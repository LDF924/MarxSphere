// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { aiSettingsService, type AiRuntimeSettings } from "../services/ai-settings-service.js";
import type { ExtractedEntity, ExtractedEvent, EventRecord } from "../types.js";
import { createModelCallLogger } from "../observability/model-call-log.js";
import { breakers } from "../services/circuit-breaker.js";
import { recordLedger } from "../services/cost-ledger-service.js";
import { buildExtractionMessages } from "../ingestion/prompts/build-extraction-messages.js";
import { validateExtractionResponse } from "../ingestion/prompts/extraction-schema.js";
import { isLikelyLanguageDrift, isMostlyChinese } from "../ingestion/prompts/extraction-utils.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface LlmClient {
  /** V381: 最近一次 LLM 调用的 usage（prompt/completion/cacheHit）——search 链真实 token 采集 */
  readonly lastUsage?: { in: number; out: number; cacheHit: number } | null;
  extractNamedEntities(query: string): Promise<string[]>;
  /** G5: 查询改写 + 实体提取(一个调用, 失败降级原查询) */
  rewriteAndExtractEntities(query: string): Promise<{ rewrittenQuery: string; entities: string[] }>;
  extractEventsFromChunk(input: {
    title: string;
    heading?: string;
    content: string;
    references: string[];
    /** G7: 层级模式(默认 false 保持单事件) */
    hierarchical?: boolean;
  }): Promise<ExtractedEvent[]>;
  rerankEvents(input: {
    query: string;
    candidates: EventRecord[];
    topK: number;
  }): Promise<string[]>;
  extractRelations(input: {
    text: string;
    relationTypes: Array<{ id: string; label: string }>;
  }): Promise<Array<{ subject: string; relation: string; relationLabel: string; object: string }>>;
  composeAnswer(input: {
    query: string;
    evidence: Array<{ title: string; content: string; heading?: string }>;
  }): Promise<{ answer: string; citations: Array<{ index: number; title: string }> }>;
}

export class OpenAICompatibleLlmClient implements LlmClient {
  /** V381: 最近一次 LLM 调用 usage（chatJson/chatText 每次调用后更新） */
  private _lastUsage: { in: number; out: number; cacheHit: number } | null = null;
  get lastUsage(): { in: number; out: number; cacheHit: number } | null { return this._lastUsage; }

  /** V381: 从响应 JSON 采集 usage（prompt_cache_hit_tokens 为 DeepSeek 字段）
   * V405(P0 成本账本): 同时落 llm_usage_ledger(真实模型名/调用意图/usage) — 搜索链/对话链每轮可审计 */
  private captureUsage(json: any, model?: string, endpoint = "llm"): void {
    const u = json?.usage;
    if (u && typeof u.prompt_tokens === "number") {
      this._lastUsage = {
        in: u.prompt_tokens ?? 0,
        out: u.completion_tokens ?? 0,
        cacheHit: typeof u.prompt_cache_hit_tokens === "number" ? u.prompt_cache_hit_tokens : 0,
      };
      recordLedger({
        kind: "llm",
        endpoint,
        model: model ?? "unknown",
        tokensIn: this._lastUsage.in,
        tokensOut: this._lastUsage.out,
        tokensCacheRead: this._lastUsage.cacheHit,
      });
    }
  }

