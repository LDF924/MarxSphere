// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ssh-tunnel-service.ts — SSH 远程访问（2026-08-27, Agentero 对照: 远程访问/数据留在用户服务器）
// 能力: 通过 SSH 隧道浏览远程知识库（远程 SAG 实例的文献/文档）
// 方式: ssh -L 端口转发 → 本机代理请求远程 SAG API
// 安全: 凭证在 .env(SSH_HOST/SSH_USER/SSH_KEY); 隧道进程管理; 超时回收
import { execFile, spawn } from "node:child_process";
import net from "node:net";

const SSH_HOST = process.env.SSH_HOST || "";
const SSH_USER = process.env.SSH_USER || "";
const SSH_KEY = process.env.SSH_KEY_PATH || "";
const REMOTE_SAG_PORT = Number(process.env.SSH_REMOTE_SAG_PORT || 4173);

// 活跃隧道: { localPort, proc, createdAt }
const tunnels = new Map<number, { proc: ReturnType<typeof spawn>; createdAt: number }>();

export function sshConfigured(): boolean {
  return !!(SSH_HOST && SSH_USER);
}

/** 建立 SSH 隧道: 本地 127.0.0.1:localPort → 远程 127.0.0.1:REMOTE_SAG_PORT */
export function openSshTunnel(localPort: number): { ok: boolean; port?: number; error?: string } {
  if (!sshConfigured()) return { ok: false, error: "SSH 未配置 (SSH_HOST/SSH_USER)" };
  if (tunnels.has(localPort)) return { ok: true, port: localPort };  // 已存在
  const args = ["-N", "-L", `${localPort}:127.0.0.1:${REMOTE_SAG_PORT}`, `${SSH_USER}@${SSH_HOST}`];
  if (SSH_KEY) args.splice(1, 0, "-i", SSH_KEY);
  try {
    const proc = spawn("ssh", args, { windowsHide: true, stdio: "ignore" });
    tunnels.set(localPort, { proc, createdAt: Date.now() });
    return { ok: true, port: localPort };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 关闭隧道 */
export function closeSshTunnel(localPort: number): boolean {
  const t = tunnels.get(localPort);
  if (!t) return false;
  try { t.proc.kill(); } catch { /* 已退出 */ }
  tunnels.delete(localPort);
  return true;
}

/** 关闭全部隧道 */
export function closeAllTunnels(): void {
  for (const [port] of tunnels) closeSshTunnel(port);
}

/** 隧道状态 */
export function tunnelStatus(): Array<{ port: number; alive: boolean; uptimeSec: number }> {
  return [...tunnels.entries()].map(([port, t]) => ({
    port,
    alive: !t.proc.killed,
    uptimeSec: Math.round((Date.now() - t.createdAt) / 1000),
  }));
}

/** 通过隧道请求远程 SAG API（浏览远程知识库） */
export async function proxyRemoteRequest(localPort: number, path: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const url = `http://127.0.0.1:${localPort}${path}`;
    const resp = await fetch(url, { signal: (AbortSignal as any).timeout(15_000) });
    const data = await resp.json().catch(() => null);
    return resp.ok ? { ok: true, data } : { ok: false, error: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 空闲隧道回收（>30 分钟无访问） */
export function reapIdleTunnels(maxIdleMs = 30 * 60 * 1000): number {
  let reaped = 0;
  for (const [port, t] of tunnels) {
    if (Date.now() - t.createdAt > maxIdleMs) {
      closeSshTunnel(port);
      reaped++;
    }
  }
  return reaped;
}

export const sshTunnelService = {
  sshConfigured,
  openSshTunnel,
  closeSshTunnel,
  closeAllTunnels,
  tunnelStatus,
  proxyRemoteRequest,
  reapIdleTunnels,
};
