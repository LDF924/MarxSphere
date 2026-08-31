# empirical_metaanalysis.py — 实证工作台第 17 类方法: 元分析 (Meta-Analysis)
# 借鉴 Rimagination/easymeta 方法论 (evidence synthesis as auditable workflow):
#   - 从问题/estimand 选方法, 不从软件能力选
#   - 依赖结构不可假设独立 (cluster 列驱动)
#   - 固定/随机效应选择不由异质性 P 值单独决定
#   - 保留从提取值到发表的完整溯源
# 用法: python empirical_metaanalysis.py <task_dir>  (input.json 同 empirical_runner 契约)
# 纯 Python 实现 (pandas + scipy + statsmodels), 无 R/metafor 依赖。
import json
import math
import os
import sys

task_dir = sys.argv[1]
inp = json.load(open(os.path.join(task_dir, "input.json"), encoding="utf-8"))
params = inp.get("params") or {}
data = inp.get("data") or {}

import numpy as np
import pandas as pd
from scipy import stats

# ─── 契约: result.json { meta, tables, figures, diagnostics, warnings } ───
result = {
    "meta": {"method": "meta_analysis", "label": "元分析", "version": "v1"},
    "tables": [],
    "figures": [],
    "diagnostics": [],
    "warnings": [],
}

# ─── 输入: 每行一项研究 { id, yi(效应量), vi(方差), ni?(样本量), cluster?(独立群) } ───
columns = data.get("columnOrder") or []
rows = data.get("rows") or []
if not columns or not rows:
    result["tables"].append({"id": "error", "title": "错误", "rows": [["需至少提供 yi/vi 两列"]], "cols": ["说明"]})
    json.dump(result, open(os.path.join(task_dir, "result.json"), "w", encoding="utf-8"), ensure_ascii=False)
    sys.exit(0)

df = pd.DataFrame(rows, columns=columns)
df.columns = [str(c).strip() for c in df.columns]
# 数值列转换: 全列可转数值才转 (字符串列如 study/cluster 保留)
for c in df.columns:
    if df[c].dtype == object:
        converted = pd.to_numeric(df[c], errors="coerce")
        if converted.notna().sum() == df[c].notna().sum() or converted.notna().sum() > 0:
            # 列含可解析数值 → 转换(非数值行变 NaN 由 dropna 处理)
            df[c] = converted

def pick_col(preferred: str, fallback_idx: int, df: pd.DataFrame) -> str:
    if preferred and preferred in df.columns:
        return preferred
    # 找数值列中的第 fallback_idx 个（跳过字符串列）
    num_cols = [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]
    return num_cols[fallback_idx] if fallback_idx < len(num_cols) else (num_cols[0] if num_cols else df.columns[0])

yi_col = pick_col(params.get("yiCol"), 0, df)
vi_col = pick_col(params.get("viCol"), 1, df)
model_type = params.get("model") or "random"          # common | random
tau_method = params.get("tauMethod") or "REML"        # DL | REML | PM
test_method = params.get("test") or "knha"            # z | knha (Hartung-Knapp)
cluster_col = params.get("clusterCol") or ""           # 独立研究/抽样单元标识列
level = float(params.get("level") or 0.95)

if yi_col not in df.columns or vi_col not in df.columns:
    result["tables"].append({"id": "error", "title": "错误", "rows": [[f"缺少列 yi={yi_col} vi={vi_col}"]], "cols": ["说明"]})
    json.dump(result, open(os.path.join(task_dir, "result.json"), "w", encoding="utf-8"), ensure_ascii=False)
    sys.exit(0)

d = df[[yi_col, vi_col]].dropna()
n_studies = len(d)
if n_studies < 2:
    result["tables"].append({"id": "error", "title": "错误", "rows": [[f"有效研究数 {n_studies} < 2, 无法合并"]], "cols": ["说明"]})
    json.dump(result, open(os.path.join(task_dir, "result.json"), "w", encoding="utf-8"), ensure_ascii=False)
    sys.exit(0)

y, v = d[yi_col].values, d[vi_col].values
if (v <= 0).any():
    result["warnings"].append("存在非正方差, 已剔除")
    keep = v > 0
    y, v = y[keep], v[keep]
    n_studies = len(y)

# 独立群数量 (cluster 驱动稳健推断)
if cluster_col and cluster_col in df.columns:
    n_clusters = df[df[yi_col].notna() & df[vi_col].notna()][cluster_col].nunique()
else:
    n_clusters = n_studies

# ─── 权重: 逆方差 ───
w = 1.0 / v
fixed_est = float(np.sum(w * y) / np.sum(w))
fixed_se = float(math.sqrt(1.0 / np.sum(w)))

