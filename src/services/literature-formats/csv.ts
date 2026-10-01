// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// csv.ts — 带表头的通用题录表(CSV / TSV / 知网的"复制表格")
//
// 由来: 用户的题录**一大半是从 Excel 里另存的 CSV** —— 没有哪家的固定格式,
//   列名中英文混着来(`题名` / `Title` / `TI`; `作者` / `Author` / `A1`)。
//   与其为每个来源写一个解析器, 不如做一张**列名别名表**(common.ts 的 FIELD_ALIASES)
//   按表头认列。旧项目 AIToolman 的 `read_OTHER_file` 语义里最有用的一条就是这个。
//
// ⚠ 两个必须自己处理的地方(用 `split(",")` 的实现会在这里整批错位):
//   ① **带引号的字段里可以含分隔符与换行**(`"Zhang, San"`、摘要里换行) ——
//      必须按 RFC4180 逐字符扫, 不能按分隔符切;
//   ② 有的文件**没有表头**(知网复制的纯文本表格常带上它自己的中文列头, 但也可能没有) ——
//      认不出列名时退回 `other.ts` 按位置猜。
import {
  type FormatParser, type LiteratureRecord, FIELD_ALIASES, normalizeKey, normalizeDoi,
  parseYear, splitList, authorsOf, keywordsFrom, pagesFrom, normalizeType, finish,
} from "./common.js";

/** 分隔符探测: 取前几行里出现次数最稳定的一种 */
export function sniffDelimiter(text: string): string {
  const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 8);
  if (lines.length === 0) return ",";
  const cands: Array<[string, string]> = [["\t", "\t"], [",", ","], [";", ";"], ["|", "|"]];
  let best = ",", bestScore = 0;
  for (const [name, d] of cands) {
    const counts = lines.map((l) => splitRow(l, d).length - 1);
    if (counts[0] <= 0) continue;
    // "稳定" = 多数行的列数一致且 > 0
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    if (mode <= 0) continue;
    const agree = counts.filter((c) => c === mode).length / counts.length;
    const score = mode * agree;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/**
 * RFC4180 单行切分: 引号内的分隔符/换行都算内容。
 * `inQuotes` 与 `cell` 由调用方跨行保留 —— 字段里换行要能接起来。
 */
export function splitRow(line: string, delim: string): string[] {
  const cells: string[] = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }   // `""` = 一个字面引号
        else inQuotes = false;
      } else cur += c;
      continue;
    }
    if (c === '"' && cur === "") { inQuotes = true; continue; }
    if (c === delim) { cells.push(cur); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** 整表切分(处理跨行引号字段) */
export function splitTable(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [], field = "", inQuotes = false;
  const src = String(text ?? "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field.trim() === "") { inQuotes = true; field = ""; continue; }
    if (c === delim) { cur.push(field.trim()); field = ""; continue; }
    if (c === "\n") { cur.push(field.trim()); rows.push(cur); cur = []; field = ""; continue; }
    if (c === "\r") continue;
    field += c;
  }
  if (field.trim() !== "" || cur.length) { cur.push(field.trim()); rows.push(cur); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

/** 表头 → 字段映射; 认出的列少于 2 个就认为"这不是题录表" */
export function mapHeader(cells: string[]): { map: Record<number, string>; hits: number } {
  const map: Record<number, string> = {};
  let hits = 0;
  cells.forEach((h, i) => {
    const f = FIELD_ALIASES[normalizeKey(h)];
    if (f && !Object.values(map).includes(f)) { map[i] = f; hits++; }
  });
  return { map, hits };
}

/** 关键词列可能是 `关键词; 主题词` 也可能是 `a|b` */
function keywordsFromCell(v: string): string[] {
  return splitList(v.replace(/[|｜]/g, ";"));
}

export function parseCsv(text: string): LiteratureRecord[] {
  const src = String(text ?? "");
  if (!src.trim()) return [];
  const delim = sniffDelimiter(src);
  const rows = splitTable(src, delim);
  if (rows.length < 2) return [];

  let headerIdx = -1;
  let header = { map: {} as Record<number, string>, hits: 0 };
  // 表头可能不在第一行(有的导出在前面写"检索结果: N 条") —— 前 5 行里找最像表头的那行
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const h = mapHeader(rows[i]);
    if (h.hits > header.hits) { header = h; headerIdx = i; }
  }
  if (header.hits < 2) return [];   // 认不出列 → 交给 other.ts

  const out: LiteratureRecord[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.every((c) => c === "")) continue;
    const get = (field: string): string => {
      for (const [idx, f] of Object.entries(header.map)) {
        if (f === field) return cells[Number(idx)] ?? "";
      }
      return "";
    };
    const title = get("title");
    if (!title || title.length < 2) continue;              // 无标题 → 不是题录行
    // `年卷期` 这种合并列: 从里面抠年份, 顺便当卷期
    const yearCell = get("year");
    const volumeIssue = get("volume") || "";
    const issue = get("issue") || "";
    out.push(finish({
      title,
      authors: authorsOf(get("authors")),
      year: parseYear(yearCell),
      journal: get("journal"),
      volume: volumeIssue,
      issue,
      pages: pagesFrom(get("pages"), "", ""),
      doi: normalizeDoi(get("doi")),
      abstract: get("abstract"),
      keywords: keywordsFromCell(get("keywords")),
      url: /^https?:/i.test(get("url")) ? get("url") : "",
      type: normalizeType(get("type")),
      source: "csv",
    }));
  }
  return out;
}

export const csvParser: FormatParser = {
  id: "csv",
  label: "CSV / TSV 表",
  score(t: string): number {
    const s = String(t ?? "");
    if (!s.trim()) return 0;
    // 带标签的文本格式优先(它们更具体), 这里判 0 让 detectFormat 不去抢
    if (/^\s*(TY|PT|PMID|FN)\b/m.test(s)) return 0;
    if (/^\s*@[A-Za-z]+\s*[{(]/.test(s)) return 0;
    const rows = splitTable(s, sniffDelimiter(s));
    if (rows.length < 2) return 0;
    const { hits } = mapHeader(rows[0]);
    if (hits < 2) return 0;
    // 命中列越多越确信(只有"标题+年份"两列的表可能是任何东西)
    return Math.min(75, 25 + hits * 8);
  },
  read: parseCsv,
};

export default csvParser;
