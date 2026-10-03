// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// model-price-table.ts — 模型官方单价的**唯一真源**(2026-10-03)
//
// ═══ 为什么要有这个文件 ═══
// 改前同一份"模型单价"在仓里有 **5 套互不相同的值**:
//   ① billing-service.PRICE_PER_MTOKEN   flash 4.0 / v4-pro 16 / qwen-plus 8 / qwen3.7-max 60  ← 用户看到的
//   ② pricing.MODEL_COGS(硬编码副本)    flash 0.27/1.10 / v4-pro 2.16/8.64 …                 ← 算积分用
//   ③ llm_model_prices 表 + cost-ledger seed                                                     ← 记账用
//   ④ cost-service / quota-service(USD, 不分模型, 一对 env)
//   ⑤ agent-task-service(分/步的经验值)
// 用户报「模型单价和官网不一致」时, ① 的四个数**全部高于官方标价**(qwen3.7-max 高了 1.7 倍),
// 而 ②③ 用的又是另一组更低的值 —— 同一件事三种说法, 核对账单时无从下手。
//
// 现在 ①②③ 都从这里取。④⑤ 是**不同量纲**的东西(一个是"分/步"的经验预算,
// 一个是"按 token 折算的美元"), 不并进来, 但也不再冒充"单价"。
//
// ═══ 数据来源(2026-10-03 逐页抄录, 改价时请连同日期一起改) ═══
//   · DeepSeek  https://api-docs.deepseek.com/zh-cn/quick_start/pricing
//   · 阿里云百炼 https://www.alibabacloud.com/help/zh/model-studio/model-pricing
//
// ⚠ 两个必须先说清的口径, 否则抄回来的数字会被误用:
//   · DeepSeek 是**双时段价**: 空闲时段(工作日 9:00-12:00 / 14:00-18:00 之外, 含周末与
//     法定节假日全天)价格是高峰的**一半**。这里 `in/out` 取**高峰价** ——
//     计费不能按最低档收, 否则空闲时段以外全在亏。`offPeak` 单独存, 界面如实展示"空闲减半"。
//   · 百炼按**输入长度分档**(0-32K / 32K-128K / …)。这里取**最常用档**,
//     档位写进 `note`: 数字离开档位就没有意义。

export interface ModelRate {
  /** 元 / 百万 token */
  in: number;
  out: number;
  /** 缓存命中的输入价(DeepSeek 有, 且便宜到只剩零头) */
  cacheHit?: number;
  /** 优惠/空闲时段的价 —— 只在官方明确公布时分档的模型才有 */
  offPeak?: { in: number; out: number };
  /** 口径说明: 哪个档位 / 哪个时段 / 版本差异。**不能只留一个数** */
  note?: string;
}

/**
 * 官方单价表(元 / 百万 token)。
 *
 * 键必须与 `llm-model-registry.ts` 的模型 id 一致 —— 这一列不匹配的后果是
 * "某个模型静默落到 DEFAULT_RATE", 账单会按兜底价算, 而界面上看不出任何异常。
 */
export const MODEL_PRICES: Record<string, ModelRate> = {
  "deepseek-flash": {
    in: 2, out: 8, cacheHit: 0.04,
    offPeak: { in: 1, out: 4 },
    note: "DeepSeek 高峰价(空闲时段为其一半); 实际模型 DeepSeek-V4.1-Flash",
  },
  "deepseek-v4-pro": {
    in: 9, out: 27, cacheHit: 0.30,
    offPeak: { in: 4.5, out: 13.5 },
    note: "DeepSeek 高峰价(空闲时段为其一半)",
  },
  "deepseek-reasoner": {
    in: 9, out: 27, cacheHit: 0.30,
    offPeak: { in: 4.5, out: 13.5 },
    note: "该模型名已并入 V4 系列, 按 pro 档计",
  },
  "qwen3.7-max": {
    in: 12, out: 36, cacheHit: 2.4,
    note: "百炼官方原价(限时 5 折活动以控制台为准)",
  },
  "qwen3-max": { in: 2.5, out: 10, note: "百炼 ≤32K 输入档" },
  "qwen-plus": { in: 0.8, out: 2, note: "百炼 ≤128K 非思考模式档; 思考模式输出更高" },
  "text-embedding-v4": { in: 0.5, out: 0, note: "向量模型不产生输出 token, 出价按 0 计" },
  "qwen3-rerank": { in: 0.5, out: 0, note: "重排模型不产生输出 token, 出价按 0 计" },

  /**
   * ⚠ **Claude 系列(row)刻意不在这里** —— 不是漏了, 是查不到。
   *
   * llm-model-registry 里有 claude-sonnet-4-8 / claude-opus-4-8 / claude-haiku-4-5,
   * 但它们需要用户自己配 Anthropic 端点才用得上, 而且 anthropic 官网定价页在本机
   * **按地区拒绝**(2026-10-03 实测: 页面只回一段 "Claude is only available in certain
   * regions" 的导航壳, 拿不到价格表)。
   *
   * 为什么宁可空着也不填:
   *   这次要修的问题**恰恰是**"单价对不上官网"。凭印象填几个数, 等于把同一个病换个地方犯 ——
   *   而且比原来更糟: 原来那几个数至少还能被看出来是拍的, 抄错来源的数会被当成核对过的。
   *   现在这几个模型落到 DEFAULT_RATE, 界面明写"未收录模型按此价估算"。
   *
   * 要补的话: 从能访问的地区拉 https://platform.claude.com/docs/en/about-claude/pricing,
   *   把 in/out/cacheHit 抄进来并更新 verifiedAt。
   */
};

/**
 * 未收录模型的兜底价。
 *
 * ⚠ 改前兜底是"混合单价 8.0", 折合进/出约 8/8 —— 比表里最便宜的一档贵好几倍。
 *   "不认识"不该等于"按贵的收", 所以取一个中间值, 并在界面上**明确标注这是估计价**。
 */
export const DEFAULT_RATE: ModelRate = {
  in: 2.0,
  out: 8.0,
  note: "未收录模型, 按中档模型估算",
};

/** 模型 → 官方单价; 未收录时返回兜底并带 estimated 标记(调用方据此决定要不要如实说明) */
export function rateFor(model: string): ModelRate & { estimated?: boolean } {
  const r = MODEL_PRICES[model];
  if (r) return r;
  return { ...DEFAULT_RATE, estimated: true };
}

/** 一次调用的成本(元) */
export function costCny(model: string, tokensIn: number, tokensOut: number): number {
  const r = rateFor(model);
  return (tokensIn / 1_000_000) * r.in + (tokensOut / 1_000_000) * r.out;
}
