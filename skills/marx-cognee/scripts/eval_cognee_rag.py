"""
Cognee RAG 评估 v4 — 快速冒烟 (保留用于日常巡检)

完整质量评估请用: eval_cognee_rag_full.py
"""
import asyncio, os, time

os.chdir("%USERPROFILE%/cognee")
import dotenv; dotenv.load_dotenv(override=True)

from cognee.api.v1.search import search, SearchType
from cognee.api.v1.datasets.datasets import datasets as ds
from cognee.modules.users.methods import get_default_user

EVAL_QUERIES = [
    ("资本下乡对乡村治理有什么影响", "乡村治理 权力关系", "hard"),
    ("农地流转中农户权益如何保障", "土地流转 农户权益", "medium"),
    ("工商资本进入农业领域有哪些模式", "投资模式 产业类型", "easy"),
    ("土地流转违约风险的原因和后果", "违约 风险 治理", "hard"),
    ("资本下乡中的政府角色", "政府 政策 监管", "easy"),
    ("龙头企业与合作社的关系", "企业 合作社 合作", "medium"),
    ("资本下乡对农民收入的影响", "收入 就业 福利", "medium"),
    ("精准扶贫与资本下乡的关联", "扶贫 政策 资本", "medium"),
    ("农村土地制度改革对资本下乡的促进", "土地制度 改革", "hard"),
    ("资本下乡失败案例的共同特征", "失败 风险 治理", "hard"),
]

SEARCH_TYPES = [
    SearchType.HYBRID_COMPLETION,
    SearchType.GRAPH_COMPLETION,
    SearchType.GRAPH_COMPLETION_COT,
    SearchType.GRAPH_COMPLETION_DECOMPOSITION,
    SearchType.CHUNKS,
    SearchType.TRIPLET_COMPLETION,
]

def fmt(s): return f"{s*1000:.0f}ms" if s < 1 else f"{s:.1f}s"

async def main():
    print("=" * 70)
    print("COGNEE RAG 日常巡检 v4 (快速冒烟)")
    print("=" * 70)

    user = await get_default_user()
    all_ds = await ds.list_datasets(user=user)
    capital_ds = [d.name for d in all_ds if "capital" in d.name.lower() or "batch" in d.name.lower()]
    print(f"\n可用数据集: {capital_ds}")

    # 使用 capital_batch_000 数据集
    test_ds = ["capital_batch_000"] if any("capital_batch_000" in d.name for d in all_ds) else [capital_ds[0]]
    if not test_ds or not test_ds[0]:
        test_ds = [all_ds[0].name]
    print(f"测试目标数据集: {test_ds}")

    # ======= Phase 1: 6 search_type 对比 =======
    print(f"\n{'─'*70}")
    print(f"Phase 1: search_type 多策略对比")
    print(f"  Query: {EVAL_QUERIES[0][0]}")
    print(f"{'─'*70}")

    p1 = []
    for st in SEARCH_TYPES:
        name = st.value
        t0 = time.time()
        try:
            r = await asyncio.wait_for(
                search(EVAL_QUERIES[0][0], query_type=st, datasets=test_ds, top_k=5),
                timeout=120.0,
            )
            elapsed = time.time() - t0
            rlen = len(r) if isinstance(r, (list, str)) else 0
            p1.append({"type": name, "elapsed": elapsed, "len": rlen, "err": None})
            print(f"  {name:36s} {fmt(elapsed):>8s}  len={rlen}")
        except Exception as e:
            elapsed = time.time() - t0
            err = str(e)[:80]
            p1.append({"type": name, "elapsed": elapsed, "len": 0, "err": err})
            print(f"  {name:36s} {fmt(elapsed):>8s}  ERR: {type(e).__name__}")

    # ======= Phase 2: 10 queries × 3 types =======
    print(f"\n{'─'*70}")
    print(f"Phase 2: 多查询覆盖 (10 queries × 3 types)")
    print(f"{'─'*70}")

    p2_types = [SearchType.HYBRID_COMPLETION, SearchType.GRAPH_COMPLETION, SearchType.GRAPH_COMPLETION_COT]
    p2_total = 0
    p2_ok = 0

    for q_text, theme, diff in EVAL_QUERIES:
        ok_count = 0
        for st in p2_types:
            try:
                r = await asyncio.wait_for(
                    search(q_text, query_type=st, datasets=test_ds, top_k=5),
                    timeout=120.0,
                )
                ok_count += 1
            except Exception:
                pass
        p2_total += 3
        p2_ok += ok_count
        print(f"  [{diff:6s}] {q_text[:45]:45s} {ok_count}/3 OK")

    # ======= Phase 3: 速度基准 =======
    print(f"\n{'─'*70}")
    print(f"Phase 3: HYBRID_COMPLETION 速度基准 (5 runs)")
    print(f"{'─'*70}")

    timings = []
    for i in range(5):
        t0 = time.time()
        try:
            r = await asyncio.wait_for(
                search("工商资本进入农业", query_type=SearchType.HYBRID_COMPLETION, datasets=test_ds, top_k=5),
                timeout=60.0,
            )
            dt = time.time() - t0
            timings.append(dt)
            print(f"  Run {i+1}: {fmt(dt)}")
        except Exception as e:
            dt = time.time() - t0
            print(f"  Run {i+1}: {fmt(dt)} ERR: {type(e).__name__}")

    # ======= Summary =======
    print(f"\n{'='*70}")
    print("评估汇总")
    print(f"{'='*70}")

    p1_ok = sum(1 for r in p1 if r["err"] is None)
    print(f"\nPhase 1 — 策略可用率: {p1_ok}/{len(p1)}")
    for r in p1:
        s = "OK" if r["err"] is None else f"ERR: {r['err'][:50]}"
        print(f"  {r['type']:40s} {fmt(r['elapsed']):>8s}  {s}")

    print(f"\nPhase 2 — 查询成功率: {p2_ok}/{p2_total} ({100*p2_ok//p2_total}%)")

    if timings:
        avg = sum(timings)/len(timings)
        print(f"\nPhase 3 — 速度: avg={fmt(avg)}  min={fmt(min(timings))}  max={fmt(max(timings))}")

    conn_errs = sum(1 for r in p1 if r.get("err") and ("connect" in r["err"].lower() or "timeout" in r["err"].lower()))
    print(f"\n连接错误: {conn_errs}/6")
    if conn_errs == 0:
        print("连接稳定性: PASS (DISABLE_AIOHTTP_TRANSPORT 生效)")

    print(f"\n{'='*70}")
    print("评估完成")
    print(f"{'='*70}")

if __name__ == "__main__":
    asyncio.run(main())
