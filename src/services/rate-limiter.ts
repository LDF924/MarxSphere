// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// rate-limiter.ts — 限流（固定窗口）
//
// 两种模式:
//   memory  —— 进程内桶(默认; 单机部署/单元测试)。窗口按 Math.floor(now/windowMs) 的桶号,
//              天然自过期; 5 分钟定时清理防 Map 无限增长。
//   db      —— DB 计数(多副本部署)。计数行 upsert 原子累加, **所有副本共享同一配额**。
//
// 由来(2026-09-11 上云审计): 原来是纯进程内桶。多副本部署下 N 个副本各有各的桶 →
//   租户实际可用 QPS 是配置值的 N 倍, 事前拦不住、只能事后扣费。
//   DB 不可用时**降级为进程内计数**(限流是保护性功能, 不能因为它挂掉就拒绝所有请求),
//   但降级时打日志 —— 静默降级等于配额悄悄变成 N 倍。
import type { Pool } from "pg";

export type RateLimitMode = "memory" | "db";

/**
 * 计数存储后端。默认是 Postgres 实现(共享配额的那一份)。
 * 抽出来是为了让"多副本共享限流"不只认 pg —— 挂 Redis 时实现同接口、调
 * `attachRateLimitBackend(new RedisBackend(...))` 即可, 调用点一处都不用改。
 */
export interface RateLimitBackend {
  readonly name: string;
  /** 当前窗口计数 +1, 返回累加后的值与该窗口的结束时间 */
  incr(key: string, windowMs: number): Promise<{ count: number; resetAt: Date }>;
  /** 清零某个键当前窗口的计数(登录成功时用) */
  reset(key: string, windowMs: number): Promise<void>;
  /** 租户并发: 尝试占一个名额(含陈旧回收), 成功返回 true */
  acquireSlot(tenantId: string, limit: number, staleMs: number): Promise<boolean>;
  /** 租户并发: 归还一个名额 */
  releaseSlot(tenantId: string): Promise<void>;
  /** 租户并发: 心跳续期(防止长任务被误判陈旧) */
  renewSlot(tenantId: string): Promise<void>;
  /**
   * 登记本实例心跳并返回**一跳之内活跃的实例数**(用于实测集群规模)。
   * 后端自己就是共享存储, 数活跃实例不需要知道部署编排。可选: 未实现则退回 REPLICA_COUNT。
   */
  aliveInstances?(instanceId: string, ttlMs: number): Promise<number>;
  /** 清理过期窗口 */
  prune?(windowMs: number): Promise<void>;
}

// ───────── Postgres 后端(默认) ─────────

export class PgRateLimitBackend implements RateLimitBackend {
  readonly name = "pg";
  constructor(private pool: Pool) {}

  async incr(key: string, windowMs: number): Promise<{ count: number; resetAt: Date }> {
    // 窗口对齐到固定边界(与内存版同一语义): floor(now / windowMs) * windowMs
    const r = await this.pool.query(
      `insert into rate_limit_counters (key, window_start, count)
       values ($1, to_timestamp(floor(extract(epoch from now()) / ($2::bigint / 1000.0)) * ($2::bigint / 1000.0)), 1)
       on conflict (key, window_start)
       do update set count = rate_limit_counters.count + 1
       returning count, window_start`,
      [key, windowMs]
    );
    const row = r.rows[0];
    if (!row) throw new Error("限流计数未返回行");
    return { count: Number(row.count), resetAt: new Date(new Date(row.window_start).getTime() + windowMs) };
  }

  async reset(key: string, windowMs: number): Promise<void> {
    await this.pool.query(
      `delete from rate_limit_counters where key = $1 and window_start >= now() - ($2::int || ' milliseconds')::interval`,
      [key, windowMs]
    );
  }

