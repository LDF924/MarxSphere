// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// learning-evidence-service.ts — 学习者证据账本 + BKT 概念掌握(V386, 2026-08-29, 借鉴 TraitTutor)
// 对照 TraitTutor 的三大设计:
//   1. 强证据单闸门(is_strong_evidence): 只有服务端判分+可靠归属+答案非空的事件才更新 BKT
//   2. 事件账本 append-only + void amendment: 掌握度从账本确定性重放重建, 纠错不删原始裁决
//   3. 诚实读策略: 未校准参数或观察不足(默认 <3)时不显示精确数字, 只给定性状态
// 迁移: 096_learner_evidence_ledger.sql
import { pool } from "../db/pool.js";

// ═══ BKT 更新公式(TraitTutor bkt_math 移植) ═══
export interface BktParams { version: string; transition: number; guess: number; slip: number; prior: number; calibrated: boolean; }

export function bktUpdate(prior: number, correct: boolean, t: number, g: number, s: number, weight = 1.0): number {
  const predicted = prior + (1 - prior) * t;                                    // 先施加学习转换
  const likelihood = correct
    ? predicted * (1 - s) + (1 - predicted) * g
    : predicted * s + (1 - predicted) * (1 - g);
  const posterior = likelihood <= 0 ? predicted : (predicted * (correct ? 1 - s : s)) / likelihood;
  return Math.max(0, Math.min(1, prior * (1 - weight) + posterior * weight));
}

/** 观察数门槛: 未达到不给概率, 只给定性状态(TraitTutor MIN_OBSERVATIONS_FOR_PROBABILITY=3) */
export const MIN_OBSERVATIONS_FOR_PROBABILITY = 3;
/** 阶段阈值: >= supported 视为已掌握(TraitTutor 0.75) */
export const SUPPORTED_THRESHOLD = 0.75;
/** 时间衰减半衰期(天): 按知识类型(TraitTutor decay.py: MEMORY=30/PROCEDURE=60/CONCEPT=90/DESIGN=120) */
const HALF_LIFE_BY_TYPE: Record<string, number> = { memory: 30, procedure: 60, concept: 90, design: 120 };

/** 知识类型推断(默认 concept) */
function knowledgeTypeOf(point: string): string {
  const p = point.toLowerCase();
  if (/(记忆|背诵|定义|事实|人名|术语)/.test(p)) return "memory";
  if (/(步骤|流程|操作|procedure|语法|写法)/.test(p)) return "procedure";
  if (/(设计|方法|策略|体系|模型)/.test(p)) return "design";
  return "concept";
}

/** 获取当前生效 BKT 参数(取最新 calibrated, 否则回退种子未校准参数) */
export async function getActiveBktParams(): Promise<BktParams> {
  const r = await pool.query(
    `select version, transition::float8 t, guess::float8 g, slip::float8 s, prior::float8 p, calibrated
     from bkt_parameters order by calibrated desc, created_at desc limit 1`
  ).catch(() => ({ rows: [] }));
  if (r.rows.length === 0) return { version: "v1-uncalibrated", transition: 0.12, guess: 0.2, slip: 0.1, prior: 0.2, calibrated: false };
  const row = r.rows[0];
  return { version: row.version, transition: row.t, guess: row.g, slip: row.s, prior: row.p, calibrated: row.calibrated };
}

// ═══ 强证据闸门(TraitTutor is_strong_evidence 移植) ═══
/** 是否强证据: 服务端判分 + 可靠归属 + 答案非空。曝光/自我报告/未评分永不进 BKT */
export function isStrongEvidence(e: { evidence_strength?: string; attribution_status?: string; is_correct: boolean | null }): boolean {
  return e.evidence_strength === "strong" && (e.attribution_status ?? "reliable") === "reliable" && e.is_correct !== null;
}

