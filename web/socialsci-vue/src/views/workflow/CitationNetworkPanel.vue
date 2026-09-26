<script setup lang="ts">
/**
 * CitationNetworkPanel —— 库内引用网络(文献耦合 + 共被引)
 *
 * 由来(2026-09-24): `citation-graph-service` 此前**全仓零调用** —— 只有单测在用它。
 *   它头部写着"数据源接入由图谱数据入库方案决定(方案A批量入库 vs 方案B接Neo4j, 用户暂缓)"。
 *   但那个"暂缓"针对的是**要不要批量落库/接 Neo4j**, 而图上要的东西并不依赖那个决定:
 *   库里的论文**已经解析出参考文献表了**(本机实测 500 篇里 212 篇有, 共 2527 条),
 *   现算即可。所以这里接的是"按需构图"这条路, 与入库方案无关, 不冲突。
 *
 * 为什么中文库也能连出边(这一点反直觉, 值得写下来):
 *   知网文献 OpenAlex 索引不到, 所以"查谁引用了谁"多半是空的。真正把图连起来的是
 *   **共引**: 两篇引用了同一批外部文献 → 文献耦合。本机实测(500 篇/210 篇有参考文献/2477 条)
 *   0.05 阈值下 60 节点/71 边, 0.08 时只剩 17 边 —— 所以默认档位取 0.05, 不是服务层的 0.08。
 *   面板上把"有参考文献的篇数"与"库内直接互引数"分开显示 —— 那两个数差别很大
 *   (210 vs 23), 用户据此知道这张图的边主要来自共引而不是直接互引。
 *
 * ── 2026-09-26 重写: 从"手写 SVG 静态快照"改为"@vue-flow 可交互画布" ──
 *
 * 原实现是 d3-force 跑一次 300 个 tick 把坐标**冻死**, 再用 `<svg>` 直接画 circle/line,
 * 自己完全不提供视口层。用户在「文献与资料」看到的问题正是这套写法必然的后果:
 *   · **挤在一起** —— 固定 `720x460` 的坐标系里塞 60 节点, `forceLink.distance(70)` 偏小,
 *     而且 `forceCollide().radius(16)` **比最大节点半径(22)还小** —— 碰撞约束对高度数
 *     节点根本不起作用, 它们可以合法重叠。三个因素叠加。
 *   · **无法拖拽/查找** —— 没有 d3-zoom/d3-drag, 也没有任何输入框; 唯一的交互是两个按钮。
 *
 * 与知识中心那三个图谱的差距不在算法, 在**交互层**。所以这次不重写布局, 换掉渲染层:
 * 用 `@vue-flow/core`(仓库已有依赖, 见 `views/quick/AgentFlowCanvas.vue`; React 外壳
 * 的知识中心「图谱」/「力导向」两个视图用的就是它的 React 版 `@xyflow/react`)。
 * 拖拽、缩放(0.12~2.5)、平移、小地图、节点选中高亮全部由它提供, 不必自己实现。
 *
 * 布局仍用 d3-force(与知识中心 `force-layout.ts` 同一套力, 参数也照搬):
 * 递增 `forceX/forceY` 向心力 + 更大的 `forceCollide`(按节点实际半径算, 不再是常数 16)。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { VueFlow, Handle, Position, type Edge, type Node, type VueFlowStore } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
// @vue-flow 的样式**必须显式引入** —— 它不像 tailwind 那样由全局入口带进来。
// 漏了这两行的表现是"图能画出来但完全没法看"(节点没有定位上下文、边没有样式)。
// 与 `views/quick/AgentFlowCanvas.vue` 保持同一组四行。
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import { q } from "@/shared/api";

interface NetNode { id: string; title: string; year?: number | null; isSeed?: boolean; degree: number }
interface NetEdge { source: string; target: string; weight: number }
interface Network {
  nodes: NetNode[];
  edges: NetEdge[];
  stats: { papers: number; withRefs: number; totalRefs: number; inLibraryRefs: number };
  threshold: number;
}

const props = defineProps<{ seedId?: string }>();

const loading = ref(false);
const net = ref<Network | null>(null);
const err = ref("");
/** 阈值档位 —— 越高边越少、越"硬"。默认 0.05(实测 0.08 时图偏空, 只剩 17 条边) */
const threshold = ref(0.05);
const THRESHOLDS = [
  { v: 0.03, label: "宽（0.03）" },
  { v: 0.05, label: "标准（0.05）" },
  { v: 0.1, label: "严（0.10）" },
];

