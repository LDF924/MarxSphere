// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// review-fence.ts — fenced-JSON 审查协议(移植自 ai4s-research/open-science, MIT)
// 机制: agent/服务在消息末尾输出恰好一个 ```review fenced JSON block,
// 前端 splitReviewFence 解析后从正文剥除、渲染为可折叠 ReviewerCard。
// 底层 review 文本仍在对话中, 不丢审计。详见 docs/OPEN-SCIENCE-GAP-ANALYSIS.md。
export type FindingLevel = "ok" | "warn" | "error";
export type ReviewCheck = "citation" | "number" | "figure" | "domain" | "integrity" | "format";

export interface ReviewFinding {
  level: FindingLevel;
  title: string;
  evidence?: string;
  check?: ReviewCheck;
  tag?: string;
}

export interface ReviewerBlock {
  kind: "reviewer";
  findings: ReviewFinding[];
  note?: string;
}

const FENCE = /```review\s*\n([\s\S]*?)\n```/;
const LEVELS: FindingLevel[] = ["ok", "warn", "error"];
const CHECKS: ReviewCheck[] = ["citation", "number", "figure", "domain", "integrity", "format"];

/**
 * 提取 agent 被要求以 ```review fenced JSON 输出的结构化审查结果。
 * 返回: 去掉 fence 的 markdown + 解析出的 block; 无/畸形时 review=null(原文保留)。
 */
export function splitReviewFence(markdown: string): { clean: string; review: ReviewerBlock | null } {
  const m = FENCE.exec(markdown);
  if (!m) return { clean: markdown, review: null };
  let review: ReviewerBlock | null = null;
  try {
    const parsed = JSON.parse(m[1]) as {
      findings?: Array<{
        level?: string;
        title?: string;
        evidence?: string;
        check?: string;
        tag?: string;
      }>;
      note?: string;
    };
    const findings = (parsed.findings ?? [])
      .filter((f) => f.title)
      .map((f) => ({
        level: (LEVELS as string[]).includes(f.level ?? "") ? (f.level as FindingLevel) : "warn",
        title: String(f.title),
        evidence: f.evidence ? String(f.evidence) : undefined,
        check: (CHECKS as string[]).includes(f.check ?? "") ? (f.check as ReviewCheck) : undefined,
        tag: f.tag ? String(f.tag) : undefined,
      }));
    if (findings.length > 0 || parsed.note) {
      review = { kind: "reviewer", findings, note: parsed.note };
    }
  } catch {
    return { clean: markdown, review: null }; // malformed JSON: leave the text as-is
  }
  const clean = review ? markdown.replace(FENCE, "").trim() : markdown;
  return { clean, review };
}

/** 构造一个 review fence 文本(供 agent 提示词/服务输出时使用) */
export function buildReviewFence(block: ReviewerBlock): string {
  return "```review\n" + JSON.stringify({ findings: block.findings, note: block.note }, null, 2) + "\n```";
}
