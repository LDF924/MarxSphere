import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeMouseHandler,
  useEdgesState,
  useNodesState,
  useReactFlow
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  ProjectGraphEntityRecord,
  ProjectGraphEventRecord,
  ProjectGraphRecord
} from "../types";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import type { SupportedLanguage } from "../i18n";

type GraphNodeData = {
  label: string;
  kind: "entity" | "event";
  expanded: boolean;
} & Record<string, unknown>;

type GraphNode = Node<GraphNodeData>;
type GraphEdge = Edge;

const ROOT_ENTITY_LIMIT = 8;
const ENTITY_NODE_WIDTH = 170;
const EVENT_NODE_WIDTH = 180;
const NODE_HEIGHT = 44;
const ENTITY_RING_START_RADIUS = 220;
const ENTITY_RING_GAP = 190;
const ENTITY_SLOT_SPACING = 210;
const EVENT_RING_START_RADIUS = 520;
const EVENT_RING_GAP = 185;
const EVENT_SLOT_SPACING = 240;
const EVENT_ANGLE_OFFSET = -Math.PI / 2 + Math.PI / 12;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

type GraphPosition = {
  x: number;
  y: number;
  angle: number;
  radius: number;
  root?: boolean;
};

export function ProjectGraphFlow(props: {
  graph: ProjectGraphRecord;
  language: SupportedLanguage;
  highlightedNodeIds?: Set<string>;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <ProjectGraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function ProjectGraphCanvas(props: {
  graph: ProjectGraphRecord;
  language: SupportedLanguage;
  highlightedNodeIds?: Set<string>;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  // 2026-08-07 图谱筛选：论文标题搜索 + 批量选择（必须先于 initialEntityIds 声明）
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPapers, setSelectedPapers] = useState<Set<string>>(new Set());
  const [showPaperPicker, setShowPaperPicker] = useState(false);

  const initialEntityIds = useMemo(
    // 2026-08-07 图谱筛选：勾选论文后"只渲染勾选的"（selectedPapers 非空时不用默认 base）
    () => {
      if (selectedPapers.size > 0) return new Set(selectedPapers);
      return new Set(props.graph.entities.slice(0, ROOT_ENTITY_LIMIT).map((entity) => entity.id));
    },
    [props.graph.entities, selectedPapers]
  );
  const [expandedEntityIds, setExpandedEntityIds] = useState<Set<string>>(
    // 2026-08-07 防全量：初始不自动展开任何实体（只显示初始 8 个 + 关联事件）
    () => new Set()
  );
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const expandedEntityIdsRef = useRef(expandedEntityIds);

  // 2026-08-07 图谱筛选：勾选变化时重置展开集（否则旧展开的实体残留）
  useEffect(() => {
    if (selectedPapers.size > 0) {
      setExpandedEntityIds(new Set());
      setExpandedEventIds(new Set());
    }
  }, [selectedPapers]);
  const expandedEventIdsRef = useRef(expandedEventIds);
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>([]);
  const { fitView } = useReactFlow<GraphNode, GraphEdge>();
  const clickTimerRef = useRef<number | null>(null);
  const shouldFitViewRef = useRef(true);

  const entityById = useMemo(
    () => new Map(props.graph.entities.map((entity) => [entity.id, entity])),
    [props.graph.entities]
  );
  const eventById = useMemo(
    () => new Map(props.graph.events.map((event) => [event.id, event])),
    [props.graph.events]
  );
  const eventIdsByEntityId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of props.graph.edges) {
      const eventIds = map.get(edge.entityId) ?? [];
      eventIds.push(edge.eventId);
      map.set(edge.entityId, eventIds);
    }
    for (const [entityId, eventIds] of map.entries()) {
      eventIds.sort((a, b) => compareEvents(eventById.get(a), eventById.get(b)));
      map.set(entityId, eventIds);
    }
    return map;
  }, [eventById, props.graph.edges]);
  const entityIdsByEventId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of props.graph.edges) {
      const entityIds = map.get(edge.eventId) ?? [];
      entityIds.push(edge.entityId);
      map.set(edge.eventId, entityIds);
    }
    for (const [eventId, entityIds] of map.entries()) {
      entityIds.sort((a, b) => compareEntities(entityById.get(a), entityById.get(b)));
      map.set(eventId, entityIds);
    }
    return map;
  }, [entityById, props.graph.edges]);
  const positionByNodeId = useMemo(
    () => buildCircularPositionMap(props.graph),
    [props.graph]
  );
  const graphIdentity = useMemo(
    () => [
      props.graph.entities.map((entity) => entity.id).join(","),
      props.graph.events.map((event) => event.id).join(","),
      props.graph.edges.map((edge) => `${edge.entityId}:${edge.eventId}`).join(",")
    ].join("|"),
    [props.graph]
  );

  const graphModel = useMemo(() => buildVisibleGraph({
    initialEntityIds,
    expandedEntityIds,
    expandedEventIds,
    entityById,
    eventById,
    eventIdsByEntityId,
    entityIdsByEventId,
    edges: props.graph.edges,
    positionByNodeId,
    selectedNodeId,
    // V399 性能: highlightedNodeIds 不作为 useMemo 依赖（否则关系查询 9823 高亮节点
    // 触发全量重建卡死）；高亮由下方单独 effect 增量应用到已渲染节点
    highlightedNodeIds: undefined
  }), [
    entityById,
    entityIdsByEventId,
    eventById,
    eventIdsByEntityId,
    expandedEntityIds,
    expandedEventIds,
    initialEntityIds,
    positionByNodeId,
    props.graph.edges,
    selectedNodeId
  ]);

  // V399 性能: 高亮/选中样式增量应用 — 不重建整图，仅更新命中+相关节点/边的 style
  useEffect(() => {
    const highlight = props.highlightedNodeIds;
    if (!highlight || highlight.size === 0) return;
    setNodes((current) => current.map((node) => {
      const related = node.id === selectedNodeId;
      const hit = highlight.has(node.id);
      if (!hit && !related) return node;
      return {
        ...node,
        style: {
          ...node.style,
          opacity: 1,
          border: "2px solid var(--graph-node-fg, #111827)",
          boxShadow: "0 10px 30px rgba(15, 23, 42, 0.22)"
        }
      };
    }));
  }, [props.highlightedNodeIds, selectedNodeId, setNodes]);

  useEffect(() => {
    setNodes(graphModel.nodes);
    setEdges(graphModel.edges);
    if (shouldFitViewRef.current) {
      shouldFitViewRef.current = false;
      window.requestAnimationFrame(() => {
        fitView({ padding: 0.22, duration: 220 });
      });
    }
  }, [fitView, graphModel.edges, graphModel.nodes, setEdges, setNodes]);

  useEffect(() => {
    shouldFitViewRef.current = true;
    // 2026-08-07 防全量：初始不自动展开
    setExpandedEntityIds(new Set());
    setExpandedEventIds(new Set());
    setSelectedNodeId(null);
  }, [graphIdentity, props.graph.entities]);

  useEffect(() => {
    expandedEntityIdsRef.current = expandedEntityIds;
  }, [expandedEntityIds]);

  useEffect(() => {
    expandedEventIdsRef.current = expandedEventIds;
  }, [expandedEventIds]);

  useEffect(() => () => clearClickTimer(), []);

  const onNodeClick: NodeMouseHandler<GraphNode> = (event, node) => {
    event.stopPropagation();
    setSelectedNodeId(node.id);
    clearClickTimer();
    clickTimerRef.current = window.setTimeout(() => {
      toggleNode(node);
      clickTimerRef.current = null;
    }, 180);
  };

  const onNodeDoubleClick: NodeMouseHandler<GraphNode> = (event, node) => {
    event.stopPropagation();
    clearClickTimer();
    setSelectedNodeId(node.id);
    const data = node.data as GraphNodeData;
    if (data.kind === "entity") {
      props.onOpenEntity(node.id);
      return;
    }
    props.onOpenEvent(node.id);
  };

  function toggleNode(node: GraphNode) {
    const data = node.data as GraphNodeData;
    if (data.kind === "entity") {
      const isExpanded = expandedEntityIdsRef.current.has(node.id);
      setExpandedEntityIds((current) => {
        const next = new Set(current);
        if (isExpanded) {
          next.delete(node.id);
        } else {
          next.add(node.id);
        }
        return next;
      });
      if (isExpanded) {
        const relatedEventIds = new Set(eventIdsByEntityId.get(node.id) ?? []);
        setExpandedEventIds((current) => {
          const next = new Set(current);
          for (const eventId of relatedEventIds) {
            next.delete(eventId);
          }
          return next;
        });
      }
      return;
    }
    setExpandedEventIds((current) => {
      const next = new Set(current);
      if (expandedEventIdsRef.current.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      return next;
    });
  }

  function clearClickTimer() {
    if (clickTimerRef.current == null) {
      return;
    }
    window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = null;
  }

  function resetGraph() {
    shouldFitViewRef.current = true;
    // 2026-08-07 防全量：重置也不自动展开
    setExpandedEntityIds(new Set());
    setExpandedEventIds(new Set());
    setSelectedNodeId(null);
  }

  function expandAll() {
    shouldFitViewRef.current = true;
    setExpandedEntityIds(new Set(props.graph.entities.map((entity) => entity.id)));
    setExpandedEventIds(new Set(props.graph.events.map((event) => event.id)));
    setSelectedNodeId(null);
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-lg border border-border bg-background">
      <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/95 p-2 shadow-sm">
        <MetricChip label={graphText(props.language, "实体", "Entities")} value={props.graph.entities.length} />
        <MetricChip label={graphText(props.language, "事件", "Events")} value={props.graph.events.length} />
        <MetricChip label={graphText(props.language, "关系", "Relations")} value={props.graph.edges.length} />
        {/* 2026-08-07 图谱筛选：论文标题搜索框 */}
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={graphText(props.language, "搜索论文标题…", "Search paper title…")}
          className="w-44 rounded-md border border-border bg-background px-2 py-1 text-xs"
        />
        {/* 2026-08-07 批量选择论文按钮 */}
        <Button type="button" variant="outline" size="sm" onClick={() => setShowPaperPicker((v) => !v)}>
          {graphText(props.language, "选择论文", "Select papers")}
          {selectedPapers.size > 0 ? ` (${selectedPapers.size})` : ""}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={resetGraph}>{graphText(props.language, "重置", "Reset")}</Button>
        <Button type="button" variant="outline" size="sm" onClick={expandAll}>{graphText(props.language, "展开全部", "Expand all")}</Button>
      </div>

      {/* 2026-08-07 批量选择论文面板：搜索过滤 + 复选框列表（阻止 pointer 冒泡到 ReactFlow 手势） */}
      {showPaperPicker && (
        <div
          className="absolute left-3 top-16 z-20 w-80 rounded-md border border-border bg-background/95 p-2 shadow-lg"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium">{graphText(props.language, "选择要渲染的论文", "Select papers to render")}</span>
            <div className="flex gap-1">
              <button type="button" onClick={() => setSelectedPapers(new Set(props.graph.entities.map((e) => e.id)))}
                className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">全选</button>
              <button type="button" onClick={() => setSelectedPapers(new Set())}
                className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">清空</button>
              <button type="button" onClick={() => setShowPaperPicker(false)}
                className="rounded border border-primary/40 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/5">
                {graphText(props.language, "应用并渲染", "Apply")} ({selectedPapers.size})
              </button>
            </div>
          </div>
          <div className="max-h-56 space-y-0.5 overflow-y-auto pr-1">
            {props.graph.entities
              .filter((e) => !searchQuery || e.name.toLowerCase().includes(searchQuery.toLowerCase()))
              .slice(0, 50)
              .map((e) => (
                <label key={e.id} className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] hover:bg-accent/50">
                  <input
                    type="checkbox"
                    checked={selectedPapers.has(e.id)}
                    onChange={() => {
                      setSelectedPapers((prev) => {
                        const next = new Set(prev);
                        if (next.has(e.id)) next.delete(e.id);
                        else next.add(e.id);
                        return next;
                      });
                    }}
                    className="h-3 w-3"
                  />
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  <span className="shrink-0 text-[9px] text-muted-foreground">{e.eventCount ?? 0}</span>
                </label>
              ))}
          </div>
        </div>
      )}
      <ReactFlow<GraphNode, GraphEdge>
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => setSelectedNodeId(null)}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.12}
        maxZoom={2.5}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => ((node.data as GraphNodeData).kind === "entity" ? "var(--graph-node-fg, #111827)" : "var(--graph-edge, #6b7280)")}
          maskColor="var(--graph-minimap-mask, rgba(255,255,255,0.65))"
        />
      </ReactFlow>
    </div>
  );
}

