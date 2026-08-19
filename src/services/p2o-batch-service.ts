// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// p2o-batch-service.ts — V395-13/14: P2O 批量导入（移植自研 skill pipeline.py 完整能力）
// 目录扫描(.pdf/.PDF去重) → 批量创建 P2O 任务 → 队列并发执行
// V395-14: 任务落库 agent_p2o_batch_jobs（重启恢复）+ 参数透传（retryFailed/maxFiles）
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pool } from "../db/pool.js";
import { createP2oTask, getP2oTask } from "./p2o-service.js";

export interface BatchPaper {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  contentHash: string;
}

export interface BatchJob {
  id: string;
  inputDir: string;
  outputDir: string;
  status: "running" | "completed" | "failed" | "cancelled";
  total: number;
  done: number;
  succeeded: number;
  failed: number;
  skipped: number;
  duplicate: number;
  currentFile?: string;
  taskIds: string[];
  maxDailyPages: number;
  log: string[];
  startedAt: number;
  finishedAt?: number;
  /** V395-14: 参数 */
  maxFiles?: number;
  retryFailed: boolean;
}

/** 内存 job 缓存（DB 为主, 重启后从 DB 恢复） */
const jobs = new Map<string, BatchJob>();

// ═══ DB 持久化 ═══
async function persistJob(job: BatchJob): Promise<void> {
  try {
    await pool.query(
      `insert into agent_p2o_batch_jobs
         (id, input_dir, output_dir, status, total, done, succeeded, failed, skipped, duplicate,
          current_file, task_ids, max_daily_pages, log, started_at, finished_at, max_files, retry_failed)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15,$16,$17,$18)
       on conflict (id) do update set
         status = excluded.status, done = excluded.done, succeeded = excluded.succeeded,
         failed = excluded.failed, skipped = excluded.skipped, duplicate = excluded.duplicate,
         current_file = excluded.current_file, task_ids = excluded.task_ids,
         log = excluded.log, finished_at = excluded.finished_at,
         max_files = excluded.max_files, retry_failed = excluded.retry_failed`,
      [
        job.id, job.inputDir, job.outputDir, job.status, job.total, job.done,
        job.succeeded, job.failed, job.skipped, job.duplicate,
        job.currentFile ?? null, JSON.stringify(job.taskIds), job.maxDailyPages,
        JSON.stringify(job.log.slice(-100)), new Date(job.startedAt),
        job.finishedAt ? new Date(job.finishedAt) : null,
        job.maxFiles ?? null, job.retryFailed,
      ]
    );
  } catch { /* 持久化失败不影响内存执行 */ }
}

function mapRow(row: any): BatchJob {
  return {
    id: row.id,
    inputDir: row.input_dir,
    outputDir: row.output_dir || row.input_dir,
    status: row.status,
    total: Number(row.total || 0),
    done: Number(row.done || 0),
    succeeded: Number(row.succeeded || 0),
    failed: Number(row.failed || 0),
    skipped: Number(row.skipped || 0),
    duplicate: Number(row.duplicate || 0),
    currentFile: row.current_file || undefined,
    taskIds: Array.isArray(row.task_ids) ? row.task_ids : [],
    maxDailyPages: Number(row.max_daily_pages || 900),
    log: Array.isArray(row.log) ? row.log : [],
    startedAt: new Date(row.started_at).getTime(),
    finishedAt: row.finished_at ? new Date(row.finished_at).getTime() : undefined,
    maxFiles: row.max_files != null ? Number(row.max_files) : undefined,  // V395-15
    retryFailed: row.retry_failed === true,                                // V395-15
  };
}

