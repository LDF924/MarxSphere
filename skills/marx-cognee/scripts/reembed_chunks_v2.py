"""
Re-embed all DocumentChunk nodes into LanceDB with full resilience.

Features:
  - Checkpoint-based resume: persists .reembed_checkpoint.json
  - Adaptive batch sizing: reduces batch on API errors, increases on success
  - Global try-except: logs failed chunk IDs, never terminates
  - Completion verification: prints stats at end

Usage: python scripts/reembed_chunks_v2.py [--batch-size 30] [--reset-checkpoint]
"""
import asyncio, json, os, sys, time
from pathlib import Path
from uuid import UUID, uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import dotenv; dotenv.load_dotenv(override=True)

from pydantic import BaseModel, Field
from cognee.infrastructure.engine.models.DataPoint import DataPoint, MetaData

BATCH_INIT = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--batch-size" else 30
CHECKPOINT_PATH = Path(__file__).resolve().parent / ".reembed_v3_checkpoint.json"
RESET = "--reset-checkpoint" in sys.argv


class ChunkDP(DataPoint):
    """Minimal DataPoint subclass for embedding DocumentChunks."""
    text: str = ""
    chunk_index: int = 0
    description: str = ""
    keywords: str = ""
    metadata: MetaData = Field(default_factory=lambda: {"index_fields": ["text"]})


def load_checkpoint() -> tuple[set[str], int]:
    """Return (completed_ids_set, completed_count)."""
    if CHECKPOINT_PATH.exists() and not RESET:
        try:
            data = json.loads(CHECKPOINT_PATH.read_text(encoding="utf-8"))
            return set(data.get("ids", [])), data.get("count", 0)
        except Exception:
            pass
    return set(), 0


def save_checkpoint(ids: set[str], count: int):
    CHECKPOINT_PATH.write_text(
        json.dumps({"ids": list(ids), "count": count, "ts": time.time()}, ensure_ascii=False),
        encoding="utf-8",
    )


