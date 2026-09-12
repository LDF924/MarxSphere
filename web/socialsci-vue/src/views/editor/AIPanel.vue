<script setup lang="ts">
/**
 * AIPanel — 还原自闭源 EditorView E:18962-19952(scope data-v-e0631cb6)
 * 6 tab: check(全文检查 4 动作)/local(选区修改 5 动作)/title(题名摘要 3)/citation(引用格式 2)
 *       /format(4 预设持久化 ade-format-preset)/chart(5 类型 → /ai/chart → ChartRenderer → ai-insert-chart)
 * 动作按钮 → 统一 assistDocument(action...) job 流; 全文 ≤60000 字; 选区上下文前后各 4000 字
 * 模型选择: 学术写作角色(editor)独立于推理链, 面板顶部下拉即时切换
 * 面板宽度拖拽: mousedown → CSS var --ade-ai-panel-width(clamp 340-720) → localStorage ade-ai-panel-width
 */
import { ref, computed, onMounted, onUnmounted } from "vue";
import type { Editor } from "@tiptap/vue-3";
import { useEditorAiStore } from "./stores/editorAi";
import { useDocumentStore } from "./stores/document";
import { renderMdWithLatex, loadKatex } from "@/shared/markdown";
import { toast } from "@/shared/ui";
import ChartRenderer from "./ChartRenderer.vue";
import { FORMAT_PRESETS, loadPresetKey, savePresetKey, presetToCssVars, loadAiPanelWidth, saveAiPanelWidth, AI_PANEL_MIN, AI_PANEL_MAX } from "./presets";
import { q, authedBlob } from "@/shared/api";
import { EVT } from "@/shared/constants";

const props = defineProps<{ editor: Editor | null }>();

const store = useEditorAiStore();
const docStore = useDocumentStore();

// ── tab 与动作表(闭源文案 1:1) ──
const CHECK_ACTIONS = [
  { id: "logic_check", title: "全文逻辑检查", desc: "检查全文逻辑连贯性、论证是否完整" },
  { id: "section_coherence_check", title: "章节衔接检查", desc: "检查章节之间衔接是否自然顺畅" },
  { id: "variable_method_conclusion_check", title: "变量-方法-结论一致性", desc: "核对变量、方法、结论的一致性" },
  { id: "submission_check", title: "投稿前检查", desc: "按目标期刊做投稿前综合检查" }
];
const LOCAL_ACTIONS = [
  { id: "academic_polish", title: "学术润色", desc: "提升学术表达与用词准确性" },
  { id: "reduce_ai_tone", title: "减少模板化表达", desc: "去除 AI 痕迹, 让行文更自然" },
  { id: "compress_redundancy", title: "压缩冗余", desc: "删减重复啰嗦内容" },
  { id: "expand_argument", title: "扩展论证", desc: "补充论证细节与论据" },
  { id: "proofread", title: "校对标点", desc: "修正标点与错别字" }
];
const TITLE_ACTIONS = [
  { id: "title_optimize", title: "优化论文标题", desc: "生成 5 个候选标题" },
  { id: "abstract_optimize", title: "优化摘要", desc: "改进摘要结构与表达" },
  { id: "keywords_generate", title: "提取关键词", desc: "生成关键词建议" }
];
const CITATION_ACTIONS = [
  { id: "citation_consistency_check", title: "引用一致性检查", desc: "检查文中引用的格式一致性" },
  { id: "format_check", title: "格式与语言检查", desc: "不判断文献真实存在与否" }
];
const CHART_TYPES = [
  { id: "mermaid_flowchart", label: "流程图" },
  { id: "mermaid_mindmap", label: "思维导图" },
  { id: "echarts_bar", label: "柱状图" },
  { id: "echarts_line", label: "折线图" },
  { id: "echarts_pie", label: "饼图" }
];

const activeTab = computed({
  get: () => store.activeTab,
  set: (v: string) => {
    store.activeTab = v;
    resultText.value = "";
    pendingActionTitle.value = "";
    store.resetJobState();
  }
});

// 结果区状态
const resultText = ref("");
const resultTitle = ref("检查结果");
const resultError = ref(false);
const pendingActionTitle = ref("");
const renderedHtml = computed(() => (resultText.value ? renderMdWithLatex(resultText.value) : ""));

// chart tab 状态
const chartDesc = ref("");
const chartType = ref("echarts_bar");
const chartCode = ref("");
const chartPreviewType = ref("");

// format tab
const presetKey = ref(loadPresetKey());
const activePreset = computed(() => FORMAT_PRESETS.find((p) => p.key === presetKey.value) ?? FORMAT_PRESETS[0]);
function applyPreset(key: string) {
  presetKey.value = key;
  savePresetKey(key);
  const styleEl = document.documentElement;
  const vars = presetToCssVars(activePreset.value);
  for (const [k, v] of Object.entries(vars)) styleEl.style.setProperty(k, v);
  toast(`已切换模板: ${activePreset.value.name}`, "success");
}

// 选区上下文
const selectionCount = ref(0);
let selectionOff: (() => void) | null = null;

