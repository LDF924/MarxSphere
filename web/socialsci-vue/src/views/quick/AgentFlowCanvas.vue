<script setup lang="ts">
/**
 * AgentFlowCanvas — 还原自闭源 AgentFlowCanvas(L13526-14200, data-v-0bebca05)
 * 用 npm @vue-flow/core(闭源 L1-13472 即库本体); 布局: 顺序横排 + module 类节点下排
 * 三色边体系: agent-edge-(自动链)/manual-edge-(用户拖); active 目标 → #7184f5 2.4px animated
 */
import { ref, computed, provide, watch, onMounted } from "vue";
import { VueFlow, type Node, type Connection, type EdgeChange, type NodeChange } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { MiniMap } from "@vue-flow/minimap";
import { Controls } from "@vue-flow/controls";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import AgentFlowNode from "./AgentFlowNode.vue";
import { ORCH_NODE_ACTIONS, type OrchNodeActions } from "./orchNodeActions";


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
  /** V415: 节点卡片右上角的 ••• 与"待执行"右边的 → (与右键菜单/详情面板同一入口) */
  (e: "node-menu", payload: { event: MouseEvent; position: { x: number; y: number }; node: BizNode }): void;
  /** V415: 选中小红叉点了 —— 交给上层真正删节点(节点数组的主人在上层) */
  (e: "node-delete", payload: { id: string }): void;
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
/**
 * 屏幕坐标 → 画布容器内坐标(定位右键菜单用)。
 *
 * 刻意**不**做 flow 坐标换算: 读 .vue-flow__pane 上的 zoom/pan 再反算, 会因为菜单元素
 * 定位在容器 padding box 而同 vue-flow 的坐标系差一个 padding 偏移 —— 实测 fitView
 * 缩放 0.667 / 平移 (0,63) 时反算点落在点击点上方 40px(等于容器 padding-top 40)。
 * 菜单只需要"贴住鼠标", 容器内相对坐标就是正确目标。
 * 拖放落点才需要 flow 坐标, 那是另一回事: 见 onDrop。
 */
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
  ev.stopPropagation();
  emit("pane-context-menu", { event: ev, position: relPos(ev) });
}
function onNodeContextMenu(ev: MouseEvent, biz: BizNode) {
  if (!props.editable || props.locked) return;
  ev.preventDefault();
  // V415 修复: 必须 stopPropagation —— 节点在画布容器内部, 容器上的 @contextmenu 会**接着**触发,
  // 把"节点菜单"覆盖成"空白处菜单"。实测症状: 右键节点弹出的标题是「添加节点」,
  // 于是节点上的「删除节点」永远点不到(用户报的"删除节点这能力居然不存在"就是它)。
  ev.stopPropagation();
  emit("node-context-menu", { event: ev, position: relPos(ev), node: biz });
}

// ── 节点上的 ••• 菜单 / → 展开 ──
/**
 * 这两个标记在 AgentFlowNode 的模板里(闭源里它们是可点入口), 之前点了完全没反应。
 *
 * 关键坑: 自定义节点是 VueFlow **内部**渲染的, 它 emit 的事件只会传给 VueFlow 的节点包装器,
 * **到不了我在 <VueFlow> 上写的 @node-menu 监听**(Vue 的 emit 只向直接父组件投递)。
 * 实测: 遍历 DOM 能看到 clickHandler 已绑定、元素也能命中, 但菜单就是不出现。
 * 所以这里用 provide/inject 把回调直接递进节点组件, 不依赖事件冒泡。
 */
const nodeActions = {
  menu: (ev: MouseEvent, biz: BizNode) => {
    if (props.locked) return;
    ev.preventDefault();
    emit("node-menu", { event: ev, position: relPos(ev), node: biz });
  },
  open: (ev: MouseEvent, biz: BizNode) => {
    if (props.locked) return;
    ev.preventDefault();
    emit("node-selected", biz);
  },
};
provide(ORCH_NODE_ACTIONS, nodeActions);

// ── 节点点击 → 原对象 ──
function onNodeClick(event: { node: Node }) {
  const biz = (event.node.data ?? {}) as BizNode;
  selectedEdgeKey.value = "";
  selectedNodeId.value = biz.id;
  emit("node-selected", biz);
}

