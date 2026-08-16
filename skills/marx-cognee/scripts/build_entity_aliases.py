#!/usr/bin/env python
"""Build an entity alias dictionary from Neo4j by fuzzy-matching entity names.

Usage: python scripts/build_entity_aliases.py
Output: cognee/config/entity_aliases.json
"""

import asyncio
import json
import os
import sys
from difflib import get_close_matches
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
from neo4j import GraphDatabase
from collections import defaultdict

load_dotenv()

NEO4J_URI = os.getenv("GRAPH_DATABASE_URL", "bolt://127.0.0.1:11003")
NEO4J_AUTH = ("neo4j", "neo4j123")

CUTOFF = 0.75
MIN_GROUP_SIZE = 2
BATCH_SIZE = 2000


def fetch_entities(driver):
    """Fetch all entity names and descriptions from Neo4j, excluding dirty publication entities."""
    names = []
    with driver.session() as session:
        result = session.run(
            "MATCH (e:Entity) "
            "WHERE e.name IS NOT NULL AND e.name <> '' "
            "  AND (e.dirty_source IS NULL OR e.dirty_source <> 'publication_citation') "
            "RETURN e.name AS name, e.description AS description "
            "ORDER BY e.name"
        )
        for record in result:
            name = record["name"]
            desc = record["description"] or ""
            names.append((name.strip(), desc.strip()))
    return names


def build_alias_groups(entities: list[tuple[str, str]], cutoff: float = CUTOFF):
    """Group entity names by fuzzy similarity."""
    name_list = [e[0] for e in entities]
    seen = set()
    groups: dict[str, list[str]] = {}

    for i, (name, desc) in enumerate(entities):
        if name in seen:
            continue
        candidates = [n for n in name_list if n != name and n not in seen]
        matches = get_close_matches(name, candidates, n=5, cutoff=cutoff)
        if len(matches) >= MIN_GROUP_SIZE - 1:
            group = [name] + matches
            groups[name] = group
            seen.update(group)
        else:
            seen.add(name)

    return groups


def main():
    print(f"Connecting to {NEO4J_URI} ...")
    driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)

    try:
        driver.verify_connectivity()
    except Exception as e:
        print(f"Neo4j connection failed: {e}")
        sys.exit(1)

    entities = fetch_entities(driver)
    driver.close()
    print(f"Found {len(entities)} Entity nodes.")

    print(f"Building alias groups (cutoff={CUTOFF}) ...")
    groups = build_alias_groups(entities, CUTOFF)

    print(f"Built {len(groups)} alias groups covering {sum(len(g) for g in groups.values())} entities.")

    out_path = Path(__file__).resolve().parent.parent / "cognee" / "config" / "entity_aliases.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(groups, f, ensure_ascii=False, indent=2)

    print(f"Written to {out_path}")

    # Print top-5 largest groups as preview
    top = sorted(groups.items(), key=lambda kv: len(kv[1]), reverse=True)[:5]
    print("\nTop-5 largest alias groups:")
    for canonical, aliases in top:
        print(f"  {canonical}: {aliases[:5]}")


if __name__ == "__main__":
    main()