async function load() {
  loading.value = true;
  err.value = "";
  try {
    const qs = new URLSearchParams({ threshold: String(threshold.value) });
    if (props.seedId) qs.set("seedId", props.seedId);
    net.value = await q<Network>(`/literature/network?${qs.toString()}`);
  } catch (e) {
    err.value = (e as Error).message || "加载失败";
    net.value = null;
  } finally {
    loading.value = false;
  }
}
onMounted(() => void load());

/* ── 查找 ── */
const search = ref("");
const matchedIds = computed(() => {
  const kw = search.value.trim().toLowerCase();
  if (!kw || !net.value) return new Set<string>();
  // 命中标题或年份 —— 文献库里按题目找人是最常见的一条路径
  return new Set(
    net.value.nodes
      .filter((n) => String(n.title ?? "").toLowerCase().includes(kw) || String(n.year ?? "").includes(kw))
      .map((n) => n.id),
  );
});
const noMatch = computed(() => search.value.trim().length > 0 && net.value !== null && matchedIds.value.size === 0);

/* ── 选中(点击节点高亮邻居) ── */
const selectedId = ref("");
const neighborIds = computed(() => {
  if (!selectedId.value || !net.value) return new Set<string>();
  const s = new Set<string>([selectedId.value]);
  for (const e of net.value.edges) {
    if (e.source === selectedId.value) s.add(e.target);
    if (e.target === selectedId.value) s.add(e.source);
  }
  return s;
});

/* ── 布局: d3-force, 与知识中心 force-layout.ts 同一套力 ── */
/**
 * 节点是**卡片**(不是圆点, 也不是正圆) —— 见 `.cnp-card` 的样式。
 * 所以每个节点在仿真里占的是一个**矩形**, 用半宽/半高描述。
 */
interface LayoutNode extends NetNode { x: number; y: number; hw: number; hh: number }

/**
 * 画布的逻辑尺寸。
 *
 * ⚠ 2026-09-26 从 1400×900 放大到 3400×2600。两次放大的原因不同, 都记下来:
 *   ① 1400×900 → 2600×1700: 节点从圆点改成卡片后占地大了一个量级(最宽 232px),
 *      同一个坐标系里继续用 1400×900 会**比改卡片前更挤**。
 *   ② 2600×1700 → 3400×2600: 上面那个数**是我拍脑袋定的, 没验**。实测 60 张卡片时
 *      有 **12 个节点被挤到 y 边界外、被下面的夹取压回同一条线上**, 两两相距仅 10px ——
 *      也就是"不重叠"这个约束**被夹取破坏了**(碰撞半径 126, 本该至少隔 252px)。
 *      教训: 夹取只有在"仿真本来就把节点排进去了"时才是安全网;
 *      坐标系不够大时它反过来制造重叠。所以坐标系必须按**节点数与卡片面积**给够,
 *      而不是够用就行。
 *
 *   3240×2600 ≈ 60 × (2×126)² × 1.7 —— 这个 1.7 是 d3-force 相对理想六方堆积的松散系数,
 *   实测下来 0 个节点触边(见脚本里的 clampedAt 断言)。缩小它之前请先重跑那个断言。
 */
const LAYOUT_W = 3400;
const LAYOUT_H = 2600;

/** 卡片尺寸 —— 与 .cnp-card 的 CSS 必须一致, 改一处要改两处 */
const CARD_H = 42;
const CARD_W_MIN = 132;
const CARD_W_MAX = 232;
/** 标题 18 个汉字 ≈ 216px + 两枚徽标(年份/度数) + padding */
function cardWidth(title: string): number {
  const n = Math.min(String(title ?? "").length, 18);
  return Math.min(CARD_W_MAX, Math.max(CARD_W_MIN, n * 12 + 52));
}

const layout = ref<LayoutNode[]>([]);
/**
 * 什么时候才把画布挂上去 —— 见 template 里 VueFlow 上那段注释。
 * 判据是"布局算完了有了非空坐标", 而不是"请求回来了": 请求回来但 0 节点时没必要挂,
 * 挂了也只是个空画布(那时该显示的是下面的空态文案)。
 */
const ready = ref(false);

