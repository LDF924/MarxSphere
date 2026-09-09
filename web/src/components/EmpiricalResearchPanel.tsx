// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// EmpiricalResearchPanel.tsx — 实证研究执行工作台（V348+）
// 数据上传 → 选方法 → Python 沙箱执行 → 结果展示(回归表/系数图/诊断)
// 骨架照抄 EducationPanel: 全高 flex column + 顶栏 + flex-1 内容区
import { useState, useEffect, type FC } from "react";
import { FlaskConical, Upload, Play, RotateCcw, Table2, AlertTriangle, CheckCircle2, FileUp, ArrowRight, Wand2, History, Download, BookOpen, Trash2, Stethoscope, Database, ListChecks, Workflow, LineChart, BookMarked } from "lucide-react";
import { apiEmpirical, apiEmpiricalWorkshop, apiEmpiricalDemo } from "../lib/api";
import { readResume } from "./ResearchHistoryPanel";
import { Button } from "./ui/button";
import { ToolRunner } from "./ToolRunner";
import { Card } from "./ui/card";
import { NavRail, type SectionId } from "./empirical/NavRail";
import UnifiedWorkspace from "../empirical/UnifiedWorkspace";
import { GeneratorPage } from "./empirical/GeneratorPage";
import { RecognizePage } from "./empirical/RecognizePage";
import { DataVersionBar } from "./empirical/DataVersionBar";
import { PipelineOverview } from "./empirical/PipelineOverview";
import { ReliabilityPage } from "./empirical/ReliabilityPage";
import { DiagnosisPage } from "./empirical/DiagnosisPage";
import { ImputationPage } from "./empirical/ImputationPage";
import { VariablesPage } from "./empirical/VariablesPage";
import { DataPipelinePage } from "./empirical/DataPipelinePage";
import { RegressionPage } from "./empirical/RegressionPage";
import { LedgerPage } from "./empirical/LedgerPage";
import { InterpretationPage } from "./empirical/InterpretationPage";

interface MethodDef {
  id: string; label: string; en: string; desc: string; category: string; engine: string; skills: string[];
}
interface EmpResult {
  meta?: any; tables?: any[]; figures?: any[]; diagnostics?: any[]; warnings?: string[];
}

const DEMO_CSV = `unit,year,treat,post,y
1,2019,1,0,11.2
1,2020,1,0,12.1
1,2021,1,1,15.8
1,2022,1,1,16.9
2,2019,1,0,10.5
2,2020,1,0,11.3
2,2021,1,1,14.2
2,2022,1,1,15.1
3,2019,1,0,12.8
3,2020,1,0,13.4
3,2021,1,1,17.5
3,2022,1,1,18.2
4,2019,0,0,9.8
4,2020,0,0,10.2
4,2021,0,0,10.5
4,2022,0,0,11.0
5,2019,0,0,11.1
5,2020,0,0,11.5
5,2021,0,0,11.9
5,2022,0,0,12.3
6,2019,0,0,10.2
6,2020,0,0,10.8
6,2021,0,0,11.0
6,2022,0,0,11.4`;
// DiD 需要绝对年份时间列: 生成 treat_time 列 (处理组 2021 处理, 对照组 9999)
const DEMO_DID_CSV = DEMO_CSV.replace(
  "unit,year,treat,post,y",
  "unit,year,treat,treat_time,y"
).split("\n").map((line, i) => {
  if (i === 0) return line;
  const cells = line.split(",");
  // treat=1 → 处理时间 2021; treat=0 → 9999 (未处理)
  const tt = cells[2] === "1" ? "2021" : "9999";
  return [cells[0], cells[1], cells[2], tt, cells[4]].join(",");
}).join("\n");

