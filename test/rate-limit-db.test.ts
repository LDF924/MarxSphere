// rate-limit-db.test.ts — 多副本限流/并发槽位/already 租约门的回归测试
//
// 这几处都是"单机看不出来、多副本必坏"的: 进程内桶 N 倍配额、进程内槽位 N 倍并发、
// 每副本各跑一遍定时任务。这里锁住语义, 防止将来被改回进程内实现。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// singleton-scheduler 直接 import 真实 pool, 这里整体替换成可控替身。
// vi.mock 会被提升到文件顶部, 所以替身必须用 vi.hoisted 一起提升。
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db/pool.js", () => ({ pool: poolMock, closePool: vi.fn() }));

import { RateLimiter, attachRateLimitBackend, attachRateLimitPool, configureRateLimitBackends, clusterAwareLimit, refreshClusterSize, clusterInstanceCount, rateLimitBackend, tryAcquireTenantSlot, releaseTenantSlot, tenantConcurrencyLimit } from "../src/services/rate-limiter.js";
import { acquireRunLease, withRunLease } from "../src/services/singleton-scheduler.js";
import { loginAllowed, loginSucceeded, loginIpLimiter, loginUserLimiter } from "../src/services/login-guard.js";

/** 假后端: 只实现接口, 便于断言行为而不连库 */
function fakeBackend(over: Partial<import("../src/services/rate-limiter.js").RateLimitBackend> = {}) {
  return {
    name: "fake",
    incr: vi.fn(async () => ({ count: 1, resetAt: new Date(Date.now() + 60_000) })),
    reset: vi.fn(async () => {}),
    acquireSlot: vi.fn(async () => true),
    releaseSlot: vi.fn(async () => {}),
    renewSlot: vi.fn(async () => {}),
    prune: vi.fn(async () => {}),
    ...over,
  };
}

/** 兼容旧测试: 传 pg Pool 形状的替身 */
function fakePool(handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number } | Error) {
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      const r = handler(sql, params);
      if (r instanceof Error) throw r;
      return r;
    }),
  } as never;
}

