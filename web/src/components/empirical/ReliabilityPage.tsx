// ReliabilityPage.tsx — 信效度报告（V380+）: α/KMO/Bartlett/因子分析
import { useState } from "react";
import { FlaskConical, Loader2, Play, Plus, X } from "lucide-react";
import { apiEmpirical, apiEmpiricalWorkshop, type EmpiricalDataVersion } from "../../lib/api";
import { DataVersionBar } from "./DataVersionBar";
import { DemoDataButton } from "./DemoDataButton";
import { Button } from "../ui/button";

interface ScaleGroup { name: string; columns: string[] }

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

export function ReliabilityPage({ projectId }: { projectId?: string }) {
  const [csv, setCsv] = useState("");
  const [parsed, setParsed] = useState<{ columnOrder: string[]; rows: (string | number | null)[][] } | null>(null);
  const [dataVersion, setDataVersion] = useState<EmpiricalDataVersion | null>(null);
  const [groups, setGroups] = useState<ScaleGroup[]>([{ name: "量表 1", columns: [] }]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [interp, setInterp] = useState("");

  const run = async () => {
    const data = parsed ?? (dataVersion ? { columnOrder: dataVersion.columns, rows: [] } : null);
    if (!data) { setError("请先粘贴数据或选择数据版本"); return; }
    if (data.rows.length === 0) { setError("数据版本无行数据, 请粘贴 CSV"); return; }
    const validGroups = groups.filter((g) => g.name && g.columns.length >= 2);
    if (validGroups.length === 0) { setError("至少需要一个含 ≥2 列的量表组"); return; }
    setBusy(true); setError(""); setResult(null); setInterp("");
    try {
      const r = await apiEmpirical.reliability({
        projectId, data, scaleGroups: validGroups,
      });
      if (!r.ok) { setError(r.error ?? "提交失败"); setBusy(false); return; }
      // 轮询
      for (let i = 0; i < 200; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const res = await apiEmpirical.result(r.taskId!);
        if (res.status === "done") {
          setResult(res.result);
          // 等 LLM 解读落库(再轮询 pipeline_runs 不可行, 直接展示 python 结果 + 提示)
          setBusy(false);
          return;
        }
        if (res.status === "error") { setError(res.error ?? "执行失败"); setBusy(false); return; }
      }
      setError("轮询超时"); setBusy(false);
    } catch (e: any) {
      setError(e?.message ?? "信效度执行失败"); setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-semibold">信效度报告</span>
          <span className="text-[10px] text-muted-foreground">克隆巴赫α / KMO / Bartlett球形 / 因子分析(Python 实算 + LLM 解读)</span>
        </div>
        <DataVersionBar projectId={projectId} value={dataVersion?.id ?? null} onChange={setDataVersion} />
        <div className="mt-2 flex items-center justify-between">
          <label className="mb-0.5 block text-[10px] font-medium text-muted-foreground">或粘贴数据 CSV(首行=变量名)</label>
          <DemoDataButton onLoad={(data) => {
            setParsed(data);
            // 自动填意愿量表组
            setGroups([
              { name: "种地意愿量表", columns: ["adj_willing", "continue_will", "abandon_right_will"].filter((c) => data.columnOrder.includes(c)) },
              { name: "家庭特征组", columns: ["hh_size", "own_area", "cult_area"].filter((c) => data.columnOrder.includes(c)) },
            ]);
          }} />
        </div>
        <div className="mt-1">
          <textarea
            className="h-24 w-full rounded-md border bg-background p-2 font-mono text-[10px]"
            value={csv}
            onChange={(e) => { setCsv(e.target.value); setParsed(parseCsv(e.target.value)); }}
            placeholder={"identity,adj_willing,continue_will,abandon_right_will\n1,2,3,4\n..."}
          />
          {parsed && <div className="mt-1 text-[10px] text-muted-foreground">{parsed.rows.length} 行 × {parsed.columnOrder.length} 列</div>}
        </div>
        <div className="mt-2">
          <div className="mb-1 text-[10px] font-medium text-muted-foreground">量表分组(每组选择要测信度的题项列)</div>
          {groups.map((g, gi) => (
            <div key={gi} className="mb-1.5 flex items-center gap-1.5">
              <input
                className="w-28 rounded border bg-background px-1.5 py-1 text-[10px]"
                value={g.name}
                onChange={(e) => setGroups(groups.map((x, i) => i === gi ? { ...x, name: e.target.value } : x))}
                placeholder="量表名"
              />
              <select
                multiple
                className="min-h-8 flex-1 rounded border bg-background px-1.5 py-1 text-[10px]"
                value={g.columns}
                onChange={(e) => {
                  const cols = Array.from(e.target.selectedOptions).map((o) => o.value);
                  setGroups(groups.map((x, i) => i === gi ? { ...x, columns: cols } : x));
                }}
              >
                {(parsed?.columnOrder ?? dataVersion?.columns ?? []).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <button className="rounded border p-1 hover:bg-accent" onClick={() => setGroups(groups.filter((_, i) => i !== gi))}><X className="h-3 w-3" /></button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => setGroups([...groups, { name: `量表 ${groups.length + 1}`, columns: [] }])}>
            <Plus className="mr-1 h-3 w-3" /> 添加量表组
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
            {busy ? "计算中…" : "运行信效度"}
          </Button>
          {error && <span className="text-[10px] text-red-600">{error}</span>}
        </div>
      </div>

      {result && (
        <div className="space-y-2">
          <div className="rounded-lg border bg-emerald-500/5 p-2 text-[11px]">
            N={result.meta?.n}, 量表组={result.meta?.scaleGroups}; LLM 解读约 5 秒后入库(可在证据账本/概览查看)
          </div>
          {result.tables?.map((t: any, i: number) => (
            <div key={i} className="overflow-x-auto rounded-lg border">
              <div className="border-b bg-muted/30 px-2 py-1 text-[11px] font-medium">{t.title}</div>
              <table className="w-full text-[11px]">
                <thead><tr className="border-b bg-muted/20 text-left">{(t.cols ?? []).map((c: string, ci: number) => <th key={ci} className="px-2 py-1 font-medium">{c}</th>)}</tr></thead>
                <tbody>
                  {(t.rows ?? []).map((r: any[], ri: number) => (
                    <tr key={ri} className="border-b last:border-0">
                      {r.map((v, ci) => <td key={ci} className={`px-2 py-1 ${ci === 0 ? "font-medium" : ""}`}>{String(v)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {t.notes && <div className="border-t bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">{t.notes}</div>}
            </div>
          ))}
          {(result.warnings ?? []).map((w: string, i: number) => (
            <div key={i} className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-700">⚠️ {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}
