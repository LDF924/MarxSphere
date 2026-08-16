"""Step 1: 5-dim eval — GRAPH_COMPLETION + raw text augmentation ENABLED + verify=OFF.

Single-shot: collect 30 answers with raw paper context, judge, compare vs baseline.
"""
import asyncio, json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, ".")
import dotenv; dotenv.load_dotenv(override=True)

os.environ["ENABLE_RAW_TEXT_AUGMENT"] = "true"

from cognee.api.v1.search import search, SearchType
from cognee.modules.users.methods import get_default_user

GROUND_TRUTH = Path("eval/ground_truth_30q.json")
BASELINE = Path("eval/eval_results_5dim_v5.json")
OUTPUT = Path("eval/eval_results_step1_rawtext.json")
CHECKPOINT = Path("eval/.eval_checkpoint_step1.json")

TOP_K = 10
TIMEOUT = 180.0


def load_cp():
    if CHECKPOINT.exists():
        try: return json.loads(CHECKPOINT.read_text(encoding="utf-8"))
        except: pass
    return {}

def save_cp(data):
    CHECKPOINT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


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

    prompt = f"""RAG多维度评估。对候选回答在5个维度上独立打分。
问题：{query}
标准答案：{ga}
期望实体：{ge}
候选回答：{ca}

评分：
1. Faithfulness：事实声称是否在标准答案中找到对应？有无编造实体/数据/因果？
2. Relevance：是否答对问题？有无答非所问？
3. Completeness：覆盖标准答案多少方面？
4. Attribution：是否引用具体来源/论文/数据？是否可追溯到文献？
5. Overall：综合质量。

只输出JSON：{{"faithfulness":0.X,"relevance":0.X,"completeness":0.X,"attribution":0.X,"overall":0.X,"note":"一句话"}}"""

    try:
        r = cl.chat.completions.create(model=md, messages=[{"role":"user","content":prompt}], temperature=0, max_tokens=300)
        raw = r.choices[0].message.content.strip()
        m = re.search(r"\{[^}]+\}", raw)
        if m:
            scores = json.loads(m.group())
            for k in ["faithfulness","relevance","completeness","attribution","overall"]:
                scores.setdefault(k, 0.0)
            return scores
    except: pass
    return {"faithfulness":0,"relevance":0,"completeness":0,"attribution":0,"overall":0,"note":"judge failed"}


async def main():
    print("=" * 70)
    print("Step 1: GRAPH_COMPLETION + raw text augmentation ENABLED")
    print("=" * 70)

    gt_data = json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))
    gt_queries = gt_data["queries"]
    user = await get_default_user()
    cp = load_cp()

    # Phase 1: Collect
    if "collected" not in cp:
        print(f"\nPhase 1: Collecting {len(gt_queries)} answers (GRAPH_COMPLETION, raw_text=ON)...")
        collected = []
        for i, qd in enumerate(gt_queries):
            q = qd["query"]
            t0 = time.time()
            try:
                r = await asyncio.wait_for(
                    search(query_text=q, query_type=SearchType.GRAPH_COMPLETION, datasets=["capital_batch_000"], top_k=TOP_K),
                    timeout=TIMEOUT,
                )
                elapsed = time.time() - t0
                collected.append({"query": q, "answer": str(r)[:4000], "elapsed": round(elapsed, 2), "error": None})
                print(f"  [{i+1:2d}/30] {elapsed:.0f}s {q[:40]}")
            except Exception as e:
                collected.append({"query": q, "answer": f"[ERROR] {e}", "elapsed": 0, "error": str(e)[:200]})
                print(f"  [{i+1:2d}/30] ERR {type(e).__name__}")
        cp["collected"] = collected
        save_cp(cp)
    else:
        collected = cp["collected"]
        print(f"\nPhase 1: restored ({len(collected)} answers)")

    # Phase 2: Judge
    if "judged" not in cp:
        print(f"\nPhase 2: 5-Dim Judge...")
        judged = []
        for i, (row, qd) in enumerate(zip(collected, gt_queries)):
            q, ga, ge = row["query"], qd.get("ground_truth_answer",""), qd.get("expected_entities",[])
            if not row.get("error"):
                scores = await five_dim_judge(q, ga, row.get("answer",""), ge)
            else:
                scores = {"faithfulness":0,"relevance":0,"completeness":0,"attribution":0,"overall":0,"note":"error"}
            scores["elapsed"] = row.get("elapsed", 0)
            scores["query"] = q[:50]
            scores["difficulty"] = qd.get("difficulty", "medium")
            judged.append(scores)
            print(f"  [{i+1:2d}/30] F={scores['faithfulness']:.2f} R={scores['relevance']:.2f} C={scores['completeness']:.2f} A={scores['attribution']:.2f} O={scores['overall']:.2f}")
        cp["judged"] = judged
        save_cp(cp)
    else:
        judged = cp["judged"]
        print(f"\nPhase 2: restored ({len(judged)} judged)")

    # Summary
    dims = ["faithfulness","relevance","completeness","attribution","overall"]
    all_scores = {d: [] for d in dims}
    for j in judged:
        for d in dims:
            all_scores[d].append(j.get(d, 0))
    n = max(len(all_scores["faithfulness"]), 1)
    summary = {d: round(sum(all_scores[d])/n, 4) for d in dims}

    # Load baseline
    baseline = {}
    if BASELINE.exists():
        baseline = json.loads(BASELINE.read_text(encoding="utf-8")).get("summary", {})

    print(f"\n{'='*70}")
    print(f"RESULTS ({n} queries, GRAPH_COMPLETION + raw text)")
    print(f"{'Dimension':15s} | {'Baseline':>8s} | {'Step1':>8s} | {'Diff':>8s}")
    print("-" * 55)
    for d in dims:
        bl = baseline.get(d, 0)
        s1 = summary.get(d, 0)
        delta = s1 - bl
        sign = "+" if delta >= 0 else ""
        print(f"  {d:15s} | {bl:8.4f} | {s1:8.4f} | {sign}{delta:7.4f}")

    report = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"), "summary": summary, "baseline": baseline, "details": judged}
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    CHECKPOINT.unlink(missing_ok=True)
    print(f"\nSaved: {OUTPUT}")


if __name__ == "__main__":
    asyncio.run(main())
