// capabilities-service.test.ts — 能力探测单测(对齐 Zleap capabilities)
import { describe, expect, it, vi, beforeEach } from "vitest";

import { probeCapabilities } from "../src/services/capabilities-service.js";

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn() },
}));
vi.mock("../src/db/vector-store.js", () => ({
  getVectorStore: () => ({ health: async () => ({ ok: true }), name: "pg" }),
  getLanceDbStore: () => null,
}));
import { pool } from "../src/db/pool.js";

describe("probeCapabilities", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("PG 在线时报告 ok 且检索源可用", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const report = await probeCapabilities();
    expect(report.pg.ok).toBe(true);
    expect(report.retrievalSources.pg).toBe(true);
    expect(report.openai.search).toBe(true);
    expect(report.vectorStore.ok).toBe(true);
    expect(report.lancedb.ok).toBe(false); // 未安装
  });

  it("PG 离线时报告失败且检索源 pg=false", async () => {
    vi.mocked(pool.query).mockRejectedValue(new Error("connection refused"));
    const report = await probeCapabilities();
    expect(report.pg.ok).toBe(false);
    expect(report.retrievalSources.pg).toBe(false);
    expect(report.openai.search).toBe(false);
  });

  it("Neo4j 探测不抛错(离线返回 false)", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const report = await probeCapabilities();
    // 无论 Neo4j 是否在线, 报告结构完整且类型正确
    expect(typeof report.graphiti.ok).toBe("boolean");
    expect(typeof report.cognee.ok).toBe("boolean");
    expect(typeof report.retrievalSources.graphiti).toBe("boolean");
  });
});
