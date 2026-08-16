import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const SAG_API = 'http://localhost:4173';
const PROJECT_ID = '8ecb4299-1bec-45d5-afef-6da5c3843ef3';

const LOG_FILE = 'eval_results_sag.json';
const BATCH_SIZE = 2;
const BATCH_DELAY_MS = 30000; // 30s, SAG 推理链较长

interface EvalResult {
  question_id: string; question_type: string; question: string;
  gold_answer: string; paper_id: string; config: string;
  task_id?: string; hypothesis?: string; confidence?: number;
  timings?: Record<string, number>; outlines?: string[];
  retrieve_count?: number; eval_score?: number;
  error?: string; duration_ms: number;
}

const CONFIGS = [
  { name: 'A_SAG_Only', engines: [] },
  { name: 'D_SAG_Both', engines: ['graphiti', 'cognee'] },
];

async function callSAGReason(query: string, cfg: {name: string; engines: string[]}): Promise<Omit<EvalResult, 'question_id'|'question_type'|'question'|'gold_answer'|'paper_id'>> {
  const start = Date.now();
  try {
    const res = await fetch(SAG_API + '/api/reason/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: PROJECT_ID, query, topK: 15 })
    });
    const json = await res.json();
    const duration = Date.now() - start;
    if (json.error) return { config: cfg.name, error: json.error.message || JSON.stringify(json.error), duration_ms: duration };

    const trace = json.trace || {};
    return {
      config: cfg.name, task_id: json.taskId,
      hypothesis: trace.hypothesis?.content || '',
      confidence: trace.hypothesis?.confidence,
      timings: trace.timings || {},
      outlines: (trace.outline || []).map((o: any) => o.title),
      retrieve_count: (trace.retrieveResults || []).reduce((s: number, r: any) => s + (r.results?.length || 0), 0),
      eval_score: trace.evaluation?.overallScore,
      duration_ms: duration,
    };
  } catch(e: any) { return { config: cfg.name, error: e.message, duration_ms: Date.now() - start }; }
}

async function main() {
  console.log('=== 评测: SAG 推理链 (调 /api/reason/query) ===');
  console.log('模型: SAG 内置 (qwen-plus 大纲, Graphiti+Cognee MCP)');
  console.log('配置: A(SAG Only) vs D(SAG+双库)');
  console.log('批次: ' + BATCH_SIZE + ' 题/批, 间隔 ' + (BATCH_DELAY_MS/1000) + 's\n');

  const questions = JSON.parse(readFileSync('gold_dataset.json', 'utf8'));

  let results: EvalResult[] = [];
  let doneSet = new Set<string>();
  if (existsSync(LOG_FILE)) {
    results = JSON.parse(readFileSync(LOG_FILE, 'utf8'));
    for (const r of results) { if (!r.error) doneSet.add(r.question_id + '__' + r.config); }
    console.log('恢复进度: ' + doneSet.size + ' 次\n');
  }

  const totalTarget = questions.length * CONFIGS.length;
  let totalDone = doneSet.size;

  for (let batchStart = 0; batchStart < questions.length; batchStart += BATCH_SIZE) {
    const batch = questions.slice(batchStart, batchStart + BATCH_SIZE);
    for (const q of batch) {
      for (const cfg of CONFIGS) {
        const key = q.id + '__' + cfg.name;
        if (doneSet.has(key)) continue;
        process.stdout.write('  ' + q.id + ' ' + cfg.name + ' ... ');
        const result = await callSAGReason(q.question, cfg);
        results.push({ question_id: q.id, question_type: q.question_type, question: q.question, gold_answer: q.gold_answer, paper_id: q.paper_id, ...result });
        doneSet.add(key); totalDone++;
        if (result.error) { console.log('FAIL: ' + result.error.substring(0, 80)); }
        else { console.log('OK (' + (result.duration_ms/1000).toFixed(1) + 's)'); }
        writeFileSync(LOG_FILE, JSON.stringify(results, null, 2));
      }
    }
    console.log('  [批次] ' + totalDone + '/' + totalTarget + ' (' + ((totalDone/totalTarget)*100).toFixed(0) + '%)');
    if (batchStart + BATCH_SIZE < questions.length) {
      process.stdout.write('  等待 ' + (BATCH_DELAY_MS/1000) + 's...');
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      console.log('');
    }
  }

  const okResults = results.filter(r => !r.error);
  console.log('\n=== 推理完成 ===');
  console.log('总计: ' + results.length + ' | 成功: ' + okResults.length + ' | 失败: ' + (results.length - okResults.length));
  if (okResults.length > 0) console.log('平均耗时: ' + (okResults.reduce((s,x)=>s+x.duration_ms,0)/okResults.length/1000).toFixed(1) + 's');
}

main().catch(e => { console.error(e); process.exit(1); });
