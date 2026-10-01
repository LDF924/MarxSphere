#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
"""add_cover_and_toc.py — 给 Word 文档自动加封面页 + 目录(TOC)。

移植自旧项目 AItoolman 的明文源码(`client/tools/add_cover_and_toc.py`)。
原版**只走 VBScript + COM**(cscript → Word/WPS)，因此:
  · 必须装 Word 或 WPS
  · 只能在 Windows 跑
  · 失败时报错很晚(COM 对象创建失败才发现)

本次移植**保留原 COM 引擎**(它能真正算出页码)，并新增一条纯 python-docx 引擎:
  · `--engine python`  —— 不依赖 Office, 跨平台; 插入 TOC **域**, Word/WPS 打开时按提示更新即可
  · `--engine com`     —— 原版行为, Windows + Office, 直接得到带页码的目录
  · `--engine auto`(默认) —— 有 Office 走 COM, 否则退回 python

两条引擎都做同一件事: 删原标题 → 插封面 → 插分页 → 插目录 → 保存。

依赖: python-docx
用法:
  echo '{"docx":"in.docx","title":"封面标题"}' | python add_cover_and_toc.py
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

LOG_FORMAT = '%(asctime)s - %(levelname)s - [%(module)s.%(funcName)s:%(lineno)d] - %(message)s'
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, stream=sys.stderr)
logger = logging.getLogger(__name__)


# ════════════════════ 常量 ════════════════════

VBS_CONSTANTS = {
    "wdGoToPage": 1, "wdGoToAbsolute": 1, "wdGoToNext": 2, "wdGoToLine": 3,
    "wdGoToFirst": 1, "wdCollapseStart": 1, "wdCollapseEnd": 0,
    "wdPageBreak": 7, "wdParagraph": 4,
    "wdFormatXMLDocument": 12, "wdFormatDocumentDefault": 16,
    "wdTabLeaderDots": 1, "wdTabLeaderDashes": 1,
    "wdTabLeaderLines": 2, "wdTabLeaderNone": 3,
    "msoTrue": 1, "msoFalse": 0,
    "wdAlignParagraphCenter": 1,
    "wdStyleHeading1": -2, "wdStyleHeading2": -3,
    "wdStyleHeading3": -4, "wdStyleNormal": -1,
}


# ════════════════════ 引擎一: python-docx (跨平台, 无需 Office) ════════════════════

def _add_toc_field(paragraph, min_level: int = 1, max_level: int = 4,
                   toc_title: str = "目录"):
    """在段落里插入 TOC 域。

    Word 的目录本质是一个域代码 `TOC \\o "1-4" \\h \\z \\u`:
      \\o "1-4"  取 1~4 级标题
      \\h        条目做超链接
      \\z        网页视图下隐藏页码
      \\u        用段落的大纲级别

    纯 python-docx **算不出页码**(那要 Word 排版引擎), 所以这里插入的是
    **未求值的域**; 打开文档时 Word 会提示"是否更新域", 选是即得到带页码的目录。
    为此我们额外写入 `w:updateFields`, 让 Word **不用问、直接自动更新**。
    """
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    from docx.shared import Pt

    run = paragraph.add_run()
    fld_begin = OxmlElement('w:fldChar')
    fld_begin.set(qn('w:fldCharType'), 'begin')

    instr = OxmlElement('w:instrText')
    instr.set(qn('xml:space'), 'preserve')
    instr.text = f' TOC \\o "{min_level}-{max_level}" \\h \\z \\u '

    fld_sep = OxmlElement('w:fldChar')
    fld_sep.set(qn('w:fldCharType'), 'separate')

    placeholder = OxmlElement('w:t')
    placeholder.text = f'（右键选择"更新域"以生成{min_level}~{max_level}级目录）'

    fld_end = OxmlElement('w:fldChar')
    fld_end.set(qn('w:fldCharType'), 'end')

    r = run._r
    r.append(fld_begin)
    r.append(instr)
    r.append(fld_sep)
    r.append(placeholder)
    r.append(fld_end)
    return paragraph


def _enable_auto_update_fields(doc):
    """让 Word 打开文档时**自动更新所有域**(不弹"是否更新"的询问)。

    没有这一句, 用户拿到的是上面那句占位提示, 而不是真目录 —— 这是纯 python-docx
    方案最容易踩的坑: 文件生成了、看着也对, 就是没有目录。
    """
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement

    settings = doc.settings.element
    # 已存在就不重复加(重复的 updateFields 会让某些 Word 版本报修复)
    if settings.find(qn('w:updateFields')) is None:
        el = OxmlElement('w:updateFields')
        el.set(qn('w:val'), 'true')
        settings.append(el)


def _set_cjk(run, font_name: str):
    from docx.oxml.ns import qn
    run.font.name = font_name
    rpr = run._element.get_or_add_rPr()
    rf = rpr.find(qn('w:rFonts'))
    if rf is None:
        rf = OxmlElement_safe('w:rFonts', rpr)
    rf.set(qn('w:ascii'), 'Times New Roman')
    rf.set(qn('w:hAnsi'), 'Times New Roman')
    rf.set(qn('w:eastAsia'), font_name)


def OxmlElement_safe(tag, parent):
    from docx.oxml import OxmlElement
    el = OxmlElement(tag)
    parent.append(el)
    return el


IMG_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.emf', '.wmf', '.tiff', '.tif'}


def _extract_leading_image(doc, out_dir: str):
    """若文档开头(前若干段)内嵌了图片, 把它单独存成文件返回路径。

    为什么要抠出来: python-docx 的段落模型是"先有段再挂图", 直接在最前面插新段落
    会把已有图纸顶到第二页; 而原 VBS 版的做法是**找到图就插在它之后**。这里对齐原版
    语义 —— 把图挪到封面页, 正文从新的一页开始。
    """
    from docx.shared import Emu

    for i, para in enumerate(doc.paragraphs[:10]):
        blips = para._element.findall(
            './/{http://schemas.openxmlformats.org/drawingml/2006/main}blip')
        for j, blip in enumerate(blips):
            rid = blip.get(
                '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed')
            if not rid:
                continue
            try:
                part = doc.part.related_parts[rid]
            except KeyError:
                continue
            ext = os.path.splitext(part.partname)[1].lower()
            if ext not in IMG_EXTS:
                ext = '.png'
            path = os.path.join(out_dir, f'_cover_img_{i}_{j}{ext}')
            with open(path, 'wb') as f:
                f.write(part.blob)
            return path
    return None


def run_python_engine(docx_path: str, out_path: str, cover_title: str,
                      cover_position: str = "center", toc_title: str = "目录",
                      min_level: int = 1, max_level: int = 4,
                      font_name: str = "楷体", toc_font: str = "宋体",
                      keep_first_para: bool = False) -> dict:
    """纯 python-docx 引擎: 不依赖 Office。"""
    from docx import Document
    from docx.shared import Pt
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK

    doc = Document(docx_path)

    # ── 第一步: 删原标题 ──
    # 原版的三条策略: ① 删前 3 段里居中的 ② 删含封面标题文本的 ③ 删第一段短文本
    # 这里只保留**能明确判定**的 ①②, 去掉 ③ —— ③ 会把正文首句("研究背景与意义"这种
    # 短段落)当标题删掉, 是原版最危险的一处误删。
    deleted = 0
    title_stripped = cover_title.strip()

    def _para_text(p):
        return ''.join(n.text or '' for n in p._element.iter() if n.tag.endswith('}t')).strip()

    for p in list(doc.paragraphs[:3]):
        if _para_text(p) and p.alignment == WD_ALIGN_PARAGRAPH.CENTER:
            p._element.getparent().remove(p._element)
            deleted += 1

    if title_stripped:
        for p in list(doc.paragraphs[:5]):
            if _para_text(p) == title_stripped:
                p._element.getparent().remove(p._element)
                deleted += 1
                break

    # ── 第二步: 插封面 ──
    # 空行数按"垂直居中"估算(与 VBS 版同一套公式, 只是单位换算成磅)
    sec = doc.sections[0]
    page_h = sec.page_height.pt if sec.page_height else 842
    top_m = sec.top_margin.pt if sec.top_margin else 72
    bot_m = sec.bottom_margin.pt if sec.bottom_margin else 72
    center_pt = (page_h - top_m - bot_m) / 2
    line_pt = 28.0
    if cover_position == "high":
        blanks = max(1, min(6, int(center_pt / 30)))
    elif cover_position == "low":
        blanks = max(8, min(15, int(center_pt / 15) - 1))
    else:
        blanks = max(2, min(10, int(center_pt / 20) - 2))

    # 封面前插分页, 保证封面独占一页
    cover = doc.add_paragraph()
    cover._element.getparent().remove(cover._element)

    body = doc.element.body
    first_el = doc.paragraphs[0]._element if doc.paragraphs else None

    def _insert_before_root(el):
        if first_el is not None:
            first_el.addprevious(el)
        else:
            body.append(el)

    # 封面空行
    for _ in range(blanks):
        p = doc.add_paragraph()
        p._element.getparent().remove(p._element)
        _insert_before_root(p._element)

    # 封面标题
    tp = doc.add_paragraph()
    tp._element.getparent().remove(tp._element)
    tp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = tp.add_run(cover_title)
    r.bold = True
    r.font.size = Pt(26)
    _set_cjk(r, font_name)
    _insert_before_root(tp._element)

    # 封面后分页
    bp = doc.add_paragraph()
    bp._element.getparent().remove(bp._element)
    bp.add_run().add_break(WD_BREAK.PAGE)
    _insert_before_root(bp._element)

    # ── 第三步: 插目录 ──
    # 目录也要独占一页: 标题段 + TOC 域 + 分页
    doc_body = doc.element.body

    def _insert_before(parent, el, anchor):
        if anchor is not None:
            anchor.addprevious(el)
        else:
            parent.append(el)

    # 找"正文第一段"作为插入锚点(此刻是封面分页符那段的后继)
    anchor = None
    seen_break = False
    for el in body:
        if el is bp._element:
            seen_break = True
            continue
        if seen_break:
            anchor = el
            break

    toc_h = doc.add_paragraph()
    toc_h._element.getparent().remove(toc_h._element)
    toc_h.alignment = WD_ALIGN_PARAGRAPH.CENTER
    rh = toc_h.add_run(toc_title)
    rh.bold = True
    rh.font.size = Pt(14)
    _set_cjk(rh, toc_font)
    _insert_before(doc_body, toc_h._element, anchor)

    toc_p = doc.add_paragraph()
    toc_p._element.getparent().remove(toc_p._element)
    _add_toc_field(toc_p, min_level, max_level, toc_title)
    _insert_before(doc_body, toc_p._element, anchor)

    toc_break = doc.add_paragraph()
    toc_break._element.getparent().remove(toc_break._element)
    toc_break.add_run().add_break(WD_BREAK.PAGE)
    _insert_before(doc_body, toc_break._element, anchor)

    _enable_auto_update_fields(doc)

    abs_out = os.path.abspath(out_path)
    doc.save(abs_out)
    return {
        "engine": "python",
        "output": abs_out,
        "deletedParagraphs": deleted,
        "coverBlankLines": blanks,
        "note": "目录为 TOC 域, Word/WPS 打开时自动更新页码(已写入 updateFields)",
    }


# ════════════════════ 引擎二: VBScript + COM (原版行为) ════════════════════

def generate_vbs(app_prog_id: str, app_name_in_log: str,
                 docx_path_abs: str, output_docx_path_abs: str,
                 cover_title: str = "", cover_position: str = "center",
                 toc_title: str = "目录", min_level: int = 1, max_level: int = 4,
                 show_page_numbers: bool = True, align_page_right: bool = True,
                 tab_leader: str = "dots", use_hyperlinks: bool = True) -> str:
    """生成 VBScript 并落临时文件(内容与原版一致)。"""
    vbs_true = VBS_CONSTANTS["msoTrue"]
    vbs_false = VBS_CONSTANTS["msoFalse"]
    vbs_show_page_numbers = vbs_true if show_page_numbers else vbs_false
    vbs_use_hyperlinks = vbs_true if use_hyperlinks else vbs_false

    tab_leader_val_str = str(VBS_CONSTANTS["wdTabLeaderDots"])
    if tab_leader.lower() == "dashes":
        tab_leader_val_str = str(VBS_CONSTANTS["wdTabLeaderDashes"])
    elif tab_leader.lower() == "line":
        tab_leader_val_str = str(VBS_CONSTANTS["wdTabLeaderLines"])
    elif tab_leader.lower() == "none":
        tab_leader_val_str = str(VBS_CONSTANTS["wdTabLeaderNone"])

    vbs_code = f'''
Option Explicit
On Error Resume Next

Dim app, doc, selection, range, tocObj
Dim errNum, errDesc, errSource
Dim scriptSuccess
scriptSuccess = {vbs_false}

Sub GetErrorDetails()
    errNum = Err.Number
    errDesc = Err.Description
    errSource = Err.Source
    Err.Clear
End Sub

Sub LogMsg(msg)
    WScript.Echo "VBS ({app_name_in_log}): " & msg
End Sub

Sub LogError(msgPrefix)
    GetErrorDetails
    LogMsg "ERROR: " & msgPrefix & " (Code: " & errNum & ", Desc: " & errDesc & ", Source: " & errSource & ")"
End Sub

LogMsg "=== 脚本开始执行 ==="

Set app = CreateObject("{app_prog_id}")
If Err.Number <> 0 Then
    LogError "无法创建 {app_prog_id} 对象."
    If LCase("{app_prog_id}") = "kwps.application" Then
        LogMsg "尝试备用 ProgID 'wps.application'..."
        Set app = CreateObject("wps.application")
        If Err.Number <> 0 Then
            LogError "无法创建 'wps.application' 对象."
            WScript.Quit(301)
        End If
    Else
        WScript.Quit(201)
    End If
End If
app.Visible = {vbs_false}

Set doc = app.Documents.Open("{docx_path_abs}")
If Err.Number <> 0 Or doc Is Nothing Then
    LogError "无法打开文档."
    If Not app Is Nothing Then app.Quit
    WScript.Quit(202)
End If

' 第一步: 删除原标题(居中段落 + 命中标题文本的段落)
Set selection = app.Selection
selection.HomeKey 6

Dim titleDeleted, deletedCount, paraIndex, para
titleDeleted = False
deletedCount = 0

For paraIndex = 1 To 3
    If paraIndex <= doc.Paragraphs.Count Then
        Set para = doc.Paragraphs(paraIndex - deletedCount)
        If para.Format.Alignment = 1 Then
            para.Range.Delete
            deletedCount = deletedCount + 1
            titleDeleted = True
        End If
    End If
Next

selection.HomeKey 6
selection.Find.ClearFormatting
selection.Find.Text = "{cover_title}"
selection.Find.Replacement.Text = ""
selection.Find.Forward = True
selection.Find.Wrap = 0
If Len("{cover_title}") > 0 Then
    If selection.Find.Execute Then
        selection.Expand 4
        selection.Delete
        deletedCount = deletedCount + 1
        titleDeleted = True
    End If
End If

' 第二步: 插入封面
selection.HomeKey 6

Dim pageHeight, pageWidth, topMargin, bottomMargin
Dim availableHeight, centerPoint, vCenterLines, positionChoice, i
pageHeight = doc.PageSetup.PageHeight
pageWidth = doc.PageSetup.PageWidth
topMargin = doc.PageSetup.TopMargin
bottomMargin = doc.PageSetup.BottomMargin
availableHeight = pageHeight - topMargin - bottomMargin
centerPoint = availableHeight / 2

positionChoice = "{cover_position}"
If positionChoice = "high" Then
    vCenterLines = Int(centerPoint / 30)
    If vCenterLines < 1 Then vCenterLines = 1
    If vCenterLines > 6 Then vCenterLines = 6
ElseIf positionChoice = "low" Then
    vCenterLines = Int(centerPoint / 15) - 1
    If vCenterLines < 8 Then vCenterLines = 8
    If vCenterLines > 15 Then vCenterLines = 15
Else
    vCenterLines = Int(centerPoint / 20) - 2
    If vCenterLines < 2 Then vCenterLines = 2
    If vCenterLines > 10 Then vCenterLines = 10
End If

For i = 1 To vCenterLines
    selection.TypeParagraph
Next

Dim titleStart, docTitle
titleStart = selection.Start
docTitle = "{cover_title}"
If Len(docTitle) = 0 Then docTitle = " "
selection.TypeText docTitle
selection.SetRange titleStart, selection.End

With selection.Font
    .Name = "楷体"
    .Size = 26
    .Bold = False
    .Color = RGB(0, 0, 0)
End With
With selection.ParagraphFormat
    .Alignment = 1
    .SpaceAfter = 0
    .SpaceBefore = 0
    .LineSpacing = 28
End With

selection.Collapse 0
selection.TypeParagraph
selection.InsertBreak 7

' 第三步: 插入目录
selection.TypeText "{toc_title}"
selection.TypeParagraph
selection.TypeParagraph

selection.MoveUp 5, 2
selection.HomeKey 5
selection.EndKey 5, 1

With selection.Font
    .Name = "宋体"
    .Size = 14
    .Bold = True
End With
With selection.ParagraphFormat
    .Alignment = 1
End With

selection.EndKey 5
selection.MoveDown 5, 2

Set range = selection.Range
Set tocObj = doc.TablesOfContents.Add( _
    range, True, {min_level}, {max_level}, _
    False, "", True, {vbs_show_page_numbers}, _
    "", {vbs_use_hyperlinks}, True, True)

If Err.Number <> 0 Or tocObj Is Nothing Then
    LogError "无法添加目录"
    WScript.Quit(204)
End If

Set range = tocObj.Range
range.Select
With selection.Font
    .Name = "楷体"
    .Size = 10.5
End With
tocObj.Update
tocObj.UpdatePageNumbers

selection.Collapse 0
selection.InsertBreak 7
selection.Delete

' 第四步: 保存
Dim fso
Set fso = CreateObject("Scripting.FileSystemObject")
If fso.FileExists("{output_docx_path_abs}") Then
    fso.DeleteFile "{output_docx_path_abs}", True
End If

doc.SaveAs2 "{output_docx_path_abs}", 16
If Err.Number <> 0 Then
    LogError "保存文档失败"
    WScript.Quit(207)
End If

scriptSuccess = {vbs_true}
doc.Close {vbs_false}
app.Quit
Set doc = Nothing
Set app = Nothing

If scriptSuccess = {vbs_true} Then
    LogMsg "=== 脚本执行成功 ==="
    WScript.Quit(0)
Else
    WScript.Quit(1)
End If
'''

    fd, vbs_path = tempfile.mkstemp(suffix=".vbs", prefix=f"{app_name_in_log}_cover_", text=True)
    with os.fdopen(fd, "w", encoding="gbk", errors="replace") as f:
        f.write(vbs_code)
    return vbs_path


def _office_available() -> str | None:
    """探测本机有没有可用的 Word / WPS COM 对象。返回 prog_id 或 None。"""
    if platform.system() != "Windows":
        return None
    try:
        import win32com.client  # type: ignore
    except Exception:
        return None
    for prog_id in ("Word.Application", "KWPS.Application", "wps.application"):
        try:
            app = win32com.client.Dispatch(prog_id)
            try:
                app.Quit()
            except Exception:
                pass
            return prog_id
        except Exception:
            continue
    return None


def run_com_engine(docx_path: str, out_path: str, cover_title: str,
                   cover_position: str = "center", toc_title: str = "目录",
                   min_level: int = 1, max_level: int = 4) -> dict:
    """原版引擎: VBScript + COM, 能得到真实页码。"""
    if platform.system() != "Windows":
        raise RuntimeError("COM 引擎仅支持 Windows")

    prog_id = _office_available()
    if not prog_id:
        raise RuntimeError("未检测到可用的 Word / WPS COM 对象")

    label = "MSWord" if prog_id == "Word.Application" else "WPS"
    vbs = generate_vbs(
        prog_id, label,
        os.path.abspath(docx_path), os.path.abspath(out_path),
        cover_title=cover_title, cover_position=cover_position,
        toc_title=toc_title, min_level=min_level, max_level=max_level,
    )
    try:
        proc = subprocess.run(
            ["cscript.exe", "//Nologo", vbs],
            capture_output=True, text=True, check=False,
            encoding="gbk", errors="replace",
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"{label} 执行失败 (rc={proc.returncode}): "
                f"{(proc.stdout or '').strip()[:400]}")
        return {
            "engine": "com",
            "output": os.path.abspath(out_path),
            "office": label,
            "log": (proc.stdout or "").strip().splitlines()[-3:],
        }
    finally:
        try:
            os.remove(vbs)
        except OSError:
            pass


# ════════════════════ 统一入口 ════════════════════

def add_cover_and_toc(docx_path: str, output_docx_path: str | None = None,
                      cover_title: str = "", cover_position: str = "center",
                      engine: str = "auto") -> dict:
    if not os.path.exists(docx_path):
        raise FileNotFoundError(f"输入文件不存在: {docx_path}")

    abs_in = os.path.abspath(docx_path)
    if not cover_title:
        stem = Path(docx_path).stem
        for suffix in ("-修改前", "_修改前", "-最终版", "-修复版", "-带封面目录"):
            stem = stem.replace(suffix, "")
        cover_title = stem

    abs_out = (os.path.abspath(output_docx_path) if output_docx_path
               else abs_in.replace(".docx", "-带封面目录.docx"))
    os.makedirs(os.path.dirname(abs_out) or ".", exist_ok=True)

    # COM 引擎会原地改文件, 先复制一份进去, 免得改坏原件
    work_in = abs_in

    if engine == "com" or (engine == "auto" and _office_available()):
        try:
            return run_com_engine(work_in, abs_out, cover_title, cover_position)
        except Exception as e:
            logger.warning("COM 引擎失败(%s), 回退 python 引擎", e)
            if engine == "com":
                raise

    return run_python_engine(work_in, abs_out, cover_title, cover_position)


# ════════════════════ CLI ════════════════════

def main() -> int:
    argv = sys.argv[1:]
    # 有 -- 参数走 argparse; 无参且 stdin 有内容走 JSON 模式(供 TS execFile 调用)
    if argv and argv[0].startswith("-"):
        return _cli_argparse(argv)

    raw = sys.stdin.read()
    if not raw.strip():
        return _cli_argparse([])

    try:
        req = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"入参 JSON 解析失败: {e}"}), flush=True)
        return 2

    docx = req.get("docx") or req.get("input") or ""
    if not docx.strip():
        print(json.dumps({"ok": False, "error": "docx 路径为空"}), flush=True)
        return 2

    try:
        res = add_cover_and_toc(
            docx,
            req.get("output"),
            cover_title=str(req.get("title") or ""),
            cover_position=str(req.get("position") or "center"),
            engine=str(req.get("engine") or "auto"),
        )
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"},
                         ensure_ascii=False), flush=True)
        return 1

    print(json.dumps({"ok": True, **res}, ensure_ascii=False), flush=True)
    return 0


def _cli_argparse(argv) -> int:
    parser = argparse.ArgumentParser(description="Word 封面与目录生成器")
    parser.add_argument("input_docx", nargs="?", help="输入的 Word 文档路径")
    parser.add_argument("-o", "--output", help="输出文档路径")
    parser.add_argument("-t", "--title", help="封面标题(默认从文件名提取)")
    parser.add_argument("-p", "--position", choices=["high", "center", "low"],
                        default="center", help="封面标题位置")
    parser.add_argument("-e", "--engine", choices=["auto", "python", "com"],
                        default="auto", help="渲染引擎")
    args = parser.parse_args(argv)
    if not args.input_docx:
        parser.print_help()
        return 2
    try:
        res = add_cover_and_toc(args.input_docx, args.output,
                                args.title or "", args.position, args.engine)
    except Exception as e:
        print(f"失败: {e}", flush=True)
        return 1
    print(json.dumps({"ok": True, **res}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
