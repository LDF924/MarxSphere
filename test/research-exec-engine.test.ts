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
// 章节生成要调真 LLM —— 单测里必须打桩, 否则批量取消用例会去连真实端点
vi.mock("../src/services/paper-outline-service.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/paper-outline-service.js")>();
  return { ...mod, generateChapter: vi.fn(async () => ({ content: "章节正文", wordCount: 100 })) };
});

import { pool } from "../src/db/pool.js";
import * as llmCommon from "../src/ai/llm-common.js";
import {
  findReadyTasks, executeReadyTask, markFailed, runSchedulingRound, parseGoalToSections,
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
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)  // 2 markRunning(原子抢占成功)
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
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)  // markRunning(原子抢占成功)
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
    // analyze 走 runAnalyzeArchitecture: pool.query 6 次(读任务/markRunning/3×阶段进度/读 input 节点/markDone);
    //   sections+analysis 节点落库走 pool.connect 事务(client.query), 故需单独 mock connect
    //   (2026-09-16 起该函数会用 setStage 回写 progress.stage —— 前端 3 步进度条与打字机都读它)
    const clientQuery = vi.fn(async (sql: string) => {
      // 节点不存在 → 走 insert 分支(选择节点用 for update)
      if (String(sql).includes("for update")) return { rows: [] };
      return { rows: [] };
    });
    const release = vi.fn();
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [t] } as any)  // getTaskById
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)   // markRunning(原子抢占成功)
      .mockResolvedValueOnce({ rows: [] } as any)   // setStage: 变量识别
      .mockResolvedValueOnce({ rows: [] } as any)   // input 节点(无 → goal 解析章节)
      .mockResolvedValueOnce({ rows: [] } as any)   // setStage: 框架分析
      .mockResolvedValueOnce({ rows: [] } as any)   // setStage: Skill 生成
      .mockResolvedValueOnce({ rows: [] } as any);  // markDone
    vi.mocked(pool.connect).mockResolvedValue({ query: clientQuery, release } as any);
    const r = await executeReadyTask("t1");
    expect(r.ok, "err=" + (r.error ?? "")).toBe(true);
    const sqls = vi.mocked(pool.query).mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("status='done'"))).toBe(true);
    // 阶段进度回写(前端进度条/打字机的数据源) —— 缺了它界面上步骤条会恒停在第 1 步
    expect(sqls.filter((s) => s.includes("progress = coalesce(progress")).length).toBeGreaterThanOrEqual(3);
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
      // depends_on 为空 → 依赖校验被跳过, 所以这里就是 markRunning(靠 rowCount 判是否抢到)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
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
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // markRunning(原子抢占成功)
      .mockResolvedValueOnce({ rows: [] } as any);             // markFailed
    const r = await executeReadyTask("t1");
    expect(r.ok).toBe(false);
    const sqls = vi.mocked(pool.query).mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("status='failed'"))).toBe(true);
  });
});

// 2026-09-15: parseGoalToSections 原先只落 {id,title,level}, 父子关系完全丢失 ——
//   前端章节树只能渲染一级, 二级子节再也不显示(页脚统计却还写着"N 个子节")。
describe("parseGoalToSections 层级结构", () => {
  it("二级行挂到它前面最近的一级行下(parentId)", () => {
    // 少于 5 节会触发默认模板补足, 所以这里给足 5 行
    const outline = [
      "1. 引言",
      "1.1 研究背景",
      "1.2 研究意义",
      "2. 文献综述",
      "2.1 国内研究",
      "2.2 国外研究",
    ].join("\n");
    const out = parseGoalToSections(outline);
    const l1 = out.filter((s) => s.level === 1);
    const l2 = out.filter((s) => s.level === 2);
    expect(l1.length).toBe(2);
    expect(l2.length).toBe(4);
    // 每个二级都有 parentId, 且指向真实存在的一级
    for (const s of l2) {
      expect(s.parentId).toBeTruthy();
      expect(l1.some((p) => p.id === s.parentId)).toBe(true);
    }
    // 1.1/1.2 归第一章; 2.1/2.2 归第二章 —— 不能全挂到同一章
    const byParent = new Map<string, number>();
    for (const s of l2) byParent.set(String(s.parentId), (byParent.get(String(s.parentId)) ?? 0) + 1);
    expect([...byParent.values()].sort()).toEqual([2, 2]);
  });

  it("一级行本身没有 parentId", () => {
    const out = parseGoalToSections("1. 引言\n2. 方法\n3. 结果\n4. 讨论\n5. 结论");
    for (const s of out.filter((x) => x.level === 1)) expect(s.parentId).toBeUndefined();
  });
});

