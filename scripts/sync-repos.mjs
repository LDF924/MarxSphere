#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
/**
 * scripts/sync-repos.mjs — MarxSphere 双仓库文件级同步（非 git 合并）
 *
 * 同步两个平行仓库（方向感知，每目录固定单向，杜绝双向覆盖）：
 *   OPENSOURCE = 开发主线（推 GitHub 的线，V438+ 持续开发提交）
 *   MAIN       = 工作副本 C:/Users/HUAWEI/SAG-main（本地运行/预览，无远端，不提交）
 *
 * 方向定义（2026-08-27 修正: open 是主线）:
 *   开源 → 主仓库:  src/ web/src/ test/ migrations/ electron/ docs/ scripts/ 根配置（主线为准，副本跟随）
 *   主仓库 → 开源:  禁止（副本不能覆盖主线 — 历史教训: 8/26 曾误判 main 领先, 实际 open 一直领先）
 *
 * 用法:
 *   node scripts/sync-repos.mjs             # 双向同步（只有 open→main 有效）
 *   node scripts/sync-repos.mjs --to-main   # 只同步 开源 → 主仓库（主线刷新副本）
 *   node scripts/sync-repos.mjs --to-open   # 报错（禁止, 防止覆盖主线）
 *   node scripts/sync-repos.mjs --dry-run   # 只报告差异不复制（默认显示将要复制的文件）
 *
 * 排除规则（任何方向都不同步）:
 *   - 构建产物: node_modules/ dist/ web/dist/ release/ .cache/ resources/
 *   - 密钥/本地配置: .env* backups/ memory-settings.json *.local.json
 *   - 历史快照: *.v*-ok *.v*-before *.vNN-* *.vNN（SAG-main 开发备份）
 *   - 日志/临时: *.log *.tmp* web-tsc-errors*.txt
 *   - 本地工具配置: .claude/ .obsidian/ memory/
 *   - 内部开发文档（不开源）: HANDOFF-* CHECKLIST PITFALLS TASK_NEXT EXPERIENCE-LOG FIX_SUMMARY BOOK-GAP-ROADMAP V*_STATUS API-INTEGRATION SAG_PIPELINE_CALLGRAPH 问卷*
 *
 * 安全设计:
 *   - 只复制"目标不存在"或"源更新"的文件（mtime 比较），不删除目标多余文件
 *   - 复制前打印差异报告，--dry-run 只预览
 *   - 每个方向复制完成后打印统计
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENSOURCE = path.resolve(__dirname, "..");
const MAIN = "C:/Users/HUAWEI/SAG-main";

// ─── 方向规则：目录 → 源端 ───
// 开源 → 主仓库（代码方向，开源领先）
const DIR_TO_MAIN = new Set(["src", "web/src", "test", "migrations", "electron", "docs", "scripts"]);
// 根级文件：开源 → 主仓库（README/发布脚本等）
const ROOT_TO_MAIN = ["README.md", "README-CN.md", "README-EN.md", "CHANGELOG.md", "BENCHMARK.md", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "CLAUDE.md", "LICENSE", "package.json", "package-lock.json", "docker-compose.yml", "codex-config.toml.example", "tailwind.config.js", "vite.config.ts", "postcss.config.js", "tsconfig.json", "tsconfig.build.json", "electron-builder.yml", "vite.preview.config.ts", "vitest.config.ts", "release.mjs", "sync-repos.mjs", ".github"];

// ─── 排除规则 ───
const EXCLUDE_DIRS = new Set([
  "node_modules", "dist", ".git", ".cache", "release", "resources",
  "backups", ".pipeline", "__pycache__", "data", "examples", ".claude",
  ".obsidian", "memory", "eval-archive", "reports", "evaluation", "knowledge-graph",
  "skills", "vendor", "plugins",
]);
const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", ".vite", ".cache", "__pycache__", ".obsidian", "memory"]);
const EXCLUDE_DIR_PATTERN = [/\.bak-/, /^dist\./];
const EXCLUDE_FILES = [/^\.env/, /\.local\.json$/, /^memory-settings\.json$/, /\.log$/, /^web-tsc-errors/, /^skillify-tracking/, /\.tmp(\.|$)/, /\.v\d+-(ok|before)/, /^node_modules\.zip$/, /\.blockmap$/, /\.bak-/, /\.v\d{2,3}$/, /^run-eval-one-by-one/, /^start(_sag|-web)\./, /^compact-vhdx\.ps1$/, /^cognee_entities_dump\.json$/, /^entity_(id|norm)_map\.json$/, /^paper_id_map\.json$/, /^eval_\d+metrics\.json\.v\d+/, /^eval_32metrics.*\.json$/, /^gold_dataset.*\.json$/, /^judge_results\.json$/, /^isolated_entities\.csv$/, /^batch-ingest-log/];
const EXCLUDE_VSNAP = [/\.v\d{2,3}-/, /\.v\d{2,3}$/];
const EXCLUDE_INTERNAL = [/^HANDOFF-/, /^CHECKLIST\.md$/, /^PITFALLS_/, /^TASK_NEXT\.md$/, /^EXPERIENCE-LOG-/, /^FIX_SUMMARY_/, /^BOOK-GAP-ROADMAP\.md$/, /^V\d+_STATUS\.md$/, /^API-INTEGRATION\.md$/, /^SAG_PIPELINE_CALLGRAPH\.md$/, /^问卷/, /^cross_judge_report/, /^failure_report/, /^kappa_report/, /^prompt_regression_report/, /^significance_report/, /^skill-audit-report/, /^tp_report/];

function shouldExcludeDir(name) {
  return EXCLUDE_DIRS.has(name) || EXCLUDE_DIR_NAMES.has(name) || EXCLUDE_DIR_PATTERN.some((re) => re.test(name));
}

function shouldExcludeFile(name) {
  return EXCLUDE_FILES.some((re) => re.test(name)) || EXCLUDE_VSNAP.some((re) => re.test(name)) || EXCLUDE_INTERNAL.some((re) => re.test(name));
}

// ─── 收集文件清单（相对路径 + 内容 hash） ───
function collectFiles(dir, base = "", out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldExcludeDir(entry.name)) continue;
      collectFiles(abs, rel, out);
    } else {
      if (shouldExcludeFile(entry.name)) continue;
      const hash = createHash("sha1").update(readFileSync(abs)).digest("hex");
      out.push({ rel, abs, hash });
    }
  }
  return out;
}

// ─── 计算差异：内容 hash 不同 → 需要复制（方向固定，源为准） ───
function diffFiles(srcFiles, dstRoot) {
  const dstFiles = new Map(collectFiles(dstRoot).map((f) => [f.rel, f.hash]));
  return srcFiles
    .filter((f) => !dstFiles.has(f.rel) || dstFiles.get(f.rel) !== f.hash)
    .map((f) => ({ rel: f.rel, src: f.abs, dst: path.join(dstRoot, f.rel) }));
}

// ─── 复制（带目录创建） ───
function copyFile(f) {
  const dir = path.dirname(f.dst);
  if (!existsSync(dir)) {
    // 逐级创建缺失目录
    const stack = [];
    let cur = dir;
    while (!existsSync(cur) && cur !== path.dirname(cur)) {
      stack.unshift(cur);
      cur = path.dirname(cur);
    }
    for (const d of stack) mkdirSync(d, { recursive: true });
  }
  cpSync(f.src, f.dst, { force: true });
}

// ─── 按方向收集源文件（只收该方向的文件） ───
function collectDirection(srcRoot, dstRoot, dirAllowlist, rootAllowlist) {
  const srcFiles = collectFiles(srcRoot);
  return srcFiles.filter((f) => {
    const parts = f.rel.split("/");
    if (parts.length === 1) {
      // 根级：只同步 allowlist 内的
      return rootAllowlist ? rootAllowlist.includes(f.rel) : false;
    }
    // 目录级：前缀匹配（web/src 下的文件 top 是 web/src/components，需匹配 web/src 前缀）
    const dirPath = parts.slice(0, -1).join("/");
    return dirAllowlist ? [...dirAllowlist].some((d) => dirPath === d || dirPath.startsWith(d + "/")) : false;
  });
}

// ─── 主流程 ───
const args = process.argv.slice(2);
const toOpen = args.includes("--to-open");
const toMain = args.includes("--to-main");
const dryRun = args.includes("--dry-run");
const checkMode = args.includes("--check");
const both = !toOpen && !toMain && !checkMode;

// 2026-08-27: 主线保护 — 禁止 副本→主线（历史教训: 曾误判方向, 差点覆盖主线）
if (toOpen) {
  console.error("❌ 已禁止 --to-open: SAG-main 是工作副本, 不能覆盖主线 SAG-open-source（防止覆盖开发成果）");
  process.exit(1);
}

// ─── 2026-08-27: package.json 版本保护 — 同步时保留"更高版本"（历史教训: main 的 0.1.0 覆盖 open 的 1.0.0）───
// 规则: 源与目标 version 不同时, 保留版本号更大的（防止旧版本号覆盖新版本号, 双向都保护）
function protectVersion(srcPath) {
  if (!srcPath.endsWith("package.json")) return;
  try {
    const pkg = JSON.parse(readFileSync(srcPath, "utf8"));
    const dstPath = srcPath.includes(OPENSOURCE) ? path.join(MAIN, "package.json") : path.join(OPENSOURCE, "package.json");
    if (existsSync(dstPath)) {
      const dst = JSON.parse(readFileSync(dstPath, "utf8"));
      if (pkg.version !== dst.version) {
        const verNum = (v) => String(v || "").split(".").map((n) => parseInt(n, 10) || 0);
        const cmp = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] - y[i]; } return 0; };
        if (cmp(pkg.version, dst.version) < 0) {
          console.warn(`⚠️ package.json 版本保护: 源 ${pkg.version} < 目标 ${dst.version} — 保留更高版本 ${dst.version}`);
          pkg.version = dst.version;
          writeFileSync(srcPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
        }
      }
    }
  } catch { /* 保护失败不阻塞 */ }
}

