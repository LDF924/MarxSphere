// FinalizeView.tsx — SocialSci T3-5: 合稿定稿独立页(对齐闭源 FinalizeView)
// 单列五段式长表单(标题/摘要/关键词/正文/参考文献) + 合稿模式(直接合成/降AIGC强度)
// + 垂直 merge-timeline + 审查侧卡(章节完成度/字数) + phase5 merge 任务驱动
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckCircle2, ChevronLeft, ClipboardCheck, FileDown, FileText, GitMerge, ListChecks, Loader2, Sparkles, Wand2, X } from "lucide-react";

interface Sec { id: string; title: string; level: number; order?: number; status?: string; content?: string; children?: Sec[] }
interface FzPayload {
  mergedTitle?: string; mergedAbstract?: string; mergedKeywords?: string;
  mergedFullText?: string; mergedReferences?: string; isFinalized?: boolean;
  mode?: string; deAiStrength?: number; mergedAt?: string;
  reviewReport?: unknown;
}

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
const EMPTY: FzPayload = { mergedTitle: "", mergedAbstract: "", mergedKeywords: "", mergedFullText: "", mergedReferences: "", isFinalized: false, mode: "direct", deAiStrength: 50 };

// T7-5: 合稿五步流程(闭源 finalize 01-05 静态指示条)
const MERGE_STEPS: Array<{ title: string; desc: string }> = [
  { title: "合并正文", desc: "将各章节合并为连贯的全文" },
  { title: "语言润色", desc: "优化表达，消除AI痕迹" },
  { title: "整理参考文献", desc: "去重并统一格式" },
  { title: "生成元信息", desc: "标题、摘要、关键词" },
  { title: "完成", desc: "论文合并完成" },
];

