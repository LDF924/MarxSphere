// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// extraction-utils.ts — 事件抽取行为常量与语言检测纯函数
// isMostlyChinese / isLikelyLanguageDrift 从 llm-client.ts 逐字迁出(仅加 export)
import { BENCHMARK_ENTITY_TYPES } from "./extract-document.js";

/** 实体类型白名单(11 类; normalizeEntityType 超界归 subject 的依据) */
export const ENTITY_TYPE_SET: ReadonlySet<string> = new Set(
  BENCHMARK_ENTITY_TYPES.map((entityType) => entityType.type),
);

export const PRIORITY_VALUES = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;

export const STATUS_VALUES = ["COMPLETED", "PROCESSING", "PENDING", "UNKNOWN"] as const;

/** 判断文本主体是否为中文(逐字迁移自 llm-client.ts) */
export function isMostlyChinese(text: string): boolean {
  const cjkChars = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  return cjkChars > latinWords * 2;
}

/** 判断 LLM 输出是否发生语言漂移(逐字迁移自 llm-client.ts) */
export function isLikelyLanguageDrift(text: string, inputIsChinese: boolean): boolean {
  const cjkChars = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  if (inputIsChinese) {
    return cjkChars === 0 && latinWords >= 4;
  }
  return cjkChars >= 8 && latinWords <= 2;
}
