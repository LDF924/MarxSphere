"""
Quick 5-dim snapshot: grab 10 representative queries, run GRAPH_COMPLETION
with verify=OFF and verify=ON, compare side by side.
"""

import asyncio, json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, ".")
import dotenv; dotenv.load_dotenv(override=True)

from cognee.api.v1.search import search, SearchType
from cognee.modules.users.methods import get_default_user

RESULTS = Path("eval/ab_10q_snapshot.json")

# 10 queries: mix of high-context and low-context
QUERIES = [
    ("资本下乡对乡村治理有什么影响", "hard"),
    ("农地流转中农户权益如何保障", "medium"),
    ("龙头企业与合作社的关系", "medium"),
    ("土地流转违约风险的原因和后果", "hard"),
    ("精准扶贫与资本下乡的关联", "medium"),
    ("农村土地制度改革对资本下乡的促进", "hard"),
    ("农地确权对土地流转市场的影响", "medium"),
    ("资本下乡失败案例的共同特征", "hard"),
    ("农地流转价格的决定因素", "medium"),
    ("城乡收入差距变化趋势及原因", "medium"),
]


async def five_dim_judge(query, gt_answer, candidate_answer, gt_entities):
    import httpx
    from openai import OpenAI
    ep = os.getenv("LLM_ENDPOINT", "")
    ak = os.getenv("LLM_API_KEY", "")
    md = os.getenv("LLM_MODEL", "openai/qwen-plus").replace("openai/", "")
    cl = OpenAI(base_url=ep, api_key=ak, http_client=httpx.Client(timeout=120))

    ca = str(candidate_answer)[:2500]
    ge = ", ".join(str(e)[:40] for e in (gt_entities or [])[:15])
    ga = str(gt_answer)[:2000]

    prompt = f"""你是一个RAG系统多维度评估器。对候选回答在5个维度上独立打分（0.0-1.0）。

问题：{query}
标准答案：{ga}
期望实体：{ge}
候选回答：{ca}

评分标准：
1. Faithfulness：事实声称是否都能在标准答案中找到对应？有无编造实体/数据/因果？
2. Relevance：回答与问题的匹配程度？有无答非所问？
3. Completeness：覆盖了标准答案的多少方面？
4. Attribution：是否引用了具体来源/论文/数据？
5. Overall：综合4个维度的整体质量。

只输出JSON：{{"faithfulness":0.X,"relevance":0.X,"completeness":0.X,"attribution":0.X,"overall":0.X,"note":"一句话"}}"""

    try:
        r = cl.chat.completions.create(
            model=md, messages=[{"role":"user","content":prompt}],
            temperature=0, max_tokens=300,
        )
        raw = r.choices[0].message.content.strip()
        m = re.search(r"\{[^}]+\}", raw)
        if m:
            scores = json.loads(m.group())
            for k in ["faithfulness","relevance","completeness","attribution","overall"]:
                scores.setdefault(k, 0.0)
            return scores
    except: pass
    return {"faithfulness":0,"relevance":0,"completeness":0,"attribution":0,"overall":0,"note":"judge failed"}


async def collect_for_queries(verify_enabled):
    """Collect answers for 10 queries with given verify setting."""
    user = await get_default_user()
    results = []
    for query, diff in QUERIES:
        t0 = time.time()
        try:
            r = await asyncio.wait_for(
                search(query_text=query, query_type=SearchType.GRAPH_COMPLETION,
                       datasets=["capital_batch_000"], top_k=10),
                timeout=300,
            )
            elapsed = time.time() - t0
            results.append({
                "query": query, "difficulty": diff,
                "answer": str(r)[:4000], "elapsed": round(elapsed, 2), "error": None,
            })
            print(f"  [{verify_enabled}] {elapsed:.0f}s {query[:35]}")
        except Exception as e:
            results.append({
                "query": query, "difficulty": diff,
                "answer": f"[ERROR] {e}", "elapsed": 0, "error": str(e)[:200],
            })
            print(f"  [{verify_enabled}] ERR: {type(e).__name__} for {query[:35]}")
    return results


