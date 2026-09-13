// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/orchestrator-run-store.ts — V415: 编排运行记录的落库
//
// 单独一个模块是为了**打断运行时不被守卫拦住**: 编排层的 onStatus 回调先过 isLiveRun
// (防止被接管的旧任务覆盖新进度), 但旧任务被打断后自己的"已暂停"收尾必须写得进去 ——
// 收尾走这里直写, 不过守卫。
//
// 另一个要点是**串行化**: 一次运行的多个写入来自不同时间点(每步一次 + 终态一次), 若并发提交,
// PostgreSQL 的 ON CONFLICT 允许后到的 `running` 覆盖先到的 `done`, 结果是运行看着永久卡住
// 而 stepLog 已经全是 done(2026-09-12 实测: status=running 且 finished_at 与 updated_at
// 同毫秒 —— coalesce 保住了旧 finished_at, 行留下了自相矛盾的状态)。
// 每条运行自己一条 Promise 链, 保证写入按产生顺序落库。
import { pool } from "../db/pool.js";
import type { MetaStepRun } from "./meta-skill-runtime.js";

let persistSeq = 0;
/** runId → 写入链尾(尾指针持有未处理的拒绝, 见下方 catch) */
const writeChains = new Map<string, Promise<void>>();

export interface RunSnapshot {
  runId: string;
  skillId: string;
  input: string;
  outputs: Record<string, string>;
  status: string;
  stepLog: MetaStepRun[];
  graph?: unknown;
  error?: string;
  finalText?: string;
}

/** 写一行运行快照(upsert)。失败只 warn —— 记录是辅助, 不能因为写库失败把编排搞崩。 */
export function persistRunSnapshot(s: RunSnapshot): Promise<void> {
  const prev = writeChains.get(s.runId) ?? Promise.resolve();
  const next = prev.then(() => doPersist(s));
  // 链尾必须持有拒绝(否则会变成 unhandledRejection), 但 doPersist 内部已 catch, 这里只兜底
  writeChains.set(s.runId, next.catch(() => {}));
  // 运行终态后清掉链, 避免 Map 无限增长
  if (["done", "failed", "cancelled"].includes(s.status)) {
    void next.catch(() => {}).then(() => writeChains.delete(s.runId));
  }
  return next;
}

async function doPersist(s: RunSnapshot): Promise<void> {
  const finished = ["done", "failed", "cancelled"].includes(s.status);
  const dbg = process.env.ORCH_DEBUG_PERSIST
    ? `#${++persistSeq} ${s.runId} status=${s.status} fin=${finished} from=${new Error().stack?.split("\n")[2]?.trim().slice(0, 90) ?? "?"}`
    : "";
  if (dbg) console.log(`[orch-dbg] ${dbg}`);
  try {
    await pool.query(
      `insert into orchestrator_runs (id, graph_id, graph_name, input, status, graph_json, step_log_json, outputs_json, final_text, error, updated_at, finished_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, now(), case when $11 then now() else null end)
       on conflict (id) do update set
         status = excluded.status,
         step_log_json = excluded.step_log_json,
         outputs_json = excluded.outputs_json,
         graph_json = coalesce(excluded.graph_json, orchestrator_runs.graph_json),
         final_text = coalesce(excluded.final_text, orchestrator_runs.final_text),
         error = coalesce(excluded.error, orchestrator_runs.error),
         updated_at = now(),
         finished_at = coalesce(excluded.finished_at, orchestrator_runs.finished_at)`,
      [
        s.runId, s.skillId, s.skillId, s.input, s.status,
        s.graph ? JSON.stringify(s.graph) : null,
        JSON.stringify(s.stepLog), JSON.stringify(s.outputs),
        s.finalText ?? null, s.error ?? null, finished,
      ]
    );
  } catch (e: any) {
    console.warn(`[orchestrator] 落库失败(不阻断执行): ${String(e?.message || e).slice(0, 150)}`);
  }
}
