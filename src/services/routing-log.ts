// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/routing-log.ts — V404-3: 路由决策日志 + 用户抱怨对齐(借鉴 OpenSquilla 路由数据飞轮)
// 轻量闭环, 不做 ML:
//   1. 每次模型轮换决策 append 一条 data/routing-decisions.jsonl
//      {ts, role(场景角色), model, tier(cheap/standard/strong/other), contextTokens(估算),
//       attempts(尝试的模型链), retried, ok, errorType, ms}
//   2. 用户负评(👍👎 系统)接入时: 若该次任务用便宜档 → 记一条"低估"样本到同文件 {event:"underestimate"}
//   3. 定期统计: 按模型聚合"低估率"(underestimate/decisions), 超阈值的建议降权(简单统计, 输出诊断)
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const ROUTING_LOG_FILE = path.resolve(
  process.env.SAG_ROUTING_LOG_FILE || path.join(process.cwd(), "data", "routing-decisions.jsonl")
);

/** 角色名归一(短)— 避免 JSONL 里塞长提示词 */
function shortRole(role: string | undefined): string {
  if (!role) return "general";
  return String(role).slice(0, 24);
}

/** 粗略上下文规模: 由 messages 拼接估算(参考值, 不是精确 token 数) */
export function estimateContextTokens(messages?: Array<{ role: string; content: string }>): number {
  if (!messages) return 0;
  let chars = 0;
  for (const m of messages) chars += (m.content || "").length;
  return Math.round(chars / 2.4); // 中文约 1 字 ≈ 1.5-2 token; 粗估取中值
}

export interface RoutingDecision {
  /** 场景角色: plan/reflect/reason/tool 等 */
  role?: string;
  /** 实际请求的模型(首模型) */
  model: string;
  /** 档位: 由模型名推断 cheap/standard/strong/other */
  tier?: string;
  /** 上下文规模(字符粗估 token) */
  contextTokens?: number;
  /** 尝试过的模型链 */
  attempts?: string[];
  retried?: boolean;
  ok: boolean;
  errorType?: string;
  ms?: number;
  /** 调用用途描述(agentContext.action 或提示词前 60 字) */
  purpose?: string;
}

/** 由模型名推断档位(注册表口径: flash/reason-mini 类=cheap; plus/max=strong; 其余 standard/other) */
export function inferTier(model: string): string {
  const m = String(model || "").toLowerCase();
  if (/flash|mini|cheap|light|small|haiku/i.test(m)) return "cheap";
  if (/pro|max|large|opus|strong/i.test(m)) return "strong";
  if (/plus|v4|sonnet/i.test(m)) return "standard";
  return "other";
}

let lastWriteErrorLoggedAt = 0;
function safeAppend(line: object): void {
  try {
    mkdirSync(path.dirname(ROUTING_LOG_FILE), { recursive: true });
    appendFileSync(ROUTING_LOG_FILE, JSON.stringify(line) + "\n", "utf8");
  } catch (e: any) {
    // 日志失败静默(每 60s 最多打一条, 防刷屏)
    const now = Date.now();
    if (now - lastWriteErrorLoggedAt > 60_000) {
      lastWriteErrorLoggedAt = now;
      console.warn(`[routing-log] 写入失败: ${String(e?.message || e).slice(0, 100)}`);
    }
  }
}

/** 记录一次路由决策(在 llm 轮换处调用, 每成功/失败一次记一条) */
export function logRoutingDecision(d: RoutingDecision): void {
  safeAppend({
    event: "decision",
    ts: new Date().toISOString(),
    role: shortRole(d.role),
    model: d.model,
    tier: d.tier || inferTier(d.model),
    contextTokens: d.contextTokens || 0,
    attempts: d.attempts || [],
    retried: !!d.retried,
    ok: !!d.ok,
    errorType: d.errorType || null,
    ms: d.ms || 0,
    purpose: d.purpose ? String(d.purpose).slice(0, 80) : null,
  });
}

/**
 * 用户负评 → "低估"样本:
 * 该任务最近使用的模型若属便宜档(cheap), 记 underestimate(用户抱怨=当时选便宜了)
 * 迁移 076 后 exec_logs 有 model 列 — 但 logAgentExec 尚未回填, 先查 routing-decisions 里
 * 该任务最近的 decision; 兜底: 记录样本时仅标注(由离线统计自行对照)
 */
