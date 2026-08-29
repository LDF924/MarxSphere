#!/usr/bin/env npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// scripts/doc-sync.ts — 文档数字自动审计与更新(V393, 2026-08-30)
// 功能:
//   1. 自动统计代码实际数字: 测试数/迁移数/教育路由/顶层路由/Agent工具/视图工具/前端视图/科研场景/服务文件
//   2. 正则替换 README×3 + docs/ARCHITECTURE.md + AGENTS.md 中的过时数字
//   3. 差异报告: 列出每个文件的替换点(无差异 = 全同步)
// 用法:
//   npx tsx scripts/doc-sync.ts          # 统计+替换+报告
//   npx tsx scripts/doc-sync.ts --check  # 只报告差异不替换(CI/计划任务用)
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_ONLY = process.argv.includes("--check");

function sh(cmd: string): string {
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", shell: "cmd", timeout: 300_000 }).trim(); }
  catch { return ""; }
}

// ─── 1. 统计实际数字(Node 原生递归, 避免 findstr 路径问题) ───
function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (name.includes("node_modules") || name.includes(".vite") || name.includes("dist") || name === ".claude") continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p, exts));
      else if (exts.some((e) => name.endsWith(e))) out.push(p);
    }
  } catch { /* 目录不存在跳过 */ }
  return out;
}
function countIn(files: string[], re: RegExp, uniq = false): number {
  const hits: string[] = [];
  for (const f of files) {
    try {
      const content = readFileSync(f, "utf8");
      for (const m of content.match(re) || []) hits.push(m);
    } catch { /* 跳过 */ }
  }
  return uniq ? new Set(hits).size : hits.length;
}

