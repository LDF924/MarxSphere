/**
 * shell-script-encoding.test.ts — 脚本文件的**编码与字符集**门禁。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么要有这一条
 *
 * 2026-09-27 那天，我连着踩了同一类问题三次，而**每一次都是静默失效**：
 *
 *   ① `start-api-4173.cmd` 的注释里有中文 → cmd 按 OEM 码页(GBK)解析，那行
 *      **把后面的命令吞掉**，启动时冒出一串 `'t-api-4173.cmd' is not recognized`。
 *      而它自己的文件头第 10 行就写着 "keep comments ASCII-only" —— 那条规矩
 *      一直被违反着，只因为"被吞的是注释而不是命令"才没出事。
 *   ② 清完两个 .cmd 才发现**同类文件还有 11 个**(.bat/.ps1/.vbs)，全是中文。
 *      `.vbs` 那条最要紧：脚本里**唯一能让用户看见的失败提示**(找不到 bash 时弹的
 *      错误框)本身就是乱码。
 *   ③ BOM 比中文更危险，因为它**不可见**：
 *      `.sh` 带 BOM → `#!` 不在首字节 → **shebang 失效**，脚本根本跑不起来；
 *      被 dot-source 时 BOM 还会变成第一条命令的一部分；
 *      `.json` 带 BOM → `JSON.parse` **直接抛**；
 *      `.sql` 带 BOM → 首条语句可能报错。
 *      而 BOM 恰恰是编辑器"另存为 UTF-8 带签名"的默认行为。
 *
 * 这三次都没被任何东西拦住 —— 类型检查照不到，单测照不到，门禁也照不到
 * (它们长在**文件字节**上，不在代码结构上)。所以补这一条。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 规则(每条都对应上面的一次事故，不是凭空定的)
 *
 *   R1 危险类型不得有 BOM：`.sh .cmd .bat .sql .json`
 *   R2 `scripts/` 与仓库根的 `.cmd/.bat/.ps1/.vbs` 必须**纯 ASCII**
 *      —— 除非 `.ps1` 带 BOM(PowerShell 5.1 有 BOM 才按 UTF-8 读，那是一条明路)
 *   R3 `.sh` 不得有 CRLF —— 顺带查，因为混合行尾在 Git Bash 下会出怪问题
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 刻意**不**检查的
 *
 *   · `.ts/.tsx/.vue/.mjs/.sql` 等源码里的中文注释 —— 它们由 TypeScript / Vite /
 *     esbuild 按 UTF-8 读，中文**不会读错**。那是数据不是语法，改成英文没有收益，
 *     而注释里记的"为什么"是这个仓库最有价值的部分。
 *   · `.md` 与 `.yml` 里的中文 —— 同理，UTF-8 消费者。
 *   · `.ps1` 的 BOM —— 那是合法的、甚至更安全的(见 R2)。
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");

/** 与 sync-open.mjs 的排除口径对齐，另加构建产物 —— 规则只针对**源文件** */
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", ".cache", ".vite", "vendor", "coverage",
  "release", "resources", "backups", "eval-archive", "data", "logs", "reports",
  "knowledge-graph", "skills", "__pycache__",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // 点目录一律跳过(.claude 里是逆向材料、.vite 是缓存) —— 但保留 .github
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const FILES = walk(ROOT);
/**
 * 路径 → 展示用标签。
 *
 * ⚠ 参数化 `root` 是**为了让规则能被对着临时目录的样例调用**(见最后那组负向验证)。
 *   第一版把 ROOT 写死在规则函数里, 于是对临时文件算出的标签是
 *   `../../AppData/Local/Temp/.../a.sh` 这种怪路径 ——
 *   更糟的是 `shellScriptsWithNonAscii` 里那句 `/^scripts\//` 过滤**也依赖它**,
 *   对临时路径恒不成立 → 一个样例都匹配不到 → 负向用例**看起来"探测失效"**。
 *   (我一度以为是 `rel` 的问题, 想用 process.chdir 绕过 —— 没用, ROOT 在模块加载时就定死了。
 *    真因是**规则不可测**, 不是一个路径小 bug。)
 */
const relTo = (root: string, p: string) => path.relative(root, p).replace(/\\/g, "/");
const rel = (p: string) => relTo(ROOT, p);
const hasBom = (b: Buffer) => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
const nonAsciiLines = (s: string) =>
  s.split(/\r?\n/).map((l, i) => ({ n: i + 1, l })).filter((x) => /[^\x00-\x7F]/.test(x.l));

// ── 规则本身抽成纯函数 ──
// 抽出来是为了能对**临时目录里人为种的样例**跑同一套逻辑(见最后一组用例)。
// 只对真实仓库跑的函数没法被反向验证 —— 而"没响过的门禁"本仓已经有过好几道。

