<script setup lang="ts">
/**
 * VizChatPanelV2 — 还原自闭源 VizView L449-2869(scope data-v-cca9ccd1) 对话核心
 * 发送主链: 建任务 → POST viz-jobs(body 全契约) → AbortController SSE → 13 事件分发表
 * 图卡: chart 事件 → blob 化 → emit chart-update(父画布); data-upload/job-status 上行事件
 * markdown 手写正则渲染(v-html + XSS 转义, 无外部 md 库); 自动保存 300ms → viz_v2 键 + tasks 节点
 */
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { blobifyPng, createVizJob, getVizJob, streamVizJob, cancelVizJob, uploadVizFile, ensureVizSession, DEFAULT_JOURNAL_CONFIG, vizBackendStatus, listVizDataFiles, getVizFileProfile, listStatsJobs, getStatsJobDataset, vizArtifactUrl, getVizModels, setVizModel, type VizJob, type VizChart, type VizDataFile, type StatsJobBrief, type VizLlmModel } from "./vizApi";
import { toast } from "@/shared/ui";
import { K, uid } from "@/shared/constants";
import { ensureModuleTask, putNode } from "@/shared/tasks";

const props = defineProps<{
  initialJobId?: string;
  readOnly?: boolean;
  compact?: boolean;
}>();
const emit = defineEmits<{
  (e: "chart-update", payload: Record<string, unknown>): void;
  (e: "multi-chart", charts: unknown[]): void;
  (e: "data-upload", payload: { fileId: string; fileName: string; columns: string[]; rows: unknown[][]; rowCount?: number }): void;
  (e: "job-status", payload: { id: string; status: string }): void;
}>();

// ── 消息模型(闭源 F() L557-571) ──
export interface VizMsg {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  caption?: string;
  thinking?: string;
  chartPng?: string | null;
  chartType?: string;
  error?: string;
  code?: string;
  plan?: string;
  toolActivities?: Array<{ name: string; status: string; detail?: string }>;
  chartMetadata?: Record<string, unknown>;
  time?: string;
}

const messages = ref<VizMsg[]>([]);
const input = ref("");
const sending = ref(false);
const textareaEl = ref<HTMLTextAreaElement | null>(null);
const chatScroll = ref<HTMLElement | null>(null);
const sessionId = ref(`v2_${Date.now().toString(36)}`);
const uploadedData = ref<{ fileId: string; fileName: string; columns: string[]; rows: unknown[][]; rowCount?: number } | null>(null);
const backendState = ref("checking");
const attachedImages = ref<string[]>([]);
const tokenEstimate = computed(() => Math.round(input.value.length * 0.4));

// ── 数据源选择器(2026-09-11): 视觉上必须让人一眼看出"这张图是真实的还是示意的" ──
interface SourceOption { key: string; label: string; sub: string; fileId: string; fileName: string; rowCount: number; colCount: number }
const srcPickerOpen = ref(false);
const srcTab = ref<"files" | "stats">("files");
const srcOptions = ref<SourceOption[]>([]);
const srcStats = ref<StatsJobBrief[]>([]);
const srcLoading = ref(false);
const srcError = ref("");

async function openSourcePicker() {
  srcPickerOpen.value = true;
  srcError.value = "";
  srcLoading.value = true;
  try {
    const [files, stats] = await Promise.all([
      listVizDataFiles().catch(() => [] as VizDataFile[]),
      listStatsJobs(20).catch(() => [] as StatsJobBrief[]),
    ]);
    srcOptions.value = files.map((f) => ({
      key: `f:${f.fileId}`, fileId: f.fileId, fileName: f.fileName,
      rowCount: f.rowCount, colCount: f.colCount,
      label: f.fileName, sub: `${f.rowCount} 行 × ${f.colCount} 列`,
    }));
    srcStats.value = stats.filter((s) => s.status === "completed");
    if (!srcOptions.value.length) srcTab.value = srcStats.value.length ? "stats" : "files";
  } catch (e) {
    srcError.value = (e as Error).message;
  } finally {
    srcLoading.value = false;
  }
}

async function bindFileSource(opt: SourceOption) {
  uploadedData.value = { fileId: opt.fileId, fileName: opt.fileName, columns: [], rows: [], rowCount: opt.rowCount };
  pushMsg({ role: "system", content: `[数据源] **${opt.fileName}** · ${opt.rowCount} 行 × ${opt.colCount} 列\n\n本会话后续图表将使用该数据(真实计算), 不再是示意数据。` });
  srcPickerOpen.value = false;
  // 列名/样本用于预览(取数由服务端按 fileId 做, 前端只展示)
  const prof = await getVizFileProfile(opt.fileId);
  if (prof && uploadedData.value?.fileId === opt.fileId) {
    const cols = (prof.columns ?? prof.variables ?? []).map((c) => String(typeof c === "string" ? c : (c as { name?: unknown })?.name ?? ""));
    uploadedData.value.columns = cols;
    uploadedData.value.rows = ((prof.sampleRows ?? []) as unknown[][]).slice(0, 500);
    emit("data-upload", { fileId: opt.fileId, fileName: opt.fileName, columns: cols, rows: uploadedData.value.rows });
  }
  // 数据源是当前任务的会话状态, 不再另起任务(ensureModuleTask 按标题会新建 → 刷新后载回旧任务, 数据丢失)
  scheduleSave();
}

async function bindStatsSource(job: StatsJobBrief) {
  const ds = await getStatsJobDataset(job.id);
  if (!ds) {
    toast("该分析任务没有可用的原始数据文件", "error");
    return;
  }
  const label = `${String(job.method ?? job.tool)} 分析的数据 (${ds.fileName || "未命名"})`;
  // 沿用 fileId 单一通道: 后端按 fileId 取数, 前端只带引用
  uploadedData.value = { fileId: ds.fileId, fileName: label, columns: ds.columnOrder, rows: ds.rows.slice(0, 500), rowCount: ds.totalRows };
  pushMsg({ role: "system", content: `[数据源] **${label}** · ${ds.totalRows} 行 × ${ds.columnOrder.length} 列\n\n来自统计分析「${job.method ?? job.tool}」的原始数据。` });
  emit("data-upload", { fileId: ds.fileId, fileName: label, columns: ds.columnOrder, rows: ds.rows.slice(0, 500) });
  srcPickerOpen.value = false;
  scheduleSave();
}

function clearDataSource() {
  uploadedData.value = null;
  pushMsg({ role: "system", content: "[数据源] 已清除 — 后续图表将按**示意图**生成, 不含真实数据。" });
  scheduleSave();
}

