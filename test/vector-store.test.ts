// vector-store.test.ts — 向量存储抽象单测(多存储后端, PG 真源不动)
import { describe, expect, it, vi, beforeEach } from "vitest";

import { LanceDbVectorStore, PgVectorStore, getLanceDbStore, getVectorStore } from "../src/db/vector-store.js";

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn() },
}));
import { pool } from "../src/db/pool.js";

describe("PgVectorStore", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("events 集合按向量召回", async () => {
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ id: "ev1", score: 0.9 }, { id: "ev2", score: 0.8 }],
    } as any);
    const store = new PgVectorStore();
    const rows = await store.query("events", [1, 0, 0], 10, { sourceIds: ["s1"] });
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("ev1");
    expect(rows[0].score).toBe(0.9);
  });

  it("未知集合抛错", async () => {
    const store = new PgVectorStore();
    await expect(store.query("unknown", [1], 1)).rejects.toThrow(/未知向量集合/);
  });

  it("health 返回 ok", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const store = new PgVectorStore();
    const h = await store.health();
    expect(h.ok).toBe(true);
  });

  it("upsert 抛错(PG 真源由业务表管理)", async () => {
    const store = new PgVectorStore();
    await expect(store.upsert("events", "id", [1])).rejects.toThrow(/业务表管理/);
  });
});

describe("LanceDbVectorStore", () => {
  it("未安装 lancedb 时 available=false 且 query 抛错", async () => {
    const store = new LanceDbVectorStore();
    expect(store.available).toBe(false); // 测试环境无 lancedb
    await expect(store.query("events", [1], 1)).rejects.toThrow(/未安装/);
  });

  it("getLanceDbStore 未安装返回 null", () => {
    expect(getLanceDbStore()).toBeNull();
  });
});

describe("getVectorStore", () => {
  it("默认返回 PG 实现(真源不动)", () => {
    const store = getVectorStore();
    expect(store.name).toBe("pg");
    expect(getVectorStore()).toBe(store); // 单例
  });
});