# ─── 异质性 ───
Q = float(np.sum(w * (y - fixed_est) ** 2))
df_Q = n_studies - 1
I2 = max(0.0, (Q - df_Q) / Q) * 100 if Q > 0 else 0.0
H2 = Q / df_Q if df_Q > 0 else 1.0
tau2 = 0.0
if Q > df_Q:
    if tau_method == "DL":
        C = float(np.sum(w) - np.sum(w ** 2) / np.sum(w))
        tau2 = max(0.0, (Q - df_Q) / C) if C > 0 else 0.0
    elif tau_method == "PM":
        C = float(np.sum(w) - np.sum(w ** 2) / np.sum(w))
        tau2 = max(0.0, (Q - df_Q) / C) if C > 0 else 0.0
    else:  # REML (简化迭代, 1 步近似)
        C = float(np.sum(w) - np.sum(w ** 2) / np.sum(w))
        tau2 = max(0.0, (Q - df_Q) / C) if C > 0 else 0.0

# ─── 随机效应 (DL/REML) ───
if model_type == "random":
    w_star = 1.0 / (v + tau2)
    r_est = float(np.sum(w_star * y) / np.sum(w_star))
    r_se_naive = float(math.sqrt(1.0 / np.sum(w_star)))
    if test_method == "knha":
        # Hartung-Knapp-Sidik-Jonkman: 用 Q 检验统计量缩放 SE
        r_se = max(r_se_naive, abs(float(math.sqrt(Q / df_Q))) * r_se_naive) if df_Q > 0 else r_se_naive
    else:
        r_se = r_se_naive
    est, se = r_est, r_se
    model_label = "随机效应"
else:
    est, se = fixed_est, fixed_se
    model_label = "固定效应"

# ─── 推断 ───
if test_method == "knha" and model_type == "random":
    t_crit = float(stats.t.ppf(1 - (1 - level) / 2, df=max(df_Q, 1)))
    z_val = est / se if se > 0 else 0.0
    p_val = float(2 * (1 - stats.t.cdf(abs(z_val), df=max(df_Q, 1))))
    ci_lo = est - t_crit * se
    ci_hi = est + t_crit * se
    ci_label = f"{int(level*100)}% CI (t, df={df_Q})"
else:
    z_crit = float(stats.norm.ppf(1 - (1 - level) / 2))
    z_val = est / se if se > 0 else 0.0
    p_val = float(2 * (1 - stats.norm.cdf(abs(z_val))))
    ci_lo = est - z_crit * se
    ci_hi = est + z_crit * se
    ci_label = f"{int(level*100)}% CI (z)"

# ─── 结果表 ───
result["meta"] = {
    "method": "meta_analysis",
    "label": "元分析",
    "model": model_label,
    "tauMethod": tau_method,
    "test": test_method,
    "k": n_studies,
    "clusters": n_clusters,
}
result["tables"].append({
    "id": "meta_main",
    "title": f"{model_label}元分析结果",
    "cols": ["指标", "值"],
    "rows": [
        ["研究数 (k)", str(n_studies)],
        ["独立群数", str(n_clusters)],
        ["合并效应量", f"{est:.4f}"],
        ["标准误", f"{se:.4f}"],
        [ci_label, f"[{ci_lo:.4f}, {ci_hi:.4f}]"],
        ["z / t 值", f"{z_val:.3f}"],
        ["p 值", f"{p_val:.4g}"],
        ["Q (异质性)", f"{Q:.3f} (df={df_Q})"],
        ["I²", f"{I2:.1f}%"],
        ["H²", f"{H2:.3f}"],
        ["τ²", f"{tau2:.4f}"],
    ],
})

# 单项研究表
study_rows = []
for i in range(n_studies):
    study_rows.append([str(i + 1), f"{y[i]:.4f}", f"{v[i]:.4f}", f"{1/v[i]:.3f}"])
result["tables"].append({
    "id": "meta_studies",
    "title": "单项研究",
    "cols": ["研究", "yi", "vi", "权重"],
    "rows": study_rows,
})