  async acquireSlot(tenantId: string, limit: number, staleMs: number): Promise<boolean> {
    const r = await this.pool.query(
      `insert into tenant_slots (tenant_id, count, updated_at)
       values ($1, 1, now())
       on conflict (tenant_id) do update
         set count = case when tenant_slots.updated_at < now() - ($3::int || ' milliseconds')::interval
                          then 1 else tenant_slots.count + 1 end,
             updated_at = now()
         where (case when tenant_slots.updated_at < now() - ($3::int || ' milliseconds')::interval
                     then 1 else tenant_slots.count + 1 end) <= $2
       returning count`,
      [tenantId, limit, staleMs]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async releaseSlot(tenantId: string): Promise<void> {
    await this.pool.query(
      `update tenant_slots set count = greatest(0, count - 1), updated_at = now() where tenant_id = $1`,
      [tenantId]
    );
  }

  async renewSlot(tenantId: string): Promise<void> {
    await this.pool.query(`update tenant_slots set updated_at = now() where tenant_id = $1 and count > 0`, [tenantId]);
  }

  async aliveInstances(instanceId: string, ttlMs: number): Promise<number> {
    // 先登记自己(心跳), 再数一跳内活跃的条数; 过期行顺手清掉, 免得表无限增长
    await this.pool.query(
      `insert into cluster_instances (instance_id, seen_at) values ($1, now())
       on conflict (instance_id) do update set seen_at = now()`,
      [instanceId]
    );
    const r = await this.pool.query(
      `select count(*)::int as n from cluster_instances where seen_at > now() - ($1::int || ' milliseconds')::interval`,
      [ttlMs]
    );
    void this.pool.query(
      `delete from cluster_instances where seen_at < now() - ($1::int || ' milliseconds')::interval`,
      [ttlMs * 10]
    ).catch(() => { /* 清理失败不影响探测 */ });
    return Number(r.rows[0]?.n ?? 0);
  }

  async prune(windowMs: number): Promise<void> {
    await this.pool.query(
      `delete from rate_limit_counters where window_start < now() - ($1::int || ' milliseconds')::interval`,
      [windowMs * 2]
    );
  }
}

let backend: RateLimitBackend | null = null;
/** 备用后端: 主后端连续失败时自动改用它。没有它时, 主后端一挂就整体降级到进程内
 *  → 配额变 N 倍, 而且没人会注意到。有了它, 单一存储不可达只影响该存储自身, 配额仍是全局的。 */
let fallbackBackend: RateLimitBackend | null = null;
const FAILOVER_THRESHOLD = 3;

/** 配置主/备后端(启动时调用) */
export function configureRateLimitBackends(primary: RateLimitBackend | null, fallback: RateLimitBackend | null = null): void {
  backend = primary;
  fallbackBackend = fallback && fallback !== primary ? fallback : null;
  activeSide = "primary";
  consecutiveFailures = 0;
  fallbackSuccesses = 0;
  const names = [primary?.name, fallbackBackend?.name].filter(Boolean).join(" → ");
  console.log(`[rate-limit] 计数后端: ${names || "进程内(单机)"}${fallbackBackend ? "(主故障自动切换)" : ""}`);
}

/**
 * 集群实例数。
 * 用途有二: ① 启动自检据此判断"多副本却还在用本机态"; ② 后端故障降级时按它均分配额。
 *
 * 信息来源按优先级:
 *   ① 环境变量 REPLICA_COUNT(部署时声明, 最准)
 *   ② **后端实测**(见 refreshClusterSize): 限流后端自己就是共享存储, 让每个实例登记心跳、
 *      数一跳活跃实例即可 —— 不用去认 K8s 还是别的编排, 也不怕忘记声明。
 *      故障降级时后端正好不可用, 所以这里用的是"后端还健康时测到的最近一次值", 不是实时值。
 * 两个都没有时按 1(单机)。
 */
let clusterSize = Math.max(1, Number(process.env.REPLICA_COUNT) || 1);

export function clusterInstanceCount(): number {
  return clusterSize;
}

/** 降级到进程内计数时的实际配额(按实例数均分) */
export function clusterAwareLimit(limit: number): number {
  if (clusterSize <= 1) return limit;
  return Math.max(1, Math.floor(limit / clusterSize));
}

// 本实例标识(与 scheduler/queue 的持有者写法一致: 主机名 + pid)
const INSTANCE_ID = `${process.env.HOSTNAME || "node"}#${process.pid}`;

/**
 * 实测集群规模: 在后端上给每个实例留一条心跳, 数一跳之内活跃的条数。
 * 后端不可用/未接入时返回 0(调用方保持原值)。
 */
export async function refreshClusterSize(): Promise<number> {
  if (!backend?.aliveInstances) return 0;
  try {
    const n = await backend.aliveInstances(INSTANCE_ID, 60_000);
    if (n > 0) {
      if (n !== clusterSize) {
        console.log(`[rate-limit] 实测集群实例数: ${n}(配额将按此均分; 环境变量 REPLICA_COUNT=${process.env.REPLICA_COUNT ?? "未设"})`);
      }
      clusterSize = Math.max(1, n);
      return n;
    }
  } catch (e) {
    console.error("[rate-limit] 实例数探测失败(保持上次值):", String((e as Error)?.message || e).slice(0, 140));
  }
  return 0;
}

/** 启动时接入后端(在 DB 就绪之后)。保留为单后端入口, 多后端用 configureRateLimitBackends */
export function attachRateLimitBackend(b: RateLimitBackend | null): void {
  configureRateLimitBackends(b, null);
}

/** 兼容旧签名: 传一个 pg Pool */
export function attachRateLimitPool(p: Pool, enabled: boolean): void {
  attachRateLimitBackend(enabled ? new PgRateLimitBackend(p) : null);
}

export function rateLimitBackend(): string {
  return backend?.name ?? "memory";
}

/** 当前生效的后端: "primary" | "fallback" */
let activeSide: "primary" | "fallback" = "primary";
/** 当前侧连续失败次数(达到阈值就切到另一侧) */
let consecutiveFailures = 0;
/** 备用侧的成功次数: 攒够就探一次主后端(否则主恢复了也永远切不回来 —— 实测遇到的) */
let fallbackSuccesses = 0;
const PROBE_PRIMARY_AFTER = 50;

/**
 * 执行后端调用。失败处理:
 *   ① 有备用 → 连续失败达阈值就切到备用(期间单次失败仍走进程内);
 *   ② **在备用侧每成功 50 次探一次主**: 主若已恢复就切回, 否则继续用备用(不切);
 *   ③ 没备用 / 两侧都不可用 → 返回 null, 调用方降级为进程内。
 *
 * 为什么需要 ②: 只按"当前侧失败"切换的话, 主后端恢复后**永远切不回来** ——
 * 备用一直成功, 就没人去试主了。实测确认过这个状态会一直保持。
 *
 * 为什么把备援放在这一层: 计数保持全局性是**正确性**要求(降级到进程内 → 配额变 N 倍),
 * 不该指望每个调用点各自处理。
 *
 * **已知且有意的偏差**: 切换瞬间两边计数不连续 —— 切换前记在内存桶的次数, 新后端不知道。
 * 偏差有上界: 每个 key 在切换窗口内最多多放行 FAILOVER_THRESHOLD 次(到阈值就切了),
 * 之后配额恢复全局。实测: 配额 100、主坏时放行 103 次(恰好 = 阈值), 之后不再超发。
 * 要消除它得在两个存储间同步计数器(每请求双写或迁移计数), 代价远大于"一次性多放几次"。
 */
async function backendCall<T>(what: string, fn: (b: RateLimitBackend) => Promise<T>): Promise<T | null> {
  const primary = backend;
  if (!primary) return null;
  const fb = fallbackBackend;
  let active = activeSide === "fallback" && fb ? fb : primary;

  // 在备用侧攒够成功次数 → 探一次主
  if (active !== primary && fallbackSuccesses >= PROBE_PRIMARY_AFTER) {
    fallbackSuccesses = 0;
    try {
      const r = await fn(primary);
      activeSide = "primary";
      consecutiveFailures = 0;
      console.log(`[rate-limit] ${primary.name} 已恢复, 切回主后端`);
      return r;
    } catch {
      // 主还没好, 继续用备用(不记失败, 免得刚失败一次就来回切)
      active = fb!;
    }
  }

  try {
    const r = await fn(active);
    consecutiveFailures = 0;
    if (active !== primary) fallbackSuccesses++;
    return r;
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 140);
    consecutiveFailures++;
    const other = active === primary ? fb : primary;
    if (consecutiveFailures >= FAILOVER_THRESHOLD && other && other !== active) {
      console.error(`[rate-limit] ${active.name} 连续失败 ${consecutiveFailures} 次(${msg}), 改用 ${other.name}`);
      activeSide = active === primary ? "fallback" : "primary";
      consecutiveFailures = 0;
      fallbackSuccesses = 0;
    } else {
      console.error(`[rate-limit] ${what}失败(${active.name}${other && other !== active ? `, 备用 ${other.name}` : ""}), 本轮降级为进程内计数:`, msg);
    }
    return null;
  }
}

export class RateLimiter {
  private buckets = new Map<string, { bucket: number; count: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private windowMs = 60_000,
    private limit = 60,
    /** DB 键前缀(区分不同限流桶: ip / tok / tenant) */
    private keyPrefix = ""
  ) {}

