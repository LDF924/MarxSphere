/**
 * docs-index.test.ts — 文档中心的索引必须覆盖 docs/ 下的每一个 md。
 *
 * 由来(2026-09-29 用户:「系统管理里的文档中心需要全量更新」): 此前 `/api/docs` 的索引是
 *   **手写死的 25 条**, 而 `docs/` 里实际有 **60 个 md** —— 缺的 35 个正好是近期那批能力文档
 *   (实证台 / 文献管理 / 写作证据链 / 学习引擎 / 记忆 / 多Agent / 模型 / IM / Computer Use …)。
 *   手写清单只随"某次有人记得改"而更新, 必然腐烂, 而且**没有任何东西会发现**。
 *
 * 改成扫描 docs/ 自动生成之后, 这个文件盯三件事:
 *   ① **全覆盖**: 每个 .md 都要在索引里 —— 漏一个, 那个文档在文档中心就是「不存在」;
 *   ② **不死链**: 每条索引都要读得到 —— 路径写错时界面只会显示「文档未找到」;
 *   ③ **不落「其他」**: 分组是显式表, 新文档没归类时会掉进「其他」——
 *      那等于没归类, 但界面上完全看不出来。这条会把它报出来。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const server = fs.readFileSync(path.join(ROOT, "src/api/server.ts"), "utf8");

/** docs/ 下真实的 md(与 buildDocIndex 同一套排除规则: 跳过点目录与 assets) */
function actualDocs(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "assets") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.name.toLowerCase().endsWith(".md")) out.push(rel);
    }
  };
  walk(DOCS, "");
  return out.sort();
}

/**
 * 从源码里抠出显式的分组表与标题覆盖表(它们是纯字面量, 抠得动)。
 *
 * ⚠ 第一版写成 `/^\s*"([^"]+)":/gm`(只认行首的 key), 于是**一行里第二条之后全漏** ——
 *   表里为了紧凑写成了 `"a": "x", "b": "y"` 这种一行多条, 结果报出 28 个"没归组"
 *   的假阳性, 看着像我发现了一堆漏网, 其实是我没解析全。**判据自己坏了。**
 *   改成全局匹配 `key: "value"` 键值对, 且要求值也是带引号的字符串
 *   (避免把 `DOC_GROUP_OF[rel] ?? "其他"` 这种索引访问也算进来)。
 */
function mapKeys(declName: string): string[] {
  const i = server.indexOf(`const ${declName}`);
  expect(i, `源码里找不到 ${declName}`).toBeGreaterThan(-1);
  const body = server.slice(i, server.indexOf("};", i));
  return [...body.matchAll(/"([^"]+)":\s*"/g)].map((m) => m[1]);
}

describe("文档中心索引: 必须覆盖 docs/ 全量", () => {
  const files = actualDocs();

  it("docs/ 下有文档可扫(防判据失效)", () => {
    expect(files.length, "扫不到任何 md —— 判据自己坏了").toBeGreaterThan(30);
  });

  it("**每一个 md 都归了组**(没归的会掉进「其他」——那等于没归类)", () => {
    const grouped = new Set(mapKeys("DOC_GROUP_OF"));
    const orphan = files.filter((f) => !grouped.has(f));
    expect(
      orphan,
      "这些文档没在 DOC_GROUP_OF 里 —— 会以「其他」分组出现, 界面上看不出异常。\n" +
        "加一行分组即可: " + orphan.slice(0, 3).map((f) => `"${f}": "能力手册"`).join(", "),
    ).toEqual([]);
  });

  it("分组表里没有指向已删文件的僵尸条目", () => {
    const present = new Set(files);
    const zombie = mapKeys("DOC_GROUP_OF").filter((f) => !present.has(f));
    expect(zombie, `这些文件已不存在, 但分组表里还留着: ${zombie.join(", ")}`).toEqual([]);
  });

  it("标题覆盖表也同理(不能指向已删文件)", () => {
    const present = new Set(files);
    const zombie = mapKeys("DOC_TITLE_OVERRIDE").filter((f) => !present.has(f));
    expect(zombie, `标题覆盖表里的僵尸: ${zombie.join(", ")}`).toEqual([]);
  });

  it("**每个文档都有可用的标题**(H1 或覆盖表)", () => {
    const override = new Set(mapKeys("DOC_TITLE_OVERRIDE"));
    const noTitle = files.filter((f) => {
      if (override.has(f)) return false;
      const txt = fs.readFileSync(path.join(DOCS, f), "utf8");
      return !txt.split("\n").some((l) => l.startsWith("# ") && l.slice(2).trim());
    });
    expect(
      noTitle,
      "这些文档既没有 H1、也没在 DOC_TITLE_OVERRIDE 里 —— 文档中心会拿文件名当标题显示",
    ).toEqual([]);
  });

  it("索引是按 docs/ 扫出来的, 不是又抄了一份手写清单", () => {
    // 判据: 源码里应当有扫描函数, 且 DOC_INDEX 由它产出
    expect(server, "没找到 buildDocIndex —— 索引可能又变回手写清单了").toContain("function buildDocIndex");
    expect(server, "DOC_INDEX 不是由 buildDocIndex() 产出的").toMatch(/const DOC_INDEX = buildDocIndex\(\)/);
  });
});
