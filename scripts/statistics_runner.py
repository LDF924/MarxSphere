# statistics_runner.py — SocialSci 统计分析执行器(闭源 StatisticsView 17 方法语义还原)
# 用法: python statistics_runner.py <task_dir>
#   task_dir/input.json  : { tool, fileId, ...方法参数(见 methodParams.ts build), data: {columnOrder, rows} }
#   task_dir/result.json : 闭源结果契约 { tables:[{title,columns,rows}], charts:[{config:{data,layout}}], warnings, metadata }
# 语义对齐 decoded-stats-viz.md §1: 17 方法参数/输出/三线表数据/图表 config 结构
# 安全: 列名白名单(与 empirical_runner 同规则, 防 pandas eval 注入)
import sys
import os
import json

task_dir = sys.argv[1]
inp = json.load(open(os.path.join(task_dir, "input.json"), encoding="utf-8"))

tool = inp.get("tool", "descriptive")
params = inp.get("params") or inp  # 兼容: 组装层已把参数摊平到 body
data = inp.get("data") or {}
column_order = data.get("columnOrder") or []
rows = data.get("rows") or []

import re as _re
import keyword as _kw

def _assert_safe_colname(name, ctx="列名"):
    if not isinstance(name, str) or not _re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
        raise ValueError(f"{ctx}不合法: {name!r} (仅允许字母/下划线/数字, 不能含空格/引号/括号)")
    if _kw.iskeyword(name) or name in ("__import__", "eval", "exec", "system", "open", "compile", "globals", "locals"):
        raise ValueError(f"{ctx}为保留字/危险名称: {name}")

for _c in column_order:
    _assert_safe_colname(_c)

import pandas as pd
import numpy as np

# 数据装配(行数可能超实际列 → 取每行前 len(column_order) 项; 列值类型宽松)
max_cols = len(column_order)
norm_rows = [list(r[:max_cols]) + [None] * (max_cols - len(r)) for r in rows]
df = pd.DataFrame(norm_rows, columns=column_order)

# 数值列识别(pandas 类型)
def _num_cols():
    return [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]

def _cat_cols():
    return [c for c in df.columns if not pd.api.types.is_numeric_dtype(df[c])]

warnings = []

def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return float("nan")

# ─── 输出助手: 表格/图表统一结构 ───
tables = []
charts = []

def add_table(title, columns, rows_data, footnote=None):
    tbl = {"title": title, "columns": columns, "rows": rows_data}
    if footnote:
        tbl["footnote"] = footnote
    tables.append(tbl)

def add_bar_chart(title, cats, values, xlabel=None, ylabel=None):
    charts.append({
        "config": {
            "data": [{"type": "bar", "x": cats, "y": values, "name": title, "orientation": "v"}],
            "layout": {"title": {"text": title}, "xaxis": {"title": {"text": xlabel or ""}}, "yaxis": {"title": {"text": ylabel or ""}}, "template": "plotly_white"}
        }
    })

# ─── 白盒阶段上报(2026-09-09: 任务执行进度可见 — task_dir/stage.json 供服务端轮询推送) ───
def set_stage(label):
    try:
        with open(os.path.join(task_dir, "stage.json"), "w", encoding="utf-8") as _f:
            _f.write(json.dumps({"stage": label, "ts": os.path.getmtime(os.path.join(task_dir, "input.json")) if os.path.exists(os.path.join(task_dir, "input.json")) else 0}))
    except Exception:
        pass

# ─── 17 方法实现 ───
variables = [v for v in (params.get("variables") or []) if v in df.columns]

