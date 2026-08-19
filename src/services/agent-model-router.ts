// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-model-router.ts — V394-2: 模型路由策略
// 简单步骤用便宜模型(flash), 复杂步骤用强模型(pro) — 成本-质量平衡
// 路由依据: 步骤类型 + 目标复杂度(长度/关键词)
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";

/** 模型档位 */
export type ModelTier = "cheap" | "standard" | "strong";

/** 步骤类型 → 默认档位 */
const TYPE_TIER: Record<string, ModelTier> = {
  retrieve: "cheap",      // 检索: 便宜模型足够
  summarize: "cheap",     // 摘要: 便宜
  write: "standard",      // 写作: 标准
  review: "standard",     // 评审: 标准
  reason: "strong",       // 推理: 强模型
  plan: "standard",       // 规划: 标准
  reflect: "standard",    // 评估: 标准
};

/** 复杂信号词（命中 → 升档） */
const COMPLEX_SIGNALS = ["机制", "因果", "比较", "评价", "影响", "多轮", "综合分析", "批判", "深度"];

/**
 * V394-2: 路由模型 — 按步骤类型+复杂度选档
 * @returns 模型ID（已解析别名）
 */
export function routeAgentModel(stepType: string, goalOrQuery: string, opts?: { userModel?: string }): string {
  // 用户显式指定 → 优先
  if (opts?.userModel) return resolveModelAlias(opts.userModel);
  const tier = TYPE_TIER[stepType] ?? "standard";
  // 复杂信号升档: 简单类型 + 复杂关键词 → 升一档
  const text = goalOrQuery || "";
  const hasComplex = COMPLEX_SIGNALS.some((k) => text.includes(k));
  let effective: ModelTier = tier;
  if (hasComplex) {
    if (tier === "cheap") effective = "standard";
    else if (tier === "standard") effective = "strong";
  }
  // 按档位映射到实际模型（注册表角色: cheap→reason, standard→reason, strong→plan(用户可选强模型)）
  switch (effective) {
    case "cheap": return resolveModelAlias(getRoleModel("reason"));
    case "strong": return resolveModelAlias(getRoleModel("plan") || getRoleModel("reason"));
    default: return resolveModelAlias(getRoleModel("reason"));
  }
}

/** 模型档位说明（前端展示用） */
export const MODEL_TIER_LABELS: Record<ModelTier, string> = {
  cheap: "便宜(flash类)", standard: "标准", strong: "强(pro类)",
};

/**
 * G4: fallback 模型链 — 主模型失败后依次换备用模型重试
 * 配置: AGENT_MODEL_FALLBACKS="deepseek-v4-flash,qwen3.7-max"（逗号分隔, 按序尝试）
 * 未配置: 按 provider 默认互备（deepseek→qwen, qwen→deepseek; pro→flash 同源降级优先）
 */
export function getModelFallbacks(model: string): string[] {
  const configured = (process.env.AGENT_MODEL_FALLBACKS || "").split(",")
    .map((s) => s.trim()).filter(Boolean);
  if (configured.length > 0) return configured;
  const base = resolveModelAlias(model);
  if (base.startsWith("deepseek")) {
    // 同源降级优先 pro→flash, 跨源兜底 qwen3.7-max
    return base === "deepseek-v4-pro"
      ? ["deepseek-v4-flash", "qwen3.7-max", "qwen-plus"]
      : ["deepseek-v4-pro", "qwen3.7-max", "qwen-plus"];
  }
  if (base.startsWith("qwen")) {
    return ["deepseek-v4-flash", "deepseek-v4-pro"];
  }
  return [];
}

export const agentModelRouter = { routeAgentModel, MODEL_TIER_LABELS, getModelFallbacks };
