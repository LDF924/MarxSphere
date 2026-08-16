# empirical_runner.py — 实证研究执行器（V348+）
# 用法: python empirical_runner.py <task_dir>
#   task_dir/input.json  : { method, params, data: { columnOrder, rows } }
#   task_dir/result.json : 结果契约 { meta, tables, figures, diagnostics, warnings }
# 设计: statspai 优先, 失败降级自写实现, 保证"第一次点运行必有结果"
# V380+: 多脚本委托分发 — input.script 非空时交给对应脚本(信效度/插补/数据管道)
import sys
import os
import json
import time

task_dir = sys.argv[1]
inp = json.load(open(os.path.join(task_dir, "input.json"), encoding="utf-8"))

# ─── V380: 多脚本委托分发(新增脚本不改 661 行主体) ───
_script = inp.get("script")
if _script == "reliability":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import empirical_reliability as _mod
    _mod.main(task_dir)
    sys.exit(0)
elif _script == "datapipeline":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import empirical_datapipeline as _mod
    _mod.main(task_dir)
    sys.exit(0)
elif _script == "imputation":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import empirical_imputation as _mod
    _mod.main(task_dir)
    sys.exit(0)

method = inp["method"]
params = inp.get("params") or {}
data = inp["data"]


import pandas as pd
import numpy as np

# ─── V381 安全加固: 列名白名单(防 patsy/pandas eval 注入 → RCE) ───
# 列名/参数列引用只允许 [A-Za-z_][A-Za-z0-9_]* 且非 Python 关键字
import keyword as _kw
import re as _re_guard

def _assert_safe_colname(name, ctx="列名"):
    if not isinstance(name, str) or not _re_guard.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
        raise ValueError(f"{ctx}不合法: {name!r} (仅允许字母/下划线/数字, 不能含空格/引号/括号)")
    if _kw.iskeyword(name) or name in ("__import__", "eval", "exec", "system", "open", "compile", "globals", "locals"):
        raise ValueError(f"{ctx}为保留字/危险名称: {name}")

for _c in data["columnOrder"]:
    _assert_safe_colname(_c)
for _k in ("y", "treat", "time", "id", "cluster", "unit", "endog", "treat_time", "rv", "dep", "row", "col"):
    _v = params.get(_k)
    if isinstance(_v, str) and _v:
        _assert_safe_colname(_v, f"参数 {_k}")
for _k in ("xs", "instruments", "fe", "controls"):
    for _v in (params.get(_k) or []):
        if isinstance(_v, str) and _v:
            _assert_safe_colname(_v, f"参数 {_k} 元素")

df = pd.DataFrame(data["rows"], columns=data["columnOrder"])
# 数值列尝试转 float（失败保留字符串）— pandas 3.x 无 errors="ignore", 用逐列 try
for c in df.columns:
    try:
        df[c] = pd.to_numeric(df[c])
    except (ValueError, TypeError):
        pass  # 保留原样 (字符串列)

t0 = time.time()
result = {"meta": {}, "tables": [], "figures": [], "diagnostics": [], "warnings": []}

# ─── 数据预处理(变量构造/稳健性) ───
pre = inp.get("preprocess") or {}
if pre:
    # winsorize: 1%/99% 缩尾
    wins = pre.get("winsorize") or []
    for col in wins:
        if col in df.columns and pd.api.types.is_numeric_dtype(df[col]):
            lo, hi = df[col].quantile([0.01, 0.99])
            df[col] = df[col].clip(lo, hi)
    # 取对数
    logs = pre.get("log") or []
    for col in logs:
        if col in df.columns and pd.api.types.is_numeric_dtype(df[col]):
            df["ln_" + col] = np.log(df[col].clip(lower=1e-9))
    # 标准化
    stds = pre.get("standardize") or []
    for col in stds:
        if col in df.columns and pd.api.types.is_numeric_dtype(df[col]):
            df["z_" + col] = (df[col] - df[col].mean()) / df[col].std()
    # 滞后项 (面板)
    lags = pre.get("lag") or []
    if lags:
        unit_col = params.get("id") or params.get("unit")
        time_col = params.get("time")
        if unit_col and time_col and unit_col in df.columns and time_col in df.columns:
            d2 = df.sort_values([unit_col, time_col])
            for col in lags:
                if col in d2.columns:
                    d2["L_" + col] = d2.groupby(unit_col)[col].shift(1)
            df = d2
    result["meta"]["preprocess"] = list(pre.keys())


def done(extra=None):
    result["meta"] = {
        "method": method,
        "n": int(len(df)),
        "specs": len(result["tables"]),
        "durationMs": int((time.time() - t0) * 1000),
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
    }
    if extra:
        result["meta"].update(extra)
    out = os.path.join(task_dir, "result.json")
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(tmp, out)  # 原子写, 防半写
    sys.exit(0)


def fail(msg):
    result["warnings"].append(msg)
    done({"error": msg})


