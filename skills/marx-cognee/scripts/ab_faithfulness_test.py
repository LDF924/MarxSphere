"""A/B faithfulness comparison v3 — bypass cache, direct retriever calls.

Phase 1: Collect 5 answers with verify_faithfulness=True.
Phase 2: Clear cache, collect 5 answers with verify_faithfulness=False.
Phase 3: Pairwise LLM judge.
"""

import asyncio, importlib, json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, ".")
import dotenv; dotenv.load_dotenv(override=True)

from cognee.modules.users.methods import get_default_user
from cognee.modules.search.types import SearchType
from cognee.modules.retrieval.graph_completion_retriever import GraphCompletionRetriever

QUERIES = [
    "资本下乡对乡村治理有什么影响",
    "农地流转中农户权益如何保障",
    "土地流转违约风险的原因和后果",
    "龙头企业与合作社的关系",
    "资本下乡失败案例的共同特征",
]

RESULTS_PATH = Path("eval/ab_faithfulness_results.json")


async def collect_with_verify(verify: bool, label: str) -> list[dict]:
    """Instantiate GraphCompletionRetriever directly, bypassing search cache."""
    retriever = GraphCompletionRetriever(
        top_k=5,
        verify_faithfulness=verify,
    )
    results = []
    for i, query in enumerate(QUERIES):
        print(f"  [{label}] Query {i+1}/{len(QUERIES)}: {query[:40]}...")
        t0 = time.time()
        try:
            completions = await retriever.get_completion(query=query)
            elapsed = time.time() - t0
            answer = str(completions[0]) if completions else "[NO RESULT]"
            results.append({
                "query": query,
                "answer": answer[:3000],
                "elapsed": round(elapsed, 2),
                "error": None,
            })
            print(f"    -> {elapsed:.1f}s, {len(answer)} chars")
        except Exception as e:
            elapsed = time.time() - t0
            results.append({
                "query": query,
                "answer": f"[ERROR] {e}",
                "elapsed": round(elapsed, 2),
                "error": str(e)[:200],
            })
            import traceback
            traceback.print_exc()
            print(f"    -> ERROR: {type(e).__name__}")
    return results


async def pairwise_judge(query: str, answer_a: str, answer_b: str) -> dict:
    """LLM judge: which answer is more faithful?"""
    import httpx; from openai import OpenAI
    ep = os.getenv("LLM_ENDPOINT", "")
    ak = os.getenv("LLM_API_KEY", "")
    raw_md = os.getenv("LLM_MODEL", "openai/qwen-plus")
    md = raw_md.replace("openai/", "") if raw_md.startswith("openai/") else raw_md
    cl = OpenAI(base_url=ep, api_key=ak, http_client=httpx.Client(timeout=60))

    prompt = f"""你是一个严格的事实核查员。下面是对同一问题的两个版本回答。判断哪个版本更忠实于事实（更少编造未经核实的实体/数字/因果声称）。

忠实度评判标准：
- 每个事实声称是否能找到支撑证据
- 出现了多少"无来源的具体数字/名称/百分比"
- "宁可少说不可乱说" → 更忠实

问题：{query}

回答A：
{answer_a[:2000]}

回答B：
{answer_b[:2000]}

只输出 JSON（不要其他文字）：
{{"winner": "A" 或 "B" 或 "tie", "score_a": 0.X, "score_b": 0.X, "reason": "一句话说明"}}"""

    try:
        r = cl.chat.completions.create(
            model=md, messages=[{"role": "user", "content": prompt}],
            temperature=0, max_tokens=256,
        )
        raw = r.choices[0].message.content.strip()
        m = re.search(r"\{[^}]+\}", raw)
        if m:
            return json.loads(m.group())
    except Exception:
        pass
    return {"winner": "error", "score_a": 0, "score_b": 0, "reason": "judge failed"}


async def main():
    print("=" * 70)
    print("A/B Faithfulness Comparison — Direct Retriever (no cache)")
    print("=" * 70)

    # Phase 1: verify=True
    print("\n── Phase 1: verify_faithfulness=ON ──")
    answers_on = await collect_with_verify(True, "ON")

    # Phase 2: verify=False
    print("\n── Phase 2: verify_faithfulness=OFF ──")
    answers_off = await collect_with_verify(False, "OFF")

    # Phase 3: Judge
    print(f"\n{'='*70}")
    print("Phase 3: Pairwise LLM Judge")
    print(f"{'='*70}")

    all_results = []
    for i, (a_on, a_off) in enumerate(zip(answers_on, answers_off)):
        query = a_on["query"]
        print(f"\n── Query {i+1}/5: {query[:50]}")

        # Skip if either failed
        if a_on["error"] or a_off["error"]:
            print(f"  SKIP: one version errored (ON={a_on['error']}, OFF={a_off['error']})")
            all_results.append({
                "query": query,
                "version_on": a_on,
                "version_off": a_off,
                "judge": {"winner": "skip", "score_a": 0, "score_b": 0, "reason": "error in one version"},
            })
            continue

        judge = await pairwise_judge(query, a_on["answer"], a_off["answer"])

        entry = {
            "query": query,
            "version_on": {"verify": True, "elapsed": a_on["elapsed"], "answer": a_on["answer"]},
            "version_off": {"verify": False, "elapsed": a_off["elapsed"], "answer": a_off["answer"]},
            "judge": judge,
        }
        all_results.append(entry)

        w = judge.get("winner", "?")
        sa = judge.get("score_a", 0)
        sb = judge.get("score_b", 0)
        print(f"  Winner: {w} | ON(verify)={sa:.2f}  OFF(no-verify)={sb:.2f}")
        print(f"  Reason: {judge.get('reason', '')}")
        print(f"  ON  first 200 chars: {a_on['answer'][:200]}")
        print(f"  OFF first 200 chars: {a_off['answer'][:200]}")

    # Summary
    valid = [r for r in all_results if r["judge"].get("winner") != "skip"]
    a_wins = sum(1 for r in valid if r["judge"].get("winner") == "A")
    b_wins = sum(1 for r in valid if r["judge"].get("winner") == "B")
    ties = sum(1 for r in valid if r["judge"].get("winner") == "tie")
    avg_sa = sum(r["judge"].get("score_a", 0) for r in valid) / max(len(valid), 1)
    avg_sb = sum(r["judge"].get("score_b", 0) for r in valid) / max(len(valid), 1)

    print(f"\n{'='*70}")
    print(f"SUMMARY ({len(valid)} valid pairs)")
    print(f"  A (verify=ON, qwen3.7-max)  wins: {a_wins}")
    print(f"  B (verify=OFF)              wins: {b_wins}")
    print(f"  Ties:           {ties}")
    print(f"  Avg score A:    {avg_sa:.3f}")
    print(f"  Avg score B:    {avg_sb:.3f}")
    print(f"{'='*70}")

    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "summary": {
            "a_wins": a_wins, "b_wins": b_wins, "ties": ties,
            "avg_score_a": round(avg_sa, 3), "avg_score_b": round(avg_sb, 3),
        },
        "details": all_results,
    }
    RESULTS_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {RESULTS_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
