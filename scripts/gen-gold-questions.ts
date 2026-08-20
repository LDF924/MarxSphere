// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import 'dotenv/config';
import { readFileSync, writeFileSync, readdirSync } from 'fs';

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

async function callDeepSeekV4(prompt: string): Promise<any> {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + DEEPSEEK_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 2000 })
  });
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || '';
  try { return JSON.parse(content.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '')); }
  catch { return {}; }
}

async function main() {
  console.log('=== 用 DeepSeek v4 Pro 重新生成金标测试集 ===\n');

  const selection = JSON.parse(readFileSync('gold_dataset_selection.json', 'utf8'));
  const goldDataset: any[] = [];
  let generated = 0;

  const typeMap = ['概念定义', '事实检索', '多跳推理', '政策评估'];
  let typeIdx = 0;

  for (const paper of selection) {
    const qType = typeMap[typeIdx % 4];
    typeIdx++;

    let content = '';
    try {
      content = readFileSync(paper.md_path + '/' + paper.title + '.original.md', 'utf8').substring(0, 2000);
    } catch(e) {
      const files = readdirSync(paper.md_path);
      const orig = files.find(f => f.endsWith('.original.md'));
      if (orig) content = readFileSync(paper.md_path + '/' + orig, 'utf8').substring(0, 2000);
    }

    if (!content || content.length < 100) {
      console.log('  ' + (generated+1) + '. [跳过] ' + paper.title.substring(0,50));
      continue;
    }

    const prompt = '你是一个学术论文评测专家。基于论文内容生成一个高质量的' + qType + '问题。\n论文标题: ' + paper.title + '\n论文内容: ' + content.substring(0, 1500) + '\n\n返回 JSON: { "question": "...", "gold_answer": "...", "relevant_paragraphs": [1,3], "question_type": "' + qType + '" }';

    try {
      const resp = await callDeepSeekV4(prompt);
      const question = resp?.question || resp?.content || '';
      const goldAnswer = resp?.gold_answer || resp?.answer || '';
      const relevantPars = resp?.relevant_paragraphs || [];

      goldDataset.push({
        id: 'Q' + String(generated+1).padStart(2,'0'), question, gold_answer: goldAnswer,
        relevant_paragraphs: relevantPars, question_type: qType,
        paper_id: paper.paper_id, paper_title: paper.title, md_path: paper.md_path,
      });

      generated++;
      console.log('  ' + generated + '. [' + qType + '] ' + (question||'').substring(0,80));
    } catch(e: any) { console.log('  [错误] ' + e.message?.substring(0,100)); }

    if (generated >= 50) break;
  }

  writeFileSync('gold_dataset.json', JSON.stringify(goldDataset, null, 2));
  console.log('\n金标测试集 (v4 Pro): ' + goldDataset.length + ' 题');
}

main().catch(e => { console.error(e); process.exit(1); });