// ── 手动连线(环路防护: BFS 可达检查) ──
function onConnect(conn: Connection) {
  if (!props.editable || props.locked) return;
  const src = String(conn.source ?? "").replace(/^agent-/, "");
  const tgt = String(conn.target ?? "").replace(/^agent-/, "");
  if (!src || !tgt || src === tgt) return;
  if (props.edges.some((e) => e.source === src && e.target === tgt)) return; // 去重
  // 加一条 edge=src→tgt 之后会不会出现环? 可用性检查的起点是 target(从 tgt 出发能回到 src 就是环)。
  // 注意: 这两个方向是相反的两件事, 别改写成 wouldCycle(src, tgt) —— 那样会误杀 A→B 这种最常见的连线。
  if (wouldCycle(tgt, src)) return;
  // 上报给上层, 由上层更新 props.edges 回传(边是真源在上层; 见 buildLayout 的说明)
  emit("graph-changed", {
    edges: [...props.edges, { source: src, target: tgt }].map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
  });
}
/**
 * V415 修复(第四次, 把这条链上的坑记全, 免得下次再踩):
 *
 * vue-flow 的改接判定在库内部是
 *   `if ((closestHandle || handleDomNode) && connection && isValid)` → 才调 onEdgeUpdate
 * 而 `isValid` 要求**线端落在目标节点的连接柄上**。四个坑叠在一起:
 *   ① `onEdgeUpdate` 是 **prop**, 不是事件监听 —— 只写 @edge-update 库收不到, 走"新建边"分支;
 *   ② **prop 的运行时签名与 .d.ts 不一致**: .d.ts 写 `(edgeUpdateEvent: EdgeUpdateEvent) => any`(单对象),
 *      而库内实际是 `onEdgeUpdate(event2, connection)`(两个位置参数)。按 .d.ts 写就会拿到
 *      `payload.connection === undefined`, 函数头一行静默 return —— 不抛错, 只是"拖了没反应";
 *   ③ 柄只有 5×5 且不可见 —— 拖到卡片身上松手, 库判定"没落在柄上"→无效→弹回原处;
 *   ④ 自定义节点 emit 的事件到不了画布(见下方 nodeActions 的说明), 同类问题;
 *   ⑤ 拿到的 edge 两端带 agent- 前缀, 而 props.edges 里是不带前缀的业务 id ——
 *      find 不到旧边就地静默 return, 又一次表现为[没反应]。
 * 对策: 形参兼容两种形态; 传 on-edge-update prop; 放大柄与末端吸附半径。
 */
function onEdgeUpdate(a: unknown, b?: Connection) {
  if (!props.editable || props.locked) return;
  // 兼容: 单对象 {event, edge, connection} 或两个位置参数 (event, connection)
  const p = a as { event?: unknown; edge?: { source: string; target: string; id?: string }; connection?: Connection } | null;
  const conn = (b ?? p?.connection) as Connection | undefined;
  const edge = (p?.edge ?? (p?.event as { edge?: { source: string; target: string } } | undefined)?.edge) as
    | { source: string; target: string }
    | undefined;
  const src = String(conn?.source ?? "").replace(/^agent-/, "");
  const tgt = String(conn?.target ?? "").replace(/^agent-/, "");
  if (!src || !tgt || src === tgt) return;                       // 自环直接丢弃
  // edge 来自 vue-flow, 它的 source/target 带 agent- 前缀(画布节点 id 是 agent-<业务id>);
  // props.edges 里存的是**不带前缀**的业务 id。不剥前缀的话这里 find 永远 undefined,
  // 函数就地静默 return —— 表现就是"拖了没反应"(实测踩到)。
  const eSrc = String(edge?.source ?? "").replace(/^agent-/, "");
  const eTgt = String(edge?.target ?? "").replace(/^agent-/, "");
  const old = props.edges.find((e) => e.source === eSrc && e.target === eTgt);
  if (!old) return;
  if (old.source === src && old.target === tgt) return;           // 没变
  if (props.edges.some((e) => e !== old && e.source === src && e.target === tgt)) return; // 去重
  // 环检要按"改接之后"的边集合算: 先把旧边摘掉, 再看 src 是否可达 tgt
  if (wouldCycle(src, tgt, props.edges.filter((e) => e !== old))) return;
  emit("graph-changed", {
    edges: props.edges.map((e) => (e === old ? { source: src, target: tgt } : { source: e.source, target: e.target }))
      .map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
  });
}

