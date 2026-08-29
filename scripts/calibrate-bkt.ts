#!/usr/bin/env npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// scripts/calibrate-bkt.ts — BKT 参数离线校准(V386, 借鉴 TraitTutor calibration.py)
// 流程:
//   1. 从 learner_event_ledger 取全部强证据, 按 (student, subject, kc) 组成时序序列
//   2. 约束随机搜索 20000 候选: guess/slip<0.5, guess+slip<1, transition∈(0.001,0.5], 按 NLL 选优
//   3. 质量门: 校准 log-loss < 基线(prior-only 恒猜) → 才写 bkt_parameters(calibrated=true)
// 用法: npx tsx scripts/calibrate-bkt.ts [--candidates 20000] [--min-sequences 50]
import { pool } from "../src/db/pool.js";
import { bktUpdate } from "../src/services/learning-evidence-service.js";

interface Params { transition: number; guess: number; slip: number; prior: number; }
interface SeqEvent { correct: boolean; }
interface Sequence { studentId: string; subject: string; kc: string; events: SeqEvent[]; }

// ─── 数据准备: 强证据序列 ───
async function loadSequences(minEvents: number): Promise<Sequence[]> {
  const r = await pool.query(
    `select student_id, subject, knowledge_point, is_correct, answered_at
     from learner_event_ledger
     where evidence_strength = 'strong' and attribution_status = 'reliable' and is_correct is not null
       and not exists (select 1 from learner_event_amendments a where a.event_id = learner_event_ledger.id)
     order by answered_at, id`
  );
  const map = new Map<string, Sequence>();
  for (const row of r.rows) {
    const key = `${row.student_id}::${row.subject}::${row.knowledge_point}`;
    const seq = map.get(key) ?? { studentId: row.student_id, subject: row.subject, kc: row.knowledge_point, events: [] as SeqEvent[] };
    seq.events.push({ correct: row.is_correct === true });
    map.set(key, seq);
  }
  const seqs = [...map.values()].filter((s) => s.events.length >= minEvents);
  return seqs;
}

// ─── NLL(负对数似然): 逐序列用 BKT 递推 ───
function nllOf(params: Params, sequences: Sequence[]): number {
  let nll = 0;
  for (const seq of sequences) {
    let p = params.prior;
    for (const ev of seq.events) {
      const predicted = p + (1 - p) * params.transition;
      const likelihood = ev.correct
        ? predicted * (1 - params.slip) + (1 - predicted) * params.guess
        : predicted * params.slip + (1 - predicted) * (1 - params.guess);
      nll -= Math.log(Math.max(1e-9, likelihood));
      p = bktUpdate(p, ev.correct, params.transition, params.guess, params.slip);
    }
  }
  return nll;
}

// ─── 基线: 无记忆恒猜(用整体正确率做先验, 无参数) ───
function baselineNll(sequences: Sequence[]): number {
  const all = sequences.flatMap((s) => s.events);
  const rate = all.filter((e) => e.correct).length / Math.max(1, all.length);
  let nll = 0;
  for (const e of all) nll -= Math.log(e.correct ? Math.max(1e-9, rate) : Math.max(1e-9, 1 - rate));
  return nll;
}

// ─── 约束随机搜索(seed 固定保证可复现) ───
function randomSearch(sequences: Sequence[], candidates: number, seed: number): { params: Params; nll: number } {
  let rng = seed;
  const rand = () => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng / 2147483648; };
  let best: Params = { transition: 0.12, guess: 0.2, slip: 0.1, prior: 0.2 };
  let bestNll = Infinity;
  for (let i = 0; i < candidates; i++) {
    // 约束: guess/slip < 0.5, guess+slip < 1, transition ∈ (0.001, 0.5], prior ∈ (0.05, 0.5)
    const transition = 0.001 + rand() * 0.499;
    let guess = rand() * 0.49;
    const slip = rand() * Math.min(0.49, 0.98 - guess);
    guess = Math.min(guess, 0.49);
    const prior = 0.05 + rand() * 0.45;
    const nll = nllOf({ transition, guess, slip, prior }, sequences);
    if (nll < bestNll) { bestNll = nll; best = { transition, guess, slip, prior }; }
  }
  return { params: best, nll: bestNll };
}

