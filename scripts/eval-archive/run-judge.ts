import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

interface EvalResult {
  question_id: string; question_type: string; question: string;
  gold_answer: string; paper_id: string; config: string;
  hypothesis?: string; error?: string; duration_ms: number;
}

interface JudgeResult {
  question_id: string; config: string;
  faithfulness: number;    // 回答是否忠于上下文 (0-1)
  answer_relevancy: number; // 回答与问题相关度 (0-1)
  answer_correctness: number; // 与金标一致性 (0-1)
  answer_completeness: number; // 是否覆盖关键信息 (0-1)
  overall: number;          // 加权平均
  judge_raw: string;
}

async function judgeWithV4Flash(entry: EvalResult): Promise<JudgeResult> {
  if (!entry.hypothesis || entry.hypothesis.length < 10) {
    return {
      question_id: entry.question_id, config: entry.config,
      faithfulness: 0, answer_relevancy: 0, answer_correctness: 0,
      answer_completeness: 0, overall: 0,
      judge_raw: 'EMPTY_ANSWER',
    };
  }

  const prompt = `你是一个 RAG 评测专家。请对以下 AI 回答进行评分 (0-1 分)。

问题: ${entry.question}
标准答案: ${entry.gold_answer}
AI 回答: ${entry.hypothesis}

评分要求:
- 不要求 AI 回答与标准答案完全一致
- 只要 AI 回答在语义上和标准答案表达相同或相似的含义，就给高分
- 关键看 AI 回答是否覆盖了标准答案的核心观点，不管措辞是否相同
- Faithfulness: AI 回答是否基于上下文，不含编造
- Answer Relevancy: 是否切题
- Answer Correctness: 与标准答案在语义上是否表达相同的观点 (不是字面匹配!)
- Answer Completeness: 是否覆盖核心观点
- overall: 加权平均分

返回 JSON: { "faithfulness": 0.8, "answer_relevancy": 0.9, "answer_correctness": 0.7, "answer_completeness": 0.6, "overall": 0.75 }`;

  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + DEEPSEEK_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 500 })
    });
    const json = await res.json();
    const msg = json.choices?.[0]?.message || {};
    // v4-flash 有时把回答放在 reasoning_content 中，content 为空
    const raw = msg.content || msg.reasoning_content || '{}';
    // 尝试解析 JSON (可能被 markdown 包裹)
    let parsed: any = {};
    const cleaned = raw.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
    try { parsed = JSON.parse(cleaned); } catch(e) { parsed = {}; }

    return {
      question_id: entry.question_id, config: entry.config,
      faithfulness: parsed.faithfulness || 0,
      answer_relevancy: parsed.answer_relevancy || 0,
      answer_correctness: parsed.answer_correctness || 0,
      answer_completeness: parsed.answer_completeness || 0,
      overall: parsed.overall || 0,
      judge_raw: raw,
    };
  } catch(e: any) {
    return {
      question_id: entry.question_id, config: entry.config,
      faithfulness: 0, answer_relevancy: 0, answer_correctness: 0,
      answer_completeness: 0, overall: 0,
      judge_raw: 'ERROR: ' + e.message,
    };
  }
}

async function main() {
  console.log('=== 阶段 3: 自动评分 (DeepSeek v4-flash Judge) ===\n');

  const results: EvalResult[] = JSON.parse(readFileSync('eval_results_sag.json', 'utf8'));
  const okResults = results.filter(r => r.hypothesis && r.hypothesis.length >= 10);
  console.log('待评分: ' + okResults.length + ' 条');

  const judgeResults: JudgeResult[] = [];
  const BATCH_SIZE = 5;
  let done = 0;

  for (let i = 0; i < okResults.length; i += BATCH_SIZE) {
    const batch = okResults.slice(i, i + BATCH_SIZE);
    const promises = batch.map(r => judgeWithV4Flash(r));
    const settled = await Promise.allSettled(promises);

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        judgeResults.push(s.value);
      }
    }
    done += batch.length;
    if (done % 20 === 0) console.log('  已评分: ' + done + ' 条');
  }

  // 写入评分
  writeFileSync('judge_results.json', JSON.stringify(judgeResults, null, 2));

  // 计算平均值
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
  const faith = avg(judgeResults.map(r => r.faithfulness));
  const relev = avg(judgeResults.map(r => r.answer_relevancy));
  const correct = avg(judgeResults.map(r => r.answer_correctness));
  const complete = avg(judgeResults.map(r => r.answer_completeness));
  const overall = avg(judgeResults.map(r => r.overall));

  // 按配置分类
  const byConfig: Record<string, JudgeResult[]> = {};
  for (const r of judgeResults) {
    if (!byConfig[r.config]) byConfig[r.config] = [];
    byConfig[r.config].push(r);
  }

  console.log('\n=== 评测报告 ===');
  console.log('');
  console.log('指标               A(SAG Only)  B(Graphiti)  C(Cognee)  D(Both)    总体');
  console.log('──────────────────────────────────────────────────────────────────────────');
  for (const metric of ['faithfulness','answer_relevancy','answer_correctness','answer_completeness','overall']) {
    const label = { faithfulness: '忠实度', answer_relevancy: '相关性', answer_correctness: '正确性', answer_completeness: '完整性', overall: '综合分' }[metric] || metric;
    const vals = ['A_SAG_Only','B_SAG_Graphiti','C_SAG_Cognee','D_SAG_Both'].map(cfg => {
      const items = byConfig[cfg] || [];
      return items.length > 0 ? avg(items.map((r: any) => r[metric] || 0)).toFixed(3) : '   -';
    });
    const total = avg(judgeResults.map((r: any) => r[metric] || 0)).toFixed(3);
    console.log(label.padEnd(12) + vals.join('        ') + '    ' + total);
  }
  console.log('');

  // 生产指标
  const durations = results.filter(r => !r.error).map(r => r.duration_ms);
  durations.sort((a, b) => a - b);
  const avgMs = avg(durations);
  const p95Ms = durations[Math.floor(durations.length * 0.95)] || durations[durations.length - 1];
  console.log('生产指标:');
  console.log('  平均响应时间: ' + (avgMs/1000).toFixed(1) + 's');
  console.log('  P95 延迟:     ' + (p95Ms/1000).toFixed(1) + 's');
  console.log('  失败率:       ' + (results.filter(r => r.error).length / results.length * 100).toFixed(1) + '%');
  console.log('  有效回答率:   ' + (okResults.length / results.length * 100).toFixed(1) + '%');
  console.log('');
  console.log('结果文件: judge_results.json');
}

main().catch(e => { console.error(e); process.exit(1); });
