// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// spaced-repetition-service.ts — 间隔重复复习队列(V391, 2026-08-30, 借鉴 TraitTutor learning/scheduler.py)
// 对照 TraitTutor:
//   1. 按知识类型间隔序列: MEMORY[0,1,3,7,14,30,60] / PROCEDURE[0,1,3,7,14] / CONCEPT[3,7,14,30] / DESIGN[7,14,30,60]
//   2. 档位推进: 答对连中 2 次跳 2 档; 答错退 1 档; 连错 2 次重置到起点
//   3. 错误未修复的知识点优先级最高(needs_repair)
// 迁移: 100_review_queue.sql
import { pool } from "../db/pool.js";
import { recordLearnerEvent } from "./learning-evidence-service.js";

/** 知识类型间隔序列(TraitTutor scheduler.INTERVAL_SEQUENCES) */
export const INTERVAL_SEQUENCES: Record<string, number[]> = {
  memory: [0, 1, 3, 7, 14, 30, 60],
  procedure: [0, 1, 3, 7, 14],
  concept: [3, 7, 14, 30],
  design: [7, 14, 30, 60],
};

/** 知识类型推断(与 learning-evidence-service 对齐) */
export function knowledgeTypeOf(point: string): "memory" | "procedure" | "concept" | "design" {
  const p = point.toLowerCase();
  if (/(记忆|背诵|定义|事实|人名|术语)/.test(p)) return "memory";
  if (/(步骤|流程|操作|procedure|语法|写法)/.test(p)) return "procedure";
  if (/(设计|方法|策略|体系|模型)/.test(p)) return "design";
  return "concept";
}

/**
 * 复习调度推进(纯函数, TraitTutor scheduler 语义)
 * @param correct 本次复习是否答对
 * @param intervalIdx 当前档位
 * @param consecutiveCorrect / consecutiveWrong 连续统计
 * @returns 新状态
 */
export function advanceReviewState(input: {
  correct: boolean;
  intervalIdx: number;
  consecutiveCorrect: number;
  consecutiveWrong: number;
  knowledgeType: string;
}): { intervalIdx: number; consecutiveCorrect: number; consecutiveWrong: number; dueInDays: number; needsRepair: boolean } {
  const seq = INTERVAL_SEQUENCES[input.knowledgeType] || INTERVAL_SEQUENCES.concept;
  let idx = Math.max(0, Math.min(seq.length - 1, input.intervalIdx));
  let cc = input.consecutiveCorrect;
  let cw = input.consecutiveWrong;

  if (input.correct) {
    cw = 0;
    cc += 1;
    if (cc >= 2) {
      // 连中 2 次跳 2 档
      idx = Math.min(seq.length - 1, idx + 2);
      cc = 0;
    }
  } else {
    cc = 0;
    cw += 1;
    if (cw >= 2) {
      // 连错 2 次重置
      idx = 0;
      cw = 0;
    } else {
      // 答错退 1 档
      idx = Math.max(0, idx - 1);
    }
  }
  const dueInDays = seq[idx];
  return { intervalIdx: idx, consecutiveCorrect: cc, consecutiveWrong: cw, dueInDays, needsRepair: !input.correct };
}

/** 注册知识点进复习队列(幂等) */
export async function enqueueReview(input: { studentId?: string; subject: string; knowledgePoint: string; knowledgeType?: string }): Promise<Record<string, unknown>> {
  const kt = input.knowledgeType || knowledgeTypeOf(input.knowledgePoint);
  await pool.query(
    `insert into review_queue (student_id, subject, knowledge_point, knowledge_type)
     values ($1, $2, $3, $4)
     on conflict (student_id, subject, knowledge_point) do nothing`,
    [input.studentId || "default", input.subject, input.knowledgePoint, kt]
  ).catch(() => {});
  return { ok: true };
}

/**
 * 记录一次复习结果(与事件账本联动: 有 expectedAnswer 则服务端判分, 强证据进 BKT)
 * 并推进间隔调度
 */
