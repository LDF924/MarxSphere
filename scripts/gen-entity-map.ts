import 'dotenv/config';
import { RichMcpClient } from '../src/ai/rich-mcp-client.js';
import { readFileSync, writeFileSync } from 'fs';

async function main() {
  // 读取已有的 2218 对实体映射
  const alignPath = process.env.COGNEE_SKILL_DIR ? `${process.env.COGNEE_SKILL_DIR}/scripts/cross_graph_alignment.json` : 'cross_graph_alignment.json';
  const align = JSON.parse(readFileSync(alignPath, 'utf8'));
  const matches = align.matches || [];

  // 生成 entity_id_map.json (扩展格式)
  const entityMap: Record<string, any> = {};

  for (const m of matches) {
    if (!m.graphiti_name || !m.cognee_name) continue;
    const key = m.graphiti_name.toLowerCase().trim();
    if (!entityMap[key]) {
      entityMap[key] = {
        unified_name: m.graphiti_name,
        graphiti_id: m.graphiti_id,
        graphiti_name: m.graphiti_name,
        cognee_ids: [],
        cognee_names: [],
        method: m.method,
        confidence: m.confidence,
      };
    }
    entityMap[key].cognee_ids.push(m.cognee_id);
    entityMap[key].cognee_names.push(m.cognee_name);
  }

  writeFileSync('entity_id_map.json', JSON.stringify({
    stats: align.stats,
    entity_count: Object.keys(entityMap).length,
    entities: entityMap,
  }, null, 2));
  console.log(`entity_id_map.json 生成完成: ${Object.keys(entityMap).length} 实体对 (复用已有 2218 对)`);

  // 对遗漏的实体进行补充映射

  // 清理
  process.exit(0);
}

main();
