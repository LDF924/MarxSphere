"""
11-Class graph quality defect detection + automated fix pipeline.

Detects low-quality nodes/edges across BOTH Cognee (11003) and Graphiti (11001)
Neo4j instances, then triggers targeted re-extraction.

Defect classes (see Figure 2 in skill doc):
  C1  MISSING_TYPE        Entity has no is_a EntityType edge (Cognee) or no semantic label
  C2  EMPTY_DESCRIPTION   Entity description is null or < 10 chars
  C3  ORPHAN_ENTITY       Entity has 0 outgoing/incoming non-structural edges
  C4  LOW_DEGREE          Entity degree < 2 (leaf node, poor connectivity)
  C5  GENERIC_TYPE        EntityType too broad (e.g. "concept" > 10% of all entities)
  C6  DUPLICATE_NAME      Entity names that differ only by whitespace/punctuation
  C7  DIRTY_SOURCE        Publication citation entity polluting graph context
  C8  VAGUE_RELATION      Relation type too generic or uninformative
  C9  WEAK_EDGE           Edge weight < 0.3 or missing source_node_id
  C10 EMBEDDING_MISSING   Entity has no embedding in LanceDB / no name_embedding
  C11 STALE_NODE          Node not updated in 30+ days (if timestamp available)

Fix actions per class:
  C1 → re-cognify: re-run entity type classification
  C2 → re-extract: re-generate entity description via LLM
  C3 → link: build CO_OCCURS_WITH or RELATES_TO edges
  C4 → enrich: add contextual edges from neighboring chunks
  C5 → refine: split generic EntityType into subtypes via LLM
  C6 → merge: dedup entities and redirect edges
  C7 → clean: flag dirty_source, downgrade topological_rank
  C8 → curate: re-extract edges with MARX_EDGE_TYPES constraint
  C9 → repair: fix edge weight or add source_node_id
  C10 → re-embed: re-run embed pipeline for missing vectors
  C11 → refresh: re-ingest stale papers

Usage:
  cd %USERPROFILE%/cognee
  .venv312/Scripts/python.exe scripts/defect_detector.py                    # detect only
  .venv312/Scripts/python.exe scripts/defect_detector.py --fix              # detect + fix
  .venv312/Scripts/python.exe scripts/defect_detector.py --target C1,C2,C7  # specific classes
  .venv312/Scripts/python.exe scripts/defect_detector.py --engine graphiti  # Graphiti only
  .venv312/Scripts/python.exe scripts/defect_detector.py --engine cognee    # Cognee only
  .venv312/Scripts/python.exe scripts/defect_detector.py --dry-run          # preview only
"""
import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

import dotenv

dotenv.load_dotenv(override=True)

from neo4j import GraphDatabase

# ── Config ──
COGNEE_URI = os.getenv("GRAPH_DATABASE_URL", "bolt://127.0.0.1:11003")
COGNEE_AUTH = ("neo4j", "neo4j123")
GRAPHITI_URI = "bolt://127.0.0.1:11001"
GRAPHITI_AUTH = ("neo4j", "neo4j123")

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "eval" / "defect_reports"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Thresholds
MIN_DESC_LENGTH = 10
LOW_DEGREE_THRESHOLD = 2
GENERIC_TYPE_RATIO = 0.10  # >10% of entities = too generic
WEAK_EDGE_WEIGHT = 0.3
STALE_DAYS = 30
ENTITY_EMBED_BATCH = 20


