# -*- coding: utf-8 -*-
"""empirical_reliability.py — 信效度计算(全手写, 无第三方依赖)（V380+）
契约: python empirical_reliability.py <task_dir>; 读 input.json {script:"reliability", data, params}
  params.scaleGroups: [{name, columns}]
输出 result.json: {meta, tables, diagnostics, warnings}
  tables: [克隆巴赫α表(含删除项后α), KMO表, 因子分析表]
  diagnostics: [Bartlett检验, 特征值>1因子数建议]
也可作为模块被 empirical_runner.py 委托调用: main(task_dir)
"""
import json, os, sys
import numpy as np


def cronbach_alpha(mat):
    """克隆巴赫 α: mat 2D array (n_obs, k_items), 不含缺失"""
    k = mat.shape[1]
    if k < 2 or mat.shape[0] < 3:
        return float("nan")
    item_var = mat.var(axis=0, ddof=1)
    total_var = mat.sum(axis=1).var(ddof=1)
    if total_var <= 0:
        return float("nan")
    return k / (k - 1) * (1 - item_var.sum() / total_var)


def kmo_factor(mat):
    """KMO = Σr²_ij / (Σr²_ij + Σp²_ij); r=相关阵, p=偏相关阵(反像相关法)"""
    n = mat.shape[1]
    if n < 2 or mat.shape[0] < 3:
        return float("nan")
    R = np.corrcoef(mat.T)
    R = np.where(np.eye(n) == 1, 1.0, R)
    try:
        Rinv = np.linalg.inv(R)
    except np.linalg.LinAlgError:
        return float("nan")
    diag = np.sqrt(np.diag(Rinv))
    P = -Rinv / np.outer(diag, diag)
    np.fill_diagonal(P, 0)
    np.fill_diagonal(R, 0)
    num = (R ** 2).sum()
    den = num + (P ** 2).sum()
    if den <= 0:
        return float("nan")
    return num / den


def bartlett(mat):
    """Bartlett 球形检验: χ² = -[n-1-(2k+5)/6]*ln|R|"""
    n = mat.shape[0]
    k = mat.shape[1]
    R = np.corrcoef(mat.T)
    R = np.where(np.eye(k) == 1, 1.0, R)
    try:
        sign, logdet = np.linalg.slogdet(R)
    except np.linalg.LinAlgError:
        return float("nan"), float("nan")
    if sign <= 0:
        logdet = 0.0  # 非正定矩阵, 视为近似奇异
    chi2 = -(n - 1 - (2 * k + 5) / 6) * logdet
    df_ = k * (k - 1) / 2
    try:
        from scipy import stats
        p = stats.chi2.sf(max(0, chi2), df_)
    except Exception:
        p = float("nan")
    return float(chi2), float(p)


def factor_analysis(mat, max_factors=3):
    """主成分法特征值分解 + varimax 旋转(手写吉文斯循环)"""
    n, k = mat.shape
    Z = (mat - mat.mean(axis=0)) / (mat.std(axis=0, ddof=0) + 1e-12)
    R = np.corrcoef(Z.T)
    R = np.where(np.eye(k) == 1, 1.0, R)
    eigvals, eigvecs = np.linalg.eigh(R)
    order = np.argsort(eigvals)[::-1]
    eigvals, eigvecs = eigvals[order], eigvecs[:, order]
    n_factors = min(max_factors, k, int((eigvals > 1).sum()) or 1)
    n_factors = max(1, n_factors)
    L = eigvecs[:, :n_factors] * np.sqrt(np.maximum(eigvals[:n_factors], 0))
    # varimax 旋转
    for _ in range(50):
        if n_factors == 1:
            break
        changed = 0.0
        for p in range(n_factors):
            for q in range(p + 1, n_factors):
                u = L[:, p] ** 2 - L[:, q] ** 2
                v = 2 * L[:, p] * L[:, q]
                A = (u ** 2 - v ** 2).sum()
                B = (2 * u * v).sum()
                if abs(A) + abs(B) < 1e-12:
                    continue
                theta = np.arctan2(B, A) / 4
                c, s = np.cos(theta), np.sin(theta)
                col_p = c * L[:, p] - s * L[:, q]
                col_q = s * L[:, p] + c * L[:, q]
                L[:, p], L[:, q] = col_p, col_q
                changed += abs(theta)
        if changed < 1e-8:
            break
    return eigvals, L, n_factors


