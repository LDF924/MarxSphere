// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// demoCells.ts — 演示 notebook(抽取自 JupyterPanel, 统一分析台代码页签「载入演示」用)
export const DEMO_CELLS: Array<{ type: "code" | "md"; content: string }> = [
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
export type DemoCell = { type: "code" | "md"; content: string };
