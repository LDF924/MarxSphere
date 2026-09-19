<script setup lang="ts">
/**
 * MaterialsView(Phase3 素材准备) — 还原自闭源 MaterialsView-CW_9_w3K.js(10 组件, 核心形态还原)
 * 5 分类手风琴(文献检索/表格素材/理论素材/数据分析素材/附件素材) + AI 生成 + 手动添加 + 发布版本
 * 数据: 后端 research_materials CRUD + 素材节点; kind: citation/theory/data_result/figure/file
 */
import { ref, computed, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useWorkflowStore } from "./stores/workflow";
import { q, describeTaskError } from "@/shared/api";
import { toast, confirmDialog } from "@/shared/ui";
import { putNode } from "@/shared/tasks";
import { claimHandoff } from "@/shared/workflow-bridge";
import { renderMd } from "@/shared/markdown";
import PhaseProgressBar from "./PhaseProgressBar.vue";

const router = useRouter();
const store = useWorkflowStore();

/** 素材审视报告: 后端返回的是 markdown, 原先用 <pre> 直出源码 */
const reviewReportHtml = computed(() => renderMd(String(store.materialReviewReport ?? "")));

interface Material {
  id: string;
  kind: string; // literature/citation | data | table | theory | dataAnalysis | document
  title: string;
  /** 后端唯一的内容字段(content_md → contentMd); 曾另造 `content` 别名, 编辑弹层读它恒为空 → 保存清空正文 */
  contentMd?: string;
  caption?: string;
  sectionId?: string;
  /** 挂章数组(后端 section_ids jsonb → camelCase 映射); 发布门禁与"已关联"角标都读它 */
  sectionIds?: string[];
  createdAt?: string;
  tableData?: { columns: string[]; rows: unknown[][] };
  references?: Array<{ title: string; author?: string; source?: string; year?: string; gbRef?: string; venue?: string; doi?: string; volume?: string; issue?: string; pages?: string; authors?: string; excerpt?: string }>;
  source?: { sourceStatus?: { wanfang?: string; ncpssd?: string; internal?: string } };
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
  // V417: 后端写的是 internal 键(实测), 前端原来只认 ncpssd/wanfang → 状态位永远读不到,
  //   「已用/无结果/失败」三态从不显示。补上 internal。
  const st = ss.ncpssd || ss.wanfang || ss.internal || "";
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
/** 通用素材卡里"展开全文"的素材 id 集合(长正文默认折叠 400 字) */
const expandedIds = ref<Set<string>>(new Set());
function toggleExpand(id: string) {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
}
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

/**
 * V417 入站连接：外部模块（文献库/论文评审/统计台/成果工坊）投递的素材落到本项目素材库。
 *
 * 消息由 **soc 外壳**(App.vue)接收并写入 localStorage 交接 —— 这里只负责读取。
 * 为什么不在本视图收: 外壳投递时 iframe 可能还停在别的路由(如 input), 那时本视图
 * 的监听器还没注册, 消息会被静默丢弃(实测踩到)。外壳常驻, 收下后再把人带到这里。
 * 写端见 workflow-bridge.ts / App.vue 的 onExternalMaterial。
 */
async function importExternalMaterials() {
  const h = claimHandoff();
  if (!h || !store.taskId) return;
  try {
    await q("/research/materials", {
      method: "POST",
      body: {
        projectId: store.taskId,
        kind: mapExternalKind(h.kind),
        title: h.title,
        contentMd: h.markdown,
        sourceType: h.kind,
        meta: { platformType: h.kind, importedAt: new Date().toISOString() },
      },
    });
    await loadMaterials();
    toast(`已从外部模块导入素材「${h.title}」`, "success");
  } catch { /* 单条失败不阻断 */ }
}

/** 外部来源 → research_materials.kind（后端只认这 7 个值） */
function mapExternalKind(kind: string): string {
  if (kind === "literature") return "citation";
  if (kind === "review") return "note";
  if (kind === "stats") return "data_result";
  if (kind === "viz") return "figure";
  return "note";
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
  /** 文献类生成后回填的**真命中**条目(标题/作者/年份/来源), 用于弹层内的检索结果卡 */
  retrievedRefs: Array<Record<string, unknown>>;
}
const genDialog = ref<GenDialogState>({
  open: false, catKey: "", generating: false, preview: "", streaming: false,
  tableType: "comparison", sectionId: "", prompt: "", phaseText: "", retrievedRefs: []
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
  // 先停掉可能残留的轮询并复位 —— 否则"上次异常退出(接口挂了/generating 没复位)"会带进来,
  //   新打开时次按钮直接显示成「取消」, 用户以为还在生成(实测: busy 标志就是这么卡住的)
  stopGenDialogPoll();
  resetGenDialogState();
  genDialog.value = {
    open: true, catKey, generating: false, preview: "", streaming: false,
    tableType: "comparison", sectionId: store.level1Sections[0]?.id ?? "",
    prompt: catKey === "literature" ? store.input.title : "", phaseText: "",
    retrievedRefs: []
  };
}
/**
 * 关闭生成弹层(取消/放弃/保存完成都走它)。
 *
 * 2026-09-16 修: 原先只做 `open=false` —— `genTaskId` 不清零, 而它是页面级
 *   `data-assistant-async-busy` 的判据(`matAsyncBusy`), 于是**第一次生成之后该标志永久为真**,
 *   科研助手此后一直认为"正在生成素材", 不再推荐任何动作。实测: 生成一次 → 关掉 → busy 恒 true。
 *   同时把弹层内的临时态一并复位, 否则下次打开会看到上一次的预览残留(闭源是"放弃 → 状态复位")。
 */
function resetGenDialogState() {
  genTaskId.value = "";
  const d = genDialog.value;
  d.generating = false;
  d.streaming = false;
  d.preview = "";
  d.phaseText = "";
  d.retrievedRefs = [];
}
function closeGenDialog() {
  if (genDialog.value.generating) return;
  stopGenDialogPoll();
  genDialog.value.open = false;
  resetGenDialogState();
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
        const msg = describeTaskError(t) || "生成失败";
        toast(msg, "error");
      }
    } catch { /* 容忍 */ }
  }, 800);
}
/** 中止正在跑的生成: 真去取消后端任务(不是只停本地轮询 —— 那样后端会照跑完并落库) */
async function cancelGen() {
  const taskId = genTaskId.value;
  stopGenDialogPoll();
  try {
    if (taskId) {
      await q(`/research/tasks/${taskId}/control`, { method: "POST", body: { action: "cancel" } });
      // 后端可能已经写入了素材, 取消后清掉本次任务产出的草稿, 别留下半成品
      const r = await q<{ materials?: Array<{ id: string; sourceRef?: string }> }>(`/research/materials?projectId=${store.taskId}`).catch(() => ({ materials: [] }));
      const mine = (r.materials ?? []).filter((m) => m.sourceRef === taskId);
      for (const m of mine) await q(`/research/materials/${m.id}`, { method: "DELETE" }).catch(() => null);
      await loadMaterials();
    }
    genDialog.value.open = false;
    resetGenDialogState();
    toast("已取消生成", "info");
  } catch (e) {
    toast("取消失败: " + String((e as Error).message ?? e), "error");
  }
}

