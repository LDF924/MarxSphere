// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// llm-common.ts — 统一 LLM 调用工具（从 inference-service 提取公用，供其他服务复用）
// fetchLlm: 带真实 token 采集的 fetch；getLlmEndpoint: 端点选择（DeepSeek 原生优先，DashScope 兜底）
// G11: 全局 LLM 并发信号量 — 简单令牌计数, 最大 8 路并发(AGENT_LLM_CONCURRENCY 覆盖), 超出排队等待
// G4: fallback 模型链 — 主模型失败换备用（见 callLlm 包装）
import { resolveModelAlias } from "../services/llm-model-registry.js";
import { getModelFallbacks } from "../services/agent-model-router.js";

// ═══ G11: LLM 并发信号量（令牌计数）═══
// 架构E1: 动态并发 — 按最近平均延迟自适应（快→提并发, 慢→降; 防止限流）
const LLM_MAX_CONCURRENT = Math.max(1, parseInt(process.env.AGENT_LLM_CONCURRENCY || process.env.LLM_CONCURRENCY || "8", 10));
let llmActive = 0;
const llmWaiters: Array<() => void> = [];
// 架构E1: 延迟采样（最近 10 次, 滑动窗口）
const latencySamples: number[] = [];
const LATENCY_WINDOW = 10;
const LATENCY_HIGH_MS = 15000;    // 平均延迟高于此 → 降并发
const LATENCY_LOW_MS = 4000;      // 平均延迟低于此 → 提并发
const ADAPT_STEP = 1;
let adaptiveCap = LLM_MAX_CONCURRENT;

function recordLatency(ms: number): void {
  latencySamples.push(ms);
  if (latencySamples.length > LATENCY_WINDOW) latencySamples.shift();
  if (latencySamples.length >= 5) {
    const avg = latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length;
    if (avg > LATENCY_HIGH_MS && adaptiveCap > 1) {
      adaptiveCap = Math.max(1, adaptiveCap - ADAPT_STEP);
      console.log(`[llm-common] 架构E1 延迟高(${Math.round(avg)}ms) → 并发降至 ${adaptiveCap}`);
    } else if (avg < LATENCY_LOW_MS && adaptiveCap < LLM_MAX_CONCURRENT) {
      adaptiveCap = Math.min(LLM_MAX_CONCURRENT, adaptiveCap + ADAPT_STEP);
    }
    latencySamples.length = 0;  // 重置窗口, 下一周期再采样
  }
}

async function acquireLlmSlot(): Promise<() => void> {
  if (llmActive < adaptiveCap) {
    llmActive++;
    return () => { llmActive--; };
  }
  await new Promise<void>((resolve) => llmWaiters.push(resolve));
  llmActive++;
  return () => { llmActive--; };
}

function releaseLlmSlot(): void {
  llmActive = Math.max(0, llmActive - 1);
  const next = llmWaiters.shift();
  if (next) {
    llmActive++;  // 接替者立即占用槽位
    next();
  }
}

/** G11: 当前并发数（运维/测试用）— 架构E1: 含自适应上限 */
export function llmConcurrencyStats(): { active: number; waiting: number; max: number; adaptiveCap: number } {
  return { active: llmActive, waiting: llmWaiters.length, max: LLM_MAX_CONCURRENT, adaptiveCap };
}

/** 统一 LLM fetch — 从响应 usage 采真实 token，返回 { text, tokens, cacheHit }
 *  模型中立（2026-08-27 ScienceX 理念）: 自动识别 Anthropic 原生格式（URL 含 /messages）
 *  vs OpenAI 兼容格式（/chat/completions）— 两者请求/响应结构不同 */
