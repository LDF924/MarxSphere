// retrieval-session.test.ts — 检索会话分页单测(G10, 对齐 Zleap SearchSessionStore 语义)
import { describe, expect, it, vi, beforeEach } from "vitest";

import { CursorInvalidError, SearchSessionStore } from "../src/services/retrieval-session.js";

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn() },
}));
import { pool } from "../src/db/pool.js";

const mockRow = (overrides: Record<string, unknown> = {}) => ({
  id: "session-1",
  request_digest: "req-digest",
  cursor_key: "key-1",
  result_payload: { items: [1, 2, 3, 4, 5] },
  total: 5,
  page_size: 2,
  expires_at: new Date(Date.now() + 60000).toISOString(),
  ...overrides,
});

describe("SearchSessionStore", () => {
  beforeEach(() => { vi.mocked(pool.query).mockReset(); });

  it("create 存快照并返回第一页 + nextCursor", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const store = new SearchSessionStore();
    const page = await store.create({
      request: { query: "q" },
      result: { items: [1, 2, 3, 4, 5] },
      pageSize: 2,
      ttlSeconds: 300,
    });
    expect(page.result).toEqual({ items: [1, 2] });
    expect(page.total).toBe(5);
    expect(page.nextCursor).not.toBeNull();
    expect(page.nextCursor!.split(".")).toHaveLength(3); // session.offset.signature
  });

  it("resume 校验签名后返回下一页", async () => {
    // create 时捕获 cursor_key(insert 参数 $3)
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const store = new SearchSessionStore();
    const created = await store.create({ request: { query: "q" }, result: { items: [1, 2, 3, 4, 5] }, pageSize: 2, ttlSeconds: 300 });
    const insertCall = vi.mocked(pool.query).mock.calls.find((c) => String(c[0]).includes("insert into search_sessions"));
    const cursorKey = String(insertCall?.[1]?.[2] ?? "");
    const reqDigest = String(insertCall?.[1]?.[1] ?? "");
    expect(cursorKey).toBeTruthy();
    expect(reqDigest).toBeTruthy();
    // resume: mock row 用真实 cursor_key 和真实 request_digest
    const [sid, off, sig] = created.nextCursor!.split(".");
    vi.mocked(pool.query).mockReset();
    vi.mocked(pool.query).mockResolvedValue({
      rows: [mockRow({ id: sid, cursor_key: cursorKey, request_digest: reqDigest })],
    } as any);
    const page = await store.resume(`${sid}.${off}.${sig}`, { query: "q" });
    expect(page.result).toEqual({ items: [3, 4] }); // offset=2, pageSize=2
  });

  it("resume 篡改签名拒绝", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [mockRow()] } as any);
    const store = new SearchSessionStore();
    await expect(store.resume("session-1.2.fake-signature", { query: "q" }))
      .rejects.toThrow(CursorInvalidError);
  });

  it("resume 请求 digest 不匹配拒绝", async () => {
    // create 后取真实 request_digest(insert 参数 $2)
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);
    const store = new SearchSessionStore();
    const created = await store.create({ request: { query: "q" }, result: { items: [1, 2, 3] }, pageSize: 2, ttlSeconds: 300 });
    const insertCall = vi.mocked(pool.query).mock.calls.find((c) => String(c[0]).includes("insert into search_sessions"));
    const reqDigest = String(insertCall?.[1]?.[1] ?? "");
    const cursorKey = String(insertCall?.[1]?.[2] ?? "");
    expect(reqDigest).toBeTruthy();
    expect(cursorKey).toBeTruthy();
    const [sid, off, sig] = created.nextCursor!.split(".");
    vi.mocked(pool.query).mockReset();
    vi.mocked(pool.query).mockResolvedValue({
      rows: [mockRow({ id: sid, cursor_key: cursorKey, request_digest: reqDigest })],
    } as any);
    // 用错误请求(不同 query)恢复 → digest 不匹配
    await expect(store.resume(`${sid}.${off}.${sig}`, { query: "different" }))
      .rejects.toThrow(CursorInvalidError);
  });

  it("resume 过期会话拒绝并删除", async () => {
    vi.mocked(pool.query).mockResolvedValue({
      rows: [mockRow({ expires_at: new Date(Date.now() - 1000).toISOString() })],
    } as any);
    const store = new SearchSessionStore();
    const fakeSig = "a".repeat(64);
    await expect(store.resume(`session-1.2.${fakeSig}`, { query: "q" }))
      .rejects.toThrow(/expired/i);
  });

  it("resume 畸形 cursor 拒绝", async () => {
    const store = new SearchSessionStore();
    await expect(store.resume("malformed", {})).rejects.toThrow(CursorInvalidError);
  });
});
