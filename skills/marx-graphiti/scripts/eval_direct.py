#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_direct.py — 三框架直接 LLM Judge 评测
═══════════════════════════════════════════════════════
完全绕过 Ragas/DeepEval/TruLens SDK，直接用 DashScope API 实现等价评测。
SDK 的 API key 注入路径混乱，不如直接控制。

指标:
  Ragas-等价: Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall
  DeepEval-等价: Faithfulness, AnswerRelevancy, ContextPrecision,
                  ContextRecall, ContextRelevancy
  TruLens-等价: Groundedness, ContextRelevance, AnswerRelevance

运行:
  python eval_direct.py --sample 5
  python eval_direct.py --sample 30 --resume
"""
import argparse, json, os, re, sys, time, warnings
from pathlib import Path
from typing import List

warnings.filterwarnings("ignore")

# ── API Setup ──
COGNEE_ROOT = Path("%USERPROFILE%/cognee")
sys.path.insert(0, str(COGNEE_ROOT))
os.chdir(str(COGNEE_ROOT))
import dotenv; dotenv.load_dotenv(override=True)

import httpx
from openai import OpenAI

OUTPUT_DIR = Path(__file__).resolve().parent / "eval_output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1")
LLM_API_KEY  = os.getenv("LLM_API_KEY", "")
JUDGE_MODEL  = "qwen3.7-max"
RATE = 0.5

CACHE_FILE = OUTPUT_DIR / "answers_cache_v2.json"
CKPT = OUTPUT_DIR / ".direct_eval_ckpt.json"

print(f"API KEY loaded: {'YES' if LLM_API_KEY else 'NO'} ({LLM_API_KEY[:20]}...)")

_cli = OpenAI(base_url=LLM_ENDPOINT, api_key=LLM_API_KEY, http_client=httpx.Client(timeout=180))
_last = 0.0

def _call(prompt: str, max_tokens: int = 256) -> str:
    global _last
    e = time.time() - _last
    if e < RATE: time.sleep(RATE - e)
    r = _cli.chat.completions.create(model=JUDGE_MODEL, messages=[{"role":"user","content":prompt}],
                                      temperature=0, max_tokens=max_tokens)
    _last = time.time()
    return r.choices[0].message.content or ""


# ═══════════════════════════════════════════════════════
# Metric Functions (one per framework dimension)
# ═══════════════════════════════════════════════════════

def score_faithfulness(contexts: List[str], answer: str) -> float:
    """Ragas Faithfulness / DeepEval FaithfulnessMetric 等价"""
    ctx = "\n---\n".join(contexts)[:4000]
    ans = str(answer)[:2000]
    p = f"""You are an information verifier. Extract ALL factual claims from the ANSWER. For each claim, check if it is supported by the SOURCE. Count supported vs total.

SOURCE:
{ctx}

ANSWER:
{ans}

Output JSON:
{{"total_claims": <int>, "supported_claims": <int>, "score": <0-10 how well the answer is grounded in sources>, "reason": "<one sentence>"}}
JSON:"""
    ans = _call(p, max_tokens=512)
    m = re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', ans)
    return float(m.group(1)) / 10.0 if m else 0.5


def score_answer_relevancy(question: str, answer: str) -> float:
    """Ragas AnswerRelevancy / DeepEval AnswerRelevancyMetric 等价"""
    p = f"""You are a relevance judge. Rate how directly the ANSWER addresses the QUESTION.

QUESTION: {question[:500]}

ANSWER: {str(answer)[:2000]}

Output JSON: {{"score": <0-10>, "reason": "<one sentence>"}}
JSON:"""
    ans = _call(p, max_tokens=256)
    m = re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', ans)
    return float(m.group(1)) / 10.0 if m else 0.5


def score_context_precision(question: str, contexts: List[str], ground_truth: str) -> float:
    """Ragas ContextPrecision 等价 — are relevant chunks ranked higher?"""
    ctx_items = "\n".join(f"[{i}] {c[:300]}" for i, c in enumerate(contexts[:10]))
    p = f"""You are a retrieval quality judge. For each context item, judge if it is relevant to the QUESTION.

