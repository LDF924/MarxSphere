// 章节级版本对比的差异算法(V425 D3)
//
// 为什么值得单测: 这是**纯函数**, 却是对比功能的全部正确性所在 —— 段落怎么对齐、
// 哪些算"改写"哪些算"删+增", 全在这几十行里。而真浏览器里只能验到"屏幕上出现了红绿",
// 验不出"两段毫不相干的文字会不会被凑成一对"(那会让每段都显示成改写, 满屏噪声)。
// 边界(空文本、单段、全改、全同、超长)也只有在单测里才便宜。
import { describe, it, expect } from "vitest";
import { splitParagraphs, diffWords, diffParagraphs, diffStats, type ParaDiff } from "../web/socialsci-vue/src/shared/diff.js";

describe("splitParagraphs — 段落切分", () => {
  it("空行优先", () => {
    expect(splitParagraphs("第一段\n\n第二段\n\n第三段")).toEqual(["第一段", "第二段", "第三段"]);
  });

  it("没有空行时退回单换行(中文论文常一段一行)", () => {
    expect(splitParagraphs("第一段\n第二段")).toEqual(["第一段", "第二段"]);
  });

  it("CRLF 与多余空白都要吃掉", () => {
    expect(splitParagraphs("甲\r\n\r\n  乙  \r\n")).toEqual(["甲", "乙"]);
  });

  it("空文本 → 空数组(不是 [''])", () => {
    expect(splitParagraphs("")).toEqual([]);
    expect(splitParagraphs("   \n\n  ")).toEqual([]);
  });
});

describe("diffWords — 词级差异", () => {
  it("汉字逐字比较: 只标出改动的那几个字", () => {
    const segs = diffWords("资本下乡研究", "资本进城研究");
    // 相邻的同类词会**合并成一段**(渲染时少嵌套一层), 所以断言按合并后的段写
    expect(segs.filter((s: { t: "same" | "del" | "add"; s: string }) => s.t === "del").map((s: { t: "same" | "del" | "add"; s: string }) => s.s)).toEqual(["下乡"]);
    expect(segs.filter((s: { t: "same" | "del" | "add"; s: string }) => s.t === "add").map((s: { t: "same" | "del" | "add"; s: string }) => s.s)).toEqual(["进城"]);
    expect(segs.filter((s: { t: "same" | "del" | "add"; s: string }) => s.t === "same").map((s: { t: "same" | "del" | "add"; s: string }) => s.s).join("")).toBe("资本研究");
  });

  it("拉丁词整体比较: 不把 English 拆成一个个字母", () => {
    const segs = diffWords("hello world", "hello there");
    const dels = segs.filter((s: { t: "same" | "del" | "add"; s: string }) => s.t === "del").map((s: { t: "same" | "del" | "add"; s: string }) => s.s).join("");
    expect(dels).toBe("world");
    // 拆成字母的话删除段会是 "world" 之外的碎片, 这条就是防那个
    expect(segs.some((s: { t: "same" | "del" | "add"; s: string }) => s.t === "same" && s.s.includes("hello"))).toBe(true);
  });

  it("完全相同时只有一个 same 段(不产生空的 del/add)", () => {
    const segs = diffWords("一模一样", "一模一样");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ t: "same", s: "一模一样" });
  });

  it("超长文本降级成整段标注而不是卡死", () => {
    const a = "甲".repeat(5000), b = "乙".repeat(5000);
    const segs = diffWords(a, b);
    // O(n*m) 是 25M, 会卡住界面 —— 降级路径必须存在且只有两段
    expect(segs).toEqual([{ t: "del", s: a }, { t: "add", s: b }]);
  });
});

describe("diffParagraphs — 段落对齐", () => {
  it("相同的前后缀被识别为 same", () => {
    const d = diffParagraphs("开头\n\n中间\n\n结尾", "开头\n\n改过的中间\n\n结尾");
    expect(d.map((x: ParaDiff) => x.kind)).toEqual(["same", "changed", "same"]);
    expect(diffStats(d)).toMatchObject({ same: 2, changed: 1, removed: 0, added: 0 });
  });

  it("中间多出一段 → added, 不把后续段落全判成改写", () => {
    const d = diffParagraphs("甲\n\n乙", "甲\n\n新插入的一段\n\n乙");
    expect(d.map((x: ParaDiff) => x.kind)).toEqual(["same", "added", "same"]);
  });

  it("中间少一段 → removed", () => {
    const d = diffParagraphs("甲\n\n要被删的\n\n乙", "甲\n\n乙");
    expect(d.map((x: ParaDiff) => x.kind)).toEqual(["same", "removed", "same"]);
  });

  it("毫不相干的两段不会被凑成一对(否则满屏都是改写)", () => {
    const d = diffParagraphs("今天天气很好", "量子力学导论");
    // 相似度低于阈值 → 应当是 删+增, 而不是"改写"
    expect(d.map((x: ParaDiff) => x.kind).sort()).toEqual(["added", "removed"]);
  });

  it("整段重写(保留少量共同词)判为 changed 而不是删+增", () => {
    const d = diffParagraphs(
      "本文认为资本下乡对村级治理存在异质性影响",
      "本文认为资本下乡对村级治理的影响具有显著异质性");
    expect(d.map((x: ParaDiff) => x.kind)).toEqual(["changed"]);
  });

  it("内容完全相同 → 全 same", () => {
    const d = diffParagraphs("甲\n\n乙\n\n丙", "甲\n\n乙\n\n丙");
    expect(d.every((x: ParaDiff) => x.kind === "same")).toBe(true);
  });

  it("旧为空 → 全是 added; 新为空 → 全是 removed", () => {
    expect(diffParagraphs("", "甲\n\n乙").every((x: ParaDiff) => x.kind === "added")).toBe(true);
    expect(diffParagraphs("甲\n\n乙", "").every((x: ParaDiff) => x.kind === "removed")).toBe(true);
  });

  it("首段就不同时, 后缀对齐仍然成立(不会把尾巴也当成改动)", () => {
    const d = diffParagraphs("变了的开头\n\n共同一\n\n共同二", "新的开头\n\n共同一\n\n共同二");
    expect(diffStats(d)).toMatchObject({ same: 2, changed: 1 });
  });

  it("大量段落时不丢内容: 所有旧/新段落都能在结果里找到", () => {
    const A = Array.from({ length: 60 }, (_, i) => `旧段${i}`).join("\n\n");
    const B = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? `新段${i}` : `旧段${i}`)).join("\n\n");
    const d = diffParagraphs(A, B);
    const seenOld = new Set(d.flatMap((x: ParaDiff) => ("oldIdx" in x ? [x.oldIdx] : [])));
    const seenNew = new Set(d.flatMap((x: ParaDiff) => ("newIdx" in x ? [x.newIdx] : [])));
    expect(seenOld.size).toBe(60);
    expect(seenNew.size).toBe(60);
  });
});

describe("diffStats", () => {
  it("统计口径与结果一致", () => {
    const d = diffParagraphs("甲\n\n乙\n\n丙", "甲\n\n改过的乙\n\n丁");
    const st = diffStats(d);
    expect(st.same + st.changed + st.removed + st.added).toBe(d.length);
  });
});
