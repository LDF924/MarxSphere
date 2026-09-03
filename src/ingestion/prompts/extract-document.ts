// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// extract-document.ts — 文档事件抽取提示词契约(单一真源)
// 引入背景: Zleap-AI/SAG 评审 P1 — 抽取提示词契约化
// 本文件是 prompt 字符串 / zod 校验 schema / entity_types 三处的唯一数据源,
// 全部内容从 llm-client.ts 原 buildBenchmarkExtraction* 系列函数逐字迁移(行为不变)。

export interface EntityTypeDef {
  type: string;
  description: string;
}

/** 文档事件抽取契约: 输出单一融合事项 + 实体; strict 约束驱动生成, zod 驱动校验 */
export interface ExtractDocumentContract {
  /** system prompt 模板(含 {now} 占位, 用 renderExtractionSystemPrompt 渲染) */
  systemPrompt: string;
  /** few-shot 示例输入(JSON 信封) */
  exampleInput: Record<string, unknown>;
  /** few-shot 示例输出(JSON 信封) */
  exampleOutput: Record<string, unknown>;
  /** 实体类型白名单(11 类) */
  entityTypes: readonly EntityTypeDef[];
  /** 输出 JSON Schema(供 LLM 的 output_schema 字段, 仅提示用) */
  outputSchema: Record<string, unknown>;
}

export const BENCHMARK_ENTITY_TYPES: readonly EntityTypeDef[] = [
  { type: "person", description: "人物、作者、用户、负责人等具体个人" },
  { type: "organization", description: "公司、机构、团体、政府部门、学校、团队等组织" },
  { type: "location", description: "地点、地域、国家、城市、场所、地址" },
  { type: "time", description: "日期、年份、时期、时间表达" },
  { type: "product", description: "产品、系统、平台、模型、软件、服务、数据库" },
  { type: "metric", description: "数字、指标、金额、比例、数量、评分、性能数据" },
  { type: "action", description: "动作、行为、流程、操作、状态变化" },
  { type: "work", description: "作品、文档、论文、项目、任务、计划" },
  { type: "group", description: "人群、角色群体、职业群体、用户群体" },
  { type: "subject", description: "主题、概念、领域、技术、专业术语、事件名称" },
  { type: "tags", description: "其他类型均不匹配时使用的标签实体" }
];

function benchmarkOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["type", "data"],
    properties: {
      type: { const: "response" },
      data: {
        type: "object",
        required: ["items", "meta"],
        properties: {
          items: {
            type: "array",
            minItems: 0,
            maxItems: 1,
            items: {
              type: "object",
              required: ["title", "summary", "content", "category", "keywords", "references", "entities", "is_valid"],
              properties: {
                title: { type: "string" },
                summary: { type: "string" },
                content: { type: "string" },
                category: { type: "string" },
                keywords: { type: "array", items: { type: "string" } },
                priority: { enum: ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] },
                status: { enum: ["COMPLETED", "PROCESSING", "PENDING", "UNKNOWN"] },
                references: { type: "array", items: { type: "integer" } },
                entities: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["type", "name", "description"],
                    properties: {
                      type: { enum: BENCHMARK_ENTITY_TYPES.map((entityType) => entityType.type) },
                      name: { type: "string" },
                      description: { type: "string" }
                    }
                  }
                },
                is_valid: { type: "boolean" },
                children: { type: "array", maxItems: 0 }
              }
            }
          },
          meta: {
            type: "object",
            required: ["reason"],
            properties: {
              reason: { type: "string" },
              confidence: { type: "number" }
            }
          }
        }
      }
    }
  };
}

