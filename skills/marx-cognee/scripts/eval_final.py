"""Step 4: Final 5-dim eval — GRAPH_COMPLETION + raw text + verify=OFF + expanded synonyms.
Fresh: clears cache before each run, uses timestamp suffix to bust cache.
"""
import asyncio, json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, ".")
import dotenv; dotenv.load_dotenv(override=True)
os.environ["ENABLE_RAW_TEXT_AUGMENT"] = "true"

from cognee.api.v1.search import search, SearchType
from cognee.modules.users.methods import get_default_user

GROUND_TRUTH = Path("eval/ground_truth_30q.json")
OUTPUT = Path("eval/eval_results_final.json")
CHECKPOINT = Path("eval/.eval_checkpoint_final.json")
BASELINES = {
    "HYBRID (v5.1)": Path("eval/eval_results_5dim_v5.json"),
    "Step1 (GRAPH+raw)": Path("eval/eval_results_step1_rawtext.json"),
    "Step2 (+verify)": Path("eval/eval_results_step2_verify_on.json"),
}

TOP_K = 10; TIMEOUT = 180.0

def load_cp():
    if CHECKPOINT.exists():
        try: return json.loads(CHECKPOINT.read_text(encoding="utf-8"))
        except: pass
    return {}
def save_cp(d): CHECKPOINT.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")

async def j5(q, ga, ca, ge):
    import httpx; from openai import OpenAI
    ep = os.getenv("LLM_ENDPOINT",""); ak = os.getenv("LLM_API_KEY","")
    md = os.getenv("LLM_MODEL","openai/qwen-plus").replace("openai/","")
    cl = OpenAI(base_url=ep, api_key=ak, http_client=httpx.Client(timeout=120))
    prompt = f"""RAG多维度评估（0-1分）。
问题：{q}
标准答案：{str(ga)[:2000]}
期望实体：{', '.join(str(e)[:40] for e in (ge or [])[:15])}
候选回答：{str(ca)[:2500]}
评分：1.Faithfulness 2.Relevance 3.Completeness 4.Attribution 5.Overall
只输出JSON：{{"faithfulness":0.X,"relevance":0.X,"completeness":0.X,"attribution":0.X,"overall":0.X,"note":"一句话"}}"""
    try:
        r = cl.chat.completions.create(model=md, messages=[{"role":"user","content":prompt}], temperature=0, max_tokens=300)
        raw = r.choices[0].message.content.strip(); m = re.search(r"\{[^}]+\}", raw)
        if m:
            s = json.loads(m.group())
            for k in ["faithfulness","relevance","completeness","attribution","overall"]: s.setdefault(k,0.0)
            return s
    except: pass
    return {"faithfulness":0,"relevance":0,"completeness":0,"attribution":0,"overall":0,"note":"judge failed"}

async def main():
    print("="*70); print("Step 4: Final 5-dim Eval (all fixes active)"); print("="*70)
    gt = json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))
    gq = gt["queries"]; user = await get_default_user(); cp = load_cp()

    if "c" not in cp:
        # Clear cache to ensure fresh Neo4j chunk searches
        try:
            import sqlite3
            conn = sqlite3.connect('cognee/.cognee_system/databases/cache.db')
            conn.execute("DELETE FROM cache_kv WHERE key LIKE 'query_result:%'")
            conn.commit(); conn.close()
            print('Cache cleared for fresh retrieval.')
        except Exception: pass

        print(f"\nCollecting {len(gq)} answers (GRAPH+raw+synonyms)...")
        coll = []
        for i, qd in enumerate(gq):
            q = qd["query"]; t0 = time.time()
            try:
                r = await asyncio.wait_for(search(query_text=q, query_type=SearchType.GRAPH_COMPLETION, datasets=["capital_batch_000"], top_k=TOP_K), timeout=TIMEOUT)
                coll.append({"query":q,"answer":str(r)[:4000],"elapsed":round(time.time()-t0,2),"error":None})
                print(f"  [{i+1:2d}/30] {time.time()-t0:.0f}s {q[:35]}")
            except Exception as e:
                coll.append({"query":q,"answer":f"[ERROR] {e}","elapsed":0,"error":str(e)[:200]})
                print(f"  [{i+1:2d}/30] ERR {type(e).__name__}")
        cp["c"]=coll; save_cp(cp)
    else: coll=cp["c"]; print(f"\nRestored {len(coll)} answers")

    if "j" not in cp:
        print(f"\nJudging..."); judged=[]
        for row, qd in zip(coll, gq):
            if not row.get("error"): s=await j5(row["query"], qd.get("ground_truth_answer",""), row.get("answer",""), qd.get("expected_entities",[]))
            else: s={"faithfulness":0,"relevance":0,"completeness":0,"attribution":0,"overall":0,"note":"error"}
            s["elapsed"]=row.get("elapsed",0); s["query"]=row["query"][:50]; s["difficulty"]=qd.get("difficulty","medium"); judged.append(s)
            print(f"  [{len(judged):2d}/30] F={s['faithfulness']:.2f} R={s['relevance']:.2f} C={s['completeness']:.2f} A={s['attribution']:.2f} O={s['overall']:.2f}")
        cp["j"]=judged; save_cp(cp)
    else: judged=cp["j"]; print(f"\nRestored {len(judged)} judged")

    dims = ["faithfulness","relevance","completeness","attribution","overall"]
    cur = {d: round(sum(j.get(d,0) for j in judged)/max(len(judged),1), 4) for d in dims}

    # Load all baselines
    bls = {}
    for name, path in BASELINES.items():
        if path.exists():
            bls[name] = json.loads(path.read_text(encoding="utf-8")).get("summary", {})

    print(f"\n{'='*70}")
    print(f"FINAL COMPARISON TABLE (30 queries)")
    header = f"{'Dimension':15s}"
    for name in bls: header += f" | {name:>20s}"
    header += f" | {'Step4 (final)':>20s}"
    print(header); print("-"*len(header))
    for d in dims:
        row = f"  {d:15s}"
        for name in bls: row += f" | {bls[name].get(d,0):20.4f}"
        row += f" | {cur.get(d,0):20.4f}"
        print(row)

    report = {"timestamp":time.strftime("%Y-%m-%dT%H:%M:%S"),"summary":cur,"baselines":bls,"details":judged}
    OUTPUT.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    CHECKPOINT.unlink(missing_ok=True); print(f"\nSaved: {OUTPUT}")

if __name__=="__main__": asyncio.run(main())
