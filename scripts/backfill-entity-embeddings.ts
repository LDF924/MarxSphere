// backfill-entity-embeddings.ts
// Usage: cd SAG-main && npx tsx scripts/backfill-entity-embeddings.ts
import "dotenv/config";
import pg from "pg";
import { embeddingClient } from "../src/ai/embedding-client.js";

const { Pool } = pg;
const DB_URL = process.env.DATABASE_URL || "postgres://sag_lite:sag_lite_pass@localhost:5540/sag_lite";
// 5min statement_timeout for bulk backfill (not the 30s used by SAG runtime)
const pool = new Pool({ connectionString: DB_URL, statement_timeout: 300_000 });

const BATCH_SIZE = 10;
const COMMIT_EVERY = 100;

async function main() {
  console.log("=== external_entities embedding 回填 ===");

  await pool.query("alter table external_entities add column if not exists embedding vector(1024)");
  try { await pool.query("create index if not exists external_entities_embedding_hnsw on external_entities using hnsw (embedding vector_cosine_ops)"); } catch {}

  const { rows: [{ total }] } = await pool.query("SELECT COUNT(*) as total FROM external_entities WHERE embedding IS NULL");
  console.log("待回填:", total.toLocaleString(), "行");

  let done = 0;
  while (true) {
    const batch = await pool.query(
      "SELECT id, name FROM external_entities WHERE embedding IS NULL ORDER BY id LIMIT $1",
      [BATCH_SIZE]
    );
    if (batch.rows.length === 0) break;

    const ids = batch.rows.map((r: any) => r.id);
    const names = batch.rows.map((r: any) => r.name);

    try {
      const embeddings = await embeddingClient.batchGenerate(names);
      // Use a single client for the UPDATE batch to avoid nested query deprecation
      const client = await pool.connect();
      try {
        await client.query("begin");
        for (let i = 0; i < batch.rows.length; i++) {
          const vecStr = "[" + embeddings[i].join(",") + "]";
          await client.query(
            "UPDATE external_entities SET embedding = $1::vector WHERE id = $2",
            [vecStr, ids[i]]
          );
        }
        await client.query("commit");
      } catch (e: any) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    } catch (e: any) {
      console.error("  batch FAIL:", e.message?.substring(0, 100));
    }

    done += batch.rows.length;
    if (done % 500 === 0) console.log("  已回填", done.toLocaleString(), "/", total.toLocaleString());
  }

  console.log("完成:", done.toLocaleString(), "行");
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
