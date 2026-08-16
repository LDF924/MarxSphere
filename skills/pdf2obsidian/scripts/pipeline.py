#!/usr/bin/env python3
"""pdf2obsidian 主编排器：扫描 PDF → 解析 → 元数据 → AI 生成 → 写入 Obsidian 库。
用法: python pipeline.py --input DIR --output DIR [--resume] [--retry-failed] [--max-files N] [--concurrency N]
"""

import argparse
import logging
import sys
import time
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from utils import (
    load_config, setup_logging, slugify,
    load_state, save_state, is_paper_done,
    get_daily_pages, add_daily_pages, check_daily_quota,
    update_paper_state,
)
from parse import parse_pdf, _count_pages, select_mode
from metadata import extract_metadata_from_markdown
from translate import translate_markdown, detect_language
from generate import generate_all
from llm import get_token_usage, get_llm_mode, get_model_name, reset_token_usage
from obsidian_vault import write_paper, hash_source, write_database_base

logger = logging.getLogger("pdf2obsidian")

# ===== 重复文件校验缓存 =====
SOURCE_HASHES = {}  # sha256 -> slug


def scan_pdfs(input_dir: Path) -> list[Path]:
    """扫描目录下所有 PDF 文件。Windows 上 *.pdf 已匹配 .PDF，手动追加会重复——用 set/dict 去重。"""
    pdfs = sorted(input_dir.rglob("*.pdf"))
    pdfs.extend(sorted(input_dir.rglob("*.PDF")))
    # 用 resolve() 做路径去重（Windows NTFS 大小写不敏感，a.pdf 和 a.PDF 是同一个文件）
    seen = {}
    unique = []
    for p in pdfs:
        key = p.resolve()
        if key not in seen:
            seen[key] = True
            unique.append(p)
    return unique


