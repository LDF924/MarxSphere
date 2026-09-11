// doc-text-extract.test.ts — 论文稿件文本提取契约
// 由来(2026-09-11): .pdf 原本走 "把二进制按 utf-8 读" 的兜底分支 → 提取出乱码交给 LLM 审稿。
// 这里锁住: 真 PDF 走 pdfjs 出文本 / 坏 PDF 给可读错误 / 不支持的扩展名明确拒绝。
import { describe, expect, it } from "vitest";
import { extractDocumentText, extractPdfText } from "../src/services/doc-text-extract.js";

const deps = { tmpPath: "unused", docx: async () => "" };

describe("extractDocumentText 分派", () => {
  it("不支持的扩展名 → 明确拒绝(不再按 utf-8 硬读)", async () => {
    const r = await extractDocumentText(Buffer.from("PKdummy"), "data.xlsx", deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("仅支持");
  });

  it("空文本文件 → 报错而不是返回空串", async () => {
    const r = await extractDocumentText(Buffer.from("   \n  "), "a.txt", deps);
    expect(r.ok).toBe(false);
  });

  it(".txt 正常读回", async () => {
    const r = await extractDocumentText(Buffer.from("本文考察数字经济对城乡收入差距的影响。"), "a.txt", deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.sourceType).toBe("txt");
  });

  it("坏 PDF → 可读中文错误(不冒 pdfjs 英文内部错误)", async () => {
    const r = await extractDocumentText(Buffer.from("%PDF-1.4\nnot really a pdf"), "broken.pdf", deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("PDF 解析失败");
      expect(r.error).toContain("粘贴文本");
    }
  });

  it("docx 由注入的提取器处理, 空则报错", async () => {
    const r = await extractDocumentText(Buffer.from("PK"), "a.docx", { ...deps, docx: async () => "   " });
    expect(r.ok).toBe(false);
    const ok = await extractDocumentText(Buffer.from("PK"), "a.docx", { ...deps, docx: async () => "论文正文内容" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.result.sourceType).toBe("docx");
  });
});

describe("extractPdfText", () => {
  it("无文本层的 PDF → 返回空文本与真实页数(不编内容)", async () => {
    // 最小可用 PDF: 一页空白
    const minimal = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
      "trailer<</Root 1 0 R>>\n%%EOF"
    );
    const r = await extractPdfText(minimal);
    expect(r.pageCount).toBeGreaterThanOrEqual(1);
    expect(r.text.trim()).toBe("");
    expect(r.extractedPages).toBeLessThanOrEqual(r.pageCount);
  });
});
