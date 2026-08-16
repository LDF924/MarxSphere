#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数据质量检查脚本
Check: duplicates, orphans, mismatches, nulls, consistency
"""
import sys; sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection

nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

print("=" * 50)
print("  Data Quality Report")
print("=" * 50)

checks = {}

# 1. Duplicate entities (同 name 不同 id)
c = nc.execute_query("MATCH (e1:Entity),(e2:Entity) WHERE e1.name = e2.name AND elementId(e1) < elementId(e2) RETURN count(e1) AS cnt")[0]["cnt"]
checks["Duplicate entities"] = c

# 2. Orphans
c = nc.execute_query("MATCH (e:Entity) WHERE NOT (e)-[:EXTRACTED_FROM]->() RETURN count(e) AS cnt")[0]["cnt"]
checks["Orphan entities"] = c

c = nc.execute_query("MATCH (ep:Episode) WHERE NOT (ep)<-[:EXTRACTED_FROM]-() RETURN count(ep) AS cnt")[0]["cnt"]
checks["Orphan episodes (no entity)"] = c

# 3. EXTRACTED_FROM mismatches
c = nc.execute_query("MATCH (e:Entity)-[r:EXTRACTED_FROM]->(ep:Episode) WHERE e.source_folder <> ep.source_folder RETURN count(r) AS cnt")[0]["cnt"]
checks["EXTRACTED_FROM mismatch"] = c

# 4. Null/empty fields on Entity
c = nc.execute_query("MATCH (e:Entity) WHERE e.category IS NULL OR e.category = '' RETURN count(e) AS cnt")[0]["cnt"]
checks["Null category"] = c
c = nc.execute_query("MATCH (e:Entity) WHERE e.level IS NULL OR e.level = '' RETURN count(e) AS cnt")[0]["cnt"]
checks["Null level"] = c
c = nc.execute_query("MATCH (e:Entity) WHERE e.description IS NULL OR size(e.description) < 10 RETURN count(e) AS cnt")[0]["cnt"]
checks["Null/short description"] = c

# 5. Relations missing source_folder
c = nc.execute_query(
    "MATCH ()-[r]->() WHERE type(r) IN ['LEAD_TO','BELONG_TO','PROPOSED_BY','CONTRAST_WITH','INHERITS_FROM','PUBLISHED_IN','DEVELOPS_INTO','CRITIQUES'] AND r.source_folder IS NULL RETURN count(r) AS cnt"
)[0]["cnt"]
checks["Relations missing source"] = c

# 6. Empty conflicts
c = nc.execute_query("MATCH (c:Conflict) WHERE c.concept IS NULL OR c.concept = '' RETURN count(c) AS cnt")[0]["cnt"]
checks["Empty conflict concepts"] = c

# 7. Vector coverage
total_ent = nc.execute_query("MATCH (e:Entity) RETURN count(e) AS cnt")[0]["cnt"]
vec_ent = nc.execute_query("MATCH (e:Entity) WHERE e.entity_vector IS NOT NULL RETURN count(e) AS cnt")[0]["cnt"]
checks["Vector coverage"] = f"{vec_ent}/{total_ent}"

# Print
for k, v in checks.items():
    status = "PASS" if v == 0 or (isinstance(v, str) and v.split("/")[0] == v.split("/")[1]) else ("WARN" if isinstance(v, int) and v > 0 else "INFO")
    print(f"  [{status}] {k}: {v}")

# Totals
ep = nc.execute_query("MATCH (ep:Episode) RETURN count(ep) AS c")[0]["c"]
ent = nc.execute_query("MATCH (e:Entity) RETURN count(e) AS c")[0]["c"]
rel = nc.execute_query(
    "MATCH ()-[r]->() WHERE type(r) IN ['LEAD_TO','BELONG_TO','PROPOSED_BY','CONTRAST_WITH','INHERITS_FROM','PUBLISHED_IN','DEVELOPS_INTO','CRITIQUES'] RETURN count(r) AS c"
)[0]["c"]
comm = nc.execute_query("MATCH (c:Community) RETURN count(c) AS c")[0]["c"]
print(f"\n  Totals: {ep} episodes | {ent} entities | {rel} relations | {comm} communities")

# Verdict
issues = [v for k, v in checks.items() if isinstance(v, int) and v > 0]
if not issues:
    print("\n  All checks PASSED - no data quality issues")
else:
    print(f"\n  {sum(issues)} issues found (see above)")

nc.close()
