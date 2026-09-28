// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ocr-job-service.ts — V418: 文档 OCR 任务(上传扫描版 PDF → 后台识别 → 文本落成素材)
//
// 由来(2026-09-28 用户要求): 写作舱的素材上传对扫描版 PDF 是死路 ——
//   `doc-text-extract.ts:59` 抽不到文本层就返回失败, 用户看到"该 PDF 未提取到文字(可能是
//   扫描件)", 然后就**没有下一步了**。而平台其实早就有 OCR 能力(MinerU), 只是只挂在
//   Agent 工具上, 素材上传链路碰不到。
//
// ## 为什么必须是异步任务, 不能顺手在请求里做完
//
// `mineru-go-adapter.convertViaMineruGo` 是 **execFileSync**(阻塞进程), 默认超时 600 秒。
// 放进 HTTP handler 里 = 前端一个请求挂十分钟 + 期间那个 worker 线程完全卡死。
// 所以: 建 job 立刻返回 → 后台跑 → 前端轮询。这套形状项目里已有两处先例
// (statistics-job-service / editor-ai-job-service), 这里取**内存 Map + DB 兜底**那一档:
//   · 内存 Map —— 轮询走内存, 快;
//   · `ocr_jobs` 表 —— 服务重启后进度还在, 否则"进行中的任务"在内存里查不到,
//     前端会永远停在"识别中"(statistics-job-service 的注释记的就是这个坑)。
//
// ## 与素材上传的衔接
//
// 任务**只负责识别, 不替用户落素材**。完成后前端拿到 `text`, 用素材卡片上已有的
// 「补录文本」入口像粘贴文本一样入库 —— 那条路径用户看得见、可编辑、可撤销。
// 反过来(任务直接写素材)会让 OCR 错字在用户毫不知情的情况下进正文。
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../db/pool.js";
import { dataPath } from "./storage-paths.js";
import { extractPdfText, OCR_MIN_PAGES } from "./doc-text-extract.js";

export type OcrJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface OcrJob {
  id: string;
  userId: string;
  status: OcrJobStatus;
  /** 源文件名(给界面显示) */
  fileName: string;
  /** 源文件落地路径(OCR 需要**真实文件**, 不是 buffer) */
  filePath: string;
  /** 一行人类可读进度 —— 对齐 viz_jobs.current_step, 前端原样显示 */
  currentStep: string;
  /**
   * 发起这次识别的 user_files.id(裸 uuid); 空 = 不是在上传件上发起的。
   * 完成后正文会写回该文件的 text 列 —— 评审页那条「去识别文字」才有回程。
   */
  sourceFileId?: string;
  /** 识别出的 Markdown 正文。完成后才有 */
  text: string;
  charCount: number;
  error?: string;
  cancelled: boolean;
  createdAt: number;
}

const jobs = new Map<string, OcrJob>();
/** 内存里保留多久。**不是任务超时** —— 是"轮询窗口"。超时的任务照样能重试 */
const TTL_MS = 2 * 60 * 60_000;
/** 超过这个时长还是 queued/running 的, 判为卡死(进程崩了没人改状态) */
const STALE_MS = 15 * 60_000;
/** 同时进行的 OCR 任务上限 —— 每个任务占一个 Python 子进程 + 对方账号的并发额度 */
const MAX_ACTIVE_PER_USER = 2;

/** 清理内存里的老任务(DB 里那份不动 —— 它是重试与回看的依据) */
function sweep(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.createdAt > TTL_MS && j.status !== "running" && j.status !== "queued") jobs.delete(id);
  }
}
setInterval(sweep, 10 * 60_000).unref?.();

/**
 * 把 token 从任意文本里抹掉。
 *
 * ⚠ 为什么必须做: 密钥是通过 `--token` **命令行参数**传给 Python 的, 而子进程失败时
 *   adapter 会把 `e.stdout` 整段塞进 error —— 那一整段可能含 `--token sk-xxxx`。
 *   这个 error 会进 job、进 API 响应、进告警、进日志。不抹的话, 一次失败就等于把密钥
 *   抄送到四个地方。
 */
export function redactToken(msg: string, token?: string): string {
  let s = msg;
  if (token && token.length > 8) s = s.split(token).join("sk-***");
  return s
    .replace(/(--token\s+)\S+/gi, "$1sk-***")
    .replace(/Bearer\s+sk-[A-Za-z0-9_-]+/gi, "Bearer sk-***")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-***");
}

