// llm-policy-front-background.test.ts — 前台/后台调用的恢复分级(P0-12 Ch5 ①)
//
// 由来: 原计划要求"区分前台与后台调用 —— 主循环失败重试、辅助后台调用(有兜底的)失败直接放弃"。
//   不区分的后果是"重试放大": 查询变体/重排/题型复核这类辅助调用跟主链路一起重试+换模型,
//   挤占同一份并发配额(默认 8 路), 反而拖慢真正需要的那次调用。
//   这里钉住: 后台单次即弃(不重试、不降级), 前台保持既有重试+降级。
import { describe, expect, it } from "vitest";
import http from "node:http";
import { callLlm } from "../src/ai/llm-common.js";

const OK_BODY = { choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };

/** 假端点: 永远 500(可重试类), 记录被打了多少次 */
function flaky(): Promise<{ url: string; hits: () => number; close: () => void }> {
  let n = 0;
  const s = http.createServer((_req, res) => { n++; res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "upstream" })); });
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok({
    url: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1/chat/completions`,
    hits: () => n, close: () => s.close(),
  })));
}

describe("P0-12 恢复分级: 后台调用失败即弃", () => {
  it("policy=background 时只打一次, 不重试", async () => {
    const ep = await flaky();
    try {
      const r = await callLlm({ messages: [{ role: "user", content: "hi" }], url: ep.url, key: "k", model: "deepseek-v4-flash", policy: "background" });
      expect(r).toBeTruthy();            // 仍返回结果对象(带 error), 由调用方兜底
      expect(ep.hits()).toBe(1);         // 关键: 没有任何重试
    } finally { ep.close(); }
  }, 40000);

  it("policy=background 时不换模型降级(命中次数不随备用模型增加)", async () => {
    const ep = await flaky();
    try {
      await callLlm({ messages: [{ role: "user", content: "hi" }], url: ep.url, key: "k", model: "deepseek-v4-flash", policy: "background" });
      // deepseek-v4-flash 的降级链有 3 个备用模型; 若走了降级链这里会 > 1
      expect(ep.hits()).toBe(1);
    } finally { ep.close(); }
  }, 40000);

  it("前台(默认)仍然重试 —— 行为没被这次改动动到", async () => {
    const ep = await flaky();
    try {
      await callLlm({ messages: [{ role: "user", content: "hi" }], url: ep.url, key: "k", model: "deepseek-v4-flash" });
      expect(ep.hits()).toBeGreaterThan(1);   // 默认 2 次重试
    } finally { ep.close(); }
  }, 60000);
});
