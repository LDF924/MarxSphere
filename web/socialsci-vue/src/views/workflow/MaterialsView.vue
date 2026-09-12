<script setup lang="ts">
/**
 * MaterialsView(Phase3 素材准备) — 还原自闭源 MaterialsView-CW_9_w3K.js(10 组件, 核心形态还原)
 * 5 分类手风琴(文献检索/表格素材/理论素材/数据分析素材/附件素材) + AI 生成 + 手动添加 + 发布版本
 * 数据: 后端 research_materials CRUD + 素材节点; kind: citation/theory/data_result/figure/file
 */
import { ref, computed, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useWorkflowStore } from "./stores/workflow";
import { q } from "@/shared/api";
import { toast, confirmDialog } from "@/shared/ui";
import { putNode } from "@/shared/tasks";
import PhaseProgressBar from "./PhaseProgressBar.vue";

const router = useRouter();
const store = useWorkflowStore();

interface Material {
  id: string;
  kind: string; // literature/citation | data | table | theory | dataAnalysis | document
  title: string;
  content?: string;
  contentMd?: string;
  caption?: string;
  sectionId?: string;
  createdAt?: string;
  tableData?: { columns: string[]; rows: unknown[][] };
  references?: Array<{ title: string; author?: string; source?: string; year?: string; gbRef?: string }>;
  source?: { sourceStatus?: { wanfang?: string; ncpssd?: string } };
}

const materials = ref<Material[]>([]);
const expandedCats = ref<Set<string>>(new Set(["literature"]));
const publishing = ref(false);
const editDialog = ref<{ open: boolean; kind: string; material: Material }>({ open: false, kind: "literature", material: {} as Material });

// ── 5 分类定义(闭源 ze L4419-4468) ──
const CATS = [
  { key: "literature", label: "文献检索", icon: "📚", aiAction: "检索文献", manualAction: "手动添加文献", kinds: ["literature", "citation"] },
  { key: "data", label: "表格素材", icon: "📊", aiAction: "生成表格", manualAction: "添加表格", kinds: ["table", "data"] },
  { key: "theory", label: "理论素材", icon: "📖", aiAction: "生成理论", manualAction: "添加理论", kinds: ["theory"] },
  { key: "dataAnalysis", label: "数据分析素材", icon: "📈", aiAction: "上传图片", manualAction: "", kinds: ["data_result", "figure", "chart"] },
  { key: "document", label: "附件素材", icon: "📎", aiAction: "上传附件", manualAction: "", kinds: ["file", "document"] }
];
const catOf = (kind: string): string => {
  // 归一化键直接命中(loadMaterials 已 normalizeKind 成 CATS.key)
  if (CATS.some((c) => c.key === kind)) return kind;
  for (const c of CATS) if (c.kinds.includes(kind)) return c.key;
  return "document";
};
/** B5: 文献来源徽章(闭源: platformType wanfang/ncpssd=文献库检索 / internal_knowledge_base=内部资料; source.sourceStatus completed/empty/failed) */
function mKindBadge(m: Material): { text: string; cls: string } | null {
  const ss = (m.source?.sourceStatus ?? {}) as Record<string, string>;
  const st = ss.ncpssd || ss.wanfang || "";
  const pt = String((m as { platformType?: string }).platformType ?? (m as { sourceType?: string }).sourceType ?? "").toLowerCase();
  // 无平台亦无检索状态 → 不显示徽章(闭源仅对真实检索/导入素材打标)
  if (!pt && !st) return null;
  const base = !pt || pt === "wanfang" || pt === "ncpssd" || pt === "literature" ? "文献库检索" : pt === "internal_knowledge_base" ? "内部资料" : "";
  if (!base) return null;
  if (st === "completed") return { text: base + "已用", cls: "src-blue" };
  if (st === "empty") return { text: base + "无结果", cls: "src-gray" };
  if (st === "failed") return { text: base + "失败", cls: "src-red" };
  return { text: base, cls: "src-plain" };
}
// 图片全屏预览层状态(闭源: Teleport 遮罩 + img max-h 85vh)
const imagePreviewSrc = ref("");
function openImagePreview(src: string) {
  if (src) imagePreviewSrc.value = String(src);
}
function closeImagePreview() { imagePreviewSrc.value = ""; }

const grouped = computed(() => {
  const out: Record<string, Material[]> = {};
  for (const c of CATS) out[c.key] = [];
  for (const m of materials.value) {
    const k = catOf(String(m.kind ?? ""));
    (out[k] ?? out.document).push(m);
  }
  return out;
});
const catCount = (key: string) => (grouped.value[key] ?? []).length;