def coef_svg(rows, title):
    """回归系数图: 横线 + 菱形点 + 95%CI, 返回 SVG 字符串"""
    n = len(rows)
    h = max(80, n * 28 + 40)
    w = 420
    pad_l, pad_r = 150, 30
    plot_w = w - pad_l - pad_r
    vals = [r["coef"] for r in rows]
    ci = [abs(r["ci_hi"] - r["ci_lo"]) / 2 for r in rows]
    vmax = max(1e-9, max(abs(v) + c for v, c in zip(vals, ci)))
    x = lambda v: pad_l + (v + vmax) / (2 * vmax) * plot_w
    y = lambda i: 30 + i * 28 + 14
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" style="max-width:100%">',
        f'<text x="{pad_l}" y="16" font-size="11" fill="var(--foreground)">{title}</text>',
    ]
    # 零线
    parts.append(f'<line x1="{x(0):.1f}" y1="20" x2="{x(0):.1f}" y2="{h-8}" stroke="var(--border)" stroke-dasharray="3 3"/>')
    for i, r in enumerate(rows):
        yy = y(i)
        parts.append(f'<line x1="{x(r["ci_lo"]):.1f}" y1="{yy}" x2="{x(r["ci_hi"]):.1f}" y2="{yy}" stroke="var(--primary)" stroke-width="2"/>')
        parts.append(f'<rect x="{x(r["coef"])-4:.1f}" y="{yy-4}" width="8" height="8" fill="var(--primary)" transform="rotate(45 {x(r["coef"]):.1f} {yy})"/>')
        parts.append(f'<text x="{pad_l-8}" y="{yy+4}" text-anchor="end" font-size="11" fill="var(--foreground)">{r["name"]}</text>')
    parts.append("</svg>")
    return "".join(parts)


def table_html(title, cols, rows, notes):
    return {"title": title, "cols": cols, "rows": rows, "notes": notes}


# ─── 方法分发 ───
if method in ("did", "did_twfe"):
    # 主实现: 自写交互项 OLS (TWFE DiD, 稳定可靠); statspai 仅作增强尝试
    try:
        import statsmodels.formula.api as smf
        d = df.copy()
        d["_treat"] = d[params.get("treat")].astype(float)
        # 时间: 支持 post(0/1) 或绝对年份(>= 处理时点)
        time_col = params.get("time")
        if "treat_time" in d.columns:
            # 有 treat_time 列: post = year >= 组处理时点
            tt = pd.to_numeric(d["treat_time"], errors="coerce").fillna(9999)
            d["_post"] = (d[time_col].astype(float) >= tt).astype(float)
        else:
            d["_post"] = d[time_col].astype(float)
        d["_did"] = d["_treat"] * d["_post"]
        ycol = params.get("y")
        formula = f"{ycol} ~ _treat + _post + _did"
        groups = d[params.get("id")] if params.get("id") and params.get("id") in d.columns else None
        # V381 fix: 无 id 分组时不传 cov_type="cluster"(否则 statsmodels 聚类无协变量崩溃)
        if groups is not None:
            m = smf.ols(formula, data=d).fit(cov_type="cluster", cov_kwds={"groups": groups})
        else:
            m = smf.ols(formula, data=d).fit()
        coef = m.params["_did"]
        se = m.bse["_did"]
        pv = m.pvalues["_did"]
        ci_lo, ci_hi = m.conf_int().loc["_did"]
        result["tables"].append(table_html("DID 交互项 OLS (TWFE)", ["变量", "系数", "SE", "p", "95%CI"], [["DID", round(coef, 4), round(se, 4), round(pv, 4), f"[{round(ci_lo,4)}, {round(ci_hi,4)}]"]], f"N={len(d)}, 聚类SE={'是' if groups is not None else '否'}, *** p<0.01, ** p<0.05, * p<0.1"))
        result["figures"].append({"id": "did", "title": "DID 系数图", "svg": coef_svg([{"name": "DID", "coef": coef, "ci_lo": ci_lo, "ci_hi": ci_hi}], "DID")})
        result["diagnostics"].append({"name": "DID 识别", "stat": "", "p": "", "verdict": "交互项 OLS 估计完成, 建议做平行趋势(用事件研究方法)"})
    except Exception as e:
        fail(f"DiD 执行失败: {str(e)[:120]}")

