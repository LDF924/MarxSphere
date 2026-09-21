<script setup lang="ts">
/**
 * InputView(Phase1 信息录入) — 还原自闭源 InputView-DwlhRWpv.js(L616-1471)
 * 主题/字数预估/大纲 OutlineEditor/额外要求/方法 3 卡/参考文件/agent 引导提问手风琴 → submitAnalysis
 * 提交链: 校验 → 建项目(template five-stage) → 写 input 节点 → phase=2 → /workflow/sections
 */
import { ref, computed, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import OutlineEditor from "./OutlineEditor.vue";
import { useWorkflowStore } from "./stores/workflow";
import { toast, confirmDialog } from "@/shared/ui";
import { q } from "@/shared/api";
import { markWorkflowReady } from "@/shared/workflow-bridge";
import { putNode, createTask } from "@/shared/tasks";
import PhaseProgressBar from "./PhaseProgressBar.vue";

const router = useRouter();
const store = useWorkflowStore();

// ── 拖拽文件 ──
const fileDragover = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
// V417: 正在读取的文件名(读 PDF/docx 要几秒, 给用户反馈并防重复点)
const fileBusy = ref("");

const canSubmit = computed(() => {
  const title = store.input.title.trim();
  const outline = store.input.outline.trim();
  return title.length >= 4 && !/^\d+$/.test(title) && !!outline;
});

// ── 方法选择 ──
const METHODS = [
  { id: "qualitative", label: "定性研究", desc: "案例 / 访谈 / 文本分析" },
  { id: "quantitative", label: "定量研究", desc: "问卷 / 实证 / 统计分析" },
  { id: "mixed", label: "混合方法", desc: "定性 + 定量结合" }
];

/**
 * 研究方法自动识别 —— 还原闭源 `wp()`(index-xpWAkSSw.js, "detectResearchMethod")。
 *
 * ⚠ 2026-09-16 修: 原先这里有**两份**词表(展示用 10 词 / 提交用 9 词), 两份还不一样,
 *   而且都和闭源差得远。逐字对照闭源后的三处不等价:
 *   ① 词表: 闭源定量 **34** 词、定性 **18** 词; 我方只有 10/7 —— "量表/结构方程/信度/效度/
 *      绩效/评价指标"这类高频题面词全识别不出来。
 *   ② 文本源: 闭源取 **title + outline**; 我方取 title + requirements。
 *      后果: 用户写的目录里全是量化词, 系统却当没看见。
 *   ③ 兜底: 闭源无匹配时**兜底 qualitative**(并打日志); 我方返 ""。
 *      这条看似等价(下游默认走定性), 但空值会让 `researchMethodAuto` 判定为"没识别出来",
 *      提示条不显示 —— 用户看不到系统替他选了什么。
 *   现在统一成一份实现, 展示与提交共用(原先两份并存正是"显示的和提交的不一致"的根源)。
 */
const QUANT_WORDS = ["实证", "问卷", "量表", "回归", "统计", "数据分析", "假设检验", "结构方程", "sem", "amos", "spss", "stata", "计量", "量化", "定量", "样本", "显著性", "相关系数", "因子分析", "信度", "效度", "调查", "实验", "检验", "模型", "路径分析", "调节效应", "中介效应", "影响机制", "驱动因素", "影响因素", "绩效", "效率", "评价指标"];
const QUAL_WORDS = ["案例", "访谈", "文本分析", "话语分析", "民族志", "扎根理论", "质性", "叙事", "现象学", "田野", "观察", "内容分析", "比较研究", "政策分析", "历史分析", "文献分析", "理论分析", "思辨"];
/** 识别文本源: 标题 + 目录(闭源 `(title||"") + " " + (outline||"")`, 统一小写) */
function methodHeuristicText(): string {
  return `${store.input.title || ""} ${store.input.outline || ""}`.toLowerCase();
}
function inferMethod(txt: string): "qualitative" | "quantitative" | "mixed" {
  let qn = 0, ql = 0;
  for (const w of QUANT_WORDS) if (txt.includes(w)) qn++;
  for (const w of QUAL_WORDS) if (txt.includes(w)) ql++;
  if (qn >= 2 && ql >= 2) return "mixed";
  if (qn >= 2) return "quantitative";
  if (ql >= 2) return "qualitative";
  return "qualitative"; // 闭源语义: 无明确定量线索 → 默认定性
}
/**
 * 识别提示条是否显示。
 *
 * 闭源这里有**时序不对称**: 提示由 `wp()` 在**提交那一刻**才触发(它顺手把值写回 store),
 * 而模型卡的高亮直接绑 `input.researchMethod` —— 所以"高亮"和"提示条"只在提交后才同时亮。
 * 我方常驻计算, 在**表现上更好**(用户在提交前就知道系统会怎么判), 但两边必须用**同一份实现**,
 * 否则会出现"提示说识别为定量、提交后却按定性走"这种自相矛盾。
 * 现在共用 inferMethod, 一致性由结构保证, 不再靠两处词表碰巧长得一样。
 */
const researchMethodAuto = computed(() => {
  // 用户手动选过就不再提示(那一项已高亮, 再提示是噪音)
  if (store.input.researchMethod) return false;
  const txt = methodHeuristicText();
  // 闭源在提交时才校验"主题 ≥4 字", 这里只在够长时才展示判断, 免得空表单显示"已识别为定性"
  return txt.trim().length >= 6;
});
const methodAutoLabel = computed(() => {
  const map: Record<string, string> = { qualitative: "定性研究", quantitative: "定量研究", mixed: "混合方法" };
  return map[inferMethod(methodHeuristicText())] ?? "定性研究";
});
function pickMethod(id: string) {
  store.input.researchMethod = id;
  autoSave();
}

// ── 自动草稿(闭源 autoSaveDraft: skf_draft) ──
function autoSave() {
  try {
    localStorage.setItem(
      "skf_draft",
      // 2026-09-16: 补 clarifyAnswers —— 用户答完引导问题若刷新页面, 答案是空的(闭源草稿存整个 input 对象);
      //   顺带把 sampleFiles 也存上, 但那可能很大, 只存文件名与大小, 内容不进草稿。
      JSON.stringify({
        title: store.input.title, outline: store.input.outline,
        requirements: store.input.requirements, researchMethod: store.input.researchMethod,
        totalWordCount: store.input.totalWordCount,
        clarifyAnswers: store.input.clarifyAnswers ?? {},
      })
    );
  } catch { /* 忽略 */ }
}
function loadDraft() {
  try {
    const raw = localStorage.getItem("skf_draft");
    if (!raw) return;
    const d = JSON.parse(raw);
    if (typeof d.title === "string") store.input.title = d.title;
    if (typeof d.outline === "string") store.input.outline = d.outline;
    if (typeof d.requirements === "string") store.input.requirements = d.requirements;
    if (typeof d.researchMethod === "string") store.input.researchMethod = d.researchMethod;
    if (typeof d.totalWordCount === "number") store.input.totalWordCount = d.totalWordCount;
    if (d.clarifyAnswers && typeof d.clarifyAnswers === "object") {
      store.input.clarifyAnswers = { ...(store.input.clarifyAnswers ?? {}), ...(d.clarifyAnswers as Record<string, string>) };
    }
  } catch { /* 忽略 */ }
}

// ── 参考文件解析(txt/docx/pdf; 闭源 st/Q/rt 三管道) ──
async function readFileAsText(file: File): Promise<string> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const pdfjs = await import("pdfjs-dist");
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    let out = "";
    for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      out += tc.items.map((it: unknown) => (it as { str?: string }).str ?? "").join("") + "\n";
    }
    return out;
  }
  if (lower.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const r = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return r.value ?? "";
  }
  // V417: 老式 .doc 是二进制复合文档, 按 UTF-8 当纯文本读出来是乱码 —— 而且会被当成读取成功
  //   塞进样例文件里, 用户看到一堆方块字还以为是模型的问题。这里明确拒绝并给出可操作建议。
  if (lower.endsWith(".doc")) {
    throw new Error("不支持老式 .doc(二进制格式)。请在 Word/WPS 里另存为 .docx 后再上传");
  }
  return await file.text();
}

