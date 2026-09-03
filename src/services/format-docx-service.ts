// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// format-docx-service.ts — .docx 格式检查编排服务(2026-09-03)
// 调 Python 子进程(vendor/format-check/format-check-cli.py, MIT 移植见 THIRD_PARTY_NOTICES):
//   1. inspect docx → Word 级样式 findings(页边距/字号/行距等 ~17 条规则)
//   2. extract-text docx → 纯文本 → 喂给 TS 规则引擎(内容级语义检测)
//   3. extract-template 学校模板 → 规则 JSON(自定义模板导入)
// 输出统一为 FormatIssue(与 TS 引擎同构), 前端合并展示。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync } from "node:fs";
import os from "node:os";
import { runRuleEngine, type FormatIssue } from "./format-eval-engine.js";
import type { FormatTemplate } from "./format-eval-templates.js";

const execFileAsync = promisify(execFile);

export interface DocxStyleFinding {
  rule_id: string;
  message: string;
  severity: string;
  expected?: unknown;
  actual?: unknown;
  location?: string;
  fixable?: boolean;
}

export interface DocxInspectResult {
  ok: boolean;
  error?: string;
  preset?: string;
  findings?: DocxStyleFinding[];
  stats?: { errors: number; warnings: number; infos: number };
}

const VENDOR_CLI = path.resolve(
  process.cwd(),
  "vendor",
  "format-check",
  "format-check-cli.py",
);

/** python 可执行: 优先项目 venv, 退回系统 python */
function pythonBin(): string {
  const venvPy = path.resolve(process.cwd(), ".venv-fmtcheck", "Scripts", "python.exe");
  if (existsSync(venvPy)) return venvPy;
  return process.platform === "win32" ? "python" : "python3";
}

async function runCli(args: string[], timeoutMs = 120_000): Promise<unknown> {
  const { stdout } = await execFileAsync(pythonBin(), [VENDOR_CLI, ...args], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

/** 样式级检查: Word 文档属性 → findings */
export async function inspectDocxStyle(
  docxPath: string,
  preset = "ncwu",
): Promise<DocxInspectResult> {
  try {
    const result = await runCli(["inspect", docxPath, "--preset", preset]) as DocxInspectResult;
    return result;
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 提取 docx 纯文本(供 TS 引擎) */
export async function extractDocxText(docxPath: string): Promise<string> {
  const result = await runCli(["extract-text", docxPath]) as { ok: boolean; text?: string; error?: string };
  if (!result.ok || result.text === undefined) {
    throw new Error(result?.error ?? "docx 文本提取失败");
  }
  return result.text;
}

/** 模板规则提取: 学校模板 docx → 结构化规则(JSON 落盘路径) */
export async function extractDocxTemplate(
  templatePath: string,
): Promise<{ ok: boolean; output?: string; styles?: number; warnings?: string[]; error?: string }> {
  try {
    const outPath = path.join(os.tmpdir(), `school-template-rules-${Date.now()}.json`);
    const result = await runCli(["extract-template", templatePath, "--output", outPath]) as {
      ok: boolean; output?: string; styles?: number; warnings?: string[]; error?: string;
    };
    return { ...result, output: result.ok ? outPath : undefined };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** docx 全检查: 样式级(python) + 文本级(TS 引擎)合并 */
export async function checkDocxFull(
  docxPath: string,
  tpl: FormatTemplate,
  preset = "ncwu",
): Promise<{
  ok: boolean;
  error?: string;
  styleFindings: FormatIssue[];
  textFindings: FormatIssue[];
}> {
  try {
    // 1) 样式级
    const styleResult = await inspectDocxStyle(docxPath, preset);
    const styleFindings: FormatIssue[] = (styleResult.findings ?? []).map((f) => ({
      ruleId: `docx-${f.rule_id}`,
      category: "Word样式",
      severity: f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "info",
      message: f.message ?? "",
      paragraph: 0,
      snippet: "",
      suggestion: f.location ? `位置: ${f.location}` : "",
    }));

    // 2) 文本级(提取文本喂 TS 引擎)
    const text = await extractDocxText(docxPath);
    const textFindings = runRuleEngine(text, tpl);

    return { ok: true, styleFindings, textFindings };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), styleFindings: [], textFindings: [] };
  }
}
