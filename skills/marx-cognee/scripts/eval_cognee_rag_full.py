"""
Cognee RAG full evaluation v4.1 — check-pointing + adaptive timeouts.
Each Phase writes to eval/.eval_checkpoint_v4.json so that a crash / timeout
never loses completed work.  Rerun and it picks up where it left off.
"""
import asyncio, os, time, json, re, sys
from pathlib import Path

os.chdir("%USERPROFILE%/cognee")
import dotenv; dotenv.load_dotenv(override=True)

from cognee.api.v1.search import search, SearchType
from cognee.api.v1.datasets.datasets import datasets as ds
from cognee.modules.users.methods import get_default_user

GROUND_TRUTH = Path("eval/ground_truth_30q.json")
RESULTS     = Path("eval/eval_results_full_v4.json")
CHECKPOINT  = Path("eval/.eval_checkpoint_v4.json")
SMOKE_TO    = 180.0
FULL_TO     = 420.0
TOP_K       = 10

EVAL_QUERIES = [
    ("资本下乡对乡村治理有什么影响", "乡村治理 权力关系", "hard"),
    ("农地流转中农户权益如何保障", "土地流转 农户权益", "medium"),
    ("工商资本进入农业领域有哪些模式", "投资模式 产业类型", "easy"),
    ("土地流转违约风险的原因和后果", "违约 风险 治理", "hard"),
    ("资本下乡中的政府角色", "政府 政策 监管", "easy"),
    ("龙头企业与合作社的关系", "企业 合作社 合作", "medium"),
    ("资本下乡对农民收入的影响", "收入 就业 福利", "medium"),
    ("精准扶贫与资本下乡的关联", "扶贫 政策 资本", "medium"),
    ("农村土地制度改革对资本下乡的促进", "土地制度 改革", "hard"),
    ("资本下乡失败案例的共同特征", "失败 风险 治理", "hard"),
]
SEARCH_TYPES = [SearchType.HYBRID_COMPLETION, SearchType.GRAPH_COMPLETION,
                SearchType.GRAPH_COMPLETION_COT, SearchType.GRAPH_COMPLETION_DECOMPOSITION,
                SearchType.CHUNKS, SearchType.TRIPLET_COMPLETION]
P2_TYPES = [SearchType.HYBRID_COMPLETION, SearchType.GRAPH_COMPLETION, SearchType.GRAPH_COMPLETION_COT]

def fmt(s): return f"{s*1000:.0f}ms" if s<1 else f"{s:.1f}s"

# ── checkpoint helpers ────────────────────────────────

def load_cp():
    if CHECKPOINT.exists():
        try: return json.loads(CHECKPOINT.read_text(encoding="utf-8"))
        except: pass
    return {}

def save_cp(data):
    CHECKPOINT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

# ── LLM Judge ─────────────────────────────────────────

async def llm_judge(query, gt_answer, candidate_answer, gt_entities, candidate_entities):
    import httpx; from openai import OpenAI
    ep = os.getenv("LLM_ENDPOINT",""); ak = os.getenv("LLM_API_KEY","")
    # litellm expects "openai/qwen-plus" but DashScope compatible-mode needs "qwen-plus"
    raw_md = os.getenv("LLM_MODEL","openai/qwen-plus")
    md = raw_md.replace("openai/", "") if raw_md.startswith("openai/") else raw_md
    cl = OpenAI(base_url=ep, api_key=ak, http_client=httpx.Client(timeout=60))
    ce = ", ".join(str(e)[:60] for e in (candidate_entities or [])[:20])
    ca = str(candidate_answer)[:1500]
    prompt = f"""RAG system evaluation.
Question: {query}
Ground truth: {gt_answer}
Expected entities: {', '.join(gt_entities)}
Candidate entities: {ce}
Candidate answer: {ca}

Output ONLY JSON (no text):
{{"correctness": 0.X, "completeness": 0.X, "faithfulness": 0.X, "entity_recall": 0.X}}"""
    try:
        r = cl.chat.completions.create(model=md, messages=[{"role":"user","content":prompt}], temperature=0, max_tokens=256)
        raw = r.choices[0].message.content.strip()
        m = re.search(r"\{[^}]+\}", raw)
        if m: return json.loads(m.group())
    except: pass
    return {"correctness":0,"completeness":0,"faithfulness":0,"entity_recall":0}

# ── retrieval metrics ─────────────────────────────────

