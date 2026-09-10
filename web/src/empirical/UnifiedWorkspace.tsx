// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// UnifiedWorkspace.tsx — 统一分析工作区(2026-09-09 融合重建, 替代 iframe 拼接)
// 三种能力(统计 17 法 / 计量因果 19 法 / Python 代码)在一个数据域上工作:
//   uploadFile 上传/粘贴 → dataState(parsed+csv+fileId+fileName) 全局一份
//   左目录: 统计分析(17法 schema 表单+结果) / 计量因果(19法深度表单+结果) / 代码分析(notebook 单元)
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileCode2, Play, Upload, Loader2, ChevronDown, ChevronRight, RotateCcw, Layers, Trash2 } from "lucide-react";
import { ToolRunner } from "../components/ToolRunner";
import { CHART_TEMPLATES } from "./chartTemplates";
import { DEMO_CELLS } from "./demoCells";
import { METHODS as STATS_METHODS, methodById, normalizeVarType, varTypeMeta } from "./methodParams";
import StatsParamForm from "./StatsParamForm";
import { uploadStatsFileReact, createStatsJobReact, getStatsJobReact, cancelStatsJobReact, retryStatsJobReact, listStatsJobsReactAll, streamStatsJobReact } from "./statsApiReact";
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

  // 数据变更即广播: 编辑器「辅助工具 → 图表」可直接复用这份数据出图, 不用重传
  useEffect(() => {
    if (!csvText.trim()) return;
    const cols = parsed?.columnOrder?.length
      ? parsed.columnOrder
      : (csvText.split(/\r?\n/)[0] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!cols.length) return;
    window.dispatchEvent(new CustomEvent("empirical:dataset-changed", {
      detail: { csv: csvText, columnOrder: cols, fileName: fileName || "实证数据集" },
    }));
  }, [csvText, parsed, fileName]);

  // ── 统计法 ──
  const [selVars, setSelVars] = useState<Set<string>>(new Set());
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState(false);
  const [statsResult, setStatsResult] = useState<any>(null);
  const [ecoResult, setEcoResult] = useState<any>(null);
  const [msg, setMsg] = useState("");
  // 补③: 历史/取消/重试(Vue 统计台四特性)
  const [curJobId, setCurJobId] = useState("");
  const [jobStatus, setJobStatus] = useState("");
  const [stageLabel, setStageLabel] = useState("");
  const [historyJobs, setHistoryJobs] = useState<Array<{ id: string; tool: string; status: string; created_at?: string }>>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sseRef = useRef<{ abort: () => void; done: Promise<void> } | null>(null);

  // ── 代码 ──
  const [cells, setCells] = useState<Array<{ type: "code" | "md"; content: string }>>([]);
  const [cellOuts, setCellOuts] = useState<Array<{ ok: boolean; output: string; error?: string; figures?: string[]; variables?: Record<string, unknown> } | null>>([]);
  const [kernelVars, setKernelVars] = useState<Record<string, unknown>>({});
  const [runningCell, setRunningCell] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState(`nb-${Date.now()}`);
  const [runningAll, setRunningAll] = useState(false);
  const [showDigitize, setShowDigitize] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [versioning, setVersioning] = useState(false);
  const [versions, setVersions] = useState<Array<{ id: string; name: string; columns: string[]; nRows: number; data?: (string | number | null)[][] | null; created_at?: string }>>([]);

  const statsMethod = methodById(statsId);
  const ecoMethod = ecoMethods.find((m) => m.id === ecoId) ?? null;

  useEffect(() => { void loadEcoMethods(); void loadVersions(); }, []);

  // ── 外部数据同步: 问卷仿真/其他区段载入数据写入父级 parsed/csv 后, 本工作区跟随 ──
  const lastExternalParsed = useRef<{ col: string; rows: number } | null>(null);
  useEffect(() => {
    if (!parsed || !parsed.columnOrder.length) return;
    const sig = `${parsed.columnOrder.join(",")}|${parsed.rows.length}`;
    // 自身 handleUpload 触发父级 setParsed 也会进这里 — 用 fileName 已设区分, 幂等无害
    if (lastExternalParsed.current?.col === sig) return;
    lastExternalParsed.current = { col: sig, rows: parsed.rows.length };
    setVariables(inferVariables(parsed.columnOrder, parsed.rows));
    setSelVars(new Set());
  }, [parsed]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 无 fileId 时自动从 csvText 注册(仿真/版本/粘贴数据 → 统计法可用) ──
  async function ensureFileIdFromCsv(): Promise<string> {
    if (fileId) return fileId;
    if (!csvText.trim()) return "";
    try {
      const f = new File([csvText], "data_载入.csv", { type: "text/csv" });
      const b64 = await fileToBase64(f);
      const r = await fetch("/api/files/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` },
        body: JSON.stringify({ filename: f.name, base64: b64, mime: "text/csv" }),
      }).then((x) => x.json()).catch(() => null);
      if (r?.fileId) { setFileId(r.fileId); return r.fileId; }
    } catch { /* 注册失败走提示 */ }
    return "";
  }

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
      const isXlsx = /\.(xlsx|xls)$/i.test(file.name);
      const rawText = isXlsx ? "" : await file.text();
      const b64 = await fileToBase64(file);
      const r = await fetch("/api/files/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` },
        body: JSON.stringify({ filename: file.name, base64: b64, mime: file.type || "text/csv" }),
      }).then((x) => x.json()).catch(() => null);
      if (!r?.fileId) { setMsg(`上传失败: ${r?.error ?? "未知错误"}`); return; }
      // xlsx: 后端已转 CSV, 用 profile.sampleRows 无法重建全量 — 从 profile.columns + 后端转换后文件读回?
      // 务实: xlsx 全量行经 /api/files/{id}/content 读回(此时内容已是 CSV)
      let text = rawText;
      if (isXlsx) {
        try {
          const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
          text = await fetch(`/api/files/${r.fileId}/content`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then((x) => x.text());
        } catch { text = ""; }
      }
      const p = parseCsvText(text);
      if (!p) { setMsg("无法解析数据文件(需含表头 CSV)"); return; }
      setParsed(p); setCsvText(text);
      setVariables(inferVariables(p.columnOrder, p.rows));
      setFileId(r.fileId);
      setFileName(file.name);
      // 同步到 jupyter 沙箱(代码方法可读; xlsx 转换后的 CSV 存为 .csv)
      const sandboxName = isXlsx ? file.name.replace(/\.(xlsx|xls)$/i, ".csv") : file.name;
      try {
        await fetch("/api/jupyter/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileName: sandboxName, content: text.slice(0, 4_000_000) }) });
      } catch { /* 沙箱可选 */ }
      notice?.(`已加载 ${file.name}${isXlsx ? "(xlsx 已转 CSV)" : ""}: ${p.rows.length} 行 × ${p.columnOrder.length} 列 — 统计法/计量法/代码共用`);
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

  // ── 粘贴 CSV(全部方法可用: 转 Blob 走 handleUpload 统一通道, 含 fileId) ──
  async function applyPaste() {
    const text = pasteText.trim();
    if (!text) return;
    const f = new File([text], `pasted_${Date.now()}.csv`, { type: "text/csv" });
    setShowPaste(false);
    await handleUpload(f);
    setPasteText("");
  }

  // ── 载入问卷仿真演示数据(apiEmpiricalDemo) ──
  async function loadDemoData() {
    try {
      const r = await fetch("/api/empirical/demo", { headers: { Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` } }).then((x) => x.json());
      if (!r.ok || !r.data) { setMsg("演示数据加载失败"); return; }
      // 组装 CSV 文本走 handleUpload(得到 fileId, 统计法可用)
      const col = (r.data.columnOrder ?? []) as string[];
      const csvText = [col.join(","), ...(r.data.rows ?? []).map((row: unknown[]) => row.map((v) => v === null ? "" : String(v)).join(","))].join("\n");
      const f = new File([csvText], "demo_问卷仿真.csv", { type: "text/csv" });
      await handleUpload(f);
    } catch {
      setMsg("演示数据加载失败");
    }
  }

  // ── 登记数据版本(内容哈希判重 + 自动画像, 同实证面板语义) ──
  /** 结果 → 成果可视化工坊: 带上当前数据集, 用户在工坊里可继续精修而不必重传 */
  function sendToWorkshop(kind: "stats" | "eco", title: string) {
    const res = kind === "stats" ? statsResult : ecoResult;
    if (!res) return;
    // 统计结果走数据回查(内存数据是"已持久化文件"的二等副本, 优先用文件里那份)
    if (kind === "stats") { void sendStatsJobToWorkshop(); return; }
    const cols = parsed?.columnOrder?.length
      ? parsed.columnOrder
      : (csvText.split(/\r?\n/)[0] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    try {
      window.dispatchEvent(new CustomEvent("empirical:open-viz-workshop", {
        detail: {
          title,
          csv: csvText,
          columnOrder: cols,
          message: `基于「${title}」分析结果重绘并优化图表: ${(res?.tables ?? [])[0]?.title ?? title}`,
        },
      }));
      notice?.("已送往成果可视化工坊");
    } catch { /* 忽略 */ }
  }

  /** 任务 → 原始数据集(数据真源是 user_files; 拿不到就明说, 不静默按无数据出图) */
  async function fetchJobDataset(jobId: string, rows = 200) {
    const tk = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
    const res = await fetch(`/api/statistics-jobs/${jobId}/dataset?rows=${rows}`, { headers: { Authorization: `Bearer ${tk}` } });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(j?.error ?? `数据回查失败 (${res.status})`);
    return (j?.dataset ?? null) as { title?: string; fileName?: string; columnOrder: string[]; rowCount: number; truncated?: boolean; sampleRows: unknown[][] } | null;
  }

  /** 行数组 → CSV(含引号转义) */
  function rowsToCsv(cols: string[], rows: unknown[][]): string {
    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.map(esc).join(","), ...rows.map((r) => (r ?? []).map(esc).join(","))].join("\n");
  }

  /** 统计任务 → 工坊: 回查原始数据集(最多 5000 行)再交给 viz 视图 */
  async function sendJobDatasetToWorkshop(jobId: string) {
    try {
      notice?.("正在回查原始数据集…");
      const ds = await fetchJobDataset(jobId, 5000);
      if (!ds?.columnOrder?.length) { notice?.("该统计结果没有可用数据"); return; }
      window.dispatchEvent(new CustomEvent("empirical:open-viz-workshop", {
        detail: {
          title: ds.title || "统计分析结果",
          csv: rowsToCsv(ds.columnOrder, ds.sampleRows),
          columnOrder: ds.columnOrder,
          message: `基于「${ds.title || "统计分析结果"}」的原始数据重绘并优化图表表达`,
        },
      }));
      notice?.(`已送往成果可视化工坊 (${ds.rowCount} 行${ds.truncated ? ", 取前 5000 行" : ""})`);
    } catch (e) {
      notice?.(`送工坊失败: ${(e as Error).message}`);
    }
  }

  /** 「送工坊精修」按钮: 当前任务优先, 没跑过就退回最近一次已完成的历史任务 */
  async function sendStatsJobToWorkshop() {
    const jobId = curJobId || historyJobs.find((h) => h.status === "completed")?.id || "";
    if (!jobId) { notice?.("没有可复用的统计任务, 请先跑一次分析"); return; }
    await sendJobDatasetToWorkshop(jobId);
  }

  async function registerVersion() {
    if (!parsed || !parsed.rows.length || versioning) return;
    setVersioning(true);
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(csvText || JSON.stringify(parsed)));
      const contentHash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      const name = `CSV_${parsed.rows.length}行_${new Date().toISOString().substring(0, 10)}`;
      const res = await fetch("/api/empirical/data-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` },
        body: JSON.stringify({ projectId: projectId || undefined, name, columns: parsed.columnOrder, nRows: parsed.rows.length, contentHash, rows: parsed.rows }),
      }).then((x) => x.json()).catch(() => null);
      if (res?.version) {
        notice?.(res.version.duplicate ? `数据版本已存在(重复内容, ${res.version.duplicateReason ?? ""})` : `已登记数据版本: ${name}`);
        void loadVersions();
      } else {
        setMsg("登记失败");
      }
    } catch (e: any) {
      setMsg(`登记失败: ${e?.message ?? e}`);
    } finally { setVersioning(false); }
  }

  // ── 代码 df 型变量 → 数据版本(沙箱 DataFrame 已带 __df__ 标记回传) ──
  const dfVars = Object.entries(kernelVars).filter(([, v]) => v && typeof v === "object" && (v as any).__df__ && Array.isArray((v as any).columns));

  async function registerDfVersion(name: string, val: unknown) {
    const df = val as { columns: string[]; records: Array<Record<string, unknown>> };
    const rows: (string | number | null)[][] = (df.records ?? []).map((rec) => df.columns.map((c) => {
      const v = rec[c];
      return v === undefined || v === null ? null : (typeof v === "number" ? v : String(v));
    }));
    if (!rows.length) { setMsg("df 无数据行"); return; }
    const vname = `${name}_df_${rows.length}行_${new Date().toISOString().substring(0, 10)}`;
    try {
      const res = await fetch("/api/empirical/data-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` },
        body: JSON.stringify({ projectId: projectId || undefined, name: vname, columns: df.columns, nRows: rows.length, rows }),
      }).then((x) => x.json()).catch(() => null);
      if (res?.version) {
        notice?.(`代码变量 ${name} 已登记为数据版本: ${vname}`);
        void loadVersions();
      } else setMsg("版本登记失败");
    } catch (e: any) { setMsg(`登记失败: ${e?.message ?? e}`); }
  }
  // ── 结果表 → jupyter 沙箱(代码可 pd.read_csv 引用分析结果) ──
  async function pushResultToSandbox(res: any, baseName: string): Promise<string | null> {
    try {
      const tables = res?.tables ?? [];
      if (!tables.length) return null;
      const lines: string[] = [];
      const t0 = tables[0];
      const cols = t0.columns ?? t0.cols ?? [];
      if (!cols.length) return null;
      const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      lines.push(cols.map(esc).join(","));
      for (const t of tables) {
        for (const r of (t.rows ?? [])) lines.push((r ?? []).map(esc).join(","));
      }
      const safeName = baseName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
      const fileName = `result_${safeName}.csv`;
      await fetch("/api/jupyter/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName, content: lines.join("\n") }),
      });
      return fileName;
    } catch { return null; }
  }

  // ── 从数据版本载入(问卷仿真/历史登记数据直通) ──
  async function loadVersions() {
    try {
      const r = await fetch(`/api/empirical/data-versions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` },
      }).then((x) => x.json()).catch(() => ({ versions: [] }));
      setVersions((r.versions ?? []) as typeof versions);
    } catch { /* 容忍 */ }
  }

  async function loadFromVersion(id: string) {
    const v = versions.find((x) => x.id === id);
    if (!v || !v.data) { setMsg("该版本无数据本体(需在登记时含行数据)"); return; }
    const p = { columnOrder: v.columns ?? [], rows: v.data ?? [] };
    setParsed(p);
    setCsvText([(v.columns ?? []).join(","), ...(v.data ?? []).map((r) => r.map((c) => c === null ? "" : String(c)).join(","))].join("\n"));
    setVariables(inferVariables(p.columnOrder, p.rows));
    setFileName(`版本:${v.name}`);
    setFileId(""); // 统计法需 fileId: 无则提示用代码/计量法, 或重新登记生成
    notice?.(`已载入数据版本 ${v.name}: ${v.data.length} 行 × ${v.columns.length} 列`);
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
    // 无 fileId(仿真/版本/粘贴数据) → 自动从 csvText 注册再跑(统计法需要 user-files)
    let runFileId = fileId;
    if (!runFileId && m.needData && csvText.trim()) {
      runFileId = await ensureFileIdFromCsv();
      if (!runFileId) { setMsg("请先在上方上传数据文件"); return; }
    }
    if (!runFileId) { setMsg("请先在上方上传数据文件"); return; }
    if (m.needVars && !selVars.size) { setMsg("请至少选择一个变量"); return; }
    const err = m.validate(params, [...selVars]);
    if (err) { setMsg(err); return; }
    setRunning(true); setJobStatus("queued"); setStatsResult(null); setStageLabel(""); setMsg("");
    try {
      const body: Record<string, unknown> = m.build(params, [...selVars], runFileId);
      body.tool = m.id;
      const { job } = await createStatsJobReact(body);
      const jid = job.id;
      setCurJobId(jid);
      localStorage.setItem("sag:stats-active-job", jid);
      watchJobDual(jid); // 双轨: SSE(白盒 stage/终态)+ 轮询兜底
    } catch (e: any) {
      setRunning(false); setMsg(`提交失败: ${e?.message ?? e}`);
    }
  }

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  /** 双轨监听一个 job: SSE + 轮询并行, 任一先到终态即收敛(另一轨 abort); 断流由轮询兜底 */
  function watchJobDual(jid: string) {
    let finished = false;
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      stopPoll();
      sseRef.current?.abort();
      sseRef.current = null;
      fn();
    };
    // SSE 轨(服务端推送终态/快照, 含白盒 stage)
    const sse = streamStatsJobReact(jid, {
      onSnapshot: (s) => { if (s.status) setJobStatus(s.status); if (s.stage) setStageLabel(s.stage); },
      onCompleted: (p) => finish(() => {
        setRunning(false); setCurJobId(""); setStageLabel("");
        localStorage.removeItem("sag:stats-active-job");
        setStatsResult(p.result ?? {});
        void pushResultToSandbox(p.result ?? {}, statsMethod?.name ?? "stats").then((fn) => {
          notice?.(fn ? `${statsMethod?.name ?? "分析"}完成 — 代码可读 ${fn}` : `${statsMethod?.name ?? "分析"}完成`);
        });
        void refreshStatsHistory();
      }),
      onFailed: (e) => finish(() => {
        setRunning(false); setJobStatus("failed"); setStageLabel("");
        const em = (e as { message?: string })?.message ?? "分析失败";
        setMsg(em);
        notice?.(`分析失败: ${em}`);
        void refreshStatsHistory();
      }),
      onCancelled: () => finish(() => {
        setRunning(false); setJobStatus(""); setCurJobId(""); setStageLabel(""); setMsg("任务已取消");
      }),
    });
    sseRef.current = sse;
    // 轮询兜底轨(SSE 断流/无终态事件时收敛; 700ms)
    pollRef.current = setInterval(async () => {
      try {
        const { job: j } = await getStatsJobReact(jid);
        setJobStatus(j.status);
        if (j.stage) setStageLabel(j.stage);
        if (j.status === "completed") {
          finish(() => {
            setRunning(false); setCurJobId(""); setStageLabel("");
            localStorage.removeItem("sag:stats-active-job");
            setStatsResult(j.result ?? {});
            void pushResultToSandbox(j.result ?? {}, statsMethod?.name ?? "stats").then((fn) => {
              notice?.(fn ? `${statsMethod?.name ?? "分析"}完成 — 代码可读 ${fn}` : `${statsMethod?.name ?? "分析"}完成`);
            });
            void refreshStatsHistory();
          });
        } else if (j.status === "failed") {
          finish(() => {
            setRunning(false); setJobStatus("failed"); setStageLabel("");
            const em = j.error?.message ?? "分析失败";
            setMsg(em);
            notice?.(`分析失败: ${em}`);
            void refreshStatsHistory();
          });
        } else if (j.status === "cancelled") {
          finish(() => { setRunning(false); setJobStatus(""); setCurJobId(""); setStageLabel(""); setMsg("任务已取消"); });
        }
      } catch { /* 网络瞬断容忍, 下一轮再试 */ }
    }, 700);
  }

  async function cancelStats() {
    if (!curJobId) return;
    stopPoll(); sseRef.current?.abort(); sseRef.current = null;
    setRunning(false); setCurJobId(""); setStageLabel(""); setMsg("正在取消…");
    await cancelStatsJobReact(curJobId).catch(() => null);
    setMsg("任务已取消"); setJobStatus("");
    localStorage.removeItem("sag:stats-active-job");
    void refreshStatsHistory();
  }

  async function retryStats() {
    if (!curJobId) return;
    const { job } = await retryStatsJobReact(curJobId).catch(() => ({ job: { id: curJobId, status: "queued" } }));
    setJobStatus(job.status); setRunning(true); setMsg("");
    watchJobDual(curJobId); // 双轨监听
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
    return () => { stopPoll(); sseRef.current?.abort(); sseRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runCell(i: number, cellOverride?: { type: "code" | "md"; content: string }) {
    const c = cellOverride ?? cells[i];
    if (!c) return;
    if (c.type === "md") { setCellOuts((prev) => { const n = [...prev]; n[i] = { ok: true, output: "", figures: [], variables: {} }; return n; }); return; }
    setRunningCell(i);
    try {
      const res = await fetch("/api/jupyter/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: c.content, sessionId, cellIndex: i }),
        signal: AbortSignal.timeout(90_000),
      }).then((r) => r.json()).catch(() => ({ result: { ok: false, output: "", error: "请求失败或超时", figures: [] } }));
      const rr = res.result as { ok: boolean; output: string; error?: string; figures?: string[]; variables?: Record<string, unknown> };
      setCellOuts((prev) => { const n = [...prev]; n[i] = rr; return n; });
      // 内核变量合并(跨单元持久显示)
      if (rr.variables && typeof rr.variables === "object") {
        setKernelVars((prev) => ({ ...prev, ...rr.variables }));
      }
    } finally { setRunningCell(null); }
  }

  function addCell(type: "code" | "md" = "code") {
    setCells((c) => [...c, { type, content: "" }]);
    setCellOuts((o) => [...o, null]);
  }

  function delCell(i: number) {
    setCells((c) => c.filter((_, j) => j !== i));
    setCellOuts((o) => o.filter((_, j) => j !== i));
  }

  function toggleCellType(i: number) {
    setCells((c) => c.map((v, j) => (j === i ? { ...v, type: v.type === "code" ? "md" : "code", content: v.type === "code" && v.content.trim() === "" ? "# 说明文本…" : v.content } : v)));
    setCellOuts((o) => o.map((v, j) => (j === i ? null : v)));
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
    setKernelVars({});
    try {
      await fetch("/api/jupyter/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: newId }) });
    } catch { /* 容忍 */ }
  }

  /** 载入演示 notebook(对齐 JupyterPanel DEMO_CELLS: md+代码, 自动运行全部) */
  async function loadDemo() {
    const newId = `nb-${Date.now()}`;
    setSessionId(newId);
    setCells(DEMO_CELLS);
    setCellOuts([]);
    setKernelVars({});
    try {
      await fetch("/api/jupyter/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: newId }) });
    } catch { /* 容忍 */ }
    setRunningAll(true);
    for (let i = 0; i < DEMO_CELLS.length; i++) {
      if (DEMO_CELLS[i].type === "md") continue;
      await runCell(i, DEMO_CELLS[i]);
    }
    setRunningAll(false);
    notice?.("演示 notebook 已载入并运行完成");
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
        <input ref={fileInputRef} type="file" accept=".csv,.txt,.tsv,.json,.xlsx,.xls" className="hidden"
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

      {/* ═══ 数据来源扩展: 粘贴 CSV / 载入问卷演示数据 / 登记数据版本 ═══ */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setShowPaste((v) => !v)}
          className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          {showPaste ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          粘贴 CSV
        </button>
        <button type="button" onClick={() => void loadDemoData()}
          className="rounded-md border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
          title="载入问卷仿真演示数据(269 列作答, 来自实证面板)">载入问卷演示数据</button>
        <button type="button" onClick={() => void registerVersion()}
          disabled={!hasData}
          className="rounded-md border border-blue-500/30 bg-blue-500/5 px-2 py-0.5 text-[10px] text-blue-600 hover:bg-blue-500/10 disabled:opacity-40"
          title="当前数据存为数据版本(哈希判重+自动画像)">登记数据版本</button>
        <select
          value=""
          onChange={(e) => { if (e.target.value) void loadFromVersion(e.target.value); }}
          className="max-w-[200px] rounded-md border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
          title="载入已登记数据版本(问卷仿真/历史数据直通)"
          onClick={() => { if (!versions.length) void loadVersions(); }}
        >
          <option value="">从数据版本载入…</option>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>{v.name} ({v.nRows ?? (v.data?.length ?? 0)}行)</option>
          ))}
        </select>
        {showPaste && (
          <div className="w-full rounded-lg border bg-muted/5 p-2">
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="粘贴 CSV(首行为列名, 逗号/分号/制表符分隔)…"
              spellCheck={false}
              className="h-24 w-full rounded-md border bg-background p-2 font-mono text-[11px]"
            />
            <button type="button" onClick={() => void applyPaste()}
              disabled={!pasteText.trim()}
              className="mt-1 rounded-md bg-emerald-600 px-3 py-1 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
              载入粘贴数据(全部方法可用)
            </button>
          </div>
        )}
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
              <button type="button" onClick={() => addCell("code")} className="w-full rounded-md border border-dashed py-1.5 text-[10px] text-muted-foreground hover:border-violet-500/40 hover:text-violet-600">+ 代码单元</button>
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
                <StatsParamForm methodId={statsMethod.id} fields={statsMethod.fields ?? []} values={params} onChange={(k, v) => setParams((p) => ({ ...p, [k]: v }))} vars={variables} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" disabled={running} onClick={() => void runStats()}
                  className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
                  {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} {running ? "分析中…" : "运行分析"}
                </button>
                {running && stageLabel && <span className="rounded bg-blue-500/10 px-2 py-1 text-[10px] font-medium text-blue-600">⏳ {stageLabel}</span>}
                {!running && jobStatus === "failed" && <span className="rounded bg-red-500/10 px-2 py-1 text-[10px] font-medium text-red-600">✗ 失败(可重试)</span>}
                {!running && jobStatus === "completed" && <span className="rounded bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-600">✓ 已完成</span>}
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
                  <>
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
                    <select
                      className="max-w-[160px] rounded-md border border-sky-500/30 bg-sky-500/5 px-1.5 py-1 text-[10px] text-sky-600"
                      value=""
                      onChange={(e) => { if (e.target.value) void sendJobDatasetToWorkshop(e.target.value); }}
                      title="选一条历史任务 → 回查其原始数据 → 送成果可视化工坊精修"
                    >
                      <option value="">送工坊精修…</option>
                      {historyJobs.filter((h) => h.status === "completed").map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.tool} · {(h.created_at ?? "").slice(5, 16).replace("T", " ")}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </>
          )}
          {pane === "eco" && ecoMethod && (
            <EcoMethodPane method={ecoMethod} data={{ parsed, csvText, preprocess: { winsorize: [], log: [], standardize: [] }, projectId }} onResult={(r) => {
              setEcoResult(r);
              if (r && (r.tables?.length ?? 0) > 0) {
                void pushResultToSandbox(r, ecoMethod?.label ?? "eco").then((fn) => {
                  if (fn) notice?.(`${ecoMethod?.label ?? "计量"}完成 — 代码可读 ${fn}`);
                });
              }
            }} />
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
                <button type="button" onClick={() => addCell("code")} className="rounded-md border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent">+ 代码</button>
                <button type="button" onClick={() => addCell("md")} className="rounded-md border border-purple-500/30 bg-purple-500/5 px-2 py-1 text-[10px] text-purple-600 hover:bg-purple-500/10">+ 说明(md)</button>
                <button type="button" onClick={() => void loadDemo()} className="rounded-md border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent" title="载入资本下乡调研数据演示(自动运行)">载入演示</button>
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
                  <button type="button" onClick={() => addCell("code")} className="mt-3 rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-[10px] font-medium text-violet-700 hover:bg-violet-500/20">+ 新建代码单元</button>
                </div>
              )}
              {/* 内核变量条(跨单元持久变量可视化, 对齐 JupyterPanel) */}
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 rounded-lg border bg-muted/20 px-2 py-1.5 text-[10px] text-muted-foreground">
                <span className="font-medium text-foreground/70">内核变量</span>
                {Object.keys(kernelVars).length > 0
                  ? Object.keys(kernelVars).slice(0, 12).map((k) => (
                      <span key={k} className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[9px] text-emerald-700">{k}</span>
                    ))
                  : <span>（无 — 运行代码后变量在此显示，可跨单元格复用）</span>}
                {Object.keys(kernelVars).length > 12 && <span className="text-[9px]">+{Object.keys(kernelVars).length - 12}</span>}
                {dfVars.length > 0 && (
                  <span className="ml-auto flex flex-wrap items-center gap-1">
                    <span className="text-[9px] text-blue-600">df 变量:</span>
                    {dfVars.slice(0, 4).map(([k, v]) => (
                      <button key={k} type="button"
                        onClick={() => void registerDfVersion(k, v)}
                        title={`将 ${k}(${(v as any).records?.length ?? 0} 行)登记为数据版本`}
                        className="rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[9px] text-blue-600 hover:bg-blue-500/20">
                        {k} → 存版本
                      </button>
                    ))}
                  </span>
                )}
              </div>
              {cells.map((c, i) => (
                <div key={i} className="overflow-hidden rounded-xl border bg-card/40">
                  <div className="flex items-center gap-1.5 border-b bg-muted/10 px-2 py-1">
                    <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">[{i}]</span>
                    {c.type === "code" ? (
                      <button type="button" onClick={() => toggleCellType(i)} title="切换为说明(md)" className="rounded bg-violet-500/10 px-1 py-0.5 text-[8px] font-semibold text-violet-600 hover:bg-violet-500/20">PY</button>
                    ) : (
                      <button type="button" onClick={() => toggleCellType(i)} title="切换为代码" className="rounded bg-purple-500/10 px-1 py-0.5 text-[8px] font-semibold text-purple-600 hover:bg-purple-500/20">MD</button>
                    )}
                    <span className="ml-auto flex items-center gap-0.5">
                      {c.type === "code" && (
                        <button type="button" onClick={() => void runCell(i)} disabled={runningCell === i}
                          className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-medium text-emerald-700 hover:bg-emerald-500/20 disabled:opacity-40">
                          {runningCell === i ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />} 运行
                        </button>
                      )}
                      <button type="button" onClick={() => delCell(i)} title="删除单元"
                        className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-600">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  </div>
                  {c.type === "md" ? (
                    <textarea value={c.content} spellCheck={false}
                      onChange={(e) => setCells((prev) => prev.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
                      className="min-h-[64px] w-full resize-y bg-transparent p-2 text-[11px] leading-relaxed outline-none"
                      placeholder="# Markdown 说明(支持标题/粗体/列表)" />
                  ) : (
                    <textarea value={c.content} spellCheck={false}
                      onChange={(e) => setCells((prev) => prev.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
                      className="min-h-[72px] w-full resize-y bg-transparent p-2 font-mono text-[11px] outline-none"
                      placeholder={'# 共享数据集: pd.read_csv("' + (fileName || "数据.csv") + '")'} />
                  )}
                  {cellOuts[i] && (
                    <div className="border-t bg-muted/5 px-2 py-1.5">
                      {cellOuts[i]!.ok ? <pre className="whitespace-pre-wrap font-mono text-[10px] text-foreground/80">{cellOuts[i]!.output || "(无输出)"}</pre>
                        : <pre className="whitespace-pre-wrap font-mono text-[10px] text-red-600">✗ {cellOuts[i]!.error}</pre>}
                      {(cellOuts[i]!.figures?.length ?? 0) > 0 && (
                        <div className="mt-1 space-y-1">
                          {cellOuts[i]!.figures!.map((b64, fi) => (
                            <img key={fi} src={`data:image/png;base64,${b64}`} alt={`输出图 ${fi + 1}`}
                              className="max-h-[320px] w-auto max-w-full rounded border bg-white" />
                          ))}
                        </div>
                      )}
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
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-semibold">分析结果</span>
                {statsResult && (
                  <>
                    <button type="button" onClick={() => exportResultMd("stats", statsResult, statsMethod?.name ?? "统计")}
                      className="rounded border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-accent">⤓ 导出 md</button>
                    <button type="button" onClick={() => sendResultToEditor(statsMethod?.name ?? "统计分析结果", mdFromResult(statsResult, statsMethod?.name ?? "统计"))}
                      className="rounded border border-violet-500/30 bg-violet-500/5 px-1.5 py-0.5 text-[9px] text-violet-600 hover:bg-violet-500/10">✎ 写入论文</button>
                    <button type="button" onClick={() => void sendToWorkshop("stats", statsMethod?.name ?? "统计")}
                      className="rounded border border-sky-500/30 bg-sky-500/5 px-1.5 py-0.5 text-[9px] text-sky-600 hover:bg-sky-500/10">◱ 送工坊精修</button>
                  </>
                )}
              </div>
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
          {pane === "eco" && (
            <>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-semibold">计量法结果</span>
                <div className="flex items-center gap-1">
                  {ecoResult && <button type="button" onClick={() => exportResultMd("eco", ecoResult, ecoMethod?.label ?? "计量")}
                    className="rounded border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-accent">⤓ 导出 md</button>}
                  {ecoResult && <button type="button" onClick={() => sendResultToEditor(ecoMethod?.label ?? "计量分析结果", mdFromResult(ecoResult, ecoMethod?.label ?? "计量"))}
                    className="rounded border border-violet-500/30 bg-violet-500/5 px-1.5 py-0.5 text-[9px] text-violet-600 hover:bg-violet-500/10">✎ 写入论文</button>}
                  {ecoResult && <button type="button" onClick={() => void sendToWorkshop("eco", ecoMethod?.label ?? "计量")}
                    className="rounded border border-sky-500/30 bg-sky-500/5 px-1.5 py-0.5 text-[9px] text-sky-600 hover:bg-sky-500/10">◱ 送工坊精修</button>}
                  {ecoResult && <button type="button" onClick={() => setEcoResult(null)} className="rounded border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-accent">清空</button>}
                </div>
              </div>
              {!ecoResult && <div className="py-8 text-center text-[10px] text-muted-foreground">执行计量法后在此显示回归表与系数图</div>}
              {ecoResult && (
                <div className="space-y-2">
                  {ecoResult.tables?.map((t: any, i: number) => (
                    <div key={i} className="overflow-x-auto rounded-lg border bg-card/50">
                      {t.title && <div className="border-b bg-muted/20 px-2 py-1 text-[10px] font-medium">{t.title}</div>}
                      <table className="w-full text-[10px]">
                        <thead><tr className="border-b bg-muted/10 text-left">{(t.cols ?? []).map((c: string, ci: number) => <th key={ci} className="px-2 py-1 font-medium">{c}</th>)}</tr></thead>
                        <tbody>{(t.rows ?? []).map((r: any[], ri: number) => (
                          <tr key={ri} className="border-b last:border-0 odd:bg-muted/5">{(r ?? []).map((v, ci) => <td key={ci} className={`px-2 py-1 ${ci === 0 ? "font-medium" : ""}`}>{cellText(v)}</td>)}</tr>
                        ))}</tbody>
                      </table>
                      {t.notes && <div className="border-t bg-muted/10 px-2 py-1 text-[9px] text-muted-foreground">{t.notes}</div>}
                    </div>
                  ))}
                  {ecoResult.figures?.map((f: any, i: number) => (
                    <div key={i} className="rounded-lg border bg-card/50 p-1.5">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-[10px] font-medium">{f.title}</span>
                        <button type="button" onClick={() => exportFigPng(`eco-r-${i}`, f.title || "图表")}
                          className="rounded border border-slate-300/40 px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-accent">⬇ PNG</button>
                      </div>
                      <div id={`eco-r-${i}`} dangerouslySetInnerHTML={{ __html: f.svg ?? "" }} />
                    </div>
                  ))}
                  {ecoResult.diagnostics?.map((d: any, i: number) => (
                    <div key={i} className="rounded-lg border bg-muted/20 p-2 text-[10px]">
                      <span className="font-medium">{d.name}:</span> <span className="text-muted-foreground">{d.verdict}</span>
                    </div>
                  ))}
                  {!ecoResult.tables?.length && !ecoResult.figures?.length && <div className="py-3 text-center text-[10px] text-muted-foreground">{ecoResult.warnings?.length ? ecoResult.warnings.join("; ") : "无输出内容"}</div>}
                </div>
              )}
            </>
          )}
          {pane === "code" && <div className="text-[11px] font-semibold text-muted-foreground">代码输出在单元内展示 · 变量跨单元持久</div>}
        </div>
      </div>
    </div>
  );
}

/** 统计法图表(plotly)懒加载渲染 */
function ChartPlaceholder({ charts }: { charts: any[] }) {  const ref = useRef<HTMLDivElement | null>(null);
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

/** 结果 markdown → 学术文本工作台: 顶层 CustomEvent, App.tsx 监听后导航 editor 并转发 iframe */
function sendResultToEditor(title: string, md: string) {
  try {
    window.dispatchEvent(new CustomEvent("empirical:open-editor-with-doc", { detail: { title, markdown: md } }));
  } catch { /* 忽略 */ }
}

/** 结果对象 → markdown(供导出与写入论文共用) */
function mdFromResult(res: any, title: string): string {
  const lines: string[] = [];
  lines.push(`## ${title} 分析结果`);
  lines.push("");
  const tables = (res?.tables ?? []) as any[];
  const figs = (res?.figures ?? res?.charts ?? []) as any[];
  if (!tables.length && !figs.length && !res?.diagnostics?.length) {
    lines.push("_(无输出内容)_");
  }
  for (const t of tables) {
    if (t.title) { lines.push(`### ${t.title}`); lines.push(""); }
    const cols = t.columns ?? t.cols ?? [];
    const rows = (t.rows ?? []) as unknown[][];
    if (cols.length) {
      lines.push(`| ${cols.join(" | ")} |`);
      lines.push(`|${cols.map(() => "---").join("|")}|`);
      for (const r of rows) lines.push(`| ${(r ?? []).map((v) => cellText(v).replace(/\|/g, "\\|")).join(" | ")} |`);
      lines.push("");
    }
    if (t.footnote || t.notes) lines.push(`> 注: ${t.footnote ?? t.notes}`);
  }
  for (const f of figs) lines.push(`![${f.title ?? "图表"}](图表: ${f.title ?? "见工作区"})`);
  for (const d of (res?.diagnostics ?? [])) lines.push(`- **${d.name}**: ${d.verdict}`);
  for (const w of (res?.warnings ?? [])) lines.push(`- ⚠ ${w}`);
  return lines.join("\n");
}

/** SVG 节点 → PNG 下载(计量法图导出) */function exportFigPng(elId: string, title: string) {
  try {
    const el = document.getElementById(elId);
    if (!el) return;
    const s = new XMLSerializer().serializeToString(el);
    const blob = new Blob([s], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const rect = el.getBoundingClientRect();
        const w = Math.max(400, Math.ceil(rect.width || 800) * 2);
        const h = Math.max(300, Math.ceil(rect.height || 500) * 2);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const a = document.createElement("a");
        a.href = canvas.toDataURL("image/png");
        a.download = `${title.replace(/[\/:*?"<>|]/g, "_").slice(0, 60)}.png`;
        a.click();
      } catch { /* 降级忽略 */ }
    };
    img.onerror = () => { /* SVG 渲染失败忽略 */ };
    img.src = url;
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch { /* 导出失败忽略 */ }
}

/** 当前结果 → Markdown 报告片段下载(表→md 表格, 图→占位说明, 诊断→列表) */
function exportResultMd(kind: "stats" | "eco", res: any, title: string) {
  try {
    const md = mdFromResult(res, title);
    const a = document.createElement("a");
    a.href = "data:text/markdown;charset=utf-8," + encodeURIComponent(md);
    a.download = `${title.replace(/[\/:*?"<>|]/g, "_").slice(0, 40)}_结果.md`;
    a.click();
  } catch { /* 导出失败忽略 */ }
}
