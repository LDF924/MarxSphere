// P2OView.tsx — V395-10: PDF2Obsidian 三栏工作台（复刻原版 LocalWorkspace 完整功能）
// 左: 上传区+任务列表(统计/状态/进度/重试/删除) | 中: PDF iframe 预览 | 右: 输出(译文/阅读材料[摘要/术语表/问答]/论文信息结构化/Bases)
// 直连 SAG /api/p2o/*（持久化任务, 重启不丢; 管线后台异步, 2s 轮询进度）
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { FileUp, Link2, Trash2, Loader2, RefreshCw, FileText, Database, BookOpen, Settings, RotateCcw, CheckCircle2, XCircle, Clock, FolderOpen, Play, StopCircle, ListTree } from "lucide-react";
import { cn } from "../lib/utils";

type TaskStatus = "queued" | "running" | "completed" | "failed";
type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";
type ArtifactKind = "original" | "translated" | "index" | "database" | "summary" | "terms" | "qa";
type OutputViewKind = "translated" | "reading" | "metadata" | "database";
type ReadingKind = "summary" | "terms" | "qa";

interface P2oStep { step: string; status: StepStatus; message?: string }
interface P2oTask {
  id: string;
  fileName: string;
  pdfPath: string;
  source: string;
  status: TaskStatus;
  progress: number;
  steps: P2oStep[];
  error?: string;
  result?: {
    slug: string;
    originalNotePath?: string;
    translatedNotePath?: string;
    indexNotePath?: string;
    databaseNotePath?: string;
    reading?: { summaryPath?: string; termsPath?: string; qaPath?: string };
    configSummary?: { mineruMode?: string; mineruBackend?: string; translationEnabled?: boolean; translationSkipped?: boolean; translationProvider?: string; translationModel?: string; readingAssetsEnabled?: boolean };
  };
  createdAt: string;
  updatedAt: string;
}

const STEP_LABELS: Record<string, string> = {
  upload: "读取论文", mineru: "MinerU提取", normalize: "整理结构", translate: "生成译文", obsidian_export: "写入笔记", quality_check: "质量检查",
};
const OUTPUT_VIEWS: Array<{ kind: OutputViewKind; label: string; source: ArtifactKind }> = [
  { kind: "translated", label: "译文", source: "translated" },
  { kind: "reading", label: "阅读材料", source: "summary" },
  { kind: "metadata", label: "论文信息", source: "index" },
  { kind: "database", label: "Bases", source: "database" },
];
const READING_VIEWS: Array<{ kind: ReadingKind; label: string; desc: string }> = [
  { kind: "summary", label: "摘要", desc: "核心观点" },
  { kind: "terms", label: "术语表", desc: "关键概念" },
  { kind: "qa", label: "问答", desc: "复习问题" },
];
const STATUS_LABELS: Record<TaskStatus, string> = { queued: "排队", running: "运行中", completed: "完成", failed: "失败" };