function trackSelection() {
  selectionOff?.();
  const ed = props.editor;
  if (!ed) return;
  const { from, to } = ed.state.selection;
  selectionCount.value = from === to ? 0 : ed.state.doc.textBetween(from, to, " ").replace(/\s/g, "").length;
  const fn = () => {
    const { from: f, to: t } = ed.state.selection;
    selectionCount.value = f === t ? 0 : ed.state.doc.textBetween(f, t, " ").replace(/\s/g, "").length;
  };
  ed.on("selectionUpdate", fn);
  selectionOff = () => ed.off("selectionUpdate", fn);
}

// ── 动作执行 ──
function selectionText(): string {
  const ed = props.editor;
  if (!ed) return "";
  const { from, to } = ed.state.selection;
  if (from === to) return "";
  return ed.state.doc.textBetween(from, to, "\n");
}

// 正文全文(闭源 j.value: currentContent 去标签; 一律 ≤60000 字) — 与"是否已打开文档"无关
const docText = computed(() => plainTextOf(docStore.currentContent));

function plainTextOf(raw: unknown): string {
  if (!raw) return "";
  let s = typeof raw === "string" ? raw : "";
  // Tiptap 存的是 JSON 串 → 抽 text 字段拼回纯文本
  if (s.trim().startsWith("{")) {
    try {
      const json = JSON.parse(s) as { content?: unknown };
      const out: string[] = [];
      const walk = (n: any) => {
        if (!n || typeof n !== "object") return;
        if (typeof n.text === "string") out.push(n.text);
        if (Array.isArray(n.content)) n.content.forEach(walk);
      };
      walk(json);
      s = out.join("\n");
    } catch {
      /* 非 JSON → 按纯文本处理 */
    }
  } else {
    s = s.replace(/<[^>]+>/g, "");
  }
  return s.slice(0, 60000);
}

// ── 动作 → 后端 ai/jobs{action, mode}; mode 为后端真实执行分支, 一按钮一动作 ──
const ACTION_MAP: Record<string, { action: string; mode: string }> = {
  // check(全文检查 4 — 后端 CHECK_MODES 四套独立 prompt)
  logic_check: { action: "check", mode: "logic" },
  section_coherence_check: { action: "check", mode: "cohesion" },
  variable_method_conclusion_check: { action: "check", mode: "consistency" },
  submission_check: { action: "check", mode: "submission" },
  // local(选区修改 5 — 后端 MODE_PROMPT 同名 RewriteMode)
  academic_polish: { action: "rewrite", mode: "polish" },
  reduce_ai_tone: { action: "rewrite", mode: "de-template" },
  compress_redundancy: { action: "rewrite", mode: "condense" },
  expand_argument: { action: "rewrite", mode: "expand" },
  proofread: { action: "rewrite", mode: "proofread" },
  // title(题名摘要 3 — 后端 TITLE_PROMPT 三套独立 prompt, 按 mode 只返回该部分)
  title_optimize: { action: "title", mode: "title" },
  abstract_optimize: { action: "title", mode: "abstract" },
  keywords_generate: { action: "title", mode: "keywords" },
  // citation(引用格式 2 — 后端 CITATION_KIND 两套独立 prompt)
  citation_consistency_check: { action: "format_refs", mode: "consistency" },
  format_check: { action: "format_refs", mode: "format" }
};

async function runAction(tab: string, action: { id: string; title: string }) {
  const ed = props.editor;
  const mapped = ACTION_MAP[action.id] ?? { action: action.id, mode: "" };
  // 闭源语义: 门控只看"有无正文/选区"与"是否忙碌", 不要求先打开文档
  if (!docText.value.trim() || store.isLoading) return;
  pendingActionTitle.value = action.title;
  resultError.value = false;
  resultText.value = "";
  store.resetJobState();
  const docId = docStore.currentDocument?.id;
  try {
    if (tab === "local") {
      const sel = selectionText();
      if (!sel) {
        toast("请先在正文中选中需要处理的文字", "warning");
        return;
      }
      // 上下文 = 选区前后各 4000 字(闭源 L(): "Context before selection: … Context after selection: …")
      const ctx = buildContext(ed);
      const out = await store.assistDocument(mapped.action, sel, ctx, docId, mapped.mode);
      resultTitle.value = action.title;
      resultText.value = out;
    } else {
      const out = await store.assistDocument(mapped.action, docText.value, "", docId, mapped.mode);
      resultTitle.value = action.title;
      resultText.value = out;
    }
  } catch (e) {
    resultError.value = true;
    resultText.value = `执行失败: ${(e as Error).message}`;
  } finally {
    pendingActionTitle.value = "";
  }
}

/** 选区前后各 4000 字上下文(闭源 L() 同格式) */
function buildContext(ed: Editor | null): string {
  if (!ed) return "";
  const U = 4000;
  const size = ed.state.doc.content.size;
  const { from, to } = ed.state.selection;
  const before = ed.state.doc.textBetween(Math.max(0, from - U), from, " ", " ").trim();
  const after = ed.state.doc.textBetween(to, Math.min(size, to + U), " ", " ").trim();
  return [before ? `Context before selection: ${before}` : "", after ? `Context after selection: ${after}` : ""].filter(Boolean).join(" ");
}

