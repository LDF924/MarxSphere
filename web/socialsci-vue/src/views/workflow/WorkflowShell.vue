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
import { listProjects, archiveProject, type SocProject } from "@/shared/tasks";
import { toast, confirmDialog } from "@/shared/ui";
import EmptyState from "./EmptyState.vue";

const store = useWorkflowStore();
const router = useRouter();

// ── 左侧项目栏 ──
const railOpen = ref(localStorage.getItem("skf_proj_rail") !== "0");
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

const STATUS_LABEL: Record<string, string> = { active: "进行中", "in-progress": "进行中", archived: "已归档", done: "已完成" };
const PHASE_LABEL = ["", "信息录入", "科研架构", "素材准备", "文本创作", "合稿定稿"];

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
 * 阶段跳转的两条规则(与进度条节点上的可点性同源):
 *   · **往回看是自由的** —— 已完成的阶段随时可以回去核对, 快捷键不该比点击更严;
 *   · **往前只能一格** —— 不允许从信息录入直接蹦到合稿定稿, 那会绕过"章节未全部完成
 *     不能进入合稿"这类既有校验(那些校验长在页面按钮上, 快捷键绕过去就等于没有)。
 * `ph` 用的是 1..5 的阶段号, 与 `store.phase` 同一套取值。
 */
const STEPS = [
  { key: "1", ph: 1, route: "/workflow/input", title: "信息录入" },
  { key: "2", ph: 2, route: "/workflow/sections", title: "科研架构" },
  { key: "3", ph: 3, route: "/workflow/materials", title: "素材准备" },
  { key: "4", ph: 4, route: "/workflow/workspace", title: "文本创作" },
  { key: "5", ph: 5, route: "/workflow/finalize", title: "合稿定稿" },
];

const helpOpen = ref(false);

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
  // Alt+1..5 切阶段
  if (e.altKey) {
    const i = STEPS.findIndex((s) => s.key === e.key);
    if (i >= 0) {
      e.preventDefault();
      const want = i + 1;
      /**
       * 与进度条同一套门禁: **只允许往回看, 或往前走一格** —— 不允许 Alt+5 从信息录入直接
       * 蹦到合稿定稿(那会绕过"章节未全部完成不能进入合稿"等既有校验)。
       * 这里不重写判定, 直接用 `store.phase` 比大小, 与 PhaseProgressBar 的节点状态同源。
       */
      /**
       * ⚠ 光改 `store.phase` **不会换页** —— 这一页是 vue-router 的独立路由。
       *   我第一版只调了 store.goto(), 结果按快捷键什么都没发生(hash 一动不动),
       *   而探针那条"越级被拦"因为"hash 没变"还**假通过**了一次:
       *   拦截与没生效，从 hash 上看是一样的。两件事都要做: 推路由 + 记阶段。
       */
      if (want <= store.phase + 1) {
        store.goto(want);
        void router.push(STEPS[i].route);
      } else {
        toast(`请先完成前面的阶段，再进入「${STEPS[i].title}」`, "warning");
      }
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
              <span>{{ PHASE_LABEL[p.phase] || "未开始" }}</span>
              <span class="wfs-dot">·</span>
              <span>{{ fmtDay(p.updatedAt) }}</span>
            </div>
            <button
              class="wfs-archive" :disabled="!!switching"
              :data-control="`workflow:proj-archive-${p.id}`"
              title="归档(数据保留，可在外壳历史记录里找回)"
              @click.stop="doArchive(p)"
            >归档</button>
          </div>

          <EmptyState
            v-if="projLoaded && !visible.length"
            size="sm"
            icon="⬚"
            :title="query ? '没有匹配的项目' : '还没有其它项目'"
            :hint="query ? '换个关键词试试。' : '在下方进度条点「＋ 新项目」开始一个。'"
          />
          <p v-if="!projLoaded" class="wfs-loading">加载中…</p>
        </div>
      </template>
    </aside>

    <!-- 中: 主区。结构与内边距层级原样保留 —— 见文件头"刻意不动"那段 -->
    <slot />

    <!-- 右: 快捷键浮标 -->
    <div class="wfs-keys">
      <button class="wfs-keys-btn" data-control="workflow:keys-help" title="快捷键(?)" @click="helpOpen = !helpOpen">?</button>
    </div>

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
.wfs-archive {
  position: absolute; right: 6px; bottom: 6px; opacity: 0;
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
.wfs-keys { position: fixed; right: 14px; bottom: 14px; z-index: 40; }
.wfs-keys-btn {
  width: 28px; height: 28px; border-radius: 50%; cursor: pointer;
  border: 1px solid var(--wf-line); background: var(--wf-raised); color: var(--wf-faint);
  font-size: 14px; line-height: 1;
}
.wfs-keys-btn:hover { color: var(--wf-text); border-color: var(--wf-line-strong); }
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
