// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import 'dotenv/config';
import { RichMcpClient } from '../src/ai/rich-mcp-client.js';
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';

async function main() {
  const g = new RichMcpClient({ name: 'g', command: 'python', args: ['scripts/mcp_graphiti_runner.py'], env: { PYTHONIOENCODING: 'utf-8' } });
  await g.connect();

  // 通过 run_cypher_read 直接读 Paper 节点
  const allResults: any[] = [];
  const seen = new Set<string>();

  // 用 run_cypher_read 分批拉取 (每次 offset)
  for (let offset = 0; offset < 600; offset += 100) {
    try {
      const cyRes = await g.callTool('run_cypher_read', {
        query: 'MATCH (p:Paper) RETURN p.title as title, p.id as node_id, p.file_path as path SKIP ' + offset + ' LIMIT 100',
        params: {}
      });
      const cyData = JSON.parse((cyRes as any).result[0].text);
      if (!cyData.results || cyData.results.length === 0) break;
      for (const p of cyData.results) {
        const key = (p.title || '').trim();
        if (key && !seen.has(key)) {
          seen.add(key);
          allResults.push({ source_folder: key, title: key, id: p.node_id, file_path: p.path });
        }
      }
      if (cyData.results.length < 100) break;
    } catch(e) {
      console.log('Batch', offset, 'failed:', e);
      break;
    }
  }

  // 再用 search_literature 补充
  for (const ch of '资本市场规范发展政策制度农村农业'.split('')) {
    try {
      const r = await g.callTool('search_literature', { query: ch, limit: 50 });
      const data = JSON.parse((r as any).result[0].text);
      for (const p of (data.results || [])) {
        const key = p.source_folder || '';
        if (key && !seen.has(key)) {
          seen.add(key);
          allResults.push(p);
        }
      }
    } catch(e) { continue; }
  }

  console.log('Graphiti 总论文:', allResults.length);
  const map: Record<string, any> = {};
  for (const p of allResults) {
    const title = (p.source_folder || '').trim();
    if (!title) continue;
    const hash = createHash('md5').update(title.toLowerCase()).digest('hex').slice(0, 12);
    map[hash] = { paper_id: hash, title, graphiti_folder: p.source_folder };
  }

  writeFileSync('paper_id_map.json', JSON.stringify(map, null, 2));
  console.log('paper_id_map 生成完成:', Object.keys(map).length, '篇');
  await g.close();
}

main().catch(e => { console.error(e); process.exit(1); });
