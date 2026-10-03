// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// file-text-service.ts — 上传文件 → 纯文本(user_files 的 text 列)
//
// 由来(2026-09-29 用户: "审稿的上传 PDF 要先 file_read/pdf_parse 拿到文本再建 job ——
//   后端没有 fileId → 纯文本这个能力。全部修复"):
//   平台上有**两个**文件概念, 一直没接上:
//     · `user_files`(迁移 123): 用户上传的文件, 有 storage_rel(字节)与 profile(表格概览)。
//       数据类链路(viz 出图、统计台跑回归)一直用它, 走的是 `resolveJobData` —— 只认 CSV。
//     · `ocr_jobs`(迁移 163): 文档 → Markdown, 但它的 id 是 **OCR 任务 id**, 不是上传文件 id。
//   于是"我上传的这份 PDF, 它的正文是什么" **没有任何地方能回答** ——
//     审稿建 job 要全文, 只能先让用户把文本粘贴进去;
//     评审面板上传 .pdf 走的是 `/api/files/extract-text`, 那条路由**既不落库也不返回 fileId**
//     (临时文件 finally 里删掉), 而且扫描件直接硬失败(`doc-text-extract.ts:78`)。
//     副作用: `review_jobs.source_file_id` 落了库却**永远写不进值**。
//
// 本模块就是那个缺失的原语: fileId → 文本。按扩展名分派, 抽到的文本存回 `user_files.text`
// (迁移 164 加的两列), 因为"引用这个文件"是高频动作(审稿要全文、对话要读内容),
// 而抽一次 3MB 的 PDF 要几秒、扫描件走 OCR 是分钟级。
//
// ⚠ 三条边界(都不是随手写的):
//   ① **不做写操作**: 只读+回填自己的 text 列。上传/落库仍在各自的入口。
//   ② **OCR 是**分钟级的**, 不在请求里同步等 —— `ensureFileText` 遇到扫描件直接返回
//      `needs_ocr: true`, 调用方(审稿面板/Agent 工具)提示用户去走「识别文字」那条链。
//      同步等 600 秒会把 HTTP 连接与前端轮询一起拖死(ocr-job-service 的注释记过同一件事)。
//   ③ **文字版与识别版必须能区分**: `extraction` 列记录 text 是怎么来的 ——
//      OCR 有错字是常态, 用户有权知道手里的正文该不该复核(与迁移 163 的 extractionMethod 同口径)。
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pool } from "../db/pool.js";
import { getObject } from "./blob-store.js";
import { extractPdfText, OCR_MIN_PAGES } from "./doc-text-extract.js";
import { resolvePython } from "./py-path.js";

/** 抽取方式。空串 = 还没抽过(与 user_files.extraction 的缺省一致) */
export type FileExtraction = "" | "native" | "text-layer" | "mammoth" | "ocr" | "doc" | "failed";

export interface FileTextResult {
  ok: boolean;
  fileId: string;
  fileName: string;
  ext: string;
  text: string;
  charCount: number;
  pageCount: number | null;
  extraction: FileExtraction;
  /** 这份文件是扫描件, 得走 OCR 才有正文(调用方据此提示用户, 而不是干等) */
  needsOcr: boolean;
  error: string;
}

const MAX_TEXT = 400_000; // 与 /api/files/extract-text 的 200k 同量级; 多留一倍给整篇学位论文

/** 库里的 fileId 形如 `file_<uuid>`(server.ts 的返回), 但落库的是裸 uuid —— 两种都要认 */
export function rawFileId(fileId: string): string {
  return String(fileId ?? "").replace(/^file_/, "");
}

/**
 * 纯文本类扩展名 —— 这些不需要任何抽取器, 字节就是文本。
 * 单独拎出来是因为 `ensureFileText` 对它们可以走一条不碰磁盘的短路。
 */
const TEXTY = new Set(["txt", "md", "csv", "tsv", "json", "html", "htm", "xml", "tex", "bib", "rtf"]);

function extOf(fileName: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(fileName ?? ""));
  return m ? m[1].toLowerCase() : "";
}

/** 同步等子进程 —— docx/xlsx 的抽取走 Python, 是秒级的, 不是分钟级 */
function runPython(args: string[], timeoutMs = 120_000): Promise<string> {
  const py = resolvePython({ envKeys: ["EMPIRICAL_PYTHON", "COGNEE_PYTHON"] });
  return new Promise((resolve, reject) => {
    execFile(py, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).slice(0, 200)));
        else resolve(stdout);
      });
  });
}

/**
 * 从字节抽出文本。**不做 OCR** —— 抽不到就说"这是扫描件"。
 *
 * 返回 `needsOcr` 是这一层的核心输出: "抽不到"和"没有正文"是两回事, 前者有下一步。
 */