export async function logUnderestimateSample(taskId: string, note?: string): Promise<{ model?: string; tier?: string; counted: boolean }> {
  let model: string | undefined;
  let tier: string | undefined;
  let counted = false;
  try {
    const { pool } = await import("../db/pool.js");  // lazy: 模块顶层零 DB 依赖(测试/无库环境可加载)
    // 1. exec_logs 中该任务最近的模型(取 action 含 LLM/规划/反思类)
    const r = await pool.query(
      `select model from agent_exec_logs
       where task_id = $1::uuid and model is not null and model <> ''
       order by id desc limit 1`,
      [taskId]
    );
    if (r.rows[0]?.model) {
      model = r.rows[0].model as string;
      tier = inferTier(model);
    } else {
      // 2. 兜底: 扫 routing-decisions.jsonl 中最近 200 行找该任务
      try {
        if (existsSync(ROUTING_LOG_FILE)) {
          const lines = readFileSync(ROUTING_LOG_FILE, "utf8").split("\n").filter(Boolean).slice(-200);
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const rec = JSON.parse(lines[i]);
              if (rec.taskId === taskId && rec.event === "decision") {
                model = rec.model;
                tier = rec.tier;
                break;
              }
            } catch { /* 坏行跳过 */ }
          }
        }
      } catch { /* 兜底失败忽略 */ }
    }
    counted = tier === "cheap";  // 只有便宜档才算"低估"样本
  } catch { /* DB 不可用 → 不记录 */ }
  safeAppend({
    event: counted ? "underestimate" : "negative_feedback",
    ts: new Date().toISOString(),
    taskId,
    model: model || null,
    tier: tier || null,
    note: note ? String(note).slice(0, 160) : null,
  });
  return { model, tier, counted };
}

export interface UnderestimateStats {
  /** 每模型决策数与低估样本数 */
  byModel: Array<{ model: string; decisions: number; underestimates: number; rate: number; flagged: boolean }>;
  /** 超阈需降权的模型 */
  flagged: string[];
}

/**
 * 统计低估率: 按模型聚合 routing-decisions.jsonl
 * 低估率 = 该模型 underestimate 样本 / 该模型 decision 数(按最近 N 条, 默认 1000)
 * 阈值(默认 0.15)超限 → flagged(建议降权; 不自动改路由, observe-only)
 */
export function routingUnderestimateStats(limit = 1000, threshold = 0.15): UnderestimateStats {
  const byModel = new Map<string, { decisions: number; underestimates: number }>();
  if (existsSync(ROUTING_LOG_FILE)) {
    const lines = readFileSync(ROUTING_LOG_FILE, "utf8").split("\n").filter(Boolean).slice(-limit);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (!rec.model) continue;
        const st = byModel.get(rec.model) || { decisions: 0, underestimates: 0 };
        if (rec.event === "decision") st.decisions++;
        else if (rec.event === "underestimate") st.underestimates++;
        byModel.set(rec.model, st);
      } catch { /* 坏行跳过 */ }
    }
  }
  const out: UnderestimateStats["byModel"] = [];
  for (const [model, st] of byModel) {
    if (st.decisions === 0) continue;
    const rate = st.underestimates / st.decisions;
    out.push({ model, decisions: st.decisions, underestimates: st.underestimates, rate, flagged: rate >= threshold });
  }
  out.sort((a, b) => b.rate - a.rate || b.decisions - a.decisions);
  return { byModel: out, flagged: out.filter((x) => x.flagged).map((x) => x.model) };
}

/** 保留策略: 只保留最近 7 天(避免 JSONL 无限膨胀) — 调用方在服务启动/每日巡检时调用 */
export function trimRoutingLog(retentionDays = 7): number {
  try {
    if (!existsSync(ROUTING_LOG_FILE)) return 0;
    const stat = statSync(ROUTING_LOG_FILE);
    // >5MB 才裁剪(正常量级不动)
    if (stat.size < 5 * 1024 * 1024) return 0;
    const lines = readFileSync(ROUTING_LOG_FILE, "utf8").split("\n").filter(Boolean);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const keep = lines.filter((l) => {
      try {
        const rec = JSON.parse(l);
        return rec.ts && new Date(rec.ts).getTime() >= cutoff;
      } catch { return false; }
    });
    if (keep.length < lines.length) {
      const { writeFileSync } = require("node:fs") as typeof import("node:fs");
      writeFileSync(ROUTING_LOG_FILE, keep.join("\n") + "\n", "utf8");
      return lines.length - keep.length;
    }
    return 0;
  } catch { return 0; }
}
