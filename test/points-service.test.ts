// points-service.test.ts — SocialSci P0-8 契约测试(积分对账/签到/冻结-实扣/兑换)
// 覆盖: freeze/settle/rollback 的 SQL 结构与记账口径 / refund 对冲 / 签到防重 / redeem 防重用
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));

import { pool } from "../src/db/pool.js";
import { freezeCharge, settleCharge, rollbackFreeze, redeemCode } from "../src/services/points-service.js";

function txClient(queries: Array<() => unknown>): { query: ReturnType<typeof vi.fn>; release: () => void } {
  const q = vi.fn();
  q.mockResolvedValueOnce({}); // begin
  for (const fn of queries) q.mockImplementationOnce(fn);
  q.mockResolvedValueOnce({}); // commit
  // rollback 分支也返回 Promise(带 catch)
  q.mockResolvedValue({});
  return { query: q, release: () => {} };
}

describe("freezeCharge 冻结记账口径", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("freeze: amount=-cost(余额变化), freeze_amount=+cost(冻结总额)", async () => {
    // 注意: ensureAccount 走 pool.query(不占 client 调用); client 序列=begin/update/insert/commit
    const client = txClient([
      () => ({ rows: [{ balance: "150", frozen: "50" }] }), // update returning
      () => ({}),                                   // ledger insert
    ]);
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const r = await freezeCharge("u1", 50, "viz_job", "v1");
    expect(r.ok).toBe(true);
    const insert = client.query.mock.calls.find((c) => String(c[0]).includes("insert into points_ledger"));
    expect(insert).toBeTruthy();
    const [sql, vals] = insert as unknown as [string, unknown[]];
    expect(sql).toContain("'freeze'");      // type 是 SQL 字面量
    expect(vals[0]).toBe("u1");
    expect(vals[1]).toBe(-50);  // amount 负(余额减)
    expect(vals[2]).toBe(50);   // freeze_amount 正(总额口径)
    expect(vals[3]).toBe("viz_job");
  });

  it("余额不足: INSUFFICIENT_POINTS + rollback", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})                    // begin
        .mockResolvedValueOnce({})                    // ensureAccount
        .mockResolvedValueOnce({ rows: [] })          // update 无行(余额不足)
        .mockResolvedValueOnce({}),                   // rollback
      release: () => {},
    };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const r = await freezeCharge("u1", 999, "x", "y");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("INSUFFICIENT_POINTS");
  });
});

describe("settleCharge 核销记账口径", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("settle: amount=0(核销不动可用余额), settle_amount=+cost; 同事务含 usage 统计", async () => {
    const client = txClient([
      () => ({ rows: [{ balance: "100", frozen: "0" }] }),    // frozen 扣减
      () => ({}),                                             // ledger insert
      () => ({}),                                             // usage insert
    ]);
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const r = await settleCharge("u1", 50, "viz_job", "v1");
    expect(r.ok).toBe(true);
    const ledger = client.query.mock.calls.find((c) => String(c[0]).includes("insert into points_ledger"));
    const [sql, vals] = ledger as unknown as [string, unknown[]];
    expect(sql).toContain("'settle'");
    // 2026-09-11 回归: 核销时钱早已在 freeze 那步从 balance 划入 frozen, 本步只划走 frozen,
    //   balance 不变 → amount 必须为 0。此前记 -cost, 导致 freeze+settle 对同一笔钱
    //   各记一次余额减少, 任何按 amount 汇总的报表都双倍计费。
    expect(vals[1]).toBe(0);
    expect(vals[2]).toBe(50); // settle_amount 才是"本次核销多少"
    const usage = client.query.mock.calls.find((c) => String(c[0]).includes("points_usage_daily"));
    expect(usage).toBeTruthy();
  });
});

describe("rollbackFreeze 归还对冲", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("refund 行以 freeze_amount=-cost 对冲原冻结", async () => {
    const client = txClient([
      () => ({ rows: [{ balance: "100", frozen: "30" }] }),        // frozen 扣减
      () => ({}),                                                  // balance 加回
      () => ({}),                                                  // ledger insert
    ]);
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const r = await rollbackFreeze("u1", 30, "review_job", "r1");
    expect(r.ok).toBe(true);
    const ledger = client.query.mock.calls.find((c) => String(c[0]).includes("insert into points_ledger"));
    const [sql, vals] = ledger as unknown as [string, unknown[]];
    expect(sql).toContain("'refund'");
    expect(vals[1]).toBe(30);      // amount 正(归还入账)
    expect(vals[2]).toBe(-30);     // freeze_amount 负(对冲)
  });

  // 2026-09-11 回归: pg 返回的 numeric 是字符串, `"100" + 30` 会拼接成 "10030"
  it("balance_after 必须是数值相加(不是字符串拼接)", async () => {
    const client = txClient([
      () => ({ rows: [{ balance: "600", frozen: "30" }] }),        // frozen 扣减(字符串余额)
      () => ({}),                                                  // balance 加回
      () => ({}),                                                  // ledger insert
    ]);
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    await rollbackFreeze("u1", 30, "editor:title", "r2");
    const ledger = client.query.mock.calls.find((c) => String(c[0]).includes("insert into points_ledger"));
    const vals = (ledger as unknown as [string, unknown[]])[1];
    expect(typeof vals[5]).toBe("number");   // balance_after
    expect(vals[5]).toBe(630);               // 而不是 "60030"
  });
});

describe("redeemCode 防重用", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("已用兑换码拒绝", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})  // begin
        .mockResolvedValueOnce({ rows: [{ code: "X1", points: 100, used_by: "other-user" }] }) // select for update
        .mockResolvedValueOnce({})  // rollback
        .mockResolvedValueOnce({}), // release 后无
      release: () => {},
    };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const r = await redeemCode("u1", "X1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("已被使用");
  });
});
