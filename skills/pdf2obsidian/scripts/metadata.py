"""元数据提取：从 MinerU（MinerU）Markdown 正文提取元数据 + CrossRef/OpenAlex 查询 + 引用格式。"""

import re
import logging
from typing import Optional

import requests

logger = logging.getLogger("pdf2obsidian")


# ===== DOI / External APIs =====

def extract_doi_from_text(text: str) -> Optional[str]:
    m = re.search(r"(?:doi:\s*|https?://doi\.org/)?(10\.\d{4,}/[^\s]+)", text, re.IGNORECASE)
    return m.group(1).rstrip(".") if m else None


def lookup_crossref(doi: str) -> Optional[dict]:
    url = f"https://api.crossref.org/works/{doi}"
    try:
        r = requests.get(url, timeout=15, headers={"User-Agent": "pdf2obsidian/1.0"})
        if r.status_code == 200:
            msg = r.json()["message"]
            authors = []
            for a in msg.get("author", []):
                given = a.get("given", "")
                family = a.get("family", "")
                if given or family:
                    authors.append(f"{family} {given}".strip())
            pub = msg.get("published-print", {}) or msg.get("published-online", {}) or {}
            dp = pub.get("date-parts", [[None]])[0]
            return {
                "doi": doi,
                "title": "\n".join(msg.get("title", [])),
                "authors": authors,
                "journal": "\n".join(msg.get("container-title", [])),
                "year": str(dp[0]) if dp[0] else "",
                "publisher": msg.get("publisher", ""),
                "keywords": list(msg.get("subject", [])),
                "abstract": msg.get("abstract", ""),
            }
        elif r.status_code == 404:
            logger.info("  CrossRef 未找到 DOI: %s", doi)
        else:
            logger.warning("  CrossRef API 返回 %d", r.status_code)
    except Exception as e:
        logger.warning("  CrossRef 查询失败: %s", e)
    return None


def lookup_openalex(doi: str) -> Optional[dict]:
    url = f"https://api.openalex.org/works/doi:{doi}"
    try:
        r = requests.get(url, timeout=15, headers={"User-Agent": "pdf2obsidian/1.0"})
        if r.status_code == 200:
            data = r.json()
            authors = [a.get("author", {}).get("display_name", "") for a in data.get("authorships", [])]
            keywords = [c.get("display_name", "") for c in data.get("concepts", [])]
            source = data.get("primary_location", {}).get("source", {}) or {}
            return {
                "doi": doi,
                "title": data.get("title", ""),
                "authors": [a for a in authors if a],
                "journal": source.get("display_name", ""),
                "year": str(data.get("publication_year", "")),
                "keywords": keywords,
                "publisher": source.get("host_organization_name", ""),
                "abstract": "",
            }
        elif r.status_code == 404:
            logger.info("  OpenAlex 未找到 DOI: %s", doi)
        else:
            logger.warning("  OpenAlex API 返回 %d", r.status_code)
    except Exception as e:
        logger.warning("  OpenAlex 查询失败: %s", e)
    return None


# ===== Text extraction from MinerU output (no YAML frontmatter) =====

def _extract_title_from_markdown(text: str) -> str:
    """从 # 标题行提取论文标题。"""
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("# ") and len(s) > 3:
            return s[2:].strip()
    # Fallback: first non-empty line
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("DOI") and not s.startswith("关键词") and not s.startswith("中图"):
            return s[:120]
    return ""


def _extract_authors_from_markdown(text: str) -> list:
    """从 MinerU 正文提取作者。MinerU 格式：□张三 □李四 / 张三 李四。"""
    # Pattern 1: □张三 □李四 □王五 (MinerU specific)
    m = re.search(r"□\s*([一-鿿]{2,4}(?:\s*□\s*[一-鿿]{2,4})+)", text[:500])
    if m:
        names = re.findall(r"([一-鿿]{2,4})", m.group(1))
        if names:
            logger.info("  作者 (□格式): %s", names)
            return names

    # Pattern 2: "# 标题\n\n作者1 作者2\n" right after the title
    lines = text.splitlines()
    title_idx = None
    for i, line in enumerate(lines):
        if line.strip().startswith("# "):
            title_idx = i
            break
    if title_idx is not None:
        # Look at the next 1-3 lines after title for authors
        for j in range(title_idx + 1, min(title_idx + 4, len(lines))):
            s = lines[j].strip()
            # Skip empty lines, DOI, keywords, classification
            if not s or s.startswith("DOI") or s.startswith("关键词") or s.startswith("中图"):
                continue
            # Check if it looks like authors (2-5 Chinese names separated by spaces)
            names = re.findall(r"[一-鿿]{2,4}", s)
            if 1 <= len(names) <= 6 and all(2 <= len(n) <= 4 for n in names):
                logger.info("  作者 (标题后): %s", names)
                return names
            break  # Only check first non-empty line after title

    return []


