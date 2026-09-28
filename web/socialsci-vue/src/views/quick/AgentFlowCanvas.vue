<script setup lang="ts">
/**
 * AgentFlowCanvas — 还原自参考产品 AgentFlowCanvas(, data-v-0bebca05)
 * 用 npm @vue-flow/core(参考产品 L1-13472 即库本体); 布局: 顺序横排 + module 类节点下排
 * 三色边体系: agent-edge-(自动链)/manual-edge-(用户拖); active 目标 → #7184f5 2.4px animated
 */
import { ref, computed, provide, watch, onMounted, onUnmounted, nextTick } from "vue";
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
  /**
   * V416: 实际消费了哪些上游节点的产出(`MetaStepRun.inputsFrom`, 由运行时的进度回填)。
   *
   * 与 `input` 的区别很重要: `input` 是**能力的声明**(这张卡片按规格需要什么),
   * 这里是**这一次运行真的吃了谁**。参考产品「节点输入」在跑完后展示的是后者。
   * 没跑过时为空数组 —— 那时不要编一个"上游产出"充数。
   */
  inputsFrom?: string[];
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
  /** V415: 卡片上的 ✕ 点了 —— 交给上层真正删节点(节点数组的主人在上层) */
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

// ── 右键菜单(参考产品: pane 空白右键 → 模块列表; node 右键 → 详情/删除) ──
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
 * 这两个标记在 AgentFlowNode 的模板里(参考产品里它们是可点入口), 之前点了完全没反应。
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
  /** V415: 卡片上的 × —— 直接删, 不用先选中再找浮层按钮 */
  remove: (ev: MouseEvent, biz: BizNode) => {
    if (props.locked) return;
    ev.preventDefault();
    emit("node-delete", { id: biz.id });
  },
};
provide(ORCH_NODE_ACTIONS, nodeActions);

// ── 节点点击 → 原对象 ──
function onNodeClick(event: { node: Node }) {
  const biz = (event.node.data ?? {}) as BizNode;
  selectedEdgeKey.value = "";
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
  let moved = false;
  for (const ch of changes) {
    if (ch.type === "position" && ch.position && !ch.dragging) {
      emit("nodes-moved", { id: String(ch.id).replace(/^agent-/, ""), position: { x: ch.position.x, y: ch.position.y } });
      moved = true;
    }
  }
  /**
   * V416: 拖拽落点也会影响泳道边界 —— 把一个主链节点拖到很下面, "主链"那条框要跟着长高。
   * ⚠ 只在**拖拽结束**时重算(而不是每一帧): 计算要做 min/max 扫全量节点, 拖拽期间
   *   每帧算一次纯属浪费, 而且框跟着手抖在视觉上很吵。
   */
  if (moved) computeLanes();
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
const selectedEdgeKey = ref<string>("");

/** 选中边: vue-flow 会同时给出 edge(含 source/target) */
function onEdgeClick(ev: { edge?: { source?: string; target?: string } }) {
  if (!props.editable || props.locked) return;
  const s = String(ev.edge?.source ?? "").replace(/^agent-/, "");
  const t = String(ev.edge?.target ?? "").replace(/^agent-/, "");
  selectedEdgeKey.value = s && t ? `${s}->${t}` : "";
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
watch(
  () => [props.nodes, props.edges] as const,
  () => {
    buildLayout();
    /**
     * V416: 等一帧再量泳道 —— `buildLayout` 只写了 flowNodes, vue-flow 还没把节点
     *   挂进 DOM、更没量出宽高; 同一 tick 里算边界会拿到未落定的尺寸。
     *   `nextTick` 后 DOM 已更新(位置是我们自己给的不依赖测量, 所以这一帧足够)。
     */
    void nextTick(() => {
      // 首次算泳道前先挂上视口观察器, 再量一次 —— 首帧节点可能还没进 DOM, 量出来是空的
      watchViewport();
      computeLanes();
    });
  },
  { deep: true }
);
onMounted(() => { buildLayout(); void nextTick(() => { watchViewport(); computeLanes(); }); });

/**
 * V415: 把"缩放/平移到全部节点可见"暴露给上层。
 * 用途: 点能力项的 ➕ 后新节点可能落在当前视野外(尤其中小窗口), 用户会以为"没加上" ——
 * 上层加完节点调一次 fit 就能把它带进视野。
 */
const flowRef = ref<{
  fitView?: (opts?: unknown) => void;
  getViewport?: () => { x: number; y: number; zoom: number };
  setCenter?: (x: number, y: number, opts?: unknown) => void;
} | null>(null);
/**
 * V416: 把某个节点滚进视野 —— 「在画布打开工作界面」这个动作的落点。
 *
 * 为什么要用 `setCenter` 自己算而不用库里的 fitView({nodes:[...]}):
 *   fitView 会**顺手改缩放**(它要"装下"目标), 而用户此时的缩放是他自己调的 ——
 *   点一下"在画布打开"就把画布拉远, 会让人丢失方向感。setCenter 只平移, 缩放保持。
 * 拿不到实例时**什么都不做**(返回 false, 由上层换一种方式告知), 不抛错。
 */
defineExpose({
  fitView: () => flowRef.value?.fitView?.({ padding: 0.15, duration: 200 }),
  focusNode: (id: string): boolean => {
    const f = flowRef.value;
    if (!f?.setCenter || !f?.getViewport) return false;
    const n = flowNodes.value.find((x: { id: string }) => x.id === id);
    if (!n?.position) return false;
    const vp = f.getViewport();
    // vue-flow 的节点 position 是**流坐标**, setCenter 收的也是流坐标 —— 直接传节点中心
    const w = Number(n.width) || 180;
    const h = Number(n.height) || 120;
    f.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: vp.zoom, duration: 260 });
    return true;
  },
});

