// agent-skill-distill.ts — V396-9: 技能蒸馏 + EDV 防自我确认
// 从任务成败轨迹蒸馏可复用技能（SKILL.md 式工件, 带 when-to-apply 守卫）
// EDV(自我确认陷阱防护): 蒸馏 agent 与验证 agent 角色解耦 — 第三方验证者跨轨迹对比,
// 共识验证: 全票通过入共享库 / 部分通过入私有待定 / 全票否决丢弃
import { pool } from "../db/pool.js";
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";
import { callLlm } from "../ai/llm-common.js";

export interface DistilledSkill {
  id: number;
  name: string;
  whenToApply: string;
  skillMd: string;
  sourceTasks: string[];
  distilledBy: string;
  consensus: number;
  votes: Array<{ validator: string; verdict: "approve" | "reject" | "uncertain"; reason: string }>;
  status: "pending" | "approved" | "rejected";
}

/** 任务轨迹 → 技能提案（蒸馏者角色, LLM 提炼: 方法步骤+适用条件+反模式） */
export async function proposeSkill(taskId: string, goal: string, result: string, toolsUsed: string[]): Promise<DistilledSkill | null> {
  // W9: 技能库容量控制 — 超 100 条自动淘汰最旧+最低共识的 rejected/pending（保留 approved）
  try {
    const cnt = await pool.query("select count(*) as n from agent_skills");
    if (Number(cnt.rows[0]?.n || 0) >= 100) {
      await pool.query(
        `delete from agent_skills where status != 'approved'
         and id in (select id from agent_skills where status != 'approved' order by consensus asc, created_at asc limit 20)`
      );
    }
  } catch { /* 容量清理失败不阻塞 */ }
  try {
    if (!result || result.length < 200) return null;
    const model = resolveModelAlias(getRoleModel("plan"));
    const prompt = `你是技能蒸馏师。从一次 Agent 研究任务的成功轨迹中蒸馏出可复用的"技能"（SKILL.md 式工件）：
任务目标: ${goal.slice(0, 200)}
使用工具: ${toolsUsed.join(", ")}
任务产出: ${result.slice(0, 800)}

蒸馏要求:
1. 技能名(10字内): 概括可复用的方法/流程
2. when_to_apply(适用条件守卫): 什么情况该用这个技能(30字内)
3. skill_md: 步骤化技能描述(100字内, 含: 流程步骤/关键注意/反模式)

只输出 JSON: {"name":"技能名","when_to_apply":"适用条件","skill_md":"技能描述"}`;
    const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2, maxTokens: 500 });
    const text = (r?.text || "").replace(/```json|```/g, "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed.name || !parsed.when_to_apply || !parsed.skill_md) return null;
    const ins = await pool.query(
      `insert into agent_skills (name, when_to_apply, skill_md, source_tasks, distilled_by, status)
       values ($1,$2,$3,$4::text[],'agent','pending') returning *`,
      [String(parsed.name).slice(0, 30), String(parsed.when_to_apply).slice(0, 100), String(parsed.skill_md).slice(0, 500), [taskId]]
    );
    return mapRow(ins.rows[0]);
  } catch { return null; }
}

/** EDV 验证: 第三方验证者独立评估技能提案（角色解耦防自我确认陷阱） */
export async function validateSkill(skillId: number, validators = 2): Promise<{ consensus: number; status: string; votes: any[] }> {
  try {
    const s = await pool.query("select * from agent_skills where id = $1", [skillId]);
    if (s.rows.length === 0) return { consensus: 0, status: "rejected", votes: [] };
    const skill = mapRow(s.rows[0]);
    const model = resolveModelAlias(getRoleModel("plan"));
    const votes: Array<{ validator: string; verdict: "approve" | "reject" | "uncertain"; reason: string }> = [];
    for (let i = 0; i < validators; i++) {
      try {
        const prompt = `你是独立的第三方技能验证者（与技能蒸馏者不同角色）。评估以下技能提案是否值得入库复用:
技能名: ${skill.name}
适用条件: ${skill.whenToApply}
技能描述: ${skill.skillMd}
来源任务: ${skill.sourceTasks.join(", ")}

评估标准（防自我确认陷阱——蒸馏者可能把"错而自洽"的轨迹当成功经验）:
1. 技能是否具体可操作(非泛泛而谈)?
2. 是否可能只是单次任务的偶然经验(样本不足)?
3. 描述是否自洽但实际无效(错而自洽)?

输出 JSON: {"verdict":"approve/reject/uncertain","reason":"理由(30字内)"}`;
        const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2, maxTokens: 200 });
        const text = (r?.text || "").replace(/```json|```/g, "");
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start !== -1 && end > start) {
          const v = JSON.parse(text.slice(start, end + 1));
          votes.push({ validator: `validator-${i + 1}`, verdict: (v.verdict === "approve" || v.verdict === "reject" ? v.verdict : "uncertain"), reason: String(v.reason || "").slice(0, 60) });
        }
      } catch { /* 单验证者失败跳过 */ }
    }
    // 共识规则: 全票通过→approved; 有否决→rejected; 全不确定→pending
    const approves = votes.filter((v) => v.verdict === "approve").length;
    const rejects = votes.filter((v) => v.verdict === "reject").length;
    const status = votes.length > 0 && approves === votes.length ? "approved" : rejects > 0 ? "rejected" : "pending";
    await pool.query(
      "update agent_skills set consensus = $2, votes = $3::jsonb, status = $4 where id = $1",
      [skillId, approves, JSON.stringify(votes), status]
    );
    return { consensus: approves, status, votes };
  } catch { return { consensus: 0, status: "pending", votes: [] }; }
}