def _extract_keywords_from_markdown(text: str) -> list:
    """从 MinerU 正文提取关键词。模式：关键词：A；B；C"""
    m = re.search(r"关键词[：:]\s*(.+)", text[:1500])
    if m:
        raw = m.group(1).strip()
        # Split by ；; ，,  followed by optional spaces
        keywords = re.split(r"[；;，,]\s*", raw)
        keywords = [k.strip() for k in keywords if k.strip()]
        if keywords:
            logger.info("  关键词: %s", keywords)
            return keywords
    return []


def _extract_doi_from_markdown(text: str) -> Optional[str]:
    """从 MinerU 正文提取 DOI。模式：DOI:10.xxx"""
    m = re.search(r"DOI[：:]\s*(10\.\d{4,}/[^\s]+)", text[:2000], re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return extract_doi_from_text(text)


def _extract_journal_info_from_markdown(text: str) -> dict:
    """从 MinerU 正文提取期刊信息。模式：中图分类号：F303.3 文献标识码：A 文章编号：...（年份）"""
    info = {"year": "", "journal": ""}
    # 中图分类号：F303.3 文献标识码：A 文章编号：1003—5656（2024）10—0119—10
    m = re.search(r"文章编号[：:]\s*\S+\s*[（(](\d{4})[）)]", text[:1000])
    if m:
        info["year"] = m.group(1)
        logger.info("  年份 (文章编号): %s", info["year"])
    return info


# ===== Citation format generation =====

def generate_citations(meta: dict) -> dict:
    """生成 APA / IEEE / BibTeX 引用格式。"""
    authors = meta.get("authors", [])
    title = meta.get("title", "")
    year = meta.get("year", "")
    doi = meta.get("doi", "")

    plain = f"({year}) {title} doi:{doi}" if year and title and doi else None
    apa = None
    if year and title:
        apa = f"({year}). {title}."
        if doi:
            apa += f" https://doi.org/{doi}"
    ieee = None
    if year and title and doi:
        ieee = f'"{title}," {year} doi:{doi}'
    bibtex = None
    if title and year:
        bibtex = (
            f"@article{{paper{year}work,\n"
            f"  title = {{{title}}},\n"
            f"  year = {year},\n"
            f"  doi = {{{doi}}},\n"
            f"}}"
        )

    return {
        "citationPlain": plain,
        "citationApa": apa,
        "citationIeee": ieee,
        "citationBibtex": bibtex,
    }


# ===== Main extraction =====

def extract_metadata_from_markdown(markdown: str) -> dict:
    """从 MinerU 输出的 Markdown 正文中提取所有元数据。"""

    # 1. 从正文提取基础字段
    title = _extract_title_from_markdown(markdown)
    authors = _extract_authors_from_markdown(markdown)
    keywords = _extract_keywords_from_markdown(markdown)
    doi = _extract_doi_from_markdown(markdown)
    journal = _extract_journal_info_from_markdown(markdown)

    meta = {
        "title": title,
        "paperTitle": title,
        "translatedTitle": title,
        "authors": authors,
        "keywords": keywords,
        "doi": doi or "",
        "year": journal.get("year", ""),
        "journal": journal.get("journal", ""),
    }

    # 2. DOI 查询外部 API 补全
    if doi:
        logger.info("  查询元数据 (DOI: %s)...", doi)
        external = lookup_crossref(doi) or lookup_openalex(doi)
        if external:
            for k in ("authors", "keywords", "year", "journal", "publisher", "abstract", "title"):
                if external.get(k) and not meta.get(k):
                    meta[k] = external[k]

    # 3. 生成引用格式
    meta.update(generate_citations(meta))

    return meta
