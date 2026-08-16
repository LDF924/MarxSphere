#!/usr/bin/env python3
"""Phase 3 batch entity extraction — inline standalone script."""
import sys, json, os, time, traceback
from pathlib import Path
from datetime import datetime

sys.path.insert(0, r'%USERPROFILE%\.claude\skills\marx-graphiti')
from pipeline.neo4j import Neo4jConnection
from pipeline.api_client import DeepSeekClient

BATCH_TAG = f'v3_batch_{datetime.now().strftime("%Y%m%d_%H%M")}'
_BATCH_FROM_ARG = None
for _i, _a in enumerate(sys.argv):
    if _a == "--batch-size" and _i + 1 < len(sys.argv):
        _BATCH_FROM_ARG = int(sys.argv[_i + 1])
        break
BATCH_SIZE = _BATCH_FROM_ARG or int(os.environ.get("BATCH_SIZE", 5))
BASE_DIR = Path(r'D:\Desktop\ov_import')
CP_FILE = Path(r'%USERPROFILE%\.claude\skills\marx-graphiti\scripts\.checkpoint_batch.json')

ENTITY_CATEGORIES = """1. 理论概念——马理论、政治经济学、哲学等学科的核心理论概念
2. 人物主体——学者、思想家、历史人物、群体主体
3. 文本著作——文献、著作、文件、政策文本
4. 组织机构空间——组织、机构、地区、空间范畴
5. 时代历史时序——历史时期、阶段、时间节点
6. 价值意识形态文化——价值观、意识形态、文化现象
7. 研究要素学术工具——研究方法、分析框架、学术概念工具
8. 行为实践社会行动——社会实践、行为模式、社会运动
9. 权利规范法律——权利、法律、制度规范
10. 关系载体——社会关系、经济关系的承载形式"""

VALID_REL_TYPES = {'PROPOSED_BY','PUBLISHED_IN','INHERITS_FROM','CRITIQUES','DEVELOPS_INTO','LEAD_TO','BELONG_TO','CONTRAST_WITH'}

neo4j = Neo4jConnection('bolt://127.0.0.1:11001', 'neo4j', 'neo4j123')
neo4j.execute_query('RETURN 1 AS test')
print('[OK] Neo4j connected')

llm = DeepSeekClient()
res = llm.call('回一个数字: 1', timeout=15)
assert res is not None, 'DeepSeek connection failed'
print('[OK] DeepSeek connected')

processed = set()
if CP_FILE.exists():
    processed = set(json.loads(CP_FILE.read_text('utf-8')))

all_dirs = sorted([d for d in BASE_DIR.iterdir() if d.is_dir() and not d.name.startswith('.')])
pending_all = [d for d in all_dirs if d.name not in processed]
pending = pending_all[:BATCH_SIZE]

print(f'Total: {len(all_dirs)}, Processed: {len(processed)}, Remaining: {len(pending_all)}, This batch: {len(pending)}')

def read_texts(folder):
    texts = {}
    for f in folder.glob('*.md'):
        n = f.name
        if '摘要' in n: texts['摘要'] = f.read_text(encoding='utf-8')
        elif '术语' in n: texts['术语'] = f.read_text(encoding='utf-8')
        elif '问答' in n or '問答' in n: texts['问答'] = f.read_text(encoding='utf-8')
        elif 'original' in n: texts['original'] = f.read_text(encoding='utf-8')
    return texts

ok_count = fail_count = 0
start_time = time.time()

