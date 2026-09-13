<script setup lang="ts">
/**
 * AgentFlowCanvas — 还原自闭源 AgentFlowCanvas(L13526-14200, data-v-0bebca05)
 * 用 npm @vue-flow/core(闭源 L1-13472 即库本体); 布局: 顺序横排 + module 类节点下排
 * 三色边体系: agent-edge-(自动链)/manual-edge-(用户拖); active 目标 → #7184f5 2.4px animated
 */
import { ref, computed, watch, onMounted } from "vue";
import { VueFlow, type Node, type Connection, type EdgeChange, type NodeChange } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { MiniMap } from "@vue-flow/minimap";
import { Controls } from "@vue-flow/controls";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import AgentFlowNode from "./AgentFlowNode.vue";

export interface BizNode {
  id: string;
  title: string;
  module: string;
  index?: string;
  state?: string;
  stateLabel?: string;
  input?: string;
  output?: string;
  progress?: number;
  standalone?: boolean;
  systemStart?: boolean;
  canvasPosition?: { x: number; y: number };
  hint?: string;
  executionDetail?: string;
  outputPreview?: string;
  artifactCount?: number;
  /** V415: 该节点对应哪个编排能力(来自 /api/orchestrator/capabilities) */
  capabilityId?: string;
  /** V415: 节点参数(覆盖能力默认值; 渲染 {{outputs.x}} / {{inputs}} 模板) */
  params?: Record<string, unknown>;
  /** V415: 产物落点(前端"产物"面板跳转到对应工作台) */
  artifact?: { where: string; label: string };
}

const props = defineProps<{
  nodes: BizNode[];
  edges: Array<{ id: string; source: string; target: string; type?: string }>;
  editable?: boolean;
  locked?: boolean;
}>();
const emit = defineEmits<{
  (e: "node-selected", node: BizNode): void;
  (e: "graph-changed", payload: { edges: Array<{ id: string; source: string; target: string }> }): void;
  (e: "pane-context-menu", payload: { event: MouseEvent; position: { x: number; y: number } }): void;
  (e: "node-context-menu", payload: { event: MouseEvent; position: { x: number; y: number }; node: BizNode }): void;
  (e: "nodes-moved", payload: { id: string; position: { x: number; y: number } }): void;
  /** V415: 把能力面板拖进来的节点投放(带画布坐标) */
  (e: "capability-dropped", payload: { capabilityId: string; position: { x: number; y: number } }): void;
}>();

// 宽松类型: @vue-flow 泛型嵌套深, 运行时结构固定(库接受结构兼容对象)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const flowNodes = ref<any[]>([]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const flowEdges = ref<any[]>([]);

// ── 布局: 主流程横排层距 230; standalone 下排 ──
// V415: 节点位置优先用节点自带 canvasPosition(用户拖动过 / 保存的图), 否则按序号自动排。
// 旧实现无条件覆盖成 (i*230, 60) —— 拖动后一保存就弹回原位, 而且从池里恢复的 iframe
// 重新挂载时位置也会丢。
function buildLayout() {
  const main = props.nodes.filter((n) => !n.standalone);
  const mods = props.nodes.filter((n) => n.standalone);
  // 自动布局兜底: 主流程一行、standalone 一行
  const autoMainY = 60;
  const autoModY = main.length ? 340 : 60;
  const posOf = (n: BizNode, fallbackX: number, fallbackY: number) =>
    n.canvasPosition && Number.isFinite(n.canvasPosition.x) && Number.isFinite(n.canvasPosition.y)
      ? { x: n.canvasPosition.x, y: n.canvasPosition.y }
      : { x: fallbackX, y: fallbackY };
  flowNodes.value = [
    ...main.map((n, i) => ({
      id: `agent-${n.id}`,
      type: "agent",
      position: posOf(n, i * 230 + 40, autoMainY),
      data: n
    })),
    ...mods.map((n, i) => ({
      id: `agent-${n.id}`,
      type: "agent",
      position: posOf(n, i * 230 + 40, autoModY),
      data: n
    }))
  ];
  // 边: **以 props.edges 为唯一真源**。
  // V415 修复: 旧实现只渲染 userEdges(手动拖的), props.edges 被完全忽略 —— 用手动链兜底。
  //   后果是模板/已保存图里的连线一条都看不见(实测: 多源检索汇编 8 条边只渲染出 5 条自动链),
  //   而边在后端就是依赖本体, 看不见等于用户不知道会跑成什么样。
  //   现在由上层持有边并回传, 本组件只负责渲染与"新连线/删连线"的上报。
  flowEdges.value = (props.edges ?? []).map((e) => {
    const targetState = props.nodes.find((n) => n.id === e.target)?.state;
    const running = targetState === "running";
    return {
      id: `edge-${e.source}-${e.target}`,
      source: `agent-${e.source}`,
      target: `agent-${e.target}`,
      type: "default",
      markerEnd: "arrowclosed",
      animated: running,
      style: running ? { stroke: "#7184f5", strokeWidth: 2.4 } : { stroke: "#a6b2cf", strokeWidth: 1.8 }
    };
  });
}

