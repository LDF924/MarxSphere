#!/usr/bin/env python3
"""诊断 45 篇缺实体论文的根因"""
import sys, json, time
sys.path.insert(0, r"D:\Desktop\执行流程")
from pipeline import Neo4jConnection, QwenMaxClient
from pathlib import Path

nc = Neo4jConnection(uri="bolt://127.0.0.1:11001", user="neo4j", password="neo4j123")
llm = QwenMaxClient()
base = Path(r"D:\Desktop\ov_import")

no_ent = nc.execute_query("MATCH (ep:Episode) WHERE NOT (ep)-[:EXTRACTED_FROM]-(:Entity) RETURN ep.source_folder AS f ORDER BY f LIMIT 1")
name = no_ent[0]["f"]
d = base / name
print(f"Diagnosing: {name[:60]}")

texts = {}
for key, kws in [("摘要",["摘要","摘"]), ("问答",["问答","問答","问"]), ("术语",["术语"]), ("original",["original"])]:
    for f in d.glob("*.md"):
        if any(k in f.name for k in kws):
            texts[key] = f.read_text(encoding="utf-8")
            break

print(f"Files found: {sorted(texts.keys())}")
for k in ["摘要","术语","问答","original"]:
    if k in texts:
        print(f"  {k}: {len(texts[k])} chars")

ENTITY_CATEGORIES = "理论概念、人物主体、文本著作、组织机构空间、时代历史时序、价值意识形态文化、研究要素学术工具、行为实践社会行动、权利规范法律、关系载体"

prompt_e = (
    f"【文献摘要】{texts.get('摘要','')[:2000]}\n"
    f"【配套问答】{texts.get('问答','')[:2000]}\n"
    f"【术语表】{texts.get('术语','')[:2000]}\n"
    f"【原文】{texts.get('original','')[:10000]}\n"
    f"\n"
    f"十大实体分类: {ENTITY_CATEGORIES}\n"
    f'输出JSON: {{"entities":[{{"name":"唯物史观","category":"理论概念"}}]}}'
)

# Test 1: call_json (the normal pipeline path)
print("\n--- Test 1: call_json ---")
start = time.time()
r = llm.call_json(prompt_e, system_prompt="你是知识抽取专家。严格输出JSON。", max_retries=1, timeout=300)
elapsed = time.time() - start
print(f"Elapsed: {elapsed:.0f}s, Result type: {type(r).__name__}")

if r:
    if isinstance(r, dict) and "entities" in r:
        print(f"Entities: {len(r['entities'])}")
        for e in r["entities"][:2]:
            print(f"  {json.dumps(e, ensure_ascii=False)[:120]}")
    elif isinstance(r, list):
        print(f"List len: {len(r)}")
else:
    print("call_json returned None")
    if llm.failed_tasks:
        for ft in llm.failed_tasks:
            print(f"  Failed: {ft['error'][:300]}")

# Test 2: raw call to see what's returned
print("\n--- Test 2: raw call ---")
raw = llm.call(prompt_e, system_prompt="你是知识抽取专家。严格输出JSON。", timeout=300)
if raw:
    content = raw.get("content", "")
    print(f"Content length: {len(content)}")
    print(f"First 300:\n{content[:300]}")
    print(f"\nLast 300:\n{content[-300:]}")

    # Try to parse
    stripped = content.strip()
    # Remove markdown code fences
    import re as _re
    stripped = _re.sub(r'^```(?:json)?\s*\n?', '', stripped)
    stripped = _re.sub(r'\n?```\s*$', '', stripped)

    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, dict) and "entities" in parsed:
            print(f"\nPARSED OK: {len(parsed['entities'])} entities")
        else:
            print(f"\nParsed unexpected: {type(parsed).__name__}")
    except json.JSONDecodeError as e:
        print(f"\nJSON parse failed: {e}")
        print(f"Braces: {content.count('{')}, Brackets: {content.count('[')}")
else:
    print("Raw call ALSO returned None")
    if llm.failed_tasks:
        for ft in llm.failed_tasks:
            print(f"  Error: {ft['error'][:500]}")

nc.close()
print("\nDiagnosis complete.")
