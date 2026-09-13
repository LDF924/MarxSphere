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
import { existsSync, mkdirSync, writeFileSync, statSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..");
const DRY = process.argv.includes("--dry-run");

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

function run() {
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
  // robocopy 的退出码 0-7 都是成功(1=有复制), ≥8 才是失败 —— 别用 execFileSync 的默认抛错语义
  let code = 0;
  try {
    execFileSync("cmd", ["/c", "robocopy", ...robocopyArgs], { stdio: "pipe" });
  } catch (e) {
    code = typeof e.status === "number" ? e.status : 16;
    if (code >= 8) { console.error(`[snapshot] robocopy 失败(退出码 ${code})`); process.exit(1); }
  }
  console.log(`[snapshot] robocopy 完成(退出码 ${code}, 0-7 均视为成功)`);

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
    `HEAD: ${git(["rev-parse", "HEAD"])}`,
    `HEAD 提交: ${git(["log", "-1", "--format=%s"])}`,
    `工作区: ${git(["status", "--short"]).split("\n").filter(Boolean).length} 个未提交改动`,
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