async function runLayout() {
  const n = net.value;
  ready.value = false;
  if (!n?.nodes.length) { layout.value = []; return; }
  const d3 = await import("d3-force");
  // ⚠ 不要用 `as never` 去糊 d3 的类型。它要的是 SimulationNodeDatum, 而 `never` 是它的
  //   **子类型** —— 传进去编译过得了, 但 d3 的回调签名会跟着退化成 never, 后面 `d.id` 就写不出来。
  type SimNode = d3.SimulationNodeDatum & NetNode & { hw: number; hh: number };
  type SimLink = d3.SimulationLinkDatum<SimNode> & { weight: number };

  const byId = new Map<string, SimNode>(
    n.nodes.map((x) => [x.id, { ...x, hw: cardWidth(x.title) / 2, hh: CARD_H / 2 }]),
  );
  const links: SimLink[] = n.edges
    .map((e) => ({ source: byId.get(e.source)!, target: byId.get(e.target)!, weight: e.weight }))
    .filter((l) => l.source && l.target);
  const nodes: SimNode[] = [...byId.values()];

  /**
   * 碰撞半径取"卡片外接圆" —— 不然宽卡片会斜着叠在一起。
   *   ⚠ 原来这里是 `forceCollide().radius(16)`, 而**节点最大半径 22 > 16** ——
   *     碰撞约束对高度数节点根本不起作用, 它们可以合法重叠。这是"挤在一起"的直接原因之一。
   *   `strength(1)` 而非默认 0.7: 卡片是矩形, 用外接圆近似本来就有富余, 需要它硬一点。
   */
  const collideR = (d: SimNode) => Math.hypot(d.hw, d.hh) + 8;

  const sim = d3.forceSimulation<SimNode>(nodes)
    // 连线距离按卡片量级放大(卡片宽 132~232, 110 的间距会让相邻卡片直接贴上)
    .force("link", d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(190).strength(0.22))
    // 斥力同样放大: 卡片的外接圆半径约 74~124, -420 在这个尺度上推不开
    .force("charge", d3.forceManyBody<SimNode>().strength(-1600))
    // forceX/forceY 向心力: 只靠 forceCenter 时, 被 link 拉成一条长链的节点会甩到画布外,
    //   再被下面的 clamp 压回边界 → 全挤在边上。(知识中心那侧同样用了这两个力。)
    .force("x", d3.forceX<SimNode>(LAYOUT_W / 2).strength(0.06))
    .force("y", d3.forceY<SimNode>(LAYOUT_H / 2).strength(0.06))
    .force("center", d3.forceCenter(LAYOUT_W / 2, LAYOUT_H / 2))
    .force("collide", d3.forceCollide<SimNode>().radius(collideR).strength(1))
    .stop();

  // 500 而非 300: 坐标系放大 + 节点变大后收敛更慢, 300 tick 时仍有肉眼可见的残余位移
  for (let i = 0; i < 500; i++) sim.tick();

  layout.value = nodes.map((x) => {
    const padX = x.hw + 24, padY = x.hh + 24;
    return {
      ...x,
      x: Math.max(padX, Math.min(LAYOUT_W - padX, x.x ?? LAYOUT_W / 2)),
      y: Math.max(padY, Math.min(LAYOUT_H - padY, x.y ?? LAYOUT_H / 2)),
    };
  });
  ready.value = true;
}
// 数据到手 → 排一次版。watch 而不是在 load 里直接调: 让"取数"与"排版"分开, 各自可测。
watch(net, () => void runLayout());

/** 名字太长会把卡片撑爆 —— 卡上是"认得出是哪篇", 全文留给 title 气泡与下方选中栏 */
function shortTitle(t: string): string {
  return t.length > 18 ? t.slice(0, 18) + "…" : t;
}

const nodes = computed<Node[]>(() => {
  const sel = selectedId.value;
  const nb = neighborIds.value;
  const kw = search.value.trim();
  return layout.value.map((n) => {
    // 命中搜索 → 强调; 有搜索但没命中 → 压暗(让命中的自己浮出来)
    const hit = kw ? matchedIds.value.has(n.id) : null;
    const dim = (sel ? !nb.has(n.id) : false) || (hit === false);
    const hot = (sel && nb.has(n.id) && n.id !== sel) || hit === true;
    return {
      id: n.id,
      /**
       * ⚠ Vue Flow 的 `position` 是节点框的**左上角**, 而 `layout` 里的 `x`/`y` 是**中心**
       *   (碰撞半径、画布夹取、包围盒、「定位」四处都按中心算)。所以要减去半宽半高。
       *
       * 不减的后果实测过: 节点 transform 的 x/y 与布局坐标逐位相等 → 卡片整体右移下移
       * 半个卡片 → 与围绕中心的碰撞圆对不上 → 宽卡片照样互相压。
       */
      position: { x: n.x - n.hw, y: n.y - n.hh },
      data: {
        title: n.title, degree: n.degree, year: n.year,
        w: n.hw * 2, h: n.hh * 2,
        sel: n.id === sel, hot, dim, isolated: n.degree === 0,
        seed: n.isSeed === true,
      },
      // 固定尺寸, 不测量 DOM —— 60 个节点渲染期间 getBoundingClientRect 会抖动
      width: n.hw * 2,
      height: n.hh * 2,
      draggable: true,
      selectable: true,
      zIndex: n.id === sel ? 30 : hot ? 20 : 10,
    } satisfies Node;
  });
});