/** 预览文本: job 产物素材内容(exec 落库)或 result structured 兜底 */
async function buildGenPreview(taskId: string): Promise<string> {
  try {
    const r = await q<{ materials?: Array<{ id: string; sourceRef?: string; contentMd?: string; references?: unknown[]; title?: string }> }>(`/research/materials?projectId=${store.taskId}`);
    const mine = (r.materials ?? []).filter((m) => m.sourceRef === taskId || m.id === taskId);
    if (mine.length) {
      // 文献类: 顺带把真命中存进弹层, 生成后仍能看到"这次检索命中了什么"
      const refs = mine.flatMap((m) => (Array.isArray(m.references) ? m.references : [])) as Array<Record<string, unknown>>;
      if (refs.length) genDialog.value.retrievedRefs = refs;
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

/**
 * 「保存到素材库」。
 *
 * 2026-09-16 修: 原先这里是**空操作** —— 只 `open=false` + toast, 素材其实早在 exec 阶段就落库了,
 *   所以「保存」既不保存什么、也不改变什么, 只是把窗口关掉。用户点完以为"我确认保存了这一条",
 *   实际什么都没发生(这也让"未获取到真实文献数据"这类硬拦截无处可放)。
 *
 * 现在按闭源 `saveGeneratedMaterial` 的语义:
 *   ① 文献类**必须有真命中**才允许入库 —— 检索空结果时后端写的是"需人工补录"占位条目,
 *      把它当"已保存的文献"会误导(闭源在这里硬拦截并提示"未获取到真实文献数据")。
 *      此时把该条草稿素材删掉, 避免库里留垃圾。
 *   ② 其余类: 确认入库(toast 计数)。
 */
async function finishGenSave() {
  const d = genDialog.value;
  if (!genTaskId.value && !d.preview) { closeGenDialog(); return; }
  const taskId = genTaskId.value;
  stopGenDialogPoll();
  try {
    if (d.catKey === "literature") {
      const r = await q<{ materials?: Array<{ id: string; sourceRef?: string; references?: unknown[] }> }>(`/research/materials?projectId=${store.taskId}`);
      const mine = (r.materials ?? []).filter((m) => m.sourceRef === taskId || m.id === taskId);
      const refCount = mine.reduce((n, m) => n + (Array.isArray(m.references) ? m.references.length : 0), 0);
      if (!refCount) {
        // 无真命中: 删掉占位素材, 明确告诉用户"这条没入库"
        for (const m of mine) await q(`/research/materials/${m.id}`, { method: "DELETE" }).catch(() => null);
        toast("未获取到真实文献数据, 该条未保存。可换检索词重试。", "warning");
        await loadMaterials();
        genDialog.value.open = false;
        resetGenDialogState();
        return;
      }
    }
    genDialog.value.open = false;
    resetGenDialogState();
    await loadMaterials();
    toast(`${genCatLabel.value}已保存到素材库`, "success");
  } catch (e) {
    toast("保存失败: " + String((e as Error).message ?? e), "error");
  }
}


// ── B2 文献批量解析(闭源 la(): DOI/年份/APA·GB 混合; 空条目工厂/单条解析/批量粘贴) ──
const REF_KEYS = ["title", "author", "source", "journal", "year", "volume", "issue", "pages", "doi", "abstract"];
/**
 * 卷(期):页码 —— 模板此前读的是 `volumeIssue`, 而解析器产出的是
 * `volume`/`issue`/`pages` 三个独立键(见 REF_KEYS), **全仓没有任何地方写 volumeIssue**。
 * 于是用户填的卷期永远不显示 —— 读的是个恒空的键。
 * 2026-09-18 修: 按 `REF_KEYS` 的口径拼, 不显示空占位。
 */
function refVol(ref: Record<string, unknown>): string {
  const v = String(ref.volume ?? "").trim();
  const i = String(ref.issue ?? "").trim();
  const p = String(ref.pages ?? "").trim();
  if (!v && !i && !p) return "";
  let s = v + (i ? `(${i})` : "");
  if (p) s += `: ${p}`;
  return s;
}
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
  /**
   * 卷(期):页码 —— GB/T 7714 里跟在年份后面(如 `经济学(季刊), 2020, 19(4): 1-15.`)。
   * 2026-09-18 补: 此前**完全不抽**这三项, 而 REF_KEYS 里定义了它们、模板也想显示,
   * 结果是"著录里明明有卷期, 卡片上永远不显示"。抽取是保守的: 只在紧跟年份之后认,
   * 认不出就不写(宁可空, 也不要把年份/页码错切到卷号上)。
   */
  const vip = t.match(/[,，]\s*(\d{4})\s*[,，]\s*(\d+)\s*(?:\(\s*(\d+)\s*\))?\s*(?::\s*([\d\-–—~]+))?/);
  if (vip) {
    if (!r.year) r.year = vip[1];
    r.volume = vip[2] ?? "";
    if (vip[3]) r.issue = vip[3];
    if (vip[4]) r.pages = vip[4];
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
/**
 * 把批量解析结果写进编辑中素材的**结构化 `references[]`**。
 *
 * 2026-09-16 修: 原先只把 `【题目】…【作者】…` 拼进自由文本 `content`, `references` 恒空。
 * 后果是链式的 ——
 *   · 文献卡的结构化渲染分支(逐条标题/作者/年份/DOI + GB 引用)永远不成立;
 *   · 后端参考文献池 `buildCitationPool` 按 `content_md` 里的 `[N] 条目` 匹配, 拼出来的
 *     `【题目】…` 格式它认不出 → **手动添加的文献从不进入正文引用池**。
 * 闭源的做法就是解析成 `references[]` 数组(单条时原地替换), 这里对齐。
 */
function applyParsedRefs() {
  const m = editDialog.value.material;
  const incoming = parsedRefs.value.map((r) => ({
    title: r.title ?? "", authors: r.author ?? "", author: r.author ?? "",
    source: r.source ?? "", venue: r.source ?? "", year: r.year ?? "",
    ...(r.doi ? { doi: r.doi } : {}),
  }));
  const prev = Array.isArray(m.references) ? m.references : [];
  m.references = [...prev, ...incoming];
  // 同步维护一份 `[N] 著录` 文本 —— 后端引用链现在**优先读结构化 entries**,
  // 但这份文本仍有用: 外部复制/导出、以及"结构化字段缺项"时的兜底展示。
  // 格式必须带 `[N]`, 与后端正则口径一致(此前拼的是 `1.【题目】…`, 后端认不出)。
  if (m.references.length) {
    m.contentMd = m.references
      .map((r, i) => `[${i + 1}] ${[r.authors || r.author, r.title, r.source || r.venue, r.year].filter(Boolean).join(". ")}`)
      .join("\n");
  }
  parsedRefs.value = [];
  bulkRefText.value = "";
  toast(`已录入 ${incoming.length} 条结构化文献`, "success");
}
/** 逐条删除已录入的文献(闭源文献卡 hover 的「删除此条」) */
function removeRefAt(i: number) {
  const m = editDialog.value.material;
  if (!Array.isArray(m.references)) return;
  m.references.splice(i, 1);
  // 文本副本跟着重排编号, 否则删了第 2 条后文本里编号会断层
  m.contentMd = m.references
    .map((x, idx) => `[${idx + 1}] ${[x.authors || x.author, x.title, x.source || x.venue, x.year].filter(Boolean).join(". ")}`)
    .join("\n");
}
/** 单条手动录入一行(题目必填; 其余可空) */
const newRef = ref({ title: "", author: "", year: "", source: "", doi: "" });
function addRefRow() {
  const r = newRef.value;
  if (!r.title.trim()) { toast("请填写文献题目", "warning"); return; }
  const m = editDialog.value.material;
  if (!Array.isArray(m.references)) m.references = [];
  m.references.push({
    title: r.title.trim(), authors: r.author.trim(), author: r.author.trim(),
    source: r.source.trim(), venue: r.source.trim(), year: r.year.trim(),
    ...(r.doi.trim() ? { doi: r.doi.trim() } : {}),
  });
  // 与批量解析同口径: 同步维护 `[N] 著录` 文本
  m.contentMd = m.references
    .map((x, i) => `[${i + 1}] ${[x.authors || x.author, x.title, x.source || x.venue, x.year].filter(Boolean).join(". ")}`)
    .join("\n");
  newRef.value = { title: "", author: "", year: "", source: "", doi: "" };
}

// ── 手动添加 ──
function openAdd(kind: string) {
  editDialog.value = { open: true, kind, material: { id: "", kind, title: "", contentMd: "", references: [] } };
}

/** 变量角色色(SectionsView/WorkspaceView 同款 5 色) —— 文献弹层的「研究变量参考」chips 用 */
function roleColor(role: string): string {
  const qn: Record<string, string> = {
    "自变量": "#2563eb", "因变量": "#dc2626", "中介": "#E8B54A", "调节": "#7c3aed", "控制": "#6b7280",
    x: "#2563eb", y: "#dc2626", mediator: "#E8B54A", moderator: "#7c3aed", control: "#6b7280",
    "影响因素": "#2563eb", "结果表现": "#dc2626", "中间机制": "#E8B54A", "情境条件": "#7c3aed", "背景因素": "#6b7280",
  };
  return qn[String(role ?? "")] ?? "#2563eb";
}

/** 编辑已有素材(闭源素材卡 hover 出现的「编辑」; 与新建共用同一弹层, 靠 material.id 区分) */
function openEdit(m: Material) {
  editDialog.value = { open: true, kind: catOf(String(m.kind ?? "")), material: { ...m } };
}

/** 素材卡上的章节徽标(闭源: 灰色小徽标, 显示挂到的章/子节名, 最多 80px 截断) */
function sectionBadgeOf(m: Material): string {
  const ids = Array.isArray(m.sectionIds) ? m.sectionIds : [];
  const all = ids.length ? ids : m.sectionId ? [m.sectionId] : [];
  if (!all.length) return "";
  const title = store.sections.find((s) => s.id === all[0])?.title ?? "";
  if (!title) return "";
  return all.length > 1 ? `${title.slice(0, 6)}… +${all.length - 1}` : title.slice(0, 10);
}

/** 素材字数(闭源「N 字」) */
function wordCountOf(m: Material): number {
  const t = String(m.contentMd ?? "");
  return t.replace(/\s/g, "").length;
}

/** 前往其它模块 —— 走外壳既有的 navigate 协议(不带 markdown, 是纯导航) */
function gotoModule(mod: "statistics" | "viz") {
  const view = mod === "statistics" ? "empirical-research" : "plot-agent";
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source: "marxsphere-soc", type: "navigate", view }, "*");
      return;
    }
  } catch { /* 跨源拿不到 parent */ }
  toast("请从左侧导航进入对应模块", "warning");
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
  // 编辑已有素材(有 id): 走 PUT 只改标题与内容 —— 不要重新建一条,
  //   否则"编辑"会变成"复制一份"(闭源素材卡的编辑是就地改)。
  if (m.id) {
    try {
      await q(`/research/materials/${m.id}`, {
        method: "PUT",
        // references 必须一起传 —— 否则编辑一条已有的文献素材会把它的结构化条目抹掉
        body: { title: m.title, contentMd: m.contentMd ?? "", references: m.references ?? [] },
      });
      toast("素材已更新", "success");
      closeAdd();
      await loadMaterials();
    } catch (e) {
      toast(`更新失败: ${describeTaskError({ error: (e as Error).message })}`, "error");
    }
    return;
  }
  const created = await createMaterial({
    kind: kindMap[editDialog.value.kind] ?? editDialog.value.kind,
    title: m.title,
    contentMd: m.contentMd ?? "",
    ...(Array.isArray(m.references) && m.references.length ? { references: m.references } : {}),
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
/**
 * V417: 上传「数据文件」—— 写作舱原先**没有任何数据上传入口**, 于是 store.statisticsFileId
 *   永远是空 → 素材计划里的 hasDataFile 恒为 false → dataAnalysis 段恒空 → 那整块 UI 从不渲染。
 *   这里补上: 走统计台同款 /api/files/upload 拿 fileId, 记进 store, 并落一条 file 素材。
 */
const dataBusy = ref(false);
async function uploadDataFile(file: File | undefined) {
  if (!file || !store.taskId) return;
  dataBusy.value = true;
  try {
    const b64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result ?? "").split(",")[1] ?? "");
      r.onerror = () => reject(new Error("文件读取失败"));
      r.readAsDataURL(file);
    });
    const res = await fetch("/api/files/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}`,
      },
      body: JSON.stringify({ filename: file.name, base64: b64, mime: file.type || "text/csv" }),
    }).then((x) => x.json()).catch(() => null);
    if (!res?.fileId) throw new Error("后端未返回 fileId");
    store.statisticsFileId = String(res.fileId);
    await createMaterial({
      kind: "file", title: `数据文件 · ${file.name}`,
      contentMd: `原始数据文件 ${file.name}(${Math.round(file.size / 1024)} KB)`,
      sourceType: "data_file", notes: `fileId=${res.fileId}`,
      ...(store.level1Sections[0] ? { sectionIds: [store.level1Sections[0].id] } : {}),
    });
    await store.saveProject();
    await loadMaterials();
    toast(`数据文件已登记(${file.name}), 素材计划将包含数据分析项`, "success");
  } catch (e) {
    toast(`数据文件登记失败: ${(e as Error).message}`, "error");
  } finally {
    dataBusy.value = false;
  }
}

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
/**
 * ⚠ 2026-09-16 修: 初值原为 `state:"running"`, 而 `open:false` —— 于是**页面一打开**
 *   `matAsyncBusy` 就是 true(`planDialog.state === "running"` 是它的判据之一),
 *   科研助手全程以为"正在生成素材执行计划", 不再推荐任何动作。
 *   未打开弹层时的正确状态是"就绪"(没有任务在跑)。
 */