/** 任务完成后完整蒸馏流程: 提案 → EDV 验证 → 共识入库（异步触发） */
export async function distillSkillFromTask(taskId: string, goal: string, result: string, toolsUsed: string[]): Promise<{ proposed: boolean; skillId?: number; consensus?: number; status?: string }> {
  const skill = await proposeSkill(taskId, goal, result, toolsUsed);
  if (!skill) return { proposed: false };
  const v = await validateSkill(skill.id);
  return { proposed: true, skillId: skill.id, consensus: v.consensus, status: v.status };
}

/** 删除技能（含可选：同时删除已固化的 SKILL.md） */
export async function deleteSkill(id: number, removeSkillify = false): Promise<{ ok: boolean; removedSkillify?: string; error?: string }> {
  try {
    const s = await pool.query("select * from agent_skills where id = $1", [id]);
    if (s.rows.length === 0) return { ok: false, error: "技能不存在" };
    const skill = mapRow(s.rows[0]);
    await pool.query("delete from agent_skills where id = $1", [id]);
    // 可选: 删除已固化的 SKILL.md（~/.claude/skills/<name>/）
    let removedSkillify: string | undefined;
    if (removeSkillify) {
      try {
        const os = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs");
        const name = /^[a-z0-9-]+$/.test(skill.name) ? skill.name : `agent-skill-${skill.id}`;
        const targetDir = path.join(os.homedir(), ".claude", "skills", name);
        if (fs.existsSync(targetDir)) {
          fs.rmSync(targetDir, { recursive: true, force: true });
          removedSkillify = targetDir;
        }
      } catch { /* SKILL.md 删除失败不阻塞 */ }
    }
    return { ok: true, removedSkillify };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 100) };
  }
}

/** 列表（前端技能库展示） */
export async function listSkills(status?: string): Promise<DistilledSkill[]> {
  const where = status ? "where status = $1" : "";
  const params = status ? [status] : [];
  const r = await pool.query(`select * from agent_skills ${where} order by created_at desc limit 50`, params);
  return r.rows.map(mapRow);
}

/** V4: 技能注入频控缓存 — 同 goal 5 分钟内不重复注入（防上下文膨胀） */
const skillInjectionCache = new Map<string, number>();
const SKILL_INJECT_TTL_MS = 5 * 60 * 1000;

/** 检索技能: 按适用条件/名称匹配（任务规划时注入; V4: 同 goal 短期去重） */
export async function recallSkills(query: string, limit = 3): Promise<DistilledSkill[]> {
  // V4: 频控 — 同 goal 5 分钟内已注入过 → 跳过
  const cacheKey = query.slice(0, 40);
  const lastInjected = skillInjectionCache.get(cacheKey);
  if (lastInjected && Date.now() - lastInjected < SKILL_INJECT_TTL_MS) {
    return [];
  }
  const keywords = query.split(/[\s,，、]+/).filter((k) => k.length >= 2).slice(0, 3);
  if (keywords.length === 0) return [];
  const conds = keywords.map((_, i) => `(name ilike $${i + 1} or when_to_apply ilike $${i + 1} or skill_md ilike $${i + 1})`).join(" or ");
  const params = keywords.map((k) => `%${k}%`);
  const r = await pool.query(
    `select * from agent_skills where status = 'approved' and (${conds}) order by consensus desc limit $${params.length + 1}`,
    [...params, limit]
  );
  const skills = r.rows.map(mapRow);
  if (skills.length > 0) skillInjectionCache.set(cacheKey, Date.now());  // 只对有结果的缓存(空结果不缓存, 允许下次再试)
  return skills;
}

function mapRow(row: any): DistilledSkill {
  return {
    id: Number(row.id),
    name: row.name,
    whenToApply: row.when_to_apply,
    skillMd: row.skill_md,
    sourceTasks: Array.isArray(row.source_tasks) ? row.source_tasks : [],
    distilledBy: row.distilled_by,
    consensus: Number(row.consensus || 0),
    votes: Array.isArray(row.votes) ? row.votes : [],
    status: row.status || "pending",
  };
}

export const agentSkillDistillService = {
  proposeSkill,
  validateSkill,
  distillSkillFromTask,
  listSkills,
  recallSkills,
  deleteSkill,  // V396-16: 删除技能（可选连带删 SKILL.md）
};
