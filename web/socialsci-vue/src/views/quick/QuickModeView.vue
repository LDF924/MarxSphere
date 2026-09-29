<script setup lang="ts">
/**
 * QuickModeView — 课题流程编排画布(V415 重写)
 *
 * 旧实现的问题(2026-09-12 用户反馈): 节点写死 5 个 phrase + 4 个模块; 用户拖的连线只画不执行
 * (执行靠数组顺序 + 写死的 id→jobKind 字典); "暂停"只停前端 800ms 轮询而后端照跑;
 * 模板只有一个形态, 看不到 SocioSeek 的其余能力。
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
import { useRouter } from "vue-router";
import { useDraggablePanel } from "./useDraggablePanel";
import { STAGES, type StageDef, type StageStepDef } from "@/shared/stages";
import { toast, confirmDialog } from "@/shared/ui";
import { q } from "@/shared/api";
import {
  fetchCapabilities, fetchTemplates, startRun, fetchProgress, controlRun, fetchRuns,
  listGraphs, loadGraph, saveGraph, deleteGraph, fetchAgentSetting, updateAgentSetting,
  fetchMetaSkills, fetchMetaSkillGraph, type OrchMetaSkill,
  RUN_STATUS_META, COST_META, stepStatusToNodeState,
  fetchRunEvents, EVENT_LABEL, eventFamily, type OrchRunEvent, type OrchStepRun,
  type OrchCapability, type OrchTemplate, type OrchProgress, type OrchRunRecord, type OrchGraph, type AgentOrchSetting,
} from "@/shared/orchApi";

const router = useRouter();

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
/** V416: 「让 Agent 调整此节点」要把整理好的上下文填进这个输入框, 需要拿到元素引用 */
const inputEl = ref<HTMLTextAreaElement | null>(null);
const chatScroll = ref<HTMLElement | null>(null);
function nowHM() { const n = new Date(); return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`; }
function pushMsg(p: Partial<ChatMsg> & { role: "user" | "agent" }) {
  messages.value.push({ id: ++msgSeq, kind: "text", time: nowHM(), ...p } as ChatMsg);
  setTimeout(() => { if (chatScroll.value) chatScroll.value.scrollTop = chatScroll.value.scrollHeight; }, 50);
}

// ── 能力面板 ──
const paletteCollapsed = ref(false);
/**
 * 面板视图: `cap` = 按能力类别(原来的); `stage` = 按研究阶段。
 * 见模板里那段注释 —— 同一批能力换一种组织方式, 让"我在第几步"的人找得到。
 */
const capMode = ref<"cap" | "stage">("cap");
/**
 * 阶段视图用的阶段表。
 *
 * ⚠ **刻意不做"按研究类型过滤"**, 虽然 `visibleStages()` 就是干这个的。
 *   原因是本页**不持有项目上下文**: 它是编排画布, 既不注入 workflow store,
 *   也没有 researchMethod —— 要拿就得从 `lastTask_workflow` 指针去后端读一次。
 *   为一行展示值加一次请求不划算, 更要紧的是**读不到时会静默显示错的阶段集合**
 *   (比如把定量项目的「研究实施」藏起来), 而用户不会知道是"没读到"还是"本来就没有"。
 *
 *   所以这里列**全部**阶段, 用 `appliesTo` 把"对当前研究类型不适用"的那档**标出来**
 *   而不是藏掉 —— 定性项目会看到「研究实施」带一句「定量/混合研究适用」,
 *   这比"它凭空消失了"诚实, 也让"A 阶段为什么没有"这个问题有答案。
 *   (研究类型的真源仍在项目里, 阶段页与进度条照旧按它过滤 —— 那里有上下文。)
 */
const ALL_STAGES = computed(() => STAGES);
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

// ── MetaSkill 声明式 DAG(用户要求: 把它独有的能力融合进编排页) ──
// 这里承载的是 MetaSkill 面板独有的两件事:
//   ① 已注册的声明式 DAG 可以**打开到画布上**继续改(以前只能在那边点"运行")
//   ② DAG 提案的审阅(平台按高频任务自动组装候选流程, 人工 accept 后才进注册表)
const metaSkills = ref<OrchMetaSkill[]>([]);  // 含 steps 数量(明细要另拉图)
const proposals = ref<Array<{ id: string; triggerGoal: string; seenCount: number; status: string; sourceSkillNames?: string[]; sourceSkillIds?: number[]; dag: { name: string; description?: string; steps?: unknown[] } }>>([]);
const dagBusy = ref(false);
const proposeTopic = ref("");
const metaLoaded = ref(false);

async function loadMetaSkills() {
  metaSkills.value = await fetchMetaSkills().catch(() => []);
  metaLoaded.value = true;
}
async function loadProposals() {
  try {
    const r = await apiGetProposals();
    proposals.value = r;
  } catch { proposals.value = []; }
}
/** 提案接口不在 orchApi 里(属于 meta-skill 域), 这里直接打 */
async function apiGetProposals() {
  const res = await fetch("/api/meta-skill/proposals");
  const j = await res.json();
  return (j?.proposals ?? []) as typeof proposals.value;
}
/** 把一条已注册的 DAG 打开到画布上 —— 打开后就是普通图, 随便改随便存 */
async function openMetaSkill(id: string) {
  dagBusy.value = true;
  try {
    const g = await fetchMetaSkillGraph(id);
    if (!g) { toast("读取失败: 这条 DAG 可能已被移除", "error"); return; }
    loadGraphInto(g.nodes, g.edges, g.name || id, g.basedOn, undefined);
    graphId.value = "";   // 打开副本: 不覆盖原 DAG, 要留住得自己另存
    pushMsg({ role: "agent", text: `已把声明式 DAG「${g.name}」打开到画布。
节点与连线都能改; 改动要复用请点「我的编排」保存。` });
    toast(`已打开「${g.name}」`, "success");
  } finally {
    dagBusy.value = false;
  }
}

// ── V418: 一句话 → 可执行流程 ──
// 走 POST /orchestrator/nl-to-dag(本页同一条执行链), **不是**项目级那个 nl-to-dag ——
//   后者往 research_projects.canvas 落库, 而本页画布是纯客户端状态、「开始执行」走
//   /orchestrator/run 不读那个列, 两条路不通用(2026-09-20 实测后重做)。
const nlDescription = ref("");
const nlBusy = ref(false);

async function genFromNl() {
  const desc = nlDescription.value.trim();
  if (!desc) return;
  nlBusy.value = true;
  try {
    const r = await q<{ graph?: OrchGraph }>("/orchestrator/nl-to-dag", { method: "POST", body: { description: desc } });
    const g = r.graph;
    const ns = Array.isArray(g?.nodes) ? g!.nodes : [];
    if (!ns.length) { toast("AI 没拆出步骤, 换个说法再试", "error"); return; }
    // 与 applyTemplate 同一形态: 载入画布 → 用户可改 → 点「开始执行」
    loadGraphInto(ns, g!.edges ?? [], g!.name || desc.slice(0, 40));
    graphId.value = "";        // 未保存的新图, 别覆盖已有编排
    graphName.value = g!.name || desc.slice(0, 40);
    graphBasedOn.value = "";
    nlDescription.value = "";
    await nextTick();
    fitCanvas();
    const withCap = ns.filter((n) => n.capabilityId).length;
    pushMsg({
      role: "agent",
      text: `已拆成 ${ns.length} 个步骤(其中 ${withCap} 个绑定了真实能力), 已载入下方画布。\n可以拖动调整、改参数, 然后点「开始执行」—— 和内置模板走同一条执行链。`,
    });
    toast(`已生成 ${ns.length} 步流程`, "success");
  } catch (e) {
    toast(`生成失败: ${(e as Error).message}`, "error");
  } finally {
    nlBusy.value = false;
  }
}

/** 让平台按高频主题组装一条候选 DAG(走 /api/meta-skill/propose-dag, 不自动注册) */
async function proposeDag() {
  const topic = proposeTopic.value.trim();
  if (!topic) { toast("写一个高频任务主题", "error"); return; }
  dagBusy.value = true;
  try {
    const res = await fetch("/api/meta-skill/propose-dag", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: topic }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.proposal) { toast(`组装失败: ${j?.error || res.status}`, "error"); return; }
    await loadProposals();
    toast("已生成候选 DAG, 请在下方审阅后接受或否决", "success");
    proposeTopic.value = "";
  } finally {
    dagBusy.value = false;
  }
}
async function actProposal(id: string, action: "accept" | "reject") {
  dagBusy.value = true;
  try {
    const res = await fetch(`/api/meta-skill/proposals/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { toast(`${action === "accept" ? "接受" : "否决"}失败: ${j?.error || res.status}`, "error"); return; }
    await loadProposals();
    if (action === "accept") { await loadMetaSkills(); toast("已接受并注册, 可直接打开到画布", "success"); }
    else toast("已否决", "success");
  } finally {
    dagBusy.value = false;
  }
}
// ── V415: 从已删除的 MetaSkill 面板搬过来的两块能力(用户要求"先转移再删") ──
//  ① 演示运行: 纯前端假跑, 不调 LLM 不花钱, 用定时器把步骤一格格点亮 —— 用来看"这条 DAG 会怎么跑"
//  ② 真实运行: 选一条 DAG + 填输入 → 起运行 → 轮询进度 → 澄清表单 → 终态产出
// 说明: 这两块以前只在 MetaSkill 面板有, 编排页只能"把图打开到画布", 看不到"直接跑这条 DAG"。
const msRunId = ref("");
const msStatus = ref("");
const msStepLog = ref<Array<{ stepId: string; kind: string; label?: string; status: string; output?: string; waitingFields?: Array<{ name: string; prompt: string; required: boolean }> }>>([]);
const msOutput = ref("");
const msForm = ref<Record<string, string>>({});
const msTopic = ref("");
const msDemo = ref(false);          // 演示模式(纯前端, 不落库不烧钱)
const msBusy = ref(false);
let msPollTimer: ReturnType<typeof setInterval> | null = null;
let msDemoTimers: ReturnType<typeof setTimeout>[] = [];

function msStopPoll() { if (msPollTimer) { clearInterval(msPollTimer); msPollTimer = null; } }
function msClearDemo() { for (const t of msDemoTimers) clearTimeout(t); msDemoTimers = []; }
function msReset() {
  msStopPoll(); msClearDemo();
  msRunId.value = ""; msStatus.value = ""; msStepLog.value = []; msOutput.value = ""; msForm.value = {}; msDemo.value = false;
}