/** 文献库账户模式(2026-09-19) —— 只影响"拿谁的身份去查"的**说明**, 不涉及存密码 */
const CNKI_MODES = [
  { value: "personal", label: "我的账户", hint: "在 Edge 里登录你自己的知网账户后刷新" },
  { value: "institution", label: "机构订阅账户", hint: "在 Edge 里登录学校/单位的机构账号(包库)后刷新" }
] as const;
const cnkiMode = ref<"personal" | "institution">("institution");
type CnkiIdentity = { ok: boolean; loggedIn: boolean; userName?: string; showName?: string; userType?: string; isInstitution?: boolean; error?: string };
const cnkiIdentity = ref<CnkiIdentity | null>(null);
const cnkiBusy = ref(false);
async function loadCnkiIdentity() {
  cnkiBusy.value = true;
  try {
    cnkiIdentity.value = await q<CnkiIdentity>("/cnki/identity");
    // 检测到的身份与所选模式不一致时**自动对齐** —— 否则界面显示"机构订阅"而实际用个人号,
    //   用户以为切了其实没切(实测这类"界面说的和实际不是一个"正是本仓反复出现的一类缺陷)。
    if (cnkiIdentity.value?.loggedIn) cnkiMode.value = cnkiIdentity.value.isInstitution ? "institution" : "personal";
  } catch (e) {
    cnkiIdentity.value = { ok: false, loggedIn: false, error: (e as Error).message };
  } finally {
    cnkiBusy.value = false;
  }
}

// ── 中文三大库检索(2026-09-19) ──
// 走**用户浏览器里的机构登录态**: 这三家都没有对外检索 API, 检索页是 SPA 空壳。
// 平台不存它们的密码 —— 所以"未登录"是正常返回(409), 不是故障, 界面上要说清。
const LIT_SOURCES = [
  { id: "wanfang", label: "万方" },
  { id: "cqvip", label: "维普" },
  { id: "cnki", label: "知网" }
] as const;
type LitSourceId = (typeof LIT_SOURCES)[number]["id"];
type LitHit = { index: number; title: string; type?: string; journal?: string; issue?: string; authors?: string; abstract?: string; url?: string };
const litSource = ref<LitSourceId>("wanfang");
const litQuery = ref("");
const litBusy = ref(false);
const litHits = ref<LitHit[]>([]);
const litTotal = ref("");
const litNote = ref<{ kind: "warn" | "err" | "info"; text: string } | null>(null);
/** 已勾选待入库的条目(按 index) */
const litPicked = ref<Set<number>>(new Set());

async function runLitSearch() {
  const query = litQuery.value.trim();
  if (!query) { toast("请输入检索词", "warning"); return; }
  litBusy.value = true;
  litNote.value = null;
  litHits.value = [];
  litPicked.value = new Set();
  try {
    const r = await q<{ hits?: LitHit[]; total?: string; error?: string }>("/literature/search", {
      method: "POST",
      body: { source: litSource.value, query }
    });
    litHits.value = Array.isArray(r.hits) ? r.hits : [];
    litTotal.value = r.total ?? "";
    if (!litHits.value.length) litNote.value = { kind: "info", text: r.error || "没有检索到结果" };
  } catch (e) {
    const msg = (e as Error).message ?? "";
    // 后端用 409 表达"需要先登录" —— 这与"服务坏了"是两回事, 提示也要不同
    if (/需要先在浏览器|NEEDS_LOGIN|登录/.test(msg)) {
      const label = LIT_SOURCES.find((s) => s.id === litSource.value)?.label ?? "";
      litNote.value = { kind: "warn", text: `需要先在浏览器里登录${label}（可先点上面的「刷新」查看当前身份）` };
    } else {
      litNote.value = { kind: "err", text: `检索失败：${msg}` };
    }
  } finally {
    litBusy.value = false;
  }
}

function toggleLitPick(idx: number) {
  const next = new Set(litPicked.value);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  litPicked.value = next;
}

/** 把选中的检索结果落成文献素材(kind=citation + 结构化 references[]) —— 复用现有素材通道 */
async function importLitHits() {
  const picked = litHits.value.filter((h) => litPicked.value.has(h.index));
  if (!picked.length) { toast("请先勾选要入库的条目", "warning"); return; }
  let ok = 0;
  for (const h of picked) {
    const gbRef = [h.authors, h.title, h.journal, h.issue, h.url].filter(Boolean).join(". ");
    const created = await createMaterial({
      kind: "citation",
      title: h.title,
      contentMd: [h.title, h.authors, h.journal, h.issue, h.url].filter(Boolean).join("\n"),
      sourceType: litSource.value,
      sourceUrl: h.url ?? "",
      references: [{
        title: h.title,
        author: h.authors ?? "",
        venue: h.journal ?? "",
        year: h.issue ?? "",
        gbRef,
        ...(h.url ? { url: h.url } : {})
      }]
    });
    if (created) ok += 1;
  }
  toast(ok ? `已入库 ${ok} 条文献素材` : "入库失败", ok ? "success" : "error");
  if (ok) {
    litPicked.value = new Set();
    await loadMaterials();
  }
}

const planDialog = ref<{ open: boolean; state: "running" | "ready" | "executing" | "failed"; plan?: { literatureSearch: PlanItem[]; textTables: PlanItem[]; dataAnalysis: PlanItem[] }; counts?: { lit: number; tab: number; ana: number }; msg?: string }>({ open: false, state: "ready" });

/**
 * 页面级异步状态埋点(闭源 MaterialsView: busy = 计划生成中 || 素材生成中 || dataBusy,
 * reason = 对应阶段文案)。科研助手靠它避免在长任务进行中插动作。
 * 2026-09-15 补: 原先根节点只有 `data-assistant-material-count="0"` 这个**写死的假值**。
 */
const matAsyncBusy = computed(() => publishing.value || !!genTaskId.value || dataBusy.value || planDialog.value.state === "running");
const matAsyncReason = computed(() => {
  if (publishing.value) return "正在发布素材版本";
  if (planDialog.value.state === "running") return "正在生成素材执行计划";
  if (genTaskId.value) return "正在生成素材";
  if (dataBusy.value) return "正在上传数据文件";
  return "";
});
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

/** V417: 素材来源 —— 端点 /materials/:id/sources 一直存在但没有界面入口(能力有、看不见) */
const srcDialog = ref<{ open: boolean; materialId: string; title: string; loading: boolean; sources: Array<Record<string, unknown>>; sourceRef: string; error: string }>(
  { open: false, materialId: "", title: "", loading: false, sources: [], sourceRef: "", error: "" });
async function openSources(m: Material) {
  srcDialog.value = { open: true, materialId: m.id, title: m.title ?? "", loading: true, sources: [], sourceRef: "", error: "" };
  try {
    const r = await q<{ sources?: Array<Record<string, unknown>>; sourceRef?: string }>(`/research/materials/${m.id}/sources`);
    srcDialog.value.sources = r.sources ?? [];
    srcDialog.value.sourceRef = String(r.sourceRef ?? "");
  } catch (e) {
    srcDialog.value.error = String((e as Error).message ?? e);
  } finally {
    srcDialog.value.loading = false;
  }
}
function closeSrcDialog() { srcDialog.value = { ...srcDialog.value, open: false }; }

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
  /**
   * phase2 版本门禁(闭源: `!state.phase2Version || state.phase2Stale` → 中止并提示返回 Phase 2)。
   *
   * 2026-09-16 补: 后端 `/versions/current` 一直能算出 `phase2Stale`, 但**前端从不请求它**
   * (`store.phase2Stale` 零写入方), 于是"架构改了却没重新确认"的情况下照样能发布素材版本 ——
   * 素材是按旧架构关联的, 发布出去的就是一份对不上的版本。
   * 这里在发布前真查一次; 查询失败(网络/404)不阻断, 门禁不能因为旁路故障把用户卡死。
   */
  const vs = await q<{ state?: { phase2Version?: unknown; phase2Stale?: boolean } }>(
    `/research/versions/current?projectId=${store.taskId}`
  ).catch(() => null);
  const st2 = vs?.state;
  if (st2) {
    store.phase2VersionId = String((st2.phase2Version as { id?: string } | null)?.id ?? "");
    store.phase2Stale = Boolean(st2.phase2Stale);
    if (st2.phase2Stale) {
      toast("科研架构版本已失效(确认后又改动过), 请返回 Phase 2 重新确认后再发布素材", "warning");
      return;
    }
  }
  publishing.value = true;
  try {
    // publish 版本(POST publish → research_versions 指针快照)
    // 2026-09-15: 标签改成阶段语义的 phase3_materials —— /versions/current 靠标签找各阶段
    //   最新版本(合稿门禁"请先完成当前 Phase 4"要读它)。原先写的是中文「素材版本」,
    //   后端认不出, phase3Version 永远是 null。
    await q(`/research/projects/${store.taskId}/publish`, { method: "POST", body: { label: "phase3_materials" } }).catch(() => null);
    store.setPhase(4);
    toast("素材版本已发布, 进入文本创作", "success");
    void router.push("/workflow/workspace");
  } catch {
    toast("发布失败", "error");
  } finally {
    publishing.value = false;
  }
}

