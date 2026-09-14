// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// research-literature-retrieval.ts — V417: 写作舱文献检索接真源
//
// 由来（2026-09-14 实测"研途写作舱"）：
//   原 runLiteratureSearch 只让 LLM 编检索词就写素材，内容是"检索词列表 + (实际检索需接知识库/CNKI)"
//   —— 从没碰过任何库。而下游的 buildCitationPool / buildMergedReferences 靠正则
//   `^\s*\[(\d+)\]\s*(.+)$` 从素材里抠条目 —— 于是参考文献恒为空，
//   正文里 25 处 `[N]（待补引文）` 谁也不认。
//
// 本模块把"检索词"变成"真实条目"，来源按优先级：
//   1. pg     — PG 向量库 (source_chunks/documents)，按项目绑定的 source_ids 检索
//   2. mdlibrary — 本地 md 文献库 (literature-service)，唯一带 authors/year 著录的源
//   3. graphiti / cognee — Neo4j 图谱臂，按需经 MCP 池
//
// 诚实原则：搜不到就是搜不到 —— 条目为空时返回空数组，由调用方在导出里标注"需人工补录"，
// 绝不用 LLM 编造文献（那是学术不端）。

import { pool } from "../db/pool.js";

export type RetrievalSourceName = "pg" | "graphiti" | "cognee" | "mdlibrary";

/** 检索命中（各源归一化）。著录字段缺失就是缺失，不做假。 */
export interface LiteratureHit {
  title: string;
  /** 有则填，无则空串 —— 导出时按"著录不全"标注 */
  authors: string;
  year: string;
  /** 正文片段/摘要，用于让模型判断该引什么 */
  excerpt: string;
  source: RetrievalSourceName;
  /** 原始定位（sourceId/documentId 等），便于回溯 */
  ref?: string;
}

/** 默认公共库（与 server.ts DEFAULT_SOURCE 一致：本机"资本下乡"库） */
const DEFAULT_SOURCE = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";

/**
 * PG 标题里常带作者，形如 `“合伙人”制度：资本下乡的路径创新及其实践绩效_李玉霞`。
 * 这是本平台入库时的命名约定（实测 504 篇均为此格式），不是我们造的 —— 拆出来当著录用。
 */
export function splitTitleAuthor(rawTitle: string): { title: string; authors: string } {
  const t = String(rawTitle ?? "").trim();
  const m = /^(.+?)[_—\-]{1,2}([一-龥·、A-Za-z.\s]{2,40})$/.exec(t);
  if (!m) return { title: t, authors: "" };
  const [, title, authors] = m;
  // 右侧必须像个姓名列表（中文名/顿号分隔/西文），否则不拆 —— 避免把"资本下乡_2023"当作者
  if (!/[一-龥A-Za-z]/.test(authors) || /\d{3,}/.test(authors)) return { title: t, authors: "" };
  return { title: title.trim(), authors: authors.trim() };
}

/** 从标题/正文里抠 4 位年份（2015-2030 区间），抠不到就空 */
export function extractYear(text: string): string {
  const m = /(19[89]\d|20[0-4]\d)/.exec(String(text ?? ""));
  if (!m) return "";
  const y = Number(m[1]);
  return y >= 1980 && y <= 2049 ? String(y) : "";
}

/** 读取项目绑定的检索源；空数组 → 默认公共库 */
export async function resolveProjectSourceIds(projectId: string): Promise<string[]> {
  try {
    const r = await pool.query(`select source_ids from research_projects where id=$1`, [projectId]);
    const ids = (r.rows[0]?.source_ids ?? []) as string[];
    return ids.length ? ids : [DEFAULT_SOURCE];
  } catch {
    return [DEFAULT_SOURCE];
  }
}

/**
 * PG 向量库检索。
 *
 * 直接连 source_chunks → documents 取 **document 级标题**，不走 searchService.vectorSearch ——
 * 实测后者返回的是 chunk 的 `heading`（"一、引言"/"（二）资本下乡的基本内涵" 这类章节小标题），
 * 拿它当参考文献标题是错的；而且 chunk 上没有任何著录字段。
 * documents.title 才是入库时的论文名（本机实测形如 `资本下乡的路径创新及其实践绩效_李玉霞`）。
 *
 * 每个文档只保留得分最高的一片当摘要片段，避免一本论文集里同一篇刷满结果。
 */
