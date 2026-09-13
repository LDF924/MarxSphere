<script setup lang="ts">
/**
 * QuickModeView — 课题流程编排画布(V415 重写)
 *
 * 旧实现的问题(2026-09-12 用户反馈): 节点写死 5 个 phrase + 4 个模块; 用户拖的连线只画不执行
 * (执行靠数组顺序 + 写死的 id→jobKind 字典); "暂停"只停前端 800ms 轮询而后端照跑;
 * 模板只有一个形态, 看不到 MarxSphere 的其余能力。
 *
 * 现在:
 *   节点来源 = /api/orchestrator/capabilities(100 项: 75 个 agent 工具 + 22 个工作台能力 + 特殊节点)
 *   执行     = 后端真 DAG(边=依赖本体, 拓扑执行, 上游产出按边流入下游的 {{inputs}})
 *   控制     = /api/orchestrator/control 的 pause/resume/cancel/input(后端真状态机)
 *   模板     = 10 条内置编排, 选中即作为起点自由改
 *   运行记录 = 后端落库(orchestrator_runs), 刷新/换设备可查
 */
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";
import AgentFlowCanvas from "./AgentFlowCanvas.vue";
import type { BizNode } from "./AgentFlowCanvas.vue";
import { useDraggablePanel } from "./useDraggablePanel";
import { toast } from "@/shared/ui";
import {
  fetchCapabilities, fetchTemplates, startRun, fetchProgress, controlRun, fetchRuns,
  listGraphs, loadGraph, saveGraph, deleteGraph, fetchAgentSetting, updateAgentSetting,
  RUN_STATUS_META, COST_META, stepStatusToNodeState,
  type OrchCapability, type OrchTemplate, type OrchProgress, type OrchRunRecord, type OrchGraph, type AgentOrchSetting,
} from "@/shared/orchApi";

// ── 状态 ──
const capabilities = ref<OrchCapability[]>([]);
const templates = ref<OrchTemplate[]>([]);
const loadingCaps = ref(true);
const templateId = ref("tpl_five_stage");
const graphName = ref("自定义编排");
const graphId = ref("");
const graphBasedOn = ref("");
const model = ref("");
const models = ref<string[]>([]);

const nodes = ref<BizNode[]>([]);
const userEdges = ref<Array<{ id: string; source: string; target: string }>>([]);
const runState = ref<"draft" | "running" | "waiting_input" | "paused" | "done" | "failed" | "cancelled">("draft");
const runId = ref("");
/**
 * V415: 本次运行的执行角色来源。后端按它决定工具角色(ui→manager / agent→analyst), 前端只做呈现。
 * 新启动的运行由我们自己知道; 轮询到的运行以后端返回的 runSource 为准(别人的/恢复出来的运行)。
 */
const runSource = ref<"ui" | "agent">("ui");
const progress = ref<OrchProgress | null>(null);
const finalText = ref("");

