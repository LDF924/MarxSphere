// agent-knowledge-feedback.ts — V394-3: 工具结果回流知识库
// Agent 任务完成时, 把已验证的步骤产出自动提交为知识页草稿（Truth 知识页, 人工审核后入库）
// 知识沉淀复用: 同一主题的研究成果下次可被检索/引用
import { pool } from "../db/pool.js";

/**
 * V394-3: Agent 任务产出 → 知识页草稿
 * @param taskId 任务ID
 * @param goal 任务目标（作为知识页标题来源）
 * @param result 最终汇总
 * @returns 创建的草稿数
 */
export async function feedbackTaskToKnowledge(taskId: string, goal: string, result: string): Promise<{ created: number; pageId?: number; skipped?: string }> {
  try {
    if (!result || result.length < 100) return { created: 0, skipped: "产出过短(<100字)不沉淀" };
    // 检查是否已有同主题草稿（防重复提交）
    const dup = await pool.query(
      "select id from knowledge_page_drafts where title = $1 and status = 'pending_review' limit 1",
      [goal.substring(0, 80)]
    );
    if (dup.rows.length > 0) return { created: 0, skipped: "同主题草稿已存在" };
    // 创建草稿（标题: 目标前40字; compiled_truth: 任务汇总; source_hint: 来源标注）
    const r = await pool.query(
      `insert into knowledge_page_drafts (title, compiled_truth, source_hint, tags, status)
       values ($1, $2, $3, $4::jsonb, 'pending_review') returning id`,
      [goal.substring(0, 80), result.substring(0, 8000), "agent-task:" + taskId, JSON.stringify(["agent", "auto"])]
    );
    console.log(`[agent] V394-3 知识回流: 任务 ${taskId} 产出已提交为知识草稿 #${r.rows[0].id}`);
    return { created: 1, pageId: Number(r.rows[0].id) };
  } catch (e: any) {
    console.warn(`[agent] V394-3 知识回流失败: ${String(e?.message || e).slice(0, 100)}`);
    return { created: 0, skipped: "写入失败" };
  }
}

export const agentKnowledgeFeedback = { feedbackTaskToKnowledge };