function toggleCat(key: string) {
  const next = new Set(expandedCats.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedCats.value = next;
}

// ── 素材 API(后端 research_materials) ──
async function loadMaterials() {
  if (!store.taskId) return;
  try {
    const r = await q<{ materials?: Material[]; items?: Material[] }>(`/research/materials?projectId=${store.taskId}`);
    const list = (r.materials ?? r.items ?? []).map((m) => ({ ...m, kind: normalizeKind(String(m.kind ?? "")) }));
    materials.value = list;
  } catch {
    materials.value = [];
  }
}
function normalizeKind(k: string): string {
  if (["literature", "citation"].includes(k)) return "literature";
  if (k === "table") return "data";
  if (["figure", "chart", "data_result", "image"].includes(k)) return "dataAnalysis";
  if (k === "file") return "document";
  return k;
}

async function createMaterial(body: Record<string, unknown>): Promise<Material | null> {
  try {
    const r = await q<{ material?: Material; data?: Material; id?: string }>(`/research/materials`, {
      method: "POST",
      body: { projectId: store.taskId, ...body }
    });
    // 契约: 我方后端 POST → {id}(无嵌套对象); 闭源 → {material}
    if (r.material || r.data) return (r.material ?? r.data ?? null) as Material | null;
    return r.id ? ({ id: r.id } as Material) : null;
  } catch {
    return null;
  }
}

// ── AI 生成(走 phase3 后台 job → 泵执行 → 产物为 citation/theory/data_result 素材; 单类弹层见 B4) ──
async function aiGenerate(catKey: string) {
  if (!store.taskId) {
    toast("请先完成信息录入", "warning");
    return;
  }
  // B4: 单类生成进阶弹层(闭源 MaterialGenerateDialog: 关联章节 select + 表类型 radio + 流式预览)
  openGenDialog(catKey);
}

// ── 手动添加 ──

// ── B4 单类生成弹层(闭源 MaterialGenerateDialog: 标题/提示/变量 chips/生成要求/表类型 radio/关联章节 select/生成→预览→完成) ──
interface GenDialogState {
  open: boolean;
  catKey: string;
  generating: boolean;
  preview: string;      // 生成预览(轮询完成 → 结果文本)
  streaming: boolean;
  tableType: string;    // text(文本表)/comparison(文本对比表)/data(数据表)
  sectionId: string;
  prompt: string;
  phaseText: string;
}
const genDialog = ref<GenDialogState>({
  open: false, catKey: "", generating: false, preview: "", streaming: false,
  tableType: "comparison", sectionId: "", prompt: "", phaseText: ""
});
const genPollTimer = ref<ReturnType<typeof setInterval> | null>(null);
const genTaskId = ref("");
const genCatLabel = computed(() => CATS.find((c) => c.key === genDialog.value.catKey)?.label ?? "");
const genDialogTitle = computed(() => (genDialog.value.catKey === "literature" ? "检索文献" : `生成${genCatLabel.value}`));
const genPromptHint = computed(() =>
  genDialog.value.catKey === "literature"
    ? "输入研究主题或关键词, 系统将从文献库检索相关文献并生成 GB/T 7714 引用。"
    : genDialog.value.catKey === "data"
      ? "描述需要设计/呈现的表格内容与论证目的, 可选择文本对比表或数据表。"
      : "描述本节所需的理论梳理内容, 系统将生成核心理论框架。");
const genPlaceholder = computed(() =>
  genDialog.value.catKey === "literature"
    ? "如: 数字普惠金融 中小企业融资约束"
    : genDialog.value.catKey === "data"
      ? "如: 不同规模企业融资约束的对比"
      : "如: 信息不对称理论在中小企业融资中的适用性");

function openGenDialog(catKey: string) {
  if (!store.level1Sections.length) { toast("请先完成科研架构", "warning"); return; }
  genDialog.value = {
    open: true, catKey, generating: false, preview: "", streaming: false,
    tableType: "comparison", sectionId: store.level1Sections[0]?.id ?? "",
    prompt: catKey === "literature" ? store.input.title : "", phaseText: ""
  };
  genTaskId.value = "";
}
function closeGenDialog() {
  if (genDialog.value.generating) return;
  stopGenDialogPoll();
  genDialog.value.open = false;
}
function stopGenDialogPoll() {
  if (genPollTimer.value) { clearInterval(genPollTimer.value); genPollTimer.value = null; }
}
function pickGenTableType(t: string) { genDialog.value.tableType = t; }

/** 开始生成: 建 job(jobKind: literature-search / table-generate / theory-generate) → 轮询 → 结果拼预览 */
async function runGenStart() {
  const d = genDialog.value;
  if (!d.prompt.trim()) { toast("请输入生成要求", "warning"); return; }
  if (!d.sectionId) { toast("请先选择关联章节", "warning"); return; }
  const secTitle = store.sections.find((s) => s.id === d.sectionId)?.title ?? "";
  d.generating = true;
  d.streaming = true;
  d.preview = "";
  d.phaseText = "排队中...";
  const jobKind = d.catKey === "literature" ? "literature-search" : d.catKey === "data" ? "table-generate" : "theory-generate";
  const cat = CATS.find((c) => c.key === d.catKey);
  try {
    const { createTask } = await import("@/shared/tasks");
    const t = await createTask({
      title: `${genCatLabel.value}生成`,
      projectId: store.taskId,
      module: "workflow",
      jobKind,
      goal: store.input.title,
      phase: 3,
      phaseLabel: "素材准备",
      inputSnapshot: {
        sectionId: d.sectionId,
        sectionTitle: secTitle,
        keywords: [d.prompt],
        prompt: d.prompt,
        title: d.prompt.slice(0, 60),
        ...(jobKind === "table-generate" ? { tableType: d.tableType } : {})
      }
    });
    genTaskId.value = t.id;
    pollGenTask(t.id);
  } catch (e) {
    d.generating = false;
    d.streaming = false;
    toast("启动失败: " + String((e as Error).message ?? e), "error");
  }
}

/** 轮询 job(800ms): 阶段实时 → 完成后从 result structured/素材库拉预览 */
function pollGenTask(taskId: string) {
  stopGenDialogPoll();
  genPollTimer.value = setInterval(async () => {
    try {
      const { getTask } = await import("@/shared/tasks");
      const t = await getTask(taskId);
      if (!t) return;
      const d = genDialog.value;
      if (t.progress?.stage) d.phaseText = String(t.progress.stage);
      const total = t.progress?.total ?? 0;
      const cur = t.progress?.current ?? 0;
      d.phaseText = total ? `${d.phaseText}(${cur}/${total})` : d.phaseText;
      if (t.status === "done" || t.status === "completed") {
        stopGenDialogPoll();
        d.streaming = false;
        d.generating = false;
        // 生成即落库 → 取最新素材(sourceRef=taskId)拼预览
        d.preview = await buildGenPreview(taskId);
        d.phaseText = "生成完成";
        toast("生成完成, 请确认内容后保存", "success");
      } else if (t.status === "failed" || t.status === "cancelled") {
        stopGenDialogPoll();
        d.generating = false;
        d.streaming = false;
        const msg = String((t as { error?: { message?: string } }).error?.message ?? (t as { result?: { error?: string } }).result?.error ?? "生成失败");
        toast(msg, "error");
      }
    } catch { /* 容忍 */ }
  }, 800);
}
/** 预览文本: job 产物素材内容(exec 落库)或 result structured 兜底 */
async function buildGenPreview(taskId: string): Promise<string> {
  try {
    const r = await q<{ materials?: Array<{ id: string; sourceRef?: string; contentMd?: string; references?: unknown[]; title?: string }> }>(`/research/materials?projectId=${store.taskId}`);
    const mine = (r.materials ?? []).filter((m) => m.sourceRef === taskId || m.id === taskId);
    if (mine.length) {
      return mine.map((m) => `【${m.title ?? "素材"}】\n${String(m.contentMd ?? "").slice(0, 1200)}`).join("\n\n");
    }
  } catch { /* 兜底 result */ }
  const t = await (await import("@/shared/tasks")).getTask(taskId).catch(() => null);
  const res = (t?.result ?? {}) as { text?: string; structured?: { queries?: string[]; theory?: { name?: string; core?: string }; tables?: Array<{ title?: string; columns?: string[] }> } };
  const st = res.structured;
  if (st?.theory?.core) return `【理论框架 · ${st.theory.name ?? ""}】\n${st.theory.core}`;
  if (st?.queries) return `【检索词】\n${st.queries.join("\n")}`;
  if (st?.tables) return st.tables.map((tb) => `- ${tb.title}: [${(tb.columns ?? []).join(" | ")}]`).join("\n");
  return res.text ?? "生成完成";
}

/** 完成: 保存(素材已自动入库, 关闭并刷新列表) */
async function finishGenSave() {
  const d = genDialog.value;
  if (d.catKey === "literature" && !d.preview) {
    toast("请先完成生成", "warning");
    return;
  }
  stopGenDialogPoll();
  d.open = false;
  await loadMaterials();
  toast(`${genCatLabel.value}已保存到素材库`, "success");
}


// ── B2 文献批量解析(闭源 la(): DOI/年份/APA·GB 混合; 空条目工厂/单条解析/批量粘贴) ──
const REF_KEYS = ["title", "author", "source", "journal", "year", "volume", "issue", "pages", "doi", "abstract"];
function emptyRef(): Record<string, string> {
  const r: Record<string, string> = {};
  for (const k of REF_KEYS) r[k] = "";
  return r;
}
function parseSingleRef(raw: string): Record<string, string> {
  const r = emptyRef();
  const t = String(raw ?? "").trim();
  if (!t) return r;
  // DOI: 10.xxxx/xxx
  const doiM = t.match(/10\.\d{4,}\/\S+/);
  if (doiM) r.doi = doiM[0].replace(/[.,;]$/, "");
  // 年份
  const yrM = t.match(/\(?(\d{4})\)?/);
  if (yrM) r.year = yrM[1];
  // 期刊(【来源】或 [J]. 前或 刊名 年 卷(期): 页)
  const srcM = t.match(/(?:【来源】|\[J\]\.?\s*|,\s*)([^,;]+?)(?:,?\s*\d{4}|$)/);
  // 简化: 作者 + 题名拆(【作者】/【题目】标记优先)
  const authM = t.match(/【作者】([^【]+)/);
  const titM = t.match(/【题目】([^【]+)/);
  if (authM) r.author = authM[1].trim();
  if (titM) r.title = titM[1].trim();
  // 无标记: GB 风格 '作者. 题名[J]. 刊名, 年'
  const gb = t.match(/^([^\[.]+?)[.。]\s*([^\[.]+?)\[J\][.]\s*([^,，]+?)[,，]\s*(\d{4})/);
  if (!r.title) {
    if (gb) { r.author = gb[1].trim(); r.title = gb[2].trim(); r.source = gb[3].trim(); r.year = gb[4]; }
    else r.title = t.slice(0, 60);
  }
  return r;
}
function parseBulkRefs(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const lines = String(text ?? "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const ref = parseSingleRef(line);
    if (ref.title || ref.doi || ref.author) out.push(ref);
  }
  return out;
}
const bulkRefText = ref("");
const parsedRefs = ref<Record<string, string>[]>([]);
function runBulkParse() {
  const arr = parseBulkRefs(bulkRefText.value);
  parsedRefs.value = arr;
  if (!arr.length) toast("未识别到有效文献, 请检查格式", "warning");
  else toast(`已批量解析 ${arr.length} 条文献, 请核对字段`, "success");
}
function applyParsedRefs() {
  // 合并进编辑中素材: content 按闭源格式 '1.【题目】..【作者】..【来源】..【年份】..【DOI】..'
  const m = editDialog.value.material;
  const parts = parsedRefs.value.map((r) => {
    return `【题目】${r.title}【作者】${r.author}【来源】${r.source}【年份】${r.year}【DOI】${r.doi}`;
  });
  m.content = (m.content ? m.content + "\n" : "") + parts.map((p, i) => `${i + 1}.${p}`).join("\n");
  parsedRefs.value = [];
  bulkRefText.value = "";
  toast("已应用批量解析结果", "success");
}

// ── 手动添加 ──
function openAdd(kind: string) {
  editDialog.value = { open: true, kind, material: { id: "", kind, title: "", content: "" } };
}
function closeAdd() {
  editDialog.value.open = false;
}
async function saveManual() {
  const m = editDialog.value.material;
  if (!m.title?.trim()) {
    toast("请填写标题", "warning");
    return;
  }
  // kindMap: 手动添加物料的落库 kind 与列表分组语义一致 —
  // 表格素材 → table(后端白名单外仍可存; normalizeKind 归 data/表格素材),
  // 数据分析素材(上传图/实证产物) → figure/data_result 归 dataAnalysis
  const kindMap: Record<string, string> = { literature: "citation", data: "table", theory: "theory", dataAnalysis: "figure", document: "file" };
  const created = await createMaterial({
    kind: kindMap[editDialog.value.kind] ?? editDialog.value.kind,
    title: m.title,
    contentMd: m.content ?? "",
    sectionIds: store.level1Sections.length ? [store.level1Sections[0].id] : []
  });
  if (created) {
    toast("素材已添加", "success");
    closeAdd();
    await loadMaterials();
  } else {
    toast("添加失败", "error");
  }
}

// ── 素材文件上传(闭源上传语义; 图→data-url 素材; 附件→extract-text 抽文本入 contentMd) ──
async function uploadMaterialFile(catKey: string, file: File | undefined) {
  if (!file) return;
  const isImg = catKey === "dataAnalysis";
  const maxImg = 8 * 1024 * 1024;
  const maxFile = 25 * 1024 * 1024;
  if (file.size > (isImg ? maxImg : maxFile)) {
    toast(`文件超过大小限制(${isImg ? "8MB" : "25MB"})`, "warning");
    return;
  }
  const toDataUrl = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result ?? ""));
      r.onerror = () => reject(new Error("文件读取失败"));
      r.readAsDataURL(f);
    });
  try {
    if (isImg) {
      const dataUrl = await toDataUrl(file);
      const created = await createMaterial({
        kind: "figure",
        title: file.name.replace(/\.(png|jpe?g|webp)$/i, ""),
        contentMd: `![${file.name}](${dataUrl})`,
        caption: file.name,
        sectionIds: store.level1Sections.length ? [store.level1Sections[0].id] : []
      });
      if (created) { toast("图片已上传为素材", "success"); await loadMaterials(); }
      else toast("上传失败", "error");
      return;
    }
    // 附件: 文本类直接读; docx/pdf 走后端 extract-text
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    let text = "";
    if (["txt", "md", "csv", "tsv"].includes(ext)) {
      text = await file.text();
    } else {
      const base64 = await toDataUrl(file);
      const r = await q<{ ok?: boolean; text?: string; error?: string }>("/files/extract-text", {
        method: "POST",
        body: { filename: file.name, base64, mime: file.type }
      }).catch((e) => ({ ok: false as const, error: String((e as { message?: string }).message ?? e) }));
      if (!r?.ok) { toast((r as { error?: string }).error ?? "文件解析失败(不支持的类型?)", "error"); return; }
      text = (r as { text?: string }).text ?? "";
    }
    const created = await createMaterial({
      kind: "file",
      title: file.name,
      contentMd: text.slice(0, 100_000),
      sectionIds: store.level1Sections.length ? [store.level1Sections[0].id] : []
    });
    if (created) { toast("附件已上传为素材", "success"); await loadMaterials(); }
    else toast("上传失败", "error");
  } catch (e) {
    toast(`上传失败: ${(e as Error).message}`, "error");
  }
}