for idx, folder in enumerate(pending):
    fname = folder.name
    print(f"[{idx+1}/{len(pending)}] Processing: {fname[:50]}", flush=True)
    texts = read_texts(folder)

    if '摘要' not in texts or '术语' not in texts:
        print(f'[{idx+1}/{len(pending)}] SKIP {fname[:50]} - missing core files')
        fail_count += 1
        continue

    try:
        neo4j.execute_write(
            "MERGE (ep:Episode {source_folder:$f}) ON CREATE SET ep.title=$f, ep.created_at=datetime()",
            {'f': fname})

        prompt_e = (
            f"【文献摘要 - 最高优先级】{texts.get('摘要','')[:2000]}\n"
            f"【配套问答知识点 - 轻量化概念】{texts.get('问答','')[:2000]}\n"
            f"【专业术语表 - 标准化名词库】{texts.get('术语','')[:2000]}\n"
            f"【原文全文 - 补充论证细节】{texts.get('original','')[:10000]}\n"
            "\n"
            "你是马克思主义理论领域知识抽取专家。从以上文献中抽取实体节点，全部字段必填。\n"
            f"十大实体分类: {ENTITY_CATEGORIES}\n"
            "\n"
            "规则:\n"
            "- name/category/level/description/subcategory/aliases/context 全部必填\n"
            "- level 只能是「一级概念」或「二级子概念」\n"
            "- description 不少于15字\n"
            "- 空值填空数组[]或空字符串\"\"\n"
            "- 优先核心范畴，不抽细碎短句\n"
            "- 摘要中的核心论点、核心人物、核心理论、创新点、研究结论一个都不能少\n"
            "- 术语表中的概念全称、简称、别名、所属分类必须全部抽取\n"
            "- 输出JSON格式: {\"entities\":[{\"name\":\"唯物史观\",\"category\":\"理论概念\",\"level\":\"一级概念\",\"description\":\"...\"}]}"
        )

        entities = []
        for retry in range(3):
            r = llm.call_json(prompt_e,
                              system_prompt="你是马理论知识抽取专家。严格输出JSON，所有字段必填。",
                              max_retries=1, timeout=300)
            if isinstance(r, dict) and r.get('entities'):
                entities = r['entities']
                break
            elif isinstance(r, list):
                entities = r
                break
            if retry < 2:
                prompt_e += "\n务必输出 entities 数组，所有字段都填完整。"

        valid_ent = 0
        for ent in entities:
            if not isinstance(ent, dict):
                continue
            name = ent.get('name', '')
            if not name:
                continue
            props = {
                'category': ent.get('category', ''),
                'subcategory': ent.get('subcategory', ''),
                'level': ent.get('level', '二级子概念'),
                'description': ent.get('description', ''),
                'aliases': ent.get('aliases', []),
                'context': ent.get('context', ''),
                'source_folder': fname,
            }
            neo4j.execute_write("""
                MERGE (e:Entity {name: $name})
                SET e += $props, e.created_at = COALESCE(e.created_at, datetime())
                WITH e MATCH (ep:Episode {source_folder: $folder})
                MERGE (e)-[rf:EXTRACTED_FROM]->(ep)
                SET rf.source_folder = $folder, rf.batch_run = $batch_tag
            """, {'name': name, 'props': props, 'folder': fname, 'batch_tag': BATCH_TAG})
            valid_ent += 1

        valid_rel = 0
        if valid_ent >= 2:
            ent_names = neo4j.execute_query(
                "MATCH (e:Entity)-[:EXTRACTED_FROM]->(ep:Episode {source_folder:$f}) RETURN e.name AS n ORDER BY e.created_at DESC LIMIT 20",
                {'f': fname})
            names = [r['n'] for r in ent_names]

            rel_prompt = (
                "基于以下实体列表以及文献的四层内容，抽取实体间的逻辑关系三元组。\n"
                "\n"
                f"【文献摘要 - 全局认知】{texts.get('摘要','')[:1200]}\n"
                f"【配套问答 - 概念区分】{texts.get('问答','')[:1200]}\n"
                f"【术语表 - 标准命名】{texts.get('术语','')[:1200]}\n"
                f"【原文片段 - 论证支撑】{texts.get('original','')[:2000]}\n"
                "\n"
                f"已知实体: {', '.join(names)}\n"
                "关系类型（必须选以下之一）: PROPOSED_BY, PUBLISHED_IN, INHERITS_FROM, CRITIQUES, DEVELOPS_INTO, LEAD_TO, BELONG_TO, CONTRAST_WITH\n"
                "输出JSON: {\"relations\":[{\"source\":\"...\",\"relation_type\":\"BELONG_TO\",\"target\":\"...\",\"confidence\":0.9,\"description\":\"...\"}]}\n"
                "至少输出3条关系。优先从摘要和问答中抽取明确提出的关系。"
            )

            r = llm.call_json(rel_prompt,
                              system_prompt="你是马理论关系抽取专家。严格输出JSON，至少3条关系。",
                              max_retries=1, timeout=300)
            relations = []
            if isinstance(r, dict) and r.get('relations'):
                relations = r['relations']
            elif isinstance(r, list):
                relations = r

            for rel in relations:
                if not isinstance(rel, dict):
                    continue
                src, tgt, rtype = rel.get('source', ''), rel.get('target', ''), rel.get('relation_type', '')
                if not src or not tgt or rtype not in VALID_REL_TYPES:
                    continue
                sc = neo4j.execute_query("MATCH (e:Entity {name:$n}) RETURN count(e) AS c", {'n': src})
                tc = neo4j.execute_query("MATCH (e:Entity {name:$n}) RETURN count(e) AS c", {'n': tgt})
                if sc[0]['c'] == 0 or tc[0]['c'] == 0:
                    continue
                try:
                    neo4j.execute_write(
                        f"MATCH (a:Entity {{name:$s}}) MATCH (b:Entity {{name:$t}}) "
                        f"MERGE (a)-[rr:{rtype} {{source_folder:$f}}]->(b) "
                        f"SET rr.confidence=$c, rr.description=$d, rr.created_at=datetime(), rr.batch_run=$batch_tag",
                        {'s': src, 't': tgt, 'f': fname, 'c': rel.get('confidence', 0.8),
                         'd': rel.get('description', ''), 'batch_tag': BATCH_TAG})
                    valid_rel += 1
                except Exception:
                    pass

        processed.add(fname)
        CP_FILE.write_text(json.dumps(sorted(processed), ensure_ascii=False), encoding='utf-8')
        ok_count += 1
        elapsed = (time.time() - start_time) / 60
        print(f"[{idx+1}/{len(pending)}] OK {fname[:50]} | ent={valid_ent} rel={valid_rel} | {elapsed:.0f}min")

    except Exception as e:
        fail_count += 1
        print(f"[{idx+1}/{len(pending)}] FAIL {fname[:50]}: {e}")
        traceback.print_exc()

ep = neo4j.execute_query("MATCH (ep:Episode) RETURN count(ep) AS c")[0]['c']
ent = neo4j.execute_query("MATCH (e:Entity) RETURN count(e) AS c")[0]['c']
elapsed = (time.time() - start_time) / 60
print(f"\n=== BATCH DONE === {ok_count} ok, {fail_count} fail | {elapsed:.0f}min")
print(f"Neo4j: {ep} episodes, {ent} entities")
neo4j.close()
