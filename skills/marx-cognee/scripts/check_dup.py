import asyncio, os
os.chdir("%USERPROFILE%/cognee")
import dotenv; dotenv.load_dotenv(override=True)
from cognee.infrastructure.databases.graph import get_graph_engine

async def main():
    g = await get_graph_engine()

    # 1. 缺 description 的 Entity
    r = await g.query("MATCH (n:Entity) WHERE n.description IS NULL OR n.description = '' RETURN n.name AS name, n.id AS id")
    print("=== Entity 缺 description ===")
    for row in r:
        print(f"  name={row['name']}, id={row['id']}")

    # 2. 严重重复语义边 (>5次)
    q = """
        MATCH (a)-[e]->(b)
        WHERE NOT type(e) IN ['contains','is_a','made_from','is_part_of']
        WITH a.name AS src, b.name AS tgt, type(e) AS rel, count(e) AS cnt
        WHERE cnt > 5
        RETURN src, tgt, rel, cnt ORDER BY cnt DESC LIMIT 12
    """
    r = await g.query(q)
    print("\n=== 严重重复语义边 (>5次) ===")
    for row in r:
        print(f"  {row['src'][:40]:40s} -[{row['rel']:25s}]-> {row['tgt'][:40]:40s} x{row['cnt']}")

    # 3. 去重对比
    r = await g.query("MATCH ()-[e]->() RETURN count(e) AS total")
    total = r[0]["total"]

    r = await g.query("MATCH ()-[e]->() WHERE type(e) IN ['contains','is_a','made_from','is_part_of'] RETURN count(e) AS s")
    structural = r[0]["s"]
    semantic = total - structural

    r = await g.query("""
        MATCH (a)-[e]->(b)
        WHERE NOT type(e) IN ['contains','is_a','made_from','is_part_of']
        WITH a.id AS src_id, b.id AS tgt_id, type(e) AS rel
        RETURN count(*) AS unique_sem
    """)
    unique_sem = r[0]["unique_sem"]
    dup_sem = semantic - unique_sem
    print(f"\n总边: {total}")
    print(f"结构边: {structural} ({100*structural//total}%)")
    print(f"语义边: {semantic}, 去重后: {unique_sem}, 重复: {dup_sem} ({100*dup_sem//semantic}%)")

asyncio.run(main())