async function extractFromBuffer(buf: Buffer, fileName: string): Promise<{ text: string; pageCount: number | null; extraction: FileExtraction; needsOcr: boolean; error: string }> {
  const ext = extOf(fileName);

  if (TEXTY.has(ext)) {
    const text = buf.toString("utf-8");
    return { text, pageCount: null, extraction: "native", needsOcr: false, error: text.trim() ? "" : "文件是空的" };
  }

  if (ext === "pdf") {
    let text = "", pageCount = 0;
    try {
      ({ text, pageCount } = await extractPdfText(buf));
    } catch (e) {
      // 加密/损坏的 PDF: pdfjs 抛的是英文内部错误, 不该原样冒到用户面前
      const msg = String((e as Error)?.message ?? e).slice(0, 120);
      return { text: "", pageCount: null, extraction: "failed", needsOcr: false, error: `PDF 解析失败(${msg})。文件可能已损坏或加了密码。` };
    }
    if (text.trim()) return { text, pageCount, extraction: "text-layer", needsOcr: false, error: "" };
    // 抽不到文本层 —— 少页大概率是空白封面, 补 OCR 也是空的; 多页才是真的扫描件
    const needsOcr = pageCount >= OCR_MIN_PAGES;
    return {
      text: "", pageCount, extraction: "failed", needsOcr,
      error: needsOcr
        ? `这份 PDF(${pageCount} 页)没有文字层, 是扫描件 —— 需要先做 OCR 识别才能拿到正文。`
        : `这份 PDF 只有 ${pageCount || "不足 " + OCR_MIN_PAGES} 页且没有文字层, OCR 出来大概率也是空的 —— 请确认传的是目标文档。`,
    };
  }

  if (ext === "docx" || ext === "doc") {
    /**
     * ⚠ 2026-10-03: .doc 不再直接拒绝。
     *
     * 改前这里是 `return { error: "暂不支持旧版 .doc, 请先另存为 .docx" }` —— 而这条分支
     * 被**审稿建 job 的正文抽取**与**资料库预览**共用, 于是在这两条路上, 用户资料库里
     * 那些结题报告书/申报书(至今仍是 .doc 的公文模板)**一处都读不到**。
     *
     * 现在走 office-preview-service 的 `readLegacyDoc`(word-extractor, MIT), 出纯文本。
     * 代价必须说清: 表格会摊平成行、页眉混在开头、版式不还原 —— 但"能给 LLM/审稿读到的正文"
     * 与"把版式还给用户"是两个目标, 这条路径要的是前者。
     */
    if (ext === "doc") {
      try {
        const { readLegacyDoc } = await import("./office-preview-service.js");
        const r = await readLegacyDoc(buf);
        return r.ok
          ? { text: r.text, pageCount: null, extraction: "doc", needsOcr: false, error: "" }
          : { text: "", pageCount: null, extraction: "failed", needsOcr: false, error: r.error };
      } catch (e) {
        return { text: "", pageCount: null, extraction: "failed", needsOcr: false, error: `.doc 解析失败: ${String((e as Error).message).slice(0, 160)}` };
      }
    }
    const tmp = path.join(os.tmpdir(), `filetext-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`);
    try {
      writeFileSync(tmp, buf);
      const { extractDocxText } = await import("./format-docx-service.js");
      const text = await extractDocxText(tmp);
      return { text, pageCount: null, extraction: "mammoth", needsOcr: false, error: text.trim() ? "" : "该 .docx 没有提取到正文" };
    } catch (e) {
      return { text: "", pageCount: null, extraction: "failed", needsOcr: false, error: `Word 解析失败: ${String((e as Error).message).slice(0, 160)}` };
    } finally {
      try { unlinkSync(tmp); } catch { /* 临时文件清理失败不影响结果 */ }
    }
  }

  if (ext === "xlsx" || ext === "xls") {
    const tmp = path.join(os.tmpdir(), `filetext-${Date.now()}.${ext}`);
    try {
      writeFileSync(tmp, buf);
      const csv = await runPython([path.join(process.env.SAG_ROOT || process.cwd(), "scripts", "xlsx2csv.py"), tmp]);
      return { text: csv, pageCount: null, extraction: "native", needsOcr: false, error: csv.trim() ? "" : "表格是空的" };
    } catch (e) {
      return { text: "", pageCount: null, extraction: "failed", needsOcr: false, error: `表格解析失败: ${String((e as Error).message).slice(0, 160)}` };
    } finally {
      try { unlinkSync(tmp); } catch { /* 同上 */ }
    }
  }

  return {
    text: "", pageCount: null, extraction: "failed", needsOcr: false,
    error: `暂不支持 ${ext ? "." + ext : "这种"} 格式的文本抽取(支持 pdf/doc/docx/txt/md/xlsx), 可改用「粘贴文本」。`,
  };
}

