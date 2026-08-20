// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ablation-eval.ts — 真消融评测（对齐 V88K 自己的口径，非 GBrain）
// 基线：50 题全算子跑 → MRR/NDCG/paper_hit；关掉每个算子重跑 → 同指标对比
// topK=15（对齐 V88K 评测 0.870 配置）；规则指标（不依赖 LLM，稳定可复现）
// 用法：npx tsx scripts/ablation-eval.ts [--operators rerank,title] [--limit 10]
import { readFileSync } from "fs";

// SSE 进度协议（eval-server.ts 逐行解析）：CLI 直跑仅多一行注释式输出
function emitProgress(evt: unknown) {
  console.log("[EVAL-SSE] " + JSON.stringify(evt));
}

const SAG_API = "http://localhost:4173";
const SOURCE_ID = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";
const TOP_K = 15; // V88K 评测基线配置

const OPERATORS = [
  "compiled_truth", "title", "chronicle_type", "backlink",
  "cosine", "dedup", "alias", "relational", "expansion",
  "graph_traversal", "multi_query", "rerank"
];

const args = process.argv.slice(2);
const opsIdx = args.indexOf("--operators");
const limitIdx = args.indexOf("--limit");
const operators = opsIdx >= 0 && args[opsIdx + 1] ? args[opsIdx + 1].split(",") : OPERATORS;
const limit = limitIdx >= 0 && args[limitIdx + 1] ? Number(args[limitIdx + 1]) : 50;

interface GoldItem {
  id: string;
  question: string;
  gold_answer: string;
  relevant_paragraphs: number[];
  question_type: string;
  paper_id: string;
  paper_title: string;
  gold_entities: string[];
}

const gold = JSON.parse(readFileSync("gold_dataset.json", "utf-8")) as GoldItem[];
const questions = gold.slice(0, limit);