async function main() {
  const candidates = Number(process.argv.find((a) => a.startsWith("--candidates"))?.split("=")[1] ?? 20000);
  const minEvents = Number(process.argv.find((a) => a.startsWith("--min-events"))?.split("=")[1] ?? 2);
  const minSequences = Number(process.argv.find((a) => a.startsWith("--min-sequences"))?.split("=")[1] ?? 20);

  const sequences = await loadSequences(minEvents);
  console.log(`[calibrate-bkt] 强证据序列: ${sequences.length} 条, 事件总数: ${sequences.reduce((a, s) => a + s.events.length, 0)}`);
  if (sequences.length < minSequences) {
    console.log(`[calibrate-bkt] 序列不足 ${minSequences} 条, 跳过校准(保持 v1-uncalibrated 回退参数)`);
    process.exit(0);
  }

  // 学生级分组: 同学生数据只进一折(借鉴 TraitTutor owner-level folds)
  const students = [...new Set(sequences.map((s) => s.studentId))].sort();
  const foldOf = new Map<string, number>();
  students.forEach((sid, i) => foldOf.set(sid, i % 5));
  const byFold = [0, 1, 2, 3, 4].map((f) => sequences.filter((s) => foldOf.get(s.studentId) === f));

  let foldLoss = 0;
  for (let f = 0; f < 5; f++) {
    const train = byFold.flatMap((seqs, i) => (i === f ? [] : seqs));
    const valid = byFold[f];
    if (train.length === 0 || valid.length === 0) continue;
    const { params } = randomSearch(train, candidates, 42 + f);
    foldLoss += nllOf(params, valid);
  }
  const meanFoldNll = foldLoss / 5;

  // 全量再拟合一次(校准工件用)
  const full = randomSearch(sequences, candidates, 7);
  const baseline = baselineNll(sequences);
  const improvement = baseline - full.nll; // >0 表示校准优于基线

  console.log(`[calibrate-bkt] 最优参数: t=${full.params.transition.toFixed(4)} g=${full.params.guess.toFixed(4)} s=${full.params.slip.toFixed(4)} prior=${full.params.prior.toFixed(4)}`);
  console.log(`[calibrate-bkt] 全量 NLL=${full.nll.toFixed(1)} 基线 NLL=${baseline.toFixed(1)} 提升=${improvement.toFixed(1)}`);
  console.log(`[calibrate-bkt] 5 折平均验证 NLL=${meanFoldNll.toFixed(1)}`);

  // 质量门: 校准必须优于基线(借鉴 TraitTutor: log_loss < baseline)
  if (improvement <= 0) {
    console.log(`[calibrate-bkt] ✗ 质量门未过: 校准 NLL 未优于基线, 不写工件(保持 v1-uncalibrated)`);
    process.exit(1);
  }
  if (meanFoldNll > baseline) {
    console.log(`[calibrate-bkt] ✗ 质量门未过: 5 折验证 NLL 劣于基线, 不写工件(可能过拟合)`);
    process.exit(1);
  }

  const version = `v${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-calibrated`;
  await pool.query(
    `insert into bkt_parameters (version, transition, guess, slip, prior, calibrated, log_loss, observations)
     values ($1, $2, $3, $4, $5, true, $6, $7)
     on conflict (version) do nothing`,
    [version, full.params.transition, full.params.guess, full.params.slip, full.params.prior, full.nll, sequences.reduce((a, s) => a + s.events.length, 0)]
  );
  console.log(`[calibrate-bkt] ✓ 已写入校准参数: ${version} (calibrated=true, log_loss=${full.nll.toFixed(1)})`);
  process.exit(0);
}

main().catch((e) => { console.error("[calibrate-bkt] 失败:", e.message); process.exit(1); });
