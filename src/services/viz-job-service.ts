// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// viz-job-service.ts — D4(闭源 VizView job 体系对齐): 中长绘图任务持久化执行
// 设计: runTurn(既有逐轮逻辑) 零改动包 RecordingSse 适配器 →
//   - 每个事件同步落 viz_job_events(seq 递增), SSE 连接断开任务照跑(后台完成)
//   - 断线重连 GET /viz/jobs/:id/stream?after=N → 重放已发生事件 + 挂起等新事件
//   - cancel 置 cancelled 标记; RecordingSse.send 感知 cancelled 即抛中断 → runTurn catch 收尾
// 迁移 132
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import type { AttachedSse } from "../api/stream-utils.js";
import { runTurn } from "./viz-agent-service.js";

export interface VizJobOpts {
  csv?: string; columnOrder?: string[]; spec?: Record<string, unknown>;
}

async function setStatus(jobId: string, status: string, patch: { currentStep?: string; error?: unknown } = {}) {
  const sets = ["status=$2", "updated_at=now()"];
  const vals: unknown[] = [jobId, status];
  if (patch.currentStep !== undefined) { sets.push(`current_step=$${vals.length + 1}`); vals.push(patch.currentStep); }
  if (patch.error !== undefined) { sets.push(`error=$${vals.length + 1}`); vals.push(JSON.stringify(patch.error)); }
  await pool.query(`update viz_jobs set ${sets.join(",")} where id=$1`, vals);
}

/** 中断标记: cancel 后由 send 感知抛出 */
class JobCancelledError extends Error { constructor() { super("job cancelled"); this.name = "JobCancelledError"; } }

/** RecordingSse: 把 runTurn 的 sse 调用落库(事件源) + cancelled 感知中断 */
type RecordingSse = AttachedSse & { markCancelled(): void };
function recordingSse(jobId: string, live?: AttachedSse): RecordingSse {
  let seq = 0;
  let cancelled = false;
  let done = false;
  const cancelledCheck = () => {
    if (cancelled) throw new JobCancelledError();
  };
  const out: RecordingSse = {
    send(event: string, data: unknown) {
      cancelledCheck();
      if (done) return;
      seq += 1;
      void pool.query(
        `insert into viz_job_events (job_id, seq, event, payload) values ($1,$2,$3,$4)`,
        [jobId, seq, event, JSON.stringify(data ?? {})]
      ).catch(() => {});
      if (live && !live.closed) live.send(event, data);
      // cancel 检查(事件落库后抛 → runTurn catch → done{error:cancelled})
      cancelledCheck();
    },
    error(err, code) {
      const shape = typeof err === "string"
        ? { message: err, code: code ?? "VIZ_FAILED", userMessage: err, canRetry: true }
        : { message: String((err as { message?: unknown })?.message ?? err), code: (err as { code?: string })?.code ?? code ?? "VIZ_FAILED", userMessage: String((err as { userMessage?: unknown })?.userMessage ?? err), canRetry: (err as { canRetry?: boolean })?.canRetry ?? true };
      this.send("error", shape);
    },
    end() {
      cancelledCheck();
      if (done) return;
      done = true;
      if (live && !live.closed) live.end();
    },
    get closed() { return done || cancelled || (live?.closed ?? false); },
    /** 由 cancelJob 调用: 置标记; 正在 send 的调用会抛中断 */
    markCancelled() { cancelled = true; },
  };
  return out;
}

const running = new Map<string, { cancel: () => void }>();

