"""
Cross-graph entity alignment: map entities between Cognee (Neo4j 11003)
and Graphiti (Neo4j 11001) using name matching + embedding similarity.

Strategy (3-tier matching):
  Tier 1: Exact name match (fast, high confidence)
  Tier 2: Embedding cosine similarity via DashScope text-embedding-v4 (medium)
  Tier 3: difflib fuzzy match for remaining candidates (fallback)

Output: scripts/cross_graph_alignment.json
  {entity_id: {graphiti_name, cognee_name, method, confidence, ...}}

Usage:
  python scripts/align_cross_graph.py                  # full alignment
  python scripts/align_cross_graph.py --dry-run        # preview match stats
  python scripts/align_cross_graph.py --top-n 500      # align top entities only
"""
import asyncio
import json
import os
import re
import sys
import time
from difflib import SequenceMatcher
from pathlib import Path

import dotenv
import httpx
import numpy as np
from neo4j import GraphDatabase
from openai import OpenAI

dotenv.load_dotenv(override=True)

# ── Config ──
COGNEE_URI = os.getenv("GRAPH_DATABASE_URL", "bolt://127.0.0.1:11003")
COGNEE_AUTH = ("neo4j", "neo4j123")
GRAPHITI_URI = "bolt://127.0.0.1:11001"
GRAPHITI_AUTH = ("neo4j", "neo4j123")

EMBEDDING_MODEL = "text-embedding-v4"
EMBEDDING_ENDPOINT = os.getenv("EMBEDDING_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1")
EMBEDDING_API_KEY = os.getenv("EMBEDDING_API_KEY", os.getenv("LLM_API_KEY", ""))

OUTPUT = Path(__file__).resolve().parent / "cross_graph_alignment.json"
DRY_RUN = "--dry-run" in sys.argv
TOP_N = int(sys.argv[sys.argv.index("--top-n") + 1]) if "--top-n" in sys.argv else None

# Minimum confidence to include in output
MIN_CONFIDENCE = 0.70
# Embedding similarity threshold for Tier 2
EMBED_SIM_THRESHOLD = 0.82
# Fuzzy threshold for Tier 3
FUZZY_THRESHOLD = 0.80

BATCH_SIZE = 10  # DashScope text-embedding-v4 batch limit


def _normalize(name: str) -> str:
    """Strip punctuation/whitespace for comparison."""
    n = str(name).strip().lower()
    n = re.sub(r"[（()）\[\]【】\"\"''《》「」『』.,;:：；，。]", "", n)
    n = re.sub(r"\s+", " ", n).strip()
    return n


def fetch_cognee_entities(driver) -> list[dict]:
    """Fetch all non-dirty Entity nodes from Cognee Neo4j."""
    with driver.session() as s:
        recs = s.run("""
            MATCH (e:Entity)
            WHERE e.name IS NOT NULL AND e.name <> ''
              AND (e.dirty_source IS NULL OR e.dirty_source <> 'publication_citation')
            OPTIONAL MATCH (e)-[:is_a]->(et:EntityType)
            RETURN e.id AS id, e.name AS name, e.description AS description,
                   e.topological_rank AS rank, collect(DISTINCT et.name)[..3] AS types
            ORDER BY COALESCE(e.topological_rank, 0.5) DESC
        """).data()
    return recs


def fetch_graphiti_entities(driver) -> list[dict]:
    """Fetch all Entity nodes from Graphiti Neo4j."""
    with driver.session() as s:
        recs = s.run("""
            MATCH (e:Entity)
            WHERE e.name IS NOT NULL AND e.name <> ''
            OPTIONAL MATCH (e)-[r:RELATES_TO]-(other:Entity)
            RETURN e.name AS id, e.name AS name,
                   e.name_embedding IS NOT NULL AS has_embedding,
                   count(DISTINCT r) AS degree
            ORDER BY degree DESC
        """).data()
    return recs


def compute_embeddings(names: list[str], client: OpenAI) -> dict[str, list[float]]:
    """Batch-compute embeddings via DashScope."""
    result = {}
    for i in range(0, len(names), BATCH_SIZE):
        batch = names[i:i + BATCH_SIZE]
        try:
            resp = client.embeddings.create(
                model=EMBEDDING_MODEL, input=batch,
            )
            for item, emb in zip(batch, resp.data):
                result[item] = emb.embedding
        except Exception as e:
            print(f"  Embed batch {i // BATCH_SIZE} error: {e}")
            time.sleep(2)
            # Retry once
            try:
                resp = client.embeddings.create(
                    model=EMBEDDING_MODEL, input=batch,
                )
                for item, emb in zip(batch, resp.data):
                    result[item] = emb.embedding
            except Exception:
                print(f"  Skipping batch {i // BATCH_SIZE}")
    return result


def cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two vectors."""
    if not a or not b:
        return 0.0
    va, vb = np.array(a), np.array(b)
    return float(np.dot(va, vb) / (np.linalg.norm(va) * np.linalg.norm(vb) + 1e-10))


def main():
    print("=" * 60)
    print("Cross-Graph Entity Alignment: Cognee ↔ Graphiti")
    print("=" * 60)

    # ── Connect ──
    c_driver = GraphDatabase.driver(COGNEE_URI, auth=COGNEE_AUTH)
    g_driver = GraphDatabase.driver(GRAPHITI_URI, auth=GRAPHITI_AUTH)
    try:
        c_driver.verify_connectivity()
        print(f"Cognee  OK: {COGNEE_URI}")
    except Exception as e:
        print(f"Cognee  FAIL: {e}")
        return
    try:
        g_driver.verify_connectivity()
        print(f"Graphiti OK: {GRAPHITI_URI}")
    except Exception as e:
        print(f"Graphiti FAIL: {e}")
        return

    # ── Fetch entities ──
    print("\nFetching entities...")
    c_entities = fetch_cognee_entities(c_driver)
    g_entities = fetch_graphiti_entities(g_driver)
    c_driver.close()
    g_driver.close()

    if TOP_N:
        c_entities = c_entities[:TOP_N]
        g_entities = g_entities[:TOP_N]

    print(f"  Cognee:   {len(c_entities)} entities")
    print(f"  Graphiti: {len(g_entities)} entities")

    # ── Tier 1: Exact name match (normalized) ──
    print("\n── Tier 1: Exact name match ──")
    c_norm_map = {_normalize(e["name"]): e for e in c_entities}
    g_norm_map = {_normalize(e["name"]): e for e in g_entities}

    matched_norms = set(c_norm_map.keys()) & set(g_norm_map.keys())
    tier1_matches = []
    for norm in matched_norms:
        tier1_matches.append({
            "graphiti_id": g_norm_map[norm]["id"],
            "graphiti_name": g_norm_map[norm]["name"],
            "cognee_id": c_norm_map[norm]["id"],
            "cognee_name": c_norm_map[norm]["name"],
            "method": "exact_match",
            "confidence": 1.0,
            "cognee_types": c_norm_map[norm].get("types", []),
            "cognee_description": (c_norm_map[norm].get("description") or "")[:200],
        })

    print(f"  Exact matches: {len(tier1_matches)}")

    # Remaining unmatched
    c_unmatched = [e for e in c_entities if _normalize(e["name"]) not in matched_norms]
    g_unmatched = [e for e in g_entities if _normalize(e["name"]) not in matched_norms]
    print(f"  Cognee remaining:   {len(c_unmatched)}")
    print(f"  Graphiti remaining: {len(g_unmatched)}")

    # ── Tier 2: Embedding similarity ──
    print("\n── Tier 2: Embedding similarity ──")
    tier2_matches = []
    if c_unmatched and g_unmatched:
        embed_client = OpenAI(
            base_url=EMBEDDING_ENDPOINT,
            api_key=EMBEDDING_API_KEY,
            http_client=httpx.Client(timeout=60),
        )

        # Compute embeddings for unmatched names
        c_names = [e["name"] for e in c_unmatched]
        g_names = [e["name"] for e in g_unmatched]
        all_names = c_names + g_names
        print(f"  Computing embeddings for {len(all_names)} names...")
        embs = compute_embeddings(all_names, embed_client)
        print(f"  Got {len(embs)} embeddings")

        c_embs = {n: embs[n] for n in c_names if n in embs}
        g_embs = {n: embs[n] for n in g_names if n in embs}

        # Cross-compare: for each Cognee name, find best Graphiti match
        # 矩阵化: 15900×10633 cosine 用 numpy 一次算完 (原双重循环 O(n²) 数小时)
        c_names_all = list(c_embs.keys())
        g_names_all = list(g_embs.keys())
        C = np.array([c_embs[n] for n in c_names_all])      # (Nc, d)
        G = np.array([g_embs[n] for n in g_names_all])      # (Ng, d)
        C_norm = C / (np.linalg.norm(C, axis=1, keepdims=True) + 1e-10)
        G_norm = G / (np.linalg.norm(G, axis=1, keepdims=True) + 1e-10)
        sim_mat = C_norm @ G_norm.T                          # (Nc, Ng) 全矩阵
        tier2_matched_c = set()
        tier2_matched_g = set()

        # 贪心匹配: 每轮取全局最大 sim 且 >= 阈值
        import heapq
        Nc, Ng = sim_mat.shape
        best_idx = np.argmax(sim_mat, axis=1)
        best_val = sim_mat[np.arange(Nc), best_idx]
        order = np.argsort(-best_val)
        for ci in order:
            c_name = c_names_all[ci]
            if c_name in tier2_matched_c:
                continue
            gi = best_idx[ci]
            g_name = g_names_all[gi]
            if g_name in tier2_matched_g:
                # 已被占, 找该行次优未占用目标
                cand = np.argsort(-sim_mat[ci])
                chosen = None
                for g2 in cand:
                    if g_names_all[g2] not in tier2_matched_g:
                        if sim_mat[ci, g2] >= EMBED_SIM_THRESHOLD:
                            chosen = g2
                        break
                if chosen is None:
                    continue
                gi = chosen
                g_name = g_names_all[gi]
            sim = float(sim_mat[ci, gi])
            if sim >= EMBED_SIM_THRESHOLD:
                ce = next(e for e in c_unmatched if e["name"] == c_name)
                ge = next(e for e in g_unmatched if e["name"] == g_name)
                tier2_matches.append({
                    "graphiti_id": ge["id"],
                    "graphiti_name": ge["name"],
                    "cognee_id": ce["id"],
                    "cognee_name": ce["name"],
                    "method": "embedding_similarity",
                    "confidence": round(sim, 4),
                    "cognee_types": ce.get("types", []),
                    "cognee_description": (ce.get("description") or "")[:200],
                })
                tier2_matched_c.add(c_name)
                tier2_matched_g.add(g_name)

        print(f"  Embedding matches: {len(tier2_matches)} (threshold={EMBED_SIM_THRESHOLD})")

        # Update unmatched
        c_unmatched = [e for e in c_unmatched if e["name"] not in tier2_matched_c]
        g_unmatched = [e for e in g_unmatched if e["name"] not in tier2_matched_g]
    else:
        print("  Skipped (no unmatched entities)")

    print(f"  Cognee remaining:   {len(c_unmatched)}")
    print(f"  Graphiti remaining: {len(g_unmatched)}")

    # ── Tier 3: Fuzzy match ──
    print("\n── Tier 3: Fuzzy string match ──")
    tier3_matches = []
    if c_unmatched and g_unmatched:
        g_names_unmatched = [e["name"] for e in g_unmatched]
        matched_g_names = set()

        for ce in c_unmatched:
            # 用 get_close_matches 快速筛选 (内部基于 SequenceMatcher + 快速过滤)
            from difflib import get_close_matches
            cands = get_close_matches(ce["name"], g_names_unmatched, n=1, cutoff=FUZZY_THRESHOLD)
            if not cands:
                continue
            best_g_name = cands[0]
            if best_g_name in matched_g_names:
                continue
            best_ratio = SequenceMatcher(None, ce["name"], best_g_name).ratio()
            if best_ratio >= FUZZY_THRESHOLD:
                ge = next(e for e in g_unmatched if e["name"] == best_g_name)
                tier3_matches.append({
                    "graphiti_id": ge["id"],
                    "graphiti_name": ge["name"],
                    "cognee_id": ce["id"],
                    "cognee_name": ce["name"],
                    "method": "fuzzy_match",
                    "confidence": round(best_ratio, 4),
                    "cognee_types": ce.get("types", []),
                    "cognee_description": (ce.get("description") or "")[:200],
                })
                matched_g_names.add(best_g_name)

        print(f"  Fuzzy matches: {len(tier3_matches)} (threshold={FUZZY_THRESHOLD})")

    # ── Assemble results ──
    all_matches = tier1_matches + tier2_matches + tier3_matches
    total_c = len(c_entities)
    total_g = len(g_entities)
    coverage_cognee = len(set(m["cognee_id"] for m in all_matches)) / max(total_c, 1)
    coverage_graphiti = len(set(m["graphiti_id"] for m in all_matches)) / max(total_g, 1)

    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "embedding_model": EMBEDDING_MODEL,
        "stats": {
            "cognee_total": total_c,
            "graphiti_total": total_g,
            "total_aligned": len(all_matches),
            "by_method": {
                "exact_match": len(tier1_matches),
                "embedding_similarity": len(tier2_matches),
                "fuzzy_match": len(tier3_matches),
            },
            "coverage_cognee": round(coverage_cognee, 4),
            "coverage_graphiti": round(coverage_graphiti, 4),
        },
        "matches": all_matches,
        "unmatched": {
            "cognee_count": len(c_unmatched),
            "graphiti_count": len(g_unmatched),
            "cognee_sample": [e["name"][:60] for e in c_unmatched[:30]],
            "graphiti_sample": [e["name"][:60] for e in g_unmatched[:30]],
        },
    }

    print(f"\n{'='*60}")
    print(f"Alignment Summary")
    print(f"{'='*60}")
    print(f"  Exact:      {len(tier1_matches)}")
    print(f"  Embedding:  {len(tier2_matches)}")
    print(f"  Fuzzy:      {len(tier3_matches)}")
    print(f"  Total:      {len(all_matches)}")
    print(f"  Coverage:   Cognee {coverage_cognee:.1%} / Graphiti {coverage_graphiti:.1%}")

    if DRY_RUN:
        print("\n[DRY RUN] Would write to:", OUTPUT)
        # Print first 5 matches per tier
        for tier_name, tier in [("Exact", tier1_matches), ("Embedding", tier2_matches), ("Fuzzy", tier3_matches)]:
            if tier:
                print(f"\n  Sample {tier_name} matches:")
                for m in tier[:5]:
                    print(f"    [{m['confidence']:.2f}] {m['cognee_name'][:40]} ↔ {m['graphiti_name'][:40]}")
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nAlignment written to: {OUTPUT}")
        print(f"  {len(all_matches)} entity pairs mapped across engines")


if __name__ == "__main__":
    main()
