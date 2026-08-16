// jobs-service.ts — Jobs 任务队列（GBrain Jobs 适配）
// minion_jobs 表 + worker（FOR UPDATE SKIP LOCKED 领取）+ Deterministic Task
// + Dream Cycle 9-phase + Trace Waterfall
//
// 用法：
//   jobsService.enqueue({ jobType: 'lint', payload: {} })
//   jobsService.startWorker()   // 后台轮询领取任务
//   GET /api/jobs → 队列状态
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

export type MinionJobType =
  | "lint"            // 检查数据完整性
  | "backlinks"       // 重算实体反向链接
  | "sync"            // 同步外部数据
  | "synthesize"      // Compiled Truth 整合
  | "embed"           // 批量 embedding
  | "orphans"         // 清理孤儿数据
  | "purge"           // 清理软删除
  | "extract"         // 抽取关系（GBrain 9-phase）
  | "patterns"        // 跨会话主题（GBrain 9-phase）
  | "recompute_emotional_weight" // 情感权重重算（GBrain 9-phase）
  | "dream_cycle"     // 夜间自整理（9-phase）
  | "batch_ingest"    // 批量入库
  | "hyperedge"       // 超边抽取
  | "clean"           // 清洗去重 (GBrain phase 1)
  | "classify"        // 语言检测+内容分类 (GBrain phase 2-3)
  | "disambiguate"    // 实体消歧 (GBrain phase 6)
  | "index_refresh"   // 向量+全文索引+统计报告 (GBrain phase 7-9)
  | "sleep_learn"    // V321(P1-8): 睡眠学习（记忆整理+修剪）
  | "autonomous_research"; // V376: 自主研究（③主动行为——每日记忆巡检+主题研究）

export type MinionJobStatus = "waiting" | "active" | "completed" | "failed" | "delayed" | "dead" | "cancelled" | "waiting-children" | "paused";

