// scripts/scrub-provenance-comments.ts — 清洗「从某闭源产品逐行逆向」的溯源痕迹
//
// 由来(2026-09-25): 用户问"逆向材料上传云端了吗"。查证:
//   · **二进制没上传** —— `.claude/reverse-engineering/`(7.4MB, 含别人的构建产物)被
//     `.gitignore:99 .claude/` 拦住, 从未被 git 跟踪;
//   · **但开源仓里有近 200 个文件**在注释里留下了逆向证据, 且**带指纹**:
//       `闭源 EditorView-CaKgg_bg.js E:17804-17900(...)`   ← 构建产物文件名 + 行号区间
//       `闭源 $e() L3691-3716`                            ← 被混淆的函数名 + 行号
//       `对齐闭源 MaterialsView allocateMaterials(...)`
//
// 用户选择"全部洗净"。本脚本做这件事。
//
// ⚠⚠ 核心约束: **只改注释与字符串字面量内部, 一个代码 token 都不碰。**
//   近 200 个文件里只要改坏一处(比如把模板串里的 `${}` 弄乱、把正则里的斜杠吃掉),
//   后果就是成片的语法错误。所以这里逐字符走状态机, 而不是正则在全文上乱扫 ——
//   用正则改多语言源码是这次最容易翻车的地方。
//
// 清洗规则("闭源"一律换成中性的"参考产品", 不做语义改写):
//   ① `闭源产品`       → `参考产品`(先归一, 否则会产出"参考产品产品")
//   ② 构建产物文件名   → 中文视图名(去掉带哈希的指纹)
//   ③ 行号坐标         → 删
//   ④ 被混淆的函数名   → `同名函数`(**仅**在紧跟"参考产品/闭源"之后时)
//   ⑤ 其余 `闭源`      → `参考产品`
//
// 用法:
//   npx tsx scripts/scrub-provenance-comments.ts            # dry-run: 只统计与取样
//   npx tsx scripts/scrub-provenance-comments.ts --write    # 真改
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const DRY = !process.argv.includes("--write");
const EXT = /\.(ts|tsx|vue|mts|cts)$/;

/** 从 git 取"含闭源字样"的文件清单 —— 用 git 而不是遍历目录, 免得走进 node_modules */
function targets(): string[] {
  const out = execSync("git grep -l 闭源 -- src web test scripts", { encoding: "utf-8", maxBuffer: 1 << 28 });
  return out.split("\n").map((s) => s.trim()).filter((s) => s && EXT.test(s));
}

/** bundle 基名 → 中文视图名(其余保留英文基名: 它不含哈希, 本身不是指纹) */
function viewNameCn(base: string): string {
  const m: Record<string, string> = {
    EditorView: "编辑器", MaterialsView: "资料页", SectionsView: "框架页", InputView: "录入门",
    FinalizeView: "合稿页", WorkspaceView: "创作台", ReviewView: "评审页", StatisticsView: "统计台",
    ChartRenderer: "图表渲染", QuickModeView: "快速编排", LibraryHome: "审稿库", VizView: "绘图台",
    PaperPreview: "论文预览", AgentFlowCanvas: "智能体画布", FloatingAssistant: "浮动助手",
  };
  return m[base] ?? base;
}

/**
 * 清洗一段注释/字符串的内容。调用方保证传进来的**一定是**注释或字符串字面量。
 *
 * 三条规则的写法都踩过坑, 注释留在各自旁边 —— 它们是"为什么这么写"的全部理由。
 */
