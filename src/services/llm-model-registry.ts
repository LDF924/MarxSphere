// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// llm-model-registry.ts — 统一 LLM 模型注册表（2026-08-07）
// 角色 → 模型映射集中管理，前端可选择，所有调用点读取
// 角色: reason(推理合成) / judge(评测打分) / review(评审) / plan(规划) / verify(题型复核) / strategy(策略决策)

export type LlmRole = "reason" | "judge" | "review" | "plan" | "verify" | "strategy";

export interface LlmModelOption {
  id: string;
  label: string;
  provider: "deepseek" | "dashscope" | "claude";
  desc: string;
  /** 默认角色分配（可被用户选择覆盖） */
  roles: LlmRole[];
}

/** 可用模型注册表（前端展示 + 后端校验）——2026-08-07 按官方接口文档更新
 * DeepSeek: /models 实测返回 deepseek-v4-flash, deepseek-v4-pro（均原生 1M 上下文；
 *   [1M] 只是显示标注——API 不接受带 [1M] 的 ID，实测报 "supported API model names"）
 * 阿里: qwen3.7-max（2026-05-20 发布，1M 上下文，旗舰）+ qwen-plus（历史默认）
 * Claude（2026-08-27 模型中立 ScienceX）: Anthropic 官方端点自动识别(/messages),
 *   需配置 LLM_BASE_URL=https://api.anthropic.com/v1 + LLM_API_KEY=sk-ant-...
 */
export const LLM_MODEL_REGISTRY: LlmModelOption[] = [
  {
    id: "deepseek-v4-pro", label: "DeepSeek V4 Pro（1M 上下文）", provider: "deepseek",
    desc: "旗舰推理（1.6T 参数 · 原生 1M 上下文 · 384K 输出）", roles: ["reason", "judge", "review", "plan", "verify", "strategy"],
  },
  {
    id: "deepseek-v4-flash", label: "DeepSeek V4 Flash（1M 上下文）", provider: "deepseek",
    desc: "快速推理（284B 参数 · 原生 1M 上下文 · 性价比高）", roles: ["reason", "judge", "review", "plan", "verify", "strategy"],
  },
  {
    id: "qwen3.7-max", label: "通义千问 3.7 Max", provider: "dashscope",
    desc: "阿里旗舰（2026-05 发布 · 1M 上下文 · 智能体基座）", roles: ["reason", "judge", "review", "plan", "verify", "strategy"],
  },
  {
    id: "qwen-plus", label: "通义千问 Plus", provider: "dashscope",
    desc: "阿里 DashScope（历史默认，兜底）", roles: ["reason", "judge"],
  },
  {
    id: "claude-sonnet-4-8", label: "Claude Sonnet 4.8", provider: "claude",
    desc: "Anthropic 旗舰平衡（需 Anthropic 端点配置）", roles: ["reason", "judge", "review", "plan", "verify", "strategy"],
  },
  {
    id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "claude",
    desc: "Anthropic 最强推理（需 Anthropic 端点配置）", roles: ["reason", "judge", "review"],
  },
  {
    id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "claude",
    desc: "Anthropic 快速轻量（需 Anthropic 端点配置）", roles: ["judge", "verify", "strategy"],
  },
];

/** 角色 → 模型映射（用户选择覆盖；默认按注册表 roles 第一个） */
const roleModelMap: Record<LlmRole, string> = {
  reason: "deepseek-v4-flash",
  judge: "deepseek-v4-flash",
  review: "deepseek-v4-flash",
  plan: "deepseek-v4-pro",
  verify: "deepseek-v4-flash",
  strategy: "deepseek-v4-flash",
};

/** 设置角色模型（前端选择调用） */
export function setRoleModel(role: LlmRole, modelId: string): void {
  if (LLM_MODEL_REGISTRY.some((m) => m.id === modelId)) {
    roleModelMap[role] = modelId;
  }
}

/** 获取角色模型（含别名解析：[1M] 后缀移除、deepseek-chat 退役映射）
 * P0-5 模型替换实验: 支持环境变量覆盖——
 *   MODEL_SWAP_ROLE=reason:qwen3.7-max,judge:deepseek-v4-pro （分号分隔 角色:模型）
 *   评测侧跑对照实验时用 eval 脚本设置, 不改注册表默认值
 */
export function getRoleModel(role: LlmRole): string {
  const swap = process.env.MODEL_SWAP_ROLE || '';
  if (swap) {
    for (const pair of swap.split(',')) {
      const [r, m] = pair.split(':');
      if (r === role && m) return resolveModelAlias(m.trim());
    }
  }
  return resolveModelAlias(roleModelMap[role]);
}

/** 模型别名解析（所有直连 fetch 处共用）：
 * - "xxx[1M]" → "xxx"（官方无独立 [1M] ID，原生即 1M 上下文）
 * - "deepseek-chat"（2026-07-24 已退役）→ "deepseek-v4-flash"
 */
export function resolveModelAlias(model: string): string {
  const base = model.replace(/\[1M\]$/, "");
  if (base === "deepseek-chat") return "deepseek-v4-flash";
  return base;
}

/** 当前角色映射（前端展示） */
export function getRoleModelMap(): Record<LlmRole, string> {
  return { ...roleModelMap };
}

export const llmModelRegistry = {
  LLM_MODEL_REGISTRY,
  setRoleModel,
  getRoleModel,
  getRoleModelMap,
};
