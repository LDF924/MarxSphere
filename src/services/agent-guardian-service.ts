// agent-guardian-service.ts — 借鉴 OpenAI Codex guardian/ 包
// 策略驱动的工具调用安全审查: 风险等级 × 用户授权度 → allow/deny/review
// 策略文件: guardian-policy.md（可编辑, reload 热更新）
// 与 sidecar-guard 的关系: sidecar 是规则+LLM 双层审查; guardian 是
// 策略文件层(Codex 模式), 输出结构化判定供审计/前端展示
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type GuardianVerdict = "allow" | "deny" | "review";
export type RiskLevel = "low" | "medium" | "high";
export type AuthorizationLevel = "high" | "medium" | "low" | "unknown";

export interface GuardianDecision {
  verdict: GuardianVerdict;
  riskLevel: RiskLevel;
  authorization: AuthorizationLevel;
  reason: string;
  /** 命中策略条款 */
  policyClause?: string;
}

/** 工具 → 基础风险等级（对齐 guardian-policy.md 判定矩阵） */
const TOOL_RISK: Record<string, RiskLevel> = {
  // 只读认知工具 → 低风险
  sag_reason: "low", sag_retrieve: "low", sag_search: "low", sag_get_event: "low",
  concept_trace: "low", policy_search: "low", summarize: "low", review_output: "low",
  file_read: "low", web_fetch: "low", pdf_parse: "low",
  // 写/执行 → 中-高风险
  llm_write: "medium", empirical_analysis: "medium", file_write: "medium",
  run_code: "medium",       // 沙箱内 → 中; 越级(full-access) 由参数判定升级
  agent_subagent: "medium", // 外部 Agent 调用 → 中(子进程隔离)
  sag_ingest: "medium",     // 入库 → 中(数据写)
};

/** 判定矩阵（guardian-policy.md）: risk × authorization → verdict */
function verdictMatrix(risk: RiskLevel, auth: AuthorizationLevel): GuardianVerdict {
  if (auth === "high") return risk === "high" ? "review" : "allow";
  if (auth === "medium") return risk === "low" ? "allow" : "review";
  return risk === "low" ? "review" : "deny";  // low/unknown 授权: low风险review, 中高deny
}

/** 读取策略文件（缺失时用内置默认说明） */
export function readGuardianPolicy(): string {
  try {
    const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "guardian-policy.md");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "（策略文件缺失, 使用内置默认: 见判定矩阵）";
  } catch { return "（策略文件不可读）"; }
}

/**
 * 审查一次工具调用（Codex Guardian 判定流程）
 * @param toolName 工具名
 * @param args 参数（用于检查越级/危险信号）
 * @param authorization 用户授权度（默认 high — agent 步骤由任务目标授权）
 */
export function guardianReview(
  toolName: string,
  args: Record<string, unknown> = {},
  authorization: AuthorizationLevel = "high"
): GuardianDecision {
  const risk = TOOL_RISK[toolName] ?? "medium";
  // 参数级风险升级: full-access 沙箱/危险路径 → 升高风险
  let effectiveRisk = risk;
  let clause: string | undefined;
  if (toolName === "run_code" && String(args.profile || "") === "full-access") {
    effectiveRisk = "high";
    clause = "代码执行: full-access 含网络/进程操作 → 高风险, 需 sidecar 门控";
  }
  if (toolName === "web_fetch") {
    const url = String(args.url || "");
    if (!/^https?:\/\//i.test(url)) {
      return { verdict: "deny", riskLevel: "high", authorization, reason: `网页抓取 URL 非法: ${url.slice(0, 40)}`, policyClause: "数据外泄: 出口动作必须可追溯" };
    }
  }
  if (toolName === "file_write" || toolName === "file_read") {
    const p = String(args.path || "");
    if (p.includes("..") || /^[/\\]/.test(p) || /^[A-Za-z]:/.test(p)) {
      return { verdict: "deny", riskLevel: "high", authorization, reason: `路径越界: ${p.slice(0, 40)}`, policyClause: "破坏性操作: 越界路径 deny" };
    }
  }
  const verdict = verdictMatrix(effectiveRisk, authorization);
  return {
    verdict,
    riskLevel: effectiveRisk,
    authorization,
    reason: `风险${effectiveRisk} × 授权${authorization} → ${verdict}${clause ? "（" + clause + "）" : ""}`,
    policyClause: clause,
  };
}

/** 批量审查（前端展示判定依据用） */
export function guardianBatchReview(calls: Array<{ tool: string; args?: Record<string, unknown> }>, authorization: AuthorizationLevel = "high"): GuardianDecision[] {
  return calls.map((c) => guardianReview(c.tool, c.args, authorization));
}

/** 热重载策略（编辑 guardian-policy.md 后调用; 当前为文件读取模式, 天然热更新） */
export function reloadGuardianPolicy(): { ok: boolean; size: number } {
  try {
    const content = readGuardianPolicy();
    return { ok: true, size: content.length };
  } catch (e: any) {
    return { ok: false, size: 0 };
  }
}

export const guardianService = {
  guardianReview,
  guardianBatchReview,
  readGuardianPolicy,
  reloadGuardianPolicy,
};
