// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// scripts/snapshot-code.mjs — 代码快照备份(整仓 robocopy 到 E:\SAG-archive)
//
// 由来: 此前每次备份靠手打 robocopy, 排除项凭记忆 —— 实测 20260912 与 20260913
//   两份的范围就不一致(前者带 resources/ 与 *.log, 后者没有), 体积差 375M。
//   BACKUP.info 也是 20260912 才开始手写。这里把两者都固化。
//
// 用法:
//   node scripts/snapshot-code.mjs              # 快照到默认位置
//   node scripts/snapshot-code.mjs --dry-run    # 只打印将执行什么
//   SNAPSHOT_DEST=E:/其他路径 node scripts/snapshot-code.mjs
//
// 坑(记忆里记过): Git Bash 直接跑 robocopy 会把 /E 当成路径转义 —— 必须 cmd //c 包一层。
//   本脚本用 cmd.exe 执行, 所以上面这条坑不影响脚本自身, 只影响手打命令的人。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..");
const DRY = process.argv.includes("--dry-run");
/** 只报"当前状态是否与上一份快照一致"(用于"我改了东西, 要不要重跑快照"的判断), 不做快照 */
const CURRENT_ONLY = process.argv.includes("--current-only");

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
const DATE = stamp();
const DEST = process.env.SNAPSHOT_DEST || `E:/SAG-archive/SAG-main-backup-${DATE}`;

/**
 * 排除的目录 —— 都是"可重建"或"体积大且非源码"的:
 *   node_modules(1.1G, npm ci 可重建) · .git(远端有) · release(2.1G, 打包产物)
 *   dist/build(可构建) · .cache/.vite/__pycache__(缓存) · backups(备份套备份)
 *   .claude/worktrees(其它 worktree 的副本, 会造成重复与混淆)
 * 注意: 与 20260912 相比这里**多排除了 release/ 与 resources/** —— 前者 2.1G 是
 *   electron 打包产物(npm run build:desktop 可重建); 后者 274M 是同一产物在
 *   resources/sag 下的副本。上一份把 resources 备进去了, 但那是冗余而非必要。
 */
const EXCLUDE_DIRS = [
  "node_modules", ".git", "release", "resources", "dist", "build",
  ".cache", ".vite", "__pycache__", "backups",
  path.join(".claude", "worktrees"),
];
/** 排除的文件模式: 日志与临时产物(体积小但每次都在变, 备了没意义)
 *  `.git` 必须在这里也排一次 —— worktree 里的 .git 是**文件**(指向主仓)不是目录,
 *  只写 /XD .git 对它无效(实测漏过一次)。 */
const EXCLUDE_FILES = [".git", "*.log", "*.tmp", "*.bak", "npm-debug.log*"];
/** 快照完成后自检: 这些顶层项若出现, 说明排除没生效(宁可报错也别留个错误的备份) */
const MUST_NOT_EXIST = ["node_modules", ".git", "release", "resources", "dist", "build", "backups"];

function git(args, cwd = SRC) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); } catch { return ""; }
}

/**
 * 工作区状态指纹 —— 用于检测"快照期间工作区被改动"。
 *
 * 由来(2026-09-13): 快照抓的是**工作区内容**, 而 BACKUP.info 记的是 **HEAD**。
 *   两者不一致时那份 info 就是误导(实测踩过: 文档改完没提交就快照, info 指向的
 *   HEAD 里是旧文档)。这里用 `git status` + 各改动文件的内容哈希做指纹,
 *   快照前后各取一次, 不一致就警告 —— 快照本身有效, 但 info 描述的版本状态存疑。
 */
function workspaceFingerprint() {
  const status = git(["status", "--porcelain"]);
  const lines = status.split("\n").filter(Boolean);
  const h = createHash("sha256");
  for (const l of lines.sort()) {
    const rel = l.slice(3).trim().split(" -> ").pop();     // 重命名取新路径
    h.update(l.split(" ")[0]);                              // 状态码
    h.update(rel);
    try {
      const abs = path.join(SRC, rel);
      if (existsSync(abs) && statSync(abs).isFile()) h.update(readFileSync(abs));
    } catch { /* 删除的文件读不到, 状态码已经区分了 */ }
  }
  return { dirtyCount: lines.length, hash: h.digest("hex").slice(0, 16), status };
}

