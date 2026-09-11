// redis-rate-limit.test.ts — Redis 后端的单元测试
//
// 真 Redis 的端到端验证是另一套(含跨进程/并发/Lua 原子性), 这里用假客户端锁住**语义**:
// 键前缀、窗口 TTL 只设一次、抢槽位的陈旧判定、归零删键、以及"连不上要降级不抛"。
import { describe, expect, it, vi } from "vitest";
import { RedisRateLimitBackend } from "../src/services/redis-rate-limit.js";

/** 假 redis 客户端: 用一个 Map 模拟, 并记录调用 */
function fakeClient() {
  const store = new Map<string, string | number>();
  const calls: Array<{ cmd: string; args: unknown[] }> = [];
  const rec = (cmd: string, ...args: unknown[]) => { calls.push({ cmd, args }); };
  return {
    isOpen: true,
    store,
    calls,
    on: vi.fn(),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
    async incr(k: string) {
      rec("incr", k);
      const v = Number(store.get(k) ?? 0) + 1;
      store.set(k, v);
      return v;
    },
    async pExpire(k: string, ms: number) { rec("pExpire", k, ms); store.set(`${k}::ttl`, ms); },
    async pTTL(k: string) { rec("pTTL", k); return Number(store.get(`${k}::ttl`) ?? -1); },
    async del(k: string) { rec("del", k); return store.delete(k) ? 1 : 0; },
    async exists(k: string) { rec("exists", k); return store.has(k) ? 1 : 0; },
    async hSet(k: string, f: string, v: string) { rec("hSet", k, f, v); store.set(`${k}::${f}`, v); return 1; },
    async hGet(k: string, f: string) { rec("hGet", k, f); return store.get(`${k}::${f}`) ?? null; },
    /** 用简化实现替代 Lua: 语义必须与被测的 Lua 一致 */
    async eval(script: string, opts: { keys: string[]; arguments: string[] }) {
      rec("eval", opts.keys[0]);
      const key = opts.keys[0];
      if (script.includes("HMGET")) {          // 抢槽位
        const limit = Number(opts.arguments[0]);
        const staleMs = Number(opts.arguments[1]);
        const now = Number(opts.arguments[2]);
        let count = Number(store.get(`${key}::count`) ?? 0);
        const ts = Number(store.get(`${key}::ts`) ?? 0);
        if (ts > 0 && now - ts > staleMs) count = 0;
        if (count >= limit) return 0;
        store.set(`${key}::count`, count + 1);
        store.set(`${key}::ts`, now);
        return count + 1;
      }
      // 释放
      const cur = Number(store.get(`${key}::count`) ?? 0);
      const nextv = cur - 1;
      if (nextv <= 0) { store.delete(`${key}::count`); store.delete(`${key}::ts`); return 0; }
      store.set(`${key}::count`, nextv);
      return nextv;
    },
  };
}

/** 注入假客户端的子类(不改生产代码: 覆写 conn) */
function backendWith(client: ReturnType<typeof fakeClient>, prefix = "sag:test:") {
  const b = new RedisRateLimitBackend("redis://fake", prefix);
  (b as unknown as { conn: () => Promise<unknown> }).conn = async () => client;
  return b;
}

describe("RedisRateLimitBackend: 窗口计数", () => {
  it("计数键带前缀与桶名, 且只在首次设置 TTL", async () => {
    const c = fakeClient();
    const b = backendWith(c);
    const r1 = await b.incr("tenant:abc", 60_000);
    const r2 = await b.incr("tenant:abc", 60_000);
    expect(r1.count).toBe(1);
    expect(r2.count).toBe(2);
    expect(c.store.has("sag:test:w:tenant:abc")).toBe(true);
    // pExpire 只应调用一次(窗口内共用一个截止时间)
    expect(c.calls.filter((x) => x.cmd === "pExpire").length).toBe(1);
    expect(r1.resetAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("TTL 丢失时补设(避免键永不过期导致计数卡死)", async () => {
    const c = fakeClient();
    const b = backendWith(c);
    await b.incr("k", 60_000);
    c.store.delete("sag:test:w:k::ttl");   // 模拟无 TTL
    await b.incr("k", 60_000);
    expect(c.calls.filter((x) => x.cmd === "pExpire").length).toBeGreaterThanOrEqual(2);
  });

  it("reset 删键", async () => {
    const c = fakeClient();
    const b = backendWith(c);
    await b.incr("k", 60_000);
    await b.reset("k", 60_000);
    expect(c.store.has("sag:test:w:k")).toBe(false);
  });
});

describe("RedisRateLimitBackend: 租户槽位", () => {
  it("抢到上限即拒(Lua 语义)", async () => {
    const c = fakeClient();
    const b = backendWith(c);
    expect(await b.acquireSlot("t1", 2, 600_000)).toBe(true);
    expect(await b.acquireSlot("t1", 2, 600_000)).toBe(true);
    expect(await b.acquireSlot("t1", 2, 600_000)).toBe(false);
  });

  it("陈旧槽位作废重来", async () => {
    const c = fakeClient();
    const b = backendWith(c);
    await b.acquireSlot("t2", 2, 600_000);
    await b.acquireSlot("t2", 2, 600_000);
    // 把时间戳推到 20 分钟前(> staleMs 10 分钟)
    c.store.set("sag:test:s:t2::ts", String(Date.now() - 20 * 60_000));
    expect(await b.acquireSlot("t2", 2, 10 * 60_000)).toBe(true);
    expect(Number(c.store.get("sag:test:s:t2::count"))).toBe(1);
  });

  it("释放递减, 归零删键", async () => {
    const c = fakeClient();
    const b = backendWith(c);
    await b.acquireSlot("t3", 5, 600_000);
    await b.releaseSlot("t3");
    expect(c.store.has("sag:test:s:t3::count")).toBe(false);
  });

  it("心跳刷新时间戳", async () => {
    const c = fakeClient();
    const b = backendWith(c);
    await b.acquireSlot("t4", 5, 600_000);
    c.store.set("sag:test:s:t4::ts", String(Date.now() - 9 * 60_000));
    await b.renewSlot("t4");
    expect(Date.now() - Number(c.store.get("sag:test:s:t4::ts"))).toBeLessThan(2000);
  });
});

describe("RedisRateLimitBackend: 环境构造", () => {
  it("未配 REDIS_URL 返回 null(调用方回退)", async () => {
    const { buildRedisBackendFromEnv } = await import("../src/services/redis-rate-limit.js");
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    expect(buildRedisBackendFromEnv()).toBeNull();
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const b = buildRedisBackendFromEnv();
    expect(b?.name).toBe("redis");
    if (saved === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = saved;
  });

  it("连不上时调用方降级, 不把异常抛给业务", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { RateLimiter, attachRateLimitBackend } = await import("../src/services/rate-limiter.js");
    const dead = new RedisRateLimitBackend("redis://127.0.0.1:1");  // 必然连不上
    attachRateLimitBackend(dead);
    const rl = new RateLimiter(60_000, 2);
    const r = await rl.checkAsync("k");   // 不应抛
    expect(r.allowed).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    attachRateLimitBackend(null);
  });
});
