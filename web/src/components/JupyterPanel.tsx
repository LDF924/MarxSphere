// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// JupyterPanel.tsx — 轻量 notebook 工作台（2026-08-27, ScienceX 通用计算环境）
// 单元格编辑 → venv 执行 → 输出/图表/持久变量；Restart & Run All 全跑
// 设计: 复用实证沙箱（无完整 Jupyter 依赖），variables 跨单元持久模拟内核
import React, { useEffect, useRef, useState } from "react";
import { Play, RotateCcw, Plus, Trash2, Loader2, FileCode2, Wand2 } from "lucide-react";

interface CellResult {
  ok: boolean;
  output: string;
  error?: string;
  figures: string[];
  variables: Record<string, unknown>;
  cellIndex?: number;
}

// 演示 notebook（2026-08-27: 载入示例 — 资本下乡调研数据探索）
const DEMO_CELLS: string[] = [
  `# 演示: 资本下乡调研数据探索
# 模拟 50 个村庄样本: 是否引入工商资本、村集体收入、耕地流转率
import pandas as pd
import numpy as np

rng = np.random.default_rng(42)
n = 50
df = pd.DataFrame({
    "村庄": [f"村{i+1}" for i in range(n)],
    "引入工商资本": rng.choice([0, 1], n, p=[0.4, 0.6]),
    "村集体收入_万元": rng.normal(80, 25, n).round(1),
    "耕地流转率_pct": rng.normal(35, 12, n).round(1),
})
print("样本量:", len(df), "| 列:", list(df.columns))`,
  `# 描述统计: 引入资本 vs 未引入的差异
print(df.groupby("引入工商资本")[["村集体收入_万元", "耕地流转率_pct"]].mean().round(1))`,
  `# 可视化: 资本引入与集体收入的关系
import matplotlib.pyplot as plt
plt.figure(figsize=(6, 4))
plt.scatter(df["耕地流转率_pct"], df["村集体收入_万元"], c=df["引入工商资本"], cmap="coolwarm", alpha=0.7)
plt.xlabel("耕地流转率 (%)"); plt.ylabel("村集体收入 (万元)")
plt.title("资本引入与集体收入")
plt.colorbar(label="引入工商资本")
plt.tight_layout()
plt.show()`,
  `# 相关性
print(df[["引入工商资本", "村集体收入_万元", "耕地流转率_pct"]].corr().round(3))`,
];