async def main():
    print("=" * 60)
    print("10-Query A/B Snapshot: verify=OFF vs verify=ON")
    print("=" * 60)

    # Load ground truth
    gt = json.loads(Path("eval/ground_truth_30q.json").read_text(encoding="utf-8"))
    gt_map = {q["query"]: q for q in gt["queries"]}

    # ═══ Phase A: OFF ═══
    print("\n── A: verify=OFF ──")
    factory_path = Path("cognee/modules/search/methods/get_search_type_retriever_instance.py")
    orig = factory_path.read_text(encoding="utf-8")
    content = orig.replace('"verify_faithfulness": True,', '"verify_faithfulness": False,')
    factory_path.write_text(content, encoding="utf-8")
    import importlib, cognee.modules.search.methods.get_search_type_retriever_instance as mod
    importlib.reload(mod)

    try:
        off_answers = await collect_for_queries(False)
    finally:
        factory_path.write_text(orig, encoding="utf-8")
        importlib.reload(mod)

    # ═══ Clear cache ═══
    import sqlite3
    db = Path("cognee/.cognee_system/databases/cache.db")
    if db.exists():
        conn = sqlite3.connect(str(db))
        conn.execute("DELETE FROM cache_kv WHERE key LIKE 'query_result:%'")
        conn.commit(); conn.close()

    # ═══ Phase B: ON ═══
    print("\n── B: verify=ON ──")
    on_answers = await collect_for_queries(True)

    # ═══ Judge ═══
    print(f"\n{'='*60}")
    print("5-Dim Judge")
    print(f"{'='*60}")

    dims = ["faithfulness","relevance","completeness","attribution","overall"]
    off_scores = {d: [] for d in dims}
    on_scores = {d: [] for d in dims}

    details = []
    for a_off, a_on in zip(off_answers, on_answers):
        q = a_off["query"]
        g = gt_map.get(q, {})
        ga = g.get("ground_truth_answer", "")
        ge = g.get("expected_entities", [])

        off_j = await five_dim_judge(q, ga, a_off.get("answer",""), ge) if not a_off.get("error") else {d:0 for d in dims}
        on_j = await five_dim_judge(q, ga, a_on.get("answer",""), ge) if not a_on.get("error") else {d:0 for d in dims}

        details.append({
            "query": q[:50], "difficulty": a_off["difficulty"],
            "OFF": off_j, "ON": on_j,
            "elapsed_off": a_off.get("elapsed", 0),
            "elapsed_on": a_on.get("elapsed", 0),
        })

        for d in dims:
            off_scores[d].append(off_j.get(d, 0))
            on_scores[d].append(on_j.get(d, 0))

        f_off = off_j.get("faithfulness", 0)
        f_on = on_j.get("faithfulness", 0)
        delta = f_on - f_off
        sign = "+" if delta >= 0 else ""
        print(f"  {q[:35]:35s} F: {f_off:.2f}→{f_on:.2f} ({sign}{delta:.2f})")

    # ═══ Summary ═══
    print(f"\n{'='*60}")
    print(f"SUMMARY (10 queries)")
    print(f"{'='*60}")
    print(f"{'Dimension':15s} | {'OFF':>8s} | {'ON':>8s} | {'Diff':>8s}")
    print("-" * 50)
    for d in dims:
        avg_off = sum(off_scores[d]) / 10
        avg_on = sum(on_scores[d]) / 10
        delta = avg_on - avg_off
        sign = "+" if delta >= 0 else ""
        print(f"  {d:15s} | {avg_off:8.4f} | {avg_on:8.4f} | {sign}{delta:7.4f}")

    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "queries": 10,
        "summary_off": {d: round(sum(off_scores[d])/10, 4) for d in dims},
        "summary_on": {d: round(sum(on_scores[d])/10, 4) for d in dims},
        "details": details,
    }
    RESULTS.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {RESULTS}")


if __name__ == "__main__":
    asyncio.run(main())
