// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// literature-import-service.ts — 题录文件导入(2026-10-01)
//
// 由来: 旧项目 AIToolman 有 9 个 `read_*_file`(WOS/CNKI/PUBMED/SPRINGER/ARXIV/
//   OPENALEX/SEMANTIC_SCHOLAR/QBYQ/OTHER)。移植前先核了一遍本项目的家底:
//   **只有 API 拉取那条路** —— `paper-source-service`(arXiv/Semantic Scholar/Cool Papers/
//   魔搭)、`citation-discovery-service`(OpenAlex 引用发现)。用户手里那堆从数据库导出的
//   题录文件(`savedrecs.txt` / `.ris` / `.bib` / 知网的复制结果)一个入口都没有。
//   本模块就是那个入口: 文件字节 → 结构化题录 → 入库 → 一份能复核的台账。
//
// 落点选择(为什么写 `documents` 而不是新建文献表): 见 migrations/167 的注释 ——
//   四源检索、写作舱文献臂、引用发现、数据指纹都读 `documents`; 另起一张表等于
//   用户导完一篇都搜不到。这里与 `zotero-service` / `paper-source-service` 同口径。
//
// ⚠ 四条边界(都不是随手写的):
//   ① **编码先于解析**: 中文题录常是 GBK/GB18030, 按 UTF-8 硬读会得到满屏 `�` ——
//      而且**不会报错**, 只是整批题名变成乱码。所以先嗅编码(见 decodeBuffer)。
//   ② **单条失败不能拖垮整批**: 一条残缺记录只丢它自己, 进 errors[]; 整批照常入库。
//      用户导 2000 条, 不该因为第 7 条少个标题就一条都没进来。
//   ③ **判重先于写入且要跨格式**: 同一篇文献从 RIS 与 BibTeX 各导一次必须只入库一条。
//      靠的是 manuscript 无关的 `lit_key`(DOI 优先, 退化到 归一化标题+年) —— 见 167。
//   ④ **不做 embedding / 不建 chunk**: 题录只有元数据, 没有正文可嵌。把它当"正文文档"
//      送进 ingestion 会把一堆空 chunk 塞进向量库, 还会触发实体抽取(纯浪费)。
//      导入的文献落在 `documents` 里、`content` 为摘要, 等用户后续补 PDF 再走既有入库链路。
import { createHash } from "node:crypto";
import { pool } from "../db/pool.js";
import {
  PARSERS, detectFormat, getParser, dedupKey, normalizeTitle,
  type FormatId, type LiteratureRecord, type DetectResult,
} from "./literature-formats/index.js";

export type { LiteratureRecord, FormatId } from "./literature-formats/index.js";

// ───────────────────────────── 编码 ─────────────────────────────

export interface DecodedText {
  text: string;
  encoding: string;
  /** 替换字符(乱码)占比 —— 高得离谱说明这份文件根本不像是文本 */
  replacementRatio: number;
}

/**
 * 字节 → 文本, 带编码嗅探。
 *
 * 顺序不是随手排的:
 *   ① **BOM 最权威** —— UTF-16/UTF-8 的 BOM 是明写的, 有就照它;
 *   ② **严格 UTF-8 解码**能成功 → 就是 UTF-8(UTF-8 的结构决定了"随便一段 GBK 字节
 *      恰好是合法 UTF-8"的概率极低);
 *   ③ 否则按 GB18030 解 —— 它是 GBK/GB2312 的超集, 中文题录的非 UTF-8 情形几乎都是它。
 *
 * ⚠ 最后必须给出**替换字符占比**: 纯二进制的文件(用户传了一张图的字节)在 GB18030 下
 *   也能"解出"一串东西而不报错。占比就是判据 —— 高的时候调用方直接判 failed,
 *   而不是把乱码当题录入库。
 */
export function decodeBuffer(buf: Buffer): DecodedText {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const finishWith = (text: string, encoding: string): DecodedText => {
    const bad = (text.match(/�/g) ?? []).length;
    return { text, encoding, replacementRatio: text.length ? bad / text.length : 0 };
  };

  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return finishWith(new TextDecoder("utf-16le").decode(b.subarray(2)), "utf-16le");
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return finishWith(new TextDecoder("utf-16be").decode(b.subarray(2)), "utf-16be");
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return finishWith(new TextDecoder("utf-8").decode(b.subarray(3)), "utf-8-bom");

  try {
    return finishWith(new TextDecoder("utf-8", { fatal: true }).decode(b), "utf-8");
  } catch {
    // 不是合法 UTF-8 → 中文题录的下一种可能
  }
  try {
    return finishWith(new TextDecoder("gb18030").decode(b), "gb18030");
  } catch {
    return finishWith(b.toString("utf-8"), "utf-8");
  }
}

