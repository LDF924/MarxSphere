// EventEntityGraphView.tsx — 检索路径图谱(G2 前端, 完整移植 Zleap source-graph/graph-canvas)
// 参照: zleap/apps/web/components/features/{source-graph,graph-canvas}.tsx
// 设计对齐(不简化):
//   - GraphCanvas: force/radial/tree 三布局 + d3-force 仿真 + 悬停高亮联动 + 全屏 + 点阵背景 + 图例
//   - 节点卡片: 事件(琥珀色实线/Sparkles)/实体(紫色虚线/Users), 与 Zleap 样式一致
//   - 边: 紫色半透明, 按方向计算 source/target handle(对齐 graphEdgeHandles)
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { ListTree, Maximize2, Minimize2, Orbit, RefreshCw, Share2, Sparkles, Users } from "lucide-react";

// ═══ 类型(对齐 Zleap GraphKind/GraphLayout/GraphPoint) ═══

export type GraphKind = "event" | "entity";
export type GraphLayout = "radial" | "tree" | "force";
export type GraphPoint = { x: number; y: number };
export type GraphSide = "top" | "right" | "bottom" | "left";

interface GraphNodeData extends Record<string, unknown> {
  kind: GraphKind;
  label: string;
  subtitle?: string;
}

export interface GraphNodeInput {
  id: string;
  kind: GraphKind;
  label: string;
  subtitle?: string;
}

export interface GraphEdgeInput {
  id: string;
  fromId: string;
  toId: string;
  method?: string;
  confidence?: number;
}

export const GRAPH_EDGE_TYPE: Record<GraphLayout, "straight" | "smoothstep"> = {
  radial: "straight",
  tree: "smoothstep",
  force: "straight",
};

