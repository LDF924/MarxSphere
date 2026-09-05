// cost-ledger.test.ts — V405 OpenSquilla 移植 P0/P1: 成本账本 & 路由审计 SQL 契约单测
// 用 vi.mock(pool) 钉死 SQL 语句形状(防后续重构漂移) + 纯逻辑断言
// 覆盖: calcLedgerCostCny / getModelPrice 默认价 / recordLedger 参数映射 / routerEnabled 开关门
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db/pool.js", () => ({ pool: db }));

import { calcLedgerCostCny, recordLedger, getLedgerSummary } from "../src/services/cost-ledger-service.js";

describe("cost-ledger SQL 契约", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("calcLedgerCostCny: in/out 分价(默认 ¥2.16/8.64 每 1M)", () => {
    // 1M in × 2.16 + 500K out × 8.64 = 2.16 + 4.32 = 6.48
    expect(calcLedgerCostCny("deepseek-v4-flash", 1_000_000, 500_000)).toBeCloseTo(6.48, 4);
    expect(calcLedgerCostCny("x", 0, 0)).toBe(0);
  });

  it("recordLedger: 落 INSERT 语句且模型/用量/来源参数正确映射(fire-and-forget)", () => {
    recordLedger({
      kind: "llm", endpoint: "reason", model: "deepseek-v4-pro",
      tokensIn: 100, tokensOut: 50, tokensCacheRead: 30,
      userId: "u1", taskId: "t1", context: "stage4_hypothesis",
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("insert into llm_usage_ledger");
    expect(params).toEqual(expect.arrayContaining([
      "llm", "reason", "deepseek-v4-pro", 100, 50, 30,
      expect.any(Number), "estimate", "u1", "t1", "stage4_hypothesis",
    ]));
  });

  it("recordLedger byok: 平台零成本(cost_source=byok, cost=0)", () => {
    recordLedger({ endpoint: "reason", model: "deepseek-v4-flash", tokensIn: 1_000_000, tokensOut: 1_000_000, costSource: "byok" });
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("cost_source");
    expect(params).toContain("byok");
    // byok → 单价 0 → cost 0
    expect(params[6]).toBe(0);
  });

  it("recordLedger: tokens 负数/非法被钳到 0, 失败静默不抛", () => {
    expect(() => recordLedger({ endpoint: "e", model: "m", tokensIn: -5, tokensOut: Number.NaN })).not.toThrow();
    db.query.mockRejectedValueOnce(new Error("db down"));
    expect(() => recordLedger({ endpoint: "e", model: "m", tokensIn: 1 })).not.toThrow();
  });

  it("getLedgerSummary: 聚合 SQL 含按模型分组(审计视图数据源)", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ model: "deepseek-v4-flash", calls: 3, tin: "100", tout: "50", cache: "10", cost: "0.5" }] });
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const s = await getLedgerSummary(7);
    const firstSql = db.query.mock.calls[0][0] as string;
    expect(firstSql).toContain("from llm_usage_ledger");
    expect(firstSql).toContain("group by model");
    expect(s.byModel[0]?.model).toBe("deepseek-v4-flash");
    expect(s.byModel[0]?.costCny).toBeCloseTo(0.5, 4);
  });

  it("getLedgerSummary: 表不可用(迁移未跑) → 空降级不抛", async () => {
    db.query.mockRejectedValue(new Error('relation "llm_usage_ledger" does not exist'));
    const s = await getLedgerSummary(7);
    expect(s.totalCostCny).toBe(0);
    expect(s.byModel).toEqual([]);
  });
});

describe("routerEnabled 开关门", () => {
  it("默认关(无 env) — 行为与基线一致", async () => {
    delete process.env.ROUTER_ENABLED;
    const { routerEnabled } = await import("../src/services/tier-router-service.js");
    expect(routerEnabled()).toBe(false);
    process.env.ROUTER_ENABLED = "1";
    expect(routerEnabled()).toBe(true);
    process.env.ROUTER_ENABLED = "false";
    expect(routerEnabled()).toBe(false);
    delete process.env.ROUTER_ENABLED;
  });
});