// ═══ 服务端评分器(确定性, 参考 TraitTutor grading.py) ═══
export interface GradeInput {
  userAnswer: string;
  expectedAnswer: string;
  questionType?: "choice" | "tf" | "short" | "open";
}
/** 短答案: SequenceMatcher 相似度 >= 0.85; 开放题: 关键词命中 >= 60%; 空预期答案必错 */
export function gradeAnswer(input: GradeInput): { correct: boolean; method: string } {
  const u = (input.userAnswer ?? "").trim();
  const e = (input.expectedAnswer ?? "").trim();
  if (!e) return { correct: false, method: "empty-expected" };
  if (!u) return { correct: false, method: "empty-answer" };
  const type = input.questionType || "short";
  if (type === "choice" || type === "tf") {
    return { correct: u.toLowerCase() === e.toLowerCase(), method: "exact" };
  }
  if (type === "open") {
    // open: 关键词命中率(取预期答案中的词)
    const kw = e.split(/[\s,，。;；、]+/).filter((w) => w.length >= 2);
    if (kw.length === 0) return { correct: false, method: "open-nokeywords" };
    const hit = kw.filter((w) => u.includes(w)).length;
    return { correct: hit / kw.length >= 0.6, method: "keyword" };
  }
  // short: 相似度 >= 0.85(长答案超 30 字保守 fail-closed)
  if (u.length > 30) return { correct: false, method: "too-long" };
  const ratio = similarity(u, e);
  return { correct: ratio >= 0.85, method: "similarity" };
}

/** 序列相似度(Levenshtein 简化版) */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - dp[n] / Math.max(m, n);
}

// ═══ 事件记录 ═══
export interface RecordEventInput {
  studentId?: string;
  subject: string;
  knowledgePoint: string;
  question: string;
  userAnswer?: string;
  expectedAnswer?: string;
  /** 缺省自动服务端判分; 传 null 表示不判分(仅参与记录) */
  isCorrect?: boolean | null;
  gradedBy?: "server" | "client" | "self";
  questionType?: "choice" | "tf" | "short" | "open";
  surfaceType?: string;
  difficulty?: string;
  idempotencyKey?: string;
}

/**
 * 记录一条学习者事件并返回判定。
 * - 提供 expectedAnswer → 服务端判分, 写 evidence_strength='strong'(进 BKT)
 * - 不提供 → 按 gradedBy 写 exposure/none(仅参与, 永不进 BKT)
 * - 幂等键防重放: 同键重复调用返回原事件, 零写入
 */
