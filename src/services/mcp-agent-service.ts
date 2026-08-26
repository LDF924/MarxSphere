// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
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
  deleteMcpMessage,
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
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_start"; toolName: string; arguments: Record<string, unknown> }
  | { type: "search_progress"; event: SearchProgressEvent }
  | { type: "tool_end"; toolCall: McpToolCallRecord }
  | { type: "model"; model: string }
  | { type: "done"; detail: Awaited<ReturnType<typeof getMcpSessionDetail>> }
  | { type: "error"; message: string };

type StreamEmitter = (event: McpRunStreamEvent) => void;

export class McpAgentService {
  /** V399: 对话工具审批队列 — key=approvalId, value={tool,args,resolvers}；waitToolApproval 挂起，approve/deny 唤醒 */
  private pendingApprovals = new Map<string, {
    toolName: string;
    args: Record<string, unknown>;
    sessionId: string;
    createdAt: number;
    resolve: (approved: boolean) => void;
    timeout: NodeJS.Timeout;
  }>();

  /** V399: 审批决定（对话内 review 工具 → 前端弹窗 → 批准后强制执行） */
  async approveToolCall(approvalId: string, approved: boolean): Promise<boolean> {
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    this.pendingApprovals.delete(approvalId);
    entry.resolve(approved);
    return true;
  }

  /** V399: 审批事件广播回调（server 端注入，转 SSE tool_approval） */
  emitApproval?: (event: { type: "tool_approval"; approvalId: string; sessionId: string; toolName: string; arguments: Record<string, unknown> }) => void;