function graphText(language: SupportedLanguage, zh: string, en: string) {
  return language === "en" ? en : zh;
}

function buildVisibleGraph(input: {
  initialEntityIds: Set<string>;
  expandedEntityIds: Set<string>;
  expandedEventIds: Set<string>;
  entityById: Map<string, ProjectGraphEntityRecord>;
  eventById: Map<string, ProjectGraphEventRecord>;
  eventIdsByEntityId: Map<string, string[]>;
  entityIdsByEventId: Map<string, string[]>;
  edges: ProjectGraphRecord["edges"];
  positionByNodeId: Map<string, GraphPosition>;
  selectedNodeId: string | null;
  highlightedNodeIds?: Set<string>;
}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const visibleEntityIds = new Set(input.initialEntityIds);
  const visibleEventIds = new Set<string>();

  // 2026-08-07 防全量：未展开的初始实体，每个最多关联 8 个事件（避免 8 实体 → 数百事件爆炸）
  const EVENT_PER_ENTITY_CAP = 8;
  for (const entityId of input.initialEntityIds) {
    if (input.expandedEntityIds.has(entityId)) continue;
    const events = input.eventIdsByEntityId.get(entityId) ?? [];
    for (const eventId of events.slice(0, EVENT_PER_ENTITY_CAP)) {
      visibleEventIds.add(eventId);
    }
  }

  // 2026-08-07 防点击爆炸：展开实体的事件数上限（12）+ 事件关联实体上限（8）
  // 之前点击一个实体 → 所有事件 → 所有关联实体 → 69→1079 节点爆炸
  const EXPAND_EVENT_CAP = 12;
  const EVENT_ENTITY_CAP = 8;
  for (const entityId of input.expandedEntityIds) {
    visibleEntityIds.add(entityId);
    const events = input.eventIdsByEntityId.get(entityId) ?? [];
    for (const eventId of events.slice(0, EXPAND_EVENT_CAP)) {
      visibleEventIds.add(eventId);
    }
  }

  for (const eventId of input.expandedEventIds) {
    visibleEventIds.add(eventId);
    const entities = input.entityIdsByEventId.get(eventId) ?? [];
    for (const entityId of entities.slice(0, EVENT_ENTITY_CAP)) {
      visibleEntityIds.add(entityId);
    }
  }

  const nodes: GraphNode[] = [];
  const entityIds = [...visibleEntityIds]
    .filter((id) => input.entityById.has(id))
    .sort((a, b) => compareEntities(input.entityById.get(a), input.entityById.get(b)));
  const eventIds = [...visibleEventIds]
    .filter((id) => input.eventById.has(id))
    .sort((a, b) => compareEvents(input.eventById.get(a), input.eventById.get(b)));

  for (const entityId of entityIds) {
    const entity = input.entityById.get(entityId);
    if (!entity) continue;
    const position = input.positionByNodeId.get(entity.id) ?? fallbackPosition();
    nodes.push(createGraphNode({
      id: entity.id,
      label: entity.name,
      kind: "entity",
      expanded: input.expandedEntityIds.has(entity.id),
      x: position.x,
      y: position.y,
      root: position.root
    }));
  }

  for (const eventId of eventIds) {
    const event = input.eventById.get(eventId);
    if (!event) continue;
    const position = input.positionByNodeId.get(event.id) ?? fallbackPosition();
    nodes.push(createGraphNode({
      id: event.id,
      label: event.title,
      kind: "event",
      expanded: input.expandedEventIds.has(event.id),
      x: position.x,
      y: position.y
    }));
  }

  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const edges = input.edges
    .filter((edge) => visibleNodeIds.has(edge.entityId) && visibleNodeIds.has(edge.eventId))
    .map((edge) => {
      const eventExpandsEntity = input.expandedEventIds.has(edge.eventId) && !input.expandedEntityIds.has(edge.entityId);
      return {
        id: `${edge.entityId}-${edge.eventId}`,
        source: eventExpandsEntity ? edge.eventId : edge.entityId,
        target: eventExpandsEntity ? edge.entityId : edge.eventId,
        animated: input.expandedEntityIds.has(edge.entityId) || input.expandedEventIds.has(edge.eventId),
        style: { stroke: "var(--graph-edge, #d4d4d8)", strokeWidth: 1.4 }
      };
    });

  return applySelectionStyles({
    nodes,
    edges,
    selectedNodeId: input.selectedNodeId,
    highlightedNodeIds: input.highlightedNodeIds
  });
}