if tool == "descriptive":
    set_stage("描述统计计算")
    opts = params.get("options") or params
    stats_cols = variables or _num_cols()
    rows_out = []
    for c in stats_cols:
        s = pd.to_numeric(df[c], errors="coerce").dropna()
        if s.empty:
            continue
        row = {"变量": c, "N": int(s.count())}
        if opts.get("mean"): row["均值"] = round(float(s.mean()), 3)
        if opts.get("median"): row["中位数"] = round(float(s.median()), 3)
        if opts.get("std"): row["标准差"] = round(float(s.std()), 3)
        if opts.get("minmax"):
            row["最小值"] = round(float(s.min()), 3)
            row["最大值"] = round(float(s.max()), 3)
        if opts.get("quartiles"):
            q = s.quantile([0.25, 0.75])
            row["Q1"] = round(float(q[0.25]), 3)
            row["Q3"] = round(float(q[0.75]), 3)
        if opts.get("skew"): row["偏度"] = round(float(s.skew()), 3)
        if opts.get("kurt"): row["峰度"] = round(float(s.kurt()), 3)
        rows_out.append(row)
    cols = list(rows_out[0].keys()) if rows_out else []
    add_table("描述统计", cols, [list(r.values()) for r in rows_out])
    if opts.get("histogram") and stats_cols:
        c0 = stats_cols[0]
        s = pd.to_numeric(df[c0], errors="coerce").dropna()
        if not s.empty:
            h, edges = np.histogram(s, bins=min(20, max(5, int(np.sqrt(s.count())))))
            mids = [(edges[i] + edges[i + 1]) / 2 for i in range(len(h))]
            charts.append({"config": {"data": [{"type": "bar", "x": mids, "y": h.tolist(), "name": "频数"}], "layout": {"title": {"text": f"{c0} 直方图"}, "template": "plotly_white"}}})

elif tool == "frequency":
    set_stage("频数统计")
    for v in variables or _cat_cols():
        vc = df[v].value_counts(dropna=False)
        pct = (vc / vc.sum() * 100).round(2)
        add_table(f"频数分析 · {v}", ["取值", "频数", "百分比(%)"],
                  [[str(k), int(c), float(pct[k])] for k, c in vc.items()])

elif tool == "classify":
    set_stage("分组汇总")
    gv = params.get("groupVar")
    stats_cols = [v for v in variables if pd.api.types.is_numeric_dtype(df[v])]
    rows_out = []
    groups = sorted(df[gv].dropna().unique()) if gv and gv in df.columns else ["全部"]
    for g in groups:
        sub = df[df[gv] == g] if gv and gv in df.columns else df
        for v in stats_cols:
            s = pd.to_numeric(sub[v], errors="coerce").dropna()
            if s.empty:
                continue
            rows_out.append([str(g), v, int(s.count()), round(float(s.mean()), 3), round(float(s.std()), 3), round(float(s.min()), 3), round(float(s.max()), 3)])
    add_table("分类汇总", ["分组", "变量", "N", "均值", "标准差", "最小值", "最大值"], rows_out)

elif tool == "transform":
    set_stage("数据转换")
    trs = params.get("transforms") or []
    new_df = df.copy()
    for v in variables:
        s = pd.to_numeric(df[v], errors="coerce")
        for t in trs:
            name = f"{v}_{t}"
            if t in ("z-score", "zscore"):
                std = s.std()
                new_df[name] = (s - s.mean()) / std if std and std > 0 else s * 0
            elif t in ("min-max", "minmax"):
                rng = s.max() - s.min()
                new_df[name] = (s - s.min()) / rng if rng and rng > 0 else s * 0
            elif t == "log":
                new_df[name] = np.log(s.clip(lower=1e-9))
            elif t == "rank":
                new_df[name] = s.rank()
            elif t == "sqrt":
                new_df[name] = np.sqrt(s.clip(lower=0))
    # 预览前 20 行
    preview_cols = new_df.columns.tolist()
    add_table("数据转换预览(前 20 行)", preview_cols, new_df.head(20).astype(object).where(pd.notnull(new_df.head(20)), None).values.tolist(),
              footnote="新列已生成: " + ", ".join([c for c in new_df.columns if c not in df.columns]))

elif tool == "filter":
    set_stage("条件筛选")
    conds = params.get("conditions") or []
    logic = params.get("logic") or "and"
    mask = pd.Series(True, index=df.index)
    for c in conds:
        col = c.get("variable", "")
        op = c.get("operator", ">=")
        val = c.get("value", "")
        if col not in df.columns:
            continue
        if op == ">=":
            m = pd.to_numeric(df[col], errors="coerce") >= float(val)
        elif op == ">":
            m = pd.to_numeric(df[col], errors="coerce") > float(val)
        elif op == "<=":
            m = pd.to_numeric(df[col], errors="coerce") <= float(val)
        elif op == "<":
            m = pd.to_numeric(df[col], errors="coerce") < float(val)
        elif op == "==":
            m = df[col].astype(str) == str(val)
        elif op == "!=":
            m = df[col].astype(str) != str(val)
        else:
            m = pd.Series(False, index=df.index)
        mask = (mask & m) if logic == "and" else (mask | m)
    sub = df[mask]
    add_table(f"筛选结果(N={len(sub)})", df.columns.tolist(), sub.head(50).astype(object).where(pd.notnull(sub.head(50)), None).values.tolist(),
              footnote="满足条件行数: " + str(int(mask.sum())))

