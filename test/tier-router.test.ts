// tier-router.test.ts — V405 OpenSquilla 移植 P1: 三档路由纯函数单测
// decideTier 的档位判定(题型/长度/显式模式) — 无 IO 可全量断言
import { describe, it, expect } from "vitest";
import { decideTier } from "../src/services/tier-router-service.js";

describe("decideTier", () => {
  it("政策评估恒为 deep(法条定位+引证核验)", () => {
    expect(decideTier("我国对工商资本下乡有哪些政策规定？", "policy_evaluation").level).toBe("deep");
    expect(decideTier("农村土地流转管理办法允许哪些行为", "policy_evaluation").level).toBe("deep");
  });

  it("短概念定义题(<=60字) → lite", () => {
    const d = decideTier("什么是剩余价值？", "concept_definition");
    expect(d.level).toBe("lite");
    expect(d.estimatedSavingsPct).toBe(80);
  });

  it("短事实检索题(<=60字) → lite", () => {
    expect(decideTier("《资本论》第一卷出版年份", "factual_retrieval").level).toBe("lite");
  });

  it("长概念题(>60字) → standard(需要分路检索)", () => {
    const q = "什么是剩余价值？请结合马克思在《资本论》第一卷第五章中对剩余价值生产过程与价值增殖过程的系统论述，从劳动二重性角度加以全面说明，并区分绝对剩余价值与相对剩余价值两种生产方法";
    expect(q.length).toBeGreaterThan(60);
    expect(decideTier(q, "concept_definition").level).toBe("standard");
  });

  it("普通多跳题 → standard", () => {
    expect(decideTier("结合资本循环理论分析产业资本三种职能形式的关系", "multi_hop_reasoning").level).toBe("standard");
  });

  it("长多跳题/含引证要求 → deep", () => {
    const q = "请结合马克思在《资本论》第一卷第二十三章关于资本积累的一般规律的论述，引用原文分析资本有机构成不断提高对产业后备军规模与工人命运的影响机制，并系统梳理这一过程与相对过剩人口理论之间的逻辑关系链条，给出原文出处的具体章节页码";
    expect(q.length).toBeGreaterThan(60);
    expect(decideTier(q, "multi_hop_reasoning").level).toBe("deep");
  });

  it("显式 template/adaptive(评测口径) → 恒 standard 不路由", () => {
    const d1 = decideTier("什么是剩余价值？", "concept_definition", "template");
    expect(d1.level).toBe("standard");
    expect(d1.source).toBe("default");
    const d2 = decideTier("什么是剩余价值？", "concept_definition", "adaptive");
    expect(d2.level).toBe("standard");
  });

  it("常规长题兜底 standard(非 lite 触发条件)", () => {
    const q = "请从马克思主义政治经济学的视角，系统综述学术界关于数字经济背景下劳动价值论当代发展的主要流派观点与研究进展，并比较各流派在价值创造源泉问题上的分歧";
    expect(q.length).toBeGreaterThan(60);
    expect(decideTier(q, "factual_retrieval").level).toBe("standard");
  });

  it("V405-ML: predictWithMl 资产缺失/关闭 → null 不炸", async () => {
    const { predictWithMl } = await import("../src/services/tier-router-service.js");
    // 默认 ROUTER_ENABLED 关 → mlRouterEnabled=false → 立即 null
    delete process.env.ROUTER_ENABLED;
    delete process.env.ML_ROUTER_ENABLED;
    const r = await predictWithMl("什么是剩余价值");
    expect(r).toBeNull();
  });

  it("V405-ML: decideTierHybrid 开关关时纯规则(不 spawn)", async () => {
    const { decideTierHybrid } = await import("../src/services/tier-router-service.js");
    delete process.env.ROUTER_ENABLED;
    const d = await decideTierHybrid("什么是剩余价值？", "concept_definition");
    expect(d.level).toBe("lite"); // 规则短概念
    const d2 = await decideTierHybrid("什么是剩余价值？", "concept_definition", "template");
    expect(d2.level).toBe("standard"); // 显式模式恒 standard
  });
});
