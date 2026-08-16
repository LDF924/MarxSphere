import 'dotenv/config';
process.env.DATABASE_URL = 'postgres://sag_lite:sag_lite_pass@localhost:5540/sag_lite';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';

const SAG_API = 'http://localhost:4173';
const PROJECT_ID = '8ecb4299-1bec-45d5-afef-6da5c3843ef3';

async function main() {
  const gold = JSON.parse(readFileSync('gold_dataset.json', 'utf8'));
  // Check existing docs in SAG
  const res = await fetch(SAG_API + '/api/projects/' + PROJECT_ID + '/documents?limit=200');
  const json = await res.json();
  const existing = new Set((json.documents||[]).map((d:any)=>d.title));

  console.log('金标集: ' + gold.length + ' 篇, 已入库: ' + existing.size + ' 篇');

  let ok = 0, fail = 0;
  for (const q of gold) {
    if (existing.has(q.paper_title || q.title)) { ok++; continue; }
    const mdPath = q.md_path; if (!mdPath) { fail++; continue; }
    let title = q.paper_title || '', content = '';
    try {
      try { content = readFileSync(mdPath + '/' + title + '.original.md', 'utf8'); }
      catch {
        const files = readdirSync(mdPath);
        const orig = files.find(f => f.endsWith('.original.md'));
        if (orig) { content = readFileSync(mdPath + '/' + orig, 'utf8'); title = orig.replace('.original.md', ''); }
      }
    } catch { fail++; continue; }
    if (!content || content.length < 100) { fail++; continue; }
    try {
      const up = await fetch(SAG_API + '/api/documents/upload', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ sourceId: PROJECT_ID, fileName: (title||'paper').substring(0,100)+'.md', title: title.substring(0,100), content })
      });
      const j = await up.json();
      if (j.error) { console.log('  FAIL: ' + title.substring(0,40) + ': ' + j.error.message); fail++; }
      else { ok++; existing.add(title); }
    } catch(e:any) { console.log('  FAIL: ' + title.substring(0,40) + ': ' + e.message); fail++; }
    if ((ok+fail) % 5 === 0) console.log('  进度: ' + (ok+fail) + '/' + gold.length);
  }
  console.log('入库完成: ' + ok + ' 篇, 失败: ' + fail);
}

main().catch(e=>{console.error(e);process.exit(1)});
