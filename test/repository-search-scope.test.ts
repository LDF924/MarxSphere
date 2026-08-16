import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  pool: db
}));

import {
  assertSourcesAccessible,
  getEntityDetail,
  getEventIdsByEntityIds,
  getEventDetail,
  searchChunksByVector,
  searchEntitiesByVector,
  searchEventsByTitleVector
} from "../src/db/repositories.js";

describe("search repository scope", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [] });
  });

  it("requires active projects during source access checks", async () => {
    const sourceId = "00000000-0000-0000-0000-000000000001";
    db.query.mockResolvedValueOnce({ rows: [{ id: sourceId }] });

    await assertSourcesAccessible([sourceId], "default");

    expect(normalizeSql(db.query.mock.calls[0][0])).toContain("archived_at is null");
  });

  it("filters archived documents and projects in vector chunk recall", async () => {
    await searchChunksByVector({
      sourceIds: ["00000000-0000-0000-0000-000000000001"],
      queryVector: [1, 0, 0],
      topK: 5
    });

    const sql = normalizeSql(db.query.mock.calls[0][0]);
    expect(sql).toContain("join documents d on d.id = c.document_id");
    expect(sql).toContain("join sources s on s.id = c.source_id");
    expect(sql).toContain("d.archived_at is null");
    expect(sql).toContain("s.archived_at is null");
  });

  it("filters archived documents and projects in event title recall", async () => {
    await searchEventsByTitleVector({
      sourceIds: ["00000000-0000-0000-0000-000000000001"],
      queryVector: [1, 0, 0],
      topK: 5,
      threshold: 0
    });

    const sql = normalizeSql(db.query.mock.calls[0][0]);
    expect(sql).toContain("join documents d on d.id = e.document_id");
    expect(sql).toContain("join sources s on s.id = e.source_id");
    expect(sql).toContain("d.archived_at is null");
    expect(sql).toContain("s.archived_at is null");
  });

  it("filters entity recall to entities linked with active events", async () => {
    await searchEntitiesByVector({
      sourceIds: ["00000000-0000-0000-0000-000000000001"],
      queryVector: [1, 0, 0],
      topK: 5,
      threshold: 0
    });

    const sql = normalizeSql(db.query.mock.calls[0][0]);
    expect(sql).toContain("from event_entities ee");
    expect(sql).toContain("join events e on e.id = ee.event_id");
    expect(sql).toContain("join documents d on d.id = e.document_id");
    expect(sql).toContain("d.archived_at is null");
    expect(sql).toContain("s.archived_at is null");
  });

  it("filters entity-to-event expansion to active documents", async () => {
    await getEventIdsByEntityIds({
      entityIds: ["00000000-0000-0000-0000-000000000011"],
      sourceIds: ["00000000-0000-0000-0000-000000000001"]
    });

    const sql = normalizeSql(db.query.mock.calls[0][0]);
    expect(sql).toContain("join documents d on d.id = e.document_id");
    expect(sql).toContain("join sources s on s.id = e.source_id");
    expect(sql).toContain("d.archived_at is null");
    expect(sql).toContain("s.archived_at is null");
  });

  it("scopes event detail by tenant and active project/document state", async () => {
    await getEventDetail({
      eventId: "00000000-0000-0000-0000-000000000021",
      tenantId: "default"
    });

    const sql = normalizeSql(db.query.mock.calls[0][0]);
    expect(sql).toContain("s.tenant_id = $2");
    expect(sql).toContain("s.archived_at is null");
    expect(sql).toContain("d.archived_at is null");
  });

  it("scopes entity detail by tenant and active event documents", async () => {
    await getEntityDetail({
      entityId: "00000000-0000-0000-0000-000000000011",
      tenantId: "default"
    });

    const sql = normalizeSql(db.query.mock.calls[0][0]);
    expect(sql).toContain("join documents d on d.id = e.document_id");
    expect(sql).toContain("s.tenant_id = $2");
    expect(sql).toContain("s.archived_at is null");
    expect(sql).toContain("d.archived_at is null");
  });
});

function normalizeSql(value: unknown): string {
  return String(value).replace(/\s+/g, " ").trim();
}