/**
 * --current-only: 比对"当前仓库状态"与**最近一份快照**记录的状态, 只报告不做事。
 *
 * 解决的是执行顺序问题: 改完东西后先跑这个 —— 若显示"已偏离", 说明该重做快照了;
 * 若显示一致, 说明当前快照仍然有效, 不用白跑一次全量拷贝。
 * 判据是 HEAD + 工作区指纹(不是文件内容逐个比对, 那太慢)。
 */
function reportCurrentVsLatest() {
  const root = path.dirname(DEST);
  const snaps = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^SAG-main-backup-\d{8}$/.test(e.name))
        .map((e) => e.name).sort()
    : [];
  if (!snaps.length) { console.log("[snapshot] 还没有任何快照"); return; }
  const latest = snaps[snaps.length - 1];
  const infoPath = path.join(root, latest, "BACKUP.info");
  if (!existsSync(infoPath)) { console.log(`[snapshot] 最近快照 ${latest} 没有 BACKUP.info, 无法比对`); return; }
  const info = readFileSync(infoPath, "utf8");
  const snapHead = (info.match(/^HEAD: (\S+)/m) || [])[1] || "";
  const snapFp = (info.match(/^工作区指纹: (\S+)/m) || [])[1] || "";
  const cur = workspaceFingerprint();
  const curHead = git(["rev-parse", "HEAD"]);
  const drift = curHead !== snapHead || cur.hash !== snapFp;

  console.log(`[snapshot] 最近快照: ${latest}`);
  console.log(`  快照记录的 HEAD: ${snapHead.slice(0, 8)}  工作区指纹: ${snapFp || "(旧格式无)"}`);
  console.log(`  当前    的 HEAD: ${curHead.slice(0, 8)}  工作区指纹: ${cur.hash} (${cur.dirtyCount} 个改动)`);
  if (!drift) {
    console.log("[snapshot] ✓ 状态一致 —— 现有快照仍有效, 无需重做");
  } else {
    console.log("[snapshot] ✗ 状态已偏离 —— 现有快照不含最新改动, 该重做了");
    if (curHead !== snapHead) console.log(`  HEAD 变了: ${snapHead.slice(0, 8)} → ${curHead.slice(0, 8)}`);
    if (cur.hash !== snapFp) console.log(`  工作区变了(指纹不一致)`);
    console.log(`  重做: rm -rf "${root}/${latest}" 然后 node scripts/snapshot-code.mjs`);
  }
}

