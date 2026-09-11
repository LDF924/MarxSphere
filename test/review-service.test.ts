// review-service.test.ts — SocialSci P0-3 契约测试(审稿服务)
// 覆盖: 分段算法 / 控制状态机 / 默认维度 / 标准设默认事务 / 解析函数返回契约
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));
vi.mock("../src/services/llm-model-registry.js", () => ({
  getRoleModel: () => "test-model",
}));
vi.mock("../src/ai/llm-common.js", () => ({
  getLlmEndpoint: () => ({ url: "http://mock", key: "k", model: "m" }),
  fetchLlm: vi.fn(async () => ({ text: "{}" })),
  parseLlmJson: (t: string) => { try { return JSON.parse(t); } catch { return null; } },
}));

import { pool } from "../src/db/pool.js";
import {
  segmentText, defaultDimensions, createReviewJob, controlReviewJob,
  parseSubmissionGuide, parseStandardText, setDefaultStandard,
  listJournals, updateJournal, deleteJournal, runReviewJob,
} from "../src/services/review-service.js";

describe("segmentText 分段算法", () => {
  it("短文本(<maxLen) 不分段", () => {
    const segs = segmentText("短论文内容".repeat(50));
    expect(segs).toHaveLength(1);
  });

  it("超长文本按段落边界切分且全部保留", () => {
    // 构造 ~9000 字: 每段 ~400 字
    const paras: string[] = [];
    for (let i = 0; i < 24; i++) paras.push(`第${i}段` + "论证内容".repeat(100));
    const text = paras.join("\n\n");
    const segs = segmentText(text);
    expect(segs.length).toBeGreaterThan(2);
    // 内容无丢失(拼接字符数一致, 去空白)
    const joined = segs.join("").replace(/\s/g, "");
    expect(joined).toBe(text.replace(/\s/g, ""));
    // 每段 ≤ maxLen 且 ≥ 1
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(4000);
  });

  it("空文本返回空数组", () => {
    expect(segmentText("   ")).toEqual([]);
  });
});

describe("defaultDimensions", () => {
  it("含 7 个社科期刊审稿维度(闭源实页 7 维)且权重和≈1", () => {
    const dims = defaultDimensions() as Array<{ key: string; weight: number; weightLabel?: number }>;
    expect(dims).toHaveLength(7);
    const sum = dims.reduce((a, d) => a + d.weight, 0);
    expect(sum).toBeCloseTo(1.0);
    expect(dims[0].key).toBe("topic_value");
    // P-B: 闭源权重整档 3-5 透传
    expect(dims.map((d) => d.weightLabel)).toEqual([4, 5, 5, 5, 4, 3, 4]);
    expect(dims.some((d) => d.key === "empirical")).toBe(true);
    expect(dims.some((d) => d.key === "countermeasure")).toBe(true);
  });
});

