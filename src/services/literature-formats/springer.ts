// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// springer.ts — Springer Nature Metadata API 的 JSON 导出

import {
  type FormatParser, type LiteratureRecord, text, textOrValue, parseYear, normalizeDoi,
  authorsOf, keywordsFrom, pagesFrom, venueFrom, normalizeType, finish,
} from "./common.js";

export function readSpringerRecords(parsed: unknown): LiteratureRecord[] {
  const recs: unknown[] = [];
  const push = (v: unknown): void => {
    if (Array.isArray(v)) recs.push(...v);
    else if (v && typeof v === "object") recs.push(v);
  };
  if (Array.isArray(parsed)) push(parsed);
  else if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    push(o.records);
    push(o.result);
    push(o.entries);
    // 单条记录(不是集合) —— 顶层就是一篇
    if (recs.length === 0 && o.title && (o.authors || o.creator || o.publicationName)) recs.push(o);
  }
  return recs.map((r) => toRecord(r as Record<string, unknown>)).filter((r): r is LiteratureRecord => r !== null);
}

function toRecord(o: Record<string, unknown>): LiteratureRecord | null {
  const title = textOrValue(o.title) || textOrValue(o.name);
  if (!title) return null;
  // Springer 的日期字段在 `publicationDate` / `onlineDate` / `date` 之间飘
  const dateStr = textOrValue(o.publicationDate) || textOrValue(o.onlineDate) || textOrValue(o.date) || textOrValue(o.coverDate);
  return finish({
    title,
    authors: authorsOf(o.creators ?? o.authors ?? o.creator),
    year: parseYear(dateStr || o.publicationYear),
    journal: venueFrom(o.publicationName ?? o.journal ?? o.container ?? o.publication),
    volume: textOrValue(o.volume ?? o.volumeNumber),
    issue: textOrValue(o.number ?? o.issue),
    pages: pagesFrom(o.pagination ?? o.pages ?? o.pageRange, o.startingPage, o.endingPage),
    doi: normalizeDoi(o.doi ?? o.identifier ?? o.articleDoi),
    abstract: textOrValue(o.abstract),
    keywords: keywordsFrom(o.keywords ?? o.subjects ?? o.keyword),
    url: textOrValue(o.url ?? o.uri) || (text(o.electronicUrl) ? text(o.electronicUrl) : ""),
    type: normalizeType(textOrValue(o.contentType) || textOrValue(o.type) || textOrValue(o.genre)),
    source: "springer",
  });
}

export const springerParser: FormatParser = {
  id: "springer",
  label: "Springer JSON",
  /**
   * Springer 特有的字段名组合: `publicationName`(刊名, 别家不叫这个)、
   * `pagination`(页码, 别家叫 pages)、`contentType`。
   * 只给 70 —— JSON 之间靠字段名区分, 误判成本比文本格式高。
   */
  score(t: string): number {
    const s = String(t ?? "").trim();
    if (!s.startsWith("{") && !s.startsWith("[")) return 0;
    // ⚠ 这里**必须**先确认它是一个合法 JSON。只查字符串特征的话, 一段被截断的 JSON
    //   也会因为"含有 pagination 这个词"而拿分 —— 然后 parser.read 里 JSON.parse 失败
    //   返回空, 用户看到的失败原因会是"没解析出题录"而不是"这个文件是坏的 JSON"。
    if (safeJson(s) === null) return 0;
    let score = 0;
    if (/"(publicationName|pagination|contentType|startingPage|endingPage|coverDate)"\s*:/.test(s)) score += 45;
    if (/"(creators|abstract|publicationDate)"\s*:/.test(s)) score += 20;
    if (/"(doi|identifier)"\s*:/.test(s)) score += 10;
    if (/"(records|result)"\s*:\s*[[{]/.test(s)) score += 10;
    return Math.min(70, score);
  },
  read: (t) => readSpringerRecords(safeJson(t)),
};

/** JSON.parse 包一层 —— 坏 JSON 返回 null 而不是抛, 由调用方记 failed */
export function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

export default springerParser;
