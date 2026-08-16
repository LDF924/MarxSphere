#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
module_chunk.py — 论文语义切块 + 向量索引入库
══════════════════════════════════════════════════════════════
Implements:
  1. Semantic chunking: split paper .original.md into ~500-char overlapping paragraphs
  2. Chunk vectorization: embed via text-embedding-v4 (1024d)
  3. Neo4j storage: create Chunk nodes with FT + vector indexes
  4. Parent-child wiring: Chunk-[:CHUNK_OF]->Episode

Architecture:
  Episode (208 nodes, existing)
    ↑ :CHUNK_OF
  Chunk (new, ~2000 nodes)
    - text: chunked paragraph text
    - chunk_index: paragraph order (1-based)
    - chunk_type: original | abstract | qa | terms
    - chunk_vector: 1024d embedding
    - indexes: FT on text, Vector on chunk_vector

Design decisions:
  - Chunk 4 files per paper: .original.md, 摘要.md, 术语表.md, 问答.md
  - 500 char chunks with 100 char overlap
  - Batch embed: 10 chunks/batch
  - Skip empty/boilerplate chunks (<50 chars)
  - Idempotent: skips papers that already have chunks

Expected output:
  - ~1500-2000 Chunk nodes (500 char chunks across 208 papers × 4 files)
  - 3 new Neo4j indexes: chunk_text_ft (FULLTEXT), chunk_vector_idx (VECTOR)
