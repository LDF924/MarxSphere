<script setup lang="ts">
/**
 * ImplementView(研究实施 · 第 3 步) — 对齐真实科研流程里的「实施」段。
 *
 * 由来（2026-09-26）：这一步的成立理由是一条**结构缺口** ——
 *   第 2 步「框架设计」产出研究设计（方法选型/因果识别/数据来源/伦理），
 *   但**没有任何一页承接它的执行**，直接从"设计"跳到第 4 步"料场"。
 *   数据收集、跑分析、看结果这三件事此前全挤在「文献与资料」页里
 *   （MaterialsView 2894 行，一级区文献检索、二级区挂着数据收集/文献矩阵/引用网络/研究台账）。
 *
 * ## 为什么是"新建一页"而不是"把资料页那几块搬过来"
 *
 * 搬走会打散两套既有探针的断言（`probe-writing-cabin-v425b` 的「数据收集-生成问卷真打端点」、
 * `probe-materials-actions` 的台账相关），而它们**本来在验的是真功能**。
 * 更划算的做法：**资料页保持不动**（它是完整的素材管理页），这里做"实施"这条链的**主线**——
 *   数据从哪来 → 跑了什么 → 结果是什么 → 进台账。
 * 数据准备区给**入口**指向资料页，而不是把同一块界面抄第二份（抄一份 = 两个地方都要改）。
 *
 * ## 按研究类型条件显示
 *
 * 本页注册的 `appliesTo: ["quantitative","mixed"]`（见 shared/stages.ts）——
 * 定性研究走访谈/文本分析，没有"数据集 → 统计分析"这一段，
 * 给它显示这一步只会让人在 17 种统计方法里找一个不相干的。
 * store 的 `stages` computed 已经按研究类型过滤，进度条与快捷键都会跟着少一个节点。
 *
 * ## 数据链（这三块为什么放在一起）
 *
 *   ① 研究设计回顾 —— 明确"该按什么做"（只读展示第 2 步定下的设计，避免用户翻回去看）
 *   ② 跑分析     —— 两个出口：本项目数据文件（统计台）、实证课题（回归/信效度）
 *   ③ 研究台账   —— 分析结果落成"哪条假设被支持"，这是第 5 步正文能写具体发现的前提
 */
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useWorkflowStore } from "./stores/workflow";
import { q } from "@/shared/api";
import { getNode } from "@/shared/tasks";
import { toast } from "@/shared/ui";
import { renderMd } from "@/shared/markdown";
import WorkflowShell from "./WorkflowShell.vue";
import PhaseProgressBar from "./PhaseProgressBar.vue";
import FindingsView from "./FindingsView.vue";
import { gotoWorkbenchModule, setEmpiricalTarget } from "@/shared/workflow-bridge";

const router = useRouter();
const store = useWorkflowStore();

/** 第 2 步定下的研究设计（design 节点）—— 只读回顾，改要去第 2 步 */
const design = ref<Record<string, unknown> | null>(null);
const designLoading = ref(true);

const METHOD_LABEL: Record<string, string> = {
  ols: "OLS 回归", logit: "Logistic 回归", ologit: "有序 Logistic", probit: "Probit",
  tobit: "Tobit", mediation: "中介效应", did: "双重差分", event_study: "事件研究",
  iv: "工具变量 2SLS", rdd: "断点回归", psm: "倾向得分匹配", scm: "合成控制",
  descriptive: "描述统计", crosstab: "交叉表", meta_analysis: "元分析",
};
const IDENTIFY_LABEL: Record<string, string> = {
  none: "不做因果推断（只写相关）", did: "双重差分", event_study: "事件研究",
  iv: "工具变量 2SLS", rdd: "断点回归", psm: "倾向得分匹配", scm: "合成控制",
};

const methodText = computed(() => {
  const id = String(design.value?.methodId ?? "");
  return id ? (METHOD_LABEL[id] ?? id) : "";
});
const identifyText = computed(() => {
  const id = String(design.value?.identifyId ?? "");
  return id ? (IDENTIFY_LABEL[id] ?? id) : "";
});
const dataSources = computed(() => {
  const v = design.value?.dataSources;
  return Array.isArray(v) ? v.map(String) : [];
});
const hasDesign = computed(() => !!(methodText.value || identifyText.value || dataSources.value.length));

