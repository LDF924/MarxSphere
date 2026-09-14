// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// skill-usage-tracker.ts — V417: 技能使用痕迹（"越用越熟"闭环的感应器）
//
// 由来（2026-09-14 用户问"有没有一套天天在更新、越用越熟的 skill"）：
//   实测 144 条技能里 consensus 全是 2 —— 但那是 **2 个 LLM 校验器放行**，不是用了 2 次。
//   技能一旦入库就不再有使用痕迹：没有使用次数、没有最近使用时间、source_tasks 全是单元素。
//   结果是"反复遇到同类任务 → 技能沉淀得更熟"这条链**从来没接上**，144 条全是单次任务的孤儿。
//
// 这里只做两件事: 记录使用(recall/结果) + 把使用情况读出来给运营/召回排序用。
// **不改 consensus** —— 它的语义是校验票数，往里面塞使用次数会让已有数据含义混淆(见迁移 148)。
import { pool } from "../db/pool.js";

export type SkillUseSource = "recall" | "agent" | "manual";

export interface SkillUsageStat {
  id: number;
  name: string;
  status: string;
  useCount: number;
  successCount: number;
  lastUsedAt: string | null;
  /** 成功率(0-1); 没有成功回写时为 null —— 不把"未知"当成 0 */
  successRate: number | null;
}

/**
 * 记一次技能使用。**失败不抛** —— 埋点不该影响主流程。
 * @param skillIds 本次实际注入到上下文的技能
 * @param opts.taskId/goal 便于回溯"哪类任务用上了它"
 */
export async function recordSkillUsage(skillIds: number[], opts: { taskId?: string; goal?: string; source?: SkillUseSource } = {}): Promise<number> {
  const ids = [...new Set(skillIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return 0;
  const source = opts.source ?? "recall";
  try {
    await pool.query(
      `update agent_skills
          set use_count = use_count + 1, last_used_at = now(), last_used_by = $2
        where id = any($1::int[])`,
      [ids, source]
    );
    // 流水留档: 一次 insert 写多行, 比循环单条省往返
    const values = ids.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(",");
    const params: Array<number | string | null> = [];
    for (const id of ids) params.push(id, opts.taskId ?? null, (opts.goal ?? "").slice(0, 300) || null, source);
    await pool.query(
      `insert into skill_usage_events (skill_id, task_id, goal, source) values ${values}`,
      params
    );
    return ids.length;
  } catch (e: unknown) {
    console.warn(`[skill-usage] 记录失败(不影响主流程): ${String((e as Error)?.message || e).slice(0, 120)}`);
    return 0;
  }
}

/**
 * 回写任务结果 —— 这才是"越用越熟"里的"熟"。
 *
 * 按 **taskId 从流水表反查**这次任务用过哪些技能, 而不是在内存里传递 id 列表:
 * 任务可能跨进程/重启(任务队列 + 租约), 内存态会丢; 流水表不会。
 */
export async function recordSkillOutcome(taskId: string, done: boolean): Promise<number> {
  if (!taskId) return 0;
  const outcome = done ? "done" : "failed";
  try {
    // 先补结局。**用 RETURNING 拿到真正被更新的行** —— 然后只给这些技能计数。
    // 早期版本在这里无条件 `success_count = success_count + 1`, 而结局只补 outcome is null 的,
    // 两边条件不一致: 同一个 taskId 回写两次会让 success_count 变 2 而 use_count 还是 1,
    // 热度榜显示出"成功率 200%"这种不可能的值(实测踩到)。
    // 幂等性靠这里的 WHERE outcome is null: 重复回写时 RETURNING 为空, 不会重复计数。
    const r = await pool.query(
      `update skill_usage_events set outcome = $2
        where task_id = $1 and outcome is null
        returning skill_id`,
      [taskId, outcome]
    );
    const ids = [...new Set(r.rows.map((x: Record<string, unknown>) => Number(x.skill_id)).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length === 0) return 0;
    if (done) {
      // 只有"本次真的补上了成功结局"的技能才 +1, 与 use_count 的分母对齐
      await pool.query(`update agent_skills set success_count = success_count + 1 where id = any($1::int[])`, [ids]);
    }
    return ids.length;
  } catch (e: unknown) {
    console.warn(`[skill-usage] 结果回写失败(不影响主流程): ${String((e as Error)?.message || e).slice(0, 120)}`);
    return 0;
  }
}

/**
 * 技能热度榜（运营面板/越用越熟的可视化依据）。
 * 按 use_count 降序，未使用过的排在后面但不隐藏 —— 冷技能也是事实。
 */
export async function listSkillUsage(limit = 50): Promise<{ total: number; used: number; rows: SkillUsageStat[] }> {
  try {
    const r = await pool.query(
      `select id, name, status, use_count, success_count, last_used_at
         from agent_skills
        order by use_count desc, last_used_at desc nulls last, id
        limit $1`,
      [limit]
    );
    const t = await pool.query(
      `select count(*)::int total, count(*) filter (where use_count > 0)::int used from agent_skills`
    );
    const rows: SkillUsageStat[] = r.rows.map((x: Record<string, unknown>) => {
      const useCount = Number(x.use_count || 0);
      const successCount = Number(x.success_count || 0);
      return {
        id: Number(x.id),
        name: String(x.name || ""),
        status: String(x.status || ""),
        useCount,
        successCount,
        lastUsedAt: x.last_used_at ? new Date(x.last_used_at as string).toISOString() : null,
        // 只有真的回写过结局才算得出成功率; 一次都没回写时给 null(而不是 0)。
        // 夹到 1: success_count 与 use_count 的理论口径一致(见 recordSkillOutcome),
        // 但历史数据或并发回写仍可能让分子超过分母 —— 别把 200% 这种事端到用户面前。
        successRate: successCount > 0 && useCount > 0 ? Number(Math.min(1, successCount / useCount).toFixed(3)) : null,
      };
    });
    return { total: Number(t.rows[0]?.total || 0), used: Number(t.rows[0]?.used || 0), rows };
  } catch (e: unknown) {
    console.warn(`[skill-usage] 读取失败: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return { total: 0, used: 0, rows: [] };
  }
}

/** 某技能的使用流水（面板展开看"它都在哪些任务上被用过"） */
export async function listSkillUsageEvents(skillId: number, limit = 20): Promise<Array<{ taskId: string | null; goal: string | null; source: string; outcome: string | null; createdAt: string }>> {
  try {
    const r = await pool.query(
      `select task_id, goal, source, outcome, created_at
         from skill_usage_events where skill_id = $1
        order by created_at desc limit $2`,
      [skillId, limit]
    );
    return r.rows.map((x: Record<string, unknown>) => ({
      taskId: x.task_id ? String(x.task_id) : null,
      goal: x.goal ? String(x.goal) : null,
      source: String(x.source || ""),
      outcome: x.outcome ? String(x.outcome) : null,
      createdAt: new Date(x.created_at as string).toISOString(),
    }));
  } catch { return []; }
}

export const skillUsageTracker = { recordSkillUsage, recordSkillOutcome, listSkillUsage, listSkillUsageEvents };