elif tool == "t-test":
    set_stage("t 检验")
    from scipy import stats as sps
    tt = params.get("testType", "one_sample")
    if tt == "one_sample":
        test_val = float(params.get("testValue") or 0)
        for v in variables:
            s = pd.to_numeric(df[v], errors="coerce").dropna()
            if len(s) < 2:
                continue
            t, p = sps.ttest_1samp(s, test_val)
            add_table(f"单样本 t 检验 · {v}(检验值 {test_val})",
                      ["t 值", "自由度", "p 值", "均值差", "95% CI 下限", "95% CI 上限"],
                      [[round(float(t), 3), int(len(s) - 1), round(float(p), 4), round(float(s.mean() - test_val), 3),
                        round(float(sps.t.interval(0.95, len(s) - 1, loc=s.mean(), scale=sps.sem(s))[0] - test_val), 3),
                        round(float(sps.t.interval(0.95, len(s) - 1, loc=s.mean(), scale=sps.sem(s))[1] - test_val), 3)]])
    elif tt == "independent":
        dep = params.get("dependentVar") or (variables[0] if variables else "")
        gv = params.get("groupVar")
        if dep in df.columns and gv in df.columns:
            groups = df[gv].dropna().unique()[:2]
            if len(groups) == 2:
                a = pd.to_numeric(df[df[gv] == groups[0]][dep], errors="coerce").dropna()
                b = pd.to_numeric(df[df[gv] == groups[1]][dep], errors="coerce").dropna()
                if len(a) > 1 and len(b) > 1:
                    t, p = sps.ttest_ind(a, b, equal_var=False)
                    add_table(f"独立样本 t 检验 · {dep} by {gv}",
                              ["组别", "N", "均值", "标准差", "t 值", "p 值"],
                              [[str(groups[0]), int(len(a)), round(float(a.mean()), 3), round(float(a.std()), 3), round(float(t), 3) if groups[0] == groups[0] else "", ""],
                               [str(groups[1]), int(len(b)), round(float(b.mean()), 3), round(float(b.std()), 3), "", ""],
                               ["差异", "", "", "", round(float(t), 3), round(float(p), 4)]])
    elif tt == "paired":
        pv = params.get("pairedVars") or variables
        for i in range(0, len(pv) - 1, 2):
            a = pd.to_numeric(df[pv[i]], errors="coerce").dropna()
            b = pd.to_numeric(df[pv[i + 1]], errors="coerce").dropna()
            common = a.index.intersection(b.index)
            if len(common) > 1:
                t, p = sps.ttest_rel(a[common], b[common])
                add_table(f"配对 t 检验 · {pv[i]} vs {pv[i+1]}", ["t 值", "自由度", "p 值", "均值差"],
                          [[round(float(t), 3), int(len(common) - 1), round(float(p), 4), round(float((a[common] - b[common]).mean()), 3)]])

elif tool == "anova":
    set_stage("方差分析")
    from scipy import stats as sps
    gv = params.get("groupVar")
    if gv in df.columns:
        groups = [pd.to_numeric(df[df[gv] == g][v], errors="coerce").dropna() for g in df[gv].dropna().unique() if v in df.columns for v in ([variables[0]] if variables else _num_cols()[:1])]
        for v in (variables or _num_cols()):
            samples = [pd.to_numeric(df[df[gv] == g][v], errors="coerce").dropna() for g in df[gv].dropna().unique()]
            samples = [s for s in samples if len(s) > 1]
            if len(samples) >= 2:
                f, p = sps.f_oneway(*samples)
                all_s = pd.concat(samples)
                add_table(f"单因素 ANOVA · {v} by {gv}",
                          ["来源", "平方和", "自由度", "均方", "F 值", "p 值"],
                          [["组间", round(float(sum(len(s) * (s.mean() - all_s.mean()) ** 2 for s in samples)), 3), int(len(samples) - 1), "", round(float(f), 3), round(float(p), 4)],
                           ["组内", round(float(sum(((s - s.mean()) ** 2).sum() for s in samples)), 3), int(sum(len(s) for s in samples) - len(samples)), "", "", ""],
                           ["总计", round(float(((all_s - all_s.mean()) ** 2).sum()), 3), int(len(all_s) - 1), "", "", ""]])

