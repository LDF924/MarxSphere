<script setup lang="ts">
/**
 * PhaseProgressBar(阶段进度条) — 还原自闭源 phase-progress(6 节点 ppb-* 语义, DeepDive-DOM-DECODED §阶段进度条)
 * 节点: 研究主题 → 1信息录入 → 2科研架构 → 3素材准备 → 4文本创作 → 5合稿定稿
 * 形态: ppb-topic 研究主题卡(已完成绿点) + ppb-node(done ✓/active 序号+metric/pending 灰)+ ppb-line 连接线
 * 点击导航: 已完成/当前阶段可达; 向后阶段需按顺序推进(门禁提示在本组件 goNode 内)
 */
import { useRouter } from "vue-router";
import { useWorkflowStore } from "./stores/workflow";
import { computed } from "vue";

const router = useRouter();
const store = useWorkflowStore();

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
  void import("@/shared/ui").then(({ toast }) => toast(t || "请按流程逐步完成前置阶段", "warning"));
  void labels;
}
/** active 节点 metric(闭源: 科研架构节点显示 "N 章节") */
function nodeMetric(n: { key: string }): string {
  if (n.key === "sections") return store.level1Sections.length ? `${store.level1Sections.length} 章节` : "";
  if (n.key === "materials") return store.materials.length ? `${store.materials.length} 素材` : "";
  if (n.key === "workspace") {
    const done = store.level1Sections.filter((s) => s.content && s.content.length > 50).length;
    return done ? `${done} 章节` : "";
  }
  return "";
}
</script>

<template>
  <div class="phase-progress-wrapper">
    <div class="phase-progress-bar">
      <div class="ppb-inner">
        <!-- 研究主题卡 -->
        <div class="ppb-topic" title="研究主题" @click="router.push('/workflow/input')">
          <div class="ppb-topic-head">
            <span class="ppb-topic-label">研究主题</span>
            <span class="ppb-topic-status" :class="{ 'is-success': topicDone }"><i class="ppb-dot"></i>{{ topicDone ? "已完成" : "待填写" }}</span>
          </div>
          <div class="ppb-topic-title">{{ store.title || "未命名项目" }}</div>
        </div>
        <!-- 阶段节点 -->
        <template v-for="(n, i) in NODES" :key="n.key">
          <div class="ppb-line-wrap">
            <div class="ppb-line" :class="{ done: nodeState(n) === 'done' || nodeState(n) === 'active' }"></div>
          </div>
          <div
            class="ppb-node"
            :class="nodeState(n)"
            :data-phase="n.ph"
            @click="goNode(n)"
          >
            <div class="ppb-circle">
              <template v-if="nodeState(n) === 'done'">✓</template>
              <template v-else-if="nodeState(n) === 'active'">{{ n.ph }}</template>
            </div>
            <div class="ppb-label">
              <span class="ppb-label-num">{{ n.ph }}</span>
              <span class="ppb-label-text">{{ n.title }}</span>
              <span v-if="nodeState(n) === 'active' && nodeMetric(n)" class="ppb-metric">{{ nodeMetric(n) }}</span>
            </div>
          </div>
        </template>
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
.phase-progress-bar { max-width: 1120px; margin: 0 auto; padding: 12px 20px 10px; overflow-x: auto; }
.ppb-inner { display: flex; align-items: center; gap: 6px; min-width: 860px; }
.ppb-scroll { overflow-x: auto; }
.ppb-topic {
  width: 200px; flex-shrink: 0; border: 1px solid #222F44; border-radius: 10px;
  padding: 8px 12px; cursor: pointer; background: #1A2333;
}
.ppb-topic:hover { border-color: #B06A6A; }
.ppb-topic-head { display: flex; align-items: center; gap: 7px; }
.ppb-topic-label { font-size: 11px; color: #8B9BB1; font-weight: 600; }
.ppb-topic-status { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: #7A8AA0; }
.ppb-topic-status.is-success { color: #5FD0B4; }
.ppb-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; }
.ppb-topic-title {
  font-size: 12px; font-weight: 600; color: #E8EEF7; margin-top: 3px;
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
.ppb-label { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.ppb-label-num { display: none; }
.ppb-label-text { font-size: 13px; color: #8B9BB1; font-weight: 500; }
.ppb-node.active .ppb-label-text { color: #759FD7; font-weight: 700; }
.ppb-node.done .ppb-label-text { color: #E8EEF7; }
.ppb-node.pending .ppb-label-text { color: #7A8AA0; }
.ppb-metric {
  font-size: 10px; background: #1E2A48; color: #759FD7;
  padding: 1.5px 7px; border-radius: 8px;
}
</style>
