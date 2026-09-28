// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/orchestrator-event-log.ts — V416: 编排运行事件流(计划历史浮层的数据源)
//
// 与 orchestrator-run-store 的分工(两者都写库, 但语义完全不同, 不要混):
//   · orchestrator-run-store 写的是**状态快照** —— 每步"现在是什么状态", 整行覆盖。
//     它回答"跑到哪了", 不回答"怎么走到这里的"。
//   · 这里写的是**事件流** —— 每次状态迁移追加一行, 永不覆盖。
//     它回答"04:32:13 发生了一次 node.diagnosed, 说明是 XXX"。
//
// 为什么必须另起一张表: 快照表的 on conflict do update 会把同一 stepId 的
//   pending → running → done 三个瞬间压成最后一个 —— 失败前的诊断过程在库里天生读不出来。
//   (2026-09-28 对齐参考产品「计划历史」时确认)
//
// 纪律:
//   · **永不抛错、永不阻断执行**。记录是辅助, 写不进去最多是浮层少一行, 不能把编排搞崩
//     —— 与 persistRunSnapshot 同一条。这里连 warn 都收敛成一行, 不打印 payload(可能含模型产出)。
//   · **按 run 串行**。事件顺序就是它想表达的意义("先诊断再失败"和"先失败再诊断"是两回事),
//     并发提交时 PostgreSQL 不保证到达顺序, 所以每条 run 自己一条 Promise 链。

import { pool } from "../db/pool.js";

/** 事件名。加新事件时**同时**在前端的 `EVENT_LABEL` 里给中文说明, 否则浮层只能显示裸英文名。 */
export type RunEvent =
  | "job.created"
  | "job.started"
  | "job.batch_started"
  | "job.done"
  | "job.failed"
  | "job.paused"
  | "job.cancelled"
  | "node.running"
  | "node.done"
  | "node.failed"
  | "node.waiting_input"
  | "node.skipped";

let seqCounter = 0;
/** runId → 写入链尾(尾指针持有未处理的拒绝) */
const writeChains = new Map<string, Promise<void>>();

/**
 * 记一条事件。**调用方不需要 await** —— 它自己吞掉所有错误。
 *
 * seq 用进程内自增而不是 `max(seq)+1` 查询: 每次事件多一次往返不值得, 而进程内计数器
 *   加上"按 run 串行"已经保证同一 run 内严格递增且不重复。进程重启后计数器从 0 重新开始,
 *   但那时旧 run 的执行早就没了(liveRuns 是内存态), 不会与新 run 的 seq 撞车。
 */
export function recordRunEvent(
  runId: string,
  event: RunEvent,
  opts: { nodeId?: string; message?: string; payload?: Record<string, unknown> } = {},
): void {
  if (!runId) return;
  const seq = ++seqCounter;
  const prev = writeChains.get(runId) ?? Promise.resolve();
  const next = prev.then(() => insertEvent(runId, seq, event, opts));
  writeChains.set(runId, next.catch(() => {}));
  // 终态事件之后这个 run 不会再有事件了, 清掉链条免得 Map 无限增长
  if (event === "job.done" || event === "job.failed" || event === "job.cancelled") {
    void next.catch(() => {}).then(() => writeChains.delete(runId));
  }
}

async function insertEvent(
  runId: string, seq: number, event: RunEvent,
  opts: { nodeId?: string; message?: string; payload?: Record<string, unknown> },
): Promise<void> {
  try {
    await pool.query(
      `insert into orchestrator_run_events (run_id, seq, event, node_id, message, payload)
       values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (run_id, seq) do nothing`,
      [runId, seq, event, opts.nodeId ?? "", (opts.message ?? "").slice(0, 500), JSON.stringify(opts.payload ?? {})],
    );
  } catch (e: unknown) {
    // 表还没迁移到(旧库)也不该炸: 这是辅助记录, 不是执行路径
    console.warn(`[orch-events] 记事件失败(不阻断执行): ${String((e as Error)?.message ?? e).slice(0, 150)}`);
  }
}

/**
 * 读一次运行的完整事件流。
 *
 * 只读, 不建表判断 —— 表不存在时抛出的错由调用方(路由)转成"空事件流 + 说明",
 *   而不是 500: 老库上浮层应该显示空态, 不是报错。
 */
export async function listRunEvents(
  runId: string, sinceSeq = 0,
): Promise<Array<{ seq: number; event: string; nodeId: string; message: string; createdAt: string }>> {
  const r = await pool.query(
    `select seq, event, node_id, message, created_at
       from orchestrator_run_events
      where run_id = $1 and seq > $2
      order by seq asc
      limit 500`,
    [runId, sinceSeq],
  );
  return r.rows.map((x: Record<string, unknown>) => ({
    seq: Number(x.seq),
    event: String(x.event),
    nodeId: String(x.node_id ?? ""),
    message: String(x.message ?? ""),
    createdAt: x.created_at ? new Date(x.created_at as string).toISOString() : "",
  }));
}