/** 远端错误 → 用户能看懂的一句话。照抄 statistics-job-service.translateError 的结构 */
export function translateOcrError(raw: string): { userMessage: string; canRetry: boolean } {
  const s = raw || "";
  if (/not configured|未配置/i.test(s)) return { userMessage: "平台没有配置 OCR 密钥，无法识别扫描件。到「设置 → 外部服务密钥」填一个 MinerU 密钥即可。", canRetry: false };
  if (/\b401\b|expired|authenticate failed|AccessDenied/i.test(s)) return { userMessage: "OCR 密钥已过期或被拒绝。到「设置 → 外部服务密钥」换一枚新的。", canRetry: false };
  if (/timeout|timed out|超时/i.test(s)) return { userMessage: "识别超时（页数多或对方排队）。文件本身没问题，可以重试。", canRetry: true };
  if (/脚本缺失|not found|ENOENT/i.test(s)) return { userMessage: "服务端缺少 OCR 运行环境（Python 或脚本），请让部署方检查。", canRetry: false };
  if (/password|加密|corrupt|损坏/i.test(s)) return { userMessage: "这份 PDF 打不开（可能加密或损坏），OCR 也读不了。", canRetry: false };
  // 兜底也截断: 原始信息可能很长, 但前 200 字足够定位
  return { userMessage: `识别失败：${s.slice(0, 200) || "未知原因"}`, canRetry: true };
}

export function countActiveOcrJobs(userId: string): number {
  let n = 0;
  for (const j of jobs.values()) if (j.userId === userId && (j.status === "queued" || j.status === "running")) n++;
  return n;
}

/**
 * 建任务。**立刻返回**, 真正的识别在 `void run(job)` 里跑。
 *
 * @param buf 源文件字节。写盘是必须的 —— MinerU 那条链只吃真实文件路径
 */
export function createOcrJob(input: { userId: string; fileName: string; buf: Buffer; sourceFileId?: string }): { ok: true; job: OcrJob } | { ok: false; error: string } {
  if (countActiveOcrJobs(input.userId) >= MAX_ACTIVE_PER_USER) {
    return { ok: false, error: `同时最多跑 ${MAX_ACTIVE_PER_USER} 个识别任务，等这一个完成再试。` };
  }
  const id = randomUUID();
  const dir = dataPath("ocr", input.userId);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `无法创建文件目录：${String((e as Error).message).slice(0, 120)}` };
  }
  // 文件名只取基名并清掉路径分隔符 —— 用户上传的名字里带 ../ 不能影响落地位置
  const safeName = input.fileName.replace(/[\\/]/g, "_").slice(0, 120) || "upload.pdf";
  const filePath = join(dir, `${id}.pdf`);
  try {
    writeFileSync(filePath, input.buf);
  } catch (e) {
    return { ok: false, error: `无法保存文件：${String((e as Error).message).slice(0, 120)}` };
  }
  const job: OcrJob = {
    id, userId: input.userId, status: "queued", fileName: safeName, filePath,
    sourceFileId: input.sourceFileId ? String(input.sourceFileId) : undefined,
    currentStep: "排队中", text: "", charCount: 0, cancelled: false, createdAt: Date.now(),
  };
  jobs.set(id, job);
  void persist(job);
  void run(job);
  return { ok: true, job };
}

/** 读任务。**带归属校验** —— 别人的任务 id 猜中了也读不到 */
export function getOcrJob(userId: string, jobId: string): OcrJob | null {
  const j = jobs.get(jobId);
  if (j && j.userId === userId) return j;
  return null;
}

/** 取消。⚠ 单靠 status 不够: 在途的识别回来时会**无条件覆盖成 done**,
 *  所以还要一个独立的 cancelled 标志让 run() 的收尾能判出来(editor-ai-job-service 同款) */
export function cancelOcrJob(userId: string, jobId: string): boolean {
  const j = getOcrJob(userId, jobId);
  if (!j || (j.status !== "queued" && j.status !== "running")) return false;
  j.cancelled = true;
  j.status = "cancelled";
  j.currentStep = "已取消";
  void persist(j);
  return true;
}

function setStep(job: OcrJob, step: string): void {
  job.currentStep = step;
}

/**
 * 真正干活。失败不抛 —— 把结论写进 job。**任何路径都要落到终态**, 否则前端永远转圈。
 */
