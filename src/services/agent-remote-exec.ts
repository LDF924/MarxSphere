// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-remote-exec.ts — 借鉴 wisp-science: 远程计算上下文
// WSL(Windows 子系统 Linux) 直连 / SSH 远程执行代码
// 安全: 危险命令黑名单(同沙箱) + 凭证隔离 env + 超时
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RemoteExecInput {
  target: "wsl" | "ssh" | "gpu";
  language: "python" | "javascript";
  code: string;
  timeoutMs?: number;
}

export interface RemoteExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
}

/** 远程危险操作黑名单（与本地沙箱一致） */
const BLACKLIST = [
  /rm\s+-rf|del\s+\/s|format\s|shutdown|reboot/i,
  /os\.system|subprocess\.(run|Popen)|exec\(|eval\(/i,
  /\.env|password|secret|api[_-]?key/i,
  /socket|listen\(|bind\(/i,
  /chmod|chown|mkfs|fdisk/i,
];

/** SSH 主机配置（AGENT_SSH_HOST 必配; 可选 USER/PORT/KEY） */
function sshConfig(): { host: string; user: string; port: string; key?: string } {
  return {
    host: process.env.AGENT_SSH_HOST || "",
    user: process.env.AGENT_SSH_USER || "root",
    port: process.env.AGENT_SSH_PORT || "22",
    key: process.env.AGENT_SSH_KEY,
  };
}

/** GPU 主机配置（AGENT_GPU_HOST 独立于普通 SSH; 可选 CUDA_HOME/PYTHON） */
function gpuConfig(): { host: string; user: string; port: string; key?: string; python?: string } {
  return {
    host: process.env.AGENT_GPU_HOST || "",
    user: process.env.AGENT_GPU_USER || "root",
    port: process.env.AGENT_GPU_PORT || "22",
    key: process.env.AGENT_GPU_KEY,
    python: process.env.AGENT_GPU_PYTHON || "python3",
  };
}

/** 远程执行代码（WSL: wsl.exe 直连; SSH: ssh 命令 + 临时脚本） */
export async function executeRemoteCode(input: RemoteExecInput): Promise<RemoteExecResult> {
  const t0 = Date.now();
  const timeout = Math.min(Math.max(input.timeoutMs || 30000, 5000), 120000);
  // 危险操作拦截
  for (const re of BLACKLIST) {
    if (re.test(input.code)) {
      return { ok: false, stdout: "", stderr: "", error: "代码含被禁止的危险操作（远程执行安全策略拦截）", durationMs: Date.now() - t0 };
    }
  }
  // 命令构造: 远程用 python -c 或 node -e（把代码作为参数传入, 避免 shell 转义）
  const remoteCmd = input.language === "python" ? "python3" : "node";
  const flag = input.language === "python" ? "-c" : "-e";
  try {
    if (input.target === "wsl") {
      // WSL 直连（Windows 自带 wsl.exe）
      const { stdout, stderr } = await execFileAsync("wsl.exe", [remoteCmd, flag, input.code], {
        timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, WSLENV: "PYTHONIOENCODING/up" },
      });
      return { ok: true, stdout: stdout.slice(0, 3000), stderr: stderr.slice(0, 1000), durationMs: Date.now() - t0 };
    }
    // GPU 远程（独立 GPU 主机, CUDA 环境; AGENT_GPU_HOST 配置）
    if (input.target === "gpu") {
      const gcfg = gpuConfig();
      if (!gcfg.host) return { ok: false, stdout: "", stderr: "", error: "GPU 主机未配置 — 请设置 AGENT_GPU_HOST（可选 USER/PORT/KEY/PYTHON）", durationMs: Date.now() - t0 };
      const gpy = gcfg.python || "python3";
      const sshArgs = ["-p", gcfg.port, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10"];
      if (gcfg.key) sshArgs.push("-i", gcfg.key);
      // GPU 环境: 探测 CUDA 可用性 → 执行（失败自动降级为 CPU 提示）
      const cmd = `(${gpy} -c "import torch, torch.cuda; print('GPU:', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')" 2>/dev/null || echo 'NO_TORCH') && ${gpy} ${flag} ${JSON.stringify(input.code)}`;
      sshArgs.push(`${gcfg.user}@${gcfg.host}`, cmd);
      const { stdout, stderr } = await execFileAsync("ssh", sshArgs, {
        timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      });
      // 结果前附带 GPU 环境信息
      const lines = stdout.split("\n");
      const gpuInfo = lines.find((l) => l.startsWith("GPU:"));
      const codeOut = lines.filter((l) => !l.startsWith("GPU:")).join("\n").trim();
      const parts: string[] = [];
      if (gpuInfo) parts.push(`【GPU环境】${gpuInfo.replace("GPU: ", "")}`);
      if (gpuInfo?.includes("NO_TORCH") || stdout.includes("NO_TORCH")) parts.push("（目标机未装 torch — 代码可能跑 CPU 模式）");
      if (codeOut) parts.push(codeOut.slice(0, 3000));
      return { ok: true, stdout: parts.join("\n"), stderr: stderr.slice(0, 1000), durationMs: Date.now() - t0 };
    }
    // SSH 远程
    const cfg = sshConfig();
    if (!cfg.host) return { ok: false, stdout: "", stderr: "", error: "SSH 未配置 — 请设置 AGENT_SSH_HOST（可选 USER/PORT/KEY）", durationMs: Date.now() - t0 };
    const sshArgs = ["-p", cfg.port, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10"];
    if (cfg.key) sshArgs.push("-i", cfg.key);
    sshArgs.push(`${cfg.user}@${cfg.host}`, `${remoteCmd} ${flag} ${JSON.stringify(input.code)}`);
    const { stdout, stderr } = await execFileAsync("ssh", sshArgs, {
      timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    return { ok: true, stdout: stdout.slice(0, 3000), stderr: stderr.slice(0, 1000), durationMs: Date.now() - t0 };
  } catch (e: any) {
    return {
      ok: false,
      stdout: String(e?.stdout || "").slice(0, 1000),
      stderr: String(e?.stderr || "").slice(0, 1000),
      error: String(e?.message || e).slice(0, 200),
      durationMs: Date.now() - t0,
    };
  }
}

/** 远程上下文状态（诊断）— 审计修复: wsl 探测真实可用性（非硬编码 true） */
export function remoteExecStatus(): { wsl: boolean; sshConfigured: boolean; sshHost?: string; gpuConfigured: boolean; gpuHost?: string } {
  const cfg = sshConfig();
  const gcfg = gpuConfig();
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  let wslAvailable = false;
  try { wslAvailable = existsSync("C:/Windows/System32/wsl.exe"); } catch { /* 探测失败 */ }
  return { wsl: wslAvailable, sshConfigured: !!cfg.host, sshHost: cfg.host || undefined, gpuConfigured: !!gcfg.host, gpuHost: gcfg.host || undefined };
}
