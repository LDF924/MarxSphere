#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_v2.py — 三框架评测优化版
═══════════════════════════════════════════════════════
优化清单:
  1. Cognee CACHING=true + GRAPH_MAX_NODES=200 + VECTOR_TOP_K=5
  2. Ragas Evaluator(num_generations=1, max_workers=1, timeout=120)
  3. LiteLLM: completion_timeout=120, max_retries=1, 连接池扩容
  4. 分批执行: 每个框架写独立 checkpoint, 10样本/批, 批次间 sleep 2s
  5. 断点续评: 失败样本落盘, 完成后自动重试

运行:
  python eval_v2.py --sample 5               # smoke
  python eval_v2.py --sample 30              # 全量
  python eval_v2.py --sample 30 --resume     # 断点续
"""
import argparse, asyncio, json, os, re, sys, time, types, warnings
from pathlib import Path
from typing import List

warnings.filterwarnings("ignore")

# ═══════════════════════════════════════════════════════
# (1) 环境变量 — 检索层优化
# ═══════════════════════════════════════════════════════
os.environ["CACHING"] = "true"                    # 开启缓存
os.environ["GRAPH_MAX_NODES"] = "200"             # 限制子图节点
os.environ["GRAPH_HOP_DEPTH"] = "1"              # 限制跳数
os.environ["VECTOR_TOP_K"] = "5"                 # 压缩向量召回

COGNEE_ROOT = Path("%USERPROFILE%/cognee")
sys.path.insert(0, str(COGNEE_ROOT))
os.chdir(str(COGNEE_ROOT))
import dotenv; dotenv.load_dotenv(override=True)
from cognee.api.v1.search import search, SearchType
from cognee.modules.users.methods import get_default_user

import httpx
from neo4j import GraphDatabase
from openai import OpenAI

OUTPUT_DIR = Path(__file__).resolve().parent / "eval_output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1")
LLM_API_KEY  = os.getenv("LLM_API_KEY", "")
EMBED_MODEL  = "text-embedding-v4"
GROUND_TRUTH = COGNEE_ROOT / "eval" / "ground_truth_30q.json"
TOP_K        = 5    # (1) 压缩向量召回
JUDGE_MODEL  = "qwen3.7-max"

CACHE_FILE   = OUTPUT_DIR / "answers_cache_v2.json"
RAGAS_CKPT   = OUTPUT_DIR / ".ragas_v2_ckpt.json"
DEEPEVAL_CKPT= OUTPUT_DIR / ".deepeval_v2_ckpt.json"
TRIAD_CKPT   = OUTPUT_DIR / ".triad_v2_ckpt.json"

# ═══════════════════════════════════════════════════════
# (3) LiteLLM 配置 — 防 APIConnectionError
# ═══════════════════════════════════════════════════════
import litellm
litellm.completion_timeout = 120
litellm.set_verbose = False
# RetryConfig (新版 litellm API)
try:
    litellm.integrate_retry_config(max_retries=1, initial_delay=3)
except Exception:
    pass

# OpenAI client — 连接池扩容
_cli: OpenAI = None
_last_call = 0.0
RATE_INTERVAL = 0.5  # 0.5s between LLM calls

def _llm(prompt: str, model: str = JUDGE_MODEL, max_tokens: int = 512, temperature: float = 0.0) -> str:
    global _cli, _last_call
    if _cli is None:
        _cli = OpenAI(
            base_url=LLM_ENDPOINT, api_key=LLM_API_KEY,
            http_client=httpx.Client(
                timeout=180,
                limits=httpx.Limits(max_connections=100, max_keepalive_connections=50),
            ))
    elapsed = time.time() - _last_call
    if elapsed < RATE_INTERVAL:
        time.sleep(RATE_INTERVAL - elapsed)
    r = _cli.chat.completions.create(
        model=model, messages=[{"role":"user","content":prompt}],
        temperature=temperature, max_tokens=max_tokens)
    _last_call = time.time()
    return r.choices[0].message.content or ""

def _embed(text: str) -> List[float] | None:
    global _cli, _last_call
    if _cli is None:
        _cli = OpenAI(
            base_url=LLM_ENDPOINT, api_key=LLM_API_KEY,
            http_client=httpx.Client(
                timeout=180,
                limits=httpx.Limits(max_connections=100, max_keepalive_connections=50),
            ))
    elapsed = time.time() - _last_call
    if elapsed < 0.3: time.sleep(0.3 - elapsed)
    try:
        r = _cli.embeddings.create(model=EMBED_MODEL, input=text)
        _last_call = time.time()
        return r.data[0].embedding
    except Exception:
        return None


# ═══════════════════════════════════════════════════════
# Searchers
# ═══════════════════════════════════════════════════════
class GraphitiSearcher:
    def __init__(self):
        self.drv = GraphDatabase.driver("bolt://127.0.0.1:11001", auth=("neo4j","neo4j123"))
        self.drv.verify_connectivity()
        self._ecache: dict = {}

    def search(self, query: str) -> dict:
        t0 = time.time()
        try:
            qv = _embed(query)
            contexts = []
            with self.drv.session() as s:
                rows = s.run(
                    "CALL db.index.vector.queryNodes('entity_vector_idx',30,$v) YIELD node,score "
                    "RETURN node.name AS name, node.category AS cat, node.description AS desc, score "
                    "ORDER BY score DESC LIMIT 10", v=qv)
                entities = [dict(r) for r in rows]
                for e in entities[:5]:
                    eps = s.run(
                        "MATCH (e:Entity {name:$en})-[:EXTRACTED_FROM]->(ep:Episode) "
                        "RETURN ep.source_folder AS p, ep.author AS a, ep.year AS y LIMIT 2",
                        en=e["name"]).data()
                    for ep in eps:
                        cks = s.run(
                            "MATCH (ep:Episode {source_folder:$p})<-[:CHUNK_OF]-(c:Chunk) "
                            "WHERE c.chunk_type IN ['original','abstract'] "
                            "RETURN c.text AS t ORDER BY c.chunk_index ASC LIMIT 2",
                            p=ep["p"]).data()
                        for ck in cks:
                            txt = str(ck.get("t",""))[:500]
                            if len(txt)>20:
                                contexts.append(f"[{str(ep.get('a','?'))[:20]},{ep.get('y','?')}] {txt}")

            ctx = "\n".join(contexts[:15])[:4000]
            ans = _llm(
                f"你是马克思主义理论学术专家。基于上下文准确回答。禁止编造、假设、因果推断。用[作者,年份]标注来源。\n\n"
                f"查询：{query}\n\n上下文：\n{ctx}",
                model="qwen-plus", max_tokens=1500)
            return {"answer": ans, "contexts": contexts[:15],
                    "elapsed": round(time.time()-t0,2), "error": None}
        except Exception as e:
            return {"answer": f"[ERROR] {e}", "contexts": [],
                    "elapsed": round(time.time()-t0,2), "error": str(e)[:200]}
    def close(self):
        if self.drv: self.drv.close()

class CogneeSearcher:
    def __init__(self):
        self.user = None
    async def _init(self):
        if self.user is None: self.user = await get_default_user()
        return self.user
    async def search(self, query: str) -> dict:
        t0 = time.time()
        try:
            u = await self._init()
            cr = await search(query_type=SearchType.CHUNKS, query_text=query, top_k=TOP_K, user=u)
            ctxs = []
            for it in (cr if isinstance(cr,list) else [cr]):
                if isinstance(it,str): ctxs.append(it[:400])
                elif isinstance(it,dict): ctxs.append(str(it.get("text") or it.get("content") or it)[:400])
                else: ctxs.append(str(it)[:400])
            ar = await search(query_type=SearchType.GRAPH_COMPLETION, query_text=query, top_k=TOP_K, user=u)
            ans = "\n".join(str(r) for r in ar) if isinstance(ar,list) else str(ar)
            return {"answer": ans[:3000] if ans else "[EMPTY]", "contexts": ctxs[:10],
                    "elapsed": round(time.time()-t0,2), "error": None}
        except Exception as e:
            return {"answer": f"[ERROR] {e}", "contexts": [],
                    "elapsed": round(time.time()-t0,2), "error": str(e)[:200]}


# ═══════════════════════════════════════════════════════
# (2) Ragas — Evaluator with num_generations=1, serial
# ═══════════════════════════════════════════════════════
def run_ragas(samples: List[dict], label: str):
    valid = [s for s in samples if not s.get("error") and len(s["answer"])>20
             and not s["answer"].startswith("[ERROR]")]
    if not valid: return {"n":0}

    # monkey-patch
    _fv = types.ModuleType("lc_vertexai"); _fv.ChatVertexAI = type("F",(),{})
    _cm = types.ModuleType("lc_chat_models"); _cm.vertexai = _fv
    sys.modules["langchain_community.chat_models.vertexai"] = _fv
    sys.modules["langchain_community.chat_models"] = _cm
    from ragas import evaluate, EvaluationDataset, RunConfig
    from ragas.metrics import Faithfulness,AnswerRelevancy,ContextPrecision,ContextRecall
    from ragas.llms import llm_factory; from ragas.embeddings import OpenAIEmbeddings
    from datasets import Dataset

    judge_llm = llm_factory(f"openai/{JUDGE_MODEL}", client=_cli, max_tokens=4096)
    judge_llm.model = JUDGE_MODEL
    judge_emb = OpenAIEmbeddings(client=_cli, model="text-embedding-v4")
    judge_emb.embed_query = judge_emb.embed_text
    judge_emb.embed_documents = judge_emb.embed_texts

    metrics = [Faithfulness(llm=judge_llm), AnswerRelevancy(llm=judge_llm,embeddings=judge_emb),
               ContextPrecision(llm=judge_llm), ContextRecall(llm=judge_llm)]
    mnames = ["faithfulness","answer_relevancy","context_precision","context_recall"]

    # resume
    done_ids = set()
    per_sample = []
    if RAGAS_CKPT.exists():
        ck = json.loads(RAGAS_CKPT.read_text("utf-8"))
        done_ids = set(ck.get("done_ids",[]))
        per_sample = ck.get("per_sample",[])

    todo = [(i,s) for i,s in enumerate(valid) if s["id"] not in done_ids]
    failed = []

    if todo:
        print(f"    [{label}] Ragas: {len(todo)} to score (batch=10, serial)...", flush=True)
        batch_size = 10
        eval_config = RunConfig(max_workers=1, timeout=120)

        for b_start in range(0, len(todo), batch_size):
            batch = todo[b_start:b_start+batch_size]
            b_data = {k:[valid[i][k] for i,_ in batch] for k in ["question","answer","contexts","ground_truth"]}
            b_ds = Dataset.from_dict(b_data)
            eval_ds = EvaluationDataset.from_hf_dataset(b_ds)

            try:
                result = evaluate(eval_ds, metrics=metrics, run_config=eval_config)
                for j, (orig_i, s) in enumerate(batch):
                    row = {"id": s["id"], "question": s["question"][:60]}
                    for mn in mnames:
                        try: row[mn] = round(float(result[mn][j]),4)
                        except: row[mn] = None
                    per_sample.append(row)
                    done_ids.add(s["id"])
            except Exception as e:
                print(f"      [{label}] batch {b_start//batch_size+1} FAILED: {e}", flush=True)
                for _, s in batch:
                    failed.append({"id": s["id"], "query": s["question"][:80], "error": str(e)[:200]})
                continue

            RAGAS_CKPT.write_text(json.dumps({"done_ids":list(done_ids),"per_sample":per_sample},ensure_ascii=False), "utf-8")
            print(f"      [{label}] batch {b_start//batch_size+1} saved ({len(done_ids)}/{len(valid)})", flush=True)

            if b_start + batch_size < len(todo):
                time.sleep(2)  # (4) 批次间隔

        # (5) save failed for retry
        if failed:
            fail_path = OUTPUT_DIR / "ragas_failed.json"
            fail_path.write_text(json.dumps(failed, ensure_ascii=False, indent=2), "utf-8")
            print(f"    [{label}] {len(failed)} failed samples saved to {fail_path}")
    else:
        print(f"    [{label}] Ragas: all {len(done_ids)} already scored (resume)", flush=True)

    agg = {}
    for mn in mnames:
        vals = [ps[mn] for ps in per_sample if ps.get(mn) is not None]
        agg[mn] = round(sum(vals)/max(len(vals),1),4) if vals else None
    print(f"    [{label}] Ragas done: {agg}")
    return {"n":len(valid), "aggregate":agg, "per_sample":per_sample}


# ═══════════════════════════════════════════════════════
# DeepEval — strict serial
# ═══════════════════════════════════════════════════════
def run_deepeval(samples: List[dict], label: str):
    valid = [s for s in samples if not s.get("error") and len(s["answer"])>20
             and not s["answer"].startswith("[ERROR]")]
    if not valid: return {"n":0}

    from deepeval.metrics import (FaithfulnessMetric,AnswerRelevancyMetric,
        ContextualPrecisionMetric,ContextualRecallMetric,ContextualRelevancyMetric)
    from deepeval.test_case import LLMTestCase

    mnames = ["Faithfulness","AnswerRelevancy","ContextualPrecision","ContextualRecall","ContextualRelevancy"]
    def _mk(): return [FaithfulnessMetric(threshold=0.0,model=JUDGE_MODEL,include_reason=True),
                       AnswerRelevancyMetric(threshold=0.0,model=JUDGE_MODEL,include_reason=True),
                       ContextualPrecisionMetric(threshold=0.0,model=JUDGE_MODEL,include_reason=True),
                       ContextualRecallMetric(threshold=0.0,model=JUDGE_MODEL,include_reason=True),
                       ContextualRelevancyMetric(threshold=0.0,model=JUDGE_MODEL,include_reason=True)]

    done_ids = set()
    per_sample = []
    if DEEPEVAL_CKPT.exists():
        ck = json.loads(DEEPEVAL_CKPT.read_text("utf-8"))
        done_ids = set(ck.get("done_ids",[]))
        per_sample = ck.get("per_sample",[])

    todo = [(i,s) for i,s in enumerate(valid) if s["id"] not in done_ids]
    failed = []

    if todo:
        print(f"    [{label}] DeepEval: {len(todo)} serial...", flush=True)
        for j, (orig_i, s) in enumerate(todo):
            tc = LLMTestCase(input=s["question"], actual_output=s["answer"],
                             expected_output=s["ground_truth"],
                             retrieval_context=s["contexts"] or ["[no context]"])
            row = {"id": s["id"], "question": s["question"][:60]}
            for mn, m in zip(mnames, _mk()):
                try:
                    m.measure(tc, _show_indicator=False)
                    row[mn] = round(m.score,4) if m.score is not None else None
                except Exception as e:
                    row[mn] = None
                    failed.append({"id": s["id"], "metric": mn, "error": str(e)[:200]})
            per_sample.append(row)
            done_ids.add(s["id"])
            if (j+1) % 5 == 0:
                print(f"      [{label}] {j+1}/{len(todo)} done, saving...", flush=True)
                DEEPEVAL_CKPT.write_text(json.dumps({"done_ids":list(done_ids),"per_sample":per_sample},ensure_ascii=False), "utf-8")
                time.sleep(2)
        DEEPEVAL_CKPT.write_text(json.dumps({"done_ids":list(done_ids),"per_sample":per_sample},ensure_ascii=False), "utf-8")
        if failed:
            fail_path = OUTPUT_DIR / "deepeval_failed.json"
            fail_path.write_text(json.dumps(failed, ensure_ascii=False, indent=2), "utf-8")
            print(f"    [{label}] {len(failed)} failed samples saved")
    else:
        print(f"    [{label}] DeepEval: all {len(done_ids)} already scored (resume)", flush=True)

    agg = {}
    for mn in mnames:
        vals = [ps[mn] for ps in per_sample if ps.get(mn) is not None]
        agg[mn] = round(sum(vals)/max(len(vals),1),4) if vals else None
    print(f"    [{label}] DeepEval done: {agg}")
    return {"n":len(valid), "aggregate":agg, "per_sample":per_sample}


# ═══════════════════════════════════════════════════════
# TruLens Triad — 手写 LLM Judge
# ═══════════════════════════════════════════════════════
def run_triad(samples: List[dict], label: str):
    valid = [s for s in samples if not s.get("error") and len(s["answer"])>20
             and not s["answer"].startswith("[ERROR]")]
    if not valid: return {"n":0}

    def _judge(prompt):
        ans = _llm(prompt, max_tokens=256)
        m = re.search(r'"score"\s*:\s*(\d+(?:\.\d+)?)', ans)
        return float(m.group(1))/10.0 if m else 0.5

    done_ids = set()
    per_sample = []
    failed = []
    if TRIAD_CKPT.exists():
        ck = json.loads(TRIAD_CKPT.read_text("utf-8"))
        done_ids = set(ck.get("done_ids",[]))
        per_sample = ck.get("per_sample",[])

    todo = [(i,s) for i,s in enumerate(valid) if s["id"] not in done_ids]
    if todo:
        print(f"    [{label}] Triad: {len(todo)} serial...", flush=True)
        for j, (orig_i, s) in enumerate(todo):
            q = s["question"]; ans = str(s["answer"])[:1500]
            ctx = "\n---\n".join(s.get("contexts",["[no context]"]))[:3000]
            try:
                g  = _judge(f"Score if ANSWER is supported by SOURCE (0-10).\nSOURCE:\n{ctx}\nANSWER:\n{ans}\nJSON: {{\"score\":<0-10>}}")
                cr = _judge(f"Score if CONTEXTS relevant to QUESTION (0-10).\nQUESTION:{q[:500]}\nCONTEXTS:\n{ctx}\nJSON: {{\"score\":<0-10>}}")
                ar = _judge(f"Score if ANSWER addresses QUESTION (0-10).\nQUESTION:{q[:500]}\nANSWER:\n{ans}\nJSON: {{\"score\":<0-10>}}")
                per_sample.append({"id":s["id"],"question":q[:60],
                    "Groundedness":round(g,4),"ContextRelevance":round(cr,4),"AnswerRelevance":round(ar,4)})
            except Exception as e:
                failed.append({"id": s["id"], "error": str(e)[:200]})
                per_sample.append({"id":s["id"],"question":q[:60],
                    "Groundedness":None,"ContextRelevance":None,"AnswerRelevance":None})
            done_ids.add(s["id"])
            if (j+1) % 5 == 0:
                print(f"      [{label}] {j+1}/{len(todo)} done, saving...", flush=True)
                TRIAD_CKPT.write_text(json.dumps({"done_ids":list(done_ids),"per_sample":per_sample},ensure_ascii=False), "utf-8")
                time.sleep(2)
        TRIAD_CKPT.write_text(json.dumps({"done_ids":list(done_ids),"per_sample":per_sample},ensure_ascii=False), "utf-8")
        if failed:
            fail_path = OUTPUT_DIR / "triad_failed.json"
            fail_path.write_text(json.dumps(failed, ensure_ascii=False, indent=2), "utf-8")
            print(f"    [{label}] {len(failed)} failed samples saved")
    else:
        print(f"    [{label}] Triad: all {len(done_ids)} already scored (resume)", flush=True)

    agg = {}
    for col in ["Groundedness","ContextRelevance","AnswerRelevance"]:
        vals = [ps[col] for ps in per_sample if ps.get(col) is not None]
        agg[col] = round(sum(vals)/max(len(vals),1),4) if vals else None
    print(f"    [{label}] Triad done: {agg}")
    return {"n":len(valid), "aggregate":agg, "per_sample":per_sample}


# ═══════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════
async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sample",type=int,default=30)
    p.add_argument("--engine",default="both",choices=["cognee","graphiti","both"])
    p.add_argument("--resume",action="store_true")
    p.add_argument("--skip-phase1",action="store_true")
    p.add_argument("--skip",nargs="*",default=[],choices=["ragas","deepeval","triad"])
    p.add_argument("-o","--output",default=None)
    args = p.parse_args()

    skip = set(args.skip); run_c = args.engine in ("cognee","both"); run_g = args.engine in ("graphiti","both")

    print("="*65)
    print("  EVAL v2 — Optimized Tri-Framework")
    print(f"  Engine: {'Cognee+Graphiti' if run_c and run_g else args.engine}")
    print(f"  Judge: {JUDGE_MODEL}  Rate: {RATE_INTERVAL}s/call")
    print(f"  Cognee: CACHING=true TOP_K={TOP_K} GRAPH_MAX_NODES=200")
    print(f"  LiteLLM: timeout=120 max_retries=1")
    print("="*65)

    gt = json.loads(GROUND_TRUTH.read_text("utf-8"))["queries"][:args.sample]
    os.environ["OPENAI_API_KEY"] = LLM_API_KEY
    os.environ["OPENAI_API_BASE"] = LLM_ENDPOINT

    # Phase 1
    cache = {}
    if CACHE_FILE.exists() and (args.skip_phase1 or args.resume):
        cache = json.loads(CACHE_FILE.read_text("utf-8"))
        print(f"  Loaded cache: {len(cache.get('graphiti',[]))}G + {len(cache.get('cognee',[]))}C")
    else:
        print(f"\n{'─'*55}\n  Phase 1: Collecting\n{'─'*55}")

    g_samples = cache.get("graphiti",[])
    c_samples = cache.get("cognee",[])

    if run_g and not g_samples:
        gs = GraphitiSearcher()
        try:
            for i,q in enumerate(gt):
                r = gs.search(q["query"])
                g_samples.append({"id":q["id"],"question":q["query"],"answer":r["answer"],
                    "contexts":r["contexts"],"ground_truth":q.get("ground_truth_answer",""),
                    "elapsed":r["elapsed"],"error":r.get("error")})
                print(f"  G[{i+1:2d}/{len(gt)}] {q['id']} ({r['elapsed']:.0f}s)")
            cache["graphiti"] = g_samples
            CACHE_FILE.write_text(json.dumps(cache,ensure_ascii=False,indent=2),"utf-8")
        finally: gs.close()

    if run_c and not c_samples:
        cs = CogneeSearcher()
        try:
            for i,q in enumerate(gt):
                r = await cs.search(q["query"])
                c_samples.append({"id":q["id"],"question":q["query"],"answer":r["answer"],
                    "contexts":r["contexts"],"ground_truth":q.get("ground_truth_answer",""),
                    "elapsed":r["elapsed"],"error":r.get("error")})
                print(f"  C[{i+1:2d}/{len(gt)}] {q['id']} ({r['elapsed']:.0f}s)")
            cache["cognee"] = c_samples
            CACHE_FILE.write_text(json.dumps(cache,ensure_ascii=False,indent=2),"utf-8")
        finally: pass

    # Phase 2
    print(f"\n{'─'*55}\n  Phase 2: Evaluation\n{'─'*55}")

    results = {}
    for key, lbl, samples in [("cognee","Cognee (11003)",c_samples),
                               ("graphiti","Graphiti (11001)",g_samples)]:
        if not samples: continue
        print(f"\n  === {lbl} ({len(samples)} queries) ===")
        results[key] = {}
        if "ragas" not in skip:
            results[key]["ragas"] = run_ragas(samples, lbl)
        if "deepeval" not in skip:
            results[key]["deepeval"] = run_deepeval(samples, lbl)
        if "triad" not in skip:
            results[key]["triad"] = run_triad(samples, lbl)

    # Summary
    print(f"\n{'='*65}\n  FINAL SUMMARY\n{'='*65}")
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
    out = Path(args.output) if args.output else OUTPUT_DIR/f"v2_{ts}.json"
    out.write_text(json.dumps({"judge":JUDGE_MODEL,"n":len(gt),"results":results},ensure_ascii=False,indent=2),"utf-8")
    print(f"\n  Report: {out}")

if __name__ == "__main__":
    asyncio.run(main())