  async extractNamedEntities(query: string): Promise<string[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) {
      const log = createModelCallLogger({
        kind: "llm",
        operation: "extractNamedEntities.local",
        request: { query }
      });
      const entities = localNamedEntities(query);
      log.succeed({ named_entities: entities });
      return entities;
    }
    const result = await this.chatJson(settings, {
      system: "Extract named entities important for answering the question. Return JSON only.",
      user: JSON.stringify({
        question: query,
        schema: { named_entities: ["string"] }
      })
    });
    const entities = Array.isArray(result.named_entities) ? result.named_entities : result.entities;
    return Array.isArray(entities) ? entities.map(String).filter(Boolean) : localNamedEntities(query);
  }

  /** G5(对齐 Zleap rewrite_and_extract_entities): 一个 LLM 调用同时产出改写查询 + 搜索实体 */
  async rewriteAndExtractEntities(query: string): Promise<{ rewrittenQuery: string; entities: string[] }> {
    const settings = await aiSettingsService.getRuntimeSettings();
    const maxEntities = 10;
    const fallback = { rewrittenQuery: query, entities: [] as string[] };
    if (!settings.hasRemoteLlm) {
      return fallback; // 无远程 LLM: 不改写(与 Zleap 降级语义一致)
    }
    const log = createModelCallLogger({
      kind: "llm",
      operation: "rewriteAndExtractEntities",
      request: { query }
    });
    try {
      const result = await this.chatJson(settings, {
        system: `你是搜索分析专家。请分析用户问题，改写为清晰、正式且不改变原意的查询，
并只提取问题中明确出现、对检索有帮助的实体。当前 UTC 时间为 ${new Date().toISOString()}。

用户问题：${query}

严格返回 JSON 对象，格式如下：
{"rewritten_query":"...","entities":["...","..."]}
实体去重后最多返回 ${maxEntities} 个。`,
        operation: "rewriteAndExtractEntities"
      });
      const rewrittenQuery = String(result.rewritten_query ?? "").trim();
      const entities = Array.isArray(result.entities)
        ? result.entities.map(String).filter(Boolean).slice(0, maxEntities)
        : [];
      // 结构化校验失败 → 降级原查询(对齐 Zleap 非 strict 语义)
      if (!rewrittenQuery || rewrittenQuery.length < 1) {
        log.fail(new Error("rewritten_query 为空, 降级原查询"));
        return fallback;
      }
      log.succeed({ rewritten_query: rewrittenQuery, entities });
      return { rewrittenQuery, entities };
    } catch (error) {
      log.fail(error instanceof Error ? error : new Error(String(error)));
      return fallback; // 任何失败不改写(检索不因改写中断)
    }
  }

  async extractEventsFromChunk(input: {
    title: string;
    heading?: string;
    content: string;
    references: string[];
    /** G7: 层级模式(默认 false 保持单事件; true 时允许 children) */
    hierarchical?: boolean;
  }): Promise<ExtractedEvent[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) {
      const log = createModelCallLogger({
        kind: "llm",
        operation: "extractEventsFromChunk.local",
        request: input
      });
      const events = [localExtractEvent(input)];
      log.succeed({ events });
      return events;
    }
    const result = await this.chatJson(settings, {
      operation: "extractEventsFromChunk.benchmarkPipeline",
      messages: buildExtractionMessages(input)
    });
    const validation = validateExtractionResponse(result);
    if (!validation.valid) {
      // 契约校验失败: 记日志并回退本地抽取(不加重试, 与语言漂移回退同一路径)
      const log = createModelCallLogger({
        kind: "llm",
        operation: "extractEventsFromChunk.schemaRejected",
        request: { title: input.title }
      });
      log.fail(new Error(`extraction schema rejected: ${validation.reason}`));
      return [localExtractEvent(input)];
    }
    const items = "data" in validation.value ? validation.value.data.items : validation.value.items;
    if (!Array.isArray(items) || items.length === 0) {
      return [localExtractEvent(input)];
    }
    const inputIsChinese = isMostlyChinese(input.content);
    const event = buildSingleExtractedEvent(items, input, inputIsChinese);
    return event ? [event] : [localExtractEvent(input)];
  }

  async extractRelations(input: {
    text: string;
    relationTypes: Array<{ id: string; label: string }>;
  }): Promise<Array<{ subject: string; relation: string; relationLabel: string; object: string }>> {
    const settings = await aiSettingsService.getRuntimeSettings();
    const typeList = input.relationTypes.map((rt) => `- ${rt.id}（${rt.label}）`).join("\n");
    if (!settings.hasRemoteLlm) {
      return [];
    }
    try {
      const result = await this.chatJson(settings, {
        operation: "extractRelations",
        system: "你是马克思主义政治经济学研究助手。从文本中抽取实体关系三元组，仅使用给定的关系类型。返回 JSON，不要输出其他内容。",
        user: JSON.stringify({
          text: input.text.slice(0, 3000),
          relation_types: input.relationTypes,
          output_schema: {
            triples: [
              {
                subject: "主语实体",
                relation: "关系类型 id（必须来自给定的 relation_types）",
                object: "宾语实体"
              }
            ]
          }
        })
      });
      const items = Array.isArray(result.triples) ? result.triples : [];
      return items
        .filter((item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({
          subject: String(item.subject ?? "").trim(),
          relation: String(item.relation ?? "").trim(),
          object: String(item.object ?? "").trim()
        }))
        .filter((item) => item.subject && item.relation && item.object)
        .map((item) => {
          const matched = input.relationTypes.find((rt) => rt.id === item.relation);
          return {
            subject: item.subject,
            relation: item.relation,
            relationLabel: matched?.label ?? item.relation,
            object: item.object
          };
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`LLM 关系抽取失败：${message.slice(0, 200)}`);
    }
  }

  async rerankEvents(input: {
    query: string;
    candidates: EventRecord[];
    topK: number;
    /** G4(对齐 Zleap llm_include_content): 是否把候选 content 给 LLM(默认 true, 保持现状) */
    includeContent?: boolean;
    /** G4(对齐 Zleap llm_max_content_chars): 每条候选 content 最大字符数(默认 1200, 保持现状) */
    maxContentChars?: number;
  }): Promise<string[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) {
      const log = createModelCallLogger({
        kind: "llm",
        operation: "rerankEvents.local",
        request: input
      });
      const ids = localRerank(input.query, input.candidates, input.topK);
      log.succeed({ useful_event_ids: ids });
      return ids;
    }
    const includeContent = input.includeContent ?? true;
    const maxContentChars = input.maxContentChars ?? 1200;
    const result = await this.chatJson(settings, {
      system: `Select exactly ${input.topK} event ids most useful for answering the question. Return JSON only.`,
      user: JSON.stringify({
        question: input.query,
        candidates: input.candidates.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          ...(includeContent ? { content: candidate.content.slice(0, maxContentChars) } : {}),
          score: candidate.score ?? 0
        })),
        output_schema: { useful_event_ids: ["uuid"] }
      })
    });
    const ids = result.useful_event_ids ?? result.event_ids;
    return Array.isArray(ids)
      ? ids.map(String).filter((id) => input.candidates.some((candidate) => candidate.id === id)).slice(0, input.topK)
      : localRerank(input.query, input.candidates, input.topK);
  }

  async composeAnswer(input: {
    query: string;
    evidence: Array<{ title: string; content: string; heading?: string }>;
  }): Promise<{ answer: string; citations: Array<{ index: number; title: string }> }> {
    const settings = await aiSettingsService.getRuntimeSettings();
    const evidence = input.evidence.slice(0, 8);
    const citations: Array<{ index: number; title: string }> = evidence.map((e, index) => ({
      index: index + 1,
      title: e.title || `证据${index + 1}`
    }));

    const evidenceText = evidence.map((e, index) =>
      `[${index + 1}] ${e.title}\n${(e.content || "").slice(0, 800)}`
    ).join("\n\n");

    const system = "你是一位马克思主义理论研究助手。基于提供的证据片段，回答用户的研究问题。要求：\n" +
      "1. 只使用证据中的事实，不编造\n" +
      "2. 关键论断后用 [n] 标注对应证据编号\n" +
      "3. 用中文回答，结构清晰\n" +
      "4. 若证据不足，明确说明";

    if (!settings.hasRemoteLlm) {
      return {
        answer: `基于 ${evidence.length} 条证据片段的初步回答：\n\n${evidenceText.slice(0, 500)}\n\n（本地模式无远程 LLM，以上为证据摘要）`,
        citations
      };
    }

    const answer = await this.chatText(settings, {
      system,
      user: `问题：${input.query}\n\n证据片段：\n${evidenceText}`,
      operation: "composeAnswer"
    });
    return { answer: answer || "（未能生成回答）", citations };
  }

  private async chatJson(settings: AiRuntimeSettings, input: {
    system?: string;
    user?: string;
    messages?: ChatMessage[];
    operation?: string;
  }): Promise<Record<string, any>> {
    const url = `${settings.llmBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const messages = input.messages ?? [
      { role: "system" as const, content: input.system ?? "" },
      { role: "user" as const, content: input.user ?? "" }
    ];
    // Only set json_object if system prompt mentions json (qwen requirement)
    const sysContent = messages.find(m => m.role === 'system')?.content || '';
    const needsJson = sysContent.toLowerCase().includes('json');
    // 2026-08-07 模型注册表覆盖：composeAnswer 等传入 modelOverride 时优先（用户选择）
    const body: any = {
      model: (input as any).modelOverride ?? settings.llmModel,
      messages,
      temperature: 0.1
    };
    if (needsJson) body.response_format = { type: "json_object" };

    let lastError: unknown;
    const maxAttempts = settings.llmMaxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), settings.llmTimeoutMs);
      const log = createModelCallLogger({
        kind: "llm",
        operation: input.operation ?? "chatJson",
        request: {
          url,
          method: "POST",
          attempt,
          maxAttempts,
          headers: {
            "Content-Type": "application/json"
          },
          body
        }
      });
      let logged = false;
      try {
        const response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${settings.llmApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        const { responseText, responseBody } = await readResponseBody(response);
        if (!response.ok) {
          const error = new Error(`llm request failed: ${response.status} ${responseText.slice(0, 500)}`);
          // V348: DeepSeek 429 → 熔断器计数 (连续 20 次/60s 触发全局短路)
          if (response.status === 429) breakers.deepseek429.recordFailure();
          log.fail(error, {
            status: response.status,
            body: responseBody
          });
          logged = true;
          lastError = error;
          if (attempt < maxAttempts && isRetryableHttpStatus(response.status)) {
            await waitBeforeRetry(attempt);
            continue;
          }
          throw error;
        }
        const json = responseBody as { choices?: Array<{ message?: { content?: string } }>; usage?: any };
        const content = json.choices?.[0]?.message?.content ?? "{}";
        // V381: 采集真实 usage（prompt/completion/cacheHit）; V405: 记真实模型
        this.captureUsage(json, (input as any).modelOverride ?? settings.llmModel, input.operation ?? "chatJson");
        // JSON 修复解析：剥离 markdown 围栏/前后噪声，防 LLM 输出不合法导致 token 空耗重试
        const parsed = parseLlmJson(content);
        log.succeed({
          status: response.status,
          body: responseBody,
          parsed
        });
        return parsed;
      } catch (error) {
        lastError = error;
        if (!logged) {
          log.fail(error);
        }
        if (attempt < maxAttempts && isRetryableFetchError(error)) {
          await waitBeforeRetry(attempt);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** 非 JSON 聊天：返回原始文本（用于生成自然语言回答） */
  private async chatText(settings: AiRuntimeSettings, input: {
    system?: string;
    user?: string;
    operation?: string;
  }): Promise<string> {
    const url = `${settings.llmBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const messages: ChatMessage[] = [
      { role: "system", content: input.system ?? "" },
      { role: "user", content: input.user ?? "" }
    ];
    const body: any = {
      model: settings.llmModel,
      messages,
      temperature: 0.3
    };

    let lastError: unknown;
    const maxAttempts = settings.llmMaxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), settings.llmTimeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${settings.llmApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        const { responseText } = await readResponseBody(response);
        if (!response.ok) {
          const error = new Error(`llm request failed: ${response.status} ${responseText.slice(0, 300)}`);
          // V348: DeepSeek 429 → 熔断器计数 (连续 20 次/60s 触发全局短路)
          if (response.status === 429) breakers.deepseek429.recordFailure();
          lastError = error;
          if (attempt < maxAttempts && isRetryableHttpStatus(response.status)) {
            await waitBeforeRetry(attempt);
            continue;
          }
          throw error;
        }
        const json = JSON.parse(responseText) as { choices?: Array<{ message?: { content?: string } }>; usage?: any };
        const content = json.choices?.[0]?.message?.content ?? "";
        // V381: 采集真实 usage（prompt/completion/cacheHit）; V405: 记真实模型
        this.captureUsage(json, settings.llmModel, input.operation ?? "chatText");
        return content.trim();
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts && isRetryableFetchError(error)) {
          await waitBeforeRetry(attempt);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
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

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || error.message.includes("fetch failed");
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(1_000, 100 * 2 ** Math.max(0, attempt - 1));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}


function normalizeEntities(raw: unknown, inputIsChinese: boolean): ExtractedEntity[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      const record = item as Record<string, unknown>;
      const name = String(record.name ?? "").trim();
      const description = String(record.description ?? "").trim();
      return {
        type: normalizeEntityType(String(record.type ?? "subject")),
        name,
        description: normalizeEntityDescription(description, inputIsChinese)
      };
    })
    .filter((entity) => entity.name.length > 1);
}