const BOM_DANGEROUS = [".sh", ".cmd", ".bat", ".sql", ".json"];
function filesWithDangerousBom(files: string[], root = ROOT): string[] {
  const bad: string[] = [];
  for (const f of files) {
    if (!BOM_DANGEROUS.includes(path.extname(f).toLowerCase())) continue;
    try { if (hasBom(fs.readFileSync(f))) bad.push(relTo(root, f)); } catch { /* 读不到跳过 */ }
  }
  return bad;
}

const SHELL_EXT = [".cmd", ".bat", ".vbs", ".ps1"];
function shellScriptsWithNonAscii(files: string[], root = ROOT): Array<{ f: string; lines: number[] }> {
  const bad: Array<{ f: string; lines: number[] }> = [];
  for (const f of files) {
    const r = relTo(root, f);
    if (!/^scripts\/|^[^/]+$/.test(r)) continue;          // 只看 scripts/ 与仓库根
    const ext = path.extname(f).toLowerCase();
    if (!SHELL_EXT.includes(ext)) continue;
    let b: Buffer;
    try { b = fs.readFileSync(f); } catch { continue; }
    /**
     * `.ps1` 的放宽：**带 BOM 就整条放行**（不再查非 ASCII）。
     *
     * 为什么是放行而不是"剥掉 BOM 再查"：PowerShell 5.1 对带 BOM 的 .ps1 按 UTF-8 读，
     *   所以"带 BOM + 中文"是**一条正当写法**，不该被拦。如果剥掉 BOM 接着查，
     *   那条中文照样会被判红 —— 等于豁免没生效。
     *
     * ⚠ 这里我绕过一次弯，值得记：第一版写的 `continue` 本来就是对的。
     *   后来负向测试报"该绿却红"，我就把它改成"剥 BOM 再查" —— **那才是引入回归**。
     *   当时那次红其实是**负向脚本自己的退出码不可靠**(用 `npx` + 管道取退出码)造成的假象。
     *   教训: 判据说某条"该绿却红"时, 先怀疑**测量方式**, 再改被测逻辑。
     */
    if (ext === ".ps1" && hasBom(b)) continue;
    const text = b.toString("utf8");
    const lines = nonAsciiLines(text).map((x) => x.n);
    if (lines.length) bad.push({ f: r, lines });
  }
  return bad;
}

function shFilesWithCrlf(files: string[], root = ROOT): string[] {
  const bad: string[] = [];
  for (const f of files) {
    if (path.extname(f).toLowerCase() !== ".sh") continue;
    let s: string;
    try { s = fs.readFileSync(f, "utf8"); } catch { continue; }
    // 只要有**一个** CRLF 就算 —— 混合行尾是坏得更隐蔽的那种
    if (/\r\n/.test(s)) bad.push(rel(f));
  }
  return bad;
}

