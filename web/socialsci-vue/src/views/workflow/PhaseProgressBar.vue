<script setup lang="ts">
/**
 * PhaseProgressBar(阶段进度条) — 还原自闭源 phase-progress(6 节点 ppb-* 语义, DeepDive-DOM-DECODED §阶段进度条)
 * 节点: 研究主题 → 1信息录入 → 2科研架构 → 3素材准备 → 4文本创作 → 5合稿定稿
 * 形态: ppb-topic 研究主题卡(已完成绿点) + ppb-node(done ✓/active 序号+metric/pending 灰)+ ppb-line 连接线
 * 点击导航: 已完成/当前阶段可达; 向后阶段需按顺序推进(门禁提示在本组件 goNode 内)
 */
import { useRouter } from "vue-router";
import { useWorkflowStore } from "./stores/workflow";
import { computed, ref, watch } from "vue";
import { toast, confirmDialog } from "@/shared/ui";
import { createTask } from "@/shared/tasks";

const router = useRouter();
const store = useWorkflowStore();

/** 横向滚动容器 —— 用于把当前阶段滚到中央(闭源 p() 的语义) */
const wrapperRef = ref<HTMLElement | null>(null);

const NODES = [
  { ph: 1, key: "input", title: "信息录入", path: "/workflow/input" },
  { ph: 2, key: "sections", title: "科研架构", path: "/workflow/sections" },
  { ph: 3, key: "materials", title: "素材准备", path: "/workflow/materials" },
  { ph: 4, key: "workspace", title: "文本创作", path: "/workflow/workspace" },
  { ph: 5, key: "finalize", title: "合稿定稿", path: "/workflow/finalize" }
];
/** 研究主题步(未完成过信息录入 → 主题未成; 视为 done 态当 phase>0 或有标题) */
const topicDone = computed(() => store.phase >= 1 || !!store.input.title.trim() || !!store.taskId);

/**
 * 当前**正在查看**的阶段(闭源 `viewing` 第四态)。
 *
 * 闭源的状态机是三档 + 一档(逐字对照 index-xpWAkSSw.js):
 *   y(O) = O.phase <  store.phase                        → done
 *   g(O) = O.phase === store.phase                       → active
 *   E(O) = O.phase === viewing.value && O.phase !== store.phase → **viewing**
 *   L(O) = y ? "done" : g ? "active" : E ? "viewing" : "pending"
 *
 * 语义: 用户点了某个阶段去看, 但那一阶段**不是当前阶段** —— 圆变蓝 + 另一圈样式,
 * 与"走到了这一步(active)"区分开。
 * 2026-09-16 补: 我方此前只有三态, 而渲染条件里还写着 `(done||active||viewing)` ——
 * 注释提了第四态、代码从没实现, viewing 分支永远不成立。
 */
const viewing = ref(0);
/** 路由一落地就同步 viewing: 用户直接开某页 URL 时, 该页对应的节点也该是 viewing */
const routePh = computed(() => {
  const p = String(router.currentRoute.value?.path ?? "");
  const hit = NODES.find((n) => p.startsWith(n.path));
  return hit?.ph ?? 0;
});
watch(routePh, (v) => { if (v) viewing.value = v; }, { immediate: true });

function nodeState(n: { ph: number }) {
  // store.phase 编号: 1=信息录入 2=科研架构 3=素材准备 4=文本创作 5=合稿定稿
  const cur = Math.max(1, Math.min(5, store.phase || 1));
  if (n.ph < cur) return "done";
  if (n.ph === cur) return "active";
  if (n.ph === viewing.value) return "viewing";
  return "pending";
}
/** 节点点击: 已完成/当前可达, 未完成阶段门禁提示(由后续视图按钮承担推进) */
function goNode(n: { ph: number; path: string }) {
  const cur = Math.max(1, Math.min(5, store.phase || 1));
  if (n.ph <= cur) {
    viewing.value = n.ph;
    void router.push(n.path);
    return;
  }
  const labels: Record<number, string> = { 1: "信息录入", 2: "科研架构", 3: "素材准备", 4: "文本创作" };
  const tip: Record<number, string> = {
    2: "请先完成信息录入并提交研究主题",
    3: "请先在科研架构中生成章节与写作指导",
    4: "请先在素材准备中整理素材并发布",
    5: "请先在文本创作中完成全部章节生成"
  };
  const t = tip[n.ph] ?? "";
  toast(t || "请按流程逐步完成前置阶段", "warning");
  void labels;
}

