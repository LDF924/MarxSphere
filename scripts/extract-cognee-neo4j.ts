import os
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { execSync } from 'child_process';

async function main() {
  console.log('=== 直接用 Python 查 Neo4j 11003 提取 Cognee 全量实体 ===');

  const sourceId = '8ecb4299-1bec-45d5-afef-6da5c3843ef3';

  // 用 Python 直接连 Neo4j 11003
  const pyScript = `
import sys
sys.path.insert(0, r'CLAUDE_DIR\\skills\\marx-cognee')
from neo4j import GraphDatabase
import json

driver = GraphDatabase.driver("bolt://127.0.0.1:11003", auth=("neo4j", os.environ.get("NEO4J_PASSWORD", "neo4j123")))
results = []

with driver.session() as session:
    # 分批拉取所有 Entity 节点
    for offset in range(0, 12000, 500):
        r = session.run(
            "MATCH (e:Entity) RETURN e.name as name, labels(e) as labels, e.description as description, e.id as node_id SKIP $offset LIMIT 500",
            offset=offset
        )
        batch = [{"name": row["name"] or "", "labels": row["labels"] or [], "description": row["description"] or "", "node_id": row["node_id"] or ""} for row in r]
        results.extend(batch)
        if len(batch) < 500:
            break

print(json.dumps(results[:10]))
print("TOTAL:", len(results))

driver.close()
`.trim();

  const output = execSync('python -c "' + pyScript.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"', { encoding: 'utf8', timeout: 60000 });
  console.log('Python output:', output.substring(0, 500));

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
