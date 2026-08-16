import { describe, expect, it } from "vitest";
import { defaultMcpSessionTitle, summarizeConversationTitle } from "../src/services/mcp-title.js";

describe("MCP conversation title", () => {
  it("keeps Chinese titles concise and in the original language", () => {
    expect(summarizeConversationTitle("请帮我分析 SAG2 改写计划里面最关键的风险是什么？"))
      .toBe("分析SAG2改写计划里面最关键的风险");
  });

  it("keeps English titles within the configured word budget", () => {
    expect(summarizeConversationTitle("Could you explain why the retrieval pipeline times out during reranking?"))
      .toBe("why the retrieval pipeline times out during reranking");
  });

  it("falls back to the default title for empty content", () => {
    expect(summarizeConversationTitle("   ")).toBe(defaultMcpSessionTitle());
  });
});
