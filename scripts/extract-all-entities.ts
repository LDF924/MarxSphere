// extract-all-entities.ts — 一键执行: Cognee+Graphiti 实体提取 + PG同步 + embedding回填
// Usage: cd SAG-main && npx tsx scripts/extract-all-entities.ts
// V28: Cognee 用 neo4j-driver 直连 Neo4j (不走MCP — MCP CYPHER search不可靠)
//      Graphiti 保留 MCP run_cypher_read (Graphiti MCP支持raw Cypher)
import 'dotenv/config';
import neo4j from 'neo4j-driver';
import { RichMcpClient } from '../src/ai/rich-mcp-client.js';
import { pool } from '../src/db/pool.js';
import { embeddingClient } from '../src/ai/embedding-client.js';

function isBusinessEntity(name: string): boolean {
  if (!name || name.length < 2) return false;
  if (name.length > 80) return false;
  if (/^\d+$/.test(name)) return false;
  if (/^\d{4}年/.test(name)) return false;
  if (/^\d+[-~]\d+$/.test(name)) return false;
  if (/^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青川藏宁琼]/.test(name) && name.length <= 3) return false;
  if (/^(关于|基于|当前)/.test(name)) return false;
  if (/^[a-zA-Z]+$/.test(name) && name.length < 2) return false;
  return true;
}

const SOURCE_ID = '8ecb4299-1bec-45d5-afef-6da5c3843ef3';
const PYTHON = 'COGNEE_DIR/.venv312/Scripts/python.exe';
const BATCH_EMBED = 10;

// ─── Cognee: neo4j-driver 直连 Neo4j 11003 ───
const cogneeDriver = neo4j.driver(
  'bolt://127.0.0.1:11003',
  neo4j.auth.basic('neo4j', process.env.NEO4J_PASSWORD || 'neo4j123'),
  { maxConnectionLifetime: 300_000, connectionTimeout: 30_000 },
);

async function extractCogneeDirect(): Promise<{total: number, filtered: number}> {
  console.log('--- 第1步: Cognee 直连 Neo4j 实体提取 ---');
  const session = cogneeDriver.session();
  let total = 0, filtered = 0;
  try {
    const BATCH = 5000;
    for (let offset = 0; offset < 100_000; offset += BATCH) {
      const result = await session.run(
        `MATCH (e:Entity) RETURN e.name AS name, labels(e) AS labels, e.description AS description SKIP ${offset} LIMIT ${BATCH}`,
      );
      if (result.records.length === 0) break;
      for (const record of result.records) {
        const name = record.get('name') || '';
        if (!name) continue;
        if (!isBusinessEntity(name)) { filtered++; continue; }
        const labels: string[] = record.get('labels') || [];
        const type = labels.filter((l: string) => l !== '__Node__' && l !== 'Entity').join(',') || 'Entity';
        const desc = (record.get('description') || '').substring(0, 500);
        await pool.query(
          `INSERT INTO external_entities (source_id, engine, name, type, description, metadata)
           VALUES ($1, 'cognee', $2, $3, $4, $5)
           ON CONFLICT (engine, name, source_id) DO UPDATE SET type = $3, description = $4, metadata = $5`,
          [SOURCE_ID, name, type, desc, JSON.stringify({ batch: offset / BATCH })],
        );
        total++;
      }
      if (total % 500 === 0) console.log('  Cognee:', total.toLocaleString(), '+', filtered.toLocaleString(), 'filtered');
    }
  } finally {
    await session.close();
  }
  return { total, filtered };
}

