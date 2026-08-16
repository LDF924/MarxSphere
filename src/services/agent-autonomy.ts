// agent-autonomy.ts — 借鉴 Codex approval modes: 自主级别
// suggest(建议, 每步审批) / auto-edit(自动执行, 高危审批) / full-auto(全自动, 只审计)
// 级别由环境变量 AGENT_AUTONOMY 或 API 设置; 影响 executeAgentTool 的审批判定
export type AutonomyLevel = "suggest" | "auto-edit" | "full-auto";

export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  "suggest": "建议模式 — 每步工具调用都需审批",
  "auto-edit": "自动编辑 — 常规操作自动执行, 高危(review级)仍审批",
  "full-auto": "全自动 — 全部自动执行, 只审计（高风险操作仍受 guardian 拦截）",
};

let autonomyLevel: AutonomyLevel = (process.env.AGENT_AUTONOMY as AutonomyLevel) || "auto-edit";

export function getAutonomyLevel(): AutonomyLevel {
  return autonomyLevel;
}

export function setAutonomyLevel(level: AutonomyLevel): boolean {
  if (!AUTONOMY_LABELS[level]) return false;
  autonomyLevel = level;
  return true;
}

/**
 * 按自主级别判定工具审批:
 * - suggest: 一切工具调用都需审批（除纯只读 reader 级）
 * - auto-edit: 常规(risk=safe)自动, review 级审批
 * - full-auto: 全自动, 仅 guardian deny 拦截
 */
export function requiresApprovalByAutonomy(toolRisk: string, minRole: string, currentRole: string): boolean {
  const level = getAutonomyLevel();
  if (level === "suggest") {
    // suggest: 只读(reader级)放行, 其余全部审批
    return minRole !== "reader";
  }
  if (level === "auto-edit") {
    // auto-edit: review 级工具审批, safe 放行
    return toolRisk === "review";
  }
  // full-auto: 不因自主级别拦截（guardian 兜底）
  return false;
}
