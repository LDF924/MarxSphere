<script setup lang="ts">
/**
 * WorkspaceView(Phase4 文本创作) — 还原自闭源 WorkspaceView-Baf0x_1H.js(L735-2706, scope data-v-2b778b5d)
 * 三栏: 左章节导航(SectionNavItem 递归)/中正文编辑器+生成控制/右素材卡(MaterialCard)
 * 生成: 单节/批量 phase4_batch job → 泵 → 800ms 轮询 → nodes/sections 回读 content
 */
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useWorkflowStore } from "./stores/workflow";
import type { Section } from "./stores/workflow";
import { createTask, getTask, getNode, putNode } from "@/shared/tasks";
import { toast } from "@/shared/ui";
import { q } from "@/shared/api";
import PhaseProgressBar from "./PhaseProgressBar.vue";

const router = useRouter();
const store = useWorkflowStore();

// ── 选中/展开状态 ──
const expandedIds = ref<Set<string>>(new Set());
const activeSecId = ref("");
const activeSection = computed(() => store.sections.find((s) => s.id === activeSecId.value) ?? null);
const childrenOf = (id: string) => store.sections.filter((s) => s.parentId === id);
const isExpanded = (id: string) => expandedIds.value.has(id);
function toggleExpand(id: string) {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
}
function selectSection(s: Section) {
  // 切章节前退出编辑态(防草稿跨章节误写; 未保存草稿丢弃)
  if (editing.value) {
    editing.value = false;
    editText.value = "";
  }
  activeSecId.value = s.id;
}
// 非空安全访问(模板闭包内 TS 收窄失效)
const activeId = computed(() => activeSection.value?.id ?? "");
// 选中章所属一级章索引(l2 子节 → 归属父一级)
const activeL1Idx = computed(() => {
  const sec = activeSection.value;
  if (!sec) return -1;
  if (sec.level === 1) return l1List.value.findIndex((s) => s.id === sec.id);
  const parent = store.sections.find((s) => s.id === sec.parentId);
  if (parent) return l1List.value.findIndex((s) => s.id === parent.id);
  return -1;
});

// ── 章导航辅助 ──
function cnOf(i: number): string {
  const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];
  return CN[i] ?? String(i + 1);
}
/** 变量角色色(SectionsView 同款 5 色) */
function roleColor(role: string): string {
  const qn: Record<string, string> = {
    "自变量": "#2563eb", "因变量": "#dc2626", "中介": "#E8B54A", "调节": "#7c3aed", "控制": "#6b7280",
    "x": "#2563eb", "y": "#dc2626", "mediator": "#E8B54A", "moderator": "#7c3aed", "control": "#6b7280",
    "影响因素": "#2563eb", "结果表现": "#dc2626", "中间机制": "#E8B54A", "情境条件": "#7c3aed", "背景因素": "#6b7280"
  };
  return qn[String(role ?? "")] ?? "#2563eb";
}
function secStatusDot(s: Section): { cls: string; title: string } {
  const st = s.status ?? "";
  if (st === "generated" || (s.content && s.content.length > 50)) return { cls: "dot-done", title: "已生成" };
  if (st === "generating") return { cls: "dot-generating", title: "生成中" };
  return { cls: "", title: "待生成" };
}
const l1List = computed(() => store.level1Sections);
const genCount = computed(() => l1List.value.filter((s) => s.content && s.content.length > 50).length);
const pendingCount = computed(() => l1List.value.filter((s) => !(s.content && s.content.length > 50)).length);
const progressPct = computed(() => (l1List.value.length ? Math.round((genCount.value / l1List.value.length) * 100) : 0));

// ── 生成状态 ──
const generating = ref(false);
const generateMode = ref<"single" | "batch">("single");
const genStage = ref("");
const genProgress = ref<{ current?: number; total?: number }>({});
let poll: ReturnType<typeof setInterval> | null = null;

function statusText(): string {
  if (generating.value) {
    if (generateMode.value === "batch") return `正在批量生成章节 ${genProgress.value.current ?? 0}/${genProgress.value.total ?? 0}…`;
    return genStage.value || "正在生成章节内容…";
  }
  if (busy.value) return busyText.value;
  return "就绪";
}
const busy = computed(() => generating.value);
const busyText = computed(() => "当前操作处理中");

// ── 单节生成(闭源 me()) ──
async function generateSection() {
  const sec = activeSection.value;
  if (!sec) return;
  if (generating.value) {
    toast(statusText() + ", 请等待完成后再操作", "warning");
    return;
  }
  if (!store.taskId) {
    toast("请先创建并保存工作流任务", "warning");
    return;
  }
  const l1 = sec.level === 1 ? sec : store.sections.find((s) => s.id === sec.parentId);
  if (!l1) return;
  // 子节随父章节一起生成(闭源规则)
  const targets = [l1.id, ...childrenOf(l1.id).map((c) => c.id)];
  generating.value = true;
  generateMode.value = "single";
  genStage.value = "执行智能体开始思考…";
  try {
    const t = await createTask({
      title: `生成章节: ${l1.title}`,
      projectId: store.taskId,
      module: "workflow",
      jobKind: "phase4_batch",
      goal: store.input.title,
      phase: 4,
      phaseLabel: "文本创作",
      inputSnapshot: {
        sections: store.sections.filter((s) => targets.includes(s.id)).map((s) => ({
          id: s.id, title: s.title, level: s.level,
          skill_prompt: s.skill_prompt && s.skill_prompt.trim() ? s.skill_prompt : (s.aiSkill ? JSON.stringify(s.aiSkill) : "")
        }))
      }
    });
    // 立即标记 generating(UI 状态)
    for (const s of store.sections) if (targets.includes(s.id)) s.status = "generating";
    pollTask(t.id, async () => {
      await refreshSections();
      const target = store.sections.find((s) => s.id === l1.id);
      toast(`「${l1.title}」生成完成`, "success");
      if (target) target.status = "generated";
    });
  } catch (e) {
    generating.value = false;
    toast(`生成失败: ${(e as Error).message}`, "error");
  }
}

