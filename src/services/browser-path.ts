// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// browser-path.ts — 无头浏览器可执行文件的定位
//
// 由来(2026-09-11 上云审计): 两处写死 Windows 上的 Edge 路径
//   (`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`)。
//   其中 agent-tool-router 的探测函数虽然"看起来"会逐个尝试候选路径, 但它用的是 `require` ——
//   ESM 里没有 require, 于是每次都走 catch 直接返回**第一个候选**(硬编码那条),
//   探测从未真正生效。Linux 云主机上这些路径都不存在, 网页抓取工具会直接失败。
//
// 现在: 环境变量优先 → 按平台探测候选 → 都找不到返回 null(调用方给出可读提示, 而不是 ENOENT)。
import fs from "node:fs";
import os from "node:os";

/** 各平台常见安装位置(按可能性排序) */
function candidates(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    const pf = process.env["ProgramFiles"] || "C:/Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
    return [
      `${pf86}/Microsoft/Edge/Application/msedge.exe`,
      `${pf}/Microsoft/Edge/Application/msedge.exe`,
      local ? `${local}/Microsoft/Edge/Application/msedge.exe` : "",
      `${pf}/Google/Chrome/Application/chrome.exe`,
      `${pf86}/Google/Chrome/Application/chrome.exe`,
      local ? `${local}/Google/Chrome/Application/chrome.exe` : "",
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  // linux: 容器镜像里通常是 chromium / chromium-browser; 也尊重用户 home 下的 chrome
  return [
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    `${home}/.cache/puppeteer/chrome/headless_shell`,
  ];
}

/**
 * 返回可用的浏览器可执行文件路径; 找不到返回 null。
 * 覆盖: AGENT_EDGE_PATH 显式指定(既有变量名, 保持兼容)。
 */
export function edgePath(): string | null {
  const explicit = process.env.AGENT_EDGE_PATH;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  for (const c of candidates()) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* 试下一个 */ }
  }
  return null;
}

/** 找不到时给调用方用的可读说明(而不是让上层看到 ENOENT) */
export function edgePathHint(): string {
  return `未找到无头浏览器。设置 AGENT_EDGE_PATH 指向 Chromium/Edge 可执行文件`
    + `（当前平台 ${process.platform}，常见位置: ${candidates().slice(0, 3).join(" / ")}）`;
}