describe("取消语义(2026-09-16: 取消必须真停, 不能被收尾覆盖)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("markDone 不覆盖已取消的任务", async () => {
    // 并发场景: 用户点取消 → status=cancelled; 执行器随后跑完并调 markDone。
    // 不加 `status <> 'cancelled'` 守卫的话, 任务会被改回 done —— 用户看到"已取消"的任务
    // 又变成"已完成", 且半成品结果被当成完整结果落库。
    const query = vi.mocked(pool.query);
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { markDone } = await import("../src/services/research-exec-engine.js");
    await markDone("t1", { text: "半成品" });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("status <> 'cancelled'");
  });

  it("批处理遇到取消就停, 不再生成后面的章节", async () => {
    // 章节批量: sections 有 3 章, 但第 2 章开始前查到已取消 → 必须停在 2 章, 第 3 章不执行
    const t = task("queued", {
      job_kind: "phase4_batch",
      input_snapshot: { sections: [
        { id: "s1", title: "第一章", level: 1 },
        { id: "s2", title: "第二章", level: 1 },
        { id: "s3", title: "第三章", level: 1 },
      ] },
    });
    const clientQuery = vi.fn(async () => ({ rows: [] }));
    vi.mocked(pool.connect).mockResolvedValue({ query: clientQuery, release: vi.fn() } as never);

    let poll = 0;
    const query = vi.mocked(pool.query);
    query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("select * from research_tasks")) return { rows: [t] } as never;
      if (s.includes("status='running'")) return { rows: [{ id: "t1" }], rowCount: 1 } as never;
      // 第 1 轮取消检查 → 未取消; 第 2 轮 → 已取消(模拟用户在第 1 章生成期间点了取消)
      if (s.includes("select status from research_tasks")) {
        poll++;
        return { rows: [{ status: poll >= 2 ? "cancelled" : "running" }] } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    });
    // 第 1 章正常产出
    const { generateChapter } = await import("../src/services/paper-outline-service.js");
    vi.mocked(generateChapter).mockResolvedValue({ content: "第一章正文", wordCount: 100 } as never);

    const r = await executeReadyTask("t1");
    expect(r.ok).toBe(true);
    const doneCall = query.mock.calls.map((c) => String(c[0])).find((s) => s.includes("result=$2"));
    // 收尾写回时仍受取消守卫约束
    expect(String(doneCall)).toContain("status <> 'cancelled'");
  });
});

describe("素材 references 链路(2026-09-16: 结构化文献必须能写、能读、能更新)", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("PUT 更新时 references 映射到 references_json 列", async () => {
    // 不映射的话, 前端保存表单会把结构化文献静默丢掉(此前 PUT 根本不接收该字段)
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: "m1" }] } as never);
    const { updateMaterial } = await import("../src/services/research-materials-service.js");
    await updateMaterial("u1", "m1", { title: "t", references: [{ title: "条目" }] });
    const [sql, vals] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("references_json=");
    // 必须是 jsonb 参数, 不是普通文本
    expect(sql).toContain("::jsonb");
    // vals[0]=materialId, vals[1]=userId, 之后按 Object.entries 顺序追加
    expect(vals.map(String).join("|")).toContain("条目");
  });

  it("单条 getMaterial 与列表同形状(camelCase references), 且保留 snake 旧键", async () => {
    // 两处字段名不一致时: 前端把单条结果塞回表单 → references 是 undefined → 一保存就抹掉
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ id: "m1", content_md: "正文", references_json: [{ title: "A" }], section_ids: ["s1"], meta: {}, source_type: "literature" }],
    } as never);
    const { getMaterial } = await import("../src/services/research-materials-service.js");
    const m = (await getMaterial("u1", "m1")) as Record<string, unknown>;
    expect(Array.isArray(m.references)).toBe(true);
    expect((m.references as unknown[]).length).toBe(1);
    expect(m.contentMd).toBe("正文");
    expect(m.sectionIds).toEqual(["s1"]);
    // 旧蛇形键保留(React 侧 MaterialMaterialsDrawer 直接读 content_md)
    expect(m.content_md).toBe("正文");
  });
});

describe("引用链条目口径(2026-09-16: 结构化 references 必须进可引池与参考文献表)", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("buildMergedReferences 优先读 references_json, 并兼容 content_md 的 [N] 行", async () => {
    // 库里有两种形状: 结构化(手动录入/检索臂) 与 老的文本形式。
    // 此前只认后者 —— 手动录入的文献因此进不了参考文献表(实测确认过的缺口)。
    vi.mocked(pool.query).mockResolvedValue({
      rows: [
        { content_md: "", references_json: [{ title: "结构化条目", authors: "郭峰", year: "2020", source: "经济学(季刊)" }] },
        { content_md: "[1] 文本条目. 2023.", references_json: [] },
      ],
    } as never);
    const { buildMergedReferences } = await import("../src/services/research-exec-engine.js");
    const out = await buildMergedReferences("u1", "p1");
    expect(out).toContain("结构化条目");
    expect(out).toContain("文本条目");
    // 编号要连续(两条都在, 且是 [1] [2])
    expect(out).toMatch(/\[1\][\s\S]*\[2\]/);
  });

  it("SQL 同时取 references_json 列(只取 content_md 就永远读不到结构化条目)", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    const { buildMergedReferences } = await import("../src/services/research-exec-engine.js");
    await buildMergedReferences("u1", "p1");
    const sql = String(vi.mocked(pool.query).mock.calls[0][0]);
    expect(sql).toContain("references_json");
    expect(sql).toContain("content_md");
  });
});
