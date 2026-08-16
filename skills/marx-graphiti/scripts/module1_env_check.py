#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 模块1：前置环境与工程健壮性优化 — 独立检测脚本  v2.0
============================================================
功能：
  (1) MD 文件完整性检测
  (2) 空/乱码文件检测
  (3) Neo4j 配置校验
  (4) 阶段备份 (dump)

新增特性：
  1. 最大重试阈值 — 每项检测最多 3 次，超限退出
  2. 状态持久化 — 当日校验通过后生成本地标记，不再重复执行
  3. 异常阻断 — 所有外部调用 try-except，失败直接退出
"""

import sys, json, os, time, argparse, hashlib, shutil
from pathlib import Path
from datetime import datetime, date

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger

logger = get_logger("env_check")

# ── 全局常量 ──
MAX_RETRY = 3
MARK_FILE = SCRIPT_DIR / ".env_check_ok.timestamp"
BASE_DIR = Path(r"D:\Desktop\ov_import")
BACKUP_DIR = Path(r"%USERPROFILE%\neo4j\neo4j-community-5.26.27\data\neo4j_backups")


# ═══════════════════════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════════════════════

def _today_key() -> str:
    return date.today().isoformat()  # "2026-07-01"


def _check_or_skip() -> bool:
    """如果当日已通过校验，返回 True 表示应跳过"""
    if MARK_FILE.exists():
        saved = MARK_FILE.read_text(encoding="utf-8").strip()
        if saved == _today_key():
            logger.info(f"Today's env check already passed ({saved}), skipping full check.")
            return True
    return False


def _mark_passed():
    MARK_FILE.write_text(_today_key(), encoding="utf-8")


def _retry_or_die(label: str, func, *args, **kwargs):
    """最多重试 MAX_RETRY 次，全部失败则退出"""
    for attempt in range(1, MAX_RETRY + 1):
        try:
            result = func(*args, **kwargs)
            if result is not False and result is not None:
                return result
        except Exception as e:
            logger.error(f"[{label}] attempt {attempt}/{MAX_RETRY} exception: {type(e).__name__}: {e}")
        if attempt < MAX_RETRY:
            logger.warning(f"[{label}] attempt {attempt}/{MAX_RETRY} failed, retrying...")
            time.sleep(2)
    logger.critical(f"[{label}] FAILED after {MAX_RETRY} attempts — aborting pipeline.")
    sys.exit(1)


def _fatal(label: str, reason: str):
    logger.critical(f"[{label}] FATAL — {reason}")
    sys.exit(1)


# ═══════════════════════════════════════════════════════════
# (1) MD 文件完整性检测
# ═══════════════════════════════════════════════════════════

def _check_md_once() -> dict:
    all_dirs = sorted([d for d in BASE_DIR.iterdir()
                       if d.is_dir() and not d.name.startswith('.')])
    if not all_dirs:
        return {"total": 0, "complete": 0, "missing_count": 0, "missing_items": []}

    required_patterns = [
        ("摘要", ["摘要"]),
        ("术语", ["术语"]),
        ("问答", ["问答", "問答"]),
        ("原文", ["original", "原文"]),
    ]
    complete = 0
    missing = []
    for folder in all_dirs:
        md_files = list(folder.glob("*.md"))
        found = {}
        for label, patterns in required_patterns:
            matched = any(any(p in f.name for p in patterns) for f in md_files)
            if not matched:
                found[label] = None
        if not found:
            complete += 1
        else:
            for label in found:
                missing.append({"folder": folder.name, "missing": label})

    return {"total": len(all_dirs), "complete": complete,
            "missing_count": len(missing), "missing_items": missing}


def check_md_integrity():
    logger.info("=" * 55)
    logger.info("  (1) MD File Integrity Check")
    logger.info("=" * 55)
    result = _retry_or_die("md_integrity", _check_md_once)
    logger.info(f"  Total folders:    {result['total']}")
    logger.info(f"  Complete (4/4):   {result['complete']}")
    logger.info(f"  Missing files:    {result['missing_count']}")
    if result["missing_count"] > 0:
        for m in result["missing_items"][:10]:
            logger.info(f"    {m['folder'][:40]} — missing: {m['missing']}")
        _fatal("md_integrity", f"{result['missing_count']} folders missing required files")
    logger.info("  VERDICT: PASS")
    return result


# ═══════════════════════════════════════════════════════════
# (2) 空/乱码文件检测
# ═══════════════════════════════════════════════════════════

def _check_corrupt_once() -> dict:
    all_dirs = sorted([d for d in BASE_DIR.iterdir()
                       if d.is_dir() and not d.name.startswith('.')])
    empty_files, short_files, corrupt_files = [], [], []
    total_files = 0
    total_bytes = 0

    for folder in all_dirs:
        for f in folder.glob("*.md"):
            total_files += 1
            try:
                content = f.read_text(encoding="utf-8")
                size = len(content)
                total_bytes += size
                if size == 0:
                    empty_files.append(str(f))
                elif size < 50:
                    short_files.append(str(f))
                else:
                    non_printable = sum(1 for c in content
                                        if ord(c) < 32 and ord(c) not in (9, 10, 13))
                    if non_printable / size > 0.3:
                        corrupt_files.append({"path": str(f), "size": size,
                                               "ratio": f"{non_printable/size:.2%}"})
            except UnicodeDecodeError:
                corrupt_files.append({"path": str(f), "size": f.stat().st_size,
                                       "error": "UnicodeDecodeError"})
            except Exception as e:
                corrupt_files.append({"path": str(f), "error": str(e)[:100]})

    return {"total_files": total_files, "size_mb": round(total_bytes / (1024*1024), 1),
            "empty": len(empty_files), "short": len(short_files),
            "corrupt": len(corrupt_files), "empty_list": empty_files,
            "short_list": short_files, "corrupt_list": corrupt_files}


def check_corrupt_files():
    logger.info("\n" + "=" * 55)
    logger.info("  (2) Empty / Corrupt File Check")
    logger.info("=" * 55)
    result = _retry_or_die("corrupt_files", _check_corrupt_once)
    logger.info(f"  Total .md files:  {result['total_files']}")
    logger.info(f"  Total size:       {result['size_mb']} MB")
    logger.info(f"  Empty / Short / Corrupt: {result['empty']} / {result['short']} / {result['corrupt']}")
    if result["empty"] > 0:
        for ef in result["empty_list"][:5]:
            logger.warning(f"    EMPTY: {ef}")
    if result["short"] > 0:
        for sf in result["short_list"][:5]:
            logger.warning(f"    SHORT: {sf}")
    if result["corrupt"] > 0:
        for cf in result["corrupt_list"][:5]:
            logger.warning(f"    CORRUPT: {cf}")
    total_issues = result["empty"] + result["short"] + result["corrupt"]
    if total_issues > 0:
        _fatal("corrupt_files", f"{total_issues} bad file(s) found — cannot proceed")
    logger.info("  VERDICT: PASS")
    return result


# ═══════════════════════════════════════════════════════════
# (3) Neo4j 配置校验
# ═══════════════════════════════════════════════════════════

def _check_neo4j_once() -> dict:
    try:
        nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
        nc.execute_query("RETURN 1 AS t")
    except Exception as e:
        _fatal("neo4j_config", f"connection failed: {e}")

    ver = nc.execute_query("CALL dbms.components() YIELD name, versions, edition "
                           "RETURN name, versions, edition")
    is_community = "community" in ver[0]["edition"].lower()

    try:
        idx = nc.execute_query("SHOW INDEXES YIELD name, type, state")
        vector_idx = [i for i in idx if i["type"] == "VECTOR"]
        offline = [i for i in vector_idx if i["state"] != "ONLINE"]
    except Exception as e:
        _fatal("neo4j_config", f"index query failed: {e}")

    ep = nc.execute_query("MATCH (ep:Episode) RETURN COUNT(ep) AS c")[0]["c"]
    ent = nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"]
    rel = nc.execute_query(
        "MATCH ()-[r]->() WHERE type(r) <> \"EXTRACTED_FROM\" "
        "AND type(r) <> \"BELONGS_TO_COMMUNITY\" "
        "AND type(r) <> \"HAS_CONFLICT\" RETURN COUNT(r) AS c"
    )[0]["c"]
    nc.close()

    return {"edition": "community" if is_community else "enterprise",
            "vector_idx_total": len(vector_idx),
            "vector_idx_offline": len(offline),
            "episodes": ep, "entities": ent, "relations": rel}


def check_neo4j_config():
    logger.info("\n" + "=" * 55)
    logger.info("  (3) Neo4j Config Check")
    logger.info("=" * 55)
    result = _retry_or_die("neo4j_config", _check_neo4j_once)
    logger.info(f"  Edition: {result['edition']}")
    logger.info(f"  Vector indexes: {result['vector_idx_total']} "
                f"({result['vector_idx_offline']} offline)")
    if result["vector_idx_offline"] > 0:
        _fatal("neo4j_config", f"{result['vector_idx_offline']} indexes NOT ONLINE")
    logger.info(f"  Graph: {result['episodes']} episodes | "
                f"{result['entities']} entities | {result['relations']} relations")
    if result["episodes"] == 0 or result["entities"] == 0:
        _fatal("neo4j_config", "Graph appears empty — check Neo4j database")
    logger.info("  VERDICT: PASS")
    return result


# ═══════════════════════════════════════════════════════════
# (4) 阶段备份
# ═══════════════════════════════════════════════════════════

def _find_neo4j_data_dir() -> Path:
    """从 Neo4j 配置或环境变量自动发现 data 目录"""
    try:
        nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
        configs = nc.execute_query(
            "CALL dbms.listConfig() YIELD name, value "
            "WHERE name = 'server.directories.data' RETURN value LIMIT 1"
        )
        nc.close()
        if configs:
            return Path(configs[0]["value"])
    except Exception:
        pass
    for cand in [Path(r"%USERPROFILE%\neo4j\neo4j-community-5.26.27\data"),
                 Path.home() / "neo4j" / "neo4j-community-5.26.27" / "data"]:
        if cand.exists():
            return cand
    return None


def _backup_once() -> dict:
    neo4j_data_dir = _find_neo4j_data_dir()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_name = f"neo4j_backup_{timestamp}_{hashlib.md5(timestamp.encode()).hexdigest()[:6]}"
    backup_path = BACKUP_DIR / backup_name
    backup_path.mkdir(parents=True, exist_ok=True)

    try:
        nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
        ep = nc.execute_query("MATCH (ep:Episode) RETURN COUNT(ep) AS c")[0]["c"]
        ent = nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"]
        nc.close()
    except Exception as e:
        _fatal("backup", f"cannot query Neo4j: {e}")

    # metadata
    (backup_path / "metadata.json").write_text(
        json.dumps({"timestamp": timestamp, "episodes": ep, "entities": ent},
                   ensure_ascii=False, indent=2), encoding="utf-8")

    data_copied = False
    if neo4j_data_dir and neo4j_data_dir.exists():
        data_backup = backup_path / "neo4j_data_copy"
        try:
            shutil.copytree(
                str(neo4j_data_dir), str(data_backup),
                ignore=shutil.ignore_patterns("*.log", "*.log.*", "raft-log*", "checkpoint*"),
                dirs_exist_ok=True)
            data_copied = True
        except Exception as e:
            logger.warning(f"  Data copy skipped: {e}")

    backup_size = sum(f.stat().st_size for f in backup_path.rglob("*") if f.is_file())
    return {"path": str(backup_path), "size_mb": round(backup_size / (1024*1024), 1),
            "data_copied": data_copied, "episodes": ep, "entities": ent}


def backup_neo4j():
    logger.info("\n" + "=" * 55)
    logger.info("  (4) Neo4j Stage Backup (dump)")
    logger.info("=" * 55)
    result = _retry_or_die("backup", _backup_once)
    logger.info(f"  Backup path: {result['path']}")
    logger.info(f"  Backup size: {result['size_mb']} MB (data_copied={result['data_copied']})")
    logger.info(f"  Graph state: {result['episodes']} episodes | {result['entities']} entities")
    logger.info("  VERDICT: PASS")
    return result


# ═══════════════════════════════════════════════════════════
# 主入口
# ═══════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Module 1: Environment Check & Backup v2.0"
    )
    parser.add_argument("--md", action="store_true", help="MD file integrity check only")
    parser.add_argument("--corrupt", action="store_true", help="Empty / corrupt file check only")
    parser.add_argument("--neo4j", action="store_true", help="Neo4j config check only")
    parser.add_argument("--backup", action="store_true", help="Neo4j stage backup only")
    parser.add_argument("--all", action="store_true", help="Run ALL checks + backup")
    parser.add_argument("--force", action="store_true", help="Force re-run even if today already passed")
    args = parser.parse_args()

    if not any(vars(args).values()):
        args.all = True

    # ── 状态持久化：当日已通过则跳过 ──
    if not args.force and _check_or_skip():
        return

    start = time.time()

    if args.md or args.all:
        check_md_integrity()

    if args.corrupt or args.all:
        check_corrupt_files()

    if args.neo4j or args.all:
        check_neo4j_config()

    if args.backup or args.all:
        backup_neo4j()

    # ── 全部通过后写入标记 ──
    _mark_passed()

    elapsed = time.time() - start
    logger.info(f"\nAll checks passed in {elapsed:.0f}s — mark written to {MARK_FILE}")


if __name__ == "__main__":
    main()