  /** 进程内计数(内存模式与后端故障降级共用) */
  private memoryCheck(key: string, limit: number): { allowed: boolean; retryAfterSec: number; remaining: number } {
    const now = Date.now();
    const bucket = Math.floor(now / this.windowMs);
    const entry = this.buckets.get(key);
    if (!entry || entry.bucket !== bucket) {
      // 降级期间必须**按副本数均分配额**: 否则 3 个副本各发满 limit, 整体是 N 倍。
      // 均分会让集群整体"少发"(N 个副本合计 ≤ limit), 但在后端故障的窗口里这是安全方向 ——
      // 少发只是体验问题, 超发是计费与保护失效的问题。
      const eff = clusterAwareLimit(limit);
      this.buckets.set(key, { bucket, count: 1 });
      return { allowed: true, retryAfterSec: 0, remaining: Math.max(0, eff - 1) };
    }
    const eff = clusterAwareLimit(limit);
    if (entry.count >= eff) {
      const windowEnd = (bucket + 1) * this.windowMs;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((windowEnd - now) / 1000)), remaining: 0 };
    }
    entry.count += 1;
    return { allowed: true, retryAfterSec: 0, remaining: Math.max(0, eff - entry.count) };
  }

  /** 超限返回 { allowed: false, retryAfterSec }; limit 可覆盖(per-token 用配额行值) */
  check(key: string, limitOverride?: number): { allowed: boolean; retryAfterSec: number; remaining: number } {
    // 同步接口等不了后端 → 只做进程内预检; 真正的共享配额判定在 checkAsync
    return this.memoryCheck(key, limitOverride ?? this.limit);
  }

  /**
   * 共享配额判定(多副本的唯一真源)。后端不可用 → 退回进程内判定。
   * 调用点应是**真正要计数的请求**(LLM/检索这类有成本的操作), 不是每个 HTTP 请求。
   */
  async checkAsync(key: string, limitOverride?: number): Promise<{ allowed: boolean; retryAfterSec: number; remaining: number }> {
    const limit = limitOverride ?? this.limit;
    const r = await backendCall("计数", (b) => b.incr(`${this.keyPrefix}${key}`, this.windowMs));
    if (!r) return this.memoryCheck(key, limit); // 无后端/后端挂了 → 降级(已打日志)
    if (r.count > limit) {
      const retryAfterSec = Math.max(1, Math.ceil((r.resetAt.getTime() - Date.now()) / 1000));
      return { allowed: false, retryAfterSec, remaining: 0 };
    }
    return { allowed: true, retryAfterSec: 0, remaining: Math.max(0, limit - r.count) };
  }

  /** 每 5 分钟清理过期桶（防 Map 无限增长） */
  startCleanup(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      const currentBucket = Math.floor(now / this.windowMs);
      for (const [key, entry] of this.buckets) {
        if (entry.bucket < currentBucket - 1) this.buckets.delete(key);
      }
    }, 5 * 60_000);
    this.timer.unref?.();
  }

  /**
   * 清零某个键的计数(登录成功时用)。DB 模式下同时清掉当前窗口的行 ——
   * 否则"成功清零"只清了本副本的内存, 其他副本仍记着失败次数。
   */
  reset(key: string): void {
    this.buckets.delete(key);
    void backendCall("计数清零", (b) => b.reset(`${this.keyPrefix}${key}`, this.windowMs));
  }
}

