/**
 * workflow project store — 还原自闭源 project store 语义(共享 index-xpWAkSSw.js L15595+)
 * sections/variables/input{title,outline,...}/project{logicFlow}/materials/版本链/phase
 * 我方后端: research_projects + research_nodes(sections/materials 等节点) + workbench snapshot
 * 视图间衔接: 本 store 是 5 阶段唯一真源(闭源同一 store 语义)
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { listTasks, getNode, putNode, saveWorkbench, getWorkbench } from "@/shared/tasks";
import { K } from "@/shared/constants";

export interface Section {
  id: string;
  title: string;
  level: number; // 1 | 2
  parentId?: string | null;
  order?: number;
  content?: string;
  status?: string; // pending/generating/generated
  aiSkill?: Record<string, unknown> | null;
  skill_prompt?: string;
  wordCount?: number;
  requirements?: string;
  summary?: string;
}

export interface WfInput {
  title: string;
  outline: string;
  totalWordCount: number;
  researchMethod: string; // qualitative/quantitative/mixed
  requirements: string;
  sampleFiles: Array<{ name: string; size: number; content: string }>;
  clarifyAnswers: Record<string, string>;
}

export const useWorkflowStore = defineStore("workflow", () => {
  // ── 基础 ──
  const taskId = ref(""); // 当前工作流任务(projectId)
  const phase = ref(0); // 1-5
  const phaseLabel = ref("");
  // ── Phase1 输入 ──
  const input = ref<WfInput>({
    title: "", outline: "", totalWordCount: 10000, researchMethod: "",
    requirements: "", sampleFiles: [], clarifyAnswers: {}
  });
  // ── Phase2 科研架构 ──
  const sections = ref<Section[]>([]);
  const variables = ref<Array<{ name: string; role: string; description?: string; measurement?: string }>>([]);
  const hypotheses = ref<string[]>([]);
  const stepAnalysisTexts = ref<Record<string, string>>({ 1: "", 2: "", 3: "" });
  const skillThinking = ref(false);
  const skillStep = ref(0);
  const skillError = ref<Record<string, unknown> | null>(null);
  const project = ref<{ title: string; logicFlow?: string }>({ title: "" });
  // ── 版本链(闭源 getCurrent 校验 stale) ──
  const inputVersionId = ref("");
  const phase2VersionId = ref("");
  const phase3VersionId = ref("");
  const phase4VersionId = ref("");
  const phase5VersionId = ref("");
  const phase2Stale = ref(false);
  const phase3Stale = ref(false);
  const phase4Stale = ref(false);
  const phase5Stale = ref(false);
  // ── Phase3 素材 ──
  const materials = ref<Array<Record<string, unknown>>>([]);
  const materialAllocation = ref<Record<string, string[]>>({});
  const materialReviewReport = ref("");
  const statisticsFileId = ref("");
  // ── Phase4/5 正文/合稿 ──
  const sectionsOrder = ref<string[]>([]);
  const activeSectionId = ref("");
  const textFlow = ref<{ status: string }>({ status: "" });
  const mergedFullText = ref("");
  const mergedTitle = ref("");
  const mergedAbstract = ref("");
  const mergedKeywords = ref("");
  const mergedReferences = ref("");
  const mergeGenerated = ref(false);
  const isFinalized = ref(false);
  const reviewResult = ref<Record<string, unknown> | null>(null);
  const exportStatus = ref("");
  const exportedAt = ref("");
  const exportFormat = ref("md");
  const projectStateVersion = ref(0);

  // ── 计算 ──
  const title = computed(() => input.value.title || project.value.title);
  const level1Sections = computed(() => sections.value.filter((s) => s.level === 1));
  const activeSection = computed(() => sections.value.find((s) => s.id === activeSectionId.value) ?? null);
  const totalWordCount = computed(() => Number(input.value.totalWordCount) || 0);

  // ── 节点持久化(闭源 loadNode/saveCurrentNode 语义) ──
  async function ensureTask(title: string): Promise<string> {
    if (taskId.value) return taskId.value;
    // 1) localStorage 项目指针(lastTask_workflow 语义 → 存 projectId)
    const saved = localStorage.getItem("lastTask_workflow");
    if (saved) {
      taskId.value = saved;
      return saved;
    }
    const { listTasks: list, createTask } = await import("@/shared/tasks");
    const hits = await list({ module: "workflow", limit: 10 }).catch(() => []);
    // 2) 复用: 进行中任务带 projectId(后端任务无 title 列 → 取 goal 兜底标题匹配)
    const hit = hits.find(
      (t) => ["in-progress", "queued", "running"].includes(t.status) && (t.title ?? t.goal) === title && t.projectId
    );
    if (hit?.projectId) {
      taskId.value = hit.projectId;
      persistPointer(hit.projectId);
      return hit.projectId;
    }
    // 3) 建全新项目
    const created = await createTask({ title: title || "未命名科研任务", module: "workflow", status: "in-progress", phase: 1, phaseLabel: "信息录入" });
    const pid = created.projectId ?? "";
    taskId.value = pid;
    persistPointer(pid);
    return pid;
  }
  function persistPointer(pid: string): void {
    localStorage.setItem("lastTask_workflow", pid);
  }
  function clearPointer(): void {
    localStorage.removeItem("lastTask_workflow");
  }

  async function saveProject(): Promise<void> {
    if (!taskId.value) return;
    try {
      await saveWorkbench(taskId.value, {
        phase: phase.value,
        phaseLabel: phaseLabel.value,
        input: input.value,
        sections: sections.value,
        variables: variables.value,
        hypotheses: hypotheses.value,
        project: project.value,
        ...(inputVersionId.value ? { inputVersionId: inputVersionId.value } : {}),
        ...(phase2VersionId.value ? { phase2VersionId: phase2VersionId.value } : {}),
        ...(phase3VersionId.value ? { phase3VersionId: phase3VersionId.value } : {}),
        ...(phase4VersionId.value ? { phase4VersionId: phase4VersionId.value } : {}),
        ...(phase5VersionId.value ? { phase5VersionId: phase5VersionId.value } : {}),
        phase2Stale: phase2Stale.value,
        phase3Stale: phase3Stale.value,
        phase4Stale: phase4Stale.value,
        phase5Stale: phase5Stale.value,
        materialAllocation: materialAllocation.value,
        materialReviewReport: materialReviewReport.value,
        mergedFullText: mergedFullText.value,
        mergedTitle: mergedTitle.value,
        mergedAbstract: mergedAbstract.value,
        mergedKeywords: mergedKeywords.value,
        mergedReferences: mergedReferences.value,
        mergeGenerated: mergeGenerated.value,
        isFinalized: isFinalized.value,
        reviewResult: reviewResult.value,
        exportStatus: exportStatus.value,
        exportedAt: exportedAt.value,
        exportFormat: exportFormat.value,
        textFlow: textFlow.value,
        stateVersion: projectStateVersion.value
      });
    } catch { /* 409/锁容忍 */ }
  }

  async function loadProject(): Promise<void> {
    // 只恢复已有项目(绝不创建 — 创建发生在用户提交时)
    const saved = localStorage.getItem("lastTask_workflow");
    if (saved) {
      taskId.value = saved;
    } else {
      const { listTasks: list } = await import("@/shared/tasks");
      const hits = await list({ module: "workflow", limit: 10 }).catch(() => []);
      const hit = hits.find((t) => ["in-progress", "queued", "running"].includes(t.status) && t.projectId);
      if (hit?.projectId) {
        taskId.value = hit.projectId;
        localStorage.setItem("lastTask_workflow", hit.projectId);
      }
    }
    if (!taskId.value) return;
    try {
      const snap = await getWorkbench(taskId.value);
      if (!snap || !Object.keys(snap).length) return;
      if (typeof snap.phase === "number") phase.value = snap.phase;
      if (snap.phaseLabel) phaseLabel.value = String(snap.phaseLabel);
      if (snap.input) input.value = { ...input.value, ...(snap.input as WfInput) };
      if (Array.isArray(snap.sections)) sections.value = snap.sections as Section[];
      if (Array.isArray(snap.variables)) variables.value = snap.variables as typeof variables.value;
      if (Array.isArray(snap.hypotheses)) hypotheses.value = snap.hypotheses as string[];
      if (snap.project) project.value = { ...project.value, ...(snap.project as Record<string, string>) };
      if (snap.inputVersionId) inputVersionId.value = String(snap.inputVersionId);
      if (snap.phase2VersionId) phase2VersionId.value = String(snap.phase2VersionId);
      if (snap.phase3VersionId) phase3VersionId.value = String(snap.phase3VersionId);
      if (snap.phase4VersionId) phase4VersionId.value = String(snap.phase4VersionId);
      if (snap.phase5VersionId) phase5VersionId.value = String(snap.phase5VersionId);
      if (typeof snap.phase2Stale === "boolean") phase2Stale.value = snap.phase2Stale;
      if (typeof snap.phase3Stale === "boolean") phase3Stale.value = snap.phase3Stale;
      if (typeof snap.phase4Stale === "boolean") phase4Stale.value = snap.phase4Stale;
      if (typeof snap.phase5Stale === "boolean") phase5Stale.value = snap.phase5Stale;
      if (snap.materialAllocation) materialAllocation.value = snap.materialAllocation as Record<string, string[]>;
      if (snap.materialReviewReport) materialReviewReport.value = String(snap.materialReviewReport);
      if (snap.mergedFullText) mergedFullText.value = String(snap.mergedFullText);
      if (snap.mergedTitle) mergedTitle.value = String(snap.mergedTitle);
      if (snap.mergedAbstract) mergedAbstract.value = String(snap.mergedAbstract);
      if (snap.mergedKeywords) mergedKeywords.value = String(snap.mergedKeywords);
      if (snap.mergedReferences) mergedReferences.value = String(snap.mergedReferences);
      if (typeof snap.mergeGenerated === "boolean") mergeGenerated.value = snap.mergeGenerated;
      if (typeof snap.isFinalized === "boolean") isFinalized.value = snap.isFinalized;
      if (snap.reviewResult) reviewResult.value = snap.reviewResult as Record<string, unknown>;
      if (snap.exportStatus) exportStatus.value = String(snap.exportStatus);
      if (snap.exportFormat) exportFormat.value = String(snap.exportFormat);
      if (snap.exportedAt) exportedAt.value = String(snap.exportedAt);
    } catch { /* 无快照容忍 */ }
  }

  async function loadMaterials(): Promise<void> {
    if (!taskId.value) return;
    try {
      const node = await getNode(taskId.value, "materials");
      const list = node?.materials ?? node?.items ?? [];
      if (Array.isArray(list)) materials.value = list as Array<Record<string, unknown>>;
    } catch { /* 空容忍 */ }
  }

  async function saveMaterials(): Promise<void> {
    if (!taskId.value) return;
    await putNode(taskId.value, "materials", { materials: materials.value }).catch(() => null);
  }

  function goto(ph: number): void {
    phase.value = ph;
    phaseLabel.value = ph === 1 ? "信息录入" : ph === 2 ? "科研架构" : ph === 3 ? "素材准备" : ph === 4 ? "文本创作" : "合稿定稿";
    void saveProject();
  }

  return {
    taskId, phase, phaseLabel, input, sections, variables, hypotheses, stepAnalysisTexts,
    skillThinking, skillStep, skillError, project,
    inputVersionId, phase2VersionId, phase3VersionId, phase4VersionId, phase5VersionId,
    phase2Stale, phase3Stale, phase4Stale, phase5Stale,
    materials, materialAllocation, materialReviewReport, statisticsFileId,
    sectionsOrder, activeSectionId, textFlow,
    mergedFullText, mergedTitle, mergedAbstract, mergedKeywords, mergedReferences,
    mergeGenerated, isFinalized, reviewResult, exportStatus, exportFormat, exportedAt,
    title, level1Sections, activeSection, totalWordCount,
    ensureTask, saveProject, loadProject, loadMaterials, saveMaterials, goto
  };
});
