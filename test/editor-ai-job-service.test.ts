// editor-ai-job-service.test.ts — 编辑器 AI 任务的并发护栏契约
// 背景(2026-09-11): createAiJob 此前没有任何并发上限, 连点 14 个按钮会并发打出 14 路 240s 长请求
import { describe, expect, it, vi, afterEach } from "vitest";

// 让 run() 挂起, 便于断言"任务在跑"时的并发计数(不真正调 LLM)
vi.mock("../src/services/editor-service.js", () => ({
  rewriteText: () => new Promise(() => { /* 永不 resolve */ }),
  checkFulltext: () => new Promise(() => { /* 永不 resolve */ }),
  generateTitleAbstract: () => new Promise(() => { /* 永不 resolve */ }),
  formatReferences: () => new Promise(() => { /* 永不 resolve */ }),
}));

// 积分闸门会连真实 DB(points_accounts) — 单测里必须 mock, 否则测试用户无账户会被判"积分不足"
vi.mock("../src/services/points-service.js", () => ({
  freezeCharge: async () => ({ ok: true }),
  settleCharge: async () => ({ ok: true }),
  rollbackFreeze: async () => ({ ok: true }),
}));
vi.mock("../src/services/points-gate.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/points-gate.js")>("../src/services/points-gate.js");
  return { ...actual, pointsEnabled: () => false };   // 本文件只测并发护栏, 不计积分
});

import { createAiJob, countActiveAiJobs, cancelAiJob } from "../src/services/editor-ai-job-service.js";

const U1 = "user-1";
const U2 = "user-2";
const LIMIT = Number(process.env.EDITOR_AI_MAX_CONCURRENT || 3);
/** 记录积分收尾动作类型(取消用例断言"归还"而非"核销") */
const settled: string[] = [];

/** 本测试创建的全部 job id — afterEach 统一取消, 避免模块级 jobs Map 跨用例泄漏 */
const created: Array<{ user: string; id: string }> = [];
async function make(user: string, action: string, text = "t") {
  const j = await createAiJob(user, { action, text });
  if (j) created.push({ user, id: j.id });
  return j;
}
afterEach(() => {
  for (const { user, id } of created.splice(0)) cancelAiJob(user, id);
});

describe("editor-ai-job-service 并发护栏", () => {
  it("非法 action 返回 null, 不占并发额度", async () => {
    expect(await createAiJob(U1, { action: "nope" })).toBeNull();
    expect(countActiveAiJobs(U1)).toBe(0);
  });

  it("超出每用户并发上限抛错, 错误信息含上限值", async () => {
    for (let i = 0; i < LIMIT; i++) expect(await make(U1, "rewrite")).not.toBeNull();
    expect(countActiveAiJobs(U1)).toBe(LIMIT);
    await expect(make(U1, "rewrite")).rejects.toThrow(/上限/);
  });

  it("并发额度按用户隔离(A 跑满不影响 B)", async () => {
    for (let i = 0; i < LIMIT; i++) await make(U1, "check");
    await expect(make(U1, "check")).rejects.toThrow(/上限/);
    expect(await make(U2, "check")).not.toBeNull();
    expect(countActiveAiJobs(U2)).toBe(1);
  });

  it("取消后释放额度", async () => {
    const ids: string[] = [];
    for (let i = 0; i < LIMIT; i++) ids.push((await make(U1, "title"))!.id);
    expect(countActiveAiJobs(U1)).toBe(LIMIT);
    cancelAiJob(U1, ids[0]);
    expect(countActiveAiJobs(U1)).toBe(LIMIT - 1);
    expect(await make(U1, "title")).not.toBeNull();
  });
});

// 2026-09-11 回归: 取消在途任务后, run() 跑完仍会走到收尾 ——
//   曾因 run() 无条件 `status = "done"` 覆盖, 导致"点了取消仍按成功核销积分"。
describe("editor-ai-job-service 取消语义", () => {
  it("取消后 status 保持 cancelled, 不被 run() 覆盖成 done", async () => {
    // 关键: LLM 调用必须"挂起到取消之后", 否则 run() 会在 cancelAiJob 前就收尾(测试竞态)
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    vi.resetModules();
    vi.doMock("../src/services/editor-service.js", () => ({
      rewriteText: async () => { await gate; return { text: "x" }; },
      checkFulltext: async () => ({ mode: "logic", modeName: "m", checks: [] }),
      generateTitleAbstract: async () => ({ title: "t", abstract: "", keywords: [] }),
      formatReferences: async () => ({ text: "", fixes: [] }),
    }));
    vi.doMock("../src/services/points-service.js", () => ({
      freezeCharge: async () => ({ ok: true }),
      settleCharge: async () => { settled.push("settle"); return { ok: true }; },
      rollbackFreeze: async () => { settled.push("rollback"); return { ok: true }; },
    }));
    vi.doMock("../src/services/points-gate.js", async () => {
      const actual = await vi.importActual<typeof import("../src/services/points-gate.js")>("../src/services/points-gate.js");
      return { ...actual, pointsEnabled: () => true };   // 本用例要求真的走积分分支
    });
    const mod = await import("../src/services/editor-ai-job-service.js");
    const j = await mod.createAiJob("cx", { action: "rewrite", text: "t" });
    // run 已进入 LLM 调用并挂起 → 此时取消
    mod.cancelAiJob("cx", j!.id);
    release!();                                  // 放行, 模拟"取消后 LLM 仍返回了结果"
    await new Promise((r) => setTimeout(r, 50));

    const after = mod.getAiJob("cx", j!.id);
    expect(after?.status).toBe("cancelled");
    expect(settled).toContain("rollback");
    expect(settled).not.toContain("settle");
  });
});
