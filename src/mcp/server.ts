// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// Based on Zleap-AI/SAG (MIT License) — https://github.com/Zleap-AI/SAG
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ingestionService } from "../services/ingestion-service.js";
import { searchService } from "../services/search-service.js";
import { graphService } from "../services/graph-service.js";
import { logger } from "../observability/logger.js";
import { subscribeModelCallLogs, type ModelCallLogRecord } from "../observability/model-call-log.js";
import type { SearchProgressEvent } from "../types.js";

export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "sag",
    version: "0.1.0"
  });

  server.tool(
    "sag_ingest_document",
    {
      title: z.string().min(1),
      content: z.string().min(1),
      metadata: z.record(z.unknown()).optional(),
      extract: z.boolean().optional(),
      waitForCompletion: z.boolean().optional(),
      chunking: z.object({
        mode: z.enum(["heading_strict", "token"]).optional(),
        maxTokens: z.number().int().min(64).max(8192).optional(),
        overlapTokens: z.number().int().min(0).max(4096).optional()
      }).optional(),
      // V311(P0-16): 真值守门员 — 模型自报期望值, 服务端查库真值核对（不一致拒绝执行）
      expected_doc_count: z.number().int().min(0).optional(),      // 模型自报"预计该库已有N篇相关文档"
      expected_latest_date: z.string().optional(),                  // 自报最新入库时间
    },
    async (input, extra) => {
      const notificationEmitter = createMcpNotificationEmitter(extra);
      const unsubscribe = notificationEmitter ? pipeMcpModelCallLogs(notificationEmitter) : () => undefined;
      try {
        // V311(P0-16): 服务端真值校验（最后守门员, 模型无法伪造的数据）
        // 不一致 → 拒绝执行 + 返回结构化错误（发现错误认知或潜在注入的信号）
        try {
          const { pool } = await import("../db/pool.js");
          const truth = await pool.query("select count(*)::int as n, max(created_at) as latest from documents");
          const actualCount = truth.rows[0]?.n ?? 0;
          const actualLatest = truth.rows[0]?.latest ?? null;
          if (input.expected_doc_count !== undefined && input.expected_doc_count !== actualCount) {
            return jsonContent({
              ok: false,
              error: "expected mismatch",
              detail: { expected: input.expected_doc_count, actual: actualCount, reported: input.expected_doc_count },
              message: `模型自报文档数 ${input.expected_doc_count} 与服务端真值 ${actualCount} 不一致，已拒绝入库（truth_gate）`
            });
          }
          if (input.expected_latest_date) {
            const reported = new Date(input.expected_latest_date).getTime();
            const actual = actualLatest ? new Date(actualLatest).getTime() : 0;
            if (Math.abs(reported - actual) > 24 * 3600 * 1000) {  // 差异 > 24h
              return jsonContent({
                ok: false,
                error: "expected mismatch",
                detail: { expected: input.expected_latest_date, actual: actualLatest },
                message: `模型自报最新入库时间 ${input.expected_latest_date} 与服务端真值 ${actualLatest} 差异超 24h，已拒绝入库（truth_gate）`
              });
            }
          }
        } catch { /* 真值查询失败 → 放行（不阻塞入库） */ }

        const result = await ingestionService.ingestDocument({
          ...input,
          sourceId: readConfiguredSourceId()
        });
        return jsonContent(result);
      } finally {
        unsubscribe();
      }
    }
  );

  server.tool(
    "sag_search",
    {
      query: z.string().min(1),
      strategy: z.enum(["vector", "multi"]).optional(),
      searchMode: z.enum(["standard", "fast"]).optional(),
      subStrategy: z.enum(["multi", "multi1", "hopllm"]).optional(),
      topK: z.number().int().positive().max(50).optional(),
      returnTrace: z.boolean().optional()
    },
    async (input, extra) => {
      const notificationEmitter = createMcpNotificationEmitter(extra);
      const unsubscribe = notificationEmitter ? pipeMcpModelCallLogs(notificationEmitter) : () => undefined;
      try {
        const result = await searchService.search(
          { ...input, sourceIds: [readConfiguredSourceId()], strategy: input.strategy ?? "multi", returnTrace: true },
          undefined,
          notificationEmitter ? createMcpProgressEmitter(notificationEmitter) : undefined
        );
        return jsonContent(result);
      } finally {
        unsubscribe();
      }
    }
  );

  server.tool(
    "sag_execute_code",
    {
      language: z.enum(["python", "javascript"]),
      code: z.string().min(1),
      timeoutMs: z.number().int().min(1000).max(60000).optional()
    },
    async (input) => {
      // 代码解释器（2026-08-07）：沙箱子进程执行，超时熔断 + 输出截断
      // 安全沙箱（#33）：黑名单禁止危险操作 + 工作目录隔离到临时目录
      // P0-2: 逻辑已提取到 code-sandbox-service（agent 工具与 MCP 共用同一沙箱）
      const { executeCode } = await import("../services/code-sandbox-service.js");
      const r = await executeCode({ language: input.language, code: input.code, timeoutMs: input.timeoutMs ?? 20000 });
      return jsonContent({
        ok: r.ok,
        stdout: r.stdout,
        stderr: r.stderr,
        error: r.error,
        durationMs: r.durationMs,
      });
    }
  );

  server.tool(
    "sag_browse",
    {
      url: z.string().url(),
      waitMs: z.number().int().min(0).max(20000).optional(),
      extractText: z.boolean().optional()
    },
    async (input) => {
      // 浏览器工具（2026-08-07）：Edge headless 抓取页面文本（SSR/静态页）
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { writeFileSync, readFileSync, mkdirSync } = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const execFileAsync = promisify(execFile);
      const waitMs = input.waitMs ?? 3000;
      const tmpDir = path.join(os.tmpdir(), "sag-browse");
      mkdirSync(tmpDir, { recursive: true });
      const outFile = path.join(tmpDir, `page-${Date.now()}.html`);
      const edge = process.env.AGENT_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
      try {
        await execFileAsync(edge, [
          "--headless", "--disable-gpu", "--dump-dom",
          `--virtual-time-budget=${waitMs}`,
          `--user-data-dir=${path.join(tmpDir, "profile")}`,
          input.url,
        ], { timeout: 45000, maxBuffer: 20 * 1024 * 1024, windowsHide: true })
          .then(({ stdout }) => writeFileSync(outFile, stdout, "utf8"))
          .catch((e) => writeFileSync(outFile, String(e?.stdout || e?.stderr || e), "utf8"));
        const html = readFileSync(outFile, "utf8");
        // 提取可见文本（粗略：去 script/style 标签）
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 5000);
        return jsonContent({ ok: true, title: (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "", text });
      } catch (e: any) {
        return jsonContent({ ok: false, error: String(e?.message || e).slice(0, 1000) });
      }
    }
  );

  server.tool(
    "sag_explain_search",
    {
      query: z.string().min(1),
      searchMode: z.enum(["standard", "fast"]).optional(),
      subStrategy: z.enum(["multi", "multi1", "hopllm"]).optional(),
      topK: z.number().int().positive().max(50).optional()
    },
    async (input, extra) => {
      const notificationEmitter = createMcpNotificationEmitter(extra);
      const unsubscribe = notificationEmitter ? pipeMcpModelCallLogs(notificationEmitter) : () => undefined;
      try {
        const result = await searchService.search(
          { ...input, sourceIds: [readConfiguredSourceId()], strategy: "multi", returnTrace: true },
          undefined,
          notificationEmitter ? createMcpProgressEmitter(notificationEmitter) : undefined
        );
        return jsonContent(result.trace ?? result);
      } finally {
        unsubscribe();
      }
    }
  );

  server.tool(
    "sag_get_event",
    {
      eventId: z.string().uuid()
    },
    async (input) => {
      const result = await graphService.getEvent(input.eventId);
      return jsonContent(result ?? { error: { code: "EVENT_NOT_FOUND", message: "Event not found" } });
    }
  );

  return server;
}