// ── 批量生成全部(闭源 Me(): 深快照+覆盖确认) ──
async function generateAll() {
  const targets = l1List.value;
  if (!targets.length) return;
  if (generating.value) {
    toast(statusText() + ", 请等待完成后再操作", "warning");
    return;
  }
  if (targets.every((s) => s.content && s.content.length > 50)) {
    const ok = window.confirm("所有章节已有正文。重新生成将覆盖当前内容, 确定要继续吗?");
    if (!ok) return;
  }
  // 深快照(供失败回滚)
  const snapshot = JSON.parse(JSON.stringify(store.sections));
  localStorage.setItem("wf_batch_snapshot", JSON.stringify(snapshot));
  generating.value = true;
  generateMode.value = "batch";
  genProgress.value = { current: 0, total: targets.length };
  try {
    const t = await createTask({
      title: `批量生成全部章节(${targets.length})`,
      projectId: store.taskId,
      module: "workflow",
      jobKind: "phase4_batch",
      goal: store.input.title,
      phase: 4,
      phaseLabel: "文本创作",
      inputSnapshot: {
        sections: store.sections.map((s) => ({
          id: s.id, title: s.title, level: s.level,
          skill_prompt: s.skill_prompt && s.skill_prompt.trim() ? s.skill_prompt : (s.aiSkill ? JSON.stringify(s.aiSkill) : "")
        }))
      }
    });
    for (const s of store.sections) s.status = "generating";
    pollTask(t.id, async () => {
      await refreshSections();
      generating.value = false;
      localStorage.removeItem("wf_batch_snapshot");
      toast(`批量生成完成, 共 ${targets.length} 个章节`, "success");
    }, true);
  } catch (e) {
    // 整批还原(闭源失败路径)
    const snapRaw = localStorage.getItem("wf_batch_snapshot");
    if (snapRaw) {
      try {
        store.sections = JSON.parse(snapRaw);
      } catch { /* 忽略 */ }
    }
    localStorage.removeItem("wf_batch_snapshot");
    generating.value = false;
    toast(`批量生成失败: ${(e as Error).message}, 已恢复生成前的章节和内容`, "error");
  }
}

// ── 回滚批量(闭源 Fe/Ae) ──
async function rollbackBatch() {
  const ok = window.confirm("回滚到批量生成前的内容? 当前全部章节正文将被覆盖。");
  if (!ok) return;
  try {
    await q(`/research/projects/${store.taskId}/nodes/sections/undo-batch`, { method: "POST" }).catch(() => null);
    await refreshSections();
    toast("已回滚到批量生成前的内容", "success");
  } catch {
    toast("回滚失败", "error");
  }
}

// ── 任务轮询(泵执行; 成功回读 sections) ──
function pollTask(taskId: string, onDone: () => Promise<void>, isBatch = false) {
  stopPoll();
  poll = setInterval(async () => {
    try {
      const t = await getTask(taskId);
      if (!t) return;
      const prog = (t.progress ?? {}) as { stage?: string; current?: number; total?: number };
      genStage.value = prog.stage ?? "";
      genProgress.value = { current: prog.current ?? genProgress.value.current, total: prog.total ?? genProgress.value.total };
      if (t.status === "done" || t.status === "completed") {
        stopPoll();
        await onDone();
        if (!isBatch) generating.value = false;
        await store.saveProject();
      } else if (t.status === "failed" || t.status === "cancelled") {
        stopPoll();
        generating.value = false;
        for (const s of store.sections) if (s.status === "generating") s.status = "pending";
        toast("章节生成失败, 请重试", "error");
      }
    } catch { /* 容忍 */ }
  }, 800);
}
function stopPoll() {
  if (poll) {
    clearInterval(poll);
    poll = null;
  }
}

// ── sections 回读(nodes/sections payload.sections[]) ──
async function refreshSections() {
  if (!store.taskId) return;
  try {
    const node = await getNode(store.taskId, "sections");
    const list = node?.sections;
    if (Array.isArray(list)) {
      const merged = store.sections.map((s) => {
        const fresh = (list as Section[]).find((x) => x.id === s.id);
        if (fresh?.content) {
          return { ...s, content: fresh.content, status: "generated" as const };
        }
        return s;
      });
      // 新出现但本地没有的(后端生成的)
      for (const f of list as Section[]) {
        if (!merged.find((m) => m.id === f.id) && f.content) merged.push({ ...f, status: "generated" as const });
      }
      store.sections = merged;
    }
  } catch { /* 空容忍 */ }
}

// ── 正文编辑(本地预览; 保存到 store) ──
const editing = ref(false);
const editText = ref("");
function startEdit() {
  const sec = activeSection.value;
  if (!sec) return;
  editText.value = sec.content ?? "";
  editing.value = true;
}
function saveEdit() {
  const sec = activeSection.value;
  if (!sec) return;
  sec.content = editText.value;
  sec.status = "generated";
  editing.value = false;
  void store.saveProject();
}

// ── 素材卡(右栏; 绑当前节/全部) ──
const materials = ref<Array<Record<string, unknown>>>([]);
const materialFilter = ref("all");
const filteredMaterials = computed(() => {
  const f = materialFilter.value;
  return materials.value.filter((m) => {
    if (f === "all") return true;
    return m.kind === f;
  });
});
async function loadMaterials() {
  if (!store.taskId) return;
  try {
    const r = await q<{ materials?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>> }>(`/research/materials?projectId=${store.taskId}`);
    materials.value = r.materials ?? r.items ?? [];
  } catch {
    materials.value = [];
  }
}
async function insertMaterialContent(m: Record<string, unknown>) {
  const sec = activeSection.value;
  if (!sec) return;
  const content = String(m.contentMd ?? m.content ?? "");
  sec.content = (sec.content ?? "") + "\n\n" + content;
  await store.saveProject();
  toast("素材已插入到章节尾部", "success");
}

