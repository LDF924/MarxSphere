// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// agent-autonomy.ts — 借鉴 Codex approval modes: 自主级别
// suggest(建议, 每步审批) / auto-edit(自动执行, 高危审批) / full-auto(全自动, 只审计)
// 级别由环境变量 AGENT_AUTONOMY 或 API 设置; 影响 executeAgentTool 的审批判定
export type AutonomyLevel = "suggest" | "auto-edit" | "full-auto";

export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  "suggest": "建议模式 — 每步工具调用都需审批",
  "auto-edit": "自动编辑 — 常规操作自动执行, 高危(review级)仍审批",
  "full-auto": "全自动 — 全部自动执行, 只审计（高风险操作仍受 guardian 拦截）",
};

/**
 * 缺省自主级别 = "auto-edit"。
 *
 * ## 为什么从 suggest 回到 auto-edit(2026-09-28, 两轮的结论)
 *
 * V417(2026-09-14)把它从 auto-edit 改成 suggest, 理由是安全审计发现
 * **`runtime_exec` / `run_code` 这类"任意代码执行"的能力当时标着 risk:"safe"** ——
 * 而 auto-edit 的规则是"safe 自动执行", 于是开箱即用地能无审批跑任意 Python。
 * 那个判断**是对的**, suggest 当时确实是安全的那一侧。
 *
 * 但 suggest 有一个当时没被看见的后果:**在编排里, "需要审批" == "失败"**。
 * 编排是在 HTTP 请求之外跑的后台任务, 没有"停下来等人点同意"这一态 ——
 * `executeAgentTool` 返回 `requiresApproval: true` 时, 步骤直接记 failed。
 * 于是平台的旗舰模板**默认跑不完**(2026-09-28 实测):
 *
 *   tpl_five_stage(标准五阶段论文)
 *     intake         done        ← 澄清输入正常
 *     analyze        failed      工具 llm_write 需要审批（当前自主级别: 建议模式）
 *     materials      failed      上游步骤失败, 跳过
 *     material_plan  failed      上游步骤失败, 跳过
 *     draft          failed      上游步骤失败, 跳过
 *     gate           failed      上游步骤失败, 跳过
 *
 * 也就是说: **安全档把功能关掉了, 而不是把危险挡住**。那不是"更安全", 是"更没用"。
 *
 * ## 为什么现在回到 auto-edit 是安全的
 *
 * 安全审计指出的那个真问题**已经修掉了** —— 本轮逐个核对了全部 `risk:"safe"` 的 agent 工具
 * (共 40 个), 把三个不该是 safe 的改成了 review:
 *   · `run_code`  —— 任意代码执行(还带 workspace-write/full-access 档), 原来的 safe 是错的
 *   · `orch_run`  —— 能触发含任意工具的编排, 是**提权旁路**
 *   · `doc_edit`  —— 改知识库文档, 会写
 * 其余 safe 都是检索/生成/教育档案读取, 确实低危。危险的那批
 * (runtime_exec / run_command / file_write / sag_ingest / apply_patch)**V417 那次已经改了**。
 *
 * 于是 auto-edit 现在的语义是准的: **safe 自动跑, review 一律要审批**。
 * 它比 suggest 可用(常规科研编排不再被自己的安全档拦死), 又比 full-auto 保守
 * (写文件/跑命令/入库仍然必须人点)。
 *
 * ## 什么时候该显式设成别的
 *
 * · 首次部署、多租户、或想让每一步都过人眼 → 显式 `AGENT_AUTONOMY=suggest`
 * · 完全无人值守的批处理 → `AGENT_AUTONOMY=full-auto`(仍有 guardian 兜底)
 *
 * ⚠ 无论哪一档, **guardian 策略层都还在**(见 agent-guardian-service): 它是独立的一道,
 *   按"风险等级 × 用户授权度"判, 不因这里换成 auto-edit 而失效。
 */
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