// ─── 2026-08-27: 同步后自动校验 — 确认目标端不丢文件(历史教训: 方向反了覆盖 V4xx 修复都没发现) ───
function verifySync(dstRoot, label) {
  console.log(`\n[校验] ${label} 后一致性检查:`);
  let checked = 0, diff = 0;
  for (const f of collectFiles(dstRoot)) {
    const srcPath = path.join(OPENSOURCE, f.rel);
    if (existsSync(srcPath)) {
      const h1 = createHash("sha1").update(readFileSync(srcPath)).digest("hex");
      const h2 = createHash("sha1").update(readFileSync(f.abs)).digest("hex");
      checked++;
      if (h1 !== h2) { diff++; console.error(`  ✗ ${f.rel} 不一致`); }
    }
  }
  if (diff === 0) console.log(`  ✅ ${checked} 个文件全部与主线一致`);
  else console.error(`  ⚠️ ${diff}/${checked} 个文件与主线不一致 — 需人工检查!`);
  return diff;
}

function sync(srcRoot, dstRoot, label, dirAllowlist, rootAllowlist) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`${label}`);
  console.log(`${"═".repeat(60)}`);
  const srcFiles = collectDirection(srcRoot, dstRoot, dirAllowlist, rootAllowlist);
  const pending = diffFiles(srcFiles, dstRoot);
  if (pending.length === 0) {
    console.log("无差异，跳过");
    return { copied: 0, skipped: 0 };
  }
  const byDir = new Map();
  for (const f of pending) {
    const dir = f.rel.split("/").slice(0, -1).join("/") || "(root)";
    byDir.set(dir, (byDir.get(dir) || 0) + 1);
  }
  console.log(`将同步 ${pending.length} 个文件：`);
  for (const [dir, count] of [...byDir.entries()].sort()) console.log(`  ${dir}: ${count}`);
  if (dryRun) {
    console.log("(--dry-run 预览，未复制)");
    return { copied: 0, skipped: pending.length };
  }
  let copied = 0;
  for (const f of pending) {
    try {
      protectVersion(f.src);
      copyFile(f); copied++;
    } catch (e) { console.error(`  ✗ ${f.rel}: ${e.message}`); }
  }
  console.log(`✅ 已复制 ${copied}/${pending.length}`);
  // 同步后自动校验（防"覆盖了不知道"）
  verifySync(dstRoot, label);
  return { copied, skipped: pending.length - copied };
}

