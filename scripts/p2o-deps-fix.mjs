#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// p2o-deps-fix.mjs — PDF2Obsidian 依赖修复(一键重建)
// 背景: vendor/pdf2obsidian 是独立 pnpm workspace, 未安装 node_modules。
//   其 dist 产物直接 import 依赖:
//   1. fflate(0.8.3 的 exports 不含 ./index.js, 但 vendor dist 用旧式 import) → 需桥接文件
//   2. @pdf2obsidian/{core,pipeline,providers,tasks}(workspace 包) → 需 junction 链接
//   ⚠ npm install 会清除这两个修复, 重装依赖后必须重跑本脚本。
// 用法: node scripts/p2o-deps-fix.mjs
import { existsSync, mkdirSync, symlinkSync, copyFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { console.error(`  ✗ ${msg}`); process.exitCode = 1; };

console.log(`[p2o-deps-fix] root: ${rootDir}`);

// ── 1. fflate 桥接: node_modules/fflate/index.js → esm/index.mjs ──
const fflateDir = path.join(rootDir, "node_modules", "fflate");
if (!existsSync(fflateDir)) {
  fail("fflate 未安装, 先运行: npm install fflate@0.8.3 --legacy-peer-deps");
} else {
  const esm = path.join(fflateDir, "esm", "index.mjs");
  const bridge = path.join(fflateDir, "index.js");
  if (existsSync(esm)) {
    if (!existsSync(bridge) || readFirstLine(bridge) !== readFirstLine(esm)) {
      copyFileSync(esm, bridge);
      ok(`fflate 桥接创建: node_modules/fflate/index.js`);
    } else {
      ok("fflate 桥接已存在");
    }
  } else {
    fail(`fflate esm/index.mjs 不存在 (${esm})`);
  }
}

// ── 2. @pdf2obsidian workspace 链接 ──
const scopedDir = path.join(rootDir, "node_modules", "@pdf2obsidian");
const pkgs = ["core", "pipeline", "providers", "tasks"];
mkdirSync(scopedDir, { recursive: true });
for (const pkg of pkgs) {
  const link = path.join(scopedDir, pkg);
  const target = path.resolve(rootDir, "vendor", "pdf2obsidian", "packages", pkg);
  if (existsSync(link)) {
    try {
      const stat = require("fs").lstatSync(link);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        ok(`@pdf2obsidian/${pkg} 已链接`);
        continue;
      }
    } catch { /* fallthrough */ }
    require("fs").rmSync(link, { recursive: true, force: true });
  }
  if (!existsSync(target)) {
    fail(`vendor 包不存在: ${target}`);
    continue;
  }
  try {
    symlinkSync(target, link, "junction");
    ok(`@pdf2obsidian/${pkg} → vendor/pdf2obsidian/packages/${pkg} (junction)`);
  } catch (e) {
    fail(`链接失败 @pdf2obsidian/${pkg}: ${e.message}`);
  }
}

// ── 3. 验证 ──
console.log("\n[p2o-deps-fix] 验证:");
let pass = true;
try {
  const { pathToFileURL } = await import("node:url");
  const m = await import(pathToFileURL(path.join(fflateDir, "index.js")).href);
  const hasUnzip = typeof m.unzipSync === "function";
  console.log(`  ${hasUnzip ? "✓" : "✗"} fflate unzipSync: ${hasUnzip ? "可用" : "缺失"}`);
  pass = pass && hasUnzip;
} catch (e) {
  console.error(`  ✗ fflate import 失败: ${e.message}`);
  pass = false;
}
for (const pkg of pkgs) {
  const p = path.join(scopedDir, pkg, "package.json");
  const okPkg = existsSync(p);
  console.log(`  ${okPkg ? "✓" : "✗"} @pdf2obsidian/${pkg} package.json: ${okPkg ? "可用" : "缺失"}`);
  pass = pass && okPkg;
}
console.log(pass ? "\n全部修复完成, OCR 可用。" : "\n部分修复失败, 请检查上方错误。");

function readFirstLine(file) {
  return require("fs").readFileSync(file, "utf8").split("\n")[0];
}
