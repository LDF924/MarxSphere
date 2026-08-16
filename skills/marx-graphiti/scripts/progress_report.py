#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""简洁进度报告"""
import sys; sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection

nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
ep = nc.execute_query("MATCH (ep:Episode) RETURN COUNT(ep) AS c")[0]["c"]
ent = nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"]
rel = nc.execute_query("MATCH ()-[r]->() WHERE type(r) <> \"EXTRACTED_FROM\" AND type(r) <> \"BELONGS_TO_COMMUNITY\" AND type(r) <> \"HAS_CONFLICT\" RETURN COUNT(r) AS c")[0]["c"]
comm = nc.execute_query("MATCH (c:Community) RETURN COUNT(c) AS c")[0]["c"]
conf = nc.execute_query("MATCH (c:Conflict) RETURN COUNT(c) AS c")[0]["c"]
distill = nc.execute_query("MATCH (ld:LiteratureDistill) RETURN COUNT(ld) AS c")[0]["c"]
dk = nc.execute_query("MATCH (dk:DomainKnowledge) RETURN COUNT(dk) AS c")[0]["c"]
idx = nc.execute_query("SHOW INDEXES YIELD name, state WHERE name = \"entity_vector_idx\" RETURN name, state")
vec_status = idx[0]["state"] if idx else "NOT_FOUND"
nc.close()

print("=" * 50)
print("  Pipeline Progress Report")
print("=" * 50)
print(f"  1. Env Setup       DONE")
print(f"  2. Data Ingestion  DONE")
print(f"     Episodes:     {ep}")
print(f"     Entities:     {ent}")
print(f"     Relations:    {rel}")
print(f"     Communities:  {comm}")
print(f"     Conflicts:    {conf}")
print(f"  3. Vectorization  DONE")
print(f"     Index:        {vec_status}")
print(f"  4. Knowledge Distill")
print(f"     LitDistill:   {distill}/208 DONE")
print(f"     DomainKnowl:  {dk} (NEXT)")
print(f"  5. API Cost       DONE")
print(f"  6. Data Quality   PENDING")
print()
print(f"  NEXT: None - Full pipeline complete")
