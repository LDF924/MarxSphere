// SPDX-License-Identifier: Apache-2.0
// pricing.ts — 统一「成本 → 售出价」口径(2026-09-11)
//
// 背景: 此前 billing(按 token 计费) 与 points(按功能计次) 是两套独立口径,
//   同一功能既可能被扣积分又可能被扣订阅额度, 且两边的"1 单位值多少钱"没有对齐。
//   本文件是**唯一**的成本基数, 两侧都从这里取值。
//
// ── 定价依据(2026-09-11 市场调研) ──
// 同类学术 AI 工具普遍采用「订阅 + 积分」混合制:
//   Elicit Plus $10-12/月(12,000 credits) · SciSpace Premium $12/月(1,200 credits)
//   Consensus Pro ~$9-12/月 · Resea Basic $8/月(1,000 积分) · Ponder Casual $8/月(800 积分)
//   (来源: theaiagentindex.com / ponder.ing / toolin.ai, 2026)
// 积分锚点的行业惯例是 $0.005~$0.01/积分(GitHub Copilot / HubSpot 用 $0.01 锚);
//   差距可达 50 倍(Salesforce $0.005 ~ Lovable $0.25), 所以**必须自己锚定并公开**,
//   否则用户无法预估(2026 调研: 55% 买家认为积分制定价最难评估)。
//
// ── 本项目的锚定 ──
//   **1 积分 = ¥0.001, 即 ¥1 = 1000 积分**。
//   为何不用行业常见的 ¥0.01: 实测单位成本仅 ¥0.0002~0.002, 若 1 积分 = ¥0.01
//   则所有功能都进位到 1 积分, 失去区分度(评审与润色同价)。取 ¥0.001 后:
//     编辑器单次 1 积分 · 评审单次 5+ 积分 —— 档位可分辨。
//   换算成订阅: ¥29/月 赠 10000~20000 积分, 与 Elicit/Ponder 的 ±$8/月 同档。
//
// ── 定价公式 ──
//   creditPrice(feature) = ceil( COGS / (1 - TARGET_GROSS_MARGIN) / POINTS_YUAN )
//   TARGET_GROSS_MARGIN = 0.52 —— 2026 年 AI 产品普遍接受的毛利率
//     (传统 SaaS 70-80%; AI 因推理成本随用量增长, 行业实测中位约 52%)
//   COGS 另加 FAILURE_BUFFER(5%) —— 失败/重试的调用也要摊到成功调用上
//   (市场调研明确建议: "Add ~5% to effective COGS for failed/hallucinated calls you can't bill")
//
// ⚠ **COGS 与售价的区别**(2026-09-11 校正):
//   billing-service 的 PRICE_PER_MTOKEN(flash 4.0) 注释写的是"成本", 实际已是**售价**(毛利约 83%);
//   真实 COGS 在 llm_model_prices 表(flash 0.27 进 / 1.10 出)。本文件用**真实 COGS** 做基数,
//   否则积分定价会虚高约 6 倍(billing 的售价已含利润, 再乘一次毛利就重复加价了)。
export const POINTS_YUAN = 0.001;             // 1 积分 = ¥0.001
export const TARGET_GROSS_MARGIN = 0.52;      // 目标毛利率
export const FAILURE_BUFFER = 0.05;           // 失败调用摊销

/** 模型真实成本(元/百万 token, 进/出分离) — 取自 llm_model_prices 表 */
export const MODEL_COGS: Record<string, { in: number; out: number }> = {
  "deepseek-v4-flash": { in: 0.27, out: 1.10 },
  "deepseek-v4-pro": { in: 2.16, out: 8.64 },
  "qwen-plus": { in: 3.60, out: 12.60 },
  "qwen3.7-max": { in: 10.80, out: 36.00 },
};

/**
 * 各功能的实测单位成本模型。
 * 更新方式: 跑一段时间后按
 *   `select endpoint, avg(tokens_in), avg(tokens_out) from llm_usage_ledger group by endpoint`
 * 校准 tokensIn/tokensOut。
 */
