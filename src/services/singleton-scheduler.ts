// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// singleton-scheduler.ts — 跨副本"只跑一次"的定时任务门（leader 租约）
//
// 由来(2026-09-11 上云审计): 期刊同步(6h) / 主动研究(24h) / Dream 巩固(24h) /
// agent 评测回归(24h) / 审批超时巡检(30min) 都是每个副本各起一个定时器。
// 单机没问题; 多副本下:
//   ① 同一批数据被 N 个副本同时处理 → 重复写入/重复消耗 LLM;
//   ② 期刊同步还会触发外部站点抓取 —— N 倍请求量, 正是会被风控封的形态(历史上已被限流过)。
//
// 做法: 首次执行前抢一把 DB 租约; 抢到的那个副本刷新到期时间, 其余副本看到未过期就跳过。
// 租约到期即失效 —— 持有者崩溃后, 下一个副本的下一轮会自然接手, 不需要额外的故障转移逻辑。
//
// 失败语义: DB 不可用时**照常执行**(单机必须能用)。宁可多跑一次, 也不要因为门坏了全都不跑。
import { pool } from "../db/pool.js";

/** 租约表名固定; 主键是任务名, 见迁移 141 */
const LEASE_TTL_MS = 10 * 60_000;

/**
 * 尝试成为该任务的执行者。true = 本轮由本副本执行。
 * @param name   任务名(唯一标识, 如 "journal-sync")
 * @param ttlMs  租约有效期; 应 >= 任务最长耗时(用 interval/idle 标识更稳)
 */
export async function acquireRunLease(name: string, ttlMs = LEASE_TTL_MS): Promise<boolean> {
  // 稳定标识: 容器里 hostname = pod 名, 可读; 兜底用 pid
  const holder = `${process.env.HOSTNAME || "node"}#${process.pid}`;
  try {
    const r = await pool.query(
      `insert into scheduler_leases (name, holder, expires_at, updated_at)
       values ($1, $2, now() + ($3::int || ' milliseconds')::interval, now())
       on conflict (name) do update
         set holder = excluded.holder, expires_at = excluded.expires_at, updated_at = now()
         where scheduler_leases.expires_at < now()          -- 只在过期时抢占
       returning name`,
      [name, holder, ttlMs]
    );
    const won = (r.rowCount ?? 0) > 0;
    if (!won) {
      // 明确说明"被跳过", 否则运维只看到日志里少了一轮, 会以为是任务坏了
      const cur = await pool.query(`select holder, expires_at from scheduler_leases where name=$1`, [name]);
      const row = cur.rows[0];
      console.log(`[scheduler] ${name} 本轮跳过(由 ${row?.holder ?? "?"} 执行, 租约至 ${row?.expires_at ? new Date(row.expires_at).toISOString() : "?"})`);
    }
    return won;
  } catch (e) {
    // 门本身出问题不该让任务停摆(单机/首次建表前的场景也走这里)
    console.error(`[scheduler] ${name} 租约不可用, 本轮照常执行:`, String((e as Error)?.message || e).slice(0, 140));
    return true;
  }
}

/** 包装一个定时任务体: 抢到租约才执行 */
export function withRunLease<T>(name: string, fn: () => Promise<T>, ttlMs = LEASE_TTL_MS): () => Promise<T | undefined> {
  return async () => {
    if (!(await acquireRunLease(name, ttlMs))) return undefined;
    return fn();
  };
}
