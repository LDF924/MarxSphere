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
  fetchLlm: async () => ({ text: "{}" }),
  parseLlmJson: (t: string) => { try { return JSON.parse(t); } catch { return null; } },
}));

import { pool } from "../src/db/pool.js";
import {
  segmentText, defaultDimensions, createReviewJob, controlReviewJob,
  parseSubmissionGuide, parseStandardText, setDefaultStandard,
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
    const [sql, vals] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("insert into review_jobs");
    // dimensions 在第8参数(json)
    expect(vals[7]).toContain("topic_value");
    // progress 含 totalSegments
    const prog = JSON.parse(String(vals[8])) as { totalSegments: number };
    expect(prog.totalSegments).toBeGreaterThan(0);
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

  it("done 态不受 cancel/retry 影响", async () => {
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

describe("setDefaultStandard 事务", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("设默认先清旧默认再更新", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})  // begin
        .mockResolvedValueOnce({})  // 清旧默认
        .mockResolvedValueOnce({ rows: [{ id: "s1" }] }) // update
        .mockResolvedValueOnce({}), // commit
      release: vi.fn(),
    };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const r = await setDefaultStandard("u1", "s1", true);
    expect(r.ok).toBe(true);
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