  /** V399: 等待审批决定（60s 超时 → 视为拒绝） */
  private waitToolApproval(sessionId: string, toolName: string, args: Record<string, unknown>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const approvalId = crypto.randomUUID();
      const entry = {
        toolName,
        args,
        sessionId,
        createdAt: Date.now(),
        resolve,
        timeout: setTimeout(() => {
          this.pendingApprovals.delete(approvalId);
          resolve(false);
        }, 60_000)
      };
      this.pendingApprovals.set(approvalId, entry);
      this.emitApproval?.({
        type: "tool_approval",
        approvalId,
        sessionId,
        toolName,
        arguments: args
      });
    });
  }

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

  /** V398: 撤回单条消息（AI 对话页回复前撤回；连带工具调用删除） */
  async deleteMessage(sessionId: string, messageId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const deleted = await deleteMcpMessage({ sessionId, messageId, tenantId });
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
    /** V399: 深度模式 — 轮次上限 20（质量优先），前端「深度思考」开关 */
    deepMode?: boolean;
    /** V399: 思考强度三档（low/high/max）— DeepSeek reasoning_effort */
    reasoningEffort?: "low" | "high" | "max";
    /** V399: 文档附件（PDF/Office/文本，attachment_read 解析） */
    docs?: McpMessageImage[];
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
    /** V399: 思考链（最终回答的 reasoning_content，随 assistant 消息落库） */
    let chatReasoningText = "";
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
        const flowResult = await this.runChatLlmFlow({
          session: activeSession,
          messageId: userMessage.id,
          history: detail.messages,
          settings,
          userContent: input.content,
          images: input.images,
          webSearch: input.webSearch,
          deepMode: input.deepMode,
          reasoningEffort: input.reasoningEffort,
          docs: input.docs,
          toolCalls,
          signal: input.signal,
          emit
        });
        // V399: 思考链随 assistant 消息落库（metadata.reasoning 供历史消息折叠展示）
        chatReasoningText = flowResult.reasoning;
        assistantText = flowResult.text;
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
      metadata: {
        ...(answerCitations.length > 0 ? { citations: answerCitations } : {}),
        // V399: 思考链落库（历史消息折叠展示）
        ...(chatReasoningText.length > 0 ? { reasoning: chatReasoningText } : {})
      }
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
   * V398/V399: 通用 AI 对话流（kind=chat，无项目绑定）— Agent 工具循环：
   * 图片/联网注入 → LLM 规划选工具 → 执行（审批拦截）→ 结果入上下文 → 循环
   * 直到 LLM 判定完成 → 流式最终回答。全程 tool_start/tool_end 事件供前端时间线。
   */
  private async runChatLlmFlow(input: {
    session: McpSessionRecord;
    messageId: string;
    history: NonNullable<Awaited<ReturnType<typeof getMcpSessionDetail>>>["messages"];
    settings: AiRuntimeSettings;
    userContent: string;
    images?: McpMessageImage[];
    webSearch?: boolean;
    deepMode?: boolean;
    reasoningEffort?: "low" | "high" | "max";
    docs?: McpMessageImage[];
    toolCalls: McpToolCallRecord[];
    signal?: AbortSignal;
    emit?: StreamEmitter;
  }): Promise<{ text: string; reasoning: string }> {
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

    // ①.5 V399: 文档附件 → attachment_read 解析注入（PDF/Office/文本）
    for (const doc of input.docs ?? []) {
      assertNotAborted(input.signal);
      const started = performance.now();
      input.emit?.({ type: "tool_start", toolName: "attachment_read", arguments: { path: doc.path } });
      const { buildAgentTools, executeAgentTool } = await import("./agent-tool-router.js");
      const tools = await buildAgentTools();
      const toolDef = tools.find((t) => t.name === "attachment_read");
      let resultText = "（附件解析失败）";
      if (toolDef) {
        const exec = await executeAgentTool(toolDef, { path: doc.path, maxChars: 8000 }, { role: "analyst" });
        resultText = exec.ok ? exec.result : exec.result;
      }
      const toolCall = await addMcpToolCall({
        sessionId: input.session.id,
        messageId: input.messageId,
        toolName: "attachment_read",
        arguments: { path: doc.path },
        result: { text: resultText.slice(0, 3000) },
        status: "SUCCEEDED",
        durationMs: Math.round(performance.now() - started)
      });
      input.toolCalls.push(toolCall);
      input.emit?.({ type: "tool_end", toolCall });
      contextParts.push(`[附件 ${doc.name}] ${resultText.slice(0, 8000)}`);
    }

    // ② 联网开关 → web_search 结果注入
    if (input.webSearch) {
      assertNotAborted(input.signal);
      const { buildAgentTools, executeAgentTool } = await import("./agent-tool-router.js");
      const started = performance.now();
      input.emit?.({ type: "tool_start", toolName: "web_search", arguments: { query: input.userContent.slice(0, 80), source: "general", maxResults: 5 } });
      let resultText = "（联网搜索失败）";
      let failed = false;
      try {
        const tools = await buildAgentTools();
        const toolDef = tools.find((t) => t.name === "web_search");
        if (!toolDef) {
          resultText = "（web_search 工具不可用）";
          failed = true;
        } else {
          const toolResult = await executeAgentTool(toolDef, {
            query: input.userContent.slice(0, 80),
            source: "general",
            maxResults: 5
          });
          resultText = toolResult.ok ? toolResult.result : `（联网搜索被拦截: ${toolResult.result.slice(0, 120)}）`;
          if (!toolResult.ok) failed = true;
        }
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

    // ③ V399: Agent 工具循环 — LLM 规划选工具 → 执行 → 结果入上下文 → 循环
    const { callLlm } = await import("../ai/llm-common.js");
    const { buildAgentTools, executeAgentTool, checkToolPolicy, maskCredentials } = await import("./agent-tool-router.js");
    const { getRoleModel } = await import("./llm-model-registry.js");
    const model = input.session.model || getRoleModel("reason") || input.settings.llmModel;
    input.emit?.({ type: "model", model });

    // V405: 对话历史接入分层压缩 — 按字符预算动态截取（对齐 1M 窗口 800K 字符估算），
    // 超阈值(80% = 640K)触发 compressContext 压缩历史部分（保留最新 2 轮）；未超阈零行为变化
    const { compressContext, compactByBudget, DEFAULT_COMPACTION_BUDGET, estimateContextChars } = await import("./context-compressor.js");
    const MAX_HIST_CHARS = 640_000; // 1M 窗口 80% 阈值（约 4 字符/token）
    // 历史消息统一为 {role: string; content: string} 形态（与压缩器签名一致）
    let recentTurns: Array<{ role: string; content: string }> = input.history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));
    const histChars = estimateContextChars(recentTurns);
    if (histChars >= MAX_HIST_CHARS) {
      const compressed = compressContext("", recentTurns);
      if (compressed.compressedCount > 0 && compressed.outputChars < compressed.inputChars) {
        // 压缩后仍超预算 → 角色预算强截断兜底（保证永不超限）
        const fallback = compactByBudget(compressed.compressed, { ...DEFAULT_COMPACTION_BUDGET, budgetChars: MAX_HIST_CHARS });
        recentTurns = fallback.compressed;
      } else {
        const fallback = compactByBudget(recentTurns, { ...DEFAULT_COMPACTION_BUDGET, budgetChars: MAX_HIST_CHARS });
        recentTurns = fallback.compressed;
      }
    }

    const allTools = await buildAgentTools();
    const toolList = allTools.map((t) => {
      const params = Object.entries(t.params)
        .map(([k, v]) => `${k}${v.required ? "(必填)" : ""}:${v.type} — ${v.desc}`)
        .join("; ");
      return `- ${t.name}(${t.risk}): ${t.description} | 参数: ${params || "无"}`;
    }).join("\n");

    const planningSystem = [
      "你是 MarxSphere 的 Agent 工具调度器。根据用户任务，从工具清单中选择最合适的工具执行。",
      "规则：",
      "1. 每次只调用一个工具，观察结果后决定下一步。",
      "2. 需要检索文献/知识库 → sag_search / sag_retrieve / concept_trace；",
      "   需要深度推理 → sag_reason；需要联网 → web_search；需要实证分析 → empirical_analysis；",
      "   需要读取附件 → attachment_read；需要图片分析 → image_analyze；其他按描述选择。",
      "3. **质量优先原则（严禁偷懒）**：",
      "   - 涉及论文/文献/学术综述类任务：必须先调 view_literature_search（文献库 500+ 同行评议论文），",
      "     再调 sag_search（知识库）交叉验证，不得因知识库更快而跳过文献库；",
      "   - 涉及政策/法规 → 必须先调 policy_search 或 view_policy_tree；",
      "   - 涉及概念溯源/跨文献关联 → concept_trace 或 view_truth_list；",
      "   - 多步骤任务不要一步收尾：检索 → 推理/实证 → 写作/总结，每阶段用对应工具；",
      "   - 不要怕步骤多、耗时长，结果最优优先。",
      "4. 工具执行完成后，判断任务是否解决：解决 → 返回 {\"done\":true}；否则继续调用下一步工具。",
      "5. 最多 12 轮工具调用（深度模式 20 轮），超限必须收尾。",
      "6. risk=review 或需 manager 的工具需要用户审批，若被拦截说明原因并换工具。",
      "只返回 JSON: {\"tool\":\"工具名\",\"args\":{...}} 或 {\"done\":true}。参数必须具体，不要用占位符。",
      `工具清单:\n${toolList}`
    ].join("\n");

    // V399: 深度模式 — 轮次上限提高（质量优先，不怕耗时长）
    const MAX_TOOL_ROUNDS = input.deepMode ? 20 : 12;
    let finalText = "";
    /** V399: 连续工具名记录（防同工具重复调用死循环） */
    const recentToolNames: string[] = [];
    /** V399: 已调用过的工具+参数组合（同 query 去重） */
    const seenToolCalls = new Set<string>();
    /** V399: 已加载的技能集（防同一 skill 重复注入上下文） */
    let planReasoning = "";
    const loadedSkills = new Set<string>();
    // V399: /命令 → @skill: 语法解析 — 用户输入 @skill:技能名 任务 时预加载技能指令
    let skillInjectedContext = "";
    const skillMatch = input.userContent.match(/@skill:([\w.-]+(?:\/[\w.-]+)?)\s*([\s\S]*)/);
    if (skillMatch) {
      const { getSkillDetail } = await import("./skills-service.js");
      const detail = getSkillDetail(skillMatch[1]);
      if (detail) {
        loadedSkills.add(skillMatch[1]);
        const fs = await import("node:fs");
        const path = await import("node:path");
        const os = await import("node:os");
        const skillDir = path.dirname(detail.skillMdPath ?? path.join(os.homedir(), ".claude", "skills", skillMatch[1], "SKILL.md"));
        const parts: string[] = [`【技能 ${detail.name} 完整指令】\n${String(detail.skillMd ?? "")}`];
        const refDir = path.join(skillDir, "references");
        if (fs.existsSync(refDir)) {
          const refs = fs.readdirSync(refDir).filter((f) => f.endsWith(".md")).slice(0, 3);
          for (const ref of refs) {
            try {
              parts.push(`\n【方法库 ${ref}】\n${fs.readFileSync(path.join(refDir, ref), "utf8").slice(0, 6000)}`);
            } catch { /* 忽略 */ }
          }
        }
        const scriptsDir = path.join(skillDir, "scripts");
        const scripts = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir) : [];
        if (scripts.length > 0) parts.push(`\n【可执行脚本】${scripts.join(", ")}（用 run_code/run_command 执行）`);
        skillInjectedContext = parts.join("\n\n").slice(0, 16000);
        input.emit?.({ type: "stage", label: `技能加载: ${detail.name}`, detail: "已注入技能完整指令" });
      } else {
        skillInjectedContext = `（技能 ${skillMatch[1]} 不存在，可用 view_skill_search 检索）`;
      }
    }
    // V399: /命令 → @tool: 语法解析 — 用户可指定必须使用的工具（如 @tool:policy_search 查政策）
    let forcedTool: string | null = null;
    const toolMatch = input.userContent.match(/@tool:([\w_]+)\s*([\s\S]*)/);
    if (toolMatch) {
      forcedTool = toolMatch[1];
      input.emit?.({ type: "stage", label: `指定工具: ${forcedTool}`, detail: "将强制使用该工具执行" });
    }
    // @skill 语法剥离后作为实际任务（不带技能指令前缀）
    const actualTask = skillMatch ? skillMatch[2].trim() || input.userContent
      : toolMatch ? toolMatch[2].trim() || input.userContent
      : input.userContent;
    // 强制工具注入：规划时告知 LLM 必须使用指定工具
    const forcedToolHint = forcedTool ? `注意：用户指定必须使用工具「${forcedTool}」执行此任务，不要跳过或换用其他工具。` : "";
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      assertNotAborted(input.signal);
      input.emit?.({ type: "stage", label: `工具规划 ${round + 1}`, detail: "正在决定下一步工具调用" });

      // 3a. LLM 规划（非流式 JSON）
      const plan = await callLlm({
        model,
        agentContext: { action: "chat_tool_plan" },
        messages: [
          { role: "system", content: planningSystem },
          ...recentTurns.slice(-4),
          {
            role: "user",
            content: [
              `用户任务: ${actualTask}`,
              ...(contextParts.length > 0 ? [`已收集上下文:\n${contextParts.join("\n\n").slice(0, 6000)}`] : ["（尚无工具结果）"]),
              // V399: 技能指令注入（/命令 → @skill: 语法预加载）
              skillInjectedContext ? `\n${skillInjectedContext}` : "",
              // V399: 强制工具提示（@tool: 语法）
              forcedToolHint || "",
              // V399: 技能执行约束 — 已加载技能的代码模板需用 run_code/runtime_exec 落地执行
              loadedSkills.size > 0
                ? `注意：已加载技能「${[...loadedSkills].join("、")}」的完整指令。若技能含代码模板且用户要求执行分析，下一步必须调用 run_code 或 runtime_exec 执行代码（不要重复加载同一技能）。`
                : ""
            ].filter(Boolean).join("\n\n")
          }
        ],
        // V399: 规划决策 maxTokens 也拉满（思考充分性）+ 思考强度 max
        maxTokens: 131_072,
        jsonMode: true,
        temperature: 0.1,
        reasoningEffort: input.reasoningEffort ?? "high",
        // V399: 采集规划阶段思考 — 工具链面板显示「决策理由」
        onReasoning: (reasoning) => {
          planReasoning += reasoning;
        }
      });
      // 每轮决策思考（截断展示，作为工具链决策理由）
      if (planReasoning.trim().length > 0) {
        input.emit?.({ type: "stage", label: `决策思考`, detail: planReasoning.trim().slice(0, 300) });
      }
      if (plan?.error) {
        return { text: `（工具规划失败: ${plan.error.slice(0, 200)}）`, reasoning: "" };
      }
      let decision: { tool?: string; args?: Record<string, unknown>; done?: boolean } = {};
      try {
        decision = JSON.parse((plan?.text ?? "").trim().replace(/```json|```/g, ""));
      } catch {
        // 解析失败 → 收尾（不阻塞回答）
      }

      if (decision.done || !decision.tool) {
        break;
      }

      // 3b. 找工具定义
      const toolDef = allTools.find((t) => t.name === decision.tool);
      if (!toolDef) {
        contextParts.push(`[工具 ${decision.tool} 不存在，忽略]`);
        continue;
      }

      // V399: view_skill_run 执行后记录已加载技能（防重复注入）
      if (toolDef.name === "view_skill_run" && typeof decision.args?.skill === "string") {
        loadedSkills.add(decision.args.skill);
      }

      // V399: 重复工具调用保护 — 同一工具连续选择 ≥3 次（结果已入上下文）→ 提醒换工具，防规划死循环
      if (recentToolNames.length >= 2 && recentToolNames.slice(-2).every((n) => n === toolDef.name)) {
        contextParts.push(`[提示: 工具 ${toolDef.name} 已连续调用 3 次，结果已在上下文中。请换用其他工具推进任务，或直接收尾回答]`);
        recentToolNames.push(toolDef.name);
        continue;
      }
      // V399: 完全相同的工具+参数调用去重（结果已在上下文）→ 直接跳过，防同 query 反复重试
      const callKey = `${toolDef.name}:${JSON.stringify(decision.args ?? {})}`;
      if (seenToolCalls.has(callKey)) {
        contextParts.push(`[提示: 工具 ${toolDef.name} 已用相同参数调用过，结果已在上下文中。请换用其他工具或收尾]`);
        recentToolNames.push(toolDef.name);
        continue;
      }
      seenToolCalls.add(callKey);
      recentToolNames.push(toolDef.name);

      // 3c. 策略检查（对话内 analyst 角色 — 允许 llm_write/summarize 等分析写作工具，
      // 仅 run_code/file_write 等 manager 级工具触发审批弹窗）
      const policy = checkToolPolicy(toolDef.name, "analyst");
      if (!policy.allowed) {
        contextParts.push(`[工具 ${toolDef.name} 被策略拦截: ${policy.reason}]`);
        continue;
      }

      // 3d. 执行（review/manager 工具 → SSE 审批弹窗 → 批准后强制执行）
      assertNotAborted(input.signal);
      const started = performance.now();
      input.emit?.({ type: "tool_start", toolName: toolDef.name, arguments: decision.args ?? {} });
      let resultText = "（执行失败）";
      let failed = false;
      let needsApproval = false;
      try {
        // reader 角色 → run_code/file_write 等 manager 级工具返回 requiresApproval → 审批弹窗
        const exec = await executeAgentTool(toolDef, decision.args ?? {}, { role: "analyst" });
        if (exec.requiresApproval) {
          needsApproval = true;
          // V399: 审批弹窗 — 前端批准后强制执行（绕过策略层，直调工具 run）
          const approved = await this.waitToolApproval(input.session.id, toolDef.name, decision.args ?? {});
          if (approved) {
            const safeArgs = Object.fromEntries(
              Object.entries(decision.args ?? {}).map(([k, v]) => [/key|token|secret|password|auth/i.test(k) ? maskCredentials(String(v)) : v].map((vv) => [k, vv])[0])
            );
            resultText = await toolDef.run(safeArgs);
            needsApproval = false;
          } else {
            resultText = `工具 ${toolDef.name} 审批超时/拒绝，已跳过`;
          }
        } else if (!exec.ok) {
          failed = true;
          resultText = exec.result;
        } else {
          resultText = exec.result;
        }
      } catch (e: any) {
        failed = true;
        resultText = `（工具异常: ${String(e?.message || e).slice(0, 200)}）`;
      }
      const toolCall = await addMcpToolCall({
        sessionId: input.session.id,
        messageId: input.messageId,
        toolName: toolDef.name,
        arguments: decision.args ?? {},
        result: { text: resultText.slice(0, 3000) },
        status: needsApproval ? "FAILED" : failed ? "FAILED" : "SUCCEEDED",
        durationMs: Math.round(performance.now() - started),
        error: failed || needsApproval ? resultText.slice(0, 300) : undefined
      });
      input.toolCalls.push(toolCall);
      input.emit?.({ type: "tool_end", toolCall });
      contextParts.push(`[工具 ${toolDef.name} 结果]\n${resultText.slice(0, 2000)}`);
    }

    // ④ 最终回答（流式，含思考链）
    assertNotAborted(input.signal);
    const systemPrompt = [
      "你是 MarxSphere AI 助手，一名马克思主义理论研究科研助手。",
      "能力说明：你可以调用系统工具获取实时信息——文献库检索、知识库检索、SAG 推理、",
      "政策库、知识图谱、联网搜索（web_search）、实证分析、技能执行等。",
      "涉及最新信息/外部资料时使用联网搜索，不要声称无法访问互联网。",
      "根据用户任务和工具执行结果，给出完整、结构化的最终回答。",
      "回答使用 Markdown：代码块用 ```lang 标注，数学公式用 $...$ 或 $$...$$。",
      "引用工具结果时标注来源（如 [检索结果]、[推理结论]、[政策库]）。",
      "若工具结果不足，诚实说明并建议使用 Ask 检索或 52 步推理。"
    ].join("\n");

    const finalMessages = [
      { role: "system", content: systemPrompt },
      ...recentTurns.slice(-6),
      {
        role: "user",
        content: [
          `用户任务: ${actualTask}`,
          ...(skillInjectedContext ? [`\n技能指令（必须遵循）:\n${skillInjectedContext.slice(0, 6000)}`] : []),
          ...(contextParts.length > 0 ? [`\n\n工具执行记录:\n${contextParts.join("\n\n").slice(0, 12000)}`] : [])
        ].join("")
      }
    ];

    // V405: 发送前总字符硬校验 — 组装后若仍超 1M 窗口 80% 阈值，
    // 对历史消息按角色预算强截断兜底（保证永不触达 token 超限错误）
    if (estimateContextChars(finalMessages as any) >= 640_000) {
      const { compactByBudget, DEFAULT_COMPACTION_BUDGET } = await import("./context-compressor.js");
      const trimmed = compactByBudget(finalMessages.slice(0, -1), { ...DEFAULT_COMPACTION_BUDGET, budgetChars: 400_000 });
      finalMessages.splice(0, finalMessages.length - 1, ...trimmed.compressed as any);
    }

    // V399: 采集思考链（落库到 assistant 消息 metadata，历史消息可折叠查看）
    let reasoningText = "";
    const result = await callLlm({
      model,
      agentContext: { action: "chat_final" },
      messages: finalMessages as any,
      // V399: maxTokens 拉到 DeepSeek 上限 131072（模型上下文 100 万，输出可达 128K）
      maxTokens: 131_072,
      thinking: "enabled",
      // V399: 思考强度由前端三档控制
      reasoningEffort: input.reasoningEffort ?? "high",
      onStream: (delta) => {
        input.emit?.({ type: "assistant_delta", delta });
      },
      onReasoning: (reasoning) => {
        reasoningText += reasoning;
        input.emit?.({ type: "reasoning_delta", delta: reasoning });
      }
    });

    assertNotAborted(input.signal);
    if (result?.error) {
      return { text: `（模型调用失败: ${result.error.slice(0, 300)}）`, reasoning: "" };
    }
    finalText = result?.text ?? "";
    // 思考链由 runUserMessage 落库到 assistant 消息 metadata（此处不再提前写库）
    return { text: finalText, reasoning: reasoningText.slice(0, 4000) };
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
  // V380/V405: 对话历史接入分层压缩 — 按字符预算动态截取（保留最新若干轮直至预算上限），
  // 超阈值(80% = 640K)触发 compressContext 压缩历史部分（保留最新 2 轮 + observations 不压缩）；
  // 压缩后仍超 → compactByBudget 角色预算强截断兜底（保证永不超 1M 窗口）
  const { compressContext, compactByBudget, DEFAULT_COMPACTION_BUDGET, estimateContextChars } = await import("./context-compressor.js");
  const MAX_HIST_CHARS = 640_000; // 1M 窗口 80% 阈值（约 4 字符/token）
  let historyForLlm = input.history.slice(-10);
  const histChars = estimateContextChars(historyForLlm);
  if (histChars >= MAX_HIST_CHARS) {
    const compressed = compressContext(input.userContent ?? "", historyForLlm);
    if (compressed.compressedCount > 0 && compressed.outputChars < compressed.inputChars) {
      historyForLlm = compressed.compressed;
    }
    // 压缩后仍超预算 → 角色预算强截断（兜底防线）
    const stillOver = estimateContextChars(historyForLlm);
    if (stillOver >= MAX_HIST_CHARS) {
      const fallback = compactByBudget(historyForLlm, { ...DEFAULT_COMPACTION_BUDGET, budgetChars: MAX_HIST_CHARS });
      historyForLlm = fallback.compressed;
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
