// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// request-context.ts — 每个请求的调用者身份(AsyncLocalStorage)
//
// 为什么需要: 服务层的 LLM 调用(llm-common / llm-client)要按用户记账与计费,
//   但那些函数拿不到 Fastify 的 request —— 逐个改 20+ 个端点的签名既不现实也易漏。
// 实测结论(scripts 曾验证): Fastify 的 onRequest hook 里 als.run() **不会**传播到 handler,
//   必须在"路由处理器入口"run, 才能覆盖 handler 及其 await 的深层服务调用。
//   故 server.ts 在注册路由时统一包一层(见 withRequestContext 的安装处)。
//
// 没有上下文时的语义: userId 为 undefined = 系统调用(定时任务/后台任务),
//   成本账本照记(标 null), 但**不做用户计费**。
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  userId?: string;
  tenantId?: string;
  /** 本次调用已被积分覆盖 —— billing 侧据此跳过 token 计费, 避免同一功能既扣积分又扣额度。
   *  由 points-gate.withPoints 在执行用户任务时置位。 */
  pointsCovered?: boolean;
  /** 本次请求内实际发生的 LLM 调用次数 —— 积分按"真的消耗了"结算,
   *  避免端点提前返回(如"未检索到相关文献")时白白扣费。 */
  llmCalls?: number;
}

const als = new AsyncLocalStorage<RequestContext>();

/** 在给定的调用者身份下执行 fn(路由包装层与后台任务用), 返回值/异常原样透传 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** 当前调用者身份; 不在请求内(后台任务/脚本)时为 undefined */
export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}

/** 当前用户 id; 无上下文或系统调用时 undefined */
export function currentUserId(): string | undefined {
  return als.getStore()?.userId;
}

/** 当前调用是否已被积分覆盖(决定 billing 要不要再按 token 收费) */
export function isPointsCovered(): boolean {
  return als.getStore()?.pointsCovered === true;
}

/** 记一次真实 LLM 调用(供积分按消耗结算); 无请求上下文时忽略 */
export function noteLlmCall(): void {
  const ctx = als.getStore();
  if (ctx) ctx.llmCalls = (ctx.llmCalls ?? 0) + 1;
}

/** 本次请求已发生的 LLM 调用次数(无上下文返回 0) */
export function getLlmCalls(): number {
  return als.getStore()?.llmCalls ?? 0;
}

/**
 * 在"已被积分覆盖"的标记下执行 fn —— 供 points-gate 包裹用户任务使用。
 * 只 set/restore 同一 store 对象上的标记位(不新开 run), 保证异步链路看到一致状态。
 */
export async function markPointsCovered<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = als.getStore();
  if (!ctx) return fn();          // 无请求上下文(后台任务): 没有 billing 需要跳过
  const prev = ctx.pointsCovered;
  ctx.pointsCovered = true;
  try { return await fn(); } finally { ctx.pointsCovered = prev; }
}
