// promote-to-gold.ts — 生产 bad case 回流评测集（BOOK-GAP-ROADMAP P2-4）
// 输入: eval_failures 表中 confidence≥0.7 且 is_recoverable=false 的题
// 流程: LLM(getRoleModel("plan")) 起草新 gold 题(question/gold_answer/relevant_paragraphs/question_type/paper_id/paper_title)
//       → 输出 gold_candidates.json(status: draft) → 人工确认后移入 gold_dataset.json
// 说明: 评估集从静态 50 题变成活资产; 每次评测报告标注"本次新增 N 题来自生产回流"
// 用法: npx tsx scripts/promote-to-gold.ts [--dry-run]
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Client } from 'pg';
import { getRoleModel } from '../src/services/llm-model-registry.js';

const DS_URL = process.env.DS_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';

const GOLD_PROMPT = `你是评测集设计专家。以下是一条 SAG 生产失败案例（含归因）。
请基于该失败案例起草一道新的评测题（gold_dataset.json 格式）。

失败案例: {failure}
归因: {attribution}

【硬性约束】新题必须基于【来源题的论文】——即失败案例的论文 {source_paper}。禁止换用其他论文！
- paper_title 必须填来源论文标题（原样复制）
- md_path 必须填来源论文路径（原样复制）
- gold_answer 必须基于该论文原文内容

输出 JSON:
{"id":"建议题号(如 Q51)",
 "question":"评测问题(基于该论文内容提问)",
 "gold_answer":"标准答案(基于该论文原文)",
 "question_type":"概念定义|事实检索|多跳推理|政策评估(中文,与gold_dataset一致)",
 "paper_title":"来源论文标题(原样复制)",
 "paper_id":"来源论文ID(原样复制)",
 "md_path":"来源论文路径(原样复制)",
 "gold_entities":["关键实体1","关键实体2"],
 "relevant_paragraphs":[1],
 "rationale":"为什么这题能捕获该失败模式"}

规则: 问题必须与失败模式直接相关(能复现同类错误); 金标答案必须基于论文原文; 不确定的字段填空字符串。`;

/** 调 plan 模型起草新题（thinking 禁用） */
async function draftGold(failure: any, sourcePaper: { paper_title: string; paper_id: string; md_path: string }): Promise<Record<string, unknown> | null> {
  const model = getRoleModel('plan');
  const prompt = GOLD_PROMPT
    .replace('{failure}', `题号=${failure.question_id}, 类别=${failure.failure_category}, 首错步骤=${failure.first_error_step || '?'}`)
    .replace('{attribution}', String(failure.root_cause || '').substring(0, 400))
    .replace('{source_paper}', `${sourcePaper.paper_title}（${sourcePaper.md_path}）`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const res = await fetch(DS_URL, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + DEEPSEEK_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 3000,
            thinking: { type: 'disabled' },
          }),
          signal: controller.signal,
        });
        const rawResp: any = await res.json();
        const rawText = rawResp.choices?.[0]?.message?.content?.trim() || '';
        if (!rawText) { if (attempt < 2) continue; return null; }
        const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const objMatch = cleaned.match(/{[\s\S]*}/);
        if (!objMatch) { if (attempt < 2) continue; return null; }
        const obj = JSON.parse(objMatch[0]);
        if (typeof obj.question !== 'string' || typeof obj.gold_answer !== 'string') { if (attempt < 2) continue; return null; }
        return obj;
      } finally { clearTimeout(timer); }
    } catch { if (attempt < 2) continue; }
  }
  return null;
}

