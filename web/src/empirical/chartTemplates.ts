// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// 图表模板库(移植自 JupyterPanel, 2026-08-27: 一键生成专业图表代码单元格)
export const CHART_TEMPLATES: Array<{ id: string; label: string; code: string }> = [
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
export type ChartTemplate = { id: string; label: string; code: string };