def retrieval_metrics(results_batch, expected_batch, k=10):
    """Compute Recall@K, Precision@K, MRR against expected entities.

    GRAPH_COMPLETION / TRIPLET_COMPLETION return **str** (LLM answer text).
    CHUNKS returns **list[dict]** whose ``text`` or ``name`` keys carry content.
    We check whether each expected entity keyword appears in any result.
    """
    hits, mrr = [], 0.0
    for results, exp in zip(results_batch, expected_batch):
        el = set(e.lower() for e in exp)
        found_entities: set[str] = set()
        rank: int = 0
        if isinstance(results, list):
            for j, r in enumerate(results[:k]):
                combined = ""
                # ── string result (GRAPH / TRIPLET answer text) ──
                if isinstance(r, str):
                    combined = r.lower()
                # ── dict result (CHUNKS) ──
                elif isinstance(r, dict):
                    combined = " ".join(
                        str(v).lower()
                        for kk, v in r.items()
                        if v is not None and kk in ("text", "name", "id", "document_name")
                    )
                # ── object with attributes ──
                elif hasattr(r, "__dict__"):
                    d = r.__dict__
                    parts = []
                    for key in ("name", "text", "description", "relationship_name",
                                "edge_text", "from_node_id", "to_node_id"):
                        val = d.get(key, "")
                        if val:
                            parts.append(str(val))
                    combined = " ".join(p.lower() for p in parts)
                # ── pure string fallback ──
                elif hasattr(r, "__str__"):
                    combined = str(r).lower()

                for e in el:
                    if e in combined and e not in found_entities:
                        found_entities.add(e)
                        if rank == 0:
                            rank = j + 1

        hits.append(len(found_entities) / max(len(el), 1))
        mrr += 1.0 / rank if rank else 0.0

    n = max(len(hits), 1)
    return {
        f"Recall@{k}": round(sum(hits) / n, 4),
        f"Precision@{k}": round(sum(hits) / (n * k), 4),
        "MRR": round(mrr / n, 4),
    }

# ── main ───────────────────────────────────────────────