describe("createReviewJob", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("无标准: 落默认维度 + 分段落库", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const r = await createReviewJob({
      userId: "u1", title: "测试论文",
      text: "长文".repeat(300) + "\n\n" + "长文".repeat(300), // ~1200字
    });
    expect(r.id).toBeTruthy();
    expect(r.dimensions).toHaveLength(7);
    // 现在会先查一次「设为默认」的标准(没有则回落 7 维默认), insert 不再是第一条
    const insert = vi.mocked(pool.query).mock.calls.find((c) => String(c[0]).includes("insert into review_jobs"));
    expect(insert).toBeTruthy();
    const vals = insert![1] as unknown[];
    // dimensions 在第8参数(json)
    expect(String(vals[7])).toContain("topic_value");
    // progress 含 totalSegments
    const prog = JSON.parse(String(vals[8])) as { totalSegments: number };
    expect(prog.totalSegments).toBeGreaterThan(0);
  });

  it("面板契约: settings.journalId 落 journal_id 且期刊规则进 progress(此前被丢弃)", async () => {
    const rules = { formatRules: ["15000-25000字"], reviewFocus: ["理论创新"] };
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [] } as any)                      // 默认标准查询(无)
      .mockResolvedValueOnce({ rows: [{ parsed_rules: rules }] } as any) // 期刊
      .mockResolvedValueOnce({ rows: [] } as any);                      // insert
    await createReviewJob({
      userId: "u1", text: "短文本内容".repeat(10),
      settings: { strictness: "strict", journalId: "j-1", standardIds: [], customRequirements: "重点看方法" },
    });
    const insert = vi.mocked(pool.query).mock.calls.find((c) => String(c[0]).includes("insert into review_jobs"));
    const vals = insert![1] as unknown[];
    expect(vals[5]).toBe("j-1");                                       // journal_id
    const prog = JSON.parse(String(vals[8])) as { rules?: unknown };
    expect(prog.rules).toEqual(rules);                                 // 规则进 progress → 进提示词
    const settings = JSON.parse(String(vals[9])) as { strictness: string; customRequirements: string };
    expect(settings.strictness).toBe("strict");
    expect(settings.customRequirements).toBe("重点看方法");
  });

  it("面板契约: settings.standardIds 取标准维度(传字符串数组不炸 uuid=text)", async () => {
    const customDims = [{ key: "innovation", name: "创新性", weight: 3, criteria: "选题新意" }];
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ dimensions: customDims }] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any);
    const r = await createReviewJob({
      userId: "u1", text: "短文本内容".repeat(10),
      settings: { standardIds: ["11111111-1111-1111-1111-111111111111"] },
    });
    expect(r.dimensions).toEqual(customDims);
    const sel = vi.mocked(pool.query).mock.calls[0];
    // uuid 列不能直接和 text[] 比 → 必须 id::text = any($1::text[])
    expect(String(sel[0])).toContain("id::text = any(");
  });

  it("useDefaults: 显式要求默认 7 维(跳过默认标准查询)", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const r = await createReviewJob({ userId: "u1", text: "短文本内容".repeat(10), useDefaults: true });
    expect(r.dimensions).toHaveLength(7);
    expect(vi.mocked(pool.query).mock.calls[0][0]).toContain("insert into review_jobs");
  });

  it("带 standardId: 取标准维度覆盖默认", async () => {
    const customDims = [{ key: "custom", name: "自定义维度", weight: 1, criteria: "x", min: 0, max: 100 }];
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ dimensions: customDims }] } as any)  // standard select
      .mockResolvedValueOnce({ rows: [] } as any)                            // journal(无)
      .mockResolvedValueOnce({ rows: [] } as any);                           // insert
    const r = await createReviewJob({
      userId: "u1", text: "短文本内容".repeat(10), standardId: "s1",
    });
    expect(r.dimensions).toEqual(customDims);
  });
});
describe("controlReviewJob 控制流", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("cancel: running 态 → cancelled", async () => {
    const job = { id: "j1", user_id: "u1", status: "running" };
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [job] } as any)  // getReviewJob
      .mockResolvedValueOnce({ rows: [] } as any);     // update
    const r = await controlReviewJob("u1", "j1", "cancel");
    expect(r?.status).toBe("cancelled");
  });

  it("retry: failed 态建 retry_of 子任务", async () => {
    const job = { id: "j1", user_id: "u1", status: "failed" };
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [job] } as any)  // getReviewJob
      .mockResolvedValueOnce({ rows: [] } as any);     // insert ... select
    const r = await controlReviewJob("u1", "j1", "retry");
    expect(r?.id).not.toBe("j1");
    expect(r?.status).toBe("queued");
  });

  it("done 态重试: 建子任务(结果页「重新审稿」按钮), 复制 settings", async () => {
    const job = { id: "j1", user_id: "u1", status: "done" };
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [job] } as any)  // getReviewJob
      .mockResolvedValueOnce({ rows: [] } as any);     // insert ... select
    const r = await controlReviewJob("u1", "j1", "retry");
    expect(r?.id).not.toBe("j1");
    expect(r?.status).toBe("queued");
    const ins = vi.mocked(pool.query).mock.calls[1];
    // 严格度/额外要求必须跟着走, 否则"重审"会悄悄换回默认标准
    expect(String(ins[0])).toContain("settings_json");
  });

  it("done 态不受 cancel 影响", async () => {
    const job = { id: "j1", user_id: "u1", status: "done" };
    vi.mocked(pool.query).mockResolvedValue({ rows: [job] } as any);
    const r = await controlReviewJob("u1", "j1", "cancel");
    expect(r?.status).toBe("done");
  });
});