elif tool == "multivariate-anova":
    set_stage("多因素方差")
    dep = params.get("dependentVar")
    factors = params.get("factors") or []
    from scipy import stats as sps
    if dep in df.columns and len(factors) >= 1:
        # 双因素 ANOVA 简化: 交互项 OLS 分解(闭源 multivariate-anova 语义核心 = 主效应+交互)
        import statsmodels.formula.api as smf
        safe = df.copy()
        for f in factors:
            safe[f] = safe[f].astype(str)
        formula = f"{dep} ~ " + " * ".join(f"C({f})" for f in factors)
        try:
            model = smf.ols(formula, data=safe).fit()
            sm = model.summary()
            add_table("多因素 ANOVA", ["项", "系数", "标准误", "t 值", "p 值"],
                      [[str(r), round(float(model.params[r]), 3), round(float(model.bse[r]), 3), round(float(model.tvalues[r]), 3), round(float(model.pvalues[r]), 4)] for r in model.params.index])
        except Exception as e:
            warnings.append(f"多因素 ANOVA 拟合失败: {str(e)[:200]}")

elif tool == "correlation":
    set_stage("相关分析")
    from scipy import stats as sps
    method = params.get("method", "pearson")
    cols = [v for v in variables if pd.api.types.is_numeric_dtype(df[v])]
    if len(cols) >= 2:
        corr = df[cols].corr(method=method)
        pvals = pd.DataFrame(np.ones((len(cols), len(cols))), index=cols, columns=cols)
        for i, a in enumerate(cols):
            for j, b in enumerate(cols):
                if i < j:
                    mask = df[[a, b]].dropna()
                    if len(mask) > 2:
                        if method == "pearson":
                            _, p = sps.pearsonr(mask[a], mask[b])
                        elif method == "spearman":
                            _, p = sps.spearmanr(mask[a], mask[b])
                        else:
                            _, p = sps.kendalltau(mask[a], mask[b])
                        pvals.loc[a, b] = pvals.loc[b, a] = p
        header = ["变量"] + cols
        rows_out = [[a] + [round(float(corr.loc[a, b]), 3) if not np.isnan(corr.loc[a, b]) else "" for b in cols] for a in cols]
        add_table(f"相关矩阵({method})", header, rows_out)
        p_rows = [[a] + [round(float(pvals.loc[a, b]), 4) if not np.isnan(pvals.loc[a, b]) else "" for b in cols] for a in cols]
        add_table("显著性(p 值)", header, p_rows)
        # 相关热图
        charts.append({"config": {"data": [{"type": "heatmap", "z": corr.values.tolist(), "x": cols, "y": cols, "colorscale": "RdBu", "zmin": -1, "zmax": 1}], "layout": {"title": {"text": f"相关矩阵热图({method})"}, "template": "plotly_white"}}})

elif tool == "crosstab":
    set_stage("交叉表卡方")
    rv = params.get("rowVar")
    cv = params.get("colVar")
    if rv in df.columns and cv in df.columns:
        ct = pd.crosstab(df[rv], df[cv])
        from scipy import stats as sps
        chi2, p, dof, expected = sps.chi2_contingency(ct)
        header = [rv + " \\ " + cv] + [str(c) for c in ct.columns] + ["合计"]
        rows_out = [[str(i)] + [int(ct.loc[i, c]) for c in ct.columns] + [int(ct.loc[i].sum())] for i in ct.index]
        rows_out.append(["合计"] + [int(ct[c].sum()) for c in ct.columns] + [int(ct.values.sum())])
        add_table(f"交叉表 · {rv} × {cv}", header, rows_out)
        add_table("卡方检验", ["卡方值", "自由度", "p 值", "Cramér's V"],
                  [[round(float(chi2), 3), int(dof), round(float(p), 4), round(float(np.sqrt(chi2 / (ct.values.sum() * (min(ct.shape) - 1)))) if min(ct.shape) > 1 and ct.values.sum() else 0, 3)]])

