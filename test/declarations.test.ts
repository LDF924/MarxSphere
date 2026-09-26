/**
 * declarations.test.ts — 锁住「投稿声明」前后端两份定义的一致性。
 *
 * 后端只镜像 `key + label`（导出时按它拼块），前端还有 hint/template/required/placeholder。
 * 不一致的后果是**静默的**：界面填的键在后端不认 → 那段声明在导出文件里凭空消失，不报错。
 * 前端在 soc 子应用里（tsconfig 不同）不能直接 import，所以用文本解析 —— 与 stages 同一套做法，
 * 解析不到会直接 fail 而不是静默跳过。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DECLARATION_META, declarationsToMarkdown, hasAnyDeclaration } from "../src/services/declarations.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.join(here, "..", "web", "socialsci-vue", "src", "shared", "declarations.ts");

/** 从前端那份里抠出 `key: "x"` + `label: "y"` */
function parseFront(): Array<{ key: string; label: string }> {
  const src = fs.readFileSync(FRONT, "utf8");
  const body = src.slice(src.indexOf("export const DECLARATIONS"), src.indexOf("]);", src.indexOf("export const DECLARATIONS")));
  const out: Array<{ key: string; label: string }> = [];
  for (const m of body.matchAll(/key:\s*"([^"]+)"[\s\S]*?label:\s*"([^"]+)"/g)) out.push({ key: m[1], label: m[2] });
  return out;
}

describe("投稿声明 · 前后端一致", () => {
  it("前端那份能被解析（解析不到就是测试失效，直接失败）", () => {
    const front = parseFront();
    expect(front.length).toBe(DECLARATION_META.length);
  });

  it("key 与 label 逐条一致、顺序一致", () => {
    expect(parseFront().map((x) => ({ key: x.key, label: x.label })))
      .toEqual(DECLARATION_META.map((x) => ({ key: x.key, label: x.label })));
  });

  it("五项齐全（少一项就是漏做，不是「环境差异」）", () => {
    const keys = DECLARATION_META.map((x) => x.key).sort();
    expect(keys).toEqual(["acknowledgement", "authorship", "conflict", "dataAvailability", "funding"]);
  });
});

describe("投稿声明 · 拼块", () => {
  it("只输出有内容的项 —— 空标题会让编辑以为「声明了但没写」", () => {
    const md = declarationsToMarkdown({ authorship: "张三：研究设计", funding: "   ", conflict: "无。" });
    expect(md).toContain("作者贡献声明");
    expect(md).toContain("利益冲突声明");
    expect(md).not.toContain("基金资助");   // 全空白 → 不出现
    expect(md).not.toContain("致谢");
  });

  it("按声明顺序输出，不是对象的键序", () => {
    const md = declarationsToMarkdown({ dataAvailability: "见仓库", authorship: "张三：设计", funding: "无资助" });
    const iAuth = md.indexOf("作者贡献声明");
    const iFund = md.indexOf("基金资助");
    const iData = md.indexOf("数据可得性声明");
    expect(iAuth).toBeGreaterThanOrEqual(0);
    expect(iFund).toBeGreaterThan(iAuth);
    expect(iData).toBeGreaterThan(iFund);
  });

  it("空对象 → 空串，且 hasAnyDeclaration 为假（导出时不该多一个空节）", () => {
    expect(declarationsToMarkdown({})).toBe("");
    expect(hasAnyDeclaration({})).toBe(false);
    expect(hasAnyDeclaration(null)).toBe(false);
    expect(hasAnyDeclaration({ conflict: "无。" })).toBe(true);
  });

  it("非对象输入不炸（节点 payload 可能被写成字符串）", () => {
    expect(declarationsToMarkdown("垃圾")).toBe("");
    expect(declarationsToMarkdown(42)).toBe("");
    expect(hasAnyDeclaration(undefined)).toBe(false);
  });
});
