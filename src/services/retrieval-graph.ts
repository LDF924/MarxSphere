// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// retrieval-graph.ts — 请求级检索图追踪(G2, 完整移植 Zleap GraphCollector/Tracker/PathAnalyzer)
// 参照: zleap/sag/modules/search/{tracker,graph,path_analyzer}.py
// 设计对齐(不简化):
//   - Tracker: 四类节点(query/entity/event/chunk) + 优先级合并 + 边去重(同 key 取 max confidence)
//   - GraphCollector: record_* 接口(enabled=false 全 no-op), build() 产出 answer graph
//   - PathAnalyzer: 有界路径枚举(深度 32/每目标 200 上限), 最短/最长路径, 逐 hop 实体分组
import { createHash } from "node:crypto";

// ═══ 数据结构(对齐 GraphNode/GraphClue/SearchGraph/PathAnalysisResult) ═══

export type GraphNodeType = "query" | "entity" | "event" | "chunk";
export type ClueVisibility = "debug" | "intermediate" | "final";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  category: string;
  eventId?: string;
  chunkId?: string;
  name?: string;
  title?: string;
  summary?: string;
  content: string;
  description: string;
  stage?: string;
  hop: number;
  metadata: Record<string, unknown>;
}

export interface GraphClue {
  id: string;
  stage: string;
  method: string;
  fromId: string;
  toId: string;
  confidence: number;
  hop: number;
  visibility: ClueVisibility;
  relation: string;
  description: string;
  metadata: Record<string, unknown>;
}

export interface SearchGraph {
  version: "1.0";
  nodes: GraphNode[];
  clues: GraphClue[];
}

export interface PathAnalysisResult {
  shortestPaths: Record<string, GraphClue[][]>;
  longestPaths: Record<string, GraphClue[][]>;
  candidatePaths: Record<string, GraphClue[][]>;
  nodesByDepth: Record<string, GraphNode[]>;
  stats: {
    maxDepth: number;
    maxPathsPerEvent: number;
    targetEventCount: number;
    eventWithPathCount: number;
    totalPathCount: number;
    truncated: boolean;
    truncatedEventIds: string[];
    cycleEdgesSkipped: number;
    depthEdgesSkipped: number;
  };
}

// ═══ Tracker(对齐 tracker.py: 优先级合并/边去重/反向 BFS) ═══

const SOURCE_PRIORITY: Record<string, number> = {
  route_stub: 0,
  vector_projection: 1,
  relation_detail: 2,
};
const VISIBILITY_PRIORITY: Record<ClueVisibility, number> = { debug: 0, intermediate: 1, final: 2 };

export function stableId(prefix: string, ...parts: unknown[]): string {
  const payload = JSON.stringify(parts, (_k, v) => (typeof v === "object" && v !== null ? v : v), "");
  return `${prefix}-${createHash("sha256").update(payload).digest("hex").slice(0, 24)}`;
}

function portable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
}

function clampConfidence(value: number): number {
  return Math.min(1.0, Math.max(0.0, value));
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && value !== null && Object.keys(value as object).length === 0);
}

export interface RouteTraceSnapshot {
  nodes: Map<string, GraphNode>;
  clues: Map<string, GraphClue>;
  incoming: Map<string, string[]>;
}

export class Tracker {
  allNodes = new Map<string, GraphNode>();
  allClues = new Map<string, GraphClue>();
  incoming = new Map<string, string[]>();
  private nodeSources = new Map<string, number>();
  private clueKeys = new Map<string, string>();

  static buildQueryNode(query: string, scopeFingerprint: string, rewritten = false): GraphNode {
    const text = query.trim();
    return {
      id: stableId("query", text, scopeFingerprint),
      type: "query",
      category: rewritten ? "rewrite" : "origin",
      content: text,
      description: rewritten ? "重写的请求" : "原始搜索内容",
      hop: 0,
      metadata: {},
    };
  }

  static buildEntityNode(entity: Record<string, unknown>, stage?: string, hop = 0): GraphNode {
    const id = String(entity.entity_id ?? entity.id ?? entity.key_id ?? "");
    if (!id) throw new Error("实体投影缺少稳定 entity_id");
    const meta: Record<string, unknown> = {};
    for (const key of ["data_source_id", "source_id", "normalized_name"]) {
      if (entity[key] != null) meta[key] = portable(entity[key]);
    }
    return {
      id,
      type: "entity",
      category: String(entity.type ?? entity.category ?? ""),
      name: String(entity.name ?? ""),
      content: String(entity.name ?? ""),
      description: String(entity.description ?? ""),
      stage,
      hop: Math.max(0, hop),
      metadata: meta,
    };
  }

