"""翻译模块：通过 llm.py 统一抽象层。中文文献默认跳过。"""

import logging
from typing import Optional
from llm import chat

logger = logging.getLogger("pdf2obsidian")

FIELD_CONTEXT = (
    "工商资本、共同富裕、合作社、农民增收、农业经济、农业农村现代化、"
    "三农、乡村产业振兴、乡村治理、资本下乡、中国式现代化等"
)

SYSTEM_PROMPT = f"""你是一位精通中国社会科学、农业经济学、公共政策与乡村治理领域的中英学术翻译。
专业领域涉及：{FIELD_CONTEXT}。

翻译为中文时注意：
- 保留 Markdown 格式（标题、列表、表格、链接、图片引用）
- 保留 LaTeX 公式（不修改 $$...$$ 或 $...$）
- 专业术语首次出现时保留英文原文并在括号内附中文译名
- 区分以下术语的翻译：
  * capital going to the countryside → 资本下乡
  * industrial and commercial capital → 工商资本
  * agriculture-oriented industries → 趋农产业
  * backbone farmers → 中坚农民
  * benefit linkage mechanism → 利益联结机制
- 政策文件名称使用官方规范译法

只输出翻译结果，不要额外说明。"""


def detect_language(text: str) -> str:
    chinese_chars = sum(1 for c in text[:2000] if '一' <= c <= '鿿')
    return "zh-CN" if chinese_chars > 100 else "en"


def chunk_markdown(text: str, max_chars: int = 4000) -> list[str]:
    lines = text.splitlines()
    chunks = []
    cur, cur_len = [], 0

    def flush():
        nonlocal cur, cur_len
        if cur:
            chunks.append("\n".join(cur))
            cur, cur_len = [], 0

    for line in lines:
        ln = len(line) + 1
        if line.startswith("## ") and cur_len > max_chars * 0.5:
            flush()
        if line.strip() == "---" and cur_len > max_chars * 0.3:
            flush()
        cur.append(line)
        cur_len += ln
        if cur_len >= max_chars:
            flush()
    flush()
    return chunks


def translate_markdown(text: str, config: dict, target_lang: str = "zh") -> Optional[str]:
    src_lang = detect_language(text)
    if src_lang == target_lang:
        logger.info("  源=%s 目标=%s，跳过翻译", src_lang, target_lang)
        return None

    chunks = chunk_markdown(text)
    logger.info("  翻译分 %d 块 (%s→%s)", len(chunks), src_lang, target_lang)

    translated = []
    for chunk in chunks:
        result = chat(SYSTEM_PROMPT, chunk, config, max_tokens=8192)
        translated.append(result if result else chunk)

    return "\n\n".join(translated)
