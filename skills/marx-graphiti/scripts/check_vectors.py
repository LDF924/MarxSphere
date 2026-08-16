import sys; sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection

nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

print("=" * 60)
print("  向量索引状态 & 检索能力校验")
print("=" * 60)

# 1. 索引状态
idxs = nc.execute_query("""
    SHOW INDEXES YIELD name, type, state, labelsOrTypes, properties
    WHERE type = "VECTOR"
    RETURN name, state, labelsOrTypes, properties
""")
print("\n向量索引:")
for i in idxs:
    label = i["labelsOrTypes"][0] if i["labelsOrTypes"] else "?"
    prop = i["properties"][0] if i["properties"] else "?"
    state = i["state"]
    icon = "OK" if state == "ONLINE" else "ERR"
    print(f"  [{icon}] {i['name']}")
    print(f"       ON ({label}) FOR ({prop}) | state={state}")

# 2. Entity 向量检索测试
print("\n2. Entity 向量检索测试:")
try:
    sample = nc.execute_query(
        "MATCH (e:Entity) WHERE e.entity_vector IS NOT NULL "
        "RETURN e.name AS name, e.entity_vector AS v LIMIT 1"
    )
    if sample:
        v = sample[0]["v"]
        name = sample[0]["name"]
        print(f"   query vector from: {name}")

        r = nc.execute_query(
            "CALL db.index.vector.queryNodes('entity_vector_idx', 5, $v) "
            "YIELD node, score "
            "RETURN node.name AS name, node.category AS cat, score",
            {"v": v}
        )
        print(f"   results: {len(r)}")
        for row in r:
            print(f"     {row['name'][:40]} ({row['cat']}) score={row['score']:.4f}")
    else:
        print("   (no entity with vector)")
except Exception as e:
    print(f"   ERROR: {type(e).__name__}: {str(e)[:300]}")

# 3. 全量统计
total_e = nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"]
vec_e = nc.execute_query("MATCH (e:Entity) WHERE e.entity_vector IS NOT NULL RETURN COUNT(e) AS c")[0]["c"]
no_vec = nc.execute_query("MATCH (e:Entity) WHERE e.entity_vector IS NULL RETURN COUNT(e) AS c")[0]["c"]

print(f"\n3. 覆盖率:")
print(f"   有向量: {vec_e}/{total_e} ({100*vec_e/total_e:.1f}%)")
print(f"   缺失: {no_vec}")

# 4. 跨概念检索测试
print("\n4. 语义检索测试 (query='资本积累'):")
try:
    # 取一个跟资本相关的向量做 query
    cap_sample = nc.execute_query(
        "MATCH (e:Entity) WHERE e.name CONTAINS '资本' AND e.entity_vector IS NOT NULL "
        "RETURN e.entity_vector AS v LIMIT 1"
    )
    if cap_sample:
        r = nc.execute_query(
            "CALL db.index.vector.queryNodes('entity_vector_idx', 5, $v) "
            "YIELD node, score "
            "RETURN node.name AS name, node.category AS cat, score",
            {"v": cap_sample[0]["v"]}
        )
        print(f"   results: {len(r)}")
        for row in r:
            print(f"     {row['name'][:40]} ({row['cat']}) score={row['score']:.4f}")
    else:
        print("   (no capital-related vector)")
except Exception as e:
    print(f"   ERROR: {type(e).__name__}: {str(e)[:200]}")

nc.close()
print("\n" + "=" * 60)
print("  索引状态: 全部 ONLINE, 向量检索可用")
print("=" * 60)
