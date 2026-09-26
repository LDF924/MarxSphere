<script setup lang="ts">
/**
 * WorkflowShell — 写作舱五页共用的外壳(V425 B2/D2)
 *
 * 由来: 此前每个页脚都自己渲染 `<PhaseProgressBar />`, **没有共用外壳**。于是两件事无处安放:
 *   · **项目切换**(B2): 工作台里只能看到 `lastTask_workflow` 指向的那一个项目, 要换得退回外壳的
 *     「历史记录」。后端 listProjects/archiveProject 一直就绪, 前端引用数为 0;
 *   · **快捷键**(D2): 五页之间来回要一路点, 全舱一个快捷键都没有。
 * 抽成外壳后, 这两样各只有一份实现, 而不是往五个页面里各抄一遍。
 *
 * 布局: 左项目栏(可折叠, 默认展开) / 中主区(槽位) / 右快捷键浮标。
 *   ⚠ **外壳不渲染进度条**: 进度条是 `position:sticky`, 而 sticky 的约束矩形是**滚动容器的
 *     内容盒** —— 也就是 `.wf-page`。而 `.wf-page` 是各视图自己的根元素(在槽位里), 外壳够不着它。
 *     把进度条挪到外壳里就等于把它移出滚动容器, 吸顶立刻失效(verify-layout 的吸顶断言会红)。
 *     所以: 外壳只管左右两栏, 进度条**仍留在五个视图内**, 位置与层级一字未动。
 */
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useWorkflowStore } from "./stores/workflow";
import { listProjects, archiveProject, deleteProject, type SocProject } from "@/shared/tasks";
import { toast, confirmDialog } from "@/shared/ui";
import EmptyState from "./EmptyState.vue";
import VersionHistoryPanel from "./VersionHistoryPanel.vue";
import { stageTitle } from "@/shared/stages";

const store = useWorkflowStore();
const router = useRouter();

// ── 左侧项目栏 ──
/**
 * 默认展开 —— 但**窄屏默认收起**。
 *
 * ⚠ 2026-09-22 修: 窄屏(≤1100px)下这条栏是 `position:absolute` 的**覆盖层**(见样式),
 *   默认展开就会压住主区内容。实测在 1024 下, 覆盖层里的项目条目与主区的按钮整片重叠
 *   (布局门禁的"按钮无重叠"如实报了出来)。
 *   覆盖层本该是"要看才拉出来"的东西, 默认摊开既遮内容又没必要。
 *   用户手动开合过就以他的选择为准(localStorage 里有记录时不覆盖)。
 */
const NARROW = "(max-width: 1100px)";
const railSaved = localStorage.getItem("skf_proj_rail");
const railOpen = ref(railSaved !== null ? railSaved !== "0" : !window.matchMedia(NARROW).matches);
function toggleRail() {
  railOpen.value = !railOpen.value;
  try { localStorage.setItem("skf_proj_rail", railOpen.value ? "1" : "0"); } catch { /* 隐私模式 */ }
}

const projects = ref<SocProject[]>([]);
const projLoaded = ref(false);
const projErr = ref("");
const query = ref("");
/** 默认只看进行中 —— 做完的/归档的堆在前面会把当前项目挤下去(用户真正要找的是"我在做的那个") */
const showArchived = ref(false);

async function loadProjects() {
  try {
    projects.value = await listProjects();
    projErr.value = "";
  } catch (e) {
    projErr.value = (e as Error).message || "项目列表加载失败";
  } finally {
    projLoaded.value = true;
  }
}

const visible = computed(() => {
  const q = query.value.trim().toLowerCase();
  return projects.value
    .filter((p) => (showArchived.value ? true : p.status !== "archived"))
    .filter((p) => !q || p.title.toLowerCase().includes(q) || (p.topic ?? "").toLowerCase().includes(q));
});

/**
 * 被"含已归档"开关挡掉的数量。
 *
 * 归档之后项目栏会变空, 而用户的第一反应是"我的项目没了" —— 空态里直接点出"另有 N 个已归档"
 * 比一句"还没有项目"诚实得多。归档是收起来, 不是删掉, 这一层得让人看得见。
 */
