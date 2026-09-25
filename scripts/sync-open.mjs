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
import { cpSync, existsSync, readdirSync, readFileSync, statSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(__dirname, "..");
const OPEN = process.env.SAG_OPEN_ROOT || path.resolve(__dirname, "..", "..", "SAG-open-source");

/**
 * 运行留痕(`--log <文件>` 或 `SAG_SYNC_LOG`)。
 *
 * 由来(2026-09-21 用户问"今晚 22:30 怎么没跑"): 同步**每天都在跑**, 但计划任务的 stdout
 *   没有落盘 —— 于是"跑了但零差异"与"根本没启动"在事后**完全无法区分**。那次我只能靠
 *   open 仓的提交时间戳反推, 而"零差异"的那几次天然不留任何提交。
 *   所以把每次运行的结论追加成一行(不是覆盖): 有没有差异、复制了几个、提交哈希、推没推成。
 *
 * 为什么用 `appendFileSync` 而不是写 stdout 让调用方重定向: 重定向要改计划任务的动作,
 *   而"这次跑的结果"恰恰是运行**内部**才知道的事(退出码表达不了"零差异"与"没启动"的区别)。
 * 为什么 `--log` 是参数而不是写死路径: 写死会指向主仓, 但脚本自己可能在别处被调用
 *   (worktree / 其它副本), 落点应由调用方决定。
 */
const LOG_FLAG = process.argv.indexOf("--log");
const LOG_FILE = LOG_FLAG > -1 ? process.argv[LOG_FLAG + 1] : process.env.SAG_SYNC_LOG || "";
/** 本次运行的账 —— 各处只填事实, 最后**恰好写一次**(见 finish) */
const run = { t0: Date.now(), changed: 0, added: 0, ghosts: 0, commit: "", pushed: false };
/**
 * 收尾: 写日志 + 按原语义退出。
 *
 * ⚠ 日志写在**唯一出口**, 且 `writeLog` 自己吞掉异常 —— 留痕绝不能反过来把同步搞挂;
 *   写不进去只是少一条记录, 同步本身该成功还是成功。
 */
function finish(code, note) {
  writeLog(code, note);
  process.exit(code);
}
function writeLog(code, note) {
  if (!LOG_FILE) return;
  const secs = ((Date.now() - run.t0) / 1000).toFixed(1);
  const parts = [
    // ISO 只到秒(zip 里见过 toISOString() 带毫秒, 这里不需要)
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    `exit=${code}`,
    `${DRY ? "dry-run" : "sync"}`,
    `差异=${run.changed}改+${run.added}增`,
    run.commit ? `提交=${run.commit}` : "提交=无",
    run.pushed ? "push=ok" : (NO_PUSH ? "push=跳过" : "push=未执行"),
    `残留=${run.ghosts}`,
    `${secs}s`,
  ];
  if (note) parts.push(note);
  try {
    appendFileSync(LOG_FILE, parts.join(" | ") + "\n");
  } catch (e) {
    console.error(`[sync-open] 写日志失败(${LOG_FILE}): ${String(e?.message || e).slice(0, 120)}`);
  }
}
const DRY = process.argv.includes("--dry-run");
const NO_PUSH = process.argv.includes("--push");
// 自定义提交消息: 默认 "sync: 自动同步 main → open (日期)"; 功能提交用 --msg "feat(xxx): ..."
const MSG_FLAG = process.argv.indexOf("--msg");
const CUSTOM_MSG = MSG_FLAG > -1 ? process.argv[MSG_FLAG + 1] : "";
const COMMIT_MSG = CUSTOM_MSG || `sync: 自动同步 main → open (${new Date().toISOString().slice(0, 10)})`;

/**
 * open 仓找不到 → 立刻失败, 并**留痕**。
 *
 * ⚠ 这条必须放在 CLI 参数解析之后: 本文件的 `const DRY`/`const NO_PUSH` 在**声明前**被
 *   `writeLog` 引用 —— 上面用 `--dry-run` 冒烟时因为这一段被删掉、脚本一路跑下去,
 *   把 open 仓不存在当成"1411 个文件全是新增", 打印出一个**看起来正常的差异报告**。
 *   那正是"静默地把失败说成成功"。所以这里既要有守卫, 也不能把它挪到声明之前。
 */
if (!existsSync(OPEN)) {
  console.error(`[sync-open] open-source 不存在: ${OPEN}`);
  finish(1, "open-source 不存在");
}


// ─── 同步目录(与 sync-repos.mjs 的 EXCLUDE 对齐) ───
// ⚠ 2026-09-12 修复: 原来只列了 "web/src", 而 collect() 不会跨进未列出的兄弟目录 ——
//   于是 **web/socialsci-vue/ 从来没有被同步过**(open 侧整个目录不存在)。
//   而 package.json 里 build:socialsci-vue 引用 web/socialsci-vue/vite.config.ts,
//   即 open 仓库的 `npm run build` 一直是坏的; 更严重的是**审稿/统计/viz/编辑器四个
//   工作台的全部前端代码都不在开源仓库里**。
//   现在补上 web/socialsci-vue 与其构建配置; web/dist 等产物仍由 EXCLUDE_DIR 排除。
//
// ⚠ 2026-09-23 补 `.github`: 它与上面那次是**同一个病** —— 不在列表里就永远同步不过去。
//   实测后果: open 仓的 `.github/workflows/ci.yml` 停在 9-1(99 行), 而 main 侧已改到
//   124 行 —— 9-14 加的「UI 视图门禁(真浏览器)」**从没在 CI 上跑过**, 一直是 open 仓
//   那份 99 行的旧版在跑(它那一步还是空转的 `npx playwright test`)。
//   同目录下的 release.yml 也一样。**改了 CI 配置却看不到效果的, 先查这里。**
const DIRS = ["src", "web/src", "web/public", "web/socialsci-vue", "test", "migrations", "scripts", "docs", "electron", "plugins", "vendor", "config", "script-archive", ".github"];
const ROOT_FILES = ["README.md", "README-CN.md", "README-EN.md", "CHANGELOG.md", "BENCHMARK.md", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "CLAUDE.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", "docker-compose.yml", "tailwind.config.js", "vite.config.ts", "postcss.config.js", "tsconfig.json", "tsconfig.build.json", "electron-builder.yml", "vitest.config.ts", "vite.preview.config.ts"];
const EXCLUDE_DIR = new Set(["node_modules", "dist", ".git", ".cache", ".vite", "release", "resources", "backups", "data", ".claude", "memory", "eval-archive", "reports", "knowledge-graph", "skills", "__pycache__"]);
/**
 * ⚠ 2026-09-25 补: **五份方法论文档 + 一个逆向脚本不进开源仓**。
 *
 * 由来: 用户问"逆向材料上传云端了吗"。二进制(别人的构建产物)没上传 ——
 *   `.claude/` 早在 EXCLUDE_DIR 里。但**方法论文档上传了**, 而且比代码注释更具体:
 *     · HAR-LINE-BY-LINE.md       1105 行参考产品接口逐条清单(`/api/editor/v1/documents/10/lock`)
 *     · SOCIALSCI-FUNCTION-MATRIX  77 个接口的逐条对照
 *     · socialsci-live-walk-1      登录态下的真实鼠标点击走查记录
 *     · dump-assistant-controls    从参考产品产物抽控件集的脚本(路径写死了逆向目录)
 *     · SOCIALSCI/UI 两份 GAP-ANALYSIS/UI-AUDIT 同样通篇引用 HAR 与参考产品页面结构
 *
 * 处置: **主仓保留、只在同步时跳过** —— 我们自己的差异基线不能丢, 但没必要公开。
 *   这与上面 `.github` 那次的方向相反(那次是"不在列表里就永远同步不过去"的 bug),
 *   这次是**有意排除**, 不是漏配。
 */
const EXCLUDE_FILE = [/\.env$/, /\.log$/, /\.v\d+/, /\.bak/, /^eval_32metrics.*\.json$/, /^gold_dataset.*\.json$/, /^judge_results\.json$/, /^isolated_entities\.csv$/, /^batch-ingest-log/, /^cognee_entities_dump\.json$/, /^entity_(id|norm)_map\.json$/, /^paper_id_map\.json$/, /^run-eval-one-by-one/, /^start(_sag|-web)\./, /^compact-vhdx/, /^memory-settings\.json$/, /^node_modules\.zip$/,
  // 见上方长注释: 逆向方法论文档与抓取脚本, 主仓保留、不公开
  /^HAR-LINE-BY-LINE\.md$/, /^SOCIALSCI-FUNCTION-MATRIX\.md$/, /^socialsci-live-walk-\d+\.md$/,
  /^SOCIALSCI-GAP-ANALYSIS\.md$/, /^UI-AUDIT-FINDINGS\.md$/, /^UI-COMPLEXITY-AUDIT\.md$/,
  /^dump-assistant-controls\.mjs$/,
  // 同类: 逆向工具本身(能直接重跑抽取), 与"记录性文档"不是一回事
  /^har-line-by-line\.mjs$/, /^har-eighth-round\.mjs$/, /^closed-feature-extract\.mjs$/,
];

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
run.changed = changed.length;
run.added = added.length;
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
run.ghosts = ghosts.length;
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

if (DRY) { console.log("[sync-open] --dry-run: 未复制"); finish(ghosts.length ? GHOST_EXIT : 0, "dry-run"); }
if (changed.length + added.length === 0) { console.log("[sync-open] ✅ open-source 已是最新(无新增/修改)"); finish(ghosts.length ? GHOST_EXIT : 0, "无差异"); }

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
    // 记短哈希进日志 —— 事后靠它在 open 仓里直接定位这次同步的内容
    run.commit = execSync(`git rev-parse --short HEAD`, { cwd: OPEN, encoding: "utf8" }).trim();
    console.log(`[sync-open] 已提交 open-source: ${COMMIT_MSG}`);
  }
  if (!NO_PUSH) {
    execSync(`git push origin main`, { cwd: OPEN, stdio: "inherit" });
    run.pushed = true;
    console.log("[sync-open] 已 push origin main");
  } else {
    console.log("[sync-open] --push: 跳过 push");
  }
} catch (e) {
  console.error(`[sync-open] git 操作失败: ${String(e?.message || e).slice(0, 200)}`);
  finish(1, `git 失败: ${String(e?.message || e).slice(0, 80).replace(/\s+/g, " ")}`);
}
console.log(ghosts.length
  ? `[sync-open] ⚠️ 同步完成, 但有 ${ghosts.length} 个残留待人工清理(退出码 ${GHOST_EXIT})`
  : "[sync-open] ✅ 同步完成");
finish(ghosts.length ? GHOST_EXIT : 0);
