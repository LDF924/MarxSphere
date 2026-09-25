<script setup lang="ts">
/**
 * PhaseProgressBar(阶段进度条) — 还原自参考产品 phase-progress(6 节点 ppb-* 语义, DeepDive-DOM-DECODED §阶段进度条)
 * 节点: 研究主题 → 1选题界定 → 2框架设计 → 3文献与资料 → 4章节写作 → 5统稿定稿
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

/** 横向滚动容器 —— 用于把当前阶段滚到中央(参考产品同名函数 的语义) */
const wrapperRef = ref<HTMLElement | null>(null);

const NODES = [
  { ph: 1, key: "input", title: "选题界定", path: "/workflow/input" },
  { ph: 2, key: "sections", title: "框架设计", path: "/workflow/sections" },
  { ph: 3, key: "materials", title: "文献与资料", path: "/workflow/materials" },
  { ph: 4, key: "workspace", title: "章节写作", path: "/workflow/workspace" },
  { ph: 5, key: "finalize", title: "统稿定稿", path: "/workflow/finalize" }
];
/** 研究主题步(未完成过选题界定 → 主题未成; 视为 done 态当 phase>0 或有标题) */
const topicDone = computed(() => store.phase >= 1 || !!store.input.title.trim() || !!store.taskId);

/**
 * 当前**正在查看**的阶段(参考产品 `viewing` 第四态)。
 *
 * 参考产品的状态机是三档 + 一档(逐字对照 index):
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
  // store.phase 编号: 1=选题界定 2=框架设计 3=文献与资料 4=章节写作 5=统稿定稿
  const cur = Math.max(1, Math.min(5, store.phase || 1));
  if (n.ph < cur) return "done";
  if (n.ph === cur) return "active";
  if (n.ph === viewing.value) return "viewing";
  return "pending";
}
/** 节点点击: 已完成/当前可达, 未完成阶段门禁提示(由后续视图按钮承担推进) */
/**
 * 点阶段节点 —— **一律可进**, 不再拦。
 *
 * ⚠ V425 改。原先这里写着 `if (n.ph <= cur) 进 else toast("请先完成XX")`, 也就是
 * "没走过就不能看"。查下来那个门禁**站不住**:
 *
 *  · **不是技术限制**: 拿一个全新空项目直接用 URL 访问这四页, 全部正常渲染,
 *    四页各自都有空态与引导按钮("开始框架设计分析" / "去填研究框架" / "智能生成素材"…),
 *    没有路由守卫、没有报错。拦住用户的只是这个判断;
 *  · **判据是错的对象**: `store.phase` 是个标量, 只在四个「确认」按钮里 +1 ——
 *    它记的是"你点到哪儿了", 不是"你做完了什么"。于是"阶段 3 不可达"的真实含义
 *    只是"你还没按过阶段 2 底部那个确认按钮", 哪怕你已经在素材页填了半天;
 *  · **真正的依赖检查在各页的按钮上, 而且本来就是准的**:
 *    创作台「进入合稿」查 `pendingCount > 0`, 输入页「开始思考」查标题与大纲。
 *    进度条这道门是同一结论的**粗糙近似** —— 它不看内容, 只看你按没按过按钮。
 *  · **参考产品也没有这道门**: 实拍它的进度条 DOM, 节点只有 done / active / pending 三态
 *    (已走过 / 正在看 / 还没到), 没有 disabled 的视觉表达。这道门是我方自己加严的。
 *
 * 新规则: **"看"不是破坏性操作** —— 可以自由进入任何阶段查看, 页面已有空态接住;
 * 真正会消费上一步产物的动作由各页已有的校验拦。这样新用户能先看看后面长什么样,
 * 而不是被一个 3 秒就消失的 toast 挡在门外。
 */
function goNode(n: { ph: number; path: string }) {
  viewing.value = n.ph;
  void router.push(n.path);
}

