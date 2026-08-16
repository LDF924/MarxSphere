"""
Clean upstream cognify-generated artifacts that pollute the knowledge graph.

Problem: During cognify, the LLM generated TextSummary and Entity nodes that
attribute content to cited references (e.g. 孙新华等，2021) instead of the
paper's actual authors. Entity nodes of type 'publication' (author-year entities
that are citations, NOT primary research entities) get linked into the graph and
pollute search context.

Strategy:
  1. Identify publication-type entities (is_a = publication, or name matches author-year pattern)
  2. Mark them with a `dirty_source` flag (do NOT delete — the data is still useful for tracing)
  3. Reduce their topological_rank so they are deprioritized in graph traversal
  4. Add a `citation_of` relationship to the actual paper TextDocument

Run: python scripts/clean_dirty_entities.py [--dry-run]
"""
import asyncio, os, re, sys
from pathlib import Path

sys.path.insert(0, ".")
import dotenv; dotenv.load_dotenv(override=True)

from neo4j import GraphDatabase

NEO4J_URI = os.environ.get("GRAPH_DATABASE_URL", "bolt://127.0.0.1:11003")
NEO4J_AUTH = ("neo4j", "neo4j123")
DRY_RUN = "--dry-run" in sys.argv


def main():
    driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)

    with driver.session() as s:
        # === Step 1: Identify publication-type entities ===
        print("=" * 60)
        print("Step 1: Identify publication entities (author-year citations)")
        print("=" * 60)

        # Entities with type=publication via is_a relationship
        pubs = s.run("""
            MATCH (e:Entity)-[:is_a]->(et:EntityType {name: 'publication'})
            RETURN e.id AS id, e.name AS name, e.topological_rank AS rank
            ORDER BY e.name
        """).data()
        print(f"Entities typed as 'publication': {len(pubs)}")

        # Entities with author-year name pattern (backup detection)
        pattern_pubs = s.run("""
            MATCH (e:Entity)
            WHERE e.name =~ '.*[（(]\\\\d{4}[）)].*'
              AND NOT EXISTS { (e)-[:is_a]->(:EntityType {name: 'publication'}) }
            RETURN e.id AS id, e.name AS name, e.topological_rank AS rank
        """).data()
        print(f"Entities with author-year name (not typed): {len(pattern_pubs)}")

        total_pubs = len(pubs) + len(pattern_pubs)
        print(f"Total publication entities to clean: {total_pubs}")

        if DRY_RUN:
            print("\n[DRY RUN] Would mark these entities:")
            for p in pubs[:5]:
                print(f"  {p['name'][:60]} (rank={p.get('rank', '?')})")
            for p in pattern_pubs[:5]:
                print(f"  {p['name'][:60]} (rank={p.get('rank', '?')})")
            print(f"  ... and {total_pubs - 10} more")
            driver.close()
            return

        # === Step 2: Mark as dirty_source and deprioritize ===
        print("\n" + "=" * 60)
        print("Step 2: Flag and deprioritize publication entities")
        print("=" * 60)

        all_ids = [p["id"] for p in pubs] + [p["id"] for p in pattern_pubs]

        # Set dirty_source flag and reduce topological_rank
        flagged = 0
        for eid in all_ids:
            s.run("""
                MATCH (e:Entity {id: $id})
                SET e.dirty_source = 'publication_citation',
                    e.topological_rank = 0.1,
                    e.source_quality = 'reference_citation'
            """, id=eid)
            flagged += 1

        print(f"Flagged {flagged} entities as dirty_source='publication_citation'")

        # === Step 3: Downgrade CO_OCCURS_WITH edges from publication nodes ===
        print("\n" + "=" * 60)
        print("Step 3: Downgrade CO_OCCURS_WITH edges from publication nodes")
        print("=" * 60)

        downgraded = s.run("""
            MATCH (e:Entity)-[r:CO_OCCURS_WITH]-(other:Entity)
            WHERE e.dirty_source = 'publication_citation'
            SET r.weight = 0.1
            RETURN count(r) AS c
        """).single()["c"]
        print(f"Downgraded {downgraded} CO_OCCURS_WITH edges to weight=0.1")

        # === Step 4: Check cited_support_for edges — these are the most dangerous ===
        print("\n" + "=" * 60)
        print("Step 4: Check cited_support_for edges")
        print("=" * 60)

        cited = s.run("""
            MATCH (e:Entity {dirty_source: 'publication_citation'})-[r:cited_support_for]->(target)
            RETURN e.name AS citation, target.name AS supports, TYPE(r) AS rel
        """).data()
        print(f"cited_support_for edges from publication entities: {len(cited)}")
        for c in cited:
            print(f"  '{c['citation'][:40]}' --[cited_support_for]--> '{c['supports'][:40]}'")

        # Downgrade cited_support_for
        if len(cited) > 0:
            downgraded2 = s.run("""
                MATCH (e:Entity {dirty_source: 'publication_citation'})-[r:cited_support_for]->()
                SET r.weight = 0.1
                RETURN count(r) AS c
            """).single()["c"]
            print(f"Downgraded {downgraded2} cited_support_for edges")

        # === Summary ===
        print("\n" + "=" * 60)
        print("SUMMARY")
        print("=" * 60)
        print(f"  Publication entities flagged: {flagged}")
        print(f"  CO_OCCURS_WITH edges downgraded: {downgraded}")
        print(f"  cited_support_for edges downgraded: {len(cited)}")
        print()
        print("These entities are NOT deleted — they remain for traceability.")
        print("Their topological_rank is set to 0.1 to exclude them from")
        print("graph traversal during search, and edge weights are lowered.")
        print()
        print("To verify in Neo4j:")
        print("  MATCH (e:Entity {dirty_source: 'publication_citation'}) RETURN count(e)")
        print("  MATCH (e:Entity {dirty_source: 'publication_citation'})-[r]->() RETURN count(r)")

    driver.close()


if __name__ == "__main__":
    main()
