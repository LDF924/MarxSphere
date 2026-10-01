// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// arxiv.ts — arXiv 导出(Atom XML / arXiv API JSON / arXiv CSV)
//
// 由来: 旧项目 AIToolman 的 `read_ARXIV_file`。arXiv 的导出有**三种皮**, 都得认:
//   ① API 的 Atom XML —— `<feed><entry><title>…`, 这就是 `readArxiv` 那边在用的形状;
//      注意 `<entry>` 里的作者是 `<author><name>…</name></author>`, 且 `<id>` 形如
//      `http://arxiv.org/abs/2301.12345v2`;
//   ② arXiv 列表页 / 第三方工具导出的 JSON(`{"title": …, "authors": "…"}`);
//   ③ arXiv 的 CSV 导出 —— 列名固定, 交给 csv.ts(它认得 `arXiv ID` 这类列)。
//
// ⚠ arXiv 特有的一处: 标题与摘要里**换行被折成硬换行**(每 ~80 字符), 直接读出来
//   标题中间会带 `\n`, 判重与展示都会出错 —— 必须把空白折叠掉。
import {
  type FormatParser, type LiteratureRecord, text, textOrValue, parseYear, normalizeDoi,
  authorsOf, keywordsFrom, finish,
} from "./common.js";
import { safeJson } from "./springer.js";

/** XML 里的 `<tag>…</tag>`(含 CDATA 与实体) */
function xmlText(block: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!m) return "";
  return decodeXml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, ""));
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** arXiv ID: `http://arxiv.org/abs/2301.12345v2` → `2301.12345v2`(URL 形式) */
function arxivIdFrom(v: string): string {
  const m = /(\d{4}\.\d{4,5}(?:v\d+)?)/.exec(String(v ?? ""));
  if (m) return m[1];
  const old = /([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i.exec(String(v ?? ""));
  return old ? old[1] : "";
}

export function readArxivXml(xml: string): LiteratureRecord[] {
  const out: LiteratureRecord[] = [];
  for (const m of String(xml ?? "").matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const b = m[1];
    const title = xmlText(b, "title");
    if (!title) continue;
    // 作者: `<author><name>San Zhang</name></author>`(name 要取在 author 之内)
    const authors = [...b.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)].map((a) => xmlText(a[1], "name")).filter(Boolean);
    const id = xmlText(b, "id") || xmlText(b, "guid");
    const arxivId = arxivIdFrom(id);
    const doi = xmlText(b, "arxiv:doi") || xmlText(b, "doi");
    const journalRef = xmlText(b, "arxiv:journal_ref") || xmlText(b, "journal_ref");
    const published = xmlText(b, "published") || xmlText(b, "updated");
    out.push(finish({
      title,
      authors,
      year: parseYear(published),
      journal: journalRef,
      doi,
      abstract: xmlText(b, "summary"),
      keywords: [...b.matchAll(/<category\b[^>]*term="([^"]+)"/gi)].map((c) => c[1]),
      url: arxivId ? `https://arxiv.org/abs/${arxivId}` : id,
      type: "preprint",
      source: "arxiv",
    }));
  }
  return out;
}

export function readArxivJson(parsed: unknown): LiteratureRecord[] {
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).entries))
      ? ((parsed as Record<string, unknown>).entries as unknown[])
      : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).results))
        ? ((parsed as Record<string, unknown>).results as unknown[])
        : (parsed && typeof parsed === "object" ? [parsed] : []);
  const out: LiteratureRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = textOrValue(o.title);
    if (!title) continue;
    const id = textOrValue(o.id) || textOrValue(o.arxivId) || textOrValue(o.arxiv_id) || textOrValue(o.link);
    const arxivId = arxivIdFrom(id);
    const doi = normalizeDoi(o.doi);
    out.push(finish({
      title,
      authors: authorsOf(o.authors ?? o.author ?? o.creator),
      year: parseYear(o.published ?? o.updated ?? o.date ?? o.year),
      doi,
      abstract: textOrValue(o.summary) || textOrValue(o.abstract),
      keywords: keywordsFrom(o.categories ?? o.keywords ?? o.subjects),
      url: /^https?:/i.test(id) ? id : arxivId ? `https://arxiv.org/abs/${arxivId}` : "",
      type: "preprint",
      source: "arxiv",
    }));
  }
  return out;
}

export const arxivParser: FormatParser = {
  id: "arxiv",
  label: "arXiv(Atom XML / JSON)",
  score(t: string): number {
    const s = String(t ?? "").trim();
    if (!s) return 0;
    if (/<feed[\s>]/i.test(s) && /<entry[\s>]/i.test(s)) {
      // Atom 可能是 arXiv, 也可能是别的博客订阅源 —— 要有 arXiv 的专属命名空间才算
      if (/arxiv\.org\/abs\//i.test(s) || /xmlns:arxiv/i.test(s) || /<arxiv:doi/i.test(s)) return 75;
      return 35;
    }
    if (s.startsWith("{") || s.startsWith("[")) {
      if (/"arxiv_id"|"arxivId"|arxiv\.org\/abs\//i.test(s)) return 55;
      if (/"primary_category"|"primaryCategory"/i.test(s)) return 50;   // arXiv API 独有
      if (/"summary"\s*:/.test(s) && /"authors"\s*:/.test(s) && /"published"\s*:/.test(s)) return 40;
    }
    return 0;
  },
  read: (t) => {
    const s = String(t ?? "").trim();
    if (s.startsWith("{") || s.startsWith("[")) return readArxivJson(safeJson(s));
    return readArxivXml(s);
  },
};

export default arxivParser;