export interface MinionJob {
  id: string;
  jobType: MinionJobType;
  status: MinionJobStatus;
  queue: string;
  payload: Record<string, unknown>;
  result?: unknown;
  error?: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  attemptsStarted: number;
  backoffType: "fixed" | "exponential";
  backoffDelay: number;
  backoffJitter: number;
  stalledCounter: number;
  maxStalled: number;
  lockToken?: string;
  lockUntil?: string;
  delayUntil?: string;
  parentJobId?: string;
  onChildFail: string;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  progress?: unknown;
  timeoutMs?: number;
  timeoutAt?: string;
  idempotencyKey?: string;
  removeOnComplete: boolean;
  removeOnFail: boolean;
  stacktrace: unknown[];
  depth: number;
  maxChildren?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

function jobFromRow(row: Record<string, unknown>): MinionJob {
  return {
    id: String(row.id),
    jobType: String(row.job_type ?? row.name ?? "lint") as MinionJobType,
    status: String(row.status ?? "waiting") as MinionJobStatus,
    queue: String(row.queue ?? "default"),
    payload: (row.payload ?? row.data ?? {}) as Record<string, unknown>,
    result: row.result,
    error: row.error == null ? undefined : String(row.error ?? row.error_text),
    priority: Number(row.priority ?? 0),
    attempts: Number(row.attempts_made ?? row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    attemptsStarted: Number(row.attempts_started ?? 0),
    backoffType: (row.backoff_type ?? "exponential") as "fixed" | "exponential",
    backoffDelay: Number(row.backoff_delay ?? 1000),
    backoffJitter: Number(row.backoff_jitter ?? 0.2),
    stalledCounter: Number(row.stalled_counter ?? 0),
    maxStalled: Number(row.max_stalled ?? 5),
    lockToken: row.lock_token == null ? undefined : String(row.lock_token),
    lockUntil: row.lock_until == null ? undefined : String(row.lock_until),
    delayUntil: row.delay_until == null ? undefined : String(row.delay_until),
    parentJobId: row.parent_job_id == null ? undefined : String(row.parent_job_id),
    onChildFail: String(row.on_child_fail ?? "fail_parent"),
    tokensInput: Number(row.tokens_input ?? 0),
    tokensOutput: Number(row.tokens_output ?? 0),
    tokensCacheRead: Number(row.tokens_cache_read ?? 0),
    progress: row.progress,
    timeoutMs: row.timeout_ms == null ? undefined : Number(row.timeout_ms),
    timeoutAt: row.timeout_at == null ? undefined : String(row.timeout_at),
    idempotencyKey: row.idempotency_key == null ? undefined : String(row.idempotency_key),
    removeOnComplete: Boolean(row.remove_on_complete),
    removeOnFail: Boolean(row.remove_on_fail),
    stacktrace: Array.isArray(row.stacktrace) ? row.stacktrace : [],
    depth: Number(row.depth ?? 0),
    maxChildren: row.max_children == null ? undefined : Number(row.max_children),
    createdAt: String(row.created_at),
    startedAt: row.started_at == null ? undefined : String(row.started_at),
    completedAt: row.completed_at == null ? undefined : String(row.completed_at)
  };
}

/** 入队（支持 delay/idempotency/queue） */
export async function enqueueJob(input: {
  jobType: MinionJobType;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  schedule?: string;
  queue?: string;
  delayMs?: number;
  idempotencyKey?: string;
  parentJobId?: string;
  timeoutMs?: number;
}): Promise<MinionJob> {
  // 幂等：相同 idempotency_key 不重复入队
  if (input.idempotencyKey) {
    const existing = await pool.query(
      `select * from minion_jobs where idempotency_key = $1 and status in ('waiting','active','delayed')`,
      [input.idempotencyKey]
    );
    if (existing.rows.length > 0) return jobFromRow(existing.rows[0]);
  }
  const isDelayed = (input.delayMs ?? 0) > 0;
  const result = await pool.query(
    `insert into minion_jobs (id, job_type, status, queue, payload, priority, max_attempts, schedule,
       delay_until, idempotency_key, parent_job_id, timeout_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
    [
      randomUUID(), input.jobType, isDelayed ? "delayed" : "waiting",
      input.queue ?? "default", JSON.stringify(input.payload ?? {}),
      input.priority ?? 0, input.maxAttempts ?? 3, input.schedule ?? null,
      isDelayed ? new Date(Date.now() + input.delayMs!).toISOString() : null,
      input.idempotencyKey ?? null, input.parentJobId ?? null, input.timeoutMs ?? null
    ]
  );
  return jobFromRow(result.rows[0]);
}

/** 领取下一个任务（FOR UPDATE SKIP LOCKED + lock 租约 — GBrain worker 模式） */
export async function claimNextJob(workerId: string): Promise<MinionJob | null> {
  // 先恢复卡死任务（lock_until 过期 → 回 waiting，stalled_counter+1）
  await pool.query(
    `update minion_jobs set status = 'waiting', lock_token = null, lock_until = null,
       stalled_counter = stalled_counter + 1
     where status = 'active' and lock_until is not null and lock_until < now()`
  ).catch(() => {});
  // 超时任务 → failed
  await pool.query(
    `update minion_jobs set status = 'failed', error_text = 'timeout', completed_at = now()
     where status = 'active' and timeout_at is not null and timeout_at < now()`
  ).catch(() => {});
  // 延迟任务到期 → waiting
  await pool.query(
    `update minion_jobs set status = 'waiting', delay_until = null
     where status = 'delayed' and delay_until is not null and delay_until <= now()`
  ).catch(() => {});

  const result = await pool.query(
    `with next_job as (
       select id from minion_jobs
       where status = 'waiting' and (queue = 'default' or queue = '')
       order by priority desc, created_at asc
       limit 1
       for update skip locked
     )
     update minion_jobs m
     set status = 'active', lock_token = $1, lock_until = now() + interval '5 minutes',
         started_at = now(), attempts_made = attempts_made + 1, attempts_started = attempts_started + 1,
         timeout_at = case when m.timeout_ms is not null then now() + (m.timeout_ms || ' ms')::interval else m.timeout_at end,
         updated_at = now()
     from next_job
     where m.id = next_job.id
     returning m.*`,
    [workerId]
  );
  return result.rows.length > 0 ? jobFromRow(result.rows[0]) : null;
}

/** 完成/失败（带退避重试 + stalled 检测） */
export async function finishJob(jobId: string, status: "completed" | "failed", result?: unknown, error?: string): Promise<void> {
  await pool.query(
    `update minion_jobs set status = $2, result = $3, error_text = $4,
       lock_token = null, lock_until = null, completed_at = now(), updated_at = now()
     where id = $1`,
    [jobId, status, result == null ? null : JSON.stringify(result), error ?? null]
  );
}

/** 指数退避延迟（GBrain backoff） */
function computeBackoffDelay(job: MinionJob, attempts: number): number {
  const base = job.backoffType === "exponential"
    ? job.backoffDelay * Math.pow(2, Math.max(0, attempts - 1))
    : job.backoffDelay;
  const jitter = base * job.backoffJitter * (Math.random() - 0.5);
  return Math.max(100, Math.round(base + jitter));
}

/** 任务处理器注册表 */
export type JobHandler = (job: MinionJob) => Promise<unknown>;

const handlers = new Map<MinionJobType, JobHandler>();

export function registerHandler(jobType: MinionJobType, handler: JobHandler): void {
  handlers.set(jobType, handler);
}

export function hasHandler(jobType: MinionJobType): boolean {
  return handlers.has(jobType);
}

/** 直接执行 handler（dream_cycle 内部 phase 用：不走数据库 finishJob，内存子 job 无行可更新） */
export async function runHandlerDirect(jobType: MinionJobType, job?: MinionJob): Promise<unknown> {
  const handler = handlers.get(jobType);
  if (!handler) return "skipped (no handler)";
  return handler(job ?? ({} as MinionJob));
}

/** 执行单个任务（带指数退避重试 + stalled 检测 + token 计量入口 + Trace span） */
export async function executeJob(job: MinionJob): Promise<void> {
  const handler = handlers.get(job.jobType);
  if (!handler) {
    await finishJob(job.id, "failed", undefined, `no handler for job type: ${job.jobType}`);
    return;
  }
  // Trace Waterfall：任务执行 span
  const startedAt = Date.now();
  const traceSpan = (globalThis as { __sagTraceId?: string }).__sagTraceId;
  try {
    const result = await handler(job);
    await finishJob(job.id, "completed", result);
    // 任务 span 落库
    if (traceSpan) {
      import("./trace-service.js").then(({ recordSpan }) => {
        void recordSpan({
          traceId: traceSpan, kind: "job", name: job.jobType, status: "ok",
          durationMs: Date.now() - startedAt,
          tokens: { input: job.tokensInput, output: job.tokensOutput, cacheRead: job.tokensCacheRead }
        }).catch(() => {});
      }).catch(() => {});
    }
    // remove_on_complete：完成后自动清理
    if (job.removeOnComplete) {
      await pool.query(`delete from minion_jobs where id = $1`, [job.id]).catch(() => {});
    }
    // 子任务完成 → 通知父任务
    if (job.parentJobId) {
      await resolveParent(job.parentJobId, "completed");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // 任务失败 span 落库
    if (traceSpan) {
      import("./trace-service.js").then(({ recordSpan }) => {
        void recordSpan({
          traceId: traceSpan, kind: "job", name: job.jobType, status: "error",
          durationMs: Date.now() - startedAt, detail: msg.slice(0, 200)
        }).catch(() => {});
      }).catch(() => {});
    }
    if (job.attempts < job.maxAttempts) {
      // 指数退避重试：回 delayed（delay_until = now + backoff）
      const delayMs = computeBackoffDelay(job, job.attempts);
      await pool.query(
        `update minion_jobs set status = 'delayed', error_text = $2, delay_until = now() + ($3 || ' ms')::interval,
           lock_token = null, lock_until = null, updated_at = now()
         where id = $1`,
        [job.id, msg, delayMs]
      );
      // 子任务退避重试时：父任务也标记有子失败（waiting-children），避免父无限挂起
      if (job.parentJobId) {
        await pool.query(
          `update minion_jobs set status = 'waiting-children', progress = jsonb_set(
             coalesce(progress, '{}'::jsonb), '{child_retries}',
             coalesce(progress->'child_retries', '0'::jsonb) + '1'
           ), updated_at = now() where id = $1`,
          [job.parentJobId]
        ).catch(() => {});
      }
    } else {
      // 超过 max_stalled → dead
      if (job.stalledCounter >= job.maxStalled) {
        await pool.query(
          `update minion_jobs set status = 'dead', error_text = $2, lock_token = null, lock_until = null,
             stacktrace = coalesce(stacktrace, '[]'::jsonb) || jsonb_build_array($2), completed_at = now(), updated_at = now()
           where id = $1`,
          [job.id, msg]
        );
      } else {
        await finishJob(job.id, "failed", undefined, msg);
        if (job.removeOnFail) {
          await pool.query(`delete from minion_jobs where id = $1`, [job.id]).catch(() => {});
        }
      }
      if (job.parentJobId) {
        await resolveParent(job.parentJobId, "failed");
      }
    }
  }
}

/** token 计量（LLM 调用后累计到任务 — GBrain tokens_input/output/cache_read） */
export async function addJobTokens(jobId: string, tokens: { input?: number; output?: number; cacheRead?: number }): Promise<void> {
  if (!jobId) return;
  await pool.query(
    `update minion_jobs set
       tokens_input = tokens_input + $2,
       tokens_output = tokens_output + $3,
       tokens_cache_read = tokens_cache_read + $4,
       updated_at = now()
     where id = $1`,
    [jobId, tokens.input ?? 0, tokens.output ?? 0, tokens.cacheRead ?? 0]
  ).catch(() => {});
}

/** 更新任务进度（GBrain progress） */
export async function updateJobProgress(jobId: string, progress: unknown): Promise<void> {
  if (!jobId) return;
  await pool.query(
    `update minion_jobs set progress = $2, updated_at = now() where id = $1`,
    [jobId, progress == null ? null : JSON.stringify(progress)]
  ).catch(() => {});
}

/** 父任务子任务完成处理（GBrain on_child_fail 4 策略：fail_parent / remove_dep / ignore / continue） */
async function resolveParent(parentJobId: string, childStatus: "completed" | "failed"): Promise<void> {
  try {
    const parent = await pool.query(`select * from minion_jobs where id = $1`, [parentJobId]);
    if (parent.rows.length === 0) return;
    const onChildFail = String(parent.rows[0].on_child_fail ?? "fail_parent");
    if (childStatus === "completed") {
      // 所有子任务完成 → 父任务回 waiting（可继续）
      const openChildren = await pool.query(
        `select count(*)::int as n from minion_jobs where parent_job_id = $1 and status in ('waiting','active','delayed','waiting-children')`,
        [parentJobId]
      );
      if (openChildren.rows[0].n === 0) {
        await pool.query(`update minion_jobs set status = 'waiting', updated_at = now() where id = $1`, [parentJobId]);
      }
      return;
    }
    // 子任务失败 → 按 on_child_fail 策略处理
    switch (onChildFail) {
      case "fail_parent":
        await pool.query(`update minion_jobs set status = 'failed', error_text = 'child failed', completed_at = now() where id = $1`, [parentJobId]);
        break;
      case "remove_dep":
        // 删除父任务（子失败即整体失败，但父也被移除）
        await pool.query(`delete from minion_jobs where id = $1`, [parentJobId]);
        break;
      case "ignore":
        // 忽略子失败，父任务继续（子失败不影响父）
        await pool.query(`update minion_jobs set status = 'waiting', updated_at = now() where id = $1`, [parentJobId]);
        break;
      case "continue":
        // 父标记继续（进度字段标注子失败）
        await pool.query(
          `update minion_jobs set status = 'waiting', progress = jsonb_set(
             coalesce(progress, '{}'::jsonb), '{child_failures}',
             coalesce(progress->'child_failures', '0'::jsonb) + '1'
           ), updated_at = now() where id = $1`,
          [parentJobId]
        );
        break;
      default:
        await pool.query(`update minion_jobs set status = 'failed', error_text = 'child failed', completed_at = now() where id = $1`, [parentJobId]);
    }
  } catch { /* 父任务处理失败不阻断 */ }
}

/** 后台 worker：轮询领取并执行（每 2s 一次） */
let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;

export function startWorker(intervalMs = 2000): void {
  if (workerTimer) return;
  const workerId = `worker-${randomUUID().slice(0, 8)}`;
  workerTimer = setInterval(async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      const job = await claimNextJob(workerId);
      if (job) {
        await executeJob(job);
      }
    } catch (error) {
      console.error("[jobs] worker error:", error instanceof Error ? error.message : String(error));
    } finally {
      workerRunning = false;
    }
  }, intervalMs);
}

export function stopWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

/** 列出任务（Trace Waterfall 数据源） */
export async function listJobs(input: { status?: string; limit?: number } = {}): Promise<MinionJob[]> {
  const statusFilter = input.status ? ` and status = '${input.status}'` : "";
  const result = await pool.query(
    `select * from minion_jobs where 1=1${statusFilter} order by created_at desc limit $1`,
    [input.limit ?? 50]
  );
  return result.rows.map(jobFromRow);
}

/** 统计（Jobs UI 用） */
export async function jobStats(): Promise<Record<string, number>> {
  const result = await pool.query(
    `select status, count(*)::int as n from minion_jobs group by status`
  );
  const stats: Record<string, number> = {};
  for (const row of result.rows) stats[String(row.status)] = Number(row.n);
  return stats;
}

/** 删除任务（仅限非 active 状态） */
export async function deleteJob(jobId: string): Promise<boolean> {
  const result = await pool.query(
    `delete from minion_jobs where id = $1 and status != 'active'`,
    [jobId]
  );
  return (result.rowCount ?? 0) > 0;
}

export const jobsService = {
  enqueue: enqueueJob,
  claimNext: claimNextJob,
  finish: finishJob,
  execute: executeJob,
  runHandlerDirect,
  registerHandler,
  hasHandler,
  startWorker,
  stopWorker,
  list: listJobs,
  stats: jobStats,
  delete: deleteJob,
  addTokens: addJobTokens,
  updateProgress: updateJobProgress
};
