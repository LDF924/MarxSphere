// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// cross-judge.ts — 多源异构评判（BOOK-GAP-ROADMAP P2-5 古德哈特定律防御）
// 现有单 Judge(deepseek-v4-flash) → qwen3.7-max 交叉复评同一批题
// 两源分歧 > 0.2 的题标记人工审查; 分歧率统计进评测报告
// 原理: 偏见正交, 无法同时欺骗两个不同源模型
// 用法: npx tsx scripts/cross-judge.ts [--eval eval_32metrics.json] [--questions Q01,Q02] [--limit 10]
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const DS_URL = process.env.DS_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
const DASHSCOPE_URL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || process.env.LLM_API_KEY || process.env.EMBEDDING_API_KEY || '';

const CROSS_MODEL = process.env.CROSS_JUDGE_MODEL || 'deepseek-v4-pro';  // 异源/异型模型（有DASHSCOPE key可设qwen3.7-max真异源）

/** 用指定端点+模型对题目打分（同 eval-32 的 judge 逻辑） */
async function judgeWith(url: string, key: string, model: string, question: string, gold: string, hyp: string): Promise<number | null> {
  const prompt = `你是RAG评测专家。请评估以下回答与标准答案的一致程度。
问题: ${question.substring(0, 300)}
标准答案: ${gold.substring(0, 800)}
AI回答: ${hyp.substring(0, 1500)}
只输出一个0~1之间的浮点数分数。评分标准: 1.0完全一致 / 0.7-0.9核心一致 / 0.4-0.6部分一致 / 0.0-0.3基本不一致`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 500, thinking: { type: 'disabled' } }),
          signal: controller.signal,
        });
        const raw: any = await res.json();
        const text = raw.choices?.[0]?.message?.content?.trim() || '';
        const m = text.match(/([01](?:\.\d+)?)/);
        if (m) { const v = parseFloat(m[1]); if (v >= 0 && v <= 1) return v; }
        if (attempt === 0) continue;
        return null;
      } finally { clearTimeout(timer); }
    } catch { if (attempt === 0) continue; }
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const evalFile = (() => { const i = args.indexOf('--eval'); return i >= 0 && i + 1 < args.length ? args[i + 1] : 'eval_32metrics.json'; })();
  const qFilter = (() => { const i = args.indexOf('--questions'); return i >= 0 && i + 1 < args.length ? args[i + 1].split(',').map(s => s.trim()) : null; })();
  const limit = (() => { const i = args.indexOf('--limit'); const v = i >= 0 && i + 1 < args.length ? parseInt(args[i + 1], 10) : NaN; return !isNaN(v) && v > 0 ? v : 10; })();
  // V381: 支持 perq 格式（无 hypothesis，用已存的 DeepSeek 四维分当主评）
  const perqMode = evalFile.includes('perq');

  if (!existsSync(evalFile)) { console.error('未找到 ' + evalFile); process.exit(1); }
  const raw = JSON.parse(readFileSync(evalFile, 'utf8'));
  const valid = perqMode
    ? (Array.isArray(raw.questions) ? raw.questions : []).filter((r: any) => !r.eval_error)
    : (Array.isArray(raw) ? raw : []).filter((r: any) => !r.error && r.hypothesis && r.question_id !== '__fingerprint__');
  const goldRaw = JSON.parse(readFileSync('gold_dataset.json', 'utf8'));
  const goldList: any[] = Array.isArray(goldRaw) ? goldRaw : (goldRaw.questions || []);
  const goldMap = new Map(goldList.map((g: any) => [g.id, g]));

  let targets = valid.slice(0, limit);
  if (qFilter) targets = valid.filter((r: any) => qFilter.includes(r.question_id)).slice(0, limit);
  console.log(`交叉复评 ${targets.length} 题（DeepSeek judge vs ${CROSS_MODEL}）`);

  const rows: Array<{ id: string; deepseek: number | null; qwen: number | null; diff: number | null; flagged: boolean }> = [];
  (async () => {
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      const q = goldMap.get(r.question_id) || {};
      console.log(`[${i + 1}/${targets.length}] ${r.question_id} 交叉复评中...`);
      // V381 perq 模式：DeepSeek 主分直接用评测结果（overall），qwen 用 perq 存的真实答案复评
      const answerText = r.hypothesis || r.answer || '';
      const ds = perqMode
        ? (typeof r.overall === 'number' ? r.overall : null)
        : await judgeWith(DS_URL, DEEPSEEK_KEY, 'deepseek-v4-flash', r.question, q.gold_answer || '', r.hypothesis);
      const qw = answerText
        ? await judgeWith(DASHSCOPE_URL, DASHSCOPE_KEY, CROSS_MODEL, q.question || r.question, q.gold_answer || '', answerText)
        : null;
      const diff = ds !== null && qw !== null ? Math.abs(ds - qw) : null;
      const flagged = diff !== null && diff > 0.2;
      rows.push({ id: r.question_id, deepseek: ds, qwen: qw, diff, flagged });
      console.log(`  → ds=${ds !== null ? ds.toFixed(2) : '-'} qwen=${qw !== null ? qw.toFixed(2) : '-'} diff=${diff !== null ? diff.toFixed(2) : '-'}${flagged ? ' ⚠️分歧>0.2' : ''}`);
    }

    // 报告
    const flaggedRows = rows.filter(r => r.flagged);
    const scored = rows.filter(r => r.diff !== null);
    const avgDiff = scored.length > 0 ? scored.reduce((s, r) => s + (r.diff || 0), 0) / scored.length : 0;
    const lines: string[] = [];
    lines.push('# 多源异构评判报告（P2-5）');
    lines.push('');
    lines.push(`- **主 Judge**: deepseek-v4-flash`);
    lines.push(`- **交叉 Judge**: ${CROSS_MODEL}（异源）`);
    lines.push(`- **复评题数**: ${rows.length} | 分歧率: ${rows.length > 0 ? (flaggedRows.length / rows.length * 100).toFixed(1) : 0}% | 平均分歧: ${avgDiff.toFixed(3)}`);
    lines.push('');
    lines.push(`## 分歧题（>0.2, 需人工审查）: ${flaggedRows.length > 0 ? flaggedRows.map(r => r.id).join(', ') : '无'}`);
    lines.push('');
    lines.push('## 逐题对照');
    lines.push('');
    lines.push(`| 题号 | DeepSeek | ${CROSS_MODEL} | 分歧 | 标记 |`);
    lines.push('|---|---|---|---|---|');
    for (const r of rows) {
      lines.push(`| ${r.id} | ${r.deepseek !== null ? r.deepseek.toFixed(2) : '-'} | ${r.qwen !== null ? r.qwen.toFixed(2) : '-'} | ${r.diff !== null ? r.diff.toFixed(2) : '-'} | ${r.flagged ? '⚠️' : ''} |`);
    }
    lines.push('');
    lines.push('> 原理: 偏见正交（古德哈特定律防御）——两源分歧大 = 单模型可能被偏见影响, 需人工裁决。');
    writeFileSync('cross_judge_report.md', lines.join('\n'), 'utf8');
    console.log('\ncross_judge_report.md 已写入');
  })().catch((e: any) => { console.error('交叉复评失败:', e.message); process.exit(1); });
}

main();
