#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chunk_cleanup.py — 删除 v1 阶段写入的 6591 个旧 Chunk 节点（无向量、已被 v2 覆盖）
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from pipeline import Neo4jConnection

nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")

# 查找无向量的旧 Chunk
before = nc.execute_query("MATCH (c:Chunk) RETURN count(c) AS cnt")[0]["cnt"]
orphan_count = nc.execute_query(
    "MATCH (c:Chunk) WHERE c.chunk_vector IS NULL RETURN count(c) AS cnt")[0]["cnt"]

print(f"Total Chunks: {before}")
print(f"Chunks without vector (old): {orphan_count}")

if orphan_count > 0:
    nc.execute_write("MATCH (c:Chunk) WHERE c.chunk_vector IS NULL DETACH DELETE c")
    after = nc.execute_query("MATCH (c:Chunk) RETURN count(c) AS cnt")[0]["cnt"]
    print(f"Deleted {orphan_count} stale chunks. Remaining: {after}")
else:
    print("No stale chunks to clean.")

nc.close()
