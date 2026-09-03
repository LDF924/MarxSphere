"""Content-level inspection via pandoc conversion.

Extracts structural content (word counts, TOC, cover fields, chapters)
that python-docx can't reliably read (SDT TOC, table-based covers).
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any


@dataclass
class ContentResult:
    abstract_zh_chars: int = 0
    abstract_zh_text: str = ""
    abstract_en_words: int = 0
    abstract_en_text: str = ""
    foreign_translation_chars: int = 0
    toc_present: bool = False
    toc_entries: list[str] = field(default_factory=list)
    cover_fields_found: list[str] = field(default_factory=list)
    chapters: list[str] = field(default_factory=list)
    full_text: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


CJK_RE = re.compile(r"[一-鿿㐀-䶿]")
COVER_FIELD_RE = re.compile(r"\*?\*?(学\s*院|专\s*业|姓\s*名|学\s*号|指导教师|完成时间)\*?\*?")
CHAPTER_HEADING_RE = re.compile(r"^#\s+第\d+章", re.MULTILINE)


def _find_pandoc() -> str:
    pandoc = shutil.which("pandoc")
    if pandoc:
        return pandoc
    fallback = Path(r"C:\Program Files\Pandoc\pandoc.exe")
    if fallback.exists():
        return str(fallback)
    raise FileNotFoundError("pandoc not found in PATH or default location")


def _run_pandoc(docx_path: Path) -> str:
    pandoc = _find_pandoc()
    with tempfile.TemporaryDirectory() as tmpdir:
        result = subprocess.run(
            [pandoc, str(docx_path), "-t", "markdown", "--wrap=none"],
            capture_output=True, text=True, encoding="utf-8",
            cwd=tmpdir, timeout=60,
        )
    if result.returncode != 0:
        raise RuntimeError(f"pandoc failed: {result.stderr[:500]}")
    return result.stdout


def _count_cjk(text: str) -> int:
    return len(CJK_RE.findall(text))


def _extract_abstract_zh(text: str) -> tuple[int, str]:
    patterns = [
        (r"\{#_Toc\d+\s+\.anchor\}\s*\*\*摘\s*要\*\*", r"\{#_Toc\d+\s+\.anchor\}\s*\*\*ABSTRACT\*\*"),
        (r"\*\*摘\s*要\*\*", r"\*\*ABSTRACT\*\*"),
        (r"^#.*摘\s*要", r"^#.*ABSTRACT"),
    ]
    for start_pat, end_pat in patterns:
        start_m = re.search(start_pat, text, re.MULTILINE)
        end_m = re.search(end_pat, text, re.MULTILINE)
        if start_m and end_m and end_m.start() > start_m.end():
            block = text[start_m.end():end_m.start()]
            clean = re.sub(r"\{[^}]*\}", "", block)
            clean = re.sub(r"\*\*", "", clean)
            clean = re.sub(r"\[|\]", "", clean)
            chars = _count_cjk(clean)
            if chars > 0:
                return chars, clean.strip()
    return 0, ""


def _extract_abstract_en(text: str) -> tuple[int, str]:
    patterns = [
        (r"\*\*ABSTRACT\*\*", r"^# 第1章"),
        (r"\{#_Toc\d+\s+\.anchor\}\s*\*\*ABSTRACT\*\*", r"^# 第1章"),
    ]
    for start_pat, end_pat in patterns:
        start_m = re.search(start_pat, text, re.MULTILINE)
        end_m = re.search(end_pat, text, re.MULTILINE)
        if start_m and end_m and end_m.start() > start_m.end():
            block = text[start_m.end():end_m.start()]
            clean = re.sub(r"\{[^}]*\}", "", block)
            clean = re.sub(r"\*\*", "", clean)
            clean = clean.replace("ABSTRACT", "").strip()
            words = len(re.findall(r"\b[A-Za-z][A-Za-z\-]*\b", clean))
            return words, clean
    return 0, ""


def _extract_foreign_translation(text: str) -> int:
    patterns = [
        (r"^# 附录二\s+外文译文", r"^# 附录三"),
        (r"^## 附录二", r"^# 附录三"),
    ]
    for start_pat, end_pat in patterns:
        matches = list(re.finditer(start_pat, text, re.MULTILINE))
        if not matches:
            continue
        start_m = matches[-1]
        end_m = re.search(end_pat, text[start_m.end():], re.MULTILINE)
        if end_m:
            block = text[start_m.end():start_m.end() + end_m.start()]
        else:
            block = text[start_m.end():start_m.end() + 10000]
        return _count_cjk(block)
    return 0


def _detect_toc(text: str) -> tuple[bool, list[str]]:
    toc_entries = []
    toc_block_re = re.compile(
        r"\[([^\]]+)\s+\[\d+\]\([^)]+\)\]\([^)]+\)", re.MULTILINE
    )
    for m in toc_block_re.finditer(text[:15000]):
        toc_entries.append(m.group(1).strip())
    if toc_entries:
        return True, toc_entries
    if "目" in text[:15000] and "录" in text[:15000]:
        return True, []
    return False, []


def _detect_cover_fields(text: str) -> list[str]:
    found = []
    cover_block = text[:3000]
    field_names = ["学院", "专业", "姓名", "学号", "指导教师", "完成时间"]
    for f in field_names:
        normalized = f.replace(" ", r"\s*")
        if re.search(normalized, cover_block):
            found.append(f)
    return found


def _extract_chapters(text: str) -> list[str]:
    chapters = []
    for m in CHAPTER_HEADING_RE.finditer(text):
        line = text[m.start():text.find("\n", m.start())]
        chapters.append(line.lstrip("# ").strip())
    return chapters


def inspect(path: str | Path) -> ContentResult:
    """Run pandoc on DOCX and extract content-level facts."""
    path = Path(path)
    full_text = _run_pandoc(path)

    abstract_zh_chars, abstract_zh_text = _extract_abstract_zh(full_text)
    abstract_en_words, abstract_en_text = _extract_abstract_en(full_text)
    foreign_translation_chars = _extract_foreign_translation(full_text)
    toc_present, toc_entries = _detect_toc(full_text)
    cover_fields_found = _detect_cover_fields(full_text)
    chapters = _extract_chapters(full_text)

    return ContentResult(
        abstract_zh_chars=abstract_zh_chars,
        abstract_zh_text=abstract_zh_text,
        abstract_en_words=abstract_en_words,
        abstract_en_text=abstract_en_text,
        foreign_translation_chars=foreign_translation_chars,
        toc_present=toc_present,
        toc_entries=toc_entries,
        cover_fields_found=cover_fields_found,
        chapters=chapters,
        full_text=full_text,
    )