function createGraphNode(input: {
  id: string;
  label: string;
  kind: GraphNodeData["kind"];
  expanded: boolean;
  x: number;
  y: number;
  root?: boolean;
}): GraphNode {
  return {
    id: input.id,
    type: "default",
    position: { x: input.x, y: input.y },
    data: {
      label: input.label,
      kind: input.kind,
      expanded: input.expanded
    },
    style: {
      width: input.root ? ENTITY_NODE_WIDTH + 20 : input.kind === "entity" ? ENTITY_NODE_WIDTH : EVENT_NODE_WIDTH,
      borderRadius: 6,
      border: input.expanded ? "1.5px solid var(--graph-node-fg, #111827)" : "1px solid var(--graph-node-border, #d4d4d8)",
      background: input.kind === "entity" ? "var(--graph-node-bg, #ffffff)" : "var(--graph-node-bg-alt, #f8fafc)",
      color: "var(--graph-node-fg, #111827)",
      fontSize: 12,
      fontWeight: input.kind === "entity" ? 650 : 520,
      padding: "8px 10px",
      boxShadow: input.root ? "0 8px 24px rgba(15, 23, 42, 0.12)" : "0 2px 8px rgba(15, 23, 42, 0.06)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    },
    className: cn(input.expanded && "ring-2 ring-ring/25")
  };
}

function applySelectionStyles(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  highlightedNodeIds?: Set<string>;
}) {
  const highlightMode = input.highlightedNodeIds != null && input.highlightedNodeIds.size > 0;
  if (!input.selectedNodeId && !highlightMode) {
    return input;
  }

  const relatedNodeIds = new Set<string>();
  if (input.selectedNodeId) {
    relatedNodeIds.add(input.selectedNodeId);
    for (const edge of input.edges) {
      if (edge.source === input.selectedNodeId || edge.target === input.selectedNodeId) {
        relatedNodeIds.add(edge.source);
        relatedNodeIds.add(edge.target);
      }
    }
  }

  // V399 性能: 高亮/选中只重建样式变化的节点与边（原全量 map 5万节点+10万边导致
  // 关系查询返回后页面卡死）。未变化的节点保留原引用 → React 跳过重渲染。
  const needsNodeStyle = (node: GraphNode) => {
    const selected = node.id === input.selectedNodeId;
    const highlighted = highlightMode && input.highlightedNodeIds!.has(node.id);
    if (highlightMode) {
      return selected || highlighted || relatedNodeIds.has(node.id);
    }
    return selected || relatedNodeIds.has(node.id);
  };
  const needsEdgeStyle = (edge: GraphEdge) => {
    const related = relatedNodeIds.has(edge.source) || relatedNodeIds.has(edge.target);
    const highlighted = highlightMode && (input.highlightedNodeIds!.has(edge.source) || input.highlightedNodeIds!.has(edge.target));
    return highlightMode ? highlighted || related : related;
  };

  const nodes = input.nodes.map((node) => {
    if (!needsNodeStyle(node)) return node;  // 未命中 → 原引用（不触发重渲染）
    const selected = node.id === input.selectedNodeId;
    const highlighted = highlightMode && (input.highlightedNodeIds!.has(node.id) || relatedNodeIds.has(node.id));
    const dimmed = highlightMode ? !highlighted && !selected : !relatedNodeIds.has(node.id) && !selected;
    return {
      ...node,
      style: {
        ...node.style,
        opacity: selected ? 1 : dimmed ? 0.15 : 1,
        border: selected ? "2px solid var(--graph-node-fg, #111827)" : node.style?.border,
        boxShadow: selected ? "0 10px 30px rgba(15, 23, 42, 0.22)" : node.style?.boxShadow
      }
    };
  });
  const edges = input.edges.map((edge) => {
    if (!needsEdgeStyle(edge)) return edge;  // 未命中 → 原引用
    const related = relatedNodeIds.has(edge.source) || relatedNodeIds.has(edge.target);
    const highlighted = highlightMode && (input.highlightedNodeIds!.has(edge.source) || input.highlightedNodeIds!.has(edge.target));
    const dimmed = highlightMode ? !highlighted && !related : !related;
    return {
      ...edge,
      style: {
        ...edge.style,
        opacity: dimmed ? 0.08 : 1,
        strokeWidth: highlighted ? 2.4 : 1
      }
    };
  });
  return { nodes, edges };
}

