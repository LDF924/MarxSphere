// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/tool-result-store.test.ts — 工具大结果压缩存储 + 按需取回(V404-2, 参考 OpenSquilla tool_result_store)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = path.join(os.tmpdir(), `sag-tool-results-test-${process.pid}`);
process.env.SAG_TOOL_RESULT_DIR = TEST_DIR;

const {
  TOOL_RESULT_CHAR_THRESHOLD, storeLargeResult, retrieveStoredResult, cleanupExpired, parseLineRange,
} = await import("../src/services/tool-result-store.js");

beforeAll(() => { rmSync(TEST_DIR, { recursive: true, force: true }); });
afterAll(() => { rmSync(TEST_DIR, { recursive: true, force: true }); });

function bigText(n = 200, lineLen = 60): string {
  const rows: string[] = [];
  for (let i = 1; i <= n; i++) {
    rows.push(`第${i}行: ` + "某".repeat(lineLen - 6) + ` [marker-${i}]`);
  }
  return rows.join("\n");
}

describe("tool-result-store", () => {
  it("小结果(<阈值)原样返回, 不做任何包装", () => {
    const out = storeLargeResult("file_read", "short");
    expect(out.compressed).toBe(false);
    expect(out.view).toBe("short");
    expect(out.handle).toBeUndefined();
  });

  it("大文本: 压缩存储 → 模型拿预览+句柄 → 取回与原文逐字节一致", () => {
    const text = bigText(300); // ~300 行 × 60+ 字符
    expect(text.length).toBeGreaterThan(TOOL_RESULT_CHAR_THRESHOLD);
    const stored = storeLargeResult("search_web", text);
    expect(stored.compressed).toBe(true);
    expect(stored.handle).toBeDefined();
    expect(stored.view).toContain(stored.handle!);
    expect(stored.view).toContain("retrieve_tool_result");
    expect(stored.view).toContain("预览");
    // 模型视角看不到原文(只拿到 ~400 字符预览)
    expect(stored.view.length).toBeLessThan(1200);
    // 落盘: data/tool-results/<handle>.json.gz
    const file = path.join(TEST_DIR, `${stored.handle}.json.gz`);
    expect(existsSync(file)).toBe(true);
    // 取回全文与原文一致
    const r = retrieveStoredResult(stored.handle!);
    expect(r.ok).toBe(true);
    expect(r.content).toBe(text);
    expect(r.chars).toBe(text.length);
    // 内容寻址: 同内容再次存储 → 同句柄(去重)
    const again = storeLargeResult("search_web", text);
    expect(again.handle).toBe(stored.handle);
  });

  it("行窗口取回: 行号精确对应原文", () => {
    const text = bigText(100);
    const stored = storeLargeResult("dump_log", text);
    const r = retrieveStoredResult(stored.handle!, { lines: "10-12" });
    expect(r.ok).toBe(true);
    const lines = r.focused!.split("\n");
    expect(lines[0]).toBe("10: " + text.split("\n")[9]);
    expect(lines).toHaveLength(3);
  });

  it("关键词聚焦: 命中行 + 前后 3 行上下文, 带省略号", () => {
    const text = bigText(150); // ~150×70 ≈ 10500 字符 > 阈值
    const stored = storeLargeResult("search_web", text);
    expect(stored.compressed).toBe(true);
    // 命中 40 行前后 — 关键词 marker-40 在 150 行内唯一
    const r = retrieveStoredResult(stored.handle!, { keyword: "marker-40" });
    expect(r.ok).toBe(true);
    expect(r.focused!).toContain("40: ");
    expect(r.focused!).toContain("37: "); // 前 3 行上下文
    expect(r.focused!).toContain("43: "); // 后 3 行
    expect(r.focused).not.toContain("marker-20"); // 未命中的行不出现在聚焦里
  });

  it("关键词未命中 → 明确告知可全量取回", () => {
    const stored = storeLargeResult("search_web", bigText(150));
    expect(stored.compressed).toBe(true);
    const r = retrieveStoredResult(stored.handle!, { keyword: "不存在的词xyz" });
    expect(r.ok).toBe(true);
    expect(r.focused).toBeUndefined();
    expect(r.error).toContain("未命中");
  });

  it("非法句柄/不存在句柄 → 明确错误", () => {
    const bad = retrieveStoredResult("tr-zzzz");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("非法句柄");
    const missing = retrieveStoredResult("tr-" + "a".repeat(32));
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("不存在或已过期");
  });

  it("超单条上限(>8MB) → 不落盘, 返回截断说明", () => {
    const huge = "x".repeat(9 * 1024 * 1024);
    const stored = storeLargeResult("dump", huge);
    expect(stored.droppedReason).toBeDefined();
    expect(stored.view.length).toBeLessThan(9000);
    // 目录无新增大文件
    const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".json.gz"));
    expect(files.length).toBeLessThan(10);
  });

  it("过期清理: 超过 7 天的记录被清, 新记录保留", () => {
    const text = bigText(150);
    const stored = storeLargeResult("file_read", text);
    const handle = stored.handle!;
    expect(existsSync(path.join(TEST_DIR, `${handle}.json.gz`))).toBe(true);
    const removed = cleanupExpired(Date.now()); // now: 没有过期记录
    expect(removed).toBe(0);
    expect(existsSync(path.join(TEST_DIR, `${handle}.json.gz`))).toBe(true);
    // 模拟 8 天前 → 记录被清
    const removedOld = cleanupExpired(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(removedOld).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(TEST_DIR, `${handle}.json.gz`))).toBe(false);
    const r = retrieveStoredResult(handle);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("已过期");
  });

  it("parseLineRange: 合法/非法格式", () => {
    expect(parseLineRange("1-200")).toEqual({ start: 1, end: 200 });
    expect(parseLineRange("42")).toEqual({ start: 42, end: 42 });
    expect(parseLineRange("10-5")).toEqual({ start: 10, end: 10 }); // 反向 → 归一
    expect(parseLineRange("abc")).toBeNull();
    expect(parseLineRange("")).toBeNull();
  });
});
