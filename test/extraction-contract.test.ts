// extraction-contract.test.ts — 事件抽取提示词契约单测(纯函数, 无 mock)
import { describe, expect, it } from "vitest";

import {
  buildExtractionMessages,
} from "../src/ingestion/prompts/build-extraction-messages.js";
import {
  extractDocumentContract,
  renderExtractionSystemPrompt,
} from "../src/ingestion/prompts/extract-document.js";
import {
  validateExtractionResponse,
} from "../src/ingestion/prompts/extraction-schema.js";

// llm-local.test.ts 的 4 个远程 mock 响应(防回归: 必须全部通过校验)
const historicalMocks = [
  {
    type: "response",
    data: {
      items: [
        {
          title: "SAG系统升级",
          summary: "SAG系统升级用于资料检索。",
          content: "SAG系统升级使用PostgreSQL数据库。",
          category: "系统升级",
          keywords: ["SAG系统", "PostgreSQL"],
          references: [1],
          entities: [{ type: "product", name: "SAG系统", description: "被升级的系统" }],
          is_valid: true,
          children: [
            {
              title: "MCP工具接入",
              content: "SAG系统接入MCP工具。",
              keywords: ["MCP工具"],
              references: [1],
              entities: [{ type: "product", name: "MCP工具", description: "用于测试的工具接入" }],
              is_valid: true,
              children: []
            }
          ]
        },
        {
          title: "Embedding生成",
          content: "SAG系统生成Embedding向量。",
          keywords: ["Embedding"],
          references: [1],
          entities: [{ type: "subject", name: "Embedding", description: "用于向量检索" }],
          is_valid: true,
          children: []
        }
      ],
      meta: { reason: "测试多事项违规输出" }
    }
  },
  {
    type: "response",
    data: {
      items: [{
        title: "Test Event",
        summary: "Test summary",
        content: "This is test content in English.",
        category: "测试",
        keywords: ["test"],
        references: [1],
        entities: [{ type: "subject", name: "Test", description: "test entity" }],
        is_valid: true,
        children: []
      }],
      meta: { reason: "语言漂移测试" }
    }
  },
  {
    type: "response",
    data: {
      items: [{
        title: "重试测试",
        summary: "重试测试摘要",
        content: "重试测试内容",
        category: "测试",
        keywords: ["重试"],
        references: [1],
        entities: [],
        is_valid: true,
        children: []
      }],
      meta: { reason: "重试测试" }
    }
  }
];

describe("extractDocumentContract", () => {
  it("systemPrompt 含关键约束段(Mandatory single event / Faithfulness)", () => {
    expect(extractDocumentContract.systemPrompt).toContain("Mandatory single event");
    expect(extractDocumentContract.systemPrompt).toContain("Faithfulness");
    expect(extractDocumentContract.systemPrompt).toContain("Output language must follow the main input language");
  });

  it("entityTypes 为 11 类且唯一", () => {
    expect(extractDocumentContract.entityTypes).toHaveLength(11);
    const types = extractDocumentContract.entityTypes.map((e) => e.type);
    expect(new Set(types).size).toBe(11);
  });

  it("outputSchema 含 items.maxItems:1 与 children.maxItems:0(提示级约束)", () => {
    const schema: any = extractDocumentContract.outputSchema;
    const items = schema.properties.data.properties.items;
    expect(items.maxItems).toBe(1);
    expect(items.items.properties.children.maxItems).toBe(0);
  });
});

describe("renderExtractionSystemPrompt", () => {
  it("含 Current time 且注入的 now 生效", () => {
    const rendered = renderExtractionSystemPrompt("2026-09-01T00:00:00.000Z");
    expect(rendered).toContain("Current time: 2026-09-01T00:00:00.000Z");
  });
  it("无参时渲染不残留占位符", () => {
    const rendered = renderExtractionSystemPrompt();
    expect(rendered).toContain("Current time: ");
    expect(rendered).not.toContain("${now}");
  });
});

describe("buildExtractionMessages", () => {
  it("返回 4 条消息, roles 顺序正确", () => {
    const messages = buildExtractionMessages({
      title: "测试文档",
      heading: "第一章",
      content: "内容",
      references: ["r1"],
    });
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
  it("示例 input/output 可 JSON.parse 且含 type 字段", () => {
    const messages = buildExtractionMessages({
      title: "t", content: "c", references: [],
    });
    const exampleInput = JSON.parse(messages[1].content) as any;
    const exampleOutput = JSON.parse(messages[2].content) as any;
    expect(exampleInput.type).toBe("request");
    expect(exampleOutput.type).toBe("response");
  });
  it("真实请求信封含 heading 前缀与实体类型白名单", () => {
    const messages = buildExtractionMessages({
      title: "t", heading: "H", content: "C", references: [],
    });
    const real = JSON.parse(messages[3].content) as any;
    expect(real.data.items[0].content).toContain("# H");
    expect(real.data.meta.entity_types).toHaveLength(11);
    expect(real.output_schema).toBeDefined();
  });
});

describe("validateExtractionResponse", () => {
  it("历史 3 个 mock 响应全部通过(防回归)", () => {
    for (const mock of historicalMocks) {
      const result = validateExtractionResponse(mock);
      expect(result.valid, JSON.stringify(result)).toBe(true);
    }
  });
  it("兼容裸 { items } 形态", () => {
    const result = validateExtractionResponse({
      items: [{
        title: "裸形态", content: "内容", is_valid: true,
      }],
    });
    expect(result.valid).toBe(true);
  });
  it("缺 type 字段 → invalid", () => {
    const result = validateExtractionResponse({
      data: { items: [{ title: "x", content: "c" }], meta: { reason: "r" } },
    });
    expect(result.valid).toBe(false);
  });
  it("实体 type 超白名单 → invalid", () => {
    const result = validateExtractionResponse({
      type: "response",
      data: {
        items: [{
          title: "x", content: "c", entities: [{ type: "not-a-type", name: "n", description: "d" }],
        }],
        meta: { reason: "r" },
      },
    });
    expect(result.valid).toBe(false);
  });
  it("非对象输入 → invalid", () => {
    expect(validateExtractionResponse(null).valid).toBe(false);
    expect(validateExtractionResponse("string").valid).toBe(false);
  });
  it("items 非数组 → invalid", () => {
    const result = validateExtractionResponse({
      type: "response",
      data: { items: "not-array", meta: { reason: "r" } },
    });
    expect(result.valid).toBe(false);
  });
});
