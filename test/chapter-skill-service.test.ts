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
import { mergeSectionsById, applyNodesToSnapshot, SNAPSHOT_NODE_MAP } from "../src/services/workbench-sync.js";

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
    // 2026-09-18: 由整块覆盖改成 jsonb `||` 合并 —— 部分提交不再抹掉之前存的键
    // (实测: 只提交 {phase,phaseLabel} 会把 sections / statisticsFileId 全弄丢)
    expect(sql).toContain("coalesce(workbench_snapshot,'{}'::jsonb) || $2::jsonb");
    expect(sql).not.toContain("workbench_snapshot=$2,");
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
    const secs = (r?.snapshot?.sections ?? []) as Array<{ title?: string }>;
    expect(secs[0]?.title).toBe("引言"); // 节点动态合并
    expect(r?.englishAbstract).toBe("Abs");
    vi.mocked(pool.query).mockReset();
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as any);
    expect(await getWorkbenchSnapshot("u1", "p1")).toBeNull();
  });
});

// ═══ 2026-09-18: 「快照 ↔ 节点」口径真源(workbench-sync) ═══
// 这些断言的由来: 前一段挖出的 7 个缺陷里一半是"写进去的和读出来的不是一套"。
// 映射表就是防它再犯的, 所以每条策略都得有测试锁住。
describe("workbench-sync 口径", () => {
  it("映射表覆盖了此前整条链失效的 isFinalized", () => {
    // 它此前只写快照、而读侧只从 finalize 节点读 → 刷新后「已定稿」静默丢失
    const e = SNAPSHOT_NODE_MAP.find((x) => x.snapshotKey === "isFinalized");
    expect(e?.nodeKey).toBe("finalize");
  });

  it("mergeById: 提交里的空 content 不得清空节点已有的正文", () => {
    // 这是防倒退的核心 —— 客户端拿旧视图提交时, 引擎刚写的正文必须活下来
    const cur = [{ id: "s1", title: "引言", content: "引擎刚写完的正文", status: "done" }];
    const inc = [{ id: "s1", title: "引言(改了标题)", content: "", status: "" }];
    const out = mergeSectionsById(cur, inc) as Array<Record<string, unknown>>;
    expect(out[0].content).toBe("引擎刚写完的正文"); // 空值保留节点现值
    expect(out[0].status).toBe("done");
    expect(out[0].title).toBe("引言(改了标题)");     // 编辑性字段以提交值为准
  });

  it("mergeById: 提交里没有的章节保留(客户端可能是旧视图)", () => {
    const cur = [{ id: "s1", title: "引言" }, { id: "s2", title: "结论" }];
    const inc = [{ id: "s1", title: "引言" }];
    const out = mergeSectionsById(cur, inc) as Array<Record<string, unknown>>;
    expect(out.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("读侧: sections 节点空数组也算(语义=清空章节), 与既有行为一致", () => {
    const merged = applyNodesToSnapshot({ sections: [{ id: "old" }] }, [{ node_key: "sections", payload: { sections: [] } }]);
    expect(merged.sections).toEqual([]);
  });

  it("读侧: 节点的空串不得盖掉快照里的值(与原来 truthy 判据一致)", () => {
    const merged = applyNodesToSnapshot({ input: { title: "快照里的标题" } }, [{ node_key: "input", payload: { input: "" } }]);
    expect(merged.input).toEqual({ title: "快照里的标题" });
  });
});
