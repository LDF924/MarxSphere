import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { readFileSync } from 'fs';

async function main() {
  console.log('=== 从 entity_id_map.json 提取 Cognee 实体元数据 ===');

  const sourceId = '8ecb4299-1bec-45d5-afef-6da5c3843ef3';
  const entityMap = JSON.parse(readFileSync('entity_id_map.json', 'utf8'));
  const entities = entityMap.entities || {};
  let total = 0;

  for (const [, entry] of Object.entries(entities) as [string, any][]) {
    const name = entry.unified_name || entry.graphiti_name || '';
    if (!name) continue;

    // 这个实体在 Cognee 中有映射
    if (entry.cognee_names && entry.cognee_names.length > 0) {
      for (let i = 0; i < entry.cognee_names.length; i++) {
        const cogName = entry.cognee_names[i];
        const cogId = entry.cognee_ids?.[i] || '';
        try {
          await pool.query(
            `INSERT INTO external_entities (source_id, engine, name, type, description, paper_count, metadata)
             VALUES ($1, 'cognee', $2, $3, $4, 1, $5)
             ON CONFLICT (engine, name, source_id) DO UPDATE SET metadata = $5`,
            [sourceId, cogName, '', '', JSON.stringify({ cognee_id: cogId, unified_name: name })]
          );
          total++;
        } catch(e) {}
      }
    }

    // Graphiti 实体也写入
    if (entry.graphiti_name) {
      try {
        await pool.query(
          `INSERT INTO external_entities (source_id, engine, name, type, description, paper_count, metadata)
           VALUES ($1, 'graphiti', $2, $3, $4, 1, $5)
           ON CONFLICT (engine, name, source_id) DO UPDATE SET metadata = $5`,
          [sourceId, entry.graphiti_name, '', '', JSON.stringify({ graphiti_id: entry.graphiti_id, method: entry.method, confidence: entry.confidence })]
        );
        total++;
      } catch(e) {}
    }

    if (total % 500 === 0) console.log('  已处理', total, '个...');
  }

  console.log('从 entity_id_map 提取完成:', total, '个');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
