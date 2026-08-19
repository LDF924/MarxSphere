// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// DiagnosisPage.tsx — 数据诊断（V380+）: 数据缺失 + 田野信息 → 问卷问题/方案/补齐要点
import { useState } from "react";
import { Stethoscope, Loader2, Play, CheckCircle2 } from "lucide-react";
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
      if (raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    });
  });
  return { columnOrder, rows };
}

const SEV_COLOR: Record<string, string> = {
  high: "border-red-500/40 bg-red-500/10 text-red-700",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-700",
  low: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700",
};

export function DiagnosisPage({ projectId }: { projectId?: string }) {
  const [csv, setCsv] = useState("");
  const [parsed, setParsed] = useState<{ columnOrder: string[]; rows: (string | number | null)[][] } | null>(null);
  const [fieldNotes, setFieldNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState("");
  const [handled, setHandled] = useState<Set<number>>(new Set());

  const run = async () => {
    if (!parsed) { setError("请先粘贴数据"); return; }
    if (!fieldNotes.trim()) { setError("请填写田野调查信息"); return; }
    setBusy(true); setError(""); setReport(null);
    try {
      const r = await apiEmpirical.diagnosis({ projectId, data: parsed, fieldNotes });
      setReport(r.report);
    } catch (e: any) {
      setError(e?.message ?? "诊断失败");
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-semibold">数据诊断</span>
          <span className="text-[10px] text-muted-foreground">前期数据 + 田野信息 → 问卷问题、解决方案、补齐要点</span>
        </div>
        <div className="flex items-center justify-between">
          <label className="mb-0.5 block text-[10px] font-medium text-muted-foreground">前期收集的数据 CSV(首行=变量名; 空值/-88/-99 计为缺失)</label>
          <DemoDataButton onLoad={(data) => setParsed(data)} />
        </div>
        <textarea
          className="h-28 w-full rounded-md border bg-background p-2 font-mono text-[10px]"
          value={csv}
          onChange={(e) => { setCsv(e.target.value); setParsed(parseCsv(e.target.value)); }}
          placeholder={"identity,adj_willing,nonfarm_income\n1,2,18000\n..."}
        />
        <label className="mb-0.5 mt-2 block text-[10px] font-medium text-muted-foreground">田野调查信息(前期收集数据/访谈观察/当地情况)</label>
        <textarea
          className="h-20 w-full rounded-md border bg-background p-2 text-[10px]"
          value={fieldNotes}
          onChange={(e) => setFieldNotes(e.target.value)}
          placeholder="如: 部分问卷由村干部代填, 收入问题拒答率高, 农户对'调地'概念理解有偏差…"
        />
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
            {busy ? "诊断中…(约20-40s)" : "开始诊断"}
          </Button>
          {parsed && <span className="text-[10px] text-muted-foreground">{parsed.rows.length} 行 × {parsed.columnOrder.length} 列</span>}
          {error && <span className="text-[10px] text-red-600">{error}</span>}
        </div>
      </div>

      {report && (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold">诊断结果</div>
          {(report.problems ?? []).map((p: any, i: number) => (
            <div key={i} className={`rounded-lg border p-2 ${SEV_COLOR[p.severity] ?? SEV_COLOR.medium}`}>
              <div className="flex items-center gap-2">
                <span className="rounded bg-black/10 px-1 py-0.5 text-[9px] font-semibold">{String(p.severity ?? "").toUpperCase()}</span>
                <span className="rounded bg-white/40 px-1 py-0.5 text-[9px]">{p.type}</span>
                <span className="text-[11px] font-medium">{p.location}</span>
                <button
                  className="ml-auto flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] hover:bg-black/5"
                  onClick={() => { const s = new Set(handled); s.has(i) ? s.delete(i) : s.add(i); setHandled(s); }}
                >
                  <CheckCircle2 className={`h-3 w-3 ${handled.has(i) ? "text-emerald-600" : "text-muted-foreground"}`} />
                  {handled.has(i) ? "已处理" : "标记已处理"}
                </button>
              </div>
              <div className="mt-1 text-[10px]">{p.evidence}</div>
            </div>
          ))}
          <div className="rounded-lg border bg-card p-2">
            <div className="mb-1 text-[10px] font-semibold text-muted-foreground">解决方案</div>
            {(report.solutions ?? []).map((s: any, i: number) => (
              <div key={i} className="mb-1 rounded border p-1.5 text-[10px]">
                <span className="font-medium">→ 问题 {Number(s.problemIdx ?? 0) + 1}: {s.action}</span>
                {(s.steps ?? []).map((st: string, si: number) => (
                  <div key={si} className="ml-3 text-muted-foreground">· {st}</div>
                ))}
              </div>
            ))}
          </div>
          {report.completeness && (
            <div className="rounded-lg border bg-card p-2 text-[10px]">
              <div className="font-semibold text-muted-foreground">覆盖与补齐</div>
              <div className="mt-1"><span className="font-medium">已覆盖: </span>{(report.completeness.covered ?? []).join("、")}</div>
              <div className="mt-0.5"><span className="font-medium">数据缺口: </span>{(report.completeness.gaps ?? []).join("、")}</div>
              <div className="mt-0.5"><span className="font-medium text-emerald-700">补齐要点: </span>{(report.completeness.fillPoints ?? []).join("; ")}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
