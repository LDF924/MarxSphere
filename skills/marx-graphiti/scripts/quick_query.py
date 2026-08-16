import sys; sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection
nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
r = nc.execute_query(
    "MATCH (e:Entity {batch_run: 'v3_incremental_20260629'})-[:EXTRACTED_FROM]->(ep:Episode) "
    "RETURN count(DISTINCT ep) AS c1, count(DISTINCT e) AS c2"
)[0]
print("本轮处理论文数:", r["c1"])
print("本轮新增实体总数:", r["c2"])
nc.close()
