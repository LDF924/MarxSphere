# -*- coding: utf-8 -*-
"""empirical_report_export.py — 课题全套报告导出(V413)
把课题流水线(问卷+数据版本+全阶段 runs+图表)打包成 LaTeX(.tex) / Word(.docx)。
input.json: { script, overview: {projectId, questionnaires, versions, runs},
              figuresDir: 绝对路径(figures PNG 目录, 可选),
              outDir }  →  result.json: { ok, files: [{name, kind, sizeKB}] }
"""
import json, sys, os
from pathlib import Path

task_dir = Path(sys.argv[1])
inp = json.load(open(task_dir / "input.json", encoding="utf-8"))
ov = inp.get("overview") or {}
out_dir = Path(inp.get("outDir") or task_dir)
out_dir.mkdir(parents=True, exist_ok=True)
fig_dir = inp.get("figuresDir")
if fig_dir:
    fig_dir = Path(fig_dir)

def esc_latex(s):
    return str(s).replace("&", "\\&").replace("%", "\\%").replace("_", "\\_").replace("#", "\\#").replace("$", "\\$")

STAGE_CN = {"recognize": "问卷识别", "simulate": "仿真数据", "reliability": "信效度",
            "diagnosis": "数据诊断", "imputation": "LLM 插补", "data_pipeline": "数据管道",
            "regression": "回归"}

def stage_label(stage):
    return STAGE_CN.get(stage, stage)

def tables_of(run):
    pr = run.get("pythonResult") or {}
    return pr.get("tables") or []

def run_summary(run):
    pr = run.get("pythonResult") or {}
    meta = pr.get("meta") or {}
    parts = []
    if meta.get("n") is not None:
        parts.append(f"N={meta.get('n')}")
    for t in (pr.get("tables") or [])[:1]:
        rows = t.get("rows") or []
        if rows:
            parts.append(f"表[{t.get('title','')}] {len(rows)}行")
    return ", ".join(parts) if parts else ""

# ─────────── LaTeX 报告 ───────────
def build_latex():
    L = []
    L.append("% MarxSphere 课题实证分析报告 (自动生成, V413)")
    L.append("\\documentclass[11pt]{article}")
    L.append("\\usepackage[UTF8]{ctex}")
    L.append("\\usepackage{booktabs}")
    L.append("\\usepackage{geometry}")
    L.append("\\usepackage{graphicx}")
    L.append("\\usepackage{longtable}")
    L.append("\\geometry{margin=2.2cm}")
    L.append("\\begin{document}")
    L.append("\\begin{center}{\\LARGE\\bfseries 问卷实证分析全套报告}\\end{center}")
    L.append("\\vspace{0.5em}")
    L.append("\\begin{center}MarxSphere 实证工作台 \\cdot 自动生成\\end{center}")
    L.append("\\noindent\\rule{\\linewidth}{0.4pt}")
    L.append("")

    # 问卷
    qs = ov.get("questionnaires") or []
    if qs:
        L.append("\\section*{一、问卷结构}")
        for q in qs:
            cols = q.get("columns") or []
            L.append(f"\\paragraph{{{esc_latex(q.get('title','问卷'))}}} 来源={q.get('source','')}, 变量数={len(cols)}")
            inds = (q.get("meta") or {}).get("indicators") or []
            if inds:
                L.append(f"\\noindent 指标: {'、'.join(esc_latex(str(i)) for i in inds)}")
                L.append("")

    # 数据版本
    vers = ov.get("versions") or []
    if vers:
        L.append("\\section*{二、数据版本}")
        L.append("\\begin{tabular}{lcccl}\\toprule")
        L.append("名称 & 行数 & 变量数 & 哈希 & 时间 \\\\ \\midrule")
        for v in vers[:10]:
            ts = (v.get("created_at") or "")[:16].replace("T", " ")
            L.append(f"{esc_latex(str(v.get('name','')))[:28]} & {v.get('nRows',0)} & {len(v.get('columns') or [])} & {(v.get('contentHash') or '')[:8]} & {esc_latex(ts)} \\\\")
        L.append("\\bottomrule\\end{tabular}\n")

    # 各阶段 runs
    runs = ov.get("runs") or []
    if runs:
        L.append("\\section*{三、分析流水线}")
        for i, run in enumerate(runs, 1):
            stage = run.get("stage", "")
            ts = (run.get("createdAt") or "")[:16].replace("T", " ")
            L.append(f"\\subsection*{{{i}. {esc_latex(stage_label(stage))} — {esc_latex(ts)}}}")
            summ = run_summary(run)
            if summ:
                L.append(f"\\noindent\\small {esc_latex(summ)}\\normalsize\n")
            for t in tables_of(run):
                cols = t.get("cols") or []
                rows = t.get("rows") or []
                if not cols or not rows:
                    continue
                L.append(f"\\begin{{table}}[htbp]\\centering")
                L.append(f"\\caption{{{esc_latex(t.get('title',''))}}}")
                L.append(f"\\begin{{tabular}}{{l{'c'*(len(cols)-1)}}}")
                L.append("\\toprule")
                L.append(esc_latex(" & ".join(str(c) for c in cols)) + " \\\\")
                L.append("\\midrule")
                for r in rows[:50]:
                    L.append(esc_latex(" & ".join(str(v) for v in r)) + " \\\\")
                if len(rows) > 50:
                    L.append(f"\\multicolumn{{{len(cols)}}}{{l}}{{\\scriptsize 仅显示前50行, 共{len(rows)}行}} \\\\")
                L.append("\\bottomrule")
                if t.get("notes"):
                    L.append(f"\\multicolumn{{{len(cols)}}}{{l}}{{\\scriptsize {esc_latex(t['notes'])}}}")
                L.append("\\end{tabular}\\end{table}\n")
            li = run.get("llmInterpretation") or ""
            if li:
                li = li.replace("\\", "").replace("\n\n", "\n")
                # 只取 text 部分(json string 时解析)
                try:
                    obj = json.loads(li)
                    if isinstance(obj, dict) and obj.get("summary"):
                        li = f"总评: {obj.get('summary')}"
                except Exception:
                    pass
                L.append(f"\\noindent\\textbf{{LLM 解读:}} {esc_latex(li[:1500])}\n")

    # 图表
    if fig_dir and fig_dir.exists():
        pngs = sorted(fig_dir.glob("*.png"))
        if pngs:
            L.append("\\section*{四、图表产物}")
            for p in pngs:
                L.append(f"\\begin{{figure}}[htbp]\\centering")
                L.append(f"\\includegraphics[width=0.8\\linewidth]{{{p.name}}}")
                L.append(f"\\caption{{{esc_latex(p.stem)}}}")
                L.append("\\end{figure}")
    L.append("\\end{document}")
    return "\n".join(L)