async function handleFile(file: File) {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!["txt", "doc", "docx", "pdf", "md"].includes(ext)) {
    toast(`不支持的文件格式: .${ext}(支持 .txt/.docx/.pdf)`, "error");
    return;
  }
  // V417: 读 20 页 PDF / 大 docx 要好几秒, 此前界面毫无反馈且可重复点。加个忙碌提示。
  fileBusy.value = file.name;
  try {
    const content = await readFileAsText(file);
    store.input.sampleFiles.push({ name: file.name, size: file.size, content: content.slice(0, 200_000) });
    toast(`已读取: ${file.name}`, "success");
    autoSave();
  } catch (e) {
    toast(`读取失败: ${(e as Error).message}`, "error");
  } finally {
    fileBusy.value = "";
  }
}
function onDrop(ev: DragEvent) {
  fileDragover.value = false;
  for (const f of ev.dataTransfer?.files ?? []) void handleFile(f);
}
function removeFile(i: number) {
  store.input.sampleFiles.splice(i, 1);
  autoSave();
}

/**
 * V417: 检索数据源绑定 —— 文献检索要从哪个库里搜。
 *
 * 没有它, `research_projects.source_ids` 永远是空 → 检索回退到默认公共库,
 * 用户换个选题(比如"数字普惠金融")就搜出一堆不相干文献。本机实测: 公共库是"资本下乡"(504 篇)。
 */
const availableSources = ref<Array<{ id: string; name: string; docCount: number; isPublic: boolean }>>([]);
const pickedSourceIds = ref<string[]>([]);
const sourcesLoading = ref(false);

async function loadAvailableSources() {
  sourcesLoading.value = true;
  try {
    const { q } = await import("@/shared/api");
    const r = await q<{ sources?: typeof availableSources.value }>("/research/available-sources");
    availableSources.value = r.sources ?? [];
    // 未选过则默认勾上文档最多的那个(通常就是用户自己的库)
    if (!pickedSourceIds.value.length && availableSources.value.length) {
      pickedSourceIds.value = [availableSources.value[0].id];
    }
  } catch {
    availableSources.value = [];
  } finally {
    sourcesLoading.value = false;
  }
}

