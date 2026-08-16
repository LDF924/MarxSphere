// circuit-breaker.test.ts — 熔断器单测（P0-11）
import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker, breakers, MAX_STEP_ITERATIONS, SESSION_TOKEN_BUDGET, MAX_CONSECUTIVE_SAME_FAILURES } from "../src/services/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("初始 CLOSED（不短路）", () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    expect(cb.isOpen()).toBe(false);
  });

  it("连续失败 < maxFailures 不 OPEN", () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
  });

  it("连续失败 ≥ maxFailures → OPEN（短路）", () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });

  it("冷却后 → HALF_OPEN 放行一次试探", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker("test", 2, 1000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    // 冷却期过 → HALF_OPEN 放行
    vi.advanceTimersByTime(1500);
    expect(cb.isOpen()).toBe(false); // 放行试探
    // 试探失败 → 重新 OPEN
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    vi.useRealTimers();
  });

  it("recordSuccess 复位熔断", () => {
    const cb = new CircuitBreaker("test", 2, 1000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    cb.recordSuccess();
    expect(cb.isOpen()).toBe(false);
    expect(cb.failureCount).toBe(0);
  });
});

describe("全局断路器实例", () => {
  it("5 个独立实例存在", () => {
    expect(breakers.compression.name).toBe("compression");
    expect(breakers.reflection.name).toBe("reflection");
    expect(breakers.llmJudge.name).toBe("llmJudge");
    expect(breakers.ingest.name).toBe("ingest");
    expect(breakers.graphitiHeavy.name).toBe("graphitiHeavy");
  });
});

describe("全局终止常量", () => {
  it("迭代上限 / token 预算 / 连续失败阈值有值", () => {
    expect(MAX_STEP_ITERATIONS).toBeGreaterThan(0);
    expect(SESSION_TOKEN_BUDGET).toBeGreaterThan(0);
    expect(MAX_CONSECUTIVE_SAME_FAILURES).toBeGreaterThan(0);
  });
});
