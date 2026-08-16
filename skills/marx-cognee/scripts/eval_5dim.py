"""
5-Dim A/B Evaluation v5.3 — GRAPH_COMPLETION: verify=OFF vs verify=ON.
Cache cleared. Each run collects fresh answers from Neo4j.
"""

import asyncio, json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, ".")
import dotenv; dotenv.load_dotenv(override=True)

from cognee.api.v1.search import search, SearchType
from cognee.modules.users.methods import get_default_user

GROUND_TRUTH = Path("eval/ground_truth_30q.json")
RESULTS_HYBRID = Path("eval/eval_results_5dim_v5.json")      # v5.1 baseline (HYBRID, no verify)
RESULTS_OFF = Path("eval/eval_results_5dim_off.json")        # GRAPH_COMPLETION, verify=OFF
RESULTS_ON = Path("eval/eval_results_5dim_on.json")          # GRAPH_COMPLETION, verify=ON

TOP_K = 10
TIMEOUT = 300.0


async def five_dim_judge(query, gt_answer, candidate_answer, gt_entities):
    """5-dimension LLM judge."""
    import httpx
    from openai import OpenAI
    ep = os.getenv("LLM_ENDPOINT", "")
    ak = os.getenv("LLM_API_KEY", "")
    raw_md = os.getenv("LLM_MODEL", "openai/qwen-plus")
    md = raw_md.replace("openai/", "") if raw_md.startswith("openai/") else raw_md
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
1. Faithfulness（忠实度 0-1）：候选回答中的事实声称是否都能在标准答案中找到对应？有无编造不存在的人名、地名、数据、因果？
2. Relevance（相关性 0-1）：候选回答与问题的匹配程度？有无答非所问？
3. Completeness（完整性 0-1）：候选回答覆盖了标准答案的多少方面？有无遗漏关键维度？
4. Attribution（溯源度 0-1）：候选回答是否引用了具体来源/论文/数据？是否可追溯到具体文献？
5. Overall（综合 0-1）：综合4个维度的整体质量。