class DefectDetector:
    """Scans both Neo4j instances for 11 defect categories."""

    def __init__(self, engine: str = "both"):
        self.engine = engine
        self.drivers = {}
        self.results: dict[str, list[dict]] = defaultdict(list)
        self.stats: dict[str, dict] = {}

        if engine in ("cognee", "both"):
            self.drivers["cognee"] = GraphDatabase.driver(COGNEE_URI, auth=COGNEE_AUTH)
        if engine in ("graphiti", "both"):
            self.drivers["graphiti"] = GraphDatabase.driver(GRAPHITI_URI, auth=GRAPHITI_AUTH)

        for name, d in self.drivers.items():
            try:
                d.verify_connectivity()
                print(f"Connected: {name} ({d._pool.address})")
            except Exception as e:
                print(f"Connection failed: {name} — {e}")
                del self.drivers[name]

    # ── C1: MISSING_TYPE ──
    def detect_missing_type(self, engine: str):
        """Entities with no is_a EntityType edge (Cognee) or no semantic label (Graphiti)."""
        driver = self.drivers.get(engine)
        if not driver:
            return
        with driver.session() as s:
            if engine == "cognee":
                recs = s.run("""
                    MATCH (e:Entity)
                    WHERE NOT EXISTS { (e)-[:is_a]->(:EntityType) }
                    RETURN e.id AS id, e.name AS name, labels(e) AS labels
                    ORDER BY e.name LIMIT 500
                """).data()
            else:
                recs = s.run("""
                    MATCH (e:Entity)
                    WHERE NOT EXISTS { (e)-[:BELONGS_TO_COMMUNITY]->() }
                      AND NOT EXISTS { (e)-[:EXTRACTED_FROM]->() }
                    RETURN e.uuid AS id, e.name AS name, labels(e) AS labels
                    ORDER BY e.name LIMIT 500
                """).data()
        for r in recs:
            self.results["C1_MISSING_TYPE"].append({
                "engine": engine, "entity_id": r["id"],
                "entity_name": str(r.get("name", ""))[:80],
                "current_labels": r.get("labels", []),
            })

    # ── C2: EMPTY_DESCRIPTION ──
    def detect_empty_description(self, engine: str):
        driver = self.drivers.get(engine)
        if not driver:
            return
        field = "description" if engine == "cognee" else "name"
        with driver.session() as s:
            if engine == "cognee":
                recs = s.run("""
                    MATCH (e:Entity)
                    WHERE e.description IS NULL OR size(trim(e.description)) < $minlen
                    RETURN e.id AS id, e.name AS name, e.description AS description
                    ORDER BY e.name LIMIT 500
                """, minlen=MIN_DESC_LENGTH).data()
            else:
                # Graphiti entities don't have descriptions; check if name is sufficient
                recs = s.run("""
                    MATCH (e:Entity)
                    WHERE e.name IS NULL OR size(trim(e.name)) < $minlen
                    RETURN e.uuid AS id, e.name AS name
                    LIMIT 500
                """, minlen=MIN_DESC_LENGTH).data()
        for r in recs:
            self.results["C2_EMPTY_DESCRIPTION"].append({
                "engine": engine, "entity_id": r["id"],
                "entity_name": str(r.get("name", ""))[:80],
                "current_description": str(r.get("description", ""))[:100],
            })

    # ── C3: ORPHAN_ENTITY ──
    def detect_orphan(self, engine: str):
        """Entities with 0 non-structural edges (isolated in graph)."""
        driver = self.drivers.get(engine)
        if not driver:
            return
        structural = ["contains", "is_a", "is_part_of", "made_from", "summarized_in",
                       "CHUNK_OF", "BELONGS_TO_COMMUNITY", "EXTRACTED_FROM",
                       "DISTILL_FROM", "AGGREGATED_INTO"]
        with driver.session() as s:
            try:
                if engine == "cognee":
                    recs = s.run(f"""
                        MATCH (e:Entity)
                        OPTIONAL MATCH (e)-[r]-(other)
                        WHERE NOT type(r) IN [{', '.join(repr(x) for x in structural[:5])}]
                        WITH e, count(r) AS meaningful_degree
                        WHERE meaningful_degree = 0
                        RETURN e.id AS id, e.name AS name
                        ORDER BY e.name LIMIT 500
                    """).data()
                else:
                    recs = s.run(f"""
                        MATCH (e:Entity)
                        OPTIONAL MATCH (e)-[r]-(other)
                        WHERE NOT type(r) IN [{', '.join(repr(x) for x in structural[5:])}]
                        WITH e, count(r) AS meaningful_degree
                        WHERE meaningful_degree = 0
                        RETURN e.uuid AS id, e.name AS name
                        ORDER BY e.name LIMIT 500
                    """).data()
            except Exception:
                # Fallback: just count all edges (ignore structural exclusion)
                if engine == "graphiti":
                    recs = s.run("""
                        MATCH (e:Entity)
                        WHERE NOT EXISTS { (e)--() }
                        RETURN e.uuid AS id, e.name AS name LIMIT 500
                    """).data()
                else:
                    recs = s.run("""
                        MATCH (e:Entity)
                        WHERE NOT EXISTS { (e)--() }
                        RETURN e.id AS id, e.name AS name LIMIT 500
                    """).data()
        for r in recs:
            self.results["C3_ORPHAN_ENTITY"].append({
                "engine": engine, "entity_id": r["id"],
                "entity_name": str(r.get("name", ""))[:80],
            })

    # ── C4: LOW_DEGREE ──
    def detect_low_degree(self, engine: str):
        driver = self.drivers.get(engine)
        if not driver:
            return
        with driver.session() as s:
            if engine == "cognee":
                recs = s.run("""
                    MATCH (e:Entity)
                    OPTIONAL MATCH (e)-[r]-(other)
                    WITH e, count(r) AS deg
                    WHERE deg < $thresh AND deg > 0
                    RETURN e.id AS id, e.name AS name, deg
                    ORDER BY deg LIMIT 500
                """, thresh=LOW_DEGREE_THRESHOLD).data()
            else:
                recs = s.run("""
                    MATCH (e:Entity)
                    OPTIONAL MATCH (e)-[r]-(other)
                    WITH e, count(r) AS deg
                    WHERE deg < $thresh AND deg > 0
                    RETURN e.uuid AS id, e.name AS name, deg
                    ORDER BY deg LIMIT 500
                """, thresh=LOW_DEGREE_THRESHOLD).data()
        for r in recs:
            self.results["C4_LOW_DEGREE"].append({
                "engine": engine, "entity_id": r["id"],
                "entity_name": str(r.get("name", ""))[:80],
                "degree": r["deg"],
            })

    # ── C5: GENERIC_TYPE ──
    def detect_generic_type(self, engine: str):
        """EntityTypes that are too broad (>10% of all entities)."""
        driver = self.drivers.get(engine)
        if not driver or engine != "cognee":
            return  # Only Cognee has EntityType nodes
        with driver.session() as s:
            total = s.run("MATCH (e:Entity) RETURN count(e) AS c").single()["c"]
            recs = s.run("""
                MATCH (e:Entity)-[:is_a]->(et:EntityType)
                RETURN et.name AS type_name, count(e) AS cnt
                ORDER BY cnt DESC
            """).data()
        threshold = total * GENERIC_TYPE_RATIO
        for r in recs:
            if r["cnt"] > threshold:
                self.results["C5_GENERIC_TYPE"].append({
                    "engine": engine, "type_name": r["type_name"],
                    "count": r["cnt"], "pct": round(r["cnt"] / max(total, 1) * 100, 1),
                    "threshold_pct": round(GENERIC_TYPE_RATIO * 100, 1),
                })

    # ── C6: DUPLICATE_NAME ──
    def detect_duplicate_name(self, engine: str):
        """Entity names that differ only by whitespace/punctuation."""
        driver = self.drivers.get(engine)
        if not driver:
            return
        with driver.session() as s:
            if engine == "cognee":
                recs = s.run("""
                    MATCH (e:Entity)
                    WITH trim(replace(replace(toLower(e.name), ' ', ''), '_', '')) AS norm,
                         collect({id: e.id, name: e.name}) AS group
                    WHERE size(group) > 1
                    RETURN norm, group[..5] AS sample, size(group) AS cnt
                    ORDER BY cnt DESC LIMIT 100
                """).data()
            else:
                recs = s.run("""
                    MATCH (e:Entity)
                    WITH trim(replace(replace(toLower(e.name), ' ', ''), '_', '')) AS norm,
                         collect({id: e.uuid, name: e.name}) AS group
                    WHERE size(group) > 1
                    RETURN norm, group[..5] AS sample, size(group) AS cnt
                    ORDER BY cnt DESC LIMIT 100
                """).data()
        for r in recs:
            self.results["C6_DUPLICATE_NAME"].append({
                "engine": engine, "normalized_name": r["norm"],
                "count": r["cnt"], "sample": r["sample"],
            })

    # ── C7: DIRTY_SOURCE ──
    def detect_dirty_source(self, engine: str):
        """Publication citation entities polluting the graph (Cognee only)."""
        driver = self.drivers.get(engine)
        if not driver or engine != "cognee":
            return
        with driver.session() as s:
            # Already flagged
            flagged = s.run("""
                MATCH (e:Entity {dirty_source: 'publication_citation'})
                RETURN count(e) AS c
            """).single()["c"]
            # New candidates (not yet flagged)
            candidates = s.run("""
                MATCH (e:Entity)
                WHERE (e.name =~ '.*[（(]\\\\d{4}[）)].*' OR e.name =~ '.*[，,].*\\\\d{4}.*')
                  AND (e.dirty_source IS NULL OR e.dirty_source <> 'publication_citation')
                RETURN e.id AS id, e.name AS name
                LIMIT 100
            """).data()
        self.stats["cognee"] = self.stats.get("cognee", {})
        self.stats["cognee"]["already_flagged_dirty"] = flagged
        for r in candidates:
            self.results["C7_DIRTY_SOURCE"].append({
                "engine": engine, "entity_id": r["id"],
                "entity_name": str(r.get("name", ""))[:80],
                "status": "new_candidate",
            })

    # ── C8: VAGUE_RELATION ──
    def detect_vague_relation(self, engine: str):
        """Relations that are too generic or uninformative."""
        driver = self.drivers.get(engine)
        if not driver:
            return
        vague_patterns = ["RELATES_TO", "related_to", "has", "associated_with",
                          "connected_to", "linked_with"]
        with driver.session() as s:
            for pattern in vague_patterns:
                try:
                    if engine == "cognee":
                        cnt = s.run("""
                            MATCH ()-[r]->() WHERE toLower(type(r)) = $pat
                            RETURN count(r) AS c
                        """, pat=pattern.lower()).single()
                    else:
                        cnt = s.run("""
                            MATCH ()-[r]->() WHERE type(r) = $pat
                            RETURN count(r) AS c
                        """, pat=pattern.upper()).single()
                    if cnt and cnt["c"] > 0:
                        self.results["C8_VAGUE_RELATION"].append({
                            "engine": engine, "relation_type": pattern,
                            "count": cnt["c"],
                        })
                except Exception:
                    pass

    # ── C9: WEAK_EDGE ──
    def detect_weak_edge(self, engine: str):
        """Edges with low weight or missing source_node_id."""
        driver = self.drivers.get(engine)
        if not driver:
            return
        with driver.session() as s:
            # Low weight edges
            try:
                low_w = s.run("""
                    MATCH ()-[r]->()
                    WHERE r.weight IS NOT NULL AND r.weight < $thresh
                    RETURN type(r) AS rel_type, count(r) AS cnt
                    ORDER BY cnt DESC
                """, thresh=WEAK_EDGE_WEIGHT).data()
                for lw in low_w:
                    self.results["C9_WEAK_EDGE"].append({
                        "engine": engine, "relation_type": lw["rel_type"],
                        "low_weight_count": lw["cnt"],
                        "issue": "weight_below_threshold",
                    })
            except Exception:
                pass
            # Missing source_node_id (Cognee CO_OCCURS_WITH)
            if engine == "cognee":
                try:
                    missing = s.run("""
                        MATCH ()-[r:CO_OCCURS_WITH]->()
                        WHERE r.source_node_id IS NULL
                        RETURN count(r) AS c
                    """).single()
                    if missing and missing["c"] > 0:
                        self.results["C9_WEAK_EDGE"].append({
                            "engine": engine, "relation_type": "CO_OCCURS_WITH",
                            "missing_source_node_id": missing["c"],
                            "issue": "missing_source_node_id",
                        })
                except Exception:
                    pass

    # ── C10: EMBEDDING_MISSING ──
    def detect_embedding_missing(self, engine: str):
        """Entities without embedding vectors."""
        # This is a proxy check — actual LanceDB check is expensive.
        # We check if the entity was created before the embedding pipeline ran.
        driver = self.drivers.get(engine)
        if not driver:
            return
        with driver.session() as s:
            if engine == "cognee":
                # Check DocumentChunks without vectors in Neo4j
                # (LanceDB is the ground truth but slow to query)
                recs = s.run("""
                    MATCH (dc:DocumentChunk)
                    WHERE dc.vector IS NULL
                    RETURN count(dc) AS c
                """).single()
                if recs and recs["c"] > 0:
                    self.results["C10_EMBEDDING_MISSING"].append({
                        "engine": engine, "node_type": "DocumentChunk",
                        "missing_count": recs["c"],
                    })
            else:
                recs = s.run("""
                    MATCH (e:Entity)
                    WHERE e.name_embedding IS NULL
                    RETURN count(e) AS c
                """).single()
                if recs and recs["c"] > 0:
                    self.results["C10_EMBEDDING_MISSING"].append({
                        "engine": engine, "node_type": "Entity",
                        "missing_count": recs["c"],
                    })

    # ── C11: STALE_NODE ──
    def detect_stale_node(self, engine: str):
        """Nodes not updated recently (if timestamps exist)."""
        driver = self.drivers.get(engine)
        if not driver:
            return
        cutoff = (datetime.utcnow() - timedelta(days=STALE_DAYS)).isoformat()
        with driver.session() as s:
            for label in ["Entity", "DocumentChunk", "TextDocument"]:
                try:
                    if engine == "cognee":
                        recs = s.run(f"""
                            MATCH (n:{label})
                            WHERE n.updated_at IS NOT NULL AND n.updated_at < $cutoff
                            RETURN count(n) AS c
                        """, cutoff=cutoff).single()
                    else:
                        recs = s.run(f"""
                            MATCH (n:{label})
                            WHERE n.updated_at IS NOT NULL AND n.updated_at < $cutoff
                            RETURN count(n) AS c
                        """, cutoff=cutoff).single()
                    if recs and recs["c"] > 0:
                        self.results["C11_STALE_NODE"].append({
                            "engine": engine, "node_type": label,
                            "stale_count": recs["c"], "cutoff_days": STALE_DAYS,
                        })
                except Exception:
                    pass

    # ── Run all detections ──
    def detect_all(self, target_classes: list[str] | None = None):
        """Run detection for all or specified defect classes."""
        detectors = {
            "C1": self.detect_missing_type,
            "C2": self.detect_empty_description,
            "C3": self.detect_orphan,
            "C4": self.detect_low_degree,
            "C5": self.detect_generic_type,
            "C6": self.detect_duplicate_name,
            "C7": self.detect_dirty_source,
            "C8": self.detect_vague_relation,
            "C9": self.detect_weak_edge,
            "C10": self.detect_embedding_missing,
            "C11": self.detect_stale_node,
        }

        if target_classes:
            to_run = {k: v for k, v in detectors.items() if k in target_classes}
        else:
            to_run = detectors

        engines = list(self.drivers.keys())
        for code, detector in to_run.items():
            for engine in engines:
                # Skip engine-specific detectors
                if code in ("C5", "C7") and engine != "cognee":
                    continue
                print(f"  {code} ({engine})...")
                detector(engine)

    def report(self) -> dict:
        """Generate structured defect report."""
        report = {
            "timestamp": datetime.now().isoformat(),
            "engines": list(self.drivers.keys()),
            "total_defects": sum(len(v) for v in self.results.values()),
            "by_class": {},
        }
        for code in sorted(self.results.keys()):
            items = self.results[code]
            engines_involved = list(set(d["engine"] for d in items))
            report["by_class"][code] = {
                "count": len(items),
                "engines": engines_involved,
                "sample": items[:5],
            }
        report["stats"] = self.stats
        return report

    def print_summary(self):
        """Print human-readable summary."""
        print(f"\n{'='*60}")
        print(f"DEFECT DETECTION SUMMARY")
        print(f"{'='*60}")
        print(f"  Engines: {', '.join(self.drivers.keys())}")
        total = sum(len(v) for v in self.results.values())
        print(f"  Total defects found: {total}")
        print()
        for code in sorted(self.results.keys()):
            items = self.results[code]
            if not items:
                continue
            engines_involved = list(set(d["engine"] for d in items))
            if code == "C5_GENERIC_TYPE":
                for item in items[:3]:
                    print(f"  {code}: {item['type_name']} ({item['count']} entities, {item['pct']}%) [{item['engine']}]")
            elif code == "C8_VAGUE_RELATION":
                for item in items[:5]:
                    print(f"  {code}: {item['relation_type']} ({item['count']} edges) [{item['engine']}]")
            elif code == "C9_WEAK_EDGE":
                for item in items[:5]:
                    print(f"  {code}: {item.get('relation_type','?')} — {item.get('issue','?')} ({item.get('low_weight_count', item.get('missing_source_node_id','?'))}) [{item['engine']}]")
            elif code == "C10_EMBEDDING_MISSING":
                for item in items:
                    print(f"  {code}: {item['node_type']} — {item['missing_count']} missing [{item['engine']}]")
            else:
                sample_names = ", ".join(str(d.get("entity_name", d.get("type_name", d.get("normalized_name", "?")))[:40]) for d in items[:3])
                print(f"  {code}: {len(items)} items [{', '.join(engines_involved)}] — {sample_names}...")

    def close(self):
        for d in self.drivers.values():
            d.close()


