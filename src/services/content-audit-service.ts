// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// content-audit-service.ts — 思政内容四维核验（复赛冲刺期实现）
// 马理论/思政教育输出交付前核验：
//   ① 意识形态核验：与马理论基本原理、党的创新理论表述一致
//   ② 表述准确性：专有名词/术语/历史事件表述准确（对照知识库权威源）
//   ③ 引用真实性：引用真实存在、版本对应（防模型幻觉）
//   ④ 边界提示：不确定/争议内容输出置信度 + 引导人工核实
// 权威校准：输出含马理论概念时，强制检索 Compiled Truth 知识页对照校验
// 审核分级：低风险自动核验 / 中风险+置信度 / 高风险+人工确认提示
// 边界: 不替代教师/学校/专业机构的最终教育评价；不替代思政教师判断
import { llmJson } from "./education-service.js";
import { searchCompiledTruth } from "../db/repositories.js";

// ═══ 规则通道：意识形态/表述的高危词表 ═══
// 常见易错/高危表述（命中即重点核验；不自动判错，交给 LLM Judge + 人工确认）
const HIGH_RISK_RULES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(马克思|恩格斯|列宁).{0,8}(说|认为).{0,20}(没有|不存在|错误)/, label: "对经典作家观点的否定性转述" },
  { pattern: /(社会主义|共产主义).{0,6}(=|=|等同|等于).{0,8}(资本主义|私有制)/, label: "制度概念混淆" },
  { pattern: /(剩余价值|剥削).{0,6}(不存在|已消失|没有)/, label: "对基本原理的否定" },
  { pattern: /(马克思主义).{0,8}(过时|无用|错误)/, label: "对马克思主义的贬损表述" },
  { pattern: /(中国特色社会主义).{0,6}(背离|否定|脱离).{0,8}(马克思主义|社会主义)/, label: "方向性错误表述" },
];

/** 高危词命中检测 */
export function ruleScan(content: string): Array<{ label: string; matched: string }> {
  const hits: Array<{ label: string; matched: string }> = [];
  for (const r of HIGH_RISK_RULES) {
    const m = content.match(r.pattern);
    if (m) hits.push({ label: r.label, matched: m[0].slice(0, 40) });
  }
  return hits;
}

// ═══ 四维核验 ═══
export async function auditContent(input: {
  content: string;
  level?: "low" | "medium" | "high";   // 审核分级，默认 medium
  context?: string;                    // 场景上下文（辅导/备课/诊断/陪伴）
}): Promise<Record<string, unknown>> {
  const content = String(input.content || "").slice(0, 4000);
  const level = input.level || "medium";
  const context = input.context || "教育输出";

  // ① 规则通道
  const ruleHits = ruleScan(content);

  // ② 权威校准：检索 Compiled Truth 知识页（马理论权威源）
  const truthPages = await searchCompiledTruth({ query: content.slice(0, 60), limit: 3 });

  // ③ LLM Judge 四维核验
  const judge = await llmJson(`你是马理论/思政内容审核专家。审核以下${context}，逐维核验：

【内容】${content}
${ruleHits.length > 0 ? `【规则预警】命中高危表述:\n${ruleHits.map((h) => `- ${h.label}: ${h.matched}`).join("\n")}` : ""}
${truthPages.length > 0 ? `【权威知识页（Compiled Truth）对照】\n${truthPages.map((p) => `[${p.title}] ${p.compiledTruth.slice(0, 300)}`).join("\n")}` : "【权威知识页】未命中，注意核查引用来源"}

逐维输出 JSON: {
  "ideology": {"pass": true|false, "issues": ["与马理论基本原理/党的创新理论表述不一致处"], "quoteCheck": "是否错误引用经典作家观点"},
  "accuracy": {"pass": true|false, "issues": ["术语/历史事件/专有名词表述不准确处"]},
  "citation": {"pass": true|false, "issues": ["引用真实性存疑处（版本/出处）"]},
  "boundary": {"pass": true|false, "issues": ["需提示边界/置信度/人工核实的点"]},
  "overall": "pass|review|fail",
  "recommendation": "改进建议（具体可执行）",
  "confidence": 0~1
}`);

  const ideo = judge?.ideology || {};
  const acc = judge?.accuracy || {};
  const cite = judge?.citation || {};
  const bound = judge?.boundary || {};

  // ④ 分级处置（citation 维度：无引用仅提示不判违规——辅导输出不强制每句带出处）
  const citationPass = cite.pass !== false;
  const boundaryPass = bound.pass !== false;
  const noCitationIssue = (cite.issues || []).length === 0 || String(cite.issues[0]).includes("未提供具体引用");
  const dimensions = {
    ideology: ideo.pass !== false,
    accuracy: acc.pass !== false,
    citation: citationPass || noCitationIssue,   // 无引用 → 提示级，不算违规
    boundary: boundaryPass,
  };
  let overall = judge?.overall || (ruleHits.length > 0 ? "review" : "pass");
  if (overall !== "fail" && !(dimensions.ideology && dimensions.accuracy)) {
    overall = "fail";   // 意识形态/表述不准确 → 必拦截
  }
  if (overall === "review" && ruleHits.length === 0 && dimensions.ideology && dimensions.accuracy && dimensions.citation) {
    overall = "pass";   // 仅边界/引用提示 → 降级为通过（提示不拦截）
  }
  const pass = overall === "pass";

  // ⑤ 分级处置
  let action: string;
  if (overall === "fail" || level === "high") {
    action = overall === "fail" ? "拦截：需人工确认后交付" : "核验 + 人工确认提示";
  } else if (overall === "review") {
    action = "核验 + 置信度标注，提示人工核实";
  } else {
    action = "自动核验通过";
  }

  return {
    ok: true,
    overall,
    pass,
    dimensions,
    issues: {
      ideology: ideo.issues || [],
      accuracy: acc.issues || [],
      citation: cite.issues || [],
      boundary: bound.issues || [],
    },
    ruleHits,
    truthPages: truthPages.map((p) => p.title),
    action,
    level,
    confidence: judge?.confidence ?? 0.5,
    recommendation: judge?.recommendation || "",
  };
}

// ═══ 权威校准（轻量版）：对照 Compiled Truth 校验单一概念 ═══
export async function calibrateConcept(input: { concept: string; claim?: string }): Promise<Record<string, unknown>> {
  const pages = await searchCompiledTruth({ query: input.concept, limit: 2 });
  if (pages.length === 0) {
    return { ok: true, concept: input.concept, calibrated: false, note: "未命中权威知识页，建议人工核实" };
  }
  const truth = pages[0];
  const judge = await llmJson(`对照权威来源校验表述一致性：
【概念】${input.concept}
【权威来源】[${truth.title}] ${truth.compiledTruth.slice(0, 500)}
${input.claim ? `【待校验表述】${input.claim}` : "（仅提取权威定义）"}

输出 JSON: {
  "consistent": true|false,
  "authoritativeDefinition": "权威定义（提炼）",
  "discrepancy": "表述不一致处（如有）"
}`);
  return {
    ok: true,
    concept: input.concept,
    calibrated: true,
    source: truth.title,
    consistent: judge?.consistent !== false,
    authoritativeDefinition: judge?.authoritativeDefinition || truth.compiledTruth.slice(0, 200),
    discrepancy: judge?.discrepancy || "",
  };
}

export const contentAuditService = { auditContent, calibrateConcept, ruleScan };
