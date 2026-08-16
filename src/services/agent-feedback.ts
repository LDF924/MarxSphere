// agent-feedback.ts — 借鉴 DSH feedback 包: Agent 任务反馈闭环
// 👍👎 → 失败反馈自动转防错规则 / 好评沉淀经验 / 反馈回流记忆
import { pool } from "../db/pool.js";

export interface FeedbackResult {
  ok: boolean;
  ruleCreated?: boolean;
  ruleId?: number;
  note?: string;
}

/** 提交任务反馈: 赞/踩/备注; 踩(负评)自动转防错规则 */
export async function submitAgentFeedback(input: {
  taskId: string;
  feedback: 1 | -1 | 0;
  note?: string;
}): Promise<FeedbackResult> {
  if (!input.taskId) return { ok: false };
  const task = await pool.query(
    `select id, goal, progress from agent_tasks where id = $1::uuid`,
    [input.taskId]
  );
  if (task.rows.length === 0) return { ok: false };
  const goal = String(task.rows[0].goal || "");
  // 记录反馈
  await pool.query(
    `update agent_tasks set user_feedback = $2, feedback_at = now(), feedback_note = $3 where id = $1::uuid`,
    [input.taskId, input.feedback, input.note || null]
  );
  // 负评 → 转防错规则（失败原因沉淀, 防复发）
  let ruleCreated = false;
  let ruleId: number | undefined;
  if (input.feedback === -1 && goal) {
    try {
      const { createPreventionRule } = await import("./prevention-rules-service.js");
      const reason = input.note?.trim()
        ? `用户反馈: ${input.note.trim()}`
        : `用户对任务「${goal.slice(0, 30)}」给出负评, 需改进产出质量`;
      const rule = await createPreventionRule({
        category: "quality",
        pattern: goal.slice(0, 60),
        rule: reason.slice(0, 200),
        source: "user_down" as const,  // 防错规则 source 类型: user_down/eval_failure/manual
      });
      if (rule) { ruleCreated = true; ruleId = Number((rule as any).id || rule); }
    } catch { /* 规则创建失败不阻塞 */ }
  }
  // 反馈回流记忆（负评失败经验 / 好评成功经验）
  try {
    const { agentEpisodicMemoryService } = await import("./agent-episodic-memory.js");
    await agentEpisodicMemoryService.recordEpisodicMemory({
      taskId: input.taskId,
      goal: goal.slice(0, 60),
      summary: `用户${input.feedback === 1 ? "好评" : "负评"}${input.note ? `: ${input.note.slice(0, 100)}` : ""}`,
      keyFacts: [input.feedback === 1 ? "用户认可" : "用户不满意"],
      toolsUsed: [],
      outcome: input.feedback === 1 ? "success" : "partial",
      importance: input.feedback === 1 ? 0.5 : 0.8,
    });
  } catch { /* 记忆回流失败不阻塞 */ }
  return { ok: true, ruleCreated, ruleId, note: input.feedback === -1 ? (ruleCreated ? "负评已转防错规则" : "负评已记录") : "已记录" };
}

/** 反馈统计（评测/面板） */
export async function agentFeedbackStats(): Promise<{ positive: number; negative: number; recent: Array<{ taskId: string; goal: string; feedback: number; note?: string; feedbackAt: Date }> }> {
  const r = await pool.query(
    `select id, goal, user_feedback, feedback_note, feedback_at from agent_tasks
     where user_feedback is not null and user_feedback != 0
     order by feedback_at desc limit 10`
  );
  const s = await pool.query(
    `select
      coalesce(sum(case when user_feedback = 1 then 1 else 0 end), 0)::int as positive,
      coalesce(sum(case when user_feedback = -1 then 1 else 0 end), 0)::int as negative
     from agent_tasks where user_feedback is not null`
  );
  return {
    positive: Number(s.rows[0]?.positive || 0),
    negative: Number(s.rows[0]?.negative || 0),
    recent: r.rows.map((row: any) => ({
      taskId: row.id, goal: String(row.goal || "").slice(0, 50),
      feedback: Number(row.user_feedback || 0), note: row.feedback_note, feedbackAt: row.feedback_at,
    })),
  };
}

export const agentFeedbackService = { submitAgentFeedback, agentFeedbackStats };
