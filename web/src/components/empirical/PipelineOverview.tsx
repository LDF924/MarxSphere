// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// PipelineOverview.tsx — 课题流水线总览(V413): 问卷→数据→分析 全链时间线
// 把分散在各页的产出(识别/仿真/信效度/插补…)串成一条可展开的流水线, 直观看到完整过程与结果
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Database, FlaskConical, Wand2, ClipboardList, Loader2, BarChart3, Table2, ScrollText, Download, FileDown } from "lucide-react";
import { apiEmpiricalWorkshop } from "../../lib/api";

interface PipelineProps { projectId?: string; refreshKey?: number; projectTitle?: string }

const STAGE_META: Record<string, { label: string; icon: any; color: string }> = {
  recognize: { label: "问卷识别", icon: FileText, color: "text-blue-600" },
  simulate: { label: "仿真数据", icon: Wand2, color: "text-emerald-600" },
  reliability: { label: "信效度", icon: FlaskConical, color: "text-violet-600" },
  diagnosis: { label: "数据诊断", icon: ClipboardList, color: "text-amber-600" },
  imputation: { label: "LLM 插补", icon: Database, color: "text-cyan-600" },
  data_pipeline: { label: "数据管道", icon: ScrollText, color: "text-rose-600" },
  regression: { label: "回归", icon: BarChart3, color: "text-indigo-600" },
};

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

