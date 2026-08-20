// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

async function main() {
  console.log('=== 阶段1: 生成 50 题金标测试集 ===\n');

  const paperMap = JSON.parse(readFileSync('paper_id_map.json', 'utf8'));
  const entries = Object.entries(paperMap) as [string, any][];

  // 从有 md_path 的论文中选 (171 篇), 确保能读到原文
  const candidates = entries.filter(([, e]) => e.md_path);
  console.log('候选论文 (有本地MD):', candidates.length, '篇');

  // 随机选 50 篇 (哈希取模确保可复现)
  const seed = 'gold-50-v1';
  const sorted = [...candidates].sort((a, b) => {
    const ha = createHash('md5').update(seed + a[0]).digest('hex');
    const hb = createHash('md5').update(seed + b[0]).digest('hex');
    return ha.localeCompare(hb);
  });
  const selected = sorted.slice(0, 50);

  console.log('选中 50 篇论文:');
  for (const [i, [paperId, entry]] of selected.entries()) {
    const title = (entry.title || '').substring(0, 60);
    const path = entry.md_path || '';
    const hasMd = path ? '✅' : '❌';
    console.log(`  ${(i+1).toString().padStart(2)}. ${hasMd} ${title} (${paperId})`);
  }

  // 输出选中信息 (稍后需要 LLM 生成问题)
  const outline = selected.map(([paperId, entry]) => ({
    paper_id: paperId,
    title: entry.title,
    md_path: entry.md_path || '',
    graphiti_folder: entry.graphiti_folder || '',
  }));

  writeFileSync('gold_dataset_selection.json', JSON.stringify(outline, null, 2));
  console.log('\n选中论文已保存到 gold_dataset_selection.json');
  console.log('下一步: 对每篇论文用 LLM 生成问题 + 标准答案 + 相关段落');
}

main().catch(e => { console.error(e); process.exit(1); });
