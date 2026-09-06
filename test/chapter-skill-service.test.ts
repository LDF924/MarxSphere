// chapter-skill-service.test.ts — SocialSci 补漏R2 契约测试
// 覆盖: workbench 快照归属校验 / skill-card 落库 SQL / 回写 sections
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/db/pool.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/services/llm-model-registry.js", () => ({ getRoleModel: () => "m" }));
vi.mock("../src/ai/llm-common.js", () => ({
  getLlmEndpoint: () => ({}), fetchLlm: async () => ({ text: "{}" }), parseLlmJson: () => null,
}));

import { pool } from "../src/db/pool.js";
import { saveWorkbenchSnapshot, getWorkbenchSnapshot } from "../src/services/chapter-skill-service.js";

describe("saveWorkbenchSnapshot", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("非本人项目拒绝", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as any);
    const r = await saveWorkbenchSnapshot("u2", "p1", { phase: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("项目不存在");
  });

  it("本人项目: 快照+englishAbstract 落库", async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ id: "p1" }] } as any)   // owned
      .mockResolvedValueOnce({ rows: [] } as any);              // update
    const r = await saveWorkbenchSnapshot("u1", "p1", { phase: 3, _englishAbstract: "EN" });
    expect(r.ok).toBe(true);
    const [sql, vals] = vi.mocked(pool.query).mock.calls[1] as unknown as [string, unknown[]];
    expect(sql).toContain("workbench_snapshot=$2");
    expect(sql).toContain("english_abstract=coalesce($3,");
    const snapJson = String(vals[1]);
    expect(snapJson).toContain('"phase":3');
    expect(vals[2]).toBe("EN");
  });
});

describe("getWorkbenchSnapshot", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("返回快照+英文摘要(动态合并节点); 无项目返回 null", async () => {
    // 第1次: 项目查询; 第2次: 节点查询(动态合并)
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ workbench_snapshot: { phase: 2 }, english_abstract: "Abs", merged_title: "", merged_fulltext: "" }] } as any)
      .mockResolvedValueOnce({ rows: [{ node_key: "sections", payload: { sections: [{ id: "s1", title: "引言" }] }, updated_at: new Date() }] } as any);
    const r = await getWorkbenchSnapshot("u1", "p1");
    expect(r?.snapshot?.phase).toBe(2);
    expect(r?.snapshot?.sections?.[0]?.title).toBe("引言"); // 节点动态合并
    expect(r?.englishAbstract).toBe("Abs");
    vi.mocked(pool.query).mockReset();
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as any);
    expect(await getWorkbenchSnapshot("u1", "p1")).toBeNull();
  });
});
