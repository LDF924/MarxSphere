// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// code-sandbox-service.ts — P0-2: 代码执行沙箱（从 MCP server 提取, agent 工具与 MCP 共用）
// 沙箱子进程执行: 黑名单+语义检查+sidecar门控+凭证隔离+工作目录隔离+白名单代理
// 借鉴2(Codex PermissionProfile): 沙箱分级 read-only/workspace-write/full-access + 升级链
// 用法: executeCode({ language, code, timeoutMs, profile })
import { execFile } from "node:child_process";
import { dataPath } from "./storage-paths.js";
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

/**
 * 沙箱分级说明（前端展示/审计用）。
 *
 * ⚠ 这两条纪律是实测踩出来的:
 *
 * ① **措辞必须与实现一致**。`workspace-write` 原写作"仅允许 agent_workspace 内读写",
 *    **那句话是假的** —— 实测工作区里跑的代码能写到任意绝对路径(连平台 `src/` 都写得进去)。
 *    平台没有 OS 级隔离, 沙箱只设了 cwd + env, 文件系统访问靠**规则层**的路径拦截
 *    (见 codeEscapesWorkspace)。把"约定"说成"隔离", 会让读代码的人 —— 包括我在内 ——
 *    据它做出错误的授权判断, 而那正是这个缺口藏了这么久的原因。
 *
 * ② **这是给用户看的文案, 不是注释**。第一版塞了 `**加粗**` 和"详见注释" ——
 *    星号会原样显示在设置界面上, 而"详见注释"指向的是用户根本看不到的源码。
 *    写给用户的话就按用户能读的方式写。
 */
