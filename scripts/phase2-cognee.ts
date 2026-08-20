// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import 'dotenv/config';
import { RichMcpClient } from '../src/ai/rich-mcp-client.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';

async function main() {
  console.log('=== 阶段 2.1: Cognee 侧补充 paper_id ===');

  const c = new RichMcpClient({ name: 'cognee', command: 'COGNEE_DIR/.venv312/Scripts/python.exe', args: ['scripts/mcp_cognee_runner.py'], env: { PYTHONIOENCODING: 'utf-8', COGNEE_LOG_FILE: 'false' } });
  await c.connect();

  // 拉取 Cognee 的全部论文列表
  const r = await c.callTool('cognee_datasets', {});
  console.log('Cognee datasets result:', JSON.stringify(r.result).substring(0, 500));

  // Cognee 侧: 已有 paper_id_map.json 中的 title → hash 映射
  // 核心操作: 更新 paper_id_map.json，补充 cognee_id
  const paperMap = JSON.parse(readFileSync('paper_id_map.json', 'utf8'));
  let updated = 0;

  // 尝试用不同查询词搜索 Cognee 论文
  for (const [hash, entry] of Object.entries(paperMap) as [string, any][]) {
    const title = entry.title || entry.graphiti_folder || '';
    if (!title || entry.cognee_id) continue;
    try {
      const sr = await c.callTool('cognee_search', { query: title.substring(0, 50), limit: 3 });
      const data = JSON.parse((sr as any).result[0].text);
      // Cognee 返回格式不同，暂记 paper_id
      if (data && data.results && data.results.length > 0) {
        entry.cognee_id = data.results[0].id || data.results[0].source_id || '';
      }
    } catch(e) { continue; }
    updated++;
    if (updated % 20 === 0) console.log('  已处理', updated, '篇...');
    if (updated >= 10) break; // 先测试 10 篇
  }

  writeFileSync('paper_id_map.json', JSON.stringify(paperMap, null, 2));
  console.log('Cognee 映射补充完成:', updated, '篇更新');

  await c.close();
}

main().catch(e => { console.error(e); process.exit(1); });
