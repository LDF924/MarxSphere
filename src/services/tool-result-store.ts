// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/tool-result-store.ts — 工具大结果压缩存储 + 按需取回
// 借鉴 OpenSquilla engine/tool_result_store.py + result_budget.py(Apache-2.0) 自写实现:
//   大工具输出(>阈值)gzip 存 data/tool-results/tr-<sha256前32>.json.gz, 返回给模型的
//   文本换小预览 + handle + 说明; 模型需要时调 retrieve_tool_result 精确取回
//   (支持行号窗口/关键词聚焦), 防上下文被长输出撑爆、防截断丢信息。
//   7 天保留: 每次写前清理过期记录(按 mtime)。
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const TOOL_RESULT_DIR = path.resolve(process.env.SAG_TOOL_RESULT_DIR || path.join(process.cwd(), "data", "tool-results"));
/** 超过该字符数视为"大输出", 走压缩存储(参考 OpenSquilla: 8KB 起投影; 本项目用 6000 字符) */
export const TOOL_RESULT_CHAR_THRESHOLD = 6000;
/** 返回给模型的预览长度 */
export const TOOL_RESULT_PREVIEW_CHARS = 400;
/** 保留天数 */
export const TOOL_RESULT_RETENTION_DAYS = 7;
/** 单条记录磁盘上限(保护: 超过直接拒存并返回说明) */
export const TOOL_RESULT_MAX_BYTES = 8 * 1024 * 1024;
/** 单次聚焦取回最大行数 */
export const TOOL_RESULT_FOCUS_MAX_LINES = 200;

export interface StoredToolResultMeta {
  handle: string;
  toolName: string;
  sha256: string;
  chars: number;
  bytes: number;
  createdAt: string;
}

interface StoredFile {
  meta: StoredToolResultMeta;
  content: string;
}

export interface StoreOutcome {
  /** 是否被压缩存储 */
  compressed: boolean;
  /** 压缩时的句柄; 未压缩时为空 */
  handle?: string;
  /** 给模型看的替换文本(预览 + 取回说明) */
  view: string;
  /** 存盘字节数 */
  storedBytes?: number;
  /** 丢弃原因(超过单条上限等); 有值时 view 已含说明 */
  droppedReason?: string;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function recordPath(handle: string): string {
  return path.join(TOOL_RESULT_DIR, `${handle}.json.gz`);
}

function encodeFile(content: string, meta: StoredToolResultMeta): Buffer {
  return gzipSync(Buffer.from(JSON.stringify({ meta, content }), "utf8"), { level: 6 });
}

function decodeFile(buf: Buffer): StoredFile {
  const json = gunzipSync(buf).toString("utf8");
  const parsed = JSON.parse(json) as StoredFile;
  if (!parsed?.meta?.handle || typeof parsed.content !== "string") {
    throw new Error("tool-result 记录格式损坏");
  }
  return parsed;
}

/** 清理过期记录(按 mtime, 超过保留期删除); 写前调用, 顺带清空目录中残留坏文件 */
export function cleanupExpired(now: number = Date.now()): number {
  let removed = 0;
  if (!existsSync(TOOL_RESULT_DIR)) return 0;
  const cutoff = now - TOOL_RESULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(TOOL_RESULT_DIR)) {
    if (!name.endsWith(".json.gz")) continue;
    const full = path.join(TOOL_RESULT_DIR, name);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        rmSync(full, { force: true });
        removed++;
      }
    } catch { /* 单文件失败跳过 */ }
  }
  return removed;
}

/**
 * 压缩存储大工具结果。小结果(<阈值)原样返回, 不做任何包装(不破坏既有行为)。
 * 内容寻址: 相同内容复用同一句柄(去重); 写前做一次过期清理。
 * 超单条上限的记录丢弃(返回 droppedReason, view 内含说明)。
 */
