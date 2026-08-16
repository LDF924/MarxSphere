#!/usr/bin/env python3
"""Phase 3 — full batch entity extraction, runs until all 292 papers done."""
import sys, json, os, time, traceback
from pathlib import Path
from datetime import datetime

sys.path.insert(0, r'%USERPROFILE%\.claude\skills\marx-graphiti')
from pipeline.neo4j import Neo4jConnection
from pipeline.api_client import DeepSeekClient

BATCH_TAG = f'v3_full_{datetime.now().strftime("%Y%m%d_%H%M")}'
BASE_DIR = Path(r'D:\Desktop\ov_import')
CP_FILE = Path(r'%USERPROFILE%\.claude\skills\marx-graphiti\scripts\.checkpoint_full.json')
TOTAL = 292
BATCH_LIMIT = int(os.environ.get('BATCH_LIMIT', 0))  # 0 = unlimited, >0 = stop after N papers

ENTITY_CATEGORIES = "1.理论概念 2.人物主体 3.文本著作 4.组织机构空间 5.时代历史时序 6.价值意识形态文化 7.研究要素学术工具 8.行为实践社会行动 9.权利规范法律 10.关系载体"
VALID_REL_TYPES = frozenset({"PROPOSED_BY","PUBLISHED_IN","INHERITS_FROM","CRITIQUES","DEVELOPS_INTO","LEAD_TO","BELONG_TO","CONTRAST_WITH"})

neo4j = Neo4jConnection('bolt://127.0.0.1:11001', 'neo4j', 'neo4j123')
neo4j.execute_query('RETURN 1')

llm = DeepSeekClient()
llm.monitor.set_calling_script("batch_extract_full.py")

def _checkpoint_saver(script_name, cost, budget_limit):
    """预停机回调: 保存断点+Neo4j中当前进度"""
    save_checkpoint(processed)
    ep = neo4j.execute_query("MATCH (ep:Episode) RETURN count(ep) AS c")[0]["c"]
    ent = neo4j.execute_query("MATCH (e:Entity) RETURN count(e) AS c")[0]["c"]
    with open(CP_FILE.with_suffix(".shutdown_report.txt"), "w", encoding="utf-8") as f:
        f.write(f"Script: {script_name}\n")
        f.write(f"Time: {datetime.now().isoformat()}\n")
        f.write(f"Cost: RMB {cost:.4f} / budget {budget_limit}\n")
        f.write(f"Processed: {len(processed)} papers\n")
        f.write(f"Neo4j: {ep} Episodes, {ent} Entities\n")
    print(f"Checkpoint saved: {len(processed)} papers, {ep} episodes, {ent} entities", flush=True)

llm.monitor.set_checkpoint_saver(_checkpoint_saver)
r = llm.call('hi', timeout=15)
assert r

def save_checkpoint(data):
    tmp = CP_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps(sorted(data), ensure_ascii=False), encoding='utf-8')
    tmp.replace(CP_FILE)

processed = set()
if CP_FILE.exists():
    try:
        content = CP_FILE.read_text('utf-8').strip()
        if content:
            processed = set(json.loads(content))
    except:
        pass

def read_texts(folder):
    texts = {}
    for f in folder.glob('*.md'):
        n = f.name
        if '摘要' in n: texts['摘要'] = f.read_text(encoding='utf-8')[:2000]
        elif '术语' in n: texts['术语'] = f.read_text(encoding='utf-8')[:2000]
        elif '问答' in n or '問答' in n: texts['问答'] = f.read_text(encoding='utf-8')[:2000]
        elif 'original' in n: texts['original'] = f.read_text(encoding='utf-8')[:5000]
    return texts

