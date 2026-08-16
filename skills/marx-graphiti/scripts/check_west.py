import sys; sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection
nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

p = "西方马克思主义"
ents = nc.execute_query("MATCH (e:Entity)-[:BELONGS_TO_COMMUNITY]->(c:Community {parent_community: $p}) RETURN COUNT(e) AS c", {"p": p})[0]["c"]
dks = nc.execute_query("MATCH (ld:LiteratureDistill)-[:CORRESPONDS_TO]->(e:Entity)-[:BELONGS_TO_COMMUNITY]->(c:Community {parent_community: $p}) RETURN COUNT(DISTINCT ld) AS c", {"p": p})[0]["c"]
print(f"西方马克思主义: {ents} entities, {dks} linked distills")
print("Reason for skip: 0 distills linked to entities in this community")
nc.close()