// ── 期刊规范(出版级出图的关键: 尺寸/DPI/字号/配色, 由用户定而非写死) ──
type JournalCfg = typeof DEFAULT_JOURNAL_CONFIG;
const journalConfig = ref<JournalCfg>({ ...DEFAULT_JOURNAL_CONFIG });
const specOpen = ref(false);
const COLOR_SCHEMES = ["nature-default", "色盲友好(cividis)", "灰度可辨", "暖色系", "冷色系"];
const JOURNAL_PRESETS: Array<{ key: string; label: string; cfg: Partial<JournalCfg> }> = [
  { key: "nature-single", label: "Nature 单栏", cfg: { journal: "nature", layout: "single-column", widthMm: 89, heightMm: 62.3, dpi: 600, fontSize: 7, fontFamily: "Arial" } },
  { key: "nature-double", label: "Nature 双栏", cfg: { journal: "nature", layout: "double-column", widthMm: 183, heightMm: 120, dpi: 600, fontSize: 8, fontFamily: "Arial" } },
  { key: "science-single", label: "Science 单栏", cfg: { journal: "science", layout: "single-column", widthMm: 55, heightMm: 40, dpi: 600, fontSize: 6, fontFamily: "Arial" } },
  { key: "ieee-double", label: "IEEE 双栏", cfg: { journal: "ieee", layout: "double-column", widthMm: 88.9, heightMm: 60, dpi: 600, fontSize: 8, fontFamily: "Times New Roman" } },
  { key: "cn-core", label: "中文核心", cfg: { journal: "中文核心期刊", layout: "single-column", widthMm: 140, heightMm: 100, dpi: 300, fontSize: 9, fontFamily: "SimSun" } },
  { key: "slide", label: "汇报用图", cfg: { journal: "presentation", layout: "double-column", widthMm: 240, heightMm: 135, dpi: 150, fontSize: 12, fontFamily: "Microsoft YaHei" } },
];
function applyJournal(key: string) {
  const p = JOURNAL_PRESETS.find((x) => x.key === key);
  if (p) journalConfig.value = { ...journalConfig.value, ...p.cfg };
}
const activeJournal = computed(() => JOURNAL_PRESETS.find((p) =>
  p.cfg.widthMm === journalConfig.value.widthMm && p.cfg.dpi === journalConfig.value.dpi)?.key ?? "custom");

// ── 绘图模型选择(角色 viz, 后端按 provider 路由端点) ──
const llmModels = ref<VizLlmModel[]>([]);
const curModel = ref("");
async function loadModels() {
  try {
    const r = await getVizModels();
    llmModels.value = r.models;
    curModel.value = r.current || r.models[0]?.id || "";
  } catch { /* 后端不可用时保持空 */ }
}
async function pickModel(id: string) {
  const prev = curModel.value;
  curModel.value = id;
  try {
    await setVizModel(id);
    toast(`绘图模型已切换: ${llmModels.value.find((m) => m.id === id)?.label ?? id}`, "success");
  } catch (e) {
    curModel.value = prev;
    toast(`切换失败: ${(e as Error).message}`, "error");
  }
}

// ── 快捷技能(把常用出图诉求一键填进输入框, 也让新用户知道能做什么) ──
const SKILLS: Array<{ k: string; label: string; tpl: string }> = [
  { k: "clean", label: "出版美化", tpl: "在保持数据不变的前提下美化该图: 去掉多余装饰(顶/右边框、网格线), 字号与线宽按期刊规范, 配色灰度可辨" },
  { k: "sig", label: "加显著性", tpl: "在图上标注组间差异显著性(星号 * / ** / ***), 并在图注说明检验方法" },
  { k: "errbar", label: "加误差棒", tpl: "为柱/点加上误差棒(标准差或标准误, 并注明), 误差棒样式符合期刊要求" },
  { k: "labels", label: "标签优化", tpl: "优化坐标轴标签与刻度: 中文完整表述、必要处带单位、避免刻度重叠" },
  { k: "reorder", label: "排序重绘", tpl: "按数值大小重排类别顺序后重绘, 便于横向比较" },
  { k: "caption", label: "生成图注", tpl: "为该图生成规范的中文图注(说明图表达什么、数据来源与必要统计信息), 只依据图中已有信息" },
];

