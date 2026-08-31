// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// citation-graph-service.ts — V399: 引用网络图构造 (Rimagination/paper-atlas 参考实现)
// 提炼 paper-atlas 后端算法 (backend/services/similarity.py):
//   - 文献耦合 (bibliographic coupling): 两文共享参考文献的余弦重叠
//   - 共被引 (co-citation): 两文被共同引用的余弦重叠
//   - 组合相似度 = 0.5*耦合 + 0.5*共被引
//   - networkx 建图 → 度排序 → top-K 边裁剪
// 用途: 图谱页引用网络可视化的后端算法层 (前端 d3 力导向已有 ForceGraphPanel)。
// 注意: 本服务为算法参考实现, 数据源接入由图谱数据入库方案决定 (方案A批量入库 vs 方案B接Neo4j, 用户暂缓)。

/** 文献耦合: 参考文献集合的余弦重叠 */
export function bibliographicCoupling(refA: Set<string>, refB: Set<string>): number {
  return cosineOverlap(refA, refB);
}

/** 共被引: 被引集合的余弦重叠 */
export function coCitation(citeA: Set<string>, citeB: Set<string>): number {
  return cosineOverlap(citeA, citeB);
}

/** 余弦重叠 (Jaccard 的余弦变体, 同 paper-atlas) */
export function cosineOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / Math.sqrt(a.size * b.size);
}

/** 组合相似度 (paper-atlas: 0.5 耦合 + 0.5 共被引) */
export function combineSimilarity(
  refA: Set<string>, refB: Set<string>,
  citeA: Set<string>, citeB: Set<string>
): number {
  return 0.5 * bibliographicCoupling(refA, refB) + 0.5 * coCitation(citeA, citeB);
}

export interface GraphNode {
  id: string;
  title: string;
  year?: number | null;
  citationCount?: number;
  isSeed?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface CitationGraphInput {
  /** 论文查找表: id → { title, year, citationCount, references: string[], citations: string[] } */
  papers: Record<string, {
    title?: string;
    year?: number | null;
    citationCount?: number;
    references?: string[];
    citations?: string[];
  }>;
  seedPaperId?: string;
  threshold?: number;   // 相似度阈值 (默认 0.08)
  nodeMax?: number;     // 节点上限 (默认 60)
  edgeMax?: number;     // 边上限 (默认 150)
}

/**
 * 构造引用网络图 (paper-atlas 算法):
 * 两两论文算组合相似度 → 超阈值连边 → 按加权度排序裁剪节点 → top-K 边
 */
export function buildCitationGraph(input: CitationGraphInput): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const { papers, seedPaperId, threshold = 0.08, nodeMax = 60, edgeMax = 150 } = input;
  const ids = Object.keys(papers).filter(Boolean);

  const refSets: Record<string, Set<string>> = {};
  const citeSets: Record<string, Set<string>> = {};
  for (const id of ids) {
    refSets[id] = new Set(papers[id].references || []);
    citeSets[id] = new Set(papers[id].citations || []);
  }

  // 1) 两两相似度 → 边
  const edges: GraphEdge[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const w = combineSimilarity(refSets[a], refSets[b], citeSets[a], citeSets[b]);
      if (w >= threshold) edges.push({ source: a, target: b, weight: w });
    }
  }

  // 2) 加权度排序 (networkx degree(weight) 对应)
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + e.weight);
    degree.set(e.target, (degree.get(e.target) || 0) + e.weight);
  }

  // 3) 节点裁剪: seed 必保, 其余按加权度 top-K
  let selected = ids;
  if (ids.length > nodeMax) {
    const ranked = [...ids].sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0));
    const keep = new Set<string>();
    if (seedPaperId && papers[seedPaperId]) keep.add(seedPaperId);
    for (const id of ranked) {
      keep.add(id);
      if (keep.size >= nodeMax) break;
    }
    selected = ids.filter((id) => keep.has(id));
  }
  const sel = new Set(selected);
  const keptEdges = edges.filter((e) => sel.has(e.source) && sel.has(e.target));

  const nodes: GraphNode[] = selected.map((id) => ({
    id,
    title: papers[id].title || id,
    year: papers[id].year ?? null,
    citationCount: papers[id].citationCount || 0,
    isSeed: id === seedPaperId,
  }));
  const top = keptEdges.sort((a, b) => b.weight - a.weight).slice(0, edgeMax);
  return { nodes, edges: top };
}

export const citationGraphService = { bibliographicCoupling, coCitation, combineSimilarity, buildCitationGraph };
