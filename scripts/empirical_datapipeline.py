# -*- coding: utf-8 -*-
"""empirical_datapipeline.py — 数据处理管道五步(缺失/缩尾/构造/筛选/描述)（V380+）
契约: main(task_dir); 读 input.json {script:"datapipeline", data, params}
  params.steps: {
    missing: {cols?: string[]},                        # 1. 缺失统计(含 -99/-88 编码缺失)
    winsorize: {cols: string[], lo?: number, hi?: number},  # 2. 缩尾(默认 1%/99%)
    genvars: [{name, expr}],                          # 3. 变量构造
    filter: [{col, op, value}],                       # 4. 筛选
    describe: {cols?: string[]}                       # 5. 描述统计 Table 1
  }
输出 result.json: {meta{pipeline:{n_before,n_after,generated[],winsorized[],notes[]}}, tables, diagnostics, warnings}
"""
import json, os, sys
import re


def main(task_dir):
    inp = json.load(open(os.path.join(task_dir, "input.json"), encoding="utf-8"))
    params = inp.get("params") or {}
    data = inp["data"]

    import pandas as pd
    import numpy as np
    df = pd.DataFrame(data["rows"], columns=data["columnOrder"])
    for c in df.columns:
        try:
            df[c] = pd.to_numeric(df[c])
        except (ValueError, TypeError):
            pass

    result = {"meta": {}, "tables": [], "diagnostics": [], "warnings": []}
    n_before = int(len(df))
    generated = []
    winsorized = []
    notes = []
    steps = params.get("steps") or {}

    def done():
        result["meta"] = {"method": "datapipeline",
                          "pipeline": {"n_before": n_before, "n_after": int(len(df)),
                                       "generated": generated, "winsorized": winsorized, "notes": notes},
                          "n": int(len(df))}
        out = os.path.join(task_dir, "result.json")
        tmp = out + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
        os.replace(tmp, out)
        sys.exit(0)

    def table_html(title, cols, rows, nt):
        return {"title": title, "cols": cols, "rows": rows, "notes": nt}

    # ── 1) 缺失统计 ──
    miss_cfg = steps.get("missing") or {}
    miss_cols = miss_cfg.get("cols") or list(df.columns)
    miss_rows = []
    for c in miss_cols:
        if c not in df.columns:
            continue
        s = df[c]
        n_missing = int(s.isna().sum())
        rate = round(n_missing / len(df) * 100, 2) if len(df) else 0
        # 编码缺失 -99/-88
        n_m99 = int((s == -99).sum()) if pd.api.types.is_numeric_dtype(s) else 0
        n_m88 = int((s == -88).sum()) if pd.api.types.is_numeric_dtype(s) else 0
        miss_rows.append([c, n_missing, rate, n_m99, n_m88, int(s.nunique())])
    if miss_rows:
        result["tables"].append(table_html("缺失统计", ["变量", "缺失N", "缺失率%", "-99数", "-88数", "唯一值"],
                                           miss_rows, "编码缺失: -99 未适用(跳转), -88 拒答"))

    # ── 2) 缩尾 ──
    win_cfg = steps.get("winsorize") or {}
    win_cols = win_cfg.get("cols") or []
    lo = float(win_cfg.get("lo", 0.01))
    hi = float(win_cfg.get("hi", 0.99))
    if win_cols:
        for c in win_cols:
            if c not in df.columns or not pd.api.types.is_numeric_dtype(df[c]):
                continue
            q_lo, q_hi = df[c].quantile([lo, hi])
            n_chg = int(((df[c] < q_lo) | (df[c] > q_hi)).sum())
            df[c] = df[c].clip(q_lo, q_hi)
            winsorized.append(f"{c}({n_chg}条)")
        win_rows = [[c, round(float(df[c].quantile(lo)), 4), round(float(df[c].quantile(hi)), 4)] for c in win_cols if c in df.columns]
        result["tables"].append(table_html("缩尾处理", ["变量", f"下界(P{int(lo*100)})", f"上界(P{int(hi*100)})"],
                                           win_rows, f"缩尾列: {', '.join(winsorized) or '无'}"))

    # ── 3) 变量构造 ──
    formulas = steps.get("genvars") or []
    for f in formulas:
        name = f.get("name")
        expr = f.get("expr")
        if not name or not expr:
            continue
        try:
            # 注入防护(Python 侧兜底)
            if re.search(r"[;\n\r]|__|\bimport\b|\bexec\b|\beval\b|\bsystem\b|\bopen\b|@|%|`", expr):
                raise ValueError(f"表达式包含不允许的字符: {expr[:40]}")
            tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*|[+\-*/()]", expr)
            for tk in tokens:
                if re.match(r"^[A-Za-z_]", tk) and tk not in df.columns and tk not in ("log", "exp", "sqrt", "abs", "min", "max", "sum", "mean", "nan", "inf"):
                    raise ValueError(f"未知列: {tk}")
            df[name] = df.eval(expr)
            generated.append(f"{name} = {expr}")
        except Exception as e:
            result["warnings"].append(f"变量 {name} 构造失败: {str(e)[:80]}")
    if generated:
        result["tables"].append(table_html("变量构造", ["新变量", "公式"],
                                           [[g.split(" = ")[0], g.split(" = ")[1]] for g in generated],
                                           f"共 {len(generated)} 个新变量"))

    # ── 4) 筛选 ──
    conds = steps.get("filter") or []
    if conds:
        mask = pd.Series(True, index=df.index)
        applied = []
        for c in conds:
            col, op, val = c.get("col"), c.get("op"), c.get("value")
            if not col or not op or col not in df.columns:
                continue
            try:
                if op == "==":
                    m = df[col].astype(str) == str(val)
                elif op == "!=":
                    m = df[col].astype(str) != str(val)
                elif op == ">":
                    m = pd.to_numeric(df[col], errors="coerce") > float(val)
                elif op == ">=":
                    m = pd.to_numeric(df[col], errors="coerce") >= float(val)
                elif op == "<":
                    m = pd.to_numeric(df[col], errors="coerce") < float(val)
                elif op == "<=":
                    m = pd.to_numeric(df[col], errors="coerce") <= float(val)
                elif op == "in":
                    m = df[col].astype(str).isin([str(v) for v in (val if isinstance(val, list) else [val])])
                else:
                    continue
                mask = mask & m.fillna(False)
                applied.append(f"{col} {op} {val}")
            except Exception as e:
                result["warnings"].append(f"条件 {col} {op} {val} 失败: {str(e)[:60]}")
        df = df[mask]
        notes.append(f"筛选: {' AND '.join(applied)} → {len(df)}/{n_before} 行")
        result["tables"].append(table_html("样本筛选", ["条件", "结果"],
                                           [[a, ""] for a in applied],
                                           f"筛选后: {len(df)}/{n_before} 行"))

    # ── 5) 描述统计 ──
    desc_cfg = steps.get("describe") or {}
    desc_cols = desc_cfg.get("cols") or list(df.columns)
    desc_rows = []
    for c in desc_cols:
        if c not in df.columns:
            continue
        s = df[c]
        if pd.api.types.is_numeric_dtype(s):
            desc_rows.append([c, round(float(s.mean()), 4), round(float(s.std()), 4), int(s.count()),
                              round(float(s.min()), 4), round(float(s.max()), 4)])
        else:
            desc_rows.append([c, "", "", int(s.count()), "", ""])
    if desc_rows:
        result["tables"].append(table_html("描述性统计 (Table 1)", ["变量", "均值", "标准差", "N", "Min", "Max"],
                                           desc_rows, f"N={len(df)}"))

    result["diagnostics"].append({"name": "管道摘要",
        "stat": f"n_before={n_before} → n_after={len(df)}",
        "verdict": f"构造 {len(generated)} 变量, 缩尾 {len(winsorized)} 列, 筛选 {len(notes)} 步"})

    done()


if __name__ == "__main__":
    main(sys.argv[1])