export function storeLargeResult(toolName: string, content: string): StoreOutcome {
  const chars = content.length;
  if (chars <= TOOL_RESULT_CHAR_THRESHOLD) {
    return { compressed: false, view: content };
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > TOOL_RESULT_MAX_BYTES) {
    const droppedReason = `输出过大(${(bytes / 1024 / 1024).toFixed(1)}MB > 8MB 上限), 已截断为末尾 6000 字符`;
    const tail = content.slice(-TOOL_RESULT_CHAR_THRESHOLD);
    return { compressed: true, view: `[工具 ${toolName}] ${droppedReason}\n${tail}`, droppedReason };
  }
  try {
    cleanupExpired();
    mkdirSync(TOOL_RESULT_DIR, { recursive: true });
    const sha = hashContent(content);
    const handle = `tr-${sha.slice(0, 32)}`;
    const meta: StoredToolResultMeta = {
      handle,
      toolName,
      sha256: sha,
      chars,
      bytes,
      createdAt: new Date().toISOString(),
    };
    // 内容寻址: 已存在同内容记录 → 直接复用(句柄相同内容必相同)
    const target = recordPath(handle);
    if (!existsSync(target)) {
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, encodeFile(content, meta));
      try {
        renameSync(tmp, target); // 原子写: 目标就绪前读方不会看到半截文件
      } catch {
        rmSync(tmp, { force: true });
        if (!existsSync(target)) throw new Error("tool-result 写入失败");
      }
    }
    const preview = content.slice(0, TOOL_RESULT_PREVIEW_CHARS);
    const compressedBytes = existsSync(target) ? statSync(target).size : 0;
    return {
      compressed: true,
      handle,
      storedBytes: compressedBytes,
      view: buildCompressedView(toolName, handle, chars, compressedBytes, preview),
    };
  } catch (e: any) {
    // 存储失败不阻塞执行 — 降级: 直接截断给模型(不丢信息但更省)
    const tail = content.slice(-TOOL_RESULT_CHAR_THRESHOLD);
    return {
      compressed: true,
      view: `[工具 ${toolName}] 结果过大(原 ${chars} 字符)且压缩存储失败(${String(e?.message || e).slice(0, 80)}), 已截断为末尾 6000 字符\n${tail}`,
    };
  }
}

export function buildCompressedView(toolName: string, handle: string, chars: number, storedBytes: number, preview: string): string {
  return [
    `【${toolName} 结果过大: ${chars} 字符(≈${(chars / 1000).toFixed(0)}K tokens)】完整结果已压缩存储, 需要时请调用 retrieve_tool_result 取回原文(绝不臆测缺失内容)。`,
    `句柄: ${handle}`,
    `存储: ${(storedBytes / 1024).toFixed(1)}KB gzip, 保留 7 天`,
    `取回示例: 调 retrieve_tool_result(handle="${handle}") 取全文; 或带 lines="1-200" 取行窗口; 或带 keyword="资本下乡" 关键词聚焦(前后 3 行)`,
    ``,
    `--- 预览(前 ${TOOL_RESULT_PREVIEW_CHARS} 字符) ---`,
    preview,
  ].join("\n");
}

/** 解析行窗口 "1-200" / "100" */
export function parseLineRange(spec: string): { start: number; end: number } | null {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(spec);
  if (!m) return null;
  const start = Math.max(1, Number(m[1]));
  const end = m[2] ? Math.max(start, Number(m[2])) : start;
  return { start, end };
}

export interface RetrieveOptions {
  /** 行窗口 "1-200"; 缺省全部 */
  lines?: string;
  /** 关键词聚焦: 只返回含关键词的行及其前后 context 行 */
  keyword?: string;
  /** 关键词聚焦窗口(每侧行数, 默认 3, 上限 10) */
  context?: number;
}

export interface RetrieveResult {
  ok: boolean;
  toolName?: string;
  chars?: number;
  /** 全文(未聚焦时) */
  content?: string;
  /** 聚焦视图(行窗口/关键词命中) */
  focused?: string;
  error?: string;
}

