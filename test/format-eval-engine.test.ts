// format-eval-engine.test.ts — 论文格式评测规则引擎单测(2026-09-03)
// 覆盖: 标题层级/摘要/关键词/章节结构/引文标注/参考文献/图表编号/文本规范
import { describe, expect, it } from "vitest";
import { runRuleEngine, chineseLength, splitLines, extractHeadings } from "../src/services/format-eval-engine.js";
import { BUILTIN_TEMPLATES, resolveTemplate } from "../src/services/format-eval-templates.js";

const undergrad = resolveTemplate("undergrad-thesis");

/** 生成规范论文样例(本科模板): 摘要 200+ 字、3 关键词、第1章→1.1、参考文献 2 条 */
function goodThesis(): string {
  return [
    "摘要: 本文研究资本下乡对农村集体经济发展的影响。通过构建理论分析框架，结合实地调研数据，考察资本下乡的作用机制与政策效果，提出促进农村集体经济高质量发展的对策建议，为乡村振兴战略实施提供参考。本文的主要发现是资本下乡具有双重效应，既能够激活农村资源要素，也可能加剧利益分配矛盾，需要完善制度设计加以规范引导。研究表明，资本下乡的效果取决于制度环境与利益联结机制的设计，未来应进一步健全农村集体资产监管制度，完善风险防范机制，推动资本下乡与农民增收、集体经济发展的有机统一。",
    "关键词: 资本下乡；集体经济；乡村振兴",
    "",
    "Abstract: This paper studies the impact of capital going to the countryside on rural collective economy.",
    "Keywords: capital; collective economy; rural revitalization",
    "",
    "目录",
    "第1章 引言 1",
    "1.1 研究背景 1",
    "第2章 理论基础 10",
    "",
    "第1章 引言",
    "资本下乡是当前乡村振兴战略实施中的重要现象。已有研究从多个角度对此进行了讨论[1]。本文在此基础上展开进一步分析。",
    "1.1 研究背景",
    "近年来工商资本大规模进入农业农村领域。",
    "第2章 理论基础",
    "马克思主义政治经济学为分析资本下乡提供了理论工具。",
    "2.1 相关概念界定",
    "资本下乡指城市工商资本进入农村从事生产经营活动的过程。",
    "第3章 实证分析",
    "基于调研数据展开分析。",
    "第4章 结论",
    "本文得出若干结论并提出建议。",
    "",
    "参考文献",
    "[1] 张三. 资本下乡与农村发展研究[J]. 农业经济问题, 2022, 43(5): 10-20.",
    "[2] 李四. 乡村振兴战略研究[M]. 北京: 人民出版社, 2021: 1-100.",
  ].join("\n");
}

function findIssues(text: string, tpl = undergrad, ruleIds?: string[]) {
  const issues = runRuleEngine(text, tpl);
  return ruleIds ? issues.filter((i) => ruleIds.includes(i.ruleId)) : issues;
}

