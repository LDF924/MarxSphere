"""Obsidian 库写入模块：slug/images/ 独立图片目录，YAML frontmatter，wiki-link 导航。"""

import hashlib
import logging
import re
from pathlib import Path
from datetime import datetime, timezone

import yaml

logger = logging.getLogger("pdf2obsidian")


def hash_source(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def write_paper(output_dir: Path, slug: str, data: dict) -> bool:
    paper_dir = output_dir / slug
    paper_dir.mkdir(parents=True, exist_ok=True)

    meta = data.get("metadata", {})
    title = meta.get("title", slug)
    paper_title = meta.get("paperTitle", title)
    translated_title = meta.get("translatedTitle", title)
    src_hash = data.get("sourceHash", hash_source(data.get("original_md", "")))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    index_note = f"[[{slug}.index]]"

    # ---- 图片写入 ----
    images = data.get("images")
    if images:
        img_dir = paper_dir / "images"
        img_dir.mkdir(exist_ok=True)
        for name, content in images.items():
            try:
                (img_dir / name).write_bytes(content)
            except OSError as e:
                logger.warning("  图片写入失败 %s: %s", name, e)

    # ---- 原文 (original.md) —— 先处理图片路径再写 ----
    orig_body = data.get("original_md", "")
    orig_body = _strip_frontmatter(orig_body)

    # 将 MinerU 输出中的 images/xxx 替换为 slug/images/xxx
    if images:
        for img_name in images:
            old_path = f"images/{img_name}"
            new_path = f"{slug}/images/{img_name}"
            orig_body = orig_body.replace(old_path, new_path)
            # 也尝试处理 ./images/xxx 和直接 images/ 引用
            orig_body = orig_body.replace(f"./images/{img_name}", new_path)
            # 匹配 ![](images/xxx) 不带前缀
            orig_body = orig_body.replace(f"](images/{img_name})", f"]({new_path})")

    orig_fm = {
        "title": title,
        "paperTitle": paper_title,
        "translatedTitle": translated_title,
        "year": meta.get("year"),
        "doi": meta.get("doi"),
        "abstract": meta.get("abstract"),
        "impactFactor": meta.get("impactFactor"),
        "fiveYearImpactFactor": meta.get("fiveYearImpactFactor"),
        "jci": meta.get("jci"),
        "jcrQuartile": meta.get("jcrQuartile"),
        "casQuartile": meta.get("casQuartile"),
        "citationPlain": meta.get("citationPlain"),
        "citationApa": meta.get("citationApa"),
        "citationIeee": meta.get("citationIeee"),
        "citationBibtex": meta.get("citationBibtex"),
        "lang": data.get("detectedSourceLanguage", "zh-CN"),
        "sourceHash": src_hash,
        "sourcePdf": Path(data.get("_pdf_path", "")).name or None,
        "indexNote": index_note,
        "createdAt": now,
    }
    if data.get("translationProvider"):
        orig_fm["translationProvider"] = data["translationProvider"]
        orig_fm["translationModel"] = data["translationModel"]
    orig_fm["detectedSourceLanguage"] = data.get("detectedSourceLanguage", "zh-CN")
    orig_fm["translationSkipped"] = data.get("translationSkipped", True)
    orig_fm = {k: v for k, v in orig_fm.items() if v is not None and v != ""}

    orig_content = _fmt_frontmatter(orig_fm) + "\n\n" + orig_body
    (paper_dir / f"{slug}.original.md").write_text(orig_content, encoding="utf-8")

    # ---- 索引 (index.md) ----
    idx = _format_index(data, slug, title, paper_title, translated_title, now, src_hash, index_note)
    (paper_dir / f"{slug}.index.md").write_text(idx, encoding="utf-8")

    # ---- 元数据 (信息.md) ----
    meta_md = _format_metadata(meta, slug, title, paper_title, translated_title, index_note, now, src_hash)
    (paper_dir / f"{slug}_信息.md").write_text(meta_md, encoding="utf-8")

    # ---- 摘要 ----
    if data.get("summary"):
        s = _format_derived("摘要", "summary", data["summary"], title, paper_title, translated_title, index_note, now, src_hash)
        (paper_dir / "摘要.md").write_text(s, encoding="utf-8")

    # ---- 术语表 ----
    if data.get("glossary"):
        g = _format_glossary(data["glossary"], title, paper_title, translated_title, index_note, now, src_hash)
        (paper_dir / "术语表.md").write_text(g, encoding="utf-8")

    # ---- 问答 ----
    if data.get("qa"):
        q = _format_qa(data["qa"], title, paper_title, translated_title, index_note, now, src_hash)
        (paper_dir / "问答.md").write_text(q, encoding="utf-8")

    return True


# ===== Obsidian Database Folder 插件配置 =====

DATABASE_BASE = """filters: type == "index" && file.inFolder("{folder_name}")
properties:
  file.name:
    displayName: 名称
  translatedTitle:
    displayName: 标题
  authors:
    displayName: 作者
  year:
    displayName: 年份
  journal:
    displayName: 期刊/会议
  citationCount:
    displayName: 引用
  impactFactor:
    displayName: 影响因子
  jcrQuartile:
    displayName: JCR
  casQuartile:
    displayName: 中科院
  doi:
    displayName: DOI
  citationApa:
    displayName: 引用 APA
  citationBibtex:
    displayName: 引用 BibTeX
views:
  - type: table
    name: 论文
    order:
      - file.name
      - translatedTitle
      - year
      - journal
      - citationCount
      - impactFactor
      - jcrQuartile
      - casQuartile
      - doi
    sort:
      - property: translatedTitle
        direction: ASC
      - property: doi
        direction: ASC
  - type: table
    name: 引用
    order:
      - file.name
      - translatedTitle
      - authors
      - year
      - citationApa
      - citationBibtex
      - doi
    sort:
      - property: year
        direction: DESC
      - property: file.name
        direction: ASC
"""


def write_database_base(output_dir: Path, folder_name: str = "Thesis"):
    """在 output_dir 下写入 数据库.base 文件（Obsidian Database Folder 插件配置）。
    这样 Obsidian 里可以按表格视图浏览所有论文，按标题/年份/期刊/DOI 排序筛选。"""
    base_file = output_dir / "数据库.base"
    content = DATABASE_BASE.replace("{folder_name}", folder_name)
    base_file.write_text(content, encoding="utf-8")
    logger.info("  已写入 Database Folder 配置: %s", base_file)


def _strip_frontmatter(text: str) -> str:
    m = re.match(r"^---\s*\n.*?\n---\s*\n", text, re.DOTALL)
    return text[m.end():] if m else text


def _fmt_frontmatter(data: dict) -> str:
    clean = {k: v for k, v in data.items() if v is not None and v != "" and v != []}
    return "---\n" + yaml.dump(clean, allow_unicode=True, default_flow_style=False, sort_keys=False) + "---"


def _format_index(data, slug, title, paper_title, translated_title, now, src_hash, index_note):
    meta = data.get("metadata", {})
    year = meta.get("year", "")
    authors = meta.get("authors", [])
    journal = meta.get("journal", "")
    doi = meta.get("doi", "")
    keywords = meta.get("keywords", [])
    abstract = (meta.get("abstract") or "")[:600]

    fm = {k: v for k, v in {
        "title": title, "paperTitle": paper_title, "translatedTitle": translated_title,
        "year": year or None, "doi": doi or None, "authors": authors or None,
        "journal": journal or None, "keywords": keywords or None,
        "abstract": abstract or None, "type": "index", "sourceHash": src_hash,
        "createdAt": now, "tags": ["paper"] + ([f"year/{year}"] if year else []),
    }.items() if v is not None and v != "" and v != []}

    lines = ["---", yaml.dump(fm, allow_unicode=True, default_flow_style=False, sort_keys=False).strip(), "---", "", f"# {title}"]

    links = [
        f"- [[{slug}_信息|元数据信息]]",
        f"- [[{slug}.original|原始文本]]",
    ]
    if data.get("translated_md"):
        links.append(f"- [[{slug}_译文|译文]]")
    if data.get("summary"):
        links.append("- [[摘要|AI 摘要]]")
    if data.get("glossary"):
        links.append("- [[术语表|术语表]]")
    if data.get("qa"):
        links.append("- [[问答|复习问答]]")

    lines.extend(["", "## 导航", ""] + links + ["", "## 元数据", ""])
    table = ["| 字段 | 值 |", "|------|-----|"]
    if authors:
        table.append(f"| 作者 | {'、'.join(authors[:10])} |")
    if journal:
        table.append(f"| 期刊 | {journal} |")
    if year:
        table.append(f"| 年份 | {year} |")
    if doi:
        table.append(f"| DOI | {doi} |")
    if keywords:
        table.append(f"| 关键词 | {'、'.join(keywords[:15])} |")
    lines.extend(table)
    return "\n".join(lines)


def _format_metadata(meta, slug, title, paper_title, translated_title, index_note, now, src_hash):
    fm = _fmt_frontmatter({
        "title": title + " - 信息", "paperTitle": paper_title,
        "translatedTitle": translated_title, "type": "metadata",
        "parent": index_note, "sourceHash": src_hash, "createdAt": now,
    })
    lines = [fm, "", f"**← 返回：** {index_note}", "", f"# {title}", ""]
    if meta.get("authors"):
        lines.extend(["## 作者", "、".join(meta["authors"]), ""])
    if meta.get("journal") or meta.get("year"):
        lines.append(f"## 期刊\n{meta.get('journal', '')} ({meta.get('year', '')})\n")
    if meta.get("doi"):
        lines.extend(["## DOI", meta["doi"], ""])
    if meta.get("keywords"):
        lines.extend(["## 关键词", "、".join(meta["keywords"]), ""])
    if meta.get("abstract"):
        lines.extend(["## 摘要", meta["abstract"]])
    return "\n".join(lines)


def _format_derived(title_suffix, p2o_type, content, paper_title, paper_title_en, translated_title, index_note, now, src_hash):
    fm = _fmt_frontmatter({
        "title": paper_title + " - " + title_suffix, "paperTitle": paper_title,
        "translatedTitle": translated_title, "type": p2o_type,
        "parent": index_note, "sourceHash": src_hash, "createdAt": now,
    })
    return f"{fm}\n\n**← 返回：** {index_note}\n\n# {title_suffix}\n\n{content}\n\n**← 返回：** {index_note}\n"


def _format_glossary(glossary, title, paper_title, translated_title, index_note, now, src_hash):
    fm = _fmt_frontmatter({
        "title": title + " - 术语表", "paperTitle": paper_title,
        "translatedTitle": translated_title, "type": "terms",
        "parent": index_note, "sourceHash": src_hash, "createdAt": now,
    })
    lines = [fm, "", f"**← 返回：** {index_note}", "", "# 术语表", "",
             "| 术语 | 英文名称 | 学术语境释义 |", "| :--- | :--- | :--- |"]
    for item in glossary:
        t = item.get("term", "")
        e = item.get("english", "")
        d = item.get("definition", "")
        lines.append(f"| **{t}** ({e}) | {e} | {d} |")
    lines.extend(["", f"**← 返回：** {index_note}"])
    return "\n".join(lines)


def _format_qa(qa, title, paper_title, translated_title, index_note, now, src_hash):
    fm = _fmt_frontmatter({
        "title": title + " - 问答", "paperTitle": paper_title,
        "translatedTitle": translated_title, "type": "qa",
        "parent": index_note, "sourceHash": src_hash, "createdAt": now,
    })
    by_type = {}
    for item in qa:
        by_type.setdefault(item.get("type", "other"), []).append(item)
    labels = {"methodology": "研究方法", "finding": "主要发现", "theory": "理论框架", "policy": "政策启示"}
    lines = [fm, "", f"**← 返回：** {index_note}", "", "# 问答"]
    n = 1
    for t, items in by_type.items():
        label = labels.get(t, t)
        lines.extend(["", f"## {label}", ""])
        for item in items:
            lines.append(f"{n}. **{item.get('question', '')}**")
            lines.extend(["", f"   - **答：** {item.get('answer', '')}", ""])
            n += 1
    lines.append(f"**← 返回：** {index_note}")
    return "\n".join(lines)