/**
 * 把当前阶段节点滚到视口中央(闭源 p(): offsetLeft - (容器宽 - 节点宽) / 2)。
 * 窄屏时进度条要横向滚动, 阶段一多当前节点可能就在屏外 —— 用户看不到自己走到哪了。
 */
function centerCurrentNode() {
  requestAnimationFrame(() => {
    const wrap = wrapperRef.value;
    if (!wrap) return;
    const cur = Math.max(1, Math.min(5, store.phase || 1));
    const node = wrap.querySelector<HTMLElement>(`.ppb-node[data-phase="${cur}"]`);
    if (!node) return;
    wrap.scrollTo({ left: Math.max(0, node.offsetLeft - (wrap.clientWidth - node.offsetWidth) / 2), behavior: "smooth" });
  });
}
watch(() => store.phase, centerCurrentNode, { immediate: true });
/**
 * 章节"已生成"的判据 —— **必须看正文, 不能只看 status 词汇**。
 *
 * 2026-09-16 实测: 后端 analyze 与 runChapterBatch 写的都是 `status:"done"`,
 * 而前端多处写的是 `"generated"` —— 同一套数据两套词汇, 谁也没统一。
 * 只认其中一个的结果是"已生成 N/M"恒算成 0(实测过了门槛的章节被漏数)。
 * 有正文(>50 字, 与 doMerge 的门禁同口径)就是已生成。
 */
function isSectionGenerated(s: { status?: string; content?: string }): boolean {
  if (s.status === "generated" || s.status === "done") return true;
  return String(s.content ?? "").length > 50;
}

/**
 * 节点 metric(逐字对照闭源 index-main.js 的 5 个节点定义):
 *   科研架构 `N 章节` / 素材准备 `N 条` / 文本创作 `已生成/总数` / 合稿定稿 `已定稿|待确认`
 * 2026-09-15 修: 原实现里素材写成「N 素材」、文本创作写成「N 章节」, 且合稿节点的 metric 完全没做。
 */
function nodeMetric(n: { key: string }): string {
  if (n.key === "sections") return store.level1Sections.length ? `${store.level1Sections.length} 章节` : "";
  if (n.key === "materials") return store.materials.length ? `${store.materials.length} 条` : "";
  if (n.key === "workspace") {
    const total = store.level1Sections.length || 1;
    const done = store.level1Sections.filter((s) => isSectionGenerated(s)).length;
    return done > 0 ? `${done}/${total}` : "";
  }
  if (n.key === "finalize") return store.isFinalized ? "已定稿" : store.mergeGenerated ? "待确认" : "";
  return "";
}

/**
 * 新项目(闭源 ppb-new-btn: 确认后 `createTaskWithTitle("未命名","workflow")` + 切到新任务)。
 * 2026-09-15 补: 原先只清本地指针(注释里我写"怕在库里堆空项目")—— 但那**不是**闭源语义,
 * 而且清指针会让用户误以为上一个项目没了。现在按闭源来: 真建一个空项目并切过去,
 * 旧项目留在历史里(用户随时能从「历史记录」回去)。
 */
async function newProject() {
  const ok = await confirmDialog({
    title: "开始新项目？",
    message: "开始新项目？系统会创建独立任务，当前项目将保留在历史记录中。",
    okText: "开始新项目",
    cancelText: "留在当前项目",
  });
  if (!ok) return;
  try {
    // 不传 projectId → createTask 自动建一个新的项目容器(闭源 createTaskWithTitle 语义)
    const t = await createTask({ title: "未命名", module: "workflow" });
    const newPid = t?.projectId ?? "";
    store.resetLocal();
    if (newPid) {
      store.taskId = newPid;
      store.setPhase(1);
      try { localStorage.setItem("lastTask_workflow", newPid); } catch { /* 隐私模式 */ }
    }
    void router.push("/workflow/input");
  } catch (e) {
    toast(`新建项目失败: ${String((e as Error).message ?? e)}`, "error");
  }
}
</script>