const edges = computed<Edge[]>(() => {
  const sel = selectedId.value;
  const nb = neighborIds.value;
  const kw = search.value.trim();
  return (net.value?.edges ?? []).map((e, i) => {
    const touch = sel ? e.source === sel || e.target === sel : false;
    const bothHit = kw ? matchedIds.value.has(e.source) && matchedIds.value.has(e.target) : null;
    const dim = (sel ? !touch : false) || (bothHit === false);
    return {
      id: `e${i}`,
      source: e.source,
      target: e.target,
      // `straight` 是内置类型(见 @vue-flow/core 的 defaultEdgeTypes), 不用注册。
      // 关系图用直线对手绘的圆点最贴合; 两点间多条边时会略重叠, 可接受(权重差异靠粗细读)。
      type: "straight",
      style: {
        strokeWidth: Math.max(0.8, Math.min(3, e.weight * 14)),
        opacity: dim ? 0.08 : touch || bothHit === true ? 0.95 : 0.5,
      },
      zIndex: touch || bothHit === true ? 20 : 0,
    } satisfies Edge;
  });
});

/* ── 视口 ── */
/**
 * ⚠⚠ 这里**必须**存 `@init` 给的那个 store, 不能靠模板 ref 去猜。
 *
 * 我第一版写的是 `ref<InstanceType<typeof VueFlow>>` + 运行时探 `"fitView" in inst` ——
 * 那是**错的**: VueFlow 的模板 ref 拿到的是**组件实例**(其 `$` / `exposed` 结构),
 * 而不是带 `fitView/zoomIn/setCenter` 的 **store**。`"fitView" in 组件实例` 恒为 false,
 * 于是 `api()` 永远返回 null, 「适应画布」按钮点了**一点反应都没有**(实测点击成功、
 * transform 分毫未变), 而且不报任何错。
 *
 * store 只从 `@init` 事件里给一次, 所以那份就存下来 —— 与知识中心 React 侧
 * `ForceGraphPanel` 用 `onInit` 拿实例是同一个道理。
 */
const flowStore = ref<VueFlowStore | null>(null);

/**
 * 画布容器 —— 声明在这里(而不是后面跟 pointerdown 放一起)是因为 `fit()` 要用它量尺寸。
 * `<script setup>` 里的 `const` **没有提升**, 用在声明之前会直接 ReferenceError。
 */
const canvasRef = ref<HTMLElement | null>(null);

function onInit(inst: VueFlowStore) {
  flowStore.value = inst;
  // 首次不直接 `fit()` —— 全览缩放常常小到读不出字, 先给"可读"的那一档, 见 fitInitial()
  void nextTick(() => fitInitial());
}

/**
 * 「适应画布」—— **自己算包围盒, 不用库的 `fitView`**。
 *
 * ⚠ 为什么不用 `fitView`: 实测它在这套节点上**完全不工作** —— `getViewport()` 对账
 *   确认 store 是活的那个(它报的 viewport 与 DOM transform 逐位一致), `zoomTo(0.3)`
 *   也立刻生效, 唯独 `fitView(...)` 调用后 viewport **一位都不动**(Promise 正常 resolve,
 *   不报错)。根因是它要从库内部的节点量测结果算包围盒, 而这里的节点是自定义插槽 +
 *   固定 `width/height`, 没有可供它测量的 DOM 尺寸 → 边界为空 → 直接放弃。
 *
 *   而我们**本来就精确知道**每个节点的坐标与半径(`layout` 就是自己算的力导向结果),
 *   与其等库量, 不如自己算 —— 确定、可测, 也不依赖副作用时序。
 */
/**
 * 「适应画布」—— **自己算包围盒, 不用库的 `fitView`**。
 *
 * ⚠ 为什么不用 `fitView`: 实测它在这套节点上**完全不工作** —— `getViewport()` 对账
 *   确认 store 是活的那个(它报的 viewport 与 DOM transform 逐位一致), `zoomTo(0.3)`
 *   也立刻生效, 唯独 `fitView(...)` 调用后 viewport **一位都不动**(Promise 正常 resolve,
 *   不报错)。根因是它要从库内部的节点量测结果算包围盒, 而这里的节点是自定义插槽 +
 *   固定 `width/height`, 没有可供它测量的 DOM 尺寸 → 边界为空 → 直接放弃。
 *
 *   而我们**本来就精确知道**每个节点的坐标与尺寸(`layout` 就是自己算的力导向结果),
 *   与其等库量, 不如自己算 —— 确定、可测, 也不依赖副作用时序。
 */
function bounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of layout.value) {
    minX = Math.min(minX, n.x - n.hw);
    maxX = Math.max(maxX, n.x + n.hw);
    minY = Math.min(minY, n.y - n.hh);
    maxY = Math.max(maxY, n.y + n.hh);
  }
  return { minX, minY, maxX, maxY, bw: Math.max(1, maxX - minX), bh: Math.max(1, maxY - minY) };
}
/** 把视口对准包围盒中心(zoom 由调用方给) */
function centerOn(b: ReturnType<typeof bounds>, zoom: number) {
  const store = flowStore.value, el = canvasRef.value;
  if (!store || !el) return;
  void store.setViewport({
    x: el.clientWidth / 2 - ((b.minX + b.maxX) / 2) * zoom,
    y: el.clientHeight / 2 - ((b.minY + b.maxY) / 2) * zoom,
    zoom,
  });
}

function fit() {
  const el = canvasRef.value;
  if (!el || !layout.value.length) return;
  const W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return; // 还没布局出来(隐藏的 tab 里 clientWidth 为 0), 等下次
  const PAD = 28; // 留白: 卡片边框与选中环不要贴到画布边上
  const b = bounds();
  const z = Math.min(1.15, Math.max(0.12, Math.min((W - PAD * 2) / b.bw, (H - PAD * 2) / b.bh)));
  centerOn(b, z);
}

/**
 * 首次进入时的视口 —— **不是全览**。
 *
 * 60 张卡片在 1100×700 的画布上全览只有 0.25 倍上下, 卡片标题直接糊成一团色块,
 * 用户第一眼看到的还是"看不懂的图"。所以首屏给一个**可读的下限**(卡片 12px 字缩到
 * 0.7 仍有 ~8px, 能认出是哪篇), 让图以一个能读的密度铺开; 想看全貌有右下角小地图,
 * 想回到全览有「适应画布」。
 *
 * 少于此数(比如只剩几篇)就没什么可权衡的, 直接全览。
 */
const READABLE_MIN_ZOOM = 0.7;
function fitInitial() {
  const el = canvasRef.value;
  if (!el || !layout.value.length) return;
  const W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return;
  const b = bounds();
  const full = Math.min(1.15, Math.max(0.12, Math.min((W - 56) / b.bw, (H - 56) / b.bh)));
  centerOn(b, Math.max(full, READABLE_MIN_ZOOM));
}

/**
 * 点空白处取消选中。
 *
 * ⚠ 不能直接把 `@pane-click` 挂上去 —— 搜了一圈仓库里的用法, 这个事件在
 *   `@vue-flow/core` 1.48 上并没有稳定触发(节点/边都点了才有)。所以自己监听
 *   画布容器的 pointerdown, 再判断**事件源是不是节点/边**:
 *   点在节点上时不取消(那次点击该由节点自己的处理器负责选中)。
 *   (`canvasRef` 声明在上面 —— 这里的 handler 要用它。)
 */
function onPaneDown(e: PointerEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return;
  if (t.closest(".vue-flow__node") || t.closest(".vue-flow__edge")) return;
  selectedId.value = "";
}
onMounted(() => canvasRef.value?.addEventListener("pointerdown", onPaneDown));
onBeforeUnmount(() => canvasRef.value?.removeEventListener("pointerdown", onPaneDown));

async function focusFirstMatch() {
  const first = layout.value.find((n) => matchedIds.value.has(n.id));
  if (!first) return;
  selectedId.value = first.id;
  await nextTick();
  // 也走 setViewport 而不是 setCenter —— 同一个原因(fit() 的注释): 依赖库内部量测的
  //   那几个视口方法在这套节点上不可靠, 而坐标我们自己有。
  const el = canvasRef.value;
  if (!el || !flowStore.value) return;
  const zoom = 1.2;
  void flowStore.value.setViewport({
    x: el.clientWidth / 2 - first.x * zoom,
    y: el.clientHeight / 2 - first.y * zoom,
    zoom,
  });
}