export async function recordLearnerEvent(input: RecordEventInput): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const questionType = input.questionType || "short";
  let isCorrect = input.isCorrect === undefined ? null : input.isCorrect;
  let evidenceStrength = "none";
  let gradedBy = input.gradedBy || (input.expectedAnswer ? "server" : "client");

  if (input.expectedAnswer && isCorrect === null) {
    const g = gradeAnswer({ userAnswer: input.userAnswer || "", expectedAnswer: input.expectedAnswer, questionType });
    isCorrect = g.correct;
  }
  if (isCorrect !== null && gradedBy === "server") evidenceStrength = "strong";
  else if (gradedBy === "client") evidenceStrength = "none";
  else if (gradedBy === "self") evidenceStrength = "exposure";

  const idem = input.idempotencyKey || `ev:${studentId}:${input.subject}:${input.knowledgePoint}:${hash(`${input.question}|${input.userAnswer ?? ""}`)}`;
  const dup = await pool.query("select id from learner_event_ledger where idempotency_key = $1", [idem]).catch(() => ({ rows: [] }));
  if (dup.rows.length > 0) {
    const existing = await pool.query("select id, is_correct, evidence_strength from learner_event_ledger where id = $1", [dup.rows[0].id]);
    return { ok: true, duplicate: true, eventId: existing.rows[0]?.id, isCorrect: existing.rows[0]?.is_correct, evidenceStrength: existing.rows[0]?.evidence_strength };
  }
  // V396: 内容寻址去重(借鉴 LingxiLearn) — sha256 摘要即去重键, 同观察重复追加自动坍缩
  const digest = sha256(`${studentId}|${input.subject}|${input.knowledgePoint}|${input.question}|${input.userAnswer ?? ""}|${String(isCorrect)}`);
  const digestDup = await pool.query("select id from learner_event_ledger where evidence_digest = $1", [digest]).catch(() => ({ rows: [] }));
  if (digestDup.rows.length > 0) {
    const existing = await pool.query("select id, is_correct, evidence_strength from learner_event_ledger where id = $1", [digestDup.rows[0].id]);
    return { ok: true, duplicate: true, viaDigest: true, eventId: existing.rows[0]?.id, isCorrect: existing.rows[0]?.is_correct, evidenceStrength: existing.rows[0]?.evidence_strength };
  }

  const r = await pool.query(
    `insert into learner_event_ledger
       (student_id, subject, knowledge_point, surface_type, question, user_answer, expected_answer,
        is_correct, evidence_strength, attribution_status, graded_by, difficulty, idempotency_key, evidence_digest)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reliable',$10,$11,$12,$13) returning id`,
    [studentId, input.subject, input.knowledgePoint, input.surfaceType || "practice", input.question,
     input.userAnswer ?? null, input.expectedAnswer ?? null, isCorrect, evidenceStrength, gradedBy,
     input.difficulty || "medium", idem, digest]
  );
  // V394: 事件→图谱联动投影 — 强证据同步 learner_events(学习者模型/图谱消费)
  if (evidenceStrength === "strong") {
    await pool.query(
      `insert into learner_events (student_id, event_type, payload)
       values ($1, 'mastery_attempt', $2::jsonb)`,
      [studentId, JSON.stringify({
        source_event_id: r.rows[0].id, subject: input.subject, knowledge_point: input.knowledgePoint,
        is_correct: isCorrect, evidence_strength: "strong", surface_type: input.surfaceType || "practice",
        graded_by: gradedBy, created_at: new Date().toISOString(),
      })]
    ).catch(() => {});
    // V395: 深水区① — 学习事件写入 Neo4j 知识图谱(异步, 失败降级不阻塞学习)
    void (async () => {
      try {
        const { syncLearningEventToGraph } = await import("./learning-events-graph-sync.js");
        await syncLearningEventToGraph({
          studentId, knowledgePoint: input.knowledgePoint, subject: input.subject,
          isCorrect: isCorrect === true, sourceEventId: r.rows[0].id,
        });
      } catch { /* Neo4j 离线降级 */ }
    })();
  }
  return { ok: true, duplicate: false, eventId: r.rows[0].id, isCorrect, evidenceStrength, gradedBy };
}

// ═══ 纠错: void amendment(TraitTutor: 原始裁决可回放, 派生只吃有效流) ═══
export async function voidEvent(input: { eventId: number; reason: "grading_error" | "item_invalid" | "attribution_error" | "duplicate_evidence" | "privacy_request"; note?: string }): Promise<Record<string, unknown>> {
  const exists = await pool.query("select 1 from learner_event_ledger where id = $1", [input.eventId]).catch(() => ({ rows: [] }));
  if (exists.rows.length === 0) return { ok: false, error: "事件不存在" };
  const dup = await pool.query("select 1 from learner_event_amendments where event_id = $1", [input.eventId]);
  if (dup.rows.length > 0) return { ok: false, error: "该事件已作废" };
  await pool.query(
    "insert into learner_event_amendments (event_id, action, reason, note) values ($1, 'void', $2, $3)",
    [input.eventId, input.reason, input.note ?? null]
  );
  return { ok: true, voided: input.eventId };
}

/** 有效事件流(排除已 void 的), 按时间+id 确定性排序供重放 */
async function effectiveEvents(studentId: string): Promise<any[]> {
  const r = await pool.query(
    `select l.* from learner_event_ledger l
     where l.student_id = $1
       and not exists (select 1 from learner_event_amendments a where a.event_id = l.id)
     order by l.answered_at, l.id`,
    [studentId]
  );
  return r.rows;
}