// ── C3 素材生成弹窗(闭源: 类型 select + 生成要求 + 流式结果 → 保存到素材库) ──
const genDlg = ref({ open: false, type: "theory", prompt: "", busy: false, preview: "", err: "" });
const GEN_TYPES = [
  { key: "theory", label: "理论素材" },
  { key: "data", label: "数据素材" },
  { key: "case", label: "案例素材" },
  { key: "method", label: "方法素材" },
  { key: "literature", label: "文献素材" }
];
const GEN_KIND: Record<string, string> = { theory: "theory", data: "data_result", case: "note", method: "note", literature: "citation" };
function openGenDlg() { genDlg.value = { open: true, type: "theory", prompt: "", busy: false, preview: "", err: "" }; }
function closeGenDlg() {
  if (genDlg.value.busy) return;
  genDlg.value.open = false;
}
/** 生成: 同步素材生成端点(POST /research/materials/generate → LLM 落库 count 条) */
async function runMaterialGen() {
  const d = genDlg.value;
  if (!d.prompt.trim()) { toast("请输入生成要求", "warning"); return; }
  const l1 = activeSection.value && activeSection.value.level === 1
    ? activeSection.value
    : activeSection.value
      ? store.sections.find((s) => s.id === activeSection.value!.parentId)
      : null;
  if (!l1) { toast("请先在左侧选择一个章节", "warning"); return; }
  d.busy = true;
  d.err = "";
  d.preview = "";
  try {
    const r = await q<{ materials?: Array<{ id?: string; title?: string; kind?: string }> }>(`/research/materials/generate`, {
      method: "POST",
      body: {
        projectId: store.taskId,
        targetSectionId: l1.id,
        sectionTitle: l1.title,
        count: 3,
        topic: d.prompt,
        prompt: `素材类型: ${GEN_TYPES.find((t) => t.key === d.type)?.label ?? d.type}; 生成要求: ${d.prompt}`
      }
    });
    const list = r.materials ?? [];
    if (!list.length) { d.err = "AI 未能生成素材, 请重试"; d.busy = false; return; }
    d.preview = list.map((m, i) => `${i + 1}. ${m.title ?? "素材"}${m.kind ? `（${m.kind}）` : ""}`).join("\n");
  } catch (e) {
    d.err = String((e as { message?: string }).message ?? e);
  } finally {
    d.busy = false;
  }
}
/** 保存: 素材已在后端落库 → 关闭 + 刷新右栏素材库 */
async function saveGenMaterial() {
  genDlg.value.open = false;
  genDlg.value.preview = "";
  await loadMaterials();
  toast("素材已保存到素材库", "success");
}

// ── C4 字数徽标(闭源 SectionGenerator: 已生成 N 字, 生成中按流式字符数实时) ──
const activeWords = computed(() => {
  const sec = activeSection.value;
  if (!sec?.content) return 0;
  return String(sec.content).replace(/\s/g, "").length;
});
const secWordBadge = computed(() => {
  const words = activeWords.value;
  if (generating.value && generateMode.value === "single") return "生成中…";
  return words ? `已生成 ${words} 字` : "";
});

// ── 进合稿门禁(闭源 je()) ──
async function enterFinalize() {
  if (!l1List.value.length) {
    toast("请先确认章节清单, 再进入合并定稿", "warning");
    return;
  }
  if (pendingCount.value > 0) {
    toast(`还有 ${pendingCount.value} 个一级章节未完成, 全部完成后再进入合并定稿`, "warning");
    return;
  }
  store.phase = 5;
  store.phaseLabel = "合稿定稿";
  await store.saveProject();
  void router.push("/workflow/finalize");
}

watch(
  () => store.sections.map((s) => s.id).join(","),
  () => {
    if (store.phase === 4) void store.saveProject();
  }
);

// ── C2 主控 AI — 结构化分析面板(闭源 WorkspaceView L36269+: 折叠卡片盖中央区) ──
const aiPanelOpen = ref(false);
const aiThinking = ref(false);
const aiStepMsg = ref("");
const aiStep = ref(0); // 0=未开始/1 识别研究变量/2 构建研究框架/3 生成写作指导
const aiStepDetail = ref("");
const aiJobId = ref("");
let aiPoll: ReturnType<typeof setInterval> | null = null;
const ANALYSIS_STEPS: Array<{ no: number; label: string }> = [
  { no: 1, label: "识别研究变量" },
  { no: 2, label: "构建研究框架" },
  { no: 3, label: "生成写作指导" }
];
/** 已完成结构化分析(sections 有 aiSkill/写作指导 或 store 有逻辑流/变量) */
const aiDone = computed(() => {
  if (store.variables.length || store.project.logicFlow) return true;
  if (!store.sections.length) return false;
  return store.sections.filter((s) => s.aiSkill || s.skill_prompt).length >= store.level1Sections.length * 0.6;
});
function aiPanelOpenToggle() {
  if (!store.level1Sections.length) {
    toast("请先确认章节清单, 再开始结构化分析", "warning");
    return;
  }
  aiPanelOpen.value = !aiPanelOpen.value;
}
function closeAiPanel() { aiPanelOpen.value = false; }
function stopAiPoll() {
  if (aiPoll) { clearInterval(aiPoll); aiPoll = null; }
}

/** 开始/重新分析(闭源 ue()=generateSkillsForSections): analyze job 泵 → 变量/框架/写作指导回填 */
async function runStructuredAnalysis() {
  if (!store.taskId) { toast("请先完成信息录入", "warning"); return; }
  if (!store.level1Sections.length) { toast("请先确认章节清单", "warning"); return; }
  if (aiThinking.value) return;
  aiThinking.value = true;
  aiPanelOpen.value = true;
  aiStep.value = 0;
  aiStepMsg.value = "正在分析论文结构...";
  aiStepDetail.value = "";
  try {
    const t = await createTask({
      title: store.input.title || "结构化分析",
      projectId: store.taskId,
      module: "workflow",
      jobKind: "analyze",
      goal: store.input.title || "结构化分析",
      phase: 2,
      phaseLabel: "科研架构"
    });
    aiJobId.value = t.id;
    pollAnalyzeJob(t.id);
  } catch (e) {
    aiThinking.value = false;
    aiStepMsg.value = "";
    toast("结构化分析失败: " + String((e as Error).message ?? e), "error");
  }
}
function pollAnalyzeJob(taskId: string) {
  stopAiPoll();
  aiPoll = setInterval(async () => {
    try {
      const t = await getTask(taskId);
      if (!t) return;
      const prog = (t.progress ?? {}) as { stage?: string; current?: number; total?: number };
      if (prog.stage) {
        if (prog.stage.includes("变量") || prog.stage.includes("因素")) { aiStep.value = 1; aiStepDetail.value = String(prog.stage); }
        else if (prog.stage.includes("框架")) { aiStep.value = 2; aiStepDetail.value = String(prog.stage); }
        else if (prog.stage.includes("指导") || prog.stage.toLowerCase().includes("skill")) { aiStep.value = 3; aiStepDetail.value = String(prog.stage); }
        aiStepMsg.value = String(prog.stage);
      } else {
        aiStep.value = aiStep.value || 1;
        aiStepMsg.value = "正在生成章节写作指导...";
      }
      if (t.status === "done" || t.status === "completed") {
        stopAiPoll();
        aiThinking.value = false;
        aiStep.value = 3;
        aiStepMsg.value = "结构化分析完成";
        aiStepDetail.value = "";
        await finishStructuredAnalysis(t);
      } else if (t.status === "failed" || t.status === "cancelled") {
        stopAiPoll();
        aiThinking.value = false;
        aiStepMsg.value = "分析失败, 请重试";
        toast("结构化分析失败, 请重试", "error");
      }
    } catch { /* 容忍 */ }
  }, 800);
}

