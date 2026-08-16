#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
API Token 成本仪表盘
从 SQLite 缓存 + Neo4j 图状态计算全流程消耗
"""
import sys, json, sqlite3
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

from pipeline import get_logger, Neo4jConnection
from pipeline.cache import CACHE_DIR

logger = get_logger("token_dashboard")
CACHE_DB = CACHE_DIR / "text_cache.db"


def compute_dashboard():
    now = datetime.now()

    # ---- LLM cache ----
    llm_total_calls = 0
    llm_total_tokens = 0
    llm_hits = 0
    daily_tokens = {}

    if CACHE_DB.exists():
        conn = sqlite3.connect(str(CACHE_DB))
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT hash_key, total_tokens, hit_count, last_hit, created_at FROM llm_cache").fetchall()
        llm_total_calls = len(rows)
        llm_total_tokens = sum((r["total_tokens"] or 0) for r in rows)
        llm_hits = sum((r["hit_count"] or 0) for r in rows)
        for r in rows:
            dt = (r["created_at"] or "")[:10]
            if dt:
                daily_tokens[dt] = daily_tokens.get(dt, 0) + (r["total_tokens"] or 0)
        conn.close()

    # ---- Embedding cache ----
    emb_calls = 0
    if CACHE_DB.exists():
        conn = sqlite3.connect(str(CACHE_DB))
        emb_calls = conn.execute("SELECT COUNT(*) FROM embedding_cache").fetchone()[0]
        conn.close()
    emb_tokens_est = emb_calls * 200

    # ---- Cost (real pricing) ----
    # qwen3.7-max: input $0.00057/1K ($0.57/M), output $0.00171/1K ($1.71/M) -> ~RMB 0.004/0.012 per 1K
    # text-embedding-v4: RMB 0.0007/1K
    input_est = llm_total_tokens * 0.2
    output_est = llm_total_tokens * 0.8
    llm_cost = (input_est / 1000) * 0.004 + (output_est / 1000) * 0.012
    emb_cost = (emb_tokens_est / 1000) * 0.0007
    total_cost = llm_cost + emb_cost

    # ---- Graph state ----
    nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
    g = {
        "episodes": nc.execute_query("MATCH (ep:Episode) RETURN COUNT(ep) AS c")[0]["c"],
        "entities": nc.execute_query("MATCH (e:Entity) RETURN COUNT(e) AS c")[0]["c"],
        "relations": nc.execute_query(
            "MATCH ()-[r]->() WHERE type(r) <> \"EXTRACTED_FROM\" AND type(r) <> \"BELONGS_TO_COMMUNITY\" AND type(r) <> \"HAS_CONFLICT\" RETURN COUNT(r) AS c"
        )[0]["c"],
        "communities": nc.execute_query("MATCH (c:Community) RETURN COUNT(c) AS c")[0]["c"],
        "conflicts": nc.execute_query("MATCH (c:Conflict) RETURN COUNT(c) AS c")[0]["c"],
        "vectors": nc.execute_query("MATCH (e:Entity) WHERE e.entity_vector IS NOT NULL RETURN COUNT(e) AS c")[0]["c"],
    }
    nc.close()

    return {
        "timestamp": now.isoformat(),
        "graph": g,
        "tokens": {
            "llm_calls": llm_total_calls,
            "llm_tokens": llm_total_tokens,
            "llm_cache_hits": llm_hits,
            "embedding_calls": emb_calls,
            "embedding_tokens_est": emb_tokens_est,
        },
        "cost": {
            "llm": round(llm_cost, 4),
            "embedding": round(emb_cost, 4),
            "total": round(total_cost, 4),
        },
        "daily_tokens": dict(sorted(daily_tokens.items())),
    }


def print_report(d):
    g = d["graph"]
    t = d["tokens"]
    c = d["cost"]

    lines = []
    lines.append("=" * 50)
    lines.append("  API Token Cost Dashboard")
    lines.append("=" * 50)
    lines.append(f"  Updated: {d['timestamp'][:19]}")
    lines.append("")
    lines.append("  Graph State:")
    lines.append(f"    Episodes:   {g['episodes']:>6}")
    lines.append(f"    Entities:   {g['entities']:>6}")
    lines.append(f"    Relations:  {g['relations']:>6}")
    lines.append(f"    Communities:{g['communities']:>6}")
    lines.append(f"    Conflicts:  {g['conflicts']:>6}")
    lines.append(f"    Vectors:    {g['vectors']:>6}")
    lines.append("")
    lines.append("  Token Usage:")
    lines.append(f"    LLM calls:      {t['llm_calls']:>8}")
    lines.append(f"    LLM tokens:     {t['llm_tokens']:>8}")
    lines.append(f"    LLM cache hits: {t['llm_cache_hits']:>8}")
    lines.append(f"    Embedding:      {t['embedding_calls']:>8} calls")
    lines.append(f"    Embed tokens:   {t['embedding_tokens_est']:>8} (est)")
    lines.append("")
    lines.append("  Cost (RMB):")
    lines.append(f"    LLM (qwen3.7-max):  {c['llm']:>10.4f}")
    lines.append(f"    Embedding:          {c['embedding']:>10.4f}")
    lines.append(f"    TOTAL:              {c['total']:>10.4f}")
    lines.append("")
    lines.append("  Pricing:")
    lines.append("    qwen3.7-max: RMB 4/M input, RMB 12/M output")
    lines.append("    text-embedding-v4: RMB 0.7/M tokens")
    lines.append("=" * 50)

    text = "\n".join(lines)
    print(text)

    # Next stage estimate
    ep = g["episodes"]
    est_distill = ep * 8000
    est_cost = (est_distill * 0.2 / 1000) * 0.004 + (est_distill * 0.8 / 1000) * 0.012
    print(f"\n  Next: Literature Distill x {ep}")
    print(f"    Est tokens: ~{est_distill:,}")
    print(f"    Est cost:   ~RMB {est_cost:.2f}")
    print()

    # Write to UTF-8 file to avoid GBK issues
    report_path = Path(__file__).parent / f"cost_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    report_path.write_text(text + "\n", encoding="utf-8")
    logger.info(f"Report: {report_path}")


def main():
    logger.info("Computing token dashboard...")
    d = compute_dashboard()
    print_report(d)


if __name__ == "__main__":
    main()