  static buildEventNode(event: Record<string, unknown>, stage?: string, hop = 0): GraphNode {
    const id = String(event.event_id ?? event.id ?? "");
    if (!id) throw new Error("事项投影缺少稳定 event_id");
    const meta: Record<string, unknown> = {};
    for (const key of ["data_source_id", "source_id", "source_type", "chunk_id", "start_time", "end_time"]) {
      if (event[key] != null) meta[key] = portable(event[key]);
    }
    return {
      id,
      type: "event",
      eventId: id,
      category: String(event.category ?? event.type ?? ""),
      title: String(event.title ?? ""),
      summary: String(event.summary ?? ""),
      content: String(event.content ?? event.summary ?? ""),
      description: String(event.content ?? ""),
      stage,
      hop: Math.max(0, hop),
      metadata: meta,
    };
  }

  static buildChunkNode(chunk: Record<string, unknown>, stage?: string, hop = 0): GraphNode {
    const id = String(chunk.chunk_id ?? chunk.id ?? "");
    if (!id) throw new Error("Chunk 投影缺少稳定 chunk_id");
    const meta: Record<string, unknown> = {};
    for (const key of ["data_source_id", "source_id", "score", "heading"]) {
      if (chunk[key] != null) meta[key] = portable(chunk[key]);
    }
    return {
      id,
      type: "chunk",
      chunkId: id,
      category: "chunk",
      title: String(chunk.heading ?? chunk.title ?? ""),
      content: String(chunk.content ?? ""),
      description: String(chunk.content ?? ""),
      stage,
      hop: Math.max(0, hop),
      metadata: meta,
    };
  }

  addNode(node: GraphNode, source = "route_stub"): GraphNode {
    const priority = SOURCE_PRIORITY[source] ?? 0;
    const existing = this.allNodes.get(node.id);
    if (!existing) {
      this.allNodes.set(node.id, node);
      this.nodeSources.set(node.id, priority);
      return node;
    }
    if (existing.type !== node.type) {
      throw new Error(`RouteTrace 节点 ${node.id} 的类型发生冲突`);
    }
    const oldPriority = this.nodeSources.get(node.id) ?? 0;
    const merged: GraphNode = { ...existing };
    // 逐字段合并(对齐 tracker.py add_node: 非空且高优先级才覆盖)
    const fields: Array<keyof GraphNode> = ["category", "eventId", "chunkId", "name", "title", "summary", "content", "description", "stage", "hop"];
    for (const key of fields) {
      const value = node[key];
      if (key === "hop" && value === 0 && existing.hop > 0) continue;
      if (!isEmptyValue(value)) {
        if (priority >= oldPriority || isEmptyValue(merged[key])) {
          // 显式类型分支避免联合类型赋值(TS 严格模式)
          switch (key) {
            case "category": merged.category = value as string; break;
            case "eventId": merged.eventId = value as string | undefined; break;
            case "chunkId": merged.chunkId = value as string | undefined; break;
            case "name": merged.name = value as string | undefined; break;
            case "title": merged.title = value as string | undefined; break;
            case "summary": merged.summary = value as string | undefined; break;
            case "content": merged.content = value as string; break;
            case "description": merged.description = value as string; break;
            case "stage": merged.stage = value as string | undefined; break;
            case "hop": merged.hop = value as number; break;
            default: break;
          }
        }
      }
    }
    const mergedMetadata: Record<string, unknown> = { ...existing.metadata };
    if (priority >= oldPriority) Object.assign(mergedMetadata, node.metadata);
    else {
      const combined: Record<string, unknown> = { ...node.metadata, ...mergedMetadata };
      Object.keys(mergedMetadata).forEach((k) => { delete mergedMetadata[k]; });
      Object.assign(mergedMetadata, combined);
    }
    merged.metadata = mergedMetadata;
    this.allNodes.set(node.id, merged);
    this.nodeSources.set(node.id, Math.max(priority, oldPriority));
    return merged;
  }