export const P2OView: FC = () => {
  const [tasks, setTasks] = useState<P2oTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [artifact, setArtifact] = useState<{ kind: ArtifactKind; view: OutputViewKind; content?: string; error?: string }>();
  const [activeView, setActiveView] = useState<OutputViewKind>("translated");
  const [readingKind, setReadingKind] = useState<ReadingKind>("summary");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [urlInput, setUrlInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<any>();
  const fileRef = useRef<HTMLInputElement>(null);
  // V395-13: 批量导入状态
  const [batchDir, setBatchDir] = useState("");
  const [batchScan, setBatchScan] = useState<Array<{ fileName: string; sizeBytes: number }> | null>(null);
  const [batchJob, setBatchJob] = useState<any>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  // V395-14: 批量参数
  const [batchMaxFiles, setBatchMaxFiles] = useState("");
  const [batchRetryFailed, setBatchRetryFailed] = useState(false);
  // V395-16: 批量历史任务列表（重启后展示 + 恢复中任务续跑轮询）
  const [batchHistory, setBatchHistory] = useState<any[]>([]);

  const selected = useMemo(() => tasks.find((t) => t.id === selectedId) ?? tasks[0], [tasks, selectedId]);
  const hasOutput = Boolean(selected?.result);
  const translationSkipped = selected?.result?.configSummary?.translationSkipped === true;
  const readingEnabled = selected?.result?.configSummary?.readingAssetsEnabled === true;
  const visibleViews = useMemo(() => OUTPUT_VIEWS.filter((v) => {
    if (v.kind === "database" && !selected?.result?.databaseNotePath) return false;
    if (v.kind === "translated" && translationSkipped) return false;
    if (v.kind === "reading" && !readingEnabled) return false;
    return true;
  }), [selected?.result?.databaseNotePath, translationSkipped, readingEnabled]);

  const loadTasks = async () => {
    try {
      const r = await fetch("/api/p2o/tasks");
      const list = (await r.json()).tasks || [];
      setTasks(list);
      setSelectedId((cur) => cur && list.some((t: P2oTask) => t.id === cur) ? cur : list[0]?.id);
      // V395-16: 批量历史（重启后展示最近任务; 恢复中的自动续跑可见）
      void loadBatchHistory();
    } catch { /* 静默 */ }
  };
  const loadBatchHistory = async () => {
    try {
      const r = await fetch("/api/p2o/batch");
      const jobs = (await r.json()).jobs || [];
      setBatchHistory(jobs);
      // 有 running 的恢复任务 → 自动轮询其进度
      const runningJob = jobs.find((j: any) => j.status === "running");
      if (runningJob && !batchPollRef.current) {
        setBatchJob(runningJob);
        batchPollRef.current = setInterval(async () => {
          const r2 = await fetch(`/api/p2o/batch/${runningJob.id}`);
          const j = (await r2.json()).job;
          setBatchJob(j);
          setBatchHistory((prev) => prev.map((h) => h.id === j.id ? j : h));
          if (["completed", "failed", "cancelled"].includes(j.status)) {
            if (batchPollRef.current) { clearInterval(batchPollRef.current); batchPollRef.current = null; }
            setMessage(`批量完成: 成功 ${j.succeeded} / 失败 ${j.failed} / 跳过 ${j.skipped} / 去重 ${j.duplicate}`);
            void loadTasks();
          }
        }, 2000);
      }
    } catch { /* 静默 */ }
  };
  const loadConfig = async () => {
    try {
      const r = await fetch("/api/p2o/config");
      setConfig((await r.json()).data);
    } catch { /* 静默 */ }
  };
  useEffect(() => { void loadTasks(); void loadConfig(); }, []);
  // 2s 轮询（任务运行中/排队时刷新进度）
  useEffect(() => {
    const timer = setInterval(() => { void loadTasks(); }, 2000);
    return () => clearInterval(timer);
  }, []);

  // 任务完成/选中后自动加载对应产物
  useEffect(() => {
    if (!selected) { setArtifact(undefined); return; }
    if (!hasOutput) { setArtifact(undefined); return; }
    if (translationSkipped) {
      setActiveView("reading");
      setReadingKind("summary");
      void loadArtifact(selected.id, "summary", "reading");
    } else {
      setActiveView("translated");
      setReadingKind("summary");
      void loadArtifact(selected.id, "translated", "translated");
    }
  }, [selected?.id]);

  const loadArtifact = async (taskId: string, kind: ArtifactKind, view: OutputViewKind) => {
    try {
      const r = await fetch(`/api/p2o/tasks/${taskId}/artifact?kind=${kind}`);
      const d = await r.json();
      if (d.error) setArtifact({ kind, view, error: d.error });
      else setArtifact({ kind, view, content: d.content });
    } catch { setArtifact({ kind, view, error: "加载失败" }); }
  };
  const selectView = async (view: OutputViewKind) => {
    if (!selected) return;
    setActiveView(view);
    const source = view === "reading" ? readingKind : OUTPUT_VIEWS.find((v) => v.kind === view)?.source || "translated";
    await loadArtifact(selected.id, source, view);
  };
  const selectReading = async (kind: ReadingKind) => {
    if (!selected) return;
    setReadingKind(kind);
    setActiveView("reading");
    await loadArtifact(selected.id, kind, "reading");
  };

  const uploadFile = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true); setMessage(undefined);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const r = await fetch("/api/p2o/tasks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileBase64: base64, fileName: file.name }),
      });
      const d = await r.json();
      if (!r.ok) { setMessage(d.error || "上传失败"); return; }
      setSelectedId(d.task.id);
      setMessage("任务已创建，正在解析…");
      void loadTasks();
    } catch (e: any) { setMessage(String(e?.message || "上传失败")); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const importUrl = async () => {
    if (!urlInput.trim()) return;
    setBusy(true); setMessage(undefined);
    try {
      const r = await fetch("/api/p2o/tasks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput.trim() }),
      });
      const d = await r.json();
      if (!r.ok) { setMessage(d.error || "导入失败"); return; }
      setUrlInput("");
      setSelectedId(d.task.id);
      setMessage("任务已创建，正在解析…");
      void loadTasks();
    } catch (e: any) { setMessage(String(e?.message || "导入失败")); }
    finally { setBusy(false); }
  };
  const retryTask = async (id: string) => {
    setMessage(undefined);
    const r = await fetch(`/api/p2o/tasks/${id}/retry`, { method: "POST" });
    const d = await r.json();
    if (!r.ok) { setMessage(d.error || "重试失败"); return; }
    setSelectedId(id);
    setMessage("任务已重新开始");
    void loadTasks();
  };
  const deleteTask = async (id: string) => {
    if (!confirm("删除任务记录和本地 PDF？已写入 Obsidian 的笔记产物会保留。")) return;
    const r = await fetch(`/api/p2o/tasks/${id}`, { method: "DELETE" });
    if (r.ok) { setArtifact(undefined); setMessage("任务已删除"); void loadTasks(); }
  };

  // ═══ V395-13: 批量导入（目录扫描 → 队列执行 → 进度/统计） ═══
  const scanBatchDir = async () => {
    if (!batchDir.trim()) return;
    setBatchBusy(true);
    try {
      const r = await fetch(`/api/p2o/batch/scan?dir=${encodeURIComponent(batchDir.trim())}`);
      const d = await r.json();
      if (d.error) { setMessage("扫描失败: " + d.error); setBatchScan(null); return; }
      setBatchScan(d.papers || []);
      setMessage(`扫描到 ${d.count} 篇 PDF`);
    } catch (e: any) { setMessage("扫描失败: " + (e.message || "")); }
    finally { setBatchBusy(false); }
  };
  const startBatch = async () => {
    if (!batchDir.trim()) return;
    setBatchBusy(true);
    try {
      const r = await fetch("/api/p2o/batch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputDir: batchDir.trim(),
          concurrency: 2,
          maxFiles: batchMaxFiles ? parseInt(batchMaxFiles, 10) : undefined,  // V395-14
          retryFailed: batchRetryFailed,                                       // V395-14
        }),
      });
      const d = await r.json();
      if (d.error) { setMessage("启动失败: " + d.error); return; }
      setBatchJob(d.job);
      setMessage(`批量任务已启动（${d.job.total} 篇）`);
      // 2s 轮询进度
      batchPollRef.current = setInterval(async () => {
        const r2 = await fetch(`/api/p2o/batch/${d.job.id}`);
        const j = (await r2.json()).job;
        setBatchJob(j);
        if (["completed", "failed", "cancelled"].includes(j.status)) {
          if (batchPollRef.current) { clearInterval(batchPollRef.current); batchPollRef.current = null; }
          setMessage(`批量完成: 成功 ${j.succeeded} / 失败 ${j.failed} / 跳过 ${j.skipped} / 去重 ${j.duplicate}`);
          void loadTasks();
        }
      }, 2000);
    } catch (e: any) { setMessage("启动失败: " + (e.message || "")); }
    finally { setBatchBusy(false); }
  };
  const cancelBatch = async () => {
    if (!batchJob) return;
    await fetch(`/api/p2o/batch/${batchJob.id}`, { method: "DELETE" });
    if (batchPollRef.current) { clearInterval(batchPollRef.current); batchPollRef.current = null; }
    setMessage("批量任务已取消");
  };
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const taskSummary = useMemo(() => ({
    total: tasks.length,
    running: tasks.filter((t) => t.status === "queued" || t.status === "running").length,
    completed: tasks.filter((t) => t.status === "completed").length,
    failed: tasks.filter((t) => t.status === "failed").length,
  }), [tasks]);
  const activeStepText = useMemo(() => {
    if (!selected || selected.status === "completed") return undefined;
    const s = selected.steps.find((x) => x.status === "running") ?? selected.steps.find((x) => x.status === "failed") ?? selected.steps.find((x) => x.status === "pending");
    return s ? `${STEP_LABELS[s.step] || s.step} ${STEP_STATUS_LABELS[s.status]}` : undefined;
  }, [selected]);

  const cfg = config || {};
  return (
    <section className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex h-full min-h-0 flex-col gap-3 p-3 md:flex-row">
        {/* ═══ 左栏: 上传 + 任务列表 ═══ */}
        <aside className="flex w-full shrink-0 flex-col gap-2 overflow-y-auto rounded-lg border border-border/70 bg-background/40 p-3 md:w-80">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">PDF2Obsidian</div>
              <h3 className="text-sm font-semibold">论文处理工作台</h3>
            </div>
            <button type="button" onClick={() => setSettingsOpen(true)}
              className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent">
              <Settings className="h-3 w-3" /> 设置
            </button>
          </div>

          {/* 上传区 */}
          <div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-3">
            <input ref={fileRef} type="file" accept=".pdf" onChange={() => void uploadFile()} className="hidden" id="p2o-file-input" />
            <label htmlFor="p2o-file-input" className={cn("flex cursor-pointer flex-col items-center gap-1 rounded-md border border-primary/30 py-4 text-center hover:bg-primary/10", busy && "pointer-events-none opacity-50")}>
              <FileUp className="h-5 w-5 text-primary" />
              <span className="text-xs font-medium text-primary">{busy ? "上传中…" : "上传或拖入 PDF"}</span>
              <span className="text-[10px] text-muted-foreground">选择文件后立即进入处理队列</span>
            </label>
            <div className="my-2 flex items-center gap-2 text-[10px] text-muted-foreground">
              <div className="h-px flex-1 bg-border" />或从链接导入<div className="h-px flex-1 bg-border" />
            </div>
            <div className="flex gap-1.5">
              <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void importUrl(); }}
                placeholder="arXiv ID / DOI / PDF 链接"
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-[11px]" />
              <button type="button" onClick={() => void importUrl()} disabled={busy || !urlInput.trim()}
                className="shrink-0 rounded bg-primary/10 px-2.5 py-1.5 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-40">
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "导入"}
              </button>
            </div>
            {message && <div className="mt-2 rounded bg-muted/50 px-2 py-1 text-[10px] text-muted-foreground">{message}</div>}
          </div>

          {/* 统计 */}
          <div className="grid grid-cols-4 gap-1.5 text-center">
            {([["全部", taskSummary.total], ["处理中", taskSummary.running], ["完成", taskSummary.completed], ["失败", taskSummary.failed]] as const).map(([label, n]) => (
              <div key={label} className="rounded border border-border/50 px-1 py-1.5">
                <div className="text-sm font-semibold">{n}</div>
                <div className="text-[9px] text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>

          {/* V395-13: 批量导入（目录扫描 → 队列 → 进度） */}
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5">
              <FolderOpen className="h-3.5 w-3.5 text-primary" />
              <span className="text-[11px] font-medium">批量导入</span>
              <span className="text-[9px] text-muted-foreground">目录扫描 → 队列执行（去重/配额/续传）</span>
            </div>
            <div className="flex gap-1.5">
              <input value={batchDir} onChange={(e) => setBatchDir(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void scanBatchDir(); }}
                placeholder="PDF 目录路径 (如 D:/papers)"
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-[11px]" />
              <button type="button" onClick={() => void scanBatchDir()} disabled={batchBusy || !batchDir.trim()}
                className="shrink-0 rounded border border-primary/40 px-2 py-1.5 text-[10px] text-primary hover:bg-primary/10 disabled:opacity-40">
                <ListTree className="h-3 w-3" /> 扫描
              </button>
            </div>
            {batchScan && (
              <div className="mt-1.5 max-h-24 overflow-y-auto rounded border border-border/40 bg-background/40 p-1.5">
                <div className="mb-1 text-[9px] text-muted-foreground">预览 {batchScan.length} 篇:</div>
                {batchScan.slice(0, 8).map((p) => (
                  <div key={p.fileName} className="flex justify-between text-[9px]">
                    <span className="truncate">{p.fileName}</span>
                    <span className="shrink-0 text-muted-foreground/60">{(p.sizeBytes / 1048576).toFixed(1)}MB</span>
                  </div>
                ))}
                {batchScan.length > 8 && <div className="text-[9px] text-muted-foreground/50">…共 {batchScan.length} 篇</div>}
              </div>
            )}
            {batchJob && (
              <div className="mt-1.5 space-y-1">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground">
                    {batchJob.done}/{batchJob.total} · 成功 {batchJob.succeeded} · 失败 {batchJob.failed} · 去重 {batchJob.duplicate}
                  </span>
                  <span className={cn("rounded px-1 py-0.5 text-[9px]", batchJob.status === "running" ? "bg-blue-100 text-blue-700" : batchJob.status === "completed" ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground")}>
                    {batchJob.status === "running" ? "执行中" : batchJob.status === "completed" ? "完成" : batchJob.status}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded bg-muted">
                  <div className="h-full bg-primary transition-all" style={{ width: `${batchJob.total > 0 ? (batchJob.done / batchJob.total) * 100 : 0}%` }} />
                </div>
                {batchJob.currentFile && <div className="truncate text-[9px] text-muted-foreground">当前: {batchJob.currentFile}</div>}
                <div className="flex gap-1.5">
                  {batchJob.status === "running" ? (
                    <button type="button" onClick={() => void cancelBatch()}
                      className="flex items-center gap-1 rounded border border-red-300/50 px-1.5 py-0.5 text-[9px] text-red-600 hover:bg-red-50">
                      <StopCircle className="h-2.5 w-2.5" /> 取消
                    </button>
                  ) : (
                    <button type="button" onClick={() => void startBatch()} disabled={batchBusy || !batchDir.trim()}
                      className="flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[9px] text-primary hover:bg-primary/25 disabled:opacity-40">
                      <Play className="h-2.5 w-2.5" /> 再次导入
                    </button>
                  )}
                </div>
                <div className="max-h-20 overflow-y-auto rounded bg-slate-950/60 p-1.5 font-mono text-[8px] leading-3 text-slate-300">
                  {batchJob.log.slice(-6).map((l: string, i: number) => <div key={i}>{l}</div>)}
                </div>
              </div>
            )}
            {!batchJob && batchScan && batchScan.length > 0 && (
              <button type="button" onClick={() => void startBatch()} disabled={batchBusy}
                className="mt-1.5 flex w-full items-center justify-center gap-1 rounded bg-primary px-2 py-1.5 text-[10px] text-primary-foreground hover:opacity-90 disabled:opacity-40">
                <Play className="h-3 w-3" /> 开始批量导入（{batchScan.length} 篇）
              </button>
            )}
            {/* V395-16: 批量历史任务（重启后仍可见; 恢复中的显示续跑中） */}
            {batchHistory.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
                <div className="text-[9px] font-medium text-muted-foreground">批量历史（{batchHistory.length}）</div>
                {batchHistory.slice(0, 5).map((h) => (
                  <div key={h.id} className="rounded border border-border/40 px-1.5 py-1 text-[9px]">
                    <div className="flex items-center justify-between gap-1">
                      <span className="min-w-0 truncate">{h.inputDir?.split(/[\\/]/).pop() || h.id}</span>
                      <span className={cn("shrink-0 rounded px-1 py-0.5",
                        h.status === "completed" ? "bg-green-100 text-green-700"
                        : h.status === "running" ? "bg-blue-100 text-blue-700"
                        : h.status === "cancelled" ? "bg-amber-100 text-amber-700"
                        : "bg-red-100 text-red-700")}>
                        {h.status === "running" ? (h.log?.some((l: string) => l.includes("恢复")) ? "续跑中" : "执行中") : h.status}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded bg-muted">
                        <div className="h-full bg-primary" style={{ width: `${h.total > 0 ? (h.done / h.total) * 100 : 0}%` }} />
                      </div>
                      <span className="shrink-0 text-muted-foreground">{h.done}/{h.total} · 成功{h.succeeded} · 失败{h.failed}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* V395-14: 批量参数（限数量 / 重试失败） */}
            <div className="mt-1.5 flex items-center gap-1.5">
              <input value={batchMaxFiles} onChange={(e) => setBatchMaxFiles(e.target.value)}
                placeholder="最多N篇" title="仅处理前 N 篇（--max-files）"
                className="w-16 shrink-0 rounded border border-border bg-background px-1.5 py-1 text-[9px]" />
              <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[9px] text-muted-foreground">
                <input type="checkbox" checked={batchRetryFailed} onChange={(e) => setBatchRetryFailed(e.target.checked)}
                  className="h-3 w-3" />
                重试失败
              </label>
              <span className="text-[8px] text-muted-foreground/50">失败任务再次导入时重跑</span>
            </div>
          </div>

          {/* 任务列表 */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">任务</span>
            <button type="button" onClick={() => void loadTasks()} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
              <RefreshCw className="h-2.5 w-2.5" /> 刷新
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
            {tasks.length === 0 && <div className="rounded border border-dashed border-border px-2 py-4 text-center text-[10px] text-muted-foreground">暂无解析任务</div>}
            {tasks.map((t) => {
              const active = selected?.id === t.id;
              return (
                <div key={t.id} className={cn("rounded border px-2 py-1.5", active ? "border-primary/50 bg-primary/10" : "border-border/50 hover:bg-accent/30", t.status === "failed" && "border-red-400/30")}>
                  <button type="button" onClick={() => setSelectedId(t.id)} className="w-full text-left">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-[11px]">{t.fileName || t.result?.slug || t.id.slice(0, 8)}</span>
                      <span className={cn("shrink-0 text-[9px]", t.status === "completed" ? "text-green-600" : t.status === "failed" ? "text-red-500" : t.status === "running" ? "text-primary" : "text-muted-foreground")}>
                        {STATUS_LABELS[t.status]}
                      </span>
                    </div>
                    <div className="mt-1 text-[9px] text-muted-foreground">
                      {t.error ? t.error.slice(0, 40) : activeStepOf(t) ? `${STEP_LABELS[activeStepOf(t)!.step] || activeStepOf(t)!.step} · ${t.progress}%` : t.status === "completed" ? "处理完成" : `${t.progress}%`}
                    </div>
                    <div className="mt-1 h-0.5 overflow-hidden rounded bg-muted">
                      <div className={cn("h-full", t.status === "failed" ? "bg-red-500/60" : "bg-primary/70")} style={{ width: `${t.progress}%` }} />
                    </div>
                  </button>
                  {(t.status === "failed" || t.status === "completed") && (
                    <div className="mt-1 flex gap-1">
                      {t.status === "failed" && (
                        <button type="button" onClick={() => void retryTask(t.id)} className="flex items-center gap-0.5 rounded border border-primary/30 px-1.5 py-0.5 text-[9px] text-primary hover:bg-primary/5">
                          <RotateCcw className="h-2.5 w-2.5" /> 重试
                        </button>
                      )}
                      <button type="button" onClick={() => void deleteTask(t.id)} className="flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-red-50 hover:text-red-600">
                        <Trash2 className="h-2.5 w-2.5" /> 删除
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        {/* ═══ 中栏: PDF 预览 ═══ */}
        <section className="flex min-h-[280px] min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-background/40">
          <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
            <div>
              <h3 className="text-xs font-medium">原文件</h3>
              <p className="text-[10px] text-muted-foreground">{selected?.fileName || "选择或上传 PDF"}</p>
            </div>
            {selected && (
              <span className={cn("rounded px-1.5 py-0.5 text-[9px]", selected.status === "completed" ? "bg-green-100 text-green-700" : selected.status === "failed" ? "bg-red-100 text-red-700" : selected.status === "running" ? "bg-blue-100 text-blue-700" : "bg-muted text-muted-foreground")}>
                {STATUS_LABELS[selected.status]}{activeStepText ? ` · ${activeStepText}` : ""}
              </span>
            )}
          </div>
          {selected ? (
            <iframe title="pdf-preview" src={`/api/p2o/tasks/${selected.id}/pdf`} className="min-h-0 w-full flex-1 border-0" />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 text-muted-foreground">
              <FileText className="h-8 w-8 opacity-40" />
              <span className="text-xs">从左侧上传一篇 PDF</span>
              <span className="text-[10px] opacity-70">上传后会在这里预览原文件</span>
            </div>
          )}
        </section>

        {/* ═══ 右栏: 输出 ═══ */}
        <section className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background/40", hasOutput ? "w-full md:w-[26rem]" : "hidden")}>
          <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
            <div>
              <h3 className="text-xs font-medium">输出结果</h3>
              <p className="text-[10px] text-muted-foreground">{selected?.result?.slug || "Markdown"}</p>
            </div>
          </div>
          {hasOutput && selected && (
            <>
              <div className="flex gap-1 border-b border-border/40 px-2 py-1.5">
                {visibleViews.map((v) => (
                  <button key={v.kind} type="button" onClick={() => void selectView(v.kind)}
                    className={cn("rounded px-2 py-1 text-[10px]", activeView === v.kind ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent")}>
                    {v.label}
                  </button>
                ))}
              </div>
              {activeView === "reading" && (
                <div className="flex gap-1 border-b border-border/40 px-2 py-1.5">
                  {READING_VIEWS.map((r) => (
                    <button key={r.kind} type="button" onClick={() => void selectReading(r.kind)}
                      className={cn("rounded border px-2 py-1 text-[10px]", readingKind === r.kind ? "border-primary/40 bg-primary/10 text-primary" : "border-border/50 text-muted-foreground hover:bg-accent")}>
                      <span className="font-medium">{r.label}</span>
                      <span className="ml-1 text-[9px] opacity-60">{r.desc}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {artifact?.error ? (
                  <div className="text-[11px] text-red-500">{artifact.error}</div>
                ) : activeView === "metadata" ? (
                  <MetadataView content={artifact?.content} />
                ) : (
                  <MarkdownView content={artifact?.content} emptyText="任务完成后会在这里显示生成内容。" />
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {/* ═══ 设置面板 ═══ */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setSettingsOpen(false)}>
          <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">PDF2Obsidian 配置</h3>
              <button type="button" onClick={() => setSettingsOpen(false)} className="text-muted-foreground hover:text-foreground">✕</button>
            </div>
            <div className="space-y-2 text-[11px]">
              <ConfigRow label="Vault 路径" value={cfg.vault?.path} />
              <ConfigRow label="文献目录" value={cfg.vault?.documentDir} />
              <ConfigRow label="解析引擎" value={`${cfg.mineru?.mode || "-"} / ${cfg.mineru?.backend || "-"}（MinerU 官方 API）`} />
              <ConfigRow label="公式 / 表格 / 图像" value={`${cfg.mineru?.formula ? "✅" : "❌"} / ${cfg.mineru?.table ? "✅" : "❌"} / ${cfg.mineru?.imageAnalysis ? "✅" : "❌"}`} />
              <ConfigRow label="翻译" value={cfg.translation?.enabled ? `✅ ${cfg.translation?.model || ""}` : "❌ 关闭（马理论原文保留）"} />
              <ConfigRow label="阅读材料" value={cfg.readingAssets?.enabled ? `✅ ${cfg.readingAssets?.summaryFileName || "摘要.md"} / ${cfg.readingAssets?.termsFileName || "术语表.md"} / ${cfg.readingAssets?.qaFileName || "问答.md"}` : "❌ 关闭"} />
              <ConfigRow label="质量报告" value={cfg.quality?.reportFileName} />
              <ConfigRow label="Bases 数据库" value={cfg.obsidian?.database?.enabled ? "✅ 开启" : "❌ 关闭"} />
              <ConfigRow label="自动关联" value={cfg.obsidian?.autoLink?.enabled ? "✅ 开启" : "❌ 关闭"} />
            </div>
            <div className="mt-3 rounded bg-muted/50 px-2 py-1.5 text-[10px] text-muted-foreground">
              配置来自适配层（env: P2O_VAULT_PATH / P2O_READING_ASSETS / P2O_TRANSLATE_MODEL）；修改后重启服务生效。
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

function activeStepOf(task: P2oTask): P2oStep | undefined {
  if (task.status === "completed") return undefined;
  return task.steps.find((s) => s.status === "running") ?? task.steps.find((s) => s.status === "failed") ?? task.steps.find((s) => s.status === "pending");
}
const STEP_STATUS_LABELS: Record<StepStatus, string> = { pending: "等待", running: "运行中", completed: "完成", failed: "失败", skipped: "跳过" };

/** 论文信息结构化展示（解析 frontmatter） */
function MetadataView({ content }: { content?: string }) {
  const meta = useMemo(() => parseFrontmatter(content ?? ""), [content]);
  const rows: Array<[string, string]> = [
    ["标题", meta.title || ""],
    ["原文标题", meta.paperTitle || ""],
    ["中文标题", meta.translatedTitle || ""],
    ["作者", meta.authors || ""],
    ["年份", meta.year || ""],
    ["期刊/会议", meta.journal || ""],
    ["出版社", meta.publisher || ""],
    ["DOI", meta.doi || ""],
    ["元数据来源", meta.metadataSources || ""],
    ["关键词", meta.keywords || ""],
    ["研究领域", meta.fieldsOfStudy || ""],
  ].filter(([, v]) => v) as Array<[string, string]>;
  if (rows.length === 0) {
    return <div className="text-[11px] text-muted-foreground">暂无论文信息</div>;
  }
  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">论文信息</div>
      <div className="space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded border border-border/40 px-2 py-1.5">
            <div className="text-[9px] text-muted-foreground">{label}</div>
            <div className="text-[11px] leading-4">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Markdown 轻量渲染（标题/段落/列表/代码/引用/表格） */
function MarkdownView({ content, emptyText }: { content?: string; emptyText?: string }) {
  const text = (content || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  if (!text) return <div className="text-[11px] text-muted-foreground">{emptyText || "暂无内容"}</div>;
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-1.5 text-[11px] leading-4">
      {blocks.map((b, i) => {
        if (b.type === "h1") return <h4 key={i} className="text-sm font-semibold">{b.text}</h4>;
        if (b.type === "h2") return <h5 key={i} className="text-xs font-semibold">{b.text}</h5>;
        if (b.type === "h3") return <h6 key={i} className="text-[11px] font-semibold">{b.text}</h6>;
        if (b.type === "list") return <ul key={i} className="list-inside list-disc space-y-0.5">{(b.items || []).map((it, j) => <li key={j}>{it}</li>)}</ul>;
        if (b.type === "code") return <pre key={i} className="overflow-x-auto rounded bg-slate-900/60 p-2 font-mono text-[10px]">{b.text}</pre>;
        if (b.type === "quote") return <blockquote key={i} className="border-l-2 border-primary/40 pl-2 text-muted-foreground">{b.text}</blockquote>;
        if (b.type === "table") return <pre key={i} className="overflow-x-auto rounded bg-muted/40 p-2 font-mono text-[10px]">{b.text}</pre>;
        return <p key={i}>{b.text}</p>;
      })}
    </div>
  );
}

function parseBlocks(md: string): Array<{ type: string; text: string; items?: string[] }> {
  const blocks: Array<{ type: string; text: string; items?: string[] }> = [];
  let i = 0;
  const lines = md.split(/\r?\n/);
  while (i < lines.length) {
    const t = (lines[i] || "").trim();
    if (!t) { i++; continue; }
    const h = /^(#{1,3})\s+(.+)$/.exec(t);
    if (h) { blocks.push({ type: `h${h[1].length}`, text: h[2] || "" }); i++; continue; }
    if (t.startsWith("```")) {
      const code: string[] = []; i++;
      while (i < lines.length && !(lines[i] || "").trim().startsWith("```")) { code.push(lines[i] || ""); i++; }
      blocks.push({ type: "code", text: code.join("\n") }); i++; continue;
    }
    if (t.startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && (lines[i] || "").trim().startsWith(">")) { q.push((lines[i] || "").trim().replace(/^>\s?/, "")); i++; }
      blocks.push({ type: "quote", text: q.join("\n") }); continue;
    }
    if (/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length) {
        const it = (lines[i] || "").trim();
        if (!/^[-*]\s+/.test(it) && !/^\d+\.\s+/.test(it)) break;
        items.push(it.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", text: "", items }); continue;
    }
    if (t.startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && (lines[i] || "").trim().startsWith("|")) { rows.push(lines[i] || ""); i++; }
      blocks.push({ type: "table", text: rows.join("\n") }); continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const c = (lines[i] || "").trim();
      if (!c || /^(#{1,3})\s+/.test(c) || c.startsWith("```") || c.startsWith(">") || c.startsWith("|") || /^[-*]\s+/.test(c) || /^\d+\.\s+/.test(c)) break;
      para.push(c); i++;
    }
    blocks.push({ type: "p", text: para.join(" ") });
  }
  return blocks;
}

function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md.trimStart());
  if (!m) return {};
  const meta: Record<string, string> = {};
  let key: string | undefined;
  const list: string[] = [];
  const commit = () => { if (key && list.length) meta[key] = list.join("、"); list.length = 0; };
  for (const raw of (m[1] || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const li = /^\s*-\s+(.+)$/.exec(line);
    if (li && key) { list.push((li[1] || "").trim().replace(/^["']|["']$/g, "")); continue; }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    commit();
    key = kv[1];
    const v = (kv[2] || "").trim().replace(/^["']|["']$/g, "");
    if (v) { meta[key] = v; key = undefined; } else { meta[key] = ""; }
  }
  commit();
  return meta;
}

function ConfigRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-border/40 px-2 py-1.5">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{value || "-"}</span>
    </div>
  );
}
