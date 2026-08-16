import os
# extract_cognee_entities.py — 从 Neo4j 11003 提取所有实体到 JSON
import sys
sys.path.insert(0, os.environ.get('COGNEE_SKILL_DIR', ''))
from neo4j import GraphDatabase
import json

# Neo4j 11003 auth
driver = GraphDatabase.driver("bolt://127.0.0.1:11003", auth=("neo4j", os.environ.get("NEO4J_PASSWORD", "neo4j123")))
results = []

with driver.session() as session:
    for offset in range(0, 12000, 500):
        r = session.run(
            "MATCH (e:Entity) RETURN e.name as name, labels(e) as labels, e.description as description, e.id as node_id SKIP $offset LIMIT 500",
            offset=offset
        )
        batch = [{"name": row["name"] or "", "labels": row["labels"] or [], "description": row["description"] or "", "node_id": row["node_id"] or ""} for row in r]
        results.extend(batch)
        if len(batch) < 500:
            break

with open("cognee_entities_dump.json", "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False)

print("TOTAL:", len(results))
driver.close()
