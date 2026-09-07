// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// DataPipelinePage.tsx — 数据管道（V380+）: 缺失/缩尾/构造/筛选/描述 + Stata 下载
import { useState } from "react";
import { Workflow, Loader2, Play, FileCode2, ShieldCheck } from "lucide-react";
import { apiEmpirical, type EmpiricalDataVersion } from "../../lib/api";
import { DataVersionBar } from "./DataVersionBar";
import { DemoDataButton } from "./DemoDataButton";
import { CodeBlock } from "./CodeBlock";
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

export function DataPipelinePage({ projectId }: { projectId?: string }) {
  const [csv, setCsv] = useState("");
  const [parsed, setParsed] = useState<{ columnOrder: string[]; rows: (string | number | null)[][] } | null>(null);
  const [dataVersion, setDataVersion] = useState<EmpiricalDataVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [stataCode, setStataCode] = useState("");
  const [verifyReport, setVerifyReport] = useState<any>(null);
  const [error, setError] = useState("");
  // W8(闭源 statistics 数据转换实拍): 5 方法多选 + 目标列
  const [transformVars, setTransformVars] = useState<string[]>([]);
  const [transformMethods, setTransformMethods] = useState<string[]>(["center", "rank", "sqrt"]);

  // 默认步骤(演示): 缺失统计全列 + 缩尾收入 + 构造 has_out + 筛选有地 + 转换 + 描述
  const buildSteps = () => {
    const cols = (parsed?.columnOrder ?? dataVersion?.columns ?? []);
    const tCols = transformVars.length ? transformVars : ["own_area"];
    const t: Record<string, string[]> = {};
    for (const m of transformMethods) {
      const key = m === "zscore" ? "zscore" : m === "minmax" ? "minmax" : m === "log" ? "log" : m === "rank" ? "rank" : m === "sqrt" ? "sqrt" : "center";
      t[key] = tCols;
    }
    return {
      missing: { cols: ["nonfarm_income", "adj_willing", "politics"] },
      winsorize: { cols: ["nonfarm_income", "own_area"] },
      genvars: [{ name: "has_out", expr: "transfer_out_area > 0" }],
      filter: [{ col: "own_area", op: ">", value: 0 }],
      // W8(闭源 statistics 数据转换): zscore 标准化/minmax 归一/log 对数/rank 排名/sqrt 开方 — 用户多选
      transform: t,
      describe: { cols: ["own_area", "cult_area", "adj_willing", "has_out"] },
    };
  };

  const run = async () => {
    const data = parsed ?? (dataVersion ? { columnOrder: dataVersion.columns, rows: [] as any[] } : null);
    if (!data || data.rows.length === 0) { setError("请先粘贴数据或选择数据版本"); return; }
    setBusy(true); setError(""); setResult(null);
    try {
      const steps = buildSteps();
      const r = await apiEmpirical.pipeline({ projectId, data, steps });
      if (!r.ok || !r.taskId) { setError(r.error ?? "提交失败"); setBusy(false); return; }
      for (let i = 0; i < 200; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const res = await apiEmpirical.result(r.taskId!);
        if (res.status === "done") {
          setResult(res.result);
          const p = (res.result as any)?.meta?.pipeline ?? {};
          const vr = await apiEmpirical.pipelineVerify({
            nBefore: p.n_before, nAfter: p.n_after, generatedVars: p.generated ?? [],
          });
          setVerifyReport(vr.report);
          // 同步生成 Stata
          const sr = await apiEmpirical.pipelineStata({ projectId, data, steps });
          setStataCode(sr.stataCode ?? "");
          setBusy(false);
          return;
        }
        if (res.status === "error") { setError(res.error ?? "执行失败"); setBusy(false); return; }
      }
      setError("超时"); setBusy(false);
    } catch (e: any) {
      setError(e?.message ?? "管道失败"); setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <Workflow className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-semibold">数据管道</span>
          <span className="text-[10px] text-muted-foreground">缺失统计 → 缩尾 → 变量构造 → 样本筛选 → 描述统计(Python 实执行) + Stata 代码下载</span>
        </div>
        <DataVersionBar projectId={projectId} value={dataVersion?.id ?? null} onChange={setDataVersion} />
        <div className="mt-2 flex items-center justify-between">
          <label className="mb-0.5 block text-[10px] font-medium text-muted-foreground">或粘贴数据 CSV</label>
          <DemoDataButton onLoad={(data) => setParsed(data)} />
        </div>
        <textarea className="h-20 w-full rounded-md border bg-background p-2 font-mono text-[10px]" value={csv} onChange={(e) => { setCsv(e.target.value); setParsed(parseCsv(e.target.value)); }} placeholder={"identity,own_area,transfer_out_area\n1,10,3\n..."} />
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
            {busy ? "执行中…" : "执行管道五步"}
          </Button>
          {parsed && <span className="text-[10px] text-muted-foreground">{parsed.rows.length} 行 × {parsed.columnOrder.length} 列</span>}
          {error && <span className="text-[10px] text-red-600">{error}</span>}
        </div>
        <div className="mt-1 text-[9px] text-muted-foreground">{"步骤: 缺失统计 → 缩尾(1%/99%) → has_out 构造 → own_area>0 筛选 → 数据转换(center/rank/sqrt of own_area) → Table 1"}</div>

        {/* W8(闭源 statistics 数据转换实拍): 转换方法多选 + 目标列 */}
        <div className="mt-2 rounded-lg border bg-muted/20 p-2">
          <p className="mb-1 text-[10px] font-medium text-muted-foreground">数据转换(可多选, 作用于所选数值列)</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {[["zscore", "Z-score 标准化 (x-mean)/std"], ["minmax", "Min-Max 归一化 [0,1]"], ["log", "对数转换 ln(x)"], ["rank", "排名转换 秩次"], ["sqrt", "开方转换 sqrt(x)"]].map(([k, lb]) => (
              <button key={k} onClick={() => setTransformMethods((p) => p.includes(k) ? p.filter((x) => x !== k) : [...p, k])}
                className={`rounded-full border px-2 py-0.5 text-[9px] ${transformMethods.includes(k) ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-700" : "border-border text-muted-foreground hover:border-muted-foreground"}`}>
                {lb}
              </button>
            ))}
            <select value={transformVars.join(",")} onChange={(e) => setTransformVars(e.target.value ? e.target.value.split(",") : [])}
              className="ml-1 max-w-40 rounded border bg-background px-1 py-0.5 text-[9px]">
              <option value="">目标列: own_area(默认)</option>
              {(parsed?.columnOrder ?? dataVersion?.columns ?? []).filter((c) => c !== "identity").map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {verifyReport && (
        <div className={`rounded-lg border p-2 text-[10px] ${verifyReport.issues?.length ? "border-amber-500/30 bg-amber-500/10 text-amber-700" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"}`}>
          <div className="flex items-center gap-1 font-semibold"><ShieldCheck className="h-3 w-3" /> 反 hallucinate 核对报告: {verifyReport.verdict}</div>
          {(verifyReport.checks ?? []).map((c: string, i: number) => <div key={i}>· {c}</div>)}
          {(verifyReport.issues ?? []).map((c: string, i: number) => <div key={i}>· ❌ {c}</div>)}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          {result.tables?.map((t: any, i: number) => (
            <div key={i} className="overflow-x-auto rounded-lg border">
              <div className="border-b bg-muted/30 px-2 py-1 text-[11px] font-medium">{t.title}</div>
              <table className="w-full text-[11px]">
                <thead><tr className="border-b bg-muted/20 text-left">{(t.cols ?? []).map((c: string, ci: number) => <th key={ci} className="px-2 py-1 font-medium">{c}</th>)}</tr></thead>
                <tbody>
                  {(t.rows ?? []).map((r: any[], ri: number) => (
                    <tr key={ri} className="border-b last:border-0">{r.map((v, ci) => <td key={ci} className={`px-2 py-1 ${ci === 0 ? "font-medium" : ""}`}>{String(v)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {stataCode && (
        <div>
          <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold"><FileCode2 className="h-3 w-3 text-emerald-600" /> Stata 复现代码(常量模板, 与 Python 管道同名步骤)</div>
          <CodeBlock code={stataCode} filename="pipeline.do" />
        </div>
      )}
    </div>
  );
}
