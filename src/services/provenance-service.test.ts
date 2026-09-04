// provenance-service.test.ts — 文件级溯源服务单测
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// 用临时目录做 provenance 落盘, 不碰真实 data/
const tmpRoot = path.join(os.tmpdir(), `sag-prov-test-${Date.now()}`);
process.env.SAG_ROOT = tmpRoot;

import { fileHistory, queryProvenance, recordProvenance } from "./provenance-service.js";
beforeAll(async () => {
  await fs.mkdir(path.join(tmpRoot, "data", "provenance"), { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.SAG_ROOT;
});

describe("recordProvenance", () => {
  it("写入两次同文件 → 版本递增 1,2", async () => {
    await recordProvenance({ path: "notes.md", tool: "file_write", op: "write", content: "v1", sessionId: "s1", model: "m1" });
    await recordProvenance({ path: "notes.md", tool: "file_write", op: "write", content: "v2-longer", sessionId: "s1", model: "m1" });
    const rows = await queryProvenance({ path: "notes.md" });
    expect(rows.records).toHaveLength(2);
    expect(rows.records[0].version).toBe(2);
    expect(rows.records[1].version).toBe(1);
    expect(rows.records[0].contentHash).toHaveLength(12);
    expect(rows.records[0].size).toBe(9); // "v2-longer"
  });

  it("不同文件独立计数 + 记录带时间戳", async () => {
    await recordProvenance({ path: "a.md", tool: "apply_patch", op: "patch", content: "x" });
    await recordProvenance({ path: "b.md", tool: "todo_update", op: "write", content: "y" });
    const histA = await fileHistory("a.md");
    expect(histA[0].version).toBe(1);
    expect(histA[0].tool).toBe("apply_patch");
    expect(histA[0].ts).toBeTruthy();
    const histB = await fileHistory("b.md");
    expect(histB[0].op).toBe("write");
  });

  it("queryProvenance 可按 sessionId 过滤 + 分页", async () => {
    await recordProvenance({ path: "s2.md", tool: "file_write", op: "write", content: "1", sessionId: "alpha" });
    await recordProvenance({ path: "s3.md", tool: "file_write", op: "write", content: "2", sessionId: "beta" });
    const alpha = await queryProvenance({ sessionId: "alpha" });
    expect(alpha.records.every((r) => r.sessionId === "alpha")).toBe(true);
    // 分页
    const page1 = await queryProvenance({ limit: 1 });
    expect(page1.records).toHaveLength(1);
    const page2 = await queryProvenance({ limit: 1, cursor: page1.nextCursor });
    expect(page2.records.length).toBeGreaterThanOrEqual(1);
  });

  it("带 runId 的记录采集环境快照(envHash + 内容寻址文件)", async () => {
    await recordProvenance({ path: "run-file.md", tool: "file_write", op: "write", content: "run v1", runId: "run-abc" });
    const hist = await fileHistory("run-file.md");
    expect(hist[0].runId).toBe("run-abc");
    expect(hist[0].envHash).toBeTruthy();
    // env 快照文件应存在且含 pip freeze 输出
    const { readEnvSnapshot } = await import("./provenance-service.js");
    const envText = await readEnvSnapshot(hist[0].envHash);
    expect(envText).toBeTruthy();
    expect(envText!.length).toBeGreaterThan(10);
  });
});
