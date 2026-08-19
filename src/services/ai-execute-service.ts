// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ai-execute-service — 面板 → Claude Code 执行桥
 *
 * 通过 child_process 调 claude CLI（-p 非交互模式），
 * 让面板按钮触发 Claude 执行任务（自动使用已装的 skills/MCP）。
 *
 * 认证：从 CC-switch（第三方网关）读取当前 provider 的环境变量
 * （ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / 模型映射），
 * 与用户日常 Claude Code 完全一致。
 *
 * 用法：POST /api/ai-execute { prompt, cwd?, timeoutMs? }
 *
 * 重要：不用 cmd.exe /c 调 claude（多行 prompt 会被 cmd 当命令分隔符拆碎，
 * 导致 claude 收到残缺参数后卡死到超时）。改为直接 spawn claude.exe，
 * prompt 走 stdin 传入——换行/中文/引号零损耗。
 */

// claude.exe 真实路径（npm shim 的 claude.cmd 最终指向这里）
const CLAUDE_EXE = path.join(
  process.env.APPDATA || "",
  "npm",
  "node_modules",
  "@anthropic-ai",
  "claude-code",
  "bin",
  "claude.exe"
);

// 纯文本归纳任务禁用的工具（防 Claude 尝试查库/读文件/联网）
const NO_TOOLS_DISALLOW = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"];

// CC-switch 数据库路径（第三方网关配置）
const CC_SWITCH_DB = path.join(os.homedir(), ".cc-switch", "cc-switch.db");

/** 从 CC-switch db 读取当前 claude provider 的 env 配置 */
function readCcSwitchEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    if (!fs.existsSync(CC_SWITCH_DB)) return env;
    // 用 python 读 sqlite（node 无内置 sqlite）
    const script = [
      "import sqlite3, json, sys",
      "conn = sqlite3.connect(r'" + CC_SWITCH_DB.replace(/\\/g, "\\\\") + "')",
      "cur = conn.cursor()",
      "cur.execute(\"SELECT settings_config FROM providers WHERE app_type='claude' AND is_current=1\")",
      "row = cur.fetchone()",
      "if row:",
      "    cfg = json.loads(row[0])",
      "    for k, v in cfg.get('env', {}).items():",
      "        print(k + '=' + str(v))",
    ].join("\n");
    const out = execFileSync("python3", ["-c", script], { timeout: 10000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    for (const line of out.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1).trim();
    }
  } catch {
    // 读不到则用空 env（claude 可能走默认认证）
  }
  return env;
}

let cachedCcSwitchEnv: Record<string, string> | null = null;
function getCcSwitchEnv(): Record<string, string> {
  if (!cachedCcSwitchEnv) cachedCcSwitchEnv = readCcSwitchEnv();
  return cachedCcSwitchEnv;
}

export interface AiExecuteInput {
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  /** 纯文本任务：禁止 Claude 调用任何工具（Bash/Read/Write 等），只能基于 prompt 内联数据回答 */
  noTools?: boolean;
  /** 2026-08-07 模型选择：claude 模型 ID（如 claude-sonnet-5 / claude-opus-4-8，空=默认） */
  model?: string;
}

export interface AiExecuteResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  tookMs: number;
  error?: string;
}

/** 是否可用（claude.exe 存在） */
export function isClaudeCliAvailable(): boolean {
  try {
    if (!fs.existsSync(CLAUDE_EXE)) return false;
    execFileSync(CLAUDE_EXE, ["--version"], { timeout: 10000, stdio: "pipe", env: { ...process.env, ...getCcSwitchEnv() } });
    return true;
  } catch {
    return false;
  }
}

/** 执行 Claude Code 任务（-p 非交互模式，prompt 走 stdin） */
export async function executeWithClaude(input: AiExecuteInput): Promise<AiExecuteResult> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 120_000;

  // claude.exe 不存在则退回 cmd（兼容非 npm 安装路径）
  if (!fs.existsSync(CLAUDE_EXE)) {
    return {
      ok: false,
      output: "",
      exitCode: null,
      tookMs: Date.now() - startedAt,
      error: "claude.exe 未找到，请确认 Claude Code 安装位置"
    };
  }

  const args = [
    "-p",
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
    ...(input.noTools ? ["--disallowedTools", NO_TOOLS_DISALLOW.join(",")] : []),
    "--max-turns",
    "15",
    // 2026-08-07 模型选择：--model 参数（用户可选，如 claude-sonnet-5）
    ...(input.model ? ["--model", input.model] : [])
  ];

  return new Promise((resolve) => {
    const child = spawn(CLAUDE_EXE, args, {
      cwd: input.cwd || process.cwd(),
      env: { ...process.env, ...getCcSwitchEnv() },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d; });
    child.stderr.on("data", (d: Buffer) => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        output: (stdout || stderr).trim(),
        exitCode: null,
        tookMs: Date.now() - startedAt,
        error: err.message.slice(0, 500)
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const killed = signal !== null || code === null;
      resolve({
        ok: !killed && code === 0,
        output: (stdout || stderr).trim(),
        exitCode: code,
        tookMs: Date.now() - startedAt,
        error: killed ? `执行超时（${Math.round(timeoutMs / 1000)} 秒）` : (code !== 0 ? stderr.slice(0, 2000) : undefined)
      });
    });

    // prompt 走 stdin（避免 cmd 命令行传参被拆碎）
    child.stdin.write(input.prompt);
    child.stdin.end();
  });
}

export const aiExecuteService = {
  execute: executeWithClaude,
  available: isClaudeCliAvailable
};
