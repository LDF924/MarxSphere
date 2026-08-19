// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ingest-monitor-service.ts — 图库入库监控（V406）
// Graphiti/Cognee 入库进度实时监控：
//   左侧队列 = 库中文档（按入库步骤完成度打标）+ paper_id_map 中未入库文档（排队）
//   右侧详情 = 概览/切片/超边(事件)/实体/检索（各引擎结合自身入库步骤与节点 schema）
// 全部只读查询，复用 neo4j-query 参数化工具（中文安全）
import { neo4jQuery } from "../db/neo4j-query.js";
import { readFileSync } from "node:fs";

const PORTS = { graphiti: 11001, cognee: 11003 } as const;
export type Engine = keyof typeof PORTS;
const MAP_PATH = process.env.SAG_ROOT ? `${process.env.SAG_ROOT}/paper_id_map.json` : "paper_id_map.json";

const num = (v: unknown): number =>
  typeof v === "object" && v !== null ? Number((v as { low: number }).low ?? 0) : Number(v ?? 0);

// ═══ paper_id_map.json 论文标题集合（用于识别「排队中未入库」文档） ═══
let mapTitlesCache: string[] | null = null;
function mapTitles(): string[] {
  if (mapTitlesCache) return mapTitlesCache;
  try {
    const raw = JSON.parse(readFileSync(MAP_PATH, "utf-8"));
    const titles = new Set<string>();
    for (const v of Object.values(raw)) {
      const t = (v as { title?: string })?.title;
      if (t) titles.add(t);
    }
    mapTitlesCache = [...titles];
  } catch { mapTitlesCache = []; }
  return mapTitlesCache;
}

// TextDocument.name 是 URL 编码的文件名（如 %E8%B5%84%E6%9C%AC…__.original）→ 还原为论文名
function decodeDocName(name: string): string {
  try { name = decodeURIComponent(name); } catch { /* 保持原样 */ }
  return name.replace(/\.original(\.md)?$/, "").trim();
}

