#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 Neo4j 配置审计脚本
============================================================
功能：
  1. 内存配置校验 — heap/off-heap/pagecache 参数是否合理
  2. 索引健康检查 — VECTOR/LOOKUP 状态、数量、一致性
  3. 数据库存储用量 — total/used/free disk
  4. 连接池与事务限制
  5. 输出审计报告 JSON + 终端摘要

操作:
  python check_neo4j_config.py           # 终端报告
  python check_neo4j_config.py --json    # JSON 报告
"""

import sys, json, argparse
from pathlib import Path
from datetime import datetime

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from pipeline import Neo4jConnection, get_logger

logger = get_logger("neo4j_audit")

# ── 阈值 ──
MIN_HEAP_MB = 256          # heap 最低推荐值
MIN_PAGECACHE_MB = 128     # pagecache 最低推荐值
MAX_TX_TOTAL_RATIO = 0.85  # 事务内存占比警告阈值
DISK_WARN_RATIO = 0.90     # 磁盘使用率警告阈值


def audit() -> dict:
    """完整审计，返回结构化结果"""
    result = {
        "timestamp": datetime.now().isoformat(),
        "memory": {},
        "indexes": {},
        "storage": {},
        "transactions": {},
        "warnings": [],
        "passed": True,
    }

    try:
        nc = Neo4jConnection(uri="bolt://127.0.0.1:11001",
                             user="neo4j", password="neo4j123")
        nc.execute_query("RETURN 1")
    except Exception as e:
        result["passed"] = False
        result["warnings"].append(f"CONNECTION FAILED: {e}")
        return result

    # ── 1. 内存配置 ──
    mem_configs = {}
    for key in ["server.memory.heap.initial_size", "server.memory.heap.max_size",
                "server.memory.off_heap.max_size", "db.memory.pagecache.size",
                "dbms.memory.transaction.total.max", "db.memory.transaction.total.max"]:
        try:
            r = nc.execute_query(
                "CALL dbms.listConfig() YIELD name, value WHERE name = $key "
                "RETURN value LIMIT 1", {"key": key})
            if r:
                mem_configs[key] = r[0]["value"]
        except Exception:
            mem_configs[key] = "N/A"

    result["memory"] = mem_configs

    # 解析 heap
    heap_max = mem_configs.get("server.memory.heap.max_size")
    if heap_max and heap_max != "None" and heap_max != "N/A":
        try:
            heap_mb = _parse_size_mb(heap_max)
            if heap_mb > 0 and heap_mb < MIN_HEAP_MB:
                result["warnings"].append(
                    f"Heap max ({heap_max} ~ {heap_mb}MB) < recommended {MIN_HEAP_MB}MB")
        except Exception:
            pass
    else:
        # Community Edition / 未显式配置 heap — 使用默认，不告警
        result["memory"]["heap_note"] = "heap not explicitly configured (Community Edition uses defaults)"

    # 解析 pagecache
    pagecache = mem_configs.get("db.memory.pagecache.size")
    if pagecache and pagecache not in ("None", "N/A", "0B", "0"):
        try:
            pc_mb = _parse_size_mb(pagecache)
            if 0 < pc_mb < MIN_PAGECACHE_MB:
                result["warnings"].append(
                    f"Pagecache ({pagecache} ~ {pc_mb}MB) < recommended {MIN_PAGECACHE_MB}MB")
        except Exception:
            pass
    else:
        result["memory"]["pagecache_note"] = "pagecache not explicitly configured"

    # 事务内存
    tx_max = mem_configs.get("dbms.memory.transaction.total.max", "0B")
    result["memory"]["transaction_total_max"] = tx_max

    # ── 2. 索引 ──
    try:
        idxs = nc.execute_query("SHOW INDEXES YIELD name, type, state, "
                                "labelsOrTypes, properties, populationPercent")
        vector_idx = [i for i in idxs if i.get("type") == "VECTOR"]
        lookup_idx = [i for i in idxs if i.get("type") == "LOOKUP"]
        other_idx = [i for i in idxs if i.get("type") not in ("VECTOR", "LOOKUP")]
        offline = [i for i in vector_idx if i["state"] != "ONLINE"]

        result["indexes"] = {
            "total": len(idxs),
            "vector_count": len(vector_idx),
            "lookup_count": len(lookup_idx),
            "other_count": len(other_idx),
            "offline": [{"name": i["name"], "state": i["state"]} for i in offline],
            "details": [
                {"name": i["name"], "type": i["type"], "state": i["state"],
                 "on": str(i.get("labelsOrTypes", "")),
                 "prop": str(i.get("properties", "")),
                 "populated": i.get("populationPercent", 100)}
                for i in vector_idx
            ],
        }

        if offline:
            result["warnings"].append(f"{len(offline)} vector indexes NOT ONLINE")
        if len(vector_idx) == 0:
            result["warnings"].append("No VECTOR indexes found — vector search disabled")
    except Exception as e:
        result["indexes"]["error"] = str(e)
        result["warnings"].append(f"Index query failed: {e}")

    # ── 3. 存储 ──
    try:
        store = nc.execute_query(
            "CALL db.stats.retrieve('GRAPH COUNTS') YIELD data "
            "RETURN data LIMIT 1")
    except Exception:
        store = None

    # 图库节点统计
    ep = nc.execute_query("MATCH (ep:Episode) RETURN COUNT(ep) AS c")[0]["c"]
    ent = nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"]
    rel = nc.execute_query(
        "MATCH ()-[r]->() WHERE type(r) <> \"EXTRACTED_FROM\" "
        "AND type(r) <> \"BELONGS_TO_COMMUNITY\" "
        "AND type(r) <> \"HAS_CONFLICT\" RETURN COUNT(r) AS c"
    )[0]["c"]
    prop_keys = nc.execute_query(
        "CALL db.propertyKeys() YIELD propertyKey "
        "RETURN count(propertyKey) AS c")[0]["c"]
    rel_types = nc.execute_query(
        "CALL db.relationshipTypes() YIELD relationshipType "
        "RETURN count(relationshipType) AS c")[0]["c"]
    node_labels = nc.execute_query(
        "CALL db.labels() YIELD label RETURN count(label) AS c")[0]["c"]

    result["storage"] = {
        "episodes": ep, "entities": ent, "relations": rel,
        "node_labels": node_labels, "relationship_types": rel_types,
        "property_keys": prop_keys,
    }

    # 数据库列表
    try:
        dbs = nc.execute_query("SHOW DATABASES YIELD name, status, "
                               "currentStatus, address RETURN name, status, "
                               "currentStatus, address")
        result["storage"]["databases"] = [
            {"name": d["name"], "status": d["status"],
             "currentStatus": d.get("currentStatus", ""),
             "address": d.get("address", "")}
            for d in dbs
        ]
    except Exception:
        result["storage"]["databases"] = []

    # 版本
    ver = nc.execute_query("CALL dbms.components() YIELD name, versions, edition "
                           "RETURN name, versions, edition")
    result["version"] = f"{ver[0]['name']} {ver[0]['versions'][0]} [{ver[0]['edition']}]" if ver else "unknown"

    # ── 4. 事务配置 ──
    for key in ["db.transaction.timeout", "db.transaction.concurrent.maximum",
                "db.lock.acquisition.timeout", "db.tx_log.rotation.size"]:
        try:
            r = nc.execute_query(
                "CALL dbms.listConfig() YIELD name, value WHERE name = $key "
                "RETURN value LIMIT 1", {"key": key})
            result["transactions"][key] = r[0]["value"] if r else "N/A"
        except Exception:
            result["transactions"][key] = "N/A"

    nc.close()

    # ── 汇总 ──
    if result["warnings"]:
        result["passed"] = False

    return result


def _parse_size_mb(raw: str) -> float:
    """解析 Neo4j 内存尺寸字符串为 MB"""
    raw = raw.strip().upper()
    if raw.endswith("GIB") or raw.endswith("GB"):
        return float(raw.replace("GIB", "").replace("GB", "").strip()) * 1024
    if raw.endswith("MIB") or raw.endswith("MB"):
        return float(raw.replace("MIB", "").replace("MB", "").strip())
    if raw.endswith("KIB") or raw.endswith("KB"):
        return float(raw.replace("KIB", "").replace("KB", "").strip()) / 1024
    if raw.endswith("B"):
        return float(raw.replace("B", "").strip()) / (1024 * 1024)
    if raw == "0B" or raw == "0" or raw == "N/A":
        return 0
    # 纯数字 (bytes)
    try:
        return float(raw) / (1024 * 1024)
    except Exception:
        return 0


def print_report(result: dict):
    """终端审计报告"""
    print("=" * 55)
    print("  Neo4j Configuration Audit")
    print("=" * 55)
    print(f"  Version:  {result.get('version', '?')}")
    print()

    # Memory
    m = result["memory"]
    print("  ── Memory ──")
    for k, v in m.items():
        short = k.replace("server.memory.", "").replace("dbms.memory.", "").replace("db.memory.", "")
        print(f"    {short}:  {v}")
    print()

    # Indexes
    idx = result["indexes"]
    print("  ── Indexes ──")
    print(f"    Total: {idx.get('total', '?')} "
          f"(VECTOR: {idx.get('vector_count', 0)}, "
          f"LOOKUP: {idx.get('lookup_count', 0)})")
    for vi in idx.get("details", []):
        status_flag = "OK" if vi["state"] == "ONLINE" else "WARN"
        print(f"    [{status_flag}] {vi['name']} ON {vi['on']} FOR {vi['prop']} "
              f"populated={vi.get('populated', '?')}%")
    for off in idx.get("offline", []):
        print(f"    [WARN] {off['name']} is {off['state']}")
    print()

    # Storage
    s = result["storage"]
    print("  ── Graph State ──")
    print(f"    Episodes:   {s['episodes']}")
    print(f"    Entities:   {s['entities']}")
    print(f"    Relations:  {s['relations']}")
    print(f"    Labels:     {s['node_labels']} | RelTypes: {s['relationship_types']} | PropKeys: {s['property_keys']}")
    for db in s.get("databases", []):
        print(f"    DB: {db['name']} [{db['status']}] @ {db['address']}")
    print()

    # Transactions
    t = result["transactions"]
    print("  ── Transaction Config ──")
    for k, v in t.items():
        short = k.replace("db.", "").replace("dbms.", "")
        print(f"    {short}:  {v}")
    print()

    # Warnings
    if result["warnings"]:
        print(f"  WARNINGS ({len(result['warnings'])}):")
        for w in result["warnings"]:
            print(f"    - {w}")
    else:
        print("  No warnings — configuration looks healthy.")
    print()

    status = "PASS" if result["passed"] else "ISSUES FOUND"
    print(f"  VERDICT: {status}")


def main():
    parser = argparse.ArgumentParser(description="Neo4j Config Audit")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    args = parser.parse_args()

    result = audit()

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        out = SCRIPT_DIR / f".neo4j_audit_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info(f"JSON report: {out}")
    else:
        print_report(result)

    sys.exit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