function scrubText(t: string): string {
  /** 只做替换, 不额外收拾空格 —— 空格由各规则自己保证(见 ③ 的替换成空串) */
  const apply = (src: string, re: RegExp, rep: string | ((...a: never[]) => string)) =>
    src.replace(re as never, rep as never);

  let s = t;
  // ① 归一: 否则 ⑤ 会把"闭源产品"变成"参考产品产品"
  s = apply(s, /闭源产品/g, "参考产品");

  // ② 构建产物文件名(带哈希的那种) → 中文视图名
  //    ⚠ 前瞻/后顾是**必需的**, 而且踩过两次:
  //      a) 少了 `\b`, 会在更长的标识符内部误匹配;
  //      b) 少了"前后不能是引号/斜杠"这一条, 会吃掉 **import 路径** ——
  //         `../services/llm-model-registry.js` 里的 `llm-model-registry.js` 长得
  //         完全像一个 bundle 名, 被换成 `llm-model` 之后**整个文件编译不过**。
  //         干跑取样里就是这么发现的。
  //    c) ⚠⚠ **`.js` 后面不能再跟单词字符** —— 否则它会吃到 `.json` 的前三个字母。
  //       实测 `"memory-recall-report.json"` 被改成 `"memory-recallon"`
  //       (base=`recall` + 残余 `on`)。那是**代码在用的真实文件路径**, 运行期会找不到文件,
  //       而 typecheck 与单测**都发现不了**(它仍是一个合法字符串)。
  //       三条一起才安全: 前面不是引号/斜杠、是词边界、后面不是单词字符。
  s = apply(s, /(?<!["'`/])\b([A-Za-z][A-Za-z0-9]*?)-[A-Za-z0-9_]{6,12}\.js(?![\w"'`])/g,
    (_m: string, base: string) => viewNameCn(base));

  // ③ 行号坐标 —— 两条硬约束, 都是踩出来的:
  //    a) **前缀 [LRE] 必须必需**, 不能写成可选。第一版写成可选, 于是"任意 3-6 位数字"
  //       都被当行号, 年份/条数/`§1.4-4` 全被吃掉, 干跑取样里甚至跨行吞掉下一行。
  //    b) **前面不能是字母/数字/`#`**。少了这条, `"#E0714F"` 这种十六进制色值会被
  //       当成 "E0714" + 尾巴 `F` 吃掉 → 颜色静默变成 `"# F"`, 而 **typecheck 照样通过**
  //       (它仍是合法字符串)。这是本次清洗最危险的一处: 改坏的是运行期数据, 不是代码。
  //       实测在 WorkspaceView 的 roleColor 里真的发生了(5 处), 靠 diff 逐行看才发现。
  //       替换成**空串**: 模式里的前导 `\s*` 已经把前面的空格一并吃掉。
  s = apply(s, /(?<![\w#])\s*[（(]?\s*[LRE]:?\d{3,6}(?:[-–~]\d{3,6})?[）)]?/g, "");

  // ④ 被混淆的函数名。
  //    ⚠ 只动**紧跟溯源词之后**的短名, 且中间最多隔一个 CamelCase 视图名。
  //    做成"任意短名 + ()"很危险: `q()` 是我们自己的 API 封装(见 api.ts 的注释),
  //    `fn()`/`h()`/`it()` 有的是回调参数与测试 API —— 误伤才是真的改坏语义。
  //    中间那个可选词也要求是 CamelCase 英文(`闭源 StatisticsView it()`,
  //    实测有这么写的), 中文一律不匹配 —— 那更可能是正常句子。
  //    `a()/b()` 连写也要盖住(见 fe()/xe() 那种引用形态, 只替一次即可)。
  //
  //    ⚠ 试过改成"变长后顾只替换名字本身"(想避免动空格), 结果一条都没替换上 ——
  //    两条分支的可选组让后顾长度不定, JS 不认。**够用的写法就别再"优化"**,
  //    这一版的四条形态(纯名/带视图名/连写/带行号)都验过。
  s = apply(s, /(参考产品|闭源)(\s+[A-Z][A-Za-z0-9]*)?\s*([$A-Za-z_][A-Za-z0-9_$]{0,2})\(\)(\s*\/\s*([$A-Za-z_][A-Za-z0-9_$]{0,2})\(\))?/g,
    (_m: string, lead: string, mid: string | undefined) =>
      `${lead}${mid ?? ""}${mid ? " " : ""}同名函数`);

  // ⑤ 其余 `闭源`
  s = apply(s, /闭源/g, "参考产品");
  return s;
}

/**
 * 逐字符状态机: 只对"注释"与"字符串字面量"跑 scrubText, 其余原样透传。
 *
 * 判定刻意保守 —— 认不出来的一律当代码(宁可漏洗, 不可改坏)。
 * scrubText 的输出不含 `$` 或反引号, 所以模板串整段处理是安全的。
 */
function scrubSource(src: string): { out: string; changed: number } {
  let out = "";
  let i = 0;
  let changed = 0;
  const n = src.length;
  const flush = (text: string) => {
    const s2 = scrubText(text);
    if (s2 !== text) changed++;
    out += s2;
  };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // 行注释
    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      flush(src.slice(i, j));
      i = j;
      continue;
    }
    // 块注释
    if (c === "/" && c2 === "*") {
      const end = src.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      flush(src.slice(i, j));
      i = j;
      continue;
    }
    // 字符串字面量(含模板串)
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { j++; closed = true; break; }
        // 非模板串里出现裸换行 → 我们认错了起点, 立刻收手当代码处理
        if (src[j] === "\n" && c !== "`") break;
        j++;
      }
      if (closed) {
        flush(src.slice(i, j));
        i = j;
        continue;
      }
    }
    out += c;
    i++;
  }
  return { out, changed };
}

const files = targets();
console.log(`[scrub] 目标 ${files.length} 个文件 (${DRY ? "dry-run" : "写入"})`);

/**
 * ⚠⚠ **落地前的守门** —— 本次清洗唯一能防住"改坏代码/数据"的手段。
 *
 * 判据: **一条被改动的行, 它的原文里必须含触发词**(`闭源` / 带哈希的 bundle 文件名 /
 * `L·R·E` 行号坐标)。含不着 = 我们的某条正则**超出了它该管的范围**, 一律拒绝写入。
 *
 * 这是被两次真实事故逼出来的, 两处的共同点都是"**不是语法错**, 所以 typecheck / 单测
 * 一律抓不到, 只有逐行看改动落点才抓得到":
 *   · 第一轮: 行号正则把 `"#E0714F"` 吃成 `"# F"` —— 十六进制色值, 5 处, 全绿;
 *   · 第二轮: 文件名正则把 `"memory-recall-report.json"` 吃成 `"memory-recallon"` ——
 *     真实文件路径、代码在用、同样全绿。
 * 两条被判据当场拦下(它们所在的行都没有 `闭源`)。
 *
 * 为什么不用"这一行看起来像注释"当判据: 试过, 误报 6 处 ——
 * 多行模板串里的正文、`describe("...闭源...")` 的测试名、`-->` 结尾的块注释末行,
 * 它们都不是注释却**本来就该被改**。而这套代码本来就是"只改注释与字符串内部"
 * (见文件头), 所以"行是不是注释"根本不是判据, "改动有没有越界"才是。
 */
function offendingLines(rel: string, before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const TRIGGER = /闭源|[A-Za-z]+-[A-Za-z0-9_]{6,12}\.js|[LRE]:?\d{3,6}/;
  const bad: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    // 新增行(a[i] 不存在)没有原文可比, 只能靠"删掉的那一版"来判 —— 这里保守放过,
    // 因为状态机只会在注释/字符串区间里产生变更, 而整行新增只可能来自块注释内部换行。
    if (a[i] === undefined) continue;
    if (!TRIGGER.test(a[i])) bad.push(`    ${i + 1}: ${a[i].trim().slice(0, 100)}`);
  }
  return bad;
}