function buildCircularPositionMap(graph: ProjectGraphRecord) {
  const positions = new Map<string, GraphPosition>();
  const entities = [...graph.entities].sort(compareEntities);
  const [rootEntity, ...secondaryEntities] = entities;

  if (rootEntity) {
    positions.set(rootEntity.id, {
      x: -ENTITY_NODE_WIDTH / 2,
      y: -NODE_HEIGHT / 2,
      angle: -Math.PI / 2,
      radius: 0,
      root: true
    });
  }

  placeOnRings({
    ids: secondaryEntities.map((entity) => entity.id),
    positions,
    startRadius: ENTITY_RING_START_RADIUS,
    ringGap: ENTITY_RING_GAP,
    slotSpacing: ENTITY_SLOT_SPACING,
    nodeWidth: ENTITY_NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
    angleOffset: -Math.PI / 2
  });

  placeEventsOnOuterRings({
    events: graph.events,
    positions,
    angleOffset: EVENT_ANGLE_OFFSET
  });

  return positions;
}

function fallbackPosition(): GraphPosition {
  return {
    x: 0,
    y: 0,
    angle: 0,
    radius: 0
  };
}

function placeEventsOnOuterRings(input: {
  events: ProjectGraphEventRecord[];
  positions: Map<string, GraphPosition>;
  angleOffset: number;
}) {
  const sortedEvents = [...input.events].sort(compareEvents);
  const occupiedSlotsByRing = new Map<number, Set<number>>();

  for (let index = 0; index < sortedEvents.length; index += 1) {
    const event = sortedEvents[index];
    const desiredAngle = index * GOLDEN_ANGLE;
    const slot = findEventSlot({
      desiredAngle,
      angleOffset: input.angleOffset,
      occupiedSlotsByRing
    });
    const radius = EVENT_RING_START_RADIUS + slot.ring * EVENT_RING_GAP;
    const angle = input.angleOffset + (2 * Math.PI * slot.index) / slot.capacity;
    input.positions.set(event.id, {
      x: Math.cos(angle) * radius - EVENT_NODE_WIDTH / 2,
      y: Math.sin(angle) * radius - NODE_HEIGHT / 2,
      angle,
      radius
    });
  }
}

