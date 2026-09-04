// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/dream-consolidation-service.ts — V404-7: 记忆 Dream 巩固(借鉴 OpenSquilla memory/dream)
// 回合捕获 → 证据门控 → 确定性评分 → LLM 生成补丁 → 人工可审提升(隔离区/收据/回滚)
// 源: task_experience(成功经验) + agent_tasks(用户反馈) + agent_exec_logs
// 流程:
//   1. scanCandidates: 扫描 task_experience, 按 (goal 归一前缀) 聚合 → 候选
//   2. 证据门控: seen_count>=2(跨 ≥2 任务) 或 正评≥1; 负评 ≥1 的不推(记 correction)
//   3. 确定性评分: 频率(对数) + 信号平衡 + 跨天跨度 → ≥ 阈值进候选池
//   4. LLM 补丁: 打磨成精炼记忆(可选 — 不配 LLM 键时用确定性摘要)
//   5. proposals 落盘 data/dream/proposals.jsonl 隔离区; 人工 accept → 写 strategic_memory(回执), reject → quarantine
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pool } from "../db/pool.js";

export const DREAM_DIR = path.resolve(process.env.SAG_DREAM_DIR || path.join(process.cwd(), "data", "dream"));
const PROPOSALS_FILE = path.join(DREAM_DIR, "proposals.jsonl");
const QUARANTINE_FILE = path.join(DREAM_DIR, "quarantine.jsonl");
const RECEIPTS_FILE = path.join(DREAM_DIR, "receipts.jsonl");

/** 证据门控阈值 */
const MIN_SEEN = 2;                       // 同一模式至少出现 2 次才考虑
const MIN_SCORE = 0.5;                    // 确定性评分门槛
const MAX_CANDIDATES_PER_RUN = 10;        // 单次最多生成多少候选(控制 LLM 成本)

export interface DreamCandidate {
  /** 目标归一键(前缀 ≥12 字或含数字年份的截断) */
  key: string;
  goal: string;
  seenCount: number;
  taskIds: string[];
  positiveSignals: number;
  negativeSignals: number;
  /** 跨天跨度(天数) */
  spanDays: number;
  /** 最近一次成功结果摘要(截断) */
  bestResult: string;
  lastSeenAt: string;
}

export interface DreamProposal extends DreamCandidate {
  id: string;
  score: number;
  /** LLM 打磨后的记忆条目(未配 LLM 键时为确定性摘要) */
  polished: string;
  kind: "goal" | "decision" | "constraint" | "milestone" | "preference";
  status: "proposed" | "accepted" | "rejected" | "quarantined";
  createdAt: string;
  decidedAt?: string;
  receipt?: string;
}

// ═══ 捕获与门控 ═══

/** 目标归一: 去掉语气/前缀后截断(≥12 字保特征; 更短的全保留) */
export function normalizeGoalKey(goal: string): string {
  const g = String(goal || "").trim()
    .replace(/^(请|帮我|麻烦|分析下|研究下|写一份|生成|做一次)\s*/g, "")
    .replace(/[，。！？!?、,;\s]+$/g, "")
    .slice(0, 24);
  return g || String(goal || "").trim().slice(0, 24);
}

/** 扫描候选: task_experience 聚合(同一归一 query 出现 ≥minSeen 次; 聚合后过滤, 因不同写法需先归一) */
export async function scanDreamCandidates(opts: { minSeen?: number; days?: number } = {}): Promise<DreamCandidate[]> {
  const minSeen = opts.minSeen ?? MIN_SEEN;
  const days = opts.days ?? 30;
  try {
    const r = await pool.query(
      `select query as goal, user_feedback,
              count(*)::int as n,
              array_agg(distinct id::text) as record_ids,
              min(created_at::date)::text as first_day,
              max(created_at::date)::text as last_day,
              max(created_at) as last_at
       from task_experience
       where created_at > now() - ($1::int || ' days')::interval
         and query is not null and query <> ''
       group by query, user_feedback`,
      [days]
    );
    // 按归一键聚合(跨不同写法)
    const agg = new Map<string, {
      goal: string; n: number; recordIds: Set<string>; pos: number; neg: number;
      firstDay?: string; lastDay?: string; lastAt?: Date; bestResult?: string;
    }>();
    for (const row of r.rows) {
      const key = normalizeGoalKey(row.goal);
      const a = agg.get(key) || { goal: row.goal, n: 0, recordIds: new Set<string>(), pos: 0, neg: 0, firstDay: undefined as string | undefined, lastDay: undefined as string | undefined, lastAt: undefined as Date | undefined };
      a.n += Number(row.n || 0);
      if (row.user_feedback === 1) a.pos += Number(row.n || 0);
      if (row.user_feedback === -1) a.neg += Number(row.n || 0);
      for (const t of (row.record_ids || [])) if (t) a.recordIds.add(t);
      a.firstDay = a.firstDay || row.first_day;
      a.lastDay = row.last_day || a.lastDay;
      a.lastAt = row.last_at || a.lastAt;
      agg.set(key, a);
    }
    const out: DreamCandidate[] = [];
    for (const [key, a] of agg) {
      if (a.n < minSeen) continue;
      if (a.neg > 0) continue; // 有负评的模式不推(证据门控)
      let spanDays = 0;
      try {
        spanDays = a.firstDay && a.lastDay
          ? Math.max(1, Math.round((new Date(a.lastDay).getTime() - new Date(a.firstDay).getTime()) / 86_400_000)) + 1
          : 1;
      } catch { spanDays = 1; }
      out.push({
        key, goal: a.goal, seenCount: a.n, taskIds: [...a.recordIds],
        positiveSignals: a.pos, negativeSignals: a.neg, spanDays,
        bestResult: "", lastSeenAt: a.lastAt ? new Date(a.lastAt).toISOString() : new Date().toISOString(),
      });
    }
    out.sort((x, y) => y.seenCount - x.seenCount || y.spanDays - x.spanDays);
    return out;
  } catch (e: any) {
    console.warn(`[dream] scan 失败: ${String(e?.message || e).slice(0, 120)}`);
    return [];
  }
}