QUESTION: {question[:500]}
GROUND TRUTH: {ground_truth[:1000]}

CONTEXTS:
{ctx_items[:4000]}

Output JSON: {{"relevant_indices": [<list of 0-based indices relevant to question>], "score":<0-10 precision weighted by rank>, "reason":"<brief>"}}
JSON:"""
    ans = _call(p, max_tokens=512)
    m = re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', ans)
    return float(m.group(1)) / 10.0 if m else 0.5


def score_context_recall(question: str, contexts: List[str], ground_truth: str) -> float:
    """Ragas ContextRecall 等价 — does context contain all info from ground_truth?"""
    ctx = "\n---\n".join(contexts)[:4000]
    p = f"""You are a coverage evaluator. Extract key claims from GROUND_TRUTH. Check how many are covered by CONTEXTS.

QUESTION: {question[:500]}
GROUND TRUTH: {ground_truth[:1500]}

CONTEXTS:
{ctx}

Output JSON: {{"key_claims_in_gt": <int>, "claims_found_in_contexts": <int>, "score":<0-10 recall>, "reason":"<brief>"}}
JSON:"""
    ans = _call(p, max_tokens=512)
    m = re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', ans)
    return float(m.group(1)) / 10.0 if m else 0.5


def score_context_relevancy(question: str, contexts: List[str]) -> float:
    """DeepEval ContextualRelevancyMetric 等价 — signal-to-noise in context"""
    ctx_items = "\n".join(f"[{i}] {c[:200]}" for i, c in enumerate(contexts[:10]))
    p = f"""You are a signal-to-noise judge. Rate what fraction of context items are relevant to the question.

QUESTION: {question[:500]}

CONTEXTS:
{ctx_items[:4000]}