# ── Fix actions ──

def fix_C1_missing_type(dry_run: bool = True):
    """Re-cognify entities without type: re-run entity type classification."""
    if dry_run:
        print("  [DRY RUN] Would re-cognify entities without type")
        return
    print("  Re-running entity type classification...")
    os.system(f'cd %USERPROFILE%/cognee && .venv312/Scripts/python.exe -c '
              f'"from cognee.api.v1.cognify import cognify; import asyncio; asyncio.run(cognify(datasets=[\\"capital_rebuild\\"]))"')


def fix_C2_empty_description(dry_run: bool = True):
    """Re-extract descriptions for entities with empty ones."""
    if dry_run:
        print("  [DRY RUN] Would re-extract descriptions via LLM for empty-description entities")
        return
    print("  Triggering re-cognify for description regeneration...")
    os.system(f'cd %USERPROFILE%/cognee && .venv312/Scripts/python.exe -c '
              f'"from cognee.api.v1.cognify import cognify; import asyncio; asyncio.run(cognify(datasets=[\\"capital_rebuild\\"]))"')


def fix_C3_orphan(dry_run: bool = True):
    """Build CO_OCCURS_WITH edges for orphan entities."""
    if dry_run:
        print("  [DRY RUN] Would build CO_OCCURS_WITH edges for orphan entities")
        return
    print("  Building co-occurrence edges...")
    os.system(f'cd %USERPROFILE%/cognee && .venv312/Scripts/python.exe '
              f'cognee/memify_pipelines/link_cooccurring_entities.py')