function collectValidEventItems(items: unknown[]): Array<Record<string, unknown>> {
  const collected: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.is_valid !== false) {
      collected.push(record);
    }
    if (Array.isArray(record.children)) {
      collected.push(...collectValidEventItems(record.children));
    }
  }
  return collected;
}

function buildSingleExtractedEvent(
  items: unknown[],
  input: { title: string; heading?: string; content: string; references: string[] },
  inputIsChinese: boolean
): ExtractedEvent | null {
  const eventItems = collectValidEventItems(items);
  if (eventItems.length === 0) {
    return null;
  }

  const primary = eventItems[0];
  const content = buildConciseEventContent(eventItems, input.content, inputIsChinese);
  if (isLikelyLanguageDrift(content, inputIsChinese)) {
    return null;
  }
  const keywords = uniqueStrings(
    eventItems.flatMap((item) => Array.isArray(item.keywords) ? item.keywords.map(String) : [])
  );
  const entities = uniqueEntities(eventItems.flatMap((item) => normalizeEntities(item.entities, inputIsChinese)));
  const title = normalizeEventText(String(primary.title ?? ""), input.heading ?? input.title, inputIsChinese);
  const summary = normalizeEventText(String(primary.summary ?? ""), title, inputIsChinese);
  const category = normalizeCategory(primary.category, inputIsChinese);

  return {
    title,
    summary,
    content,
    category,
    keywords: keywords.length > 0 ? keywords : localKeywords(input.content),
    references: input.references,
    entities
  };
}

