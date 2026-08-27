// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// JupyterPanel.tsx — 轻量 notebook 工作台（2026-08-27, ScienceX 通用计算环境）
// 单元格编辑(code/markdown) → venv 执行 → 输出/图表/持久变量；Restart & Run All；文件上传供 pandas 读
// 设计: 复用实证沙箱（无完整 Jupyter 依赖），variables 跨单元持久模拟内核
import React, { useEffect, useRef, useState } from "react";
import { Play, RotateCcw, Plus, Trash2, Loader2, FileCode2, Wand2, Upload, Type } from "lucide-react";

interface CellResult {
  ok: boolean;
  output: string;
  error?: string;
  figures: string[];
  variables: Record<string, unknown>;
  cellIndex?: number;
}

interface NotebookCell {
  type: "code" | "md";
  content: string;
}

// 演示 notebook（2026-08-27: 载入示例 — 资本下乡调研数据探索, 含 Markdown 说明）
const DEMO_CELLS: NotebookCell[] = [
  { type: "md", content: "# 资本下乡调研数据探索\n\n模拟 **50 个村庄**样本：是否引入工商资本、村集体收入、耕地流转率。\n\n点击「**载入演示**」自动运行全部单元格。" },
  { type: "code", content: `# 1. 生成模拟数据
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
print("样本量:", len(df), "| 列:", list(df.columns))` },
  { type: "md", content: "## 分组对比\n\n引入工商资本的村庄 vs 未引入，集体收入与流转率差异：" },
  { type: "code", content: `# 2. 描述统计: 引入资本 vs 未引入
print(df.groupby("引入工商资本")[["村集体收入_万元", "耕地流转率_pct"]].mean().round(1))` },
  { type: "code", content: `# 3. 可视化: 资本引入与集体收入的关系
import matplotlib.pyplot as plt
plt.figure(figsize=(6, 4))
plt.scatter(df["耕地流转率_pct"], df["村集体收入_万元"], c=df["引入工商资本"], cmap="coolwarm", alpha=0.7)
plt.xlabel("耕地流转率 (%)"); plt.ylabel("村集体收入 (万元)")
plt.title("资本引入与集体收入")
plt.colorbar(label="引入工商资本")
plt.tight_layout()
plt.show()` },
  { type: "code", content: `# 4. 相关性
print(df[["引入工商资本", "村集体收入_万元", "耕地流转率_pct"]].corr().round(3))` },
];

// 极简 Markdown 渲染（标题/粗体/列表/代码块）
function renderMd(text: string): React.ReactNode {
  const lines = text.split("\n");
  // 行内粗体 **x** → <b>
  const renderInline = (s: string): React.ReactNode => {
    const parts = s.split(/\*\*(.+?)\*\*/g);
    return parts.map((p, i) => (i % 2 === 1 ? <b key={i}>{p}</b> : p));
  };
  return (
    <div className="space-y-1 text-[12px] leading-relaxed text-foreground/90">
      {lines.map((line, i) => {
        if (line.startsWith("### ")) return <h4 key={i} className="text-[13px] font-semibold">{renderInline(line.slice(4))}</h4>;
        if (line.startsWith("## ")) return <h3 key={i} className="text-[14px] font-semibold">{renderInline(line.slice(3))}</h3>;
        if (line.startsWith("# ")) return <h2 key={i} className="text-[15px] font-bold">{renderInline(line.slice(2))}</h2>;
        if (line.startsWith("- ")) return <div key={i} className="pl-3">• {renderInline(line.slice(2))}</div>;
        if (line.startsWith("```")) return null;
        if (line.trim() === "") return <div key={i} className="h-1" />;
        return <div key={i}>{renderInline(line)}</div>;
      })}
    </div>
  );
}