elif tool == "nonparametric":
    set_stage("非参数检验")
    from scipy import stats as sps
    tt = params.get("testType", "mann-whitney")
    gv = params.get("groupVar")
    if tt == "mann-whitney" and gv in df.columns:
        groups = df[gv].dropna().unique()[:2]
        a = pd.to_numeric(df[df[gv] == groups[0]][variables[0]], errors="coerce").dropna()
        b = pd.to_numeric(df[df[gv] == groups[1]][variables[0]], errors="coerce").dropna()
        if len(a) and len(b):
            u, p = sps.mannwhitneyu(a, b, alternative="two-sided")
            add_table(f"Mann-Whitney U · {variables[0]} by {gv}", ["U 值", "p 值", "组1 中位数", "组2 中位数"],
                      [[round(float(u), 3), round(float(p), 4), round(float(a.median()), 3), round(float(b.median()), 3)]])
    elif tt == "wilcoxon":
        for i in range(0, len(variables) - 1, 2):
            a = pd.to_numeric(df[variables[i]], errors="coerce").dropna()
            b = pd.to_numeric(df[variables[i + 1]], errors="coerce").dropna()
            common = a.index.intersection(b.index)
            if len(common) > 1:
                w, p = sps.wilcoxon(a[common], b[common])
                add_table(f"Wilcoxon 符号秩 · {variables[i]} vs {variables[i+1]}", ["W 值", "p 值", "N"],
                          [[round(float(w), 3), round(float(p), 4), int(len(common))]])
    elif tt == "kruskal" and gv in df.columns:
        groups = [pd.to_numeric(df[df[gv] == g][variables[0]], errors="coerce").dropna() for g in df[gv].dropna().unique()]
        groups = [g for g in groups if len(g) > 0]
        if len(groups) >= 2:
            h, p = sps.kruskal(*groups)
            add_table(f"Kruskal-Wallis · {variables[0]} by {gv}", ["H 值", "自由度", "p 值"],
                      [[round(float(h), 3), int(len(groups) - 1), round(float(p), 4)]])

elif tool == "normality":
    set_stage("正态性检验")
    from scipy import stats as sps
    for v in variables:
        s = pd.to_numeric(df[v], errors="coerce").dropna()
        if len(s) < 3 or len(s) > 5000:
            continue
        if len(s) <= 2000:
            w, p = sps.shapiro(s)
            add_table(f"Shapiro-Wilk · {v}", ["W 值", "p 值", "结论"],
                      [[round(float(w), 4), round(float(p), 4), "符合正态" if p > 0.05 else "偏离正态"]])
        ks, kp = sps.kstest(s, "norm", args=(s.mean(), s.std()))
        add_table(f"Kolmogorov-Smirnov · {v}", ["D 值", "p 值", "结论"],
                  [[round(float(ks), 4), round(float(kp), 4), "符合正态" if kp > 0.05 else "偏离正态"]])

elif tool == "regression":
    set_stage("回归拟合")
    dep = params.get("dependentVar")
    indep = params.get("independentVars") or []
    if dep in df.columns and indep:
        import statsmodels.api as sm
        X = df[indep].apply(pd.to_numeric, errors="coerce")
        y = pd.to_numeric(df[dep], errors="coerce")
        mask = pd.notnull(y) & X.notnull().all(axis=1)
        Xc, yc = X[mask], y[mask]
        Xc = sm.add_constant(Xc)
        model = sm.OLS(yc, Xc).fit()
        header = ["变量", "系数", "标准误", "t 值", "p 值", "95% CI"]
        rows_out = []
        for name, val in zip(model.params.index, model.params.values):
            ci = model.conf_int().loc[name]
            rows_out.append([str(name), round(float(val), 3), round(float(model.bse[name]), 3), round(float(model.tvalues[name]), 3), round(float(model.pvalues[name]), 4),
                             f"[{round(float(ci[0]), 3)}, {round(float(ci[1]), 3)}]"])
        add_table("OLS 回归结果", header, rows_out)
        add_table("模型拟合", ["R²", "调整 R²", "F 值", "F p 值", "N"],
                  [[round(float(model.rsquared), 4), round(float(model.rsquared_adj), 4), round(float(model.fvalue), 3), round(float(model.f_pvalue), 4), int(model.nobs)]])
        # 系数图(闭源 chart 配置)
        charts.append({"config": {"data": [{"type": "bar", "x": [str(n) for n in model.params.index[1:]], "y": [float(v) for v in model.params.values[1:]], "name": "系数"}],
                        "layout": {"title": {"text": f"{dep} 回归系数图"}, "template": "plotly_white"}}})

