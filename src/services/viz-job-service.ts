// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// viz-job-service.ts — D4(闭源 VizView job 体系对齐): 中长绘图任务持久化执行
// 设计: runTurn(既有逐轮逻辑) 零改动包 RecordingSse 适配器 →
//   - 每个事件同步落 viz_job_events(seq 递增), SSE 连接断开任务照跑(后台完成)
//   - 断线重连 GET /viz/jobs/:id/stream?after=N → 重放已发生事件 + 挂起等新事件
//   - cancel 置 cancelled 标记; RecordingSse.send 感知 cancelled 即抛中断 → runTurn catch 收尾
// 审查修复(S1-S5/M3/M4): 取消防覆盖/error 不二次抛/挂起无限/sse 终态唯一/failed 先重放
// 迁移 132
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import type { AttachedSse } from "../api/stream-utils.js";
import { runTurn } from "./viz-agent-service.js";
import * as vizExec from "./viz-exec-service.js";

/**
 * file_id 的两种历史形状: 早期上传接口写 'file_<uuid>', 现在写裸 uuid。
 * 只按其中一种 JOIN 会让另一种的任务查不到文件名 → 任务卡把"用了真实数据"标成"示意图"(实测踩过)。
 */
const FILE_ID_MATCH = "u.id::text = regexp_replace(j.file_id, '^file_', '')";

export interface VizJobOpts {
  csv?: string; columnOrder?: string[]; spec?: Record<string, unknown>;
  /** 数据来源文件(/files/upload 的 fileId) — 与 csv 二选一, 有 fileId 则由服务端取真实数据 */
  fileId?: string;
  /** 数据来源文件名(仅记录/提示用) */
  fileName?: string;
  /** 闭源 VizView journalConfig(期刊/双栏/DPI/字号/配色/尺寸) — 转成绘图 spec */
  journalConfig?: Record<string, unknown>;
}

/** 期刊规范覆盖: journalConfig 的显式尺寸/字号/线宽优先于预设 spec(缺省回落到预设) */
function mergeSpec(spec: Record<string, unknown> | undefined, journalConfig: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(spec ?? {}) };
  if (!journalConfig) return out;
  // 尺寸只在调用方未显式给 spec 尺寸时采用(panel 预设更具体, 不被默认值覆盖)
  const hasExplicitSize = spec?.widthMm != null || spec?.heightMm != null;
  if (!hasExplicitSize) {
    if (journalConfig.widthMm != null) out.widthMm = journalConfig.widthMm;
    if (journalConfig.heightMm != null) out.heightMm = journalConfig.heightMm;
  }
  for (const k of ["dpi", "fontSize", "fontFamily"]) {
    if (out[k] == null && journalConfig[k] != null) out[k] = journalConfig[k];
  }
  if (out.lineWidth == null) {
    // 闭源 journalConfig 把轴线/数据线分开, specPrompt 只认单一 lineWidth → 取数据线
    out.lineWidth = journalConfig.dataLineWidth ?? journalConfig.axisLineWidth;
  }
  for (const k of ["journal", "layout", "colorScheme"]) {
    if (journalConfig[k] != null) out[k] = journalConfig[k];
  }
  return out;
}

/**
 * 数据来源解析(2026-09-11): opts.csv 优先(调用方已备好文本); 否则按 fileId 从 user_files 取真实数据。
 * 两者都没有 → 返回 undefined(示意图模式), 由 runTurn 明说而不是静默编数据。
 */
async function resolveOpts(userId: string, opts: VizJobOpts): Promise<VizJobOpts> {
  const spec = mergeSpec(opts.spec, opts.journalConfig);
  if (opts.csv && opts.csv.trim()) return { ...opts, spec };
  if (!opts.fileId) return { ...opts, spec };   // 本来就没选数据源 = 示意图, 正常
  const data = await vizExec.resolveJobData(userId, opts.fileId);
  if (!data) {
    // 传了 fileId 却取不到数据 = 文件被删/不可读/不是表格 —— 必须报错而不是静默降级:
    //   否则任务照样 done, 用户分不清"取数失败"和"故意不传数据"(后者是编数值的示意图)
    throw Object.assign(new Error("数据文件读取失败, 请重新选择数据源(文件可能已被删除或不是表格)"),
      { code: "DATA_UNREADABLE", status: 400 });
  }
  return { ...opts, spec, csv: data.csv, columnOrder: data.columnOrder, fileName: data.fileName };
}

