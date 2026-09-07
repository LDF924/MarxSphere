// ArchitectureConfirmView.tsx — SocialSci T7: 科研架构确认页(闭源 /workflow/sections 对齐)
// 状态机: 提交录入 → 架构确认页(自动触发生成, 生成中/失败+重试/成功清单) → 确认进入创作
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Brain, CheckCircle2, ChevronRight, Loader2, Network, RefreshCw, RotateCcw, Sparkles, Target, X } from "lucide-react";
import { cn } from "../lib/utils";

interface Sec { id: string; title: string; level: number; order?: number; children?: Sec[] }

function tokenOf() { return localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""; }
async function j<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) ?? {}) };
  const t = tokenOf(); if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(url, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败 ${r.status}`);
  return body as T;
}

type Phase = "generating" | "failed" | "ready";

export function ArchitectureConfirmView({ projectId, title, onConfirm, onBack, onMsg }: {
  projectId: string; title: string; onConfirm: () => void; onBack: () => void; onMsg: (m: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("generating");
  const [errMsg, setErrMsg] = useState("");
  const [secs, setSecs] = useState<Sec[]>([]);
  const [analysis, setAnalysis] = useState<{
    variables?: { kind?: string; list?: Array<{ name?: string; role?: string; description?: string }> };
    hypotheses?: Array<{ id?: string; type?: string; text?: string; theory?: string }>;
    chapterPlan?: Array<{ title?: string; requirements?: string; skillType?: string; wordCount?: number }>;
    logicChain?: string;
  } | null>(null);
  const [genBusy, setGenBusy] = useState(false);

  const loadSections = useCallback(async () => {
    try {
      const n = await j<{ node: { payload?: { sections?: Sec[] } } }>(`/api/research/projects/${projectId}/nodes/sections`);
      setSecs(n.node?.payload?.sections ?? []);
    } catch { /* 静默 */ }
  }, [projectId]);

  const runGenerate = useCallback(async () => {
    setPhase("generating"); setErrMsg(""); setGenBusy(true);
    try {
      const task = await j<{ task: { id: string } }>("/api/research/tasks", {
        method: "POST",
        body: JSON.stringify({ projectId, jobKind: "analyze", goal: `科研架构分析: ${title}`, dagNodeId: "" }),
      });
      const r = await fetch(`/api/research/projects/${projectId}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenOf()}` },
        body: JSON.stringify({ taskId: task.task.id }),
      });
      if (!r.ok || !r.body) throw new Error(`分析请求失败 ${r.status}`);
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
        for (const p of parts) {
          const ev = p.match(/event: (\S+)/)?.[1];
          const data = p.match(/data: (.*)/s)?.[1];
          if (!data) continue;
          const obj = JSON.parse(data);
          if (ev === "pipe.node" && obj?.nodeKey === "analysis" && obj.payload) {
            setAnalysis(obj.payload as typeof analysis);
          }
          if (ev === "pipe.error" && obj) {
            setErrMsg(obj.userMessage || "分析失败");
            setPhase("failed");
          }
        }
      }
      await loadSections();
      setPhase("ready");
    } catch (e) {
      setErrMsg((e as Error).message);
      setPhase("failed");
    } finally { setGenBusy(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, title]);

  useEffect(() => { void loadSections(); void runGenerate(); }, []); // 进页自动生成(闭源语义)

  const top = secs.filter((s) => s.level === 1);
  const subCount = secs.filter((s) => s.level > 1).length;
  const vars = analysis?.variables?.list ?? [];

  return (
    <div className="absolute inset-0 z-30 overflow-y-auto bg-slate-950/98 backdrop-blur-sm">
      <div className="mx-auto max-w-3xl px-6 py-8">
        {/* 头 */}
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-slate-100">科研架构</h2>
          <p className="mt-1 text-sm text-slate-500">{title} — 确认科研架构后进入创作工作台。</p>
          <p className="mt-1 text-xs text-slate-600">共 {top.length} 章、{subCount} 个子节</p>
        </div>

        {/* 生成中 */}
        {phase === "generating" && (
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-8 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-cyan-400" />
            <p className="mt-3 text-sm text-slate-300">科研架构分析中...</p>
            <p className="mt-1 text-xs text-slate-500">AI 智能体正在识别变量、规划章节并生成写作指导</p>
          </div>
        )}

        {/* 失败卡 */}
        {phase === "failed" && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-rose-300">
              <AlertTriangle className="h-4 w-4" /> 科研架构生成失败
            </div>
            {errMsg && <p className="mt-2 text-xs text-rose-200/70">Step 1 执行失败: {errMsg}</p>}
            <button onClick={() => void runGenerate()} disabled={genBusy}
              className="mt-3 flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-xs text-white hover:bg-rose-500 disabled:opacity-50">
              {genBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} 重新生成
            </button>
          </div>
        )}

        {/* 成功: 变量 + 章节清单 */}
        {phase === "ready" && (
          <div className="space-y-4">
            {vars.length > 0 && (
              <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-4">
                <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-200">
                  <Brain className="h-4 w-4 text-amber-400" /> 变量识别
                  <span className="text-[10px] font-normal text-slate-500">{analysis?.variables?.kind === "quantitative" ? "定量" : analysis?.variables?.kind === "mixed" ? "混合" : "定性"}设计</span>
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {vars.map((v, i) => (
                    <span key={i} className="rounded-full bg-slate-800 px-2.5 py-1 text-[11px] text-slate-300">
                      {v.name || `变量${i + 1}`}
                      <span className="ml-1 text-[9px] text-slate-500">{v.role === "dependent" ? "因" : v.role === "independent" ? "自" : v.role === "mediator" ? "中介" : v.role === "moderator" ? "调节" : v.role === "control" ? "控制" : ""}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {/* W2: 研究假设(闭源 sections 完成态: H1-H4 带类型+理论依据) */}
            {analysis?.hypotheses?.length ? (
              <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-4">
                <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-200">
                  <Target className="h-4 w-4 text-cyan-400" /> 研究假设
                  <span className="text-[10px] font-normal text-slate-500">共 {analysis.hypotheses.length} 条</span>
                </p>
                <div className="space-y-2">
                  {analysis.hypotheses.map((h) => (
                    <div key={h.id ?? h.text} className="rounded-lg border border-slate-700/40 bg-slate-800/40 p-2.5">
                      <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-200">
                        <span className="shrink-0 rounded bg-cyan-600/25 px-1.5 py-0.5 text-[9px] font-bold text-cyan-300">{h.id ?? "H"}</span>
                        <span>{h.text}</span>
                      </p>
                      {h.type && <p className="mt-1 text-[9px] text-slate-500">类型: {h.type === "main" ? "主效应" : h.type === "mediation" ? "中介" : h.type === "moderation" ? "调节" : h.type}</p>}
                      {h.theory && <p className="mt-0.5 pl-6 text-[9px] leading-relaxed text-slate-500">{h.theory}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* W2: 研究逻辑(闭源"研究逻辑"一段话) */}
            {analysis?.logicChain ? (
              <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-4">
                <p className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-200">
                  <Network className="h-4 w-4 text-emerald-400" /> 研究逻辑
                </p>
                <p className="text-xs leading-relaxed text-slate-400">{analysis.logicChain}</p>
              </div>
            ) : null}

            <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-4">
              <p className="mb-2 flex items-center justify-between text-sm font-semibold text-slate-200">
                <span>章节清单</span>
                {/* W2: 闭源 Skill 卡字数(Phase 1 分配) */}
                {analysis?.chapterPlan?.some((c) => c.wordCount) ? <span className="text-[9px] font-normal text-slate-500">字数按 Phase 1 分配</span> : null}
              </p>
              <div className="space-y-1">
                {top.map((s, si) => {
                  const plan = analysis?.chapterPlan?.[si];
                  return (
                  <div key={s.id}>
                    <div className="flex items-center gap-2 py-1">
                      <span className="w-8 shrink-0 text-center text-xs font-semibold text-slate-500">{s.order ?? si + 1}</span>
                      <span className="text-sm text-slate-200">{s.title}</span>
                      {/* W2: 技能类型+目标字数(闭源: intro/literature/theory + NNNN 字(Phase 1 分配)) */}
                      {plan?.skillType || plan?.wordCount ? (
                        <span className="ml-auto shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[9px] text-slate-500">
                          {plan.skillType}{plan.wordCount ? ` · ${plan.wordCount.toLocaleString()} 字` : ""}
                        </span>
                      ) : null}
                    </div>
                    {(s.children ?? []).map((c) => (
                      <div key={c.id} className="flex items-center gap-2 py-0.5 pl-10">
                        <span className="w-8 shrink-0 text-center text-[10px] font-semibold text-slate-600">{(s.order ?? si + 1)}.{(s.children ?? []).indexOf(c) + 1}</span>
                        <span className="text-xs text-slate-400">{c.title}</span>
                      </div>
                    ))}
                  </div>
                ); })}
              </div>
            </div>
          </div>
        )}

        {/* 底操作 */}
        <div className="mt-8 flex items-center justify-between">
          <button onClick={onBack} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
            <RotateCcw className="h-3.5 w-3.5" /> 返回修改
          </button>
          <button onClick={onConfirm} disabled={phase !== "ready"}
            className={cn("flex items-center gap-1.5 rounded-lg px-5 py-2 text-sm font-medium", phase === "ready" ? "bg-cyan-600 text-white hover:bg-cyan-500" : "cursor-not-allowed bg-slate-800 text-slate-600")}>
            {phase === "ready" ? <><CheckCircle2 className="h-4 w-4" /> 确认科研架构, 进入创作</> : <><Loader2 className="h-4 w-4 animate-spin" /> 分析中...</>}
          </button>
        </div>
      </div>
    </div>
  );
}