const pos = computed(() => new Map(layout.value.map((p) => [p.id, p])));
/** 只给度数为 0 的节点画不了边 —— 它们仍要出现在图上(说明"这篇在库里是孤立的"), 但标注出来 */
const isolated = computed(() => layout.value.filter((n) => n.degree === 0).length);
const selectedTitle = computed(() => layout.value.find((n) => n.id === selectedId.value)?.title ?? "");
/** 选中节点在库里的直接相关篇数(边是"文献耦合", 所以叫"相关"而不是"引用") */
const selectedDegree = computed(() => layout.value.find((n) => n.id === selectedId.value)?.degree ?? 0);
</script>

<template>
  <div class="cnp">
    <div class="cnp-bar">
      <span class="cnp-label">关系强度阈值</span>
      <button
        v-for="t in THRESHOLDS" :key="t.v"
        class="cnp-chip" :class="{ on: threshold === t.v }"
        :data-control="`workflow:net-threshold-${t.v}`"
        @click="threshold = t.v; load()"
      >{{ t.label }}</button>
      <button class="cnp-btn" data-control="workflow:net-reload" :disabled="loading" @click="load">
        {{ loading ? "加载中…" : "重新构图" }}
      </button>
    </div>

    <div class="cnp-bar">
      <input
        v-model="search"
        class="cnp-search"
        type="search"
        placeholder="查找文献标题或年份…"
        data-control="workflow:net-search"
        @keydown.enter.prevent="focusFirstMatch"
      />
      <button class="cnp-btn cnp-btn-inline" :disabled="!matchedIds.size" @click="focusFirstMatch">定位</button>
      <span v-if="search.trim()" class="cnp-hits">
        <template v-if="matchedIds.size">命中 {{ matchedIds.size }} 篇 · 已高亮</template>
        <template v-else>没有匹配的文献</template>
      </span>
      <button class="cnp-btn cnp-btn-fit" @click="fit">适应画布</button>
    </div>

    <p v-if="err" class="cnp-err">加载失败：{{ err }}</p>
    <p v-else-if="net" class="cnp-stats">
      库内 <strong>{{ net.stats.papers }}</strong> 篇参与构图，其中
      <strong>{{ net.stats.withRefs }}</strong> 篇解析出参考文献（共 {{ net.stats.totalRefs }} 条）；
      这些条目里只有 <strong>{{ net.stats.inLibraryRefs }}</strong> 条指向库内另一篇 ——
      所以这张图的边**主要来自共引**（两篇引用了同一批外部文献），而不是直接互引。
    </p>

    <div v-if="net" ref="canvasRef" class="cnp-canvas">
      <!-- ⚠ `v-if="ready"` **不是**可有可无的: 上面 `net` 是异步来的(先 null, 后 71 条边)。
           VueFlow 在只给 `:nodes`/`:edges`(非 v-model)时**只在挂载那一刻读一次 props**,
           之后 props 变了它不同步进内部 store —— 症状是"节点都画出来了、边一条没有,
           `.vue-flow__edges` 层整个不存在", 而组件里 `edges` 明明有 71 条。
           (实测确认: VueFlow 的 props.edges 长度 71, 但内部 getEdges 为空。)
           所以等布局算完再挂载它, 让它第一次就读到完整数据。 -->
      <VueFlow
        v-if="ready"
        :nodes="nodes"
        :edges="edges"
        :min-zoom="0.12"
        :max-zoom="2.5"
        :nodes-connectable="false"
        :elements-selectable="true"
        @init="onInit"
        @node-click="(p: { node: Node }) => (selectedId = String(p.node.id))"
      >
        <Background :gap="18" :size="1" pattern-color="#243247" />
        <Controls position="bottom-left" />
        <!-- 小地图与知识中心同款。颜色写死而不是取变量: MiniMap 把 nodeColor 塞进 SVG fill,
             而 CSS 变量在这里不参与解析。底色用暗色系, 与 .cnp-canvas 一致。 -->
        <MiniMap pannable zoomable node-color="#4D84CB" mask-color="rgba(15,23,42,.72)" />
        <template #node-default="{ data }">
          <!-- 节点是**卡片**(与知识中心 ProjectGraphFlow 的节点形态对齐: 标题在框内、
               有边框/底色/阴影/省略号), 而不是"小圆点 + 浮在下面的 9px 小字"。
               后者是这张图此前显得简陋的主要原因之一 —— 标题读不清, 也点不准。

               ⚠⚠ **四个 Handle 是必须的, 不是装饰**。
               Vue Flow 靠 Handle 给每条边找锚点; 自定义节点里一个都没有时, 它**不报错**,
               只是静默地一条边都不画 —— 实测症状是"60 个节点都在、`vue-flow__edges` 层
               整个不存在、边上一条没有"。
               关系图没有方向, 所以四个方向各放一个(全 `type="source"`), 让任意两点间
               都能连; 用 `opacity:0` 而不是 `display:none` 藏起来 —— 后者会让 Vue Flow
               量不到锚点位置, 又会退回"画不出边"。
               `isConnectable=false` 只是不让用户拉新手连边(图是只读的)。 -->
          <Handle type="source" :position="Position.Top" :connectable="false" class="cnp-handle" />
          <Handle type="source" :position="Position.Right" :connectable="false" class="cnp-handle" />
          <Handle type="source" :position="Position.Bottom" :connectable="false" class="cnp-handle" />
          <Handle type="source" :position="Position.Left" :connectable="false" class="cnp-handle" />
          <div
            class="cnp-card"
            :class="{
              'is-seed': data.seed,
              'is-isolated': data.isolated,
              'is-sel': data.sel,
              'is-hot': data.hot,
              'is-dim': data.dim,
            }"
            :style="{ width: data.w + 'px', height: data.h + 'px' }"
            :title="data.title"
          >
            <span class="cnp-card-title">{{ shortTitle(data.title) }}</span>
            <span class="cnp-card-meta">
              <span v-if="data.year" class="cnp-card-year">{{ data.year }}</span>
              <span class="cnp-card-deg">{{ data.degree }}</span>
            </span>
          </div>
        </template>
      </VueFlow>

      <p v-if="!layout.length" class="cnp-empty">
        <template v-if="!net.stats.papers">
          文献库还是空的 —— 先在「文献管理」里导入论文，库里有文献才谈得上引用关系。
        </template>
        <template v-else-if="!net.stats.withRefs">
          库里有 {{ net.stats.papers }} 篇，但没有一篇解析出参考文献表 ——
          引用网络靠参考文献建立，原文里没有参考文献块就无从连边。
        </template>
        <template v-else>
          这个阈值下没有连出任何边 —— 库存 {{ net.stats.withRefs }} 篇有参考文献，调低阈值试试。
        </template>
      </p>

      <p v-if="selectedId" class="cnp-sel">
        <strong>{{ selectedTitle }}</strong>
        <span class="cnp-sel-meta">相关 {{ selectedDegree }} 篇 · 高亮的是与它文献耦合的邻居</span>
      </p>
      <p v-else-if="layout.length && !search.trim()" class="cnp-tip">
        拖拽节点可挪开重叠 · 滚轮缩放 · 点节点看它的相关文献
      </p>
    </div>
    <p v-else-if="!loading && !err" class="cnp-empty">还没有数据。</p>

    <p v-if="net && layout.length" class="cnp-foot">
      {{ net.nodes.length }} 个节点 · {{ net.edges.length }} 条边<template v-if="isolated"> · 其中 {{ isolated }} 个孤立节点（与谁都不相似）</template>
    </p>
  </div>