// ─── Graphiti: MCP run_cypher_read (Graphiti MCP 支持原始 Cypher) ───
async function extractGraphitiCypher(): Promise<{total: number, filtered: number}> {
  console.log('--- 第2步: Graphiti Cypher 实体提取 ---');
  const g = new RichMcpClient({ name: 'graphiti-extract', command: 'python', args: ['scripts/mcp_graphiti_runner.py'], env: { PYTHONIOENCODING: 'utf-8' } });
  await g.connect();
  let total = 0, filtered = 0;
  for (let offset = 0; offset < 12000; offset += 100) {
    try {
      const r = await g.callTool('run_cypher_read', {
        query: `MATCH (e:Entity) RETURN e.name as name, labels(e) as labels, e.description as description SKIP ${offset} LIMIT 100`,
        params: {}
      });
      const json = JSON.parse((r as any).result[0].text);
      const rows = json?.results || json?.data || [];
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        const name = row.name || '';
        if (!name) continue;
        if (!isBusinessEntity(name)) { filtered++; continue; }
        await pool.query(
          `INSERT INTO external_entities (source_id, engine, name, type, description, metadata)
           VALUES ($1, 'graphiti', $2, $3, $4, $5)
           ON CONFLICT (engine, name, source_id) DO UPDATE SET type = $3, description = $4, metadata = $5`,
          [SOURCE_ID, name, '', row.description || '', JSON.stringify({ batch: offset/100 })]
        );
        total++;
      }
      if (total % 500 === 0) console.log('  Graphiti:', total.toLocaleString(), '+', filtered.toLocaleString(), 'filtered');
    } catch(e: any) { console.log('  Graphiti batch', offset, 'FAIL:', e.message?.substring(0, 60)); break; }
  }
  await g.close();
  return { total, filtered };
}

// ─── Embedding 回填 ───
async function backfillEmbeddings() {
  console.log('--- 第3步: Embedding 回填 ---');
  await pool.query("alter table external_entities add column if not exists embedding vector(1024)");
  try { await pool.query("create index if not exists external_entities_embedding_hnsw on external_entities using hnsw (embedding vector_cosine_ops)"); } catch {}
  const { rows: [{ total }] } = await pool.query("SELECT COUNT(*) as total FROM external_entities WHERE embedding IS NULL");
  console.log('  待回填:', total.toLocaleString());
  let done = 0;
  while (true) {
    const { rows } = await pool.query("SELECT name FROM external_entities WHERE embedding IS NULL LIMIT $1", [BATCH_EMBED]);
    if (rows.length === 0) break;
    const names = rows.map((r: any) => r.name);
    const vecs = await embeddingClient.batchGenerate(names);
    if (!vecs || vecs.length !== names.length) { console.log('  embed fail, retry'); continue; }
    for (let i = 0; i < names.length; i++) {
      // batchGenerate returns number[], need to format as PG vector literal: '[0.1,0.2,...]'
      const vec = vecs[i];
      const literal = '[' + vec.join(',') + ']';
      await pool.query("UPDATE external_entities SET embedding = $1::vector WHERE name = $2 AND embedding IS NULL", [literal, names[i]]);
    }
    done += names.length;
    if (done % 500 === 0) console.log(`  Embeddings: ${done.toLocaleString()} / ${total.toLocaleString()}`);
  }
  console.log(`  Embeddings 完成: ${done.toLocaleString()}`);
}

// ─── Main ───
async function main() {
  console.log('═══════════════════════════════');
  console.log('  V28 双引擎实体提取 (直连)');
  console.log('═══════════════════════════════');

  const cogneeResult = await extractCogneeDirect();
  const graphitiResult = await extractGraphitiCypher();
  await backfillEmbeddings();

  const cnt = await pool.query('SELECT COUNT(*) as c, engine FROM external_entities GROUP BY engine');
  console.log('\n═══════════════════════════════');
  console.log('  提取完成!');
  cnt.rows.forEach((r: any) => console.log('  ' + r.engine + ': ' + r.c.toLocaleString() + ' entities'));
  console.log('  Cognee 过滤碎片: ' + cogneeResult.filtered.toLocaleString());
  console.log('  Graphiti 过滤碎片: ' + graphitiResult.filtered.toLocaleString());
  console.log('═══════════════════════════════');
  await pool.end();
  await cogneeDriver.close();
}

main();