export function JupyterPanel() {
  const [cells, setCells] = useState<NotebookCell[]>([{ type: "code", content: "import pandas as pd\nprint('notebook 就绪')" }]);
  const [results, setResults] = useState<(CellResult | null)[]>([]);
  const [sessionId, setSessionId] = useState<string>(`nb-${Date.now()}`);
  const [running, setRunning] = useState<number | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [ready, setReady] = useState<{ ready: boolean; python: string } | null>(null);
  const [vars, setVars] = useState<Record<string, unknown>>({});
  const [uploadMsg, setUploadMsg] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

  useEffect(() => {
    fetch("/api/jupyter/ready").then((r) => r.json()).then(setReady).catch(() => {});
  }, []);

  // 载入演示 notebook（清空当前 → 填入演示单元格并自动运行）
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
      const c = DEMO_CELLS[i];
      if (c.type === "md") { setResults((prev) => { const n = [...prev]; n[i] = { ok: true, output: "", figures: [], variables: {} }; return n; }); continue; }
      const res = await fetch("/api/jupyter/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: c.content, sessionId: newId, cellIndex: i }),
      }).then((r) => r.json()).catch(() => ({ result: { ok: false, output: "", error: "请求失败" } }));
      const r = res.result as CellResult;
      setResults((prev) => { const n = [...prev]; n[i] = r; return n; });
      if (r.variables) setVars(r.variables);
    }
    setRunningAll(false);
  };

  const runCell = async (i: number) => {
    if (cells[i].type === "md") { setResults((prev) => { const n = [...prev]; n[i] = { ok: true, output: "", figures: [], variables: {} }; return n; }); return; }
    setRunning(i);
    const res = await fetch("/api/jupyter/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: cells[i].content, sessionId, cellIndex: i }),
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

  const addCell = (type: "code" | "md" = "code") => { setCells((c) => [...c, { type, content: "" }]); setResults((r) => [...r, null]); };
  const removeCell = (i: number) => {
    setCells((c) => c.filter((_, j) => j !== i));
    setResults((r) => r.filter((_, j) => j !== i));
  };
  const toggleCellType = (i: number) => {
    setCells((c) => c.map((v, j) => (j === i ? { ...v, type: v.type === "code" ? "md" : "code" } : v)));
  };

  // 文件上传（存服务端 .cache/jupyter-uploads, pandas 可用相对路径读）
  const uploadFile = async (file: File) => {
    setUploadMsg("上传中…");
    const reader = new FileReader();
    reader.onload = async () => {
      const res = await fetch("/api/jupyter/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, content: String(reader.result) }),
      }).then((r) => r.json()).catch(() => ({ ok: false, error: "上传失败" }));
      setUploadMsg(res.ok ? `✅ ${file.name} 已上传（代码里用 pd.read_csv("${file.name}") 读取）` : `❌ ${res.error || "失败"}`);
    };
    reader.readAsText(file);
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
          <input ref={fileRef} type="file" accept=".csv,.txt,.json" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ""; }} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={runningAll}
            className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
            title="上传 CSV/JSON 数据文件，pandas 可读">
            <Upload className="h-3 w-3" /> 上传数据
          </button>
          <button type="button" onClick={() => void loadDemo()} disabled={runningAll}
            className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
            title="载入资本下乡调研数据探索演示（自动运行）">
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

      {/* 上传提示 / 持久变量 */}
      <div className="rounded border bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">
        {uploadMsg || `内核变量: ${Object.keys(vars).length > 0 ? Object.keys(vars).slice(0, 8).join(", ") + (Object.keys(vars).length > 8 ? ` +${Object.keys(vars).length - 8}` : "") : "（无）"}`}
      </div>

      {/* 单元格列表 */}
      {cells.map((cell, i) => (
        <div key={i} className={`flex flex-col gap-1 rounded border ${cell.type === "md" ? "border-dashed bg-muted/5" : ""}`}>
          <div className="flex items-center gap-1 border-b bg-muted/20 px-1.5 py-0.5">
            <span className="text-[9px] font-mono text-muted-foreground">[{i}]</span>
            <span className={`rounded px-1 py-0.5 text-[8px] font-medium ${cell.type === "md" ? "bg-purple-500/15 text-purple-700" : "bg-emerald-500/15 text-emerald-700"}`}>
              {cell.type === "md" ? "MD" : "PY"}
            </span>
            {cell.type === "code" && (
              <button type="button" onClick={() => void runCell(i)} disabled={running !== null || runningAll}
                className="flex items-center gap-0.5 rounded bg-emerald-600/10 px-1.5 py-0.5 text-[9px] text-emerald-700 hover:bg-emerald-600/20 disabled:opacity-40">
                {running === i ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />} 运行
              </button>
            )}
            <button type="button" onClick={() => toggleCellType(i)}
              className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-accent"
              title={cell.type === "code" ? "切换为 Markdown 说明" : "切换为代码单元格"}>
              <Type className="h-2.5 w-2.5" />
            </button>
            <button type="button" onClick={() => addCell()}
              className="rounded px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-accent"><Plus className="h-2.5 w-2.5" /></button>
            {cells.length > 1 && (
              <button type="button" onClick={() => removeCell(i)}
                className="ml-auto rounded px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-red-50 hover:text-red-600"><Trash2 className="h-2.5 w-2.5" /></button>
            )}
          </div>
          {cell.type === "md" ? (
            <div className="px-3 py-2">{renderMd(cell.content)}</div>
          ) : (
            <>
              <textarea
                ref={(el) => { inputRefs.current[i] = el; }}
                value={cell.content}
                onChange={(e) => setCells((c) => c.map((v, j) => (j === i ? { ...v, content: e.target.value } : v)))}
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
            </>
          )}
        </div>
      ))}

      <div className="flex gap-1">
        <button type="button" onClick={() => addCell("code")}
          className="flex flex-1 items-center justify-center gap-1 rounded border border-dashed py-1.5 text-[10px] text-muted-foreground hover:bg-accent">
          <Plus className="h-3 w-3" /> 添加代码单元格
        </button>
        <button type="button" onClick={() => addCell("md")}
          className="flex flex-1 items-center justify-center gap-1 rounded border border-dashed py-1.5 text-[10px] text-purple-600 hover:bg-accent">
          <Type className="h-3 w-3" /> 添加说明（Markdown）
        </button>
      </div>
    </div>
  );
}
