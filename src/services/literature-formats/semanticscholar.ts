// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// semanticscholar.ts — Semantic Scholar Graph API 的 JSON 导出
//
// 由来: 旧项目 AIToolman 的 `read_SEMANTIC_SCHOLAR_file`。本平台在线臂已接
//   `searchSemanticScholar`(paper-source-service), 这里补的是"离线导出文件"那一半。
//
// ⚠ 它的两处专属形状:
//   ① DOI **不在 doi 字段**里, 而在 `externalIds: {DOI, ArXiv, PubMed, CorpusId}` ——
//      `externalIds` 是 S2 独有的键名, 也正好是自动识别最可靠的判据;
//   ② 期刊在 `venue`(字符串)或 `journal: {name}` 里(两种都出现过, 取决于 fields 参数)。
import {
  type FormatParser, type LiteratureRecord, text, textOrValue, parseYear, normalizeDoi,
  authorsOf, keywordsFrom, normalizeType, finish,
} from "./common.js";
import { safeJson } from "./springer.js";

/** S2 的卷期页在 `journal: {volume, pages}` 里, 也可能直接挂在 `externalIds` 之外 */
function readS2Journal(o: Record<string, unknown>): { venue: string; volume: string; pages: string } {
  const j = (o.journal && typeof o.journal === "object") ? o.journal as Record<string, unknown> : undefined;
  const venue = text(o.venue) || text(o.publicationVenue) || (j ? text(j.name) : "") ||
    ((o.publicationVenue && typeof o.publicationVenue === "object")
      ? text((o.publicationVenue as Record<string, unknown>).name) : "");
  return {
    venue,
    volume: (j ? text(j.volume) : "") || text(o.volume),
    pages: (j ? text(j.pages) : "") || text(o.pages),
  };
}

export function readSemanticScholarJson(parsed: unknown): LiteratureRecord[] {
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).data))
      ? ((parsed as Record<string, unknown>).data as unknown[])
      : (parsed && typeof parsed === "object" ? [parsed] : []);
  const out: LiteratureRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = text(o.title) || text(o.display_name);
    if (!title) continue;
    const ext = (o.externalIds && typeof o.externalIds === "object") ? o.externalIds as Record<string, unknown> : undefined;
    const j = readS2Journal(o);
    const pdf = (o.openAccessPdf && typeof o.openAccessPdf === "object") ? o.openAccessPdf as Record<string, unknown> : undefined;
    const url = text(o.url) || (pdf ? text(pdf.url) : "") || (ext?.DOI ? `https://doi.org/${text(ext.DOI)}` : "");
    out.push(finish({
      title,
      authors: authorsOf(o.authors),
      year: parseYear(o.year ?? o.publicationDate),
      journal: j.venue,
      volume: j.volume,
      issue: text(o.issue) || ((o.journal && typeof o.journal === "object")
        ? textOrValue(((o.journal as Record<string, unknown>).issue)) : ""),
      pages: j.pages,
      doi: normalizeDoi(ext?.DOI ?? o.doi),
      abstract: text(o.abstract),
      keywords: keywordsFrom(o.fieldsOfStudy ?? o.s2FieldsOfStudy ?? o.keywords),
      url,
      // S2 的 publicationTypes: ["JournalArticle"] / ["Conference"] — 类型在数组里
      type: normalizeType(Array.isArray(o.publicationTypes) ? String((o.publicationTypes as unknown[])[0] ?? "") : o.type),
      source: "semanticscholar",
    }));
  }
  return out;
}

export const semanticScholarParser: FormatParser = {
  id: "semanticscholar",
  label: "Semantic Scholar JSON",
  score(t: string): number {
    const s = String(t ?? "").trim();
    if (!s.startsWith("{") && !s.startsWith("[")) return 0;
    // 与 springer.ts 同理: 先确认是合法 JSON, 否则截断的 JSON 会拿到分
    if (safeJson(s) === null) return 0;
    let score = 0;
    // 铁证: externalIds 是 S2 独有(且里面带 CorpusId)
    if (/"externalIds"\s*:/.test(s)) score += 45;
    if (/"CorpusId"\s*:/.test(s)) score += 20;
    if (/"paperId"\s*:/.test(s)) score += 20;
    if (/"openAccessPdf"\s*:/.test(s)) score += 10;
    return Math.min(80, score);
  },
  read: (t) => readSemanticScholarJson(safeJson(t)),
};

export default semanticScholarParser;
