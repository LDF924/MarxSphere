// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-model-router.ts — V394-2: 模型路由策略 + V404-6: KV-cache 感知档位保持(sticky tier)
// 简单步骤用便宜模型(flash), 复杂步骤用强模型(pro) — 成本-质量平衡
// 路由依据: 步骤类型 + 目标复杂度(长度/关键词)
//
// V404-6(借鉴 OpenSquilla KV-cache 感知 + sticky tier / anti-downgrade):
//   LLM 提供商(DeepSeek/Qwen)对"同模型 + 同前缀"自动做 prompt cache;
//   多轮任务中前轮用强档 X, 后轮降成便宜档 Y → 前缀全换 → cache 全 miss,
//   省下的模型差价 < 重算整个前缀的代价(反更贵/更慢)。
//   因此同一上下文(contextKey=taskId/会话)在 TTL(默认 600s)内**不降档**:
//   stickyTier 记该上下文最近用过的最高档, 后续路由目标档低于它 → 提到 sticky 档。
//   env: AGENT_TIER_HOLD_MS(0=关闭保持) / AGENT_TIER_HOLD_KEYED_ONLY(1=仅显式 contextKey, 不全局近似)
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

/** 档位升序(用于比较: 是否降档) */
const TIER_RANK: Record<ModelTier, number> = { cheap: 0, standard: 1, strong: 2 };
const TIER_BY_RANK: ModelTier[] = ["cheap", "standard", "strong"];

/** 由模型名推断档位(供未走 routeAgentModel 的调用登记 sticky 用; 与 routing-log.inferTier 同口径) */
export function tierOfModel(model: string): ModelTier {
  const m = String(model || "").toLowerCase();
  if (/flash|mini|haiku|light/.test(m)) return "cheap";
  if (/pro|max|opus/.test(m)) return "strong";
  if (/plus|sonnet|v4/.test(m)) return "standard";
  return "standard"; // 未知模型保守按标准档(避免误降)
}

// ═══ V404-6: sticky tier 状态(contextKey → {tier, seenAt}) ═══
const TIER_HOLD_MS = Math.max(0, parseInt(process.env.AGENT_TIER_HOLD_MS || "600000", 10)); // 默认 600s
const KEYED_ONLY = process.env.AGENT_TIER_HOLD_KEYED_ONLY === "1";
const sticky = new Map<string, { tier: ModelTier; seenAt: number }>();

/** 档位 → 模型(供路由落档; 同时记录 sticky) */
function modelForTier(effective: ModelTier): string {
  switch (effective) {
    case "cheap": return resolveModelAlias(getRoleModel("reason"));
    case "strong": return resolveModelAlias(getRoleModel("plan") || getRoleModel("reason"));
    default: return resolveModelAlias(getRoleModel("reason"));
  }
}

/**
 * 记录某上下文实际使用的档位(路由决定后回写; 供同任务后续步骤 sticky)
 * @param contextKey 任务/会话标识
 * @param tier 实际落档
 */
export function noteTierUsed(contextKey: string | undefined, tier: ModelTier): void {
  if (TIER_HOLD_MS <= 0) return;
  const key = contextKey || "_global";
  const prev = sticky.get(key);
  const curRank = TIER_RANK[tier];
  // 只升不降: 记录该上下文见过的最高档
  if (!prev || TIER_RANK[prev.tier] < curRank) {
    sticky.set(key, { tier, seenAt: Date.now() });
  } else {
    sticky.set(key, { tier: prev.tier, seenAt: Date.now() }); // 刷新 TTL
  }
}

/** 清理过期 sticky(定时/查询顺带) */
export function pruneTierHold(now: number = Date.now()): number {
  let n = 0;
  for (const [k, v] of sticky) {
    if (now - v.seenAt > TIER_HOLD_MS) { sticky.delete(k); n++; }
  }
  return n;
}

/** sticky 状态快照(诊断/单测) */
export function tierHoldStats(): Array<{ key: string; tier: ModelTier; ageMs: number }> {
  const now = Date.now();
  return [...sticky.entries()].map(([key, v]) => ({ key, tier: v.tier, ageMs: now - v.seenAt }));
}

/**
 * V394-2: 路由模型 — 按步骤类型+复杂度选档
 * V404-6: 落档前查 sticky — 若该上下文 TTL 内已用更高档 → 不降档(保 prompt cache)
 * @returns 模型ID（已解析别名）
 */
export function routeAgentModel(
  stepType: string,
  goalOrQuery: string,
  opts?: { userModel?: string; contextKey?: string }
): string {
  // 用户显式指定 → 优先(不参与 sticky 保持)
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
  // V404-6: KV-cache 档位保持 — 上下文 TTL 内见过的最高档作为下限
  if (TIER_HOLD_MS > 0) {
    const key = opts?.contextKey || (KEYED_ONLY ? undefined : "_global");
    pruneTierHold();
    if (key) {
      const seen = sticky.get(key);
      if (seen && Date.now() - seen.seenAt <= TIER_HOLD_MS && TIER_RANK[seen.tier] > TIER_RANK[effective]) {
        console.log(`[agent-router] V404-6 sticky 保持: ${effective} → ${seen.tier}(上下文 ${key.slice(0, 24)} 窗口内已用更高档, 保 prompt cache)`);
        effective = TIER_BY_RANK[TIER_RANK[seen.tier]];
      }
    }
  }
  // 记录本次落档(供后续步骤 sticky; 显式 key 或全局近似都记)
  if (TIER_HOLD_MS > 0 && !opts?.userModel) {
    noteTierUsed(opts?.contextKey, effective);
  }
  return modelForTier(effective);
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

export const agentModelRouter = { routeAgentModel, MODEL_TIER_LABELS, getModelFallbacks, noteTierUsed, tierHoldStats, pruneTierHold, tierOfModel };
