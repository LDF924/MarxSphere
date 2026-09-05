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

// ═══ ⑤ subprocess: 集中子进程注册表(整树终止增强 V404-23H3) ═══
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
  // 超时自动清理（防孤儿进程; V404-23H3: 整树终止）
  rec.timer = setTimeout(() => {
    if (!proc.killed) {
      console.log(`[agent] 差距P⑤ 子进程超时清理: ${label} (>${Math.round(timeoutMs / 1000)}s)`);
      void import("./runtime-guard-events.js").then((m) => m.recordGuardEvent("h3_killtree", "kill", `子进程 ${label} 超时整树终止`)).catch(() => {});
      void killProcessTree(proc);
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

/** 整树终止单进程(借鉴 OpenSquilla process_tree: leader 退出后仍能终止全部子孙 — Windows 用 taskkill /T, POSIX 杀进程组) */
export async function killProcessTree(proc: ChildProcess): Promise<boolean> {
  if (!proc.pid) return false;
  try {
    if (process.platform === "win32") {
      // taskkill /PID <pid> /T /F — 递归杀子孙(等价 Job Object 整树终止; Git Bash 下经 execFile 无路径转换问题)
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve) => {
        execFile("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      });
      return true;
    }
    // POSIX: 杀进程组(负 pid); 失败回退单杀
    try { process.kill(-proc.pid, "SIGKILL"); return true; } catch { proc.kill("SIGKILL"); return true; }
  } catch { return false; }
}

/** 清理全部子进程(整树; 服务关闭时) */
export function killAllSubprocesses(): number {
  let killed = 0;
  for (const [, r] of managedProcesses) {
    if (!r.proc.killed) {
      void import("./runtime-guard-events.js").then((m) => m.recordGuardEvent("h3_killtree", "kill", `关闭清理: ${r.label} 整树终止`)).catch(() => {});
      void killProcessTree(r.proc); killed++;
    }
  }
  managedProcesses.clear();
  return killed;
}

/** 服务启动/关闭注册（index.ts 调用） */
export const agentRuntimeUtils = { spillMessagesToFile, shouldSpill, trackSubprocess, subprocessStatus, killAllSubprocesses, killProcessTree };