/** 终态仅允许从 running/queued 迁移(防 cancel 后被 done 覆盖 — 审查 S1) */
async function setStatus(jobId: string, status: string, patch: { currentStep?: string; error?: unknown } = {}) {
  const sets = ["status=$2", "updated_at=now()"];
  const vals: unknown[] = [jobId, status];
  if (patch.currentStep !== undefined) { sets.push(`current_step=$${vals.length + 1}`); vals.push(patch.currentStep); }
  if (patch.error !== undefined) { sets.push(`error=$${vals.length + 1}`); vals.push(JSON.stringify(patch.error)); }
  // 转成功时清掉失败痕迹: 否则"先失败后成功"的任务行上留着旧 error, 前端按 error 判失败会误报
  if (status === "done") sets.push("error=null");
  // 终态更新只在非终态行上生效(cancel/其他并发已置终态时不覆盖)
  await pool.query(
    `update viz_jobs set ${sets.join(",")}
      where id=$1 and status in ('queued','running')`,
    vals
  );
}

/** 中断标记: cancel 后由 send 感知抛出 */
class JobCancelledError extends Error { constructor() { super("job cancelled"); this.name = "JobCancelledError"; } }

/** RecordingSse: 把 runTurn 的 sse 调用落库(事件源) + cancelled 感知中断
 *  审查 S2: error/end 不抛 — runTurn 内层 catch 调 sse.error 时若已 cancelled,
 *  直接落 error 事件并吞掉(不再二次抛导致异常逃逸)
 *  审查 S6: 事件 INSERT 串行队列 — 终态补插 await 队列保证 seq 顺序(防 unique 冲突/丢事件) */
type RecordingSse = AttachedSse & { markCancelled(): void; isCancelled(): boolean; flush(): Promise<unknown> };
function recordingSse(jobId: string, live?: AttachedSse): RecordingSse {
  let seq = 0;
  let cancelled = false;
  let done = false;
  let insertChain: Promise<unknown> = Promise.resolve();
  /** 事件落库(同步入队, 顺序保证); 返回 await 后可确保已持久化 */
  const persist = (event: string, data: unknown) => {
    seq += 1;
    const s = seq;
    insertChain = insertChain.then(() =>
      pool.query(
        `insert into viz_job_events (job_id, seq, event, payload) values ($1,$2,$3,$4)`,
        [jobId, s, event, JSON.stringify(data ?? {})]
      ).catch(() => {})
    );
    return s;
  };
  const out: RecordingSse = {
    send(event: string, data: unknown) {
      // cancelled 后 send 抛中断(runTurn 收尾); 事件先入队保证重放有上下文
      persist(event, data);
      if (cancelled) throw new JobCancelledError();
      if (done) return;
      if (live && !live.closed) live.send(event, data);
    },
    error(err, code) {
      const shape = typeof err === "string"
        ? { message: err, code: code ?? "VIZ_FAILED", userMessage: err, canRetry: true }
        : { message: String((err as { message?: unknown })?.message ?? err), code: (err as { code?: string })?.code ?? code ?? "VIZ_FAILED", userMessage: String((err as { userMessage?: unknown })?.userMessage ?? err), canRetry: (err as { canRetry?: boolean })?.canRetry ?? true };
      // 直接入队不抛(即使 cancelled — 让 runTurn catch 正常走完, 终态由 createVizJob 判定)
      persist("error", shape);
      if (live && !live.closed) live.send("error", shape);
    },
    /** 等事件队列 flush(终态补插前调用, 保证 seq 顺序与不丢) */
    flush(): Promise<unknown> { return insertChain; },
    end() {
      if (done) return;
      done = true;
      if (live && !live.closed) live.end();
    },
    get closed() { return done || cancelled || (live?.closed ?? false); },
    markCancelled() { cancelled = true; },
    isCancelled() { return cancelled; },
  };
  return out;
}

const running = new Map<string, { cancel: () => void; isCancelled: () => boolean }>();

