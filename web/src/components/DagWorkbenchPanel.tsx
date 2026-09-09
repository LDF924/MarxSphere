// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// DagWorkbenchPanel.tsx — SocialSci P0-1: 可视化 DAG 科研工作台(画布主体)
// 形态对齐(闭源产品交互语义, 原创实现): 画布节点=研究要素, 连线=产物依赖流转
//   - 项目列表 + 新建(空白/五阶段模板) + NL→DAG(画布任务)
//   - xyflow 画布: 拖节点/连线/框选, 乐观锁保存(canvas_version)
//   - 节点右键/双击: 打开工作界面(节点快照面板, 执行任务/回滚/产物)
// 配套后端: /api/research/*(research-pipeline-service); 迁移114/115
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState, Handle, Position,
  type Connection, type Edge, type Node, type NodeTypes, MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { MaterialsDrawer } from "./MaterialsDrawer";
import { ResearchInputWizard } from "./ResearchInputWizard";
import { ConfirmDialog, type ConfirmSpec } from "./ConfirmDialog";
import { SectionWorkspaceView } from "./SectionWorkspaceView";
import { ArchitectureConfirmView } from "./ArchitectureConfirmView";
import { MaterialPrepPage } from "./MaterialPrepPage";
import { FinalizeView } from "./FinalizeView";
import { readResume } from "./ResearchHistoryPanel";
import {
  BookOpen, Boxes, Brain, CheckCircle2, ChevronDown, Circle, Database, FileText,
  Flag, FlaskConical, GitBranch, HelpCircle, Loader2, Network, PenLine, Plus,
  RotateCcw, Save, Send, Sparkles, Target, Trash2, Wand2, X, ListChecks,
} from "lucide-react";

interface DagProject { id: string; title: string; topic: string; phase: number; phase_label: string; status: string; canvas_version: number; updated_at: string; }
interface CanvasState { nodes: Node[]; edges: Edge[]; }

const NODE_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  goal: { label: "研究目标", color: "#f59e0b", icon: <Target className="h-3 w-3" /> },
  object_sample: { label: "对象/样本", color: "#10b981", icon: <Boxes className="h-3 w-3" /> },
  data_design: { label: "数据与研究设计", color: "#3b82f6", icon: <Database className="h-3 w-3" /> },
  literature: { label: "文献证据", color: "#8b5cf6", icon: <BookOpen className="h-3 w-3" /> },
  analysis: { label: "数据分析", color: "#06b6d4", icon: <FlaskConical className="h-3 w-3" /> },
  chart: { label: "图表产物", color: "#ec4899", icon: <GitBranch className="h-3 w-3" /> },
  writing: { label: "论文写作", color: "#6366f1", icon: <PenLine className="h-3 w-3" /> },
  review: { label: "审稿修订", color: "#f43f5e", icon: <ListChecks className="h-3 w-3" /> },
  deliverable: { label: "交付成果", color: "#22c55e", icon: <FileText className="h-3 w-3" /> },
  end: { label: "任务终点", color: "#64748b", icon: <Flag className="h-3 w-3" /> },
};
const STORAGE_KEY = "marx:dag:wksp:v1";

function genId(): string { return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function cn(...xs: Array<string | false | undefined>) { return xs.filter(Boolean).join(" "); }

async function j<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers as Record<string, string> || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败 ${r.status}`);
  return body as T;
}
function tokenOf() {
  return localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
}

// ═══ 画布节点组件(闭源 AgentFlowNode 对齐: index 序号+module 徽标+输入/输出 meta+progress+state) ═══
function DAGNodeChip({ data, id }: { data: { label: string; type: string; status?: string; index?: number | string; progress?: number; state?: string; systemStart?: boolean; locked?: boolean; module?: string; input?: string; output?: string }; id?: string }) {
  const meta = NODE_META[data.type] ?? NODE_META.goal;
  const statusColor = data.status === "done" ? "bg-green-500/20 text-green-300 border-green-500/40"
    : data.status === "running" ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
    : data.status === "failed" ? "bg-red-500/20 text-red-300 border-red-500/40"
    : "bg-slate-800/80 text-slate-200 border-slate-600/50";
  const state = data.state ?? "draft";
  return (
    <div className={cn("w-52 rounded-lg border px-2.5 py-2 text-left shadow-lg backdrop-blur", statusColor, state === "locked" || data.locked ? "opacity-60" : "")}
      style={{ borderLeft: `3px solid ${meta.color}` }}>
      {/* 连线柄(审查修复: 原节点无 Handle → ReactFlow 无法拖线) */}
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border !border-slate-500 !bg-cyan-300" />
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border !border-slate-500 !bg-cyan-300" />
      <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: meta.color }}>
        {/* R10/R16(闭源 AgentFlowNode): index 序号 + module 徽标 */}
        {(data.index !== undefined && data.index !== null) && <span className="text-[10px] font-bold">{data.index}</span>}
        {data.module ? (
          <span className="rounded bg-slate-600/30 px-1 py-px text-[8px] tracking-wide text-slate-400">{data.module}</span>
        ) : (meta.icon)}
        <span className="truncate">{meta.label}</span>
        {data.systemStart && <span className="ml-auto rounded bg-emerald-500/20 px-1 py-px text-[8px] text-emerald-300">起点</span>}
      </div>
      <div className="mt-1 truncate text-xs font-semibold">{data.label}</div>
      {/* R16(闭源 node-meta): 输入/输出 双 meta 行 */}
      {(data.input || data.output) && (
        <div className="mt-1 space-y-0.5">
          {data.input && <div className="flex items-center gap-1 text-[9px] text-slate-400"><span className="text-slate-500">输入</span><span className="truncate">{data.input}</span></div>}
          {data.output && <div className="flex items-center gap-1 text-[9px] text-slate-400"><span className="text-slate-500">输出</span><span className="truncate">{data.output}</span></div>}
        </div>
      )}
      {/* R10: progress 进度条(闭源 width=progress%) */}
      {typeof data.progress === "number" && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-900/60">
          <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(0, data.progress))}%`, background: meta.color }} />
        </div>
      )}
    </div>
  );
}
const nodeTypes: NodeTypes = { dag: DAGNodeChip };