/** 全局限流: per IP 120 次/分钟 */
export const globalRateLimiter = new RateLimiter(60_000, 120, "ip:");
/** 令牌级限流: per token 60 次/分钟 (可被配额行 rate_limit_per_min 覆盖) */
export const tokenRateLimiter = new RateLimiter(60_000, 60, "tok:");
/** V391(P1-3): 租户级限流 — 按租户隔离请求频率 (free 租户 30/分钟, 可按 plan 升级) */
export const tenantRateLimiter = new RateLimiter(60_000, 30, "tenant:");
/** V391(P1-3): 租户并发推理计数 — 并发推理/Agent 任务数按租户隔离 (free 2 并发, pro 5, enterprise 20) */
export const tenantConcurrency = new Map<string, { count: number }>();

/** V391(P1-3): 租户并发配额（按 plan） */
export function tenantConcurrencyLimit(plan: string): number {
  return plan === "enterprise" ? 20 : plan === "pro" ? 5 : 2;
}

/** V391(P1-3): 尝试获取租户并发槽位（无槽返回 false） */
export function tryAcquireTenantSlot(tenantId: string, plan: string): boolean {
  const entry = tenantConcurrency.get(tenantId) || { count: 0 };
  const limit = tenantConcurrencyLimit(plan);
  if (entry.count >= limit) return false;
  entry.count += 1;
  tenantConcurrency.set(tenantId, entry);
  return true;
}

