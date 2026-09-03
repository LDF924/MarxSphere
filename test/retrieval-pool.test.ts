// retrieval-pool.test.ts — 内存候选池单测(G3, 对齐 Zleap PooledCandidateSource 语义)
import { describe, expect, it, vi, beforeEach } from "vitest";

import { PooledCandidateSource, VectorCandidateSource } from "../src/services/retrieval-pool.js";

const mockPool = {
  query: vi.fn(),
};

describe("VectorCandidateSource", () => {
  beforeEach(() => { vi.mocked(mockPool.query).mockReset(); });

  it("recallDirect 查询事件并返回 entityIds", async () => {
    vi.mocked(mockPool.query).mockResolvedValue({
      rows: [
        { id: "ev1", title: "t1", summary: "s1", content: "c1", entity_ids: ["e1", "e2"], score: 0.9 },
        { id: "ev2", title: "t2", summary: "s2", content: "c2", entity_ids: ["e1"], score: 0.8 },
      ],
    } as any);
    const src = new VectorCandidateSource([1, 0, 0], ["s1"], mockPool as any);
    const rows = await src.recallDirect(10);
    expect(rows).toHaveLength(2);
    expect(rows[0].entityIds).toEqual(["e1", "e2"]);
    expect(rows[0].score).toBe(0.9);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it("eventsForKeys per-entity 截断", async () => {
    vi.mocked(mockPool.query).mockResolvedValue({
      rows: [
        { event_id: "ev1", entity_id: "e1", description: "d1", score: 0.9, data_source_id: "s1" },
        { event_id: "ev2", entity_id: "e1", description: "d2", score: 0.8, data_source_id: "s1" },
        { event_id: "ev3", entity_id: "e1", description: "d3", score: 0.7, data_source_id: "s1" },
      ],
    } as any);
    const src = new VectorCandidateSource([1, 0, 0], ["s1"], mockPool as any);
    const rows = await src.eventsForKeys(["e1"], 2);
    expect(rows).toHaveLength(2); // per-entity limit 2
  });
});

describe("PooledCandidateSource", () => {
  beforeEach(() => { vi.mocked(mockPool.query).mockReset(); });

  it("建池后 eventsForKeys 读内存倒排(不查库)", async () => {
    vi.mocked(mockPool.query).mockResolvedValue({
      rows: [
        { id: "ev1", title: "t1", summary: "s1", content: "c1", entity_ids: ["e1", "e2"], score: 0.9 },
        { id: "ev2", title: "t2", summary: "s2", content: "c2", entity_ids: ["e1"], score: 0.8 },
      ],
    } as any);
    const src = new PooledCandidateSource([1, 0, 0], ["s1"], 100, mockPool as any);
    // 建池: 触发一次查询
    const direct = await src.recallDirect(10);
    expect(direct).toHaveLength(2);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    // 实体路由: 读内存, 不再查库
    const relations = await src.eventsForKeys(["e1"], 10);
    expect(relations).toHaveLength(2);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // 仍是 1 次
  });

  it("池分 poolScore 返回池内事件分数", async () => {
    vi.mocked(mockPool.query).mockResolvedValue({
      rows: [{ id: "ev1", title: "t1", summary: "s1", content: "c1", entity_ids: ["e1"], score: 0.9 }],
    } as any);
    const src = new PooledCandidateSource([1, 0, 0], ["s1"], 100, mockPool as any);
    await src.recallDirect(10);
    expect(src.poolScore("ev1")).toBe(0.9);
    expect(src.poolScore("unknown")).toBeNull();
  });

  it("建池失败降级回向量源", async () => {
    vi.mocked(mockPool.query).mockRejectedValueOnce(new Error("db down"));
    vi.mocked(mockPool.query).mockResolvedValue({ rows: [] } as any);
    const src = new PooledCandidateSource([1, 0, 0], ["s1"], 100, mockPool as any);
    const rows = await src.recallDirect(10);
    expect(rows).toEqual([]);
    expect(src.poolScore("x")).toBeNull();
    expect(src.poolStats()).toBeNull();
  });

  it("poolStats 统计池大小与倒排键数", async () => {
    vi.mocked(mockPool.query).mockResolvedValue({
      rows: [
        { id: "ev1", title: "t1", summary: "s1", content: "c1", entity_ids: ["e1", "e2"], score: 0.9 },
        { id: "ev2", title: "t2", summary: "s2", content: "c2", entity_ids: ["e3"], score: 0.8 },
      ],
    } as any);
    const src = new PooledCandidateSource([1, 0, 0], ["s1"], 100, mockPool as any);
    await src.recallDirect(10);
    const stats = src.poolStats();
    expect(stats?.actual).toBe(2);
    expect(stats?.keyCount).toBe(3);
    expect(stats?.saturated).toBe(false);
  });
});