/** 跑单题推理检索（走 /api/reason/query——V88K 口径：带 paperId + ablation + noTrace 类比），返回 sections */
async function searchOne(q: GoldItem, ablation?: string[]): Promise<Array<{ heading: string; content: string }>> {
  const res = await fetch(`${SAG_API}/api/reason/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceId: SOURCE_ID,
      query: q.question,
      topK: TOP_K,
      paperId: q.paper_id || undefined,
      ...(ablation ? { ablation } : {}),
    }),
  });
  const data = await res.json() as {
    error?: { message?: string };
    trace?: { retrieveResults?: Array<{ results?: Array<{ text?: string; content?: string; title?: string }> }> };
  };
  if (data.error || !data.trace?.retrieveResults) return [];
  const sections: Array<{ heading: string; content: string }> = [];
  for (const rr of data.trace.retrieveResults) {
    for (const r of rr.results ?? []) {
      const text = r.text ?? r.content ?? "";
      if (text) sections.push({ heading: r.title ?? "", content: text });
    }
  }
  return sections.slice(0, TOP_K);
}

/** 黄金关键词（V88K 口径：gold_entities + gold_answer 分词） */
function goldTerms(q: GoldItem): string[] {
  return [
    ...(q.gold_entities ?? []),
    ...(q.gold_answer ?? "").split(/[\s，。、；：！？,.!?;:]+/).filter((w) => w.length >= 2),
  ].filter(Boolean);
}

/** MRR（对齐 eval-22-metrics computeMRR） */
function computeMRR(chunks: string[], gTerms: string[]): number {
  for (let i = 0; i < chunks.length; i++) {
    for (const kw of gTerms) { if (chunks[i].includes(kw)) return 1 / (i + 1); }
  }
  return 0;
}

/** NDCG（对齐 eval-22-metrics computeNDCG） */
function computeNDCG(chunks: string[], gTerms: string[]): number {
  let dcg = 0;
  for (let i = 0; i < chunks.length; i++) {
    let relevant = 0;
    for (const kw of gTerms) if (chunks[i].includes(kw)) { relevant = 1; break; }
    dcg += relevant / Math.log2(i + 2);
  }
  const idcg = 1 / Math.log2(2);
  return idcg > 0 ? dcg / idcg : 0;
}

/** paper_hit：目标论文是否出现在检索结果中 */
function paperHit(sections: Array<{ heading: string; content: string }>, q: GoldItem): number {
  if (!q.paper_title) return 1; // 无 paper_title 的题不判
  const titleKey = q.paper_title.replace(/[《》【】\[\]()（）\s,，。、；;：:！!？?""''-_—]+/g, "").substring(0, 20);
  for (const s of sections) {
    const text = `${s.heading} ${s.content}`.replace(/\s+/g, "");
    if (text.includes(titleKey)) return 1;
  }
  return 0;
}

async function runEval(ablation?: string[], label = "基线"): Promise<{ mrr: number; ndcg: number; paperHit: number; perQuestion: Record<string, { mrr: number; ndcg: number; paperHit: number }> }> {
  const perQuestion: Record<string, { mrr: number; ndcg: number; paperHit: number }> = {};
  for (const q of questions) {
    emitProgress({ type: "question_start", question: q.id, qtype: q.question_type || "", index: questions.indexOf(q) + 1, total: questions.length, phase: label });
    const sections = await searchOne(q, ablation);
    const chunks = sections.map((s) => `${s.heading} ${s.content}`);
    const g = goldTerms(q);
    perQuestion[q.id] = {
      mrr: computeMRR(chunks, g),
      ndcg: computeNDCG(chunks, g),
      paperHit: paperHit(sections, q),
    };
    emitProgress({ type: "question_done", question: q.id, ok: true, phase: label, ...perQuestion[q.id] });
  }
  const avg = (key: "mrr" | "ndcg" | "paperHit") =>
    Object.values(perQuestion).reduce((a, b) => a + b[key], 0) / questions.length;
  const r = { mrr: avg("mrr"), ndcg: avg("ndcg"), paperHit: avg("paperHit"), perQuestion };
  console.log(`${label}: MRR ${(r.mrr * 100).toFixed(1)}% | NDCG ${(r.ndcg * 100).toFixed(1)}% | paper_hit ${(r.paperHit * 100).toFixed(1)}%`);
  return r;
}

async function main() {
  emitProgress({ type: "phase", phase: "start", total: questions.length * operators.length, output: "ablation" });
  console.log(`真消融评测：${questions.length} 题 × ${operators.length} 算子（V88K 口径：topK=${TOP_K}, MRR/NDCG/paper_hit）`);
  console.log("=".repeat(70));

  const baseline = await runEval(undefined, "基线（全算子）");

  console.log("\n关掉单一算子后的退化：");
  console.log("-".repeat(70));
  const results: Array<{ operator: string; mrr: number; ndcg: number; paperHit: number; mrrDrop: number }> = [];
  for (const op of operators) {
    const ablated = await runEval([op], `关掉 ${op}`);
    const mrrDrop = (baseline.mrr - ablated.mrr) * 100;
    results.push({ operator: op, mrr: ablated.mrr, ndcg: ablated.ndcg, paperHit: ablated.paperHit, mrrDrop });
    const severity = mrrDrop > 5 ? "🔴" : mrrDrop > 2 ? "🟠" : mrrDrop > 0 ? "🟡" : "⚪";
    console.log(`  ${severity} ${op.padEnd(18)} MRR ${(ablated.mrr * 100).toFixed(1)}% (掉 ${mrrDrop.toFixed(1)}pp) | NDCG ${(ablated.ndcg * 100).toFixed(1)}% | paper_hit ${(ablated.paperHit * 100).toFixed(1)}%`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("贡献排名（MRR 掉得越多 = 该算子越关键）：");
  results.sort((a, b) => b.mrrDrop - a.mrrDrop);
  results.forEach((r, i) => console.log(`  ${i + 1}. ${r.operator.padEnd(18)} MRR 掉 ${r.mrrDrop.toFixed(1)}pp`));
  emitProgress({ type: "phase", phase: "done", output: "ablation", baseline: baseline, results: results.map(r => ({ operator: r.operator, mrr: r.mrr, ndcg: r.ndcg, paperHit: r.paperHit, mrrDrop: r.mrrDrop })) });
}

main().catch((e) => { console.error("崩溃:", e.message); process.exit(1); });
