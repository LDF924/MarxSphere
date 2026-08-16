import os
"""V96: 一键三库联动入库编排器 — ov_import 新增文献 → 三库同步
流程:
  Step 1: 扫描 ov_import → 检测新增/变更论文
  Step 2: 重建 paper_id_map.json (保留 gold 稳定 id)
  Step 3: Cognee 增量入库 (add + cognify)
  Step 4: Graphiti chunk 入库 (module_chunk_v2.py)
  Step 5: Graphiti 实体抽取 (batch_extract_full.py)
  Step 6: Graphiti 蒸馏 (distill_robust.py)
  Step 7: 完整性校验 (三库覆盖度 + 差异清单)

用法:
  python scripts/orchestrate_ingest.py --scan        # 只检测
  python scripts/orchestrate_ingest.py --map         # 扫描+重建 map
  python scripts/orchestrate_ingest.py --cognee      # 触发 Cognee 入库
  python scripts/orchestrate_ingest.py --chunk       # Graphiti chunk
  python scripts/orchestrate_ingest.py --extract     # Graphiti 实体抽取
  python scripts/orchestrate_ingest.py --distill     # Graphiti 蒸馏
  python scripts/orchestrate_ingest.py --hyperedge   # Graphiti 超边抽取 (V166+)
  python scripts/orchestrate_ingest.py --graphiti    # chunk+extract+distill+hyperedge
  python scripts/orchestrate_ingest.py --verify      # 三库完整性校验
  python scripts/orchestrate_ingest.py --all         # 全流程
"""
import argparse, json, subprocess, sys
from pathlib import Path

OV_IMPORT = Path(r"D:\Desktop\ov_import")
MAP_PATH = Path(Path(os.environ.get('SAG_ROOT', '.')) / 'paper_id_map.json')
GOLD_PATH = Path(Path(os.environ.get('SAG_ROOT', '.')) / 'gold_dataset.json')
PY = os.environ.get('COGNEE_PYTHON', 'python')
MAP_SCRIPT = str(Path(os.environ.get('SAG_ROOT', '.')) / 'scripts' / 'rebuild_paper_id_map.py')
GRAPHITI_ROOT = os.environ.get('GRAPHITI_SKILL_DIR', '')
GRAPHITI_CHUNK = GRAPHITI_ROOT + r"\scripts\module_chunk_v2.py"
GRAPHITI_EXTRACT = GRAPHITI_ROOT + r"\scripts\batch_extract_full.py"
GRAPHITI_DISTILL = GRAPHITI_ROOT + r"\scripts\distill_robust.py"
GRAPHITI_HYPEREDGE = GRAPHITI_ROOT + r"\scripts\batch_hyperedge_extract.py"
COGNEE_INGEST = os.environ.get('COGNEE_INGEST_SCRIPT', '')


