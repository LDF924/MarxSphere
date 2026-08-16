// RegressionPage.tsx — 回归生成（V380+）: 基准/FE/聚类SE/交互 + 稳健性/安慰剂/IV/事件研究模板 + Agent Debug
import { useState, useEffect } from "react";
import { LineChart, Loader2, Play, FileCode2, AlertTriangle } from "lucide-react";
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

export function RegressionPage({ projectId }: { projectId?: string }) {
  const [csv, setCsv] = useState("");
  const [parsed, setParsed] = useState<{ columnOrder: string[]; rows: (string | number | null)[][] } | null>(null);
  const [dataVersion, setDataVersion] = useState<EmpiricalDataVersion | null>(null);
  const [dep, setDep] = useState("adj_willing");
  const [core, setCore] = useState("identity");
  const [controls, setControls] = useState("edu,own_area");
  const [cluster, setCluster] = useState("");
  const [model, setModel] = useState("ologit");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [result, setResult] = useState<any>(null);
  const [templates, setTemplates] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState("");
  const [debugBusy, setDebugBusy] = useState(false);
  const [interpConfirmed, setInterpConfirmed] = useState(false);
  const [lastRunId, setLastRunId] = useState<string | null>(null);

  // 加载闸门状态(结果解释确认后显示入账按钮)
  useEffect(() => {
    if (!projectId) return;
    void apiEmpirical.gates(projectId).then((r) => {
      const g = r.gates.find((x) => x.node === "result_interpretation");
      setInterpConfirmed(g?.status === "confirmed");
    }).catch(() => {});
  }, [projectId]);

  // 入账(只传坐标, 数值由服务端从真实结果读取)
  const addToLedger = async (tableIndex: number, rowIndex: number, colIndex: number) => {
    if (!projectId || !lastRunId) { setError("缺少课题或运行记录"); return; }
    try {
      const r = await apiEmpirical.ledgerAdd({ projectId, runId: lastRunId, tableIndex, rowIndex, colIndex });
      if (r.ok) setWarnings((w) => [...w, `✅ 已入账: ${r.entry?.coefficient} = ${r.entry?.coefValue} (见证据账本页)`]);
      else setError(r.error ?? "入账失败");
    } catch (e: any) {
      setError(e?.message ?? "入账失败");
    }
  };

  const buildSpec = () => ({
    dep, core: core.split(",").map((c) => c.trim()).filter(Boolean),
    controls: controls.split(",").map((c) => c.trim()).filter(Boolean),
    cluster: cluster || undefined,
    model: (model as any) ?? "ols",
  });

  const generate = async () => {
    const data = parsed ?? (dataVersion ? { columnOrder: dataVersion.columns, rows: [] as any[] } : null);
    if (!data || data.rows.length === 0) { setError("请先粘贴数据或选择数据版本"); return; }
    setBusy(true); setError(""); setCode(""); setResult(null);
    try {
      const spec = buildSpec();
      const r = await apiEmpirical.regressionGenerate({ projectId, data, spec });
      if (!r.ok || !r.code) { setError(r.error ?? "生成失败"); setBusy(false); return; }
      setCode(r.code);
      setWarnings(r.meta?.warnings ?? []);
      // 执行
      const rr = await apiEmpirical.regressionRun({ projectId, data, spec, code: r.code });
      if (!rr.ok || !rr.taskId) { setError(rr.error ?? "执行失败"); setBusy(false); return; }
      for (let i = 0; i < 200; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const res = await apiEmpirical.result(rr.taskId!);
        if (res.status === "done") { setResult(res.result); setLastRunId(rr.taskId); setBusy(false); return; }
        if (res.status === "error") { setError(res.error ?? "执行失败"); setBusy(false); return; }
      }
      setError("超时"); setBusy(false);
    } catch (e: any) {
      setError(e?.message ?? "失败"); setBusy(false);
    }
  };

  const loadTemplates = async () => {
    const spec = buildSpec();
    const r = await apiEmpirical.regressionTemplates(spec);
    setTemplates(r.templates);
  };

  const debug = async (errorLog: string) => {
    const data = parsed ?? (dataVersion ? { columnOrder: dataVersion.columns, rows: [] as any[] } : null);
    if (!data) return;
    setDebugBusy(true);
    try {
      const r = await apiEmpirical.regressionDebug({ projectId, code, errorLog, columns: data.columnOrder });
      if (r.ok && r.fixedCode) {
        setCode(r.fixedCode);
        setWarnings([...(warnings ?? []), `🔧 Agent 已修复: ${r.explanation ?? ""}`]);
      }
    } catch (e: any) {
      setError(e?.message ?? "调试失败");
    } finally { setDebugBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <LineChart className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-semibold">回归生成</span>
          <span className="text-[10px] text-muted-foreground">基准/固定效应/聚类SE/交互项 + 稳健性/安慰剂/IV/事件研究模板</span>
        </div>
        <DataVersionBar projectId={projectId} value={dataVersion?.id ?? null} onChange={setDataVersion} />
        <div className="mt-2 flex items-center justify-between">
          <label className="mb-0.5 block text-[10px] font-medium text-muted-foreground">或粘贴数据 CSV</label>
          <DemoDataButton onLoad={(data) => {
            setParsed(data);
            setDep("adj_willing");
            setCore("identity,edu,own_area");
            setControls("hh_size");
            setCluster("hukou");
            setModel("ologit");
          }} />
        </div>
        <textarea className="h-16 w-full rounded-md border bg-background p-2 font-mono text-[10px]" value={csv} onChange={(e) => { setCsv(e.target.value); setParsed(parseCsv(e.target.value)); }} placeholder={"adj_willing,identity,edu,own_area\n2,1,3,10\n..."} />
        <div className="mt-2 grid gap-1.5 md:grid-cols-5">
          <label className="block"><span className="mb-0.5 block text-[9px] font-medium text-muted-foreground">因变量</span>
            <input className="w-full rounded border bg-background px-1.5 py-1 text-[10px]" value={dep} onChange={(e) => setDep(e.target.value)} /></label>
          <label className="block"><span className="mb-0.5 block text-[9px] font-medium text-muted-foreground">核心解释(逗号分隔)</span>
            <input className="w-full rounded border bg-background px-1.5 py-1 text-[10px]" value={core} onChange={(e) => setCore(e.target.value)} /></label>
          <label className="block"><span className="mb-0.5 block text-[9px] font-medium text-muted-foreground">控制变量(逗号)</span>
            <input className="w-full rounded border bg-background px-1.5 py-1 text-[10px]" value={controls} onChange={(e) => setControls(e.target.value)} /></label>
          <label className="block"><span className="mb-0.5 block text-[9px] font-medium text-muted-foreground">聚类变量(可选)</span>
            <input className="w-full rounded border bg-background px-1.5 py-1 text-[10px]" value={cluster} onChange={(e) => setCluster(e.target.value)} placeholder="如 hukou" /></label>
          <label className="block"><span className="mb-0.5 block text-[9px] font-medium text-muted-foreground">模型</span>
            <select className="w-full rounded border bg-background px-1.5 py-1 text-[10px]" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="ols">OLS</option><option value="logit">Logit</option><option value="ologit">Ordered Logit</option>
            </select></label>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" onClick={() => void generate()} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
            {busy ? "生成+执行中…" : "生成并执行回归"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void loadTemplates()}>加载检验模板</Button>
          {error && <span className="text-[10px] text-red-600">{error}</span>}
        </div>
        {warnings.length > 0 && (
          <div className="mt-2 space-y-1">
            {(warnings ?? []).map((w, i) => (
              <div key={i} className="flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 p-1 text-[9px] text-amber-700"><AlertTriangle className="h-3 w-3" /> {w}</div>
            ))}
          </div>
        )}
        <div className="mt-1 text-[9px] text-muted-foreground">⚠️ 内生性/平行趋势/排他性由研究者判断 — Agent 不做假设检验</div>
      </div>

      {code && (
        <div>
          <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold"><FileCode2 className="h-3 w-3 text-emerald-600" /> 生成代码</div>
          <CodeBlock code={code} filename="regression.do" onDebug={debug} debugBusy={debugBusy} />
        </div>
      )}

      {templates && (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold">检验模板(静态生成, 变量名注入)</div>
          {Object.entries(templates).map(([k, v]) => (
            <div key={k}>
              <div className="mb-0.5 text-[10px] font-medium text-muted-foreground capitalize">{k}</div>
              <CodeBlock code={v} filename={`${k}.do`} />
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          {(result.tables ?? []).map((t: any, i: number) => (
            <div key={i} className="overflow-x-auto rounded-lg border">
              <div className="border-b bg-muted/30 px-2 py-1 text-[11px] font-medium">{t.title} <span className="ml-2 text-[9px] text-muted-foreground">{t.notes}</span>
                {interpConfirmed && (
                  <span className="ml-2 rounded bg-emerald-500/10 px-1 py-0.5 text-[9px] text-emerald-700">✅ 解释已确认 — 可入账</span>
                )}
              </div>
              <table className="w-full text-[11px]">
                <thead><tr className="border-b bg-muted/20 text-left">{(t.cols ?? []).map((c: string, ci: number) => <th key={ci} className="px-2 py-1 font-medium">{c}</th>)}
                  {interpConfirmed && <th className="px-2 py-1 font-medium">证据账本</th>}
                </tr></thead>
                <tbody>
                  {(t.rows ?? []).map((r: any[], ri: number) => (
                    <tr key={ri} className="border-b last:border-0">
                      {r.map((v, ci) => <td key={ci} className={`px-2 py-1 ${ci === 0 ? "font-medium" : ""}`}>{String(v)}</td>)}
                      {interpConfirmed && (
                        <td className="px-2 py-1">
                          <button className="rounded border border-emerald-600/30 bg-emerald-600/10 px-1.5 py-0.5 text-[9px] text-emerald-700 hover:bg-emerald-600/20"
                            onClick={() => void addToLedger(i, ri, 0)}>
                            + 入账
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
