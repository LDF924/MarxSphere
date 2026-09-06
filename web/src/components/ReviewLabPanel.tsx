// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ReviewLabPanel.tsx — SocialSci P0-3: 审稿实验室(在线科研审查)
// 形态对齐(闭源产品交互语义, 原创实现): 传稿→SSE 维度实时涌入→审稿报告(维度评分卡)→期刊/标准库
//   - 新建审稿: 粘贴全文(选期刊规则/审核标准) → SSE 流式(review.started/status/delta/completed)
//   - 报告: 维度评分卡 + 大小修清单 + 总体评语 + 打印/导出入口
//   - 期刊库: 投稿须知粘贴 → AI 解析入库; 标准库: 评分标准 → 维度解析/设默认
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen, CheckCircle2, ClipboardList, FileDown, Gavel, Loader2,
  PenLine, Printer, RefreshCw, ScrollText, Sparkles, Trash2,
} from "lucide-react";

interface ReviewJobLite {
  id: string; kind: string; title: string; status: string;
  paper_title?: string; word_count?: number; created_at: string; updated_at: string;
}
interface Journal { id: string; name: string; level: string; scope: string; focus_count: number; user_id: string | null; }
interface Standard { id: string; name: string; built_in: boolean; is_default: boolean; dimensions: Array<{ key: string; name: string; weight: number }>; }
interface ReviewResult {
  paperTitle: string; wordCount: number;
  // R4 全 schema
  overallScore?: number; grade?: string; overallComment?: string;
  annotations?: Array<{ id: string; type: string; dimension: string; highlightText: string; comment: string }>;
  highlights?: string[]; topSuggestions?: string[];
  dimensions: Array<{ key?: string; name: string; score: number; comment?: string;
    maxScore?: number; weight?: number; status?: string; summary?: string;
    issues: string[] | Array<{ id: string; severity: string; location: string; originalText: string; suggestion?: string }> }>;
  overall: string; majorIssues: Array<{ title: string; detail: string }>;
  minorIssues: Array<{ title: string; detail: string }>;
  segmentIssues?: number;
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

type Tab = "new" | "jobs" | "report" | "journals" | "standards";

export function ReviewLabPanel() {
  const [tab, setTab] = useState<Tab>("new");
  const [jobs, setJobs] = useState<ReviewJobLite[]>([]);
  const [journals, setJournals] = useState<Journal[]>([]);
  const [standards, setStandards] = useState<Standard[]>([]);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [journalId, setJournalId] = useState("");
  const [standardId, setStandardId] = useState("");
  const [strictness, setStrictness] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [streamState, setStreamState] = useState<{ jobId: string; status: string; step: number; total: number } | null>(null);
  const [deltaCount, setDeltaCount] = useState(0);
  // T6: 流式期间实时聚合段问题预览
  const [liveIssues, setLiveIssues] = useState<Array<{ seg: number; text: string }>>([]);
  const [partialScore, setPartialScore] = useState<number | null>(null);
  const [liveDims, setLiveDims] = useState<Array<{ name: string; score: number; status: string; summary: string }>>([]);
  const [partialJson, setPartialJson] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [curJob, setCurJob] = useState<string>("");
  // 期刊/标准 modal
  const [jpInput, setJpInput] = useState("");   // 投稿须知原文
  const [jpName, setJpName] = useState("");
  const [parseBusy, setParseBusy] = useState(false);
  const [stdInput, setStdInput] = useState("");
  const [stdName, setStdName] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [jr, rs] = await Promise.all([
        j<{ jobs: ReviewJobLite[] }>("/api/review/jobs"),
        j<{ journals: Journal[] }>("/api/review/journals"),
      ]);
      setJobs(jr.jobs ?? []); setJournals(rs.journals ?? []);
      const st = await j<{ standards: Standard[] }>("/api/review/standards");
      setStandards(st.standards ?? []);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void loadAll(); }, [loadAll]);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [upBusy, setUpBusy] = useState(false);
  // 上传 docx/txt → 正文提取 → 填入
  const onPickFile = async (file: File) => {
    setUpBusy(true); setErr("");
    try {
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const r = await j<{ ok: boolean; text?: string; error?: string }>("/api/files/extract-text", {
        method: "POST", body: JSON.stringify({ filename: file.name, base64: b64, mime: file.type }),
      });
      if (!r.ok || !r.text) throw new Error(r.error || "未能提取正文");
      setText(r.text);
      setTitle(file.name.replace(/\.[^.]+$/, ""));
      setErr(`已提取 ${file.name} (${r.text.length} 字)`);
    } catch (e) { setErr((e as Error).message); } finally { setUpBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const createAndRun = async () => {
    if (!text.trim()) { setErr("请粘贴稿件全文"); return; }
    setBusy(true); setErr(""); setDeltaCount(0); setResult(null);
    try {
      const r = await j<{ jobId: string; segmentCount: number }>("/api/review/jobs", {
        method: "POST",
        body: JSON.stringify({
          text, title: title || undefined, journalId: journalId || undefined,
          standardId: standardId || undefined,
          settings: { strictness, journalId: journalId || null, standardIds: standardId ? [standardId] : [], customRequirements: "" },
        }),
      });
      setCurJob(r.jobId);
      await runStream(r.jobId);
      void loadAll();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  const runStream = async (jobId: string) => {
    setTab("report");
    setStreamState({ jobId, status: "started", step: 0, total: 0 });
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const r = await fetch(`/api/review/jobs/${jobId}/stream`, {
        headers: { Authorization: `Bearer ${tokenOf()}`, Accept: "text/event-stream" },
        signal: ac.signal,
      });
      if (!r.ok || !r.body) throw new Error(`流连接失败 ${r.status}`);
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
          if (ev === "review.started") setStreamState((s) => ({ ...s!, total: obj.totalSegments ?? 0 }));
          else if (ev === "review.status") setStreamState((s) => ({ ...s!, status: "running", step: obj.step ?? s?.step ?? 0 }));
          else if (ev === "review.delta") {
            setDeltaCount((c) => c + (obj.issuesCount ?? 0));
            // T6: delta.content 是 fenced JSON 流式累积 → 实时解出报告片段
            if (typeof obj.content === "string") {
              setPartialJson((cur) => {
                const next = (cur ?? "") + obj.content;
                const m = next.match(/```json\s*([\s\S]*?)(?:```|$)/);
                if (m) {
                  try {
                    const parsed = JSON.parse(m[1]);
                    if (parsed?.overallScore !== undefined || parsed?.paperTitle) {
                      if (parsed.overallScore !== undefined) setPartialScore(parsed.overallScore);
                      const dims = parsed.dimensions;
                      if (Array.isArray(dims) && dims.length) {
                        setLiveDims(dims.map((dd: { name?: string; score?: number; status?: string; summary?: string }) => ({
                          name: dd.name ?? "维度", score: dd.score ?? 0,
                          status: dd.status ?? (Number(dd.score ?? 0) >= 60 ? "warning" : "error"),
                          summary: dd.summary ?? "",
                        })));
                      }
                    }
                  } catch { /* JSON 未完整, 继续累积 */ }
                }
                return next;
              });
            }
          }
          else if (ev === "review.completed") { setResult(obj.result); setStreamState((s) => ({ ...s!, status: "done" })); setLiveDims([]); }
          else if (ev === "error") { setErr(obj.userMessage || "审稿失败"); setStreamState((s) => ({ ...s!, status: "failed" })); }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") { setErr((e as Error).message); setStreamState((s) => ({ ...s!, status: "failed" })); }
    } finally { setBusy(false); }
  };

  const openJob = async (jobId: string) => {
    setCurJob(jobId); setBusy(true); setErr("");
    try {
      const r = await j<{ job: { status: string; result: ReviewResult | null } }>(`/api/review/jobs/${jobId}`);
      if (r.job.result) { setResult(r.job.result); setTab("report"); }
      else if (r.job.status === "queued" || r.job.status === "failed" || r.job.status === "cancelled") {
        // 重跑
        await runStream(jobId);
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const control = async (jobId: string, action: "cancel" | "retry") => {
    setBusy(true); setErr("");
    try {
      await j(`/api/review/jobs/${jobId}/control`, { method: "POST", body: JSON.stringify({ action }) });
      if (action === "retry") await runStream(jobId);
      await loadAll();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // Word 批注导出(当前报告任务 curJob; 空则从 jobs 记录取最近 done)
  const exportWord = async () => {
    const jobId = curJob;
    setExportBusy(true); setErr("");
    try {
      const r = await j<{ ok: boolean; base64?: string; fileName?: string; error?: string }>(`/api/review/jobs/${jobId}/export-word`, { method: "POST", body: "{}" });
      if (!r.ok || !r.base64) throw new Error(r.error || "导出失败");
      const a = document.createElement("a");
      a.href = `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${r.base64}`;
      a.download = r.fileName ?? "审稿报告.docx";
      a.click();
    } catch (e) { setErr((e as Error).message); } finally { setExportBusy(false); }
  };

  // 期刊解析入库
  const parseJournal = async () => {
    if (!jpInput.trim() || !jpName.trim()) { setErr("请填期刊名+粘贴投稿须知"); return; }
    setParseBusy(true); setErr("");
    try {
      const r = await j<{ parsed: { formatRules: string[]; reviewFocus: string[]; citationRules: string[]; scope: string } }>("/api/review/journals/parse", {
        method: "POST", body: JSON.stringify({ rawText: jpInput }),
      });
      await j("/api/review/journals", {
        method: "POST",
        body: JSON.stringify({ name: jpName.trim(), submissionGuideText: jpInput, parsedRules: r.parsed }),
      });
      setJpInput(""); setJpName(""); await loadAll();
    } catch (e) { setErr((e as Error).message); } finally { setParseBusy(false); }
  };

  // 标准解析入库
  const parseStandard = async () => {
    if (!stdInput.trim() || !stdName.trim()) { setErr("请填标准名+粘贴评分标准原文"); return; }
    setParseBusy(true); setErr("");
    try {
      const r = await j<{ dimensions: Array<{ key: string; name: string; weight: number }> }>("/api/review/standards/parse", {
        method: "POST", body: JSON.stringify({ rawText: stdInput }),
      });
      await j("/api/review/standards", {
        method: "POST",
        body: JSON.stringify({ name: stdName.trim(), sourceText: stdInput, dimensions: r.dimensions }),
      });
      setStdInput(""); setStdName(""); await loadAll();
    } catch (e) { setErr((e as Error).message); } finally { setParseBusy(false); }
  };

  const delJournal = async (id: string) => { try { await j(`/api/review/journals/${id}`, { method: "DELETE" }); await loadAll(); } catch (e) { setErr((e as Error).message); } };
  const delStandard = async (id: string) => { try { await j(`/api/review/standards/${id}`, { method: "DELETE" }); await loadAll(); } catch (e) { setErr((e as Error).message); } };
  const setDefault = async (id: string) => { try { await j(`/api/review/standards/${id}/default`, { method: "POST", body: JSON.stringify({ isDefault: true }) }); await loadAll(); } catch (e) { setErr((e as Error).message); } };

  const statusColor = (s: string) =>
    s === "done" ? "bg-green-500/15 text-green-300" : s === "failed" ? "bg-red-500/15 text-red-300"
      : s === "cancelled" ? "bg-slate-500/15 text-slate-400" : "bg-amber-500/15 text-amber-300";

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      {/* 头 */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gavel className="h-5 w-5 text-rose-400" />
          <h2 className="text-base font-bold text-slate-100">审稿实验室</h2>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">SocialSci 对齐</span>
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-800/80 p-0.5">
          {([["new", "新建审稿", <PenLine key="i" className="h-3 w-3" />], ["jobs", "审稿记录", <ClipboardList key="i" className="h-3 w-3" />],
            ["journals", "期刊库", <BookOpen key="i" className="h-3 w-3" />], ["standards", "审核标准", <ScrollText key="i" className="h-3 w-3" />]] as Array<[Tab, string, React.ReactNode]>).map(([k, label, ic]) => (
            <button key={k} onClick={() => setTab(k)}
              className={cn("flex items-center gap-1 rounded-md px-2.5 py-1 text-xs", tab === k ? "bg-slate-600 text-white" : "text-slate-400 hover:text-slate-200")}>
              {ic}{label}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{err}</div>}

      {tab === "new" && (
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_240px] gap-3">
          <div className="flex min-h-0 flex-col rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
            {/* 上传或粘贴 */}
            <div className="mb-2 flex items-center justify-between rounded-lg border border-dashed border-slate-600 bg-slate-800/40 px-3 py-2">
              <span className="text-[10px] text-slate-500">{upBusy ? "提取中…" : "上传 Word/TXT → 自动提取正文"}</span>
              <button onClick={() => fileRef.current?.click()} disabled={upBusy}
                className="rounded bg-slate-700 px-2.5 py-1 text-[10px] text-slate-200 hover:bg-slate-600 disabled:opacity-50">
                {upBusy ? <Loader2 className="mr-1 inline h-2.5 w-2.5 animate-spin" /> : <FileText className="mr-1 inline h-2.5 w-2.5" />}选择文件
              </button>
              <input ref={fileRef} type="file" accept=".docx,.txt,.md" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickFile(f); }} />
            </div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="论文标题(选填, 自动从正文推断)"
              className="mb-2 rounded-lg border border-slate-600/60 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500" />
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={"粘贴论文全文(支持长文, 将分段审稿后汇总; 文件上传支持后续批)\n\n…论文正文…"}
              className="min-h-0 flex-1 resize-none rounded-lg border border-slate-600/60 bg-slate-800/70 px-3 py-2 text-xs leading-relaxed text-slate-200 placeholder:text-slate-500" />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[10px] text-slate-500">{text ? `${text.length} 字(将分 ${Math.ceil(text.length / 3000)} 段审阅)` : ""}</span>
              <button onClick={createAndRun} disabled={busy || !text.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Gavel className="h-3.5 w-3.5" />}
                开始审稿 (SSE 流式)
              </button>
            </div>
          </div>
          {/* 右侧: 期刊规则/标准选择 */}
          <div className="space-y-3 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-3 text-xs">
            <div>
              <p className="mb-1.5 font-semibold text-slate-300">选用刊物规则 <span className="text-[9px] text-slate-500">(可不用)</span></p>
              <select value={journalId} onChange={(e) => setJournalId(e.target.value)}
                className="w-full rounded-lg border border-slate-600/60 bg-slate-800 px-2 py-1.5 text-slate-200">
                <option value="">— 通用审稿 —</option>
                {journals.map((j) => <option key={j.id} value={j.id}>{j.name} [{j.level}]</option>)}
              </select>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-500">选用后该刊解析规则(格式/审稿关注点)并入本次审稿维度</p>
            </div>
            <div>
              <p className="mb-1.5 font-semibold text-slate-300">选用审核标准</p>
              <select value={standardId} onChange={(e) => setStandardId(e.target.value)}
                className="w-full rounded-lg border border-slate-600/60 bg-slate-800 px-2 py-1.5 text-slate-200">
                <option value="">— 默认 6 维标准 —</option>
                {standards.map((s) => <option key={s.id} value={s.id}>{s.name}{s.built_in ? " (内置)" : ""}{s.is_default ? " ★默认" : ""}</option>)}
              </select>
            </div>
            <div>
              <p className="mb-1.5 font-semibold text-slate-300">审查严格度</p>
              <div className="grid grid-cols-3 gap-1">
                {(["loose", "medium", "strict"] as const).map((st) => (
                  <button key={st} onClick={() => setStrictness(st)}
                    className={cn("rounded-lg py-1.5 text-[11px]", strictness === st ? "bg-rose-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200")}>
                    {st === "loose" ? "宽松" : st === "medium" ? "标准" : "严格"}
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-2 text-[10px] leading-relaxed text-slate-500">
              <p className="mb-1 font-semibold text-slate-400">审稿输出</p>
              <p>· 分段流式审阅(每段问题实时推送)</p>
              <p>· 聚合生成维度评分卡(选题/文献/逻辑/方法/表达/创新)</p>
              <p>· 大修/小修问题清单 + 总体评语与录用建议</p>
              <p>· 支持断线续传(每段 checkpoint)</p>
            </div>
          </div>
        </div>
      )}

      {tab === "jobs" && (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
          {jobs.length === 0 && <p className="mt-10 text-center text-xs text-slate-500">暂无审稿记录</p>}
          {jobs.map((job) => (
            <div key={job.id} className="mb-2 flex items-center justify-between rounded-lg border border-slate-700/50 bg-slate-800/50 p-3">
              <div className="min-w-0 cursor-pointer" onClick={() => openJob(job.id)}>
                <p className="truncate text-sm font-medium text-slate-200">{job.paper_title || job.title || "未命名审稿"}</p>
                <p className="mt-0.5 text-[10px] text-slate-500">{new Date(job.created_at).toLocaleString()}{job.word_count ? ` · ${job.word_count} 字` : ""}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={cn("rounded-full px-2 py-0.5 text-[10px]", statusColor(job.status))}>{job.status}</span>
                {job.status === "failed" && (
                  <button onClick={() => control(job.id, "retry")} className="rounded bg-slate-700 px-2 py-1 text-[10px] text-slate-200 hover:bg-slate-600">
                    <RefreshCw className="mr-1 inline h-2.5 w-2.5" />重试
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "report" && (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-4">
          {streamState && streamState.status !== "done" && !result && (
            <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
              <p className="flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {streamState.status === "failed" ? "审稿失败" : "审稿进行中..."}
                <span className="text-slate-400">({streamState.step}/{streamState.total || "?"} 段已阅 · 已发现 {deltaCount} 个问题)</span>
              </p>
              <button onClick={() => abortRef.current?.abort()} className="mt-2 rounded bg-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-600">停止</button>
            </div>
          )}
          {/* T6: 流式期间实时评分卡(partialJson累积解析) */}
          {(partialScore !== null || liveDims.length > 0) && streamState?.status !== "done" && !result && (
            <div className="mb-3 space-y-2 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
              <p className="flex items-center gap-2 text-xs font-medium text-sky-200">
                <Loader2 className="h-3 w-3 animate-spin" /> 实时评分卡(聚合中)
                {partialScore !== null && <span className={cn("ml-auto text-xl font-bold", partialScore >= 70 ? "text-green-400" : partialScore >= 55 ? "text-amber-400" : "text-rose-400")}>{partialScore}</span>}
              </p>
              {liveDims.length > 0 && (
                <div className="grid grid-cols-2 gap-1.5">
                  {liveDims.map((dd, i) => (
                    <div key={i} className="rounded bg-slate-800/60 px-2 py-1">
                      <div className="flex items-center justify-between">
                        <span className={cn("text-[10px] font-medium", dd.status === "good" ? "text-green-300" : dd.status === "warning" ? "text-amber-300" : "text-rose-300")}>
                          {dd.name}
                        </span>
                        <span className="text-[11px] font-bold text-slate-200">{dd.score}</span>
                      </div>
                      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-slate-700">
                        <div className={cn("h-full rounded-full transition-all duration-700", dd.status === "good" ? "bg-green-400" : dd.status === "warning" ? "bg-amber-400" : "bg-rose-400")}
                          style={{ width: `${dd.score}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {result ? (
            <div className="space-y-4">
              {/* 报告头 */}
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-slate-100">{result.paperTitle}</h3>
                  <p className="text-[11px] text-slate-500">全文 {result.wordCount} 字 · 发现 {result.segmentIssues ?? 0} 处问题 · {new Date().toLocaleDateString()} 审</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => window.print()} className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-700">
                    <Printer className="h-3.5 w-3.5" /> 打印/存PDF
                  </button>
                  <button onClick={exportWord} disabled={exportBusy}
                    className="flex items-center gap-1 rounded-lg bg-emerald-700 px-2.5 py-1.5 text-xs text-white hover:bg-emerald-600 disabled:opacity-50">
                    {exportBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />} 导出Word批注
                  </button>
                </div>
              </div>
              {/* R4: 总分+等级横幅 */}
              {(result.overallScore !== undefined || result.grade) && (
                <div className={cn("flex items-center justify-between rounded-lg border p-3",
                  (result.grade ?? "") === "A" || (result.overallScore ?? 0) >= 85 ? "border-green-500/40 bg-green-500/10"
                  : (result.grade ?? "") === "B" || (result.overallScore ?? 0) >= 70 ? "border-amber-500/40 bg-amber-500/10"
                  : "border-rose-500/40 bg-rose-500/10")}>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">总分 / 等级</p>
                    <p className="text-2xl font-bold text-slate-100">
                      {result.overallScore ?? "—"}<span className="ml-2 text-base font-semibold text-slate-300">{result.grade ? `等级 ${result.grade}` : ""}</span>
                    </p>
                  </div>
                  <p className="max-w-md text-right text-[11px] leading-relaxed text-slate-300">{result.overallComment || result.overall}</p>
                </div>
              )}
              {/* 维度评分卡 */}
              <div className="grid grid-cols-3 gap-2">
                {result.dimensions?.map((d) => (
                  <div key={d.key ?? d.name} className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-3">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                        {d.status && <span className={cn("inline-block h-1.5 w-1.5 rounded-full", d.status === "good" ? "bg-green-400" : d.status === "warning" ? "bg-amber-400" : "bg-rose-400")} />}
                        {d.name}
                      </span>
                      <span className={cn("text-sm font-bold", (d.score ?? 0) >= 80 ? "text-green-400" : (d.score ?? 0) >= 60 ? "text-amber-400" : "text-red-400")}>
                        {d.score ?? "—"}{d.maxScore ? `/${d.maxScore}` : ""}
                      </span>
                    </div>
                    {(d.summary || d.comment) && <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{d.summary || d.comment}</p>}
                    {d.issues?.length > 0 && (
                      <div className="mt-1.5 space-y-0.5">
                        {d.issues.slice(0, 3).map((iss, i) => {
                          if (typeof iss === "string") return <p key={i} className="text-[10px] text-rose-300/80">· {iss}</p>;
                          const sv = iss.severity === "major" ? "text-rose-300" : iss.severity === "minor" ? "text-amber-300" : "text-slate-400";
                          return <p key={i} className={cn("text-[10px]", sv)}>· [{iss.severity}] {iss.location && <span className="text-slate-500">({iss.location})</span>} {iss.suggestion || iss.originalText || ""}</p>;
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {/* 总评 */}
              <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-3">
                <p className="mb-1 text-xs font-semibold text-slate-300">总体评语与录用建议</p>
                <p className="text-xs leading-relaxed text-slate-300">{result.overall}</p>
              </div>
              {/* 大小修清单 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="mb-1.5 text-xs font-semibold text-rose-300">大修问题 ({result.majorIssues?.length ?? 0})</p>
                  {result.majorIssues?.map((m, i) => (
                    <div key={i} className="mb-1.5 rounded-lg border border-rose-500/20 bg-rose-500/5 p-2.5">
                      <p className="text-xs font-medium text-slate-200">{i + 1}. {m.title}</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{m.detail}</p>
                    </div>
                  ))}
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-semibold text-amber-300">小修问题 ({result.minorIssues?.length ?? 0})</p>
                  {result.minorIssues?.map((m, i) => (
                    <div key={i} className="mb-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5">
                      <p className="text-xs font-medium text-slate-200">{i + 1}. {m.title}</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{m.detail}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* R4: 亮点 + 首要建议 */}
              {(result.highlights?.length > 0 || result.topSuggestions?.length > 0) && (
                <div className="grid grid-cols-2 gap-3">
                  {result.highlights?.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-semibold text-emerald-300">论文亮点 ({result.highlights.length})</p>
                      {result.highlights.map((h, i) => (
                        <div key={i} className="mb-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2.5">
                          <p className="text-[11px] leading-relaxed text-slate-300">{h}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {result.topSuggestions?.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-semibold text-cyan-300">首要修改建议 ({result.topSuggestions.length})</p>
                      {result.topSuggestions.map((s, i) => (
                        <div key={i} className="mb-1.5 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-2.5">
                          <p className="text-[11px] leading-relaxed text-slate-300"><span className="mr-1 font-semibold text-cyan-300">{i + 1}.</span>{s}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* R4: 批注列表(annotations: type/dimension/highlightText/comment) */}
              {result.annotations?.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold text-rose-300">正文批注 ({result.annotations.length})</p>
                  <div className="max-h-64 space-y-1.5 overflow-y-auto">
                    {result.annotations.map((a) => (
                      <div key={a.id} className={cn("rounded-lg border p-2.5",
                        a.type === "error" ? "border-rose-500/30 bg-rose-500/5" : a.type === "warning" ? "border-amber-500/30 bg-amber-500/5" : "border-slate-600/40 bg-slate-800/40")}>
                        <div className="flex items-center gap-1.5">
                          <span className={cn("rounded px-1 py-0.5 text-[9px] font-bold uppercase", a.type === "error" ? "bg-rose-500/20 text-rose-300" : a.type === "warning" ? "bg-amber-500/20 text-amber-300" : "bg-slate-600/40 text-slate-300")}>{a.type}</span>
                          {a.dimension && <span className="text-[10px] text-slate-400">{a.dimension}</span>}
                        </div>
                        {a.highlightText && <p className="mt-1 border-l-2 border-slate-600 pl-2 text-[10px] italic leading-relaxed text-slate-500">"{a.highlightText}"</p>}
                        {a.comment && <p className="mt-1 text-[11px] leading-relaxed text-slate-300">{a.comment}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : !streamState && (
            <div className="mt-10 text-center">
              <CheckCircle2 className="mx-auto h-8 w-8 text-slate-600" />
              <p className="mt-2 text-xs text-slate-500">从"审稿记录"打开一个已完成任务, 或新建审稿</p>
            </div>
          )}
        </div>
      )}

      {tab === "journals" && (
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_340px] gap-3">
          <div className="min-h-0 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
            <p className="mb-2 text-xs font-semibold text-slate-300">期刊库 ({journals.length})</p>
            {journals.length === 0 && <p className="mt-6 text-center text-[11px] text-slate-500">还没有期刊, 右侧粘贴投稿须知 AI 解析入库</p>}
            {journals.map((j) => (
              <div key={j.id} className="mb-2 flex items-center justify-between rounded-lg border border-slate-700/50 bg-slate-800/50 p-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">{j.name} {j.user_id === null && <span className="text-[9px] text-slate-500">(公共)</span>}</p>
                  <p className="mt-0.5 text-[10px] text-slate-500">[{j.level}] {j.scope}{j.focus_count ? ` · ${j.focus_count} 审稿关注点` : ""}</p>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => delJournal(j.id)} className="rounded p-1 text-slate-500 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-300"><BookOpen className="h-3.5 w-3.5 text-purple-400" /> 投稿须知智能解析</p>
            <input value={jpName} onChange={(e) => setJpName(e.target.value)} placeholder="期刊名 (如: 中国社会科学)"
              className="mb-2 w-full rounded-lg border border-slate-600/60 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-500" />
            <textarea value={jpInput} onChange={(e) => setJpInput(e.target.value)} rows={10} placeholder="粘贴该刊投稿须知/作者指南原文 → AI 解析为格式规则/审稿关注点/引文规范"
              className="w-full resize-none rounded-lg border border-slate-600/60 bg-slate-800/70 px-2.5 py-2 text-xs text-slate-200 placeholder:text-slate-500" />
            <button onClick={parseJournal} disabled={parseBusy || !jpInput.trim() || !jpName.trim()}
              className="mt-2 w-full rounded-lg bg-purple-600 py-2 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50">
              {parseBusy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 inline h-3 w-3" />}AI 解析并入期刊库
            </button>
          </div>
        </div>
      )}

      {tab === "standards" && (
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_340px] gap-3">
          <div className="min-h-0 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
            <p className="mb-2 text-xs font-semibold text-slate-300">审核标准库 ({standards.length})</p>
            {standards.length === 0 && <p className="mt-6 text-center text-[11px] text-slate-500">还没有自定义标准, 右侧粘贴评分标准解析</p>}
            {standards.map((s) => (
              <div key={s.id} className="mb-2 flex items-center justify-between rounded-lg border border-slate-700/50 bg-slate-800/50 p-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">{s.name} {s.is_default && <span className="ml-1 rounded bg-cyan-500/20 px-1 py-0.5 text-[9px] text-cyan-300">默认</span>} {s.built_in && <span className="text-[9px] text-slate-500">(内置)</span>}</p>
                  <p className="mt-0.5 text-[10px] text-slate-500">{s.dimensions?.length ?? 0} 个维度: {(s.dimensions ?? []).map((d) => d.name).join("、").slice(0, 60)}</p>
                </div>
                <div className="flex items-center gap-1">
                  {!s.is_default && !s.built_in && (
                    <button onClick={() => setDefault(s.id)} className="rounded bg-slate-700 px-2 py-1 text-[10px] text-slate-200 hover:bg-slate-600">设默认</button>
                  )}
                  <button onClick={() => delStandard(s.id)} className="rounded p-1 text-slate-500 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-300"><ScrollText className="h-3.5 w-3.5 text-cyan-400" /> 评分标准解析</p>
            <input value={stdName} onChange={(e) => setStdName(e.target.value)} placeholder="标准名 (如: 社科论文通用审查标准)"
              className="mb-2 w-full rounded-lg border border-slate-600/60 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-500" />
            <textarea value={stdInput} onChange={(e) => setStdInput(e.target.value)} rows={10} placeholder="粘贴评分标准/审稿要点原文 → AI 解析为维度(名称/权重/细则)"
              className="w-full resize-none rounded-lg border border-slate-600/60 bg-slate-800/70 px-2.5 py-2 text-xs text-slate-200 placeholder:text-slate-500" />
            <button onClick={parseStandard} disabled={parseBusy || !stdInput.trim() || !stdName.trim()}
              className="mt-2 w-full rounded-lg bg-cyan-600 py-2 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50">
              {parseBusy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 inline h-3 w-3" />}AI 解析并入标准库
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