describe("format-eval 规则引擎", () => {
  it("规范论文 → 无 error(仅 info/warning 级提示或零问题)", () => {
    const issues = runRuleEngine(goodThesis(), undergrad);
    const errors = issues.filter((i) => i.severity === "error");
    // 允许: citation-none(info) 引文少、heading 提示等非 error 项
    expect(errors).toEqual([]);
  });

  it("中文计数与段落切分", () => {
    expect(chineseLength("本文研究资本下乡")).toBe(8);
    expect(splitLines("a\n\nb\n\n\nc")).toHaveLength(3);
  });

  it("缺摘要 → abstract-missing(error)", () => {
    const t = goodThesis().replace(/摘要[^\n]+\n/, "").replace(/关键词[^\n]+\n/, "");
    const issues = findIssues(t, undergrad, ["abstract-missing", "keywords-missing"]);
    expect(issues.some((i) => i.ruleId === "abstract-missing")).toBe(true);
  });

  it("摘要过短 → abstract-too-short", () => {
    const t = goodThesis().replace(
      /摘要: 本文研究资本下乡对农村集体经济发展的影响。[\s\S]*?为乡村振兴战略实施提供参考。本文的主要发现是资本下乡具有双重效应，既能够激活农村资源要素，也可能加剧利益分配矛盾，需要完善制度设计加以规范引导。/,
      "摘要: 本文研究了资本下乡的影响。",
    );
    const issues = findIssues(t, undergrad, ["abstract-too-short"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
  });

  it("关键词仅 2 个 → keywords-count; 分隔符混用 → keywords-separator", () => {
    const t = goodThesis().replace("关键词: 资本下乡；集体经济；乡村振兴", "关键词: 资本下乡; 集体经济,");
    const issues = findIssues(t, undergrad, ["keywords-count", "keywords-separator"]);
    expect(issues.some((i) => i.ruleId === "keywords-count")).toBe(true);
    expect(issues.some((i) => i.ruleId === "keywords-separator")).toBe(true);
  });

  it("缺参考文献块 → references-missing", () => {
    const t = goodThesis().replace(/\n参考文献[\s\S]*$/, "");
    const issues = findIssues(t, undergrad, ["references-missing", "section-missing"]);
    expect(issues.some((i) => i.ruleId === "references-missing")).toBe(true);
  });

  it("参考文献序号跳号 [1][3] → reference-numbering-gap", () => {
    const t = goodThesis().replace("[2] 李四", "[3] 李四");
    const issues = findIssues(t, undergrad, ["reference-numbering-gap"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("[3]");
  });

  it("正文引用越界 [9] → reference-out-of-range", () => {
    const t = goodThesis().replace("已有研究从多个角度对此进行了讨论[1]", "已有研究从多个角度对此进行了讨论[9]");
    const issues = findIssues(t, undergrad, ["reference-out-of-range"]);
    expect(issues).toHaveLength(1);
  });

  it("标题跳级(第1章→1.1.1 无 1.1)在缺中间层时 → heading-jump", () => {
    // 手工构造: 第1章(level0)后直接跟 1.1.1(level2), 中间无 1.1
    const t = [
      "摘要: " + "研".repeat(200),
      "关键词: 甲；乙；丙",
      "第1章 引言",
      "1.1.1 研究背景细分",
      "正文内容若干。",
    ].join("\n");
    const issues = findIssues(t, undergrad, ["heading-jump"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("跳变");
  });

  it("cn-seq 模板吃「第X章」标题 → heading-pattern-mismatch", () => {
    const tpl = resolveTemplate("title-paper");
    const issues = findIssues(goodThesis(), tpl, ["heading-pattern-mismatch"]);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("图 1 → 图 3 跳号 → figure-numbering-gap", () => {
    const t = goodThesis() + "\n图 1 调研区域分布\n\n图 3 政策效果对比\n";
    const issues = findIssues(t, undergrad, ["figure-numbering-gap"]);
    expect(issues).toHaveLength(1);
  });

  it("空文本 → text-empty; 纯乱码 → text-garbage", () => {
    const empty = findIssues("", undergrad, ["text-empty"]);
    expect(empty).toHaveLength(1);
    const garbage = findIssues("第1章 引言\n\n摘要: 测试内容。\n\n����� 乱码段", undergrad, ["text-garbage"]);
    expect(garbage).toHaveLength(1);
  });

  it("缺少结论章节 → section-missing 含「结论」", () => {
    const t = goodThesis().replace(/第4章 结论[\s\S]*?本文得出若干结论并提出建议。/, "");
    const issues = findIssues(t, undergrad, ["section-missing"]);
    expect(issues.some((i) => i.message.includes("结论"))).toBe(true);
  });

  it("内置模板 6 个, 关键字段齐全", () => {
    expect(BUILTIN_TEMPLATES).toHaveLength(6);
    const ids = BUILTIN_TEMPLATES.map((t) => t.id);
    expect(ids).toContain("undergrad-thesis");
    expect(ids).toContain("master-thesis");
    expect(ids).toContain("journal-gb7714");
    const under = BUILTIN_TEMPLATES.find((t) => t.id === "undergrad-thesis")!;
    expect(under.abstract.min).toBeGreaterThan(0);
    expect(under.requiredSections).toContain("参考文献");
  });

  it("自定义内联模板合并内置模板默认值", () => {
    const custom = resolveTemplate("undergrad-thesis", { id: "undergrad-thesis", name: "我校本科模板", abstract: { required: true, min: 300, max: 500 } });
    expect(custom.builtin).toBe(false);
    expect(custom.name).toBe("我校本科模板");
    expect(custom.abstract.min).toBe(300);
    // 未覆盖字段继承内置模板
    expect(custom.headingPattern).toBe("chapter-x.x");
    expect(custom.keywords.min).toBe(3);
  });

  it("extractHeadings 识别两种编号体系", () => {
    const paras = splitLines([
      "一、引言",
      "（一）研究背景",
      "1. 国内研究现状",
      "正文段落内容",
    ].join("\n\n"));
    const cn = extractHeadings(paras, "cn-seq");
    expect(cn.map((h) => h.level)).toEqual([0, 1, 2]);
    expect(cn[0].text).toBe("引言");

    const paras2 = splitLines([
      "第1章 引言",
      "1.1 研究背景",
      "1.1.1 背景细分",
      "正文段落内容",
    ].join("\n\n"));
    const ch = extractHeadings(paras2, "chapter-x.x");
    expect(ch.map((h) => h.level)).toEqual([0, 1, 2]);
  });
});
