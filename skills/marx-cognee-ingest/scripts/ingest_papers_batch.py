#!/usr/bin/env python3
"""
Single-shot Cognee batch ingest — no while loop, single exit, 4-layer protection.

Architecture:
  Layer 1 — Process lock (sys.exit BEFORE import cognee if lock held)
  Layer 2 — Empty batch guard (exit BEFORE pipeline creation)
  Layer 3 — Neo4j :IngestMarker {processing_flag} mutual exclusion (no completed_flag spam)
  Layer 4 — SQLite WAL + busy_timeout, wiped BEFORE import
"""

import os, sys, time, json, shutil, atexit, sqlite3
from pathlib import Path
from datetime import datetime

# ══════════════════════════════════════════════════════════════════
# LAYER 1: Process lock — BEFORE any heavy import.
# ══════════════════════════════════════════════════════════════════

LOCK_FILE = Path(r"%USERPROFILE%\cognee\cognee_ingest.lock")

def _release_lock():
    if LOCK_FILE.exists():
        LOCK_FILE.unlink(missing_ok=True)

if LOCK_FILE.exists():
    age = time.time() - LOCK_FILE.stat().st_mtime
    if age < 7200:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] LOCK ACTIVE ({age:.0f}s). "
              f"Remove {LOCK_FILE} if stale.", flush=True)
        sys.exit(1)
    else:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Stale lock ({age:.0f}s), removing.", flush=True)
        LOCK_FILE.unlink(missing_ok=True)

LOCK_FILE.write_text(str(os.getpid()), "utf-8")
atexit.register(_release_lock)
print(f"[{datetime.now().strftime('%H:%M:%S')}] Lock acquired (PID {os.getpid()})", flush=True)

# ══════════════════════════════════════════════════════════════════
# LAYER 4: SQLite WAL — BEFORE Cognee touches the DB.
# ══════════════════════════════════════════════════════════════════

COGNEE_DB = Path(r"%USERPROFILE%\cognee\cognee\.cognee_system\databases\cognee_db")

def wipe_sqlite():
    for suffix in ["", "-wal", "-shm"]:
        f = Path(str(COGNEE_DB) + suffix)
        try:
            if f.exists():
                f.unlink()
        except PermissionError:
            pass

def init_sqlite_pragmas():
    COGNEE_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(COGNEE_DB))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA wal_autocheckpoint=1000")
    conn.close()
    print(f"[{datetime.now().strftime('%H:%M:%S')}] SQLite WAL enabled (timeout=30s)", flush=True)

wipe_sqlite()
init_sqlite_pragmas()

# aiosqlite timeout patch
try:
    import aiosqlite as _aiosqlite
    _orig_connect = _aiosqlite.connect
    def _patched_connect(*args, **kwargs):
        kwargs.setdefault("timeout", 30.0)
        return _orig_connect(*args, **kwargs)
    _aiosqlite.connect = _patched_connect
    print(f"[{datetime.now().strftime('%H:%M:%S')}] aiosqlite.connect timeout=30s patched", flush=True)
except ImportError:
    pass

# ══════════════════════════════════════════════════════════════════
# Import Cognee
# ══════════════════════════════════════════════════════════════════

os.chdir(r"%USERPROFILE%\cognee")
sys.path.insert(0, r"%USERPROFILE%\cognee")
from dotenv import load_dotenv
load_dotenv(".env")

import cognee
from neo4j import GraphDatabase
import asyncio

URI = os.getenv("GRAPH_DATABASE_URL", "bolt://127.0.0.1:11003")
USER = os.getenv("GRAPH_DATABASE_USERNAME", "neo4j")
PASS = os.getenv("GRAPH_DATABASE_PASSWORD", "neo4j123")
PAPER_ROOT = Path(r"D:\Desktop\ov_import")
BATCH_DIR = Path(r"%USERPROFILE%\cognee\.batch_current")
CACHE_FILE = Path(r"%USERPROFILE%\cognee\.batch_cache.json")
BATCH_SIZE = 30
MAX_RETRIES = 3
RATE_SLEEP = 15

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

# ══════════════════════════════════════════════════════════════════
# LAYER 3: Neo4j IngestMarker — processing_flag only, no completed_flag spam.
# ══════════════════════════════════════════════════════════════════

def _neo4j():
    d = GraphDatabase.driver(URI, auth=(USER, PASS))
    d.verify_connectivity()
    return d

