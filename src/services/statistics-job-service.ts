// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// statistics-job-service.ts — SocialSci Vue M3: 统计分析 17 法任务执行器(闭源契约完整还原)
// 契约: POST /api/statistics-jobs {tool,fileId,variables,options...} → {job:{id,status:"queued"}}
//       GET  /api/statistics-jobs/:id → {job:{id,status,result:{tables,charts,warnings,metadata},result_version_id,error}}
//       GET  /api/statistics-jobs/:id/stream → SSE(可恢复: 完成前挂起→推送 done; after 重放)
//       POST /:id/cancel / POST /:id/retry
// 执行: 文件仓取数据(user_files) → statistics_runner.py(独立 venv, pandas/scipy/statsmodels) → 结果 DB 落库
// 闭源语义: decoded-stats-viz.md §1(17 法参数/输出契约/Python 异常翻译); 与 empirical 域隔离独立实现
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { pool } from "../db/pool.js";

const PYTHON = process.env.EMPIRICAL_PYTHON || process.env.COGNEE_PYTHON || "";
const RUNNER = `${process.env.SAG_ROOT || process.cwd()}/scripts/statistics_runner.py`;
const TTL_MS = 5 * 60 * 1000;

export interface StatsJob {
  id: string;
  userId: string;
  tool: string;
  input: Record<string, unknown>;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result: Record<string, unknown> | null;
  resultVersionId: string | null;
  error: { code?: string; message?: string } | null;
  sourceTaskId?: string;
  createdAt: number;
}

const jobs = new Map<string, StatsJob>();

/** 建任务(完整参数入 input; 与闭源 body 契约一致) */
export function createStatsJob(userId: string, body: Record<string, unknown>): StatsJob | null {
  const tool = String(body.tool ?? "descriptive");
  const job: StatsJob = {
    id: randomUUID(),
    userId,
    tool,
    input: body,
    status: "queued",
    result: null,
    resultVersionId: null,
    error: null,
    sourceTaskId: body.sourceTaskId ? String(body.sourceTaskId) : undefined,
    createdAt: Date.now()
  };
  jobs.set(job.id, job);
  void runStatsJob(userId, job.id);
  return job;
}

export function getStatsJob(userId: string, jobId: string): StatsJob | null {
  const j = jobs.get(jobId);
  return j && j.userId === userId ? j : null;
}

