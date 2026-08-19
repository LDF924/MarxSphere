// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ImputationPage.tsx — LLM 民调插补工作台（V380+）: 论文方法复现
// 三栏: 缺失机制诊断 | 插补队列(人工确认) | 对比评估(LLM vs MICE/KNN/RF)
import { useState } from "react";
import { Database, Loader2, Play, CheckCircle2, XCircle, Pencil, Download, AlertTriangle } from "lucide-react";
import { apiEmpirical } from "../../lib/api";
import { DemoDataButton } from "./DemoDataButton";
import { Button } from "../ui/button";

function parseCsv(text: string): { columnOrder: string[]; rows: (string | number | null)[][] } | null {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const delimiter = text.includes(";") ? ";" : text.includes("\t") ? "\t" : ",";
  const columnOrder = lines[0].split(delimiter).map((c) => c.trim());
  const rows = lines.slice(1).map((l) => {
    const cells = l.split(delimiter);
    return columnOrder.map((_, i) => {
      const raw = (cells[i] ?? "").trim();
      if (raw === "" || raw === "-88" || raw === "-99") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    });
  });
  return { columnOrder, rows };
}

export function ImputationPage({ projectId }: { projectId?: string }) {
  const [csv, setCsv] = useState("");
  const [parsed, setParsed] = useState<{ columnOrder: string[]; rows: (string | number | null)[][] } | null>(null);
  const [targetCol, setTargetCol] = useState("");
  const [contextCols, setContextCols] = useState<string[]>([]);
  const [codingOptions, setCodingOptions] = useState("");
  const [fieldInfo, setFieldInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<any>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [junkCells, setJunkCells] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [compareResult, setCompareResult] = useState<any[] | null>(null);

  const start = async () => {
    if (!parsed) { setError("请先粘贴数据"); return; }
    if (!targetCol) { setError("请选择目标变量(被插补列)"); return; }
    setBusy(true); setError(""); setRun(null); setRunId(null); setJunkCells([]); setCompareResult(null);
    try {
      const r = await apiEmpirical.imputationStart({
        projectId, data: parsed, targetCol, contextCols,
        codingOptions: codingOptions ? codingOptions.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n)) : undefined,
        fieldInfo,
      });
      if (!r.ok) { setError("插补启动失败"); setBusy(false); return; }
      setRunId(r.runId ?? null); setJunkCells(r.junkCells ?? []);
      if (r.runId) {
        const rr = await apiEmpirical.imputationGet(r.runId);
        setRun(rr.run);
      }
    } catch (e: any) {
      setError(e?.message ?? "插补失败");
    } finally { setBusy(false); }
  };

  const confirmCell = async (cell: any, action: "confirm" | "reject") => {
    if (!runId) return;
    await apiEmpirical.imputationBatch(runId, [{ id: cell.id, confirmed: action === "confirm" }]);
    const rr = await apiEmpirical.imputationGet(runId);
    setRun(rr.run);
  };

  const editCell = async (cell: any) => {
    if (!runId) return;
    const val = edits[cell.id];
    if (val === undefined) return;
    await apiEmpirical.imputationBatch(runId, [{ id: cell.id, editedValue: val }]);
    setEdits((e) => ({ ...e, [cell.id]: "" }));
    const rr = await apiEmpirical.imputationGet(runId);
    setRun(rr.run);
  };

  const compare = async () => {
    if (!runId || !parsed) return;
    setBusy(true); setError("");
    try {
      const r = await apiEmpirical.imputationCompare({
        runId, data: parsed, targetCol, contextCols,
        codingOptions: codingOptions ? codingOptions.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n)) : undefined,
        fieldInfo,
      });
      if (!r.ok) { setError("对比评估失败"); setBusy(false); return; }
      setCompareResult(r.baselineCompare ?? []);
    } catch (e: any) {
      setError(e?.message ?? "对比失败");
    } finally { setBusy(false); }
  };

  const exportCsv = () => {
    if (!run || !run.cells) return;
    const header = ["row_idx", "col", "original_value", "missing_type", "llm_value", "llm_reason", "status", "edited_value"];
    const lines = [header.join(",")];
    for (const c of run.cells) {
      const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      lines.push([c.rowIdx, esc(c.col), esc(c.originalValue), c.missingType, esc(c.llmValue), esc(c.llmReason), c.status, esc(c.editedValue)].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `imputation_${runId?.slice(0, 8)}.csv`;
    a.click();
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <Database className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-semibold">LLM 民调插补</span>
          <span className="text-[10px] text-muted-foreground">论文方法: 生成性建模插补(杨锋等 2025) — 非随机缺失/敏感题空答乱答</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <div className="mb-0.5 flex items-center justify-between">
              <label className="block text-[10px] font-medium text-muted-foreground">数据 CSV(空值/-88/-99 计缺失)</label>
              <DemoDataButton
                missing
                label="载入挖缺演示数据"
                onLoad={(data) => {
                  setParsed(data);
                  if (data.columnOrder.includes("nonfarm_income")) setTargetCol("nonfarm_income");
                  setContextCols(["identity", "edu", "employment", "off_farm", "own_area"].filter((c) => data.columnOrder.includes(c)));
                }}
              />
            </div>
            <textarea className="h-24 w-full rounded-md border bg-background p-2 font-mono text-[10px]" value={csv} onChange={(e) => { setCsv(e.target.value); setParsed(parseCsv(e.target.value)); }} placeholder={"identity,adj_willing,nonfarm_income\n1,2,\n..."} />
          </div>
          <div className="space-y-1.5">
            <label className="block">
              <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">目标变量(被插补)</span>
              <select className="w-full rounded border bg-background px-1.5 py-1 text-[10px]" value={targetCol} onChange={(e) => setTargetCol(e.target.value)}>
                <option value="">(选择)</option>
                {(parsed?.columnOrder ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">上下文变量(LLM 推断依据, 可多选)</span>
              <select multiple className="min-h-10 w-full rounded border bg-background px-1.5 py-1 text-[10px]" value={contextCols} onChange={(e) => setContextCols(Array.from(e.target.selectedOptions).map((o) => o.value))}>
                {(parsed?.columnOrder ?? []).filter((c) => c !== targetCol).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">编码集(逗号分隔, 如 1,2,3,4,5 — 用于乱答检测)</span>
              <input className="w-full rounded border bg-background px-1.5 py-1 text-[10px]" value={codingOptions} onChange={(e) => setCodingOptions(e.target.value)} placeholder="如 1,2,3,4,5" />
            </label>
          </div>
        </div>
        <label className="mb-0.5 mt-2 block text-[10px] font-medium text-muted-foreground">田野背景信息(可选, 提高插补质量)</label>
        <textarea className="h-12 w-full rounded-md border bg-background p-2 text-[10px]" value={fieldInfo} onChange={(e) => setFieldInfo(e.target.value)} placeholder="如: 本地非农就业机会多, 收入普遍较高…" />
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" onClick={() => void start()} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
            {busy ? "插补中…" : "开始 LLM 插补"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void compare()} disabled={busy || !runId}>
            掩码对比评估(LLM vs MICE/KNN/RF)
          </Button>
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={!run}>导出 CSV</Button>
          {error && <span className="text-[10px] text-red-600">{error}</span>}
        </div>
        <div className="mt-1 text-[9px] text-muted-foreground">⚠️ 横截面插补(本问卷一期数据); 敏感题空答→插补池, 乱答→警示列表, -88/-99→结构性排除</div>
      </div>

      {junkCells.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
          <div className="flex items-center gap-1 text-[11px] font-semibold text-amber-700"><AlertTriangle className="h-3 w-3" /> 乱答检测({junkCells.length}条, 不进插补池, 请重编码)</div>
          {junkCells.map((j, i) => (
            <div key={i} className="text-[10px] text-amber-700">行 {j.row_idx}: 原值={String(j.original_value)}</div>
          ))}
        </div>
      )}

      {run && (
        <div className="space-y-2">
          <div className="rounded-lg border bg-card p-2 text-[10px]">
            <span className="font-semibold">缺失机制诊断: </span>
            空值 {run.missingAnalysis?.empty ?? 0} 条 | 乱答 {run.missingAnalysis?.junk ?? 0} 条 | -88/-99 {run.missingAnalysis?.masked ?? 0} 条 | 分布: {run.missingAnalysis?.sampleSummary ?? ""}
          </div>
          <div className="text-[11px] font-semibold">插补队列(人工逐条确认 {run.cells?.length ?? 0} 条)</div>
          <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
            {run.cells?.map((c: any) => (
              <div key={c.id} className="flex items-center gap-2 rounded-lg border bg-card p-1.5 text-[10px]">
                <span className="w-10 shrink-0 text-muted-foreground">行{c.rowIdx}</span>
                <span className="w-16 shrink-0 rounded bg-muted px-1 py-0.5 text-center">{c.missingType}</span>
                <span className="min-w-0 flex-1 truncate" title={c.llmReason}>LLM值: <b>{c.llmValue}</b> <span className="text-muted-foreground">({c.llmReason.slice(0, 40)})</span></span>
                {c.status === "pending" ? (
                  <>
                    <input className="w-20 rounded border bg-background px-1 py-0.5" placeholder="改值" value={edits[c.id] ?? ""} onChange={(e) => setEdits((s) => ({ ...s, [c.id]: e.target.value }))} />
                    <button className="rounded border px-1.5 py-0.5 hover:bg-emerald-500/10" onClick={() => void editCell(c)}><Pencil className="h-3 w-3 text-emerald-600" /></button>
                    <button className="rounded border px-1.5 py-0.5 hover:bg-emerald-500/10" onClick={() => void confirmCell(c, "confirm")}><CheckCircle2 className="h-3 w-3 text-emerald-600" /></button>
                    <button className="rounded border px-1.5 py-0.5 hover:bg-red-500/10" onClick={() => void confirmCell(c, "reject")}><XCircle className="h-3 w-3 text-red-600" /></button>
                  </>
                ) : (
                  <span className={`rounded px-1.5 py-0.5 ${c.status === "confirmed" ? "bg-emerald-100 text-emerald-700" : c.status === "edited" ? "bg-blue-100 text-blue-700" : "bg-red-100 text-red-600"}`}>{c.status}{c.editedValue ? `=${c.editedValue}` : ""}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {compareResult && compareResult.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <div className="border-b bg-muted/30 px-2 py-1 text-[11px] font-medium">掩码对比评估(插补值 vs 已知真值)</div>
          <table className="w-full text-[11px]">
            <thead><tr className="border-b bg-muted/20 text-left">
              {["方法", "RMSE", "MAE", "MAPE%/偏移", "准确率%", "N"].map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}
            </tr></thead>
            <tbody>
              {compareResult.map((r: any[], i: number) => (
                <tr key={i} className={`border-b last:border-0 ${r[0] === "LLM" ? "bg-emerald-500/5" : ""}`}>
                  {r.map((v, ci) => <td key={ci} className={`px-2 py-1 ${ci === 0 ? "font-medium" : ""}`}>{String(v)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">
            LLM 保真指标: RMSE/MAE/准确率 与基线同口径; 均值偏移/相关保持见详情; 论文结论: LLM 在 MNAR 场景零样本优势明显
          </div>
        </div>
      )}
    </div>
  );
}
