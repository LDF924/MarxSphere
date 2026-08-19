// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-presets.ts — 借鉴 DSH preset 包: Agent 模式预设
// 预设 = 工具集 + 模型档位 + 行为约束 + 默认参数 的组合（DSH: 不同模式加载不同插件集）
// 模式: academic(学术研究, 默认) / data(数据分析) / writing(论文写作) / coding(代码开发)
import type { SandboxProfile } from "./code-sandbox-service.js";

export type AgentPresetId = "academic" | "data" | "writing" | "coding";

export interface AgentPreset {
  id: AgentPresetId;
  label: string;
  desc: string;
  /** 允许的工具白名单（null=全部） */
  tools: string[] | null;
  /** 模型档位偏好 */
  modelTier: "cheap" | "standard" | "strong";
  /** 沙箱默认级别 */
  sandboxProfile: SandboxProfile;
  /** 行为约束（注入规划提示） */
  constraints: string;
  /** 默认任务参数 */
  defaults: Record<string, unknown>;
}

/** 预设定义（DSH preset 模式: 模式=插件组合） */
export const AGENT_PRESETS: Record<AgentPresetId, AgentPreset> = {
  academic: {
    id: "academic", label: "学术研究", desc: "文献检索/理论分析/综述写作（默认）",
    tools: null,  // 全部工具
    modelTier: "standard",
    sandboxProfile: "read-only",
    constraints: "研究导向: 以三库检索为证据基础, 引用须可追溯, 术语使用学术规范。",
    defaults: {},
  },
  data: {
    id: "data", label: "数据分析", desc: "实证回归/统计检验/数据管道",
    tools: ["sag_reason", "sag_retrieve", "empirical_analysis", "run_code", "file_read", "summarize"],
    modelTier: "standard",
    sandboxProfile: "workspace-write",  // 数据分析需写临时文件
    constraints: "数据导向: 所有结论须来自真实计算, 报告样本量/系数/显著性, 不得虚构统计结果。",
    defaults: { sandboxProfile: "workspace-write" },
  },
  writing: {
    id: "writing", label: "论文写作", desc: "段落/综述/引言生成（语料库增强）",
    tools: ["sag_reason", "sag_retrieve", "llm_write", "review_output", "summarize", "file_read"],
    modelTier: "standard",
    sandboxProfile: "read-only",
    constraints: "写作导向: 借鉴语料库句式与逻辑（不得照抄原文）, 结构清晰, 术语规范。",
    defaults: {},
  },
  coding: {
    id: "coding", label: "代码开发", desc: "沙箱编码/调试/文件操作",
    tools: ["run_code", "file_read", "file_write", "web_fetch", "agent_subagent", "sag_reason"],
    modelTier: "strong",
    sandboxProfile: "workspace-write",
    constraints: "代码导向: 先读后写, 代码须可运行, 变更最小化, 错误处理完整。",
    defaults: { sandboxProfile: "workspace-write" },
  },
};

/** 当前激活预设（AGENT_PRESET 环境变量或 setAgentPreset; 默认 academic） */
let activePreset: AgentPresetId = (process.env.AGENT_PRESET as AgentPresetId) || "academic";
export function getActivePreset(): AgentPreset {
  return AGENT_PRESETS[activePreset] || AGENT_PRESETS.academic;
}
export function setActivePreset(id: AgentPresetId): boolean {
  if (!AGENT_PRESETS[id]) return false;
  activePreset = id;
  return true;
}

/** 预设约束提示（规划注入用） */
export function presetConstraintHint(): string {
  const p = getActivePreset();
  return `\n【当前模式: ${p.label}】${p.constraints}`;
}

/** 预设工具过滤（buildAgentTools 后按预设裁剪） */
export function filterToolsByPreset(tools: Array<{ name: string }>): Array<{ name: string }> {
  const p = getActivePreset();
  if (!p.tools) return tools;
  return tools.filter((t) => p.tools!.includes(t.name));
}
