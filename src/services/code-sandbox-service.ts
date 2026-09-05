// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// code-sandbox-service.ts — P0-2: 代码执行沙箱（从 MCP server 提取, agent 工具与 MCP 共用）
// 沙箱子进程执行: 黑名单+语义检查+sidecar门控+凭证隔离+工作目录隔离+白名单代理
// 借鉴2(Codex PermissionProfile): 沙箱分级 read-only/workspace-write/full-access + 升级链
// 用法: executeCode({ language, code, timeoutMs, profile })
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";  // 静态 import（require 在 ESM 不可用）

const execFileAsync = promisify(execFile);

export interface ExecuteCodeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
}

// ═══ 借鉴2: 沙箱分级（Codex PermissionProfile 模式）═══
export type SandboxProfile = "read-only" | "workspace-write" | "full-access";

/** 沙箱分级说明（前端展示/审计用） */
export const SANDBOX_PROFILE_LABELS: Record<SandboxProfile, string> = {
  "read-only": "只读（默认）— 禁止一切文件写/网络/进程操作",
  "workspace-write": "工作区可写 — 仅允许 agent_workspace 内读写",
  "full-access": "完全访问 — 危险操作需 sidecar 门控（默认禁止危险命令）",
};

/** 默认沙箱级别（AGENT_SANDBOX_PROFILE 覆盖; 对齐 Codex 默认 read-only） */
export function defaultSandboxProfile(): SandboxProfile {
  const v = process.env.AGENT_SANDBOX_PROFILE || "read-only";
  return (v === "workspace-write" || v === "full-access") ? v : "read-only";
}

/**
 * 升级链（Codex escalation 模式）: 低级别被拦的操作 → 建议升级级别
 * 返回: { suggested, reason } — 调用方（agent 工具）可据此请求人工审批升级
 */
export function suggestSandboxEscalation(code: string, profile: SandboxProfile): { suggested: SandboxProfile; reason: string } {
  if (profile === "read-only") {
    // 检测写/网络/进程意图 → 建议升级 workspace-write
    if (/(?:open|writeFileSync|writeFile|readdir|mkdir|unlink)\(/.test(code) || /(?:fs\.|os\.|Path\.)/.test(code)) {
      return { suggested: "workspace-write", reason: "代码含文件读写操作, 需工作区可写级别" };
    }
    if (/(?:fetch|axios|http|requests\.)/.test(code)) {
      return { suggested: "full-access", reason: "代码含网络请求, 需 full-access（白名单代理管控）" };
    }
  }
  if (profile === "workspace-write") {
    if (/(?:fetch|axios|http|requests\.)/.test(code) || /import\s+subprocess|child_process/.test(code)) {
      return { suggested: "full-access", reason: "代码含网络/进程操作, 需 full-access 级别" };
    }
  }
  return { suggested: profile, reason: "无需升级" };
}

/** 按级别决定 cwd 与 env（read-only 用只读临时目录+禁网; workspace-write 允许 agent_workspace; full-access 保留代理白名单） */
function sandboxCwd(profile: SandboxProfile): string {
  if (profile === "workspace-write") {
    const ws = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
    try { fs.mkdirSync(ws, { recursive: true }); } catch { /* 目录创建失败 → 回退临时目录 */ }
    if (fs.existsSync(ws)) return ws;
  }
  const tmp = path.join(os.tmpdir(), "sag-code-sandbox");
  try { fs.mkdirSync(tmp, { recursive: true }); } catch { /* ignore */ }
  return tmp;
}

/** 网络策略: read-only 彻底禁网(代理指向黑洞); workspace-write/full-access 走白名单代理
 *  V404-28(M6): env 白名单 + 密钥剥离双层 — 只透传运行必需/无害变量, 任何密钥/凭据/DB 类一律不继承
 *  (白名单兜底防遗漏, 密钥正则防白名单误加敏感键) */
export function sandboxEnv(profile: SandboxProfile): Record<string, string> { // V404-28(M6): 导出供单测断言隔离
  // 运行必需/无害变量(宿主 env 只透传这些)
  const ENV_ALLOW = ["PATH", "PYTHONPATH", "HOME", "USERPROFILE", "TEMP", "TMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "NODE_PATH", "SAG_ROOT", "SAG_SANDBOX_PYTHON", "VENV_PYTHON", "COGNEE_PYTHON", "EMPIRICAL_PYTHON", "VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONHOME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "OneDrive", "HOMEDRIVE", "HOMEPATH", "USERNAME", "COMPUTERNAME", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"];
  const SENSITIVE_RE = /(?:API_KEY|DASHSCOPE|DEEPSEEK|EMBEDDING|TOKEN|SECRET|PASSWORD|DATABASE_URL|PGHOST|PGPASSWORD|BOCHA|TAVILY|EXA|SENSENOVA|KEY$)/i;
  const base: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => ENV_ALLOW.includes(k) && !SENSITIVE_RE.test(k))
    ),
    PYTHONIOENCODING: "utf-8",
    SAG_SANDBOX: "1",
    SAG_SANDBOX_PROFILE: profile,
  };
  if (profile === "read-only") {
    // 彻底断网: 代理指向不可达端口 + 清空代理白名单
    base.HTTP_PROXY = "http://127.0.0.1:1";
    base.HTTPS_PROXY = "http://127.0.0.1:1";
    base.NO_PROXY = "";
  } else {
    base.HTTP_PROXY = "http://127.0.0.1:8899";  // 白名单代理（只放行 pypi/github 等）
    base.HTTPS_PROXY = "http://127.0.0.1:8899";
    base.NO_PROXY = "";
  }
  return base;
}