// ── 可拖拽控制栏(用户反馈④: 面板边框可拉伸) ──
// 三段高度(图例/出版规范/输入区) + 底部信息栏(在 VizView)与图卡条。
// localStorage 持久化: 拖过一次就一直是用户要的高度。
const CTL_KEY = "viz_ui_layout_v1";
interface CtlLayout { legend: number; spec: number; composer: number }
const ctl = ref<CtlLayout>({ legend: 0, spec: 0, composer: 118 });
function loadCtl() {
  try {
    const raw = localStorage.getItem(CTL_KEY);
    if (raw) ctl.value = { ...ctl.value, ...JSON.parse(raw) };
  } catch { /* 忽略 */ }
}
function saveCtl() {
  try { localStorage.setItem(CTL_KEY, JSON.stringify(ctl.value)); } catch { /* 忽略 */ }
}
function startRowResize(kind: "legend" | "spec", e: MouseEvent) {
  const el = (e.currentTarget as HTMLElement).parentElement;
  if (!el) return;
  const startY = e.clientY;
  const startH = el.getBoundingClientRect().height;
  const move = (ev: MouseEvent) => {
    // 向上拖 = 变高(控制栏在底部, 高度向上增长)
    ctl.value[kind] = Math.max(28, Math.min(280, startH - (ev.clientY - startY)));
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    saveCtl();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
function startComposerResize(e: MouseEvent) {
  const el = (e.currentTarget as HTMLElement).parentElement;
  if (!el) return;
  const startY = e.clientY;
  const startH = el.getBoundingClientRect().height;
  const move = (ev: MouseEvent) => {
    ctl.value.composer = Math.max(84, Math.min(400, startH - (ev.clientY - startY)));
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    saveCtl();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

let abortCtrl: AbortController | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let currentTaskId = ""; // 任务 id(localStorage viz_v2_<uid>_<taskId> 键, 闭源语义)
let currentProjectId = ""; // 项目 id(节点云存 PUT /research/projects/:projectId/nodes/:key 归属)
let currentJobId = ""; // 本轮 job(图表去重/任务关联)

// ── expose(闭源 L1144-1244: saveToLocal/loadFromLocal/restoreFromVizJob 等) ──
defineExpose({
  messages, sessionId, uploadedData,
  send, stop,
  async saveToLocal() { saveLocal(); },
  async loadFromLocal() { loadLocal(); },
  async restoreFromVizJob(job: VizJob) { await restoreFromVizJob(job); },
  async restoreFromBackend(msgs: VizMsg[], sid: string, data?: typeof uploadedData.value | null) {
    messages.value = (msgs ?? []).slice();
    sessionId.value = sid || sessionId.value;
    if (data) uploadedData.value = data;
  },
  clearMessages() { messages.value = []; },
  /**
   * 统一分析台「送工坊精修」: 把当时的 CSV 传上来 + 预填需求并自动发起绘图
   * (数据随结果一起带过来, 用户不必手动重传)
   */
  async seedFromEmpirical(seed: { csv: string; columnOrder: string[]; message: string }) {
    if (!seed?.csv?.trim()) { input.value = seed?.message ?? ""; return; }
    try {
      const file = new File([seed.csv], "empirical_data.csv", { type: "text/csv" });
      const up = await uploadVizFile(file);
      const cols = (up?.profile?.columns ?? []).map((c) => (typeof c === "string" ? c : c?.name ?? "")).filter(Boolean);
      uploadedData.value = {
        fileId: up.fileId,
        fileName: "empirical_data.csv",
        columns: cols.length ? cols : (seed.columnOrder ?? []),
        rows: (up?.profile?.sampleRows ?? []) as unknown[][],
      };
      input.value = seed.message || "基于这份数据绘制合适的科研图表";
      await send();
    } catch (e) {
      // 上传失败也要把需求写进去, 用户可手动重试
      input.value = seed.message ?? "";
      toast(`数据同步失败: ${(e as Error).message}`, "error");
    }
  }
});

// ── localStorage(闭源 be() L662-750: viz_v2_<uid>_<taskId>, 300ms 防抖, 流结束立即存) ──
function saveLocal() {
  try {
    if (!currentTaskId) return;
    const key = K.vizV2(uid(), currentTaskId);
    const trimmed = messages.value.map((m) => {
      const copy = { ...m };
      // 大 base64 置 null(>500KB)
      if (typeof copy.chartPng === "string" && copy.chartPng.length > 500_000) copy.chartPng = null;
      return copy;
    });
    localStorage.setItem(key, JSON.stringify({
      messages: trimmed, sessionId: sessionId.value, savedAt: new Date().toISOString(),
      // 数据源随会话保存: 否则刷新后回落到"未绑定" → 同样的提问会退化成编造数值的示意图
      uploadedData: uploadedData.value ? { ...uploadedData.value, rows: uploadedData.value.rows.slice(0, 50) } : null,
      journalConfig: journalConfig.value,
    }));
    // 云端: tasks 节点 viz_chat(409 静默跳过)
    void putNodeSafe("viz_chat", { messages: trimmed, sessionId: sessionId.value, savedAt: new Date().toISOString() });
    if (uploadedData.value) {
      void putNodeSafe("viz_data", { ...uploadedData.value, rows: uploadedData.value.rows.slice(0, 500) });
    }
  } catch { /* 容量/隐私模式容忍 */ }
}

async function putNodeSafe(key: string, payload: Record<string, unknown>) {
  // 节点挂在项目下(task id ≠ project id, 审查修复: 混用导致 PUT 404 项目不存在)
  if (!currentProjectId) return;
  await putNode(currentProjectId, key, payload).catch(() => null);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLocal, 300); // 闭源 300ms 防抖
}

function loadLocal() {
  try {
    if (!currentTaskId) return;
    const key = K.vizV2(uid(), currentTaskId);
    const raw = localStorage.getItem(key);
    if (raw) {
      const d = JSON.parse(raw);
      if (Array.isArray(d.messages)) messages.value = d.messages;
      if (d.sessionId) sessionId.value = d.sessionId;
      // 恢复数据源与出版规范(与 messages 同源, 否则刷新即丢)
      if (d.uploadedData && typeof d.uploadedData === "object") {
        uploadedData.value = d.uploadedData;
        // 必须重新广播给画布: 否则刷新后"已选数据源"但画布 curDataSnapshot 为空,
        //   再出图又会显示"暂无绑定数据"(用户反馈的真实路径)
        emit("data-upload", {
          fileId: d.uploadedData.fileId, fileName: d.uploadedData.fileName,
          columns: d.uploadedData.columns ?? [], rows: d.uploadedData.rows ?? [],
          rowCount: d.uploadedData.rowCount,
        });
      }
      if (d.journalConfig && typeof d.journalConfig === "object") journalConfig.value = { ...journalConfig.value, ...d.journalConfig };
    }
  } catch { /* 忽略 */ }
}

// ── markdown 手写正则渲染(闭源 z() L1817-1913: XSS 转义 → 代码块折叠 → 表/标题/粗体/列表) ──
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderMd(src: string): string {
  if (!src) return "";
  let s = esc(src);
  // 代码块 → details 折叠(占位符防二次替换)
  const placeholders: string[] = [];
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const i = placeholders.length;
    placeholders.push(`<details class="md-code"><summary>查看 ${lang || "code"}</summary><pre><code>${code}</code></pre></details>`);
    return `@@CODE_${i}@@`;
  });
  // 行内 code
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // 表格
  s = s.replace(/(^\|.+\|$)\n((^\|[-:|\s]+\|$)\n)?((^\|.+\|$\n?)+)/gm, (block) => {
    const lines = block.trim().split("\n").filter((l) => l.includes("|"));
    if (lines.length < 1) return block;
    const parse = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const header = parse(lines[0]);
    const body = lines.filter((l, i) => i !== 0 && !/^\|[\s:|-]+\|$/.test(l)).map(parse);
    return `<table><thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`;
  });
  // 标题
  s = s.replace(/^##### (.*)$/gm, "<h5>$1</h5>").replace(/^#### (.*)$/gm, "<h4>$1</h4>").replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>");
  // 列表
  s = s.replace(/^- (.*)$/gm, "<li>$1</li>");
  // 粗体/斜体
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // 分隔
  s = s.replace(/^---$/gm, "<hr/>");
  // 段落包装(非块行)
  s = s.split("\n").map((line) => (line.trim() ? line : "")).filter(Boolean).map((line) => {
    if (/^<(h\d|table|li|hr|details|pre|strong|em)/.test(line)) return line;
    return `<p>${line}</p>`;
  }).join("");
  // 列表聚合
  s = s.replace(/(<li>.*<\/li>)+/g, (m) => `<ul>${m}</ul>`);
  // 占位回填
  placeholders.forEach((html, i) => {
    s = s.replace(`@@CODE_${i}@@`, html);
  });
  return s;
}

/** 上传(2026-09-11 重做): 上传后绑定 fileId, 取数由服务端完成
 *  改造前: 前端本地解析整表 CSV 塞进请求体(大文件会把 body 撑爆), 且 fileId 被后端丢弃 → 全程无数据。 */
async function handleFile(file: File) {
  try {
    const r = await uploadVizFile(file);
    const prof = r.profile ?? {};
    const cols = (prof.columns ?? prof.variables ?? []).map((c) => String(typeof c === "string" ? c : (c as { name?: unknown })?.name ?? ""));
    const rows = ((prof.sampleRows ?? []) as unknown[][]).slice(0, 500);
    const rowCount = Number(prof.rowCount ?? 0);
    const payload = { fileId: r.fileId, fileName: file.name, columns: cols, rows, rowCount };
    uploadedData.value = payload;
    const head = cols.slice(0, 6).map((c) => `\`${c}\``).join(" ");
    pushMsg({ role: "system", content: `[数据源] **${file.name}**\n\n${rowCount || rows.length} 行 × ${prof.colCount ?? prof.columnCount ?? cols.length} 列\n${head}` });
    emit("data-upload", payload);
    await ensureTask(file.name.replace(/\.[^.]+$/, "") || "未命名绘图");
    scheduleSave();
  } catch (e) {
    toast(`上传失败: ${(e as Error).message}`, "error");
  }
}

function pushMsg(m: Partial<VizMsg> & { role: VizMsg["role"]; content: string }): VizMsg {
  const msg: VizMsg = { id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, time: new Date().toISOString(), ...m } as VizMsg;
  messages.value.push(msg);
  scrollToBottom();
  // 必须返回 Vue 的响应式代理, 不能返回上面的原始对象:
  //   handleEvent 里 `assistant.content += ...` 改的是返回值; 改原始对象不触发渲染,
  //   表现为出图后聊天区全空、图卡不生成(要等整轮结束重新拉消息才显示)。2026-09-11 实测踩到。
  return messages.value[messages.value.length - 1];
}

async function ensureTask(title: string) {
  const { taskId, projectId } = await ensureModuleTask("viz", title, props.initialJobId ?? undefined);
  currentTaskId = taskId;
  currentProjectId = projectId ?? "";
}

// ── 发送主链(闭源 d() L1453-1594) ──
async function send() {
  const text = input.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  // input 与 ensureTask 放进 try: 建任务失败(401/网络抖动)也让用户看到原因, 而不是"点了没反应"
  abortCtrl = new AbortController();
  let assistant: VizMsg | null = null;
  try {
    input.value = "";
    await ensureTask(text.slice(0, 30));
    pushMsg({ role: "user", content: text });
    assistant = pushMsg({ role: "assistant", content: "", thinking: "", toolActivities: [] });
    const conv = messages.value.slice(-16).map((m) => ({ role: m.role === "tool" ? "assistant" : m.role, content: m.content.slice(0, 900) }));
    // 会话确保存在(后端校验 sessionId)
    sessionId.value = await ensureVizSession(sessionId.value, text.slice(0, 30));
    const body = {
      message: text,
      sessionId: sessionId.value, // 后端契约: sessionId(驼峰)
      conversation: conv,
      // 数据源: 只传 fileId + 文件名, 取数在服务端(2026-09-11; 此前 fileId 被丢弃 → 图无数据)
      fileId: uploadedData.value?.fileId || null,
      fileName: uploadedData.value?.fileName ?? null,
      user_id: uid(),
      journalConfig: { ...journalConfig.value },
      modelConfig: { defaultJournal: journalConfig.value.journal },
      maxToolRounds: 5,
      autoPolish: "best_practice",
      autoComplianceCheck: "",
      contextWindow: null,
      systemPromptOverride: null
    };
    const { job } = await createVizJob(body);
    currentJobId = job.id;
    emit("job-status", { id: job.id, status: job.status });
    // streamVizJob 返回 {promise, controller} — 必须 await 它的 promise;
    //   直接 await 返回值会立即兑现 → sending 提前归位, 可重复发送
    // signal 必须传: 否则「停止」abort 的是孤儿 controller, 前端说停了后端照跑
    await streamVizJob(job.id, {
      onEvent: (event, payload) => handleEvent(event, payload, assistant!),
      onError: () => {
        if (assistant) assistant.error = "连接中断, 请重试";
      },
      signal: abortCtrl.signal
    }).promise;
  } catch (e) {
    const stopped = (e as Error).name === "AbortError" || abortCtrl?.signal.aborted;
    if (stopped) {
      if (assistant) assistant.content += "~~已停止生成~~";
      // 前端断开不等于后端停止: 显式取消任务, 否则服务端继续烧 LLM 并落产物
      if (currentJobId) void cancelVizJob(currentJobId);
    } else {
      const msg = `抱歉, 出错了: ${(e as Error).message}`;
      if (assistant) assistant.error = msg;
      else pushMsg({ role: "assistant", content: "", error: msg });
    }
  } finally {
    sending.value = false;
    abortCtrl = null;
    scheduleSave();
  }
}

function stop() {
  abortCtrl?.abort();
}

// ── SSE 事件分发表(闭源 m() L1646-1801 13 事件) ──
function handleEvent(event: string | null, payload: Record<string, unknown>, assistant: VizMsg) {
  const p = payload as Record<string, unknown>;
  switch (event) {
    case "plan": {
      assistant.plan = String(p.content ?? p.plan ?? "");
      break;
    }
    case "delta": {
      assistant.content += String(p.content ?? p.text ?? p.delta ?? "");
      break;
    }
    case "thinking": {
      const t = String(p.content ?? "");
      if (t) {
        const round = /Round\s*(\d+)\s*\/\s*(\d+)/.exec(t);
        assistant.thinking += (round || t.startsWith("type=recovery") ? "\n" : "") + t + "\n";
      }
      break;
    }
    case "tool_status":
    case "tool": {
      const acts = assistant.toolActivities ?? [];
      const name = String(p.name ?? p.tool ?? "工具");
      const status = String(p.status ?? "");
      let existing = acts.find((a) => a.name === name && (a.status === "calling" || a.status === "retrying"));
      if (!existing) {
        existing = { name, status: "running", detail: "" };
        acts.push(existing);
      }
      if (["done", "failed", "error", "skipped"].includes(status)) existing.status = status === "error" ? "failed" : status;
      else if (status) existing.status = status;
      const detail = String(p.content ?? p.detail ?? p.message ?? p.error ?? "").slice(0, 120);
      if (detail) existing.detail = detail;
      break;
    }
    case "chart": {
      // 合并 metadata 别名(闭源 Ae() 双向映射)
      const chart = payloadToChart(p);
      assistant.chartType = chart.chartType;
      assistant.chartMetadata = chart.metadata;
      assistant.chartPng = chart.png ?? null;
      void blobifyPng(chart.png ?? chart.chartPng ?? null).then((url) => {
        if (url) {
          assistant.chartPng = url;
          emit("chart-update", {
            vizJobId: String(p.job_id ?? currentJobId ?? ""),
            chartKey: String(p.chart_key ?? chart.chartVersionId ?? ""),
            png: chart.png,
            url,
            caption: chart.caption,
            analysisText: chart.analysisText,
            code: chart.code,
            chartType: chart.chartType,
            chartVersionId: chart.chartVersionId,
            figureId: chart.figureId,
            figureIndex: chart.figureIndex,
            panelId: chart.panelId,
            chartKeyRaw: p.chart_key,
            svg: chart.svg,
            // 生成端不带 svg 时, 产物路径可直接当 SVG 源(后端 viz_artifacts.svg_editable_path)
            svgUrl: artifactSvgUrl(p),
            sampleData: p.sampleData === true
          });
        }
      });
      break;
    }
    case "svg": {
      assistant.chartPng = assistant.chartPng ?? String(p.content ?? p.svg ?? "");
      break;
    }
    case "code": {
      assistant.code = String(p.content ?? p.code ?? "");
      break;
    }
    case "critique": {
      const score = p.score !== undefined ? `${p.score}/10` : "";
      const summary = String(p.summary ?? p.content ?? "");
      assistant.thinking += `\n审查: ${score} · ${summary}\n`;
      const issues = p.issues;
      if (Array.isArray(issues)) {
        for (const iss of issues.slice(0, 5)) {
          const it = iss as Record<string, unknown>;
          assistant.thinking += `问题: [${String(it.severity ?? "中")}] ${String(it.issue ?? it.desc ?? it.description ?? "")}\n`;
        }
      }
      break;
    }
    case "critique_fix": {
      assistant.thinking += `\n修订: ${String(p.content ?? "").slice(0, 200)}\n`;
      break;
    }
    case "error": {
      // message 是后端包装后的对象(形如 "[object Object]"), 真正可读的是 userMessage
      const msg = String(p.userMessage ?? (typeof p.message === "string" ? p.message : "") ?? p.error ?? "绘图出错");
      const isAutoRetry = msg.includes("[Auto-retry]");
      if (assistant.toolActivities) {
        for (const a of assistant.toolActivities) if (a.status === "running" || a.status === "calling") a.status = "failed";
      }
      if (!isAutoRetry) assistant.error = msg;
      break;
    }
    case "done": {
      if (assistant.toolActivities) {
        for (const a of assistant.toolActivities) if (a.status === "running") a.status = "done";
      }
      break;
    }
    case "viz.completed": {
      // job_id 缺失时回落到本轮 job; 不要用 version 冒充 id(后端终态事件不带 job_id)
      emit("job-status", { id: String(p.job_id ?? currentJobId ?? ""), status: "completed" });
      break;
    }
    // 后端重连路径发的是 viz_failed / cancelled(见 viz-job-service streamVizJob) — 三种写法都要认
    case "viz.failed":
    case "viz_failed": {
      emit("job-status", { id: String(p.job_id ?? currentJobId ?? ""), status: "failed" });
      break;
    }
    case "viz.cancelled":
    case "cancelled": {
      emit("job-status", { id: String(p.job_id ?? currentJobId ?? ""), status: "cancelled" });
      break;
    }
    default: {
      // 无事件名增量
      if (!event && p.content) assistant.content += String(p.content);
    }
  }
  scheduleSave();
}

/** chart 事件 → 可下载的 SVG 源(优先内联 svg, 其次后端产物路径 svgRel) */
function artifactSvgUrl(p: Record<string, unknown>): string {
  const art = (p.artifact ?? {}) as Record<string, unknown>;
  const inline = String(p.svg ?? p.svg_embedded ?? art.svg ?? "");
  if (inline) return inline;
  const rel = String(art.svgRel ?? "");
  return rel ? vizArtifactUrl(rel) : "";
}

/** 后端 chart 事件 payload → 图卡结构(闭源 Ae() L537-556 别名映射) */
function payloadToChart(p: Record<string, unknown>): VizChart {
  const art = (p.artifact ?? {}) as Record<string, unknown>;
  const png = String(p.png ?? p.chartPng ?? art.pngRel ?? art.png ?? "");
  const svg = String(p.svg ?? p.svg_embedded ?? art.svgRel ?? "");
  const meta = (p.metadata ?? {}) as Record<string, unknown>;
  const chartType = String(meta.chartType ?? p.chartType ?? meta.chart_type ?? art.chartType ?? "");
  const widthMm = p.widthMm ?? meta.width_mm;
  const heightMm = p.heightMm ?? meta.height_mm;
  return {
    png: png || null,
    svg: svg || null,
    caption: String(p.caption ?? p.title ?? art.caption ?? ""),
    analysisText: String(p.analysisText ?? p.analysis_text ?? art.analysisText ?? ""),
    code: String(p.code ?? art.code ?? ""),
    chartType,
    chartVersionId: String(p.chartVersionId ?? p.chart_version_id ?? p.version ?? art.chartVersionId ?? ""),
    figureId: String(p.figureId ?? p.figure_id ?? art.figureId ?? ""),
    figureIndex: p.figureIndex != null ? Number(p.figureIndex ?? p.figure_index ?? null) : null,
    panelId: String(p.panelId ?? p.panel_id ?? art.panelId ?? ""),
    metadata: { ...meta, chartType, widthMm: widthMm ?? DEFAULT_JOURNAL_CONFIG.widthMm, heightMm: heightMm ?? DEFAULT_JOURNAL_CONFIG.heightMm }
  };
}

// ── 恢复(闭源 Ue/Ve: 云端优先 → localStorage; 历史任务 restoreFromVizJob) ──
async function restoreFromVizJob(job: VizJob) {
  // 清空现有
  messages.value = [];
  const res = job.result ?? {};
  const charts = res.charts ?? [];
  const msgs: VizMsg[] = [];
  if (res.plan) msgs.push({ id: `p_${Date.now()}`, role: "assistant", content: "", plan: String(res.plan) });
  if (res.content) msgs.push({ id: `c_${Date.now()}`, role: "assistant", content: String(res.content), thinking: String(res.thinking ?? "") });
  for (const ch of charts) {
    const url = await blobifyPng(ch.png ?? ch.chartPng ?? null);
    msgs.push({ id: `ch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, role: "assistant", content: "", chartPng: url, chartType: ch.chartType, code: ch.code, caption: ch.caption, chartMetadata: ch.metadata });
  }
  messages.value = msgs;
  sessionId.value = String(job.input?.session_id ?? sessionId.value);
  scrollToBottom();
}

// ── UI 辅助 ──
function scrollToBottom() {
  nextTick(() => {
    const el = chatScroll.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}
function autoGrow() {
  const el = textareaEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}
function traceLines(m: VizMsg): string[] {
  if (!m.thinking) return [];
  return m.thinking.split("\n").filter((l) => l.trim());
}
function copyCode(code: string) {
  void navigator.clipboard.writeText(code).then(() => toast("代码已复制", "success"));
}

// 剪贴板图片粘贴
function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items ?? [];
  for (const it of items) {
    if (it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) {
        const reader = new FileReader();
        reader.onload = () => {
          input.value += `\n![image](${reader.result})\n`;
        };
        reader.readAsDataURL(f);
      }
    }
  }
}

// ── 生命周期(注册必须在 setup 同步段, async 内注册会失活) ──
watch([() => messages.value.length, () => messages.value[messages.value.length - 1]?.content], () => scheduleSave());
let healthTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  loadCtl();
  void ensureTask("未命名绘图任务").catch(() => null).then(() => {
    loadLocal();
  });
  // 后端心跳 30s(闭源 tt())
  const poll = async () => {
    backendState.value = await vizBackendStatus();
  };
  void poll();
  void loadModels();
  healthTimer = setInterval(poll, 30_000);
});
onUnmounted(() => {
  if (healthTimer) clearInterval(healthTimer);
  if (saveTimer) clearTimeout(saveTimer);
  if (messages.value.length) saveLocal();
});
</script>

<template>
  <div class="viz-chat-panel-v2">
    <div ref="chatScroll" class="chat-scroll">
      <!-- 空态欢迎 -->
      <div v-if="!messages.length" class="chat-welcome">
        <div class="welcome-title">科研绘图助手</div>
        <p>上传/选择数据 → 描述需求 → AI 规划、出图、自审修订, 产出 PNG + 可编辑 SVG。</p>
        <p class="welcome-note">未绑定数据时会生成<b>示意图</b>(带水印), 数值非真实结果。</p>
        <div class="quick-templates">
          <button v-for="t in ['双Y轴', '子图网格', '柱线叠加', '回归散点', '基准线']" :key="t" class="quick-chip" @click="input = '请绘制' + t + '图表: 使用已上传数据'">{{ t }}</button>
        </div>
      </div>

      <!-- 消息流 -->
      <div v-for="m in messages" :key="m.id" class="chat-msg" :class="'msg-' + m.role">
        <template v-if="m.role === 'user'">
          <div class="msg-bubble user-bubble">{{ m.content }}</div>
        </template>
        <template v-else-if="m.role === 'system'">
          <div class="system-card" v-html="renderMd(m.content)"></div>
        </template>
        <template v-else-if="m.role === 'tool'">
          <div class="tool-line"><span class="tool-icon">🛠</span> {{ m.content }}</div>
        </template>
        <template v-else>
          <div class="assistant-block">
            <!-- plan 目标行 -->
            <div v-if="m.plan" class="goal-line">
              <span class="goal-rule"></span>
              <span class="goal-text">{{ m.plan }}</span>
            </div>
            <!-- thinking trace -->
            <details v-if="m.thinking" class="thinking-trace" open>
              <summary class="thinking-header">
                <span class="thinking-chevron">▸</span> 思考过程
                <span class="thinking-state">trace</span>
              </summary>
              <div class="thinking-body">
                <div v-for="(l, i) in traceLines(m)" :key="i" class="thinking-entry">
                  <span class="entry-title">{{ l.slice(0, 60) }}</span>
                  <span class="entry-detail">{{ l.slice(60) }}</span>
                </div>
              </div>
            </details>
            <!-- 图表 -->
            <div v-if="m.chartPng" class="chart-figure">
              <img :src="m.chartPng" class="chart-img" alt="图表" />
              <div v-if="m.chartType" class="chart-type-chip">{{ m.chartType }}</div>
            </div>
            <!-- 正文 -->
            <div v-if="m.content" class="msg-bubble assistant-bubble" v-html="renderMd(m.content)"></div>
            <!-- code 展示 -->
            <div v-if="m.code" class="code-card">
              <div class="code-head"><span>Python 代码</span><button @click="copyCode(m.code!)">复制</button></div>
              <pre class="code-body"><code>{{ m.code }}</code></pre>
            </div>
            <!-- tool activities -->
            <div v-if="m.toolActivities?.length" class="tool-activities">
              <div v-for="(a, i) in m.toolActivities" :key="i" class="tool-activity" :class="'tool-' + a.status">
                <span class="tool-dot"></span>{{ a.name }}<span v-if="a.detail" class="tool-detail"> — {{ a.detail }}</span>
              </div>
            </div>
            <!-- error -->
            <div v-if="m.error" class="msg-error">⚠ {{ m.error }}</div>
          </div>
        </template>
      </div>

      <!-- sending 占位 -->
      <div v-if="sending" class="typing-indicator">
        <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span> 绘图智能体处理中…
      </div>
    </div>

    <!-- 数据源条: 一眼看出"真实数据"还是"示意图"(2026-09-11) -->
    <div class="data-bar" :class="{ bound: !!uploadedData }">
      <span class="data-dot"></span>
      <template v-if="uploadedData">
        <span class="data-name" :title="uploadedData.fileName">{{ uploadedData.fileName }}</span>
        <span class="data-meta">{{ uploadedData.columns.length || "?" }} 列 · 真实数据</span>
        <button class="data-btn" @click="openSourcePicker">换数据源</button>
        <button class="data-btn ghost" @click="clearDataSource">解除</button>
      </template>
      <template v-else>
        <span class="data-name warn">未绑定数据 — 生成的是<strong>示意图</strong>, 数值非真实</span>
        <button class="data-btn" @click="openSourcePicker">选择数据源</button>
      </template>
    </div>

    <!-- 绘图模型 + 快捷技能(一键把常用诉求填进输入框) -->
    <div class="legend-bar" :style="ctl.legend ? { height: ctl.legend + 'px' } : undefined">
      <div class="ctl-grip" title="拖动调整高度" @mousedown="startRowResize('legend', $event)"></div>
      <div class="legend-row">
        <span class="legend-label">模型</span>
        <select class="model-select" :value="curModel" @change="pickModel(($event.target as HTMLSelectElement).value)"
                :title="llmModels.find(m => m.id === curModel)?.desc || ''">
          <option v-for="m in llmModels" :key="m.id" :value="m.id">{{ m.label }}</option>
        </select>
        <span v-if="!llmModels.length" class="legend-hint">模型列表加载中…</span>
      </div>
      <div class="legend-row skills">
        <span class="legend-label">技能</span>
        <button v-for="sk in SKILLS" :key="sk.k" class="skill-chip" :title="sk.tpl" @click="input = sk.tpl">{{ sk.label }}</button>
      </div>
    </div>

    <!-- 出版规范条(尺寸/DPI/字号/配色 → 后端 journalConfig) -->
    <div class="spec-bar" :style="ctl.spec ? { height: ctl.spec + 'px' } : undefined">
      <div class="ctl-grip" title="拖动调整高度" @mousedown="startRowResize('spec', $event)"></div>
      <button class="spec-toggle" @click="specOpen = !specOpen">
        <span class="chev" :class="{ open: specOpen }">▸</span> 出版规范
        <span class="spec-now">{{ JOURNAL_PRESETS.find(p => p.key === activeJournal)?.label || "自定义" }} · {{ journalConfig.widthMm }}mm · {{ journalConfig.dpi }}dpi</span>
      </button>
      <div v-if="specOpen" class="spec-body">
        <div class="spec-row">
          <span class="spec-label">期刊</span>
          <button v-for="p in JOURNAL_PRESETS" :key="p.key" class="spec-chip" :class="{ on: activeJournal === p.key }" @click="applyJournal(p.key)">{{ p.label }}</button>
        </div>
        <div class="spec-row">
          <span class="spec-label">配色</span>
          <button v-for="c in COLOR_SCHEMES" :key="c" class="spec-chip" :class="{ on: journalConfig.colorScheme === c }" @click="journalConfig.colorScheme = c">{{ c }}</button>
        </div>
        <div class="spec-row">
          <span class="spec-label">细调</span>
          <label class="spec-num">宽 <input type="number" v-model.number="journalConfig.widthMm" min="30" max="500" /> mm</label>
          <label class="spec-num">高 <input type="number" v-model.number="journalConfig.heightMm" min="20" max="400" /> mm</label>
          <label class="spec-num">DPI <input type="number" v-model.number="journalConfig.dpi" min="72" max="1200" step="50" /></label>
          <label class="spec-num">字号 <input type="number" v-model.number="journalConfig.fontSize" min="4" max="24" step="0.5" /> pt</label>
          <label class="spec-num">线宽 <input type="number" v-model.number="journalConfig.dataLineWidth" min="0.2" max="6" step="0.1" /></label>
        </div>
      </div>
    </div>

    <!-- 输入区(高度可拖) -->
    <div class="chat-composer" :style="{ height: ctl.composer + 'px' }">
      <div class="ctl-grip" title="拖动调整高度" @mousedown="startComposerResize($event)"></div>
      <div class="composer-attach">
        <label class="attach-btn" title="上传数据文件(CSV/Excel)">📎
          <input type="file" accept=".csv,.xlsx,.xls" style="display: none" @change="(ev) => { const f = (ev.target as HTMLInputElement).files?.[0]; if (f) void handleFile(f); (ev.target as HTMLInputElement).value = ''; }" />
        </label>
      </div>
      <textarea
        ref="textareaEl"
        v-model="input"
        class="composer-input"
        rows="1"
        placeholder="描述图表需求, Enter 发送, Shift+Enter 换行…"
        :disabled="sending || readOnly"
        @keydown="onKeydown"
        @input="autoGrow"
        @paste="onPaste"
      ></textarea>
      <div class="composer-side">
        <span class="token-est">{{ tokenEstimate }} tokens</span>
        <button v-if="sending" class="send-btn stop" @click="stop">⏹</button>
        <button v-else class="send-btn" :disabled="!input.trim() || readOnly" @click="send">↗</button>
      </div>
    </div>

    <!-- 数据源选择器 -->
    <div v-if="srcPickerOpen" class="src-mask" @click.self="srcPickerOpen = false">
      <div class="src-dialog">
        <div class="src-head">
          <strong>选择数据源</strong>
          <button class="src-close" @click="srcPickerOpen = false">×</button>
        </div>
        <div class="src-tabs">
          <button :class="{ on: srcTab === 'files' }" @click="srcTab = 'files'">已上传文件</button>
          <button :class="{ on: srcTab === 'stats' }" @click="srcTab = 'stats'">统计结果数据集</button>
        </div>
        <div class="src-list">
          <div v-if="srcLoading" class="src-empty">加载中…</div>
          <div v-else-if="srcError" class="src-empty err">{{ srcError }}</div>
          <template v-else-if="srcTab === 'files'">
            <div v-if="!srcOptions.length" class="src-empty">暂无表格类文件 — 用左下角 📎 上传 CSV/Excel</div>
            <button v-for="o in srcOptions" :key="o.key" class="src-item" @click="bindFileSource(o)">
              <span class="src-item-name">{{ o.label }}</span>
              <span class="src-item-sub">{{ o.sub }}</span>
            </button>
          </template>
          <template v-else>
            <div v-if="!srcStats.length" class="src-empty">暂无已完成的分析任务 — 去「数据分析」跑一次 17 法分析</div>
            <button v-for="s in srcStats" :key="s.id" class="src-item" @click="bindStatsSource(s)">
              <span class="src-item-name">{{ s.method ?? s.tool }} 分析</span>
              <span class="src-item-sub">{{ (s.created_at ?? "").slice(0, 16).replace("T", " ") }}</span>
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viz-chat-panel-v2 {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  font-family: PingFang SC, Microsoft YaHei, sans-serif;
}
.chat-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: thin;
  scrollbar-color: #c4b5e0 #212C45;
}
.chat-welcome {
  padding: 24px 8px;
  text-align: center;
}
.welcome-title { font-size: 16px; font-weight: 700; color: #E8EEF7; margin-bottom: 6px; }
.chat-welcome p { font-size: 12px; color: #8B9BB1; margin: 0 0 10px; }
.welcome-note { font-size: 11px !important; color: #7A8AA0 !important; margin-bottom: 14px !important; }
.welcome-note b { color: #d9a441; font-weight: 600; }
.quick-templates { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
.quick-chip {
  padding: 5px 12px;
  font-size: 11.5px;
  border: 1px solid #46587A;
  border-radius: 14px;
  background: #11192C;
  color: #A3B3C8;
  cursor: pointer;
}
.quick-chip:hover { border-color: #4D84CB; color: #4D84CB; }
.chat-msg { min-width: 0; }
.msg-bubble {
  padding: 9px 13px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}
.user-bubble {
  background: #2563eb;
  color: #F1F5F9;
  margin-left: 40px;
}
.assistant-block { display: flex; flex-direction: column; gap: 8px; }
.assistant-bubble {
  background: #212C45;
  color: #E8EEF7;
  margin-right: 30px;
  max-width: 100%;
}
.goal-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 3px 4px;
  background: #11192C;
  border-radius: 6px;
}
.goal-rule { width: 16px; height: 2px; flex: 0 0 16px; background: #9aa9ba; }
.goal-text { color: #34445a; font-size: 12px; font-weight: 600; line-height: 1.45; }
.thinking-trace { width: min(100%, 520px); margin: 4px 0 8px; color: #A3B3C8; }
.thinking-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 26px;
  padding: 3px 7px;
  border: 0;
  background: #161F33;
  color: #A3B3C8;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
  border-radius: 6px 6px 0 0;
}
.thinking-state { margin-left: auto; color: #7A8AA0; font-size: 10px; }
.thinking-body {
  max-height: 138px;
  margin: 0;
  overflow-y: auto;
  padding: 5px 8px 7px;
  border-top: 1px solid #e5e8ec;
  background: #161F33;
  border-radius: 0 0 6px 6px;
}
.thinking-entry {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 20px;
  color: #7c8795;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
}
.entry-title { flex: 0 0 auto; color: #5f6c7b; }
.entry-detail {
  min-width: 0;
  overflow: hidden;
  color: #97a1ad;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chart-figure { position: relative; max-width: 480px; }
.chart-img { max-width: 100%; max-height: 320px; border-radius: 8px; border: 1px solid #222F44; }
.chart-type-chip {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 2px 8px;
  font-size: 10px;
  background: rgba(30, 41, 59, 0.75);
  color: #F1F5F9;
  border-radius: 10px;
}
.code-card { border: 1px solid #DCE6F2; border-radius: 8px; overflow: hidden; max-width: 480px; }
.code-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 10px;
  background: #1e293b;
  color: #46587A;
  font-size: 11px;
}
.code-head button {
  border: 0;
  background: #DCE6F2;
  color: #222F44;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.code-body {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  padding: 10px;
  background: #0f172a;
  color: #a5b4fc;
  font-size: 11px;
  line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
}
.tool-activities { display: flex; flex-direction: column; gap: 3px; }
.tool-activity {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #8B9BB1;
  font-family: ui-monospace, SFMono-Regular, monospace;
}
.tool-dot { width: 7px; height: 7px; border-radius: 50%; background: #46587A; flex: 0 0 auto; }
.tool-running .tool-dot { background: #4D84CB; animation: pulse 1s infinite; }
.tool-done .tool-dot { background: #5FD0B4; }
.tool-failed .tool-dot { background: #d75e5e; }
.tool-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
  color: #7A8AA0;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
.msg-error {
  padding: 8px 11px;
  font-size: 12px;
  border: 1px solid #3A2323;
  border-radius: 8px;
  background: #2A1C1C;
  color: #dc2626;
}
.system-card {
  padding: 9px 12px;
  border: 1px solid #222F44;
  border-radius: 9px;
  background: #11192C;
  font-size: 12px;
  color: #DCE6F2;
  line-height: 1.6;
}
.typing-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  font-size: 11px;
  color: #7A8AA0;
}
.typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4D84CB;
  animation: blink 1.2s infinite;
}
.typing-dot:nth-child(2) { animation-delay: 0.2s; }
.typing-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 1; }
}
.chat-composer {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 12px 10px;
  border-top: 1px solid #222F44;
  background: #11192C;
}
.composer-attach { flex-shrink: 0; }
.attach-btn {
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border: 1px solid #222F44;
  border-radius: 8px;
  cursor: pointer;
  font-size: 15px;
}
.composer-input {
  flex: 1;
  resize: none;
  border: 1px solid #222F44;
  border-radius: 10px;
  padding: 8px 11px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  max-height: 120px;
  outline: none;
  background: #1A2333;
}
.composer-input:focus { border-color: #4D84CB; background: #11192C; }
.composer-side {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}
.token-est { font-size: 9.5px; color: #7A8AA0; }
.send-btn {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 50%;
  background: #4D84CB;
  color: #F1F5F9;
  font-size: 15px;
  cursor: pointer;
}
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.send-btn.stop { background: #dc2626; }

/* ── 控制栏拖拽手柄(所有可拖边界共用) ── */
.ctl-grip {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  cursor: ns-resize;
  background: transparent;
  z-index: 5;
}
.ctl-grip::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  width: 34px;
  height: 2px;
  border-radius: 1px;
  background: #46587A;
  opacity: 0;
  transition: opacity 0.15s;
}
.ctl-grip:hover::after { opacity: 1; }
.ctl-grip:hover { background: rgba(77, 132, 203, 0.14); }

/* ── 模型 + 技能条 ── */
.legend-bar {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 12px 7px;
  border-top: 1px solid #222F44;
  background: #11192C;
  overflow-y: auto;
}
.legend-row { display: flex; align-items: center; gap: 6px; min-height: 24px; }
.legend-label {
  flex: 0 0 30px;
  font-size: 10px;
  color: #7A8AA0;
  letter-spacing: 0.5px;
}
.legend-hint { font-size: 10px; color: #7A8AA0; }
.model-select {
  flex: 1;
  min-width: 0;
  max-width: 260px;
  padding: 3px 8px;
  border: 1px solid #46587A;
  border-radius: 6px;
  background: #1A2333;
  color: #DCE6F2;
  font-size: 11px;
  outline: none;
  cursor: pointer;
}
.model-select:hover { border-color: #4D84CB; }
.model-select option { background: #1A2333; color: #DCE6F2; }
.legend-row.skills { flex-wrap: wrap; }
.skill-chip {
  padding: 3px 10px;
  border: 1px solid #46587A;
  border-radius: 13px;
  background: #1A2333;
  color: #A3B3C8;
  font-size: 10.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}
.skill-chip:hover { border-color: #4D84CB; background: #1E2A48; color: #8FD0FF; transform: translateY(-1px); }

/* ── 数据源条(真实数据 vs 示意图, 必须一眼可辨) ── */
.data-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border-top: 1px solid #222F44;
  background: #161F33;
  font-size: 11px;
  min-height: 30px;
}
.data-dot { width: 7px; height: 7px; border-radius: 50%; background: #d9a441; flex: 0 0 auto; }
.data-bar.bound .data-dot { background: #5FD0B4; }
.data-name { color: #E8EEF7; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
.data-name.warn { color: #d9a441; font-weight: 500; }
.data-meta { color: #7A8AA0; flex: 0 0 auto; }
.data-btn {
  margin-left: auto;
  border: 1px solid #46587A;
  border-radius: 6px;
  background: #11192C;
  color: #A3B3C8;
  font-size: 10.5px;
  padding: 2px 8px;
  cursor: pointer;
  flex: 0 0 auto;
}
.data-btn:hover { border-color: #4D84CB; color: #4D84CB; }
.data-btn.ghost { margin-left: 0; border-color: transparent; }
.data-btn.ghost:hover { color: #F08A8A; border-color: transparent; }

/* ── 出版规范条 ── */
.spec-bar { position: relative; flex-shrink: 0; border-top: 1px solid #222F44; background: #11192C; overflow-y: auto; }
.spec-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 12px;
  border: 0;
  background: transparent;
  color: #A3B3C8;
  font-size: 11px;
  cursor: pointer;
  text-align: left;
}
.spec-toggle:hover { background: #161F33; }
.chev { transition: transform 0.15s; display: inline-block; }
.chev.open { transform: rotate(90deg); }
.spec-now { margin-left: auto; color: #7A8AA0; font-size: 10px; }
.spec-body { padding: 4px 12px 10px; display: flex; flex-direction: column; gap: 6px; }
.spec-row { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; }
.spec-label { font-size: 10px; color: #7A8AA0; flex: 0 0 30px; }
.spec-chip {
  border: 1px solid #46587A;
  border-radius: 12px;
  background: #1A2333;
  color: #A3B3C8;
  font-size: 10px;
  padding: 2px 9px;
  cursor: pointer;
}
.spec-chip:hover { border-color: #4D84CB; }
.spec-chip.on { border-color: #4D84CB; background: #1E2A48; color: #8FD0FF; }
.spec-num { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; color: #8B9BB1; }
.spec-num input {
  width: 52px;
  border: 1px solid #46587A;
  border-radius: 5px;
  background: #1A2333;
  color: #E8EEF7;
  font-size: 10px;
  padding: 2px 5px;
}

/* ── 数据源选择器弹层 ── */
.src-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 12, 22, 0.62);
}
.src-dialog {
  width: min(460px, 92vw);
  max-height: 74vh;
  display: flex;
  flex-direction: column;
  border: 1px solid #2C3A55;
  border-radius: 12px;
  background: #11192C;
  overflow: hidden;
}
.src-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #222F44;
  color: #E8EEF7;
  font-size: 13px;
}
.src-close { border: 0; background: transparent; color: #7A8AA0; font-size: 18px; cursor: pointer; line-height: 1; }
.src-close:hover { color: #E8EEF7; }
.src-tabs { display: flex; gap: 4px; padding: 8px 12px 0; }
.src-tabs button {
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #8B9BB1;
  font-size: 11.5px;
  padding: 5px 10px;
  cursor: pointer;
}
.src-tabs button.on { color: #8FD0FF; border-bottom-color: #4D84CB; font-weight: 600; }
.src-list { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 14px; display: flex; flex-direction: column; gap: 5px; }
.src-empty { padding: 26px 10px; text-align: center; color: #7A8AA0; font-size: 11.5px; line-height: 1.7; }
.src-empty.err { color: #F08A8A; }
.src-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 11px;
  border: 1px solid #222F44;
  border-radius: 8px;
  background: #1A2333;
  cursor: pointer;
  text-align: left;
}
.src-item:hover { border-color: #4D84CB; background: #1E2A48; }
.src-item-name { color: #E8EEF7; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.src-item-sub { margin-left: auto; flex: 0 0 auto; color: #7A8AA0; font-size: 10.5px; }
</style>