function wouldCycle(from: string, to: string, edges: Array<{ source: string; target: string }> = props.edges): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
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

/**
 * V415: 屏幕坐标 → flow 坐标。
 *
 * 活取 .vue-flow__pane 的实时 transform(zoom + pan)反算, 不另存一份状态 —— 用户滚轮缩过、
 * 拖过画布之后, 只有库自己知道当前的 zoom/平移。
 *
 * 容器 padding 必须减掉: 节点是 .vue-flow__pane 的子元素, 而 pane 位于容器的 padding box
 * 之内(容器 padding: 40px 0 0), 所以 pane 左上角 ≠ 容器左上角 —— 实测差 40px, 不减这一项
 * 落点会整体偏下。这正是旧实现"看着像对"的原因: 它用一个比例系数把这个偏移顺手吞掉了。
 *
 * 旧实现(已删)按 `容器内坐标 * 0.72` 近似, 只在 fitView 恰好缩放到 1.0 时才碰巧正确 ——
 * 而浏览器缩放/双屏 dpr 会让它变成 0.667 或 1.25, 那时落点偏得肉眼可见。
 */
function screenToFlow(clientX: number, clientY: number): { x: number; y: number } {
  const host = canvasEl.value;
  if (!host) return { x: 0, y: 0 };
  const rect = host.getBoundingClientRect();
  const cs = getComputedStyle(host);
  const pl = parseFloat(cs.paddingLeft) || 0;
  const pt = parseFloat(cs.paddingTop) || 0;
  const pane = host.querySelector(".vue-flow__pane") as HTMLElement | null;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  if (pane) {
    const m = getComputedStyle(pane).transform.match(/matrix\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(",").map(Number);
      scale = p[0] || 1;
      tx = p[4] || 0;
      ty = p[5] || 0;
    }
  }
  return { x: (clientX - rect.left - pl - tx) / scale, y: (clientY - rect.top - pt - ty) / scale };
}

/** V415: 能力面板拖放 —— 把屏幕坐标换成画布坐标后交给上层建节点 */
function onDrop(ev: DragEvent) {
  if (!props.editable || props.locked) return;
  const capabilityId = ev.dataTransfer?.getData("application/x-orch-capability") || ev.dataTransfer?.getData("text/plain") || "";
  if (!capabilityId) return;
  ev.preventDefault();
  emit("capability-dropped", { capabilityId, position: screenToFlow(ev.clientX, ev.clientY) });
}
function onDragOver(ev: DragEvent) {
  if (!props.editable || props.locked) return;
  // 必须 preventDefault 才允许 drop
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
}

// ── 选中边 / 选中节点(用来自动画布内的删除入口) ──
// vue-flow 的 selected 状态在它自己的 flowEdges 里, 但选中"得到确认动作"这件事在本组件内联最直接:
// 选中一条边 → 边上出现小红叉; 选中节点 → 节点上出现小红叉。用户不用记 Backspace。
const selectedNodeId = ref<string>("");
const selectedEdgeKey = ref<string>("");