def fix_C6_duplicates(dry_run: bool = True):
    """Dedup entities: build alias groups and redirect edges."""
    if dry_run:
        print("  [DRY RUN] Would run build_entity_aliases.py + merge duplicates")
        return
    print("  Building entity aliases...")
    os.system(f'cd %USERPROFILE%/cognee && .venv312/Scripts/python.exe scripts/build_entity_aliases.py')


def fix_C7_dirty(dry_run: bool = True):
    """Flag publication citation entities."""
    if dry_run:
        print("  [DRY RUN] Would flag dirty publication entities")
        return
    print("  Cleaning dirty entities...")
    os.system(f'cd %USERPROFILE%/cognee && .venv312/Scripts/python.exe scripts/clean_dirty_entities.py')


def fix_C9_weak_edges(dry_run: bool = True):
    """Repair weak edges: fix CO_OCCURS_WITH missing source_node_id."""
    if dry_run:
        print("  [DRY RUN] Would repair CO_OCCURS_WITH edges missing source_node_id")
        return
    print("  Repairing CO_OCCURS_WITH edges...")
    driver = GraphDatabase.driver(COGNEE_URI, auth=COGNEE_AUTH)
    with driver.session() as s:
        # Add source_node_id from adjacent DocumentChunk if missing
        result = s.run("""
            MATCH (e1:Entity)-[r:CO_OCCURS_WITH]-(e2:Entity)
            WHERE r.source_node_id IS NULL
            OPTIONAL MATCH (dc:DocumentChunk)-[:contains]->(e1)
            WITH r, dc LIMIT 1000
            SET r.source_node_id = dc.id
            RETURN count(r) AS fixed
        """).single()
        if result:
            print(f"  Fixed {result['fixed']} edges")
    driver.close()