function main() {
  if (!DEEPSEEK_KEY) { console.error('DEEPSEEK_API_KEY 未设置'); process.exit(1); }
  const dryRun = process.argv.includes('--dry-run');
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  (async () => {
    await client.connect();
    // 可回流: confidence≥0.7 且 is_recoverable=false（高置信度且不可恢复的失败）
    const candidates = await client.query(
      `select question_id, failure_category, first_error_step, root_cause, confidence
       from eval_failures where confidence >= 0.7 and is_recoverable = false
       order by confidence desc`
    );
    if (candidates.rows.length === 0) { console.log('无可回流题（无 confidence≥0.7 且不可恢复的失败）'); await client.end(); return; }
    console.log(`可回流失败 ${candidates.rows.length} 个（confidence≥0.7 且 is_recoverable=false）:`);
    for (const f of candidates.rows) console.log(' ', f.question_id, f.failure_category, 'conf=' + f.confidence);

    const outFile = 'data/gold_candidates.json';
    const existing = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : { generated_at: new Date().toISOString(), candidates: [] };
    // 去重只看非 rejected 候选（rejected 的不阻止重新起草）
    const seen = new Set(existing.candidates.filter((c: any) => c.status !== 'rejected').map((c: any) => c.source_question));

    // 来源题论文信息（gold_dataset.json 里查）
    const goldRaw = JSON.parse(readFileSync('gold_dataset.json', 'utf8'));
    const goldList: any[] = Array.isArray(goldRaw) ? goldRaw : (goldRaw.questions || []);
    const goldMap = new Map(goldList.map((g: any) => [g.id, g]));

    for (const f of candidates.rows) {
      if (seen.has(f.question_id)) { console.log(' 跳过(已存在):', f.question_id); continue; }
      // 取来源题论文信息（硬性约束: 新题必须基于同篇论文）
      const src = goldMap.get(f.question_id) || {};
      const sourcePaper = {
        paper_title: src.paper_title || '',
        paper_id: src.paper_id || '',
        md_path: src.md_path || '',
      };
      if (!sourcePaper.md_path) {
        console.log(` 跳过 ${f.question_id}: 来源题无 md_path（无法绑定论文）`);
        continue;
      }
      console.log(`\n起草 ${f.question_id} 的新题（绑定论文: ${String(sourcePaper.paper_title).substring(0, 40)}）...`);
      const draft = await draftGold(f, sourcePaper);
      if (!draft) { console.log(' 起草失败'); continue; }
      // 校验: 新题 paper_title 必须与来源题一致（LLM 换论文则拒绝）
      const paperMatch = draft.paper_title && String(draft.paper_title).trim() === String(sourcePaper.paper_title).trim();
      if (!paperMatch) {
        console.log(` ❌ 拒绝 ${f.question_id}: LLM 换了论文（新题 "${String(draft.paper_title || '').substring(0, 30)}" ≠ 来源 "${String(sourcePaper.paper_title).substring(0, 30)}"）`);
        continue;
      }
      const entry = {
        id: 'Q' + (51 + existing.candidates.length),  // 题号自动递增（避免 LLM 重复建议同一 id）
        source_question: f.question_id,
        source_failure_category: f.failure_category,
        question: draft.question,
        gold_answer: draft.gold_answer,
        question_type: draft.question_type || 'factual_retrieval',
        paper_title: draft.paper_title || '',
        paper_id: sourcePaper.paper_id,   // 强制用来源题论文 ID（不信 LLM 自报）
        md_path: sourcePaper.md_path,     // 强制用来源题论文路径
        gold_entities: Array.isArray(draft.gold_entities) ? draft.gold_entities : [],
        relevant_paragraphs: Array.isArray(draft.relevant_paragraphs) ? draft.relevant_paragraphs : [1],
        rationale: draft.rationale || '',
        status: 'draft',  // draft=待人工确认 → confirmed 移入 gold_dataset.json
      };
      existing.candidates.push(entry);
      seen.add(f.question_id);
      console.log(` ✅ ${entry.id} (${entry.question_type}) | ${String(entry.question).substring(0, 50)}`);
    }

    existing.generated_at = new Date().toISOString();
    writeFileSync(outFile, JSON.stringify(existing, null, 2), 'utf8');
    console.log(`\n${dryRun ? '[dry-run] ' : ''}候选已写入 ${outFile}（共 ${existing.candidates.length} 条, status=draft 待人工确认 → confirmed 后移入 gold_dataset.json）`);
    await client.end();
  })().catch((e: any) => { console.error('回流异常:', e); process.exit(1); });
}

main();