// Neo4j 时间字段两种形态：Graphiti=DateTime(ISO)，Cognee=EpochMillis(数字) → 统一显示串
function fmtTime(v: string | number | null | undefined): string {
  if (v == null) return "";
  if (typeof v === "number") {
    const d = new Date(v > 1e12 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  const s = String(v);
  if (/^\d+$/.test(s)) {
    const d = new Date(Number(s) > 1e12 ? Number(s) : Number(s) * 1000);
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  }
  return s;
}

// ═══ Graphiti 概览：Episode 列表 + 各步骤按文档聚合计数 ═══
async function graphitiOverview() {
  const [episodes, chunkAgg, entAgg, distAgg, heAgg] = await Promise.all([
    neo4jQuery<{ f: string; title: string; author: string; docType: string; createdAt: string }>(
      11001, `MATCH (e:Episode) RETURN e.source_folder AS f, e.title AS title, e.author AS author,
              e.doc_type AS docType, toString(e.created_at) AS createdAt`, {}, 20000),
    neo4jQuery<{ f: string; n: number }>(11001,
      `MATCH (c:Chunk)-[:CHUNK_OF]->(e:Episode) RETURN e.source_folder AS f, count(c) AS n`, {}, 20000),
    neo4jQuery<{ f: string; n: number }>(11001,
      `MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) RETURN ep.source_folder AS f, count(e) AS n`, {}, 20000),
    neo4jQuery<{ f: string; n: number }>(11001,
      `MATCH (d:LiteratureDistill)-[:DISTILL_FROM]->(e:Episode) RETURN e.source_folder AS f, count(d) AS n`, {}, 20000),
    neo4jQuery<{ f: string; n: number }>(11001,
      `MATCH (h:HyperEdge)-[:FROM_EPISODE]->(e:Episode) RETURN e.source_folder AS f, count(h) AS n`, {}, 20000),
  ]);

  const chunkBy = new Map(chunkAgg.map((r) => [r.f, num(r.n)]));
  const entBy = new Map(entAgg.map((r) => [r.f, num(r.n)]));
  const distBy = new Map(distAgg.map((r) => [r.f, num(r.n)]));
  const heBy = new Map(heAgg.map((r) => [r.f, num(r.n)]));

  const inGraph = new Set(episodes.map((e) => e.f));
  const queue = episodes.map((e) => {
    const chunks = chunkBy.get(e.f) ?? 0;
    const entities = entBy.get(e.f) ?? 0;
    const distills = distBy.get(e.f) ?? 0;
    const hyperedges = heBy.get(e.f) ?? 0;
    return {
      name: e.f, title: e.title || e.f, author: e.author || "", docType: e.docType || "",
      createdAt: fmtTime(e.createdAt),
      stages: {
        chunk: chunks > 0,        // Step1: 语义切块（CHUNK_OF）
        extract: entities > 0,    // Step2: 实体抽取（EXTRACTED_FROM）
        distill: distills > 0,    // Step3: 五层蒸馏（DISTILL_FROM）
        hyperedge: hyperedges > 0 // Step4: 超边抽取（FROM_EPISODE）
      },
      counts: { chunks, entities, distills, hyperedges },
      pending: false,
    };
  });

  // 排队中：map 有、图库无（等 orchestrate 扫描入库）
  const pending = mapTitles()
    .filter((t) => !inGraph.has(t) && t)
    .map((t) => ({
      name: t, title: t, author: "", docType: "",
      createdAt: "",
      stages: { chunk: false, extract: false, distill: false, hyperedge: false },
      counts: { chunks: 0, entities: 0, distills: 0, hyperedges: 0 },
      pending: true,
    }));

  return {
    engine: "graphiti",
    stats: {
      docs: episodes.length,
      chunks: [...chunkBy.values()].reduce((a, b) => a + b, 0),
      entities: [...entBy.values()].reduce((a, b) => a + b, 0),
      distills: [...distBy.values()].reduce((a, b) => a + b, 0),
      hyperedges: [...heBy.values()].reduce((a, b) => a + b, 0),
      pending: pending.length,
    },
    queue: [...queue, ...pending].sort((a, b) => (a.pending === b.pending ? 0 : a.pending ? 1 : -1)),
    stages: ["chunk", "extract", "distill", "hyperedge"],
    stageLabels: { chunk: "切片", extract: "实体", distill: "蒸馏", hyperedge: "超边" },
  };
}

// ═══ Cognee 概览：TextDocument 列表（按解码名去重）+ 切片/摘要聚合 ═══
async function cogneeOverview() {
  const [docs, chunkAgg] = await Promise.all([
    neo4jQuery<{ name: string; createdAt: string }>(11003,
      `MATCH (d:TextDocument) RETURN d.name AS name, toString(d.created_at) AS createdAt`, {}, 25000),
    neo4jQuery<{ f: string; n: number }>(11003,
      `MATCH (c:DocumentChunk)-[:is_part_of]->(d:TextDocument) RETURN d.name AS f, count(c) AS n`, {}, 25000),
  ]);
  // 按解码名合并（cognify 多次运行会产生同名 TextDocument）
  const chunkByRaw = new Map(chunkAgg.map((r) => [r.f, num(r.n)]));
  const byDoc = new Map<string, { chunks: number; createdAt: string }>();
  for (const d of docs) {
    const key = decodeDocName(d.name);
    if (!key) continue;
    const cur = byDoc.get(key) ?? { chunks: 0, createdAt: "" };
    cur.chunks += chunkByRaw.get(d.name) ?? 0;
    if (!cur.createdAt) cur.createdAt = fmtTime(d.createdAt);
    byDoc.set(key, cur);
  }
  const sumAgg = neo4jQuery<{ n: number }>(11003, `MATCH (t:TextSummary) RETURN count(t) AS n`, {}, 20000);

  const inGraph = new Set(byDoc.keys());
  const queue = [...byDoc.entries()].map(([name, v]) => ({
    name, title: name, author: "", docType: "",
    createdAt: v.createdAt,
    stages: { chunk: v.chunks > 0, summary: false }, // summary 按文档需查 chunk id，留到详情
    counts: { chunks: v.chunks, summaries: 0 },
    pending: false,
  }));
  const pending = mapTitles()
    .filter((t) => {
      if (inGraph.has(t)) return false;
      // 宽松匹配：解码名可能带后缀差异（如 …__）
      return ![...inGraph].some((g) => g.startsWith(t) || t.startsWith(g));
    })
    .filter(Boolean)
    .map((t) => ({
      name: t, title: t, author: "", docType: "",
      createdAt: "",
      stages: { chunk: false, summary: false },
      counts: { chunks: 0, summaries: 0 },
      pending: true,
    }));

  const totalSummaries = num((await sumAgg)[0]?.n ?? 0);
  return {
    engine: "cognee",
    stats: {
      docs: byDoc.size,
      chunks: [...byDoc.values()].reduce((a, v) => a + v.chunks, 0),
      entities: 0, // 全局实体数由 /api/neo4j/stats 提供，这里保持步骤口径
      summaries: totalSummaries,
      pending: pending.length,
    },
    queue: [...queue, ...pending].sort((a, b) => (a.pending === b.pending ? 0 : a.pending ? 1 : -1)),
    stages: ["chunk", "summary"],
    stageLabels: { chunk: "分块", summary: "摘要" },
  };
}

export async function overview(engine: Engine): Promise<Record<string, unknown>> {
  return engine === "cognee" ? cogneeOverview() : graphitiOverview();
}

// ═══ 文档详情（右侧标签页数据源） ═══
export async function docDetail(engine: Engine, name: string): Promise<Record<string, unknown>> {
  if (!name) return { ok: false, error: "文档名为空" };
  if (engine === "cognee") return cogneeDocDetail(name);
  return graphitiDocDetail(name);
}

// 数组/任意值 → 截断字符串（Cypher toString() 不接受 StringArray，统一在 JS 端转换）
const clip = (v: unknown, n: number): string => {
  if (v == null) return "";
  const s = Array.isArray(v) ? v.join("；") : String(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
};

async function graphitiDocDetail(folder: string) {
  const [chunks, entities, distills, hyperedges] = await Promise.all([
    neo4jQuery<{ idx: number; type: string; text: unknown; file: string }>(
      11001,
      `MATCH (e:Episode {source_folder: $f})<-[:CHUNK_OF]-(c:Chunk)
       RETURN c.chunk_index AS idx, c.chunk_type AS type, c.text AS text, c.source_file AS file
       ORDER BY c.chunk_index LIMIT 60`, { f: folder }, 25000),
    neo4jQuery<{ name: string; category: string; desc: unknown }>(
      11001,
      `MATCH (e:Episode {source_folder: $f})<-[:EXTRACTED_FROM]-(ent:Entity)
       RETURN ent.name AS name, ent.category AS category, ent.description AS desc
       ORDER BY ent.name LIMIT 60`, { f: folder }, 25000),
    neo4jQuery<{ id: string; core: unknown; paradigm: unknown }>(
      11001,
      `MATCH (e:Episode {source_folder: $f})<-[:DISTILL_FROM]-(d:LiteratureDistill)
       RETURN d.id AS id, d.core_concept_definition AS core,
              d.analysis_paradigm_and_interpretation AS paradigm LIMIT 5`, { f: folder }, 25000),
    neo4jQuery<{ summary: unknown; claims: unknown; confidence: number; type: string }>(
      11001,
      `MATCH (e:Episode {source_folder: $f})<-[:FROM_EPISODE]-(h:HyperEdge)
       RETURN h.summary AS summary, h.claims AS claims,
              h.confidence AS confidence, h.type AS type ORDER BY h.created_at DESC LIMIT 20`, { f: folder }, 25000),
  ]);
  return {
    ok: true, engine: "graphiti", name: folder,
    chunks: chunks.map((c) => ({ idx: num(c.idx), type: c.type, text: clip(c.text, 400), file: c.file })),
    entities: entities.map((e) => ({ name: e.name, category: e.category, description: clip(e.desc, 300) })),
    distills: distills.map((d) => ({ id: d.id, core: clip(d.core, 400), paradigm: clip(d.paradigm, 300) })),
    hyperedges: hyperedges.map((h) => ({ summary: clip(h.summary, 300), claims: clip(h.claims, 300), confidence: h.confidence, type: h.type })),
  };
}

async function cogneeDocDetail(rawName: string) {
  const name = decodeDocName(rawName);
  // 同名 TextDocument 可能多个（多次运行）→ 取全部切片并合并
  const chunks = await neo4jQuery<{ idx: number; text: unknown; id: string }>(
    11003,
    `MATCH (d:TextDocument) WHERE d.name CONTAINS $n
     MATCH (d)<-[:is_part_of]-(c:DocumentChunk)
     RETURN c.chunk_index AS idx, c.text AS text, c.id AS id
     ORDER BY c.chunk_index LIMIT 60`, { n: encodeURIComponent(name) }, 25000);
  const chunkIds = chunks.map((c) => c.id).filter(Boolean);
  let summaries: Array<{ text: unknown }> = [];
  if (chunkIds.length > 0) {
    summaries = await neo4jQuery<{ text: unknown }>(
      11003,
      `MATCH (t:TextSummary) WHERE t.source_chunk_id IN $ids
       RETURN t.text AS text LIMIT 10`, { ids: chunkIds }, 20000);
  }
  return {
    ok: true, engine: "cognee", name,
    chunks: chunks.map((c) => ({ idx: num(c.idx), text: clip(c.text, 400) })),
    summaries: summaries.map((t) => ({ text: clip(t.text, 400) })),
    entities: [], // Cognee Entity 无文档归属（全局概念图谱），检索页可搜
  };
}

// ═══ 检索（实体名 / 切片文本） ═══
export async function search(engine: Engine, query: string, docName?: string): Promise<Record<string, unknown>> {
  const q = (query || "").trim().slice(0, 60);
  if (!q) return { ok: false, error: "搜索词为空" };
  if (engine === "cognee") {
    const [entities, chunks] = await Promise.all([
      neo4jQuery<{ name: string; description: unknown }>(
        11003, `MATCH (e:Entity) WHERE e.name CONTAINS $q
                RETURN e.name AS name, e.description AS description LIMIT 15`,
        { q }, 20000),
      neo4jQuery<{ name: string; text: unknown }>(
        11003, `MATCH (c:DocumentChunk) WHERE c.text CONTAINS $q
                RETURN c.name AS name, c.text AS text LIMIT 8`,
        { q }, 25000),
    ]);
    return {
      ok: true, engine: "cognee", query: q,
      nodes: [
        ...entities.map((e) => ({ name: e.name, type: "实体", snippet: clip(e.description, 200) })),
        ...chunks.map((c) => ({ name: c.name, type: "切片", snippet: clip(c.text, 200) })),
      ],
    };
  }
  // Graphiti：可选限定文档（source_folder）
  const where = docName ? `WHERE e.source_folder = $f AND e.name CONTAINS $q` : `WHERE e.name CONTAINS $q`;
  const nodes = await neo4jQuery<{ name: string; category: string; folder: string }>(
    11001,
    `MATCH (e:Entity) ${where} RETURN e.name AS name, e.category AS category, e.source_folder AS folder
     ORDER BY e.name LIMIT 20`,
    docName ? { q, f: docName } : { q }, 20000);
  return {
    ok: true, engine: "graphiti", query: q,
    nodes: nodes.map((e) => ({ name: e.name, type: e.category || "实体", snippet: e.folder || "" })),
  };
}

export const ingestMonitorService = { overview, docDetail, search };
