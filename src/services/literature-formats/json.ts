// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// json.ts — 通用题录 JSON(认不出是哪一家时的兜底)
//
// 由来: 用户的 JSON 题录来自各种小工具/自建脚本, 名字五花八门(`records` / `items` /
//   `data` / `papers` / `docs`), 字段名中英混用。做不了"一家一个解析器", 只能:
//   找到一个**看起来像题录的数组**, 然后按列名别名表(common.ts FIELD_ALIASES)认字段。
//
// 与 csv.ts 是同一套思路, 只是一个吃表、一个吃对象数组。
import {
  type FormatParser, type LiteratureRecord, text, textOrValue, pickByAlias, normalizeDoi,
  parseYear, authorsOf, keywordsFrom, pagesFrom, venueFrom, invertAbstract, normalizeType, finish,
} from "./common.js";
import { safeJson } from "./springer.js";

/** 数组藏在哪个键下面 —— 按常见程度排, 取第一个命中的 */
const COLLECTION_KEYS = ["records", "results", "items", "data", "papers", "entries", "docs", "documents", "articles", "list", "hits"];

/** 一篇记录至少要认得出"标题"或(作者 + 年份) */
function looksLikeRecord(o: Record<string, unknown>): boolean {
  if (textOrValue(o.title) || textOrValue(pickByAlias(o, "title"))) return true;
  const hasAuthor = o.authors ?? o.author ?? pickByAlias(o, "authors");
  const hasYear = o.year ?? o.date ?? pickByAlias(o, "year");
  return Boolean(hasAuthor && hasYear);
}

/** 从任意 JSON 里找出题录数组 */
export function findRecordArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const o = parsed as Record<string, unknown>;
  for (const k of COLLECTION_KEYS) {
    if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  // 没有集合键: 顶层对象自己可能就是一篇
  return looksLikeRecord(o) ? [o] : [];
}

export function readGenericJson(parsed: unknown): LiteratureRecord[] {
  const list = findRecordArray(parsed);
  const out: LiteratureRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const title = textOrValue(pickByAlias(o, "title"));
    if (!title) continue;
    out.push(finish({
      title,
      authors: authorsOf(pickByAlias(o, "authors")),
      year: parseYear(pickByAlias(o, "year")),
      journal: venueFrom(pickByAlias(o, "journal")),
      volume: textOrValue(pickByAlias(o, "volume")),
      issue: textOrValue(pickByAlias(o, "issue")),
      pages: pagesFrom(pickByAlias(o, "pages"), "", ""),
      doi: normalizeDoi(pickByAlias(o, "doi")),
      // 有的导出把摘要写成倒排索引(OpenAlex 转存过一手) —— 两种都要认
      abstract: textOrValue(pickByAlias(o, "abstract")) || invertAbstract(pickByAlias(o, "abstract")),
      keywords: keywordsFrom(pickByAlias(o, "keywords")),
      url: textOrValue(pickByAlias(o, "url")),
      type: normalizeType(textOrValue(pickByAlias(o, "type"))),
      source: "json",
    }));
  }
  return out;
}

export const jsonParser: FormatParser = {
  id: "json",
  label: "通用 JSON",
  /**
   * 兜底性质: 分数刻意压低(40), 只有更具体的 JSON 解析器(springer/openalex/S2/arxiv)
   * 全都不认时才轮到它。
   */
  score(t: string): number {
    const s = String(t ?? "").trim();
    if (!s.startsWith("{") && !s.startsWith("[")) return 0;
    const parsed = safeJson(s);
    if (parsed === null) return 0;                              // 坏 JSON 不算格式命中
    const list = findRecordArray(parsed);
    if (list.length === 0) return 0;
    const sample = list.slice(0, 5).filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>;
    if (sample.length === 0) return 0;
    const known = sample.filter(looksLikeRecord).length;
    if (known === 0) return 0;
    return Math.min(40, 15 + Math.round((known / sample.length) * 25));
  },
  read: (t) => readGenericJson(safeJson(t)),
};

export default jsonParser;
