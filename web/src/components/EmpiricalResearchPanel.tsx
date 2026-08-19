// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// EmpiricalResearchPanel.tsx — 实证研究执行工作台（V348+）
// 数据上传 → 选方法 → Python 沙箱执行 → 结果展示(回归表/系数图/诊断)
// 骨架照抄 EducationPanel: 全高 flex column + 顶栏 + flex-1 内容区
import { useState, useEffect, type FC } from "react";
import { FlaskConical, Upload, Play, RotateCcw, Table2, AlertTriangle, CheckCircle2, FileUp, ArrowRight, Wand2, History, Download, BookOpen, Trash2, Stethoscope, Database, ListChecks, Workflow, LineChart, BookMarked } from "lucide-react";
import { apiEmpirical, apiEmpiricalWorkshop, apiEmpiricalDemo } from "../lib/api";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { NavRail, type SectionId } from "./empirical/NavRail";
import { GeneratorPage } from "./empirical/GeneratorPage";
import { RecognizePage } from "./empirical/RecognizePage";
import { DataVersionBar } from "./empirical/DataVersionBar";
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

function CoefFigure({ fig }: { fig: any }) {
  return (
    <div className="rounded-lg border p-2">
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">{fig.title}</div>
      <div dangerouslySetInnerHTML={{ __html: fig.svg }} />
    </div>
  );
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
                <td key={ci} className={`px-2 py-1 ${ci === 0 ? "font-medium" : ""} ${typeof v === "number" && Math.abs(v) < 0.05 && v !== 0 ? "text-red-600" : ""}`}>{v}</td>
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
  const [datasets, setDatasets] = useState<any[]>([]);
  const [preprocess, setPreprocess] = useState<{ winsorize: string[]; log: string[]; standardize: string[] }>({ winsorize: [], log: [], standardize: [] });

  // 初始化: 加载方法目录 + venv 状态 + 关联技能 + 历史
  useEffect(() => {
    void apiEmpirical.methods().then((r) => setMethods(r.methods)).catch(() => {});
    void apiEmpirical.meta().then(setMeta).catch(() => {});
    void apiEmpirical.skills().then((r) => setSkills(r.skills)).catch(() => {});
    loadHistory();
    void apiEmpirical.datasets().then((r) => setDatasets(r.datasets as any[])).catch(() => {});
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
      const r = await apiEmpirical.run({ data: parsed, method: selectedMethod.id, params: runParams, preprocess });
      if (!r.ok) { setError(r.error ?? "提交失败"); setRunning(false); return; }
      // 轮询结果(V381: 对齐后端 300s 超时, 200 次 × 1.5s; 超时提示可去历史查看)
      let timedOut = true;
      for (let i = 0; i < 200; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const s = await apiEmpirical.result(r.taskId);
        if (s.status === "done") { setResult(s.result ?? {}); setFlowStep("result"); timedOut = false; break; }
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

      {/* 步骤指示器(仅方法执行区段显示) */}
      {activeSection === "methods" && (
      <div className="flex items-center gap-1 border-b bg-muted/20 px-4 py-1.5 text-[10px]">
        {(["data", "config", "result"] as const).map((s, i) => (
          <span key={s} className="flex items-center gap-1">
            <span className={`rounded-full px-2 py-0.5 ${flowStep === s ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground"}`}>{i + 1}. {s === "data" ? "数据" : s === "config" ? "方法与参数" : "结果"}</span>
            {i < 2 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
          </span>
        ))}
        {running && <span className="ml-auto text-emerald-600">正在沙箱执行…（完全本机, 不消耗 API 配额）</span>}
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

        {/* 右: 工作区 */}
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
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
                    ["methods", "方法执行", "16 个计量方法沙箱执行"],
                  ] as const).map(([id, label, desc]) => (
                    <button key={id} onClick={() => { setActiveSection(id as SectionId); setFlowStep("data"); }} className="rounded-lg border p-2 text-left transition-colors hover:bg-accent">
                      <div className="text-[11px] font-semibold">{label}</div>
                      <div className="mt-0.5 text-[9px] text-muted-foreground">{desc}</div>
                    </button>
                  ))}
                </div>
                <div className="mt-2 border-t pt-2">
                  <DataVersionBar projectId={projectId} value={dataVersionId} onChange={(v) => setDataVersionId(v?.id ?? null)} />
                </div>
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
              <RecognizePage projectId={projectId} />
            </div>
          )}

          {activeSection === "reliability" && (
            <div className="mx-auto w-full max-w-[1400px]">
              <ReliabilityPage projectId={projectId} />
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
          <>
          {/* 方法网格: 16 方法全部列出, 点选直接进入参数配置 */}
          {flowStep !== "config" && (
            <div className="mx-auto w-full max-w-[1400px] space-y-2">
              <Card className="p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Table2 className="h-4 w-4 text-emerald-600" />
                  <span className="text-xs font-semibold">方法目录({methods.length})</span>
                  <span className="text-[10px] text-muted-foreground">点选方法 → 配置参数 → 沙箱执行</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {methods.map((m) => (
                    <button key={m.id} onClick={() => pickMethod(m)}
                      className={`rounded-lg border p-2 text-left transition-colors ${selectedMethod?.id === m.id ? "border-emerald-500/50 bg-emerald-500/10" : "hover:bg-accent"}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold">{m.label}</span>
                        <span className={`rounded px-1 py-0.5 text-[8px] ${m.engine === "statspai" ? "bg-violet-100 text-violet-700" : m.engine === "技能流程" ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"}`}>{m.engine}</span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[9px] text-muted-foreground">{m.desc}</div>
                    </button>
                  ))}
                </div>
              </Card>
            </div>
          )}
          {flowStep === "data" && (
            <div className="mx-auto w-full max-w-[1400px] space-y-3">
              <Card className="p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Upload className="h-4 w-4 text-emerald-600" />
                  <span className="text-xs font-semibold">上传数据</span>
                  <span className="text-[10px] text-muted-foreground">CSV (首行列名) 或 JSON</span>
                  <Button size="sm" variant="outline" className="ml-auto" onClick={loadDemo}><Wand2 className="mr-1 h-3 w-3" />载入演示数据</Button>
                </div>
                <textarea
                  value={csv}
                  onChange={(e) => { setCsv(e.target.value); const p = parseCsv(e.target.value); setParsed(p); }}
                  placeholder="粘贴 CSV, 首行为列名, 逗号/分号/制表符分隔…"
                  className="mb-2 h-32 w-full rounded-md border bg-background p-2 font-mono text-[11px]"
                />
                <div className="flex items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent">
                    <FileUp className="h-3 w-3" /> 上传文件
                    <input type="file" accept=".csv,.txt,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                  </label>
                  {datasets.length > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-muted-foreground">数据源:</span>
                      <select className="rounded-md border bg-background px-1.5 py-1 text-[10px]" onChange={(e) => { if (e.target.value) void loadFromPg(e.target.value); }} defaultValue="">
                        <option value="">(选择 PG 表)</option>
                        {datasets.map((ds: any) => (
                          <option key={ds.table} value={ds.table}>{ds.table} ({ds.rows}行)</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {uploading && <span className="text-[10px] text-muted-foreground">读取中…</span>}
                </div>
                {parsed && (
                  <div className="mt-2">
                    <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700">{parsed.rows.length} 行</span>
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700">{parsed.columnOrder.length} 列</span>
                      <span>列: {parsed.columnOrder.join(", ")}</span>
                    </div>
                    <div className="overflow-x-auto rounded border">
                      <table className="w-full text-[10px]">
                        <thead><tr className="border-b bg-muted/20">{parsed.columnOrder.map((c) => <th key={c} className="px-1.5 py-1 font-medium">{c}</th>)}</tr></thead>
                        <tbody>
                          {parsed.rows.slice(0, 5).map((r, i) => (
                            <tr key={i} className="border-b last:border-0">{r.map((v, ci) => <td key={ci} className="px-1.5 py-0.5">{String(v)}</td>)}</tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-1 text-[9px] text-muted-foreground">前 5 行预览</div>
                  </div>
                )}
              </Card>
            </div>
          )}

          {flowStep === "config" && selectedMethod && (
            <div className="mx-auto w-full max-w-[1400px] space-y-3">
              {!parsed && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700">
                  ⚠️ 尚未加载数据 — 请先在上一步粘贴 CSV / 上传文件 / 选 PG 数据源 / 载入演示数据, 或先配置方法参数
                </div>
              )}
              <Card className="p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold">{selectedMethod.label}</span>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setFlowStep("data")}>← 换数据</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setSelectedMethod(null); setParams({}); setFlowStep("data"); }}>选其他方法</Button>
                  </div>
                </div>
                <p className="mb-2 text-[11px] text-muted-foreground">{selectedMethod.desc}</p>
                {selectedMethod.skills.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {selectedMethod.skills.map((s) => <span key={s} className="rounded bg-violet-100 px-1.5 py-0.5 text-[9px] text-violet-700">{s}</span>)}
                  </div>
                )}
                <div className="space-y-2">
                  {selectedMethod.id === "did" || selectedMethod.id === "did_twfe" ? (
                    <>
                      {[["y", "结果变量 y"], ["treat", "处理变量 treat"], ["time", "时间列(绝对年份)"], ["id", "个体 id (可选)"], ["cluster", "聚类列 (可选)"]].map(([k, label]) => (
                        <label key={k} className="block">
                          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{label}</span>
                          <select value={params[k] ?? ""} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                            <option value="">{parsed ? "(选择列)" : "(先加载数据)"}</option>
                            {parsed?.columnOrder.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </label>
                      ))}
                    </>
                  ) : selectedMethod.id === "event_study" ? (
                    <>
                      {[["y", "结果变量 y"], ["unit", "个体 id"], ["time", "时间列"], ["treat_time", "处理时间列(未处理=0或超范围)"]].map(([k, label]) => (
                        <label key={k} className="block">
                          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{label}</span>
                          <select value={params[k] ?? ""} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                            <option value="">{parsed ? "(选择列)" : "(先加载数据)"}</option>
                            {parsed?.columnOrder.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </label>
                      ))}
                      <div className="rounded bg-blue-50 px-2 py-1 text-[10px] text-blue-700">基期 t=-1, 窗口 -4 到 +4, 自动做平行趋势检验</div>
                    </>
                  ) : selectedMethod.id === "iv" ? (
                    <>
                      {[["y", "结果变量 y"], ["endog", "内生变量"], ["instruments", "工具变量 (逗号分隔多列)"]].map(([k, label]) => (
                        <label key={k} className="block">
                          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{label}</span>
                          {k === "instruments" ? (
                            <input value={params[k] ?? ""} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} placeholder="如 z1, z2" className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
                          ) : (
                            <select value={params[k] ?? ""} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                              <option value="">(选择列)</option>
                              {parsed?.columnOrder.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                          )}
                        </label>
                      ))}
                      <label className="block">
                        <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">控制变量 xs (逗号分隔, 可选)</span>
                        <input value={params.xs ?? ""} onChange={(e) => setParams((p) => ({ ...p, xs: e.target.value }))} placeholder="如 x1, x2" className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
                      </label>
                    </>
                  ) : selectedMethod.id === "rdd" ? (
                    <>
                      {[["y", "结果变量 y"], ["running", "运行变量 (断点)"], ["cutoff", "断点值 (数值)"]].map(([k, label]) => (
                        <label key={k} className="block">
                          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{label}</span>
                          {k === "cutoff" ? (
                            <input type="number" value={params[k] ?? "0"} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
                          ) : (
                            <select value={params[k] ?? ""} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                              <option value="">(选择列)</option>
                              {parsed?.columnOrder.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                          )}
                        </label>
                      ))}
                    </>
                  ) : selectedMethod.id === "panel_fe" ? (
                    <>
                      {[["y", "结果变量 y"], ["id", "个体 id"], ["time", "时间列"]].map(([k, label]) => (
                        <label key={k} className="block">
                          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{label}</span>
                          <select value={params[k] ?? ""} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                            <option value="">{parsed ? "(选择列)" : "(先加载数据)"}</option>
                            {parsed?.columnOrder.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </label>
                      ))}
                      <label className="block">
                        <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">自变量 xs (逗号分隔)</span>
                        <input value={params.xs ?? ""} onChange={(e) => setParams((p) => ({ ...p, xs: e.target.value }))} placeholder="如 x1, x2" className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
                      </label>
                    </>
                  ) : selectedMethod.id === "psm" ? (
                    <>
                      {[["y", "结果变量 y"], ["treat", "处理变量"]].map(([k, label]) => (
                        <label key={k} className="block">
                          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{label}</span>
                          <select value={params[k] ?? ""} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                            <option value="">{parsed ? "(选择列)" : "(先加载数据)"}</option>
                            {parsed?.columnOrder.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </label>
                      ))}
                      <label className="block">
                        <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">协变量 xs (逗号分隔)</span>
                        <input value={params.xs ?? ""} onChange={(e) => setParams((p) => ({ ...p, xs: e.target.value }))} placeholder="如 x1, x2" className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
                      </label>
                    </>
                  ) : selectedMethod.id === "scm" ? (
                    <>
                      {[["y", "结果变量 y"], ["unit", "个体 id"], ["time", "时间列"], ["treated_unit", "处理单元值 (数值)"]].map(([k, label]) => (
                        <label key={k} className="block">
                          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{label}</span>
                          {k === "treated_unit" ? (
                            <input value={params[k] ?? ""} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} placeholder="如 0" className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
                          ) : (
                            <select value={params[k] ?? ""} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                              <option value="">(选择列)</option>
                              {parsed?.columnOrder.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                          )}
                        </label>
                      ))}
                      <label className="block">
                        <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">处理时间 (数值年份)</span>
                        <input value={params.treatment_time ?? ""} onChange={(e) => setParams((p) => ({ ...p, treatment_time: e.target.value }))} placeholder="如 2016" className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
                      </label>
                    </>
                  ) : selectedMethod.id === "ols" ? (
                    <>
                      <label className="block">
                        <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">结果变量 y</span>
                        <select value={params.y ?? ""} onChange={(e) => setParams((p) => ({ ...p, y: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                          <option value="">(选择列)</option>
                          {parsed?.columnOrder.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">自变量 xs (逗号分隔多列)</span>
                        <input value={params.xs ?? ""} onChange={(e) => setParams((p) => ({ ...p, xs: e.target.value }))} placeholder="如 treat, post" className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
                      </label>
                    </>
                  ) : ["logit", "ologit", "mnl"].includes(selectedMethod.id) ? (
                    <>
                      {[["y", "因变量" + (selectedMethod.id === "logit" ? "(0/1)" : selectedMethod.id === "ologit" ? "(有序1-5)" : "(多分类)")], ["link", "链接函数(仅Logit)"]].filter(([k]) => !(k === "link" && selectedMethod.id !== "logit")).map(([k, label]) => (
                        <label key={k} className="block">
                          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{label}</span>
                          {k === "link" ? (
                            <select value={params[k] ?? "logit"} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                              <option value="logit">Logit</option>
                              <option value="probit">Probit</option>
                            </select>
                          ) : (
                            <select value={params[k] ?? ""} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                              <option value="">{parsed ? "(选择列)" : "(先加载数据)"}</option>
                              {parsed?.columnOrder.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                          )}
                        </label>
                      ))}
                      <label className="block">
                        <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">自变量 xs (逗号分隔)</span>
                        <input value={params.xs ?? ""} onChange={(e) => setParams((p) => ({ ...p, xs: e.target.value }))} placeholder="如 edu, area, income" className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
                      </label>
                    </>
                  ) : selectedMethod.id === "crosstab" ? (
                    <>
                      {[["row", "行变量"], ["col", "列变量"]].map(([k, label]) => (
                        <label key={k} className="block">
                          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{label}</span>
                          <select value={params[k] ?? ""} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
                            <option value="">{parsed ? "(选择列)" : "(先加载数据)"}</option>
                            {parsed?.columnOrder.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </label>
                      ))}
                      <div className="rounded bg-blue-50 px-2 py-1 text-[10px] text-blue-700">输出: 交叉表 + 行百分比 + 卡方检验 + Cramér's V</div>
                    </>
                  ) : selectedMethod.id === "genvars" ? (
                    <>
                      <label className="block">
                        <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">公式 (JSON: [{"{name:'rate', expr:'out/own'}"}])</span>
                        <textarea
                          value={params.formulas ?? ""}
                          onChange={(e) => setParams((p) => ({ ...p, formulas: e.target.value }))}
                          placeholder='[{"name":"rate","expr":"out/own"},{"name":"permu","expr":"income/area"}]'
                          className="h-20 w-full rounded-md border bg-background p-2 font-mono text-[11px]"
                        />
                      </label>
                      <div className="rounded bg-blue-50 px-2 py-1 text-[10px] text-blue-700">支持 + - * / () 和已有列; 生成新列供后续分析</div>
                    </>
                  ) : selectedMethod.id === "filter" ? (
                    <>
                      <label className="block">
                        <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">条件 (JSON: [{"{col:'identity', op:'==', value:2}"}])</span>
                        <textarea
                          value={params.conditions ?? ""}
                          onChange={(e) => setParams((p) => ({ ...p, conditions: e.target.value }))}
                          placeholder='[{"col":"identity","op":"==","value":2},{"col":"area","op":">","value":10}]'
                          className="h-20 w-full rounded-md border bg-background p-2 font-mono text-[11px]"
                        />
                      </label>
                      <div className="rounded bg-blue-50 px-2 py-1 text-[10px] text-blue-700">支持 == != &gt; &gt;= &lt; &lt;= in; 输出筛选后描述统计</div>
                    </>
                  ) : selectedMethod.id === "descriptive" ? (
                    <div className="text-[11px] text-muted-foreground">将统计全部数值列: 均值/标准差/N/Min/Max</div>
                  ) : (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700">
                      方法「{selectedMethod.label}」首版走技能流程: 前往技能面板, 使用已装 skill(如 10-Jill0099-causal-inference-mixtape)执行。
                      <Button size="sm" variant="outline" className="ml-2" onClick={gotoSkills}>前往技能面板</Button>
                    </div>
                  )}
                </div>
                <div className="mt-2 rounded-lg border border-dashed p-2">
                  <div className="mb-1 text-[10px] font-semibold text-muted-foreground">数据预处理 (可选)</div>
                  <div className="flex flex-wrap gap-3">
                    {(["winsorize", "log", "standardize"] as const).map((kind) => (
                      <label key={kind} className="flex items-center gap-1 text-[10px]">
                        <input
                          type="checkbox"
                          checked={preprocess[kind].length > 0}
                          onChange={(e) => {
                            setPreprocess((p) => ({ ...p, [kind]: e.target.checked ? (parsed?.columnOrder ?? []) : [] }));
                          }}
                        />
                        {kind === "winsorize" ? "Winsorize 1%/99%" : kind === "log" ? "取对数" : "标准化"}
                      </label>
                    ))}
                  </div>
                  {preprocess.winsorize.length > 0 && <div className="mt-1 text-[9px] text-muted-foreground">将对全部数值列: 缩尾/对数(ln_前缀)/标准化(z_前缀)</div>}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Button size="sm" disabled={running} onClick={() => void runAnalysis()}>
                    {running ? <span className="mr-1 inline-block h-3 w-3 animate-spin rounded-full border border-white border-t-transparent" /> : <Play className="mr-1 h-3.5 w-3.5" />}
                    执行分析
                  </Button>
                  {error && <span className="text-[11px] text-red-600">{error}</span>}
                </div>
              </Card>
            </div>
          )}

          {flowStep === "result" && result && (
            <div className="mx-auto w-full max-w-[1400px] space-y-3">
              {result.warnings?.map((w, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5" /> {w}
                </div>
              ))}
              {result.meta?.error && (
                <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-700">
                  <AlertTriangle className="h-3.5 w-3.5" /> {result.meta.error}
                </div>
              )}
              <div className="flex items-center justify-between">
                <div className="text-[10px] text-muted-foreground">
                  方法: {result.meta?.method} | N={result.meta?.n} | {result.meta?.durationMs}ms | Python {result.meta?.python}
                </div>
                <Button size="sm" variant="outline" onClick={() => setFlowStep("config")}><RotateCcw className="mr-1 h-3 w-3" />重跑</Button>
              </div>
              <div className="space-y-2">
                {result.tables?.map((t, i) => <ResultTable key={i} t={t} />)}
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {result.figures?.map((f, i) => <CoefFigure key={i} fig={f} />)}
              </div>
              {result.diagnostics?.map((d, i) => (
                <div key={i} className="rounded-lg border p-2 text-[11px]">
                  <span className="font-medium">{d.name}:</span> <span className="text-muted-foreground">{d.verdict}</span>
                </div>
              ))}
            </div>
          )}

          {/* 底部: 关联技能 */}
          {skills.length > 0 && (
            <div className="mx-auto mt-4 w-full max-w-[1400px]">
              <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold text-muted-foreground">
                <Table2 className="h-3 w-3" /> 可调用实证技能 ({skills.length})
              </div>
              <div className="grid gap-1.5 md:grid-cols-2">
                {skills.slice(0, 8).map((s: any) => (
                  <div key={s.name} className="flex items-center justify-between rounded-lg border p-1.5 text-[10px]">
                    <span className="truncate font-medium">{s.name}</span>
                    <span className="ml-1 truncate text-muted-foreground">{(s.description ?? "").slice(0, 40)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          </>
          )}
        </div>
      </div>
    </div>
  );
};
