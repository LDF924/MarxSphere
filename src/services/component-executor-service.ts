// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// component-executor-service.ts — 组件执行器(V394, 2026-08-30, 对照 TraitTutor executors)
// 蓝图: Lesson / assessment / retrieval executors 生成组件内容, 产物经三态机确认后挂载
//   1. lesson 执行器: concept_explanation/worked_example/visual_map → 课文/例题/图解(知识库支撑)
//   2. assessment 执行器: guided_practice/transfer_challenge → 题目(答案服务端持有) + 接 grade_answer 判分
//   3. retrieval 执行器: retrieval_card/review_queue → 回忆卡(front/back 分离, back 服务端持有)
// 产物 → generation_reviews(needs_review 三态) → confirm → 挂载到计划 artifacts
import { llmJson, retrieveChunks, DEFAULT_SOURCE } from "./education-service.js";
import { gradeAnswer } from "./learning-evidence-service.js";

// ═══ Lesson 执行器: 概念讲解/分步例题(知识库支撑) ═══
export async function generateLesson(input: {
  subject: string; knowledgePoint: string; goal?: string;
  kind: "concept_explanation" | "worked_example" | "goal_map" | "visual_map";
  sourceId?: string;
}): Promise<Record<string, unknown>> {
  const chunks = await retrieveChunks(input.knowledgePoint, input.sourceId || DEFAULT_SOURCE, 6).catch(() => []);
  const ctx = chunks.length > 0
    ? `\n\n【系统知识库相关文献】\n${chunks.slice(0, 4).map((c: any) => `[${c.title}] ${String(c.content || "").slice(0, 200)}`).join("\n")}`
    : "";
  const kindLabel: Record<string, string> = {
    concept_explanation: "概念讲解", worked_example: "分步例题", goal_map: "目标地图", visual_map: "概念关系图",
  };
  const prompt = `你是学习内容生成器。为「${input.knowledgePoint}」(${input.subject}) 生成${kindLabel[input.kind]}。
要求:
1. 内容基于系统知识库(引用来源), 不编造
2. 概念讲解: 200-400字, 分点; 分步例题: 3-5 步带每步说明; 目标地图: 里程碑+完成标准; 关系图: nodes+edges 结构(3-8 个概念节点, 节点含 id/label, 边含 from/to/relation)
3. 输出 JSON: {"title":"","content":"正文(分点/步骤)","key_points":["要点"],"references":[{"source":"来源文献","note":"依据"}],${input.kind === "visual_map" ? '"nodes":[{"id":"","label":""}],"edges":[{"from":"","to":"","relation":""}]' : ""}}
${ctx}`;
  const out = await llmJson(prompt);
  // V397: visual_map 生成 SVG 关系图(节点+连线, 前端直接渲染)
  let svg = "";
  if (input.kind === "visual_map" && Array.isArray(out?.nodes) && out.nodes.length > 0) {
    svg = buildRelationSvg(out.nodes, out.edges || [], out.title || input.knowledgePoint);
  }
  return {
    ok: true,
    component: {
      kind: input.kind, title: out?.title || `${kindLabel[input.kind]}: ${input.knowledgePoint}`,
      content: out?.content || "", key_points: out?.key_points || [],
      references: out?.references || [], concept_refs: [input.knowledgePoint],
      ...(svg ? { svg } : {}),
    },
  };
}