describe("RateLimiter: 进程内模式(单机/测试默认)", () => {
  it("窗口内超限被拒, 并给出剩余等待秒数", () => {
    const rl = new RateLimiter(60_000, 3);
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(true);
    const denied = rl.check("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });

  it("limitOverride 生效(per-token 配额行可覆盖)", () => {
    const rl = new RateLimiter(60_000, 100);
    for (let i = 0; i < 5; i++) expect(rl.check("t", 5).allowed).toBe(true);
    expect(rl.check("t", 5).allowed).toBe(false);
  });

  it("不同 key 互不影响", () => {
    const rl = new RateLimiter(60_000, 1);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("b").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false);
  });

  it("reset 清零计数", () => {
    const rl = new RateLimiter(60_000, 1);
    expect(rl.check("x").allowed).toBe(true);
    expect(rl.check("x").allowed).toBe(false);
    rl.reset("x");
    expect(rl.check("x").allowed).toBe(true);
  });
});

describe("RateLimiter: 共享后端(多副本共享配额)", () => {
  afterEach(() => attachRateLimitBackend(null));

  it("计数来自后端, 超过 limit 即拒", async () => {
    attachRateLimitBackend(fakeBackend({ incr: vi.fn(async () => ({ count: 11, resetAt: new Date(Date.now() + 30_000) })) }));
    const rl = new RateLimiter(60_000, 10, "tenant:");
    const r = await rl.checkAsync("tenant:abc");
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("首次请求(count=1)放行", async () => {
    attachRateLimitBackend(fakeBackend());
    const rl = new RateLimiter(60_000, 10, "tenant:");
    const r = await rl.checkAsync("tenant:abc");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(9);
  });

  it("后端故障时降级为进程内计数, 不把请求全拒掉", async () => {
    // 限流是保护性功能: 它自己挂掉不该让服务不可用
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    attachRateLimitBackend(fakeBackend({ incr: vi.fn(async () => { throw new Error("连接被拒绝"); }) }));
    const rl = new RateLimiter(60_000, 2);
    expect((await rl.checkAsync("k")).allowed).toBe(true);   // 降级后第 1 次
    expect((await rl.checkAsync("k")).allowed).toBe(true);   // 第 2 次
    expect((await rl.checkAsync("k")).allowed).toBe(false);  // 第 3 次超限
    spy.mockRestore();
  });

  it("key 带前缀(不同桶不会互相串)", async () => {
    const incr = vi.fn(async (_key: string, _windowMs: number) => ({ count: 1, resetAt: new Date(Date.now() + 60_000) }));
    attachRateLimitBackend(fakeBackend({ incr }));
    const rl = new RateLimiter(60_000, 10, "tok:");
    await rl.checkAsync("abc");
    expect(incr.mock.calls[0][0]).toBe("tok:abc");
  });

  it("未接后端时回到进程内", async () => {
    attachRateLimitBackend(null);
    const rl = new RateLimiter(60_000, 1);
    expect((await rl.checkAsync("k")).allowed).toBe(true);
    expect((await rl.checkAsync("k")).allowed).toBe(false);
  });

  it("租户槽位走后端: 抢不到即拒, 且能续期/释放", async () => {
    const acquireSlot = vi.fn(async () => false);
    const renewSlot = vi.fn(async () => {});
    const releaseSlot = vi.fn(async () => {});
    attachRateLimitBackend(fakeBackend({ acquireSlot, renewSlot, releaseSlot }));
    const { acquireTenantSlotAsync, renewTenantSlotAsync, releaseTenantSlotAsync } = await import("../src/services/rate-limiter.js");
    expect(await acquireTenantSlotAsync("t1", "free")).toBe(false);
    await renewTenantSlotAsync("t1");
    await releaseTenantSlotAsync("t1");
    expect(renewSlot).toHaveBeenCalledWith("t1");
    expect(releaseSlot).toHaveBeenCalledWith("t1");
  });

  it("建表后端(pg)在错误时降级而不是抛给调用方", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    attachRateLimitPool(fakePool(() => new Error("boom")), true);
    const rl = new RateLimiter(60_000, 5);
    const r = await rl.checkAsync("k");
    expect(r.allowed).toBe(true); // 降级后放行
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    attachRateLimitBackend(null);
  });
});

describe("租户并发槽位(进程内)", () => {
  it("按 plan 限制并发数", () => {
    expect(tenantConcurrencyLimit("free")).toBe(2);
    expect(tenantConcurrencyLimit("pro")).toBe(5);
    expect(tenantConcurrencyLimit("enterprise")).toBe(20);
    expect(tenantConcurrencyLimit("未知")).toBe(2);
  });

  it("取满即拒, 释放后可再取", () => {
    const t = "slot-test-tenant";
    expect(tryAcquireTenantSlot(t, "free")).toBe(true);
    expect(tryAcquireTenantSlot(t, "free")).toBe(true);
    expect(tryAcquireTenantSlot(t, "free")).toBe(false);
    releaseTenantSlot(t);
    expect(tryAcquireTenantSlot(t, "free")).toBe(true);
    releaseTenantSlot(t); releaseTenantSlot(t);
  });
});

describe("login-guard: 登录爆破防护", () => {
  it("同用户名超过阈值被拒", async () => {
    loginUserLimiter.reset("u:__unit_probe__");
    loginIpLimiter.reset("ip:__unit_probe_ip__");
    let deniedAt = -1;
    for (let i = 1; i <= 12; i++) {
      const r = await loginAllowed("__unit_probe_ip__", "__unit_probe__");
      if (!r.allowed && deniedAt < 0) deniedAt = i;
    }
    // 用户名维度限 10 次 → 第 11 次被拒
    expect(deniedAt).toBe(11);
    loginUserLimiter.reset("u:__unit_probe__");
    loginIpLimiter.reset("ip:__unit_probe_ip__");
  });

  it("登录成功清零, 正常用户不会被自己之前的手误拖住", async () => {
    loginUserLimiter.reset("u:__unit_ok__");
    loginIpLimiter.reset("ip:__unit_ok_ip__");
    for (let i = 0; i < 9; i++) await loginAllowed("__unit_ok_ip__", "__unit_ok__");
    loginSucceeded("__unit_ok_ip__", "__unit_ok__");
    for (let i = 0; i < 5; i++) {
      expect((await loginAllowed("__unit_ok_ip__", "__unit_ok__")).allowed).toBe(true);
    }
    loginUserLimiter.reset("u:__unit_ok__");
    loginIpLimiter.reset("ip:__unit_ok_ip__");
  });

  it("用户名大小写归一(Admin 与 admin 同一桶)", async () => {
    loginUserLimiter.reset("u:__unit_case__");
    loginIpLimiter.reset("ip:__unit_case_ip__");
    for (let i = 0; i < 10; i++) await loginAllowed("__unit_case_ip__", "__UNIT_CASE__");
    const r = await loginAllowed("__unit_case_ip2__", "__unit_case__");
    expect(r.allowed).toBe(false);
    loginUserLimiter.reset("u:__unit_case__");
    loginIpLimiter.reset("ip:__unit_case_ip__");
    loginIpLimiter.reset("ip:__unit_case_ip2__");
  });
});

describe("singleton-scheduler: 定时任务跨副本门", () => {
  beforeEach(() => { poolMock.query.mockReset(); });

  it("抢到租约(rowCount=1)才执行任务体", async () => {
    poolMock.query.mockResolvedValueOnce({ rows: [{ name: "x" }], rowCount: 1 });
    const fn = vi.fn(async () => "跑过了");
    expect(await withRunLease("x", fn)()).toBe("跑过了");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("没抢到(rowCount=0)就跳过, 任务体不执行", async () => {
    poolMock.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                 // 抢占失败
      .mockResolvedValueOnce({ rows: [{ holder: "别的副本#1", expires_at: new Date() }], rowCount: 1 }); // 查当前持有者
    const fn = vi.fn(async () => "不该跑");
    expect(await withRunLease("x", fn)()).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it("只有租约已过期时才能抢占(where expires_at < now())", async () => {
    poolMock.query.mockResolvedValueOnce({ rows: [{ name: "x" }], rowCount: 1 });
    await acquireRunLease("x", 1000);
    const sql = String(poolMock.query.mock.calls[0][0]);
    expect(sql).toContain("where scheduler_leases.expires_at < now()");
  });

  it("DB 不可用时照常执行(门坏了不该让任务停摆)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    poolMock.query.mockRejectedValueOnce(new Error("连接被拒绝"));
    expect(await acquireRunLease("x")).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("限流后端可插拔(非 pg 后端)", () => {
  afterEach(() => attachRateLimitBackend(null));

  it("换成内存后端即可跨『副本』共享配额, 调用点不改", async () => {
    // 这个后端的存储与 pg 无关 —— 证明契约是通用的, 换 Redis 只需照抄这个形状
    const store = new Map<string, { count: number; resetAt: number }>();
    const memoryBackend: import("../src/services/rate-limiter.js").RateLimitBackend = {
      name: "memory-shared",
      async incr(key, windowMs) {
        const now = Date.now();
        const cur = store.get(key);
        if (!cur || cur.resetAt <= now) {
          const resetAt = now + windowMs;
          store.set(key, { count: 1, resetAt });
          return { count: 1, resetAt: new Date(resetAt) };
        }
        cur.count += 1;
        return { count: cur.count, resetAt: new Date(cur.resetAt) };
      },
      async reset(key) { store.delete(key); },
      async acquireSlot() { return true; },
      async releaseSlot() {},
      async renewSlot() {},
    };
    attachRateLimitBackend(memoryBackend);
    expect(rateLimitBackend()).toBe("memory-shared");

    // 两个 RateLimiter 实例(模拟两个副本各有自己的进程内桶) 共享同一后端
    const a = new RateLimiter(60_000, 3);
    const b = new RateLimiter(60_000, 3);
    const results = [
      (await a.checkAsync("k")).allowed,
      (await b.checkAsync("k")).allowed,
      (await a.checkAsync("k")).allowed,
      (await b.checkAsync("k")).allowed, // 第 4 次, 超过 3
    ];
    expect(results).toEqual([true, true, true, false]);
  });

  it("rateLimitBackend() 汇报当前后端名(诊断用)", () => {
    attachRateLimitBackend(null);
    expect(rateLimitBackend()).toBe("memory");
    attachRateLimitBackend(fakeBackend({ name: "redis" }));
    expect(rateLimitBackend()).toBe("redis");
  });
});

describe("限流后端故障自动切换(主→备)", () => {
  afterEach(() => configureRateLimitBackends(null, null));

  it("主后端连续失败达阈值后切到备用, 配额仍是全局的", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const primary = fakeBackend({ name: "primary", incr: vi.fn(async () => { throw new Error("主挂了"); }) });
    const fallback = fakeBackend({ name: "fallback", incr: vi.fn(async () => ({ count: 1, resetAt: new Date(Date.now() + 60_000) })) });
    configureRateLimitBackends(primary, fallback);
    const rl = new RateLimiter(60_000, 10);
    await rl.checkAsync("a");  // 1 次失败: 未到阈值, 这轮走进程内
    await rl.checkAsync("a");  // 2 次
    await rl.checkAsync("a");  // 3 次 → 触发切换
    expect(fallback.incr).not.toHaveBeenCalled();   // 阈值那一次仍未调用备用
    const r = await rl.checkAsync("a");             // 切换后应走备用
    expect(fallback.incr).toHaveBeenCalled();
    expect(r.allowed).toBe(true);
    spy.mockRestore();
  });

  it("备用也挂了才降级为进程内(服务仍可用)", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    const primary = fakeBackend({ name: "primary", incr: vi.fn(async () => { throw new Error("主挂了"); }) });
    const fallback = fakeBackend({ name: "fallback", incr: vi.fn(async () => { throw new Error("备也挂了"); }) });
    configureRateLimitBackends(primary, fallback);
    const rl = new RateLimiter(60_000, 10);
    for (let i = 0; i < 3; i++) await rl.checkAsync("k");   // 触发切换
    const r = await rl.checkAsync("k");
    expect(fallback.incr).toHaveBeenCalled();               // 确实改用了备用
    expect(r.allowed).toBe(true);                           // 备用也失败 → 降级, 但请求仍被放行
    expect(logs.some((l) => l.includes("备用"))).toBe(true); // 且明确说了备用不可用
    spy.mockRestore();
  });

  it("主后端恢复后会切回(否则备用一直成功就没人再试主 —— 实测遇到的)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let primaryHealthy = false;
    const primaryIncr = vi.fn(async (_k: string, _w: number) => {
      if (!primaryHealthy) throw new Error("主挂了");
      return { count: 1, resetAt: new Date(Date.now() + 60_000) };
    });
    const fallbackIncr = vi.fn(async (_k: string, _w: number) => ({ count: 1, resetAt: new Date(Date.now() + 60_000) }));
    const primary = fakeBackend({ name: "primary", incr: primaryIncr });
    const fallback = fakeBackend({ name: "fallback", incr: fallbackIncr });
    configureRateLimitBackends(primary, fallback);
    const rl = new RateLimiter(60_000, 1000);
    for (let i = 0; i < 3; i++) await rl.checkAsync("k");     // 3 次失败达阈值 → 切到备用
    await rl.checkAsync("k");                                  // 第 4 次才真正落到备用
    const callsAfterSwitch = fallbackIncr.mock.calls.length;
    expect(callsAfterSwitch).toBeGreaterThan(0);
    // 主恢复: 备用侧攒够 50 次成功后就该探回主
    primaryHealthy = true;
    for (let i = 0; i < 60; i++) await rl.checkAsync("k");
    expect(primaryIncr.mock.calls.length).toBeGreaterThan(3);   // 又被调用了 → 已切回
    spy.mockRestore();
  });

  it("没配备用时保持原行为(失败即降级)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const primary = fakeBackend({ name: "primary", incr: vi.fn(async () => { throw new Error("挂了"); }) });
    configureRateLimitBackends(primary, null);
    const rl = new RateLimiter(60_000, 1);
    expect((await rl.checkAsync("k")).allowed).toBe(true);
    expect((await rl.checkAsync("k")).allowed).toBe(false);
    spy.mockRestore();
  });
});

describe("集群实例数(实测)与降级均分", () => {
  afterEach(async () => { configureRateLimitBackends(null, null); await resetClusterSize(); });

  /** 用真实探测路径设置实例数(而不是加测试后门): 假后端报 N 个活跃实例 */
  async function setClusterSize(n: number) {
    attachRateLimitBackend(fakeBackend({ aliveInstances: async () => n }));
    await refreshClusterSize();
  }
  async function resetClusterSize() {
    attachRateLimitBackend(fakeBackend({ aliveInstances: async () => 1 }));
    await refreshClusterSize();
  }

  it("实测到 N 个实例后, 进程内降级按 N 均分配额", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await setClusterSize(4);
    // 后端不可用 → 走进程内; limit=8 在 4 实例下每个副本只应有 2
    const dead = fakeBackend({ name: "dead", incr: vi.fn(async () => { throw new Error("不可用"); }) });
    configureRateLimitBackends(dead, null);
    const rl = new RateLimiter(60_000, 8);
    const seq: boolean[] = [];
    for (let i = 0; i < 4; i++) seq.push((await rl.checkAsync("q")).allowed);
    expect(seq).toEqual([true, true, false, false]);
    spy.mockRestore();
  });

  it("单实例时不做均分(limit 原样)", async () => {
    await resetClusterSize();
    const rl = new RateLimiter(60_000, 3);
    expect([rl.check("a").allowed, rl.check("a").allowed, rl.check("a").allowed, rl.check("a").allowed])
      .toEqual([true, true, true, false]);
  });

  it("均分至少为 1(避免 limit 小于实例数时把所有人挡死)", async () => {
    await setClusterSize(10);
    expect(clusterAwareLimit(3)).toBe(1);
    await resetClusterSize();
    expect(clusterAwareLimit(3)).toBe(3);
  });
});
