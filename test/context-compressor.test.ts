// context-compressor.test.ts — 上下文压缩单测（P0-6/P0-7）
import { describe, it, expect } from "vitest";
import {
  estimateContextChars, shouldCompress,
  splitByPriority, truncateToolResult, compressContext,
  SEGMENT_KEEP, SEGMENT_SUMMARIZE, SEGMENT_DROP,
} from "../src/services/context-compressor.js";

describe("estimateContextChars / shouldCompress", () => {
  it("估算字符数", () => {
    expect(estimateContextChars([{ role: "user", content: "你好" }])).toBe(2);
    expect(estimateContextChars([{ role: "user", content: "abc" }, { role: "assistant", content: "def" }])).toBe(6);
  });

  it("80% 阈值触发", () => {
    const big = "x".repeat(700_000);
    expect(shouldCompress([{ role: "user", content: big }])).toBe(true);
    const small = "x".repeat(100_000);
    expect(shouldCompress([{ role: "user", content: small }])).toBe(false);
  });
});

describe("splitByPriority（P0-7）", () => {
  it("KEEP 段原文保留", () => {
    const ctx = `${SEGMENT_KEEP}关键决策原文${SEGMENT_KEEP}`;
    const segs = splitByPriority(ctx);
    const keep = segs.find((s) => s.priority === "keep");
    expect(keep?.content).toBe("关键决策原文");
  });

  it("DROP 段保留完整内容（状态过滤在 compressContext）", () => {
    const ctx = `${SEGMENT_DROP}工具执行完成: 成功\n大量输出内容 abcdefg\n步骤2: 失败\n更多细节...${SEGMENT_DROP}`;
    const segs = splitByPriority(ctx);
    const drop = segs.find((s) => s.priority === "drop");
    expect(drop?.content).toContain("工具执行完成");
    expect(drop?.content).toContain("步骤2: 失败");
  });

  it("无标记内容默认 summarize", () => {
    const segs = splitByPriority("普通内容");
    expect(segs[0]?.priority).toBe("summarize");
  });
});

describe("truncateToolResult", () => {
  it("长输出截断头尾保留", () => {
    const text = Array.from({ length: 120 }, (_, i) => `line${i}`).join("\n");
    const out = truncateToolResult(text, 50, 50);
    expect(out).toContain("line0");
    expect(out).toContain("line119");
    expect(out).toContain("省略");
  });

  it("短输出不截断", () => {
    const text = "a\nb\nc";
    expect(truncateToolResult(text)).toBe(text);
  });
});

describe("compressContext", () => {
  it("历史消息压缩 + [COMPRESSED] 标记", () => {
    const msgs = [
      { role: "user", content: "x".repeat(3000) },
      { role: "assistant", content: "y".repeat(3000) },
      { role: "user", content: "最新消息" },  // 保留最新 2 轮
      { role: "assistant", content: "最新回复" },
    ];
    const r = compressContext("q", msgs);
    expect(r.outputChars).toBeLessThan(r.inputChars);
    expect(r.compressedCount).toBeGreaterThan(0);
    // 最新 2 轮不压缩
    expect(r.compressed[2].content).toBe("最新消息");
    expect(r.compressed[3].content).toBe("最新回复");
    // 已压缩的带标记
    expect(r.compressed[0].content).toContain("[COMPRESSED]");
  });

  it("已 [COMPRESSED] 的消息不重复压缩", () => {
    const msgs = [
      { role: "user", content: "x".repeat(3000) + "\n[COMPRESSED]" },
      { role: "user", content: "最新" },
    ];
    const r = compressContext("q", msgs);
    // 历史已压缩消息保留原样（防重复）
    expect(r.compressed[0].content).toContain("[COMPRESSED]");
  });

  it("DROP 段压缩后只剩状态行", () => {
    const msgs = [
      { role: "user", content: `${SEGMENT_DROP}工具执行完成: 成功\n大量输出内容 abcdefg\n步骤2: 失败\n更多细节...${SEGMENT_DROP}` },
      { role: "user", content: "中间消息" },
      { role: "user", content: "最新" },
    ];
    const r = compressContext("q", msgs);
    const lines = r.compressed[0].content.split("\n");
    // 只保留状态行 + [COMPRESSED] 标记
    expect(lines.every((l) => /(?:成功|失败|pass|fail|✓|✗|COMPRESSED)/.test(l))).toBe(true);
    expect(r.compressed[0].content).not.toContain("大量输出内容");
  });
});
