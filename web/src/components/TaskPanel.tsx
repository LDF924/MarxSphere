// TaskPanel.tsx — 自主任务面板（2026-08-07 P2）
// 输入目标 → LLM 拆解子任务 → 逐项执行（进度条+每步状态）→ 暂停/恢复/取消干预
import { useEffect, useRef, useState, type FC } from "react";
import { ChevronDown, Loader2, Play, Pause, XCircle, ListChecks, Target, CheckCircle2, XCircle as X, ChevronRight, Sparkles, Trash2, Download, Plug, Clock, Pencil, MessageSquare, ThumbsUp, ThumbsDown, GitBranch, Terminal } from "lucide-react";
import { cn } from "../lib/utils";
import { LlmModelSelector, TASK_ROLES } from "./LlmModelSelector";

interface TaskStep {
  id: string;
  title: string;
  type: "retrieve" | "reason" | "write" | "review";
  query?: string;
  status: "pending" | "running" | "done" | "failed";
  result?: string;
  /** 2026-08-07 步骤详情（展开查看：来源/结果全文/说明） */
  detail?: string;
  source?: string;
}
interface TaskRecord {
  id: string;
  goal: string;
  status: "planning" | "running" | "paused" | "awaiting_approval" | "completed" | "failed" | "cancelled";
  plan: TaskStep[];
  currentStep: number;
  progress?: string;
  result?: string;
  loopCount?: number;
  reflectLog?: Array<{ round: number; verdict: string; score: number; issues: string[]; action: string }>;
  approvalRequest?: { stepIdx: number; title: string; action: string; reason: string } | null;
  costSummary?: { totalCostCents: number; totalTokens: number; execCount: number; byTool: Array<{ tool: string; costCents: number; count: number }> };
  /** V395-6: 成本预估(分)与实际(分) */
  estimatedCostCents?: number;
  actualCostCents?: number;
  /** W2: LLM judge 推理质量分(0-1) */
  judgeScore?: number | null;
  /** W6: 任务归属用户 */
  userId?: string | null;
  /** V394-5: 任务链（续作关联） */
  parentTaskId?: string;
  /** 差距O①: 用户反馈（1 赞 / -1 踩 / 0 无） */
  userFeedback?: number;
  createdAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  retrieve: "检索", reason: "推理", write: "写作", review: "评审",
};