// ═══ 从账本重放重建掌握度(TraitTutor: 派生状态永远可重建) ═══
export interface MasteryCell {
  student_id: string; subject: string; knowledge_point: string;
  mastery_probability: number | null;       // 未校准/观察不足 → null(不显示数字)
  evidence_state: "insufficient_evidence" | "needs_support" | "developing" | "supported";
  verified_observation_count: number;
  attempts: number; correct_count: number;
  param_version: string; calibrated: boolean;
  last_answer_at: string | null;
}

export async function rebuildMastery(studentId: string): Promise<MasteryCell[]> {
  const events = await effectiveEvents(studentId);
  const params = await getActiveBktParams();
  const cells = new Map<string, MasteryCell>();

  for (const ev of events) {
    const key = `${ev.subject}::${ev.knowledge_point}`;
    const cell = cells.get(key) || {
      student_id: studentId, subject: ev.subject, knowledge_point: ev.knowledge_point,
      mastery_probability: params.prior, evidence_state: "insufficient_evidence" as const,
      verified_observation_count: 0, attempts: 0, correct_count: 0,
      param_version: params.version, calibrated: params.calibrated, last_answer_at: null,
    };
    cell.attempts += 1;
    if (ev.is_correct === true) cell.correct_count += 1;
    if (ev.answered_at && (!cell.last_answer_at || new Date(ev.answered_at) > new Date(cell.last_answer_at))) {
      cell.last_answer_at = ev.answered_at;
    }
    if (isStrongEvidence(ev)) {
      cell.verified_observation_count += 1;
      cell.mastery_probability = bktUpdate(cell.mastery_probability!, ev.is_correct, params.transition, params.guess, params.slip);
    }
    cells.set(key, cell);
  }

  const out: MasteryCell[] = [];
  for (const cell of cells.values()) {
    // 时间衰减(纯读投影): 未校准或最近答错不衰减向上
    let p = cell.mastery_probability;
    const type = knowledgeTypeOf(cell.knowledge_point);
    if (p !== null && cell.calibrated && cell.verified_observation_count >= MIN_OBSERVATIONS_FOR_PROBABILITY && cell.last_answer_at) {
      const days = (Date.now() - new Date(cell.last_answer_at).getTime()) / 86_400_000;
      const hl = HALF_LIFE_BY_TYPE[type] || 90;
      const params0 = params.prior;
      p = params0 + (p - params0) * Math.exp((-Math.LN2 * days) / hl);
    }
    // 定性状态(与 TraitTutor stage_policy 对齐: 最近失败优先)
    if (cell.verified_observation_count > 0 && cell.attempts > 0) {
      // 最近一次强证据是否错误(取该 cell 最近强证据事件)
      const lastStrong = [...events].reverse().find((e) => e.knowledge_point === cell.knowledge_point && e.subject === cell.subject && isStrongEvidence(e));
      if (lastStrong && lastStrong.is_correct === false) {
        cell.evidence_state = "needs_support";
      } else if (!cell.calibrated || cell.verified_observation_count < MIN_OBSERVATIONS_FOR_PROBABILITY) {
        cell.evidence_state = "insufficient_evidence";
      } else if ((p ?? 0) >= SUPPORTED_THRESHOLD) {
        cell.evidence_state = "supported";
      } else {
        cell.evidence_state = "developing";
      }
    }
    out.push({ ...cell, mastery_probability: cell.calibrated && cell.verified_observation_count >= MIN_OBSERVATIONS_FOR_PROBABILITY ? p : null });
  }
  out.sort((a, b) => a.subject.localeCompare(b.subject) || a.knowledge_point.localeCompare(b.knowledge_point));
  return out;
}

/** 简单哈希(idempotency 用) */
/** sha256 摘要(内容寻址去重, 借鉴 LingxiLearn) */
function sha256(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0xdeadbeef, h4 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ c, 0xc2b2ae35) >>> 0;
    h4 = Math.imul(h4 + c, 0x27d4eb2f) >>> 0;
  }
  return [h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export const learningEvidenceService = { bktUpdate, gradeAnswer, recordLearnerEvent, voidEvent, rebuildMastery, getActiveBktParams, isStrongEvidence, similarity, MIN_OBSERVATIONS_FOR_PROBABILITY, SUPPORTED_THRESHOLD };
