// backup-service.test.ts — 备份服务纯函数单测(不依赖 docker/DB/Neo4j)
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  buildManifest,
  buildRestorePlan,
  computeSha256,
  pruneOldBackups,
} from "../src/services/backup-service.js";

// pruneOldBackups 依赖 DB — mock pool
vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn() },
}));
import { pool } from "../src/db/pool.js";

describe("pruneOldBackups", () => {
  beforeEach(() => {
    vi.mocked(pool.query).mockReset();
  });

  it("keep=0 时不清理", async () => {
    const removed = await pruneOldBackups(0);
    expect(removed).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("超出 keep 的旧备份被删除(目录+元数据)", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [
        { id: "newest", path: "/tmp/newest" },
        { id: "mid", path: "/tmp/mid" },
        { id: "oldest", path: "/tmp/oldest" },
      ],
    } as any);
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any); // delete 调用
    const removed = await pruneOldBackups(2);
    // 只删第 3 份(最旧)
    expect(removed).toEqual(["/tmp/oldest"]);
    const deleteCalls = vi.mocked(pool.query).mock.calls.filter((c) => String(c[0]).includes("delete from backups"));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][1]).toEqual(["oldest"]);
  });

  it("刚好 keep 份时不删任何备份", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [
        { id: "a", path: "/tmp/a" },
        { id: "b", path: "/tmp/b" },
        { id: "c", path: "/tmp/c" },
      ],
    } as any);
    const removed = await pruneOldBackups(3);
    expect(removed).toEqual([]);
  });
});

describe("computeSha256", () => {
  it("已知输入产生稳定哈希", () => {
    expect(computeSha256("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
  it("Buffer 与字符串结果一致", () => {
    expect(computeSha256(Buffer.from("abc"))).toBe(computeSha256("abc"));
  });
});

describe("buildManifest", () => {
  it("字段完整且符合契约", () => {
    const manifest = buildManifest({
      createdAt: "2026-09-01T00:00:00.000Z",
      schemaVersion: "001-101",
      parts: {
        "pg_data.sql": { sha256: "a".repeat(64), size: 100, rows: { documents: 3 } },
      },
      counts: { documents: 3 },
      warnings: [],
    });
    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.version).toBe(BACKUP_VERSION);
    expect(manifest.schema_version).toBe("001-101");
    expect(manifest.embedding).toEqual({ dimensions: 1024, model: "text-embedding-v4" });
    expect(manifest.includes.lancedb).toBe(false);
    expect(manifest.warnings[0]).toContain("LanceDB");
  });
  it("附加 warnings 追加到默认警告之后", () => {
    const manifest = buildManifest({
      createdAt: "t", schemaVersion: "v", parts: {}, counts: {},
      warnings: ["图谱已跳过"],
    });
    expect(manifest.warnings).toHaveLength(2);
    expect(manifest.warnings[1]).toBe("图谱已跳过");
  });
});

describe("buildRestorePlan", () => {
  it("skipped part 跳过, 正常 part 恢复", () => {
    const plan = buildRestorePlan({
      format: BACKUP_FORMAT, version: BACKUP_VERSION, created_at: "t",
      generator: { name: "SAG", version: "1.0.0" }, schema_version: "v",
      parts: {
        "pg_data.sql": { sha256: "a".repeat(64), size: 1 },
        "neo4j_graphiti.json": { sha256: "", size: 0, skipped: true },
      },
      counts: {}, embedding: { dimensions: 1024, model: "m" },
      includes: { postgres: true, graphiti: true, cognee: true, lancedb: false },
      warnings: [],
    });
    expect(plan.find((p) => p.part === "pg_data.sql")?.action).toBe("restore");
    expect(plan.find((p) => p.part === "neo4j_graphiti.json")?.action).toBe("skip");
  });
  it("缺 part 时默认恢复(不抛错)", () => {
    const plan = buildRestorePlan({
      format: BACKUP_FORMAT, version: BACKUP_VERSION, created_at: "t",
      generator: { name: "SAG", version: "1.0.0" }, schema_version: "v",
      parts: {}, counts: {}, embedding: { dimensions: 1024, model: "m" },
      includes: { postgres: true, graphiti: true, cognee: true, lancedb: false },
      warnings: [],
    });
    expect(plan).toEqual([]);
  });
});