/**
 * 把当前阶段节点滚到视口中央(参考产品同名函数: offsetLeft - (容器宽 - 节点宽) / 2)。
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
 * 节点 metric(逐字对照参考产品 index-main.js 的 5 个节点定义):
 *   框架设计 `N 章节` / 文献与资料 `N 条` / 章节写作 `已生成/总数` / 统稿定稿 `已定稿|待确认`
 * 2026-09-15 修: 原实现里素材写成「N 素材」、章节写作写成「N 章节」, 且合稿节点的 metric 完全没做。
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
 * 新项目(参考产品 ppb-new-btn: 确认后 `createTaskWithTitle("未命名","workflow")` + 切到新任务)。
 * 2026-09-15 补: 原先只清本地指针(注释里我写"怕在库里堆空项目")—— 但那**不是**参考产品语义,
 * 而且清指针会让用户误以为上一个项目没了。现在按参考产品来: 真建一个空项目并切过去,
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
    // 不传 projectId → createTask 自动建一个新的项目容器(参考产品 createTaskWithTitle 语义)
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
            <!-- 2026-09-15: pending 圆圈原先**没有序号**(空圈), 参考产品实拍是 ppb-num 显示 4/5。
                 active 也用 ppb-num, 圈本身另挂状态类(参考产品 .ppb-circle.done/.active/.pending)。 -->
            <div class="ppb-circle" :class="nodeState(n)">
              <svg v-if="nodeState(n) === 'done'" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="3">
                <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span v-else class="ppb-num">{{ n.ph }}</span>
            </div>
            <!-- 参考产品 ppb-label 是**独立块**(圆在上、标签在下), 不是圆的同行兄弟 -->
            <div class="ppb-label" :class="nodeState(n)">
              <span class="ppb-label-text">{{ n.title }}</span>
              <!-- 参考产品条件: (done||active||viewing) && metrics —— 三种状态都渲染该节点的产物计数。
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
/* 参考产品 .phase-progress-wrapper{height:90px;...;display:flex;align-items:center} —— 我方实测 78px */
.phase-progress-wrapper {
  background: var(--wf-surface); border-bottom: 1px solid var(--wf-line);
  position: sticky; top: 0; z-index: 30;
  height: 90px; display: flex; align-items: center;
  max-width: 100%; overflow-x: auto;
}
/* 只有 wrapper 一层横向滚动(参考产品: ppb-inner 无 min-width, 窄容器由外层滚) ——
   原先内层也套了 overflow-x 并钉死 min-width:860px, 窄屏会出现双滚动条且内条不动。 */
/* 参考产品 .phase-progress-bar{position:relative;width:100%;height:100%} —— 限宽交给 .ppb-inner(1200px) */
.phase-progress-bar { position: relative; width: 100%; height: 100%; }
/* V420: 去掉 `max-width:1200px`。参考产品那个限宽是为了让进度条在它的文档页里居中;
   我方页面已改全宽, 留着就是**在 1440 视口上左右各空 120px**, 进度条看着像被框住。
   改成吃满可用宽度。
   ⚠ 2026-09-24 再改: 原先 `justify-content:center` —— 在 1536 视口下实测**左空 181px、右空 196px**,
   而中间的主题卡与节点已经排到 1325px(条宽 1289), 加上"新项目"按钮又把内容挤得更紧。
   改成**左对齐**: 主题卡贴左边, "新项目"用 `margin-left:auto` 推到最右 —— 这样两头都用上了,
   中间的空白变成"节点与按钮之间的弹性间距", 而不是两边各空一块。
   (参考产品无此问题: 它的进度条挂在 max-w-5xl 的文档页里, 本来就不会这么宽。) */
