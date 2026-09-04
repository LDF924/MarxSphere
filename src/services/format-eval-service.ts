// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// format-eval-service.ts — 论文格式评测: 聚合服务 + LLM 审校层(2026-09-03)
// 双层检测: 规则引擎(纯函数, 确定性) + LLM 审校(软性项, 失败可降级)。
// 评分: score = 100 − 5×error − 2×warning − 0.5×info, 保留 1 位小数。
import { runRuleEngine, summarizeRules, type FormatIssue, type RuleStatusEntry } from "./format-eval-engine.js";
import { resolveTemplate, type FormatTemplate } from "./format-eval-templates.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";
import { getRoleModel } from "./llm-model-registry.js";

export interface FormatEvalResult {
  ok: true;
  templateUsed: FormatTemplate;
  stats: {
    score: number;
    totalRules: number;   // 规则清单总数(含通过项)
    passed: number;       // 通过项数
    errors: number;
    warnings: number;
    infos: number;
    byCategory: Record<string, number>;
  };
  ruleFindings: FormatIssue[];
  ruleStatuses: RuleStatusEntry[];  // 完整规则清单(逐条状态)
  llmFindings: FormatIssue[];
  llmStatus: "ok" | "skipped" | "failed";
  humanCheckNotes: string[];
}

/** 文本采样: ≤8000 字全量; 更长时取 摘要+各章首段+结论 混合样本 */
function sampleText(text: string, maxLen = 8000): string {
  if (text.length <= maxLen) return text;
  const lines = text.split("\n");
  const head = lines.slice(0, Math.floor(lines.length * 0.15)).join("\n"); // 摘要/引言区
  const tail = lines.slice(Math.max(0, lines.length - Math.floor(lines.length * 0.2))).join("\n"); // 结论/参考文献前区
  const sample = (head + "\n…[中段省略]…\n" + tail).slice(0, maxLen);
  return sample;
}

async function llmJson(prompt: string, modelOverride?: string, maxTokens = 3000): Promise<any | null> {
  const ep = getLlmEndpoint({ model: modelOverride || getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url,
    key: ep.key,
    model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON，不要其他文字。" }],
    temperature: 0.2,
    maxTokens,
    timeoutMs: 180_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}

const LLM_CATEGORIES = ["标题层级", "摘要", "关键词", "章节结构", "文本规范", "其他"];

/** LLM 审校层: 规则引擎查不出的软性项; 失败返回 null(调用方降级) */
async function runLlmReview(
  text: string,
  tpl: FormatTemplate,
  model?: string,
): Promise<FormatIssue[] | null> {
  const sample = sampleText(text);
  const sections = tpl.requiredSections.join("、");
  const aliases = Object.entries(tpl.sectionAliases ?? {})
    .map(([k, v]) => `${k}(${v.join("/")})`).join("; ");
  const prompt = `你是高校学位论文格式审校专家。对以下论文文本做软性格式审校(规则引擎已查过硬性项, 请勿重复报硬性问题):

审校要点:
1. 摘要四要素(研究目的/方法/结果/结论)是否齐全
2. 术语一致性: 同一概念是否前后用词不一(如 乡村振兴/农村振兴 混用)
3. 标题措辞规范: 模板要求的章节名(模板必含: ${sections}; 章节别名: ${aliases || "无"})
   之外是否用了生造/口语化标题
4. 图表编号与正文引用一致性、明显的内容归属错位(章节内容放错章)
5. 关键词与摘要主题是否明显不符

只输出确有问题的项(少于 5 条), 没有则输出空数组。
输出 JSON: {"findings":[{"category":"标题层级|摘要|关键词|章节结构|文本规范|其他","severity":"error|warning|info","message":"问题描述(≤80字)","suggestion":"修改建议(≤60字)"}]}

论文文本(采样):
${sample}`;
  try {
    const answer = await llmJson(prompt, model);
    const findings = Array.isArray(answer?.findings) ? answer.findings : [];
    return findings
      .filter((f: any) => f && typeof f.message === "string" && f.message.trim().length > 0)
      .slice(0, 8)
      .map((f: any) => ({
        ruleId: "llm-review",
        category: (LLM_CATEGORIES.includes(f?.category) ? f.category : "其他") as FormatIssue["category"],
        severity: (f?.severity === "error" || f?.severity === "warning") ? f.severity : "info",
        message: String(f.message).slice(0, 120),
        paragraph: 0,
        snippet: "",
        suggestion: typeof f?.suggestion === "string" ? f.suggestion.slice(0, 100) : "",
      }));
  } catch {
    return null; // LLM 失败降级, 不阻塞规则结果
  }
}

function computeStats(findings: FormatIssue[], statuses: RuleStatusEntry[]) {
  const byCategory: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  let passed = 0;
  for (const s of statuses) {
    if (s.status === "pass") { passed += 1; continue; }
    if (s.status === "error") { errors += 1; byCategory[s.category] = (byCategory[s.category] ?? 0) + 1; }
    else if (s.status === "warning") { warnings += 1; byCategory[s.category] = (byCategory[s.category] ?? 0) + 1; }
    else { infos += 1; byCategory[s.category] = (byCategory[s.category] ?? 0) + 1; }
  }
  const score = Math.max(0, Math.min(100, Math.round((100 - errors * 5 - warnings * 2 - infos * 0.5) * 10) / 10));
  return { score, errors, warnings, infos, passed, byCategory, totalRules: statuses.length };
}

export async function runFormatEval(input: {
  text: string;
  templateId?: string;
  template?: Partial<FormatTemplate>;
  llm?: boolean;
  model?: string;
}): Promise<FormatEvalResult> {
  const templateUsed = resolveTemplate(input.templateId, input.template);
  const ruleFindings = runRuleEngine(input.text, templateUsed);
  const wantLlm = input.llm !== false;

  let llmFindings: FormatIssue[] = [];
  let llmStatus: FormatEvalResult["llmStatus"] = "skipped";
  if (wantLlm) {
    const reviewed = await runLlmReview(input.text, templateUsed, input.model);
    if (reviewed) {
      llmFindings = reviewed;
      llmStatus = "ok";
    } else {
      llmStatus = "failed";
    }
  }

  const combined = [...ruleFindings, ...llmFindings];
  const ruleStatuses = summarizeRules(ruleFindings);
  return {
    ok: true,
    templateUsed,
    stats: computeStats(combined, ruleStatuses),
    ruleFindings,
    ruleStatuses,
    llmFindings,
    llmStatus,
    humanCheckNotes: templateUsed.humanCheckNotes,
  };
}

export const formatEvalService = { runFormatEval };
