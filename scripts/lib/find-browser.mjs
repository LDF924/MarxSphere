// scripts/lib/find-browser.mjs — 无头浏览器可执行文件定位(CDP 验证脚本共用)
//
// 由来: verify-fusion-tabs / verify-empirical-project-switch / browser-smoke 三个脚本
//   都写死了 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`,
//   非 Windows 机器或 Edge 不装在该路径时直接 ENOENT。探测链搬到这里共用。
//
// 返回值是**可执行文件路径**: 调用方自己 spawn + --remote-debugging-port 走 CDP。
// 这里不碰 Playwright 的 launch —— 那是另一套 API, 只共享"去哪找浏览器"。
//
// 环境变量叫 UI_VERIFY_BROWSER —— 按仓库既有命名习惯(<用途>_<东西>, 如 AGENT_EDGE_PATH),
//   不用泛称 BROWSER_PATH: 名字太通用容易和别的东西撞, 而 Windows 自带的
//   `ProgramFiles(x86)` 正是"带括号的变量名"这种坑的现成例子。
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";

/**
 * 按"最稳→最省事"给出候选, 每项 { how, path, requireEnv? }:
 *   ① 环境变量 envVar 显式指定(不存在时显式报错, 不静默跳过 —— 用户指明了就该知道它错了)
 *   ② 扫描各平台 Playwright 缓存根目录找 chromium-<版本>(目录名带版本, 没法硬编码)
 *   ③ 系统 Edge / Chrome(includeSystem=false 时跳过, 交给调用方自己的默认查找)
 * requireEnv 是路径成立所需的环境变量; 变量缺失时该候选项根本不存在(如 Windows 下没 LOCALAPPDATA)
 */
function browserCandidates({ envVar = "UI_VERIFY_BROWSER", includeSystem = true } = {}) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [];
  if (process.env[envVar]) candidates.push({ how: `${envVar} 指定`, path: process.env[envVar], requireEnv: envVar });

  // Playwright 浏览器缓存: 三个平台的默认根目录 + 官方覆盖变量
  const roots = [
    { path: process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/ms-playwright`, requireEnv: "LOCALAPPDATA" }, // Windows
    { path: home && `${home}/.cache/ms-playwright`, requireEnv: "HOME" },                                          // Linux
    { path: home && `${home}/Library/Caches/ms-playwright`, requireEnv: "HOME" },                                  // macOS
    { path: process.env.PLAYWRIGHT_BROWSERS_PATH, requireEnv: "PLAYWRIGHT_BROWSERS_PATH" },
  ];
  for (const root of roots) {
    if (!root.path || !existsSync(root.path)) continue;
    let dirs = [];
    try { dirs = readdirSync(root.path).filter((x) => /^chromium/.test(x)); } catch { continue; } // 权限/损坏目录跳过
    for (const d of dirs) {
      for (const p of [`${root.path}/${d}/chrome-win64/chrome.exe`, `${root.path}/${d}/chrome-linux/chrome`,
        `${root.path}/${d}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`]) {
        if (existsSync(p)) candidates.push({ how: `Playwright 缓存 ${d}`, path: p });
      }
    }
  }

  if (includeSystem) {
    // Windows 那几个候选只可能在 Windows 上存在, 用对应的 ProgramFiles* 变量当判据:
    // POSIX 平台(含 Git Bash/MSYS)根本不会有这些变量, 就不必 stat 一堆盘符路径。
    const sys = [
      { path: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", requireEnv: "ProgramFiles(x86)" },
      { path: "C:/Program Files/Microsoft/Edge/Application/msedge.exe", requireEnv: "ProgramFiles" },
      { path: process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Microsoft/Edge/Application/msedge.exe`, requireEnv: "LOCALAPPDATA" },
      { path: "C:/Program Files/Google/Chrome/Application/chrome.exe", requireEnv: "ProgramFiles" },
      { path: "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", requireEnv: "ProgramFiles(x86)" },
      { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },        // macOS
      { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
      { path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },                  // macOS
      { path: "/usr/bin/google-chrome" },                                              // Linux
      { path: "/usr/bin/google-chrome-stable" },
      { path: "/usr/bin/chromium" },
      { path: "/usr/bin/chromium-browser" },
      { path: "/snap/bin/chromium" },
      { path: "/usr/bin/microsoft-edge" },
    ];
    for (const s of sys) {
      // Windows 路径只在 Windows 上试(靠对应的 ProgramFiles* 变量存在与否判断):
      // 裸的 "C:/Program Files/..." 在 Linux 上也长得出来, 不该被 stat 一遍
      if (s.requireEnv && process.env[s.requireEnv] === undefined) continue;
      candidates.push({ how: `系统浏览器 ${s.path}`, path: s.path });
    }
  }
  return candidates;
}

/** 全失败时的排查清单: 也列出没进候选链的路径(别的平台/环境变量缺失), 免得用户以为漏扫了 */
function alsoConsidered(candidates) {
  const seen = new Set(candidates.map((c) => c.path));
  const rows = [];
  const winVars = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
  for (const v of winVars) {
    for (const p of [`${v}/Microsoft/Edge/Application/msedge.exe`, `${v}/Google/Chrome/Application/chrome.exe`]) {
      if (!seen.has(p)) rows.push(p);
    }
  }
  for (const p of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"]) {
    if (!seen.has(p)) rows.push(p);
  }
  return rows;
}

/**
 * 探测并返回第一个存在的可执行文件路径。
 * 全不可用时打印每条失败原因 + 两条可操作办法, 以退出码 1 退出。
 * label 用于错误提示里指回是哪个脚本(调用方传自己的文件名)。
 */
export function resolveBrowser({ envVar = "UI_VERIFY_BROWSER", includeSystem = true, label = "node <脚本>" } = {}) {
  const candidates = browserCandidates({ envVar, includeSystem });
  // 日志里的绝对路径: 环境变量给的可能是相对路径, 校验和 spawn 都按当前工作目录解析
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(p));
  const failures = [];
  for (const c of candidates) {
    if (existsSync(c.path)) {
      console.log(`[env] 浏览器: ${c.how} (${abs(c.path)})`);
      return abs(c.path);
    }
    failures.push(`${c.how}: 不存在 ${abs(c.path)}`);
  }
  const rest = alsoConsidered(candidates);
  console.error("找不到可用的浏览器。已尝试:\n" + failures.map((f) => "  - " + f).join("\n")
    + (rest.length ? "\n另外看过这些位置(环境变量缺失或非本平台):\n" + rest.map((p) => "  - " + p).join("\n") : ""));
  console.error(`\n解决(任选其一):
  npx playwright install chromium        # 装 Playwright 自带浏览器(约 200MB)
  ${envVar}=<chrome/edge 可执行文件绝对路径> node ${label}`);
  process.exit(1);
}