async function removeMaterial(m: Material) {  const ok = await confirmDialog({ message: `确定删除「${m.title}」?`, title: "删除素材", okText: "删除", danger: true });
  if (!ok) return;
  try {
    await q(`/research/materials/${m.id}`, { method: "DELETE" });
    toast("已删除", "success");
    await loadMaterials();
  } catch {
    toast("删除失败", "error");
  }
}

// ── B1 智能生成执行计划(闭源 na composable: 计划 → 确认弹层三段 checkbox → 逐段执行) ──
interface PlanItem { _enabled: boolean; sectionId?: string; sectionTitle?: string; keywords?: string[]; title?: string; columns?: string[]; count?: number }
const planDialog = ref<{ open: boolean; state: "running" | "ready" | "executing" | "failed"; plan?: { literatureSearch: PlanItem[]; textTables: PlanItem[]; dataAnalysis: PlanItem[] }; counts?: { lit: number; tab: number; ana: number }; msg?: string }>({ open: false, state: "running" });
let planJobId = ref("");

async function generatePlan() {
  if (!store.taskId) { toast("请先完成信息录入", "warning"); return; }
  planDialog.value = { open: true, state: "running", msg: "正在分析论文框架, 生成执行计划..." };
  try {
    const { createTask } = await import("@/shared/tasks");
    const t = await createTask({
      title: "素材生成计划",
      projectId: store.taskId, module: "workflow", jobKind: "material-plan",
      goal: store.input.title, phase: 3, phaseLabel: "素材准备",
      inputSnapshot: {
        l1Sections: store.level1Sections.map((s) => ({ id: s.id, title: s.title })),
        variables: store.variables.map((v) => ({ name: v.name, role: v.role })),
        hasDataFile: !!store.statisticsFileId
      }
    });
    planJobId.value = t.id;
    pollPlan(t.id);
  } catch (e) {
    planDialog.value.state = "failed";
    planDialog.value.msg = String((e as Error).message ?? e);
  }
}
function pollPlan(taskId: string) {
  stopPlanPoll();
  planPollTimer.value = setInterval(async () => {
    try {
      const { getTask } = await import("@/shared/tasks");
      const t = await getTask(taskId);
      if (!t) return;
      // 弹层已被用户关闭(或执行中)→ 只收尾不复活界面
      const stillOpen = planDialog.value.open && planDialog.value.state === "running";
      if (t.status === "done" || t.status === "completed") {
        stopPlanPoll();
        const res = (t.result ?? {}) as { structured?: { plan?: { literatureSearch?: PlanItem[]; textTables?: PlanItem[]; dataAnalysis?: PlanItem[] } } };
        const plan = res.structured?.plan;
        if (plan && stillOpen) {
          const norm = (arr?: PlanItem[]) => (Array.isArray(arr) ? arr.map((x) => ({ ...x, _enabled: x._enabled !== false })) : []);
          planDialog.value = {
            open: true, state: "ready",
            plan: { literatureSearch: norm(plan.literatureSearch), textTables: norm(plan.textTables), dataAnalysis: norm(plan.dataAnalysis) },
            counts: { lit: (plan.literatureSearch ?? []).length, tab: (plan.textTables ?? []).length, ana: (plan.dataAnalysis ?? []).length }
          };
          if (!(plan.literatureSearch?.length || plan.textTables?.length || plan.dataAnalysis?.length)) {
            planDialog.value.state = "ready";
            planDialog.value.msg = "当前不需要生成额外素材";
          }
        }
      } else if (t.status === "failed" || t.status === "cancelled") {
        stopPlanPoll();
        if (stillOpen) {
          planDialog.value.state = "failed";
          planDialog.value.msg = "执行计划生成失败, 请重试";
        }
      }
    } catch { /* 容忍 */ }
  }, 800);
}
const planPollTimer = ref<ReturnType<typeof setInterval> | null>(null);
function stopPlanPoll() {
  if (planPollTimer.value) { clearInterval(planPollTimer.value); planPollTimer.value = null; }
}
/** 关闭计划弹层(任意态): 停轮询防回调复活/覆盖 */
function closePlanDialog() {
  stopPlanPoll();
  planDialog.value.open = false;
}

