// judge-calibration.ts — 评判者金标校准（BOOK-GAP-ROADMAP P0-4）
// 输入: data/judge_gold.json (人工标注金标集: 每题 gold_score + gold_passed)
// 流程: 对每条用同一 judge prompt 模板重跑 _llmJudgeOnce (deepseek-v4-flash, 3轮中位数)
//       → 计算 Cohen's kappa: k = (p_o - p_e) / (1 - p_e)
//         p_o = 一致率 (两档: 达标 ≥0.55 / 不达标)
//         p_e = 随机一致率 (边际概率乘积)
//       → 输出 kappa_report.md: kappa、逐题分歧表 (重点看"理由 vs 分数"矛盾)
// 判定: kappa ≥ 0.7 → Judge 可放量; < 0.7 → 禁止把新评测结果当发布依据, 先修 Judge prompt
// 用法: npx tsx scripts/judge-calibration.ts [--gold data/judge_gold.json] [--out kappa_report.md]
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const DS_URL = process.env.DS_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const JUDGE_TIMEOUT_MS = 60000;
const JUDGE_LLM_MODEL = 'deepseek-v4-flash';

// 与 eval-32-metrics.ts 的 _llmJudgeOnce 相同模板（保证校准用同一 prompt）
const JUDGE_PROMPT = `你是RAG评测专家。请评估以下回答与标准答案的一致程度。
问题：{question}
标准答案：{gold_answer}
AI回答：{hypothesis}

只输出一个0~1之间的浮点数分数。评分标准：
- 1.0: 完全一致且信息完整
- 0.7-0.9: 核心一致, 少量遗漏或细节差异
- 0.4-0.6: 部分一致, 有实质偏差
- 0.0-0.3: 基本不一致或答非所问`;

/** 单次 judge 打分（同 eval-32 _llmJudgeOnce 的容错逻辑; thinking 禁用保证结构化输出） */
async function judgeOnce(question: string, goldAnswer: string, hypothesis: string): Promise<number | null> {
  const prompt = JUDGE_PROMPT
    .replace('{question}', question.substring(0, 300))
    .replace('{gold_answer}', goldAnswer.substring(0, 800))
    .replace('{hypothesis}', hypothesis.substring(0, 1500));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
      try {
        const res = await fetch(DS_URL, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + DEEPSEEK_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: JUDGE_LLM_MODEL, messages: [{ role: 'user', content: prompt }],
            temperature: 0, max_tokens: 1000, thinking: { type: 'disabled' },
          }),
          signal: controller.signal,
        });
        const rawResp: any = await res.json();
        const rawText = rawResp.choices?.[0]?.message?.content?.trim() || '';
        const numMatch = rawText.match(/([01](?:\.\d+)?)/);
        if (numMatch) {
          const v = parseFloat(numMatch[1]);
          if (v >= 0 && v <= 1) return v;
        }
      } finally { clearTimeout(timer); }
    } catch {}
    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
  }
  return null;
}

