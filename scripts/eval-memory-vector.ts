// eval-memory-vector.ts — P1-4 记忆向量化评估：验证语义召回质量
// 2026-08-12：skill_embeddings(189) + task_experience 向量化(17/22) 已有；本脚本验证语义召回
// 用法: npx tsx scripts/eval-memory-vector.ts
import { pool } from "../src/db/pool.js";
import { embeddingClient } from "../src/ai/embedding-client.js";

async function main() {
  // 1. 统计数据
  const skills = await pool.query("SELECT count(*)::int as n FROM skill_embeddings");
  const exp = await pool.query("SELECT count(*) FILTER (WHERE embedding IS NOT NULL)::int as with_vec, count(*)::int as total FROM task_experience");
  console.log("=== P1-4 记忆向量化统计 ===");
  console.log(`skill_embeddings: ${skills.rows[0].n} 条`);
  console.log(`task_experience: ${exp.rows[0].with_vec}/${exp.rows[0].total} 有向量`);

  // 2. 语义召回测试：用 task_experience 里的 query 作为查询，验证能召回相似经验
  const queries = await pool.query("SELECT query, qtype FROM task_experience ORDER BY created_at DESC LIMIT 5");
  console.log("\n=== 语义召回测试 ===");
  for (const q of queries.rows) {
    const vec = await embeddingClient.generate(q.query);
    const lit = `[${vec.join(",")}]`;
    const r = await pool.query(
      `select query, qtype, quality_score,
              1 - (embedding <=> $1::vector) as similarity
       from task_experience
       where embedding is not null
       order by embedding <=> $1::vector
       limit 3`,
      [lit]
    );    console.log(`\n查询: ${q.query.slice(0, 40)} [${q.qtype}]`);
    for (const hit of r.rows) {
      console.log(`  → ${hit.query.slice(0, 40)} [${hit.qtype}] sim=${Number(hit.similarity).toFixed(3)}`);
    }
  }

  // 3. 验证 skill 嵌入检索（P1-3 主动工具发现）
  const skillTest = await embeddingClient.generate("资本下乡与土地流转的分析");
  const skillLit = `[${skillTest.join(",")}]`;
  const s = await pool.query(
    `select name, description,
            1 - (embedding <=> $1::vector) as similarity
     from skill_embeddings
     order by embedding <=> $1::vector
     limit 3`,
    [skillLit]
  );
  console.log("\n=== 技能语义检索（P1-3 验证）===");
  for (const hit of s.rows) {
    console.log(`  → ${hit.name} sim=${Number(hit.similarity).toFixed(3)}`);
  }

  await pool.end();
  console.log("\n=== P1-4 评估完成 ===");
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
