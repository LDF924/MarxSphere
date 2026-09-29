// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// test/meta-skill-runtime.test.ts — MetaSkill 声明式 DAG 运行时(V404-4, 借鉴 OpenSquilla meta-skills)
import { describe, it, expect } from "vitest";
import {
  renderTemplate, evalCondition, topologicalOrder, validateMetaSkill, extractJson,
  runMetaSkill,
  type MetaSkillDef,
} from "../src/services/meta-skill-runtime.js";

// 假执行器: 按步骤 id 返回预设文本, 不需要真实 LLM/DB
function fakeExecutor(map: Record<string, string>, failIds: Set<string> = new Set()) {
  return async (step: any) => {
    if (failIds.has(step.id)) throw new Error(`模拟失败: ${step.id}`);
    if (map[step.id]) return map[step.id];
    if (step.kind === "llm_classify") return step.output_choices?.[0] ?? "X";
    return `【${step.id} 输出】`;
  };
}

const okDef: MetaSkillDef = {
  id: "test_flow", name: "测试流程", description: "desc", final_text_mode: "raw",
  steps: [
    { id: "input_echo", kind: "llm_chat", with: { task: "{{inputs}}" } },
    { id: "draft", kind: "llm_chat", depends_on: ["input_echo"], with: { task: "草稿: {{outputs.input_echo}}" } },
    { id: "gate", kind: "llm_gate", depends_on: ["draft"], on_failure: "draft_retry" },
    { id: "draft_retry", kind: "llm_chat", with: { task: "重写: {{outputs.draft}}" } },
  ],
};

