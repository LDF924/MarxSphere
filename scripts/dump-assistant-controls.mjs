// scripts/dump-assistant-controls.mjs — 从闭源构建产物里抽 `data-assistant-control` 全集
//
// 为什么留这个脚本: 那张 44 项对照表(台账 §19)是**逐条判定**的产物, 必须可复核。
//   把"闭源到底有哪些"固定成一条能重跑的命令, 比在文档里贴一份手抄清单可靠 ——
//   旧记录里那个"43 个"就是估算来的, 重抽一次发现是 44。
//
// 用法: node scripts/dump-assistant-controls.mjs
//   前置: 逆向资料在本机(不入库, 见 AGENTS/同步脚本对 .claude 的排除)
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = ".claude/reverse-engineering/socialsci-com";
if (!existsSync(ROOT)) {
  console.error(`找不到逆向资料目录: ${ROOT}`);
  console.error("(它按约定不入库, 只在本机 —— 换机器需要先把资料拷回来)");
  process.exit(1);
}

const dirs = [join(ROOT, "full"), ROOT];
const found = new Map(); // control → Set(来源文件)
for (const dir of dirs) {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/data-assistant-control":"([a-z_0-9]+)"/g)) {
      if (!found.has(m[1])) found.set(m[1], new Set());
      found.get(m[1]).add(f);
    }
  }
}

const rows = [...found.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log(`闭源 data-assistant-control 全集: ${rows.length} 个\n`);
for (const [c, files] of rows) {
  console.log(`  ${c.padEnd(40)} ${[...files].sort().join(", ")}`);
}