function normalizeEventText(value: string, fallback: string, inputIsChinese: boolean): string {
  const text = value.trim();
  if (!text || isLikelyLanguageDrift(text, inputIsChinese)) {
    return fallback;
  }
  return text;
}

function normalizeCategory(value: unknown, inputIsChinese: boolean): string {
  const fallback = inputIsChinese ? "一般事项" : "general";
  const category = value == null ? "" : String(value).trim();
  const hasChinese = /[\u4e00-\u9fa5]/.test(category);
  if (!category || isLikelyLanguageDrift(category, inputIsChinese) || (inputIsChinese && !hasChinese)) {
    return fallback;
  }
  return category;
}

function normalizeEntityDescription(description: string, inputIsChinese: boolean): string {
  if (!description || isLikelyLanguageDrift(description, inputIsChinese)) {
    return inputIsChinese ? "在当前事项中被提及" : "Mentioned in the current event";
  }
  return description;
}

function buildConciseEventContent(
  eventItems: Array<Record<string, unknown>>,
  fallbackContent: string,
  inputIsChinese: boolean
): string {
  const candidates = uniqueStrings(
    eventItems.flatMap((item) => [
      String(item.summary ?? "").trim(),
      String(item.content ?? "").trim()
    ]).filter(Boolean)
  );
  const raw = candidates.join(inputIsChinese ? "；" : "; ") || fallbackContent.trim();
  return conciseText(raw, inputIsChinese);
}

