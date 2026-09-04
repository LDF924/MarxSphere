// git-snapshot-service.test.ts — git 无痕快照单测(临时仓库验证, 不碰真实分支)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { hasChanges, snapshotHistory, snapshotWorkspace } from "./git-snapshot-service.js";

let repo = "";

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "sag-snap-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, windowsHide: true });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo, windowsHide: true });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo, windowsHide: true });
  writeFileSync(path.join(repo, "base.txt"), "v1");
  execFileSync("git", ["add", "-A"], { cwd: repo, windowsHide: true });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo, windowsHide: true });
});

afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

describe("snapshotWorkspace", () => {
  it("快照未提交变更到专用 ref, 用户分支/HEAD 不动", async () => {
    writeFileSync(path.join(repo, "note.md"), "hello");
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    const branchBefore = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo }).toString().trim();
    const r = await snapshotWorkspace(repo, "test-1");
    expect(r.ok).toBe(true);
    expect(r.ref).toBe("refs/openscience/snapshots/main");
    expect(r.files).toBeGreaterThan(0);
    // 用户分支/HEAD 未动
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim()).toBe(headBefore);
    expect(execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo }).toString().trim()).toBe(branchBefore);
    // 快照历史可查
    const hist = await snapshotHistory(repo);
    expect(hist.length).toBeGreaterThan(0);
    expect(hist[0].msg).toContain("test-1");
  });

  it("无变更时不产生新快照", async () => {
    // 清理工作区(移除首个测试遗留的 untracked note.md)
    rmSync(path.join(repo, "note.md"), { force: true });
    const before = (await snapshotHistory(repo)).length;
    const r = await snapshotWorkspace(repo);
    expect(r.ok).toBe(true);
    expect(r.files).toBe(0);
    expect((await snapshotHistory(repo)).length).toBe(before);
  });

  it("hasChanges 正确报告", async () => {
    writeFileSync(path.join(repo, "note.md"), "hello");
    expect(await hasChanges(repo)).toBe(true);
    rmSync(path.join(repo, "note.md"), { force: true });
    expect(await hasChanges(repo)).toBe(false);
  });
});