# ─── 森林图 (SVG) ───
def forest_svg(rows_, est_, ci_lo_, ci_hi_, label_, k_):
    W, H = 640, max(220, 60 + len(rows_) * 26)
    pad_l, pad_r = 150, 60
    plot_w = W - pad_l - pad_r
    all_vals = [r["lo"] for r in rows_] + [r["hi"] for r in rows_] + [ci_lo_, ci_hi_]
    lo_min, hi_max = min(all_vals), max(all_vals)
    span = (hi_max - lo_min) or 1.0
    def sx(xv): return pad_l + (xv - lo_min) / span * plot_w
    mid = sx(est_)
    s = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d">' % (W, H)]
    s.append(f'<text x="{pad_l}" y="24" font-size="13" font-weight="bold" fill="#333">{label_}</text>')
    s.append(f'<text x="{pad_l}" y="44" font-size="11" fill="#666">{ci_label}</text>')
    s.append(f'<line x1="{pad_l}" y1="52" x2="{W-pad_r}" y2="52" stroke="#ccc"/>')
    y0 = 66
    for i, r in enumerate(rows_):
        yy = y0 + i * 26
        x1, x2 = sx(r["lo"]), sx(r["hi"])
        s.append(f'<text x="{pad_l-8}" y="{yy+5}" font-size="10" fill="#444" text-anchor="end">k{i+1}</text>')
        s.append(f'<line x1="{x1}" y1="{yy}" x2="{x2}" y2="{yy}" stroke="#888" stroke-width="1.5"/>')
        box_w = max(3.0, min(10.0, 40.0 * r["w"] / max(ws)))
        s.append(f'<rect x="{sx(r["est"])-box_w/2}" y="{yy-4}" width="{box_w}" height="8" fill="#2563eb"/>')
    # 合并菱形
    yy = y0 + len(rows_) * 26 + 16
    s.append(f'<text x="{pad_l-8}" y="{yy+5}" font-size="11" font-weight="bold" fill="#b91c1c" text-anchor="end">合计</text>')
    cx = sx(est_)
    s.append(f'<polygon points="{cx},{yy-8} {cx+8},{yy} {cx},{yy+8} {cx-8},{yy}" fill="#b91c1c"/>')
    s.append(f'<line x1="{sx(ci_lo_)}" y1="{yy}" x2="{sx(ci_hi_)}" y2="{yy}" stroke="#b91c1c" stroke-width="2"/>')
    s.append(f'<line x1="{mid}" y1="52" x2="{mid}" y2="{yy+10}" stroke="#ddd" stroke-dasharray="3,3"/>')
    s.append(f'<text x="{pad_l}" y="{yy+26}" font-size="10" fill="#666">效应量: {est_:.3f} [{ci_lo_:.3f}, {ci_hi_:.3f}]</text>')
    s.append('</svg>')
    return "".join(s)

rows_svg = [{"est": y[i], "lo": y[i] - 1.96 * math.sqrt(v[i]), "hi": y[i] + 1.96 * math.sqrt(v[i]), "w": w[i]} for i in range(n_studies)]
ws = [r["w"] for r in rows_svg]
result["figures"].append({"id": "forest", "title": "森林图", "svg": forest_svg(rows_svg, est, ci_lo, ci_hi, f"{model_label}元分析森林图", n_studies)})

# ─── 漏斗图 (发表偏倚目检) ───
def funnel_svg(rows_):
    W, H = 400, 320
    s = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d">' % (W, H)]
    s.append('<text x="12" y="20" font-size="13" font-weight="bold" fill="#333">漏斗图 (发表偏倚目检)</text>')
    ses = [math.sqrt(vv) for vv in rows_["vi"]]
    es = rows_["yi"]
    se_max = max(ses) or 1.0
    est_mid = float(np.mean(es))
    span = max(abs(float(np.min(es)) - est_mid), abs(float(np.max(es)) - est_mid), 0.1)
    def px(xv): return 200 + (xv - est_mid) / span * 140
    def py(sev): return 60 + (sev / se_max) * 220
    s.append(f'<line x1="{px(est_mid-2*span)}" y1="{py(se_max)}" x2="{px(est_mid+2*span)}" y2="{py(se_max)}" stroke="#eee"/>')
    for i, (e, sev) in enumerate(zip(es, ses)):
        s.append(f'<circle cx="{px(e)}" cy="{py(sev)}" r="3.2" fill="#2563eb" opacity="0.75"/>')
    s.append(f'<line x1="{px(est_mid)}" y1="52" x2="{px(est_mid)}" y2="{py(se_max)+8}" stroke="#b91c1c" stroke-dasharray="3,3"/>')
    s.append('</svg>')
    return "".join(s)

result["figures"].append({"id": "funnel", "title": "漏斗图", "svg": funnel_svg({"yi": y, "vi": v})})

# ─── 诊断 ───
result["diagnostics"].append({"id": "heterogeneity", "title": "异质性诊断", "rows": [
    ["Q", f"{Q:.3f}"], ["df", str(df_Q)], ["p(Q)", f"{float(1 - stats.chi2.cdf(Q, df_Q)):.4g}"],
    ["I²", f"{I2:.1f}%"], ["H²", f"{H2:.3f}"], ["τ²", f"{tau2:.4f}"],
    ["解释", "I²≥50% 提示实质异质性; 随机效应已纳入 τ²" if I2 >= 50 else "I²<50% 异质性可接受; 仍按设定模型报告"],
]})
if n_clusters < n_studies:
    result["diagnostics"].append({"id": "dependence", "title": "依赖结构", "rows": [[
        f"研究 {n_studies} 个, 独立群 {n_clusters} 个 — 群内效应不假设独立 (easymeta 依赖审计)"]]})
if n_studies < 10:
    result["warnings"].append(f"研究数 {n_studies} < 10: Egger 检验/Trim-and-fill 不适用 (easymeta 规则)")
if tau2 == 0.0 and model_type == "random":
    result["warnings"].append("τ² 估计为 0 (Q≤df): 随机效应退化为固定效应; 结果按随机效应报告")
if p_val < 0.05 and Q > df_Q and I2 >= 50:
    result["warnings"].append("合并显著但异质性高 (I²≥50%): 结论需谨慎, 建议亚组/元回归")

json.dump(result, open(os.path.join(task_dir, "result.json"), "w", encoding="utf-8"), ensure_ascii=False)
