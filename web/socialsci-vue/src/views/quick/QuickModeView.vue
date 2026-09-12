<script setup lang="ts">
/**
 * QuickModeView — 还原自闭源 QuickModeView-DJU6Ms4b.js(L14304-18019, data-v-1606ef93) 主视图
 * 左侧对话 + 右侧画布; 5 阶段节点注册表 + 启动自动管线(建任务→publishPhase1→save→run→轮询对账)
 * 后端映射: 项目=research project; DAG 图存 nodes/quick_graph; job 对账走 research_tasks
 */
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import AgentFlowCanvas from "./AgentFlowCanvas.vue";
import type { BizNode } from "./AgentFlowCanvas.vue";
import { ensureModuleTask, getNode, putNode, createTask, getTask, getWorkbench } from "@/shared/tasks";
import { q } from "@/shared/api";
import { toast } from "@/shared/ui";
import { useWorkflowStore } from "@/views/workflow/stores/workflow";

// ── 节点注册表(闭源 phrase1-5 + 模块, 状态 8 值) ──
const STATE_LABEL: Record<string, string> = {
  draft: "待执行", queued: "排队中", running: "执行中", paused: "已暂停",
  completed: "已完成", failed: "执行失败", cancelled: "已取消", blocked: "已阻塞"
};

function makeNodes(): BizNode[] {
  return [
    { id: "phrase1", title: "信息录入", module: "STANDARD WORKFLOW", index: "01", state: "draft", stateLabel: "待执行", input: "研究意图", output: "研究任务", systemStart: true, hint: "请先在左侧对话中描述研究主题与目标" },
    { id: "phrase2", title: "科研架构", module: "STANDARD WORKFLOW", index: "02", state: "draft", stateLabel: "待执行", input: "研究任务", output: "章节结构" },
    { id: "phrase3", title: "素材准备", module: "STANDARD WORKFLOW", index: "03", state: "draft", stateLabel: "待执行", input: "章节结构", output: "研究素材" },
    { id: "phrase4", title: "文本创作", module: "STANDARD WORKFLOW", index: "04", state: "draft", stateLabel: "待执行", input: "章节+素材", output: "章节正文" },
    { id: "phrase5", title: "合稿定稿", module: "STANDARD WORKFLOW", index: "05", state: "draft", stateLabel: "待执行", input: "正文", output: "最终稿件" }
  ];
}

// ── 可选科研模块(闭源右键菜单「选择要加入的模块」; type=module → standalone 下排) ──
const MODULE_DEFS = [
  { id: "m_statistics", menuLabel: "统计分析", module: "RESEARCH MODULE", title: "统计分析", input: "数据文件", output: "实证结果" },
  { id: "m_viz", menuLabel: "科研绘图", module: "RESEARCH MODULE", title: "科研绘图", input: "数据+结果", output: "图表产物" },
  { id: "m_review", menuLabel: "科研审查", module: "RESEARCH MODULE", title: "科研审查", input: "论文全文", output: "审查报告" },
  { id: "m_editor", menuLabel: "学术编辑", module: "RESEARCH MODULE", title: "学术文本编辑", input: "草稿", output: "成稿" }
];

// ── 消息模型(闭源 7 kinds: text/question(双态)/plan/progress/node-update/artifact) ──
interface ChatMsg {
  id: number;
  role: "user" | "agent";
  kind: "text" | "question" | "plan" | "progress" | "node-update" | "artifact";
  time: string;
  text?: string;
  // question 卡
  question?: string;
  target?: string;
  understanding?: string;
  missingInputs?: string[];
  options?: Array<{ label: string; prompt: string }>;
  selectedOption?: string;
  optionSubmitted?: boolean;
  // plan 卡
  items?: Array<{ label: string; module?: string; state?: "todo" | "active" | "done" }>;
  // progress 卡
  module?: string;
  progress?: number;
  // node-update 卡
  nodeId?: string;
  title?: string;
  statusLabel?: string;
  detailLabel?: string;
  detail?: string;
  artifactCount?: number;
  artifactLabel?: string;
  preview?: string;
  // artifact 卡
  icon?: string;
}
let msgSeq = 0;
function mkMsg(partial: Partial<ChatMsg> & { role: "user" | "agent" }): ChatMsg {
  const now = new Date();
  return {
    id: ++msgSeq,
    kind: "text",
    time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    ...partial
  } as ChatMsg;
}
function nowHM(): string {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
}

const nodes = ref<BizNode[]>(makeNodes());
const userEdges = ref<Array<{ id: string; source: string; target: string }>>([]);
const runState = ref<"draft" | "running" | "paused" | "completed" | "failed" | "cancelled">("draft");
const jobId = ref("");
const messages = ref<ChatMsg[]>([
  mkMsg({ role: "agent", kind: "text", text: "新任务已创建。直接描述研究主题、希望产出和已有材料即可; 缺少的信息我会集中补齐, 确认后自动启动标准工作流。" })
]);
const input = ref("");
const sending = ref(false);
const chatScroll = ref<HTMLElement | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;
let workflowStore: ReturnType<typeof useWorkflowStore> | null = null;

