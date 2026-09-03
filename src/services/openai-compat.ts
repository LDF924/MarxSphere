// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// openai-compat.ts — OpenAI 兼容端点(外部客户端把本地知识库当"模型"调用)
// 引入背景: Zleap-AI/SAG 评审(2026-09-01) — 上游演进能力回溯吸收 P0
//   POST /api/openai/chat/completions (+ /api/openai/v1/chat/completions 别名)
//   流程: OpenAI 消息 → 最后 user 消息为查询 → SAG 检索 → 基于证据带引用生成
//   响应: 标准 chat.completion + 顶层 sag.citations(标准客户端忽略未知字段)
//   流式: OpenAI SSE 格式(data: {...} 块 + data: [DONE])
// 复用: searchService.search(检索) / callLlmWithRotation(生成, 信号量/重试/熔断/配额轮换)
//       aiSettingsService(远程 LLM 探测) / quotaService.recordUsage(记账)
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { callLlmWithRotation, classifyLlmError } from "../ai/llm-common.js";
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import { aiSettingsService } from "./ai-settings-service.js";
import { getRoleModel } from "./llm-model-registry.js";
import { quotaService } from "./quota-service.js";
import { searchService } from "./search-service.js";
import type { SearchSection } from "../types.js";

// ─── zod schema(与 server.ts 顶部 schema 风格一致; 默认 strip 未知字段)───
export const openaiChatCompletionsSchema = z.object({
  model: z.string().max(100).optional(),
  messages: z
    .array(
      z.object({
        // 放宽到 tool 角色(多轮 agent 客户端会带), 提取逻辑只认 user
        role: z.enum(["system", "user", "assistant", "tool"]),
        // 兼容多模态客户端 content:[{type:"text",text:...}] 形态
        content: z
          .union([
            z.string(),
            z.array(z.object({ type: z.string().optional(), text: z.string().optional() })),
          ])
          .optional(),
      }),
    )
    .min(1),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(64000).optional(),
  maxTokens: z.number().int().positive().optional(), // 兼容别名
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
});

// ─── 错误类(handler 内捕获, 显式转 OpenAI 格式, 不走 setErrorHandler)───
export class OpenAiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public type: "invalid_request_error" | "server_error" | "rate_limit_error" = "invalid_request_error",
    public code?: string,
  ) {
    super(message);
    this.name = "OpenAiError";
  }
}

// ─── 引用结构(与 composeAnswer 的 {index,title} 兼容, 扩展溯源字段)───
export interface SagCitation {
  index: number;
  title: string;
  sourceId: string;
  chunkId: string;
  heading?: string;
  score?: number;
}

export interface OpenAiChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop";
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  sag: { citations: SagCitation[]; traceId?: string; query?: string };
}

// ═══ 纯函数(全部可单测)═══

/** 取 messages 中最后一条 user 消息为查询; content 为数组时拼接所有 {text} 项 */
export function extractLastUserMessage(
  messages: Array<{ role: string; content?: unknown }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return content.trim() || null;
    if (Array.isArray(content)) {
      const parts = content
        .filter((c): c is { text?: string } => typeof c === "object" && c !== null)
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .filter(Boolean);
      const joined = parts.join("").trim();
      if (joined) return joined;
    }
    return null;
  }
  return null;
}

/** 证据 prompt: system 逐字复用 composeAnswer(llm-client.ts:205-209), user 复用 [n] 编号拼法 */
export function buildEvidencePrompt(
  query: string,
  evidence: Array<{ title: string; content: string; heading?: string }>,
  maxSections = 8,
  maxCharsPerSection = 800,
): { system: string; user: string } {
  const system =
    "你是一位马克思主义理论研究助手。基于提供的证据片段，回答用户的研究问题。要求：\n" +
    "1. 只使用证据中的事实，不编造\n" +
    "2. 关键论断后用 [n] 标注对应证据编号\n" +
    "3. 用中文回答，结构清晰\n" +
    "4. 若证据不足，明确说明";
  const evidenceText = evidence
    .slice(0, maxSections)
    .map(
      (e, index) =>
        `[${index + 1}] ${e.title}\n${(e.content || "").slice(0, maxCharsPerSection)}`,
    )
    .join("\n\n");
  return { system, user: `问题：${query}\n\n证据片段：\n${evidenceText}` };
}

