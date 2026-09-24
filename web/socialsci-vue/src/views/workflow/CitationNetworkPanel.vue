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
 * 力导向用 d3-force 自己算 + SVG 渲染, 不引入新依赖(仓库里已有 d3-force)。
 * 不做拖拽/缩放 —— 这是一个"看一眼关系"的图, 不是编辑器。
 */
import { computed, onMounted, ref, watch } from "vue";
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

const W = 720, H = 460;

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

/**
 * d3-force 布局 → 固定的 SVG 坐标。
 *
 * 在**加载后算一次**并把结果冻成静态坐标, 而不是每帧重算: 静态图在 Vue 里渲染成本低、
 * 也不会因为 re-render 抖动。力导向本身用固定迭代次数(sim.tick)跑到收敛 ——
 * 不用 sim.on("tick") 驱动渲染, 那会把每次重渲染和物理模拟绑在一起。
 */
const layout = ref<Array<NetNode & { x: number; y: number; r: number }>>([]);

async function runLayout() {
  const n = net.value;
  if (!n?.nodes.length) { layout.value = []; return; }
  const d3 = await import("d3-force");
  // ⚠ 不要用 `as never` 去糊 d3 的类型。它要的是 SimulationNodeDatum, 而 `never` 是它的
  //   **子类型** —— 传进去编译过得了, 但 d3 的回调签名会跟着退化成 never, 后面 `d.id` 就写不出来。
  //   这里老老实实声明成 d3 认识的形状(多带 x/y 可选), 边上再挂一个 weight 供渲染。
  type SimNode = d3.SimulationNodeDatum & NetNode;
  type SimLink = d3.SimulationLinkDatum<SimNode> & { weight: number };
  const byId = new Map<string, SimNode>(n.nodes.map((x) => [x.id, { ...x }]));
  const links: SimLink[] = n.edges
    .map((e) => ({ source: byId.get(e.source)!, target: byId.get(e.target)!, weight: e.weight }))
    .filter((l) => l.source && l.target);
  const nodes: SimNode[] = [...byId.values()];
  const maxDeg = Math.max(1, ...nodes.map((x) => x.degree));
  const sim = d3.forceSimulation<SimNode>(nodes)
    .force("link", d3.forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(70).strength(0.35))
    .force("charge", d3.forceManyBody().strength(-160))
    .force("center", d3.forceCenter(W / 2, H / 2))
    .force("collide", d3.forceCollide().radius(16))
    .stop();
  for (let i = 0; i < 300; i++) sim.tick();
  // 把坐标夹进画布(力导向偶尔会把孤立节点推到边界外)
  const pad = 24;
  layout.value = nodes.map((x) => ({
    ...x,
    x: Math.max(pad, Math.min(W - pad, x.x ?? W / 2)),
    y: Math.max(pad, Math.min(H - pad, x.y ?? H / 2)),
    // 半径按度数: 连得多的更显眼。8~22px
    r: 8 + Math.round((x.degree / maxDeg) * 14),
  }));
}
// 数据到手 → 排一次版。watch 而不是在 load 里直接调: 让"取数"与"排版"分开, 各自可测。
watch(net, () => void runLayout());

const pos = computed(() => new Map(layout.value.map((p) => [p.id, p])));
const lines = computed(() =>
  net.value?.edges
    .map((e) => ({ a: pos.value.get(e.source), b: pos.value.get(e.target), weight: e.weight }))
    .filter((l) => l.a && l.b) ?? [],
);
/** 只给度数为 0 的节点画不了边 —— 它们仍要出现在图上(说明"这篇在库里是孤立的"), 但标注出来 */
const isolated = computed(() => layout.value.filter((n) => n.degree === 0).length);
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

    <p v-if="err" class="cnp-err">加载失败：{{ err }}</p>
    <p v-else-if="net" class="cnp-stats">
      库内 <strong>{{ net.stats.papers }}</strong> 篇参与构图，其中
      <strong>{{ net.stats.withRefs }}</strong> 篇解析出参考文献（共 {{ net.stats.totalRefs }} 条）；
      这些条目里只有 <strong>{{ net.stats.inLibraryRefs }}</strong> 条指向库内另一篇 ——
      所以这张图的边**主要来自共引**（两篇引用了同一批外部文献），而不是直接互引。
    </p>

    <div v-if="net" class="cnp-canvas">
      <svg :viewBox="`0 0 ${W} ${H}`" class="cnp-svg" role="img" aria-label="引用网络图">
        <!-- 边: 粗细随相似度 -->
        <line
          v-for="(l, i) in lines" :key="'e' + i"
          :x1="l.a!.x" :y1="l.a!.y" :x2="l.b!.x" :y2="l.b!.y"
          :stroke-width="Math.max(0.6, Math.min(3, l.weight * 14))"
          class="cnp-edge"
        />
        <!-- 节点 -->
        <g v-for="n in layout" :key="n.id">
          <circle :cx="n.x" :cy="n.y" :r="n.r" class="cnp-node" :class="{ 'is-seed': n.isSeed, 'is-isolated': n.degree === 0 }" />
          <text :x="n.x" :y="n.y - n.r - 4" class="cnp-text">{{ n.title.length > 12 ? n.title.slice(0, 12) + "…" : n.title }}</text>
        </g>
      </svg>
      <!-- 空态的两种原因**必须分开说** —— 它们的下一步完全不同:
           库本身是空的(去导入文献) vs 有文献但都不够相似(调阈值)。
           混成一句"没有数据"会让人在错的方向上试。
           ⚠ 库为空这条不是假想: CI / 新部署里 `data/` 是 gitignore 的, 文献库就是 0 篇。 -->
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
  margin-left: auto; cursor: pointer; border: 1px solid var(--wf-line-strong); border-radius: var(--wf-r-sm);
  background: transparent; color: var(--wf-text-2); padding: 4px 11px; font-size: var(--wf-f-xs);
}
.cnp-btn:disabled { opacity: .5; cursor: not-allowed; }
.cnp-err { margin: 0; font-size: var(--wf-f-sm); color: var(--wf-danger); }
.cnp-stats { margin: 0; font-size: var(--wf-f-xs); color: var(--wf-muted); line-height: 1.7; }
.cnp-stats strong { color: var(--wf-text-2); }
.cnp-canvas {
  position: relative; border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface-2); overflow: hidden;
}
.cnp-svg { display: block; width: 100%; height: auto; }
.cnp-edge { stroke: var(--wf-line-hard); opacity: .55; }
.cnp-node { fill: var(--wf-accent); opacity: .85; stroke: var(--wf-surface); stroke-width: 1.5; }
.cnp-node.is-seed { fill: var(--wf-ok); }
.cnp-node.is-isolated { fill: var(--wf-faint); opacity: .5; }
.cnp-text { font-size: 9px; fill: var(--wf-muted); text-anchor: middle; pointer-events: none; }
.cnp-empty { margin: 0; padding: 24px; text-align: center; font-size: var(--wf-f-sm); color: var(--wf-faint); }
.cnp-foot { margin: 0; font-size: var(--wf-f-xs); color: var(--wf-faint); }
</style>