const KIND_META: Record<GraphKind, { width: number; className: string; header: string }> = {
  event: {
    width: 196,
    className: "border-amber-500/30",
    header: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  },
  entity: {
    width: 148,
    className: "border-dashed border-violet-500/35",
    header: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
};

// ═══ 节点卡片(对齐 Zleap GraphNode) ═══

function GraphNodeCard({ data, selected }: NodeProps) {
  const node = data as GraphNodeData;
  const meta = KIND_META[node.kind];
  return (
    <div
      className={
        "relative cursor-grab overflow-hidden rounded-lg border bg-card shadow-sm transition-[box-shadow,border-color] hover:shadow-md " +
        meta.className +
        (selected ? " ring-2 ring-primary/45 ring-offset-2 ring-offset-background" : "")
      }
      style={{ width: meta.width }}
    >
      <GraphHandles />
      <div className={"flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium " + meta.header}>
        {node.kind === "event" ? <Sparkles className="size-3 shrink-0" /> : <Users className="size-3 shrink-0" />}
        {node.kind === "event" ? "事件" : "实体"}
      </div>
      <div className="px-2.5 py-2">
        <div className="line-clamp-2 text-xs font-medium leading-snug text-foreground" title={node.label}>
          {node.label}
        </div>
        {node.subtitle && (
          <div className="mt-1 truncate text-[10px] text-muted-foreground" title={node.subtitle}>
            {node.subtitle}
          </div>
        )}
      </div>
    </div>
  );
}

const nodeTypes = { eventEntityGraph: GraphNodeCard };

// ═══ 手柄(对齐 GraphHandles: 四向 target/source) ═══

const SIDES: Array<{ side: GraphSide; position: Position }> = [
  { side: "top", position: Position.Top },
  { side: "right", position: Position.Right },
  { side: "bottom", position: Position.Bottom },
  { side: "left", position: Position.Left },
];

function GraphHandles() {
  return (
    <>
      {SIDES.map(({ side, position }) => (
        <span key={side} style={{ display: "contents" }}>
          <Handle id={`target-${side}`} type="target" position={position} isConnectable={false} className="!size-2 !border-0 !bg-transparent !opacity-0" />
          <Handle id={`source-${side}`} type="source" position={position} isConnectable={false} className="!size-2 !border-0 !bg-transparent !opacity-0" />
        </span>
      ))}
    </>
  );
}

function sideFromVector(from: GraphPoint, to: GraphPoint): GraphSide {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function oppositeSide(side: GraphSide): GraphSide {
  if (side === "top") return "bottom";
  if (side === "bottom") return "top";
  if (side === "left") return "right";
  return "left";
}

function graphEdgeHandles(from: GraphPoint, to: GraphPoint) {
  const side = sideFromVector(from, to);
  return {
    sourceHandle: `source-${side}`,
    targetHandle: `target-${oppositeSide(side)}`,
  };
}

// ═══ 布局引擎(对齐 Zleap buildTreePositions/buildRadialPositions/buildNetwork) ═══

function eventNodeId(kind: GraphKind, id: string): string {
  return `${kind}-${id}`;
}

function linkedEventPositions(slice: { edges: GraphEdgeInput[] }, positions: Map<string, GraphPoint>, entityId: string) {
  return slice.edges
    .filter((e) => e.toId === entityId)
    .map((e) => positions.get(eventNodeId("event", e.fromId)))
    .filter((p): p is GraphPoint => Boolean(p));
}

function makeNodes(slice: { nodes: GraphNodeInput[] }, positions: Map<string, GraphPoint>): Node[] {
  const fallback = { x: 0, y: 0 };
  return slice.nodes.map((n) => ({
    id: eventNodeId(n.kind, n.id),
    type: "eventEntityGraph",
    position: positions.get(eventNodeId(n.kind, n.id)) ?? fallback,
    data: { kind: n.kind, label: n.label, subtitle: n.subtitle } satisfies GraphNodeData,
  }));
}

/** 关系类型 → 边色(Neo 源: RELATION=紫/LEAD_TO=青/CONTRAST=红/默认=紫) */
function edgeColorFor(method?: string) {
  const rel = (method || "").toUpperCase();
  if (rel.includes("RELATION") || rel.includes("MENTION")) return "hsl(263 55% 62% / 0.45)";
  if (rel.includes("LEAD") || rel.includes("CAUSE")) return "hsl(190 80% 62% / 0.45)";
  if (rel.includes("CONTRAST")) return "hsl(0 75% 65% / 0.45)";
  if (rel.includes("BELONG") || rel.includes("PART")) return "hsl(140 60% 55% / 0.45)";
  if (rel.includes("IS_A")) return "hsl(45 85% 60% / 0.45)";
  if (rel.includes("REQUIRE")) return "hsl(280 60% 65% / 0.45)";
  return "hsl(263 55% 58% / 0.38)";
}

function makeEdges(slice: { edges: GraphEdgeInput[] }, positions: Map<string, GraphPoint>, layout: GraphLayout): Edge[] {
  return slice.edges.map((e) => {
    const source = eventNodeId("event", e.fromId);
    const target = eventNodeId("entity", e.toId);
    const from = positions.get(source) ?? { x: 0, y: 0 };
    const to = positions.get(target) ?? { x: 0, y: 0 };
    return {
      id: e.id,
      source,
      target,
      ...graphEdgeHandles(from, to),
      type: GRAPH_EDGE_TYPE[layout],
      interactionWidth: 14,
      style: { stroke: edgeColorFor(e.method), strokeWidth: 1.25 },
      label: e.method ? `${e.method}${e.confidence != null ? ` ${(e.confidence * 100).toFixed(0)}%` : ""}` : undefined,
      labelStyle: { fontSize: 9, fill: "hsl(263 55% 58% / 0.6)" },
    };
  });
}

function buildTreePositions(slice: { nodes: GraphNodeInput[]; edges: GraphEdgeInput[] }) {
  const positions = new Map<string, GraphPoint>();
  const events = slice.nodes.filter((n) => n.kind === "event");
  const entities = slice.nodes.filter((n) => n.kind === "entity");
  const eventGap = 260;
  const eventStart = -((events.length - 1) * eventGap) / 2;
  events.forEach((event, index) => {
    positions.set(eventNodeId("event", event.id), { x: eventStart + index * eventGap, y: 0 });
  });
  const sorted = entities
    .map((entity) => {
      const linked = linkedEventPositions(slice, positions, entity.id);
      return {
        entity,
        desiredX: linked.length ? linked.reduce((sum, p) => sum + p.x, 0) / linked.length : 0,
      };
    })
    .sort((a, b) => a.desiredX - b.desiredX || a.entity.label.localeCompare(b.entity.label));
  let previousX = -Infinity;
  sorted.forEach(({ entity, desiredX }) => {
    const x = Math.max(desiredX, previousX + 174);
    previousX = x;
    positions.set(eventNodeId("entity", entity.id), { x, y: 310 });
  });
  if (sorted.length > 0) {
    const first = positions.get(eventNodeId("entity", sorted[0].entity.id))?.x ?? 0;
    const last = positions.get(eventNodeId("entity", sorted[sorted.length - 1].entity.id))?.x ?? 0;
    const offset = (first + last) / 2;
    sorted.forEach(({ entity }) => {
      const id = eventNodeId("entity", entity.id);
      const position = positions.get(id);
      if (position) positions.set(id, { ...position, x: position.x - offset });
    });
  }
  return positions;
}

function normalizeAngle(angle: number) {
  const tau = Math.PI * 2;
  return ((angle % tau) + tau) % tau;
}

function buildRadialPositions(slice: { nodes: GraphNodeInput[]; edges: GraphEdgeInput[] }) {
  const tau = Math.PI * 2;
  const positions = new Map<string, GraphPoint>();
  const events = slice.nodes.filter((n) => n.kind === "event");
  const entities = slice.nodes.filter((n) => n.kind === "entity");
  const eventCount = events.length;
  const eventRadius = eventCount <= 1 ? 0 : Math.max(250, (eventCount * 220 * 1.16) / tau);
  const eventAngles = new Map<string, number>();
  events.forEach((event, index) => {
    const angle = -Math.PI / 2 + (index * tau) / Math.max(eventCount, 1);
    eventAngles.set(event.id, angle);
    positions.set(eventNodeId("event", event.id), {
      x: Math.cos(angle) * eventRadius,
      y: Math.sin(angle) * eventRadius,
    });
  });
  const sorted = entities
    .map((entity, index) => {
      const angles = slice.edges
        .filter((e) => e.toId === entity.id)
        .map((e) => eventAngles.get(e.fromId))
        .filter((a): a is number => a != null);
      const desired = angles.length
        ? Math.atan2(
            angles.reduce((sum, a) => sum + Math.sin(a), 0),
            angles.reduce((sum, a) => sum + Math.cos(a), 0),
          )
        : -Math.PI / 2 + (index * tau) / Math.max(entities.length, 1);
      return { entity, angle: normalizeAngle(desired) };
    })
    .sort((a, b) => a.angle - b.angle || a.entity.label.localeCompare(b.entity.label));
  const minGap = Math.min(0.18, (tau * 0.88) / Math.max(entities.length, 1));
  let previousAngle = -Infinity;
  sorted.forEach((item) => {
    item.angle = Math.max(item.angle, previousAngle + minGap);
    previousAngle = item.angle;
  });
  if (sorted.length && sorted[sorted.length - 1].angle - sorted[0].angle > tau - minGap) {
    const start = sorted[0].angle;
    sorted.forEach((item, index) => {
      item.angle = start + (index * tau) / sorted.length;
    });
  }
  const entityRadius = Math.max(360, eventRadius + 390);
  sorted.forEach(({ entity, angle }) => {
    positions.set(eventNodeId("entity", entity.id), {
      x: Math.cos(angle) * entityRadius,
      y: Math.sin(angle) * entityRadius,
    });
  });
  return positions;
}

function collisionRadius(kind: GraphKind) {
  return kind === "event" ? 126 : 80;
}

function buildNetwork(slice: { nodes: GraphNodeInput[]; edges: GraphEdgeInput[] }, layout: GraphLayout): { nodes: Node[]; edges: Edge[] } {
  if (layout === "tree") {
    const positions = buildTreePositions(slice);
    return { nodes: makeNodes(slice, positions), edges: makeEdges(slice, positions, layout) };
  }
  const radialPositions = buildRadialPositions(slice);
  const radialNodes = makeNodes(slice, radialPositions);
  if (layout === "radial") {
    return { nodes: radialNodes, edges: makeEdges(slice, radialPositions, layout) };
  }
  // force: d3-force 仿真(对齐 Zleap 参数)
  type SimNode = SimulationNodeDatum & { id: string; kind: GraphKind };
  const degree = new Map<string, number>();
  slice.edges.forEach((e) => {
    const event = eventNodeId("event", e.fromId);
    const entity = eventNodeId("entity", e.toId);
    degree.set(event, (degree.get(event) ?? 0) + 1);
    degree.set(entity, (degree.get(entity) ?? 0) + 1);
  });
  const simNodes: SimNode[] = radialNodes.map((node) => ({
    id: node.id,
    kind: (node.data as GraphNodeData).kind,
    x: (node.position.x ?? 0) * 0.48,
    y: (node.position.y ?? 0) * 0.48,
  }));
  const seedEdges = makeEdges(slice, radialPositions, "force");
  const simLinks: SimulationLinkDatum<SimNode>[] = seedEdges.map((edge) => ({
    source: edge.source,
    target: edge.target,
  }));
  // 大图降级为径向布局(对齐 Zleap: force 仿真 O(n²) 阈值 280)
  if (simNodes.length > 280) {
    return { nodes: radialNodes, edges: makeEdges(slice, radialPositions, layout) };
  }
  const simulation = forceSimulation<SimNode>(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
        .id((node) => node.id)
        .distance((link) => {
          const source = typeof link.source === "object" ? link.source.id : String(link.source);
          const target = typeof link.target === "object" ? link.target.id : String(link.target);
          return 164 + Math.min(64, Math.max(degree.get(source) ?? 1, degree.get(target) ?? 1) * 3.5);
        })
        .strength(0.46),
    )
    .force("charge", forceManyBody<SimNode>().strength((node) => (node.kind === "event" ? -430 : -135)).distanceMax(1500))
    .force("collide", forceCollide<SimNode>((node) => collisionRadius(node.kind)).strength(0.96).iterations(4))
    .force("x", forceX<SimNode>(0).strength((node) => (node.kind === "event" ? 0.028 : 0.018)))
    .force("y", forceY<SimNode>(0).strength((node) => (node.kind === "event" ? 0.028 : 0.018)))
    .stop();
  for (let index = 0; index < 340; index += 1) simulation.tick();
  const positions = new Map(simNodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
  return { nodes: makeNodes(slice, positions), edges: makeEdges(slice, positions, layout) };
}

/**
 * 异步力导向布局: 340 次 force tick 同步执行会阻塞主线程(实测首帧
 * 800ms 卡顿)。改为 rAF 分帧计算(每帧最多 24 tick),期间调用方先用
 * 径向布局占位,完成后通过 onSettled 回调一次性替换,避免中间态抖动。
 */
function computeForceLayoutAsync(
  slice: { nodes: GraphNodeInput[]; edges: GraphEdgeInput[] },
  radialNodes: Node[],
  radialPositions: Map<string, GraphPoint>,
  layout: GraphLayout,
  onSettled: (network: { nodes: Node[]; edges: Edge[] }) => void,
): () => void {
  type SimNode = SimulationNodeDatum & { id: string; kind: GraphKind };
  const degree = new Map<string, number>();
  slice.edges.forEach((e) => {
    const event = eventNodeId("event", e.fromId);
    const entity = eventNodeId("entity", e.toId);
    degree.set(event, (degree.get(event) ?? 0) + 1);
    degree.set(entity, (degree.get(entity) ?? 0) + 1);
  });
  const simNodes: SimNode[] = radialNodes.map((node) => ({
    id: node.id,
    kind: (node.data as GraphNodeData).kind,
    x: (node.position.x ?? 0) * 0.48,
    y: (node.position.y ?? 0) * 0.48,
  }));
  const seedEdges = makeEdges(slice, radialPositions, "force");
  const simLinks: SimulationLinkDatum<SimNode>[] = seedEdges.map((edge) => ({
    source: edge.source,
    target: edge.target,
  }));
  if (simNodes.length > 280) {
    onSettled({ nodes: radialNodes, edges: makeEdges(slice, radialPositions, layout) });
    return () => undefined;
  }
  const simulation = forceSimulation<SimNode>(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
        .id((node) => node.id)
        .distance((link) => {
          const source = typeof link.source === "object" ? link.source.id : String(link.source);
          const target = typeof link.target === "object" ? link.target.id : String(link.target);
          return 164 + Math.min(64, Math.max(degree.get(source) ?? 1, degree.get(target) ?? 1) * 3.5);
        })
        .strength(0.46),
    )
    .force("charge", forceManyBody<SimNode>().strength((node) => (node.kind === "event" ? -430 : -135)).distanceMax(1500))
    .force("collide", forceCollide<SimNode>((node) => collisionRadius(node.kind)).strength(0.96).iterations(4))
    .force("x", forceX<SimNode>(0).strength((node) => (node.kind === "event" ? 0.028 : 0.018)))
    .force("y", forceY<SimNode>(0).strength((node) => (node.kind === "event" ? 0.028 : 0.018)))
    .stop();
  let ticks = 0;
  let frame = 0;
  const TICKS_PER_FRAME = 24;
  const step = () => {
    const batch = Math.min(24, 340 - ticks);
    for (let index = 0; index < batch; index += 1) simulation.tick();
    ticks += batch;
    if (ticks < 340) {
      frame = window.requestAnimationFrame(step);
      return;
    }
    const positions = new Map(simNodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
    onSettled({ nodes: makeNodes(slice, positions), edges: makeEdges(slice, positions, layout) });
  };
  frame = window.requestAnimationFrame(step);
  return () => window.cancelAnimationFrame(frame);
}

// ═══ GraphCanvas(对齐 Zleap: 三布局切换/悬停高亮/全屏/点阵/图例) ═══

function FitViewOnChange({ nodes, edges, refreshKey, padding, minZoom }: {
  nodes: Node[]; edges: Edge[]; refreshKey: unknown; padding: number; minZoom: number;
}) {
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (!initialized || nodes.length === 0) return;
    let frame = 0;
    const timers: number[] = [];
    frame = window.requestAnimationFrame(() => {
      fitView({ padding, duration: 0, minZoom, maxZoom: 1.05 });
      timers.push(window.setTimeout(() => fitView({ padding, duration: 260, minZoom, maxZoom: 1.05 }), 120));
    });
    return () => {
      window.cancelAnimationFrame(frame);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [edges, fitView, initialized, minZoom, nodes, padding, refreshKey]);
  return null;
}

const LAYOUT_ICON: Record<GraphLayout, React.ReactNode> = {
  radial: <Orbit className="size-3.5" />,
  tree: <ListTree className="size-3.5" />,
  force: <Share2 className="size-3.5" />,
};

const LAYOUT_LABEL: Record<GraphLayout, string> = {
  radial: "径向",
  tree: "树形",
  force: "力导向",
};

export function EventEntityGraphView({ nodes, edges, height, onNodeClick }: {
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
  height?: number;
  onNodeClick?: (nodeId: string) => void;
}) {
  const [layout, setLayout] = useState<GraphLayout>("force");
  const [expanded, setExpanded] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const slice = useMemo(() => ({ nodes, edges }), [nodes, edges]);
  const network = useMemo(() => buildNetwork(slice, layout), [slice, layout]);
  // 力导向布局异步分帧: 先用径向占位(0 阻塞), force 计算完成后一次性替换。
  // buildNetwork 同步路径保留(布局切换/树形/径向即时), 异步仅用于 force 首算。
  const [forceNetwork, setForceNetwork] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  useEffect(() => {
    if (layout !== "force") { setForceNetwork(null); return; }
    let cancelled = false;
    const radialPositions = buildRadialPositions(slice);
    const radialNodes = makeNodes(slice, radialPositions);
    // 大图直接径向, 不启动异步
    if (radialNodes.length > 280) return;
    const cancel = computeForceLayoutAsync(
      slice,
      radialNodes,
      radialPositions,
      "force",
      (settled) => { if (!cancelled) setForceNetwork(settled); },
    );
    return () => { cancelled = true; cancel(); };
  }, [layout, slice]);
  const resolvedNetwork = layout === "force" && forceNetwork ? forceNetwork : network;
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(resolvedNetwork.nodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(resolvedNetwork.edges);
  const [positionVersion, setPositionVersion] = useState(0);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    setFlowNodes(resolvedNetwork.nodes);
    setFlowEdges(resolvedNetwork.edges);
    setHoveredNodeId(null);
  }, [resolvedNetwork.nodes, resolvedNetwork.edges, setFlowNodes, setFlowEdges]);

  const resetPositions = () => {
    setFlowNodes(resolvedNetwork.nodes);
    setHoveredNodeId(null);
    setPositionVersion((v) => v + 1);
  };

  const eventCount = nodes.filter((n) => n.kind === "event").length;
  const entityCount = nodes.filter((n) => n.kind === "entity").length;

  return (
    <div className={"relative overflow-hidden rounded-lg border bg-card/40 " + (expanded ? "fixed inset-4 z-50 bg-card shadow-xl" : height !== undefined ? "" : "h-full")} style={expanded || height === undefined ? undefined : { height }}>
      {/* 图例 */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-lg border bg-card/95 px-2.5 py-2 shadow-sm backdrop-blur-sm">
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="size-2 rounded-full bg-amber-500" /> 事件 {eventCount}
          </span>
          <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="size-2 rounded-full bg-violet-500" /> 实体 {entityCount}
          </span>
          <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="size-2 rounded-full bg-purple-500/40" /> 关系 {edges.length}
          </span>
        </div>
      </div>

      {/* 工具栏 */}
      <div className="absolute right-3 top-3 z-20 flex flex-wrap items-center justify-end gap-1.5">
        <div className="flex rounded-md border bg-card/95 shadow-sm backdrop-blur-sm">
          {(["force", "radial", "tree"] as GraphLayout[]).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLayout(l)}
              title={LAYOUT_LABEL[l]}
              className={
                "grid size-8 place-items-center transition-colors " +
                (layout === l ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")
              }
            >
              {LAYOUT_ICON[l]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={resetPositions}
          disabled={nodes.length === 0}
          className="grid size-8 place-items-center rounded-md border bg-card/95 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          title="重置布局"
        >
          <RefreshCw className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="grid size-8 place-items-center rounded-md border bg-card/95 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground"
          title={expanded ? "退出全屏" : "全屏"}
        >
          {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
      </div>

      {mounted && resolvedNetwork.nodes.length > 0 ? (
        <div style={expanded ? { height: "calc(100vh - 2rem)" } : undefined} className={expanded ? "" : "h-full"}>
        <ReactFlow
          key={`${expanded}-${resolvedNetwork.edges.length}`}
          nodes={flowNodes}
          edges={flowEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          nodeOrigin={[0.5, 0.5]}
          fitView
          fitViewOptions={{ padding: 0.2, minZoom: 0.2, maxZoom: 1.05 }}
          minZoom={0.16}
          maxZoom={1.7}
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          nodesConnectable={false}
          onNodeClick={(_e, node) => onNodeClick?.(node.id)}
          onNodeMouseEnter={(_e, node) => setHoveredNodeId(node.id)}
          onNodeMouseLeave={() => setHoveredNodeId(null)}
          onPaneClick={() => setHoveredNodeId(null)}
        >
          <FitViewOnChange
            nodes={resolvedNetwork.nodes}
            edges={resolvedNetwork.edges}
            refreshKey={`${expanded}-${layout}-${positionVersion}`}
            padding={0.2}
            minZoom={0.2}
          />
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="!bg-transparent" />
          <Controls showInteractive={false} />
        </ReactFlow>
        </div>
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-card/20 text-xs text-muted-foreground">
          {nodes.length === 0 ? "无图谱数据" : "渲染中…"}
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-md border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur-sm">
        {LAYOUT_ICON[layout]}
        {LAYOUT_LABEL[layout]}布局
      </div>
    </div>
  );
}
