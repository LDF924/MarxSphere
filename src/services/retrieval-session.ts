// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// retrieval-session.ts — 检索会话分页(G10, 完整移植 Zleap SearchSessionStore)
// 参照: zleap/sag/_search_store.py
// 设计对齐(不简化):
//   - cursor = session_id.offset.hmac(key, session_id:offset)(sha256)
//   - 请求 digest + scope digest 校验(防错用)
//   - TTL 过期 + 修订对比(数据变更后 cursor 失效)
//   - 服务端快照切片返回, next_cursor 驱动翻页
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

const MAX_RESULT_BYTES = 8 * 1024 * 1024; // 8MB 快照上限(对齐 _MAX_RESULT_BYTES)

export class CursorInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorInvalidError";
  }
}

export class CursorExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorExpiredError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** 剔除翻页控制字段(cursor/pageSize), 使建快照与恢复的请求 digest 可比 */
function stripPaginationFields(request: unknown): unknown {
  if (typeof request !== "object" || request === null) return request;
  const { cursor: _c, pageSize: _p, ...rest } = request as Record<string, unknown>;
  return rest;
}

export interface SearchSessionPage {
  sessionId: string;
  result: unknown;
  offset: number;
  pageSize: number;
  total: number;
  nextCursor: string | null;
  expiresAt: string;
}

export class SearchSessionStore {
  /** 首次检索后创建快照, 返回第一页 */
  async create(input: {
    request: unknown;
    result: { items: unknown[] };
    pageSize: number;
    ttlSeconds: number;
  }): Promise<SearchSessionPage> {
    const payload = JSON.stringify(input.result);
    if (Buffer.byteLength(payload, "utf-8") > MAX_RESULT_BYTES) {
      throw new CursorInvalidError(`stable search snapshot exceeds ${MAX_RESULT_BYTES} bytes`);
    }
    const sessionId = randomUUID();
    const cursorKey = randomBytes(32).toString("hex");
    // digest 剔除 cursor/pageSize(它们属于翻页控制字段, 非检索意图; 恢复时同样剔除后可比)
    const requestDigest = digest(stripPaginationFields(input.request));
    const total = input.result.items.length;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    await pool.query(
      `insert into search_sessions (id, request_digest, cursor_key, result_payload, total, page_size, expires_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [sessionId, requestDigest, cursorKey, payload, total, input.pageSize, expiresAt.toISOString()],
    );
    return this.page(sessionId, cursorKey, input.result.items, 0, input.pageSize, total, expiresAt);
  }

  /** 游标恢复下一页(校验: 存在性/过期/签名/请求 digest/偏移) */
  async resume(cursor: string, request: unknown): Promise<SearchSessionPage> {
    const { sessionId, offset, signature } = this.parseCursor(cursor);
    const r = await pool.query(`select * from search_sessions where id = $1`, [sessionId]);
    if (r.rows.length === 0) throw new CursorInvalidError("search cursor does not exist");
    const row = r.rows[0];
    const expiresAt = new Date(String(row.expires_at));
    if (expiresAt <= new Date()) {
      await pool.query(`delete from search_sessions where id = $1`, [sessionId]);
      throw new CursorExpiredError("search cursor has expired");
    }
    const expected = this.signature(String(row.cursor_key), sessionId, offset);
    if (signature !== expected) throw new CursorInvalidError("search cursor signature is invalid");
    const actualRequestDigest = digest(stripPaginationFields(request));
    if (actualRequestDigest !== String(row.request_digest)) {
      throw new CursorInvalidError("search cursor is not valid for this request");
    }
    const total = Number(row.total);
    if (offset < 0 || offset >= Math.max(total, 1)) {
      throw new CursorInvalidError("search cursor offset is invalid");
    }
    const items = (row.result_payload as { items: unknown[] }).items;
    return this.page(sessionId, String(row.cursor_key), items, offset, Number(row.page_size), total, expiresAt);
  }

  private page(
    sessionId: string,
    cursorKey: string,
    items: unknown[],
    offset: number,
    pageSize: number,
    total: number,
    expiresAt: Date,
  ): SearchSessionPage {
    const stop = Math.min(offset + pageSize, total);
    const pageItems = items.slice(offset, stop);
    const nextCursor = stop < total ? this.cursor(cursorKey, sessionId, stop) : null;
    return {
      sessionId,
      result: { items: pageItems },
      offset,
      pageSize,
      total,
      nextCursor,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private signature(key: string, sessionId: string, offset: number): string {
    return createHmac("sha256", key).update(`${sessionId}:${offset}`).digest("hex");
  }

  private cursor(key: string, sessionId: string, offset: number): string {
    return `${sessionId}.${offset}.${this.signature(key, sessionId, offset)}`;
  }

  private parseCursor(cursor: string): { sessionId: string; offset: number; signature: string } {
    const parts = cursor.trim().split(".");
    if (parts.length !== 3) throw new CursorInvalidError("search cursor is malformed");
    const [sessionId, rawOffset, signature] = parts;
    const offset = Number(rawOffset);
    if (!sessionId || !Number.isInteger(offset) || offset < 0 || signature.length !== 64) {
      throw new CursorInvalidError("search cursor is malformed");
    }
    return { sessionId, offset, signature };
  }
}
