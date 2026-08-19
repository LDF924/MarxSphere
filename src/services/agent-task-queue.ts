// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-task-queue.ts — V394-4: 任务调度队列
// 多任务并发控制: 串行/并发上限/优先级
// 原理: 内存队列 + 信号量（每任务一个执行器槽位）
// V396-5: 队列持久化(agent_task_queue 表) + 启动恢复(running 卡死→failed 可重试)
import { pool } from "../db/pool.js";

/** 并发上限（AGENT_QUEUE_CONCURRENCY 覆盖, 默认 2） */
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.AGENT_QUEUE_CONCURRENCY || "2", 10));

interface QueuedTask {
  taskId: string;
  priority: number;       // 1(低) ~ 3(高)
  run: () => Promise<void>;
}

const queue: QueuedTask[] = [];
let running = 0;
let queueTimer: NodeJS.Timeout | null = null;

/** 任务优先级映射（按用户 plan: enterprise=3, pro=2, free=1） */
export function priorityForPlan(plan: string): number {
  return plan === "enterprise" ? 3 : plan === "pro" ? 2 : 1;
}

/** 入队（按优先级排序; 高优先级先执行）+ V396-5 持久化到 DB */
export async function enqueueTask(input: { taskId: string; priority?: number; run: () => Promise<void> }): Promise<void> {
  const item: QueuedTask = { taskId: input.taskId, priority: input.priority ?? 1, run: input.run };
  // 插入排序（优先级降序, 同优先级先入先出）
  let idx = queue.length;
  while (idx > 0 && queue[idx - 1].priority < item.priority) idx--;
  queue.splice(idx, 0, item);
  // V396-5: 持久化队列条目（重启后可恢复）
  try {
    await pool.query(
      `insert into agent_task_queue (task_id, priority) values ($1::uuid, $2)
       on conflict (task_id) do update set priority = excluded.priority`,
      [input.taskId, input.priority ?? 1]
    );
  } catch { /* 持久化失败不阻塞执行 */ }
  void pump();
}

/** 泵: 有槽位就取出队首执行（V396-5: 出队时清 DB 条目） */
async function pump(): Promise<void> {
  if (running >= MAX_CONCURRENT || queue.length === 0) return;
  const item = queue.shift()!;
  // 差距K②: 依赖门 — 前置任务未全部 completed → 重新入队等待（DAG 调度）
  try {
    const r = await pool.query(
      `select bool_and(status = 'completed') as ready from agent_tasks
       where id = any((select depends_on from agent_tasks where id = $1::uuid))`,
      [item.taskId]
    );
    const ready = r.rows[0]?.ready;
    if (ready === false) {
      // 依赖未满足 → 重新入队（保序插回队首前, 避免饥饿）
      const deps = await pool.query(`select depends_on from agent_tasks where id = $1::uuid`, [item.taskId]);
      const pending = (deps.rows[0]?.depends_on || []).length;
      console.log(`[agent] 差距K② 任务 ${item.taskId.slice(0, 8)} 依赖未满足(${pending} 个前置), 重新排队`);
      queue.unshift(item);
      return;
    }
  } catch { /* 依赖查询失败 → 直接执行（不阻塞） */ }
  // 出队 → 清持久化条目
  try { await pool.query("delete from agent_task_queue where task_id = $1::uuid", [item.taskId]); } catch { /* ignore */ }
  running++;
  void (async () => {
    try { await item.run(); } catch { /* 执行错误由调用方处理 */ }
    finally {
      running--;
      void pump();
    }
  })();
}

/** V396-5: 启动恢复 — ①清空内存队列 ②DB 里遗留的队列条目直接删除 ③running 卡死任务置 failed 可重试
 * G9: ④planning 卡死(>24h 未流转)置 failed ⑤awaiting_approval 超时(复用 timeoutPendingApprovals, 60分钟) */
export async function recoverAfterRestart(): Promise<{ recoveredTasks: string[]; clearedQueue: number; stuckPlanning: string[]; approvalTimedOut: number; checkpointRestores: number }> {
  const recovered: string[] = [];
  const stuckPlanning: string[] = [];
  let clearedQueue = 0;
  let approvalTimedOut = 0;
  let checkpointRestores = 0;
  try {
    // 借鉴3(DSH): 带 checkpoint 的 running 任务 → 保留为续跑（不置 failed）
    const cpTasks = await pool.query(
      `select id from agent_tasks where status = 'running' and checkpoint is not null`
    );
    checkpointRestores = cpTasks.rowCount || 0;
    if (checkpointRestores > 0) {
      console.log(`[agent] 借鉴3 发现 ${checkpointRestores} 个带 checkpoint 的任务（重启后按快照续跑）`);
    }
    // ① running 卡死任务(无 checkpoint) → failed(可重试), 但 awaiting_approval/paused 保留(可恢复)
    const r = await pool.query(
      `update agent_tasks set status = 'failed', progress = coalesce(progress, '') || '（进程重启中断, 可重试）', updated_at = now()
       where status = 'running' and checkpoint is null returning id`
    );
    for (const row of r.rows) recovered.push(row.id);
    // ② 清空持久化队列条目（内存队列已空, 条目作废）
    const q = await pool.query("delete from agent_task_queue");
    clearedQueue = q.rowCount || 0;
    // ③ G9: planning 卡死 — 超过 24h 仍停留在 planning(LLM 规划失败/进程中断) → 置 failed
    const p = await pool.query(
      `update agent_tasks set status = 'failed', progress = '规划卡死超过 24 小时, 已终止(可重试)', updated_at = now()
       where status = 'planning' and updated_at < now() - interval '24 hours' returning id`
    );
    for (const row of p.rows) stuckPlanning.push(row.id);
    // ④ G9: awaiting_approval 超时 — 复用 G6 的 timeoutPendingApprovals(60 分钟未响应 → 按拒绝处理)
    const { timeoutPendingApprovals } = await import("./agent-task-service.js");
    const timedOut = await timeoutPendingApprovals(60);
    approvalTimedOut = timedOut.timedOut;
    if (recovered.length > 0 || clearedQueue > 0 || stuckPlanning.length > 0 || approvalTimedOut > 0 || checkpointRestores > 0) {
      console.log(`[agent] V396-5+G9+借鉴3 重启恢复: ${recovered.length} 个 running 置 failed, 清空队列条目 ${clearedQueue}, planning 卡死 ${stuckPlanning.length}, 审批超时 ${approvalTimedOut}, checkpoint 续跑 ${checkpointRestores}`);
    }
  } catch (e: any) {
    console.error("[agent] V396-5 恢复失败:", String(e?.message || e).slice(0, 100));
  }
  return { recoveredTasks: recovered, clearedQueue, stuckPlanning, approvalTimedOut, checkpointRestores };
}

/** 队列状态（前端展示） */
export function queueStatus(): { queued: number; running: number; maxConcurrent: number; items: Array<{ taskId: string; priority: number }> } {
  return { queued: queue.length, running, maxConcurrent: MAX_CONCURRENT, items: queue.map((q) => ({ taskId: q.taskId, priority: q.priority })) };
}

/** 清理定时器（测试用） */
export function resetQueueForTest(): void {
  queue.length = 0;
  running = 0;
}

/** 服务关闭时清理 */
export function shutdownQueue(): void {
  if (queueTimer) clearInterval(queueTimer);
}

export const agentTaskQueue = { enqueueTask, queueStatus, priorityForPlan, shutdownQueue, recoverAfterRestart };