export interface FeatureCostModel {
  /** 功能键(与 FEATURE_COST / endpoint 对齐) */
  key: string;
  /** 平均每次输入的 token(实测) */
  tokensIn: number;
  /** 平均每次输出的 token(实测) */
  tokensOut: number;
  /** 计费模型 */
  model: string;
  /** 该功能是否另有非 token 成本(如 Python 沙箱渲染), 单位: 元/次 */
  extraCny?: number;
}

/** 实测成本模型(2026-09-11 取自 llm_usage_ledger 的 in/out 拆分) */
export const FEATURE_COST_MODEL: FeatureCostModel[] = [
  // 编辑器 AI 助手(实测 in≈200 / out≈128)
  { key: "editor:title",    tokensIn: 200, tokensOut: 128, model: "deepseek-v4-flash" },
  { key: "editor:rewrite",  tokensIn: 200, tokensOut: 128, model: "deepseek-v4-flash" },
  { key: "editor:refs",     tokensIn: 150, tokensOut: 100, model: "deepseek-v4-flash" },
  { key: "editor:check",    tokensIn: 430, tokensOut: 270, model: "deepseek-v4-flash" },
  // 图表: LLM 生成代码 + Python 沙箱渲染
  { key: "viz:chart",       tokensIn: 300, tokensOut: 200, model: "deepseek-v4-flash", extraCny: 0.002 },
  // 场景类同步端点(实测 716 tok/次)
  { key: "writing:research", tokensIn: 437, tokensOut: 279, model: "deepseek-v4-flash" },
  { key: "writing:output",   tokensIn: 437, tokensOut: 279, model: "deepseek-v4-flash" },
  { key: "quality:check",    tokensIn: 437, tokensOut: 279, model: "deepseek-v4-flash" },
  { key: "classical:study",  tokensIn: 437, tokensOut: 279, model: "deepseek-v4-flash" },
  { key: "theory:reflect",   tokensIn: 437, tokensOut: 279, model: "deepseek-v4-flash" },
  { key: "academic:research", tokensIn: 437, tokensOut: 279, model: "deepseek-v4-flash" },
  // 论文评审(整篇分片 + 多维评审, 单次消耗显著更高, 按 4 片估)
  { key: "review:paper",    tokensIn: 1950, tokensOut: 1250, model: "deepseek-v4-flash" },
  // 实证分析(含 Python 计算 + LLM 解读)
  { key: "empirical:analyze", tokensIn: 550, tokensOut: 350, model: "deepseek-v4-flash", extraCny: 0.002 },
];

/** 单次调用的成本(人民币) — 按进/出分别计价(输出通常更贵) */
export function featureCogsCny(feature: string): number {
  const m = FEATURE_COST_MODEL.find((x) => x.key === feature);
  if (!m) return 0;
  const p = MODEL_COGS[m.model] ?? { in: 4, out: 4 };
  const tokenCost = (m.tokensIn / 1e6) * p.in + (m.tokensOut / 1e6) * p.out;
  return (tokenCost + (m.extraCny ?? 0)) * (1 + FAILURE_BUFFER);
}

/** 单次调用的建议售价(人民币) */
export function featurePriceCny(feature: string): number {
  const cogs = featureCogsCny(feature);
  if (cogs <= 0) return 0;
  return cogs / (1 - TARGET_GROSS_MARGIN);
}

/** 功能 → 积分定价(向上取整到整数积分; 未登记的返回 0 = 不收费) */
export function featurePoints(feature: string): number {
  const price = featurePriceCny(feature);
  return price <= 0 ? 0 : Math.ceil(price / POINTS_YUAN);
}

/** 定价表(供运营面板展示/调试) */
export function pricingTable(): Array<{ feature: string; cogsCny: number; priceCny: number; points: number }> {
  return FEATURE_COST_MODEL.map((m) => {
    const cogsCny = featureCogsCny(m.key);
    const priceCny = featurePriceCny(m.key);
    return { feature: m.key, cogsCny: Number(cogsCny.toFixed(6)), priceCny: Number(priceCny.toFixed(6)), points: featurePoints(m.key) };
  });
}
