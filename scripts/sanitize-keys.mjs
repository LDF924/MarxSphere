// sanitize-keys.mjs — 清理 skills/ 目录硬编码 API key（V425）
// 把所有 sk-ws-* 字面量替换为 os.getenv("DASHSCOPE_API_KEY", "")（保留环境变量读取逻辑）
// 删除 *.v*-bak 备份文件
import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve("skills");
const KEY_RE = /["']sk-ws-[A-Za-z0-9._-]+["']/g;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let replaced = 0;
let filesChanged = 0;
for (const file of walk(root)) {
  if (!/\.(py|md)$/.test(file)) continue;
  const raw = readFileSync(file, "utf8");
  if (!KEY_RE.test(raw)) continue;
  const clean = raw.replace(KEY_RE, (m) => {
    replaced++;
    // 保留原引号风格
    const q = m[0];
    return `${q}${q}`; // 空字符串（环境变量读取仍在，getenv 第二参数变 "")
  });
  writeFileSync(file, clean, "utf8");
  filesChanged++;
  console.log("cleaned:", file);
}

// 删除备份文件
let bakRemoved = 0;
for (const file of walk(root)) {
  if (/\.(v\d+-bak|bak)$/.test(file) || /\.v\d+[A-Za-z-]*$/.test(file)) {
    rmSync(file, { force: true });
    bakRemoved++;
    console.log("removed:", file);
  }
}

console.log(`\n替换 key 字面量: ${replaced} 处 | 修改文件: ${filesChanged} | 删除备份: ${bakRemoved}`);
