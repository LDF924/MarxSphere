#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HyperEdge 结构化超边抽取 — 超越 HyperGraphRAG 的知识层
- 500 篇论文 → 每篇 1 次 LLM 调用(deepseek-v4-flash) 抽取 8-30 条结构化超边
- 显式 (e:Entity)-[:INVOLVED_IN]->(h:HyperEdge) 关联(分层匹配)
- text-embedding-v4 向量化, checkpoint 断点续传, 预算 guard
用法:
  python batch_hyperedge_extract.py                 # 全量
  BATCH_LIMIT=5 python batch_hyperedge_extract.py   # 5篇试跑
"""
import sys, json, os, time, hashlib, traceback
from pathlib import Path
from datetime import datetime

sys.path.insert(0, r'%USERPROFILE%\.claude\skills\marx-graphiti')
from pipeline.neo4j import Neo4jConnection
from pipeline.api_client import DeepSeekClient, QwenEmbeddingClient

BATCH_TAG = f'he_v1_{datetime.now().strftime("%Y%m%d_%H%M")}'
BASE_DIR = Path(r'D:\Desktop\ov_import')
CP_FILE = Path(r'%USERPROFILE%\.claude\skills\marx-graphiti\scripts\.checkpoint_hyperedge.json')
BATCH_LIMIT = int(os.environ.get('BATCH_LIMIT', 0))

HE_TYPES = {"命题命题定义","理论机制","政策法规","典型案例","学术争议","研究方法","时间事件","概念辨析","其他"}

neo4j = Neo4jConnection('bolt://127.0.0.1:11001', 'neo4j', 'neo4j123')
neo4j.execute_query('RETURN 1')

llm = DeepSeekClient()
llm.monitor.set_calling_script("batch_hyperedge_extract.py")
emb = QwenEmbeddingClient()
emb.monitor.set_calling_script("batch_hyperedge_extract.py")

def _checkpoint_saver(script_name, cost, budget_limit):
    save_checkpoint(processed, failed, counts)
    print(f"Checkpoint saved: {len(processed)} papers, {counts['hyperedges']} hyperedges, cost ¥{cost:.2f}", flush=True)

llm.monitor.set_checkpoint_saver(_checkpoint_saver)
r = llm.call('hi', timeout=15)
assert r

processed = set()
failed = {}
counts = {"hyperedges": 0, "unlinked_entities": 0, "total_entities_ref": 0}
if CP_FILE.exists():
    try:
        content = CP_FILE.read_text('utf-8').strip()
        if content:
            data = json.loads(content)
            processed = set(data.get("processed", []))
            failed = data.get("failed", {})
            counts = data.get("counts", counts)
    except:
        pass

def save_checkpoint(proc, fail, cnt):
    tmp = CP_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps({
        "processed": sorted(proc), "failed": fail, "counts": cnt,
        "updated_at": datetime.now().isoformat()
    }, ensure_ascii=False), encoding='utf-8')
    tmp.replace(CP_FILE)

def read_texts(folder):
    texts = {}
    for f in folder.glob('*.md'):
        n = f.name
        content = f.read_text(encoding='utf-8')
        # 剥离 frontmatter (---\n...\n---) 和 obsidian 链接行，避免污染 LLM 输入
        if content.startswith('---'):
            end = content.find('\n---', 3)
            if end > 0:
                content = content[end + 4:]
        lines = [l for l in content.splitlines() if not l.strip().startswith('**← 返回：**')]
        content = '\n'.join(lines)
        if '摘要' in n: texts['摘要'] = content[:1800]
        elif '术语' in n: texts['术语'] = content[:800]
        elif '问答' in n: texts['问答'] = content[:1500]
        elif 'original' in n: texts['original'] = content[:6000]
    return texts

PROMPT = (
    '【文献摘要】{摘要}\n'
    '【原文全文】{original}\n'
    '【问答要点】{问答}\n'
    '【术语表】{术语}\n\n'
    '你是马克思主义理论领域知识抽取专家。把该文献蕴含的"知识片段"（陈述性命题/机制/政策/案例/争议/方法/事件）逐条抽取为结构化超边。\n'
    '输出JSON: {{"hyperedges":['
    '{{"text":"完整原句或忠实概括句(≤150字)",'
    '"type":"命题命题定义|理论机制|政策法规|典型案例|学术争议|研究方法|时间事件|概念辨析|其他",'
    '"summary":"该知识点的中文凝练(≤60字)",'
    '"entities":["实体名1","实体名2"],'
    '"claims":["断言1"],'
    '"year":2020,'
    '"confidence":0.92}}]}}\n'
    '规则:\n'
    '- 每条超边 3-8 个参与实体, 实体名需与该文献中出现的一致(全称优先)\n'
    '- 政策条文类每条"禁止/允许/条件"单独成边\n'
    '- 争议类必须包含对立方实体\n'
    '- 数值/年份/比例必须原样保留在 text 中\n'
    '- 每篇 8-30 条, 优先核心论点, 宁缺毋滥\n'
    '- type 必须是上述9种之一\n'
    '- confidence 0-1 表示抽取置信度'
)

def process_one(folder):
    global counts
    fname = folder.name
    texts = read_texts(folder)
    if '摘要' not in texts or '术语' not in texts:
        print(f'SKIP {fname[:40]} - missing core', flush=True)
        return

    if llm.monitor.is_shutdown():
        print('BUDGET EXCEEDED. Checkpoint saved. Stopping.', flush=True)
        return 'shutdown'

    # 1. LLM 抽取
    prompt = PROMPT.format(**{k: texts.get(k, '') for k in ['摘要','original','问答','术语']})
    hedges = []
    for retry in range(3):
        r = llm.call_json(prompt, system_prompt='你是马理论知识抽取专家。严格输出JSON。', max_retries=1, timeout=300)
        if isinstance(r, dict) and r.get('hyperedges'):
            hedges = r['hyperedges']
            break
        elif isinstance(r, list):
            hedges = r
            break
    if not hedges:
        failed[fname] = 'llm_failed'
        print(f'FAIL {fname[:40]} - no hyperedges', flush=True)
        return

    # 2. 过滤/去重/校验
    valid = []
    seen_text = set()
    paper_id = hashlib.md5(fname.encode('utf-8')).hexdigest()[:12]
    for h in hedges:
        if not isinstance(h, dict): continue
        text = str(h.get('text', '')).strip()
        if not text or len(text) < 10 or len(text) > 300: continue
        if text in seen_text: continue
        seen_text.add(text)
        htype = h.get('type', '其他')
        if htype not in HE_TYPES: htype = '其他'
        conf = float(h.get('confidence', 0.8) or 0.8)
        if conf < 0.5: continue
        ents = [str(e).strip() for e in h.get('entities', []) if str(e).strip()][:8]
        if not ents: continue
        valid.append({
            'id': f'he_{paper_id}_{hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]}',
            'text': text, 'type': htype,
            'summary': str(h.get('summary', ''))[:200],
            'entities': ents,
            'claims': [str(c)[:200] for c in h.get('claims', [])][:5],
            'year': h.get('year'),
            'confidence': round(conf, 2),
        })
    if not valid:
        failed[fname] = 'no_valid'
        print(f'FAIL {fname[:40]} - no valid hyperedges', flush=True)
        return

    # 3. 向量化
    texts_to_embed = [h['text'] for h in valid]
    vecs = emb.embed_batch(texts_to_embed)
    if not vecs or len(vecs) != len(valid):
        failed[fname] = 'embed_failed'
        print(f'FAIL {fname[:40]} - embedding failed', flush=True)
        return

    # 4. 写库（幂等）
    ep = neo4j.execute_query('MATCH (ep:Episode {source_folder:$f}) RETURN ep.source_folder AS f', {'f': fname})
    has_episode = len(ep) > 0
    unlinked = 0
    for h, vec in zip(valid, vecs):
        props = {
            'text': h['text'], 'type': h['type'], 'summary': h['summary'],
            'entities': h['entities'], 'claims': h['claims'],
            'source_id': paper_id, 'source_title': fname,
            'pub_year': h.get('year'), 'confidence': h['confidence'],
            'embedding': vec, 'created_at': datetime.now().isoformat(),
            'batch_tag': BATCH_TAG
        }
        neo4j.execute_write(
            'MERGE (h:HyperEdge {id:$id}) SET h += $props',
            {'id': h['id'], 'props': props})
        # 实体分层匹配: 精确 → aliases → CONTAINS模糊
        for en in h['entities']:
            m = neo4j.execute_query(
                'MATCH (e:Entity {name:$n}) RETURN e.name AS n', {'n': en})
            if not m:
                m2 = neo4j.execute_query(
                    'MATCH (e:Entity) WHERE $n IN e.aliases RETURN e.name AS n LIMIT 1',
                    {'n': en})
                if m2:
                    en = m2[0]['n']
                else:
                    # CONTAINS 模糊: 短名(≤8字)且唯一包含
                    if len(en) <= 8:
                        m3 = neo4j.execute_query(
                            'MATCH (e:Entity) WHERE e.name CONTAINS $n '
                            'RETURN e.name AS n LIMIT 2', {'n': en})
                        if len(m3) == 1:
                            en = m3[0]['n']
                        else:
                            unlinked += 1
                            continue
                    else:
                        unlinked += 1
                        continue
            try:
                neo4j.execute_write(
                    'MATCH (e:Entity {name:$n}) MATCH (h:HyperEdge {id:$hid}) '
                    'MERGE (e)-[r:INVOLVED_IN]->(h) ON CREATE SET r.batch_tag=$bt, r.created_at=datetime()',
                    {'n': en, 'hid': h['id'], 'bt': BATCH_TAG})
            except Exception:
                unlinked += 1
        # Episode 关联
        if has_episode:
            try:
                neo4j.execute_write(
                    'MATCH (h:HyperEdge {id:$hid}) MATCH (ep:Episode {source_folder:$f}) '
                    'MERGE (h)-[r:FROM_EPISODE]->(ep) ON CREATE SET r.batch_tag=$bt',
                    {'hid': h['id'], 'f': fname, 'bt': BATCH_TAG})
            except Exception:
                pass

    counts['hyperedges'] += len(valid)
    counts['unlinked_entities'] += unlinked
    counts['total_entities_ref'] += sum(len(h['entities']) for h in valid)
    processed.add(fname)
    save_checkpoint(processed, failed, counts)
    print(f'OK {fname[:40]} | {len(valid)} hyperedges | unlinked={unlinked} | cost=¥{llm.monitor.total_cost+emb.monitor.total_cost:.2f}', flush=True)

# === MAIN LOOP ===
def _collect_paper_dirs(base: Path) -> list[Path]:
    dirs = []
    for d in sorted(base.iterdir()):
        if not d.is_dir(): continue
        if d.name in ('.obsidian', '.git', '__pycache__'): continue
        has_md = any((d / f).exists() for f in ['摘要.md', '术语.md', '问答.md', '术语表.md', 'original.md'])
        if has_md: dirs.append(d)
        else:
            subdirs = [sd for sd in d.iterdir() if sd.is_dir() and sd.name not in ('.obsidian', '.git', '__pycache__')]
            if subdirs: dirs.extend(_collect_paper_dirs(d))
    return dirs

all_dirs = _collect_paper_dirs(BASE_DIR)
pending = [d for d in all_dirs if d.name not in processed]
print(f'Total papers: {len(all_dirs)}, Done: {len(processed)}, Remaining: {len(pending)}', flush=True)

t_start = time.time()
for idx, folder in enumerate(pending):
    if BATCH_LIMIT and idx >= BATCH_LIMIT:
        print(f'\nBATCH_LIMIT={BATCH_LIMIT} reached. Saving checkpoint.', flush=True)
        save_checkpoint(processed, failed, counts)
        break
    t0 = time.time()
    try:
        result = process_one(folder)
        if result == 'shutdown':
            save_checkpoint(processed, failed, counts)
            break
        elapsed = (time.time() - t_start) / 60
        done = len(processed)
        remain = len(pending) - (idx + 1)
        avg = elapsed / (idx + 1) if idx > 0 else 2
        est = remain * avg
        print(f'  [{idx+1}/{len(pending)}] {elapsed:.0f}min | ~{est:.0f}min left | 共{counts["hyperedges"]}边 | ¥{llm.monitor.total_cost+emb.monitor.total_cost:.2f}', flush=True)
    except Exception as e:
        failed[folder.name] = f'crash: {str(e)[:80]}'
        print(f'CRASH {folder.name[:40]}: {e}', flush=True)
        traceback.print_exc()

# 建索引
print('\n=== 建索引 ===', flush=True)
try:
    neo4j.execute_write(
        'CREATE VECTOR INDEX hyperedge_vector_idx IF NOT EXISTS '
        'FOR (h:HyperEdge) ON (h.embedding) '
        'OPTIONS {indexConfig: {`vector.dimensions`: 1024, `vector.similarity_function`: "cosine"}}')
    print('vector index OK', flush=True)
except Exception as e:
    print(f'vector index: {e}', flush=True)
try:
    neo4j.execute_write(
        'CREATE FULLTEXT INDEX hyperedge_text_ft IF NOT EXISTS '
        'FOR (h:HyperEdge) ON EACH [h.text, h.summary]')
    print('fulltext index OK', flush=True)
except Exception as e:
    print(f'fulltext index: {e}', flush=True)

he = neo4j.execute_query('MATCH (h:HyperEdge) RETURN count(h) AS c')[0]['c']
inv = neo4j.execute_query('MATCH (:Entity)-[:INVOLVED_IN]->(:HyperEdge) RETURN count(*) AS c')[0]['c']
elapsed = (time.time() - t_start) / 60
print(f'\n=== HYPEREDGE DONE === {len(processed)} papers, {he} hyperedges, {inv} INVOLVED_IN | {elapsed:.0f}min | ¥{llm.monitor.total_cost+emb.monitor.total_cost:.2f} ===', flush=True)
neo4j.close()