// ─── 2026-08-27: --check 模式 — 只报告两仓库差异, 不复制（每次开发前跑一次） ───
if (checkMode) {
  console.log("\n" + "═".repeat(60));
  console.log("差异检测 (--check): 主线 vs 工作副本");
  console.log("═".repeat(60));
  const mainFiles = collectDirection(MAIN, OPENSOURCE, DIR_TO_MAIN, ROOT_TO_MAIN);
  const openFiles = collectDirection(OPENSOURCE, MAIN, DIR_TO_MAIN, ROOT_TO_MAIN);
  const openMap = new Map(openFiles.map((f) => [f.rel, f.hash]));
  const mainMap = new Map(mainFiles.map((f) => [f.rel, f.hash]));
  let diffCount = 0;
  // 主线有 副本没有/不同
  for (const f of openFiles) {
    if (!mainMap.has(f.rel) || mainMap.get(f.rel) !== f.hash) {
      if (diffCount < 30) console.log(`  ⚠️ 副本落后: ${f.rel}`);
      diffCount++;
    }
  }
  // 副本有 主线没有
  for (const f of mainFiles) {
    if (!openMap.has(f.rel)) {
      if (diffCount < 30) console.log(`  ⚠️ 副本独有: ${f.rel} (检查是否需补到主线)`);
      diffCount++;
    }
  }
  if (diffCount === 0) console.log("  ✅ 两仓库完全一致 (代码目录)");
  else console.log(`\n  ${diffCount} 处差异 — 副本落后则跑 sync-repos.mjs 刷新, 副本独有需人工判断`);
  process.exit(0);
}

if (both || toMain) sync(OPENSOURCE, MAIN, "同步: 开源仓库(主线) → 主仓库(工作副本)", DIR_TO_MAIN, ROOT_TO_MAIN);

console.log(`\n完成。${dryRun ? "预览模式，未做任何修改" : "同步结束 — 建议跑 typecheck + 测试验证"}`);