/** 从 DB 恢复批量任务（重启后前端可查 + running job 自动续跑） */
export async function restoreBatchJobs(): Promise<void> {
  try {
    const r = await pool.query("select * from agent_p2o_batch_jobs order by started_at desc limit 20");
    for (const row of r.rows) {
      const job = mapRow(row);
      jobs.set(job.id, job);
      // V395-15: running 状态的 job → 自动续跑（重新扫描目录, 去重逻辑跳过已处理文件）
      if (job.status === "running") {
        job.log.push("[恢复] 服务重启, 自动续跑剩余文件");
        void persistJob(job);
        void resumeBatchJob(job);
      }
    }
    console.log(`[p2o-batch] 恢复 ${r.rows.length} 个批量任务历史（${r.rows.filter((x: any) => x.status === "running").length} 个续跑）`);
  } catch { /* 表不存在/失败忽略 */ }
}

/** V395-15: 续跑运行中的 job — 重新扫描目录, 跳过已完成文件继续 */
async function resumeBatchJob(job: BatchJob): Promise<void> {
  try {
    const papers = await scanPdfDir(job.inputDir);
    if (papers.length === 0) {
      job.status = "failed";
      job.log.push("[恢复] 输入目录无 PDF, 标记失败");
      await persistJob(job);
      return;
    }
    // 已完成文件集合（task_ids 中已完成的任务对应文件）
    const doneFiles = new Set<string>();
    for (const tid of job.taskIds) {
      const t = await getP2oTask(tid).catch(() => null);
      if (t && t.status === "completed") doneFiles.add(t.fileName);
    }
    // 只保留未完成文件
    const remaining = papers.filter((p) => !doneFiles.has(p.fileName));
    if (remaining.length === 0) {
      job.status = "completed";
      job.finishedAt = Date.now();
      job.log.push("[恢复] 所有文件已处理完成");
      await persistJob(job);
      return;
    }
    job.log.push(`[恢复] 剩余 ${remaining.length} 篇待处理`);
    await persistJob(job);
    await runBatch(job, remaining, { concurrency: 2, resume: true });
  } catch (e: any) {
    job.status = "failed";
    job.log.push(`[恢复] 续跑失败: ${String(e?.message || e).slice(0, 100)}`);
    await persistJob(job);
  }
}

// ═══ 扫描 ═══
/** 扫描目录下 PDF（大小写去重 — 移植 skill scan_pdfs） */
export async function scanPdfDir(inputDir: string): Promise<BatchPaper[]> {
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  const seen = new Set<string>();
  const papers: BatchPaper[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (!lower.endsWith(".pdf")) continue;
    const filePath = path.join(inputDir, e.name);
    const key = filePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const st = await fs.stat(filePath);
    const contentHash = createHash("sha256").update(await fs.readFile(filePath)).digest("hex").slice(0, 16);
    papers.push({ filePath, fileName: e.name, sizeBytes: st.size, contentHash });
  }
  return papers;
}

/** 判重: 同路径已完成 → 跳过 */
async function isDuplicateContent(_contentHash: string, filePath: string, _sizeBytes: number): Promise<boolean> {
  const r = await pool.query(
    `select 1 from agent_p2o_tasks where pdf_path = $1 and status = 'completed' limit 1`,
    [filePath]
  );
  return (r.rowCount ?? 0) > 0;
}