/** ▶ 真实运行: 走 /api/meta-skill/run(与画布的"开始执行"同引擎, 但直接跑指定 DAG, 不用先打开到画布) */
async function msRun(skillId: string) {
  const input = msTopic.value.trim();
  if (!input) { toast("先填任务输入", "error"); return; }
  msReset(); msBusy.value = true;
  try {
    const r = await fetch("/api/meta-skill/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId, input }),
    }).then((res) => res.json());
    if (!r?.runId) { msBusy.value = false; toast(`启动失败: ${r?.error || "未知错误"}`, "error"); return; }
    msRunId.value = r.runId;
    msStatus.value = "running";
    msPollTimer = setInterval(() => void msPoll(), 1500);
  } catch (e) {
    msBusy.value = false;
    toast(`启动失败: ${(e as Error).message}`, "error");
  }
}
async function msPoll() {
  const id = msRunId.value;
  if (!id) return;
  const j = await fetch(`/api/meta-skill/progress?runId=${encodeURIComponent(id)}`).then((r) => r.json()).catch(() => null);
  // 运行结束被清理 → ok=false, 此时停轮询(与面板原来的处理一致)
  if (!j?.ok) { msStopPoll(); msBusy.value = false; return; }
  msStatus.value = j.status ?? "";
  msStepLog.value = j.stepLog ?? [];
  if (j.status === "done" || j.status === "failed") {
    msStopPoll(); msBusy.value = false;
    const last = [...(j.stepLog ?? [])].reverse().find((s: { output?: string }) => s.output);
    msOutput.value = last?.output || "（无输出）";
  }
}
/** 提交澄清字段 → 续跑 */
async function msSubmitForm() {
  if (!msRunId.value) return;
  await fetch("/api/meta-skill/input", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId: msRunId.value, values: msForm.value }),
  }).catch(() => null);
  msForm.value = {};
}

/** 演示要用步骤明细(清单接口只给数量) → 拉一次图; 拿不到就退化成"N 步"进度 */
async function demoSteps(skill: OrchMetaSkill): Promise<Array<{ id: string; kind: string; label?: string }>> {
  const g = await fetchMetaSkillGraph(skill.id);
  return (g?.nodes ?? []).map((n) => ({ id: n.id, kind: String((n as { kind?: string }).kind ?? "step"), label: n.title }));
}
/**
 * 🎬 演示运行 —— 纯前端假跑: 不调 LLM、不落库、不花钱, 只把步骤按序点亮。
 * 用途: 先看清"这条 DAG 有几个步骤、每步哪种类型、会问什么", 再决定要不要真跑。
 * (这是原 MetaSkill 面板唯一编排页没有的能力, 用户要求删页面前先搬过来。)
 */
async function msPlayDemo(skill: OrchMetaSkill) {
  msReset(); msDemo.value = true; msBusy.value = true;
  msRunId.value = "demo-run";
  const log: typeof msStepLog.value = (await demoSteps(skill)).map((s) => ({ stepId: s.id, kind: s.kind, label: s.label, status: "pending" }));
  const cur = { i: 0 };
  msStepLog.value = [...log];
  const advance = () => {
    if (cur.i >= log.length) {
      msBusy.value = false; msStatus.value = "done";
      msOutput.value = "【演示产出】这是一段示例文献综述。\n## 一、研究缘起\n关于该主题的学术讨论源于……\n## 二、发展脉络\n……\n（演示文本; 真实运行会生成真实综述）";
      return;
    }
    const step = log[cur.i];
    const isInput = step.kind === "user_input";
    step.status = isInput ? "waiting_input" : "running";
    if (isInput) step.waitingFields = [{ name: "topic", prompt: "综述主题", required: true }];
    msStatus.value = "running";
    msStepLog.value = [...log];
    msDemoTimers.push(setTimeout(() => {
      step.status = "done";
      step.output = isInput
        ? "topic: 演示主题"
        : `【${step.kind} 演示输出】${
          step.kind === "llm_gate" ? '{"pass":true,"reason":"引用检查通过"}'
            : step.kind === "llm_chat" ? "这是演示生成的综述草稿……(真实运行会调用 LLM)"
              : "检索到示例文献 8 篇……"}`;
      step.waitingFields = undefined;
      cur.i++;
      msStepLog.value = [...log];
      msDemoTimers.push(setTimeout(advance, 900));
    }, isInput ? 400 : 700));
  };
  advance();
}
const msWaiting = computed(() => msStepLog.value.find((s) => s.status === "waiting_input"));
/**
 * 澄清表单能不能提交: 必填字段都填了。
 * 放计算属性而不是写在模板里 —— Vue 模板表达式对"可选链 + 嵌套箭头函数"这种组合解析不了
 * (实测报 Identifier expected), 放 here 更清楚也更好测。
 */
const msFormReady = computed(() => {
  const fields = msWaiting.value?.waitingFields ?? [];
  return fields.every((f) => !f.required || (msForm.value[f.name] ?? "").trim().length > 0);
});

