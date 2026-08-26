#!/usr/bin/env node
// sync-check-auto.mjs — 自动同步一致性检查（计划任务调用, 2026-08-27）
// 每天自动跑: 对比主线(SAG-open-source) vs 工作副本(SAG-main) 代码一致性
// 发现差异 → 写日志 + Windows 通知气泡
// 用法: node scripts/sync-check-auto.mjs
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENSOURCE = path.resolve(__dirname, "..");
const LOG_FILE = path.join(OPENSOURCE, ".cache", "sync-check.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch { /* 日志失败不阻塞 */ }
}

function notify(title, msg) {
  // Windows 通知气泡（PowerShell 弹 Toast, 免依赖）
  try {
    execSync(`powershell -Command "New-BurntToastNotification -Text '${title}','${msg}'" 2>$null; echo done`, { shell: "cmd", timeout: 15000, stdio: "ignore" });
  } catch {
    // BurntToast 可能未安装, 降级 msg 弹窗
    try {
      execSync(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${msg}','${title}')"`, { timeout: 15000, stdio: "ignore" });
    } catch { /* 通知失败不影响检查 */ }
  }
}

log("=== 自动同步一致性检查开始 ===");
try {
  // 跑 sync-repos.mjs --check（复用其差异检测逻辑）
  const out = execSync(`node "${path.join(OPENSOURCE, "scripts", "sync-repos.mjs")}" --check`, { encoding: "utf8", timeout: 60000 });
  log(out);
  const diffCount = (out.match(/⚠️/g) || []).length;
  if (diffCount > 0) {
    log(`⚠️ 发现 ${diffCount} 处差异 — 需人工检查!`);
    notify("MarxSphere 同步检查", `发现 ${diffCount} 处仓库差异，请运行 sync-repos.mjs 或检查`);
  } else {
    log("✅ 两仓库一致, 无需处理");
  }
} catch (e) {
  log(`❌ 检查失败: ${String(e.message || e).slice(0, 200)}`);
  notify("MarxSphere 同步检查", "检查执行失败，请查看日志");
}
log("=== 检查结束 ===\n");
