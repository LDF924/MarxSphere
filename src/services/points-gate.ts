// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// points-gate.ts — 把「积分」真正接到业务功能上(2026-09-11)
//
// 背景: points-service 提供了 冻结/核销/归还 的完整机制, 但全仓**没有任何业务模块调用**
//   (`/api/points/freeze` 只有路由自身定义, 零调用者) —— 积分只能靠签到/兑换码进账,
//   没有出口, 等于摆设。本模块是业务侧的统一接入点。
//
// 分层语义(对齐 points-service 头部声明): 与 billing 解耦 ——
//   billing(balance_cents) 计 **token 消耗**, 面向重度用量;
//   积分 计 **功能级消费**, 面向"用一次某功能"的直觉口径。
//
// 开关: POINTS_ENABLED(默认关)。理由: 开启后余额为 0 的账号做这些功能会被 402 拦下,
//   属会改变现有行为的上线动作, 应由运营显式开启(同 V405 其他功能开关纪律)。
import { freezeCharge, settleCharge, rollbackFreeze } from "./points-service.js";
import { markPointsCovered, getLlmCalls } from "./request-context.js";
import { featurePoints, FEATURE_COST_MODEL } from "./pricing.js";

/**
 * 功能级积分定价 —— **从统一定价源 pricing.ts 派生, 不在此硬编码**。
 *
 * 此前这里是手填的 2/5/1, 与 billing 侧的 token 计价各算各的。现统一为:
 *   points = ceil( COGS / (1 - 目标毛利率) / ¥0.01 )
 * 锚定与依据见 pricing.ts 头部(含 2026 市场调研: 1 积分 = ¥0.01, 毛利率 52%, 失败摊销 5%)。
 */
export const FEATURE_COST: Record<string, number> = Object.fromEntries(
  FEATURE_COST_MODEL.map((m) => [m.key, featurePoints(m.key)])
);

export function pointsEnabled(): boolean {
  return process.env.POINTS_ENABLED === "true" || process.env.POINTS_ENABLED === "1";
}

/** 该功能的积分定价; 未登记的功能返回 0(不收费, 便于灰度逐个接入) */
export function featureCost(feature: string): number {
  return FEATURE_COST[feature] ?? 0;
}

/** 积分不足(路由层据此回 402 而不是 500) */
export class InsufficientPointsError extends Error {
  readonly needPoints: number;
  constructor(needPoints: number) {
    super(`积分不足(需要 ${needPoints} 积分)`);
    this.name = "InsufficientPointsError";
    this.needPoints = needPoints;
  }
}

/**
 * 消费闸门: 冻结 → 执行 → 成功核销 / 失败归还
 * refId 用于把冻结与核销对上账(用业务侧的任务 id 即可)。
 * 开关关闭或该功能定价为 0 时直接执行, 不做任何积分操作。
 *
 * 分层(2026-09-11): 执行期间打上"已被积分覆盖"标记 → billing 侧跳过 token 计费,
 *   避免同一功能既扣积分又扣订阅额度(用户视角的"收两次钱")。
 *
 * 计费口径(2026-09-11 校正): **按实际 LLM 消耗结算** ——
 *   端点提前返回(如"知识库中未检索到相关文献"、无证据)时一次 LLM 都没调,
 *   此时必须归还而不是核销(实测过: 早期版本在零消耗的情况下也扣了 5 积分)。
 */
export async function withPoints<T>(
  userId: string,
  feature: string,
  refId: string,
  fn: () => Promise<T>
): Promise<T> {
  const cost = pointsEnabled() ? featureCost(feature) : 0;
  if (cost <= 0) return fn();

  const frozen = await freezeCharge(userId, cost, feature, refId);
  if (!frozen.ok) throw new InsufficientPointsError(cost);

  try {
    const out = await markPointsCovered(fn);
    if (getLlmCalls() > 0) {
      // 核销失败只记日志, 不把已成功的业务结果变成失败(用户已拿到产出)
      const settled = await settleCharge(userId, cost, feature, refId);
      if (!settled.ok) console.error(`[points-gate] 核销失败 ${feature}/${refId}: ${settled.error}`);
    } else {
      // 零消耗(提前返回/检索无结果) → 不收钱
      const back = await rollbackFreeze(userId, cost, feature, refId);
      if (!back.ok) console.error(`[points-gate] 零消耗归还失败 ${feature}/${refId}: ${back.error}`);
    }
    return out;
  } catch (e) {
    const back = await rollbackFreeze(userId, cost, feature, refId);
    if (!back.ok) console.error(`[points-gate] 归还失败 ${feature}/${refId}: ${back.error}`);
    throw e;
  }
}
