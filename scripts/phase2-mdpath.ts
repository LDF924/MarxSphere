// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import 'dotenv/config';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';

async function main() {
  console.log('=== 阶段 2.3: 补充 MD 路径映射 ===');

  const paperMap = JSON.parse(readFileSync('paper_id_map.json', 'utf8'));
  const ovDir = 'D:/Desktop/ov_import/资本规范与引导、资本治理（2012—2026年6月）';

  // 批量匹配论文标题到本地 MD 路径
  let matched = 0;
  let skipped = 0;
  const entries = Object.values(paperMap) as any[];

  const dirEntries = readdirSync(ovDir, { withFileTypes: true });
  const dirMap = new Map<string, string>();
  for (const d of dirEntries) {
    if (d.isDirectory()) dirMap.set(d.name, d.name);
  }

  for (const entry of entries) {
    const title = entry.title || entry.graphiti_folder || '';
    if (!title || entry.md_path) continue;

    // 精确匹配
    if (dirMap.has(title)) {
      entry.md_path = ovDir + '/' + dirMap.get(title);
      matched++;
      continue;
    }

    // 前缀匹配 (论文名可能前面有特殊符号)
    let found = false;
    for (const [dirName] of dirMap) {
      if (dirName.includes(title.substring(0, 10)) || title.includes(dirName.substring(0, 10))) {
        entry.md_path = ovDir + '/' + dirName;
        matched++;
        found = true;
        break;
      }
    }
    if (!found) skipped++;
  }

  writeFileSync('paper_id_map.json', JSON.stringify(paperMap, null, 2));
  console.log('MD 路径匹配:', matched, '篇, 未匹配:', skipped, '篇');
  console.log('阶段 2.3 完成');
}

main().catch(e => { console.error(e); process.exit(1); });