/** 读一行(带归属校验 —— 这张表里全是用户论文, 缺 owner 过滤就等于把别人的稿件交出去) */
async function loadRow(userId: string, fileId: string): Promise<{ id: string; filename: string; storage_rel: string; text: string; extraction: string } | null> {  const r = await pool.query(
    `select id, filename, storage_rel, text, extraction from user_files where id=$1 and user_id=$2`,
    [rawFileId(fileId), userId]);
  return r.rows[0] ?? null;
}

/**
 * fileId → 文本。抽过就直接返回(库里那份是缓存), 没抽过才现抽并回填。
 *
 * `force` 用在上次抽失败之后重试(比如用户刚换了个能用的 OCR 密钥)。
 */
export async function ensureFileText(userId: string, fileId: string, opts: { force?: boolean } = {}): Promise<FileTextResult> {
  const row = await loadRow(userId, fileId);
  const base: FileTextResult = {
    ok: false, fileId: `file_${rawFileId(fileId)}`, fileName: row?.filename ?? "", ext: extOf(row?.filename ?? ""),
    text: "", charCount: 0, pageCount: null, extraction: "", needsOcr: false, error: "",
  };
  if (!row) return { ...base, error: "文件不存在或不属于你" };

  // 有正文就直接给 —— 这是快路径, 也是把 text 存库的全部理由
  if (!opts.force && String(row.text ?? "").trim()) {
    const text = String(row.text).slice(0, MAX_TEXT);
    return { ...base, ok: true, text, charCount: text.length, extraction: (row.extraction || "native") as FileExtraction };
  }

  const buf = await getObject(String(row.storage_rel ?? ""));
  if (!buf) return { ...base, error: "文件字节已丢失(存储里找不到), 请重新上传" };

  const ex = await extractFromBuffer(buf, row.filename);
  if (!ex.text.trim()) {
    // 失败也要落库(extraction='failed'): 下次读的人立刻知道"抽过了, 是这个原因",
    //   不用再等一遍几秒的失败。error 只在这一次的返回值里 —— 调用方当场就要用它做提示
    //   (user_files 没有 updated_at 列, 只有 created_at —— 不为了这一处去加)
    await pool.query(`update user_files set extraction='failed' where id=$1 and user_id=$2`,
      [row.id, userId]);
    return { ...base, extraction: "failed", needsOcr: ex.needsOcr, pageCount: ex.pageCount, error: ex.error };
  }

  const text = ex.text.slice(0, MAX_TEXT);
  await pool.query(`update user_files set text=$2, extraction=$3 where id=$1 and user_id=$4`,
    [row.id, text, ex.extraction, userId]);
  return { ...base, ok: true, text, charCount: text.length, pageCount: ex.pageCount, extraction: ex.extraction };
}

/**
 * 表格文件的**结构化**读取(多 sheet + 列类型)。xlsx/xls 专用。
 *
 * 由来(2026-10-02 对照 Respal 的表格预览): 改前 xlsx 只有一条路 ——
 * `scripts/xlsx2csv.py` 把**首个含数据的 sheet** 转成 CSV 纯文本。两个后果都很难看:
 *   · 一份"说明 / 变量表 / 数据"三 sheet 的问卷传进来, 用户只看到说明页, 数据根本没出现;
 *   · 日期列变成数字或字符串, 前端还按"前 50 行数字占比"猜类型 —— 猜错的列会被
 *     当成分类变量送进回归。
 * 现在多 sheet 与列类型都由 openpyxl 直出(它本来就带着 Python 类型, 不用猜)。
 *
 * 边界: 每 sheet 只回前 `previewRows` 行。这是**预览**, 全量数据仍走
 * `/api/files/{id}/content`(那时已是 CSV) —— 评估里动辄十万行的表不该塞进一个 JSON。
 */
export interface SheetPreview {
  name: string;
  empty: boolean;
  columns: Array<{ name: string; type: string }>;
  header: string[];
  rows: Array<Array<string | number | boolean>>;
  /** 预览只取了前 N 行, 真实行数比这多 */
  truncated: boolean;
  /** openpyxl 记的声明尺寸(拿来做"共约 N 行"的提示) */
  declaredRows: number;
}

export async function readSpreadsheet(userId: string, fileId: string, opts: { previewRows?: number } = {}): Promise<
  { ok: true; fileName: string; sheetNames: string[]; sheets: SheetPreview[] } | { ok: false; error: string }
