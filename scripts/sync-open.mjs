#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// scripts/sync-open.mjs — main→open-source 一键同步(V393, 2026-08-30)
// 流程:
//   1. 复制 main 的全部代码/文档到 open-source(排除 .env/.git/node_modules/dist 等)
//   2. open-source 提交 + push origin main  (临时改动)
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
// 自定义提交消息: 默认 "sync: 自动同步 main → open (日期)"; 功能提交用 --msg "feat(xxx): ..."
const MSG_FLAG = process.argv.indexOf("--msg");
const CUSTOM_MSG = MSG_FLAG > -1 ? process.argv[MSG_FLAG + 1] : "";
const COMMIT_MSG = CUSTOM_MSG || `sync: 自动同步 main → open (${new Date().toISOString().slice(0, 10)})`;

if (!existsSync(OPEN)) { console.error(`[sync-open] open-source 不存在: ${OPEN}`); process.exit(1); }

// ─── 同步目录(与 sync-repos.mjs 的 EXCLUDE 对齐) ───
// ⚠ 2026-09-12 修复: 原来只列了 "web/src", 而 collect() 不会跨进未列出的兄弟目录 ——
//   于是 **web/socialsci-vue/ 从来没有被同步过**(open 侧整个目录不存在)。
//   而 package.json 里 build:socialsci-vue 引用 web/socialsci-vue/vite.config.ts,
//   即 open 仓库的 `npm run build` 一直是坏的; 更严重的是**审稿/统计/viz/编辑器四个
//   工作台的全部前端代码都不在开源仓库里**。
//   现在补上 web/socialsci-vue 与其构建配置; web/dist 等产物仍由 EXCLUDE_DIR 排除。
const DIRS = ["src", "web/src", "web/public", "web/socialsci-vue", "test", "migrations", "scripts", "docs", "electron", "plugins", "vendor", "config"];
const ROOT_FILES = ["README.md", "README-CN.md", "README-EN.md", "CHANGELOG.md", "BENCHMARK.md", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "CLAUDE.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", "docker-compose.yml", "tailwind.config.js", "vite.config.ts", "postcss.config.js", "tsconfig.json", "tsconfig.build.json", "electron-builder.yml", "vitest.config.ts", "vite.preview.config.ts"];
const EXCLUDE_DIR = new Set(["node_modules", "dist", ".git", ".cache", ".vite", "release", "resources", "backups", "data", ".claude", "memory", "eval-archive", "reports", "knowledge-graph", "skills", "__pycache__"]);
const EXCLUDE_FILE = [/^\.env/, /\.log$/, /\.v\d+/, /\.bak/, /^eval_32metrics.*\.json$/, /^gold_dataset.*\.json$/, /^judge_results\.json$/, /^isolated_entities\.csv$/, /^batch-ingest-log/, /^cognee_entities_dump\.json$/, /^entity_(id|norm)_map\.json$/, /^paper_id_map\.json$/, /^run-eval-one-by-one/, /^start(_sag|-web)\./, /^compact-vhdx/, /^memory-settings\.json$/, /^node_modules\.zip$/];

// vendor/pdf2obsidian 的 dist 是**运行依赖**而非可再生产物:
//   src/services/pdf2obsidian-adapter.ts 直接 import 它的 {pipeline,core}/dist/*.js,
//   一旦不同步 → 克隆后 tsc 报 TS2307, 后端根本构建不出来(2026-09-12 实测)。
//   所以这三个包下的 dist 必须放行, 其它 dist(web/dist、packages/dist 等)继续排除。
const VENDOR_DIST_ALLOW = /^vendor\/pdf2obsidian\/packages\/(core|pipeline|providers)\/dist(\/|$)/;

