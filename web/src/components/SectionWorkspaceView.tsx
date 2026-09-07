// SectionWorkspaceView.tsx — SocialSci T3-2: 章节创作三栏工作区(对齐闭源 WorkspaceView)
// 左: 章节树(一级+子节, 状态点, 完成度进度条) / 中: 标题+字数+技能卡要点+正文 Markdown 编辑器+执行按钮
//    / 右: 素材清单(点击注入正文末)
// 保存: PUT /research/projects/:pid/nodes/sections(全量 payload 原子覆盖, 历史自动留痕)
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Brain, CheckCircle2, ChevronLeft, FileText, Loader2, PenLine, Save, Sparkles, X } from "lucide-react";

interface Sec {
  id: string; title: string; level: number; order?: number; status?: string;
  content?: string; aiSkill?: { type?: string; notes?: string; keyPoints?: string[]; writingGoal?: string; wordCount?: number };
  children?: Sec[];
}
interface Mat { id: string; title: string; kind: string; content_md?: string; produced_by_dag_node?: string; section_ids?: string[] | null }

function tokenOf() { return localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""; }
async function j<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) ?? {}) };
  const t = tokenOf(); if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(url, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败 ${r.status}`);
  return body as T;
}
function cn(...xs: Array<string | false | undefined>) { return xs.filter(Boolean).join(" "); }
function isDone(s: Sec) { return s.status === "done" || (s.content ?? "").trim().length > 100; }

// T7-3: 素材筛选分组(闭源 workspace 右栏: 全部/理论/数据/案例/方法/文献/图表)
const MAT_FILTERS: Array<{ k: string; label: string }> = [
  { k: "all", label: "全部素材" },
  { k: "theory", label: "理论" },
  { k: "data_result", label: "数据" },
  { k: "citation", label: "文献" },
  { k: "figure", label: "图表" },
  { k: "note", label: "案例/笔记" },
  { k: "file", label: "附件" },
];

export function SectionWorkspaceView({ projectId, title, onBack, onMsg }: {
  projectId: string; title: string; onBack: () => void; onMsg: (m: string) => void;
}) {
  const [sections, setSections] = useState<Sec[]>([]);
  const [selId, setSelId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [materials, setMaterials] = useState<Mat[]>([]);
  // T7-3: 素材筛选(闭源 workspace 右栏分组)
  const [matFilter, setMatFilter] = useState("all");
  const [runBusy, setRunBusy] = useState<"all" | string | null>(null);
  const [busyMsg, setBusyMsg] = useState("");
  const [curJob, setCurJob] = useState<{ id: string; kind: "all" | string } | null>(null);
  const [failMsg, setFailMsg] = useState<string>("");
  // 展开/折叠态(闭源 sections payload expandedSections 同名字段, 刷新恢复)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const n = await j<{ node: { payload?: { sections?: Sec[]; expandedSections?: string[] } } }>(`/api/research/projects/${projectId}/nodes/sections`);
      const list = n.node?.payload?.sections ?? [];
      setSections(list);
      setExpanded(new Set(n.node?.payload?.expandedSections ?? list.map((s) => s.id)));
      if (!selId && list.length) setSelId(list[0].id);
      const m = await j<{ materials: Mat[] }>(`/api/research/materials?projectId=${encodeURIComponent(projectId)}`);
      setMaterials(m.materials ?? []);
    } catch (e) { onMsg((e as Error).message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  const sel = sections.find((s) => s.id === selId) ?? null;
  const top = sections.filter((s) => s.level === 1);
  const doneTop = top.filter(isDone).length;
  const doneSub = sections.filter((s) => s.level === 2 && isDone(s)).length;
  const subAll = sections.filter((s) => s.level === 2).length;
  const wordCount = (sel?.content ?? "").replace(/\s/g, "").length;
  const visibleMats = matFilter === "all" ? materials : materials.filter((m) => m.kind === matFilter);
  const savedRef = { current: sections };

  const persist = async (next: Sec[]) => {
    savedRef.current = next;
    try {
      await j(`/api/research/projects/${projectId}/nodes/sections`, {
        method: "PUT", body: JSON.stringify({ payload: { sections: next, expandedSections: [...expanded] }, sourceRole: "user", note: "章节创作工作区" }),
      });
    } catch (e) { onMsg((e as Error).message); }
  };

  const editContent = (id: string, v: string) => {
    const next = sections.map((s) => (s.id === id ? { ...s, content: v, status: v.trim() ? s.status || "draft" : s.status } : s));
    setSections(next);
    void persist(next);
  };
  const editTitle = (id: string, v: string) => {
    const next = sections.map((s) => (s.id === id ? { ...s, title: v } : s));
    setSections(next); void persist(next);
  };

  // 轮询任务直到 done/failed/cancelled(或超时), 支持中途取消
  const waitJob = async (jobId: string, targetSecId: string | null, onPoll?: () => void) => {
    const h = { "Content-Type": "application/json", ...(tokenOf() ? { Authorization: `Bearer ${tokenOf()}` } : {}) };
    for (let i = 0; i < 150; i++) {
      await new Promise((rr) => setTimeout(rr, 2500));
      const st = await j<{ task?: { status: string; error?: { userMessage?: string } | null } }>(`/api/research/tasks/${jobId}`).catch(() => ({ task: undefined }));
      const status = st?.task?.status ?? "";
      if (status === "done") return { ok: true as const };
      if (status === "failed" || status === "cancelled") {
        const msg = st?.task?.error && typeof st.task.error === "object" ? (st.task.error as { userMessage?: string }).userMessage ?? JSON.stringify(st.task.error) : "";
        return { ok: false as const, msg, cancelled: status === "cancelled" };
      }
      // 每轮也刷新 sections(生成完成即现)
      if (targetSecId) {
        const secs2 = await pollSections(h, projectId);
        if (secs2.some((s) => s.id === targetSecId && isDone(s))) return { ok: true as const };
      }
      onPoll?.();
    }
    return { ok: false as const, msg: "生成超时(任务仍在后台, 可在画布任务区查看)", cancelled: false };
  };
  const cancelJob = async () => {
    if (!curJob) return;
    try {
      await j(`/api/research/tasks/${curJob.id}/control`, { method: "POST", body: JSON.stringify({ action: "cancel" }) });
      setBusyMsg("已请求取消章节生成");
    } catch (e) { onMsg((e as Error).message); }
  };

  // 执行智能体: 单章 — 已生成且 >50 字时覆盖确认(对齐闭源"重新生成将覆盖当前内容")
  const runChapter = async (sec: Sec) => {
    if (runBusy) return;
    if (isDone(sec) && !window.confirm("该章节已有正文。重新生成将覆盖当前内容, 确定要继续吗?")) return;
    setRunBusy(sec.id); setBusyMsg(`正在生成章节内容 · ${sec.title}`); setFailMsg("");
    try {
      const h = { "Content-Type": "application/json", ...(tokenOf() ? { Authorization: `Bearer ${tokenOf()}` } : {}) };
      const goal = `生成论文章节: ${title} / ${sec.title}`;
      const r = await fetch(`/api/research/jobs/phase4/batch`, {
        method: "POST", headers: h,
        body: JSON.stringify({ projectId, goal, sections: [{ id: sec.id, title: sec.title, level: sec.level }] }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "创建任务失败");
      const job = d.job as { id: string };
      setCurJob({ id: job.id, kind: sec.id });
      const res = await waitJob(job.id, sec.id);
      setCurJob(null);
      const secs2 = await pollSections(h, projectId);
      setSections(secs2); savedRef.current = secs2;
      setBusyMsg("");
      if (res.ok) onMsg(`章节完成: ${sec.title}`);
      else if (res.cancelled) onMsg(`已取消: ${sec.title}`);
      else { setFailMsg(`${sec.title}: ${res.msg}`); onMsg(`章节生成失败: ${res.msg.slice(0, 80)}`); }
    } catch (e) { onMsg((e as Error).message); } finally { setRunBusy(null); setBusyMsg(""); }
  };

  const runAll = async () => {
    if (runBusy) return;
    if (top.some(isDone) && !window.confirm("部分章节已有正文。重新生成将覆盖当前内容, 确定要继续吗?")) return;
    setRunBusy("all"); setBusyMsg("正在批量生成章节..."); setFailMsg("");
    try {
      const h = { "Content-Type": "application/json", ...(tokenOf() ? { Authorization: `Bearer ${tokenOf()}` } : {}) };
      const r = await fetch(`/api/research/jobs/phase4/batch`, {
        method: "POST", headers: h,
        body: JSON.stringify({ projectId, goal: `批量生成论文章节: ${title}`, sections: top.map((s) => ({ id: s.id, title: s.title, level: s.level })) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "创建任务失败");
      const job = d.job as { id: string };
      setCurJob({ id: job.id, kind: "all" });
      const res = await waitJob(job.id, null);
      setCurJob(null);
      const secs2 = await pollSections(h, projectId);
      setSections(secs2); savedRef.current = secs2;
      setBusyMsg("");
      if (res.ok) onMsg(`批量生成完成: ${secs2.filter(isDone).length}/${top.length} 章`);
      else if (res.cancelled) onMsg("已取消批量生成");
      else { setFailMsg(res.msg); onMsg(`批量生成失败: ${res.msg.slice(0, 80)}`); }
    } catch (e) { onMsg((e as Error).message); } finally { setRunBusy(null); setBusyMsg(""); }
  };

  const insertMaterial = (m: Mat) => {
    if (!sel) return;
    const md = m.content_md ?? "";
    editContent(sel.id, (sel.content ?? "") + (md ? `\n\n${md}` : ""));
    onMsg(`已注入素材: ${m.title}`);
  };
  // T4-4: AI 自动编排素材(建议预览 → 逐条确认 adopt)
  const [alloc, setAlloc] = useState<Array<{ materialId: string; materialTitle: string; sectionId: string | null; sectionTitle: string; reason: string }> | null>(null);
  const [allocBusy, setAllocBusy] = useState(false);
  const runAllocate = async () => {
    setAllocBusy(true); setAlloc(null);
    try {
      const r = await j<{ suggestions: typeof alloc }>("/api/research/materials/allocate", { method: "POST", body: JSON.stringify({ projectId }) });
      setAlloc(r.suggestions ?? []);
      onMsg(r.suggestions?.length ? `AI 编排建议 ${r.suggestions.length} 条, 请确认` : "暂无待编排素材(或已全部挂章)");
    } catch (e) { onMsg((e as Error).message); } finally { setAllocBusy(false); }
  };
  const confirmAlloc = async (s: { materialId: string; sectionId: string | null }) => {
    if (!s.sectionId) return;
    try {
      await j(`/api/research/materials/${s.materialId}/adopt`, { method: "POST", body: JSON.stringify({ sectionIds: [s.sectionId] }) });
      setAlloc((p) => p?.filter((x) => x.materialId !== s.materialId) ?? null);
      await load();
      onMsg("已挂章: 素材 → 章节");
    } catch (e) { onMsg((e as Error).message); }
  };
  const saveNow = async () => { try { await j(`/api/research/projects/${projectId}/nodes/sections`, { method: "PUT", body: JSON.stringify({ payload: { sections: savedRef.current }, sourceRole: "user", note: "手动保存" }) }); onMsg("已保存"); } catch (e) { onMsg((e as Error).message); } };

  const editEl = sel ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-slate-700/50 px-3 py-1.5">
        <input value={sel.title} onChange={(e) => editTitle(sel.id, e.target.value)}
          className="min-w-0 flex-1 rounded border border-slate-700/50 bg-slate-800 px-2 py-1 text-sm font-medium text-slate-100" />
        <span className="shrink-0 text-[10px] text-slate-500">{wordCount.toLocaleString()} 字</span>
        <button onClick={() => runChapter(sel)} disabled={!!runBusy}
          className={cn("flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] text-white", runBusy === sel.id ? "bg-amber-600 opacity-60" : "bg-cyan-600 hover:bg-cyan-500")}>
          {runBusy === sel.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}执行智能体
        </button>
        <button onClick={() => runAll()} disabled={!!runBusy} title="批量生成全部一级章节"
          className={cn("flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] text-white", runBusy === "all" ? "bg-amber-600 opacity-60" : "bg-purple-600 hover:bg-purple-500")}>
          {runBusy === "all" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}批量生成
        </button>
        {runBusy && (
          <button onClick={() => void cancelJob()} title="取消生成"
            className="flex shrink-0 items-center gap-1 rounded-lg border border-rose-500/40 px-2.5 py-1.5 text-[11px] text-rose-300 hover:bg-rose-500/10">
            <X className="h-3 w-3" />取消
          </button>
        )}
        <button onClick={() => void saveNow()} className="flex shrink-0 items-center gap-1 rounded-lg bg-slate-700 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-slate-600">
          <Save className="h-3 w-3" />保存
        </button>
      </div>
      {busyMsg && <p className="border-b border-amber-500/20 bg-amber-500/5 px-3 py-1 text-[10px] text-amber-300">{busyMsg}</p>}
      {failMsg && <p className="border-b border-rose-500/20 bg-rose-500/5 px-3 py-1 text-[10px] text-rose-300">{failMsg}</p>}
      {/* 技能卡要点(写作指导) */}
      {sel.aiSkill && (
        <div className="border-b border-slate-700/40 bg-slate-800/40 px-3 py-1.5">
          <p className="mb-0.5 text-[9px] font-bold uppercase tracking-wide text-purple-300">
            写作指导 · {sel.aiSkill.type} {sel.aiSkill.wordCount ? `· 目标 ${sel.aiSkill.wordCount} 字` : ""}
          </p>
          {sel.aiSkill.keyPoints?.slice(0, 4).map((k, i) => (
            <p key={i} className="text-[9px] leading-relaxed text-slate-400">· {k}</p>
          ))}
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-2">
        <textarea value={sel.content ?? ""} onChange={(e) => editContent(sel.id, e.target.value)} placeholder="章节正文(markdown)..."
          className="h-full w-full resize-none border-r border-slate-700/50 bg-slate-950/60 p-3 font-mono text-[12px] leading-relaxed text-slate-200 placeholder:text-slate-600" />
        <div className="h-full overflow-y-auto bg-slate-900/40 p-3 text-[12px] leading-relaxed text-slate-300">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{(sel.content || "").trim() ? sel.content : "*（空章节）*"}</ReactMarkdown>
        </div>
      </div>
    </div>
  ) : (
    <div className="flex flex-1 items-center justify-center text-xs text-slate-600">← 左侧选择章节, 或先新建</div>
  );

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-slate-950/98 backdrop-blur-sm">
      {/* 顶栏 */}
      <div className="flex items-center justify-between border-b border-slate-700/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"><ChevronLeft className="h-4 w-4" /></button>
          <PenLine className="h-4 w-4 text-cyan-400" />
          <h2 className="text-sm font-bold text-slate-100">章节创作 · {title}</h2>
          <span className={cn("rounded-full px-2 py-0.5 text-[9px]", doneTop === top.length && top.length > 0 ? "bg-green-500/15 text-green-300" : "bg-amber-500/15 text-amber-300")}>
            {doneTop}/{top.length} 章完成
          </span>
        </div>
        <div className="flex items-center gap-2">
          {busyMsg && <span className="flex items-center gap-1 text-[10px] text-amber-300"><Loader2 className="h-3 w-3 animate-spin" />{busyMsg}</span>}
          <button onClick={onBack} className="rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-slate-700">完成返回画布</button>
        </div>
      </div>
      {/* 三栏 */}
      <div className="flex min-h-0 flex-1">
        {/* 左: 章节导航树 + 进度 */}
        <div className="flex w-64 shrink-0 flex-col border-r border-slate-700/60 bg-slate-900/60">
          <div className="border-b border-slate-700/40 p-2">
            <div className="mb-1 flex items-center justify-between text-[10px] text-slate-400">
              <span>章节进度</span><span className="text-slate-300">{doneTop + doneSub}/{top.length + subAll}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full rounded-full bg-red-400 transition-all" style={{ width: `${(top.length ? (doneTop / top.length) * 100 : 0)}%` }} />
            </div>
            <p className="mt-1 text-[9px] text-slate-500">{top.length - doneTop > 0 ? `缺 ${top.length - doneTop} 章一级章节未完成` : "一级章节全部完成"}</p>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
            {top.map((s) => (
              <div key={s.id}>
                <button onClick={() => setSelId(s.id)}
                  className={cn("flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px]", selId === s.id ? "bg-cyan-600/15 text-cyan-200" : "text-slate-300 hover:bg-slate-800")}>
                  {(s.children ?? []).length > 0 && (
                    <span onClick={(e) => { e.stopPropagation(); setExpanded((p) => { const n = new Set(p); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); void persist(sections); return n; }); }}
                      className="shrink-0 text-slate-500 hover:text-slate-300">{expanded.has(s.id) ? "▾" : "▸"}</span>
                  )}
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", isDone(s) ? "bg-green-400" : s.status === "generating" ? "animate-pulse bg-amber-400" : "bg-slate-600")} />
                  <span className="truncate font-medium">{s.order ? `${s.order}. ` : ""}{s.title}</span>
                  {isDone(s) && <CheckCircle2 className="ml-auto h-3 w-3 shrink-0 text-green-400" />}
                </button>
                {expanded.has(s.id) && (s.children ?? []).map((c) => (
                  <button key={c.id} onClick={() => setSelId(c.id)}
                    className={cn("ml-3 flex w-[calc(100%-0.75rem)] items-center gap-1 rounded px-2 py-1 text-left text-[10px]", selId === c.id ? "bg-slate-700/60 text-cyan-200" : "text-slate-500 hover:bg-slate-800/70")}>
                    <span className={cn("h-1 w-1 shrink-0 rounded-full", isDone(c) ? "bg-green-400" : "bg-slate-600")} />
                    <span className="truncate">{c.title}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        {/* 中: 编辑区 */}
        {editEl}
        {/* 右: 素材 */}
        <div className="flex w-72 shrink-0 flex-col border-l border-slate-700/60 bg-slate-900/60">
          <p className="flex items-center gap-1 border-b border-slate-700/40 px-3 py-1.5 text-[10px] font-semibold text-slate-400">
            <FileText className="h-3 w-3" />素材库 ({materials.length}) <span className="font-normal text-slate-600">点击注入正文</span>
          </p>
          {/* T7-3: 素材筛选分组(闭源 workspace 右栏: 全部/理论/数据/案例/方法/文献/图表) */}
          <div className="flex flex-wrap gap-1 border-b border-slate-700/40 px-2 py-1.5">
            {MAT_FILTERS.map((f) => (
              <button key={f.k} onClick={() => setMatFilter(f.k)}
                className={cn("rounded-full px-2 py-0.5 text-[9px]", matFilter === f.k ? "bg-cyan-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200")}>
                {f.label}<span className="ml-0.5 opacity-60">({f.k === "all" ? materials.length : materials.filter(m => m.kind === f.k).length})</span>
              </button>
            ))}
          </div>
          {/* T4-4: AI 自动编排素材 */}
          <div className="border-b border-slate-700/40 p-1.5">
            <button onClick={() => void runAllocate()} disabled={allocBusy}
              className="flex w-full items-center justify-center gap-1 rounded-lg bg-violet-600/80 py-1 text-[10px] text-white hover:bg-violet-500 disabled:opacity-50">
              {allocBusy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Sparkles className="h-2.5 w-2.5" />}AI 编排素材到章节
            </button>
            {alloc && alloc.length > 0 && (
              <div className="mt-1.5 space-y-1">
                <p className="text-[9px] text-slate-500">建议({alloc.length}) — 点确认挂章:</p>
                {alloc.map((s) => (
                  <div key={s.materialId} className="flex items-center gap-1 rounded border border-violet-500/20 bg-violet-500/5 px-1.5 py-1">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[9px] text-slate-300">{s.materialTitle}</p>
                      <p className="truncate text-[8px] text-violet-300/80">→ {s.sectionTitle} {s.reason ? `· ${s.reason.slice(0, 24)}` : ""}</p>
                    </div>
                    {s.sectionId ? (
                      <button onClick={() => void confirmAlloc(s)} className="shrink-0 rounded bg-violet-600 px-1.5 py-0.5 text-[8px] text-white hover:bg-violet-500">确认</button>
                    ) : (
                      <span className="shrink-0 text-[8px] text-slate-600">不匹配</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            {materials.length === 0 && <p className="px-1 text-[10px] text-slate-600">素材为空 — 回画布"素材库"生成/导入</p>}
            {visibleMats.map((m) => (
              <button key={m.id} onClick={() => insertMaterial(m)}
                className="w-full rounded-lg border border-slate-700/40 bg-slate-800/40 p-2 text-left transition hover:border-cyan-500/50 hover:bg-slate-800">
                <p className="truncate text-[10px] font-medium text-slate-200">{m.title || "未命名"}</p>
                <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[9px] leading-relaxed text-slate-500">{(m.content_md ?? "").slice(0, 180) || (m.produced_by_dag_node ? `来源节点: ${m.produced_by_dag_node}` : "")}</p>
                {m.section_ids?.length ? <p className="mt-0.5 text-[8px] text-amber-300/80">已挂 {m.section_ids.length} 章</p> : null}
              </button>
            ))}
          </div>
        </div>
      </div>
      {/* 底部状态条 */}
      <div className="flex items-center justify-between border-t border-slate-700/60 bg-slate-900/80 px-3 py-1.5 text-[10px] text-slate-500">
        <span className="flex items-center gap-1"><Brain className="h-3 w-3 text-amber-400" />执行智能体: 基于写作卡要点+素材生成章节正文, 生成后自动回写保存</span>
        <span>编辑自动原子保存 · 可回滚</span>
      </div>
    </div>
  );
}

async function pollSections(h: Record<string, string>, projectId: string): Promise<Sec[]> {
  const r = await fetch(`/api/research/projects/${projectId}/nodes/sections`, { headers: h });
  const d = await r.json().catch(() => ({}));
  return d?.node?.payload?.sections ?? d?.payload?.sections ?? [];
}
