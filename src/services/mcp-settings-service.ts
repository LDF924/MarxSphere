import { config } from "../config/env.js";

export interface PublicMcpSettings {
  toolTimeoutMs: number;
  clientConfigs: Array<{
    id: string;
    title: string;
    description: string;
    config: Record<string, unknown>;
  }>;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    example: Record<string, unknown>;
  }>;
}

export function getPublicMcpSettings(): PublicMcpSettings {
  return {
    toolTimeoutMs: config.MCP_TOOL_TIMEOUT_MS,
    clientConfigs: buildClientConfigs(),
    tools: [
      {
        name: "sag_ingest_document",
        description: "导入文档并执行切片、事件抽取、实体抽取和向量化。",
        inputSchema: objectSchema({
          title: { type: "string", minLength: 1, description: "文档标题。" },
          content: { type: "string", minLength: 1, description: "文档正文。" },
          metadata: { type: "object", description: "可选。文档元数据。" },
          extract: { type: "boolean", description: "可选。是否执行事件和实体抽取。" },
          waitForCompletion: { type: "boolean", description: "可选。是否等待处理完成后再返回。" }
        }, ["title", "content"]),
        example: {
          title: "产品方案",
          content: "这里是需要导入的文档正文。",
          extract: true,
          waitForCompletion: true
        }
      },
      {
        name: "sag_search",
        description: "对 MCP server 配置绑定的项目执行 SAG 多路检索，并返回内部检索 trace。支持 searchMode=fast 使用实体全文匹配 + qwen3-rerank 极速检索。",
        inputSchema: objectSchema({
          query: { type: "string", minLength: 1, description: "检索问题或 Agent 改写后的搜索语句。" },
          strategy: { type: "string", enum: ["vector", "multi"], description: "可选。vector 为纯向量，multi 为 SAG 多路检索。" },
          searchMode: { type: "string", enum: ["standard", "fast"], description: "可选。省略时使用全局默认检索模式。" },
          subStrategy: { type: "string", enum: ["multi", "multi1", "hopllm"], description: "可选。SAG 多跳子策略。" },
          topK: { type: "integer", minimum: 1, maximum: 50, description: "可选。返回候选数量，默认由服务端决定。" },
          returnTrace: { type: "boolean", description: "可选。是否返回内部检索链路。" }
        }, ["query"]),
        example: {
          query: "SAG 为什么比传统 RAG 更适合多跳检索？",
          strategy: "multi",
          searchMode: "fast",
          returnTrace: true
        }
      },
      {
        name: "sag_explain_search",
        description: "返回当前项目的 SAG 检索链路说明和 trace，用于调试检索过程。",
        inputSchema: objectSchema({
          query: { type: "string", minLength: 1, description: "需要解释的检索问题。" },
          searchMode: { type: "string", enum: ["standard", "fast"], description: "可选。省略时使用全局默认检索模式。" },
          subStrategy: { type: "string", enum: ["multi", "multi1", "hopllm"], description: "可选。SAG 多跳子策略。" },
          topK: { type: "integer", minimum: 1, maximum: 50, description: "可选。返回候选数量。" }
        }, ["query"]),
        example: {
          query: "解释 SAG 检索为什么召回这些事件",
          searchMode: "standard"
        }
      },
      {
        name: "sag_get_event",
        description: "按事件 ID 查询事件详情。",
        inputSchema: objectSchema({
          eventId: { type: "string", format: "uuid", description: "事件 ID。" }
        }, ["eventId"]),
        example: {
          eventId: "00000000-0000-0000-0000-000000000000"
        }
      },
    ]
  };
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function buildClientConfigs(): PublicMcpSettings["clientConfigs"] {
  const serverName = "sag";
  const npmConfig = {
    mcpServers: {
      [serverName]: {
        command: "npm",
        args: ["run", "mcp"],
        env: {
          SAG_MCP_SOURCE_ID: "__SAG_PROJECT_ID__"
        }
      }
    }
  };

  return [
    {
      id: "stdio-npm",
      title: "mcpServers JSON",
      description: "适合 Claude Desktop、Cursor、Windsurf 等支持 mcpServers 的本机 MCP 客户端。",
      config: npmConfig
    }
  ];
}