elif tool == "logistic-regression":
    set_stage("Logistic 拟合")
    dep = params.get("dependentVar")
    indep = params.get("independentVars") or []
    if dep in df.columns and indep:
        import statsmodels.api as sm
        X = df[indep].apply(pd.to_numeric, errors="coerce")
        y = pd.to_numeric(df[dep], errors="coerce")
        mask = pd.notnull(y) & X.notnull().all(axis=1) & y.isin([0, 1])
        Xc, yc = X[mask], y[mask]
        Xc = sm.add_constant(Xc)
        try:
            model = sm.Logit(yc, Xc).fit(disp=0)
            header = ["变量", "系数", "标准误", "z 值", "p 值", "优势比 OR"]
            rows_out = []
            for name in model.params.index:
                orv = np.exp(model.params[name]) if name != "const" else ""
                rows_out.append([str(name), round(float(model.params[name]), 3), round(float(model.bse[name]), 3), round(float(model.tvalues[name]), 3), round(float(model.pvalues[name]), 4),
                                 round(float(orv), 3) if orv != "" else ""])
            add_table("Logistic 回归结果", header, rows_out)
            if params.get("showOddsRatios"):
                add_table("模型拟合", ["Pseudo R²", "LLF", "N"],
                          [[round(float(model.prsquared), 4), round(float(model.llf), 2), int(model.nobs)]])
        except Exception as e:
            warnings.append(f"Logistic 拟合失败: {str(e)[:200]}")

elif tool == "reliability":
    set_stage("信度 α 计算")
    cols = [v for v in variables if pd.api.types.is_numeric_dtype(df[v])]
    if len(cols) >= 2:
        items = df[cols].apply(pd.to_numeric, errors="coerce").dropna()
        k = items.shape[1]
        if items.shape[0] > 1:
            item_var = items.var(axis=0).sum()
            total_var = items.sum(axis=1).var()
            alpha = (k / (k - 1)) * (1 - item_var / total_var) if total_var > 0 else float("nan")
            rows_out = []
            for c in cols:
                others = items.drop(columns=[c])
                ov = others.sum(axis=1).var()
                iva = others.var(axis=0).sum()
                a_del = ((k - 1) / (k - 2)) * (1 - iva / ov) if ov > 0 and k > 2 else float("nan")
                rows_out.append([c, round(float(a_del), 3) if not np.isnan(a_del) else ""])
            add_table(f"Cronbach α(总体)", ["指标", "值"], [["α 系数", round(float(alpha), 3) if not np.isnan(alpha) else ""], ["项数", k], ["有效样本", int(items.shape[0])]])
            add_table("删除项后的 α", ["变量", "删除后 α"], rows_out)

