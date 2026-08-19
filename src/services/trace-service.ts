// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// trace-service.ts — Trace Waterfall 统一追踪（OTEL 风格 span）
// Ask 检索步骤 + Jobs 任务流水 → 统一 span 存储 + 查询
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

export interface TraceSpan {
  id: string;
  traceId: string;
  parentId?: string;
  kind: string;
  name: string;
  status: "ok" | "error" | "running";
  startedAt: string;
  durationMs?: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  detail?: string;
}

function spanFromRow(row: Record<string, unknown>): TraceSpan {
  return {
    id: String(row.id),
    traceId: String(row.trace_id),
    parentId: row.parent_id == null ? undefined : String(row.parent_id),
    kind: String(row.kind),
    name: String(row.name),
    status: String(row.status) as TraceSpan["status"],
    startedAt: String(row.started_at),
    durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
    tokensInput: Number(row.tokens_input ?? 0),
    tokensOutput: Number(row.tokens_output ?? 0),
    tokensCacheRead: Number(row.tokens_cache_read ?? 0),
    detail: row.detail == null ? undefined : String(row.detail)
  };
}

/** 记录一个 span */
export async function recordSpan(input: {
  traceId: string;
  parentId?: string;
  kind: string;
  name: string;
  status?: "ok" | "error" | "running";
  durationMs?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number };
  detail?: string;
}): Promise<TraceSpan> {
  const result = await pool.query(
    `insert into trace_spans (id, trace_id, parent_id, kind, name, status, duration_ms,
       tokens_input, tokens_output, tokens_cache_read, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
    [
      randomUUID(), input.traceId, input.parentId ?? null, input.kind, input.name,
      input.status ?? "ok", input.durationMs == null ? null : Math.round(input.durationMs),
      input.tokens?.input ?? 0, input.tokens?.output ?? 0, input.tokens?.cacheRead ?? 0,
      input.detail ?? null
    ]
  );
  return spanFromRow(result.rows[0]);
}

/** 查询 trace（按 trace_id 或最近 N 条） */
export async function listSpans(input: { traceId?: string; kind?: string; limit?: number } = {}): Promise<TraceSpan[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.traceId) {
    params.push(input.traceId);
    conditions.push(`trace_id = $${params.length}`);
  }
  if (input.kind) {
    params.push(input.kind);
    conditions.push(`kind = $${params.length}`);
  }
  params.push(input.limit ?? 50);
  const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  const result = await pool.query(
    `select * from trace_spans ${where} order by started_at desc limit $${params.length}`,
    params
  );
  return result.rows.map(spanFromRow);
}

/** 批量记录 spans（一次事务写入 — 避免多次 fire-and-forget 丢失） */
export async function recordSpansBatch(spans: Array<{
  traceId: string;
  kind: string;
  name: string;
  status?: "ok" | "error" | "running";
  durationMs?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number };
  detail?: string;
  io?: { input?: number; output?: number };
}>): Promise<void> {
  if (spans.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const s of spans) {
      // 入/出流量收敛标记（GBrain 风格：步骤名后附 入→出）
      let detail = s.detail ?? null;
      if (s.io && s.io.input !== undefined) {
        detail = `${detail ?? ""}【入 ${s.io.input} → 出 ${s.io.output ?? s.io.input}】`;
      }
      await client.query(
        `insert into trace_spans (id, trace_id, kind, name, status, duration_ms,
           tokens_input, tokens_output, tokens_cache_read, detail)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          randomUUID(), s.traceId, s.kind, s.name, s.status ?? "ok",
          s.durationMs == null ? null : Math.round(s.durationMs),
          s.tokens?.input ?? 0, s.tokens?.output ?? 0, s.tokens?.cacheRead ?? 0, detail
        ]
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.error("[trace] batch 落库失败:", error instanceof Error ? error.message : String(error));
  } finally {
    client.release();
  }
}

