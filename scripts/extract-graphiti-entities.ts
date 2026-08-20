// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// extract-graphiti-entities.ts — 从 Graphiti Neo4j 提取高质量业务实体(过滤碎片)
// Usage: cd SAG-main && npx tsx scripts/extract-graphiti-entities.ts
// V26: entity quality filter — 去除日期、地名、数字、短词、停用词等碎片实体
import 'dotenv/config';
import { RichMcpClient } from '../src/ai/rich-mcp-client.js';
import { pool } from '../src/db/pool.js';

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
  console.log('=== 提取 Graphiti 高质量业务实体 ===');

  const g = new RichMcpClient({ name: 'g', command: 'python', args: ['scripts/mcp_graphiti_runner.py'], env: { PYTHONIOENCODING: 'utf-8' } });
  await g.connect();

  const sourceId = '8ecb4299-1bec-45d5-afef-6da5c3843ef3';
  let total = 0;
  let filtered = 0;
  const batchSize = 100;

  for (let offset = 0; offset < 12000; offset += batchSize) {
    try {
      const r = await g.callTool('run_cypher_read', {
        query: `MATCH (e:Entity) RETURN e.name as name, labels(e) as labels, e.description as description SKIP ${offset} LIMIT ${batchSize}`,
        params: {}
      });
      const data = JSON.parse((r as any).result[0].text);
      if (!data.results || data.results.length === 0) break;

      for (const row of data.results) {
        const name = row.name || '';
        if (!name) continue;
        if (!isBusinessEntity(name)) { filtered++; continue; }

        const type = Array.isArray(row.labels) ? row.labels.filter((l: string) => l !== 'Entity').join(',') || 'Entity' : 'Entity';
        const desc = row.description || '';
        await pool.query(
          `INSERT INTO external_entities (source_id, engine, name, type, description, metadata)
           VALUES ($1, 'graphiti', $2, $3, $4, $5)
           ON CONFLICT (engine, name, source_id) DO UPDATE SET type = $3, description = $4, metadata = $5`,
          [sourceId, name, type, desc, JSON.stringify({ import_batch: offset / batchSize })]
        );
        total++;
      }

      if (total % 500 === 0) console.log('  已处理', total, '个业务实体 (过滤', filtered, '个碎片)...');
    } catch(e: any) {
      console.log('批次', offset, '失败:', e.message?.substring(0, 100));
      break;
    }
  }

  console.log('Graphiti 业务实体提取完成:', total, '个, 过滤碎片:', filtered, '个');
  await g.close();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
