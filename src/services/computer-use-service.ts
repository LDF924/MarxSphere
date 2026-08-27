// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// computer-use-service.ts — 桌面控制（2026-08-27, ScienceX 对照: Computer Use）
// 能力: 截屏 / 鼠标移动点击 / 键盘输入 / 窗口列表
// 实现: Windows 下 PowerShell(无依赖); 非 Windows 返回不可用提示
// 安全: 默认关闭(COMPUTER_USE_ENABLED=true 启用), 只读操作(screenshot/window_list)可开, 控制操作需显式启用
import { execFile } from "node:child_process";

const ENABLED = process.env.COMPUTER_USE_ENABLED === "true";

function isWindows(): boolean {
  return process.platform === "win32";
}

function runPs(script: string, timeoutMs = 15_000): Promise<{ ok: boolean; out: string; err?: string }> {
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-Command", script], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ""), err: err ? String(stderr || err.message) : undefined }));
  });
}

/** 截屏 → base64 PNG（PowerShell System.Drawing） */
export async function screenshot(): Promise<{ ok: boolean; image?: string; error?: string }> {
  if (!isWindows()) return { ok: false, error: "仅支持 Windows（当前 " + process.platform + "）" };
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())
$g.Dispose(); $bmp.Dispose(); $ms.Dispose()`;
  const r = await runPs(script, 20_000);
  if (!r.ok) return { ok: false, error: r.err?.slice(0, 200) };
  const img = r.out.trim();
  if (!img) return { ok: false, error: "截屏无输出" };
  return { ok: true, image: img };
}

/** 鼠标移动 + 点击（PowerShell user32） */
export async function mouseAction(action: "move" | "click" | "dblclick", x: number, y: number): Promise<{ ok: boolean; error?: string }> {
  if (!isWindows()) return { ok: false, error: "仅支持 Windows" };
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
[M]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})
Start-Sleep -Milliseconds 50
${action === "click" ? '[M]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [M]::mouse_event(4,0,0,0,[UIntPtr]::Zero)' : ""}
${action === "dblclick" ? '[M]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [M]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80; [M]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [M]::mouse_event(4,0,0,0,[UIntPtr]::Zero)' : ""}
Write-Output "ok"`;
  const r = await runPs(script, 10_000);
  return r.ok ? { ok: true } : { ok: false, error: r.err?.slice(0, 200) };
}

/** 键盘输入（PowerShell SendKeys） */
export async function typeText(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!isWindows()) return { ok: false, error: "仅支持 Windows" };
  // 转义 SendKeys 特殊字符
  const escaped = text.replace(/[+^%~(){}[\]]/g, (m) => "{" + m + "}").slice(0, 500);
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${escaped}")
Write-Output "ok"`;
  const r = await runPs(script, 10_000);
  return r.ok ? { ok: true } : { ok: false, error: r.err?.slice(0, 200) };
}

/** 窗口列表（PowerShell Win32 EnumWindows 简化: 用 Get-Process 主窗口标题） */
export async function windowList(): Promise<{ ok: boolean; windows?: Array<{ title: string; pid: number }>; error?: string }> {
  if (!isWindows()) return { ok: false, error: "仅支持 Windows" };
  const script = `
Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object -First 20 Id, MainWindowTitle | ConvertTo-Json -Compress`;
  const r = await runPs(script, 10_000);
  if (!r.ok) return { ok: false, error: r.err?.slice(0, 200) };
  try {
    const parsed = JSON.parse(r.out.trim());
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return { ok: true, windows: list.map((w: any) => ({ title: String(w.MainWindowTitle || ""), pid: Number(w.Id) })) };
  } catch {
    return { ok: true, windows: [] };
  }
}

export const computerUseService = {
  isEnabled: () => ENABLED,
  screenshot,
  mouseAction,
  typeText,
  windowList,
};