function toggleSource(id: string) {
  const next = new Set(pickedSourceIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  pickedSourceIds.value = Array.from(next);
}

/** 项目未建 → 提交时随建项目带上; 已建 → 直接改绑 */
async function persistSources(projectId: string): Promise<void> {
  if (!projectId) return;
  try {
    const { q } = await import("@/shared/api");
    await q(`/research/projects/${projectId}/sources`, { method: "PUT", body: { sourceIds: pickedSourceIds.value } });
  } catch { /* 不阻断提交(检索时回退默认库) */ }
}

// ── 澄清问答(闭源 4 态手风琴; POST /api/clarify/generate) ──
const clarify = ref<{ state: "idle" | "loading" | "done" | "error"; questions: Array<{ id: string; category: string; question: string; guidance: string; importance: string; answer?: string }>; error: string }>({
  state: "idle", questions: [], error: ""
});
/**
 * 后端每次都会回一段「总体分析」(已明确什么 + 还存在哪些关键模糊点)。
 * 2026-09-16 修: 原先解析时把它丢了 —— 后果在"0 问完成态"最明显:
 * 界面只剩一句「AI 未发现需要补充的引导问题」, 用户看不到任何分析结论。
 */
const clarifyAnalysis = ref("");
/** 已进入第几轮追问(0 = 首轮); 后端按 round 切换"≤3 问、不重复已明确项"的提示词 */
const clarifyRound = ref(0);
let clarifyAbort: AbortController | null = null;

/** 引导提问手风琴(闭源默认收起; 生成完/有答案时自动展开, 免得结果藏在折叠里没人看见) */
const clarifyOpen = ref(false);
watch(
  () => clarify.value.state,
  (s) => { if (s === "done") clarifyOpen.value = true; }
);

/** 引导问 8 分类的中文标签与配色(闭源 OutlineEditor-DECODED §引导提问 8 分类) */
const CAT_LABELS: Record<string, string> = {
  scope: "范围界定", concept: "概念维度", method: "研究方法", theory: "理论基础",
  data: "数据来源", innovation: "创新聚焦", structure: "章节逻辑", general: "补充信息",
};
const CAT_COLORS: Record<string, string> = {
  scope: "cat-blue", concept: "cat-purple", method: "cat-green", theory: "cat-orange",
  data: "cat-cyan", innovation: "cat-pink", structure: "cat-indigo", general: "cat-gray",
};
function catLabel(c: string): string { return CAT_LABELS[String(c)] ?? String(c || "补充信息"); }
function catColor(c: string): string { return CAT_COLORS[String(c)] ?? "cat-gray"; }

/**
 * 生成/续问澄清问题。
 *
 * @param nextRound true = 基于已答内容发起**第二轮追问**(闭源 `round` + `answers` 语义)。
 *   后端一直支持这两个字段, 但前端从不传 —— 所以"答完第一轮再问一轮"的能力此前根本走不到。
 *   后端在第 2 轮会切到"只问仍模糊的关键点(≤3 问, 不重复已明确项)"的提示词。
 */
async function runClarify(nextRound = false) {
  clarify.value.state = "loading";
  if (!nextRound) clarify.value.questions = [];
  clarifyAbort?.abort();
  clarifyAbort = new AbortController();
  try {
    // 已答内容带上 —— 第二轮靠它判断"哪些已经明确"
    const answers = nextRound
      ? clarify.value.questions
          .filter((q) => String(q.answer ?? "").trim())
          .map((q) => ({ question: q.question, answer: String(q.answer) }))
      : [];
    const body = {
      title: store.input.title,
      outline: store.input.outline,
      requirements: store.input.requirements,
      researchMethod: store.input.researchMethod,
      totalWordCount: store.input.totalWordCount,
      sampleContent: store.input.sampleFiles.map((f) => f.content.slice(0, 3000)).join("\n\n").slice(0, 8000),
      ...(nextRound ? { round: clarifyRound.value + 1, answers } : {})
    };
    const r = await fetch("/api/clarify/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}`
      },
      body: JSON.stringify(body),
      signal: clarifyAbort.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const qs = j?.data?.questions ?? j?.questions ?? [];
    // 总体分析每次都要留下 —— 0 问时它是用户唯一能看到的结论
    clarifyAnalysis.value = String(j?.data?.analysis ?? j?.analysis ?? "");
    if (nextRound) clarifyRound.value += 1;
    if (!Array.isArray(qs) || !qs.length) {
      clarify.value.state = "done";
      clarify.value.questions = [];
      toast(nextRound ? "第二轮追问完成: 已无更多关键模糊点" : "AI 未发现需要补充的引导问题", "info");
      return;
    }
    clarify.value.state = "done";
    clarify.value.questions = qs.map((q: Record<string, unknown>) => {
      // 后端缺 id 时用 序号+question 前 12 字作稳定 key(避免随机 key 导致答案无法回填)
      const rawId = String(q.id ?? "").trim();
      const stableId = rawId || `q_${String(q.question ?? "").slice(0, 12).replace(/\s/g, "_")}`;
      return {
        id: stableId,
        category: String(q.category ?? "general"),
        question: String(q.question ?? ""),
        guidance: String(q.guidance ?? ""),
        importance: String(q.importance ?? "normal"),
        answer: store.input.clarifyAnswers[stableId] ?? store.input.clarifyAnswers[rawId] ?? ""
      };
    });
    toast(nextRound ? `第 ${clarifyRound.value} 轮追问: ${qs.length} 个问题` : `AI 生成了 ${qs.length} 个引导问题`, "success");
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    clarify.value.state = "error";
    clarify.value.error = String((e as Error).message ?? e);
  }
}
function setAnswer(q: { id: string }, v: string) {
  store.input.clarifyAnswers[q.id] = v;
  autoSave();
}

// ── 提交(闭源 submitAnalysis → W()): 建项目 → 写 input 节点 → phase2 ──
const submitting = ref(false);

/**
 * 页面级异步状态埋点(闭源 InputView-DECODED: data-assistant-async-busy=submitting||clarifyLoading,
 * reason=正在提交研究信息/正在生成需求澄清问题)。
 * 科研助手靠它判断"这页正忙、别来插动作" —— 原先恒为 "false", 助手在提交过程中照样推动作。
 */
const asyncBusy = computed(() => submitting.value || clarify.value.state === "loading");
const asyncReason = computed(() =>
  submitting.value ? "正在提交研究信息" : clarify.value.state === "loading" ? "正在生成需求澄清问题" : ""
);
const deleting = ref(false);

/**
 * 删除当前项目(V419b)。软删 —— 后端 PUT status='deleted', 不删数据。
 *
 * 确认层要把**真实后果**说清楚, 尤其"还有任务在跑"这一条: 后端在 2026-09-21 之前
 *   `findReadyTasks` 根本不看项目状态, 删了项目它的排队任务**照样被调度器捞去烧 LLM**
 *   (已一并修好: 选任务与领取任务两处都加了项目状态闸)。用户此刻必须知道这一点。
 */
async function deleteCurrentProject() {
  const pid = store.taskId;
  if (!pid) { toast("当前没有项目", "warning"); return; }
  // 标题取 project 上真实落库的那份 —— store.title 是 **input.title**(新建项目时为空),
  //   直接用它会让确认层永远显示「当前项目」(实测踩到)。
  let name = store.project.title || store.input.title || "";
  try {
    const r = await q<{ project?: { title?: string } }>(`/research/projects/${pid}`);
    if (r.project?.title) name = r.project.title;
  } catch { /* 取不到就用本地兜底 */ }
  // 先问后端还有多少在跑的任务 —— 不猜
  let running = 0;
  try {
    const r = await q<{ tasks?: Array<{ status?: string }> }>(`/research/tasks?projectId=${pid}`);
    running = (r.tasks ?? []).filter((t) => ["queued", "running", "in-progress"].includes(String(t.status))).length;
  } catch { /* 取不到就不提这一条, 不阻断删除 */ }
  const extra = running ? `\n\n注意: 该项目还有 ${running} 个任务处于排队/运行中, 删除后不会再被调度执行。` : "";
  // ⚠ 确认层是纯文本渲染(white-space: pre-wrap), **不解析 Markdown** —— 早先这里写了
  //   `**软删**`, 界面上原样显示成两个星号(实测截图确认)。别在 message 里用 Markdown 语法。
  const ok = await confirmDialog({
    title: "删除项目",
    message: `确定从列表移除「${name || "当前项目"}」?${extra}\n\n这是软删: 项目不再出现在列表里, 但数据(章节/素材/版本/历史)都保留。`,
    okText: "删除", cancelText: "取消", danger: true,
  });
  if (!ok) return;
  deleting.value = true;
  try {
    await q(`/research/projects/${pid}`, { method: "DELETE" });
    toast("项目已移除", "success");
    // 清指针再回列表页 —— 留着会在下一次挂载时把已删项目又拉回来
    localStorage.removeItem("lastTask_workflow");
    store.resetLocal();
    router.push("/workflow");
  } catch (e) {
    toast(`删除失败: ${(e as Error).message}`, "error");
  } finally { deleting.value = false; }
}

async function submitAnalysis() {
  if (submitting.value) return; // 防双击重复建项目
  if (!canSubmit.value) {
    if (store.input.title.trim().length < 4 || /^\d+$/.test(store.input.title.trim())) toast("请填写有效的研究主题(至少 4 个字符)", "warning");
    else if (!store.input.outline.trim()) toast("请填写章节大纲", "warning");
    return;
  }
  submitting.value = true;
  try {
    // researchMethod 启发式(闭源 wp: 标题+目录 → 定量/定性关键词计分, 无匹配默认定性)
    // 与展示用的 methodAutoLabel 共用同一份实现(原先这里是第二份词表, 两边会打架)
    if (!store.input.researchMethod) {
      store.input.researchMethod = inferMethod(methodHeuristicText());
    }
    const pid = await store.ensureTask(store.input.title || "未命名科研任务");
    // 建项目(若 ensureTask 未建)
    if (!pid) {
      toast("项目创建失败", "error");
      return;
    }
    // 写 input 节点(快照)
    await putNode(pid, "input", {
      title: store.input.title,
      outline: store.input.outline,
      requirements: store.input.requirements,
      researchMethod: store.input.researchMethod,
      totalWordCount: Number(store.input.totalWordCount) || 10000,
      sampleFiles: store.input.sampleFiles,
      clarifyAnswers: store.input.clarifyAnswers,
      updatedAt: new Date().toISOString()
    }).catch(() => null);
    store.setPhase(2);
    // V417: 把选了的数据源绑定到项目(没有它, 文献检索回退到默认公共库 → 搜出不相干文献)
    await persistSources(pid);
    localStorage.removeItem("skf_draft");
    toast("提交成功, 进入科研架构分析", "success");
    void router.push("/workflow/sections");
  } catch (e) {
    toast(`提交失败: ${(e as Error).message}`, "error");
  } finally {
    submitting.value = false;
  }
}

watch(() => store.input.title, () => autoSave());
watch(() => store.input.outline, () => autoSave());
watch(() => store.input.researchMethod, () => autoSave());
watch(() => store.input.requirements, () => autoSave());
watch(() => store.input.totalWordCount, () => autoSave());
watch(() => store.input.clarifyAnswers, () => autoSave(), { deep: true });

onMounted(async () => {
  markWorkflowReady();
  await store.loadProject().catch(() => null);
  void loadAvailableSources();
  // 已建项目 → 回读它绑定的数据源
  if (store.taskId) {
    void (async () => {
      try {
        const { q } = await import("@/shared/api");
        const r = await q<{ project?: { source_ids?: string[] } }>(`/research/projects/${store.taskId}`);
        const ids = r.project?.source_ids;
        if (Array.isArray(ids) && ids.length) pickedSourceIds.value = ids.map(String);
      } catch { /* 容忍 */ }
    })();
  }
  // 草稿仅在「无已存项目输入」时恢复(否则旧草稿会覆盖服务端快照的项目内容)
  const hasSaved = !!store.taskId && !!(store.input.title || store.input.outline);
  if (!hasSaved) loadDraft();
});
</script>

<template>
  <div
    class="workflow-page wf-page"
    :data-assistant-async-busy="asyncBusy ? 'true' : 'false'"
    :data-assistant-async-reason="asyncReason"
  >
    <PhaseProgressBar />
    <!-- 闭源页头: `mb-8`(32px) 包住 h1.text-2xl(24px) + p.text-sm + `mt-1`(4px)。
         2026-09-16 修: 我方原先 h1 22px / 副文案 13px / 下间距 18px —— 整条阶梯都塌了一档。 -->
    <div class="wf-head">
      <h1 class="wf-h1">信息录入</h1>
      <p class="wf-sub">请输入你的研究主题、研究框架和额外要求，AI智能体将据此规划科研架构</p>
    </div>

    <!-- 研究主题 + 字数预估(闭源同一行: 主题 flex-1 + 字数 w-36, 都带红色 *) -->
    <section class="wf-card">
      <div class="topic-row">
        <div class="topic-main">
          <label class="wf-label">
            研究主题
            <span class="req-star">*</span>
          </label>
          <input
            v-model="store.input.title"
            class="wf-input"
            placeholder="例如:数字经济背景下中小企业融资困境与对策研究"
            data-control="workflow:research-title"
          />
        </div>
        <div class="topic-wc">
          <label class="wf-label">
            字数预估
            <span class="req-star">*</span>
          </label>
          <input
            v-model.number="store.input.totalWordCount"
            type="number"
            min="3000"
            max="50000"
            step="1000"
            class="wf-input"
            data-control="workflow:total-word-count"
          />
        </div>
      </div>
      <p class="wf-note">字数估算仅计算正文整体工作量(不含摘要、关键词、参考文献等内容),AI 智能体将按此字数进行科研分配。</p>
    </section>

    <!-- 大纲(OutlineEditor) -->
    <section class="wf-card">
      <label class="wf-label">
        研究框架(章节大纲)
        <span class="req-star">*</span>
      </label>
      <OutlineEditor v-model="store.input.outline" />
      <!-- sr-only 同步真源(DOM 自动化/爬虫可见) -->
      <textarea class="sr-only" :value="store.input.outline" data-control="workflow:outline" tabindex="-1" aria-hidden="true" style="position: absolute; width: 1px; height: 1px; opacity: 0"></textarea>
    </section>

    <!-- 额外要求(闭源此处是 textarea, 不是单行 input —— 长要求写不进一行) -->
    <section class="wf-card">
      <label class="wf-label">额外要求<span class="opt-tag">(可选)</span></label>
      <textarea
        v-model="store.input.requirements"
        class="wf-textarea"
        rows="3"
        placeholder="例如: 近3年文献 / 实证方法 / 8000-10000字 / 江苏省中小企业"
        data-control="workflow:requirements"
      ></textarea>
    </section>

    <!-- 研究方法 -->
    <section class="wf-card">
      <label class="wf-label">研究方法</label>
      <div class="method-grid">
        <button
          v-for="m in METHODS"
          :key="m.id"
          type="button"
          class="method-card"
          :class="{ selected: store.input.researchMethod === m.id }"
          :aria-pressed="store.input.researchMethod === m.id"
          :data-control="'workflow_method_' + m.id"
          @click="pickMethod(m.id)"
        >
          <strong>{{ m.label }}</strong>
          <small>{{ m.desc }}</small>
        </button>
      </div>
      <p class="wf-note">如不确定可跳过, 系统将根据标题和目录自动识别。</p>
      <p v-if="researchMethodAuto" class="auto-detect-note">📎 已根据标题和目录自动识别: {{ methodAutoLabel }}</p>
    </section>

    <!-- V417 检索数据源: 素材准备阶段的文献检索从这里选库 -->
    <section class="wf-card">
      <label class="wf-label">检索数据源</label>
      <p v-if="sourcesLoading" class="wf-note">正在读取可用数据源…</p>
      <p v-else-if="!availableSources.length" class="wf-note">
        暂无可用数据源。文献检索会自动回退到平台公共库; 也可稍后在「文献管理」里导入后重建项目。
      </p>
      <div v-else class="src-list">
        <button
          v-for="s in availableSources"
          :key="s.id"
          type="button"
          class="src-item"
          :class="{ selected: pickedSourceIds.includes(s.id) }"
          :aria-pressed="pickedSourceIds.includes(s.id)"
          :data-control="'workflow_source_' + s.id"
          @click="toggleSource(s.id)"
        >
          <span class="src-check">{{ pickedSourceIds.includes(s.id) ? "✓" : "" }}</span>
          <span class="src-name">{{ s.name }}</span>
          <span class="src-count">{{ s.docCount }} 篇{{ s.isPublic ? " · 公共库" : "" }}</span>
        </button>
      </div>
      <p class="wf-note">
        文献检索阶段会在这几个库里搜真实文献并生成可引用的参考文献。
        <template v-if="!pickedSourceIds.length">不选则用平台公共库。</template>
      </p>
    </section>

    <!-- 参考文件 -->
    <section class="wf-card">
      <label class="wf-label">参考文件(可选)</label>
      <div
        class="drop-zone"
        :class="{ dragover: fileDragover }"
        @click="fileInput?.click()"
        @dragover.prevent="fileDragover = true"
        @dragleave="fileDragover = false"
        @drop.prevent="onDrop"
      >
        <template v-if="fileBusy">
          <p class="drop-line">正在读取 {{ fileBusy }}…</p>
        </template>
        <template v-else>
          <p class="drop-line">点击或拖拽上传参考文件</p>
          <p class="drop-sub">支持 PDF、Word、TXT、Markdown</p>
        </template>
        <input ref="fileInput" type="file" multiple accept=".pdf,.docx,.txt,.md" style="display: none" @change="(ev) => { for (const f of (ev.target as HTMLInputElement).files ?? []) void handleFile(f); (ev.target as HTMLInputElement).value = ''; }" />
      </div>
      <div v-if="store.input.sampleFiles.length" class="file-list">
        <div v-for="(f, i) in store.input.sampleFiles" :key="i" class="file-row">
          <span class="file-icon">📄</span>
          <span class="file-name">{{ f.name }}</span>
          <span class="file-size">{{ (f.size / 1024).toFixed(0) }}KB</span>
          <span class="file-status ok">✓ 已读取</span>
          <button class="file-remove" @click="removeFile(i)">移除</button>
        </div>
      </div>
    </section>

    <!-- agent 引导提问(闭源: 默认折叠的手风琴, 标题栏带「（推荐）」) -->
    <section class="wf-card clarify-card">
      <button
        type="button"
        class="clarify-head"
        :aria-expanded="clarifyOpen"
        data-control="workflow:clarify-toggle"
        @click="clarifyOpen = !clarifyOpen"
      >
        <span class="ch-left">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M12 3a6 6 0 00-3.6 10.8c.5.4.8 1 .9 1.6l.1.6h5.2l.1-.6c.1-.6.4-1.2.9-1.6A6 6 0 0012 3zM9.5 19h5M10.5 21.5h3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="ch-title">agent引导提问（推荐）</span>
        </span>
        <svg class="ch-arrow" :class="{ open: clarifyOpen }" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <div v-if="clarifyOpen" class="clarify-body">
        <div v-if="clarify.state === 'idle'" class="clarify-idle">
          <p>AI智能体将根据你已填写的信息提出针对性问题，回答后将自动纳入科研架构分析。</p>
          <button type="button" class="btn-clarify-run" @click="runClarify(false)" data-control="workflow:clarify">AI 分析我的研究</button>
        </div>
        <div v-else-if="clarify.state === 'loading'" class="clarify-loading">
          <span class="mini-spinner"></span>
          <p>AI 正在分析你的研究... 调用大模型理解内容并生成针对性问题, 最长约 3 分钟</p>
        </div>
        <div v-else-if="clarify.state === 'error'" class="clarify-error">
          <p>⚠ 引导问题生成失败: {{ clarify.error }}</p>
          <button type="button" class="btn-clarify-run" @click="runClarify(false)" data-control="workflow:clarify-regen">重新生成引导问题</button>
        </div>
        <div v-else-if="!clarify.questions.length" class="clarify-done-empty">
          <!-- 2026-09-16: 0 问时原先只有一句否定, 后端算出的「总体分析」被丢掉了 ——
               用户看不到"系统到底怎么看我的方案"。现在把它显示出来。 -->
          <p v-if="clarifyAnalysis" class="cq-analysis">{{ clarifyAnalysis }}</p>
          <p>AI 未发现需要补充的引导问题。</p>
          <button type="button" class="btn-clarify-run" @click="runClarify(false)" data-control="workflow:clarify-retry">重新分析</button>
        </div>
        <div v-else class="clarify-list">
          <!-- 总体分析: 有就问显示在问题列表前面(它是这批问题的由来) -->
          <p v-if="clarifyAnalysis" class="cq-analysis">{{ clarifyAnalysis }}</p>
          <div v-for="q in clarify.questions" :key="q.id" class="clarify-item">
            <div class="cq-head">
              <span class="cq-cat" :class="catColor(q.category)">{{ catLabel(q.category) }}</span>
              <span v-if="q.importance === '高'" class="cq-imp">核心问题</span>
            </div>
            <p class="cq-question">{{ q.question }}</p>
            <p class="cq-guidance">{{ q.guidance }}</p>
            <textarea v-model="q.answer" class="cq-input" rows="2" placeholder="你的回答…" @input="setAnswer(q, ($event.target as HTMLTextAreaElement).value)"></textarea>
          </div>
          <!-- 第二轮追问(闭源: 答完一轮可再问一轮, 集中补齐仍模糊的点) -->
          <div class="clarify-next">
            <button
              type="button" class="btn-clarify-run"
              :disabled="clarifyRound >= 2"
              data-control="workflow:clarify-next-round"
              @click="runClarify(true)"
            >{{ clarifyRound >= 2 ? "追问已达上限" : (clarifyRound === 0 ? "基于我的回答再问一轮" : `再追加一轮追问（已 ${clarifyRound} 轮）`) }}</button>
            <span class="clarify-next-hint">回答后自动纳入科研架构分析</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 底部操作(闭源: 主按钮在左 flex-1, 返回在右) -->
    <div class="wf-actions">
      <button
        type="button"
        class="btn-primary"
        :disabled="!canSubmit"
        data-control="workflow:submit-analysis"
        @click="submitAnalysis"
      >开始思考科研架构</button>
      <button type="button" class="btn-back" data-control="workflow:back" @click="router.push('/workflow')">返回</button>
    </div>

    <!-- V419b: 删除当前项目。
         在这之前**全站没有任何删项目入口**(写作舱/导航/设置都没有), 而后端 DELETE 路由
         2026-09-21 才补上(软删 status='deleted')。入口放这一页是因为它是"项目起点",
         用户要丢弃一个项目时最自然的落点就是回到这里。
         文案写的是**软删的真实语义**: 不删数据、不再出现在列表里、历史仍可按 id 直查。 -->
    <div class="proj-danger">
      <button
        type="button"
        class="btn-danger-ghost"
        :disabled="!store.taskId || deleting"
        data-control="workflow:delete-project"
        @click="deleteCurrentProject"
      >{{ deleting ? "删除中…" : "删除当前项目" }}</button>
      <span class="pd-hint">从项目列表移除(不删数据; 历史与版本仍可按 id 直查)</span>
    </div>
  </div>
</template>

<style scoped>

.workflow-page { width: 100%; box-sizing: border-box; }
.wf-head { margin-bottom: 32px; }
.wf-h1 { margin: 0; font-size: 24px; font-weight: 700; color: #E8EEF7; }
.wf-sub { margin: 4px 0 0; font-size: 14px; color: #8B9BB1; }
/* 闭源各卡之间是 `space-y-6`(24px), 卡内 `p-5`(20px) —— 我方原 14px / 16px18px */
.wf-card {
  background: #11192C;
  border: 1px solid #222F44;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 24px;
}
.wf-label { display: flex; align-items: center; gap: 4px; font-size: 14px; font-weight: 600; color: #E8EEF7; margin-bottom: 8px; }
.req-star { color: #dc2626; }
.wf-input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid #46587A;
  border-radius: 8px;
  font-size: 13.5px;
  background: #11192C;
  outline: none;
}
.wf-input:focus, .wf-textarea:focus { border-color: #E67E7E; box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.12); }
.wf-textarea {
  width: 100%; box-sizing: border-box; padding: 9px 12px;
  border: 1px solid #46587A; border-radius: 8px;
  font-size: 13.5px; font-family: inherit; background: #11192C; outline: none;
  resize: none; line-height: 1.6;
}
.opt-tag { font-weight: 400; font-size: 12px; color: #7A8AA0; }
/* 主题 + 字数同行(闭源: 主题 flex-1 自适应, 字数固定 144px) */
.topic-row { display: flex; align-items: flex-start; gap: 12px; }
.topic-main { flex: 1; min-width: 0; }
.topic-wc { width: 144px; flex-shrink: 0; }
.wf-note { margin: 6px 0 0; font-size: 11.5px; color: #8B9BB1; line-height: 1.5; }
/* V420: 固定 3 列 → 自适应(窄屏自动塌) */
.method-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
.src-list { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.src-item {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  background: #11192C; border: 1px solid #222F44; border-radius: 8px;
  color: #DCE6F2; font-size: 13px; cursor: pointer; text-align: left;
}
.src-item.selected { border-color: #2563eb; background: #14213D; }
.src-check { width: 14px; color: #5FD0B4; font-weight: 700; }
.src-name { flex: 1; }
.src-count { font-size: 11.5px; color: #8B9BB1; }
/* E2 自动识别提示 */
.auto-detect-note {
  margin: 6px 0 0; font-size: 12px; color: #E8B54A; background: #11192C;
  border: 1px dashed #C9A23C; border-radius: 7px; padding: 6px 10px;
}

.method-card {
  padding: 14px;
  border: 2px solid #1A2333;
  border-radius: 12px;
  background: #11192C;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
}
.method-card strong { font-size: 14px; color: #E8EEF7; }
.method-card small { font-size: 11.5px; color: #8B9BB1; }
.method-card.selected { border-color: #dc2626; background: #2A1C1C; box-shadow: 0 1px 4px rgba(220, 38, 38, 0.1); }
.drop-zone {
  border: 2px dashed #46587A;
  border-radius: 10px;
  padding: 22px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
}
.drop-zone.dragover { border-color: #dc2626; background: #2A1C1C; }
.drop-zone p { margin: 0; font-size: 13px; color: #8B9BB1; }
.drop-zone .drop-line { color: #B9C6D8; }
.drop-zone .drop-sub { margin-top: 4px; font-size: 11.5px; color: #7A8AA0; }
.file-list { margin-top: 8px; display: flex; flex-direction: column; gap: 5px; }
.file-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border: 1px solid #222F44; border-radius: 7px; font-size: 12.5px;
}
.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #DCE6F2; }
.file-size { color: #7A8AA0; font-size: 11px; }
.file-status.ok { color: #5FD0B4; font-size: 11.5px; }
.file-remove { border: 0; background: none; color: #dc2626; font-size: 12px; cursor: pointer; }
/* 引导提问: 折叠头 + 展开体(闭源是手风琴, 默认收起) */
.clarify-card { padding: 0; overflow: hidden; }
.clarify-head {
  width: 100%; display: flex; align-items: center; justify-content: space-between;
  padding: 13px 18px; background: #0E1729; border: 0; cursor: pointer;
  color: #DCE6F2; font-size: 13.5px; font-weight: 500;
}
.clarify-head:hover { background: #1A2333; }
.ch-left { display: flex; align-items: center; gap: 8px; }
.ch-title { font-weight: 500; }
.ch-arrow { color: #8B9BB1; transition: transform 0.18s; }
.ch-arrow.open { transform: rotate(180deg); }
.clarify-body { padding: 4px 18px 16px; }
.clarify-idle, .clarify-loading, .clarify-error, .clarify-done-empty { text-align: center; padding: 14px 0; }
.clarify-idle p, .clarify-loading p, .clarify-error p, .clarify-done-empty p { font-size: 12px; color: #8B9BB1; margin: 8px 0 0; }
.clarify-error p { color: #dc2626; }
/* 生成引导问题的主按钮(闭源红底实心, 与页面其它主行动一致) */
.btn-clarify-run {
  padding: 9px 22px; border: 0; border-radius: 8px;
  background: #dc2626; color: #F1F5F9; font-size: 13px; font-weight: 600; cursor: pointer;
}
.btn-clarify-run:hover { background: #b91c1c; }
.btn-secondary {
  padding: 7px 16px;
  border: 1px solid #222F44;
  border-radius: 8px;
  background: #11192C;
  color: #DCE6F2;
  font-size: 13px;
  cursor: pointer;
}
.mini-spinner {
  display: inline-block;
  width: 18px; height: 18px;
  border: 2px solid #222F44; border-top-color: #dc2626;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.clarify-list { display: flex; flex-direction: column; gap: 10px; }
.clarify-item { border: 1px solid #222F44; border-radius: 10px; padding: 12px; }
.cq-head { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.cq-cat {
  font-size: 10.5px; padding: 2px 9px; border-radius: 9px;
  background: #1E2A48; color: #8BA4F0;
}
/* 8 分类配色(闭源 P 映射: blue/purple/green/orange/cyan/pink/indigo/gray) —— 深色化后的等价色 */
.cq-cat.cat-blue { background: #16243F; color: #6FA8F5; }
.cq-cat.cat-purple { background: #241A3A; color: #B08CF0; }
.cq-cat.cat-green { background: #14291F; color: #5FD09A; }
.cq-cat.cat-orange { background: #33240F; color: #E8A84A; }
.cq-cat.cat-cyan { background: #0F2A2E; color: #4FC9D6; }
.cq-cat.cat-pink { background: #33172A; color: #EF7FBF; }
.cq-cat.cat-indigo { background: #1B1F42; color: #8C93F0; }
.cq-cat.cat-gray { background: #1A2333; color: #A8B4C4; }
.cq-imp { font-size: 10px; padding: 2px 7px; background: #3A2323; color: #dc2626; border-radius: 8px; font-weight: 600; }
.cq-question { margin: 0 0 4px; font-size: 13.5px; color: #E8EEF7; font-weight: 600; }
.cq-guidance { margin: 0 0 8px; font-size: 12px; color: #8B9BB1; }
/* 总体分析(后端每次都会回, 原先被丢弃) —— 0 问时它是用户唯一能看到的结论 */
.cq-analysis {
  margin: 0 0 10px; padding: 9px 12px; font-size: 12.5px; line-height: 1.7;
  background: #16243F; border: 1px solid #24406B; border-radius: 8px; color: #A8C4E8;
}
/* 第二轮追加入口 */
.clarify-next { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.clarify-next-hint { font-size: 11.5px; color: #7A8AA0; }
.btn-clarify-run:disabled { opacity: .5; cursor: not-allowed; }
.cq-input {
  width: 100%; box-sizing: border-box;
  padding: 7px 10px; border: 1px solid #222F44; border-radius: 7px;
  font-size: 12.5px; font-family: inherit; resize: vertical;
}
/* 动作行。闭源 `pt-4 flex gap-3`(16px 上边距 + 12px 间距, **无**分隔线 —— 这一页是
   "开始思考科研架构 / 返回" 那对, 与 sections/materials 的 pt-6 + border-t 不同)。
   原值 margin-top:6px 比闭源少 10px, 页面底部显得挤。 */
.wf-actions { display: flex; gap: 12px; margin-top: 16px; }
/* 主按钮占满剩余宽度(闭源 flex-1), 返回按钮固定宽在右 */
.wf-actions .btn-primary { flex: 1; }
/* 闭源按钮是 `px-6 py-3 text-sm` = 24/12 内边距 + **固定 20px 行高** + 边框 = 46px 高。
   我方原 10px 内边距 + 13px×1.2 行高 = 38px, 比闭源矮 8px。行高写死 20px 才与闭源等高。 */
.wf-actions .btn-primary,
.wf-actions .btn-back { padding: 12px 24px; line-height: 20px; }
/* V419b 删除项目: 与主操作行**分开**放在页面底部 —— 破坏性动作不该和"开始思考科研架构"挨着 */
.proj-danger { display: flex; align-items: center; gap: 10px; margin-top: 28px; padding-top: 16px; border-top: 1px solid #2A1C1C; }
.btn-danger-ghost {
  padding: 7px 16px; border: 1px solid #7f1d1d; border-radius: 8px;
  background: transparent; color: #E88A8A; font-size: 12.5px; cursor: pointer;
}
.btn-danger-ghost:hover:not(:disabled) { background: #2A1C1C; }
.btn-danger-ghost:disabled { opacity: 0.45; cursor: not-allowed; }
.pd-hint { font-size: 11.5px; color: #7A8AA0; }
.btn-back {
  padding: 10px 22px;
  border: 1px solid #222F44;
  border-radius: 9px;
  background: #11192C;
  color: #8B9BB1;
  font-size: 14px;
  cursor: pointer;
}
.btn-primary {
  padding: 10px 26px;
  border: 0;
  border-radius: 9px;
  background: #dc2626;
  color: #F1F5F9;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:hover { background: #E06B6B; }
.btn-primary:disabled { background: #46587A; cursor: not-allowed; }
.sr-only { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
</style>
