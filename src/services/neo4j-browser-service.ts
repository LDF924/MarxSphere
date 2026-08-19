// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// neo4j-browser-service.ts — Neo4j 库直连浏览（V400）
// 安全只读浏览：节点类型统计 / 按类型列节点 / 实体搜索 / 关系图（不暴露任意 Cypher）
// 两个引擎: Graphiti(11001) / Cognee(11003)
import { neo4jQuery } from "../db/neo4j-query.js";

const PORTS = { graphiti: 11001, cognee: 11003 } as const;
export type Neo4jEngine = keyof typeof PORTS;

// ═══ 节点类型统计（浏览首页） ═══
export async function typeStats(engine: Neo4jEngine): Promise<Record<string, unknown>> {
  const port = PORTS[engine];
  const labels = await neo4jQuery<{ label: string; count: number }>(
    port,
    `match (n) unwind labels(n) as label return label, count(*) as count order by count desc limit 20`,
    {}, 20000
  );
  const total = await neo4jQuery<{ n: number }>(port, `match (n) return count(n) as n`, {}, 20000);
  const num = (v: unknown): number => typeof v === "object" && v !== null ? Number((v as { low: number }).low ?? 0) : Number(v ?? 0);
  return { ok: true, engine, total: num(total[0]?.n), labels: labels.map((l) => ({ label: l.label, count: num(l.count) })) };
}

// ═══ 按标签列节点（分页） ═══
export async function listByLabel(engine: Neo4jEngine, label: string, limit = 30, skip = 0): Promise<Record<string, unknown>> {
  const port = PORTS[engine];
  // 动态标签 → 用参数化不可行（Cypher 标签不能参数化），白名单校验
  const safeLabel = label.replace(/[^a-zA-Z0-9_一-龥]/g, "").slice(0, 60);
  if (!safeLabel) return { ok: false, error: "非法标签" };
  const nodes = await neo4jQuery<Record<string, unknown>>(
    port,
    `match (n:\`${safeLabel}\`) return n skip toInteger($skip) limit toInteger($limit)`,
    { limit, skip }, 20000
  );
  const count = await neo4jQuery<{ n: number }>(port, `match (n:\`${safeLabel}\`) return count(n) as n`, {}, 20000);
  return {
    ok: true, engine, label: safeLabel,
    count: typeof count[0]?.n === "object" ? Number((count[0].n as { low: number }).low ?? 0) : Number(count[0]?.n ?? 0),
    nodes: nodes.map((n) => {
      const props = (n.n as { properties?: Record<string, unknown> })?.properties
        ?? (n.n as { properties?: unknown })?.properties ?? {};
      return props;
    }),
  };
}

// ═══ 实体搜索 ═══
export async function searchEntity(engine: Neo4jEngine, query: string, limit = 20): Promise<Record<string, unknown>> {
  const port = PORTS[engine];
  const q = query.trim().slice(0, 50);
  if (!q) return { ok: false, error: "搜索词为空" };
  const nodes = await neo4jQuery<Record<string, unknown>>(
    port,
    `match (n) where n.name contains $q return n limit $limit`,
    { q, limit }, 20000
  );
  return {
    ok: true, engine, query: q,
    nodes: nodes.map((n) => (n.n as { properties?: Record<string, unknown> })?.properties ?? {}),
  };
}

// ═══ 实体关系图（以某实体为中心展开） ═══
export async function entityGraph(engine: Neo4jEngine, name: string, depth = 1, limit = 20): Promise<Record<string, unknown>> {
  const port = PORTS[engine];
  const q = name.trim().slice(0, 50);
  if (!q) return { ok: false, error: "实体名为空" };
  const rows = await neo4jQuery<{ source: string; rel: string; target: string; sProps: Record<string, unknown>; tProps: Record<string, unknown> }>(
    port,
    `match (a)-[r]-(b) where a.name = $q
     with a, r, b limit $limit
     return a.name as source, type(r) as rel, b.name as target,
            properties(a) as sProps, properties(b) as tProps`,
    { q, limit }, 25000
  );
  return {
    ok: true, engine, center: q,
    nodes: [...new Map<string, Record<string, unknown>>([
      ...rows.map((r) => [r.source, r.sProps] as const),
      ...rows.map((r) => [r.target, r.tProps] as const),
    ])].map(([name2, props]) => ({ name: name2, props })),
    edges: rows.map((r) => ({ source: r.source, target: r.target, relation: r.rel })),
  };
}

export const neo4jBrowserService = { typeStats, listByLabel, searchEntity, entityGraph };