> {
  const row = await loadRow(userId, fileId);
  if (!row) return { ok: false, error: "文件不存在或不属于你" };

  /**
   * ⚠ 上传入口会把 xlsx **转成 CSV 再落库**(server.ts 的 /api/files/upload ——
   *   统计台那条链读的是 CSV), 所以 storage_rel 指向的**不是原始 xlsx**。
   *   直接拿它喂 openpyxl 只会得到 "File is not a zip file"(实测踩过)。
   *   上传时已经解析好的多 sheet 预览存在 profile.sheets 里, 优先用它 ——
   *   既正确, 也省掉一次几秒的 Python 往返。
   */
  const cached = await loadSheetPreview(userId, fileId);
  if (cached) return { ok: true, fileName: row.filename, sheetNames: cached.sheets.map((s) => s.name), sheets: cached.sheets };

  const buf = await getObject(String(row.storage_rel ?? ""));
  if (!buf) return { ok: false, error: "文件字节已丢失(存储里找不到), 请重新上传" };
  return readSpreadsheetFromBuffer(buf, row.filename, opts);
}

/** 读上传时存进 profile.sheets 的多 sheet 预览(没有则 null) */
export async function loadSheetPreview(userId: string, fileId: string): Promise<{ sheets: SheetPreview[] } | null> {
  const r = await pool.query(
    `select profile from user_files where id=$1 and user_id=$2`,
    [rawFileId(fileId), userId]);
  const sheets = (r.rows[0]?.profile as { sheets?: SheetPreview[] } | undefined)?.sheets;
  return Array.isArray(sheets) && sheets.length ? { sheets } : null;
}

/** 同上, 但直接吃字节 —— 资料库(vault)那条路没有 user_files 行, 只有磁盘上的文件 */export async function readSpreadsheetFromBuffer(buf: Buffer, fileName: string, opts: { previewRows?: number } = {}): Promise<
  { ok: true; fileName: string; sheetNames: string[]; sheets: SheetPreview[] } | { ok: false; error: string }
> {
  const ext = extOf(fileName);
  if (ext !== "xlsx" && ext !== "xls") return { ok: false, error: `不是表格文件(.${ext})` };

  const tmp = path.join(os.tmpdir(), `sheet-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  try {
    writeFileSync(tmp, buf);
    const out = await runPython([
      path.join(process.env.SAG_ROOT || process.cwd(), "scripts", "xlsx2csv.py"), tmp, "--meta",
    ], 60_000);
    const parsed = JSON.parse(out) as { sheetNames: string[]; sheets: SheetPreview[] };
    const limit = opts.previewRows ?? 200;
    // 脚本侧已按 200 截断; 调用方要更少时在这里再切一刀(让"预览行数"是一个参数而不是常量)
    const sheets = parsed.sheets.map((s) => (limit < 200 && !s.empty
      ? { ...s, rows: s.rows.slice(0, limit), truncated: s.truncated || s.rows.length > limit }
      : s));
    return { ok: true, fileName, sheetNames: parsed.sheetNames, sheets };
  } catch (e) {
    return { ok: false, error: `表格读取失败: ${String((e as Error).message).slice(0, 160)}` };
  } finally {
    try { unlinkSync(tmp); } catch { /* 临时文件清理失败不影响结果 */ }
  }
}

/**
 * 把 OCR 结果写回文件的 text 列 —— 「识别文字」那条链跑完之后调这个。
 * 由来: OCR 的产物原本只落在 `ocr_jobs.text` 里, 而审稿/对话要的是「这个**上传文件**的正文」。
 * 不写回的话, 用户 OCR 完回到评审面板, 系统还是说"这份是扫描件"。
 */
export async function attachOcrText(userId: string, fileId: string, text: string): Promise<boolean> {
  if (!String(text ?? "").trim()) return false;
  const r = await pool.query(
    `update user_files set text=$2, extraction='ocr' where id=$1 and user_id=$3`,
    [rawFileId(fileId), String(text).slice(0, MAX_TEXT), userId]);
  return (r.rowCount ?? 0) > 0;
}

/** 登记一个已落盘的文件(上传入口调用)。profile 由调用方给 —— 表格剖析是数据链路的事 */
export async function registerUploadedFile(input: {
  id: string; userId: string; filename: string; mime: string; sizeBytes: number; storageRel: string; profile: unknown;
}): Promise<void> {
  await pool.query(
    `insert into user_files (id, user_id, filename, mime, size_bytes, storage_rel, profile)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [input.id, input.userId, input.filename, input.mime, input.sizeBytes, input.storageRel, JSON.stringify(input.profile ?? {})]);
}
