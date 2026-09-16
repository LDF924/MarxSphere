#!/usr/bin/env node
// scripts/lib/hunk-split.mjs — 把某文件的工作区改动按**块**拆进不同提交
//
// 场景: 一次会话里连续改了多个主题, 同一个文件里混着它们, 要分到不同提交。
// `git add -p` 是交互式的, 脚本/代理环境用不了; 手工拼 patch 又极容易算错上下文
// (实测踩到: 按块拼出的 patch `git apply` 直接 reject)。
//
// 做法改用**重建文件**: 按块选择后, 从 HEAD 版本出发, 只把选中的块应用到它上面,
// 得到"该提交应有的文件内容", 再 `git update-index --cacheinfo` 写进索引(无需文件落地)。
// 这样不依赖任何 patch 上下文匹配, 也就不会 reject。
//
// 用法:
//   node scripts/lib/hunk-split.mjs list <file>                 # 列出可选块
//   node scripts/lib/hunk-split.mjs stage <file> H0,H3.1,H5     # 暂存这些块(索引 = HEAD + 选中块)
//
// ⚠ stage 是**覆盖式**: 索引里该文件被设成"HEAD + 本次选中的块"。
//   要分多次累加, 请一次把该文件所有属于本提交的块列全。
import { execSync } from "node:child_process";

const [cmd, file, spec] = process.argv.slice(2);
if (!cmd || !file) {
  console.error("用法: node scripts/lib/hunk-split.mjs list|stage <file> [H0,H3.1]");
  process.exit(1);
}

/**
 * 按行切分**并保留行尾**。
 *
 * ⚠ 不能用 `content.split("\n")` + `join("\n")`: 本仓库部分文件是 CRLF(Windows 上编辑的),
 *   那样重建会把 `\r` 丢掉, 索引与工作区的差异变成"整文件行尾变了"(实测踩到)。
 *   这里把行尾留在行内, 原样拼回去。
 */
function splitKeepEol(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return lines;
}

/** HEAD 版本 → 行数组(文件是新文件则为 null) */
function headLines() {
  try {
    return splitKeepEol(execSync(`git show HEAD:"${file}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } catch { return null; }
}
const hLines = headLines();
if (!hLines) { console.error(`(HEAD 里没有这个文件 —— 新文件不需要拆, 直接 git add)`); process.exit(1); }

// ── 生成带分组标记的 diff: 用 -U0 让每个变更块天然独立 ──
const diff = execSync(`git diff --no-color -U0 -- "${file}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const dLines = splitKeepEol(diff);
const blocks = [];   // { oldStart, newStart, dels: string[], adds: string[] }
for (const l of dLines) {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
  if (m) { blocks.push({ oldStart: Number(m[1]), newStart: Number(m[2]), dels: [], adds: [] }); continue; }
  if (!blocks.length) continue;
  const cur = blocks[blocks.length - 1];
  if (l.startsWith("-") && !l.startsWith("---")) cur.dels.push(l.slice(1));
  else if (l.startsWith("+") && !l.startsWith("+++")) cur.adds.push(l.slice(1));
  else if (l.startsWith(" ")) { cur.dels.push(l.slice(1)); cur.adds.push(l.slice(1)); }
}
// 只保留有新增的块(纯删除块不单列 —— 本工具用于"把哪些改动放进提交")
const pickable = blocks.filter((b) => b.adds.length > 0);

function summary(b) {
  const s = (b.adds[0] ?? b.dels[0] ?? "").trim();
  return s.slice(0, 84);
}

if (cmd === "list") {
  pickable.forEach((b, i) => console.log(`${String(i).padStart(3)}  +${b.adds.length}/-${b.dels.length}  ${summary(b)}`));
  console.log(`\n共 ${pickable.length} 个可选块`);
  process.exit(0);
}

if (cmd === "stage") {
  const toks = String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const idxs = toks.map((t) => {
    const n = Number(String(t).replace(/^H/i, ""));
    return Number.isInteger(n) ? n : NaN;
  });
  if (!idxs.length || idxs.some((n) => Number.isNaN(n) || n < 0 || n >= pickable.length)) {
    console.error(`块编号非法。有效范围 0..${pickable.length - 1}`);
    process.exit(1);
  }
  // 从 HEAD 逐块应用: 用 oldStart 从上往下走, 每次把 adds 替换掉那段 dels
  const chosen = [...new Set(idxs)].sort((a, b) => pickable[a].oldStart - pickable[b].oldStart);
  let cur = [...hLines];
  let offset = 0;
  for (const i of chosen) {
    const b = pickable[i];
    const at = b.oldStart - 1 + offset;
    // 校验将要替换掉的内容确实匹配(避免错位写入)
    const actual = cur.slice(at, at + b.dels.length);
    if (actual.join("") !== b.dels.join("")) {
      console.error(`❌ 块 ${i} 定位失败(offset=${offset})。该文件可能已被别处改过, 请重新 list。`);
      process.exit(1);
    }
    cur.splice(at, b.dels.length, ...b.adds);
    offset += b.adds.length - b.dels.length;
  }
  const content = cur.join("");
  /**
   * ⚠ 入仓前把 CRLF 归一成 LF。
   *
   * 本仓库 `.gitattributes` 写着 `* text=auto eol=lf` —— **入库一律 LF**, 而 Windows 上
   * `core.autocrlf=true` 让工作区是 CRLF。索引里必须是 LF, 否则即使内容一字不差,
   * `git diff` 也会显示整个文件都变了(实测踩到: 索引与工作区差 3 行, 内容却完全相同)。
   */
  const lf = content.replace(/\r\n/g, "\n");
  // 直接写索引: 建 blob → update-index --cacheinfo, 不落工作区文件
  const blob = execSync(`git hash-object -w --stdin`, { input: lf, encoding: "utf8" }).trim();
  const mode = execSync(`git ls-files -s -- "${file}"`, { encoding: "utf8" }).trim().split(/\s+/)[0] || "100644";
  execSync(`git update-index --cacheinfo ${mode},${blob},"${file}"`, { stdio: "inherit" });
  console.log(`✅ 索引已更新: ${file} = HEAD + ${chosen.length} 个块`);
  process.exit(0);
}

console.error(`未知命令: ${cmd}`);
process.exit(1);
