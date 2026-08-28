// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// citation-discovery-service.ts — 引用库文献→查找新文献（2026-08-29, Agentero 对照: 支持获取库中文献的出版商, 一键查找引用库文献的新文献）
// 能力:
//   1. 以库中文献(标题/DOI)为种子, 经 OpenAlex 查引用它的新文献(citing works, 时间更新)
//   2. 按相关性/时间过滤, 返回新文献候选(含 DOI/年份/作者/摘要)
//   3. 可一键导入(复用 paperSourceService.importPaper)
// OpenAlex: 免费无需密钥, 返回 DOI/title/year/cited_by
import { pool } from "../db/pool.js";

export interface NewPaperCandidate {
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  url?: string;
  citedByCount?: number;
  abstract?: string;
}

/** 从库中取文献标题(种子), 最多取 n 篇
 *  ⚠ 优先英文标题(OpenAlex 可索引, 引用链有效); 中文知网文献 OpenAlex 不索引, 仅作回退 */
export async function getSeedTitles(sourceId: string | null, limit = 5): Promise<string[]> {
  const sql = sourceId
    ? "select title from documents where source_id = $1::uuid and title is not null and length(title) > 8"
    : "select title from documents where title is not null and length(title) > 8";
  const params = sourceId ? [sourceId] : [];
  // 优先英文标题(含 ≥3 个连续拉丁字母)
  const en = await pool.query(`${sql} and title ~ '[A-Za-z]{3,}' order by updated_at desc limit $${params.length + 1}`, [...params, limit]);
  if (en.rows.length > 0) return en.rows.map((x) => x.title);
  const r = await pool.query(`${sql} order by updated_at desc limit $${params.length + 1}`, [...params, limit]);
  return r.rows.map((x) => x.title);
}

/** 单篇种子文献 → OpenAlex 引用它的新文献(按引用数/时间排序)
 *  回退: 种子不在 OpenAlex 索引(如知网论文) → 按标题关键词搜索近 5 年高被引文献 */
export async function findCitingWorks(title: string, maxResults = 10): Promise<NewPaperCandidate[]> {
  try {
    // 1) 找种子文献的 OpenAlex ID
    const searchUrl = `https://api.openalex.org/works?filter=title.search:${encodeURIComponent(title.slice(0, 80))}&per-page=3&select=id,title,doi,publication_year,cited_by_count`;
    const sr = await fetch(searchUrl, { signal: (AbortSignal as any).timeout(15_000) });
    if (!sr.ok) return [];
    const sj = await sr.json() as { results?: Array<{ id: string; title: string; doi?: string; publication_year?: number; cited_by_count?: number }> };
    const seed = (sj.results || []).find((w) => w.title && title.toLowerCase().includes(w.title.toLowerCase().slice(0, 30)));

    // 2) 查引用该种子的新文献(近 5 年)
    if (seed) {
      const seedId = seed.id.split("/").pop();
      const citeUrl = `https://api.openalex.org/works?filter=cites:${seedId},from_publication_date:${new Date().getFullYear() - 5}-01-01&per-page=${maxResults}&sort=cited_by_count:desc&select=id,title,doi,publication_year,cited_by_count,abstract_inverted_index,authorships`;
      const cr = await fetch(citeUrl, { signal: (AbortSignal as any).timeout(20_000) });
      if (cr.ok) {
        const cj = await cr.json() as { results?: Array<any> };
        const hits = (cj.results || []).map(mapWork).filter((w: NewPaperCandidate) => w.title);
        if (hits.length > 0) return hits;
      }
    }

    // 3) 回退: 种子不在 OpenAlex(知网等) → 用标题关键词搜索近 5 年高被引(去除种子本身)
    //    ⚠ 中文标题保留中文字符(只去标点/分隔符/引号/下划线), 否则关键词为空
    const keywords = title.replace(/[_\-：:、（）()【】《》“”"'.,;!?\[\]\s]+/g, " ").trim().split(/\s+/).slice(0, 4).join(" ");
    if (!keywords || keywords.length < 2) return [];
    const fbUrl = `https://api.openalex.org/works?filter=title.search:${encodeURIComponent(keywords)},from_publication_date:${new Date().getFullYear() - 5}-01-01&per-page=${maxResults}&sort=cited_by_count:desc&select=id,title,doi,publication_year,cited_by_count,abstract_inverted_index,authorships`;
    const fr = await fetch(fbUrl, { signal: (AbortSignal as any).timeout(20_000) });
    if (!fr.ok) return [];
    const fj = await fr.json() as { results?: Array<any> };
    return (fj.results || [])
      .map(mapWork)
      .filter((w: NewPaperCandidate) => w.title && !title.toLowerCase().includes(w.title.toLowerCase().slice(0, 30)));
  } catch { return []; }
}

/** OpenAlex work → 候选 */
function mapWork(w: any): NewPaperCandidate {
  return {
    title: String(w.title || ""),
    authors: Array.isArray(w.authorships) ? w.authorships.map((a: any) => a.author?.display_name || "").filter(Boolean) : [],
    year: w.publication_year ? Number(w.publication_year) : undefined,
    doi: w.doi ? String(w.doi).replace("https://doi.org/", "") : undefined,
    url: w.doi ? String(w.doi) : undefined,
    citedByCount: w.cited_by_count ? Number(w.cited_by_count) : undefined,
    abstract: w.abstract_inverted_index ? invertAbstract(w.abstract_inverted_index).slice(0, 500) : undefined,
  };
}

/** OpenAlex 倒排索引摘要 → 文本 */
function invertAbstract(inv: Record<string, number[]>): string {
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const pos of positions) words.push([pos, word]);
  }
  return words.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(" ");
}

/** 多篇种子合并去重, 返回候选 */
export async function discoverNewPapers(sourceId: string | null, maxSeeds = 3, maxPerSeed = 6): Promise<NewPaperCandidate[]> {
  const seeds = await getSeedTitles(sourceId, maxSeeds);
  const seen = new Set<string>();
  const out: NewPaperCandidate[] = [];
  for (const title of seeds) {
    const hits = await findCitingWorks(title, maxPerSeed);
    for (const h of hits) {
      const key = h.title.toLowerCase().replace(/\s+/g, "");
      if (seen.has(key) || h.title.length < 15) continue;
      seen.add(key);
      out.push(h);
    }
    if (out.length >= 15) break;
  }
  return out.slice(0, 15);
}

export const citationDiscoveryService = { getSeedTitles, findCitingWorks, discoverNewPapers };