/** 数据文件 / 分析结果（与资料页同源：statisticsFileId 是本课题与统计台的唯一连接点） */
const analyses = ref<Array<{ id: string; tool: string; status: string; createdAt: string }>>([]);
const analysesNote = ref("");
const hasDataFile = computed(() => !!store.statisticsFileId);

const TOOL_LABELS: Record<string, string> = {
  describe: "描述统计", crosstab: "交叉表", ttest: "t 检验", anova: "方差分析",
  correlation: "相关分析", ols: "OLS 回归", logit: "Logistic 回归",
  ologit: "有序 Logistic", probit: "Probit", tobit: "Tobit",
  mediation: "中介效应", did: "双重差分", event_study: "事件研究",
  iv: "工具变量 2SLS", rdd: "断点回归", psm: "倾向得分匹配",
  scm: "合成控制", meta_analysis: "元分析",
};

async function loadDesign() {
  designLoading.value = true;
  try {
    const node = await getNode(store.taskId, "design");
    design.value = node && typeof node === "object" ? node : null;
  } catch {
    design.value = null;
  } finally {
    designLoading.value = false;
  }
}

async function loadAnalyses() {
  if (!store.taskId) return;
  try {
    const r = await q<{ analyses?: Array<Record<string, unknown>>; reason?: string }>(
      `/research/projects/${store.taskId}/analyses`);
    const list = (r.analyses ?? []).map((a) => ({
      id: String(a.id ?? ""),
      tool: String(a.tool ?? ""),
      status: String(a.status ?? ""),
      createdAt: String(a.created_at ?? a.createdAt ?? ""),
    }));
    analyses.value = list;
    // 没有数据文件时后端会给出 reason —— 如实转述，别让用户看着一个空列表猜
    analysesNote.value = list.length ? "" : String(r.reason ?? "");
  } catch {
    analyses.value = [];
    analysesNote.value = "";
  }
}

function fmtTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 去统计台跑分析 —— 走外壳导航（保住"返回写作舱"的回程，与资料页那两个出口同一套约定） */
async function goAnalyze(where: "statistics-lab" | "empirical") {
  /**
   * 去实证台时要**带上本课题绑定的那个实证课题** —— 否则用户过去落在"未选中课题"状态，
   * 还得在下拉里再找一遍自己刚绑的那个（实证台刻意不自动选第一个）。
   * 绑定关系读写见 `/research/projects/:id/empirical-binding`（表格迁移 155）。
   * 与 ChapterEvidencePanel 的 gotoEmpirical 同一套做法：**先写交接再跳**（顺序反了读不到）。
   */
  if (where === "empirical") {
    try {
      const b = await q<{ empiricalProjectId?: string }>(`/research/projects/${store.taskId}/empirical-binding`);
      const id = String(b.empiricalProjectId ?? "");
      if (id) setEmpiricalTarget(id);
    } catch { /* 没绑定就照常跳，用户在那边自己选 */ }
  }
  const view = where === "statistics-lab" ? "statistics" : "empirical-research";
  const label = where === "statistics-lab" ? "研途写作舱 · 研究实施" : "研途写作舱 · 研究实施";
  if (gotoWorkbenchModule(view, { label, path: "/workflow/implement" })) return;
  toast("请从左侧导航进入对应模块", "warning");
}

/** 去资料页上传数据文件（数据准备留在那边，这里只给入口，不抄第二份界面） */
function goMaterials() {
  void router.push("/workflow/materials");
}

onMounted(async () => {
  await store.loadProject().catch(() => null);
  void loadDesign();
  void loadAnalyses();
});
</script>

