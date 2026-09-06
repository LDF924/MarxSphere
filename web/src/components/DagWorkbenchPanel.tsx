// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// DagWorkbenchPanel.tsx — SocialSci P0-1: 可视化 DAG 科研工作台(画布主体)
// 形态对齐(闭源产品交互语义, 原创实现): 画布节点=研究要素, 连线=产物依赖流转
//   - 项目列表 + 新建(空白/五阶段模板) + NL→DAG(画布任务)
//   - xyflow 画布: 拖节点/连线/框选, 乐观锁保存(canvas_version)
//   - 节点右键/双击: 打开工作界面(节点快照面板, 执行任务/回滚/产物)
// 配套后端: /api/research/*(research-pipeline-service); 迁移114/115
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState,
  type Connection, type Edge, type Node, type NodeTypes, MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { MaterialsDrawer } from "./MaterialsDrawer";
import { ResearchInputWizard } from "./ResearchInputWizard";
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

// ═══ 画布节点组件 ═══
function DAGNodeChip({ data }: { data: { label: string; type: string; status?: string } }) {
  const meta = NODE_META[data.type] ?? NODE_META.goal;
  const statusColor = data.status === "done" ? "bg-green-500/20 text-green-300 border-green-500/40"
    : data.status === "running" ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
    : data.status === "failed" ? "bg-red-500/20 text-red-300 border-red-500/40"
    : "bg-slate-800/80 text-slate-200 border-slate-600/50";
  return (
    <div className={cn("w-48 rounded-lg border px-2.5 py-2 text-left shadow-lg backdrop-blur", statusColor)} style={{ borderLeft: `3px solid ${meta.color}` }}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: meta.color }}>
        {meta.icon}<span>{meta.label}</span>
      </div>
      <div className="mt-1 truncate text-xs font-semibold">{data.label}</div>
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"list" | "work">("list");
  const [nlInput, setNlInput] = useState("");
  const [nlBusy, setNlBusy] = useState(false);
  const [selNode, setSelNode] = useState<Node | null>(null);
  const [nodePayload, setNodePayload] = useState<unknown>(null);
  const [nodeVersion, setNodeVersion] = useState(0);
  const [nodeHistory, setNodeHistory] = useState<Array<{ id: string; version: number; note: string; by_role: string; created_at: string }>>([]);
  const [showAnalyze, setShowAnalyze] = useState(false);
  const [analyzeBusy, setAnalyzeBusy] = useState(false);
  const [showMaterials, setShowMaterials] = useState(false);
  // SocialSci R5: 需求澄清
  const [showClarify, setShowClarify] = useState(false);
  const [clarifyBusy, setClarifyBusy] = useState(false);
  const [clarifyData, setClarifyData] = useState<{ analysis: string; questions: Array<{ id: string; category: string; question: string; guidance: string; importance: string }> } | null>(null);
  const [clarifyAnswers, setClarifyAnswers] = useState<string[]>([]);

  const toggleClarify = async () => {
    if (showClarify) { setShowClarify(false); return; }
    if (!cur) return;
    setClarifyBusy(true); setErr("");
    try {
      const r = await j<{ success: boolean; data: { analysis: string; questions: Array<{ id: string; category: string; question: string; guidance: string; importance: string }> } }>("/api/clarify/generate", {
        method: "POST",
        body: JSON.stringify({ title: cur.title, researchMethod: cur.topic || undefined }),
      });
      if (!r.success) throw new Error("澄清生成失败");
      setClarifyData(r.data); setClarifyAnswers(new Array(r.data.questions.length).fill("")); setShowClarify(true);
    } catch (e) { setErr((e as Error).message); } finally { setClarifyBusy(false); }
  };

  const saveClarifyAnswers = async () => {
    if (!cur || !clarifyData) return;
    setErr("");
    try {
      const lines = clarifyData.questions.map((q, i) => `Q(${q.category}): ${q.question}\n  → ${(clarifyAnswers[i] ?? "").trim() || "无"}`);
      const text = `【AI需求澄清结果】\n${lines.join("\n")}`;
      await j(`/api/research/projects/${cur.id}/nodes/clarify`, {
        method: "PUT",
        body: JSON.stringify({ payload: { analysis: clarifyData.analysis, qa: lines }, sourceRole: "user", note: "需求澄清归档" }),
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
  // 会话恢复
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { try { const p = JSON.parse(saved) as { projectId: string }; } catch { /* ignore */ } }
  }, []);

  // 新建项目(空白 / 五阶段模板)
  const createProject = async (title: string, template: "blank" | "five-stage") => {
    setBusy(true); setErr("");
    try {
      const r = await j<{ id: string }>("/api/research/projects", {
        method: "POST", body: JSON.stringify({ title, topic: title, template }),
      });
      await loadProjects();
      await openProject(r.id);
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
  const persistCanvas = useCallback((n: Node[], e: Edge[]) => {
    if (!cur) return;
    dirtyRef.current = true;
    if (loadTimer.current) clearTimeout(loadTimer.current);
    loadTimer.current = setTimeout(async () => {
      if (!cur || !dirtyRef.current) return;
      dirtyRef.current = false;
      try {
        const r = await j<{ ok: boolean; canvasVersion?: number }>(`/api/research/projects/${cur.id}/canvas`, {
          method: "PUT",
          body: JSON.stringify({ canvas: { nodes: n, edges: e }, expectedVersion: canvasVer }),
        });
        setCanvasVer(r.canvasVersion ?? canvasVer);
      } catch (e) {
        setErr(`画布保存冲突/失败: ${(e as Error).message} (请刷新重载)`);
      }
    }, 2000);
  }, [cur, canvasVer]);

  const onConnect = useCallback((conn: Connection) => {
    if (!cur) return;
    setEdges((eds) => {
      const next = addEdge({ ...conn, id: `e${Date.now().toString(36)}`, markerEnd: { type: MarkerType.ArrowClosed } }, eds);
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
  const selKey = selNode ? (selNode.data.type as string) : "";
  const meta = selNode ? (NODE_META[selNode.data.type as string] ?? NODE_META.goal) : null;

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5 text-cyan-400" />
          <h2 className="text-base font-bold text-slate-100">科研工作台 · 可视化 DAG 编排</h2>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">SocialSci 对齐</span>
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
                <button disabled={busy} onClick={() => { const t = prompt("项目标题:"); if (t?.trim()) createProject(t.trim(), "blank"); }}
                  className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50">
                  <Plus className="h-3 w-3" /> 空白画布
                </button>
                <button disabled={busy} onClick={() => { const t = prompt("论文主题:"); if (t?.trim()) createProject(t.trim(), "five-stage"); }}
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
          onDone={() => setMode("work")}
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
              onEdgesChange={(ch) => { onEdgesChange(ch); if (ch.length) persistCanvas(nodesRef.current, edgesRef.current); }}
              onConnect={onConnect}
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
                    <button onClick={saveClarifyAnswers} className="w-full rounded-lg bg-sky-600 py-1.5 text-[11px] text-white hover:bg-sky-500">归档回答到研究要求</button>
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
                <SectionProgress projectId={cur.id} onMsg={(m) => setErr(m)} />
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

                {/* 快照编辑 */}
                <div className="mt-2 rounded-lg bg-slate-800/50 p-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-semibold uppercase text-slate-500">节点快照 v{nodeVersion}</p>
                    <span className="flex items-center gap-1 text-[10px] text-slate-500"><Save className="h-2.5 w-2.5" />自动原子保存</span>
                  </div>
                  <textarea
                    value={nodePayload ? JSON.stringify(nodePayload, null, 1) : ""}
                    onChange={(e) => { try { setNodePayload(JSON.parse(e.target.value)); } catch { /* 半输入状态忽略 */ } }}
                    rows={10} spellCheck={false}
                    className="mt-1.5 w-full resize-none rounded-lg border border-slate-600/50 bg-slate-950/60 px-2 py-1.5 font-mono text-[11px] text-slate-300" />
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
  const [tasks, setTasks] = useState<Array<{ id: string; jobKind: string; status: string; goal: string }>>([]);
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
        const list = (d.tasks ?? []).filter((t: { status: string }) => t.status !== "done");
        // UI审计T4: 展开progress中的stage/current/total
        setTasks(list.map((t: { progress?: { stage?: string; current?: number; total?: number; sections?: unknown } }) => t));
        // 分级busy文案: 优先级 batch > section > material > analysis
        const prio = ["phase4_batch", "chapter_batch", "chapter_gen", "theory-generate", "table-generate", "literature-search", "analyze", "merge", "review", "revise"];
        const active = list.find((t: { jobKind: string }) => prio.includes(t.jobKind));
        setBusyMsg(active ? (JOB_LABELS[active.jobKind] ?? "当前操作处理中") : "");
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
            <span className="truncate text-slate-400">{JOB_LABELS[t.jobKind] ?? t.jobKind}: {t.goal?.slice(0, 30) ?? ""}</span>
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
        </div>
      ))}
      {tasks.length > 4 && <p className="text-[9px] text-slate-500">…还有 {tasks.length - 4} 个任务</p>}
    </div>
  );
}

// ═══ SocialSci UI审计 T3: 章节完成度进度条(一级章 X/Y + 未完成门禁) ═══
function SectionProgress({ projectId, onMsg }: { projectId: string; onMsg: (m: string) => void }) {
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
        const top = secs.filter((s: { level?: number }) => s.level === 1);
        const doneTop = top.filter((s: { status?: string; content?: string }) => s.status === "done" || (s.content ?? "").trim().length > 100).length;
        const sub = secs.filter((s: { level?: number }) => s.level > 1);
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
          onClick={() => onMsg(allDone ? "调用合并: 在'章节'节点工作界面创建 phase5 merge 任务" : "先完成全部一级章节")}
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
    if (!window.confirm("回滚到最近一次批量生成前的章节状态? 当前批量结果将被覆盖(节点历史仍可找回)。")) return;
    setUndoBusy(true);
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
    <button onClick={doUndo} disabled={undoBusy}
      className="flex-1 rounded-lg bg-rose-700/80 py-1 text-[10px] text-white hover:bg-rose-600 disabled:opacity-50">
      {undoBusy ? "回滚中…" : "回滚本批"}
    </button>
  );
}
