// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// base-urls.ts — 进程自身 API 地址的统一解析
//
// 由来(2026-09-11 上云审计): 全仓 8 处写死 `127.0.0.1:4173` / `localhost:4173`, 且分属三个
// 互不相通的环境变量名(AGENT_API_BASE / SAG_INTERNAL_URL / SELF_BASE)。单机跑没问题;
// 跨机部署(容器编排 + 负载均衡)时有两处会真坏:
//   ① Agent 步骤执行器 / 插件 / 定时任务的 self-fetch 打到**自己容器**的环回口 ——
//      服务监听 0.0.0.0 时恰好能用, 一旦只绑内网 IP 或前面挂了 sidecar, 环回口没有监听 → 全部 ECONNREFUSED;
//   ② SSRF 白名单(url-guard)放行的还是 127.0.0.1, 而自我请求实际走服务名 → 被自家防护拦下。
//
// 统一规则: 显式配置优先(三个既有变量名都认, 兼容现存 .env), 否则按 HTTP_HOST/HTTP_PORT 推导 ——
// 这样"服务实际监听在哪"与"自我请求打哪"不可能再分叉。
import { isIP } from "node:net";
import { config } from "../config/env.js";

/** 通配监听地址(本身不可作为目标) → 环回; IPv6 字面量加方括号 */
function formatHost(host: string): string {
  const h = (host || "").trim();
  if (h === "" || h === "0.0.0.0" || h === "::" || h === "[::]") return "127.0.0.1";
  return isIP(h) === 6 ? `[${h}]` : h;
}

/** 显式配置的自我基址(末尾无斜杠); 未配置返回 null */
export function configuredSelfBase(): string | null {
  const raw = process.env.AGENT_API_BASE || process.env.SAG_INTERNAL_URL || process.env.SELF_BASE;
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/**
 * 进程自身 API 的基址(末尾无斜杠)。
 * 多副本/跨机部署: 设 AGENT_API_BASE(或 SAG_INTERNAL_URL / SELF_BASE)为**内部服务名**,
 * 例如 http://sag-api:4173 或 http://10.0.0.12:4173。
 */
export function selfBaseUrl(): string {
  return configuredSelfBase() || `http://${formatHost(config.HTTP_HOST)}:${config.HTTP_PORT}`;
}
