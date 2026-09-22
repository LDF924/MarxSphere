<script setup lang="ts">
/**
 * VersionHistoryPanel —— 版本历史与回滚(V425 A1)
 *
 * 由来: 写作舱**有发布动作却没有历史 UI**。素材页「确认并进入创作」、架构页「确认章节」、
 *   创作台「进入合稿」各发一次版(phase3_materials / phase2_architecture / phase4_text),
 *   后端 research_versions 一路记着, 页面却一处都读不到、也退不回去 —— 改坏了没有回头路。
 *   四条后端路由(versions / nodes/:key/history / nodes/:key/rollback / versions/:ver/activate)
 *   此前前端引用数为 0。
 *
 * 三个页签对应后端**两种不同的粒度**, 不能混为一谈:
 *   · 阶段版本 —— 整项目的一次发布(指针快照: 记下各节点当时指向哪条历史), 粒度粗、可"激活为终稿";
 *   · 节点历史 —— 单个节点(章节清单/素材/合稿)的逐次改动, 粒度细、可逐条回滚;
 *   · 恢复   —— 选一个节点, 展开它的历史并就地回滚。
 *
 * 为什么把"恢复"单列一页而不是并进节点历史: 用户的心智是**先想清楚要退什么**
 *   (退章节? 退素材? 退合稿?), 再找那一刻。按节点组织比按时间混排更接近这个动作。
 *
 * 取舍: 只读 + 两类写操作(回滚/激活), 不做 diff 渲染 —— 节点 payload 动辄上百 KB,
 *   前端 diff 大文本的开销与收益不成比例; 每条历史给出 by_role/note/时间足以定位。
 */
import { ref, computed, watch } from "vue";
import { listVersions, listNodeHistory, rollbackNode, activateVersion, type NodeHistoryItem } from "@/shared/tasks";
import { toast, confirmDialog } from "@/shared/ui";
import EmptyState from "./EmptyState.vue";
import NodeDiffView from "./NodeDiffView.vue";

const props = defineProps<{
  open: boolean;
  projectId: string;
  nodeKeys: Array<{ key: string; label: string }>;
  /**
   * 当前节点的内容 —— 由**调用方**读好传进来。
   * 本组件不自己查: "当前态"在写作舱里来自 store(前端权威), 而不是再向后端要一遍,
   * 后端拿到的是最近一次落库的快照, 可能比界面上看到的旧。
   */
  currentNodePayload?: Record<string, unknown> | null;
}>();
const emit = defineEmits<{ (e: "close"): void; (e: "changed", nodeKey: string): void; (e: "node-change", nodeKey: string): void }>();

type Tab = "versions" | "history" | "rollback";
const tab = ref<Tab>("versions");

const versions = ref<Array<{ id: string; version: number; label: string; status: string; createdAt: string }>>([]);
const loadingVersions = ref(false);
const versionsErr = ref("");

/**
 * 当前选中的节点, 先给个初值, 打开时再按**真实历史条数**改选。
 *
 * 初值不能直接取 nodeKeys[0]: 那会恒落在「研究信息」上 —— 而 input 节点只在信息录入完成时
 * 写过一次,**首写不产生历史**(见下方空态文案), 所以它长期是 0 条; 章节/素材/合稿才是
 * 天天在改的那几个。用户一进来就看到"这里没有历史记录", 而隔壁标签里躺着几十条 ——
 * 这是"抽屉打开时该选谁"的问题, 不是数据问题。
 */
const activeNode = ref(props.nodeKeys[0]?.key ?? "sections");
const history = ref<NodeHistoryItem[]>([]);
const loadingHistory = ref(false);
const historyErr = ref("");
const busy = ref(""); // 正在进行的动作标识, 防止连点

/** 正在对比的历史(null = 没开) —— 只读, 不改任何数据 */
const diffTarget = ref<{ id: string; version: number } | null>(null);
function openDiff(h: { id: string; version: number }) {
  diffTarget.value = { id: h.id, version: h.version };
}

/** 阶段标签是**机器标签**(phase3_materials), 直接摊给用户看等于让人读代码 */
const LABELS: Record<string, string> = {
  phase2_architecture: "科研架构确认",
  phase3_materials: "素材版本",
  phase4_text: "正文生成完成",
  phase5_final: "终稿",
  phase5_revision: "修订稿",
};
const PHASE_ORDER = ["phase2_architecture", "phase3_materials", "phase4_text", "phase5_final", "phase5_revision"];
const labelOf = (l: string) => LABELS[l] ?? (l || "未标注");