  addEdge(input: {
    stage: string;
    method: string;
    fromId: string;
    toId: string;
    confidence?: number;
    hop?: number;
    visibility?: ClueVisibility;
    relation?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): GraphClue {
    const { stage, method, fromId, toId } = input;
    if (!this.allNodes.has(fromId) || !this.allNodes.has(toId)) {
      throw new Error(`RouteTrace 边端点不存在: ${fromId} -> ${toId}`);
    }
    const visibility = input.visibility ?? "intermediate";
    const key = [stage, method, fromId, toId, Math.max(0, input.hop ?? 0)].join("|");
    const existingId = this.clueKeys.get(key);
    if (existingId) {
      const existing = this.allClues.get(existingId)!;
      const mergedMetadata: Record<string, unknown> = {
        ...existing.metadata,
        ...(portable(input.metadata ?? {}) as Record<string, unknown>),
      };
      const merged: GraphClue = {
        ...existing,
        confidence: Math.max(existing.confidence, clampConfidence(input.confidence ?? 1.0)),
        visibility: VISIBILITY_PRIORITY[visibility] > VISIBILITY_PRIORITY[existing.visibility] ? visibility : existing.visibility,
        relation: input.relation ?? existing.relation,
        description: input.description ?? existing.description,
        metadata: mergedMetadata,
      };
      this.allClues.set(existingId, merged);
      return merged;
    }
    const clueId = stableId("clue", key);
    const clue: GraphClue = {
      id: clueId,
      stage,
      method,
      fromId,
      toId,
      confidence: clampConfidence(input.confidence ?? 1.0),
      hop: Math.max(0, input.hop ?? 0),
      visibility,
      relation: input.relation ?? "",
      description: input.description ?? "",
      metadata: portable(input.metadata ?? {}) as Record<string, unknown>,
    };
    this.clueKeys.set(key, clueId);
    this.allClues.set(clueId, clue);
    const incomingList = this.incoming.get(toId) ?? [];
    incomingList.push(clueId);
    this.incoming.set(toId, incomingList);
    return clue;
  }

  snapshot(): RouteTraceSnapshot {
    return {
      nodes: new Map(this.allNodes),
      clues: new Map(this.allClues),
      incoming: new Map([...this.incoming.entries()].map(([k, v]) => [k, [...v]])),
    };
  }

  /** 反向 BFS: 只保留能到达最终答案目标的节点与边(对齐 build_answer_graph) */
  buildAnswerGraph(targetIds: string[]): SearchGraph {
    const wantedNodes = new Set<string>();
    const wantedClues = new Set<string>();
    const stack = [...new Set(targetIds)].filter((id) => this.allNodes.has(id));
    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      if (wantedNodes.has(nodeId)) continue;
      wantedNodes.add(nodeId);
      for (const clueId of this.incoming.get(nodeId) ?? []) {
        const clue = this.allClues.get(clueId);
        if (!clue) continue;
        wantedClues.add(clueId);
        if (!wantedNodes.has(clue.fromId)) stack.push(clue.fromId);
      }
    }
    return {
      version: "1.0",
      nodes: [...wantedNodes].sort().map((id) => this.allNodes.get(id)!),
      clues: [...wantedClues].sort().map((id) => this.allClues.get(id)!),
    };
  }
}

// ═══ PathAnalyzer(对齐 path_analyzer.py: 有界路径枚举) ═══

function pathConfidence(path: GraphClue[]): number {
  return path.reduce((acc, clue) => acc * clue.confidence, 1);
}

export class PathAnalyzer {
  static readonly HARD_MAX_DEPTH = 32;
  static readonly HARD_MAX_PATHS_PER_EVENT = 200;

  analyze(snapshot: RouteTraceSnapshot, targetEventIds: string[], maxDepth: number, maxPathsPerEvent = 20): PathAnalysisResult {
    const effectiveDepth = Math.max(1, Math.min(maxDepth, PathAnalyzer.HARD_MAX_DEPTH));
    const effectiveLimit = Math.max(1, Math.min(maxPathsPerEvent, PathAnalyzer.HARD_MAX_PATHS_PER_EVENT));

    const pathsByEvent: Record<string, GraphClue[][]> = {};
    const truncatedEvents: string[] = [];
    let cycleEdgesSkipped = 0;
    let depthEdgesSkipped = 0;

    for (const eventId of [...new Set(targetEventIds)]) {
      if (!snapshot.nodes.has(eventId)) continue;
      const { found, truncated, skippedCycles, skippedDepth } = this.enumeratePaths(snapshot, eventId, effectiveDepth, effectiveLimit);
      cycleEdgesSkipped += skippedCycles;
      depthEdgesSkipped += skippedDepth;
      const ordered = [...found].sort((a, b) => {
        const keyA = pathKey(a);
        const keyB = pathKey(b);
        return keyA[0] - keyB[0] || keyA[1] - keyB[1] || keyA[2].join(",").localeCompare(keyB[2].join(","));
      });
      if (ordered.length > 0) pathsByEvent[eventId] = ordered;
      if (truncated) truncatedEvents.push(eventId);
    }

    const shortestPaths: Record<string, GraphClue[][]> = {};
    const longestPaths: Record<string, GraphClue[][]> = {};
    for (const [eventId, paths] of Object.entries(pathsByEvent)) {
      shortestPaths[eventId] = [paths[0]];
      longestPaths[eventId] = [[...paths].sort((a, b) => b.length - a.length || pathConfidence(b) - pathConfidence(a))[0]];
    }

    const nodesByDepth = this.entitiesByHop(snapshot, pathsByEvent);
    return {
      shortestPaths,
      longestPaths,
      candidatePaths: pathsByEvent,
      nodesByDepth,
      stats: {
        maxDepth: effectiveDepth,
        maxPathsPerEvent: effectiveLimit,
        targetEventCount: new Set(targetEventIds).size,
        eventWithPathCount: Object.keys(pathsByEvent).length,
        totalPathCount: Object.values(pathsByEvent).reduce((sum, paths) => sum + paths.length, 0),
        truncated: truncatedEvents.length > 0,
        truncatedEventIds: truncatedEvents,
        cycleEdgesSkipped,
        depthEdgesSkipped,
      },
    };
  }

