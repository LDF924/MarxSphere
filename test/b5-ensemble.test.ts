// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/b5-ensemble.test.ts — V404-9 + V405-B5: B5 难档多模型互证融合(借鉴 OpenSquilla B5, 默认关闭)
// 服务层纯函数测试: B5_ENABLED 读取 / squad 预设阵容 / shouldUseB5 智能直连判定
import { describe, it, expect } from "vitest";
import { b5Squad, B5_ENABLED, b5EnsembleService, b5PresetName, shouldUseB5 } from "../src/services/b5-ensemble-service.js";

describe("b5-ensemble (V404-9)", () => {
  it("默认关闭(B5_ENABLED ≠ 1) — 不自动改全局路由的红线", () => {
    expect(B5_ENABLED).toBe(false);
  });

  it("b5Squad 默认 3 模型阵容: 2 strong + 1 cheap 锚点", () => {
    const squad = b5Squad();
    expect(squad).toEqual(["deepseek-v4-pro", "qwen3.7-max", "deepseek-v4-flash"]);
    expect(squad).toContain("deepseek-v4-flash"); // cheap 锚点控成本
    expect(squad.length).toBe(3);
  });

  it("服务面完整: 融合入口存在, 启用开关暴露", () => {
    expect(typeof b5EnsembleService.runB5Ensemble).toBe("function");
    expect(b5EnsembleService.B5_ENABLED).toBe(false);
  });
});

// V405-B5: 预设阵容 + 智能直连判定(纯函数)
describe("b5 preset & direct (V405-B5)", () => {
  it("默认 preset=default: 2 strong + 1 cheap 锚点", () => {
    expect(b5PresetName()).toBe("default");
    const squad = b5Squad();
    expect(squad.length).toBeGreaterThanOrEqual(3);
    expect(squad).toContain("deepseek-v4-flash");
  });

  it("B5_SQUAD 自定义阵容优先", () => {
    const old = process.env.B5_SQUAD;
    process.env.B5_SQUAD = "m1,m2";
    expect(b5Squad()).toEqual(["m1", "m2"]);
    expect(b5PresetName()).toBe("custom");
    process.env.B5_SQUAD = old || "";
  });

  it("shouldUseB5: B5_ENABLED=1 时难题(比较/引证/机制) true, 短问答 false", () => {
    const old = process.env.B5_ENABLED;
    process.env.B5_ENABLED = "1";
    expect(shouldUseB5("凯恩斯有效需求不足理论与马克思生产过剩危机理论的比较分析，并引用原文")).toBe(true);
    expect(shouldUseB5("请结合马克思关于资本积累的论述引用原文分析资本有机构成提高的影响机制")).toBe(true);
    expect(shouldUseB5("你好")).toBe(false);
    expect(shouldUseB5("什么是剩余价值")).toBe(false); // 短概念 → 直连
    process.env.B5_ENABLED = old || "0";
  });

  it("shouldUseB5: B5_ENABLED 未开 → 恒 false(红线: 不自动改全局路由)", () => {
    const old = process.env.B5_ENABLED;
    process.env.B5_ENABLED = "0";
    expect(shouldUseB5("凯恩斯与马克思危机理论比较分析")).toBe(false);
    process.env.B5_ENABLED = old || "0";
  });
});