export async function recordReviewResult(input: {
  studentId?: string;
  subject: string;
  knowledgePoint: string;
  question: string;
  userAnswer?: string;
  expectedAnswer?: string;
  isCorrect?: boolean | null;
  questionType?: "choice" | "tf" | "short" | "open";
  /** V396: 提示级别(0=独立作答) — 强帮助(hint>=2)后答对记验证债务 */
  hintLevel?: number;
}): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  // 事件账本(强证据闸门)
  const ev = await recordLearnerEvent({
    studentId, subject: input.subject, knowledgePoint: input.knowledgePoint,
    question: input.question, userAnswer: input.userAnswer, expectedAnswer: input.expectedAnswer,
    isCorrect: input.isCorrect, questionType: input.questionType, surfaceType: "review",
  });
  const correct = ev.isCorrect === true;

  // 推进调度(V396: verification_debt 验证债务 — 借鉴 LingxiLearn)
  // 强帮助(hint_level>=2)后答对: 记债务不立即还; 独立正确(无提示)还债
  const hintLevel = input.hintLevel ?? 0;
  const cur = await pool.query(
    "select * from review_queue where student_id = $1 and subject = $2 and knowledge_point = $3",
    [studentId, input.subject, input.knowledgePoint]
  ).catch(() => ({ rows: [] }));

  // review_priority 单尺子(借鉴 LingxiLearn: 0.45×逾期 + 0.35×薄弱 + 0.20×不确定)
  const calcPriority = (dueAt: Date | null, wasCorrect: boolean, hasMisconception: boolean): number => {
    let p = 0;
    if (dueAt && new Date(dueAt).getTime() < Date.now()) {
      const daysLate = (Date.now() - new Date(dueAt).getTime()) / 86_400_000;
      p += 0.45 * Math.min(1, daysLate / 7);
    }
    if (!wasCorrect) p += 0.35;
    if (hasMisconception) p += 0.20;
    return Math.min(1, p);
  };

  let next: ReturnType<typeof advanceReviewState>;
  if (cur.rows.length === 0) {
    // 未入队: 从 0 档开始
    next = advanceReviewState({ correct, intervalIdx: 0, consecutiveCorrect: 0, consecutiveWrong: 0, knowledgeType: knowledgeTypeOf(input.knowledgePoint) });
    const debt = !correct || hintLevel >= 2;
    await pool.query(
      `insert into review_queue (student_id, subject, knowledge_point, knowledge_type, interval_idx, consecutive_correct, consecutive_wrong, due_at, last_result, needs_repair, verification_debt, debt_reason, review_priority)
       values ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' days')::interval, $9, $10, $11, $12, $13)`,
      [studentId, input.subject, input.knowledgePoint, knowledgeTypeOf(input.knowledgePoint),
       next.intervalIdx, next.consecutiveCorrect, next.consecutiveWrong, next.dueInDays, correct, next.needsRepair,
       debt, debt ? (hintLevel >= 2 ? "强帮助后需独立验证" : "答错需修复") : null,
       calcPriority(null, correct, debt)]
    ).catch(() => {});
  } else {
    const row = cur.rows[0];
    next = advanceReviewState({
      correct,
      intervalIdx: row.interval_idx,
      consecutiveCorrect: row.consecutive_correct,
      consecutiveWrong: row.consecutive_wrong,
      knowledgeType: row.knowledge_type || knowledgeTypeOf(input.knowledgePoint),
    });
    // 还债: 独立正确(无提示)且此前有债务 → 清除
    const debtCleared = correct && hintLevel === 0 && row.verification_debt;
    const debtStill = !correct || hintLevel >= 2;
    const priority = calcPriority(row.due_at, correct, debtStill);
    await pool.query(
      `update review_queue set interval_idx = $1, consecutive_correct = $2, consecutive_wrong = $3,
         due_at = now() + ($4 || ' days')::interval, last_result = $5, needs_repair = $6,
         verification_debt = $7, debt_reason = $8, review_priority = $9, updated_at = now()
       where student_id = $10 and subject = $11 and knowledge_point = $12`,
      [next.intervalIdx, next.consecutiveCorrect, next.consecutiveWrong, next.dueInDays, correct, next.needsRepair,
       debtCleared ? false : debtStill, debtCleared ? null : (debtStill ? (hintLevel >= 2 ? "强帮助后需独立验证" : "答错需修复") : null),
       priority, studentId, input.subject, input.knowledgePoint]
    ).catch(() => {});
  }

  return { ok: true, correct, ...next, dueInDays: next.dueInDays };
}

/** 到期复习队列(错误未修复+验证债务优先, 再按 review_priority 与到期时间) */
export async function dueReviews(input: { studentId?: string; subject?: string; limit?: number }): Promise<Record<string, unknown>> {
  const params: unknown[] = [input.studentId || "default"];
  let where = "student_id = $1 and due_at <= now()";
  if (input.subject) { params.push(input.subject); where += " and subject = $" + params.length; }
  const r = await pool.query(
    `select * from review_queue where ${where}
     order by needs_repair desc, verification_debt desc, review_priority desc, due_at asc limit $${params.length + 1}`,
    [...params, input.limit || 10]
  ).catch(() => ({ rows: [] }));
  return { ok: true, reviews: r.rows };
}

export const spacedRepetitionService = { enqueueReview, recordReviewResult, dueReviews, advanceReviewState, INTERVAL_SEQUENCES };
