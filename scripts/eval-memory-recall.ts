// eval-memory-recall.ts — 记忆量化评测（V377, ⑦）
// 用 MEMORY_EVAL_GOLD 20 条: 写入 OpenViking → 每条用检索词 recall → 算命中率
// 指标: recall@k (Top-5 命中率) / 平均相似度 / 按类别命中
// 用法: npx tsx scripts/eval-memory-recall.ts
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { MEMORY_EVAL_GOLD } from '../src/services/memory-eval-gold.js';
import { rememberCategorized, recallMemory } from '../src/services/openviking-memory.js';

interface EvalResult {
  id: string;
  category: string;
  query: string;
  hit: boolean;
  topScore: number;
  foundContent: string;
}

async function main() {
  const recallOnly = process.argv.includes("--recall-only");
  console.log("══════ 记忆量化评测（recall@k）══════");
  console.log(`评测集: ${MEMORY_EVAL_GOLD.length} 条${recallOnly ? "（recall-only 复用已有记忆）" : ""}\n`);

  // 1. 写入全部测试记忆
  let writeOk = 0;
  if (recallOnly) {
    console.log("【1/2】跳过写入（--recall-only，复用已有记忆）");
  } else {
    console.log("【1/2】写入测试记忆...");
    for (const item of MEMORY_EVAL_GOLD) {
      const ok = await rememberCategorized(item.content, item.category);
      if (ok) writeOk++;
    }
  }
  if (!recallOnly) console.log(`写入完成: ${writeOk}/${MEMORY_EVAL_GOLD.length}\n`);

  // 2. 等抽取完成（LLM 抽取 + 向量化，给足时间）
  console.log("【2/2】等待抽取完成（30 秒）...");
  await new Promise((r) => setTimeout(r, 30000));

  // 3. 逐条召回测试
  const results: EvalResult[] = [];
  for (const item of MEMORY_EVAL_GOLD) {
    const recalled = await recallMemory(item.query, 5, 0.05);
    // 检查是否命中本条的 MEMEVAL 标识
    const phrase = item.phrase;
    const hit = recalled.some((r) => r.content.includes(phrase));
    const topScore = recalled.length > 0 ? recalled[0].score : 0;
    results.push({
      id: item.id,
      category: item.category,
      query: item.query,
      hit,
      topScore,
      foundContent: hit ? recalled.find((r) => r.content.includes(phrase))?.content.slice(0, 50) ?? "" : "",
    });
    console.log(`${hit ? "✅" : "❌"} ${item.id} [${item.category}] query="${item.query.slice(0, 20)}" topScore=${topScore.toFixed(3)}`);
  }

  // 4. 汇总
  const total = results.length;
  const hits = results.filter((r) => r.hit).length;
  const byCategory = (cat: string) => {
    const rs = results.filter((r) => r.category === cat);
    return { total: rs.length, hit: rs.filter((r) => r.hit).length };
  };
  const avgScore = results.reduce((s, r) => s + r.topScore, 0) / total;

  const report = {
    generatedAt: new Date().toISOString(),
    total,
    hits,
    recallAt5: hits / total,
    avgTopScore: Number(avgScore.toFixed(3)),
    byCategory: {
      user: byCategory("user"),
      session: byCategory("session"),
      entity: byCategory("entity"),
    },
    failures: results.filter((r) => !r.hit).map((r) => r.id),
    results,
  };

  writeFileSync("data/memory-recall-report.json", JSON.stringify(report, null, 2));
  console.log("\n══════ 评测报告 ══════");
  console.log(`Recall@5: ${hits}/${total} = ${((hits / total) * 100).toFixed(1)}%`);
  console.log(`平均 Top 分数: ${avgScore.toFixed(3)}`);
  console.log(`按类别: user ${byCategory("user").hit}/${byCategory("user").total} | session ${byCategory("session").hit}/${byCategory("session").total} | entity ${byCategory("entity").hit}/${byCategory("entity").total}`);
  console.log(`失败项: ${report.failures.join(", ") || "无"}`);
  console.log("\n报告已存: data/memory-recall-report.json");
}

main().catch((e) => { console.error("评测崩溃:", e); process.exit(1); });
