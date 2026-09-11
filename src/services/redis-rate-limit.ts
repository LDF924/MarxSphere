// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// redis-rate-limit.ts — 限流的 Redis 后端
//
// 由来(2026-09-11): 限流计数原先只有 Postgres 一种共享实现。pg 作计数器有两个实际问题 ——
// 高频写(每个受限请求一次 upsert)会持续压在业务库上, 而且计数器与业务数据抢同一连接池。
// Redis 是这类计数的常规去处: INCR 原子、自带 TTL、不碰业务库。
//
// 语义与 PgRateLimitBackend 保持一致(同一套 RateLimitBackend 接口), 所以切换只改环境变量:
//   RATE_LIMIT_BACKEND=redis + REDIS_URL=redis://host:6379
//
// 两个刻意选择:
//   ① 计数键带窗口 TTL: 用 PEXPIRE 而不是靠固定窗口起点 —— 键自己过期, 不需要清理任务;
//   ② 抢槽位用 Lua: "读计数→判断→写回"必须原子, 否则多副本同时抢会双双成功, 并发上限形同虚设。
import { createClient, type RedisClientType } from "redis";
import type { RateLimitBackend } from "./rate-limiter.js";

/** 抢槽位脚本: 陈旧则重置为 1, 否则 +1(超上限则不动); 两种结果都刷新时间戳 */
const ACQUIRE_SLOT_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local staleMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cur = redis.call('HMGET', key, 'count', 'ts')
local count = tonumber(cur[1]) or 0
local ts = tonumber(cur[2]) or 0
if ts > 0 and (now - ts) > staleMs then count = 0 end
if count >= limit then
  return 0
end
redis.call('HSET', key, 'count', count + 1, 'ts', now)
redis.call('PEXPIRE', key, staleMs)
return count + 1
`;

/** 释放脚本: 计数减到 0 就删键(避免留下一堆 count=0 的垃圾键) */
const RELEASE_SLOT_LUA = `
local key = KEYS[1]
local cur = tonumber(redis.call('HGET', key, 'count')) or 0
local nextv = cur - 1
if nextv <= 0 then
  redis.call('DEL', key)
  return 0
end
redis.call('HSET', key, 'count', nextv)
return nextv
`;

export class RedisRateLimitBackend implements RateLimitBackend {
  readonly name = "redis";
  private client: RedisClientType | null = null;
  private connecting: Promise<RedisClientType> | null = null;

  constructor(private url: string, private keyPrefix = "sag:rl:") {}

  /** 惰性连接(启动时不一定有 Redis; 连不上则抛错, 由 backendCall 统一降级) */
  private async conn(): Promise<RedisClientType> {
    // 关键: 判"能不能用"必须看 isReady 而不是 isOpen。
    // node-redis 的 isOpen 在**建连后**一直为 true —— 服务端断开、连接对象已死时它仍然是 true,
    // 于是这里会一直返回那个死客户端, 后续每个命令都 "The client is offline", 而且**永不重连**。
    // 实测表现: 停掉 Redis 再恢复, 主后端永远切不回来、实例数探测也一直失败(而隔离脚本里却是好的,
    // 因为那边是每次新建客户端)。
    if (this.client?.isReady) return this.client;
    if (this.client && !this.client.isReady) { this.client = null; this.connecting = null; }
    if (!this.connecting) {
      const c = createClient({
        url: this.url,
        // 关键: 不给超时/不设重试上限的话, Redis 不可达时首次调用会**一直挂着** ——
        // 限流是每个请求都要过的一环, 它把请求拖住比它自己降级严重得多。
        socket: {
          connectTimeout: 1500,
          // 返回 Error 才会让 connect() 拒绝; 返回数字是无上限重试(实测: 会挂满整个请求)
          reconnectStrategy: (retries) =>
            retries >= 3 ? new Error("redis 连接失败(重试 3 次)") : Math.min(200 * retries, 1500),
        },
        // 断线时命令立即失败, 不要排队等连接(排队同样会把请求拖住)
        disableOfflineQueue: true,
      });
      // 必须有 error 监听, 否则连接错误会以未捕获异常的形式把进程打挂
      c.on("error", (e) => console.error("[rate-limit] redis 错误:", String(e).slice(0, 160)));
      this.connecting = c.connect().then(() => {
        this.client = c as RedisClientType;
        console.log(`[rate-limit] redis 已连接 (${this.url.replace(/:[^:@/]*@/, ":***@")})`);
        return this.client;
      }).catch((e) => {
        this.connecting = null;          // 允许下次重试
        void c.disconnect().catch(() => {});
        throw e;
      });
    }
    return this.connecting;
  }

  async incr(key: string, windowMs: number): Promise<{ count: number; resetAt: Date }> {
    const c = await this.conn();
    const full = `${this.keyPrefix}w:${key}`;
    // INCR 后取 TTL: 首次(返回 -1)才设过期, 保证整个窗口共用一个截止时间
    const count = await c.incr(full);
    if (count === 1) await c.pExpire(full, windowMs);
    let ttl = await c.pTTL(full);
    if (ttl < 0) {                       // 极端情形(键刚被清/无 TTL) → 补设, 避免永久计数
      await c.pExpire(full, windowMs);
      ttl = windowMs;
    }
    return { count, resetAt: new Date(Date.now() + ttl) };
  }

  async reset(key: string, windowMs: number): Promise<void> {
    void windowMs;
    const c = await this.conn();
    await c.del(`${this.keyPrefix}w:${key}`);
  }

  async acquireSlot(tenantId: string, limit: number, staleMs: number): Promise<boolean> {
    const c = await this.conn();
    const r = await c.eval(ACQUIRE_SLOT_LUA, {
      keys: [`${this.keyPrefix}s:${tenantId}`],
      arguments: [String(limit), String(staleMs), String(Date.now())],
    });
    return Number(r) > 0;
  }

  async releaseSlot(tenantId: string): Promise<void> {
    const c = await this.conn();
    await c.eval(RELEASE_SLOT_LUA, { keys: [`${this.keyPrefix}s:${tenantId}`], arguments: [] });
  }

  async renewSlot(tenantId: string): Promise<void> {
    const c = await this.conn();
    await c.hSet(`${this.keyPrefix}s:${tenantId}`, "ts", String(Date.now()));
  }

  /**
   * 实测集群实例数: 每个实例在一个有序集合里留心跳(score=时间戳), 数一跳内活跃的条数。
   * 顺带删掉过期的(防集合无限增长)。
   */
  async aliveInstances(instanceId: string, ttlMs: number): Promise<number> {
    const c = await this.conn();
    const key = `${this.keyPrefix}instances`;
    const now = Date.now();
    await c.zAdd(key, { score: now, value: instanceId });
    await c.zRemRangeByScore(key, 0, now - ttlMs * 10);   // 清过期
    const n = await c.zCount(key, now - ttlMs, now);
    return Number(n);
  }

  /** 关连接(进程退出/测试收尾) */
  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.connecting = null;
    if (c?.isOpen) await c.quit().catch(() => {});
  }

  /** 诊断用: 当前是否真的可用 */
  isReady(): boolean {
    return Boolean(this.client?.isReady);
  }
}

/** 从环境变量构造; REDIS_URL 缺失返回 null(调用方回退到 pg 或进程内) */
export function buildRedisBackendFromEnv(): RedisRateLimitBackend | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return new RedisRateLimitBackend(url, process.env.REDIS_KEY_PREFIX || "sag:rl:");
}
