// research-pipeline-service.test.ts — SocialSci P0-1 契约测试(迁移114/115)
// 覆盖: DAG五阶段模板结构 / NL→DAG 强制首尾 / 任务控制状态机 / putNode乐观覆盖语义 / 版本指针快照结构
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));
vi.mock("../src/services/llm-model-registry.js", () => ({
  getRoleModel: () => "test-model",
}));
vi.mock("../src/ai/llm-common.js", () => ({
  getLlmEndpoint: () => ({ url: "http://mock", key: "k", model: "m" }),
  // 必须是 vi.fn: 下面的用例要按需改返回(默认 {} = 模型什么都没分析出来)
  fetchLlm: vi.fn(async () => ({ text: "{}" })),
  parseLlmJson: (t: string) => { try { return JSON.parse(t); } catch { return null; } },
}));

import { pool } from "../src/db/pool.js";
import * as llmCommon from "../src/ai/llm-common.js";
import {
  dagTemplateFiveStage,
  nlToDag,
  controlTask,
  putNode,
  runMainAgentAnalysis,
} from "../src/services/research-pipeline-service.js";

function mockTask(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "t1", project_id: "p1", user_id: "u1", dag_node_id: "n1",
    module: "workflow", job_kind: "analyze", phase: 0, goal: "",
    depends_on: [], plan: [], input_snapshot: null, retry_of: null,
    status, ...extra,
  };
}

describe("dagTemplateFiveStage", () => {
  it("五阶段模板: 10 节点含目标/交付终点, 9 条顺连边", () => {
    const c = dagTemplateFiveStage("数字经济课题");
    expect(c.nodes).toHaveLength(10);
    expect(c.nodes[0].type).toBe("goal");
    expect(c.nodes[0].data.label).toContain("数字经济课题");
    expect(c.nodes[9].type).toBe("end");
    expect(c.edges).toHaveLength(9);
    // 边首尾衔接
    for (let i = 0; i < c.edges.length; i++) {
      expect(c.edges[i].source).toBe(c.nodes[i].id);
      expect(c.edges[i].target).toBe(c.nodes[i + 1].id);
    }
    // 位置纵向排布
    expect(c.nodes[1].position.y).toBeGreaterThan(c.nodes[0].position.y);
  });
});

describe("nlToDag", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("AI 返回空 steps 时报结构化错误", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const r = await nlToDag("u1", "p1", "研究共同富裕");
    expect("error" in r).toBe(true);
  });
});

describe("controlTask 状态机", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("cancel: running→cancelled", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [mockTask("running")] } as any);
    const r = await controlTask("u1", "t1", "cancel");
    expect(r?.status).toBe("cancelled");
  });

  it("pause: queued→paused; resume: paused→queued", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [mockTask("queued")] } as any);
    expect((await controlTask("u1", "t1", "pause"))?.status).toBe("paused");
    vi.mocked(pool.query).mockReset();
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [mockTask("paused")] } as any);
    expect((await controlTask("u1", "t1", "resume"))?.status).toBe("queued");
  });

  it("retry: 非失败态不动作; 失败态建 retry_of 子任务", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [mockTask("running")] } as any);
    const r = await controlTask("u1", "t1", "retry");
    expect(r?.id).toBe("t1"); // 原样返回
    // 失败态: getTask 一次 + insert 一次
    vi.mocked(pool.query).mockReset();
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [mockTask("failed")] } as any)
      .mockResolvedValueOnce({ rows: [{ id: "new-1" }] } as any);
    const r2 = await controlTask("u1", "t1", "retry");
    expect(r2?.id).not.toBe("t1"); // 新 uuid 子任务
    expect(r2?.status).toBe("queued");
    expect(r2?.retry_of).toBe("t1");
  });
});