elif method == "ols":
    try:
        import statsmodels.formula.api as smf
        ycol = params.get("y")
        xs = params.get("xs") or []
        formula = f"{ycol} ~ " + " + ".join(xs)
        m = smf.ols(formula, data=df).fit()
        rows_t = []
        for name, val in m.params.items():
            se = m.bse[name]
            pv = m.pvalues[name]
            ci_lo, ci_hi = m.conf_int().loc[name]
            rows_t.append([name, round(val, 4), round(se, 4), round(pv, 4), f"[{round(ci_lo,4)}, {round(ci_hi,4)}]"])
        result["tables"].append(table_html("OLS 回归", ["变量", "系数", "SE", "p", "95%CI"], rows_t, f"R²={m.rsquared:.4f}, N={int(m.nobs)}, *** p<0.01, ** p<0.05, * p<0.1"))
        # 系数图
        fig_rows = [{"name": n, "coef": float(m.params[n]), "ci_lo": float(m.conf_int().loc[n][0]), "ci_hi": float(m.conf_int().loc[n][1])} for n in m.params.index if n != "Intercept"]
        if fig_rows:
            result["figures"].append({"id": "coef", "title": "系数图", "svg": coef_svg(fig_rows, "OLS 系数")})
    except Exception as e:
        fail(f"OLS 执行失败: {str(e)[:120]}")

elif method == "descriptive":
    try:
        cols = params.get("cols") or list(df.columns)
        rows_t = []
        for c in cols:
            s = df[c]
            if pd.api.types.is_numeric_dtype(s):
                rows_t.append([c, round(float(s.mean()), 4), round(float(s.std()), 4), int(s.count()), round(float(s.min()), 4), round(float(s.max()), 4)])
            else:
                rows_t.append([c, "", "", int(s.count()), "", ""])
        result["tables"].append(table_html("描述性统计", ["变量", "均值", "标准差", "N", "Min", "Max"], rows_t, "数值列统计"))
    except Exception as e:
        fail(f"描述统计失败: {str(e)[:120]}")

elif method == "panel_fe":
    try:
        import linearmodels
        from linearmodels import PanelOLS
        ycol = params.get("y")
        xs = params.get("xs") or []
        idc = params.get("id")
        tc = params.get("time")
        if not idc or not tc:
            fail("面板固定效应需要 id 和时间列")
        d = df.copy()
        d = d.set_index([idc, tc])
        xcols = list(xs) + ["const"]
        d["const"] = 1.0
        mod = PanelOLS(d[ycol], d[xcols], entity_effects=True, time_effects=True)
        res = mod.fit(cov_type="clustered", cluster_entity=True)
        coef_rows = []
        for name, val in res.params.items():
            se = res.std_errors[name]; pv = res.pvalues[name]
            lo, hi = res.conf_int().loc[name]
            coef_rows.append([name, round(float(val),4), round(float(se),4), round(float(pv),4), f"[{round(float(lo),4)}, {round(float(hi),4)}]"])
        result["tables"].append(table_html("面板双向固定效应 (linearmodels)", ["变量","系数","SE","p","95%CI"], coef_rows, f"N={len(d)}, 个体×时间 FE, 聚类SE"))
        # 系数图
        fig_rows = []
        for r_ in coef_rows:
            if r_[0] != "const":
                try:
                    lo = float(r_[4].replace("[","").split(",")[0]); hi = float(r_[4].replace("]","").split(",")[1])
                    fig_rows.append({"name": r_[0], "coef": float(r_[1]), "ci_lo": lo, "ci_hi": hi})
                except Exception: pass
        if fig_rows:
            result["figures"].append({"id":"panel-coef","title":"面板系数图","svg": coef_svg(fig_rows, "面板 FE 系数")})
        # Hausman 诊断
        try:
            from statspai import hausman_test
            h = hausman_test(data=df, y=ycol, x=xs, id=idc, time=tc)
            result["diagnostics"].append({"name":"Hausman", "stat": str(h.get("statistic","")), "p": str(h.get("p_value","")), "verdict": str(h.get("conclusion", h.get("decision","")))})
        except Exception: pass
    except Exception as e:
        fail(f"面板回归失败: {str(e)[:120]}")

