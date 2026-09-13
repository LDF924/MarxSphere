// error-classifier-merge.test.ts — 合并三份错误分类器的安全网
//
// 背景: 项目里有三份判据重叠的错误分类器 ——
//   · error-recovery-map.classifyError  (13 类 + 5 恢复策略, 最全)
//   · llm-common.classifyLlmError       (4 类, 服务于 LLM 调用重试)
//   · agent-task-service.classifyRetry  (可重试 + 幂等性, 服务于任务步骤)
// 合并方向: 让后两者复用 classifyError(超集), 但**保持各自对外行为不变** ——
//   这份测试先把"现有行为"钉住, 改完必须仍全绿。
import { describe, expect, it } from "vitest";
import { classifyError } from "../src/services/error-recovery-map.js";
import { classifyLlmError } from "../src/ai/llm-common.js";
import { classifyRetry } from "../src/services/agent-task-service.js";

/** 两份分类器都能正确判定的错误串(可重试类) —— 合并后两侧都必须为 true */
const RETRYABLE_CASES = [
  "HTTP 429 rate limit exceeded",
  "503 Service Unavailable",
  "500 internal server error",
  "fetch failed: ECONNRESET",
  "请求超时",
  "socket hang up",
];
/** 明确不可重试的 */
const NON_RETRYABLE_CASES = ["401 unauthorized: invalid api key", "403 forbidden", "参数错误: topic 不能为空"];

describe("两份分类器在可重试判据上一致", () => {
  for (const msg of RETRYABLE_CASES) {
    it(`“${msg}” → 可重试`, () => {
      expect(classifyError(new Error(msg)).retryable, "classifyError").toBe(true);
      // classifyLlmError 需要显式状态码才能判 429/5xx —— 无状态码时它只认 timeout/network 文本。
      //   这不是缺陷, 是它的调用约定(它从 HTTP 响应拿 status 一起传); 这里带上状态码对齐两侧。
      const status = /\b429\b/.test(msg) ? 429 : /\b5\d\d\b/.test(msg) ? Number(msg.match(/\b5\d\d\b/)![0]) : undefined;
      expect(classifyLlmError(new Error(msg), status).retryable, "classifyLlmError").toBe(true);
    });
  }

  for (const msg of NON_RETRYABLE_CASES) {
    it(`“${msg}” → 不可重试`, () => {
      expect(classifyError(new Error(msg)).retryable, "classifyError").toBe(false);
      expect(classifyLlmError(new Error(msg)).retryable, "classifyLlmError").toBe(false);
      expect(classifyRetry(msg, "reason").retryable, "classifyRetry").toBe(false);
    });
  }
});

describe("classifyLlmError 无状态码时也能判(合并后的改进)", () => {
  it("只传错误文本时, 429/5xx 也能判出可重试", () => {
    // 合并前: 无状态码时只认 timeout/network 两个正则, "HTTP 429" 会落到 other/不可重试 ——
    //   而 mcp-agent-service.ts:1196 正是只传一个参数, 那个调用点的限流/5xx 一直判不出重试。
    //   复用 classifyError 后这条补上了。
    expect(classifyLlmError(new Error("HTTP 429 rate limit")).retryable).toBe(true);
    expect(classifyLlmError(new Error("HTTP 429 rate limit"), 429).retryable).toBe(true);
    expect(classifyLlmError(new Error("503 Service Unavailable")).retryable).toBe(true);
  });
});

describe("classifyLlmError 的状态码优先(classifyError 无法表达的部分)", () => {
  it("有状态码时以状态码为准, 不看错误文本", () => {
    // 文本像是认证错, 但状态码 429 说明是限流 —— 应按状态码判可重试
    expect(classifyLlmError(new Error("unauthorized"), 429).retryable).toBe(true);
    expect(classifyLlmError(new Error("timeout"), 400).retryable).toBe(false);
    expect(classifyLlmError(new Error("ok"), 500).retryable).toBe(true);
  });

  it("errorType 供调用方做差异化退避(限流要退得更久)", () => {
    expect(classifyLlmError(new Error("x"), 429).errorType).toBe("rate_limit");
    expect(classifyLlmError(new Error("x"), 503).errorType).toBe("server_error");
    expect(classifyLlmError(new Error("timeout")).errorType).toBe("timeout");
    expect(classifyLlmError(new Error("ECONNRESET")).errorType).toBe("network");
    expect(classifyLlmError(new Error("whatever")).errorType).toBe("other");
  });
});

describe("classifyRetry 的可重试判定", () => {
  it("网络/限流/5xx/超时 → 可重试", () => {
    for (const m of ["ECONNREFUSED", "429 Too Many", "503 Service Unavailable", "timeout 超时"]) {
      expect(classifyRetry(m, "reason").retryable, m).toBe(true);
    }
  });

  it("业务错误(参数/未找到) → 不可重试", () => {
    for (const m of ["参数错误: topic 不能为空", "not found", "无结果"]) {
      expect(classifyRetry(m, "reason").retryable, m).toBe(false);
    }
  });

  it("幂等性按步骤类型判定(检索/推理/评审可安全重跑)", () => {
    for (const t of ["retrieve", "reason", "review"]) {
      expect(classifyRetry("timeout", t).idempotent, t).toBe(true);
    }
    for (const t of ["write", "delete", "publish"]) {
      expect(classifyRetry("timeout", t).idempotent, t).toBe(false);
    }
  });

  it("不可重试时即使幂等也返回 retryable=false(幂等只影响'要不要谨慎', 不解除'不该重试')", () => {
    const r = classifyRetry("参数错误", "reason");
    expect(r.retryable).toBe(false);
    expect(r.idempotent).toBe(true);
  });
});