function conciseText(text: string, inputIsChinese: boolean): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const maxLength = inputIsChinese ? 180 : 360;
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const sentencePattern = inputIsChinese ? /[^。！？；;]+[。！？；;]?/gu : /[^.!?;]+[.!?;]?/g;
  const sentences = cleaned.match(sentencePattern)?.map((item) => item.trim()).filter(Boolean) ?? [cleaned];
  const selected: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    if (selected.length >= 3) {
      break;
    }
    if (length + sentence.length > maxLength && selected.length > 0) {
      break;
    }
    selected.push(sentence);
    length += sentence.length;
  }
  const result = selected.join(inputIsChinese ? "" : " ").trim();
  if (result.length <= maxLength) {
    return result;
  }
  return `${result.slice(0, maxLength - 1).trim()}…`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Set<string>();
  const result: ExtractedEntity[] = [];
  for (const entity of entities) {
    const key = `${entity.type}:${entity.name.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entity);
  }
  return result;
}

function localExtractEvent(input: {
  title: string;
  heading?: string;
  content: string;
  references: string[];
}): ExtractedEvent {
  const zh = isMostlyChinese(input.content);
  const title = cleanTitle(input.heading || firstSentence(input.content) || input.title);
  const keywords = localKeywords(`${title} ${input.content}`);
  const entities = localNamedEntities(`${title} ${input.content}`).slice(0, 12).map((name) => ({
    type: inferEntityType(name),
    name,
    description: zh ? `在事项「${title}」中被提及` : `Mentioned in event: ${title}`
  }));
  return {
    title,
    summary: conciseText(firstSentence(input.content) || title, zh),
    content: conciseText(input.content, zh),
    category: zh ? "一般事项" : "general",
    keywords,
    priority: "UNKNOWN",
    status: "COMPLETED",
    references: input.references,
    entities
  };
}

function localNamedEntities(text: string): string[] {
  const candidates = new Set<string>();
  const titleCaseMatches = text.match(/\b[A-Z][A-Za-z0-9]+(?:[-\s][A-Z][A-Za-z0-9]+){0,4}\b/g) ?? [];
  for (const match of titleCaseMatches) {
    candidates.add(match.trim());
  }
  const quotedMatches = text.match(/["'“”]([^"'“”]{2,80})["'“”]/g) ?? [];
  for (const match of quotedMatches) {
    candidates.add(match.replace(/["'“”]/g, "").trim());
  }
  const cjkMatches = text.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{2,24}(?:公司|集团|大学|模型|系统|产品|项目|技术|平台|算法|数据库|方案)/g) ?? [];
  for (const match of cjkMatches) {
    candidates.add(match.trim());
  }
  return [...candidates].filter((item) => item.length > 1).slice(0, 20);
}

function localKeywords(text: string): string[] {
  if (isMostlyChinese(text)) {
    const cjkTerms = text.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{2,18}/g) ?? [];
    return [...new Set(cjkTerms)].slice(0, 10);
  }
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !["the", "and", "for", "with", "from", "that"].includes(token));
  return [...new Set(tokens)].slice(0, 10);
}

function localRerank(query: string, candidates: EventRecord[], topK: number): string[] {
  const queryTokens = new Set(localKeywords(query));
  return [...candidates]
    .sort((a, b) => {
      const overlapA = overlapScore(queryTokens, `${a.title} ${a.content}`);
      const overlapB = overlapScore(queryTokens, `${b.title} ${b.content}`);
      return (overlapB + (b.score ?? 0)) - (overlapA + (a.score ?? 0));
    })
    .slice(0, topK)
    .map((candidate) => candidate.id);
}

function overlapScore(queryTokens: Set<string>, text: string): number {
  const tokens = new Set(localKeywords(text));
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

function firstSentence(text: string): string {
  return text.trim().split(/(?<=[.!?。！？])\s+/u)[0]?.slice(0, 120) ?? "";
}

function cleanTitle(text: string): string {
  return text.replace(/^#+\s*/, "").trim().slice(0, 160) || "Untitled event";
}


function inferEntityType(name: string): string {
  if (/\d/.test(name)) return "metric";
  if (/(Inc|Corp|LLC|Ltd|Company|Group|公司|集团|大学|组织)$/i.test(name)) return "organization";
  if (/(System|Platform|Product|系统|平台|产品|模型|数据库)$/i.test(name)) return "product";
  if (/(Search|Retrieval|检索|搜索|算法|技术|方案)$/i.test(name)) return "subject";
  return "subject";
}

function normalizeEntityType(type: string): string {
  const allowed = new Set(["time", "location", "person", "organization", "subject", "product", "metric", "action", "work", "group", "tags"]);
  return allowed.has(type) ? type : "subject";
}

/**
 * JSON 修复解析：LLM 输出常带 markdown 围栏/前后噪声/截断。
 * 剥离后尝试解析；失败抛错（由上层重试）。
 * 防 LLM 输出不合法 → JSON.parse 直接崩 → token 空耗重试。
 */
function parseLlmJson(raw: string): Record<string, any> {
  let text = (raw ?? "").trim();
  // 1. 剥离 ```json ... ``` 围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // 2. 剥离首尾非 JSON 噪声（保留 { } 之间的部分）
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  // 3. 尝试解析
  try {
    return JSON.parse(text);
  } catch {
    // 4. 截断修复：去掉尾部不完整字段（"xxx": 后面没值的），再试
    const truncated = text.replace(/,\s*"[^"]*"\s*:\s*$/, "").replace(/,\s*"[^"]*"\s*:\s*[\[{][^\S]*$/, "");
    if (truncated !== text) {
      try {
        return JSON.parse(truncated);
      } catch { /* 仍失败则抛原始错误 */ }
    }
    throw new SyntaxError(`LLM JSON 解析失败: ${raw.slice(0, 200)}`);
  }
}

export const llmClient = new OpenAICompatibleLlmClient();
