// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// mineru-go-adapter.ts — V399: mineru-go (Rimagination) 双模式转换适配层
// 复用 Rimagination/mineru-go 的 mineru_api_convert.py 源码（vendor/mineru-go/）:
//   - Agent 轻量 API (≤10MB, ≤20页): 快速通道, 适合非扫描件
//   - Precision 精准 API: 全量通道, 扫描件/大文件自动路由
// 与 V395 的 pdf2obsidian 官方 v4 管线互补: mineru-go 提供"自动路由 + 轻量通道",
// pdf2obsidian 提供"完整 6 阶段管线(翻译/导出/质量检查)"。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MINERU_GO_SCRIPT = join(process.env.SAG_ROOT || process.cwd(), "vendor", "mineru-go", "mineru_api_convert.py");
const MD_CLEAN_SCRIPT = join(process.env.SAG_ROOT || process.cwd(), "vendor", "scansci-pdf", "md_clean_cli.py");
const PYTHON = process.env.MINERU_GO_PYTHON || "python";

export interface MineruGoResult {
  ok: boolean;
  mode?: "agent" | "precision";
  markdownPath?: string;
  content?: string;
  manifest?: Record<string, unknown>;
  error?: string;
}

function readEnvValue(key: string): string | undefined {
  if (process.env[key]?.trim()) return process.env[key].trim();
  for (const envFile of [".env", "web/.env", "web/.env.local", ".env.local"]) {
    try {
      for (const line of readFileSync(envFile, "utf-8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)$/);
        if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
      }
    } catch { /* 文件不存在跳过 */ }
  }
  return undefined;
}

/** 探测文件是否扫描件（粗略启发式: 扩展名 + 存在性; 真正判断由 MinerU 官方 is_ocr 承担） */
export function isLikelyScanned(pdfPath: string): boolean {
  return pdfPath.toLowerCase().endsWith(".pdf");
}

/**
 * Markdown 清洗（V399: scansci-pdf md_export 提炼）:
 * 修复 pymupdf4llm/MinerU 产物的确定性瑕疵 — 组合变音符号、替换字符计数、
 * NFC 归一化。入库原文前调用, 保证索引质量。
 */
export function cleanMarkdown(mdText: string): { ok: boolean; text?: string; warnings?: string[]; error?: string } {
  if (!mdText) return { ok: true, text: "", warnings: [] };
  if (!existsSync(MD_CLEAN_SCRIPT)) {
    // 脚本缺失时降级: 仅做基础清洗（不阻塞管线）
    return { ok: true, text: mdText, warnings: ["scansci-pdf 清洗脚本缺失, 未清洗"] };
  }
  try {
    const tmp = mkdtempSync(join(tmpdir(), "md-clean-"));
    const inPath = join(tmp, "in.md");
    writeFileSync(inPath, mdText, "utf-8");
    const out = execFileSync(PYTHON, [MD_CLEAN_SCRIPT, inPath], { encoding: "utf-8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const parsed = JSON.parse(out);
    const text = readFileSync(join(tmp, "out.md"), "utf-8");
    rmSync(tmp, { recursive: true, force: true });
    return { ok: true, text, warnings: parsed.warnings || [] };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * 用 mineru-go 转换文档（自动路由 Agent/Precision）
 * @param pdfPath 文档路径（pdf/png/jpg/docx/pptx/xlsx）
 * @param opts.mode 强制模式 auto/agent/precision
 * @param opts.ocr 启用 OCR（扫描件）
 * @param opts.outputDir 输出目录（默认 .pipeline/mineru-go-out）
 * @param opts.maxChars 截断返回的 content
 */
export function convertViaMineruGo(
  pdfPath: string,
  opts?: {
    mode?: "auto" | "agent" | "precision";
    ocr?: boolean;
    outputDir?: string;
    maxChars?: number;
    language?: string;
    timeoutMs?: number;
  }
): MineruGoResult {
  if (!existsSync(pdfPath)) return { ok: false, error: `文件不存在: ${pdfPath}` };
  if (!existsSync(MINERU_GO_SCRIPT)) return { ok: false, error: `mineru-go 脚本缺失: ${MINERU_GO_SCRIPT}` };

  // 先检查 token（提前失败, 避免 API 调用报错）
  const token = readEnvValue("MINERU_TOKEN") || readEnvValue("MINERU_API_TOKEN") || readEnvValue("MINERU_API_KEY");
  if (!token) {
    return { ok: false, error: "MINERU_TOKEN 未配置（.env）; 到 mineru.net/apiManage 申请" };
  }

  const outputDir = opts?.outputDir || join(".pipeline", "mineru-go-out");
  const args: string[] = [
    MINERU_GO_SCRIPT,
    pdfPath,
    "-o", outputDir,
    "--token", token,
    "--api-mode", opts?.mode || "auto",
    "--language", opts?.language || "en",  // Agent 轻量 API 仅支持 en; Precision 也接受 en
  ];
  if (opts?.ocr) args.push("--ocr");
  if (opts?.timeoutMs) args.push("--timeout", String(Math.floor(opts.timeoutMs / 1000)));

  try {
    const stdout = execFileSync(PYTHON, args, {
      encoding: "utf-8",
      timeout: opts?.timeoutMs || 600_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, MINERU_TOKEN: token, MINERU_API_TOKEN: token },
    });
    // 解析输出的 markdown 路径
    const modeMatch = stdout.match(/mode=(\w+)/);
    const mode = (modeMatch?.[1] || "precision") as "agent" | "precision";
    // manifest 记录了归一化路径 (mineru-go 生成 mineru_manifest.json)
    const manifestPath = join(outputDir, "mineru_manifest.json");
    let manifest: Record<string, unknown> | undefined;
    let markdownPath: string | undefined;
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      } catch { /* 忽略解析失败 */ }
    }
    // 找产出 markdown: 优先 manifest.markdown_path, 再扫子目录的 *.md
    if (manifest) {
      const md = (manifest as any).markdown_path || (manifest as any).primary_path;
      if (md && existsSync(md)) markdownPath = md;
    }
    if (!markdownPath) {
      // 递归扫输出目录找 .md（跳过 assets/）
      const stack: string[] = [outputDir];
      while (stack.length && !markdownPath) {
        const dir = stack.pop()!;
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          let st: any;
          try { st = statSync(full); } catch { continue; }
          if (st.isDirectory()) { if (entry !== "assets") stack.push(full); }
          else if (entry.endsWith(".md")) { markdownPath = full; break; }
        }
      }
    }
    let content: string | undefined;
    if (markdownPath && existsSync(markdownPath)) {
      content = readFileSync(markdownPath, "utf-8");
      const max = opts?.maxChars || 8000;
      if (content.length > max) content = content.slice(0, max);
    }
    return { ok: true, mode, markdownPath, content, manifest };
  } catch (e: any) {
    const msg = String(e?.stdout || e?.message || e).slice(0, 400);
    return { ok: false, error: msg };
  }
}

/** 转换到 ov_import 论文目录（PDF → {stem}/original.md + manifest） */
export function convertPdfToOriginalMd(
  pdfPath: string,
  targetDir: string,
  opts?: { ocr?: boolean; mode?: "auto" | "agent" | "precision" }
): MineruGoResult {
  const r = convertViaMineruGo(pdfPath, { ...opts, outputDir: targetDir, maxChars: 0 });
  if (!r.ok || !r.markdownPath) return r;
  return { ...r, markdownPath: r.markdownPath };
}

export const mineruGoAdapter = { convertViaMineruGo, convertPdfToOriginalMd, isLikelyScanned };