export async function fetchLlm(input: {
  url: string;
  key: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<{ text: string; tokens: { in: number; out: number } | null; cacheHit: number | null } | null> {
  try {
    const isAnthropic = input.url.includes("/messages") && !input.url.includes("/chat/completions");
    const headers: Record<string, string> = isAnthropic
      ? { 'x-api-key': input.key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
      : { 'Authorization': 'Bearer ' + input.key, 'Content-Type': 'application/json' };
    const body = isAnthropic
      ? {
          model: input.model,
          messages: input.messages,   // Anthropic: [{role:'user'|'assistant', content}]
          temperature: input.temperature ?? 0.3,
          ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
        }
      : {
          model: input.model,
          messages: input.messages,
          temperature: input.temperature ?? 0.3,
          ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
          // 关键坑（P0 记忆）: deepseek-v4-flash 默认 thinking 消耗全部输出配额 → content 为空
          // 所有结构化输出调用必须禁用 thinking，否则 finish_reason=length 且 content=""
          thinking: { type: "disabled" },
        };
    const resp = await fetch(input.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: (AbortSignal as any).timeout(input.timeoutMs ?? 180_000),
    }).catch(() => null);
    if (!resp || !resp.ok) return null;
    const j = await resp.json();
    // Anthropic 响应: {content:[{type:'text',text}], usage:{input_tokens, output_tokens}}
    const text = isAnthropic
      ? (Array.isArray(j?.content) ? j.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('') : '')
      : (j?.choices?.[0]?.message?.content || '');
    const u = j?.usage;
    const tokens = (u && typeof (isAnthropic ? u.input_tokens : u.prompt_tokens) === 'number')
      ? { in: isAnthropic ? u.input_tokens : u.prompt_tokens, out: isAnthropic ? u.output_tokens : (u.completion_tokens ?? 0) }
      : null;
    const cacheHit = (u && typeof u.prompt_cache_hit_tokens === 'number') ? u.prompt_cache_hit_tokens : null;
    return { text, tokens, cacheHit };
  } catch { return null; }
}

/** 取 LLM 端点配置（DeepSeek 原生优先，MAAS/DashScope 兼容兜底） */
export function getLlmEndpoint(overrides?: { model?: string }): { url: string; key: string; model: string } {
  const ds = process.env.DEEPSEEK_API_KEY || '';
  const key = ds || (process.env.LLM_API_KEY || '');
  const url = ds
    ? (process.env.DS_BASE_URL || 'https://api.deepseek.com/v1/chat/completions')
    : (process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1') + '/chat/completions';
  const model = resolveModelAlias(overrides?.model
    ?? (ds ? 'deepseek-v4-flash' : (process.env.LLM_MODEL || 'qwen-plus')));
  return { url, key, model };
}

/** 解析 LLM 返回中的 JSON（剥 code fence） */
export function parseLlmJson(text: string): any {
  const cleaned = text.replace(/^```(?:json)?\s*\n?|```\s*$/g, "").trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

/** 架构E2: 流式响应读取 — SSE 逐块解析, 回调 onStream(delta) / onReasoning(reasoning), 返回聚合 text */
async function readStreamingResponse(
  resp: Response,
  onStream: (delta: string) => void,
  onReasoning?: (reasoning: string) => void
): Promise<string> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 按行解析 SSE: data: {...}
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";  // 保留最后不完整行
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const delta = j?.choices?.[0]?.delta?.content || "";
          if (delta) {
            fullText += delta;
            onStream(delta);
          }
          // V398: DeepSeek 思考链（reasoning_content）— AI 对话页「已深度思考」折叠区
          const reasoning = j?.choices?.[0]?.delta?.reasoning_content || "";
          if (reasoning && onReasoning) {
            onReasoning(reasoning);
          }
        } catch { /* 非 JSON 块跳过 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return fullText;
}

// ═══════ V381: 统一 LLM 调用入口（12 处散点收敛于此）═══════

export interface CallLlmOptions {
  url?: string;            // 默认 getLlmEndpoint().url
  key?: string;            // 默认 getLlmEndpoint().key
  model?: string;          // 默认 getLlmEndpoint().model
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  thinking?: "disabled" | "enabled";   // 默认 disabled（防 deepseek-v4-flash 空 content 坑）
  /** V399: 思考强度（DeepSeek reasoning_effort: low/medium/high/max）— 控制思考链充分程度 */
  reasoningEffort?: "low" | "medium" | "high" | "max";
  jsonMode?: boolean;                  // response_format = json_object
  /** V396-14: Agent 场景标记 — 自动采集 usage 入 exec_logs（规划/reflect/replan/工具全链路 token 审计） */
  agentContext?: { taskId?: string; action: string; tool?: string };
  /** 架构E2: 流式返回 — 每收到一个增量块回调; 最终仍返回完整 text */
  onStream?: (delta: string) => void;
  /** V398: 流式思考链回调（DeepSeek reasoning_content）— AI 对话页「已深度思考」折叠区 */
  onReasoning?: (reasoning: string) => void;
  /** V389: Quota Rotation 总 deadline(ms, 默认 180s) — 整个 fallback 链的最长耗时 */
  totalTimeoutMs?: number;
}

export interface CallLlmResult {
  text: string;
  tokens: { in: number; out: number } | null;
  cacheHit: number | null;
  /** JSON 解析结果（jsonMode 时自动解析，失败返回 null） */
  json?: any;
  /** G1: 失败原因（重试耗尽/不可重试错误），成功时为空。调用方不再静默吞错 */
  error?: string;
  /** G1: 错误分类（429/5xx/timeout/network/other），便于调用方区分处理 */
  errorType?: "rate_limit" | "server_error" | "timeout" | "network" | "auth" | "other";
  /** V389: HTTP 状态码(失败时附上, 供 Quota Rotation 判定) */
  status?: number;
}

/**
 * G1: 错误分类 — 429 退避重试、5xx/超时重试、业务错误不重试
 * 返回 { retryable, errorType }
 */
export function classifyLlmError(err: unknown, status?: number): { retryable: boolean; errorType: CallLlmResult["errorType"] } {
  const msg = err instanceof Error ? err.message : String(err);
  if (typeof status === "number") {
    if (status === 429) return { retryable: true, errorType: "rate_limit" };
    if (status >= 500) return { retryable: true, errorType: "server_error" };
    if (status === 401 || status === 403) return { retryable: false, errorType: "auth" };
    if (status === 400) return { retryable: false, errorType: "other" };
  }
  if (/timeout|aborted/i.test(msg)) return { retryable: true, errorType: "timeout" };
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket|network|网络/i.test(msg)) return { retryable: true, errorType: "network" };
  return { retryable: false, errorType: "other" };
}

/** G1: 指数退避等待（第 n 次重试: base*2^(n-1) ms, 上限 30s） */
export function retryBackoffMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, Math.max(0, attempt - 1)), 30_000);
}

