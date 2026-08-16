// VariablesPage.tsx — 变量敲定（V380+）: 被解释/核心解释/控制/识别策略 + 人工闸门
import { useState, useEffect } from "react";
import { ListChecks, Loader2, Play, Save, RefreshCw } from "lucide-react";
import { apiEmpirical, type EmpiricalDataVersion } from "../../lib/api";
import { DataVersionBar } from "./DataVersionBar";
import { DemoDataButton } from "./DemoDataButton";
import { GateCard, type GateInfo } from "./GateCard";
import { Button } from "../ui/button";

export function VariablesPage({ projectId }: { projectId?: string }) {
  const [dataVersion, setDataVersion] = useState<EmpiricalDataVersion | null>(null);
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<any>(null);
  const [edited, setEdited] = useState("");
  const [gates, setGates] = useState<GateInfo[]>([]);
  const [error, setError] = useState("");
  const [demoColumns, setDemoColumns] = useState<string[] | null>(null);
  const [demoRows, setDemoRows] = useState(0);

  const loadGates = () => {
    if (!projectId) return;
    void apiEmpirical.gates(projectId).then((r) => setGates(r.gates)).catch(() => {});
  };
  useEffect(loadGates, [projectId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const suggest = async () => {
    const columns = demoColumns ?? dataVersion?.columns;
    const nRows = demoRows || dataVersion?.nRows || 0;
    if (!columns || columns.length === 0) { setError("请先选择数据版本或载入演示数据"); return; }
    setBusy(true); setError(""); setSuggestion(null);
    try {
      const r = await apiEmpirical.variablesSuggest({
        projectId, topic: topic || undefined,
        columns, nRows,
      });
      setSuggestion(r.suggestion);
      setEdited(JSON.stringify(r.suggestion, null, 2));
    } catch (e: any) {
      setError(e?.message ?? "建议生成失败");
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (!projectId) return;
    setBusy(true); setError("");
    try {
      let content: any;
      try { content = JSON.parse(edited); } catch { content = { text: edited }; }
      await apiEmpirical.variablesSave(projectId, content);
      loadGates();
    } catch (e: any) {
      setError(e?.message ?? "保存失败");
    } finally { setBusy(false); }
  };

  const gate = gates.find((g) => g.node === "variable_definition") ?? null;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-semibold">变量敲定</span>
          <span className="text-[10px] text-muted-foreground">被解释/核心解释/控制变量/识别策略 — LLM 建议 + 人工复核闸门(防编造变量)</span>
        </div>
        <DataVersionBar projectId={projectId} value={dataVersion?.id ?? null} onChange={setDataVersion} />
        <div className="mt-2 flex gap-2">
          <DemoDataButton onLoad={(data) => { setDemoColumns(data.columnOrder); setDemoRows(data.rows.length); }} label="载入演示数据(269列)" />
        </div>
        <div className="mt-2 flex gap-2">
          <input className="flex-1 rounded-md border bg-background px-2 py-1.5 text-[11px]" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="研究课题(可选, 默认按数据列建议)" />
          <Button size="sm" onClick={() => void suggest()} disabled={busy || !dataVersion}>
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
            生成建议
          </Button>
        </div>
        {error && <div className="mt-2 text-[10px] text-red-600">{error}</div>}
      </div>

      {suggestion && (
        <div className="rounded-lg border bg-card p-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] font-semibold">LLM 建议(可编辑)</span>
            <span className="text-[9px] text-muted-foreground">⚠️ 变量均经白名单校验(必须来自数据版本列); 请人工核对后再锁定</span>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => void save()} disabled={busy}><Save className="mr-1 h-3 w-3" /> 保存草稿</Button>
            <Button size="sm" variant="ghost" onClick={() => void suggest()}><RefreshCw className="h-3 w-3" /></Button>
          </div>
          <textarea className="h-56 w-full rounded-md border bg-background p-2 font-mono text-[10px]" value={edited} onChange={(e) => setEdited(e.target.value)} />
          <div className="mt-1 grid gap-1.5 md:grid-cols-2 text-[10px]">
            <div className="rounded border p-1.5">
              <div className="font-semibold text-muted-foreground">被解释变量</div>
              {(suggestion.dep ?? []).map((d: any, i: number) => <div key={i}>• {d.var}: {d.rationale}</div>)}
            </div>
            <div className="rounded border p-1.5">
              <div className="font-semibold text-muted-foreground">核心解释变量</div>
              {(suggestion.core ?? []).map((c: any, i: number) => <div key={i}>• {c.var}: {c.rationale}</div>)}
            </div>
            <div className="rounded border p-1.5">
              <div className="font-semibold text-muted-foreground">控制变量</div>
              <div>{(suggestion.controls ?? []).join(", ")}</div>
            </div>
            <div className="rounded border p-1.5">
              <div className="font-semibold text-muted-foreground">识别策略</div>
              <div>{suggestion.identification}</div>
            </div>
          </div>
          {(suggestion.concerns ?? []).length > 0 && (
            <div className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-1.5 text-[10px] text-amber-700">
              ⚠️ {(suggestion.concerns ?? []).join("; ")}
            </div>
          )}
        </div>
      )}

      {projectId && (
        <GateCard gate={gate} onRefresh={loadGates}>
          {gate && (
            <div className="mt-1.5 rounded border-t border-black/5 pt-1.5 text-[9px] text-muted-foreground">
              当前变量定义: {JSON.stringify(gate.content ?? {}).slice(0, 150)}
            </div>
          )}
        </GateCard>
      )}
    </div>
  );
}