.ppb-inner { display: flex; align-items: center; justify-content: flex-start; gap: 0; padding: 0 20px; margin: 0 auto; height: 100%; width: 100%; }
.ppb-new-btn { margin-left: auto; }
.ppb-topic {
  /* 参考产品: width:280px;margin:0 24px 0 0;padding:8px 12px;border-radius:7px */
  width: 280px; flex-shrink: 0; margin: 0 24px 0 0; min-width: 0;
  padding: 8px 12px; box-sizing: border-box;
  border: 1px solid var(--wf-line); border-radius: 7px; background: var(--wf-raised);
  cursor: pointer;
}
.ppb-topic:hover { border-color: #B06A6A; }
.ppb-topic-heading { display: flex; align-items: center; gap: 7px; }
.ppb-topic-label { font-size: 11px; color: var(--wf-muted); font-weight: 600; }
.ppb-topic-status { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--wf-faint); }
.ppb-topic-status.is-success { color: #5FD0B4; }
.ppb-topic-status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; }
.ppb-topic-title {
  display: block; font-size: 12px; font-weight: 600; color: var(--wf-text); margin-top: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 参考产品 .ppb-line-wrap{width:40px} —— 我方原 26px, 连接线过短 */
.ppb-line-wrap { width: 40px; flex-shrink: 0; display: flex; align-items: center; }
/* 参考产品 .ppb-line{width:100%;height:2.5px;border-radius:2px} */
.ppb-line { width: 100%; height: 2.5px; background: var(--wf-line); border-radius: 2px; transition: background .35s ease; }
.ppb-line.done { background: #5FD0B4; }
.ppb-line.viewing { background: #4D84CB; }
/*
 * 参考产品 .ppb-node{display:flex;flex-direction:column;align-items:center;gap:6px;
 *   padding:4px 8px;border-radius:12px;min-width:72px}
 * 2026-09-16 修: 我方原先是 `flex-direction:row` 的**横向 pill** —— 方向反了,
 *   参考产品是"圆在上、标签在下"的纵向块。整条进度条的视觉节奏因此完全不同。
 */
.ppb-node {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  cursor: pointer; padding: 4px 8px; border-radius: 12px;
  min-width: 72px; position: relative; flex-shrink: 0;
  transition: all .25s ease;
}
.ppb-node:hover { background: var(--wf-raised); }
/**
 * ⚠ V425: 节点**仍然标注 pending, 但已经可以点进去**。
 *
 * 参考产品只有 done / active / pending 三态, 没有 disabled 的视觉表达; 我方此前把 pending
 * 做成了"拦住的"——点它弹一个 3 秒就消失的 toast。现在改成: 三态只表达**进度**
 * (已走过 / 正在看 / 还没到), 不再暗示"不可点"。
 *
 * 于是 pending 态必须与可点状态**一致**: 去掉 `cursor:not-allowed` 与降透明度的写法,
 * 保留 hover 反馈 —— 否则用户看到的就是"看着能点、点了没反应"。
 * 悬停时给一个轻提示, 说明"这一步还没走, 但可以先看看"。
 */
.ppb-node.pending { cursor: pointer; }
.ppb-node.pending:hover { background: var(--wf-raised); }
/* 悬停提示: 让"我还没走到这里"在**按之前**就看得出来, 而不是按了才知道 */
.ppb-node.pending::after {
  content: "尚未进行到这一步, 可先查看";
  position: absolute; top: calc(100% + 2px); left: 50%; transform: translateX(-50%);
  white-space: nowrap; font-size: 10px; color: var(--wf-faint);
  background: var(--wf-raised); border: 1px solid var(--wf-line);
  border-radius: var(--wf-r-sm); padding: 2px 7px;
  opacity: 0; pointer-events: none; transition: opacity .15s ease;
  z-index: 5;
}
.ppb-node.pending:hover::after { opacity: 1; }
/* 参考产品 .ppb-circle{width:32px;height:32px;font-size:12px} —— 我方原 24px */
.ppb-circle {
  width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; flex-shrink: 0; position: relative;
  transition: all .35s ease;
  background: var(--wf-line); color: var(--wf-faint); border: 2px solid var(--wf-line-strong);
}
.ppb-circle.done { background: #16a34a; color: #F1F5F9; border: none; box-shadow: 0 2px 8px #16a34a40; }
.ppb-circle.active { background: #4D84CB; color: #F1F5F9; border: none; box-shadow: 0 0 0 4px #1E2A48, 0 2px 8px #00000014; }
/* 第四态: 用户在看的阶段(不是当前阶段) —— 参考产品 .ppb-circle.viewing{background:#3b82f6;border:2px solid #93bbfd} */
.ppb-circle.viewing { background: #3B82F6; color: #F1F5F9; border: 2px solid #93BBFD; box-shadow: 0 2px 8px #3b82f64d; }
.ppb-num { font-size: 13px; font-weight: 700; line-height: 1; }
/* 参考产品 .ppb-label{font-size:11px;font-weight:600;text-align:center;white-space:nowrap} —— 我方原 13px */
.ppb-label { display: flex; align-items: center; gap: 5px; white-space: nowrap; text-align: center; }
.ppb-label-text { font-size: 11px; font-weight: 600; color: var(--wf-faint); letter-spacing: .02em; }
.ppb-label.active .ppb-label-text { color: #759FD7; }
.ppb-label.done .ppb-label-text { color: #5FD0B4; }
.ppb-label.viewing .ppb-label-text { color: #6FA8F5; }
.ppb-label.pending .ppb-label-text { color: var(--wf-faint); }
/* 参考产品 .ppb-metric{font-size:9.5px;display:block;margin-top:1px;opacity:.85} —— 我方原是带底色的胶囊 */
.ppb-metric {
  font-size: 9.5px; font-weight: 500; display: block; margin-top: 1px; opacity: .85;
  color: var(--wf-muted); background: none; padding: 0;
}
.ppb-label.active .ppb-metric, .ppb-label.viewing .ppb-metric { color: #6FA8F5; }
/*
 * ⚠ 2026-09-24: 补**基础规则** —— 此前这里**只有 `:hover`**, 没有任何基础样式。
 *   后果实测: 按钮宽 48px, 里面的 svg(13px) 与「新项目」三个字按 inline 排不下 → **换行**,
 *   渲染成"加号在上、新项目在下"两行(截图确认)。
 *   补成 inline-flex + nowrap: 图标与文字同一行, 且按钮不再被压窄。
 */
.ppb-new-btn {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  flex-shrink: 0; padding: 6px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--wf-line); background: var(--wf-raised);
  color: var(--wf-muted); font-size: 13px; font-weight: 600; font-family: inherit;
}
.ppb-new-btn:hover { border-color: #B06A6A; color: var(--wf-text); }

/*
 * 窄屏紧凑化 —— 逐条对照参考产品 @media(max-width:600px):
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
