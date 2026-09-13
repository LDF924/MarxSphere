// llm-cross-provider-strip.test.ts — 跨源降级时剥离私有字段(P0-12 Ch5 ②)
//
// 由来: 这个能力原先只存在于 `src/services/llm-call-policy.ts`(从未接线的 P0-12 实现),
//   而实际在跑的 `callLlm` 是把 messages **原样**发出去的 —— 实测对比过: 同一段带
//   reasoning_content 的 assistant 消息, 归档件会剥掉, callLlm 不剥。
//   归档件已删, 正确行为搬进 callLlm; 这里钉住"该剥的剥、不该剥的不动"。
import { describe, expect, it } from "vitest";
import http from "node:http";
import { callLlm } from "../src/ai/llm-common.js";

/** 起一个假端点, 把收到的 request body 原样记下来 */
function captureLlm(): Promise<{ url: string; bodies: () => string[]; close: () => void }> {
  const bodies: string[] = [];
  const s = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      bodies.push(b);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok({
    url: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1/chat/completions`,
    bodies: () => bodies,
    close: () => s.close(),
  })));
}

/** 带 DeepSeek 私有字段的 assistant 消息(模拟"主模型产出后又拿去降级"的场景) */
const MSGS = [
  { role: "user", content: "问题" },
  { role: "assistant", content: "答案", reasoning_content: "私有思考链" },
] as never[];

describe("跨源降级: 剥离发送方私有字段", () => {
  it("降级到非 DeepSeek 模型时, reasoning_content 不发给上游", async () => {
    const ep = await captureLlm();
    try {
      await callLlm({ messages: MSGS, url: ep.url, key: "k", model: "qwen3.7-max" });
      const parsed = JSON.parse(ep.bodies()[0]);
      expect(ep.bodies()[0]).not.toContain("reasoning_content");
      // 只该摘掉私有键, 正文与结构原样保留
      expect(parsed.messages).toEqual([
        { role: "user", content: "问题" },
        { role: "assistant", content: "答案" },
      ]);
    } finally { ep.close(); }
  }, 30000);

  it("同源(DeepSeek)调用保持原样, 不改变现有序列化", async () => {
    const ep = await captureLlm();
    try {
      await callLlm({ messages: MSGS, url: ep.url, key: "k", model: "deepseek-v4-flash" });
      expect(ep.bodies()[0]).toContain("reasoning_content");
    } finally { ep.close(); }
  }, 30000);

  it("未登记的模型名保守不动(不认识任何私有字段)", async () => {
    const ep = await captureLlm();
    try {
      await callLlm({ messages: MSGS, url: ep.url, key: "k", model: "some-unknown-model" });
      expect(ep.bodies()[0]).toContain("reasoning_content");
    } finally { ep.close(); }
  }, 30000);

  it("没有私有字段的普通消息, 跨源也不受影响", async () => {
    const ep = await captureLlm();
    try {
      const plain = [{ role: "user", content: "只有正文" }] as never[];
      await callLlm({ messages: plain, url: ep.url, key: "k", model: "qwen3.7-max" });
      const parsed = JSON.parse(ep.bodies()[0]);
      expect(parsed.messages).toEqual([{ role: "user", content: "只有正文" }]);
    } finally { ep.close(); }
  }, 30000);
});
