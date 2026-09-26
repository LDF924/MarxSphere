// scripts/restart-4173.mjs — 重建前端产物 + 重启后端，一条命令。
//
// ## 为什么需要它
//
// 本项目的后端是 **tsx（不是 tsx watch）**，改了 `src/` 不重启就不生效；
// 前端产物同理，soc 源码改了不重新构建，4173 服务的还是旧的。
// 这两件事**不会报错**，表现为"改了没反应" —— 而这正是本仓库反复出现的一类缺陷。
//
// `scripts/verify-ui.mjs` 的环境哨兵会在跑套件前拦住这种情况（后端新鲜度 / 产物新鲜度两条），
// 所以问题不会被漏掉，但**每拦一次就白等一轮门禁**。
// 2026-09-26 我在这一个批次的实现里被拦了 **4 次**，每次都手动 cat PID → taskkill → start。
// 这个脚本把那一串固化下来。
//
// ## 用法
//
//   node scripts/restart-4173.mjs            # 重建 soc + 重启后端
//   node scripts/restart-4173.mjs --no-build # 只重启（没改前端时更快）
//
// ## 刻意不做的事
//
// · **不杀 node.exe**：仓库铁律 —— 那是 Claude Code 自己，会闪退。
//   这里只按 **4173 端口**查出 PID 再 taskkill /T /F（连子进程）。
// · 不用管道接后端输出：SIGPIPE 会杀进程（本项目踩过）。
//   启动器自己把日志写进 %TEMP%/sag-api-4173.log，这里只等端口起来。
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const noBuild = process.argv.includes("--no-build");
const PORT = Number(process.env.HTTP_PORT || 4173);
/** 与启动器同一口径（它也有默认值），用于下面的"日志真的在写吗"自检 */
const LOG_FILE = process.env.SAG_API_LOG || path.join(process.env.TEMP || "/tmp", "sag-api-4173.log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 4173 上正在监听的 PID（可能没有） */
function pidOnPort() {
  try {
    const out = execFileSync("cmd", ["/c", `netstat -ano | findstr :${PORT}`], { encoding: "utf-8" });
    const line = out.split("\n").find((l) => l.includes("LISTENING"));
    return line ? Number(line.trim().split(/\s+/).pop()) : 0;
  } catch {
    return 0;   // findstr 没命中会以非 0 退出
  }
}

async function main() {
  // ① 前端产物（可选）
  if (!noBuild) {
    const t0 = Date.now();
    process.stdout.write("构建 soc 产物… ");
    try {
      execFileSync(process.execPath, [path.join(here, "build-soc.mjs")], { cwd: repoRoot, stdio: "pipe" });
      console.log(`完成(${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (e) {
      console.error("\n❌ soc 构建失败，中止（不重启一个产物不新鲜的实例）:");
      console.error(String(e?.stdout ?? e?.message ?? e).slice(-800));
      process.exit(1);
    }
  }

  // ② 停掉旧的（按端口找 PID，不碰其它 node）
  const old = pidOnPort();
  if (old) {
    process.stdout.write(`停止旧实例 PID ${old}… `);
    // /T 连子进程一起 —— tsx 会 fork 出真正跑服务的子进程
    try { execFileSync("cmd", ["/c", `taskkill /PID ${old} /T /F`], { stdio: "pipe" }); } catch { /* 已退出 */ }
    console.log("已停");
  } else {
    console.log(`端口 ${PORT} 上没有监听者`);
  }
  await sleep(3000);

  // ③ 起新的 —— 走仓库自己的启动器（它负责 SAG_ROOT/DATA_DIR/.env 那套口径）
  const launcher = path.join(here, "start-api-worktree-4173.cmd");
  if (!existsSync(launcher)) {
    console.error(`❌ 找不到启动器: ${launcher}`);
    process.exit(1);
  }
  process.stdout.write("启动后端… ");
  /**
   * 这两个选项是**互相制约**的，改一个必须想另一个 —— 2026-09-26 我在它们之间来回翻车两次。
   *
   * ① **不能加 `detached: true`**：它会让启动器里那句 `>> "%SAG_API_LOG%"` 建出文件却
   *    一个字节都写不进去（把 fd 直接交给子进程也一样）。后果不是报错，是
   *    "后端跑着、日志恒 0 字节" —— 出事时手上一份空日志。
   *    受控实测（真实启动器各打一个真请求后量文件）：
   *      detached:true  → 0 字节     detached:false → 24309 字节
   *
   * ② **必须加 `windowsHide: true`**：detached 在 Windows 上等于 DETACHED_PROCESS
   *    （完全不要控制台）。去掉它之后子进程会**继承调用方的控制台** ——
   *    实测无 windowsHide 时新建 conhost 数为 0（即挂到了调用方已有的控制台上），
   *    表现就是"后端一启动，一个控制台窗口弹到前台"。加上 windowsHide 后 cmd 有一个
   *    **隐藏的**控制台可用（所以 `>>` 照样能写），但不会显示。
   *    实测两种组合: 无 windowsHide → 日志 24306 字节 / 弹窗;
   *                 有 windowsHide → 日志 24309 字节 / 隐藏 console。
   *
   * 一句话：**要日志就得给它一个控制台，要安静就得是隐藏的那个。**
   */
  const child = spawn("cmd", ["/c", launcher], { cwd: repoRoot, stdio: "ignore", windowsHide: true });
  child.unref();

  /**
   * 日志基线 —— 用来判断"重启后日志到底有没有在写"。
   * 取的是**重启前**的大小：文件是 `>>` 追加的，新实例若真在写，尺寸只会涨。
   */
  const logSizeBefore = (() => { try { return statSync(LOG_FILE).size; } catch { return -1; } })();

  // ④ 等端口真的起来（不是等固定秒数 —— 首次启动要跑迁移可能很久）
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        console.log(`就绪 · db=${j.db ?? "?"} · 用时 ${Math.round((Date.now() - (deadline - 120_000)) / 1000)}s`);
        if (j.db !== "up") {
          console.error("\n⚠️  服务起来了但 **db 不是 up** —— 后端读不到库，跑门禁会大面积失败。");
          console.error("   本机库是 docker 的 sag_lite_postgres（映射 5540）。先确认 docker 在跑：");
          console.error("     docker ps");
          console.error("   若 Docker Desktop 自己崩了（不是容器崩），start it via:");
          console.error('     powershell -Command "Start-Process \'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe\'"');
          process.exit(2);
        }
        await checkLogAlive(logSizeBefore);
        process.exit(0);
      }
    } catch { /* 还没起来 */ }
  }
  console.error(`\n❌ 等了 120s 端口 ${PORT} 仍未就绪，看日志: ${LOG_FILE}`);
  process.exit(1);
}

/**
 * 自检: 重启后, 日志文件到底有没有在增长。
 *
 * 由来(2026-09-26): 这个脚本第一版用了 `detached: true` —— 启动器那句
 *   `>> "%SAG_API_LOG%"` 会**建出文件却一个字节都写不进去**, 而服务照常起来、照常健康。
 *   于是每重启一次, 日志就永远停在旧内容上: 出事时手上有日志, 只是里面没有这次的故障。
 *   **没有任何信号** —— 这一条就是那个信号。
 *
 * 判据: 发一个**已知不进日志的**请求(/health 在 Fastify 里是 excluded), 所以改用
 *   /api/projects —— 它必然产生一条 incoming/completed。
 *   基线取 -1(文件原本不存在)时, 只要文件现在存在且非空就算过。
 */
async function checkLogAlive(sizeBefore) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/projects`).catch(() => {});
    await sleep(1500);
    /**
     * ⚠ 读不到就当 **-1**，不能让它抛。
     *   第一版直接 `statSync(...).size` —— 文件压根没建出来时抛异常，被外层 catch 吞掉,
     *   于是"日志完全没写"这个最严重的情形反而**静默通过**。
     *   （本仓管这个叫"判据看不到被测对象"。）
     */
    let now;
    try { now = statSync(LOG_FILE).size; } catch { now = -1; }
    if (now > Math.max(sizeBefore, 0)) return;   // 涨了 = 正常
    console.error("\n⚠️  服务在跑, 但**日志文件没有写入**（重启后大小没有增长）。");
    console.error(`   文件: ${LOG_FILE}  重启前 ${sizeBefore} 字节 → 现在 ${now} 字节`);
    console.error("   多为启动器的 `>>` 重定向被 spawn 选项吃掉: `detached: true` 会让 cmd");
    console.error("   建出文件却写不进内容。检查本脚本第 ③ 步的 spawn 选项里有没有 detached。");
    console.error("   （不影响服务本身, 但出事时你手上会是一份空的日志。）\n");
  } catch { /* 自检失败不该让重启算失败 */ }
}

await main();