def scan_papers(base: Path) -> list[Path]:
    papers = []
    if not base.exists(): return papers
    for entry in sorted(base.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."): continue
        if list(entry.glob("*.original.md")):
            papers.append(entry)
        else:
            for sub in sorted(entry.iterdir()):
                if sub.is_dir() and not sub.name.startswith("."):
                    if list(sub.glob("*.original.md")):
                        papers.append(sub)
    return papers


def run_script(label: str, script: str, env_extra: dict | None = None, timeout: int = 7200) -> bool:
    print(f"\n===== {label} =====")
    env = {"PYTHONPATH": GRAPHITI_ROOT} if env_extra is None else {**{"PYTHONPATH": GRAPHITI_ROOT}, **env_extra}
    try:
        r = subprocess.run([PY, script], capture_output=True, text=True, env=env, timeout=timeout)
        print(r.stdout[-2500:] if r.stdout else "")
        if r.returncode != 0:
            print(f"[ERROR] {label} failed rc={r.returncode}")
            print(r.stderr[-1000:] if r.stderr else "")
            return False
        return True
    except subprocess.TimeoutExpired:
        print(f"[TIMEOUT] {label} exceeded {timeout}s — 检查后台进程")
        return False


def step1_scan():
    papers = scan_papers(OV_IMPORT)
    print(f"[1] 扫描 ov_import: {len(papers)} 篇")
    map_data = json.loads(MAP_PATH.read_text(encoding="utf-8")) if MAP_PATH.exists() else {}
    map_titles = {v.get("title", "") for v in map_data.values()}
    paper_names = {p.name for p in papers}
    new_papers = paper_names - map_titles
    print(f"    map 现有: {len(map_data)}, 新增论文: {len(new_papers)}")
    for n in sorted(new_papers):
        print(f"      + {n[:60]}")
    return len(new_papers)


def step2_map():
    print("[2] 重建 paper_id_map.json")
    r = subprocess.run([PY, MAP_SCRIPT], capture_output=True, text=True)
    print(r.stdout)
    if r.returncode != 0:
        print(r.stderr)
        sys.exit(1)


def step3_cognee():
    run_script("[3] Cognee 增量入库", COGNEE_INGEST)


def step4_chunk():
    run_script("[4] Graphiti chunk", GRAPHITI_CHUNK)


def step5_extract():
    run_script("[5] Graphiti 实体抽取", GRAPHITI_EXTRACT)


def step6_distill():
    run_script("[6] Graphiti 蒸馏", GRAPHITI_DISTILL, env_extra={"PYTHONPATH": r"D:\Desktop\执行流程"})


def step8_hyperedge():
    """V166+: Graphiti 结构化超边抽取（知识片段层，超越HyperGraphRAG）"""
    run_script("[8] Graphiti 超边抽取", GRAPHITI_HYPEREDGE, env_extra={"PYTHONPATH": GRAPHITI_ROOT + ";" + GRAPHITI_ROOT + r"\scripts"})


def step7_verify():
    print("\n[7] 三库完整性校验")
    import neo4j
    papers = scan_papers(OV_IMPORT)
    paper_names = {p.name for p in papers}
    print(f"    磁盘论文: {len(paper_names)}")

    # Graphiti
    g = neo4j.GraphDatabase.driver("bolt://127.0.0.1:11001", auth=("neo4j", os.environ.get("NEO4J_PASSWORD", "neo4j123")))
    with g.session() as s:
        ep = s.run("MATCH (e:Episode) RETURN count(e) AS c").single()["c"]
        ch = s.run("MATCH (c:Chunk) RETURN count(c) AS c").single()["c"]
        ent = s.run("MATCH (e:Entity) RETURN count(e) AS c").single()["c"]
        dis = s.run("MATCH (d:LiteratureDistill) RETURN count(d) AS c").single()["c"]
        # 覆盖度: 有 chunk 的论文
        ch_papers = s.run("MATCH (c:Chunk)-[:CHUNK_OF]->(e:Episode) RETURN count(DISTINCT e.source_folder) AS c").single()["c"]
        ent_papers = s.run("MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode) RETURN count(DISTINCT ep.source_folder) AS c").single()["c"]
        dis_papers = s.run("MATCH (d:LiteratureDistill)-[:DISTILL_FROM]->(ep:Episode) RETURN count(DISTINCT ep.source_folder) AS c").single()["c"]
    g.close()
    print(f"    Graphiti: {ep} Episode, {ch} Chunk, {ent} Entity, {dis} Distill")
    print(f"      覆盖: chunk {ch_papers}/{len(paper_names)}, 实体 {ent_papers}/{len(paper_names)}, 蒸馏 {dis_papers}/{len(paper_names)}")

    # Cognee
    c = neo4j.GraphDatabase.driver("bolt://127.0.0.1:11003", auth=("neo4j", os.environ.get("NEO4J_PASSWORD", "neo4j123")))
    with c.session() as s:
        dc = s.run("MATCH (dc:DocumentChunk) RETURN count(dc) AS c").single()["c"]
        entc = s.run("MATCH (e:Entity) RETURN count(e) AS c").single()["c"]
    c.close()
    print(f"    Cognee:   {dc} DocumentChunk, {entc} Entity")

    # map
    map_data = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    map_titles = {v.get("title", "") for v in map_data.values()}
    missing = {p.name for p in papers} - map_titles
    print(f"    paper_id_map: {len(map_data)} 条, 论文缺失: {len(missing)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", action="store_true")
    ap.add_argument("--map", action="store_true")
    ap.add_argument("--cognee", action="store_true")
    ap.add_argument("--chunk", action="store_true")
    ap.add_argument("--extract", action="store_true")
    ap.add_argument("--distill", action="store_true")
    ap.add_argument("--hyperedge", action="store_true")
    ap.add_argument("--graphiti", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    if args.all or args.scan: step1_scan()
    if args.all or args.map: step2_map()
    if args.all or args.cognee: step3_cognee()
    if args.all or args.chunk or args.graphiti: step4_chunk()
    if args.all or args.extract or args.graphiti: step5_extract()
    if args.all or args.distill or args.graphiti: step6_distill()
    if args.all or args.hyperedge or args.graphiti: step8_hyperedge()
    if args.all or args.verify: step7_verify()
    if not any([args.scan, args.map, args.cognee, args.chunk, args.extract, args.distill, args.hyperedge, args.graphiti, args.verify, args.all]):
        ap.print_help()


if __name__ == "__main__":
    main()
