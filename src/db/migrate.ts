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

/**
 * 已知的历史改名/重编号: 库里的记录名 → 本分支里同一个迁移现在的名字。
 *
 * 为什么需要这张表(2026-09-26): 第一次跑这个自检就报出 3 个"库里独有", 逐个核对后
 * 发现**都不是回退信号**, 而是历史上迁移文件被改名/重编号过:
 *   · 009_ingest_jobs.sql        → 011_minion_jobs.sql      (同一个 minion_jobs 表)
 *   · 010_external_entities.sql  → 009_external_entities_embedding.sql
 *   · 134_viz_job_file_id.sql    → 135_viz_job_file_id.sql  (同一件事, 重新编号)
 * 老的库里记的是旧名, 新造的库会记新名 —— 两者 schema 状态相同。
 *
 * 不把它们认出来的话, 这个自检就会**每次启动都报同样 3 条**, 变成又一个
 * "永远响、照做还不对"的告警(那个告警的坏处见 sync-check 那次)。
 * 但也不能静默吞掉 —— 所以下面单独计数并在日志里说明"已忽略 N 个已知改名",
 * 让人知道它们存在、且是被**有意**放过的, 而不是检查漏了。
 */
const KNOWN_RENAMED: Readonly<Record<string, string>> = Object.freeze({
  "009_ingest_jobs.sql": "011_minion_jobs.sql",
  "010_external_entities.sql": "009_external_entities_embedding.sql",
  "134_viz_job_file_id.sql": "135_viz_job_file_id.sql",
});

/**
 * schema 漂移自检 —— 库里的迁移记录 与 **本分支** 的 migrations/ 是否对得上。
 *
 * 为什么需要它(2026-09-26): `migrate()` 是**只前进**的 —— 它只看"本地有、库里没有"的迁移,
 * 补上; 而"**库里有、本地没有**"这一方向它完全不看, 也永远不会报。
 * 于是出现这个盲区: 你在带新迁移的分支上跑过服务(迁移已应用), 再切回旧分支启动 ——
 * 旧分支的迁移全都"已应用"、逐个静默跳过, 服务带着**比代码新的 schema** 起来,
 * 没有任何提示。之后的表现是零散的运行时错误(列不存在、约束冲突),
 * 而根因(schema 比代码新)**从日志里完全看不出来**。
 *
 * 这与 SAG_ROOT/data 那次是同一类坑(见 resolveMigrationsDir 上面的注释):
 * 出问题时不报错, 而是静默地做错事。
 *
 * 判定:
 *   dbOnly    库里已应用、本分支的 migrations/ 里没有 —— **这是回退信号**。
 *             旧代码面对新 schema, 是最该被看见的那一种。
 *   localOnly 本分支有、库里没应用 —— 正常情况下 migrate() 刚跑完不该出现;
 *             真出现了说明 migrationsDir 解析到了别的目录(同样是静默做错事)。
 *
 * ⚠ 不阻断启动: 与 startup-check 的既有口径一致(只有强制模式下的 JWT_SECRET 才致命)。
 *   有时你就是想用旧分支连上去看两眼 —— 那也该让你看, 但要**明确知道**风险在哪,
 *   而不是启动后从零散的报错里反推。
 */
export interface SchemaDrift {
  /** 库里已应用、本分支没有的迁移(回退信号) */
  dbOnly: string[];
  /** 本分支有、库里未应用的迁移(正常应为空) */
  localOnly: string[];
  /** 库里的迁移总数, 便于判断"是不是根本没连对库" */
  dbTotal: number;
  /** 其中属于 KNOWN_RENAMED、已判定不是漂移的那部分(仍然报出来, 不静默) */
  knownRenamed: string[];
}

export async function checkSchemaDrift(): Promise<SchemaDrift> {
  const local = (await fs.readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const localSet = new Set(local);

  const client = await pool.connect();
  try {
    // 表还不存在(全新库, 且 migrate 没跑成)时按"库为空"处理, 不抛
    const exists = await client.query("select to_regclass('public.schema_migrations') as t");
    if (!exists.rows[0]?.t) {
      return { dbOnly: [], localOnly: local, dbTotal: 0, knownRenamed: [] };
    }
    const rows = await client.query("select name from schema_migrations order by name");
    const applied: string[] = rows.rows.map((r: { name: string }) => String(r.name));
    const appliedSet = new Set(applied);
    // 只把"确实是被改名过的那几个"摘出来 —— 判据是**后继文件在本分支里真的存在**,
    //   而不是"表里有这一条"。这样白名单写错了(后继文件名打错)也不会把真漂移放过去。
    const knownRenamed: string[] = [];
    const dbOnly: string[] = [];
    for (const n of applied) {
      if (localSet.has(n)) continue;
      const successor = KNOWN_RENAMED[n];
      if (successor && localSet.has(successor)) knownRenamed.push(n);
      else dbOnly.push(n);
    }
    return {
      dbOnly,
      localOnly: local.filter((n) => !appliedSet.has(n)),
      dbTotal: applied.length,
      knownRenamed,
    };
  } finally {
    client.release();
  }
}

/**
 * 把 checkSchemaDrift 的结果打成启动日志。
 * 单独抽出来是为了让 index.ts 那边只有一行, 且这里可以独立测试输出文案。
 */
export function formatSchemaDrift(d: SchemaDrift, opts: { migrationsDir: string }): { ok: boolean; lines: string[] } {
  const legacy =
    d.knownRenamed.length > 0
      ? [`   注: 另有 ${d.knownRenamed.length} 个已知的历史改名已忽略(${d.knownRenamed.join(", ")})。`]
      : [];
  if (d.dbOnly.length) {
    return {
      ok: false,
      lines: [
        `⚠️ 数据库的 schema 比当前代码**新** —— 有 ${d.dbOnly.length} 个迁移只存在于库里:`,
        ...d.dbOnly.slice(0, 8).map((n) => `     · ${n}`),
        ...(d.dbOnly.length > 8 ? [`     … 另有 ${d.dbOnly.length - 8} 个`] : []),
        `   说明: 本分支(${opts.migrationsDir})没有这些迁移文件。`,
        `   风险: 旧代码对着新 schema 跑, 可能报"列不存在""约束冲突"这类零散错误, 而根因在此。`,
        `   处理: 切回带这些迁移的分支, 或把库恢复到与本分支匹配的状态。`,
        ...legacy,
      ],
    };
  }
  if (d.localOnly.length) {
    return {
      ok: false,
      lines: [
        `⚠️ 本分支有 ${d.localOnly.length} 个迁移**没有**应用到库里 —— migrate() 刚跑完不该出现:`,
        ...d.localOnly.slice(0, 8).map((n) => `     · ${n}`),
        `   这通常意味着 migrations/ 解析到了别的目录(实际用的是 ${opts.migrationsDir}),`,
        `   即"迁移静默什么都没做"。检查 SAG_ROOT 是否指向了预期的那棵树。`,
        ...legacy,
      ],
    };
  }
  return {
    ok: true,
    lines: [
      `✅ schema 与代码一致 (${d.dbTotal} 个迁移)` +
        (d.knownRenamed.length ? ` · 已忽略 ${d.knownRenamed.length} 个已知改名` : ""),
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(async () => closePool())
    .catch(async (error: unknown) => {
      logger.error({ error }, "migration failed");
      await closePool();
      process.exit(1);
    });
}