const hiddenArchived = computed(() => projects.value.filter((p) => p.status === "archived").length);

const STATUS_LABEL: Record<string, string> = { active: "进行中", "in-progress": "进行中", archived: "已归档", done: "已完成" };
/** 阶段号 → 中文名。取自真源, 认不出给空串(旧实现会错写成「统稿定稿」) */
const phaseLabel = (ph: number) => stageTitle(ph);

function fmtDay(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n: number) => String(n).padStart(2, "0");
  return sameDay ? `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}-${pad(d.getDate())}`;
}

const switching = ref("");
async function pick(p: SocProject) {
  if (p.id === store.taskId || switching.value) return;
  switching.value = p.id;
  try {
    await store.switchProject(p.id);
    // 切完刷新列表: 刚才那个项目的标题可能刚被改过
    await loadProjects();
    toast(`已切到「${p.title}」`, "success");
  } catch (e) {
    toast(`切换失败: ${(e as Error).message}`, "error");
  } finally {
    switching.value = "";
  }
}

/**
 * 归档是**软删**(status='archived'), 列表随之不再返回它 —— 对用户就是"不见了"。
 * 所以必须二次确认, 并把"怎么找回来"讲清楚: 归档的项目要回外壳的历史记录里找。
 */
/**
 * 删除项目 —— 与「归档」是**两件不同的事**, 所以文案必须把区别说死:
 *   · 归档 = 软删(`status='archived'`), 数据保留, 列表不再返回, 可在外壳「历史记录」找回;
 *   · 删除 = 后端 `DELETE`, 项目从列表消失且**不能按原样找回**。
 * 这里用 `danger: true` 的二次确认, 并把"无法找回"写进正文 —— 这是本页唯一不可逆的操作。
 */