/**
 * 统一 LLM 调用：headers/超时/thinking 默认/usage 采集/JSON 解析全在此
 * G1: 加重试(2次)/指数退避/错误分类(429 退避、5xx 重试、超时重试)，失败原因返回给调用方(不静默 null)
 * G11: 全局并发信号量包装 — 最大 8 路并发(AGENT_LLM_CONCURRENCY), 超出排队等待
 * 12 个散点（inference/agent-task/truth/sidecar-guard/mcp-agent/search 等）收敛入口
 * 用法: const r = await callLlm({ messages: [...], jsonMode: true, model: getRoleModel("plan") })
 */
export async function callLlm(input: CallLlmOptions): Promise<CallLlmResult | null> {
  const release = await acquireLlmSlot();  // G11: 获取并发槽位（超出上限排队）
  const startedAt = Date.now();
  try {
    // G4: fallback 模型链 — 主模型重试耗尽后, 依次换备用模型（相同槽位内串行）
    const fallbacks = (input.model ? getModelFallbacks(input.model) : []).filter((m) => m !== input.model);
    if (fallbacks.length > 0) {
      const first = await callLlmInner(input);
      if (first && !first.error) {
        recordLatency(Date.now() - startedAt);  // 架构E1: 延迟采样
        return first;
      }
      // 主模型失败 → 逐个尝试备用模型
      for (const fb of fallbacks) {
        const attemptInput = { ...input, model: fb };
        const r = await callLlmInner(attemptInput);
        if (r && !r.error) {
          console.log(`[llm-common] G4 fallback 成功: ${input.model} → ${fb}（主模型: ${first?.error?.slice(0, 60) || "失败"}）`);
          recordLatency(Date.now() - startedAt);  // 架构E1
          return r;
        }
      }
      // 全部失败 → 返回主模型错误信息（含 fallback 尝试记录）
      return { text: "", tokens: null, cacheHit: null, error: `模型 ${input.model} 及备用 ${fallbacks.join("/")} 均失败: ${first?.error || "未知"}`, errorType: first?.errorType || "other" };
    }
    const result = await callLlmInner(input);
    recordLatency(Date.now() - startedAt);  // 架构E1: 延迟采样（成功/失败都采样）
    return result;
  } finally {
    releaseLlmSlot();
  }
}

