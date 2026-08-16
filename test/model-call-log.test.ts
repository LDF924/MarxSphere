import { describe, expect, it } from "vitest";
import {
  createModelCallLogger,
  importModelCallLog,
  listModelCallLogs,
  subscribeModelCallLogs,
  type ModelCallLogRecord
} from "../src/observability/model-call-log.js";

describe("model call log", () => {
  it("notifies subscribers when a new model call log is appended", () => {
    const operation = `test.subscribe.${Date.now()}`;
    const received: ModelCallLogRecord[] = [];
    const unsubscribe = subscribeModelCallLogs((log) => {
      if (log.operation === operation) {
        received.push(log);
      }
    });

    try {
      const logger = createModelCallLogger({
        kind: "llm",
        operation,
        request: { prompt: "hello" }
      });
      logger.succeed({ answer: "world" });
    } finally {
      unsubscribe();
    }

    expect(received).toHaveLength(1);
    expect(received[0]?.status).toBe("SUCCEEDED");
  });

  it("imports external model call logs once", () => {
    const operation = `test.import.${Date.now()}`;
    const log: ModelCallLogRecord = {
      sequence: 99,
      id: `external-${operation}`,
      kind: "embedding",
      operation,
      status: "SUCCEEDED",
      createdAt: new Date().toISOString(),
      durationMs: 12,
      request: { input: "query" },
      response: { data: [1, 2, 3] }
    };
    const before = listModelCallLogs(0).latestSequence;

    const imported = importModelCallLog(log);
    const duplicate = importModelCallLog(log);
    const matchingLogs = listModelCallLogs(before).logs.filter((item) => item.operation === operation);

    expect(imported?.operation).toBe(operation);
    expect(duplicate).toBeNull();
    expect(matchingLogs).toHaveLength(1);
  });
});