interface ChatMsg {
  id: number; role: "user" | "agent"; kind: "text" | "plan" | "node-update" | "artifact";
  time: string; text?: string;
  items?: Array<{ label: string; module?: string; nodeId: string }>;
  title?: string; statusLabel?: string; detail?: string;
  preview?: string; icon?: string; nodeId?: string;
}
let msgSeq = 0;
const messages = ref<ChatMsg[]>([]);
const input = ref("");
const chatScroll = ref<HTMLElement | null>(null);
function nowHM() { const n = new Date(); return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`; }
function pushMsg(p: Partial<ChatMsg> & { role: "user" | "agent" }) {
  messages.value.push({ id: ++msgSeq, kind: "text", time: nowHM(), ...p } as ChatMsg);
  setTimeout(() => { if (chatScroll.value) chatScroll.value.scrollTop = chatScroll.value.scrollHeight; }, 50);
}

// ── 能力面板 ──
const paletteCollapsed = ref(false);
const capQuery = ref("");
const capCategory = ref("");
const categories = computed(() => ["", ...Array.from(new Set(capabilities.value.map((c) => c.category)))]);
const filteredCaps = computed(() => {
  const q = capQuery.value.trim().toLowerCase();
  return capabilities.value.filter((c) => {
    if (capCategory.value && c.category !== capCategory.value) return false;
    if (!q) return true;
    return c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
  });
});

// ── 弹层 ──
const openTemplates = ref(false);
const openRuns = ref(false);
const openGraphs = ref(false);
/** V415: 自由创作节点弹层(标题 + 提示词) */
const openCreate = ref(false);
const createForm = ref({ title: "", task: "", system: "", maxTokens: "3000" });
function openCreateNode() {
  createForm.value = { title: "", task: "", system: "", maxTokens: "3000" };
  openCreate.value = true;
}
function addCustomNode() {
  const f = createForm.value;
  const title = f.title.trim();
  const task = f.task.trim();
  if (!title) { toast("给节点起个名字", "error"); return; }
  if (!task) { toast("写清楚这一步要做什么(提示词)", "error"); return; }
  const id = nextNodeId("custom");
  nodes.value = [...nodes.value, {
    id,
    title,
    module: "创作",
    index: String(nodes.value.length + 1).padStart(2, "0"),
    state: "draft",
    stateLabel: "待执行",
    input: "上游产出",
    output: "text",
    // 刻意**不设** capabilityId: 后端对没有能力绑定的节点走 llm_chat 兜底,
    // 提示词就是它的全部语义(见 capability-registry.dagNodeToMetaStep)。
    params: cleanParams({ task, system: f.system.trim() || undefined, maxTokens: f.maxTokens }) as Record<string, unknown>,
    canvasPosition: { x: 40 + (nodes.value.length % 5) * 240, y: 50 + Math.floor(nodes.value.length / 5) * 235 },
  }];
  openCreate.value = false;
  toast(`已添加「${title}」`, "success");
}
const runs = ref<OrchRunRecord[]>([]);
const myGraphs = ref<Awaited<ReturnType<typeof listGraphs>>>([]);

function capById(id?: string) { return id ? capabilities.value.find((c) => c.id === id) : undefined; }

/** 画布实例(用于"加完节点把它带进视野") —— 组件那边 expose 了 fitView */
const canvasRef = ref<InstanceType<typeof AgentFlowCanvas> | null>(null);
function fitCanvas() {
  try { (canvasRef.value as unknown as { fitView?: () => void } | null)?.fitView?.(); } catch { /* 画布还没挂载就算了 */ }
}

/** 依赖分层布局: 深度=x 同层=y —— 并联分支上下排开, 比旧的"两行"布局更能看出 DAG 形状 */
function autoLayout(ids: string[], edges: Array<{ source: string; target: string }>) {
  const depth = new Map<string, number>(ids.map((i) => [i, 0]));
  for (let iter = 0; iter < ids.length; iter++) {
    let changed = false;
    for (const e of edges) {
      const d = (depth.get(e.source) ?? 0) + 1;
      if (d > (depth.get(e.target) ?? 0)) { depth.set(e.target, d); changed = true; }
    }
    if (!changed) break;
  }
  const byDepth = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(id);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, list] of byDepth) list.forEach((id, i) => pos.set(id, { x: d * 240 + 40, y: i * 235 + 50 }));
  return pos;
}

/** 能力的默认参数: 用能力自带的默认值填充(不是空字段 —— 空参数会把节点做空) */
function defaultParams(cap: OrchCapability): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of cap.fields ?? []) out[f.name] = f.default ?? "";
  return out;
}

/** 当前画布的成本量级(与后端 estimateGraphCost 同一判据, 前端即时反馈) */
const graphCost = computed(() => {
  let heavy = 0, medium = 0;
  for (const n of nodes.value) {
    const c = capById(n.capabilityId);
    const cost = c?.cost ?? "medium";
    if (cost === "heavy") heavy++;
    else if (cost === "medium") medium++;
  }
  if (heavy >= 2) return "heavy" as const;
  if (heavy === 1 || medium >= 3) return "medium" as const;
  return "light" as const;
});

function loadGraphInto(nodesIn: OrchGraph["nodes"], edgesIn: OrchGraph["edges"], name: string, basedOn?: string, id?: string) {
  const pos = autoLayout(nodesIn.map((n) => n.id), edgesIn);
  nodes.value = nodesIn.map((n, i) => {
    const cap = capById(n.capabilityId);
    return {
      id: n.id,
      title: n.title || cap?.label || n.id,
      module: cap?.category ?? "自定义",
      index: String(i + 1).padStart(2, "0"),
      state: "draft",
      stateLabel: "待执行",
      input: cap?.inputs.join(" / ") || "上游产出",
      output: cap?.outputs.join(" / ") || "text",
      capabilityId: n.capabilityId,
      params: n.params ? { ...n.params } : (cap ? defaultParams(cap) : undefined),
      artifact: cap?.artifact,
      canvasPosition: pos.get(n.id),
    } as BizNode;
  });
  userEdges.value = edgesIn.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target }));
  graphName.value = name;
  graphId.value = id ?? "";
  graphBasedOn.value = basedOn ?? "";
  runState.value = "draft";
  runId.value = "";
  progress.value = null;
  finalText.value = "";
  lastDone = new Set();
  waitFields.value = [];
  selectedNode.value = null;
}

async function applyTemplate(id: string) {
  const t = templates.value.find((x) => x.id === id);
  if (!t) return;
  templateId.value = id;
  loadGraphInto(t.graph.nodes, t.graph.edges, t.name, t.id);
  pushMsg({ role: "agent", text: `已载入模板「${t.name}」: ${t.description}\n画布上的节点与连线都可自由增删改 —— 改完点「开始执行」。` });
}

// ── 节点操作 ──
const selectedNode = ref<BizNode | null>(null);
const nodeForm = ref<Record<string, string>>({});
const selectedCap = computed(() => capById(selectedNode.value?.capabilityId));
const paramFields = computed(() => selectedCap.value?.fields ?? []);
/** V415: 某节点在这张图里的入边条数(= 直接依赖数)。连线是唯一依据, 不另存一份依赖关系。 */
function depCountOf(id: string): number { return userEdges.value.filter((e) => e.target === id).length; }

function onNodeSelected(n: BizNode) {
  selectedNode.value = n;
  const f: Record<string, string> = {};
  for (const [k, v] of Object.entries(n.params ?? {})) f[k] = typeof v === "string" ? v : JSON.stringify(v);
  nodeForm.value = f;
}

function nextNodeId(base: string) {
  const clean = base.replace(/[^\w-]/g, "_") || "node";
  let id = clean;
  let i = 1;
  while (nodes.value.some((n) => n.id === id)) id = `${clean}_${++i}`;
  return id;
}

/**
 * V415(2026-09-13 用户反馈"点击能力节点的加号时并没有出现新的节点"):
 * 老算法是 `x = 40 + (len % 5) * 240, y = 50 + floor(len / 5) * 235` —— 纯按节点数算的全局网格,
 * **与当前视野无关**。节点一多、或图被 fitView 缩放过, 新节点就落到可视区外, 看着像"没加上"。
 *
 * 注意这里用的是 **flow 坐标**(画布内有缩放/平移), 不是容器像素 —— 两者不能混算。
 * 所以策略是: ①贴着已有节点右边找个空格放; ②放完让画布 fitView 把新节点带进视野(见 addCapability)。
 */
function nextFreePosition(existing: BizNode[]): { x: number; y: number } {
  const CELL_X = 215, CELL_Y = 205;
  if (!existing.length) return { x: 40, y: 50 };
  const occupied = new Set(
    existing.map((n) => `${Math.round((n.canvasPosition?.x ?? 0) / CELL_X)},${Math.round((n.canvasPosition?.y ?? 0) / CELL_Y)}`),
  );
  // 从最右下的节点开始往右找, 到头换行往下 —— 保证贴着已有内容, 不会离得老远
  const maxX = Math.max(...existing.map((n) => n.canvasPosition?.x ?? 0));
  const maxY = Math.max(...existing.map((n) => n.canvasPosition?.y ?? 0));
  for (let r = 0; r < 40; r++) {
    for (let c = 0; c < 40; c++) {
      const x = 40 + c * CELL_X;
      const y = 50 + r * CELL_Y;
      if (x < maxX || y < maxY) continue;          // 只在已有内容的右下方找
      if (!occupied.has(`${Math.round(x / CELL_X)},${Math.round(y / CELL_Y)}`)) return { x, y };
    }
  }
  return { x: maxX + CELL_X, y: maxY };
}

function addCapability(cap: OrchCapability, position?: { x: number; y: number }) {
  const id = nextNodeId(cap.id);
  const pos = position ?? nextFreePosition(nodes.value);
  nodes.value = [...nodes.value, {
    id,
    title: cap.label,
    module: cap.category,
    index: String(nodes.value.length + 1).padStart(2, "0"),
    state: "draft",
    stateLabel: "待执行",
    input: cap.inputs.join(" / ") || "上游产出",
    output: cap.outputs.join(" / "),
    capabilityId: cap.id,
    params: defaultParams(cap),
    artifact: cap.artifact,
    canvasPosition: pos,
  }];
  // 加完把画布缩放到"全部可见" —— 否则节点可能落在当前视野外, 用户以为没加上。
  // 时序: nextTick 只是 DOM 更新完, vue-flow 内部还没量到新节点的尺寸(它异步测量),
  // 此时 fitView 算的还是旧集合。所以要等两帧再 fit(实测一帧不够)。
  void nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => fitCanvas())));
  toast(`已添加「${cap.label}」`, "success");
}

function removeNode(id: string) {
  if (locked.value) return;
  nodes.value = nodes.value.filter((n) => n.id !== id);
  userEdges.value = userEdges.value.filter((e) => e.source !== id && e.target !== id);
  if (selectedNode.value?.id === id) selectedNode.value = null;
  toast("节点已移除", "success");
}

function onCapabilityDropped(p: { capabilityId: string; position: { x: number; y: number } }) {
  const cap = capById(p.capabilityId);
  if (cap) addCapability(cap, p.position);
}
function onNodesMoved(p: { id: string; position: { x: number; y: number } }) {
  nodes.value = nodes.value.map((n) => (n.id === p.id ? { ...n, canvasPosition: p.position } : n));
}
function onGraphChanged(payload: { edges: Array<{ id: string; source: string; target: string }> }) {
  // 画布只上报"用户新连/删掉的边"; 边是真源在这里(见 AgentFlowCanvas 的 buildLayout 说明)
  userEdges.value = (payload.edges ?? []).map((e) => ({ id: e.id, source: e.source, target: e.target }));
}

function saveNodeParams() {
  const n = selectedNode.value;
  if (!n) return;
  nodes.value = nodes.value.map((x) => (x.id === n.id ? { ...x, params: { ...nodeForm.value } } : x));
  selectedNode.value = { ...n, params: { ...nodeForm.value } };
  // V415: 参数只改内存 = 刷新就丢。用户点"保存"的预期是"存下来了", 所以这里顺手落库 ——
  // 只在已经有图 id 时写(没存过的图没有 id, 那时提示用户去"我的编排"保存一次)。
  void persistParamsNow();
}
/** 把当前画布(含刚改的参数)落库; 失败只提示不阻断编辑 */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
async function persistParamsNow() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    if (!graphId.value) { toast("节点参数已保存(草稿在内存里)。要持久化请到「我的编排」保存当前画布", "success"); return; }
    try {
      await saveGraph(graphId.value, { ...graphPayload(), id: graphId.value, name: graphName.value });
      toast("节点参数已保存并落库", "success");
    } catch (e) {
      toast(`参数已改但落库失败: ${(e as Error).message}`, "error");
    }
  }, 400);
}

// ── 右键菜单 ──
const ctxMenu = ref<{ x: number; y: number; nodeId?: string; nodeTitle?: string } | null>(null);
const locked = computed(() => runState.value === "running" || runState.value === "waiting_input");
function onPaneContextMenu(p: { event: MouseEvent; position: { x: number; y: number } }) {
  if (locked.value) return;
  ctxMenu.value = { x: p.position.x, y: p.position.y };
}
function onNodeContextMenu(p: { event: MouseEvent; position: { x: number; y: number }; node: BizNode }) {
  if (locked.value) return;
  ctxMenu.value = { x: p.position.x, y: p.position.y, nodeId: p.node.id, nodeTitle: p.node.title };
}
/** V415: 卡片右上角 ••• —— 与右键同一份菜单(右键那条路在触屏/触控板上不好用) */
function onNodeMenu(p: { event: MouseEvent; position: { x: number; y: number }; node: BizNode }) {
  if (locked.value) return;
  ctxMenu.value = { x: p.position.x, y: p.position.y, nodeId: p.node.id, nodeTitle: p.node.title };
}
/** V415: 选中小红叉删节点(画布上的直观入口, 不用记右键) */
function onNodeDelete(p: { id: string }) { removeNode(p.id); }
function closeCtxMenu() { ctxMenu.value = null; }

// ── 运行 ──
/** 去掉空参数 —— 空串会覆盖能力默认模板, 等于把节点做空 */
function cleanParams(p?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!p) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) { if (v !== "" && v !== undefined && v !== null) out[k] = v; }
  return Object.keys(out).length ? out : undefined;
}
function graphPayload(): OrchGraph {
  return {
    id: graphId.value || undefined,
    name: graphName.value,
    description: `画布编排 · ${nodes.value.length} 节点`,
    basedOn: graphBasedOn.value || undefined,
    nodes: nodes.value.map((n) => ({ id: n.id, capabilityId: n.capabilityId, title: n.title, params: cleanParams(n.params) })),
    edges: userEdges.value.map((e) => ({ source: e.source, target: e.target })),
  };
}

async function startExecution() {
  if (locked.value) return;
  if (!nodes.value.length) { toast("画布是空的: 先从左侧能力面板拖节点进来, 或选一个模板", "error"); return; }
  try {
    const r = await startRun({ graph: graphPayload(), text: graphName.value, model: model.value || undefined });
    runId.value = r.runId;
    runSource.value = "ui";   // 画布上手动启动 = manager 权限(后端同一口径)
    runState.value = "running";
    lastDone = new Set();
    pushMsg({ role: "user", text: "开始执行" });
    pushMsg({
      role: "agent", kind: "plan",
      items: r.order.map((sid) => {
        const n = nodes.value.find((x) => x.id === sid);
        return { label: n?.title ?? sid, module: n?.module ?? "", nodeId: sid };
      }),
    });
    pushMsg({ role: "agent", text: `已启动, 共 ${r.steps} 个节点。执行顺序由连线决定, 上游产出会流入下游。` });
    startPoll(r.runId);
  } catch (e) {
    runState.value = "failed";
    pushMsg({ role: "agent", text: `启动失败: ${(e as Error).message}` });
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastDone = new Set<string>();
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function startPoll(id: string) {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const p = await fetchProgress(id);
      if (p.ok) applyProgress(p);
    } catch { /* 容忍单次失败 */ }
  }, 1200);
}

function applyProgress(p: OrchProgress) {
  progress.value = p;
  if (p.status !== "unknown") runState.value = p.status as typeof runState.value;
  // 后端是角色的权威(可能是 Agent 触发的, 也可能是恢复出来的旧运行), 有值就以后端为准
  if (p.runSource) runSource.value = p.runSource;

  const byStep = new Map(p.stepLog.map((s) => [s.stepId, s]));
  nodes.value = nodes.value.map((n) => {
    const s = byStep.get(n.id);
    if (!s) return n;
    const outLen = (s.output ?? "").replace(/\s/g, "").length;
    return {
      ...n,
      state: stepStatusToNodeState(s.status),
      stateLabel: s.status === "done" ? "已完成" : s.status === "running" ? "执行中" : s.status === "failed" ? "执行失败" : s.status === "waiting_input" ? "等待输入" : "待执行",
      progress: s.status === "done" ? 100 : s.status === "running" ? 50 : undefined,
      artifactCount: s.status === "done" && outLen ? outLen : undefined,
      outputPreview: s.status === "done" ? (s.output ?? "").slice(0, 120) : undefined,
      executionDetail: s.inputsFrom?.length ? `← 依赖 ${s.inputsFrom.join(" + ")}` : undefined,
    };
  });

  for (const s of p.stepLog) {
    if (s.status === "done" && !lastDone.has(s.stepId)) {
      lastDone.add(s.stepId);
      const n = nodes.value.find((x) => x.id === s.stepId);
      const len = (s.output ?? "").replace(/\s/g, "").length;
      pushMsg({
        role: "agent", kind: "node-update",
        title: n?.title ?? s.label ?? s.stepId,
        statusLabel: "已完成",
        detail: `${len} 字`,
        preview: (s.output ?? "").slice(0, 140) || undefined,
        nodeId: s.stepId,
      });
    }
  }

  if (p.status === "waiting_input") {
    const w = p.stepLog.find((s) => s.status === "waiting_input");
    if (w?.waitingFields?.length) {
      waitFields.value = w.waitingFields;
      const v: Record<string, string> = {};
      for (const f of w.waitingFields) v[f.name] = waitValues.value[f.name] ?? "";
      waitValues.value = v;
    }
  } else {
    waitFields.value = [];
  }

  if (["done", "failed", "cancelled"].includes(p.status)) {
    stopPoll();
    const last = p.stepLog[p.stepLog.length - 1];
    finalText.value = last ? (p.outputs?.[last.stepId] ?? "") : "";
    if (p.status === "done") {
      pushMsg({ role: "agent", kind: "artifact", icon: "📄", title: "编排完成", detail: `共 ${p.stepLog.filter((s) => s.status === "done").length} 个节点完成`, nodeId: last?.stepId });
    } else if (p.status === "failed") {
      const bad = p.stepLog.find((s) => s.status === "failed");
      pushMsg({ role: "agent", text: `执行失败: ${bad?.error ?? "未知原因"}。可修正节点参数后重新开始。` });
    }
  }
}

// ── 等待输入(后端真挂起) ──
const waitFields = ref<Array<{ name: string; prompt: string; required: boolean }>>([]);
const waitValues = ref<Record<string, string>>({});
const waitingStep = computed(() => waitFields.value.length > 0);
async function submitWaitInput() {
  if (!runId.value) return;
  const missing = waitFields.value.filter((f) => f.required && !(waitValues.value[f.name] ?? "").trim());
  if (missing.length) { toast(`还需填写: ${missing.map((f) => f.prompt).join("、")}`, "error"); return; }
  try {
    await controlRun(runId.value, "input", waitValues.value);
    pushMsg({ role: "user", text: Object.entries(waitValues.value).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n") });
    waitFields.value = [];
  } catch (e) { toast(`提交失败: ${(e as Error).message}`, "error"); }
}

// ── 控制 ──
async function pauseRun() {
  if (!runId.value) return;
  try { await controlRun(runId.value, "pause"); pushMsg({ role: "agent", text: "已暂停。已完成节点的产出保留, 恢复时从下一个未完成节点继续。" }); }
  catch (e) { toast(`暂停失败: ${(e as Error).message}`, "error"); }
}
async function resumeRun() {
  if (!runId.value) return;
  try { await controlRun(runId.value, "resume"); pushMsg({ role: "agent", text: "已恢复执行。" }); startPoll(runId.value); }
  catch (e) { toast(`恢复失败: ${(e as Error).message}`, "error"); }
}
async function cancelRun() {
  if (!runId.value) return;
  try { await controlRun(runId.value, "cancel"); stopPoll(); pushMsg({ role: "agent", text: "已取消本次编排。" }); }
  catch (e) { toast(`取消失败: ${(e as Error).message}`, "error"); }
}
function resetCanvas() {
  if (locked.value) return;
  runState.value = "draft"; runId.value = ""; runSource.value = "ui"; progress.value = null; finalText.value = "";
  lastDone = new Set(); waitFields.value = [];
  nodes.value = nodes.value.map((n) => ({ ...n, state: "draft", stateLabel: "待执行", progress: undefined, artifactCount: undefined, outputPreview: undefined, executionDetail: undefined }));
}

// ── 左右拉伸: 能力面板宽度(记忆到 localStorage) ──
const PALETTE_MIN = 180;
const PALETTE_MAX = 560;
const paletteWidth = ref(Number(localStorage.getItem("orch_palette_w")) || 246);
const splitting = ref(false);
function startSplit(ev: PointerEvent) {
  if (ev.button !== 0) return;
  splitting.value = true;
  const startX = ev.clientX;
  const startW = paletteWidth.value;
  const move = (e: PointerEvent) => {
    // 面板在左侧: 向右拖 = 变宽。夹在 [180, 560] 防止拖成 0 宽或吃掉整个画布。
    paletteWidth.value = Math.min(PALETTE_MAX, Math.max(PALETTE_MIN, startW + (e.clientX - startX)));
  };
  const up = () => {
    splitting.value = false;
    localStorage.setItem("orch_palette_w", String(paletteWidth.value));
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  ev.preventDefault();
}

/**
 * V415: 编排助手(最左)的宽度, 与上面那个是**两件独立的事**
 * (用户指出"编排助手与能力节点之间不能左右拉伸" —— 那一段当时根本没收拉伸条)。
 * 助手更宽有用: 它的对话/计划消息比较长。
 */
const AGENT_MIN = 200;
const AGENT_MAX = 560;
const agentWidth = ref(Number(localStorage.getItem("orch_agent_w")) || 0);
const splitAgent = ref(false);
/** 没存过宽度时用旧样式的 clamp(240, 28%, 310) 兜底 —— 保持首屏观感不变 */
const agentPanelWidth = computed(() => {
  if (agentWidth.value) return `${agentWidth.value}px`;
  const host = (typeof document !== "undefined" ? document.querySelector(".quick-shell") : null) as HTMLElement | null;
  const w = host?.clientWidth ?? 1400;
  return `${Math.min(310, Math.max(240, Math.round(w * 0.28)))}px`;
});
function startSplitAgent(ev: PointerEvent) {
  if (ev.button !== 0) return;
  splitAgent.value = true;
  const startX = ev.clientX;
  const startW = Number(agentWidth.value) || parseFloat(agentPanelWidth.value) || 260;
  const move = (e: PointerEvent) => {
    agentWidth.value = Math.min(AGENT_MAX, Math.max(AGENT_MIN, startW + (e.clientX - startX)));
  };
  const up = () => {
    splitAgent.value = false;
    localStorage.setItem("orch_agent_w", String(agentWidth.value));
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  ev.preventDefault();
}

// ── 模板/图/记录 ──
async function loadRuns() { runs.value = await fetchRuns(30); }
async function loadMyGraphs() { myGraphs.value = await listGraphs(); }
async function openGraph(id: string) {
  const g = await loadGraph(id);
  if (!g) { toast("读取失败", "error"); return; }
  loadGraphInto(g.nodes, g.edges, g.name || "自定义编排", g.basedOn, id);
  openGraphs.value = false;
  pushMsg({ role: "agent", text: `已打开「${g.name}」。` });
}
async function persistGraph() {
  if (!nodes.value.length) { toast("画布为空, 无可保存内容", "error"); return; }
  const id = graphId.value || `g-${Date.now().toString(36)}`;
  try {
    await saveGraph(id, { ...graphPayload(), id, name: graphName.value });
    graphId.value = id;
    await loadMyGraphs();
    toast("编排已保存", "success");
  } catch (e) { toast(`保存失败: ${(e as Error).message}`, "error"); }
}
async function removeGraph(id: string) {
  try { await deleteGraph(id); await loadMyGraphs(); toast("已删除", "success"); }
  catch (e) { toast(String((e as Error).message), "error"); }
}
function viewArtifact(where: string) {
  // 产物落在别的 tab: 通过 postMessage 请 React 壳切视图(iframe 内不能直接改父级路由)
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ source: "marxsphere-soc", type: "navigate", view: where }, "*");
  }
  toast(`产物在「${where}」工作台`, "success");
}

// ── V415: Agent 编排开关(用户可见可切) ──
const agentSetting = ref<AgentOrchSetting | null>(null);
const openSettings = ref(false);
const savingSetting = ref(false);
async function loadAgentSetting() {
  try { agentSetting.value = await fetchAgentSetting(); } catch { agentSetting.value = null; }
}
async function toggleAgentEnabled(v: boolean) {
  savingSetting.value = true;
  try {
    agentSetting.value = await updateAgentSetting({ enabled: v });
    toast(v ? "已允许 Agent 触发编排" : "已关闭 Agent 编排", "success");
  } catch (e) {
    toast(`设置失败: ${(e as Error).message}`, "error");
    await loadAgentSetting();
  } finally { savingSetting.value = false; }
}

// ── 初始化 ──
onMounted(async () => {
  await loadAgentSetting();
  try {
    const [caps, tpls] = await Promise.all([fetchCapabilities(), fetchTemplates()]);
    capabilities.value = caps.capabilities;
    templates.value = tpls;
    pushMsg({
      role: "agent",
      text: `编排画布就绪: 可用能力 ${caps.stats.total} 项(${Object.entries(caps.stats.byKind).map(([k, v]) => `${k} ${v}`).join(" · ")}), 内置模板 ${tpls.length} 条。\n从左侧拖节点到画布, 连线决定执行顺序与数据流向。`,
    });
    if (tpls.length) await applyTemplate(templateId.value);
  } catch (e) {
    pushMsg({ role: "agent", text: `初始化失败: ${(e as Error).message}` });
  } finally { loadingCaps.value = false; }
  try {
    const r = await fetch("/api/editor/v1/ai/model", { headers: { Authorization: `Bearer ${localStorage.getItem("sag_token") ?? ""}` } }).then((x) => x.json());
    models.value = r?.models ?? [];
  } catch { /* 模型列表不可用 → 只用默认 */ }
});

onUnmounted(stopPoll);

const runMeta = computed(() => RUN_STATUS_META[runState.value] ?? { label: runState.value, cls: "" });
const completedCount = computed(() => nodes.value.filter((n) => n.state === "completed").length);
const runMetaOf = (s: string) => RUN_STATUS_META[s] ?? { label: s, cls: "" };
/**
 * V415: 节点大卡片可拖动 —— 原来钉在画布右上角, 挡着节点也挪不开。
 *
 * 坐标系: 面板的 left/top 相对**画布容器**(.workspace-stage, position:relative),
 * 所以默认位置与拖动边界都按容器算, 不能按视口 —— 踩过: 按视口算时面板在窄窗口里
 * 直接落到容器右边界之外(实测 1600 宽时跑到 x=1793, 屏幕外), 鼠标够不到, 看着像"拖不动"。
 */
const nodePanel = useDraggablePanel(
  "orch_node_panel_pos",
  () => {
    const host = document.querySelector(".workspace-stage") as HTMLElement | null;
    const w = host?.clientWidth ?? 900;
    return { x: Math.max(8, w - 356), y: 42 };
  },
  () => {
    const host = document.querySelector(".workspace-stage") as HTMLElement | null;
    return { w: host?.clientWidth ?? window.innerWidth, h: host?.clientHeight ?? window.innerHeight };
  },
);
/** V415: 运行记录展开后的步骤状态文案(stepLog 用的是步骤状态机, 与运行状态不同名) */
const openRunId = ref("");
const STEP_LABEL: Record<string, string> = {
  done: "完成", running: "执行中", failed: "失败", pending: "待执行", waiting_input: "等待输入",
};
const stepLabel = (s: string) => STEP_LABEL[s] ?? s;
</script>

<template>
  <div class="quick-view">
    <header class="quick-header">
      <div class="brand-lockup">
        <div class="brand-mark">Q</div>
        <div>
          <h1>课题流程编排</h1>
          <p>{{ nodes.length }} 节点 · {{ runMeta.label }} · 已完成 {{ completedCount }}/{{ nodes.length }} · 可用能力 {{ capabilities.length }} 项</p>
        </div>
      </div>
      <!-- V415: 成本量级 + Agent 编排开关状态 —— 一眼可见, 不用点开弹层 -->
      <div class="header-flags">
        <span class="cost-chip" :class="COST_META[graphCost].cls" :title="'按节点能力推算的量级: ' + COST_META[graphCost].label">
          成本 {{ COST_META[graphCost].label }}
        </span>
        <!-- V415: 当前运行的执行角色。外部 Agent 触发的运行只有 analyst 权限, 写类能力会被拦 ——
             这一条是用户看到"为什么这个节点起不来"的答案, 所以常驻在顶部而不是藏在节点里。 -->
        <span
          v-if="runSource === 'agent'"
          class="role-chip"
          title="本次编排由 AI 对话里的 Agent 触发, 以 analyst 权限执行: 写类能力(文件写入/代码沙箱/入库)会被权限拦下。要跑这些能力请在画布上手动启动。"
        >analyst 权限</span>
        <span
          v-else-if="runId"
          class="role-chip is-manager"
          title="本次编排由你在画布上启动, 以 manager 权限执行: 全部能力可用(含文件写入/代码沙箱/入库)。"
        >manager 权限</span>
        <button
          class="agent-chip"
          :class="{ 'is-on': agentSetting?.enabled }"
          :title="agentSetting?.enabled ? 'AI 对话里的 Agent 可以触发编排(点击设置)' : 'AI 对话里的 Agent 不能触发编排(点击设置)'"
          @click="openSettings = true"
        >
          <span class="agent-dot"></span>Agent 编排{{ agentSetting?.enabled ? "已开" : "已关" }}
        </button>
      </div>
      <div class="header-tools">
        <select v-model="templateId" class="hdr-select" :disabled="locked" @change="applyTemplate(templateId)">
          <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
        <select v-model="model" class="hdr-select" :disabled="locked">
          <option value="">默认模型</option>
          <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
        </select>
        <button class="hdr-btn" :disabled="locked" @click="openTemplates = true">模板库</button>
        <button class="hdr-btn" @click="openRuns = true; loadRuns()">运行记录</button>
        <button class="hdr-btn" :disabled="locked" @click="openGraphs = true; loadMyGraphs()">我的编排</button>
        <button class="hdr-btn" @click="openSettings = true">设置</button>
      </div>
    </header>

    <main class="quick-shell">
      <!-- 左: 对话 -->
      <aside class="agent-panel" :class="{ 'is-resized': !!agentWidth }" :style="{ width: agentPanelWidth }">
        <div class="agent-panel-header">
          <div class="agent-avatar">Q</div>
          <div>
            <strong>编排助手</strong>
            <span class="agent-status">● 在线</span>
          </div>
        </div>
        <div class="agent-context">
          <span class="ctx-label">当前编排</span>
          <strong>{{ graphName }}</strong>
          <span class="state-chip" :class="runMeta.cls">{{ runMeta.label }}</span>
        </div>
        <div ref="chatScroll" class="conversation-stream">
          <article v-for="m in messages" :key="m.id" class="message" :class="'is-' + m.role">
            <div v-if="m.role === 'agent'" class="msg-avatar">Q</div>
            <div class="msg-body">
              <div class="msg-meta">
                <strong>{{ m.role === "agent" ? "编排助手" : "你" }}</strong>
                <span>{{ m.time }}</span>
              </div>
              <div class="msg-content">
                <p v-if="m.text">{{ m.text }}</p>
                <div v-if="m.kind === 'node-update'" class="node-update-card">
                  <div class="nu-head"><strong>{{ m.title }}</strong><span>{{ m.statusLabel }}</span></div>
                  <div v-if="m.detail" class="nu-detail"><strong>产出</strong><span>{{ m.detail }}</span></div>
                  <p v-if="m.preview" class="nu-preview">{{ m.preview }}</p>
                </div>
                <div v-if="m.kind === 'plan'" class="plan-card">
                  <div class="plan-card-head"><span class="card-icon">✦</span><strong>执行计划</strong><span>{{ m.items?.length ?? 0 }} 个节点</span></div>
                  <div v-for="it in m.items ?? []" :key="it.nodeId" class="plan-item">
                    <span class="plan-check" :class="'is-' + (nodes.find((n) => n.id === it.nodeId)?.state === 'completed' ? 'done' : 'todo')">{{ nodes.find((n) => n.id === it.nodeId)?.state === 'completed' ? '✓' : '' }}</span>
                    <span>{{ it.label }}</span>
                    <small>{{ it.module }}</small>
                  </div>
                </div>
                <div v-if="m.kind === 'artifact'" class="artifact-card">
                  <div class="artifact-icon">{{ m.icon || "📄" }}</div>
                  <div class="artifact-body">
                    <strong>{{ m.title }}</strong>
                    <p>{{ m.detail }}</p>
                  </div>
                </div>
              </div>
            </div>
          </article>
        </div>
        <div class="composer">
          <textarea v-model="input" rows="2" placeholder="描述研究需求…(节点与连线决定实际执行)" @keydown.enter.exact.prevent="pushMsg({ role: 'user', text: input }); input = ''"></textarea>
          <button class="send-button" :disabled="!input.trim()" @click="pushMsg({ role: 'user', text: input }); input = ''">↗</button>
        </div>
        <div class="run-actions">
          <button v-if="runState === 'draft'" class="run-btn" @click="startExecution">开始执行</button>
          <template v-else-if="runState === 'running'">
            <button class="run-btn pause" @click="pauseRun">暂停</button>
            <button class="run-btn danger" @click="cancelRun">取消</button>
          </template>
          <template v-else-if="runState === 'waiting_input'">
            <button class="run-btn danger" @click="cancelRun">取消</button>
          </template>
          <template v-else-if="runState === 'paused'">
            <button class="run-btn" @click="resumeRun">恢复</button>
            <button class="run-btn danger" @click="cancelRun">取消</button>
          </template>
          <template v-else>
            <button class="run-btn" @click="resetCanvas">重新开始</button>
          </template>
        </div>
      </aside>

      <!-- V415: 助手 ↔ 能力节点 之间的拉伸条(用户指出这里也拉不动) -->
      <div
        class="pane-splitter"
        :class="{ 'is-dragging': splitAgent }"
        title="拖动调整编排助手宽度"
        @pointerdown="startSplitAgent"
      ></div>

      <!-- 中: 能力面板(拖到画布即建节点) -->
      <aside v-if="!paletteCollapsed" class="palette-panel" :style="{ width: paletteWidth + 'px' }">
        <header class="palette-head">
          <strong>能力节点</strong>
          <input v-model="capQuery" class="palette-search" placeholder="搜索能力…" />
          <button class="palette-toggle" title="收起" @click="paletteCollapsed = true">«</button>
        </header>
        <!-- V415: 自由创作节点 —— 平台里没有现成能力、但用户就是想加一步"按我的提示词做点事"时用。
             后端把没有 capabilityId 的节点当 llm_chat 执行(见 capability-registry 的 dagNodeToMetaStep),
             所以这里不需要新端点, 只需要一个能填标题+提示词的入口。 -->
        <button v-if="!locked" class="palette-create" @click="openCreateNode">＋ 创作能力节点</button>
        <div class="palette-cats">
          <button v-for="c in categories" :key="c" class="palette-cat" :class="{ 'is-on': capCategory === c }" @click="capCategory = c">{{ c || "全部" }}</button>
        </div>
        <div class="palette-list">
          <div v-if="loadingCaps" class="palette-empty">正在加载能力表…</div>
          <div v-else-if="!filteredCaps.length" class="palette-empty">没有匹配的能力</div>
          <div
            v-for="c in filteredCaps"
            :key="c.id"
            class="palette-item"
            draggable="true"
            :title="c.description + '（双击或点 + 添加）'"
            @dragstart="(e) => (e as DragEvent).dataTransfer?.setData('application/x-orch-capability', c.id)"
            @dblclick="addCapability(c)"
          >
            <div class="pi-main">
              <strong>{{ c.label }}</strong>
              <small>{{ c.description }}</small>
            </div>
            <span v-if="c.risk !== 'safe'" class="pi-risk" :title="'风险等级: ' + c.risk">需审批</span>
            <span v-else class="pi-cat">{{ c.category }}</span>
            <button class="pi-add" title="添加到画布" @click="addCapability(c)">＋</button>
          </div>
        </div>
      </aside>
      <button v-else class="palette-expand" title="展开能力面板" @click="paletteCollapsed = false">能力 »</button>

      <!-- V415: 左右拉伸条 —— 能力面板写死 246px 时, 长能力名被截断、画布又空着, 用户没法调 -->
      <div
        v-if="!paletteCollapsed"
        class="pane-splitter"
        :class="{ 'is-dragging': splitting }"
        title="拖动调整能力面板宽度"
        @pointerdown="startSplit"
      ></div>

      <!-- 右: 画布 -->
      <section class="workspace-stage">
        <AgentFlowCanvas
          ref="canvasRef"
          :nodes="nodes"
          :edges="userEdges"
          :editable="!locked"
          :locked="locked"
          @node-selected="onNodeSelected"
          @graph-changed="onGraphChanged"
          @pane-context-menu="onPaneContextMenu"
          @node-context-menu="onNodeContextMenu"
          @node-menu="onNodeMenu"
          @node-delete="onNodeDelete"
          @nodes-moved="onNodesMoved"
          @capability-dropped="onCapabilityDropped"
        />

        <div v-if="!nodes.length && !loadingCaps" class="canvas-start-gate">
          <div class="gate-mark">00</div>
          <div class="gate-copy">
            <strong>画布是空的</strong>
            <span>从左侧「能力节点」拖一个节点进来, 或在顶部选一个模板作为起点。连线决定执行顺序与数据流向。</span>
          </div>
        </div>
        <div v-else-if="locked" class="canvas-locked-banner">
          {{ runState === "waiting_input" ? "等待补充信息 · 画板已锁定" : "执行中 · 画板已锁定" }}
        </div>
        <div v-else class="canvas-hint-banner">拖动节点调整位置 · 从节点右侧圆点拖到另一节点左侧即建立依赖</div>

        <!-- 等待输入(后端真挂起) -->
        <div v-if="waitingStep" class="input-overlay">
          <div class="input-card">
            <header>
              <strong>需要补充信息后继续</strong>
              <span>后端已挂起本次运行, 提交后从当前节点继续</span>
            </header>
            <div class="input-body">
              <label v-for="f in waitFields" :key="f.name" class="workspace-field">
                <span>{{ f.prompt || f.name }}<b v-if="f.required"> *</b></span>
                <input v-model="waitValues[f.name]" :placeholder="f.prompt || f.name" />
              </label>
            </div>
            <footer><button class="workspace-primary" @click="submitWaitInput">提交并继续</button></footer>
          </div>
        </div>

        <!-- 右键菜单 -->
        <div v-if="ctxMenu" class="canvas-context-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }" @click.stop @contextmenu.prevent="closeCtxMenu">
          <div class="ctx-title">{{ ctxMenu.nodeId ? ctxMenu.nodeTitle : "添加节点" }}</div>
          <template v-if="ctxMenu.nodeId">
            <button class="context-menu-item" @click="onNodeSelected(nodes.find((n) => n.id === ctxMenu?.nodeId)!); closeCtxMenu()">查看/编辑参数 <span>↗</span></button>
            <button class="context-menu-item is-danger" @click="removeNode(ctxMenu!.nodeId!)">删除节点 <span>×</span></button>
          </template>
          <template v-else>
            <div class="context-menu-label">常用能力</div>
            <button v-for="c in capabilities.slice(0, 8)" :key="c.id" class="context-menu-item" @click="addCapability(c); closeCtxMenu()">{{ c.label }} <span>＋</span></button>
          </template>
        </div>
        <div v-if="ctxMenu" class="ctx-backdrop" @click="closeCtxMenu" @contextmenu.prevent="closeCtxMenu"></div>

        <!-- 节点详情 -->
        <div
          v-if="selectedNode"
          class="workspace-panel"
          :class="{ 'is-dragging': nodePanel.dragging.value }"
          :style="{ left: nodePanel.pos.value.x + 'px', top: nodePanel.pos.value.y + 'px' }"
        >
          <header class="workspace-panel-header" @pointerdown="nodePanel.startDrag" @dblclick="nodePanel.reset()">
            <span class="panel-grip" title="按住拖动 · 双击复位">⠿</span>
            <div>
              <span class="workspace-panel-kicker">{{ selectedNode.module }}</span>
              <h2>{{ selectedNode.title }}</h2>
            </div>
            <div class="workspace-panel-actions">
              <span class="workspace-live-state" :class="'is-' + selectedNode.state">{{ selectedNode.stateLabel || selectedNode.state }}</span>
              <button class="workspace-close" @click="selectedNode = null">×</button>
            </div>
          </header>          <div class="node-panel-detail">
            <p v-if="selectedCap" class="drawer-desc">{{ selectedCap.description }}</p>
            <div class="drawer-row"><label>能力</label><span>{{ selectedNode.capabilityId || "（未绑定, 按通用生成执行）" }}</span></div>
            <div class="drawer-row"><label>输入</label><span>{{ selectedNode.input || "上游产出" }}</span></div>
            <div class="drawer-row"><label>输出</label><span>{{ selectedNode.output || "text" }}</span></div>
            <!-- V415: 直接依赖数 = 这张图里有多少条边指向它。连线才是执行的依据, 数字对得上用户才看得出
                 "我连的线生效了"; 与执行日志里的 ← 依赖列表是同一份事实的两种呈现。 -->
            <div class="drawer-row"><label>直接依赖</label><span>{{ depCountOf(selectedNode.id) }} 个上游节点</span></div>
            <div v-if="selectedNode.artifact" class="drawer-artifact">
              <span>产物落点: {{ selectedNode.artifact.label }}</span>
              <button class="ws-ask-btn" @click="viewArtifact(selectedNode!.artifact!.where)">去查看</button>
            </div>
            <div v-if="selectedNode.executionDetail" class="drawer-hint">{{ selectedNode.executionDetail }}</div>
            <div v-if="selectedNode.outputPreview" class="drawer-live-output">{{ selectedNode.outputPreview }}</div>

            <template v-if="paramFields.length">
              <div class="panel-section-title">节点参数</div>
              <label v-for="f in paramFields" :key="f.name" class="workspace-field">
                <span>{{ f.label }}<b v-if="f.required"> *</b></span>
                <textarea v-if="f.type === 'string'" v-model="nodeForm[f.name]" rows="3" :placeholder="f.placeholder || ''" />
                <input v-else v-model="nodeForm[f.name]" :placeholder="f.placeholder || ''" />
              </label>
              <div class="param-tip">可用 <code>&#123;&#123;inputs&#125;&#125;</code> 引用上游产出, <code>&#123;&#123;outputs.节点id&#125;&#125;</code> 引用指定节点产出。</div>
            </template>

            <details class="panel-advanced">
              <summary>高级: 直接编辑全部参数(JSON)</summary>
              <textarea
                class="json-editor"
                :value="JSON.stringify(nodeForm, null, 2)"
                @change="(e) => { try { nodeForm = JSON.parse((e.target as HTMLTextAreaElement).value); } catch { toast('JSON 格式错误', 'error'); } }"
              />
            </details>
          </div>
          <footer class="workspace-panel-footer">
            <span>改完点保存即落库</span>
            <div>
              <!-- V415: 删除入口必须在看得见的地方 —— 之前只有右键(而且右键还是坏的), 用户找不到 -->
              <button class="workspace-secondary danger" :disabled="locked" @click="removeNode(selectedNode!.id); selectedNode = null">删除节点</button>
              <button class="workspace-secondary" @click="selectedNode = null">关闭</button>
              <button class="workspace-primary" :disabled="locked" @click="saveNodeParams">保存参数</button>
            </div>
          </footer>
        </div>

        <div v-if="finalText && !waitingStep" class="final-bar">
          <span>本次产出 {{ finalText.replace(/\s/g, "").length }} 字</span>
        </div>
      </section>
    </main>

    <!-- 模板库 -->
    <div v-if="openTemplates" class="modal-shell" @click.self="openTemplates = false">
      <div class="modal-card wide">
        <header class="modal-head"><strong>内置编排模板</strong><span>选中即载入画布, 之后可自由改</span><button class="workspace-close" @click="openTemplates = false">×</button></header>
        <div class="modal-body tpl-grid">
          <div v-for="t in templates" :key="t.id" class="tpl-card" @click="applyTemplate(t.id); openTemplates = false">
            <div class="tpl-head">
              <strong>{{ t.name }}</strong>
              <span class="tpl-cost" :class="COST_META[t.costEstimated ?? t.cost].cls">{{ COST_META[t.costEstimated ?? t.cost].label }}</span>
            </div>
            <p>{{ t.description }}</p>
            <small>{{ t.scenario }}</small>
            <div class="tpl-meta">{{ t.graph.nodes.length }} 节点 · {{ t.graph.edges.length }} 条连线</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 创作能力节点(V415: 平台没现成能力时, 用提示词自己定义一个节点) -->
    <div v-if="openCreate" class="modal-shell" @click.self="openCreate = false">
      <div class="modal-card">
        <header class="modal-head">
          <strong>创作能力节点</strong>
          <span>用提示词定义一步 —— 执行时按这一步的提示词生成</span>
          <button class="workspace-close" @click="openCreate = false">×</button>
        </header>
        <div class="modal-body">
          <div class="set-row">
            <div class="set-label">
              <strong>节点名称</strong>
              <small>画布卡片上显示的名字</small>
            </div>
            <input v-model="createForm.title" class="palette-search" placeholder="如 交叉验证数据来源" />
          </div>
          <div class="set-row">
            <div class="set-label">
              <strong>这一步要做什么</strong>
              <!-- v-pre: 这里要**显示**字面量 {{inputs}}, 不能被 Vue 当插值编译(嵌套花括号会解析失败) -->
              <small>用 <code v-pre>{{inputs}}</code> 引用上游产出; 不写则上游产出自动作为输入</small>
            </div>
            <textarea v-model="createForm.task" class="set-input" rows="5" placeholder="如: 对本段论证中的每个数据点, 列出可能的替代解释, 并标注需要补充的证据。"></textarea>
          </div>
          <div class="set-row">
            <div class="set-label">
              <strong>角色设定(可选)</strong>
              <small>不填则用默认的学术写作专家</small>
            </div>
            <input v-model="createForm.system" class="palette-search" placeholder="如 你是期刊审稿人, 只指出问题不给建议" />
          </div>
        </div>
        <footer class="workspace-panel-footer">
          <span>添加后可在节点详情里继续改</span>
          <div>
            <button class="workspace-secondary" @click="openCreate = false">取消</button>
            <button class="workspace-primary" @click="addCustomNode">添加到画布</button>
          </div>
        </footer>
      </div>
    </div>

    <!-- 运行记录 -->
    <div v-if="openRuns" class="modal-shell" @click.self="openRuns = false">
      <div class="modal-card wide">
        <header class="modal-head">
          <strong>运行记录</strong>
          <span>后端落库, 刷新/换设备可查 · 点一条看运行过程</span>
          <button class="workspace-close" @click="openRuns = false">×</button>
        </header>
        <div class="modal-body">
          <div v-if="!runs.length" class="palette-empty">暂无运行记录</div>
          <template v-for="r in runs" :key="r.runId">
            <!-- V415: 记录可点开 —— 之前整行没有任何点击处理, 用户看不到"这步跑了多久/依赖谁/产出什么" -->
            <div class="run-row" :class="{ 'is-open': openRunId === r.runId }" @click="openRunId = openRunId === r.runId ? '' : r.runId">
              <span class="state-chip" :class="runMetaOf(r.status).cls">{{ runMetaOf(r.status).label }}</span>
              <strong>{{ r.graphName || r.graphId || r.runId }}</strong>
              <span class="run-meta">{{ r.stepLog.filter((s) => s.status === "done").length }}/{{ r.stepLog.length }} 节点 · {{ (r.updatedAt || "").slice(5, 16).replace("T", " ") }}</span>
              <span class="run-caret">{{ openRunId === r.runId ? "▾" : "▸" }}</span>
            </div>
            <div v-if="openRunId === r.runId" class="run-detail">
              <div v-if="r.error" class="run-detail-error">{{ r.error }}</div>
              <div v-for="(s, i) in r.stepLog" :key="s.stepId" class="run-step">
                <span class="run-step-no">{{ String(i + 1).padStart(2, "0") }}</span>
                <span class="state-chip sm" :class="runMetaOf(s.status === 'done' ? 'done' : s.status).cls">{{ stepLabel(s.status) }}</span>
                <strong>{{ s.label || s.stepId }}</strong>
                <span class="run-step-meta">
                  <span v-if="s.inputsFrom?.length">依赖 {{ s.inputsFrom.join(" + ") }}</span>
                  <span v-if="s.durationMs !== undefined">{{ (s.durationMs / 1000).toFixed(1) }}s</span>
                  <span v-if="(s.output ?? '').length">{{ (s.output ?? '').replace(/\s/g, "").length }} 字</span>
                </span>
                <div v-if="s.error" class="run-step-err">{{ s.error }}</div>
                <div v-else-if="s.output" class="run-step-out">{{ s.output.slice(0, 220) }}{{ s.output.length > 220 ? " …" : "" }}</div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 我的编排 -->
    <div v-if="openGraphs" class="modal-shell" @click.self="openGraphs = false">
      <div class="modal-card">
        <header class="modal-head"><strong>我的编排</strong><span>画布上的图可保存复用</span><button class="workspace-close" @click="openGraphs = false">×</button></header>
        <div class="modal-body">
          <div class="save-row">
            <input v-model="graphName" class="palette-search" placeholder="编排名称" />
            <button class="workspace-primary" @click="persistGraph">保存当前画布</button>
          </div>
          <div v-if="!myGraphs.length" class="palette-empty">还没有保存的编排</div>
          <div v-for="g in myGraphs" :key="g.id" class="run-row">
            <strong>{{ g.name }}</strong>
            <span class="run-meta">{{ g.nodeCount }} 节点 · {{ (g.updatedAt || "").slice(5, 16).replace("T", " ") }}</span>
            <button class="workspace-secondary" @click="openGraph(g.id)">打开</button>
            <button class="workspace-secondary danger" @click="removeGraph(g.id)">删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 设置(V415: Agent 编排开关必须用户可见) -->
    <div v-if="openSettings" class="modal-shell" @click.self="openSettings = false">
      <div class="modal-card">
        <header class="modal-head"><strong>编排设置</strong><span>影响 AI 对话里的 Agent 行为</span><button class="workspace-close" @click="openSettings = false">×</button></header>
        <div class="modal-body">
          <div v-if="!agentSetting" class="palette-empty">正在读取设置…</div>
          <template v-else>
            <div class="set-row">
              <div class="set-label">
                <strong>允许 Agent 触发编排</strong>
                <small>
                  打开后, AI 对话里的 Agent 能用 <code>orch_run</code> 触发一条完整编排
                  (多步管道, 成本较高)。关闭时 Agent 只能做单步任务。
                </small>
              </div>
              <label class="switch" :class="{ 'is-disabled': !agentSetting.envAllowed || savingSetting }">
                <input
                  type="checkbox"
                  :checked="agentSetting.enabled"
                  :disabled="!agentSetting.envAllowed || savingSetting"
                  @change="toggleAgentEnabled(($event.target as HTMLInputElement).checked)"
                />
                <span class="slider"></span>
              </label>
            </div>
            <div v-if="!agentSetting.envAllowed" class="set-warn">
              部署方未开启该能力: 环境变量 <code>ORCH_AGENT_ENABLED</code> 未设为 <code>1</code>(也接受 <code>true</code>/<code>yes</code>/<code>on</code>)。
              这是部署级总闸, 界面上只能查看, 无法自行打开。
            </div>
            <div v-else class="set-hint">
              当前状态: <b>{{ agentSetting.enabled ? "已开启" : "已关闭" }}</b>
              ({{ agentSetting.source === "user" ? "由你在本页设置" : "默认值" }})
            </div>
            <div class="set-row">
              <div class="set-label">
                <strong>单次最多节点数</strong>
                <small>防"一句话烧掉整月额度": Agent 触发的编排节点数超过这个值会被拒绝。当前 {{ agentSetting.maxNodes }}。</small>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quick-view {
  --ink: #E8EEF7; --muted: #8B9BB1; --line: #222F44; --soft: #161F33; --blue: #4D84CB;
  height: 100%; min-height: 0; width: 100%; margin: 0; box-sizing: border-box;
  display: flex; flex-direction: column;
  /* V415: 原来是 overflow:hidden —— 窗口/iframe 一矮, 三个区被压扁且**整页滚不动**,
     用户报的"该页面不能上下滑动"就是它。改成纵向可滚 + 给主区一个最小高度:
     空间够时不出现滚动条(内容正好铺满), 空间不够时滚动而不是把面板挤成一条缝。 */
  overflow-x: hidden; overflow-y: auto;
  background: #0A1120; color: var(--ink);
  font-family: PingFang SC, Microsoft YaHei, sans-serif;
}
.quick-header {
  z-index: 4; display: flex; align-items: center; justify-content: space-between;
  gap: 20px; min-height: 62px; padding: 10px 22px;
  border-bottom: 1px solid #222F44; background: rgba(17, 25, 44, 0.96); flex-shrink: 0;
}
.brand-lockup { display: flex; align-items: center; gap: 11px; min-width: 0; }
.brand-mark {
  width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center;
  background: #0F1830; color: #F1F5F9; font-weight: 800; font-size: 13px; flex-shrink: 0;
}
.brand-lockup h1 { margin: 0; font-size: 15px; letter-spacing: 0.01em; white-space: nowrap; }
.brand-lockup p { margin: 3px 0 0; color: var(--muted); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.header-tools { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; justify-content: flex-end; }
/* V415: 成本量级 + Agent 编排开关状态(常驻可见, 不用点开弹层) */
.header-flags { display: flex; align-items: center; gap: 6px; flex-shrink: 0; margin-left: auto; }
.cost-chip {
  font-size: 10px; padding: 3px 9px; border-radius: 10px;
  background: #212C45; color: #8B9BB1; white-space: nowrap;
}
.cost-chip.cost-light { background: #14281F; color: #5FD0B4; }
.cost-chip.cost-medium { background: #1E2A48; color: #6FA6E8; }
.cost-chip.cost-heavy { background: #2A2414; color: #E8B54A; }
/* 执行权限角色: analyst(外部 Agent 触发, 写类能力被拦) / manager(用户在画布上启动) */
.role-chip {
  font-size: 10px; padding: 3px 9px; border-radius: 10px; white-space: nowrap;
  background: #2A2414; color: #E8B54A; cursor: help;
}
.role-chip.is-manager { background: #1E2A48; color: #6FA6E8; }
.agent-chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 10px; padding: 3px 9px; border-radius: 10px; cursor: pointer;
  background: #1F2430; color: #8B9BB1; border: 1px solid #2A3A55; white-space: nowrap;
}
.agent-chip:hover { border-color: #4D84CB; color: #DCE6F2; }
.agent-chip.is-on { background: #14281F; color: #5FD0B4; border-color: #2F6B55; }
.agent-dot { width: 6px; height: 6px; border-radius: 50%; background: #6E7F96; }
.agent-chip.is-on .agent-dot { background: #5FD0B4; box-shadow: 0 0 0 2px rgba(95, 208, 180, 0.2); }
.hdr-select {
  border: 1px solid #2A3A55; border-radius: 7px; background: #161F33; color: #DCE6F2;
  font-size: 11px; padding: 5px 8px; font-family: inherit; outline: none; max-width: 190px;
}
.hdr-select:disabled { opacity: 0.55; }
.hdr-btn {
  border: 1px solid #2A3A55; border-radius: 7px; background: transparent; color: #A3B3C8;
  font-size: 11px; padding: 5px 11px; cursor: pointer;
}
.hdr-btn:hover:not(:disabled) { background: #1A2333; color: #DCE6F2; }
.hdr-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* 空间够时铺满(不出现滚动条), 空间不够时由 .quick-view 滚动而不是把面板压扁 */
.quick-shell { flex: 1; min-height: 420px; display: flex; }
.agent-panel {
  width: clamp(240px, 28%, 310px); flex-shrink: 0; border-right: 1px solid var(--line);
  display: flex; flex-direction: column; background: #11192C; min-height: 0;
}
/* 用户拖过宽度后以 px 为准(内联 style 直接取胜, 这条只是把 flex 约束住) */
.agent-panel.is-resized { min-width: 0; }
/* 拉伸条: 命中区 7px 比 1px 视觉线好抓; 拖动/悬停高亮 */
.pane-splitter { flex: 0 0 7px; margin: 0 -3px; cursor: col-resize; background: transparent; position: relative; z-index: 5; }
.pane-splitter:hover, .pane-splitter.is-dragging { background: rgba(77, 132, 203, 0.35); }
.agent-panel-header { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid #212C45; }
.agent-avatar { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: #0F1830; color: #F1F5F9; font-weight: 800; }
.agent-panel-header strong { font-size: 13.5px; }
.agent-status { display: block; font-size: 10.5px; color: #5FD0B4; }
.agent-context { display: flex; align-items: center; gap: 8px; padding: 8px 14px; background: var(--soft); font-size: 11.5px; }
.ctx-label { color: var(--muted); flex-shrink: 0; }
.agent-context strong { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state-chip { margin-left: auto; font-size: 10px; padding: 2px 8px; border-radius: 9px; background: #212C45; color: #8B9BB1; flex-shrink: 0; }
.st-running { background: #1E2A48 !important; color: #6FA6E8 !important; }
.st-waiting, .st-paused { background: #2A2414 !important; color: #E8B54A !important; }
.st-completed { background: #14281F !important; color: #5FD0B4 !important; }
.st-failed { background: #2A1C1C !important; color: #F08A8A !important; }
.st-cancelled { background: #1F2430 !important; color: #8B9BB1 !important; }
.conversation-stream { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.message { display: flex; gap: 8px; max-width: 100%; }
.message.is-user { flex-direction: row-reverse; }
.msg-avatar { width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0; display: grid; place-items: center; background: #0F1830; color: #F1F5F9; font-size: 11px; font-weight: 800; }
.msg-body { flex: 1; min-width: 0; }
.message.is-user .msg-body { display: flex; flex-direction: column; align-items: flex-end; }
.msg-meta { display: flex; gap: 7px; font-size: 10px; color: #7A8AA0; margin-bottom: 3px; }
.msg-meta strong { color: #A3B3C8; font-weight: 600; }
.msg-content {
  display: inline-block; max-width: 100%; background: #212C45; border-radius: 10px;
  padding: 8px 12px; font-size: 12.5px; line-height: 1.6; word-break: break-word; color: #E8EEF7;
}
.message.is-user .msg-content { background: var(--blue); color: #F1F5F9; }
.msg-content > p { margin: 0; white-space: pre-wrap; }
.node-update-card { margin: 4px 0; min-width: 210px; background: #11192C; border: 1px solid #222F44; border-radius: 9px; padding: 8px 11px; }
.nu-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 5px; }
.nu-head strong { font-size: 12.5px; }
.nu-head span { font-size: 10px; padding: 1px 8px; border-radius: 9px; background: #14281F; color: #5FD0B4; flex-shrink: 0; }
.nu-detail { display: flex; gap: 7px; font-size: 11px; color: #8B9BB1; margin: 3px 0; }
.nu-detail strong { color: #DCE6F2; flex-shrink: 0; }
.nu-preview { margin: 4px 0 0; font-size: 11px; color: #93A5BC; background: #1A2438; border-left: 2px solid #9aaaf0; padding: 5px 8px; border-radius: 0 6px 6px 0; }
.plan-card { min-width: 230px; background: #11192C; border: 1px solid #222F44; border-radius: 9px; padding: 9px 11px; margin: 3px 0; }
.plan-card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 12px; }
.plan-card-head .card-icon { color: #d19a2f; }
.plan-card-head strong { font-size: 12.5px; }
.plan-card-head span { margin-left: auto; font-size: 10.5px; color: #7A8AA0; }
.plan-item { display: flex; align-items: center; gap: 7px; padding: 3px 0; font-size: 11.5px; }
.plan-item small { margin-left: auto; color: #7A8AA0; font-size: 9.5px; }
.plan-check { width: 15px; height: 15px; border-radius: 50%; flex-shrink: 0; display: grid; place-items: center; font-size: 9px; border: 1px solid #3A4A66; color: transparent; }
.plan-check.is-done { background: #5FD0B4; border-color: #5FD0B4; color: #0A1120; }
.artifact-card { display: flex; gap: 10px; align-items: flex-start; background: #11192C; border: 1px solid #222F44; border-radius: 9px; padding: 9px 11px; min-width: 210px; margin: 3px 0; }
.artifact-icon { width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0; display: grid; place-items: center; font-size: 15px; background: #1C2740; border: 1px solid #2A3A55; }
.artifact-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.artifact-body strong { font-size: 12.5px; }
.artifact-body p { margin: 0; font-size: 11px; color: #93A5BC; }
.composer { display: flex; align-items: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); }
.composer textarea {
  flex: 1; resize: none; border: 1px solid #222F44; border-radius: 10px; padding: 8px 11px;
  font-size: 12.5px; font-family: inherit; line-height: 1.5; outline: none;
  background: #161F33; color: #E8EEF7;
}
.send-button { width: 30px; height: 30px; border: 0; border-radius: 50%; background: var(--blue); color: #F1F5F9; font-size: 14px; cursor: pointer; }
.send-button:disabled { opacity: 0.4; cursor: not-allowed; }
.run-actions { padding: 0 12px 12px; display: flex; gap: 7px; }
.run-btn { flex: 1; padding: 8px; border: 0; border-radius: 9px; background: var(--blue); color: #F1F5F9; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.run-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.run-btn.pause { background: #E8B54A; color: #2A2414; }
.run-btn.danger { background: #3A2028; color: #F08A8A; border: 1px solid #5A2A34; }

/* 能力面板 */
.palette-panel { flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); background: #0F172A; }
/* 拉伸条: 命中区 7px 比视觉线宽(视觉 1px 太难抓), hover / 拖动时高亮 */
.palette-head { display: flex; align-items: center; gap: 6px; padding: 9px 11px; border-bottom: 1px solid #1E2A42; }
.palette-head strong { font-size: 12px; white-space: nowrap; }
.palette-search { flex: 1; min-width: 0; border: 1px solid #22304A; border-radius: 7px; background: #141D33; color: #E8EEF7; font-size: 11px; padding: 5px 8px; font-family: inherit; outline: none; }
.palette-toggle { border: 0; background: none; color: #7A8AA0; font-size: 14px; cursor: pointer; padding: 0 3px; }
.palette-toggle:hover { color: #E8EEF7; }
.palette-cats { display: flex; gap: 5px; overflow-x: auto; padding: 7px 10px; border-bottom: 1px solid #1E2A42; scrollbar-width: none; }
.palette-cats::-webkit-scrollbar { display: none; }
.palette-cat { flex-shrink: 0; border: 1px solid #22304A; background: transparent; color: #8B9BB1; font-size: 10.5px; padding: 3px 9px; border-radius: 11px; cursor: pointer; white-space: nowrap; }
.palette-cat.is-on { background: #1E2A48; border-color: #4D84CB; color: #9FC0E8; }
.palette-list { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.palette-empty { padding: 14px 10px; color: #6E7F96; font-size: 11px; text-align: center; }
.palette-item { display: flex; align-items: center; gap: 6px; padding: 7px 8px; border: 1px solid #1E2A42; border-radius: 8px; background: #131C30; cursor: grab; }
.palette-item:hover { border-color: #4D84CB; background: #17203A; }
.pi-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pi-main strong { font-size: 11.5px; color: #DCE6F2; }
.pi-main small { font-size: 9.5px; color: #6E7F96; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pi-cat { font-size: 9px; color: #6E7F96; flex-shrink: 0; }
.pi-risk { font-size: 9px; color: #E8B54A; flex-shrink: 0; }
.pi-add { border: 0; background: #1E2A48; color: #9FC0E8; border-radius: 6px; width: 20px; height: 20px; line-height: 1; font-size: 13px; cursor: pointer; flex-shrink: 0; }
.pi-add:hover { background: #4D84CB; color: #F1F5F9; }
.palette-expand { width: 26px; flex-shrink: 0; border: 0; border-right: 1px solid var(--line); background: #0F172A; color: #7A8AA0; font-size: 11px; cursor: pointer; writing-mode: vertical-rl; }
.palette-expand:hover { color: #E8EEF7; background: #131C30; }

.workspace-stage { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
.canvas-start-gate {
  position: absolute; inset: 0; z-index: 6; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 12px;
  background: rgba(17, 25, 44, 0.85); backdrop-filter: blur(1px); pointer-events: none;
}
.gate-mark { width: 44px; height: 44px; border-radius: 12px; background: #43C9CD; color: #0A1120; font-weight: 800; font-size: 15px; display: grid; place-items: center; }
.gate-copy { text-align: center; display: flex; flex-direction: column; gap: 5px; }
.gate-copy strong { font-size: 14px; color: #E8EEF7; }
.gate-copy span { font-size: 11.5px; color: #A3B3C8; max-width: 420px; line-height: 1.6; }
.canvas-locked-banner {
  position: absolute; top: 42px; left: 50%; transform: translateX(-50%); z-index: 6;
  background: rgba(29, 43, 72, 0.9); color: #DCE6F2; font-size: 11px;
  padding: 6px 16px; border-radius: 16px; pointer-events: none;
}
.canvas-hint-banner {
  position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); z-index: 6;
  background: rgba(23, 32, 58, 0.9); color: #7A8AA0; font-size: 10.5px;
  padding: 5px 14px; border-radius: 14px; pointer-events: none;
}
.canvas-context-menu {
  position: absolute; z-index: 20; min-width: 190px; max-height: 60%; overflow-y: auto;
  background: #11192C; border: 1px solid #222F44; border-radius: 10px;
  box-shadow: 0 14px 38px rgba(0, 0, 0, 0.5); padding: 6px; font-size: 12px;
}
.ctx-title { padding: 6px 8px 7px; font-weight: 700; color: #E8EEF7; border-bottom: 1px solid #1A2333; margin-bottom: 4px; }
.context-menu-label { padding: 4px 8px 6px; color: #7A8AA0; font-size: 10.5px; }
.context-menu-item {
  width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 10px;
  padding: 7px 9px; border: 0; border-radius: 7px; background: transparent;
  color: #DCE6F2; font-size: 12px; cursor: pointer; text-align: left;
}
.context-menu-item:hover { background: #1E2A48; color: #9FC0E8; }
.context-menu-item span { color: #7A8AA0; }
.context-menu-item.is-danger { color: #F08A8A; }
.context-menu-item.is-danger:hover { background: #2A1C1C; }
.ctx-backdrop { position: absolute; inset: 0; z-index: 19; }

.input-overlay { position: absolute; inset: 0; z-index: 25; display: grid; place-items: center; background: rgba(4, 8, 16, 0.6); backdrop-filter: blur(1px); }
.input-card { width: min(460px, 90%); background: #141D33; border: 1px solid #2A3A55; border-radius: 12px; overflow: hidden; }
.input-card header { padding: 12px 16px 9px; border-bottom: 1px solid #222F44; }
.input-card header strong { display: block; font-size: 13px; color: #E8EEF7; }
.input-card header span { font-size: 10.5px; color: #7A8AA0; }
.input-body { padding: 13px 16px; display: flex; flex-direction: column; gap: 10px; max-height: 50vh; overflow-y: auto; }
.input-card footer { padding: 10px 16px; border-top: 1px solid #222F44; background: #141D33; text-align: right; }

/* V415: 改为 left/top 定位(可由用户拖动); 高度仍随容器, 避免拖出去看不见内容 */
.workspace-panel {
  position: absolute; width: 340px; max-height: calc(100% - 24px); z-index: 9;
  display: flex; flex-direction: column;
  background: #11192C; border: 1px solid #2A3A55; border-radius: 12px;
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.5); overflow: hidden;
}
.workspace-panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 13px 15px 11px; border-bottom: 1px solid #222F44; cursor: grab; }
.workspace-panel.is-dragging .workspace-panel-header { cursor: grabbing; }
.panel-grip { color: #5B6B84; font-size: 13px; line-height: 1; flex-shrink: 0; margin-top: 3px; letter-spacing: -1px; }
.panel-grip:hover { color: #9FC0E8; }
.workspace-panel-header h2 { margin: 3px 0 0; font-size: 14px; color: #E8EEF7; }
.workspace-panel-kicker { font-size: 9px; letter-spacing: 0.14em; font-weight: 700; color: #759FD7; text-transform: uppercase; }
.workspace-panel-actions { display: flex; align-items: center; gap: 8px; }
.workspace-live-state { font-size: 10px; padding: 2px 9px; border-radius: 10px; background: #212C45; color: #A3B3C8; }
.workspace-live-state.is-completed { background: #14281F; color: #5FD0B4; }
.workspace-live-state.is-running { background: #1E2A48; color: #6FA6E8; }
.workspace-live-state.is-failed { background: #2A1C1C; color: #F08A8A; }
.workspace-live-state.is-paused { background: #2A2414; color: #E8B54A; }
.workspace-close { border: 0; background: none; font-size: 17px; line-height: 1; color: #7A8AA0; cursor: pointer; padding: 0 2px; }
.workspace-close:hover { color: #E8EEF7; }
.workspace-field { display: flex; flex-direction: column; gap: 5px; }
.workspace-field span { font-size: 10.5px; color: #A3B3C8; }
.workspace-field span b { color: #E8B54A; }
.workspace-field input, .workspace-field textarea {
  border: 1px solid #2A3A55; border-radius: 8px; background: #161F33;
  color: #E8EEF7; font-size: 12px; padding: 8px 10px; font-family: inherit; outline: none;
}
.workspace-field textarea { resize: vertical; min-height: 62px; }
.workspace-field input:focus, .workspace-field textarea:focus { border-color: #4D84CB; }
.workspace-panel-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 15px; border-top: 1px solid #222F44; background: #141D33; }
.workspace-panel-footer span { font-size: 9.5px; color: #7A8AA0; }
.workspace-panel-footer > div { display: flex; gap: 7px; }
.workspace-primary, .workspace-secondary { border-radius: 8px; font-size: 11px; font-weight: 600; padding: 6px 13px; cursor: pointer; }
.workspace-primary { border: 0; background: #4D84CB; color: #F1F5F9; }
.workspace-primary:disabled, .workspace-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
.workspace-primary:hover:not(:disabled) { background: #3771BE; }
.workspace-secondary { border: 1px solid #2A3A55; background: transparent; color: #A3B3C8; }
.workspace-secondary:hover { background: #1A2333; }
.workspace-secondary.danger { color: #F08A8A; border-color: #5A2A34; }
.node-panel-detail { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px 15px; }
.drawer-desc { margin: 0; font-size: 11px; color: #93A5BC; line-height: 1.6; }
.drawer-row { display: flex; gap: 8px; font-size: 11.5px; }
.drawer-row label { color: var(--muted); flex-shrink: 0; min-width: 42px; }
.drawer-row span { color: #DCE6F2; word-break: break-all; }
.drawer-artifact { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #5FD0B4; background: #14281F; border-radius: 7px; padding: 6px 9px; }
.drawer-hint { padding: 7px 9px; background: #1A2438; border-left: 2px solid #9aaaf0; font-size: 11px; color: #A3B3C8; }
.drawer-live-output {
  max-height: 130px; overflow: auto; padding: 8px 10px; background: #1A2438;
  border-left: 2px solid #7B9CE0; border-radius: 0 7px 7px 0;
  font-size: 11px; color: #A3B3C8; white-space: pre-wrap; word-break: break-word;
}
.ws-ask-btn { border: 1px solid #2F6B55; border-radius: 7px; background: transparent; color: #5FD0B4; font-size: 10.5px; padding: 3px 9px; cursor: pointer; flex-shrink: 0; }
.ws-ask-btn:hover { background: #1A3A2E; }
.panel-section-title { margin-top: 6px; font-size: 10px; letter-spacing: 0.12em; color: #759FD7; text-transform: uppercase; }
.param-tip { font-size: 10px; color: #6E7F96; line-height: 1.6; }
.param-tip code { background: #1A2438; padding: 1px 4px; border-radius: 4px; color: #9FC0E8; }
.panel-advanced summary { font-size: 10.5px; color: #7A8AA0; cursor: pointer; margin-top: 4px; }
.json-editor {
  width: 100%; min-height: 110px; margin-top: 6px; border: 1px solid #2A3A55; border-radius: 8px;
  background: #0F172A; color: #C3D2E5; font-family: Consolas, monospace; font-size: 10.5px;
  padding: 8px; outline: none; resize: vertical;
}
.final-bar {
  position: absolute; bottom: 46px; right: 14px; z-index: 8;
  background: #14281F; border: 1px solid #2F6B55; border-radius: 10px; padding: 7px 12px;
  font-size: 11px; color: #5FD0B4;
}

/* 弹层 */
.modal-shell { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; background: rgba(4, 8, 16, 0.72); backdrop-filter: blur(2px); }
.modal-card { width: min(560px, 92%); max-height: 82vh; display: flex; flex-direction: column; background: #131C30; border: 1px solid #2A3A55; border-radius: 12px; overflow: hidden; }
.modal-card.wide { width: min(860px, 94%); }
.modal-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #222F44; }
.modal-head strong { font-size: 13px; color: #E8EEF7; white-space: nowrap; }
.modal-head span { font-size: 10.5px; color: #7A8AA0; }
.modal-head .workspace-close { margin-left: auto; }
.modal-body { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 9px; }
.tpl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
.tpl-card { display: flex; flex-direction: column; gap: 5px; padding: 12px; border: 1px solid #222F44; border-radius: 10px; background: #11192C; cursor: pointer; }
.tpl-card:hover { border-color: #4D84CB; background: #17203A; }
.tpl-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tpl-head strong { font-size: 12.5px; color: #E8EEF7; }
.tpl-cost { font-size: 9.5px; padding: 1px 7px; border-radius: 9px; background: #212C45; color: #8B9BB1; flex-shrink: 0; }
.tpl-cost.cost-light { background: #14281F; color: #5FD0B4; }
.tpl-cost.cost-heavy { background: #2A2414; color: #E8B54A; }
.tpl-card p { margin: 0; font-size: 11px; color: #A3B3C8; line-height: 1.55; }
.tpl-card small { font-size: 10px; color: #6E7F96; }
.tpl-meta { font-size: 9.5px; color: #759FD7; }
.run-row { display: flex; align-items: center; gap: 9px; padding: 9px 11px; border: 1px solid #1E2A42; border-radius: 9px; background: #11192C; font-size: 11.5px; }
.run-row strong { color: #DCE6F2; font-size: 12px; }
.run-meta { margin-left: auto; color: #7A8AA0; font-size: 10.5px; }
.run-row .state-chip { margin-left: 0; }
.run-row .workspace-secondary { flex-shrink: 0; }
/* V415: 运行记录可展开看过程 */
.run-row { cursor: pointer; }
.run-row:hover { border-color: #3A5080; }
.run-row.is-open { border-color: #4D84CB; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.run-caret { color: #7A8AA0; font-size: 10px; flex-shrink: 0; }
.run-detail { margin: -1px 0 6px; border: 1px solid #4D84CB; border-top: 0; border-radius: 0 0 9px 9px; background: #0E1626; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.run-detail-error { font-size: 10.5px; color: #F08A8A; background: #2A1C1C; border-radius: 7px; padding: 6px 8px; }
.run-step { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 8px; border-radius: 7px; background: #111C30; font-size: 11px; }
.run-step-no { color: #5B6B84; font-size: 9.5px; font-weight: 700; }
.run-step strong { color: #DCE6F2; font-size: 11.5px; }
.run-step-meta { margin-left: auto; display: flex; gap: 10px; color: #7A8AA0; font-size: 10px; }
.state-chip.sm { margin-left: 0; font-size: 9px; padding: 1px 6px; }
.run-step-err { flex-basis: 100%; color: #F08A8A; font-size: 10.5px; line-height: 1.55; }
.run-step-out { flex-basis: 100%; color: #93A5BC; font-size: 10.5px; line-height: 1.55; white-space: pre-wrap; }
.save-row { display: flex; gap: 8px; }
.save-row .palette-search { flex: 1; }

/* 设置弹层(V415) */
.set-row { display: flex; align-items: flex-start; gap: 12px; padding: 11px 12px; border: 1px solid #1E2A42; border-radius: 9px; background: #11192C; }
.set-label { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.set-label strong { font-size: 12.5px; color: #E8EEF7; }
.set-label small { font-size: 10.5px; color: #8B9BB1; line-height: 1.6; }
.set-label code { background: #1A2438; padding: 1px 4px; border-radius: 4px; color: #9FC0E8; }
.set-warn { font-size: 10.5px; color: #E8B54A; background: #2A2414; border-radius: 8px; padding: 8px 10px; line-height: 1.6; }
.set-warn code { background: #3A3418; padding: 1px 4px; border-radius: 4px; }
.set-hint { font-size: 10.5px; color: #8B9BB1; }
.set-input {
  width: 190px; flex-shrink: 0; border: 1px solid #22304A; border-radius: 7px;
  background: #141D33; color: #E8EEF7; font-size: 11.5px; padding: 7px 9px;
  font-family: inherit; outline: none; resize: vertical; line-height: 1.6;
}
.set-input:focus { border-color: #4D84CB; }
/* V415: 创作能力节点入口 —— 与能力列表区分开(它是"定义一步", 不是"选一个已有能力") */
.palette-create {
  margin: 7px 8px 3px; padding: 7px 10px; border: 1px dashed #3A5080; border-radius: 8px;
  background: transparent; color: #9FC0E8; font-size: 11.5px; font-weight: 600;
  cursor: pointer; text-align: left; font-family: inherit;
}
.palette-create:hover { background: #17203A; border-color: #4D84CB; color: #DCE6F2; }
.set-hint b { color: #5FD0B4; }
.switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; cursor: pointer; }
.switch.is-disabled { opacity: 0.45; cursor: not-allowed; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute; inset: 0; border-radius: 22px; background: #2A3A55; transition: background 0.2s;
}
.slider::before {
  content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px;
  border-radius: 50%; background: #8B9BB1; transition: transform 0.2s, background 0.2s;
}
.switch input:checked + .slider { background: #2F6B55; }
.switch input:checked + .slider::before { transform: translateX(18px); background: #5FD0B4; }

/* 窄容器: 对话/面板/画布纵向堆叠 */
@media (max-width: 1100px) {
  .quick-shell { flex-direction: column; overflow-y: auto; }
  .agent-panel { width: 100% !important; max-height: 38%; border-right: 0; border-bottom: 1px solid var(--line); }
  .palette-panel { width: 100% !important; max-height: 220px; border-right: 0; border-bottom: 1px solid var(--line); }
  .palette-expand { writing-mode: horizontal-tb; width: 100%; height: 22px; border-right: 0; border-bottom: 1px solid var(--line); }
  .workspace-stage { min-height: 360px; }
  .workspace-panel { top: auto; right: 8px; bottom: 8px; left: 8px; width: auto; max-height: 60%; }
}
</style>
