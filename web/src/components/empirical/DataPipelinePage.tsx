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

  // 默认步骤(演示): 缺失统计全列 + 缩尾收入 + 构造 has_out + 筛选有地 + 描述
  const buildSteps = () => {
    const cols = (parsed?.columnOrder ?? dataVersion?.columns ?? []);
    return {
      missing: { cols: ["nonfarm_income", "adj_willing", "politics"] },
      winsorize: { cols: ["nonfarm_income", "own_area"] },
      genvars: [{ name: "has_out", expr: "transfer_out_area > 0" }],
      filter: [{ col: "own_area", op: ">", value: 0 }],
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
        <div className="mt-1 text-[9px] text-muted-foreground">步骤: 缺失统计(nonfarm_income/adj_willing/politics) → 缩尾(1%/99%) → has_out=转出大于0 → own_area大于0 → Table 1</div>
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
