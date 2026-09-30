/**
 * screenshots.test.ts — 界面截图必须**与导航对得上**。
 *
 * 由来(2026-09-30 用户:「界面速览、视图的界面截图、运行截图这些文档与可验证材料需要全量更新」):
 *   查下来 `docs/assets/sag-*.png` 是 **2026-08-27** 那一批, 之后就没动过。它的毛病不是"旧",
 *   是三件各自独立、且**没有任何东西会发现**的事:
 *
 *   ① **图跟名字对不上**。旧脚本先 `loadURL` 再设 hash, 而改 hash**不触发已完成的加载** ——
 *      于是 37 张里有 **11 张是逐字节相同**的 AI 对话空态(md5 都一样), 文件名却分别叫
 *      「政经C刊科研」「写作语料库」「文档中心」「外部检索」…… 另有 7 张压根没截到目标视图。
 *      **文件名、大小、乃至"看着像"都判不出来** —— 只有两两比内容才认得出。
 *   ② **被登录弹窗盖住**。多数工作台在 AuthGate 后面, 未登录时截出来是一张居中的登录卡片。
 *      全批 47 张里 **27 张**是这样, 同样没有任何信号。
 *   ③ **品牌与规模全停在改名之前**。36 张的导航栏读作旧名, 副标题写「马理论 AI 科研中枢」;
 *      而现在有 47 个 tab, 当年只有 34 个 —— 一半的 tab 从来没有图。
 *
 * 这个文件盯三件事(都能在**不起浏览器**的前提下判):
 *   ① 导航里每个 tab 都有对应截图(按 capture-screenshots.mjs 的 hash→文件名映射核);
 *   ② 文档里引用的每一张 `docs/assets/*.png` 都真的存在(防断链);
 *   ③ 在库的截图必须被 git 跟踪(防又被 `.gitignore` 的 `*.png` 静默吞掉)。
 *
 * ⚠ 它**不验图的内容**(那要起浏览器 + 真跑一屏)。内容由 `capture-screenshots.mjs`
 *   自带的三道自检保证: 标题核对、全批哈希比对、登录弹窗检测。
 *   这里只在"图与代码/文档的对应关系"这一层兜住 —— 而这恰好是腐烂得最快的一层。
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "docs/assets");
const app = readFileSync(path.join(ROOT, "web/src/App.tsx"), "utf8");
const capture = readFileSync(path.join(ROOT, "scripts/capture-screenshots.mjs"), "utf8");

/** 导航里的全部 tab —— 与 App.tsx 的 `categories` 同一个真源 */
function navTabs(): string[] {
  const seg = app.slice(app.indexOf("const categories: NavCategory[] = ["));
  const body = seg.slice(0, seg.indexOf("\n  ];"));
  return [...body.matchAll(/\{ value: "([^"]+)", label:/g)].map((m) => m[1]);
}

/** capture-screenshots.mjs 里登记的 hash → 文件名 */
function captured(): Map<string, string> {
  const out = new Map<string, string>();
  // 形如: { file: "sag-x.png", hash: "#x", expect: "…" }
  for (const m of capture.matchAll(/\{\s*file:\s*"([^"]+)"[^}]*?hash:\s*"(#[^"]+)"/gs))
    out.set(m[2].slice(1), m[1]);
  return out;
}

const TABS = navTabs();
const CAP = captured();

describe("界面截图: 每个导航 tab 都要有, 且不能是断链", () => {
  it("App.tsx 的导航 tab 数看着正常(防判据失效)", () => {
    expect(TABS.length, "数不到导航 tab —— 判据自己坏了").toBeGreaterThan(30);
  });

  it("截图脚本登记了足够多的视图(防判据失效)", () => {
    expect(CAP.size, "截不到 hash → 文件名的映射 —— 判据自己坏了").toBeGreaterThan(30);
  });

  /**
   * 每个 tab 都要有截图。
   *
   * ⚠ 例外只有两个, 都是**有意不拍**的:
   *   · `home` —— 首页 landing 视图。它不在 `categories` 里(那是 6 大分类之外的独立视图),
   *     所以本来就数不到, 不需要排除。
   *   · 其余一律要拍。当年 47 个 tab 里有近一半从来没有图, 而没人发现。
   */
  it("**导航里的每个 tab 都有截图**, 且在脚本里登记了 hash", () => {
    const missing = TABS.filter((t) => !CAP.has(t));
    expect(
      missing,
      "这些 tab 没有截图 —— 在 scripts/capture-screenshots.mjs 的 VIEWS 里加一条\n" +
        "(记得填 expect: 主内容区标题里必然出现的字串, 否则那张图不会被核对):\n" +
        missing.map((t) => `  { file: "sag-${t}.png", hash: "#${t}", expect: "…" },`).join("\n"),
    ).toEqual([]);
  });

  it("脚本里登记的每张图都真的存在", () => {
    const missing = [...CAP.values()].filter((f) => !existsSync(path.join(ASSETS, f)));
    expect(missing, `这些图在脚本里登记了但磁盘上没有: ${missing.join(", ")}`).toEqual([]);
  });

  /**
   * 文档里引用的图必须存在 —— 这是"断链"那一类。
   * 全仓 md 里所有 `docs/assets/xxx.png` 的反引号/markdown 引用都算。
   *
   * ⚠ **CHANGELOG.md 必须排除掉**。它是**历史记录**: 里面 `docs/assets/marx-logo-512.png`
   *   说的是"当时纳入了哪两个文件", 那在换标之后**本来就不该存在**了 —— 改它才是篡改史实。
   *   与 `scripts/brand-rename.py` 的 SKIP_FILES 是同一个道理(那边跳过的是运行日志)。
   *   实测: 不排除的话这条判据会红在一个"正确的历史记录"上, 而真正该抓的断链被淹掉。
   */
  const HISTORY_FILES = new Set(["CHANGELOG.md"]);

  it("文档引用的 docs/assets/*.png 都真实存在", () => {
    const files: string[] = [];
    /**
     * ⚠ 必须跳过**构建产物**里的文档副本。
     *
     * `resources/sag/` 是 `build-desktop.mjs` 为桌面端打包暂存的、`release/` 是
     * electron-builder 的输出 —— 它们里面各有一份整份 docs/ 的快照。不跳过的话,
     * 这条判据会去查**上一次打包时那份旧文档**里的引用, 报出根本不存在的断链。
     *
     * 实测(2026-09-30): worktree 里没有这两个目录 → 全绿; 主仓里有(打过包) → 两条假红
     * (`sag-home.png` / `marxsphere-architecture.svg`, 都只在旧副本里)。
     * **判据扫错了范围 —— 与"判据看不到被测对象"是同一类病。**
     */
    const SKIP_DIRS = new Set(["node_modules", "release", "resources", "dist", "coverage", ".cache"]);
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md") && !HISTORY_FILES.has(e.name)) files.push(p);
      }
    };
    walk(ROOT);

    const refs = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/docs\/assets\/([\w.-]+\.(?:png|svg|jpeg|jpg))/g))
        refs.add(m[1]);
    }
    expect(refs.size, "一篇文档都没引用到图 —— 判据自己坏了").toBeGreaterThan(5);

    const broken = [...refs].filter((r) => !existsSync(path.join(ASSETS, r)));
    expect(broken, `文档引用了不存在的图(界面会显示裂图): ${broken.join(", ")}`).toEqual([]);
  });

  /**
   * 在库的截图必须被 git 跟踪。
   *
   * ⚠ 与 `docs-index.test.ts` 的品牌资产判据同源, 但对象不同: 那条盯的是 logo/favicon,
   *   这条盯的是**整批界面截图** —— 它们同样会被 `.gitignore` 的全局 `*.png` 吞掉,
   *   而 `git add -A` 对已忽略文件是静默跳过, 连 `git status` 都不列。
   *   use `git ls-files` 而不是 `fs.existsSync`: 后者对"磁盘有、仓里没有"正是瞎的。
   */
  it("在库的截图都在 git 索引里(没被 *.png 吞掉)", () => {
    const tracked = new Set(
      execSync("git ls-files docs/assets", { cwd: ROOT, encoding: "utf8" }).split("\n").map((s) => s.trim()),
    );
    const onDisk = readdirSync(ASSETS).filter((f) => f.startsWith("sag-") && f.endsWith(".png"));
    const untracked = onDisk.filter((f) => !tracked.has(`docs/assets/${f}`));
    expect(
      untracked,
      "这些截图只在磁盘上、不在 git 里 —— 多半被 .gitignore 的 *.png 吞了:\n" +
        untracked.map((f) => `!docs/assets/${f}`).join("\n"),
    ).toEqual([]);
  });
});