async function run(job: OcrJob): Promise<void> {
  if (job.cancelled) return;
  job.status = "running";
  setStep(job, "准备识别");
  void persist(job);

  let rawToken = "";
  try {
    /**
     * 先自己抽一次文本层。
     *
     * ⚠ 这一步**不是多余的**: 调用方是"抽不到文字才来 OCR", 但两次抽取之间文件可能不同
     *   (用户重传/换文件), 也可能上一步只是页数超限截断了。自己再判一次, 才能对
     *   "其实有文字层"这种情况给出准确的话, 而不是白烧一次 OCR。
     *   顺带也拿到页数, 用来自查"是不是给了个空文档"。
     */
    setStep(job, "检查文件");
    let pageCount = 0;
    try {
      const probe = await extractPdfText(Buffer.from(readFileSync(job.filePath)), 1);
      pageCount = probe.pageCount;
    } catch {
      // 自己抽不了不代表 OCR 也读不了(加密/异常结构) —— 交给远端, 不在这里拦
    }
    if (job.cancelled) return;
    if (pageCount > 0 && pageCount < OCR_MIN_PAGES) {
      throw new Error(`这份 PDF 只有 ${pageCount} 页且没有文字层，OCR 出来大概率也是空的 —— 请确认传的是目标文档。`);
    }

    const { effectiveToken, serviceDef } = await import("./service-token-store.js");
    const def = serviceDef("mineru");
    rawToken = (await effectiveToken("mineru")) ?? "";
    if (!rawToken) throw new Error(def ? "OCR 密钥未配置" : "未知服务");

    setStep(job, pageCount ? `OCR 识别中（共 ${pageCount} 页，通常 1–3 分钟）` : "OCR 识别中（通常 1–3 分钟）");
    void persist(job);

    const { convertViaMineruGo } = await import("./mineru-go-adapter.js");
    const outDir = join(job.filePath, "..", `${job.id}-out`);
    const r = convertViaMineruGo(job.filePath, {
      // 强制 precision: 走 agent 轻量通道有 10MB / 20 页上限, 而扫描件正是大文件
      mode: "precision",
      ocr: true,
      outputDir: outDir,
      maxChars: 0,
      /**
       * 语言模型: `ch` 是 MinerU 给**中英混排**文档的模型。
       *
       * ⚠ 2026-09-28 实测改的。原来这里写死 `en`, 是照抄 agent-pdf-tool 的值 ——
       *   但那份文档是英文语料, 而从这里进来的是**中文论文扫描件**。
       *   实测证据: 同一份图-only PDF, `en` 模型对纯色块页会输出自述式文本
       *   ("The image contains no text..."), 那是模型在描述图片而不是在识别文字;
       *   对真正的中文版面它会直接漏字。
       *   可用环境变量 `OCR_LANGUAGE` 覆盖(其它语种语料时用)。
       */
      language: process.env.OCR_LANGUAGE || "ch",
      timeoutMs: 600_000,
    });
    if (!r.ok) throw new Error(r.error || "OCR 失败");

    setStep(job, "整理文本");
    let text = r.content ?? "";
    if (!text && r.markdownPath && existsSync(r.markdownPath)) text = readFileSync(r.markdownPath, "utf-8");

    /**
     * 清洗。**降级不算失败** —— 清洗脚本缺失时返回原文 + 一条 warning,
     * 把"没洗"当成失败会让用户白等一场。
     */
    try {
      const { cleanMarkdown } = await import("./mineru-go-adapter.js");
      const c = cleanMarkdown(text);
      if (c.ok && typeof c.text === "string") text = c.text;
    } catch { /* 清洗是加分项, 不是前提 */ }

    if (!text.trim()) throw new Error("OCR 返回了空文本 —— 这份文件可能整本都是图片或空白页。");

    if (job.cancelled) return;
    job.text = text;
    job.charCount = text.length;
    job.status = "done";
    setStep(job, `识别完成（${text.length} 字）`);

    /**
     * 写回**发起它的那份上传件**(2026-09-29)。
     *
     * 不写回的话, 评审页那条「扫描件 → 去识别文字 →」就是个绕不回来的圈: 用户识别完回去
     * 重选文件, 那是**另一次上传**产生的新 user_files 行, 正文仍在旧的那份上。
     * 失败只记日志 —— 识别本身已经成功了, 不该因为这一步把整个任务判失败。
     */
    if (job.sourceFileId) {
      try {
        const { attachOcrText } = await import("./file-text-service.js");
        await attachOcrText(job.userId, job.sourceFileId, text);
      } catch (e) {
        console.warn("[ocr] 回填上传件正文失败(识别结果仍在任务里):", String((e as Error).message).slice(0, 120));
      }
    }
  } catch (e) {
    if (job.cancelled) return;
    const { userMessage, canRetry } = translateOcrError(redactToken(String((e as Error)?.message ?? e), rawToken));
    // 不可重试的原因要在文案里说清 —— 否则用户会一直点重试, 而结果每次一样
    job.error = userMessage + (canRetry ? "" : " 直接重试结果不会变，需要先处理上面的原因。");
    job.status = "failed";
    setStep(job, "识别失败");
  } finally {
    // 取消发生在识别中途时, run 里几处 return 都没走到终态赋值 —— 在这里统一纠正
    if (job.cancelled) job.status = "cancelled";
    void persist(job);
  }
}

