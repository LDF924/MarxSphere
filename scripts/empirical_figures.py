# -*- coding: utf-8 -*-
"""empirical_figures.py — 论文级结果图生成器（V413+）
把 MarxSphere 实证结果(empirical/run + reliability 的 result JSON)渲染成论文级 PNG/PDF。
支持图表:
  - alpha_bar      信效度 α 对比柱状(反转前 vs 反转后)
  - boxplot        变量箱线图(如四维得分)
  - heatmap        交叉表热力图(频数+百分比)
  - forest         回归系数森林图(自动剔阈值/截距, 星号标注显著性)
  - method_compare 插补/方法对比双柱(准确率/RMSE)
输入: { results: { key: <任务结果JSON> }| 或 { tables: [...], figures? } 直接喂一或多个任务结果,
       spec: { kind: "alpha_bar", sourceA: {name, tables:[...]}, sourceB: {...}, title?, path? } }
输出: 每图写 {chartId}.png + .pdf 到 outDir (默认 data/agent_workspace/figures/)
result.json: { ok: true, meta: { charts: [ {id, title, file, sizeKB} ] } }
"""
import json, sys, os
from pathlib import Path

task_dir = Path(sys.argv[1])
inp = json.load(open(task_dir / "input.json", encoding="utf-8"))
out_dir = Path(inp.get("outDir") or task_dir)
out_dir.mkdir(parents=True, exist_ok=True)

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# 中文字体(Windows)
for fname in ["Microsoft YaHei", "SimHei", "SimSun"]:
    try:
        plt.rcParams["font.sans-serif"] = [fname]
        break
    except Exception:
        continue
plt.rcParams["axes.unicode_minus"] = False
plt.rcParams["font.size"] = 11

BLUE = "#2563eb"; RED = "#dc2626"; GRAY = "#64748b"; GREEN = "#059669"; AMBER = "#d97706"
charts = []

def savefig(fig, chart_id, title):
    for ext in ("png", "pdf"):
        fp = out_dir / f"{chart_id}.{ext}"
        fig.savefig(fp, bbox_inches="tight", dpi=200)
    plt.close(fig)
    png = out_dir / f"{chart_id}.png"
    charts.append({"id": chart_id, "title": title, "file": f"{chart_id}.png",
                   "sizeKB": round(png.stat().st_size / 1024, 1)})
    return chart_id

def tbl_rows(src, idx=0):
    """src: 任务结果 dict(有 tables) → 返回第 idx 张表的 rows"""
    tables = src.get("tables") or []
    if idx >= len(tables):
        return []
    return tables[idx].get("rows", [])

def clean_num(v):
    try:
        return float(str(v).replace("%", "").strip())
    except Exception:
        return None

