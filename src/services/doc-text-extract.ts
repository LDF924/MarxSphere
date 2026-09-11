// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// doc-text-extract.ts — 论文稿件文本提取(pdf / docx)
// 由来(2026-09-11): /api/files/extract-text 对 .pdf 走的是"把字节按 utf-8 读一遍"的兜底分支,
//   PDF 是二进制 → 提取出一堆乱码交给 LLM 审稿, 用户只会看到审稿意见驴唇不对马嘴。
//   这里用 pdfjs-dist 做真实文本层提取(取不到文本层的扫描件明确报错, 不编内容)。

/** PDF → 纯文本(按页拼接, 页间空行)。扫描件无文本层时返回空串。 */
export async function extractPdfText(buf: Buffer, maxPages = 80): Promise<{ text: string; pageCount: number; extractedPages: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs 在 Node 下不需要 worker; 关掉字体加载以免告警刷屏
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
  } as Parameters<typeof pdfjs.getDocument>[0]).promise;
  const pageCount = doc.numPages;
  const pages = Math.min(pageCount, maxPages);
  const out: string[] = [];
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const line = content.items
      .map((it) => (typeof (it as { str?: unknown }).str === "string" ? (it as { str: string }).str : ""))
      .join("")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (line) out.push(line);
  }
  try { await (doc as { destroy?: () => Promise<void> }).destroy?.(); } catch { /* 忽略 */ }
  return { text: out.join("\n\n"), pageCount, extractedPages: pages };
}

/** 结构化成 OCR 提示的容器格式(existing extract-text 的 fallback 约定) */
export interface ExtractResult {
  text: string;
  sourceType: "pdf" | "docx" | "txt";
  pageCount?: number;
  extractedPages?: number;
  truncated?: boolean;
  extractionWarnings?: string[];
}

/** 统一入口: 按扩展名分派, 失败返回可读错误而不是乱码文本 */
export async function extractDocumentText(
  buf: Buffer,
  filename: string,
  deps: { docx: (path: string) => Promise<string>; tmpPath: string }
): Promise<{ ok: true; result: ExtractResult } | { ok: false; error: string }> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) {
    let text = "", pageCount = 0, extractedPages = 0;
    try {
      ({ text, pageCount, extractedPages } = await extractPdfText(buf));
    } catch (e) {
      // 坏文件/加密 PDF: pdfjs 抛的是英文内部错误, 不能直接冒到用户面前
      const msg = String((e as Error)?.message ?? e).slice(0, 120);
      return { ok: false, error: `PDF 解析失败(${msg})。文件可能已损坏或加了密码, 请改用「粘贴文本」。` };
    }
    if (!text.trim()) {
      return { ok: false, error: "该 PDF 未提取到文字(可能是扫描件/纯图片版)。请改用「粘贴文本」或先做 OCR。" };
    }
    return { ok: true, result: { text, sourceType: "pdf", pageCount, extractedPages, truncated: pageCount > extractedPages } };
  }
  if (lower.endsWith(".docx")) {
    // docx 由调用方注入(依赖 .venv 的 python-docx 通道), 避免本模块直接依赖进程环境
    const text = await deps.docx(deps.tmpPath);
    if (!text.trim()) return { ok: false, error: "该 .docx 未提取到正文, 请改用「粘贴文本」" };
    return { ok: true, result: { text, sourceType: "docx" } };
  }
  if (lower.endsWith(".txt") || lower.endsWith(".md")) {
    const text = buf.toString("utf-8");
    if (!text.trim()) return { ok: false, error: "文本文件为空" };
    return { ok: true, result: { text, sourceType: "txt" } };
  }
  return { ok: false, error: "仅支持 .pdf / .docx / .txt / .md, 请改用「粘贴文本」" };
}
