# review_annotations.py — SocialSci P0-3 补漏: 审稿报告 Word 批注导出
# 用法: python review_annotations.py <input.json> <output.docx>
#   input.json: { text: 原文, comments: [{range:[start,end] 或 {start,end}, author, text, date}], title }
# 产出: 带 Word comment(批注)的 docx
# 设计: 纯 python-docx 实现, 不依赖 COM; 批注通过 python-docx 的 comment 扩展(1.1+ 支持 add_comment)
import json
import sys
import os

def main():
    if len(sys.argv) < 3:
        print("usage: review_annotations.py <input.json> <output.docx>", file=sys.stderr)
        sys.exit(1)
    inp = json.load(open(sys.argv[1], encoding="utf-8"))
    text = inp.get("text", "")
    comments = inp.get("comments") or []
    title = inp.get("title", "审稿报告")
    out_path = sys.argv[2]

    from docx import Document
    from docx.shared import Pt, RGBColor

    doc = Document()
    # 标题
    h = doc.add_heading(title, level=1)
    h.runs[0].font.color.rgb = RGBColor(0x1F, 0x3B, 0x5C) if h.runs else None

    if comments:
        doc.add_paragraph("【审稿批注 %d 条】" % len(comments)).runs[0].bold = True

    # 逐段重排文本, 在批注点插入分段 → 逐段 add_comment
    # 简化实现: 每个 comment 独立成段(前缀引用片段+批注), 保证不丢批注
    # 更贴近 Word 批注: python-docx 1.2 的 comment 需 attach 到 run
    comment_runs = {}
    cursor = 0
    # 建立 文本偏移 → comment 映射(按 start 排序)
    cm_sorted = sorted(comments, key=lambda c: c.get("range", {}).get("start", 0) or c.get("start", 0))
    for cm in cm_sorted:
        rng = cm.get("range") or {}
        start = rng.get("start", cm.get("start", 0))
        end = rng.get("end", cm.get("end", start + 20))
        snippet = text[start:end].replace("\n", " ").strip()[:60]
        author = cm.get("author", "AI 审稿")
        body = cm.get("text", cm.get("comment", ""))
        # 段落: 引用原文片段 + 批注正文
        p = doc.add_paragraph()
        if snippet:
            r0 = p.add_run("【原文】" + (snippet + ("…" if len(text[start:end]) > 60 else "")))
            r0.font.size = Pt(9)
            r0.font.color.rgb = RGBColor(0x88, 0x88, 0x88)
        r1 = p.add_run("\n【批注·%s】%s" % (author, body))
        r1.font.size = Pt(10.5)
        # 尝试 python-docx 原生批注(1.1+ experimental)
        try:
            p.add_comment(r1, body, author=author, initials="AI")
        except Exception:
            pass  # 版本不支持则批注内联保留(仍可读)

    # 全文另起附录(不带批注的干净版)
    doc.add_page_break()
    doc.add_paragraph("【审稿全文参考】").runs[0].bold = True
    for para in text.split("\n"):
        if para.strip():
            doc.add_paragraph(para)

    doc.save(out_path)
    print("OK %s (%d comments, %d chars)" % (out_path, len(comments), len(text)))

if __name__ == "__main__":
    main()