function parseCsv(text: string): { columnOrder: string[]; rows: (string | number | null)[][] } | null {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const delimiter = text.includes(";") ? ";" : text.includes("\t") ? "\t" : ",";
  const columnOrder = lines[0].split(delimiter).map((c) => c.trim());
  const rows = lines.slice(1).map((l) => {
    const cells = l.split(delimiter);
    return columnOrder.map((_, i) => {
      const raw = (cells[i] ?? "").trim();
      if (raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    });
  });
  return { columnOrder, rows };
}

// C5(闭源 StatisticsView PNG 导出三级降级): SVG→Blob→Image→canvas→PNG(scale 2),
//   失败兜底 dataURL 直存; 产物 Blob 下载
function svgToPngDownload(svgEl: HTMLElement, title: string) {
  try {
    const s = new XMLSerializer().serializeToString(svgEl);
    const blob = new Blob([s], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const rect = svgEl.getBoundingClientRect();
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
        a.download = `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.png`;
        a.click();
      } catch { /* 降级: dataURL 直存失败忽略 */ }
    };
    img.onerror = () => { /* SVG 渲染失败忽略 */ };
    img.src = url;
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch { /* 导出失败忽略 */ }
}

function CoefFigure({ fig }: { fig: any }) {
  return (
    <div className="rounded-lg border p-2">
      <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
        <span>{fig.title}</span>
        <button onClick={() => { const el = document.getElementById(`fig-${fig.id ?? ""}`); if (el) svgToPngDownload(el, fig.title || "图表"); }}
          title="导出 PNG" className="rounded border border-slate-200 px-1.5 py-0.5 text-[9px] hover:bg-slate-100">
          <Download className="h-3 w-3" /> PNG
        </button>
      </div>
      <div id={`fig-${fig.id ?? ""}`} dangerouslySetInnerHTML={{ __html: fig.svg }} />
    </div>
  );
}

// C8(闭源 StatisticsView 数值格式): |x|≥1000 或 <0.001 → 科学计数3位; <0.01 → 4位小数;
//   整数原样; 否则 3 位有效
function fmtNum(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return v === null ? "" : String(v);
  const a = Math.abs(v);
  if (a >= 1000 || (a > 0 && a < 0.001)) return v.toExponential(3);
  if (a > 0 && a < 0.01) return v.toFixed(4);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(3);
}

function ResultTable({ t }: { t: any }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <div className="border-b bg-muted/30 px-2 py-1 text-[11px] font-medium">{t.title}</div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b bg-muted/20 text-left">
            {t.cols.map((c: string, i: number) => (
              <th key={i} className="px-2 py-1 font-medium">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r: any[], ri: number) => (
            <tr key={ri} className="border-b last:border-0">
              {r.map((v, ci) => (
                <td key={ci} className={`px-2 py-1 ${ci === 0 ? "font-medium" : ""} ${typeof v === "number" && Math.abs(v) < 0.05 && v !== 0 ? "text-red-600" : ""}`}>{fmtNum(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {t.notes && <div className="border-t bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">{t.notes}</div>}
    </div>
  );
}

export const EmpiricalResearchPanel: FC = () => {
  const [flowStep, setFlowStep] = useState<"data" | "config" | "result">("data");
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [dataVersionId, setDataVersionId] = useState<string | null>(null);
  const [gateStatuses, setGateStatuses] = useState<any[]>([]);
  const [methods, setMethods] = useState<MethodDef[]>([]);
  const [selectedMethod, setSelectedMethod] = useState<MethodDef | null>(null);
  const [csv, setCsv] = useState("");
  const [parsed, setParsed] = useState<{ columnOrder: string[]; rows: (string | number | null)[][] } | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<EmpResult | null>(null);
  const [error, setError] = useState("");
  const [meta, setMeta] = useState<{ venvReady: boolean; statsModels: boolean; statspai: boolean; python: string } | null>(null);
  const [skills, setSkills] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyDetail, setHistoryDetail] = useState<any>(null);
  const [notice, setNotice] = useState("");
  // V413: 流水线总览刷新(仿真/信效度/识别完成后 +1 触发重拉)
  const [pipelineRefreshKey, setPipelineRefreshKey] = useState(0);
  const [datasets, setDatasets] = useState<any[]>([]);
  const [preprocess, setPreprocess] = useState<{ winsorize: string[]; log: string[]; standardize: string[] }>({ winsorize: [], log: [], standardize: [] });

  // 初始化: 加载方法目录 + venv 状态 + 关联技能 + 历史
  useEffect(() => {
    void apiEmpirical.methods().then((r) => setMethods(r.methods)).catch(() => {});
    void apiEmpirical.meta().then(setMeta).catch(() => {});
    void apiEmpirical.skills().then((r) => setSkills(r.skills)).catch(() => {});
    loadHistory();
    void apiEmpirical.datasets().then((r) => setDatasets(r.datasets as any[])).catch(() => {});
    // 历史中心 deep-resume: 从历史记录 statistics 区卡点击跳入 → 自动打开对应实证记录
    const r = readResume("statistics");
    if (r?.id) {
      setShowHistory(true);
      void apiEmpirical.historyDetail(String(r.id)).then((d) => setHistoryDetail((d as any).record)).catch(() => {});
    }
  }, []);

  const loadHistory = () => {
    void apiEmpirical.history(10).then((r) => setHistory(r.history as any[])).catch(() => {});
  };

  const openHistory = async (id: string) => {
    try {
      const r = await apiEmpirical.historyDetail(id);
      setHistoryDetail((r as any).record);
    } catch { setNotice("历史详情加载失败"); }
  };

  const deleteHistory = async (id: string) => {
    if (!window.confirm("删除该历史记录?")) return;
    await apiEmpirical.historyDelete(id).catch(() => {});
    loadHistory();
    if (historyDetail?.id === id) setHistoryDetail(null);
  };

  const exportResult = async (format: "latex" | "csv") => {
    const rid = (historyDetail as any)?.id;
    if (!rid) { setNotice("请先打开一条历史记录"); return; }
    try {
      const text = await apiEmpirical.export(format, rid);
      const blob = new Blob([text], { type: format === "latex" ? "text/plain" : "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `empirical-${rid.slice(0, 8)}.${format === "latex" ? "tex" : "csv"}`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`已导出 ${format.toUpperCase()}`);
    } catch { setNotice("导出失败"); }
  };

  const saveKnowledge = async () => {
    const rid = (historyDetail as any)?.id;
    if (!rid) { setNotice("请先打开一条历史记录"); return; }
    try {
      const r = await apiEmpirical.saveKnowledge(rid);
      setNotice(r.ok ? "已存为知识页 ✅" : "保存失败");
    } catch { setNotice("保存失败"); }
  };

  const pickMethod = (m: MethodDef) => {
    setSelectedMethod(m);
    setParams({});
    setFlowStep("config");
  };

  const handleFile = (file: File) => {
    setUploading(true);
    const reader = new FileReader();
    reader.onload = () => {
      const p = parseCsv(String(reader.result ?? ""));
      if (p) { setParsed(p); setCsv(String(reader.result)); }
      setUploading(false);
    };
    reader.readAsText(file);
  };

  const loadDemo = () => {
    // 全量演示: 基于农村经营形态问卷 PDF 生成的 50 份模拟作答(269列)
    void apiEmpiricalDemo.load().then((r) => {
      if (r.ok && r.data) {
        setCsv("");  // 数据来自 API, 文本区留空
        setParsed(r.data);
        setNotice(`已载入演示数据: ${r.data.rows.length} 行 × ${r.data.columnOrder.length} 列 (${r.meta?.source ?? ""})`);
      }
    }).catch(() => setNotice("演示数据加载失败"));
  };

  // V399-2 P2 补齐: 数据版本登记（ScienceX 实验表格登记）— 当前解析数据存为数据版本
  // 内容哈希(sha256) + 行数据(自动画像) 随登记提交; 同内容重传服务端判重返回 duplicate
  const [savingVersion, setSavingVersion] = useState(false);
  const registerDataVersion = async () => {
    if (!parsed || parsed.rows.length === 0) { setNotice("无有效数据可登记（先上传/粘贴 CSV）"); return; }
    setSavingVersion(true);
    try {
      // Web Crypto sha256（内容哈希 = 判重/溯源键）
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(csv || JSON.stringify(parsed)));
      const contentHash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      const name = `CSV_${parsed.rows.length}行_${new Date().toISOString().substring(0, 10)}`;
      const res = await apiEmpiricalWorkshop.saveDataVersion({
        name, columns: parsed.columnOrder, nRows: parsed.rows.length, contentHash,
        rows: parsed.rows,  // V399-2 P2: 行数据 → 服务端自动生成列画像存 meta.profile
      });
      const v = res.version;
      setNotice(v.duplicate
        ? `⚠️ 同内容已登记（duplicate, 哈希命中 ${contentHash.substring(0, 8)}…）— 未新建版本`
        : `✅ 数据版本已登记: ${name}（${parsed.rows.length} 行 × ${parsed.columnOrder.length} 列 · 哈希 ${contentHash.substring(0, 8)}…）`);
    } catch (e: any) {
      setError(String(e?.message || e).substring(0, 120));
    } finally {
      setSavingVersion(false);
    }
  };

  const loadFromPg = async (table: string) => {
    setUploading(true);
    try {
      const r = await apiEmpirical.fetchDataset(table, 2000);
      const data = (r as any).data;
      if (data) {
        // 转 CSV 文本
        const esc = (v: any) => String(v ?? "").includes(",") ? `"${String(v ?? "")}"` : String(v ?? "");
        const csvText = [data.columnOrder.join(","), ...data.rows.map((row: any[]) => row.map(esc).join(","))].join("\n");
        setCsv(csvText);
        setParsed(data);
        setNotice(`已从 PG 加载表 ${table} (${data.rows.length} 行)`);
      }
    } catch { setNotice("数据源加载失败"); }
    setUploading(false);
  };

  const runAnalysis = async () => {
    if (!parsed || !selectedMethod) return;
    setRunning(true);
    setError("");
    try {
      // genvars/filter 的 JSON 字符串参数解析为数组
      const runParams: Record<string, unknown> = { ...params };
      if (selectedMethod.id === "genvars" && runParams.formulas) {
        try { runParams.formulas = JSON.parse(String(runParams.formulas)); } catch { setError("公式 JSON 格式错误"); setRunning(false); return; }
      }
      if (selectedMethod.id === "filter" && runParams.conditions) {
        try { runParams.conditions = JSON.parse(String(runParams.conditions)); } catch { setError("条件 JSON 格式错误"); setRunning(false); return; }
      }
      if (["logit", "ologit", "mnl", "crosstab"].includes(selectedMethod.id) && runParams.xs) {
        runParams.xs = String(runParams.xs).split(",").map((x) => x.trim()).filter(Boolean);
      }
      const r = await apiEmpirical.run({ data: parsed, method: selectedMethod.id, params: runParams, preprocess, projectId });
      if (!r.ok) { setError(r.error ?? "提交失败"); setRunning(false); return; }
      // 轮询结果(V381: 对齐后端 300s 超时, 200 次 × 1.5s; 超时提示可去历史查看)
      let timedOut = true;
      for (let i = 0; i < 200; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const s = await apiEmpirical.result(r.taskId);
        if (s.status === "done") { setResult(s.result ?? {}); setFlowStep("result"); timedOut = false; setPipelineRefreshKey((k) => k + 1); break; }
        if (s.status === "error") { setError(s.error ?? "执行失败"); timedOut = false; break; }
        if (s.status === "not_found") { setError("任务不存在(服务可能重启)"); timedOut = false; break; }
      }
      if (timedOut) setError("任务仍在执行中(超过 300s)— 结果会自动保存, 可稍后到「历史」查看");
    } catch (e: any) { setError(String(e?.message ?? e)); }
    setRunning(false);
  };

  const gotoSkills = () => {
    // V381 fix: hash 直接赋值不触发 App 的 popstate 监听 → 改为 pushState + dispatch(与 App.navigateView 一致)
    window.history.pushState({ view: "skills" }, "", "#skills");
    window.dispatchEvent(new PopStateEvent("popstate", { state: { view: "skills" } }));
  };

  // 课题(项目)选择器: 创建/切换, 全局共享给所有功能页
  const [projects, setProjects] = useState<any[]>([]);
  const [projectMenu, setProjectMenu] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");

  const loadProjects = () => {
    void apiEmpiricalWorkshop.projects().then((r) => {
      setProjects(r.projects);
      // 自动选第一个(若未选)
      if (!projectId && r.projects.length > 0) setProjectId(r.projects[0].id);
    }).catch(() => {});
  };
  useEffect(() => { loadProjects(); }, []);

  // 课题变化时加载闸门状态
  useEffect(() => {
    if (!projectId) { setGateStatuses([]); return; }
    void apiEmpirical.gates(projectId).then((r) => setGateStatuses(r.gates)).catch(() => {});
  }, [projectId]);

  const createProject = async () => {
    if (!newProjectTitle.trim()) return;
    try {
      const r = await apiEmpiricalWorkshop.createProject({ title: newProjectTitle.trim() });
      setProjectId(r.project.id);
      setNewProjectTitle("");
      setProjectMenu(false);
      loadProjects();
    } catch { /* 忽略 */ }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <FlaskConical className="h-4 w-4 text-emerald-600" />
        <h2 className="text-sm font-semibold">实证研究</h2>
        <span className="text-[10px] text-muted-foreground">数据 → 方法 → Python 沙箱执行 → 结果</span>
        <div className="ml-auto flex items-center gap-2">
          {/* 课题选择 */}
          <div className="relative">
            <button className="flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[10px] hover:bg-accent" onClick={() => setProjectMenu((v) => !v)}>
              <BookOpen className="h-3 w-3 text-emerald-600" />
              {projects.find((p) => p.id === projectId)?.title ?? "选择课题"}
              <span className="text-muted-foreground">▾</span>
            </button>
            {projectMenu && (
              <div className="absolute right-0 z-20 mt-1 w-64 rounded-lg border bg-card p-2 shadow-lg">
                <div className="mb-1 text-[9px] font-semibold text-muted-foreground">课题列表({projects.length})</div>
                <div className="max-h-40 space-y-0.5 overflow-y-auto">
                  {projects.map((p) => (
                    <button key={p.id} className={`block w-full rounded px-1.5 py-1 text-left text-[10px] hover:bg-accent ${p.id === projectId ? "bg-emerald-500/10 text-emerald-700" : ""}`}
                      onClick={() => { setProjectId(p.id); setProjectMenu(false); }}>
                      {p.title}
                    </button>
                  ))}
                  {projects.length === 0 && <div className="px-1.5 py-1 text-[9px] text-muted-foreground">暂无课题, 请先创建</div>}
                </div>
                <div className="mt-1.5 flex gap-1 border-t pt-1.5">
                  <input className="flex-1 rounded border bg-background px-1.5 py-1 text-[10px]" placeholder="新课题名…" value={newProjectTitle} onChange={(e) => setNewProjectTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void createProject(); }} />
                  <button className="rounded border px-2 py-1 text-[10px] hover:bg-accent" onClick={() => void createProject()}>创建</button>
                </div>
              </div>
            )}
          </div>
          {meta && (
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className={`flex items-center gap-0.5 ${meta.venvReady ? "text-emerald-600" : "text-red-600"}`}><CheckCircle2 className="h-3 w-3" />Python {meta.python}</span>
              <span className={`flex items-center gap-0.5 ${meta.statsModels ? "text-emerald-600" : "text-red-600"}`}><CheckCircle2 className="h-3 w-3" />statsmodels</span>
              <span className={`flex items-center gap-0.5 ${meta.statspai ? "text-emerald-600" : "text-red-600"}`}><CheckCircle2 className="h-3 w-3" />statspai</span>
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={gotoSkills}><Wand2 className="mr-1 h-3 w-3" />技能面板</Button>
          <Button size="sm" variant="outline" onClick={() => { setShowHistory((v) => !v); if (!showHistory) loadHistory(); }}>
            <History className="mr-1 h-3 w-3" />历史
          </Button>
        </div>
      </div>

      {/* 历史抽屉 */}
      {showHistory && (
        <div className="border-b bg-muted/20 px-4 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold text-muted-foreground">历史记录 (最近 {history.length})</span>
            <button className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setShowHistory(false)}>关闭 ×</button>
          </div>
          {history.length === 0 ? (
            <div className="py-2 text-center text-[10px] text-muted-foreground">暂无历史 — 跑一次分析后自动保存</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {history.map((h: any) => (
                <div key={h.id} className="flex items-center gap-1 rounded-lg border bg-background px-2 py-1 text-[10px]">
                  <button className="font-medium hover:text-emerald-600" onClick={() => void openHistory(h.id)}>{h.method}</button>
                  <span className="text-muted-foreground">{h.meta?.n ? `N=${h.meta.n}` : ""} · {new Date(h.created_at).toLocaleTimeString()}</span>
                  <button className="text-muted-foreground hover:text-red-600" onClick={() => void deleteHistory(h.id)}><Trash2 className="h-3 w-3" /></button>
                </div>
              ))}
            </div>
          )}
          {historyDetail && (
            <div className="mt-2 rounded-lg border bg-background p-2">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[11px] font-semibold">{historyDetail.method} · {historyDetail.title}</span>
                <span className="text-[10px] text-muted-foreground">{new Date(historyDetail.created_at).toLocaleString()}</span>
                {/* SocialSci R6: 计费状态 */}
                {(historyDetail.charge_points > 0 || historyDetail.billing_status) && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                    消耗 {(historyDetail.charge_points ?? 0)} 积分 · {historyDetail.billing_status === "settled" ? "已结算" : historyDetail.billing_status === "frozen" ? "冻结中" : historyDetail.billing_status || "未计费"}
                  </span>
                )}
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => void exportResult("latex")}><Download className="mr-1 h-3 w-3" />LaTeX</Button>
                  <Button size="sm" variant="outline" onClick={() => void exportResult("csv")}><Download className="mr-1 h-3 w-3" />CSV</Button>
                  <Button size="sm" variant="outline" onClick={() => void saveKnowledge()}><BookOpen className="mr-1 h-3 w-3" />存为知识页</Button>
                </div>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {((historyDetail.result as any)?.tables ?? []).map((t: any, i: number) => <ResultTable key={i} t={t} />)}
              </div>
            </div>
          )}
          {notice && <div className="mt-1 text-[10px] text-emerald-600">{notice}</div>}
        </div>
      )}

      {/* 内容区 */}
      <div className="flex min-h-0 flex-1">
        {/* 左: 功能导航 */}
        <div className="w-[190px] shrink-0 overflow-y-auto border-r p-2">
          <NavRail
            active={activeSection}
            onSelect={(s) => { setActiveSection(s); if (s !== "methods") setFlowStep("data"); }}
          />
        </div>

        {/* 右: 工作区(统一分析台需要全高 → methods 区段去 padding) */}
        <div className={`min-w-0 flex-1 ${activeSection === "methods" ? "overflow-hidden" : "overflow-y-auto p-4"}`}>
          {activeSection === "overview" && (
            <div className="mx-auto w-full max-w-[1400px] space-y-3">
              <Card className="p-3">
                <div className="mb-2 flex items-center gap-2">
                  <FlaskConical className="h-4 w-4 text-emerald-600" />
                  <span className="text-xs font-semibold">实证研究工作台</span>
                  <span className="text-[10px] text-muted-foreground">完整研究流水线: 问卷设计 → 识别 → 信效度 → 诊断 → 插补 → 变量敲定 → 管道 → 回归 → 证据账本</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {([
                    ["generator", "问卷生成器", "按课题生成结构化问卷"],
                    ["recognize", "问卷识别", "上传问卷自动识别主体/指标/变量"],
                    ["reliability", "信效度", "克隆巴赫α / KMO / 因子分析"],
                    ["diagnosis", "数据诊断", "前期数据+田野信息 → 问卷问题与补齐方案"],
                    ["imputation", "LLM插补", "非随机缺失/敏感题空答乱答插补(论文方法)"],
                    ["variables", "变量敲定", "被解释/核心解释/控制/识别策略 + 人工闸门"],
                    ["pipeline", "数据管道", "缺失统计/缩尾/变量构造/筛选/描述 + Stata 代码"],
                    ["regression", "回归生成", "基准/FE/聚类SE/稳健性/安慰剂/IV/事件研究"],
                    ["interpretation", "结果解释", "回归结果 → LLM 草稿 → 人工确认(解锁账本)"],
                    ["ledger", "证据账本", "系数→代码/数据表/原始数据/文献 四维绑定"],
                    ["methods", "统一分析台", "统计17法 / 计量19法 / Python代码 一份数据全打通"],
                  ] as const).map(([id, label, desc]) => (
                    <button key={id} onClick={() => { setActiveSection(id as SectionId); setFlowStep("data"); }} className="rounded-lg border p-2 text-left transition-colors hover:bg-accent">
                      <div className="text-[11px] font-semibold">{label}</div>
                      <div className="mt-0.5 text-[9px] text-muted-foreground">{desc}</div>
                    </button>
                  ))}
                </div>
                <div className="mt-2 border-t pt-2">
                  <DataVersionBar projectId={projectId} value={dataVersionId} onChange={(v) => {
                    setDataVersionId(v?.id ?? null);
                    // V399-2 P2(092): 选中数据版本 → 其数据本体载入 parsed, 分析真正用该版本数据
                    if (v?.data && v.data.length > 0) {
                      setParsed({ columnOrder: v.columns, rows: v.data as (string | number | null)[][] });
                      setNotice(`已载入数据版本: ${v.name}（${v.data.length} 行 × ${v.columns.length} 列）`);
                    } else if (v?.columns) {
                      setParsed({ columnOrder: v.columns, rows: [] });
                    }
                  }} />
                </div>
                {/* V413: 课题流水线总览(问卷→数据→分析全链时间线) */}
                {projectId && <PipelineOverview projectId={projectId} refreshKey={pipelineRefreshKey} />}
                {/* 闸门状态总览 */}
                {projectId && (
                  <div className="mt-2 rounded-lg border bg-muted/20 p-2">
                    <div className="mb-1 text-[10px] font-semibold text-muted-foreground">人工闸门进度(4 节点)</div>
                    <div className="flex items-center gap-1">
                      {["topic", "variable_definition", "identification", "result_interpretation"].map((node, i) => {
                        const g = gateStatuses.find((x) => x.node === node);
                        const done = g?.status === "confirmed";
                        return (
                          <div key={node} className="flex flex-1 items-center gap-1">
                            <button
                              onClick={() => setActiveSection(node === "topic" ? "variables" : node === "variable_definition" ? "variables" : node === "identification" ? "variables" : "interpretation")}
                              className={`flex-1 rounded border px-1.5 py-1 text-center text-[9px] ${done ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700" : "border-muted bg-card text-muted-foreground"}`}
                              title={`${g?.status ?? "未创建"}${g && g.reopens > 0 ? ` (退回${g.reopens}次)` : ""}`}
                            >
                              {done ? "✅" : "⏳"} {i + 1}.{["选题", "变量定义", "识别策略", "结果解释"][i]}
                            </button>
                            {i < 3 && <span className="text-muted-foreground">→</span>}
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-1 text-[9px] text-muted-foreground">点击节点跳转对应页面; 全部 ✅ 后证据账本解锁</div>
                  </div>
                )}
              </Card>
            </div>
          )}

          {activeSection === "generator" && (
            <div className="mx-auto w-full max-w-[1400px] space-y-3">
              <GeneratorPage projectId={projectId} />
            </div>
          )}

          {activeSection === "recognize" && (
            <div className="mx-auto w-full max-w-[1400px] space-y-3">
              <RecognizePage
                projectId={projectId}
                onSimLoaded={(data) => {
                  setParsed(data);
                  // 转 CSV 文本(供下游数据版本/管道用)
                  const esc = (v: unknown) => String(v ?? "").includes(",") ? `"${String(v ?? "")}"` : String(v ?? "");
                  setCsv([data.columnOrder.join(","), ...data.rows.map((row) => row.map(esc).join(","))].join("\n"));
                  setNotice(`✅ 仿真数据已载入工作台: ${data.rows.length} 行 × ${data.columnOrder.length} 列 — 可直接做信效度/回归/插补`);
                  setPipelineRefreshKey((k) => k + 1);  // 刷新流水线总览
                }}
              />
            </div>
          )}

          {activeSection === "reliability" && (
            <div className="mx-auto w-full max-w-[1400px]">
              <ReliabilityPage projectId={projectId} onDone={() => setPipelineRefreshKey((k) => k + 1)} />
            </div>
          )}

          {activeSection === "diagnosis" && (
            <div className="mx-auto w-full max-w-[1400px]">
              <DiagnosisPage projectId={projectId} />
            </div>
          )}

          {activeSection === "imputation" && (
            <div className="mx-auto w-full max-w-[1400px]">
              <ImputationPage projectId={projectId} />
            </div>
          )}

          {activeSection === "variables" && (
            <div className="mx-auto w-full max-w-[1400px]">
              <VariablesPage projectId={projectId} />
            </div>
          )}

          {activeSection === "pipeline" && (
            <div className="mx-auto w-full max-w-[1400px]">
              <DataPipelinePage projectId={projectId} />
            </div>
          )}

          {activeSection === "regression" && (
            <div className="mx-auto w-full max-w-[1400px]">
              <RegressionPage projectId={projectId} />
            </div>
          )}

          {activeSection === "ledger" && (
            <div className="mx-auto w-full max-w-[1400px]">
              <LedgerPage projectId={projectId} />
            </div>
          )}

          {activeSection === "interpretation" && (
            <div className="mx-auto w-full max-w-[1400px]">
              <InterpretationPage projectId={projectId} />
            </div>
          )}

          {activeSection === "methods" && (
            <div className="h-full min-h-0 w-full">
              <UnifiedWorkspace
                parsed={parsed}
                setParsed={setParsed}
                csvText={csv}
                setCsvText={setCsv}
                projectId={projectId}
                notice={(m) => setNotice(m)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
