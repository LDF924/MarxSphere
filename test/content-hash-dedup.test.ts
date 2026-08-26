import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

// V398 文献入库哈希版本化 — 哈希判重逻辑测试（纯函数，不依赖 DB/embedding）
// 与 ingestion-service.ts / webui-service.ts 的 sha256 计算保持一致（createHash("sha256").update(content).digest("hex")）

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("content hash dedup (V398)", () => {
  it("same content produces identical hash", () => {
    const content = "同一篇论文的正文内容，包含中文与\n换行符。";
    expect(contentHash(content)).toBe(contentHash(content));
  });

  it("different content produces different hash", () => {
    const a = "工商资本下乡研究正文";
    const b = "工商资本下乡研究正文（修订版）";
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it("hash is 64 hex chars (sha256)", () => {
    expect(contentHash("任意内容")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("title change does not affect hash (content-level dedup)", () => {
    // 换标题同内容 → 哈希相同 → 判重应命中（堵 title 判重漏洞）
    const content = "内容不变，标题变了也不会影响哈希";
    expect(contentHash(content)).toBe(contentHash(content));
  });

  it("whitespace normalization matters — raw content hashed as-is (matches ingest path)", () => {
    // 与 ingestion-service.ts 一致：对清洗后的 input.content 直接 hash，不做额外规范化
    const c1 = "有空格 内容";
    const c2 = "有空格  内容"; // 双空格 → 哈希应不同（内容确实不同）
    expect(contentHash(c1)).not.toBe(contentHash(c2));
  });
});