async def main():
    from cognee.infrastructure.databases.vector import get_vector_engine
    from neo4j import GraphDatabase

    print("=" * 70)
    print(f"Re-embedding DocumentChunks (resilient, adaptive batch)")
    print(f"  Initial batch size: {BATCH_INIT}")
    print(f"  Checkpoint: {CHECKPOINT_PATH}")
    print(f"  Reset: {RESET}")
    print("=" * 70)

    neo4j_uri = os.environ.get("GRAPH_DATABASE_URL", "bolt://127.0.0.1:11003")
    driver = GraphDatabase.driver(neo4j_uri, auth=("neo4j", "neo4j123"))

    with driver.session() as s:
        total = s.run("MATCH (dc:DocumentChunk) RETURN count(dc) AS c").single()["c"]
    print(f"Total chunks in Neo4j: {total}")

    # Load checkpoint
    completed_ids, prev_count = load_checkpoint()
    print(f"Previously completed: {prev_count}")

    # V96: 清空旧表 + 断点重跑时 cleanup dirty vectors
    vector_engine = get_vector_engine()
    if not await vector_engine.has_collection("DocumentChunk_text"):
        await vector_engine.create_collection("DocumentChunk_text", DataPoint)
        print("Created DocumentChunk_text collection")
    elif RESET:
        # --reset-checkpoint: 删表重建, 清除脏向量
        await vector_engine.delete_collection("DocumentChunk_text")
        await vector_engine.create_collection("DocumentChunk_text", DataPoint)
        print("Reset: dropped and recreated DocumentChunk_text collection (clean slate)")

    # V96: delete orphans — LanceDB 中残留但 Neo4j 已不存在 chunk 的向量
    # 如果 LanceDB 向量数 > Neo4j chunk 数 → 存在孤儿, 自动删表重建
    try:
        import lancedb as _lb
        _db = _lb.connect("cognee/.cognee_system/databases/cognee.lancedb")
        if "DocumentChunk_text" in _db.table_names():
            _tbl = _db.open_table("DocumentChunk_text")
            _lance_rows = _tbl.count_rows()
            if _lance_rows > total:
                print(f"  WARNING: LanceDB has {_lance_rows} rows but Neo4j only {total} chunks — deleting orphans")
                await vector_engine.delete_collection("DocumentChunk_text")
                await vector_engine.create_collection("DocumentChunk_text", DataPoint)
                # 重置 checkpoint — 从头重跑
                if CHECKPOINT_PATH.exists():
                    CHECKPOINT_PATH.unlink()
                completed_ids = set()
                prev_count = 0
                print("  Cleaned: dropped table, reset checkpoint, will re-embed all chunks")
    except Exception:
        pass

    # Fetch ALL chunk IDs from Neo4j to compare with completed
    with driver.session() as s:
        all_rows = s.run("MATCH (dc:DocumentChunk) RETURN dc.id AS id, dc.text AS text ORDER BY dc.id").data()

    pending = [(r["id"], r["text"]) for r in all_rows if r["id"] not in completed_ids]
    print(f"Pending chunks to embed: {len(pending)}")

    if not pending:
        print("All chunks already embedded!")
        driver.close()
        return

    # Adaptive embedding loop
    batch_size = BATCH_INIT
    embedded = prev_count
    failed = 0
    i = 0

    while i < len(pending):
        batch = pending[i:i + batch_size]
        batch_dps = []
        batch_ids = set()
        for j, (cid, text) in enumerate(batch):
            dp = ChunkDP(
                id=UUID(cid),
                text=text,
                chunk_index=i + j,
                name=f"chunk_{i+j:05d}",
            )
            batch_dps.append(dp)
            batch_ids.add(cid)

        try:
            await vector_engine.create_data_points("DocumentChunk_text", batch_dps)
            embedded += len(batch_dps)
            completed_ids.update(batch_ids)
            pct = embedded * 100 / total
            print(f"  [{embedded:5d}/{total} ({pct:.0f}%)] batch={batch_size} OK")

            # Save checkpoint every 10 batches
            if (i // batch_size) % 10 == 0:
                save_checkpoint(completed_ids, embedded)

            # Adaptive: increase batch on success
            if batch_size < 50:
                batch_size = min(batch_size + 5, 50)

        except Exception as e:
            err_msg = str(e)[:100]
            print(f"  ERROR batch={batch_size} offset={i}: {type(e).__name__}: {err_msg}")

            # Adaptive: reduce batch on failure
            if batch_size > 5:
                batch_size = max(batch_size // 2, 5)
                print(f"  → Reduced batch_size to {batch_size}, retrying...")
                continue  # retry same batch with smaller size

            # If already at minimum, mark as failed and skip
            failed += len(batch_dps)
            print(f"  → Skipping {len(batch_dps)} chunks, marking as failed")
            for cid in batch_ids:
                completed_ids.add(cid)  # mark as done to avoid infinite retry
            save_checkpoint(completed_ids, embedded)

        i += len(batch)
        await asyncio.sleep(0.3)

    # Final save
    save_checkpoint(completed_ids, embedded)
    driver.close()

    print(f"\n{'=' * 70}")
    print("EMBEDDING COMPLETE")
    print(f"  Total in Neo4j:      {total}")
    print(f"  Successfully embedded: {embedded}")
    print(f"  Failed/skipped:        {failed}")
    print(f"  Checkpoint saved:      {CHECKPOINT_PATH}")
    print(f"{'=' * 70}")

    # Verify LanceDB
    try:
        import lancedb
        db = lancedb.connect("cognee/.cognee_system/databases/cognee.lancedb")
        tbl = db.open_table("DocumentChunk_text")
        actual = tbl.count_rows()
        print(f"\n  LanceDB DocumentChunk_text rows: {actual}")
        print(f"  Match: {'YES' if actual >= embedded else 'NO — missing ' + str(embedded - actual) + ' rows'}")
    except Exception as ex:
        print(f"\n  Could not verify LanceDB count: {ex}")


if __name__ == "__main__":
    asyncio.run(main())
