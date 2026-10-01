#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
"""pdf_extract_figures.py — 从 PDF 里取出**内嵌位图**(2026-10-02)

由来: agent 的"产出文件"能力打通后, 做论文汇报 pptx 时最该有的素材是**论文原图**。
      而平台此前对 PDF 只有"转文本"(pdf2obsidian), **没有取图** ——
      技能 `nature-paper2ppt` 的整个主线就是"裁论文图放进幻灯片"。

═══ 为什么不直接抽所有内嵌图 ═══
    论文 PDF 里的内嵌位图混杂着: 真图表 / 期刊 logo / 页眉装饰 / 公式小图 /
    整页扫描(扫描件整页就是一张大图)。全抽出来会喂给模型一堆噪声,
    而模型没有"看出这不是图"的能力 —— 它只会照着放进去。
    所以按**像素尺寸**过滤: 太小的(图标)与整页扫描(宽高接近页面且极大)分别处理。

═══ 判据为什么用像素而非文件大小 ═══
    压缩率差异极大: 一张白色背景的复杂折线图可能只有 20KB,
    而一张噪声纹理的小图标能到 200KB。**大小判不出它是不是图**, 像素才判得出。

用法:
    python pdf_extract_figures.py <pdf路径> <输出目录> [--min-px 200] [--json out.json]
输出(最后一行): 单行 JSON —— {"ok":bool,"figures":[{"file","page","w","h","bytes"}],
                                "skipped":[{"page","w","h","reason"}]}
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("outdir")
    # 200px 是经验值: 论文里真正的图表在这之上, 期刊 logo / 装饰线在下
    ap.add_argument("--min-px", type=int, default=200)
    ap.add_argument("--max-figures", type=int, default=20)
    args = ap.parse_args()

    try:
        import fitz  # PyMuPDF
    except Exception as e:  # pragma: no cover
        print(json.dumps({"ok": False, "error": f"PyMuPDF 不可用: {e}"}, ensure_ascii=False))
        return 1

    src = Path(args.pdf)
    if not src.exists():
        print(json.dumps({"ok": False, "error": f"文件不存在: {src}"}, ensure_ascii=False))
        return 1
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    figures: list[dict] = []
    skipped: list[dict] = []
    seen_xref: set[int] = set()

    try:
        doc = fitz.open(str(src))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"打不开 PDF: {e}"}, ensure_ascii=False))
        return 1

    try:
        page_count = len(doc)
        for pno in range(page_count):
            if len(figures) >= args.max_figures:
                break
            page = doc[pno]
            # 页面尺寸(pt) — 用来识别"整页扫描"
            page_w = float(page.rect.width)
            page_h = float(page.rect.height)
            for img in page.get_images(full=True):
                xref = int(img[0])
                if xref in seen_xref:
                    continue  # 同一张图在多页复用(页眉等)只取一次
                seen_xref.add(xref)
                try:
                    pix = fitz.Pixmap(doc, xref)
                except Exception as e:
                    skipped.append({"page": pno + 1, "w": 0, "h": 0, "reason": f"读取失败: {e}"})
                    continue
                w, h = int(pix.width), int(pix.height)
                if w < args.min_px or h < args.min_px:
                    skipped.append({"page": pno + 1, "w": w, "h": h, "reason": f"小于 {args.min_px}px（图标/装饰）"})
                    continue
                # 整页扫描: 一张图几乎铺满整页且像素量巨大 —— 那是"扫描的页面", 不是"论文里的图"
                if pix.width * pix.height > 4_000_000 and w / max(1, h) > 0.6 and page_w > 0:
                    skipped.append({"page": pno + 1, "w": w, "h": h, "reason": "疑似整页扫描"})
                    continue
                # CMYK/带 alpha 的要转成 RGB 才能存成 PNG
                if pix.colorspace is None:
                    skipped.append({"page": pno + 1, "w": w, "h": h, "reason": "无色彩空间(单色掩码)"})
                    continue
                if pix.n - pix.alpha >= 4:
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                name = f"fig{pno + 1:02d}-{xref:05d}.png"
                dest = outdir / name
                pix.save(str(dest))
                figures.append({
                    "file": name, "page": pno + 1, "w": w, "h": h,
                    "bytes": dest.stat().st_size,
                })
    finally:
        doc.close()

    print(json.dumps(
        {"ok": True, "figures": figures, "skipped": skipped, "pages": page_count},
        ensure_ascii=False,
    ))
    return 0


if __name__ == "__main__":
    sys.exit(_main())