function findEventSlot(input: {
  desiredAngle: number;
  angleOffset: number;
  occupiedSlotsByRing: Map<number, Set<number>>;
}) {
  let ring = 0;
  while (true) {
    const radius = EVENT_RING_START_RADIUS + ring * EVENT_RING_GAP;
    const capacity = Math.max(8, Math.floor((2 * Math.PI * radius) / EVENT_SLOT_SPACING));
    const occupiedSlots = input.occupiedSlotsByRing.get(ring) ?? new Set<number>();
    const desiredSlot = modulo(
      Math.round(((input.desiredAngle - input.angleOffset) / (2 * Math.PI)) * capacity),
      capacity
    );
    const freeSlot = nearestFreeSlot(desiredSlot, capacity, occupiedSlots);
    if (freeSlot != null) {
      occupiedSlots.add(freeSlot);
      input.occupiedSlotsByRing.set(ring, occupiedSlots);
      return { ring, index: freeSlot, capacity };
    }
    ring += 1;
  }
}

function nearestFreeSlot(desiredSlot: number, capacity: number, occupiedSlots: Set<number>) {
  for (let distance = 0; distance < capacity; distance += 1) {
    const candidates = distance === 0 ? [desiredSlot] : [
      modulo(desiredSlot - distance, capacity),
      modulo(desiredSlot + distance, capacity)
    ];
    for (const candidate of candidates) {
      if (!occupiedSlots.has(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function modulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function placeOnRings(input: {
  ids: string[];
  positions: Map<string, GraphPosition>;
  startRadius: number;
  ringGap: number;
  slotSpacing: number;
  nodeWidth: number;
  nodeHeight: number;
  angleOffset: number;
}) {
  let index = 0;
  let ring = 0;

  while (index < input.ids.length) {
    const radius = input.startRadius + ring * input.ringGap;
    const capacity = Math.max(6, Math.floor((2 * Math.PI * radius) / input.slotSpacing));
    for (let slot = 0; slot < capacity && index < input.ids.length; slot += 1) {
      const id = input.ids[index];
      const angle = input.angleOffset + (2 * Math.PI * slot) / capacity;
      input.positions.set(id, {
        x: Math.cos(angle) * radius - input.nodeWidth / 2,
        y: Math.sin(angle) * radius - input.nodeHeight / 2,
        angle,
        radius
      });
      index += 1;
    }
    ring += 1;
  }

  return ring;
}

function compareEntities(a?: ProjectGraphEntityRecord, b?: ProjectGraphEntityRecord) {
  return (b?.eventCount ?? 0) - (a?.eventCount ?? 0) || (a?.name ?? "").localeCompare(b?.name ?? "");
}

function compareEvents(a?: ProjectGraphEventRecord, b?: ProjectGraphEventRecord) {
  return (a?.rank ?? 0) - (b?.rank ?? 0) || (a?.title ?? "").localeCompare(b?.title ?? "");
}

function MetricChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-2 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="ml-1 text-sm font-semibold">{value}</span>
    </div>
  );
}
