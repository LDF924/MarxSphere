// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// JupyterPanel.tsx — 轻量 notebook 工作台（2026-08-27, ScienceX 通用计算环境）
// 单元格编辑(code/markdown) → venv 执行 → 输出/图表/持久变量；Restart & Run All；文件上传供 pandas 读
// 设计: 复用实证沙箱（无完整 Jupyter 依赖），variables 跨单元持久模拟内核
import React, { useEffect, useRef, useState } from "react";
import { Play, RotateCcw, Plus, Trash2, Loader2, FileCode2, Wand2, Upload, Type, CheckCircle2, X } from "lucide-react";

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

// 图表模板库（2026-08-27: 一键生成专业图表代码单元格）
const CHART_TEMPLATES: Array<{ id: string; label: string; code: string }> = [
  {
    id: "bar", label: "柱状图（分组对比）",
    code: `# 柱状图: 引入 vs 未引入资本的集体收入对比
import matplotlib.pyplot as plt
import numpy as np

# 用演示数据 df（若未定义则生成）
try: df
except NameError:
    import pandas as pd, numpy as np
    rng = np.random.default_rng(42)
    df = pd.DataFrame({"引入工商资本": rng.choice([0,1],50), "村集体收入_万元": rng.normal(80,25,50)})

means = df.groupby("引入工商资本")["村集体收入_万元"].mean()
plt.figure(figsize=(5, 3.5))
plt.bar(["未引入", "已引入"], means.values, color=["#94a3b8", "#ef4444"], alpha=0.85)
plt.ylabel("村集体收入 (万元)")
plt.title("工商资本引入 vs 村集体收入")
for i, v in enumerate(means.values): plt.text(i, v+1, f"{v:.1f}", ha="center")
plt.tight_layout(); plt.show()`,
  },
  {
    id: "hist", label: "直方图（收入分布）",
    code: `# 直方图: 村集体收入分布
import matplotlib.pyplot as plt
import numpy as np

try: df
except NameError:
    import pandas as pd, numpy as np
    rng = np.random.default_rng(42)
    df = pd.DataFrame({"村集体收入_万元": rng.normal(80,25,50)})

plt.figure(figsize=(5, 3.5))
plt.hist(df["村集体收入_万元"], bins=12, color="#3b82f6", edgecolor="white", alpha=0.8)
plt.axvline(df["村集体收入_万元"].mean(), color="#ef4444", linestyle="--", label=f'均值 {df["村集体收入_万元"].mean():.1f}')
plt.xlabel("村集体收入 (万元)"); plt.ylabel("村庄数")
plt.title("村集体收入分布"); plt.legend()
plt.tight_layout(); plt.show()`,
  },
  {
    id: "box", label: "箱线图（分组分布）",
    code: `# 箱线图: 按资本引入分组的收入分布
import matplotlib.pyplot as plt

try: df
except NameError:
    import pandas as pd, numpy as np
    rng = np.random.default_rng(42)
    df = pd.DataFrame({"引入工商资本": rng.choice([0,1],50), "村集体收入_万元": rng.normal(80,25,50)})

plt.figure(figsize=(5, 3.5))
plt.boxplot([df[df["引入工商资本"]==0]["村集体收入_万元"], df[df["引入工商资本"]==1]["村集体收入_万元"]],
            tick_labels=["未引入", "已引入"], patch_artist=True,
            boxprops=dict(facecolor="#93c5fd"))
plt.ylabel("村集体收入 (万元)")
plt.title("收入分布: 引入 vs 未引入资本")
plt.tight_layout(); plt.show()`,
  },
  {
    id: "scatter", label: "散点图（双变量关系）",
    code: `# 散点图: 耕地流转率 vs 集体收入（气泡=资本引入）
import matplotlib.pyplot as plt

try: df
except NameError:
    import pandas as pd, numpy as np
    rng = np.random.default_rng(42)
    df = pd.DataFrame({"耕地流转率_pct": rng.normal(35,12,50), "村集体收入_万元": rng.normal(80,25,50), "引入工商资本": rng.choice([0,1],50)})

plt.figure(figsize=(5, 3.5))
sc = plt.scatter(df["耕地流转率_pct"], df["村集体收入_万元"], c=df["引入工商资本"], cmap="coolwarm", s=50, alpha=0.7)
plt.colorbar(sc, label="引入工商资本")
plt.xlabel("耕地流转率 (%)"); plt.ylabel("村集体收入 (万元)")
plt.title("流转率与集体收入")
plt.tight_layout(); plt.show()`,
  },
  {
    id: "heatmap", label: "热力图（相关性）",
    code: `# 热力图: 变量相关性矩阵（只取数值列, 跳过字符串列如"村庄"）
import matplotlib.pyplot as plt
import numpy as np

try: df
except NameError:
    import pandas as pd, numpy as np
    rng = np.random.default_rng(42)
    df = pd.DataFrame({"引入工商资本": rng.choice([0,1],50), "村集体收入_万元": rng.normal(80,25,50), "耕地流转率_pct": rng.normal(35,12,50)})

num_df = df.select_dtypes(include=[np.number])   # 只保留数值列
corr = num_df.corr()
plt.figure(figsize=(5, 4))
im = plt.imshow(corr.values, cmap="RdBu_r", vmin=-1, vmax=1)
plt.xticks(range(len(corr)), corr.columns, rotation=30, ha="right", fontsize=9)
plt.yticks(range(len(corr)), corr.columns, fontsize=9)
plt.colorbar(im, label="相关系数")
for i in range(len(corr)):
    for j in range(len(corr)):
        plt.text(j, i, f"{corr.values[i,j]:.2f}", ha="center", va="center", fontsize=9,
                 color="white" if abs(corr.values[i,j]) > 0.5 else "black")
plt.title("变量相关性热力图")
plt.tight_layout(); plt.show()`,
  },
  {
    id: "line", label: "折线图（趋势）",
    code: `# 折线图: 2019-2026 集体收入趋势（模拟）
import matplotlib.pyplot as plt
import numpy as np

years = list(range(2019, 2027))
rng = np.random.default_rng(7)
base = 60
trend = [base + i*3 + rng.normal(0, 3) for i in range(len(years))]

plt.figure(figsize=(5, 3.5))
plt.plot(years, trend, marker="o", color="#10b981", linewidth=2)
plt.fill_between(years, trend, min(trend)-5, color="#10b981", alpha=0.1)
plt.xlabel("年份"); plt.ylabel("村集体收入 (万元)")
plt.title("村集体收入趋势 (2019-2026)")
plt.grid(alpha=0.3)
plt.tight_layout(); plt.show()`,
  },
  {
    id: "pie", label: "饼图（结构占比）",
    code: `# 饼图: 引入/未引入资本村庄占比
import matplotlib.pyplot as plt

try: df
except NameError:
    import pandas as pd, numpy as np
    rng = np.random.default_rng(42)
    df = pd.DataFrame({"引入工商资本": rng.choice([0,1],50)})

counts = df["引入工商资本"].value_counts()
plt.figure(figsize=(4.5, 4))
plt.pie(counts.values, labels=["未引入", "已引入"], autopct="%1.0f%%",
        colors=["#94a3b8", "#ef4444"], startangle=90, explode=(0, 0.05))
plt.title("村庄资本引入结构")
plt.tight_layout(); plt.show()`,
  },
  {
    id: "time", label: "面积图（累积效应）",
    code: `# 面积图: 引入资本 vs 未引入的累积收入差异
import matplotlib.pyplot as plt
import numpy as np

years = list(range(2019, 2027))
rng = np.random.default_rng(11)
with_cap = np.cumsum(rng.normal(8, 2, len(years))) + 50
without_cap = np.cumsum(rng.normal(3, 1.5, len(years))) + 50

plt.figure(figsize=(5, 3.5))
plt.fill_between(years, with_cap, color="#ef4444", alpha=0.6, label="引入资本")
plt.fill_between(years, without_cap, color="#94a3b8", alpha=0.6, label="未引入")
plt.xlabel("年份"); plt.ylabel("累计收入 (万元)")
plt.title("资本引入的累积效应")
plt.legend()
plt.tight_layout(); plt.show()`,
  },
  {
    id: "threeline", label: "三线表（学术规范 C 刊）",
    code: `# 三线表: 学术规范表格（顶线/栏目线/底线, C刊标准）
import matplotlib.pyplot as plt
import numpy as np

try: df
except NameError:
    import pandas as pd, numpy as np
    rng = np.random.default_rng(42)
    df = pd.DataFrame({"引入工商资本": rng.choice([0,1],50), "村集体收入_万元": rng.normal(80,25,50), "耕地流转率_pct": rng.normal(35,12,50)})

stats = df.groupby("引入工商资本").agg(
    样本数=("村集体收入_万元", "count"),
    集体收入均值=("村集体收入_万元", lambda x: f"{x.mean():.1f}±{x.std():.1f}"),
    流转率均值=("耕地流转率_pct", lambda x: f"{x.mean():.1f}±{x.std():.1f}"),
)
rows = [["未引入"] + [str(v) for v in stats.loc[0].tolist()],
        ["已引入"] + [str(v) for v in stats.loc[1].tolist()]]
headers = ["资本引入", "样本数", "集体收入(万元)", "流转率(%)"]

fig, ax = plt.subplots(figsize=(6.5, 1.6))
ax.axis("off")
table = ax.table(cellText=rows, colLabels=headers, loc="center", cellLoc="center")
table.auto_set_font_size(False)
table.set_fontsize(10)
table.scale(1.05, 1.6)
# 三线表核心: 只保留 顶线(粗)/栏目线(细)/底线(粗), 其余边框全去
n_rows = len(rows) + 1  # 含表头
for (r, c), cell in table.get_celld().items():
    cell.set_edgecolor("none")        # 默认全无线
    cell.set_facecolor("none")
# 关键: 必须先 draw() 强制布局, 否则 get_bbox() 返回默认值(所有 cell 相同 → 栏目线丢失)
fig.canvas.draw()
# get_bbox() 返回的就是 axes 坐标(0-1) — 直接用它画线
# 注意: cell(0,0) 只是第一列! x1 必须用最后一列的 bbox, 否则线只画到表格 1/4 处
bbox_top = table.get_celld()[(0, 0)].get_bbox()
bbox_col = table.get_celld()[(1, 0)].get_bbox()
bbox_bot = table.get_celld()[(n_rows - 1, 0)].get_bbox()
bbox_last = table.get_celld()[(0, len(headers) - 1)].get_bbox()
top = bbox_top.y1
col_line = bbox_col.y1
bottom = bbox_bot.y0
x0, x1 = bbox_top.x0, bbox_last.x1
for y, w in [(top, 3.0), (col_line, 1.5), (bottom, 3.0)]:
    ax.plot([x0, x1], [y, y], color="black", linewidth=w, clip_on=False, transform=ax.transAxes)
ax.set_xlim(0, 1); ax.set_ylim(0, 1)
plt.title("表1  资本引入与村集体经营状况（描述统计）", fontsize=10, pad=4)
plt.tight_layout(); plt.show()`,
  },
];

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
    <div className="flex min-h-0 flex-col gap-3">
      {/* ─── 头部: 渐变 + 内核状态 ─── */}
      <div className="relative overflow-hidden rounded-xl border bg-gradient-to-r from-emerald-500/10 via-teal-500/5 to-transparent p-4">
        <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-emerald-500/10 blur-2xl" />
        <div className="relative flex flex-wrap items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20">
            <FileCode2 className="h-5 w-5 text-white" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">Notebook 工作台</h2>
            <p className="text-[10px] text-muted-foreground">Python 单元执行 · 变量持久 · 图表输出 · 三线表</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {/* 内核状态徽章 */}
            <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-medium ${ready?.ready ? "bg-emerald-500/15 text-emerald-600" : "bg-red-500/10 text-red-500"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${ready?.ready ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
              {ready?.ready ? "内核就绪" : "venv 未配置"}
            </span>
            <span className="rounded-full bg-muted/50 px-2 py-0.5 text-[9px] text-muted-foreground">
              {Object.keys(vars).length} 变量
            </span>
            {runningAll && (
              <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-medium text-amber-600">
                <Loader2 className="h-2.5 w-2.5 animate-spin" /> 运行中…
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ─── 工具栏: 卡片化按钮 ─── */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border bg-card/60 p-2 backdrop-blur-sm">
        <select
          value=""
          onChange={(e) => {
            const t = CHART_TEMPLATES.find((x) => x.id === e.target.value);
            if (t) { setCells((c) => [...c, { type: "code", content: t.code }]); setResults((r) => [...r, null]); }
            e.target.value = "";
          }}
          className="rounded-lg border bg-background px-2 py-1.5 text-[10px] text-muted-foreground"
          title="插入图表模板代码单元格（运行后出图）"
        >
          <option value="">📊 图表模板…</option>
          {CHART_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <div className="h-4 w-px bg-border/60" />
        <input ref={fileRef} type="file" accept=".csv,.txt,.json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ""; }} />
        <button type="button" onClick={() => fileRef.current?.click()} disabled={runningAll}
          className="flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
          title="上传 CSV/JSON 数据文件，pandas 可读">
          <Upload className="h-3 w-3" /> 上传数据
        </button>
        <button type="button" onClick={() => void loadDemo()} disabled={runningAll}
          className="flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[10px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 disabled:opacity-40"
          title="载入资本下乡调研数据探索演示（自动运行）">
          <Wand2 className="h-3 w-3" /> 载入演示
        </button>
        <button type="button" onClick={() => void restart()} disabled={runningAll}
          className="flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40">
          <RotateCcw className="h-3 w-3" /> Restart
        </button>
        <button type="button" onClick={() => void runAllCells()} disabled={runningAll}
          className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[10px] font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-40">
          {runningAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run All
        </button>
      </div>

      {/* 上传提示 / 持久变量 */}
      {uploadMsg && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{uploadMsg}</span>
          <button type="button" onClick={() => setUploadMsg("")} className="rounded p-0.5 hover:bg-white/10"><X className="h-3 w-3" /></button>
        </div>
      )}

      {/* 内核变量条 */}
      <div className="flex items-center gap-1.5 rounded-lg border bg-muted/20 px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className="font-medium text-foreground/70">内核变量</span>
        {Object.keys(vars).length > 0
          ? Object.keys(vars).map((k) => (
              <span key={k} className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[9px] text-emerald-700">{k}</span>
            ))
          : <span>（无 — 运行代码后变量在此显示，可跨单元格复用）</span>}
        {Object.keys(vars).length > 8 && <span className="text-[9px]">+{Object.keys(vars).length - 8}</span>}
      </div>

      {/* 单元格列表 */}
      {cells.map((cell, i) => (
        <div key={i} className={`group overflow-hidden rounded-xl border transition-all ${cell.type === "md" ? "border-dashed border-purple-500/20 bg-purple-500/5" : "border-border/60 bg-card/60 backdrop-blur-sm hover:border-emerald-500/30"}`}>
          {/* 单元格头部 */}
          <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/20 px-2 py-1">
            <span className="w-5 text-right font-mono text-[9px] text-muted-foreground/50">[{i}]</span>
            <span className={`rounded px-1.5 py-0.5 text-[8px] font-bold ${cell.type === "md" ? "bg-purple-500/15 text-purple-600" : "bg-emerald-500/15 text-emerald-600"}`}>
              {cell.type === "md" ? "MD" : "PY"}
            </span>
            {cell.type === "code" && (
              <button type="button" onClick={() => void runCell(i)} disabled={running !== null || runningAll}
                className="flex items-center gap-0.5 rounded-md bg-emerald-600/10 px-2 py-0.5 text-[9px] font-medium text-emerald-700 transition-colors hover:bg-emerald-600/20 disabled:opacity-40">
                {running === i ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />}
                {running === i ? "运行中" : "运行"}
              </button>
            )}
            {results[i] && results[i]!.ok && cell.type === "code" && !runningAll && (
              <span className="flex items-center gap-0.5 text-[8px] text-emerald-500"><CheckCircle2 className="h-2.5 w-2.5" />完成</span>
            )}
            <button type="button" onClick={() => toggleCellType(i)}
              className="rounded-md px-1.5 py-0.5 text-[9px] text-muted-foreground transition-colors hover:bg-accent"
              title={cell.type === "code" ? "切换为 Markdown 说明" : "切换为代码单元格"}>
              <Type className="h-2.5 w-2.5" />
            </button>
            <button type="button" onClick={() => addCell()}
              className="rounded-md px-1.5 py-0.5 text-[9px] text-muted-foreground transition-colors hover:bg-accent"><Plus className="h-2.5 w-2.5" /></button>
            {cells.length > 1 && (
              <button type="button" onClick={() => removeCell(i)}
                className="ml-auto rounded-md px-1.5 py-0.5 text-[9px] text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600"><Trash2 className="h-2.5 w-2.5" /></button>
            )}
          </div>
          {cell.type === "md" ? (
            <div className="px-4 py-3">{renderMd(cell.content)}</div>
          ) : (
            <>
              <textarea
                ref={(el) => { inputRefs.current[i] = el; }}
                value={cell.content}
                onChange={(e) => setCells((c) => c.map((v, j) => (j === i ? { ...v, content: e.target.value } : v)))}
                spellCheck={false}
                placeholder="# 输入 Python 代码，如: df = pd.DataFrame({'a':[1,2,3]})"
                className="min-h-[60px] w-full resize-y bg-background/60 p-3 font-mono text-[11px] leading-relaxed outline-none placeholder:text-muted-foreground/40"
              />
              {results[i] && (
                <div className="border-t border-border/50 bg-muted/5 px-3 py-2">
                  {!results[i]!.ok && results[i]!.error && (
                    <pre className="whitespace-pre-wrap rounded-lg border border-red-500/20 bg-red-500/5 p-2 font-mono text-[10px] leading-relaxed text-red-600">{results[i]!.error}</pre>
                  )}
                  {results[i]!.output && (
                    <pre className="whitespace-pre-wrap rounded-lg bg-background/80 p-2 font-mono text-[10px] leading-relaxed text-foreground/80">{results[i]!.output}</pre>
                  )}
                  {results[i]!.figures.map((f, fi) => (
                    <div key={fi} className="relative mt-1.5 inline-block">
                      <img src={`data:image/png;base64,${f}`} alt={`figure-${i}-${fi}`} className="max-h-72 rounded-lg border shadow-sm" />
                      <button
                        type="button"
                        onClick={() => {
                          const a = document.createElement("a");
                          a.href = `data:image/png;base64,${f}`;
                          a.download = `figure-${i}-${fi}.png`;
                          a.click();
                        }}
                        className="absolute right-1.5 top-1.5 rounded-md bg-black/60 px-2 py-1 text-[9px] text-white backdrop-blur transition-colors hover:bg-black/80"
                        title="下载图表"
                      >
                        下载
                      </button>
                    </div>
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

      {/* 添加单元格 */}
      <div className="flex gap-2">
        <button type="button" onClick={() => addCell("code")}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 py-2.5 text-[11px] text-muted-foreground transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/5 hover:text-emerald-700">
          <Plus className="h-3.5 w-3.5" /> 添加代码单元格
        </button>
        <button type="button" onClick={() => addCell("md")}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 py-2.5 text-[11px] text-purple-600 transition-colors hover:border-purple-500/40 hover:bg-purple-500/5">
          <Type className="h-3.5 w-3.5" /> 添加说明（Markdown）
        </button>
      </div>
    </div>
  );
}