const STATS = {
  tests: parseInt(sh(`npm test 2>&1 | findstr "Tests"`).match(/(\d+)\s+passed/)?.[1] || "0", 10),
  migrations: countIn(walk(path.join(ROOT, "migrations"), [".sql"]), /^/m) || readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).length,
  eduRoutes: countIn([path.join(ROOT, "src/api/server.ts")], /app\.(get|post|put|delete|patch)\("\/api\/education/g),
  topRoutes: countIn([path.join(ROOT, "src/api/server.ts")], /app\.(get|post|put|delete|patch)\("\/api\/(learning-plans|materials|generations|memory|components|llm\/circuit)/g),
  agentTools: countIn([path.join(ROOT, "src/services/agent-tool-router.ts")], /name: "/g),
  viewTools: countIn([path.join(ROOT, "src/services/agent-view-tools.ts")], /name: "/g),
  views: countIn([path.join(ROOT, "web/src/App.tsx")], /workspaceView === "[a-z-]+"/g, true),
  scenarios: countIn([path.join(ROOT, "web/src/components/ScenariosPanel.tsx")], /"S\d{2}"/g, true),
  services: readdirSync(path.join(ROOT, "src/services")).filter((f) => f.endsWith(".ts") && !/\.v\d+/.test(f)).length,
};

const totals = {
  tools: STATS.agentTools + STATS.viewTools,
  routes: STATS.eduRoutes + STATS.topRoutes,
  services: STATS.services,
};

console.log("[doc-sync] 实际数字:");
console.log(`  测试 ${STATS.tests} · 迁移 ${STATS.migrations} · 教育路由 ${STATS.eduRoutes} + 顶层 ${STATS.topRoutes}`);
console.log(`  工具 ${STATS.agentTools} Agent + ${STATS.viewTools} 视图 = ${totals.tools} · 视图 ${STATS.views} · 场景 ${STATS.scenarios} · 服务 ${STATS.services}`);

// ─── 2. 定义替换规则(文件 → [old, new][]) ───
interface Rule { re: RegExp; to: string; label: string; }
const RULES: Array<{ file: string; rules: Rule[] }> = [
  { file: "README.md", rules: [
    { re: /tests-\d+%20passed/g, to: `tests-${STATS.tests}%20passed`, label: "badge 测试数" },
    { re: /\d+ 项单元测试全绿/g, to: `${STATS.tests} 项单元测试全绿`, label: "测试数" },
    { re: /单元测试（\d+ 项）/g, to: `单元测试（${STATS.tests} 项）`, label: "测试数(目录)" },
    { re: /npm test\s+# \d+ 项单元测试/g, to: `npm test                # ${STATS.tests} 项单元测试`, label: "测试数(命令)" },
    { re: /\d+ 工具矩阵/g, to: `${totals.tools} 工具矩阵`, label: "工具矩阵" },
    { re: /\d+ 工具自主调度/g, to: `${totals.tools} 工具自主调度`, label: "工具调度" },
    { re: /\d+ 个 Agent 工具/g, to: `${STATS.agentTools} 个 Agent 工具`, label: "Agent 工具数" },
    { re: /合计 \d+）/g, to: `合计 ${totals.tools}）`, label: "工具合计" },
    { re: /\d+ 教育路由/g, to: `${STATS.eduRoutes} 教育路由`, label: "教育路由" },
  ]},
  { file: "README-CN.md", rules: [
    { re: /tests-\d+%20passed/g, to: `tests-${STATS.tests}%20passed`, label: "badge 测试数" },
    { re: /\d+ 项单元测试全绿/g, to: `${STATS.tests} 项单元测试全绿`, label: "测试数" },
    { re: /单元测试（\d+ 项）/g, to: `单元测试（${STATS.tests} 项）`, label: "测试数(目录)" },
    { re: /npm test\s+# \d+ 项单元测试/g, to: `npm test                # ${STATS.tests} 项单元测试`, label: "测试数(命令)" },
    { re: /\d+ 工具矩阵/g, to: `${totals.tools} 工具矩阵`, label: "工具矩阵" },
    { re: /\d+ 工具自主调度/g, to: `${totals.tools} 工具自主调度`, label: "工具调度" },
    { re: /\d+ 个 Agent 工具/g, to: `${STATS.agentTools} 个 Agent 工具`, label: "Agent 工具数" },
    { re: /合计 \d+）/g, to: `合计 ${totals.tools}）`, label: "工具合计" },
    { re: /\d+ 教育路由/g, to: `${STATS.eduRoutes} 教育路由`, label: "教育路由" },
  ]},
  { file: "README-EN.md", rules: [
    { re: /tests-\d+%20passed/g, to: `tests-${STATS.tests}%20passed`, label: "badge 测试数" },
    { re: /Unit tests.: \d+ green/g, to: `Unit tests: ${STATS.tests} green`, label: "测试数" },
    { re: /\d+-tool dispatch/g, to: `${totals.tools}-tool dispatch`, label: "工具调度" },
    { re: /\d+ Agent tools/g, to: `${STATS.agentTools} Agent tools`, label: "Agent 工具数" },
    { re: /= \d+\)/g, to: `= ${totals.tools})`, label: "工具合计" },
    { re: /\d+-tool matrix/g, to: `${totals.tools}-tool matrix`, label: "工具矩阵" },
  ]},
  { file: "docs/ARCHITECTURE.md", rules: [
    { re: /(\d+) 服务文件/g, to: `${STATS.services} 服务文件`, label: "服务文件" },
    { re: /(\d+) 迁移/g, to: `${STATS.migrations} 迁移`, label: "迁移数" },
    { re: /(\d+) 前端视图/g, to: `${STATS.views} 前端视图`, label: "视图数" },
    { re: /(\d+) 测试/g, to: `${STATS.tests} 测试`, label: "测试数" },
    { re: /(\d+) 教育路由/g, to: `${STATS.eduRoutes} 教育路由`, label: "教育路由" },
  ]},
  { file: "AGENTS.md", rules: [
    { re: /单元测试（\d+ 项, Vitest）/g, to: `单元测试（${STATS.tests} 项, Vitest）`, label: "测试数" },
    { re: /(\d+) 项单元测试（Vitest）/g, to: `${STATS.tests} 项单元测试（Vitest）`, label: "测试数" },
    { re: /(\d+) 项全绿/g, to: `${STATS.tests} 项全绿`, label: "测试数" },
    { re: /(\d+) 教育路由/g, to: `${STATS.eduRoutes} 教育路由`, label: "教育路由" },
  ]},
];

// ─── 3. 执行替换 ───
let totalChanges = 0;
for (const entry of RULES) {
  const filePath = path.join(ROOT, entry.file);
  let content: string;
  try { content = readFileSync(filePath, "utf8"); } catch { continue; }
  let changed = 0;
  for (const rule of entry.rules) {
    const matches = content.match(rule.re);
    if (matches && matches.length > 0) {
      const after = content.replace(rule.re, rule.to);
      if (after !== content) {  // 只在内容真正变化时计数(避免把已正确数字重复替换成同样值)
        content = after;
        changed += matches.length;
      }
    }
  }
  if (changed > 0) {
    totalChanges += changed;
    console.log(`[doc-sync] ${entry.file}: ${changed} 处更新(${entry.rules.filter((r) => r.re.test(content) === false && content.includes(r.to)).map((r) => r.label).join(", ") || "见 diff"})`);
    if (!CHECK_ONLY) writeFileSync(filePath, content, "utf8");
  } else {
    console.log(`[doc-sync] ${entry.file}: ✅ 已同步`);
  }
}
console.log(totalChanges > 0
  ? `[doc-sync] ${CHECK_ONLY ? "发现" : "已更新"} ${totalChanges} 处过时数字`
  : "[doc-sync] ✅ 所有文档数字与代码一致");
process.exit(totalChanges > 0 && CHECK_ONLY ? 1 : 0);
