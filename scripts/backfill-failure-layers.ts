// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// backfill-failure-layers.ts — 给 eval_failures 补 layer 列（P1-6 三层验证）
// 用三层验证器(verifyResult/verifyProcess)结合评测JSON的trace数据+金标, 计算每题 layer:
//   result(结果层失败: 论文未命中/实体覆盖低) / process(过程层失败: 降级未标注/绕过检索) / quality(质量层: 推理/上下文错误)
// 用法: npx tsx scripts/backfill-failure-layers.ts [--eval eval_32metrics.json]
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { Client } from 'pg';
import { verifyResult, verifyProcess } from '../src/services/trajectory-verifier.js';

function main() {
  const args = process.argv.slice(2);
  const evalFile = (() => { const i = args.indexOf('--eval'); return i >= 0 && i + 1 < args.length ? args[i + 1] : 'eval_32metrics.json'; })();
  const dryRun = args.includes('--dry-run');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const goldRaw = JSON.parse(readFileSync('gold_dataset.json', 'utf8'));
  const goldList: any[] = Array.isArray(goldRaw) ? goldRaw : (goldRaw.questions || []);
  const goldMap = new Map(goldList.map((g: any) => [g.id, g]));

  // 评测结果（含 trace: fusedContext/hypothesis/retrievalStrategy）
  let evalResults: any[] = [];
  if (existsSync(evalFile)) {
    try { evalResults = JSON.parse(readFileSync(evalFile, 'utf8')); } catch {}
  }
  const evalMap = new Map((Array.isArray(evalResults) ? evalResults : []).map((r: any) => [r.question_id, r]));

  (async () => {
    await client.connect();
    const failures = await client.query('select id, question_id, failure_category from eval_failures');
    console.log(`待补 layer: ${failures.rows.length} 条`);

    for (const f of failures.rows) {
      const q = goldMap.get(f.question_id) || {};
      const evalR = evalMap.get(f.question_id);
      const trace = evalR?.trace || {};
      // 构造验证输入（金标 + trace）
      const qInput = { paper_title: q.paper_title || '', gold_entities: q.gold_entities || [] };
      const v = verifyResult(qInput, trace);
      const p = verifyProcess(trace);

      // layer 判定（结合归因类别 + 三层验证结果）
      let layer: string;
      const cat = f.failure_category;
      if (cat === 'timeout' || cat === 'tool') {
        layer = 'process';  // 超时/工具失败 = 过程层
      } else if (cat === 'retrieval') {
        layer = v.paperHit && v.goldEntityCoverage >= 0.5 ? 'quality' : 'result';  // 检索失败: 结果层(未命中论文)或质量层
      } else if (cat === 'context') {
        layer = 'process';  // 上下文问题 = 过程层
      } else if (cat === 'reasoning') {
        layer = 'quality';  // 推理错误 = 质量层
      } else {
        layer = 'quality';
      }

      console.log(`  ${f.question_id} (${cat}) → ${layer} | result:${v.passed ? 'ok' : 'fail'} process:${p.passed ? 'ok' : 'fail'}`);
      if (!dryRun) {
        await client.query('update eval_failures set layer = $1 where id = $2', [layer, f.id]);
      }
    }
    console.log(dryRun ? '[dry-run] 未写库' : '✅ layer 已补齐');
    await client.end();
  })().catch((e: any) => { console.error('补层失败:', e.message); process.exit(1); });
}

main();