function excluded(rel, isDir) {
  // 任意层级的排除目录(scripts/eval-archive 等)
  const relLower = rel.toLowerCase();
  if (VENDOR_DIST_ALLOW.test(relLower)) return false;
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

// ─── 检测「main 已删、open 仍留着」的残留 ───
// 本脚本只做单向复制(collect → 比对 → cpSync), **没有 unlink 分支**, 源仓删除不会
// 传播到 open 仓 → open 留下孤儿文件(2026-09-12 实测: 删掉 web/src/components/
// SocialSciVueHost.tsx 后, open 侧仍保留着它, 内容还引用着已被清空的注册链)。
//
// 这里**只检测并警告, 不自动删**。原因: 不能简单地"open 有而 main 没有就删" ——
// open 仓**故意**保留了 400+ 个 main 没有的文件(examples/seed-corpus 语料、
// skills/* 技能包、evaluation/eval-archive), 它们只是不在 DIRS 里、根本不属于同步
// 范围。无脑自动删会把它们从公开仓库一起抹掉。
// 所以先按 DIRS/ROOT_FILES 圈定范围, 再报出来让人来判断; 删除动作由人工执行。
function inSyncScope(rel) {
  return ROOT_FILES.includes(rel) || DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}
let openTracked = [];
try {
  const out = execSync(`git ls-files`, { cwd: OPEN, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  openTracked = out.split("\n").map((s) => s.trim()).filter(Boolean);
} catch { /* open 仓无 git / 读不到 → 跳过检测 */ }
const ghosts = openTracked.filter((rel) => inSyncScope(rel) && !existsSync(path.join(MAIN, rel)));
// 有残留时用独立退出码, 让外部脚本/CI 能感知(原来无论如何都返回 0, 警告只打在
// stdout —— 不盯着终端就等于静默, 2026-09-12 讨论确认这是真实风险)。
// 2 = "同步成功但有残留待人工清理", 与 1 = "同步失败" 区分; 同步本身仍照常完成。
const GHOST_EXIT = 2;
if (ghosts.length) {
  console.log(`\n[sync-open] ⚠️ 检测到 ${ghosts.length} 个「main 已删、open 仍跟踪」的残留(本脚本不自动删):`);
  for (const g of ghosts) console.log(`  D ${g}`);
  console.log(`\n  这些文件在 main 仓已不存在, 但 open 仓仍在跟踪 —— 多半是孤儿代码。`);
  console.log(`  确认无用后手工清理:`);
  console.log(`    cd ${OPEN} && git rm -r -- ${ghosts.slice(0, 3).map((g) => JSON.stringify(g)).join(" ")}${ghosts.length > 3 ? " …" : ""}`);
  console.log(`  (注意: 只在上述范围内报告。examples/、skills/ 等不在 DIRS 里的差异是 open 独有的内容, 不算残留。)\n`);
  console.log(`  → 本次退出码 ${GHOST_EXIT}(有残留); 若无残留为 0.`);
  console.log(`  → 该提示同时写入 open 仓的提交信息, 供事后 git log 追溯。`);
}

// 留痕: 把残留写进提交信息, 这样即使没人盯终端, git log 里也查得到
const GHOST_NOTE = ghosts.length
  ? "\n\n[sync-open 残留提示] open 仓有 " + ghosts.length + " 个文件在 main 已删但仍被跟踪, 需人工清理:\n"
    + ghosts.slice(0, 10).map((g) => "  - " + g).join("\n")
    + (ghosts.length > 10 ? "\n  … 等 " + ghosts.length + " 个" : "")
  : "";

if (DRY) { console.log("[sync-open] --dry-run: 未复制"); process.exit(ghosts.length ? GHOST_EXIT : 0); }
if (changed.length + added.length === 0) { console.log("[sync-open] ✅ open-source 已是最新(无新增/修改)"); process.exit(ghosts.length ? GHOST_EXIT : 0); }

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
    // 用 `-F -` 从 stdin 读消息, 而不是 `-m ${JSON.stringify(...)}`:
    // 后者消息里的换行会被 shell 当字面字符传进 git, 多行提示会显示成一行,
    // 留痕形同失效(2026-09-12 实测)。stdin 方式换行才真的生效。
    execSync(`git commit -F -`, { cwd: OPEN, input: COMMIT_MSG + GHOST_NOTE, stdio: ["pipe", "inherit", "inherit"] });
    console.log(`[sync-open] 已提交 open-source: ${COMMIT_MSG}`);
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
console.log(ghosts.length
  ? `[sync-open] ⚠️ 同步完成, 但有 ${ghosts.length} 个残留待人工清理(退出码 ${GHOST_EXIT})`
  : "[sync-open] ✅ 同步完成");
process.exit(ghosts.length ? GHOST_EXIT : 0);
