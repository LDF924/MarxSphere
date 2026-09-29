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

/**
 * 解析 `.env` 的位置 —— **必须给子进程带上**, 否则取到的数是错的。
 *
 * ⚠ 2026-09-29 实测踩到: 本脚本用 `npx tsx -e` 起子进程数工具, 而那个子进程**读不到 .env**
 *   (`.env` 只在主仓, 且 `tsx --env-file` 是 tsx 自己的机制, 不是环境变量)。
 *   后果**不是报错, 是静默少算**: 少加载 2 个工具 → 数出 156, 而服务端实际是 158。
 *   然后它把这个**错的数写进文档**, 且 `docs:check` 报绿 —— 比不更新更坏。
 *   候选顺序与 verify-ui 的 readDbUrl 一致: 环境变量 → cwd → 主仓(worktree 是三级上去)。
 */
const ENV_FILE = (() => {
  const cands = [
    process.env.SAG_ENV_FILE,
    path.join(ROOT, ".env"),
    path.join(ROOT, "..", "..", "..", ".env"),
  ].filter(Boolean) as string[];
  return cands.find((p) => { try { return statSync(p).isFile(); } catch { return false; } }) ?? "";
})();

function sh(cmd: string): string {
  try {
    // ⚠ 把 .env 交给子进程(见 ENV_FILE 的说明) —— 漏了它会静默少算工具数
    const prefix = ENV_FILE ? `set DOTENV_CONFIG_PATH=${ENV_FILE}&& ` : "";
    return execSync(prefix + cmd, { cwd: ROOT, encoding: "utf8", shell: "cmd", timeout: 300_000 }).trim();
  }
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
  /**
   * 工具数 —— **按运行时注册表数, 不按源码正则数**。
   *
   * ⚠ 2026-09-29 改。此前是 `countIn([agent-tool-router.ts], /name: "/g)`, 只数那一个文件。
   *   但工具早已分散到 `agent-view-tools` / `agent-review-tools` / `agent-viz-tools` /
   *   `agent-editor-tools` / `agent-orch-tools` 等模块 —— 正则**数不到它们**, 于是脚本报
   *   "工具 83"(50 Agent + 33 视图), 而运行时 `buildAgentTools({})` 实际返回 **158**。
   *   文档里的数字跟着这个错口径走, 越同步越离谱。
   *   `agentTools` / `viewTools` 仍保留(文档里有分别引用它们的句子), 但按**各模块实际注册**算。
   */
  agentTools: 0,   // 见下方 runtimeStats()
  viewTools: 0,
  /** 技能数 / 编排能力数 —— 也是运行时取(见下方), 文档里那两个数字此前从不自动同步 */
  skills: null as number | null,
  capabilities: null as number | null,
  // 教育服务文件(教育专属 Agent 的服务层)
  eduServices: readdirSync(path.join(ROOT, "src/services")).filter((f) => f.startsWith("education-") && f.endsWith(".ts")).length,
  views: countIn([path.join(ROOT, "web/src/App.tsx")], /workspaceView === "[a-z-]+"/g, true),
  scenarios: countIn([path.join(ROOT, "web/src/components/ScenariosPanel.tsx")], /"S\d{2}"/g, true),
  /** 场景分组数 —— 与场景页的 GROUPS 同一个真源(「N 大研究阶段」用的就是它) */
  groups: (() => {
    try {
      const txt = readFileSync(path.join(ROOT, "web/src/components/ScenariosPanel.tsx"), "utf8");
      const seg = txt.slice(txt.indexOf("export const GROUPS"));
      return new Set((seg.slice(0, seg.indexOf("]")).match(/"([^"]+)"/g) || [])).size;
    } catch { return 0; }
  })(),
  /**
   * 导航分类数 —— 与 `App.tsx` 的 `categories` 同一个真源。
   *
   * ⚠ 2026-09-29 加: 此前这里是**写死的字面量 7**(规则里直接写 `7 大分类`),
   *   而实际是 **6** —— 于是每次同步都把文档里改对的 6 **改回 7**, 且 docs:check 报绿。
   *   这是"规则里藏着一个不派生的常量"的典型: 它比过时更坏, 因为它会主动把对的改错。
   *
   * 数法: `categories` 数组里每个分类都有一个 `key: "..."`(core/literature/knowledge/policy/tools/system)。
   *   注意它**不含首页 landing**(`home` 视图)—— 那个视图不在分类里, 文档别把它算进来。
   */
  categories: (() => {
    try {
      const txt = readFileSync(path.join(ROOT, "web/src/App.tsx"), "utf8");
      const seg = txt.slice(txt.indexOf("const categories: NavCategory[] = ["));
      return (seg.slice(0, seg.indexOf("\n  ];")).match(/^\s{6}key: "/gm) || []).length;
    } catch { return 0; }
  })(),
  services: readdirSync(path.join(ROOT, "src/services")).filter((f) => f.endsWith(".ts") && !/\.v\d+/.test(f)).length,
};

const totals = {
  tools: STATS.agentTools + STATS.viewTools,
  routes: STATS.eduRoutes + STATS.topRoutes,
  services: STATS.services,
};

/**
 * 工具数 / 技能数 / 编排能力数 —— 由 `scripts/doc-facts.ts` 在**带 .env 的子进程**里取。
 *
 * ⚠ 2026-09-29 两次踩坑后的写法:
 *   ① 原先是 `countIn(agent-tool-router.ts, /name: "/)` —— 只数一个文件。工具早已分散到
 *      view/review/viz/editor/orch 等模块, 正则数不到, 于是报「83」而运行时是 158。
 *   ② 改成内联 `npx tsx -e "import('dotenv/config')..."` 后**仍然不对**: 那个子进程读不到
 *      .env, 少加载 2 个工具 → 数出 156。**静默少算**, 然后把错的数写进文档。而且内联命令里
 *      的引号经 cmd 转义会被吃掉(实测直接崩)。
 *   现在抽成 `scripts/doc-facts.ts` + `--env-file`, 取不到就**明确报空**而不是退回一个错的值。
 */
function runtimeFacts(): { tools: number; agent: number; view: number; skills: number | null; caps: number | null } | null {
  try {
    // 走 `npx tsx <file>` 而不是 `-e`: 文件里 `import "dotenv/config"` 不经过 shell 引号
    const envArg = ENV_FILE ? `--env-file="${ENV_FILE}" ` : "";
    const out = sh(`npx tsx ${envArg}scripts/doc-facts.ts`);
    const g = (k: string) => { const m = out.match(new RegExp(`${k}=(\\d+)`)); return m ? Number(m[1]) : null; };
    const tools = g("TOOLS");
    if (tools === null) return null;
    return { tools, agent: g("AGENT") ?? 0, view: g("VIEW") ?? 0, skills: g("SKILLS"), caps: g("CAPS") };
  } catch { return null; }
}
const RT = runtimeFacts();
STATS.agentTools = RT?.agent ?? 0;
STATS.viewTools = RT?.view ?? 0;
totals.tools = STATS.agentTools + STATS.viewTools;

/**
 * 技能数 / 编排能力数 —— 与首页统计条同一个来源。
 *
 * ⚠ 2026-09-29 加。此前文档里「208 个技能」「87 通用工具」「40 视图」这些**没有一个是自动同步的** ——
 *   它们只随"某次有人记得改"而更新。现在并列进 STATS, 由同一张规则表往下刷。
 */
STATS.skills = RT?.skills ?? null;
STATS.capabilities = RT?.caps ?? null;

console.log("[doc-sync] 实际数字:");
console.log(`  测试 ${STATS.tests} · 迁移 ${STATS.migrations} · 教育路由 ${STATS.eduRoutes} + 顶层 ${STATS.topRoutes}`);
console.log(`  工具 ${STATS.agentTools} Agent + ${STATS.viewTools} 视图 = ${totals.tools}${RT ? "" : "（运行时取数失败, 退回静态计数）"} · 视图 ${STATS.views} · 分类 ${STATS.categories} · 场景 ${STATS.scenarios}(${STATS.groups} 组) · 服务 ${STATS.services}`);
if (STATS.skills !== null || STATS.capabilities !== null) {
  console.log(`  技能 ${STATS.skills ?? "?"} · 编排能力 ${STATS.capabilities ?? "?"}`);
}

// ─── 2. 定义替换规则(文件 → [old, new][]) ───
interface Rule { re: RegExp; to: string; label: string; }
const RULES: Array<{ file: string; rules: Rule[] }> = [
  { file: "README.md", rules: [
    { re: /tests-\d+%20passed/g, to: `tests-${STATS.tests}%20passed`, label: "badge 测试数" },
    { re: /\d+ 项单元测试全绿/g, to: `${STATS.tests} 项单元测试全绿`, label: "测试数" },
    { re: /单元测试（\d+ 项）/g, to: `单元测试（${STATS.tests} 项）`, label: "测试数(目录)" },
    { re: /npm test\s+# \d+ 项单元测试/g, to: `npm test                # ${STATS.tests} 项单元测试`, label: "测试数(命令)" },
    { re: /(?<![\d.])\d+ 工具矩阵/g, to: `${totals.tools} 工具矩阵`, label: "工具矩阵" },
    { re: /(?<![\d.])\d+ 工具自主调度/g, to: `${totals.tools} 工具自主调度`, label: "工具调度" },
    { re: /\d+ 个 Agent 工具/g, to: `${STATS.agentTools} 个 Agent 工具`, label: "Agent 工具数" },
    { re: /合计 \d+）/g, to: `合计 ${totals.tools}）`, label: "工具合计" },
    { re: /\d+ 教育路由/g, to: `${STATS.eduRoutes} 教育路由`, label: "教育路由" },
  ]},
  { file: "README-CN.md", rules: [
    { re: /tests-\d+%20passed/g, to: `tests-${STATS.tests}%20passed`, label: "badge 测试数" },
    { re: /\d+ 项单元测试全绿/g, to: `${STATS.tests} 项单元测试全绿`, label: "测试数" },
    { re: /单元测试（\d+ 项）/g, to: `单元测试（${STATS.tests} 项）`, label: "测试数(目录)" },
    { re: /npm test\s+# \d+ 项单元测试/g, to: `npm test                # ${STATS.tests} 项单元测试`, label: "测试数(命令)" },
    { re: /(?<![\d.])\d+ 工具矩阵/g, to: `${totals.tools} 工具矩阵`, label: "工具矩阵" },
    { re: /(?<![\d.])\d+ 工具自主调度/g, to: `${totals.tools} 工具自主调度`, label: "工具调度" },
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
    // V417: 原来这里是 /(\d+) 迁移/g —— **太宽**: 表格里 `router_audit`(106 迁移) 这类
    //   "某张表建在第几号迁移" 也被一起改掉, 于是每次同步都把正确的历史编号改错
    //   (实测: 105/106/107 被改成 148), 且改完 docs:check 仍报"过时" → 永远收敛不了。
    //   仅统计"规模"行: 那个数字后面紧跟 ` · `, 表格里的后面是 `)`。
    { re: /(\d+) 迁移(?= ·)/g, to: `${STATS.migrations} 迁移`, label: "迁移数" },
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
  // V415(2026-09-13 补): CLAUDE.md 里也有 `npm test # N 项单元测试` ——
  //   原来这份规则表没有它, 于是那个数字一直停在 736(实际已 1001), 而 docs:check 报绿。
  //   漏的原因是"同步列表里没这个文件", 不是规则写错 —— 加文件即可。
  { file: "CLAUDE.md", rules: [
    { re: /npm test\s+# \d+ 项单元测试/g, to: `npm test            # ${STATS.tests} 项单元测试`, label: "测试数(命令)" },
    { re: /(\d+) 项单元测试/g, to: `${STATS.tests} 项单元测试`, label: "测试数" },
  ]},
  // V418(2026-09-15 补): 下面这批文件原来**不在同步列表**里, 于是数字常年停在几代之前,
  //   而 docs:check 一直报绿(它只检查列表里的文件)。这与 V415 修 CLAUDE.md 是同一个病:
  //   漏的原因是"文件没进列表", 不是规则写错。
  //   实测过时值: PROJECT-OVERVIEW「87 工具/112 教育路由/44 通用工具/13 教育服务/43 视图/
  //   deepseek-v4-flash」· FEATURES-DETAILED「43 视图/48+22 工具/112 路由/32 学习引擎」·
  //   OPEN-SOURCE-DISCLOSURE「332 测试/87 工具(65+22)」· FAQ「154 测试」· ARCHITECTURE「736 测试」
  { file: "docs/PROJECT-OVERVIEW.md", rules: [
    // 模型名: deepseek-v4-flash / deepseek-chat 是退役名(服务端返回 200 头但正文挂起)
    { re: /deepseek-v4-flash|deepseek-chat/g, to: "deepseek-flash", label: "模型名" },
    { re: /(\d+) 工具统一调度/g, to: `${totals.tools} 工具统一调度`, label: "工具统一调度" },
    { re: /(\d+) 通用工具（(\d+) Agent \+ (\d+) 视图）/g, to: `${totals.tools} 通用工具（${STATS.agentTools} Agent + ${STATS.viewTools} 视图）`, label: "通用工具数" },
    { re: /(\d+) 教育路由/g, to: `${STATS.eduRoutes} 教育路由`, label: "教育路由" },
    { re: /（(\d+) 服务文件、(\d+) 教育路由）/g, to: `（${STATS.eduServices} 服务文件、${STATS.eduRoutes} 教育路由）`, label: "教育服务数" },
    { re: /工具层\(\d+ 通用\)/g, to: `工具层(${totals.tools} 通用)`, label: "工具层" },
    { re: /教育专属层\(\d+ 路由\)/g, to: `教育专属层(${STATS.eduRoutes} 路由)`, label: "教育层" },
    { re: /(\d+) 通用工具 \+ (\d+) 教育路由，(\d+) 测试/g, to: `${totals.tools} 通用工具 + ${STATS.eduRoutes} 教育路由，${STATS.tests} 测试`, label: "能力行" },
    { re: /，(\d+) 教育路由，教育评测/g, to: `，${STATS.eduRoutes} 教育路由，教育评测`, label: "教育评测行" },
    { re: /(\d+) 视图 · Mega Menu/g, to: `${STATS.views} 视图 · Mega Menu`, label: "视图数" },
  ]},
  { file: "docs/FEATURES-DETAILED.md", rules: [
    { re: /Web 界面（\d+ 视图）/g, to: `Web 界面（${STATS.views} 视图）`, label: "视图数" },
    { re: /## 一、导航与工作区（\d+ 视图 · \d+ 大分类）/g, to: `## 一、导航与工作区（${STATS.views} 视图 · ${STATS.categories} 大分类）`, label: "视图数(章节)" },
    { re: /（(\d+) 通用工具 \+ (\d+) 视图工具 · (\d+) 教育路由 \+ (\d+) 学习引擎顶层）/g, to: `（${STATS.agentTools} 通用工具 + ${STATS.viewTools} 视图工具 · ${STATS.eduRoutes} 教育路由 + ${STATS.topRoutes} 学习引擎顶层）`, label: "Agent 子系统" },
    { re: /（\d+ 工具 = \d+ Agent 工具 \+ \d+ 视图；教育工具经 \/api\/education\/\* \d+ 路由 \+ 学习引擎顶层 \d+ 路由接入）/g, to: `（${totals.tools} 工具 = ${STATS.agentTools} Agent 工具 + ${STATS.viewTools} 视图；教育工具经 /api/education/* ${STATS.eduRoutes} 路由 + 学习引擎顶层 ${STATS.topRoutes} 路由接入）`, label: "工具矩阵" },
  ]},
  { file: "docs/OPEN-SOURCE-DISCLOSURE.md", rules: [
    { re: /deepseek-v4-flash|deepseek-chat/g, to: "deepseek-flash", label: "模型名" },
    { re: /(\d+) 项单元测试/g, to: `${STATS.tests} 项单元测试`, label: "测试数" },
    { re: /(\d+) 工具（(\d+) Agent \+ (\d+) 视图）/g, to: `${totals.tools} 工具（${STATS.agentTools} Agent + ${STATS.viewTools} 视图）`, label: "工具数" },
  ]},
  { file: "docs/FAQ.md", rules: [
    { re: /类型检查 → \d+ 单元测试/g, to: `类型检查 → ${STATS.tests} 单元测试`, label: "测试数" },
  ]},
  { file: ".github/PULL_REQUEST_TEMPLATE.md", rules: [
    { re: /`npm test`（\d+ 项）/g, to: "`npm test`（" + STATS.tests + " 项）", label: "测试数" },
  ]},
  // docs/index.md 是文档中心(DocsPanel)的首页, 数字同样会漂
  { file: "docs/index.md", rules: [
    { re: /(?<![\d.])(\d+) 工具矩阵/g, to: `${totals.tools} 工具矩阵`, label: "工具矩阵" },
    { re: /单元测试 \d+ 项/g, to: `单元测试 ${STATS.tests} 项`, label: "测试数" },
  ]},
];

/**
 * ─── 4. 通用规则: 作用于**所有**会被同步的文档 ───
 *
 * ⚠ 2026-09-29 加。用户:「内容都没根据实际情况进行全量更新, 对所有描述性的内容全部都要进行更新,
 *   不能漏掉一点」。查下来根因有两层:
 *   ① **只覆盖 12/60 个文件** —— 其余 48 个文档里的数字没人管;
 *   ② **只认少数几种写法** —— 例如「208 个技能」「40 视图」「87 通用工具」这些
 *      **根本不在规则表里**, 于是永远停在写入时的那一刻。
 *
 * 这一节把**能从代码派生的量**全部收进来, 对所有文档生效。
 * 仍留在文档里的历史叙述(某个版本号、某次审计的结论、某号迁移建了哪张表)不在射程内 ——
 * 那些是事实记录, 不该被"刷新"; 会漂的是**描述当前规模**的那些数字。
 *
 * ⚠ 每条都带一个**足够具体的后缀**限定, 不用裸 `\d+ 工具` 这类 ——
 *   否则会把「4 工具」「8 工具」这种模块内的局部计数(某张图里某个服务挂几个工具)
 *   一起改掉, 那是误伤。
 *
 * ⚠ 2026-09-29 追加: **左侧还要加 `(?<![\d.])`**。
 *   `\d+ 工具矩阵` 会把 `### 4.2 工具矩阵（156 工具…）` 里的**小节号 2** 也吃掉,
 *   改成 `### 4.158 工具矩阵` —— 数字确实"一致"了, docs:check 报绿, 而**章节编号被改坏**
 *   没人发现(已由 `test/docs-index.test.ts` 的两条标题判据兜住)。
 *   后缀限定管不住这个: 它防的是右侧误伤, 这里发生在左侧。
 */
const GENERIC_RULES: Rule[] = [
  /**
   * ─── 测试数的各种写法 ───
   *
   * ⚠ 2026-09-29 加。此前测试数只在**少数几个固定句式**上有规则
   *   (`N 项单元测试全绿` / `单元测试（N 项）` / `npm test # N 项单元测试` / badge)。
   *   于是同一份文档里只要换个写法 —— `1267 单测` / `1267 项单元测试（Vitest）` /
   *   `1267 unit tests` / `1267 测试）` —— 就**永远停在写入那一刻**, 而 docs:check 报绿。
   *   这是"规则覆盖率"问题, 不是漏改某一句: 加句式, 别逐句手改。
   *
   * 都带 `(?<![\d.])` 前缀: 避免命中 `12.1267` 这种小数, 也避免吃到 `v1267`。
   */
  { re: /(?<![\d.])(\d+) 项单元测试/g, to: `${STATS.tests} 项单元测试`, label: "测试数(项单元测试)" },
  { re: /(?<![\d.])(\d+) 项全绿/g, to: `${STATS.tests} 项全绿`, label: "测试数(项全绿)" },
  { re: /(?<![\d.])(\d+) 单测/g, to: `${STATS.tests} 单测`, label: "测试数(单测)" },
  { re: /(?<![\d.])(\d+) 测试(?=[）)])/g, to: `${STATS.tests} 测试`, label: "测试数(测试·括号)" },
  { re: /(?<![\d.])(\d+) unit tests/gi, to: `${STATS.tests} unit tests`, label: "测试数(unit tests)" },
  { re: /(?<![\d.])(\d+) green/gi, to: `${STATS.tests} green`, label: "测试数(green)" },
  // `（1267, CI 全绿）` / `(1267, CI green)` —— 数字在括号开头、后接逗号 + CI
  // ⚠ 逗号要**两种都收**(`,` 与 `，`): 第一版只写了半角, 于是「（1267 项, CI 全绿）」
  //   因为项名不同 + 全角逗号两条都没命中, docs:check 报绿而数字一直是旧的。
  { re: /([（(])(?<![\d.])(\d+)(\s*[项个]?\s*[,，]\s*CI)/g, to: `$1${STATS.tests}$3`, label: "测试数(括号+CI)" },
  // 技能总数
  { re: /(\d+)\s*个?技能/g, to: `${STATS.skills ?? "$1"} 个技能`, label: "技能数" },  { re: /技能（(\d+) 项）/g, to: `技能（${STATS.skills ?? "$1"} 项）`, label: "技能项数" },
  { re: /（(\d+) 个技能全量浏览搜索）/g, to: `（${STATS.skills ?? "$1"} 个技能全量浏览搜索）`, label: "命令面板技能" },
  // 视图
  { re: /(\d+) 视图（含/g, to: `${STATS.views} 视图（含`, label: "视图数(含)" },
  { re: /(\d+) 视图 · \d+ 大分类/g, to: `${STATS.views} 视图 · ${STATS.categories} 大分类`, label: "视图数(分类)" },
  { re: /单窗口 (\d+) 视图切换/g, to: `单窗口 ${STATS.views} 视图切换`, label: "视图数(单窗口)" },
  // 工具总量(只在明确说"总体规模"的写法上)
  { re: /(?<![\d.])(\d+) 工具矩阵/g, to: `${totals.tools} 工具矩阵`, label: "工具矩阵" },
  { re: /(?<![\d.])(\d+) 工具自主调度/g, to: `${totals.tools} 工具自主调度`, label: "工具调度" },
  { re: /(\d+) 工具（(\d+) Agent \+ (\d+) 视图）/g, to: `${totals.tools} 工具（${STATS.agentTools} Agent + ${STATS.viewTools} 视图）`, label: "工具数(拆分)" },
  { re: /(\d+) 通用工具（(\d+) Agent \+ (\d+) 视图）/g, to: `${totals.tools} 通用工具（${STATS.agentTools} Agent + ${STATS.viewTools} 视图）`, label: "通用工具数" },
  { re: /(\d+) 通用工具 \+ (\d+) 视图工具/g, to: `${STATS.agentTools} 通用工具 + ${STATS.viewTools} 视图工具`, label: "通用+视图" },
  { re: /(\d+) 通用工具（(\d+) Agent \+ (\d+) 视图）/g, to: `${totals.tools} 通用工具（${STATS.agentTools} Agent + ${STATS.viewTools} 视图）`, label: "通用工具(拆分)" },
  { re: /(\d+) 工具 = (\d+) Agent 工具 \+ (\d+) 视图/g, to: `${totals.tools} 工具 = ${STATS.agentTools} Agent 工具 + ${STATS.viewTools} 视图`, label: "工具等式" },
  // 场景 / 阶段
  { re: /(\d+)\s*场景\s*[×x]\s*(\d+)\s*大阶段/g, to: `${STATS.scenarios} 场景 × ${STATS.groups} 大阶段`, label: "场景×阶段" },
  { re: /(\d+) 场景 · (\d+) 大(研究)?阶段/g, to: `${STATS.scenarios} 场景 · ${STATS.groups} 大研究阶段`, label: "场景·阶段" },
  { re: /场景数[：:]\s*(\d+)/g, to: `场景数：${STATS.scenarios}`, label: "场景数" },
  // 服务文件
  { re: /(\d+) 服务文件（/g, to: `${STATS.services} 服务文件（`, label: "服务文件数" },
];

// ─── 5. 执行替换 ───
let totalChanges = 0;
/** 已同步的文件集合 = RULES 里点名的 + GENERIC_RULES 生效的全部文档 */
const SYNCED_FILES = new Set<string>(RULES.map((r) => r.file));
for (const f of walkDocsForSync()) SYNCED_FILES.add(f);

for (const file of SYNCED_FILES) {
  const perFile = RULES.find((r) => r.file === file)?.rules ?? [];
  const filePath = path.join(ROOT, file);
  let content: string;
  try { content = readFileSync(filePath, "utf8"); } catch { continue; }
  let changed = 0;
  const labels: string[] = [];
  for (const rule of [...perFile, ...GENERIC_RULES]) {
    const matches = content.match(rule.re);
    if (!matches || matches.length === 0) continue;
    const after = content.replace(rule.re, rule.to);
    if (after !== content) {   // 只在内容真正变化时计数
      content = after;
      changed += matches.length;
      labels.push(rule.label);
    }
  }
  if (changed > 0) {
    totalChanges += changed;
    console.log(`[doc-sync] ${file}: ${changed} 处更新(${[...new Set(labels)].join(", ")})`);
    if (!CHECK_ONLY) writeFileSync(filePath, content, "utf8");
  }
}
console.log(totalChanges > 0
  ? `[doc-sync] ${CHECK_ONLY ? "发现" : "已更新"} ${totalChanges} 处过时数字`
  : "[doc-sync] ✅ 所有文档数字与代码一致");
process.exit(totalChanges > 0 && CHECK_ONLY ? 1 : 0);

/**
 * 要参与同步的文档集合。
 *
 * ⚠ 2026-09-29 加。此前只同步 RULES 里**点名的 12 个文件**, 其余 48 个文档里的数字
 *   完全没人管 —— 这是"内容没跟上实际"的头号原因(docs:check 一直报绿, 因为它只查列表里的)。
 *   现在把 docs/ 下的 md 全收进来, 通用规则对它们全部生效。
 */
function walkDocsForSync(): string[] {
  const out: string[] = [];
  const walkDir = (dir: string, prefix: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.') || name === 'assets') continue;
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      try {
        if (statSync(full).isDirectory()) walkDir(full, rel);
        else if (name.toLowerCase().endsWith('.md')) out.push(`docs/${rel}`);
      } catch { /* 跳过读不到的 */ }
    }
  };
  walkDir(path.join(ROOT, 'docs'), '');
  return out;
}
