# -*- coding: utf-8 -*-
"""empirical_stata_templates.py — Stata 常量模板库 + 变量注入（V380+）
反 hallucinate 核心: 常量模板, 不靠 LLM 自由发挥; 变量名注入过白名单
用法: build_stata(steps: dict, vars: list[str]) -> str
  对应 python 管道五步: 缺失/缩尾/构造/筛选/描述
"""
import re


def _safe_var(v: str) -> bool:
    return bool(re.match(r"^[a-z_][a-z0-9_]*$", v))


def _safe_expr(expr: str, vars: list[str]) -> bool:
    tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*|[+\-*/()]", expr)
    allowed = set(vars) | {"log", "exp", "sqrt", "abs", "min", "max", "sum", "mean"}
    return all(tok in allowed or tok.isdigit() for tok in tokens if re.match(r"^[A-Za-z_]", tok))


def build_stata(steps: dict, vars: list[str]) -> str:
    """从 steps 生成 Stata .do 代码(与 python 管道同名步骤一一对应)"""
    out = []
    out.append("* 数据管道 Stata 复现脚本 (由 MarxSphere 实证工作台生成)")
    out.append("* 对应: 缺失统计 → 缩尾 → 变量构造 → 样本筛选 → 描述统计")
    out.append("* 前置: ssc install winsor2 estout estpost  (esttab 需 estout)")
    out.append("clear all")
    out.append("set more off")
    out.append("* import delimited 数据文件路径, 自行替换")
    out.append('import delimited "问卷数据.csv", clear')
    out.append("")

    # 1) 缺失统计
    miss_cols = (steps.get("missing") or {}).get("cols") or vars
    miss_cols = [c for c in miss_cols if _safe_var(c)]
    if miss_cols:
        out.append("* ── 1. 缺失统计 (含编码缺失 -99/-88) ──")
        out.append(f"misstable summarize {' '.join(miss_cols)}")
        out.append("* 编码缺失检查 (跳转未答 -99, 拒答 -88):")
        for c in miss_cols[:8]:
            out.append(f"count if {c} == -99  // {c} 未适用数")
            out.append(f"count if {c} == -88  // {c} 拒答数")
        out.append("")

    # 2) 缩尾
    win_cfg = steps.get("winsorize") or {}
    win_cols = [c for c in (win_cfg.get("cols") or []) if _safe_var(c)]
    if win_cols:
        lo = int((win_cfg.get("lo", 0.01)) * 100)
        hi = int((win_cfg.get("hi", 0.99)) * 100)
        out.append("* ── 2. 缩尾 (winsor2, 默认 1%/99%) ──")
        out.append(f"winsor2 {' '.join(win_cols)}, cuts({lo} {hi}) replace")
        out.append("* 若未安装 winsor2, 用 _pctile 手写降级:")
        for c in win_cols[:4]:
            out.append(f"quietly _pctile {c}, p({lo})")
            out.append(f"gen byte _lo_{c} = {c} < r(r1)")
            out.append(f"replace {c} = r(r1) if {c} < r(r1)")
            out.append(f"quietly _pctile {c}, p({hi})")
            out.append(f"replace {c} = r(r1) if {c} > r(r1)")
        out.append("")

    # 3) 变量构造
    formulas = steps.get("genvars") or []
    for f in formulas:
        name = f.get("name", "")
        expr = f.get("expr", "")
        if _safe_var(name) and _safe_expr(expr, vars):
            # Stata 语法映射: ** → ^ 不支持, log() → ln()
            sexpr = expr.replace("**", "^").replace("log(", "ln(").replace("sqrt(", "sqrt(")
            out.append("* ── 3. 变量构造 ──")
            out.append(f"gen {name} = {sexpr}  // {expr}")
            out.append("")

    # 4) 筛选
    conds = steps.get("filter") or []
    if conds:
        parts = []
        for c in conds:
            col, op, val = c.get("col"), c.get("op"), c.get("value")
            if not _safe_var(col) or col not in vars:
                continue
            st_op = {"==": "==", "!=": "!=", ">": ">", ">=": ">=", "<": "<", "<=": "<="}.get(op)
            if st_op and isinstance(val, (int, float)):
                parts.append(f"{col} {st_op} {val}")
            elif op == "in" and isinstance(val, list):
                parts.append(f"inlist({col}, {', '.join(str(v) for v in val)})")
        if parts:
            out.append("* ── 4. 样本筛选 ──")
            out.append(f"keep if {' & '.join(parts)}")
            out.append(f"count  // 筛选后样本量")
            out.append("")

    # 5) 描述统计
    desc_cols = [c for c in ((steps.get("describe") or {}).get("cols") or vars) if _safe_var(c)]
    if desc_cols:
        out.append("* ── 5. 描述统计 (Table 1) ──")
        out.append(f"estpost summarize {' '.join(desc_cols)}")
        out.append("esttab using table1.tex, cells(\"count mean(fmt(2)) sd(fmt(2)) min max\") replace")
        out.append("")
    out.append("* 完成 — 复现核对: 各步骤样本量/变量应与 Python 管道结果一致")
    return "\n".join(out)


if __name__ == "__main__":
    # 自检: 两次生成快照一致(确定性)
    steps = {
        "missing": {"cols": ["own_area", "adj_willing"]},
        "winsorize": {"cols": ["own_area", "nonfarm_income"]},
        "genvars": [{"name": "has_out", "expr": "transfer_out_area > 0"}],
        "filter": [{"col": "own_area", "op": ">", "value": 0}],
        "describe": {"cols": ["own_area", "adj_willing"]},
    }
    vars_list = ["own_area", "adj_willing", "nonfarm_income", "transfer_out_area"]
    a = build_stata(steps, vars_list)
    b = build_stata(steps, vars_list)
    print("确定性快照一致:", a == b)
    print(a[:400])