def process_one(folder):
    fname = folder.name
    texts = read_texts(folder)
    if '摘要' not in texts or '术语' not in texts:
        print(f'SKIP {fname[:40]} - missing core', flush=True)
        return (0, 0)

    # === 预停机检查: 余额不足时拒绝新任务 ===
    if llm.monitor.is_shutdown():
        print(f'BUDGET EXCEEDED. Checkpoint saved. Stopping.', flush=True)
        return None  # 特殊标记: 预停机

    neo4j.execute_write(
        "MERGE (ep:Episode {source_folder:$f}) ON CREATE SET ep.title=$f, ep.created_at=datetime()",
        {'f': fname})

    prompt_e = (
        '【文献摘要 - 最高优先级】' + texts.get('摘要','') + '\n'
        + '【配套问答知识点 - 轻量化概念】' + texts.get('问答','') + '\n'
        + '【专业术语表 - 标准化名词库】' + texts.get('术语','') + '\n'
        + '【原文全文 - 补充论证细节】' + texts.get('original','') + '\n\n'
        + '你是马克思主义理论领域知识抽取专家。从以上文献中抽取实体节点，全部字段必填。\n'
        + '十大实体分类: ' + ENTITY_CATEGORIES + '\n\n'
        + '关键要求: 优先抽取学术概念术语（理论概念、价值意识形态文化、权利规范法律、研究要素学术工具），至少占60%以上。\n'
        + '不要遗漏短概念（如"产权""契约""资本""地租""GDP"），英文缩写作为alias保留。\n'
        + '规则: name/category/level/description/subcategory/aliases/context全部必填。level只能是"一级概念"或"二级子概念"。description不少于15字。\n'
        + '每个实体必须提供 2-4 个 aliases（含简称、英文名、同义术语）。\n'
        + '输出JSON: {"entities":[{"name":"...","category":"...","level":"一级概念","description":"...","subcategory":"...","aliases":[],"context":"..."}]}'
    )

    entities = []
    for retry in range(3):
        r = llm.call_json(prompt_e, system_prompt='你是马理论知识抽取专家。严格输出JSON。', max_retries=1, timeout=600)
        if isinstance(r, dict) and r.get('entities'):
            entities = r['entities']
            break
        elif isinstance(r, list):
            entities = r
            break

    valid_ent = 0
    for ent in entities:
        if not isinstance(ent, dict): continue
        name = ent.get('name','')
        if not name: continue
        props = {
            'category': ent.get('category',''), 'subcategory': ent.get('subcategory',''),
            'level': ent.get('level','二级子概念'), 'description': ent.get('description',''),
            'aliases': ent.get('aliases',[]), 'context': ent.get('context',''), 'source_folder': fname
        }
        neo4j.execute_write(
            'MERGE (e:Entity {name: $name}) SET e += $props, e.created_at = COALESCE(e.created_at, datetime()) '
            'WITH e MATCH (ep:Episode {source_folder:$folder}) '
            'MERGE (e)-[rf:EXTRACTED_FROM]->(ep) SET rf.source_folder = $folder, rf.batch_run = $bt',
            {'name': name, 'props': props, 'folder': fname, 'bt': BATCH_TAG})
        valid_ent += 1

    valid_rel = 0
    if valid_ent >= 2:
        ent_names = neo4j.execute_query(
            'MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode {source_folder:$f}) RETURN e.name AS n ORDER BY e.created_at DESC LIMIT 20',
            {'f': fname})
        names = [row['n'] for row in ent_names]
        rel_prompt = (
            '基于以下实体列表以及文献内容，抽取逻辑关系三元组。\n\n'
            + '【文献摘要】' + texts.get('摘要','')[:1200] + '\n'
            + '已知实体: ' + ', '.join(names) + '\n'
            + '关系类型: PROPOSED_BY, PUBLISHED_IN, INHERITS_FROM, CRITIQUES, DEVELOPS_INTO, LEAD_TO, BELONG_TO, CONTRAST_WITH\n'
            + '输出JSON: {"relations":[{"source":"...","relation_type":"BELONG_TO","target":"...","confidence":0.9,"description":"..."}]}'
        )
        r = llm.call_json(rel_prompt, system_prompt='你是马理论关系抽取专家。严格输出JSON。', max_retries=1, timeout=600)
        relations = []
        if isinstance(r, dict) and r.get('relations'): relations = r['relations']
        elif isinstance(r, list): relations = r
        for rel in relations:
            if not isinstance(rel, dict): continue
            src, tgt, rtype = rel.get('source',''), rel.get('target',''), rel.get('relation_type','')
            if not src or not tgt or rtype not in VALID_REL_TYPES: continue
            sc = neo4j.execute_query('MATCH (e:Entity {name:$n}) RETURN count(e) AS c', {'n': src})
            tc = neo4j.execute_query('MATCH (e:Entity {name:$n}) RETURN count(e) AS c', {'n': tgt})
            if sc[0]['c'] == 0 or tc[0]['c'] == 0: continue
            try:
                neo4j.execute_write(
                    'MATCH (a:Entity {name:$s}) MATCH (b:Entity {name:$t}) '
                    'MERGE (a)-[rr:' + rtype + ' {source_folder:$f}]->(b) '
                    'SET rr.confidence=$c, rr.description=$d, rr.created_at=datetime(), rr.batch_run=$bt',
                    {'s': src, 't': tgt, 'f': fname, 'c': rel.get('confidence',0.8),
                     'd': rel.get('description',''), 'bt': BATCH_TAG})
                valid_rel += 1
            except Exception:
                pass
    return (valid_ent, valid_rel)

