#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// scripts/sync-open.mjs — main→open-source 一键同步(V393, 2026-08-30)
// 流程:
//   1. 复制 main 的全部代码/文档到 open-source(排除 .env/.git/node_modules/dist 等)
//   2. open-source 提交 + push origin main
// 用法:
//   node scripts/sync-open.mjs           # 同步+提交+push
//   node scripts/sync-open.mjs --dry-run # 只显示差异不复制
//   node scripts/sync-open.mjs --push    # 同步+提交, 跳过 push
import { execSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, statSync, appendFileSync, writeFileSync } from "node:fs";
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
const run = { t0: Date.now(), changed: 0, added: 0, ghosts: 0, excludedStale: 0, commit: "", pushed: false,
  /**
   * push 的三种结局, 必须分开记 —— 2026-10-02 踩到:
   *   `pushed: false` 同时表示"没推成"和"根本没到 push 那一步"(无差异早退),
   *   而这两件事的含义完全相反。日志里 09-23~10-01 连续 9 天写着 `push=未执行`,
   *   看起来像"不需要推", 实际是**从来没走到 push**, 于是 gh-proxy 不可写这件事
   *   藏了 9 天没被发现。
   */
  pushOutcome: /** @type {"ok"|"failed"|"skipped"|"not-reached"} */ ("not-reached"),
  /** 失败原因(push 失败时填) —— 只留 "失败" 两个字, 事后无从查起 */
  pushError: "" };

/**
 * 状态落点 —— 供**平台侧的巡检**读取并转成告警。
 *
 * 为什么不是让同步脚本自己写 alerts 表: 那会让一个纯文件同步的脚本
 *   依赖 pg / .env / 数据库可达。网络或库不可用时, **同步本身会因此挂掉** ——
 *   本末倒置。脚本只落一个 JSON, 读它、判断、告警都是平台的事。
 *
 * 与 `--log` 那条同样的理由: 落点由调用方决定(脚本可能在 worktree 或其它副本里被调用)。
 */
const STATE_FLAG = process.argv.indexOf("--state");
const STATE_FILE = STATE_FLAG > -1 ? process.argv[STATE_FLAG + 1] : process.env.SAG_SYNC_STATE || "";
/**
 * 收尾: 写日志 + 按原语义退出。
 *
 * ⚠ 日志写在**唯一出口**, 且 `writeLog` 自己吞掉异常 —— 留痕绝不能反过来把同步搞挂;
 *   写不进去只是少一条记录, 同步本身该成功还是成功。
 */
function finish(code, note) {
  writeLog(code, note);
  writeState(code, note);
  process.exit(code);
}

/**
 * 把本次运行的结论写进状态文件 —— **平台侧巡检靠它发告警**。
 *
 * 与 `writeLog` 的关系: 日志是**追加**给人看的(每次一行), 状态是**覆盖**给机器读的
 *   (只关心"最近一次怎么样")。两者都要, 但用途不同。
 *
 * ⚠ 这里**必须自己吞掉异常**: 留痕/上报绝不能反过来把同步搞挂 ——
 *   写不进去只是少一条状态, 同步该成功还是成功。
 */