# ── ① α 对比柱状(两份结果: 反转前 vs 反转后) ──
def chart_alpha_bar(spec):
    a = spec.get("sourceA") or {}
    b = spec.get("sourceB") or {}
    single = bool(spec.get("single")) or not b
    if single:
        # 单组模式: 只画 A 的 α 柱(标注 0.7 可接受线)
        rows = tbl_rows(a, 0) if "tables" in a else []
        labels = [str(r[0]) for r in rows]
        vals = [clean_num(r[1]) for r in rows]
        fig, ax = plt.subplots(figsize=(8, 4.4))
        x = np.arange(len(vals))
        bars = ax.bar(x, vals, 0.55, color=BLUE, alpha=0.85)
        ax.axhline(0.7, color=GRAY, ls="--", lw=1)
        ax.axhline(0, color="black", lw=0.8)
        for b1, v in zip(bars, vals):
            if v is None: continue
            ax.text(b1.get_x() + b1.get_width()/2, v + (0.02 if v >= 0 else -0.08),
                    f"{v:.2f}", ha="center", va="bottom" if v >= 0 else "top", fontsize=9)
        ax.set_xticks(x)
        ax.set_xticklabels([str(l)[:12] for l in labels], fontsize=9)
        ax.set_ylabel(spec.get("ylabel", "Cronbach α"))
        ax.set_ylim(min(vals + [0]) - 0.25 if vals else -0.5, max(vals + [0.7]) + 0.25)
        ax.set_title(spec.get("title", "信效度 α"), pad=12)
        ax.spines[["top", "right"]].set_visible(False)
        return savefig(fig, spec.get("id", "alpha_bar"), spec.get("title", "信效度 α"))
    ra = clean_num(a.get("alpha")); rb = clean_num(b.get("alpha"))
    # 兼容传任务结果: sourceA.tables[0] 为 α 表
    if "tables" in a and a["tables"]:
        rows = tbl_rows(a, 0)
        alphas_a = [clean_num(r[1]) for r in rows]
    else:
        alphas_a = [ra] if ra is not None else []
    if "tables" in b and b["tables"]:
        rows = tbl_rows(b, 0)
        alphas_b = [clean_num(r[1]) for r in rows]
    else:
        alphas_b = [rb] if rb is not None else []
    labels = [str(r[0]) for r in (tbl_rows(a, 0) or tbl_rows(b, 0) or [])]
    if len(alphas_a) != len(alphas_b):
        alphas_a = alphas_a[:len(alphas_b)] if len(alphas_a) > len(alphas_b) else alphas_a
        alphas_b = alphas_b[:len(alphas_a)]
        labels = labels[:len(alphas_a)]
    fig, ax = plt.subplots(figsize=(8, 4.6))
    x = np.arange(len(alphas_a)); w = 0.36
    lab_a = spec.get("labelA", "组 A"); lab_b = spec.get("labelB", "组 B")
    ba = ax.bar(x - w/2, alphas_a, w, label=lab_a, color=RED if spec.get("colorA") else BLUE, alpha=0.85)
    bb = ax.bar(x + w/2, alphas_b, w, label=lab_b, color=BLUE if spec.get("colorA") else GREEN, alpha=0.9)
    ax.axhline(0.7, color=GRAY, ls="--", lw=1)
    for bars in (ba, bb):
        for b1 in bars:
            h = b1.get_height()
            ax.text(b1.get_x()+b1.get_width()/2, h + (0.02 if h >= 0 else -0.06), f"{h:.2f}",
                    ha="center", va="bottom" if h >= 0 else "top", fontsize=9)
    ax.set_xticks(x)
    ax.set_xticklabels([str(l)[:10] for l in labels], fontsize=9)
    ax.set_ylabel(spec.get("ylabel", "值"))
    ax.set_title(spec.get("title", "组间对比"), pad=12)
    ax.legend(frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    return savefig(fig, spec.get("id", "alpha_bar"), spec.get("title", "α 对比"))

# ── ② 箱线图 ──
def chart_boxplot(spec):
    groups = spec.get("groups") or []
    fig, ax = plt.subplots(figsize=(8, 4.8))
    data = []
    labels = []
    colors = [BLUE, GREEN, AMBER, "#7c3aed"]
    for i, g in enumerate(groups):
        vals = [clean_num(v) for v in g.get("values", [])]
        vals = [v for v in vals if v is not None]
        data.append(vals); labels.append(g.get("label", f"组{i+1}"))
    bp = ax.boxplot(data, tick_labels=labels, patch_artist=True, widths=0.5,
                    medianprops=dict(color="white", lw=1.5),
                    flierprops=dict(marker="o", markersize=3, alpha=0.4))
    for i, patch in enumerate(bp["boxes"]):
        patch.set_facecolor(colors[i % len(colors)]); patch.set_alpha(0.75)
    for i, vals in enumerate(data, 1):
        if vals:
            ax.text(i, max(vals) * 1.06, f"均值 {np.mean(vals):.2f}", ha="center", fontsize=9, color=GRAY)
    ax.set_ylabel(spec.get("ylabel", "值"))
    ax.set_title(spec.get("title", "箱线图"), pad=12)
    ax.spines[["top", "right"]].set_visible(False)
    return savefig(fig, spec.get("id", "boxplot"), spec.get("title", "箱线图"))

# ── ③ 热力图(交叉表) ──
def chart_heatmap(spec):
    tables = spec.get("tables") or []
    if not tables:
        return None
    t = tables[0]
    rows = t.get("rows", [])
    # 行标签=第一列, 其余数值
    mat = []
    row_labels = []
    for r in rows:
        row_labels.append(str(r[0]))
        mat.append([clean_num(v) or 0 for v in r[1:]])
    mat = np.array(mat, dtype=float)
    col_labels = t.get("cols", [])[1:]
    fig, ax = plt.subplots(figsize=(8, max(3.2, 0.6 * len(rows))))
    im = ax.imshow(mat, cmap="YlOrRd", aspect="auto")
    ax.set_xticks(range(len(col_labels)))
    ax.set_xticklabels([str(c)[:8] for c in col_labels], fontsize=9, rotation=20, ha="right")
    ax.set_yticks(range(len(row_labels)))
    ax.set_yticklabels(row_labels, fontsize=9)
    for i in range(mat.shape[0]):
        for j in range(mat.shape[1]):
            v = mat[i, j]
            row_sum = mat[i].sum() or 1
            ax.text(j, i, f"{int(v)}\n({v/row_sum*100:.0f}%)", ha="center", va="center",
                    fontsize=8, color="white" if v > mat.max()/2 else "black")
    ax.set_title(spec.get("title", "交叉表热力图"), pad=12)
    fig.colorbar(im, ax=ax, shrink=0.85, label=spec.get("colorLabel", "频数"))
    return savefig(fig, spec.get("id", "heatmap"), spec.get("title", "交叉表热力图"))

# ── ④ 森林图(回归系数) ──
def chart_forest(spec):
    tables = spec.get("tables") or []
    if not tables:
        return None
    rows = tables[0].get("rows", [])
    items = []
    import re
    for r in rows:
        var = str(r[0])
        # 剔阈值(1/2, 2/3)/截距/cut
        if re.fullmatch(r"\d+/\d+", var) or var in ("Intercept", "const") or var.startswith("cut"):
            continue
        if len(r) < 5:
            continue
        try:
            coef = clean_num(r[1])
            ci_txt = str(r[4])
            lo = clean_num(ci_txt.strip("[]").split(",")[0])
            hi = clean_num(ci_txt.strip("[]").split(",")[1])
            p = clean_num(r[3]) if len(r) > 3 else None
        except Exception:
            continue
        if coef is None:
            continue
        items.append((var, coef, lo, hi, p))
    if not items:
        return None
    fig, ax = plt.subplots(figsize=(8, max(3.2, 0.9 * len(items))))
    y = np.arange(len(items))[::-1]
    var_labels = spec.get("labels") or {}
    for yi, (var, coef, lo, hi, p) in zip(y, items):
        sig = (p is not None and p < 0.05)
        col = BLUE if sig else GRAY
        ax.plot([lo, hi], [yi, yi], lw=1.8, color=col, alpha=0.9)
        ax.scatter(coef, yi, marker="D", s=45, color=col, zorder=5)
        star = "***" if (p is not None and p < 0.01) else ("**" if (p is not None and p < 0.05) else ("*" if (p is not None and p < 0.1) else ""))
        ax.text(hi + abs(hi)*0.08 + 0.03, yi, f"{coef:.2f}{star}", va="center", fontsize=9, color=col)
    ax.axvline(0, color="black", lw=0.9)
    ax.set_yticks(y)
    ax.set_yticklabels([var_labels.get(v, v) for v, *_ in items], fontsize=10)
    maxabs = max(abs(lo) if lo is not None else 1 for _, _, lo, hi, _ in items)
    ax.set_xlim(-maxabs*1.35, maxabs*1.35)
    ax.set_xlabel(spec.get("xlabel", "系数 (95% CI)"))
    ax.set_title(spec.get("title", "回归系数森林图"), pad=12)
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(axis="x", alpha=0.25, lw=0.6)
    return savefig(fig, spec.get("id", "forest"), spec.get("title", "回归系数森林图"))

# ── ⑤ 方法对比(双柱: 准确率/RMSE) ──
def chart_compare(spec):
    methods = spec.get("methods") or []
    vals = spec.get("values") or []
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(9.5, 3.8))
    colors = [BLUE, GRAY, "#94a3b8", AMBER]
    # 左: 百分比
    pct = [v for v in vals if spec.get("pct", True)]
    if pct:
        bars = ax1.bar(methods, pct, color=colors[:len(methods)], width=0.5)
        for b, v in zip(bars, pct):
            ax1.text(b.get_x()+b.get_width()/2, v+0.5, f"{v:.1f}", ha="center", fontsize=10)
        ax1.set_ylabel(spec.get("ylabel", "%"))
        ax1.set_title(spec.get("titleLeft", "准确率"), fontsize=11)
    rmse = spec.get("rmse") or []
    if rmse:
        bars2 = ax2.bar(methods, rmse, color=colors[:len(methods)], width=0.5)
        for b, v in zip(bars2, rmse):
            ax2.text(b.get_x()+b.get_width()/2, v+0.01, f"{v:.2f}", ha="center", fontsize=10)
        ax2.set_ylabel("RMSE")
        ax2.set_title(spec.get("titleRight", "误差"), fontsize=11)
    for axx in (ax1, ax2):
        axx.spines[["top", "right"]].set_visible(False)
    fig.suptitle(spec.get("title", "方法对比"), fontsize=12, y=1.02)
    return savefig(fig, spec.get("id", "compare"), spec.get("title", "方法对比"))

# ── 分发 ──
spec = inp.get("spec") or {}
kind = spec.get("kind", "alpha_bar")
try:
    if kind == "alpha_bar":
        chart_alpha_bar(spec)
    elif kind == "boxplot":
        chart_boxplot(spec)
    elif kind == "heatmap":
        chart_heatmap(spec)
    elif kind == "forest":
        chart_forest(spec)
    elif kind == "compare":
        chart_compare(spec)
    else:
        raise ValueError(f"未知图类型: {kind}")
    json.dump({"ok": True, "meta": {"charts": charts}},
              open(task_dir / "result.json", "w", encoding="utf-8"), ensure_ascii=False)
except Exception as e:
    import traceback
    json.dump({"ok": False, "error": f"{kind} 失败: {e}\n{traceback.format_exc()[-800:]}"},
              open(task_dir / "result.json", "w", encoding="utf-8"), ensure_ascii=False)
