// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-task-queue.ts — V394-4: 任务调度队列
// 多任务并发控制: 串行/并发上限/优先级
// 原理: 内存队列 + 信号量（每任务一个执行器槽位）
// V396-5: 队列持久化(agent_task_queue 表) + 启动恢复(running 卡死→failed 可重试)
// V405(P2 租约): 跨进程防双跑 — 出队执行前先抢 DB 级执行租约(holder+fencing+until),
//   心跳续期; 断线/过期 → 他人可抢(原持有者续租被拒自动放弃)。
//   解决: 多实例/重启竞态下同一任务被两进程同时 runAgentTask(旧 recovery 只覆盖本进程队列)
import { pool } from "../db/pool.js";
import { randomUUID } from "node:crypto";

/** 并发上限（AGENT_QUEUE_CONCURRENCY 覆盖, 默认 2） */
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.AGENT_QUEUE_CONCURRENCY || "2", 10));

/** V405: 本实例唯一执行者标识(重启变化 → 旧租约自动失效) */
const LEASE_HOLDER = `instance:${randomUUID().slice(0, 8)}:${process.pid}`;
/** V405: 租约 TTL(默认 120s — 心跳间隔应 < TTL/2) */
const LEASE_TTL_SECONDS = parseInt(process.env.AGENT_LEASE_TTL || "120", 10);

interface QueuedTask {
  taskId: string;
  priority: number;       // 1(低) ~ 3(高)
  run: () => Promise<void>;
}

/** 执行方式的登记表: 把"怎么跑"从内存闭包里解放出来, 让任何实例都能接手
 *  (原来 run 只活在接到 POST 的那个副本内存里 → 副本缩容 = 任务蒸发) */
export interface QueueRunnerPayload { taskId: string; [k: string]: unknown }
type QueueRunner = (payload: QueueRunnerPayload) => Promise<void>;
const runners = new Map<string, QueueRunner>();
/** 注册一种可跨实例重建的执行方式(启动时注册, 与 agent_task_queue.runner 对应) */
export function registerQueueRunner(name: string, fn: QueueRunner): void { runners.set(name, fn); }

const queue: QueuedTask[] = [];
let running = 0;
let queueTimer: NodeJS.Timeout | null = null;
/** 本实例标识(与执行租约同源, 但每次领取再带序号, 避免同进程两个领取者互相认成自己人) */
let claimSeq = 0;
const claimHolder = () => `${LEASE_HOLDER}#q${++claimSeq}`;
/** 领取租约时长: 超时未续 → 其他实例可接手(副本崩溃后的兜底) */
const CLAIM_TTL_SECONDS = Math.max(60, parseInt(process.env.AGENT_QUEUE_CLAIM_TTL || "300", 10));

/** V405: 抢占/续期任务执行租约(原子: 空闲或已过期才能易主; 自己持有则续期保 token)
 * 返回 token 表示持锁成功; 抢不到(他人持有未过期)返回 null — 调用方必须跳过该任务 */