/** 创建绘图任务并后台执行(不等待完成, 调用方轮询/SSE 观察) */
export async function createVizJob(userId: string, sessionId: string, prompt: string, opts: VizJobOpts = {}): Promise<{ job_id: string }> {
  const sess = await pool.query(`select id from viz_sessions where id=$1 and user_id=$2`, [sessionId, userId]);
  if (!sess.rows.length) throw Object.assign(new Error("会话不存在"), { code: "NOT_FOUND", status: 404 });
  const id = randomUUID();
  await pool.query(
    `insert into viz_jobs (id, session_id, user_id, prompt, csv, column_order, spec) values ($1,$2,$3,$4,$5,$6,$7)`,
    [id, sessionId, userId, prompt, opts.csv ?? null, opts.columnOrder ?? [], JSON.stringify(opts.spec ?? {})]
  );
  // 后台执行(不 await; fire-and-forget, 生命周期独立于连接)
  void (async () => {
    const rec = recordingSse(id);
    running.set(id, { cancel: () => rec.markCancelled() });
    try {
      await setStatus(id, "running", { currentStep: "started" });
      await runTurn(userId, sessionId, prompt, rec, opts);
      await setStatus(id, "done", { currentStep: "completed" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cancelled = e instanceof JobCancelledError || msg === "job cancelled";
      await setStatus(id, cancelled ? "cancelled" : "failed", {
        currentStep: cancelled ? "cancelled" : "error",
        error: { userMessage: cancelled ? "任务已取消" : msg.slice(0, 300), canRetry: !cancelled },
      });
    } finally {
      running.delete(id);
    }
  })();
  return { job_id: id };
}

export async function getVizJob(userId: string, jobId: string) {
  const r = await pool.query(`select * from viz_jobs where id=$1 and user_id=$2`, [jobId, userId]);
  return r.rows[0] ?? null;
}

export async function cancelVizJob(userId: string, jobId: string): Promise<boolean> {
  const r = await pool.query(`update viz_jobs set status='cancelled', updated_at=now() where id=$1 and user_id=$2 and status in ('queued','running') returning id`, [jobId, userId]);
  if (r.rows.length) { running.get(jobId)?.cancel(); running.delete(jobId); return true; }
  return false;
}

export async function retryVizJob(userId: string, jobId: string): Promise<{ job_id: string } | null> {
  const r = await pool.query(`select * from viz_jobs where id=$1 and user_id=$2`, [jobId, userId]);
  const job = r.rows[0];
  if (!job || (job.status !== "failed" && job.status !== "cancelled")) return null;
  const opts: VizJobOpts = { csv: job.csv ?? undefined, columnOrder: job.column_order ?? [], spec: job.spec ?? {} };
  return createVizJob(userId, job.session_id, job.prompt, opts);
}

/** SSE 观察: 先重放 after 之后的事件(含断线期间落库的), 再挂起实时等新事件(最长 waitMs) */
export async function streamVizJob(userId: string, jobId: string, sse: AttachedSse, after = 0, waitMs = 120_000): Promise<void> {
  const job = await getVizJob(userId, jobId);
  if (!job) { sse.error({ code: "NOT_FOUND", userMessage: "任务不存在", canRetry: false }); sse.end(); return; }
  if (job.status === "failed") { sse.error({ code: "JOB_FAILED", userMessage: (job.error as { userMessage?: string })?.userMessage ?? "任务失败", canRetry: true }); sse.end(); return; }
  const replay = async () => {
    const ev = await pool.query(
      `select seq, event, payload from viz_job_events where job_id=$1 and seq>$2 order by seq asc`,
      [jobId, after]
    );
    for (const row of ev.rows) {
      if (sse.closed) return;
      after = Number(row.seq);
      sse.send(row.event, row.payload);
    }
  };
  // 已完成 → 重放后直接 done
  if (job.status === "done" || job.status === "cancelled") {
    await replay();
    if (job.status === "done" && !sse.closed) sse.send("viz.completed", { replayDone: true });
    sse.end();
    return;
  }
  await replay();
  // 挂起等新事件/终态(轮询 500ms)
  const deadline = Date.now() + waitMs;
  while (!sse.closed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const st = await pool.query(`select status from viz_jobs where id=$1`, [jobId]);
    const status = st.rows[0]?.status;
    const ev = await pool.query(
      `select seq, event, payload from viz_job_events where job_id=$1 and seq>$2 order by seq asc limit 50`,
      [jobId, after]
    );
    for (const row of ev.rows) {
      if (sse.closed) return;
      after = Number(row.seq);
      sse.send(row.event, row.payload);
    }
    if (status === "done") { sse.send("viz.completed", { replayDone: false }); sse.end(); return; }
    if (status === "failed" || status === "cancelled") { sse.end(); return; }
  }
  sse.end();
}
