// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, closePool } from "./pool.js";
import { logger } from "../observability/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// V397 桌面端: 迁移目录优先用 SAG_ROOT（根目录）而非模块路径推导 —
// 编译到 dist 后 __dirname 变成 dist/src/db, 推导会指向不存在的 dist/migrations
//
// 2026-09-11: SAG_ROOT 指向的目录下**没有** migrations/ 时回退到模块相对路径。
// 起因是本地 worktree 开发: SAG_ROOT 仍指主仓, 于是改了 worktree 的迁移却在主仓目录里找不到,
// 表现为"迁移静默什么都没做"(实测)。宁可路径判断复杂一点, 也别静默跳过迁移。
function resolveMigrationsDir(): string {
  const candidates = [
    process.env.SAG_ROOT ? path.join(process.env.SAG_ROOT, "migrations") : null,
    path.resolve(__dirname, "../..", "migrations"),
    path.resolve(__dirname, "../../..", "migrations"), // dist/src/db → 仓库根
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    try {
      if (fsSync.statSync(dir).isDirectory()) return dir;
    } catch { /* 试下一个 */ }
  }
  return candidates[0];
}
const migrationsDir = resolveMigrationsDir();

// 跨实例迁移互斥锁(会话级; 与 finally 的 unlock 成对)
const MIGRATION_LOCK_KEY = 736_154_201;

// 并发锁：防止 migrate() 被同时调用（index.ts 启动 + 手动触发时共享 pool client 状态错乱）
let migrating = false;
export async function migrate(): Promise<void> {
  if (migrating) {
    // 已有迁移在跑 — 等待完成（不并发）
    await new Promise<void>((resolve) => {
      const check = setInterval(() => { if (!migrating) { clearInterval(check); resolve(); } }, 500);
    });
  }
  migrating = true;
  const client = await pool.connect();
  try {
    // 多副本同时启动: 只有一个真正执行迁移, 其余在此等待 ——
    // 没有它, 两个副本会各自跑同一个文件(幂等 SQL 也可能因并发建索引/唯一约束而失败)。
    // PG 不支持 advisory lock 时退化为原行为并告警(单机仍正确)。
    try {
      await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    } catch (e) {
      console.warn("[sag] 迁移互斥锁不可用(继续迁移, 单机安全):", String((e as Error)?.message || e).slice(0, 120));
    }
    await client.query("begin");
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    await client.query("commit");

    const files = (await fs.readdir(migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const alreadyApplied = await client.query(
        "select 1 from schema_migrations where name = $1",
        [file]
      );
      if (alreadyApplied.rowCount && alreadyApplied.rowCount > 0) {
        logger.info({ migration: file }, "migration already applied");
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        logger.info({ migration: file }, "migration applied");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    // 释放跨实例锁(会话结束也会自动释放; 显式释放让等待中的副本更快拿到)
    try { await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]); } catch { /* 忽略 */ }
    client.release();
    migrating = false;
  }
}

// Windows 下 tsx 的 process.argv[1] 是反斜杠路径、import.meta.url 是正斜杠 URL——
// 直接比较永不相等导致 migrate() 从不执行。用 pathToFileURL 规范化后比较。
import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(async () => closePool())
    .catch(async (error: unknown) => {
      logger.error({ error }, "migration failed");
      await closePool();
      process.exit(1);
    });
}

