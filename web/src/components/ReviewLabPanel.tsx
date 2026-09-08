// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ReviewLabPanel.tsx — SocialSci P0-3: 审稿实验室(在线科研审查)
// 形态对齐(闭源产品交互语义, 原创实现): 传稿→SSE 维度实时涌入→审稿报告(维度评分卡)→期刊/标准库
//   - 新建审稿: 粘贴全文(选期刊规则/审核标准) → SSE 流式(review.started/status/delta/completed)
//   - 报告: 维度评分卡 + 大小修清单 + 总体评语 + 打印/导出入口
//   - 期刊库: 投稿须知粘贴 → AI 解析入库; 标准库: 评分标准 → 维度解析/设默认
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen, CheckCircle2, ClipboardList, FileDown, FileText, Gavel, Loader2,
  PenLine, Plus, Printer, RefreshCw, ScrollText, Sparkles, Trash2,
} from "lucide-react";
import { readResume } from "./ResearchHistoryPanel";
import { ConfirmDialog, type ConfirmSpec } from "./ConfirmDialog";

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
    maxScore?: number; weight?: number; weightLabel?: number; status?: string; summary?: string;
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
  const [stdIds, setStdIds] = useState<string[]>([]);   // 审核标准多选(HAR: standardIds 数组语义)
  const [strictness, setStrictness] = useState("standard"); // 闭源值: lax/standard/strict
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
  const [askNew, setAskNew] = useState<ConfirmSpec | null>(null); // 新建审稿确认层(闭源对齐)
  const [askJournal, setAskJournal] = useState(false); // 手动新增期刊弹层开关
  const [curJob, setCurJob] = useState<string>("");
  // T3-3 原文对照: 稿件全文快照 + 报告子视图(report | diff)
  const [textSnap, setTextSnap] = useState<string>("");
  const [reportView, setReportView] = useState<"report" | "diff">("report");
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [expandedComment, setExpandedComment] = useState(false); // R1: 总评 >120 字折叠展开
  // 期刊/标准 modal
  const [jpInput, setJpInput] = useState("");   // 投稿须知原文
  const [jpName, setJpName] = useState("");
  const [jLevelFilter, setJLevelFilter] = useState(""); // W11: 期刊分类过滤 chips
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

  // 历史中心 deep-resume: 从历史记录 review 区卡点击跳入 → 自动打开对应审稿任务(切 jobs 视图)
  useEffect(() => {
    const r = readResume("review");
    if (r?.id) {
      setTab("jobs");
      void openJob(String(r.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          standardId: stdIds[0] || undefined,
          settings: { strictness, journalId: journalId || null, standardIds: stdIds, customRequirements: "" },
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
      const r = await j<{ job: { status: string; result: ReviewResult | null; text_snapshot?: string } }>(`/api/review/jobs/${jobId}`);
      if (r.job.text_snapshot) setTextSnap(r.job.text_snapshot);
      if (r.job.result) { setResult(r.job.result); setResolved(new Set()); setReportView("report"); setTab("report"); }
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

  // T6: 排版 HTML 报告(新窗口打印/存 PDF; 对齐闭源 export-report)
  const exportHtml = async () => {
    if (!curJob) return;
    setExportBusy(true); setErr("");
    try {
      const r = await j<{ ok: boolean; html?: string; error?: string }>(`/api/review/jobs/${curJob}/export-html`, { method: "POST", body: "{}" });
      if (!r.ok || !r.html) throw new Error(r.error || "生成失败");
      const win = window.open("", "_blank");
      if (!win) throw new Error("浏览器拦截了新窗口, 请允许弹窗");
      win.document.open();
      win.document.write(atob(r.html));
      win.document.close();
    } catch (e) { setErr((e as Error).message); } finally { setExportBusy(false); }
  };

  // B2(闭源 LibraryHome 前端正则 6 类归槽): 投稿须知 → 结构化规则(本机先解, AI 后端精修)
  const regexParseSubmissionGuide = (raw: string): { formatRules: string[]; reviewFocus: string[]; citationRules: string[]; scope: string } => {
    const rules = { formatRules: [] as string[], reviewFocus: [] as string[], citationRules: [] as string[], scope: "" };
    const lines = raw.split(/\n+/).map((l) => l.replace(/^\s*[-*·•]\s*/, "").trim()).filter(Boolean);
    for (const line of lines) {
      const t = line;
      if (/(\d+)\s*[-~～至到]\s*(\d+)\s*(字|词|字符)/i.test(t)) rules.formatRules.push(t);
      else if (/字数|页数|篇幅|不超过|不低于/.test(t)) rules.formatRules.push(t);
      else if (/引用|citation|gb\/t|apa|mla|chicago|参考文献|脚注|尾注/i.test(t)) rules.citationRules.push(t);
      else if (/风格|语气|人称|被动|主动|学术性/.test(t)) rules.formatRules.push(`风格要求: ${t}`);
      else if (/结构|章节|文献综述|方法论|结论|引言|摘要/.test(t)) rules.reviewFocus.push(t);
      else if (/盲审|匿名|英文|关键词|利益冲突|基金|声明/.test(t)) rules.formatRules.push(t);
      else if (/禁止|不得|不允许|不能|请勿/.test(t)) rules.formatRules.push(`禁止: ${t}`);
      else { rules.formatRules.push(t); }
    }
    // scope: 学科归类(简单启发)
    if (/经济|金融|管理|社会|政治|哲学|法学|教育|心理/.test(raw)) rules.scope = "社科";
    else if (/数学|物理|化学|生物|医学|工程|计算机/.test(raw)) rules.scope = "理工";
    else rules.scope = "";
    // 去重保序
    const dedupe = (a: string[]) => [...new Set(a)];
    rules.formatRules = dedupe(rules.formatRules).slice(0, 20);
    rules.citationRules = dedupe(rules.citationRules).slice(0, 10);
    rules.reviewFocus = dedupe(rules.reviewFocus).slice(0, 10);
    return rules;
  };

  // 期刊解析入库(B2: 前端正则先行, 无网/AI 降级也可用)
  const parseJournal = async () => {
    if (!jpInput.trim() || !jpName.trim()) { setErr("请填期刊名+粘贴投稿须知"); return; }
    setParseBusy(true); setErr("");
    try {
      const localRules = regexParseSubmissionGuide(jpInput);
      let parsed = localRules;
      try {
        const r = await j<{ parsed: { formatRules: string[]; reviewFocus: string[]; citationRules: string[]; scope: string } }>("/api/review/journals/parse", {
          method: "POST", body: JSON.stringify({ rawText: jpInput }),
        });
        // AI 结果更全则用; 失败保留本地正则结果
        if (r.parsed && (r.parsed.formatRules?.length || r.parsed.reviewFocus?.length)) {
          parsed = {
            formatRules: r.parsed.formatRules?.length ? r.parsed.formatRules : localRules.formatRules,
            reviewFocus: r.parsed.reviewFocus?.length ? r.parsed.reviewFocus : localRules.reviewFocus,
            citationRules: r.parsed.citationRules?.length ? r.parsed.citationRules : localRules.citationRules,
            scope: r.parsed.scope || localRules.scope,
          };
        }
      } catch { /* AI 解析失败 → 用本地正则结果 */ }
      await j("/api/review/journals", {
        method: "POST",
        body: JSON.stringify({ name: jpName.trim(), submissionGuideText: jpInput, parsedRules: parsed }),
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

  // 手动新增期刊(闭源 review/library "新增期刊" 弹层: 刊物名称+分类下拉7类+核心审稿要点"一行一条")
  const [njName, setNjName] = useState("");
  const [njLevel, setNjLevel] = useState("CSSCI");
  const [njFocus, setNjFocus] = useState("");
  const [njBusy, setNjBusy] = useState(false);
  const LEVELS = ["CSSCI", "北大核心", "SCI", "SSCI", "学位论文", "普通期刊", "其他"];
  const saveJournalManual = async () => {
    if (!njName.trim()) { setErr("请填刊物名称"); return; }
    setNjBusy(true); setErr("");
    try {
      const scope = njFocus.split("\n").map((l) => l.trim()).filter(Boolean).join(";");
      await j("/api/review/journals", {
        method: "POST",
        body: JSON.stringify({ name: njName.trim(), level: njLevel, scope, submissionGuideText: njFocus }),
      });
      setAskJournal(false); setNjName(""); setNjFocus(""); await loadAll();
    } catch (e) { setErr((e as Error).message); } finally { setNjBusy(false); }
  };

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
            <button key={k} onClick={() => {
              // 新建审稿确认层(闭源: "开始新的审稿?当前审稿状态将清除。" — 已有报告/进行中任务时先确认)
              if (k === "new" && tab !== "new" && (result || curJob)) {
                setAskNew({ title: "新建审稿", desc: "开始新的审稿？当前审稿状态将清除。", confirmText: "确认", danger: false });
                return;
              }
              setTab(k);
            }}
              className={cn("flex items-center gap-1 rounded-md px-2.5 py-1 text-xs", tab === k ? "bg-slate-600 text-white" : "text-slate-400 hover:text-slate-200")}>
              {ic}{label}
            </button>
          ))}
        </div>
      </div>

      <ConfirmDialog spec={askNew} onDone={(ok) => { setAskNew(null); if (ok) { setResult(null); setCurJob(""); setTab("new"); } }} />
      {askJournal && <div className="hidden" /> /* 新增期刊弹层渲染位 */}

      {/* 新增期刊弹层(闭源 review/library: 刊物名称必填 + 分类下拉 7 类 + 核心审稿要点一行一条) */}
      {askJournal && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={() => setAskJournal(false)}>
          <div className="w-full max-w-md rounded-xl border border-slate-600/60 bg-slate-900 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold text-slate-100">新增期刊要求</p>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">刊物名称 *</label>
                  <input value={njName} onChange={(e) => setNjName(e.target.value)} placeholder="如: 中国社会科学"
                    className="w-full rounded-lg border border-slate-600/60 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-500" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">分类 *</label>
                  <select value={njLevel} onChange={(e) => setNjLevel(e.target.value)}
                    className="w-full rounded-lg border border-slate-600/60 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200">
                    {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">核心审稿要点</label>
                <textarea value={njFocus} onChange={(e) => setNjFocus(e.target.value)} rows={4}
                  placeholder={"一行一条，AI 会自动识别字数、格式、风格等要素\n\n如:\n正文 8000-12000 字\n需有摘要与关键词\n实证方法须交代数据来源"}
                  className="w-full resize-none rounded-lg border border-slate-600/60 bg-slate-800/70 px-2.5 py-2 text-xs text-slate-200 placeholder:text-slate-500" />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setAskJournal(false)} className="rounded-lg border border-slate-600/60 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700">取消</button>
              <button onClick={saveJournalManual} disabled={njBusy || !njName.trim()}
                className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50">
                {njBusy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : null}保存
              </button>
            </div>
          </div>
        </div>
      )}

      {err && <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{err}</div>}

      {tab === "new" && (
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_240px] gap-3">
          <div className="flex min-h-0 flex-col rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
            {/* 上传或粘贴 */}
            <div className="mb-2 flex items-center justify-between rounded-lg border border-dashed border-slate-600 bg-slate-800/40 px-3 py-2">
              <span className="text-[10px] text-slate-500">{upBusy ? "提取中…" : "上传 Word/TXT → 自动提取正文"}</span>
              <button onClick={() => fileRef.current?.click()} disabled={upBusy} data-control="review_upload"
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
                className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50" data-control="review_start">
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
              <p className="mb-1.5 font-semibold text-slate-300">选用审核标准 <span className="text-[9px] text-slate-500">(多选合并维度, 可不用)</span></p>
              {standards.length === 0 && <p className="mb-1 text-[10px] text-slate-600">标准库为空 → 默认 7 维社科审稿</p>}
              <div className="flex flex-wrap gap-1.5">
                {standards.map((s) => {
                  const on = stdIds.includes(s.id);
                  return (
                    <button key={s.id} onClick={() => setStdIds((prev) => (on ? prev.filter((x) => x !== s.id) : [...prev, s.id]))}
                      className={cn("rounded-full border px-2.5 py-1 text-[10px] transition",
                        on ? "border-rose-500/60 bg-rose-600/20 text-rose-200"
                          : "border-slate-600/60 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200")}>
                      {s.name}{s.is_default ? " ★" : ""}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-500">多选时合并各标准维度去重, 未选=默认 7 维社科(选题与意义/文献综述与分析框架/研究方法与数据/实证分析/对策建议/写作规范与格式/逻辑结构)</p>
            </div>
            <div>
              <p className="mb-1.5 flex items-center justify-between font-semibold text-slate-300">审查严格度
                <span className={cn("rounded px-1.5 py-0.5 text-[10px]", strictness === "strict" ? "bg-rose-500/20 text-rose-300" : strictness === "standard" ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300")}>
                  {strictness === "lax" ? "宽松 · 仅重大问题" : strictness === "standard" ? "标准 · 核心问题" : "严格 · 逐项检查"}
                </span>
              </p>
              {/* B5(闭源 review radio 三档): 宽松/标准/严格 radio 组(替代 range slider) */}
              <div className="flex gap-1.5">
                {([["lax", "宽松", "仅重大问题"], ["standard", "标准", "核心问题"], ["strict", "严格", "逐项检查"]] as Array<["lax" | "standard" | "strict", string, string]>).map(([v, label, sub]) => (
                  <label key={v} onClick={() => setStrictness(v)}
                    className={cn("flex-1 cursor-pointer rounded-lg border px-2 py-1.5 text-center transition",
                      strictness === v
                        ? v === "strict" ? "border-rose-500/60 bg-rose-500/15" : v === "standard" ? "border-amber-500/60 bg-amber-500/15" : "border-emerald-500/60 bg-emerald-500/15"
                        : "border-slate-700/50 bg-slate-800/40 hover:border-slate-500")}>
                    <input type="radio" name="strictness" value={v} checked={strictness === v} onChange={() => setStrictness(v)} className="sr-only" data-control="review_strictness" />
                    <p className={cn("text-[10px] font-medium", strictness === v ? (v === "strict" ? "text-rose-200" : v === "standard" ? "text-amber-200" : "text-emerald-200") : "text-slate-300")}>{label}</p>
                    <p className="text-[8px] text-slate-500">{sub}</p>
                  </label>
                ))}
              </div>
              <p className="mt-0.5 text-[9px] text-slate-600">严格度影响判分尺度和问题发现密度</p>
            </div>
            <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-2 text-[10px] leading-relaxed text-slate-500">
              <p className="mb-1 font-semibold text-slate-400">审稿输出</p>
              <p>· 分段流式审阅(每段问题实时推送)</p>
              <p>· 聚合生成维度评分卡(社科 7 维: 选题/文献/方法/实证/对策/写作/逻辑)</p>
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
                        <span className={cn("text-[10px] font-medium", dd.status === "good" || dd.status === "pass" ? "text-green-300" : dd.status === "warning" ? "text-amber-300" : "text-rose-300")}>
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
              {/* T3-3: 报告 | 原文对照 子页签 */}
              <div className="flex items-center gap-1">
                <button onClick={() => setReportView("report")}
                  className={cn("rounded-lg px-3 py-1 text-[11px]", reportView === "report" ? "bg-rose-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200")}>审稿报告</button>
                <button onClick={() => setReportView("diff")}
                  className={cn("flex items-center gap-1 rounded-lg px-3 py-1 text-[11px]", reportView === "diff" ? "bg-rose-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200")}>
                  <ScrollText className="h-3 w-3" />原文对照{result.annotations?.length ? <span className="rounded-full bg-rose-500/30 px-1 text-[9px]">{result.annotations.length}</span> : null}
                </button>
              </div>
              {reportView === "diff" && (
                <ReviewDiffView
                  text={textSnap || ""}
                  annotations={result.annotations ?? []}
                  resolved={resolved}
                  onToggle={(id) => setResolved((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
                />
              )}
              {reportView === "report" && (<>
              {/* 报告头 */}
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-slate-100">{result.paperTitle}</h3>
                  <p className="text-[11px] text-slate-500">全文 {result.wordCount} 字 · {result.dimensions?.length ?? 0} 个维度审查 · 发现 {result.segmentIssues ?? 0} 处问题 · {new Date().toLocaleDateString()} 审</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => window.print()} className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-700">
                    <Printer className="h-3.5 w-3.5" /> 打印/存PDF
                  </button>
                  <button data-control="review_export_word" onClick={exportWord} disabled={exportBusy}
                    className="flex items-center gap-1 rounded-lg bg-emerald-700 px-2.5 py-1.5 text-xs text-white hover:bg-emerald-600 disabled:opacity-50">
                    {exportBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />} 导出Word批注
                  </button>
                  <button onClick={() => void exportHtml()} disabled={exportBusy || !curJob}
                    className="flex items-center gap-1 rounded-lg bg-cyan-700 px-2.5 py-1.5 text-xs text-white hover:bg-cyan-600 disabled:opacity-50">
                    {exportBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScrollText className="h-3.5 w-3.5" />} 排版HTML报告
                  </button>
                </div>
              </div>
              {/* R4: 总分+等级横幅(闭源: 大数字总分 + 徽标等级 如 "C") */}
              {(result.overallScore !== undefined || result.grade) && (
                <div className={cn("flex items-center justify-between rounded-lg border p-3",
                  (result.grade ?? "") === "A" || (result.overallScore ?? 0) >= 85 ? "border-green-500/40 bg-green-500/10"
                  : (result.grade ?? "") === "B" || (result.overallScore ?? 0) >= 70 ? "border-amber-500/40 bg-amber-500/10"
                  : "border-rose-500/40 bg-rose-500/10")}>
                  <div className="flex items-center gap-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">总分</p>
                      <p className="text-2xl font-bold text-slate-100">{result.overallScore ?? "—"}</p>
                    </div>
                    {/* P-B: 闭源等级徽标(等级字母大卡 + 及格/良好判词) */}
                    {(result.grade ?? "") !== "" && (
                      <div className="rounded-lg bg-slate-900/60 px-2.5 py-1 text-center">
                        <p className="text-lg font-black leading-none text-slate-100">{result.grade}</p>
                        <p className="mt-0.5 text-[8px] text-slate-400">
                          {/* 闭源等级表(ReviewView 源码): A+=优秀/A=优秀/B+=良好/B=良好/C+=及格/C=及格/D=待改进/其他一般 */}
                          {{ "A+": "优秀", A: "优秀", "B+": "良好", B: "良好", "C+": "及格", C: "及格", D: "待改进" }[result.grade ?? ""] ?? "一般"}
                        </p>
                      </div>
                    )}
                  </div>
                  <p className="text-right text-[10px] leading-relaxed text-slate-500">字数: {result.wordCount?.toLocaleString() ?? "—"} · {result.dimensions?.length ?? 0} 个维度审查</p>
                </div>
              )}

              {/* R1(闭源 ReviewResult): 总评 >120 字折叠 + 展开完整评语/收起评语红链 */}
              {(() => {
                const oc = result.overallComment || result.overall || "";
                const long = oc.length > 120;
                return oc && (
                  <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-3">
                    <p className="text-[11px] leading-relaxed whitespace-pre-wrap text-slate-300">{expandedComment ? oc : long ? oc.slice(0, 120) + "…" : oc}</p>
                    {long && (
                      <button onClick={() => setExpandedComment((v) => !v)} className="mt-1 text-[10px] text-rose-400 hover:text-rose-300">
                        {expandedComment ? "收起评语" : "展开完整评语"}
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* P-B: 核心问题分级计数(闭源报告: 严重/中等/建议 + 共 N 个) */}
              {(() => {
                type IssueEl = string | { id: string; severity: string; location: string; originalText: string; suggestion?: string };
                // 守卫: 非字符串即对象(issues 联合由后端保证 shape)
                const all = (result.dimensions ?? []).flatMap((d) => Array.isArray(d.issues) ? d.issues.filter((i): i is Exclude<IssueEl, string> => typeof i !== "string") : []);
                const sev = all.filter((i) => i.severity === "major").length;
                const mid = all.filter((i) => i.severity === "minor").length;
                const sug = all.filter((i) => i.severity !== "major" && i.severity !== "minor").length;
                return all.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-700/40 bg-slate-800/30 px-3 py-2">
                    <p className="text-[10px] font-semibold text-slate-300">核心问题 (共 {all.length} 个)</p>
                    {sev > 0 && <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[9px] font-semibold text-rose-300">严重 {sev}</span>}
                    {mid > 0 && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-semibold text-amber-300">中等 {mid}</span>}
                    {sug > 0 && <span className="rounded-full bg-slate-600/30 px-2 py-0.5 text-[9px] font-semibold text-slate-300">建议 {sug}</span>}
                    <button onClick={() => setReportView("diff")} className="ml-auto flex items-center gap-1 rounded border border-slate-600/50 px-2 py-0.5 text-[9px] text-slate-300 hover:border-rose-500/40 hover:text-rose-300">
                      <ScrollText className="h-2.5 w-2.5" />进入原文对照
                    </button>
                  </div>
                ) : null;
              })()}
              {/* 维度评分卡(闭源 ReviewResult 对齐: status 通过/待改进/不通过 + 进度条) */}
              <div className="grid grid-cols-3 gap-2">
                {result.dimensions?.map((d) => {
                  const st = d.status === "warning" ? "warning" : d.status === "fail" ? "fail" : d.status === "pass" ? "pass" : (d.score ?? 0) >= 80 ? "pass" : (d.score ?? 0) >= 60 ? "warning" : "fail";
                  const stText = { pass: "通过", warning: "待改进", fail: "不通过" }[st] ?? "";
                  return (
                  <div key={d.key ?? d.name} className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-3">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                        {d.name}
                        {/* 闭源权重整档(权重 3-5) */}
                        {d.weightLabel !== undefined && <span className="rounded bg-slate-700/70 px-1 text-[8px] font-normal text-slate-400">权重 {d.weightLabel}</span>}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className={cn("text-sm font-bold", (d.score ?? 0) >= 80 ? "text-green-400" : (d.score ?? 0) >= 60 ? "text-amber-400" : "text-red-400")}>
                          {d.score ?? "—"}{d.maxScore ? `/${d.maxScore}` : ""}
                        </span>
                        {stText && <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-medium", st === "pass" ? "bg-green-500/15 text-green-300" : st === "warning" ? "bg-amber-500/15 text-amber-300" : "bg-red-500/15 text-red-300")}>{stText}</span>}
                      </span>
                    </div>
                    {/* 闭源进度条: score≥80 绿/≥60 琥珀/红, width=score% */}
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800">
                      <div className={cn("h-full rounded-full transition-all duration-700", (d.score ?? 0) >= 80 ? "bg-green-500" : (d.score ?? 0) >= 60 ? "bg-amber-500" : "bg-red-500")}
                        style={{ width: `${Math.min(100, Math.max(0, d.score ?? 0))}%` }} />
                    </div>
                    {(d.summary || d.comment) && <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">{d.summary || d.comment}</p>}
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
                ); })}
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
              {(() => { const hl = result.highlights ?? []; const ts = result.topSuggestions ?? []; return (hl.length > 0 || ts.length > 0) && (
                <div className="grid grid-cols-2 gap-3">
                  {hl.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-semibold text-emerald-300">论文亮点 ({hl.length})</p>
                      {hl.map((h, i) => (
                        <div key={i} className="mb-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2.5">
                          <p className="text-[11px] leading-relaxed text-slate-300">{h}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {ts.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-semibold text-cyan-300">首要修改建议 ({ts.length})</p>
                      {ts.map((s, i) => (
                        <div key={i} className="mb-1.5 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-2.5">
                          <p className="text-[11px] leading-relaxed text-slate-300"><span className="mr-1 font-semibold text-cyan-300">{i + 1}.</span>{s}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ); })()}

              {/* R4: 批注列表(annotations: type/dimension/highlightText/comment) */}
              {result.annotations!.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold text-rose-300">正文批注 ({result.annotations!.length})</p>
                  <div className="max-h-64 space-y-1.5 overflow-y-auto">
                    {result.annotations!.map((a) => (
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
            </>)}
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
            <p className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-300">
              <span>期刊库 ({journals.length})</span>
              {/* 闭源 review/library: 新增期刊(名称+分类下拉+核心审稿要点一行一条) */}
              <button onClick={() => setAskJournal(true)} data-control="review_add_journal"
                className="flex items-center gap-1 rounded-md bg-purple-600/20 px-2 py-0.5 text-[10px] font-medium text-purple-300 hover:bg-purple-600/30">
                <Plus className="h-3 w-3" />新增期刊
              </button>
            </p>
            {/* W11(闭源审稿库实拍): 分类 chips 过滤(全部/CSSCI/北大核心/SCI/SSCI/学位论文/普通期刊/其他) */}
            <div className="mb-2 flex flex-wrap gap-1">
              {["", "CSSCI", "北大核心", "SCI", "SSCI", "学位论文", "普通期刊", "其他"].map((c) => (
                <button key={c || "all"} onClick={() => setJLevelFilter(c)}
                  className={cn("rounded-full border px-2 py-0.5 text-[9px]", jLevelFilter === c ? "border-rose-500/60 bg-rose-500/15 text-rose-300" : "border-slate-600/50 bg-slate-800/60 text-slate-400 hover:text-slate-200")}>
                  {c || "全部分类"}
                </button>
              ))}
            </div>
            {journals.length === 0 && <p className="mt-6 text-center text-[11px] text-slate-500">还没有期刊, 右侧粘贴投稿须知 AI 解析入库</p>}
            {journals.filter((j) => !jLevelFilter || (j.level ?? "") === jLevelFilter).map((j) => (
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

// ═══ T3-3: 审稿原文对照(左=稿件原文+命中高亮标号 / 右=问题抽屉勾销) ═══
function ReviewDiffView({ text, annotations, resolved, onToggle }: {
  text: string;
  annotations: Array<{ id: string; type: string; dimension: string; highlightText: string; comment: string }>;
  resolved: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const anns = annotations.filter((a) => a.highlightText);
  if (!text && !anns.length) return <p className="py-10 text-center text-xs text-slate-600">无原文快照与批注</p>;
  // 原文按段拆分, 段落内命中 highlightText 则高亮(B4: 空白归一化双索引匹配 —
  // 两端抹掉空白定位再映射回原串坐标, 修复"引文原文与批注文本间空白/换行差异"导致的漏标)
  const paras = (text || "(无原文快照)").split(/\n{1,}/).filter((p) => p.trim());
  const normOf = (s: string) => s.replace(/\s+/g, "");
  const markPara = (p: string) => {
    const pNorm = normOf(p);
    const hits = anns
      .map((a, i) => {
        const t = a.highlightText.trim();
        const tn = normOf(t);
        // 先试原文直找(带空白), 失败再走归一化映射
        let idx = p.indexOf(t);
        let len = t.length;
        if (idx < 0 && tn.length >= 4) {
          const ni = pNorm.indexOf(tn);
          if (ni >= 0) {
            // 归一化坐标 → 原串坐标(数原串在归一化位置前的非空白字符数)
            let count = 0, orig = 0;
            while (orig < p.length && count < ni) { if (!/\s/.test(p[orig])) count++; orig++; }
            let end = orig;
            const targetEnd = ni + tn.length;
            while (end < p.length && count < targetEnd) { if (!/\s/.test(p[end])) count++; end++; }
            idx = orig; len = end - orig;
          }
        }
        return idx >= 0 && t.length >= 6 ? { i, idx, len, a } : null;
      })
      .filter((x): x is { i: number; idx: number; len: number; a: (typeof anns)[0] } => !!x)
      .sort((x, y) => x.idx - y.idx);
    if (!hits.length) return <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-slate-300">{p}</p>;
    const segs: Array<React.ReactNode> = [];
    let cursor = 0;
    const used = new Set<number>();
    for (const h of hits) {
      if (h.idx < cursor || used.has(h.i)) continue;
      used.add(h.i);
      if (h.idx > cursor) segs.push(<span key={`t${cursor}`}>{p.slice(cursor, h.idx)}</span>);
      const end = Math.min(p.length, h.idx + h.len);
      const hlText = p.slice(h.idx, end);
      segs.push(
        <button key={`h${h.i}`} onClick={() => setActive(active === anns[h.i].id ? null : anns[h.i].id)}
          title={anns[h.i].comment}
          className={cn("mx-0.5 rounded border-b-2 px-0.5 text-[11px] leading-relaxed",
            resolved.has(anns[h.i].id) ? "border-slate-600 text-slate-400 line-through" : "border-rose-400 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20",
            active === anns[h.i].id && "bg-rose-500/30")}>
          {hlText}
          <sup className="ml-0.5 text-[8px] text-rose-300">{h.i + 1}</sup>
        </button>
      );
      cursor = end;
    }
    if (cursor < p.length) segs.push(<span key={`t${cursor}`}>{p.slice(cursor)}</span>);
    return <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-slate-300">{segs}</p>;
  };
  return (
    <div className="grid h-[520px] min-h-0 grid-cols-2 gap-3">
      {/* 左: 原文 */}
      <div className="min-h-0 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-950/60 p-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">稿件原文 · 点击高亮查看问题</p>
        {paras.map((p, i) => <div key={i} className="mb-2">{markPara(p)}</div>)}
      </div>
      {/* 右: 问题抽屉 */}
      <div className="flex min-h-0 flex-col rounded-xl border border-slate-700/60 bg-slate-900/60">
        <p className="border-b border-slate-700/40 px-3 py-1.5 text-[10px] font-semibold text-slate-400">
          问题清单 ({anns.length}) · {resolved.size} 已解决
        </p>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
          {anns.map((a, i) => (
            <div key={a.id} className={cn("rounded-lg border p-2 transition", active === a.id ? "border-rose-500/50 bg-rose-500/5" : resolved.has(a.id) ? "border-slate-700/40 bg-slate-800/30 opacity-60" : "border-slate-700/50 bg-slate-800/50")}>
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-bold text-slate-500">{i + 1}</span>
                <span className={cn("rounded px-1 py-0.5 text-[8px] font-bold uppercase", a.type === "error" ? "bg-rose-500/20 text-rose-300" : a.type === "warning" ? "bg-amber-500/20 text-amber-300" : "bg-slate-600/40 text-slate-300")}>{a.type}</span>
                {a.dimension && <span className="text-[9px] text-slate-500">{a.dimension}</span>}
                <button onClick={() => onToggle(a.id)}
                  className={cn("ml-auto flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px]", resolved.has(a.id) ? "bg-emerald-600/20 text-emerald-300" : "bg-slate-700 text-slate-400 hover:text-slate-200")}>
                  <CheckCircle2 className="h-2.5 w-2.5" />{resolved.has(a.id) ? "已解决" : "标已解决"}
                </button>
              </div>
              <p className="mt-1 border-l-2 border-slate-600 pl-2 text-[10px] italic leading-relaxed text-slate-400">"{a.highlightText}"</p>
              {a.comment && <p className="mt-1 text-[10px] leading-relaxed text-slate-300">{a.comment}</p>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