export const SANDBOX_PROFILE_LABELS: Record<SandboxProfile, string> = {
  "read-only": "只读 — 禁止一切文件写/网络/进程操作",
  "workspace-write": "工作区可写 — 以 agent_workspace 为工作目录; 绝对路径与越级路径会被拦截（文件系统访问靠规则层限制，不是操作系统级隔离）",
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

/** 会话级工作目录(绝对路径)。空 = 沿用全局 agent_workspace。见 setSessionWorkspace */
let sessionWorkspaceDir = "";

/**
 * 会话工作目录(2026-10-02)。
 *
 * 由来(对照 Respal 的"会话工作目录"): 本仓沙箱的 cwd 此前**与会话无关** ——
 *   `workspace-write` 一律是 `agent_workspace/`, 其余一律是临时目录。于是同一台机器上
 *   两个并行会话的产物混在一个目录里, 也没有任何办法让某个任务待在自己的子目录。
 *
 * ═══ 为什么只做到"可选的子目录"这一步 ═══
 *   把 cwd 直接交给用户输入是危险的: 那条路径会成为子进程的工作目录, 而沙箱只是
 *   设 cwd + env, **没有操作系统级隔离**(见本文件下方 codeEscapesWorkspace 的说明)。
 *   所以这里只接受一个**相对名字**(如 `proj-a`), 并强制:
 *     · 只允许字母/数字/连字符/下划线/点, 长度 ≤ 64;
 *     · `..` 与绝对路径一律拒(否则 `../../src` 就逃出工作区了);
 *     · 最终路径必须仍在 agent_workspace 之下 —— **这是兜底校验**, 不靠正则一条路。
 *   换句话说: 用户能选"哪个房间", 不能选"出不出这栋楼"。
 *
 * 目录不存在就创建(这正是"新建工作目录"的语义)。名字为空则沿用全局工作区 ——
 * 既有行为一字不变, 所以这是个纯增量开关。
 */
export function setSessionWorkspace(name: string): { ok: true; dir: string } | { ok: false; error: string } {
  const raw = String(name ?? "").trim();
  if (!raw) { sessionWorkspaceDir = ""; return { ok: true, dir: "" }; }
  if (raw.length > 64) return { ok: false, error: "工作目录名过长（最多 64 字符）" };
  if (!/^[A-Za-z0-9._-]+$/.test(raw) || raw === "." || raw === ".." || raw.includes("..")) {
    return { ok: false, error: "工作目录名只能含字母、数字、连字符、下划线、点，且不能包含 .." };
  }
  const base = path.resolve(dataPath("agent_workspace"));
  const dir = path.resolve(base, raw);
  // 兜底: resolve 之后的路径必须仍在工作区之下。正则已经挡了 `..`, 但不能只靠它 ——
  // Windows 的大小写/短名/符号链接都可能绕过纯字符串判断, 所以再核一次前缀。
  if (dir !== base && !dir.startsWith(base + path.sep)) {
    return { ok: false, error: "工作目录必须位于智能体工作区之内" };
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    return { ok: false, error: `无法创建工作目录: ${String((e as Error).message).slice(0, 120)}` };
  }
  sessionWorkspaceDir = dir;
  return { ok: true, dir };
}

/** 当前会话工作目录(空 = 用全局工作区)。供执行层与诊断读取 */
export function currentSessionWorkspace(): string {
  return sessionWorkspaceDir;
}

/** 按级别决定 cwd 与 env（read-only 用只读临时目录+禁网; workspace-write 允许 agent_workspace; full-access 保留代理白名单） */
function sandboxCwd(profile: SandboxProfile): string {
  if (profile === "workspace-write") {
    // 会话级子目录优先 —— 它一定在 agent_workspace 之内(见 setSessionWorkspace 的兜底校验)
    if (sessionWorkspaceDir && fs.existsSync(sessionWorkspaceDir)) return sessionWorkspaceDir;
    const ws = dataPath("agent_workspace");
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
    // V415: 端口可配(原来写死 8899) —— allowlist-proxy 支持 --port, 换端口时沙盒会静默断网。
    // SANDBOX_ALLOWLIST_PROXY 可给完整 URL(跨机部署时指向代理所在主机)。
    const proxy = process.env.SANDBOX_ALLOWLIST_PROXY
      || `http://127.0.0.1:${process.env.SANDBOX_ALLOWLIST_PORT || "8899"}`;
    base.HTTP_PROXY = proxy;   // 白名单代理（只放行 pypi/github 等）
    base.HTTPS_PROXY = proxy;
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
/**
 * 代码里是否出现了**绝对路径**或**向上越级**的路径字面量。
 *
 * ═══ 为什么需要它(2026-10-01 实测发现的未记录缺口) ═══
 *
 * `workspace-write` 的档位描述写的是"仅允许 agent_workspace 内读写", 而实测:
 *   · 沙箱只是把 **cwd** 设成 agent_workspace, **对文件系统访问没有任何限制**;
 *   · 平台也没有 OS 级隔离(没有 bwrap / restricted token 之类的设施);
 *   · 于是工作区里跑的代码可以**写到任意绝对路径** —— 实测成功写进了平台自己的
 *     `src/` 源码目录。
 *
 * 这不只是"隔离没做到位": 它让我加的 `execute` 步骤类型有了远超其名义的权限 ——
 * 用户在审批界面上看到的是"生成一份 .pptx"并据此点头, 而实际授予的是**整个
 * 文件系统的写权限**。**同意必须是知情的**, 否则那道审批门就只是个形式。
 *
 * ═══ 判据取"保守"而非"完备" ═══
 *
 * 只拦**字面量**里看得出来的越界: 盘符绝对路径(`D:/…`)、UNC(`\\\\host\\share`)、
 * 以及从当前位置向上跳的 `../`。这挡不住 `pathlib.Path.home() / "x"` 这类**构造**出来的
 * 路径 —— 靠正则做出完备的沙箱本就做不到, 假装能反倒更危险。
 * 所以目标是把门槛抬高、并把事实说清楚, 不是宣称已经隔离。
 *
 * 误报面: 只认**带盘符/UNC/越级**的写法。`out.pptx`、`./out.pptx`、`assets/fig.png`
 * 都不命中 —— 而这正是生成产物时该用的形态(见 tool-router 的 SANDBOX_OUTPUT_PATH_RULE)。
 *
 * ═══ 一个要提前知道的取舍(给做"论文配图"的人) ═══
 *
 * 这道拦截同时**挡住了模型直接调用技能自带的脚本**(它们在 `~/.claude/skills/…` 这样的
 * 绝对路径上)。当前不受影响 —— 质检由平台的 artifact-verify-service 在沙箱**外**跑。
 * 但将来若要"裁剪论文原图放进幻灯片", **不要**靠放宽这条规则去让模型读任意路径;
 * 正确做法是把需要的素材**推进 agent_workspace**, 模型只用相对路径取。
 * 否则等于为了一个功能把整个文件系统的读权限又还回去。
 */
export function codeEscapesWorkspace(code: string): { escapes: boolean; reason?: string } {
  const src = String(code || "");
  const winAbs = src.match(/["']([A-Za-z]:[\\/][^"']{2,})["']/);
  if (winAbs) return { escapes: true, reason: `绝对路径 ${winAbs[1].slice(0, 80)}` };
  const unc = src.match(/["'](\\\\[^"']{2,})["']/);
  if (unc) return { escapes: true, reason: `UNC 路径 ${unc[1].slice(0, 80)}` };
  // 越级: "../x" 或 "..\\x"。单独的 ".." 不算 —— 那可能是文本内容。
  const up = src.match(/["'](\.\.[\\/][^"']{0,60})["']/);
  if (up) return { escapes: true, reason: `向上越级路径 ${up[1]}` };
  return { escapes: false };
}

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
      // ⚠ 前缀 `_sandbox-blocked` 是**给上游认的标记**, 不是装饰。
      //   工具契约只返回字符串, 执行层无从知道"这段文字是结果还是拒绝";
      //   本仓已有同款约定(见 run_command 的同类标记)。少了它, 一次被安全策略
      //   拦下的执行会被记成"步骤成功"(result 非空即 verified), 而磁盘上什么都没发生 ——
      //   2026-10-01 实测: execute 步骤报 done、任务报 completed、没有任何 .pptx。
      return { ok: false, stdout: "", stderr: "", error: "_sandbox-blocked 代码包含被禁止的危险操作（沙箱安全策略拦截）", durationMs: Date.now() - t0 };
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
  /**
   * 路径越界拦截 —— **workspace-write 的围栏在这里, 而不是在内核里**。
   *
   * 实测(2026-10-01): 没有这道检查时, 工作区里的代码能写到任意绝对路径
   * (连平台 `src/` 源码目录都写得进去)。见 `codeEscapesWorkspace` 的说明。
   * 放在黑名单之后、门控之前: 它拦的是"逃出工作区", 与"是不是危险操作"是两件事,
   * 不该混进门控让 LLM 去判 —— 那是**确定性的规则**, 就该用规则判。
   */
  if (profile !== "full-access") {
    const esc = codeEscapesWorkspace(input.code);
    if (esc.escapes) {
      return {
        ok: false, stdout: "", stderr: "",
        error: `_sandbox-blocked 代码引用了工作区之外的路径（${esc.reason}）——`
          + `请改用**相对路径**(如 out.pptx)写在工作目录里。`
          + `注意: 这是规则层拦截, 不是 OS 级隔离; 需要访问外部路径请显式升级 profile。`,
        durationMs: Date.now() - t0,
      };
    }
  }
  // P0-2: 纯计算预检 — 不含文件/进程/网络/环境操作的代码跳过 LLM 门控（规则层放行）
  // 含敏感能力的代码仍走 sidecar 审查（防 LLM 不可用时保守 review 卡死普通计算）
  // 借鉴2: workspace-write 级别下文件操作是"预授权"的（目录已被沙箱锁定在 agent_workspace）,
  //   跳过 LLM 门控 — 对齐 Codex workspace-write 语义; read-only/full-access 仍走门控
  const isPureCompute = !SENSITIVE_SIGNALS.some((re) => re.test(input.code));
  /**
   * workspace-write 下, **只是写工作区**的代码直接放行(目录已被沙箱锁死在 agent_workspace)。
   *
   * ⚠ 2026-10-01 修: 原判据要求代码里出现 `open(` / `fs.` / `writeFileSync(` 之类字面量,
   *   属于**按某种写法猜意图**。而 python-pptx 写文件是 `prs.save("x.pptx")` ——
   *   一个 `open(` 都没有, 于是"预授权"永远不成立, 每次都掉进下面那道
   *   **由 LLM 判定**的 sidecar 门控。结果同一段代码**这次过、下次被拦**
   *   (实测: 一次 `Sidecar 门控升级人工审查: 代码含网络/进程操作`, 重跑同样的生成却通过)。
   *   那不是内容差异, 是掷骰子 —— 对用户表现为"生成 PPT 时好时坏"。
   *
   *   现在改成看**写文件的调用形态**: 覆盖常见的落盘 API(不同库各有各的名字),
   *   而不是只认某一种。危险面没有变大 —— 排除项(网络/子进程)仍然挡着,
   *   黑名单也仍然在最前面拦, 这里放宽的只是"判定它算不算在写工作区"。
   */
  const WRITES_WORKSPACE = /(?:\.save|\.write|\.writestr|\.to_excel|\.to_csv|\.to_json|\.to_pickle|\.export|\.dump|\.write_bytes|\.write_text|open\(|fs\.|writeFileSync|appendFileSync|readdir|mkdir|shutil\.copy)/i;
  const NETWORK_OR_PROC = /(?:fetch|axios|xmlhttprequest|requests\.|urllib|socket|https?:\/\/|ftplib|telnetlib|child_process|subprocess|os\.system|os\.popen|\bexec\(|\beval\(|spawn\()/i;
  const preAuthorizedFileOps = profile === "workspace-write"
    && WRITES_WORKSPACE.test(input.code)
    && !NETWORK_OR_PROC.test(input.code);
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
