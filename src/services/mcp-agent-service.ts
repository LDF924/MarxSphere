import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../config/env.js";
import {
  addMcpMessage,
  addMcpToolCall,
  clearMcpSession,
  createMcpSession,
  deleteMcpSession,
  getMcpSessionDetail,
  listMcpSessions,
  updateMcpSessionTitle
} from "../db/repositories.js";
import type { McpMessageImage, McpSessionRecord, McpToolCallRecord } from "../types.js";
import type { SearchProgressEvent } from "../types.js";
import { aiSettingsService, type AiRuntimeSettings } from "./ai-settings-service.js";
import { createModelCallLogger, importModelCallLog, type ModelCallLogRecord } from "../observability/model-call-log.js";
import { defaultMcpSessionTitle, summarizeConversationTitle } from "./mcp-title.js";
import { compressContext, estimateContextChars } from "./context-compressor.js";
import { classifyLlmError, retryBackoffMs } from "../ai/llm-common.js";  // G2: LLM 规划请求重试/退避

type ToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type ToolAction = {
  action: "call_tool" | "final";
  toolName?: string;
  arguments?: Record<string, unknown>;
  final?: string;
};

type AnswerCitation = {
  index: number;
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank?: number;
  score?: number;
  query?: string;
  toolCallId?: string;
};

export type McpRunStreamEvent =
  | { type: "stage"; label: string; detail?: string }
  | { type: "message"; message: { id: string; sessionId: string; role: string; content: string; metadata: Record<string, unknown>; createdAt: string } }
  | { type: "assistant_delta"; delta: string }
  | { type: "tool_start"; toolName: string; arguments: Record<string, unknown> }
  | { type: "search_progress"; event: SearchProgressEvent }
  | { type: "tool_end"; toolCall: McpToolCallRecord }
  | { type: "model"; model: string }
  | { type: "done"; detail: Awaited<ReturnType<typeof getMcpSessionDetail>> }
  | { type: "error"; message: string };

type StreamEmitter = (event: McpRunStreamEvent) => void;

export class McpAgentService {
  async createSession(input: {
    title?: string;
    sourceIds?: string[];
    kind?: "project" | "chat";
  }, tenantId = config.DEFAULT_TENANT_ID): Promise<McpSessionRecord> {
    const settings = await aiSettingsService.getRuntimeSettings();
    const title = input.title?.trim();
    const kind = input.kind ?? "project";
    return createMcpSession({
      tenantId,
      title: title || defaultMcpSessionTitle(),
      model: settings.hasRemoteLlm ? settings.llmModel : "local-rule-fallback",
      sourceIds: input.sourceIds ?? [],
      metadata: {
        createdVia: kind === "chat" ? "webui:chat" : "webui",
        autoTitle: !title
      },
      kind
    });
  }

  async listSessions(input: { sourceId?: string; kind?: "project" | "chat" } = {}, tenantId = config.DEFAULT_TENANT_ID) {
    return listMcpSessions({
      tenantId,
      limit: input.kind === "chat" ? 100 : 50,
      sourceId: input.sourceId,
      kind: input.kind
    });
  }

  /** V398: 会话重命名（AI 对话页/项目会话通用） */
  async updateTitle(sessionId: string, title: string, tenantId = config.DEFAULT_TENANT_ID) {
    return updateMcpSessionTitle({
      sessionId,
      tenantId,
      title,
      metadata: { renamedByUser: true }
    });
  }

  async getSession(sessionId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getMcpSessionDetail({ sessionId, tenantId });
  }

  async clearSession(sessionId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const cleared = await clearMcpSession({ sessionId, tenantId });
    if (!cleared) {
      return null;
    }
    return getMcpSessionDetail({ sessionId, tenantId });
  }

  async deleteSession(sessionId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const deleted = await deleteMcpSession({ sessionId, tenantId });
    if (!deleted) {
      return null;
    }
    return { deleted: true };
  }