/** 三轮中位数（同 eval-32 runThreeRoundMedian 精简版） */
async function judgeMedian(q: any): Promise<number | null> {
  const vals: number[] = [];
  for (let i = 0; i < 3; i++) {
    const s = await judgeOnce(q.question, q.gold_answer, q.hypothesis);
    if (s !== null) vals.push(s);
  }
  if (vals.length === 0) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

/** Cohen's kappa: 两档(达标/不达标) */
function cohenKappa(judge: boolean[], gold: boolean[]): { kappa: number; p_o: number; p_e: number } {
  const n = judge.length;
  let a = 0, b = 0, c = 0, d = 0; // a: 双达标, b: judge达标gold不达标, c: judge不达标gold达标, d: 双不达标
  for (let i = 0; i < n; i++) {
    if (judge[i] && gold[i]) a++;
    else if (judge[i] && !gold[i]) b++;
    else if (!judge[i] && gold[i]) c++;
    else d++;
  }
  const p_o = (a + d) / n;
  // 边际概率: judge 达标率 = (a+b)/n, gold 达标率 = (a+c)/n
  const pE = ((a + b) / n) * ((a + c) / n) + ((c + d) / n) * ((b + d) / n);
  const kappa = p_o === 1 ? 1 : (p_o - pE) / (1 - pE);
  return { kappa, p_o, p_e: pE };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => { const i = args.indexOf(flag); return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined; };
  return { gold: get('--gold') || 'data/judge_gold.json', out: get('--out') || 'kappa_report.md' };
}

function main() {
  const { gold, out } = parseArgs();
  if (!DEEPSEEK_KEY) { console.error('DEEPSEEK_API_KEY 未设置'); process.exit(1); }
  if (!existsSync(gold)) { console.error('未找到 ' + gold); process.exit(1); }

  const raw = JSON.parse(readFileSync(gold, 'utf8'));
  const samples = raw.samples || [];
  const reviewed = samples.filter((s: any) => s.human_reviewed);
  const targets = reviewed.length >= 10 ? reviewed : samples; // 优先用已人工复核的; 否则全量
  console.log(`评判者校准: ${targets.length} 条 (金标集共 ${samples.length} 条, 已人工复核 ${reviewed.length} 条)`);
  if (reviewed.length === 0) console.log('⚠️ 金标未人工复核, 用历史评测分作为金标 (gold_passed 可能不准)');

  const results: Array<{ id: string; gold_score: number; gold_passed: boolean; judge_score: number | null; judge_passed: boolean | null }> = [];

  (async () => {
    for (let i = 0; i < targets.length; i++) {
      const s = targets[i];
      console.log(`[${i + 1}/${targets.length}] ${s.id} 评判中...`);
      const score = await judgeMedian(s);
      const judgePassed = score !== null ? score >= 0.55 : null;
      results.push({ id: s.id, gold_score: s.gold_score, gold_passed: s.gold_passed, judge_score: score, judge_passed: judgePassed });
      console.log(`  → judge=${score !== null ? score.toFixed(3) : 'null'} gold=${s.gold_score.toFixed(3)} ${score !== null ? (Math.abs(score - s.gold_score) < 0.15 ? '✓' : '✗') : ''}`);
    }

    // ── kappa 计算 ──
    const scored = results.filter(r => r.judge_passed !== null);
    const judgeBools = scored.map(r => r.judge_passed!);
    const goldBools = scored.map(r => r.gold_passed);
    const { kappa, p_o, p_e } = cohenKappa(judgeBools, goldBools);
    const verdict = kappa >= 0.7
      ? `✅ kappa=${kappa.toFixed(3)} ≥ 0.7, Judge 可放量使用`
      : `❌ kappa=${kappa.toFixed(3)} < 0.7, 禁止把新评测结果当发布依据, 先修 Judge prompt`;

    // ── 报告 ──
    const lines: string[] = [];
    lines.push('# 评判者金标校准报告（P0-4）');
    lines.push('');
    lines.push(`- **金标集**: \`${gold}\`（${samples.length} 条, 已人工复核 ${reviewed.length} 条）`);
    lines.push(`- **Judge**: ${JUDGE_LLM_MODEL}（3轮中位数, thinking禁用）`);
    lines.push(`- **评测样本**: ${scored.length} 条（判定成功）`);
    lines.push(`- **生成时间**: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('## Cohen\'s Kappa（两档: 达标 ≥0.55 / 不达标）');
    lines.push('');
    lines.push(`| 指标 | 值 |`);
    lines.push('|---|---|');
    lines.push(`| 一致率 p_o | ${p_o.toFixed(4)} |`);
    lines.push(`| 随机一致率 p_e | ${p_e.toFixed(4)} |`);
    lines.push(`| **Cohen\'s kappa** | **${kappa.toFixed(4)}** |`);
    lines.push('');
    lines.push(`**判定: ${verdict}**`);
    lines.push('');
    lines.push('## 逐题对照表');
    lines.push('');
    lines.push('| 题号 | 题型 | gold | judge | 差异 | gold达标 | judge达标 | 分歧 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    const disputes: any[] = [];
    for (const r of scored) {
      const s = targets.find((t: any) => t.id === r.id) || {};
      const diff = r.judge_score !== null ? Math.abs(r.judge_score - r.gold_score) : null;
      const dispute = r.judge_passed !== r.gold_passed;
      if (dispute) disputes.push(r.id);
      lines.push(`| ${r.id} | ${(s.question_type || '').substring(0, 4)} | ${r.gold_score.toFixed(3)} | ${r.judge_score !== null ? r.judge_score.toFixed(3) : '-'} | ${diff !== null ? diff.toFixed(3) : '-'} | ${r.gold_passed ? '是' : '否'} | ${r.judge_passed ? '是' : '否'} | ${dispute ? '**分歧**' : ''} |`);
    }
    lines.push('');
    lines.push(`分歧题: ${disputes.length > 0 ? disputes.join(', ') : '无'}`);
    lines.push('');
    lines.push('## 流程约定（写入 SCORING_STANDARD.md）');
    lines.push('');
    lines.push('- Judge prompt 或 Rubric 任何更新 → 重跑 judge-calibration → kappa ≥ 0.7 才放量');
    lines.push('- 金标集每周 +10 条（人工标注）, 优先覆盖低分题和分歧题');
    lines.push('- 定期人工抽检评分理由: 看"理由 vs 分数"是否矛盾');
    lines.push('');
    writeFileSync(out, lines.join('\n'), 'utf8');
    console.log('\n' + lines.slice(0, 16).join('\n'));
    console.log('\nkappa_report.md 已写入');
  })().catch((e: any) => { console.error('校准过程异常:', e); process.exit(1); });
}

main();