/** 最近 trace 列表（ingest 同名去重：入库重试产生重复记录时只留最新；Ask/Jobs 保留全部） */
export async function listTraces(input: { limit?: number } = {}): Promise<Array<{ traceId: string; name: string; spanCount: number; startedAt: string; status: string }>> {
  const result = await pool.query(
    `select trace_id, name, span_count, started_at, status from (
       select
         t.trace_id,
         t.name,
         t.span_count,
         t.started_at,
         t.status,
         row_number() over (
           partition by case when t.name like 'ingest:%' then t.name else t.trace_id::text end
           order by t.started_at desc
         ) as rn
       from (
         select
           trace_id,
           -- root span 优先作为 trace 名（ask:/ingest:/job: 前缀），否则取第一个 name
           (array_agg(name order by case when name like 'ask:%' or name like 'ingest:%' or name like 'job:%' then 0 else 1 end, started_at))[1] as name,
           count(*)::int as span_count,
           min(started_at) as started_at,
           -- 状态聚合：有 error → error；有 running → running；否则 ok
           case
             when count(*) filter (where status = 'error') > 0 then 'error'
             when count(*) filter (where status = 'running') > 0 then 'running'
             else 'ok'
           end as status
         from trace_spans
         group by trace_id
       ) t
     ) t2
     where t2.rn = 1
     order by t2.started_at desc
     limit $1`,
    [input.limit ?? 50]
  );
  return result.rows.map((row) => ({
    traceId: String(row.trace_id),
    name: String(row.name),
    spanCount: Number(row.span_count),
    startedAt: String(row.started_at),
    status: String(row.status)
  }));
}

/**
 * 按类型分组查询 trace（各组独立 limit，互不挤占）：
 * ask = Ask 检索（最新 N 条）；ingest = 文献入库（同名去重，最新 N 条）；other = Jobs 等
 */
export async function listTracesGrouped(input: { perGroup?: number } = {}): Promise<{
  ask: Array<{ traceId: string; name: string; spanCount: number; startedAt: string; status: string }>;
  ingest: Array<{ traceId: string; name: string; spanCount: number; startedAt: string; status: string }>;
  other: Array<{ traceId: string; name: string; spanCount: number; startedAt: string; status: string }>;
}> {
  const perGroup = input.perGroup ?? 50;
  const base = `
    from (
      select
        t.trace_id,
        t.name,
        t.span_count,
        t.started_at,
        t.status,
        row_number() over (
          partition by case when t.name like 'ingest:%' then t.name else t.trace_id::text end
          order by t.started_at desc
        ) as rn
      from (
        select
          trace_id,
          (array_agg(name order by case when name like 'ask:%' or name like 'ingest:%' or name like 'job:%' then 0 else 1 end, started_at))[1] as name,
          count(*)::int as span_count,
          min(started_at) as started_at,
          case
            when count(*) filter (where status = 'error') > 0 then 'error'
            when count(*) filter (where status = 'running') > 0 then 'running'
            else 'ok'
          end as status
        from trace_spans
        group by trace_id
      ) t
    ) t2
    where t2.rn = 1
  `;
  const rowTo = (row: Record<string, unknown>) => ({
    traceId: String(row.trace_id),
    name: String(row.name),
    spanCount: Number(row.span_count),
    startedAt: String(row.started_at),
    status: String(row.status)
  });
  const [askR, ingestR, otherR] = await Promise.all([
    pool.query(`select trace_id, name, span_count, started_at, status ${base} and t2.name like 'ask:%' order by t2.started_at desc limit $1`, [perGroup]),
    pool.query(`select trace_id, name, span_count, started_at, status ${base} and t2.name like 'ingest:%' order by t2.started_at desc limit $1`, [perGroup]),
    pool.query(`select trace_id, name, span_count, started_at, status ${base} and t2.name not like 'ask:%' and t2.name not like 'ingest:%' order by t2.started_at desc limit $1`, [perGroup])
  ]);
  return {
    ask: askR.rows.map(rowTo),
    ingest: ingestR.rows.map(rowTo),
    other: otherR.rows.map(rowTo)
  };
}

/** 删除一条 trace（连带其全部 span） */
export async function deleteTrace(traceId: string): Promise<{ ok: boolean; deleted: number }> {
  const result = await pool.query(`delete from trace_spans where trace_id = $1`, [traceId]);
  return { ok: true, deleted: result.rowCount ?? 0 };
}

/** 批量删除 trace（用户勾选多条批量删） */
export async function deleteTracesBatch(traceIds: string[]): Promise<{ ok: boolean; deleted: number }> {
  if (traceIds.length === 0) return { ok: true, deleted: 0 };
  // trace_id 是 text 列，用 text[] 匹配（不用 uuid[]）
  const result = await pool.query(`delete from trace_spans where trace_id = any($1::text[])`, [traceIds]);
  return { ok: true, deleted: result.rowCount ?? 0 };
}

/** 清空全部 trace（保留表结构） */
export async function clearTraces(): Promise<{ ok: boolean; deleted: number }> {
  const result = await pool.query(`delete from trace_spans`);
  return { ok: true, deleted: result.rowCount ?? 0 };
}

export const traceService = {
  record: recordSpan,
  recordBatch: recordSpansBatch,
  list: listSpans,
  listTraces,
  listTracesGrouped,
  deleteTrace,
  deleteTracesBatch,
  clearTraces
};
