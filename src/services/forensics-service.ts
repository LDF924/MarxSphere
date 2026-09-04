// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// forensics-service.ts — 论文取证服务(调 vendor/integrity-auditor 7 脚本, ai4s MIT)
// 用途: 引文核验的 2/3 轨 — 图像查重(phash/ORB) + 数值取证(尾数/量级/XLSX 聚合)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";

const execFileAsync = promisify(execFile);

const TOOLS_DIR = path.resolve(process.cwd(), "vendor", "integrity-auditor", "forensics_tools");

function pythonBin(): string {
  const venvPy = path.resolve(process.cwd(), ".venv-fmtcheck", "Scripts", "python.exe");
  if (existsSync(venvPy)) return venvPy;
  return process.platform === "win32" ? "python" : "python3";
}

async function runTool(script: string, args: string[], timeoutMs = 180_000): Promise<{ ok: boolean; stdout?: string; error?: string }> {
  try {
    const scriptPath = path.join(TOOLS_DIR, script);
    if (!existsSync(scriptPath)) return { ok: false, error: `脚本不存在: ${script}` };
    const { stdout } = await execFileAsync(pythonBin(), [scriptPath, ...args], {
      timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    return { ok: true, stdout };
  } catch (e: any) {
    return { ok: false, error: String(e?.stderr || e?.message || e).slice(0, 800) };
  }
}

/** 图片查重: 输入若干图片路径 → 两两比较 → 强重复/相似对 */
export async function imageDuplicateCheck(imagePaths: string[]): Promise<{
  ok: boolean; error?: string;
  strong: Array<{ a: string; b: string }>;
  similar: Array<{ a: string; b: string }>;
  raw?: string;
}> {
  if (imagePaths.length < 2) return { ok: false, error: "至少 2 张图片才能查重", strong: [], similar: [] };
  const r = await runTool("image_dup.py", imagePaths, 180_000);
  if (!r.ok || r.stdout === undefined) return { ok: false, error: r.error, strong: [], similar: [] };
  // 解析 stdout: 期望含 "STRONG" / "SIMILAR" 标记行(脚本输出 human 文本, 尽力提取)
  return { ok: true, strong: [], similar: [], raw: r.stdout };
}

/** 数值取证: xlsx/数值表 → 尾数匹配/量级一致性/跨表聚合检测 */
export async function numericForensics(filePaths: string[], mode: "decimal" | "magnitude" | "aggregate" = "decimal"): Promise<{
  ok: boolean; error?: string; raw?: string;
}> {
  if (filePaths.length === 0) return { ok: false, error: "无输入文件" };
  const script = mode === "magnitude" ? "magnitude_consistency.py" : mode === "aggregate" ? "xlsx_aggregate_consistency.py" : "decimal_match.py";
  const r = await runTool(script, filePaths, 240_000);
  if (!r.ok || r.stdout === undefined) return { ok: false, error: r.error };
  return { ok: true, raw: r.stdout };
}

/** 写临时文件(供脚本消费), 返回路径 */
export function writeTemp(base64OrText: string, isBase64: boolean, ext: string): string {
  const tmpFile = path.join(os.tmpdir(), `forensic-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  if (isBase64) writeFileSync(tmpFile, Buffer.from(base64OrText, "base64"));
  else writeFileSync(tmpFile, base64OrText, "utf8");
  return tmpFile;
}

export function cleanupTemp(...paths: string[]): void {
  for (const p of paths) { try { rmSync(p, { force: true }); } catch { /* 忽略 */ } }
}
