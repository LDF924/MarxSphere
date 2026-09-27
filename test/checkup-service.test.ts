/**
 * checkup-service 的纯函数回归 —— 拆条与导出。
 *
 * 为什么这两组值得单测：它们是这一批里**唯一有判断**的地方，其余都是搬运。
 *
 * · **拆条**：漏掉一行 = 该交的一项没交，而漏掉的那一行不会报错、界面上也看不出来
 *   （条目数从 12 变 11，没人会数）。这里锁住的第一个用例 `1. 项目名称` 就是实测踩到的：
 *   我第一版按"短且无句读 ⇒ 小节标题"判，于是**整份检查表 11 条全被判成小节**，
 *   塌成一条吃掉全文 —— 而它在界面上看起来像"这份表只有一项"，不像坏了。
 *
 * · **导出**：`auto` 项后面的 `【来源：…】` 是这个功能赖以成立的东西（用户被问到
 *   "这个数字哪来的"要答得上）。三分类在导出里必须**三种形态都能区分** ——
 *   尤其是 `platform_missing` 要单独成段，否则用户会对着空行反复找"是不是我哪步没做"。
 *
 * 分类本身（auto/manual/platform_missing）要读项目真数据，属集成面，由 `probe-batch10.mjs`
 * 端到端验；这里只测它的**导出与拆条**这两个纯函数。
 */
import { describe, it, expect } from "vitest";
import {
  parseChecklistItems, exportCheckupMarkdown, exportCheckupDocxNodes,
  type CheckupDoc, type CheckupItem,
} from "../src/services/checkup-service.js";

describe("parseChecklistItems — 拆条", () => {
  it("阿拉伯数字编号是**条目**，中文数字编号是**小节**", () => {
    const r = parseChecklistItems("一、项目基本情况\n1. 项目名称\n2. 起止时间\n二、进展\n3. 研究进度");
    expect(r.map((x) => x.label)).toEqual(["项目名称", "起止时间", "研究进度"]);
    expect(r.map((x) => x.section)).toEqual(["项目基本情况", "项目基本情况", "进展"]);
  });

  it("回归: 短条目(4 字、无句读)不能被当成小节 —— 否则整份表塌成一条", () => {
    // 这正是实测踩到的那个形状：第一版判成"只有一个小节、零条目"，
    // 然后掉进"整段当一条"的兜底，得到 1 条吃掉全文的记录。
    const r = parseChecklistItems("1. 项目名称\n2. 研究进度\n3. 经费使用情况");
    expect(r).toHaveLength(3);
    expect(r[0].label).toBe("项目名称");
  });

  it("通篇只有中文编号时，那些编号行当条目而不是全部吃掉", () => {
    const r = parseChecklistItems("一、项目名称\n二、研究进度\n三、经费使用情况");
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.label)).toEqual(["项目名称", "研究进度", "经费使用情况"]);
  });

  it("Tab 分隔的表: 取中文最多那格, 序号格与表头词不当检查项", () => {
    const r = parseChecklistItems("序号\t检查内容\t填写\n1\t项目名称\t\n2\t经费使用情况\t\n");
    expect(r.map((x) => x.label)).toEqual(["项目名称", "经费使用情况"]);
  });

  it("Markdown 表: 跳过分隔行与表头行", () => {
    const r = parseChecklistItems("| 检查项 | 填写情况 |\n|---|---|\n| 已完成章节目录 | 是 |\n| 已交材料 | 否 |");
    expect(r.map((x) => x.label)).toEqual(["已完成章节目录", "已交材料"]);
  });

  it("小数开头的续行不被当成新条目", () => {
    const r = parseChecklistItems("1. 回归系数是显著的\n3.5 的系数值见上表");
    expect(r).toHaveLength(1);
    expect(r[0].label).toContain("3.5");
  });

  it("完全拆不出编号时整段当一条(不硬切)", () => {
    const r = parseChecklistItems("本项目按计划推进，已完成阶段性目标，特此说明。");
    expect(r).toHaveLength(1);
    expect(r[0].label).toContain("按计划推进");
  });

  it("空输入返回空数组", () => {
    expect(parseChecklistItems("   \n  ")).toEqual([]);
  });
});

const ITEMS: CheckupItem[] = [
  { seq: 1, section: "基本情况", label: "项目名称", kind: "auto", value: "某课题", autoSource: "项目元数据" },
  { seq: 2, section: "基本情况", label: "研究进展", kind: "manual", value: "", autoSource: "" },
  { seq: 3, section: "经费", label: "经费使用情况", kind: "platform_missing", value: "", autoSource: "" },
];
const DOC: CheckupDoc = {
  kind: "midterm", sourceName: "某校中期检查表", items: ITEMS,
  counts: { auto: 1, manual: 1, platformMissing: 1 }, updatedAt: "", rawText: "",
};

describe("exportCheckupMarkdown", () => {
  const md = exportCheckupMarkdown(DOC, "某课题");

  it("auto 项带【来源：…】—— 用户被问『这个数字哪来的』要答得上", () => {
    expect(md).toContain("【来源：项目元数据】");
  });

  it("留空的项写「（待填）」而不是留个空", () => {
    expect(md).toContain("研究进展**：（待填）");
  });

  it("platform_missing 单独成段说清『平台不记录』", () => {
    expect(md).toContain("平台不记录");
    expect(md).toContain("请线下补");
  });

  it("标题带项目名与检查类型", () => {
    expect(md.split("\n")[0]).toBe("# 某课题 · 中期检查");
  });
});

describe("exportCheckupDocxNodes — 与 md 同源", () => {
  const nodes = exportCheckupDocxNodes(DOC, "某课题");

  it("结构与 md 一致: 也带来源标注", () => {
    expect(JSON.stringify(nodes)).toContain("【来源：项目元数据】");
  });

  it("平台不记录的项也单独成节", () => {
    expect(nodes.some((n) => String(n.title).includes("平台不记录"))).toBe(true);
  });

  it("条目按小节分组, 不逐条变成标题", () => {
    // 逐条做标题会让 Word 里满屏大字号; 这一条锁住"按 section 分节、节内拼行"
    const sec = nodes.find((n) => n.title === "基本情况");
    expect(sec).toBeTruthy();
    expect(String(sec!.content)).toContain("项目名称");
    expect(String(sec!.content)).toContain("研究进展");
  });
});
