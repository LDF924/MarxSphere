#!/usr/bin/env python3
"""format-check-cli.py — 论文格式检查统一 CLI(MarxSphere 后端子进程调用)

整合 MIT 开源项目(合规署名见 THIRD_PARTY_NOTICES.md):
- thesis-format-checker(emptyinkpot, MIT): docx 样式检查器 + yaml 规则
- thesis-format-fixer(kankanliuyi-lgtm, MIT): 模板规则提取
- china-thesis-docx-formatter(keyingshuzhi, MIT): 模板分析/文档格式化

子命令:
  inspect <docx> [--preset ncwu|yaml]        # 样式+内容检查, JSON findings
  extract-template <template.docx>           # 提取模板规则 JSON
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def cmd_inspect(argv: list[str]) -> int:
    """检查 docx 样式级: 复用 thesis-format-checker 的 docx_inspector + rules(纯 python-docx, 无 pandoc)。
    内容级文本由调用方另行提取交给 TS 引擎处理。"""
    import sys as _sys
    _sys.path.insert(0, str(HERE / "thesis_format_checker"))
    from thesis_format_checker.checker import load_preset
    from thesis_format_checker.docx_inspector import inspect as docx_inspect
    from thesis_format_checker.standard.rules import evaluate_all
    from thesis_format_checker.content_inspector import ContentResult

    docx = argv[0] if argv else ""
    preset_name = "ncwu"
    if "--preset" in argv:
        preset_name = argv[argv.index("--preset") + 1]

    if not docx or not Path(docx).exists():
        print(json.dumps({"ok": False, "error": f"DOCX not found: {docx}"}, ensure_ascii=False))
        return 1
    try:
        preset = load_preset(preset_name)
        docx_result = docx_inspect(Path(docx))
        # 内容级检查依赖 pandoc 文本提取 — 以空 ContentResult 兜底(纯样式规则正常跑,
        # 摘要/目录类规则因 0/False 值自然跳过); 内容级语义检测由 TS 引擎承担
        empty_content = ContentResult()
        findings = evaluate_all(docx_result, empty_content, preset)
        # 参考改写规则(无许可项目功能自写实现, 见 docx_extra_rules.py)
        _sys.path.insert(0, str(HERE))
        from docx_extra_rules import run_extra_rules
        findings += run_extra_rules(Path(docx), preset)
        out = {
            "ok": True,
            "preset": preset.get("name", preset_name),
            "findings": [f.__dict__ for f in findings],
            "stats": {
                "errors": sum(1 for f in findings if f.severity == "error"),
                "warnings": sum(1 for f in findings if f.severity == "warning"),
                "infos": sum(1 for f in findings if f.severity == "info"),
            },
            "docx_summary": {
                "sections": len(docx_result.sections) if docx_result.sections else 0,
                "paragraphs": len(docx_result.paragraphs) if docx_result.paragraphs else 0,
            },
        }
        print(json.dumps(out, ensure_ascii=False, default=str))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:500]}, ensure_ascii=False))
        return 1


def cmd_extract_text(argv: list[str]) -> int:
    """提取 docx 纯文本(标题结构保留行) — 供 TS 规则引擎做内容级检测。"""
    docx = argv[0] if argv else ""
    if not docx or not Path(docx).exists():
        print(json.dumps({"ok": False, "error": f"DOCX not found: {docx}"}, ensure_ascii=False))
        return 1
    try:
        from docx import Document
        d = Document(docx)
        lines: list[str] = []
        for p in d.paragraphs:
            t = (p.text or "").strip()
            if not t:
                continue
            style = (p.style.name if p.style is not None else "") or ""
            # 标题样式 → 保留原样(引擎行级识别), 正文归一
            if "Heading" in style or "标题" in style or "Title" in style:
                lines.append(t)
            else:
                lines.append(t)
        text = "\n".join(lines)
        print(json.dumps({"ok": True, "chars": len(text), "text": text[:80000]}, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:500]}, ensure_ascii=False))
        return 1


def cmd_extract(argv: list[str]) -> int:
    """提取学校模板规则 JSON(复用 thesis-format-fixer + china-thesis analyze_docx)。"""
    template = argv[0] if argv else ""
    out_path = argv[argv.index("--output") + 1] if "--output" in argv else "template-rules.json"
    if not template or not Path(template).exists():
        print(json.dumps({"ok": False, "error": f"Template not found: {template}"}, ensure_ascii=False))
        return 1
    try:
        # 优先 china-thesis 的 docx_rules(成熟 JSON 输出)
        sys.path.insert(0, str(HERE / "china-thesis" / "scripts"))
        from docx_rules import extract_rules, write_rules
        from docx import Document
        rules = extract_rules(Document(template), Path(template).name, "master")
        write_rules(rules, out_path)
        print(json.dumps({
            "ok": True,
            "output": out_path,
            "styles": len(rules.get("styles", [])),
            "warnings": rules.get("extraction_warnings", []),
        }, ensure_ascii=False, default=str))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:500]}, ensure_ascii=False))
        return 1




def cmd_format(argv: list[str]) -> int:
    """自动格式化 docx: 复用 paper_format_agent(zxyasfas, MIT, 内容指纹保护)。
    用法: format <paper.docx> [--format-file <规则.md/docx>] [--out-dir <dir>]
    无 --format-file 时使用算法内置默认规则(本科论文格式 V3)。"""
    sys.path.insert(0, str(HERE))
    from paper_format_agent.rules import extract_rules_from_text
    from paper_format_agent.service import format_paper

    paper = argv[0] if argv else ""
    fmt_file = argv[argv.index("--format-file") + 1] if "--format-file" in argv else None
    out_dir = argv[argv.index("--out-dir") + 1] if "--out-dir" in argv else "formatted-out"
    if not paper or not Path(paper).exists():
        print(json.dumps({"ok": False, "error": f"paper not found: {paper}"}, ensure_ascii=False))
        return 1
    try:
        out_path = Path(out_dir)
        out_path.mkdir(parents=True, exist_ok=True)
        # 无格式指南时用内置默认规则(避免 format_paper 因 rules/format_file 全空报错)
        rules = None
        if fmt_file:
            result = format_paper(
                Path(paper),
                out_path,
                format_file=Path(fmt_file),
                allow_content_change=False,  # 内容指纹保护: 改动正文即失败
            )
        else:
            result = format_paper(
                Path(paper),
                out_path,
                rules=extract_rules_from_text(),
                allow_content_change=False,  # 内容指纹保护: 改动正文即失败
            )
        print(json.dumps({"ok": True, "result": str(result)[:300]}, ensure_ascii=False, default=str))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:500]}, ensure_ascii=False))
        return 1


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    argv = sys.argv[2:]
    if cmd == "inspect":
        return cmd_inspect(argv)
    if cmd == "extract-text":
        return cmd_extract_text(argv)
    if cmd == "extract-template":
        return cmd_extract(argv)
    if cmd == "format":
        return cmd_format(argv)
    print(json.dumps({"ok": False, "error": f"Unknown command: {cmd}"}, ensure_ascii=False))
    return 1



if __name__ == "__main__":
    raise SystemExit(main())
