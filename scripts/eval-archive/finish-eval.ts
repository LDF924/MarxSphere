// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { readFileSync, writeFileSync, existsSync } from 'fs';

const SAG_API = 'http://localhost:4173';
const PROJECT_ID = '8ecb4299-1bec-45d5-afef-6da5c3843ef3';
const LOG_FILE = 'eval_results_sag.json';

async function callSAG(query: string, config: string) {
  const start = Date.now();
  const res = await fetch(SAG_API + '/api/reason/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId: PROJECT_ID, query, topK: 15 })
  });
  const json = await res.json();
  const duration = Date.now() - start;
  if (json.error) return { config, error: json.error.message || JSON.stringify(json.error), duration_ms: duration };
  const trace = json.trace || {};
  return {
    config, task_id: json.taskId,
    hypothesis: trace.hypothesis?.content || '',
    confidence: trace.hypothesis?.confidence,
    timings: trace.timings || {},
    eval_score: trace.evaluation?.overallScore,
    duration_ms: duration,
  };
}

async function main() {
  let results: any[] = [];
  const doneSet = new Set<string>();
  if (existsSync(LOG_FILE)) {
    const raw = JSON.parse(readFileSync(LOG_FILE, 'utf8'));
    // Filter out init/error entries
    results = raw.filter((r: any) => !r.error && r.question_id !== 'init');
    for (const r of results) doneSet.add(r.question_id + '__' + r.config);
  }
  const gold = JSON.parse(readFileSync('gold_dataset.json', 'utf8'));
  const configs = ['A_SAG_Only', 'D_SAG_Both'];

  // Find what's missing
  const todos: {q: any, c: string}[] = [];
  for (const q of gold) {
    for (const c of configs) {
      if (!doneSet.has(q.id + '__' + c)) todos.push({q, c});
    }
  }
  console.log('剩余: ' + todos.length + ' 次');

  for (let i = 0; i < todos.length; i++) {
    const {q, c} = todos[i];
    process.stdout.write(q.id + ' ' + c + ' ... ');
    const r = await callSAG(q.question, c);
    results.push({ question_id: q.id, question_type: q.question_type, question: q.question, gold_answer: q.gold_answer, paper_id: q.paper_id, ...r });
    writeFileSync(LOG_FILE, JSON.stringify(results, null, 2));
    if (r.error) console.log('FAIL: ' + r.error.substring(0, 60));
    else console.log('OK (' + (r.duration_ms/1000).toFixed(1) + 's)');
    if ((i+1) % 4 === 0) { console.log('  [' + (i+1) + '/' + todos.length + ']'); await new Promise(r=>setTimeout(r, 10000)); }
  }

  const ok = results.filter((r:any)=>!r.error);
  console.log('\n完成: ' + results.length + '/' + (gold.length*configs.length) + ' (' + ok.length + ' 有效)');
}

main().catch(e => { console.error(e); process.exit(1); });
