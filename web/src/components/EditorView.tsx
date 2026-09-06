// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// EditorView.tsx — SocialSci P0-5: 在线学术文本编辑器(学术编辑器)
// 形态对齐(闭源产品交互语义, 原创实现): 文档列表/双栏编辑(markdown+预览)/选区改写5模式+humanize/
//   全文一致性检查/图表代码插入/自动保存+锁心跳/字数
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlignLeft, BarChart3, CheckCircle2, ChevronLeft, ClipboardCheck, Download,
  Eye, FileText, ImageIcon, Loader2, Lock, Pencil, Plus, Save, Search,
  Sparkles, Trash2, Wand2, X,
} from "lucide-react";

interface DocLite { id: string; title: string; word_count: number; status: string; updated_at: string; }
interface RewriteResult { text: string; }
interface CheckResult { checks: Array<{ name: string; ok: boolean; findings: string[] }>; }

const REWRITE_MODES: Array<{ key: string; label: string; desc: string }> = [
  { key: "polish", label: "学术润色", desc: "优化用词与句式" },
  { key: "condense", label: "压缩冗余", desc: "删重复/空泛, 缩短30-40%" },
  { key: "de-template", label: "去除模板化", desc: "消除口号/套路表达" },
  { key: "proofread", label: "修正语病", desc: "错别字/语病/标点" },
  { key: "journal-style", label: "期刊风格", desc: "中文核心期刊表达" },
  { key: "humanize", label: "消除AI痕迹", desc: "行文更接近人类学者" },
];

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