// ── 执行租约(集群级) ──
// 只靠 updated_at 判卡死会在多副本下误杀: B 启动时把 A 正在跑的长绘图任务判 failed,
//   而 A 跑完仍把状态写回 done。持有者必须是"本次执行", 不能是实例。
import { randomUUID as _uuid } from "node:crypto";
const VIZ_INSTANCE = `viz:${_uuid().slice(0, 8)}:${process.pid}`;
let vizExecSeq = 0;
const vizExecutionId = () => `${VIZ_INSTANCE}#${++vizExecSeq}`;
const vizLeaseTtl = () => Math.max(30, parseInt(process.env.VIZ_LEASE_TTL || "120", 10));
const vizHeartbeatMs = () => Math.max(20, parseInt(process.env.VIZ_HEARTBEAT_MS || "30000", 10));

async function claimVizLease(jobId: string, holder: string): Promise<number | null> {
  try {
    const r = await pool.query(
      `update viz_jobs set
         exec_lease_holder = case
           when exec_lease_holder = $2 and exec_lease_until > now() then exec_lease_holder
           when exec_lease_holder is null or exec_lease_until <= now() then $2
           else exec_lease_holder end,
         exec_lease_token = case
           when exec_lease_holder = $2 and exec_lease_until > now() then exec_lease_token
           when exec_lease_holder is null or exec_lease_until <= now() then coalesce(exec_lease_token, 0) + 1
           else exec_lease_token end,
         exec_lease_until = case
           when exec_lease_holder = $2 and exec_lease_until > now() then now() + ($3::int || ' seconds')::interval
           when exec_lease_holder is null or exec_lease_until <= now() then now() + ($3::int || ' seconds')::interval
           else exec_lease_until end
       where id = $1::uuid
       returning exec_lease_holder, exec_lease_token`,
      [jobId, holder, vizLeaseTtl()]
    );
    const row = r.rows[0] as { exec_lease_holder?: string; exec_lease_token?: number } | undefined;
    if (!row || row.exec_lease_holder !== holder) return null;
    return Number(row.exec_lease_token);
  } catch { return null; }   // DB 不可用 → 保守不跑
}

