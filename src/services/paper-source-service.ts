// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// paper-source-service.ts — 论文搜索导入（2026-08-27, Agentero 对照: 搜索论文名导入）
// 能力: 按论文名/关键词搜索导入（arXiv + Semantic Scholar 免费公开 API）
// 2026-08-29 扩展: Cool Papers(papers.cool) / 魔搭(ModelScope) 文献导入
//   Cool Papers: /arxiv/<topic>/feed Atom RSS(arXiv 每日精选, 含 arXiv ID/标题/作者/日期)
//   魔搭 ModelScope: 站点可达性检测 + 链接导入(markdown 格式 papers 页面)
import { pool } from "../db/pool.js";

export interface PaperHit {
  title: string;
  abstract?: string;
  authors: string[];
  year?: number;
  doi?: string;
  url?: string;
  source: "arxiv" | "semanticscholar" | "coolpapers" | "modelscope";
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

/** 常见 arXiv 主题映射（Cool Papers 分类 → 展示名） */
const COOLPAPERS_TOPICS: Record<string, string> = {
  "cs.AI": "人工智能", "cs.CL": "计算语言学", "cs.CV": "计算机视觉", "cs.LG": "机器学习",
  "cs.MA": "多智能体", "cs.IR": "信息检索", "cs.CR": "安全与加密", "cs.SE": "软件工程",
  "cs.NE": "神经与进化计算", "cs.RO": "机器人学", "cs.DB": "数据库", "cs.GT": "博弈论",
  "math.OC": "优化与控制", "stat.ML": "统计学习", "econ.GN": "经济学",
};

export function coolPapersTopics(): Array<{ id: string; name: string }> {
  return Object.entries(COOLPAPERS_TOPICS).map(([id, name]) => ({ id, name }));
}

/**
 * Cool Papers 每日精选导入（2026-08-29, Agentero 对照: 软件内浏览 Cool Papers 并导入文献）
 * 通过 /arxiv/<topic>/feed 的 Atom RSS 获取 arXiv 精选文章
 */
export async function fetchCoolPapers(topic = "cs.AI", maxResults = 20): Promise<PaperHit[]> {
  try {
    const url = `https://papers.cool/arxiv/${topic}/feed`;
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
      const link = get("link") || get("id");
      const idMatch = link.match(/(\d{4}\.\d{4,5})/) || b.match(/(\d{4}\.\d{4,5})/);
      const arxivId = idMatch ? idMatch[1] : "";
      const authors = [...b.matchAll(/<author>[\s\S]*?<name>([^<]+)<\/name>/g)].map((a) => a[1].trim());
      const pubDate = get("published") || get("updated");
      const year = pubDate ? parseInt(pubDate.slice(0, 4), 10) : undefined;
      if (!title) return null;
      return {
        title, authors, year,
        url: arxivId ? `https://arxiv.org/abs/${arxivId}` : link,
        source: "coolpapers" as const,
        externalId: arxivId || undefined,
      };
    }).filter(Boolean) as PaperHit[];
    return entries.slice(0, Math.max(1, maxResults));
  } catch { return []; }
}

/** 魔搭 ModelScope 站点可达性检测 */
export async function modelscopeReachable(): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch("https://modelscope.cn/", { signal: (AbortSignal as any).timeout(10_000) });
    return { ok: resp.ok };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 80) };
  }
}

/** 魔搭链接导入: 从 ModelScope 论文链接解析标题/作者(页面抓取, 失败回退保留链接) */
export async function fetchModelScopeLink(url: string): Promise<PaperHit | null> {
  try {
    const resp = await fetch(url, { signal: (AbortSignal as any).timeout(15_000) });
    if (!resp.ok) return null;
    const html = await resp.text();
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (!title) return null;
    return {
      title, authors: [], url,
      source: "modelscope" as const,
      externalId: `ms-${url.replace(/[^a-zA-Z0-9]/g, "").slice(0, 60)}`,
    };
  } catch { return null; }
}

/** 导入搜索结果到项目（external_id 判重）— paper 参数兼容 API 传入的部分字段 */
export async function importPaper(paper: {
  title: string; abstract?: string; authors?: string[]; year?: number;
  doi?: string; url?: string; source?: string; externalId?: string;
}, sourceId: string): Promise<{ imported: boolean; reason?: string }> {
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

/** arXiv / alphaXiv 链接解析（2026-08-29, Agentero 对照: 快速跳转对应 arXiv、alphaXiv 链接）
 *  从 arXiv ID / DOI / 标题 推断可跳转链接 */
export function resolvePaperLinks(input: { arxivId?: string; doi?: string; title?: string }): {
  arxiv?: string; alphaXiv?: string; doiUrl?: string; semanticScholar?: string;
} {
  const links: { arxiv?: string; alphaXiv?: string; doiUrl?: string; semanticScholar?: string } = {};
  const id = (input.arxivId || "").trim();
  // arXiv ID 格式: 2301.12345 或 2301.12345v2
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(id)) {
    const cleanId = id.replace(/^v\d+$/, "");
    links.arxiv = `https://arxiv.org/abs/${id}`;
    links.alphaXiv = `https://www.alphaxiv.org/abs/${id}`;
  } else if (input.doi) {
    const doi = input.doi.replace(/^doi:\s*/i, "").trim();
    links.doiUrl = `https://doi.org/${encodeURIComponent(doi)}`;
  } else if (input.title) {
    links.semanticScholar = `https://www.semanticscholar.org/search?q=${encodeURIComponent(input.title.slice(0, 100))}`;
  }
  return links;
}

export const paperSourceService = {
  searchArxiv, searchSemanticScholar, searchPapers, importPaper,
  fetchCoolPapers, coolPapersTopics, modelscopeReachable, fetchModelScopeLink,
  resolvePaperLinks,
};