// ── 选中节点详情 + 右侧工作面板(闭源 workspace-panel) ──
const selectedNode = ref<BizNode | null>(null);
function onNodeSelected(n: BizNode) {
  selectedNode.value = n;
}
// 表单编辑态(phrase1): 主题/目标与 intakeDraft 互通; lockedNow = 运行中锁定
const panelTopic = ref("");
const panelGoal = ref("");
const lockedNow = computed(() => runState.value === "running");
watch(selectedNode, (n) => {
  if (n?.id === "phrase1") {
    panelTopic.value = intakeDraft.value.topic || String(workflowStore?.input?.title ?? "") || "";
    panelGoal.value = summarizeIntake() || "";
  }
});
// 正文/终稿预览(phrase4/5): 从后端 sections 节点 / merged 全文动态回读
const manuscriptTitle = ref("最终稿件");
const manuscriptBody = ref("");
const manuscriptWords = ref(0);
const manuscriptLoading = ref(false);
const manuscriptModal = ref(false);
async function refreshManuscript() {
  if (!selectedNode.value || !workflowStore?.taskId) return;
  const pid = workflowStore.taskId;
  manuscriptLoading.value = true;
  try {
    if (selectedNode.value.id === "phrase4") {
      const secNode = await getNode(pid, "sections").catch(() => null);
      const secs = (secNode?.sections ?? []) as Array<{ title?: string; content?: string }>;
      const done = secs.filter((s) => String(s.content ?? "").replace(/\s/g, "").length > 30);
      manuscriptTitle.value = "章节正文预览";
      manuscriptBody.value = done.map((s) => `# ${s.title ?? ""}\n\n${s.content ?? ""}`).join("\n\n");
      manuscriptWords.value = done.reduce((a, s) => a + String(s.content ?? "").replace(/\s/g, "").length, 0);
    } else {
      const wb = (await getWorkbench(pid).catch(() => ({}))) as Record<string, unknown>;
      const full = String(wb.mergedFullText ?? wb.merged_fulltext ?? "");
      manuscriptTitle.value = String(wb.mergedTitle ?? wb.merged_title ?? "最终稿件");
      manuscriptBody.value = full;
      manuscriptWords.value = full.replace(/\s/g, "").length;
    }
  } catch { /* 容忍 */ } finally {
    manuscriptLoading.value = false;
  }
}
watch(selectedNode, (n) => {
  if (n && (n.id === "phrase4" || n.id === "phrase5")) void refreshManuscript();
});
function openManuscriptModal() {
  if (manuscriptBody.value) manuscriptModal.value = true;
}
function exportManuscript() {
  // 简单导出: .md 文本(闭源 lu() 为 Word docx; md 降级保可用)
  const blob = new Blob([`# ${manuscriptTitle.value}\n\n${manuscriptBody.value}`], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${String(manuscriptTitle.value || "稿件").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}
/** phrase1「让 Agent 检查」: 把未齐字段问题写入对话输入框(闭源 Qr 语义) */
function agentCheckPhrase1() {
  const missing: string[] = [];
  if (!panelTopic.value.trim()) missing.push("研究主题");
  if (!panelGoal.value.trim()) missing.push("研究目标");
  if (!missing.length) {
    pushMsg({ role: "agent", text: "主题与目标已齐备, 可回复「开始执行」或点击下方「保存并进入 Phrase 2」启动标准工作流。" });
    return;
  }
  input.value = `请补充${missing.join("、")}：`;
  setTimeout(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea");
    ta?.focus();
  }, 60);
}
/** phrase1「保存并进入 Phrase 2」(闭源 uu 语义): 表单写回 intakeDraft → 启动管线 */
async function saveAndEnterPhrase2() {
  if (runState.value === "running") return;
  const topic = panelTopic.value.trim();
  if (!topic) {
    pushMsg({ role: "agent", kind: "question", question: "请先填写研究主题", missingInputs: ["研究主题"], understanding: summarizeIntake() });
    return;
  }
  intakeDraft.value = { ...intakeDraft.value, topic };
  // 目标正文尝试提取 对象/方法/边界(复用规则)
  const ext = extractIntent(panelGoal.value + " " + topic);
  intakeDraft.value = { ...intakeDraft.value, object: intakeDraft.value.object || ext.object, method: intakeDraft.value.method || ext.method, boundary: intakeDraft.value.boundary || ext.boundary };
  // 未开始 → 走完整启动; 已启动(暂停中) → 仅存草稿提示
  if (runState.value === "draft" || runState.value === "paused") {
    if (!jobId.value) {
      pushMsg({ role: "user", text: "保存并进入 Phrase 2" });
      await startExecution();
    } else {
      pushMsg({ role: "agent", text: "主题已更新, 任务运行中/暂停, 重新开始将新建任务。" });
    }
  }
}

// ── 右键菜单(闭源: pane 空白 → 加模块/新建; node → 详情/删除) ──
const ctxMenu = ref<{ x: number; y: number; nodeId?: string; nodeTitle?: string; canDelete?: boolean } | null>(null);
function onPaneContextMenu(p: { event: MouseEvent; position: { x: number; y: number } }) {
  if (runState.value === "running") return;
  ctxMenu.value = { x: p.position.x, y: p.position.y };
}
function onNodeContextMenu(p: { event: MouseEvent; position: { x: number; y: number }; node: BizNode }) {
  if (runState.value === "running") return;
  ctxMenu.value = {
    x: p.position.x,
    y: p.position.y,
    nodeId: p.node.id,
    nodeTitle: p.node.title ?? "节点",
    canDelete: !!p.node.standalone && !p.node.systemStart
  };
}
function closeCtxMenu() { ctxMenu.value = null; }
/** 加模块(standalone 节点; 已存在则忽略) */
function addModuleNode(def: { id: string; menuLabel: string; module: string; title: string; input: string; output: string }) {
  if (nodes.value.some((n) => n.id === def.id)) { toast("该模块已在画板中", "info"); closeCtxMenu(); return; }
  nodes.value = [...nodes.value, {
    id: def.id, title: def.title, module: def.module, index: "M",
    state: "draft", stateLabel: "待执行", input: def.input, output: def.output,
    standalone: true, hint: "右键可删除此模块"
  }];
  void saveGraph();
  closeCtxMenu();
}
/** 删除 standalone 模块节点 */
function removeModuleNode(id: string) {
  if (runState.value === "running") return;
  nodes.value = nodes.value.filter((n) => n.id !== id);
  userEdges.value = userEdges.value.filter((e) => e.source !== id && e.target !== id);
  if (selectedNode.value?.id === id) selectedNode.value = null;
  void saveGraph();
  closeCtxMenu();
  toast("模块已从画板移除", "success");
}
/** 菜单节点详情 → 打开抽屉 */
function ctxViewDetail() {
  const n = nodes.value.find((x) => x.id === ctxMenu.value?.nodeId);
  if (n) selectedNode.value = n;
  closeCtxMenu();
}
/** 新建空白任务(重置为仅 5 主节点草稿) */
function newBlankCanvas() {
  nodes.value = makeNodes();
  userEdges.value = [];
  runState.value = "draft";
  jobId.value = "";
  void saveGraph();
  closeCtxMenu();
  toast("已新建空白画布(标准工作流)", "success");
}
function onGraphChanged(payload: { edges: Array<{ id: string; source: string; target: string }> }) {
  userEdges.value = payload.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
  void saveGraph();
}
let graphSaving = false;
let graphDirty = false;
async function saveGraph() {
  try {
    if (!workflowStore?.taskId) return;
    if (graphSaving) { graphDirty = true; return; } // 已在写 → 标脏, 写完补写最新
    graphSaving = true;
    do {
      graphDirty = false;
      await putNode(workflowStore.taskId, "quick_graph", {
        workflowMode: "standard",
        nodes: nodes.value.map((n) => ({ ...n, canvasPosition: { x: 0, y: 0 } })),
        edges: userEdges.value,
        jobId: jobId.value || undefined,
        runState: runState.value,
        savedAt: new Date().toISOString()
      }).catch(() => null);
    } while (graphDirty); // 期间又有新状态 → 用最新快照重写一次(防旧态覆盖竞态)
  } catch { /* 容忍 */ } finally {
    graphSaving = false;
  }
}

// ── 启动管线(闭源 Mi(): 写 input → phrase1 完成 → 逐阶段建 job → 800ms 轮询) ──
async function startExecution() {
  if (runState.value === "running") return;
  try {
    // 意图主题优先(闭源: 确认后按提取的研究主题启动); 兜底默认标题
    const intentTopic = intakeDraft.value.topic.trim();
    const title = intentTopic || "快速科研任务";
    const { projectId } = await ensureModuleTask("workflow", title);
    if (!projectId) throw new Error("任务创建失败");
    // 项目指针写回 store(审查修复: 原从未赋值 → saveGraph 恒 return → quick_graph 从不落库 → 真刷新丢全部状态)
    if (workflowStore) workflowStore.taskId = projectId;
    // 持久化指针(闭源 lastTask_workflow): 刷新/重进恢复到本任务画布(全链完成也不丢)
    try { localStorage.setItem("lastTask_workflow", projectId); } catch { /* 容忍 */ }
    // publishPhase1 语义: 写 input 节点(信息录入=快照写入, 完成后 phrase1 即 done)
    await putNode(projectId, "input", {
      title,
      outline: "一、引言\n二、文献综述与分析框架\n三、现状描述或案例呈现\n四、问题分析与对策建议\n五、结语",
      researchMethod: intakeDraft.value.method === "定性研究" ? "qualitative" : intakeDraft.value.method ? "quantitative" : "",
      totalWordCount: 10000,
      requirements: intakeDraft.value.boundary ? `研究边界: ${intakeDraft.value.boundary}` : "",
      updatedAt: new Date().toISOString()
    }).catch(() => null);
    runState.value = "running";
    // phrase1(信息录入)完成态; phrase2 起为真实 job
    nodes.value = nodes.value.map((n) => (n.id === "phrase1" ? { ...n, state: "completed", stateLabel: "已完成", progress: 100 } : n));
    pushMsg({ role: "agent", text: `标准工作流已启动「${title}」, Agent 将自动连续执行 Phase 1–5。` });
    await kickNextStage(projectId);
  } catch (e) {
    runState.value = "failed";
    toast(`启动失败: ${(e as Error).message}`, "error");
  }
}
/** 建下一草稿阶段 job(跳过 phrase1 起始节点; 闭源链: analyze→literature-search→table-generate→phase4_batch→merge)
 *  产物链修复: 每阶段建 job 前从后端节点/素材回读真实产物 → 写入下阶段 inputSnapshot
 *  (analyze 落 sections 结构 → phase4 以带 aiSkill 的章节快照批量生成; phase4 回写正文 → merge 后端自读) */
async function kickNextStage(projectId: string) {
  const next = nodes.value.find((n) => n.state === "draft" && !n.standalone);
  if (!next) {
    runState.value = "completed";
    pushMsg({ role: "agent", text: "标准工作流全部阶段已完成, 最终稿件已生成。" });
    stopPoll();
    return;
  }
  const kindMap: Record<string, string> = { phrase2: "analyze", phrase3: "literature-search", phrase4: "phase4_batch", phrase5: "merge" };
  const kind = kindMap[next.id] ?? "analyze";
  // ── 跨阶段产物回填(空产物根因修复: 原 phase4 只投 1 节空壳 → 正文全空 → merge 0 字节) ──
  let snapshot: Record<string, unknown> = {};
  if (next.id === "phrase2") {
    // analyze 输入: 研究意图 + 默认章节大纲(后端 runAnalyzeArchitecture 解析落 sections 节点)
    const intentOutline = ["一、引言", "二、文献综述与分析框架", "三、现状描述或案例呈现", "四、问题分析与对策建议", "五、结语"].join("\n");
    snapshot = { outline: intentOutline };
  } else if (next.id === "phrase4") {
    // phase4 输入: 回读 sections 节点(analyze 落库的结构 + aiSkill 写作指导) → 逐章批量生成
    const secNode = await getNode(projectId, "sections").catch(() => null);
    const secs = (secNode?.sections ?? []) as Array<Record<string, unknown>>;
    if (secs.length) {
      snapshot = {
        sections: secs.map((s) => ({
          id: s.id, title: s.title, level: s.level ?? 1,
          skill_prompt: s.skill_prompt && String(s.skill_prompt).trim()
            ? String(s.skill_prompt)
            : s.aiSkill ? JSON.stringify(s.aiSkill) : ""
        }))
      };
    }
  }
  // phrase5(merge) 无需快照: 后端 runPhase5 从 sections 节点自读正文
  const t = await createTask({
    title: `阶段: ${next.title}`,
    projectId,
    module: "workflow",
    jobKind: kind,
    goal: intakeDraft.value.topic.trim() || "快速科研任务",
    phase: next.id === "phrase2" ? 2 : next.id === "phrase3" ? 3 : next.id === "phrase4" ? 4 : 5,
    phaseLabel: next.title,
    inputSnapshot: snapshot
  });
  jobId.value = t.id;
  nodes.value = nodes.value.map((n) => (n.id === next.id ? { ...n, state: "running", stateLabel: "执行中" } : n));
  pushMsg({ role: "agent", text: `阶段「${next.title}」自动启动…` });
  pollTask(t.id, projectId);
}
function pushMsg(p: { role: "user" | "agent"; text?: string; kind?: ChatMsg["kind"] } & Partial<Omit<ChatMsg, "role" | "kind" | "id" | "time">>) {
  const { role, kind, ...rest } = p;
  messages.value.push(mkMsg({ role, kind: kind ?? "text", ...rest }));
  scrollToBottom();
}
function scrollToBottom() {
  setTimeout(() => {
    if (chatScroll.value) chatScroll.value.scrollTop = chatScroll.value.scrollHeight;
  }, 50);
}

// ── 轮询对账(闭源 Dn(): 状态映射节点 + 完成后触发下一阶段 + node-update/progress 消息) ──
let lastStageMsg = ""; // 阶段完成消息去重
function pollTask(taskId: string, projectId: string) {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const t = await getTask(taskId);
      if (!t) return;
      const stageMap: Record<string, string> = { analyze: "phrase2", "literature-search": "phrase3", "table-generate": "phrase3", "theory-generate": "phrase3", phase4_batch: "phrase4", merge: "phrase5", phase5_review: "phrase5", phase5_revise: "phrase5" };
      const cur = stageMap[t.jobKind ?? ""] ?? "phrase1";
      if (t.status === "done" || t.status === "completed") {
        const node = nodes.value.find((n) => n.id === cur);
        // ── 产物回读(空产物修复: 每阶段 done → 后端落库产物取回 → 节点 preview/节点卡/消息卡) ──
        let outputTxt = node?.output ?? "阶段产物";
        let previewTxt = "";
        let artifactMeta: { title: string; count: number; label: string } | null = null;
        try {
          if (cur === "phrase2") {
            const secNode = await getNode(projectId, "sections").catch(() => null);
            const secs = (secNode?.sections ?? []) as Array<Record<string, unknown>>;
            outputTxt = `章节结构 ${secs.length} 章`;
            previewTxt = secs.slice(0, 8).map((s) => `${s.title ?? ""}`).join(" / ");
            artifactMeta = secs.length ? { title: "章节结构", count: secs.length, label: "章节" } : null;
          } else if (cur === "phrase3") {
            // 素材在 research_materials 表(闭源 Au.list 语义; runLiteratureSearch 等按 kind 写入)
            const r = await q<{ materials?: Array<Record<string, unknown>> }>(`/research/materials?projectId=${projectId}`).catch(() => ({ materials: [] as Array<Record<string, unknown>> }));
            const mats = Array.isArray(r.materials) ? r.materials : [];
            outputTxt = `研究素材 ${mats.length} 条`;
            previewTxt = mats.slice(0, 5).map((m) => String(m.title ?? m.content_md ?? "").slice(0, 24)).join(" / ");
            artifactMeta = mats.length ? { title: "研究素材", count: mats.length, label: "素材" } : null;
          } else if (cur === "phrase4") {
            const secNode = await getNode(projectId, "sections").catch(() => null);
            const secs = (secNode?.sections ?? []) as Array<Record<string, unknown>>;
            const done = secs.filter((s) => String(s.content ?? "").replace(/\s/g, "").length > 30);
            const words = done.reduce((a, s) => a + String(s.content ?? "").replace(/\s/g, "").length, 0);
            outputTxt = `章节正文 ${done.length}/${secs.length} 章 · ${words} 字`;
            previewTxt = done.slice(0, 3).map((s) => `${s.title}: ${String(s.content ?? "").slice(0, 40)}…`).join(" | ");
            artifactMeta = done.length ? { title: "章节正文", count: done.length, label: "章" } : null;
          } else if (cur === "phrase5") {
            const wb = (await getWorkbench(projectId).catch(() => ({}))) as Record<string, unknown>;
            const full = String(wb.mergedFullText ?? wb.merged_fulltext ?? "");
            const n = full.replace(/\s/g, "").length;
            outputTxt = `最终稿件 ${n} 字`;
            previewTxt = full ? full.slice(0, 80) + "…" : "合稿完成(正文为空)";
            artifactMeta = { title: "最终稿件", count: n, label: "字" };
          }
        } catch { /* 回读失败用默认 */ }
        // 节点字段更新(output/outputPreview/artifactCount 供卡片画布展示)
        const nodeIdx = nodes.value.findIndex((n) => n.id === cur);
        if (nodeIdx >= 0) {
          const nn = { ...nodes.value[nodeIdx], state: "completed", stateLabel: "已完成", progress: 100, output: outputTxt, outputPreview: previewTxt || undefined, artifactCount: artifactMeta?.count };
          nodes.value = nodes.value.map((n, i) => (i === nodeIdx ? nn : n));
        }
        // node-update 完成卡(每阶段一条, 产物真值)
        if (node && lastStageMsg !== cur) {
          lastStageMsg = cur;
          pushMsg({
            role: "agent", kind: "node-update",
            title: node.title ?? cur,
            statusLabel: "已完成",
            detailLabel: "产出",
            detail: outputTxt,
            artifactCount: artifactMeta?.count ?? 0,
            artifactLabel: artifactMeta?.label ?? "",
            preview: previewTxt || `进度 ${nodes.value.filter((x) => x.state === "completed").length}/${nodes.value.filter((x) => !x.standalone).length}`
          });
          // 终稿产物(phrase5 merge 完成 → artifact 卡 + merged 字数)
          if (cur === "phrase5" && artifactMeta) {
            pushMsg({
              role: "agent", kind: "artifact", icon: "📄",
              title: artifactMeta.title,
              detail: `已生成 ${artifactMeta.count} ${artifactMeta.label}合并全文`,
              nodeId: "phrase5"
            });
          }
          void saveGraph();
        } else if (nodeIdx >= 0) {
          void saveGraph();
        }
        // 阶段 job 完成(phrase2-5)→ 自动推进下一草稿阶段(审查修复: 原推进只在 phrase1 分支 → analyze 完成后链即死)
        await kickNextStage(projectId);
      } else if (t.status === "running") {
        const prog = (t.progress as { current?: number })?.current;
        nodes.value = nodes.value.map((n) => (n.id === cur ? { ...n, state: "running", stateLabel: "执行中", progress: prog ? Number(prog) * 20 : 35 } : n));
        void saveGraph();
      } else if (t.status === "failed" || t.status === "cancelled") {
        nodes.value = nodes.value.map((n) => (n.id === cur ? { ...n, state: t.status === "failed" ? "failed" : "cancelled", stateLabel: STATE_LABEL[t.status] ?? t.status } : n));
        runState.value = "failed";
        pushMsg({ role: "agent", text: `阶段「${cur}」执行失败, 可修正后重试。` });
        stopPoll();
      }
    } catch { /* 容忍 */ }
  }, 800);
}
function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── 意图对话(闭源: 提取 topic/object/method/boundary → 缺字段 question 追问 ≤2 轮 → plan 卡+确认 → 启动) ──
const intakeRound = ref(0);
const intakeDraft = ref<{ topic: string; object: string; method: string; type: string; boundary: string }>({ topic: "", object: "", method: "", type: "", boundary: "" });
const awaitingExec = ref(false);
const requiredFields = computed(() => {
  const d = intakeDraft.value;
  const missing: string[] = [];
  if (!d.topic.trim()) missing.push("研究主题");
  if (!d.object.trim()) missing.push("研究对象");
  if (!d.method.trim()) missing.push("研究方法");
  return missing;
});
const intakeComplete = computed(() => requiredFields.value.length === 0);
/** 规则提取(闭源 jl 词表语义): 标题含 8 字 6 汉 → 判定主题; 关键词归槽 */
function extractIntent(raw: string) {
  const t = String(raw ?? "");
  const out = { ...intakeDraft.value };
  const topRe = t.match(/(?:研究|探讨|分析|影响|机制|效应|实证|基于)[^。；;，,\n]{4,40}/);
  // 主题: 优先引号内, 或"研究..."/长串
  const qm = t.match(/["“"']([^""']{4,40})["”"']/);
  if (qm) out.topic = qm[1];
  else if (topRe) out.topic = topRe[0];
  else if (/[一-龥]/.test(t) && t.length >= 8) out.topic = t.slice(0, 40);
  if (!out.topic.trim()) {
    const wm = t.match(/(?:主题|题目|标题)[:：]\s*([^。；;，,\n]{4,40})/);
    if (wm) out.topic = wm[1];
  }
  // 对象
  const objRe = t.match(/(?:以|针对|聚焦|研究对象是|对象为)[^。；;，,\n]{2,18}?(?:为对象|为例|为研究对象)?/);
  if (objRe) out.object = objRe[0].replace(/^(以|针对|聚焦|研究对象是|对象为)/, "").slice(0, 18);
  const obj2 = t.match(/(?:中小企业|农户|企业|银行|政府|高校|制造业|服务业|县域|省份|城市群|上市公司|上市公司|居民|家庭|个体户)/);
  if (!out.object && obj2) out.object = obj2[0];
  // 方法
  if (/(实证|回归|面板|DID|双重差分|PSM|断点|OLS|GMM|中介|调节|问卷|调研|案例分析|扎根|访谈)/.test(t)) {
    if (/问卷|调研|访谈|扎根/.test(t) && !/回归|实证|面板|DID/.test(t)) out.method = "定性研究";
    else if (/中介|调节|机制/.test(t)) out.method = "定量研究(含机制检验)";
    else out.method = "定量研究";
  }
  // 边界(如年份/地区)
  const bd = t.match(/(\d{4}—\d{4}年|\d{4}年(?:以来|至今)|[一二三四五六七八九十]{2,4}年|近\d+年)/);
  if (bd) out.boundary = bd[1];
  const reg = t.match(/(?:基于|以)[^。；;]{2,14}?(省|市|地区|样本|数据|面板)/);
  if (!out.boundary && reg) out.boundary = reg[0].replace(/^基于|^以/, "").slice(0, 14);
  return out;
}
/** 首条指令判定(闭源: 执行类词 → 直接启动; 其余 → 提取/追问) */
const EXEC_WORDS = /^(开始|执行|确认|启动|继续|跑|开始执行|确认方案|生成吧|可以|好的|是的|对)/;
function isExecPhrase(text: string): boolean {
  const t = text.trim();
  if (EXEC_WORDS.test(t)) return true;
  if (t.length <= 8 && /(开始|执行|确认|启动|继续|可以|好的|同意)/.test(t)) return true;
  return false;
}
async function send() {
  const text = input.value.trim();
  if (!text || sending.value) return;
  input.value = "";
  pushMsg({ role: "user", text });
  // 执行指令: 已齐备 → 启动; 缺字段 → 提示先补齐
  if (isExecPhrase(text)) {
    if (!intakeComplete.value) {
      pushMsg({
        role: "agent", kind: "question",
        question: "请补充以下信息：",
        missingInputs: requiredFields.value,
        understanding: summarizeIntake()
      });
      return;
    }
    void startExecution();
    return;
  }
  // 特殊命令(闭源特殊命令正则语义)
  const cmd = text.match(/^(新建|重置|清空|帮助|暂停|恢复|状态)(?:任务|画布|工作流|)?/);
  if (cmd) {
    const c = cmd[1];
    if (c === "新建" || c === "重置" || c === "清空") { newBlankCanvas(); pushMsg({ role: "agent", text: "已重置为新的空白画布(标准工作流)。" }); return; }
    if (c === "暂停") { if (runState.value === "running") void pauseResume(); else pushMsg({ role: "agent", text: "当前没有运行中的任务。" }); return; }
    if (c === "恢复") { if (runState.value === "paused") void pauseResume(); else pushMsg({ role: "agent", text: "当前没有已暂停的任务。" }); return; }
    if (c === "状态") { pushMsg({ role: "agent", text: `画布状态: ${runLabel.value}; 已完成 ${activeCount.value}/${nodes.value.filter((n) => !n.standalone).length} 阶段。` }); return; }
    if (c === "帮助") { pushMsg({ role: "agent", text: "支持: 自然语言描述研究需求 / 回复「开始执行」启动 / 「暂停」「恢复」「状态」「新建任务」。" }); return; }
  }
  // 提取 + 追问(≤2 轮; 齐备 → 理解卡 + plan 卡 + 待确认)
  intakeDraft.value = extractIntent(text);
  intakeRound.value = Math.min(2, intakeRound.value + 1);
  if (!intakeComplete.value && intakeRound.value <= 2) {
    pushMsg({
      role: "agent", kind: "question",
      question: intakeRound.value >= 2 ? "还差最后一点信息：" : "我已理解你的目标，请补充：",
      target: intakeDraft.value.topic || undefined,
      understanding: summarizeIntake(),
      missingInputs: requiredFields.value
    });
  } else if (intakeComplete.value) {
    awaitingExec.value = true;
    const planTxt = ["已确认研究方案", `主题「${intakeDraft.value.topic}」`];
    if (intakeDraft.value.object) planTxt.push(`对象 ${intakeDraft.value.object}`);
    if (intakeDraft.value.method) planTxt.push(intakeDraft.value.method);
    pushMsg({ role: "agent", text: planTxt.join(" · ") });
    pushMsg({
      role: "agent", kind: "plan",
      items: [
        { label: "信息录入与目标确认", module: "phrase1", state: "done" },
        { label: "科研架构分析", module: "phrase2", state: "todo" },
        { label: "素材检索与准备", module: "phrase3", state: "todo" },
        { label: "章节正文创作", module: "phrase4", state: "todo" },
        { label: "合稿定稿", module: "phrase5", state: "todo" }
      ]
    });
    pushMsg({ role: "agent", text: "方案已就绪, 回复「开始执行」即启动标准工作流。" });
  } else {
    pushMsg({ role: "agent", text: "信息还不太够。请描述研究主题、研究对象与研究方法(如「分析数字普惠金融对中小企业融资约束的影响, 用面板回归」), 或直接说「开始执行」使用默认模板。" });
  }
}
/** 已识别小结(闭源 understanding) */
function summarizeIntake(): string {
  const d = intakeDraft.value;
  const parts: string[] = [];
  if (d.topic) parts.push(`主题: ${d.topic}`);
  if (d.object) parts.push(`对象: ${d.object}`);
  if (d.method) parts.push(`方法: ${d.method}`);
  if (d.boundary) parts.push(`边界: ${d.boundary}`);
  return parts.join("; ");
}
function onEnter(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

// ── question 卡交互(闭源 Ei/Tn: 选项点击→填输入框; 集中补齐→missingInputs 并入输入框) ──
function submitOption(m: ChatMsg, opt: { label: string; prompt: string }) {
  if (m.optionSubmitted) return;
  m.selectedOption = opt.label;
  m.optionSubmitted = true;
  input.value = opt.prompt;
  void send();
}
function prefillMissing(m: ChatMsg) {
  if (m.optionSubmitted) return;
  m.optionSubmitted = true;
  const missing = m.missingInputs ?? [];
  input.value = missing.join("、") + "：";
  setTimeout(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea");
    ta?.focus();
  }, 60);
}

/** artifact 卡「查看关联节点」→ 选中对应节点并滚动画布视角 */
function goNodeFromArtifact(nodeId: string | undefined) {
  if (!nodeId) return;
  const n = nodes.value.find((x) => x.id === nodeId);
  if (n) selectedNode.value = n;
  closeCtxMenu();
}

// ── 状态机操作 ──
async function pauseResume() {
  if (runState.value === "running") {
    runState.value = "paused";
    stopPoll();
    pushMsg({ role: "agent", text: "任务已暂停, 可以调整画板; 点击恢复继续。" });
  } else if (runState.value === "paused") {
    runState.value = "running";
    pushMsg({ role: "agent", text: "任务已恢复运行…" });
    // 恢复须续连轮询(审查修复: 原恢复仅改状态, 后端 job 继续跑但前端不再推进)
    const pid = workflowStore?.taskId;
    if (pid && jobId.value) pollTask(jobId.value, pid);
  }
}
async function retryFailed() {
  if (runState.value !== "failed") return;
  const t = await createTask({ title: "重试科研任务", projectId: workflowStore?.taskId, module: "workflow", jobKind: "analyze", goal: "快速科研任务", phase: 2, phaseLabel: "科研架构" });
  jobId.value = t.id;
  runState.value = "running";
  if (workflowStore?.taskId) pollTask(t.id, workflowStore.taskId);
}

// ── 恢复(挂载: 指针项目 quick_graph) ──
onMounted(async () => {
  workflowStore = useWorkflowStore();
  await workflowStore.loadProject().catch(() => null);
  if (!workflowStore.taskId) {
    // 兜底: loadProject 只找活跃任务; 全链完成(done)后刷新会丢指针 → 取最近含 quick_graph 的项目
    try {
      const r = await q<{ projects?: Array<{ id: string; updated_at?: string }> }>(`/research/projects`).catch(() => ({ projects: [] }));
      const list = (r.projects ?? []).sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
      for (const p of list.slice(0, 5)) {
        const g = await getNode(String(p.id), "quick_graph").catch(() => null);
        if (g?.nodes) {
          workflowStore.taskId = String(p.id);
          try { localStorage.setItem("lastTask_workflow", String(p.id)); } catch { /* 容忍 */ }
          break;
        }
      }
    } catch { /* 容忍 */ }
  }
  if (workflowStore.taskId) {
    const g = await getNode(workflowStore.taskId, "quick_graph").catch(() => null);
    if (g?.nodes && Array.isArray(g.nodes)) {
      // 保留存库的真实节点状态(running/completed 等), 不重置 draft —
      // 审查修复: 原实现硬编码 draft 导致执行中切走回来进度归零(0/5 永不前进)
      nodes.value = (g.nodes as BizNode[]).map((n) => ({
        ...n,
        state: n.state || "draft",
        stateLabel: n.stateLabel || (STATE_LABEL[(n.state as string) ?? "draft"] ?? "待执行")
      }));
      if (g.jobId) jobId.value = String(g.jobId);
      if (g.runState && ["running", "paused", "completed", "failed", "cancelled"].includes(String(g.runState))) {
        runState.value = g.runState as typeof runState.value;
        // 运行中/暂停 → 续连轮询(断线恢复)
        if ((g.runState === "running" || g.runState === "paused") && g.jobId && workflowStore.taskId) {
          pollTask(String(g.jobId), workflowStore.taskId);
        } else if (g.runState === "completed" && g.jobId && workflowStore.taskId) {
          // 终态对账(空产物修复补漏): 全链完成后刷新进来, 残留 running 的中间节点
          // (saveGraph 竞态把 phrase4 存成 running) → 查对应 job 真状态校正
          try {
            const jt = await getTask(String(g.jobId)).catch(() => null);
            if (jt && (jt.status === "done" || jt.status === "completed")) {
              const stageMap: Record<string, string> = { analyze: "phrase2", "literature-search": "phrase3", phase4_batch: "phrase4", merge: "phrase5", phase5_review: "phrase5", phase5_revise: "phrase5" };
              const doneNode = stageMap[jt.jobKind ?? ""];
              if (doneNode) {
                nodes.value = nodes.value.map((n) => (n.id === doneNode && n.state === "running" ? { ...n, state: "completed", stateLabel: "已完成", progress: 100 } : n));
                void saveGraph();
              }
            }
          } catch { /* 容忍 */ }
        }
      }
    }
  }
});
onUnmounted(() => {
  stopPoll();
  void saveGraph();
});

/** 开始门显示: draft 且从未启动过(无 jobId)且画布非空(闭源 start-gate 覆盖层) */
const showStartGate = computed(() => runState.value === "draft" && !jobId.value && nodes.value.length > 0);
const runLabel = computed(() => {
  const map: Record<string, string> = {
    draft: "草稿", running: "运行中", paused: "已暂停", completed: "已完成", failed: "执行失败", cancelled: "已取消"
  };
  return map[runState.value] ?? runState.value;
});
const activeCount = computed(() => nodes.value.filter((n) => n.state === "completed").length);
</script>

<template>
  <div class="quick-view">
    <!-- header -->
    <header class="quick-header">
      <div class="brand-lockup">
        <div class="brand-mark">Q</div>
        <div>
          <h1>可视化DAG编排模式</h1>
          <p>标准工作流 · {{ runLabel }} · {{ activeCount }}/{{ nodes.length }} 阶段完成</p>
        </div>
      </div>
      <span class="preview-badge ok">标准工作流 · 自动执行</span>
    </header>

    <main class="quick-shell">
      <!-- 左: 对话 -->
      <aside class="agent-panel">
        <div class="agent-panel-header">
          <div class="agent-avatar">Q</div>
          <div>
            <strong>科研 Agent</strong>
            <span class="agent-status">● 在线</span>
          </div>
        </div>
        <div class="agent-context">
          <span class="ctx-label">当前任务</span>
          <strong>快速科研任务</strong>
          <span class="state-chip" :class="'st-' + runState">{{ runLabel }}</span>
        </div>
        <div ref="chatScroll" class="conversation-stream">
          <article v-for="m in messages" :key="m.id" class="message" :class="'is-' + m.role + ' is-' + (m.kind || 'text')">
            <div v-if="m.role === 'agent'" class="msg-avatar">Q</div>
            <div class="msg-body">
              <div class="msg-meta">
                <strong>{{ m.role === "agent" ? "科研 Agent" : "你" }}</strong>
                <span>{{ m.time }}</span>
              </div>
              <div class="msg-content">
                <!-- text -->
                <p v-if="m.text">{{ m.text }}</p>
                <!-- node-update 卡 -->
                <div v-if="m.kind === 'node-update'" class="node-update-card" :class="'is-' + m.nodeId">
                  <div class="nu-head">
                    <strong>{{ m.title }}</strong>
                    <span :class="'is-' + m.statusLabel">{{ m.statusLabel }}</span>
                  </div>
                  <div v-if="m.detail" class="nu-detail">
                    <strong>{{ m.detailLabel }}</strong>
                    <span>{{ m.detail }}</span>
                  </div>
                  <div v-if="m.artifactCount" class="nu-artifacts">已准备 {{ m.artifactCount }} {{ m.artifactLabel }}</div>
                  <p v-if="m.preview" class="nu-preview">{{ m.preview }}</p>
                </div>
                <!-- question 卡 -->
                <div v-if="m.kind === 'question'" class="question-card">
                  <div v-if="m.target" class="q-block"><span class="q-label">当前目标</span><strong>{{ m.target }}</strong></div>
                  <div v-if="m.understanding" class="q-block"><span class="q-label">已识别</span><p>{{ m.understanding }}</p></div>
                  <strong v-if="m.question" class="q-question">{{ m.question }}</strong>
                  <!-- options 单选 -->
                  <div v-if="m.options?.length" class="q-options">
                    <button
                      v-for="opt in m.options"
                      :key="opt.label"
                      type="button"
                      :disabled="m.optionSubmitted"
                      class="q-option"
                      :class="{ 'is-selected': m.selectedOption === opt.label }"
                      @click="submitOption(m, opt)"
                    >{{ opt.label }}<span v-if="m.selectedOption === opt.label">已选择</span></button>
                  </div>
                  <!-- missing inputs 集中补齐 -->
                  <div v-else-if="m.missingInputs?.length" class="q-missing">
                    <div class="q-missing-chips">
                      <span v-for="mi in m.missingInputs" :key="mi">{{ mi }}</span>
                    </div>
                    <button type="button" class="q-missing-btn" :disabled="m.optionSubmitted" @click="prefillMissing(m)">在一条消息中补齐以上信息</button>
                  </div>
                </div>
                <!-- plan 卡 -->
                <div v-if="m.kind === 'plan'" class="plan-card">
                  <div class="plan-card-head"><span class="card-icon">✦</span><strong>执行计划</strong><span>{{ m.items?.length ?? 0 }} 个步骤</span></div>
                  <div v-for="it in m.items ?? []" :key="it.label" class="plan-item">
                    <span class="plan-check" :class="'is-' + (it.state ?? 'todo')">{{ it.state === "done" ? "✓" : it.state === "active" ? "•" : "" }}</span>
                    <span>{{ it.label }}</span>
                    <small>{{ it.module }}</small>
                  </div>
                </div>
                <!-- progress 卡 -->
                <div v-if="m.kind === 'progress'" class="progress-card">
                  <span>{{ m.module }}</span><strong>{{ m.progress }}%</strong>
                </div>
                <!-- artifact 卡(闭源: 图标 + 标题 + 明细 + 查看关联节点) -->
                <div v-if="m.kind === 'artifact'" class="artifact-card">
                  <div class="artifact-icon">{{ m.icon || "📄" }}</div>
                  <div class="artifact-body">
                    <strong>{{ m.title }}</strong>
                    <p>{{ m.detail }}</p>
                    <button type="button" @click="goNodeFromArtifact(m.nodeId)">查看关联节点 ↗</button>
                  </div>
                </div>
              </div>
            </div>
          </article>
        </div>
        <div class="composer">
          <textarea v-model="input" rows="2" placeholder="描述研究需求, 输入「开始执行」启动标准工作流…" @keydown="onEnter"></textarea>
          <button class="send-button" :disabled="!input.trim() || sending" @click="send">↗</button>
        </div>
        <div class="run-actions">
          <button v-if="runState === 'draft'" class="run-btn" @click="startExecution">▶ 开始自动执行</button>
          <button v-else-if="runState === 'running'" class="run-btn pause" @click="pauseResume">⏸ 暂停</button>
          <button v-else-if="runState === 'paused'" class="run-btn" @click="pauseResume">▶ 恢复</button>
          <button v-else-if="runState === 'failed'" class="run-btn" @click="retryFailed">↻ 重试</button>
        </div>
      </aside>

      <!-- 右: 画布 -->
      <section class="workspace-stage">
        <AgentFlowCanvas
          :nodes="nodes"
          :edges="userEdges"
          :editable="runState === 'draft' || runState === 'paused' || runState === 'failed'"
          :locked="runState === 'running'"
          @node-selected="onNodeSelected"
          @graph-changed="onGraphChanged"
          @pane-context-menu="onPaneContextMenu"
          @node-context-menu="onNodeContextMenu"
        />
        <!-- 开始门(闭源 canvas-start-gate: draft 且未启动过 → 覆盖层引导) -->
        <div v-if="showStartGate" class="canvas-start-gate">
          <div class="gate-mark">00</div>
          <div class="gate-copy">
            <strong>工作流已准备</strong>
            <span>点击开始后，Agent 将自动连续执行 Phrase 1–5，直到生成最终稿。</span>
          </div>
          <button type="button" class="gate-button" @click="startExecution">开始自动执行</button>
        </div>
        <div v-else-if="runState === 'running'" class="canvas-locked-banner">画板已锁定 · Agent 自动执行中</div>
        <!-- 右键菜单(闭源 canvas-context-menu) -->
        <div
          v-if="ctxMenu"
          class="canvas-context-menu"
          :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
          @click.stop
          @contextmenu.prevent="closeCtxMenu"
        >
          <div class="ctx-title">{{ ctxMenu.nodeId ? ctxMenu.nodeTitle : "新建画布任务" }}</div>
          <template v-if="ctxMenu.nodeId">
            <button type="button" class="context-menu-item" @click="ctxViewDetail">查看节点详情 <span>↗</span></button>
            <button v-if="ctxMenu.canDelete" type="button" class="context-menu-item is-danger" @click="ctxMenu.nodeId && removeModuleNode(ctxMenu.nodeId)">删除模块 <span>×</span></button>
            <div v-else class="ctx-forbidden">系统节点不可删除</div>
          </template>
          <template v-else>
            <div class="context-menu-label">选择要加入的模块</div>
            <button v-for="d in MODULE_DEFS" :key="d.id" type="button" class="context-menu-item" @click="addModuleNode(d)">{{ d.menuLabel }} <span>＋</span></button>
            <button type="button" class="context-menu-item is-muted" @click="newBlankCanvas">新建空白任务 <span>⌘</span></button>
          </template>
        </div>
        <!-- 点击空白处关闭菜单 -->
        <div v-if="ctxMenu" class="ctx-backdrop" @click="closeCtxMenu" @contextmenu.prevent="closeCtxMenu"></div>
        <!-- 右侧工作面板(闭源 canvas-workspace-panel: module 徽标+标题+live-state+分节点表单/预览/产物) -->
        <div v-if="selectedNode" class="workspace-panel" :class="'wp-' + selectedNode.id">
          <header class="workspace-panel-header">
            <div>
              <span class="workspace-panel-kicker">{{ selectedNode.module }}</span>
              <h2>{{ selectedNode.title }}</h2>
            </div>
            <div class="workspace-panel-actions">
              <span class="workspace-live-state" :class="'is-' + (selectedNode.state || 'draft')">{{ selectedNode.stateLabel || selectedNode.state }}</span>
              <button type="button" class="workspace-close" title="关闭工作界面" @click="selectedNode = null">×</button>
            </div>
          </header>

          <!-- phrase1: 信息录入表单(闭源: 主题+目标可编辑 → 保存推进) -->
          <div v-if="selectedNode.id === 'phrase1'" class="phrase-workspace">
            <div class="workspace-summary">
              <div><span class="workspace-summary-label">当前阶段</span><strong>研究任务初始化</strong></div>
              <div v-if="runState === 'draft' || runState === 'paused'" class="workspace-summary-note">主题修改后需重新开始执行</div>
            </div>
            <div class="workspace-progress" v-if="selectedNode.state === 'completed'"><i style="width:100%"></i><span>100%</span></div>
            <div class="workspace-form-grid">
              <label class="workspace-field">
                <span>研究主题</span>
                <input v-model="panelTopic" :disabled="lockedNow" placeholder="如: 数字经济对制造业企业全要素生产率的影响研究" />
              </label>
              <label class="workspace-field workspace-field-wide">
                <span>研究目标</span>
                <textarea v-model="panelGoal" rows="4" :disabled="lockedNow" placeholder="描述研究目标、想要产出的论文形式与已有材料…"></textarea>
              </label>
              <div class="workspace-evidence-row">
                <span class="workspace-evidence-dot"></span>
                <div>
                  <strong>先确认研究主题和目标</strong>
                  <small>研究对象、类型与范围会根据你的描述由 Agent 自动补全</small>
                </div>
                <button type="button" class="ws-ask-btn" :disabled="lockedNow" @click="agentCheckPhrase1">让 Agent 检查</button>
              </div>
            </div>
            <footer class="workspace-panel-footer">
              <span>修改会保存在当前任务草稿中</span>
              <div>
                <button type="button" class="workspace-secondary" @click="selectedNode = null">稍后处理</button>
                <button type="button" class="workspace-primary" :disabled="lockedNow" @click="saveAndEnterPhrase2">保存并进入 Phrase 2</button>
              </div>
            </footer>
          </div>

          <!-- phrase4/5: 正文预览(闭源 final-manuscript-workspace: 拉 sections/merged 实时正文) -->
          <div v-else-if="selectedNode.id === 'phrase4' || selectedNode.id === 'phrase5'" class="final-manuscript-workspace">
            <span class="workspace-placeholder-label">{{ selectedNode.id === 'phrase4' ? '正文预览' : '最终稿件' }}</span>
            <h3>{{ manuscriptTitle }}</h3>
            <div class="final-manuscript-meta" v-if="selectedNode.id === 'phrase5' && manuscriptWords > 0">共 {{ manuscriptWords }} 字 · 已自动合稿</div>
            <div v-if="manuscriptLoading" class="final-manuscript-preview is-loading">正在载入预览…</div>
            <div v-else-if="manuscriptBody" class="final-manuscript-preview" @click="openManuscriptModal">
              <pre>{{ manuscriptBody.slice(0, 600) }}{{ manuscriptBody.length > 600 ? "\n……(点击查看全文)" : "" }}</pre>
            </div>
            <div v-else class="phase4-preview-empty">{{ selectedNode.id === 'phrase5' ? '尚未生成最终稿件 — 先运行完整工作流' : '尚无章节正文 — 运行到文本创作阶段后自动填充' }}</div>
            <div class="final-manuscript-actions" v-if="manuscriptBody">
              <button type="button" class="workspace-secondary" @click="openManuscriptModal">预览全文</button>
              <button v-if="selectedNode.id === 'phrase5'" type="button" class="workspace-primary" @click="exportManuscript">导出 Word</button>
            </div>
          </div>

          <!-- 其他节点: 输入/输出/产物详情 -->
          <div v-else class="node-panel-detail">
            <div class="drawer-row"><label>输入</label><span>{{ selectedNode.input || "待分配" }}</span></div>
            <div class="drawer-row"><label>预期输出</label><span>{{ selectedNode.output || "—" }}</span></div>
            <div class="drawer-row"><label>状态</label><span>{{ selectedNode.stateLabel || selectedNode.state }}</span></div>
            <div v-if="selectedNode.artifactCount" class="drawer-artifact">已产出 {{ selectedNode.artifactCount }} {{ selectedNode.output }}</div>
            <div v-if="selectedNode.outputPreview" class="drawer-live-output">{{ selectedNode.outputPreview }}</div>
            <div v-if="selectedNode.hint" class="drawer-hint">{{ selectedNode.hint }}</div>
            <div v-if="runState === 'draft' && selectedNode.id === 'phrase2'" class="workspace-suggest">
              提示: 开始执行后将自动生成章节结构(科研架构)。
            </div>
          </div>
        </div>
        <!-- 全文预览弹层(phrase4/5) -->
        <div v-if="manuscriptModal" class="paper-preview-shell" @click.self="manuscriptModal = false">
          <div class="paper-preview-modal">
            <header class="paper-preview-modal-header">
              <strong>{{ manuscriptTitle }}</strong>
              <button type="button" class="workspace-close" @click="manuscriptModal = false">×</button>
            </header>
            <div class="paper-preview-scroll"><pre>{{ manuscriptBody }}</pre></div>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.quick-view {
  --ink: #E8EEF7; --muted: #8B9BB1; --line: #222F44; --soft: #161F33; --blue: #4D84CB;
  height: 100%;
  min-height: 0;
  width: 100%;
  margin: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #0A1120;
  color: var(--ink);
  font-family: PingFang SC, Microsoft YaHei, sans-serif;
}
.quick-header {
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 62px;
  padding: 10px 22px;
  border-bottom: 1px solid #222F44;
  background: rgba(17, 25, 44, 0.96);
  flex-shrink: 0;
}
.brand-lockup { display: flex; align-items: center; gap: 11px; }
.brand-mark {
  width: 32px; height: 32px; border-radius: 8px;
  display: grid; place-items: center;
  background: #0F1830; color: #F1F5F9; font-weight: 800; font-size: 13px;
}
.brand-lockup h1 { margin: 0; font-size: 15px; letter-spacing: 0.01em; }
.brand-lockup p { margin: 3px 0 0; color: var(--muted); font-size: 10px; }
.preview-badge {
  font-size: 10px; color: #E8B54A; background: #11192Cbeb;
  border: 1px solid #3A3020; padding: 2px 10px; border-radius: 10px;
}
.preview-badge.ok {
  color: #5FD0B4; background: #14281F; border-color: #a7f3d0;
}
.quick-shell { flex: 1; min-height: 0; display: flex; }
.agent-panel {
  width: clamp(240px, 38%, 320px); flex-shrink: 0; border-right: 1px solid var(--line);
  display: flex; flex-direction: column; background: #11192C; min-height: 0;
}
.agent-panel-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; border-bottom: 1px solid #212C45;
}
.agent-avatar {
  width: 34px; height: 34px; border-radius: 50%;
  display: grid; place-items: center;
  background: #0F1830; color: #F1F5F9; font-weight: 800;
}
.agent-panel-header strong { font-size: 13.5px; }
.agent-status { display: block; font-size: 10.5px; color: #5FD0B4; }
.agent-context {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px; background: var(--soft); font-size: 11.5px;
}
.ctx-label { color: var(--muted); }
.agent-context strong { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state-chip {
  margin-left: auto; font-size: 10px; padding: 2px 8px; border-radius: 9px;
  background: #212C45; color: #8B9BB1; flex-shrink: 0;
}
.st-running { background: #1E2A48 !important; color: #2563eb !important; }
.st-completed { background: #14281F !important; color: #5FD0B4 !important; }
.st-failed { background: #2A1C1C !important; color: #dc2626 !important; }
.conversation-stream {
  flex: 1; overflow-y: auto; padding: 12px;
  display: flex; flex-direction: column; gap: 10px;
}
/* 消息卡(闭源 7 kinds) */
.message { display: flex; gap: 8px; max-width: 100%; }
.message.is-user { flex-direction: row-reverse; }
.msg-avatar {
  width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0;
  display: grid; place-items: center;
  background: #0F1830; color: #F1F5F9; font-size: 11px; font-weight: 800;
}
.msg-body { flex: 1; min-width: 0; }
.message.is-user .msg-body { display: flex; flex-direction: column; align-items: flex-end; }
.msg-meta { display: flex; gap: 7px; font-size: 10px; color: #7A8AA0; margin-bottom: 3px; }
.msg-meta strong { color: #A3B3C8; font-weight: 600; }
.msg-content {
  display: inline-block; max-width: 100%; background: #212C45;
  border-radius: 10px; padding: 8px 12px; font-size: 12.5px; line-height: 1.6;
  word-break: break-word; color: #E8EEF7;
}
.message.is-user .msg-content { background: var(--blue); color: #F1F5F9; }
.msg-content > p { margin: 0; white-space: pre-wrap; }
/* node-update 卡 */
.node-update-card {
  margin: 4px 0; min-width: 240px; background: #11192C; border: 1px solid #222F44;
  border-radius: 9px; padding: 8px 11px;
}
.message.is-user .node-update-card { background: #1E2A48; border-color: transparent; }
.nu-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 5px; }
.nu-head strong { font-size: 12.5px; }
.nu-head span {
  font-size: 10px; padding: 1px 8px; border-radius: 9px;
  background: #1E2A48; color: #2563eb; flex-shrink: 0;
}
.nu-head span.is-已完成, .nu-head span.is-completed { background: #14281F; color: #5FD0B4; }
.nu-head span.is-执行中, .nu-head span.is-running { background: #1E2A48; color: #2563eb; }
.nu-head span.is-执行失败, .nu-head span.is-failed { background: #2A1C1C; color: #dc2626; }
.nu-detail { display: flex; gap: 7px; font-size: 11px; color: #8B9BB1; margin: 3px 0; }
.nu-detail strong { color: #DCE6F2; flex-shrink: 0; }
.nu-artifacts { font-size: 10.5px; color: #7c3aed; margin: 2px 0; }
.nu-preview {
  margin: 4px 0 0; font-size: 11px; color: #93A5BC; background: #1A2438;
  border-left: 2px solid #9aaaf0; padding: 5px 8px; border-radius: 0 6px 6px 0;
}
/* question 卡 */
.question-card { display: flex; flex-direction: column; gap: 7px; min-width: 240px; margin: 3px 0; }
.message.is-user .question-card { background: #11192C; border-radius: 9px; padding: 9px 11px; color: #E8EEF7; }
.q-block { display: flex; flex-direction: column; gap: 2px; }
.q-label { font-size: 10px; color: #7A8AA0; }
.q-question { font-size: 12.5px; line-height: 1.5; }
.q-options { display: flex; flex-wrap: wrap; gap: 6px; }
.q-option {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid #2A3A55; background: #11192C; color: #DCE6F2;
  border-radius: 15px; padding: 4px 12px; font-size: 11.5px; cursor: pointer;
}
.q-option:hover { border-color: #4D84CB; }
.q-option.is-selected { border-color: #4D84CB; background: #1E2A48; color: #3d56b4; }
.q-option.is-selected span { font-size: 10px; }
.q-option:disabled { opacity: 0.7; cursor: default; }
.q-missing { display: flex; flex-direction: column; gap: 7px; align-items: flex-start; }
.q-missing-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.q-missing-chips span {
  font-size: 10.5px; background: #11192C; border: 1px dashed #c7d0e0;
  color: #A3B3C8; padding: 2px 9px; border-radius: 12px;
}
.q-missing-btn {
  border: 1px solid #4D84CB; color: #3d56b4; background: #1E2A48;
  font-size: 11px; padding: 5px 12px; border-radius: 8px; cursor: pointer;
}
.q-missing-btn:disabled { opacity: 0.6; cursor: default; }
/* plan 卡 */
.plan-card {
  min-width: 260px; background: #11192C; border: 1px solid #222F44;
  border-radius: 9px; padding: 9px 11px; margin: 3px 0;
}
.message.is-user .plan-card { background: #1E2A48; border-color: transparent; }
.plan-card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 12px; }
.plan-card-head .card-icon { color: #d19a2f; }
.plan-card-head strong { font-size: 12.5px; }
.plan-card-head span { margin-left: auto; font-size: 10.5px; color: #7A8AA0; }
.plan-item { display: flex; align-items: center; gap: 7px; padding: 3px 0; font-size: 11.5px; }
.plan-item small { margin-left: auto; color: #7A8AA0; font-size: 9.5px; }
.plan-check {
  width: 15px; height: 15px; border-radius: 50%; flex-shrink: 0;
  display: grid; place-items: center; font-size: 9px;
  border: 1px solid #d0d7e3; color: transparent;
}
.plan-check.is-done { background: #5FD0B4; border-color: #5FD0B4; color: #F1F5F9; }
.plan-check.is-active { border-color: #4D84CB; color: #4D84CB; }
/* progress 卡 */
.progress-card { display: flex; align-items: center; gap: 10px; min-width: 200px; font-size: 11.5px; }
.progress-card span { color: #8B9BB1; }
.progress-card strong { color: #3d56b4; font-size: 14px; }
/* artifact 卡(闭源) */
.artifact-card {
  display: flex; gap: 10px; align-items: flex-start;
  background: #11192C; border: 1px solid #222F44; border-radius: 9px;
  padding: 9px 11px; min-width: 240px; margin: 3px 0;
}
.message.is-user .artifact-card { background: #1E2A48; border-color: transparent; }
.artifact-icon {
  width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
  display: grid; place-items: center; font-size: 15px;
  background: #1C2740; border: 1px solid #dfe6f5;
}
.artifact-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.artifact-body strong { font-size: 12.5px; }
.artifact-body p { margin: 0; font-size: 11px; color: #93A5BC; }
.artifact-body button {
  align-self: flex-start; border: 0; background: none; color: #4D84CB;
  font-size: 11px; padding: 0; cursor: pointer;
}
.artifact-body button:hover { text-decoration: underline; }
.composer {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 10px 12px; border-top: 1px solid var(--line);
}
.composer textarea {
  flex: 1; resize: none; border: 1px solid #222F44; border-radius: 10px;
  padding: 8px 11px; font-size: 12.5px; font-family: inherit; line-height: 1.5;
  outline: none;
}
.send-button {
  width: 30px; height: 30px; border: 0; border-radius: 50%;
  background: var(--blue); color: #F1F5F9; font-size: 14px; cursor: pointer;
}
.send-button:disabled { opacity: 0.4; cursor: not-allowed; }
.run-actions { padding: 0 12px 12px; }
.run-btn {
  width: 100%; padding: 8px; border: 0; border-radius: 9px;
  background: var(--blue); color: #F1F5F9; font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.run-btn.pause { background: #E8B54A; }
.workspace-stage {
  flex: 1; min-width: 0; min-height: 0;
  display: flex; flex-direction: column; position: relative;
}
/* 开始门(闭源 canvas-start-gate) */
.canvas-start-gate {
  position: absolute; inset: 0; z-index: 6;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
  background: rgba(17, 25, 44, 0.85); backdrop-filter: blur(1px);
  pointer-events: auto; cursor: pointer;
}
.gate-mark {
  width: 44px; height: 44px; border-radius: 12px;
  background: #43C9CD; color: #F1F5F9; font-weight: 800; font-size: 15px;
  display: grid; place-items: center;
}
.gate-copy { text-align: center; display: flex; flex-direction: column; gap: 5px; }
.gate-copy strong { font-size: 14px; color: #0F1830; }
.gate-copy span { font-size: 11.5px; color: #A3B3C8; max-width: 380px; line-height: 1.6; }
.gate-button {
  border: 0; background: #4D84CB; color: #F1F5F9;
  padding: 9px 26px; border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer;
}
.gate-button:hover { background: #5568d8; }
.canvas-locked-banner {
  position: absolute; top: 42px; left: 50%; transform: translateX(-50%); z-index: 6;
  background: rgba(29, 43, 72, 0.85); color: #F1F5F9; font-size: 11px;
  padding: 6px 16px; border-radius: 16px; pointer-events: none;
}
/* 右键菜单(闭源 canvas-context-menu) */
.canvas-context-menu {
  position: absolute; z-index: 20; min-width: 190px;
  background: #11192C; border: 1px solid #222F44; border-radius: 10px;
  box-shadow: 0 14px 38px rgba(29, 43, 72, 0.16);
  padding: 6px; font-size: 12px;
}
.ctx-title { padding: 6px 8px 7px; font-weight: 700; color: #E8EEF7; border-bottom: 1px solid #1A2333; margin-bottom: 4px; }
.context-menu-label { padding: 4px 8px 6px; color: #7A8AA0; font-size: 10.5px; }
.context-menu-item {
  width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 10px;
  padding: 7px 9px; border: 0; border-radius: 7px; background: #11192C;
  color: #DCE6F2; font-size: 12px; cursor: pointer; text-align: left;
}
.context-menu-item:hover { background: #f1f5ff; color: #3d56b4; }
.context-menu-item span { color: #7A8AA0; }
.context-menu-item.is-danger { color: #c0434f; }
.context-menu-item.is-danger:hover { background: #11192C3f3; color: #E06B6B; }
.context-menu-item.is-muted { color: #8B9BB1; }
.context-menu-item.is-muted:hover { background: #161F33; color: #DCE6F2; }
.ctx-forbidden { padding: 6px 9px; color: #6E7F96; font-size: 11px; }
.ctx-backdrop { position: absolute; inset: 0; z-index: 19; }
/* ── 右侧工作面板(闭源 workspace-panel: header/kicker/live-state + phrase 表单/预览) ── */
.workspace-panel {
  position: absolute; top: 42px; right: 14px; bottom: 14px; width: 330px; z-index: 9;
  display: flex; flex-direction: column;
  background: #11192C; border: 1px solid #2A3A55; border-radius: 12px;
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.workspace-panel-header {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
  padding: 13px 15px 11px; border-bottom: 1px solid #222F44;
}
.workspace-panel-header h2 { margin: 3px 0 0; font-size: 14px; color: #E8EEF7; }
.workspace-panel-kicker {
  font-size: 9px; letter-spacing: 0.14em; font-weight: 700;
  color: #759FD7; text-transform: uppercase;
}
.workspace-panel-actions { display: flex; align-items: center; gap: 8px; }
.workspace-live-state {
  font-size: 10px; padding: 2px 9px; border-radius: 10px;
  background: #212C45; color: #A3B3C8;
}
.workspace-live-state.is-completed, .workspace-live-state.is-done { background: #14281F; color: #5FD0B4; }
.workspace-live-state.is-running { background: #1E2A48; color: #6FA6E8; }
.workspace-live-state.is-failed { background: #2A1C1C; color: #F08A8A; }
.workspace-close {
  border: 0; background: none; font-size: 17px; line-height: 1; color: #7A8AA0; cursor: pointer;
  padding: 0 2px;
}
.workspace-close:hover { color: #E8EEF7; }
/* phrase1 表单 */
.phrase-workspace { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.workspace-summary {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 15px 4px;
}
.workspace-summary span { display: block; font-size: 10px; color: #7A8AA0; }
.workspace-summary strong { font-size: 12px; color: #DCE6F2; }
.workspace-summary-note { font-size: 10px; color: #E8B54A; }
.workspace-progress { display: flex; align-items: center; gap: 8px; margin: 6px 15px 0; }
.workspace-progress i { display: block; height: 4px; border-radius: 3px; background: #5FD0B4; }
.workspace-progress span { font-size: 9px; color: #7A8AA0; }
.workspace-form-grid { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 11px; padding: 10px 15px; }
.workspace-field { display: flex; flex-direction: column; gap: 5px; }
.workspace-field span { font-size: 10.5px; color: #A3B3C8; }
.workspace-field input, .workspace-field textarea {
  border: 1px solid #2A3A55; border-radius: 8px; background: #161F33;
  color: #E8EEF7; font-size: 12px; padding: 8px 10px; font-family: inherit; outline: none;
}
.workspace-field textarea { resize: vertical; min-height: 74px; }
.workspace-field input:focus, .workspace-field textarea:focus { border-color: #4D84CB; }
.workspace-evidence-row {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 9px 10px; border: 1px solid #222F44; border-radius: 9px; background: #141D33;
}
.workspace-evidence-dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 4px; flex-shrink: 0; background: #43C9CD; }
.workspace-evidence-row strong { display: block; font-size: 11px; color: #DCE6F2; }
.workspace-evidence-row small { font-size: 10px; color: #7A8AA0; line-height: 1.5; }
.ws-ask-btn {
  margin-left: auto; flex-shrink: 0; border: 1px solid #4D84CB; border-radius: 7px;
  background: transparent; color: #759FD7; font-size: 10.5px; padding: 4px 10px; cursor: pointer;
}
.ws-ask-btn:hover { background: #1E2A48; }
.workspace-panel-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 15px; border-top: 1px solid #222F44; background: #141D33;
}
.workspace-panel-footer span { font-size: 9.5px; color: #7A8AA0; }
.workspace-panel-footer > div { display: flex; gap: 7px; }
.workspace-primary, .workspace-secondary {
  border-radius: 8px; font-size: 11px; font-weight: 600; padding: 6px 13px; cursor: pointer;
}
.workspace-primary {
  border: 0; background: #4D84CB; color: #F1F5F9;
}
.workspace-primary:disabled, .workspace-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
.workspace-primary:hover:not(:disabled) { background: #3771BE; }
.workspace-secondary {
  border: 1px solid #2A3A55; background: transparent; color: #A3B3C8;
}
.workspace-secondary:hover { background: #1A2333; }
/* phrase4/5 终稿预览 */
.final-manuscript-workspace {
  flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 13px 15px; overflow: hidden;
}
.workspace-placeholder-label { font-size: 10px; letter-spacing: 0.1em; color: #7A8AA0; }
.final-manuscript-workspace h3 { margin: 0; font-size: 13.5px; color: #E8EEF7; }
.final-manuscript-meta { font-size: 10.5px; color: #5FD0B4; }
.final-manuscript-preview {
  flex: 1; min-height: 0; overflow: auto; cursor: pointer;
  border: 1px solid #222F44; border-radius: 9px; background: #141D33; padding: 10px 12px;
}
.final-manuscript-preview pre {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font-family: inherit; font-size: 11.5px; line-height: 1.7; color: #C3D2E5;
}
.final-manuscript-preview.is-loading { display: grid; place-items: center; color: #7A8AA0; font-size: 11px; }
.phase4-preview-empty {
  flex: 1; display: grid; place-items: center; text-align: center; color: #7A8AA0;
  font-size: 11px; padding: 20px; border: 1px dashed #2A3A55; border-radius: 9px;
}
.final-manuscript-actions { display: flex; gap: 8px; }
/* 普通节点详情 */
.node-panel-detail {
  flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px 15px;
}
.drawer-row { display: flex; gap: 8px; font-size: 11.5px; }
.drawer-row label { color: var(--muted); flex-shrink: 0; min-width: 50px; }
.drawer-row span { color: #DCE6F2; }
.drawer-artifact { font-size: 11px; color: #5FD0B4; background: #14281F; border-radius: 7px; padding: 5px 9px; }
.drawer-live-output {
  max-height: 120px; overflow: auto; padding: 8px 10px;
  background: #1A2438; border-left: 2px solid #7B9CE0; border-radius: 0 7px 7px 0;
  font-size: 11px; color: #A3B3C8; white-space: pre-wrap; word-break: break-word;
}
.drawer-hint { padding: 7px 9px; background: #1A2438; border-left: 2px solid #9aaaf0; font-size: 11px; color: #A3B3C8; }
.workspace-suggest { font-size: 10.5px; color: #E8B54A; background: #2A2414; border-radius: 7px; padding: 7px 10px; }
/* 全文弹层 */
.paper-preview-shell {
  position: absolute; inset: 0; z-index: 30; display: grid; place-items: center;
  background: rgba(4, 8, 16, 0.72); backdrop-filter: blur(2px);
}
.paper-preview-modal {
  width: min(640px, 86%); max-height: 80vh; display: flex; flex-direction: column;
  background: #141D33; border: 1px solid #2A3A55; border-radius: 12px; overflow: hidden;
}
.paper-preview-modal-header {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid #222F44;
}
.paper-preview-modal-header strong { font-size: 13px; color: #E8EEF7; }
.paper-preview-scroll { overflow: auto; padding: 16px; }
.paper-preview-scroll pre {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font-family: inherit; font-size: 12px; line-height: 1.75; color: #C3D2E5;
}

/* 窄容器(<880px): 对话与画布上下堆叠(须置于 .agent-panel 等规则之后才能覆盖) */
@media (max-width: 880px) {
  .quick-shell { flex-direction: column; overflow-y: auto; }
  .agent-panel { width: 100% !important; flex-shrink: 0; max-height: 46%; border-right: 0; border-bottom: 1px solid var(--line); }
  .workspace-stage { min-height: 320px; }
  .agent-flow-canvas { min-height: 320px; height: auto; }
  .node-drawer, .workspace-panel { top: auto; right: 8px; bottom: 8px; }
}
</style>