  private enumeratePaths(snapshot: RouteTraceSnapshot, eventId: string, maxDepth: number, maxPaths: number): {
    found: GraphClue[][];
    truncated: boolean;
    skippedCycles: number;
    skippedDepth: number;
  } {
    const found: GraphClue[][] = [];
    const seenPathKeys = new Set<string>();
    let truncated = false;
    let cycleEdgesSkipped = 0;
    let depthEdgesSkipped = 0;

    const walk = (nodeId: string, reversedPath: GraphClue[], visited: Set<string>): void => {
      const node = snapshot.nodes.get(nodeId);
      if (!node) return;
      if (node.type === "query" && node.category === "origin") {
        const path = [...reversedPath].reverse();
        const key = path.map((c) => c.id).join("|");
        if (!seenPathKeys.has(key)) {
          seenPathKeys.add(key);
          found.push(path);
        }
        return;
      }
      const incomingIds = [...(snapshot.incoming.get(nodeId) ?? [])].sort();
      if (reversedPath.length >= maxDepth) {
        if (incomingIds.length > 0) {
          depthEdgesSkipped += incomingIds.length;
          truncated = true;
        }
        return;
      }
      for (const clueId of incomingIds) {
        if (found.length >= maxPaths) {
          truncated = true;
          return;
        }
        const clue = snapshot.clues.get(clueId);
        if (!clue) continue;
        if (visited.has(clue.fromId)) {
          cycleEdgesSkipped++;
          continue;
        }
        walk(clue.fromId, [...reversedPath, clue], new Set(visited).add(clue.fromId));
      }
    };

    walk(eventId, [], new Set([eventId]));
    return { found, truncated, skippedCycles: cycleEdgesSkipped, skippedDepth: depthEdgesSkipped };
  }

  private entitiesByHop(snapshot: RouteTraceSnapshot, pathsByEvent: Record<string, GraphClue[][]>): Record<string, GraphNode[]> {
    const byHop = new Map<number, Map<string, GraphNode>>();
    for (const paths of Object.values(pathsByEvent)) {
      for (const path of paths) {
        for (const clue of path) {
          for (const nodeId of [clue.fromId, clue.toId]) {
            const node = snapshot.nodes.get(nodeId);
            if (node && node.type === "entity") {
              if (!byHop.has(node.hop)) byHop.set(node.hop, new Map());
              byHop.get(node.hop)!.set(node.id, node);
            }
          }
        }
      }
    }
    const result: Record<string, GraphNode[]> = {};
    for (const [hop, nodes] of [...byHop.entries()].sort((a, b) => a[0] - b[0])) {
      result[String(hop)] = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    return result;
  }
}

function pathKey(path: GraphClue[]): [number, number, string[]] {
  return [path.length, -pathConfidence(path), path.map((c) => c.id)];
}

// ═══ GraphCollector(对齐 graph.py: record_* 接口 + build; enabled=false 全 no-op) ═══

export interface GraphOutput {
  graph: SearchGraph | null;
  pathResult: PathAnalysisResult | null;
}

export class GraphCollector {
  private tracker: Tracker | null;

  constructor(
    private enabled: boolean,
    private maxPathsPerEvent = 20,
  ) {
    this.tracker = enabled ? new Tracker() : null;
  }