def fix_C10_embeddings(dry_run: bool = True):
    """Re-embed entities missing vectors."""
    if dry_run:
        print("  [DRY RUN] Would run reembed_chunks_v2.py for missing embeddings")
        return
    print("  Re-embedding missing vectors...")
    os.system(f'cd %USERPROFILE%/cognee && .venv312/Scripts/python.exe scripts/reembed_chunks_v2.py --batch-size 20')


# ── Fix dispatcher ──
FIX_ACTIONS = {
    "C1": ("MISSING_TYPE", fix_C1_missing_type),
    "C2": ("EMPTY_DESCRIPTION", fix_C2_empty_description),
    "C3": ("ORPHAN_ENTITY", fix_C3_orphan),
    "C4": ("LOW_DEGREE", None),  # Manual review needed
    "C5": ("GENERIC_TYPE", None),  # Requires LLM subtype splitting
    "C6": ("DUPLICATE_NAME", fix_C6_duplicates),
    "C7": ("DIRTY_SOURCE", fix_C7_dirty),
    "C8": ("VAGUE_RELATION", None),  # Requires re-extraction with edge_types
    "C9": ("WEAK_EDGE", fix_C9_weak_edges),
    "C10": ("EMBEDDING_MISSING", fix_C10_embeddings),
    "C11": ("STALE_NODE", None),  # Manual review needed
}


