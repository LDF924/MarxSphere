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
}>();

// 宽松类型: @vue-flow 泛型嵌套深, 运行时结构固定(库接受结构兼容对象)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const flowNodes = ref<any[]>([]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const flowEdges = ref<any[]>([]);
interface BizEdge {
  id: string;
  source: string;
  target: string;
}
const userEdges = ref<BizEdge[]>([]);

// ── 布局: 主流程横排层距 230; standalone 下排 ──
function buildLayout() {
  const main = props.nodes.filter((n) => !n.standalone);
  const mods = props.nodes.filter((n) => n.standalone);
  flowNodes.value = [
    ...main.map((n, i) => ({
      id: `agent-${n.id}`,
      type: "agent",
      position: { x: i * 230 + 40, y: 60 },
      data: n
    })),
    ...mods.map((n, i) => ({
      id: `agent-${n.id}`,
      type: "agent",
      position: { x: i * 230 + 40, y: main.length ? 340 : 60 },
      data: n
    }))
  ];
  // 边: 用户边(agent- 映射)优先; 无则主流程自动链
  if (userEdges.value.length) {
    flowEdges.value = userEdges.value.map(
      (e) => ({
        id: `manual-edge-${e.id}`,
        source: `agent-${e.source}`,
        target: `agent-${e.target}`,
        type: "default",
        markerEnd: "arrowclosed",
        animated: false,
        style: { stroke: "#a6b2cf", strokeWidth: 1.8 }
      })
    );
  } else {
    flowEdges.value = main.slice(0, -1).map(
      (n, i) => ({
        id: `agent-edge-${n.id}-${main[i + 1].id}`,
        source: `agent-${n.id}`,
        target: `agent-${main[i + 1].id}`,
        type: "default",
        markerEnd: "arrowclosed",
        animated: main[i + 1].state === "running",
        style: main[i + 1].state === "running" ? { stroke: "#7184f5", strokeWidth: 2.4 } : { stroke: "#a6b2cf", strokeWidth: 1.8 }
      })
    );
  }
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
  // 自环/成环: BFS 从 tgt 沿现有边找 src
  if (wouldCycle(tgt, src)) return;
  const eid = `${Date.now()}`;
  userEdges.value.push({ id: eid, source: src, target: tgt });
  buildLayout();
  emitGraphChanged();
}
function wouldCycle(from: string, to: string): boolean {
  const adj = new Map<string, string[]>();
  for (const e of userEdges.value) {
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
function emitGraphChanged() {
  emit("graph-changed", {
    edges: userEdges.value.map((e) => ({ ...e, type: "manual" }))
  });
}

// ── 删除边(仅手动) ──
function onEdgesChange(changes: EdgeChange[]) {
  for (const ch of changes) {
    if (ch.type === "remove") {
      const idx = userEdges.value.findIndex((e) => `manual-edge-${e.id}` === ch.id);
      if (idx >= 0) {
        userEdges.value.splice(idx, 1);
        buildLayout();
        emitGraphChanged();
      }
    }
  }
}
function onNodesChange(_changes: NodeChange[]) {
  /* 位置持久化在 graph-changed 由 QuickModeView 处理; 此处忽略 */
}

watch(
  () => [props.nodes, props.edges, userEdges.value.length] as const,
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
  <div ref="canvasEl" class="agent-flow-canvas" :class="{ 'is-locked': locked }" @contextmenu.prevent="onPaneContextMenu">
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
