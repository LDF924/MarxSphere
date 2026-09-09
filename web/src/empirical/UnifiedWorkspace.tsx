// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// UnifiedWorkspace.tsx — 统一分析工作区(2026-09-09 融合重建, 替代 iframe 拼接)
// 三种能力(统计 17 法 / 计量因果 19 法 / Python 代码)在一个数据域上工作:
//   uploadFile 上传/粘贴 → dataState(parsed+csv+fileId+fileName) 全局一份
//   左目录: 统计分析(17法 schema 表单+结果) / 计量因果(19法深度表单+结果) / 代码分析(notebook 单元)
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileCode2, Play, Upload, Loader2, ChevronDown, ChevronRight, RotateCcw, Layers } from "lucide-react";
import { ToolRunner } from "../components/ToolRunner";
import { CHART_TEMPLATES } from "./chartTemplates";
import { METHODS as STATS_METHODS, methodById, normalizeVarType, varTypeMeta } from "./methodParams";
import StatsParamForm from "./StatsParamForm";
import { uploadStatsFileReact, createStatsJobReact, getStatsJobReact, cancelStatsJobReact, retryStatsJobReact, listStatsJobsReactAll } from "./statsApiReact";
import EcoMethodPane, { type EcoMethod } from "./EcoMethodPane";
import { cellText } from "./fmtCell";

export interface ParsedData {
  columnOrder: string[];
  rows: (string | number | null)[][];
}

interface PropShape {
  parsed: ParsedData | null;
  setParsed: (p: ParsedData | null) => void;
  csvText: string;
  setCsvText: (s: string) => void;
  projectId?: string;
  notice?: (s: string) => void;
}

// 19 计量法类别映射(与后端 /api/empirical/methods 一致)
const ECO_CATEGORIES = ["基础", "数据处理", "因果识别", "机制分析", "分类模型", "面板数据", "匹配", "证据综合"];

