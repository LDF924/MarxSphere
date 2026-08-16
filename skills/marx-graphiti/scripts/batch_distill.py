#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量单文献蒸馏 — 含进度 & ETA 脚本来确定被调用"""
import sys, importlib.util, json, time
from pathlib import Path
from datetime import datetime

sys.path.insert(0, r"D:\Desktop\执行流程")

spec = importlib.util.spec_from_file_location(
    "module4", r"D:\Desktop\执行流程\模块4：双层知识蒸馏（完整版）.py"
)
module4 = importlib.util.module_from_spec(spec)
sys.modules["module4"] = module4
spec.loader.exec_module(module4)

from pipeline import Neo4jConnection

nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
engine = module4.LiteratureDistillation(nc)

base = Path(r"D:\Desktop\ov_import")
folders = sorted([d for d in base.iterdir() if d.is_dir() and not d.name.startswith(".")])

# 合并断点
checkpoint_file = Path(r"D:\Desktop\执行流程\.checkpoints\module4_distill_state.json")
checkpoint_file.parent.mkdir(parents=True, exist_ok=True)
processed = set()
if checkpoint_file.exists():
    processed = set(json.loads(checkpoint_file.read_text(encoding="utf-8")).get("processed_folders", []))
db_done = nc.execute_query("MATCH (ld:LiteratureDistill) RETURN ld.source_folder AS f")
processed |= set(r["f"] for r in db_done)

pending = [f for f in folders if f.name not in processed]
total = len(folders)
done = len(processed)
print(f"Total: {total} | Done: {done} | Pending: {len(pending)}")

if not pending:
    print("All done!")
    nc.close()
    sys.exit(0)

success = done
start_time = time.time()
papers_in_batch = 0
batch_start_time = time.time()

for i, folder in enumerate(pending):
    paper_start = time.time()
    print(f"[{i+1}/{len(pending)}] {folder.name[:60]}", flush=True)

    try:
        ok = engine.process_literature(folder)
        paper_elapsed = time.time() - paper_start

        if ok:
            processed.add(folder.name)
            success += 1
            papers_in_batch += 1
            checkpoint_file.write_text(
                json.dumps({"processed_folders": sorted(processed)}, ensure_ascii=False, indent=2),
                encoding="utf-8"
            )
            print(f"  OK ({paper_elapsed:.0f}s) | total={success}/{total}", flush=True)
        else:
            print(f"  SKIPPED ({paper_elapsed:.0f}s)", flush=True)

    except Exception as e:
        print(f"  ERROR: {type(e).__name__}: {str(e)[:200]}", flush=True)

    # ETA every 5 papers
    if papers_in_batch > 0 and papers_in_batch % 5 == 0:
        elapsed = (time.time() - batch_start_time) / 60
        remaining_papers = len(pending) - (i + 1)
        avg_min = elapsed / papers_in_batch
        eta_min = remaining_papers * avg_min
        print(f"  --- Batch: {papers_in_batch} papers in {elapsed:.1f}min | "
              f"ETA: {eta_min:.0f}min | "
              f"Progress: {success}/{total} ({100*success/total:.1f}%) ---", flush=True)

# Final report
total_elapsed = (time.time() - start_time) / 60
print(f"\nDone: {success}/{total} | Time: {total_elapsed:.0f}min")
print(f"Checkpoint: {checkpoint_file}")

# Count final
final_total = nc.execute_query("MATCH (ld:LiteratureDistill) RETURN COUNT(ld) AS total")[0]["total"]
with_vec = nc.execute_query(
    "MATCH (ld:LiteratureDistill) WHERE ld.distill_vector IS NOT NULL RETURN COUNT(ld) AS c"
)[0]["c"]
with_ent = nc.execute_query(
    "MATCH (ld:LiteratureDistill)-[:CORRESPONDS_TO]->(:Entity) RETURN COUNT(DISTINCT ld) AS c"
)[0]["c"]
print(f"Distill nodes: {final_total} | with vector: {with_vec} | with entity links: {with_ent}")
nc.close()