// ───────────────────────────── 识别 ─────────────────────────────

export interface FormatInfo { id: FormatId; label: string }

export function listFormats(): FormatInfo[] {
  return PARSERS.map((p) => ({ id: p.id, label: p.label }));
}

/** 内容识别(不看扩展名也行) —— 供"先让我看看这是什么格式"的预览接口用 */
export function detect(text: string, fileName?: string): DetectResult {
  return detectFormat(text, extOf(fileName));
}

function extOf(fileName: string | undefined): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(fileName ?? ""));
  return m ? m[1].toLowerCase() : "";
}

/**
 * 控制字节占比: `byte < 0x20` 且不是 tab/LF/CR。
 *
 * 文本文件(UTF-8/GBK/CSV/RIS…)里这类字节几乎为 0 —— 中文是 `>= 0x80` 的双字节,
 * 不在这个范围。二进制(图片/压缩包)则满是 NUL 与其它控制码。
 *
 * ⚠ 刻意**不用"替换字符占比"**: GB18030 几乎能吃下任何字节(实测 0x80 是合法的 `€`),
 *   替换字符恒为 0, 那个判据**永远不会拦**(是个假判据)。
 *   也刻意**不用"有没有换行"**: PNG 头里就带 CRLF, 那个条件会漏掉真实图片。
 */
function controlByteRatio(bytes: Buffer): number {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (b.length === 0) return 0;
  let bad = 0;
  for (const byte of b) if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) bad++;
  return bad / b.length;
}

// ───────────────────────────── 预览 ─────────────────────────────

export interface PreviewResult {
  format: FormatId;
  formatLabel: string;
  encoding: string;
  total: number;
  sample: LiteratureRecord[];
  /** 所有得分为正的候选 —— 用户/接口能看出"它像几种格式" */
  candidates: Array<{ id: FormatId; score: number }>;
  errors: ImportError[];
}

/** 只解析不入库 —— 用户先看一眼"识别成什么格式、前几条长什么样"再决定 */
export function previewLiteratureFile(input: { bytes: Buffer; fileName?: string; maxSample?: number }): PreviewResult {
  const dec = decodeBuffer(input.bytes);
  const records = readRecords(dec.text, input.fileName);
  return {
    format: records.format,
    formatLabel: records.formatLabel,
    encoding: dec.encoding,
    total: records.records.length,
    sample: records.records.slice(0, Math.max(1, Math.min(input.maxSample ?? 5, 50))),
    candidates: records.candidates,
    errors: records.errors.slice(0, 20),
  };
}

// ───────────────────────────── 解析(纯函数) ─────────────────────────────

export interface ImportError { row: number; reason: string; raw: string }

interface ReadResult {
  format: FormatId;
  formatLabel: string;
  candidates: Array<{ id: FormatId; score: number }>;
  records: LiteratureRecord[];
  /** 被丢掉的条目(缺标题等) —— 它们是 failed 的那部分 */
  errors: ImportError[];
}

/**
 * 文本 → 题录数组。**不抛异常**: 坏掉的部分进 errors, 好的照常返回。
 *
 * `format` 显式给定时不走嗅探(用户手选了格式, 尊重他的选择); 给定但解析器不存在
 * 则记一条 error 并返回空 —— 而不是静默换一个格式解析。
 */