def get_stats():
    d = _neo4j(); s = d.session()
    td = s.run("MATCH (n:TextDocument) RETURN count(n) AS c").single()["c"]
    en = s.run("MATCH (n:Entity) RETURN count(n) AS c").single()["c"]
    total = s.run("MATCH (n) RETURN count(n) AS c").single()["c"]
    rels = s.run("MATCH ()-[r]->() RETURN count(r) AS c").single()["c"]
    s.close(); d.close()
    return total, en, td, rels


def folder_completion_report(cache):
    """Per-folder completion summary — fixes cache-count ambiguity (Fault #2).

    Returns {folders_total, folders_done, folders_pending, done_pct}
    so the user sees folder-level (not file-level) progress at a glance.
    """
    import os as _os
    all_dirs = []
    for d in sorted(PAPER_ROOT.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        all_dirs.append(d)
    for d in sorted(PAPER_ROOT.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        try:
            for sub in sorted(d.iterdir()):
                if sub.is_dir() and not sub.name.startswith("."):
                    all_dirs.append(sub)
        except OSError:
            pass
    done = sum(1 for d in all_dirs if d.name in cache.get("processed", {}))
    return {
        "folders_total": len(all_dirs),
        "folders_done": done,
        "folders_pending": len(all_dirs) - done,
        "done_pct": round(100 * done / len(all_dirs), 1) if all_dirs else 0,
    }

def split_glossary_terms(folder_path):
    """Pre-process glossary files so each term line becomes a standalone paragraph.

    Cognee's chunker needs enough textual context to extract entities per term.
    A bare noun-list (one term per line) produces only 1 summary entity (Fault #5).
    Rewriting each term as a short definitional sentence gives the LLM enough signal
    to create one Entity node per term.
    """
    glossary_file = folder_path / "术语表.md"
    if not glossary_file.exists():
        return
    raw = glossary_file.read_text("utf-8")
    lines = [l.strip() for l in raw.split("\n") if l.strip() and not l.startswith("#")]
    if len(lines) <= 1:
        return  # already prose or too short
    enriched = []
    for line in lines:
        line = line.lstrip("-*• ").strip()
        if not line:
            continue
        # Turn bare term into a claim sentence the LLM can anchor an Entity on
        enriched.append(f"术语条目：{line}。该术语是本文论证体系中的一个独立概念节点，承载特定的理论含义与分析功能。")
    glossary_file.write_text("\n\n".join(enriched), "utf-8")
    log(f"  split_glossary: {len(enriched)} terms expanded in {folder_path.name[:40]}")


def dedup_glossary_terms(folder_path):
    """Remove glossary lines that are pure copies of the abstract's term list.

    The 术语表.md is often auto-generated by pdf2obsidian and can duplicate the
    abstract's keyword section word-for-word.  Cognee's vector-level INSERT OR
    IGNORE catches duplicates post-hoc (Fault #7), but we can save embedding
    cost by stripping exact-duplicate lines BEFORE add().
    """
    glossary_file = folder_path / "术语表.md"
    abstract_file = folder_path / "摘要.md"
    if not glossary_file.exists() or not abstract_file.exists():
        return
    glossary_text = glossary_file.read_text("utf-8")
    abstract_text = abstract_file.read_text("utf-8")
    glossary_lines = [l.strip() for l in glossary_text.split("\n") if l.strip()]
    new_lines = []
    removed = 0
    for line in glossary_lines:
        clean = line.lstrip("-*• #").strip()
        if len(clean) > 4 and clean in abstract_text:
            removed += 1
            continue
        new_lines.append(line)
    if removed > 0:
        glossary_file.write_text("\n".join(new_lines), "utf-8")
        log(f"  dedup_glossary: {removed} duplicate lines removed from {folder_path.name[:40]}")

def mark_processing(name):
    d = _neo4j(); s = d.session()
    s.run("MERGE (m:IngestMarker {paper_name:$n}) SET m.processing_flag=1, m.updated_at=datetime()", n=name)
    s.close(); d.close()

def mark_completed(name):
    """processing_flag=0 = completed. Single flag, no UnknownPropertyKeyWarning."""
    d = _neo4j(); s = d.session()
    s.run("MERGE (m:IngestMarker {paper_name:$n}) SET m.processing_flag=0, m.updated_at=datetime()", n=name)
    s.close(); d.close()

def is_processed(name):
    """Only flag=0 = completed. flag=1 = in-progress (may be stuck) → allow re-process."""
    d = _neo4j(); s = d.session()
    r = s.run(
        "MATCH (m:IngestMarker {paper_name:$n}) WHERE m.processing_flag=0 RETURN m LIMIT 1",
        n=name
    ).single()
    s.close(); d.close()
    return r is not None


def detect_empty_markers():
    """Find IngestMarker nodes with processing_flag=1 but zero Neo4j data.
    Returns list of paper_names safe to delete + re-process.
    Handles Chinese folder names by matching against TextDocument.raw_data_location."""
    d = _neo4j(); s = d.session()
    markers = s.run(
        "MATCH (m:IngestMarker) WHERE m.processing_flag=1 "
        "RETURN m.paper_name AS n"
    ).data()
    if not markers:
        s.close(); d.close()
        return []
    all_locs = [r["loc"] for r in s.run(
        "MATCH (td:TextDocument) RETURN DISTINCT td.raw_data_location AS loc"
    ).data() if r["loc"]]
    s.close(); d.close()
    empty = []
    for m in markers:
        name = m["n"]
        if not any(name in str(loc) for loc in all_locs):
            empty.append(name)
    return empty


def clear_empty_markers(paper_names):
    """Delete IngestMarker nodes for papers with no Neo4j data (safe re-process)."""
    if not paper_names:
        return 0
    d = _neo4j(); s = d.session()
    count = 0
    for name in paper_names:
        s.run("MATCH (m:IngestMarker {paper_name:$n}) DETACH DELETE m", n=name)
        count += 1
    s.close(); d.close()
    return count

# ══════════════════════════════════════════════════════════════════
# Cache + pending
# ══════════════════════════════════════════════════════════════════

def load_cache():
    if CACHE_FILE.exists():
        return json.loads(CACHE_FILE.read_text("utf-8"))
    return {"processed": {}, "last_run": ""}

def save_cache(c):
    CACHE_FILE.write_text(json.dumps(c, ensure_ascii=False, indent=2), "utf-8")

def get_pending(cache):
    """Returns up to BATCH_SIZE papers NOT in cache AND NOT marked completed.

    `is_processed()` (Neo4j IngestMarker flag=0) is authoritative.  Both root-level
    folders AND nested subdirectories (one level deep) are scanned.
    """
    all_dirs = []
    # Scan root level (skip dot-prefixed)
    for d in sorted(PAPER_ROOT.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        all_dirs.append(d)
    # Scan nested directories (1 level deep) — catch papers in grouped subfolders
    for d in sorted(PAPER_ROOT.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        try:
            for sub in sorted(d.iterdir()):
                if sub.is_dir() and not sub.name.startswith("."):
                    all_dirs.append(sub)
        except OSError:
            pass

    pending = []
    for d in all_dirs:
        if len(pending) >= BATCH_SIZE:
            break

        # ── Authoritative: Neo4j IngestMarker flag=0 ──
        if is_processed(d.name):
            if d.name not in cache["processed"]:
                cache["processed"][d.name] = d.stat().st_mtime
            continue

        # ── Fallback: filesystem cache ──
        if d.name in cache["processed"]:
            continue

        pending.append(d)
    return pending

# ══════════════════════════════════════════════════════════════════
# Batch runner — add + cognify, 2-phase retry with reactive auto-heal
# ══════════════════════════════════════════════════════════════════

def _reactive_heal(error_msg: str):
    """触发式自愈：只在错误发生时检测+修复对应故障，成功则返回可重试的提示。"""
    msg = error_msg.lower()
    fixed = False

    # Fault #8: database is locked → clean SQLite WAL residue
    if "database is locked" in msg:
        db = Path(r"%USERPROFILE%\cognee\cognee\.cognee_system\databases\cognee_db")
        for suffix in ["-wal", "-shm"]:
            residue = Path(str(db) + suffix)
            if residue.exists():
                residue.unlink(missing_ok=True)
                log(f"[AUTO-HEAL] removed SQLite {suffix} (Fault #8)")
                fixed = True
        if fixed:
            log("[AUTO-HEAL] retry after SQLite cleanup...")

    # Fault #9: stale lock blocking re-run
    if "lock active" in msg or "permission" in msg:
        lock = Path(r"%USERPROFILE%\cognee\cognee_ingest.lock")
        if lock.exists():
            lock.unlink(missing_ok=True)
            log("[AUTO-HEAL] removed stale process lock (Fault #9)")
            fixed = True

    # Fault #14: litellm can't find provider → FALLBACK_MODEL missing prefix
    if "provider not provided" in msg or "llm provider" in msg:
        env_file = Path(r"%USERPROFILE%\cognee\.env")
        if env_file.exists():
            content = env_file.read_text("utf-8")
            if 'FALLBACK_MODEL="qwen-plus"' in content or "FALLBACK_MODEL=qwen-plus" in content:
                new_content = content.replace('FALLBACK_MODEL="qwen-plus"', 'FALLBACK_MODEL="openai/qwen-plus"')
                new_content = new_content.replace('FALLBACK_MODEL=qwen-plus', 'FALLBACK_MODEL="openai/qwen-plus"')
                env_file.write_text(new_content, "utf-8")
                log("[AUTO-HEAL] fixed FALLBACK_MODEL prefix → openai/qwen-plus (Fault #14)")
                fixed = True

    # Fault #3/#11: processing_flag=1 stuck markers with no data
    if "ingestmarker" in msg or "processing_flag" in msg:
        empty = detect_empty_markers()
        if empty:
            clear_empty_markers(empty)
            log(f"[AUTO-HEAL] cleared {len(empty)} empty IngestMarkers (Faults #3 #11)")
            fixed = True

    return fixed


async def run_batch(papers, batch_name):
    ds = f"capital_{batch_name}"
    if BATCH_DIR.exists():
        shutil.rmtree(BATCH_DIR)
    BATCH_DIR.mkdir()
    for d in papers:
        shutil.copytree(d, BATCH_DIR / d.name)

    # Pre-processing: split glossary noun-lists + dedup vs abstract (Faults #5, #7)
    for d in papers:
        dest = BATCH_DIR / d.name
        dedup_glossary_terms(dest)
        split_glossary_terms(dest)

    for d in papers:
        mark_processing(d.name)

    # Phase 1 — add
    add_ok = False
    for attempt in range(MAX_RETRIES):
        try:
            log(f"  cognee.add({len(papers)} papers, dataset={ds})")
            await cognee.add(str(BATCH_DIR), dataset_name=ds)
            add_ok = True; break
        except Exception as e:
            msg = str(e).lower()
            if "unique constraint" in msg:
                log(f"  [UNIQUE constraint — content dedup] proceeding to cognify")
                add_ok = True; break
            elif "database is locked" in msg:
                _reactive_heal(str(e))
                log(f"  [DB locked] sleep 15s after auto-heal"); await asyncio.sleep(15)
            elif "429" in msg:
                w = RATE_SLEEP * (attempt + 1)
                log(f"  [429] sleep {w}s"); await asyncio.sleep(w)
            elif "provider not provided" in msg or "llm provider" in msg:
                if _reactive_heal(str(e)):
                    log(f"  [FALLBACK FIXED] retrying...")
                else:
                    log(f"  add() Error: {str(e)[:300]}")
                    if attempt >= MAX_RETRIES - 1: break
                    await asyncio.sleep(5)
            else:
                log(f"  add() Error: {str(e)[:300]}")
                if attempt >= MAX_RETRIES - 1: break
                await asyncio.sleep(5)

    if not add_ok:
        for d in papers:
            mark_completed(d.name)  # processing_flag=0 = give up
        return False

    # Phase 2 — cognify
    for attempt in range(MAX_RETRIES):
        try:
            log(f"  cognee.cognify(datasets=[{ds}])")
            await cognee.cognify(datasets=[ds])
            for d in papers:
                mark_completed(d.name)
            return True
        except Exception as e:
            msg = str(e).lower()
            if "429" in msg:
                w = RATE_SLEEP * (attempt + 1)
                log(f"  [429] sleep {w}s"); await asyncio.sleep(w)
            elif "database is locked" in msg:
                _reactive_heal(str(e))
                log(f"  [DB locked] sleep 15s after auto-heal"); await asyncio.sleep(15)
            elif "provider not provided" in msg or "llm provider" in msg:
                if _reactive_heal(str(e)):
                    log(f"  [FALLBACK FIXED] retrying cognify...")
                else:
                    log(f"  cognify() Error: {str(e)[:300]}")
                    if attempt >= MAX_RETRIES - 1:
                        for d in papers:
                            mark_completed(d.name)
                        return False
                    await asyncio.sleep(5)
            else:
                log(f"  cognify() Error: {str(e)[:300]}")
                if attempt >= MAX_RETRIES - 1:
                    for d in papers:
                        mark_completed(d.name)
                    return False
                await asyncio.sleep(5)

    for d in papers:
        mark_completed(d.name)
    return False

# ══════════════════════════════════════════════════════════════════
# MAIN — single shot, zero while loops. One batch, then exit.
# ══════════════════════════════════════════════════════════════════

async def main():
    try:
        # ══════════════════════════════════════════════════════════════
        # LAYER 0: 前置条件检查 — 运行前必须满足，不满足就退出
        # ══════════════════════════════════════════════════════════════

        # 0.1 前置：.env 关键字段完整性（缺了跑不起来，直接退出）
        env_errors = []
        if not os.getenv("LLM_API_KEY"):
            env_errors.append("LLM_API_KEY is not set in .env")
        if not os.getenv("GRAPH_DATABASE_URL", "").startswith("bolt://"):
            env_errors.append("GRAPH_DATABASE_URL is not set (expected bolt://...)")
        if env_errors:
            for e in env_errors:
                log(f"FATAL: {e}")
            log("FATAL: .env 配置不完整，无法继续。修复 .env 后重试。")
            return

        # 0.2 前置：Neo4j 连通性（连不上后面全白费）
        try:
            _n4 = _neo4j()
            _n4.close()
            log("Neo4j 11003: 已连接")
        except Exception as ne:
            log(f"FATAL: Neo4j 11003 无法连接 — {str(ne)[:100]}")
            log("HINT: 先启动 Cognee Neo4j: neo4j-community-5.26.27-cognee\\bin\\neo4j.bat console")
            return

        # 0.3 前置：源目录存在
        if not PAPER_ROOT.exists():
            log(f"FATAL: 论文源目录不存在: {PAPER_ROOT}")
            return

        # 0.4 前置：cognee SDK 可导入
        try:
            import cognee as _cognee
        except ImportError:
            log("FATAL: cognee SDK 未安装，请在 C:\\Users\\HUAWEI\\cognee\\.venv312 中安装")
            return

        cache = load_cache()
        total, en, td, rels = get_stats()
        report = folder_completion_report(cache)
        log(f"Neo4j: {total} nodes, {en} Entities, {td} TextDocs, {rels} rels")
        log(f"Folders: {report['folders_done']}/{report['folders_total']} done ({report['done_pct']}%), "
            f"{report['folders_pending']} pending")

        # ── Cost guard: estimate before touching LLM (Fault #17 context-awareness) ──
        papers = get_pending(cache)
        if not papers:
            log("No pending papers. Exiting — no pipeline created.")
            return

        # Rough token estimate: ~3000 tokens/paper for entity extraction + summary
        est_tokens = len(papers) * 4 * 3000
        log(f"Cost estimate: ~{est_tokens:,} LLM tokens (~¥{est_tokens * 0.000004:.2f} RMB) for this batch")
        if report["folders_pending"] > 60:
            log(f"WARNING: {report['folders_pending']} folders remain. "
                f"Consider splitting across sessions to stay under context limits (Faults #22-24).")

        log(f"Pending: {len(papers)} papers (cap {BATCH_SIZE})")
        batch_name = datetime.now().strftime("%Y%m%d_%H%M%S")
        log(f"======== BATCH {batch_name}: {len(papers)} papers ========")
        for i, p in enumerate(papers):
            log(f"  [{i+1}/{len(papers)}] {p.name[:80]}")

        t0 = time.time()
        ok = await run_batch(papers, batch_name)

        if ok:
            for p in papers:
                cache["processed"][p.name] = p.stat().st_mtime
            save_cache(cache)
            total, en, td, rels = get_stats()
            log(f"DONE in {time.time()-t0:.0f}s | {total} nodes, {en} Entities, {td} TextDocs")
            log(f"Cache: {len(cache['processed'])} papers tracked")
        else:
            log(f"FAILED after {MAX_RETRIES} retries")

        total, en, td, rels = get_stats()
        log(f"===== FINAL: {total} nodes, {en} Entities, {td} TextDocs =====")

    finally:
        _release_lock()
        log("Lock released.")

if __name__ == "__main__":
    asyncio.run(main())
