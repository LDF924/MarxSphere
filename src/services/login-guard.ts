// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// login-guard.ts — 登录/注册/找回密码的限流
//
// 由来(2026-09-11 上云审计): 全站唯一**无鉴权**的写入入口就是这几个, 而它们此前
// 只有全站令牌限流兜底(且无令牌请求走不到那一层) → 公网上可无限次爆破密码。
// 这里按「IP + 用户名」双维度计数, 到阈值直接拒绝并给出剩余等待秒数。
//
// 语义(刻意选最简单、最不容易写错的):
//   每次尝试**都计数**(含成功)。成功即清零双维度计数 —— 正常用户永远碰不到阈值
//   (>20 次/15 分钟), 而爆破者无论换用户名还是换 IP 都会被其中一维拦住。
//
// DB 可用时计数跨副本共享(多副本部署下逐个副本试密码是常见绕过); 不可用降级为进程内。
import { RateLimiter } from "./rate-limiter.js";

/** 同一 IP 15 分钟内最多 20 次尝试 */
export const loginIpLimiter = new RateLimiter(15 * 60_000, 20, "login-ip:");
/** 同一用户名 15 分钟内最多 10 次尝试(防定向爆破, 与 IP 池轮换无关) */
export const loginUserLimiter = new RateLimiter(15 * 60_000, 10, "login-user:");

export interface LoginGuardResult {
  allowed: boolean;
  retryAfterSec: number;
}

/** 是否允许本次尝试(允许时已计入本次)。被拒时 retryAfterSec 给出剩余等待秒数 */
export async function loginAllowed(ip: string, username: string): Promise<LoginGuardResult> {
  const byIp = await loginIpLimiter.checkAsync(`ip:${ip}`);
  if (!byIp.allowed) return { allowed: false, retryAfterSec: byIp.retryAfterSec };
  const byUser = await loginUserLimiter.checkAsync(`u:${username.toLowerCase()}`);
  if (!byUser.allowed) return { allowed: false, retryAfterSec: byUser.retryAfterSec };
  return { allowed: true, retryAfterSec: 0 };
}

/** 成功后清零双维度计数(避免正常用户被自己之前的手误拖住) */
export function loginSucceeded(ip: string, username: string): void {
  loginIpLimiter.reset(`ip:${ip}`);
  loginUserLimiter.reset(`u:${username.toLowerCase()}`);
}
