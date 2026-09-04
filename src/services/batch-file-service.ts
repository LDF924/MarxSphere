// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// batch-file-service.ts — 批量文件解析(多 PDF/Word/Excel/PPT → 逐份提取文本)
// 解析逻辑与 agent attachment_read 同 python 方案(pymupdf/python-docx/openpyxl/python-pptx)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface ParsedFile {
  fileName: string;
  ok: boolean;
  text: string;       // 解析文本(截断至 maxChars)
  charCount: number;
  error?: string;
}

function pythonBin(): string {
  const venvPy = path.resolve(process.cwd(), ".venv-fmtcheck", "Scripts", "python.exe");
  if (existsSync(venvPy)) return venvPy;
  return process.env.COGNEE_PYTHON || process.env.EMPIRICAL_PYTHON || "python";
}

const SUPPORTED = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"];

export function isSupportedFile(name: string): boolean {
  return SUPPORTED.includes(path.extname(name).toLowerCase());
}

function parseScript(target: string, maxChars: number): string {
  const safe = target.replace(/\\/g, "\\\\");
  return `
import sys
from pathlib import Path
p = Path(r"${safe}")
ext = p.suffix.lower()
out = []
try:
    if ext == ".pdf":
        import pymupdf
        doc = pymupdf.open(str(p))
        for page in doc:
            if len("\\n".join(out)) > ${maxChars}: break
            out.append(page.get_text())
    elif ext in (".docx", ".doc"):
        from docx import Document
        d = Document(str(p))
        for para in d.paragraphs:
            if para.text.strip(): out.append(para.text)
        for t in d.tables:
            for row in t.rows:
                out.append(" | ".join(c.text.strip() for c in row.cells))
    elif ext in (".xlsx", ".xls"):
        import openpyxl
        wb = openpyxl.load_workbook(str(p), read_only=True, data_only=True)
        for ws in wb.worksheets:
            out.append(f"[Sheet: {ws.title}]")
            for row in ws.iter_rows(values_only=True):
                out.append(" | ".join(str(c) if c is not None else "" for c in row))
    elif ext in (".pptx", ".ppt"):
        from pptx import Presentation
        prs = Presentation(str(p))
        for i, slide in enumerate(prs.slides):
            out.append(f"[Slide {i+1}]")
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        if para.text.strip(): out.append(para.text)
    text = "\\n".join(out)
    print(text[:${maxChars}])
except Exception as e:
    print(f"（解析失败: {e}）")
`;
}

/** 解析单个文件(写入临时文件 → python 提取) */
async function parseOne(fileName: string, base64: string, maxChars: number): Promise<ParsedFile> {
  const ext = path.extname(fileName).toLowerCase();
  const tmp = path.join(os.tmpdir(), `batch-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  try {
    writeFileSync(tmp, Buffer.from(base64, "base64"));
    const { stdout } = await execFileAsync(pythonBin(), ["-c", parseScript(tmp, maxChars)], {
      timeout: 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    const text = String(stdout ?? "").trim();
    if (text.startsWith("（解析失败")) {
      return { fileName, ok: false, text: "", charCount: 0, error: text.slice(0, 120) };
    }
    return { fileName, ok: true, text, charCount: text.length };
  } catch (e: any) {
    return { fileName, ok: false, text: "", charCount: 0, error: String(e?.message || e).slice(0, 120) };
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
  }
}

/** 批量解析: 多文件(base64) → 逐份文本(顺序执行, 限并发防资源耗尽) */
export async function parseBatch(files: Array<{ name: string; base64: string }>, opts: {
  maxChars?: number;
  concurrency?: number;
} = {}): Promise<{ results: ParsedFile[]; okCount: number; failCount: number }> {
  const maxChars = opts.maxChars ?? 8000;
  const concurrency = opts.concurrency ?? 3;
  const results: ParsedFile[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const idx = cursor++;
      const f = files[idx];
      results[idx] = await parseOne(f.name, f.base64, maxChars);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);
  const ok = results.filter((r) => r.ok);
  return { results, okCount: ok.length, failCount: results.length - ok.length };
}