export function readRecords(text: string, fileName?: string, format?: FormatId | "auto"): ReadResult {
  const s = String(text ?? "");
  if (!s.trim()) {
    return { format: format && format !== "auto" ? format : "other", formatLabel: "", candidates: [], records: [], errors: [{ row: 0, reason: "文件是空的(没有任何可解析的字符)", raw: "" }] };
  }

  let id: FormatId;
  let candidates: Array<{ id: FormatId; score: number }> = [];
  if (format && format !== "auto") {
    id = format;
  } else {
    const det = detectFormat(s, extOf(fileName));
    id = det.id;
    candidates = det.candidates;
  }
  const parser = getParser(id);
  if (!parser) {
    return { format: id, formatLabel: "", candidates, records: [], errors: [{ row: 0, reason: `未知格式 "${id}"`, raw: s.slice(0, 200) }] };
  }

  const raw = splitEntries(s, id);
  const records: LiteratureRecord[] = [];
  const errors: ImportError[] = [];
  // 逐条解析: 一条崩了只丢它自己(单条隔离是"整批不能因一条失败"的实现方式)
  if (raw) {
    for (const { row, chunk } of raw.chunks) {
      try {
        // prefix(BibTeX 的 @string 宏定义)必须每一块都带上 —— 宏的作用域是整个文件
        const parsed = parser.read(raw.prefix ? `${raw.prefix}\n${chunk}` : chunk);
        if (parsed.length === 0) errors.push({ row, reason: "这条记录里没有能识别的题录(通常是没有题名)", raw: chunk.slice(0, 200).replace(/\s+/g, " ") });
        else records.push(...parsed);
      } catch (e) {
        errors.push({ row, reason: `解析异常: ${String((e as Error)?.message ?? e).slice(0, 120)}`, raw: chunk.slice(0, 200).replace(/\s+/g, " ") });
      }
    }
  } else {
    try {
      records.push(...parser.read(s));
    } catch (e) {
      errors.push({ row: 0, reason: `解析异常: ${String((e as Error)?.message ?? e).slice(0, 120)}`, raw: s.slice(0, 200).replace(/\s+/g, " ") });
    }
  }

  return { format: id, formatLabel: parser.label, candidates, records, errors };
}

/**
 * 把整份文件切成"一条记录"。
 *
 * 按格式给一对"开始/结束"标记切, 切不出两条以上就返回 null —— 整份一次性交给解析器。
 * 切分只是为了**让失败能定位到条**, 不是解析逻辑本身; 切错了不解析反而更糟,
 * 所以这里宁可退回"整份解析"。
 *
 * `prefix` 是"第一条记录之前的内容", 调用方会给**每一块**都补上 ——
 *   BibTeX 的 `@string{jrs = {...}}` 宏定义就在这个位置, 而后面的条目要引用它。
 *   不补的后果实测过: 宏展开不到, `journal = jrs` 读出来是空刊名(且不报错)。
 *
 * `end` 为 null 表示这种格式没有结束标记(EndNote Tagged 只有开头的 `%0`) ——
 * 那就以"下一条的开始"为界。**不能**用 lookahead 那种写法: 开始行会被算进两条里。
 */
