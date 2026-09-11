// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// llm-model-registry.ts — 统一 LLM 模型注册表（2026-08-07）
// 角色 → 模型映射集中管理，前端可选择，所有调用点读取
// 角色: reason(推理合成) / judge(评测打分) / review(评审) / plan(规划) / verify(题型复核) / strategy(策略决策)
//       viz(科研绘图: 规划/出图代码/自审 — 用户可在绘图面板单独切换)
//       editor(学术写作: 编辑器 AI 助手 — 与推理链解耦, 用户可在编辑器面板单独切换)

export type LlmRole = "reason" | "judge" | "review" | "plan" | "verify" | "strategy" | "viz" | "editor";

/** 全部角色(注册表里"支持所有角色"的模型直接展开它, 免得每加一个角色就要改 N 处) */
const ALL_ROLES: LlmRole[] = ["reason", "judge", "review", "plan", "verify", "strategy", "viz", "editor"];

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
    desc: "旗舰推理（1.6T 参数 · 原生 1M 上下文 · 384K 输出）", roles: [...ALL_ROLES],
  },
  {
    id: "deepseek-v4-flash", label: "DeepSeek V4 Flash（1M 上下文）", provider: "deepseek",
    desc: "快速推理（284B 参数 · 原生 1M 上下文 · 性价比高）", roles: [...ALL_ROLES],
  },
  {
    id: "qwen3.7-max", label: "通义千问 3.7 Max", provider: "dashscope",
    desc: "阿里旗舰（2026-05 发布 · 1M 上下文 · 智能体基座）", roles: [...ALL_ROLES],
  },
  {
    id: "qwen-plus", label: "通义千问 Plus", provider: "dashscope",
    desc: "阿里 DashScope（历史默认，兜底）", roles: ["reason", "judge", "viz", "editor"],
  },
  {
    id: "claude-sonnet-4-8", label: "Claude Sonnet 4.8", provider: "claude",
    desc: "Anthropic 旗舰平衡（需 Anthropic 端点配置）", roles: [...ALL_ROLES],
  },
  {
    id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "claude",
    desc: "Anthropic 最强推理（需 Anthropic 端点配置）", roles: ["reason", "judge", "review", "viz", "editor"],
  },
  {
    id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "claude",
    desc: "Anthropic 快速轻量（需 Anthropic 端点配置）", roles: ["judge", "verify", "strategy", "viz", "editor"],
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
  viz: "deepseek-v4-flash",
  // 学术写作: 与 reason 同源起步, 但独立存储 —— 切换它不影响推理链
  editor: "deepseek-v4-flash",
};

/** 学术写作(editor)角色是否被用户显式选择过 — 未选择时跟随 reason */
let editorModelSet = false;

/** 设置角色模型（前端选择调用） */
export function setRoleModel(role: LlmRole, modelId: string): void {
  if (LLM_MODEL_REGISTRY.some((m) => m.id === modelId)) {
    roleModelMap[role] = modelId;
    if (role === "editor") editorModelSet = true;
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
  // editor 未显式设置时跟随 reason(保持"写作与推理同源"的原有行为)
  if (role === "editor" && !editorModelSet) return getRoleModel("reason");
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

/**
 * 批量覆盖角色映射(用户设置落库后回灌; 非法模型名忽略)。
 * editor 需单独标记"是否被显式设置过" —— 否则下次读取时无法区分
 * "用户就是要用 reason 的模型" 与 "用户从没选过, 默认跟随 reason"。
 */
export function setRoleModelMap(map: Partial<Record<LlmRole, string>>): void {
  for (const role of ALL_ROLES) {
    const m = map[role];
    if (!m) continue;
    if (LLM_MODEL_REGISTRY.some((x) => x.id === m)) {
      roleModelMap[role] = m;
      if (role === "editor") editorModelSet = true;
    }
  }
}

/** editor 角色是否被显式设置过(持久化时要一并存这个标志, 否则"跟随 reason"的语义会丢) */
export function isEditorModelSet(): boolean {
  return editorModelSet;
}

// ═══ provider 端点解析 ═══
// 2026-09-10 修复: 原先 model 由用户选择、url/key 却只看 DEEPSEEK_API_KEY 是否存在,
//   导致选 Claude/通义千问时把它们的模型名发给了 DeepSeek 端点(必然 400 → 静默空结果)。
//   现在按 model 所属 provider 解析端点, 两者强制联动。
export interface ProviderEndpoint {
  provider: LlmModelOption["provider"];
  url: string;
  key: string;
  keyEnv: string;
}

/** 某 provider 的端点配置; key 为空表示未配置, 该 provider 的模型不可选 */
export function getProviderEndpoint(provider: LlmModelOption["provider"]): ProviderEndpoint {
  if (provider === "claude") {
    const key = process.env.ANTHROPIC_API_KEY || "";
    // Anthropic 原生 /messages 端点(fetchLlm 依 url 含 /messages 自动切请求格式)
    const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1").replace(/\/$/, "");
    return { provider, url: `${base}/messages`, key, keyEnv: "ANTHROPIC_API_KEY" };
  }
  if (provider === "dashscope") {
    const key = process.env.DASHSCOPE_API_KEY || "";
    const base = (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
    return { provider, url: `${base}/chat/completions`, key, keyEnv: "DASHSCOPE_API_KEY" };
  }
  const key = process.env.DEEPSEEK_API_KEY || "";
  const url = process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions";
  return { provider, url, key, keyEnv: "DEEPSEEK_API_KEY" };
}

/** 模型 id → 注册项; 别名先解析(deepseek-chat → deepseek-v4-flash) */
export function findModelOption(model: string): LlmModelOption | null {
  const id = resolveModelAlias(model);
  return LLM_MODEL_REGISTRY.find((m) => m.id === id) ?? null;
}

/** 该模型所属 provider 是否已配置密钥(前端下拉过滤 + 后端校验共用) */
export function isModelUsable(model: string): boolean {
  const opt = findModelOption(model);
  if (!opt) return false;
  return Boolean(getProviderEndpoint(opt.provider).key);
}

export const llmModelRegistry = {
  LLM_MODEL_REGISTRY,
  setRoleModel,
  setRoleModelMap,
  getRoleModel,
  getRoleModelMap,
  isEditorModelSet,
  getProviderEndpoint,
  findModelOption,
  isModelUsable,
};