async def main():
    print("="*70); print("COGNEE RAG v4.1 (check-pointing)"); print("="*70)
    gt_data = json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))
    gt_queries = gt_data["queries"]
    print(f"\nGround truth: {len(gt_queries)} queries")

    user = await get_default_user()
    all_ds = await ds.list_datasets(user=user)
    test_ds = ["capital_batch_000"] if any("capital_batch_000" in d.name for d in all_ds) else [d.name for d in all_ds if "batch" in d.name.lower()][:1]
    if not test_ds or not test_ds[0]: test_ds = [all_ds[0].name]
    print(f"Target: {test_ds}")

    cp = load_cp()

    # ═══ Phase 1: smoke ═══
    if "phase1" not in cp:
        print(f"\n{'─'*70}\nPhase 1: smoke ({EVAL_QUERIES[0][0]})\n{'─'*70}")
        p1 = []
        for st in SEARCH_TYPES:
            nm = st.value; t0 = time.time()
            to = 420.0 if "COT" in nm.upper() else SMOKE_TO
            try:
                r = await asyncio.wait_for(search(EVAL_QUERIES[0][0], query_type=st, datasets=test_ds, top_k=5), timeout=to)
                e = time.time()-t0; rl = len(r) if isinstance(r,(list,str)) else 0
                p1.append({"type":nm,"elapsed":e,"len":rl,"err":None})
                print(f"  {nm:36s} {fmt(e):>8s}  len={rl}")
            except Exception as ex:
                e = time.time()-t0
                p1.append({"type":nm,"elapsed":e,"len":0,"err":str(ex)[:80]})
                print(f"  {nm:36s} {fmt(e):>8s}  ERR: {type(ex).__name__}")
        cp["phase1"] = p1
        save_cp(cp)
    else:
        p1 = cp["phase1"]
        print(f"\nPhase 1: restored ({len(p1)} types)")

    # ═══ Phase 2: multi-query ═══
    if "phase2_results" not in cp:
        print(f"\n{'─'*70}\nPhase 2: {len(gt_queries)}q x 3 types\n{'─'*70}")
        p2_res = []; p2_ok = 0; p2_tot = 0
        for qd in gt_queries:
            q = qd["query"]; ok = 0
            for st in P2_TYPES:
                try:
                    r = await asyncio.wait_for(search(q, query_type=st, datasets=test_ds, top_k=TOP_K), timeout=FULL_TO)
                    p2_res.append({"query":q,"type":st.value,"result":r}); ok+=1
                except: p2_res.append({"query":q,"type":st.value,"result":None})
            p2_tot+=3; p2_ok+=ok
            print(f"  [{qd.get('difficulty','medium'):6s}] {q[:45]:45s} {ok}/3")
        cp["phase2_results"]=p2_res; cp["phase2_ok"]=p2_ok; cp["phase2_tot"]=p2_tot
        save_cp(cp)
    else:
        p2_res=cp["phase2_results"]; p2_ok=cp["phase2_ok"]; p2_tot=cp["phase2_tot"]
        print(f"\nPhase 2: restored ({p2_ok}/{p2_tot})")

    # ═══ Phase 3: speed ═══
    if "phase3_timings" not in cp:
        print(f"\n{'─'*70}\nPhase 3: speed (5 runs)\n{'─'*70}")
        tms = []
        for i in range(5):
            t0=time.time()
            try:
                r = await asyncio.wait_for(search("工商资本进入农业", query_type=SearchType.HYBRID_COMPLETION, datasets=test_ds, top_k=5), timeout=60)
                dt=time.time()-t0; tms.append(dt); print(f"  Run {i+1}: {fmt(dt)}")
            except Exception as e: dt=time.time()-t0; print(f"  Run {i+1}: {fmt(dt)} ERR {type(e).__name__}")
        cp["phase3_timings"]=tms
        save_cp(cp)
    else:
        tms=cp["phase3_timings"]; print(f"\nPhase 3: restored ({len(tms)} runs)")

    # ═══ Phase 4: judge ═══
    if "phase4_judge" not in cp:
        print(f"\n{'─'*70}\nPhase 4: LLM Judge + retrieval\n{'─'*70}")
        j_scores, r_res, r_exp = [], [], []
        for qd in gt_queries:
            q = qd["query"]; ga = qd["ground_truth_answer"]; ge = qd["expected_entities"]
            candidate = None
            for r in p2_res:
                if r["query"]==q and r["type"]=="HYBRID_COMPLETION": candidate=r.get("result"); break
            ca_raw = candidate if isinstance(candidate,list) else []
            ce = [getattr(x,"name","") or str(x)[:100] for x in (ca_raw or [])[:TOP_K]]
            ca_txt = str(candidate)[:2000] if candidate else ""
            score = await llm_judge(q,ga,ca_txt,ge,ce) if ca_txt else {"correctness":0,"completeness":0,"faithfulness":0,"entity_recall":0}
            score["query"]=q[:40]; j_scores.append(score)
            print(f"  Judge: {q[:30]:30s} | c={score.get('correctness',0):.2f} comp={score.get('completeness',0):.2f} faith={score.get('faithfulness',0):.2f} er={score.get('entity_recall',0):.2f}")
            r_res.append(ca_raw); r_exp.append(ge)
            cp["phase4_judge"]=j_scores; cp["phase4_results"]=r_res; cp["phase4_expected"]=r_exp
            save_cp(cp)
    else:
        j_scores=cp["phase4_judge"]; r_res=cp["phase4_results"]; r_exp=cp["phase4_expected"]
        print(f"\nPhase 4: restored ({len(j_scores)} judged)")

    # ═══ Summary ═══
    print(f"\n{'='*70}\nSummary\n{'='*70}")
    p1_ok = sum(1 for r in p1 if r["err"] is None)
    print(f"\nPhase 1: {p1_ok}/{len(p1)}")
    for r in p1:
        s = "OK" if r["err"] is None else f"ERR: {r['err'][:50]}"
        print(f"  {r['type']:40s} {fmt(r['elapsed']):>8s}  {s}")
    print(f"\nPhase 2: {p2_ok}/{p2_tot} ({100*p2_ok//p2_tot}%)")
    if tms: print(f"\nPhase 3: avg={fmt(sum(tms)/len(tms))} min={fmt(min(tms))} max={fmt(max(tms))}")
    ce = sum(1 for r in p1 if r.get("err") and ("connect" in str(r["err"]).lower() or "timeout" in str(r["err"]).lower()))
    print(f"\nConnection errors: {ce}/6"); print("Stability: PASS" if ce==0 else "")

    rm = retrieval_metrics(r_res, r_exp, k=TOP_K)
    print(f"\nPhase 4 Retrieval:"); [print(f"  {k}: {v}") for k,v in rm.items()]
    if j_scores:
        n=len(j_scores); ac=sum(s.get("correctness",0) for s in j_scores)/n
        acp=sum(s.get("completeness",0) for s in j_scores)/n
        af=sum(s.get("faithfulness",0) for s in j_scores)/n
        ae=sum(s.get("entity_recall",0) for s in j_scores)/n
        print(f"\nLLM Judge (avg {n}): Correctness={ac:.4f} Completeness={acp:.4f} Faithfulness={af:.4f} EntityRecall={ae:.4f}")

    report = {"version":"4.1","timestamp":time.strftime("%Y-%m-%dT%H:%M:%S"),
              "phase1":[{"type":r["type"],"elapsed":r["elapsed"],"len":r["len"],"error":r["err"]} for r in p1],
              "phase2":{"total":p2_tot,"ok":p2_ok,"rate":p2_ok/max(p2_tot,1)},
              "phase3":{"timings":tms,"avg":sum(tms)/len(tms) if tms else None},
              "phase4":{"retrieval":rm,"judge_avg":{"correctness":ac if j_scores else 0,"completeness":acp if j_scores else 0,"faithfulness":af if j_scores else 0,"entity_recall":ae if j_scores else 0},"judge_details":j_scores}}
    RESULTS.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    CHECKPOINT.unlink(missing_ok=True)
    print(f"\nSaved: {RESULTS}")
    print(f"\n{'='*70}\nDone\n{'='*70}")

if __name__ == "__main__":
    asyncio.run(main())