const taskApi = {
  async create(goal: string, opts?: { target?: string }): Promise<TaskRecord> {
    const res = await fetch("/api/agent/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, ...(opts?.target && opts.target !== "local" ? { target: opts.target } : {}) }),
    });
    return (await res.json()).task;
  },
  async run(id: string): Promise<void> {
    await fetch(`/api/agent/tasks/${id}/run`, { method: "POST" });
  },
  async control(id: string, action: "pause" | "resume" | "cancel"): Promise<TaskRecord> {
    const res = await fetch(`/api/agent/tasks/${id}/control`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    return (await res.json()).task;
  },
  // V391(P0-4): 审批高危步骤; V396-11: 四态(action)
  async approve(id: string, approve: boolean, note?: string, action: "approve" | "edit" | "reject" | "respond" = approve ? "approve" : "reject"): Promise<TaskRecord> {
    const res = await fetch(`/api/agent/tasks/${id}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve, note, action }),
    });
    return (await res.json()).task;
  },
  // G12: 分页加载 — offset/limit 参数, 返回 {tasks, hasMore}
  async list(offset = 0, limit = 20): Promise<{ tasks: TaskRecord[]; hasMore: boolean }> {
    const res = await fetch(`/api/agent/tasks?offset=${offset}&limit=${limit}`);
    const data = await res.json();
    const tasks = data.tasks || [];
    // V391(P2-5): 拉取成本摘要（并行, 失败静默）
    await Promise.all(tasks.map(async (t: TaskRecord) => {
      try {
        const r = await fetch(`/api/agent/logs/cost-summary?taskId=${t.id}`);
        t.costSummary = (await r.json()).summary;
      } catch { /* 成本拉取失败忽略 */ }
    }));
    return { tasks, hasMore: !!data.page?.hasMore };
  },
  // V394-8: 模板创建
  async createFromTemplate(templateId: string, goal: string): Promise<TaskRecord> {
    const res = await fetch("/api/agent/tasks/from-template", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId, goal }),
    });
    return (await res.json()).task;
  },
  // V394-5: 续作（任务链）
  async createChild(parentTaskId: string, goal: string): Promise<TaskRecord> {
    const res = await fetch("/api/agent/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, parentTaskId }),
    });
    return (await res.json()).task;
  },
  // V394-4: 队列状态
  async queueStatus(): Promise<{ queued: number; running: number; maxConcurrent: number; items: Array<{ taskId: string; priority: number }> }> {
    const res = await fetch("/api/agent/queue");
    return (await res.json()).queue;
  },
  // V394-7: 对话式指挥
  async chat(message: string, sessionId?: string): Promise<{ ok: boolean; taskId?: string; goal?: string; error?: string; note?: string; sessionId?: string; history?: Array<{ role: string; content: string }> }> {
    const res = await fetch("/api/agent/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId }),
    });
    return res.json();
  },
  // V391(P2-1): 主管-工人编排
  async orchestrate(goal: string): Promise<{ taskId: string }> {
    const res = await fetch("/api/agent/orchestrate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal }),
    });
    return res.json();
  },
};

export const TaskPanel: FC = () => {
  const [goal, setGoal] = useState("");
  // wisp借鉴: 计算上下文选择（local/wsl/ssh/gpu — 创建任务时透传, 步骤执行用）
  const [runTarget, setRunTarget] = useState("local");
  const [remoteStatus, setRemoteStatus] = useState<{ ssh: boolean; gpu: boolean }>({ ssh: false, gpu: false });
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<string | null>(null);
  // 2026-08-07 步骤详情展开态（key = taskId:stepId）
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  // V394-4/7/8: 队列状态 + 模板 + 对话指挥
  const [queue, setQueue] = useState<{ queued: number; running: number; maxConcurrent: number }>({ queued: 0, running: 0, maxConcurrent: 2 });
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; desc: string; stepCount: number }>>([]);
  // 差距D/F: Agent 预设模式（学术研究/数据分析/论文写作/代码开发）
  const [presetId, setPresetId] = useState("academic");
  const [presets, setPresets] = useState<Array<{ id: string; label: string; desc: string }>>([]);
  const loadPresets = async () => {
    try {
      const r = await fetch("/api/agent/presets");
      const d = await r.json();
      setPresets(d.presets || []);
      setPresetId(d.active || "academic");
    } catch { /* 预设加载失败忽略 */ }
  };
  const switchPreset = async (id: string) => {
    setPresetId(id);
    try {
      await fetch("/api/agent/presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    } catch { /* 切换失败忽略 */ }
  };
  const [chatMsg, setChatMsg] = useState("");
  const [chatReply, setChatReply] = useState("");
  // 2026-08-07 演示：模拟任务创建 → 计划生成 → 子任务逐步执行
  const [demoPlaying, setDemoPlaying] = useState(false);
  const demoTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // V395-2: SSE 流式进度 — EventSource 连接 ref（任务运行时推送, 断开自动重连）
  const sseRef = useRef<EventSource | null>(null);
  // V395-7: 运行日志实时查看 — 当前任务实时日志行
  const [liveLogs, setLiveLogs] = useState<Array<{ ts: string; text: string; kind?: string }>>([]);
  const [liveLogTaskId, setLiveLogTaskId] = useState<string | null>(null);
  // V396-14: 工具生命周期卡片（tool_start/complete/error 实时渲染）
  const [liveTools, setLiveTools] = useState<Array<{ id: number; tool: string; label: string; args: string; status: "running" | "done" | "error"; durationMs?: number; resultPreview?: string; error?: string; ts: number }>>([]);
  // V395-5: 重试实时提示（SSE retry 事件触发, 2.5s 自动消失）
  const [taskNotice, setTaskNotice] = useState("");
  useEffect(() => {
    if (!taskNotice) return;
    const t = setTimeout(() => setTaskNotice(""), 2500);
    return () => clearTimeout(t);
  }, [taskNotice]);

  // 差距O①: 反馈提交（👍 好评 / 👎 差评→转防错规则）
  const submitFeedback = async (id: string, fb: 1 | -1) => {
    try {
      const r = await fetch("/api/agent/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: id, feedback: fb }),
      });
      const d = await r.json();
      setTaskNotice(d.result?.note || (fb === 1 ? "已记录好评" : "已记录差评"));
      setTasks((prev) => prev.map((t) => t.id === id ? { ...t, userFeedback: fb } : t));
    } catch { /* 反馈失败忽略 */ }
  };
  // 批次4(#8): 会话图可视化 — 树状渲染会话→任务→工具
  const [graph, setGraph] = useState<{ nodes: Array<{ id: string; type: string; label: string; status?: string }>; edges: Array<{ from: string; to: string; relation: string }> }>({ nodes: [], edges: [] });
  const [graphOpen, setGraphOpen] = useState(false);
  const loadSessionGraph = async () => {
    try {
      const r = await fetch("/api/agent/session-graph?sessionId=" + (chatSessionId || "current"));
      setGraph(await r.json());
    } catch { setGraph({ nodes: [], edges: [] }); }
  };
  const graphChildren = (nodeId: string) => graph.edges.filter((e) => e.from === nodeId).map((e) => ({ edge: e, node: graph.nodes.find((n) => n.id === e.to) }));
  // 前端缺口③: 任务分叉（checkpoint fork — 计划复制独立演进）
  const forkTask = async (id: string) => {
    const goal = prompt("分叉目标（基于原任务计划复制, 可独立演进）:", "");
    if (goal === null) return;
    try {
      const r = await fetch(`/api/agent/tasks/${id}/fork`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: goal || undefined }),
      });
      const d = await r.json();
      setTaskNotice(d.ok ? `✅ ${d.note || "已分叉"}` : `❌ ${d.error || "分叉失败"}`);
      await loadTasks();
    } catch { setTaskNotice("❌ 分叉失败"); }
  };
  // 前端缺口②: 流式推理 UI — SSE 实时显示 LLM 生成
  const [streamOpen, setStreamOpen] = useState(false);
  const [streamPrompt, setStreamPrompt] = useState("");
  const [streamOutput, setStreamOutput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const runStream = async () => {
    if (!streamPrompt.trim() || streaming) return;
    setStreaming(true);
    setStreamOutput("");
    try {
      const res = await fetch("/api/agent/llm/stream", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: streamPrompt }),
      });
      const reader = res.body?.getReader();
      if (!reader) { setStreamOutput("（流式不可用）"); setStreaming(false); return; }
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (j.delta) setStreamOutput((prev) => prev + j.delta);
            if (j.done) setStreaming(false);
          } catch { /* 跳过 */ }
        }
      }
      setStreaming(false);
    } catch { setStreamOutput("（流式失败）"); setStreaming(false); }
  };
  // 审计修复: 计划确认（planning 状态 → 确认后执行）
  const confirmPlan = async (id: string) => {
    try {
      const r = await fetch(`/api/agent/tasks/${id}/confirm-plan`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true }),
      });
      const d = await r.json();
      setTaskNotice(d.ok ? `✅ ${d.note || "计划已确认"}` : `❌ ${d.error || "确认失败"}`);
      void loadTasks();
    } catch { setTaskNotice("❌ 确认失败"); }
  };
  // V395-2: 订阅任务 SSE — 替换 3 秒轮询（task/step/reflect/done 事件实时刷新; exec_log 事件追加实时日志）
  const subscribeTaskStream = (taskId: string) => {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    setLiveLogTaskId(taskId);
    setLiveLogs([]);
    const es = new EventSource(`/api/agent/tasks/${taskId}/stream`);
    sseRef.current = es;
    // V396-14: 订阅新任务时清空工具卡片
    setLiveTools([]);
    const parse = (e: Event) => {
      try { return JSON.parse((e as MessageEvent).data); } catch { return null; }
    };
    // snapshot: 连接后初始快照（全量任务状态）
    es.addEventListener("snapshot", (e) => {
      const d = parse(e);
      if (!d?.task) return;
      setTasks((prev) => prev.map((t) => t.id === d.task.id ? { ...t, ...d.task } : t));
    });
    // task: 任务级状态（状态/计划/进度/审批）
    es.addEventListener("task", (e) => {
      const d = parse(e);
      if (!d) return;
      setTasks((prev) => prev.map((t) => t.id === d.taskId
        ? { ...t, status: d.data?.status || t.status, plan: d.data?.plan || t.plan, currentStep: d.data?.currentStep ?? t.currentStep, progress: d.data?.progress || t.progress, approvalRequest: d.data?.approvalRequest ?? t.approvalRequest, estimatedCostCents: d.data?.estimatedCostCents ?? t.estimatedCostCents, actualCostCents: d.data?.actualCostCents ?? t.actualCostCents }
        : t));
    });
    // step: 步骤状态（running/done/failed + 结果 + V395-5 重试信息）
    es.addEventListener("step", (e) => {
      const d = parse(e);
      if (!d) return;
      setTasks((prev) => prev.map((t) => t.id === d.taskId ? { ...t, plan: t.plan.map((s) => s.id === d.data?.step?.id ? { ...s, ...d.data.step } : s) } : t));
      // V395-5: 重试事件 → 实时提示（attempt/waitMs 展示, 不改步骤状态）
      if (d.data?.retry) {
        const r = d.data.retry;
        setTaskNotice(`${d.data.step?.title || "步骤"} 执行失败，正在第 ${r.attempt}/${r.maxAttempts} 次重试（${(r.waitMs / 1000).toFixed(1)}s 后）…`);
      }
    });
    // reflect: 循环评估
    es.addEventListener("reflect", (e) => {
      const d = parse(e);
      if (!d) return;
      setTasks((prev) => prev.map((t) => t.id === d.taskId ? { ...t, reflectLog: [...(t.reflectLog || []), { round: d.data?.round ?? 0, verdict: d.data?.verdict ?? "fail", score: d.data?.score ?? 0, issues: d.data?.issues || [], action: d.data?.action ?? "replan" }].slice(-10) } : t));
    });
    // exec_log: 实时执行日志（V395-7 运行日志实时查看）
    es.addEventListener("exec_log", (e) => {
      const d = parse(e);
      if (!d) return;
      setLiveLogs((prev) => [...prev.slice(-199), { ts: new Date(d.data?.createdAt || Date.now()).toLocaleTimeString("zh-CN", { hour12: false }), text: String(d.data?.outputSummary || d.data?.inputSummary || "").slice(0, 200), kind: d.data?.action }]);
    });
    // V396-14: 工具生命周期事件 → 实时工具卡片（tool_start/complete/error）
    es.addEventListener("tool_start", (e) => {
      const d = parse(e);
      if (!d) return;
      setLiveTools((prev) => [{ id: Date.now(), tool: String(d.data?.tool || ""), label: String(d.data?.label || d.data?.tool || ""), args: String(d.data?.args || ""), status: "running" as const, ts: Date.now() }, ...prev].slice(0, 8));
    });
    es.addEventListener("tool_complete", (e) => {
      const d = parse(e);
      if (!d) return;
      setLiveTools((prev) => prev.map((t) => t.tool === d.data?.tool && t.status === "running" ? { ...t, status: "done" as const, durationMs: Number(d.data?.durationMs || 0), resultPreview: String(d.data?.resultPreview || "") } : t));
    });
    es.addEventListener("tool_error", (e) => {
      const d = parse(e);
      if (!d) return;
      setLiveTools((prev) => prev.map((t) => t.tool === d.data?.tool && t.status === "running" ? { ...t, status: "error" as const, error: String(d.data?.error || "") } : t));
    });
    // done: 任务结束（关闭连接 + 刷新列表）
    es.addEventListener("done", (e) => {
      const d = parse(e);
      if (!d) return;
      setTasks((prev) => prev.map((t) => t.id === d.taskId ? { ...t, status: d.data?.status || "completed", result: d.data?.result || t.result, loopCount: d.data?.loopCount ?? t.loopCount, progress: d.data?.note ? `完成（${d.data.note}）` : "全部完成" } : t));
      sseRef.current?.close();
      sseRef.current = null;
      setLiveLogTaskId(null);
      void loadTasks();
    });
    // 连接异常: EventSource 自动重连; 若任务已终态则手动关闭
    es.onerror = () => {
      const t = tasks.find((x) => x.id === taskId);
      if (t && ["completed", "failed", "cancelled"].includes(t.status)) {
        es.close();
        if (sseRef.current === es) sseRef.current = null;
      }
    };
  };

  // V395-2: 停止当前 SSE 订阅
  const stopTaskStream = () => {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
  };

  const playDemo = () => {
    demoTimersRef.current.forEach(clearTimeout);
    demoTimersRef.current = [];
    setDemoPlaying(true);
    setError("");
    // 演示任务数据
    const demoGoal = "写一篇资本下乡对农村集体经济影响的综述";
    const demoPlan: TaskStep[] = [
      { id: "s1", title: "检索资本下乡相关政策文献", type: "retrieve", query: demoGoal, status: "pending" },
      { id: "s2", title: "检索农村集体经济改革案例", type: "retrieve", query: "农村集体经济 改革 案例", status: "pending" },
      { id: "s3", title: "综合推理资本下乡的双重效应", type: "reason", query: demoGoal, status: "pending" },
      { id: "s4", title: "撰写综述初稿（正面效应与风险）", type: "write", query: demoGoal, status: "pending" },
      { id: "s5", title: "评审综述并修正", type: "review", query: demoGoal, status: "pending" },
    ];
    const demoTask: TaskRecord = {
      id: "demo-task-1",
      goal: demoGoal,
      status: "running",
      plan: demoPlan,
      currentStep: 0,
      progress: "开始执行…",
      createdAt: new Date().toISOString(),
    };
    setTasks([demoTask, ...tasks]);
    setExpandedId("demo-task-1");
    setLastCreated("demo-task-1");
    // 逐步执行（每步 1s：running → 结果 → done）
    const stepResults: Array<{ result: string; detail: string; source: string }> = [
      {
        result: "检索到 12 篇相关政策文献（2018-2025）",
        detail: "命中文献：\n1. 《资本下乡与乡村振兴的实践路径》（2021）\n2. 《工商资本参与农村土地流转的规制研究》（2019）\n3. 《农村集体经济组织法解读》（2023）\n4. 《资本下乡对农户收入的影响机制》（2022）\n…共 12 篇，按相关度排序。",
        source: "Cognee 图谱 11003 + PG 全文检索",
      },
      {
        result: "检索到 8 个农村集体经济改革案例",
        detail: "典型案例：\n1. 贵州塘约村·集体经济合作社（2018）\n2. 山东代村·土地股份合作（2020）\n3. 浙江鲁家村·工商资本+乡村旅游（2019）\n4. 江苏华西村·集体企业改制（2021）\n…共 8 个案例，覆盖东部/中部/西部。",
        source: "Graphiti 图谱 11001 蒸馏知识",
      },
      {
        result: "推理结论：资本下乡存在资源激活与利益挤占双重效应",
        detail: "综合推理链：\n① 资源激活：闲置土地/劳动力/资金 三要素重组 → 集体经济增收（证据：塘约村集体收入增长 3.2 倍）\n② 利益挤占：资本逐利性 → 农户议价权弱化 → 收益分配失衡（证据：代村案例中普通农户分红占比仅 21%）\n③ 制度约束：集体经济组织法第 45 条 限制资本控股集体资产\n④ 结论：需「激活+规制」双轨并进。",
        source: "SAG 推理链（52 步）· deepseek-chat",
      },
      {
        result: "综述初稿完成（约 3000 字）",
        detail: "综述结构：\n一、资本下乡的政策背景与理论框架\n二、正面效应：要素激活与集体增收\n三、风险审视：利益挤占与治理挑战\n四、制度回应：法律规制与政策引导\n五、研究展望\n（初稿已按政策库资料补充 2019 年中央一号文件依据）",
        source: "LLM 写作（deepseek-v4-flash）",
      },
      {
        result: "评审通过，修正 2 处表述",
        detail: "评审意见：\n1. 【修正】「土地流转」表述 → 「农村土地经营权流转」（与集体经济组织法术语一致）\n2. 【修正】「资本控股」 → 「资本入股」（区分控股与入股的法律后果）\n3. 【通过】事实引用与政策依据均可在检索上下文追溯\n评审分：0.86/1.0",
        source: "评审 Agent（独立角色）· deepseek-chat",
      },
    ];
    demoPlan.forEach((step, i) => {
      demoTimersRef.current.push(setTimeout(() => {
        setTasks((prev) => prev.map((t) => t.id === "demo-task-1"
          ? { ...t, currentStep: i + 1, progress: `第 ${i + 1}/${demoPlan.length} 步完成: ${step.title}`, plan: t.plan.map((s, si) => si === i ? { ...s, status: "running" as const } : s) }
          : t));
      }, 800 + i * 1000));
      demoTimersRef.current.push(setTimeout(() => {
        setTasks((prev) => prev.map((t) => t.id === "demo-task-1"
          ? { ...t, plan: t.plan.map((s, si) => si === i ? { ...s, status: "done" as const, result: stepResults[i].result, detail: stepResults[i].detail, source: stepResults[i].source } : s) }
          : t));
      }, 800 + i * 1000 + 500));
    });
    // 完成（G13: demo 补最终结果 → 展开区"最终结果"卡片可演示）
    demoTimersRef.current.push(setTimeout(() => {
      setTasks((prev) => prev.map((t) => t.id === "demo-task-1"
        ? {
            ...t, status: "completed", progress: "全部 5 步完成", currentStep: 5,
            result: "# 任务完成汇总\n目标: 写一篇资本下乡对农村集体经济影响的综述\n\n## 检索资本下乡相关政策文献\n检索到 12 篇相关政策文献（2018-2025），覆盖土地流转、乡村振兴、集体经济组织法三大主题。\n\n## 综合推理资本下乡的双重效应\n资源激活（要素重组→集体增收）与利益挤占（资本逐利→农户议价权弱化）双重效应并存，需「激活+规制」双轨并进。\n\n## 撰写综述初稿\n五段结构：政策背景/正面效应/风险审视/制度回应/研究展望（约 3000 字，含 2019 年中央一号文件依据）。\n\n## 评审综述并修正\n评审分 0.86/1.0 — 修正「土地流转」→「农村土地经营权流转」、「资本控股」→「资本入股」两处表述。",
          }
        : t));
      setDemoPlaying(false);
    }, 800 + demoPlan.length * 1000 + 600));
  };

  const loadTasks = async () => {
    try {
      const { tasks: list, hasMore } = await taskApi.list(0, 20);
      setTasks(list);
      setHasMore(hasMore);
      // V395-7: 页面加载时若有运行中任务 → 自动订阅 SSE（实时日志/进度恢复）
      const runningTask = list.find((t) => ["running", "planning", "awaiting_approval"].includes(t.status));
      if (runningTask && runningTask.id !== "demo-task-1") {
        subscribeTaskStream(runningTask.id);
      }
      const q = await taskApi.queueStatus();
      setQueue({ queued: q.queued, running: q.running, maxConcurrent: q.maxConcurrent });
      const t = await fetch("/api/agent/templates");
      setTemplates((await t.json()).templates || []);
      void loadPresets();
      // wisp借鉴: 加载远程计算状态（SSH/GPU 配置 → 下拉框可用性）
      try {
        const r = await fetch("/api/agent/compute-status");
        const d = await r.json();
        setRemoteStatus({ ssh: !!d.remote?.sshConfigured, gpu: !!d.remote?.gpuConfigured });
      } catch { /* 远程状态加载失败忽略 */ }
      // V395-4/9: 插件 + 定时任务列表（并行加载, 失败静默）
      void loadPlugins();
      void loadScheduled();
    } catch { /* 加载失败静默 */ }
  };

  // G12: 加载更多 — 追加下一页到现有列表（去重: 防止 SSE 更新与新页重叠）
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMoreTasks = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const { tasks: more, hasMore: morePages } = await taskApi.list(tasks.length, 20);
      setTasks((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...more.filter((t) => !seen.has(t.id))];
      });
      setHasMore(morePages);
    } catch { /* 加载更多失败静默 */ }
    setLoadingMore(false);
  };

  // ═══ V395-4: 插件管理面板 ═══
  const [plugins, setPlugins] = useState<Array<{ id: string; name: string; description: string; entry: string; enabled: boolean; tools: Array<{ name: string }> }>>([]);
  const [pluginForm, setPluginForm] = useState({ id: "", name: "", entry: "" });
  const [pluginError, setPluginError] = useState("");
  const loadPlugins = async () => {
    try {
      const r = await fetch("/api/agent/plugins");
      setPlugins((await r.json()).plugins || []);
    } catch { /* 插件加载失败静默 */ }
  };
  const registerPlugin = async () => {
    if (!pluginForm.id.trim() || !pluginForm.entry.trim()) { setPluginError("插件 id 和 entry 必填"); return; }
    setPluginError("");
    try {
      const r = await fetch("/api/agent/plugins", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: pluginForm.id.trim(), name: pluginForm.name.trim() || pluginForm.id.trim(), entry: pluginForm.entry.trim() }),
      });
      const d = await r.json();
      if (d.error) { setPluginError(d.error); return; }
      setPluginForm({ id: "", name: "", entry: "" });
      void loadPlugins();
    } catch (e: any) { setPluginError(e.message || "注册失败"); }
  };
  const togglePlugin = async (id: string, enabled: boolean) => {
    await fetch(`/api/agent/plugins/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !enabled }),
    });
    void loadPlugins();
  };
  const deletePlugin = async (id: string) => {
    if (!confirm("确定删除该插件？")) return;
    await fetch(`/api/agent/plugins/${id}`, { method: "DELETE" });
    void loadPlugins();
  };

  // ═══ V395-9: 定时任务面板 ═══
  const [scheduled, setScheduled] = useState<Array<{ id: string; goal: string; cron: string; nextRun?: string; lastRunAt?: string; lastTaskId?: string; enabled: boolean }>>([]);
  const [schedForm, setSchedForm] = useState({ goal: "", cron: "0 9 * * *" });
  const [schedError, setSchedError] = useState("");
  const loadScheduled = async () => {
    try {
      const r = await fetch("/api/agent/scheduled");
      setScheduled((await r.json()).scheduled || []);
    } catch { /* 定时任务加载失败静默 */ }
  };
  const createScheduled = async () => {
    if (!schedForm.goal.trim()) { setSchedError("目标必填"); return; }
    setSchedError("");
    try {
      const r = await fetch("/api/agent/scheduled", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: schedForm.goal.trim(), cron: schedForm.cron.trim() }),
      });
      const d = await r.json();
      if (d.error) { setSchedError(d.error); return; }
      setSchedForm({ goal: "", cron: "0 9 * * *" });
      void loadScheduled();
    } catch (e: any) { setSchedError(e.message || "创建失败"); }
  };
  const toggleScheduled = async (id: string, enabled: boolean) => {
    await fetch(`/api/agent/scheduled/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !enabled }),
    });
    void loadScheduled();
  };
  const deleteScheduled = async (id: string) => {
    if (!confirm("确定删除该定时任务？")) return;
    await fetch(`/api/agent/scheduled/${id}`, { method: "DELETE" });
    void loadScheduled();
  };
  useEffect(() => { void loadTasks(); }, []);
  // 2026-08-07 修复白框：组件卸载时清理 demo 定时器（否则切 tab 后定时器在已卸载组件上 setState）
  // V381: 轮询句柄也挂 ref, 卸载时一并清理
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    return () => {
      demoTimersRef.current.forEach(clearTimeout);
      demoTimersRef.current = [];
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      // V395-2: 卸载时关闭 SSE 连接
      if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    };
  }, []);

  const createTask = async () => {
    if (!goal.trim() || creating) return;
    // 2026-08-07 创建真实任务时清理演示
    demoTimersRef.current.forEach(clearTimeout);
    setDemoPlaying(false);
    setTasks((prev) => prev.filter((t) => t.id !== "demo-task-1"));
    setCreating(true);
    setError("");
    try {
      const task = await taskApi.create(goal.trim(), { target: runTarget });
      setLastCreated(task.id);
      setExpandedId(task.id);
      setGoal("");
      await loadTasks();
      // 自动开始执行
      await taskApi.run(task.id);
      // V395-2: SSE 流式进度（替换 3 秒轮询）
      subscribeTaskStream(task.id);
    } catch (e: any) {
      setError(e.message || "创建任务失败");
    } finally {
      setCreating(false);
    }
  };

  // V394-8: 模板创建（prompt 填主题 → 模板创建; G15: 加"创建即执行"选项 — confirm 选择）
  const createFromTemplate = async (tpl: { id: string; name: string }) => {
    const topic = prompt(`「${tpl.name}」模板 — 请输入研究主题:`, chatMsg || goal || "");
    if (!topic?.trim()) return;
    setCreating(true);
    setError("");
    try {
      const task = await taskApi.createFromTemplate(tpl.id, topic.trim());
      setLastCreated(task.id);
      setExpandedId(task.id);
      setGoal("");
      setChatMsg("");
      await loadTasks();
      // G15: 创建即执行选项 — 默认立即执行; 取消则仅创建(稍后手动执行)
      if (confirm(`「${tpl.name}」任务已创建 — 立即开始执行？\n（取消则稍后在任务卡上点"执行"）`)) {
        await taskApi.run(task.id);
        // V395-2: SSE 流式进度（替换 3 秒轮询）
        subscribeTaskStream(task.id);
      }
    } catch (e: any) {
      setError(e.message || "模板创建失败");
    } finally {
      setCreating(false);
    }
  };

  // V394-7: 对话式指挥
  // V395-3: sessionId 会话上下文 — 前端持有会话 id, 连续对话（"帮我研究X"→"重点看Y"）
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const doChat = async () => {
    if (!chatMsg.trim()) return;
    setChatReply("");
    try {
      const r = await taskApi.chat(chatMsg.trim(), chatSessionId || undefined);
      // 首次对话返回 sessionId → 持有（后续消息延续语境）
      if (r.sessionId) setChatSessionId(r.sessionId);
      if (r.ok) {
        setChatReply(`✅ 已创建任务「${r.goal}」并开始执行（${r.note || ""}）${chatSessionId ? "" : " · 已开启会话记忆"}`);
        setChatMsg("");
        void loadTasks();
      } else {
        setChatReply("⚠️ " + (r.error || "无法理解"));
      }
    } catch (e: any) {
      setChatReply("❌ " + (e.message || "失败"));
    }
  };

  // V394-5: 续作（任务链）
  const continueTask = async (parentId: string, goal: string) => {
    const childGoal = prompt("续作目标（将基于上次任务继续）:", goal);
    if (!childGoal?.trim()) return;
    try {
      const child = await taskApi.createChild(parentId, childGoal.trim());
      setLastCreated(child.id);
      setExpandedId(child.id);
      void loadTasks();
      await taskApi.run(child.id);
    } catch (e: any) {
      setError(e.message || "续作失败");
    }
  };

  const controlTask = async (id: string, action: "pause" | "resume" | "cancel") => {
    await taskApi.control(id, action);
    await loadTasks();
  };

  // V391(P0-4): 审批高危步骤（批准后继续执行）
  // V396-11: 四态确认 — approve(批准) / edit(改参后批准) / reject(拒绝跳过) / respond(回复理由继续)
  const approveTask = async (id: string, approve: boolean, note?: string, action: "approve" | "edit" | "reject" | "respond" = approve ? "approve" : "reject") => {
    await taskApi.approve(id, approve, note, action);
    await loadTasks();
    if (approve || action === "approve" || action === "edit" || action === "respond") {
      // 批准/编辑/回复后重新触发执行（从挂起步骤继续）
      await taskApi.run(id);
      void loadTasks();
    }
  };

  // V391(P2-1): 主管-工人编排（复杂任务并行）
  const orchestrateTask = async () => {
    if (!goal.trim() || creating) return;
    setCreating(true);
    setError("");
    try {
      const { taskId } = await taskApi.orchestrate(goal.trim());
      setLastCreated(taskId);
      setGoal("");
      await loadTasks();
      // V395-2: SSE 流式进度（编排任务也走 SSE 推送）
      subscribeTaskStream(taskId);
    } catch (e: any) {
      setError(e.message || "编排失败");
    } finally {
      setCreating(false);
    }
  };

  // V388: 删除任务（完成后清理）
  const deleteTask = async (id: string) => {
    if (!confirm("确定删除该任务？")) return;
    await fetch(`/api/agent/tasks/${id}`, { method: "DELETE" });
    await loadTasks();
  };

  // V395-8: 结果导出 Markdown（下载 .md 文件）
  const exportTask = async (id: string) => {
    try {
      const res = await fetch(`/api/agent/tasks/${id}/export`);
      if (!res.ok) { setError("导出失败"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      // 从 Content-Disposition 取文件名（无则兜底）
      const cd = res.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename="?([^";]+)"?/);
      a.download = match ? match[1] : `agent-task-${id.slice(0, 8)}.md`;
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message || "导出失败");
    }
  };

  const statusColor = (s: string) => {
    // V394修复: 原 bg-green-50/30、bg-red-50/30 是近白色系在暗色主题下显示为白色蒙版; 改用500系低透明度(暗色柔和底)
    switch (s) {
      case "running": return "border-primary/50 bg-primary/10";
      case "completed": return "border-green-400/30 bg-green-500/10";
      case "failed": return "border-red-400/40 bg-red-500/10";
      case "cancelled": return "border-border bg-muted/30";
      default: return "border-border bg-background/40";
    }
  };

  const stepIcon = (s: string) => {
    switch (s) {
      case "done": return <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />;
      case "running": return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
      case "failed": return <X className="h-3.5 w-3.5 text-red-600" />;
      default: return <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />;
    }
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="w-full space-y-4">
        <div className="flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">自主任务</h2>
          <span className="text-xs text-muted-foreground">目标 → LLM 拆解 → 逐项执行 → 进度回报 → 中途干预</span>
        </div>

        {/* 目标输入 + 创建 */}
        <div className="rounded-lg border border-border/70 bg-background/40 p-3">
          <div className="flex items-center gap-2">
            <input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createTask(); }}
              placeholder="输入研究目标，如：写一篇资本下乡对农村集体经济影响的综述"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50"
            />
            <button
              type="button"
              onClick={() => void createTask()}
              disabled={creating || !goal.trim()}
              className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {creating ? "拆解中…" : "创建任务"}
            </button>
            {/* 2026-08-07 LLM 模型选择（自主任务：仅规划） */}
            <LlmModelSelector roles={TASK_ROLES.task} />
            {/* 差距D/F: Agent 预设模式切换（学术研究/数据分析/论文写作/代码开发） */}
            <select
              value={presetId}
              onChange={(e) => void switchPreset(e.target.value)}
              aria-label="Agent模式预设"
              className="shrink-0 rounded-md border border-border bg-background px-2 py-2 text-xs text-muted-foreground"
              title="模式预设: 工具集+沙箱级别+行为约束"
            >
              {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {/* wisp借鉴: 计算上下文选择（local/wsl/ssh/gpu — 步骤执行时透传 target） */}
            <select
              value={runTarget}
              onChange={(e) => setRunTarget(e.target.value)}
              aria-label="计算上下文"
              className="shrink-0 rounded-md border border-border bg-background px-2 py-2 text-xs text-muted-foreground"
              title={"计算上下文: local本机沙箱 / wsl子系统 / ssh远程(" + (remoteStatus.ssh ? "已配置" : "未配置") + ") / gpu(" + (remoteStatus.gpu ? "已配置" : "未配置") + ")"}
            >
              <option value="local">计算: 本机</option>
              <option value="wsl">计算: WSL</option>
              <option value="ssh" disabled={!remoteStatus.ssh}>计算: SSH{remoteStatus.ssh ? "" : "(未配置)"}</option>
              <option value="gpu" disabled={!remoteStatus.gpu}>计算: GPU{remoteStatus.gpu ? "" : "(未配置)"}</option>
            </select>
            {/* V391(P2-1): 主管-工人编排（并行工人执行复杂任务） */}
            <button
              type="button"
              onClick={() => void orchestrateTask()}
              disabled={creating || !goal.trim()}
              className="flex shrink-0 items-center gap-1 rounded-md border border-primary/40 px-3 py-2 text-xs text-primary hover:bg-primary/5 disabled:opacity-40"
              title="主管拆包 → 并行工人执行 → 主管汇总（复杂任务）"
            >
              <ListChecks className="h-3.5 w-3.5" />
              编排执行
            </button>
            {/* 2026-08-07 演示：模拟任务逐步执行（沙箱，不消耗 API） */}
            <button
              type="button"
              onClick={playDemo}
              disabled={demoPlaying}
              className="flex shrink-0 items-center gap-1 rounded-md border border-dashed border-primary/40 px-3 py-2 text-xs text-primary hover:bg-primary/5 disabled:opacity-50"
              title="播放演示：任务拆解 + 逐步执行（沙箱 · 不消耗 API）"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {demoPlaying ? "演示中…" : "播放演示"}
            </button>
          </div>
          {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
          {/* V394-8: 模板快捷按钮 — 点击直接用模板创建任务并自动执行（填入主题后） */}
          {templates.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">模板:</span>
              {templates.map((t) => (
                <button key={t.id} type="button"
                  onClick={() => void createFromTemplate(t)}
                  title={t.desc + "（点击直接用此模板创建任务）"}
                  className="rounded border border-primary/30 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/5">
                  {t.name}
                </button>
              ))}
            </div>
          )}
          {/* V394-4: 队列状态 */}
          <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>队列: 排队 {queue.queued} · 运行 {queue.running}/{queue.maxConcurrent}</span>
            {queue.queued > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] text-amber-700">任务排队中（并发上限 {queue.maxConcurrent}）</span>}
          </div>
          {/* V394-7: 对话式指挥 */}
          <div className="mt-2 flex items-center gap-2">
            <input value={chatMsg} onChange={(e) => setChatMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void doChat(); }}
              placeholder="对话式指挥: 帮我研究资本下乡对农村集体经济的影响"
              className="min-w-0 flex-1 rounded-md border border-white/10 bg-slate-800 px-3 py-1.5 text-xs text-white placeholder:text-slate-500" />
            {/* 批次4(#8): 会话图可视化切换 */}
            <button type="button" aria-label="会话图" onClick={() => { setGraphOpen((v) => !v); if (!graphOpen) void loadSessionGraph(); }}
              className="shrink-0 rounded-md border border-emerald-400/30 px-2.5 py-1.5 text-[11px] text-emerald-400 hover:bg-emerald-500/5"
              title="会话图: 会话→任务→工具 研究过程复盘">
              {graphOpen ? "收起会话图" : "会话图"}
            </button>
            {/* V394-7: 模型选择（与创建任务共享 plan/reason 角色配置, 影响规划与执行模型） */}
            <LlmModelSelector roles={TASK_ROLES.task} />
            <button type="button" onClick={() => void doChat()} disabled={!chatMsg.trim()}
              className="shrink-0 rounded-md bg-primary/10 px-3 py-1.5 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-40">
              指挥
            </button>
          </div>
          {chatReply && <div className="mt-1 text-[11px] text-emerald-600">{chatReply}</div>}
          {/* 前端缺口②: 流式推理面板（SSE 实时显示生成） */}
          <div className="mt-2 flex items-center gap-2">
            <button type="button" aria-label="流式推理" onClick={() => setStreamOpen((v) => !v)}
              className="flex shrink-0 items-center gap-1 rounded-md border border-purple-400/30 px-2.5 py-1.5 text-[11px] text-purple-500 hover:bg-purple-500/5"
              title="LLM 流式推理: SSE 实时显示生成过程">
              <Terminal className="h-3 w-3" /> {streamOpen ? "收起流式" : "流式推理"}
            </button>
          </div>
          {streamOpen && (
            <div className="mt-2 rounded-lg border border-purple-500/20 bg-slate-900/40 p-2">
              <div className="flex gap-2">
                <input value={streamPrompt} onChange={(e) => setStreamPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void runStream(); }}
                  placeholder="输入提示词, 流式生成…" className="min-w-0 flex-1 rounded-md border border-white/10 bg-slate-800 px-2 py-1 text-[11px] text-white" />
                <button type="button" aria-label="开始流式生成" onClick={() => void runStream()} disabled={streaming || !streamPrompt.trim()}
                  className="shrink-0 rounded-md bg-purple-500/15 px-3 py-1 text-[11px] text-purple-300 hover:bg-purple-500/25 disabled:opacity-40">
                  {streaming ? "生成中…" : "生成"}
                </button>
              </div>
              {streamOutput && (
                <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-purple-100/80">{streamOutput}{streaming && <span className="animate-pulse">▍</span>}</pre>
              )}
            </div>
          )}
          {/* 批次4(#8): 会话图树状渲染 */}
          {graphOpen && (
            <div className="mt-2 rounded-lg border border-emerald-500/20 bg-slate-900/40 p-2 font-mono text-[10px]">
              {graph.nodes.length === 0 && <div className="text-muted-foreground">暂无会话图数据（运行 Agent 任务后生成）</div>}
              {graph.nodes.filter((n) => n.type === "session").map((sessionNode) => (
                <div key={sessionNode.id}>
                  <div className="text-emerald-300">● {sessionNode.label}</div>
                  {graphChildren(sessionNode.id).map(({ edge, node }) => node && (
                    <div key={edge.to} className="pl-4">
                      <div className="text-cyan-300">├─ ▸ {node.label} <span className="text-muted-foreground/60">({node.status || ""})</span></div>
                      {graphChildren(node.id).map(({ edge: e2, node: n2 }) => n2 && (
                        <div key={e2.to} className="pl-4 text-muted-foreground">├─ ⚙ {n2.label} <span className="text-muted-foreground/40">[{e2.relation}]</span></div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {/* V395-5: 重试实时提示 */}
          {taskNotice && (
            <div className="mt-1 flex items-center gap-1.5 rounded border border-amber-300/40 bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
              <Loader2 className="h-2.5 w-2.5 animate-spin" /> {taskNotice}
            </div>
          )}
        </div>

        {/* ═══ V395-4: 插件管理 + V395-9: 定时任务（可折叠） ═══ */}
        <div className="grid gap-3 md:grid-cols-2">
          {/* 插件管理 */}
          <div className="rounded-lg border border-border/70 bg-background/40 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Plug className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium">插件体系</h3>
              <span className="text-[10px] text-muted-foreground">注册 entry 模块 → 启用后自动并入 Agent 工具清单</span>
            </div>
            <div className="mb-2 flex gap-1.5">
              <input value={pluginForm.id} onChange={(e) => setPluginForm({ ...pluginForm, id: e.target.value })}
                placeholder="插件 id (如 classical-tools)" className="w-28 min-w-0 rounded border border-border bg-background px-2 py-1 text-[11px]" />
              <input value={pluginForm.name} onChange={(e) => setPluginForm({ ...pluginForm, name: e.target.value })}
                placeholder="名称" className="w-20 min-w-0 rounded border border-border bg-background px-2 py-1 text-[11px]" />
              <input value={pluginForm.entry} onChange={(e) => setPluginForm({ ...pluginForm, entry: e.target.value })}
                placeholder="入口模块 (如 ./plugin-example-classical.js)" className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px]" />
              <button type="button" onClick={() => void registerPlugin()}
                className="shrink-0 rounded bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20">注册</button>
            </div>
            {pluginError && <div className="mb-1 text-[10px] text-red-600">{pluginError}</div>}
            {plugins.length === 0 ? (
              <div className="rounded border border-dashed border-border px-2 py-2 text-center text-[10px] text-muted-foreground">暂无插件 — 注册后启用即可扩展 Agent 工具</div>
            ) : (
              <div className="space-y-1">
                {plugins.map((p) => (
                  <div key={p.id} className="flex items-center gap-1.5 rounded border border-border/50 px-1.5 py-1">
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", p.enabled ? "bg-green-500" : "bg-muted-foreground/40")} />
                    <span className="min-w-0 flex-1 truncate text-[11px]">{p.name}</span>
                    <span className="hidden shrink-0 text-[9px] text-muted-foreground/70 sm:inline">{p.tools?.length || 0} 工具</span>
                    <button type="button" onClick={() => void togglePlugin(p.id, p.enabled)}
                      className={cn("shrink-0 rounded px-1.5 py-0.5 text-[9px]", p.enabled ? "bg-amber-100 text-amber-700 hover:bg-amber-200" : "bg-green-100 text-green-700 hover:bg-green-200")}>
                      {p.enabled ? "禁用" : "启用"}
                    </button>
                    <button type="button" onClick={() => void deletePlugin(p.id)}
                      className="shrink-0 text-[9px] text-muted-foreground hover:text-red-600" title="删除插件">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 定时任务 */}
          <div className="rounded-lg border border-border/70 bg-background/40 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium">定时任务</h3>
              <span className="text-[10px] text-muted-foreground">cron 分钟级触发 → 自动创建 Agent 任务</span>
            </div>
            <div className="mb-2 flex gap-1.5">
              <input value={schedForm.goal} onChange={(e) => setSchedForm({ ...schedForm, goal: e.target.value })}
                placeholder="研究目标（到期自动创建任务）" className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px]" />
              <input value={schedForm.cron} onChange={(e) => setSchedForm({ ...schedForm, cron: e.target.value })}
                title="5 字段 cron: 分 时 日 月 周"
                className="w-24 shrink-0 rounded border border-border bg-background px-2 py-1 font-mono text-[11px]" />
              <button type="button" onClick={() => void createScheduled()}
                className="shrink-0 rounded bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20">创建</button>
            </div>
            <div className="mb-1.5 flex flex-wrap gap-1 text-[9px] text-muted-foreground">
              <span>示例:</span>
              {["0 9 * * *", "30 8 * * 1", "0 3 * * *"].map((c) => (
                <button key={c} type="button" onClick={() => setSchedForm({ ...schedForm, cron: c })}
                  className="rounded border border-border/60 px-1 py-0.5 font-mono hover:bg-accent/40">{c}</button>
              ))}
            </div>
            {schedError && <div className="mb-1 text-[10px] text-red-600">{schedError}</div>}
            {scheduled.length === 0 ? (
              <div className="rounded border border-dashed border-border px-2 py-2 text-center text-[10px] text-muted-foreground">暂无定时任务 — 设置 cron 后到点自动创建 Agent 任务</div>
            ) : (
              <div className="space-y-1">
                {scheduled.map((s) => (
                  <div key={s.id} className="rounded border border-border/50 px-1.5 py-1">
                    <div className="flex items-center gap-1.5">
                      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.enabled ? "bg-green-500" : "bg-muted-foreground/40")} />
                      <span className="min-w-0 flex-1 truncate text-[11px]">{s.goal}</span>
                      <span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">{s.cron}</span>
                      <button type="button" onClick={() => void toggleScheduled(s.id, s.enabled)}
                        className={cn("shrink-0 rounded px-1.5 py-0.5 text-[9px]", s.enabled ? "bg-amber-100 text-amber-700 hover:bg-amber-200" : "bg-green-100 text-green-700 hover:bg-green-200")}>
                        {s.enabled ? "暂停" : "启用"}
                      </button>
                      <button type="button" onClick={() => void deleteScheduled(s.id)}
                        className="shrink-0 text-[9px] text-muted-foreground hover:text-red-600" title="删除定时任务">✕</button>
                    </div>
                    {s.nextRun && (
                      <div className="mt-0.5 text-[9px] text-muted-foreground/70">
                        下次: {new Date(s.nextRun).toLocaleString("zh-CN")}{s.lastRunAt ? ` · 上次: ${new Date(s.lastRunAt).toLocaleString("zh-CN")}` : ""}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 任务列表 */}
        {tasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            暂无任务 — 输入目标创建，Agent 将自主拆解并执行
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => {
              const expanded = expandedId === task.id || lastCreated === task.id;
              const doneSteps = task.plan.filter((s) => s.status === "done").length;
              const pct = task.plan.length > 0 ? Math.round((doneSteps / task.plan.length) * 100) : 0;
              return (
                <div key={task.id} className={cn("rounded-lg border p-3", statusColor(task.status))}>
                  <div className="flex items-center gap-2">
                    {/* G22: 展开/收起按钮（aria-label 无障碍） */}
                    <button
                      type="button"
                      aria-label={expanded ? `收起任务详情: ${task.goal.slice(0, 30)}` : `展开任务详情: ${task.goal.slice(0, 30)}`}
                      aria-expanded={expanded}
                      onClick={() => setExpandedId(expanded ? null : task.id)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
                    >
                      <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
                    </button>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.goal}</span>
                    {/* V391(P0-1): 循环轮次徽标 */}
                    {(task.loopCount ?? 0) > 0 && (
                      <span className="shrink-0 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] text-purple-700">循环×{(task.loopCount ?? 0) + 1}</span>
                    )}
                    {/* V2: 超时终止提示 */}
                    {task.status === "failed" && task.progress?.includes("超时") && (
                      <span className="shrink-0 rounded bg-orange-100 px-1.5 py-0.5 text-[10px] text-orange-700">⏱ 超时终止</span>
                    )}
                    <span className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                      task.status === "completed" ? "bg-green-100 text-green-700"
                        : task.status === "failed" ? "bg-red-100 text-red-700"
                        : task.status === "running" ? "bg-blue-100 text-blue-700"
                        : task.status === "paused" ? "bg-amber-100 text-amber-700"
                        : task.status === "awaiting_approval" ? "bg-orange-100 text-orange-700"
                        : "bg-muted text-muted-foreground"
                    )}>
                      {task.status === "awaiting_approval" ? "等待审批" : task.status}
                    </span>
                  </div>
                  {/* 进度条 */}
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-muted">
                      <div className="h-full rounded bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{doneSteps}/{task.plan.length} · {pct}%</span>
                  </div>
                  {task.progress && <div className="mt-1 text-[11px] text-muted-foreground">{task.progress}</div>}

                  {/* V391(P2-5): 成本摘要 + V395-6: 预估 → 实际 对比 */}
                  {(task.costSummary && task.costSummary.execCount > 0) || (task.estimatedCostCents ?? 0) > 0 ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                      {/* V395-6: 创建即有预估; 完成后显示对比 */}
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">
                        {((task.actualCostCents ?? 0) > 0) || (task.costSummary && task.costSummary.execCount > 0)
                          ? <>预估 ¥{((task.estimatedCostCents ?? 0) / 100).toFixed(3)} → 实际 ¥{((task.actualCostCents ?? (task.costSummary?.totalCostCents ?? 0)) / 100).toFixed(3)}</>
                          : <>预估 ¥{((task.estimatedCostCents ?? 0) / 100).toFixed(3)}</>}
                      </span>
                      {task.costSummary && task.costSummary.totalTokens > 0 && (
                        <span>{task.costSummary.totalTokens.toLocaleString()} tokens</span>
                      )}
                      {task.costSummary && <span>{task.costSummary.execCount} 次执行</span>}
                      {/* W2: LLM judge 推理质量分 */}
                      {task.judgeScore != null && (
                        <span className={"rounded px-1.5 py-0.5 " + (task.judgeScore >= 0.7 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>
                          judge {Math.round(task.judgeScore * 100)}分
                        </span>
                      )}
                      {/* W6: 任务归属用户 */}
                      {task.userId && <span className="text-[9px] text-slate-400">用户 {task.userId.slice(0, 8)}</span>}
                    </div>
                  ) : null}

                  {/* V395-7: 运行日志实时查看 — SSE exec_log 事件实时追加（当前订阅任务） */}
                  {liveLogTaskId === task.id && liveLogs.length > 0 && (
                    <div className="mt-1.5 rounded border border-primary/20 bg-slate-950/80 p-2">
                      <div className="mb-1 flex items-center gap-1.5 text-[9px] text-primary">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        实时执行日志（SSE 推送）
                      </div>
                      <div className="max-h-28 overflow-y-auto font-mono text-[9px] leading-3.5 text-slate-300">
                        {liveLogs.map((l, li) => (
                          <div key={li} className="flex gap-1.5">
                            <span className="shrink-0 text-slate-500">{l.ts}</span>
                            <span className={l.kind === "reflect" ? "text-purple-300" : l.kind === "tool_call" ? "text-emerald-300" : "text-slate-300"}>{l.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* V396-14: 工具生命周期卡片（tool_start/complete/error 实时渲染） */}
                  {liveLogTaskId === task.id && liveTools.length > 0 && (
                    <div className="mt-1.5 space-y-1">
                      {liveTools.map((t) => (
                        <div key={t.id} className={"flex items-center gap-2 rounded border px-2 py-1 text-[9px] " +
                          (t.status === "running" ? "border-blue-300/30 bg-blue-500/5" : t.status === "error" ? "border-red-300/30 bg-red-500/5" : "border-emerald-300/30 bg-emerald-500/5")}>
                          {t.status === "running"
                            ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-400" />
                            : t.status === "error"
                              ? <XCircle className="h-3 w-3 shrink-0 text-red-400" />
                              : <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />}
                          <span className="shrink-0 font-medium">{t.label}</span>
                          <span className="min-w-0 flex-1 truncate text-slate-400">{t.status === "error" ? t.error : t.status === "done" ? t.resultPreview : t.args}</span>
                          {t.status === "done" && t.durationMs ? <span className="shrink-0 text-slate-500">{t.durationMs}ms</span> : null}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 控制按钮 */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {task.status === "running" && (
                      <button type="button" aria-label={`暂停任务: ${task.goal.slice(0, 30)}`} onClick={() => void controlTask(task.id, "pause")}
                        className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent">
                        <Pause className="h-3 w-3" /> 暂停
                      </button>
                    )}
                    {task.status === "paused" && (
                      <button type="button" aria-label={`恢复任务: ${task.goal.slice(0, 30)}`} onClick={() => void controlTask(task.id, "resume")}
                        className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent">
                        <Play className="h-3 w-3" /> 恢复
                      </button>
                    )}
                    {task.status === "awaiting_approval" && task.approvalRequest && (
                      <>
                        <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] text-orange-700">
                          高危操作: {task.approvalRequest.title}
                        </span>
                        {/* V396-11: 四态确认 — 批准/编辑/拒绝/回复 */}
                        <button type="button" aria-label="批准高危步骤" onClick={() => void approveTask(task.id, true)}
                          className="flex items-center gap-1 rounded bg-green-600 px-2 py-0.5 text-[10px] text-white hover:bg-green-700">
                          <CheckCircle2 className="h-3 w-3" /> 批准
                        </button>
                        <button type="button" aria-label="拒绝高危步骤" onClick={() => void approveTask(task.id, false)}
                          className="flex items-center gap-1 rounded border border-red-300 px-2 py-0.5 text-[10px] text-red-600 hover:bg-red-50">
                          <X className="h-3 w-3" /> 拒绝
                        </button>
                        <button type="button" aria-label="编辑后继续高危步骤" onClick={() => {
                          const note = prompt("编辑后继续（输入修改说明，可选）") || "";
                          void approveTask(task.id, true, note, "edit");
                        }}
                          className="flex items-center gap-1 rounded border border-blue-300 px-2 py-0.5 text-[10px] text-blue-600 hover:bg-blue-50">
                          <Pencil className="h-3 w-3" /> 编辑
                        </button>
                        <button type="button" onClick={() => {
                          const note = prompt("回复补充信息（将注入任务继续执行）") || "";
                          if (note) void approveTask(task.id, true, note, "respond");
                        }}
                          className="flex items-center gap-1 rounded border border-purple-300 px-2 py-0.5 text-[10px] text-purple-600 hover:bg-purple-50">
                          <MessageSquare className="h-3 w-3" /> 回复
                        </button>
                      </>
                    )}
                    {["running", "paused", "planning"].includes(task.status) && (
                      <button type="button" aria-label="取消任务执行" onClick={() => void controlTask(task.id, "cancel")}
                        className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-red-600 hover:bg-red-50">
                        <XCircle className="h-3 w-3" /> 取消
                      </button>
                    )}
                    {/* 审计修复: 计划确认（planning 状态: 展示计划→确认执行/拒绝） */}
                    {task.status === "planning" && task.plan.length > 0 && (
                      <button type="button" aria-label="确认计划并执行" onClick={() => void confirmPlan(task.id)}
                        className="flex items-center gap-1 rounded bg-green-600 px-2 py-0.5 text-[10px] text-white hover:bg-green-700"
                        title={`确认计划（${task.plan.length} 步）并开始执行`}>
                        <CheckCircle2 className="h-3 w-3" /> 确认计划
                      </button>
                    )}
                    {/* V388: 删除已完成/失败任务（完成后清理） */}
                    {["completed", "failed"].includes(task.status) && (
                      <button type="button" aria-label="续作此任务" onClick={() => void continueTask(task.id, task.goal)}
                        className="flex items-center gap-1 rounded border border-primary/30 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/5">
                        <Play className="h-3 w-3" /> 续作
                      </button>
                    )}
                    {!["running", "paused", "planning"].includes(task.status) && (
                      <button type="button" aria-label={`删除任务: ${task.goal.slice(0, 30)}`} onClick={() => void deleteTask(task.id)}
                        className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-red-50 hover:text-red-600">
                        <Trash2 className="h-3 w-3" /> 删除
                      </button>
                    )}
                    {/* V395-8: 结果导出 Markdown（完成/失败/取消均可下载） */}
                    {["completed", "failed", "cancelled"].includes(task.status) && (
                      <button type="button" onClick={() => void exportTask(task.id)}
                        className="flex items-center gap-1 rounded border border-primary/30 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/5"
                        title="导出任务结果为 Markdown（含步骤详情/执行日志/成本对比）">
                        <Download className="h-3 w-3" /> 导出
                      </button>
                    )}
                    {/* 前端缺口③: 分叉按钮（checkpoint fork） */}
                    {["completed", "failed"].includes(task.status) && (
                      <button type="button" aria-label="分叉此任务" onClick={() => void forkTask(task.id)}
                        className="flex items-center gap-1 rounded border border-cyan-400/30 px-2 py-0.5 text-[10px] text-cyan-600 hover:bg-cyan-50"
                        title="从 checkpoint 分叉: 复制计划为新任务, 可独立演进">
                        <GitBranch className="h-3 w-3" /> 分叉
                      </button>
                    )}
                    {/* 差距O①: 反馈 👍👎（负评自动转防错规则） */}
                    {["completed", "failed"].includes(task.status) && (
                      <span className="flex items-center gap-1">
                        <button type="button" aria-label="好评任务" onClick={() => void submitFeedback(task.id, 1)}
                          className={"flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] hover:bg-emerald-50 " + (task.userFeedback === 1 ? "border-emerald-300 bg-emerald-50 text-emerald-600" : "border-border text-muted-foreground")}
                          title="好评（沉淀成功经验）">
                          <ThumbsUp className="h-3 w-3" />
                        </button>
                        <button type="button" aria-label="差评任务" onClick={() => void submitFeedback(task.id, -1)}
                          className={"flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] hover:bg-red-50 " + (task.userFeedback === -1 ? "border-red-300 bg-red-50 text-red-600" : "border-border text-muted-foreground")}
                          title="差评（自动转防错规则, 防复发）">
                          <ThumbsDown className="h-3 w-3" />
                        </button>
                      </span>
                    )}
                    <button type="button" onClick={() => setExpandedId(expanded ? null : task.id)}
                      className="ml-auto text-[10px] text-muted-foreground hover:text-foreground">
                      {expanded ? "收起" : "展开步骤"}
                    </button>
                  </div>

                  {/* 步骤列表 — 2026-08-07 每步可点击展开详情 */}
                  {expanded && (
                    <div className="mt-2 space-y-1 rounded bg-background/50 p-2">
                      {/* G13: 任务详情元信息 — 创建时间/任务ID/循环轮次/审批详情 */}
                      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border/40 pb-1.5 text-[10px] text-muted-foreground">
                        <span>创建 {new Date(task.createdAt).toLocaleString("zh-CN")}</span>
                        <span className="font-mono text-[9px]">#{task.id.slice(0, 8)}</span>
                        {(task.loopCount ?? 0) > 0 && <span>循环 {task.loopCount} 轮</span>}
                        {task.estimatedCostCents != null && <span>预估 ¥{(task.estimatedCostCents / 100).toFixed(3)}</span>}
                        {(() => { const actual = task.actualCostCents ?? 0; return actual > 0 ? <span>实际 ¥{(actual / 100).toFixed(3)}</span> : null; })()}
                        {task.judgeScore != null && <span>评委分 {(task.judgeScore * 100).toFixed(0)}</span>}
                        {task.parentTaskId && <span>续作自 #{task.parentTaskId.slice(0, 8)}</span>}
                      </div>
                      {/* G13: 审批请求详情（挂起时） */}
                      {task.status === "awaiting_approval" && task.approvalRequest && (
                        <div className="mb-1.5 rounded border border-orange-200/50 bg-orange-50/20 px-2 py-1 text-[10px] text-orange-700">
                          <span className="font-medium">待批准步骤 #{task.approvalRequest.stepIdx + 1}</span>：{task.approvalRequest.title}
                          {task.approvalRequest.reason && <span className="text-muted-foreground"> — {task.approvalRequest.reason}</span>}
                        </div>
                      )}
                      {/* V391(P0-1): 循环评估记录 */}
                      {task.reflectLog && task.reflectLog.length > 0 && (
                        <div className="mb-2 rounded border border-purple-200/40 bg-purple-50/20 p-2">
                          <div className="mb-1 text-[10px] font-medium text-purple-700">循环评估（reflect）</div>
                          {task.reflectLog.map((r, ri) => (
                            <div key={ri} className="mb-1 text-[10px] text-muted-foreground">
                              第 {r.round} 轮: {r.verdict === "pass" ? "✅ 达标" : "⚠️ 未达标"} 评分 {r.score.toFixed(2)}
                              {r.issues.length > 0 && <span className="text-amber-600"> — {r.issues.join("; ")}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                      {task.plan.map((step, i) => {
                        const stepKey = `${task.id}:${step.id}`;
                        const stepOpen = expandedStep === stepKey;
                        return (
                          <div key={step.id} className="rounded border border-border/40">
                            <button
                              type="button"
                              onClick={() => setExpandedStep(stepOpen ? null : stepKey)}
                              className={cn(
                                "flex w-full items-center gap-2 px-1.5 py-1 text-left text-[11px] hover:bg-accent/40",
                                stepOpen && "border-primary/30"
                              )}
                            >
                              {stepIcon(step.status)}
                              <span className="w-10 shrink-0 rounded bg-muted px-1 text-center text-[9px] text-muted-foreground">{TYPE_LABELS[step.type]}</span>
                              <span className={cn("min-w-0 flex-1 truncate", step.status === "done" ? "text-foreground" : "text-muted-foreground")}>
                                {i + 1}. {step.title}
                              </span>
                              {step.result && step.status === "done" && (
                                <span className="max-w-[200px] truncate text-[9px] text-muted-foreground/70">
                                  {step.result.slice(0, 40)}
                                </span>
                              )}
                              <ChevronDown className={cn("h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform", stepOpen && "rotate-180")} />
                            </button>
                            {stepOpen && (
                              <div className="border-t border-border/40 px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
                                {step.query && (
                                  <div className="mb-1"><span className="text-primary">查询词 </span>{step.query}</div>
                                )}
                                {step.source && (
                                  <div className="mb-1"><span className="text-primary">来源 </span>{step.source}</div>
                                )}
                                {step.detail ? (
                                  <pre className="whitespace-pre-wrap font-sans text-[10px] leading-4">{step.detail}</pre>
                                ) : (
                                  <div>{step.result || (step.status === "running" ? "执行中…" : "待执行")}</div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {/* G13: 任务完整结果（终态时展示） */}
                      {task.result && (
                        <div className="mt-1.5 rounded border border-emerald-200/40 bg-emerald-50/10 p-2">
                          <div className="mb-1 text-[10px] font-medium text-emerald-700">最终结果</div>
                          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap font-sans text-[10px] leading-4 text-muted-foreground">{task.result}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {/* G12: 加载更多 — 有更多历史任务时显示 */}
            {hasMore && (
              <button
                aria-label="加载更多任务"
                onClick={() => void loadMoreTasks()}
                disabled={loadingMore}
                className="w-full rounded-lg border border-border py-2 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
              >
                {loadingMore ? "加载中…" : "加载更多任务"}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
