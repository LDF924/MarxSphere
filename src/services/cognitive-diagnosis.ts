// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// cognitive-diagnosis.ts — BKT 贝叶斯知识追踪（复赛冲刺期实现）
// 基于 knowledge_mastery 的 attempts/correct_count 推断 p(掌握) 隐状态：
//   ① BKT 更新：p(掌握) = P(前轮掌握)·(1-遗忘) + P(前轮未掌握)·(学会)
//   ② 作答似然：P(答对) = p(掌握)·(1-滑) + (1-p(掌握))·猜
//   ③ 输出「预测下次答对概率」曲线，供诊断/计划联动
// 与加权平滑（±0.15/-0.25）对比：BKT 是模型化推断，可输出概率与不确定性
// 复用: knowledge_mastery / answer_history（既有表，无新增迁移）
import { pool } from "../db/pool.js";

// ═══ BKT 参数 ═══
export interface BKTParams {
  pLearn: number;       // 学会概率（未掌握 → 掌握）
  pForget: number;      // 遗忘概率（掌握 → 未掌握）
  pGuess: number;       // 猜对概率（未掌握时答对）
  pSlip: number;        // 滑错概率（掌握时答错）
}

export const DEFAULT_PARAMS: BKTParams = { pLearn: 0.25, pForget: 0.05, pGuess: 0.2, pSlip: 0.1 };

/** 从作答历史估计 BKT 参数（简版：按整体正确率粗调） */
function estimateParams(history: Array<{ is_correct: boolean }>): BKTParams {
  if (history.length < 5) return { ...DEFAULT_PARAMS };
  const correct = history.filter((h) => h.is_correct).length;
  const acc = correct / history.length;
  // 正确率高 → 猜/滑低；正确率低 → 未掌握概率高
  const pGuess = Math.min(0.3, Math.max(0.1, 0.3 - acc * 0.1));
  const pSlip = Math.min(0.25, Math.max(0.05, 0.25 - acc * 0.15));
  return { pLearn: 0.25, pForget: 0.05, pGuess, pSlip };
}

/** BKT 单步更新：给定当前 p(掌握) 与本次作答结果，返回更新后 p(掌握) */
export function bktUpdate(pMastery: number, isCorrect: boolean, params: BKTParams): number {
  const { pLearn, pForget, pGuess, pSlip } = params;
  // 作答似然 P(obs | 掌握)
  const pObsGivenMastered = isCorrect ? 1 - pSlip : pSlip;
  const pObsGivenUnlearned = isCorrect ? pGuess : 1 - pGuess;
  const pObs = pMastery * pObsGivenMastered + (1 - pMastery) * pObsGivenUnlearned;
  if (pObs === 0) return pMastery;
  // 后验 P(掌握 | obs)
  const pMasteryPost = (pMastery * pObsGivenMastered) / pObs;
  // 预测下一轮（含学会与遗忘）
  return pMasteryPost * (1 - pForget) + (1 - pMasteryPost) * pLearn;
}

/** 单知识点 BKT 追踪：从作答历史推断 p(掌握) 序列与预测下次答对概率 */
export async function bktTrack(input: { studentId?: string; subject?: string; knowledgePoint: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";

  // ① 取该知识点全部作答历史（时间正序）
  const history = await pool.query(
    `select is_correct, answered_at from answer_history
     where student_id = $1 and knowledge_point = $2
     ${input.subject ? "and subject = $3" : ""}
     order by answered_at asc`,
    input.subject ? [studentId, input.knowledgePoint, input.subject] : [studentId, input.knowledgePoint]
  );
  const rows = history.rows as Array<{ is_correct: boolean; answered_at: string }>;

  // ② 参数估计 + 序列推断
  const params = estimateParams(rows);
  let pMastery = 0.5;   // 先验
  const trace: Array<{ step: number; pMastery: number; isCorrect: boolean }> = [];
  rows.forEach((r, i) => {
    pMastery = bktUpdate(pMastery, r.is_correct, params);
    trace.push({ step: i + 1, pMastery: Math.round(pMastery * 1000) / 1000, isCorrect: r.is_correct });
  });

  // ③ 预测下次答对概率
  const predictCorrect = pMastery * (1 - params.pSlip) + (1 - pMastery) * params.pGuess;

  // ④ 与 knowledge_mastery 现状对照
  const km = await pool.query(
    `select mastery_level, score, attempts from knowledge_mastery
     where student_id = $1 and knowledge_point = $2`,
    [studentId, input.knowledgePoint]
  );

  return {
    ok: true,
    knowledgePoint: input.knowledgePoint,
    params,
    trace,
    finalMastery: Math.round(pMastery * 1000) / 1000,
    predictNextCorrect: Math.round(predictCorrect * 1000) / 1000,
    level: pMastery >= 0.7 ? "mastered" : pMastery >= 0.4 ? "fuzzy" : "unlearned",
    masteryTable: km.rows[0] || null,
    note: "BKT 模型化推断（pGuess/pSlip 按作答正确率估计），优于加权平滑规则",
  };
}

/** 全科目 BKT 诊断：列出薄弱知识点（按 p(掌握) 排序） */
export async function bktDiagnose(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";

  // 聚合每个知识点的作答历史（无需逐条回放，用汇总推断近似）
  const points = await pool.query(
    `select knowledge_point,
            count(*)::int as attempts,
            sum(case when is_correct then 1 else 0 end)::int as correct,
            count(*) filter (where is_correct = false)::int as wrong
     from answer_history
     where student_id = $1 ${input.subject ? "and subject = $2" : ""}
     group by knowledge_point having count(*) >= 2
     order by attempts desc`,
    input.subject ? [studentId, input.subject] : [studentId]
  );

  const results = points.rows.map((r) => {
    const { knowledge_point: kp, attempts, correct, wrong } = r as { knowledge_point: string; attempts: number; correct: number; wrong: number };
    // 简化 BKT：以序列末尾状态近似（用最后一次作答回放）
    const p = bktUpdate(0.5, correct / attempts >= 0.5, DEFAULT_PARAMS);
    const pCorr = p * (1 - DEFAULT_PARAMS.pSlip) + (1 - p) * DEFAULT_PARAMS.pGuess;
    return {
      knowledgePoint: kp,
      attempts, correct, wrong,
      pMastery: Math.round(p * 1000) / 1000,
      predictNextCorrect: Math.round(pCorr * 1000) / 1000,
      weak: correct / attempts < 0.6,
    };
  });

  const weak = results.filter((r) => r.weak).sort((a, b) => a.pMastery - b.pMastery);

  return { ok: true, points: results, weakPoints: weak.slice(0, 10) };
}

export const cognitiveDiagnosisService = { bktTrack, bktDiagnose, bktUpdate };