elif method == "iv":
    try:
        from statspai import iv
        ycol = params.get("y")
        endog = params.get("endog")
        instruments = params.get("instruments") or []
        xs = params.get("xs") or []
        if not endog or not instruments:
            fail("IV 需要内生变量和工具变量")
        # 公式接口: y ~ (endog ~ instr1 + instr2) + x1 + x2
        formula = f"{ycol} ~ ({endog} ~ " + " + ".join(instruments) + ")"
        if xs:
            formula += " + " + " + ".join(xs)
        res = iv(formula, data=df, method="2sls")
        # 提取系数 (EconometricResults: params/conf_int/diagnostics)
        coef_rows = []
        params_dict = getattr(res, "params", None)
        if params_dict is not None:
            # params 可能是 dict 或 Series
            items = params_dict.items() if hasattr(params_dict, "items") else [(str(k), v) for k, v in params_dict]
            for name, val in items:
                try:
                    se = float(getattr(res, "bse", {}).get(name, 0)) if hasattr(res, "bse") else 0.0
                except Exception:
                    se = 0.0
                try:
                    pv = float(getattr(res, "pvalues", {}).get(name, 0)) if hasattr(res, "pvalues") else 0.0
                except Exception:
                    pv = 0.0
                try:
                    ci = res.conf_int
                    lo, hi = (ci.loc[name][0], ci.loc[name][1]) if hasattr(ci, "loc") else (float(val)-1.96*se, float(val)+1.96*se)
                except Exception:
                    lo, hi = float(val)-1.96*se, float(val)+1.96*se
                coef_rows.append([str(name), round(float(val),4), round(se,4), round(pv,4), f"[{round(lo,4)}, {round(hi,4)}]"])
            result["tables"].append(table_html("IV 2SLS 估计", ["变量","系数","SE","p","95%CI"], coef_rows, "内生变量: " + endog + ", 工具: " + ", ".join(instruments)))
            # 系数图
            fig_rows = []
            for r_ in coef_rows:
                if r_[0] not in ("Intercept", "const"):
                    try:
                        lo = float(r_[4].replace("[","").split(",")[0]); hi = float(r_[4].replace("]","").split(",")[1])
                        fig_rows.append({"name": r_[0], "coef": float(r_[1]), "ci_lo": lo, "ci_hi": hi})
                    except Exception: pass
            if fig_rows:
                result["figures"].append({"id":"iv-coef","title":"IV 系数图","svg": coef_svg(fig_rows, "IV 2SLS 系数")})
        else:
            result["tables"].append(table_html("IV 2SLS 结果", ["字段","值"], [["返回类型", str(type(res).__name__)]], "statspai IV 返回"))
        # 弱工具变量诊断
        try:
            diags = getattr(res, "diagnostics", None)
            if diags is not None:
                if isinstance(diags, dict):
                    for k, v in diags.items():
                        result["diagnostics"].append({"name": str(k), "stat": str(v)[:40], "p": "", "verdict": ""})
                elif hasattr(diags, "items"):
                    for k, v in diags.items():
                        result["diagnostics"].append({"name": str(k), "stat": str(v)[:40], "p": "", "verdict": ""})
        except Exception:
            pass
    except Exception as e:
        fail(f"IV 执行失败: {str(e)[:120]}")