/** sections(按 rank) → 完整引用数组(index 从 1, 与 prompt 证据编号一一对应) */
export function mapSectionsToCitations(
  sections: SearchSection[],
  titleMap: Map<string, string>,
): SagCitation[] {
  return sections.map((section, index) => ({
    index: index + 1,
    title: titleMap.get(section.sourceId) ?? section.sourceId,
    sourceId: section.sourceId,
    chunkId: section.chunkId,
    ...(section.heading ? { heading: section.heading } : {}),
    ...(typeof section.score === "number" ? { score: section.score } : {}),
  }));
}

/** OpenAI SSE 块: `data: {json}\n\n` 单行(标准客户端只读 choices[0].delta) */
export function formatChatChunk(chunk: {
  id: string;
  created: number;
  model: string;
  delta: { role?: string; content?: string };
  finishReason?: string | null;
  extra?: Record<string, unknown>;
}): string {
  const payload: Record<string, unknown> = {
    id: chunk.id,
    object: "chat.completion.chunk",
    created: chunk.created,
    model: chunk.model,
    choices: [
      {
        index: 0,
        delta: chunk.delta,
        finish_reason: chunk.finishReason ?? null,
      },
    ],
    ...chunk.extra,
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 字符数 → token 估算(与 /api/ai/execute 估算口径一致: chars/4) */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

// ═══ 编排入口 ═══

interface RunInput {
  model?: string;
  messages: Array<{ role: string; content?: unknown }>;
  temperature?: number;
  maxTokens?: number;
  stream: boolean;
  onDelta?: (delta: string) => void;
  onFinal?: (extra: Record<string, unknown>) => void;
  tokenCtx?: { tokenId: string };
}

/** 取全部可访问 sources(id + name 一次查询), 复用 assertSourcesAccessible 的租户可见性逻辑 */
async function resolveAllSources(): Promise<{ ids: string[]; titleMap: Map<string, string> }> {
  const tenantId = config.DEFAULT_TENANT_ID;
  const accessibleTenants =
    tenantId === "00000000-0000-0000-0000-000000000001" || tenantId === "default"
      ? ["default", "00000000-0000-0000-0000-000000000001"]
      : [tenantId];
  const result = await pool.query(
    "select id, name from sources where tenant_id = any($1::text[]) and archived_at is null order by id",
    [accessibleTenants],
  );
  const ids = result.rows.map((row) => String(row.id));
  const titleMap = new Map<string, string>();
  for (const row of result.rows) titleMap.set(String(row.id), String(row.name ?? ""));
  return { ids, titleMap };
}

function buildCompletion(
  input: RunInput,
  text: string,
  citations: SagCitation[],
  traceId: string | undefined,
  query: string,
  tokens: { in: number; out: number } | null,
): OpenAiChatCompletion {
  const id = "chatcmpl-" + randomUUID().slice(0, 16);
  const created = Math.floor(Date.now() / 1000);
  const model = input.model || getRoleModel("reason");
  const promptTokens = tokens?.in ?? estimateTokens(0);
  const completionTokens = tokens?.out ?? estimateTokens(text.length);
  const completion: OpenAiChatCompletion = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    sag: { citations, ...(traceId ? { traceId } : {}), ...(query ? { query } : {}) },
  };
  if (input.stream) {
    input.onFinal?.({
      sag: completion.sag,
      usage: completion.usage,
    });
  }
  return completion;
}

export async function runOpenAiChatCompletion(input: RunInput): Promise<OpenAiChatCompletion> {
  // 1. 取最后 user 消息为查询
  const query = extractLastUserMessage(input.messages);
  if (!query) {
    throw new OpenAiError("messages 中缺少 user 消息", 400, "invalid_request_error", "no_user_message");
  }

  // 2. 无 sourceIds → 全部可访问 sources
  const { ids, titleMap } = await resolveAllSources();

  // 3. SAG 检索(检索链 LLM token 落 trace, 不入本端点记账)
  const result = await searchService.search(
    { query, sourceIds: ids, topK: 20 },
    config.DEFAULT_TENANT_ID,
  );

  // 4. citations 与 prompt 证据一一对应(取前 8, 保证 [n] 编号对上)
  const citations = mapSectionsToCitations(result.sections.slice(0, 8), titleMap);

  // 5. 0 结果短路: 不烧 LLM 配额, 固定"证据不足"回答
  if (result.sections.length === 0) {
    const text = "未在知识库中找到与问题直接相关的证据片段，无法给出有依据的回答。";
    const tokens = { in: 0, out: estimateTokens(text.length) };
    if (input.tokenCtx) {
      quotaService.recordUsage(input.tokenCtx.tokenId, "reason", {
        tokensInput: tokens.in,
        tokensOutput: tokens.out,
      });
    }
    return buildCompletion(input, text, [], result.traceId, query, tokens);
  }

  // 6. 无远程 LLM 兜底(与 composeAnswer llm-client.ts:211-216 行为一致)
  const settings = await aiSettingsService.getRuntimeSettings();
  if (!settings.hasRemoteLlm) {
    const evidence = result.sections
      .slice(0, 8)
      .map((s) => ({ title: titleMap.get(s.sourceId) ?? s.sourceId, content: s.content, heading: s.heading }));
    const text =
      `基于 ${citations.length} 条证据片段的初步回答：\n\n` +
      `${buildEvidencePrompt(query, evidence).user.slice(0, 500)}\n\n（本地模式无远程 LLM，以上为证据摘要）`;
    const tokens = { in: 0, out: estimateTokens(text.length) };
    if (input.tokenCtx) {
      quotaService.recordUsage(input.tokenCtx.tokenId, "reason", {
        tokensInput: tokens.in,
        tokensOutput: tokens.out,
      });
    }
    return buildCompletion(input, text, citations, result.traceId, query, tokens);
  }

  // 7. 生成(信号量/重试/熔断/fallback 链/配额轮换/流式回调全在 callLlmWithRotation)
  const evidence = result.sections.slice(0, 8).map((s) => ({
    title: titleMap.get(s.sourceId) ?? s.sourceId,
    content: s.content,
    heading: s.heading,
  }));
  const { system, user } = buildEvidencePrompt(query, evidence);
  const llmResult = await callLlmWithRotation({
    model: getRoleModel("reason"),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    onStream: input.stream ? (delta) => input.onDelta?.(delta) : undefined,
  });
  if (!llmResult || llmResult.error || !llmResult.text) {
    const cls = classifyLlmError(llmResult?.error ?? "未知错误", llmResult?.status);
    throw new OpenAiError(
      llmResult?.error ?? "LLM 生成失败",
      502,
      "server_error",
      "UPSTREAM_LLM_ERROR",
    );
  }

  // 8. 配额记账: reason kind 记 LLM 真实 tokens(流式 tokens 为 null → 估算)
  if (input.tokenCtx) {
    const tokens = llmResult.tokens ?? {
      in: estimateTokens(system.length + user.length),
      out: estimateTokens(llmResult.text.length),
    };
    quotaService.recordUsage(input.tokenCtx.tokenId, "reason", {
      tokensInput: tokens.in,
      tokensOutput: tokens.out,
    });
  }

  // 9. 组装响应(stream 模式经 onFinal 回调 extra, 非 stream 返回完整 JSON)
  return buildCompletion(input, llmResult.text, citations, result.traceId, query, llmResult.tokens ?? null);
}
