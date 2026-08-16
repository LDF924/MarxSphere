"""PDF 解析模块：通过 MinerU 云端 SDK 将 PDF 转为 Markdown。"""

import time
import logging
from pathlib import Path
from typing import Optional

from mineru import MinerU
from mineru.client import ExtractResult

logger = logging.getLogger("pdf2obsidian")

try:
    from PyPDF2 import PdfReader
    def _count_pages(pdf_path: Path) -> int:
        try:
            return len(PdfReader(str(pdf_path)).pages)
        except Exception:
            return 999
except ImportError:
    def _count_pages(_pdf_path: Path) -> int:
        return 999


def select_mode(pdf_path: Path, has_token: bool) -> str:
    """默认 precision（有 token 强制精度模式）。"""
    if has_token:
        return "precision"
    size_mb = pdf_path.stat().st_size / (1024 * 1024)
    pages = _count_pages(pdf_path)
    if size_mb <= 10 and pages <= 20:
        return "flash"
    logger.warning("%s 超过 flash 限制 (%.1fMB, %d页) 且未配置 token，仍尝试 flash", pdf_path.name, size_mb, pages)
    return "flash"


def parse_pdf(pdf_path: Path, config: dict) -> Optional[ExtractResult]:
    """解析单个 PDF，返回 ExtractResult。失败返回 None。"""
    token = config.get("MINERU_TOKEN", "").strip()
    mode = select_mode(pdf_path, bool(token))

    size_mb = pdf_path.stat().st_size / (1024 * 1024)
    pages = _count_pages(pdf_path)
    logger.info("  解析 %s (%.1fMB, %d页, %s 模式)", pdf_path.name, size_mb, pages, mode)

    client = MinerU(token=token) if token else MinerU()

    # 超时控制：precision 最长 600s，flash 最长 300s
    timeout = int(config.get("PARSE_TIMEOUT", "600"))
    if mode == "flash":
        timeout = min(timeout, 300)

    max_retries = int(config.get("MAX_RETRIES", "3"))
    for attempt in range(1, max_retries + 1):
        try:
            if mode == "flash":
                result = client.flash_extract(
                    str(pdf_path), language="ch",
                    enable_formula=True, enable_table=True,
                )
            else:
                result = client.extract(
                    str(pdf_path), formula=True, table=True,
                    language="ch", timeout=timeout,
                )

            if result.state == "done" and result.markdown:
                logger.info("  OK: parsed %d chars, %d images",
                            len(result.markdown),
                            len(result.images) if result.images else 0)
                return result

            logger.warning("  解析状态=%s（第 %d 次尝试）", result.state, attempt)

        except Exception as e:
            err_msg = str(e)
            logger.warning("  第 %d/%d 次失败: %s", attempt, max_retries, err_msg[:120])
            if "auth" in err_msg.lower() or "token" in err_msg.lower() or "401" in err_msg:
                if mode == "precision":
                    logger.info("  Token 可能失效，降级为 flash 模式重试")
                    mode = "flash"
                    client = MinerU()
            if attempt < max_retries:
                wait = 5 * (2 ** (attempt - 1))
                logger.info("  %ds 后重试...", wait)
                time.sleep(wait)

    logger.error("  全部重试失败: %s", pdf_path.name)
    return None