def process_paper(pdf_path: Path, config: dict, output_dir: Path, state: dict) -> str:
    fname = pdf_path.name
    slug = slugify(fname)
    # ══════════════════════════════════════════════════════════
    # 触发式自愈：只在 state 文件损坏时当场修复
    # ══════════════════════════════════════════════════════════

    state_file = output_dir / ".pipeline_state.json"
    if state_file.exists():
        try:
            json.loads(state_file.read_text("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            state_file.write_text("{}", "utf-8")
            logger.warning("  [AUTO-HEAL] reset corrupt pipeline_state.json")
            state = {}

    daily_file = output_dir / ".daily_quota.json"
    if daily_file.exists():
        try:
            json.loads(daily_file.read_text("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            daily_file.write_text("{}", "utf-8")
            logger.warning("  [AUTO-HEAL] reset corrupt daily_quota.json")

    logger.info("[%s] 开始处理", fname)

    paper_data = {}
    current_stage = state.get(slug, "pending")

    try:
        # ============================================================
        # 阶段 1: PDF 解析
        # ============================================================
        if current_stage in ("pending", "parsing", "failed"):
            update_paper_state(output_dir, slug, "parsing")
            logger.info("  [状态] %s → parsing", current_stage)

            token = config.get("MINERU_TOKEN", "").strip()
            mode = select_mode(pdf_path, bool(token))
            if mode == "precision":
                max_pages = int(config.get("MAX_DAILY_PAGES", "900"))
                if not check_daily_quota(output_dir, max_pages):
                    logger.warning("  今日精度配额已满，跳过 %s", fname)
                    update_paper_state(output_dir, slug, "pending")
                    return "skipped"

            result = parse_pdf(pdf_path, config)
            if not result or not result.markdown:
                update_paper_state(output_dir, slug, "failed")
                logger.error("  [失败] PDF 解析失败: %s", fname)
                return "failed"

            paper_data["original_md"] = result.markdown
            paper_data["sourceHash"] = hash_source(result.markdown)
            paper_data["_pdf_path"] = str(pdf_path)

            # 图片提取（健壮校验）
            if result.images:
                img_map = {}
                for img in result.images:
                    if hasattr(img, "name") and hasattr(img, "data") and img.data:
                        img_map[img.name] = img.data
                if img_map:
                    paper_data["images"] = img_map
                    logger.info("  提取 %d 张图片", len(img_map))

            if mode == "precision":
                add_daily_pages(output_dir, _count_pages(pdf_path))

            update_paper_state(output_dir, slug, "parsed")
            logger.info("  [状态] parsing → parsed")
        else:
            logger.info("  [状态] 跳过解析（%s）", current_stage)

        # ---- contentHash 去重 ----
        src_hash = paper_data.get("sourceHash", "")
        if src_hash and src_hash in SOURCE_HASHES:
            dup_slug = SOURCE_HASHES[src_hash]
            logger.warning("  [去重] 内容重复，已在 %s 处理过，跳过", dup_slug)
            update_paper_state(output_dir, slug, "duplicate")
            return "skipped"
        if src_hash:
            SOURCE_HASHES[src_hash] = slug

        # ============================================================
        # 阶段 2: 元数据提取
        # ============================================================
        if current_stage in ("pending", "parsing", "parsed", "failed"):
            update_paper_state(output_dir, slug, "metadata")

            orig_md = paper_data.get("original_md", "")
            try:
                meta = extract_metadata_from_markdown(orig_md) if orig_md else {}
            except Exception as e:
                logger.warning("  元数据提取异常: %s，使用默认值", e)
                meta = {}
            meta.setdefault("title", fname.replace(".pdf", ""))
            paper_data["metadata"] = meta

            best_title = meta.get("title") or fname.replace(".pdf", "")
            paper_data["slug"] = slugify(best_title) if best_title else slug

            # 始终同步更新 state key 为输出目录 slug，保持一致性
            # （否则 state 里 key=文件名slug，但输出目录=标题slug，resume 失配）
            update_paper_state(output_dir, slug, "meta_done")
            if paper_data.get("slug") and paper_data["slug"] != slug:
                update_paper_state(output_dir, paper_data["slug"], state.get(slug, "meta_done"))
            logger.info("  [状态] parsed → meta_done")
        elif "metadata" not in paper_data:
            paper_data["metadata"] = {"title": fname.replace(".pdf", "")}
            paper_data["slug"] = slug

        # ============================================================
        # 阶段 3: 翻译（中文文献跳过）
        # ============================================================
        if current_stage not in ("translated", "generating", "meta_done", "finished", "done"):
            update_paper_state(output_dir, slug, "translating")
            paper_data["translationSkipped"] = True
            paper_data["detectedSourceLanguage"] = "zh-CN"
            logger.info("  [状态] meta_done → translating → skipped（中文文献）")
        else:
            logger.info("  [状态] 跳过翻译（%s）", current_stage)

        # ============================================================
        # 阶段 4: AI 内容生成
        # ============================================================
        if current_stage not in ("generating", "meta_done", "finished", "done"):
            update_paper_state(output_dir, slug, "generating")
            llm_ok = bool(config.get("LLM_BASE_URL", "").strip())
            if llm_ok and paper_data.get("original_md"):
                try:
                    gen = generate_all(paper_data["original_md"], config)
                    paper_data.update(gen)
                    logger.info("  AI 生成: 摘要=%s 术语表=%d 问答=%d",
                                "OK" if gen.get("summary") else "no",
                                len(gen.get("glossary") or []),
                                len(gen.get("qa") or []))
                except Exception as e:
                    logger.warning("  AI 生成异常: %s", e)
            update_paper_state(output_dir, slug, "generated")
            logger.info("  [状态] generating → generated")

        # ============================================================
        # 阶段 5: 写入 Obsidian
        # ============================================================
        update_paper_state(output_dir, slug, "writing")
        use_slug = paper_data.get("slug", slug)
        try:
            ok = write_paper(output_dir, use_slug, paper_data)
        except Exception as e:
            logger.error("  写入异常: %s", e)
            update_paper_state(output_dir, slug, "failed")
            return "failed"

        if ok:
            # 同步更新 state：确保输出目录 slug 也被标记为完成
            update_paper_state(output_dir, slug, "finished")
            use_slug_final = paper_data.get("slug", slug)
            if use_slug_final != slug:
                update_paper_state(output_dir, use_slug_final, "finished")
            logger.info("  [状态] generated → finished")
            return "done"
        else:
            update_paper_state(output_dir, slug, "failed")
            return "failed"

    except Exception as e:
        logger.error("  [崩溃] %s: %s", fname, e, exc_info=True)
        try:
            update_paper_state(output_dir, slug, "failed")
        except Exception:
            pass
        return "failed"


def main():
    parser = argparse.ArgumentParser(description="pdf2obsidian — PDF 批量转 Obsidian Markdown")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--config", default=None)
    parser.add_argument("--max-files", type=int, default=None)
    parser.add_argument("--concurrency", type=int, default=1, help="并发数（默认 1，API 模式可设为 3-5）")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    input_dir = Path(args.input)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    setup_logging(output_dir)
    if args.verbose:
        logger.setLevel(logging.DEBUG)

    # ══════════════════════════════════════════════════════════════
    # 前置条件检查：跑之前必须满足，不满足直接退出
    # ══════════════════════════════════════════════════════════════

    # 1. 源 PDF 目录必须存在且包含 PDF
    if not input_dir.exists():
        logger.error("FATAL: PDF 输入目录不存在: %s", input_dir)
        sys.exit(1)
    pdfs = [p for p in input_dir.rglob("*.pdf")] + [p for p in input_dir.rglob("*.PDF")]
    if not pdfs:
        logger.error("FATAL: 输入目录下没有 PDF 文件: %s", input_dir)
        sys.exit(1)
    logger.info("前置检查: 找到 %d 个 PDF 文件", len(pdfs))

    # 2. 目标目录必须可写
    try:
        test = output_dir / ".write_test"
        test.write_text("ok")
        test.unlink()
    except (PermissionError, OSError) as e:
        logger.error("FATAL: 输出目录不可写: %s — %s", output_dir, e)
        sys.exit(1)
    logger.info("前置检查: 输出目录可写")

    # 3. 配置文件如果指定，必须存在
    if args.config:
        cfg_path = Path(args.config)
        if not cfg_path.exists():
            logger.error("FATAL: 配置文件不存在: %s", cfg_path)
            sys.exit(1)

    config = load_config(Path(args.config) if args.config else None)

    pdfs = scan_pdfs(input_dir)
    logger.info("扫描到 %d 篇 PDF", len(pdfs))
    if args.max_files:
        pdfs = pdfs[:args.max_files]
        logger.info("限制处理 %d 篇", args.max_files)

    if args.dry_run:
        for i, p in enumerate(pdfs, 1):
            mode = select_mode(p, bool(config.get("MINERU_TOKEN", "").strip()))
            size_mb = p.stat().st_size / (1024 * 1024)
            pages = _count_pages(p)
            logger.info("  %3d. %s (%.1fMB, %d页, %s)", i, p.name, size_mb, pages, mode)
        return

    state = load_state(output_dir)
    done_count = sum(1 for v in state.values() if isinstance(v, str) and v in ("done", "finished"))
    logger.info("state 中已完成: %d 篇", done_count)
    logger.info("LLM: %s / %s", get_llm_mode(config), get_model_name(config))

    start_time = datetime.now()
    results = {"done": 0, "failed": 0, "skipped": 0}

    if args.concurrency > 1:
        logger.info("并发模式: %d 线程", args.concurrency)
        # 先构建任务列表，筛掉已完成和失败的
        tasks = []
        for i, pdf_path in enumerate(pdfs, 1):
            slug = slugify(pdf_path.name)
            if args.resume and is_paper_done(output_dir, slug):
                results["done"] += 1
                continue
            if state.get(slug) == "failed" and not args.retry_failed:
                results["failed"] += 1
                continue
            tasks.append((i, pdf_path))

        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            futures = {pool.submit(process_paper, p, config, output_dir, state): (i, p) for i, p in tasks}
            for fut in as_completed(futures):
                i, p = futures[fut]
                try:
                    outcome = fut.result()
                except Exception as e:
                    logger.error("[%d/%d] 线程异常 %s: %s", i, len(pdfs), p.name, e)
                    outcome = "failed"
                results[outcome] = results.get(outcome, 0) + 1
                done = results["done"] + results["failed"]
                rate = done / (datetime.now() - start_time).total_seconds() * 60 if done > 0 else 0
                logger.info("  进度: %d/%d done=%d failed=%d %.1f/min",
                            done, len(tasks), results["done"], results["failed"], rate)
    else:
        # 串行模式
        for i, pdf_path in enumerate(pdfs, 1):
            fname = pdf_path.name
            slug = slugify(fname)
            if args.resume and is_paper_done(output_dir, slug):
                results["done"] += 1
                logger.info("[%d/%d] %s — 已完成，跳过", i, len(pdfs), fname)
                continue
            if state.get(slug) == "failed" and not args.retry_failed:
                results["failed"] += 1
                logger.info("[%d/%d] %s — 之前失败，跳过", i, len(pdfs), fname)
                continue
            logger.info("\n[%d/%d] %s", i, len(pdfs), fname)
            outcome = process_paper(pdf_path, config, output_dir, state)
            results[outcome] = results.get(outcome, 0) + 1
            done = results["done"] + results["failed"]
            rate = done / (datetime.now() - start_time).total_seconds() * 60 if done > 0 else 0
            logger.info("  进度: %d done | %d failed | %d skipped | %.1f 篇/分钟",
                        results["done"], results["failed"], results["skipped"], rate)

    # 汇总
    logger.info("\n===== 完成 =====")
    logger.info("LLM: %s / %s", get_llm_mode(config), get_model_name(config))
    logger.info("总文件: %d | 成功: %d | 失败: %d | 跳过: %d",
                len(pdfs), results["done"], results["failed"], results["skipped"])
    logger.info("耗时: %s", str(datetime.now() - start_time).split(".")[0])

    # 写入 Database Folder 配置
    folder_name = Path(args.output).name
    write_database_base(output_dir, folder_name)

    usage = get_token_usage()
    tp = sum(v for k, v in usage.items() if k.endswith("_prompt"))
    tc = sum(v for k, v in usage.items() if k.endswith("_completion"))
    tt = sum(v for k, v in usage.items() if k.endswith("_total"))
    count = max(results["done"], 1)
    if tt:
        logger.info("===== Token 用量 =====")
        for cat in ("summary", "glossary", "qa", "translate"):
            p = usage.get(f"{cat}_prompt", 0)
            c = usage.get(f"{cat}_completion", 0)
            t = usage.get(f"{cat}_total", 0)
            if t:
                logger.info("%s: prompt=%d completion=%d total=%d", cat, p, c, t)
        logger.info("合计: prompt=%d completion=%d total=%d (%.1fK)", tp, tc, tt, tt / 1000)
        if get_llm_mode(config) == "api":
            logger.info("平均每篇: %.1fK tokens | 预估 409 篇费用: ~¥%.0f",
                        tt / count / 1000, (tp / 1e6 * 1 + tc / 1e6 * 2) * 409)
    else:
        logger.info("本地模型，不消耗 API token")


if __name__ == "__main__":
    main()
