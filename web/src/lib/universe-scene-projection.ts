// universe-scene-projection.ts — 累积拓扑投影(对齐 Zleap universe-scene-projection.ts)
// 语义: 累积是事件主导的——实体只有在当前投影中的事实关系把它连到事件时
// 才允许进入视觉拓扑;游离实体作为 orphanEntityIds 返回供 UI 提示。
// 来源: Zleap-AI/SAG apps/web/lib/universe-scene-projection.ts(完整移植)。
export interface UniverseProjectionNode {
  id: string;
  kind: "source" | "event" | "entity";
}

export interface UniverseProjectionLink {
  source: string;
  target: string;
  virtual: boolean;
}

/**
 * Accumulation is event-led: an entity may enter the visual topology only
 * when a factual, currently projected relation connects it to an event.
 */
export function projectUniverseAccumulationTopology<
  TNode extends UniverseProjectionNode,
  TLink extends UniverseProjectionLink,
>(nodes: readonly TNode[], links: readonly TLink[]) {
  const eventIds = new Set(
    nodes.filter((node) => node.kind === "event").map((node) => node.id),
  );
  const entityIds = new Set(
    nodes.filter((node) => node.kind === "entity").map((node) => node.id),
  );
  const connectedEntityIds = new Set<string>();
  links.forEach((link) => {
    if (link.virtual) return;
    if (eventIds.has(link.source) && entityIds.has(link.target)) {
      connectedEntityIds.add(link.target);
    }
    if (eventIds.has(link.target) && entityIds.has(link.source)) {
      connectedEntityIds.add(link.source);
    }
  });

  const retainedNodes = nodes.filter((node) =>
    node.kind !== "entity" || connectedEntityIds.has(node.id));
  const retainedIds = new Set(retainedNodes.map((node) => node.id));
  return {
    nodes: retainedNodes,
    links: links.filter((link) =>
      retainedIds.has(link.source) && retainedIds.has(link.target)),
    orphanEntityIds: nodes
      .filter((node) => node.kind === "entity" && !connectedEntityIds.has(node.id))
      .map((node) => node.id),
  };
}
