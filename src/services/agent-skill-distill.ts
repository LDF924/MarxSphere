// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
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
export async function proposeSkill(taskId: string, goal: string, result: string, toolsUsed: string[], opts?: { minResultChars?: number }): Promise<DistilledSkill | null> {
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
    // V404-8: minResultChars 可配(auto-propose 用 60 — 高频任务上下文紧凑; 默认 200 保轨迹完整)
    const minChars = opts?.minResultChars ?? 200;
    if (!result || result.length < minChars) return null;
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
    const name = String(parsed.name).slice(0, 30);

    // V417: **同名即强化, 不再克隆**。
    // 原来是无条件 insert, 同一个技能被反复蒸馏就多一行 —— 实测 skill 库 144 行只有 15 个不同名字,
    // 其中两个技能占了 134 行(93%)。"天天在更新"是真的, 但方向反了: 越用越冗余, 不是越用越熟。
    // 命中同名的正确动作是把它**用厚**: 追加来源任务(于是 source_tasks 不再是单元素),
    // 并保留原有内容与校验结论, 不重复走一遍 EDV。
    const dup = await pool.query(
      `select * from agent_skills where name = $1 order by (status = 'approved') desc, consensus desc, id limit 1`,
      [name]
    );
    if (dup.rows.length > 0) {
      const cur = mapRow(dup.rows[0]);
      const tasks = Array.isArray(cur.sourceTasks) ? cur.sourceTasks : [];
      await pool.query(
        `update agent_skills
            set source_tasks = case when $2 = any(source_tasks) then source_tasks else array_append(source_tasks, $2) end
          where id = $1`,
        [cur.id, taskId]
      );
      return { ...cur, sourceTasks: [...new Set([...tasks, taskId])] };
    }

    const ins = await pool.query(
      `insert into agent_skills (name, when_to_apply, skill_md, source_tasks, distilled_by, status)
       values ($1,$2,$3,$4::text[],'agent','pending') returning *`,
      [name, String(parsed.when_to_apply).slice(0, 100), String(parsed.skill_md).slice(0, 500), [taskId]]
    );
    // V417: 立刻建向量索引 —— 否则新技能只进 agent_skills 不进 skill_embeddings,
    // 语义召回永远捞不到它(实测历史 144 条蒸馏技能与 189 条向量**零交集**, 就是这么来的)。
    void indexSkillEmbedding(String(ins.rows[0].name), String(ins.rows[0].when_to_apply || ""), String(ins.rows[0].skill_md || ""));
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

/**
 * V417: 把一条蒸馏技能写进 skill_embeddings, 让语义召回能捞到它。
 *
 * 为什么必须做: 实测 agent_skills(144 条) 与 skill_embeddings(189 条)**交集为 0** ——
 * 蒸馏出来的技能从来没有向量。而关键词召回又在中文上失效(见 recallSkills 注释),
 * 于是两条路同时断掉, 技能库事实上不会被任何任务用上。
 * 失败不抛: 向量只是加速器, 技能本身已入库。
 */
export async function indexSkillEmbedding(name: string, whenToApply: string, skillMd: string): Promise<boolean> {
  try {
    const { embeddingClient } = await import("../ai/embedding-client.js");
    // 用 when_to_apply + skill_md 头部做向量 —— 召回时匹配的是"什么时候用得上", 不是名字
    const text = `${whenToApply}\n${skillMd}`.slice(0, 2000);
    const [vec] = await embeddingClient.batchGenerate([text]);
    if (!vec?.length) return false;
    await pool.query(
      `insert into skill_embeddings (skill_name, embedding, source, updated_at)
       values ($1, $2::vector, 'distilled', now())
       on conflict (skill_name) do update set embedding = excluded.embedding, updated_at = now()`,
      [name, JSON.stringify(vec)]
    );
    return true;
  } catch (e: unknown) {
    console.warn(`[skill-distill] 向量索引失败(不影响技能入库): ${String((e as Error)?.message || e).slice(0, 120)}`);
    return false;
  }
}

/**
 * 取一段中文文本里"像关键词"的片段。
 *
 * 为什么不用原来那套 `split(/[\s,，、]+/)`: **中文目标句通常整句没有一个空格**,
 * 切出来就是"从劳动过程理论概念中提炼交叉接口并生成研究选题"这样一个 22 字的"关键词",
 * 拿去做 `ilike '%…%'` 永远匹配不上 —— 实测中文目标下召回率恒为 0。
 * 这里改成抽 2-3 字的连续汉字片段(近似 bigram), 让 ilike 至少有命中的可能。
 */
export function extractSearchTerms(query: string, max = 8): string[] {
  const out: string[] = [];
  const STOP = new Set(["什么", "怎么", "如何", "能否", "可以", "研究", "分析", "问题", "理论", "一个", "以及", "并且", "进行", "方法", "基于"]);
  // 连续 2-3 个汉字
  for (const m of query.matchAll(/[一-龥]{2,3}/g)) {
    const t = m[0];
    if (!STOP.has(t) && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * V417: 语义召回蒸馏技能 —— 中文目标真正能用的那条路。
 * 走 skill_embeddings 余弦相似度, 只保留 status='approved' 的蒸馏技能。
 * 任何一步失败都返回空数组(调用方会退回关键词路径), 绝不抛。
 */
export async function recallSkillsSemantic(query: string, limit = 3, minSimilarity = 0.45): Promise<DistilledSkill[]> {
  try {
    const { embeddingClient } = await import("../ai/embedding-client.js");
    const [qvec] = await embeddingClient.batchGenerate([query.slice(0, 500)]);
    if (!qvec?.length) return [];
    // 距离算在 SQL 里: pgvector 的 <=> 是余弦距离(1-相似度)。只比"蒸馏技能"这个名字空间。
    // V417: **按名字去重** —— agent_skills 里有重名(144 行 / 139 个不同名字),
    // 一个名字只映射一条向量, join 回来就会把同一技能返回多次(实测: 三条一样的"多跳归因推理"),
    // 注入时等于把同一段技能内容重复塞给模型。
    const r = await pool.query(
      `select distinct on (a.name) a.*, 1 - (e.embedding <=> $1::vector) as similarity
         from skill_embeddings e
         join agent_skills a on a.name = e.skill_name
        where a.status = 'approved'
        order by a.name, e.embedding <=> $1::vector`,
      [JSON.stringify(qvec)]
    );
    return (r.rows as Array<Record<string, unknown>>)
      .filter((x) => Number(x.similarity) >= minSimilarity)
      .sort((a, b) => Number(b.similarity) - Number(a.similarity))   // distinct on 已按名字分组, 需再按相似度排
      .slice(0, limit)
      .map(mapRow);
  } catch (e: unknown) {
    console.warn(`[skill-distill] 语义召回失败(退回关键词): ${String((e as Error)?.message || e).slice(0, 120)}`);
    return [];
  }
}

/** 检索技能: 按适用条件/名称匹配（任务规划时注入; V4: 同 goal 短期去重） */
export async function recallSkills(query: string, limit = 3): Promise<DistilledSkill[]> {
  // V4: 频控 — 同 goal 5 分钟内已注入过 → 跳过
  const cacheKey = query.slice(0, 40);
  const lastInjected = skillInjectionCache.get(cacheKey);
  if (lastInjected && Date.now() - lastInjected < SKILL_INJECT_TTL_MS) {
    return [];
  }

  // V417: **先走语义召回** —— 这是中文目标唯一能命中的路。
  // 原来只有关键词路径, 而它按空格/标点分词: 中文目标句整句没空格, 切出来是一个 22 字的"词",
  // ilike 恒不命中(实测召回率 0, 144 条技能因此从未被任何任务用上)。
  const sem = await recallSkillsSemantic(query, limit);
  if (sem.length > 0) {
    skillInjectionCache.set(cacheKey, Date.now());
    return sem;
  }

  // 退回关键词路径: 用 extractSearchTerms 抽 2-3 字片段(原来那套切法对中文无效)
  const keywords = extractSearchTerms(query, 8).slice(0, 3);
  if (keywords.length === 0) return [];
  const conds = keywords.map((_, i) => `(name ilike $${i + 1} or when_to_apply ilike $${i + 1} or skill_md ilike $${i + 1})`).join(" or ");
  const params = keywords.map((k) => `%${k}%`);
  // V417: 排序在 consensus 之前先看**实际用过几次、成功了没有** —— 技能库要"越用越熟",
  // 召回就得优先给验证过效果的, 而不是只看入库时的校验票数。
  // 注: use_count/success_count 由 skill-usage-tracker 回写(迁移 148)。
  const r = await pool.query(
    `select * from agent_skills where status = 'approved' and (${conds})
      order by success_count desc, use_count desc, consensus desc limit $${params.length + 1}`,
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
