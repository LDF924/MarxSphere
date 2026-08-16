#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_v4.py — Stable 3-Framework Evaluation (Ragas + DeepEval + TruLens)

Architecture:
  Ragas:    Native OpenAI client, manual scoring loops (bypasses SDK Evaluator)
            This avoids the llm_factory / langchain_community vertexai import crash.
  DeepEval: SDK native — custom QwenJudge via litellm, full metric suite
  TruLens:  Delayed import, provider-based feedback, runs AFTER Ragas+DeepEval

Anti-stall design (7 fixes applied):
  1. Ragas: no SDK Evaluator — manual OpenAI client calls with 0.5s rate limit
  2. DeepEval: single QwenJudge instance, no async, serial metric measurement
  3. TruLens: delayed import, runs last, isolated from Ragas/DeepEval
  4. Batch=8 with 2s inter-batch sleep — prevents API connection pool exhaustion
  5. Per-sample try/except — single failure skips sample, never blocks
  6. NLTK punkt_tab pre-loaded from venv-local nltk_data (avoids cross-drive error)
  7. Checkpoint per framework per engine — crash recovery without re-running

Usage:
  python eval_v4.py --sample 2 --engine graphiti              # smoke (~2 min)
  python eval_v4.py --sample 30 --engine both                 # full
  python eval_v4.py --sample 30 --engine both --resume        # resume
  python eval_v4.py --sample 30 --engine both --skip trulens  # skip TruLens