describe("R1 危险类型不得有 BOM", () => {
  /**
   * 每个后缀各自坏法不同 —— 逐条写明，免得后人以为这条是洁癖：
   *   .sh   shebang 失效 / dot-source 时 BOM 变成首命令的一部分
   *   .cmd  .bat  cmd.exe 解析异常
   *   .sql  首条语句可能报错
   *   .json JSON.parse 直接抛
   */
  it("这些后缀的文件里没有一个带 BOM", () => {
    const bad = filesWithDangerousBom(FILES);
    expect(bad, `带 BOM 的文件(会让 shebang/JSON.parse/SQL 解析失效)：\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  it("至少真扫到了这些类型的文件(防判据失效)", () => {
    // ⚠ 这条是**给判据本身上的保险**: 如果 walk() 因某个原因返回空数组,
    //   上面那条会**空数组对空数组**恒过 —— 而它看起来是绿的。
    const counts: Record<string, number> = {};
    for (const f of FILES) {
      const e = path.extname(f).toLowerCase();
      if (BOM_DANGEROUS.includes(e)) counts[e] = (counts[e] ?? 0) + 1;
    }
    expect(counts[".sh"] ?? 0, `实测各类型: ${JSON.stringify(counts)}`).toBeGreaterThan(0);
    expect(counts[".json"] ?? 0, `实测各类型: ${JSON.stringify(counts)}`).toBeGreaterThan(0);
  });
});

describe("R2 shell 脚本必须纯 ASCII", () => {
  it("scripts/ 与仓库根下的壳脚本没有非 ASCII 字符", () => {
    const bad = shellScriptsWithNonAscii(FILES);
    expect(bad, `非 ASCII 的壳脚本(cmd 按 GBK / wscript 按 ANSI 读，会吞命令或弹乱码)：\n` +
      bad.map((x) => `  ${x.f} 行 ${x.lines.join(",")}`).join("\n")).toEqual([]);
  });

  it("至少真扫到了壳脚本(防判据失效)", () => {
    const n = FILES.filter((f) => {
      const r = rel(f);
      return /^scripts\/|^[^/]+$/.test(r) && SHELL_EXT.includes(path.extname(f).toLowerCase());
    }).length;
    expect(n, "没扫到任何壳脚本 —— 说明 walk 或过滤写错了，上一条会假绿").toBeGreaterThan(0);
  });
});

describe("R3 .sh 不得是 CRLF", () => {
  it("没有 CRLF 行尾的 .sh", () => {
    const bad = shFilesWithCrlf(FILES);
    expect(bad, `.sh 用了 CRLF(Git Bash 下会出现 \\r 混进命令的怪问题)：\n  ${bad.join("\n  ")}`).toEqual([]);
  });
});

/**
 * 规则的**负向验证** —— 在临时目录里人为种出每一种违规，确认规则真会报。
 *
 * 为什么需要这一组: 只对真实仓库跑的规则**没法证明它会响**。
 *   本仓已经吃过"加了门禁但从来没响过"的亏(verify-ui 里那套曾因 `process.exit`
 *   丢掉 stdout, 失败时日志只有 1.6KB; 也有一道判据因为断言的文案早就不存在而恒真)。
 *   一组对样例的断言，是"这道门禁不是空的"的唯一证据。
 *
 * ⚠ 两个踩过的细节:
 *   ① `scripts/x.cmd` 这种名字**要先建出 scripts/ 子目录**, 否则 writeFileSync 报 ENOENT
 *      (第一版漏了, 用例全挂在 ENOENT 上);
 *   ② 断言**按 basename 而不是按返回的字符串** —— 规则内部用 `rel()`(相对**仓库根**的
 *      绝对路径常量)拼标签, 对临时目录里的文件会算出
 *      `../../AppData/Local/Temp/.../a.sh` 这种怪路径。我试过 `process.chdir(TMP)`,
 *      **没用** —— ROOT 在模块加载时就定死了。探测本身是对的(数组长度对), 只是标签不同。
 *   与"直接改真实文件再还原"相比: 不碰仓库里的任何文件, 崩了也不会留下脏文件。
 */
describe("规则不是空转(对人为种的样例必须报警)", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "shell-gate-neg-"));
  const w = (name: string, body: string | Buffer, bom = false) => {
    const p = path.join(TMP, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const b = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    fs.writeFileSync(p, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]) : b);
    return p;
  };
  /** 规则返回的是路径标签, 这里只关心"抓到了哪个文件" */
  const names = (arr: Array<string | { f: string }>) =>
    arr.map((x) => path.basename(typeof x === "string" ? x : x.f));
  /** 负向样例都在 TMP 下, 规则要按 TMP 算标签与过滤 */
  const R = TMP;
  afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

  it("R1 会抓出带 BOM 的 .sh / .json, 且放过不带 BOM 的", () => {
    const sh = w("a.sh", "#!/bin/bash\necho hi\n", true);
    const js = w("b.json", '{"a":1}', true);
    const ok = w("c.json", '{"a":1}');
    expect(names(filesWithDangerousBom([sh, js, ok], R)).sort()).toEqual(["a.sh", "b.json"]);
  });

  it("R2 会抓出含中文的 .cmd/.vbs/.ps1", () => {
    const cmd = w("scripts/x.cmd", "@echo off\r\nrem 中文\r\n");
    const vbs = w("scripts/y.vbs", "' 中文\r\n");
    const ps1Plain = w("scripts/z.ps1", "# 中文\r\n");
    expect(names(shellScriptsWithNonAscii([cmd], R))).toEqual(["x.cmd"]);
    expect(names(shellScriptsWithNonAscii([vbs], R))).toEqual(["y.vbs"]);
    expect(names(shellScriptsWithNonAscii([ps1Plain], R))).toEqual(["z.ps1"]);
  });

  it("R2 的放宽真的成立: .ps1 **带 BOM** 时中文不报", () => {
    /**
     * ⚠ 这条是**给放宽条款本身**的保险。第一版这里恒红 ——
     *   因为 BOM 本身是非 ASCII, 而 `toString("utf8")` 不剥它。
     *   只测"该红的红了"会漏掉"该绿的绿不了"。
     */
    const ps1Bom = w("scripts/ok.ps1", "# 中文\r\n", true);
    expect(shellScriptsWithNonAscii([ps1Bom], R)).toEqual([]);
  });

  it("R3 会抓出 CRLF 的 .sh, 且放过 LF 的", () => {
    const crlf = w("scripts/d.sh", "#!/bin/bash\r\necho hi\r\n");
    const lf = w("scripts/e.sh", "#!/bin/bash\necho hi\n");
    expect(names(shFilesWithCrlf([crlf], R))).toEqual(["d.sh"]);
    expect(shFilesWithCrlf([lf], R)).toEqual([]);
  });
});

describe("规则本身的前提", () => {
  it("仓库根推导正确(否则上面几条查的是别的地方)", () => {
    // ⚠ 这条同样是为**判据**上的保险：ROOT 算错会让 walk 扫空，而空扫恒绿。
    expect(fs.existsSync(path.join(ROOT, "package.json"))).toBe(true);
    expect(FILES.length, "walk() 返回的文件数少得离谱，ROOT 很可能算错了").toBeGreaterThan(500);
  });
});
