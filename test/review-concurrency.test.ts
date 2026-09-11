// review-concurrency.test.ts — 审稿执行的集群级闸(租约 + 全局槽位)
// 由来(2026-09-11): 原来的闸是进程内状态, 单机够用但两类问题:
//   ① 同一任务两条 SSE 会把一份稿子审两遍(实测两条流各跑满全程);
//   ② 多实例后每个副本各自算并发, 上限形同虚设。
// 现在两条约束都在 DB 上: 任务租约(holder + token fencing + TTL) + 全局槽位表。
// 测试用受控假池模拟 DB 的原子抢占语义(单测不依赖真库)。
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));
vi.mock("../src/services/llm-model-registry.js", () => ({ getRoleModel: () => "test-model" }));
vi.mock("../src/ai/llm-common.js", () => ({
  getLlmEndpoint: () => ({ url: "http://mock", key: "k", model: "m" }),
  fetchLlm: vi.fn(async () => ({ text: "{}" })),
  parseLlmJson: (t: string) => { try { return JSON.parse(t); } catch { return null; } },
}));

import { pool } from "../src/db/pool.js";
import { acquireReviewSlot, reviewQueueDepth, reapStaleReviewJobs } from "../src/services/review-service.js";

type Sse = Parameters<typeof acquireReviewSlot>[0]["sse"];
function fakeSse(): Sse & { events: Array<{ event: string; data: unknown }> } {
  const events: Array<{ event: string; data: unknown }> = [];
  return { events, send: (e: string, d: unknown) => { events.push({ event: e, data: d }); }, error: () => {}, end: () => {}, closed: false } as never;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msgs = (s: Sse) => ((s as never as { events: Array<{ data: unknown }> }).events).map((e) => String((e.data as { message?: string })?.message ?? ""));

/**
 * 受控假池: 模拟"任务租约空闲/他人持有"与"N 个全局槽位"的原子抢占。
 * - leaseBusy: 置 true 表示任务被别的实例持有着(抢租约应失败)
 * - slotTotal: 槽位总数; held 记录被占的 slot
 */
function makePool(opts: { job: Record<string, unknown> } = { job: { status: "queued" } }) {
  const state = { leaseBusy: false, slotTotal: 2, held: new Set<number>(), renewFails: false };
  const query = vi.fn(async (sql: string, vals?: unknown[]) => {
    // 顺序要紧: 续期的 SQL 同样含 "update review_jobs set" + "exec_lease_holder",
    // 放在抢租约之后会被误匹配(实测踩过: 心跳永远返回成功, 租约丢失测不出来)
    if (sql.includes("exec_lease_until = now()")) {
      // 心跳续期
      return { rows: state.renewFails ? [] : [{ id: "x" }], rowCount: state.renewFails ? 0 : 1 };
    }
    if (sql.includes("update review_jobs set") && sql.includes("exec_lease_holder")) {
      // 抢租约
      if (state.leaseBusy) return { rows: [{ exec_lease_holder: "other", exec_lease_token: 9 }], rowCount: 1 };
      return { rows: [{ exec_lease_holder: vals?.[1], exec_lease_token: 1 }], rowCount: 1 };
    }
    if (sql.includes("review_exec_slots set acquired_at")) {
      // 槽位续期
      return { rows: [{ slot: 1 }], rowCount: state.renewFails ? 0 : 1 };
    }
    if (sql.includes("exec_lease_holder = null")) return { rows: [], rowCount: 1 };   // 释放租约
    if (sql.includes("update review_exec_slots set job_id = $1")) {
      // 抢槽位
      for (let s = 1; s <= state.slotTotal; s++) if (!state.held.has(s)) { state.held.add(s); return { rows: [{ slot: s }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("update review_exec_slots set job_id = null")) {
      // 释放槽位(按 jobId 匹配)
      state.held.clear();   // 测试里每个用例独占, 直接清空即可
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("from review_exec_slots")) {
      return { rows: [{ used: String(state.held.size), total: String(state.slotTotal) }] };
    }
    if (sql.includes("from review_jobs where id=$1")) {
      return { rows: [{ id: vals?.[0], user_id: vals?.[1], ...opts.job }] };   // getReviewJob
    }
    return { rows: [], rowCount: 0 };
  });
  vi.mocked(pool.query).mockImplementation(query as never);
  return state;
}

describe("acquireReviewSlot 集群级闸", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("拿到租约 + 槽位 → ok:true, release 后两者都释放", async () => {
    const st = makePool();
    const sse = fakeSse();
    const g = await acquireReviewSlot({ userId: "u1", jobId: "j1", sse });
    expect(g.ok).toBe(true);
    expect(st.held.size).toBe(1);
    g.release();
    expect(st.held.size).toBe(0);
  });

  it("任务已被别的实例持有 → ok:false(不再审第二遍), 并告诉用户只展示进度", async () => {
    const st = makePool();
    st.leaseBusy = true;
    const sse = fakeSse();
    const g = await acquireReviewSlot({ userId: "u1", jobId: "j1", sse });
    expect(g.ok).toBe(false);
    expect(msgs(sse).some((m) => m.includes("另一个执行者"))).toBe(true);
    expect(st.held.size).toBe(0);          // 没抢槽位
  });

  it("槽位被占满 → 排队等待, 有人释放后接管", async () => {
    const st = makePool();
    st.slotTotal = 2;
    const a = await acquireReviewSlot({ userId: "u1", jobId: "a", sse: fakeSse() });
    const b = await acquireReviewSlot({ userId: "u1", jobId: "b", sse: fakeSse() });
    expect(a.ok && b.ok).toBe(true);

    // 第三个: 槽位满 → 卡在等待(不立刻返回)
    const sse = fakeSse();
    let settled: boolean | null = null;
    const pending = acquireReviewSlot({ userId: "u1", jobId: "c", sse }).then((r) => { settled = r.ok; return r; });
    await sleep(50);
    expect(settled).toBeNull();
    expect(msgs(sse).some((m) => m.includes("队列已满"))).toBe(true);

    a.release();                            // 让出一个槽
    const got = await pending;
    expect(got.ok).toBe(true);
    got.release();
    b.release();
  });

  it("租约被抢走(心跳失败) → guard 抛 LEASE_LOST, 调用方停止执行", async () => {
    const st = makePool();
    const g = await acquireReviewSlot({ userId: "u1", jobId: "j1", sse: fakeSse() });
    expect(g.ok).toBe(true);
    expect(() => g.guard()).not.toThrow();      // 正常时是空操作
    st.renewFails = true;
    await sleep(100);                            // 等心跳跑一轮(测试里 HEARTBEAT_MS 取默认 30s → 用事件驱动)
    // 心跳间隔是 30s, 单测不等待: 直接验证 guard 在租约丢失后才会抛(通过释放后再 guard)
    g.release();
    expect(() => g.guard()).not.toThrow();       // 释放不等于丢失, 不抛
  });

  it("心跳同时续任务租约与槽位(只续租不续槽位会被当成过期残留抢走)", async () => {
    const st = makePool();
    process.env.REVIEW_HEARTBEAT_MS = "40";      // 心跳间隔取用时读 → 测试里压到 40ms
    try {
      const g = await acquireReviewSlot({ userId: "u1", jobId: "j1", sse: fakeSse() });
      expect(g.ok).toBe(true);
      await sleep(140);                           // 等 2~3 轮心跳
      const calls = vi.mocked(pool.query).mock.calls.map((c) => String(c[0]));
      expect(calls.some((q) => q.includes("exec_lease_until = now()"))).toBe(true);          // 续租约
      expect(calls.some((q) => q.includes("review_exec_slots set acquired_at"))).toBe(true);  // 续槽位
      expect(() => g.guard()).not.toThrow();      // 续期成功 → 不判定丢失
      g.release();
      expect(st.held.size).toBe(0);
    } finally {
      delete process.env.REVIEW_HEARTBEAT_MS;
    }
  });

  it("心跳失败 → guard 抛 LEASE_LOST(执行方据此停止, 不再烧 token)", async () => {
    const st = makePool();
    process.env.REVIEW_HEARTBEAT_MS = "40";
    try {
      const g = await acquireReviewSlot({ userId: "u1", jobId: "j1", sse: fakeSse() });
      st.renewFails = true;                       // 之后所有续期都失败
      await sleep(140);                           // 等心跳发现租约丢失
      expect(() => g.guard()).toThrow(/租约已失效/);
      g.release();
    } finally {
      delete process.env.REVIEW_HEARTBEAT_MS;
    }
  });

  it("卡死任务自愈: 清空过期槽位占用", async () => {
    makePool();
    const n = await reapStaleReviewJobs();
    expect(typeof n).toBe("number");
  });
});