/** 版本状态用中文 + 颜色区分: superseded 是"被更新的版本取代", 不是失败 */
const STATUS: Record<string, { text: string; cls: string }> = {
  published: { text: "当前终稿", cls: "vh-st-on" },
  superseded: { text: "已被取代", cls: "vh-st-off" },
  rolled_back: { text: "已回滚", cls: "vh-st-off" },
};

const fmt = (iso: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 状态列**只在它能区分时才显示**。
 *
 * 后端两条写入路径的 status 语义不同: publishVersion(每个阶段各发一次版)用的是列默认值
 * `published`, activateVersion 才是"把这一版置 published、其余置 superseded"。
 * 也就是说——**没有任何一版被激活过时, 每一版的 status 都是 published**,
 * 此时把每行都标上「当前终稿」是彻头彻尾的误导(实测第一版就打出了这个标签, 而我一开始
 * 写的是 `some(v.status === 'published')`, 正好让这个错误条件恒成立)。
 * 只有**恰好一个** published 才说明用户真的指定过终稿。
 */
const exactlyOnePublished = computed(() => versions.value.filter((v) => v.status === "published").length === 1);
const statusOf = (s: string) =>
  exactlyOnePublished.value ? (STATUS[s] ?? { text: s || "—", cls: "vh-st-off" }) : { text: "—", cls: "vh-st-off" };

async function loadVersions() {
  loadingVersions.value = true;
  versionsErr.value = "";
  try {
    versions.value = await listVersions(props.projectId);
  } catch (e) {
    versionsErr.value = (e as Error).message || "版本列表加载失败";
  } finally {
    loadingVersions.value = false;
  }
}

async function loadHistory() {
  if (!activeNode.value) return;
  loadingHistory.value = true;
  historyErr.value = "";
  try {
    history.value = await listNodeHistory(props.projectId, activeNode.value);
  } catch (e) {
    historyErr.value = (e as Error).message || "节点历史加载失败";
  } finally {
    loadingHistory.value = false;
  }
}

/** 抽屉每次打开都重新拉一次 —— 外面刚发过版就打开是最常见的用法 */
watch(
  () => props.open,
  async (o) => {
    if (!o) return;
    tab.value = "versions";
    void loadVersions();
    // 先探测每个节点的历史条数, 把默认选中挪到**真的有历史的那个**(顺序即优先级:
    //   章节 → 素材 → 合稿 → 研究信息)。都为空就保持初值, 空态文案会解释为什么。
    const counts = await Promise.all(
      props.nodeKeys.map((n) => listNodeHistory(props.projectId, n.key).then((h) => h.length).catch(() => 0))
    );
    const pick = counts.findIndex((c) => c > 0);
    activeNode.value = pick >= 0 ? props.nodeKeys[pick].key : (props.nodeKeys[0]?.key ?? "");
    history.value = pick >= 0 ? await listNodeHistory(props.projectId, activeNode.value).catch(() => []) : [];
  }
);
watch(activeNode, (k) => { void loadHistory(); emit("node-change", k); });

function switchTab(t: Tab) {
  tab.value = t;
  if (t === "versions") void loadVersions();
  else void loadHistory();
}

async function doActivate(v: number) {
  busy.value = `act-${v}`;
  try {
    await activateVersion(props.projectId, v);
    toast(`已把 v${v} 设为终稿`, "success");
    await loadVersions();
  } catch (e) {
    toast((e as Error).message || "激活失败", "error");
  } finally {
    busy.value = "";
  }
}

/**
 * 回滚会**覆盖该节点当前内容**。确认文案必须让用户知道影响面 ——
 *   "回滚"这个词本身不说明会动什么, 而不同节点的回滚代价差别很大(合稿节点 = 整篇正文)。
 */
async function doRollback(h: NodeHistoryItem) {
  const label = props.nodeKeys.find((n) => n.key === activeNode.value)?.label ?? activeNode.value;
  const ok = await confirmDialog({
    title: "回滚节点内容",
    message: `将把「${label}」恢复为 v${h.version} 时的内容${h.note ? `（${h.note}）` : ""}。当前内容会先存成一条新历史，之后仍可再回滚回来。`,
    okText: "确认回滚",
  });
  if (!ok) return;
  busy.value = `rb-${h.id}`;
  try {
    await rollbackNode(props.projectId, activeNode.value, h.id);
    toast(`已回滚「${label}」到 v${h.version}`, "success");
    await loadHistory();
    emit("changed", activeNode.value);
  } catch (e) {
    toast((e as Error).message || "回滚失败", "error");
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="wf-fade">
      <div v-if="open" class="vh-mask" @click.self="emit('close')">
        <aside class="vh-drawer" role="dialog" aria-label="版本历史">
          <header class="vh-head">
            <div>
              <h3>版本历史</h3>
              <p class="vh-sub">每次阶段确认都会留下一个版本；单个节点的改动逐条可回滚。</p>
            </div>
            <button class="vh-x" data-control="workflow:vh-close" @click="emit('close')">×</button>
          </header>

          <nav class="vh-tabs">
            <button :class="{ on: tab === 'versions' }" data-control="workflow:vh-tab-versions" @click="switchTab('versions')">阶段版本</button>
            <button :class="{ on: tab === 'history' }" data-control="workflow:vh-tab-history" @click="switchTab('history')">节点历史</button>
            <button :class="{ on: tab === 'rollback' }" data-control="workflow:vh-tab-rollback" @click="switchTab('rollback')">恢复</button>
          </nav>

          <div class="vh-body">
            <!-- ① 阶段版本 -->
            <template v-if="tab === 'versions'">
              <p v-if="versionsErr" class="vh-err">{{ versionsErr }}</p>
              <table v-if="versions.length" class="vh-table">
                <thead>
                  <tr><th class="vh-c-num">版本</th><th>阶段</th><th class="vh-c-st">状态</th><th class="vh-c-time">时间</th><th class="vh-c-act">操作</th></tr>
                </thead>
                <tbody>
                  <tr v-for="v in versions" :key="v.id" class="vh-row">
                    <td class="vh-num">v{{ v.version }}</td>
                    <td>{{ labelOf(v.label) }}<span class="vh-raw">{{ v.label }}</span></td>
                    <td><span class="vh-st" :class="statusOf(v.status).cls">{{ statusOf(v.status).text }}</span></td>
                    <td class="vh-time">{{ fmt(v.createdAt) }}</td>
                    <td>
                      <button
                        class="vh-btn"
                        :data-control="`workflow:vh-activate-${v.version}`"
                        :disabled="!!busy"
                        @click="doActivate(v.version)"
                      >{{ busy === `act-${v.version}` ? "处理中…" : "设为终稿" }}</button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <EmptyState
                v-else-if="!loadingVersions"
                size="sm"
                icon="⧉"
                title="还没有发布过版本"
                hint="在科研架构页确认章节、或在素材页点「确认并进入创作」时，会自动发布一个版本。"
              />
              <p v-if="loadingVersions" class="vh-loading">加载中…</p>
            </template>

            <!-- ② 节点历史 / ③ 恢复: 共用节点选择器, 差别只在有没有回滚按钮 -->
            <template v-else>
              <div class="vh-nodebar">
                <span class="vh-nodelabel">节点</span>
                <button
                  v-for="n in nodeKeys" :key="n.key"
                  class="vh-chip" :class="{ on: activeNode === n.key }"
                  :data-control="`workflow:vh-node-${n.key}`"
                  @click="activeNode = n.key"
                >{{ n.label }}</button>
              </div>
              <p v-if="historyErr" class="vh-err">{{ historyErr }}</p>
              <table v-if="history.length" class="vh-table">
                <thead>
                  <tr>
                    <th class="vh-c-num">版本</th><th>来源</th><th>备注</th><th class="vh-c-time">时间</th>
                    <th class="vh-c-act">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="h in history" :key="h.id" class="vh-row">
                    <td class="vh-num">v{{ h.version }}</td>
                    <td>{{ h.byRole }}</td>
                    <td class="vh-note">{{ h.note || "—" }}</td>
                    <td class="vh-time">{{ fmt(h.createdAt) }}</td>
                    <td class="vh-acts">
                      <!-- 对比是**只读**动作, 所以两个页签都给; 回滚会改数据, 只在「恢复」页签出现。
                           此前"看上一版写了什么"的唯一途径就是回滚(覆盖当前) —— 那不是对比。 -->
                      <button
                        class="vh-btn" :data-control="`workflow:vh-diff-${h.id}`"
                        @click="openDiff(h)"
                      >对比</button>
                      <button v-if="tab === 'rollback'" class="vh-btn" :disabled="!!busy" @click="doRollback(h)">
                        {{ busy === `rb-${h.id}` ? "回滚中…" : "回滚到此" }}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <EmptyState
                v-else-if="!loadingHistory"
                size="sm"
                icon="⧉"
                :title="`「${nodeKeys.find((n) => n.key === activeNode)?.label ?? activeNode}」发生过 0 次改动`"
                hint="历史记录的是**上一次**的内容 —— 节点第一次写入时还没有“上一版”，所以这里从第二次改动起才有记录。"
              />
              <p v-if="loadingHistory" class="vh-loading">加载中…</p>
            </template>
          </div>
        </aside>

        <NodeDiffView
          :open="!!diffTarget"
          :project-id="projectId"
          :node-key="activeNode"
          :node-label="nodeKeys.find((n) => n.key === activeNode)?.label ?? activeNode"
          :history-id="diffTarget?.id ?? ''"
          :history-version="diffTarget?.version ?? 0"
          :current-payload="currentNodePayload ?? null"
          @close="diffTarget = null"
        />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.vh-mask { position: fixed; inset: 0; z-index: 95; background: rgba(0, 0, 0, 0.55); display: flex; justify-content: flex-end; }
.vh-drawer {
  width: min(660px, 96vw); height: 100%; display: flex; flex-direction: column;
  background: var(--wf-surface); border-left: 1px solid var(--wf-line); box-shadow: -20px 0 60px rgba(0, 0, 0, 0.35);
}
.vh-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 18px 22px 12px; }
.vh-head h3 { margin: 0; font-size: var(--wf-f-lg); color: var(--wf-text); }
.vh-sub { margin: 5px 0 0; font-size: var(--wf-f-sm); color: var(--wf-muted); max-width: 52ch; line-height: 1.6; }
.vh-x { border: 0; background: none; font-size: 22px; line-height: 1; color: var(--wf-muted); cursor: pointer; }
.vh-x:hover { color: var(--wf-text); }
.vh-tabs { display: flex; gap: 4px; padding: 0 22px; border-bottom: 1px solid var(--wf-line); }
.vh-tabs button {
  padding: 9px 14px; border: 0; border-bottom: 2px solid transparent; background: none;
  color: var(--wf-muted); font-size: var(--wf-f-sm); cursor: pointer;
}
.vh-tabs button.on { color: var(--wf-text); border-bottom-color: var(--wf-accent); font-weight: 600; }
.vh-body { flex: 1; overflow-y: auto; padding: 16px 22px 26px; }
.vh-nodebar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 14px; }
.vh-nodelabel { font-size: var(--wf-f-sm); color: var(--wf-muted); }
.vh-chip {
  padding: 4px 11px; border: 1px solid var(--wf-line); border-radius: var(--wf-r-pill);
  background: var(--wf-raised); color: var(--wf-text-2); font-size: var(--wf-f-sm); cursor: pointer;
}
.vh-chip.on { border-color: var(--wf-accent); color: var(--wf-text); background: var(--wf-accent-soft); }
.vh-table { width: 100%; border-collapse: collapse; font-size: var(--wf-f-sm); }
.vh-table th {
  text-align: left; padding: 7px 10px; color: var(--wf-faint); font-weight: 500;
  border-bottom: 1px solid var(--wf-line); white-space: nowrap;
}
.vh-row td { padding: 10px; border-bottom: 1px solid var(--wf-line); color: var(--wf-text-2); vertical-align: top; }
.vh-c-num { width: 58px; }
.vh-c-st { width: 84px; }
.vh-c-time { width: 116px; }
.vh-c-act { width: 128px; }
.vh-acts { display: flex; gap: 6px; flex-wrap: wrap; }
.vh-num { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--wf-text); white-space: nowrap; }
.vh-raw { display: block; margin-top: 2px; font-size: 11px; color: var(--wf-faint); font-family: ui-monospace, monospace; }
.vh-note { max-width: 30ch; word-break: break-word; }
.vh-time { color: var(--wf-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
.vh-st { font-size: 12px; }
.vh-st-on { color: #6FAE7C; }
.vh-st-off { color: var(--wf-faint); }
.vh-btn {
  padding: 5px 12px; border: 1px solid var(--wf-line-strong); border-radius: var(--wf-r-sm);
  background: var(--wf-raised); color: var(--wf-text-2); font-size: 12px; cursor: pointer; white-space: nowrap;
}
.vh-btn:hover:not(:disabled) { border-color: var(--wf-accent); color: var(--wf-text); }
.vh-btn:disabled { opacity: .5; cursor: not-allowed; }
.vh-err { margin: 0 0 12px; font-size: var(--wf-f-sm); color: #E1756B; }
.vh-loading { margin: 12px 0 0; font-size: var(--wf-f-sm); color: var(--wf-faint); }
</style>
