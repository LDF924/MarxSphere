// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/b5-ensemble.test.ts — V404-9: B5 难档多模型互证融合(借鉴 OpenSquilla B5, 默认关闭)
// 服务层纯函数测试: B5_ENABLED 读取 / squad 默认阵容(含 cheap 锚点)
import { describe, it, expect } from "vitest";
import { b5Squad, B5_ENABLED, b5EnsembleService } from "../src/services/b5-ensemble-service.js";

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
