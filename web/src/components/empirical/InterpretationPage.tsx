// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// InterpretationPage.tsx — 结果解释闸门（V380+）: 回归结果 → LLM 解释草稿 → 人工确认
// 确认后解锁证据账本写入; LLM 只做统计描述, 禁用因果推断词
import { useState, useEffect } from "react";
import { FileText, Loader2, Sparkles, Save, ShieldAlert, Play } from "lucide-react";
import { apiEmpirical, apiEmpiricalDemo } from "../../lib/api";
import { GateCard, type GateInfo } from "./GateCard";
import { Button } from "../ui/button";

export function InterpretationPage({ projectId }: { projectId?: string }) {
  const [history, setHistory] = useState<any[]>([]);
  const [selectedRun, setSelectedRun] = useState<any>(null);
  const [tablesText, setTablesText] = useState("");
  const [draft, setDraft] = useState<any>(null);
  const [edited, setEdited] = useState("");
  const [gates, setGates] = useState<GateInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadGates = () => {
    if (!projectId) return;
    void apiEmpirical.gates(projectId).then((r) => setGates(r.gates)).catch(() => {});
  };
  useEffect(() => {
    if (!projectId) return;
    loadGates();
    void apiEmpirical.history(20).then((r) => setHistory(r.history ?? [])).catch(() => {});
  }, [projectId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const selectRun = (id: string) => {
    void apiEmpirical.historyDetail(id).then((r) => {
      const rec = r.record as any;
      setSelectedRun(rec);
      // 表文本化供 LLM
      const tables = rec?.result?.tables ?? [];
      setTablesText(tables.map((t: any) => `【${t.title}】\n${(t.rows ?? []).map((row: any[]) => row.join(" | ")).join("\n")}`).join("\n\n"));
    }).catch(() => {});
  };

  const generateDraft = async () => {
    if (!selectedRun || !tablesText) { setError("请先选择回归结果"); return; }
    setBusy(true); setError(""); setDraft(null);
    try {
      const r = await apiEmpirical.interpretationDraft({ projectId, runId: selectedRun.id, tablesText });
      if (!r.ok || !r.draft) { setError(r.error ?? "生成失败"); setBusy(false); return; }
      setDraft(r.draft);
      setEdited(JSON.stringify(r.draft, null, 2));
    } catch (e: any) {
      setError(e?.message ?? "生成失败");
    } finally { setBusy(false); }
  };

  // 一键演示: 载入全量演示数据 → 跑 ologit(adj_willing ~ identity+edu+own_area) → 自动填入结果
  const runDemoRegression = async () => {
    setBusy(true); setError("");
    try {
      const demo = await apiEmpiricalDemo.load();
      if (!demo.ok || !demo.data) { setError("演示数据加载失败"); setBusy(false); return; }
      // 用演示数据的核心列跑 ologit
      const keepCols = ["adj_willing", "identity", "edu", "own_area", "hh_size", "hukou"].filter((c) => demo.data!.columnOrder.includes(c));
      const colIdx = keepCols.map((c) => demo.data!.columnOrder.indexOf(c));
      const rows = demo.data.rows.map((r) => colIdx.map((ci) => r[ci] ?? null));
      const data = { columnOrder: keepCols, rows };
      const spec = { dep: "adj_willing", core: ["identity", "edu", "own_area"], controls: ["hh_size"], cluster: "hukou", model: "ologit" };
      const gen = await apiEmpirical.regressionGenerate({ projectId, data, spec });
      if (!gen.ok || !gen.code) { setError(gen.error ?? "回归生成失败"); setBusy(false); return; }
      const rr = await apiEmpirical.regressionRun({ projectId, data, spec, code: gen.code });
      if (!rr.ok || !rr.taskId) { setError(rr.error ?? "回归执行失败"); setBusy(false); return; }
      for (let i = 0; i < 200; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const res = await apiEmpirical.result(rr.taskId!);
        if (res.status === "done") {
          const tables = (res.result as any)?.tables ?? [];
          setTablesText(tables.map((t: any) => `【${t.title}】\n${(t.rows ?? []).map((row: any[]) => row.join(" | ")).join("\n")}`).join("\n\n"));
          setSelectedRun({ id: rr.taskId, method: "ologit", meta: { n: (res.result as any)?.meta?.n } });
          setError("");
          setBusy(false);
          return;
        }
        if (res.status === "error") { setError(res.error ?? "执行失败"); setBusy(false); return; }
      }
      setError("超时"); setBusy(false);
    } catch (e: any) {
      setError(e?.message ?? "演示失败"); setBusy(false);
    }
  };

  const save = async () => {
    if (!projectId) return;
    setBusy(true); setError("");
    try {
      let content: any;
      try { content = JSON.parse(edited); } catch { content = { text: edited }; }
      await apiEmpirical.interpretationSave(projectId, content);
      loadGates();
    } catch (e: any) {
      setError(e?.message ?? "保存失败");
    } finally { setBusy(false); }
  };

  const gate = gates.find((g) => g.node === "result_interpretation") ?? null;
  const gateConfirmed = gate?.status === "confirmed";

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <FileText className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-semibold">结果解释闸门</span>
          <span className="text-[10px] text-muted-foreground">回归结果 → LLM 统计描述草稿 → 人工编辑确认 → 解锁证据账本</span>
        </div>
        <div className="mb-1 text-[10px] font-medium text-muted-foreground">选择回归运行结果(最近 20 条)</div>
        <select className="w-full rounded border bg-background px-1.5 py-1 text-[10px]" value={selectedRun?.id ?? ""} onChange={(e) => e.target.value && selectRun(e.target.value)}>
          <option value="">(选择历史记录)</option>
          {history.map((h: any) => (
            <option key={h.id} value={h.id}>{h.method} · N={h.meta?.n ?? "?"} · {new Date(h.created_at).toLocaleTimeString()}</option>
          ))}
        </select>
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void runDemoRegression()} disabled={busy} title="载入全量演示数据 → 跑 ologit(adj_willing ~ identity+edu+own_area) → 自动填入结果, 再点「生成解释草稿」">
            <Play className="mr-1 h-3 w-3" /> 跑一次演示回归
          </Button>
          <Button size="sm" onClick={() => void generateDraft()} disabled={busy || !selectedRun}>
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 h-3 w-3" />}
            生成解释草稿
          </Button>
          <Button size="sm" variant="outline" onClick={() => void save()} disabled={busy || !draft}>
            <Save className="mr-1 h-3 w-3" /> 保存到闸门
          </Button>
          {error && <span className="text-[10px] text-red-600">{error}</span>}
        </div>
        <div className="mt-1 flex items-center gap-1 text-[9px] text-amber-600">
          <ShieldAlert className="h-3 w-3" />
          LLM 只做统计描述(方向/显著性/置信区间), 不推断因果; 命中禁用词(因果/导致/有效)会被拒绝
        </div>
      </div>

      {selectedRun && (
        <div className="max-h-40 overflow-y-auto rounded-lg border bg-card p-2">
          <div className="mb-1 text-[10px] font-semibold text-muted-foreground">回归结果预览</div>
          <pre className="whitespace-pre-wrap font-mono text-[9px]">{tablesText.slice(0, 3000)}</pre>
        </div>
      )}

      {draft && (
        <div className="rounded-lg border bg-card p-3">
          <div className="mb-1 text-[11px] font-semibold">解释草稿(可编辑后保存)</div>
          <textarea className="h-48 w-full rounded-md border bg-background p-2 font-mono text-[10px]" value={edited} onChange={(e) => setEdited(e.target.value)} />
        </div>
      )}

      {projectId && (
        <GateCard gate={gate} onRefresh={loadGates}>
          {gate && (
            <div className="mt-1.5 rounded border-t border-black/5 pt-1.5 text-[9px] text-muted-foreground">
              当前解释: {JSON.stringify(gate.content ?? {}).slice(0, 180)}
            </div>
          )}
        </GateCard>
      )}

      {gateConfirmed && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 text-[10px] text-emerald-700">
          ✅ 结果解释已确认 — 证据账本已解锁, 可去「证据账本」页或回归结果表「入账」
        </div>
      )}
    </div>
  );
}