/**
 * 全局不变量: 原文件里所有"运行期常量字面量"必须原样出现在结果里。
 * 这是判据之外的第二张网 —— 十六进制色值与各类文件名是**运行期真的在用**的东西,
 * 被正则蹭掉之后不会报错, 只会静默变行为。
 */
const RUNTIME_LITERALS = /"(#[0-9A-Fa-f]{3,8})"|"([\w./-]+\.(?:json|mjs|cjs|py|csv|xlsx|docx|zip|sql|md))"/g;
function lostLiterals(before: string, after: string): string[] {
  const lost: string[] = [];
  for (const m of before.matchAll(RUNTIME_LITERALS)) {
    const lit = m[1] ?? m[2];
    if (lit && !after.includes(lit)) lost.push(lit);
  }
  // 去重(同一个色值可能出现多次)
  return [...new Set(lost)];
}

let touched = 0;
let totalChanged = 0;
const samples: string[] = [];
const offenses: string[] = [];
const planned: Array<{ f: string; out: string }> = [];
for (const f of files) {
  const src = readFileSync(f, "utf-8");
  const { out, changed } = scrubSource(src);
  if (out === src) continue;
  const bad = offendingLines(f, src, out);
  const lost = lostLiterals(src, out);
  if (bad.length || lost.length) {
    offenses.push(`  ${f}${bad.length ? "\n  越界行:\n" + bad.slice(0, 3).join("\n") : ""}${lost.length ? `\n  丢失字面量: ${lost.slice(0, 5).join(", ")}` : ""}`);
    continue;
  }
  touched++;
  totalChanged += changed;
  planned.push({ f, out });
  if (samples.length < 6) {
    const before = src.split("\n");
    const after = out.split("\n");
    let li = before.findIndex((l, k) => l !== after[k]);
    if (li < 0) li = before.findIndex((l) => /闭源|[A-Za-z]+-[A-Za-z0-9_]{6,12}\.js/.test(l));
    samples.push(`  ${f}\n    - ${(before[li] ?? "").trim().slice(0, 116)}\n    + ${(after[li] ?? "").trim().slice(0, 116)}`);
  }
}
if (offenses.length) {
  console.error(`\n[scrub] ❌ 有 ${offenses.length} 个文件的改动落在**非注释行**上, 拒绝写入。`);
  console.error(`        这些是代码或字符串里的真实内容 —— 改了运行期会坏, 而 typecheck 抓不到。`);
  console.error(offenses.slice(0, 6).join("\n"));
  process.exit(1);
}
if (!DRY) for (const { f, out } of planned) writeFileSync(f, out, "utf-8");
console.log(`[scrub] 改动 ${touched} 个文件 / ${totalChanged} 处 (全部落在注释行内)`);
if (samples.length) console.log("[scrub] 取样:\n" + samples.join("\n"));
