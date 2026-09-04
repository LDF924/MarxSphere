// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/agent-model-router.test.ts — V404-6: KV-cache 感知档位保持(sticky tier/anti-downgrade)
// 借鉴 OpenSquilla KV-cache 感知路由: 上下文窗口内见过高档 → 后续不降档(保 prompt cache)
// 真实注册表: reason=deepseek-v4-flash(cheap 档), plan=deepseek-v4-pro(strong 档)
import { describe, it, expect, beforeEach } from "vitest";
import {
  routeAgentModel, noteTierUsed, tierHoldStats, pruneTierHold, tierOfModel,
} from "../src/services/agent-model-router.js";

const FLASH = "deepseek-v4-flash"; // reason → cheap
const PRO = "deepseek-v4-pro";     // plan → strong

describe("agent-model-router V404-6", () => {
  beforeEach(() => {
    pruneTierHold(Date.now() + 999_999); // 清空 sticky(时钟推进触发全清)
  });

  it("tierOfModel: 模型名→档位", () => {
    expect(tierOfModel("deepseek-v4-flash")).toBe("cheap");
    expect(tierOfModel("deepseek-v4-pro")).toBe("strong");
    expect(tierOfModel("qwen3.7-max")).toBe("strong");
    expect(tierOfModel("qwen-plus")).toBe("standard");
    expect(tierOfModel("deepseek-chat")).toBe("standard"); // 未知保守
  });

  it("noteTierUsed 只升不降: strong 后记 strong, cheap 不覆盖", () => {
    noteTierUsed("t1", "cheap");
    noteTierUsed("t1", "strong");
    noteTierUsed("t1", "cheap"); // 不降
    const st = tierHoldStats().find((x) => x.key === "t1")!;
    expect(st.tier).toBe("strong");
  });

  it("routeAgentModel: 上下文见过 strong → retrieve(cheap)被抬到 strong(不降档)", () => {
    // 无 sticky 的上下文: retrieve → cheap 档(flash)
    const fresh = routeAgentModel("retrieve", "简单检索", { contextKey: "t-fresh" });
    expect(fresh).toContain("flash");
    // 该上下文见过 strong(plan 调用后)
    noteTierUsed("t-cache", "strong");
    const held = routeAgentModel("retrieve", "简单检索", { contextKey: "t-cache" });
    expect(held).toContain("pro"); // 被抬到 strong → plan 角色模型
    expect(held).not.toBe(fresh);
    // sticky 状态保持 strong
    expect(tierHoldStats().find((x) => x.key === "t-cache")!.tier).toBe("strong");
  });

  it("过期后 sticky 失效 → 可再次降档", () => {
    // 用短 TTL 验证: 把 AGENT_TIER_HOLD_MS 设小再测(模块顶部 env 在 import 时读取 — 需重载)
    // 直接验证 prune: 未过期保留; 过期(推进 600s+1s)清除
    noteTierUsed("t-exp", "strong");
    pruneTierHold(Date.now());
    expect(tierHoldStats().some((x) => x.key === "t-exp")).toBe(true); // 未过期保留
    pruneTierHold(Date.now() + 601_000); // TTL 600s + 1s → 过期清除
    expect(tierHoldStats().some((x) => x.key === "t-exp")).toBe(false);
  });

  it("userModel 显式指定不参与 sticky(用户覆盖优先)", () => {
    noteTierUsed("t-user", "strong");
    const m = routeAgentModel("retrieve", "x", { contextKey: "t-user", userModel: FLASH });
    expect(m.toLowerCase()).toContain("flash");
  });
});
