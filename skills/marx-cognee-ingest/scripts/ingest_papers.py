#!/usr/bin/env python3
"""Cognee batch ingest — incremental batches with dedup + rate limiting."""
import os, sys, asyncio, time, json
from pathlib import Path
from datetime import datetime

os.chdir(r"%USERPROFILE%\cognee")
sys.path.insert(0, r"%USERPROFILE%\cognee")
from dotenv import load_dotenv
load_dotenv(".env")

import cognee
from neo4j import GraphDatabase

NEO4J_URI = os.getenv("GRAPH_DATABASE_URL", "bolt://127.0.0.1:11003")
NEO4J_USER = os.getenv("GRAPH_DATABASE_USERNAME", "neo4j")
NEO4J_PASS = os.getenv("GRAPH_DATABASE_PASSWORD", "neo4j123")
BATCHES_DIR = Path(r"%USERPROFILE%\cognee\.batches")
CHECKPOINT_FILE = Path(r"%USERPROFILE%\cognee\.ingest_checkpoint.json")
MAX_RETRIES = 3
RATE_SLEEP = 15

def load_cp():
    if CHECKPOINT_FILE.exists():
        return json.loads(CHECKPOINT_FILE.read_text("utf-8"))
    return {"done": [], "failed": {}}

def save_cp(cp):
    CHECKPOINT_FILE.write_text(json.dumps(cp, ensure_ascii=False, indent=2), "utf-8")

def get_stats():
    d = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASS))
    s = d.session()
    t = s.run("MATCH (n) RETURN count(n) AS c").single()["c"]
    en = s.run("MATCH (n:Entity) RETURN count(n) AS c").single()["c"]
    td = s.run("MATCH (n:TextDocument) RETURN count(n) AS c").single()["c"]
    rl = s.run("MATCH ()-[r]->() RETURN count(r) AS c").single()["c"]
    d.close()
    return t, en, td, rl

def mark_processed():
    d = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASS))
    s = d.session()
    c = s.run("MATCH (d:TextDocument) WHERE d.cognify_processed <> true SET d.cognify_processed = true RETURN count(d) AS c").single()["c"]
    d.close()
    return c

def dedup():
    d = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASS))
    s = d.session()
    try:
        de = s.run("MATCH (e:Entity) WITH e.name AS n, collect(e) AS g, count(*) AS c WHERE c>1 UNWIND g[1..] AS d DETACH DELETE d RETURN count(d) AS x").single()
        de = de["x"] if de else 0
    except:
        de = 0
    try:
        dd = s.run("MATCH (d:TextDocument) WHERE d.raw_data_location IS NOT NULL WITH d.raw_data_location AS l, collect(d) AS g, count(*) AS c WHERE c>1 UNWIND g[1..] AS x DETACH DELETE x RETURN count(x) AS y").single()
        dd = dd["y"] if dd else 0
    except:
        dd = 0
    d.close()
    return de, dd

async def run_batch(batch_dir, ds_name):
    for attempt in range(MAX_RETRIES):
        try:
            await cognee.add(str(batch_dir), dataset_name=ds_name)
            await cognee.cognify(datasets=[ds_name])
            return True
        except Exception as e:
            msg = str(e).lower()
            if "429" in msg or "rate" in msg or "throttl" in msg:
                w = RATE_SLEEP * (attempt + 1)
                print(f"  [429] sleeping {w}s ...")
                await asyncio.sleep(w)
            elif "database is locked" in msg:
                print(f"  [locked] sleeping 10s ...")
                await asyncio.sleep(10)
            else:
                print(f"  Error: {str(e)[:200]}")
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(5)
                else:
                    return False
    return False

async def main():
    cp = load_cp()
    batches = sorted([d for d in BATCHES_DIR.iterdir() if d.is_dir() and d.name.startswith("batch_")])
    print(f"Batches: {len(batches)} | Done: {cp['done']}")

    for bd in batches:
        if bd.name in cp["done"]:
            print(f"\n{bd.name}: SKIP")
            continue

        papers = len(list(bd.iterdir()))
        ds = f"capital_{bd.name}"
        print(f"\n{'='*50}")
        print(f"{bd.name}: {papers} papers")
        print(f"{'='*50}")

        t0 = time.time()
        ok = await run_batch(bd, ds)

        if ok:
            marked = mark_processed()
            de, dd = dedup()
            t, en, td, rl = get_stats()
            cp["done"].append(bd.name)
            save_cp(cp)
            print(f"  OK {time.time()-t0:.0f}s | Marked:{marked} Dedup:{de}E/{dd}D")
            print(f"  Neo4j: {t} nodes, {en} Entities, {td} TextDocs, {rl} rels")
            print(f"  Papers: {td//4}/208 ({round(td/4/208*100)}%)")
        else:
            print(f"  FAILED")
            cp["failed"][bd.name] = str(datetime.now())
            save_cp(cp)

    t, en, td, rl = get_stats()
    print(f"\n=== DONE ===")
    print(f"Total: {t} nodes | {en} Entities | {td} TextDocs | {rl} rels")
    print(f"Papers: {td//4}/208 ({round(td/4/208*100)}%)")

if __name__ == "__main__":
    asyncio.run(main())