onMounted(async () => {
  void loadCnkiIdentity();
  await store.loadProject().catch(() => null);
  await loadMaterials();
  // V417: 接外部模块投递的素材(文献库检索结果/论文评审意见/统计结果/图表), 落 research_materials
  await importExternalMaterials();
  // 默认展开非空分类(闭源默认)
  const nonEmpty = Object.entries(grouped.value).filter(([, list]) => list.length).map(([k]) => k);
  if (nonEmpty.length) expandedCats.value = new Set(nonEmpty);
});
</script>

<template>
  <div
    class="workflow-page max-w-5xl mx-auto px-6 py-8 pb-16 h-full overflow-y-auto"
    :data-assistant-material-count="String(materials.length)"
    :data-assistant-async-busy="matAsyncBusy ? 'true' : 'false'"
    :data-assistant-async-reason="matAsyncReason"
  >
    <PhaseProgressBar />
    <h1 class="wf-h1">素材准备</h1>
    <!-- 页头三行状态区(闭源: 计数 | 阶段说明 | 版本状态, 竖线分隔) -->
    <div class="mat-stats">
      <span><span class="ms-num">{{ materials.length }}</span></span>
      <span class="ms-sep"></span>
      <span>按流程完成素材整理后即可进入创作</span>
      <span class="ms-sep"></span>
      <span>{{ store.phase >= 4 ? "素材版本已发布" : "素材版本待发布" }}</span>
    </div>

    <!-- ═══ 补充素材来源(闭源整卡: 三主按钮 + 手动添加四格 + 从其他模块导入两格) ═══ -->
    <section class="source-card">
      <h2 class="sc-title">补充素材来源</h2>
      <div class="sc-actions">
        <button class="sc-btn-primary" data-control="workflow:smart-generate" @click="generatePlan">智能生成素材</button>
        <button class="sc-btn-outline" data-control="workflow:review-materials" @click="reviewAll">审视素材</button>
        <button class="sc-btn-outline" data-control="workflow:allocate" :disabled="!materials.length" @click="runAllocate">编排素材</button>
      </div>

      <!-- ═══ 文献库身份(2026-09-19) ═══
           用户要在"用自己的账户"与"用机构订阅账户"之间选, 并希望登录后平台直接拿它去查。
           ⚠ 前提必须说清: **平台不保存知网账号密码** —— 知网访问走的是**你自己浏览器里的登录态**。
             所以这里做的是"**选模式 + 把当前身份读出来给你看**", 不是"把密码交给平台"。
             那是安全与合规的硬边界, 不是没做完。 -->
      <h3 class="sc-group">文献库身份</h3>
      <div class="cnki-identity">
        <div class="ci-modes" role="radiogroup" aria-label="文献库账户模式">
          <button
            v-for="m in CNKI_MODES" :key="m.value"
            class="ci-mode" :class="{ on: cnkiMode === m.value }" role="radio"
            :aria-checked="cnkiMode === m.value"
            :data-control="`workflow:cnki-mode-${m.value}`"
            :title="m.hint"
            @click="cnkiMode = m.value"
          >{{ m.label }}</button>
        </div>
        <div class="ci-row">
          <span class="ci-label">当前身份</span>
          <span v-if="cnkiBusy" class="ci-val ci-dim">读取中…</span>
          <span v-else-if="cnkiIdentity?.loggedIn" class="ci-val">
            {{ cnkiIdentity.showName || cnkiIdentity.userName }}
            <span class="ci-badge" :class="cnkiIdentity.isInstitution ? 'inst' : 'personal'">
              {{ cnkiIdentity.isInstitution ? "机构订阅" : "个人账户" }}
            </span>
          </span>
          <span v-else class="ci-val ci-dim">未检测到登录态</span>
          <button class="ci-refresh" data-control="workflow:cnki-refresh" :disabled="cnkiBusy" @click="loadCnkiIdentity">刷新</button>
        </div>
        <p class="ci-note">
          平台<strong>不保存</strong>知网账号密码。请先在 Edge 里登录<strong>你自己的账户</strong>或<strong>机构订阅账户</strong>，再点「刷新」。
        </p>
      </div>

      <!-- ═══ 文献检索(中文三大库, 2026-09-19) ═══
           走用户浏览器里的机构登录态: 这三家都没有对外检索 API, 检索页是 SPA 空壳。
           ⚠ 平台不存它们的账号密码 —— 未登录时后端返回 409, 界面提示"去登录", 不是"重试"。 -->
      <h3 class="sc-group">文献检索（中文三大库）</h3>
      <div class="lit-search">
        <div class="ls-row">
          <div class="ls-srcs" role="radiogroup" aria-label="文献源">
            <button
              v-for="s in LIT_SOURCES" :key="s.id"
              class="ls-src" :class="{ on: litSource === s.id }" role="radio"
              :aria-checked="litSource === s.id"
              :data-control="`workflow:lit-source-${s.id}`"
              @click="litSource = s.id"
            >{{ s.label }}</button>
          </div>
          <input
            v-model="litQuery" class="ls-input" placeholder="检索词，如：数字经济"
            data-control="workflow:lit-query"
            @keydown.enter="runLitSearch"
          />
          <button class="ls-go" data-control="workflow:lit-search" :disabled="litBusy" @click="runLitSearch">
            {{ litBusy ? "检索中…" : "检索" }}
          </button>
        </div>

        <p v-if="litNote" class="ls-note" :class="litNote.kind">{{ litNote.text }}</p>

        <template v-if="litHits.length">
          <div class="ls-meta">
            <span>共 {{ litHits.length }} 条{{ litTotal ? `（页面显示命中 ${litTotal}）` : "" }}</span>
            <button class="ls-import" data-control="workflow:lit-import" :disabled="!litPicked.size" @click="importLitHits">
              入库选中的 {{ litPicked.size }} 条
            </button>
          </div>
          <div class="ls-list">
            <label v-for="h in litHits" :key="h.index" class="ls-item" :class="{ picked: litPicked.has(h.index) }">
              <input type="checkbox" :checked="litPicked.has(h.index)" @change="toggleLitPick(h.index)" />
              <span class="ls-body">
                <span class="ls-title">{{ h.title }}</span>
                <span class="ls-sub">
                  <template v-if="h.journal">{{ h.journal }}</template>
                  <template v-if="h.issue"> · {{ h.issue }}</template>
                  <template v-if="h.type"> · {{ h.type }}</template>
                </span>
                <span v-if="h.abstract" class="ls-abs">{{ h.abstract }}</span>
              </span>
            </label>
          </div>
        </template>
      </div>

      <h3 class="sc-group">手动添加</h3>
      <div class="sc-grid-4">
        <button class="sc-tile" data-control="workflow:manual-literature" @click="openAdd('literature')">
          <span class="sc-icon"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5.5A2.5 2.5 0 016.5 3H19v16H6.5A2.5 2.5 0 004 21.5V5.5zM8 8h7M8 12h7" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
          <span class="sc-tile-text">检索文献</span>
        </button>
        <button class="sc-tile" data-control="workflow:manual-table" @click="openAdd('data')">
          <span class="sc-icon"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 5h18v14H3zM3 10h18M9 10v9" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
          <span class="sc-tile-text">添加表格</span>
        </button>
        <button class="sc-tile" data-control="workflow:manual-theory" @click="openAdd('theory')">
          <span class="sc-icon"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5a2 2 0 012-2h12v18H6a2 2 0 01-2-2V5zM8 7h8M8 11h8" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
          <span class="sc-tile-text">添加理论</span>
        </button>
        <label class="sc-tile" data-control="workflow:upload-attachment">
          <span class="sc-icon"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.5V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h9M16 3v4M8 3v4M3 9h18" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
          <span class="sc-tile-text">上传附件</span>
          <input type="file" accept=".pdf,.docx,.txt,.md,.csv,.tsv" style="display: none" @change="(ev) => { const f = (ev.target as HTMLInputElement).files?.[0]; (ev.target as HTMLInputElement).value = ''; if (f) void uploadMaterialFile('document', f); }" />
        </label>
      </div>

      <h3 class="sc-group">从其他模块导入</h3>
      <div class="sc-grid-2">
        <button class="sc-tile wide" data-control="workflow:goto-statistics" @click="gotoModule('statistics')">
          <span class="sc-tile-left">
            <span class="sc-icon"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke-linecap="round" /></svg></span>
            <span class="sc-tile-text">前往数据分析模块进行分析</span>
          </span>
          <span class="sc-arrow">›</span>
        </button>
        <button class="sc-tile wide" data-control="workflow:goto-viz" @click="gotoModule('viz')">
          <span class="sc-tile-left">
            <span class="sc-icon"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
            <span class="sc-tile-text">前往科研绘图模块进行分析</span>
          </span>
          <span class="sc-arrow">›</span>
        </button>
      </div>
    </section>

    <!-- 设计思路(闭源: 研究逻辑全文卡) -->
    <div v-if="store.project.logicFlow" class="design-card">
      <div class="dc-head">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.4.3.6.8.7 1.3l.1.8h5.4l.1-.8c.1-.5.3-1 .7-1.3A6 6 0 0012 3z" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <span>设计思路</span>
      </div>
      <p class="dc-body">{{ store.project.logicFlow }}</p>
    </div>

    <h2 class="mat-section-title">已整理素材</h2>

    <!-- 分类手风琴 -->
    <div class="cat-list">
      <section v-for="cat in CATS" :key="cat.key" class="cat-card">
        <!-- 头行: 图标块 + 标题 + 计数 + **行内操作按钮**(折叠态也可见) + caret -->
        <div class="cat-head">
          <span class="cat-icon-box" @click="toggleCat(cat.key)">
            <span class="cat-icon">{{ cat.icon }}</span>
          </span>
          <div class="cat-title-wrap" @click="toggleCat(cat.key)">
            <span class="cat-name">{{ cat.label }}</span>
            <span class="cat-count">{{ catCount(cat.key) }} 项</span>
          </div>
          <div class="cat-head-actions">
            <!-- 数据分析素材(闭源头行三个按钮: 上传图片 / 前往数据分析 / 前往科研绘图)。
                 2026-09-15: 原先 `cat.key !== 'dataAnalysis'` 把这类的 aiAction 整个屏蔽掉,
                 于是「上传图片」没有入口, 而 uploadMaterialFile 的图片分支成了死代码。 -->
            <template v-if="cat.key === 'dataAnalysis'">
              <label class="cat-inline-btn" data-control="workflow:upload-image">
                上传图片
                <input type="file" accept=".png,.jpg,.jpeg,.webp" style="display: none"
                  @change="(ev) => { const f = (ev.target as HTMLInputElement).files?.[0]; (ev.target as HTMLInputElement).value = ''; if (f) void uploadMaterialFile('dataAnalysis', f); }" />
              </label>
              <label class="cat-inline-btn" data-control="workflow:upload-data">
                {{ dataBusy ? "上传中…" : "上传数据" }}
                <input type="file" accept=".csv,.tsv,.xlsx,.xls,.json" style="display: none" :disabled="dataBusy"
                  @change="(ev) => { const f = (ev.target as HTMLInputElement).files?.[0]; (ev.target as HTMLInputElement).value = ''; void uploadDataFile(f); }" />
              </label>
              <button class="cat-inline-btn" :data-control="`workflow:goto-statistics-${cat.key}`" @click.stop="gotoModule('statistics')">前往数据分析</button>
              <button class="cat-inline-btn" :data-control="`workflow:goto-viz-${cat.key}`" @click.stop="gotoModule('viz')">前往科研绘图</button>
            </template>
            <template v-else>
              <!-- 2026-09-16: id 必须逐类唯一。原先 5 个分类共用 `workflow:cat-generate`,
                   而科研助手的上报按 id 去重(actions-bridge.collectDomActions) —— 结果是
                   表格/理论/数据/附件四类的行内动作在助手里**不可见、不可点**, 只剩文献类那一条。
                   `goto-statistics`/`goto-viz` 同理(页面里共出现 3 次)。
                   另: 附件类没有 AI 生成能力, cat.aiAction 对它为空, 靠 v-if 兜住;
                   原先 click 里写 `cat.key === 'document' ? undefined : ...` 是死条件(该按钮根本不渲染)。 -->
              <button
                v-if="cat.aiAction"
                class="cat-inline-btn" :disabled="genDialog.open"
                :data-control="`workflow:cat-generate-${cat.key}`"
                @click.stop="aiGenerate(cat.key)"
              >{{ cat.aiAction }}</button>
            </template>
            <button v-if="cat.manualAction" class="cat-inline-btn" :data-control="`workflow:cat-add-${cat.key}`" @click.stop="openAdd(cat.key)">{{ cat.manualAction }}</button>
            <span class="cat-caret" :class="{ open: expandedCats.has(cat.key) }" @click="toggleCat(cat.key)">▼</span>
          </div>
        </div>
        <div v-if="expandedCats.has(cat.key)" class="cat-body">
          <div v-if="!catCount(cat.key)" class="cat-empty">暂无{{ cat.label }}素材</div>
          <div v-else class="mat-list">
            <div v-for="m in grouped[cat.key]" :key="m.id" class="mat-card">
              <!-- 卡头: 章节徽标 + 标题 + hover 出现的编辑/删除 -->
              <div class="mat-head">
                <span v-if="sectionBadgeOf(m)" class="mat-sec-chip">{{ sectionBadgeOf(m) }}</span>
                <strong class="mat-title">{{ m.title || "未命名素材" }}</strong>
                <span class="mat-head-ops">
                  <button class="mat-op" data-control="workflow:edit-material" @click.stop="openEdit(m)">编辑</button>
                  <button class="mat-op danger" data-control="workflow:delete-material" @click.stop="removeMaterial(m)">删除</button>
                </span>
              </div>
              <!-- 文献类: 「共 N 条文献」+ 逐条结构化卡。
                   2026-09-15 补: 原先不论哪类都直出 contentMd 前 120 字, 检索到的文献被压成一坨文本,
                   作者/年份/出处读不出来。数据取后端 references_json 的**真命中**(不臆造字段)。 -->
              <template v-if="cat.key === 'literature' && (m.references?.length ?? 0) > 0">
                <div class="ref-count">共 {{ m.references!.length }} 条文献</div>
                <div class="ref-list">
                  <div v-for="(ref, ri) in m.references" :key="ri" class="ref-item">
                    <span class="ref-num">{{ ri + 1 }}</span>
                    <div class="ref-body">
                      <div class="ref-title">{{ ref.title || "（无标题）" }}</div>
                      <div class="ref-meta">
                        <span v-if="ref.author || (ref as any).authors">{{ ref.author || (ref as any).authors }}</span>
                        <span v-if="(ref as any).venue" class="ref-venue">{{ (ref as any).venue }}</span>
                        <span v-if="ref.source" class="ref-source">{{ ref.source }}</span>
                        <span v-if="ref.year">· {{ ref.year }}</span>
                        <span v-if="refVol(ref)" class="ref-vol">{{ refVol(ref) }}</span>
                      </div>
                      <div v-if="(ref as any).doi" class="ref-doi">DOI: {{ (ref as any).doi }}</div>
                      <div v-if="ref.gbRef" class="ref-gb">{{ ref.gbRef }}</div>
                    </div>
                  </div>
                </div>
              </template>
              <!-- 通用分支(表格/理论/附件等非文献类)。
                   2026-09-16 修: 原先硬截断 120 字 —— AI 生成的表格素材(contentMd 是
                   `- 表题: [列名|列名] 用途` 列表)、理论素材(core + 本文应用)都读不全,
                   用户看不到自己生成的东西。闭源这里是**全量**渲染 `o.content`。
                   改成: 默认全文, 超过 400 字折叠, 点「展开全文」看剩余。 -->
              <template v-else-if="m.contentMd && !(m as any).imageDataUrl && !m.tableData">
                <div class="mat-content">{{ expandedIds.has(m.id) ? String(m.contentMd) : String(m.contentMd).slice(0, 400) }}</div>
                <button
                  v-if="String(m.contentMd).length > 400"
                  type="button" class="mat-more" :data-control="`workflow:expand-material-${m.id}`"
                  @click.stop="toggleExpand(m.id)"
                >{{ expandedIds.has(m.id) ? "收起" : `展开全文（共 ${String(m.contentMd).length} 字）` }}</button>
              </template>
              <!-- B5: 图片素材预览(点击全屏放大; 闭源 imageDataUrl 语义) -->
              <div v-if="(m as any).imageDataUrl" class="mat-img">
                <img :src="(m as any).imageDataUrl" :alt="m.title" class="mat-img-src" @click="openImagePreview((m as any).imageDataUrl)" />
              </div>
              <div v-else-if="m.contentMd && /^!\[[^\]]*\]\((\/api\/[^)]+|data:image\/[^)]+)\)/.test(m.contentMd)" class="mat-img">
                <img :src="String(m.contentMd).match(/^!\[[^\]]*\]\(([^)]+)\)/)?.[1] ?? ''" :alt="m.title" class="mat-img-src" @click="openImagePreview(String(m.contentMd).match(/^!\[[^\]]*\]\(([^)]+)\)/)?.[1] ?? '')" />
              </div>
              <!-- 表格预览(闭源 max-h-20 可滚动的真三线表, 不截断行) -->
              <div v-if="m.tableData && Array.isArray((m as any).tableData?.columns) && Array.isArray((m as any).tableData?.rows)" class="mat-table">
                <table class="three-line-table">
                  <thead><tr><th v-for="c in m.tableData.columns" :key="c">{{ c }}</th></tr></thead>
                  <tbody>
                    <tr v-for="(r, ri) in m.tableData.rows" :key="ri">
                      <td v-for="(cell, ci) in r" :key="ci">{{ cell }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="mat-foot">
                <span v-if="m.sectionId || (m as any).sectionIds?.length" class="sec-chip">📎 已关联</span>
                <!-- B5: 文献来源徽章(闭源: 文献库检索/内部资料 + sourceStatus completed/empty/failed) -->
                <span v-if="mKindBadge(m)" class="src-badge" :class="mKindBadge(m)!.cls">{{ mKindBadge(m)!.text }}</span>
                <span class="mat-words">{{ wordCountOf(m) }} 字</span>
                <span class="mat-date">{{ m.createdAt ? m.createdAt.slice(0, 10).replace(/-/g, "/") : "" }}</span>
                <button class="mat-src-btn" data-control="workflow:open-sources" title="查看该素材的来源文献/出处" @click.stop="openSources(m)">来源</button>
                <button v-if="!(m.sectionId || (m as any).sectionIds?.length)" class="mat-alloc" @click.stop="runAllocate">编排</button>
              </div>
            </div>
          </div>
          <!-- 继续搜集(闭源每类底部一行)。
               2026-09-16 修条件: 原先只判 `cat.aiAction` —— 空分类底部会同时出现
               「暂无X素材」和「＋继续搜集X素材」, 自相矛盾。闭源条件是
               `hasAI && items.length > 0`: 一条都没有时不该引导"继续搜集"。 -->
          <button v-if="cat.aiAction && catCount(cat.key) > 0" class="cat-more" :data-control="`workflow:cat-more-${cat.key}`" @click.stop="aiGenerate(cat.key)">
            ＋ 继续搜集{{ cat.label.replace("素材", "") }}素材
          </button>
        </div>
      </section>
    </div>

    <!-- 审视报告 -->
    <div v-if="store.materialReviewReport" class="review-report">
      <details>
        <summary class="report-head">素材审视报告</summary>
        <div class="report-body markdown-body" v-html="reviewReportHtml"></div>
      </details>
    </div>

    <!-- 底部操作(闭源顺序: 描边返回在**左**, flex-1 主按钮在**右**) -->
    <div class="wf-actions">
      <button class="btn-back" data-control="workflow:back" @click="router.push('/workflow/sections')">返回章节清单</button>
      <button class="btn-primary" data-control="workflow:confirm-materials" :disabled="publishing" @click="publishAndEnter">
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
              <button class="btn-smart" @click="generatePlan" data-control="workflow:regenerate-plan">重新生成</button>            </div>
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
            <button class="btn-primary" data-control="workflow:confirm-plan" @click="executePlan">开始执行</button>
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
            <!-- 研究变量参考(闭源仅文献类展示: 角色圆点 + 中文角色 + 变量名) -->
            <div v-if="genDialog.catKey === 'literature' && store.variables.length" class="gen-vars">
              <p class="gv-title">研究变量参考（可据此查询）</p>
              <div class="gv-chips">
                <span v-for="v in store.variables" :key="v.name" class="gv-chip">
                  <i class="gv-dot" :style="{ background: roleColor(v.role) }"></i>{{ v.role }}　{{ v.name }}
                </span>
              </div>
            </div>
            <!-- 文献类: 检索结果卡(闭源生成前展示检索命中; 这里用后端返回的**真命中**条目) -->
            <div v-if="genDialog.catKey === 'literature' && genDialog.retrievedRefs.length" class="gen-refs">
              <p class="gr-title">本次检索命中 {{ genDialog.retrievedRefs.length }} 条（来自内部库真命中）</p>
              <div class="ref-list">
                <div v-for="(ref, ri) in genDialog.retrievedRefs" :key="ri" class="ref-item">
                  <span class="ref-num">{{ ri + 1 }}</span>
                  <div class="ref-body">
                    <div class="ref-title">{{ String(ref.title ?? "（无标题）") }}</div>
                    <div class="ref-meta">
                      <span v-if="ref.author || ref.authors">{{ ref.author || ref.authors }}</span>
                      <span v-if="ref.venue" class="ref-venue">{{ ref.venue }}</span>
                      <span v-if="ref.source" class="ref-source">{{ ref.source }}</span>
                      <span v-if="ref.year">· {{ ref.year }}</span>
                      <span v-if="refVol(ref)" class="ref-vol">{{ refVol(ref) }}</span>
                    </div>
                    <div v-if="ref.doi" class="ref-doi">DOI: {{ ref.doi }}</div>
                    <div v-if="ref.excerpt" class="ref-gb">{{ String(ref.excerpt).slice(0, 160) }}</div>
                  </div>
                </div>
              </div>
            </div>
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
            <button v-if="!genDialog.preview" class="btn-primary gen-start" :disabled="genDialog.generating || !genDialog.prompt.trim() || !genDialog.sectionId" @click="runGenStart" data-control="workflow:run-gen">
              {{ genDialog.generating ? "生成中..." : "开始生成" }}
            </button>
            <!-- 已预览: 保存到素材库 / 完成 -->
            <button v-else class="btn-primary gen-start" @click="finishGenSave" data-control="workflow:finish-gen-save">保存到素材库</button>
            <!-- 2026-09-16: 原先生成中次按钮是 `:disabled="generating"` + 文案「取消」——
                 看着能取消, 实际点不动(disabled), 用户只能干等。现在生成中允许中止:
                 真去取消后端任务 + 复位弹层状态。 -->
            <button
              class="btn-back"
              :data-control="genDialog.generating ? 'workflow:cancel-gen' : 'workflow:discard-gen'"
              @click="genDialog.generating ? cancelGen() : closeGenDialog()"
            >{{ genDialog.generating ? "取消" : genDialog.preview ? "放弃" : "取消" }}</button>
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
            <button class="btn-primary" :disabled="allocBusy || allocDialog.loading" data-control="workflow:confirm-allocate" @click="confirmAllocate">
              {{ allocBusy ? "关联中…" : `确认关联（${allocSelected} 个）` }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!--
      素材来源弹层。
      2026-09-17 修: 这个弹层此前**只有状态没有视图** —— `openSources()` 会 set
      `srcDialog.open = true` 并真发 GET /materials/:id/sources, 但模板里从来没有渲染过它。
      用户点「来源」的观感是: 什么也没发生(请求在 network 里 200, 界面上零反馈)。
      GET/POST 两个端点一直在, 是前端把这半边功能丢了。
      数据源: 后端 `getMaterialSources` → `{ sources: material.source_docs ?? [], sourceRef }`
      (检索命中的文献条目, 在素材入库时一并落库)。
    -->
    <Teleport to="body">
      <div v-if="srcDialog.open" class="modal-mask" @click.self="closeSrcDialog">
        <div class="modal-card">
          <div class="modal-head">
            <h3>素材来源 · {{ srcDialog.title }}</h3>
            <button class="modal-x" data-control="workflow:close-sources" @click="closeSrcDialog">×</button>
          </div>
          <div class="modal-body">
            <p class="src-sub">该素材入库时命中的来源文献（用于溯源核对，不参与正文生成）。</p>
            <div v-if="srcDialog.loading" class="src-state">正在读取来源…</div>
            <div v-else-if="srcDialog.error" class="src-state err">{{ srcDialog.error }}</div>
            <!-- 空态必须与"加载失败"分开说 —— 两者都空白的话用户无法判断是没来源还是坏了 -->
            <div v-else-if="!srcDialog.sources.length" class="src-state">
              这条素材没有记录来源文献（手动添加的素材通常没有）。
              <template v-if="srcDialog.sourceRef"><br />引用标识：<code>{{ srcDialog.sourceRef }}</code></template>
            </div>
            <div v-else class="src-list">
              <div v-for="(d, i) in srcDialog.sources" :key="i" class="src-row">
                <span class="src-idx">{{ i + 1 }}</span>
                <div class="src-main">
                  <strong class="src-title">{{ String((d as any).title ?? "未命名文献") }}</strong>
                  <span class="src-meta">
                    <template v-if="(d as any).authors">{{ String((d as any).authors) }}</template>
                    <template v-if="(d as any).year"> · {{ String((d as any).year) }}</template>
                  </span>
                  <p v-if="(d as any).excerpt" class="src-excerpt">{{ String((d as any).excerpt) }}</p>
                </div>
              </div>
              <p v-if="srcDialog.sourceRef" class="src-ref">引用标识：<code>{{ srcDialog.sourceRef }}</code></p>
            </div>
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
              <textarea v-model="editDialog.material.contentMd" class="f-textarea" rows="6" placeholder="素材内容(文本/文献引用格式)…"></textarea>
            </div>
            <!--
              结构化文献条目(闭源 MaterialEditorDialog 的逐字段表单)。
              2026-09-16 补: 原先只有「标题 + 自由文本」两个框, 作者/年份/来源/DOI 无处可填,
              `references[]` 恒空 —— 文献卡的结构化分支与后端参考文献池都拿不到数据。
              这里给"已录入条目"一个可逐条删除的列表, 新条目通过下面的批量解析或此项录入。
            -->
            <div v-if="editDialog.kind === 'literature'" class="refs-box">
              <div class="refs-head">
                <span>结构化文献条目</span>
                <span class="refs-count">{{ (editDialog.material.references ?? []).length }} 条</span>
              </div>
              <div v-if="!(editDialog.material.references ?? []).length" class="refs-empty">
                暂无条目。可在下方「批量粘贴文献」中解析后录入 — 录入的条目会进入正文参考文献池。
              </div>
              <div v-else class="refs-list">
                <div v-for="(r, ri) in editDialog.material.references" :key="ri" class="ref-item">
                  <span class="ri-num">{{ ri + 1 }}</span>
                  <span class="ri-title">{{ r.title || "未填题目" }}</span>
                  <span v-if="r.authors || r.author" class="ri-meta">{{ (r.authors || r.author || "").slice(0, 18) }}</span>
                  <span v-if="r.year" class="ri-meta">{{ r.year }}</span>
                  <span v-if="r.source || r.venue" class="ri-meta">{{ (r.source || r.venue || "").slice(0, 16) }}</span>
                  <span v-if="r.doi" class="ri-doi">DOI:{{ r.doi.slice(0, 18) }}</span>
                  <button type="button" class="ri-del" title="删除此条" @click="removeRefAt(ri)">×</button>
                </div>
              </div>
              <!-- 单条手动录入(作者/年份/来源/DOI 逐字段) -->
              <div class="ref-add">
                <input v-model="newRef.title" class="rf-in wide" placeholder="题目 *" />
                <input v-model="newRef.author" class="rf-in" placeholder="作者" />
                <input v-model="newRef.year" class="rf-in narrow" placeholder="年份" />
                <input v-model="newRef.source" class="rf-in" placeholder="期刊/来源" />
                <input v-model="newRef.doi" class="rf-in" placeholder="DOI" />
                <button type="button" class="btn-manual" data-control="workflow:add-ref-row" @click="addRefRow">添加此条</button>
              </div>
            </div>
            <!-- B2 文献批量粘贴解析(仅文献类) -->
            <div v-if="editDialog.kind === 'literature'" class="bulk-ref-box">
              <details>
                <summary class="bulk-summary">📋 批量粘贴文献(每行或每段一条, APA/GB/混合)</summary>
                <div class="bulk-body">
                  <textarea v-model="bulkRefText" class="f-textarea" rows="4" placeholder="郭峰,王靖一.测度中国数字普惠金融发展[J].经济学(季刊),2020,19(4).&#10;Stiglitz J E, Weiss A. Credit Rationing in Markets with Imperfect Information[J]. AER, 1981, 71(3): 393-410."></textarea>
                  <div class="bulk-actions">
                    <button type="button" class="btn-manual" @click="runBulkParse" data-control="workflow:bulk-parse">解析</button>
                    <button type="button" v-if="parsedRefs.length" class="btn-manual" @click="applyParsedRefs" data-control="workflow:apply-parsed-recs">应用 {{ parsedRefs.length }} 条到内容</button>
                  </div>
                  <div v-if="parsedRefs.length" class="parsed-list">
                    <div v-for="(r, ri) in parsedRefs.slice(0, 6)" :key="ri" class="parsed-item">
                      <span class="pi-num">{{ ri + 1 }}</span>
                      <span class="pi-title">{{ r.title || "未识别题目" }}</span>
                      <span v-if="r.author" class="pi-meta">{{ r.author.slice(0, 20) }}</span>
                      <span v-if="r.year" class="pi-meta">{{ r.year }}</span>
                      <!-- 卷(期):页码 —— 解析器抽了这三项, 此前预览卡不渲染, 用户看不到解析结果对不对 -->
                      <span v-if="refVol(r)" class="pi-meta">{{ refVol(r) }}</span>
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
            <button class="btn-primary" @click="saveManual" data-control="workflow:save-manual">保存</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>

.workflow-page {
/* 文献检索(中文三大库) */
.lit-search { margin: 6px 0 12px; padding: 10px 12px; border: 1px solid #222F44; border-radius: 8px; background: #11192C; }
.ls-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ls-srcs { display: flex; gap: 4px; }
.ls-src { padding: 4px 10px; border: 1px solid #2A3A55; border-radius: 6px; background: #16233A; color: #A9BBD0; font-size: 12px; cursor: pointer; }
.ls-src.on { border-color: #4D84CB; background: #1B2C4A; color: #E8EEF7; }
.ls-input { flex: 1; min-width: 160px; padding: 5px 10px; border: 1px solid #2A3A55; border-radius: 6px; background: #0D1526; color: #E8EEF7; font-size: 12px; }
.ls-go { padding: 5px 14px; border: 0; border-radius: 6px; background: #4D84CB; color: #F1F5F9; font-size: 12px; cursor: pointer; }
.ls-go:disabled { opacity: 0.5; cursor: default; }
.ls-note { margin: 8px 0 0; font-size: 11px; line-height: 1.7; }
.ls-note.warn { color: #D9A441; }
.ls-note.err { color: #D9706A; }
.ls-note.info { color: #6B7A90; }
.ls-meta { display: flex; align-items: center; justify-content: space-between; margin: 10px 0 6px; font-size: 11px; color: #7A8AA0; }
.ls-import { padding: 4px 12px; border: 1px solid #2A3A55; border-radius: 6px; background: #16233A; color: #A9BBD0; font-size: 11px; cursor: pointer; }
.ls-import:disabled { opacity: 0.45; cursor: default; }
.ls-list { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.ls-item { display: flex; gap: 8px; padding: 8px 10px; border: 1px solid #1E2A40; border-radius: 6px; background: #0D1526; cursor: pointer; }
.ls-item.picked { border-color: #4D84CB; background: #13203A; }
.ls-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ls-title { font-size: 12.5px; color: #E8EEF7; line-height: 1.5; }
.ls-sub { font-size: 11px; color: #7A8AA0; }
.ls-abs { font-size: 11px; color: #6B7A90; line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* 文献库身份卡 */
.cnki-identity { margin: 6px 0 12px; padding: 10px 12px; border: 1px solid #222F44; border-radius: 8px; background: #11192C; }
.ci-modes { display: flex; gap: 6px; margin-bottom: 8px; }
.ci-mode { padding: 4px 12px; border: 1px solid #2A3A55; border-radius: 6px; background: #16233A; color: #A9BBD0; font-size: 12px; cursor: pointer; }
.ci-mode.on { border-color: #4D84CB; background: #1B2C4A; color: #E8EEF7; }
.ci-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.ci-label { color: #7A8AA0; }
.ci-val { color: #E8EEF7; }
.ci-dim { color: #6B7A90; }
.ci-badge { margin-left: 6px; padding: 1px 6px; border-radius: 4px; font-size: 10px; }
.ci-badge.inst { background: #1B3A2A; color: #6FD08C; }
.ci-badge.personal { background: #1B2C4A; color: #7FB2EC; }
.ci-refresh { margin-left: auto; padding: 3px 10px; border: 1px solid #2A3A55; border-radius: 6px; background: #16233A; color: #A9BBD0; font-size: 11px; cursor: pointer; }
.ci-refresh:disabled { opacity: 0.5; cursor: default; }
.ci-note { margin: 8px 0 0; font-size: 11px; line-height: 1.7; color: #6B7A90; }
.ci-note strong { color: #A9BBD0; }
 width: 100%; box-sizing: border-box; }
.wf-h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; color: #E8EEF7; }
.wf-sub { margin: 0 0 16px; font-size: 13px; color: #8B9BB1; }
/* 页头三行状态区(闭源: N | 说明 | 版本状态, 中间夹竖线) */
.mat-stats { display: flex; align-items: center; gap: 12px; font-size: 12.5px; color: #8B9BB1; margin: 10px 0 18px; flex-wrap: wrap; }
.ms-num { color: #E8EEF7; font-weight: 600; font-size: 13.5px; }
.ms-sep { width: 1px; height: 12px; background: #46587A; display: inline-block; }

/* 补充素材来源整卡 */
.source-card {
  background: #11192C; border: 1px solid #222F44; border-radius: 12px;
  padding: 16px 20px; margin-bottom: 16px; /* 闭源 space-y-4=16px, p-4=16px */
}
.sc-title { margin: 0 0 14px; font-size: 16px; font-weight: 600; color: #E8EEF7; }
.sc-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
.sc-btn-primary {
  padding: 8px 18px; border: 0; border-radius: 9px; background: #dc2626;
  color: #F1F5F9; font-size: 13px; font-weight: 500; cursor: pointer;
}
.sc-btn-primary:hover { background: #b91c1c; }
.sc-btn-outline {
  padding: 8px 18px; border-radius: 9px; background: #11192C;
  border: 1px solid #dc2626; color: #E88A8A; font-size: 13px; cursor: pointer;
}
.sc-btn-outline:hover { background: #2A1C1C; }
.sc-btn-outline:disabled { opacity: 0.45; cursor: not-allowed; }
.sc-group { margin: 0 0 10px; font-size: 11px; font-weight: 500; color: #7A8AA0; letter-spacing: 0.06em; }
.sc-grid-4 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 16px; }
.sc-grid-2 { display: grid; grid-template-columns: 1fr; gap: 10px; }
@media (min-width: 768px) {
  .sc-grid-4 { grid-template-columns: repeat(4, 1fr); }
  .sc-grid-2 { grid-template-columns: repeat(2, 1fr); }
}
.sc-tile {
  display: flex; align-items: center; gap: 10px; padding: 11px 13px;
  background: #0E1729; border: 1px solid #222F44; border-radius: 9px;
  color: #DCE6F2; font-size: 13px; cursor: pointer; text-align: left;
}
.sc-tile:hover { border-color: #B06A6A; }
.sc-tile.wide { justify-content: space-between; }
.sc-tile-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sc-tile-text { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-icon {
  width: 30px; height: 30px; border-radius: 8px; background: #2A1C1C; color: #E88A8A;
  display: grid; place-items: center; flex-shrink: 0;
}
.sc-arrow { color: #7A8AA0; font-size: 18px; flex-shrink: 0; }
.sc-tile:hover .sc-arrow { color: #dc2626; }

/* 设计思路卡 */
.design-card {
  background: #11192C; border: 1px solid #222F44; border-radius: 10px;
  padding: 12px 16px; margin-bottom: 16px;
}
.dc-head { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; color: #8B9BB1; }
.dc-head span { font-size: 13px; font-weight: 500; color: #DCE6F2; }
.dc-body { margin: 0; font-size: 12.5px; color: #B9C6D8; line-height: 1.7; overflow-wrap: break-word; }
.mat-section-title { margin: 0 0 12px; font-size: 16px; font-weight: 600; color: #E8EEF7; }

.job-bar { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 9px; margin-bottom: 12px; font-size: 13px; }
.job-bar.running { background: #1E2A48; border: 1px solid #bfdbfe; color: #1d4ed8; }
.job-bar.failed { background: #2A1C1C; border: 1px solid #3A2323; color: #dc2626; }
.job-spinner {
  width: 14px; height: 14px; border: 2px solid #93c5fd; border-top-color: #1d4ed8;
  border-radius: 50%; animation: jspin 0.8s linear infinite;
}
@keyframes jspin { to { transform: rotate(360deg); } }
.cat-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; } /* 闭源 space-y-2.5=10px */
.cat-card { background: #11192C; border: 1px solid #222F44; border-radius: 12px; overflow: hidden; }
/* 头行: 图标块 + 标题/计数 + 行内按钮 + caret。行内按钮**折叠态也可见**(闭源如此) */
.cat-head {
  display: flex; align-items: center; gap: 12px; padding: 13px 18px;
  background: #1A2333; user-select: none;
}
.cat-icon-box { cursor: pointer; }
.cat-icon {
  width: 30px; height: 30px; border-radius: 8px;
  background: #2A1C1C; color: #E88A8A; display: grid; place-items: center; font-size: 15px;
}
.cat-title-wrap { display: flex; align-items: center; gap: 8px; cursor: pointer; flex: 1; min-width: 0; }
.cat-name { font-size: 14.5px; font-weight: 600; color: #E8EEF7; }
.cat-count {
  font-size: 11px; color: #7A8AA0; background: #0E1729;
  padding: 2px 9px; border-radius: 10px; flex-shrink: 0;
}
.cat-head-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.cat-inline-btn {
  font-size: 11.5px; padding: 4px 10px; border-radius: 6px;
  background: #0E1729; border: 1px solid #222F44; color: #B9C6D8; cursor: pointer;
}
.cat-inline-btn:hover { background: #1E2A48; color: #E8EEF7; }
.cat-inline-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.cat-caret { color: #7A8AA0; font-size: 10px; cursor: pointer; transition: transform 0.16s; }
.cat-caret.open { transform: rotate(180deg); }
.cat-body { padding: 12px 18px 14px; border-top: 1px solid #212C45; } /* 闭源 space-y-3=12px */
.cat-actions { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.cat-more {
  margin-top: 10px; width: 100%; padding: 7px; border-radius: 7px;
  background: transparent; border: 1px dashed #46587A; color: #8B9BB1;
  font-size: 12px; cursor: pointer;
}
.cat-more:hover { border-color: #B06A6A; color: #E8EEF7; }
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
.mat-src-btn {
  margin-left: 6px; padding: 1px 7px; border: 1px solid #46587A; border-radius: 5px;
  background: #11192C; color: #C7D2E0; font-size: 10px; cursor: pointer;
}
.src-row { padding: 6px 0; border-bottom: 1px solid #222F44; }
.src-row strong { font-size: 12.5px; color: #E8EEF7; }
.src-meta { margin-left: 8px; font-size: 11px; color: #8B9BB1; }
.src-excerpt { margin: 3px 0 0; font-size: 11.5px; line-height: 1.6; color: #C7D2E0; }
.f-hint { font-size: 12px; color: #8B9BB1; margin: 4px 0; }
.mat-head { display: flex; align-items: center; gap: 8px; }
.mat-title { font-size: 13.5px; font-weight: 500; color: #E8EEF7; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 章节徽标(闭源 text-gray-500 小徽标, max-w-[80px] 截断) */
.mat-sec-chip {
  font-size: 10.5px; color: #8B9BB1; background: #1A2333;
  padding: 2px 7px; border-radius: 6px; max-width: 80px; flex-shrink: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 卡头操作(闭源 hover 才出现) */
.mat-head-ops { display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s; flex-shrink: 0; }
.mat-card:hover .mat-head-ops { opacity: 1; }
.mat-op {
  border: 0; background: none; color: #8B9BB1; font-size: 11.5px; cursor: pointer; padding: 1px 4px;
}
.mat-op:hover { color: #E8EEF7; }
.mat-op.danger:hover { color: #dc2626; }
.mat-kind { font-size: 10px; color: #dc2626; background: #2A1C1C; padding: 2px 8px; border-radius: 8px; flex-shrink: 0; }
.mat-content { font-size: 12px; color: #8B9BB1; line-height: 1.55; white-space: pre-wrap; }
.mat-more {
  margin-top: 4px; border: 0; background: transparent; color: #6FA8F5;
  font-size: 11.5px; cursor: pointer; padding: 0; font-family: inherit;
}
.mat-more:hover { text-decoration: underline; }
.mat-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sec-chip { font-size: 10.5px; background: #11192C; color: #E8B54A; padding: 2px 8px; border-radius: 7px; }
.mat-words { font-size: 10.5px; color: #7A8AA0; }
.mat-date { font-size: 10.5px; color: #7A8AA0; }
.mat-foot .mat-src-btn { margin-left: auto; }
.mat-del { border: 0; background: none; color: #8B9BB1; font-size: 11.5px; cursor: pointer; }
.mat-del:hover { color: #dc2626; }
/* 文献类素材: 「共 N 条文献」+ 逐条结构化卡 */
.ref-count { font-size: 11px; color: #7A8AA0; margin-bottom: 6px; }
.gen-refs { margin-bottom: 12px; }
.gr-title { margin: 0 0 7px; font-size: 12px; color: #8B9BB1; }
.ref-list { display: flex; flex-direction: column; gap: 6px; }
.ref-item { display: flex; gap: 8px; padding: 7px 9px; background: #0E1729; border: 1px solid #212C45; border-radius: 8px; }
.ref-num {
  flex-shrink: 0; width: 18px; height: 18px; border-radius: 5px;
  background: #16243F; color: #6FA8F5; font-size: 10.5px; font-weight: 700;
  display: grid; place-items: center;
}
.ref-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ref-title { font-size: 12.5px; color: #E8EEF7; line-height: 1.5; }
.ref-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #8B9BB1; }
/* 期刊名(GB/T 7714 著录载体) / 卷期 / DOI —— 外部源(OpenAlex)才有的字段 */
.ref-venue {
  font-size: 10px; padding: 1px 6px; border-radius: 6px;
  background: #14291F; color: #5FD0B4;
}
.ref-vol { color: #7A8AA0; }
.ref-doi { font-size: 10.5px; color: #5F7288; overflow-wrap: break-word; }
.ref-source {
  font-size: 10px; padding: 1px 6px; border-radius: 6px;
  background: #16243F; color: #6FA8F5;
}
.ref-gb { font-size: 11px; color: #7A8AA0; line-height: 1.5; overflow-wrap: break-word; }

/* 表格预览: 闭源 max-h-20 可滚动, 不截断行(原先 slice(0,3) 会把长表截成"只有表头") */
.mat-table { max-height: 80px; overflow-y: auto; }
/*
 * 三线表 —— 必须是**三条线**: 顶线 / 栏目线 / 底线。
 *
 * 2026-09-16 修: 我方把边框挂在 `th` 上(上 2px + 下 1px), `tbody` **没有底线** ——
 *   表格底部不封口, 只剩两条线。闭源的写法是按语义元素挂:
 *     thead{border-top:2px;border-bottom:1.5px} + tbody{border-bottom:2px}
 *   注: `border-collapse:collapse` 下 thead 的 border 在部分浏览器里不生效,
 *   所以顶/栏目线**同时**挂在 thead 上(与闭源一致), 底线挂 tbody。
 */
.three-line-table { border-collapse: collapse; width: 100%; font-size: 11.5px; }
.three-line-table thead { border-top: 2px solid #46587A; border-bottom: 1.5px solid #46587A; }
.three-line-table th {
  padding: 5px 9px; text-align: left; color: #E8EEF7; white-space: nowrap;
  border: none;
}
.three-line-table td { padding: 4px 9px; color: #DCE6F2; border: none; }
.three-line-table tbody { border-bottom: 2px solid #46587A; }
.three-line-table tbody tr:hover { background: #1A2333; }
.review-report { margin-bottom: 14px; }
.report-head { font-size: 13.5px; font-weight: 600; color: #E8EEF7; cursor: pointer; padding: 9px 13px; background: #11192C; border: 1px solid #3A3020; border-radius: 9px; }
.report-body {
  margin: 0; padding: 12px 15px; background: #11192C;
  border: 1px solid #3A3020; border-top: 0; border-radius: 0 0 9px 9px;
  font-family: inherit; font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; color: #DCE6F2;
}
.wf-actions { display: flex; gap: 10px; margin-top: 6px; }
.wf-actions .btn-primary { flex: 1; }
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
.modal-mask { position: fixed; inset: 0; z-index: 70; /* 2026-09-16: 深色主题下 20% 黑几乎不可见, 弹层与页面无分离感(闭源是浅色底所以 20% 够用) */
  background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; }
.modal-card { width: 520px; max-width: 95vw; background: #11192C; border-radius: 16px; box-shadow: 0 20px 60px rgba(15, 23, 42, 0.25); }
.modal-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #222F44; }
.modal-head h3 { margin: 0; font-size: 16px; color: #E8EEF7; }
.modal-x { border: 0; background: none; font-size: 20px; color: #8B9BB1; cursor: pointer; }
.modal-body { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
.f-row { display: flex; flex-direction: column; gap: 5px; }
.f-row label { font-size: 13px; font-weight: 600; color: #DCE6F2; }
.f-input { padding: 8px 12px; border: 1px solid #222F44; border-radius: 8px; font-size: 13px; }
/* 生成要求文本域(闭源 resize-none —— 让弹层高度稳定, 不被用户拖成两屏) */
.f-textarea { padding: 8px 12px; border: 1px solid #222F44; border-radius: 8px; font-size: 13px; font-family: inherit; resize: none; }
/* 研究变量参考 chips */
.gen-vars { margin-bottom: 12px; }
.gv-title { margin: 0 0 7px; font-size: 12px; color: #8B9BB1; }
.gv-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.gv-chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; color: #C6D2E4; background: #0E1729;
  border: 1px solid #222F44; border-radius: 8px; padding: 3px 9px;
}
.gv-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
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


/* 结构化文献条目(2026-09-16 补) */
.refs-box { border: 1px solid #222F44; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
/* 素材来源弹层(见模板里同名注释: 此前只有状态没有视图) */
.src-sub { margin: 0; font-size: 12px; color: #7A8AA0; line-height: 1.6; }
.src-state { padding: 14px 0; font-size: 13px; color: #8B9BB1; line-height: 1.7; }
.src-state.err { color: #E08A8A; }
.src-state code, .src-ref code { background: #0E1729; border: 1px solid #222F44; border-radius: 4px; padding: 1px 6px; font-size: 12px; }
.src-list { display: flex; flex-direction: column; gap: 8px; max-height: 44vh; overflow-y: auto; }
.src-row { display: flex; gap: 10px; padding: 9px 11px; background: #0E1729; border: 1px solid #222F44; border-radius: 8px; }
.src-idx {
  flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; background: #1E2A48;
  color: #6FA8F5; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center;
}
.src-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.src-title { font-size: 13px; font-weight: 600; color: #E8EEF7; }
.src-meta { font-size: 11.5px; color: #7A8AA0; }
.src-excerpt { margin: 2px 0 0; font-size: 12px; color: #A9BBD0; line-height: 1.6; }
.src-ref { margin: 2px 0 0; font-size: 12px; color: #7A8AA0; }.refs-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: #8B9BB1; margin-bottom: 8px; }
.refs-count { font-size: 11px; background: #1E2A48; color: #759FD7; padding: 1px 7px; border-radius: 8px; }
.refs-empty { font-size: 12px; color: #7A8AA0; padding: 6px 0; }
.refs-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.ref-item { display: flex; align-items: center; gap: 7px; font-size: 12px; color: #DCE6F2; background: #11192C; border: 1px solid #222F44; border-radius: 6px; padding: 4px 8px; }
.ri-num { color: #7A8AA0; flex-shrink: 0; }
.ri-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ri-meta { color: #8B9BB1; font-size: 11px; flex-shrink: 0; }
.ri-doi { color: #6FA8F5; font-size: 11px; flex-shrink: 0; }
.ri-del { border: 0; background: transparent; color: #7A8AA0; cursor: pointer; font-size: 15px; line-height: 1; padding: 0 2px; flex-shrink: 0; }
.ri-del:hover { color: #E88A8A; }
.ref-add { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.rf-in { background: #11192C; border: 1px solid #222F44; border-radius: 6px; color: #E8EEF7; font-size: 12px; padding: 5px 8px; font-family: inherit; min-width: 0; }
.rf-in.wide { flex: 1 1 160px; }
.rf-in.narrow { width: 64px; }
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
.gen-mask { /* 2026-09-16: 深色主题下 20% 黑几乎不可见, 弹层与页面无分离感(闭源是浅色底所以 20% 够用) */
  background: rgba(0, 0, 0, 0.55); }
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