describe("meta-skill-runtime", () => {
  it("renderTemplate: inputs/user/outputs/默认值/slice", () => {
    const ctx = { runId: "r", skillId: "s", input: "主题X", outputs: { draft: "D".repeat(100) }, userValues: { topic: "资本下乡", years: "" }, status: "running" as const };
    expect(renderTemplate("{{inputs}}", ctx)).toBe("主题X");
    expect(renderTemplate("{{user.topic}}", ctx)).toBe("资本下乡");
    expect(renderTemplate("{{outputs.draft}}", ctx)).toBe("D".repeat(100));
    expect(renderTemplate("{{user.years || '近5年'}}", ctx)).toBe("近5年");
    expect(renderTemplate("{{user.topic || '默认'}}", ctx)).toBe("资本下乡");
    expect(renderTemplate("{{outputs.draft|slice(5)}}", ctx)).toBe("DDDDD");
    expect(renderTemplate("{{nope}}", ctx)).toContain("未渲染");
  });

  it("evalCondition: == / contains / 存在 / 非", () => {
    const ctx = { runId: "r", skillId: "s", input: "", outputs: { classify: "BUG" }, userValues: {}, status: "running" as const };
    expect(evalCondition("outputs.classify == 'BUG'", ctx)).toBe(true);
    expect(evalCondition("outputs.classify == 'FEATURE'", ctx)).toBe(false);
    expect(evalCondition("outputs.classify contains 'UG'", ctx)).toBe(true);
    expect(evalCondition("outputs.classify", ctx)).toBe(true);
    expect(evalCondition("!outputs.none", ctx)).toBe(true);
    expect(evalCondition("outputs.none", ctx)).toBe(false);
  });

  it("topologicalOrder: 依赖在前的稳定序; 环检测", () => {
    const steps = [
      { id: "a", kind: "llm_chat" as const },
      { id: "b", kind: "llm_chat" as const, depends_on: ["a"] },
      { id: "c", kind: "llm_chat" as const, depends_on: ["b", "a"] },
    ];
    expect(topologicalOrder(steps).order).toEqual(["a", "b", "c"]);
    const cyclic = [{ id: "a", kind: "llm_chat" as const, depends_on: ["b"] }, { id: "b", kind: "llm_chat" as const, depends_on: ["a"] }];
    expect(topologicalOrder(cyclic).error).toContain("依赖环");
  });

  it("validateMetaSkill: 引用完整性/闭集/备胎约束", () => {
    expect(validateMetaSkill(okDef).ok).toBe(true);
    const bad = {
      id: "x", name: "x", description: "", steps: [
        { id: "a", kind: "llm_chat" as const, depends_on: ["ghost"] },
        { id: "b", kind: "llm_classify" as const }, // 缺 output_choices
        { id: "c", kind: "llm_chat" as const, on_failure: "not-exist" },
      ],
    };
    const v = validateMetaSkill(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(";")).toContain("ghost");
    expect(v.errors.join(";")).toContain("output_choices");
    expect(v.errors.join(";")).toContain("not-exist");
  });

  it("extractJson: 裸 JSON / 代码围栏 / 尾部 {", () => {
    expect(extractJson('{"pass":true}')).toEqual({ pass: true });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson("前置文字 {\"b\":2} 尾")).toEqual({ b: 2 });
    expect(extractJson("无 json")).toBeNull();
  });

  it("全步骤跑通: 拓扑序 + 模板串联 + final raw 取最后输出", async () => {
    const calls: string[] = [];
    const exe = async (step: any, ctx: any) => {
      calls.push(step.id);
      if (step.id === "input_echo") return "回显: " + ctx.input;
      if (step.id === "draft") return "草稿内容(含" + ctx.outputs.input_echo + ")";
      if (step.id === "gate") return '{"pass":true,"reason":"ok"}';
      if (step.id === "draft_retry") return "重写内容";
      return "x";
    };
    const r = await runMetaSkill(okDef, "研究主题", { stepExecutor: exe });
    expect(r.status).toBe("done");
    // 顺序: input_echo → draft → gate; draft_retry 是备胎不主动跑
    expect(calls).toEqual(["input_echo", "draft", "gate"]);
    // final_text_mode=raw → 最后一个有输出的主步骤 = gate 输出
    expect(r.output).toContain("pass");
    expect(r.stepLog.find((s) => s.stepId === "draft_retry")!.status).toBe("pending");
    expect(r.stepLog.every((s) => ["pending", "done"].includes(s.status))).toBe(true);
  });

  it("llm_gate 判定失败 → on_failure 备胎顶替", async () => {
    const exe = fakeExecutor({
      input_echo: "回显",
      draft: "草稿缺引用",
      gate: '{"pass":false,"reason":"缺引用标注"}',
      draft_retry: "重写补了(张三,2023)",
    });
    const r = await runMetaSkill(okDef, "主题", { stepExecutor: exe });
    expect(r.status).toBe("done");
    // gate 判定不过 → failed(诚实), 备胎 draft_retry 运行并顶替输出
    const gate = r.stepLog.find((s) => s.stepId === "gate")!;
    expect(gate.status).toBe("failed");
    expect(gate.error).toContain("质量门");
    expect(r.stepLog.find((s) => s.stepId === "draft_retry")!.status).toBe("done");
    expect(r.outputs.draft_retry).toContain("张三");
    expect(r.outputs.gate).toContain("重写补了"); // 备胎输出顶替 gate 步骤(下游引用 gate 时拿到修订稿)
  });

  it("主步骤抛错 → 备胎运行并成功; 输出顶原步骤", async () => {
    const def: MetaSkillDef = {
      id: "f", name: "f", description: "", final_text_mode: "raw",
      steps: [
        { id: "main", kind: "llm_chat", on_failure: "fallback" },
        { id: "fallback", kind: "llm_chat" },
      ],
    };
    const exe = async (step: any) => {
      if (step.id === "main") throw new Error("LLM 挂了");
      return "兜底结果";
    };
    const r = await runMetaSkill(def, "x", { stepExecutor: exe });
    expect(r.status).toBe("done");
    // 主步骤失败(stepLog 诚实标记 failed), 备胎完成 → 整体 done
    expect(r.stepLog.find((s) => s.stepId === "main")!.status).toBe("failed");
    expect(r.stepLog.find((s) => s.stepId === "fallback")!.status).toBe("done");
    expect(r.output).toContain("兜底结果");
  });

  it("备胎也失败 → 整体 failed, 附错误", async () => {
    const def: MetaSkillDef = {
      id: "g", name: "g", description: "",
      steps: [
        { id: "main", kind: "llm_chat", on_failure: "fallback" },
        { id: "fallback", kind: "llm_chat" },
      ],
    };
    const exe = async (step: any) => { throw new Error("总是失败"); };
    const r = await runMetaSkill(def, "x", { stepExecutor: exe });
    expect(r.status).toBe("failed");
    expect(r.stepLog.find((s) => s.stepId === "fallback")!.error).toContain("总是失败");
  });

  it("user_input 步骤: 挂起等待 → 提交值 → 续跑完成", async () => {
    const def: MetaSkillDef = {
      id: "u", name: "u", description: "", final_text_mode: "raw",
      steps: [
        {
          id: "ask", kind: "user_input",
          clarify: { fields: [{ name: "topic", type: "string", required: true, prompt: "主题" }] },
        },
        { id: "gen", kind: "llm_chat", depends_on: ["ask"], with: { task: "写: {{user.topic}}" } },
      ],
    };
    // 第一步 ask: stepExecutor 模拟"等待提交" — 用短超时+预提交
    const r = await runMetaSkill(def, "", {
      userValues: { topic: "劳动价值论" },
      stepExecutor: async (step: any, ctx: any) => {
        if (step.id === "ask") return `user.topic=${ctx.userValues.topic}`;
        return `综述: ${ctx.userValues.topic}`;
      },
    });
    expect(r.status).toBe("done");
    expect(r.output).toContain("劳动价值论");
  });

  it("user_input 无提交超时 → failed", async () => {
    const def: MetaSkillDef = {
      id: "t", name: "t", description: "",
      steps: [{ id: "ask", kind: "user_input", clarify: { fields: [{ name: "a", type: "string", required: true }] } }],
    };
    const r = await runMetaSkill(def, "", { userInputTimeoutMs: 500 });
    expect(r.status).toBe("failed");
    expect(r.stepLog.find((s) => s.stepId === "ask")!.error).toContain("等待超时");
  });

  it("resumeMetaSkillInput: 挂起运行接收提交 → 续跑完成(真实 liveRuns 通道)", async () => {
    const { resumeMetaSkillInput, listLiveRuns, getLiveRunSnapshot } = await import("../src/services/meta-skill-runtime.js");
    const def: MetaSkillDef = {
      id: "u2", name: "u2", description: "", final_text_mode: "raw",
      steps: [
        { id: "ask", kind: "user_input", clarify: { fields: [{ name: "topic", type: "string", required: true, prompt: "主题" }] } },
        { id: "gen", kind: "llm_chat", depends_on: ["ask"], with: { task: "写综述: {{user.topic}}" } },
      ],
    };
    const exe = async (step: any, ctx: any) => {
      if (step.id === "ask") throw new Error("不应执行 ask 的执行器");
      return `【综述】关于${ctx.userValues.topic}的文献综述…`;
    };
    const p = runMetaSkill(def, "", { userInputTimeoutMs: 30000, stepExecutor: exe });
    // 等挂起
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const runs = listLiveRuns();
      if (runs.length && runs[0].status === "waiting_input") break;
    }
    expect(listLiveRuns()[0]?.status).toBe("waiting_input");
    // 提交主题
    const live = listLiveRuns()[0]!;
    const snap0 = getLiveRunSnapshot(live.runId)!;
    expect(snap0.stepLog.find((s) => s.stepId === "ask")!.status).toBe("waiting_input");
    expect(snap0.stepLog.find((s) => s.stepId === "ask")!.waitingFields![0].name).toBe("topic");
    const r1 = resumeMetaSkillInput(live.runId, { topic: "数字劳动" });
    expect(r1.ok).toBe(true);
    const result = await p;
    expect(result.status).toBe("done");
    expect(result.output).toContain("数字劳动");
  });
});