const nodeColor = (n: Node) => {
  const st = (n.data as BizNode | undefined)?.state;
  if (st === "running") return "#7184f5";
  if (st === "completed") return "#5FD0B4";
  return "#c3ccdc";
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * V416: 泳道与「模块调度」区(对齐参考产品图 11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 参考产品把画布按 PHASE 横向分泳道(研究定义/研究框架/素材编排/正文生成)外加一条
 * MODULE SCHEDULER 底栏。**我方不照抄那五条泳道** —— 理由要说清楚, 免得日后被当成漏做:
 *
 *   · 它那五条是**它自己的固定五阶段产品结构**(phrase1..5); 我方这个画布是**自由 DAG**:
 *     节点来自 100 项能力、可以任意连、可以一个都没有。硬套五条泳道等于把用户的图
 *     塞进一个我们没有的阶段模型里, 而且图里没有对应节点时泳道只能是空壳(装饰)。
 *   · 我方真正有的两条带: **主链**与**模块调度**。后者不是新概念 ——
 *     `BizNode.standalone` 与 `AgentFlowCanvas` 里那条 y=340 的下排布局**早就在了**,
 *     只是一直没有可见的区隔, 用户看到的是"下面莫名其妙飘着一排节点"。
 *
 * 所以这件事的做法是**给已有的两条带补上可见的标题与边界**, 而不是造五条没有的泳道。
 *
 * ⚠ `standalone` 在 QuickModeView 里从来没被赋过值(grep 0 命中), 而模板图里确实有底部
 *   模块行 —— 所以判据不能只看这个字段。这里按**能力的 category** 兜底认模块节点:
 *   模块调度 / 统计分析 / 科研绘图 / 实证 这四类属于"分析模块", 而不是写作主链。
 *   这样模板图(它们的 category 就是这几个)能正确落到下排, 已保存的图也不受影响。
 */
const MODULE_CATEGORIES = new Set(["模块调度", "统计分析", "科研绘图", "实证"]);
const isModuleNode = (n: BizNode): boolean => !!n.standalone || MODULE_CATEGORIES.has(n.module);

/** 泳道分区: 主链 / 模块调度。见下面 V416 那段说明。 */
type Lane = "main" | "module";

/**
 * ⚠ 坐标系: **屏幕坐标**(相对画布容器), 不是流坐标。
 *
 * 第一版我把它当成流坐标写进 `<VueFlow>` 的默认插槽里, 以为"跟节点同一坐标系就能跟着动"。
 * 实测两件事全错: ① 默认插槽渲染在 `.vue-flow` 里而**不在** `.vue-flow__viewport` 里
 * (vue-flow 1.48.2 的默认插槽是**兄弟层**, 不是子层), 所以它既不缩放也不平移;
 * ② `z-index: 0` 被 `.vue-flow__pane` 盖住, 边框根本看不见(截图里整条泳道是隐形的)。
 * 现在: 画在 VueFlow 之外、`z-index` 提到 pane 之上、边界从 DOM 实拍取(见 computeLanes)。
 */
interface LaneRect { key: Lane; title: string; x: number; y: number; w: number; h: number; color: string }
const lanes = ref<LaneRect[]>([]);

const LANE_META: Record<Lane, { title: string; color: string }> = {
  main: { title: "主链", color: "#4D84CB" },
  module: { title: "模块调度", color: "#9B7BE0" },
};

/**
 * ⚠ 泳道边界从 **DOM 实拍**取, 不自己算变换。
 *
 * 走过的三条路, 记下来免得再绕:
 *   ① 流坐标 + 放进 `<VueFlow>` 默认插槽 —— **错**: 默认插槽渲染在 `.vue-flow` 里而不是
 *      `.vue-flow__viewport` 里(vue-flow 1.48.2), 既不跟平移缩放, 还被 pane 盖住(整条隐形)。
 *   ② 自己拿 `viewport` 做 `x*zoom+tx` 换算 + `@viewport-change` 触发 —— **错**:
 *      实测点两次缩放按钮, 节点宽度 ×1.44 而泳道纹丝不动 ⇒ 那个事件没有按预期派发到外层组件。
 *   ③ 现在: 节点卡片的 `getBoundingClientRect()` 本来就是**屏幕坐标**(vue-flow 的变换已经
 *      作用在 DOM 上), 直接量它、减掉画布容器的 rect 即可。变换口径永远与 vue-flow 自身一致,
 *      不存在"我算的和他做的不一样"; 触发用 MutationObserver 盯视口元素的 `style`
 *      (缩放/平移必然改它), 不依赖任何 emit 契约。
 */
function computeLanes() {
  const root = canvasEl.value;
  if (!root) { lanes.value = []; return; }
  const base = root.getBoundingClientRect();
  const groups: Record<Lane, Array<{ x: number; y: number; w: number; h: number }>> = { main: [], module: [] };
  for (const n of props.nodes) {
    // 节点卡在 vue-flow 里的 DOM id 是 `agent-<bizId>`(见 buildLayout)
    const el = root.querySelector(`.vue-flow__node[data-id="agent-${CSS.escape(n.id)}"]`) as HTMLElement | null;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    groups[isModuleNode(n) ? "module" : "main"].push({
      x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height,
    });
  }
  const PAD_X = 26, PAD_TOP = 34, PAD_BOTTOM = 22, MARGIN = 20;
  const out: LaneRect[] = [];
  for (const key of ["main", "module"] as Lane[]) {
    const pts = groups[key];
    if (!pts.length) continue;   // 空的泳道**不画** —— 空壳泳道是纯装饰, 参考产品图里也没有空的
    const left = Math.min(...pts.map((p) => p.x));
    const top = Math.min(...pts.map((p) => p.y));
    const right = Math.max(...pts.map((p) => p.x + p.w));
    const bottom = Math.max(...pts.map((p) => p.y + p.h));
    const px = MARGIN + PAD_X, py = MARGIN + PAD_TOP;
    out.push({
      key, title: LANE_META[key].title, color: LANE_META[key].color,
      x: left - px, y: top - py,
      w: right - left + px * 2, h: bottom - top + py + MARGIN + PAD_BOTTOM,
    });
  }
  lanes.value = out;
}

/**
 * 视口变换一改就重算泳道 —— 不依赖 vue-flow 的 emit 契约。
 *
 * ⚠ 盯的元素是 `.vue-flow__transformationpane`, **不是** `.vue-flow__viewport`。
 *   我第一版盯的是后者, 结果盯了个空: 实测(2026-09-28)点缩放按钮时
 *   `.vue-flow__viewport` 的 `style` 属性**始终是 null**, 而真正带
 *   `matrix(zoom,0,0,zoom,tx,ty)` 的是它的子元素 `.vue-flow__transformationpane`。
 *   MutationObserver 挂错元素**不会有任何报错**, 只是永远不触发 —— 表现与"没写这段"一模一样。
 *   所以这里附一条自检: 挂不上就打一行, 免得再静默失效。
 */
let laneObserver: MutationObserver | null = null;
function watchViewport() {
  const root = canvasEl.value;
  if (!root || laneObserver) return;
  const vp = root.querySelector(".vue-flow__transformationpane");
  if (!vp) {
    console.warn("[AgentFlowCanvas] 找不到 .vue-flow__transformationpane — 泳道不会跟随缩放/平移");
    return;
  }
  laneObserver = new MutationObserver(() => {
    // 同一帧内可能连续变更, 合并到下一帧只算一次
    void nextTick(() => computeLanes());
  });
  laneObserver.observe(vp, { attributes: true, attributeFilter: ["style"] });
}
onUnmounted(() => { laneObserver?.disconnect(); laneObserver = null; });

/**
 * 「可执行」的真判据。
 *
 * 与后端启动前置**同口径**(见 `startOrchestration`: 非空才让跑), 但这里更严一档 ——
 * 后端对未绑能力的节点会**静默退化**成通用 LLM 生成(`dagNodeToMetaStep` 的 else 分支),
 * 那意味着你排的那一步不会做你以为它做的事。所以这里把它标出来。
 */
const executable = computed<{ ok: boolean; why: string }>(() => {
  if (!props.nodes.length) return { ok: false, why: "画布是空的" };
  const unbound = props.nodes.filter((n) => !n.capabilityId);
  if (unbound.length) {
    return { ok: false, why: `${unbound.length} 个节点未绑定能力: ${unbound.slice(0, 2).map((n) => n.id).join(", ")}${unbound.length > 2 ? " …" : ""}` };
  }
  return { ok: true, why: `${props.nodes.length} 个节点都已绑定能力` };
});
</script>

<template>
  <div ref="canvasEl" class="agent-flow-canvas" :class="{ 'is-locked': locked }" @contextmenu.prevent="onPaneContextMenu" @drop="onDrop" @dragover="onDragOver">
    <VueFlow
      ref="flowRef"
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
    <!--
      V416: 泳道区隔。**放在 VueFlow 之外** —— 第一版放进默认插槽, 实测默认插槽渲染在
      `.vue-flow` 里而不是 `.vue-flow__viewport` 里, 于是既不跟平移缩放、还低于 pane。
      边界取自节点卡片的实际屏幕位置(见 computeLanes), 视口一变就重算。
    -->
    <div
      v-for="ln in lanes"
      :key="'lane-' + ln.key"
      class="flow-lane"
      :style="{ left: ln.x + 'px', top: ln.y + 'px', width: ln.w + 'px', height: ln.h + 'px', borderColor: ln.color + '55' }"
    >
      <span class="flow-lane-title" :style="{ color: ln.color, borderColor: ln.color + '66' }">{{ ln.title }}</span>
    </div>
    <div class="flow-toolbar">
      <!--
        V416: 「可执行」徽标(参考产品图 11 右上角那个绿徽标)。
        ⚠ **它必须是真判据, 不能是恒定绿灯** —— 一个永远绿的徽标比没有更糟。
        判据与后端 startOrchestration 的前置一致: 有节点 + 每个节点都绑了已登记的能力。
        没绑能力的节点后端会退化成通用 LLM 生成(见 dagNodeToMetaStep), 那是意外行为而不是设计,
        所以这里判"不可执行"并说明原因 —— 让人有机会改, 而不是跑完了才发现那步只是泛泛生成。
      -->
      <span class="flow-zone-chip">标准工作流 · 主流程</span>
      <span
        class="flow-exec-chip"
        :class="executable.ok ? 'is-ok' : 'is-blocked'"
        :title="executable.why"
        :data-executable="executable.ok ? '1' : '0'"
      >{{ executable.ok ? "可执行" : "不可执行" }}</span>
      <span v-if="!executable.ok" class="flow-exec-why">{{ executable.why }}</span>
    </div>

    <!-- V415: 只剩"边的删除钮" —— 节点卡片自带 ✕, 再挂一个圆形按钮是重复的(用户指出)。
         边没有别的可见入口(右键/键盘都不直观), 所以这里保留一个。 -->
    <button
      v-for="m in edgeMarks"
      :key="'x-' + m.key"
      class="canvas-kill is-edge"
      :style="{ left: m.x + 'px', top: m.y + 'px' }"
      title="删除这条连线"
      @click.stop="deleteEdgeAt(m.source, m.target)"
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
  color: #9FB0C6;  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
:deep(.vue-flow__background) { background: #0D1626; }
:deep(.vue-flow__minimap) { right: 12px; bottom: 12px; border: 1px solid var(--wf-line-hard); border-radius: 5px; }
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

/* V416: 泳道区隔(屏幕坐标, 随平移缩放重算) + 「可执行」徽标 */
/* ⚠ z-index 必须高于 .vue-flow__pane(vue-flow 默认 1 附近) —— 第一版是 0, 边框被 pane 整体盖住 */
.flow-lane {
  position: absolute; z-index: 2; pointer-events: none;
  border: 1px dashed; border-radius: 12px; background: rgba(77, 132, 203, 0.035);
}
.flow-lane-title {
  position: absolute; top: -9px; left: 12px; padding: 0 7px;
  font-size: 10px; letter-spacing: 0.08em; line-height: 16px;
  background: #0D1626; border-left: 2px solid; white-space: nowrap;
}
.flow-exec-chip {
  display: inline-flex; align-items: center; min-height: 20px; padding: 0 9px;
  margin-left: auto; border-radius: 10px; font-size: 10.5px; letter-spacing: 0.04em;
}
.flow-exec-chip.is-ok { background: #14281F; color: #5FD0B4; border: 1px solid #24503C; }
.flow-exec-chip.is-blocked { background: #2A2414; color: #E8B54A; border: 1px solid #5A4A1E; }
.flow-exec-why { font-size: 10px; color: #7A8AA0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
</style>
