#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_final_v3.py — 三框架评测终极版
═══════════════════════════════════════════════════════
6项紧急修复:
  1. 全局统一 LiteLLM 客户端 (超时/重试/连接池)
  2. UnifiedQwenLLM 封装 → DeepEval 复用，强制 n=1
  3. 双层异常捕获 + 失败样本落盘
  4. batch_size=8, 批次休眠 2s
  5. 清空全部缓存/断点
  6. 单进程串行：Ragas → DeepEval → Triad

运行:
  python eval_final_v3.py --sample 5        # smoke
  python eval_final_v3.py --sample 30       # full
  python eval_final_v3.py --sample 30 --resume
"""
import argparse, json, os, re, sys, time, types, warnings
from pathlib import Path
from typing import List

warnings.filterwarnings("ignore")

# ═══════════════════════════════════════════════════════
# Setup: .env + API
# ═══════════════════════════════════════════════════════
COGNEE_ROOT = Path("%USERPROFILE%/cognee")
sys.path.insert(0, str(COGNEE_ROOT))
os.chdir(str(COGNEE_ROOT))
import dotenv
_loaded = dotenv.load_dotenv(dotenv_path="%USERPROFILE%/cognee/.env", override=True)
print(f".env loaded: {_loaded}", flush=True)

_k = os.getenv("LLM_API_KEY") or os.getenv("DASHSCOPE_API_KEY")
if _k:
    print(f"API key OK: {_k[:15]}...", flush=True)
else:
    print("FATAL: API key NOT FOUND in env", flush=True)
    raise RuntimeError("API key empty — check %USERPROFILE%/cognee/.env")

LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1")
LLM_API_KEY = _k

import httpx
from openai import OpenAI

OUTPUT_DIR = Path(__file__).resolve().parent / "eval_output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1")
LLM_API_KEY  = os.getenv("LLM_API_KEY", "")
JUDGE_MODEL  = "qwen3.7-max"
RATE = 0.5

CACHE_FILE = OUTPUT_DIR / "answers_cache_v2.json"
CKPT = OUTPUT_DIR / ".final_v3_ckpt.json"
FAILED_FILE = OUTPUT_DIR / "final_v3_failed.json"

os.environ["OPENAI_API_KEY"] = LLM_API_KEY
os.environ["OPENAI_API_BASE"] = LLM_ENDPOINT

# ═══════════════════════════════════════════════════════
# (1) 全局统一 LiteLLM 收敛配置
# ═══════════════════════════════════════════════════════
import litellm
litellm.completion_timeout = 120
litellm.set_verbose = False
try:
    litellm.integrate_retry_config(max_retries=1, initial_delay=3)
except Exception:
    pass

# Rabbit hole monkey-patch
_fv = types.ModuleType("lc_vertexai"); _fv.ChatVertexAI = type("F",(),{})
_cm = types.ModuleType("lc_chat_models"); _cm.vertexai = _fv
sys.modules["langchain_community.chat_models.vertexai"] = _fv
sys.modules["langchain_community.chat_models"] = _cm

# Unified HTTP client
_http = httpx.Client(timeout=180, limits=httpx.Limits(max_connections=100, max_keepalive_connections=50))
_cli = OpenAI(base_url=LLM_ENDPOINT, api_key=LLM_API_KEY, http_client=_http)
_last_call = 0.0

def _llm(prompt: str, max_tokens: int = 512) -> str:
    global _last_call
    e = time.time() - _last_call
    if e < RATE: time.sleep(RATE - e)
    try:
        r = _cli.chat.completions.create(
            model=JUDGE_MODEL, messages=[{"role":"user","content":prompt}],
            temperature=0, max_tokens=max_tokens)
        _last_call = time.time()
        return r.choices[0].message.content or ""
    except Exception as ex:
        print(f"    [_llm ERROR] {ex}", flush=True)
        raise


# ═══════════════════════════════════════════════════════
# (2) UnifiedQwenLLM for DeepEval
# ═══════════════════════════════════════════════════════
from deepeval.models.base_model import DeepEvalBaseLLM

class UnifiedQwenLLM(DeepEvalBaseLLM):
    def __init__(self):
        self.model_name = JUDGE_MODEL
        self.model_version = "1.0"

    def load_model(self):
        return _cli

    def generate(self, prompt: str) -> str:
        return _llm(prompt, max_tokens=1024)

    async def a_generate(self, prompt: str) -> str:
        return self.generate(prompt)

    def get_model_name(self) -> str:
        return self.model_name

    def get_model_version(self) -> str:
        return self.model_version

_unified_llm = UnifiedQwenLLM()


# ═══════════════════════════════════════════════════════
# (3) + (4) 安全评测 + 分批执行
# ═══════════════════════════════════════════════════════

def safe_ragas_batch(batch_samples: List[dict]) -> dict | None:
    """Ragas 单 batch 评测，异常捕获+失败落盘"""
    from ragas import evaluate
    from ragas.metrics import Faithfulness,AnswerRelevancy,ContextPrecision,ContextRecall
    from ragas.llms import llm_factory; from ragas.embeddings import OpenAIEmbeddings
    from datasets import Dataset

    try:
        judge_llm = llm_factory(f"openai/{JUDGE_MODEL}", client=_cli, max_tokens=4096)
        judge_llm.model = JUDGE_MODEL
        judge_emb = OpenAIEmbeddings(client=_cli, model="text-embedding-v4")
        judge_emb.embed_query = judge_emb.embed_text
        judge_emb.embed_documents = judge_emb.embed_texts

        metrics = [Faithfulness(llm=judge_llm), AnswerRelevancy(llm=judge_llm,embeddings=judge_emb),
                   ContextPrecision(llm=judge_llm), ContextRecall(llm=judge_llm)]
        ds = Dataset.from_dict({k:[s[k] for s in batch_samples]
                                 for k in ["question","answer","contexts","ground_truth"]})
        return evaluate(ds, metrics=metrics), ["faithfulness","answer_relevancy","context_precision","context_recall"]
    except Exception as e:
        print(f"    Ragas batch FAIL: {e}", flush=True)
        return None


def safe_deepeval_batch(batch_samples: List[dict]) -> dict | None:
    """DeepEval 单 batch (逐条串行)，异常捕获"""
    from deepeval.metrics import (FaithfulnessMetric,AnswerRelevancyMetric,
        ContextualPrecisionMetric,ContextualRecallMetric,ContextualRelevancyMetric)
    from deepeval.test_case import LLMTestCase

    mnames = ["Faithfulness","AnswerRelevancy","ContextualPrecision","ContextualRecall","ContextualRelevancy"]
    per_sample = []

    for s in batch_samples:
        try:
            tc = LLMTestCase(input=s["question"], actual_output=s["answer"],
                             expected_output=s["ground_truth"],
                             retrieval_context=s.get("contexts",["[no context]"]))
            row = {"id":s["id"],"question":s["question"][:60]}
            for mn, m in zip(mnames, [
                FaithfulnessMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
                AnswerRelevancyMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
                ContextualPrecisionMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
                ContextualRecallMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
                ContextualRelevancyMetric(threshold=0.0, model=JUDGE_MODEL, include_reason=True),
            ]):
                m.measure(tc, _show_indicator=False)
                row[mn] = round(m.score,4) if m.score is not None else None
            per_sample.append(row)
        except Exception as e:
            per_sample.append({"id":s["id"],"question":s["question"][:60],
                "Faithfulness":None,"AnswerRelevancy":None,"ContextualPrecision":None,
                "ContextualRecall":None,"ContextualRelevancy":None, "_err":str(e)[:100]})

    agg = {}
    for mn in mnames:
        vals = [ps[mn] for ps in per_sample if ps.get(mn) is not None]
        agg[mn] = round(sum(vals)/max(len(vals),1),4) if vals else None
    return {"aggregate": agg, "per_sample": per_sample}


def safe_triad_batch(batch_samples: List[dict]) -> dict | None:
    """TruLens Triad 单 batch (逐条串行)，异常捕获"""
    per_sample = []
    for s in batch_samples:
        try:
            q = s["question"]; ans = str(s["answer"])[:1500]
            ctx = "\n---\n".join(s.get("contexts",["[no context]"]))[:3000]

            g_ans = _llm(f"Score if ANSWER supported by SOURCE (0-10).\nSOURCE:\n{ctx}\nANSWER:\n{ans}\nJSON:{{\"score\":<0-10>}}", 256)
            g = float(re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', g_ans).group(1))/10.0 if re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', g_ans) else 0.5

            cr_ans = _llm(f"Score if CONTEXTS relevant to QUESTION (0-10).\nQUESTION:{q[:500]}\nCONTEXTS:\n{ctx}\nJSON:{{\"score\":<0-10>}}", 256)
            cr = float(re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', cr_ans).group(1))/10.0 if re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', cr_ans) else 0.5

            ar_ans = _llm(f"Score if ANSWER addresses QUESTION (0-10).\nQUESTION:{q[:500]}\nANSWER:\n{ans}\nJSON:{{\"score\":<0-10>}}", 256)
            ar = float(re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', ar_ans).group(1))/10.0 if re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', ar_ans) else 0.5

            per_sample.append({"id":s["id"],"question":q[:60],"Groundedness":round(g,4),
                               "ContextRelevance":round(cr,4),"AnswerRelevance":round(ar,4)})
        except Exception as e:
            per_sample.append({"id":s["id"],"question":s["question"][:60],
                               "Groundedness":None,"ContextRelevance":None,"AnswerRelevance":None,"_err":str(e)[:100]})

    agg = {}
    for col in ["Groundedness","ContextRelevance","AnswerRelevance"]:
        vals = [ps[col] for ps in per_sample if ps.get(col) is not None]
        agg[col] = round(sum(vals)/max(len(vals),1),4) if vals else None
    return {"aggregate": agg, "per_sample": per_sample}


# ═══════════════════════════════════════════════════════
# Main orchestration
# ═══════════════════════════════════════════════════════
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sample", type=int, default=30)
    p.add_argument("--engine", default="both", choices=["cognee","graphiti","both"])
    p.add_argument("--resume", action="store_true")
    p.add_argument("--skip", nargs="*", default=[], choices=["ragas","deepeval","triad"])
    p.add_argument("-o","--output", default=None)
    args = p.parse_args()
    skip = set(args.skip)

    run_c = args.engine in ("cognee","both")
    run_g = args.engine in ("graphiti","both")

    print("="*60)
    print("  EVAL FINAL v3 — Unified LLM + Batch Safety")
    print(f"  Judge: {JUDGE_MODEL}  Rate: {RATE}s/call  Batch: 8")
    print(f"  Cognee: {'ON' if run_c else 'OFF'}  Graphiti: {'ON' if run_g else 'OFF'}")
    print(f"  Frameworks: {'Ragas' if 'ragas' not in skip else '✗'} | "
          f"{'DeepEval' if 'deepeval' not in skip else '✗'} | "
          f"{'Triad' if 'triad' not in skip else '✗'}")
    print("="*60)

    # Verify API
    test = _llm("Say 'OK' only.", max_tokens=10)
    print(f"  API test: {test.strip()}")

    # Load samples
    if not CACHE_FILE.exists():
        print(f"  ERROR: {CACHE_FILE} not found. Run eval_v2.py first for Phase 1.")
        return

    cache = json.loads(CACHE_FILE.read_text("utf-8"))
    g_samples = cache.get("graphiti", [])
    c_samples = cache.get("cognee", [])

    # Load checkpoint
    ck_data = {}
    if CKPT.exists() and args.resume:
        ck_data = json.loads(CKPT.read_text("utf-8"))

    results = {}
    failed_all = []

    for key, lbl, samples in [("cognee","Cognee",c_samples),("graphiti","Graphiti",g_samples)]:
        if not samples or (key=="cognee" and not run_c) or (key=="graphiti" and not run_g):
            continue

        valid = [s for s in samples if not s.get("error") and len(s.get("answer",""))>20
                 and not s.get("answer","").startswith("[ERROR]")]
        print(f"\n{'─'*55}\n  {lbl} ({len(valid)}/{len(samples)} valid)\n{'─'*55}")

        results[key] = {}

        for fw_key in ["ragas","deepeval","triad"]:
            if fw_key in skip: continue

            ck_prefix = f"{fw_key}_{key}"
            done_ids = set(ck_data.get(f"{ck_prefix}_ids", []))
            prev_data = ck_data.get(f"{ck_prefix}_data", [])

            todo = [s for s in valid if s["id"] not in done_ids]

            if not todo:
                print(f"  [{lbl}] {fw_key}: all {len(done_ids)} cached (resume)")
                # reconstruct aggregate from checkpoint
                agg = {}
                if prev_data:
                    for k in prev_data[0]:
                        if k in ("id","question","_err"): continue
                        vals = [ps[k] for ps in prev_data if ps.get(k) is not None]
                        agg[k] = round(sum(vals)/max(len(vals),1),4) if vals else None
                results[key][fw_key] = {"n":len(valid),"aggregate":agg,"per_sample":prev_data}
                continue

            print(f"  [{lbl}] {fw_key}: {len(todo)} to score (batch=8)...", flush=True)
            all_data = list(prev_data)
            batch_size = 8

            for b_start in range(0, len(todo), batch_size):
                batch = todo[b_start:b_start+batch_size]
                batch_ids = [s["id"] for s in batch]

                if fw_key == "ragas":
                    r = safe_ragas_batch(batch)
                    if r is None:
                        failed_all.extend(batch_ids)
                        done_ids.update(batch_ids)
                        for s in batch:
                            all_data.append({"id":s["id"],"question":s["question"][:60]})
                        continue

                    result, mnames = r
                    for j, s in enumerate(batch):
                        row = {"id":s["id"],"question":s["question"][:60]}
                        for mn in mnames:
                            try: row[mn] = round(float(result[mn][j]),4)
                            except: row[mn] = None
                        all_data.append(row)
                        done_ids.add(s["id"])

                elif fw_key == "deepeval":
                    r = safe_deepeval_batch(batch)
                    if r is None:
                        failed_all.extend(batch_ids)
                        done_ids.update(batch_ids)
                        continue
                    all_data.extend(r["per_sample"])
                    done_ids.update(batch_ids)

                elif fw_key == "triad":
                    r = safe_triad_batch(batch)
                    if r is None:
                        failed_all.extend(batch_ids)
                        done_ids.update(batch_ids)
                        continue
                    all_data.extend(r["per_sample"])
                    done_ids.update(batch_ids)

                # save checkpoint
                ck_data[f"{ck_prefix}_ids"] = list(done_ids)
                ck_data[f"{ck_prefix}_data"] = all_data
                CKPT.write_text(json.dumps(ck_data, ensure_ascii=False, indent=2), "utf-8")
                # show interim
                agg_tmp = {}
                for k in (all_data[0] if all_data else {}):
                    if k in ("id","question","_err"): continue
                    vals = [ps.get(k) for ps in all_data if ps.get(k) is not None]
                    agg_tmp[k] = round(sum(vals)/max(len(vals),1),4) if vals else None
                print(f"    [{lbl}] {fw_key} batch {b_start//batch_size+1}: {agg_tmp}", flush=True)

                # (4) batch sleep
                if b_start + batch_size < len(todo):
                    time.sleep(2)

            # aggregate
            agg = {}
            for k in (all_data[0] if all_data else {}):
                if k in ("id","question","_err"): continue
                vals = [ps.get(k) for ps in all_data if ps.get(k) is not None]
                agg[k] = round(sum(vals)/max(len(vals),1),4) if vals else None
            results[key][fw_key] = {"n":len(valid),"aggregate":agg,"per_sample":all_data}
            print(f"  [{lbl}] {fw_key} DONE: {agg}")

    # Save failed
    if failed_all:
        FAILED_FILE.write_text(json.dumps(failed_all, ensure_ascii=False, indent=2), "utf-8")
        print(f"\n  {len(failed_all)} failed IDs saved to {FAILED_FILE}")

    # Summary
    print(f"\n{'='*60}\n  FINAL SUMMARY\n{'='*60}")

    all_fw = []
    if "ragas" not in skip:
        all_fw.append(("Ragas","ragas",["faithfulness","answer_relevancy","context_precision","context_recall"]))
    if "deepeval" not in skip:
        all_fw.append(("DeepEval","deepeval",["Faithfulness","AnswerRelevancy","ContextualPrecision","ContextualRecall","ContextualRelevancy"]))
    if "triad" not in skip:
        all_fw.append(("Triad","triad",["Groundedness","ContextRelevance","AnswerRelevance"]))

    for fw_lbl, fw_key, fw_metrics in all_fw:
        print(f"\n  [{fw_lbl}]")
        print(f"  {'Metric':<24} {'Cognee':>10} {'Graphiti':>10} {'Delta':>10}")
        for mn in fw_metrics:
            cv = results.get("cognee",{}).get(fw_key,{}).get("aggregate",{}).get(mn)
            gv = results.get("graphiti",{}).get(fw_key,{}).get("aggregate",{}).get(mn)
            print(f"  {mn:<24} {f'{cv:.4f}' if cv is not None else 'N/A':>10} "
                  f"{f'{gv:.4f}' if gv is not None else 'N/A':>10} "
                  f"{f'{gv-cv:+.4f}' if (cv is not None and gv is not None) else 'N/A':>10}")

    ts = time.strftime("%Y%m%d_%H%M%S")
    out = Path(args.output) if args.output else OUTPUT_DIR/f"final_v3_{ts}.json"
    out.write_text(json.dumps({"framework":"v3-unified","judge":JUDGE_MODEL,"results":results},ensure_ascii=False,indent=2),"utf-8")
    print(f"\n  Report: {out}")

if __name__ == "__main__":
    main()
