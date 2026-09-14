// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export type ModelCallKind = "llm" | "embedding";
export type ModelCallStatus = "SUCCEEDED" | "FAILED";

export interface ModelCallLogRecord {
  sequence: number;
  id: string;
  kind: ModelCallKind;
  operation: string;
  status: ModelCallStatus;
  createdAt: string;
  durationMs: number;
  request: unknown;
  response?: unknown;
  error?: string;
}

type ModelCallLogListener = (log: ModelCallLogRecord) => void;

const MAX_MODEL_CALL_LOGS = 500;
const MAX_IMPORTED_MODEL_CALL_LOG_IDS = MAX_MODEL_CALL_LOGS * 2;
const logs: ModelCallLogRecord[] = [];
const importedLogIds = new Set<string>();
const importedLogIdQueue: string[] = [];
const listeners = new Set<ModelCallLogListener>();
let latestSequence = 0;

export function createModelCallLogger(input: {
  kind: ModelCallKind;
  operation: string;
  request: unknown;
}) {
  const started = performance.now();
  return {
    succeed(response: unknown) {
      appendModelCallLog({
        kind: input.kind,
        operation: input.operation,
        status: "SUCCEEDED",
        request: input.request,
        response,
        durationMs: Math.round(performance.now() - started)
      });
    },
    fail(error: unknown, response?: unknown) {
      appendModelCallLog({
        kind: input.kind,
        operation: input.operation,
        status: "FAILED",
        request: input.request,
        response,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - started)
      });
    }
  };
}

export function listModelCallLogs(afterSequence = 0): {
  logs: ModelCallLogRecord[];
  latestSequence: number;
} {
  return {
    logs: logs.filter((log) => log.sequence > afterSequence),
    latestSequence
  };
}

export function importModelCallLog(log: ModelCallLogRecord): ModelCallLogRecord | null {
  if (importedLogIds.has(log.id)) {
    return null;
  }
  rememberImportedLogId(log.id);
  return appendModelCallLog({
    kind: log.kind,
    operation: log.operation,
    status: log.status,
    request: log.request,
    response: log.response,
    error: log.error,
    durationMs: log.durationMs
  });
}

function rememberImportedLogId(id: string) {
  importedLogIds.add(id);
  importedLogIdQueue.push(id);
  if (importedLogIdQueue.length <= MAX_IMPORTED_MODEL_CALL_LOG_IDS) {
    return;
  }
  const expiredIds = importedLogIdQueue.splice(0, importedLogIdQueue.length - MAX_IMPORTED_MODEL_CALL_LOG_IDS);
  for (const expiredId of expiredIds) {
    importedLogIds.delete(expiredId);
  }
}

export function subscribeModelCallLogs(listener: ModelCallLogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function appendModelCallLog(input: Omit<ModelCallLogRecord, "sequence" | "id" | "createdAt">): ModelCallLogRecord {
  latestSequence += 1;
  const log = {
    sequence: latestSequence,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...input
  };
  logs.push(log);
  if (logs.length > MAX_MODEL_CALL_LOGS) {
    logs.splice(0, logs.length - MAX_MODEL_CALL_LOGS);
  }
  for (const listener of listeners) {
    listener(log);
  }
  persistModelCallLog(log);
  return log;
}

/**
 * V417: 落库(迁移 151)。
 *
 * 内存环保留 —— 它服务的是同实例的 SSE 订阅与 `after` 增量轮询, 延迟最低。
 * 落库补的是内存环补不上的三件事: 重启后仍可查、多副本下能看到全部、以及按时间/状态筛历史。
 * 失败只 warn 一次量级的问题不逐条刷屏: 日志本身是观测设施, 它自己写不进去不该拖垮调用方。
 */
let persistWarned = false;
function persistModelCallLog(log: ModelCallLogRecord): void {
  void import("../db/pool.js")
    .then(({ pool }) =>
      pool.query(
        `insert into model_call_logs (id, kind, operation, status, duration_ms, error, request, response, created_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
         on conflict (id) do nothing`,
        [
          log.id, log.kind, log.operation, log.status, log.durationMs, log.error ?? null,
          safeJson(log.request), safeJson(log.response), log.createdAt,
        ],
      ),
    )
    .catch((e) => {
      if (!persistWarned) {
        persistWarned = true;
        console.warn("[model-call-log] 落库失败(后续同类失败不再刷屏):", String(e).slice(0, 140));
      }
    });
}

/** 请求/响应里有循环引用或 BigInt 时 JSON.stringify 会抛 —— 观测数据不该因此丢掉整条记录 */
function safeJson(v: unknown, maxLen = 8000): string | null {
  if (v === undefined || v === null) return null;
  try {
    const s = JSON.stringify(v);
    return s.length > maxLen ? JSON.stringify({ _truncated: true, head: s.slice(0, maxLen) }) : s;
  } catch {
    return JSON.stringify({ _unserializable: true, type: typeof v });
  }
}

/**
 * V417: 从库里读历史(重启后 / 跨副本)。
 * 内存环里没有的(比如上一个实例写的)由这里补齐 —— 端点把两者合并返回。
 */
export async function listModelCallLogsFromDb(opts: { limit?: number; status?: ModelCallStatus } = {}): Promise<ModelCallLogRecord[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
  try {
    const { pool } = await import("../db/pool.js");
    const r = opts.status
      ? await pool.query(
          `select id, kind, operation, status, duration_ms, error, request, response, created_at
             from model_call_logs where status=$1 order by created_at desc limit $2`, [opts.status, limit])
      : await pool.query(
          `select id, kind, operation, status, duration_ms, error, request, response, created_at
             from model_call_logs order by created_at desc limit $1`, [limit]);
    return r.rows.map((row, i) => ({
      sequence: -(i + 1),   // 负数 = 历史(内存环用正数), 端点合并时不会与实时流撞号
      id: String(row.id),
      kind: row.kind as ModelCallKind,
      operation: String(row.operation),
      status: row.status as ModelCallStatus,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      durationMs: Number(row.duration_ms ?? 0),
      request: row.request,
      response: row.response,
      error: row.error ?? undefined,
    }));
  } catch { return []; }
}

/** V417: 清理过期日志(启动时调用一次即可, 不必占一个定时器) */
export async function pruneModelCallLogs(keepDays = 7): Promise<number> {
  try {
    const { pool } = await import("../db/pool.js");
    const r = await pool.query(
      `delete from model_call_logs where created_at < now() - ($1::int || ' days')::interval`,
      [Math.max(1, keepDays)],
    );
    return r.rowCount ?? 0;
  } catch { return 0; }
}
