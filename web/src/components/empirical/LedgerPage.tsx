// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// LedgerPage.tsx — 证据账本（econ-paper-studio evidence ledger 模式）: 系数四维绑定
import { useState, useEffect } from "react";
import { BookMarked, Plus, Trash2, RefreshCw, BookOpen } from "lucide-react";
import { apiEmpirical } from "../../lib/api";
import { Button } from "../ui/button";

interface LedgerEntry {
  id: string; runId: string | null; coefficient: string; coefValue: string; sePvalue: string;
  spec: string; codeSnippet: string; dataTable: string; rawDataRef: string;
  literatureRef: { cite_key: string; title: string; authors: string; source: string }[];
  status: string; created_at: string;
}

export function LedgerPage({ projectId }: { projectId?: string }) {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [citations, setCitations] = useState<any[]>([]);
  const [selected, setSelected] = useState<LedgerEntry | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    if (!projectId) return;
    void apiEmpirical.ledgerList(projectId).then((r) => {
      setEntries(r.entries as LedgerEntry[]);
      if (r.entries.length > 0 && !selected) setSelected(r.entries[0] as LedgerEntry);
    }).catch((e) => setError(e?.message ?? "加载失败"));
    void apiEmpirical.ledgerCitations(projectId).then((r) => setCitations(r.citations)).catch(() => {});
  };
  useEffect(load, [projectId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const remove = async (id: string) => {
    await apiEmpirical.ledgerDelete(id);
    load();
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <BookMarked className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-semibold">证据账本</span>
          <span className="text-[10px] text-muted-foreground">每个系数绑定: 代码片段 / 数据表 / 原始数据 / 文献 — 杜绝 AI 编造回归结果(econ-paper-studio evidence ledger 思想)</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={load}><RefreshCw className="h-3 w-3" /></Button>
        </div>
        {!projectId && <div className="text-[10px] text-muted-foreground">请先在上方工作台概览创建/选择课题</div>}
        {error && <div className="text-[10px] text-red-600">{error}</div>}
        {citations.length > 0 && (
          <div className="mt-1 text-[9px] text-muted-foreground">文献库: {citations.map((c) => c.citeKey).join(", ")}</div>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-[280px_1fr]">
        <div className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
          {entries.length === 0 && (
            <div className="rounded-lg border border-dashed p-3 text-[10px] text-muted-foreground">
              暂无条目。在「结果解释闸门」确认后, 从回归结果表点击「入账」添加。
            </div>
          )}
          {entries.map((e) => (
            <button key={e.id} onClick={() => setSelected(e)} className={`w-full rounded-lg border p-2 text-left ${selected?.id === e.id ? "border-emerald-500/50 bg-emerald-500/5" : "hover:bg-accent"}`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold">{e.coefficient}</span>
                <span className={`rounded px-1 py-0.5 text-[8px] ${e.status === "needs_update" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                  {e.status === "needs_update" ? "⚠️ 需更新" : "linked"}
                </span>
              </div>
              <div className="mt-0.5 text-[10px]">系数 = <b>{e.coefValue}</b> | {e.dataTable}</div>
              <div className="text-[9px] text-muted-foreground">{new Date(e.created_at).toLocaleString()}</div>
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {selected && (
            <>
              <div className="rounded-lg border bg-card p-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold">{selected.coefficient} — 系数 {selected.coefValue}</span>
                  <button className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] text-red-600 hover:bg-red-500/10" onClick={() => void remove(selected.id)}>
                    <Trash2 className="h-3 w-3" /> 删除
                  </button>
                </div>
              </div>
              <div className="grid gap-1.5 md:grid-cols-2">
                <div className="rounded-lg border bg-card p-2">
                  <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-muted-foreground"><Plus className="h-3 w-3" /> ① 代码片段</div>
                  <pre className="max-h-32 overflow-auto rounded bg-muted/30 p-1.5 font-mono text-[9px]">{selected.codeSnippet || "(未绑定)"}</pre>
                </div>
                <div className="rounded-lg border bg-card p-2">
                  <div className="mb-1 text-[10px] font-semibold text-muted-foreground">② 数据表</div>
                  <div className="text-[10px]">{selected.dataTable || "(未绑定)"}</div>
                  <div className="mb-1 mt-2 text-[10px] font-semibold text-muted-foreground">③ 原始数据</div>
                  <div className="rounded bg-muted/30 px-1.5 py-0.5 text-[10px]">{selected.rawDataRef || "(未绑定, 需从数据版本下拉选择)"}</div>
                </div>
              </div>
              <div className="rounded-lg border bg-card p-2">
                <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-muted-foreground"><BookOpen className="h-3 w-3" /> ④ 参考文献</div>
                {(selected.literatureRef ?? []).length === 0 && <div className="text-[9px] text-muted-foreground">(未绑定文献)</div>}
                {(selected.literatureRef ?? []).map((c, i) => (
                  <div key={i} className="mb-1 rounded border p-1.5 text-[10px]">
                    <div className="font-medium">[{c.cite_key}] {c.title}</div>
                    <div className="text-[9px] text-muted-foreground">{c.authors} | {c.source}</div>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border bg-card p-2 text-[9px] text-muted-foreground">
                spec: {selected.spec?.slice(0, 120) || "(未记录)"}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