describe("putNode 乐观覆盖", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("节点已存在: 当前 payload 进历史 + version 递增", async () => {
    // 事务 client: begin/owned/select for update/select payload/insert history/update/commit
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // begin
        .mockResolvedValueOnce({ rows: [{ id: "p1" }] }) // owned
        .mockResolvedValueOnce({ rows: [{ id: "node1", version: 3 }] }) // for update
        .mockResolvedValueOnce({ rows: [{ payload: '{"old":1}' }] }) // 当前 payload
        .mockResolvedValueOnce({}) // insert history
        .mockResolvedValueOnce({}) // update
        .mockResolvedValueOnce({}), // commit
      release: vi.fn(),
    };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const r = await putNode("u1", "p1", "analysis", { new: 2 }, { sourceRole: "agent" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.version).toBe(4);
    // 历史行写入调用存在
    const calls = client.query.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes("insert into research_node_history"))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it("节点不存在: 新建 version=1", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // begin
        .mockResolvedValueOnce({ rows: [{ id: "p1" }] }) // owned
        .mockResolvedValueOnce({ rows: [] }) // for update 无
        .mockResolvedValueOnce({ rows: [{ id: "node-new" }] }) // insert
        .mockResolvedValueOnce({}), // commit
      release: vi.fn(),
    };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const r = await putNode("u1", "p1", "sections", { a: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.version).toBe(1);
  });

  it("项目非本人: NOT_FOUND 且回滚", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // begin
        .mockResolvedValueOnce({ rows: [] }) // owned 无
        .mockResolvedValueOnce({}), // rollback
      release: vi.fn(),
    };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const r = await putNode("u2", "p1", "analysis", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });
});