/** 确认执行: 逐段跑 jobKind 链(literature-search/table-generate) */
async function executePlan() {
  const plan = planDialog.value.plan;
  if (!plan) return;
  planDialog.value.state = "executing";
  const enabled = {
    lit: plan.literatureSearch.filter((x) => x._enabled),
    tab: plan.textTables.filter((x) => x._enabled),
    ana: plan.dataAnalysis.filter((x) => x._enabled)
  };
  let okLit = 0; let okTab = 0; let okAna = 0;
  const { createTask } = await import("@/shared/tasks");
  try {
    // 文献组(可并发后端 job; 逐条跑保序)
    for (const item of enabled.lit) {
      const t = await createTask({ title: `文献检索: ${item.sectionTitle ?? ""}`, projectId: store.taskId, module: "workflow", jobKind: "literature-search", goal: store.input.title, phase: 3, phaseLabel: "素材准备",
        inputSnapshot: { sectionId: item.sectionId ?? "", sectionTitle: item.sectionTitle ?? "", keywords: item.keywords ?? [], count: item.count ?? 5 } });
      await waitJobDone(t.id).then((ok) => { if (ok) okLit++; });
    }
    // 表格组
    for (const item of enabled.tab) {
      const t = await createTask({ title: `表格: ${item.title ?? ""}`, projectId: store.taskId, module: "workflow", jobKind: "table-generate", goal: store.input.title, phase: 3, phaseLabel: "素材准备",
        inputSnapshot: { sectionId: item.sectionId ?? "", sectionTitle: item.sectionTitle ?? "", title: item.title ?? "", prompt: `为「${store.input.title}」设计表格: ${item.title ?? ""}`, tableType: "text" } });
      await waitJobDone(t.id).then((ok) => { if (ok) okTab++; });
    }
    // 数据分析组(闭源 plan.dataAnalysis 段; 执行器 data-analysis 产方案素材)
    for (const item of enabled.ana) {
      const it = item as PlanItem & { analysisType?: string; variables?: string[]; methods?: string[] };
      const t = await createTask({ title: `分析: ${String(it.analysisType ?? "描述统计")}`, projectId: store.taskId, module: "workflow", jobKind: "data-analysis", goal: store.input.title, phase: 3, phaseLabel: "素材准备",
        inputSnapshot: { sectionId: item.sectionId ?? "", sectionTitle: item.sectionTitle ?? "", analysisType: it.analysisType ?? "descriptive", variables: (it.variables ?? []).map((v) => ({ name: v })), methods: it.methods ?? [] } });
      await waitJobDone(t.id).then((ok) => { if (ok) okAna++; });
    }
    await loadMaterials();
    planDialog.value = { open: false, state: "ready" };
    toast(`生成完成:${enabled.lit.length ? ` ${okLit} 个文献组,` : ""}${enabled.tab.length ? ` ${okTab} 个文本表,` : ""}${enabled.ana.length ? ` ${okAna} 个分析结果` : ""}`.replace(/, $/, ""), "success");
  } catch (e) {
    planDialog.value.state = "failed";
    planDialog.value.msg = String((e as Error).message ?? e);
  }
}
/** 等待 job done(800ms 轮询, 上限 5 分钟) */
function waitJobDone(taskId: string): Promise<boolean> {
  return new Promise((resolve) => {
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      try {
        const { getTask } = await import("@/shared/tasks");
        const t = await getTask(taskId);
        if (!t) return;
        if (t.status === "done" || t.status === "completed") { clearInterval(timer); resolve(true); }
        else if (t.status === "failed" || t.status === "cancelled") { clearInterval(timer); resolve(false); }
        else if (tries > 380) { clearInterval(timer); resolve(false); }
      } catch { /* 容忍 */ }
    }, 800);
  });
}
function togglePlanItem(section: keyof { literatureSearch: PlanItem[]; textTables: PlanItem[]; dataAnalysis: PlanItem[] }, idx: number) {
  const plan = planDialog.value.plan;
  if (!plan) return;
  plan[section][idx]._enabled = !plan[section][idx]._enabled;
}

// ── B3 编排弹层(闭源 MaterialAllocationDialog: suggestions 无 sectionId 素材 → checkbox+目标章节 select → 逐条关联) ──
interface AllocSuggestion { materialId: string; materialTitle: string; sectionId: string | null; sectionTitle: string; reason?: string; selected?: boolean }
const allocDialog = ref<{ open: boolean; loading: boolean; suggestions: AllocSuggestion[] }>({ open: false, loading: false, suggestions: [] });
const allocBusy = ref(false);
const allocErr = ref("");
/** 章节 option 文案(闭源 y(): level>1 全角空格缩进 + "└ " 前缀) */
const allocOptionLabel = (s: { id: string; title: string; level: number }) =>
  `${(s.level || 1) > 1 ? "　　".repeat((s.level || 1) - 1) + "└ " : ""}${s.title || ""}`;
const allocSelected = computed(() => allocDialog.value.suggestions.filter((s) => s.selected).length);
const allocSectionTitle = (id: string | null | undefined) =>
  (store.sections.find((s) => s.id === id)?.title) || "";

/** 编排: 请求 AI 建议(仅未关联素材) → 弹层确认(闭源 ee(): 无章节→"请先完成科研架构"; 全已关联→info; 无建议→warning) */
async function runAllocate() {
  if (!store.taskId) { toast("请先完成信息录入", "warning"); return; }
  if (!store.level1Sections.length) { toast("请先完成科研架构", "warning"); return; }
  if (!materials.value.length) { toast("请先添加素材", "warning"); return; }
  if (!materials.value.some((m) => !m.sectionId && !(m as { sectionIds?: string[] }).sectionIds?.length)) {
    toast("所有素材已关联章节", "info");
    return;
  }
  allocDialog.value.open = true;
  allocDialog.value.loading = true;
  allocErr.value = "";
  try {
    const r = await q<{ suggestions?: AllocSuggestion[] }>(`/research/materials/allocate`, {
      method: "POST",
      body: { projectId: store.taskId }
    });
    const list = (r.suggestions ?? []).filter((s) => s && s.materialId);
    // 空态文案与闭源一致: "暂无建议"
    if (!list.length) { allocDialog.value.suggestions = []; allocDialog.value.loading = false; return; }
    allocDialog.value.suggestions = list.map((s) => ({ ...s, selected: true, sectionId: s.sectionId ?? store.level1Sections[0]?.id ?? "" }));
    allocDialog.value.loading = false;
  } catch (e) {
    allocDialog.value.loading = false;
    allocErr.value = String((e as { message?: string }).message ?? e);
    toast("素材编排失败: " + allocErr.value, "error");
  }
}
function closeAllocate() {
  if (allocBusy.value) return;
  allocDialog.value.open = false;
}
/** 确认: 逐条关联(闭源 apply: 未选择→"未选择任何匹配项"; 逐条 updateMaterial {sectionId} → 计数 toast "已为 N 个素材关联章节") */
async function confirmAllocate() {
  const picked = allocDialog.value.suggestions.filter((s) => s.selected);
  if (!picked.length) { toast("未选择任何匹配项", "warning"); return; }
  allocBusy.value = true;
  try {
    let ok = 0;
    for (const s of picked) {
      try {
        await q(`/research/materials/${s.materialId}/adopt`, { method: "POST", body: { sectionIds: s.sectionId ? [s.sectionId] : [] } });
        ok++;
      } catch { /* 单条失败继续 */ }
    }
    if (ok > 0) {
      await loadMaterials();
      toast(`已为 ${ok} 个素材关联章节`, "success");
    } else {
      toast("素材编排失败：关联未生效", "error");
    }
    allocDialog.value.open = false;
  } catch { /* 容错 */ } finally {
    allocBusy.value = false;
  }
}

// ── 审查/编排 ──
async function reviewAll() {
  try {
    const r = await q<{ report?: string; reviewReport?: string }>(`/research/materials/review`, {
      method: "POST",
      body: { projectId: store.taskId }
    });
    store.materialReviewReport = String(r.report ?? r.reviewReport ?? "");
    await store.saveProject();
    toast("素材审视完成", "success");
  } catch {
    toast("审视失败", "error");
  }
}

// ── 发布版本 → Phase4(闭源 Ut(): 无素材→"请先添加素材"; 未关联→"还有 N 个素材未关联章节，请先为每个素材选择所属章节") ──
async function publishAndEnter() {
  if (!materials.value.length) {
    toast("请先添加素材", "warning");
    return;
  }
  const unassigned = materials.value.filter((m) => !m.sectionId && !(m as { sectionIds?: string[] }).sectionIds?.length);
  if (unassigned.length) {
    toast(`还有 ${unassigned.length} 个素材未关联章节，请先为每个素材选择所属章节`, "warning");
    return;
  }
  publishing.value = true;
  try {
    // publish 版本(POST publish → research_versions 指针快照)
    await q(`/research/projects/${store.taskId}/publish`, { method: "POST", body: { label: `素材版本` } }).catch(() => null);
    store.phase = 4;
    store.phaseLabel = "文本创作";
    await store.saveProject();
    toast("素材版本已发布, 进入文本创作", "success");
    void router.push("/workflow/workspace");
  } catch {
    toast("发布失败", "error");
  } finally {
    publishing.value = false;
  }
}

