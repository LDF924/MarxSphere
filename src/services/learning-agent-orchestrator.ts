// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// learning-agent-orchestrator.ts — 学习多 Agent 协作(V397, 2026-08-30, 借鉴 LingxiLearn "多个专业 Agent 基于 Skill 动态组合")
// 三 Agent 分工: 讲解Agent(content.lesson) → 出题Agent(assess.generate) → 反馈Agent(assess.grade)
// 共享上下文: 知识点 + BKT 画像 + 已生成产物(前一 Agent 输出作为后一 Agent 输入)
// 任一 Agent 失败 → 降级(跳过该环节不阻塞整体)
import { llmJson, retrieveChunks, DEFAULT_SOURCE } from "./education-service.js";
import { gradeAnswer } from "./learning-evidence-service.js";
import { buildRelationSvg } from "./component-executor-service.js";

export interface LearningAgentResult {
  role: string;          // explainer | quizzer | feedback
  capability: string;    // content.lesson | assess.generate | assess.grade
  ok: boolean;
  output: any;
  error?: string;
}

/**
 * 学习多 Agent 编排: 讲解 → 出题 → 反馈(共享上下文链式传递)
 * 借鉴 LingxiLearn: 多个专业 Agent 基于 Skill 动态组合, 完成讲解、练习、分析与反馈
 */
export async function orchestrateLearningAgents(input: {
  studentId?: string; subject: string; knowledgePoint: string;
  userAnswer?: string; sourceId?: string;
}): Promise<Record<string, unknown>> {
  const { subject, knowledgePoint, sourceId } = input;
  const chunks = await retrieveChunks(knowledgePoint, sourceId || DEFAULT_SOURCE, 6).catch(() => []);
  const ctx = chunks.length > 0
    ? `\n\n【知识库参考】\n${chunks.slice(0, 4).map((c: any) => `[${c.title}] ${String(c.content || "").slice(0, 200)}`).join("\n")}`
    : "";

  // ── Agent 1: 讲解(Content.lesson) ──
  let explainer: LearningAgentResult = { role: "explainer", capability: "content.lesson", ok: false, output: {} };
  try {
    const prompt = `你是讲解专家。为「${knowledgePoint}」(${subject}) 生成简明概念讲解。
要求: 200-350字分点, 基于知识库, 输出 JSON: {"title":"","content":"","key_points":[""],"nodes":[{"id":"","label":""}],"edges":[{"from":"","to":"","relation":""}]}
${ctx}`;
    const out = await llmJson(prompt);
    explainer = {
      role: "explainer", capability: "content.lesson", ok: true,
      output: {
        title: out?.title || `讲解: ${knowledgePoint}`,
        content: out?.content || "", key_points: out?.key_points || [],
        svg: Array.isArray(out?.nodes) && out.nodes.length > 0 ? buildRelationSvg(out.nodes, out.edges || [], out.title || knowledgePoint) : undefined,
      },
    };
  } catch (e: any) { explainer.error = String(e?.message || e).slice(0, 80); }

  // ── Agent 2: 出题(Assess.generate) — 基于讲解产物 ──
  let quizzer: LearningAgentResult = { role: "quizzer", capability: "assess.generate", ok: false, output: {} };
  try {
    const prompt = `你是出题专家。基于以下讲解内容为「${knowledgePoint}」出 2 题(1 选择 + 1 简答):
${String(explainer.output.content || "").slice(0, 800)}
输出 JSON: {"items":[{"question":"","question_type":"choice|short","options":[{"text":""}],"correct_answer":"","explanation":""}]}`;
    const out = await llmJson(prompt);
    quizzer = {
      role: "quizzer", capability: "assess.generate", ok: true,
      output: { items: (out?.items || []).slice(0, 2).map((it: any, i: number) => ({ question_id: i + 1, question: it.question, question_type: it.question_type || "short", options: it.options || [], correct_answer: it.correct_answer || "", explanation: it.explanation || "" })) },
    };
  } catch (e: any) { quizzer.error = String(e?.message || e).slice(0, 80); }

  // ── Agent 3: 反馈(Assess.grade) — 判分作答并给针对性反馈 ──
  let feedback: LearningAgentResult = { role: "feedback", capability: "assess.grade", ok: false, output: {} };
  const firstItem = quizzer.output?.items?.[0];
  if (input.userAnswer && firstItem) {
    try {
      const g = gradeAnswer({ userAnswer: input.userAnswer, expectedAnswer: String(firstItem.correct_answer || ""), questionType: firstItem.question_type || "short" });
      const prompt = `你是学习反馈专家。学生作答 ${g.correct ? "正确" : "错误"}: ${input.userAnswer}
标准答案: ${firstItem.correct_answer}
解析: ${firstItem.explanation || ""}
给 2-3 句针对性反馈(正确则肯定+提示拓展; 错误则指出差距+引导修复)。
输出 JSON: {"feedback":"","next_step":"建议下一步"}`;
      const out = await llmJson(prompt);
      feedback = {
        role: "feedback", capability: "assess.grade", ok: true,
        output: { correct: g.correct, method: g.method, feedback: out?.feedback || (g.correct ? "回答正确!" : "回答有误, 请重试。"), next_step: out?.next_step || (g.correct ? "可进入下一知识点" : "建议复习后重试") },
      };
    } catch (e: any) { feedback.error = String(e?.message || e).slice(0, 80); }
  } else {
    feedback.output = { note: "未提供作答, 跳过反馈环节" };
  }

  const agents = [explainer, quizzer, feedback];
  return {
    ok: true,
    knowledge_point: knowledgePoint,
    agents,
    summary: {
      total: agents.length,
      ok: agents.filter((a) => a.ok).length,
      degraded: agents.filter((a) => !a.ok).length,
    },
    // 便捷访问: 讲解/题目(剥答案键)/反馈
    lesson: explainer.ok ? explainer.output : null,
    quiz: quizzer.ok ? { ...quizzer.output, items: (quizzer.output.items || []).map((it: any) => ({ question_id: it.question_id, question: it.question, question_type: it.question_type, options: (it.options || []).map((o: any) => ({ text: o.text })) })) } : null,
    feedback: feedback.ok ? feedback.output : null,
  };
}

export const learningAgentOrchestrator = { orchestrateLearningAgents };