export function JupyterPanel() {
  const [cells, setCells] = useState<string[]>(["import pandas as pd\nprint('notebook 就绪')"]);
  const [results, setResults] = useState<(CellResult | null)[]>([]);
  const [sessionId, setSessionId] = useState<string>(`nb-${Date.now()}`);
  const [running, setRunning] = useState<number | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [ready, setReady] = useState<{ ready: boolean; python: string } | null>(null);
  const [vars, setVars] = useState<Record<string, unknown>>({});
  const inputRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

  useEffect(() => {
    fetch("/api/jupyter/ready").then((r) => r.json()).then(setReady).catch(() => {});
  }, []);

  // 2026-08-27: 载入演示 notebook（清空当前 → 填入 4 个演示单元格）
  const loadDemo = async () => {
    const newId = `nb-${Date.now()}`;
    setSessionId(newId);
    setCells(DEMO_CELLS);
    setResults([]);
    setVars({});
    await fetch("/api/jupyter/reset", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: newId }),
    }).catch(() => {});
    setRunningAll(true);
    for (let i = 0; i < DEMO_CELLS.length; i++) {
      const res = await fetch("/api/jupyter/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: DEMO_CELLS[i], sessionId: newId, cellIndex: i }),
      }).then((r) => r.json()).catch(() => ({ result: { ok: false, output: "", error: "请求失败" } }));
      const r = res.result as CellResult;
      setResults((prev) => { const n = [...prev]; n[i] = r; return n; });
      if (r.variables) setVars(r.variables);
    }
    setRunningAll(false);
  };

  const runCell = async (i: number) => {
    setRunning(i);
    const res = await fetch("/api/jupyter/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: cells[i], sessionId, cellIndex: i }),
    }).then((r) => r.json()).catch(() => ({ result: { ok: false, output: "", error: "请求失败" } }));
    const r = res.result as CellResult;
    setResults((prev) => { const n = [...prev]; n[i] = r; return n; });
    if (r.variables) setVars(r.variables);
    setRunning(null);
  };

  const restart = async () => {
    const newId = `nb-${Date.now()}`;
    setSessionId(newId);
    setResults([]);
    setVars({});
    await fetch("/api/jupyter/reset", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: newId }),
    }).catch(() => {});
  };

  const runAllCells = async () => {
    setRunningAll(true);
    await restart();
    for (let i = 0; i < cells.length; i++) {
      await runCell(i);
    }
    setRunningAll(false);
  };

  const addCell = () => { setCells((c) => [...c, ""]); setResults((r) => [...r, null]); };
  const removeCell = (i: number) => {
    setCells((c) => c.filter((_, j) => j !== i));
    setResults((r) => r.filter((_, j) => j !== i));
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <FileCode2 className="h-4 w-4 text-emerald-600" />
        <span className="text-xs font-semibold">Notebook 工作台</span>
        <span className="text-[10px] text-muted-foreground">
          {ready?.ready ? `Python: ${ready.python}` : "venv 未配置 (EMPIRICAL_PYTHON)"}
        </span>
        <div className="ml-auto flex gap-1">
          <button type="button" onClick={() => void loadDemo()} disabled={runningAll}
            className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
            title="载入资本下乡调研数据探索演示（4 个单元格自动运行）">
            <Wand2 className="h-3 w-3" /> 载入演示
          </button>
          <button type="button" onClick={() => void restart()} disabled={runningAll}
            className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40">
            <RotateCcw className="h-3 w-3" /> Restart
          </button>
          <button type="button" onClick={() => void runAllCells()} disabled={runningAll}
            className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40">
            {runningAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run All
          </button>
        </div>
      </div>

      {/* 持久变量显示（内核状态） */}
      <div className="rounded border bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">
        内核变量: {Object.keys(vars).length > 0 ? Object.keys(vars).slice(0, 8).join(", ") + (Object.keys(vars).length > 8 ? ` +${Object.keys(vars).length - 8}` : "") : "（无）"}
      </div>

      {/* 单元格列表 */}
      {cells.map((code, i) => (
        <div key={i} className="flex flex-col gap-1 rounded border">
          <div className="flex items-center gap-1 border-b bg-muted/20 px-1.5 py-0.5">
            <span className="text-[9px] font-mono text-muted-foreground">[{i}]</span>
            <button type="button" onClick={() => void runCell(i)} disabled={running !== null || runningAll}
              className="flex items-center gap-0.5 rounded bg-emerald-600/10 px-1.5 py-0.5 text-[9px] text-emerald-700 hover:bg-emerald-600/20 disabled:opacity-40">
              {running === i ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />} 运行
            </button>
            <button type="button" onClick={() => addCell()}
              className="rounded px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-accent"><Plus className="h-2.5 w-2.5" /></button>
            {cells.length > 1 && (
              <button type="button" onClick={() => removeCell(i)}
                className="ml-auto rounded px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-red-50 hover:text-red-600"><Trash2 className="h-2.5 w-2.5" /></button>
            )}
          </div>
          <textarea
            ref={(el) => { inputRefs.current[i] = el; }}
            value={code}
            onChange={(e) => setCells((c) => c.map((v, j) => (j === i ? e.target.value : v)))}
            spellCheck={false}
            placeholder="# 输入 Python 代码，如: df = pd.DataFrame({'a':[1,2,3]})"
            className="min-h-[60px] w-full resize-y bg-background p-2 font-mono text-[11px] outline-none placeholder:text-muted-foreground/40"
          />
          {results[i] && (
            <div className="border-t bg-muted/10 px-2 py-1.5 text-[11px]">
              {!results[i]!.ok && results[i]!.error && (
                <pre className="whitespace-pre-wrap rounded bg-red-50 p-1.5 font-mono text-[10px] text-red-700">{results[i]!.error}</pre>
              )}
              {results[i]!.output && (
                <pre className="whitespace-pre-wrap font-mono text-[10px] text-foreground/80">{results[i]!.output}</pre>
              )}
              {results[i]!.figures.map((f, fi) => (
                <img key={fi} src={`data:image/png;base64,${f}`} alt={`figure-${i}-${fi}`} className="mt-1 max-h-64 rounded border" />
              ))}
              {results[i]!.ok && !results[i]!.output && results[i]!.figures.length === 0 && (
                <span className="text-[10px] text-muted-foreground">✓ 执行成功（无输出）</span>
              )}
            </div>
          )}
        </div>
      ))}

      <button type="button" onClick={addCell}
        className="flex items-center justify-center gap-1 rounded border border-dashed py-1.5 text-[10px] text-muted-foreground hover:bg-accent">
        <Plus className="h-3 w-3" /> 添加单元格
      </button>
    </div>
  );
}
