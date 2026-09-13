// llm-retry.test.ts — 上游抖动重试的边界(P0-12)
//
// 由来(2026-09-13): 项目里三份 LLM 调用实现各缺一块 ——
//   inference-service.fetchLlm 任何失败直接 return null(撞一次限流就降级);
//   llm-common.fetchLlmDetailed 有分类能力但从不重试;
//   llm-call-policy 有重试却硬编码端点、绕开 BYOK 与成本账本、且没有生产调用方。
// 这里锁住"该重试的重试、不该重试的一次都不多发"——
// 尤其 4xx: 密钥无效/模型不存在重发多少次都是同样结果, 会白白拖慢每个请求。
import { describe, expect, it } from "vitest";
import http from "node:http";
import { fetchLlmDetailed } from "../src/ai/llm-common.js";

const OK_BODY = { choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } };

/** 起一个按次数决定响应的假 LLM 端点, 返回命中计数 */
function fakeLlm(handler: (n: number) => [number, unknown]): Promise<{ url: string; hits: () => number; close: () => void }> {
  let n = 0;
  const s = http.createServer((_req, res) => {
    n++;
    const [code, body] = handler(n);
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((ok) => {
    s.listen(0, "127.0.0.1", () => ok({
      url: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1/chat/completions`,
      hits: () => n,
      close: () => s.close(),
    }));
  });
}

const call = (url: string, retry?: number) =>
  fetchLlmDetailed({ url, key: "k", model: "m", messages: [{ role: "user", content: "hi" }], timeoutMs: 5000, ...(retry === undefined ? {} : { retry }) });

describe("LLM 重试: 上游抖动才重发", () => {
  it("429 限流退避后重发, 恢复成功", async () => {
    const ep = await fakeLlm((n) => (n <= 2 ? [429, { error: "rate limit" }] : [200, OK_BODY]));
    try {
      const r = await call(ep.url, 3);
      expect(r.ok).toBe(true);
      expect(ep.hits()).toBe(3);   // 两次失败 + 一次成功
    } finally { ep.close(); }
  }, 20000);

  it("5xx 重试到给定上限后放弃", async () => {
    const ep = await fakeLlm(() => [500, { error: "upstream" }]);
    try {
      const r = await call(ep.url, 2);
      expect(r.ok).toBe(false);
      expect(ep.hits()).toBe(3);   // 首调 + 2 次重试
    } finally { ep.close(); }
  }, 20000);
});

describe("LLM 重试: 4xx 一次都不多发", () => {
  it("401 密钥无效 — 立即返回, 不重试", async () => {
    const ep = await fakeLlm(() => [401, { error: "invalid_api_key" }]);
    try {
      const r = await call(ep.url, 3);
      expect(r.ok).toBe(false);
      expect(ep.hits()).toBe(1);
    } finally { ep.close(); }
  }, 20000);

  it("400 参数/模型名不匹配 — 立即返回, 不重试", async () => {
    const ep = await fakeLlm(() => [400, { error: "model not found" }]);
    try {
      const r = await call(ep.url, 3);
      expect(r.ok).toBe(false);
      expect(ep.hits()).toBe(1);
    } finally { ep.close(); }
  }, 20000);
});

describe("LLM 重试: 默认关闭", () => {
  it("不传 retry 时行为与接线前一致(单次)", async () => {
    const ep = await fakeLlm(() => [500, { error: "upstream" }]);
    try {
      const r = await call(ep.url);
      expect(r.ok).toBe(false);
      expect(ep.hits()).toBe(1);
    } finally { ep.close(); }
  }, 20000);
});