# === MAIN LOOP ===
# 支持多层子目录 — 顶层目录下可能还有隐藏子目录（如 .资本下乡）
# 每篇论文一个子目录，含 摘要.md / 术语表.md 等
def _collect_paper_dirs(base: Path) -> list[Path]:
    dirs = []
    for d in sorted(base.iterdir()):
        if not d.is_dir():
            continue
        if d.name in ('.obsidian', '.git', '__pycache__'):
            continue
        # 如果有 摘要.md / 术语表.md 等文件，认为这是论文目录
        has_md = any((d / f).exists() for f in ['摘要.md', '术语.md', '问答.md', '术语表.md', 'original.md'])
        if has_md:
            dirs.append(d)
        else:
            # 递归搜集子目录（包括隐藏目录，如 .资本下乡）
            subdirs = [sd for sd in d.iterdir() if sd.is_dir() and sd.name not in ('.obsidian', '.git', '__pycache__')]
            if subdirs:
                dirs.extend(_collect_paper_dirs(d))
    return dirs

all_dirs = _collect_paper_dirs(BASE_DIR)
pending = [d for d in all_dirs if d.name not in processed]
TOTAL = len(all_dirs)
print(f'Total papers: {len(all_dirs)}, Done: {len(processed)}, Remaining: {len(pending)}', flush=True)

ok = fail = 0
t_start = time.time()

for idx, folder in enumerate(pending):
    fname = folder.name

    # Batch limit: stop after BATCH_LIMIT papers to free memory
    if BATCH_LIMIT and idx >= BATCH_LIMIT:
        print(f'\nBATCH_LIMIT={BATCH_LIMIT} reached. Saving checkpoint and exiting for restart.', flush=True)
        save_checkpoint(processed)
        break

    print(f'[{idx+1}/{len(pending)}] {fname[:50]} ...', end=' ', flush=True)
    t0 = time.time()
    try:
        valid_ent, valid_rel = process_one(folder)
        if valid_ent is None:  # 预停机信号
            print('\nPRE-SHUTDOWN: Budget exceeded. Saving checkpoint and stopping...', flush=True)
            save_checkpoint(processed)
            break
        if valid_ent >= 5:
            processed.add(fname)
            save_checkpoint(processed)
            ok += 1
            elapsed = (time.time() - t_start) / 60
            remaining = len(pending) - (idx + 1)
            avg_min = elapsed / (idx + 1) if idx > 0 else 3
            est_h = remaining * avg_min / 60
            print(f'ent={valid_ent} rel={valid_rel} [{time.time()-t0:.0f}s] | total={elapsed:.0f}min | ~{est_h:.1f}h left', flush=True)
        else:
            fail += 1
            print(f'FAIL ent={valid_ent} < 5 [{time.time()-t0:.0f}s]', flush=True)
    except Exception as e:
        fail += 1
        print(f'CRASH: {e}', flush=True)
        traceback.print_exc()

# Clean orphans
neo4j.execute_write('MATCH (ep:Episode) WHERE NOT EXISTS { MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep) } DETACH DELETE ep')

ep = neo4j.execute_query('MATCH (ep:Episode) RETURN count(ep) AS c')[0]['c']
ent = neo4j.execute_query('MATCH (e:Entity) RETURN count(e) AS c')[0]['c']
elapsed = (time.time() - t_start) / 60
print(f'\n=== PHASE 3 DONE === {ok} ok, {fail} fail | {elapsed:.0f}min | Neo4j: {ep} episodes, {ent} entities ===', flush=True)
neo4j.close()