/** V391(P1-3): 释放租户并发槽位 */
export function releaseTenantSlot(tenantId: string): void {
  const entry = tenantConcurrency.get(tenantId);
  if (entry) {
    entry.count = Math.max(0, entry.count - 1);
    if (entry.count === 0) tenantConcurrency.delete(tenantId);
  }
}

/**
 * 租户并发槽位(共享后端版)。抢不到返回 false。
 *
 * 陈旧槽位: 持有者崩溃时不会归还, 所以 updated_at 超过 STALE_SLOT_MS 的行**整体作废**
 * (count 归 1 重来) —— 与 agent/viz 的租约同一思路。否则一次崩溃会永久占掉该租户一个并发额度。
 * 活着的长任务靠 renewTenantSlotAsync 续期, 不会被误判成陈旧。
 */
export const STALE_SLOT_MS = 10 * 60_000;

/** 槽位心跳间隔(必须显著小于 STALE_SLOT_MS, 否则会在续期前就被判陈旧) */
export const SLOT_HEARTBEAT_MS = 2 * 60_000;

export async function acquireTenantSlotAsync(tenantId: string, plan: string): Promise<boolean> {
  const limit = tenantConcurrencyLimit(plan);
  const r = await backendCall("槽位判定", (b) => b.acquireSlot(tenantId, limit, STALE_SLOT_MS));
  if (r === null) return tryAcquireTenantSlot(tenantId, plan); // 无后端/后端挂了 → 降级
  return r;
}

/** 续期: 把槽位标记为"还活着"。没有它, 长推理会被别的副本误判陈旧 → 并发上限被静默突破。 */
export async function renewTenantSlotAsync(tenantId: string): Promise<void> {
  await backendCall("槽位续期", (b) => b.renewSlot(tenantId));
}

export async function releaseTenantSlotAsync(tenantId: string): Promise<void> {
  await backendCall("槽位释放", (b) => b.releaseSlot(tenantId));
}

/** 清理过期计数窗口(保留最近 2 个窗口), 由定时任务调用 */
export async function pruneRateLimitCounters(windowMs = 60_000): Promise<void> {
  await backendCall("窗口清理", (b) => b.prune ? b.prune(windowMs) : Promise.resolve());
}

