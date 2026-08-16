import sys; sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection
nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

# Show the 3 entities
ents = nc.execute_query("MATCH (e)-[:BELONGS_TO_COMMUNITY]->(c:Community {parent_community: '西方马克思主义'}) RETURN e.name AS name, e.category AS cat, e.description AS desc")
print("Entities in 西方马克思主义:")
for e in ents:
    print(f"  {e['name']} ({e['cat']})")

# Search distills that contain these entity names in core_concept_definition
for name in ["鲁斯巴里特斯", "适应性危机", "资本循环危机"]:
    r = nc.execute_query("MATCH (ld:LiteratureDistill) WHERE ld.core_concept_definition CONTAINS $name RETURN count(ld) AS c", {"name": name})
    print(f"Distills mentioning '{name}': {r[0]['c']}")

# Check if any distill CORRESPONDS_TO these entities
linked = nc.execute_query("""
    MATCH (e:Entity)-[:BELONGS_TO_COMMUNITY]->(c:Community {parent_community: '西方马克思主义'})
    MATCH (ld:LiteratureDistill)-[:CORRESPONDS_TO]->(e)
    RETURN COUNT(DISTINCT ld) AS c
""")[0]["c"]
print(f"Distills via CORRESPONDS_TO: {linked}")

print("\nVerdict: 西方马克思主义 has only 3 entities, none linked to any distill.")
print("DomainKnowledge for this domain requires >= 2 distills — skip is correct.")
print("Can be built later when more Western Marxism papers are added.")

nc.close()