// ═══ 确定性评分 ═══
/** 0-1 分段压缩 */
function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }

/** 评分: 频率(对数) + 跨天跨度 + 正评信号(有正评才给信号分, 负评硬拦 0)
 *  标定: 2次/1天/无正评 → 0.373(拦下); 3次/2天 → 0.527(过); 6次/5天/正评 → 1.0 */
export function scoreCandidate(c: DreamCandidate): number {
  if (c.negativeSignals > 0) return 0;
  const freq = clamp01(Math.log1p(c.seenCount) / Math.log1p(6));        // 2次≈0.565 6次=1
  const span = clamp01(Math.log1p(c.spanDays) / Math.log1p(3));          // 1天≈0.5 3天=1
  const signal = c.positiveSignals > 0 ? 1 : 0;
  return clamp01(0.35 * freq + 0.35 * span + 0.3 * signal);
}

// ═══ 隔离区落盘 ═══
function appendRecord(file: string, rec: object): void {
  try {
    mkdirSync(DREAM_DIR, { recursive: true });
    appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
  } catch (e: any) { console.warn(`[dream] 写入失败 ${file}: ${String(e?.message || e).slice(0, 100)}`); }
}

function readRecords(file: string): DreamProposal[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as DreamProposal; } catch { return null; } })
      .filter((x): x is DreamProposal => !!x);
  } catch { return []; }
}

// ═══ 运行一轮巩固(可定时/手动) ═══
/**
 * runDream: 扫描 → 门控 → 评分 → 打磨(LLM 或确定性) → proposals 隔离区
 * LLM 打磨可选: 不配模型键或用确定性(断言式偏好/决策短句)
 */
