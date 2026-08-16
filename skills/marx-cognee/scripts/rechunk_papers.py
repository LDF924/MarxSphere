"""
Re-chunk all 208 papers into dense sliding-window DocumentChunks.

Workflow:
  1. Scan D:/Desktop/ov_import for .original.md files
  2. For each paper, split text into 500-char chunks (250-char overlap)
  3. Create new DocumentChunk nodes in Neo4j linked to TextDocument
  4. Delete old DocumentChunks (keep TextSummary and Entity nodes intact)
  5. Rebuild LanceDB vector embeddings for all new chunks

Usage: python scripts/rechunk_papers.py [--dry-run]
"""
import hashlib, json, os, re, sys, time, uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import dotenv; dotenv.load_dotenv(override=True)

from neo4j import GraphDatabase

NEO4J_URI = os.environ.get("GRAPH_DATABASE_URL", "bolt://127.0.0.1:11003")
NEO4J_AUTH = ("neo4j", "neo4j123")
OV_IMPORT = Path("D:/Desktop/ov_import")
CHUNK_SIZE = 500   # chars per chunk
CHUNK_STEP = 250   # sliding window step (50% overlap)
DRY_RUN = "--dry-run" in sys.argv
BATCH_SIZE = 100   # Neo4j batch insert size


def scan_papers(base: Path) -> list[tuple[str, Path]]:
    """Recursively scan for .original.md files in subdirectories."""
    papers = []
    for entry in base.iterdir():
        if not entry.is_dir() or entry.name.startswith('.'):
            continue
        # Check if this dir contains .original.md directly
        orig_files = list(entry.glob("*.original.md"))
        if orig_files:
            papers.append((entry.name, orig_files[0]))
        else:
            # This might be a category directory — scan one level deeper
            for sub in entry.iterdir():
                if sub.is_dir() and not sub.name.startswith('.'):
                    orig_files2 = list(sub.glob("*.original.md"))
                    if orig_files2:
                        papers.append((sub.name, orig_files2[0]))
    return papers


def sliding_window(text: str, size: int = CHUNK_SIZE, step: int = CHUNK_STEP) -> list[str]:
    """Split text into overlapping sliding windows."""
    chunks = []
    if len(text) <= size:
        return [text]
    for start in range(0, len(text) - size + 1, step):
        chunks.append(text[start:start + size])
    # Always include the tail
    last_start = max(0, len(text) - size)
    if last_start > 0 and text[last_start:last_start + size] not in chunks:
        chunks.append(text[last_start:])
    return chunks


def find_textdocument_id(driver, paper_name: str) -> str | None:
    """Find the TextDocument node ID for a paper by matching its raw_data_location."""
    with driver.session() as s:
        # Try name match first (URL-encoded)
        from urllib.parse import quote
        encoded = quote(paper_name, safe='')
        r = s.run(
            "MATCH (td:TextDocument) WHERE td.name CONTAINS $name OR td.name = $name "
            "RETURN td.id AS id, td.raw_data_location AS loc LIMIT 1",
            name=encoded[:100]
        ).single()
        if r:
            return r["id"]

        # Fallback: try substring match on raw_data_location
        r = s.run(
            "MATCH (td:TextDocument) WHERE td.raw_data_location IS NOT NULL "
            "RETURN td.id AS id, td.name AS name, td.raw_data_location AS loc LIMIT 500"
        ).data()

        # Match by paper title in the name
        for rec in r:
            from urllib.parse import unquote
            decoded = unquote(rec.get("name", ""))
            if paper_name[:20] in decoded or decoded[:20] in paper_name:
                return rec["id"]
    return None


def delete_old_chunks(driver):
    """Delete existing DocumentChunk nodes and their relationships + drop LanceDB table."""
    with driver.session() as s:
        r = s.run("MATCH (dc:DocumentChunk) DETACH DELETE dc RETURN count(dc) AS c").single()
        print(f"  Deleted {r['c']} old DocumentChunk nodes")
    # V96: 同步清理 LanceDB — 旧 chunk ID 向量与新 ID 不匹配, 必须删表重建
    try:
        from cognee.infrastructure.databases.vector import get_vector_engine
        import asyncio
        async def _drop():
            ve = get_vector_engine()
            if await ve.has_collection("DocumentChunk_text"):
                await ve.delete_collection("DocumentChunk_text")
                print("  Dropped old LanceDB DocumentChunk_text collection")
        asyncio.run(_drop())
    except Exception as e:
        print(f"  WARNING: LanceDB drop failed (may not exist): {e}")


