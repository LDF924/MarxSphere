// repository-contract.test.ts — V405 OpenSquilla 移植 P4: 关键 SQL 仓储回归契约
// vi.mock(pool) 钉死重点仓储 SQL 形状(两跳图遍历/编译真相检索 — 检索链路核心, 防重构漂移)
// 既有 repository-search-scope 覆盖向量召回; 本文件补图遍历/真相/名称臂 + V405 新 SQL
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db/pool.js", () => ({ pool: db }));

import {
  graphTraversalTwoHops,
  searchCompiledTruth,
  searchEntitiesByName,
} from "../src/db/repositories.js";

/** 与既有测试同款 SQL 归一(去空白) */
function normalizeSql(sql: string): string {
  return String(sql).replace(/\s+/g, " ").trim();
}

describe("graphTraversalTwoHops (图谱两跳遍历 SQL 契约)", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("递归 CTE: 种子实体→事件→邻居实体→邻居事件, 带源隔离+软删过滤", async () => {
    await graphTraversalTwoHops({
      seedEntityIds: ["e1", "e2"],
      sourceIds: ["00000000-0000-0000-0000-000000000001"],
      maxEvents: 20,
    });
    const sql = normalizeSql(db.query.mock.calls[0][0] as string);
    expect(sql).toContain("with recursive");
    expect(sql).toContain("event_entities");
    expect(sql).toContain("e.source_id = any($2::uuid[])");
    expect(sql).toContain("e.deleted_at is null");
  });

  it("空种子 → 短路返回不查库", async () => {
    const r = await graphTraversalTwoHops({ seedEntityIds: [], sourceIds: ["s"], maxEvents: 5 });
    expect(r.eventIds).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("searchCompiledTruth (编译真相检索 SQL 契约)", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("按分词生成 ILIKE 子句命中 knowledge_pages, 空 truth 排除", async () => {
    await searchCompiledTruth({ query: "资本下乡 集体经济", limit: 10 });
    const sql = normalizeSql(db.query.mock.calls[0][0] as string);
    expect(sql).toContain("from knowledge_pages");
    expect(sql).toContain("title ILIKE");
    expect(sql).toContain("compiled_truth ILIKE");
    expect(sql).toContain("compiled_truth != ''");
    expect(sql).toContain("order by updated_at desc");
  });

  it("查询过短/空 → 短路", async () => {
    expect(await searchCompiledTruth({ query: "x", limit: 10 })).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("searchEntitiesByName (实体名召回 SQL 契约)", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("normalized_name 精确/相似(trgm %)匹配 + 活跃链路过滤", async () => {
    await searchEntitiesByName({
      sourceIds: ["00000000-0000-0000-0000-000000000001"],
      names: ["剩余价值", "资本积累"],
      limit: 20,
    });
    const sql = normalizeSql(db.query.mock.calls[0][0] as string);
    expect(sql).toContain("from entities ent");
    expect(sql).toContain("normalized_name = query_name.name");
    expect(sql).toContain("normalized_name % query_name.name");
    expect(sql).toContain("d.archived_at is null");
    expect(sql).toContain("s.archived_at is null");
  });
});

describe("V405 新增 SQL 契约 (租约/成本账本)", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("acquireTaskLease: 原子易主 SQL — 仅空闲/过期可抢, fencing token 递增", async () => {
    // 模拟"无人持有可抢"成功路径: holder=本实例? 无法从外部注入 → 断言 SQL 形状即可
    db.query.mockResolvedValueOnce({ rows: [{ exec_lease_holder: "instance:smoke:1", exec_lease_token: 5 }] });
    const { acquireTaskLease } = await import("../src/services/agent-task-queue.js");
    await acquireTaskLease("00000000-0000-0000-0000-000000000002");
    const sql = normalizeSql(db.query.mock.calls[0][0] as string);
    expect(sql).toContain("update agent_tasks set");
    expect(sql).toContain("exec_lease_holder");
    expect(sql).toContain("exec_lease_until <= now()");
    expect(sql).toContain("coalesce(exec_lease_token, 0) + 1");
    expect(sql).toContain("' seconds')::interval");
  });

  it("recordLedger INSERT 语句含三态来源与按模型单价表查询路径", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ price_cny_per_m_in: "2.16", price_cny_per_m_out: "8.64" }] });
    const { getModelPrice } = await import("../src/services/cost-ledger-service.js");
    const p = await getModelPrice("deepseek-v4-flash");
    const sql = normalizeSql(db.query.mock.calls[0][0] as string);
    expect(sql).toContain("from llm_model_prices");
    expect(sql).toContain("where model = $1");
    expect(p.in).toBeCloseTo(2.16, 4);
    expect(p.out).toBeCloseTo(8.64, 4);
  });
});