const EXTRACTION_SYSTEM_PROMPT_TEMPLATE = `
## Role

You are a professional SAG content extractor. Extract exactly two structured objects from raw documents: events and entities.

## Benchmark-aligned Event Principles

- Mandatory single event: all valid fragments in the input must be fused into one comprehensive top-level event. Do not split different topics into multiple top-level events.
- Global scan first: identify time, location, subject, action, object, data, evaluation, cause/effect, comparison, and relationship units before writing the event.
- Cross-fragment association: resolve subject continuity, temporal continuity, causal/progressive links, contrasts, aliases, and references.
- Information coverage: every valid information unit must be represented in the single event or explicitly treated as noise in data.meta.reason.
- Faithfulness: do not invent facts, omit core facts, change the subject, or mechanically copy long original text.
- Panoramic integration: the event content should be an organic narrative thread, not a bullet list.
- Preserve relative time expressions unless the source already gives exact dates.

## Entity Principles

- Extract the entities required to understand the event, especially subjects, actions/predicates, objects, products, systems, models, metrics, organizations, people, locations, dates, and key concepts.
- Split coordinated entities such as "A and B" into separate entities.
- Use only the provided entity_types. Prefer specific types; use tags only when no specific type fits.
- Each entity.description must explain that entity's concrete role or relationship in the event.

## Input Contract

The user message is JSON:
- type: "request"
- data.items: content fragments, each with 1-based id and content
- data.meta.source_type, source_title, source_summary, previous_context, related_events, entity_types
- output_schema: JSON schema for the response

Current time: ${"${now}"}

## Output Contract

Return JSON only. Do not wrap it in markdown.
The response must be:
{
  "type": "response",
  "data": {
    "items": [
      {
        "title": "...",
        "summary": "...",
        "content": "...",
        "category": "...",
        "keywords": ["..."],
        "priority": "HIGH|MEDIUM|LOW|UNKNOWN",
        "status": "COMPLETED|PROCESSING|PENDING|UNKNOWN",
        "references": [1],
        "entities": [{ "type": "...", "name": "...", "description": "..." }],
        "is_valid": true,
        "children": []
      }
    ],
    "meta": {
      "reason": "...",
      "confidence": 0.9
    }
  }
}

## Strict Rules

- data.items must contain exactly one valid event unless the input has no useful factual content.
- children must be an empty array.
- references must cite all valid fragments used by the fused event and no unrelated fragments.
- meta.reason must state the topic identification logic, cross-fragment association evidence, semantic restructuring choices, coverage status, and noise handling.
- Output language must follow the main input language. Chinese input requires Chinese title, summary, content, category, entity descriptions, and reason.
`.trim();

function benchmarkExampleInput(): Record<string, unknown> {
  return {
    type: "request",
    data: {
      items: [{
        id: 1,
        content: "# SAG 检索\n\nSAG 将文档切成 chunk，抽取单个融合事项和实体，再通过 entity-event 关系进行多跳检索。"
      }],
      meta: {
        source_type: "article",
        source_title: "SAG 说明",
        source_summary: "",
        previous_context: "",
        related_events: [],
        entity_types: BENCHMARK_ENTITY_TYPES
      }
    },
    output_schema: benchmarkOutputSchema()
  };
}

function benchmarkExampleOutput(): Record<string, unknown> {
  return {
    type: "response",
    data: {
      items: [{
        title: "SAG 文档入库与多跳检索流程",
        summary: "SAG 通过 chunk、融合事项、实体和 entity-event 关系组织文档，以支持多跳检索。",
        content: "SAG 将文档切分为 chunk，并从每个 chunk 中抽取单个融合事项和关键实体，再利用 entity-event 关系进行多跳检索。",
        category: "检索流程",
        keywords: ["SAG", "chunk", "融合事项", "实体", "多跳检索"],
        priority: "UNKNOWN",
        status: "COMPLETED",
        references: [1],
        entities: [
          { type: "product", name: "SAG", description: "执行文档入库和多跳检索的系统" },
          { type: "subject", name: "chunk", description: "SAG 文档入库时形成的原文切片" },
          { type: "subject", name: "entity-event 关系", description: "SAG 多跳检索依赖的事项与实体连接关系" }
        ],
        is_valid: true,
        children: []
      }],
      meta: {
        reason: "识别出一个围绕 SAG 入库与检索的统一主题；覆盖 id1 的 chunk、事项、实体和多跳检索信息；无孤立有效片段。",
        confidence: 0.9
      }
    }
  };
}

export const extractDocumentContract: ExtractDocumentContract = {
  systemPrompt: EXTRACTION_SYSTEM_PROMPT_TEMPLATE,
  exampleInput: benchmarkExampleInput(),
  exampleOutput: benchmarkExampleOutput(),
  entityTypes: BENCHMARK_ENTITY_TYPES,
  outputSchema: benchmarkOutputSchema()
};

/** 渲染 system prompt; 无参时内部取当前时间(与原 buildBenchmarkExtractionSystemPrompt 一致) */
export function renderExtractionSystemPrompt(now?: string): string {
  return extractDocumentContract.systemPrompt.replace("${now}", now ?? new Date().toISOString());
}
