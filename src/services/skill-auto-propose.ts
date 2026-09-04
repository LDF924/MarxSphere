// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/skill-auto-propose.ts — V404-8: 技能自我进化闭环(auto_propose)
// 借鉴 OpenSquilla meta/author_seed.py + auto_propose: 从会话/执行日志发现高频目标
// → 检查已有 approved 技能是否覆盖 → 未覆盖 → 自动蒸馏提案 → EDV 验证 → 人工可见列表
// (前端技能库已有人工 accept/reject 面; 本服务补充"反查"发现侧 + 覆盖判定守卫)
import { pool } from "../db/pool.js";
import { recallSkills } from "./agent-skill-distill.js";
import { proposeSkill } from "./agent-skill-distill.js";

export interface AutoProposeResult {
  scanned: number;       // 扫描到的高频目标数
  covered: number;       // 已有技能覆盖(跳过)
  proposed: number;      // 新提案数
  failed: number;        // 蒸馏失败(结果过短/LLM 解析失败)
  proposals: Array<{ skillId: number; name: string; status: string; whenToApply: string }>;
}

/** 中文二元字符组(无分词下最稳的相似度信号) */
function bigrams(text: string): Set<string> {
  const clean = String(text || "").replace(/[\s\p{P}\p{S}]+/gu, "");
  const out = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2));
  return out;
}

/**
 * 判定该目标是否已被已批准技能覆盖:
 * 目标与技能(name+when)的二元字符组重叠 ≥2 → 覆盖; 目标 ≤4 字时要求完整包含(防误判)
 */
export async function isCoveredBySkills(goal: string, skills: Array<{ name: string; whenToApply: string }>): Promise<boolean> {
  const g = String(goal || "").trim();
  if (!g) return false;
  if (g.length <= 4) {
    // 短目标: 完整子串命中才算覆盖(避免两字误匹配)
    return skills.some((s) => `${s.name}${s.whenToApply}`.includes(g));
  }
  const gBigrams = bigrams(g);
  for (const s of skills) {
    const hay = `${s.name}${s.whenToApply}`;
    const hayBigrams = bigrams(hay);
    let hit = 0;
    for (const b of gBigrams) if (hayBigrams.has(b)) hit++;
    if (hit >= 2) return true;
  }
  return false;
}

/**
 * auto_propose: 扫描最近 N 天 task_experience 高频目标(≥minCount 次) → 覆盖判定
 * → 取每个目标的最近一次成功记录(quality_score/success + task 关联) → proposeSkill 蒸馏
 * 目标: 每轮最多产 maxProposals 个(控 LLM 成本), 全部走 EDV 验证异步
 */
export async function runAutoPropose(opts: { days?: number; minCount?: number; maxProposals?: number } = {}): Promise<AutoProposeResult> {
  const days = opts.days ?? 7;
  const minCount = opts.minCount ?? 3;
  const maxProposals = opts.maxProposals ?? 3;
  const out: AutoProposeResult = { scanned: 0, covered: 0, proposed: 0, failed: 0, proposals: [] };
  try {
    // 高频目标(聚合) + 直接取最近一条详情(同表 join 免二次查询)
    const r = await pool.query(
      `select t.query as goal,
              t.n,
              t.best_id,
              te.quality_score,
              te.success,
              te.strategy::text as strategy
       from (
         select query,
                count(*)::int as n,
                (array_agg(id order by created_at desc))[1] as best_id
         from task_experience
         where created_at > now() - ($1::int || ' days')::interval
           and query is not null and query <> ''
         group by query
         having count(*) >= $2
         order by n desc
         limit $3
       ) t
       left join task_experience te on te.id = t.best_id`,
      [days, minCount, maxProposals * 3] // 多取一些, 过滤覆盖后仍有货
    );
    out.scanned = r.rows.length;
    const approved = await pool.query("select name, when_to_apply from agent_skills where status = 'approved'");
    const existing = approved.rows;
    for (const row of r.rows) {
      if (out.proposed >= maxProposals) break;
      const goal = String(row.goal || "");
      if (await isCoveredBySkills(goal, existing)) { out.covered++; continue; }
      const rr = row;
      // proposeSkill 有 result<200 字符守卫 — 组合高频背景+最近策略凑足上下文
      const ctx = [
        `【高频重复任务】${goal} — 近期出现 ${row.n} 次, 值得沉淀可复用方法。`,
        `【最近一次执行策略】${String(rr.strategy || "(无策略记录)")}`,
        `【质量】${rr.quality_score != null ? `质量分 ${Number(rr.quality_score).toFixed(2)}` : "未评分"} / ${rr.success ? "成功" : "失败"}`,
      ].join("\n");
      // 高频任务上下文紧凑 → 最小长度放宽到 60(默认蒸馏仍 200 保轨迹完整)
      if (ctx.length < 60) { out.failed++; continue; }
      const skill = await proposeSkill(`auto-${row.best_id}`, goal, ctx, rr.strategy ? [String(rr.strategy).slice(0, 30)] : [], { minResultChars: 60 });
      if (!skill) { out.failed++; continue; }
      out.proposed++;
      out.proposals.push({ skillId: skill.id, name: skill.name, status: skill.status, whenToApply: skill.whenToApply });
      // 异步 EDV 验证
      const { validateSkill } = await import("./agent-skill-distill.js");
      void validateSkill(skill.id).catch(() => {});
    }
  } catch (e: any) {
    console.warn(`[auto-propose] 失败: ${String(e?.message || e).slice(0, 150)}`);
  }
  return out;
}

/** 技能体检: agent_skills 记录完整性 + 引用一致性(来源任务存在性等), 返回体检报告 */
export async function skillHealthCheck(): Promise<{
  total: number; broken: Array<{ id: number; name: string; issue: string }>;
}> {
  const broken: Array<{ id: number; name: string; issue: string }> = [];
  let total = 0;
  try {
    const r = await pool.query("select * from agent_skills order by id");
    total = r.rows.length;
    for (const s of r.rows) {
      const name = String(s.name || "").trim();
      const when = String(s.when_to_apply || "").trim();
      const md = String(s.skill_md || "").trim();
      if (!name) broken.push({ id: Number(s.id), name: `#${s.id}`, issue: "技能名为空" });
      else if (!when) broken.push({ id: Number(s.id), name, issue: "缺 when_to_apply 适用条件" });
      else if (md.length < 20) broken.push({ id: Number(s.id), name, issue: `skill_md 过短(${md.length} 字)` });
      if (s.source_tasks && Array.isArray(s.source_tasks) && (s.source_tasks as string[]).length === 0 && s.distilled_by !== "manual") {
        broken.push({ id: Number(s.id), name, issue: "来源任务为空(非 manual)" });
      }
    }
  } catch (e: any) {
    console.warn(`[skill-health] 失败: ${String(e?.message || e).slice(0, 100)}`);
  }
  return { total, broken };
}

export const skillAutoProposeService = { runAutoPropose, isCoveredBySkills, skillHealthCheck };
