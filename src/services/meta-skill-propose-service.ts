// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/meta-skill-propose-service.ts — V404-10: auto_propose → MetaSkill DAG 衔接
// 桥接: agent_skills 已批准技能 + 高频任务主题 → LLM 组装声明式步骤 DAG 提案
// 人工审(隔离区 proposals.jsonl) → accept 进运行时注册表(DB) → /api/meta-skill/list 可见可跑
// 红线: 提案不自动 accept; 不自动进全局 META_SKILLS(静态); 由人工审后注册
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { callLlm } from "../ai/llm-common.js";

export const DAG_PROPOSALS_DIR = path.resolve(process.env.SAG_DAG_PROPOSALS_DIR || path.join(process.cwd(), "data", "dag-proposals"));
const PROPOSALS_FILE = path.join(DAG_PROPOSALS_DIR, "proposals.jsonl");

export interface DagProposal {
  id: string;
  /** 源技能 id 列表 */
  sourceSkillIds: number[];
  sourceSkillNames: string[];
  /** 触发主题(高频目标) */
  triggerGoal: string;
  seenCount: number;
  dag: { id: string; name: string; description: string; trigger?: string; steps: unknown[] };
  status: "proposed" | "accepted" | "rejected";
  createdAt: string;
  decidedAt?: string;
}

function readProposals(): DagProposal[] {
  if (!existsSync(PROPOSALS_FILE)) return [];
  try {
    return readFileSync(PROPOSALS_FILE, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as DagProposal; } catch { return null; } })
      .filter((x): x is DagProposal => !!x);
  } catch { return []; }
}

