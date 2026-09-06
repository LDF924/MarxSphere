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
  fetchLlm: async () => ({ text: "{}" }),
  parseLlmJson: (t: string) => { try { return JSON.parse(t); } catch { return null; } },
}));

import { pool } from "../src/db/pool.js";
import {
  dagTemplateFiveStage,
  nlToDag,
  controlTask,
  putNode,
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