</template>

<style scoped>
.cnp { display: flex; flex-direction: column; gap: var(--wf-s3); }
.cnp-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cnp-label { font-size: var(--wf-f-xs); color: var(--wf-faint); margin-right: 2px; }
.cnp-chip {
  cursor: pointer; border-radius: var(--wf-r-pill); padding: 3px 11px; font-size: var(--wf-f-xs);
  border: 1px solid var(--wf-line-strong); background: transparent; color: var(--wf-muted);
}
.cnp-chip.on { border-color: var(--wf-accent); color: var(--wf-accent-hi); background: var(--wf-accent-soft); }
.cnp-btn {
  cursor: pointer; border: 1px solid var(--wf-line-strong); border-radius: var(--wf-r-sm);
  background: transparent; color: var(--wf-text-2); padding: 4px 11px; font-size: var(--wf-f-xs);
}
.cnp-btn:disabled { opacity: .5; cursor: not-allowed; }
.cnp-btn-inline { padding: 4px 9px; }
/* 「重新构图」贴右、「适应画布」贴右 —— 各占一行的两端, 不挤在一起 */
.cnp-btn:not(.cnp-btn-inline):not(.cnp-btn-fit) { margin-left: auto; }
.cnp-btn-fit { margin-left: auto; }
.cnp-search {
  flex: 1 1 200px; min-width: 140px; padding: 4px 10px; font-size: var(--wf-f-xs);
  border: 1px solid var(--wf-line-strong); border-radius: var(--wf-r-sm);
  background: var(--wf-surface); color: var(--wf-text-2); font-family: inherit;
}
.cnp-search::placeholder { color: var(--wf-faint); }
.cnp-hits { font-size: var(--wf-f-xs); color: var(--wf-muted); }
.cnp-err { margin: 0; font-size: var(--wf-f-sm); color: var(--wf-danger); }
.cnp-stats { margin: 0; font-size: var(--wf-f-xs); color: var(--wf-muted); line-height: 1.7; }
.cnp-stats strong { color: var(--wf-text-2); }
.cnp-canvas {
  position: relative; border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); overflow: hidden;
  /**
   * 高度是**结构**不是装饰: 原来靠 SVG 的 `height:auto` + viewBox 比例撑, 换成交互画布后
   * 必须给个显式高度, 否则 VueFlow 会塌成 0。60vh 与知识中心那两个图谱的观感一致,
   * 且 320px 下限保证在小屏/矮窗口里仍可操作(而不是缩成一条缝)。
   */
  height: 72vh; min-height: 420px;
}
/**
 * 节点卡片 —— 与知识中心 `ProjectGraphFlow` 的节点同一形态语言:
 * 有边框、有底色、有阴影、标题省略号, 尺寸固定(不靠内容撑, 免得拖拽时抖动)。
 *
 * 它取代了原来的 `.cnp-dot`(小圆点)+ `.cnp-text`(浮在下方的 9px 小字)。
 * 那两个圆点连"谁是谁"都读不出来 —— 标题要去到 9px 且在缩放后更小, 是这张图
 * 被说"简陋"的直接来源。
 */
