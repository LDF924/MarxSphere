// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// run-eval-dual.ts — 双模式推理 A/B 评测（V267）
// 同一批 gold 问题分别用 template（固定52步）和 adaptive（LLM动态选算子）跑，
// 对比：成功率/耗时/置信度/算子数，验证 adaptive 简单题收敛、复杂题加深
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// SSE 进度协议（eval-server.ts 逐行解析）：CLI 直跑仅多一行注释式输出
function emitProgress(evt: unknown) {
  console.log('[EVAL-SSE] ' + JSON.stringify(evt));
}

const SAG_API = 'http://localhost:4173';
const PROJECT_ID = 'c609acbf-1d6e-4bd5-9ae1-92fa6c64021a';
const GOLD_FILE = 'gold_dataset.json';
const LOG_FILE = process.env.EVAL_OUTPUT || 'eval_32metrics_dual.json';
const BATCH_DELAY_MS = 5000;
// 题号过滤（与 eval-22-metrics 的 EVAL_QUESTIONS 约定一致）
const EVAL_QUESTIONS = process.env.EVAL_QUESTIONS
  ? process.env.EVAL_QUESTIONS.split(',').map(s => s.trim()).filter(Boolean)
  : null;

interface DualResult {
  question_id: string; question: string; question_type: string;
  template?: { duration_ms: number; confidence?: number; eval_score?: number; error?: string };
  adaptive?: { duration_ms: number; confidence?: number; eval_score?: number; error?: string; plan?: string[] };
}

async function callMode(query: string, mode: 'template' | 'adaptive', paperId?: string) {
  const start = Date.now();
  try {
    const res = await fetch(SAG_API + '/api/reason/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: PROJECT_ID, query, topK: 15, mode, ...(paperId ? { paperId } : {}) })
    });
    const json = await res.json();
    const duration = Date.now() - start;
    if (json.error) return { duration_ms: duration, error: json.error.message || JSON.stringify(json.error) };
    const trace = json.trace || {};
    return {
      duration_ms: duration,
      confidence: trace.hypothesis?.confidence,
      eval_score: trace.evaluation?.overallScore,
      plan: trace.adaptivePlan,
    };
  } catch (e: any) { return { duration_ms: Date.now() - start, error: e.message }; }
}

async function main() {
  const gold = JSON.parse(readFileSync(GOLD_FILE, 'utf-8'));
  let questions = Array.isArray(gold) ? gold : gold.questions;
  if (EVAL_QUESTIONS) {
    questions = questions.filter((q: any) => EVAL_QUESTIONS!.includes(q.id || q.question_id));
  }
  console.log(`gold 题目数: ${questions.length}`);
  emitProgress({ type: 'phase', phase: 'start', total: questions.length, output: LOG_FILE });

  let results: DualResult[] = [];
  if (existsSync(LOG_FILE)) {
    try { results = JSON.parse(readFileSync(LOG_FILE, 'utf-8')); } catch { results = []; }
    console.log(`恢复进度: ${results.length} 题已完成`);
  }
  const doneIds = new Set(results.map((r) => r.question_id));

  for (const q of questions) {
    const qid = q.id || q.question_id;
    if (doneIds.has(qid)) continue;
    const query = q.question || q.query;
    const paperId = q.paper_id;

    emitProgress({ type: 'question_start', question: qid, qtype: q.question_type || '', index: questions.indexOf(q) + 1, total: questions.length });
    process.stdout.write(`[${qid}] ${query.substring(0, 30)}... `);
    const entry: DualResult = { question_id: qid, question: query, question_type: q.question_type || '' };

    // template 模式
    const t = await callMode(query, 'template', paperId);
    entry.template = t;
    process.stdout.write(`T=${t.duration_ms}ms${t.error ? '!' : ''} `);

    // adaptive 模式
    const a = await callMode(query, 'adaptive', paperId);
    entry.adaptive = a;
    process.stdout.write(`A=${a.duration_ms}ms${a.error ? '!' : ''} plan=${a.plan?.length || 0}ops\n`);
    emitProgress({ type: 'question_done', question: qid, ok: !(t.error || a.error), tMs: t.duration_ms, aMs: a.duration_ms, tError: t.error || null, aError: a.error || null, planOps: a.plan?.length || 0 });

    results.push(entry);
    writeFileSync(LOG_FILE, JSON.stringify(results, null, 2));
    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  // 汇总
  const okT = results.filter((r) => r.template && !r.template.error);
  const okA = results.filter((r) => r.adaptive && !r.adaptive.error);
  const avgT = okT.reduce((s, r) => s + (r.template?.duration_ms || 0), 0) / Math.max(1, okT.length);
  const avgA = okA.reduce((s, r) => s + (r.adaptive?.duration_ms || 0), 0) / Math.max(1, okA.length);
  const avgConfT = okT.reduce((s, r) => s + (r.template?.confidence || 0), 0) / Math.max(1, okT.length);
  const avgConfA = okA.reduce((s, r) => s + (r.adaptive?.confidence || 0), 0) / Math.max(1, okA.length);
  const avgScoreT = okT.reduce((s, r) => s + (r.template?.eval_score || 0), 0) / Math.max(1, okT.length);
  const avgScoreA = okA.reduce((s, r) => s + (r.adaptive?.eval_score || 0), 0) / Math.max(1, okA.length);
  const avgPlanOps = okA.reduce((s, r) => s + (r.adaptive?.plan?.length || 0), 0) / Math.max(1, okA.length);

  console.log('\n=== 双模式对比 ===');
  console.log(`成功: template ${okT.length}/${results.length} | adaptive ${okA.length}/${results.length}`);
  console.log(`平均耗时: template ${avgT.toFixed(0)}ms | adaptive ${avgA.toFixed(0)}ms (${(avgA / Math.max(1, avgT) * 100).toFixed(0)}%)`);
  console.log(`平均置信: template ${avgConfT.toFixed(3)} | adaptive ${avgConfA.toFixed(3)}`);
  console.log(`平均评估: template ${avgScoreT.toFixed(3)} | adaptive ${avgScoreA.toFixed(3)}`);
  console.log(`平均算子数: adaptive ${avgPlanOps.toFixed(1)}`);
  writeFileSync('eval_32metrics_dual_summary.json', JSON.stringify({
    okTemplate: okT.length, okAdaptive: okA.length, total: results.length,
    avgDurationTemplate: avgT, avgDurationAdaptive: avgA,
    avgConfidenceTemplate: avgConfT, avgConfidenceAdaptive: avgConfA,
    avgEvalTemplate: avgScoreT, avgEvalAdaptive: avgScoreA,
    avgPlanOps: avgPlanOps,
  }, null, 2));
  console.log('汇总已写入 eval_32metrics_dual_summary.json');
  emitProgress({ type: 'phase', phase: 'done', output: LOG_FILE });
}

main().catch((e) => { console.error('评测崩溃:', e); process.exit(1); });
