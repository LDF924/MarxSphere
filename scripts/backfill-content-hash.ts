// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// V398 backfill：为存量 documents 补算 content_hash（087 迁移后执行）
// 用法：npx tsx scripts/backfill-content-hash.ts [batchSize=100]
// 幂等：只处理 content_hash IS NULL 的行；重复执行自动跳过已填充行

import { createHash } from "node:crypto";
import { pool } from "../src/db/pool.js";

const batchSize = Number(process.argv[2] ?? 100);

async function main() {
  console.log(`[backfill] batchSize=${batchSize}`);
  let total = 0;
  for (;;) {
    const { rows } = await pool.query(
      `select id, content from documents
       where content_hash is null and archived_at is null and content is not null
       limit $1`,
      [batchSize]
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const hash = createHash("sha256").update(row.content).digest("hex");
      await pool.query(
        `update documents set content_hash = $1 where id = $2 and content_hash is null`,
        [hash, row.id]
      );
    }
    total += rows.length;
    console.log(`[backfill] ${total} done (${rows.length} this batch)`);
    if (rows.length < batchSize) break;
  }
  const { rows: remaining } = await pool.query(
    `select count(*)::int as n from documents where content_hash is null and archived_at is null`
  );
  console.log(`[backfill] done. total=${total}, remaining_null=${remaining[0].n}`);
  await pool.end();
}

main().catch((e) => {
  console.error("[backfill] failed:", e);
  process.exit(1);
});