export default function UnifiedWorkspace({ parsed, setParsed, csvText, setCsvText, projectId, notice }: PropShape) {
  // ── 面板切换: stats(17法) / eco(19法) / code ──
  const [pane, setPane] = useState<"stats" | "eco" | "code">("stats");
  const [statsId, setStatsId] = useState("descriptive");
  const [ecoId, setEcoId] = useState<string | null>(null);
  const [ecoMethods, setEcoMethods] = useState<EcoMethod[]>([]);
  const [ecoMeta, setEcoMeta] = useState<Record<string, string>>({}); // id → category

  // ── 数据 ──
  const [fileId, setFileId] = useState("");
  const [fileName, setFileName] = useState("");
  const [variables, setVariables] = useState<Array<{ name: string; type: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ── 统计法 ──
  const [selVars, setSelVars] = useState<Set<string>>(new Set());
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState(false);
  const [statsResult, setStatsResult] = useState<any>(null);
  const [msg, setMsg] = useState("");
  // 补③: 历史/取消/重试(Vue 统计台四特性)
  const [curJobId, setCurJobId] = useState("");
  const [jobStatus, setJobStatus] = useState("");
  const [historyJobs, setHistoryJobs] = useState<Array<{ id: string; tool: string; status: string; created_at?: string }>>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── 代码 ──
  const [cells, setCells] = useState<Array<{ type: "code"; content: string }>>([]);
  const [cellOuts, setCellOuts] = useState<Array<{ ok: boolean; output: string; error?: string } | null>>([]);
  const [runningCell, setRunningCell] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState(`nb-${Date.now()}`);
  const [runningAll, setRunningAll] = useState(false);
  const [showDigitize, setShowDigitize] = useState(false);

  const statsMethod = methodById(statsId);
  const ecoMethod = ecoMethods.find((m) => m.id === ecoId) ?? null;

  useEffect(() => { void loadEcoMethods(); }, []);

  async function loadEcoMethods() {
    try {
      const r = await fetch("/api/empirical/methods", { headers: { Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` } }).then((x) => x.json());
      const list: EcoMethod[] = r.methods ?? [];
      setEcoMethods(list);
      const map: Record<string, string> = {};
      list.forEach((m) => { map[m.id] = m.category; });
      setEcoMeta(map);
      // 默认选中第一个
      if (!ecoId && list.length) setEcoId(list[0].id);
    } catch { /* 忽略 */ }
  }

  // 变量类型推断(从 parsed 前 50 行)
  function inferVariables(cols: string[], rows: (string | number | null)[][]): Array<{ name: string; type: string }> {
    return cols.map((name, ci) => {
      const sample = rows.slice(0, 50).map((r) => r[ci]).filter((v) => v !== null && v !== "");
      const numeric = sample.filter((v) => typeof v === "number" || (typeof v === "string" && !Number.isNaN(Number(v)))).length;
      const ratio = sample.length ? numeric / sample.length : 0;
      return { name, type: ratio >= 0.9 ? "scale" : ratio <= 0.1 ? "nominal" : "unknown" };
    });
  }

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const text = await file.text();
      const p = parseCsvText(text);
      if (!p) { setMsg("无法解析 CSV"); return; }
      setParsed(p); setCsvText(text);
      setVariables(inferVariables(p.columnOrder, p.rows));
      // 统计台 fileId(统计法用)
      const b64 = await fileToBase64(file);
      const r = await fetch("/api/files/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` },
        body: JSON.stringify({ filename: file.name, base64: b64, mime: file.type || "text/csv" }),
      }).then((x) => x.json()).catch(() => null);
      if (r?.fileId) setFileId(r.fileId);
      setFileName(file.name);
      // 同步到 jupyter 沙箱(代码方法可读)
      try {
        await fetch("/api/jupyter/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileName: file.name, content: text.slice(0, 4_000_000) }) });
      } catch { /* 沙箱可选 */ }
      notice?.(`已加载 ${file.name}: ${p.rows.length} 行 × ${p.columnOrder.length} 列 — 统计法/计量法/代码共用`);
    } catch (e: any) {
      setMsg(`上传失败: ${e?.message ?? e}`);
    } finally { setUploading(false); }
  }

  function parseCsvText(text: string): ParsedData | null {
    const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return null;
    const delim = text.includes(";") ? ";" : text.includes("\t") ? "\t" : ",";
    const columnOrder = lines[0].split(delim).map((c) => c.trim());
    const rows = lines.slice(1).map((l) => {
      const cellsArr = l.split(delim);
      return columnOrder.map((_, i) => {
        const raw = (cellsArr[i] ?? "").trim();
        if (raw === "") return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : raw;
      });
    });
    return { columnOrder, rows };
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsDataURL(file);
    });
  }

  // 统计法参数重置
  useEffect(() => {
    if (!statsMethod) return;
    setParams(JSON.parse(JSON.stringify(statsMethod.defaults ?? {})));
  }, [statsId, statsMethod]);

  const toggleVar = (name: string) => {
    setSelVars((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  };

  async function runStats() {
    const m = statsMethod;
    if (!m) return;
    if (!fileId) { setMsg("请先在上方上传数据文件"); return; }
    if (m.needVars && !selVars.size) { setMsg("请至少选择一个变量"); return; }
    const err = m.validate(params, [...selVars]);
    if (err) { setMsg(err); return; }
    setRunning(true); setJobStatus("queued"); setStatsResult(null); setMsg("");
    try {
      const body: Record<string, unknown> = m.build(params, [...selVars], fileId);
      body.tool = m.id;
      const { job } = await createStatsJobReact(body);
      const jid = job.id;
      setCurJobId(jid);
      localStorage.setItem("sag:stats-active-job", jid);
      // 轮询(可取消 — cancelStats 置标志后停止)
      pollRef.current = setInterval(async () => {
        try {
          const { job: j } = await getStatsJobReact(jid);
          setJobStatus(j.status);
          if (j.status === "completed") {
            stopPoll(); setRunning(false); setCurJobId("");
            localStorage.removeItem("sag:stats-active-job");
            setStatsResult(j.result ?? {});
            void refreshStatsHistory();
          } else if (j.status === "failed") {
            stopPoll(); setRunning(false); setJobStatus("failed");
            setMsg(j.error?.message ?? "分析失败");
            void refreshStatsHistory();
          } else if (j.status === "cancelled") {
            stopPoll(); setRunning(false); setJobStatus(""); setCurJobId(""); setMsg("任务已取消");
          }
        } catch { /* 网络瞬断容忍, 下一轮再试 */ }
      }, 700);
    } catch (e: any) {
      setRunning(false); setMsg(`提交失败: ${e?.message ?? e}`);
    }
  }

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  async function cancelStats() {
    if (!curJobId) return;
    stopPoll(); setRunning(false); setCurJobId(""); setMsg("正在取消…");
    await cancelStatsJobReact(curJobId).catch(() => null);
    setMsg("任务已取消"); setJobStatus("");
    localStorage.removeItem("sag:stats-active-job");
    void refreshStatsHistory();
  }

  async function retryStats() {
    if (!curJobId) return;
    const { job } = await retryStatsJobReact(curJobId).catch(() => ({ job: { id: curJobId, status: "queued" } }));
    setJobStatus(job.status); setRunning(true);
    // 复用 job id 直接重轮询
    const jid = curJobId;
    pollRef.current = setInterval(async () => {
      try {
        const { job: j } = await getStatsJobReact(jid);
        setJobStatus(j.status);
        if (j.status === "completed") {
          stopPoll(); setRunning(false); setCurJobId("");
          localStorage.removeItem("sag:stats-active-job");
          setStatsResult(j.result ?? {});
          void refreshStatsHistory();
        } else if (j.status === "failed") {
          stopPoll(); setRunning(false); setJobStatus("failed");
          setMsg(j.error?.message ?? "分析失败");
        }
      } catch { /* 容忍 */ }
    }, 700);
  }

  async function refreshStatsHistory() {
    try {
      const { jobs } = await listStatsJobsReactAll(20);
      setHistoryJobs(jobs);
    } catch { /* 容忍 */ }
  }

  /** 打开历史任务结果 */
  async function openStatsHistory(jobId: string) {
    try {
      const { job } = await getStatsJobReact(jobId);
      if (job.status === "completed") { setStatsResult(job.result ?? {}); setMsg("已载入历史结果"); }
      else if (["queued", "running"].includes(job.status)) { setCurJobId(job.id); setRunning(true); retryStats(); }
      else setMsg(`该任务状态: ${job.status}`);
    } catch { setMsg("历史任务读取失败"); }
  }

  // 初次挂载: 载入历史 + 恢复未完成任务(localStorage 断点语义)
  useEffect(() => {
    void refreshStatsHistory();
    const saved = localStorage.getItem("sag:stats-active-job");
    if (saved && !curJobId) {
      void getStatsJobReact(saved).then(({ job }) => {
        if (["queued", "running"].includes(job.status)) {
          setCurJobId(job.id); setRunning(true); retryStats();
        } else {
          localStorage.removeItem("sag:stats-active-job");
          void refreshStatsHistory();
        }
      }).catch(() => {});
    }
    return () => stopPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runCell(i: number) {
    const c = cells[i];
    setRunningCell(i);
    try {
      const res = await fetch("/api/jupyter/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: c.content, sessionId, cellIndex: i }),
        signal: AbortSignal.timeout(90_000),
      }).then((r) => r.json()).catch(() => ({ result: { ok: false, output: "", error: "请求失败或超时" } }));
      const rr = res.result as { ok: boolean; output: string; error?: string };
      setCellOuts((prev) => { const n = [...prev]; n[i] = rr; return n; });
    } finally { setRunningCell(null); }
  }

  function addCell() {
    setCells((c) => [...c, { type: "code", content: "" }]);
    setCellOuts((o) => [...o, null]);
  }

  // ── 代码: 图表模板插入 / Run All / Restart(JupyterPanel 完整工具栏语义) ──
  function insertTemplate(id: string) {
    const t = CHART_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setCells((c) => [...c, { type: "code", content: t.code }]);
    setCellOuts((o) => [...o, null]);
  }

  async function runAllCells() {
    if (!cells.length || runningAll) return;
    setRunningAll(true);
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].type !== "code") continue;
      await runCell(i);
    }
    setRunningAll(false);
  }

  async function restartNotebook() {
    const newId = `nb-${Date.now()}`;
    setSessionId(newId);
    setCellOuts([]);
    try {
      await fetch("/api/jupyter/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: newId }) });
    } catch { /* 容忍 */ }
  }

  // 按分类分组渲染左目录
  const groupedStats = useGroupedStats();
  const ecoGrouped: Record<string, EcoMethod[]> = {};
  ECO_CATEGORIES.forEach((cat) => { ecoGrouped[cat] = ecoMethods.filter((m) => (ecoMeta[m.id] ?? "基础") === cat); });

  const hasData = !!parsed && parsed.rows.length > 0;
  const cols = parsed?.columnOrder ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* ═══ 全局数据栏(一处上传 → 全部方法) ═══ */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border bg-muted/10 px-3 py-2">
        <Upload className="h-3.5 w-3.5 text-emerald-600" />
        <span className="text-[10px] font-medium text-foreground/80">研究数据</span>
        <input ref={fileInputRef} type="file" accept=".csv,.txt,.tsv,.json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload(f); e.target.value = ""; }} />
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}
          className="flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-700 hover:bg-emerald-500/20 disabled:opacity-40">
          {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} 上传 CSV
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()}
          className="rounded-lg border px-2.5 py-1 text-[10px] text-muted-foreground hover:bg-accent">或点击选择 .xlsx/.xls</button>
        {fileName && <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700">{fileName}</span>}
        {hasData && (
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-600">{parsed!.rows.length} 行</span>
            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-600">{parsed!.columnOrder.length} 列</span>
            <span className="hidden max-w-[280px] truncate lg:inline">{parsed!.columnOrder.join(", ")}</span>
          </span>
        )}
        {!hasData && <span className="text-[10px] text-muted-foreground">统计 17 法 / 计量 19 法 / Python 代码共用此数据集</span>}
        {msg && <span className="text-[10px] text-red-600">⚠ {msg}</span>}
      </div>

      {/* ═══ 图表数字化(文献图→CSV, 恢复自旧方法执行 data 步) ═══ */}
      <div className="shrink-0">
        <button type="button"
          onClick={() => setShowDigitize((v) => !v)}
          className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          {showDigitize ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          📊 图表数字化 — 从文献图表/图片提取数值为 CSV（thu-digitizer, 验证优先）
        </button>
        {showDigitize && (
          <div className="rounded-lg border bg-muted/5 p-2">
            <ToolRunner
              tool="view_chart_digitize"
              title="图表数字化"
              fields={[
                { key: "imagePath", label: "图表图片/PDF 路径", placeholder: "D:/figure.png" },
                { key: "chartType", label: "图表类型", type: "select", options: ["", "bar", "line", "scatter", "histogram", "boxplot"] },
              ]}
              hint="预检 → 坐标确认 → CSV（不编造数值）"
              compact
            />
          </div>
        )}
      </div>

      {/* ═══ 能力切换页签 ═══ */}
      <div className="flex shrink-0 items-center gap-1 border-b">
        <button type="button" onClick={() => setPane("stats")} className={`rounded-t-lg border-b-2 px-3 py-1.5 text-[11px] font-medium ${pane === "stats" ? "border-emerald-500 text-emerald-700" : "border-transparent text-muted-foreground hover:bg-accent"}`}>统计分析 <span className="text-[9px] opacity-60">17 法</span></button>
        <button type="button" onClick={() => setPane("eco")} className={`rounded-t-lg border-b-2 px-3 py-1.5 text-[11px] font-medium ${pane === "eco" ? "border-emerald-500 text-emerald-700" : "border-transparent text-muted-foreground hover:bg-accent"}`}>计量因果 <span className="text-[9px] opacity-60">19 法</span></button>
        <button type="button" onClick={() => setPane("code")} className={`rounded-t-lg border-b-2 px-3 py-1.5 text-[11px] font-medium ${pane === "code" ? "border-violet-500 text-violet-700" : "border-transparent text-muted-foreground hover:bg-accent"}`}><FileCode2 className="mr-1 inline h-3 w-3" />代码分析</button>
        {pane === "code" && <span className="ml-auto text-[10px] text-muted-foreground">Python 沙箱 · {fileName ? `pd.read_csv("${fileName}") 可用` : "上传数据后可按文件名读取"}</span>}
      </div>

      {/* ═══ 三栏工作区 ═══ */}
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border bg-card/30">
        {/* 左: 方法目录 */}
        <div className="w-[170px] shrink-0 overflow-y-auto border-r p-2">
          {pane === "stats" && (
            <div className="space-y-2">
              {Object.keys(groupedStats).map((cat) => (
                <div key={cat}>
                  <div className="mb-0.5 px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{cat}</div>
                  <div className="space-y-0.5">
                    {groupedStats[cat].map((m) => (
                      <button key={m.id} type="button" onClick={() => setStatsId(m.id)}
                        className={`w-full rounded-md border px-2 py-1 text-left text-[10px] ${statsId === m.id ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700" : "hover:bg-accent"}`}
                        title={m.desc}>{m.name}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {pane === "eco" && (
            <div className="space-y-2">
              {ECO_CATEGORIES.map((cat) => {
                const list = ecoGrouped[cat] ?? [];
                if (!list.length) return null;
                return (
                  <div key={cat}>
                    <div className="mb-0.5 px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{cat}</div>
                    <div className="space-y-0.5">
                      {list.map((m) => (
                        <button key={m.id} type="button" onClick={() => setEcoId(m.id)}
                          className={`w-full rounded-md border px-2 py-1 text-left text-[10px] ${ecoId === m.id ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700" : "hover:bg-accent"}`}
                          title={m.desc}>{m.label}</button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {pane === "code" && (
            <div className="space-y-1">
              <button type="button" onClick={addCell} className="w-full rounded-md border border-dashed py-1.5 text-[10px] text-muted-foreground hover:border-violet-500/40 hover:text-violet-600">+ 代码单元</button>
              <div className="px-1 pt-1 text-[9px] leading-relaxed text-muted-foreground">
                代码与统计法/计量法共享数据集; 运行顺序共享变量。<br /><br />
                提示: 上传文件后, 沙箱内可直接 <code className="rounded bg-muted px-1">pd.read_csv("{fileName || "文件名.csv"}")</code>
              </div>
            </div>
          )}
        </div>

        {/* 中: 配置 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-3">
          {pane === "stats" && statsMethod && (
            <>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-sm font-semibold">{statsMethod.name}</span>
                <span className="text-[10px] text-muted-foreground">{statsMethod.desc}</span>
              </div>
              {statsMethod.needVars && variables.length > 0 && (
                <div className="mb-2 rounded-lg border p-2">
                  <div className="mb-1 text-[10px] font-semibold text-foreground/80">分析变量</div>
                  <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto">
                    {variables.map((v) => (
                      <div key={v.name} onClick={() => toggleVar(v.name)}
                        className={`flex cursor-pointer items-center gap-1 rounded border px-1.5 py-1 text-[10px] ${selVars.has(v.name) ? "border-emerald-500/50 bg-emerald-500/10" : "hover:bg-accent"}`}>
                        <span className="text-muted-foreground">#</span>
                        <span className="truncate">{v.name}</span>
                        <span className={`ml-auto rounded px-1 text-[8px] ${v.type === "scale" ? "bg-blue-500/10 text-blue-600" : v.type === "nominal" ? "bg-amber-500/10 text-amber-600" : "bg-muted text-muted-foreground"}`}>{varTypeMeta(v.type).label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="rounded-lg border p-2">
                <div className="mb-1.5 text-[10px] font-semibold text-foreground/80">参数设置</div>
                <StatsParamForm fields={statsMethod.fields ?? []} values={params} onChange={(k, v) => setParams((p) => ({ ...p, [k]: v }))} vars={variables} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" disabled={running} onClick={() => void runStats()}
                  className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
                  {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} {running ? "分析中…" : "运行分析"}
                </button>
                {running && curJobId && (
                  <button type="button" onClick={() => void cancelStats()}
                    className="rounded-lg border border-red-500/40 px-2.5 py-1.5 text-[10px] text-red-600 hover:bg-red-500/10">取消任务</button>
                )}
                {jobStatus === "failed" && curJobId && (
                  <button type="button" onClick={() => void retryStats()}
                    className="rounded-lg border border-amber-500/40 px-2.5 py-1.5 text-[10px] text-amber-600 hover:bg-amber-500/10">从失败任务重试</button>
                )}
                <button type="button" onClick={() => setSelVars(new Set())} className="rounded-lg border px-2.5 py-1.5 text-[10px] hover:bg-accent">清空变量</button>
                {/* 历史任务下拉(回看已完成结果) */}
                {historyJobs.length > 0 && (
                  <select
                    className="ml-auto max-w-[240px] rounded-md border bg-background px-1.5 py-1 text-[10px] text-muted-foreground"
                    value=""
                    onChange={(e) => { if (e.target.value) void openStatsHistory(e.target.value); }}
                    title="历史分析任务(点选回看结果)"
                  >
                    <option value="">历史分析…</option>
                    {historyJobs.map((h, i) => (
                      <option key={h.id} value={h.id}>
                        {h.tool} · {h.status === "completed" ? "已完成" : h.status === "failed" ? "失败" : h.status === "cancelled" ? "已取消" : h.status} · {(h.created_at ?? "").slice(5, 16).replace("T", " ")}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </>
          )}
          {pane === "eco" && ecoMethod && (
            <EcoMethodPane method={ecoMethod} data={{ parsed, csvText, preprocess: { winsorize: [], log: [], standardize: [] }, projectId }} />
          )}
          {pane === "code" && (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              {/* 代码工具栏(完整 notebook 语义: 模板/Run All/Restart) */}
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 rounded-lg border bg-card/40 px-2 py-1.5">
                <select
                  value=""
                  onChange={(e) => { if (e.target.value) insertTemplate(e.target.value); }}
                  className="rounded-md border bg-background px-1.5 py-1 text-[10px] text-muted-foreground"
                  title="插入图表模板代码单元格(运行后出图)"
                >
                  <option value="">📊 图表模板…</option>
                  {CHART_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <button type="button" onClick={addCell} className="rounded-md border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent">+ 单元</button>
                <span className="mx-0.5 h-3 w-px bg-border/60" />
                <button type="button" onClick={() => void runAllCells()} disabled={runningAll || !cells.length}
                  className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-700 hover:bg-emerald-500/20 disabled:opacity-40">
                  {runningAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run All
                </button>
                <button type="button" onClick={() => void restartNotebook()} disabled={runningAll}
                  className="flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40">
                  <RotateCcw className="h-3 w-3" /> Restart
                </button>
                <span className="ml-auto text-[9px] text-muted-foreground">{cells.length} 单元 · 顺序执行共享变量</span>
              </div>
              {cells.length === 0 && (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <FileCode2 className="mb-2 h-6 w-6 text-violet-400" />
                  <div className="text-[11px] font-medium">Python 代码分析</div>
                  <div className="mt-1 max-w-[300px] text-[9px] leading-relaxed text-muted-foreground">上传数据后在此写代码: 读取数据集、衍生变量、统计检验、画图 — 与统计法结果互补</div>
                  <button type="button" onClick={addCell} className="mt-3 rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-[10px] font-medium text-violet-700 hover:bg-violet-500/20">+ 新建代码单元</button>
                </div>
              )}
              {cells.map((c, i) => (
                <div key={i} className="overflow-hidden rounded-xl border bg-card/40">
                  <div className="flex items-center gap-1.5 border-b bg-muted/10 px-2 py-1">
                    <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">[{i}]</span>
                    <span className="rounded bg-violet-500/10 px-1 py-0.5 text-[8px] font-semibold text-violet-600">PY</span>
                    <span className="ml-auto">
                      <button type="button" onClick={() => void runCell(i)} disabled={runningCell === i}
                        className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-medium text-emerald-700 hover:bg-emerald-500/20 disabled:opacity-40">
                        {runningCell === i ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />} 运行
                      </button>
                    </span>
                  </div>
                  <textarea value={c.content} spellCheck={false}
                    onChange={(e) => setCells((prev) => prev.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
                    className="min-h-[72px] w-full resize-y bg-transparent p-2 font-mono text-[11px] outline-none"
                    placeholder={'# 共享数据集: pd.read_csv("' + (fileName || "数据.csv") + '")'} />
                  {cellOuts[i] && (
                    <div className="border-t bg-muted/5 px-2 py-1.5">
                      {cellOuts[i]!.ok ? <pre className="whitespace-pre-wrap font-mono text-[10px] text-foreground/80">{cellOuts[i]!.output || "(无输出)"}</pre>
                        : <pre className="whitespace-pre-wrap font-mono text-[10px] text-red-600">✗ {cellOuts[i]!.error}</pre>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右: 结果 */}
        <div className="flex min-w-0 w-[38%] flex-col overflow-y-auto border-l bg-muted/5 p-3">
          {pane === "stats" && (
            <>
              <div className="mb-2 text-[11px] font-semibold">分析结果</div>
              {running && <div className="flex flex-col items-center py-8 text-muted-foreground"><Loader2 className="mb-2 h-4 w-4 animate-spin text-emerald-600" /><span className="text-[10px]">沙箱执行中…</span></div>}
              {!running && !statsResult && <div className="py-8 text-center text-[10px] text-muted-foreground">运行后在此显示结果表格与图表</div>}
              {statsResult && (
                <div className="space-y-2">
                  {statsResult.tables?.map((t: any, i: number) => (
                    <div key={i} className="overflow-x-auto rounded-lg border bg-card/50">
                      {t.title && <div className="border-b bg-muted/20 px-2 py-1 text-[10px] font-medium">{t.title}</div>}
                      <table className="w-full text-[10px]">
                        <thead><tr className="border-b bg-muted/10 text-left">{(t.columns ?? []).map((c: string, ci: number) => <th key={ci} className="px-2 py-1 font-medium">{c}</th>)}</tr></thead>
                        <tbody>{(t.rows ?? []).map((r: unknown[], ri: number) => (
                          <tr key={ri} className="border-b last:border-0 odd:bg-muted/5">{r.map((v, ci) => <td key={ci} className={`px-2 py-1 ${ci === 0 ? "font-medium" : ""}`}>{cellText(v)}</td>)}</tr>
                        ))}</tbody>
                      </table>
                      {t.footnote && <div className="border-t bg-muted/10 px-2 py-1 text-[9px] text-muted-foreground">注: {t.footnote}</div>}
                    </div>
                  ))}
                  {!statsResult.tables?.length && !statsResult.charts?.length && <div className="py-3 text-center text-[10px] text-muted-foreground">分析无输出内容</div>}
                  {statsResult.charts && statsResult.charts.length > 0 && <ChartPlaceholder charts={statsResult.charts} />}
                </div>
              )}
            </>
          )}
          {pane === "eco" && <div className="text-[11px] font-semibold text-muted-foreground">计量法结果在中间栏下方展示</div>}
          {pane === "code" && <div className="text-[11px] font-semibold text-muted-foreground">代码输出在单元内展示 · 变量跨单元持久</div>}
        </div>
      </div>
    </div>
  );
}

/** 统计法图表(plotly)懒加载渲染 */
function ChartPlaceholder({ charts }: { charts: any[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mod = await import("plotly.js-dist-min").catch(() => null);
      if (cancelled || !mod) return;
      const Plotly = (mod as any).default ?? mod;
      charts.forEach((c, i) => {
        const el = ref.current?.querySelector(`#uc-chart-${i}`);
        if (!el) return;
        const cfg = c.config ?? { data: [], layout: {} };
        const data = Array.isArray(cfg.data) ? cfg.data : [cfg.data];
        void Plotly.newPlot(el, data, cfg.layout ?? {}, { responsive: true, displayModeBar: true });
      });
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, [charts]);
  if (!charts.length) return null;
  return (
    <div ref={ref} className="space-y-2">
      {charts.map((c, i) => (
        <div key={i} className="rounded-lg border bg-card/50 p-1">
          <div className="px-1 py-0.5 text-[10px] text-muted-foreground">{String(c.config?.layout?.title?.text ?? "图表")}</div>
          <div id={`uc-chart-${i}`} className="min-h-[220px] w-full" />
        </div>
      ))}
      {!ready && <div className="py-2 text-center text-[9px] text-muted-foreground">图表渲染中…</div>}
    </div>
  );
}

function useGroupedStats() {
  const cats = ["数据基础", "推断统计", "回归建模", "信效度&高级"];
  const grouped: Record<string, typeof STATS_METHODS> = {};
  cats.forEach((c) => { grouped[c] = STATS_METHODS.filter((m) => m.category === c); });
  return grouped;
}