function disabledReason(tab: string): string {
  if (store.isLoading) return store.streamingContent ? "正在生成…" : "处理中…";
  // 选区修改: 需要选中文字; 其余: 需要正文非空(与"是否已打开文档"无关)
  if (tab === "local" && !selectionCount.value) return "请先在正文选中文字";
  if (!docText.value.trim()) return "正文为空, 请先输入或打开文档";
  return "";
}

// ── 模型选择(学术写作角色, 独立于推理链) ──
function onModelChange(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  const prev = store.currentModel;
  void store.setModel(id).then((r) => {
    if (r.ok) {
      toast(`已切换学术写作模型: ${id}`, "success");
    } else {
      toast(r.message ? `切换失败: ${r.message}` : "模型切换失败", "error");
      store.currentModel = prev;
    }
  });
}

// ── 结果操作(复制/替换选中/插入光标) ──
async function copyResult() {
  try {
    await navigator.clipboard.writeText(resultText.value);
    toast("已复制", "success");
  } catch {
    toast("复制失败", "error");
  }
}
function replaceSelection() {
  if (!props.editor || !resultText.value) return;
  const ed = props.editor;
  const { from, to } = ed.state.selection;
  if (from === to) {
    ed.chain().focus().insertContent(resultText.value).run();
  } else {
    ed.chain().focus().insertContentAt({ from, to }, resultText.value).run();
  }
  toast("已替换选中内容", "success");
}
function insertAtCursor() {
  if (!props.editor || !resultText.value) return;
  props.editor.chain().focus().insertContent(resultText.value).run();
  toast("已插入到光标处", "success");
}

// ── 图表生成 ──
// 数据来源: none(仅示意) / empirical(统一分析台当前数据集) / stats(已保存统计结果) / paste(手动粘贴) / workshop(工坊已有图)
type ChartSource = "none" | "empirical" | "stats" | "paste" | "workshop";
const chartSource = ref<ChartSource>("none");
const chartDataset = ref<{ csv: string; columnOrder: string[]; fileName: string } | null>(null);
const chartPaste = ref("");
// 统计结果源: 下拉列的是**统计任务**(stats_jobs), 选中后回查该任务的原始数据集
const chartArtifacts = ref<Array<{ id: string; title: string; method?: string; created_at?: string }>>([]);
const chartArtifactId = ref("");
const statsDataset = ref<{ csv: string; columnOrder: string[]; fileName: string; rowCount: number; truncated: boolean } | null>(null);
const statsDatasetLoading = ref(false);
const statsDatasetError = ref("");
// 工坊(成果可视化工坊)已有图: 直接复用, 不需重新出图
const workshopArtifacts = ref<Array<{ id: string; png_path: string; svg_editable_path?: string; prompt?: string; version?: number; created_at?: string }>>([]);
const workshopArtifactId = ref("");
// 渲染产物: matplotlib 出的图走文件(URL), mermaid 走代码渲染
// ⚠ /api/viz/files 需 JWT, 而 <img src> 发不出 Authorization 头(命中缓存才会"恰好显示") →
//   统一用带鉴权的 fetch 取 blob 再转 object URL(与 VizView 的 blobifyPng 同约定)
const chartImageUrl = ref("");
// SVG 相对路径与 PNG 持久化路径(下载/插图时再带鉴权取)
const chartSvgRel = ref("");
const chartPersistPath = ref("");
let chartBlobUrl = "";

function revokeChartBlob() {
  if (chartBlobUrl) { URL.revokeObjectURL(chartBlobUrl); chartBlobUrl = ""; }
}

async function loadChartImage(relPath: string): Promise<boolean> {
  revokeChartBlob();
  try {
    const blob = await authedBlob(`/viz/files/${relPath}`);
    chartBlobUrl = URL.createObjectURL(blob);
    chartImageUrl.value = chartBlobUrl;
    return true;
  } catch {
    chartImageUrl.value = "";
    return false;
  }
}

function onDataset(e: Event) {
  const d = (e as CustomEvent).detail as { csv?: string; columnOrder?: string[]; fileName?: string } | undefined;
  if (!d?.csv || !d.columnOrder?.length) return;
  chartDataset.value = { csv: d.csv, columnOrder: d.columnOrder, fileName: d.fileName ?? "实证数据集" };
  // 自动切到分析台数据(用户已有数据时不应默认无数据)
  if (chartSource.value === "none") chartSource.value = "empirical";
}

async function loadChartArtifacts() {
  try {
    const r = await q<{ jobs?: Array<{ id: string; tool?: string; method?: string; status?: string; created_at?: string }> }>(
      `/statistics-jobs?limit=20`);
    // 只列跑完的任务(未完成的没有可复用数据)
    chartArtifacts.value = (r?.jobs ?? [])
      .filter((j) => j?.id && (!j.status || j.status === "completed"))
      .map((j) => ({ id: j.id, title: j.method ?? j.tool ?? "统计分析", method: j.tool ?? "", created_at: j.created_at }));
  } catch {
    chartArtifacts.value = [];
  }
}