<template>
  <WorkflowShell>
  <div class="workflow-page wf-page">
    <PhaseProgressBar />
    <div class="wf-body">
      <div class="wf-head">
        <h1 class="wf-h1">研究实施</h1>
        <p class="wf-sub">按第 2 步定下的研究设计跑数据、看结果、把结果落成可引用的发现。</p>
      </div>

      <!-- ① 研究设计回顾（只读） —— 让用户不必翻回第 2 步就知道"该按什么做" -->
      <section class="iv-card">
        <h2 class="iv-h2">研究设计回顾
          <span class="iv-h2-note">在第 2 步「框架设计」里修改</span>
        </h2>
        <p v-if="designLoading" class="iv-muted">读取中…</p>
        <template v-else-if="hasDesign">
          <div class="iv-kv">
            <div v-if="methodText" class="iv-kv-item"><span class="iv-k">研究方法</span><span class="iv-v">{{ methodText }}</span></div>
            <div v-if="identifyText" class="iv-kv-item"><span class="iv-k">因果识别</span><span class="iv-v">{{ identifyText }}</span></div>
            <div v-if="dataSources.length" class="iv-kv-item"><span class="iv-k">数据来源</span><span class="iv-v">{{ dataSources.join("、") }}</span></div>
          </div>
          <p v-if="identifyText === '不做因果推断（只写相关）'" class="iv-warn">
            已声明不做因果推断 —— 后续正文里不能出现「导致 / 因为…所以」这类句式。
          </p>
        </template>
        <p v-else class="iv-muted">
          还没有研究设计。到
          <button class="iv-link" data-control="workflow:implement-goto-design" @click="router.push('/workflow/sections')">框架设计</button>
          里选方法、识别策略与数据来源 —— 生成正文时会按它约束句式与数据口径。
        </p>
      </section>

      <!-- ② 数据与分析 -->
      <section class="iv-card">
        <h2 class="iv-h2">数据与分析</h2>

        <div class="iv-chain">
          <div class="iv-step" :class="{ on: hasDataFile }">
            <span class="iv-step-no">1</span>
            <div class="iv-step-body">
              <strong>数据准备</strong>
              <span v-if="hasDataFile" class="iv-ok">已有数据文件</span>
              <span v-else class="iv-todo">待上传</span>
              <p class="iv-step-note">问卷识别、数据文件上传在「文献与资料」页。</p>
              <button class="iv-btn" data-control="workflow:implement-goto-materials" @click="goMaterials">去数据准备</button>
            </div>
          </div>

          <div class="iv-step" :class="{ on: analyses.length > 0 }">
            <span class="iv-step-no">2</span>
            <div class="iv-step-body">
              <strong>跑分析</strong>
              <span v-if="analyses.length" class="iv-ok">{{ analyses.length }} 次</span>
              <span v-else class="iv-todo">未跑过</span>
              <p class="iv-step-note">
                两条路都通：<em>数据分析台</em>按数据文件跑 17 种统计方法（结果可回流成本章素材）；
                <em>实证研究</em>是课题级的问卷/信效度/回归，结果可采集为「发现」。
              </p>
              <div class="iv-btn-row">
                <button class="iv-btn" data-control="workflow:implement-goto-stats" @click="goAnalyze('statistics-lab')">去数据分析台</button>
                <button class="iv-btn" data-control="workflow:implement-goto-empirical" @click="goAnalyze('empirical')">去实证研究</button>
              </div>
            </div>
          </div>

          <div class="iv-step" :class="{ on: analyses.length > 0 }">
            <span class="iv-step-no">3</span>
            <div class="iv-step-body">
              <strong>看结果</strong>
              <p class="iv-step-note">下面「本课题跑过的分析」列出结果，可一键插入章节当素材。</p>
              <p v-if="analysesNote" class="iv-muted">{{ analysesNote }}</p>
              <ul v-else-if="analyses.length" class="iv-list">
                <li v-for="a in analyses" :key="a.id">
                  <span class="iv-tool">{{ TOOL_LABELS[a.tool] ?? a.tool }}</span>
                  <span class="iv-time">{{ fmtTime(a.createdAt) }}</span>
                  <span v-if="a.status !== 'completed'" class="iv-badge">{{ a.status === "failed" ? "失败" : "进行中" }}</span>
                </li>
              </ul>
              <p v-else class="iv-muted">还没有跑过分析。</p>
            </div>
          </div>
        </div>
      </section>

      <!-- ③ 研究台账 —— 假设检验结论 + 系统从结果里挖出的发现 -->
      <section class="iv-card">
        <h2 class="iv-h2">研究台账
          <span class="iv-h2-note">第 5 步写正文时的「本章依据」取自这里</span>
        </h2>
        <FindingsView :project-id="store.taskId" />
      </section>
    </div>
  </div>
  </WorkflowShell>
