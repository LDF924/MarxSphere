// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// extract-cognee-entities.ts — 从 Cognee Neo4j 提取高质量业务实体(过滤碎片)
// Usage: cd SAG-main && npx tsx scripts/extract-cognee-entities.ts
// V26: entity quality filter — 去除日期、地名、数字、短词、停用词等碎片实体
import 'dotenv/config';
import { RichMcpClient } from '../src/ai/rich-mcp-client.js';
import { pool } from '../src/db/pool.js';
import { readFileSync } from 'fs';

// V26: 碎片实体过滤规则
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

async function main() {
  console.log('=== 提取 Cognee 高质量业务实体 ===');

  const c = new RichMcpClient({ name: 'c', command: 'COGNEE_DIR/.venv312/Scripts/python.exe', args: ['scripts/mcp_cognee_runner.py'], env: { PYTHONIOENCODING: 'utf-8', COGNEE_LOG_FILE: 'false' } });
  await c.connect();

  const sourceId = '8ecb4299-1bec-45d5-afef-6da5c3843ef3';
  let total = 0;
  let filtered = 0;

  const paperMap = JSON.parse(readFileSync('paper_id_map.json', 'utf8'));
  const seen = new Set<string>();

  for (const [, entry] of Object.entries(paperMap) as [string, any][]) {
    const title = entry.title || entry.graphiti_folder || '';
    if (!title || seen.size >= 5000) break;

    try {
      const r = await c.callTool('cognee_search', { query: title.substring(0, 40), search_type: 'CHUNKS', top_k: 5, dataset_name: 'capital_20260711_225715' });
      const text = (r as any).result?.[0]?.text || '';
      if (text.includes('error') || text.includes('DatasetNotFound')) continue;

      const data = JSON.parse(text);
      const entities = data?.entities || data?.results || data?.data || [];
      if (!Array.isArray(entities)) continue;

      for (const e of entities) {
        const name = e.name || e.entity_name || '';
        if (!name || seen.has(name)) continue;

        // V26: 过滤碎片
        if (!isBusinessEntity(name)) { filtered++; continue; }

        seen.add(name);
        const type = Array.isArray(e.types) ? e.types.join(',') : e.type || '';
        const desc = e.description || '';

        await pool.query(
          `INSERT INTO external_entities (source_id, engine, name, type, description, paper_count, metadata)
           VALUES ($1, 'cognee', $2, $3, $4, 1, $5)
           ON CONFLICT (engine, name, source_id) DO UPDATE SET paper_count = external_entities.paper_count + 1, metadata = $5`,
          [sourceId, name, type, desc, JSON.stringify({ last_title: title })]
        );
        total++;
      }

      if (total % 200 === 0 && total > 0) console.log('  已提取', total, '个 (过滤了', filtered, '个碎片)...');
    } catch(e: any) { continue; }
  }

  console.log('Cognee 业务实体提取完成:', total, '个, 过滤碎片:', filtered, '个');
  await c.close();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
