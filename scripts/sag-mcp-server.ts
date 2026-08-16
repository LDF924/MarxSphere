// sag-mcp-server.ts — MarxSphere 对外 MCP Server（Claude Code / Codex 接入）
// 对标 Sciverse-Agent-Tools 模式: 薄包装 MarxSphere REST API → MCP 工具
// 暴露工具:
//   sag_reason     — 52步推理问答（多源检索+推理+反思）
//   sag_search     — 多源语义检索（PG向量+关键词）
//   sag_ingest     — 文档入库（上传文本切片向量化）
//   sag_documents  — 列出已入库文档
//
// 配置:
//   SAG_API_URL    默认 http://localhost:4173
//   SAG_API_TOKEN  外部部署时必填（MarxSphere 设置页生成 sag_xxx）
// 运行: npx tsx scripts/sag-mcp-server.ts
// 注册 Claude Code: .mcp.json mcpServers.sag { command: "npx", args: ["tsx", "scripts/sag-mcp-server.ts"] }
// 注册 Codex:      ~/.codex/config.toml [mcp_servers.sag]
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SAG_API_URL = (process.env.SAG_API_URL || "http://localhost:4173").replace(/\/$/, "");
const SAG_API_TOKEN = process.env.SAG_API_TOKEN || "";
const PROJECT_ID = process.env.SAG_PROJECT_ID || "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";

/** 带鉴权的 fetch 包装 */
async function sagFetch(path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SAG_API_TOKEN) headers["Authorization"] = "Bearer " + SAG_API_TOKEN;
  const res = await fetch(SAG_API_URL + path, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(600_000), // 推理最长 10 分钟
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || `HTTP ${res.status}`;
    throw new Error(`SAG API ${res.status}: ${msg}`);
  }
  return json;
}

const server = new Server(
  { name: "sag-mcp-server", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "sag_reason",
      description: `MarxSphere 52步深度推理问答：多源检索（PG向量/cognee/graphiti）+ 推理 + 自检反思。适用于多跳推理、概念辨析、需要引用论文原文依据的复杂学术问题。返回带检索证据的答案（含来源标记）。`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "问题（学术/政策/研究类，如：资本下乡对农户土地流转的影响机制是什么？）" },
          paperId: { type: "string", description: "限定单篇论文（可选）" },
          topK: { type: "number", description: "检索切片数，默认 15" },
          questionId: { type: "string", description: "评测联动题号（可选）" },
        },
        required: ["query"],
      },
    },
    {
      name: "sag_search",
      description: `MarxSphere 多源语义检索：返回与问题相关的论文切片（含来源论文标题/章节），适合快速检索证据、事实查证。比 sag_reason 轻量（不推理）。`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词/问题" },
          topK: { type: "number", description: "返回条数，默认 10，最大 30" },
        },
        required: ["query"],
      },
    },
    {
      name: "sag_ingest",
      description: `MarxSphere 文档入库：上传文本内容，自动切片 + 向量化 + 实体抽取，入 PG 向量库。入库后即可被 sag_reason / sag_search 检索到。`,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "文档标题（唯一，同标题会覆盖更新）" },
          content: { type: "string", description: "文档正文（Markdown 或纯文本，支持中文论文）" },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "sag_documents",
      description: `列出 MarxSphere 已入库文档（标题 + 状态 + 切片数），用于确认知识库覆盖范围。`,
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "返回条数，默认 20" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "sag_reason": {
        const a = (args ?? {}) as { query: string; paperId?: string; topK?: number; questionId?: string };
        if (!a.query) throw new Error("缺少 query");
        const body: Record<string, unknown> = { sourceId: PROJECT_ID, query: a.query, topK: a.topK ?? 15 };
        if (a.paperId) body.paperId = a.paperId;
        if (a.questionId) body.questionId = a.questionId;
        const result = await sagFetch("/api/reason/query", body);
        const trace = result.trace ?? {};
        const hypothesis = (trace.hypothesis as any)?.content ?? "";
        const entities = (trace.entityNames ?? []) as string[];
        const sources = (trace.retrieveSources ?? []) as string[];
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              answer: hypothesis,
              entities: entities.slice(0, 20),
              retrievalSources: sources,
              taskId: result.taskId,
            }, null, 2),
          }],
        };
      }
      case "sag_search": {
        const a = (args ?? {}) as { query: string; topK?: number };
        if (!a.query) throw new Error("缺少 query");
        const result = await sagFetch("/api/search", {
          query: a.query,
          sourceIds: [PROJECT_ID],
          topK: Math.min(a.topK ?? 10, 30),
        });
        const hits = (result.sections ?? result.results ?? result.hits ?? []).slice(0, a.topK ?? 10);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(hits.map((h: any) => ({
              title: (h.documentTitle ?? h.paperTitle ?? h.title ?? h.heading ?? "").replace(/^\[[^\]]+\]\s*/, ""),
              heading: h.heading ?? "",
              text: (h.content ?? h.text ?? h.rawContent ?? "").substring(0, 800),
              score: h.score ?? h.sim ?? undefined,
              source: h.sourceStep ?? h.source ?? undefined,
            })), null, 2),
          }],
        };
      }
      case "sag_ingest": {
        const a = (args ?? {}) as { title: string; content: string };
        if (!a.title || !a.content) throw new Error("缺少 title 或 content");
        const result = await sagFetch("/api/documents/upload", {
          sourceId: PROJECT_ID,
          fileName: a.title + ".md",
          title: a.title,
          content: a.content,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              documentId: result.documentId,
              chunkCount: result.chunkCount,
              eventCount: result.eventCount,
            }, null, 2),
          }],
        };
      }
      case "sag_documents": {
        const a = (args ?? {}) as { limit?: number };
        const result = await sagFetch(`/api/sources/${PROJECT_ID}/documents`);
        const docs = (result.documents ?? result.results ?? []).slice(0, Math.min(a.limit ?? 20, 100));
        return {
          content: [{
            type: "text",
            text: JSON.stringify(docs.map((d: any) => ({
              id: d.id ?? d.documentId,
              title: d.title,
              status: d.status,
              chunks: d.chunkCount ?? d.chunks ?? undefined,
            })), null, 2),
          }],
        };
      }
      default:
        throw new Error(`未知工具: ${name}`);
    }
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `错误: ${e?.message || String(e)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[sag-mcp] MarxSphere MCP server 就绪");