/** 选中边: vue-flow 会同时给出 edge(含 source/target) */
function onEdgeClick(ev: { edge?: { source?: string; target?: string } }) {
  if (!props.editable || props.locked) return;
  const s = String(ev.edge?.source ?? "").replace(/^agent-/, "");
  const t = String(ev.edge?.target ?? "").replace(/^agent-/, "");
  selectedEdgeKey.value = s && t ? `${s}->${t}` : "";
  selectedNodeId.value = "";
}
function deleteEdgeAt(sourceId: string, targetId: string) {
  if (!props.editable || props.locked) return;
  const hit = props.edges.find((e) => e.source === sourceId && e.target === targetId);
  if (!hit) return;
  selectedEdgeKey.value = "";
  emit("graph-changed", {
    edges: props.edges.filter((e) => e !== hit).map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
  });
}
function deleteNodeById(id: string) {
  if (!props.editable || props.locked) return;
  selectedNodeId.value = "";
  emit("node-delete", { id });
}
function onPaneClick() {
  // 点空白处取消选中(与"点节点打开详情"不冲突: 那个事件先发, 这里只清选中态)
  selectedEdgeKey.value = "";
}
/** 边的屏幕位置(把小红叉摆到边的中点) —— 用 vue-flow 的边 DOM 取真实路径中点 */
const edgeMarks = computed(() => {
  const out: Array<{ key: string; source: string; target: string; x: number; y: number }> = [];
  const host = canvasEl.value;
  if (!host) return out;
  for (const e of props.edges) {
    const key = `${e.source}->${e.target}`;
    if (key !== selectedEdgeKey.value) continue;
    const el = host.querySelector(`.vue-flow__edge[data-id="edge-${e.source}-${e.target}"] path`);
    const rect = host.getBoundingClientRect();
    if (el) {
      const len = (el as SVGPathElement).getTotalLength?.() ?? 0;
      const pt = (el as SVGPathElement).getPointAtLength?.(len / 2);
      const m = (el as SVGGraphicsElement).getScreenCTM?.();
      if (pt && m) {
        const sx = pt.x * m.a + pt.y * m.c + m.e;
        const sy = pt.x * m.b + pt.y * m.d + m.f;
        out.push({ key, source: e.source, target: e.target, x: sx - rect.left, y: sy - rect.top });
        continue;
      }
    }
    out.push({ key, source: e.source, target: e.target, x: 0, y: 0 });
  }
  return out;
});
/** 选中节点的小红叉位置(卡片右上角) */
const nodeMarks = computed(() => {
  const host = canvasEl.value;
  if (!host || !selectedNodeId.value) return [];
  const el = host.querySelector(`.vue-flow__node[data-id="agent-${selectedNodeId.value}"]`);
  if (!el) return [];
  const r = el.getBoundingClientRect();
  const host_rect = host.getBoundingClientRect();
  return [{ id: selectedNodeId.value, x: r.right - host_rect.left - 10, y: r.top - host_rect.top + 10 }];
});

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
      :edge-updater-radius="26"
      :on-edge-update="editable && !locked ? onEdgeUpdate : undefined"
      :min-zoom="0.35"
      :max-zoom="1.8"
      :fit-view-on-init="true"
      @node-click="onNodeClick"
      @edge-click="onEdgeClick"
      @pane-click="onPaneClick"
      @node-context-menu="(ev: any) => onNodeContextMenu(ev?.event as MouseEvent, (ev?.node?.data ?? ev?.node) as BizNode)"
      @connect="onConnect"
      @edge-update="onEdgeUpdate"
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

    <!-- V415: 选中即出删除按钮 —— 用户不该被迫记 Backspace -->
    <button
      v-for="m in edgeMarks"
      :key="'x-' + m.key"
      class="canvas-kill is-edge"
      :style="{ left: m.x + 'px', top: m.y + 'px' }"
      title="删除这条连线"
      @click.stop="deleteEdgeAt(m.source, m.target)"
    >×</button>
    <button
      v-for="m in nodeMarks"
      :key="'xn-' + m.id"
      class="canvas-kill is-node"
      :style="{ left: m.x + 'px', top: m.y + 'px' }"
      title="删除这个节点"
      @click.stop="deleteNodeById(m.id)"
    >×</button>
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
/**
 * 连接柄做大做可见。默认 5×5 且不可见 —— 用户把线拖到卡片身上松手, 库判定"没落在柄上"→无效→弹回。
 * 14px + 半径放大(edge-updater-radius)之后, 拖到卡片边缘附近就能吸附上。
 */
:deep(.vue-flow__handle) {
  width: 14px; height: 14px; min-width: 14px; min-height: 14px;
  border: 2px solid #0D1626; border-radius: 50%;
  background: #6C8FD8;
}
:deep(.vue-flow__handle:hover) { background: #9FC0E8; transform-origin: center; }
:deep(.vue-flow__handle.connectable) { cursor: crosshair; }
/* 选中即出的小红叉(边中点 / 节点右上角) —— 摆位随画布滚动实时算 */
.canvas-kill {
  position: absolute; z-index: 6;
  width: 20px; height: 20px; padding: 0; line-height: 1;
  border: 1px solid #B4544E; border-radius: 50%;
  background: #2A1C1C; color: #F08A8A;
  font-size: 13px; cursor: pointer; transform: translate(-50%, -50%);
}
.canvas-kill:hover { background: #B4544E; color: #FFF; }
</style>