// node-types: 自定义节点(库类型约束与 Vue 组件实例不兼容 → never 桥接)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const agentNodeTypes = { agent: AgentFlowNode } as any;

// ── 右键菜单(闭源: pane 空白右键 → 模块列表; node 右键 → 详情/删除) ──
const canvasEl = ref<HTMLElement | null>(null);
/** flow 坐标换算(screenToFlowCoordinate 需库实例; 简化: 相对画布 px 直接给菜单定位) */
function relPos(ev: MouseEvent) {
  const rect = canvasEl.value?.getBoundingClientRect();
  return {
    x: ev.clientX - (rect?.left ?? 0),
    y: ev.clientY - (rect?.top ?? 0)
  };
}
function onPaneContextMenu(ev: MouseEvent) {
  if (!props.editable || props.locked) return;
  ev.preventDefault();
  emit("pane-context-menu", { event: ev, position: relPos(ev) });
}
function onNodeContextMenu(ev: MouseEvent, biz: BizNode) {
  if (!props.editable || props.locked) return;
  ev.preventDefault();
  emit("node-context-menu", { event: ev, position: relPos(ev), node: biz });
}

// ── 节点点击 → 原对象 ──
function onNodeClick(event: { node: Node }) {
  const biz = (event.node.data ?? {}) as BizNode;
  emit("node-selected", biz);
}

// ── 手动连线(环路防护: BFS 可达检查) ──
function onConnect(conn: Connection) {
  if (!props.editable || props.locked) return;
  const src = String(conn.source ?? "").replace(/^agent-/, "");
  const tgt = String(conn.target ?? "").replace(/^agent-/, "");
  if (!src || !tgt || src === tgt) return;
  if (props.edges.some((e) => e.source === src && e.target === tgt)) return; // 去重
  if (wouldCycle(tgt, src)) return;
  // 上报给上层, 由上层更新 props.edges 回传(边是真源在上层; 见 buildLayout 的说明)
  emit("graph-changed", {
    edges: [...props.edges, { source: src, target: tgt }].map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
  });
}
function wouldCycle(from: string, to: string): boolean {
  const adj = new Map<string, string[]>();
  for (const e of props.edges) {
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
  }
  const seen = new Set<string>();
  const q = [from];
  while (q.length) {
    const cur = q.shift()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nx of adj.get(cur) ?? []) q.push(nx);
  }
  return false;
}

// ── 删除边 ──
function onEdgesChange(changes: EdgeChange[]) {
  for (const ch of changes) {
    if (ch.type === "remove") {
      // 边 id 形如 edge-<source>-<target>(见 buildLayout); 节点 id 不含 "-"? 有可能,
      // 所以按"去掉前缀后逐个匹配已知边"来还原, 而不是 split("-")
      const rid = String(ch.id);
      if (!rid.startsWith("edge-")) continue;
      const rest = rid.slice(5);
      const hit = props.edges.find((e) => rest === `${e.source}-${e.target}`);
      if (!hit) continue;
      emit("graph-changed", {
        edges: props.edges.filter((e) => e !== hit).map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
      });
    }
  }
}
function onNodesChange(changes: NodeChange[]) {
  // V415: 只上报拖拽结束的位置变化(旧实现整个忽略 → 位置从不持久化, 保存/重进就弹回自动布局)
  for (const ch of changes) {
    if (ch.type === "position" && ch.position && !ch.dragging) {
      emit("nodes-moved", { id: String(ch.id).replace(/^agent-/, ""), position: { x: ch.position.x, y: ch.position.y } });
    }
  }
}

