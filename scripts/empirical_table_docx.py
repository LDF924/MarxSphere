#!/usr/bin/env python3
# empirical_table_docx.py — C4(闭源 StatisticsView 三线表 Word 导出对齐)
# 输入: task_dir/input.json { table: {title, cols, rows, notes} }
# 输出: task_dir/table_<ts>.docx (三线表: 表头上下粗边框, 首列与数据 Times New Roman,
#   尾行下边框; 表头 SimSun bold 10pt, 标题 SimHei, 页边距 1440 twips)
import json
import sys
from pathlib import Path

task_dir = Path(sys.argv[1])
inp = json.load(open(task_dir / "input.json", encoding="utf-8"))
table = inp.get("table") or {}
title = table.get("title", "分析结果")
cols = table.get("cols") or []
rows = table.get("rows") or []
notes = table.get("notes") or ""

from docx import Document
from docx.shared import Pt, Cm, Twips
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

doc = Document()
sec = doc.sections[0]
sec.top_margin = Twips(1440)
sec.bottom_margin = Twips(1440)
sec.left_margin = Twips(1440)
sec.right_margin = Twips(1440)

# 标题(SimHei 居中 16pt)
h = doc.add_paragraph()
h.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = h.add_run(title)
run.font.name = "SimHei"
run._element.rPr.rFonts.set(qn("w:eastAsia"), "SimHei")
run.font.size = Pt(16)
run.bold = True

# 辅助: 给段落/表格边框
def set_border(tbl_or_row, edges, sz=12):
    """edges: list of (where, sz, val) where in ('top','bottom')"""
    tblPr = tbl_or_row._tbl.tblPr if hasattr(tbl_or_row, "_tbl") else tbl_or_row._tr.get_or_add_trPr()
    borders = tblPr.find(qn("w:tblBorders"))
    if borders is None and hasattr(tbl_or_row, "_tbl"):
        borders = OxmlElement("w:tblBorders")
        tblPr.append(borders)
    for where, val in edges:
        el = OxmlElement(f"w:{where}")
        el.set(qn("w:val"), val)
        el.set(qn("w:sz"), str(sz))
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "000000")
        if borders is not None:
            borders.append(el)

def cell_text(cell, text, bold=False, font="Times New Roman", size=10, align=None):
    cell.text = ""
    p = cell.paragraphs[0]
    r = p.add_run(str(text))
    r.font.name = font
    r._element.rPr.rFonts.set(qn("w:eastAsia"), "SimSun" if font == "SimSun" else font)
    r.font.size = Pt(size)
    r.bold = bold
    if align:
        p.alignment = align

# 表(表头 + 数据)
ncol = len(cols)
tbl = doc.add_table(rows=1 + len(rows[:200]), cols=ncol)
# 表格整体无左右竖边框: 用单行边框控制 — python-docx 表格默认样式替换为无边框
tbl.style = "Table Grid"
# 清除全部边框, 仅手动加表头上下粗线+尾行下线(三线表)
# 表头行: 上边框 12(1.5pt 粗) + 下边框 6(0.75pt)
header_row = tbl.rows[0]
# 先去掉 Table Grid 自带全边框
for r_ in tbl.rows:
    for c_ in r_.cells:
        tcPr = c_._tc.get_or_add_tcPr()
        tcB = OxmlElement("w:tcBorders")
        for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
            e = OxmlElement(f"w:{edge}")
            e.set(qn("w:val"), "nil")
            tcB.append(e)
        tcPr.append(tcB)

for ci, c in enumerate(cols):
    cell_text(header_row.cells[ci], c, bold=True, font="SimSun", size=10,
              align=WD_ALIGN_PARAGRAPH.CENTER)

for ri, r in enumerate(rows[:200], 1):
    for ci, v in enumerate(r):
        if ci < ncol:
            cell_text(tbl.rows[ri].cells[ci], v, font="Times New Roman", size=10,
                      align=None if ci > 0 else WD_ALIGN_PARAGRAPH.LEFT)

# 三线: 表头行上边线粗、下边线细, 表体末行下边线粗
def row_edges(row, edges):
    for c_ in row.cells:
        tcPr = c_._tc.get_or_add_tcPr()
        tcB = tcPr.find(qn("w:tcBorders"))
        if tcB is None:
            tcB = OxmlElement("w:tcBorders")
            tcPr.append(tcB)
        for where, sz, val in edges:
            el = OxmlElement(f"w:{where}")
            el.set(qn("w:val"), val)
            el.set(qn("w:sz"), str(sz))
            el.set(qn("w:space"), "0")
            el.set(qn("w:color"), "000000")
            tcB.append(el)

row_edges(tbl.rows[0], [("top", 12, "single"), ("bottom", 6, "single")])
last = tbl.rows[-1]
row_edges(last, [("bottom", 12, "single")])

# 注(斜体小字)
if notes:
    p = doc.add_paragraph()
    r = p.add_run(f"注: {notes}")
    r.italic = True
    r.font.size = Pt(9)
    r.font.name = "Times New Roman"

# 输出
out = task_dir / "table.docx"
doc.save(str(out))
json.dump({"ok": True, "file": out.name, "nRows": len(rows), "nCols": ncol},
          open(task_dir / "result.json", "w", encoding="utf-8"), ensure_ascii=False)
print("table docx ok:", out.name)