elif tool == "efa":
    set_stage("因子分析")
    from factor_analyzer import FactorAnalyzer
    cols = [v for v in variables if pd.api.types.is_numeric_dtype(df[v])]
    if len(cols) >= 3:
        mat = df[cols].apply(pd.to_numeric, errors="coerce").dropna()
        if mat.shape[0] > mat.shape[1]:
            fa = FactorAnalyzer(rotation=params.get("rotation", "varimax"), method=params.get("extraction", "principal"), n_factors=int(params.get("nFactors")) if params.get("nFactors") else None)
            try:
                fa.fit(mat)
                loadings = fa.loadings_
                nf = loadings.shape[1]
                header = ["变量"] + [f"因子{i+1}" for i in range(nf)] + ["共同度"]
                rows_out = []
                for i, c in enumerate(cols):
                    comm = float(np.sum(loadings[i] ** 2))
                    rows_out.append([c] + [round(float(loadings[i][j]), 3) for j in range(nf)] + [round(comm, 3)])
                add_table(f"因子载荷({params.get('rotation', 'varimax')})", header, rows_out)
                ev = fa.get_eigenvalues()[0]
                add_table("特征值", ["因子", "特征值", "解释方差(%)"],
                          [[f"因子{i+1}", round(float(ev[i]), 3), round(float(ev[i] / len(cols) * 100), 2)] for i in range(min(len(ev), len(cols)))])
            except Exception as e:
                warnings.append(f"因子分析失败: {str(e)[:200]}")
        else:
            warnings.append("有效样本数不足(需大于变量数)")

elif tool == "mediation-moderation":
    set_stage("中介调节分析")
    at = params.get("analysisType", "mediation")
    xv = params.get("xVar")
    yv = params.get("yVar")
    if at == "mediation" and xv and yv and params.get("mVar"):
        mv = params.get("mVar")
        import statsmodels.api as sm
        data_s = df[[xv, yv, mv]].apply(pd.to_numeric, errors="coerce").dropna()
        if len(data_s) > 10:
            # 三步法 + Sobel
            X = sm.add_constant(data_s[xv])
            m1 = sm.OLS(data_s[mv], X).fit()
            X2 = sm.add_constant(data_s[[xv, mv]])
            m2 = sm.OLS(data_s[yv], X2).fit()
            a = m1.params[xv]; sa = m1.bse[xv]
            b = m2.params[mv]; sb = m2.bse[mv]
            sobel = (a * b) / np.sqrt(b ** 2 * sa ** 2 + a ** 2 * sb ** 2)
            from scipy import stats as sps
            p_sobel = 2 * (1 - sps.norm.cdf(abs(sobel)))
            add_table("中介效应(三步法)", ["路径", "系数", "标准误", "p 值"],
                      [[f"{xv}→{mv} (a)", round(float(a), 3), round(float(sa), 3), round(float(m1.pvalues[xv]), 4)],
                       [f"{mv}→{yv} (b)", round(float(b), 3), round(float(sb), 3), round(float(m2.pvalues[mv]), 4)],
                       [f"总效应 c ({xv}→{yv})", round(float(sm.OLS(data_s[yv], sm.add_constant(data_s[xv])).fit().params[xv]), 3), "", ""]])
            add_table("Sobel 检验", ["间接效应 a×b", "Sobel z", "p 值"],
                      [[round(float(a * b), 4), round(float(sobel), 3), round(float(p_sobel), 4)]])
    elif at == "moderation" and xv and yv and params.get("wVar"):
        wv = params.get("wVar")
        import statsmodels.api as sm
        data_s = df[[xv, yv, wv]].apply(pd.to_numeric, errors="coerce").dropna()
        if len(data_s) > 10:
            if params.get("centering") == "mean":
                data_s[xv] = data_s[xv] - data_s[xv].mean()
                data_s[wv] = data_s[wv] - data_s[wv].mean()
            data_s["xw"] = data_s[xv] * data_s[wv]
            model = sm.OLS(data_s[yv], sm.add_constant(data_s[[xv, wv, "xw"]])).fit()
            add_table("调节效应(交互项)", ["变量", "系数", "标准误", "t 值", "p 值"],
                      [[str(n), round(float(model.params[n]), 3), round(float(model.bse[n]), 3), round(float(model.tvalues[n]), 3), round(float(model.pvalues[n]), 4)] for n in model.params.index])

# ─── 汇总警告: 变量不存在/无数据 ───
if not len(df):
    warnings.append("数据为空, 请先上传数据文件")
if not variables and tool in ("descriptive", "frequency", "classify", "transform", "normality", "reliability"):
    warnings.append("未选择变量, 已使用全部可用列")

result = {"tables": tables, "charts": charts, "warnings": warnings, "metadata": {"tool": tool, "rows": int(len(df)), "cols": int(len(df.columns))}}

out = os.path.join(task_dir, "result.json")
tmp = out + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, default=str)
os.replace(tmp, out)  # 原子写(与 empirical 竞态防护同)