async function renewVizLease(jobId: string, holder: string, token: number): Promise<boolean> {
  try {
    const r = await pool.query(
      `update viz_jobs set exec_lease_until = now() + ($4::int || ' seconds')::interval
        where id = $1::uuid and exec_lease_holder = $2 and exec_lease_token = $3`,
      [jobId, holder, token, vizLeaseTtl()]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    console.error("[viz-lease] 心跳失败:", String((e as Error)?.message ?? e).slice(0, 140));
    return false;
  }
}

async function releaseVizLease(jobId: string, holder: string, token: number): Promise<void> {
  try {
    await pool.query(
      `update viz_jobs set exec_lease_holder = null, exec_lease_token = null, exec_lease_until = null
        where id = $1::uuid and exec_lease_holder = $2 and exec_lease_token = $3`,
      [jobId, holder, token]
    );
  } catch { /* TTL 兜底 */ }
}

/** 创建绘图任务并后台执行(不等待完成, 调用方轮询/SSE 观察) */
export async function createVizJob(userId: string, sessionId: string, prompt: string, opts: VizJobOpts = {}): Promise<{ job_id: string }> {
  const sess = await pool.query(`select id from viz_sessions where id=$1 and user_id=$2`, [sessionId, userId]);
  if (!sess.rows.length) throw Object.assign(new Error("会话不存在"), { code: "NOT_FOUND", status: 404 });
  // 取数在入队前完成: 失败即失败, 不让任务在后台变成"无数据示意图"
  const resolved = await resolveOpts(userId, opts);
  const id = randomUUID();
  await pool.query(
    `insert into viz_jobs (id, session_id, user_id, prompt, csv, column_order, spec, file_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, sessionId, userId, prompt, resolved.csv ?? null, resolved.columnOrder ?? [], JSON.stringify(resolved.spec ?? {}), resolved.fileId ?? null]
  );
  // 后台执行(不 await; fire-and-forget, 生命周期独立于连接)
  void (async () => {
    const rec = recordingSse(id);
    // 抢不到执行租约 → 已有执行者(重复提交/多副本), 直接退出不双跑
    const holder = vizExecutionId();
    const leaseToken = await claimVizLease(id, holder);
    if (leaseToken === null) {
      console.error("[viz-job] 未取得执行租约, 跳过重复执行", id);
      return;
    }
    running.set(id, { cancel: () => rec.markCancelled(), isCancelled: () => rec.isCancelled() });
    const beat = setInterval(() => {
      void renewVizLease(id, holder, leaseToken).then((ok) => {
        if (!ok) console.error("[viz-lease] 租约已丢失(任务可能被其他实例接管)", id);
      });
    }, vizHeartbeatMs());
    try {
      await setStatus(id, "running", { currentStep: "started" });
      await runTurn(userId, sessionId, prompt, rec, resolved);
      // 审查 S1: 成功路径若期间被 cancel(最后事件后、状态前置前), 置 cancelled 不覆盖成 done
      if (rec.isCancelled()) {
        await setStatus(id, "cancelled", { currentStep: "cancelled", error: { userMessage: "任务已取消", canRetry: true } });
        // 补终态事件前 flush 事件队列(审查 S6: 保证 seq 顺序不冲突)
        await rec.flush();
        await pool.query(
          `insert into viz_job_events (job_id, seq, event, payload)
           select $1, coalesce(max(seq),0)+1, 'cancelled', '{"userMessage":"任务已取消"}'::jsonb from viz_job_events where job_id=$1`,
          [id]
        ).catch(() => {});
      } else {
        await setStatus(id, "done", { currentStep: "completed" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cancelled = e instanceof JobCancelledError || msg === "job cancelled";
      await rec.flush();
      await setStatus(id, cancelled ? "cancelled" : "failed", {
        currentStep: cancelled ? "cancelled" : "error",
        error: { userMessage: cancelled ? "任务已取消" : msg.slice(0, 300), canRetry: !cancelled },
      });
      // 补终态事件(错误路径事件流完整性 — 审查 S2/S5)
      await pool.query(
        `insert into viz_job_events (job_id, seq, event, payload)
         select $1, coalesce(max(seq),0)+1, ${cancelled ? "'cancelled'" : "'failed'"}, ${cancelled ? "'{\"userMessage\":\"任务已取消\"}'::jsonb" : "$2"} from viz_job_events where job_id=$1`,
        cancelled ? [id] : [id, JSON.stringify({ userMessage: msg.slice(0, 300) })]
      ).catch(() => {});
    } finally {
      // 审查 M3: 任务真正结束时才删(取消后仍跑完 LLM 期间保留, 允许幂等重复取消)
      clearInterval(beat);
      await releaseVizLease(id, holder, leaseToken);
      running.delete(id);
    }
  })().catch((e) => {
    // 兜底: try/catch 之外的 await 抛错(DB 抖动等)会变成 unhandledRejection,
    //   running 记录永不删除、状态永久停在 running, 观察流(getVizJob 见 running 就无限轮询)会挂死
    console.error("[viz-job] 后台任务异常退出", id, String(e).slice(0, 200));
    running.delete(id);
    void setStatus(id, "failed", { currentStep: "error", error: { userMessage: String(e).slice(0, 200), canRetry: true } });
  });
  return { job_id: id };
}

export async function getVizJob(userId: string, jobId: string) {
  const r = await pool.query(`select * from viz_jobs where id=$1 and user_id=$2`, [jobId, userId]);
  const job = r.rows[0];
  if (!job) return null;
  // 聚合: 该会话的最新产物 → job.result.charts(闭源 getJob result.charts 语义)
  try {
    const arts = await pool.query(
      `select python_code, png_path, svg_editable_path, critique, spec, prompt, version, created_at
         from viz_artifacts where session_id=$1 and user_id=$2
        order by version desc limit 20`,
      [job.session_id, userId]
    );
    const charts = arts.rows.map((a: Record<string, unknown>) => {
      const spec = (a.spec ?? {}) as Record<string, unknown>;
      const caption = String(spec.caption || spec.chartIntent || a.prompt || "");
      const chartType = String(spec.chartType ?? "");
      return {
        png: a.png_path ? `/api/viz/files/${String(a.png_path)}` : null,
        // svg 可编辑版: 画布恢复(任务视图点开历史任务)后 SVG 下载按钮要用
        svg: a.svg_editable_path ? `/api/viz/files/${String(a.svg_editable_path)}` : null,
        code: a.python_code,
        caption,
        analysisText: String(spec.analysis ?? ""),
        chartType,
        chartVersionId: String(a.version),
        figureId: `figure:${a.version}`,
        // sampleData: 该图是否用了真实数据(前端画"示意"徽标, 不让人误当真实结果)
        sampleData: spec.sampleData === true,
        dataFile: String(spec.dataFile ?? ""),
        metadata: { chartType, figureId: `figure:${a.version}`, sampleData: spec.sampleData === true },
      };
    });
    const content = charts.length ? `已生成 ${charts.length} 张图(最后版本 v${arts.rows[0]?.version ?? 1})` : "";
    return { ...job, result: { charts, content } };
  } catch {
    return job;
  }
}

/** 单行 CSV 解析(引号包裹/双引号转义) — rowsToCsv 写出的格式必须能读回 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 任务的数据集(画布「数据」页签用)。
 * 由来(2026-09-11): 恢复历史任务时图卡的 dataSnapshot 是空的 → 数据页签恒显示"暂无绑定数据",
 *   用户看不到"这张图到底用了什么数据"。改为一律回查任务自身的 csv(服务端已按 file_id 解析并落库)。
 */
export async function getVizJobDataset(userId: string, jobId: string, limit = 200): Promise<{
  columnOrder: string[]; rows: string[][]; totalRows: number; fileName: string; sampleData: boolean;
} | null> {
  const r = await pool.query(
    `select j.csv, j.column_order, j.file_id,
            (select filename from user_files u where ${FILE_ID_MATCH}) as file_name
       from viz_jobs j where j.id=$1 and j.user_id=$2`,
    [jobId, userId]
  );
  const job = r.rows[0];
  if (!job) return null;
  const fileName = String(job.file_name ?? "");
  const csv = String(job.csv ?? "");
  if (!csv.trim()) {
    // 无数据任务: 明确是"示意图", 而不是空数据
    return { columnOrder: [], rows: [], totalRows: 0, fileName, sampleData: true };
  }
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const columnOrder = (job.column_order as string[] | null)?.length
    ? (job.column_order as string[])
    : (lines.length ? parseCsvLine(lines[0]) : []);
  const dataLines = lines.slice(1);
  return {
    columnOrder,
    rows: dataLines.slice(0, limit).map(parseCsvLine),
    totalRows: dataLines.length,
    fileName,
    sampleData: false,
  };
}

/** 任务列表(闭源 viz-jobs?limit=N 语义): 最近 N 个 + 图数/错误摘要 */
export async function listVizJobs(userId: string, limit = 20): Promise<unknown[]> {
  const r = await pool.query(
    `select j.id, j.session_id, j.prompt, j.status, j.error, j.created_at, j.updated_at, j.file_id,
            (select filename from user_files u where ${FILE_ID_MATCH}) as file_name,
            (select count(*) from viz_job_events e where e.job_id=j.id and e.event='chart') as chart_count
       from viz_jobs j where j.user_id=$1
       order by j.created_at desc limit $2`,
    [userId, limit]
  );
  return r.rows;
}

/** 取消(幂等 — 审查 M3): DB 置 cancelled(仅非终态), 通知 running 标记; 不删 map(finally 删) */
export async function cancelVizJob(userId: string, jobId: string): Promise<boolean> {
  const r = await pool.query(`update viz_jobs set status='cancelled', updated_at=now() where id=$1 and user_id=$2 and status in ('queued','running') returning id`, [jobId, userId]);
  const entry = running.get(jobId);
  if (entry) entry.cancel();
  return r.rows.length > 0 || !!entry;
}

export async function retryVizJob(userId: string, jobId: string): Promise<{ job_id: string } | null> {
  const r = await pool.query(`select * from viz_jobs where id=$1 and user_id=$2`, [jobId, userId]);
  const job = r.rows[0];
  if (!job || (job.status !== "failed" && job.status !== "cancelled")) return null;
  const opts: VizJobOpts = {
    csv: job.csv ?? undefined,
    columnOrder: job.column_order ?? [],
    spec: job.spec ?? {},
    fileId: job.file_id ?? undefined,
  };
  return createVizJob(userId, job.session_id, job.prompt, opts);
}

/**
 * 卡死任务自愈: 进程重启后, 上一轮遗留的 running/queued 永远不会推进
 * (running Map 是内存态, 没有它就没有执行者) → 置 failed 并说明可重试。
 * 否则 getVizJob 一直回报 running, streamVizJob 的 `while (!sse.closed)` 会永久挂住观察流。
 */
export async function reapStaleVizJobs(): Promise<number> {
  try {
    const r = await pool.query(
      `update viz_jobs set status='failed', current_step='error', updated_at=now(),
              error = coalesce(error, '{"userMessage":"服务重启导致任务中断, 可点击重试","canRetry":true}'::jsonb)
        where status in ('queued','running')
          and updated_at < now() - interval '2 minutes'
          -- 有未过期租约说明有人在跑(多副本下的另一实例), 不能判死
          and (exec_lease_until is null or exec_lease_until < now())
        returning id`);
    if (r.rows.length) console.error(`[viz-job] 自愈 ${r.rows.length} 个中断任务(服务重启遗留)`);
    return r.rows.length;
  } catch (e) {
    console.error("[viz-job] 卡死任务自愈失败", String(e).slice(0, 120));
    return 0;
  }
}

/** 终态事件是否已在事件流中(防补发双发 — 审查 S4) */
async function hasTerminalEvent(jobId: string, event: string): Promise<boolean> {
  const r = await pool.query(`select 1 from viz_job_events where job_id=$1 and event=$2 limit 1`, [jobId, event]);
  return (r.rowCount ?? 0) > 0;
}

/** SSE 观察: 先重放 after 之后的事件(含断线期间落库的), 再挂起实时等新事件(无限, 靠连接关闭退出) */
export async function streamVizJob(userId: string, jobId: string, sse: AttachedSse, after = 0): Promise<void> {
  const job = await getVizJob(userId, jobId);
  if (!job) { sse.error({ code: "NOT_FOUND", userMessage: "任务不存在", canRetry: false }); sse.end(); return; }
  // replay 直接推进外部 after 游标(防挂起循环重复发送已发事件)
  const replay = async (): Promise<void> => {
    // 审查 M4: 分批拉全(不截断 50)
    for (;;) {
      const ev = await pool.query(
        `select seq, event, payload from viz_job_events where job_id=$1 and seq>$2 order by seq asc limit 200`,
        [jobId, after]
      );
      for (const row of ev.rows) {
        if (sse.closed) return;
        after = Number(row.seq);
        sse.send(row.event, row.payload);
      }
      if (ev.rows.length < 200) return;
    }
  };
  // 终态统一: 先重放全事件, 再依据 DB 终态补发单个终态标记(事件流里没有同名终态才补 — S4)
  const finish = async (event: string, payload: Record<string, unknown>) => {
    await replay();
    if (sse.closed) return;
    const already = await hasTerminalEvent(jobId, event);
    if (!already) sse.send(event, payload);
    sse.end();
  };
  // 审查 S5: failed/cancelled/done 均先重放再终态
  if (job.status === "failed") {
    await finish("viz_failed", { userMessage: (job.error as { userMessage?: string })?.userMessage ?? "任务失败", canRetry: true });
    return;
  }
  if (job.status === "cancelled") {
    await finish("cancelled", { userMessage: "任务已取消" });
    return;
  }
  if (job.status === "done") {
    await finish("viz.completed", { replayDone: true });
    return;
  }
  // running/queued: 重放已发生 → 挂起轮询(审查 S3: 无限等待, 不 120s 断 — LLM 单次可达 240s)
  await replay();
  while (!sse.closed) {
    await new Promise((r) => setTimeout(r, 500));
    const st = await pool.query(`select status from viz_jobs where id=$1`, [jobId]);
    const status = st.rows[0]?.status;
    // 审查 M5: 行被删 → 直接终断
    if (!status) { sse.error({ code: "JOB_GONE", userMessage: "任务不存在", canRetry: false }); sse.end(); return; }
    // 增量拉事件(after 已被 replay 推进, 不会重复)
    const ev = await pool.query(
      `select seq, event, payload from viz_job_events where job_id=$1 and seq>$2 order by seq asc limit 200`,
      [jobId, after]
    );
    for (const row of ev.rows) {
      if (sse.closed) return;
      after = Number(row.seq);
      sse.send(row.event, row.payload);
    }
    if (status === "done") {
      const already = await hasTerminalEvent(jobId, "viz.completed");
      if (!already) sse.send("viz.completed", { replayDone: false });
      sse.end(); return;
    }
    if (status === "failed") {
      await finish("viz_failed", { userMessage: "任务失败", canRetry: true });
      return;
    }
    if (status === "cancelled") {
      const already = await hasTerminalEvent(jobId, "cancelled");
      if (!already) sse.send("cancelled", { userMessage: "任务已取消" });
      sse.end(); return;
    }
    // 事件还没拉完就继续等(ev.rows<200 但可能还有 — 循环自然处理)
  }
  sse.end();
}