"""

import sys, json, time, re
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger
from pipeline.api_client import QwenEmbeddingClient

logger = get_logger("module_chunk")

# ── Config ─────────────────────────────────────────────────
BASE_DIR = Path(r"D:\Desktop\ov_import")
CHUNK_SIZE = 500       # characters per chunk
CHUNK_OVERLAP = 100    # character overlap between chunks
BATCH_SIZE = 10        # embedding batch size
MIN_CHUNK_LEN = 50     # skip chunks shorter than this

# Files to chunk per paper
CHUNK_FILES = [
    ("original", "*.original.md"),
    ("abstract", "摘要.md"),
    ("qa",       "问答.md"),
    ("terms",    "术语表.md"),
]


# ═══════════════════════════════════════════════════════════════
# Step 1: Chunk text into semantic paragraphs
# ═══════════════════════════════════════════════════════════════

def clean_text(text: str) -> str:
    """Remove frontmatter, HTML, excessive whitespace."""
    # Remove YAML frontmatter
    text = re.sub(r'^---\n.*?\n---\n', '', text, flags=re.DOTALL)
    # Remove markdown headers for chunking (keep the text)
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    # Remove table formatting
    text = re.sub(r'\|.*?\|', ' ', text)
    # Collapse whitespace
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r'[ \t]+', ' ', text)
    return text.strip()


def chunk_text(text: str, chunk_size: int = CHUNK_SIZE,
               overlap: int = CHUNK_OVERLAP) -> List[str]:
    """Split cleaned text into overlapping chunks, preserving paragraph boundaries."""
    text = clean_text(text)
    if len(text) < MIN_CHUNK_LEN:
        return []

    # Split by paragraph first
    paragraphs = [p.strip() for p in text.split('\n\n') if len(p.strip()) >= MIN_CHUNK_LEN]

    chunks = []
    for para in paragraphs:
        if len(para) <= chunk_size:
            chunks.append(para)
        else:
            # Split long paragraph into overlapping windows
            start = 0
            while start < len(para):
                end = start + chunk_size
                chunk = para[start:end].strip()
                if len(chunk) >= MIN_CHUNK_LEN:
                    chunks.append(chunk)
                start += (chunk_size - overlap)
                if start >= len(para):
                    break

    return chunks


# ═══════════════════════════════════════════════════════════════
# Step 2: Build chunk metadata
# ═══════════════════════════════════════════════════════════════

def extract_keywords(text: str) -> List[str]:
    """Extract suspect keywords from glossary file."""
    # Heuristic: terms are bolded in markdown with Chinese characters
    terms = re.findall(r'\*\*([^*]+?)\*\*', text)
    return [t.strip() for t in terms if len(t.strip()) >= 2]


def resolve_metadata(paper_dir: Path) -> Dict:
    """Extract metadata from paper files."""
    meta = {"keywords": [], "methods": None, "journal": None, "year": None}

    # Extract from 术语表.md (glossary)
    terms_file = paper_dir / "术语表.md"
    if terms_file.exists():
        terms_text = terms_file.read_text(encoding="utf-8")
        meta["keywords"] = extract_keywords(terms_text)[:20]

    # Extract from 问答.md for methodology hints
    qa_file = paper_dir / "问答.md"
    if qa_file.exists():
        qa_text = qa_file.read_text(encoding="utf-8")
        # Heuristic: find "研究方法" segments
        method_match = re.search(r'研究[方式]法[：:]\s*(.{10,100})', qa_text)
        if method_match:
            meta["methods"] = method_match.group(1)[:100]

    return meta


# ═══════════════════════════════════════════════════════════════
# Step 3: Main pipeline
# ═══════════════════════════════════════════════════════════════

def ensure_indexes(nc: Neo4jConnection):
    """Create FULLTEXT and VECTOR indexes for Chunk nodes."""
    try:
        nc.execute_query(
            "CREATE FULLTEXT INDEX chunk_text_ft IF NOT EXISTS "
            "FOR (c:Chunk) ON EACH [c.text]")
        logger.info("  chunk_text_ft: created/verified")
    except Exception as e:
        logger.warning(f"  chunk_text_ft: {e}")

    try:
        nc.execute_query(
            "CREATE VECTOR INDEX chunk_vector_idx IF NOT EXISTS "
            "FOR (c:Chunk) ON (c.chunk_vector) "
            "OPTIONS {indexConfig: {`vector.dimensions`: 1024, `vector.similarity_function`: 'cosine'}}")
        logger.info("  chunk_vector_idx: created/verified")
    except Exception as e:
        logger.warning(f"  chunk_vector_idx: {e}")


def paper_already_chunked(nc: Neo4jConnection, paper_name: str) -> bool:
    """Check if this paper already has chunks in Neo4j."""
    try:
        r = nc.execute_query(
            "MATCH (c:Chunk)-[:CHUNK_OF]->(ep:Episode {source_folder: $pn}) "
            "RETURN count(c) AS cnt LIMIT 1",
            {"pn": paper_name})
        return r[0]["cnt"] > 0
    except Exception:
        return False


def ingest_chunks(nc: Neo4jConnection, emb: QwenEmbeddingClient):
    """Main loop: for each paper, chunk it and write to Neo4j."""
    papers = sorted([d for d in BASE_DIR.iterdir()
                     if d.is_dir() and not d.name.startswith('.')])

    total_chunks = 0
    skipped = 0
    failed = 0
    papers_processed = 0

    for idx, paper_dir in enumerate(papers):
        paper_name = paper_dir.name

        # Skip if already chunked
        if paper_already_chunked(nc, paper_name):
            skipped += 1
            if skipped % 50 == 0:
                logger.info(f"  [{idx+1}/{len(papers)}] {papers_processed} new, {skipped} skipped")
            continue

        # Collect all chunks for this paper
        paper_chunks: List[Tuple[str, str, int, Path]] = []  # (chunk_type, text, idx, file)

        for chunk_type, file_pattern in CHUNK_FILES:
            matches = list(paper_dir.glob(file_pattern))
            for file_path in matches:
                try:
                    text = file_path.read_text(encoding="utf-8")
                    chunks = chunk_text(text)
                    for ci, chunk_text_content in enumerate(chunks):
                        paper_chunks.append((chunk_type, chunk_text_content, ci + 1, file_path))
                except Exception as e:
                    logger.warning(f"  Failed to read {file_path}: {e}")

        if not paper_chunks:
            failed += 1
            continue

        # Extract metadata
        meta = resolve_metadata(paper_dir)

        # Batch embed
        chunk_texts = [ct[1] for ct in paper_chunks]
        all_vectors = []
        for batch_start in range(0, len(chunk_texts), BATCH_SIZE):
            batch = chunk_texts[batch_start:batch_start + BATCH_SIZE]
            try:
                vecs = emb.embed_batch(batch)
                if vecs:
                    all_vectors.extend(vecs)
                else:
                    all_vectors.extend([None] * len(batch))
            except Exception as e:
                logger.warning(f"  Embed failed at batch {batch_start}: {e}")
                all_vectors.extend([None] * len(batch))

        # Write to Neo4j
        written = 0
        session = nc.new_session()
        try:
            for ci, (chunk_type, chunk_text_content, chunk_idx, file_path) in enumerate(paper_chunks):
                vec = all_vectors[ci] if ci < len(all_vectors) else None
                if vec is None:
                    continue

                session.run("""
                    MATCH (ep:Episode {source_folder: $paper_name})
                    CREATE (c:Chunk {
                        text: $text,
                        chunk_index: $chunk_idx,
                        chunk_type: $chunk_type,
                        source_file: $source_file,
                        chunk_vector: $vec,
                        created_at: datetime()
                    })
                    CREATE (c)-[:CHUNK_OF]->(ep)
                """, {
                    "paper_name": paper_name,
                    "text": chunk_text_content,
                    "chunk_idx": chunk_idx,
                    "chunk_type": chunk_type,
                    "source_file": file_path.name,
                    "vec": vec,
                })
                written += 1
        except Exception as e:
            logger.warning(f"  Write failed for {paper_name}: {e}")
            failed += 1
            session.close()
            continue
        session.close()

        # Update Episode metadata
        try:
            nc.execute_write("""
                MATCH (ep:Episode {source_folder: $pn})
                SET ep.keywords = $kw,
                    ep.research_methods = $rm,
                    ep.chunked_at = datetime()
            """, {
                "pn": paper_name,
                "kw": meta["keywords"],
                "rm": meta.get("methods"),
            })
        except Exception:
            pass

        total_chunks += written
        papers_processed += 1

        if papers_processed % 20 == 0:
            logger.info(f"  [{idx+1}/{len(papers)}] {papers_processed} processed, "
                       f"{skipped} skipped, {total_chunks} chunks")

    logger.info(f"Done: {papers_processed} papers, {total_chunks} chunks, "
                f"{skipped} skipped, {failed} failed")


def main():
    logger.info("=" * 60)
    logger.info("Module: Semantic Chunking + Indexing")
    logger.info("=" * 60)

    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    emb = QwenEmbeddingClient()

    # Step 1: Ensure indexes
    logger.info("Step 1: Creating indexes...")
    ensure_indexes(nc)

    # Step 2: Chunk and ingest
    logger.info("Step 2: Chunking and ingesting papers...")
    ingest_chunks(nc, emb)

    # Step 3: Index status
    logger.info("Step 3: Index status...")
    try:
        for row in nc.execute_query("SHOW INDEXES YIELD name, state, populationPercent"):
            if 'chunk' in str(row.get('name', '')).lower():
                logger.info(f"  {row['name']}: state={row['state']}, populated={row.get('populationPercent', '?')}%")
    except Exception:
        pass

    nc.close()
    logger.info("=" * 60)
    logger.info("Chunking pipeline complete")
    logger.info("=" * 60)


if __name__ == "__main__":
    main()
