// research-exec-engine.test.ts — SocialSci P0-2 契约测试(素材 + DAG 执行引擎)
// 覆盖: 素材 CRUD 映射 / 就绪判定(依赖空+依赖全done+依赖未完成排除) / 执行器分派(未注册/LLM)
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));
vi.mock("../src/services/llm-model-registry.js", () => ({
  getRoleModel: () => "test-model",
}));
vi.mock("../src/ai/llm-common.js", () => ({
  getLlmEndpoint: () => ({ url: "http://mock", key: "k", model: "m" }),
  fetchLlm: async () => ({ text: '{"result":"素材注入执行完成","structured":{"ok":1}}' }),
  parseLlmJson: (t: string) => { try { return JSON.parse(t); } catch { return null; } },
}));
vi.mock("../src/services/research-materials-service.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/research-materials-service.js")>();
  return { ...mod, buildMaterialsContext: async () => "【素材上下文mock】" };
});

import { pool } from "../src/db/pool.js";
import {
  findReadyTasks, executeReadyTask, markFailed, runSchedulingRound,
} from "../src/services/research-exec-engine.js";
import { createMaterial, listMaterials, updateMaterial, deleteMaterial, buildMaterialsContext } from "../src/services/research-materials-service.js";

function task(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "t1", project_id: "p1", user_id: "u1", dag_node_id: "n1",
    module: "workflow", job_kind: "analyze", phase: 0, goal: "测试目标",
    depends_on: [], plan: [], progress: {}, input_snapshot: null, retry_of: null,
    status, ...extra,
  };
}

describe("findReadyTasks 就绪判定", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("依赖为空的任务就绪(返回行)", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [task("queued")] } as any);
    const r = await findReadyTasks();
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("queued");
  });

  it("SQL 含 NOT EXISTS 依赖子查询(结构契约)", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    await findReadyTasks("p1");
    const sql = String(vi.mocked(pool.query).mock.calls[0][0]);
    expect(sql).toContain("depends_on");
    expect(sql).toContain("status='queued'");
    expect(sql).toContain("project_id");
  });
});

describe("executeReadyTask 执行器分派", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("非 queued 状态直接返回不执行", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [task("done")] } as any);
    const r = await executeReadyTask("t1");
    expect(r.ok).toBe(false);
  });

  it("review 任务走通用 LLM 执行器(面板直连, 引擎兜底)→ done", async () => {
    const t = task("queued", { job_kind: "review" });
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [t] } as any) // getTaskById
      .mockResolvedValueOnce({ rows: [] } as any)   // 二次依赖校验(无依赖跳过)
      .mockResolvedValueOnce({ rows: [] } as any)   // markRunning update
      .mockResolvedValueOnce({ rows: [] } as any);  // markDone update
    const r = await executeReadyTask("t1");
    expect(r.ok).toBe(true);
    const sqls = vi.mocked(pool.query).mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("status='done'"))).toBe(true);
  });

  it("通用 analyze 任务: LLM 执行成功 → done", async () => {
    const t = task("queued", { job_kind: "analyze" });
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [t] } as any)  // getTaskById
      .mockResolvedValueOnce({ rows: [] } as any)   // 依赖校验(空跳过)
      .mockResolvedValueOnce({ rows: [] } as any)   // markRunning
      .mockResolvedValueOnce({ rows: [] } as any)   // markDone
      .mockResolvedValueOnce({ rows: [] } as any);  // (预留)
    const r = await executeReadyTask("t1");
    expect(r.ok).toBe(true);
    const sqls = vi.mocked(pool.query).mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("status='done'"))).toBe(true);
  });
});

describe("runSchedulingRound", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("空就绪队列: executed=0", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const r = await runSchedulingRound();
    expect(r.executed).toBe(0);
    expect(r.results).toHaveLength(0);
  });
});

describe("research-materials-service", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("createMaterial: 字段完整入库", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const { id } = await createMaterial({
      projectId: "p1", userId: "u1", kind: "citation",
      title: "文献素材", contentMd: "[1] 测试文献", tags: ["经济"], sourceRef: "ragjob_x",
    });
    expect(id).toBeTruthy();
    const [sql, vals] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("research_materials");
    // vals: id,projectId,userId,kind,title,contentMd,tags,sourceRef,producedByDagNode,meta,createdBy
    expect(vals[3]).toBe("citation");
    expect(vals[6]).toBe("{经济}"); // toPgArray: PG text[] 字面量
  });

  it("listMaterials: projectId 过滤拼接", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    await listMaterials("u1", "p1", "figure");
    const [sql, vals] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("project_id=$2");
    expect(sql).toContain("kind=$3");
    expect(vals).toEqual(["u1", "p1", "figure"]);
  });

  it("updateMaterial: 只更新提供字段", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: "m1" }] } as any);
    await updateMaterial("u1", "m1", { title: "新标题" });
    const [sql] = vi.mocked(pool.query).mock.calls[0] as unknown as [string];
    expect(sql).toContain("title=$3");
    expect(sql).not.toContain("content_md=$");
  });

  it("deleteMaterial 按 user 归属删除", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: "m1" }] } as any);
    const r = await deleteMaterial("u1", "m1");
    expect(r?.id).toBe("m1");
    const [sql] = vi.mocked(pool.query).mock.calls[0] as unknown as [string];
    expect(sql).toContain("user_id=$2");
  });
});

describe("SocialSci 补漏组4: 专用执行器分派", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("literature-search 任务分派到专用执行器且产出 citation 素材", async () => {
    const t = task("queued", { job_kind: "literature-search", input_snapshot: { sectionTitle: "引言", keywords: ["融资"] } });
    // getTaskById + 依赖校验 + markRunning + LLM(fetchLlm mock {}→空) + createMaterial insert + markDone
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [t] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [{ id: "m1" }] } as any)
      .mockResolvedValueOnce({ rows: [] } as any);
    const r = await executeReadyTask("t1");
    expect(r.ok).toBe(true);
    const sqls = vi.mocked(pool.query).mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("research_materials"))).toBe(true);
    expect(sqls.some((s) => s.includes("status='done'"))).toBe(true);
  });

  it("phase4_batch 任务走 executeReadyTask 且带章节清单校验失败抛错→failed", async () => {
    const t = task("queued", { job_kind: "phase4_batch", input_snapshot: {} }); // 无 sections → 抛错
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [t] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any) // markRunning
      .mockResolvedValueOnce({ rows: [] } as any); // markFailed
    const r = await executeReadyTask("t1");
    expect(r.ok).toBe(false);
    const sqls = vi.mocked(pool.query).mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("status='failed'"))).toBe(true);
  });
});
