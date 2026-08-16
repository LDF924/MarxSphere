"""
Automated 5-Dim evaluation module with defect report + re-extraction triggers.

This extends eval_unified.py with:
  1. Auto-eval pipeline (same as eval_unified but fully non-interactive)
  2. Per-query defect diagnosis (why did this query score low?)
  3. Aggregated defect report grouped by root cause
  4. Re-extraction trigger logic — identifies which entity/relation categories
     need batch re-extraction and which papers to process

Defect taxonomy (11 categories):
  D01  NO_RESULT         — 0 results returned (retrieval gap)
  D02  HALLUCINATION     — Faithfulness < 0.3, LLM fabricated unsupported facts
  D03  OFF_TOPIC         — Relevance < 0.3, answer mismatched question
  D04  INCOMPLETE        — Completeness < 0.3, key aspects missing
  D05  NO_ATTRIBUTION    — Attribution < 0.15, no source/paper/data cited
  D06  ENTITY_CONFUSION  — wrong entity mapped to query concept
  D07  VAGUE_EDGE        — relation type too generic (RELATES_TO instead of CAUSES)
  D08  STALE_ANSWER      — cached answer returned (latency ~0s, score same as prior)
  D09  LOW_COVERAGE      — < 3 entities in answer for hard query
  D10  TIMEOUT           — search timed out (>300s)
  D11  JUDGE_FAIL        — LLM judge returned 0s across all dims (technical failure)

Usage:
  cd %USERPROFILE%/cognee
  .venv312/Scripts/python.exe eval_auto.py                          # full auto-eval
  .venv312/Scripts/python.exe eval_auto.py --trigger-fixes          # also generate fix scripts
  .venv312/Scripts/python.exe eval_auto.py --search HYBRID_COMPLETION --model qwen3.7-max
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

os.chdir("%USERPROFILE%/cognee")
sys.path.insert(0, ".")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import dotenv
dotenv.load_dotenv(override=True)

from cognee.api.v1.search import search, SearchType
from cognee.modules.users.methods import get_default_user

GROUND_TRUTH = Path("eval/ground_truth_30q.json")
TOP_K = 10
TIMEOUT = 300.0

# ── Defect thresholds ──
FAITHFULNESS_FLOOR = 0.30
RELEVANCE_FLOOR = 0.30
COMPLETENESS_FLOOR = 0.30
ATTRIBUTION_FLOOR = 0.15
LOW_ENTITY_COUNT = 3
STALE_LATENCY = 0.5  # seconds

# ── 11-class defect taxonomy ──
DEFECT_RULES = [
    ("D01_NO_RESULT",       lambda s, a: len(str(a.get("answer", ""))) < 30),
    ("D02_HALLUCINATION",   lambda s, a: s.get("faithfulness", 1) < FAITHFULNESS_FLOOR and len(str(a.get("answer", ""))) > 30),
    ("D03_OFF_TOPIC",       lambda s, a: s.get("relevance", 1) < RELEVANCE_FLOOR),
    ("D04_INCOMPLETE",      lambda s, a: s.get("completeness", 1) < COMPLETENESS_FLOOR),
    ("D05_NO_ATTRIBUTION",  lambda s, a: s.get("attribution", 1) < ATTRIBUTION_FLOOR),
    ("D06_ENTITY_CONFUSION",lambda s, a: s.get("faithfulness", 1) < 0.4 and s.get("relevance", 1) > 0.5),
    ("D07_VAGUE_EDGE",      lambda s, a: s.get("completeness", 1) < 0.4 and s.get("faithfulness", 1) > 0.5),
    ("D08_STALE_ANSWER",    lambda s, a: a.get("elapsed", 999) < STALE_LATENCY),
    ("D09_LOW_COVERAGE",    lambda s, a: s.get("completeness", 1) < 0.35 and s.get("relevance", 1) > 0.5),
    ("D10_TIMEOUT",         lambda s, a: "error" in str(a.get("answer", "")).lower() or a.get("error") is not None),
    ("D11_JUDGE_FAIL",      lambda s, a: sum(s.get(d, 0) for d in ["faithfulness","relevance","completeness","attribution"]) < 0.01),
]


async def five_dim_judge(query, gt_answer, candidate_answer, gt_entities):
    """5-dimension LLM judge (copied from eval_unified.py)."""
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
    except:
        pass
    return {"faithfulness":0,"relevance":0,"completeness":0,"attribution":0,"overall":0,"note":"judge failed"}


def diagnose_defects(scores: dict, answer_info: dict) -> list[str]:
    """Apply 11 defect rules and return matched defect codes."""
    defects = []
    for code, rule in DEFECT_RULES:
        try:
            if rule(scores, answer_info):
                defects.append(code)
        except Exception:
            pass
    return defects or ["OK"]


def classify_defect_summary(all_defects: list[dict]) -> dict:
    """Group defects by root cause with counts and example queries."""
    by_code = defaultdict(list)
    for d in all_defects:
        for code in d["defects"]:
            by_code[code].append(d["query"][:50])

    description = {
        "D01_NO_RESULT": "检索返回空结果，知识图谱中缺失相关实体/关系",
        "D02_HALLUCINATION": "LLM生成的事实未在知识图谱中找到支撑，忠实度低",
        "D03_OFF_TOPIC": "回答与问题不相关，检索结果偏离或LLM偏离主题",
        "D04_INCOMPLETE": "回答遗漏关键维度，知识图谱覆盖不足或检索不够广泛",
        "D05_NO_ATTRIBUTION": "回答未引用具体来源/论文，缺乏可追溯性",
        "D06_ENTITY_CONFUSION": "实体映射错误，同名实体混淆或类型归错",
        "D07_VAGUE_EDGE": "关系类型过于宽泛（如RELATES_TO），缺少领域精炼关系",
        "D08_STALE_ANSWER": "疑似返回缓存答案，需清空cache_kv重试",
        "D09_LOW_COVERAGE": "回答实体数不足，图谱密度偏低或检索范围不够",
        "D10_TIMEOUT": "搜索超时，LLM或图遍历耗时过长",
        "D11_JUDGE_FAIL": "Judge评分技术性失败，需检查API连接",
    }

    summary = {}
    for code, queries in sorted(by_code.items()):
        summary[code] = {
            "count": len(queries),
            "description": description.get(code, "未知缺陷"),
            "affected_queries": queries[:5],
        }
    return summary


def generate_fix_actions(defect_summary: dict, output_dir: Path) -> list[dict]:
    """Generate actionable fix scripts based on defect patterns."""
    actions = []

    # D01/D04/D09: coverage gaps → re-extraction candidate queries
    coverage_queries = []
    for code in ["D01_NO_RESULT", "D04_INCOMPLETE", "D09_LOW_COVERAGE"]:
        if code in defect_summary:
            coverage_queries.extend(defect_summary[code]["affected_queries"])

    if coverage_queries:
        actions.append({
            "action": "RE_EXTRACT_COVERAGE",
            "priority": "HIGH",
            "description": f"重新抽取覆盖不足的主题领域（{len(coverage_queries)}个查询受影响）",
            "target_queries": coverage_queries[:10],
            "script": "python eval_auto.py --retry-failed",
            "suggested_papers": "建议用cognee_detect_new_papers检查未入库论文，关注主题：土地流转违约、农户权益保障、农业科技转化",
        })

    # D07: vague edges → re-run with curated edge types
    if "D07_VAGUE_EDGE" in defect_summary:
        actions.append({
            "action": "RE_EXTRACT_CURATED_EDGES",
            "priority": "MEDIUM",
            "description": f"使用15种精选关系类型重新提取边（{defect_summary['D07_VAGUE_EDGE']['count']}个查询受影响）",
            "script": "python scripts/re_extract_with_curated_edges.py",
            "note": "使用 marx_edge_types.MARX_EDGE_TYPES 约束Graphiti提取，减少generic RELATES_TO边",
        })

    # D02/D06: hallucination/entity confusion → entity dedup + constraint pass
    if "D02_HALLUCINATION" in defect_summary or "D06_ENTITY_CONFUSION" in defect_summary:
        actions.append({
            "action": "RE_EXTRACT_ENTITY_CONSTRAINTS",
            "priority": "HIGH",
            "description": "实体消歧+类型约束：清理同名异义实体，强化类型标注",
            "script": "python scripts/build_entity_aliases.py && python scripts/clean_dirty_entities.py",
            "note": "重新运行实体别名构建和脏实体清理，降低实体混淆",
        })

    # D08: stale answers → cache purge
    if "D08_STALE_ANSWER" in defect_summary:
        actions.append({
            "action": "PURGE_QUERY_CACHE",
            "priority": "HIGH",
            "description": "清空查询缓存，防止过期答案污染评测",
            "script": "python -c \"import sqlite3; c=sqlite3.connect('cognee/.cognee_system/databases/cache.db'); c.execute(\\\"DELETE FROM cache_kv WHERE key LIKE 'query_result:%'\\\"); c.commit(); c.close(); print('Cleared')\"",
        })

    # D10: timeouts → reduce top_k or switch model
    if "D10_TIMEOUT" in defect_summary:
        actions.append({
            "action": "ADJUST_TIMEOUT_SETTINGS",
            "priority": "MEDIUM",
            "description": "降低top_k或切换至更快的LLM模型（qwen-plus代替qwen3.7-max）",
            "script": "python eval_auto.py --search GRAPH_COMPLETION --model qwen-plus",
        })

    # Write fix actions
    fix_plan = {
        "generated_at": datetime.now().isoformat(),
        "defect_summary": {k: {"count": v["count"], "description": v["description"]}
                           for k, v in defect_summary.items()},
        "actions": actions,
    }
    fix_plan_path = output_dir / "fix_plan.json"
    fix_plan_path.write_text(json.dumps(fix_plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nFix plan written to: {fix_plan_path}")
    return actions


async def main():
    parser = argparse.ArgumentParser(description="Cognee RAG Auto-Eval + Defect Report")
    parser.add_argument("--search", default="GRAPH_COMPLETION")
    parser.add_argument("--model", default="qwen-plus")
    parser.add_argument("--refs", action="store_true")
    parser.add_argument("--trigger-fixes", action="store_true",
                        help="Generate fix scripts based on defect analysis")
    parser.add_argument("--retry-failed", action="store_true",
                        help="Re-run only queries that scored low in previous run")
    parser.add_argument("-o", "--output-dir", default="eval/auto_reports")
    args = parser.parse_args()

    model_key = f"openai/{args.model}"
    os.environ["LLM_MODEL"] = model_key
    os.environ["CACHING"] = "false"

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    tag = f"{args.search}_{args.model}{'_refs' if args.refs else ''}"

    print("=" * 70)
    print(f"Cognee RAG Auto-Eval + Defect Report — {tag}")
    print(f"Timestamp: {timestamp}")
    print("=" * 70)

    gt_data = json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))
    gt_queries = gt_data["queries"]
    if args.retry_failed:
        # Load previous results and pick low-scoring queries
        prev_files = sorted(output_dir.glob(f"eval_detail_*.json"), reverse=True)
        if prev_files:
            prev = json.loads(prev_files[0].read_text(encoding="utf-8"))
            low_ids = {d["query_id"] for d in prev.get("defects", [])
                       if any(c != "OK" for c in d.get("defects", []))}
            gt_queries = [q for q in gt_queries if q["id"] in low_ids]
            print(f"Retry mode: {len(gt_queries)} previously-failed queries")
        else:
            print("No previous results found, running full eval")

    user = await get_default_user()
    search_type = getattr(SearchType, args.search)

    # ── Phase 1: Collect answers ──
    print(f"\nPhase 1: Collecting {len(gt_queries)} answers...")
    collected = []
    for i, qd in enumerate(gt_queries):
        q = qd["query"]
        t0 = time.time()
        try:
            r = await asyncio.wait_for(
                search(query_text=q, query_type=search_type,
                       datasets=["capital_rebuild"], top_k=TOP_K,
                       include_references=args.refs),
                timeout=TIMEOUT,
            )
            elapsed = time.time() - t0
            collected.append({
                "query_id": qd["id"], "query": q,
                "answer": str(r)[:4000], "elapsed": round(elapsed, 2),
                "error": None, "difficulty": qd.get("difficulty", "medium"),
            })
            print(f"  [{i+1:2d}/{len(gt_queries)}] {elapsed:.0f}s {q[:40]}")
        except Exception as e:
            elapsed = time.time() - t0
            collected.append({
                "query_id": qd["id"], "query": q,
                "answer": f"[ERROR] {e}", "elapsed": round(elapsed, 2),
                "error": str(e)[:200], "difficulty": qd.get("difficulty", "medium"),
            })
            print(f"  [{i+1:2d}/{len(gt_queries)}] ERR {q[:40]}")

    # ── Phase 2: LLM Judge ──
    print(f"\nPhase 2: 5-Dim LLM Judge...")
    judged = []
    for i, (row, qd) in enumerate(zip(collected, gt_queries)):
        q = row["query"]
        ga = qd.get("ground_truth_answer", "")
        ge = qd.get("expected_entities", [])

        if not row.get("error"):
            scores = await five_dim_judge(q, ga, row["answer"], ge)
        else:
            scores = {"faithfulness":0,"relevance":0,"completeness":0,"attribution":0,"overall":0,"note":"error"}

        scores["query_id"] = qd["id"]
        scores["query"] = q[:50]
        scores["difficulty"] = qd.get("difficulty", "medium")
        scores["elapsed"] = row.get("elapsed", 0)
        judged.append({"scores": scores, "answer_info": row})

        fv = scores.get("faithfulness", 0)
        rv = scores.get("relevance", 0)
        cv = scores.get("completeness", 0)
        av = scores.get("attribution", 0)
        ov = scores.get("overall", 0)
        print(f"  [{i+1:2d}] F={fv:.2f} R={rv:.2f} C={cv:.2f} A={av:.2f} O={ov:.2f} | {q[:30]}")

    # ── Phase 3: Defect Diagnosis ──
    print(f"\nPhase 3: Defect Diagnosis (11 categories)...")
    all_defects = []
    for j in judged:
        defects = diagnose_defects(j["scores"], j["answer_info"])
        all_defects.append({
            "query_id": j["scores"]["query_id"],
            "query": j["scores"]["query"],
            "difficulty": j["scores"]["difficulty"],
            "scores": {k: j["scores"][k] for k in ["faithfulness","relevance","completeness","attribution","overall"]},
            "defects": defects,
        })
        defect_str = ", ".join(defects)
        print(f"  [{j['scores']['query_id']}] {defect_str}")

    # ── Phase 4: Aggregate ──
    print(f"\nPhase 4: Aggregate Report...")
    dims = ["faithfulness","relevance","completeness","attribution","overall"]
    all_scores = {d: [] for d in dims}
    for j in judged:
        for d in dims:
            all_scores[d].append(j["scores"].get(d, 0))
    n = max(len(all_scores["faithfulness"]), 1)
    summary = {d: round(sum(all_scores[d]) / n, 4) for d in dims}

    defect_summary = classify_defect_summary(all_defects)

    # Per-difficulty breakdown
    per_diff = {}
    for diff in ["easy","medium","hard"]:
        d_scores = {d: [] for d in dims}
        d_defects = defaultdict(int)
        for item in all_defects:
            if item["difficulty"] == diff:
                for d in dims:
                    d_scores[d].append(item["scores"][d])
                for code in item["defects"]:
                    d_defects[code] += 1
        if d_scores["faithfulness"]:
            per_diff[diff] = {
                "count": len(d_scores["faithfulness"]),
                "faithfulness": round(sum(d_scores["faithfulness"])/len(d_scores["faithfulness"]), 4),
                "relevance": round(sum(d_scores["relevance"])/len(d_scores["relevance"]), 4),
                "overall": round(sum(d_scores["overall"])/len(d_scores["overall"]), 4),
                "top_defects": sorted(d_defects.items(), key=lambda x: -x[1])[:5],
            }

    # ── Build full report ──
    report = {
        "version": "auto-eval-v1",
        "timestamp": timestamp,
        "config": {
            "search_type": args.search,
            "model": args.model,
            "include_references": args.refs,
            "top_k": TOP_K,
        },
        "summary": summary,
        "defect_summary": defect_summary,
        "per_difficulty": per_diff,
        "total_queries": n,
        "defective_count": sum(1 for d in all_defects if d["defects"] != ["OK"]),
        "healthy_count": sum(1 for d in all_defects if d["defects"] == ["OK"]),
        "defects": all_defects,
    }

    # Write detail report
    detail_path = output_dir / f"eval_detail_{tag}_{timestamp}.json"
    detail_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # Write summary
    summary_path = output_dir / "LATEST_SUMMARY.json"
    summary_path.write_text(json.dumps({
        "timestamp": timestamp,
        "tag": tag,
        "summary": summary,
        "defective_count": report["defective_count"],
        "healthy_count": report["healthy_count"],
        "top_defects": sorted(defect_summary.items(), key=lambda x: -x[1]["count"])[:5],
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    # ── Print report ──
    print(f"\n{'='*70}")
    print(f"AUTO-EVAL REPORT — {tag}")
    print(f"{'='*70}")
    print(f"  Faithfulness:  {summary['faithfulness']:.4f}")
    print(f"  Relevance:     {summary['relevance']:.4f}")
    print(f"  Completeness:  {summary['completeness']:.4f}")
    print(f"  Attribution:   {summary['attribution']:.4f}")
    print(f"  Overall:       {summary['overall']:.4f}")
    print(f"  Healthy: {report['healthy_count']}/{n}  Defective: {report['defective_count']}/{n}")
    print(f"\n  Top Defects:")
    for code, info in sorted(defect_summary.items(), key=lambda x: -x[1]["count"])[:5]:
        print(f"    {code}: {info['count']} queries — {info['description'][:60]}")
    print(f"\n  Per Difficulty:")
    for diff in ["easy","medium","hard"]:
        if diff in per_diff:
            pd = per_diff[diff]
            print(f"    {diff:6s} (n={pd['count']}): F={pd['faithfulness']:.3f} O={pd['overall']:.3f}")

    print(f"\n  Reports saved to: {output_dir}/")

    # ── Phase 5: Generate Fix Actions ──
    if args.trigger_fixes:
        print(f"\nPhase 5: Generating Fix Actions...")
        actions = generate_fix_actions(defect_summary, output_dir)
        print(f"\n  Generated {len(actions)} fix actions:")
        for a in actions:
            print(f"    [{a['priority']}] {a['action']}: {a['description'][:80]}")
            print(f"          → {a['script']}")


if __name__ == "__main__":
    asyncio.run(main())
