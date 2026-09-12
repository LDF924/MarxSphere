/**
 * SocialSci Vue 共享 API 层 — 还原自闭源 index-xpWAkSSw.js(共享 chunk)的 q() 封装
 * 原实现(L12813): fetch("/api"+path, {headers: Go()}) → Bearer skf_auth_token → 401 清 token + 广播 auth-expired
 * 我方适配: token 读 skf_auth_token(闭源键), 回退 sag_token(仓库 React 登录态键, server.ts requireUser JWT)
 */
export const API_BASE = "/api";
export const TOKEN_KEY = "skf_auth_token";
export const AUTH_EXPIRED_EVENT = "researchflow:auth-expired";

export function readToken(): string {
  return localStorage.getItem(TOKEN_KEY) || localStorage.getItem("sag_token") || "";
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** q(): 401 → 清 token + 全局广播; 非 2xx 或 {success:false,error} 抛 ApiError; 成功返回解析后 JSON */
export async function q<T = unknown>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; raw?: boolean } = {}): Promise<T> {
  // 无 body 的 POST(POST lock/unlock/cancel/restore 等)不带 Content-Type —
  // Fastify 对空 body + application/json 直接 500 "Body cannot be empty"
  const hasBody = opts.body !== undefined;
  const headers = authHeaders(opts.headers || {});
  if (!hasBody) delete headers["Content-Type"];
  const res = await fetch(API_BASE + path, {
    method: opts.method || "GET",
    headers,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    throw new ApiError(401, "UNAUTHORIZED", "登录已过期");
  }
  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json") ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const err = payload?.error ?? {};
    const code = typeof err === "string" ? err : (err?.code ?? "ERROR");
    const message = typeof err === "string" ? err : (err?.userMessage ?? err?.message ?? res.statusText);
    throw new ApiError(res.status, code, message);
  }
  if (payload && payload.success === false) {
    throw new ApiError(res.status, payload.error?.code ?? "ERROR", payload.error?.message ?? "请求失败");
  }
  return (payload ?? {}) as T;
}

/** FormData 上传(不带 Content-Type, 浏览器自动带 boundary — 对齐闭源 extract-text 语义) */
export async function uploadForm<T = unknown>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { method: "POST", headers, body: form, signal });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    throw new ApiError(401, "UNAUTHORIZED", "登录已过期");
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const err = payload?.error ?? {};
    throw new ApiError(res.status, typeof err === "string" ? err : err?.code ?? "ERROR", typeof err === "string" ? err : err?.message ?? res.statusText);
  }
  return payload as T;
}

/** 鉴权二进制获取(原文 content / pdf 字节等) */
export async function authedBlob(path: string): Promise<Blob> {
  const headers: Record<string, string> = {};
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { headers });
  if (!res.ok) throw new ApiError(res.status, "HTTP_" + res.status, `请求失败(${res.status})`);
  return res.blob();
}

export interface SseHandle {
  promise: Promise<void>;
  controller: AbortController;
}

/** SSE 帧解析: event: X + data: JSON 两行式(兼容纯 data 行=无事件名增量) */
export function parseSseFrame(text: string): Array<{ event: string | null; data: string }> {
  const out: Array<{ event: string | null; data: string }> = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) out.push({ event, data: dataLines.join("\n") });
  }
  return out;
}

/**
 * 流式 SSE(fetch + ReadableStream, AbortController 贯穿 — 对齐闭源 sn()/ma() 语义)
 * onEvent(event|null, payload) / onDone() / onError(err)
 */
export function streamSse(
  path: string,
  handlers: {
    onEvent?: (event: string | null, data: unknown, raw: string) => void;
    onDone?: () => void;
    onError?: (err: Error) => void;
    after?: number;
    /** 外部中止信号(如面板「停止」按钮): 与内部 controller 联动 */
    signal?: AbortSignal;
  },
  body?: unknown
): SseHandle {
  const controller = new AbortController();
  // 外部 signal 一中止就 abort 内部 controller — 否则调用方 abort 的是孤儿对象, 流照跑
  if (handlers.signal) {
    if (handlers.signal.aborted) controller.abort();
    else handlers.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const url = API_BASE + path + (handlers.after ? `?after=${handlers.after}` : "");
  const promise = (async () => {
    const headers = authHeaders();
    const res = await fetch(url, {
      headers,
      method: body !== undefined ? "POST" : "GET",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal
    });
    if (!res.ok || !res.body) {
      const msg = `流连接失败(${res.status})`;
      handlers.onError?.(new ApiError(res.status, "SSE_" + res.status, msg));
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // 帧可能跨 chunk: 按完整 \n\n 切
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const f of parseSseFrame(frame)) {
            let payload: unknown = null;
            try { payload = f.data ? JSON.parse(f.data) : null; } catch { payload = f.data; }
            if (f.event === "[DONE]" || f.event === "done") { handlers.onDone?.(); return; }
            handlers.onEvent?.(f.event, payload, f.data);
          }
        }
      }
      // 尾帧
      if (buf.trim()) {
        for (const f of parseSseFrame(buf)) {
          let payload: unknown = null;
          try { payload = f.data ? JSON.parse(f.data) : null; } catch { payload = f.data; }
          if (f.event === "[DONE]" || f.event === "done") { handlers.onDone?.(); return; }
          handlers.onEvent?.(f.event, payload, f.data);
        }
      }
      handlers.onDone?.();
    } catch (e) {
      if ((e as Error).name !== "AbortError") handlers.onError?.(e as Error);
    }
  })();
  return { promise, controller };
}