function writeProposals(list: DagProposal[]): void {
  try {
    mkdirSync(DAG_PROPOSALS_DIR, { recursive: true });
    writeFileSync(PROPOSALS_FILE, list.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");
  } catch (e: any) { console.warn(`[dag-propose] 写入失败: ${String(e?.message || e).slice(0, 100)}`); }
}

/** 组装 DAG 提示: 给 LLM 一组已批准技能 + 高频主题, 让它生成步骤 DAG */
function buildDagPrompt(goal: string, skills: Array<{ name: string; whenToApply: string; skillMd: string }>): string {
  const skillList = skills.map((s, i) => `${i + 1}. ${String(s.name || "未命名")}: ${String(s.when_to_apply || s.whenToApply || "")} — ${String(s.skill_md || s.skillMd || "").slice(0, 80)}`).join("\n");
  return [
    "你是工作流设计师。把下面的一组技能编排成一条声明式 MetaSkill DAG(步骤数组)。",
    `高频任务: ${goal.slice(0, 80)}`,
    `可用技能(全部 approved):\n${skillList}`,
    "",
    "要求: 1) 步骤 id 唯一(kebab-case), 每步 kind ∈ agent/llm_chat/llm_classify/tool_call/llm_gate/user_input;",
    "2) 用 depends_on 表达依赖(前一步产出给后一步用 {{outputs.<id>}});",
    "3) 最后一步应为 llm_gate 质量门(检查产出是否含来源标注/是否答非所问);",
    "4) 若技能不够覆盖某环节, 可用 llm_chat 补一个通用步骤说明要做什么;",
    "5) 3-6 步为宜, 每步给 label(中文)和 with 参数(把技能要点写进 system/task 提示)。",
    "只输出 JSON: {\"name\":\"名称(≤14字)\",\"description\":\"一句话用途\",\"trigger\":\"触发短语\",\"steps\":[{...}]}",
  ].join("\n");
}

/**
 * 为某高频目标自动组装 DAG 提案(LLM 生成; 失败返回 null 不硬造)
 * @param goal 高频任务目标
 * @param seenCount 出现次数(证据)
 * @param skillIds 参与编排的已批准技能 id(可为空 → 全 approved)
 */
export async function proposeMetaSkillDag(goal: string, seenCount: number, skillIds?: number[]): Promise<DagProposal | null> {
  try {
    const { pool } = await import("../db/pool.js");
    let r;
    if (skillIds && skillIds.length > 0) {
      r = await pool.query(
        "select id, name, when_to_apply, skill_md from agent_skills where status='approved' and id = any($1::int[])",
        [skillIds]
      );
    } else {
      r = await pool.query("select id, name, when_to_apply, skill_md from agent_skills where status='approved' order by consensus desc limit 5");
    }
    const skills = r.rows;
    if (skills.length === 0) return null;
    const model = process.env.META_DAG_LLM_MODEL || undefined;
    const llm = await callLlm({
      model,
      messages: [{ role: "user", content: buildDagPrompt(goal, skills) }],
      maxTokens: 2000, temperature: 0.2,
    });
    const text = (llm?.text || "").replace(/```json|```/g, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed.name || !Array.isArray(parsed.steps) || parsed.steps.length < 2) return null;
    // 步骤 id 唯一性兜底
    const seen = new Set<string>();
    for (const s of parsed.steps) {
      if (!s.id) s.id = `step_${Math.random().toString(36).slice(2, 6)}`;
      if (seen.has(s.id)) s.id = `${s.id}_${Math.random().toString(36).slice(2, 4)}`;
      seen.add(s.id);
    }
    const proposal: DagProposal = {
      id: `dagp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      sourceSkillIds: skills.map((s: any) => Number(s.id)),
      sourceSkillNames: skills.map((s: any) => String(s.name)),
      triggerGoal: goal,
      seenCount,
      dag: {
        id: `dag_${Math.random().toString(36).slice(2, 8)}`,
        name: String(parsed.name).slice(0, 20),
        description: String(parsed.description || `自动编排: ${goal.slice(0, 40)}`).slice(0, 120),
        trigger: parsed.trigger ? String(parsed.trigger).slice(0, 60) : undefined,
        steps: parsed.steps,
      },
      status: "proposed",
      createdAt: new Date().toISOString(),
    };
    writeProposals([...readProposals(), proposal]);
    return proposal;
  } catch (e: any) {
    console.warn(`[dag-propose] 失败: ${String(e?.message || e).slice(0, 150)}`);
    return null;
  }
}

/** 列出提案(前端审阅) */
export function listDagProposals(): DagProposal[] { return readProposals(); }

/** 人工 accept → 写入运行时动态 DAG 表(agent_meta_dags: id/dag_json/enabled) */
export async function acceptDagProposal(id: string): Promise<{ ok: boolean; error?: string; dagId?: string }> {
  const list = readProposals();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, error: "提案不存在" };
  const p = list[idx];
  if (p.status !== "proposed") return { ok: false, error: `提案状态 ${p.status}, 仅 proposed 可接受` };
  try {
    const { pool } = await import("../db/pool.js");
    const dagId = p.dag.id;
    // 幂等: 同 dagId 覆盖
    await pool.query(
      `insert into agent_meta_dags (id, name, description, dag_json, enabled, created_at)
       values ($1, $2, $3, $4::jsonb, true, now())
       on conflict (id) do update set dag_json = excluded.dag_json, enabled = true, updated_at = now()`,
      [dagId, p.dag.name, p.dag.description, JSON.stringify({ ...p.dag, id: dagId })]
    );
    p.status = "accepted";
    p.decidedAt = new Date().toISOString();
    writeProposals(list);
    return { ok: true, dagId };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 人工 reject */
export function rejectDagProposal(id: string): { ok: boolean; error?: string } {
  const list = readProposals();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, error: "提案不存在" };
  list[idx].status = "rejected";
  list[idx].decidedAt = new Date().toISOString();
  writeProposals(list);
  return { ok: true };
}

export const metaSkillProposeService = { proposeMetaSkillDag, listDagProposals, acceptDagProposal, rejectDagProposal };
