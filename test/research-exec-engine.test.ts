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
  fetchLlm: vi.fn(async () => ({ text: JSON.stringify({ score: 62, grade: "C", overall: "mock", highlights: ["h1"], checks: { requirements: { pass: true, detail: "x" }, references: { pass: false, detail: "y" }, aiTone: { pass: false, detail: "z" }, logic: { pass: true, detail: "w" }, dataAccuracy: { pass: false, detail: "v" } }, topSuggestions: ["s1"] }) })),
  parseLlmJson: (t: string) => { try { return JSON.parse(t); } catch { return null; } },
}));
vi.mock("../src/services/research-materials-service.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/research-materials-service.js")>();
  return { ...mod, buildMaterialsContext: async () => "【素材上下文mock】" };
});

import { pool } from "../src/db/pool.js";
import * as llmCommon from "../src/ai/llm-common.js";
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
  beforeEach(() => {
    vi.mocked(pool.query).mockReset();
    vi.mocked(pool.connect).mockReset();
    vi.mocked(llmCommon.fetchLlm).mockClear();
  });

  it("非 queued 状态直接返回不执行", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [task("done")] } as any);
    const r = await executeReadyTask("t1");
    expect(r.ok).toBe(false);
  });

  it("review 任务走六维审查执行器(P-A: 读 project.merged_fulltext → 报告落 review_result)→ done", async () => {
    const t = task("queued", { job_kind: "review", project_id: "p1" });
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [t] } as any)     // 1 getTaskById
      .mockResolvedValueOnce({ rows: [] } as any)      // 2 markRunning(依赖空跳过校验)
      .mockResolvedValueOnce({ rows: [] } as any)      // 3 sections 节点(正文真源, runPhase5 开头)
      .mockResolvedValueOnce({ rows: [{ payload: { mergedTitle: "测试论文", mergedFullText: "## 引言\n正文内容若干。", mergedAbstract: "", mergedKeywords: "" } }] } as any) // 4 finalize 节点
      .mockResolvedValueOnce({ rows: [{ merged_title: "测试论文", merged_fulltext: "## 引言\n正文内容若干。", merged_abstract: "", merged_keywords: "", merged_references: "", review_result: null, published_version: 0, phase_label: "" }] } as any) // 5 project 行
      .mockResolvedValueOnce({ rows: [] } as any)      // 6 review_result 回写 project
      .mockResolvedValueOnce({ rows: [] } as any)      // 7 review_result 回写 finalize 节点
      .mockResolvedValueOnce({ rows: [] } as any);     // 8 markDone(落 result)
    const r = await executeReadyTask("t1");
    expect(r.ok, "SQLs: " + JSON.stringify(vi.mocked(pool.query).mock.calls.map((c) => String(c[0]).slice(0, 110)))).toBe(true);
    const sqls = vi.mocked(pool.query).mock.calls.map((c) => String(c[0]));
    // 六维审查报告(score/grade/checks/highlights/topSuggestions)写回 project.review_result
    expect(sqls.some((s) => s.includes("review_result") && s.includes("update research_projects")),
      "ALLSQLS: " + JSON.stringify(sqls.map((s) => s.slice(0, 90)))).toBe(true);
    // markDone 携带 result → research_tasks.result 列
    expect(sqls.some((s) => s.includes("result=$2::jsonb") && s.includes("status='done'"))).toBe(true);
    // 审查 prompt 要求六维 checks(结构契约)
    const reviewArgs = (llmCommon.fetchLlm as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String((c[0] as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content ?? ""));
    expect(reviewArgs.some((s: string) => s.includes("checks") && s.includes("aiTone") && s.includes("dataAccuracy"))).toBe(true);
  });

  it("revise 任务走有向修订执行器(P-A: 读 review_result+merged_fulltext → 修订稿覆盖 merged_* + revisionOf)→ done", async () => {
    const t = task("queued", { job_kind: "revise", project_id: "p1" });
    const projectRow = {
      merged_title: "测试论文", merged_fulltext: "## 引言\n在当今背景下, 本文具有重要意义。\n## 结论\n综上所述, 发挥了重要作用。",
      merged_abstract: "旧摘要", merged_keywords: "旧;关键词", merged_references: "",
      review_result: { score: 62, grade: "C", checks: { aiTone: { pass: false, detail: "模板化开头" }, logic: { pass: true, detail: "ok" } }, topSuggestions: ["消除模板化表达"] },
      published_version: 3, phase_label: "",
    };
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [t] } as any)     // getTaskById
      .mockResolvedValueOnce({ rows: [] } as any)      // markRunning
      .mockResolvedValueOnce({ rows: [] } as any)      // sections 节点(正文真源)
      .mockResolvedValueOnce({ rows: [{ payload: { mergedTitle: "测试论文", mergedFullText: "## 引言\n在当今背景下, 本文具有重要意义。\n## 结论\n综上所述, 发挥了重要作用。", mergedAbstract: "旧摘要", mergedKeywords: "旧;关键词", reviewReport: projectRow.review_result } }] } as any) // finalize 节点(真源)
      .mockResolvedValueOnce({ rows: [projectRow] } as any) // project 行
      .mockResolvedValueOnce({ rows: [] } as any)      // 修订稿覆盖 project merged_*
      .mockResolvedValueOnce({ rows: [] } as any)      // 修订稿覆盖 finalize 节点
      .mockResolvedValueOnce({ rows: [] } as any);     // markDone
    const r = await executeReadyTask("t1");
    expect(r.ok, "SQLs: " + JSON.stringify(vi.mocked(pool.query).mock.calls.map((c) => String(c[0]).slice(0, 90)))).toBe(true);
    const sqls = vi.mocked(pool.query).mock.calls.map((c) => String(c[0]));
    // 修订结果覆盖 merged_fulltext + revision_of_version
    expect(sqls.some((s) => s.includes("merged_fulltext=$4") && s.includes("revision_of_version=$5"))).toBe(true);
    // 修订 LLM 收到审稿意见(有向修订: checks + topSuggestions 进 prompt)
    const reviseArgs = (llmCommon.fetchLlm as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String((c[0] as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content ?? ""));
    expect(reviseArgs.some((s: string) => s.includes("论文修订专家") && s.includes("aiTone") && s.includes("消除模板化表达"))).toBe(true);
  });

  it("通用 analyze 任务: LLM 执行成功 → done", async () => {
    const t = task("queued", { job_kind: "analyze" });
    // analyze 走 runAnalyzeArchitecture: pool.query 4 次(读任务/markRunning/读 input 节点/markDone);
    // sections+analysis 节点落库走 pool.connect 事务(client.query), 故需单独 mock connect
    const clientQuery = vi.fn(async (sql: string) => {
      // 节点不存在 → 走 insert 分支(选择节点用 for update)
      if (String(sql).includes("for update")) return { rows: [] };
      return { rows: [] };
    });
    const release = vi.fn();
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [t] } as any)  // getTaskById
      .mockResolvedValueOnce({ rows: [] } as any)   // markRunning
      .mockResolvedValueOnce({ rows: [] } as any)   // input 节点(无 → goal 解析章节)
      .mockResolvedValueOnce({ rows: [] } as any);  // markDone
    vi.mocked(pool.connect).mockResolvedValue({ query: clientQuery, release } as any);
    const r = await executeReadyTask("t1");
    expect(r.ok, "err=" + (r.error ?? "")).toBe(true);
    const sqls = vi.mocked(pool.query).mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("status='done'"))).toBe(true);
    // 事务路径: begin/commit + sections/analysis 节点落库
    const clientSqls = clientQuery.mock.calls.map((c) => String(c[0]));
    expect(clientSqls).toContain("begin");
    expect(clientSqls).toContain("commit");
    expect(clientSqls.some((s) => s.includes("node_key='sections'"))).toBe(true);
    expect(clientSqls.some((s) => s.includes("node_key='analysis'"))).toBe(true);
    expect(release).toHaveBeenCalled();
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