async function searchPg(query: string, sourceIds: string[], topK: number): Promise<LiteratureHit[]> {
  try {
    const { embeddingClient } = await import("../ai/embedding-client.js");
    const { pool: db } = await import("../db/pool.js");
    const vec = await embeddingClient.generate(query);
    // 召回放大到 topK*4：多篇文档被同一篇挤占时有货可换
    const r = await db.query(
      `with hits as (
         select c.document_id,
                c.content,
                1 - (c.embedding <=> $2::vector) as score,
                row_number() over (partition by c.document_id order by c.embedding <=> $2::vector) as rn
           from source_chunks c
          where c.source_id = any($1::uuid[]) and c.embedding is not null
          order by c.embedding <=> $2::vector
          limit $3
       )
       select d.title, h.content, h.score
         from hits h join documents d on d.id = h.document_id
        where h.rn = 1
        order by h.score desc
        limit $4`,
      [sourceIds, JSON.stringify(vec), Math.max(topK * 4, 20), topK]
    );
    return (r.rows as Array<{ title: string; content: string; score: number }>)
      .map((row) => {
        const { title, authors } = splitTitleAuthor(String(row.title ?? ""));
        return {
          title: title || "(无标题)",
          authors,
          year: extractYear(String(row.title ?? "")) || extractYear(String(row.content ?? "").slice(0, 500)),
          excerpt: String(row.content ?? "").replace(/\s+/g, " ").slice(0, 400),
          source: "pg" as const,
        };
      })
      .filter((h) => h.title && h.title !== "(无标题)");
  } catch (e) {
    console.warn(`[literature-retrieval] pg 臂失败: ${String(e).slice(0, 160)}`);
    return [];
  }
}

/** 本地 md 文献库检索：唯一带 authors/year 著录的源 */
async function searchMdLibrary(query: string, topK: number): Promise<LiteratureHit[]> {
  try {
    const { literatureService } = await import("./literature-service.js");
    const keyword = String(query ?? "").trim().slice(0, 40);
    if (!keyword) return [];
    const r = literatureService.list({ keyword, page: 1, pageSize: topK });
    const hits: LiteratureHit[] = [];
    for (const it of r.items ?? []) {
      const title = String(it.paperTitle || it.title || "").trim();
      if (!title) continue;
      hits.push({
        title,
        authors: Array.isArray(it.authors) ? it.authors.join("、") : String(it.authors ?? ""),
        year: String(it.year ?? ""),
        excerpt: String(it.topic ?? ""),
        source: "mdlibrary",
        ref: it.id,
      });
      if (hits.length >= topK) break;
    }
    return hits;
  } catch {
    return [];
  }
}

/** Neo4j 图谱臂（Graphiti 实体 / Cognee 切片）。池没就绪就跳过 —— 预览模式无池是常态。 */
async function searchGraph(query: string, topK: number): Promise<LiteratureHit[]> {
  const out: LiteratureHit[] = [];
  try {
    const { getGraphitiPool, getCogneePool } = await import("../api/reason-handler.js");
    const gPool = getGraphitiPool();
    if (gPool?.isReady?.()) {
      const raw = await gPool.callTool("hybrid_search_entities", {
        query, top_k: topK, enable_rewrite: true, enable_rerank: true,
      }).catch(() => null);
      for (const e of parseGraphitiEntities(raw).slice(0, topK)) {
        out.push({ title: e.name, authors: "", year: extractYear(e.description), excerpt: e.description, source: "graphiti" });
      }
    }
    const cPool = getCogneePool();
    if (cPool?.isReady?.() && out.length < topK) {
      const raw = await cPool.callTool("cognee_search", {
        query, search_type: "HYBRID_COMPLETION", top_k: topK, datasets: "capital_v28",
      }).catch(() => null);
      for (const c of parseCogneeSlices(raw).slice(0, topK - out.length)) {
        out.push({
          title: c.slice(0, 60), authors: "", year: extractYear(c),
          excerpt: c.replace(/\s+/g, " ").slice(0, 400), source: "cognee",
        });
      }
    }
  } catch { /* 池不可用/超时都不阻断主链 */ }
  return out;
}