describe("runMainAgentAnalysis 键级合并(V417)", () => {
  // putNode 是整包替换, 而 analysis 节点有两条写入路径(本函数 / exec-engine 的 analyze 链)。
  // 实测两次踩坑: 本函数硬编码 stepAnalysisTexts 空串, 点一次「架构确认」就把 P1 产出的
  // step2/step3 抹掉 → 前端假设解析(以 step2 为第一优先级)静默清空; 反向也会把 hypotheses
  // 清掉。这里锁住"本次没产出的键不许动"。
  const prevPayload = {
    variables: [{ name: "数字资本", role: "influence", description: "既有变量" }],
    hypotheses: ["H1: 既有假设"],
    chapterPlan: [{ title: "既有章节", level: 1, requirements: "r", skillType: "intro", wordCount: 2000 }],
    logicChain: "既有逻辑主线",
    clarifyQuestions: ["既有澄清问题"],
    stepAnalysisTexts: { "1": "既有一", "2": "既有二(P1 产出)", "3": "既有三" },
  };
  const OWNED = { rows: [{ id: "p1" }] };

  /** 从 client.query 调用里抠出 update payload(交给 putNode 落库的那份) */
  function writtenPayload(client: { query: ReturnType<typeof vi.fn> }): Record<string, unknown> {
    const call = client.query.mock.calls.find((c) => String(c[0]).includes("update research_nodes set payload"));
    if (!call) throw new Error("没找到 update research_nodes 调用");
    return JSON.parse(String((call[1] as unknown[])[0])) as Record<string, unknown>;
  }
  /** putNode 的固定事务序列(owned → for update → 旧 payload → history → update → commit) */
  function putNodeClient() {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})                     // begin
        .mockResolvedValueOnce(OWNED)                  // owned
        .mockResolvedValueOnce({ rows: [{ id: "n1", version: 1 }] }) // for update
        .mockResolvedValueOnce({ rows: [{ payload: prevPayload }] }) // 旧 payload 进历史
        .mockResolvedValueOnce({})                     // insert history
        .mockResolvedValueOnce({})                     // update
        .mockResolvedValueOnce({}),                    // commit
      release: vi.fn(),
    };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    return client;
  }
  beforeEach(() => { vi.mocked(pool.query).mockReset(); vi.mocked(pool.connect).mockReset(); vi.mocked(llmCommon.fetchLlm).mockReset(); });

  it("模型给了 step2Text/: 新值覆盖, 未产的键原样保住", async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ id: "p1" }] } as never)            // getProject
      .mockResolvedValueOnce({ rows: [{ payload: prevPayload }] } as never); // 旧 analysis 节点
    vi.mocked(llmCommon.fetchLlm).mockResolvedValueOnce({
      text: JSON.stringify({
        variables: [{ name: "新变量", role: "dependent", description: "本次" }],
        logicChain: "本次新逻辑",
        step2Text: "本次新的第二段",
        chapterPlan: [],
      }),
    } as never);
    const c = putNodeClient();

    const r = await runMainAgentAnalysis("u1", "p1", { taskId: "t1" });
    expect(r.ok).toBe(true);
    const p = writtenPayload(c);
    const sats = p.stepAnalysisTexts as Record<string, string>;
    // 本次产出的 → 新值
    expect(sats["2"]).toBe("本次新的第二段");
    expect(p.logicChain).toBe("本次新逻辑");
    expect(JSON.stringify(p.variables)).toContain("新变量");
    // 本次没产出的 → 旧值不动
    expect(sats["1"]).toBe("既有一");
    expect(sats["3"]).toBe("既有三");
    expect(p.hypotheses).toEqual(["H1: 既有假设"]);
    expect(p.clarifyQuestions).toEqual(["既有澄清问题"]);
    expect(JSON.stringify(p.chapterPlan)).toContain("既有章节");
    // 没有凭空多出来的键
    expect(Object.keys(p).sort()).toEqual(
      ["chapterPlan", "clarifyQuestions", "generatedAt", "hypotheses", "logicChain", "stepAnalysisTexts", "variables"]);
  });

  it("模型返回空({}): 旧值一个都不许被清掉", async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ id: "p1" }] } as never)
      .mockResolvedValueOnce({ rows: [{ payload: prevPayload }] } as never);
    vi.mocked(llmCommon.fetchLlm).mockResolvedValueOnce({ text: "{}" } as never);
    const c = putNodeClient();

    await runMainAgentAnalysis("u1", "p1", {});
    const p = writtenPayload(c);
    expect(p.stepAnalysisTexts).toEqual({ "1": "既有一", "2": "既有二(P1 产出)", "3": "既有三" });
    expect(p.logicChain).toBe("既有逻辑主线");
    expect(JSON.stringify(p.variables)).toContain("数字资本");
  });

  it("模型给空串/空数组: 同样不覆盖旧值(新值优先, 为空才回落)", async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ id: "p1" }] } as never)
      .mockResolvedValueOnce({ rows: [{ payload: prevPayload }] } as never);
    vi.mocked(llmCommon.fetchLlm).mockResolvedValueOnce({
      text: JSON.stringify({ variables: [], logicChain: "", step2Text: "", hypotheses: [] }),
    } as never);
    const c = putNodeClient();

    await runMainAgentAnalysis("u1", "p1", {});
    const p = writtenPayload(c);
    expect((p.stepAnalysisTexts as Record<string, string>)["2"]).toBe("既有二(P1 产出)");
    expect(p.logicChain).toBe("既有逻辑主线");
    expect(JSON.stringify(p.variables)).toContain("数字资本");
  });

  it("首次分析(无旧节点): 章节计划为空也不炸, 键齐全", async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ id: "p1" }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never); // 还没 analysis 节点
    vi.mocked(llmCommon.fetchLlm).mockResolvedValueOnce({ text: "{}" } as never);
    const c = putNodeClient();
    const r = await runMainAgentAnalysis("u1", "p1", {});
    expect(r.ok).toBe(true);
    const p = writtenPayload(c);
    expect(p.stepAnalysisTexts).toEqual({ "1": "", "2": "", "3": "" });
    expect(p.hypotheses).toEqual([]);
    expect(p.logicChain).toBe("");
  });
});