describe("parseSubmissionGuide / parseStandardText 契约", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("解析函数返回结构化字段(LLM空也稳)", async () => {
    // LLM 返回 {} → 各字段空数组兜底
    const j = await parseSubmissionGuide("投稿须知长文".repeat(50));
    expect(Array.isArray(j.formatRules)).toBe(true);
    expect(Array.isArray(j.reviewFocus)).toBe(true);
    expect(Array.isArray(j.citationRules)).toBe(true);
    expect(typeof j.scope).toBe("string");
    const s = await parseStandardText("评分标准长文".repeat(50));
    expect(Array.isArray(s.dimensions)).toBe(true);
  });
});

describe("汇总失败不得伪装成成功", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("LLM 汇总返回空 → runReviewJob 以失败收尾(不落全 0 报告)", async () => {
    // fetchLlm 返回空文本 → llmJson 得 null → 聚合失败
    const llm = await import("../src/ai/llm-common.js");
    vi.mocked(llm.fetchLlm).mockResolvedValue({ text: "" } as never);
    // 还原(其它用例依赖默认的 "{}")
    // getReviewJob → 任务存在且有原文
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ id: "j1", user_id: "u1", status: "queued", text_snapshot: "正文内容".repeat(200), dimensions: [], progress: {} }],
    } as never);
    const sent: Array<{ event: string }> = [];
    const sse = { send: (e: string) => { sent.push({ event: e }); }, error: () => {}, end: () => {}, closed: false } as never;
    await runReviewJob("u1", "j1", sse);
    // 不得发 review.completed
    expect(sent.some((x) => x.event === "review.completed")).toBe(false);
    // 必须把状态落成 failed
    const updates = vi.mocked(pool.query).mock.calls.map((c) => ({ sql: String(c[0]), vals: c[1] as unknown[] }));
    expect(updates.some((u) => u.sql.includes("update review_jobs") && u.vals?.includes("failed"))).toBe(true);
  });
});

describe("setDefaultStandard 目标不存在", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("更新 0 行 → 回滚并返回 null(不得谎报成功)", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})                              // begin
        .mockResolvedValueOnce({})                              // 清旧默认
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })       // update 没命中
        .mockResolvedValueOnce({}),                             // rollback
      release: vi.fn(),
    };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const r = await setDefaultStandard("u1", "不存在的id", true);
    expect(r).toBeNull();
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls).toContain("rollback");
    expect(sqls).not.toContain("commit");
  });
});

describe("库归属过滤的占位符编号", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("update/delete 用 $2 指用户(不是 $1 — 否则 bind 参数个数对不上, 500)", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    await updateJournal("u1", "j1", { name: "x" });
    const upd = String(vi.mocked(pool.query).mock.calls[0][0]);
    expect(upd).toContain("where id=$1");
    expect(upd).toContain("user_id=$2");
    vi.mocked(pool.query).mockClear();
    await deleteJournal("u1", "j1");
    const del = String(vi.mocked(pool.query).mock.calls[0][0]);
    expect(del).toContain("user_id=$2");
  });

  it("list 用 $1 指用户", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    await listJournals("u1");
    const sql = String(vi.mocked(pool.query).mock.calls[0][0]);
    expect(sql).toContain("user_id=$1");
    expect(sql).not.toContain("user_id=$2");
  });
});

describe("setDefaultStandard 事务", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("设默认先清旧默认再更新", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})  // begin
        .mockResolvedValueOnce({})  // 清旧默认
        .mockResolvedValueOnce({ rows: [{ id: "s1" }], rowCount: 1 }) // update(现在按 rowCount 判是否命中)
        .mockResolvedValueOnce({}), // commit
      release: vi.fn(),
    };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const r = await setDefaultStandard("u1", "s1", true);
    expect(r?.ok).toBe(true);
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("is_default=false"))).toBe(true);
    // 更新用参数化 $2(非字面量 true)
    const upd = sqls.find((s) => s.includes("is_default=$2"));
    expect(upd).toBeTruthy();
    const params = client.query.mock.calls.find((c) => String(c[0]).includes("is_default=$2"))?.[1] as unknown[];
    expect(params).toContain(true);
    expect(client.release).toHaveBeenCalled();
  });
});
