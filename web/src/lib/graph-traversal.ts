// graph-traversal.ts — 方向+深度遍历：从实体出发，在 entity↔event 超图上 BFS
// 方向语义（依赖 LLM 推断的 subject/object，见 event_directions 表）：
//   out = 起点是事件的 subject（主动方）：经其事件到达事件中的其它实体（它指向谁）
//   in  = 起点是事件的 object（被动方）：谁在事件里提到/分析/针对它（谁引用它）
//   both = 两者合并
// 无方向数据的事件（subject/object 为空）回退为无向（双向可达）
// 用法：traverseGraph(graph, startEntityId, "out", 2) → { nodes, hitCount }
import type { ProjectGraphRecord } from "../types";

export type TraversalDirection = "in" | "out" | "both";

export interface TraversalNode {
  entityId: string;
  name: string;
  depth: number;
  /** 到达路径：起始实体 → [事件标题] → 实体 → ... */
  path: string[];
}

export interface TraversalResult {
  nodes: TraversalNode[];
  /** 命中数（不含起点） */
  hitCount: number;
}

const MAX_RESULTS = 200;

/**
 * BFS 遍历超图。每次实体→事件→实体步进 +1 深度。
 * 方向过滤：out = 起点在事件 subjectIds；in = 起点在事件 objectIds；both/无方向数据 = 全量。
 * 结果按 depth 升序、eventCount 降序。
 */
export function traverseGraph(
  graph: ProjectGraphRecord,
  startEntityId: string,
  direction: TraversalDirection,
  depth: number
): TraversalResult {
  const maxDepth = Math.min(Math.max(depth, 1), 3);
  const entityById = new Map(graph.entities.map((e) => [e.id, e]));
  // V399 性能: 预建 eventsById Map — 原 graph.events.find 在循环内 O(N×M) 导致
  // 大图谱(5万实体/上千事件)选择实体后页面卡死
  const eventsById = new Map(graph.events.map((e) => [e.id, e]));
  const eventsByEntity = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = eventsByEntity.get(edge.entityId) ?? [];
    list.push(edge.eventId);
    eventsByEntity.set(edge.entityId, list);
  }

  if (!entityById.has(startEntityId)) return { nodes: [], hitCount: 0 };

  const startName = entityById.get(startEntityId)!.name;
  const visitedEntities = new Set<string>([startEntityId]);
  const results: TraversalNode[] = [];

  let frontier: Array<{ entityId: string; entityDepth: number; path: string[] }> = [
    { entityId: startEntityId, entityDepth: 0, path: [startName] }
  ];

  const visitNeighbors = (
    item: { entityId: string; entityDepth: number; path: string[] },
    next: Array<{ entityId: string; entityDepth: number; path: string[] }>
  ) => {
    const events = eventsByEntity.get(item.entityId) ?? [];
    for (const eventId of events) {
      const event = eventsById.get(eventId);
      if (!event) continue;
      // 方向过滤：事件有方向数据时，判断起点在事件中的角色
      const hasDirection = (event.subjectIds?.length ?? 0) > 0 || (event.objectIds?.length ?? 0) > 0;
      if (hasDirection && direction !== "both") {
        const isSubject = event.subjectIds?.includes(item.entityId) ?? false;
        const isObject = event.objectIds?.includes(item.entityId) ?? false;
        if (direction === "out" && !isSubject) continue;
        if (direction === "in" && !isObject) continue;
      }
      for (const otherEntityId of event.entityIds) {
        if (otherEntityId === item.entityId || visitedEntities.has(otherEntityId)) continue;
        const other = entityById.get(otherEntityId);
        if (!other) continue;
        visitedEntities.add(otherEntityId);
        const newDepth = item.entityDepth + 1;
        const path = [...item.path, event.title.slice(0, 40), other.name];
        if (newDepth <= maxDepth) {
          results.push({ entityId: otherEntityId, name: other.name, depth: newDepth, path });
        }
        if (newDepth < maxDepth) {
          next.push({ entityId: otherEntityId, entityDepth: newDepth, path });
        }
      }
    }
  };

  while (frontier.length > 0 && results.length < MAX_RESULTS) {
    const next: Array<{ entityId: string; entityDepth: number; path: string[] }> = [];
    for (const item of frontier) {
      visitNeighbors(item, next);
    }
    frontier = next;
  }

  results.sort((a, b) => a.depth - b.depth || (entityById.get(b.entityId)?.eventCount ?? 0) - (entityById.get(a.entityId)?.eventCount ?? 0));

  return { nodes: results, hitCount: results.length };
}