export function DagWorkbenchPanel() {
  const [projects, setProjects] = useState<DagProject[]>([]);
  const [cur, setCur] = useState<DagProject | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [canvasVer, setCanvasVer] = useState(1);
  // 审查 P1-2: canvasVerRef 同步最新版本(密集编辑时防陈旧闭包 409 丢保存)
  const canvasVerRef = useRef(1);
  canvasVerRef.current = canvasVer;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"list" | "work" | "input">("list");
  // R16c: 新建项目自绘弹层(替代 window.prompt — 无头/自动化环境 prompt 卡死主线程)
  const [askNewProject, setAskNewProject] = useState<{ template: "blank" | "five-stage"; title: string } | null>(null);
  const [nlInput, setNlInput] = useState("");
  const [nlBusy, setNlBusy] = useState(false);
  const [selNode, setSelNode] = useState<Node | null>(null);
  const [nodePayload, setNodePayload] = useState<unknown>(null);
  const [nodeVersion, setNodeVersion] = useState(0);
  const [nodeHistory, setNodeHistory] = useState<Array<{ id: string; version: number; note: string; by_role: string; created_at: string }>>([]);
  const [showAnalyze, setShowAnalyze] = useState(false);
  const [analyzeBusy, setAnalyzeBusy] = useState(false);
  const [showMaterials, setShowMaterials] = useState(false);
  // T3-2: 章节创作三栏工作区(闭源 WorkspaceView 对齐)
  const [showSectionWs, setShowSectionWs] = useState(false);
  // T3-5: 合稿定稿独立页
  const [showFinalize, setShowFinalize] = useState(false);
  // T7: 科研架构确认页(闭源 /workflow/sections 对齐)
  const [showArchConfirm, setShowArchConfirm] = useState(false);
  // T7-2: 素材准备独立页(闭源 /workflow/materials 对齐)
  const [showMatPrep, setShowMatPrep] = useState(false);
  // SocialSci R5: 需求澄清
  const [showClarify, setShowClarify] = useState(false);
  const [clarifyBusy, setClarifyBusy] = useState(false);
  const [clarifyData, setClarifyData] = useState<{ analysis: string; questions: Array<{ id: string; category: string; question: string; guidance: string; importance: string }> } | null>(null);
  const [clarifyAnswers, setClarifyAnswers] = useState<string[]>([]);
  // E4(闭源 2 轮集中补齐): round 1 = 首轮 5 问; 答后可再点 → round 2 追问剩余模糊点(≤3)
  const [clarifyRound, setClarifyRound] = useState(0);
  const [clarifyHistory, setClarifyHistory] = useState<Array<{ question: string; answer: string }>>([]);

  const toggleClarify = async () => {
    if (showClarify) { setShowClarify(false); return; }
    if (!cur) return;
    setClarifyBusy(true); setErr("");
    try {
      const r = await j<{ success: boolean; data: { analysis: string; questions: Array<{ id: string; category: string; question: string; guidance: string; importance: string }> } }>("/api/clarify/generate", {
        method: "POST",
        body: JSON.stringify({ title: cur.title, researchMethod: cur.topic || undefined, round: 0 }),
      });
      if (!r.success) throw new Error("澄清生成失败");
      setClarifyData(r.data); setClarifyAnswers(new Array(r.data.questions.length).fill("")); setClarifyHistory([]); setClarifyRound(0); setShowClarify(true);
    } catch (e) { setErr((e as Error).message); } finally { setClarifyBusy(false); }
  };

  // E4: 第二轮集中补齐(带第一轮问答上下文追问)
  const clarifyFollowUp = async () => {
    if (!cur || !clarifyData) return;
    setClarifyBusy(true); setErr("");
    try {
      const hist = [
        ...clarifyHistory,
        ...clarifyData.questions.map((q, i) => ({ question: q.question, answer: (clarifyAnswers[i] ?? "").trim() || "未答" })),
      ];
      const r = await j<{ success: boolean; data: { analysis: string; questions: Array<{ id: string; category: string; question: string; guidance: string; importance: string }> } }>("/api/clarify/generate", {
        method: "POST",
        body: JSON.stringify({ title: cur.title, researchMethod: cur.topic || undefined, round: 1, answers: hist }),
      });
      if (!r.success) throw new Error("追问生成失败");
      setClarifyHistory(hist);
      if (r.data.questions.length === 0) {
        // 已无模糊点 → 直接归档
        await saveClarifyAnswersWith(hist);
        return;
      }
      setClarifyData(r.data); setClarifyAnswers(new Array(r.data.questions.length).fill("")); setClarifyRound(1);
    } catch (e) { setErr((e as Error).message); } finally { setClarifyBusy(false); }
  };

  const saveClarifyAnswers = async () => {
    if (!cur || !clarifyData) return;
    const hist = [
      ...clarifyHistory,
      ...clarifyData.questions.map((q, i) => ({ question: q.question, answer: (clarifyAnswers[i] ?? "").trim() || "无" })),
    ];
    await saveClarifyAnswersWith(hist);
  };

  const saveClarifyAnswersWith = async (hist: Array<{ question: string; answer: string }>) => {
    if (!cur) return;
    setErr("");
    try {
      const lines = hist.map((h) => `Q: ${h.question}\n  → ${h.answer}`);
      const text = `【AI需求澄清结果】\n${lines.join("\n")}`;
      await j(`/api/research/projects/${cur.id}/nodes/clarify`, {
        method: "PUT",
        body: JSON.stringify({ payload: { analysis: clarifyData?.analysis ?? "", qa: lines }, sourceRole: "user", note: "需求澄清归档" }),
      });
      setErr("已归档到 clarify 节点");
      setShowClarify(false);
    } catch (e) { setErr((e as Error).message); }
  };
  const dirtyRef = useRef(false);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  // 载入项目列表
  const loadProjects = useCallback(async () => {
    try {
      const r = await j<{ projects: DagProject[] }>("/api/research/projects");
      setProjects(r.projects);
    } catch (e) { setErr((e as Error).message); }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);
  // 会话恢复(原死代码: 解析即丢 — 补真消费; 另接历史中心 deep-resume: 从 history 卡跳入自动打开项目)
  useEffect(() => {
    // 优先: 历史中心 deep-resume 指针(sag:resume:workflow, 10s 窗口)
    const r = readResume("workflow");
    if (r?.projectId) { void openProject(String(r.projectId)); return; }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const p = JSON.parse(saved) as { projectId: string };
        if (p?.projectId) { void openProject(p.projectId); }
      } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 新建项目(空白 / 五阶段模板) → 录入向导对齐闭源(先建档, 再进向导补录输入/目录/澄清)
  const createProject = async (title: string, template: "blank" | "five-stage") => {
    setBusy(true); setErr("");
    try {
      const r = await j<{ id: string }>("/api/research/projects", {
        method: "POST", body: JSON.stringify({ title, topic: title, template }),
      });
      const p = await j<{ project: DagProject }>(`/api/research/projects/${r.id}`);
      setCur(p.project);
      setSelNode(null);
      setMode("input");
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ projectId: r.id }));
      void loadProjects();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // 打开项目 → 拉画布
  const openProject = async (projectId: string) => {
    setBusy(true); setErr("");
    try {
      const p = await j<{ project: DagProject }>(`/api/research/projects/${projectId}`);
      const c = await j<{ canvas: { nodes: Node[]; edges: Edge[] }; canvasVersion: number }>(`/api/research/projects/${projectId}/canvas`);
      setCur(p.project);
      setCanvasVer(c.canvasVersion);
      setNodes(c.canvas.nodes ?? []);
      setEdges(c.canvas.edges ?? []);
      setSelNode(null);
      setMode("work");
      dirtyRef.current = false;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ projectId }));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // 画布变更(自动保存, 乐观锁 2s 防抖)
  // 审查 P1-2: 409 时用响应 currentVersion 自动重试一次(密集编辑不再丢保存)
  // j() 封装丢弃 409 body 的 currentVersion → 用裸 fetch 解析
  const putCanvasOnce = async (n: Node[], e: Edge[], expected: number): Promise<{ ok: boolean; canvasVersion?: number; conflict?: boolean; currentVersion?: number; error?: string }> => {
    const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
    try {
      const resp = await fetch(`/api/research/projects/${cur!.id}/canvas`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ canvas: { nodes: n, edges: e }, expectedVersion: expected }),
      });
      const body = await resp.json().catch(() => ({}));
      if (resp.ok) return { ok: true, canvasVersion: (body as { canvasVersion?: number }).canvasVersion };
      if (resp.status === 409) {
        return { ok: false, conflict: true, currentVersion: (body as { currentVersion?: number }).currentVersion, error: (body as { error?: string }).error };
      }
      return { ok: false, error: (body as { error?: string }).error ?? `请求失败 ${resp.status}` };
    } catch (e2) {
      return { ok: false, error: (e2 as Error).message };
    }
  };
  const persistCanvas = useCallback((n: Node[], e: Edge[]) => {
    if (!cur) return;
    dirtyRef.current = true;
    if (loadTimer.current) clearTimeout(loadTimer.current);
    loadTimer.current = setTimeout(async () => {
      if (!cur || !dirtyRef.current) return;
      dirtyRef.current = false;
      const expected = canvasVerRef.current;
      const r = await putCanvasOnce(n, e, expected);
      if (r.ok) { if (r.canvasVersion !== undefined) { canvasVerRef.current = r.canvasVersion; setCanvasVer(r.canvasVersion); } return; }
      // 409 → 自动用服务器最新版本重试一次(内容基于最新画布, 无损)
      if (r.conflict && r.currentVersion !== undefined) {
        const r2 = await putCanvasOnce(n, e, r.currentVersion);
        if (r2.ok) { if (r2.canvasVersion !== undefined) { canvasVerRef.current = r2.canvasVersion; setCanvasVer(r2.canvasVersion); } return; }
      }
      setErr(`画布保存冲突/失败: ${(r as { error?: string }).error ?? "未知错误"} (请刷新重载)`);
    }, 2000);
  }, [cur]);

  const onConnect = useCallback((conn: Connection) => {
    if (!cur) return;
    setEdges((eds) => {
      // E2(闭源 manual-edge- 手动边): 用户手动画线=手动边(蓝), 后端自动补边=自动边(绿虚线)
      const next = addEdge({
        ...conn, id: `e${Date.now().toString(36)}`,
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { kind: "manual" },
        style: { stroke: "#38bdf8", strokeWidth: 1.5 },
      }, eds);
      persistCanvas(nodes, next);
      return next;
    });
  }, [cur, nodes, persistCanvas]);

  const addNode = (type: string) => {
    if (!cur) return;
    const meta = NODE_META[type] ?? NODE_META.goal;
    const id = genId();
    const n: Node = {
      id, type: "dag", position: { x: 120 + Math.random() * 200, y: 80 + Math.random() * 120 },
      data: { label: meta.label, type, status: "idle" },
    };
    setNodes((ns) => { persistCanvas([...ns, n], edges); return [...ns, n]; });
  };

  const deleteNode = (id: string) => {
    setNodes((ns) => { const next = ns.filter((x) => x.id !== id); persistCanvas(next, edges.filter((e) => e.source !== id && e.target !== id)); return next; });
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
  };

  // NL → DAG
  const runNlToDag = async () => {
    if (!cur || !nlInput.trim()) return;
    setNlBusy(true); setErr("");
    try {
      const r = await j<{ canvas: { nodes: Node[]; edges: Edge[] } }>(`/api/research/projects/${cur.id}/nl-to-dag`, {
        method: "POST", body: JSON.stringify({ description: nlInput.trim() }),
      });
      setNodes(r.canvas.nodes ?? []);
      setEdges(r.canvas.edges ?? []);
      setNlInput("");
      setCanvasVer((v) => v + 1);
    } catch (e) { setErr((e as Error).message); } finally { setNlBusy(false); }
  };

  // 节点工作界面: 载入快照 + 历史
  const openNodePanel = async (node: Node) => {
    if (!cur) return;
    setSelNode(node);
    const key = node.data.type as string; // 节点类型作 node_key
    try {
      const r = await j<{ node?: { payload: unknown; version: number } }>(`/api/research/projects/${cur.id}/nodes/${key}`);
      setNodePayload(r.node?.payload ?? null);
      setNodeVersion(r.node?.version ?? 0);
      const h = await j<{ history: Array<{ id: string; version: number; note: string; by_role: string; created_at: string }> }>(`/api/research/projects/${cur.id}/nodes/${key}/history`);
      setNodeHistory(h.history ?? []);
    } catch { setNodePayload(null); setNodeHistory([]); }
  };

  const saveNodePayload = async () => {
    if (!cur || !selNode) return;
    setBusy(true); setErr("");
    try {
      await j(`/api/research/projects/${cur.id}/nodes/${selNode.data.type}`, {
        method: "PUT",
        body: JSON.stringify({ payload: nodePayload ?? {}, sourceRole: "user", note: "画布工作界面编辑" }),
      });
      // 节点状态 → done
      setNodes((ns) => {
        const next = ns.map((n) => n.id === selNode.id ? { ...n, data: { ...n.data, status: "done" } } : n);
        persistCanvas(next, edges); return next;
      });
      await openNodePanel(selNode);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const rollbackNode = async (historyId: string) => {
    if (!cur || !selNode) return;
    setBusy(true); setErr("");
    try {
      await j(`/api/research/projects/${cur.id}/nodes/${selNode.data.type}/rollback`, {
        method: "POST", body: JSON.stringify({ historyId }),
      });
      await openNodePanel(selNode);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // 主控 Agent 分析
  const runAnalyze = async () => {
    if (!cur) return;
    setAnalyzeBusy(true); setErr("");
    try {
      const task = await j<{ task: { id: string } }>("/api/research/tasks", {
        method: "POST",
        body: JSON.stringify({ projectId: cur.id, jobKind: "analyze", goal: `科研架构分析: ${cur.title}`, dagNodeId: selNode?.id ?? "" }),
      });
      const r = await fetch(`/api/research/projects/${cur.id}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenOf()}` },
        body: JSON.stringify({ taskId: task.task.id }),
      });
      // SSE 读取
      const reader = r.body?.getReader();
      if (reader) {
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
          for (const p of parts) {
            const ev = p.match(/event: (\S+)/)?.[1];
            const data = p.match(/data: (.*)/s)?.[1];
            if (ev === "pipe.node" && data) {
              const obj = JSON.parse(data);
              if (obj.nodeKey === "analysis") setNodePayload(obj.payload);
            }
            if (ev === "pipe.error" && data) { const o = JSON.parse(data); setErr(o.userMessage || "分析失败"); }
          }
        }
      }
      setShowAnalyze(false);
      setSelNode(null);
      setNodePayload(null);
    } catch (e) { setErr((e as Error).message); } finally { setAnalyzeBusy(false); }
  };

  const backToList = () => { setMode("list"); setCur(null); setSelNode(null); localStorage.removeItem(STORAGE_KEY); loadProjects(); };

  // T3-4: 阶段跳转 — input/materials/sections/finalize 等画布节点找到即选中, analysis 触发面板提示
  const onPhaseJump = (stage: string) => {
    if (!cur) return;
    const target = nodes.find((n) => (n.data?.type as string) === stage);
    if (target) {
      setSelNode(target);
      setErr("");
      return;
    }
    // 节点不在画布: 该阶段是隐藏数据节点(向导/生成写入), 引导用对应操作
    if (stage === "sections") { setShowSectionWs(true); return; }
    if (stage === "input") { setErr("input 节点由录入向导写入 — 请在列表新建项目或 NL 生成框架后录入"); return; }
    if (stage === "analysis") { setShowAnalyze(true); return; }
    if (stage === "materials") { setShowMaterials(true); return; }
    if (stage === "finalize") { setShowFinalize(true); return; }
  };
  const selKey = selNode ? (selNode.data.type as string) : "";
  const meta = selNode ? (NODE_META[selNode.data.type as string] ?? NODE_META.goal) : null;

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      {/* T3-4: 全局阶段进度条(主题chip + 五阶段圆点; 仅画布工作态显示) */}
      {mode === "work" && cur && (
        <PhaseProgressBar
          projectTitle={cur.title}
          phase={cur.phase}
          phaseLabel={cur.phase_label || PHASE_STEPS[cur.phase]?.label}
          onJump={(stage) => onPhaseJump(stage)}
        />
      )}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5 text-cyan-400" />
          <h2 className="text-base font-bold text-slate-100">科研工作台 · 可视化 DAG 编排</h2>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">科研工作台</span>
        </div>
        {mode === "work" && cur && (
          <button onClick={backToList} className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-700">
            <ChevronDown className="h-3 w-3 rotate-90" /> 返回项目列表
          </button>
        )}
      </div>

      {err && (
        <div className="mb-2 flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <span>{err}</span>
          <button onClick={() => setErr("")}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {mode === "list" && (
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px] gap-4">
          {/* 项目列表 */}
          <div className="min-h-0 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400">我的科研项目 ({projects.length})</span>
              <div className="flex gap-2">
                <button disabled={busy} onClick={() => setAskNewProject({ template: "blank", title: "" })}
                  className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50">
                  <Plus className="h-3 w-3" /> 空白画布
                </button>
                <button disabled={busy} onClick={() => setAskNewProject({ template: "five-stage", title: "" })}
                  className="flex items-center gap-1 rounded-lg bg-cyan-600 px-2.5 py-1.5 text-xs text-white hover:bg-cyan-500 disabled:opacity-50">
                  <GitBranch className="h-3 w-3" /> 五阶段论文模板
                </button>
              </div>
            </div>
            {projects.length === 0 && !busy && (
              <div className="mt-10 flex flex-col items-center gap-2 text-slate-500">
                <Brain className="h-10 w-10 opacity-40" />
                <p className="text-sm">把想法变成可执行的研究任务</p>
                <p className="text-xs">新建空白画布自由编排, 或用五阶段模板一键铺开</p>
              </div>
            )}
            {projects.map((p) => (
              <div key={p.id} onClick={() => openProject(p.id)}
                className="mb-2 cursor-pointer rounded-lg border border-slate-700/60 bg-slate-800/60 p-3 transition hover:border-cyan-500/50 hover:bg-slate-800">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-200">{p.title}</span>
                  <span className="text-[10px] text-slate-500">{new Date(p.updated_at).toLocaleString()}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                  <Circle className="h-2 w-2" style={{ color: NODE_META[p.phase >= 5 ? "deliverable" : "analysis"].color }} />
                  {p.phase_label || `阶段 ${p.phase}`} · 画布 v{p.canvas_version}
                </div>
              </div>
            ))}
          </div>
          {/* 模式说明 */}
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-4">
            <h3 className="text-sm font-semibold text-slate-200">两种编排模式</h3>
            <div className="mt-3 space-y-3 text-xs text-slate-400">
              <div className="rounded-lg bg-slate-800/60 p-3">
                <div className="flex items-center gap-1.5 font-medium text-slate-200"><GitBranch className="h-3.5 w-3.5 text-cyan-400" /> 标准工作流模板</div>
                <p className="mt-1">目标→样本→文献→数据→分析→图表→写作→审稿→交付 十个研究要素自动连线</p>
              </div>
              <div className="rounded-lg bg-slate-800/60 p-3">
                <div className="flex items-center gap-1.5 font-medium text-slate-200"><Wand2 className="h-3.5 w-3.5 text-purple-400" /> 画布任务 (NL→DAG)</div>
                <p className="mt-1">用一句话描述研究需求, AI 自动拆成研究框架节点</p>
              </div>
              <div className="rounded-lg bg-slate-800/60 p-3">
                <div className="flex items-center gap-1.5 font-medium text-slate-200"><Brain className="h-3.5 w-3.5 text-amber-400" /> 节点工作界面</div>
                <p className="mt-1">双击节点打开: 编辑快照 / 主控 Agent 分析 / 历史回滚</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {mode === "input" && cur && (
        <ResearchInputWizard
          projectId={cur.id}
          title={cur.title}
          onDone={() => {
            setMode("work");
            // 审查修复: 向导提交后重拉画布(后端模板已铺 10 节点; 原实现不重拉 → 画布空等刷新)
            void (async () => {
              if (!cur) return;
              try {
                const c = await j<{ canvas: { nodes: Node[]; edges: Edge[] }; canvasVersion: number }>(`/api/research/projects/${cur.id}/canvas`);
                setCanvasVer(c.canvasVersion);
                setNodes(c.canvas.nodes ?? []);
                setEdges(c.canvas.edges ?? []);
              } catch { /* 容忍 */ }
            })();
            // T7 对齐闭源: 提交 → 进"科研架构确认页"(自动生成, 失败可重试, 确认才进创作)
            setShowArchConfirm(true);
          }}
          onCancel={backToList}
          onMsg={(m) => setErr(m)}
        />
      )}
      {mode === "work" && cur && (
        <div className="flex min-h-0 flex-1 gap-3">
          {/* 左: 节点调色板 */}
          <div className="w-44 shrink-0 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-2">
            <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">研究要素</p>
            {Object.entries(NODE_META).filter(([k]) => k !== "end").map(([k, m]) => (
              <button key={k} onClick={() => addNode(k)}
                className="mb-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800"
                style={{ borderLeft: `2px solid ${m.color}` }}>
                {m.icon}<span className="truncate">{m.label}</span>
              </button>
            ))}
            {/* NL 输入 */}
            <div className="mt-3 border-t border-slate-700/50 pt-2">
              <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">画布任务</p>
              <textarea value={nlInput} onChange={(e) => setNlInput(e.target.value)} rows={3}
                placeholder="用一句话描述你的研究需求…"
                className="w-full resize-none rounded-lg border border-slate-600/60 bg-slate-800 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-500" />
              <button onClick={runNlToDag} disabled={nlBusy || !nlInput.trim()}
                className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg bg-purple-600 px-2 py-1.5 text-xs text-white hover:bg-purple-500 disabled:opacity-50">
                {nlBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />} 生成研究框架
              </button>
            </div>
          </div>

          {/* 中: 画布 */}
          <div className="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-slate-700/60 bg-slate-950/60">
            <div className="absolute left-2 top-2 z-10 flex items-center gap-2 rounded-lg bg-slate-900/80 px-2.5 py-1 text-[11px] text-slate-400 backdrop-blur">
              <span>{cur.title} · 画布 v{canvasVer}</span>
              <button onClick={() => setShowMaterials((v) => !v)} title="素材库"
                className={showMaterials ? "flex items-center gap-1 rounded bg-cyan-600/30 px-1.5 py-0.5 text-cyan-300" : "flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-slate-700 hover:text-slate-200"}>
                <Database className="h-3 w-3" />素材
              </button>
            </div>
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={nodeTypes}
              // E2(闭源三色边): 手动边蓝实线(onConnect 标 manual) / 后端模板·自动补边绿虚线(默认)
              defaultEdgeOptions={{
                markerEnd: { type: MarkerType.ArrowClosed },
                style: { stroke: "#4ade80", strokeWidth: 1.5, strokeDasharray: "5 3" },
              }}
              onNodesChange={(ch) => {
                onNodesChange(ch);
                // 拖拽结束落库
                if (ch.some((c) => c.type === "position")) {
                  dirtyRef.current = true;
                  if (loadTimer.current) clearTimeout(loadTimer.current);
                  loadTimer.current = setTimeout(() => {
                    const curNodes = nodesRef.current;
                    if (cur && curNodes.length) persistCanvas(curNodes, edgesRef.current);
                  }, 1500);
                }
              }}
              // 审查 P2-8: 仅 add/remove 边触发持久化(选择/悬浮是 UI 态不落库)
              onEdgesChange={(ch) => { onEdgesChange(ch); if (ch.some((c) => c.type === "add" || c.type === "remove")) persistCanvas(nodesRef.current, edgesRef.current); }}
              onConnect={onConnect}
              onNodeClick={(_, n) => openNodePanel(n)}
              onNodeDoubleClick={(_, n) => openNodePanel(n)}
              onPaneClick={() => { setSelNode(null); setNodePayload(null); }}
              fitView minZoom={0.3} maxZoom={1.8}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={18} />
              <Controls />
              <MiniMap pannable zoomable className="!bg-slate-900" nodeColor={(n) => NODE_META[(n.data?.type as string) ?? "goal"]?.color ?? "#64748b"} />
            </ReactFlow>
            {/* 素材库抽屉(节点工作界面联动: 双击节点时高亮该节点素材) */}
            <MaterialsDrawer
              projectId={cur.id}
              open={showMaterials}
              onClose={() => setShowMaterials(false)}
              highlightDagNode={selNode?.id ?? null}
            />
          </div>

          {/* 右: 节点工作界面 / 项目操作 */}
          <div className="w-80 shrink-0 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
            {!selNode ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-300">项目操作</p>
                <button onClick={() => setShowSectionWs(true)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-cyan-600 px-2 py-2 text-xs text-white hover:bg-cyan-500">
                  <PenLine className="h-3.5 w-3.5" /> 章节创作工作区 (三栏)
                </button>
                <button data-control="dag_main_analyze" onClick={() => setShowAnalyze((v) => !v)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-2 py-2 text-xs text-white hover:bg-amber-500">
                  <Sparkles className="h-3.5 w-3.5" /> 主控 Agent 科研架构分析
                </button>
                {/* SocialSci R5: 需求澄清 */}
                <button data-control="dag_clarify" onClick={toggleClarify} disabled={clarifyBusy}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-2 py-2 text-xs text-white hover:bg-sky-500 disabled:opacity-50">
                  {clarifyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <HelpCircle className="h-3.5 w-3.5" />} 需求澄清 (AI 追问)
                </button>
                {showClarify && clarifyData && (
                  <div className="space-y-2 rounded-lg border border-sky-500/30 bg-sky-500/5 p-2">
                    <p className="text-[11px] leading-relaxed text-slate-400">{clarifyData.analysis}</p>
                    {clarifyData.questions.map((q, qi) => (
                      <div key={q.id} className="rounded-lg bg-slate-800/60 p-2">
                        <p className="flex items-start gap-1 text-[11px] font-medium text-slate-200">
                          <span className="mt-0.5 rounded bg-sky-500/20 px-1 text-[9px] text-sky-300">{q.category}</span>
                          {qi + 1}. {q.question}
                          <span className={cn("ml-auto shrink-0 rounded px-1 text-[9px]", q.importance === "高" ? "bg-rose-500/20 text-rose-300" : q.importance === "中" ? "bg-amber-500/20 text-amber-300" : "bg-slate-600/40 text-slate-400")}>{q.importance}</span>
                        </p>
                        <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{q.guidance}</p>
                        <input value={clarifyAnswers[qi] ?? ""} onChange={(e) => setClarifyAnswers((a) => { const n = [...a]; n[qi] = e.target.value; return n; })}
                          placeholder="回答(可选, 将归档进研究要求)" className="mt-1.5 w-full rounded border border-slate-600/50 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
                      </div>
                    ))}
                    <div className="flex gap-1.5">
                      {/* E4: 第二轮集中补齐(round 1 时改为归档) */}
                      {clarifyRound === 0 && (
                        <button onClick={clarifyFollowUp} disabled={clarifyBusy}
                          className="flex-1 rounded-lg border border-sky-600/50 py-1.5 text-[11px] text-sky-300 hover:bg-sky-500/10 disabled:opacity-50">
                          {clarifyBusy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : null}继续追问 (第二轮补齐)
                        </button>
                      )}
                      <button onClick={saveClarifyAnswers} className="flex-1 rounded-lg bg-sky-600 py-1.5 text-[11px] text-white hover:bg-sky-500">
                        {clarifyRound === 0 ? "归档回答到研究要求" : "归档两轮回答"}
                      </button>
                    </div>
                  </div>
                )}
                {showAnalyze && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-slate-400">
                    分析产出: 变量识别 + 章节规划 + 逻辑主线, 存入 analysis 节点快照(可回滚)。<br />
                    <button data-control="dag_run_analyze" onClick={runAnalyze} disabled={analyzeBusy}
                      className="mt-2 flex items-center gap-1 rounded-lg bg-amber-600 px-2 py-1 text-[11px] text-white hover:bg-amber-500 disabled:opacity-50">
                      {analyzeBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Brain className="h-3 w-3" />} 开始分析 (SSE 流式)
                    </button>
                  </div>
                )}
                <div className="pt-2 text-[10px] leading-relaxed text-slate-600">
                  提示: 双击画布节点打开工作界面(查看/编辑快照、执行任务、历史回滚); 拖拽连线表示产物流转依赖; 编辑后自动保存画布(乐观锁防多窗口覆盖)。
                </div>
                {/* SocialSci UI审计T2: 进行中任务状态区(分级文案) */}
                <RunningTasks projectId={cur.id} />
                {/* SocialSci UI审计T3: 章节完成度进度条 */}
                <SectionProgress projectId={cur.id} onMsg={(m) => setErr(m)} onFinalize={() => setShowFinalize(true)} />
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: meta?.color }}>
                    {meta?.icon} {meta?.label} · {String(selNode.data?.label ?? "")}
                  </p>
                  <div className="flex gap-1">
                    <button title="删除节点" onClick={() => { deleteNode(selNode.id); setSelNode(null); }} className="rounded p-1 text-slate-500 hover:bg-red-500/20 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" /></button>
                    <button title="关闭" onClick={() => setSelNode(null)} className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-300"><X className="h-3.5 w-3.5" /></button>
                  </div>
                </div>

                {/* 节点任务 */}
                <div className="mt-2 rounded-lg bg-slate-800/50 p-2">
                  <p className="text-[10px] font-semibold uppercase text-slate-500">执行任务</p>
                  <div className="mt-1.5 flex gap-1.5">
                    <button onClick={() => {
                      const k = selNode.data.type as string;
                      const t = NODE_META[k]?.label ?? k;
                      void j("/api/research/tasks", { method: "POST", body: JSON.stringify({ projectId: cur.id, dagNodeId: selNode.id, jobKind: "custom", goal: `执行: ${t}` }) });
                    }} className="flex-1 rounded-lg bg-cyan-600 px-2 py-1.5 text-[11px] text-white hover:bg-cyan-500">
                      <Send className="mr-1 inline h-3 w-3" />创建执行任务
                    </button>
                    {selKey === "analysis" && (
                      <button onClick={runAnalyze} disabled={analyzeBusy} className="flex-1 rounded-lg bg-amber-600 px-2 py-1.5 text-[11px] text-white hover:bg-amber-500 disabled:opacity-50">
                        {analyzeBusy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <Brain className="mr-1 inline h-3 w-3" />}AI 分析
                      </button>
                    )}
                    {/* SocialSci R2: 章节写作卡(aiSkill) */}
                    {selKey === "sections" && (
                      <SkillCardButton projectId={cur.id} onMsg={(m) => setErr(m)} />
                    )}
                  </div>
                </div>

                {/* 快照编辑: analysis 节点含结构化产出时渲染可读卡片(闭源: 结构化3步面板语义) */}
                {selKey === "analysis" && isStructuredAnalysis(nodePayload) ? (
                  <AnalysisSnapshotView payload={nodePayload} />
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] font-semibold uppercase text-slate-500">节点快照 v{nodeVersion}</p>
                      <span className="flex items-center gap-1 text-[10px] text-slate-500"><Save className="h-2.5 w-2.5" />自动原子保存</span>
                    </div>
                    <textarea
                      value={nodePayload ? JSON.stringify(nodePayload, null, 1) : ""}
                      onChange={(e) => { try { setNodePayload(JSON.parse(e.target.value)); } catch { /* 半输入状态忽略 */ } }}
                      rows={10} spellCheck={false}
                      className="mt-1.5 w-full resize-none rounded-lg border border-slate-600/50 bg-slate-950/60 px-2 py-1.5 font-mono text-[11px] text-slate-300" />
                  </>
                )}
                <div className="mt-1.5 flex gap-1.5">
                  <button onClick={saveNodePayload} disabled={busy}
                    className="flex items-center gap-1 rounded-lg bg-green-600 px-2 py-1.5 text-[11px] text-white hover:bg-green-500 disabled:opacity-50">
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} 保存快照
                  </button>
                  <button onClick={() => { setSelNode((n) => { if (!n) return null; setNodes((ns) => { const next = ns.map((x) => x.id === n.id ? { ...x, data: { ...x.data, status: "done" } } : x); persistCanvas(next, edges); return next; }); return n; }); }}
                    className="flex items-center gap-1 rounded-lg bg-slate-700 px-2 py-1.5 text-[11px] text-slate-200 hover:bg-slate-600">
                    <CheckCircle2 className="h-3 w-3" /> 标记完成
                  </button>
                </div>

                {/* 历史/回滚 */}
                {nodeHistory.length > 0 && (
                  <div className="mt-2 rounded-lg bg-slate-800/50 p-2">
                    <p className="flex items-center gap-1 text-[10px] font-semibold uppercase text-slate-500">
                      <RotateCcw className="h-2.5 w-2.5" /> 历史版本 ({nodeHistory.length})
                    </p>
                    <div className="mt-1 max-h-32 space-y-1 overflow-y-auto">
                      {nodeHistory.map((h) => (
                        <div key={h.id} className="flex items-center justify-between rounded bg-slate-900/60 px-2 py-1 text-[10px] text-slate-400">
                          <span>v{h.version} · {h.by_role} {h.note && `(${h.note})`}</span>
                          <button onClick={() => rollbackNode(h.id)} className="text-cyan-400 hover:text-cyan-300">回滚</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* T3-2: 章节创作三栏工作区(全屏覆盖, 从项目操作进入) */}
      {mode === "work" && cur && showSectionWs && (
        <SectionWorkspaceView
          projectId={cur.id}
          title={cur.title}
          onBack={() => setShowSectionWs(false)}
          onMsg={(m) => setErr(m)}
        />
      )}
      {/* T7-2: 素材准备独立页(全屏覆盖) */}
      {mode === "work" && cur && showMatPrep && (
        <MaterialPrepPage
          projectId={cur.id}
          title={cur.title}
          onBack={() => { setShowMatPrep(false); setShowArchConfirm(true); }}
          onConfirm={() => { setShowMatPrep(false); setShowSectionWs(true); }}
          onMsg={(m) => setErr(m)}
          onGotoAnalysis={() => { setErr("实证研究模块在左侧导航「实证研究」打开"); }}
          onGotoViz={() => { setErr("科研绘图模块在左侧导航「科研绘图」打开"); }}
        />
      )}
      {/* T7: 科研架构确认页(全屏覆盖) */}
      {mode === "work" && cur && showArchConfirm && (
        <ArchitectureConfirmView
          projectId={cur.id}
          title={cur.title}
          onConfirm={() => { setShowArchConfirm(false); setShowMatPrep(true); }}
          onBack={() => { setShowArchConfirm(false); setMode("input"); }}
          onMsg={(m) => setErr(m)}
        />
      )}
      {/* T3-5: 合稿定稿独立页(全屏覆盖) */}
      {mode === "work" && cur && showFinalize && (
        <FinalizeView
          projectId={cur.id}
          title={cur.title}
          onBack={() => setShowFinalize(false)}
          onMsg={(m) => setErr(m)}
        />
      )}

      {/* 新建项目弹层(R16c: 替代 window.prompt, 自绘标题 input + 创建) */}
      {askNewProject && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={() => setAskNewProject(null)}>
          <div className="w-full max-w-sm rounded-xl border border-slate-600/60 bg-slate-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <p className="mb-1 text-sm font-semibold text-slate-100">
              {askNewProject.template === "five-stage" ? "新建五阶段论文项目" : "新建空白项目"}
            </p>
            <p className="mb-3 text-[11px] text-slate-500">
              {askNewProject.template === "five-stage" ? "论文主题 → 五阶段模板一键铺开(目标→样本→文献→数据→分析→图表→写作→审稿→交付)" : "自定义画布自由编排"}
            </p>
            <input
              value={askNewProject.title}
              onChange={(e) => setAskNewProject({ ...askNewProject, title: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter" && askNewProject.title.trim()) { const t = askNewProject.title.trim(); setAskNewProject(null); void createProject(t, askNewProject.template); } }}
              autoFocus placeholder={askNewProject.template === "five-stage" ? "论文主题 (如: 数字经济与中小企业融资约束)" : "项目标题"}
              className="w-full rounded-lg border border-slate-600/60 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500" />
            <div className="mt-3 flex gap-2">
              <button onClick={() => setAskNewProject(null)} className="flex-1 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-400 hover:bg-slate-700">取消</button>
              <button disabled={busy || !askNewProject.title.trim()}
                onClick={() => { const t = askNewProject.title.trim(); setAskNewProject(null); void createProject(t, askNewProject.template); }}
                className="flex-1 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50">创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// SocialSci UI审计T4/闭源结构化分析3步语义: analysis 节点快照的可读面板
// (变量识别 → 章节框架 → 逻辑主线/指导), 非结构化时退回 JSON 编辑
interface AnalysisPayload {
  variables?: { kind?: string; list?: Array<{ name?: string; role?: string; description?: string }> };
  chapterPlan?: Array<{ title?: string; level?: number; requirements?: string }>;
  logicChain?: string;
  clarifyQuestions?: string[];
  stepAnalysisTexts?: Record<string, string>;
}
function isStructuredAnalysis(p: unknown): p is AnalysisPayload {
  return !!p && typeof p === "object" && ("variables" in p || "chapterPlan" in p || "logicChain" in p);
}
const VAR_ROLE_LABEL: Record<string, string> = {
  dependent: "因变量", independent: "自变量", mediator: "中介变量", moderator: "调节变量", control: "控制变量",
};
function AnalysisSnapshotView({ payload }: { payload: AnalysisPayload }) {
  const vars = payload.variables?.list ?? [];
  const kind = payload.variables?.kind ?? "unknown";
  const steps = [
    { icon: "①", title: "变量识别", items: vars.length ? `${kind === "mixed" ? "混合" : kind === "quantitative" ? "定量" : "定性"}设计, ${vars.length} 个变量` : "无(定性/尚未识别)", inner: vars.length > 0 },
    { icon: "②", title: "章节框架", items: `${payload.chapterPlan?.length ?? 0} 个一级章节`, inner: (payload.chapterPlan?.length ?? 0) > 0 },
    { icon: "③", title: "逻辑主线与指导", items: payload.logicChain || "尚未生成", inner: !!payload.logicChain },
  ];
  return (
    <div className="mt-2 space-y-2">
      <p className="text-[10px] font-semibold uppercase text-slate-500">科研架构 · 结构化分析(主控 Agent 产出)</p>
      {/* 3步状态 */}
      <div className="grid grid-cols-3 gap-1">
        {steps.map((s) => (
          <div key={s.title} className={s.inner ? "rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2" : "rounded-lg border border-slate-700/50 bg-slate-800/40 p-2"}>
            <p className={s.inner ? "text-[10px] font-semibold text-emerald-300" : "text-[10px] font-semibold text-slate-500"}>{s.icon} {s.title}</p>
            <p className="mt-0.5 line-clamp-2 text-[9px] leading-relaxed text-slate-400">{s.items}</p>
          </div>
        ))}
      </div>
      {/* 变量卡 */}
      {vars.length > 0 && (
        <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-2">
          <p className="mb-1 text-[10px] font-semibold text-slate-300">变量清单 ({vars.length})</p>
          <div className="grid grid-cols-2 gap-1">
            {vars.map((v, i) => (
              <div key={i} className="rounded bg-slate-900/70 px-1.5 py-1">
                <p className="text-[10px] font-medium text-slate-200">{v.name || `变量${i + 1}`}</p>
                <p className="text-[9px] text-slate-500">{(v.role && VAR_ROLE_LABEL[v.role]) || v.role || "—"}{v.description ? ` · ${String(v.description).slice(0, 24)}` : ""}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* 章节规划 */}
      {(payload.chapterPlan?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-2">
          <p className="mb-1 text-[10px] font-semibold text-slate-300">章节框架 ({payload.chapterPlan!.length})</p>
          <div className="space-y-0.5">
            {payload.chapterPlan!.map((c, i) => (
              <p key={i} className="text-[10px] leading-relaxed text-slate-300">
                <span className="mr-1 text-slate-500">{i + 1}.</span>{c.title}
                {c.requirements && <span className="text-slate-500"> — {String(c.requirements).slice(0, 40)}</span>}
              </p>
            ))}
          </div>
        </div>
      )}
      {payload.clarifyQuestions?.length ? (
        <p className="text-[9px] text-slate-500">待澄清 {payload.clarifyQuestions.length} 问(点"需求澄清"逐条回答归档)</p>
      ) : null}
    </div>
  );
}

// ═══ T3-4: 全局阶段进度条(对齐闭源 PhaseProgressBar: 主题chip+阶段圆点, 点击跳阶段) ═══
export const PHASE_STEPS: Array<{ key: string; label: string; nodeKey: string }> = [
  { key: "input", label: "信息录入", nodeKey: "input" },
  { key: "analysis", label: "科研架构", nodeKey: "analysis" },
  { key: "materials", label: "素材准备", nodeKey: "materials" },
  { key: "sections", label: "章节创作", nodeKey: "sections" },
  { key: "finalize", label: "合并定稿", nodeKey: "finalize" },
];
function PhaseProgressBar({ projectTitle, phase, phaseLabel, onJump }: {
  projectTitle: string; phase: number; phaseLabel?: string; onJump: (stage: string) => void;
}) {
  // phase(0..5) 对应游标: 0=未入录(列表), 1=input, 2=analysis, 3=materials, 4=sections, 5=finalize/published
  const cur = Math.max(1, Math.min(5, phase || 1));
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-700/60 bg-slate-900/70 px-3 py-2">
      <span className="flex max-w-56 items-center gap-1 truncate rounded-full bg-slate-800 px-3 py-1 text-[11px] font-semibold text-slate-200">
        <Network className="h-3 w-3 shrink-0 text-cyan-400" />
        <span className="truncate">{projectTitle}</span>
      </span>
      <div className="flex min-w-0 flex-1 items-center justify-between gap-1">
        {PHASE_STEPS.map((s, i) => {
          const stepNo = i + 1;
          const done = stepNo < cur;
          const active = stepNo === cur;
          return (
            <div key={s.key} className="flex min-w-0 flex-1 items-center">
              <button onClick={() => onJump(s.key)} title={`跳到阶段: ${s.label}`}
                className="flex min-w-0 items-center gap-1.5">
                <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold",
                  done ? "bg-green-500/25 text-green-300" : active ? "bg-cyan-500 text-white" : "bg-slate-800 text-slate-500")}>
                  {done ? "✓" : stepNo}
                </span>
                <span className={cn("hidden truncate text-[10px] lg:inline", active ? "font-semibold text-cyan-300" : done ? "text-slate-400" : "text-slate-600")}>{s.label}</span>
              </button>
              {i < PHASE_STEPS.length - 1 && (
                <span className={cn("mx-1 h-px flex-1", stepNo < cur ? "bg-green-500/40" : "bg-slate-700")} />
              )}
            </div>
          );
        })}
      </div>
      {phaseLabel ? <span className="shrink-0 rounded-full bg-cyan-500/15 px-2 py-0.5 text-[10px] text-cyan-300">{phaseLabel}</span> : null}
    </div>
  );
}

// SocialSci R2: 章节写作卡按钮(aiSkill 9字段生成; sections 节点需含章节)
function SkillCardButton({ projectId, onMsg }: { projectId: string; onMsg: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [cards, setCards] = useState<Array<{ section_title: string; skill_type: string; writing_goal: string; word_count: number }>>([]);

  const run = async () => {
    setBusy(true);
    try {
      // 从 sections 节点读章节清单 → 批量生成技能卡
      const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
      const h = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      const node = await fetch(`/api/research/projects/${projectId}/nodes/sections`, { headers: h }).then((r) => r.json());
      const secs = (node?.node?.payload?.sections ?? node?.payload?.sections ?? []).filter((s: { title?: string }) => s.title).slice(0, 20);
      if (!secs.length) { onMsg("sections 节点还没有章节, 先建章节"); return; }
      const r = await fetch(`/api/research/projects/${projectId}/skill-cards/batch`, {
        method: "POST", headers: h,
        body: JSON.stringify({ sections: secs.map((s: { id?: string; title: string; level?: number }) => ({ id: s.id ?? s.title, title: s.title, level: s.level })) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "生成失败");
      onMsg(`已生成 ${d.okCount}/${secs.length} 张章节写作卡`);
      const list = await fetch(`/api/research/projects/${projectId}/skill-cards`, { headers: h }).then((r) => r.json());
      setCards(list.cards ?? []);
    } catch (e) { onMsg((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="mt-1.5 w-full">
      <button onClick={run} disabled={busy}
        className="w-full rounded-lg bg-purple-600 px-2 py-1.5 text-[11px] text-white hover:bg-purple-500 disabled:opacity-50">
        {busy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 inline h-3 w-3" />}
        生成章节写作卡(aiSkill)
      </button>
      {cards.length > 0 && (
        <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
          {cards.map((c, i) => (
            <div key={i} className="rounded bg-slate-900/60 px-2 py-1">
              <p className="text-[10px] font-medium text-slate-300">{c.section_title} <span className="ml-1 rounded bg-purple-500/20 px-1 text-[8px] text-purple-300">{c.skill_type} · {c.word_count}字</span></p>
              <p className="mt-0.5 line-clamp-2 text-[9px] text-slate-500">{c.writing_goal}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══ SocialSci UI审计 T2: 运行中任务状态区(分级文案, 2s轮询) ═══
const JOB_LABELS: Record<string, string> = {
  "phase4_batch": "正在批量生成章节", chapter_batch: "正在批量生成章节",
  "theory-generate": "正在生成理论框架素材", "table-generate": "正在生成表格设计素材",
  "literature-search": "正在检索文献方案", merge: "正在合并定稿", phase5_merge: "正在合并定稿",
  review: "正在全文审查", revise: "正在修订去AI痕迹",
  analyze: "正在进行结构化分析", chapter_gen: "正在生成章节内容",
};
function RunningTasks({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<Array<{ id: string; jobKind: string; status: string; goal: string; progress?: { stage?: string; current?: number; total?: number }; resultText?: string; summary?: string }>>([]);
  const [busyMsg, setBusyMsg] = useState("");
  useEffect(() => {
    if (!projectId) return;
    let stop = false;
    const poll = async () => {
      try {
        const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
        const r = await fetch(`/api/research/tasks?status=running,queued&projectId=${encodeURIComponent(projectId)}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const d = await r.json().catch(() => ({ tasks: [] }));
        if (stop) return;
        // E3 fix: 保留最近 2 条 done(灰显完成摘要) + 全部运行中任务
        type RawTask = { id: string; jobKind: string; goal: string; status: string; progress?: { stage?: string; current?: number; total?: number }; result?: unknown };
        const all = (d.tasks ?? []) as RawTask[];
        const running = all.filter((t) => t.status !== "done");
        const recentDone = all.filter((t) => t.status === "done").slice(0, 2).map((t) => {
          // result 可能 {text} 或字符串 — 提取前 80 字摘要
          const res = t.result as { text?: string } | string | null | undefined;
          const txt = typeof res === "string" ? res : (res?.text ?? "");
          return { ...t, resultText: txt.replace(/\s+/g, " ").trim().slice(0, 80) };
        });
        const list = [...running, ...recentDone];
        setTasks(list);
        // 分级busy文案: 优先级 batch > section > material > analysis
        const prio = ["phase4_batch", "chapter_batch", "chapter_gen", "theory-generate", "table-generate", "literature-search", "analyze", "merge", "review", "revise"];
        const active = running.find((t) => prio.includes(t.jobKind));
        setBusyMsg(active ? (JOB_LABELS[active.jobKind] ?? "当前操作处理中") : running.length ? "任务处理中" : "");
      } catch { /* 静默 */ }
    };
    void poll();
    const iv = setInterval(poll, 2000);
    return () => { stop = true; clearInterval(iv); };
  }, [projectId]);
  if (tasks.length === 0 && !busyMsg) return null;
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-200">
        <Loader2 className="h-3 w-3 animate-spin" />
        {busyMsg || "任务处理中"}
      </p>
      {tasks.slice(0, 4).map((t) => (
        <div key={t.id} className="rounded bg-slate-900/60 px-2 py-1 text-[10px]">
          <div className="flex items-center justify-between">
            {/* E3(闭源消息卡 kind): 按 jobKind 映射消息类型徽标 — plan=规划/artifact=产物/
                question=澄清/progress=进度/text=文本 */}
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn("shrink-0 rounded px-1 py-px text-[8px] font-semibold",
                t.jobKind === "phase4_batch" || t.jobKind === "chapter_batch" || t.jobKind === "merge" ? "bg-purple-500/20 text-purple-300"
                  : t.jobKind === "literature-search" || t.jobKind === "table-generate" || t.jobKind === "theory-generate" || t.jobKind === "chapter_gen" ? "bg-emerald-500/20 text-emerald-300"
                    : t.jobKind === "clarify" ? "bg-sky-500/20 text-sky-300" : "bg-slate-600/40 text-slate-400")}>
                {t.jobKind === "phase4_batch" || t.jobKind === "chapter_batch" || t.jobKind === "merge" || t.jobKind === "revise" ? "PLAN"
                  : t.jobKind === "literature-search" || t.jobKind === "table-generate" || t.jobKind === "theory-generate" ? "ARTIFACT"
                    : t.jobKind === "clarify" ? "QUESTION" : t.jobKind === "analyze" ? "PLAN" : "TEXT"}
              </span>
              <span className="truncate text-slate-400">{JOB_LABELS[t.jobKind] ?? t.jobKind}: {t.goal?.slice(0, 26) ?? ""}</span>
            </span>
            <span className={cn("shrink-0 rounded px-1.5 py-0.5", t.status === "running" ? "bg-amber-500/20 text-amber-300" : "bg-sky-500/20 text-sky-300")}>{t.status === "running" ? "执行中" : "排队中"}</span>
          </div>
          {(t.progress?.stage) && (
            <div className="mt-1 flex items-center gap-1.5">
              <span className="shrink-0 text-slate-500">{String(t.progress.stage)}</span>
              {typeof t.progress.current === "number" && t.progress.total && (
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-700">
                  <div className="h-full rounded-full bg-cyan-500 transition-all" style={{ width: `${Math.round((t.progress.current / t.progress.total) * 100)}%` }} />
                </div>
              )}
              {typeof t.progress.current === "number" && t.progress.total && <span className="shrink-0 text-slate-500">{t.progress.current}/{t.progress.total}</span>}
            </div>
          )}
          {/* E3: node-update 型 — 完成后展示产物摘要(如有 result 摘要) */}
          {(t.status === "done" && (t.resultText || t.summary)) && (
            <p className="mt-1 truncate text-[9px] text-emerald-300/80">✓ {(t.resultText || t.summary)?.slice(0, 60)}</p>
          )}
        </div>
      ))}
      {tasks.length > 4 && <p className="text-[9px] text-slate-500">…还有 {tasks.length - 4} 个任务</p>}
    </div>
  );
}

// ═══ SocialSci UI审计 T3: 章节完成度进度条(一级章 X/Y + 未完成门禁) ═══
function SectionProgress({ projectId, onMsg, onFinalize }: { projectId: string; onMsg: (m: string) => void; onFinalize?: () => void }) {
  const [stat, setStat] = useState<{ done: number; total: number; topUnfinished: number; subWith: number; subTotal: number } | null>(null);
  const [cached, setCached] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let stop = false;
    const poll = async () => {
      try {
        const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
        const r = await fetch(`/api/research/projects/${projectId}/nodes/sections`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const d = await r.json().catch(() => ({}));
        if (stop) return;
        const secs = d?.node?.payload?.sections ?? d?.payload?.sections ?? [];
        if (!Array.isArray(secs) || !secs.length) { setStat(null); return; }
        const sec = (x: unknown) => x as { level?: number; status?: string; content?: string };
        const top = secs.filter((s) => sec(s).level === 1);
        const doneTop = top.filter((s) => sec(s).status === "done" || (sec(s).content ?? "").trim().length > 100).length;
        const sub = secs.filter((s) => (sec(s).level ?? 2) > 1);
        const subWith = sub.filter((s: { content?: string }) => String(s.content ?? "").trim()).length;
        setStat({ done: doneTop, total: top.length, topUnfinished: top.length - doneTop, subWith, subTotal: sub.length });
      } catch { /* 静默 */ }
    };
    void poll();
    const iv = setInterval(poll, 3000);
    return () => { stop = true; clearInterval(iv); };
  }, [projectId]);
  // 缓存曾见到的完成度, 避免无节点时闪烁
  if (stat && stat.total > 0) { /* 直接显示 */ }
  else if (!stat) return null;
  const s = stat!;
  const pct = s.total === 0 ? 0 : Math.round((s.done / s.total) * 100);
  const allDone = s.total > 0 && s.topUnfinished === 0;
  return (
    <div className="mt-2 rounded-lg border border-slate-700/50 bg-slate-800/50 p-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-slate-300">
          章节完成度 <span className="text-slate-500">({s.done}/{s.total} 一级章)</span>
        </p>
        {allDone ? (
          <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[9px] text-green-300">可进入合稿</span>
        ) : s.total > 0 ? (
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] text-amber-300">缺 {s.topUnfinished} 章</span>
        ) : null}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-700">
        <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-400 transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[9px] text-slate-500">
        {s.total === 0 ? "先创建章节清单(科研架构分析后自动生成)" :
         allDone ? (s.subTotal > 0 && s.subWith < s.subTotal ? `还有 ${s.subTotal - s.subWith} 个子节未写正文, 可先行合稿或补全` : "全部章节已完成, 可进入合并定稿") :
         `还有 ${s.topUnfinished} 个一级章节未完成, 全部完成后再进入合并定稿`}
      </p>
      <div className="mt-1.5 flex gap-1.5">
        <button disabled={!allDone || s.total === 0}
          onClick={() => (allDone && onFinalize ? onFinalize() : onMsg(allDone ? "调用合并: 在'章节'节点工作界面创建 phase5 merge 任务" : "先完成全部一级章节"))}
          className={cn("flex-1 rounded-lg py-1 text-[10px]", allDone ? "bg-emerald-600 text-white hover:bg-emerald-500" : "bg-slate-700/60 text-slate-500 cursor-not-allowed")}>
          进入合并定稿
        </button>
        {/* UI审计T8: 回滚到最近一次批量生成前 */}
        <UndoBatch projectId={projectId} onMsg={onMsg} />
      </div>
    </div>
  );
}
// SocialSci UI审计T8: 回滚到最近批量生成前(探测 batch:pre 历史)
function UndoBatch({ projectId, onMsg }: { projectId: string; onMsg: (m: string) => void }) {
  const [hasBatch, setHasBatch] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [ask, setAsk] = useState<ConfirmSpec | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let stop = false;
    const check = async () => {
      try {
        const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
        const r = await fetch(`/api/research/projects/${projectId}/nodes/sections/history?limit=8`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const d = await r.json().catch(() => ({}));
        if (stop) return;
        const hist = d?.history ?? [];
        setHasBatch(hist.some((h: { note?: string }) => h.note === "batch:pre"));
      } catch { /* 静默 */ }
    };
    void check();
    const iv = setInterval(check, 5000);
    return () => { stop = true; clearInterval(iv); };
  }, [projectId]);
  if (!hasBatch) return null;
  const doUndo = async () => {
    setUndoBusy(true); setAsk(null);
    try {
      const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
      const r = await fetch(`/api/research/projects/${projectId}/nodes/sections/undo-batch`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: "{}",
      });
      const d = await r.json();
      if (!r.ok) { onMsg(d?.error || "回滚失败"); return; }
      onMsg("已回滚到批量生成前状态");
      setHasBatch(false);
    } catch (e) { onMsg((e as Error).message); } finally { setUndoBusy(false); }
  };
  return (
    <>
      <button onClick={() => setAsk({ title: "回滚本批?", desc: "回滚到最近一次批量生成前的章节状态。当前批量结果将被覆盖(节点历史仍可找回)。", confirmText: "回滚", danger: true })}
        disabled={undoBusy}
        className="flex-1 rounded-lg bg-rose-700/80 py-1 text-[10px] text-white hover:bg-rose-600 disabled:opacity-50">
        {undoBusy ? "回滚中…" : "回滚本批"}
      </button>
      <ConfirmDialog spec={ask} onDone={(ok) => (ok ? void doUndo() : setAsk(null))} />
    </>
  );
}