/** 每日配额（按今日批量任务数近似） */
async function dailyTasksUsed(): Promise<number> {
  const r = await pool.query(
    `select count(*)::int as n from agent_p2o_tasks where source = 'batch' and created_at::date = current_date`,
    []
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** 创建批量任务 */
export async function createBatchJob(input: {
  inputDir: string;
  outputDir?: string;
  maxDailyPages?: number;
  concurrency?: number;
  maxFiles?: number;
  retryFailed?: boolean;
}): Promise<BatchJob> {
  let stat;
  try { stat = await fs.stat(input.inputDir); } catch { throw new Error(`输入目录不存在: ${input.inputDir}`); }
  if (!stat.isDirectory()) throw new Error(`输入路径不是目录: ${input.inputDir}`);
  const papers = await scanPdfDir(input.inputDir);
  if (papers.length === 0) throw new Error(`输入目录下没有 PDF 文件: ${input.inputDir}`);

  const outputDir = input.outputDir || input.inputDir;
  const job: BatchJob = {
    id: createHash("md5").update(input.inputDir + Date.now().toString()).digest("hex").slice(0, 8),
    inputDir: input.inputDir,
    outputDir,
    status: "running",
    total: papers.length,
    done: 0, succeeded: 0, failed: 0, skipped: 0, duplicate: 0,
    taskIds: [],
    maxDailyPages: input.maxDailyPages ?? 900,
    maxFiles: input.maxFiles,
    retryFailed: input.retryFailed ?? false,
    log: [`扫描到 ${papers.length} 篇 PDF（${input.inputDir}）`],
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  void persistJob(job);

  const concurrency = input.concurrency ?? 2;
  void runBatch(job, papers, { concurrency });
  return job;
}
async function runBatch(
  job: BatchJob,
  papers: BatchPaper[],
  opts: { concurrency: number; resume?: boolean }
): Promise<void> {
  // V395-14: maxFiles 截断（移植 skill --max-files）; V395-15: 续跑不重复截断
  let list = papers;
  if (!opts.resume && job.maxFiles && job.maxFiles > 0 && job.maxFiles < list.length) {
    list = list.slice(0, job.maxFiles);
    job.total = list.length;
    job.log.push(`限制处理前 ${job.maxFiles} 篇`);
  }
  const tasksToday = await dailyTasksUsed();
  let idx = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency, list.length) }, async () => {
    while (job.status === "running") {
      const i = idx++;
      if (i >= list.length) return;
      const paper = list[i];
      job.currentFile = paper.fileName;
      void persistJob(job);
      // 去重
      if (await isDuplicateContent(paper.contentHash, paper.filePath, paper.sizeBytes)) {
        job.duplicate++; job.skipped++;
        job.log.push(`[去重] ${paper.fileName} 内容已处理过`);
        job.done++; void persistJob(job);
        continue;
      }
      // 每日配额
      if (job.maxDailyPages > 0 && tasksToday + job.succeeded >= job.maxDailyPages) {
        job.skipped++;
        job.log.push(`[配额] ${paper.fileName} 超过每日 ${job.maxDailyPages} 篇配额, 跳过`);
        job.done++; void persistJob(job);
        continue;
      }
      try {
        const task = await createP2oTask({ fileName: paper.fileName, pdfPath: paper.filePath, source: "batch" });
        job.taskIds.push(task.id);
        void persistJob(job);
        let finalStatus = "queued";
        for (let w = 0; w < 900; w++) {
          await new Promise((r) => setTimeout(r, 2000));
          const t = await getP2oTask(task.id);
          if (!t) break;
          finalStatus = t.status;
          if (t.status === "completed") { job.succeeded++; break; }
          if (t.status === "failed") { job.failed++; break; }
          if (t.status === "queued" || t.status === "running") continue;
        }
        job.log.push(`[${job.succeeded + job.failed}/${job.total}] ${paper.fileName} → ${finalStatus}`);
      } catch (e: any) {
        job.failed++;
        job.log.push(`[失败] ${paper.fileName}: ${String(e?.message || e).slice(0, 100)}`);
      } finally {
        job.done++;
        void persistJob(job);
      }
    }
  });
  await Promise.all(workers);
  job.status = "completed";
  job.finishedAt = Date.now();
  job.currentFile = undefined;
  job.log.push(`===== 完成 ===== 总 ${job.total} | 成功 ${job.succeeded} | 失败 ${job.failed} | 跳过 ${job.skipped} | 去重 ${job.duplicate}`);
  await persistJob(job);
}

/** 批量任务状态 */
export function getBatchJob(id: string): BatchJob | null {
  return jobs.get(id) || null;
}

/** 取消 */
export function cancelBatchJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== "running") return false;
  job.status = "cancelled";
  job.log.push("[取消] 用户取消批量导入");
  void persistJob(job);
  return true;
}

/** 列表（内存 + DB 恢复） */
export function listBatchJobs(): BatchJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
}

export const p2oBatchService = {
  createBatchJob,
  getBatchJob,
  cancelBatchJob,
  listBatchJobs,
  scanPdfDir,
  restoreBatchJobs,
};