def main(task_dir):
    inp = json.load(open(os.path.join(task_dir, "input.json"), encoding="utf-8"))
    params = inp.get("params") or {}
    data = inp["data"]

    import pandas as pd
    df = pd.DataFrame(data["rows"], columns=data["columnOrder"])
    for c in df.columns:
        try:
            df[c] = pd.to_numeric(df[c])
        except (ValueError, TypeError):
            pass

    result = {"meta": {}, "tables": [], "diagnostics": [], "warnings": []}

    def done():
        result["meta"] = {"method": "reliability", "n": int(len(df)), "specs": len(result["tables"]),
                          "scaleGroups": len(params.get("scaleGroups") or [])}
        out = os.path.join(task_dir, "result.json")
        tmp = out + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
        os.replace(tmp, out)
        sys.exit(0)

    def fail(msg):
        result["warnings"].append(msg)
        done()

    def table_html(title, cols, rows, notes):
        return {"title": title, "cols": cols, "rows": rows, "notes": notes}

    # ── 主流程 ──
    groups = params.get("scaleGroups") or []
    if not groups:
        fail("需要 scaleGroups: [{name, columns}]")

    alpha_rows = []
    kmo_rows = []
    factor_tables = []

    for g in groups:
        gname = g.get("name") or "量表"
        cols = [c for c in (g.get("columns") or []) if c in df.columns]
        if len(cols) < 2:
            result["warnings"].append(f"量表 {gname}: 有效列 <2, 跳过")
            continue
        sub = df[cols]
        # 混合列加固: 逐列 to_numeric(errors="coerce"), 文本值 → NaN 而非整列崩
        for _c in cols:
            sub[_c] = pd.to_numeric(sub[_c], errors="coerce")
        full = sub.dropna()
        n_full = len(full)
        result["warnings"].append(f"量表 {gname}: 完整样本 {n_full}/{len(df)} (缺失行已剔除)")
        if n_full < 5 or n_full < len(cols) + 2:
            result["warnings"].append(f"量表 {gname}: 样本量不足 (n={n_full}), 信效度结果仅供探索参考")
        mat = full.to_numpy(dtype=float)
        if mat.shape[1] < 2:
            continue

        # α
        alpha = cronbach_alpha(mat)
        drop_rows = []
        for i, c in enumerate(cols):
            if mat.shape[1] > 2:
                a_drop = cronbach_alpha(np.delete(mat, i, axis=1))
            else:
                a_drop = float("nan")
            drop_rows.append([c, round(float(a_drop), 4) if not np.isnan(a_drop) else ""])
        alpha_rows.append([gname, round(float(alpha), 4) if not np.isnan(alpha) else "", n_full,
                           "可接受" if not np.isnan(alpha) and alpha >= 0.6 else ("较差" if not np.isnan(alpha) else "不可算")])

        # KMO + Bartlett
        kmo = kmo_factor(mat)
        chi2, p_bart = bartlett(mat)
        kmo_rows.append([gname, round(float(kmo), 4) if not np.isnan(kmo) else "", len(cols),
                         round(float(chi2), 4) if not np.isnan(chi2) else "",
                         round(float(p_bart), 6) if not np.isnan(p_bart) else ""])

        # 因子分析
        if n_full >= 5:
            eigvals, loadings, n_f = factor_analysis(mat)
            rows_f = []
            for i, c in enumerate(cols):
                load_row = [c]
                for j in range(n_f):
                    v = loadings[i, j] if i < loadings.shape[0] else 0
                    load_row.append(round(float(v), 3))
                rows_f.append(load_row)
            header = ["变量"] + [f"因子{j + 1}" for j in range(n_f)]
            factor_tables.append(table_html(f"因子分析(主成分+varimax): {gname}",
                                            header, rows_f,
                                            f"特征值>1因子数={n_f}, 累计解释方差={round(float(eigvals[:n_f].sum() / len(cols)), 4)}"))

    if alpha_rows:
        result["tables"].append(table_html("克隆巴赫 α (信度)",
            ["量表", "α系数", "N", "评价"], alpha_rows,
            "α≥0.7 良好, 0.6-0.7 可接受, <0.6 需删题(见下方删除项后α)"))
        # 删除项后 α 合并表
        drop_all = []
        for g in groups:
            gname = g.get("name") or "量表"
            cols = [c for c in (g.get("columns") or []) if c in df.columns]
            sub = df[cols].dropna()
            if len(sub) < 5 or len(cols) < 3:
                continue
            mat2 = sub.to_numpy(dtype=float)
            for i, c in enumerate(cols):
                a_drop = cronbach_alpha(np.delete(mat2, i, axis=1))
                drop_all.append([gname, c, round(float(a_drop), 4) if not np.isnan(a_drop) else ""])
        if drop_all:
            result["tables"].append(table_html("删除某项后 α (题项诊断)",
                ["量表", "题项", "删除后α"], drop_all,
                "删除后α > 原α 的题项可考虑删除"))

    if kmo_rows:
        result["tables"].append(table_html("KMO 与 Bartlett 球形检验 (效度)",
            ["量表", "KMO", "题项数", "Bartlett χ²", "p值"], kmo_rows,
            "KMO≥0.8 良好, 0.6-0.8 可接受, <0.6 提示样本量或题项结构问题"))
        for row in kmo_rows:
            try:
                if float(row[1]) < 0.6:
                    result["warnings"].append(f"量表 {row[0]}: KMO={row[1]} < 0.6, 样本量或题项结构可能不足")
            except (ValueError, TypeError):
                pass

    for ft in factor_tables:
        result["tables"].append(ft)

    result["diagnostics"].append({"name": "信效度诊断",
        "stat": f"量表数={len(groups)}",
        "verdict": "α/KMO/因子分析完成" + (", 存在样本量警告" if len(result["warnings"]) > 1 else "")})

    done()


if __name__ == "__main__":
    main(sys.argv[1])
