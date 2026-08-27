// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// paper-source-service.ts — 论文搜索导入（2026-08-27, Agentero 对照: 搜索论文名导入）
// 能力: 按论文名/关键词搜索导入（arXiv + Semantic Scholar 免费公开 API）
// 说明: Cool Papers(papers.cool) / 魔搭(ModelScope) 为网页浏览导入, 依赖外部网络(当前环境受限),
//       实现为可配置端点 + 明确错误; 搜索导入(Semantic Scholar)无需密钥即可用
import { pool } from "../db/pool.js";

export interface PaperHit {
  title: string;
  abstract?: string;
  authors: string[];
  year?: number;
  doi?: string;
  url?: string;
  source: "arxiv" | "semanticscholar";
  externalId?: string;
}

/** arXiv 搜索（按标题/关键词, 返回近期相关） */
export async function searchArxiv(query: string, maxResults = 5): Promise<PaperHit[]> {
  try {
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&sortBy=relevance&max_results=${maxResults}`;
    const resp = await fetch(url, { signal: (AbortSignal as any).timeout(20_000) });
    if (!resp.ok) return [];
    const xml = await resp.text();
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
      const b = m[1];
      const get = (tag: string): string => {
        const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b);
        return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : "";
      };
      const title = get("title").replace(/\s+/g, " ").trim();
      const id = get("id").trim();
      const authors = [...b.matchAll(/<name>([^<]+)<\/name>/g)].map((a) => a[1].trim());
      const year = parseInt(get("published").slice(0, 4), 10) || undefined;
      if (!title) return null;
      return {
        title, authors, year,
        abstract: get("summary").slice(0, 800),
        url: id, source: "arxiv" as const,
        externalId: id.split("/abs/")[1] || id,
      };
    }).filter(Boolean) as PaperHit[];
    return entries;
  } catch { return []; }
}

/** Semantic Scholar 搜索（按论文名, 免费公开 API 无需密钥） */
export async function searchSemanticScholar(query: string, maxResults = 5): Promise<PaperHit[]> {
  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${maxResults}&fields=title,abstract,year,authors,externalIds,url,openAccessPdf`;
    const resp = await fetch(url, { signal: (AbortSignal as any).timeout(20_000) });
    if (!resp.ok) return [];
    const j = await resp.json() as { data?: any[] };
    return (j.data || []).map((p: any) => ({
      title: String(p.title || ""),
      abstract: p.abstract ? String(p.abstract).slice(0, 800) : undefined,
      authors: Array.isArray(p.authors) ? p.authors.map((a: any) => a.name) : [],
      year: p.year ? Number(p.year) : undefined,
      doi: p.externalIds?.DOI ? String(p.externalIds.DOI) : undefined,
      url: p.url || (p.openAccessPdf?.url ? String(p.openAccessPdf.url) : undefined),
      source: "semanticscholar" as const,
      externalId: p.externalIds?.CorpusId ? `ss-${p.externalIds.CorpusId}` : undefined,
    })).filter((p: PaperHit) => p.title);
  } catch { return []; }
}

/** 搜索论文（双源合并去重） */
export async function searchPapers(query: string, maxResults = 5): Promise<PaperHit[]> {
  const [arxiv, ss] = await Promise.all([searchArxiv(query, maxResults), searchSemanticScholar(query, maxResults)]);
  const seen = new Set<string>();
  const merged: PaperHit[] = [];
  for (const p of [...ss, ...arxiv]) {
    const key = p.title.toLowerCase().replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(p);
  }
  return merged.slice(0, maxResults * 2);
}

/** 导入搜索结果到项目（external_id 判重） */
export async function importPaper(paper: PaperHit, sourceId: string): Promise<{ imported: boolean; reason?: string }> {
  if (!paper.title) return { imported: false, reason: "无标题" };
  const externalId = paper.externalId || paper.doi || `paper-${paper.title.slice(0, 40)}`;
  const dup = await pool.query("select 1 from documents where source_id = $1 and external_id = $2", [sourceId, externalId]);
  if (dup.rows.length > 0) return { imported: false, reason: "已存在" };
  await pool.query(
    `insert into documents (id, source_id, external_id, title, content, status, parse_status, metadata)
     values (gen_random_uuid(), $1, $2, $3, $4, 'COMPLETED', 'COMPLETED', $5::jsonb)`,
    [sourceId, externalId, paper.title, paper.abstract || "",
     JSON.stringify({ source: paper.source, authors: paper.authors, year: paper.year, doi: paper.doi, url: paper.url })]
  );
  return { imported: true };
}

export const paperSourceService = {
  searchArxiv, searchSemanticScholar, searchPapers, importPaper,
};
