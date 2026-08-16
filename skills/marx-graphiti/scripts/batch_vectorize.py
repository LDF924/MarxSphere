"/usr/bin/env python3"
"Vectorize all entities without entity_vector (batch=10, text-embedding-v4)"
import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from pipeline.neo4j import Neo4jConnection
from pipeline.api_client import QwenEmbeddingClient

nc = Neo4jConnection("bolt://127.0.0.1:11001", "neo4j", "neo4j123")
emb = QwenEmbeddingClient()
emb.monitor.set_calling_script("batch_vectorize.py")

# 预停机回调: 记录向量化进度
def _vec_shutdown_saver(script_name, cost, budget_limit):
    pct_done = processed / total * 100 if total > 0 else 0
    print(f"Vectorize checkpoint: {processed}/{total} ({pct_done:.1f}%) done", flush=True)

emb.monitor.set_checkpoint_saver(_vec_shutdown_saver)

total = nc.execute_query("MATCH (e:Entity) WHERE e.entity_vector IS NULL RETURN count(e) AS c")[0]["c"]
print(f"Entities without vector: {total}")

batch_size = 10
processed = 0
t_start = time.time()

while True:
    batch = nc.execute_query(
        "MATCH (e:Entity) WHERE e.entity_vector IS NULL "
        "RETURN e.name AS n, e.category AS c, e.description AS d, e.subcategory AS s, e.context AS ctx "
        "LIMIT $bs",
        {"bs": batch_size}
    )
    if not batch:
        break

    # 预停机检查
    if emb.monitor.is_shutdown():
        print(f"BUDGET EXCEEDED. Stopping vectorization. {processed}/{total} done.", flush=True)
        break

    texts = []
    ids = []
    for row in batch:
        def to_str(val):
            if isinstance(val, list):
                return ", ".join(str(x) for x in val)
            return str(val) if val is not None else ""

        parts = [to_str(row["n"]), to_str(row["c"]), to_str(row["s"]), to_str(row["d"]), to_str(row["ctx"])]
        text = " ".join(filter(None, parts))
        texts.append(text[:8000])
        ids.append(row["n"])

    vectors = emb.embed_batch(texts, timeout=60)
    if vectors is None:
        print(f"embed_batch returned None, sleeping 10s...")
        time.sleep(10)
        continue

    for name, vec in zip(ids, vectors):
        if vec and len(vec) == 1024:
            nc.execute_write(
                "MATCH (e:Entity {name: $n}) SET e.entity_vector = $v",
                {"n": name, "v": vec}
            )

    processed += len(ids)
    elapsed = (time.time() - t_start) / 60
    eta_h = (total - processed) / max(processed / elapsed if processed > 0 else 1, 1) / 60
    pct = processed / total * 100
    print(f"[{processed}/{total}] {pct:.1f}% | {elapsed:.0f}min | ~{eta_h:.1f}h left | batch={len(ids)}")

print(f"\nVectorization DONE. Total: {processed} | {elapsed:.0f}min")
nc.close()
