// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/skill-auto-propose.test.ts — V404-8: 技能自我进化 auto_propose + 覆盖判定(V404-8)
import { describe, it, expect } from "vitest";
import { isCoveredBySkills } from "../src/services/skill-auto-propose.js";

const EXISTING = [
  { name: "文献综述生成", whenToApply: "需要写文献综述/研究现状梳理时" },
  { name: "问卷信效度分析", whenToApply: "处理问卷数据/信度效度检验时" },
];

describe("skill-auto-propose", () => {
  it("isCoveredBySkills: 关键词重叠≥2 → 覆盖; 无重叠 → 未覆盖", async () => {
    // 目标含"综述"+"研究"与文献综述技能 name/when 重叠 ≥2 → 覆盖
    const covered = await isCoveredBySkills("帮我写一篇关于资本下乡的文献综述梳理研究现状", EXISTING);
    expect(covered).toBe(true);
    // 全新主题(无技能覆盖)
    const fresh = await isCoveredBySkills("分析农村电商直播的场域理论解释", EXISTING);
    expect(fresh).toBe(false);
    // 单关键词且命中
    const single = await isCoveredBySkills("信效度检验", EXISTING);
    expect(single).toBe(true);
    // 空目标 → false(不误拦)
    expect(await isCoveredBySkills("", EXISTING)).toBe(false);
  });
});
