// education-compass.test.ts — Compass 记忆治理(V390, 借鉴 TraitTutor Reflection/Compass)
import { describe, it, expect } from "vitest";
import { validateComponentInstance, degradeToText } from "../src/services/material-review-service.js";

describe("组件白名单 + 答案服务端持有(TraitTutor components/validation.py)", () => {
  it("合法组件通过", () => {
    const r = validateComponentInstance({ id: "c1", title: "概念讲解", type: "concept", content: "剩余价值理论", reason: "基础", status: "pending" });
    expect(r.ok).toBe(true);
  });
  it("白名单外类型拒绝", () => {
    const r = validateComponentInstance({ id: "c1", type: "evil_component", content: "x" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("白名单");
  });
  it("答案键物理缺席(泄漏即拒)", () => {
    expect(validateComponentInstance({ id: "c1", type: "assessment", content: "x", answer: "标准答案" }).ok).toBe(false);
    expect(validateComponentInstance({ id: "c1", type: "assessment", content: "x", rubric: "评分标准" }).ok).toBe(false);
    expect(validateComponentInstance({ id: "c1", type: "assessment", content: "x", correct_answer: "B" }).ok).toBe(false);
    expect(validateComponentInstance({ id: "c1", type: "assessment", content: "x", expected_answer: "B" }).ok).toBe(false);
  });
  it("可执行标记拒绝(script/onclick/SVG)", () => {
    expect(validateComponentInstance({ id: "c1", type: "concept", content: "<script>alert(1)</script>" }).ok).toBe(false);
    expect(validateComponentInstance({ id: "c1", type: "concept", content: "点击<iframe src=x>" }).ok).toBe(false);
    expect(validateComponentInstance({ id: "c1", type: "concept", content: "<svg onload=x>" }).ok).toBe(false);
  });
  it("media_url 非白名单协议拒绝", () => {
    expect(validateComponentInstance({ id: "c1", type: "material", content: "x", media_url: "javascript:alert(1)" }).ok).toBe(false);
    expect(validateComponentInstance({ id: "c1", type: "material", content: "x", media_url: "data:text/html,x" }).ok).toBe(false);
    expect(validateComponentInstance({ id: "c1", type: "material", content: "x", media_url: "/api/asset/1.png" }).ok).toBe(true);
  });
  it("白名单外字段拒绝", () => {
    const r = validateComponentInstance({ id: "c1", type: "concept", content: "x", evil_field: "y" });
    expect(r.ok).toBe(false);
  });
  it("降级文本页(体验永不死亡)", () => {
    const d = degradeToText({ id: "c1", title: "有问题的组件", type: "assessment", content: "<script>x</script>" });
    expect(d.type).toBe("material");
    expect(String(d.content)).toContain("降级为纯文本");
  });
});