function writeState(code, note) {
  if (!STATE_FILE) return;
  try {
    const prev = (() => {
      try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
    })();
    /**
     * 连续失败计数 —— 这是"9 天没发现"那个问题的直接对策。
     *
     * 单看一次 `push=failed`, 可能只是网络抖动; **连续 N 次**才是"通道坏了"。
     * 用日历时间判断太脆(计划任务可能没跑), 用次数累积更稳:
     * 成功即清零, 失败则累加, 平台侧按次数决定告警级别。
     */
    const failing = code !== 0;
    const consecutiveFailures = failing ? (Number(prev.consecutiveFailures) || 0) + 1 : 0;
    const state = {
      at: new Date().toISOString(),
      exitCode: code,
      mode: DRY ? "dry-run" : "sync",
      changed: run.changed,
      added: run.added,
      commit: run.commit || null,
      pushOutcome: run.pushOutcome,
      pushError: run.pushError || null,
      ghosts: run.ghosts,
      consecutiveFailures,
      /** 上次成功是什么时候 —— 与"上次运行"不同: 连续失败时它一直停在过去, 一眼看出停了多久 */
      lastSuccessAt: failing ? (prev.lastSuccessAt ?? null) : new Date().toISOString(),
      note: note || null,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch (e) {
    console.error(`[sync-open] 写状态失败(${STATE_FILE}): ${String(e?.message || e).slice(0, 120)}`);
  }
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
    // ⚠ 三态要分开写进日志 —— 原来只有 `push=ok` / `push=未执行` 两种,
    //   而"无差异所以没推"和"--push 跳过"和"走到 push 但失败"全挤在"未执行"里,
    //   连续 9 天的 `push=未执行` 因此看起来一切正常(2026-10-02 实测)。
    run.pushOutcome === "ok" ? "push=ok"
      : run.pushOutcome === "failed" ? "push=失败"
      : run.pushOutcome === "skipped" ? "push=跳过"
      : "push=未到(无差异)",
    `残留=${run.ghosts}`,
    `排除残留=${run.excludedStale}`,
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
const DIRS = ["src", "web/src", "web/public", "web/socialsci-vue", "test", "migrations", "scripts", "docs", "electron", "plugins", "vendor", "config", "script-archive", ".github",
  // ⚠ 2026-09-29 补: 这两处原先**不在同步范围**, 于是 open 仓里长期是旧的。
  //   web/index.html 的 title 一直停在旧名(换标后才发现), build/installer.nsh 同理。
  //   共同点是"不在任何已列目录下", 属整目录/散文件漏掉 —— 与 V415 漏 CLAUDE.md、
  //   V418 漏一批文档是同一个病: **漏的原因是文件没进列表, 不是规则写错**。
  "build",
  // ⚠ 2026-09-30 补 reports/ —— 它此前**既不在 DIRS 又在 EXCLUDE_DIR 里被排除**,
  //   于是那 4 份评测报告样例永远同步不到开源仓。
  //   那 4 份是前端「学习引擎」面板的读取对象(`EVAL_REPORT_NAMES` 白名单), 删了前端
  //   四张卡会**静默空白**(API 返回空数组、不报错), 所以必须随仓分发。
  "reports"];
// web/ 根目录下的散文件不属任何子目录, 单独列出并接进同步循环(见下方 for)。
// ⚠ 只声明不消费等于没加 —— WEB_ROOT_FILES 必须在下面**真的接进收集循环**与 inSyncScope。
const WEB_ROOT_FILES = ["web/index.html"];
const ROOT_FILES = ["README.md", "README-CN.md", "README-EN.md", "CHANGELOG.md", "BENCHMARK.md", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "CLAUDE.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", "docker-compose.yml", "tailwind.config.js", "vite.config.ts", "postcss.config.js", "tsconfig.json", "tsconfig.build.json", "electron-builder.yml", "vitest.config.ts", "vite.preview.config.ts"];
const EXCLUDE_DIR = new Set(["node_modules", "dist", ".git", ".cache", ".vite", "release", "resources", "backups", "data", ".claude", "memory", "eval-archive", "knowledge-graph", "skills", "__pycache__"]);
// ⚠ 2026-09-30 把 "reports" 从上面这张排除表里**去掉**了。
//   它此前被排除, 后果是那 4 份评测报告样例永远同步不过去; 而三份 README 又写着
//   "reports/ 在开源仓库里" —— 两边都不对。
//   历史教训: 光从 EXCLUDE_DIR 移除**不够**, 还得同时进 DIRS —— 同步只遍历 DIRS,
//   一次漏两处, 只改一处等于没改(实测过)。
//   reports/README.md 里写着这几份谁在读、删了会怎样、改名要同改哪两处。
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
// web/ 根目录的散文件 —— 只声明不消费等于没加, 所以这里必须真的接进来
for (const f of WEB_ROOT_FILES) {
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
  return ROOT_FILES.includes(rel) || WEB_ROOT_FILES.includes(rel)
    || DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}
let openTracked = [];
try {
  const out = execSync(`git ls-files`, { cwd: OPEN, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  openTracked = out.split("\n").map((s) => s.trim()).filter(Boolean);
} catch { /* open 仓无 git / 读不到 → 跳过检测 */ }
/**
 * ⚠ **开源仓有意比开发仓多留的东西** —— 探测到了也不该报成"残留待清理"。
 *
 * 2026-09-30 加。这三份评测报告 2026-08 之前就在开源仓里了, 早于"这类报告不入开发仓"
 * 那个决定。它们的内容是评测统计(异源交叉评判的逐题分歧率 / 提示词变更后的快速回归 /
 * 技能 description 四要素完整性), **不含工程记录、外部产品对照、自审交接** ——
 * 公开着没有风险, 而撤掉反而会让引用过的人困惑。所以**保留**, 两仓在这一点上有意不一致。
 *
 * 加这份白名单是因为: 每次同步都把这 3 个报成"多半是孤儿代码, 确认无用后手工清理",
 * 而照着提示做恰恰是**错的** —— 会把有意保留的内容从公开仓删掉。
 * `reports/README.md` 里也写明了缘由。
 */
const OPEN_ONLY_INTENT = new Set([
  "reports/cross_judge_report.md",
  "reports/prompt_regression_report.md",
  "reports/skill-audit-report.md",
]);
const ghosts = openTracked.filter(
  (rel) => inSyncScope(rel) && !existsSync(path.join(MAIN, rel)) && !OPEN_ONLY_INTENT.has(rel),
);
run.ghosts = ghosts.length;

/**
 * 第二类残留: **主仓还在, 但被 EXCLUDE_FILE 挡住了**。
 *
 * 由来(2026-09-27): 上面那条只查 `!existsSync(main/rel)`, 于是漏掉这一种 ——
 *   文件在 main 里**好端端地存在**, 只是 `excluded()` 把它挡在同步之外。结果:
 *   它既不会被更新, 也不会被报成残留, 只在 open 仓里**冻结成一个旧版本**。
 *
 *   实测就是这 4 个: `run-eval-one-by-one.bat/.ps1`、`start-web.cmd`、`start_sag.bat`
 *   —— open 里躺着 8 月 18 日的副本, 而 main 早已改过; 直到 2026-09-27 新加的
 *   `shell-script-encoding` 门禁在 CI 上把它们指出来, 才发现这回事。
 *   (那三个旧副本里正好还留着中文注释 —— 门禁报的是真事。)
 *
 * 判据与上面的 ghosts 不同, 所以单独一组: 主仓存在 + 在同步范围内 + 被排除 + open 仍跟踪。
 * **同样只报不删** —— 排除是**有意的**(逆向材料、本地脚本), 该不该从公开仓清掉得人来定。
 */
const excludedStale = openTracked.filter((rel) =>
  inSyncScope(rel) &&
  existsSync(path.join(MAIN, rel)) &&
  excluded(rel, statSync(path.join(MAIN, rel)).isDirectory())
);
run.excludedStale = excludedStale.length;
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

/**
 * 第二类残留的报告 —— ⚠ 它**不改退出码**。
 *
 * 为什么不并入上面那段: 上面那类是"main 已删"(基本可以断定是孤儿, 该报错催人清);
 *   这一类是"有意排除但仍被 open 跟踪"—— 排除本身正当, 只是那份副本会**冻结**。
 *   要不要从公开仓清掉, 得看内容(逆向材料必须清, 本地工具脚本无所谓), 不是脚本能定的。
 *   所以只提示, 不参与退出码 —— 否则每次同步都会因为这类"待定"而返回非 0, 那个信号很快就没人看了。
 */
if (excludedStale.length) {
  console.log(`\n[sync-open] ℹ️ 另有 ${excludedStale.length} 个文件「main 还在、但被排除表挡住」(sync 永不更新它们):`);
  for (const g of excludedStale) console.log(`  · ${g}`);
  console.log(`  它们在 open 仓里会**冻结在旧版本** —— 该不该清掉请人工判断:`);
  console.log(`    cd ${OPEN} && git rm -- ${excludedStale.slice(0, 3).map((g) => JSON.stringify(g)).join(" ")}${excludedStale.length > 3 ? " …" : ""}`);
  console.log(`  (2026-09-27 实测: 这类副本在 open 仓里躺了 40 天没被发现, 直到新加的脚本编码门禁在 CI 上报出来。)\n`);
}

// 留痕: 把残留写进提交信息, 这样即使没人盯终端, git log 里也查得到
const GHOST_NOTE = (ghosts.length || excludedStale.length)
  ? "\n\n[sync-open 残留提示] open 仓有需人工确认的文件:\n"
    + (ghosts.length
      ? "  ① main 已删但仍被跟踪(" + ghosts.length + " 个)——多半是孤儿:\n"
        + ghosts.slice(0, 10).map((g) => "    - " + g).join("\n")
        + (ghosts.length > 10 ? "\n    … 等 " + ghosts.length + " 个" : "")
      : "")
    + (excludedStale.length
      ? "\n  ② main 还在、但被排除表挡住(sync 永不更新)(" + excludedStale.length + " 个):\n"
        + excludedStale.slice(0, 10).map((g) => "    - " + g).join("\n")
      : "")
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
    try {
      execSync(`git push origin main`, { cwd: OPEN, stdio: "inherit" });
      run.pushOutcome = "ok";
      run.pushed = true;
      console.log("[sync-open] 已 push origin main");
    } catch (pushErr) {
      /**
       * ⚠ push 失败要**单独记清楚**, 不能只让外层 catch 记一句"git 操作失败"。
       *
       * 2026-10-02 实测: origin 被指向 gh-proxy(只读镜像)时, push 报
       *   `remote: No anonymous write access` —— 而日志里只有一句 exit=1,
       *   事后完全看不出是"推不上去"还是"提交就失败了"。
       * 提交已经成功、只有推送失败, 这种状态最需要被说清楚:
       *   内容已经固化在 open 仓本地, 只差推远端, **重试即可**。
       */
      run.pushOutcome = "failed";
      run.pushError = String(pushErr?.stderr || pushErr?.message || pushErr).replace(/\s+/g, " ").slice(0, 300);
      console.error(`[sync-open] ❌ push 失败(提交已在 open 仓本地): ${run.pushError.slice(0, 160)}`);
      finish(1, `push 失败: ${run.pushError.slice(0, 100)}`);
    }
  } else {
    run.pushOutcome = "skipped";
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
