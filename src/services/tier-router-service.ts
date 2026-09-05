// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// tier-router-service.ts — V405 OpenSquilla 移植 P1+P5-ML: 三档成本路由 + 决策审计 + 本地分类器融合
// 设计(对齐 OpenSquilla SquillaRouter 思想):
//   lite    — 单点事实/概念短题 → 直接生成(跳过 MCP 全链路), 省钱
//   standard— 默认: 52 步 template 全链路(保 0.884 基线口径)
//   deep    — 政策/比较/综述/引证核验深链 → 全链路 + 完整自愈链(expandQuery/HyDE/entity boost 不退让)
// 决策源(保守融合, 宁深勿浅):
//   1. 规则强信号(policy/长引证) → deep(不咨询 ML)
//   2. ML 本地分类器(scripts/ml-router/predict_router.py, 人工标签二分类 lite/deep)自信判 deep → deep
//      — 捕获规则漏判的 比较/综述/理论对接/机制分析 类(此前冒烟验证的关键缺口)
//   3. 其余 → 规则默认(standard; 短概念题 lite)
// ML 只做"升级 deep"不做降级 → 方向安全(误升级多花钱, 不降级不损质量)。
// 默认开关 ROUTER_ENABLED=false → 行为与现网完全一致(基线不动)。
// 决策每次落 audit 表(审计/调优数据源, 同 OpenSquilla router_decisions)。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pool } from "../db/pool.js";

export type TierLevel = "lite" | "standard" | "deep";
export type RouterDecisionSource = "rule_type" | "rule_len" | "rule_deep" | "ml_deep_upgrade" | "default";

export interface TierDecision {
  level: TierLevel;
  reason: string;
  source: RouterDecisionSource;
  estimatedSavingsPct: number; // 相对 standard 全链路的估算省幅(用于审计观察)
}

/** V405: 开关(默认关 — 保 0.884 基线; 评测验证后可置 true) */
export const routerEnabled = (): boolean => process.env.ROUTER_ENABLED === "1" || process.env.ROUTER_ENABLED === "true";

/** V405-ML: ML 分类器独立开关(默认随 ROUTER_ENABLED; 可单独关) */
const mlRouterEnabled = (): boolean => routerEnabled() && process.env.ML_ROUTER_ENABLED !== "0";

/** 深度档阈值(可 env 覆盖, 评测用) */
const DEEP_MAX_LEN = parseInt(process.env.ROUTER_DEEP_MAX_LEN || "1000", 10);

/** Python 解释器与推理脚本(可 env 覆盖; 默认 cognee venv + 仓库内 predict_router.py) */
const ML_PYTHON = process.env.ML_ROUTER_PYTHON || "C:/Users/HUAWEI/cognee/.venv312/Scripts/python.exe";
const SAG_ROOT = process.env.SAG_ROOT || process.cwd();
const ML_SCRIPT = path.join(SAG_ROOT, "scripts", "ml-router", "predict_router.py");
let _mlAssetsChecked: boolean | null = null;

function mlAssetsReady(): boolean {
  if (_mlAssetsChecked !== null) return _mlAssetsChecked;
  _mlAssetsChecked = existsSync(path.join(SAG_ROOT, "data", "ml-router", "lgbm_bin.txt"))
    && existsSync(ML_SCRIPT);
  return _mlAssetsChecked;
}

/** 纯函数档位决策(可单测, 无 IO):
 *  deep: policy_evaluation 恒定(政策题需要法条定位+引证核验); multi_hop 且长文(>120)也走 deep
 *  lite: concept_definition/factual_retrieval 且短(<=60, 同 auto-adaptive 口径)
 *  其余: standard
 */
export function decideTier(query: string, qtype: string, explicitMode?: "template" | "adaptive" | undefined): TierDecision {
  // 显式指定模式时不算路由(评测/消融需精确口径)
  if (explicitMode === "adaptive" || explicitMode === "template") {
    return { level: "standard", reason: `explicit_mode=${explicitMode}(评测口径)`, source: "default", estimatedSavingsPct: 0 };
  }
  const len = query.length;
  if (qtype === "policy_evaluation") {
    return { level: "deep", reason: "policy_evaluation(法条定位+引证核验)", source: "rule_type", estimatedSavingsPct: 0 };
  }
  if (qtype === "multi_hop_reasoning") {
    // 短多跳仍按 standard; 长多跳/含引证要求 → deep
    const deepHint = /引用|原文|条款|出处|页码|哪篇|文献|对比|论证过程/.test(query);
    if (len > DEEP_MAX_LEN || (len > 60 && deepHint)) {
      return { level: "deep", reason: "multi_hop+长文/引证要求", source: "rule_len", estimatedSavingsPct: 0 };
    }
    return { level: "standard", reason: "multi_hop(需要多步检索)", source: "rule_type", estimatedSavingsPct: 0 };
  }
  if ((qtype === "concept_definition" || qtype === "factual_retrieval") && len <= 60) {
    return { level: "lite", reason: `simple_${qtype}(len=${len})`, source: "rule_len", estimatedSavingsPct: 80 };
  }
  return { level: "standard", reason: `${qtype}(常规)`, source: "default", estimatedSavingsPct: 0 };
}

