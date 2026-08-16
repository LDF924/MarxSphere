#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 Neo4j 回滚 / 恢复脚本
============================================================
从 module1_env_check.py 的备份中恢复 Neo4j 数据库

操作:
  python neo4j_rollback.py --list              # 列出可用备份
  python neo4j_rollback.py --latest            # 恢复到最新备份
  python neo4j_rollback.py --restore <name>    # 恢复到指定备份
"""

import sys, shutil, argparse
from pathlib import Path
from datetime import datetime

BACKUP_DIR = Path(r"%USERPROFILE%\neo4j\neo4j-community-5.26.27\data\neo4j_backups")

# ── 自动发现 Neo4j data 目录 ──
def _find_data_dir() -> Path:
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        from pipeline import Neo4jConnection
        nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
        configs = nc.execute_query(
            "CALL dbms.listConfig() YIELD name, value "
            "WHERE name = 'server.directories.data' RETURN value LIMIT 1")
        nc.close()
        if configs:
            return Path(configs[0]["value"])
    except Exception:
        pass
    for cand in [Path(r"%USERPROFILE%\neo4j\neo4j-community-5.26.27\data")]:
        if cand.exists():
            return cand
    return None


def list_backups():
    """列出所有备份"""
    if not BACKUP_DIR.exists():
        print("No backups found.")
        return []
    backups = sorted(BACKUP_DIR.glob("neo4j_backup_*"), reverse=True)
    if not backups:
        print("No backups found.")
        return []
    print("=" * 60)
    print(f"  Available backups ({len(backups)} total)")
    print("=" * 60)
    for b in backups:
        size = sum(f.stat().st_size for f in b.rglob("*") if f.is_file()) / (1024*1024)
        ts = b.stat().st_mtime
        age_h = (datetime.now().timestamp() - ts) / 3600
        meta_file = b / "metadata.json"
        ep = "?"
        if meta_file.exists():
            import json
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            ep = meta.get("episodes", "?")
        print(f"  {b.name}")
        print(f"     size: {size:.1f} MB | age: {age_h:.1f}h ago | episodes: {ep}")
    return backups


def restore_backup(backup_path: Path):
    """恢复指定备份到 Neo4j data 目录"""
    data_dir = _find_data_dir()
    if not data_dir:
        print("ERROR: Cannot locate Neo4j data directory.")
        print("Please set NEO4J_HOME or ensure Neo4j is accessible.")
        sys.exit(1)

    print(f"Neo4j data dir: {data_dir}")
    print(f"Backup path:    {backup_path}")

    data_copy = backup_path / "neo4j_data_copy"
    if not data_copy.exists():
        print("ERROR: Backup has no data copy — cannot restore.")
        print("Only full data backups can be restored.")
        sys.exit(1)

    print("\nWARNING: This will overwrite the current Neo4j data directory.")
    print("Neo4j must be STOPPED before restoring.")
    confirm = input("Proceed? (yes/no): ").strip().lower()
    if confirm != "yes":
        print("Aborted.")
        return

    # Safety: backup current data first
    safety_backup = BACKUP_DIR / f"pre_rollback_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    print(f"\nCreating safety backup: {safety_backup}")
    shutil.copytree(str(data_dir), str(safety_backup),
                    ignore=shutil.ignore_patterns("*.log", "*.log.*"),
                    dirs_exist_ok=True)
    print("Safety backup created.")

    # Clear current data
    print(f"\nClearing {data_dir}...")
    for item in data_dir.iterdir():
        if item.name in ("dbms", "transactions_data"):  # keep some system files
            continue
        if item.is_dir():
            shutil.rmtree(str(item), ignore_errors=True)
        else:
            item.unlink(missing_ok=True)

    # Copy backup over
    print(f"Restoring from {data_copy}...")
    shutil.copytree(str(data_copy), str(data_dir), dirs_exist_ok=True)

    print("\nRestore complete!")
    print(f"Safety backup: {safety_backup.name}")
    print("You can now start Neo4j.")


def main():
    parser = argparse.ArgumentParser(description="Neo4j Rollback / Restore")
    parser.add_argument("--list", action="store_true", help="List available backups")
    parser.add_argument("--latest", action="store_true", help="Restore latest backup")
    parser.add_argument("--restore", type=str, help="Restore specific backup by name")
    args = parser.parse_args()

    if args.list:
        list_backups()
        return

    if args.restore:
        backup_path = BACKUP_DIR / args.restore
        if not backup_path.exists():
            print(f"Backup not found: {args.restore}")
            sys.exit(1)
        restore_backup(backup_path)
        return

    if args.latest:
        backups = sorted(BACKUP_DIR.glob("neo4j_backup_*"), reverse=True)
        if not backups:
            print("No backups found.")
            sys.exit(1)
        restore_backup(backups[0])
        return

    # Default: list
    list_backups()


if __name__ == "__main__":
    main()