export async function runDream(opts: { limit?: number; useLlm?: boolean; days?: number } = {}): Promise<DreamProposal[]> {
  const cands = await scanDreamCandidates({ days: opts.days ?? 30 });
  // 已提过的 key 不去重提交
  const existing = new Set(readRecords(PROPOSALS_FILE).map((p) => p.key));
  const proposals: DreamProposal[] = [];
  for (const c of cands) {
    if (existing.has(c.key)) continue;
    if (proposals.length >= (opts.limit ?? MAX_CANDIDATES_PER_RUN)) break;
    const score = scoreCandidate(c);
    if (score < MIN_SCORE) continue;
    // 打磨: LLM(可选)或确定性
    let polished = "";
    let kind: DreamProposal["kind"] = "goal";
    if (opts.useLlm) {
      try {
        polished = await polishWithLlm(c);
        const k = await classifyKindWithLlm(c);
        if (k) kind = k;
      } catch (e: any) {
        polished = deterministicPolish(c);
        console.warn(`[dream] LLM 打磨失败回退确定性: ${String(e?.message || e).slice(0, 80)}`);
      }
    } else {
      polished = deterministicPolish(c);
    }
    const p: DreamProposal = {
      id: `dp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ...c, score, polished, kind,
      status: "proposed", createdAt: new Date().toISOString(),
    };
    proposals.push(p);
    appendRecord(PROPOSALS_FILE, p);
  }
  return proposals;
}

/** 确定性打磨(不依赖 LLM): 断言式总结 */
export function deterministicPolish(c: DreamCandidate): string {
  const sig = c.positiveSignals > 0 ? `(用户正评 ${c.positiveSignals} 次)` : "";
  return `反复成功完成: 「${c.goal.slice(0, 40)}」出现 ${c.seenCount} 次/跨 ${c.spanDays} 天${sig}; 建议沉淀为可复用流程/模板, 或把该任务定为目标型战略记忆。`;
}

// ═══ LLM 打磨(可选; 无键时调用方已用确定性) ═══
async function polishWithLlm(c: DreamCandidate): Promise<string> {
  const { callLlm } = await import("../ai/llm-common.js");
  const r = await callLlm({
    model: process.env.DREAM_LLM_MODEL || undefined,
    messages: [{
      role: "user",
      content: `把以下"重复出现的成功任务"提炼成一条简短、可复用的记忆条目(用于未来会话注入, 50 字内, 断言式)。\n任务目标: ${c.goal.slice(0, 60)}\n出现次数: ${c.seenCount}, 跨 ${c.spanDays} 天。\n只输出记忆条目本身, 不要解释。`,
    }],
    maxTokens: 120, temperature: 0.2,
  });
  const t = (r?.text ?? "").trim();
  return t || deterministicPolish(c);
}

async function classifyKindWithLlm(c: DreamCandidate): Promise<DreamProposal["kind"] | null> {
  const { callLlm } = await import("../ai/llm-common.js");
  const r = await callLlm({
    messages: [{
      role: "user",
      content: `给这个重复任务分类(仅输出一个词): goal(长期目标)/decision(决策)/constraint(约束)/milestone(里程碑)/preference(偏好)\n任务: ${c.goal.slice(0, 50)}`,
    }],
    maxTokens: 10, temperature: 0,
  });
  const t = (r?.text ?? "").trim().toLowerCase();
  return ["goal", "decision", "constraint", "milestone", "preference"].includes(t) ? t as DreamProposal["kind"] : null;
}

// ═══ 人工审: 提升/驳回 ═══
function updateProposal(id: string, patch: Partial<DreamProposal>): DreamProposal | null {
  const recs = readRecords(PROPOSALS_FILE);
  const idx = recs.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const merged = { ...recs[idx], ...patch, decidedAt: new Date().toISOString() };
  recs[idx] = merged;
  try {
    writeFileSync(PROPOSALS_FILE, recs.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");
  } catch (e: any) {
    console.warn(`[dream] 状态更新失败: ${String(e?.message || e).slice(0, 100)}`);
    return null;
  }
  return merged;
}

/** 提升: 写入 strategic_memory(回执落盘) — 人工审阅后调用 */
export async function acceptProposal(id: string, opts: { projectId?: string } = {}): Promise<{ ok: boolean; receipt?: string; error?: string }> {
  const p = updateProposal(id, { status: "accepted" });
  if (!p) return { ok: false, error: `proposal 不存在: ${id}` };
  try {
    const { recordStrategicMemory } = await import("./strategic-memory-service.js");
    const rec = await recordStrategicMemory({
      projectId: opts.projectId,
      kind: p.kind as any,
      content: p.polished,
      source: "agent", // dream 为 agent 侧自动整理(source 类型仅 user/agent/system)
    });
    const receipt = `accept ${p.id} → strategic_memory#${(rec as any).id} @ ${new Date().toISOString()}`;
    appendRecord(RECEIPTS_FILE, { event: "accept", proposalId: p.id, key: p.key, memoryId: (rec as any).id, ts: new Date().toISOString() });
    p.receipt = receipt;
    updateProposal(id, { receipt });
    return { ok: true, receipt };
  } catch (e: any) {
    // 写入失败 → 状态回滚为 proposed(不丢)
    updateProposal(id, { status: "proposed" });
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 驳回 → quarantine 隔离区(可审计) */
export function rejectProposal(id: string, reason?: string): { ok: boolean; error?: string } {
  const p = updateProposal(id, { status: "rejected" });
  if (!p) return { ok: false, error: `proposal 不存在: ${id}` };
  appendRecord(QUARANTINE_FILE, { proposalId: id, key: p.key, reason: reason || "人工驳回", ts: new Date().toISOString() });
  return { ok: true };
}

/** 列表: proposals + 隔离区 + 回执(前端审计面板) */
export function listDreamState(): { proposals: DreamProposal[]; quarantine: DreamProposal[]; receipts: unknown[] } {
  return {
    proposals: readRecords(PROPOSALS_FILE),
    quarantine: readRecords(QUARANTINE_FILE),
    receipts: readRecords(RECEIPTS_FILE),
  };
}

/** 回滚已提升的记忆(人工发现错误时): 从 strategic_memory 删除 + 记回执 */
export async function rollbackAccepted(id: string): Promise<{ ok: boolean; error?: string }> {
  const p = readRecords(PROPOSALS_FILE).find((x) => x.id === id);
  if (!p) return { ok: false, error: `proposal 不存在: ${id}` };
  if (!p.receipt) return { ok: false, error: "该条无回执(未提升或回执丢失)" };
  const m = /strategic_memory#(\d+)/.exec(p.receipt);
  if (m) {
    try {
      await pool.query(`delete from strategic_memory where id = $1`, [Number(m[1])]);
    } catch { /* 删除失败继续标记 */ }
  }
  updateProposal(id, { status: "proposed", receipt: undefined });
  appendRecord(RECEIPTS_FILE, { event: "rollback", proposalId: id, ts: new Date().toISOString() });
  return { ok: true };
}