  async runUserMessage(input: {
    sessionId: string;
    content: string;
    signal?: AbortSignal;
    /** V398: 通用 AI 对话（kind=chat）附带图片相对路径 */
    images?: McpMessageImage[];
    /** V398: 通用 AI 对话联网开关 — 开启时注入 web_search 结果 */
    webSearch?: boolean;
  }, tenantId = config.DEFAULT_TENANT_ID, emit?: StreamEmitter) {
    assertNotAborted(input.signal);
    emit?.({ type: "stage", label: "加载会话", detail: "正在读取当前 MCP 会话上下文" });
    const detail = await getMcpSessionDetail({
      sessionId: input.sessionId,
      tenantId
    });
    assertNotAborted(input.signal);
    if (!detail) {
      throw new Error("MCP 会话不存在");
    }

    const userMessage = await addMcpMessage({
      sessionId: input.sessionId,
      role: "user",
      content: input.content,
      images: input.images?.length ? input.images : undefined
    });
    let activeSession = detail.session;
    if (shouldAutoTitleSession(detail.session, detail.messages)) {
      const updatedSession = await updateMcpSessionTitle({
        sessionId: input.sessionId,
        tenantId,
        title: summarizeConversationTitle(input.content),
        metadata: {
          autoTitle: true,
          titledFromMessageId: userMessage.id
        }
      });
      if (updatedSession) {
        activeSession = updatedSession;
      }
    }
    assertNotAborted(input.signal);
    emit?.({ type: "message", message: userMessage });

    const toolCalls: McpToolCallRecord[] = [];
    let assistantText = "";
    const projectId = activeSession.sourceIds[0];
    if (!projectId) {
      // ── V398: 通用 AI 对话路径（kind=chat / 无项目绑定）──
      // 直调 LLM 流式回答（真 token），图片经 image_analyze 注入描述，联网开关注入 web_search 结果
      emit?.({ type: "stage", label: "生成回答", detail: "正在综合上下文生成回答" });
      const settings = await aiSettingsService.getRuntimeSettings();
      assertNotAborted(input.signal);
      if (!settings.hasRemoteLlm) {
        assistantText = "未配置远程 LLM（llmBaseUrl/llmApiKey），请在设置中填写后可对话。";
      } else {
        assistantText = await this.runChatLlmFlow({
          session: activeSession,
          messageId: userMessage.id,
          history: detail.messages,
          settings,
          userContent: input.content,
          images: input.images,
          webSearch: input.webSearch,
          toolCalls,
          signal: input.signal,
          emit
        });
      }
    } else {
      emit?.({ type: "stage", label: "连接 MCP", detail: "正在启动 MCP 客户端并发现可用工具" });
      const runner = await this.createRunner(projectId, input.signal);
      try {
        assertNotAborted(input.signal);
        const toolsResult = await runner.client.listTools(undefined, { signal: input.signal });
        const tools = toolsResult.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }));
        assertNotAborted(input.signal);
        emit?.({ type: "stage", label: "工具发现", detail: `发现 ${tools.length} 个 MCP 工具` });
        const settings = await aiSettingsService.getRuntimeSettings();
        assertNotAborted(input.signal);