# ─────────── Word 报告 ───────────
def build_docx(path):
    from docx import Document
    from docx.shared import Pt, Inches, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    doc = Document()
    # 标题
    h = doc.add_heading("问卷实证分析全套报告", 0)
    h.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p = doc.add_paragraph("MarxSphere 实证工作台 · 自动生成")
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for run in (ov.get("runs") or []):
        pass
    doc.add_heading("一、问卷结构", level=1)
    for q in (ov.get("questionnaires") or []):
        doc.add_heading(q.get("title", "问卷"), level=2)
        doc.add_paragraph(f"来源: {q.get('source','')} | 变量数: {len(q.get('columns') or [])}")
        inds = (q.get("meta") or {}).get("indicators") or []
        if inds:
            doc.add_paragraph("指标: " + "、".join(str(i) for i in inds))
    doc.add_heading("二、数据版本", level=1)
    for v in (ov.get("versions") or [])[:15]:
        doc.add_paragraph(f"{v.get('name','')} — {v.get('nRows',0)} 行 × {len(v.get('columns') or [])} 列 ({v.get('created_at','')[:16]})")
    doc.add_heading("三、分析流水线", level=1)
    for i, run in enumerate(ov.get("runs") or [], 1):
        stage = run.get("stage", "")
        doc.add_heading(f"{i}. {stage_label(stage)} ({run.get('createdAt','')[:16]})", level=2)
        for t in tables_of(run):
            cols = t.get("cols") or []
            rows = t.get("rows") or []
            if not cols or not rows:
                continue
            doc.add_paragraph(t.get("title", ""), style="Intense Quote")
            tbl = doc.add_table(rows=1 + len(rows[:40]), cols=len(cols))
            tbl.style = "Light Grid Accent 1"
            for ci, c in enumerate(cols):
                tbl.rows[0].cells[ci].text = str(c)
            for ri, r in enumerate(rows[:40], 1):
                for ci, v in enumerate(r):
                    if ci < len(cols):
                        tbl.rows[ri].cells[ci].text = str(v)
            if len(rows) > 40:
                doc.add_paragraph(f"… 仅显示前 40 行, 共 {len(rows)} 行")
            doc.add_paragraph("")  # 表后空行
        li = run.get("llmInterpretation") or ""
        try:
            obj = json.loads(li)
            if isinstance(obj, dict):
                summ = obj.get("summary", "")
                recs = obj.get("recommendations") or []
                li_txt = f"总评: {summ}"
                if recs:
                    li_txt += "\n建议: " + "; ".join(str(x) for x in recs)
                li = li_txt
        except Exception:
            li = li.replace('"', "").replace("{", "").replace("}", "")
        if li:
            doc.add_paragraph("LLM 解读: " + li)
    # 图表
    if fig_dir and fig_dir.exists():
        pngs = sorted(fig_dir.glob("*.png"))
        if pngs:
            doc.add_heading("四、图表产物", level=1)
            for p in pngs:
                try:
                    doc.add_picture(str(p), width=Inches(5.8))
                    doc.add_paragraph(p.stem).alignment = WD_ALIGN_PARAGRAPH.CENTER
                except Exception:
                    pass
    doc.save(path)

# ─────────── 主流程 ───────────
files = []
tex = build_latex()
tex_path = out_dir / f"report_{ov.get('projectId','project')[:8]}.tex"
tex_path.write_text(tex, encoding="utf-8")
files.append({"name": tex_path.name, "kind": "latex", "sizeKB": round(tex_path.stat().st_size / 1024, 1)})
docx_path = out_dir / f"report_{ov.get('projectId','project')[:8]}.docx"
try:
    build_docx(str(docx_path))
    files.append({"name": docx_path.name, "kind": "docx", "sizeKB": round(docx_path.stat().st_size / 1024, 1)})
except Exception as e:
    pass
json.dump({"ok": True, "meta": {"files": files, "nQuestionnaires": len(ov.get("questionnaires") or []),
          "nVersions": len(ov.get("versions") or []), "nRuns": len(ov.get("runs") or [])}},
          open(task_dir / "result.json", "w", encoding="utf-8"), ensure_ascii=False)
print("export ok:", files)