/**
 * 按句柄取回原文。支持:
 *   lines: 行窗口取回 — 命中即返回该区间原文
 *   keyword: 关键词聚焦 — 返回命中行 ±context 行(最多 TOOL_RESULT_FOCUS_MAX_LINES 行)
 * 校验: sha256 一致性; 记录不存在/损坏 → ok=false + error。
 */
export function retrieveStoredResult(handle: string, opts: RetrieveOptions = {}): RetrieveResult {
  const h = String(handle || "").trim();
  if (!/^tr-[0-9a-f]{32}$/.test(h)) {
    return { ok: false, error: `非法句柄: ${h.slice(0, 40)}（应为 tr-<32位十六进制>）` };
  }
  const target = recordPath(h);
  if (!existsSync(target)) {
    return { ok: false, error: `句柄不存在或已过期(保留 7 天): ${h}` };
  }
  let file: StoredFile;
  try {
    file = decodeFile(readFileSync(target));
  } catch (e: any) {
    return { ok: false, error: `记录损坏: ${String(e?.message || e).slice(0, 120)}` };
  }
  if (file.meta.handle !== h || file.meta.sha256 !== hashContent(file.content)) {
    return { ok: false, error: "记录校验失败(句柄/哈希不一致), 内容可能已损坏" };
  }
  const linesArr = file.content.split("\n");
  // 关键词聚焦
  if (opts.keyword) {
    const kw = opts.keyword;
    const ctx = Math.min(Math.max(Number(opts.context) || 3, 0), 10);
    const hitIdx: number[] = [];
    linesArr.forEach((ln, i) => { if (ln.includes(kw)) hitIdx.push(i); });
    if (hitIdx.length === 0) {
      return { ok: true, toolName: file.meta.toolName, chars: file.content.length, error: `关键词"${kw}"未命中(全文 ${linesArr.length} 行, 可用 retrieve_tool_result(handle="${h}") 取全文)` };
    }
    const shown = new Set<number>();
    for (const idx of hitIdx) {
      for (let j = Math.max(0, idx - ctx); j <= Math.min(linesArr.length - 1, idx + ctx); j++) shown.add(j);
    }
    const sorted = [...shown].sort((a, b) => a - b);
    const rows: string[] = [];
    let last = -10;
    for (const idx of sorted) {
      if (idx > last + 1) rows.push("…");
      rows.push(`${idx + 1}: ${linesArr[idx]}`);
      last = idx;
    }
    const limited = rows.slice(0, TOOL_RESULT_FOCUS_MAX_LINES);
    const omitted = rows.length - limited.length;
    const tail = omitted > 0 ? `\n…(余 ${omitted} 行未显示, 可缩小 keyword 范围或改行窗口)` : "";
    return { ok: true, toolName: file.meta.toolName, chars: file.content.length, focused: `关键词"${kw}"命中 ${hitIdx.length} 处(共 ${linesArr.length} 行):\n${limited.join("\n")}${tail}` };
  }
  // 行窗口
  if (opts.lines) {
    const range = parseLineRange(opts.lines);
    if (!range) {
      return { ok: false, error: `行窗口格式错误: "${opts.lines}"（应为 1-200 或 100）` };
    }
    const { start, end } = range;
    if (start > linesArr.length) {
      return { ok: true, toolName: file.meta.toolName, chars: file.content.length, focused: `行 ${start} 超出全文范围(共 ${linesArr.length} 行)` };
    }
    const slice = linesArr.slice(start - 1, Math.min(end, linesArr.length));
    const numbered = slice.map((ln, i) => `${start + i}: ${ln}`);
    return { ok: true, toolName: file.meta.toolName, chars: file.content.length, focused: numbered.join("\n") };
  }
  return { ok: true, toolName: file.meta.toolName, chars: file.content.length, content: file.content };
}
