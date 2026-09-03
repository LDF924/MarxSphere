// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// extraction-schema.ts — 抽取输出程序化校验(zod)
// 引入背景: Zleap-AI/SAG 评审 P1 — 提示词契约化补上校验环
// 宽容校验策略: 合法输出必须通过; 失败由调用方回退本地抽取(不加重试)。
// 与现有清洗语义对齐: items.max(1) 容忍多 items(仍走 buildSingleExtractedEvent 归一化);
// priority/status/children/entities 为 optional(缺省由现有清洗逻辑兜底)。
import { z } from "zod";

import { extractDocumentContract } from "./extract-document.js";

const entityTypeEnum = z.enum(
  extractDocumentContract.entityTypes.map((e) => e.type) as [string, ...string[]],
);

// 事件 item 内部字段全部 optional + 类型检查: 缺字段由现有清洗逻辑兜底
// (buildSingleExtractedEvent 对 summary/category 缺失宽容, 与历史行为一致);
// 类型错误仍判非法。is_valid 缺失也容忍(collectValidEventItems 按 !== false 过滤)。
const eventItemSchema = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  category: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  priority: z.enum(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]).optional(),
  status: z.enum(["COMPLETED", "PROCESSING", "PENDING", "UNKNOWN"]).optional(),
  references: z.array(z.number().int()).optional(),
  entities: z
    .array(
      z.object({
        type: entityTypeEnum,
        name: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
  is_valid: z.boolean().optional(),
  // children 宽松: 非空 children 由 buildSingleExtractedEvent/collectValidEventItems 递归归一化
  children: z.unknown().optional(),
});

const envelopeSchema = z.object({
  type: z.literal("response"),
  data: z.object({
    // items 数量不限制: 多 items 由 buildSingleExtractedEvent 归一化为单事件(行为红线)
    items: z.array(eventItemSchema),
    meta: z.object({
      reason: z.string(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  }),
});

/** 兼容裸 { items: [...] } 形态(对齐原 result.items ?? result.data?.items 分支) */
const bareItemsSchema = z.object({
  items: z.array(eventItemSchema),
});

export type ExtractionResponseParsed = z.infer<typeof envelopeSchema> | z.infer<typeof bareItemsSchema>;

export type ExtractionValidationResult =
  | { valid: true; value: ExtractionResponseParsed }
  | { valid: false; reason: string };

/**
 * 校验 LLM 抽取输出。探测 data 字段选完整信封 / 裸 items schema。
 * 失败返回 invalid + 原因(调用方回退本地抽取并记日志)。
 */
export function validateExtractionResponse(raw: unknown): ExtractionValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { valid: false, reason: "not an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.data !== undefined) {
    const parsed = envelopeSchema.safeParse(raw);
    if (parsed.success) return { valid: true, value: parsed.data };
    return { valid: false, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const bare = bareItemsSchema.safeParse(raw);
  if (bare.success) return { valid: true, value: bare.data };
  return { valid: false, reason: bare.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
