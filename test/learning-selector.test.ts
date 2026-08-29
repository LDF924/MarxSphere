// learning-selector.test.ts — 确定性组件选择器(V392, 源码移植 TraitTutor select/_stage)
import { describe, it, expect } from "vitest";
import { determineStage, selectComponents, COMPONENT_REASON_ZH, type ComponentType, type SelectedComponent } from "../src/services/learning-selector-service.js";

const NO_AFF = { visual: false, audio: false, worked_example: false, practice: false };
const ALL_AFF = { visual: true, audio: true, worked_example: true, practice: true };

describe("determineStage(源码 _stage 四步判定)", () => {
  it("空信号 → unobserved", () => {
    expect(determineStage([])).toBe("unobserved");
  });
  it("任一 needs_support → needs_support", () => {
    expect(determineStage([{ knowledge_point: "a", support_level: "needs_support", bkt_calibrated: true, verified_observation_count: 5, mastery_probability: 0.9 }])).toBe("needs_support");
  });
  it("未校准 → unobserved", () => {
    expect(determineStage([{ knowledge_point: "a", bkt_calibrated: false, verified_observation_count: 5, mastery_probability: 0.8 }])).toBe("unobserved");
  });
  it("观察<3 → unobserved", () => {
    expect(determineStage([{ knowledge_point: "a", bkt_calibrated: true, verified_observation_count: 2, mastery_probability: 0.8 }])).toBe("unobserved");
  });
  it("min(posteriors) >= 0.75 → supported", () => {
    expect(determineStage([
      { knowledge_point: "a", bkt_calibrated: true, verified_observation_count: 4, mastery_probability: 0.9 },
      { knowledge_point: "b", bkt_calibrated: true, verified_observation_count: 5, mastery_probability: 0.8 },
    ])).toBe("supported");
  });
  it("min < 0.75 → developing", () => {
    expect(determineStage([
      { knowledge_point: "a", bkt_calibrated: true, verified_observation_count: 4, mastery_probability: 0.9 },
      { knowledge_point: "b", bkt_calibrated: true, verified_observation_count: 5, mastery_probability: 0.5 },
    ])).toBe("developing");
  });
});

describe("selectComponents(源码 select 主干分支)", () => {
  it("unobserved: concept_explanation + diagnostic_check(可选) + retrieval_card", () => {
    const comps = selectComponents({ conceptSignals: [], affordances: NO_AFF, preserved: [] });
    const types = comps.map((c) => c.component_type);
    expect(types[0]).toBe("goal_map");           // 首组件必为 goal_map
    expect(types).toContain("concept_explanation");
    expect(types).toContain("diagnostic_check");
    expect(types).toContain("retrieval_card");
    const diag = comps.find((c) => c.component_type === "diagnostic_check")!;
    expect(diag.required).toBe(false);           // 起点判断非阻塞
  });
  it("needs_support: concept_explanation + worked_example(必修)", () => {
    const comps = selectComponents({ conceptSignals: [{ knowledge_point: "a", support_level: "needs_support", bkt_calibrated: true, verified_observation_count: 4, mastery_probability: 0.3 }], affordances: NO_AFF, preserved: [] });
    const types = comps.map((c) => c.component_type);
    expect(types).toContain("concept_explanation");
    const we = comps.find((c) => c.component_type === "worked_example")!;
    expect(we.required).toBe(true);              // needs_support 的例题是必修
  });
  it("developing: guided_practice 后必跟 calibration_checkpoint(评估-校准不变量)", () => {
    const comps = selectComponents({ conceptSignals: [{ knowledge_point: "a", bkt_calibrated: true, verified_observation_count: 5, mastery_probability: 0.5 }], affordances: NO_AFF, preserved: [] });
    const types = comps.map((c) => c.component_type);
    const gpIdx = types.indexOf("guided_practice");
    expect(gpIdx).toBeGreaterThan(-1);
    expect(types[gpIdx + 1]).toBe("calibration_checkpoint");
    // 两个评分评估永不相邻: guided_practice 只有一处
    expect(types.filter((t) => t === "guided_practice").length).toBe(1);
  });
  it("supported: transfer_challenge + calibration, 无 guided_practice", () => {
    const comps = selectComponents({ conceptSignals: [{ knowledge_point: "a", bkt_calibrated: true, verified_observation_count: 5, mastery_probability: 0.9 }], affordances: NO_AFF, preserved: [] });
    const types = comps.map((c) => c.component_type);
    expect(types).toContain("transfer_challenge");
    expect(types).not.toContain("guided_practice");
    expect(types[types.indexOf("transfer_challenge") + 1]).toBe("calibration_checkpoint");
  });
  it("材料适配: 全适配时追加 worked_example/visual/audio/practice", () => {
    const comps = selectComponents({ conceptSignals: [{ knowledge_point: "a", bkt_calibrated: true, verified_observation_count: 5, mastery_probability: 0.9 }], affordances: ALL_AFF, preserved: [] });
    const types = comps.map((c) => c.component_type);
    expect(types).toContain("worked_example");
    expect(types).toContain("visual_map");
    expect(types).toContain("audio_explanation");
    // 已含 transfer_challenge → 末尾 guided_practice 被 has_assessment 抑制
    expect(types.filter((t) => t === "guided_practice").length).toBe(0);
  });
  it("preserved 含未完成评估孤儿(无校准) → 抑制追加新评估", () => {
    const comps = selectComponents({
      conceptSignals: [{ knowledge_point: "a", bkt_calibrated: true, verified_observation_count: 5, mastery_probability: 0.5 }],
      affordances: NO_AFF,
      preserved: [{ component_type: "guided_practice", status: "started", component_id: "g1" }],
    });
    const types = comps.map((c) => c.component_type);
    expect(types).not.toContain("guided_practice");  // 避免两个评分评估背靠背
    expect(types).not.toContain("transfer_challenge");
  });
  it("calibration_checkpoint 依赖紧邻评估(pending_assessment_id)", () => {
    const comps = selectComponents({ conceptSignals: [{ knowledge_point: "a", bkt_calibrated: true, verified_observation_count: 5, mastery_probability: 0.5 }], affordances: NO_AFF, preserved: [] });
    const gp = comps.find((c) => c.component_type === "guided_practice")!;
    const cal = comps.find((c) => c.component_type === "calibration_checkpoint")!;
    expect(cal.dependencies).toEqual([gp.id]);
  });
  it("preserved 前缀保留(不可变历史)", () => {
    const comps = selectComponents({
      conceptSignals: [{ knowledge_point: "a", bkt_calibrated: true, verified_observation_count: 5, mastery_probability: 0.9 }],
      affordances: NO_AFF,
      preserved: [
        { component_type: "goal_map", status: "completed", component_id: "g0" },
        { component_type: "concept_explanation", status: "completed", component_id: "c0" },
      ],
    });
    // goal_map 已在 preserved → 不重复追加
    expect(comps.filter((c) => c.component_type === "goal_map").length).toBe(0);
  });
});

describe("中文固定解释(源码 canvas-labels 照抄)", () => {
  it("14 种组件均有中文文案", () => {
    const types: ComponentType[] = ["goal_map", "concept_explanation", "worked_example", "visual_map", "video_explanation", "audio_explanation", "diagnostic_check", "guided_practice", "calibration_checkpoint", "retrieval_card", "progress_checkpoint", "reflection_prompt", "transfer_challenge", "review_queue"];
    for (const t of types) expect(COMPONENT_REASON_ZH[t]).toBeTruthy();
  });
  it("未知类型回退", () => {
    expect(COMPONENT_REASON_ZH["unknown" as any]).toBeUndefined();
  });
});
