// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// error-recovery-map.ts — 故障分类学 + 恢复策略映射表（BOOK-GAP-ROADMAP P0-10）
// 纯函数，无副作用，可单测。分类规则第一版（后续用归因数据扩充）
// 核心原则（书中 Ch5）: 第一判断不是"要不要重试"而是"值不值得重试"
//   - 可重试（限流/过载/抖动）才重试
//   - 不可重试（参数不合法/权限不足/工具不存在）必须改变输入或策略

export type ErrorCategory =
  | "api_rate_limit"      // 429 / rate limit
  | "api_overload"        // Connection reset / 过载
  | "api_timeout"         // ETIMEDOUT / timeout / FETCH_TIMEOUT
  | "api_truncation"      // finish_reason=length 输出截断
  | "tool_hallucination"  // 幻觉工具名
  | "tool_malformed_args" // JSON parse failed / 参数畸形
  | "tool_repeat_same"    // 同一 {tool, params} 指纹重复 ≥3 次
  | "tool_missing"        // tool not found / MCP Connection closed
  | "context_overflow"    // 上下文溢出
  | "context_compress_failed"
  | "context_trace_corrupt"
  | "loop_deadlock"
  | "loop_death_spiral"
  | "unknown";

export type RecoveryStrategy =
  | { kind: "retry_backoff"; maxAttempts: number; baseMs: number; jitterMs: number }
  | { kind: "change_input"; hint: string }
  | { kind: "fallback_strategy"; next: "expandedQuery" | "hyde" | "entityBoost" | "reasonFast" }
  | { kind: "surface_to_user"; detail: string }
  | { kind: "circuit_break"; cooldownMs: number };

export interface Classification {
  category: ErrorCategory;
  retryable: boolean;
  strategy: RecoveryStrategy;
}

/** 分类错误 → {类别, 可否重试, 恢复策略} */
export function classifyError(err: unknown): Classification {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();

  // 限流 / 过载
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) {
    return { category: "api_rate_limit", retryable: true, strategy: { kind: "retry_backoff", maxAttempts: 3, baseMs: 2000, jitterMs: 3000 } };
  }
  // 2026-09-13 合并三份分类器时补全: 原先只认 503, 漏了 500/502/504(上游 5xx 都是可重试类);
  //   也漏了 socket/hang up("socket hang up" 是最常见的连接中断写法)。三条都实测过原实现判成"不可重试"。
  if (msg.includes("connection reset") || msg.includes("econnreset") || msg.includes("overloaded")
      || /(^|[^0-9])5[0-9][0-9]([^0-9]|$)/.test(msg) || msg.includes("bad gateway") || msg.includes("service unavailable")
      || msg.includes("socket") || msg.includes("hang up") || msg.includes("econnrefused") || msg.includes("eai_again")) {
    return { category: "api_overload", retryable: true, strategy: { kind: "retry_backoff", maxAttempts: 2, baseMs: 3000, jitterMs: 3000 } };
  }

  // 超时
  if (msg.includes("timeout") || msg.includes("etimedout") || msg.includes("abort") || msg.includes("fetch_tim") || msg.includes("超时") || msg.includes("timed out")) {
    return { category: "api_timeout", retryable: true, strategy: { kind: "retry_backoff", maxAttempts: 2, baseMs: 5000, jitterMs: 2000 } };
  }

  // 输出截断（推理模型 reasoning 占满配额）
  if (msg.includes("finish_reason") && msg.includes("length")) {
    return { category: "api_truncation", retryable: true, strategy: { kind: "change_input", hint: "减小 prompt 或禁用 thinking" } };
  }

  // 工具类
  if (msg.includes("json parse failed") || msg.includes("malformed") || msg.includes("invalid json")) {
    return { category: "tool_malformed_args", retryable: false, strategy: { kind: "change_input", hint: "重发带原始响应" } };
  }
  if (msg.includes("tool not found") || msg.includes("invalid tool") || msg.includes("mcp connection closed") || msg.includes("unknown tool")) {
    return { category: "tool_missing", retryable: false, strategy: { kind: "fallback_strategy", next: "reasonFast" } };
  }
  if (msg.includes("hallucinat") || msg.includes("nonexistent tool")) {
    return { category: "tool_hallucination", retryable: false, strategy: { kind: "change_input", hint: "重新声明可用工具列表" } };
  }

  // 上下文类
  if (msg.includes("context") && (msg.includes("overflow") || msg.includes("too long") || msg.includes("max tokens"))) {
    return { category: "context_overflow", retryable: false, strategy: { kind: "change_input", hint: "压缩上下文后重试" } };
  }
  if (msg.includes("compress") && msg.includes("fail")) {
    return { category: "context_compress_failed", retryable: false, strategy: { kind: "circuit_break", cooldownMs: 120000 } };
  }

  // 循环类
  if (msg.includes("deadlock") || msg.includes("no progress") || msg.includes("stuck")) {
    return { category: "loop_deadlock", retryable: false, strategy: { kind: "fallback_strategy", next: "reasonFast" } };
  }

  // 认证
  if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("invalid api key") || msg.includes("403") || msg.includes("forbidden")) {
    return { category: "unknown", retryable: false, strategy: { kind: "surface_to_user", detail: "认证/权限错误，检查 API Key" } };
  }

  return { category: "unknown", retryable: false, strategy: { kind: "surface_to_user", detail: msg.substring(0, 120) } };
}

/** 重复调用指纹：{tool, params} JSON 哈希（防止同一失败反复重试） */
export function toolCallFingerprint(tool: string, params: unknown): string {
  try {
    const s = JSON.stringify({ tool, params: params ?? null });
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return String(hash);
  } catch {
    return tool;
  }
}