/** 分析完成回填(同 SectionsView 语义): 变量/逻辑流 → 逐章 aiSkill 写作指导 → saveProject */
async function finishStructuredAnalysis(t: { result?: unknown }) {
  try {
    const res = (t.result ?? {}) as { structured?: Record<string, unknown>; text?: string };
    const st = (res.structured ?? {}) as Record<string, unknown>;
    const vars = Array.isArray(st.variables) ? st.variables : null;
    if (vars && vars.length) {
      store.variables = vars.map((v) => {
        const it = v as Record<string, unknown>;
        return { name: String(it.name ?? it.var ?? ""), role: String(it.role ?? "控制"), description: it.description ? String(it.description) : undefined, measurement: it.measurement ? String(it.measurement) : undefined };
      });
    }
    if (st.logicFlow) store.project.logicFlow = String(st.logicFlow);
    await store.saveProject();
  } catch { /* 容忍 */ }
  // 逐章写作指导(skill-cards 批量; 失败容忍)
  try {
    const { batchGenerateSkillCards } = await import("@/shared/tasks");
    await batchGenerateSkillCards(store.taskId, store.level1Sections.map((s) => ({ id: s.id, title: s.title, level: 1 })));
  } catch { /* 后端容忍 */ }
  await reloadSkillCards();
  await store.saveProject();
  toast("结构化分析完成, 各章节写作指导已生成", "success");
}
async function reloadSkillCards() {
  try {
    const { listSkillCards } = await import("@/shared/tasks");
    const cards = await listSkillCards(store.taskId);
    const map = new Map<string, Record<string, unknown>>();
    for (const c of cards) {
      const flat = c as Record<string, unknown>;
      map.set(String(flat.section_id ?? flat.id ?? ""), flat);
    }
    let changed = false;
    for (const s of store.sections) {
      const flat = map.get(s.id);
      if (!flat) continue;
      if (!s.aiSkill) { s.aiSkill = {} as Record<string, unknown>; }
      const before = JSON.stringify(s.aiSkill);
      s.aiSkill = {
        type: flat.skill_type ?? (s.aiSkill as Record<string, unknown>).type,
        wordCount: Number(flat.word_count ?? (s.aiSkill as Record<string, unknown>).wordCount ?? 0),
        writingGoal: flat.writing_goal ?? (s.aiSkill as Record<string, unknown>).writingGoal ?? "",
        keyPoints: Array.isArray(flat.key_points) ? flat.key_points : Array.isArray(flat.keyPoints) ? flat.keyPoints : (s.aiSkill as Record<string, unknown>).keyPoints ?? [],
        notes: flat.notes ?? (s.aiSkill as Record<string, unknown>).notes ?? "",
        connection: flat.connection ?? (s.aiSkill as Record<string, unknown>).connection ?? "",
        sectionTitle: flat.section_title ?? flat.sectionTitle ?? "",
        frameworkSource: flat.framework_source ?? (s.aiSkill as Record<string, unknown>).frameworkSource ?? "",
        chapterDraft: flat.chapter_draft ?? (s.aiSkill as Record<string, unknown>).chapterDraft ?? "",
        childSections: Array.isArray(flat.child_sections) ? flat.child_sections : Array.isArray(flat.childSections) ? flat.childSections : (s.aiSkill as Record<string, unknown>).childSections ?? []
      };
      const after = JSON.stringify(s.aiSkill);
      if (before !== after) changed = true;
      s.skill_prompt = String((s.aiSkill as Record<string, unknown>).skill_prompt ?? flat.skill_prompt ?? "");
    }
    if (changed) void store.saveProject();
  } catch { /* 容忍 */ }
}

onMounted(async () => {
  await store.loadProject().catch(() => null);
  await loadMaterials();
  if (store.sections.length) {
    // 默认展开全部一级
    expandedIds.value = new Set(store.level1Sections.map((s) => s.id));
    const first = store.level1Sections[0];
    if (first) activeSecId.value = first.id;
  }
  // 分析中的 job 恢复(活动 analyze 任务 → 面板续显)
  const recent = await (await import("@/shared/tasks")).listTasks({ module: "workflow", limit: 5 }).catch(() => []);
  const active = recent.find((t) => t.jobKind === "analyze" && ["queued", "running"].includes(t.status) && t.projectId === store.taskId);
  if (active) {
    aiJobId.value = active.id;
    aiThinking.value = true;
    aiStepMsg.value = "正在继续上次的结构化分析...";
    aiPanelOpen.value = true;
    pollAnalyzeJob(active.id);
  }
});
onUnmounted(() => { stopPoll(); stopAiPoll(); });
</script>