onMounted(async () => {
  await store.loadProject().catch(() => null);
  await loadMaterials();
  // 默认展开非空分类(闭源默认)
  const nonEmpty = Object.entries(grouped.value).filter(([, list]) => list.length).map(([k]) => k);
  if (nonEmpty.length) expandedCats.value = new Set(nonEmpty);
});
</script>

<template>
  <div class="workflow-page max-w-5xl mx-auto px-6 py-8 pb-16" data-assistant-material-count="0">
    <PhaseProgressBar />
    <h1 class="wf-h1">素材准备</h1>
    <p class="wf-sub">{{ store.title }} — 汇总文献、表格、数据与附件素材, 绑定到对应章节。</p>

    <!-- 素材标题条(单类生成进行中状态在 B4 弹层内呈现) -->
    <!-- 分类手风琴 -->
    <div class="cat-list">
      <section v-for="cat in CATS" :key="cat.key" class="cat-card">
        <div class="cat-head" @click="toggleCat(cat.key)">
          <span class="cat-icon">{{ cat.icon }}</span>
          <strong>{{ cat.label }}</strong>
          <span class="cat-count">{{ catCount(cat.key) }} 项</span>
          <span class="cat-caret">{{ expandedCats.has(cat.key) ? "▼" : "▶" }}</span>
        </div>
        <div v-if="expandedCats.has(cat.key)" class="cat-body">
          <div class="cat-actions">
            <button v-if="cat.aiAction && cat.key !== 'dataAnalysis' && cat.key !== 'document'" class="btn-ai" :disabled="genDialog.open" @click="aiGenerate(cat.key)">
              {{ cat.aiAction }}
            </button>
            <label v-if="cat.key === 'dataAnalysis' || cat.key === 'document'" class="btn-ai" style="cursor: pointer">
              {{ cat.aiAction }}
              <input
                type="file"
                :accept="cat.key === 'dataAnalysis' ? '.png,.jpg,.jpeg,.webp' : '.pdf,.docx,.txt,.md,.csv,.tsv'"
                style="display: none"
                @change="(ev) => uploadMaterialFile(cat.key, (ev.target as HTMLInputElement).files?.[0])"
              />
            </label>
            <button v-if="cat.manualAction" class="btn-manual" @click="openAdd(cat.key)">{{ cat.manualAction }}</button>
          </div>
          <div v-if="!catCount(cat.key)" class="cat-empty">暂无{{ cat.label }}素材</div>
          <div v-else class="mat-list">
            <div v-for="m in grouped[cat.key]" :key="m.id" class="mat-card">
              <div class="mat-head">
                <strong>{{ m.title || "未命名素材" }}</strong>
                <span class="mat-kind">{{ cat.label }}</span>
              </div>
              <div v-if="m.contentMd && !(m as any).imageDataUrl && !m.tableData" class="mat-content">{{ String(m.contentMd).slice(0, 120) }}</div>
              <div v-if="m.content && !m.contentMd && !(m as any).imageDataUrl" class="mat-content">{{ String(m.content).slice(0, 120) }}</div>
              <!-- B5: 图片素材预览(点击全屏放大; 闭源 imageDataUrl 语义) -->
              <div v-if="(m as any).imageDataUrl" class="mat-img">
                <img :src="(m as any).imageDataUrl" :alt="m.title" class="mat-img-src" @click="openImagePreview((m as any).imageDataUrl)" />
              </div>
              <div v-else-if="m.contentMd && /^!\[[^\]]*\]\((\/api\/[^)]+|data:image\/[^)]+)\)/.test(m.contentMd)" class="mat-img">
                <img :src="String(m.contentMd).match(/^!\[[^\]]*\]\(([^)]+)\)/)?.[1] ?? ''" :alt="m.title" class="mat-img-src" @click="openImagePreview(String(m.contentMd).match(/^!\[[^\]]*\]\(([^)]+)\)/)?.[1] ?? '')" />
              </div>
              <div v-if="m.tableData && Array.isArray((m as any).tableData?.columns) && Array.isArray((m as any).tableData?.rows)" class="mat-table">
                <table class="three-line-table">
                  <thead><tr><th v-for="c in m.tableData.columns" :key="c">{{ c }}</th></tr></thead>
                  <tbody>
                    <tr v-for="(r, ri) in m.tableData.rows.slice(0, 3)" :key="ri">
                      <td v-for="(cell, ci) in r" :key="ci">{{ cell }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="mat-foot">
                <span v-if="m.sectionId || (m as any).sectionIds?.length" class="sec-chip">📎 已关联</span>
                <!-- B5: 文献来源徽章(闭源: 文献库检索/内部资料 + sourceStatus completed/empty/failed) -->
                <span v-if="mKindBadge(m)" class="src-badge" :class="mKindBadge(m)!.cls">{{ mKindBadge(m)!.text }}</span>
                <span class="mat-date">{{ m.createdAt ? m.createdAt.slice(5, 10).replace("-", "/") : "" }}</span>
                <button v-if="!(m.sectionId || (m as any).sectionIds?.length)" class="mat-alloc" @click="runAllocate">编排</button>
                <button class="mat-del" @click="removeMaterial(m)">删除</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 审视报告 -->
    <div v-if="store.materialReviewReport" class="review-report">
      <details>
        <summary class="report-head">素材审视报告</summary>
        <pre class="report-body markdown-body">{{ store.materialReviewReport }}</pre>
      </details>
    </div>

    <!-- 底部操作 -->
    <div class="wf-actions">
      <button class="btn-back" @click="router.push('/workflow/sections')">返回章节清单</button>
      <button class="btn-ghost-red" @click="reviewAll">审视素材</button>
      <button class="btn-alloc-cta" data-assistant-control="materials_allocate" :disabled="publishing || !materials.length" @click="runAllocate">编排素材</button>
      <button class="btn-smart" data-assistant-control="materials_smart_generate" @click="generatePlan">⚡ 智能生成素材</button>
      <button class="btn-primary" data-assistant-control="workflow_confirm_materials" :disabled="publishing" @click="publishAndEnter">
        {{ publishing ? "发布中…" : "确认并进入创作" }}
      </button>
    </div>

    <!-- B1 智能生成执行计划弹层 -->
    <Teleport to="body">
      <div v-if="planDialog.open" class="modal-mask" @click.self="planDialog.state !== 'executing' && closePlanDialog()">
        <div class="modal-card plan-modal">
          <div class="modal-head">
            <h3>素材生成执行计划</h3>
            <button class="modal-x" @click="planDialog.state !== 'executing' && closePlanDialog()">×</button>
          </div>
          <div class="modal-body">
            <!-- 计划生成中 -->
            <div v-if="planDialog.state === 'running'" class="plan-state running">
              <span class="job-spinner"></span>
              <p>{{ planDialog.msg || "正在分析论文框架, 生成执行计划..." }}</p>
            </div>
            <!-- 执行失败 -->
            <div v-else-if="planDialog.state === 'failed'" class="plan-state failed">
              <p>⚠ {{ planDialog.msg || "执行计划生成失败" }}</p>
              <button class="btn-smart" @click="generatePlan">重新生成</button>
            </div>
            <!-- 就绪: 三段 checkbox -->
            <div v-else-if="planDialog.state === 'ready' && planDialog.plan" class="plan-ready">
              <p v-if="planDialog.msg" class="plan-empty-note">{{ planDialog.msg }}</p>
              <!-- 文献检索 -->
              <div v-if="planDialog.plan.literatureSearch.length" class="plan-section">
                <div class="plan-sec-head">
                  <strong>文献检索</strong>
                  <span>{{ planDialog.plan.literatureSearch.filter((x) => x._enabled).length }}/{{ planDialog.plan.literatureSearch.length }} 组</span>
                </div>
                <label v-for="(item, i) in planDialog.plan.literatureSearch" :key="i" class="plan-check">
                  <input type="checkbox" :checked="item._enabled" @change="togglePlanItem('literatureSearch', i)" />
                  <span>{{ item.sectionTitle || "全文" }} — {{ (item.keywords ?? []).join("、").slice(0, 40) }}</span>
                </label>
              </div>
              <!-- 文本表 -->
              <div v-if="planDialog.plan.textTables.length" class="plan-section">
                <div class="plan-sec-head">
                  <strong>文本表生成</strong>
                  <span>{{ planDialog.plan.textTables.filter((x) => x._enabled).length }}/{{ planDialog.plan.textTables.length }} 个</span>
                </div>
                <label v-for="(item, i) in planDialog.plan.textTables" :key="i" class="plan-check">
                  <input type="checkbox" :checked="item._enabled" @change="togglePlanItem('textTables', i)" />
                  <span>{{ item.title }}<small v-if="item.sectionTitle">({{ item.sectionTitle }})</small></span>
                </label>
              </div>
              <!-- 数据分析 -->
              <div v-if="planDialog.plan.dataAnalysis.length" class="plan-section">
                <div class="plan-sec-head">
                  <strong>数据分析</strong>
                  <span>{{ planDialog.plan.dataAnalysis.filter((x) => x._enabled).length }}/{{ planDialog.plan.dataAnalysis.length }} 项</span>
                </div>
                <label v-for="(item, i) in planDialog.plan.dataAnalysis" :key="i" class="plan-check">
                  <input type="checkbox" :checked="item._enabled" @change="togglePlanItem('dataAnalysis', i)" />
                  <span>{{ String((item as unknown as Record<string, unknown>).analysisType ?? "分析") }} · {{ ((item as unknown as Record<string, unknown>).variables as string[] ?? []).slice(0, 3).join(",") }}</span>
                </label>
              </div>
              <!-- 空计划 -->
              <p v-if="!(planDialog.plan.literatureSearch.length || planDialog.plan.textTables.length || planDialog.plan.dataAnalysis.length)" class="plan-empty-note">当前不需要生成额外素材</p>
            </div>
            <!-- 执行中 -->
            <div v-else-if="planDialog.state === 'executing'" class="plan-state running">
              <span class="job-spinner"></span>
              <p>正在逐项生成素材, 请稍候...</p>
            </div>
          </div>
          <div v-if="planDialog.state === 'ready'" class="modal-foot">
            <button class="btn-back" @click="closePlanDialog">取消</button>
            <button class="btn-primary" data-assistant-control="materials_confirm_plan" @click="executePlan">开始执行</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- B4 单类生成弹层(闭源 MaterialGenerateDialog) -->
    <Teleport to="body">
      <div v-if="genDialog.open" class="modal-mask gen-mask" @click.self="closeGenDialog">
        <div class="modal-card gen-card">
          <div class="modal-head">
            <h3>{{ genDialogTitle }}</h3>
            <button class="modal-x" @click="closeGenDialog">×</button>
          </div>
          <div class="modal-body gen-body">
            <!-- 提示 -->
            <p v-if="genPromptHint" class="gen-hint">{{ genPromptHint }}</p>
            <!-- 生成要求 -->
            <div class="f-row">
              <label>{{ genDialog.catKey === "literature" ? "文献查询" : "生成要求" }} *</label>
              <textarea v-model="genDialog.prompt" rows="3" class="f-textarea" :placeholder="genPlaceholder"></textarea>
            </div>
            <!-- 表类型 radio(仅表格类; 闭源自绘 radio: 文本对比表/数据表) -->
            <div v-if="genDialog.catKey === 'data'" class="gen-table-type">
              <label class="radio-item" @click="pickGenTableType('comparison')">
                <span class="radio-dot" :class="genDialog.tableType === 'comparison' ? 'radio-on' : ''"><i v-if="genDialog.tableType === 'comparison'"></i></span>
                <span>文本对比表</span>
              </label>
              <label class="radio-item" @click="pickGenTableType('data')">
                <span class="radio-dot" :class="genDialog.tableType === 'data' ? 'radio-on' : ''"><i v-if="genDialog.tableType === 'data'"></i></span>
                <span>数据表（需提供数据）</span>
              </label>
            </div>
            <!-- 关联章节 select -->
            <div class="f-row">
              <label>关联章节 <i class="req">*</i></label>
              <select v-model="genDialog.sectionId" class="f-input">
                <option value="" disabled>请选择章节</option>
                <option v-for="sec in store.sections" :key="sec.id" :value="sec.id">{{ allocOptionLabel(sec) }}</option>
              </select>
              <p v-if="!genDialog.sectionId" class="gen-warn">生成前需要关联一个章节</p>
            </div>
            <!-- 生成状态/预览 -->
            <div v-if="genDialog.streaming || genDialog.preview" class="gen-preview-box">
              <div class="gen-preview-head">
                <span>生成预览</span>
                <span v-if="genDialog.streaming" class="gen-phase"><span class="job-spinner"></span>{{ genDialog.phaseText }}</span>
              </div>
              <pre v-if="genDialog.preview" class="gen-preview-body">{{ genDialog.preview }}</pre>
              <div v-else class="gen-waiting">AI 生成中, 请稍候...</div>
            </div>
          </div>
          <div class="modal-foot gen-foot">
            <!-- 未预览: 开始生成 -->
            <button v-if="!genDialog.preview" class="btn-primary gen-start" :disabled="genDialog.generating || !genDialog.prompt.trim() || !genDialog.sectionId" @click="runGenStart">
              {{ genDialog.generating ? "生成中..." : "开始生成" }}
            </button>
            <!-- 已预览: 保存到素材库 / 完成 -->
            <button v-else class="btn-primary gen-start" @click="finishGenSave">保存到素材库</button>
            <button class="btn-back" :disabled="genDialog.generating" @click="closeGenDialog">{{ genDialog.generating ? "取消" : genDialog.preview ? "放弃" : "取消" }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- B5 图片全屏预览层(闭源: z-[80] 遮罩 bg-black/60 + 白卡 img 点击不穿透) -->
    <Teleport to="body">
      <div v-if="imagePreviewSrc" class="imgpv-mask" @click.self="closeImagePreview">
        <div class="imgpv-box">
          <img :src="imagePreviewSrc" class="imgpv-img" alt="素材预览" @click.stop />
          <button class="imgpv-x" @click="closeImagePreview">×</button>
        </div>
      </div>
    </Teleport>

    <!-- B3 素材编排确认弹层(闭源 MaterialAllocationDialog 形态) -->
    <Teleport to="body">
      <div v-if="allocDialog.open" class="modal-mask alloc-mask" @click.self="closeAllocate">
        <div class="modal-card alloc-card">
          <div class="modal-head">
            <h3>素材编排确认</h3>
            <button class="modal-x" @click="closeAllocate">×</button>
          </div>
          <div class="modal-body alloc-body">
            <p class="alloc-sub">每项素材只关联一个对应章节，确认后用于该章节正文生成。</p>
            <!-- 建议加载中 -->
            <div v-if="allocDialog.loading" class="alloc-loading">
              <span class="job-spinner"></span>
              <p>正在分析素材与章节的匹配关系...</p>
            </div>
            <!-- 空态 -->
            <div v-else-if="!allocDialog.suggestions.length" class="alloc-empty">
              <p>暂无建议</p>
              <p v-if="allocErr" class="alloc-err">编排失败：{{ allocErr }}</p>
            </div>
            <!-- 逐条建议: checkbox + 标题 + 目标章节 select -->
            <div v-else class="alloc-list">
              <div v-for="s in allocDialog.suggestions" :key="s.materialId" class="alloc-item">
                <input
                  type="checkbox"
                  class="alloc-check"
                  :checked="s.selected !== false"
                  @change="s.selected = !s.selected"
                />
                <div class="alloc-main">
                  <p class="alloc-title">{{ s.materialTitle || "未命名素材" }}</p>
                  <p class="alloc-hint">目标章节：{{ s.sectionId ? allocSectionTitle(s.sectionId) : "未选择" }}</p>
                  <p v-if="s.reason" class="alloc-reason">{{ s.reason }}</p>
                </div>
                <select v-model="s.sectionId" class="alloc-select" :disabled="s.selected === false">
                  <option value="">请选择章节</option>
                  <option v-for="sec in store.sections" :key="sec.id" :value="sec.id">{{ allocOptionLabel(sec) }}</option>
                </select>
              </div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn-back" :disabled="allocBusy" @click="closeAllocate">取消</button>
            <button class="btn-primary" :disabled="allocBusy || allocDialog.loading" data-assistant-control="materials_confirm_plan" @click="confirmAllocate">
              {{ allocBusy ? "关联中…" : `确认关联（${allocSelected} 个）` }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 手动添加弹层 -->
    <Teleport to="body">
      <div v-if="editDialog.open" class="modal-mask" @click.self="closeAdd">
        <div class="modal-card">
          <div class="modal-head">
            <h3>手动添加{{ CATS.find((c) => c.key === editDialog.kind)?.label }}</h3>
            <button class="modal-x" @click="closeAdd">×</button>
          </div>
          <div class="modal-body">
            <div class="f-row">
              <label>标题 *</label>
              <input v-model="editDialog.material.title" class="f-input" placeholder="素材标题" />
            </div>
            <div class="f-row">
              <label>内容</label>
              <textarea v-model="editDialog.material.content" class="f-textarea" rows="6" placeholder="素材内容(文本/文献引用格式)…"></textarea>
            </div>
            <!-- B2 文献批量粘贴解析(仅文献类) -->
            <div v-if="editDialog.kind === 'literature'" class="bulk-ref-box">
              <details>
                <summary class="bulk-summary">📋 批量粘贴文献(每行或每段一条, APA/GB/混合)</summary>
                <div class="bulk-body">
                  <textarea v-model="bulkRefText" class="f-textarea" rows="4" placeholder="郭峰,王靖一.测度中国数字普惠金融发展[J].经济学(季刊),2020,19(4).&#10;Stiglitz J E, Weiss A. Credit Rationing in Markets with Imperfect Information[J]. AER, 1981, 71(3): 393-410."></textarea>
                  <div class="bulk-actions">
                    <button type="button" class="btn-manual" @click="runBulkParse">解析</button>
                    <button type="button" v-if="parsedRefs.length" class="btn-manual" @click="applyParsedRefs">应用 {{ parsedRefs.length }} 条到内容</button>
                  </div>
                  <div v-if="parsedRefs.length" class="parsed-list">
                    <div v-for="(r, ri) in parsedRefs.slice(0, 6)" :key="ri" class="parsed-item">
                      <span class="pi-num">{{ ri + 1 }}</span>
                      <span class="pi-title">{{ r.title || "未识别题目" }}</span>
                      <span v-if="r.author" class="pi-meta">{{ r.author.slice(0, 20) }}</span>
                      <span v-if="r.year" class="pi-meta">{{ r.year }}</span>
                      <span v-if="r.doi" class="pi-doi">DOI: {{ r.doi.slice(0, 24) }}</span>
                    </div>
                    <div v-if="parsedRefs.length > 6" class="parsed-more">…还有 {{ parsedRefs.length - 6 }} 条</div>
                  </div>
                </div>
              </details>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn-back" @click="closeAdd">取消</button>
            <button class="btn-primary" @click="saveManual">保存</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>

.workflow-page { width: 100%; box-sizing: border-box; }
.wf-h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; color: #E8EEF7; }
.wf-sub { margin: 0 0 16px; font-size: 13px; color: #8B9BB1; }
.job-bar { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 9px; margin-bottom: 12px; font-size: 13px; }
.job-bar.running { background: #1E2A48; border: 1px solid #bfdbfe; color: #1d4ed8; }
.job-bar.failed { background: #2A1C1C; border: 1px solid #3A2323; color: #dc2626; }
.job-spinner {
  width: 14px; height: 14px; border: 2px solid #93c5fd; border-top-color: #1d4ed8;
  border-radius: 50%; animation: jspin 0.8s linear infinite;
}
@keyframes jspin { to { transform: rotate(360deg); } }
.cat-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
.cat-card { background: #11192C; border: 1px solid #222F44; border-radius: 12px; overflow: hidden; }
.cat-head {
  display: flex; align-items: center; gap: 10px; padding: 13px 16px;
  background: #1A2333; cursor: pointer; user-select: none;
}
.cat-icon {
  width: 30px; height: 30px; border-radius: 8px;
  background: #dc2626; display: grid; place-items: center; font-size: 15px;
}
.cat-head strong { font-size: 15px; color: #E8EEF7; }
.cat-count { font-size: 11px; color: #7A8AA0; background: #212C45; padding: 2px 9px; border-radius: 10px; }
.cat-caret { margin-left: auto; color: #7A8AA0; font-size: 10px; }
.cat-body { padding: 12px 16px; border-top: 1px solid #212C45; }
.cat-actions { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.btn-ai {
  padding: 6px 14px; background: #dc2626; color: #F1F5F9; border: 0;
  border-radius: 7px; font-size: 12.5px; font-weight: 500; cursor: pointer;
}
.btn-ai:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-manual {
  padding: 6px 14px; background: #11192C; color: #8B9BB1; border: 1px solid #222F44;
  border-radius: 7px; font-size: 12.5px; cursor: pointer;
}
.cat-empty { padding: 20px; text-align: center; color: #7A8AA0; font-size: 12.5px; }
.mat-list { display: flex; flex-direction: column; gap: 7px; }
.mat-card {
  border: 1px solid #222F44; border-radius: 9px; padding: 11px 13px;
  display: flex; flex-direction: column; gap: 6px;
}
.mat-card:hover { border-color: #B06A6A; box-shadow: 0 2px 8px rgba(220, 38, 38, 0.06); }
.mat-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.mat-head strong { font-size: 13.5px; color: #E8EEF7; }
.mat-kind { font-size: 10px; color: #dc2626; background: #2A1C1C; padding: 2px 8px; border-radius: 8px; flex-shrink: 0; }
.mat-content { font-size: 12px; color: #8B9BB1; line-height: 1.55; white-space: pre-wrap; }
.mat-foot { display: flex; align-items: center; gap: 8px; }
.sec-chip { font-size: 10.5px; background: #11192Cbeb; color: #E8B54A; padding: 2px 8px; border-radius: 7px; }
.mat-date { font-size: 10.5px; color: #7A8AA0; }
.mat-del { margin-left: auto; border: 0; background: none; color: #8B9BB1; font-size: 11.5px; cursor: pointer; }
.mat-del:hover { color: #dc2626; }
.three-line-table { border-collapse: collapse; width: 100%; font-size: 11.5px; }
.three-line-table th {
  border-top: 2px solid #1e293b; border-bottom: 1px solid #475569;
  padding: 5px 9px; text-align: left; color: #E8EEF7; white-space: nowrap;
}
.three-line-table td { padding: 4px 9px; color: #DCE6F2; }
.three-line-table tbody tr:hover { background: #1A2333; }
.review-report { margin-bottom: 14px; }
.report-head { font-size: 13.5px; font-weight: 600; color: #E8EEF7; cursor: pointer; padding: 9px 13px; background: #11192Cbeb; border: 1px solid #3A3020; border-radius: 9px; }
.report-body {
  margin: 0; padding: 12px 15px; background: #11192C;
  border: 1px solid #3A3020; border-top: 0; border-radius: 0 0 9px 9px;
  font-family: inherit; font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; color: #DCE6F2;
}
.wf-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
.btn-back {
  padding: 10px 22px; border: 1px solid #222F44; border-radius: 9px;
  background: #11192C; color: #8B9BB1; font-size: 14px; cursor: pointer;
}
.btn-ghost-red {
  padding: 10px 18px; border: 1px solid #B06A6A; border-radius: 9px;
  background: #11192C; color: #dc2626; font-size: 13px; cursor: pointer;
}
.btn-primary {
  padding: 10px 26px; border: 0; border-radius: 9px;
  background: #dc2626; color: #F1F5F9; font-size: 14px; font-weight: 600; cursor: pointer;
}
.btn-primary:disabled { background: #46587A; cursor: not-allowed; }
.modal-mask { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, 0.2); display: flex; align-items: center; justify-content: center; }
.modal-card { width: 520px; max-width: 95vw; background: #11192C; border-radius: 16px; box-shadow: 0 20px 60px rgba(15, 23, 42, 0.25); }
.modal-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #222F44; }
.modal-head h3 { margin: 0; font-size: 16px; color: #E8EEF7; }
.modal-x { border: 0; background: none; font-size: 20px; color: #8B9BB1; cursor: pointer; }
.modal-body { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
.f-row { display: flex; flex-direction: column; gap: 5px; }
.f-row label { font-size: 13px; font-weight: 600; color: #DCE6F2; }
.f-input { padding: 8px 12px; border: 1px solid #222F44; border-radius: 8px; font-size: 13px; }
.f-textarea { padding: 8px 12px; border: 1px solid #222F44; border-radius: 8px; font-size: 13px; font-family: inherit; resize: vertical; }
.modal-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid #222F44; }

.btn-smart {
  padding: 10px 18px; border: 0; border-radius: 9px;
  background: #7c3aed; color: #F1F5F9; font-size: 13px; font-weight: 600; cursor: pointer;
}
.btn-smart:hover { background: #6d28d9; }
.plan-modal { width: 560px !important; }
.plan-state { padding: 26px 10px; text-align: center; color: #8B9BB1; font-size: 13px; }
.plan-state.running { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.plan-state.failed p { color: #dc2626; margin: 0 0 12px; }
.plan-empty-note { color: #7A8AA0; font-size: 12.5px; text-align: center; padding: 12px 0; }
.plan-ready { display: flex; flex-direction: column; gap: 12px; }
.plan-section { border: 1px solid #222F44; border-radius: 9px; padding: 10px 12px; }
.plan-sec-head { display: flex; justify-content: space-between; margin-bottom: 7px; }
.plan-sec-head strong { font-size: 13px; color: #E8EEF7; }
.plan-sec-head span { font-size: 11px; color: #7A8AA0; background: #212C45; padding: 1px 8px; border-radius: 8px; }
.plan-check {
  display: flex; align-items: flex-start; gap: 8px; padding: 4px 2px;
  font-size: 12.5px; color: #DCE6F2; cursor: pointer; line-height: 1.5;
}
.plan-check input { margin-top: 3px; }
.plan-check small { color: #7A8AA0; margin-left: 5px; }
.job-spinner {
  width: 16px; height: 16px; border: 2px solid #ddd6fe; border-top-color: #7c3aed;
  border-radius: 50%; animation: pspin 0.8s linear infinite;
}
@keyframes pspin { to { transform: rotate(360deg); } }


.bulk-ref-box { border: 1px solid #222F44; border-radius: 8px; overflow: hidden; }
.bulk-summary { padding: 8px 12px; font-size: 12.5px; color: #2563eb; cursor: pointer; background: #1A2333; }
.bulk-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.bulk-actions { display: flex; gap: 8px; }
.parsed-list { display: flex; flex-direction: column; gap: 4px; border-top: 1px dashed #222F44; padding-top: 8px; }
.parsed-item { display: flex; align-items: baseline; gap: 6px; font-size: 11.5px; }
.pi-num { color: #7A8AA0; font-size: 10px; flex-shrink: 0; }
.pi-title { color: #E8EEF7; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pi-meta { color: #8B9BB1; flex-shrink: 0; }
.pi-doi { color: #2563eb; font-size: 10px; flex-shrink: 0; }
.parsed-more { font-size: 11px; color: #7A8AA0; text-align: center; }

/* B3 素材编排(闭源 MaterialAllocationDialog) */
.mat-alloc {
  border: 0; background: none; color: #dc2626; font-size: 11.5px; cursor: pointer; margin-left: 4px;
}
.btn-alloc-cta {
  padding: 10px 18px; border: 1px solid #B06A6A; border-radius: 9px;
  background: #11192C; color: #dc2626; font-size: 13px; cursor: pointer;
}
.btn-alloc-cta:disabled { opacity: 0.5; cursor: not-allowed; }
.alloc-mask { background: rgba(0, 0, 0, 0.55); }
.alloc-card { width: 620px !important; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column; }
.alloc-sub { margin: 0; font-size: 12px; color: #8B9BB1; }
.alloc-body { flex: 1; overflow-y: auto; }
.alloc-loading, .alloc-empty { padding: 30px 0; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; color: #7A8AA0; font-size: 13px; }
.alloc-err { color: #dc2626; }
.alloc-list { display: flex; flex-direction: column; gap: 8px; }
.alloc-item { display: flex; align-items: flex-start; gap: 12px; padding: 11px 13px; border: 1px solid #222F44; border-radius: 9px; }
.alloc-item:hover { background: #1A2333; }
.alloc-check { margin-top: 3px; accent-color: #dc2626; }
.alloc-main { flex: 1; min-width: 0; }
.alloc-title { margin: 0; font-size: 13.5px; font-weight: 600; color: #E8EEF7; }
.alloc-hint { margin: 3px 0 0; font-size: 11.5px; color: #8B9BB1; }
.alloc-reason { margin: 3px 0 0; font-size: 11px; color: #7A8AA0; line-height: 1.5; }
.alloc-select {
  flex-shrink: 0; max-width: 200px; font-size: 12px; color: #DCE6F2;
  border: 1px solid #222F44; border-radius: 7px; padding: 4px 8px; outline: none;
}
.alloc-select:focus { border-color: #E67E7E; }
.alloc-select:disabled { background: #212C45; color: #8B9BB1; }

/* B4 单类生成弹层(闭源 MaterialGenerateDialog) */
.gen-mask { background: rgba(0, 0, 0, 0.2); }
.gen-card { width: 640px !important; }
.gen-body { max-height: 62vh; overflow-y: auto; }
.gen-hint { margin: 0; font-size: 12px; color: #8B9BB1; background: #1A2333; border-radius: 8px; padding: 8px 12px; line-height: 1.6; }
.req { color: #dc2626; font-style: normal; }
.gen-warn { margin: 3px 0 0; font-size: 11.5px; color: #dc2626; }
.gen-table-type { display: flex; gap: 22px; align-items: center; }
.radio-item { display: flex; align-items: center; gap: 7px; cursor: pointer; font-size: 13px; color: #DCE6F2; }
.radio-dot {
  width: 16px; height: 16px; border-radius: 50%; border: 2px solid #46587A;
  display: flex; align-items: center; justify-content: center;
}
.radio-dot.radio-on { border-color: #dc2626; }
.radio-dot i { width: 6px; height: 6px; border-radius: 50%; background: #dc2626; display: block; }
.gen-preview-box { border: 1px solid #222F44; border-radius: 9px; overflow: hidden; }
.gen-preview-head {
  display: flex; justify-content: space-between; align-items: center;
  background: #1A2333; padding: 7px 12px; font-size: 12px; color: #8B9BB1;
  border-bottom: 1px solid #212C45;
}
.gen-phase { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #7c3aed; }
.gen-waiting { padding: 20px; text-align: center; color: #7A8AA0; font-size: 12.5px; }
.gen-preview-body {
  margin: 0; padding: 12px 14px; font-family: inherit; font-size: 12.5px;
  color: #DCE6F2; line-height: 1.7; white-space: pre-wrap; max-height: 240px; overflow-y: auto;
}
.gen-foot { align-items: center; }
.gen-start { min-width: 130px; }
.gen-start:disabled { background: #46587A; cursor: not-allowed; }

/* B5 图片素材卡 + 全屏预览 + 来源徽章 */
.mat-img { margin-top: 2px; }
.mat-img-src {
  max-height: 150px; max-width: 100%; border-radius: 8px;
  object-fit: contain; border: 1px solid #212C45; cursor: zoom-in;
}
.imgpv-mask {
  position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center;
}
.imgpv-box { position: relative; max-width: 92vw; max-height: 92vh; }
.imgpv-img { max-width: 92vw; max-height: 88vh; border-radius: 10px; box-shadow: 0 25px 80px rgba(0, 0, 0, 0.5); object-fit: contain; }
.imgpv-x {
  position: absolute; top: -16px; right: -16px; width: 32px; height: 32px;
  border-radius: 50%; background: rgba(0, 0, 0, 0.5); color: #F1F5F9; border: 0;
  font-size: 16px; cursor: pointer;
}
.imgpv-x:hover { background: rgba(0, 0, 0, 0.75); }
.src-badge {
  font-size: 10px; padding: 1.5px 8px; border-radius: 8px; flex-shrink: 0;
  border: 1px solid transparent;
}
.src-blue { background: #1E2A48; color: #2563eb; border-color: #bfdbfe; }
.src-gray { background: #212C45; color: #8B9BB1; border-color: #222F44; }
.src-red { background: #2A1C1C; color: #dc2626; border-color: #3A2323; }
.src-plain { background: #1A2333; color: #8B9BB1; border-color: #222F44; }

</style>
