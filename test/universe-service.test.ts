// universe-service.test.ts — Explore 快照契约单测(阶段4b)
// 验证 timeline bundle 契约 / expand patch 契约 / manifest 分区 / rebuild+job
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn() },
}));
vi.mock("../src/db/neo4j-query.js", () => ({
  neo4jQuery: vi.fn(async () => []),
}));

import { pool } from "../src/db/pool.js";
import { neo4jQuery } from "../src/db/neo4j-query.js";
import {
  universeExpand,
  universeJob,
  universeManifest,
  universeRebuild,
  universeTimeline,
} from "../src/services/universe-service.js";

function eventRow(id: string, title: string, created: string) {
  return {
    id,
    title,
    summary: `摘要 ${title}`,
    category: "event",
    chunk_id: null,
    start_time: null,
    rank: 2,
    parent_id: null,
    related_count: 1,
    created_at: created,
  };
}

/** 按 SQL 内容路由 mock,避免并行查询(Promise.all)与 Once 顺序冲突。 */
function mockPoolBySql(handlers: Array<{ match: RegExp; rows: unknown[] }>) {
  vi.mocked(pool.query).mockImplementation(async (sql: string) => {
    for (const handler of handlers) {
      if (handler.match.test(String(sql))) return { rows: handler.rows } as any;
    }
    return { rows: [] } as any;
  });
}

describe("universe timeline 快照契约", () => {
  beforeEach(() => {
    vi.mocked(pool.query).mockReset();
  });

  it("返回 schema_version 3 的 bundle 页, ordinal 单调且游标指向事件身份", async () => {
    mockPoolBySql([
      { match: /count\(\*\)::int as total/, rows: [{ total: 1, latest: "2026-08-02T00:00:00Z" }] },
      { match: /from events e\s+where e\.source_id/, rows: [eventRow("e-1", "事件一", "2026-08-01T00:00:00Z")] },
      { match: /newest_id/, rows: [{ newest_id: "e-1", oldest_id: "e-1" }] },
      { match: /row_number\(\) over/, rows: [{ id: "e-1", ordinal: 0 }] },
    ]);

    const slice = await universeTimeline({
      epoch: 1,
      source_id: "source-a",
      direction: "older",
      limit: 20,
    });

    expect(slice.schema_version).toBe(3);
    expect(slice.epoch).toBe(1);
    expect(slice.source_id).toBe("source-a");
    expect(slice.snapshot_id).toMatch(/^snap-/);
    expect(slice.bundles).toHaveLength(1);
    expect(slice.bundles[0]).toMatchObject({
      bundle_id: "bundle:e-1",
      ordinal: 0,
      cursor_before: null,
      cursor_after: null,
    });
    expect(slice.bundles[0].event).toMatchObject({
      kind: "event",
      id: "e-1",
      label: "事件一",
      source_id: "source-a",
      state: "active",
    });
    expect(slice.page.returned_bundles).toBe(1);
    expect(slice.total_events).toBe(1);
  });

  it("空来源时返回空 bundle 页但保留契约字段", async () => {
    mockPoolBySql([
      { match: /count\(\*\)::int as total/, rows: [{ total: 0, latest: "" }] },
      { match: /from events e\s+where e\.source_id/, rows: [] },
      { match: /newest_id/, rows: [{ newest_id: null, oldest_id: null }] },
    ]);
    const slice = await universeTimeline({
      epoch: 2,
      source_id: "source-empty",
      direction: "older",
    });
    expect(slice.bundles).toEqual([]);
    expect(slice.page.returned_bundles).toBe(0);
    expect(slice.page.has_more).toBe(false);
  });

  it("带游标时 has_newer/has_older 语义成立(非边界页)", async () => {
    mockPoolBySql([
      { match: /count\(\*\)::int as total/, rows: [{ total: 10, latest: "2026-08-20T00:00:00Z" }] },
      { match: /from events e\s+where e\.source_id/, rows: [eventRow("e-mid", "中间事件", "2026-08-15T00:00:00Z")] },
      { match: /newest_id/, rows: [{ newest_id: "e-new", oldest_id: "e-old" }] },
      { match: /row_number\(\) over/, rows: [{ id: "e-mid", ordinal: 5 }] },
    ]);

    const slice = await universeTimeline({
      epoch: 3,
      source_id: "source-a",
      direction: "older",
      cursor: "e-mid",
    });
    expect(slice.page.has_newer).toBe(true);
    expect(slice.page.has_older).toBe(true);
    expect(slice.page.next_cursor).toBe("e-mid");
  });
});

