// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// acp-service.ts — BYOA（Bring Your Own Agent）via ACP（2026-08-27, Agentero 对照）
// ACP = Agent Client Protocol（MCP 风格 JSON-RPC）: 连接本机外部 Agent（Claude Code / Codex / 自定义 CLI）
// 不锁定具体 Agent/模型: 通过配置连接任意支持 ACP 的 CLI
// 配置: BYOA_AGENT_COMMAND="claude" BYOA_AGENT_ARGS="--acp" BYOA_AGENT_NAME="Claude Code"
import { spawn } from "node:child_process";

const AGENT_CMD = process.env.BYOA_AGENT_COMMAND || "";
const AGENT_ARGS = (process.env.BYOA_AGENT_ARGS || "").split(/\s+/).filter(Boolean);
const AGENT_NAME = process.env.BYOA_AGENT_NAME || AGENT_CMD || "外部 Agent";

interface AcpMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

let agentProc: ReturnType<typeof spawn> | null = null;
let msgId = 0;
const pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let buffer = "";

export function byoaConfigured(): boolean {
  return !!AGENT_CMD;
}

/** 启动外部 Agent 进程（JSON-RPC over stdio） */
export function startAgent(): { ok: boolean; error?: string } {
  if (agentProc && !agentProc.killed) return { ok: true };
  if (!byoaConfigured()) return { ok: false, error: "BYOA 未配置 (BYOA_AGENT_COMMAND)" };
  try {
    agentProc = spawn(AGENT_CMD, AGENT_ARGS, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    agentProc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const msg = JSON.parse(t) as AcpMessage;
          if (msg.id !== undefined && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
          }
        } catch { /* 非 JSON 行(日志)忽略 */ }
      }
    });
    agentProc.on("exit", () => { agentProc = null; });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 发送 JSON-RPC 请求到外部 Agent */
export function acpRequest(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const start = startAgent();
    if (!start.ok) return reject(new Error(start.error));
    const id = ++msgId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`ACP 请求超时(>${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    const msg: AcpMessage = { jsonrpc: "2.0", id, method, params };
    agentProc?.stdin?.write(JSON.stringify(msg) + "\n");
  });
}

/** 向外部 Agent 发送任务（ACP initialize → task/start → 轮询） */
export async function runExternalAgent(task: string, context?: string): Promise<{ ok: boolean; result?: string; error?: string }> {
  try {
    await acpRequest("initialize", { protocolVersion: 1, clientCapabilities: {} }, 30_000);
    const started = await acpRequest("task/start", {
      task, context: context || "",
      abilities: ["text", "read", "write"],
    }, 30_000);
    const taskId = started?.taskId || started?.id;
    if (!taskId) return { ok: false, error: "外部 Agent 未返回 taskId" };
    // 轮询任务结果
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const status = await acpRequest("task/status", { taskId }, 30_000);
      const s = status?.status || status?.state;
      if (s === "completed" || s === "done") {
        const result = await acpRequest("task/result", { taskId }, 30_000);
        return { ok: true, result: JSON.stringify(result).slice(0, 5000) };
      }
      if (s === "failed" || s === "error" || s === "canceled") {
        return { ok: false, error: `外部 Agent 任务${s}: ${JSON.stringify(status).slice(0, 200)}` };
      }
    }
    return { ok: false, error: "外部 Agent 任务超时(60s)" };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

export const acpService = {
  byoaConfigured,
  startAgent,
  acpRequest,
  runExternalAgent,
};