.cnp-card {
  box-sizing: border-box;
  display: flex; align-items: center; gap: 8px;
  padding: 0 10px;
  border-radius: var(--wf-r-sm);
  border: 1px solid var(--wf-line-strong);
  background: var(--wf-raised);
  color: var(--wf-text-2);
  font-size: var(--wf-f-xs);
  box-shadow: var(--wf-el-1);
  overflow: hidden;
  transition: opacity var(--wf-dur-fast), border-color var(--wf-dur-fast), box-shadow var(--wf-dur-fast);
}
.cnp-card-title {
  flex: 1 1 auto; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cnp-card-meta { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; }
.cnp-card-year { color: var(--wf-faint); font-size: 10px; font-variant-numeric: tabular-nums; }
/* 度数徽标: 图上"谁连着谁多"要一眼看得出 —— 之前靠圆的半径, 卡片上改用数字 */
.cnp-card-deg {
  min-width: 17px; padding: 1px 5px; border-radius: var(--wf-r-pill);
  background: var(--wf-accent-soft); color: var(--wf-accent-hi);
  font-size: 10px; text-align: center; font-variant-numeric: tabular-nums;
}
/* Handle 只用于给边提供锚点, 视觉上必须不可见 —— 但**不能** display:none(none 会让
   Vue Flow 量不到锚点位置, 边又画不出来)。opacity:0 + 零尺寸即可。 */
.cnp-handle { opacity: 0; width: 1px; height: 1px; border: 0; background: transparent; min-width: 0; min-height: 0; }
/* 库标记(seedId 指定的那篇) —— 与知识中心的 root 节点同样用加粗描边 + 大阴影 */
.cnp-card.is-seed { border-color: var(--wf-ok); background: var(--wf-ok-soft); color: var(--wf-text); }
.cnp-card.is-isolated { opacity: .55; border-style: dashed; }
.cnp-card.is-sel { border-color: var(--wf-accent-hi); box-shadow: 0 0 0 2px var(--wf-accent-hi), var(--wf-el-2); color: var(--wf-text); }
.cnp-card.is-hot { border-color: var(--wf-accent); box-shadow: var(--wf-el-2); color: var(--wf-text); }
.cnp-card.is-dim { opacity: .18; }
.cnp-empty { margin: 0; padding: 24px; text-align: center; font-size: var(--wf-f-sm); color: var(--wf-faint); }
.cnp-foot { margin: 0; font-size: var(--wf-f-xs); color: var(--wf-faint); }
/* 选中信息 / 操作提示浮在画布左下, 不占布局高度(否则一选中画布就跳动) */
.cnp-sel, .cnp-tip {
  position: absolute; left: 8px; bottom: 8px; margin: 0; max-width: calc(100% - 150px);
  padding: 6px 10px; border-radius: var(--wf-r-sm);
  background: rgba(15, 23, 42, .88); border: 1px solid var(--wf-line);
  font-size: var(--wf-f-xs); color: var(--wf-text-2); line-height: 1.6;
}
.cnp-sel-meta { margin-left: 8px; color: var(--wf-muted); }
.cnp-tip { color: var(--wf-faint); }
</style>