export async function acquireTaskLease(taskId: string): Promise<number | null> {
  try {
    const r = await pool.query(
      `update agent_tasks set
         exec_lease_holder = case
           when exec_lease_holder = $2 and exec_lease_until > now() then exec_lease_holder
           when exec_lease_holder is null or exec_lease_until <= now() then $2
           else exec_lease_holder
         end,
         exec_lease_token = case
           when exec_lease_holder = $2 and exec_lease_until > now() then exec_lease_token
           when exec_lease_holder is null or exec_lease_until <= now() then coalesce(exec_lease_token, 0) + 1
           else exec_lease_token
         end,
         exec_lease_until = case
           when exec_lease_holder = $2 and exec_lease_until > now() then now() + ($3::int || ' seconds')::interval
           when exec_lease_holder is null or exec_lease_until <= now() then now() + ($3::int || ' seconds')::interval
           else exec_lease_until
         end
       where id = $1::uuid
       returning exec_lease_holder, exec_lease_token`,
      [taskId, LEASE_HOLDER, LEASE_TTL_SECONDS]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    if (row.exec_lease_holder !== LEASE_HOLDER) return null; // 他人持有且未过期 → 抢不到
    return Number(row.exec_lease_token);
  } catch (e: any) {
    console.error("[agent-lease] acquire failed:", e?.message?.slice(0, 100));
    return null; // DB 不可用 → 保守跳过(不双跑)
  }
}

/** 心跳续期: 仅自己持有(且 token 匹配)时延长 until — 旧持有者(已被他人抢走)续租被拒 */
export async function heartbeatTaskLease(taskId: string, token: number): Promise<boolean> {
  try {
    const r = await pool.query(
      `update agent_tasks set exec_lease_until = now() + ($3::int || ' seconds')::interval
       where id = $1::uuid and exec_lease_holder = $2 and exec_lease_token = $3
       returning id`,
      [taskId, LEASE_HOLDER, token]
    );
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/** 释放租约(仅自己持有且 token 匹配 — fencing: 被抢走后旧 token 释放无效) */
export async function releaseTaskLease(taskId: string, token: number): Promise<void> {
  try {
    await pool.query(
      `update agent_tasks set exec_lease_holder = null, exec_lease_token = null, exec_lease_until = null
       where id = $1::uuid and exec_lease_holder = $2 and exec_lease_token = $3`,
      [taskId, LEASE_HOLDER, token]
    );
  } catch { /* 释放失败由 TTL 兜底 */ }
}

/** 任务优先级映射（按用户 plan: enterprise=3, pro=2, free=1） */
export function priorityForPlan(plan: string): number {
  return plan === "enterprise" ? 3 : plan === "pro" ? 2 : 1;
}

/** 入队（按优先级排序; 高优先级先执行）+ V396-5 持久化到 DB */
export async function enqueueTask(input: {
  taskId: string; priority?: number; run: () => Promise<void>;
  /** 跨实例可重建的执行方式(不传则只在内存队列里执行, 副本缩容会丢) */
  runner?: string; payload?: Record<string, unknown>;
}): Promise<void> {
  const item: QueuedTask = { taskId: input.taskId, priority: input.priority ?? 1, run: input.run };
  // 插入排序（优先级降序, 同优先级先入先出）
  let idx = queue.length;
  while (idx > 0 && queue[idx - 1].priority < item.priority) idx--;
  queue.splice(idx, 0, item);
  // 持久化队列条目: 带 runner + payload, 这样别的实例/重启后也能重建执行
  try {
    await pool.query(
      `insert into agent_task_queue (task_id, priority, runner, payload)
       values ($1::uuid, $2, $3, $4::jsonb)
       on conflict (task_id) do update set priority = excluded.priority,
         runner = excluded.runner, payload = excluded.payload,
         exec_holder = null, exec_until = null`,
      [input.taskId, input.priority ?? 1, input.runner ?? "agent-task", JSON.stringify(input.payload ?? { taskId: input.taskId })]
    );
  } catch (e) {
    console.error("[agent-queue] 队列条目落库失败(本进程仍会执行):", String((e as Error)?.message ?? e).slice(0, 120));
  }
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
  // V405(P2 租约): 执行前先抢 DB 租约 — 抢不到(其他实例正持有)则本任务让位重新排队,
  // 防双实例同跑同一任务(原内存队列只能防单进程内并发)
  const leaseToken = await acquireTaskLease(item.taskId);
  if (leaseToken === null) {
    console.log(`[agent] 租约被其他实例持有, 任务 ${item.taskId.slice(0, 8)} 重新排队(等待其 TTL 过期)`);
    queue.unshift(item);
    return;
  }
  running++;
  void (async () => {
    try { await item.run(); } catch { /* 执行错误由调用方处理 */ }
    finally {
      await releaseTaskLease(item.taskId, leaseToken);
      running--;
      void pump();
    }
  })();
}

/**
 * DB 领取扫描(多副本关键): 从共享队列表里领任务并**就地重建执行闭包**。
 * 没有这一步, 队列表只是"记录"而不是"队列" —— 副本缩容时它内存里的任务没人接手,
 * 会一直停在 planning(要等 24h 才被清)。
 * 用 `for update skip locked` 保证同一行不会被两个实例同时领走。
 */
export async function drainDbQueueOnce(): Promise<number> {
  if (running >= MAX_CONCURRENT) return 0;
  const holder = claimHolder();
  let claimed: Array<{ task_id: string; runner: string; payload: Record<string, unknown>; attempts: number }> = [];
  try {
    const r = await pool.query(
      `update agent_task_queue set exec_holder = $1, exec_until = now() + ($2::int || ' seconds')::interval,
              attempts = attempts + 1
        where task_id = (
          select task_id from agent_task_queue
           where exec_until is null or exec_until < now()
           order by priority desc, enqueued_at asc
           limit 1
           for update skip locked)
        returning task_id, runner, payload, attempts`,
      [holder, CLAIM_TTL_SECONDS]
    );
    claimed = r.rows as typeof claimed;
  } catch (e) {
    console.error("[agent-queue] 领取失败:", String((e as Error)?.message ?? e).slice(0, 120));
    return 0;
  }
  if (!claimed.length) return 0;
  const { task_id, runner, payload, attempts } = claimed[0];
  const fn = runners.get(runner);
  if (!fn) {
    // 认不出的执行方式(旧版本写的条目/插件卸载) → 清掉, 别占着队列
    console.error(`[agent-queue] 未知 runner「${runner}」, 丢弃条目 ${String(task_id).slice(0, 8)}`);
    await pool.query("delete from agent_task_queue where task_id = $1::uuid", [task_id]).catch(() => {});
    return 0;
  }
  if (attempts > 5) {
    await pool.query("delete from agent_task_queue where task_id = $1::uuid", [task_id]).catch(() => {});
    console.error(`[agent-queue] 任务 ${String(task_id).slice(0, 8)} 领取超过 5 次, 丢弃(疑似毒任务)`);
    return 0;
  }
  // 依赖门: 前置未完成 → 放回等待(别执行)
  try {
    const d = await pool.query(
      `select bool_and(status = 'completed') as ready from agent_tasks
        where id = any((select depends_on from agent_tasks where id = $1::uuid))`,
      [task_id]
    );
    if (d.rows[0]?.ready === false) {
      await pool.query(
        `update agent_task_queue set exec_holder = null, exec_until = now() - interval '1 second'
          where task_id = $1::uuid`, [task_id]
      ).catch(() => {});
      return 0;
    }
  } catch { /* 依赖查询失败 → 照常执行 */ }

  // 任务级执行租约(与内存队列那条路径共用): 抢不到说明别的实例正在跑
  const leaseToken = await acquireTaskLease(String(task_id));
  if (leaseToken === null) {
    await pool.query(
      `update agent_task_queue set exec_holder = null, exec_until = now() - interval '1 second'
        where task_id = $1::uuid`, [task_id]
    ).catch(() => {});
    return 0;
  }
  running++;
  void (async () => {
    try {
      // 领取即从队列移除: 执行闭包已在手上, 重启后由 recoverAfterRestart 的 running 兜底
      await pool.query("delete from agent_task_queue where task_id = $1::uuid", [task_id]).catch(() => {});
      await fn({ ...payload, taskId: String(task_id) });
    } catch (e) {
      console.error(`[agent-queue] DB 领取执行失败 ${String(task_id).slice(0, 8)}:`, String((e as Error)?.message ?? e).slice(0, 150));
    } finally {
      await releaseTaskLease(String(task_id), leaseToken);
      running--;
      void pump();
    }
  })();
  return 1;
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
    //    归属过滤: 不加的话, 多副本下新副本一启动就会把**兄弟副本正在跑的任务**全标失败(扩容即破坏)。
    //    只处理"租约为空或已过期"的行 —— 那才是真的没人跑。
    const r = await pool.query(
      `update agent_tasks set status = 'failed', progress = coalesce(progress, '') || '（进程重启中断, 可重试）', updated_at = now()
       where status = 'running' and checkpoint is null
         and (exec_lease_until is null or exec_lease_until < now())
       returning id`
    );
    for (const row of r.rows) recovered.push(row.id);
    // ② 只清"本实例领取过、且租约已过期"的队列条目 —— 原来是无 where 的 delete from,
    //    会把其他副本正在执行的队列条目一并删掉
    const q = await pool.query(
      `delete from agent_task_queue
        where exec_holder like $1 and (exec_until is null or exec_until < now())`,
      [`${LEASE_HOLDER}#%`]
    );
    clearedQueue = q.rowCount || 0;
    // ③ G9: planning 卡死 — 超过 24h 仍停留在 planning(LLM 规划失败/进程中断) → 置 failed
    const p = await pool.query(
      `update agent_tasks set status = 'failed', progress = '规划卡死超过 24 小时, 已终止(可重试)', updated_at = now()
       where status = 'planning' and updated_at < now() - interval '24 hours'
         and (exec_lease_until is null or exec_lease_until < now())
       returning id`
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

export const agentTaskQueue = {
  enqueueTask, queueStatus, priorityForPlan, shutdownQueue, recoverAfterRestart,
  // V405(P2 租约): 供 runAgentTask 心跳/释放
  acquireTaskLease, heartbeatTaskLease, releaseTaskLease, leaseHolder: () => LEASE_HOLDER,
  // 多副本: DB 领取扫描 + 执行方式登记
  drainDbQueueOnce, registerQueueRunner,
};