/** Graphiti hybrid_search_entities 结果解析（与 search-service 的同名私有实现语义一致） */
export function parseGraphitiEntities(raw: unknown): Array<{ name: string; description: string }> {
  try {
    const r = raw as { result?: Array<{ text?: string }> };
    const text = r?.result?.[0]?.text;
    if (!text) return [];
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed?.entities) ? parsed.entities : Array.isArray(parsed) ? parsed : [];
    return arr.map((e: Record<string, unknown>) => ({
      name: String(e.name ?? e.title ?? "").trim(),
      description: e.description == null ? "" : String(e.description),
    })).filter((e: { name: string }) => e.name);
  } catch {
    return [];
  }
}

/** Cognee cognee_search 结果解析 */
export function parseCogneeSlices(raw: unknown): string[] {
  try {
    const r = raw as { result?: unknown };
    const arr = Array.isArray(r?.result) ? r.result : [];
    return arr.map((item: unknown) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        return String(o.text ?? o.content ?? "");
      }
      return "";
    }).filter((t) => t.length > 20);
  } catch {
    return [];
  }
}

export interface RetrieveInput {
  projectId: string;
  /** 检索词（章节关键词 / 主题） */
  queries: string[];
  topK?: number;
  /** 关掉某源（默认全开；md 文库/图谱失败自动跳过） */
  disable?: RetrievalSourceName[];
}

export interface RetrieveResult {
  hits: LiteratureHit[];
  /** 实际命中的源（用于素材徽章与"需人工补录"判定） */
  sources: RetrievalSourceName[];
}

/**
 * 多词检索去重合并。多个检索词各跑一轮，按标题去重，保留首次命中的顺序。
 * 全程不调 LLM —— 只做 embedding + 向量召回 + 文件扫描，便于在 job 里同步跑。
 */
export async function retrieveLiterature(input: RetrieveInput): Promise<RetrieveResult> {
  const topK = input.topK ?? 8;
  const disabled = new Set(input.disable ?? []);
  const queries = Array.from(new Set((input.queries ?? []).map((q) => String(q ?? "").trim()).filter(Boolean))).slice(0, 4);
  if (!queries.length) return { hits: [], sources: [] };

  const sourceIds = disabled.has("pg") ? [] : await resolveProjectSourceIds(input.projectId);
  const merged: LiteratureHit[] = [];
  const seen = new Set<string>();
  const push = (hits: LiteratureHit[]) => {
    for (const h of hits) {
      const key = h.title.replace(/\s+/g, "").slice(0, 40);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(h);
      if (merged.length >= topK) return;
    }
  };

  for (const q of queries) {
    if (merged.length >= topK) break;
    if (sourceIds.length) push(await searchPg(q, sourceIds, topK));
    if (merged.length < topK && !disabled.has("mdlibrary")) push(await searchMdLibrary(q, topK));
    if (merged.length < topK && (!disabled.has("graphiti") || !disabled.has("cognee"))) {
      push(await searchGraph(q, topK - merged.length));
    }
  }

  const sources = Array.from(new Set(merged.map((h) => h.source))) as RetrievalSourceName[];
  return { hits: merged.slice(0, topK), sources };
}

/** 单条著录行：[N] 作者. 标题. 年份. —— 缺字段就省略，不编造 */
export function formatReferenceLine(no: number, hit: LiteratureHit): string {
  const parts: string[] = [];
  if (hit.authors) parts.push(`${hit.authors}.`);
  parts.push(`${hit.title}.`);
  if (hit.year) parts.push(`${hit.year}.`);
  return `[${no}] ${parts.join(" ")}`;
}

/** 命中条目 → 素材 content_md（编号清单，供 buildCitationPool/buildMergedReferences 抠取） */
export function buildCitationMaterialBody(hits: LiteratureHit[]): string {
  if (!hits.length) return "";
  // V417: excerpt 此前**只被赋值、零消费**(注释写"用于让模型判断该引什么", 但没人读)。
  // 附在编号行之后(缩进行), 正文生成时模型能据此判断该条与哪一章/哪个论点相关, 而不是
  // 只看标题就盲引。引用池仍以行首 `[N] 著录` 为准 —— 下游正则只认行首, 缩进行不干扰。
  return hits.map((h, i) => {
    const line = formatReferenceLine(i + 1, h);
    const ex = String(h.excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    return ex && ex !== h.title ? `${line}\n    摘要: ${ex}` : line;
  }).join("\n");
}