def run_fixes(defect_report: dict, target_classes: list[str] | None, dry_run: bool):
    """Execute fix actions for detected defects."""
    print(f"\n{'='*60}")
    print(f"FIX PHASE {'(DRY RUN)' if dry_run else '(LIVE)'}")
    print(f"{'='*60}")

    by_class = defect_report.get("by_class", {})

    for code, (name, fix_fn) in FIX_ACTIONS.items():
        class_key = f"C{code.split('_')[0] if '_' not in code else code}"
        # Map short codes to full keys
        matched_keys = [k for k in by_class if k.startswith(code) and by_class[k]["count"] > 0]

        if not matched_keys:
            continue
        if target_classes and not any(tc in code for tc in target_classes):
            continue

        defect_count = sum(by_class[k]["count"] for k in matched_keys)
        print(f"\n  [{code}] {name} — {defect_count} defect(s) detected")

        if fix_fn:
            fix_fn(dry_run)
        else:
            print(f"    ⚠ No automated fix — requires manual review or re-extraction")


# ── Main ──
def main():
    parser = argparse.ArgumentParser(description="11-Class Graph Defect Detector + Fix Pipeline")
    parser.add_argument("--engine", default="both", choices=["cognee", "graphiti", "both"])
    parser.add_argument("--target", default=None, help="Comma-separated defect codes (e.g. C1,C2,C7)")
    parser.add_argument("--fix", action="store_true", help="Execute fix actions (not just detect)")
    parser.add_argument("--dry-run", action="store_true", default=True,
                        help="Preview fixes without executing (default: True)")
    parser.add_argument("-o", "--output", default=None)
    args = parser.parse_args()

    target_classes = args.target.split(",") if args.target else None
    if args.fix:
        args.dry_run = False

    print("=" * 60)
    print("11-Class Graph Defect Detector")
    print(f"Engine: {args.engine} | Target: {args.target or 'ALL'} | Fix: {args.fix}")
    print("=" * 60)

    detector = DefectDetector(engine=args.engine)
    if not detector.drivers:
        print("No database connections available. Exiting.")
        return

    try:
        # ── Phase 1: Detect ──
        print("\n── Phase 1: Detection ──")
        detector.detect_all(target_classes=target_classes)
        detector.print_summary()

        report = detector.report()

        # Save report
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_path = Path(args.output) if args.output else OUTPUT_DIR / f"defect_report_{timestamp}.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nReport saved: {out_path}")

        # Write LATEST
        latest_path = OUTPUT_DIR / "LATEST_DEFECT_REPORT.json"
        latest_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

        # ── Phase 2: Fix ──
        if args.fix:
            run_fixes(report, target_classes, dry_run=False)
        elif not args.dry_run:
            run_fixes(report, target_classes, dry_run=True)

    finally:
        detector.close()


if __name__ == "__main__":
    main()
