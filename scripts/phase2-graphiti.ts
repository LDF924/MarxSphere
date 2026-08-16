import 'dotenv/config';
import { RichMcpClient } from '../src/ai/rich-mcp-client.js';
import { readFileSync, writeFileSync } from 'fs';

async function main() {
  console.log('=== 阶段 2.2: Graphiti 侧补充 paper_id + chunk 关联 ===');

  const g = new RichMcpClient({ name: 'g', command: 'python', args: ['scripts/mcp_graphiti_runner.py'], env: { PYTHONIOENCODING: 'utf-8' } });
  await g.connect();

  const paperMap = JSON.parse(readFileSync('paper_id_map.json', 'utf8'));
  let updated = 0;
  const entries = Object.values(paperMap) as any[];

  // 为每篇论文的 Paper 节点补充 paper_id 属性
  for (const entry of entries) {
    const title = entry.title || entry.graphiti_folder || '';
    if (!title) continue;
    try {
      const r = await g.callTool('run_cypher_read', {
        query: `MATCH (p:Paper {title: '${title.replace(/'/g, "\\'")}'}) SET p.paper_id = '${entry.paper_id}' RETURN p.paper_id as paper_id`,
        params: {}
      });
      updated++;
    } catch(e) { continue; }
    if (updated % 50 === 0) console.log('  已更新', updated, '篇...');
  }
  console.log('Graphiti paper_id 补充完成:', updated, '篇');

  // 对有对应 Cognee 的论文，补充 chunk 关联
  let chunkLinks = 0;
  for (const entry of entries) {
    if (!entry.cognee_id) continue;
    try {
      await g.callTool('run_cypher_read', {
        query: `MATCH (c:Chunk) WHERE c.paper_id = '${entry.paper_id}' SET c.cognee_chunk_id = '${entry.cognee_id}'`,
        params: {}
      });
      chunkLinks++;
    } catch(e) { continue; }
  }
  console.log('Graphiti chunk 关联补充完成:', chunkLinks, '篇');

  await g.close();
  console.log('阶段 2.2 完成');
}

main().catch(e => { console.error(e); process.exit(1); });