<template>
  <div class="ws-page-root">
    <PhaseProgressBar />
    <div class="workspace-container wf-layout">
    <!-- 左: 章节导航 -->
    <aside class="left-rail">
      <div class="rail-head">
        <strong>章节导航</strong>
        <span class="rail-count">{{ genCount }}/{{ l1List.length }}</span>
      </div>
      <div class="rail-progress"><div class="rail-progress-fill" :style="{ width: progressPct + '%' }"></div></div>
      <div v-if="!l1List.length" class="rail-empty">暂无章节 — 请先完成信息录入与科研架构</div>
      <div v-else class="nav-list">
        <button class="rail-ai-toggle" :class="{ on: aiPanelOpen }" @click="aiPanelOpenToggle">💡 {{ aiPanelOpen ? "关闭结构化指导" : "结构化指导" }}</button>
        <div v-for="(s, i) in l1List" :key="s.id" class="nav-l1" :class="{ active: activeSecId === s.id }" @click="selectSection(s)">
          <div class="nav-row">
            <button class="nav-toggle" @click.stop="toggleExpand(s.id)">{{ isExpanded(s.id) ? "▼" : "▶" }}</button>
            <span class="nav-num">{{ cnOf(i) }}</span>
            <span class="nav-title">{{ s.title || "未命名章节" }}</span>
            <span class="nav-dot" :class="secStatusDot(s).cls" :title="secStatusDot(s).title"></span>
          </div>
          <div v-if="s.content && s.content.length > 50" class="nav-words">{{ s.content.replace(/\s/g, "").length }} 字</div>
          <div v-if="isExpanded(s.id)" class="nav-children">
            <div
              v-for="c in childrenOf(s.id)"
              :key="c.id"
              class="nav-l2"
              :class="{ active: activeSecId === c.id }"
              @click="selectSection(c)"
            >
              <span class="nav-num2">{{ i + 1 }}.{{ childrenOf(s.id).indexOf(c) + 1 }}</span>
              <span class="nav-title">{{ c.title || "未命名子节" }}</span>
              <span class="nav-dot" :class="secStatusDot(c).cls"></span>
            </div>
          </div>
        </div>
      </div>
      <div class="rail-footer">
        <button class="btn-back-sm" @click="router.push('/workflow/materials')">← 返回素材准备</button>
        <button class="btn-primary-sm" data-assistant-control="workflow_phase4_enter_finalize" @click="enterFinalize">进入合稿 →</button>
      </div>
    </aside>

    <!-- 中: 正文区 -->
    <main class="center-main">
      <!-- C2 主控 AI 面板(闭源: 覆盖中央区; 分析中步骤态/完成态变量+逻辑流+写作指导卡/空闲灯泡态) -->
      <div v-if="aiPanelOpen" class="ai-panel">
        <div class="ai-panel-head">
          <span class="ai-panel-title">主控 AI — 结构化分析</span>
          <div class="ai-panel-actions">
            <button v-if="!aiThinking" class="ai-reanalyze" :disabled="generating" @click="runStructuredAnalysis">重新分析</button>
            <button class="ai-close" @click="closeAiPanel">关闭</button>
          </div>
        </div>
        <div class="ai-panel-body">
          <!-- 分析中: spinner + 3 步进度 -->
          <div v-if="aiThinking" class="ai-thinking">
            <div class="ai-spin-row">
              <span class="ai-spinner"></span>
              <span>{{ aiStepMsg || "正在分析..." }}</span>
            </div>
            <div class="ai-steps">
              <div v-for="stp in ANALYSIS_STEPS" :key="stp.no" class="ai-step" :class="aiStep > stp.no ? 'done' : aiStep === stp.no ? 'current' : 'todo'">
                <span class="ai-step-mark">{{ aiStep > stp.no ? "✓" : aiStep === stp.no ? String(stp.no) : "·" }}</span>
                <span>{{ stp.label }}</span>
                <span v-if="aiStepDetail && aiStep === stp.no" class="ai-step-detail">{{ aiStepDetail }}</span>
              </div>
            </div>
            <div v-if="store.variables.length" class="ai-partial">
              <div class="ai-partial-label">已识别变量（{{ store.variables.length }} 个）</div>
              <div class="ai-partial-chips">
                <span v-for="v in store.variables" :key="v.name" class="var-mini"><i class="var-dot" :style="{ background: roleColor(v.role) }"></i>{{ v.name }}</span>
              </div>
            </div>
          </div>
          <!-- 完成态: 变量胶囊 + 章节逻辑关系 + 各章节写作指导卡 -->
          <div v-else-if="store.variables.length || store.project.logicFlow || aiDone" class="ai-done">
            <div v-if="store.variables.length" class="done-block">
              <div class="done-label">研究变量（{{ store.variables.length }} 个）</div>
              <div class="done-chips">
                <span v-for="v in store.variables" :key="v.name" class="var-pill">{{ v.name }}({{ v.role }})</span>
              </div>
            </div>
            <div v-if="store.project.logicFlow" class="done-block">
              <div class="logic-label">章节逻辑关系</div>
              <p class="logic-text">{{ store.project.logicFlow }}</p>
            </div>
            <div class="done-block">
              <div class="guide-label">各章节写作指导</div>
              <div v-if="store.sections.filter((s) => s.aiSkill).length" class="guide-cards">
                <div v-for="s in store.sections.filter((x) => x.aiSkill)" :key="s.id" class="guide-card">
                  <div class="guide-head">
                    <span class="guide-title">{{ s.title }}</span>
                    <span class="guide-type">{{ (s.aiSkill as Record<string, unknown>).type }}</span>
                  </div>
                  <p class="guide-goal">{{ String((s.aiSkill as Record<string, unknown>).writingGoal ?? "") }}</p>
                  <div v-if="Array.isArray((s.aiSkill as Record<string, unknown>).keyPoints) && ((s.aiSkill as Record<string, unknown>).keyPoints as unknown[]).length" class="guide-points">
                    <div v-for="(kp, ki) in ((s.aiSkill as Record<string, unknown>).keyPoints as unknown[]).slice(0, 5)" :key="ki" class="guide-point">{{ ki + 1 }}. {{ kp }}</div>
                  </div>
                </div>
              </div>
              <p v-else class="guide-empty">点击「重新分析」为各章节生成写作指导</p>
            </div>
          </div>
          <!-- 空闲灯泡态 -->
          <div v-else class="ai-idle">
            <svg class="ai-bulb" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
            <p class="ai-idle-text">尚未进行结构化分析</p>
            <button class="ai-start" :disabled="generating" @click="runStructuredAnalysis">开始分析（变量、框架、写作指导）</button>
          </div>
        </div>
      </div>
      <template v-if="activeSection">
        <div class="sec-head">
          <span class="sec-num-big">{{ cnOf(Math.max(0, activeL1Idx)) }}</span>
          <div class="sec-title-box">
            <h2>{{ activeSection.title }}</h2>
            <div class="sec-chips">
              <span v-for="c in childrenOf(activeSection.id)" :key="c.id" class="chip">{{ c.title }}</span>
            </div>
          </div>
          <div class="sec-actions">
            <span v-if="secWordBadge" class="sec-words">{{ secWordBadge }}</span>
            <button v-if="!editing" class="btn-edit" @click="startEdit">编辑</button>
            <button v-if="editing" class="btn-save" @click="saveEdit">保存修改</button>
            <button class="btn-gen" :disabled="generating" @click="generateSection">
              {{ generating && generateMode === 'single' ? "正在思考…" : secStatusDot(activeSection).title === '已生成' ? "重新思考" : "执行智能体开始思考" }}
            </button>
          </div>
        </div>
        <div class="gen-bar" :class="{ on: generating }">
          <span class="gen-dot" :class="{ pulse: generating }"></span>
          <span>{{ statusText() }}</span>
        </div>
        <!-- 正文 -->
        <div class="editor-area">
          <textarea v-if="editing" v-model="editText" class="content-textarea" placeholder="章节正文…"></textarea>
          <div v-else class="content-view markdown-body">
            <p v-if="!activeSection.content" class="content-empty">
              该章节尚未生成正文 — 点击右上「执行智能体开始思考」生成内容。
            </p>
            <pre v-else class="content-pre">{{ activeSection.content }}</pre>
          </div>
        </div>
      </template>
      <div v-else class="center-empty">
        <p>← 从左侧选择章节开始创作</p>
      </div>
    </main>
    <!-- 右: 素材卡 -->
    <aside class="right-rail">
      <div class="rail-head">
        <strong>素材库</strong>
        <div class="rail-head-right">
          <span class="rail-count">{{ materials.length }}</span>
          <button class="mat-gen-btn" :disabled="generating" @click="openGenDlg">＋ 生成</button>
        </div>
      </div>
      <select v-model="materialFilter" class="mat-filter">
        <option value="all">全部素材</option>
        <option value="theory">理论</option>
        <option value="citation">文献</option>
        <option value="data_result">数据</option>
        <option value="figure">图表</option>
        <option value="file">附件</option>
      </select>
      <div v-if="!filteredMaterials.length" class="rail-empty">
        <p>暂无素材</p>
        <p class="rail-empty-sub">点击上方「生成」按钮创建</p>
      </div>
      <div v-else class="mat-scroll">
        <div v-for="m in filteredMaterials" :key="String(m.id ?? m.title)" class="mat-mini">
          <span class="mat-mini-icon">{{ String(m.kind ?? "file") === "theory" ? "📖" : String(m.kind ?? "") === "citation" ? "📚" : "📎" }}</span>
          <div class="mat-mini-body">
            <strong>{{ String(m.title ?? "未命名素材").slice(0, 30) }}</strong>
            <span class="mat-mini-meta">{{ String(m.kind ?? "") }} · {{ String(m.contentMd ?? m.content ?? "").length }} 字</span>
          </div>
          <button class="mat-mini-insert" title="插入到章节" @click="insertMaterialContent(m)">插入</button>
        </div>
      </div>
      <div class="rail-footer-col">
        <button class="btn-batch" data-assistant-control="workflow_phase4_generate_all" :disabled="generating" @click="generateAll">批量生成全部章节</button>
        <button v-if="generating && generateMode === 'batch'" class="btn-rollback" @click="rollbackBatch">回滚本次批量</button>
      </div>
    </aside>

    <!-- C3 素材生成弹窗(Teleport; 类型 select + 生成要求 + 流式结果 + 保存) -->
    <Teleport to="body">
      <div v-if="genDlg.open" class="modal-mask" @click.self="closeGenDlg">
        <div class="modal-card">
          <h3 class="modal-title">生成素材</h3>
          <div class="modal-body">
            <div class="f-row">
              <label class="f-label">素材类型</label>
              <select v-model="genDlg.type" class="f-input">
                <option v-for="t in GEN_TYPES" :key="t.key" :value="t.key">{{ t.label }}</option>
              </select>
            </div>
            <div class="f-row">
              <label class="f-label">生成要求</label>
              <textarea v-model="genDlg.prompt" rows="3" class="f-textarea" placeholder="描述需要生成的素材内容..."></textarea>
            </div>
            <p v-if="genDlg.err" class="gen-err">⚠ {{ genDlg.err }}</p>
            <div class="gen-actions">
              <button class="gen-run" :disabled="genDlg.busy || !genDlg.prompt.trim()" @click="runMaterialGen">
                {{ genDlg.busy ? "思考中..." : "执行智能体开始思考" }}
              </button>
              <button class="gen-cancel" @click="closeGenDlg">取消</button>
            </div>
            <!-- 流式结果预览 -->
            <div v-if="genDlg.preview" class="gen-result">
              <pre class="gen-result-body">{{ genDlg.preview }}</pre>
              <button class="gen-save" @click="saveGenMaterial">保存到素材库</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
    </div>
  </div>