</template>

<style scoped>
.workflow-page { width: 100%; box-sizing: border-box; }
.wf-head { margin-bottom: 16px; }
.wf-h1 { margin: 0; font-size: 22px; font-weight: 700; color: var(--wf-text); }
.wf-sub { margin: 4px 0 0; font-size: 13px; color: var(--wf-muted); }

.iv-card {
  border: 1px solid var(--wf-line); border-radius: var(--wf-r);
  background: var(--wf-surface); padding: 14px 16px; margin-bottom: 14px;
}
.iv-h2 {
  margin: 0 0 10px; font-size: 15px; font-weight: 600; color: var(--wf-text);
  display: flex; align-items: baseline; gap: 8px;
}
.iv-h2-note { font-size: 12px; font-weight: 400; color: var(--wf-faint); }
.iv-muted { margin: 6px 0 0; font-size: 13px; color: var(--wf-muted); }
.iv-kv { display: flex; flex-wrap: wrap; gap: 8px 20px; }
.iv-kv-item { display: flex; align-items: baseline; gap: 6px; font-size: 13px; }
.iv-k { color: var(--wf-faint); }
.iv-v { color: var(--wf-text); }
.iv-warn {
  margin: 10px 0 0; padding: 8px 10px; font-size: 12.5px;
  border-left: 3px solid #D9A441; background: rgba(217, 164, 65, .08); color: var(--wf-text-2);
}
.iv-link {
  background: none; border: none; padding: 0; cursor: pointer;
  color: var(--wf-accent); text-decoration: underline; font-size: inherit;
}

/* 三步链 —— 用竖线串起来，"做到哪了"一眼看得出 */
.iv-chain { display: flex; flex-direction: column; gap: 12px; }
.iv-step { display: flex; gap: 10px; }
.iv-step-no {
  flex: 0 0 22px; width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; border: 1px solid var(--wf-line); color: var(--wf-faint);
}
.iv-step.on .iv-step-no { border-color: var(--wf-accent); color: var(--wf-accent); }
.iv-step-body { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.iv-step-body strong { font-size: 13.5px; color: var(--wf-text); }
.iv-ok { font-size: 12px; color: #6FBF8B; }
.iv-todo { font-size: 12px; color: var(--wf-faint); }
.iv-step-note { flex-basis: 100%; margin: 2px 0 0; font-size: 12.5px; color: var(--wf-muted); line-height: 1.6; }
.iv-step-note em { font-style: normal; color: var(--wf-text-2); }
.iv-btn-row { flex-basis: 100%; display: flex; gap: 8px; margin-top: 6px; }
.iv-btn {
  padding: 5px 12px; font-size: 12.5px; cursor: pointer;
  border: 1px solid var(--wf-line); border-radius: var(--wf-r-sm);
  background: var(--wf-raised); color: var(--wf-text-2);
}
.iv-btn:hover { color: var(--wf-text); border-color: var(--wf-line-strong); }
.iv-step-body .iv-btn { margin-top: 6px; }
.iv-list { flex-basis: 100%; list-style: none; margin: 6px 0 0; padding: 0; }
.iv-list li { display: flex; align-items: center; gap: 10px; padding: 4px 0; font-size: 13px; color: var(--wf-text-2); }
.iv-tool { color: var(--wf-text); }
.iv-time { font-size: 12px; color: var(--wf-faint); }
.iv-badge { font-size: 11px; padding: 0 6px; border-radius: var(--wf-r-pill); border: 1px solid var(--wf-line); color: var(--wf-faint); }
</style>