// ═══ V389: Quota Rotation(借鉴 TraitTutor gateway/quota_rotation.py) ═══
// per-model 路由熔断: 连续失败 ≥ MODEL_CIRCUIT_FAILURES(3) 次 → OPEN 60s(期间跳过该模型)
// 与全局 breakers 区分: 这里按具体模型名(deepseek-v4-flash/qwen3.7-max...)独立熔断, 失败不拖累其他路由
const MODEL_CIRCUIT_FAILURES = Math.max(1, parseInt(process.env.LLM_MODEL_CIRCUIT_FAILURES || "3", 10));
const MODEL_CIRCUIT_COOLDOWN_MS = Math.max(5_000, parseInt(process.env.LLM_MODEL_CIRCUIT_COOLDOWN_MS || "60000", 10));
const modelCircuitState = new Map<string, { failures: number; openedAt: number }>();

function modelCircuitIsOpen(model: string): boolean {
  const st = modelCircuitState.get(model);
  if (!st || st.openedAt === 0) return false;
  if (Date.now() - st.openedAt >= MODEL_CIRCUIT_COOLDOWN_MS) {
    // 冷却已过 → HALF_OPEN 放行一次试探(失败则重新计时)
    modelCircuitState.set(model, { failures: 1, openedAt: 0 });  // 试探中: 复位失败计数, 若失败立即再开
    return false;
  }
  return true;
}
function modelCircuitRecordFailure(model: string): void {
  const st = modelCircuitState.get(model) || { failures: 0, openedAt: 0 };
  st.failures += 1;
  if (st.failures >= MODEL_CIRCUIT_FAILURES && st.openedAt === 0) {
    st.openedAt = Date.now();
    console.warn(`[llm-common] V389 路由熔断 OPEN: ${model} (连续失败 ${st.failures} 次, 冷却 ${MODEL_CIRCUIT_COOLDOWN_MS / 1000}s)`);
  }
  modelCircuitState.set(model, st);
}
function modelCircuitRecordSuccess(model: string): void {
  const st = modelCircuitState.get(model);
  if (st) modelCircuitState.set(model, { failures: 0, openedAt: st.openedAt });  // 保留 OPEN 计时, 清零失败
}

/** 路由熔断状态(前端/诊断用) */
export function modelCircuitStats(): Record<string, { failures: number; open: boolean; openedAt: number }> {
  const out: Record<string, { failures: number; open: boolean; openedAt: number }> = {};
  for (const [model, st] of modelCircuitState) {
    out[model] = { failures: st.failures, open: modelCircuitIsOpen(model), openedAt: st.openedAt };
  }
  return out;
}

