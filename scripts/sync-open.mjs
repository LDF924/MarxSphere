#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// scripts/sync-open.mjs — main→open-source 一键同步(V393, 2026-08-30)
// 流程:
//   1. 复制 main 的全部代码/文档到 open-source(排除 .env/.git/node_modules/dist 等)
//   2. open-source 提交 + push origin main
// 用法:
//   node scripts/sync-open.mjs           # 同步+提交+push
//   node scripts/sync-open.mjs --dry-run # 只显示差异不复制
//   node scripts/sync-open.mjs --push    # 同步+提交, 跳过 push
import { execSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(__dirname, "..");
const OPEN = "C:/Users/HUAWEI/SAG-open-source";
const DRY = process.argv.includes("--dry-run");
const NO_PUSH = process.argv.includes("--push");

if (!existsSync(OPEN)) { console.error(`[sync-open] open-source 不存在: ${OPEN}`); process.exit(1); }

// ─── 同步目录(与 sync-repos.mjs 的 EXCLUDE 对齐) ───
const DIRS = ["src", "web/src", "web/public", "test", "migrations", "scripts", "docs", "electron", "plugins", "vendor", "config"];
const ROOT_FILES = ["README.md", "README-CN.md", "README-EN.md", "CHANGELOG.md", "BENCHMARK.md", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "CLAUDE.md", "LICENSE", "package.json", "package-lock.json", "docker-compose.yml", "tailwind.config.js", "vite.config.ts", "postcss.config.js", "tsconfig.json", "tsconfig.build.json", "electron-builder.yml", "vitest.config.ts", "vite.preview.config.ts"];
const EXCLUDE_DIR = new Set(["node_modules", "dist", ".git", ".cache", ".vite", "release", "resources", "backups", "data", ".claude", "memory", "eval-archive", "reports", "knowledge-graph", "skills"]);
const EXCLUDE_FILE = [/^\.env/, /\.log$/, /\.v\d+/, /\.bak/, /^eval_32metrics.*\.json$/, /^gold_dataset.*\.json$/, /^judge_results\.json$/, /^isolated_entities\.csv$/, /^batch-ingest-log/, /^cognee_entities_dump\.json$/, /^entity_(id|norm)_map\.json$/, /^paper_id_map\.json$/, /^run-eval-one-by-one/, /^start(_sag|-web)\./, /^compact-vhdx/, /^memory-settings\.json$/, /^node_modules\.zip$/];

function excluded(rel, isDir) {
  // 任意层级的排除目录(scripts/eval-archive 等)
  const relLower = rel.toLowerCase();
  if (isDir && (EXCLUDE_DIR.has(rel) || relLower.split("/").some((seg) => EXCLUDE_DIR.has(seg)))) return true;
  const name = path.basename(rel);
  return EXCLUDE_FILE.some((re) => re.test(name));
}

// ─── 收集待复制文件(递归) ───
const files = [];
function collect(dir, relBase) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = relBase ? `${relBase}/${name}` : name;
    if (excluded(rel, statSync(full).isDirectory())) continue;
    if (statSync(full).isDirectory()) collect(full, rel);
    else files.push(rel);
  }
}
for (const d of DIRS) {
  const src = path.join(MAIN, d);
  if (existsSync(src)) collect(src, d);
}
for (const f of ROOT_FILES) {
  if (existsSync(path.join(MAIN, f))) files.push(f);
}

// ─── 对比差异 ───
// 行尾不敏感比较(CRLF/LF): git 仓库用 autocrlf=true 时同一内容在
// 两仓的物理字节不同, 全字节比较会让自动同步反复制造假差异提交。
function sameContent(src, dst) {
  try {
    return readFileSync(src, "utf8").replace(/\r\n/g, "\n")
      === readFileSync(dst, "utf8").replace(/\r\n/g, "\n");
  } catch { return false; }
}
const changed = [];
const added = [];
for (const rel of files) {
  const src = path.join(MAIN, rel);
  const dst = path.join(OPEN, rel);
  if (!existsSync(dst)) { added.push(rel); continue; }
  if (!sameContent(src, dst)) changed.push(rel);
}
console.log(`[sync-open] 差异: ${changed.length} 修改 + ${added.length} 新增 = ${changed.length + added.length} 文件`);
for (const f of changed.slice(0, 15)) console.log(`  M ${f}`);
for (const f of added.slice(0, 10)) console.log(`  A ${f}`);
if (changed.length + added.length > 15) console.log(`  … 等 ${changed.length + added.length - 15} 个`);

if (DRY) { console.log("[sync-open] --dry-run: 未复制"); process.exit(0); }
if (changed.length + added.length === 0) { console.log("[sync-open] ✅ open-source 已是最新"); process.exit(0); }

// ─── 复制 ───
for (const rel of files) {
  const src = path.join(MAIN, rel);
  const dst = path.join(OPEN, rel);
  if (!changed.includes(rel) && !added.includes(rel)) continue;
  if (!existsSync(dst) || !sameContent(src, dst)) {
    try { cpSync(src, dst, { force: true }); } catch { /* 二进制/权限跳过 */ }
  }
}
console.log(`[sync-open] 已复制 ${changed.length + added.length} 文件 → ${OPEN}`);

// ─── 提交 + push ───
try {
  execSync(`git add -A`, { cwd: OPEN, stdio: "inherit" });
  const status = execSync(`git status --short`, { cwd: OPEN, encoding: "utf8" });
  if (status.trim()) {
    execSync(`git commit -m "sync: 自动同步 main → open (${new Date().toISOString().slice(0, 10)})"`, { cwd: OPEN, stdio: "inherit" });
    console.log("[sync-open] 已提交 open-source");
  }
  if (!NO_PUSH) {
    execSync(`git push origin main`, { cwd: OPEN, stdio: "inherit" });
    console.log("[sync-open] 已 push origin main");
  } else {
    console.log("[sync-open] --push: 跳过 push");
  }
} catch (e) {
  console.error(`[sync-open] git 操作失败: ${String(e?.message || e).slice(0, 200)}`);
  process.exit(1);
}
console.log("[sync-open] ✅ 同步完成");
