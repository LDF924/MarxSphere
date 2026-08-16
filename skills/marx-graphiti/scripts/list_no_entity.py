import sys; sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection
nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
r = nc.execute_query(
    "MATCH (ep:Episode) WHERE NOT (ep)-[:EXTRACTED_FROM]-(:Entity) "
    "RETURN ep.source_folder AS f ORDER BY ep.source_folder"
)
print(f"无实体文献总数: {len(r)}")
print()
for i, row in enumerate(r, 1):
    print(f"  {i:2d}. {row['f']}")
nc.close()