export function EditorView() {
  const [docs, setDocs] = useState<DocLite[]>([]);
  const [curId, setCurId] = useState<string | null>(null);
  const [title, setTitle] = useState("未命名文档");
  const [content, setContent] = useState("");
  const [wordCount, setWordCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [view, setView] = useState<"edit" | "split" | "preview">("split");
  const [selText, setSelText] = useState("");
  const [rewriting, setRewriting] = useState("");
  const [rewriteBox, setRewriteBox] = useState<{ original: string; result: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  const [chartDesc, setChartDesc] = useState("");
  const [chartBusy, setChartBusy] = useState(false);
  const [chartArt, setChartArt] = useState<{ pngRel: string; code: string } | null>(null);
  const [showChart, setShowChart] = useState(false);
  // UI审计T5: AI右侧常驻面板
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [lockedBy, setLockedBy] = useState("");
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const curIdRef = useRef<string | null>(null);
  curIdRef.current = curId;
  const contentRef = useRef("");
  contentRef.current = content;

  const flash = (m: string) => { setOkMsg(m); setTimeout(() => setOkMsg(""), 2500); };

  const loadDocs = useCallback(async () => {
    try { const r = await j<{ documents: DocLite[] }>("/api/editor/v1/documents"); setDocs(r.documents ?? []); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void loadDocs(); }, [loadDocs]);

  const openDoc = async (id: string) => {
    setBusy(true); setErr("");
    try {
      const r = await j<{ document: { title: string; content: string; word_count: number; locked_by: string } }>(`/api/editor/v1/documents/${id}`);
      setCurId(id); setTitle(r.document.title); setContent(r.document.content);
      setWordCount(r.document.word_count); setLockedBy(r.document.locked_by);
      setRewriteBox(null); setCheckResult(null); setChartArt(null);
      // 持锁 + 心跳(编辑会话; 每 30s 续, 5min 超时自动放)
      await j(`/api/editor/v1/documents/${id}/lock`, { method: "POST", body: "{}" });
      setLockedBy(`user:${tokenOf().slice(0, 6)}`);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = setInterval(() => {
        if (curIdRef.current) void j(`/api/editor/v1/documents/${curIdRef.current}/lock`, { method: "POST", body: "{}" }).catch(() => {});
      }, 30_000);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const newDoc = async () => {
    setBusy(true); setErr("");
    try {
      const t = window.prompt("文档标题:", "未命名论文");
      const r = await j<{ id: string }>("/api/editor/v1/documents", { method: "POST", body: JSON.stringify({ title: t ?? "未命名文档" }) });
      await loadDocs();
      await openDoc(r.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const saveNow = async () => {
    if (!curId) return;
    setSaving(true);
    try {
      const r = await j<{ wordCount: number }>(`/api/editor/v1/documents/${curId}`, {
        method: "PUT", body: JSON.stringify({ title, content }),
      });
      setWordCount(r.wordCount);
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };

  const onContentChange = (v: string) => {
    setContent(v);
    setWordCount(v.replace(/\s/g, "").length);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveNow(), 1500); // 自动保存防抖
  };

  const removeDoc = async (id: string) => {
    if (!window.confirm("删除文档?")) return;
    try {
      await j(`/api/editor/v1/documents/${id}`, { method: "DELETE" });
      if (curId === id) { setCurId(null); setContent(""); setTitle(""); }
      await loadDocs();
    } catch (e) { setErr((e as Error).message); }
  };

  // 选区改写: 取 textarea 选中文本
  const grabSelection = () => {
    const ta = taRef.current;
    if (!ta) return "";
    const s = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    return s.trim();
  };

  const doRewrite = async (mode: string) => {
    const sel = selText || grabSelection();
    if (!sel) { setErr("请先在正文中选中一段文字, 再选择改写方式"); return; }
    setRewriting(mode); setErr("");
    try {
      const r = await j<RewriteResult>("/api/editor/v1/rewrite", {
        method: "POST", body: JSON.stringify({ mode, text: sel }),
      });
      setRewriteBox({ original: sel, result: r.text });
    } catch (e) { setErr((e as Error).message); } finally { setRewriting(""); }
  };

  const applyRewrite = () => {
    if (!rewriteBox || !taRef.current) return;
    const ta = taRef.current;
    const s = ta.value;
    const start = s.indexOf(rewriteBox.original);
    if (start >= 0) {
      const next = s.slice(0, start) + rewriteBox.result + s.slice(start + rewriteBox.original.length);
      onContentChange(next);
      flash("已替换改写结果");
    }
    setRewriteBox(null);
  };

  const doCheck = async () => {
    if (!content.trim()) { setErr("全文为空"); return; }
    setChecking(true); setErr("");
    try {
      const r = await j<CheckResult>("/api/editor/v1/check-fulltext", { method: "POST", body: JSON.stringify({ text: content }) });
      setCheckResult(r); setShowCheck(true);
    } catch (e) { setErr((e as Error).message); } finally { setChecking(false); }
  };

  // 图表代码 → 渲染 → 插入
  const doChart = async () => {
    if (!chartDesc.trim()) { setErr("请描述图表需求"); return; }
    setChartBusy(true); setErr("");
    try {
      const r = await j<{ pngRel: string; code: string }>("/api/editor/v1/chart-code", {
        method: "POST", body: JSON.stringify({ description: chartDesc }),
      });
      setChartArt({ pngRel: r.pngRel, code: r.code });
    } catch (e) { setErr((e as Error).message); } finally { setChartBusy(false); }
  };

  const insertChartMd = () => {
    if (!chartArt) return;
    const md = `\n\n![图表](/api/viz/files/${chartArt.pngRel})\n\n`;
    onContentChange(content + md);
    setShowChart(false); setChartArt(null); setChartDesc("");
    flash("图表已插入正文");
  };

  // 清理锁(卸载)
  useEffect(() => {
    return () => {
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      if (curIdRef.current) void j(`/api/editor/v1/documents/${curIdRef.current}/unlock`, { method: "POST", body: "{}" }).catch(() => {});
    };
  }, []);

  const wordCountNice = wordCount >= 10000 ? `${(wordCount / 10000).toFixed(1)} 万` : String(wordCount);

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      {/* 顶栏 */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-indigo-400" />
          <h2 className="text-base font-bold text-slate-100">学术编辑器</h2>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">SocialSci 对齐</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-slate-800/80 p-0.5">
            {([["edit", "编辑", <Pencil key="i" className="h-3 w-3" />], ["split", "双栏", <AlignLeft key="i" className="h-3 w-3" />], ["preview", "预览", <Eye key="i" className="h-3 w-3" />]] as Array<[string, string, React.ReactNode]>).map(([k, label, ic]) => (
              <button key={k} onClick={() => setView(k as never)}
                className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-[11px]", view === k ? "bg-slate-600 text-white" : "text-slate-400 hover:text-slate-200")}>
                {ic}{label}
              </button>
            ))}
          </div>
          <button onClick={() => setShowCheck((v) => !v)} disabled={checking}
            className="flex items-center gap-1 rounded-lg bg-amber-600 px-2.5 py-1.5 text-xs text-white hover:bg-amber-500 disabled:opacity-50">
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />}全文检查
          </button>
          <button onClick={() => setShowChart((v) => !v)}
            className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs text-white hover:bg-indigo-500">
            <BarChart3 className="h-3.5 w-3.5" />图表
          </button>
          <button onClick={() => setShowAiPanel((v) => !v)}
            className={cn("flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs", showAiPanel ? "bg-slate-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700")}>
            <Sparkles className="h-3.5 w-3.5" /> AI面板
          </button>
          <button onClick={() => void newDoc()} className="flex items-center gap-1 rounded-lg bg-cyan-600 px-2.5 py-1.5 text-xs text-white hover:bg-cyan-500">
            <Plus className="h-3.5 w-3.5" />新建文档
          </button>
        </div>
      </div>

      {(err || okMsg) && (
        <div className={cn("mb-2 flex items-center justify-between rounded-lg px-3 py-1.5 text-xs", err ? "border border-red-500/30 bg-red-500/10 text-red-300" : "border border-green-500/30 bg-green-500/10 text-green-300")}>
          <span>{err || okMsg}</span>
          <button onClick={() => { setErr(""); setOkMsg(""); }}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className={cn("grid min-h-0 flex-1 gap-3", showAiPanel ? "grid-cols-[200px_1fr_280px]" : "grid-cols-[200px_1fr]")}>
        {/* 文档列表 */}
        <div className="flex min-h-0 flex-col overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-2">
          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase text-slate-500">我的文档 ({docs.length})</p>
          {docs.length === 0 && <p className="px-1 text-[11px] text-slate-600">暂无文档</p>}
          {docs.map((d) => (
            <div key={d.id} className={cn("group mb-1 cursor-pointer rounded-lg px-2 py-1.5", curId === d.id ? "bg-indigo-600/20 text-indigo-200" : "hover:bg-slate-800 text-slate-300")}>
              <div className="flex items-center justify-between">
                <p className="truncate text-[11px] font-medium" onClick={() => openDoc(d.id)}>{d.title}</p>
                <button onClick={() => removeDoc(d.id)} className="hidden text-slate-500 hover:text-red-400 group-hover:block"><Trash2 className="h-3 w-3" /></button>
              </div>
              <p className="text-[9px] text-slate-500">{d.word_count} 字 · {new Date(d.updated_at).toLocaleDateString()}</p>
            </div>
          ))}
        </div>

        {/* 编辑器主区 */}
        {!curId ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-slate-700/60 bg-slate-900/50">
            <FileText className="h-12 w-12 text-slate-700" />
            <p className="mt-3 text-sm text-slate-500">选择或新建一个文档开始写作</p>
            <button onClick={() => void newDoc()} className="mt-3 rounded-lg bg-cyan-600 px-4 py-2 text-xs text-white hover:bg-cyan-500">新建文档</button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col rounded-xl border border-slate-700/60 bg-slate-900/50">
            {/* 文档工具条 */}
            <div className="flex items-center justify-between border-b border-slate-700/50 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <button onClick={() => setCurId(null)} className="text-slate-400 hover:text-slate-200"><ChevronLeft className="h-4 w-4" /></button>
                <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void saveNow()}
                  className="w-64 rounded border border-transparent bg-transparent px-1 text-sm font-semibold text-slate-100 hover:border-slate-600 focus:border-slate-500 focus:bg-slate-800" />
                {lockedBy && <Lock className="h-3 w-3 text-amber-400" />}
              </div>
              <div className="flex items-center gap-2 text-[10px] text-slate-500">
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                <span>{wordCountNice} 字</span>
                <button onClick={() => void saveNow()} className="flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700">
                  <Save className="h-3 w-3" />保存
                </button>
              </div>
            </div>

            {/* 编辑区 */}
            <div className={cn("min-h-0 flex-1", view === "edit" ? "flex" : view === "preview" ? "flex" : "grid grid-cols-2")}>
              {view !== "preview" && (
                <div className="relative flex min-h-0 min-w-0 flex-col border-r border-slate-700/40">
                  <textarea ref={taRef} value={content}
                    onChange={(e) => onContentChange(e.target.value)}
                    onMouseUp={() => setSelText(grabSelection())}
                    onKeyUp={() => setSelText(grabSelection())}
                    placeholder={"# 论文标题\n\n在这里开始写作…(markdown 语法, 双栏预览)\n\n## 一、引言\n\n…"}
                    className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[12px] leading-relaxed text-slate-200 placeholder:text-slate-600 focus:outline-none" />
                  {/* 选区改写悬浮条 */}
                  {selText && (
                    <div className="absolute bottom-2 left-2 rounded-lg border border-indigo-500/40 bg-slate-800 p-1.5 shadow-xl">
                      <p className="mb-1 flex items-center gap-1 px-1 text-[9px] text-indigo-300"><Sparkles className="h-2.5 w-2.5" />改写选中文字 ({selText.length}字):</p>
                      <div className="flex flex-wrap gap-1">
                        {REWRITE_MODES.map((m) => (
                          <button key={m.key} onClick={() => doRewrite(m.key)} disabled={!!rewriting} title={m.desc}
                            className="rounded bg-indigo-600/40 px-1.5 py-0.5 text-[10px] text-indigo-100 hover:bg-indigo-600 disabled:opacity-50">
                            {rewriting === m.key ? <Loader2 className="mr-0.5 inline h-2.5 w-2.5 animate-spin" /> : null}{m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {view !== "edit" && (
                <div className="min-h-0 overflow-y-auto px-4 py-3">
                  <div className="prose prose-sm prose-invert max-w-none prose-headings:text-slate-100 prose-p:text-slate-300 prose-li:text-slate-300">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || "*（空文档）*"}</ReactMarkdown>
                  </div>
                </div>
              )}
            </div>

            {/* 改写结果确认条 */}
            {rewriteBox && (
              <div className="border-t border-indigo-500/30 bg-indigo-500/5 p-3">
                <p className="mb-1.5 text-[10px] font-semibold text-indigo-300">改写结果</p>
                <div className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto">
                  <div className="rounded bg-slate-900/60 p-2">
                    <p className="mb-1 text-[9px] uppercase text-slate-500">原文</p>
                    <p className="text-[11px] leading-relaxed text-slate-400">{rewriteBox.original.slice(0, 600)}</p>
                  </div>
                  <div className="rounded bg-slate-900/60 p-2">
                    <p className="mb-1 text-[9px] uppercase text-emerald-500">改写</p>
                    <p className="text-[11px] leading-relaxed text-slate-200">{rewriteBox.result}</p>
                  </div>
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <button onClick={() => setRewriteBox(null)} className="rounded bg-slate-700 px-3 py-1 text-[11px] text-slate-300 hover:bg-slate-600">放弃</button>
                  <button onClick={applyRewrite} className="rounded bg-indigo-600 px-3 py-1 text-[11px] text-white hover:bg-indigo-500">替换原文</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 全文检查抽屉 */}
      {showCheck && curId && (
        <div className="absolute bottom-4 right-4 z-20 max-h-96 w-96 overflow-y-auto rounded-xl border border-amber-500/40 bg-slate-900/95 p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
              <ClipboardCheck className="h-3.5 w-3.5" /> 全文一致性检查
              <span className="text-[9px] font-normal text-slate-500">(不验证文献真实性)</span>
            </p>
            <button onClick={() => setShowCheck(false)} className="text-slate-400 hover:text-slate-200"><X className="h-4 w-4" /></button>
          </div>
          {!checkResult ? (
            <button onClick={doCheck} disabled={checking}
              className="w-full rounded-lg bg-amber-600 py-2 text-xs text-white hover:bg-amber-500 disabled:opacity-50">
              {checking ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <Search className="mr-1 inline h-3 w-3" />}运行全文检查
            </button>
          ) : (
            <div className="space-y-2">
              {checkResult.checks.map((c) => (
                <div key={c.name} className={cn("rounded-lg border p-2", c.ok ? "border-green-500/30 bg-green-500/5" : "border-amber-500/30 bg-amber-500/5")}>
                  <p className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                    {c.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-green-400" /> : <X className="h-3.5 w-3.5 text-amber-400" />}
                    {c.name}
                  </p>
                  {c.findings.map((f, i) => <p key={i} className="mt-1 text-[10px] leading-relaxed text-slate-400">· {f}</p>)}
                </div>
              ))}
              <button onClick={() => setCheckResult(null)} className="w-full rounded bg-slate-800 py-1.5 text-[11px] text-slate-300 hover:bg-slate-700">重新检查</button>
            </div>
          )}
        </div>
      )}

      {/* 图表插入抽屉 */}
      {showChart && curId && (
        <div className="absolute bottom-4 right-4 z-20 w-96 rounded-xl border border-indigo-500/40 bg-slate-900/95 p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-indigo-300"><BarChart3 className="h-3.5 w-3.5" /> AI 图表生成</p>
            <button onClick={() => setShowChart(false)} className="text-slate-400 hover:text-slate-200"><X className="h-4 w-4" /></button>
          </div>
          <textarea value={chartDesc} onChange={(e) => setChartDesc(e.target.value)} rows={2} placeholder="描述图表… 如: 按年份的 GDP 折线图(无数据则画示意图)"
            className="w-full resize-none rounded-lg border border-slate-600/60 bg-slate-800 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-500" />
          <button onClick={doChart} disabled={chartBusy || !chartDesc.trim()}
            className="mt-1.5 w-full rounded-lg bg-indigo-600 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50">
            {chartBusy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <Wand2 className="mr-1 inline h-3 w-3" />}生成图表
          </button>
          {chartArt && (
            <div className="mt-2">
              <img src={`/api/viz/files/${chartArt.pngRel}`} alt="chart" className="max-h-48 w-full rounded border border-slate-700/50 object-contain" />
              <button onClick={insertChartMd} className="mt-1.5 w-full rounded-lg bg-emerald-600 py-1.5 text-xs text-white hover:bg-emerald-500">
                <ImageIcon className="mr-1 inline h-3 w-3" />插入正文
              </button>
            </div>
          )}
        </div>
      )}

      {/* UI审计T5: AI 面板(第三栏) */}
      {showAiPanel && curId && (
        <AiEditorPanel
          content={content}
          title={title}
          selText={selText || grabSelection()}
          onInsert={(t) => { onContentChange(content + String.fromCharCode(10,10) + t); flash('已插入到文末'); }}
          onApplyTitle={(t) => { setTitle(t); void saveNow(); flash('标题已更新'); }}
          onMsg={(m) => setErr(m)}
        />
      )}
    </div>
  );
}
export function AiEditorPanel(props: {
  content: string; title: string; selText: string;
  onInsert: (t: string) => void; onApplyTitle: (t: string) => void; onMsg: (m: string) => void;
}) {
  const { content, title, selText, onInsert, onApplyTitle, onMsg } = props;
  const [tab, setTab] = useState<"check" | "title" | "rewrite" | "format" | "refs">("check");
  const [checkResult, setCheckResult] = useState<{ checks: Array<{ name: string; ok: boolean; findings: string[] }> } | null>(null);
  const [checking, setChecking] = useState(false);
  const [taResult, setTaResult] = useState<{ title: string; abstract: string; keywords: string[] } | null>(null);
  const [taBusy, setTaBusy] = useState(false);
  const [rewriteSel, setRewriteSel] = useState("");
  const [rewriteMode, setRewriteMode] = useState("polish");
  const [rwBusy, setRwBusy] = useState(false);
  const [rwResult, setRwResult] = useState("");
  const [fmtText, setFmtText] = useState("");
  const [fmtResult, setFmtResult] = useState("");
  const [fmtBusy, setFmtBusy] = useState(false);

  const doCheck = async () => {
    if (!content.trim()) { onMsg("全文为空"); return; }
    setChecking(true);
    try {
      const r = await j<{ checks: Array<{ name: string; ok: boolean; findings: string[] }> }>("/api/editor/v1/check-fulltext", { method: "POST", body: JSON.stringify({ text: content }) });
      setCheckResult(r);
    } catch (e) { onMsg((e as Error).message); } finally { setChecking(false); }
  };
  const doTitle = async () => {
    if (!content.trim()) { onMsg("全文为空"); return; }
    setTaBusy(true);
    try {
      const r = await j<{ title: string; abstract: string; keywords: string[] }>("/api/editor/v1/title-abstract", { method: "POST", body: JSON.stringify({ text: content }) });
      setTaResult(r);
    } catch (e) { onMsg((e as Error).message); } finally { setTaBusy(false); }
  };
  const doRewrite = async () => {
    const sel = rewriteSel || selText;
    if (!sel) { onMsg("请先选中文字或粘贴到面板"); return; }
    setRwBusy(true);
    try {
      const r = await j<{ text: string }>("/api/editor/v1/rewrite", { method: "POST", body: JSON.stringify({ mode: rewriteMode, text: sel }) });
      setRwResult(r.text);
    } catch (e) { onMsg((e as Error).message); } finally { setRwBusy(false); }
  };
  const doFormat = async () => {
    const txt = fmtText.trim() || selText;
    if (!txt) { onMsg("请粘贴文本或选中正文"); return; }
    setFmtBusy(true);
    try {
      const r = await j<{ text: string }>("/api/editor/v1/rewrite", { method: "POST", body: JSON.stringify({ mode: "journal-style", text: txt }) });
      setFmtResult(r.text);
    } catch (e) { onMsg((e as Error).message); } finally { setFmtBusy(false); }
  };
  const [refText, setRefText] = useState("");
  const [refResult, setRefResult] = useState<{ text: string; fixes: string[] } | null>(null);
  const [refBusy, setRefBusy] = useState(false);
  const doRefs = async () => {
    if (!refText.trim()) { onMsg("请粘贴参考文献"); return; }
    setRefBusy(true);
    try {
      const r = await j<{ text: string; fixes: string[] }>("/api/editor/v1/format-references", { method: "POST", body: JSON.stringify({ text: refText }) });
      setRefResult(r);
    } catch (e) { onMsg((e as Error).message); } finally { setRefBusy(false); }
  };
  const tabs = [
    { k: "check" as const, label: "全文检查", icon: <ClipboardCheck className="h-3 w-3" /> },
    { k: "title" as const, label: "标题摘要", icon: <FileText className="h-3 w-3" /> },
    { k: "rewrite" as const, label: "选区改写", icon: <Wand2 className="h-3 w-3" /> },
    { k: "format" as const, label: "格式模板", icon: <AlignLeft className="h-3 w-3" /> },
    { k: "refs" as const, label: "引用格式", icon: <FileText className="h-3 w-3" /> },
  ];
  return (
    <div className="flex min-h-0 flex-col rounded-xl border border-slate-700/60 bg-slate-900/95">
      <div className="border-b border-slate-700/50 px-2 py-1.5">
        <span className="flex items-center gap-1 text-[11px] font-semibold text-indigo-300"><Sparkles className="h-3 w-3" /> AI 编辑助手</span>
      </div>
      <div className="flex gap-0.5 border-b border-slate-700/40 px-1.5 py-1">
        {tabs.map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)}
            className={cn("flex flex-1 items-center justify-center gap-1 rounded px-1 py-1 text-[9px]", tab === t.k ? "bg-indigo-600/40 text-indigo-100" : "text-slate-500 hover:text-slate-300")}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 text-[11px]">
        {tab === "check" && (
          <div className="space-y-1.5">
            <button onClick={doCheck} disabled={checking}
              className="w-full rounded-lg bg-amber-600 py-1.5 text-[11px] text-white hover:bg-amber-500 disabled:opacity-50">
              {checking ? "检查中…" : "运行全文一致性检查"}
            </button>
            {checkResult?.checks.map((c, i) => (
              <div key={i} className={cn("rounded border p-1.5", c.ok ? "border-green-500/30 bg-green-500/5" : "border-amber-500/30 bg-amber-500/5")}>
                <p className="flex items-center gap-1 text-[10px] font-medium text-slate-200">{c.ok ? "✓" : "✗"} {c.name}</p>
                {c.findings.map((fd, j) => <p key={j} className="mt-0.5 text-[9px] text-slate-400">· {fd}</p>)}
              </div>
            ))}
          </div>
        )}
        {tab === "title" && (
          <div className="space-y-1.5">
            <p className="text-[9px] text-slate-500">从全文提炼优化标题/摘要/关键词</p>
            <button onClick={doTitle} disabled={taBusy}
              className="w-full rounded-lg bg-indigo-600 py-1.5 text-[11px] text-white hover:bg-indigo-500 disabled:opacity-50">
              {taBusy ? "生成中…" : "生成标题+摘要+关键词"}
            </button>
            {taResult && (
              <div className="space-y-1.5">
                <div className="rounded bg-slate-800/60 p-1.5">
                  <p className="text-[9px] font-bold text-indigo-300">建议标题</p>
                  <p className="text-[10px] text-slate-200">{taResult.title}</p>
                  <button onClick={() => onApplyTitle(taResult.title)} className="mt-1 rounded bg-indigo-600 px-2 py-0.5 text-[9px] text-white">采纳标题</button>
                </div>
                <div className="rounded bg-slate-800/60 p-1.5">
                  <p className="text-[9px] font-bold text-indigo-300">摘要</p>
                  <p className="text-[9px] leading-relaxed text-slate-300">{taResult.abstract}</p>
                  <button onClick={() => onInsert("**摘要**\n" + taResult.abstract)} className="mt-1 rounded bg-emerald-600 px-2 py-0.5 text-[9px] text-white">插入文末</button>
                </div>
                <div className="rounded bg-slate-800/60 p-1.5">
                  <p className="text-[9px] font-bold text-indigo-300">关键词</p>
                  <p className="text-[9px] text-slate-300">{taResult.keywords.join("、")}</p>
                </div>
              </div>
            )}
          </div>
        )}
        {tab === "rewrite" && (
          <div className="space-y-1.5">
            <p className="text-[9px] text-slate-500">{selText ? "正文已选中 " + selText.length + " 字, 直接点改写" : "未选中文字 — 可粘贴要改写的段落"}</p>
            <textarea value={rewriteSel} onChange={(e) => setRewriteSel(e.target.value)} rows={3} placeholder="要改写的文本…"
              className="w-full resize-none rounded border border-slate-600/60 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
            <div className="flex gap-1">
              {([["polish", "润色"], ["condense", "压缩"], ["journal-style", "期刊"], ["humanize", "去AI痕迹"]] as Array<[string, string]>).map(([k, lb]) => (
                <button key={k} onClick={() => setRewriteMode(k)}
                  className={cn("flex-1 rounded py-1 text-[9px]", rewriteMode === k ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-400")}>{lb}</button>
              ))}
            </div>
            <button onClick={doRewrite} disabled={rwBusy}
              className="w-full rounded-lg bg-indigo-600 py-1.5 text-[11px] text-white hover:bg-indigo-500 disabled:opacity-50">{rwBusy ? "改写中…" : "执行改写"}</button>
            {rwResult && (
              <div className="space-y-1">
                <p className="text-[9px] font-bold text-emerald-400">改写结果</p>
                <p className="rounded bg-slate-800/60 p-1.5 text-[9px] leading-relaxed text-slate-300">{rwResult}</p>
                <button onClick={() => onInsert(rwResult)} className="w-full rounded bg-emerald-600 py-1 text-[9px] text-white">插入到文末</button>
              </div>
            )}
          </div>
        )}
        {tab === "format" && (
          <div className="space-y-1.5">
            <p className="text-[9px] text-slate-500">中文期刊风格化(用于选中/粘贴段落)</p>
            <textarea value={fmtText} onChange={(e) => setFmtText(e.target.value)} rows={3} placeholder="粘贴要格式化的文本(空则用当前选中)…"
              className="w-full resize-none rounded border border-slate-600/60 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
            <button onClick={doFormat} disabled={fmtBusy}
              className="w-full rounded-lg bg-cyan-600 py-1.5 text-[11px] text-white hover:bg-cyan-500 disabled:opacity-50">{fmtBusy ? "处理中…" : "期刊风格化"}</button>
            {fmtResult && (
              <div className="space-y-1">
                <p className="text-[9px] font-bold text-cyan-400">结果</p>
                <p className="rounded bg-slate-800/60 p-1.5 text-[9px] leading-relaxed text-slate-300">{fmtResult}</p>
                <button onClick={() => onInsert(fmtResult)} className="w-full rounded bg-emerald-600 py-1 text-[9px] text-white">插入到文末</button>
              </div>
            )}
          </div>
        )}
        {tab === "refs" && (
          <div className="space-y-1.5">
            <p className="text-[9px] text-slate-500">粘贴参考文献 → 规范化 GB/T7714 格式(修正卷期/页码/年份)</p>
            <textarea value={refText} onChange={(e) => setRefText(e.target.value)} rows={4} placeholder={"[1] 李海波. 数字经济发展水平测度与时空分异特征[J]. 商展经济, 2026(15):58-61.\n[2] ..."}
              className="w-full resize-none rounded border border-slate-600/60 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
            <button onClick={doRefs} disabled={refBusy}
              className="w-full rounded-lg bg-purple-600 py-1.5 text-[11px] text-white hover:bg-purple-500 disabled:opacity-50">{refBusy ? "规范化中…" : "GB/T7714 规范化"}</button>
            {refResult && (
              <div className="space-y-1">
                {refResult.fixes.length > 0 && (
                  <div className="rounded bg-amber-500/10 p-1.5">
                    <p className="text-[9px] font-bold text-amber-300">修正 {refResult.fixes.length} 处</p>
                    {refResult.fixes.map((fx, i) => <p key={i} className="text-[9px] text-amber-200/80">· {fx}</p>)}
                  </div>
                )}
                <p className="rounded bg-slate-800/60 p-1.5 text-[9px] leading-relaxed text-slate-300">{refResult.text}</p>
                <button onClick={() => onInsert(refResult.text)} className="w-full rounded bg-emerald-600 py-1 text-[9px] text-white">插入到文末</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