        if (!settings.hasRemoteLlm) {
          assistantText = await this.runFallbackToolFlow({
            runner,
            session: activeSession,
            messageId: userMessage.id,
            userContent: input.content,
            toolCalls,
            signal: input.signal,
            emit
          });
        } else {
          assistantText = await this.runLlmToolFlow({
            runner,
            session: activeSession,
            messageId: userMessage.id,
            history: detail.messages,
            settings,
            tools,
            userContent: input.content,
            toolCalls,
            signal: input.signal,
            emit
          });
        }
      } finally {
        await runner.close();
      }
    }

    assertNotAborted(input.signal);
    const answerCitations = collectAnswerCitations(toolCalls);
    const assistantContent = assistantText || "已完成工具调用。";
    // V398: 通用对话（runChatLlmFlow）已真 token 流式 emit delta，此处跳过模拟打字避免重复输出
    if (projectId) {
      for (const delta of chunkText(assistantContent, 24)) {
        assertNotAborted(input.signal);
        emit?.({ type: "assistant_delta", delta });
        await sleep(12);
      }
    }
    assertNotAborted(input.signal);
    const assistant = await addMcpMessage({
      sessionId: input.sessionId,
      role: "assistant",
      content: assistantContent,
      metadata: answerCitations.length > 0 ? { citations: answerCitations } : undefined
    });
    emit?.({ type: "message", message: assistant });

    assertNotAborted(input.signal);
    const updatedDetail = await getMcpSessionDetail({
      sessionId: input.sessionId,
      tenantId
    });
    emit?.({ type: "done", detail: updatedDetail });

    return {
      session: activeSession,
      assistant,
      toolCalls,
      detail: updatedDetail
    };
  }

  /**
   * V398: 通用 AI 对话流（kind=chat，无项目绑定）—
   * 图片经 image_analyze 注入描述 → 联网开关注入 web_search → callLlm 真 token 流式 → 落库。
   */
  private async runChatLlmFlow(input: {
    session: McpSessionRecord;
    messageId: string;
    history: Awaited<ReturnType<typeof getMcpSessionDetail>>["messages"];
    settings: AiRuntimeSettings;
    userContent: string;
    images?: McpMessageImage[];
    webSearch?: boolean;
    toolCalls: McpToolCallRecord[];
    signal?: AbortSignal;
    emit?: StreamEmitter;
  }): Promise<string> {
    assertNotAborted(input.signal);
    const contextParts: string[] = [];

    // ① 图片 → image_analyze 描述注入（主进程直调，不经 stdio runner）
    for (const img of input.images ?? []) {
      assertNotAborted(input.signal);
      const started = performance.now();
      input.emit?.({ type: "tool_start", toolName: "image_analyze", arguments: { path: img.path, mode: "describe" } });
      const { analyzeImageAtPath } = await import("./agent-tool-router.js");
      const description = await analyzeImageAtPath(img.path, "describe");
      const toolCall = await addMcpToolCall({
        sessionId: input.session.id,
        messageId: input.messageId,
        toolName: "image_analyze",
        arguments: { path: img.path, mode: "describe" },
        result: { text: description },
        status: "SUCCEEDED",
        durationMs: Math.round(performance.now() - started)
      });
      input.toolCalls.push(toolCall);
      input.emit?.({ type: "tool_end", toolCall });
      contextParts.push(`[用户附件图片 ${img.name}] ${description}`);
    }

    // ② 联网开关 → web_search 结果注入
    if (input.webSearch) {
      assertNotAborted(input.signal);
      const { executeAgentTool } = await import("./agent-tool-router.js");
      const started = performance.now();
      input.emit?.({ type: "tool_start", toolName: "web_search", arguments: { query: input.userContent.slice(0, 80), source: "general", maxResults: 5 } });
      let resultText = "（联网搜索失败）";
      let failed = false;
      try {
        const toolResult = await executeAgentTool("web_search", {
          query: input.userContent.slice(0, 80),
          source: "general",
          maxResults: 5
        });
        resultText = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
      } catch (e: any) {
        failed = true;
        resultText = `（联网搜索异常: ${String(e?.message || e).slice(0, 120)}）`;
      }
      const toolCall = await addMcpToolCall({
        sessionId: input.session.id,
        messageId: input.messageId,
        toolName: "web_search",
        arguments: { query: input.userContent.slice(0, 80), source: "general", maxResults: 5 },
        result: { text: resultText },
        status: failed ? "FAILED" : "SUCCEEDED",
        durationMs: Math.round(performance.now() - started),
        error: failed ? resultText : undefined
      });
      input.toolCalls.push(toolCall);
      input.emit?.({ type: "tool_end", toolCall });
      contextParts.push(`[联网搜索结果]\n${resultText.slice(0, 4000)}`);
    }

    // ③ LLM 流式回答（真 token）
    assertNotAborted(input.signal);
    const { callLlm } = await import("../ai/llm-common.js");
    const historyForLlm = input.history.slice(-8);
    const recentTurns = historyForLlm
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    const { getRoleModel } = await import("./llm-model-registry.js");
    const model = input.session.model || getRoleModel("reason") || input.settings.llmModel;
    input.emit?.({ type: "model", model });

    const systemPrompt = [
      "你是 MarxSphere AI 助手，一名马克思主义理论研究科研助手。",
      "基于你的知识回答用户问题；若提供了检索结果/图片描述/联网搜索上下文，优先依据它们作答并标注来源。",
      "回答使用 Markdown：代码块用 ```lang 标注，数学公式用 $...$ 或 $$...$$。",
      "对于理论问题给出概念界定、历史脉络、当代意义的结构化回答。",
      "若上下文不足，诚实说明并建议使用 Ask 检索或 52 步推理获取文献级证据。"
    ].join("\n");

    const messages = [
      { role: "system", content: systemPrompt },
      ...recentTurns,
      {
        role: "user",
        content: [
          input.userContent,
          ...(contextParts.length > 0 ? [`\n\n---\n附加上下文（仅供参考）:\n${contextParts.join("\n\n")}`] : [])
        ].join("")
      }
    ];

    const result = await callLlm({
      model,
      agentContext: { action: "chat_general" },
      messages: messages as any,
      maxTokens: 2000,
      onStream: (delta) => {
        input.emit?.({ type: "assistant_delta", delta });
      }
    });

    assertNotAborted(input.signal);
    if (result?.error) {
      return `（模型调用失败: ${result.error.slice(0, 300)}）`;
    }
    return result?.text ?? "（无回答）";
  }

  private async createRunner(projectId: string, signal?: AbortSignal) {
    const client = new Client({
      name: "sag-webui",
      version: "0.1.0"
    });
    const transport = new StdioClientTransport({
      ...resolveMcpServerCommand(),
      env: childEnv(projectId),
      stderr: "pipe"
    });
    try {
      await client.connect(transport, { signal });
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    return {
      client,
      close: async () => {
        await transport.close();
      }
    };
  }

  private async runFallbackToolFlow(input: {
    runner: Awaited<ReturnType<McpAgentService["createRunner"]>>;
    session: McpSessionRecord;
    messageId: string;
    userContent: string;
    toolCalls: McpToolCallRecord[];
    signal?: AbortSignal;
    emit?: StreamEmitter;
  }): Promise<string> {
    const lower = input.userContent.toLowerCase();
    let finalText = "当前未配置 LLM_API_KEY，已使用有限本地规则回退，并通过真实 MCP 客户端测试工具。";

    if (/search|检索|搜索|查找|sag|multi/.test(lower)) {
      assertNotAborted(input.signal);
      const args = {
        query: input.userContent,
        strategy: "multi",
        returnTrace: true
      };
      input.emit?.({ type: "tool_start", toolName: "sag_search", arguments: args });
      const call = await this.callToolAndPersist(input.runner, input.session.id, "sag_search", args, input.messageId, input.signal, input.emit);
      input.toolCalls.push(call);
      input.emit?.({ type: "tool_end", toolCall: call });
      finalText = "已通过 MCP 调用 sag_search，并返回检索结果和检索链路。";
    }

    const eventId = input.userContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    if (/event|事件/.test(lower) && eventId) {
      assertNotAborted(input.signal);
      const args = { eventId };
      input.emit?.({ type: "tool_start", toolName: "sag_get_event", arguments: args });
      const call = await this.callToolAndPersist(input.runner, input.session.id, "sag_get_event", args, input.messageId, input.signal, input.emit);
      input.toolCalls.push(call);
      input.emit?.({ type: "tool_end", toolCall: call });
      finalText = "已通过 MCP 调用 sag_get_event 查询事件详情。";
    }

    if (input.toolCalls.length === 0) {
      finalText = "当前本地规则回退支持执行检索、查询事件。请尝试：搜索当前项目里的 SAG 多路检索。";
    }
    return finalText;
  }

  private async runLlmToolFlow(input: {
    runner: Awaited<ReturnType<McpAgentService["createRunner"]>>;
    session: McpSessionRecord;
    messageId: string;
    history: Array<{ role: string; content: string }>;
    settings: AiRuntimeSettings;
    tools: ToolInfo[];
    userContent: string;
    toolCalls: McpToolCallRecord[];
    signal?: AbortSignal;
    emit?: StreamEmitter;
  }): Promise<string> {
    let finalText = "";
    const observations: Array<{ toolName: string; result: unknown; error?: string | null }> = [];
    for (let step = 0; step < 6; step += 1) {
      assertNotAborted(input.signal);
      input.emit?.({ type: "stage", label: `LLM 规划 ${step + 1}`, detail: "正在决定下一步 MCP 工具调用" });
      const action = await planToolAction({
        userContent: input.userContent,
        session: input.session,
        history: input.history,
        settings: input.settings,
        tools: input.tools,
        observations,
        signal: input.signal
      });
      assertNotAborted(input.signal);
      if (action.action === "final") {
        finalText = action.final ?? "工具调用完成。";
        break;
      }
      if (!action.toolName || !input.tools.some((tool) => tool.name === action.toolName)) {
        finalText = "LLM 选择了不存在的工具，已停止本轮调用。";
        break;
      }
      const toolArguments = normalizeToolArguments(action.toolName, action.arguments ?? {});
      input.emit?.({ type: "tool_start", toolName: action.toolName, arguments: toolArguments });
      const call = await this.callToolAndPersist(
        input.runner,
        input.session.id,
        action.toolName,
        toolArguments,
        input.messageId,
        input.signal,
        input.emit
      );
      assertNotAborted(input.signal);
      input.toolCalls.push(call);
      input.emit?.({ type: "tool_end", toolCall: call });
      observations.push({
        toolName: action.toolName,
        result: call.result,
        error: call.error
      });
      if (call.status === "FAILED") {
        finalText = `工具 ${action.toolName} 调用失败：${call.error ?? "未知错误"}`;
        break;
      }
    }
    return finalText || "已完成本轮 MCP 工具调用。";
  }

  private async callToolAndPersist(
    runner: Awaited<ReturnType<McpAgentService["createRunner"]>>,
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    messageId?: string,
    signal?: AbortSignal,
    emit?: StreamEmitter
  ): Promise<McpToolCallRecord> {
    const started = performance.now();
    // W5: MCP 工具沙箱 — 复用 agent-tool-router 的网络/路径检查（检索/爬取类工具防 SSRF/越权）
    try {
      const { checkNetworkAccess, checkPathAccess } = await import("./agent-tool-router.js");
      for (const [k, v] of Object.entries(args)) {
        const sv = String(v || "");
        if (/url|link|site|href|endpoint|web/i.test(k) && sv.startsWith("http")) {
          const net = checkNetworkAccess(sv);
          if (!net.allowed) {
            return {
              id: crypto.randomUUID(), sessionId, toolName, arguments: args,
              status: "FAILED", durationMs: 0, error: `MCP 沙箱拦截: ${net.reason}`,
              createdAt: new Date().toISOString(),
            } as McpToolCallRecord;
          }
        }
        if (/path|file|dir/i.test(k) && (sv.includes("\\") || sv.includes("/"))) {
          const p = checkPathAccess(sv);
          if (!p.allowed) {
            return {
              id: crypto.randomUUID(), sessionId, toolName, arguments: args,
              status: "FAILED", durationMs: 0, error: `MCP 沙箱拦截: ${p.reason}`,
              createdAt: new Date().toISOString(),
            } as McpToolCallRecord;
          }
        }
      }
    } catch { /* 沙箱检查失败不阻塞(容错) */ }
    try {
      assertNotAborted(signal);
      const result = await runner.client.callTool(
        {
          name: toolName,
          arguments: args
        },
        undefined,
        {
          timeout: config.MCP_TOOL_TIMEOUT_MS,
          signal,
          resetTimeoutOnProgress: true,
          onprogress: (progress) => {
            const modelLog = parseModelCallLogProgress(progress.message);
            if (modelLog) {
              importModelCallLog(modelLog);
            }
            if (toolName === "sag_search" || toolName === "sag_explain_search") {
              const event = parseSearchProgress(progress.message);
              if (event) {
                emit?.({ type: "search_progress", event });
              }
            }
          }
        }
      );
      assertNotAborted(signal);
      return addMcpToolCall({
        sessionId,
        messageId,
        toolName,
        arguments: args,
        result,
        status: result.isError ? "FAILED" : "SUCCEEDED",
        durationMs: Math.round(performance.now() - started),
        error: result.isError ? extractToolText(result) : null
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new McpRunAbortedError();
      }
      return addMcpToolCall({
        sessionId,
        messageId,
        toolName,
        arguments: args,
        result: null,
        status: "FAILED",
        durationMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

class McpRunAbortedError extends Error {
  constructor() {
    super("MCP 对话已停止");
    this.name = "AbortError";
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new McpRunAbortedError();
  }
}

function normalizeToolArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const scopedArgs = { ...args };
  delete scopedArgs.sourceId;
  delete scopedArgs.sourceIds;
  delete scopedArgs.projectId;
  delete scopedArgs.projectIds;
  if (toolName !== "sag_search" && toolName !== "sag_explain_search") {
    return scopedArgs;
  }
  const strategy = scopedArgs.strategy === "vector" || scopedArgs.strategy === "multi"
    ? scopedArgs.strategy
    : "multi";
  const normalized: Record<string, unknown> = {
    ...scopedArgs,
    strategy,
    returnTrace: true
  };
  if (scopedArgs.searchMode === "standard" || scopedArgs.searchMode === "fast") {
    normalized.searchMode = scopedArgs.searchMode;
  }
  return normalized;
}

function shouldAutoTitleSession(session: McpSessionRecord, messages: Array<{ role: string }>): boolean {
  if (messages.some((message) => message.role === "user")) {
    return false;
  }
  if (session.metadata.autoTitle === false) {
    return false;
  }
  return session.metadata.autoTitle === true ||
    session.title === defaultMcpSessionTitle() ||
    session.title === "新 MCP 测试会话";
}

async function planToolAction(input: {
  userContent: string;
  session: McpSessionRecord;
  history: Array<{ role: string; content: string }>;
  settings: AiRuntimeSettings;
  tools: ToolInfo[];
  observations: Array<{ toolName: string; result: unknown; error?: string | null }>;
  signal?: AbortSignal;
}): Promise<ToolAction> {
  assertNotAborted(input.signal);
  // V380(P0-6): 对话历史接入分层压缩 — 取最近 10 条 → 压缩历史部分（保留最新 2 轮 + observations 不压缩）
  // 80% 阈值触发（约 800K 字符窗口），未超阈零行为变化；熔断器 3 次失败自动放弃
  let historyForLlm = input.history.slice(-10);
  const histChars = estimateContextChars(historyForLlm);
  if (histChars >= 640_000) {
    const compressed = compressContext(input.userContent ?? "", historyForLlm);
    if (compressed.compressedCount > 0 && compressed.outputChars < compressed.inputChars) {
      historyForLlm = compressed.compressed;
    }
  }
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), input.settings.llmTimeoutMs);
  const url = `${input.settings.llmBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: input.settings.llmModel,
    messages: [
      {
        role: "system",
        content: [
          "You are an intelligent MCP tool-calling agent for SAG.",
          "Return JSON only. Choose either call_tool or final.",
          "",
          "Before calling any tool, silently analyze the user's question:",
          "1. Identify the actual information need, not just the literal wording.",
          "2. Extract key entities, concepts, aliases, time ranges, document names, and constraints.",
          "3. Rewrite the user's question into a concise SAG search query that preserves the user's language.",
          "4. Prefer the rewritten search query over the raw user message when calling sag_search.",
          "5. If the question asks for comparison, cause/effect, architecture, process, evidence, or details from project documents, call sag_search first.",
          "6. If the user asks about a specific event id, call sag_get_event.",
          "7. The MCP server is already bound to the current project through startup configuration; never pass sourceId, sourceIds, projectId, or projectIds in tool arguments.",
          "",
          "When calling sag_search:",
          "- Set strategy to multi unless the user explicitly asks for pure vector retrieval.",
          "- Omit searchMode unless the user explicitly asks for fast or standard retrieval; the configured default search mode will apply.",
          "- Set returnTrace to true.",
          "- Use a clear query field that reflects your analysis of the user's intent.",
          "- Do not invent project ids, source ids, eventIds, or facts.",
          "",
          "After observing SAG results, answer from retrieved evidence. If the retrieved evidence is insufficient, say so and optionally perform one more refined sag_search.",
          "When citation_sources are provided, cite important claims with [1], [2], [3] style markers that match citation_sources.index.",
          "Do not invent citation numbers. Do not cite a source that does not support the sentence.",
          "Schema: {\"action\":\"call_tool\",\"toolName\":\"string\",\"arguments\":{}} or {\"action\":\"final\",\"final\":\"string\"}."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          user_message: input.userContent,
          session: {
            id: input.session.id,
            projectId: input.session.sourceIds[0] ?? null
          },
          recent_messages: historyForLlm,
          available_tools: input.tools,
          observations: input.observations,
          citation_sources: collectCitationSourcesFromObservations(input.observations)
        })
      }
    ],
    response_format: { type: "json_object" },
    temperature: 0.1
  };
  const log = createModelCallLogger({
    kind: "llm",
    operation: "mcp.planToolAction",
    request: {
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body
    }
  });
  let logged = false;
  // G2: 重试/退避 — 429 限流(退避加倍)/5xx/超时/网络错误重试, 4xx 业务错误不重试
  const maxRetries = 2;
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        assertNotAborted(input.signal);
        const response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${input.settings.llmApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        const { responseText, responseBody } = await readResponseBody(response);
        if (!response.ok) {
          const error = new Error(`LLM 规划请求失败：${response.status} ${responseText.slice(0, 500)}`);
          log.fail(error, {
            status: response.status,
            body: responseBody
          });
          logged = true;
          // G2: 可重试错误 → 退避后重试; 4xx 业务错误 → 直接抛
          const cls = classifyLlmError(error, response.status);
          if (cls.retryable && attempt < maxRetries) {
            const waitMs = cls.errorType === "rate_limit" ? retryBackoffMs(attempt + 1) * 2 : retryBackoffMs(attempt + 1);
            console.log(`[mcp-agent] G2 planToolAction ${cls.errorType} 重试 ${attempt + 1}/${maxRetries} in ${waitMs}ms`);
            await sleep(waitMs);
            continue;
          }
          throw error;
        }
        const json = responseBody as { choices?: Array<{ message?: { content?: string } }> };
        const content = json.choices?.[0]?.message?.content ?? "{}";
        const parsed = JSON.parse(content);
        const action = normalizeToolAction(parsed);
        log.succeed({
          status: response.status,
          body: responseBody,
          parsed
        });
        logged = true;
        return action;
      } catch (error) {
        if (input.signal?.aborted) {
          throw new McpRunAbortedError();
        }
        if (!logged) {
          log.fail(error);
        }
        // G2: fetch 层网络/超时错误 → 退避重试（AbortSignal 超时中止除外）
        const cls = classifyLlmError(error);
        if (cls.retryable && attempt < maxRetries) {
          const waitMs = retryBackoffMs(attempt + 1);
          console.log(`[mcp-agent] G2 planToolAction ${cls.errorType} 重试 ${attempt + 1}/${maxRetries} in ${waitMs}ms: ${String(error instanceof Error ? error.message : error).slice(0, 80)}`);
          await sleep(waitMs);
          continue;
        }
        throw error;
      }
    }
  } finally {
    // 超时/父 abort 监听在循环外统一清理（重试期间保持超时保护）
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromParent);
  }
  throw new Error("LLM 规划请求重试耗尽");
}

function parseJsonOrText(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readResponseBody(response: Response): Promise<{ responseText: string; responseBody: unknown }> {
  const maybeText = (response as Response & { text?: () => Promise<string> }).text;
  if (typeof maybeText === "function") {
    const responseText = await maybeText.call(response);
    return {
      responseText,
      responseBody: parseJsonOrText(responseText)
    };
  }
  const responseBody = await (response as Response & { json: () => Promise<unknown> }).json();
  return {
    responseText: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
    responseBody
  };
}

function normalizeToolAction(raw: unknown): ToolAction {
  const record = raw as Record<string, unknown>;
  if (record.action === "call_tool") {
    return {
      action: "call_tool",
      toolName: record.toolName == null ? undefined : String(record.toolName),
      arguments: isRecord(record.arguments) ? record.arguments : {}
    };
  }
  return {
    action: "final",
    final: record.final == null ? "工具调用完成。" : String(record.final)
  };
}

function collectAnswerCitations(toolCalls: McpToolCallRecord[]): AnswerCitation[] {
  const citations: AnswerCitation[] = [];
  const seenChunkIds = new Set<string>();
  for (const toolCall of toolCalls) {
    if (toolCall.toolName !== "sag_search" || toolCall.status !== "SUCCEEDED") {
      continue;
    }
    const result = parseToolJsonResult(toolCall.result);
    const query = typeof toolCall.arguments.query === "string" ? toolCall.arguments.query : undefined;
    for (const section of extractCitationSections(result)) {
      if (seenChunkIds.has(section.chunkId)) {
        continue;
      }
      seenChunkIds.add(section.chunkId);
      citations.push({
        index: citations.length + 1,
        ...section,
        query,
        toolCallId: toolCall.id
      });
      if (citations.length >= 5) {
        return citations;
      }
    }
  }
  return citations;
}

function collectCitationSourcesFromObservations(
  observations: Array<{ toolName: string; result: unknown; error?: string | null }>
) {
  const citations: AnswerCitation[] = [];
  const seenChunkIds = new Set<string>();
  for (const observation of observations) {
    if (observation.toolName !== "sag_search" || observation.error) {
      continue;
    }
    for (const section of extractCitationSections(parseToolJsonResult(observation.result))) {
      if (seenChunkIds.has(section.chunkId)) {
        continue;
      }
      seenChunkIds.add(section.chunkId);
      citations.push({
        index: citations.length + 1,
        ...section,
        content: previewForPrompt(section.content)
      });
      if (citations.length >= 5) {
        return citations;
      }
    }
  }
  return citations;
}

function extractCitationSections(result: unknown): Array<Omit<AnswerCitation, "index" | "query" | "toolCallId">> {
  if (!isRecord(result) || !Array.isArray(result.sections)) {
    return [];
  }
  const sections: Array<Omit<AnswerCitation, "index" | "query" | "toolCallId">> = [];
  for (const section of result.sections) {
    if (!isRecord(section)) {
      continue;
    }
    const chunkId = typeof section.chunkId === "string" ? section.chunkId : "";
    const sourceId = typeof section.sourceId === "string" ? section.sourceId : "";
    const content = typeof section.content === "string" ? section.content.trim() : "";
    if (!chunkId || !sourceId || !content) {
      continue;
    }
    sections.push({
      chunkId,
      sourceId,
      documentId: typeof section.documentId === "string" ? section.documentId : undefined,
      heading: typeof section.heading === "string" ? section.heading : undefined,
      content,
      rank: typeof section.rank === "number" ? section.rank : undefined,
      score: typeof section.score === "number" ? section.score : undefined
    });
  }
  return sections;
}

function parseToolJsonResult(result: unknown): unknown {
  const text = extractToolText(result);
  if (!text) {
    return result;
  }
  try {
    return JSON.parse(text);
  } catch {
    return result;
  }
}

function previewForPrompt(content: string): string {
  return content.length > 1200 ? `${content.slice(0, 1200)}...` : content;
}

function resolveMcpServerCommand(): { command: string; args: string[]; cwd: string } {
  const cwd = path.resolve(process.env.SAG_ROOT || process.cwd());
  const command = process.env.SAG_MCP_SERVER_COMMAND;
  if (command) {
    return {
      command,
      args: process.env.SAG_MCP_SERVER_ARGS ? JSON.parse(process.env.SAG_MCP_SERVER_ARGS) as string[] : [],
      cwd
    };
  }
  if (shouldUseDistServer(cwd)) {
    return {
      command: process.execPath,
      args: [path.join(cwd, "dist", "src", "mcp", "server.js")],
      cwd
    };
  }
  return {
    command: process.execPath,
    args: ["--import", "tsx", path.join(cwd, "src", "mcp", "server.ts")],
    cwd
  };
}

function shouldUseDistServer(cwd: string): boolean {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return process.env.NODE_ENV === "production" || entry.startsWith(path.join(cwd, "dist"));
}

function childEnv(projectId: string): Record<string, string> {
  // W5: env 裁剪 — 只保留系统运行必需变量, 过滤密钥/凭据类(防子进程窃取宿主密钥)
  const ALLOW_PREFIX = ["SAG_", "LLM_", "DEEPSEEK_", "DS_", "OPENAI_", "ANTHROPIC_", "NODE_", "PATH", "HOME", "TEMP", "TMP", "LANG", "LC_", "PG", "DATABASE_", "JWT_"];
  const DENY_KEYS = ["AWS_ACCESS_KEY", "AWS_SECRET", "AZURE_", "GCP_", "GITHUB_TOKEN", "GH_TOKEN", "GOOGLE_API_KEY"];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (DENY_KEYS.some((d) => key.startsWith(d))) continue;  // 显式拒绝高危密钥
    const allowed = ALLOW_PREFIX.some((p) => key === p || key.startsWith(p));
    if (!allowed) continue;  // 默认拒绝(白名单模式)
    env[key] = value;
  }
  env.SAG_LOG_STDERR = "true";
  env.SAG_MCP_SOURCE_ID = projectId;
  return env;
}

function chunkText(content: string, size: number): string[] {
  if (content.length <= size) return [content];
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += size) {
    chunks.push(content.slice(index, index + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSearchProgress(message: string | undefined): SearchProgressEvent | null {
  if (!message) {
    return null;
  }
  try {
    const parsed = JSON.parse(message) as { kind?: unknown; event?: unknown };
    if (parsed.kind !== "sag_search_progress" || !isRecord(parsed.event)) {
      return null;
    }
    const event = parsed.event;
    if (
      event.type !== "step" ||
      typeof event.key !== "string" ||
      typeof event.title !== "string" ||
      typeof event.detail !== "string" ||
      (event.status !== "running" && event.status !== "done" && event.status !== "failed")
    ) {
      return null;
    }
    return {
      type: "step",
      key: event.key,
      title: event.title,
      detail: event.detail,
      status: event.status,
      payload: event.payload,
      durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined
    };
  } catch {
    return null;
  }
}

function parseModelCallLogProgress(message: string | undefined): ModelCallLogRecord | null {
  if (!message) {
    return null;
  }
  try {
    const parsed = JSON.parse(message) as { kind?: unknown; log?: unknown };
    if (parsed.kind !== "sag_model_call_log" || !isRecord(parsed.log)) {
      return null;
    }
    const log = parsed.log;
    if (
      typeof log.sequence !== "number" ||
      typeof log.id !== "string" ||
      (log.kind !== "llm" && log.kind !== "embedding") ||
      typeof log.operation !== "string" ||
      (log.status !== "SUCCEEDED" && log.status !== "FAILED") ||
      typeof log.createdAt !== "string" ||
      typeof log.durationMs !== "number"
    ) {
      return null;
    }
    return {
      sequence: log.sequence,
      id: log.id,
      kind: log.kind,
      operation: log.operation,
      status: log.status,
      createdAt: log.createdAt,
      durationMs: log.durationMs,
      request: log.request,
      response: log.response,
      error: typeof log.error === "string" ? log.error : undefined
    };
  } catch {
    return null;
  }
}

function extractToolText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return "";
  }
  return value.content
    .map((item) => isRecord(item) && item.type === "text" ? String(item.text ?? "") : "")
    .filter(Boolean)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const mcpAgentService = new McpAgentService();
