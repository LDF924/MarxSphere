// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// url-guard.ts — SSRF 防护: 校验 URL 仅允许访问公网地址
// 拦截: 私网(10/172.16-31/192.168/100.64 CGNAT)/回环(127.*/::1)/链路本地(169.254/fe80::)
//       云元数据端点(169.254.169.254)/0.0.0.0/未指定地址(::)
// 放行 localhost 仅当精确匹配系统自身 API（SELF_BASE, 默认 http://127.0.0.1:4173; 可传 allowSelfBase）
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const GUARD_ERR = "URL 不允许访问内网/本地地址";

/** 系统自身 API 地址（SELF_BASE 环境变量可覆盖; 默认本机 4173） */
export const SELF_BASE = process.env.SELF_BASE || "http://127.0.0.1:4173";

/** 回环别名互通（SELF_BASE 配 127.0.0.1 时 localhost/::1 同样精确放行; 反之亦然） */
const SELF_HOST_ALIASES = ["127.0.0.1", "localhost", "::1"];

interface SelfBaseInfo {
  hostname: string;
  port: string;
}

function parseSelfBase(): SelfBaseInfo | null {
  try {
    const u = new URL(SELF_BASE);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return {
      hostname: u.hostname.toLowerCase().replace(/^\[|\]$/g, ""),
      port: u.port || (u.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return null;
  }
}

/** 判断 URL 是否精确指向系统自身 API（同步、无 DNS; 仅 http/https + host/端口精确匹配 SELF_BASE） */
export function isSelfApiUrl(u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const self = parseSelfBase();
  if (!self) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (port !== self.port) return false;
  if (self.hostname === host) return true;
  return SELF_HOST_ALIASES.includes(self.hostname) && SELF_HOST_ALIASES.includes(host);
}

/** 判断 IP 是否属于内网/回环/链路本地/元数据/保留地址 */
export function isPrivateIp(ip: string): boolean {
  const norm = ip.toLowerCase();
  // IPv4-mapped IPv6（::ffff:127.0.0.1 等）→ 转回 IPv4 判断
  const v4mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPrivateIp(v4mapped[1]);
  if (isIP(norm) === 4) {
    const p = norm.split(".").map(Number);
    if (p[0] === 0 || p[0] === 127) return true; // 0.0.0.0 / 回环 127/8
    if (p[0] === 10) return true; // 10/8
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // 100.64/10 CGNAT
    if (p[0] === 169 && p[1] === 254) return true; // 169.254/16 链路本地（含 169.254.169.254 云元数据）
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16/12
    if (p[0] === 192 && p[1] === 168) return true; // 192.168/16
    return false;
  }
  if (isIP(norm) === 6) {
    if (norm === "::" || norm === "::1") return true; // 未指定 / 回环
    if (norm.startsWith("fe80")) return true; // 链路本地
    if (norm.startsWith("fc") || norm.startsWith("fd")) return true; // ULA fc00/7
    if (norm.startsWith("::ffff:")) return true; // 其余 IPv4-mapped 形式 → 保守拒绝
    return false;
  }
  return true; // 无法识别 → 保守拒绝
}

export interface AssertPublicUrlOptions {
  /** 放行精确匹配系统自身 API 的 localhost/127.0.0.1 地址（默认不传=一律拒绝） */
  allowSelfBase?: boolean;
}

/**
 * SSRF 防护: 校验 URL 仅允许访问公网地址（解析 DNS 后校验所有 IP）; 违规抛 Error
 * @throws Error("URL 不允许访问内网/本地地址") — 协议非 http/https、解析失败或命中内网/本地地址
 */
export async function assertPublicUrl(url: string, opts?: AssertPublicUrlOptions): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(GUARD_ERR);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(GUARD_ERR);
  // 系统自身 API 精确放行（localhost 仅此路径放行）
  if (opts?.allowSelfBase && isSelfApiUrl(u)) return;

  let host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // 国际化域名（中文等）→ punycode ASCII
  if (isIP(host) === 0) {
    try {
      host = domainToASCII(host).toLowerCase();
    } catch {
      throw new Error(GUARD_ERR);
    }
  }

  let ips: string[];
  if (isIP(host) !== 0) {
    ips = [host]; // IP 字面量直接校验
  } else {
    try {
      const r = await lookup(host, { all: true, verbatim: true });
      ips = r.map((a) => a.address);
    } catch {
      throw new Error(GUARD_ERR); // 解析失败（含 DNS 到内网别名等）一律拒绝
    }
    if (ips.length === 0) throw new Error(GUARD_ERR);
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) throw new Error(GUARD_ERR);
  }
}
