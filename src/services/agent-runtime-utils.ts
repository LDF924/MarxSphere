// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-runtime-utils.ts — 借鉴 DSH spill + subprocess 包
// ④ spill: 上下文溢出 → 历史归档到工作区文件（防丢失, 可检索）
// ⑤ subprocess: 集中子进程注册表（统一超时/清理/状态, 防孤儿进程）
import { pool } from "../db/pool.js";
import type { ChildProcess } from "node:child_process";

// ═══ ④ spill: 上下文溢出归档 ═══
/** 归档消息到工作区文件（溢出时调用; 返回归档路径） */
export async function spillMessagesToFile(
  taskId: string,
  messages: Array<{ role: string; content: string }>
): Promise<{ path: string; saved: number } | null> {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const ws = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace", "spill");
    fs.mkdirSync(ws, { recursive: true });
    const file = path.join(ws, `task-${taskId.slice(0, 8)}-${Date.now()}.md`);
    const content = messages.map((m) => `## [${m.role}]\n${m.content}\n`).join("\n");
    fs.writeFileSync(file, content, "utf8");
    console.log(`[agent] 差距P④ spill 归档: ${messages.length} 条 → ${file}`);
    return { path: file, saved: messages.length };
  } catch { return null; }
}

/** 溢出判定: 消息总字符超阈值（默认 600K, 1M 窗口 60%） */
export function shouldSpill(messages: Array<{ role: string; content: string }>): boolean {
  const total = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  const threshold = parseInt(process.env.AGENT_SPILL_THRESHOLD || "600000", 10);
  return total > threshold;
}

// ═══ ⑤ subprocess: 集中子进程注册表 ═══
interface ManagedProcess {
  id: string;
  label: string;
  proc: ChildProcess;
  startedAt: number;
  timeoutMs: number;
  timer?: NodeJS.Timeout;
}

const managedProcesses = new Map<string, ManagedProcess>();

/** 注册子进程（统一超时清理; 返回管理 id） */
export function trackSubprocess(label: string, proc: ChildProcess, timeoutMs = 120_000): string {
  const id = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const rec: ManagedProcess = { id, label, proc, startedAt: Date.now(), timeoutMs };
  // 超时自动清理（防孤儿进程）
  rec.timer = setTimeout(() => {
    if (!proc.killed) {
      console.log(`[agent] 差距P⑤ 子进程超时清理: ${label} (>${Math.round(timeoutMs / 1000)}s)`);
      try { proc.kill(); } catch { /* 已退出 */ }
    }
    managedProcesses.delete(id);
  }, timeoutMs);
  rec.timer.unref?.();
  proc.on("exit", () => { if (rec.timer) clearTimeout(rec.timer); managedProcesses.delete(id); });
  managedProcesses.set(id, rec);
  return id;
}

/** 子进程状态（诊断/运维） */
export function subprocessStatus(): Array<{ id: string; label: string; runningMs: number; alive: boolean }> {
  return [...managedProcesses.values()].map((r) => ({
    id: r.id, label: r.label,
    runningMs: Date.now() - r.startedAt,
    alive: !r.proc.killed,
  }));
}

/** 清理全部子进程（服务关闭时） */
export function killAllSubprocesses(): number {
  let killed = 0;
  for (const [, r] of managedProcesses) {
    if (!r.proc.killed) { try { r.proc.kill(); killed++; } catch { /* ignore */ } }
  }
  managedProcesses.clear();
  return killed;
}

/** 服务启动/关闭注册（index.ts 调用） */
export const agentRuntimeUtils = { spillMessagesToFile, shouldSpill, trackSubprocess, subprocessStatus, killAllSubprocesses };