  get activeTracker(): Tracker {
    if (!this.tracker) throw new Error("图谱收集未启用");
    return this.tracker;
  }

  recordQuery(query: string, scopeFingerprint: string): string {
    if (!this.tracker) return stableId("query", query.trim(), scopeFingerprint);
    const node = Tracker.buildQueryNode(query, scopeFingerprint);
    this.tracker.addNode(node);
    return node.id;
  }

  recordRewrite(originId: string, rewritten: string, scopeFingerprint: string): string {
    if (!this.tracker) return stableId("query", rewritten.trim(), scopeFingerprint);
    const node = Tracker.buildQueryNode(rewritten, scopeFingerprint, true);
    this.tracker.addNode(node);
    if (node.id !== originId) {
      this.tracker.addEdge({ stage: "query", method: "rewrite", fromId: originId, toId: node.id, confidence: 1.0, visibility: "intermediate" });
    }
    return node.id;
  }

  recordEntity(row: Record<string, unknown>, queryId: string, scores: Record<string, number>, hop = 0, stage = "recall", source = "vector_projection"): string {
    if (!this.tracker) return "";
    const node = Tracker.buildEntityNode(row, stage, hop);
    this.tracker.addNode(node, source);
    for (const [method, score] of Object.entries(scores)) {
      this.tracker.addEdge({ stage, method, fromId: queryId, toId: node.id, confidence: score, hop, visibility: "intermediate" });
    }
    return node.id;
  }

  recordEvent(row: Record<string, unknown>, queryId: string, method: string, confidence: number, hop = 0, stage = "recall", source = "route_stub"): string {
    if (!this.tracker) return "";
    const node = Tracker.buildEventNode(row, stage, hop);
    this.tracker.addNode(node, source);
    this.tracker.addEdge({ stage, method, fromId: queryId, toId: node.id, confidence, hop, visibility: "intermediate" });
    return node.id;
  }

  recordEventRoutes(row: Record<string, unknown>, eventId: string, relations: Array<Record<string, unknown>>, hop = 0, stage = "recall", source = "route_stub"): string {
    if (!this.tracker) return "";
    const node = Tracker.buildEventNode(row, stage, hop);
    this.tracker.addNode(node, source);
    for (const relation of relations) {
      const entityId = String(relation.entity_id ?? "");
      if (!entityId) continue;
      this.tracker.addEdge({
        stage,
        method: "entity_relation",
        fromId: entityId,
        toId: eventId,
        confidence: Number(relation.score ?? 1.0),
        hop,
        visibility: "intermediate",
        relation: String(relation.description ?? ""),
      });
    }
    return node.id;
  }

  recordExpansionEvent(row: Record<string, unknown>, hop: number, source = "vector_projection"): string {
    if (!this.tracker) return "";
    const node = Tracker.buildEventNode(row, "expand", hop);
    this.tracker.addNode(node, source);
    return node.id;
  }

  recordExpansionEdge(method: string, fromId: string, toId: string, confidence: number, hop = 0, relation = ""): void {
    if (!this.tracker) return;
    this.tracker.addEdge({ stage: "expand", method, fromId, toId, confidence, hop, visibility: "intermediate", relation });
  }

  recordChunk(row: Record<string, unknown>, queryId: string, eventIds: string[] | null, confidence = 1.0, hop = 0, stage = "recall", source = "vector_projection"): string {
    if (!this.tracker) return "";
    const node = Tracker.buildChunkNode(row, stage, hop);
    this.tracker.addNode(node, source);
    let linkedAny = false;
    for (const eventId of [...new Set(eventIds ?? [])]) {
      if (!this.tracker.allNodes.has(eventId)) continue;
      this.tracker.addEdge({ stage, method: "chunk_link", fromId: eventId, toId: node.id, confidence, hop, visibility: "intermediate" });
      linkedAny = true;
    }
    if (!linkedAny) {
      this.tracker.addEdge({ stage, method: "query_chunk_fallback", fromId: queryId, toId: node.id, confidence, hop, visibility: "intermediate" });
    }
    return node.id;
  }

  async build(targetIds: string[], returnPaths: boolean): Promise<GraphOutput> {
    if (!this.tracker) return { graph: null, pathResult: null };
    const graph = this.tracker.buildAnswerGraph(targetIds);
    let pathResult: PathAnalysisResult | null = null;
    if (returnPaths) {
      pathResult = new PathAnalyzer().analyze(this.tracker.snapshot(), targetIds, 3 + 2 * 1, this.maxPathsPerEvent);
    }
    return { graph, pathResult };
  }
}