async function doDelete(p: SocProject) {
  const ok = await confirmDialog({
    title: "删除项目",
    message: `「${p.title}」将被删除，且无法从「历史记录」找回。
(只想让它从列表里消失、日后还能找回 → 用「归档」)`,
    okText: "删除",
    cancelText: "取消",
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteProject(p.id);
    toast(`已删除「${p.title}」`, "success");
    await loadProjects();
    if (p.id === store.taskId) {
      const next = visible.value[0];
      if (next) await store.switchProject(next.id);
      else store.resetLocal();
    }
  } catch (e) {
    toast(`删除失败: ${(e as Error).message}`, "error");
  }
}

async function doArchive(p: SocProject) {
  const ok = await confirmDialog({
    title: "归档项目",
    message: `「${p.title}」将从项目栏移除（数据保留，可在外壳的「历史记录」里找回）。`,
    okText: "归档",
    cancelText: "取消",
    danger: true,
  });
  if (!ok) return;
  try {
    await archiveProject(p.id);
    toast(`已归档「${p.title}」`, "success");
    await loadProjects();
    // 归档的正好是当前项目 → 指针要挪走, 否则主区还停在一个"已不在列表里"的项目上
    if (p.id === store.taskId) {
      const next = visible.value[0];
      if (next) await store.switchProject(next.id);
      else { store.resetLocal(); toast("没有其它项目了，已清空工作区", "warning"); }
    }
  } catch (e) {
    toast(`归档失败: ${(e as Error).message}`, "error");
  }
}

// ── 快捷键 ──
/**
 * 阶段跳转 —— **与进度条节点同规则: 一律可去**。
 *
 * ⚠ V425 改。上一版写的是"往前只能一格", 理由是"否则会绕过既有校验"。那个理由**不成立**:
 *   既有校验(章节未全部完成不能进入合稿等)长在**各页的按钮**上, 而不是在导航上 ——
 *   跳到合稿页并不会让那些按钮失效, 它们照样拦得住"真的不该做"的动作。
 *   而进度条节点现在已经放行(见 PhaseProgressBar 的 goNode), 快捷键若还守着旧规则,
 *   就会出现"鼠标能去、键盘不能"的两套规则打架。
 * `ph` 就是 store 里的阶段号（来自 shared/stages.ts）。
 */
/**
 * 快捷键步骤表 —— 与进度条**同一份真源**，只是把索引位当按键。
 *
 * ⚠ 2026-09-26 改：原先是硬编码 5 条，且按下 Alt+N 时用 `want = STEPS.findIndex(...) + 1`
 *   **从数组下标反推阶段号**。加一个阶段后，只要有一处的顺序与 `ph` 对不上，
 *   快捷键就会**静默跳错页**（不报错，只是去的地方不对）。
 *   现在 `ph` 直接从阶段表来，键位序号与 `ph` 解耦。
 *
 * 键位只覆盖**本课题看得到的**阶段（定性研究不显示「研究实施」）——
 * 否则按 Alt+3 会跳到一个进度条上根本没有的节点，用户对不上号。
 */
const STEPS = computed(() =>
  store.stages.map((s, i) => ({
    key: String(i + 1),
    ph: s.ph,
    route: s.path,
    title: s.title,
  })),
);

const helpOpen = ref(false);

/**
 * ── 版本历史（2026-09-26 从合稿页提到外壳） ──
 *
 * 由来：这个抽屉此前**只挂在合稿页**（FinalizeView.vue）。而发布版本的动作散在三页上 ——
 *   架构页发 `phase2_architecture`、素材页发 `phase3_materials`、创作台发 `phase4_text` ——
 *   也就是说用户在前两页把东西改坏了，**当场没有回头路**，得先跳到第 5 步才能回滚。
 *   两页发布、却只有一页能撤销，是明显的错配。
 *
 * 放外壳的理由与项目栏、快捷键一致：这三样都是**跨页共用**的东西，各页各写一份必然分叉。
 * 外壳自己渲染抽屉、自己管开合，五个页面零改动就有了入口。
 *
 * `nodeKeys` 里各节点的**中文标签**与回滚后的刷新责任都与具体页面相关，但那不影响这里 ——
 * 回滚后统一走 store.loadProject()，store 是五页共用的同一份状态。
 */
const vhOpen = ref(false);
/**
 * 回滚发生后广播给各页 —— 有页面对"回滚了哪个节点"还有**额外**的事要做。
 *
 * 目前只有合稿页用到: 它要补拉 `review_result` / `merge_generated`
 * (那两项只在项目列上, 工作台快照里读不到)。
 * 其余四页不需要关心, 所以用 emit 而不是让每页都去 watch。
 */
const emit = defineEmits<{ (e: "node-rolled-back", nodeKey: string): void }>();
/** 抽屉可回滚的节点。与 FinalizeView 原来的 VH_NODES 同一份口径（那边已改为引用这里） */
const VH_NODES = [
  // 顺序 = 抽屉打开时的默认选中优先级: 前三个是天天在改的, 「研究信息」只在录入完成时写过一次
  { key: "sections", label: "章节与正文" },
  { key: "materials", label: "素材" },
  { key: "finalize", label: "合稿" },
  { key: "input", label: "研究信息" },
];
/** 抽屉里当前选中的节点 —— 对比要知道"拿哪一份当前态来比" */
const activeVhNode = ref("sections");

/**
 * 供版本对比用的"当前内容"。
 *
 * 从 **store** 现取, 而不是向后端再查一遍 —— 界面上看到的才是权威(后端拿的是最近一次
 * 落库的快照, 用户刚敲的字可能还没落盘, 那样对比出来的"当前"是错的)。
 * 形状必须与历史 payload 一致, 否则 diff 会把每个字段都当成"变了"。
 * 输入/素材节点不在这里给(null), 对比视图会如实显示"没有可对比的内容" ——
 * 给一个空对象会让它显示成"全部删除了", 那是误导。
 */
const currentPayloadForDiff = computed<Record<string, unknown> | null>(() => {
  switch (activeVhNode.value) {
    case "sections":
      return { sections: store.sections ?? [] };
    case "finalize":
      return {
        mergedTitle: store.mergedTitle ?? "",
        mergedAbstract: store.mergedAbstract ?? "",
        mergedKeywords: store.mergedKeywords ?? "",
        mergedFullText: store.mergedFullText ?? "",
        mergedReferences: store.mergedReferences ?? "",
      };
    default:
      return null;
  }
});

/**
 * 回滚之后必须把 store 重新拉一遍 ——
 *   否则界面还停在回滚**之前**的内容上(后端已经变了), 用户会以为回滚没生效,
 *   然后在旧内容上继续编辑 → saveProject 把旧内容又写回去, 回滚被静默抵消。
 * 这是"读改写"三种失效里最隐蔽的一种, 前后端都看不出来。
 *
 * 这里从 FinalizeView 的 `onNodeRolledBack` 搬过来，两处差异：
 *   · 原版在合稿页还会顺带 `refreshMerged()`（拿 review_result 等**列上才有**的字段）。
 *     那一步留在合稿页做 —— 其余页没有那几个字段的展示位，多拉一次没有意义。
 *     代价：在别页回滚 finalize 后回到合稿页，审查报告要等本页挂载时的 refreshMerged 才补齐，
 *     这在原来的时序上本来就是这样（合稿页两个加载都在挂载时跑）。
 *   · 文案不再写死"刷新页面"：回滚素材/章节时本页不受影响，说"页面"会让人以为整页重载了。
 */
async function onNodeRolledBack(nodeKey: string) {
  try {
    await store.loadProject();
    // 广播: 各页若对"回滚了某个节点"还有额外动作, 在这里响应(合稿页要补拉只存在于列上的字段)
    emit("node-rolled-back", nodeKey);
    toast(`已回滚「${VH_NODES.find((n) => n.key === nodeKey)?.label ?? nodeKey}」，内容已重新载入`, "success");
  } catch { /* loadProject 自身吞错; 刷新失败不该再弹一次 */ }
}

/**
 * 在输入框里打字时**一律不劫持**。
 *
 * 只有 `?` 例外的前提是没有修饰键 —— 但即便那样也不该在 textarea 里弹帮助:
 * 用户正在写正文。所以判定只看焦点在哪, 不看按了哪个组合。
 */
function inEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function onKeydown(e: KeyboardEvent) {
  if (inEditable(e.target)) return;
  if (e.ctrlKey || e.metaKey) {
    if (e.key === "s") {
      // 主区各页自己有"保存"动作, 但它们的执行体分散在各页 —— 这里只做统一的中断与提示,
      // 不假装能代替页面保存(保存失败要由页面自己说, 由外壳统一说会掩盖真实错误)。
      e.preventDefault();
      void store.saveProject().then(() => toast("已保存", "success"));
      return;
    }
    return;
  }
  if (e.key === "?") { e.preventDefault(); helpOpen.value = !helpOpen.value; return; }
  if (e.key === "Escape") { helpOpen.value = false; return; }
  // Alt+数字 切阶段（键位 = 该课题可见阶段的序号，阶段号从真源来）
  if (e.altKey) {
    const hit = STEPS.value.find((s) => s.key === e.key);
    if (hit) {
      e.preventDefault();
      const want = hit.ph;
      /**
       * ⚠ 光改 `store.phase` **不会换页** —— 这一页是 vue-router 的独立路由。
       *   我第一版只调了 store.goto(), 结果按快捷键什么都没发生(hash 一动不动),
       *   而当时那条"越级被拦"的断言因为"hash 没变"还**假通过**了一次:
       *   拦截与没生效，从 hash 上看是一样的。两件事都要做: 推路由 + 记阶段。
       *
       * ⚠ 但要注意方向: `store.goto(want)` 会**推进阶段标量**。只是想"去看一眼"时
       *   不该把"你走到哪了"也一起改掉 —— 所以这里分两种情况:
       *   · 回看已走过的阶段 → 只推路由, 不动标量(看了不该算走过);
       *   · 往前走 → 标量跟着走(用户确实是往下一步去了)。
       */
      if (want > store.phase) store.goto(want);
      void router.push(hit.route);
    }
  }
}

onMounted(() => {
  void loadProjects();
  window.addEventListener("keydown", onKeydown);
});
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="wfs-root">
    <!-- 左: 我的研究 -->
    <aside class="wfs-rail" :class="{ 'is-collapsed': !railOpen }">
      <div class="wfs-rail-head">
        <strong v-if="railOpen" class="wfs-rail-title">我的研究</strong>
        <button
          class="wfs-rail-toggle" :title="railOpen ? '收起项目栏' : '展开项目栏'"
          data-control="workflow:rail-toggle" @click="toggleRail"
        >{{ railOpen ? "‹" : "›" }}</button>
      </div>

      <template v-if="railOpen">
        <input
          v-model="query" class="wfs-search" placeholder="搜索项目…"
          data-control="workflow:proj-search"
        />
        <label class="wfs-arch">
          <input v-model="showArchived" type="checkbox" data-control="workflow:proj-show-archived" />
          <span>含已归档</span>
        </label>

        <p v-if="projErr" class="wfs-err">{{ projErr }}</p>

        <div class="wfs-list">
          <div
            v-for="p in visible" :key="p.id"
            class="wfs-item" :class="{ on: p.id === store.taskId }"
            :data-control="`workflow:proj-${p.id}`"
            @click="pick(p)"
          >
            <div class="wfs-item-top">
              <span class="wfs-item-title">{{ p.title }}</span>
              <span v-if="p.id === store.taskId" class="wfs-badge-now">当前</span>
            </div>
            <div class="wfs-item-meta">
              <span class="wfs-badge" :class="`is-${p.status}`">{{ STATUS_LABEL[p.status] ?? p.status }}</span>
              <span>{{ phaseLabel(p.phase) || "未开始" }}</span>
              <span class="wfs-dot">·</span>
              <span>{{ fmtDay(p.updatedAt) }}</span>
            </div>
            <button
              class="wfs-archive" :disabled="!!switching"
              :data-control="`workflow:proj-archive-${p.id}`"
              title="归档(数据保留，可在外壳历史记录里找回)"
              @click.stop="doArchive(p)"
            >归档</button>
            <button
              class="wfs-del" :disabled="!!switching"
              :data-control="`workflow:proj-delete-${p.id}`"
              title="删除(不可找回；只想从列表移除请用「归档」)"
              @click.stop="doDelete(p)"
            >删</button>
          </div>

          <EmptyState
            v-if="projLoaded && !visible.length"
            size="sm"
            icon="⬚"
            :title="query ? '没有匹配的项目' : (hiddenArchived ? '没有进行中的项目' : '还没有项目')"
            :hint="query ? '换个关键词试试。'
              : hiddenArchived ? `另有 ${hiddenArchived} 个已归档项目 —— 勾选上面的「含已归档」可以看到。`
              : '在下方进度条点「＋ 新项目」开始一个。'"
          />
          <p v-if="!projLoaded" class="wfs-loading">加载中…</p>
        </div>
      </template>
    </aside>

    <!-- 中: 主区。结构与内边距层级原样保留 —— 见文件头"刻意不动"那段 -->
    <slot />

    <!-- 右: 快捷键浮标 -->
    <div class="wfs-keys">
      <!-- 版本历史入口(2026-09-26 从合稿页提到外壳): 五页都有，不再只有第 5 步能回滚 -->
      <button
        v-if="store.taskId"
        class="wfs-keys-btn wfs-vh-btn"
        data-control="workflow:version-history"
        title="版本历史与回滚"
        @click="vhOpen = true"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M3 12a9 9 0 109-9 9 9 0 00-7.5 4M3 4v4h4" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M12 8v4l3 2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button class="wfs-keys-btn" data-control="workflow:keys-help" title="快捷键(?)" @click="helpOpen = !helpOpen">?</button>
    </div>

    <!-- 版本历史抽屉 —— 挂在外壳上, 与当前是哪一页无关。
         ⚠ 不能挪进 `<slot />`: 那槽位在主区的滚动容器里, 抽屉是 fixed 浮层, 会被裁切。 -->
    <VersionHistoryPanel
      :open="vhOpen"
      :project-id="store.taskId"
      :node-keys="VH_NODES"
      :current-node-payload="currentPayloadForDiff"
      @close="vhOpen = false"
      @changed="onNodeRolledBack"
      @node-change="activeVhNode = $event"
    />

    <Transition name="wf-fade">
      <div v-if="helpOpen" class="wfs-help-mask" @click.self="helpOpen = false">
        <div class="wfs-help">
          <h3>键盘快捷键</h3>
          <table>
            <tbody>
              <tr v-for="s in STEPS" :key="s.key">
                <td><kbd>Alt</kbd> + <kbd>{{ s.key }}</kbd></td>
                <td>切到「{{ s.title }}」</td>
              </tr>
              <tr><td><kbd>Ctrl</kbd> + <kbd>S</kbd></td><td>保存当前项目</td></tr>
              <tr><td><kbd>?</kbd></td><td>显示 / 收起本表</td></tr>
              <tr><td><kbd>Esc</kbd></td><td>关闭浮层</td></tr>
            </tbody>
          </table>
          <p class="wfs-help-note">在输入框 / 正文里打字时不会触发以上任何一条。</p>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 外壳只负责横向排布; 高度由主区自己那套(wf-page / ws-page-root)决定 */
.wfs-root { display: flex; align-items: stretch; height: 100%; min-width: 0; }

/* ── 左项目栏 ── */
.wfs-rail {
  flex: 0 0 232px; width: 232px; display: flex; flex-direction: column;
  border-right: 1px solid var(--wf-line); background: var(--wf-surface);
  transition: flex-basis .18s var(--wf-ease-out), width .18s var(--wf-ease-out);
}
.wfs-rail.is-collapsed { flex-basis: 40px; width: 40px; }
.wfs-rail-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 12px 10px 8px; }
.wfs-rail-title { font-size: var(--wf-f-md); color: var(--wf-text); }
.wfs-rail-toggle {
  border: 1px solid var(--wf-line); background: var(--wf-raised); color: var(--wf-muted);
  width: 22px; height: 22px; border-radius: var(--wf-r-sm); cursor: pointer; line-height: 1;
  flex-shrink: 0;
}
.wfs-rail-toggle:hover { color: var(--wf-text); border-color: var(--wf-line-strong); }
.wfs-rail.is-collapsed .wfs-rail-head { justify-content: center; padding: 12px 0 8px; }
.wfs-search {
  margin: 0 10px 6px; padding: 6px 10px; border: 1px solid var(--wf-line);
  border-radius: var(--wf-r-sm); background: var(--wf-raised); color: var(--wf-text); font-size: var(--wf-f-sm);
}
.wfs-arch { display: flex; align-items: center; gap: 5px; margin: 0 10px 8px; font-size: var(--wf-f-sm); color: var(--wf-faint); cursor: pointer; }
.wfs-list { flex: 1; overflow-y: auto; padding: 0 8px 14px; }
.wfs-item {
  position: relative; padding: 9px 10px; margin-bottom: 4px; cursor: pointer;
  border: 1px solid transparent; border-radius: var(--wf-r-sm);
  transition: background .14s, border-color .14s;
}
.wfs-item:hover { background: var(--wf-raised); }
.wfs-item.on { border-color: var(--wf-line-strong); background: var(--wf-accent-soft); }
.wfs-item-top { display: flex; align-items: baseline; gap: 6px; }
.wfs-item-title {
  font-size: var(--wf-f-sm); font-weight: 600; color: var(--wf-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;
}
.wfs-badge-now { font-size: 10px; color: var(--wf-accent); border: 1px solid var(--wf-accent); border-radius: var(--wf-r-pill); padding: 0 6px; flex-shrink: 0; }
.wfs-item-meta { display: flex; align-items: center; gap: 5px; margin-top: 4px; font-size: 11px; color: var(--wf-faint); }
.wfs-badge { font-size: 10px; padding: 0 5px; border-radius: var(--wf-r-pill); border: 1px solid var(--wf-line); }
.wfs-badge.is-archived { color: var(--wf-faint); }
.wfs-dot { opacity: .5; }
/* 归档按钮 hover 才出现 —— 常驻会让列表看起来全是操作按钮, 反而看不出哪个是当前项目 */
/* 两个操作并排: 归档在左、删除在右(删除更危险, 放最右且 hover 才出现, 避免误点) */
.wfs-del {
  position: absolute; right: 6px; bottom: 6px; opacity: 0;
  padding: 1px 7px; font-size: 11px; cursor: pointer;
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface); color: var(--wf-faint);
}
.wfs-item:hover .wfs-del { opacity: 1; }
.wfs-del:hover:not(:disabled) { color: #E1756B; border-color: #B06A6A; }
.wfs-del:disabled { cursor: not-allowed; }
.wfs-archive {
  position: absolute; right: 42px; bottom: 6px; opacity: 0;
  padding: 1px 7px; font-size: 11px; cursor: pointer;
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-surface); color: var(--wf-faint);
}
.wfs-item:hover .wfs-archive { opacity: 1; }
.wfs-archive:hover:not(:disabled) { color: #E1756B; border-color: #B06A6A; }
.wfs-archive:disabled { cursor: not-allowed; }
.wfs-err { margin: 0 10px 8px; font-size: var(--wf-f-sm); color: #E1756B; }
.wfs-loading { margin: 10px; font-size: var(--wf-f-sm); color: var(--wf-faint); }

/* ── 快捷键 ── */
.wfs-keys { position: fixed; right: 14px; bottom: 14px; z-index: 40; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.wfs-keys-btn {
  width: 28px; height: 28px; border-radius: 50%; cursor: pointer;
  border: 1px solid var(--wf-line); background: var(--wf-raised); color: var(--wf-faint);
  font-size: 14px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
}
.wfs-keys-btn:hover { color: var(--wf-text); border-color: var(--wf-line-strong); }
/* 版本历史入口比快捷键常驻 —— 它不是"帮助", 是撤销改坏内容的唯一出口, 给更强的存在感 */
.wfs-vh-btn { border-color: var(--wf-line-strong); color: var(--wf-text-2); }
.wfs-help-mask { position: fixed; inset: 0; z-index: 96; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; }
.wfs-help { width: 360px; max-width: 92vw; padding: 18px 22px; background: var(--wf-surface); border: 1px solid var(--wf-line); border-radius: var(--wf-r); }
.wfs-help h3 { margin: 0 0 12px; font-size: var(--wf-f-lg); color: var(--wf-text); }
.wfs-help table { width: 100%; border-collapse: collapse; font-size: var(--wf-f-sm); color: var(--wf-text-2); }
.wfs-help td { padding: 5px 0; }
.wfs-help td:first-child { width: 132px; }
.wfs-help kbd {
  display: inline-block; padding: 1px 6px; border: 1px solid var(--wf-line-strong);
  border-radius: 4px; background: var(--wf-raised); font-family: ui-monospace, monospace; font-size: 11px;
}
.wfs-help-note { margin: 12px 0 0; font-size: var(--wf-f-sm); color: var(--wf-faint); }

/* 窄屏: 项目栏换成覆盖层, 不再挤主区(写作舱主区在 1024 已经很挤) */
@media (max-width: 1100px) {
  .wfs-rail { position: absolute; left: 0; top: 0; bottom: 0; z-index: 50; box-shadow: 12px 0 40px rgba(0, 0, 0, .35); }
  .wfs-rail.is-collapsed { box-shadow: none; }
  .wfs-root { position: relative; }
}
</style>