/** V415: 能力面板拖放 —— 把屏幕坐标换成画布坐标后交给上层建节点 */
function onDrop(ev: DragEvent) {
  if (!props.editable || props.locked) return;
  const capabilityId = ev.dataTransfer?.getData("application/x-orch-capability") || ev.dataTransfer?.getData("text/plain") || "";
  if (!capabilityId) return;
  ev.preventDefault();
  const rect = canvasEl.value?.getBoundingClientRect();
  // 屏幕 → 画布坐标: vue-flow 的投影在同一元素坐标系内; 页面滚动由 vue-flow 自己管, 这里用相对位置近似
  emit("capability-dropped", {
    capabilityId,
    position: { x: (ev.clientX - (rect?.left ?? 0)) * 0.72, y: (ev.clientY - (rect?.top ?? 0)) * 0.72 },
  });
}
function onDragOver(ev: DragEvent) {
  if (!props.editable || props.locked) return;
  // 必须 preventDefault 才允许 drop
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
}

watch(
  () => [props.nodes, props.edges] as const,
  () => buildLayout(),
  { deep: true }
);
onMounted(() => buildLayout());

const nodeColor = (n: Node) => {
  const st = (n.data as BizNode | undefined)?.state;
  if (st === "running") return "#7184f5";
  if (st === "completed") return "#5FD0B4";
  return "#c3ccdc";
};
</script>

<template>
  <div ref="canvasEl" class="agent-flow-canvas" :class="{ 'is-locked': locked }" @contextmenu.prevent="onPaneContextMenu" @drop="onDrop" @dragover="onDragOver">
    <VueFlow
      v-model:nodes="flowNodes"
      v-model:edges="flowEdges"
      :node-types="agentNodeTypes"
      :nodes-draggable="editable && !locked"
      :nodes-connectable="editable && !locked"
      :edges-updatable="editable && !locked"
      :min-zoom="0.35"
      :max-zoom="1.8"
      :fit-view-on-init="true"
      @node-click="onNodeClick"
      @node-context-menu="(ev: any) => onNodeContextMenu(ev?.event as MouseEvent, (ev?.node?.data ?? ev?.node) as BizNode)"
      @connect="onConnect"
      @edges-change="onEdgesChange"
      @nodes-change="onNodesChange"
    >
      <Background pattern-color="#c3d4e8" :gap="24" />
      <MiniMap :node-color="nodeColor" pannable zoomable />
      <Controls />
    </VueFlow>
    <div class="flow-toolbar">
      <span class="flow-zone-chip">标准工作流 · 主流程</span>
    </div>
  </div>
</template>

<style scoped>
.agent-flow-canvas {
  position: relative;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: #0D1626;
  font-family: PingFang SC, Microsoft YaHei, sans-serif;
}
.flow-toolbar {
  position: absolute;
  z-index: 4;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 14px;
  border-bottom: 1px solid rgba(190, 211, 229, 0.8);
  background: rgba(13, 21, 36, 0.94);
  pointer-events: none;
}
.flow-zone-chip {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 0 8px;
  border-left: 2px solid #43C9CD;
  color: #9FB0C6;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
:deep(.vue-flow__background) { background: #0D1626; }
:deep(.vue-flow__minimap) { right: 12px; bottom: 12px; border: 1px solid #46587A; border-radius: 5px; }
:deep(.vue-flow__controls-button) { width: 26px; height: 26px; border-bottom-color: #e4e8f0; background: #11192C; }
:deep(.vue-flow__node) { cursor: grab; }
</style>