function run() {
  if (CURRENT_ONLY) { reportCurrentVsLatest(); return; }
  if (existsSync(DEST)) {
    console.error(`目标已存在, 不覆盖: ${DEST}`);
    console.error("先确认它是否是有用的旧快照; 要重做请换日期或手工删除。");
    process.exit(1);
  }
  const robocopyArgs = [
    SRC, DEST, "/E", "/NFL", "/NDL", "/NJH", "/NP", "/R:1", "/W:1",
    ...EXCLUDE_DIRS.flatMap((d) => ["/XD", path.join(SRC, d)]),
    ...EXCLUDE_FILES.flatMap((f) => ["/XF", f]),
  ];
  console.log(`[snapshot] 源:   ${SRC}`);
  console.log(`[snapshot] 目标: ${DEST}`);
  console.log(`[snapshot] 排除目录: ${EXCLUDE_DIRS.join(", ")}`);
  console.log(`[snapshot] 排除文件: ${EXCLUDE_FILES.join(", ")}`);
  if (DRY) { console.log("[snapshot] --dry-run: 未执行"); return; }

  mkdirSync(path.dirname(DEST), { recursive: true });
  // 快照前取工作区指纹 —— 快照后复核, 检测"抓取期间仓库被改动"
  const before = workspaceFingerprint();
  const headAtStart = git(["rev-parse", "HEAD"]);
  // robocopy 的退出码 0-7 都是成功(1=有复制), ≥8 才是失败 —— 别用 execFileSync 的默认抛错语义
  let code = 0;
  try {
    execFileSync("cmd", ["/c", "robocopy", ...robocopyArgs], { stdio: "pipe" });
  } catch (e) {
    code = typeof e.status === "number" ? e.status : 16;
    if (code >= 8) { console.error(`[snapshot] robocopy 失败(退出码 ${code})`); process.exit(1); }
  }
  console.log(`[snapshot] robocopy 完成(退出码 ${code}, 0-7 均视为成功)`);

  // ── 快照后复核: HEAD 或工作区在抓取期间变了吗 ──
  // 变了不代表快照坏(robocopy 自己会重试), 但 BACKUP.info 记的版本状态就不准了, 必须提示。
  const after = workspaceFingerprint();
  const headAtEnd = git(["rev-parse", "HEAD"]);
  const raced = headAtEnd !== headAtStart || after.hash !== before.hash;
  if (raced) {
    console.warn("[snapshot] ⚠ 快照期间仓库发生了改动 —— 快照内容可能是个混合体, BACKUP.info 的版本信息不准");
    if (headAtEnd !== headAtStart) console.warn(`[snapshot]   HEAD 变了: ${headAtStart.slice(0, 8)} → ${headAtEnd.slice(0, 8)}`);
    if (after.hash !== before.hash) console.warn(`[snapshot]   工作区变了: ${before.dirtyCount} → ${after.dirtyCount} 个改动(指纹 ${before.hash} → ${after.hash})`);
    console.warn("[snapshot]   建议: 删掉该快照重做一次(确保抓的是同一个状态)");
  } else {
    console.log(`[snapshot] 仓库状态稳定(HEAD ${headAtEnd.slice(0, 8)}, ${after.dirtyCount} 个未提交改动)`);
  }

  // ── 自检: 排除项真的没被复制过去(robocopy 的参数写错时它是静默照做的) ──
  const leaked = MUST_NOT_EXIST.filter((d) => existsSync(path.join(DEST, d)));
  if (leaked.length) {
    console.error(`[snapshot] ✗ 排除失效, 快照里有不该有的项: ${leaked.join(", ")}`);
    console.error(`[snapshot]   快照已生成但不完整/偏大, 请修 EXCLUDE_DIRS/EXCLUDE_FILES 后删除 ${DEST} 重做`);
    process.exit(1);
  }
  console.log("[snapshot] 自检通过: 排除项均未进入快照");

  // ── BACKUP.info: 记录快照对应的代码状态, 供事后追溯 ──
  const openDir = process.env.SAG_OPEN_ROOT || "C:/Users/HUAWEI/SAG-open-source";
  const openExists = existsSync(path.join(openDir, ".git"));
  const countFiles = (dir) => {
    let n = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else n++;
      }
    };
    try { walk(dir); } catch { /* 权限 */ }
    return n;
  };
  const lines = [
    `备份时间: ${new Date().toLocaleString("zh-CN")}`,
    `源: ${SRC}`,
    `HEAD: ${headAtEnd}`,
    `HEAD 提交: ${git(["log", "-1", "--format=%s"])}`,
    `工作区: ${after.dirtyCount} 个未提交改动`,
    // 指纹: 事后可用 `snapshot-code.mjs --current-only` 比对, 判断"当前状态是否已偏离这份快照"
    `工作区指纹: ${after.hash}${raced ? "  ⚠ 快照期间有改动, 内容可能是混合体" : ""}`,
  ];
  if (openExists) {
    lines.push(`open HEAD: ${git(["rev-parse", "HEAD"], openDir)}`);
    lines.push(`GitHub:    ${git(["rev-parse", "origin/main"], openDir)}`);
  }
  lines.push(`文件数: ${countFiles(DEST)}`);
  lines.push("", `由 scripts/snapshot-code.mjs 生成; 恢复见 docs/BACKUP-RESTORE.md`);
  writeFileSync(path.join(DEST, "BACKUP.info"), lines.join("\n") + "\n", "utf8");

  const size = (() => {
    let total = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else { try { total += statSync(p).size; } catch { /* ignore */ } }
      }
    };
    try { walk(DEST); } catch { /* ignore */ }
    return total;
  })();
  console.log(`[snapshot] 完成: ${(size / 1024 / 1024).toFixed(0)} MB`);
  console.log(lines.slice(0, 6).map((l) => "    " + l).join("\n"));
}

run();
