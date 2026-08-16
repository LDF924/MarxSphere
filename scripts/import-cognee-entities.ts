import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { readFileSync } from 'fs';

async function main() {
  console.log('=== 导入 Cognee 全量实体到 PG ===');

  const sourceId = '8ecb4299-1bec-45d5-afef-6da5c3843ef3';
  const data = JSON.parse(readFileSync('cognee_entities_dump.json', 'utf8'));
  console.log('Cognee entities from Neo4j:', data.length);

  let inserted = 0;
  for (const row of data) {
    const name = row.name || '';
    if (!name) continue;
    const type = Array.isArray(row.labels) ? row.labels.filter((l: string) => l !== 'Entity').join(',') || 'Entity' : 'Entity';
    const desc = row.description || '';
    try {
      await pool.query(
        `INSERT INTO external_entities (source_id, engine, name, type, description, paper_count, metadata)
         VALUES ($1, 'cognee', $2, $3, $4, 1, $5)
         ON CONFLICT (engine, name, source_id) DO UPDATE SET type = $3, description = $4, metadata = $5`,
        [sourceId, name, type, desc, JSON.stringify({ cognee_neo4j_id: row.node_id })]
      );
      inserted++;
    } catch(e) {}
    if (inserted % 1000 === 0) console.log('  已导入', inserted, '个...');
  }

  console.log('Cognee 实体导入完成:', inserted, '个');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
