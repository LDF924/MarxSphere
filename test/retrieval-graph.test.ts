// retrieval-graph.test.ts — 请求级检索图单测(G2, 对齐 Zleap Tracker/PathAnalyzer 语义)
import { describe, expect, it } from "vitest";

import { GraphCollector, PathAnalyzer, Tracker } from "../src/services/retrieval-graph.js";

describe("Tracker", () => {
  it("addNode 去重且高优先级合并字段", () => {
    const t = new Tracker();
    t.addNode({ id: "e1", type: "entity", category: "", content: "旧", description: "", hop: 0, metadata: {} }, "route_stub");
    const merged = t.addNode({ id: "e1", type: "entity", category: "person", name: "马克思", content: "马克思", description: "经济学家", hop: 0, metadata: { score: 0.9 } }, "vector_projection");
    expect(t.allNodes.size).toBe(1);
    expect(merged.name).toBe("马克思");
    expect(merged.category).toBe("person");
    expect(merged.metadata.score).toBe(0.9);
  });

  it("addNode 类型冲突抛错", () => {
    const t = new Tracker();
    t.addNode({ id: "x", type: "entity", category: "", content: "", description: "", hop: 0, metadata: {} });
    expect(() => t.addNode({ id: "x", type: "event", category: "", content: "", description: "", hop: 0, metadata: {} })).toThrow();
  });

  it("addEdge 同 key 去重取 max confidence", () => {
    const t = new Tracker();
    t.addNode({ id: "q", type: "query", category: "origin", content: "问题", description: "", hop: 0, metadata: {} });
    t.addNode({ id: "e1", type: "event", category: "", content: "", description: "", hop: 0, metadata: {} });
    t.addEdge({ stage: "recall", method: "event_vector", fromId: "q", toId: "e1", confidence: 0.5 });
    t.addEdge({ stage: "recall", method: "event_vector", fromId: "q", toId: "e1", confidence: 0.9 });
    expect(t.allClues.size).toBe(1);
    expect([...t.allClues.values()][0].confidence).toBe(0.9);
  });

  it("addEdge 端点不存在抛错", () => {
    const t = new Tracker();
    expect(() => t.addEdge({ stage: "s", method: "m", fromId: "a", toId: "b" })).toThrow();
  });

  it("buildAnswerGraph 反向 BFS 只保留可达答案的节点", () => {
    const t = new Tracker();
    t.addNode({ id: "q", type: "query", category: "origin", content: "q", description: "", hop: 0, metadata: {} });
    t.addNode({ id: "ent", type: "entity", category: "", content: "ent", description: "", hop: 0, metadata: {} });
    t.addNode({ id: "ev1", type: "event", category: "", content: "", description: "", hop: 0, metadata: {} });
    t.addNode({ id: "ev2", type: "event", category: "", content: "", description: "", hop: 0, metadata: {} }); // 孤立
    t.addEdge({ stage: "recall", method: "entity_vector", fromId: "q", toId: "ent", confidence: 1.0 });
    t.addEdge({ stage: "recall", method: "entity_relation", fromId: "ent", toId: "ev1", confidence: 1.0 });
    const graph = t.buildAnswerGraph(["ev1"]);
    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).toContain("q");
    expect(nodeIds).toContain("ent");
    expect(nodeIds).toContain("ev1");
    expect(nodeIds).not.toContain("ev2"); // 孤立节点排除
  });
});

describe("PathAnalyzer", () => {
  it("枚举 query→event 路径并产出最短路径", () => {
    const t = new Tracker();
    t.addNode({ id: "q", type: "query", category: "origin", content: "q", description: "", hop: 0, metadata: {} });
    t.addNode({ id: "ent", type: "entity", category: "", content: "ent", description: "", hop: 0, metadata: {} });
    t.addNode({ id: "ev", type: "event", category: "", content: "", description: "", hop: 0, metadata: {} });
    t.addEdge({ stage: "recall", method: "entity_vector", fromId: "q", toId: "ent", confidence: 0.8 });
    t.addEdge({ stage: "recall", method: "entity_relation", fromId: "ent", toId: "ev", confidence: 0.9 });
    const result = new PathAnalyzer().analyze(t.snapshot(), ["ev"], 3);
    expect(result.stats.eventWithPathCount).toBe(1);
    expect(result.stats.totalPathCount).toBe(1);
    expect(result.shortestPaths["ev"]).toHaveLength(1);
    expect(result.shortestPaths["ev"][0]).toHaveLength(2); // q→ent→ev 两条边
  });

  it("环检测跳过循环边", () => {
    const t = new Tracker();
    t.addNode({ id: "q", type: "query", category: "origin", content: "q", description: "", hop: 0, metadata: {} });
    t.addNode({ id: "a", type: "entity", category: "", content: "a", description: "", hop: 0, metadata: {} });
    t.addNode({ id: "b", type: "entity", category: "", content: "b", description: "", hop: 0, metadata: {} });
    t.addNode({ id: "ev", type: "event", category: "", content: "", description: "", hop: 0, metadata: {} });
    t.addEdge({ stage: "recall", method: "m1", fromId: "q", toId: "a" });
    t.addEdge({ stage: "recall", method: "m2", fromId: "a", toId: "b" });
    t.addEdge({ stage: "recall", method: "m3", fromId: "b", toId: "a" }); // 环
    t.addEdge({ stage: "recall", method: "m4", fromId: "a", toId: "ev" });
    const result = new PathAnalyzer().analyze(t.snapshot(), ["ev"], 4);
    expect(result.stats.cycleEdgesSkipped).toBeGreaterThan(0);
  });
});

describe("GraphCollector", () => {
  it("enabled=false 时 record/build 全 no-op", async () => {
    const c = new GraphCollector(false);
    expect(c.recordQuery("q", "scope")).toBeTruthy(); // 返回稳定 id 但不记录
    const out = await c.build(["x"], true);
    expect(out.graph).toBeNull();
    expect(out.pathResult).toBeNull();
  });

  it("enabled=true 时 record 查询/实体/事件并 build 出图", async () => {
    const c = new GraphCollector(true);
    const qid = c.recordQuery("剩余价值率如何计算", "scope");
    c.recordEntity({ entity_id: "e1", name: "剩余价值率", type: "metric" }, qid, { entity_vector: 0.9 });
    c.recordEventRoutes(
      { event_id: "ev1", title: "剩余价值理论", content: "..." },
      "ev1",
      [{ entity_id: "e1", score: 0.8, description: "核心概念" }],
    );
    const out = await c.build(["ev1"], true);
    expect(out.graph).not.toBeNull();
    const nodeTypes = out.graph!.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("query");
    expect(nodeTypes).toContain("entity");
    expect(nodeTypes).toContain("event");
    expect(out.pathResult).not.toBeNull();
    expect(out.pathResult!.stats.eventWithPathCount).toBe(1);
  });
});