/** V397: 概念关系图 SVG 渲染(节点圆形 + 连线, 深色主题配色) */
export function buildRelationSvg(nodes: Array<{ id?: string; label?: string }>, edges: Array<{ from?: string; to?: string; relation?: string }>, title: string): string {
  const W = 560, H = 380;
  const positions = nodes.slice(0, 8).map((_, i) => {
    const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
    return { x: W / 2 + Math.cos(angle) * 170, y: H / 2 + Math.sin(angle) * 130 };
  });
  const color = (i: number) => ["#60a5fa", "#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#22d3ee", "#fb7185", "#4ade80"][i % 8];
  const lines = edges.slice(0, 12).map((e, i) => {
    const from = nodes.findIndex((n) => n.id === e.from || n.label === e.from);
    const to = nodes.findIndex((n) => n.id === e.to || n.label === e.to);
    if (from < 0 || to < 0 || from === to) return "";
    const p1 = positions[from], p2 = positions[to];
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    return `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#475569" stroke-width="1.5"/>
      <text x="${mx + 6}" y="${my - 6}" font-size="9" fill="#94a3b8">${String(e.relation || "")}</text>`;
  }).join("\n  ");
  const circles = nodes.slice(0, 8).map((n, i) => {
    const p = positions[i];
    return `<circle cx="${p.x}" cy="${p.y}" r="34" fill="${color(i)}22" stroke="${color(i)}" stroke-width="2"/>
      <text x="${p.x}" y="${p.y + 3}" text-anchor="middle" font-size="10" fill="#e2e8f0" font-weight="600">${String(n.label || n.id || "").slice(0, 8)}</text>`;
  }).join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="auto" style="background:#0f172a;border-radius:8px">
  <text x="16" y="22" font-size="12" fill="#fbbf24" font-weight="bold">${title}</text>
  ${lines}
  ${circles}
</svg>`;
}

// ═══ Assessment 执行器: 题目生成(答案服务端持有) ═══
// 完整答案(含 correct_answer)只存服务端内存(临时), 前端只拿剥键副本 + assessmentId
const assessmentStore = new Map<string, { items: any[]; expiresAt: number }>();
const ASSESSMENT_TTL = 30 * 60_000;  // 30 分钟

function genId(): string { return `asmt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

export async function generateAssessment(input: {
  subject: string; knowledgePoint: string;
  kind: "guided_practice" | "transfer_challenge" | "diagnostic_check";
  sourceId?: string;
}): Promise<Record<string, unknown>> {
  const chunks = await retrieveChunks(input.knowledgePoint, input.sourceId || DEFAULT_SOURCE, 4).catch(() => []);
  const ctx = chunks.length > 0
    ? `\n\n【知识库参考】\n${chunks.slice(0, 3).map((c: any) => `[${c.title}] ${String(c.content || "").slice(0, 150)}`).join("\n")}`
    : "";
  const isTransfer = input.kind === "transfer_challenge";
  const prompt = `你是出题引擎。为「${input.knowledgePoint}」(${input.subject}) 生成 ${isTransfer ? "迁移应用题(新情境检验灵活运用)" : "引导练习"} 3 题。
要求:
1. 覆盖: 1 选择 + 1 简答 + 1 开放
2. 每题: question / question_type(choice|short|open) / 选择题含 4 options(含 correct 标记) / correct_answer / explanation(≤150字)
3. 答案只存服务端, 绝不进入前端展示
输出 JSON: {"items":[{"question":"","question_type":"choice|short|open","options":[{"text":"","is_correct":false}],"correct_answer":"","explanation":""}]}
${ctx}`;
  const out = await llmJson(prompt);
  const items = (out?.items || []).slice(0, 3).map((it: any, i: number) => ({
    question_id: i + 1, question: it.question, question_type: it.question_type || "short",
    options: it.options || [], correct_answer: it.correct_answer || "", explanation: it.explanation || "",
  }));
  // 完整产物存服务端(答案服务端持有); 前端只拿剥键副本
  const id = genId();
  assessmentStore.set(id, { items, expiresAt: Date.now() + ASSESSMENT_TTL });
  // 清理过期
  for (const [k, v] of assessmentStore) if (v.expiresAt < Date.now()) assessmentStore.delete(k);
  return {
    ok: true,
    assessmentId: id,
    component: {
      kind: input.kind, title: isTransfer ? `迁移挑战: ${input.knowledgePoint}` : `引导练习: ${input.knowledgePoint}`,
      items: items.map((it: any) => ({
        question_id: it.question_id, question: it.question, question_type: it.question_type,
        options: (it.options || []).map((o: any) => ({ text: o.text })),
      })),
      concept_refs: [input.knowledgePoint],
    },
  };
}

// ═══ Assessment 执行器: 判分(按 assessmentId 查服务端完整产物, 答案不出服务端) ═══
export function gradeAssessmentItem(input: {
  assessmentId: string; questionId: number; userAnswer: string;
}): { correct: boolean; method: string } {
  const stored = assessmentStore.get(input.assessmentId);
  if (!stored) return { correct: false, method: "expired" };
  const item = stored.items.find((it) => it.question_id === input.questionId);
  if (!item) return { correct: false, method: "not-found" };
  // 选择题: 匹配选项文本 → 用 is_correct
  if (item.question_type === "choice" && item.options?.length) {
    const opt = item.options.find((o: any) => String(o.text).trim().toLowerCase() === input.userAnswer.trim().toLowerCase());
    if (opt) return { correct: !!opt.is_correct, method: "option" };
  }
  return gradeAnswer({ userAnswer: input.userAnswer, expectedAnswer: item.correct_answer || "", questionType: item.question_type || "short" });
}

// ═══ Retrieval 执行器: 回忆卡(front/back 分离) ═══
export async function generateRetrievalCards(input: {
  subject: string; knowledgePoint: string; count?: number; sourceId?: string;
}): Promise<Record<string, unknown>> {
  const chunks = await retrieveChunks(input.knowledgePoint, input.sourceId || DEFAULT_SOURCE, 4).catch(() => []);
  const ctx = chunks.length > 0
    ? `\n\n【知识库参考】\n${chunks.slice(0, 3).map((c: any) => `[${c.title}] ${String(c.content || "").slice(0, 150)}`).join("\n")}`
    : "";
  const prompt = `你是闪卡生成器。为「${input.knowledgePoint}」(${input.subject}) 生成 ${input.count || 4} 张回忆卡。
要求:
1. front: 单一回忆目标(一个问题), ≤80字; back: 答案, ≤200字
2. 每卡 1-2 个参考文献引用
输出 JSON: {"cards":[{"front":"","back":"","references":[{"source":"","quote":""}]}]}
${ctx}`;
  const out = await llmJson(prompt);
  return {
    ok: true,
    component: {
      kind: "retrieval_card", title: `主动回忆: ${input.knowledgePoint}`,
      cards: (out?.cards || []).slice(0, input.count || 4).map((c: any, i: number) => ({
        card_id: i + 1, front: c.front || "", back: c.back || "", references: c.references || [],
      })),
      concept_refs: [input.knowledgePoint],
    },
  };
}

// ═══ 产物→三态机接线(V394: 生成的工件执行计划, 经 needs_review 确认后挂载) ═══
import type { ArtifactKind } from "./material-review-service.js";

export async function submitToReview(input: {
  studentId?: string; subject: string; goal: string;
  kind: ArtifactKind; content: unknown;
  issues?: Array<{ dimension: string; score: number; note?: string }>;
  planId?: string;
}): Promise<Record<string, unknown>> {
  const { materialReviewService } = await import("./material-review-service.js");
  return materialReviewService.createGeneration(input as any);
}

// ═══ V395: 深水区② — 批量生成工作流(一次调用为计划全部组件生成内容) ═══
// 顺序: lesson 组件 → assessment 组件 → retrieval 组件; 每类可并发生成, 失败降级跳过
// 产物统一经 submitToReview 进三态机(可审查, 确认后挂载)
export async function generatePlanComponents(input: {
  studentId?: string; subject: string; goal: string;
  components: Array<{ type: string; knowledgePoint?: string }>;
  sourceId?: string;
}): Promise<Record<string, unknown>> {
  const results: Array<{ type: string; ok: boolean; kind?: string; error?: string; generationId?: string; status?: string }> = [];
  let generated = 0, failed = 0;

  for (const comp of input.components.slice(0, 20)) {
    const kp = comp.knowledgePoint || input.goal;
    try {
      let out: Record<string, unknown> = { ok: false, error: "unknown" };
      const kind: ArtifactKind = "courseware";
      // lesson 类
      if (["goal_map", "concept_explanation", "worked_example", "visual_map"].includes(comp.type)) {
        out = await generateLesson({ subject: input.subject, knowledgePoint: kp, goal: input.goal, kind: comp.type as any, sourceId: input.sourceId });
      } else if (["guided_practice", "transfer_challenge", "diagnostic_check"].includes(comp.type)) {
        out = await generateAssessment({ subject: input.subject, knowledgePoint: kp, kind: comp.type as any, sourceId: input.sourceId });
      } else if (["retrieval_card", "review_queue"].includes(comp.type)) {
        out = await generateRetrievalCards({ subject: input.subject, knowledgePoint: kp, count: 4, sourceId: input.sourceId });
      } else {
        results.push({ type: comp.type, ok: false, error: "不支持的组件类型" });
        failed++;
        continue;
      }
      if (!out.ok || !out.component) {
        results.push({ type: comp.type, ok: false, error: String(out.error || "生成失败") });
        failed++;
        continue;
      }
      // 产物进三态机(默认无 issues → 直接 confirmed, 可审查)
      const sub = await submitToReview({
        studentId: input.studentId, subject: input.subject, goal: `${input.goal} · ${kp}`,
        kind: comp.type.includes("practice") || comp.type.includes("challenge") || comp.type.includes("diagnostic") ? "quiz" : "courseware",
        content: out.component,
      });
      results.push({
        type: comp.type, ok: true,
        kind: comp.type, generationId: String(sub.generationId || ""),
        status: String(sub.status || "confirmed"),
      });
      generated++;
    } catch (e: any) {
      results.push({ type: comp.type, ok: false, error: String(e?.message || e).slice(0, 100) });
      failed++;
    }
  }

  return {
    ok: true,
    summary: { total: results.length, generated, failed, reviewCount: results.filter((r) => r.status === "needs_review").length },
    results,
  };
}

export const componentExecutorService = { generateLesson, generateAssessment, gradeAssessmentItem, generateRetrievalCards, submitToReview, generatePlanComponents };