只输出JSON（不要其他文字）：
{{"faithfulness":0.X,"relevance":0.X,"completeness":0.X,"attribution":0.X,"overall":0.X,"note":"一句话总结"}}"""

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


async def collect_and_judge(label, verify_enabled, output_path):
    """Collect 30 answers and run 5-dim judge. Save to output_path."""
    print(f"\n{'='*70}")
    print(f"{label}: verify={'ON' if verify_enabled else 'OFF'}")
    print(f"{'='*70}")

    gt_data = json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))
    gt_queries = gt_data["queries"]
    user = await get_default_user()

    print(f"\nCollecting {len(gt_queries)} answers...")
    collected = []
    for i, qd in enumerate(gt_queries):
        q = qd["query"]
        t0 = time.time()
        try:
            r = await asyncio.wait_for(
                search(
                    query_text=q, query_type=SearchType.GRAPH_COMPLETION,
                    datasets=["capital_batch_000"], top_k=TOP_K,
                ),
                timeout=TIMEOUT,
            )
            elapsed = time.time() - t0
            collected.append({
                "query": q, "answer": str(r)[:4000],
                "elapsed": round(elapsed, 2), "error": None,
            })
            print(f"  [{i+1:2d}/30] {elapsed:.0f}s {q[:35]}")
        except Exception as e:
            elapsed = time.time() - t0
            collected.append({
                "query": q, "answer": f"[ERROR] {e}",
                "elapsed": round(elapsed, 2), "error": str(e)[:200],
            })
            print(f"  [{i+1:2d}/30] ERR: {type(e).__name__}")

    print(f"\nJudging {len(collected)} answers...")
    judged = []
    for i, (row, qd) in enumerate(zip(collected, gt_queries)):
        q = row["query"]
        ga = qd.get("ground_truth_answer", "")
        ge = qd.get("expected_entities", [])
        answer = row.get("answer", "")

        if not row.get("error"):
            scores = await five_dim_judge(q, ga, answer, ge)
        else:
            scores = {"faithfulness":0,"relevance":0,"completeness":0,"attribution":0,"overall":0,"note":"error"}
        scores["elapsed"] = row.get("elapsed", 0)
        scores["query"] = q[:50]
        scores["difficulty"] = qd.get("difficulty", "medium")
        judged.append(scores)

        f = scores.get("faithfulness", 0)
        r = scores.get("relevance", 0)
        c = scores.get("completeness", 0)
        a = scores.get("attribution", 0)
        o = scores.get("overall", 0)
        print(f"  [{i+1:2d}/30] F={f:.2f} R={r:.2f} C={c:.2f} A={a:.2f} O={o:.2f} | {q[:30]}")

    # Summary
    dims = ["faithfulness","relevance","completeness","attribution","overall"]
    all_scores = {d: [] for d in dims}
    elapsed_vals = []
    for j in judged:
        elapsed_vals.append(j.get("elapsed", 0))
        for d in dims:
            all_scores[d].append(j.get(d, 0))
    n = max(len(all_scores["faithfulness"]), 1)

    summary = {d: round(sum(all_scores[d]) / n, 4) for d in dims}
    summary["avg_latency"] = round(sum(elapsed_vals) / max(len(elapsed_vals), 1), 1)

    # Per-difficulty
    per_diff = {}
    for diff in ["easy","medium","hard"]:
        d_scores = {d: [] for d in dims}
        for j in judged:
            if j.get("difficulty") == diff:
                for d in dims:
                    d_scores[d].append(j.get(d, 0))
        if d_scores["faithfulness"]:
            per_diff[diff] = {
                "count": len(d_scores["faithfulness"]),
                "faithfulness": round(sum(d_scores["faithfulness"])/len(d_scores["faithfulness"]), 4),
                "overall": round(sum(d_scores["overall"])/len(d_scores["overall"]), 4),
            }

    report = {
        "label": label, "verify_enabled": verify_enabled,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "num_queries": n, "summary": summary, "per_difficulty": per_diff,
        "details": judged,
    }
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    return summary, per_diff


async def main():
    print("=" * 70)
    print("A/B 5-Dim Evaluation — GRAPH_COMPLETION: verify OFF vs ON")
    print("=" * 70)

    gt_data = json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))

    # Load HYBRID baseline from v5.1
    hybrid_baseline = {}
    if RESULTS_HYBRID.exists():
        hb = json.loads(RESULTS_HYBRID.read_text(encoding="utf-8"))
        hybrid_baseline = hb.get("summary", {})
        print(f"\nHYBRID baseline loaded: F={hybrid_baseline.get('faithfulness',0):.4f}")

    # ═══ Run A: verify=OFF ═══
    # Temporarily disable verify in factory
    factory_path = Path("cognee/modules/search/methods/get_search_type_retriever_instance.py")
    orig = factory_path.read_text(encoding="utf-8")
    # Set GRAPH_COMPLETION verify to False
    content = orig.replace('"verify_faithfulness": True,', '"verify_faithfulness": False,')
    # Also set for the GRAPH_COMPLETION entry specifically (find and replace all)
    factory_path.write_text(content, encoding="utf-8")

    import importlib
    import cognee.modules.search.methods.get_search_type_retriever_instance as mod
    importlib.reload(mod)

    try:
        summary_off, per_diff_off = await collect_and_judge(
            "A (verify=OFF)", False, RESULTS_OFF
        )
    finally:
        factory_path.write_text(orig, encoding="utf-8")
        importlib.reload(mod)

    # ═══ Clear cache between runs ═══
    import sqlite3
    db = Path("cognee/.cognee_system/databases/cache.db")
    if db.exists():
        conn = sqlite3.connect(str(db))
        conn.execute("DELETE FROM cache_kv WHERE key LIKE 'query_result:%'")
        conn.commit()
        conn.close()

    # ═══ Run B: verify=ON ═══
    # Restore verify=True for GRAPH_COMPLETION
    summary_on, per_diff_on = await collect_and_judge(
        "B (verify=ON)", True, RESULTS_ON
    )

    # ═══ Comparison table ═══
    dims = ["faithfulness","relevance","completeness","attribution","overall"]

    print(f"\n{'='*70}")
    print(f"COMPARISON TABLE (30 queries, GRAPH_COMPLETION)")
    print(f"{'='*70}")
    header = f"{'Dimension':15s}"
    if hybrid_baseline:
        header += f" | {'HYBRID':>8s}"
    header += f" | {'OFF':>8s} | {'ON':>8s} | {'Diff':>8s}"
    print(header)
    print("-" * 70)

    for d in dims:
        row = f"  {d:15s}"
        if hybrid_baseline:
            row += f" | {hybrid_baseline.get(d,0):8.4f}"
        row += f" | {summary_off.get(d,0):8.4f} | {summary_on.get(d,0):8.4f}"
        diff = summary_on.get(d,0) - summary_off.get(d,0)
        sign = "+" if diff >= 0 else ""
        row += f" | {sign}{diff:7.4f}"
        print(row)

    print(f"\n  {'avg latency':15s} | {summary_off.get('avg_latency',0):.0f}s (OFF) vs {summary_on.get('avg_latency',0):.0f}s (ON)")

    print(f"\n{'─'*70}")
    print("Per-Difficulty Comparison")
    for diff in ["easy","medium","hard"]:
        off_f = per_diff_off.get(diff,{}).get("faithfulness",0)
        on_f = per_diff_on.get(diff,{}).get("faithfulness",0)
        delta = on_f - off_f
        sign = "+" if delta >= 0 else ""
        print(f"  {diff:6s}: OFF={off_f:.3f} → ON={on_f:.3f} ({sign}{delta:.3f})")

    print(f"\n{'='*70}")
    print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