/** 落库(upsert)。失败只记日志 —— 内存那份仍然可用, 不该因为 DB 抖动把任务搞挂 */
async function persist(job: OcrJob): Promise<void> {
  try {
    await pool.query(
      `insert into ocr_jobs (id, user_id, status, file_name, file_path, current_step, text, char_count, error, created_at, updated_at, source_file_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, to_timestamp($10 / 1000.0), now(), $11)
       on conflict (id) do update set
         status = excluded.status, current_step = excluded.current_step,
         text = excluded.text, char_count = excluded.char_count,
         error = excluded.error, updated_at = now()`,
      [job.id, job.userId, job.status, job.fileName, job.filePath, job.currentStep, job.text, job.charCount, job.error ?? "", job.createdAt, job.sourceFileId ?? ""]
    );
  } catch (e) {
    console.warn("[ocr] 任务落库失败(内存副本仍可用):", String((e as Error).message).slice(0, 120));
  }
}

/**
 * 启动恢复 + 卡死清理。
 * ⚠ 两件事都要做: ① 把 DB 里近期的任务灌回内存, 否则重启后轮询查不到;
 *   ② 把 queued/running 且太久没动的置 failed —— 那是进程崩了留下的**假进行中**,
 *      不清理的话前端会永远停在"识别中"。
 */
export async function restoreOcrJobs(): Promise<{ restored: number; reaped: number }> {
  let restored = 0;
  let reaped = 0;
  try {
    const stale = await pool.query(
      `update ocr_jobs set status='failed',
         error = coalesce(nullif(error,''), '服务重启导致识别中断，可以重新发起。'),
         current_step = '已中断', updated_at = now()
       where status in ('queued','running') and updated_at < now() - ($1::int || ' milliseconds')::interval
       returning id`,
      [STALE_MS]
    );
    reaped = stale.rowCount ?? 0;

    const r = await pool.query(
      `select id, user_id, status, file_name, file_path, current_step, text, char_count, error, source_file_id,
              (extract(epoch from created_at) * 1000)::bigint as created_ms
       from ocr_jobs
       where created_at > now() - interval '1 day'
       order by created_at desc limit 200`
    );
    for (const row of r.rows) {
      const id = String(row.id);
      if (jobs.has(id)) continue;
      jobs.set(id, {
        id,
        userId: String(row.user_id),
        status: String(row.status) as OcrJobStatus,
        fileName: String(row.file_name ?? ""),
        filePath: String(row.file_path ?? ""),
        currentStep: String(row.current_step ?? ""),
        // 一起恢复 —— 漏了它, 重启后重试这条链就丢掉了"写回哪份文件"的回程信息
        sourceFileId: row.source_file_id ? String(row.source_file_id) : undefined,
        text: String(row.text ?? ""),
        charCount: Number(row.char_count ?? 0),
        error: row.error ? String(row.error) : undefined,
        // 从 DB 恢复的任务都当作"已结束": 没有进程在跑它们了, 状态已在上面那步纠成 failed
        cancelled: false,
        createdAt: Number(row.created_ms ?? Date.now()),
      });
      restored++;
    }
  } catch (e) {
    // 表还没建(启动早于迁移)不算故障, 下一轮启动会补上
    console.warn("[ocr] 任务恢复跳过:", String((e as Error).message).slice(0, 120));
  }
  return { restored, reaped };
}

/**
 * API 视图。
 *
 * ⚠ **不带 `filePath`** —— 服务端的磁盘布局不该出现在响应里。
 *   文本按需给: 列表轮询时要的是进度, 每次都把几十万字带上会让轮询变成带宽问题。
 */
export function publicOcrJob(job: OcrJob, withText = false): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    fileName: job.fileName,
    currentStep: job.currentStep,
    charCount: job.charCount,
    error: job.error ?? "",
    // 发起时指向的那份上传件 —— 前端据此显示"识别完会写回哪份文件"
    sourceFileId: job.sourceFileId ? `file_${job.sourceFileId}` : "",
    createdAt: new Date(job.createdAt).toISOString(),
    ...(withText ? { text: job.text } : {}),
  };
}

/** 测完就删的临时目录用不到 —— 源文件保留(用户可能要重试), 但给一个显式清理入口 */
export async function deleteOcrJob(userId: string, jobId: string): Promise<boolean> {
  const j = getOcrJob(userId, jobId);
  if (!j) return false;
  if (j.status === "running" || j.status === "queued") return false;
  jobs.delete(jobId);
  try { await pool.query("delete from ocr_jobs where id = $1 and user_id = $2", [jobId, userId]); } catch { /* 内存已删, DB 失败不回滚 */ }
  return true;
}

export const ocrJobService = {
  createOcrJob, getOcrJob, cancelOcrJob, deleteOcrJob, restoreOcrJobs, publicOcrJob,
  countActiveOcrJobs, redactToken, translateOcrError, OCR_MIN_PAGES,
};
