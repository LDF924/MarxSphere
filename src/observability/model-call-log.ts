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
  return log;
}