<template>
  <div ref="wrapperRef" class="phase-progress-wrapper">
    <div class="phase-progress-bar">
      <div class="ppb-inner">
        <!-- 研究主题卡 -->
        <div class="ppb-topic" title="研究主题" @click="router.push('/workflow/input')">
          <div class="ppb-topic-heading">
            <span class="ppb-topic-label">研究主题</span>
            <span class="ppb-topic-status" :class="{ 'is-success': topicDone }">
              <span class="ppb-topic-status-dot"></span>{{ topicDone ? "已完成" : "待填写" }}
            </span>
          </div>
          <strong class="ppb-topic-title">{{ store.title || "未命名项目" }}</strong>
        </div>
        <!-- 阶段节点 -->
        <template v-for="n in NODES" :key="n.key">
          <div class="ppb-line-wrap">
            <div class="ppb-line" :class="nodeState(n) === 'pending' ? 'pending' : (nodeState(n) === 'viewing' ? 'viewing' : 'done')"></div>
          </div>
          <div
            class="ppb-node"
            :class="nodeState(n)"
            :data-phase="n.ph"
            @click="goNode(n)"
          >
            <!-- 2026-09-15: pending 圆圈原先**没有序号**(空圈), 闭源实拍是 ppb-num 显示 4/5。
                 active 也用 ppb-num, 圈本身另挂状态类(闭源 .ppb-circle.done/.active/.pending)。 -->
            <div class="ppb-circle" :class="nodeState(n)">
              <svg v-if="nodeState(n) === 'done'" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="3">
                <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span v-else class="ppb-num">{{ n.ph }}</span>
            </div>
            <!-- 闭源 ppb-label 是**独立块**(圆在上、标签在下), 不是圆的同行兄弟 -->
            <div class="ppb-label" :class="nodeState(n)">
              <span class="ppb-label-text">{{ n.title }}</span>
              <!-- 闭源条件: (done||active||viewing) && metrics —— 三种状态都渲染该节点的产物计数。
                   2026-09-15 修: 原先写死只在 done 渲染, 方向反了。
                   2026-09-16 再修: 补上 viewing —— 否则"正在查看的那个非当前阶段"的计数不显示。 -->
              <span v-if="nodeMetric(n)" class="ppb-metric">{{ nodeMetric(n) }}</span>
            </div>
          </div>
        </template>
        <!-- 新项目 -->
        <button class="ppb-new-btn" data-control="workflow:new-project" @click="newProject">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4">
            <path d="M12 5v14M5 12h14" stroke-linecap="round" />
          </svg>
          <span>新项目</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 闭源 .phase-progress-wrapper{height:90px;...;display:flex;align-items:center} —— 我方实测 78px */
.phase-progress-wrapper {
  background: #11192C; border-bottom: 1px solid #222F44;
  position: sticky; top: 0; z-index: 30;
  height: 90px; display: flex; align-items: center;
  max-width: 100%; overflow-x: auto;
}
/* 只有 wrapper 一层横向滚动(闭源: ppb-inner 无 min-width, 窄容器由外层滚) ——
   原先内层也套了 overflow-x 并钉死 min-width:860px, 窄屏会出现双滚动条且内条不动。 */