elif method == "rdd":
    try:
        from statspai import rd_bias_aware_fuzzy
        # 简化: 用 OLS 分段拟合近似 (sharp RDD: 断点两侧局部线性 + 交互)
        import statsmodels.formula.api as smf
        ycol = params.get("y")
        rv = params.get("running")
        cutoff = float(params.get("cutoff", 0))
        d = df.copy()
        d["_rv"] = d[rv].astype(float) - cutoff
        d["_treated"] = (d["_rv"] >= 0).astype(float)
        d["_inter"] = d["_rv"] * d["_treated"]
        formula = f"{ycol} ~ _rv + _treated + _inter"
        m = smf.ols(formula, data=d).fit()
        # LATE 估计 = _treated 系数 (断点处)
        late = m.params["_treated"]
        se = m.bse["_treated"]
        pv = m.pvalues["_treated"]
        lo, hi = m.conf_int().loc["_treated"]
        result["tables"].append(table_html("RDD 局部线性 (sharp)", ["变量","系数","SE","p","95%CI"], [["LATE", round(float(late),4), round(float(se),4), round(float(pv),4), f"[{round(float(lo),4)}, {round(float(hi),4)}]"]], f"断点: {cutoff}, 局部线性+交互"))
        # RDD 断点图: 断点两侧均值散点 + 拟合线
        try:
            d2 = d.copy()
            d2["_bin"] = (d2["_rv"] // 0.2).astype(float)
            bins = d2.groupby("_bin")[ycol].agg(["mean", "count"])
            bins = bins[bins["count"] >= 3]
            pts = []
            for bi, row in bins.iterrows():
                pts.append({"x": float(bi)*0.2, "y": float(row["mean"])})
            if pts:
                w, h = 420, 200
                xs = [p["x"] for p in pts]; ys = [p["y"] for p in pts]
                xmin, xmax = min(xs), max(xs)
                ymin, ymax = min(ys), max(ys)
                ypad = max(1, (ymax - ymin) * 0.2)
                X = lambda v: 60 + (v - xmin) / (xmax - xmin) * (w - 80)
                Y = lambda v: h - 30 - (v - (ymin - ypad)) / (ymax - ymin + 2*ypad) * (h - 60)
                parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" style="max-width:100%">']
                parts.append(f'<line x1="{X(0):.1f}" y1="15" x2="{X(0):.1f}" y2="{h-30}" stroke="var(--border)" stroke-dasharray="3 3"/>')
                parts.append(f'<text x="{X(0):.1f}" y="12" font-size="10" fill="var(--muted-foreground)" text-anchor="middle">断点</text>')
                for p in pts:
                    parts.append(f'<circle cx="{X(p["x"]):.1f}" cy="{Y(p["y"]):.1f}" r="3" fill="var(--primary)"/>')
                parts.append("</svg>")
                result["figures"].append({"id":"rdd","title":"RDD 断点图","svg": "".join(parts)})
        except Exception: pass
        result["diagnostics"].append({"name":"RDD", "stat":"", "p":"", "verdict":"局部线性估计完成, 建议做 McCrary 密度检验"})
    except Exception as e:
        fail(f"RDD 执行失败: {str(e)[:120]}")

elif method == "psm":
    try:
        from statspai import MatchEstimator
        ycol = params.get("y")
        treat = params.get("treat")
        xs = params.get("xs") or []
        est = MatchEstimator(data=df, y=ycol, treat=treat, covariates=xs, estimand="ATT")
        res = est.fit()  # CausalResult
        att = getattr(res, "estimate", None)
        se = getattr(res, "se", None)
        pv = getattr(res, "p_value", None) or getattr(res, "pvalue", None)
        ci = getattr(res, "ci", None)
        lo, hi = (ci[0], ci[1]) if isinstance(ci, (list, tuple)) and len(ci) >= 2 else ("", "")
        coef_rows = [["ATT", round(float(att),4) if att is not None else "", round(float(se),4) if se is not None else "", round(float(pv),4) if pv is not None else "", f"[{round(float(lo),4)}, {round(float(hi),4)}]" if lo != "" else ""]]
        result["tables"].append(table_html("PSM 倾向得分匹配 (ATT)", ["变量","系数","SE","p","95%CI"], coef_rows, "协变量: " + ", ".join(xs)))
        # ATT 图
        if att is not None and se is not None:
            lo_v = float(att) - 1.96*float(se); hi_v = float(att) + 1.96*float(se)
            result["figures"].append({"id":"psm-att","title":"PSM ATT","svg": coef_svg([{"name":"ATT","coef": float(att), "ci_lo": lo_v, "ci_hi": hi_v}], "PSM ATT")})
        # 平衡/诊断
        try:
            diags = getattr(res, "diagnostics", None)
            if diags is not None:
                if isinstance(diags, dict):
                    for k, v in list(diags.items())[:5]:
                        result["diagnostics"].append({"name": str(k), "stat": str(v)[:40], "p": "", "verdict": ""})
                elif hasattr(diags, "items"):
                    for k, v in list(diags.items())[:5]:
                        result["diagnostics"].append({"name": str(k), "stat": str(v)[:40], "p": "", "verdict": ""})
        except Exception: pass
    except Exception as e:
        fail(f"PSM 执行失败: {str(e)[:120]}")

elif method == "scm":
    try:
        from statspai import SyntheticControl
        ycol = params.get("y")
        unit = params.get("unit")
        timec = params.get("time")
        treated_unit = params.get("treated_unit")
        treatment_time = float(params.get("treatment_time", 0))
        est = SyntheticControl(data=df, outcome=ycol, unit=unit, time=timec, treated_unit=treated_unit, treatment_time=treatment_time)
        res = est.fit()  # CausalResult
        att = getattr(res, "estimate", None)
        se = getattr(res, "se", None)
        pv = getattr(res, "p_value", None)
        ci = getattr(res, "ci", None)
        lo, hi = (ci[0], ci[1]) if isinstance(ci, (list, tuple)) and len(ci) >= 2 else ("", "")
        coef_rows = [["SCM ATT", round(float(att),4) if att is not None else "", round(float(se),4) if se is not None else "", round(float(pv),4) if pv is not None else "", f"[{round(float(lo),4)}, {round(float(hi),4)}]" if lo != "" else ""]]
        result["tables"].append(table_html("合成控制法", ["变量","系数","SE","p","95%CI"], coef_rows, f"处理单元: {treated_unit}, 处理时间: {treatment_time}"))
        # ATT 图
        if att is not None and se is not None:
            lo_v = float(att) - 1.96*float(se); hi_v = float(att) + 1.96*float(se)
            result["figures"].append({"id":"scm-att","title":"SCM ATT","svg": coef_svg([{"name":"ATT","coef": float(att), "ci_lo": lo_v, "ci_hi": hi_v}], "SCM ATT")})
        # 安慰剂/诊断
        try:
            diags = getattr(res, "diagnostics", None)
            if diags is not None:
                if isinstance(diags, dict):
                    for k, v in list(diags.items())[:5]:
                        result["diagnostics"].append({"name": str(k), "stat": str(v)[:40], "p": "", "verdict": ""})
        except Exception: pass
        result["diagnostics"].append({"name":"SCM 安慰剂", "stat":"", "p":"", "verdict":"建议做 in-space placebo 检验(见技能 10-Jill0099)"})
    except Exception as e:
        fail(f"SCM 执行失败: {str(e)[:120]}")

elif method == "event_study":
    try:
        import statsmodels.api as sm_ols
        ycol = params.get("y")
        unit = params.get("unit") or params.get("id")
        timec = params.get("time")
        treat_time = params.get("treat_time")
        if not unit or not timec or not treat_time:
            fail("事件研究需要 个体id/时间列/处理时间列")
        d = df.copy()
        d[treat_time] = pd.to_numeric(d[treat_time], errors="coerce").fillna(0).astype(int)
        # 未处理组(处理时间超出时间范围/为0) → rel 为 NaN, 只贡献 FE 不生成相对期虚拟变量
        t_max = d[timec].astype(int).max()
        d["_rel"] = d[timec].astype(int) - d[treat_time]
        d.loc[d[treat_time] > t_max, "_rel"] = np.nan
        d["_rel"] = d["_rel"].clip(-4, 4)
        # 处理组才生成虚拟变量(未处理组全 0)
        treated_mask = d[treat_time] <= t_max
        rel_vals = d.loc[treated_mask, "_rel"].fillna(0).astype(int)
        X = pd.DataFrame(index=d.index, dtype=float)
        for rv in range(-4, 5):
            if rv == -1:
                continue
            col = pd.Series(0.0, index=d.index)
            col.loc[treated_mask] = (rel_vals == rv).astype(float).values
            X[f"R_{rv}"] = col
        X = pd.concat([
            X,
            pd.get_dummies(d[unit].astype(str), prefix="U", drop_first=True),
            pd.get_dummies(d[timec].astype(int), prefix="T", drop_first=True),
        ], axis=1)
        X = sm_ols.add_constant(X)
        m = sm_ols.OLS(d[ycol].astype(float), X.astype(float)).fit()
        # 提取事件研究系数
        coef_rows = []
        for name in sorted(m.params.index, key=lambda s: (s[:2] != "R_", s)):
            if name.startswith("R_"):
                lo, hi = m.conf_int().loc[name]
                rel = int(name[2:])
                coef_rows.append([f"t{rel:+d}", round(float(m.params[name]),4), round(float(m.bse[name]),4), round(float(m.pvalues[name]),4), f"[{round(float(lo),4)}, {round(float(hi),4)}]"])
        result["tables"].append(table_html("事件研究 (TWFE 动态效应)", ["期间","系数","SE","p","95%CI"], coef_rows, "基期 t=-1, 个体+时间双向固定效应"))
        # 事件研究系数图 SVG
        if coef_rows:
            fig_rows = []
            for r in coef_rows:
                try:
                    fig_rows.append({"name": r[0], "coef": float(r[1]), "ci_lo": float(r[4].replace("[","").split(",")[0]), "ci_hi": float(r[4].replace("]","").split(",")[1])})
                except Exception: pass
            if fig_rows:
                result["figures"].append({"id":"event-study","title":"事件研究系数图","svg": coef_svg(fig_rows, "事件研究 (TWFE)")})
        # 平行趋势判断
        pre_rows = [r for r in coef_rows if r[0].startswith("t-")]
        pre_sig = [r for r in pre_rows if r[3] < 0.05]
        result["diagnostics"].append({
            "name": "平行趋势",
            "stat": f"{len(pre_sig)}/{len(pre_rows)} 基期前显著",
            "p": "",
            "verdict": "基期前系数不显著, 平行趋势成立 ✅" if not pre_sig else "⚠️ 基期前有显著系数, 需检查预处理趋势",
        })
    except Exception as e:
        fail(f"事件研究失败: {str(e)[:120]}")

elif method == "logit":
    # 二值因变量 Logit/Probit 回归
    try:
        import statsmodels.formula.api as smf
        ycol = params.get("y")
        xs = params.get("xs") or []
        link = params.get("link", "logit")
        d = df.copy()
        d[ycol] = pd.to_numeric(d[ycol], errors="coerce")
        d = d.dropna(subset=[ycol])
        formula = f"{ycol} ~ " + " + ".join(xs) if xs else f"{ycol} ~ 1"
        m = smf.logit(formula, data=d).fit(disp=0) if link == "logit" else smf.probit(formula, data=d).fit(disp=0)
        rows_t = []
        for name, val in m.params.items():
            se = m.bse[name]; pv = m.pvalues[name]
            lo, hi = m.conf_int().loc[name]
            rows_t.append([name, round(float(val),4), round(float(se),4), round(float(pv),4), f"[{round(float(lo),4)}, {round(float(hi),4)}]", round(float(m.predict(d).mean()),4)])
        result["tables"].append(table_html(f"{'Logit' if link=='logit' else 'Probit'} 回归 (二值因变量)", ["变量","系数","SE","p","95%CI","平均边际"], rows_t, f"N={int(m.nobs)}, Pseudo R²={round(m.prsquared,4)}"))
        # 边际效应图
        fig_rows = []
        for r_ in rows_t:
            if r_[0] != "const":
                try:
                    lo = float(r_[4].replace("[","").split(",")[0]); hi = float(r_[4].replace("]","").split(",")[1])
                    fig_rows.append({"name": r_[0], "coef": float(r_[1]), "ci_lo": lo, "ci_hi": hi})
                except Exception: pass
        if fig_rows:
            result["figures"].append({"id":"logit","title":"Logit 系数图","svg": coef_svg(fig_rows, f"{'Logit' if link=='logit' else 'Probit'} 系数")})
    except Exception as e:
        fail(f"Logit 执行失败: {str(e)[:120]}")

elif method == "ologit":
    # 有序因变量(1-5 意愿) Ordered Logit
    try:
        from statsmodels.miscmodels.ordinal_model import OrderedModel
        ycol = params.get("y")
        xs = params.get("xs") or []
        d = df.copy()
        d[ycol] = pd.to_numeric(d[ycol], errors="coerce").round().astype(int)
        d = d.dropna(subset=[ycol])
        # 过滤有效类别(至少2类)
        vc = d[ycol].value_counts()
        if len(vc) < 2:
            fail(f"因变量 {ycol} 只有 {len(vc)} 个类别, 需要 ≥2")
        X = d[xs].apply(pd.to_numeric, errors="coerce") if xs else pd.DataFrame(index=d.index)
        X = X.fillna(X.mean() if len(X) else 0)
        m = OrderedModel(d[ycol], X, distr="logit")
        res = m.fit(method="bfgs", disp=0, maxiter=200)
        rows_t = []
        for name, val in res.params.items():
            if name.startswith("cut"):
                continue
            se = res.bse[name]; pv = res.pvalues[name]
            lo, hi = res.conf_int().loc[name]
            rows_t.append([name, round(float(val),4), round(float(se),4), round(float(pv),4), f"[{round(float(lo),4)}, {round(float(hi),4)}]"])
        result["tables"].append(table_html("有序 Logit (因变量 1-5)", ["变量","系数","SE","p","95%CI"], rows_t, f"N={int(res.nobs)}, 类别数={len(vc)}, 阈值参数已省略"))
        # 系数图
        fig_rows = []
        for r_ in rows_t:
            try:
                lo = float(r_[4].replace("[","").split(",")[0]); hi = float(r_[4].replace("]","").split(",")[1])
                fig_rows.append({"name": r_[0], "coef": float(r_[1]), "ci_lo": lo, "ci_hi": hi})
            except Exception: pass
        if fig_rows:
            result["figures"].append({"id":"ologit","title":"有序 Logit 系数图","svg": coef_svg(fig_rows, "有序 Logit")})
    except Exception as e:
        fail(f"有序 Logit 执行失败: {str(e)[:120]}")

elif method == "mnl":
    # 多分类因变量 Multinomial Logit (非公式接口)
    try:
        import statsmodels.api as sm_mnl
        ycol = params.get("y")
        xs = params.get("xs") or []
        d = df.copy()
        d["_ycat"] = pd.Categorical(d[ycol].astype(str)).codes
        d = d.dropna(subset=["_ycat"])
        vc = pd.Categorical(d[ycol].astype(str)).categories
        if len(vc) < 2:
            fail(f"因变量 {ycol} 只有 {len(vc)} 个类别, 需要 ≥2")
        y = d["_ycat"].values
        X = sm_mnl.add_constant(d[xs].apply(pd.to_numeric, errors="coerce").fillna(0)) if xs else sm_mnl.add_constant(pd.DataFrame(index=d.index))
        m = sm_mnl.MNLogit(y, X.astype(float)).fit(disp=0, maxiter=300)
        rows_t = []
        # params/bse/pvalues: (n_vars, n_cats-1); conf_int: (n_vars*(n_cats-1), 2)
        n_cats = m.params.shape[1]
        ci = m.conf_int()
        for col_idx in range(n_cats):
            cat_name = str(vc[col_idx])
            for row_idx, var_name in enumerate(m.params.index):
                val = m.params.iloc[row_idx, col_idx]
                se = m.bse.iloc[row_idx, col_idx]
                pv = m.pvalues.iloc[row_idx, col_idx]
                flat = row_idx * n_cats + col_idx
                lo, hi = ci.iloc[flat, 0], ci.iloc[flat, 1]
                rows_t.append([f"{cat_name} × {var_name}", round(float(val),4), round(float(se),4), round(float(pv),4), f"[{round(float(lo),4)}, {round(float(hi),4)}]"])
        result["tables"].append(table_html("多项 Logit (多分类因变量)", ["变量(类别×协变量)","系数","SE","p","95%CI"], rows_t, f"N={int(m.nobs)}, 类别数={n_cats+1}, 参考类别={vc[0]}"))
    except Exception as e:
        fail(f"MNL 执行失败: {str(e)[:120]}")

elif method == "crosstab":
    # 交叉表 + 卡方检验
    try:
        from scipy import stats as scistats
        row_col = params.get("row")
        col_col = params.get("col")
        if not row_col or not col_col:
            fail("交叉表需要行变量和列变量")
        d = df.copy()
        ct = pd.crosstab(d[row_col], d[col_col])
        chi2, p, dof, expected = scistats.chi2_contingency(ct)
        cramers_v = float((chi2 / (len(d) * (min(ct.shape) - 1))) ** 0.5) if min(ct.shape) > 1 else 0
        rows_t = []
        for idx, row in ct.iterrows():
            rows_t.append([str(idx)] + [str(v) for v in row.values])
        result["tables"].append(table_html(f"交叉表: {row_col} × {col_col}", [str(c) for c in ct.columns], rows_t, f"N={len(d)}"))
        result["diagnostics"].append({"name":"卡方检验", "stat": f"χ²={round(chi2,4)}", "p": str(round(p,4)), "verdict": f"Cramér's V={round(cramers_v,4)}" + (" (显著关联)" if p < 0.05 else " (无显著关联)")})
        # 百分比表
        pct = ct.div(ct.sum(axis=1), axis=0) * 100
        rows_p = []
        for idx, row in pct.iterrows():
            rows_p.append([str(idx)] + [f"{v:.1f}%" for v in row.values])
        result["tables"].append(table_html("行百分比 (%)", [str(c) for c in pct.columns], rows_p, "按行计算"))
    except Exception as e:
        fail(f"交叉表失败: {str(e)[:120]}")

elif method == "genvars":
    # 自定义变量构造: 公式列表 [{name, expr}]
    try:
        formulas = params.get("formulas") or []
        if not formulas:
            fail("需要 formulas: [{name, expr}] 如 [{name:'rate', expr:'out/own'}]")
        created = []
        for f in formulas:
            name = f.get("name"); expr = f.get("expr")
            if not name or not expr:
                continue
            try:
                import re as _re
                # 注入防护(Python 侧兜底, 防绕过 TS 校验直接调用 runner)
                if _re.search(r"[;\n\r]|__|\bimport\b|\bexec\b|\beval\b|\bsystem\b|\bopen\b|@|%|`", expr):
                    raise ValueError(f"表达式包含不允许的字符: {expr[:40]}")
                tokens = _re.findall(r"[A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*|[+\-*/()]", expr)
                for tk in tokens:
                    if _re.match(r"^[A-Za-z_]", tk) and tk not in df.columns:
                        raise ValueError(f"未知列: {tk}")
                df[name] = df.eval(expr)
                created.append(f"{name} = {expr}")
            except Exception as e:
                result["warnings"].append(f"变量 {name} 构造失败: {str(e)[:80]}")
        if created:
            result["tables"].append(table_html("变量构造", ["新变量","公式"], [[c.split(" = ")[0], c.split(" = ")[1]] for c in created], "已生成新列, 可在后续分析中使用"))
            result["meta"]["genvars"] = created
        else:
            fail("没有变量构造成功")
    except Exception as e:
        fail(f"变量构造失败: {str(e)[:120]}")

elif method == "filter":
    # 子样本筛选: 条件列表 [{col, op, value}]
    try:
        conds = params.get("conditions") or []
        if not conds:
            fail("需要 conditions: [{col, op, value}] 如 [{col:'identity', op:'==', value:2}]")
        mask = pd.Series(True, index=df.index)
        applied = []
        for c in conds:
            col = c.get("col"); op = c.get("op"); val = c.get("value")
            if not col or not op:
                continue
            try:
                if op == "==": m = df[col].astype(str) == str(val)
                elif op == "!=": m = df[col].astype(str) != str(val)
                elif op == ">": m = pd.to_numeric(df[col], errors="coerce") > float(val)
                elif op == ">=": m = pd.to_numeric(df[col], errors="coerce") >= float(val)
                elif op == "<": m = pd.to_numeric(df[col], errors="coerce") < float(val)
                elif op == "<=": m = pd.to_numeric(df[col], errors="coerce") <= float(val)
                elif op == "in": m = df[col].astype(str).isin([str(v) for v in (val if isinstance(val, list) else [val])])
                else:
                    result["warnings"].append(f"不支持操作符: {op}")
                    continue
                mask = mask & m.fillna(False)
                applied.append(f"{col} {op} {val}")
            except Exception as e:
                result["warnings"].append(f"条件 {col} {op} {val} 失败: {str(e)[:60]}")
        df_filtered = df[mask]
        result["tables"].append(table_html("子样本筛选", ["条件","结果"], [[a, ""] for a in applied], f"筛选后: {len(df_filtered)}/{len(df)} 行"))
        result["meta"]["filtered"] = {"n_before": int(len(df)), "n_after": int(len(df_filtered)), "conditions": applied}
        num_cols = df_filtered.select_dtypes(include="number").columns[:6]
        rows_t = []
        for c in num_cols:
            rows_t.append([c, round(float(df_filtered[c].mean()),4) if len(df_filtered) else "", round(float(df_filtered[c].std()),4) if len(df_filtered) else "", int(len(df_filtered))])
        if rows_t:
            result["tables"].append(table_html("筛选后描述统计", ["变量","均值","SD","N"], rows_t, f"共 {len(df_filtered)} 行"))
    except Exception as e:
        fail(f"筛选失败: {str(e)[:120]}")

else:
    fail(f"未知方法: {method}")

done()