/**
 * V389: 带 Quota Rotation 的 LLM 调用
 * 对照 TraitTutor quota_rotation.py:
 *   1. 总 deadline: 整个 fallback 链在 totalTimeoutMs(默认 180s) 内完成, 超时抛真实错误
 *   2. 路由熔断: per-model 连续失败 ≥3 次 → 跳过该模型(60s 冷却), 失败不拖累其他路由
 *   3. 配额/认证错误(429/401/403) → 立即轮换不回退; timeout/5xx → 同路由重试后轮换
 *   4. 全部失败 → 返回含各路由错误摘要的真实错误(不静默)
 */
export async function callLlmWithRotation(input: CallLlmOptions): Promise<CallLlmResult | null> {
  const startedAt = Date.now();
  const totalTimeoutMs = input.totalTimeoutMs ?? 180_000;
  const model = input.model ?? getLlmEndpoint().model;
  const fallbacks = [model, ...getModelFallbacks(model).filter((m) => m !== model)];

  let errors: Array<{ model: string; error: string }> = [];
  for (const candidate of fallbacks) {
    if (Date.now() - startedAt >= totalTimeoutMs) break;  // 总 deadline
    if (modelCircuitIsOpen(candidate)) {
      console.log(`[llm-common] V389 跳过熔断路由: ${candidate}`);
      continue;
    }
    const remaining = Math.max(5_000, totalTimeoutMs - (Date.now() - startedAt));
    const r = await callLlmInner({ ...input, model: candidate, timeoutMs: Math.min(input.timeoutMs ?? 180_000, remaining) });
    if (r && !r.error) {
      modelCircuitRecordSuccess(candidate);
      recordLatency(Date.now() - startedAt);
      return r;
    }
    if (r?.error) {
      modelCircuitRecordFailure(candidate);
      errors.push({ model: candidate, error: r.error.slice(0, 120) });
      const cls = classifyLlmError(r.error, r.status);
      // 配额/认证错误 → 立即轮换(不回退等待)
      if (cls.errorType === "rate_limit" || cls.errorType === "auth") continue;
      // 业务错误(4xx 非重试) → 不再尝试其他路由
      if (!cls.retryable && cls.errorType === "other") break;
      // timeout/5xx/网络 → 同路由重试后轮换(callLlmInner 内部已重试)
    }
    recordLatency(Date.now() - startedAt);
  }
  return {
    text: "", tokens: null, cacheHit: null,
    error: `模型链 ${fallbacks.join(" → ")} 全部失败: ${errors.map((e) => `${e.model}: ${e.error}`).join("; ") || "未知"}`,
    errorType: "other",
  };
}

