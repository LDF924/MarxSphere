// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// LiteratureMatrixPanel.tsx — 文献提取矩阵(参考 Elicit 数据提取成表; 融入文献库)
// 用法: 从文献列表勾选论文 → 定义提取列(内置常用列 + 自定义) → LLM 逐篇提取 → 可排序表 + 导出 CSV
import { useMemo, useState } from "react";
import { Download, Loader2, Plus, Table2, X } from "lucide-react";

interface MatrixPaper { id: string; title: string }
interface MatrixCell { paperId: string; paperTitle: string; columnKey: string; value: string; quote?: string }
interface ColDef { key: string; label: string }

const COMMON_COLS: ColDef[] = [
  { key: "topic", label: "研究主题" },
  { key: "method", label: "研究方法" },
  { key: "data", label: "数据来源" },
  { key: "view", label: "核心观点" },
  { key: "conclusion", label: "主要结论" },
  { key: "limitation", label: "局限" },
];

export function LiteratureMatrixPanel({ papers }: { papers: MatrixPaper[] }) {
  const [paperIds, setPaperIds] = useState<string[]>([]);
  const [cols, setCols] = useState<ColDef[]>(COMMON_COLS.slice(0, 3));
  const [customLabel, setCustomLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ papers: MatrixPaper[]; cells: MatrixCell[] } | null>(null);
  const [msg, setMsg] = useState("");
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [quotePaper, setQuotePaper] = useState<string | null>(null);

  const togglePaper = (id: string) => {
    setPaperIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const toggleCol = (c: ColDef) => {
    setCols((prev) => (prev.some((x) => x.key === c.key) ? prev.filter((x) => x.key !== c.key) : [...prev, c]));
  };
  const addCustomCol = () => {
    if (!customLabel.trim()) return;
    const key = `custom${Date.now().toString(36)}`;
    setCols((prev) => [...prev, { key, label: customLabel.trim() }]);
    setCustomLabel("");
  };

  const run = async () => {
    if (paperIds.length === 0) { setMsg("先勾选论文(≥1)"); return; }
    if (cols.length === 0) { setMsg("至少选 1 个提取列"); return; }
    setLoading(true); setMsg("");
    try {
      const res = await fetch("/api/literature/matrix", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperIds, columns: cols }),
      });
      const d = await res.json();
      if (!res.ok) { setMsg(d?.error?.message ?? `失败: HTTP ${res.status}`); return; }
      setResult({ papers: d.papers ?? [], cells: d.cells ?? [] });
      setMsg(`✅ 提取完成: ${(d.papers ?? []).length} 篇 × ${cols.length} 列`);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  // 单元格按 paper×col 排布
  const table = useMemo(() => {
    if (!result) return null;
    const rows = result.papers.map((p) => {
      const row: Record<string, string> = { _paperId: p.id, _title: p.title };
      for (const c of cols) {
        const cell = result.cells.find((x) => x.paperId === p.id && x.columnKey === c.key);
        row[c.key] = cell?.value ?? "";
      }
      return row;
    });
    if (sortCol) {
      rows.sort((a, b) => (a[sortCol] ?? "").localeCompare(b[sortCol] ?? "", "zh"));
    }
    return rows;
  }, [result, cols, sortCol]);

  const exportCsv = () => {
    if (!table) return;
    const head = ["论文", ...cols.map((c) => c.label)];
    const lines = table.map((r) => [r._title, ...cols.map((c) => (r[c.key] ?? "").replace(/[\n,]/g, " "))]);
    const csv = [head, ...lines].map((l) => l.map((x) => `"${x}"`).join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "文献提取矩阵.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="rounded-lg border border-sky-400/20 bg-sky-400/[0.03] p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-sky-200/90">
        <Table2 className="h-4 w-4" /> 文献提取矩阵
        <span className="text-[9px] font-normal text-muted-foreground/60">勾选论文 → 定义提取列 → LLM 逐篇提取成表(参考 Elicit)</span>
        <span className="ml-auto text-[10px] text-muted-foreground/60">已选 {paperIds.length} 篇</span>
      </div>

      {/* 引导步骤 */}
      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {[
          { icon: "①", title: "勾选论文", desc: "下方列表点选" },
          { icon: "②", title: "定义提取列", desc: "常用/自定义" },
          { icon: "③", title: "LLM 逐篇提取", desc: "自动提取+引文" },
          { icon: "④", title: "排序/导出", desc: "点列头+CSV" },
        ].map((g) => (
          <div key={g.title} className="rounded-lg border border-sky-400/15 bg-sky-400/[0.03] p-2">
            <div className="text-xs font-medium text-sky-200/90">{g.icon} {g.title}</div>
            <p className="text-[9px] text-muted-foreground/60">{g.desc}</p>
          </div>
        ))}
      </div>

      <div className="mt-2 space-y-2">
        {/* 论文选择 */}
        <div>
          <div className="mb-1 text-[10px] text-muted-foreground/60">论文(点击勾选):</div>
          <div className="max-h-24 space-y-0.5 overflow-y-auto rounded border border-border/40 bg-background/30 p-1.5">
            {papers.length === 0 && <div className="py-1 text-center text-[10px] text-muted-foreground/40">列表暂无论文</div>}
            {papers.slice(0, 40).map((p) => {
              const on = paperIds.includes(p.id);
              return (
                <button key={p.id} type="button" onClick={() => togglePaper(p.id)}
                  className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] ${on ? "bg-sky-400/15 text-sky-200" : "text-muted-foreground hover:bg-accent/30"}`}>
                  <input type="checkbox" checked={on} readOnly className="h-3 w-3 accent-sky-500" />
                  <span className="truncate">{p.title}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 列选择 */}
        <div>
          <div className="mb-1 text-[10px] text-muted-foreground/60">提取列(点击切换):</div>
          <div className="flex flex-wrap gap-1">
            {COMMON_COLS.map((c) => (
              <button key={c.key} type="button" onClick={() => toggleCol(c)}
                className={`rounded-full border px-2 py-0.5 text-[10px] ${cols.some((x) => x.key === c.key) ? "border-sky-400/50 bg-sky-400/15 text-sky-200" : "border-border/60 text-muted-foreground hover:bg-accent/30"}`}>
                {c.label}
              </button>
            ))}
            <input value={customLabel} onChange={(e) => setCustomLabel(e.target.value)} placeholder="自定义列…"
              className="h-5 w-24 rounded border border-border/60 bg-background px-1.5 text-[10px] outline-none focus:border-sky-400/50" />
            <button type="button" onClick={addCustomCol} className="rounded border border-border/60 px-1.5 text-[10px] text-muted-foreground hover:bg-accent/30"><Plus className="h-3 w-3" /></button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" onClick={run} disabled={loading}
            className="inline-flex items-center gap-1 rounded-md bg-sky-500 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-sky-400 disabled:opacity-40">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Table2 className="h-3 w-3" />}
            {loading ? `提取中(${paperIds.length} 篇)…` : "开始提取"}
          </button>
          {table && (
            <button type="button" onClick={exportCsv}
              className="inline-flex items-center gap-1 rounded-md border border-sky-400/30 px-2 py-1.5 text-[11px] text-sky-300 hover:bg-sky-400/10">
              <Download className="h-3 w-3" /> 导出 CSV
            </button>
          )}
          {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
        </div>

        {/* 结果表 */}
        {table && table.length > 0 && (
          <div className="mt-1 overflow-x-auto rounded border border-border/50">
            <table className="w-full min-w-[600px] text-left text-[11px]">
              <thead>
                <tr className="border-b border-border/60 bg-background/40">
                  <th className="px-2 py-1.5 font-medium text-muted-foreground">论文</th>
                  {cols.map((c) => (
                    <th key={c.key} className="px-2 py-1.5 font-medium text-muted-foreground">
                      <button type="button" onClick={() => setSortCol(sortCol === c.key ? null : c.key)} className="hover:text-sky-300">
                        {c.label}{sortCol === c.key ? " ▲" : " ⇅"}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.map((r, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-accent/20">
                    <td className="max-w-[160px] truncate px-2 py-1 align-top font-medium">{r._title}</td>
                    {cols.map((c) => {
                      const v = r[c.key] ?? "";
                      const cell = result?.cells.find((x) => x.paperId === r._paperId && x.columnKey === c.key);
                      return (
                        <td key={c.key} className="px-2 py-1 align-top">
                          <div className="max-w-[240px]">{v || <span className="text-muted-foreground/30">—</span>}</div>
                          {cell?.quote && (
                            <button type="button" onClick={() => setQuotePaper(quotePaper === cell.paperId ? null : cell.paperId)}
                              className="mt-0.5 text-[9px] text-sky-400/70 hover:text-sky-300">引文↗</button>
                          )}
                          {quotePaper === cell?.paperId && cell.quote && (
                            <div className="mt-0.5 rounded bg-black/20 px-1.5 py-1 text-[9px] leading-3 text-muted-foreground">"{cell.quote}"</div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