function splitEntries(s: string, id: FormatId): { prefix: string; chunks: Array<{ row: number; chunk: string }> } | null {
  // BibTeX 的 `@string`/`@preamble`/`@comment` **不是文献** —— 它们不能当切分起点,
  //   否则会被当成一条"没有题名的记录"而报错(实测就是这个报错)
  const markers: Partial<Record<FormatId, { start: RegExp; end: RegExp | null }>> = {
    ris: { start: /^\s*TY\s{1,2}-/, end: /^\s*ER\s{1,2}-/ },
    wos: { start: /^PT\s+\S/, end: /^ER\s*$/ },
    medline: { start: /^PMID-\s/, end: /^ER\s*-\s*$/ },
    endnote: { start: /^%0\s+\S/, end: null },
    bibtex: { start: /^@(?:article|book|inproceedings|incollection|inbook|phdthesis|mastersthesis|techreport|misc|unpublished|conference|proceedings|booklet|manual|online|software|dataset)\s*[{(]/im, end: /^\}/ },
  };
  const mk = markers[id];
  if (!mk) return null;

  const lines = s.split(/\r?\n/);
  const chunks: Array<{ row: number; chunk: string }> = [];
  const prefixLines: string[] = [];
  let cur: string[] = [], startRow = 1, started = false;
  const push = (): void => {
    if (cur.some((l) => l.trim() !== "")) chunks.push({ row: startRow, chunk: cur.join("\n") });
    cur = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (mk.start.test(line)) {
      if (started) push();                 // 上一条到此为止(它没写结束标记, 或下一条开始了)
      started = true;
      startRow = i + 1;
      cur = [line];
      continue;
    }
    if (!started) { prefixLines.push(line); continue; }
    cur.push(line);
    if (mk.end && mk.end.test(line)) { push(); started = false; }
  }
  if (started) push();
  if (chunks.length < 2) return null;
  return { prefix: prefixLines.join("\n"), chunks };
}

// ───────────────────────────── 入库 ─────────────────────────────

export interface ImportResult {
  batchId: string;
  format: FormatId;
  formatLabel: string;
  encoding: string;
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  errors: ImportError[];
  /** 本次真正入库的 documents.id(便于前端"去看看"), 最多返回 200 个 */
  documentIds: string[];
}

export interface ImportInput {
  bytes: Buffer;
  fileName?: string;
  /** 目标文献库(项目)。与 zotero/paper-share 同名同义 */
  sourceId: string;
  userId?: string;
  /** 不传 = 按内容自动识别 */
  format?: FormatId | "auto";
}

/**
 * 导入一份题录文件。
 *
 * 返回的 `{ imported, skipped, failed, errors[] }` 是**可复核**的:
 * errors 逐条带行号与原因, 台账落 `literature_import_batches`(迁移 167)。
 */
export async function importLiteratureFile(input: ImportInput): Promise<ImportResult> {
  const dec = decodeBuffer(input.bytes);
  const fileName = String(input.fileName ?? "");

  const base = {
    batchId: "", format: "other" as FormatId, formatLabel: "", encoding: dec.encoding,
    total: 0, imported: 0, skipped: 0, failed: 0,
    errors: [] as ImportError[], documentIds: [] as string[],
  };

  // 二进制文件: 别把插图/压缩包当题录读。
  //
  // ⚠ 判据(与控制字节开头的注释配套): 控制字节(`< 0x20` 且非 tab/LF/CR, 主要是 NUL)
  //   占比 > 15%。题录文本里这类字节几乎为 0; 图片/压缩包满是它们。
  //   GB18030 里中文是 `>= 0x80`, 不会被算进来 —— 所以中文题录不会被误伤。
  if (controlByteRatio(input.bytes) > 0.15) {
    const reason = "这份文件不像是文本(大部分字节是不可打印字符) —— 题录导入要的是 .txt/.ris/.bib/.csv 这类文本导出, 不是 PDF/图片/压缩包";
    await recordBatch({ ...input, format: "other", encoding: dec.encoding, total: 0, imported: 0, skipped: 0, failed: 1, errors: [{ row: 0, reason, raw: "" }], documentIds: [] });
    return { ...base, formatLabel: "无法识别", failed: 1, errors: [{ row: 0, reason, raw: "" }] };
  }

  const read = readRecords(dec.text, fileName, input.format);
  const errors: ImportError[] = [...read.errors];
  const documentIds: string[] = [];
  let imported = 0, skipped = 0;

  // 判重集: 库里已有的 lit_key ∪ 本批已导入的(同文件内自重复也要拦)
  const existing = await loadExistingKeys(read.records, input.sourceId);
  const seen = new Set<string>();

  for (const rec of read.records) {
    try {
      const key = dedupKey(rec);
      if (!key) { errors.push({ row: 0, reason: "既没有 DOI 也没有可用标题, 无法判重", raw: rec.title.slice(0, 120) }); continue; }
      if (existing.has(key) || seen.has(key)) { skipped++; continue; }
      const id = await insertRecord(rec, key, input.sourceId);
      if (!id) { skipped++; continue; }           // 撞上标题唯一索引(同项目已有同名文档)
      seen.add(key);
      documentIds.push(id);
      imported++;
    } catch (e) {
      // 单条入库失败: 记下来继续下一条(整批不能因一条而失败)
      errors.push({ row: 0, reason: `入库失败: ${String((e as Error)?.message ?? e).slice(0, 140)}`, raw: rec.title.slice(0, 120) });
    }
  }

  const failed = errors.length;
  const batchId = await recordBatch({
    ...input, format: read.format, encoding: dec.encoding,
    total: read.records.length + read.errors.length,
    imported, skipped, failed, errors, documentIds,
  });

  return {
    batchId, format: read.format, formatLabel: read.formatLabel, encoding: dec.encoding,
    total: read.records.length + read.errors.length,
    imported, skipped, failed, errors, documentIds: documentIds.slice(0, 200),
  };
}

/** 库里已存在的题录键 —— 按 (source_id, lit_key) 查, 与 167 的唯一索引同粒度 */
async function loadExistingKeys(records: LiteratureRecord[], sourceId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const keys = [...new Set(records.map(dedupKey).filter(Boolean))];
  if (keys.length === 0) return out;
  for (let i = 0; i < keys.length; i += 500) {
    const slice = keys.slice(i, i + 500);
    const r = await pool.query(
      `select lit_key from documents where source_id = $1 and lit_key = any($2::text[])`,
      [sourceId, slice]);
    for (const row of r.rows) out.add(String((row as { lit_key: string }).lit_key));
  }
  return out;
}

/**
 * 写一条题录。
 *
 * `external_id` 直接放题录键 —— 这样 `paper-source-service` / `zotero-service` 那几条
 * 既有的 `external_id` 判重路径也能看见导入进来的文献, 不用各自再学一遍 lit_key。
 * `metadata.lit_key` 冗余存一份, 接口展示"为什么判重命中"时不用再回查。
 *
 * 冲突处理与 zotero-service 一致: `do nothing` + `returning` 为空即视为跳过 ——
 * **绝不 upsert**, 导入不该覆盖用户已有文献的正文。
 */
async function insertRecord(rec: LiteratureRecord, key: string, sourceId: string): Promise<string | null> {
  const content = [rec.abstract ?? "", rec.keywords?.length ? `关键词: ${rec.keywords.join("; ")}` : ""]
    .filter(Boolean).join("\n\n");
  const metadata = {
    importedVia: "literature-file",
    format: rec.source,
    lit_key: key,
    authors: rec.authors,
    year: rec.year,
    journal: rec.journal,
    volume: rec.volume,
    issue: rec.issue,
    pages: rec.pages,
    doi: rec.doi,
    url: rec.url,
    type: rec.type,
    keywords: rec.keywords ?? [],
  };
  // 两条唯一索引都会在这条 insert 上生效, 用 `on conflict do nothing` 一次覆盖:
  //   ① (source_id, lit_key) —— 题录级判重(本模块引入的)
  //   ② (title, source_id)   —— 016 的标题唯一索引(同一篇的标题措辞略有不同)
  // do nothing **不带冲突目标**才能同时匹配两条(DML 里给多个目标 Postgres 不接受)。
  const r = await pool.query(
    `insert into documents (id, source_id, external_id, title, content, status, parse_status, metadata, lit_key)
     values (gen_random_uuid(), $1, $2, $3, $4, 'COMPLETED', 'COMPLETED', $5::jsonb, $6)
     on conflict do nothing
     returning id`,
    [sourceId, key, rec.title, content, JSON.stringify(metadata), key]
  );
  return r.rows.length ? String(r.rows[0].id) : null;
}

/** 台账落库。台账写不进去**不能**让导入失败(它是审计, 不是主链路) */
async function recordBatch(input: ImportInput & {
  format: FormatId; encoding: string; total: number; imported: number; skipped: number;
  failed: number; errors: ImportError[]; documentIds: string[];
}): Promise<string> {
  try {
    const r = await pool.query(
      `insert into literature_import_batches
         (user_id, source_id, file_name, format, encoding, raw_bytes, total, imported, skipped, failed, errors, document_ids)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
       returning id`,
      [input.userId ?? null, input.sourceId, String(input.fileName ?? ""), input.format, input.encoding,
       Buffer.isBuffer(input.bytes) ? input.bytes.length : 0,
       input.total, input.imported, input.skipped, input.failed,
       JSON.stringify(input.errors.slice(0, 200)), JSON.stringify(input.documentIds.slice(0, 500))]
    );
    return String(r.rows[0].id);
  } catch {
    return "";
  }
}

/** 导入历史(给前端展示"上次导了什么") */
export async function listImportBatches(opts: { sourceId?: string; userId?: string; limit?: number }): Promise<Array<{
  id: string; fileName: string; format: string; encoding: string; total: number;
  imported: number; skipped: number; failed: number; created_at: string;
}>> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sourceId) { params.push(opts.sourceId); where.push(`source_id = $${params.length}`); }
  if (opts.userId) { params.push(opts.userId); where.push(`user_id = $${params.length}`); }
  params.push(Math.min(Math.max(opts.limit ?? 20, 1), 100));
  const r = await pool.query(
    `select id, file_name, format, encoding, total, imported, skipped, failed, created_at
       from literature_import_batches
      ${where.length ? "where " + where.join(" and ") : ""}
      order by created_at desc limit $${params.length}`,
    params
  );
  return r.rows.map((x: Record<string, unknown>) => ({
    id: String(x.id), fileName: String(x.file_name ?? ""), format: String(x.format ?? ""),
    encoding: String(x.encoding ?? ""), total: Number(x.total ?? 0), imported: Number(x.imported ?? 0),
    skipped: Number(x.skipped ?? 0), failed: Number(x.failed ?? 0),
    created_at: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at ?? ""),
  }));
}

/** 题录键的纯函数入口(测试与判重共用一份实现, 不各写一遍) */
export { dedupKey, normalizeTitle };

/**
 * 内容指纹 —— 与 `ingestion-service` 同口径的 sha256(那份是**正文**哈希)。
 * 题录导入不写 content_hash(内容只有摘要, 各条不同但都不是正文), 这里只为
 * 需要"这份文件导过没有"的调用方提供一个稳定键。
 */
export function fileFingerprint(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const literatureImportService = {
  decodeBuffer, detect, listFormats, previewLiteratureFile, readRecords,
  importLiteratureFile, listImportBatches, fileFingerprint, dedupKey, normalizeTitle,
};
