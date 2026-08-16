#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
稳健单文献蒸馏脚本 — 绕过模块4的脆弱文件读取和cypher语法问题
每篇: read 4 files → DeepSeek V4 Pro → CREATE distill node → link entity → vectorize
"""
import sys, json, time
from pathlib import Path
sys.path.insert(0, r"D:\Desktop\执行流程")

from pipeline import Neo4jConnection, DeepSeekClient, QwenEmbeddingClient

nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
ds = DeepSeekClient()
emb = QwenEmbeddingClient()

BASE_DIR = Path(r"D:\Desktop\ov_import")
CP_FILE = Path(r"D:\Desktop\执行流程\.checkpoints\module4_distill_state.json")
CP_FILE.parent.mkdir(parents=True, exist_ok=True)


def read_paper(folder):
    """Match files by content pattern, not by exact filename"""
    texts = {"abstract": "", "term": "", "qa": "", "original": ""}
    for f in folder.glob("*.md"):
        n = f.name
        if "摘要" in n or "摘" in n:
            texts["abstract"] = f.read_text(encoding="utf-8")
        elif "术语" in n:
            texts["term"] = f.read_text(encoding="utf-8")
        elif "问答" in n or "問答" in n or "问" in n:
            texts["qa"] = f.read_text(encoding="utf-8")
        elif "original" in n.lower():
            texts["original"] = f.read_text(encoding="utf-8")
        elif not any(k in n for k in ["摘要","术语","问答","original"]):
            if not texts["original"]:
                texts["original"] = f.read_text(encoding="utf-8")
    return texts


def distill_one(folder):
    fname = folder.name
    texts = read_paper(folder)
    if not texts["abstract"].strip() or not texts["term"].strip():
        return None, "missing core files"

    # Build prompt
    prompt = (
        "你是马克思主义理论、哲学、社会科学领域的资深学者，请对以下文献进行深度知识蒸馏。\n\n"
        f"文献名: {fname}\n"
        f"摘要: {texts['abstract'][:1000]}\n"
        f"术语: {texts['term'][:1500]}\n"
        f"问答: {texts['qa'][:1500]}\n"
        f"原文: {texts['original'][:8000]}\n\n"
        "输出五层JSON（直接输出JSON，不要额外文字）:\n"
        '{"core_concept_definition": [{"concept_name": "...", "concept_alias": [], '
        '"concept_connotation": "...", "concept_boundary": "...", "source_paragraph": "..."}], '
        '"theoretical_system_and_innovation": {"rely_on_theory": [], "inherit_theory": [], '
        '"sublate_theory": [], "innovation_point": []}, '
        '"analysis_paradigm_and_interpretation": {"research_perspective": "", '
        '"analysis_framework": "", "demonstration_method": "", "interpretation_path": ""}, '
        '"dialectical_logic_chain": [{"theory_subject_a": "...", "theory_subject_b": "...", '
        '"logic_relation_type": "继承/扬弃/超越/批判", "causal_background": "...", '
        '"dialectical_content": "...", "source_paragraph": "..."}], '
        '"theoretical_limitation_and_expansion": {"interpretation_deficiency": "", '
        '"academic_controversy_unresolved": "", "future_theoretical_deepening": "", '
        '"future_practical_extension": ""}}\n\n'
        "规则: 禁用理工科词汇。所有字段必填，空值填空数组[]或空字符串\"\"。"
    )

    r = ds.call_json(prompt, max_retries=1, timeout=180)
    if r is None:
        return None, "deepseek returned None"

    # Create distill node via simple parameterized query
    distill_id = f"distill_{fname}_{int(time.time())}"
    nc.execute_write(
        """CREATE (ld:LiteratureDistill)
           SET ld.id = $id, ld.source_folder = $f,
               ld.core_concept_definition = $ccd,
               ld.theoretical_system_and_innovation = $tsi,
               ld.analysis_paradigm_and_interpretation = $api,
               ld.dialectical_logic_chain = $dlc,
               ld.theoretical_limitation_and_expansion = $tle,
               ld.vectorized = false, ld.created_at = datetime()""",
        {
            "id": distill_id, "f": fname,
            "ccd": json.dumps(r.get("core_concept_definition", []), ensure_ascii=False),
            "tsi": json.dumps(r.get("theoretical_system_and_innovation", {}), ensure_ascii=False),
            "api": json.dumps(r.get("analysis_paradigm_and_interpretation", {}), ensure_ascii=False),
            "dlc": json.dumps(r.get("dialectical_logic_chain", []), ensure_ascii=False),
            "tle": json.dumps(r.get("theoretical_limitation_and_expansion", {}), ensure_ascii=False),
        }
    )

    # Link to Episode
    nc.execute_write(
        "MATCH (ep:Episode {source_folder: $f}) "
        "MATCH (ld:LiteratureDistill {id: $id}) "
        "MERGE (ld)-[:DISTILL_FROM]->(ep)",
        {"f": fname, "id": distill_id}
    )

    # Link to entities
    cnames = [c.get("concept_name", "") for c in r.get("core_concept_definition", [])]
    aliases = [a for c in r.get("core_concept_definition", []) for a in c.get("concept_alias", [])]
    all_names = set(cnames + aliases)
    linked = 0
    for cn in all_names:
        if cn:
            try:
                nc.execute_write(
                    "MATCH (e:Entity) WHERE e.name = $cn OR $cn IN e.aliases "
                    "MATCH (ld:LiteratureDistill {id: $id}) "
                    "MERGE (ld)-[:CORRESPONDS_TO]->(e)",
                    {"cn": cn, "id": distill_id}
                )
                linked += 1
            except Exception:
                pass

    # Vectorize
    dt = f"core: {cnames[:10]} theory: {r.get('theoretical_system_and_innovation',{}).get('rely_on_theory',[])}"
    vec = emb.embed(dt)
    if vec:
        nc.execute_write(
            "MATCH (ld:LiteratureDistill {id: $id}) "
            "SET ld.distill_vector = $v, ld.vectorized = true",
            {"id": distill_id, "v": json.dumps(vec)}
        )

    concepts = len(cnames)
    chains = len(r.get("dialectical_logic_chain", []))
    return {"id": distill_id, "concepts": concepts, "chains": chains, "linked": linked, "vectorized": bool(vec)}, None


# ── Main ──
def _scan_papers(base: Path) -> list[Path]:
    """V96: 递归扫描 — 支持 ov_import 顶层分类目录结构"""
    papers = []
    if not base.exists(): return papers
    for entry in sorted(base.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."): continue
        if list(entry.glob("*.original.md")) and not any(x.is_dir() for x in entry.iterdir()):
            papers.append(entry)
        else:
            for sub in sorted(entry.iterdir()):
                if sub.is_dir() and not sub.name.startswith("."):
                    if list(sub.glob("*.original.md")):
                        papers.append(sub)
    return papers

folders = _scan_papers(BASE_DIR)

# Checkpoint
loaded = set()
if CP_FILE.exists():
    loaded = set(json.loads(CP_FILE.read_text(encoding="utf-8")).get("processed_folders", []))
db_done = nc.execute_query("MATCH (ld:LiteratureDistill) RETURN ld.source_folder AS f")
processed = loaded | set(r["f"] for r in db_done)

pending = [f for f in folders if f.name not in processed]
total = len(folders)
done_count = len(processed)
print(f"Total: {total} | Done: {done_count} | Pending: {len(pending)}")

if not pending:
    print("ALL DONE!")
    nc.close()
    sys.exit(0)

start_time = time.time()
success = done_count
for i, folder in enumerate(pending):
    p_start = time.time()
    fname = folder.name
    print(f"[{i+1}/{len(pending)}] {fname[:60]}", end=" ", flush=True)

    result, error = distill_one(folder)

    if result:
        elapsed = time.time() - p_start
        print(f"OK ({elapsed:.0f}s) | concepts={result['concepts']} linked={result['linked']}", flush=True)
        processed.add(fname)
        success += 1
        # Save checkpoint
        data = {"processed_folders": sorted(processed)}
        CP_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        elapsed = time.time() - p_start
        print(f"SKIP ({elapsed:.0f}s) | {error}", flush=True)

    # ETA every 10 papers
    if (i + 1) % 10 == 0:
        elapsed = (time.time() - start_time) / 60
        remaining = len(pending) - (i + 1)
        avg = elapsed / (i + 1)
        eta = remaining * avg
        print(f"  --- Progress: {success}/{total} ({100*success/total:.1f}%) | {elapsed:.0f}min elapsed | ~{eta:.0f}min remaining ---", flush=True)

total_elapsed = (time.time() - start_time) / 60
final_total = nc.execute_query("MATCH (ld:LiteratureDistill) RETURN COUNT(ld) AS total")[0]["total"]
print(f"\nDONE: {success}/{total} | Time: {total_elapsed:.0f}min | Distill nodes: {final_total}")
nc.close()
