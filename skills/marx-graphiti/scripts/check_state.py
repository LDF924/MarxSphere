import sys; sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection
nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
ent = nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"]
rel = nc.execute_query("MATCH ()-[r]->() WHERE type(r) <> \"EXTRACTED_FROM\" AND type(r) <> \"BELONGS_TO_COMMUNITY\" AND type(r) <> \"HAS_CONFLICT\" RETURN COUNT(r) AS c")[0]["c"]
done = nc.execute_query("MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) RETURN COUNT(DISTINCT ep) AS c")[0]["c"]
no_ent = nc.execute_query("MATCH (ep:Episode) WHERE NOT (ep)-[:EXTRACTED_FROM]-(:Entity) RETURN COUNT(ep) AS c")[0]["c"]
retry_ents = nc.execute_query("MATCH (e:Entity {batch_run: \"v3_retry_45_zero_entity\"}) RETURN COUNT(e) AS c")[0]["c"]
retry_rels = nc.execute_query("MATCH ()-[r]->() WHERE r.batch_run = \"v3_retry_45_zero_entity\" RETURN COUNT(r) AS c")[0]["c"]
nc.close()
print(f"Entity: {ent} | Relation: {rel} | Done papers: {done} | Without: {no_ent}")
print(f"Retry batch: {retry_ents} entities, {retry_rels} relations")