async function loadWorkshopArtifacts() {
  try {
    const r = await q<{ artifacts?: Array<{ id: string; png_path: string; svg_editable_path?: string; prompt?: string; version?: number; created_at?: string }> }>(
      `/viz/artifacts`);
    workshopArtifacts.value = (r?.artifacts ?? []).filter((a) => a?.png_path);
  } catch {
    workshopArtifacts.value = [];
  }
}

/** 选中工坊产物 → 直接作为预览图(不重新出图) */
async function useWorkshopArtifact() {
  const a = workshopArtifacts.value.find((x) => x.id === workshopArtifactId.value);
  if (!a) return;
  await loadChartImage(a.png_path);
  chartSvgRel.value = a.svg_editable_path ?? "";
  chartPersistPath.value = `/api/viz/files/${a.png_path}`;
  chartCode.value = a.prompt ?? "";
  chartPreviewType.value = "workshop";
}

/** 下载 SVG: 带鉴权取 blob 后本地保存(a 标签直链发不出 Authorization) */
async function downloadSvg() {
  if (!chartSvgRel.value) return;
  try {
    const blob = await authedBlob(`/viz/files/${chartSvgRel.value}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "chart.svg";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    toast(`下载失败: ${(e as Error).message}`, "error");
  }
}

/** 当前生效的数据: csv + 列名(供后端 prompt 与渲染) */
function activeChartData(): { csv: string; columnOrder: string[] } | null {
  if (chartSource.value === "empirical" && chartDataset.value) {
    return { csv: chartDataset.value.csv, columnOrder: chartDataset.value.columnOrder };
  }
  if (chartSource.value === "stats" && statsDataset.value) {
    return { csv: statsDataset.value.csv, columnOrder: statsDataset.value.columnOrder };
  }
  if (chartSource.value === "paste" && chartPaste.value.trim()) {
    const lines = chartPaste.value.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return null;
    const cols = lines[0].split(",").map((c) => c.trim()).filter(Boolean);
    return cols.length ? { csv: chartPaste.value, columnOrder: cols } : null;
  }
  return null;
}

/** 统计结果(仅取表头+样例行) → CSV 文本 */
function statsToCsv(ds: { columnOrder: string[]; sampleRows: unknown[][] }): string {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    ds.columnOrder.map(esc).join(","),
    ...ds.sampleRows.map((r) => (r ?? []).map(esc).join(",")),
  ].join("\n");
}

/** 选中统计结果 → 回查该任务的原始数据集(失败即清空并给出明确原因, 不静默按无数据出图) */
async function loadStatsDataset(jobId: string) {
  statsDataset.value = null;
  statsDatasetError.value = "";
  if (!jobId) return;
  statsDatasetLoading.value = true;
  try {
    const r = await q<{ dataset?: { fileName?: string; columnOrder: string[]; rowCount: number; truncated?: boolean; sampleRows: unknown[][] } }>(
      `/statistics-jobs/${jobId}/dataset`);
    const ds = r?.dataset;
    if (!ds?.columnOrder?.length) {
      statsDatasetError.value = "该统计结果没有可用数据";
      return;
    }
    statsDataset.value = {
      csv: statsToCsv(ds),
      columnOrder: ds.columnOrder,
      fileName: ds.fileName ?? "分析数据",
      rowCount: ds.rowCount,
      truncated: Boolean(ds.truncated),
    };
  } catch (e) {
    statsDatasetError.value = (e as Error).message || "原始数据集不可用";
  } finally {
    statsDatasetLoading.value = false;
  }
}

async function generateChart() {
  // 工坊模式: 已直接选中现成产物, 无需重新出图
  if (chartSource.value === "workshop") {
    if (!workshopArtifactId.value) { toast("请先选择一张工坊产出的图", "warning"); return; }
    useWorkshopArtifact();
    toast("已载入工坊图表, 可直接插入正文", "success");
    return;
  }
  if (!chartDesc.value.trim()) {
    toast("请描述图表需求", "warning");
    return;
  }
  // 选了数据源但没数据 → 明确拦截(不再让后端 FileNotFoundError)
  if (chartSource.value === "empirical" && !chartDataset.value) {
    toast("尚未从统一分析台同步到数据集, 请先在实证工作台载入数据", "warning");
    return;
  }
  if (chartSource.value === "paste" && !activeChartData()) {
    toast("粘贴的 CSV 至少需要表头 + 一行数据", "warning");
    return;
  }
  if (chartSource.value === "stats" && !chartArtifactId.value) {
    toast("请先选择一条统计结果", "warning");
    return;
  }
  if (chartSource.value === "stats" && !statsDataset.value) {
    toast(statsDatasetLoading.value ? "正在读取原始数据集…" : (statsDatasetError.value || "该统计结果的原始数据不可用"), "warning");
    return;
  }
  store.resetJobState();
  chartCode.value = "";
  chartPreviewType.value = "";
  revokeChartBlob();
  chartImageUrl.value = "";
  chartSvgRel.value = "";
  try {
    const data = activeChartData();
    const r = await q<{
      code?: string; chartType?: string; ok?: boolean; error?: string;
      pngRel?: string; svgRel?: string; dataUsed?: boolean;
    }>(`/editor/v1/chart-code`, {
      method: "POST",
      body: {
        description: chartDesc.value,
        chart_type: chartType.value,
        ...(data ? { csv: data.csv, columnOrder: data.columnOrder } : {})
      }
    });
    const code = r?.code ?? "";
    if (!code) {
      toast("图表代码生成失败", "error");
      return;
    }
    chartCode.value = code;
    chartPreviewType.value = chartType.value;
    // matplotlib 产物: 带鉴权取 blob 显示, 但文档里存**相对路径**(blob URL 会话结束即失效)
    if (r?.pngRel) {
      await loadChartImage(r.pngRel);
      chartSvgRel.value = r.svgRel ?? "";
      chartPersistPath.value = `/api/viz/files/${r.pngRel}`;
    }
    toast(r?.dataUsed ? "图表已生成(使用真实数据)" : "图表已生成(示意数据)", "success");
  } catch (e) {
    toast(`生成失败: ${(e as Error).message}`, "error");
  }
}

async function insertChart() {
  // 文档里持久化的是相对路径(浏览器会自动带 cookie 同源请求; 卡片预览另用 blob)
  const persist = chartPersistPath.value;
  if (persist) {
    const ed = props.editor;
    if (ed) {
      const chain = ed.chain().focus() as unknown as { setImage?: (a: { src: string }) => { run: () => boolean } };
      const op = chain.setImage?.({ src: persist });
      if (op && op.run()) {
        toast("图表已插入正文", "success");
        return;
      }
      ed.chain().focus().insertContent(`![科研图表](${persist})`).run();
      toast("图表已插入正文", "success");
      return;
    }
    toast("编辑器未就绪", "error");
    return;
  }
  if (!chartCode.value) return;
  window.dispatchEvent(new CustomEvent(EVT.aiInsertChart, { detail: { code: chartCode.value, type: chartType.value } }));
  toast("图表已插入正文", "success");
}

// ── 面板宽度拖拽(闭源 E:19366-19392) ──
const panelWidth = ref(loadAiPanelWidth());
let dragging = false;
function onResizeDown(e: MouseEvent) {
  dragging = true;
  const startX = e.clientX;
  const startW = panelWidth.value;
  const move = (ev: MouseEvent) => {
    const w = startW + (startX - ev.clientX); // 左侧拖拽: 左移加宽
    panelWidth.value = Math.min(AI_PANEL_MAX, Math.max(AI_PANEL_MIN, w));
  };
  const up = () => {
    dragging = false;
    saveAiPanelWidth(panelWidth.value);
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

onMounted(() => {
  void loadKatex();
  trackSelection();
  void store.loadModels();
  window.addEventListener(EVT.empiricalDataset, onDataset as unknown as EventListener);
  void loadChartArtifacts();
  void loadWorkshopArtifacts();
});
onUnmounted(() => {
  selectionOff?.();
  revokeChartBlob();
  window.removeEventListener(EVT.empiricalDataset, onDataset as unknown as EventListener);
});
</script>

<template>
  <aside class="ade-ai-panel" :style="{ width: panelWidth + 'px' }">
    <div class="ade-ai-panel__resize-handle" @mousedown="onResizeDown"></div>
    <div class="ade-ai-panel__header">
      <div>
        <p class="ade-ai-panel__eyebrow">AI 辅助</p>
        <h3>学术助手</h3>
      </div>
      <button class="ade-ai-panel__close" @click="store.panelOpen = false">×</button>
    </div>
    <div class="ade-ai-panel__tabs">
      <button v-for="tab in [['check', '全文检查'], ['local', '选区修改'], ['title', '题名摘要'], ['citation', '引用格式'], ['format', '格式模板'], ['chart', '图表']]" :key="tab[0]" class="ade-ai-panel__tab" :class="{ 'ade-ai-panel__tab--active': activeTab === tab[0] }" @click="activeTab = tab[0]">
        {{ tab[1] }}
      </button>
    </div>

    <!-- 模型选择(学术写作角色; 与推理链模型互不影响) -->
    <div class="ade-ai-panel__model">
      <label for="ade-ai-model">写作模型</label>
      <select
        id="ade-ai-model"
        class="ade-ai-panel__model-select"
        :value="store.currentModel"
        :disabled="store.modelBusy || !store.modelOptions.length"
        @change="onModelChange"
      >
        <option v-if="!store.modelOptions.length" :value="store.currentModel">{{ store.currentModel || "加载中…" }}</option>
        <option v-for="m in store.modelOptions" :key="m.id" :value="m.id">{{ m.label }}</option>
      </select>
    </div>

    <!-- check: 全文检查 -->
    <div v-if="activeTab === 'check'" class="ade-ai-panel__body">
      <div class="ade-ai-section-intro">
        <h4>全文检查</h4>
        <p>对整篇论文进行深度检查, 结果不会直接改动正文。将展示在下方。</p>
      </div>
      <div v-if="disabledReason('check')" class="ade-ai-panel__notice">{{ disabledReason('check') }}</div>
      <div class="ade-task-list">
        <button v-for="a in CHECK_ACTIONS" :key="a.id" class="ade-task-card" :disabled="!!disabledReason('check')" @click="runAction('check', a)">
          <span>{{ a.title }}</span>
          <small>{{ a.desc }}</small>
        </button>
      </div>
    </div>

    <!-- local: 选区修改 -->
    <div v-if="activeTab === 'local'" class="ade-ai-panel__body">
      <div class="ade-ai-section-intro">
        <h4>选区修改</h4>
        <p v-if="selectionCount">当前选区 {{ selectionCount }} 字</p>
        <p v-else>请先在正文中选中要处理的文字段落。</p>
      </div>
      <div v-if="disabledReason('local')" class="ade-ai-panel__notice">{{ disabledReason('local') }}</div>
      <div class="ade-task-list">
        <button v-for="a in LOCAL_ACTIONS" :key="a.id" class="ade-task-card" :disabled="!!disabledReason('local')" @click="runAction('local', a)">
          <span>{{ a.title }}</span>
          <small>{{ a.desc }}</small>
        </button>
      </div>
    </div>

    <!-- title: 题名摘要 -->
    <div v-if="activeTab === 'title'" class="ade-ai-panel__body">
      <div class="ade-ai-section-intro">
        <h4>题名与摘要</h4>
        <p>基于全文生成标题候选、优化摘要或提取关键词。</p>
      </div>
      <div v-if="disabledReason('title')" class="ade-ai-panel__notice">{{ disabledReason('title') }}</div>
      <div class="ade-task-list">
        <button v-for="a in TITLE_ACTIONS" :key="a.id" class="ade-task-card" :disabled="!!disabledReason('title')" @click="runAction('title', a)">
          <span>{{ a.title }}</span>
          <small>{{ a.desc }}</small>
        </button>
      </div>
    </div>

    <!-- citation: 引用格式 -->
    <div v-if="activeTab === 'citation'" class="ade-ai-panel__body">
      <div class="ade-ai-section-intro">
        <h4>引用与语言</h4>
        <p>检查引用格式一致性与语言表达。不判断文献真实存在与否。</p>
      </div>
      <div v-if="disabledReason('citation')" class="ade-ai-panel__notice">{{ disabledReason('citation') }}</div>
      <div class="ade-task-list">
        <button v-for="a in CITATION_ACTIONS" :key="a.id" class="ade-task-card" :disabled="!!disabledReason('citation')" @click="runAction('citation', a)">
          <span>{{ a.title }}</span>
        </button>
      </div>
    </div>

    <!-- format: 格式模板 -->
    <div v-if="activeTab === 'format'" class="ade-ai-panel__body">
      <div class="ade-ai-section-intro">
        <h4>排版格式模板</h4>
        <p>选择论文排版模板, 即时生效于正文预览(不改变正文内容)。</p>
      </div>
      <div class="ade-format-template-list">
        <button v-for="p in FORMAT_PRESETS" :key="p.key" class="ade-format-template" :class="{ 'ade-format-template--active': presetKey === p.key }" @click="applyPreset(p.key)">
          <strong>{{ p.name }}</strong>
          <span>{{ p.docxFont }} · {{ p.docxFontSize }}pt · 行距{{ p.lineHeight }}</span>
        </button>
      </div>
      <div class="ade-format-template-summary">当前: {{ activePreset.name }}</div>
    </div>

    <!-- chart: 图表 -->
    <div v-if="activeTab === 'chart'" class="ade-ai-panel__body">
      <div class="ade-ai-section-intro">
        <h4>图表生成</h4>
        <p>选择数据来源并描述需求, AI 生成图表并预览, 可一键插入正文。</p>
      </div>
      <div class="ade-chart-form">
        <label class="ade-chart-source">
          <span>数据来源</span>
          <select v-model="chartSource" class="w-full rounded border border-[#2A3A55] px-2 py-1.5 text-xs">
            <option value="empirical">统一分析台数据{{ chartDataset ? ` (${chartDataset.columnOrder.length} 列)` : " (未同步)" }}</option>
            <option value="workshop">成果可视化工坊已有图{{ workshopArtifacts.length ? ` (${workshopArtifacts.length})` : "" }}</option>
            <option value="stats">已保存的统计结果{{ chartArtifacts.length ? ` (${chartArtifacts.length})` : "" }}</option>
            <option value="paste">手动粘贴 CSV</option>
            <option value="none">无数据(仅示意图结构)</option>
          </select>
        </label>
        <div v-if="chartSource === 'empirical'" class="ade-chart-hint">
          <template v-if="chartDataset">
            已同步: {{ chartDataset.fileName }} · {{ chartDataset.columnOrder.join(", ") }}
          </template>
          <template v-else>尚未同步 — 请先在「科研中心 → 实证研究」载入数据</template>
        </div>
        <div v-if="chartSource === 'workshop'" class="ade-chart-hint">
          <select v-model="workshopArtifactId" class="w-full rounded border border-[#2A3A55] px-2 py-1.5 text-xs" @change="useWorkshopArtifact">
            <option value="">{{ workshopArtifacts.length ? "选择一张工坊产出的图" : "工坊暂无产物 — 先去「成果可视化工坊」绘图" }}</option>
            <option v-for="a in workshopArtifacts" :key="a.id" :value="a.id">
              {{ (a.prompt || "科研图表").slice(0, 34) }}{{ a.version ? ` · v${a.version}` : "" }}
            </option>
          </select>
        </div>
        <div v-if="chartSource === 'stats'" class="ade-chart-hint">
          <select v-model="chartArtifactId" class="w-full rounded border border-[#2A3A55] px-2 py-1.5 text-xs" @change="loadStatsDataset(chartArtifactId)">
            <option value="">{{ chartArtifacts.length ? "选择一条已完成的统计结果" : "暂无已完成的统计任务 — 先去「实证研究」跑一次分析" }}</option>
            <option v-for="a in chartArtifacts" :key="a.id" :value="a.id">
              {{ a.title }}{{ a.created_at ? ` · ${a.created_at.slice(5, 16).replace("T", " ")}` : "" }}
            </option>
          </select>
          <template v-if="statsDatasetLoading">正在读取原始数据集…</template>
          <template v-else-if="statsDataset">
            已回查: {{ statsDataset.fileName }} · {{ statsDataset.columnOrder.length }} 列 · {{ statsDataset.rowCount }} 行{{ statsDataset.truncated ? "(仅取前 200 行用于出图)" : "" }}
          </template>
          <template v-else-if="statsDatasetError" style="color: #E8A33D">{{ statsDatasetError }}</template>
        </div>
        <textarea v-if="chartSource === 'paste'" v-model="chartPaste" rows="3" class="w-full rounded border border-[#2A3A55] px-2 py-1.5 text-xs" placeholder="粘贴 CSV(第一行为表头, 建议用英文列名):&#10;industry,y2020,y2024&#10;Mfg,100,180"></textarea>
        <select v-model="chartType" class="w-full rounded border border-[#2A3A55] px-2 py-1.5 text-xs">
          <option v-for="c in CHART_TYPES" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
        <textarea v-model="chartDesc" rows="3" class="w-full rounded border border-[#2A3A55] px-2 py-1.5 text-xs" placeholder="例如: 2020-2024 年五类数字经济细分产业增加值对比柱状图"></textarea>
        <button class="w-full rounded bg-red-600 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50" :disabled="store.isBusy" @click="generateChart">
          {{ store.isBusy ? "生成中…" : "生成图表" }}
        </button>
      </div>
      <div v-if="chartImageUrl || chartCode" class="ade-chart-preview">
        <img v-if="chartImageUrl" :src="chartImageUrl" alt="科研图表" class="ade-chart-preview__img" />
        <ChartRenderer v-else-if="chartCode.startsWith('graph') || chartCode.startsWith('mindmap') || chartCode.trim().startsWith('{')" :code="chartCode" :chart-type="chartPreviewType" />
        <div v-else class="ade-chart-preview__code">{{ chartCode }}</div>
        <a v-if="chartSvgRel" href="#" class="ade-chart-preview__svg" @click.prevent="downloadSvg">下载 SVG(矢量可编辑)</a>
        <button class="w-full rounded border border-[#4D84CB] py-1.5 text-xs font-semibold text-[#6FA6E8] hover:bg-[#1E2A48]" @click="insertChart">插入到正文</button>
      </div>
    </div>

    <!-- 结果区(全 tab 共用) -->
    <div v-if="resultText || store.isBusy || pendingActionTitle" class="ade-result-card" :class="{ 'ade-result-card--error': resultError }">
      <div class="ade-result-card__header">
        <strong style="font-size: 12px; color: #E8EEF7">{{ store.isBusy && store.streamingContent ? "正在生成…" : resultTitle }}</strong>
        <span v-if="store.lastJobStatus === 'failed' && !resultError" style="font-size: 11px; color: #dc2626">任务失败</span>
      </div>
      <div class="ade-result-card__content">
        <div v-if="store.isBusy && !store.streamingContent" style="padding: 14px; color: #8B9BB1; font-size: 12px">正在整理建议…</div>
        <div v-else-if="resultText" class="markdown-body" style="padding: 12px 14px; max-height: 42vh; overflow-y: auto" v-html="renderedHtml"></div>
      </div>
      <div v-if="resultText" class="ade-result-card__actions">
        <button @click="copyResult">复制</button>
        <button @click="replaceSelection">替换选中内容</button>
        <button @click="insertAtCursor">插入到光标</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.ade-ai-panel {
  display: flex;
  flex-direction: column;
  position: relative;
  background: #11192C;
  border-left: 1px solid #1A2333;
  flex-shrink: 0;
  overflow: hidden;
  min-width: 340px;
  max-width: 720px;
}
.ade-ai-panel__resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: 10;
}
.ade-ai-panel__resize-handle:hover {
  background: #DCE6F2;
}
.ade-ai-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 14px 16px 12px;
  border-bottom: 1px solid #1A2333;
  background: #11192C;
}
.ade-ai-panel__header h3 {
  margin: 2px 0 0;
  font-size: 15px;
  font-weight: 700;
  color: #E8EEF7;
}
.ade-ai-panel__eyebrow {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  color: #8B9BB1;
}
.ade-ai-panel__close {
  border: 0;
  background: transparent;
  color: #7A8AA0;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
.ade-ai-panel__tabs {
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid #1A2333;
  background: #1A2333;
  overflow-x: auto;
  flex-shrink: 0;
}
.ade-ai-panel__tab {
  height: 30px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: #8B9BB1;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.ade-ai-panel__tab:hover {
  background: #1E2A48;
  color: #DCE6F2;
  border-color: #2A3A55;
}
.ade-ai-panel__tab--active {
  background: #1E2A48;
  color: #2563eb;
  border-color: #2A3A55;
}
/* 写作模型选择条 */
.ade-ai-panel__model {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid #1A2333;
  background: #11192C;
  flex-shrink: 0;
}
.ade-ai-panel__model label {
  font-size: 11px;
  font-weight: 600;
  color: #8B9BB1;
  white-space: nowrap;
}
.ade-ai-panel__model-select {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid #2A3A55;
  border-radius: 6px;
  background: #1A2333;
  color: #DCE6F2;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.ade-ai-panel__model-select:hover:not(:disabled) {
  border-color: #4D84CB;
}
.ade-ai-panel__model-select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ade-ai-panel__body {
  padding: 14px 16px;
  overflow-y: auto;
  flex-shrink: 0;
  max-height: 40%;
  border-bottom: 1px solid #212C45;
}
.ade-ai-section-intro h4 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 700;
  color: #E8EEF7;
}
.ade-ai-section-intro p {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: #8B9BB1;
}
.ade-ai-panel__notice {
  margin-bottom: 8px;
  padding: 7px 10px;
  border: 1px solid #4D84CB55;
  border-radius: 7px;
  background: #1E2A48;
  color: #6FA6E8;
  font-size: 11px;
  line-height: 1.5;
}
.ade-task-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ade-task-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  padding: 11px 12px;
  border: 1px solid #222F44;
  border-radius: 8px;
  background: #11192C;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  font-family: inherit;
}
.ade-task-card:hover:not(:disabled) {
  background: #1E2A48;
  border-color: #4D84CB;
}
.ade-task-card:hover:not(:disabled) span,
.ade-task-card:hover:not(:disabled) small {
  color: #FFFFFF;
}
.ade-task-card:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ade-task-card span {
  font-size: 13px;
  font-weight: 700;
  color: #E8EEF7;
}
.ade-task-card small {
  font-size: 12px;
  line-height: 1.45;
  color: #8B9BB1;
}
.ade-chart-preview__img {
  width: 100%;
  border: 1px solid #222F44;
  border-radius: 10px;
  background: #fff;
}
.ade-chart-preview__svg {
  font-size: 11px;
  color: #6FA6E8;
  text-align: center;
  text-decoration: underline;
}
.ade-chart-preview__code {
  max-height: 220px;
  overflow: auto;
  padding: 10px;
  border: 1px solid #222F44;
  border-radius: 8px;
  background: #0E1524;
  color: #A3B3C8;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}
.ade-chart-source {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ade-chart-source > span {
  font-size: 11px;
  font-weight: 600;
  color: #8B9BB1;
}
.ade-chart-hint {
  padding: 7px 9px;
  border: 1px solid #222F44;
  border-radius: 7px;
  background: #16203A;
  color: #8B9BB1;
  font-size: 11px;
  line-height: 1.5;
}
.ade-format-template-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ade-format-template {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  padding: 9px 11px;
  border: 1px solid #222F44;
  border-radius: 8px;
  background: #11192C;
  cursor: pointer;
  font-family: inherit;
}
.ade-format-template--active {
  background: #1E2A48;
  border-color: #2A3A55;
}
.ade-format-template strong {
  font-size: 12.5px;
  color: #E8EEF7;
}
.ade-format-template span {
  font-size: 11px;
  color: #8B9BB1;
}
.ade-format-template-summary {
  margin-top: 8px;
  font-size: 11px;
  color: #7A8AA0;
}
.ade-chart-form {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.ade-chart-preview {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ade-result-card {
  margin: 10px 12px 12px;
  border: 1px solid #222F44;
  border-radius: 10px;
  background: #11192C;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ade-result-card--error {
  border-color: #3A2323;
}
.ade-result-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  background: #1A2333;
  border-bottom: 1px solid #222F44;
}
.ade-result-card__actions {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid #212C45;
}
.ade-result-card__actions button {
  padding: 4px 9px;
  font-size: 11px;
  border: 1px solid #222F44;
  border-radius: 5px;
  background: #11192C;
  color: #2563eb;
  cursor: pointer;
}
.ade-result-card__actions button:hover {
  background: #1E2A48;
}
</style>
