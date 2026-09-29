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
import fs, { readFileSync, existsSync } from "node:fs";
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

/**
 * doc-sync 的替换规则**不能吃掉文档结构**。
 *
 * 由来(2026-09-29, 我自己造的): 通用规则里写了 `(\d+) 工具矩阵`,
 *   而 `FEATURES-DETAILED.md` 有一行 `### 4.2 工具矩阵（156 工具 = …）` ——
 *   规则把**小节号里的 2** 当成工具数, 改成了 `### 4.158 工具矩阵`。
 *   改完 docs:check 报绿(数字确实一致了), 而**章节编号被改坏**没人发现。
 *
 * 判据: 标题里的编号必须还是「数字.数字」的形状。
 * 这类误伤的共同形态是"规则以为自己在改数字, 其实在改结构", 所以盯标题最有效。
 */
describe("doc-sync 不许改坏标题结构", () => {
  const docs = ['README.md', 'README-CN.md', 'docs/ARCHITECTURE.md', 'docs/FEATURES-DETAILED.md',
                'docs/PROJECT-OVERVIEW.md', 'docs/OPEN-SOURCE-DISCLOSURE.md', 'docs/AGENT-CAPABILITIES.md'];

  it("markdown 标题的小节号仍是 `N.M` 形状(没有被数字规则吞掉)", () => {
    const bad: string[] = [];
    for (const d of docs) {
      if (!existsSync(path.join(ROOT, d))) continue;
      for (const line of readFileSync(path.join(ROOT, d), "utf8").split("\n")) {
        const m = /^#{2,4}\s+(\d+)\.(\d+)\s/.exec(line);
        if (!m) continue;
        // 小节号: 两段都该是短数字。出现 4158 / 258 这种说明规则把两段粘一起了
        if (m[1].length > 2 || m[2].length > 2) bad.push(`${d}: ${line.trim().slice(0, 60)}`);
      }
    }
    expect(bad, "这些标题的小节号被数字规则改坏了 —— docs:check 会报绿, 因为数字本身'一致'了").toEqual([]);
  });

  /**
   * ⚠ 上面的长度判据**不够** —— 它只在结果变成 3 位数时报警。
   *
   * 实测(fixture 回填): `### 4.2 工具矩阵（156 …）` 被规则改成 `### 4.158 工具矩阵` 时，
   *   长度判据其实**能**抓到（158 是三位）。所以这条不是为那个实例加的，而是补它的盲区:
   *   同一台机器若把第二节号焊成 **两位**数（`4.58` / `4.78`），长度判据就放绿了，
   *   而错法完全一样 —— 节号与规模数被焊死在一处。
   *
   * 判据: 标题里的节号**不该**等于任何一个会漂的规模数（工具 158 / 场景 78 / 视图 49 …）。
   *   人写小节号不会取这些值。(万一某天真有小节号等于规模数，这条会误报 —— 那时改标题即可。)
   */
  it("markdown 标题的小节号没有被规模数焊接（4.2 不该变成 4.158 / 4.78）", () => {
    const SCALE_NUMS = new Set(["158", "78", "49", "191", "209", "102", "56", "122", "39", "165", "300"]);
    const bad: string[] = [];
    for (const d of docs) {
      if (!existsSync(path.join(ROOT, d))) continue;
      for (const line of readFileSync(path.join(ROOT, d), "utf8").split("\n")) {
        const m = /^#{2,4}\s+(\d+)\.(\d+)\s/.exec(line);
        if (!m) continue;
        if (m[2].length > 1 && SCALE_NUMS.has(m[2])) bad.push(`${d}: ${line.trim().slice(0, 60)}`);
      }
    }
    expect(bad, "这些标题的第二节号是一个会漂的规模数 —— doc-sync 把它从句内数字吃进了小节号").toEqual([]);
  });
});