const createForm = ref({ title: "", task: "", system: "", maxTokens: "3000" });function openCreateNode() {
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
      /**
       * ⚠ 模板自带的参数要**盖在字段默认值之上**, 不是二选一。
       *
       * 原来写的是 `n.params ? {...n.params} : defaultParams(cap)` —— 模板节点**永远拿不到
       * 字段默认值**。后果(2026-09-29 查"模板参数有死键"时挖出来的):
       *   · `{{tool}}` / `{{message}}` 这类占位符是给字段面板用的, 值从 node.params 取;
       *     模板没给该字段时它是 undefined, 渲染成 `[未渲染:{{tool}}]` 发给端点;
       *   · 面板上那一行也**不存在**(参数行按 params 的建渲染), 用户连填的地方都没有;
       *   · 而 `stat:run` 的 fields 里 tool 有 `default: "describe"` —— 那正是为了
       *     "没人填时也别把节点做空"准备的, 却从没被用上。
       * 合并之后: 字段全在(面板有行)、默认值生效、模板自己要给的仍然说了算。
       */
      params: cap ? { ...defaultParams(cap), ...(n.params ?? {}) } : n.params,
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

/** V416: 模板库里"展开看内部结构"的那个模板 id(空 = 都收起) */
const expandedTplId = ref("");

/** 某节点连到哪些节点 —— 让展开区能看出**流向**, 而不只是一串节点名 */
function nextOf(t: OrchTemplate, nodeId: string): string[] {
  return t.graph.edges.filter((e) => e.source === nodeId).map((e) => e.target);
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
/** V416: 上游节点 id 列表 —— 「让 Agent 调整此节点」要把依赖列出来给它看 */
function depIdsOf(id: string): string[] { return userEdges.value.filter((e) => e.target === id).map((e) => e.source); }

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

/**
 * V416: 阶段视图的三个动作 —— 单跑一步 / 把一步加成节点 / 去它所属的阶段页。
 *
 * ## 单跑一步为什么要"造一张只有这一个节点的图"
 *
 * 编排后端能跑的**最小单位就是一个图**(`POST /orchestrator/run` 要 `{graph}`),
 * 没有"跑某个能力"这种端点。所以"只跑这一步" = 造一张只含它的单节点图, 走**同一条**
 * 启动链 (startRun → 同一个后端 → 同样的权限/审批/审计)。
 *
 * ⚠ 刻意**不**另开一条"直调能力"的捷径: 那会绕开权限闸门与审计。
 *   实测过裸调端点会被审批闸门拦下("建议模式 — 每步工具调用都需审批"),
 *   而那是**设计如此** —— 单步执行必须和整图执行受同一套约束。
 *
 * 与"加到画布"的区别: 单跑是**用完就走**(不留节点), 加节点是**留下它当这张图的一部分**。
 * 两个都要: 前者用于"我只想重跑这一步看看", 后者用于"我要把它编排进流程"。
 */
async function runSingleStep(stage: StageDef, step: StageStepDef) {
  if (locked.value) return;
  if (!step.capabilityId) { toast("这一步没有可直接执行的能力, 请到所属页面做", "info"); return; }
  const cap = capById(step.capabilityId);
  if (!cap) {
    // 这里**不该发生** —— 表里的 capabilityId 有单测保证都真实存在(见 test/stage-steps.test.ts)。
    // 真出现了说明表与注册表脱节了, 明说而不是静默跑一个空节点。
    toast(`能力 ${step.capabilityId} 不在当前能力表里 —— 阶段步骤表与注册表可能脱节了`, "error");
    return;
  }
  const nodeId = `step-${stage.key}-${step.key}`;
  try {
    /**
     * ⚠ 参数用 `defaultParams(cap)` 打底, 不能只传 `step.params`。
     *
     * 与 `loadGraphInto` 同一处修复(2026-09-29): 能力注册表的模板 body 里写的是
     * `{ dataVersionId: "{{dataVersionId}}" }` 这种**给字段留的种子**, 而 renderTemplate
     * 不认裸名 —— 参数里没有该键时, 那个占位符会**原样**发给端点。
     * 看 stage 表就知道这坑有多真: 「信效度检验」`emp:reliability` 与「回归分析」
     * `emp:regression` 这两步**根本没给 params**(它们的 dataVersionId/code 只能由人填),
     * 于是单跑这两步必然发出一个字面量 `{{dataVersionId}}`。
     */
    const r = await startRun({
      // 单节点图: 它就是"只跑这一步"的载体
      graph: {
        name: `单步 · ${stage.title} · ${step.label}`,
        nodes: [{ id: nodeId, capabilityId: step.capabilityId, title: step.label, params: { ...defaultParams(cap), ...(step.params ?? {}) } }],
        edges: [],
      },
      text: step.label,
      model: model.value || undefined,
    });
    runId.value = r.runId;
    runSource.value = "ui";
    runState.value = "running";
    lastDone = new Set();
    pushMsg({ role: "user", text: `单跑一步: ${stage.title} · ${step.label}` });
    pushMsg({
      role: "agent", kind: "plan",
      items: [{ label: step.label, module: stage.title, nodeId }],
    });
    startPoll(r.runId);
    toast(`已启动「${step.label}」单步执行(不影响画布上的图)`, "success");
  } catch (e) {
    toast(`单步执行启动失败: ${(e as Error).message}`, "error");
  }
}

/** 把某一步加成画布上的节点(留下它当这张图的一部分) */
function addStepAsNode(stage: StageDef, step: StageStepDef) {
  if (locked.value || !step.capabilityId) return;
  const cap = capById(step.capabilityId);
  if (!cap) { toast(`能力 ${step.capabilityId} 不在当前能力表里`, "error"); return; }
  addCapability(cap);
  // 参数用"这一步要产出什么", 而不是能力的通用默认值 —— 否则加出来的节点是空的
  const added = nodes.value[nodes.value.length - 1];
  if (added?.id) {
    const merged = { ...(added.params ?? {}), ...(defaultParams(cap)), ...(step.params ?? {}) };
    nodes.value = nodes.value.map((n) => (n.id === added.id
      ? { ...n, title: step.label, params: merged }
      : n));
  }
  toast(`已把「${step.label}」加到画布`, "success");
}

/** 没有可执行能力的步: 去它所属的阶段页做(那里本来就能做, 只是形状不是能挂 DAG 的同步步骤) */
function gotoStepPage(stage: StageDef, step: StageStepDef) {
  // ⚠ 这是 **soc 内部换页**, 用 router.push(与 MaterialsView 等页同一手法)。
  //   不要用 viewArtifact 那条 —— 它 postMessage 给 React 壳切**外壳级 tab**,
  //   而阶段页都在同一个 soc 子应用里, 走那条会绕出去再绕回来。
  void router.push(step.pageHint || stage.path);
  toast(`「${step.label}」在「${stage.title}」页做`, "info");
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

/**
 * V415(2026-09-13 用户选择"不保护, 但给后果提示"):
 * 新架构下节点来自模板、图是用户自己的, 所以不做"不可删"硬保护(那会妨碍自由组合编排)。
 * 但起点节点(澄清/选题界定)删掉后下游全都没有输入来源, 整张图跑不出东西 ——
 * 这类"删了会坏事"的情况先说清楚再删, 而不是静默把图搞坏。
 *
 * 判据用**图结构**(有无入边/出边), 不用"是不是模板起始节点"这种身份标记:
 * 用户可以把任何节点连成起点, 结构才是事实。
 */
async function removeNode(id: string, opts: { skipConfirm?: boolean } = {}) {
  if (locked.value) return;
  const node = nodes.value.find((n) => n.id === id);
  if (!node) return;
  if (!opts.skipConfirm) {
    const outs = userEdges.value.filter((e) => e.source === id);
    const ins = userEdges.value.filter((e) => e.target === id);
    const titleOf = (nid: string) => nodes.value.find((n) => n.id === nid)?.title ?? nid;
    if (outs.length) {
      const names = outs.slice(0, 4).map((e) => titleOf(e.target)).join("、");
      const more = outs.length > 4 ? ` 等 ${outs.length} 个` : "";
      const blocked = ins.length === 0;   // 没有入边 = 起点节点
      const ok = await confirmDialog({
        title: blocked ? "这是起点节点" : "删除节点",
        message: blocked
          ? `「${node.title}」没有上游输入, 删掉后下游 ${outs.length} 个节点(${names}${more})将失去输入来源, 整张图可能跑不出结果。

确定删除吗?`
          : `「${node.title}」有 ${outs.length} 个下游节点(${names}${more}), 删掉后它们会失去这部分输入。

确定删除吗?`,
        okText: "仍然删除",
        danger: true,
      });
      if (!ok) return;
    }
  }
  nodes.value = nodes.value.filter((n) => n.id !== id);
  userEdges.value = userEdges.value.filter((e) => e.source !== id && e.target !== id);
  if (selectedNode.value?.id === id) selectedNode.value = null;
  toast("节点已移除", "success");
}

/**
 * 新建空白任务(原版右键菜单里的项, 重写时丢了)。
 * 与"清空画布"的区别: 这里留一个起点节点 —— 空白图直接开跑没有任何输入来源,
 * 留一个澄清节点才能立刻开始连下游。
 */
function newBlankCanvas() {
  closeCtxMenu();
  const startCap = capabilities.value.find((c) => c.id === "io:clarify");
  const id = nextNodeId("start");
  nodes.value = [{
    id,
    title: startCap?.label ?? "起点(澄清需求)",
    module: startCap?.category ?? "通用",
    index: "01",
    state: "draft",
    stateLabel: "待执行",
    input: "上游产出",
    output: startCap?.outputs.join(" / ") || "text",
    capabilityId: startCap?.id,
    params: startCap ? defaultParams(startCap) : undefined,
    artifact: startCap?.artifact,
    canvasPosition: { x: 40, y: 50 },
  }];
  userEdges.value = [];
  graphId.value = "";
  graphName.value = "自定义编排";
  graphBasedOn.value = "";
  runState.value = "draft";
  runId.value = "";
  progress.value = null;
  finalText.value = "";
  selectedNode.value = null;
  toast("已新建空白任务", "success");
}

/** 清空画布(破坏性, 先确认) */
async function clearCanvas() {
  closeCtxMenu();
  if (!nodes.value.length) return;
  const ok = await confirmDialog({
    title: "清空画布",
    message: `将移除全部 ${nodes.value.length} 个节点与连线。未保存的改动会丢失, 确定吗?`,
    okText: "清空",
    danger: true,
  });
  if (!ok) return;
  nodes.value = [];
  userEdges.value = [];
  selectedNode.value = null;
  runState.value = "draft";
  runId.value = "";
  progress.value = null;
  finalText.value = "";
  toast("画布已清空", "success");
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

/**
 * AGENT HANDOFF —— 启动前的授权确认层(参考产品图 14)。
 *
 * 参考产品那张图的要点有两条, 都是"把用户要授权的东西摊开":
 *   ① 「该授权只对这份计划有效」—— 授权**绑定这一版图**;
 *   ② 「N 个工具节点」+ **逐条列出**将执行的节点(不是只说"N 个节点")。
 *
 * 我方原来只有一个空态覆盖层 `canvas-start-gate`(画布是空的 → 提示去加节点), 没有
 *   "确认后才启动"这一层。现在补上: 点「开始执行」先出这个确认层, 确认才真发请求。
 *
 * ⚠ 授权绑版本怎么落实(不能只是一句话): 记下**确认那一刻**的图指纹, 确认与请求之间
 *   若图又被人改了(理论上不会, 弹层挡住交互, 但代码上可能), 就作废这次授权让人重看。
 *   指纹用节点(id+能力+参数)+边拼出来 —— 简单、稳定、能覆盖"改了参数"这类肉眼可见的变化。
 */
const handoffOpen = ref(false);
/** 确认那一刻的图指纹; 为空表示还没有待确认的授权 */
const handoffFingerprint = ref("");

function graphFingerprint(): string {
  const g = graphPayload();
  return JSON.stringify({
    n: g.nodes.map((n) => [n.id, n.capabilityId ?? "", n.params ?? {}]),
    e: g.edges.map((e) => [e.source, e.target]),
  });
}
/** 将被执行的节点(参考产品图 14 那个灰色块逐行列出的东西) */
const handoffNodes = computed(() =>
  nodes.value.map((n) => ({ id: n.id, cap: n.capabilityId || "（未绑定能力）", title: n.title })),
);

function openHandoff() {
  if (locked.value) return;
  if (!nodes.value.length) { toast("画布是空的: 先从左侧能力面板拖节点进来, 或选一个模板", "error"); return; }
  handoffFingerprint.value = graphFingerprint();
  handoffOpen.value = true;
}

async function confirmHandoff() {
  if (graphFingerprint() !== handoffFingerprint.value) {
    // 图在确认期间变了 → 那句"该授权只对这份计划有效"必须有实际约束, 否则是空话
    handoffOpen.value = false;
    handoffFingerprint.value = "";
    toast("画板内容刚有改动, 授权已作废, 请重新确认", "warning");
    return;
  }
  handoffOpen.value = false;
  handoffFingerprint.value = "";
  await startExecution();
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
      // V416: 运行时真的消费了谁的产出 —— 节点详情「模块产物」与「查看诊断」都读它。
      // ⚠ 每次都用 `s.inputsFrom ?? []` **显式覆盖**(而不是"没有就留着上次的"):
      //   重跑一次之后上游可能变了, 残留的旧依赖会让诊断给出错误的因果。
      inputsFrom: s.inputsFrom ?? [],
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
    window.parent.postMessage({ source: "socioseek-soc", type: "navigate", view: where }, "*");
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
  void loadMetaSkills();
  void loadProposals();
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * V416: 计划历史(PLAN HISTORY) —— 计划版本与执行记录
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 对齐参考产品截图: 浮层里两段 —— 「执行记录」(本图跑过的各次运行) 与
 * 「当前事件」(该次运行的实时事件时间线: 时间 + 事件名 + 所属节点)。
 *
 * ## 为什么必须新做后端(而不是"渲染一下已有数据")
 *
 * 本仓原来只有 `orchestrator_runs.step_log_json`, 是**每步最后一次状态的快照**, 而且
 * 写入方 `on conflict do update` 是**整行覆盖** —— 同一节点的 pending→running→done
 * 只留得下最后一个。所以"先诊断再失败"这种**顺序**在库里**天生读不出来**。
 * 这不是渲染缺口, 是数据缺口。于是加了 `orchestrator_run_events`(迁移 161) +
 * 运行时 onEvent 钩子(见 `meta-skill-runtime.ts` 的 `MetaSkillExecutor.onEvent`)。
 *
 * ## 两个必须分开的对用户说法
 *
 * `historyAvailable === false` 表示**事件表都没建**(老库没迁移) —— 那是环境问题;
 * `events.length === 0` 而 available 为真, 才是真的"暂无执行事件"。
 * 混成一句话会让"环境没迁移"看着像"这次运行什么都没发生", 排查时方向全错。
 */
const openHistory = ref(false);
const historyRunId = ref("");
const historyEvents = ref<OrchRunEvent[]>([]);
const historyAvailable = ref(true);
const historyLoading = ref(false);
let historyTimer: ReturnType<typeof setInterval> | null = null;

/** 执行记录列表: 复用「运行记录」那份(同一次后端读取, 不另开接口) */
const historyRuns = computed(() => runs.value);

async function loadHistoryEvents() {
  if (!historyRunId.value) { historyEvents.value = []; return; }
  const r = await fetchRunEvents(historyRunId.value).catch(() => null);
  if (!r) return;
  historyEvents.value = r.events;
  historyAvailable.value = r.available;
}

/**
 * 打开浮层。
 *
 * 默认选中**本页自己那次运行**(`runId`), 没有才选最新一次。
 *
 * ⚠ 2026-09-28 改: 第一版是"优先选任何 running/waiting_input/paused 的运行",
 *   结果**永远选中一条死掉的旧运行** —— 探针实测库里躺着 **63 条 status='running'** 的历史行
 *   (进程重启不会把内存里的运行写回首态, 这些行就一直挂着)。于是浮层打开时显示的
 *   永远不是用户刚跑的那次, 时间线全是别人的。
 *   `runs` 列表里的 status 是**历史残留**, 不是"现在真的在跑"; 唯一可靠的"这次"是
 *   本页记着的 `runId`(它由 startRun 赋值、由轮询更新)。所以判据换成它。
 */
async function openPlanHistory() {
  openHistory.value = true;
  await loadRuns();
  const mine = runId.value && runs.value.some((r) => r.runId === runId.value) ? runId.value : "";
  historyRunId.value = mine || runs.value[0]?.runId || "";
  historyLoading.value = true;
  await loadHistoryEvents();
  historyLoading.value = false;
  stopHistoryPoll();
  historyTimer = setInterval(() => { void loadHistoryEvents(); }, 1500);
}
function stopHistoryPoll() {
  if (historyTimer) { clearInterval(historyTimer); historyTimer = null; }
}
function closePlanHistory() {
  stopHistoryPoll();
  openHistory.value = false;
}
async function pickHistoryRun(id: string) {
  historyRunId.value = id;
  historyLoading.value = true;
  await loadHistoryEvents();
  historyLoading.value = false;
}
onUnmounted(stopHistoryPoll);

/** 事件时间戳 → HH:MM:SS(参考产品那条时间线的粒度到秒) */
function evTime(iso: string): string {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** 事件名 → 中文。查不到就显示原名(见 EVENT_LABEL 的注释: 宁可显示英文名也不抹成"未知") */
function evLabel(event: string): string {
  return EVENT_LABEL[event] ?? event;
}
/** 节点 id → 画布上的节点标题, 认不出就用 id 本身 */
function evNodeLabel(nodeId: string): string {
  if (!nodeId) return "";
  return nodes.value.find((n) => n.id === nodeId)?.title ?? nodeId;
}

// ═══════════════════════════════════════════════════════════════════════════
// V416: 节点详情抽屉的四件事(对齐参考产品图 12 / 16 / 17)
//   · 查看诊断      —— 这个节点失败时到底说了什么
//   · 展开模块产物  —— 节点输入/产物的**原始结构化值**, 不做美化
//   · 在画布打开工作界面 —— 把节点滚到视野中央(不改缩放)
//   · 让 Agent 调整此节点 —— 把"这张卡片该怎么改"发进对话
//
// ⚠ 这三格 TASK INSPECTOR(AGENT / ATTEMPT / QUALITY)的处置, 逐条说明免得日后被当成漏做:
//   · AGENT    —— **显示**, 但显示的是真实执行角色。编排层的角色是 `runSource` 决定的
//                 (ui→manager / agent→analyst, 见 orchestrator-service 的 toolRoleFor),
//                 参考产品那个 "DAG Agent" 是它自家的产品名, 我们没有同名概念, 不编。
//   · ATTEMPT  —— **不做**。2026-09-28 实测: 编排链路上**根本没有重试** ——
//                 `grep -n "retry|重试|attempt" meta-skill-runtime.ts orchestrator-service.ts`
//                 只有一行注释命中, `orchestrator_runs` 也没有 attempts 列。
//                 一个恒显示 0 的三格比没有更糟(参考产品自己图 12 里那一格就是 "—")。
//   · QUALITY  —— **节点级没有**。全站唯一的质量分是**整篇稿子**的 `review_result.overallScore`
//                 (写进 finalize 节点的 payload); 编排的质量门 `llm_gate` 只产出
//                 `{pass, reason}` 一个布尔, 不是一个分数。所以这一格不做。
//   结论: 三格只做出一个真的(AGENT), 另外两个如实缺席。这与参考产品图 12 里
//   "ATTEMPT=0 / QUALITY=—" 的显示效果一致 —— 它那两个格子本身也是空的。
// ═══════════════════════════════════════════════════════════════════════════

/** 取这次运行里该节点的步骤记录(诊断 / 上游输入 / 用时都从这里来) */
const selectedStep = computed<OrchStepRun | null>(() => {
  const id = selectedNode.value?.id;
  if (!id) return null;
  const recent = progress.value?.stepLog ?? [];
  const cached = runs.value.find((x) => x.runId === runId.value);
  const fromRun = cached?.stepLog ?? [];
  // 内存进度优先: 它是最新的; 运行结束后 progress 会留在最后一次快照上, 所以两者通常一致
  return recent.find((s) => s.stepId === id) ?? fromRun.find((s) => s.stepId === id) ?? null;
});

/**
 * 诊断文本 —— **失败时才有, 没有就不显示**。
 *
 * 引擎里最后留下的 `error` 是给用户看的中文(`"质量门未通过: …"` / `"上游步骤失败, 跳过"`),
 * 不是错误码, 所以这里原样展示即可。**不编**一句"运行正常"之类的话去填这个位置:
 * 参考产品图 15 那种"当前进度: 本次节点已完成…"只有在真有 executionDetail 时才出现。
 */
const selectedDiagnosis = computed<string>(() => {
  const s = selectedStep.value;
  if (!s) return "";
  return String(s.error ?? "").trim();
});

/** 节点产物: 跑完后的输出(原始文本)。空就是空 —— 不拿 outputPreview 冒充。 */
const selectedArtifact = computed<string>(() => {
  const s = selectedStep.value;
  if (!s || s.status !== "done") return "";
  return String(s.output ?? "");
});

/**
 * 模块产物表(参考产品图 17): 字段名 → 值。
 *
 * 值的来源按可靠性排序 —— **有真的就用真的, 没有就明确写"尚未执行", 不编**:
 *   ① 这次运行的原始输出 + 该能力的 `outputs` 声明(声明是"产出什么字段"的真源)
 *   ② 还没跑过 → 返回空数组, 浮层显示"尚未执行"
 * 图 17 那种 `title / outline / sectionsList` 逐字段的表, 对应的是**输入**侧;
 *   输出侧我们只知道能力声明的字段名与一段文本, 所以第二段如实标成"原始输出"。
 */
const artifactRows = computed<Array<{ name: string; value: string }>>(() => {
  const n = selectedNode.value;
  const s = selectedStep.value;
  if (!n) return [];
  const rows: Array<{ name: string; value: string }> = [];
  // 输入: 参数表单里的**实际值**(原始值, 不是渲染后的文案 —— 图 16 的要点就是这个)
  for (const [k, v] of Object.entries(n.params ?? {})) {
    if (v === "" || v === undefined || v === null) continue;
    rows.push({ name: k, value: typeof v === "string" ? v : JSON.stringify(v) });
  }
  // 上游实际喂进来的产出(运行时回填的 inputsFrom)
  const deps = s?.inputsFrom ?? [];
  if (deps.length) {
    rows.push({
      name: "inputsFrom",
      value: deps.map((d) => `${evNodeLabel(d)}(${d})`).join(" → "),
    });
  }
  return rows;
});

// ── 查看诊断 ──
const openDiagnosis = ref(false);
function viewDiagnosis() { openDiagnosis.value = true; }
// ── 展开模块产物 ──
const openArtifact = ref(false);
function viewArtifactTable() { openArtifact.value = true; }

// ── 在画布打开工作界面: 把节点滚进视野并选中 ──
function focusNodeOnCanvas() {
  const n = selectedNode.value;
  if (!n) return;
  canvasRef.value?.focusNode?.(n.id);
  toast(`已定位到节点「${n.title}」`, "info");
}

/**
 * 让 Agent 调整此节点。
 *
 * 做法: 把这张卡片的**真实上下文**(能力/参数/依赖/诊断)拼成一条消息发进对话区,
 * 人再补充要求。**不直接替用户改参数** —— 参考产品这一条也是"交给 Agent", 不是"自动改"。
 */
function askAgentToAdjust() {
  const n = selectedNode.value;
  if (!n) return;
  const deps = depIdsOf(n.id);
  const lines = [
    `【调整节点】${n.title}(id: ${n.id})`,
    `能力: ${n.capabilityId || "未绑定"}`,
    deps.length ? `上游: ${deps.map((d) => `${evNodeLabel(d)}(${d})`).join(", ")}` : "上游: 无",
    paramFields.value.length
      ? `当前参数:\n${paramFields.value.map((f) => `  ${f.label}(${f.name}) = ${String((n.params ?? {})[f.name] ?? "(未设)")}`).join("\n")}`
      : "",
    selectedDiagnosis.value ? `上次失败原因: ${selectedDiagnosis.value}` : "",
    "",
    "请说明要怎么改(改哪个参数 / 换成哪个能力 / 调整上下游连接), 我照着改。",
  ].filter(Boolean);
  input.value = lines.join("\n");
  inputEl.value?.focus();
  toast("已把该节点信息填进对话, 补上你的要求后发送", "info");
}
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
        <!-- V416: 计划历史 —— 与「运行记录」是**两个视角**: 那边是"每步现在什么状态"(快照),
             这里是"依次发生过什么"(时间线, 含 node.failed 的中文诊断)。 -->
        <button class="hdr-btn" data-control="quick:plan-history" @click="openPlanHistory()">计划历史</button>
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
          <textarea ref="inputEl" v-model="input" rows="2" placeholder="描述研究需求…(节点与连线决定实际执行)" @keydown.enter.exact.prevent="pushMsg({ role: 'user', text: input }); input = ''"></textarea>
          <button class="send-button" :disabled="!input.trim()" @click="pushMsg({ role: 'user', text: input }); input = ''">↗</button>
        </div>
        <div class="run-actions">
          <button v-if="runState === 'draft'" class="run-btn" data-control="quick:start-run" @click="openHandoff">开始执行</button>
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
        <!--
          V416: 「按能力 / 按阶段」两个视图。
          ⚠ 为什么要有"按阶段"这一档: 能力面板是按**能力类别**(检索/写作/实证…)平的,
            而一个刚刚开始写论文的人脑子里的组织方式是**研究阶段**(我在第几步、这一步该做什么)。
            同一批能力换一种排法, 用户才找得到。两边指向的是同一批能力, 不是两套东西。
        -->
        <div class="palette-modes">
          <button class="palette-mode" :class="{ 'is-on': capMode === 'cap' }" @click="capMode = 'cap'">按能力</button>
          <button class="palette-mode" :class="{ 'is-on': capMode === 'stage' }" @click="capMode = 'stage'">按研究阶段</button>
        </div>
        <!-- V415: 自由创作节点 —— 平台里没有现成能力、但用户就是想加一步"按我的提示词做点事"时用。
             后端把没有 capabilityId 的节点当 llm_chat 执行(见 capability-registry 的 dagNodeToMetaStep),
             所以这里不需要新端点, 只需要一个能填标题+提示词的入口。 -->
        <button v-if="!locked" class="palette-create" @click="openCreateNode">＋ 创作能力节点</button>

        <!-- 阶段视图: 六个阶段各自列出内部步骤, 可执行的点「跑」(只跑这一步), 也可「加」到画布 -->
        <div v-if="capMode === 'stage'" class="stage-list">
          <div v-for="st in ALL_STAGES" :key="st.key" class="stage-block">
            <div class="stage-head">
              <span class="stage-ph">{{ st.ph }}</span>
              <strong>{{ st.title }}</strong>
              <!-- 不适用当前研究类型时**标出来**而不是藏掉(见 ALL_STAGES 的说明) -->
              <span v-if="st.appliesTo" class="stage-when">定量/混合研究适用</span>
            </div>
            <div
              v-for="(step, i) in st.steps ?? []"
              :key="step.key"
              class="stage-step"
              :class="{ 'is-manual': !step.capabilityId }"
            >
              <span class="ss-no">{{ i + 1 }}</span>
              <span class="ss-label">{{ step.label }}</span>
              <!-- 有能力的步: 两个动作 —— 单跑 / 加到画布; 没能力的只给落点 -->
              <template v-if="step.capabilityId">
                <button class="ss-btn" :disabled="locked" data-run-step="1" :title="'只跑这一步(' + step.capabilityId + ')'" @click="runSingleStep(st, step)">▶ 跑</button>
                <button class="ss-btn" :disabled="locked" title="加到画布(建一个节点)" @click="addStepAsNode(st, step)">＋</button>
              </template>
              <button v-else class="ss-btn ss-go" :title="'到「' + st.title + '」页做这一步'" @click="gotoStepPage(st, step)">去页面</button>
            </div>
          </div>
        </div>

        <div v-else class="palette-cats">
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
      <!-- V415: 声明式 DAG + 候选 —— 合并成一面, 占原画布位置(用户要求)。
           两处修正: ① 已注册/候选不再左右分栏, 改成上下两段(候选在下面);
                     ② 画布挪到页面下方通栏, 所以这一面能占满高度。 -->
      <section class="dag-panel">
        <!-- V418: 一句话生成流程 —— 后端 POST /research/projects/:id/nl-to-dag 早就实现了,
             但从没有任何前端调用过(2026-09-20 契约对账查出)。接在这里而不是另开一个
             "画布视图": 它产出的就是本画布能吃的那种图, 载入后与内置模板走**同一条**执行链,
             用户接着点「开始执行」即可 —— 而不是看着一个执行不了的图。 -->
        <div class="nl-dag-bar">
          <input
            v-model="nlDescription"
            class="nl-dag-input"
            placeholder="一句话描述研究需求, 让 AI 拆成可执行流程(如: 分析资本下乡对村级治理的影响)"
            data-control="quick:nl-input"
            :disabled="nlBusy || locked"
            @keydown.enter.exact.prevent="genFromNl"
          />
          <button
            class="hdr-btn is-primary"
            data-control="quick:nl-generate"
            :disabled="nlBusy || locked || !nlDescription.trim()"
            @click="genFromNl"
          >{{ nlBusy ? "拆解中…" : "生成流程" }}</button>
        </div>
        <header class="dag-strip-head">
          <div>
            <strong>声明式 DAG</strong>
            <span>与画布同一个执行引擎 · 打开后就是普通图, 随便改</span>
          </div>
          <button class="hdr-btn" :disabled="dagBusy" @click="loadMetaSkills(); loadProposals()">刷新</button>
        </header>

        <!-- ① 已注册的 DAG(独立滚动区, 条目多也不会把整页撑长) -->
        <div class="dag-row">
          <div class="dag-col-head">
            <span class="dag-badge">已注册 {{ metaSkills.length }}</span>
            <small>内置 + 提案通过后登记的 · 「运行」与「演示」共用下面这个输入</small>
          </div>
          <!-- V415: 任务输入必须**常驻**。第一版把它塞进了运行结果面板里, 而结果面板要有运行状态才显示 ——
               于是没输入就没法运行、没运行就不显示输入, 死锁(实测输入框数 0)。 -->
          <div class="ms-input-row">
            <input v-model="msTopic" class="dag-input" placeholder="任务输入(如: 资本下乡对村级治理的影响) — 「运行」「演示」都用它" />
          </div>
          <div class="dag-scroll">
            <div v-if="!metaLoaded" class="dag-empty">正在加载…</div>
            <div v-else-if="!metaSkills.length" class="dag-empty">还没有可打开的 DAG</div>
            <div v-for="m in metaSkills" :key="m.id" class="dag-item">
              <div class="dag-item-main">
                <strong>{{ m.name }}</strong>
                <small>{{ m.description }}</small>
              </div>
              <span class="dag-src" :class="{ 'is-builtin': m.source === 'builtin' }">{{ m.source === "builtin" ? "内置" : "已登记" }}</span>
              <span class="run-meta">{{ m.steps }} 步</span>
              <button class="workspace-secondary" :disabled="dagBusy || locked" @click="openMetaSkill(m.id)">打开到画布</button>
              <!-- V415: 直接从这跑这条 DAG(不用先打开到画布 —— 那是"改"的路径, 这是"用"的路径) -->
              <button class="workspace-secondary" data-control="quick:ms-run" :disabled="msBusy || !msTopic.trim()" @click="msRun(m.id)">▶ 运行</button>
              <button class="workspace-secondary" data-control="quick:ms-demo" :disabled="msBusy" title="零成本演示: 不调 LLM, 只把步骤按序点亮" @click="msPlayDemo(m)">🎬 演示</button>
            </div>
          </div>

          <!-- V415: 运行/演示的进度与产出(从 MetaSkill 面板搬来) -->
          <div v-if="msStatus || msStepLog.length" class="ms-run">
            <div class="ms-run-head">
              <span class="ms-tag" :class="{ 'is-demo': msDemo }">{{ msDemo ? "演示(零成本)" : "真实运行" }}</span>
              <span class="run-meta">{{ msRunId }} · {{ msStepLog.filter((s) => s.status === "done").length }}/{{ msStepLog.length }} 步</span>
              <button class="workspace-secondary" @click="msReset()">清空</button>
            </div>
            <div class="ms-steps">
              <div v-for="(s, i) in msStepLog" :key="s.stepId" class="ms-step" :class="'is-' + s.status">
                <span class="run-step-no">{{ String(i + 1).padStart(2, "0") }}</span>
                <span class="state-chip sm" :class="runMetaOf(s.status === 'done' ? 'done' : s.status).cls">{{ stepLabel(s.status) }}</span>
                <strong>{{ s.label || s.stepId }}</strong>
                <span class="run-meta">{{ s.kind }}</span>
                <div v-if="s.output" class="ms-step-out">{{ s.output.slice(0, 160) }}{{ s.output.length > 160 ? " …" : "" }}</div>
              </div>
            </div>
            <!-- 澄清表单(真实运行挂起时) -->
            <div v-if="msWaiting" class="ms-form">
              <div class="ms-form-title">这一步需要补充信息</div>
              <div v-for="f in msWaiting.waitingFields" :key="f.name" class="ms-form-row">
                <label>{{ f.prompt || f.name }}<span v-if="f.required" class="ms-req">*</span></label>
                <input v-model="msForm[f.name]" class="dag-input" :placeholder="f.prompt || f.name" />
              </div>
              <button class="workspace-primary" :disabled="!msFormReady" @click="msSubmitForm()">提交并继续</button>
            </div>
            <div v-if="msOutput" class="ms-final">
              <div class="ms-form-title">产出</div>
              <pre class="ms-final-text">{{ msOutput.slice(0, 1200) }}{{ msOutput.length > 1200 ? "\n…" : "" }}</pre>
            </div>
          </div>
        </div>

        <!-- ② 候选流程(提案) —— 人工审, 不自动注册 -->
        <div class="dag-row">
          <div class="dag-col-head">
            <span class="dag-badge">候选 {{ proposals.filter((p) => p.status === "proposed").length }}</span>
            <small>平台按高频任务攒的, 要你点头才进注册表</small>
          </div>
          <div class="dag-propose-row">
            <input v-model="proposeTopic" class="dag-input" placeholder="高频任务主题(如: 马理论选题与接口分析)" />
            <button class="workspace-primary" :disabled="dagBusy || !proposeTopic.trim()" @click="proposeDag">
              {{ dagBusy ? "组装中…" : "让平台组装一条" }}
            </button>
          </div>
          <div class="dag-scroll">
            <div v-if="!proposals.length" class="dag-empty">还没有候选</div>
            <div v-for="p in proposals" :key="p.id" class="dag-item" :class="{ 'is-done': p.status !== 'proposed' }">
              <div class="dag-item-main">
                <strong>{{ p.dag?.name || p.id }}</strong>
                <small>{{ p.dag?.description || p.triggerGoal }}</small>
                <!-- 来源可追溯: 哪几个已批准技能参与了这条流程(此前全是 null, 已修) -->
                <small v-if="p.sourceSkillNames?.length" class="dag-src-line">
                  来源技能: {{ p.sourceSkillNames.join("、") }}
                  <span v-if="!p.sourceSkillIds?.some((x) => x != null)" class="dag-warn">(id 缺失)</span>
                </small>
                <small class="dag-src-line">出现 {{ p.seenCount }} 次 · {{ p.dag?.steps?.length ?? 0 }} 步</small>
              </div>
              <span v-if="p.status === 'proposed'" class="dag-actions">
                <button class="workspace-secondary" :disabled="dagBusy" @click="actProposal(p.id, 'reject')">否决</button>
                <button class="workspace-primary" :disabled="dagBusy" @click="actProposal(p.id, 'accept')">接受</button>
              </span>
              <span v-else class="run-meta">{{ p.status === "accepted" ? "已接受" : "已否决" }}</span>
            </div>
          </div>
        </div>
      </section>
    </main>

    <!-- V415: 标准工作流画布 —— 从右栏挪到页面下方通栏(不与 DAG 面板争宽, 画布更大) -->
    <section class="canvas-band workspace-stage">
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
            <!-- V415: 这两项是原来有、我在重写时丢掉的(用户对照旧版发现的)。
                 新建空白任务 = 换一张干净的图继续排(不是清空当前思路), 所以给个默认起点节点;
                 清空画布则是真的清空, 要确认。 -->
            <div class="context-menu-sep"></div>
            <button class="context-menu-item" @click="newBlankCanvas">新建空白任务 <span>＋</span></button>
            <button class="context-menu-item is-danger" :disabled="!nodes.length" @click="clearCanvas">清空画布 <span>×</span></button>
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
            <!--
              V416: TASK INSPECTOR —— 只放**有真数据**的那一格。
              ⚠ AGENT 显示的是真实执行角色(ui→manager / agent→analyst), 不是参考产品那个
                产品名 "DAG Agent"。ATTEMPT / QUALITY 不做(后端没有这两个量, 见本段注释头)。
            -->
            <div class="inspector">
              <div class="insp-cell">
                <span class="insp-key">AGENT</span>
                <span class="insp-val">{{ runSource === "agent" ? "analyst 权限" : "manager 权限" }}</span>
              </div>
            </div>
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

            <!-- V416: 失败诊断 —— 有才显示。引擎留下的就是给用户看的中文, 没有就不占位 -->
            <div v-if="selectedDiagnosis" class="drawer-diag">
              <span class="diag-label">本次失败原因</span>
              <p class="diag-text">{{ selectedDiagnosis }}</p>
            </div>

            <!-- V416: 两个整宽动作按钮(参考产品图 12 的落点: 一个定位画布, 一个交给 Agent) -->
            <div class="node-actions">
              <button class="workspace-secondary wide" data-control="quick:focus-node" @click="focusNodeOnCanvas">在画布打开工作界面</button>
              <button class="workspace-secondary wide" data-control="quick:ask-agent-node" @click="askAgentToAdjust">让 Agent 调整此节点 ↗</button>
              <button class="workspace-secondary wide" data-control="quick:node-artifact" @click="viewArtifactTable">展开模块产物 ↗</button>
            </div>

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

    <!-- 模板库 -->
    <div v-if="openTemplates" class="modal-shell" @click.self="openTemplates = false">
      <div class="modal-card wide">
        <header class="modal-head"><strong>内置编排模板</strong><span>选中即载入画布, 之后可自由改 · 点「展开」先看内部结构</span><button class="workspace-close" @click="openTemplates = false">×</button></header>
        <div class="modal-body tpl-grid">
          <div
            v-for="t in templates"
            :key="t.id"
            class="tpl-card"
            :class="{ 'is-open': expandedTplId === t.id }"
            @click="applyTemplate(t.id); openTemplates = false"
          >
            <div class="tpl-head">
              <strong>{{ t.name }}</strong>
              <span class="tpl-cost" :class="COST_META[t.costEstimated ?? t.cost].cls">{{ COST_META[t.costEstimated ?? t.cost].label }}</span>
            </div>
            <p>{{ t.description }}</p>
            <small>{{ t.scenario }}</small>
            <div class="tpl-meta">
              {{ t.graph.nodes.length }} 节点 · {{ t.graph.edges.length }} 条连线
              <!--
                V416: 「展开」把这条模板内部的**节点与连线**摊开。
                前端本来就有完整 graph(templates 接口就带着), 所以不用改后端。
                ⚠ 展开按钮必须 stop 掉卡片的点击 —— 否则"想看结构"会变成"载入画布并关窗"。
              -->
              <button
                class="tpl-expand"
                :data-control="'quick:tpl-expand-' + t.id"
                @click.stop="expandedTplId = expandedTplId === t.id ? '' : t.id"
              >{{ expandedTplId === t.id ? "收起 ▾" : "展开 ▸" }}</button>
            </div>
            <!-- 展开区: 逐条列出节点, 并标出它连到哪里 -->
            <div v-if="expandedTplId === t.id" class="tpl-graph" @click.stop>
              <div class="tpl-graph-title">内部结构(载入画布后会变成节点与连线)</div>
              <div v-for="(n, i) in t.graph.nodes" :key="n.id" class="tpl-node">
                <span class="tn-no">{{ i + 1 }}</span>
                <span class="tn-id">{{ n.id }}</span>
                <span class="tn-title">{{ n.title }}</span>
                <span v-if="capById(n.capabilityId)" class="tn-cap">{{ capById(n.capabilityId)!.label }}</span>
                <span v-else class="tn-cap tn-cap-none">{{ n.capabilityId || "未绑能力" }}</span>
                <span v-if="nextOf(t, n.id).length" class="tn-to">→ {{ nextOf(t, n.id).join(", ") }}</span>
              </div>
            </div>
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

    <!--
      V416: 计划历史浮层(PLAN HISTORY)。
      ⚠ 按参考产品图 13 的要点: **空态与有记录态是同一个组件**, 不是两个 —— 两处空态
        (「暂无执行记录」/「暂无执行事件」) 就是同一段模板在列表为空时渲染的内容。
        做成两个组件的话, 以后改一处忘了另一处, 空态会慢慢长成另一个样子。
    -->
    <div v-if="openHistory" class="modal-shell" @click.self="closePlanHistory">
      <div class="modal-card wide">
        <header class="modal-head">
          <div class="ph-head">
            <span class="ph-kicker">PLAN HISTORY</span>
            <strong>计划版本与执行记录</strong>
          </div>
          <button class="workspace-close" @click="closePlanHistory">×</button>
        </header>
        <div class="modal-body ph-body">
          <!-- 执行记录: 本图跑过的各次运行 -->
          <div class="ph-section">
            <h4 class="ph-sec-title">执行记录</h4>
            <div v-if="!historyRuns.length" class="palette-empty">暂无执行记录</div>
            <div v-else class="ph-runs">
              <button
                v-for="r in historyRuns"
                :key="r.runId"
                class="ph-run"
                :class="{ 'is-on': r.runId === historyRunId }"
                @click="pickHistoryRun(r.runId)"
              >
                <i class="ph-run-dot" :class="runMetaOf(r.status).cls"></i>
                <span class="ph-run-id">{{ (r.graphId || r.runId).slice(0, 12) }}</span>
                <span class="ph-run-name">{{ r.graphName || (r.input || "").slice(0, 24) || "未命名编排" }}</span>
                <span class="ph-run-state">{{ runMetaOf(r.status).label }}</span>
              </button>
            </div>
          </div>

          <!-- 当前事件: 实时事件时间线 -->
          <div class="ph-section">
            <h4 class="ph-sec-title">
              当前事件
              <span v-if="historyRunId" class="ph-sec-sub">{{ historyRunId }}</span>
            </h4>
            <!-- 两种"空"要分开说: 表没迁到 vs 真的没事件 -->
            <div v-if="!historyAvailable" class="palette-empty">
              本环境还没有事件记录(数据库未迁移到迁移 161), 只能看上面的执行记录
            </div>
            <div v-else-if="historyLoading && !historyEvents.length" class="palette-empty">读取中…</div>
            <div v-else-if="!historyEvents.length" class="palette-empty">暂无执行事件</div>
            <ol v-else class="ph-events">
              <li v-for="ev in historyEvents" :key="ev.seq" class="ph-ev" :class="'fam-' + eventFamily(ev.event)">
                <span class="ph-ev-time">{{ evTime(ev.createdAt) }}</span>
                <span class="ph-ev-name">{{ ev.event }}</span>
                <span class="ph-ev-node">{{ evNodeLabel(ev.nodeId) }}</span>
                <span class="ph-ev-msg">{{ ev.message || evLabel(ev.event) }}</span>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>

    <!--
      V416: 展开模块产物(参考产品图 17)。
      ⚠ 图 17 的要点有两条, 都照做:
        ① 左列固定字段名, 右列**自动换行**(长值不撑破) —— 见 .art-table 的 grid 定义;
        ② 展示的是**原始值**(含 JSON 数组), 不做美化 —— 用户要能核对 "Agent 到底拿到了什么"。
      没有可展示的行时**显示"尚未执行"**, 不编一份假输入出来。
    -->
    <div v-if="openArtifact && selectedNode" class="modal-shell" @click.self="openArtifact = false">
      <div class="modal-card wide">
        <header class="modal-head">
          <div class="ph-head">
            <span class="ph-kicker">{{ selectedNode.module }}</span>
            <strong>{{ selectedNode.title }} · 模块产物</strong>
          </div>
          <button class="hdr-btn" data-control="quick:artifact-diagnosis" @click="openArtifact = false; viewDiagnosis()">查看诊断</button>
          <button class="workspace-close" @click="openArtifact = false">×</button>
        </header>
        <div class="modal-body">
          <div v-if="!artifactRows.length && !selectedArtifact" class="palette-empty">
            尚未执行 —— 这个节点还没跑过, 没有可展开的输入与产物
          </div>
          <template v-else>
            <h4 v-if="artifactRows.length" class="ph-sec-title">节点输入(原始值)</h4>
            <table v-if="artifactRows.length" class="art-table">
              <tbody>
                <tr v-for="row in artifactRows" :key="row.name">
                  <td class="art-k">{{ row.name }}</td>
                  <td class="art-v">{{ row.value }}</td>
                </tr>
              </tbody>
            </table>
            <template v-if="selectedArtifact">
              <h4 class="ph-sec-title">本次产出(原始输出)</h4>
              <pre class="art-out">{{ selectedArtifact }}</pre>
            </template>
          </template>
        </div>
      </div>
    </div>

    <!--
      V416: 查看诊断。
      参考产品图 17 里它是抽屉右上角的一个入口。**只在真有诊断时才是一个动作** ——
      否则点了会得到一个空浮层。所以: 无诊断时按钮禁用并说明原因, 而不是点了没反应。
    -->
    <div v-if="openDiagnosis && selectedNode" class="modal-shell" @click.self="openDiagnosis = false">
      <div class="modal-card">
        <header class="modal-head">
          <div class="ph-head">
            <span class="ph-kicker">DIAGNOSIS</span>
            <strong>{{ selectedNode.title }} · 诊断</strong>
          </div>
          <button class="workspace-close" @click="openDiagnosis = false">×</button>
        </header>
        <div class="modal-body">
          <template v-if="selectedDiagnosis">
            <h4 class="ph-sec-title">失败原因</h4>
            <p class="diag-text">{{ selectedDiagnosis }}</p>
          </template>
          <div v-else-if="selectedStep" class="diag-ok">
            这次运行里该节点没有失败记录(状态: {{ stepLabel(selectedStep.status) }})。
          </div>
          <div v-else class="palette-empty">
            该节点还没有运行记录 —— 先执行一次才谈得上诊断
          </div>
          <template v-if="selectedStep">
            <h4 class="ph-sec-title">这一步的执行事实</h4>
            <table class="art-table">
              <tbody>
                <tr><td class="art-k">stepId</td><td class="art-v">{{ selectedStep.stepId }}</td></tr>
                <tr><td class="art-k">kind</td><td class="art-v">{{ selectedStep.kind }}</td></tr>
                <tr><td class="art-k">status</td><td class="art-v">{{ selectedStep.status }}</td></tr>
                <tr v-if="selectedStep.durationMs !== undefined"><td class="art-k">durationMs</td><td class="art-v">{{ selectedStep.durationMs }}</td></tr>
                <tr v-if="selectedStep.inputsFrom?.length"><td class="art-k">inputsFrom</td><td class="art-v">{{ selectedStep.inputsFrom.join(", ") }}</td></tr>
              </tbody>
            </table>
          </template>
        </div>
      </div>
    </div>

    <!--
      V416: AGENT HANDOFF —— 启动确认层(参考产品图 14)。
      与下面那个 `canvas-start-gate`(空画布提示)是**两件事**, 不要合并:
        gate 说的是"画布是空的, 去加节点"; 这里是"图已经建好, 请确认要授权执行什么"。
      参考产品那张图把将执行的节点**逐条列出来**, 而不是只说"N 个节点" —— 照做。
    -->
    <div v-if="handoffOpen" class="modal-shell" @click.self="handoffOpen = false">
      <div class="modal-card">
        <div class="modal-body handoff-body">
          <span class="handoff-kicker">AGENT HANDOFF</span>
          <h3 class="handoff-title">画板流程已构筑，是否启动？</h3>
          <p class="handoff-note">确认后，Agent 将按当前版本执行。该授权只对这份计划有效。</p>
          <div class="handoff-box">
            <span class="handoff-box-title">{{ handoffNodes.length }} 个工具节点</span>
            <ol class="handoff-list">
              <li v-for="n in handoffNodes" :key="n.id">
                <code>{{ n.id }}</code>
                <span class="handoff-sep">·</span>
                <span class="handoff-cap">{{ n.cap }}</span>
              </li>
            </ol>
          </div>
        </div>
        <footer class="workspace-panel-footer">
          <button class="workspace-secondary" @click="handoffOpen = false">返回</button>
          <div>
            <button class="workspace-primary handoff-go" data-control="quick:handoff-confirm" @click="confirmHandoff">确认并启动</button>
          </div>
        </footer>
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
  --ink: #E8EEF7; --muted: #8B9BB1; --line: #222F44; --soft: var(--wf-sunken); --blue: #4D84CB;
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
  background: #1F2430; color: #8B9BB1; border: 1px solid var(--wf-line-strong); white-space: nowrap;
}
.agent-chip:hover { border-color: #4D84CB; color: #DCE6F2; }
.agent-chip.is-on { background: #14281F; color: #5FD0B4; border-color: #2F6B55; }
.agent-dot { width: 6px; height: 6px; border-radius: 50%; background: #6E7F96; }
.agent-chip.is-on .agent-dot { background: #5FD0B4; box-shadow: 0 0 0 2px rgba(95, 208, 180, 0.2); }
.hdr-select {
  border: 1px solid var(--wf-line-strong); border-radius: 7px; background: var(--wf-sunken); color: #DCE6F2;
  font-size: 11px; padding: 5px 8px; font-family: inherit; outline: none; max-width: 190px;
}
.hdr-select:disabled { opacity: 0.55; }
.hdr-btn {
  border: 1px solid var(--wf-line-strong); border-radius: 7px; background: transparent; color: #A3B3C8;
  font-size: 11px; padding: 5px 11px; cursor: pointer;
}
.hdr-btn:hover:not(:disabled) { background: #1A2333; color: #DCE6F2; }
.hdr-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* 空间够时铺满(不出现滚动条), 空间不够时由 .quick-view 滚动而不是把面板压扁 */
/* V415: 上方三块(助手/能力/DAG)的高度 —— 用视口比例而不是 flex:1, 让画布也拿到足够高度。
   0.58 是"上排明显变高但画布仍占大头"的折中; 下限 420 保证小窗口不塌, 上限 760 防超宽屏过高。 */
.quick-shell { flex: none; height: clamp(440px, 62vh, 820px); display: flex; }
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
.artifact-icon { width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0; display: grid; place-items: center; font-size: 15px; background: #1C2740; border: 1px solid var(--wf-line-strong); }
.artifact-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.artifact-body strong { font-size: 12.5px; }
.artifact-body p { margin: 0; font-size: 11px; color: #93A5BC; }
.composer { display: flex; align-items: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); }
.composer textarea {
  flex: 1; resize: none; border: 1px solid #222F44; border-radius: 10px; padding: 8px 11px;
  font-size: 12.5px; font-family: inherit; line-height: 1.5; outline: none;
  background: var(--wf-sunken); color: #E8EEF7;
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
.context-menu-sep { height: 1px; margin: 5px 4px; background: #1E2A42; }
/* V415: 页面下方的声明式 DAG 区 */
/* V415: 声明式 DAG + 候选合并成一面, 占原画布位置(用户要求: 先看到可复用的流程, 再往下看画布) */
.dag-panel {
  flex: 1; min-width: 0; min-height: 0;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 16px;
  /* V415: overflow 必须是 auto —— 原来是 hidden, 而两行都 flex:1 + min-height:0 会被压缩,
     第一行的内容(运行面板)溢出后**不裁剪**, 被后画的候选行盖住。实测后果: 提交按钮的
     中心点上最上层元素是候选列表的文字, 坐标点击根本点不到按钮(POST 一次都没发出去),
     而派发事件却能通 —— 功能没问题, 是被盖住了。 */
  overflow-y: auto;
  background: #0C1424; border-left: 1px solid var(--line);
}
/* 正常流: 行按内容取高, 谁都不压谁(压缩式 flex 正是上面那个重叠的成因) */
.dag-row { display: flex; flex-direction: column; gap: 5px; flex: none; }
/* 独立滚动区: 条目多时在这一条里滚, 不把整页撑长(用户要求"弄个框子能在里面上下滑") */
.dag-scroll {
  max-height: 200px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 5px;
  border: 1px solid #1E2A42; border-radius: 10px; padding: 7px; background: #0A1220;
}
.dag-scroll::-webkit-scrollbar { width: 8px; }
.dag-scroll::-webkit-scrollbar-thumb { background: var(--wf-line-strong); border-radius: 4px; }
/* 画布通栏: 给足高度让 DAG 画得开(原来挤在右栏里只有半宽)。
   0.62 视口比 + 下限 520 —— 上排变高后画布也要跟着变高, 不是被挤掉。 */
.canvas-band { flex: none; height: clamp(560px, 68vh, 1000px); }
.dag-strip-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
/* V418: 一句话生成流程 —— 与下方 DAG 列表同栏, 视觉上属于"图"那一块而不是助手区 */
.nl-dag-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.nl-dag-input {
  flex: 1; min-width: 0; background: #0E1626; border: 1px solid #24344E; border-radius: 7px;
  color: #DCE6F2; font-size: 11.5px; padding: 6px 10px;
}
.nl-dag-input:focus { outline: none; border-color: #3C5A85; }
.nl-dag-input:disabled { opacity: 0.5; }
.hdr-btn.is-primary { border-color: #3C5A85; color: #CFE0F5; background: #16294A; }
.hdr-btn.is-primary:hover:not(:disabled) { background: #1E355C; color: #EAF2FC; }
.dag-strip-head strong { font-size: 12.5px; color: #E8EEF7; margin-right: 8px; }
.dag-strip-head span { font-size: 10.5px; color: #7A8AA0; }
.dag-col-head { display: flex; align-items: baseline; gap: 7px; margin-bottom: 2px; }
.dag-col-head small { font-size: 10px; color: #6E7F96; }
.dag-badge { font-size: 10px; font-weight: 700; color: #9FC0E8; background: #1E2A48; border-radius: 9px; padding: 2px 9px; }
.dag-empty { font-size: 11px; color: #6E7F96; padding: 8px 10px; }
.dag-item { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border: 1px solid #1E2A42; border-radius: 9px; background: #11192C; font-size: 11.5px; }
.dag-item.is-done { opacity: 0.62; }
.dag-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dag-item-main strong { color: #DCE6F2; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dag-item-main small { color: #7A8AA0; font-size: 10.5px; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; }
.dag-src { font-size: 9.5px; padding: 2px 8px; border-radius: 9px; background: #2A2414; color: #E8B54A; flex-shrink: 0; }
.dag-src.is-builtin { background: #14281F; color: #5FD0B4; }
.dag-src-line { white-space: normal !important; }
.dag-warn { color: #E8B54A; }
.dag-actions { display: flex; gap: 6px; flex-shrink: 0; }
.dag-propose-row { display: flex; gap: 7px; margin-bottom: 3px; }/* V415: 运行/演示面板(从 MetaSkill 面板搬来) */
/* V415: 这里**不要**再限高/自己滚 —— 加了 max-height:260 之后, 澄清表单的提交按钮被算在
   260px 之外(实测按钮布局在 y=579 而面板底在 y=507), 被自己的小框裁掉: 用户得先在这个小框里
   滚动才找得到按钮, 自动化探针则直接点穿到下层元素。滚动只留 .dag-panel 一处。 */
.ms-run { border: 1px solid var(--wf-line-strong); border-radius: 10px; background: #0E1626; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.ms-run-head { display: flex; align-items: center; gap: 8px; }
.ms-tag { font-size: 9.5px; font-weight: 700; padding: 2px 8px; border-radius: 9px; background: #1E2A48; color: #6FA6E8; }
.ms-tag.is-demo { background: #2A2414; color: #E8B54A; }
.ms-input-row { display: flex; gap: 6px; }
.ms-input-row .dag-input { flex: 1; }
.ms-steps { display: flex; flex-direction: column; gap: 4px; }
.ms-step { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 5px 7px; border-radius: 7px; background: #111C30; font-size: 11px; }
.ms-step.is-running { border-left: 2px solid #7184f5; }
.ms-step.is-done { border-left: 2px solid #5FD0B4; }
.ms-step.is-waiting_input { border-left: 2px solid #E8B54A; }
.ms-step.is-failed { border-left: 2px solid #F08A8A; }
.ms-step strong { color: #DCE6F2; font-size: 11.5px; }
.ms-step-out { flex-basis: 100%; color: #93A5BC; font-size: 10px; line-height: 1.5; }
.ms-form { border-top: 1px solid #1E2A42; padding-top: 6px; display: flex; flex-direction: column; gap: 5px; }
.ms-form-title { font-size: 10.5px; font-weight: 700; color: #9FC0E8; }
.ms-form-row { display: flex; align-items: center; gap: 8px; }
.ms-form-row label { font-size: 11px; color: #A9BBD0; min-width: 90px; }
.ms-form-row .dag-input { flex: 1; }
.ms-req { color: #E8B54A; margin-left: 2px; }
.ms-final { border-top: 1px solid #1E2A42; padding-top: 6px; }
.ms-final-text { margin: 4px 0 0; max-height: 140px; overflow: auto; white-space: pre-wrap; font-size: 10.5px; line-height: 1.6; color: #A9BBD0; font-family: inherit; }
.dag-input { border: 1px solid #22304A; border-radius: 7px; background: #141D33; color: #E8EEF7; font-size: 11px; padding: 5px 8px; font-family: inherit; outline: none; min-width: 0; }
.dag-propose-row .dag-input { flex: 1; }
.context-menu-item:hover { background: #1E2A48; color: #9FC0E8; }
.context-menu-item span { color: #7A8AA0; }
.context-menu-item.is-danger { color: #F08A8A; }
.context-menu-item.is-danger:hover { background: #2A1C1C; }
.ctx-backdrop { position: absolute; inset: 0; z-index: 19; }

.input-overlay { position: absolute; inset: 0; z-index: 25; display: grid; place-items: center; background: rgba(4, 8, 16, 0.6); backdrop-filter: blur(1px); }
.input-card { width: min(460px, 90%); background: #141D33; border: 1px solid var(--wf-line-strong); border-radius: 12px; overflow: hidden; }
.input-card header { padding: 12px 16px 9px; border-bottom: 1px solid #222F44; }
.input-card header strong { display: block; font-size: 13px; color: #E8EEF7; }
.input-card header span { font-size: 10.5px; color: #7A8AA0; }
.input-body { padding: 13px 16px; display: flex; flex-direction: column; gap: 10px; max-height: 50vh; overflow-y: auto; }
.input-card footer { padding: 10px 16px; border-top: 1px solid #222F44; background: #141D33; text-align: right; }

/* V415: 改为 left/top 定位(可由用户拖动); 高度仍随容器, 避免拖出去看不见内容 */
.workspace-panel {
  position: absolute; width: 340px; max-height: calc(100% - 24px); z-index: 9;
  display: flex; flex-direction: column;
  background: #11192C; border: 1px solid var(--wf-line-strong); border-radius: 12px;
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
  border: 1px solid var(--wf-line-strong); border-radius: 8px; background: var(--wf-sunken);
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
.workspace-secondary { border: 1px solid var(--wf-line-strong); background: transparent; color: #A3B3C8; }
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
  width: 100%; min-height: 110px; margin-top: 6px; border: 1px solid var(--wf-line-strong); border-radius: 8px;
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
.modal-card { width: min(560px, 92%); max-height: 82vh; display: flex; flex-direction: column; background: #131C30; border: 1px solid var(--wf-line-strong); border-radius: 12px; overflow: hidden; }
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
  position: absolute; inset: 0; border-radius: 22px; background: var(--wf-line-strong); transition: background 0.2s;
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
  .canvas-band { height: auto; min-height: 560px; }
  .dag-panel { border-left: 0; border-top: 1px solid var(--line); }
  .workspace-panel { top: auto; right: 8px; bottom: 8px; left: 8px; width: auto; max-height: 60%; }
}

/* V416: 计划历史浮层 */
.ph-head { display: flex; flex-direction: column; gap: 2px; }
.ph-kicker { font-size: 9.5px; letter-spacing: 0.14em; color: #7A8AA0; }
.ph-head strong { font-size: 13.5px; color: #E8EEF7; }
.ph-body { display: flex; flex-direction: column; gap: 16px; }
.ph-section { display: flex; flex-direction: column; gap: 7px; }
.ph-sec-title { margin: 0; font-size: 11px; font-weight: 600; color: #9FB0C6; letter-spacing: 0.05em; }
.ph-sec-sub { margin-left: 8px; font-weight: 400; color: #5C6B80; font-size: 10px; }
.ph-runs { display: flex; flex-direction: column; gap: 4px; max-height: 168px; overflow-y: auto; }
/* 执行记录那一行: 状态圆点 + 短 id + 图名 + 右侧状态字(参考产品图 10 的卡片形态) */
.ph-run {
  display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
  padding: 6px 10px; border: 1px solid #1E2A40; border-radius: 7px;
  background: #0D1526; color: #DCE6F2; font-size: 11.5px; cursor: pointer;
}
.ph-run:hover { border-color: #2E3E5C; }
.ph-run.is-on { border-color: #4D84CB; background: #13203A; }
.ph-run-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: #5C6B80; }
/* 运行中 = 蓝点(参考产品图 10: 蓝点 + 右侧"运行中") */
.ph-run-dot.st-running { background: #4D84CB; }
.ph-run-dot.st-completed { background: #5FD0B4; }
.ph-run-dot.st-failed { background: #D9706A; }
.ph-run-dot.st-paused, .ph-run-dot.st-waiting { background: #E8B54A; }
.ph-run-dot.st-cancelled, .ph-run-dot.st-draft { background: #5C6B80; }
.ph-run-id { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; color: #9FC0E8; flex-shrink: 0; }
.ph-run-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #A3B3C8; }
.ph-run-state { color: #7A8AA0; flex-shrink: 0; }
.ph-events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; }
/* 时间线一行: 时间(等宽, 不跳动) + 事件名 + 节点 + 说明。长说明换行, 不撑破容器 */
.ph-ev {
  display: grid; grid-template-columns: 62px 132px minmax(70px, auto) 1fr;
  gap: 8px; align-items: baseline; padding: 4px 8px; border-radius: 5px; font-size: 11px;
  border-left: 2px solid transparent;
}
.ph-ev.fam-job { border-left-color: #4D84CB; }
.ph-ev.fam-node { border-left-color: #2E3E5C; }
.ph-ev-time { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; color: #6B7A90; }
.ph-ev-name { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; color: #9FC0E8; }
.ph-ev-node { color: #A3B3C8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph-ev-msg { color: #7A8AA0; line-height: 1.6; overflow-wrap: anywhere; }

/* V416: 节点详情 —— TASK INSPECTOR / 诊断 / 动作按钮 */
.inspector { display: flex; gap: 8px; margin: 8px 0 2px; }
.insp-cell { flex: 1; display: flex; flex-direction: column; gap: 2px; padding: 6px 9px; border: 1px solid #1E2A40; border-radius: 7px; background: #0D1526; }
.insp-key { font-size: 9px; letter-spacing: 0.1em; color: #6B7A90; }
.insp-val { font-size: 11.5px; color: #DCE6F2; }
.drawer-diag { margin: 8px 0; padding: 8px 10px; border: 1px solid #4A2A2A; border-left: 2px solid #D9706A; border-radius: 6px; background: #1E1414; }
.diag-label { font-size: 9.5px; letter-spacing: 0.08em; color: #D9706A; }
.diag-text { margin: 5px 0 0; font-size: 11.5px; line-height: 1.65; color: #E0C4C2; overflow-wrap: anywhere; }
.diag-ok { font-size: 11.5px; line-height: 1.7; color: #6FD08C; }
/* 两个整宽动作按钮(参考产品图 12) */
.node-actions { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 2px; }
.workspace-secondary.wide { width: 100%; justify-content: center; }
/* 模块产物表: 左列固定字段名, 右列自动换行(图 17 的布局要点) */
.art-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.art-table .art-k {
  width: 132px; vertical-align: top; padding: 6px 9px 6px 0;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 11px; color: #9FC0E8; overflow-wrap: anywhere; border-bottom: 1px solid #1A2333;
}
.art-table .art-v {
  vertical-align: top; padding: 6px 0; font-size: 11.5px; line-height: 1.7;
  color: #DCE6F2; overflow-wrap: anywhere; white-space: pre-wrap; border-bottom: 1px solid #1A2333;
}
.art-out {
  margin: 0; padding: 10px; max-height: 40vh; overflow: auto; border: 1px solid #1E2A40; border-radius: 7px;
  background: #0D1526; color: #DCE6F2; font-size: 11px; line-height: 1.7;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere;
}
/* V416: AGENT HANDOFF 确认层 */
.handoff-body { display: flex; flex-direction: column; gap: 8px; }
.handoff-kicker { font-size: 9.5px; letter-spacing: 0.14em; color: #9B7BE0; }
.handoff-title { margin: 0; font-size: 15px; color: #E8EEF7; }
.handoff-note { margin: 0; font-size: 11.5px; line-height: 1.7; color: #A3B3C8; }
.handoff-box { margin-top: 4px; padding: 10px 12px; border-radius: 8px; background: #0D1526; border: 1px solid #1E2A40; }
.handoff-box-title { font-size: 11px; color: #9FB0C6; }
.handoff-list { list-style: none; margin: 7px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 34vh; overflow-y: auto; }
.handoff-list li { display: flex; align-items: baseline; gap: 6px; font-size: 11.5px; flex-wrap: wrap; }
.handoff-list code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; color: #9FC0E8; }
.handoff-sep { color: #4A5A72; }
.handoff-cap { color: #7A8AA0; overflow-wrap: anywhere; }
/* 紫底主按钮(参考产品图 14: 「确认并启动」是紫色, 与普通主色区分开) */
.handoff-go { background: #7c3aed !important; border-color: #7c3aed !important; color: #F1F5F9 !important; }
.handoff-go:hover { background: #6d31d6 !important; }

/* V416: 能力面板的「按能力 / 按研究阶段」两个视图 + 阶段步骤列表 */
.palette-modes { display: flex; gap: 4px; padding: 0 8px 6px; }
.palette-mode {
  flex: 1; padding: 4px 0; border: 1px solid #1E2A42; border-radius: 6px;
  background: #0F172A; color: #7A8AA0; font-size: 11px; cursor: pointer;
}
.palette-mode:hover { color: #DCE6F2; border-color: #2E3E5C; }
.palette-mode.is-on { background: #1B2C4A; border-color: #4D84CB; color: #E8EEF7; }
.stage-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 10px; display: flex; flex-direction: column; gap: 10px; }
.stage-block { border: 1px solid #1E2A42; border-radius: 8px; background: #101A2E; padding: 7px 8px; }
.stage-head { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.stage-ph {
  width: 18px; height: 18px; border-radius: 5px; background: #4D84CB; color: #0A1120;
  font-size: 10px; font-weight: 700; display: grid; place-items: center; flex-shrink: 0;
}
.stage-head strong { font-size: 12px; color: #E8EEF7; }
.stage-when { margin-left: auto; font-size: 9.5px; color: #E8B54A; }
/* 一步一行: 序号 + 名称 + 动作 */
.stage-step { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 11.5px; }
.stage-step.is-manual .ss-label { color: #7A8AA0; }
.ss-no {
  width: 15px; height: 15px; border-radius: 50%; background: #1E2A42; color: #9FB0C6;
  font-size: 9px; display: grid; place-items: center; flex-shrink: 0;
}
.ss-label { flex: 1; min-width: 0; color: #DCE6F2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-btn {
  flex-shrink: 0; padding: 2px 7px; border: 1px solid #1E2A42; border-radius: 5px;
  background: #16233A; color: #9FC0E8; font-size: 10px; cursor: pointer;
}
.ss-btn:hover:not(:disabled) { background: #1B2C4A; border-color: #4D84CB; color: #E8EEF7; }
.ss-btn:disabled { opacity: 0.4; cursor: default; }
.ss-go { color: #A3B3C8; }

/* V416: 模板库的"展开看内部结构" */
.tpl-card.is-open { border-color: #4D84CB; }
.tpl-expand {
  margin-left: auto; padding: 1px 7px; border: 1px solid #1E2A42; border-radius: 5px;
  background: #16233A; color: #9FC0E8; font-size: 10px; cursor: pointer;
}
.tpl-expand:hover { background: #1B2C4A; border-color: #4D84CB; color: #E8EEF7; }
.tpl-meta { display: flex; align-items: center; gap: 8px; }
.tpl-graph { margin-top: 8px; padding: 8px; border-top: 1px dashed #1E2A42; display: flex; flex-direction: column; gap: 3px; }
.tpl-graph-title { font-size: 10px; color: #7A8AA0; margin-bottom: 3px; }
.tpl-node { display: flex; align-items: baseline; gap: 6px; font-size: 11px; flex-wrap: wrap; }
.tn-no { width: 14px; height: 14px; border-radius: 50%; background: #1E2A42; color: #9FB0C6; font-size: 9px; display: grid; place-items: center; flex-shrink: 0; }
.tn-id { font-family: ui-monospace, Consolas, monospace; color: #9FC0E8; font-size: 10px; }
.tn-title { color: #DCE6F2; }
.tn-cap { color: #7A8AA0; font-size: 10px; }
.tn-cap-none { color: #E8B54A; }
.tn-to { color: #5C6B80; font-size: 10px; margin-left: auto; }
</style>
