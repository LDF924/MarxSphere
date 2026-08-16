#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_phase2.py — Phase 2 only: 读取缓存答案 → Ragas → DeepEval → Triad
═══════════════════════════════════════════════════════════════
运行:
  python eval_phase2.py                          # 全部
  python eval_phase2.py --engine graphiti --skip deepeval triad  # 单框架
"""
import json, os, re, sys, time, types, warnings
from pathlib import Path
from typing import List

warnings.filterwarnings("ignore")

# ── Monkey-patch Ragas ──
_fv = types.ModuleType("lc_vertexai"); _fv.ChatVertexAI = type("F",(),{})
_cm = types.ModuleType("lc_chat_models"); _cm.vertexai = _fv
sys.modules["langchain_community.chat_models.vertexai"] = _fv
sys.modules["langchain_community.chat_models"] = _cm

OUTPUT_DIR = Path(__file__).resolve().parent / "eval_output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Cognee .env must be loaded before LLM_ENDPOINT check ──
COGNEE_ROOT = Path("%USERPROFILE%/cognee")
sys.path.insert(0, str(COGNEE_ROOT))
os.chdir(str(COGNEE_ROOT))
import dotenv; dotenv.load_dotenv(override=True)

LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1")
LLM_API_KEY  = os.getenv("LLM_API_KEY", "")
JUDGE_MODEL  = "qwen3.7-max"
RATE = 0.6  # seconds between API calls

CACHE_FILE = OUTPUT_DIR / "answers_cache_v2.json"
RAGAS_CKPT   = OUTPUT_DIR / ".ragas_p2_ckpt.json"
DEEPEVAL_CKPT= OUTPUT_DIR / ".deepeval_p2_ckpt.json"
TRIAD_CKPT   = OUTPUT_DIR / ".triad_p2_ckpt.json"

os.environ["OPENAI_API_KEY"] = LLM_API_KEY
os.environ["OPENAI_API_BASE"] = LLM_ENDPOINT

import httpx
from openai import OpenAI
_cli = OpenAI(base_url=LLM_ENDPOINT, api_key=LLM_API_KEY, http_client=httpx.Client(timeout=180))
_last_call = 0.0

def _llm(prompt: str, model: str = JUDGE_MODEL, max_tokens: int = 512):
    global _last_call
    elapsed = time.time() - _last_call
    if elapsed < RATE: time.sleep(RATE - elapsed)
    r = _cli.chat.completions.create(model=model, messages=[{"role":"user","content":prompt}], temperature=0, max_tokens=max_tokens)
    _last_call = time.time()
    return r.choices[0].message.content or ""

# ═══════════════════════════════ Ragas ═══════════════════════════════
def run_ragas(samples: List[dict], label: str):
    from ragas import evaluate
    from ragas.metrics import Faithfulness,AnswerRelevancy,ContextPrecision,ContextRecall
    from ragas.llms import llm_factory; from ragas.embeddings import OpenAIEmbeddings
    from datasets import Dataset

    valid = [s for s in samples if not s.get("error") and len(s.get("answer",""))>20
             and not s.get("answer","").startswith("[ERROR]")]
    if not valid: return {"n":0}

    judge_llm = llm_factory(f"openai/{JUDGE_MODEL}", client=_cli, max_tokens=4096)
    judge_llm.model = JUDGE_MODEL
    judge_emb = OpenAIEmbeddings(client=_cli, model="text-embedding-v4")
    judge_emb.embed_query = judge_emb.embed_text; judge_emb.embed_documents = judge_emb.embed_texts

    metrics = [Faithfulness(llm=judge_llm), AnswerRelevancy(llm=judge_llm,embeddings=judge_emb),
               ContextPrecision(llm=judge_llm), ContextRecall(llm=judge_llm)]
    mnames = ["faithfulness","answer_relevancy","context_precision","context_recall"]

    # resume
    done_ids=set(); per_sample=[]
    if RAGAS_CKPT.exists():
        ck=json.loads(RAGAS_CKPT.read_text("utf-8")); done_ids=set(ck.get("done_ids",[])); per_sample=ck.get("per_sample",[])
    todo = [(i,s) for i,s in enumerate(valid) if s["id"] not in done_ids]

    if not todo:
        print(f"  [{label}] Ragas: all {len(done_ids)} cached")
    else:
        print(f"  [{label}] Ragas: {len(todo)} to score (batch=5)...", flush=True)
        for b_start in range(0, len(todo), 5):
            batch = todo[b_start:b_start+5]
            b_d={k:[valid[i][k] for i,_ in batch] for k in ["question","answer","contexts","ground_truth"]}
            try:
                result = evaluate(Dataset.from_dict(b_d), metrics=metrics)
                for j,(_,s) in enumerate(batch):
                    row={"id":s["id"],"question":s["question"][:60]}
                    for mn in mnames:
                        try: row[mn]=round(float(result[mn][j]),4)
                        except: row[mn]=None
                    per_sample.append(row); done_ids.add(s["id"])
            except Exception as e:
                print(f"    [{label}] batch {b_start//5+1} FAIL: {e}", flush=True)
                for _,s in batch:
                    per_sample.append({"id":s["id"],"question":s["question"][:60],"faithfulness":None,"answer_relevancy":None,"context_precision":None,"context_recall":None})
                    done_ids.add(s["id"])
            RAGAS_CKPT.write_text(json.dumps({"done_ids":list(done_ids),"per_sample":per_sample},ensure_ascii=False),"utf-8")
            print(f"    [{label}] {len(done_ids)}/{len(valid)} saved", flush=True)
            time.sleep(2)

    agg={}
    for mn in mnames:
        vals=[ps[mn] for ps in per_sample if ps.get(mn) is not None]
        agg[mn]=round(sum(vals)/max(len(vals),1),4) if vals else None
    print(f"  [{label}] Ragas: {agg}")
    return {"n":len(valid),"aggregate":agg,"per_sample":per_sample}


# ═══════════════════════════════ DeepEval ═══════════════════════════════
def run_deepeval(samples: List[dict], label: str):
    from deepeval.metrics import (FaithfulnessMetric,AnswerRelevancyMetric,
        ContextualPrecisionMetric,ContextualRecallMetric,ContextualRelevancyMetric)
    from deepeval.test_case import LLMTestCase
    import deepeval.metrics.indicator as _di
    _di.DEEPEVAL_API_KEY = LLM_API_KEY
    _di.DEEPEVAL_BASE_URL = LLM_ENDPOINT

    valid = [s for s in samples if not s.get("error") and len(s.get("answer",""))>20
             and not s.get("answer","").startswith("[ERROR]")]
    if not valid: return {"n":0}

    mnames = ["Faithfulness","AnswerRelevancy","ContextualPrecision","ContextualRecall","ContextualRelevancy"]
    def _mk(): return [FaithfulnessMetric(threshold=0.0,model=JUDGE_MODEL,include_reason=True),
                       AnswerRelevancyMetric(threshold=0.0,model=JUDGE_MODEL,include_reason=True),
                       ContextualPrecisionMetric(threshold=0.0,model=JUDGE_MODEL,include_reason=True),
                       ContextualRecallMetric(threshold=0.0,model=JUDGE_MODEL,include_reason=True),
                       ContextualRelevancyMetric(threshold=0.0,model=JUDGE_MODEL,include_reason=True)]

    done_ids=set(); per_sample=[]
    if DEEPEVAL_CKPT.exists():
        ck=json.loads(DEEPEVAL_CKPT.read_text("utf-8")); done_ids=set(ck.get("done_ids",[])); per_sample=ck.get("per_sample",[])
    todo = [(i,s) for i,s in enumerate(valid) if s["id"] not in done_ids]

    if not todo:
        print(f"  [{label}] DeepEval: all {len(done_ids)} cached")
    else:
        print(f"  [{label}] DeepEval: {len(todo)} serial...", flush=True)
        for j,(_,s) in enumerate(todo):
            tc = LLMTestCase(input=s["question"],actual_output=s["answer"],expected_output=s["ground_truth"],
                             retrieval_context=s.get("contexts",["[no context]"]))
            row={"id":s["id"],"question":s["question"][:60]}
            for mn,m in zip(mnames,_mk()):
                try: m.measure(tc,_show_indicator=False); row[mn]=round(m.score,4) if m.score is not None else None
                except: row[mn]=None
            per_sample.append(row); done_ids.add(s["id"])
            if (j+1)%5==0:
                DEEPEVAL_CKPT.write_text(json.dumps({"done_ids":list(done_ids),"per_sample":per_sample},ensure_ascii=False),"utf-8")
                print(f"    [{label}] {j+1}/{len(todo)} saved", flush=True); time.sleep(2)
        DEEPEVAL_CKPT.write_text(json.dumps({"done_ids":list(done_ids),"per_sample":per_sample},ensure_ascii=False),"utf-8")

    agg={}
    for mn in mnames:
        vals=[ps[mn] for ps in per_sample if ps.get(mn) is not None]
        agg[mn]=round(sum(vals)/max(len(vals),1),4) if vals else None
    print(f"  [{label}] DeepEval: {agg}")
    return {"n":len(valid),"aggregate":agg,"per_sample":per_sample}


# ═══════════════════════════════ Triad ═══════════════════════════════
def run_triad(samples: List[dict], label: str):
    valid = [s for s in samples if not s.get("error") and len(s.get("answer",""))>20
             and not s.get("answer","").startswith("[ERROR]")]
    if not valid: return {"n":0}

    done_ids=set(); per_sample=[]
    if TRIAD_CKPT.exists():
        ck=json.loads(TRIAD_CKPT.read_text("utf-8")); done_ids=set(ck.get("done_ids",[])); per_sample=ck.get("per_sample",[])
    todo = [(i,s) for i,s in enumerate(valid) if s["id"] not in done_ids]

    def _judge(p):
        ans=_llm(p,max_tokens=256)
        m=re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)',ans)
        return float(m.group(1))/10.0 if m else 0.5

    if not todo:
        print(f"  [{label}] Triad: all {len(done_ids)} cached")
    else:
        print(f"  [{label}] Triad: {len(todo)} serial...", flush=True)
        for j,(_,s) in enumerate(todo):
            q=s["question"]; ans=str(s["answer"])[:1500]; ctx="\n---\n".join(s.get("contexts",["[no context]"]))[:3000]
            g =_judge(f"Score if ANSWER supported by SOURCE (0-10).\nSOURCE:\n{ctx}\nANSWER:\n{ans}\nJSON:{{\"score\":<0-10>}}")
            cr=_judge(f"Score if CONTEXTS relevant to QUESTION (0-10).\nQUESTION:{q[:500]}\nCONTEXTS:\n{ctx}\nJSON:{{\"score\":<0-10>}}")
            ar=_judge(f"Score if ANSWER addresses QUESTION (0-10).\nQUESTION:{q[:500]}\nANSWER:\n{ans}\nJSON:{{\"score\":<0-10>}}")
            per_sample.append({"id":s["id"],"question":q[:60],"Groundedness":round(g,4),"ContextRelevance":round(cr,4),"AnswerRelevance":round(ar,4)})
            done_ids.add(s["id"])
            if (j+1)%5==0:
                TRIAD_CKPT.write_text(json.dumps({"done_ids":list(done_ids),"per_sample":per_sample},ensure_ascii=False),"utf-8")
                print(f"    [{label}] {j+1}/{len(todo)} saved", flush=True); time.sleep(2)
        TRIAD_CKPT.write_text(json.dumps({"done_ids":list(done_ids),"per_sample":per_sample},ensure_ascii=False),"utf-8")

    agg={}
    for col in ["Groundedness","ContextRelevance","AnswerRelevance"]:
        vals=[ps[col] for ps in per_sample if ps.get(col) is not None]
        agg[col]=round(sum(vals)/max(len(vals),1),4) if vals else None
    print(f"  [{label}] Triad: {agg}")
    return {"n":len(valid),"aggregate":agg,"per_sample":per_sample}


# ═══════════════════════════════ Main ═══════════════════════════════
def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--engine",default="both",choices=["cognee","graphiti","both"])
    p.add_argument("--skip",nargs="*",default=[],choices=["ragas","deepeval","triad"])
    p.add_argument("-o","--output",default=None)
    args = p.parse_args()
    skip = set(args.skip)

    run_c = args.engine in ("cognee","both"); run_g = args.engine in ("graphiti","both")
    print("="*55)
    print("  Phase 2: Ragas → DeepEval → Triad")
    print(f"  Judge: {JUDGE_MODEL}  Rate: {RATE}s/call")
    print(f"  Cognee: {'ON' if run_c else 'OFF'}  Graphiti: {'ON' if run_g else 'OFF'}")
    print(f"  Skip: {skip or 'none'}")
    print("="*55)

    cache = json.loads(CACHE_FILE.read_text("utf-8"))
    g_samples = cache.get("graphiti",[])
    c_samples = cache.get("cognee",[])

    results = {}
    for key, lbl, samples in [("cognee","Cognee",c_samples),("graphiti","Graphiti",g_samples)]:
        if not samples or key=="cognee" and not run_c or key=="graphiti" and not run_g: continue
        valid = [s for s in samples if not s.get("error") and len(s.get("answer",""))>20 and not s.get("answer","").startswith("[ERROR]")]
        print(f"\n{'─'*50}\n  {lbl} ({len(valid)}/{len(samples)} valid)\n{'─'*50}")
        results[key] = {}
        if "ragas" not in skip: results[key]["ragas"] = run_ragas(samples, lbl)
        if "deepeval" not in skip: results[key]["deepeval"] = run_deepeval(samples, lbl)
        if "triad" not in skip: results[key]["triad"] = run_triad(samples, lbl)

    # Summary
    print(f"\n{'='*55}\n  SUMMARY\n{'='*55}")
    for fw, fk, fmetrics in [
        ("Ragas","ragas",["faithfulness","answer_relevancy","context_precision","context_recall"]),
        ("DeepEval","deepeval",["Faithfulness","AnswerRelevancy","ContextualPrecision","ContextualRecall","ContextualRelevancy"]),
        ("Triad","triad",["Groundedness","ContextRelevance","AnswerRelevance"]),
    ]:
        print(f"\n  [{fw}]")
        print(f"  {'Metric':<24} {'Cognee':>10} {'Graphiti':>10} {'Delta':>10}")
        for mn in fmetrics:
            cv = results.get("cognee",{}).get(fk,{}).get("aggregate",{}).get(mn)
            gv = results.get("graphiti",{}).get(fk,{}).get("aggregate",{}).get(mn)
            print(f"  {mn:<24} {f'{cv:.4f}' if cv is not None else 'N/A':>10} "
                  f"{f'{gv:.4f}' if gv is not None else 'N/A':>10} "
                  f"{f'{gv-cv:+.4f}' if (cv is not None and gv is not None) else 'N/A':>10}")

    ts = time.strftime("%Y%m%d_%H%M%S")
    out = Path(args.output) if args.output else OUTPUT_DIR/f"phase2_{ts}.json"
    out.write_text(json.dumps({"judge":JUDGE_MODEL,"results":results},ensure_ascii=False,indent=2),"utf-8")
    print(f"\n  Report: {out}")

if __name__ == "__main__":
    main()