/** 实际 LLM 调用（信号量内部执行体） */
async function callLlmInner(input: CallLlmOptions): Promise<CallLlmResult | null> {
  const ep = getLlmEndpoint(input.model ? { model: input.model } : undefined);
  const url = input.url ?? ep.url;
  const key = input.key ?? ep.key;
  const model = input.model ?? ep.model;
  // G1: 最大重试次数（默认 2 次: 初始 + 2 次重试）— LLM_MAX_RETRIES 环境变量覆盖
  const maxRetries = Math.max(0, parseInt(process.env.LLM_MAX_RETRIES || "2", 10));
  const body: Record<string, unknown> = {
    model,
    messages: input.messages,
    temperature: input.temperature ?? 0.3,
    ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
  };
  // 关键坑（P0 记忆）: deepseek-v4-flash 默认 thinking 消耗全部输出配额 → content 为空
  // 结构化输出必须禁用 thinking；仅需要长思考推理时开启
  if (input.thinking !== "enabled") body.thinking = { type: "disabled" };
  // V399: 思考强度（DeepSeek reasoning_effort）— low/medium/high/max
  if (input.reasoningEffort) {
    body.reasoning_effort = input.reasoningEffort === "medium" ? "high" : input.reasoningEffort;
  }
  if (input.jsonMode) body.response_format = { type: "json_object" };
  if (input.onStream) body.stream = true;  // 架构E2: 流式请求标记

  let lastError = "";
  let lastErrorType: CallLlmResult["errorType"] = "other";
  let lastStatus: number | undefined;
  const baseTimeout = input.timeoutMs ?? 180_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: (AbortSignal as any).timeout(baseTimeout),
      }).catch(() => null);
      if (!resp) {
        lastError = "网络请求失败(fetch 返回 null)";
        lastErrorType = "network";
        // 重试前等待
      } else if (!resp.ok) {
        const status = resp.status;
        lastStatus = status;
        const detail = (await resp.text().catch(() => "")).slice(0, 200);
        lastError = `HTTP ${status}${detail ? ": " + detail : ""}`;
        const cls = classifyLlmError(lastError, status);
        lastErrorType = cls.errorType;
        if (!cls.retryable) break;  // 4xx 业务错误 → 立即失败, 不重试
      } else {
        // 架构E2: 流式模式 — SSE 逐块回调（onStream）, 聚合成完整 text
        if (input.onStream) {
          const text = await readStreamingResponse(resp, input.onStream, input.onReasoning);
          const result: CallLlmResult = { text, tokens: null, cacheHit: null };
          if (input.jsonMode) result.json = parseLlmJson(text);
          return result;
        }
        const j = await resp.json();
        const text = j?.choices?.[0]?.message?.content || "";
        const u = j?.usage;
        const tokens = (u && typeof u.prompt_tokens === "number")
          ? { in: u.prompt_tokens ?? 0, out: u.completion_tokens ?? 0 }
          : null;
        const cacheHit = (u && typeof u.prompt_cache_hit_tokens === "number") ? u.prompt_cache_hit_tokens : null;
        // V396-14: Agent 场景 usage 采集 — 规划/reflect/replan/工具全链路 token 审计入 exec_logs
        if (input.agentContext && tokens) {
          try {
            const { logAgentExec } = await import("../services/agent-exec-log.js");
            const costCents = Math.round((tokens.in * 0.5 + tokens.out * 2) / 10000);
            await logAgentExec({
              taskId: input.agentContext.taskId,
              action: input.agentContext.action,
              tool: input.agentContext.tool,
              inputSummary: `model=${model} tokens_in=${tokens.in} tokens_out=${tokens.out}${cacheHit ? ` cache_hit=${cacheHit}` : ""}`,
              outputSummary: `cost=${costCents}分(真实用量)`,
              tokensIn: tokens.in, tokensOut: tokens.out, costCents,
              status: "ok", spanType: "LLM",
            });
          } catch { /* usage 采集失败不阻塞 */ }
        }
        const result: CallLlmResult = { text, tokens, cacheHit };
        if (input.jsonMode) result.json = parseLlmJson(text);
        return result;
      }
      // 重试退避（429 退避加倍 — 限流需更长时间冷却）
      if (attempt < maxRetries) {
        const waitMs = lastErrorType === "rate_limit"
          ? retryBackoffMs(attempt + 1) * 2
          : retryBackoffMs(attempt + 1);
        if (attempt === 0 && maxRetries > 0) {
          console.log(`[llm-common] G1 ${lastErrorType} 重试 ${attempt + 1}/${maxRetries} in ${waitMs}ms: ${lastError.slice(0, 80)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    } catch (e: any) {
      lastError = String(e?.message || e).slice(0, 200);
      const cls = classifyLlmError(e);
      lastErrorType = cls.errorType;
      if (!cls.retryable) break;  // 业务错误 → 立即失败
      if (attempt < maxRetries) {
        const waitMs = retryBackoffMs(attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  // G1: 失败原因返回给调用方（不静默 null）— 保留结构化错误供上层决策
  return { text: "", tokens: null, cacheHit: null, error: lastError || "未知错误", errorType: lastErrorType, status: lastStatus };
}
