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

function nodeState(n: { ph: number }) {
  // store.phase 编号: 1=信息录入 2=科研架构 3=素材准备 4=文本创作 5=合稿定稿
  const cur = Math.max(1, Math.min(5, store.phase || 1));
  if (n.ph < cur) return "done";
  if (n.ph === cur) return "active";
  return "pending";
}
/** 节点点击: 已完成/当前可达, 未完成阶段门禁提示(由后续视图按钮承担推进) */
function goNode(n: { ph: number; path: string }) {
  const cur = Math.max(1, Math.min(5, store.phase || 1));
  if (n.ph <= cur) {
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
            <div class="ppb-line" :class="nodeState(n) === 'pending' ? 'pending' : 'done'"></div>
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
              <svg v-if="nodeState(n) === 'done'" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3">
                <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span v-else class="ppb-num">{{ n.ph }}</span>
            </div>
            <div class="ppb-label" :class="nodeState(n)">
              <span class="ppb-label-text">{{ n.title }}</span>
              <!-- 闭源条件: (done||active||viewing) && metrics —— **三种状态都渲染**该节点的产物计数。
                   2026-09-15 修: 原先写死只在 done 渲染, 方向反了 —— active 的节点明明有数据却不显示。 -->
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
.phase-progress-wrapper {
  background: #11192C; border-bottom: 1px solid #222F44;
  position: sticky; top: 0; z-index: 30;
  max-width: 100%; overflow-x: auto;
}
/* 只有 wrapper 一层横向滚动(闭源: ppb-inner 无 min-width, 窄容器由外层滚) ——
   原先内层也套了 overflow-x 并钉死 min-width:860px, 窄屏会出现双滚动条且内条不动。 */
.phase-progress-bar { max-width: 1120px; margin: 0 auto; padding: 12px 20px 10px; }
.ppb-inner { display: flex; align-items: center; gap: 6px; }
.ppb-topic {
  width: 280px; flex-shrink: 0; border: 1px solid #222F44; border-radius: 10px;
  padding: 8px 12px; cursor: pointer; background: #1A2333;
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
.ppb-line-wrap { flex: 0 0 26px; display: flex; align-items: center; }
.ppb-line { height: 2px; flex: 1; background: #222F44; border-radius: 1px; }
.ppb-line.done { background: #5FD0B4; }
.ppb-node { display: flex; align-items: center; gap: 7px; cursor: pointer; padding: 5px 9px; border-radius: 9px; flex-shrink: 0; }
.ppb-node:hover { background: #1A2333; }
.ppb-circle {
  width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
  font-size: 12px; font-weight: 700; color: #F1F5F9; background: #46587A; flex-shrink: 0;
}
.ppb-node.done .ppb-circle { background: #16a34a; }
.ppb-node.active .ppb-circle { background: #4D84CB; box-shadow: 0 0 0 4px #1E2A48; }
.ppb-node.pending .ppb-circle { background: #222F44; color: #7A8AA0; }
.ppb-num { font-size: 12px; font-weight: 700; line-height: 1; }
.ppb-label { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.ppb-label-text { font-size: 13px; color: #8B9BB1; font-weight: 500; }
.ppb-node.active .ppb-label-text { color: #759FD7; font-weight: 700; }
.ppb-node.done .ppb-label-text { color: #E8EEF7; }
.ppb-node.pending .ppb-label-text { color: #7A8AA0; }
.ppb-metric {
  font-size: 10px; background: #1E2A48; color: #759FD7;
  padding: 1.5px 7px; border-radius: 8px;
}
.ppb-new-btn {
  display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
  margin-left: 6px; padding: 6px 12px; border-radius: 8px;
  background: transparent; border: 1px solid #222F44; color: #8B9BB1;
  font-size: 12.5px; cursor: pointer; white-space: nowrap;
}
.ppb-new-btn:hover { border-color: #B06A6A; color: #E8EEF7; }
</style>
