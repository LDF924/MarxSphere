// research-literature-retrieval.test.ts — 写作舱文献检索的纯函数契约(2026-09-16 外部臂接入时补)
//
// 为什么只测这两个函数: 检索主体要走 PG/Neo4j/网络, 属集成测试范畴;
//   而这两个函数是**著录正确性的最后一道闸** —— 它们错了, 参考文献就是错的,
//   而错误的参考文献比空参考文献更糟(空的很明显, 错的会被当成真的读进去)。
import { describe, expect, it } from "vitest";
import { normalizeCnAuthor, formatReferenceLine, splitTitleAuthor } from "../src/services/research-literature-retrieval.js";

describe("normalizeCnAuthor — OpenAlex 中文姓名还原", () => {
  // 实测问题: OpenAlex 按西文习惯把 "程琴" 存成 "琴 程"、"陈兵" 存成 "兵 陈"
  it("被拆反的姓名还原(第二段才是姓)", () => {
    expect(normalizeCnAuthor("琴 程")).toBe("程琴");
    expect(normalizeCnAuthor("兵 陈")).toBe("陈兵");
  });

  it("顺序本就正确的原样去空格(第一段是姓)", () => {
    expect(normalizeCnAuthor("陈 兵")).toBe("陈兵");
    expect(normalizeCnAuthor("周 胜浩")).toBe("周胜浩");
  });

  it("无空格的中文名不动", () => {
    expect(normalizeCnAuthor("陈齐")).toBe("陈齐");
  });

  // 关键边界: 西文名有空格但**不能**当拆反处理, 否则 "Xiaoming Wang" 会变成 "WangXiaoming"
  it("西文名原样保留", () => {
    expect(normalizeCnAuthor("Xiaoming Wang")).toBe("Xiaoming Wang");
    expect(normalizeCnAuthor("A B")).toBe("A B");
  });

  it("空值安全", () => {
    expect(normalizeCnAuthor("")).toBe("");
    expect(normalizeCnAuthor(null as unknown as string)).toBe("");
  });
});

describe("formatReferenceLine — GB/T 7714 著录", () => {
  it("有刊名时按期刊论文格式(带 [J] 与卷期页)", () => {
    const line = formatReferenceLine(1, {
      title: "数智化赋能职业教育产教融合", authors: "程琴", year: "2025",
      excerpt: "", source: "openalex",
      venue: "教育研究与实践", volumeIssue: "1(9): 21-21", doi: "10.61369/etr.11284",
    });
    expect(line).toBe("[1] 程琴. 数智化赋能职业教育产教融合[J]. 教育研究与实践, 2025, 1(9): 21-21. DOI:10.61369/etr.11284.");
  });

  // 内部臂(pg/mdlibrary)没有刊名 —— 此时**不能**加 [J](加了就是编造载体类型)
  it("无刊名时不加 [J], 退化为题录", () => {
    const line = formatReferenceLine(3, {
      title: "资本下乡的路径创新", authors: "李玉霞", year: "2021",
      excerpt: "", source: "pg",
    });
    expect(line).toBe("[3] 李玉霞. 资本下乡的路径创新. 2021.");
    expect(line).not.toContain("[J]");
  });

  it("缺字段就省略, 不留空位", () => {
    const line = formatReferenceLine(2, { title: "无作者条目", authors: "", year: "", excerpt: "", source: "pg" });
    expect(line).toBe("[2] 无作者条目.");
  });
});

describe("splitTitleAuthor — 库内文件名拆作者(回归)", () => {
  it("拆出下划线后的作者", () => {
    expect(splitTitleAuthor("合伙人制度：资本下乡的路径创新_李玉霞"))
      .toEqual({ title: "合伙人制度：资本下乡的路径创新", authors: "李玉霞" });
  });
  it("年份不当作作者", () => {
    expect(splitTitleAuthor("资本下乡_2023").authors).toBe("");
  });
});
