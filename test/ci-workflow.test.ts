// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// test/ci-workflow.test.ts — CI 工作流文件本身的自检
//
// 为什么需要这个(2026-09-28, 真实事故):
//   我改了 `.github/workflows/ci.yml` 里的一行 artifact 名字, 用了
//     `${{ replace(matrix.shard, '/', '-') }}`
//   —— GitHub Actions 的表达式**没有 `replace()`**(那是 Azure Pipelines 的语法)。
//   未知函数让**整个 workflow 文件失效**: GitHub 不创建 CI run, 只在 Actions 页
//   留一条 0.0 分钟的 "failure"。
//
//   从"某个分片红"变成"**根本没有门禁**", 而且:
//     · `npm test` / `npm run typecheck` / 本地 UI 门禁**全都绿** —— 没有任何东西读 ci.yml;
//     · 我和用户都不会立刻发现, 因为"没有 run"不像"run 失败"那样有红点。
//   换句话说: **保护伞坏了, 而坏掉的保护伞不会报警。**
//
//   所以这里把"ci.yml 里只准出现白名单内的表达式函数"变成一条单测 ——
//   它跑在本机的 `npm test` 里, 改坏了立刻红, 不用等一次 push 才发现。
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ciPath = path.join(root, ".github", "workflows", "ci.yml");

/**
 * GitHub Actions 表达式里**确实存在**的函数(官方文档的 Functions 一节)。
 *
 * ⚠ 刻意用**白名单**而不是黑名单: 黑名单只能挡住我想得到的错法, 而这次踩的
 *   `replace()` 正是我想不到的那一种。白名单会让"任何我没列出的函数"都红 ——
 *   如果将来 GitHub 真加了新函数, 这条测试会红一次, 那时把它加进白名单即可
 *   (一次噪音, 换"不会静默失效")。
 */
const ALLOWED_FNS = new Set([
  // 通用
  "contains", "startsWith", "endsWith", "format", "join", "toJSON", "fromJSON", "hashFiles",
  // 状态函数
  "success", "always", "cancelled", "failure",
]);

/** 从 `${{ ... }}` 里抠出被调用的函数名(形如 `name(`), 排除掉 `.name(` 这种属性访问 */
function calledFunctions(expr: string): string[] {
  const out: string[] = [];
  // 前面的 (?<![.\w]) 用来排除 `foo.bar(` 里的 bar 与标识符中段
  const re = /(?<![.\w])([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) out.push(m[1]);
  return out;
}

/**
 * 去掉 YAML 注释后的正文。
 *
 * ⚠ 必须先剥注释: **GitHub 不解析注释里的 `${{ }}`**, 但本测试若照扫, 就会把
 *   注释里"举例说明某个写法是错的"当成真用了那个写法 —— 实测踩过:
 *   我在注释里写了 `${{ replace(...) }}` 作为反面教材, 守卫立刻报红,
 *   而文件本身是对的。**判据要与被解释对象的真实语义对齐**(这里: 注释对 Actions 不存在)。
 */
function stripComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line) => {
      // 引号内的 # 不算注释 —— 简单处理: 找第一个不在引号里的 #
      let inS = false, inD = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'" && !inD) inS = !inS;
        else if (c === '"' && !inS) inD = !inD;
        else if (c === "#" && !inS && !inD) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** 整个文件里所有 `${{ ... }}` 的内容(不含注释里的) */
function expressions(src: string): string[] {
  const out: string[] = [];
  const re = /\$\{\{([\s\S]*?)\}\}/g;
  let m: RegExpExecArray | null;
  const body = stripComments(src);
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

describe("CI 工作流自检", () => {
  it("ci.yml 存在且能读到", () => {
    expect(existsSync(ciPath)).toBe(true);
    expect(readFileSync(ciPath, "utf8").length).toBeGreaterThan(500);
  });

  it("只使用 GitHub Actions 真有的表达式函数(未知函数会让整个 workflow 失效)", () => {
    const src = readFileSync(ciPath, "utf8");
    const offenders: string[] = [];
    for (const expr of expressions(src)) {
      for (const fn of calledFunctions(expr)) {
        // ⚠ 用字符串拼接而不是模板串: 这里要**显示** `${{ }}` 字面量,
        //   而在模板串里 `${` 会被当成插值起点 —— 写 `${{${x}}}` 直接语法错误
        //   (与工作流里的表达式撞名, 纯属巧合但很坑)。
        if (!ALLOWED_FNS.has(fn)) offenders.push(fn + "()  ←  $" + "{{" + expr.trim().slice(0, 60) + "}}");
      }
    }
    expect(
      offenders,
      `ci.yml 里用了 GitHub Actions 不支持的表达式函数。\n` +
      `这是致命的: 未知函数会让**整个 workflow 文件失效** —— GitHub 不创建 run,\n` +
      `只在 Actions 页留一条 0.0 分钟的 failure, 于是门禁等于不存在(2026-09-28 真发生过)。\n` +
      `若确实是 GitHub 新增的函数, 把它加进本测试的 ALLOWED_FNS 白名单。\n` +
      offenders.join("\n"),
    ).toEqual([]);
  });

  it("artifact 名字里不含 `/`(upload-artifact 会拒绝, 那一步自己也红)", () => {
    const src = readFileSync(ciPath, "utf8");
    /**
     * 逐行找 `name:` 后面**带表达式**的 artifact 名。
     * ⚠ 不能简单断言"名字里没有 /" —— 像 `verify-ui-log-${{ matrix.tag }}` 这种
     *   静态部分本来就不该有 `/`; 真正会出事的是 `${{ matrix.shard }}`(值形如 "3/5")。
     *   所以判据是: artifact 名里引用的矩阵变量**必须是 tag 这种无斜杠形式**。
     */
    const bad: string[] = [];
    for (const line of src.split(/\r?\n/)) {
      const m = line.match(/^\s*name:\s*(verify-ui-log.*)$/);
      if (!m) continue;
      if (/matrix\.shard/.test(m[1])) bad.push(m[1].trim());
    }
    expect(bad, `artifact 名不能直接用 matrix.shard(值形如 "3/5", 含斜杠): ${bad.join(", ")}`).toEqual([]);
  });

  it("ui-gate 分片矩阵的每一项都有 tag(artifact 名要用它)", () => {
    const src = readFileSync(ciPath, "utf8");
    // include: 下每一项都应当同时给出 shard 与 tag
    const shards = [...src.matchAll(/-\s*shard:\s*"([^"]+)"\s*\n\s*tag:\s*"([^"]+)"/g)].map((m) => ({ shard: m[1], tag: m[2] }));
    expect(shards.length, "ui-gate 矩阵里应当有 shard/tag 成对的分片定义").toBeGreaterThanOrEqual(5);
    for (const s of shards) {
      expect(s.shard.includes("/"), `shard 形如 "n/N": ${s.shard}`).toBe(true);
      expect(s.tag.includes("/"), `tag 不能含斜杠(它要进 artifact 名): ${s.tag}`).toBe(false);
      expect(s.tag.replace("-", "/")).toBe(s.shard);   // tag 与 shard 必须一一对应
    }
  });
});
