// reason-billing.test.ts — 推理计费的回归测试(合并两份 LLM 实现前的安全网)
//
// 由来: 这段逻辑出过一次真事故 —— 写入 retrieve_steps 时只塞了 tokens 没塞 model,
//   于是 `parameters->>'model'` 恒空, 整条推理链(含 deepseek-v4-pro, 16 元/百万)
//   一律按 flash(4 元/百万)计费, 长期少收 75%。
//   而 2026-09-13 计划"合并两份 LLM 实现"会再次变更 tokens 的来源 —— 动钱之前先把口径钉住。
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/db/pool.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/services/auth-service.js", () => ({ getUserLlmConfig: vi.fn() }));
vi.mock("../src/services/billing-service.js", () => ({ chargeUser: vi.fn() }));

import { pool } from "../src/db/pool.js";
import * as authService from "../src/services/auth-service.js";
import * as billingService from "../src/services/billing-service.js";
import { chargeUserForReasonTask } from "../src/services/reason-billing.js";

const q = () => vi.mocked(pool.query as unknown as ReturnType<typeof vi.fn>);
const charge = () => vi.mocked(billingService.chargeUser as unknown as ReturnType<typeof vi.fn>);
const llmCfg = () => vi.mocked(authService.getUserLlmConfig as unknown as ReturnType<typeof vi.fn>);

beforeEach(() => {
  q().mockReset(); charge().mockReset(); llmCfg().mockReset();
  charge().mockResolvedValue({ ok: true, chargedCents: 0, reason: "ok" });
  llmCfg().mockResolvedValue({ provider: "platform" });
});

describe("推理计费: 按真实模型定价", () => {
  it("跨模型链路按各自模型分别计费(不是取单一模型)", async () => {
    // 一条链里 plan 用 pro、其余用 flash —— 取 min(model) 会只按其中一个单价算
    q().mockResolvedValueOnce({ rows: [
      { model: "deepseek-v4-pro", tin: "1000", tout: "500" },
      { model: "deepseek-v4-flash", tin: "2000", tout: "800" },
    ] });
    await chargeUserForReasonTask("u1", "task-1");
    expect(charge()).toHaveBeenCalledTimes(2);
    const calls = charge().mock.calls.map((c) => [c[1], c[2], c[3]]);
    expect(calls).toContainEqual(["deepseek-v4-pro", 1000, 500]);
    expect(calls).toContainEqual(["deepseek-v4-flash", 2000, 800]);
  });

  it("按 taskId 聚合, 且 SQL 从 parameters->>'model' 取模型名", async () => {
    q().mockResolvedValueOnce({ rows: [{ model: "deepseek-v4-flash", tin: "10", tout: "5" }] });
    await chargeUserForReasonTask("u1", "task-1");
    const [sql, params] = q().mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("from retrieve_steps");
    expect(sql).toContain("parameters->>'model'");
    expect(params).toEqual(["task-1"]);
  });
});

describe("推理计费: 不该扣的情况", () => {
  it("没有 taskId → 不查库也不扣费", async () => {
    await chargeUserForReasonTask("u1", undefined);
    expect(q()).not.toHaveBeenCalled();
    expect(charge()).not.toHaveBeenCalled();
  });

  it("token 全为 0 的行不计费", async () => {
    q().mockResolvedValueOnce({ rows: [{ model: "deepseek-v4-pro", tin: "0", tout: "0" }] });
    await chargeUserForReasonTask("u1", "task-1");
    expect(charge()).not.toHaveBeenCalled();
  });

  it("BYOK 用户的调用不扣平台余额", async () => {
    q().mockResolvedValueOnce({ rows: [{ model: "", tin: "100", tout: "50" }] });
    llmCfg().mockResolvedValue({ provider: "byok" });
    await chargeUserForReasonTask("u1", "task-1");
    expect(charge()).not.toHaveBeenCalled();
  });
});

describe("推理计费: 老数据没有 model 字段", () => {
  it("缺 model 时退回用户配置推断(平台用户 → flash)", async () => {
    q().mockResolvedValueOnce({ rows: [{ model: "", tin: "100", tout: "50" }] });
    llmCfg().mockResolvedValue({ provider: "platform" });
    await chargeUserForReasonTask("u1", "task-1");
    expect(charge()).toHaveBeenCalledTimes(1);
    expect(charge().mock.calls[0][1]).toBe("deepseek-v4-flash");
  });

  it("有 model 的行走真实模型, 不受推断影响", async () => {
    q().mockResolvedValueOnce({ rows: [
      { model: "qwen3.7-max", tin: "100", tout: "50" },
      { model: "", tin: "10", tout: "5" },
    ] });
    llmCfg().mockResolvedValue({ provider: "platform" });
    await chargeUserForReasonTask("u1", "task-1");
    const models = charge().mock.calls.map((c) => c[1]);
    expect(models).toContain("qwen3.7-max");       // 有 model 的按真实模型(60 元/百万, 别降级成 flash)
    expect(models).toContain("deepseek-v4-flash"); // 缺 model 的那行才用推断值
  });
});

describe("推理计费: 失败不阻塞", () => {
  it("查库抛错时静默吞掉(计费不能挡住推理响应)", async () => {
    q().mockRejectedValueOnce(new Error("db down"));
    await expect(chargeUserForReasonTask("u1", "task-1")).resolves.toBeUndefined();
  });

  it("chargeUser 抛错也不外传", async () => {
    q().mockResolvedValueOnce({ rows: [{ model: "deepseek-v4-pro", tin: "1", tout: "1" }] });
    charge().mockRejectedValueOnce(new Error("billing down"));
    await expect(chargeUserForReasonTask("u1", "task-1")).resolves.toBeUndefined();
  });
});
