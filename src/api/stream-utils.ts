// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// api/stream-utils.ts — SocialSci P0-1: SSE 统一发送工具(从 /api/search/stream 先例抽取为单点)
// 语义: 事件名模块前缀规范(pipe.* / review.* / viz.* / rag.*), 错误统一 {code,userMessage,canRetry,hint}
// 用法: const sse = attachSse(reply); sse.send("pipe.started", {}); ... sse.end();
// 断线续传: 调用方自行持久化已发事件序号(见 research_tasks.progress), after=N 重放

import type { FastifyReply } from "fastify";

export interface SseEventError {
  code: string;
  userMessage: string;
  canRetry: boolean;
  hint?: string;
}

export interface AttachedSse {
  /** 发送一个命名事件(自动 JSON 序列化 + flush) */
  send(event: string, data: unknown): void;
  /** 发送结构化错误事件 */
  error(err: SseEventError | Error | string, code?: string): void;
  /** 结束流 */
  end(): void;
  /** 连接是否已关闭 */
  readonly closed: boolean;
}

/** 业务错误 → 结构化错误形状(供所有长任务流统一) */
export function toSseError(err: unknown, fallbackCode = "TASK_FAILED"): SseEventError {
  if (typeof err === "string") return { code: fallbackCode, userMessage: err, canRetry: false };
  const e = err as { code?: string; userMessage?: string; canRetry?: boolean; hint?: string; message?: string };
  return {
    code: e.code || fallbackCode,
    userMessage: e.userMessage || e.message || "任务执行失败",
    canRetry: e.canRetry ?? true,
    ...(e.hint ? { hint: e.hint } : {}),
  };
}

/** 挂接 SSE 响应头并返回发送句柄 */
export function attachSse(reply: FastifyReply): AttachedSse {
  const raw = reply.raw as typeof reply.raw & { flush?: () => void };
  raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  raw.on("close", () => { closed = true; });
  return {
    send(event: string, data: unknown) {
      if (closed) return;
      raw.write(`event: ${event}\n`);
      raw.write(`data: ${JSON.stringify(data)}\n\n`);
      if (typeof raw.flush === "function") raw.flush();
    },
    error(err, code) {
      this.send("error", toSseError(err, code));
    },
    end() {
      if (!closed) { try { raw.end(); } catch { /* 已关闭 */ } }
      closed = true;
    },
    get closed() { return closed; },
  };
}