export function FinalizeView({ projectId, title, onBack, onMsg }: {
  projectId: string; title: string; onBack: () => void; onMsg: (m: string) => void;
}) {
  const [payload, setPayload] = useState<FzPayload>(EMPTY);
  const [mode, setMode] = useState<"direct" | "deai">("direct");
  const [strength, setStrength] = useState(50);
  const [sections, setSections] = useState<Sec[]>([]);
  const [busy, setBusy] = useState(false);
  const [timeline, setTimeline] = useState<Array<{ t: string; msg: string; done: boolean }>>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    try {
      const [n, s] = await Promise.all([
        j<{ node: { payload?: FzPayload } }>(`/api/research/projects/${projectId}/nodes/finalize`).catch(() => ({ node: null })),
        j<{ node: { payload?: { sections?: Sec[] } } }>(`/api/research/projects/${projectId}/nodes/sections`).catch(() => ({ node: null })),
      ]);
      const p = n.node?.payload;
      if (p) setPayload({ ...EMPTY, ...p, mode: p.mode ?? "direct", deAiStrength: p.deAiStrength ?? 50 });
      setSections(s.node?.payload?.sections ?? []);
    } catch (e) { onMsg((e as Error).message); }
  };
  useEffect(() => { void load(); return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, [projectId]);

  // 自动拼装五段(不调 LLM): 各章 done 正文按顺序合并 → 全文字段; 摘要/关键词/参考文献留用户确认
  const chapterText = useMemo(() => {
    const top = sections.filter((s) => s.level === 1).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return top.filter((s) => (s.content ?? "").trim().length > 50)
      .map((s) => `${(s.content ?? "").trim()}`)
      .join("\n\n");
  }, [sections]);
  const doneCount = sections.filter((s) => s.level === 1 && (s.content ?? "").trim().length > 50).length;
  const topTotal = sections.filter((s) => s.level === 1).length;
  const refsCount = (payload.mergedReferences ?? "").split(/\n/).filter((l) => /\[\d+\]/.test(l)).length;

  const setField = (k: keyof FzPayload, v: string) => setPayload((p) => ({ ...p, [k]: v }));

  // 本地"合成正文"(可先预填再跑 merge LLM 润色)
  const assembleLocally = () => {
    setPayload((p) => ({ ...p, mergedFullText: chapterText || p.mergedFullText }));
    onMsg(chapterText ? `已按 ${doneCount} 章正文顺序合成 ${chapterText.replace(/\s/g, "").length} 字` : "还没有完成的章节正文(>50字), 先到章节创作工作区生成");
  };

  const step = (msg: string) => setTimeline((t) => [...t, { t: new Date().toLocaleTimeString(), msg, done: false }]);
  const doneStep = (i: number) => setTimeline((t) => t.map((x, idx) => (idx === i ? { ...x, done: true } : x)));

  // 跑 merge 任务(exec-engine 异步执行), 轮询任务结果 → finalize 节点
  const runMerge = async () => {
    if (busy) return;
    setBusy(true); setTimeline([]);
    const h = { "Content-Type": "application/json", ...(tokenOf() ? { Authorization: `Bearer ${tokenOf()}` } : {}) };
    try {
      step("创建合稿任务(phase5 merge)");
      const r = await fetch(`/api/research/jobs/phase5/merge`, {
        method: "POST", headers: h,
        body: JSON.stringify({
          projectId, goal: `合并定稿: ${payload.mergedTitle || title}`,
          sections: sections.filter((s) => s.level === 1).map((s) => ({ title: s.title })),
          chapterContents: sections.filter((s) => (s.content ?? "").trim().length > 50).map((s) => s.content ?? ""),
          enableDeAIFyMerge: mode === "deai",
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "创建失败");
      step("任务已入队, 等待执行引擎完成");
      const job = d.job as { id: string };
      // 轮询任务状态直至 done
      let guard = 0;
      for (;;) {
        await new Promise((rr) => setTimeout(rr, 4000));
        const st = await j<{ task?: { status: string; result?: unknown; error?: unknown } }>(`/api/research/tasks/${job.id}`).catch(() => ({ task: undefined }));
        const status = st.task?.status ?? "";
        guard++;
        if (status === "done") { step("合稿完成"); break; }
        if (status === "failed" || guard > 90) { step(`合稿失败: ${JSON.stringify(st.task?.error ?? "").slice(0, 100)}`); break; }
      }
      await load();
      onMsg("合稿任务已结束, 请在下表单核对/编辑各段");
    } catch (e) { onMsg((e as Error).message); } finally { setBusy(false); }
  };

  const saveNow = async () => {
    try {
      await j(`/api/research/projects/${projectId}/nodes/finalize`, {
        method: "PUT", body: JSON.stringify({ payload: { ...payload, mode, deAiStrength: strength }, sourceRole: "user", note: "合稿页保存" }),
      });
      onMsg("合稿内容已保存");
    } catch (e) { onMsg((e as Error).message); }
  };
  const finalize = async () => {
    try {
      await j(`/api/research/projects/${projectId}/nodes/finalize`, {
        method: "PUT", body: JSON.stringify({ payload: { ...payload, isFinalized: true, mode, deAiStrength: strength, mergedAt: new Date().toISOString() }, sourceRole: "user", note: "终稿激活" }),
      });
      onMsg("已激活终稿(可随时回滚)");
    } catch (e) { onMsg((e as Error).message); }
  };

  // ═══ P-A: 审查 → 修订 → 激活终稿闭环(对齐闭源 phase5 review/revise/activate) ═══
  const [phaseBusy, setPhaseBusy] = useState<"" | "review" | "revise">("");
  const [report, setReport] = useState<null | {
    overallScore?: number; grade?: string; overallComment?: string; overall?: string;
    highlights?: string[]; checks?: Record<string, { pass?: boolean; detail?: string }>;
    topSuggestions?: string[]; revisedAt?: string;
  }>(null);

  // 载入已存审稿报告(finalize 节点 payload.reviewReport / project 由后端回写)
  const loadReport = async () => {
    try {
      const r = await j<{ node: { payload?: { reviewReport?: unknown } } }>(`/api/research/projects/${projectId}/nodes/finalize`).catch(() => ({ node: null }));
      const rr = r.node?.payload?.reviewReport;
      if (rr && typeof rr === "object") setReport(rr as typeof report);
    } catch { /* 无报告不提示 */ }
  };
  useEffect(() => { if (projectId) void loadReport(); }, [projectId]);

  const pollJob = async (jobId: string, stepMsg: string) => {
    step(stepMsg);
    let guard = 0;
    for (;;) {
      await new Promise((rr) => setTimeout(rr, 4000));
      const st = await j<{ task?: { status?: string; error?: unknown; result?: { structured?: { overallScore?: number; grade?: string; data?: { abstract?: string; body?: string } } } } }>(`/api/research/tasks/${jobId}`).catch(() => ({ task: undefined }));
      const status = st.task?.status ?? "";
      guard++;
      if (status === "done") { return st.task; }
      if (status === "failed" || guard > 120) { step(`任务失败: ${JSON.stringify(st.task?.error ?? "").slice(0, 120)}`); return null; }
    }
  };

  // 审查: 对合并正文跑六维审稿(后端读 project.merged_fulltext)
  const runReview = async () => {
    if (phaseBusy || !(payload.mergedFullText ?? "").trim()) { onMsg("请先合成正文再审查"); return; }
    setPhaseBusy("review"); setTimeline([]);
    try {
      const r = await j<{ job: { id: string } }>(`/api/research/jobs/phase5/review`, {
        method: "POST", body: JSON.stringify({ projectId, goal: `全文审查: ${payload.mergedTitle || title}` }),
      });
      const done = await pollJob(r.job.id, "审查任务已入队, 等待六维审稿完成");
      if (done) {
        step("审查完成");
        const sd = done.result?.structured;
        if (sd) {
          const rep = { overallScore: sd.overallScore, grade: sd.grade, overallComment: "", overall: "", highlights: [], checks: {}, topSuggestions: [], revisedAt: undefined } as typeof report;
          setReport(rep);
          // 报告持久化到 finalize 节点(刷新不丢)
          try {
            await j(`/api/research/projects/${projectId}/nodes/finalize`, {
              method: "PUT", body: JSON.stringify({ payload: { ...payload, reviewReport: rep }, sourceRole: "user", note: "六维审查报告" }),
            });
          } catch { /* 持久化失败不阻断 */ }
        }
        await load(); await loadReport();
        onMsg("六维审查完成, 报告见右侧审查卡");
      }
    } catch (e) { onMsg((e as Error).message); } finally { setPhaseBusy(""); }
  };

  // 修订: 后端读 review_result 做有向修订, 产物覆盖 merged_* → 重拉
  const runRevise = async () => {
    if (phaseBusy) return;
    setPhaseBusy("revise"); setTimeline([]);
    try {
      const r = await j<{ job: { id: string } }>(`/api/research/jobs/phase5/revise`, {
        method: "POST", body: JSON.stringify({ projectId, goal: `按审稿意见修订: ${payload.mergedTitle || title}` }),
      });
      const done = await pollJob(r.job.id, "修订任务已入队, 全文去AI化改写中");
      if (done) {
        step("修订完成, 修订稿已回填各段");
        await load(); // 重新拉 finalize 节点 + sections
        onMsg("修订稿已生成并回填(可继续编辑或激活终稿)");
      }
    } catch (e) { onMsg((e as Error).message); } finally { setPhaseBusy(""); }
  };

  // 终稿激活 → 版本发布(闭源 activate: 版本置 published) — 读取当前版本号
  const [verList, setVerList] = useState<Array<{ version: number; label: string; status: string }>>([]);
  const loadVersions = async () => {
    const r = await j<{ versions: Array<{ version: number; label: string; status: string }> }>(`/api/research/projects/${projectId}/versions`).catch(() => ({ versions: [] }));
    setVerList(r.versions);
  };
  useEffect(() => { if (projectId) void loadVersions(); }, [projectId]);
  const activateVersion = async () => {
    try {
      await loadVersions();
      const latest = verList[0];
      if (!latest) { onMsg("尚无发布版本, 先跑合稿/修订(完成自动发布版本)"); return; }
      const r = await j<{ ok: boolean; version: number }>(`/api/research/projects/${projectId}/versions/${latest.version}/activate`, { method: "POST", body: "{}" });
      onMsg(`已激活 v${r.version} 为终稿`);
      await loadVersions();
    } catch (e) { onMsg((e as Error).message); }
  };

  const inputCls = "w-full rounded-lg border border-slate-600/60 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-500/50 focus:outline-none";
  const labelCls = "mb-1 block text-[11px] font-semibold text-slate-400";
  const sum = (v: string) => v.replace(/\s/g, "").length;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-slate-950/98 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-slate-700/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"><ChevronLeft className="h-4 w-4" /></button>
          <GitMerge className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-bold text-slate-100">合并定稿 · {title}</h2>
          {payload.isFinalized && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] text-emerald-300">终稿已激活</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void saveNow()} className="flex items-center gap-1 rounded-lg bg-slate-700 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-slate-600"><FileDown className="h-3 w-3" />保存</button>
          <button onClick={onBack} className="rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-slate-700">完成返回画布</button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_260px] gap-3 p-3">
        {/* 左: 五段式长表单 */}
        <div className="min-h-0 space-y-4 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-4">
          {/* T7-5: 合稿五步流程指示(闭源 finalize 01-05 静态条) */}
          <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-3">
            <p className="mb-1 text-[11px] font-semibold text-slate-300">准备合并定稿</p>
            <p className="mb-2 text-[10px] text-slate-500">AI 将把所有章节合并为一篇完整的学术论文, 并进行语言优化、格式统一和参考文献整理。</p>
            <div className="grid grid-cols-5 gap-1">
              {MERGE_STEPS.map((s, i) => (
                <div key={i} className={cn("rounded-lg px-1.5 py-1.5 text-center", doneCount === 0 ? "bg-slate-800/60" : i <= Math.min(2, doneCount) ? "bg-emerald-500/10" : "bg-slate-800/60")}>
                  <p className="text-[8px] font-bold text-slate-600">0{i + 1}</p>
                  <p className="mt-0.5 text-[9px] leading-tight text-slate-300">{s.title}</p>
                  <p className="mt-0.5 text-[8px] leading-tight text-slate-600">{s.desc}</p>
                </div>
              ))}
            </div>
          </div>
          {/* 合稿模式 */}
          <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-3">
            <p className="mb-2 text-[11px] font-semibold text-slate-300">合稿模式</p>
            <div className="flex items-center gap-2">
              <button onClick={() => setMode("direct")}
                className={cn("rounded-lg px-3 py-1.5 text-[11px]", mode === "direct" ? "bg-emerald-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200")}>直接合稿</button>
              <button onClick={() => setMode("deai")}
                className={cn("rounded-lg px-3 py-1.5 text-[11px]", mode === "deai" ? "bg-purple-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200")}>降AIGC合稿</button>
              {mode === "deai" && (
                <div className="ml-2 flex flex-1 flex-wrap items-center gap-1.5">
                  <span className="text-[10px] text-purple-300">强度:</span>
                  {[["light", 30, "轻度降重"], ["medium", 55, "中度降重"], ["heavy", 85, "重度降重"]].map(([k, v, lb]) => (
                    <button key={k as string} onClick={() => setStrength(v as number)}
                      className={cn("rounded-full border px-2.5 py-0.5 text-[10px]", strength === v ? "border-purple-500/60 bg-purple-600/20 text-purple-200" : "border-slate-600/60 bg-slate-800 text-slate-400 hover:text-slate-200")}>
                      {lb as string}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {mode === "deai" && <p className="mt-1 text-[9px] text-amber-300/70">降重可能会影响整体论文质量, 请自行斟酌</p>}
            <div className="mt-2 flex gap-1.5">
              <button onClick={assembleLocally} className="rounded bg-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-600">按章节本地合成正文</button>
              <button onClick={() => void runMerge()} disabled={busy || doneCount === 0}
                className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1 text-[10px] text-white hover:bg-emerald-500 disabled:opacity-50">
                {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Sparkles className="h-2.5 w-2.5" />}{busy ? "合稿中..." : "运行智能合稿(merge)"}
              </button>
            </div>
          </div>

          {/* 五段表单 */}
          <div>
            <label className={labelCls}>标题 *</label>
            <input className={inputCls} value={payload.mergedTitle ?? ""} onChange={(e) => setField("mergedTitle", e.target.value)} placeholder={title} />
          </div>
          <div>
            <label className={labelCls}>摘要 <span className="text-slate-600">({sum(payload.mergedAbstract ?? "")} 字)</span></label>
            <textarea rows={4} className={cn(inputCls, "resize-none font-mono text-xs")} value={payload.mergedAbstract ?? ""} onChange={(e) => setField("mergedAbstract", e.target.value)} placeholder="论文摘要(约 200-300 字)…" />
          </div>
          <div>
            <label className={labelCls}>关键词 <span className="text-slate-600">(逗号分隔 3-5 个)</span></label>
            <input className={inputCls} value={payload.mergedKeywords ?? ""} onChange={(e) => setField("mergedKeywords", e.target.value)} placeholder="数字经济; 中小企业融资; 金融科技" />
          </div>
          <div>
            <label className={labelCls}>正文 <span className="text-slate-600">({sum(payload.mergedFullText ?? "")} 字 · 点击章节卡右侧工具条可回写作工作区补写)</span></label>
            <div className="grid grid-cols-2 gap-2">
              <textarea rows={18} className={cn(inputCls, "resize-none font-mono text-xs leading-relaxed")} value={payload.mergedFullText ?? ""} onChange={(e) => setField("mergedFullText", e.target.value)} placeholder="各章节正文将在此合稿…" />
              <div className="h-full overflow-y-auto rounded-lg border border-slate-700/40 bg-slate-950/50 p-3 text-xs leading-relaxed text-slate-300">
                {(payload.mergedFullText ?? "").trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{payload.mergedFullText}</ReactMarkdown> : <span className="text-slate-600">正文预览 — 先"本地合成"或运行合稿任务</span>}
              </div>
            </div>
          </div>
          <div>
            <label className={labelCls}>参考文献 <span className="text-slate-600">({refsCount} 条)</span></label>
            <textarea rows={8} className={cn(inputCls, "resize-none font-mono text-xs")} value={payload.mergedReferences ?? ""} onChange={(e) => setField("mergedReferences", e.target.value)} placeholder="[1] 作者. 题名[J]. 期刊, 年份(期): 页码." />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => void saveNow()} className="rounded-lg bg-slate-700 px-3 py-2 text-[11px] text-slate-200 hover:bg-slate-600">保存草稿</button>
            <button onClick={finalize} disabled={!((payload.mergedFullText ?? "").trim() && (payload.mergedTitle ?? "").trim())}
              className="flex items-center gap-1 rounded-lg bg-emerald-600 px-4 py-2 text-[11px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
              <CheckCircle2 className="h-3.5 w-3.5" />激活终稿
            </button>
          </div>
        </div>

        {/* 右: 审查侧卡 + timeline */}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
            <p className="mb-2 flex items-center gap-1 text-[11px] font-semibold text-slate-300"><ListChecks className="h-3.5 w-3.5 text-emerald-400" />合稿审查</p>
            <div className="space-y-1.5 text-[10px] text-slate-400">
              <p className="flex justify-between"><span>一级章节完成</span><span className={doneCount === topTotal ? "text-emerald-300" : "text-amber-300"}>{doneCount}/{topTotal}</span></p>
              <div className="h-1 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${topTotal ? (doneCount / topTotal) * 100 : 0}%` }} /></div>
              {doneCount < topTotal && <p className="text-amber-300/80">还有 {topTotal - doneCount} 章未完成, 合稿将缺章</p>}
              <p className="flex justify-between"><span>标题</span><span>{payload.mergedTitle?.trim() ? "✓" : "—"}</span></p>
              <p className="flex justify-between"><span>摘要</span><span>{sum(payload.mergedAbstract ?? "") >= 80 ? `✓ ${sum(payload.mergedAbstract ?? "")}字` : "—"}</span></p>
              <p className="flex justify-between"><span>关键词</span><span>{(payload.mergedKeywords ?? "").split(/[,，;；]/).filter(Boolean).length >= 3 ? "✓" : "—"}</span></p>
              <p className="flex justify-between"><span>正文</span><span>{sum(payload.mergedFullText ?? "") >= 2000 ? `✓ ${(sum(payload.mergedFullText ?? "") / 1000).toFixed(1)}k字` : "—"}</span></p>
              <p className="flex justify-between"><span>参考文献</span><span>{refsCount ? `✓ ${refsCount}条` : "—"}</span></p>
            </div>
            {payload.isFinalized && <p className="mt-2 rounded bg-emerald-500/10 px-2 py-1 text-[9px] text-emerald-300">终稿已激活于 {payload.mergedAt ? new Date(payload.mergedAt).toLocaleString() : ""}</p>}

            {/* P-A: 审查→修订→激活(闭源 phase5 review/revise/activate 闭环) */}
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-slate-700/40 pt-2">
              <button onClick={() => void runReview()} disabled={phaseBusy !== "" || !(payload.mergedFullText ?? "").trim()}
                className="flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 text-[10px] text-white hover:bg-indigo-500 disabled:opacity-50">
                {phaseBusy === "review" ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <ClipboardCheck className="h-2.5 w-2.5" />}{phaseBusy === "review" ? "审查中..." : "运行全文审查"}
              </button>
              <button onClick={() => void runRevise()} disabled={phaseBusy !== ""}
                className="flex items-center gap-1 rounded bg-purple-600 px-2 py-1 text-[10px] text-white hover:bg-purple-500 disabled:opacity-50">
                {phaseBusy === "revise" ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Wand2 className="h-2.5 w-2.5" />}{phaseBusy === "revise" ? "修订中..." : "按审稿修订"}
              </button>
              <button onClick={() => void activateVersion()}
                className="flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-[10px] text-white hover:bg-emerald-500">
                <CheckCircle2 className="h-2.5 w-2.5" />激活终稿版本
              </button>
            </div>

            {/* P-A: 六维审查报告卡(闭源: score+checks 六项 pass/detail) */}
            {report && (
              <div className="mt-2 rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold text-indigo-300">六维审查报告</p>
                  {report.overallScore !== undefined && (
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold",
                      (report.overallScore ?? 0) >= 85 ? "bg-green-500/20 text-green-300" : (report.overallScore ?? 0) >= 70 ? "bg-amber-500/20 text-amber-300" : "bg-rose-500/20 text-rose-300")}>
                      {report.overallScore} 分 {report.grade ? `· ${report.grade}` : ""}
                    </span>
                  )}
                </div>
                {(report.overallComment || report.overall) && <p className="mt-1 text-[9px] leading-relaxed text-slate-400">{report.overallComment || report.overall}</p>}
                {report.checks && Object.keys(report.checks).length > 0 && (
                  <div className="mt-1.5 grid grid-cols-2 gap-1">
                    {Object.entries(report.checks).map(([k, v]) => (
                      <div key={k} className={cn("rounded border px-1.5 py-1", v.pass ? "border-green-500/25 bg-green-500/5" : "border-rose-500/25 bg-rose-500/5")}>
                        <p className={cn("text-[9px] font-semibold", v.pass ? "text-green-300" : "text-rose-300")}>{v.pass ? "✓" : "✗"} {k}</p>
                        {v.detail && <p className="mt-0.5 text-[8px] leading-snug text-slate-500">{v.detail.slice(0, 80)}{(v.detail ?? "").length > 80 ? "…" : ""}</p>}
                      </div>
                    ))}
                  </div>
                )}
                {report.topSuggestions && report.topSuggestions.length > 0 && (
                  <div className="mt-1.5">
                    <p className="text-[9px] font-semibold text-amber-300">优先修订</p>
                    {report.topSuggestions.slice(0, 3).map((s, i) => <p key={i} className="mt-0.5 text-[8px] text-slate-500">· {s}</p>)}
                  </div>
                )}
                <div className="mt-1.5 flex items-center justify-between border-t border-slate-700/40 pt-1">
                  <span className="text-[8px] text-slate-600">{report.revisedAt ? `修订于 ${new Date(report.revisedAt).toLocaleString()}` : "可点击「按审稿修订」执行有向修订"}</span>
                  {verList.length > 0 && <span className="text-[8px] text-slate-500">版本: {verList.map((v) => (v.status === "published" ? `v${v.version}${v.label ? `(${v.label})` : ""}` : "")).filter(Boolean).join(" ") || "未发布"}</span>}
                </div>
              </div>
            )}
          </div>

          {/* merge-timeline */}
          {timeline.length > 0 && (
            <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
              <p className="mb-2 text-[11px] font-semibold text-slate-300">合稿进度</p>
              <div className="space-y-0">
                {timeline.map((t, i) => (
                  <div key={i} className="relative flex gap-2 pb-3 last:pb-0">
                    {i < timeline.length - 1 && <span className="absolute left-[5px] top-4 h-full w-px bg-slate-700" />}
                    <span className={cn("z-10 mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full border-2", t.done ? "border-emerald-400 bg-emerald-400/30" : "border-amber-400 bg-transparent")} />
                    <div className="min-w-0">
                      <p className={cn("text-[10px]", t.done ? "text-slate-300" : "text-amber-300")}>{t.msg}</p>
                      <p className="text-[8px] text-slate-600">{t.t}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