/* 闭源 .phase-progress-bar{position:relative;width:100%;height:100%} —— 限宽交给 .ppb-inner(1200px) */
.phase-progress-bar { position: relative; width: 100%; height: 100%; }
/* 闭源 .ppb-inner{justify-content:center;padding:0 20px;max-width:1200px;margin:0 auto;height:100%} */
.ppb-inner { display: flex; align-items: center; justify-content: center; gap: 0; padding: 0 20px; max-width: 1200px; margin: 0 auto; height: 100%; }
.ppb-topic {
  /* 闭源: width:280px;margin:0 24px 0 0;padding:8px 12px;border-radius:7px */
  width: 280px; flex-shrink: 0; margin: 0 24px 0 0; min-width: 0;
  padding: 8px 12px; box-sizing: border-box;
  border: 1px solid #222F44; border-radius: 7px; background: #1A2333;
  cursor: pointer;
}
.ppb-topic:hover { border-color: #B06A6A; }
.ppb-topic-heading { display: flex; align-items: center; gap: 7px; }
.ppb-topic-label { font-size: 11px; color: #8B9BB1; font-weight: 600; }
.ppb-topic-status { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: #7A8AA0; }
.ppb-topic-status.is-success { color: #5FD0B4; }
.ppb-topic-status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; }
.ppb-topic-title {
  display: block; font-size: 12px; font-weight: 600; color: #E8EEF7; margin-top: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 闭源 .ppb-line-wrap{width:40px} —— 我方原 26px, 连接线过短 */
.ppb-line-wrap { width: 40px; flex-shrink: 0; display: flex; align-items: center; }
/* 闭源 .ppb-line{width:100%;height:2.5px;border-radius:2px} */
.ppb-line { width: 100%; height: 2.5px; background: #222F44; border-radius: 2px; transition: background .35s ease; }
.ppb-line.done { background: #5FD0B4; }
.ppb-line.viewing { background: #4D84CB; }
/*
 * 闭源 .ppb-node{display:flex;flex-direction:column;align-items:center;gap:6px;
 *   padding:4px 8px;border-radius:12px;min-width:72px}
 * 2026-09-16 修: 我方原先是 `flex-direction:row` 的**横向 pill** —— 方向反了,
 *   闭源是"圆在上、标签在下"的纵向块。整条进度条的视觉节奏因此完全不同。
 */
.ppb-node {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  cursor: pointer; padding: 4px 8px; border-radius: 12px;
  min-width: 72px; position: relative; flex-shrink: 0;
  transition: all .25s ease;
}
.ppb-node:hover { background: #1A2333; }
/* 闭源 .ppb-circle{width:32px;height:32px;font-size:12px} —— 我方原 24px */
.ppb-circle {
  width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; flex-shrink: 0; position: relative;
  transition: all .35s ease;
  background: #222F44; color: #7A8AA0; border: 2px solid #2A3A55;
}
.ppb-circle.done { background: #16a34a; color: #F1F5F9; border: none; box-shadow: 0 2px 8px #16a34a40; }
.ppb-circle.active { background: #4D84CB; color: #F1F5F9; border: none; box-shadow: 0 0 0 4px #1E2A48, 0 2px 8px #00000014; }
/* 第四态: 用户在看的阶段(不是当前阶段) —— 闭源 .ppb-circle.viewing{background:#3b82f6;border:2px solid #93bbfd} */
.ppb-circle.viewing { background: #3B82F6; color: #F1F5F9; border: 2px solid #93BBFD; box-shadow: 0 2px 8px #3b82f64d; }
.ppb-num { font-size: 13px; font-weight: 700; line-height: 1; }
/* 闭源 .ppb-label{font-size:11px;font-weight:600;text-align:center;white-space:nowrap} —— 我方原 13px */
.ppb-label { display: flex; align-items: center; gap: 5px; white-space: nowrap; text-align: center; }
.ppb-label-text { font-size: 11px; font-weight: 600; color: #7A8AA0; letter-spacing: .02em; }
.ppb-label.active .ppb-label-text { color: #759FD7; }
.ppb-label.done .ppb-label-text { color: #5FD0B4; }
.ppb-label.viewing .ppb-label-text { color: #6FA8F5; }
.ppb-label.pending .ppb-label-text { color: #7A8AA0; }
/* 闭源 .ppb-metric{font-size:9.5px;display:block;margin-top:1px;opacity:.85} —— 我方原是带底色的胶囊 */
.ppb-metric {
  font-size: 9.5px; font-weight: 500; display: block; margin-top: 1px; opacity: .85;
  color: #8B9BB1; background: none; padding: 0;
}
.ppb-label.active .ppb-metric, .ppb-label.viewing .ppb-metric { color: #6FA8F5; }
.ppb-new-btn:hover { border-color: #B06A6A; color: #E8EEF7; }

/*
 * 窄屏紧凑化 —— 逐条对照闭源 @media(max-width:600px):
 *   .ppb-topic{width:170px;margin-left:0;padding:6px 8px}
 *   .ppb-inner{gap:0;padding:12px 8px;overflow-x:auto;justify-content:flex-start;scroll-behavior:smooth}
 *   .ppb-line-wrap{width:28px} / .ppb-circle{28px} / .ppb-label{font-size:10px} / .ppb-node{min-width:56px;padding:2px 4px}
 * 2026-09-16 补: 我方此前全工作流**零响应式**(只有素材页一处 768px 断点),
 *   1100px 视口下节点就溢出到 1207px、只能靠外层 overflow-x 兜住。
 */
@media (max-width: 600px) {
  .ppb-topic { width: 170px; margin-left: 0; padding: 6px 8px; margin-right: 12px; }
  .ppb-inner { gap: 0; padding: 12px 8px; overflow-x: auto; justify-content: flex-start; scroll-behavior: smooth; }
  .ppb-line-wrap { width: 28px; }
  .ppb-circle { width: 28px; height: 28px; }
  .ppb-label-text { font-size: 10px; }
  .ppb-node { min-width: 56px; padding: 2px 4px; }
}
</style>