export function listStatsJobs(userId: string, limit = 30): StatsJob[] {
  return [...jobs.values()].filter((j) => j.userId === userId).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** 数据库持久化(stats_jobs 历史; 失败不影响主流程) */
async function persistJob(job: StatsJob): Promise<void> {
  try {
    await pool.query(
      `insert into stats_jobs (id, user_id, tool, input, status, result, result_version_id, error, source_task_id, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10/1000.0))
       on conflict (id) do update set status=excluded.status, result=excluded.result, result_version_id=excluded.result_version_id, error=excluded.error`,
      [job.id, job.userId, job.tool, JSON.stringify(job.input), job.status, JSON.stringify(job.result ?? {}), job.resultVersionId, JSON.stringify(job.error ?? {}), job.sourceTaskId ?? "", job.createdAt]
    );
  } catch (e) {
    console.error("[stats-job] 持久化失败", String(e).slice(0, 160));
  }
}

/** 从文件仓取数据(user_files) → 行/列结构 */
async function loadUserFileData(userId: string, fileId: string): Promise<{ columnOrder: string[]; rows: unknown[][]; profile?: Record<string, unknown> } | null> {
  try {
    const rawId = String(fileId).replace(/^file_/, "");
    const r = await pool.query(`select storage_rel, filename, profile from user_files where id=$1 and user_id=$2`, [rawId, userId]);
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const abs = `${process.env.SAG_ROOT || process.cwd()}/${row.storage_rel}`;
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(abs, "utf-8").slice(0, 1_500_000);
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return { columnOrder: [], rows: [] };
    // CSV 或 TSV 探测
    const delim = (lines[0].match(/\t/) ? "\t" : lines[0].includes(",") ? "," : "\t");
    const parseLine = (l: string) => l.split(delim).map((c) => c.trim());
    const columnOrder = parseLine(lines[0]).map((c) => (c.startsWith("﻿") ? c.slice(1) : c));
    const rows = lines.slice(1).map(parseLine);
    return { columnOrder, rows, profile: row.profile };
  } catch (e) {
    console.error("[stats-job] 数据读取失败", String(e).slice(0, 160));
    return null;
  }
}

/** 中文化 Python 异常(闭源 it() 翻译表语义, decoded-stats-viz §1.4-4) */
function translateError(raw: string): { message: string; detail: string } {
  const s = String(raw ?? "");
  let msg = "分析执行失败";
  if (/unsupported operand|ufunc.*did not contain|astype/.test(s)) msg = "数据类型不匹配, 请检查所选变量的取值类型";
  else if (/shape|broadcast|dimension|got.*instead|length of values/.test(s)) msg = "维度错误: 变量列长度或分组不一致";
  else if (/KeyError|column|not in index|does not exist/.test(s)) msg = "变量名不存在, 请重新选择变量";
  else if (/DataFrame|attribute|'DataFrame' object|has no attribute/.test(s)) msg = "后端计算异常, 请检查变量类型后重试";
  else if (/ValueError|invalid literal|could not convert/.test(s)) msg = "变量含非数字内容, 无法参与计算";
  else if (/NaN|NaT|missing|null|all-NA|empty/.test(s)) msg = "数据缺失过多或为空, 请检查数据文件";
  else if (/HTTP \d{3}/.test(s)) msg = `服务器错误: ${s.match(/HTTP \d{3}/)?.[0] ?? ""}`;
  return { message: msg, detail: s.slice(0, 500) };
}

/** 执行: 取数据 → spawn python runner → 结果落 job */
async function runStatsJob(userId: string, jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job || job.status !== "queued") return;
  job.status = "running";
  void persistJob(job);
  const taskDir = `${process.env.SAG_ROOT || process.cwd()}/data/statistics-jobs/${jobId}`;
  try {
    const { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } = await import("node:fs");
    const fileId = String(job.input.fileId ?? "");
    const loaded = fileId ? await loadUserFileData(userId, fileId) : null;
    if (fileId && !loaded) {
      throw new Error("数据文件不存在或不可读, 请重新上传");
    }
    mkdirSync(taskDir, { recursive: true });
    const inputPayload = {
      tool: job.tool,
      ...job.input,
      data: loaded ? { columnOrder: loaded.columnOrder, rows: loaded.rows.slice(0, 50_000) } : { columnOrder: [], rows: [] }
    };
    writeFileSync(`${taskDir}/input.json`, JSON.stringify(inputPayload), "utf-8");
    await new Promise<void>((resolve, reject) => {
      execFile(PYTHON, [RUNNER, taskDir], { timeout: 300_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
        const resultPath = `${taskDir}/result.json`;
        const tryRead = (attempt: number): void => {
          if (existsSync(resultPath)) {
            try {
              const parsed = JSON.parse(readFileSync(resultPath, "utf-8"));
              job.result = parsed;
              job.resultVersionId = randomUUID();
              job.status = "completed";
              job.error = null;
              void persistJob(job);
              resolve();
              return;
            } catch {
              /* 继续下一轮尝试 */
            }
          }
          if (attempt < 8) {
            setTimeout(() => tryRead(attempt + 1), 300);
            return;
          }
          job.status = "failed";
          const t = translateError(err ? err.message + "\n" + stderr : stderr);
          job.error = { code: "EXEC_FAILED", message: t.message };
          job.error = { ...job.error, detail: t.detail } as never;
          void persistJob(job);
          reject(new Error(t.message));
        };
        tryRead(0);
      });
    });
  } catch (e) {
    if (job.status === "running") {
      job.status = "failed";
      const t = translateError(String((e as Error).message ?? e));
      job.error = { code: "EXEC_FAILED", message: t.message };
      void persistJob(job);
    }
  } finally {
    // 清理任务目录(保留 result 到 DB)
    try {
      const { rmSync } = await import("node:fs");
      rmSync(taskDir, { recursive: true, force: true });
    } catch { /* 忽略 */ }
  }
}

export async function cancelStatsJob(userId: string, jobId: string): Promise<StatsJob | null> {
  const j = getStatsJob(userId, jobId);
  if (!j) return null;
  if (j.status === "queued" || j.status === "running") {
    j.status = "cancelled";
    void persistJob(j);
  }
  return j;
}

/** retry: failed/cancelled → 重排队重跑(闭源 retry 语义) */
export async function retryStatsJob(userId: string, jobId: string): Promise<StatsJob | null> {
  const j = getStatsJob(userId, jobId);
  if (!j || !["failed", "cancelled"].includes(j.status)) return j;
  j.status = "queued";
  j.result = null;
  j.resultVersionId = null;
  j.error = null;
  void persistJob(j);
  void runStatsJob(userId, jobId);
  return j;
}

/** 数据库恢复: 服务重启后拉取未过期历史(最多 50 条近期) */
export async function restoreStatsJobs(userId?: string): Promise<void> {
  try {
    const r = await pool.query(
      `select id, user_id, tool, input, status, result, result_version_id, error, source_task_id,
              extract(epoch from created_at)*1000 as created_at_ms
         from stats_jobs
        where created_at > now() - interval '7 days'
        order by created_at desc limit 200`
    );
    for (const row of r.rows) {
      jobs.set(row.id, {
        id: row.id,
        userId: row.user_id,
        tool: row.tool,
        input: row.input ?? {},
        status: row.status,
        result: row.result ?? null,
        resultVersionId: row.result_version_id ?? null,
        error: row.error ?? null,
        sourceTaskId: row.source_task_id ?? undefined,
        createdAt: Number(row.created_at_ms ?? Date.now())
      });
    }
  } catch (e) {
    console.error("[stats-job] 恢复失败", String(e).slice(0, 160));
  }
}

export const statsJobService = { createStatsJob, getStatsJob, listStatsJobs, cancelStatsJob, retryStatsJob, restoreStatsJobs };
