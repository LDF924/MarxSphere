/**
 * screenshots-pipeline.test.ts — 界面截图那条流水线不能退化。
 *
 * 由来(2026-09-30): 上一版截图脚本(`capture-screenshots.cjs`, Electron + offscreen)有两个
 *   **静默**缺陷 —— 出了 37 张图、文件名齐全、大小各异, 但里面 11 张是**逐字节相同**的
 *   对话空态, 另有 27 张被登录弹窗盖住。**没有任何东西会发现**, 因为:
 *     · 图确实生成了(退出码 0);
 *     · 文件名确实按视图命名;
 *     · 单测 / 类型检查 / docs:check 都不看图片内容。
 *   换成 Playwright 版之后加了三道自检, 但**那三道只在跑脚本时生效** —— 有人把脚本改回
 *   "先 loadURL 再设 hash"、或者去掉登录步骤, 就又回到老路, 而没人拦。
 *
 * 这个文件用**源码级判据**把这三点钉住(不用起浏览器):
 *   ① 切视图必须"改完 hash 再核对标题", 不能只改完就截;
 *   ② 必须登录(否则截图被 AuthGate 弹层盖住);
 *   ③ 必须有"全批图两两不同"的比对(这是唯一能抓住"N 张图其实是一张"的判据);
 *   ④ 旧的 Electron 版脚本不能再回来(两份脚本并存时, 没人知道该跑哪个)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/capture-screenshots.mjs");
const src = existsSync(SCRIPT) ? readFileSync(SCRIPT, "utf8") : "";

describe("截图流水线: 三道自检不能在改脚本时被删掉", () => {
  it("脚本还在, 且是 Playwright 那版(不是旧的 Electron 版)", () => {
    expect(existsSync(SCRIPT), "scripts/capture-screenshots.mjs 不见了").toBe(true);
    expect(src, "没在用 playwright —— 可能被换回 Electron offscreen 版了").toContain('from "playwright"');
  });

  it("旧脚本不能回来(两份并存时没人知道该跑哪个)", () => {
    expect(
      existsSync(path.join(ROOT, "scripts/capture-screenshots.cjs")),
      "capture-screenshots.cjs 又出现了 —— 它是被 .mjs 取代的旧版(每张图都是同一个界面)",
    ).toBe(false);
  });

  /**
   * ① 必须**登录**。
   *
   * ⚠ 没有这一步时, 47 张里 27 张会被 AuthGate 的登录弹窗盖住, 截出来是一张居中的
   *   授权卡片 —— 与它标着的视图毫无关系, 而文件名、大小、哈希比对**全都看不出来**。
   *
   * ⚠ 判据**不能只查 "sag_token" 这个词在不在**。第一版就是这么写的, 结果我把真正的写入
   *   那行替换成 `void t;` 之后**判据照样绿** —— 因为 "sag_token" 在注释和 loginToken 的
   *   文档里还各出现一次。**字符串在场 ≠ 那件事在做。** 必须锚到调用本身。
   */
  it("会先登录再截图(否则多数视图被登录弹窗盖住)", () => {
    expect(src, "没看到把 token 写进 localStorage 的调用 —— 多半没登录就截图了").toMatch(
      /localStorage\.setItem\(\s*"sag_token"\s*,/,
    );
    expect(src, "脚本里没有调登录端点").toMatch(/\/api\/auth\//);
  });

  /**
   * ② 必须**核对标题**。
   *
   * ⚠ 上一版只改 hash 不核对 —— 而"改 hash 不触发已完成的加载"正是 11 张图重复的根因。
   *   只改不查, 就会静默出一批错图。
   */
  it("改完 hash 会核对主内容区确实是目标视图(不核 = 静默出错图)", () => {
    expect(src, "没找到 matchView —— 改完 hash 没有核对").toContain("function matchView");
    expect(src, "有 expect 字段但没被拿来比对").toMatch(/matchView\(\s*probe\s*,\s*v\s*\)/);
  });

  /**
   * ③ 必须**全批两两比对**。
   *
   * ⚠ 这是唯一能抓住"37 张图其实是一张"的判据。文件名、大小、甚至人眼看缩略图都可能漏。
   *
   * ⚠ 判据必须**从比对一直查到 exit(1)**。第一版只要求 `dupGroups` 后面 400 字内出现
   *   `process.exit(1)` —— 我把 `dupGroups` 的赋值改成恒空数组(`const dupGroups = []`)
   *   之后**判据照样绿**, 因为那个 `process.exit(1)` 字面量还在下面几行没动。
   *   **查到字面量 ≠ 查通了因果。** 现在按"分组 → 过滤出重复 → 据此退出"整条链一起查。
   */
  it("会比对全批图的哈希, 撞了就报错(唯一能抓住'N 张图是一张'的判据)", () => {
    // 链要完整: 给每张图算哈希 → 按哈希分组 → 从分组里筛出重复的 → 非空就 exit(1)
    expect(src, "没有给每张图算哈希").toMatch(/createHash\(|md5sum/);
    expect(src, "没有按哈希分组").toMatch(/byHash\.(set|get)\(/);
    // 只捕获**变量名**, 不试图匹配整个 lambda —— 匹配 lambda 要处理嵌套括号,
    // 我在这里连栽两次(`[^)]*` 会被 `(g)` 的右括号截断)。判据的目标是
    // "有一个由 byHash 分组筛出来的变量", 名字拿到就够, 谓词长什么样不重要。
    const m = src.match(/(?:const|let)\s+(\w+)\s*=\s*\[\.\.\.byHash\.values\(\)\]\.filter\(/);
    expect(m, "分组之后没有筛出'组内不止一张'的").not.toBeNull();
    const dupVar = m![1];
    expect(src, `筛出重复后没有据此退出(${dupVar} 没被用来判失败)`).toMatch(
      new RegExp(`${dupVar}\\.length[\\s\\S]{0,200}?process\\.exit\\(1\\)`),
    );
  });

  it("被授权弹层盖住的那一屏会跳过而不是照截", () => {
    expect(src, "没有弹层检测 —— 被 AuthGate 盖住的图会照截").toMatch(/密码（至少6位）|用户名已存在/);
  });
});
