// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// openalex.ts — OpenAlex works JSON 导出
//
// 由来: 旧项目 AIToolman 的 `read_OPENALEX_file`。本平台已有 OpenAlex **在线**臂
//   (`citation-discovery-service` / `research-literature-retrieval`), 但没有"用户自己
//   导出一份 OpenAlex JSON 再导进来"的入口 —— 这个文件补的就是那段。
//
// ⚠ OpenAlex 有两个形状**只在这一家出现**, 认不出来的实现会把它们读成空:
//   ① 刊名/出版年/类型都在 `primary_location.source` 与 `publication_year` 里,
//      顶层没有 `journal` 这种键;
//   ② **摘要不是文本**, 而是 `abstract_inverted_index`(词 → 出现位置数组)。
//      它必须按位置重排回原句 —— 直接 `Object.keys` 得到的是乱序词典, 不是摘要。
import {
  type FormatParser, type LiteratureRecord, text, textOrValue, parseYear, normalizeDoi,
  authorsOf, keywordsFrom, invertAbstract, normalizeType, finish,
} from "./common.js";
import { safeJson } from "./springer.js";

export function readOpenAlexJson(parsed: unknown): LiteratureRecord[] {
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).results))
      ? ((parsed as Record<string, unknown>).results as unknown[])
      : (parsed && typeof parsed === "object" ? [parsed] : []);
  const out: LiteratureRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    // 展示标题优先; `title` 在 OpenAlex 里可能为 null(它用 display_name)
    const title = text(o.display_name) || text(o.title);
    if (!title) continue;
    const host = (o.primary_location && typeof o.primary_location === "object")
      ? (o.primary_location as Record<string, unknown>).source as Record<string, unknown> | undefined
      : undefined;
    const biblio = (o.biblio && typeof o.biblio === "object") ? o.biblio as Record<string, unknown> : undefined;
    const openAccess = (o.open_access && typeof o.open_access === "object") ? o.open_access as Record<string, unknown> : undefined;
    const first = biblio ? text(biblio.first_page) : "";
    const last = biblio ? text(biblio.last_page) : "";
    out.push(finish({
      title,
      authors: authorsOf(o.authorships ?? o.authors),
      year: parseYear(o.publication_year ?? o.publication_date),
      journal: text(host?.display_name) || text(host?.title),
      volume: biblio ? text(biblio.volume) : "",
      issue: biblio ? text(biblio.issue) : "",
      pages: first && last && first !== last ? `${first}-${last}` : first || last,
      doi: normalizeDoi(o.doi),
      abstract: invertAbstract(o.abstract_inverted_index) || textOrValue(o.abstract),
      keywords: keywordsFrom(o.keywords ?? o.concepts ?? o.topics ?? o.subjects),
      // 有 DOI 时 finish() 会补 doi.org 链接; 没有就用 primary_location 的落地页
      url: text(host?.landing_page_url) || (openAccess ? text(openAccess.oa_url) : "") || text(o.id),
      // OpenAlex 的 `type` 在导出里可能是数组(["article"]) —— 不等于字符串会被当成对象丢掉
      type: normalizeType(Array.isArray(o.type) ? String(o.type[0] ?? "") : o.type ?? o.type_crossref),
      source: "openalex",
    }));
  }
  return out;
}

export const openalexParser: FormatParser = {
  id: "openalex",
  label: "OpenAlex JSON",
  score(t: string): number {
    const s = String(t ?? "").trim();
    if (!s.startsWith("{") && !s.startsWith("[")) return 0;
    // 与 springer.ts 同理: 先确认是合法 JSON, 否则截断的 JSON 会拿到分
    if (safeJson(s) === null) return 0;
    let score = 0;
    // 铁证: 倒排摘要 + OpenAlex 的 id 形态
    if (/"abstract_inverted_index"\s*:/.test(s)) score += 45;
    if (/"openalex\.org\/W\d+"/.test(s) || /"ids"\s*:\s*\{/.test(s)) score += 25;
    if (/"publication_year"\s*:/.test(s) && /"authorships"\s*:/.test(s)) score += 20;
    if (/"primary_location"\s*:/.test(s)) score += 10;
    return Math.min(80, score);
  },
  read: (t) => readOpenAlexJson(safeJson(t)),
};

export default openalexParser;