/**
 * V416: 事件流(计划历史浮层的数据源)。
 *
 * 为什么必须锁: 参考产品「计划历史」展示的是**顺序** —— "先 node.diagnosed 再 node.failed"。
 *   而这份顺序在本仓是**新加的**: 原来只有 orchestrator_runs.step_log_json 的状态快照,
 *   它是 on conflict do update 整行覆盖, 同一节点的 pending→running→done 只剩最后一个。
 *   如果哪天有人把 emitEvent 去掉(它看起来"只是根日志"), 浮层会静默退化成"只有终态",
 *   而且**不会有任何报错** —— 正是本仓反复踩的那类静默失效。这里锁住事件名与顺序。
 */
describe("meta-skill-runtime 事件流(V416)", () => {
  const def: MetaSkillDef = {
    id: "ev_flow", name: "事件流测试", description: "d", final_text_mode: "raw",
    steps: [
      { id: "a", kind: "llm_chat", with: { task: "{{inputs}}" } },
      { id: "b", kind: "llm_chat", depends_on: ["a"], with: { task: "{{outputs.a}}" } },
    ],
  };

  async function runWithEvents(failIds = new Set<string>()) {
    const events: Array<{ event: string; nodeId?: string; message?: string }> = [];
    const r = await runMetaSkill(def, "输入", {
      stepExecutor: fakeExecutor({}, failIds),
      onEvent: (event, o) => events.push({ event, nodeId: o.nodeId, message: o.message }),
    });
    return { r, events };
  }

  it("成功路径: 每个节点先 node.running 后 node.done, 收尾有 job.done", async () => {
    const { r, events } = await runWithEvents();
    expect(r.status).toBe("done");
    expect(events.map((e) => e.event)).toEqual([
      "node.running", "node.done",
      "node.running", "node.done",
      "job.done",
    ]);
    expect(events.map((e) => e.nodeId)).toEqual(["a", "a", "b", "b", undefined]);
  });

  it("失败路径: node.running → node.failed, 且 message 是给用户看的中文原因", async () => {
    const { r, events } = await runWithEvents(new Set(["a"]));
    expect(r.status).toBe("failed");
    const failed = events.find((e) => e.event === "node.failed");
    expect(failed?.nodeId).toBe("a");
    expect(failed?.message).toContain("模拟失败"); // 引擎抛的是人话, 原样记
    // b 依赖 a, 应当记为 node.skipped 而不是假装跑过
    expect(events.some((e) => e.event === "node.skipped" && e.nodeId === "b")).toBe(true);
    expect(events.some((e) => e.event === "job.failed")).toBe(true);
  });

  it("不注册 onEvent 时是空操作(单测/脚本路径行为不变)", async () => {
    const r = await runMetaSkill(def, "输入", { stepExecutor: fakeExecutor({}) });
    expect(r.status).toBe("done");
    expect(r.outputs.a).toBeTruthy();
  });
});