def insert_new_chunks(driver, paper_name: str, td_id: str, chunks: list[str]):
    """Batch-insert DocumentChunk nodes linked to a TextDocument."""
    inserted = 0
    for batch_start in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[batch_start:batch_start + BATCH_SIZE]
        with driver.session() as s:
            for i, chunk_text in enumerate(batch):
                chunk_idx = batch_start + i
                chunk_id = str(uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    f"{td_id}|chunk_{chunk_idx}|{hashlib.md5(chunk_text.encode()).hexdigest()[:8]}"
                ))
                text_hash = hashlib.md5(chunk_text.encode()).hexdigest()
                try:
                    s.run("""
                        MATCH (td:TextDocument {id: $td_id})
                        CREATE (dc:DocumentChunk:__Node__ {
                            id: $chunk_id,
                            text: $text,
                            name: $name,
                            type: 'DocumentChunk',
                            chunk_index: $chunk_idx,
                            text_hash: $text_hash,
                            created_at: $ts
                        })
                        CREATE (dc)-[:is_part_of]->(td)
                    """,
                        td_id=td_id, chunk_id=chunk_id, text=chunk_text,
                        name=f"{paper_name[:60]}_chunk_{chunk_idx}",
                        chunk_idx=chunk_idx, text_hash=text_hash,
                        ts=int(time.time() * 1000)
                    )
                    inserted += 1
                except Exception as e:
                    print(f"    ERROR inserting chunk {chunk_idx} for {paper_name[:30]}: {e}")
    return inserted


def main():
    print("=" * 70)
    print("Re-chunking papers into 500-char sliding windows")
    print(f"  DRY_RUN={DRY_RUN}  CHUNK_SIZE={CHUNK_SIZE}  STEP={CHUNK_STEP}")
    print("=" * 70)

    driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)

    # Step 1: Scan papers (recursive — handles category directories)
    papers = scan_papers(OV_IMPORT)
    if not papers:
        # Try adding the one known category dir
        for sub in OV_IMPORT.iterdir():
            if sub.is_dir() and not sub.name.startswith('.'):
                papers = scan_papers(sub)
                if papers:
                    break
    print(f"\nScanning — found {len(papers)} paper directories...")

    paper_files = []
    for name, fpath in papers:
        paper_files.append((name, fpath))

    print(f"Found {len(paper_files)} papers with .original.md files")

    # Step 2: Chunk and count
    total_chunks = 0
    paper_chunks = []
    for name, fpath in paper_files:
        try:
            text = fpath.read_text(encoding="utf-8")
        except Exception as e:
            print(f"  SKIP {name[:40]}: {e}")
            continue
        chunks = sliding_window(text)
        paper_chunks.append((name, fpath, chunks))
        total_chunks += len(chunks)

    print(f"Total chunks to create: {total_chunks}")
    avg_chunks = total_chunks / max(len(paper_chunks), 1)
    print(f"Average chunks per paper: {avg_chunks:.1f}")

    if DRY_RUN:
        print("\n[DRY RUN] Would:")
        print(f"  1. Delete 1327 old DocumentChunks")
        print(f"  2. Create {total_chunks} new DocumentChunks (500-char sliding windows)")
        print(f"  3. Link them to 845 TextDocuments")
        print(f"\nSample chunks from first paper ({paper_files[0][0][:40]}):")
        name, fpath, chunks = paper_chunks[0]
        print(f"  Paper: {len(chunks)} chunks")
        for i, c in enumerate(chunks[:3]):
            print(f"  Chunk {i}: {c[:120]}..." if len(c) > 120 else f"  Chunk {i}: {c}")
        driver.close()
        return

    # Step 3: Delete old chunks
    print("\nDeleting old DocumentChunks...")
    delete_old_chunks(driver)

    # Step 4: Insert new chunks
    print(f"\nInserting {len(paper_chunks)} papers' chunks...")
    total_inserted = 0
    matched = 0
    unmatched = 0

    for i, (name, fpath, chunks) in enumerate(paper_chunks):
        td_id = find_textdocument_id(driver, name)
        if not td_id:
            unmatched += 1
            if unmatched <= 5:
                print(f"  UNMATCHED: {name[:50]}")
            continue
        matched += 1
        inserted = insert_new_chunks(driver, name, td_id, chunks)
        total_inserted += inserted
        if (i + 1) % 20 == 0 or i < 3:
            print(f"  [{i+1:3d}/{len(paper_chunks)}] {name[:40]:40s} {inserted} chunks (total: {total_inserted})")

    print(f"\nDone:")
    print(f"  Papers matched to TextDocuments: {matched}")
    print(f"  Papers unmatched (no TextDocument): {unmatched}")
    print(f"  Total chunks inserted: {total_inserted}")

    # Step 5: Verify
    with driver.session() as s:
        r = s.run("MATCH (dc:DocumentChunk) RETURN count(dc) AS c").single()
        print(f"  Verified DocumentChunk count: {r['c']}")
        r = s.run("MATCH (dc:DocumentChunk)-[:is_part_of]->(td:TextDocument) RETURN count(*) AS c").single()
        print(f"  With is_part_of link: {r['c']}")

        r = s.run("""
            MATCH (dc:DocumentChunk)
            RETURN avg(size(dc.text)) AS avg_chars, min(size(dc.text)) AS min_chars,
                   max(size(dc.text)) AS max_chars
        """).single()
        if r and r['avg_chars'] is not None:
            print(f"  Chunk sizes: avg={r['avg_chars']:.0f} min={r['min_chars']} max={r['max_chars']}")
        else:
            print("  Chunk sizes: N/A (no chunks)")

    driver.close()
    print(f"\nNext step: Rebuild LanceDB vector embeddings for the {total_inserted} new chunks")
    print("Run: python scripts/reembed_chunks.py")


if __name__ == "__main__":
    main()
