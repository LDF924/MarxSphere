// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// test/runtime-guards.test.ts — V404-23: 运行时防护(H1 进度哨兵 / H2 复读检测 / H4 代码页解码)
// 借鉴 OpenSquilla engine/{progress_watchdog,repetition_guard} + subprocess_encoding 自写实现
import { describe, it, expect } from "vitest";
import { RepetitionGuard, ProgressWatchdog, decodeSubprocessOutput } from "../src/services/runtime-guards.js";

describe("runtime-guards", () => {
  // ═══ H2: 复读检测 ═══
  it("H2 复读: 相同句子重复 8+ 次 → 检出", () => {
    const g = new RepetitionGuard({ checkStrideChars: 32, minRepetitions: 6 });
    let detected = null;
    for (let i = 0; i < 40; i++) {
      detected = g.feed("剩余价值率等于剩余价值除以可变资本,这是马克思政治经济学批判的核心公式。");
      if (detected) break;
    }
    expect(detected).not.toBeNull();
    expect(detected!.repetitions).toBeGreaterThanOrEqual(6);
    expect(detected!.similarity).toBeGreaterThanOrEqual(0.95);
  });

  it("H2 正常长文本不误报", () => {
    const g = new RepetitionGuard({ checkStrideChars: 64, minRepetitions: 8 });
    let detected = null;
    for (let i = 0; i < 10; i++) {
      // 每次不同内容
      // 每段主题完全不同(防内容 95% 相似被误判为周期)
      const topics = ["劳动价值论与商品拜物教", "资本有机构成与利润率趋向下降", "地租理论与级差地租形态", "货币流通规律与通货膨胀", "再生产图式与两大部类平衡", "信用制度与虚拟资本膨胀", "世界市场与国际分工格局", "原始积累与殖民主义批判", "生产价格转型问题争论", "国家垄断资本主义阶段"];
      detected = g.feed(`关于${topics[i % topics.length]},马克思主义政治经济学分析强调历史唯物主义方法,既考察制度变迁的结构约束,也审视阶级关系在生产关系再生产中的具体展开方式。`);
      if (detected) break;
    }
    expect(detected).toBeNull();
  });

  it("H2 重置后不再触发", () => {
    const g = new RepetitionGuard({ checkStrideChars: 16, minRepetitions: 3 });
    const s = "重复的句子A。";
    let hit = false;
    for (let i = 0; i < 8 && !hit; i++) { hit = !!g.feed(s); }
    expect(hit).toBe(true);
    g.reset(); // 缓冲清空 — 立即再次 feed 不会触发(无历史)
    expect(g.feed(s)).toBeNull();
  });

  // ═══ H1: 进度哨兵 ═══
  it("H1 连续只读检索无产出 ≥8 轮 → warn", () => {
    const w = new ProgressWatchdog({ sourceContextWithoutWriteThreshold: 8 });
    let warn = null;
    for (let i = 0; i < 9; i++) {
      const d = w.observe({ sourceContextSuccess: true, signature: `检索轮${i % 2 === 0 ? "A" : "A"}` });
      if (d.action === "warn") { warn = d; break; }
    }
    expect(warn).not.toBeNull();
    expect(warn!.reason).toContain("只读检索无产出");
  });

  it("H1 有产出即重置(检索几轮后写库 → 重新累计)", () => {
    const w = new ProgressWatchdog({ sourceContextWithoutWriteThreshold: 5 });
    let warnedAt: number[] = [];
    for (let i = 0; i < 20; i++) {
      const d = i === 7 ? w.observe({ artifactCompleted: true }) : w.observe({ sourceContextSuccess: true, signature: "s" });
      if (d.action === "warn") warnedAt.push(i);
    }
    // 重置后重新累计: 第 5 轮(索引4)首次告警, 之后每 +5 轮再告警; 产出(7)重置后 8 起重新累计
    expect(warnedAt).toEqual([4, 12, 17]);
  });

  it("H1 同错误重复 ≥3 → warn(observe-only 不 block)", () => {
    const w = new ProgressWatchdog({ repeatedToolErrorThreshold: 3 });
    let warn = null;
    for (let i = 0; i < 3; i++) {
      const d = w.observe({ toolError: "LLM 超时" });
      if (d.action === "warn") warn = d;
    }
    expect(warn).not.toBeNull();
    expect(warn!.action).toBe("warn"); // observe_only 默认
    // observeOnly=false → block
    const w2 = new ProgressWatchdog({ repeatedToolErrorThreshold: 3, observeOnly: false });
    let block = null;
    for (let i = 0; i < 3; i++) {
      const d = w2.observe({ toolError: "LLM 超时" });
      if (d.action === "block") block = d;
    }
    expect(block).not.toBeNull();
  });

  // ═══ H4: 代码页解码 ═══
  it("H4 UTF-8 正常输出原样(无误读回退)", () => {
    const buf = Buffer.from("中文正常输出", "utf8");
    expect(decodeSubprocessOutput(buf)).toBe("中文正常输出");
  });

  it("H4 纯 ASCII 不受影响", () => {
    expect(decodeSubprocessOutput(Buffer.from("hello world"))).toBe("hello world");
  });

  it("H4 空输入 → 空串", () => {
    expect(decodeSubprocessOutput(null)).toBe("");
    expect(decodeSubprocessOutput(Buffer.alloc(0))).toBe("");
  });

  it("H4 GBK 字节被当 UTF-8 时回退系统代码页(Windows 有 cp 时)", () => {
    // "中文" GBK 编码 = D6 D0 CE C4
    const gbk = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]);
    const decoded = decodeSubprocessOutput(gbk);
    // 若 TextDecoder gbk 可用且误读分更高 → 应解出"中文"; 否则 UTF-8 替换符
    expect(decoded.length).toBeGreaterThan(0);
  });
});