function readConfiguredSourceId(): string {
  const sourceId = process.env.SAG_MCP_SOURCE_ID?.trim() || process.env.SAG_MCP_PROJECT_ID?.trim();
  const parsed = z.string().uuid().safeParse(sourceId);
  if (!parsed.success) {
    throw new Error("MCP server must be started with SAG_MCP_SOURCE_ID set to the current project id.");
  }
  return parsed.data;
}

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

type McpToolExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
};

type McpNotificationEmitter = (message: unknown) => void;

function createMcpNotificationEmitter(extra: McpToolExtra): McpNotificationEmitter | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined || typeof extra.sendNotification !== "function") {
    return undefined;
  }

  let progress = 0;
  return (message: unknown) => {
    progress += 1;
    void extra.sendNotification?.({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        message: JSON.stringify(message)
      }
    }).catch((error: unknown) => {
      logger.warn({ error }, "failed to send MCP progress notification");
    });
  };
}

function createMcpProgressEmitter(emit: McpNotificationEmitter) {
  return (event: SearchProgressEvent) => {
    emit({
      kind: "sag_search_progress",
      event
    });
  };
}

function pipeMcpModelCallLogs(emit?: McpNotificationEmitter): () => void {
  if (!emit) {
    return () => undefined;
  }
  return subscribeModelCallLogs((log: ModelCallLogRecord) => {
    emit({
      kind: "sag_model_call_log",
      log
    });
  });
}

export async function startMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("SAG MCP stdio server started");
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  startMcpServer().catch((error: unknown) => {
    logger.error({ error }, "mcp server failed");
    process.exit(1);
  });
}