Output JSON: {{"total": <int>, "relevant": <int>, "score":<0-10 relevancy ratio>, "reason":"<brief>"}}
JSON:"""
    ans = _call(p, max_tokens=256)
    m = re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', ans)
    return float(m.group(1)) / 10.0 if m else 0.5


# Aliases for TruLens Triad
def score_groundedness(contexts: List[str], answer: str) -> float:
    """TruLens Groundedness = same as Faithfulness"""
    return score_faithfulness(contexts, answer)

def score_context_relevance(question: str, contexts: List[str]) -> float:
    """TruLens ContextRelevance = same as Context Relevancy"""
    return score_context_relevancy(question, contexts)

def score_answer_relevance_trulens(question: str, answer: str) -> float:
    """TruLens AnswerRelevance = same as AnswerRelevancy"""
    return score_answer_relevancy(question, answer)


# ═══════════════════════════════════════════════════════
# Evaluation Framework Definitions
# ═══════════════════════════════════════════════════════

FRAMEWORKS = {
    "ragas": {
        "metrics": [
            ("faithfulness", score_faithfulness),
            ("answer_relevancy", score_answer_relevancy),
            ("context_precision", score_context_precision),
            ("context_recall", score_context_recall),
        ],
        "needs_gt": [False, False, True, True],
    },
    "deepeval": {
        "metrics": [
            ("Faithfulness", score_faithfulness),
            ("AnswerRelevancy", score_answer_relevancy),
            ("ContextualPrecision", score_context_precision),
            ("ContextualRecall", score_context_recall),
            ("ContextualRelevancy", score_context_relevancy),
        ],
        "needs_gt": [False, False, True, True, False],
    },
    "triad": {
        "metrics": [
            ("Groundedness", score_groundedness),
            ("ContextRelevance", score_context_relevance),
            ("AnswerRelevance", score_answer_relevance_trulens),
        ],
        "needs_gt": [False, False, False],
    },
}


# ═══════════════════════════════════════════════════════
# Run evaluation
# ═══════════════════════════════════════════════════════

def run_framework(fw_key: str, samples: List[dict], label: str) -> dict:
    fw = FRAMEWORKS[fw_key]
    metric_defs = fw["metrics"]
    needs_gt = fw["needs_gt"]

    valid = [s for s in samples if not s.get("error") and len(s.get("answer",""))>20
             and not s.get("answer","").startswith("[ERROR]")]
    if not valid: return {"n":0}

    # resume
    done_ids = set()
    per_sample = []
    if CKPT.exists():
        ck = json.loads(CKPT.read_text("utf-8"))
        done_ids = set(ck.get(f"{fw_key}_{label}_ids", []))
        per_sample = ck.get(f"{fw_key}_{label}_data", [])

    todo = [(i,s) for i,s in enumerate(valid) if s["id"] not in done_ids]

    if not todo:
        print(f"  [{label}] {fw_key}: all {len(done_ids)} cached")
    else:
        print(f"  [{label}] {fw_key}: {len(todo)} to score...", flush=True)
        for j, (_, s) in enumerate(todo):
            row = {"id": s["id"], "question": s["question"][:60]}
            q = s["question"]; ans = s["answer"]; ctxs = s.get("contexts",[]); gt = s.get("ground_truth","")

            for (mname, mfunc), ngt in zip(metric_defs, needs_gt):
                try:
                    if ngt and not gt:
                        row[mname] = None
                    elif mname in ("context_precision", "ContextualPrecision", "context_recall", "ContextualRecall"):
                        row[mname] = round(mfunc(q, ctxs, gt), 4)
                    elif mname in ("faithfulness", "Faithfulness", "Groundedness"):
                        row[mname] = round(mfunc(ctxs, ans), 4)
                    elif "Relevance" in mname or "Relevancy" in mname or "relevance" in mname or "relevancy" in mname:
                        row[mname] = round(mfunc(q, ans) if "Answer" in mname else mfunc(q, ctxs), 4)
                    else:
                        row[mname] = round(mfunc(q, ans, ctxs, gt) if gt else mfunc(q, ans, ctxs), 4)
                except Exception as e:
                    row[mname] = None

            per_sample.append(row); done_ids.add(s["id"])

            if (j+1) % 5 == 0:
                # save checkpoint
                ck_data = {}
                if CKPT.exists():
                    ck_data = json.loads(CKPT.read_text("utf-8"))
                ck_data[f"{fw_key}_{label}_ids"] = list(done_ids)
                ck_data[f"{fw_key}_{label}_data"] = per_sample
                CKPT.write_text(json.dumps(ck_data, ensure_ascii=False, indent=2), "utf-8")
                # show interim scores
                tmp_agg = {}
                for mn, _ in metric_defs:
                    vals = [ps[mn] for ps in per_sample if ps.get(mn) is not None]
                    tmp_agg[mn] = round(sum(vals)/max(len(vals),1), 4) if vals else None
                print(f"    [{label}] {fw_key} {j+1}/{len(todo)}: {tmp_agg}", flush=True)

        # final save
        ck_data = {}
        if CKPT.exists():
            ck_data = json.loads(CKPT.read_text("utf-8"))
        ck_data[f"{fw_key}_{label}_ids"] = list(done_ids)
        ck_data[f"{fw_key}_{label}_data"] = per_sample
        CKPT.write_text(json.dumps(ck_data, ensure_ascii=False, indent=2), "utf-8")

    agg = {}
    for mn, _ in metric_defs:
        vals = [ps[mn] for ps in per_sample if ps.get(mn) is not None]
        agg[mn] = round(sum(vals)/max(len(vals),1), 4) if vals else None
    print(f"  [{label}] {fw_key} FINAL: {agg}")
    return {"n": len(valid), "aggregate": agg, "per_sample": per_sample}


# ═══════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--engine", default="both", choices=["cognee","graphiti","both"])
    p.add_argument("--skip", nargs="*", default=[], choices=["ragas","deepeval","triad"])
    p.add_argument("--resume", action="store_true")
    p.add_argument("-o","--output", default=None)
    args = p.parse_args()
    skip = set(args.skip)

    run_c = args.engine in ("cognee","both")
    run_g = args.engine in ("graphiti","both")

    print("="*60)
    print("  Direct LLM-Judge Tri-Framework Eval")
    print(f"  Judge: {JUDGE_MODEL}  Rate: {RATE}s/call")
    print(f"  Cognee: {'ON' if run_c else 'OFF'}  Graphiti: {'ON' if run_g else 'OFF'}")
    print(f"  Frameworks: {'Ragas' if 'ragas' not in skip else '✗'} | "
          f"{'DeepEval' if 'deepeval' not in skip else '✗'} | "
          f"{'Triad' if 'triad' not in skip else '✗'}")
    print(f"  API Key: {'✓' if LLM_API_KEY else '✗ MISSING'}")
    print("="*60)

    # Verify API
    try:
        test = _call("Say 'OK' only.", max_tokens=10)
        print(f"  API test: {test.strip()}")
    except Exception as e:
        print(f"  API FAIL: {e}")
        return

    cache = json.loads(CACHE_FILE.read_text("utf-8"))
    g_samples = cache.get("graphiti", [])
    c_samples = cache.get("cognee", [])

    results = {}
    for key, lbl, samples in [("cognee","Cognee", c_samples), ("graphiti","Graphiti", g_samples)]:
        if not samples or (key=="cognee" and not run_c) or (key=="graphiti" and not run_g):
            continue
        valid_n = sum(1 for s in samples if not s.get("error") and len(s.get("answer",""))>20)
        print(f"\n{'─'*55}\n  {lbl} ({valid_n}/{len(samples)} valid)\n{'─'*55}")
        results[key] = {}
        for fw_key in ["ragas", "deepeval", "triad"]:
            if fw_key not in skip:
                results[key][fw_key] = run_framework(fw_key, samples, lbl)

    # Summary
    print(f"\n{'='*60}\n  FINAL SUMMARY\n{'='*60}")

    all_fw = []
    if "ragas" not in skip:
        all_fw.append(("Ragas (equiv)", "ragas", ["faithfulness","answer_relevancy","context_precision","context_recall"]))
    if "deepeval" not in skip:
        all_fw.append(("DeepEval (equiv)", "deepeval", ["Faithfulness","AnswerRelevancy","ContextualPrecision","ContextualRecall","ContextualRelevancy"]))
    if "triad" not in skip:
        all_fw.append(("Triad (equiv)", "triad", ["Groundedness","ContextRelevance","AnswerRelevance"]))

    for fw_label, fw_key, fw_metrics in all_fw:
        print(f"\n  [{fw_label}]")
        print(f"  {'Metric':<24} {'Cognee':>10} {'Graphiti':>10} {'Delta':>10}")
        print(f"  {'-'*50}")
        for mn in fw_metrics:
            cv = results.get("cognee",{}).get(fw_key,{}).get("aggregate",{}).get(mn)
            gv = results.get("graphiti",{}).get(fw_key,{}).get("aggregate",{}).get(mn)
            print(f"  {mn:<24} {f'{cv:.4f}' if cv is not None else 'N/A':>10} "
                  f"{f'{gv:.4f}' if gv is not None else 'N/A':>10} "
                  f"{f'{gv-cv:+.4f}' if (cv is not None and gv is not None) else 'N/A':>10}")

    ts = time.strftime("%Y%m%d_%H%M%S")
    out = Path(args.output) if args.output else OUTPUT_DIR/f"direct_{ts}.json"
    out.write_text(json.dumps({"framework":"direct-llm-judge","judge":JUDGE_MODEL,"results":results},ensure_ascii=False,indent=2),"utf-8")
    print(f"\n  Report: {out}")

if __name__ == "__main__":
    main()