describe("universe expand 快照契约", () => {
  beforeEach(() => {
    vi.mocked(pool.query).mockReset();
  });

  it("事件扩展返回 schema_version 2 patch, 关系闭包完整", async () => {
    mockPoolBySql([
      { match: /count\(\*\)::int as total/, rows: [{ total: 5, latest: "2026-08-01T00:00:00Z" }] },
      { match: /select e\.id, e\.title/, rows: [{ id: "e-1", title: "事件一", summary: "", category: "event", chunk_id: null, start_time: null, rank: 2, related_count: 1 }] },
      { match: /join entities ent/, rows: [
        { id: "ent-1", name: "实体一", type: "person", description: "描述" },
        { id: "ent-2", name: "实体二", type: "org", description: "" },
      ] },
    ]);

    const patch = await universeExpand({
      epoch: 5,
      source_id: "source-a",
      node_kind: "event",
      node_id: "e-1",
      limit: 8,
    });

    expect(patch.schema_version).toBe(2);
    expect(patch.anchor).toMatchObject({ id: "e-1", kind: "event" });
    expect(patch.nodes).toHaveLength(2);
    expect(patch.nodes[0]).toMatchObject({ id: "ent-1", kind: "entity", label: "实体一" });
    expect(patch.relations).toHaveLength(2);
    expect(patch.relations[0]).toMatchObject({
      source_id: "source-a",
      from_id: "e-1",
      to_id: "ent-1",
      kind: "mentions",
    });
    expect(patch.page.returned).toBe(2);
    expect(patch.snapshot_id).toMatch(/^snap-/);
  });

  it("实体扩展返回以实体为锚的事件列表", async () => {
    mockPoolBySql([
      { match: /count\(\*\)::int as total/, rows: [{ total: 5, latest: "" }] },
      { match: /select ent\.id, ent\.name/, rows: [{ id: "ent-1", name: "实体一", type: "person", description: "", related_count: 2 }] },
      { match: /join events e on e\.id = ee\.event_id/, rows: [eventRow("e-1", "事件一", "2026-08-01T00:00:00Z")] },
    ]);

    const patch = await universeExpand({
      epoch: 6,
      source_id: "source-a",
      node_kind: "entity",
      node_id: "ent-1",
      limit: 4,
    });

    expect(patch.anchor).toMatchObject({ id: "ent-1", kind: "entity" });
    expect(patch.nodes[0]).toMatchObject({ id: "e-1", kind: "event" });
    expect(patch.relations[0]).toMatchObject({ from_id: "e-1", to_id: "ent-1" });
  });

  it("实体扩展时叠加 Graphiti 超边(Neo4j 在线)", async () => {
    mockPoolBySql([
      { match: /count\(\*\)::int as total/, rows: [{ total: 5, latest: "" }] },
      { match: /select ent\.id, ent\.name/, rows: [{ id: "ent-1", name: "实体一", type: "person", description: "", related_count: 2 }] },
      { match: /join events e on e\.id = ee\.event_id/, rows: [] },
    ]);
    vi.mocked(neo4jQuery).mockResolvedValue([
      { name: "外部实体X", labels: ["concept"], rel: "MENTIONS" },
      { name: "外部实体Y", labels: ["org"], rel: "RELATED" },
    ]);

    const patch = await universeExpand({
      epoch: 6,
      source_id: "source-a",
      node_kind: "entity",
      node_id: "ent-1",
      limit: 4,
    });

    expect(patch.nodes.some((node) => node.id === "g:外部实体X")).toBe(true);
    expect(patch.nodes.some((node) => node.id === "g:外部实体Y")).toBe(true);
    expect(patch.relations.some((relation) =>
      relation.to_id === "g:外部实体X" && relation.description?.includes("Graphiti"))).toBe(true);
    expect(patch.nodes.find((node) => node.id === "g:外部实体X")?.label)
      .toBe("外部实体X");
  });

  it("实体扩展时 Graphiti 离线不阻断 PG 结果", async () => {
    mockPoolBySql([
      { match: /count\(\*\)::int as total/, rows: [{ total: 5, latest: "" }] },
      { match: /select ent\.id, ent\.name/, rows: [{ id: "ent-1", name: "实体一", type: "person", description: "", related_count: 2 }] },
      { match: /join events e on e\.id = ee\.event_id/, rows: [eventRow("e-1", "事件一", "2026-08-01T00:00:00Z")] },
    ]);
    vi.mocked(neo4jQuery).mockRejectedValue(new Error("connection refused"));

    const patch = await universeExpand({
      epoch: 6,
      source_id: "source-a",
      node_kind: "entity",
      node_id: "ent-1",
      limit: 4,
    });

    expect(patch.nodes).toHaveLength(1);
    expect(patch.nodes[0]).toMatchObject({ id: "e-1", kind: "event" });
  });

  it("锚点不存在时抛错", async () => {
    mockPoolBySql([]);
    await expect(universeExpand({
      epoch: 7,
      source_id: "source-a",
      node_kind: "event",
      node_id: "missing",
    })).rejects.toThrow("anchor event not found");
  });
});

describe("universe manifest + rebuild", () => {
  beforeEach(() => {
    vi.mocked(pool.query).mockReset();
  });

  it("manifest 返回分区与完整 policy", async () => {
    mockPoolBySql([
      { match: /from events where deleted_at is null$/, rows: [{ c: 10 }] },
      { match: /from entities$/, rows: [{ c: 20 }] },
      { match: /from event_entities ee/, rows: [{ c: 30 }] },
      { match: /from sources where archived_at/, rows: [{ c: 2 }] },
      { match: /from sources s\s+left join events/, rows: [{ id: "s-1", name: "来源一", events: 10 }] },
    ]);

    const manifest = await universeManifest();

    expect(manifest.status).toBe("ready");
    expect(manifest.counts).toMatchObject({ events: 10, entities: 20, relations: 30, sources: 2 });
    expect(manifest.partitions).toHaveLength(1);
    expect(manifest.partitions[0]).toMatchObject({ kind: "source", label: "来源一", event_count: 10 });
    expect(manifest.policy).toMatchObject({
      timeline_event_page_size: 20,
      event_entity_limit: 8,
      lod_orbit_px: 240,
      lod_near_px: 480,
      lod_deep_px: 960,
      node_budget_desktop: 700,
      edge_budget_desktop: 1_000,
    });
  });

  it("rebuild 返回可轮询 job 并推进到 succeeded", async () => {
    const job = await universeRebuild();
    expect(job.status).toBe("running");
    expect(job.type).toBe("universe-rebuild");

    await new Promise((resolve) => setTimeout(resolve, 400));
    const polled = await universeJob(job.id);
    expect(polled?.status).toBe("succeeded");
    expect(polled?.progress).toBe(1);
  });

  it("未知 job id 返回 null", async () => {
    expect(await universeJob("missing")).toBeNull();
  });
});