// ─── V405-ML: 本地分类器预测(人工标签二分类 lite/deep) ─────────────────────

export interface MlPrediction {
  label: "lite" | "deep" | "standard";
  probDeep: number;
  confident: boolean;
}

/** spawn predict_router.py 单次预测; 超时/缺资产/解析失败 → null(调用方走规则, 不冒险) */
export function predictWithMl(query: string, timeoutMs = 20_000): Promise<MlPrediction | null> {
  return new Promise((resolve) => {
    if (!mlRouterEnabled() || !mlAssetsReady()) return resolve(null);
    execFile(ML_PYTHON, [ML_SCRIPT, query.slice(0, 500)], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout.trim().split("\n").pop() || "{}") as MlPrediction & { err?: string };
        if (j.err) return resolve(null);
        if (j.label !== "lite" && j.label !== "deep") return resolve(null);
        return resolve({ label: j.label, probDeep: Number(j.probDeep ?? 0), confident: j.confident !== false });
      } catch { resolve(null); }
    });
  });
}

/** 保守融合决策(异步; 唯一外部决策入口):
 *  1. 显式模式 → standard(评测口径)
 *  2. 规则 deep(政策/长引证) → deep(不咨询 ML)
 *  3. ML 自信判 deep → deep(升级捕获规则漏判; 只升级不降级)
 *  4. 其余 → decideTier 规则结果
 */
export async function decideTierHybrid(
  query: string,
  qtype: string,
  explicitMode?: "template" | "adaptive" | undefined,
): Promise<TierDecision> {
  if (explicitMode === "template" || explicitMode === "adaptive") {
    return { level: "standard", reason: `explicit_mode=${explicitMode}(评测口径)`, source: "default", estimatedSavingsPct: 0 };
  }
  // 规则强 deep 信号优先(保护性, 不咨询 ML)
  const rule = decideTier(query, qtype);
  if (rule.level === "deep") return rule;
  // ML 升级检查(仅在开关开启且资产就绪时)
  if (routerEnabled() && mlAssetsReady()) {
    try {
      const ml = await predictWithMl(query);
      if (ml && ml.confident && ml.label === "deep") {
        return {
          level: "deep",
          reason: `ml_deep_upgrade(prob=${ml.probDeep.toFixed(2)})`,
          source: "ml_deep_upgrade",
          estimatedSavingsPct: 0,
        };
      }
    } catch { /* ML 不可用 → 规则结果 */ }
  }
  return rule;
}

/** 决策落审计表(异步 fire-and-forget; 失败静默 — 审计不阻塞推理) */
export function recordTierDecision(d: {
  query: string;
  qtype: string;
  level: TierLevel;
  reason: string;
  mode?: string;
  taskId?: string | null;
}): void {
  if (!routerEnabled()) return;
  pool.query(
    `insert into router_audit (query, qtype, level, reason, mode, task_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [d.query.slice(0, 500), d.qtype, d.level, d.reason, d.mode ?? "auto", d.taskId ?? null]
  ).catch((e) => console.error("[tier-router] audit failed:", e?.message?.substring(0, 100)));
}

/** 审计统计(前端/脚本用): 各档次数 + 平均耗时估算 */
export async function getRouterAudit(days = 7): Promise<{
  total: number;
  byLevel: Record<string, number>;
  liteRate: number;
  rows: Array<{ query: string; qtype: string; level: string; reason: string; mode: string; created_at: string }>;
}> {
  try {
    const r = await pool.query(
      `select query, qtype, level, reason, mode, created_at from router_audit
       where created_at > now() - make_interval(days => $1)
       order by created_at desc limit 200`,
      [days]
    );
    const rows = r.rows.map((row: any) => ({
      query: String(row.query), qtype: String(row.qtype), level: String(row.level),
      reason: String(row.reason), mode: String(row.mode),
      created_at: new Date(row.created_at).toLocaleString("zh-CN"),
    }));
    const total = rows.length;
    const byLevel: Record<string, number> = {};
    for (const row of rows) byLevel[row.level] = (byLevel[row.level] ?? 0) + 1;
    return { total, byLevel, liteRate: total > 0 ? (byLevel.lite ?? 0) / total : 0, rows };
  } catch {
    return { total: 0, byLevel: {}, liteRate: 0, rows: [] };
  }
}

export const tierRouterService = {
  decideTier,
  decideTierHybrid,
  predictWithMl,
  recordTierDecision,
  getRouterAudit,
  routerEnabled,
  mlRouterEnabled,
};