</template>

<style scoped>
.ws-page-root { height: 100vh; width: 100%; max-width: 100%; display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box; }
.wf-layout { display: flex; gap: 0; flex: 1; min-height: 0; }
.left-rail {
  width: 260px; flex-shrink: 0; border-right: 1px solid #222F44;
  display: flex; flex-direction: column; background: #11192C; overflow-y: auto;
}
.rail-head { display: flex; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #212C45; }
.rail-head strong { font-size: 13.5px; color: #E8EEF7; }
.rail-count { font-size: 11px; color: #7A8AA0; background: #212C45; padding: 2px 8px; border-radius: 9px; }
.rail-progress { height: 3px; background: #212C45; }
.rail-progress-fill { height: 100%; background: #dc2626; transition: width 0.4s; }
.rail-empty { padding: 26px 14px; text-align: center; color: #7A8AA0; font-size: 12px; }
.nav-list { flex: 1; padding: 6px; overflow-y: auto; }
.nav-l1 { border-radius: 7px; padding: 5px 7px; cursor: pointer; }
.nav-l1:hover { background: #1A2333; }
.nav-l1.active { background: #2A1C1C; border-left: 2px solid #dc2626; }
.nav-row { display: flex; align-items: center; gap: 6px; }
.nav-toggle { width: 16px; height: 16px; border: 0; background: none; color: #7A8AA0; font-size: 8px; cursor: pointer; padding: 0; }
.nav-num {
  width: 20px; height: 20px; border-radius: 5px; background: #dc2626; color: #F1F5F9;
  display: grid; place-items: center; font-size: 11px; font-weight: 600; flex-shrink: 0;
}
.nav-title { flex: 1; font-size: 12.5px; color: #DCE6F2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-dot { width: 7px; height: 7px; border-radius: 50%; background: #222F44; flex-shrink: 0; }
.nav-dot.dot-done { background: #5FD0B4; }
.nav-dot.dot-generating { background: #E8B54A; animation: blink 1.2s infinite; }
@keyframes blink { 50% { opacity: 0.3; } }
.nav-words { font-size: 10.5px; color: #7A8AA0; padding-left: 28px; }
.nav-children { padding-left: 22px; }
.nav-l2 { display: flex; align-items: center; gap: 5px; padding: 3px 5px; border-radius: 5px; cursor: pointer; font-size: 12px; }
.nav-l2:hover { background: #212C45; }
.nav-l2.active { background: #2A1C1C; }
.nav-num2 { color: #8B9BB1; font-size: 10.5px; min-width: 28px; }
.rail-footer { padding: 10px; border-top: 1px solid #212C45; display: flex; flex-direction: column; gap: 7px; }
.btn-back-sm { border: 0; background: #1A2333; color: #8B9BB1; padding: 7px; border-radius: 7px; font-size: 12px; cursor: pointer; text-align: left; }
.btn-primary-sm {
  border: 0; background: #1e293b; color: #F1F5F9; padding: 8px; border-radius: 7px;
  font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.center-main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: #11192C; padding: 16px 24px; overflow-y: auto; }
.sec-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.sec-num-big {
  width: 30px; height: 30px; border-radius: 7px; background: #dc2626; color: #F1F5F9;
  display: grid; place-items: center; font-size: 14px; font-weight: 700; flex-shrink: 0; margin-top: 2px;
}
.sec-title-box { flex: 1; min-width: 0; }
.sec-title-box h2 { margin: 0 0 5px; font-size: 17px; color: #E8EEF7; }
.sec-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip {
  font-size: 10.5px; padding: 2px 9px; background: #212C45; color: #8B9BB1; border-radius: 9px;
}
.sec-actions { display: flex; gap: 7px; flex-shrink: 0; }
.btn-edit, .btn-save {
  padding: 6px 12px; border: 1px solid #222F44; border-radius: 7px; background: #11192C;
  color: #8B9BB1; font-size: 12px; cursor: pointer;
}
.btn-gen {
  padding: 6px 14px; border: 0; border-radius: 7px; background: #1e293b;
  color: #F1F5F9; font-size: 12px; cursor: pointer;
}
.btn-gen:disabled { opacity: 0.5; cursor: not-allowed; }
.gen-bar {
  display: flex; align-items: center; gap: 7px; padding: 6px 11px; margin-bottom: 10px;
  background: #1A2333; border-radius: 7px; font-size: 12px; color: #7A8AA0;
}
.gen-bar.on { background: #1E2A48; color: #1d4ed8; }
.gen-dot { width: 8px; height: 8px; border-radius: 50%; background: #46587A; }
.gen-dot.pulse { background: #2563eb; animation: blink 1s infinite; }
.editor-area { flex: 1; min-height: 0; display: flex; }
.content-textarea {
  flex: 1; resize: none; border: 1px solid #222F44; border-radius: 10px; padding: 14px;
  font-size: 14px; line-height: 1.9; font-family: inherit;
}
.content-view { flex: 1; overflow-y: auto; }
.content-empty { padding: 60px 20px; text-align: center; color: #7A8AA0; font-size: 13px; }
.content-pre {
  margin: 0; padding: 8px 4px; font-family: inherit; font-size: 14px; line-height: 1.9;
  color: #E8EEF7; white-space: pre-wrap; word-break: break-word;
}
.center-empty { display: grid; place-items: center; height: 100%; color: #7A8AA0; font-size: 14px; }
.right-rail {
  width: 240px; flex-shrink: 0; border-left: 1px solid #222F44;
  display: flex; flex-direction: column; background: #141E33;
}
.mat-filter { margin: 8px 10px; padding: 5px 8px; border: 1px solid #222F44; border-radius: 7px; font-size: 12px; background: #11192C; }
.mat-scroll { flex: 1; overflow-y: auto; padding: 0 8px; display: flex; flex-direction: column; gap: 6px; }
.mat-mini {
  display: flex; align-items: center; gap: 7px; padding: 8px;
  background: #11192C; border: 1px solid #212C45; border-radius: 9px;
}
.mat-mini:hover { border-color: #B06A6A; box-shadow: 0 2px 8px rgba(220, 38, 38, 0.05); }
.mat-mini-icon { font-size: 16px; }
.mat-mini-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.mat-mini-body strong { font-size: 11.5px; color: #E8EEF7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mat-mini-meta { font-size: 10px; color: #7A8AA0; }
.mat-mini-insert {
  border: 0; background: #212C45; color: #2563eb; font-size: 10.5px;
  padding: 3px 7px; border-radius: 5px; cursor: pointer;
}
.rail-footer-col { padding: 9px; border-top: 1px solid #222F44; display: flex; flex-direction: column; gap: 6px; }
.btn-batch {
  padding: 8px; border: 0; border-radius: 7px; background: #1e293b; color: #F1F5F9;
  font-size: 12px; font-weight: 600; cursor: pointer;
}
.btn-batch:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-rollback {
  padding: 6px; border: 1px solid #3A2323; border-radius: 7px; background: #2A1C1C;
  color: #dc2626; font-size: 11.5px; cursor: pointer;
}

/* C2 主控 AI — 结构化分析面板 */
.rail-ai-toggle {
  width: 100%; margin: 0 0 6px; padding: 7px 10px; border: 1px solid #222F44;
  border-radius: 8px; background: #11192C; color: #8B9BB1; font-size: 12px;
  font-weight: 500; cursor: pointer; text-align: left;
}
.rail-ai-toggle:hover { border-color: #B06A6A; }
.rail-ai-toggle.on { background: #2A1C1C; border-color: #B06A6A; color: #dc2626; }
.ai-panel {
  position: absolute; inset: 0; z-index: 20; background: #1A2333;
  display: flex; flex-direction: column; overflow: hidden;
}
.ai-panel-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 13px 18px; border-bottom: 1px solid #222F44; background: #11192C;
}
.ai-panel-title { font-size: 14px; font-weight: 600; color: #DCE6F2; }
.ai-panel-actions { display: flex; align-items: center; gap: 12px; }
.ai-reanalyze { font-size: 12px; color: #DCE6F2; border: 0; background: #212C45; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
.ai-reanalyze:disabled { opacity: 0.5; cursor: not-allowed; }
.ai-close { font-size: 12px; color: #8B9BB1; border: 0; background: none; cursor: pointer; }
.ai-close:hover { color: #8B9BB1; }
.ai-panel-body { flex: 1; overflow-y: auto; padding: 18px 22px; }
.ai-spin-row { display: flex; align-items: center; gap: 10px; font-size: 13px; color: #DCE6F2; margin-bottom: 14px; }
.ai-spinner {
  width: 20px; height: 20px; border: 2.5px solid #94a3b8; border-top-color: transparent;
  border-radius: 50%; animation: aispin 0.8s linear infinite; flex-shrink: 0;
}
@keyframes aispin { to { transform: rotate(360deg); } }
.ai-steps { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.ai-step {
  display: flex; align-items: center; gap: 8px; font-size: 12.5px;
  padding: 9px 13px; border-radius: 9px; border: 1px solid;
}
.ai-step.done { background: #14281F; border-color: #2E5C46; color: #15803d; }
.ai-step.current { background: #2A1C1C; border-color: #3A2323; color: #E06B6B; }
.ai-step.todo { background: #1A2333; border-color: #222F44; color: #8B9BB1; }
.ai-step-mark {
  width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center;
  font-size: 11px; background: currentColor; color: #F1F5F9; flex-shrink: 0;
}
.ai-step.done .ai-step-mark { background: #16a34a; }
.ai-step.current .ai-step-mark { background: #dc2626; }
.ai-step.todo .ai-step-mark { background: transparent; color: inherit; border: 1px solid #46587A; }
.ai-step-detail { margin-left: auto; font-size: 11px; opacity: 0.8; }
.ai-partial { border-top: 1px dashed #222F44; padding-top: 12px; }
.ai-partial-label { font-size: 12px; font-weight: 600; color: #DCE6F2; margin-bottom: 8px; }
.ai-partial-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.var-mini { font-size: 12px; color: #2563eb; display: inline-flex; align-items: center; gap: 5px; }
.var-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.ai-done { display: flex; flex-direction: column; gap: 16px; }
.done-block { display: flex; flex-direction: column; gap: 6px; }
.done-label { font-size: 13px; font-weight: 600; color: #DCE6F2; }
.done-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.var-pill { font-size: 12px; padding: 3px 10px; background: #1C3A2C; color: #15803d; border-radius: 8px; }
.logic-label { font-size: 12.5px; font-weight: 600; color: #E8B54A; }
.logic-text { margin: 0; font-size: 12.5px; color: #DCE6F2; line-height: 1.7; }
.guide-label { font-size: 13px; font-weight: 600; color: #8B9BB1; }
.guide-cards { display: flex; flex-direction: column; gap: 9px; }
.guide-card { padding: 12px 14px; background: #11192C; border: 1px solid #222F44; border-radius: 10px; }
.guide-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; gap: 10px; }
.guide-title { font-size: 13px; font-weight: 600; color: #E8EEF7; }
.guide-type {
  font-size: 10px; color: #dc2626; background: #2A1C1C; padding: 1.5px 8px; border-radius: 8px; flex-shrink: 0;
}
.guide-goal { margin: 0; font-size: 12px; color: #8B9BB1; line-height: 1.6; }
.guide-points { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; }
.guide-point { font-size: 11px; color: #8B9BB1; }
.guide-empty { font-size: 12px; color: #7A8AA0; }
.ai-idle { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; height: 100%; min-height: 260px; }
.ai-bulb { width: 48px; height: 48px; color: #222F44; margin-bottom: 8px; }
.ai-idle-text { font-size: 14px; color: #8B9BB1; margin-bottom: 14px; }
.ai-start {
  padding: 9px 18px; border: 0; border-radius: 8px; background: #dc2626; color: #F1F5F9;
  font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.ai-start:disabled { background: #46587A; cursor: not-allowed; }
.center-main { position: relative; }

/* C3 素材生成弹窗 + C4 字数徽标 */
.rail-head-right { display: flex; align-items: center; gap: 7px; }
.mat-gen-btn {
  border: 1px solid #9bb8d8; background: #11192C; color: #759FD7;
  font-size: 11px; padding: 2px 9px; border-radius: 7px; cursor: pointer;
}
.mat-gen-btn:hover { background: #161F33; }
.mat-gen-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.rail-empty-sub { font-size: 11px; color: #46587A; margin: 3px 0 0; }
.modal-mask { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, 0.2); display: flex; align-items: center; justify-content: center; }
.modal-card { width: 480px; max-width: 94vw; background: #11192C; border-radius: 14px; padding: 18px 22px; box-shadow: 0 20px 60px rgba(15, 23, 42, 0.25); }
.modal-title { margin: 0 0 14px; font-size: 17px; font-weight: 700; color: #E8EEF7; }
.modal-body { display: flex; flex-direction: column; gap: 13px; }
.f-row { display: flex; flex-direction: column; gap: 5px; }
.f-label { font-size: 13px; font-weight: 600; color: #DCE6F2; }
.f-input { padding: 8px 12px; border: 1px solid #46587A; border-radius: 8px; font-size: 13px; }
.f-textarea { padding: 8px 12px; border: 1px solid #46587A; border-radius: 8px; font-size: 13px; font-family: inherit; resize: vertical; }
.gen-err { margin: 0; font-size: 12px; color: #dc2626; }
.gen-actions { display: flex; gap: 10px; }
.gen-run {
  flex: 1; padding: 9px 0; border: 0; border-radius: 8px; background: #dc2626;
  color: #F1F5F9; font-size: 13px; font-weight: 600; cursor: pointer;
}
.gen-run:disabled { background: #46587A; cursor: not-allowed; }
.gen-cancel { padding: 9px 18px; border: 1px solid #46587A; border-radius: 8px; background: #11192C; color: #8B9BB1; font-size: 13px; cursor: pointer; }
.gen-result { border-top: 1px solid #212C45; padding-top: 12px; display: flex; flex-direction: column; gap: 9px; }
.gen-result-body {
  margin: 0; padding: 11px 13px; background: #1A2333; border: 1px solid #222F44; border-radius: 8px;
  font-family: inherit; font-size: 12.5px; color: #DCE6F2; line-height: 1.7;
  white-space: pre-wrap; max-height: 200px; overflow-y: auto;
}
.gen-save {
  width: 100%; padding: 8px 0; border: 0; border-radius: 8px; background: #16a34a;
  color: #F1F5F9; font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.sec-words {
  font-size: 11px; color: #5FD0B4; background: #14281F; border: 1px solid #2E5C46;
  padding: 4px 10px; border-radius: 8px; align-self: center;
}
</style>