/** 表格渲染(工作台 python_result.tables 通用) */
function ResultTables({ tables }: { tables: any[] }) {
  if (!tables?.length) return null;
  return (
    <div className="mt-1 space-y-2">
      {tables.map((t: any, i: number) => (
        <div key={i} className="overflow-x-auto rounded border">
          <div className="border-b bg-muted/30 px-2 py-0.5 text-[10px] font-medium">{t.title}</div>
          <table className="w-full text-[10px]">
            <thead><tr className="border-b bg-muted/20 text-left">{(t.cols ?? []).map((c: string, ci: number) => <th key={ci} className="px-2 py-0.5 font-medium">{c}</th>)}</tr></thead>
            <tbody>
              {(t.rows ?? []).slice(0, 30).map((r: any[], ri: number) => (
                <tr key={ri} className="border-b last:border-0">
                  {r.map((v, ci) => <td key={ci} className={`px-2 py-0.5 ${ci === 0 ? "font-medium" : ""}`}>{String(v)}</td>)}
                </tr>
              ))}
              {(t.rows?.length ?? 0) > 30 && <tr><td colSpan={(t.cols ?? []).length || 5} className="px-2 py-0.5 text-center text-[9px] text-muted-foreground">…共 {(t.rows ?? []).length} 行, 仅显示前 30</td></tr>}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/** 时间线上的一个节点卡片 */
function StageCard({ run, index, total }: { run: any; index: number; total: number }) {
  const meta = STAGE_META[run.stage] ?? { label: run.stage, icon: Table2, color: "text-gray-600" };
  const Icon = meta.icon;
  const [open, setOpen] = useState(index === total - 1);  // 最新一条默认展开
  const tables = (run.pythonResult?.tables ?? []) as any[];
  const diags = (run.pythonResult?.diagnostics ?? []) as any[];
  const nInfo = run.pythonResult?.meta?.n;
  // V413: 自动生成的图表(figures 文件)
  const figs = (run.pythonResult?.meta?.figures ?? []) as any[];
  // 摘要: 首表首行 or 解读前 80 字
  const summary = run.llmInterpretation
    ? String(run.llmInterpretation).replace(/^"|"$/g, "").slice(0, 160)
    : tables[0]?.rows?.length
      ? `${tables[0].rows.length} 行 × ${tables[0].cols?.length ?? "?"} 列`
      : "";
  return (
    <div className="rounded-lg border bg-card">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent/50">
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.color}`} />
        <span className="text-[11px] font-semibold">{meta.label}</span>
        {nInfo && <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">N={nInfo}</span>}
        <span className="text-[9px] text-muted-foreground">{fmtTime(run.createdAt)}</span>
        {summary && <span className="ml-auto truncate text-[9px] text-muted-foreground">{summary}</span>}
        {figs.length > 0 && <span className="text-[9px] text-emerald-600">📊 {figs.length} 图</span>}
        {(run.warnings ?? []).length > 0 && <span className="text-[9px] text-amber-600">⚠ {run.warnings.length}</span>}
      </button>
      {open && (
        <div className="space-y-1.5 border-t px-2 py-1.5">
          {figs.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {figs.map((f: any) => (
                <a key={f.file} href={apiEmpiricalWorkshop.figuresUrl(f.file)} target="_blank" rel="noreferrer" className="group">
                  <img
                    src={apiEmpiricalWorkshop.figuresUrl(f.file)}
                    alt={f.title ?? f.file}
                    title={`${f.title ?? ""} (${f.sizeKB}KB) — 点击查看原图`}
                    className="max-h-44 rounded border bg-white object-contain transition-opacity group-hover:opacity-80 dark:bg-card"
                  />
                  <div className="text-center text-[8px] text-muted-foreground group-hover:text-emerald-600">↘ 点击放大</div>
                </a>
              ))}
            </div>
          )}
          {diags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {diags.map((d: any, i: number) => (
                <span key={i} className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-700">{d.name}: {d.stat}{d.p !== undefined && d.p !== "" ? ` (p=${d.p})` : ""}</span>
              ))}
            </div>
          )}
          <ResultTables tables={tables} />
          {run.llmInterpretation && (
            <div className="rounded border bg-muted/20 p-1.5 text-[10px] leading-relaxed text-foreground/90">
              <span className="font-semibold">🤖 LLM 解读: </span>
              {String(run.llmInterpretation).replace(/^"|"$/g, "").slice(0, 2000)}
            </div>
          )}
          {(run.warnings ?? []).map((w: string, i: number) => (
            <div key={i} className="rounded border border-amber-500/30 bg-amber-500/10 p-1 text-[9px] text-amber-700">⚠ {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PipelineOverview({ projectId, refreshKey, projectTitle }: PipelineProps) {
  const [overview, setOverview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportFiles, setExportFiles] = useState<any[] | null>(null);
  const [exportError, setExportError] = useState("");

  useEffect(() => {
    if (!projectId) { setOverview(null); setError(""); return; }   // V414: 取消选中时清掉上一条课题的数据, 免得残留
    setLoading(true); setError("");
    apiEmpiricalWorkshop.projectPipeline(projectId)
      .then((r) => setOverview(r.overview))
      .catch((e: any) => setError(e?.message ?? "加载流水线失败"))
      .finally(() => setLoading(false));
  }, [projectId, refreshKey]);

  // V414: 原来这里是 `if (!projectId) return null` — 未选课题时整块卡片直接不渲染,
  //   看着就是"功能没了"。改成保留外壳 + 空状态说明, 让用户知道要先选课题。
  const qs = overview?.questionnaires ?? [];
  const versions = overview?.versions ?? [];
  const runs = overview?.runs ?? [];
  const hasData = qs.length + versions.length + runs.length > 0;

  /** V413: 导出全套报告(LaTeX + Word, 走报告脚本生成后提供下载链接) */
  const exportReport = async () => {
    if (!projectId) return;
    setExporting(true); setExportError(""); setExportFiles(null);
    try {
      const r = await apiEmpiricalWorkshop.exportReport(projectId);
      if (!r.ok) { setExportError(r.error ?? "导出失败"); return; }
      // 轮询报告任务(脚本秒级)
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 1200));
        const t = await apiEmpiricalWorkshop.taskResult(r.taskId!);
        if (t.status === "done") {
          setExportFiles((t.result?.meta?.files ?? []) as any[]);
          return;
        }
        if (t.status === "error") { setExportError(t.error ?? "导出失败"); return; }
      }
      setExportError("导出超时");
    } catch (e: any) {
      setExportError(e?.message ?? "导出失败");
    } finally { setExporting(false); }
  };

  return (
    <div className="mt-2 rounded-lg border bg-card p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <ScrollText className="h-4 w-4 text-emerald-600" />
        <span className="text-[11px] font-semibold">课题流水线总览</span>
        <span className="text-[9px] text-muted-foreground">问卷 → 数据 → 分析全链(点击展开结果)</span>
        <div className="ml-auto flex items-center gap-1.5">
          {hasData && (<>
              <button
                onClick={() => void exportReport()}
                disabled={exporting}
                title="把全流水线(问卷+数据+所有分析表+LLM解读+图)打包成 LaTeX 和 Word 报告"
                className="flex items-center gap-1 rounded-md border border-emerald-300 px-2 py-0.5 text-[10px] hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-700 dark:hover:bg-emerald-950"
              >
                {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileDown className="h-3 w-3 text-emerald-600" />}
                {exporting ? "生成中…" : "📄 导出全套报告"}
              </button>
              {exportFiles && exportFiles.length > 0 && (
                <span className="flex items-center gap-1">
                  {exportFiles.map((f) => (
                    <a key={f.name} href={`/api/empirical/reports/${f.name}`} className="flex items-center gap-0.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-700 hover:underline">
                      <Download className="h-3 w-3" /> {f.name} ({f.sizeKB}KB)
                    </a>
                  ))}
                </span>
              )}
            </>
          )}
          <button
            onClick={() => {
              if (!projectId) return;
              setLoading(true); apiEmpiricalWorkshop.projectPipeline(projectId).then((r) => { setOverview(r.overview); setLoading(false); }).catch((e: any) => { setError(e?.message ?? "刷新失败"); setLoading(false); });
            }}
            className="text-[9px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            disabled={loading || !projectId}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : "↻ 刷新"}
          </button>
        </div>
      </div>

      {exportError && <div className="mb-1 text-[10px] text-red-600">❌ {exportError}</div>}
      {error && <div className="mb-1 text-[10px] text-red-600">❌ {error}</div>}

      {!loading && !hasData && (
        <div className="py-2 text-center text-[10px] text-muted-foreground">
          {projectTitle
            ? <>当前课题「<span className="font-medium text-foreground">{projectTitle}</span>」暂无流水线产出。<br />在<b>本课题</b>下依次做 问卷识别 → 信效度 / 仿真 / 回归, 结果会按时间线汇总到这里。</>
            : <>先在右上角选择一个课题 — 未选课题时不会汇总任何产出(分析结果挂在选中课题下)。</>}
        </div>
      )}

      {hasData && (
        <div className="space-y-2">
          {/* 统计条 */}
          <div className="flex flex-wrap gap-1.5">
            {qs.length > 0 && <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[9px] text-blue-700">📋 问卷 {qs.length}(共 {qs.reduce((a: number, q: any) => a + (q.columns?.length ?? 0), 0)} 变量)</span>}
            {versions.length > 0 && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-700">🗄 数据版本 {versions.length}({versions[0]?.nRows ?? 0} 行最新)</span>}
            {runs.length > 0 && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] text-violet-700">⚗️ 分析 {runs.length} 次</span>}
          </div>

          {/* 问卷卡片 */}
          {qs.length > 0 && (
            <div className="space-y-1">
              {qs.map((q: any) => (
                <div key={q.id} className="rounded border bg-muted/10 px-2 py-1 text-[10px]">
                  <span className="font-semibold">📋 {q.title}</span>
                  <span className="ml-2 text-muted-foreground">source={q.source} · {q.columns?.length ?? 0} 变量 · {fmtTime(q.created_at)}</span>
                  {(q.meta?.indicators ?? []).length > 0 && (
                    <div className="text-[9px] text-muted-foreground">指标: {(q.meta.indicators as string[]).join(" / ")}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 分析 runs 时间线 */}
          {runs.length > 0 && (
            <div className="relative space-y-1 pl-3">
              <div className="absolute bottom-1 left-[3px] top-1 w-px bg-border" />
              {runs.map((run: any, i: number) => (
                <div key={run.id} className="relative">
                  <span className="absolute -left-[9px] top-3 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  <StageCard run={run} index={i} total={runs.length} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
