"""
Cognee RAG 统一评测脚本 — 支持多种检索策略和模型组合

用法:
  # 基线: GRAPH + qwen-plus (最优 Faithfulness)
  .venv312/Scripts/python.exe eval_unified.py

  # GRAPH + qwen-plus + include_references (最优 Attribution)
  .venv312/Scripts/python.exe eval_unified.py --search GRAPH_COMPLETION --model qwen-plus --refs

  # GRAPH + qwen3.7-max + include_references (最优 Overall)
  .venv312/Scripts/python.exe eval_unified.py --search GRAPH_COMPLETION --model qwen3.7-max --refs

  # HYBRID + qwen3.7-max + include_references
  .venv312/Scripts/python.exe eval_unified.py --search HYBRID_COMPLETION --model qwen3.7-max --refs

  # 自定义结果路径
  .venv312/Scripts/python.exe eval_unified.py -o eval/my_custom_results.json

踩坑提醒:
  - 跨 search_type 评测必须设 --no-cache (CACHING=false)
  - top_k=10 是甜点，不要增大
  - 不要在 prompt 里强制 LLM 标注引用（v7 教训）
  - verify_faithfulness 只用于离线审计
"""
import argparse, asyncio, json, os, re, sys, time
from pathlib import Path

os.chdir("%USERPROFILE%/cognee")
sys.path.insert(0, ".")
import dotenv
dotenv.load_dotenv(override=True)

from cognee.api.v1.search import search, SearchType
from cognee.modules.users.methods import get_default_user

GROUND_TRUTH = Path("eval/ground_truth_30q.json")
TOP_K = 10
TIMEOUT = 300.0


async def five_dim_judge(query, gt_answer, candidate_answer, gt_entities):
    """5-dimension LLM judge using DashScope qwen-plus."""
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


async def main():
    parser = argparse.ArgumentParser(description="Cognee RAG 统一评测")
    parser.add_argument("--search", default="GRAPH_COMPLETION",
                        choices=["GRAPH_COMPLETION", "HYBRID_COMPLETION", "RAG_COMPLETION",
                                 "TRIPLET_COMPLETION", "GRAPH_COMPLETION_COT",
                                 "GRAPH_COMPLETION_DECOMPOSITION", "GRAPH_SUMMARY_COMPLETION"])
    parser.add_argument("--model", default="qwen-plus",
                        choices=["qwen-plus", "qwen3.7-max", "qwen-max", "qwen-turbo"])
    parser.add_argument("--refs", action="store_true", help="include_references=True")
    parser.add_argument("--no-cache", action="store_true", default=True,
                        help="禁用 session cache (默认禁用)")
    parser.add_argument("-o", "--output", default=None, help="结果输出路径")
    args = parser.parse_args()

    model_key = f"openai/{args.model}"
    os.environ["LLM_MODEL"] = model_key
    if args.no_cache:
        os.environ["CACHING"] = "false"

    search_type = getattr(SearchType, args.search)
    output_name = args.output or (
        f"eval/eval_results_{args.search.lower()}_{args.model.replace('.','')}"
        f"{'_ref' if args.refs else ''}.json"
    )
    RESULTS = Path(output_name)

    tag = f"{args.search} + {args.model}" + (" + refs" if args.refs else "")
    print("=" * 70)
    print(f"Cognee RAG 评测 — {tag}")
    print(f"CACHING={'enabled' if not args.no_cache else 'disabled'}")
    print("=" * 70)

    gt_data = json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))
    gt_queries = gt_data["queries"]
    user = await get_default_user()

    # ── Phase 1: 收集答案 ──
    print(f"\nPhase 1: 收集 {len(gt_queries)} 个查询答案...")
    collected = []
    for i, qd in enumerate(gt_queries):
        q = qd["query"]
        t0 = time.time()
        try:
            r = await asyncio.wait_for(
                search(
                    query_text=q, query_type=search_type,
                    datasets=["capital_rebuild"], top_k=TOP_K,
                    include_references=args.refs,
                ),
                timeout=TIMEOUT,
            )
            elapsed = time.time() - t0
            collected.append({
                "query": q, "answer": str(r)[:4000],
                "elapsed": round(elapsed, 2), "error": None,
            })
            print(f"  [{i+1:2d}/30] {elapsed:.0f}s {q[:40]}")
        except Exception as e:
            elapsed = time.time() - t0
            collected.append({
                "query": q, "answer": f"[ERROR] {e}",
                "elapsed": round(elapsed, 2), "error": str(e)[:200],
            })
            print(f"  [{i+1:2d}/30] ERR: {type(e).__name__} — {str(e)[:80]}")

    # ── Phase 2: LLM Judge ──
    print(f"\nPhase 2: 5-dim LLM Judge ({len(collected)} answers)...")
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

    # ── Phase 3: 汇总 ──
    dims = ["faithfulness","relevance","completeness","attribution","overall"]
    all_scores = {d: [] for d in dims}
    elapsed_vals = []
    for j in judged:
        elapsed_vals.append(j.get("elapsed", 0))
        for d in dims:
            all_scores[d].append(j.get(d, 0))
    n = max(len(all_scores["faithfulness"]), 1)

    summary = {d: round(sum(all_scores[d]) / n, 4) for d in dims}
    avg_latency = round(sum(elapsed_vals) / max(len(elapsed_vals), 1), 1)

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
                "relevance": round(sum(d_scores["relevance"])/len(d_scores["relevance"]), 4),
                "overall": round(sum(d_scores["overall"])/len(d_scores["overall"]), 4),
            }

    report = {
        "version": tag,
        "dataset": "capital_rebuild",
        "search_type": args.search,
        "model": args.model,
        "include_references": args.refs,
        "num_queries": n,
        "summary": summary,
        "avg_latency": avg_latency,
        "per_difficulty": per_diff,
        "details": judged,
    }
    RESULTS.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n{'='*70}")
    print(f"评测完成 — {tag}")
    print(f"{'='*70}")
    print(f"  Faithfulness:  {summary['faithfulness']:.4f}")
    print(f"  Relevance:     {summary['relevance']:.4f}")
    print(f"  Completeness:  {summary['completeness']:.4f}")
    print(f"  Attribution:   {summary['attribution']:.4f}")
    print(f"  Overall:       {summary['overall']:.4f}")
    print(f"  Avg Latency:   {avg_latency}s")
    print()
    print("  Per Difficulty:")
    for diff in ["easy","medium","hard"]:
        if diff in per_diff:
            pd = per_diff[diff]
            print(f"    {diff:6s} (n={pd['count']}): F={pd['faithfulness']:.3f} O={pd['overall']:.3f}")
    print(f"\nResults saved to: {RESULTS}")


if __name__ == "__main__":
    asyncio.run(main())
