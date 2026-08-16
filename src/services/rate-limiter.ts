// rate-limiter.ts — 内存限流（固定窗口, 单进程无 redis）
// 窗口按 Math.floor(now/windowMs) 的桶号, 天然自过期; 5 分钟定时清理防 Map 无限增长
export class RateLimiter {
  private buckets = new Map<string, { bucket: number; count: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private windowMs = 60_000,
    private limit = 60
  ) {}

  /** 超限返回 { allowed: false, retryAfterSec }; limit 可覆盖(per-token 用配额行值) */
  check(key: string, limitOverride?: number): { allowed: boolean; retryAfterSec: number; remaining: number } {
    const now = Date.now();
    const bucket = Math.floor(now / this.windowMs);
    const limit = limitOverride ?? this.limit;
    const entry = this.buckets.get(key);
    if (!entry || entry.bucket !== bucket) {
      this.buckets.set(key, { bucket, count: 1 });
      return { allowed: true, retryAfterSec: 0, remaining: limit - 1 };
    }
    if (entry.count >= limit) {
      const windowEnd = (bucket + 1) * this.windowMs;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((windowEnd - now) / 1000)), remaining: 0 };
    }
    entry.count += 1;
    return { allowed: true, retryAfterSec: 0, remaining: limit - entry.count };
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
}

/** 全局限流: per IP 120 次/分钟 */
export const globalRateLimiter = new RateLimiter(60_000, 120);
/** 令牌级限流: per token 60 次/分钟 (可被配额行 rate_limit_per_min 覆盖) */
export const tokenRateLimiter = new RateLimiter(60_000, 60);
/** V391(P1-3): 租户级限流 — 按租户隔离请求频率 (free 租户 30/分钟, 可按 plan 升级) */
export const tenantRateLimiter = new RateLimiter(60_000, 30);
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