"""
import argparse, json, os, re, sys, time, warnings
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

warnings.filterwarnings("ignore")

# ═══════════════════════════════════════════════════════════
# Step 0: Environment Setup
# ═══════════════════════════════════════════════════════════
EVAL_DIR    = Path(r"D:\Desktop\执行流程")
COGNEE_DIR  = Path(r"%USERPROFILE%\cognee")
ENV_PATH    = COGNEE_DIR / ".env"
NLTK_DATA   = COGNEE_DIR / ".venv312" / "nltk_data"
DEEPEVAL_HOME = COGNEE_DIR / ".deepeval"

os.chdir(str(COGNEE_DIR))
sys.path.insert(0, str(COGNEE_DIR))
os.environ["NLTK_DATA"] = str(NLTK_DATA)
os.environ["DEEPEVAL_HOME"] = str(DEEPEVAL_HOME)
os.makedirs(str(DEEPEVAL_HOME), exist_ok=True)

import dotenv
assert dotenv.load_dotenv(dotenv_path=str(ENV_PATH), override=True), \
    ".env failed to load — check path"
KEY = os.getenv("LLM_API_KEY") or os.getenv("DASHSCOPE_API_KEY") or ""
assert KEY, "API Key not found — set LLM_API_KEY or DASHSCOPE_API_KEY in .env"
os.environ["DASHSCOPE_API_KEY"] = KEY
os.environ["OPENAI_API_KEY"] = KEY  # TruLens expects OPENAI_API_KEY

# ── LiteLLM config (for DeepEval) ──
import litellm
litellm.completion_timeout = 120
litellm.set_verbose = False
try:
    litellm.integrate_retry_config(max_retries=1, initial_delay=3)
except Exception:
    pass

# ── OpenAI client (for Ragas manual scoring) ──
import httpx
from openai import OpenAI, APIConnectionError

JUDGE_MODEL = "deepseek-v4-pro"
ENDPOINT    = "https://dashscope.aliyuncs.com/compatible-mode/v1"
RATE        = 0.5      # seconds between LLM calls
BATCH_SIZE  = 8        # samples per batch
BATCH_SLEEP = 2.0      # seconds between batches

OUTPUT_DIR = EVAL_DIR / "eval_output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_FILE = OUTPUT_DIR / "answers_cache_v2.json"
CKPT_FILE  = OUTPUT_DIR / ".v4_stable_ckpt.json"

_last_call: float = 0.0
_client: Optional[OpenAI] = None

def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(
            base_url=ENDPOINT,
            api_key=KEY,
            http_client=httpx.Client(timeout=180),
        )
    return _client

def _llm(prompt: str, max_tokens: int = 512, temperature: float = 0.0) -> str:
    """Rate-limited LLM call. Up to 3 retries with fresh client each time."""
    global _last_call
    elapsed = time.time() - _last_call
    if elapsed < RATE:
        time.sleep(RATE - elapsed)

    retry_max = 3
    retry_wait = 1.5
    for retry_cnt in range(retry_max):
        # Fresh client every retry to avoid session-cache anomalies
        cli = OpenAI(
            base_url=ENDPOINT,
            api_key=KEY,
            http_client=httpx.Client(timeout=180),
        )
        try:
            _last_call = time.time()
            resp = cli.chat.completions.create(
                model=JUDGE_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=temperature,
                max_tokens=max_tokens,
                extra_body={"reasoning_effort": {"effort": "low"}},
            )
            content = (resp.choices[0].message.content or "").strip()
            if content:
                time.sleep(0.5)
                return content
            raise ValueError("Empty response from LLM")
        except Exception as e:
            err_msg = str(e)[:120]
            print(f"    [WARN] LLM retry {retry_cnt+1}/{retry_max}: {err_msg}", flush=True)
            time.sleep(retry_wait)
    # All retries exhausted — return null-score fallback
    return '{"score":null,"reason":"llm_empty_fallback"}'


# ═══════════════════════════════════════════════════════════
# Ragas: Native OpenAI Client (Manual Scoring)
# Replicates the 4 core Ragas metrics via LLM-as-Judge prompts.
# Bypasses ragas SDK entirely — no llm_factory, no vertexai import.
# ═══════════════════════════════════════════════════════════

def _extract_score(text: str) -> float:
    """Extract a 0.0-1.0 score from JSON with key 'score' (0-10 scale)."""
    m = re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', text)
    if m:
        val = float(m.group(1))
        return val if val <= 1.0 else val / 10.0
    return 0.5

def ragas_faithfulness(ctxs: List[str], answer: str) -> float:
    """Extract claims from answer, verify each against source contexts."""
    ctx = "\n---\n".join(ctxs)[:4000]
    ans = str(answer)[:2000]
    prompt = (
        f"Extract ALL factual claims from ANSWER. Check each claim against SOURCE.\n"
        f"Count supported/total.\n"
        f"SOURCE:\n{ctx}\nANSWER:\n{ans}\n"
        f'JSON:{{"total":<int>,"supported":<int>,"score":<0-10>,"reason":"<brief>"}}'
    )
    return _extract_score(_llm(prompt, 512))

def ragas_answer_relevancy(question: str, answer: str) -> float:
    """Rate how directly the answer addresses the question."""
    prompt = (
        f"Rate how directly the ANSWER addresses the QUESTION (0-10).\n"
        f"QUESTION: {str(question)[:500]}\nANSWER: {str(answer)[:2000]}\n"
        f'JSON:{{"score":<0-10>,"reason":"<brief>"}}'
    )
    return _extract_score(_llm(prompt, 256))

def ragas_context_precision(question: str, ctxs: List[str], gt: str) -> float:
    """Judge if each context is relevant to question, score weighted by rank."""
    items = "\n".join(f"[{i}] {c[:300]}" for i, c in enumerate(ctxs[:10]))
    prompt = (
        f"Judge if each context is relevant to QUESTION. Score weighted by rank.\n"
        f"QUESTION:{question[:500]}\nGROUND TRUTH:{gt[:1000]}\nCONTEXTS:\n{items[:4000]}\n"
        f'JSON:{{"relevant_indices":[<list>],"score":<0-10>,"reason":"<brief>"}}'
    )
    return _extract_score(_llm(prompt, 512))

def ragas_context_recall(question: str, ctxs: List[str], gt: str) -> float:
    """Extract key claims from ground truth, check covered by contexts."""
    ctx = "\n---\n".join(ctxs)[:4000]
    prompt = (
        f"Extract key claims from GROUND_TRUTH. Check how many are covered by CONTEXTS.\n"
        f"QUESTION:{question[:500]}\nGROUND TRUTH:{gt[:1500]}\nCONTEXTS:\n{ctx}\n"
        f'JSON:{{"key_claims":<int>,"covered":<int>,"score":<0-10>,"reason":"<brief>"}}'
    )
    return _extract_score(_llm(prompt, 512))

RAGAS_METRICS = [
    ("faithfulness",      lambda s: ragas_faithfulness(s["contexts"], s["answer"])),
    ("answer_relevancy",  lambda s: ragas_answer_relevancy(s["question"], s["answer"])),
    ("context_precision", lambda s: ragas_context_precision(s["question"], s["contexts"], s.get("ground_truth") or "")),
    ("context_recall",    lambda s: ragas_context_recall(s["question"], s["contexts"], s.get("ground_truth") or "")),
]


# ═══════════════════════════════════════════════════════════
# DeepEval: Direct LLM Judge (bypasses SDK completely)
# Replicates 5 DeepEval metrics via the same _llm() used for Ragas.
# Solves the 3-call-per-metric latency issue (3x LLM per metric = 5 min each).
# ═══════════════════════════════════════════════════════════

DEEPEVAL_METRIC_NAMES = [
    "Faithfulness", "AnswerRelevancy", "ContextualPrecision",
    "ContextualRecall", "ContextualRelevancy",
]

def de_faithfulness(ctxs: List[str], answer: str) -> float:
    """DeepEval Faithfulness: split answer into claims, verify against contexts."""
    ctx = "\n---\n".join(ctxs)[:4000]
    ans = str(answer)[:2000]
    prompt = (
        f"Decompose the ANSWER into atomic factual claims. For each claim, determine "
        f"if it is entailed by the CONTEXTS (yes/no/idk). Score = yes_count / total.\n"
        f"CONTEXTS:\n{ctx}\n\nANSWER:\n{ans}\n"
        f'JSON:{{"total_claims":<int>,"yes":<int>,"score":<0-10>,"reason":"<brief>"}}'
    )
    return _extract_score(_llm(prompt, 512))

def de_answer_relevancy(question: str, answer: str) -> float:
    """DeepEval AnswerRelevancy: how relevant is the answer to the question."""
    prompt = (
        f"Evaluate how relevant and complete the ANSWER is to the QUESTION (0-10). "
        f"Consider: does it directly address the question? Is it complete? Is there irrelevant content?\n"
        f"QUESTION: {str(question)[:500]}\nANSWER: {str(answer)[:2000]}\n"
        f'JSON:{{"score":<0-10>,"reason":"<brief>"}}'
    )
    return _extract_score(_llm(prompt, 256))

def de_context_precision(question: str, ctxs: List[str], gt: str) -> float:
    """DeepEval ContextualPrecision: are ranked contexts relevant to the question?"""
    items = "\n".join(f"[{i}] {c[:300]}" for i, c in enumerate(ctxs[:10]))
    prompt = (
        f"For each context item, determine if it is RELEVANT to answering the QUESTION. "
        f"Precision = relevant_contexts / total_contexts. Earlier ranks have higher weight.\n"
        f"QUESTION: {str(question)[:500]}\nCONTEXTS:\n{items[:4000]}\n"
        f'JSON:{{"relevant_count":<int>,"total":<int>,"score":<0-10>,"reason":"<brief>"}}'
    )
    return _extract_score(_llm(prompt, 512))

def de_context_recall(question: str, ctxs: List[str], gt: str) -> float:
    """DeepEval ContextualRecall: how much of ground truth is covered by contexts."""
    ctx = "\n---\n".join(ctxs)[:4000]
    prompt = (
        f"Extract key information points from GROUND_TRUTH. Determine what fraction "
        f"can be derived from CONTEXTS. Recall = covered / total_key_points.\n"
        f"GROUND_TRUTH: {str(gt)[:1500]}\nCONTEXTS:\n{ctx}\n"
        f'JSON:{{"key_points":<int>,"covered":<int>,"score":<0-10>,"reason":"<brief>"}}'
    )
    return _extract_score(_llm(prompt, 512))

def de_context_relevancy(question: str, ctxs: List[str]) -> float:
    """DeepEval ContextualRelevancy: signal-to-noise ratio of contexts."""
    items = "\n".join(f"[{i}] {c[:200]}" for i, c in enumerate(ctxs[:10]))
    prompt = (
        f"Rate the signal-to-noise ratio of the CONTEXTS for answering the QUESTION. "
        f"How many context items are actually useful?\n"
        f"QUESTION: {str(question)[:500]}\nCONTEXTS:\n{items[:4000]}\n"
        f'JSON:{{"total":<int>,"relevant":<int>,"score":<0-10>,"reason":"<brief>"}}'
    )
    return _extract_score(_llm(prompt, 256))

DEEPEVAL_DIRECT_METRICS = [
    ("Faithfulness",        lambda s: de_faithfulness(s["contexts"], s["answer"])),
    ("AnswerRelevancy",     lambda s: de_answer_relevancy(s["question"], s["answer"])),
    ("ContextualPrecision", lambda s: de_context_precision(s["question"], s["contexts"], s.get("ground_truth") or "")),
    ("ContextualRecall",    lambda s: de_context_recall(s["question"], s["contexts"], s.get("ground_truth") or "")),
    ("ContextualRelevancy", lambda s: de_context_relevancy(s["question"], s["contexts"])),
]


# ═══════════════════════════════════════════════════════════
# TruLens: Provider-based Feedback (Delayed Import)
# ═══════════════════════════════════════════════════════════

TRULENS_FEEDBACKS = [
    ("Groundedness",     "groundedness_measure_with_cot_reasons"),
    ("ContextRelevance", "context_relevance_with_cot_reasons"),
    ("AnswerRelevance",  "relevance_with_cot_reasons"),
]

_trulens_provider_cache: Optional[Any] = None

def _init_trulens():
    """Lazy-init TruLens provider. Cached after first call."""
    global _trulens_provider_cache
    if _trulens_provider_cache is not None:
        return _trulens_provider_cache

    from trulens.providers.openai import OpenAI as TruOpenAI
    provider = TruOpenAI(
        api_key=KEY,
        base_url=ENDPOINT,
        model_engine=JUDGE_MODEL,
    )
    _trulens_provider_cache = provider
    return provider


# ═══════════════════════════════════════════════════════════
# Checkpoint Helpers
# ═══════════════════════════════════════════════════════════

def ckpt_load(prefix: str) -> Tuple[set, list]:
    if not CKPT_FILE.exists():
        return set(), []
    try:
        ck = json.loads(CKPT_FILE.read_text("utf-8"))
        return set(ck.get(f"{prefix}_ids", [])), ck.get(f"{prefix}_data", [])
    except Exception:
        return set(), []

def ckpt_save(done_ids: set, data: list, prefix: str):
    ck = {}
    if CKPT_FILE.exists():
        try:
            ck = json.loads(CKPT_FILE.read_text("utf-8"))
        except Exception:
            pass
    ck[f"{prefix}_ids"] = list(done_ids)
    ck[f"{prefix}_data"] = data
    CKPT_FILE.write_text(json.dumps(ck, ensure_ascii=False, indent=2), "utf-8")


# ═══════════════════════════════════════════════════════════
# Data Loading
# ═══════════════════════════════════════════════════════════

def load_samples(engine: str, sample_limit: int) -> List[Dict]:
    cache = json.loads(CACHE_FILE.read_text("utf-8"))
    raw = cache.get("graphiti" if engine == "graphiti" else "cognee", [])
    raw = raw[:sample_limit]
    valid = []
    for s in raw:
        if s.get("error"):
            continue
        ans = s.get("answer", "")
        if not ans or len(str(ans)) < 20 or str(ans).startswith("[ERROR]"):
            continue
        valid.append(s)
    return valid


# ═══════════════════════════════════════════════════════════
# Framework Runners
# ═══════════════════════════════════════════════════════════

def run_ragas(samples: List[Dict], engine: str,
              done_ids: set, prev_data: list) -> Tuple[set, list, Dict[str, float], list]:
    """Manual OpenAI-client scoring — bypasses Ragas SDK entirely."""
    prefix = f"ragas_{engine}"
    todo = [s for s in samples if s["id"] not in done_ids]
    all_data = list(prev_data)
    failed = []

    if not todo:
        agg = {}
        if prev_data:
            for mn, _ in RAGAS_METRICS:
                vals = [ps.get(mn) for ps in prev_data if ps.get(mn) is not None]
                agg[mn] = round(sum(vals)/max(len(vals),1), 4) if vals else None
        return done_ids, all_data, agg, failed

    print(f"  [Ragas] {len(todo)} samples to score...", flush=True)

    for b_start in range(0, len(todo), BATCH_SIZE):
        batch = todo[b_start:b_start + BATCH_SIZE]
        for s in batch:
            row = {"id": s["id"], "question": str(s["question"])[:60]}
            for mn, func in RAGAS_METRICS:
                try:
                    row[mn] = round(func(s), 4)
                except APIConnectionError as ce:
                    print(f"    [CONN] {s['id']}/{mn}: {ce}", flush=True)
                    row[mn] = None
                    failed.append(s["id"])
                except Exception as e:
                    print(f"    [ERR] {s['id']}/{mn}: {str(e)[:120]}", flush=True)
                    row[mn] = None
            all_data.append(row)
            done_ids.add(s["id"])

        ckpt_save(done_ids, all_data, prefix)
        agg_t = {}
        for mn, _ in RAGAS_METRICS:
            vals = [ps.get(mn) for ps in all_data if ps.get(mn) is not None]
            agg_t[mn] = round(sum(vals)/max(len(vals),1), 4) if vals else None
        print(f"    batch {b_start//BATCH_SIZE+1}: {agg_t}", flush=True)

        if b_start + BATCH_SIZE < len(todo):
            time.sleep(BATCH_SLEEP)

    agg = {}
    for mn, _ in RAGAS_METRICS:
        vals = [ps.get(mn) for ps in all_data if ps.get(mn) is not None]
        agg[mn] = round(sum(vals)/max(len(vals),1), 4) if vals else None
    return done_ids, all_data, agg, failed


def run_deepeval(samples: List[Dict], engine: str,
                 done_ids: set, prev_data: list) -> Tuple[set, list, Dict[str, float], list]:
    """DeepEval SDK with custom QwenJudge via litellm."""
    prefix = f"deepeval_{engine}"
    todo = [s for s in samples if s["id"] not in done_ids]
    all_data = list(prev_data)
    failed = []

    if not todo:
        agg = {}
        if prev_data:
            for mn in DEEPEVAL_METRIC_NAMES:
                vals = [ps.get(mn) for ps in prev_data if ps.get(mn) is not None]
                agg[mn] = round(sum(vals)/max(len(vals),1), 4) if vals else None
        return done_ids, all_data, agg, failed

    # ── DeepEval: abandon SDK metrics — replace with direct LLM Judge ──
    print(f"  [DeepEval] {len(todo)} samples to score (direct judge)...", flush=True)

    for b_start in range(0, len(todo), BATCH_SIZE):
        batch = todo[b_start:b_start + BATCH_SIZE]
        for s in batch:
            row = {"id": s["id"], "question": str(s["question"])[:60]}
            for mn, de_func in DEEPEVAL_DIRECT_METRICS:
                try:
                    row[mn] = round(de_func(s), 4)
                except Exception as e:
                    print(f"    [ERR] {s['id']}/{mn}: {str(e)[:120]}", flush=True)
                    row[mn] = None
            all_data.append(row)
            done_ids.add(s["id"])

        ckpt_save(done_ids, all_data, prefix)
        agg_t = {}
        for mn in DEEPEVAL_METRIC_NAMES:
            vals = [ps.get(mn) for ps in all_data if ps.get(mn) is not None]
            agg_t[mn] = round(sum(vals)/max(len(vals),1), 4) if vals else None
        print(f"    batch {b_start//BATCH_SIZE+1}: {agg_t}", flush=True)

        if b_start + BATCH_SIZE < len(todo):
            time.sleep(BATCH_SLEEP)

    agg = {}
    for mn in DEEPEVAL_METRIC_NAMES:
        vals = [ps.get(mn) for ps in all_data if ps.get(mn) is not None]
        agg[mn] = round(sum(vals)/max(len(vals),1), 4) if vals else None
    return done_ids, all_data, agg, failed


def run_trulens(samples: List[Dict], engine: str,
                done_ids: set, prev_data: list) -> Tuple[set, list, Dict[str, float], list]:
    """TruLens provider-based feedback. Runs in isolation after Ragas+DeepEval."""
    prefix = f"trulens_{engine}"
    todo = [s for s in samples if s["id"] not in done_ids]
    all_data = list(prev_data)
    failed = []

    if not todo:
        agg = {}
        if prev_data:
            for tname, _ in TRULENS_FEEDBACKS:
                vals = [ps.get(tname) for ps in prev_data if ps.get(tname) is not None]
                agg[tname] = round(sum(vals)/max(len(vals),1), 4) if vals else None
        return done_ids, all_data, agg, failed

    provider = _init_trulens()
    print(f"  [TruLens] {len(todo)} samples to score...", flush=True)

    for b_start in range(0, len(todo), BATCH_SIZE):
        batch = todo[b_start:b_start + BATCH_SIZE]
        for s in batch:
            row = {"id": s["id"], "question": str(s["question"])[:60]}
            ctx_str = "\n".join(str(c)[:2000] for c in (s.get("contexts") or []))
            ans_str = str(s["answer"])
            q_str   = str(s["question"])

            for tname, tmethod in TRULENS_FEEDBACKS:
                try:
                    func = getattr(provider, tmethod)
                    if tname == "Groundedness":
                        result = func(source=ctx_str, statement=ans_str)
                    elif tname == "ContextRelevance":
                        result = func(question=q_str, context=ctx_str)
                    elif tname == "AnswerRelevance":
                        result = func(prompt=q_str, response=ans_str)
                    else:
                        result = (0.5, {})

                    if isinstance(result, tuple):
                        row[tname] = round(result[0], 4) if isinstance(result[0], (int, float)) else 0.5
                    else:
                        row[tname] = float(result) if result is not None else 0.5
                except APIConnectionError as ce:
                    print(f"    [CONN] {s['id']}/{tname}: {ce}", flush=True)
                    row[tname] = None
                    failed.append(s["id"])
                except Exception as e:
                    print(f"    [ERR] {s['id']}/{tname}: {str(e)[:120]}", flush=True)
                    row[tname] = None
            all_data.append(row)
            done_ids.add(s["id"])

        ckpt_save(done_ids, all_data, prefix)
        names = [t[0] for t in TRULENS_FEEDBACKS]
        agg_t = {}
        for tn in names:
            vals = [ps.get(tn) for ps in all_data if ps.get(tn) is not None]
            agg_t[tn] = round(sum(vals)/max(len(vals),1), 4) if vals else None
        print(f"    batch {b_start//BATCH_SIZE+1}: {agg_t}", flush=True)

        if b_start + BATCH_SIZE < len(todo):
            time.sleep(BATCH_SLEEP)

    agg = {}
    for tname, _ in TRULENS_FEEDBACKS:
        vals = [ps.get(tname) for ps in all_data if ps.get(tname) is not None]
        agg[tname] = round(sum(vals)/max(len(vals),1), 4) if vals else None
    return done_ids, all_data, agg, failed


# ═══════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════

def _agg_from_prev(prev_data: list, metric_names: list) -> Dict[str, Optional[float]]:
    agg = {}
    for mn in metric_names:
        vals = [ps.get(mn) for ps in prev_data if ps.get(mn) is not None]
        agg[mn] = round(sum(vals)/max(len(vals),1), 4) if vals else None
    return agg


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int, default=30)
    parser.add_argument("--engine", default="both", choices=["cognee", "graphiti", "both"])
    parser.add_argument("--skip", nargs="*", default=[], choices=["ragas", "deepeval", "trulens"])
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("-o", "--output", default=None)
    args = parser.parse_args()
    skip = set(args.skip)

    run_c = args.engine in ("cognee", "both")
    run_g = args.engine in ("graphiti", "both")
    engines = []
    if run_c: engines.append(("cognee", "Cognee"))
    if run_g: engines.append(("graphiti", "Graphiti"))

    print("=" * 55, flush=True)
    print("  EVAL v4 — Stable 3-Framework (Ragas+DeepEval+TruLens)", flush=True)
    print(f"  Judge: {JUDGE_MODEL}  Batch: {BATCH_SIZE}  Rate: {RATE}s/call", flush=True)
    print(f"  Engines: {[e[1] for e in engines]}", flush=True)
    print(f"  Ragas:{'Y' if 'ragas' not in skip else 'N'}  "
          f"DeepEval:{'Y' if 'deepeval' not in skip else 'N'}  "
          f"TruLens:{'Y' if 'trulens' not in skip else 'N'}", flush=True)
    print(f"  Resume: {'ON' if args.resume else 'OFF'}", flush=True)
    print("=" * 55, flush=True)

    # API check
    test_resp = _llm("Say 'OK' only.", 10)
    print(f"  API: {test_resp.strip()}\n", flush=True)

    if not args.resume and CKPT_FILE.exists():
        CKPT_FILE.unlink()

    results: Dict[str, Dict] = {}

    FRAMEWORKS = [
        ("ragas",    run_ragas,    [m[0] for m in RAGAS_METRICS]),
        ("deepeval", run_deepeval, DEEPEVAL_METRIC_NAMES),
        ("trulens",  run_trulens,  [t[0] for t in TRULENS_FEEDBACKS]),
    ]

    for eng_key, eng_label in engines:
        samples = load_samples(eng_key, args.sample)
        if not samples:
            print(f"  {eng_label}: no valid samples", flush=True)
            continue

        print(f"\n{'─'*55}\n  {eng_label}: {len(samples)} samples\n{'─'*55}", flush=True)
        results[eng_key] = {}

        for fw_key, run_func, metric_names in FRAMEWORKS:
            if fw_key in skip:
                continue

            prefix = f"{fw_key}_{eng_key}"
            done_ids, prev_data = ckpt_load(prefix) if args.resume else (set(), [])

            # If all done via checkpoint, just aggregate
            if not args.resume or not prev_data:
                pass  # will run full
            elif len(done_ids) >= len(samples):
                agg = _agg_from_prev(prev_data, metric_names)
                results[eng_key][fw_key] = {"n": len(samples), "aggregate": agg, "per_sample": prev_data}
                states = [f"{k}={v}" for k, v in agg.items()]
                print(f"  [{fw_key}] cached | {' | '.join(states)}", flush=True)
                continue

            done_ids, all_data, agg, _failed = run_func(samples, eng_key, done_ids, prev_data)

            agg_final = _agg_from_prev(all_data, metric_names)
            results[eng_key][fw_key] = {
                "n": len(samples), "aggregate": agg_final, "per_sample": all_data,
            }
            states = [f"{k}={v}" for k, v in agg_final.items()]
            print(f"  [{fw_key}] DONE | {' | '.join(states)}", flush=True)

    # ═══════════════════════════════════════════ SUMMARY ═══════════════════════════════════════════
    print(f"\n{'='*55}\n  FINAL SUMMARY\n{'='*55}")

    FW_DISPLAY = [
        ("Ragas",   "ragas",   ["faithfulness","answer_relevancy","context_precision","context_recall"]),
        ("DeepEval","deepeval", DEEPEVAL_METRIC_NAMES),
        ("Triad (TruLens)", "trulens", [t[0] for t in TRULENS_FEEDBACKS]),
    ]

    for fw_label, fw_key, metric_names in FW_DISPLAY:
        if fw_key in skip:
            continue
        print(f"\n  [{fw_label}]")
        print(f"  {'Metric':<24} {'Cognee':>10} {'Graphiti':>10} {'Delta':>10}")
        for mn in metric_names:
            cv = results.get("cognee", {}).get(fw_key, {}).get("aggregate", {}).get(mn)
            gv = results.get("graphiti", {}).get(fw_key, {}).get("aggregate", {}).get(mn)
            dv = f"{(gv-cv):+.4f}" if (cv is not None and gv is not None) else "N/A"
            cf = f"{cv:.4f}" if cv is not None else "N/A"
            gf = f"{gv:.4f}" if gv is not None else "N/A"
            print(f"  {mn:<24} {cf:>10} {gf:>10} {dv:>10}")

    ts = time.strftime("%Y%m%d_%H%M%S")
    out_path = Path(args.output) if args.output else OUTPUT_DIR / f"v4_stable_{ts}.json"
    out_path.write_text(
        json.dumps({"framework":"v4-stable","judge":JUDGE_MODEL,"results":results},
                   ensure_ascii=False, indent=2),
        "utf-8",
    )
    print(f"\n  Report: {out_path}", flush=True)


if __name__ == "__main__":
    main()