/** 危险操作黑名单（文件删除/系统命令/网络监听/环境读取） */
const BLACKLIST = [
  /rm\s+-rf|del\s+\/s|format\s|shutdown|reboot/i,
  /subprocess|os\.system|exec\(|eval\(|spawn\(/i,
  /\.env|password|secret|api[_-]?key/i,
  /chmod|chown|mkfs|fdisk/i,
  /socket|listen\(|bind\(/i,
];

/** 敏感能力信号（触发后需 sidecar 门控; 纯计算代码不含这些 → 规则层直接放行） */
const SENSITIVE_SIGNALS = [
  /import\s+(os|sys|subprocess|socket|requests|urllib|http|ftplib|pathlib|shutil)/i,
  /from\s+(os|sys|subprocess|socket|requests|urllib|http|ftplib)\s+import/i,
  /require\(["'](fs|child_process|net|http|https|dns|os)["']\)/i,
  /(?:open|readFileSync|writeFileSync|existsSync|readdir)\(/i,
  /(?:fetch|axios|XMLHttpRequest|new\s+WebSocket)/i,
  /process\.env|process\.argv/i,
  /fs\.|path\.resolve/i,
  /__import__|globals\(\)|locals\(\)/i,
];

/** 修复3: Python 解释器探测 — SAG_SANDBOX_PYTHON/VENV_PYTHON 覆盖;
 * 否则探测: cognee venv → 常见 venv → PATH python */
function detectPythonExe(): string {
  const candidates = [
    process.env.SAG_SANDBOX_PYTHON,
    process.env.VENV_PYTHON,
    "",
    "python",
  ].filter(Boolean) as string[];
  return candidates[0] || "python";
}

/** Python 解释器（项目 venv, 沙箱进程用） */
const PYTHON_EXE = detectPythonExe();

/** JS 解释器 — 裸 "node" 走 PATH 解析（git-bash 下 which 给 /d/node 无 .exe 无法 spawn; D:\node.exe 不存在） */
const NODE_EXE = process.env.SAG_SANDBOX_NODE || "node";

/** 沙箱工作目录（临时目录隔离, 防越权读写项目文件） */
function sandboxDir(): string {
  const dir = path.join(os.tmpdir(), "sag-code-sandbox");
  try { const fs = require("node:fs") as typeof import("node:fs"); fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

/**
 * 沙箱内执行代码（Python/JavaScript）
 * - 黑名单 + 语义解析拦截危险操作
 * - Sidecar 门控（规则层 + LLM 层, 拒绝/升级人工审查）
 * - 凭证隔离（剔除 API Key 环境变量）
 * - 网络出口白名单代理（allowlist-proxy 8899）
 * - 超时熔断 + 输出截断
 */
export async function executeCode(input: {
  language: "python" | "javascript";
  code: string;
  timeoutMs?: number;
  /** 借鉴2: 沙箱级别（默认 read-only, AGENT_SANDBOX_PROFILE 覆盖） */
  profile?: SandboxProfile;
}): Promise<ExecuteCodeResult> {
  const timeout = input.timeoutMs ?? 20_000;
  const profile = input.profile ?? defaultSandboxProfile();
  const t0 = Date.now();
  // 黑名单检查
  for (const re of BLACKLIST) {
    if (re.test(input.code)) {
      return { ok: false, stdout: "", stderr: "", error: "代码包含被禁止的危险操作（沙箱安全策略拦截）", durationMs: Date.now() - t0 };
    }
  }
  // V342(P2-9): 命令语义解析（识别 find -exec/curl -o 覆盖系统文件等绕过手法）
  try {
    const { semanticCommandCheck } = await import("./sidecar-guard.js");
    const semantic = semanticCommandCheck(input.code);
    if (semantic.dangerous) {
      return { ok: false, stdout: "", stderr: "", error: "命令语义解析拦截: " + semantic.reason, durationMs: Date.now() - t0 };
    }
  } catch { /* 语义解析器不可用 → 黑名单已兜底 */ }
  // P0-2: 纯计算预检 — 不含文件/进程/网络/环境操作的代码跳过 LLM 门控（规则层放行）
  // 含敏感能力的代码仍走 sidecar 审查（防 LLM 不可用时保守 review 卡死普通计算）
  // 借鉴2: workspace-write 级别下文件操作是"预授权"的（目录已被沙箱锁定在 agent_workspace）,
  //   跳过 LLM 门控 — 对齐 Codex workspace-write 语义; read-only/full-access 仍走门控
  const isPureCompute = !SENSITIVE_SIGNALS.some((re) => re.test(input.code));
  const preAuthorizedFileOps = profile === "workspace-write" && /(?:fs\.|open\(|readFileSync|writeFileSync|readdir|mkdir)\(/.test(input.code) && !/(?:fetch|axios|http|requests\.|child_process|subprocess)/.test(input.code);
  if (!isPureCompute && !preAuthorizedFileOps) {
    // V308(P0-13): Sidecar 工具门控
    try {
      const { guardToolCall } = await import("./sidecar-guard.js");
      const guard = await guardToolCall({ tool: "sag_execute_code", args: { language: input.language, code_len: input.code.length } });
      if (guard.verdict === "deny") {
        return { ok: false, stdout: "", stderr: "", error: "Sidecar 门控拒绝: " + guard.reason, durationMs: Date.now() - t0 };
      }
      if (guard.verdict === "review") {
        return { ok: false, stdout: "", stderr: "", error: "Sidecar 门控升级人工审查: " + guard.reason, durationMs: Date.now() - t0 };
      }
    } catch { /* 门控服务不可用 → 放行（黑名单已兜底） */ }
  }
  try {
    let cmd: string;
    let args: string[];
    if (input.language === "python") {
      cmd = PYTHON_EXE;
      args = ["-c", input.code];
    } else {
      cmd = NODE_EXE;
      args = ["-e", input.code];
    }
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout,
      maxBuffer: 1024 * 1024,
      cwd: sandboxCwd(profile),  // 借鉴2: 按级别隔离工作目录（read-only→临时目录; workspace-write→agent_workspace）
      // 凭证隔离: 剔除 API Key/密钥环境变量（沙箱内进程拿不到凭证）
      // 借鉴2: 网络分级 — read-only 彻底断网; workspace-write/full-access 走白名单代理
      env: sandboxEnv(profile),
      windowsHide: true,
    });
    return { ok: true, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 2000), durationMs: Date.now() - t0 };
  } catch (e: any) {
    return {
      ok: false,
      error: String(e?.message || e).slice(0, 2000),
      stdout: String(e?.stdout || "").slice(0, 2000),
      stderr: String(e?.stderr || "").slice(0, 2000),
      durationMs: Date.now() - t0,
    };
  }
}
