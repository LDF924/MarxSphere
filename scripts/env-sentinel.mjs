#!/usr/bin/env node
// scripts/env-sentinel.mjs — 跑门禁前的环境自检
//
// 由来(2026-09-22): 那一晚全量跑了 25 套 UI 门禁(约 33 分钟), **三个失败全部落在我改动
//   无关的套件上** —— 不是代码回归, 而是"在什么条件下跑"变了: 从 worktree 起了后端,
//   cwd 不同, .env 解析与数据根跟着变。按改动挑套件的话, 这三个一个都跑不到。
//   问题在于: 它们本来各有一句**几秒钟就能得到**的诊断, 却要等十几分钟的门禁跑完才浮现。
//
// 所以把这几件事提前问清楚: **我在哪个树 / 打的是哪个后端 / 读的是哪个 .env / 端口上是谁**。
// 它们**推不出影响面**(cwd、端口、数据根这类变化不体现在 diff 里), 只能直接测。
//
// 判定尺度刻意从严: "服务端托管的前端不是本树的产物"一律 **FAIL 而不是 warn**。
//   教训来自实证台探针那句"清理临时课题失败(需手动删)" —— 它看起来无害, 于是躺了两次运行
//   没人管, 直到库里积了数据。**看着无害的警告等于没有警告。**
//   确实要故意跨树验证时用 `--allow-mismatch` 显式放行。
//
// 用法:
//   node scripts/env-sentinel.mjs                       # 单独跑(默认打 4173)
//   API_BASE=http://127.0.0.1:4373 WEB=http://127.0.0.1:4373 node scripts/env-sentinel.mjs
//   verify-ui.mjs 会在跑任何套件之前先调它(import 本文件的 runSentinel)
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOW_MISMATCH = process.argv.includes("--allow-mismatch") || process.env.SENTINEL_ALLOW_MISMATCH === "1";

/** 与各探针一致的取法 —— 哨兵判的必须就是探针要用的, 否则它只是在自娱自乐 */
const WEB = process.env.WEB || (process.env.SOC_DEV ? "http://127.0.0.1:5174" : "http://127.0.0.1:4173");
const API = process.env.API_BASE || "http://127.0.0.1:4173";
const inDevSoc = !!process.env.SOC_DEV;

const checks = [];
const add = (level, name, detail) => { checks.push({ level, name, detail }); };

const sh = (cmd, opts = {}) => {
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }).trim(); }
  catch { return ""; }
};
const origin = (u) => { try { return new URL(u).origin; } catch { return u; } };
const norm = (s) => String(s ?? "").replace(/\\/g, "/").toLowerCase();

// ── ① 我在哪个树 ──
const repoRoot = sh("git rev-parse --show-toplevel");
const branch = sh("git rev-parse --abbrev-ref HEAD");
const head = sh("git rev-parse --short HEAD");
const dirty = sh("git status --porcelain").split("\n").filter(Boolean).length;
if (repoRoot) {
  add("ok", "当前树", `${repoRoot}  (${branch} @ ${head}${dirty ? `, ${dirty} 个未提交` : ""})`);
} else {
  add("fail", "当前树", "不在 git 仓库里 —— 探针的相对路径、.env 解析都无从谈起");
}

// ── ② 页面与 API 是否同源 ──
// token 在 localStorage, 而 localStorage 按 origin 隔离。只改 API_BASE 不改 WEB 时,
// 页面发的请求仍走它自己 origin 的代理 —— 于是"探针的断言打新后端、页面却跑旧代码"。
if (origin(WEB) === origin(API)) {
  add("ok", "页面与 API 同源", `${origin(WEB)}  (localStorage 的 token 不会跨不过去)`);
} else {
  add("warn", "页面与 API 不同源", `页面=${origin(WEB)} API=${origin(API)} —— 页面内部的 fetch 走 ${origin(WEB)} 的代理, 探针自己的断言打 ${origin(API)}; 两边若指向不同的代码树, 断言验的就不是页面在跑的东西`);
}

// ── ③ 后端存活 ──
let health = null;
try {
  const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(5000) });
  health = await r.json().catch(() => null);
  if (r.ok && health?.ok) add("ok", "后端存活", `${API}/health 200 · db=${health.db}${health.degraded ? " · degraded" : ""}`);
  else add("fail", "后端存活", `${API}/health 返回 ${r.status}${health ? ` · ${JSON.stringify(health).slice(0, 120)}` : ""}`);
} catch (e) {
  add("fail", "后端存活", `连不上 ${API} (${String(e?.message || e).slice(0, 80)}) —— 门禁全部会以"页面打不开"收场, 先起服务`);
}

// ── ④ 服务端托管的前端, 是不是本树的产物 ──
// 这是那一晚真正咬人的一条: 4173 跑的是**主仓源码 + 主仓 dist**, 而我在改 worktree ——
// 新按钮明明建好了(类型检查也过), 真浏览器探针却报「未找到 data-control」,
// 差一步就当成"我改错了地方"。
/**
 * 取首页里引用的**第一个**带哈希的产物文件名。
 *
 * ⚠ 前缀不能写死: soc 子应用的首页引用的是 `/soc/assets/xxx.js`, 外壳是 `/assets/xxx.js` ——
 *   我第一版给本地文件传了 "/" 前缀, 于是本地侧解析出空串, 两边"都是空"反而被判成一致。
 *   所以两边用**同一条**宽松规则(找 `assets/<名字>.<js|css>`), 并且**必须判空**:
 *   解析不到就说解析不到, 不能当成"相等"。
 */
function assetOfIndex(html, _prefix) {
  const m = String(html).match(/assets\/([A-Za-z0-9_.-]+)\.(js|css)/);
  return m ? `${m[1]}.${m[2]}` : "";
}
async function checkServedFrontend() {
  if (!repoRoot) return;
  const socLocal = path.join(repoRoot, "web/dist/soc/index.html");
  const shellLocal = path.join(repoRoot, "web/dist/index.html");
  if (inDevSoc) {
    // dev 模式没有哈希产物, 只能靠"谁在端口上"判断(见 ⑤)
    add("ok", "前端产物", "SOC_DEV=1 —— 走 vite dev, 产物一致性跳过(改由进程树判断)");
    return;
  }
  if (!existsSync(socLocal) && !existsSync(shellLocal)) {
    add("fail", "前端产物", `本树没有构建产物(${path.dirname(socLocal)} 不存在) —— 服务端托管的一定是别的树的。先 npm run build:socialsci-vue / npm run build:web`);
    return;
  }
  // 分别比 soc 与外壳两张首页, 任一对不上就报 —— 只比一张会漏掉另一张
  const pairs = [
    ["soc", `${WEB}/soc/index.html`, socLocal],
    ["外壳", `${WEB}/index.html`, shellLocal],
  ];
  const mismatches = [];
  for (const [label, url, localFile] of pairs) {
    if (!existsSync(localFile)) { mismatches.push(`${label}: 本树缺 ${path.relative(repoRoot, localFile)}`); continue; }
    let served = "";
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) { mismatches.push(`${label}: ${url} 返回 ${r.status}`); continue; }
      served = assetOfIndex(await r.text());
    } catch (e) { mismatches.push(`${label}: 取不到 (${String(e?.message || e).slice(0, 60)})`); continue; }
    const local = assetOfIndex(readFileSync(localFile, "utf8"));
    if (!served || !local) { mismatches.push(`${label}: 解析不出产物名(服务端="${served}" 本树="${local}") —— 无法判断, 按不一致处理`); continue; }
    if (served !== local) mismatches.push(`${label}: 服务端=${served} 本树=${local}`);
  }
  if (!mismatches.length) {
    add("ok", "前端产物", `服务端托管的就是本树的产物(${WEB})`);
  } else if (ALLOW_MISMATCH) {
    add("warn", "前端产物", `与本树不一致(--allow-mismatch 放行): ${mismatches.join("; ")}`);
  } else {
    add("fail", "前端产物", `服务端托管的前端**不是本树的产物** —— 探针看到的将不是你在改的代码: ${mismatches.join("; ")}。改过 soc 源码要先 npm run build:socialsci-vue; 或把门禁指向本树(见文件头)`)
  }
}

// ── ⑤ 端口上跑的是哪个树(进程树) ──
function listeningPids(port) {
  const pids = new Set();
  if (process.platform === "win32") {
    for (const line of sh("netstat -ano").split("\n")) {
      // 只认 LISTENING, 且端口要精确匹配(否则 :4173 会被 :41730 之类误命中)
      if (!/LISTENING/i.test(line)) continue;
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (m && Number(m[1]) === port) pids.add(m[2]);
    }
  } else {
    for (const p of sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).split("\n")) if (p.trim()) pids.add(p.trim());
  }
  return [...pids];
}
function cmdlineOf(pid) {
  if (process.platform === "win32") {
    return sh(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`);
  }
  return sh(`ps -p ${pid} -o command=`);
}
function portTreeCheck() {
  const port = Number(new URL(API).port || 80);
  const pids = listeningPids(port);
  if (!pids.length) { add("warn", "端口进程树", `没在 ${port} 上找到监听进程(可能是别的机器/别的命名空间)`); return []; }
  // 一个端口上只该有一个服务; 多个 PID 说明有重复启动
  if (pids.length > 1) add("warn", "端口进程树", `${port} 上同时有 ${pids.length} 个监听进程: ${pids.join(", ")}`);
  const lines = pids.map((pid) => ({ pid, cmd: cmdlineOf(pid) }));
  const known = lines.filter((l) => l.cmd);
  if (!known.length) { add("warn", "端口进程树", `PID ${pids.join(", ")} 的命令行读不到(权限), 无法判断属于哪个树`); return pids; }
  const mine = repoRoot ? known.find((l) => norm(l.cmd).includes(norm(repoRoot))) : null;
  if (mine) {
    add("ok", "端口进程树", `${port} 上的 PID ${mine.pid} 从本树启动`);
  } else if (ALLOW_MISMATCH) {
    add("warn", "端口进程树", `--allow-mismatch 放行: ${port} 上的进程不是从本树启动的 (${known[0].cmd.slice(0, 120)})`);
  } else {
    add("fail", "端口进程树", `${port} 上的 PID ${known[0].pid} **不是从本树启动的** —— 它的命令行里没有 ${repoRoot}。这说明你在改 A 树、服务在跑 B 树(实测: 命令行是 ${known[0].cmd.slice(0, 140)}…)`);
  }
  return pids;
}

// ── ⑥ .env 解析到哪一份 ──
// 探针的子进程(播种子/建连接)按 cwd 找 .env; worktree 里没有 .env 时会**静默**回落到
// env.ts 的默认值 localhost:5432 —— 报错是"连接被拒", 看着像功能坏了。
function envCheck() {
  const cands = [
    process.env.SAG_ENV_FILE,
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), "..", "..", "..", ".env"),
  ].filter(Boolean);
  const hit = cands.find((p) => existsSync(p));
  if (hit) {
    const hasDb = /^DATABASE_URL=/m.test(readFileSync(hit, "utf8"));
    add(hasDb ? "ok" : "warn", ".env 解析", `${hit}${hasDb ? "" : "  ⚠ 里面没有 DATABASE_URL"}`);
  } else {
    add("warn", ".env 解析", `候选都不存在(${cands.join(" | ")}) —— 会回落到 env.ts 的默认 localhost:5432, 报错会以"连接被拒"的形式出现`);
  }
}

/** 目录下最新的 mtime(递归) —— 用于"产物/进程是否比源码旧" */
function newestMtime(dir) {
  let newest = 0, newestFile = "";
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const f = path.join(d, n);
      const st = statSync(f);
      if (st.isDirectory()) { walk(f); continue; }
      if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = f; }
    }
  };
  try { walk(dir); } catch { return { newest: 0, newestFile: "" }; }
  return { newest, newestFile };
}

/** 进程启动时刻(ms) —— Windows 走 CIM 的 CreationDate, 其余走 ps 的 lstart */
function processStartMs(pid) {
  if (process.platform === "win32") {
    const out = sh(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToUniversalTime().ToString('o')"`);
    const t = out ? Date.parse(out) : 0;
    return Number.isFinite(t) ? t : 0;
  }
  const out = sh(`ps -p ${pid} -o lstart=`);
  const t = out ? Date.parse(out) : 0;
  return Number.isFinite(t) ? t : 0;
}

/**
 * 后端进程是否比它的源码旧。
 *
 * ⚠ 2026-09-22 加: 这一条是当晚第二个坑的直接映射 —— 前端产物重建了、源码也提交了,
 *   `verify-version-history` 却仍报「回滚 INSERT 少绑参数」, `project-bundle` 拿不到 zip。
 *   查下去才发现 4173 的后端**已经跑了 23 小时**(启动于上一轮改动之前),
 *   而启动脚本用的是 `tsx` 不是 `tsx watch` —— **它不热重载**。
 *   于是"代码改了、服务还是旧的", 症状是"门禁说我的修复没生效", 极易误判成改错了地方。
 */
function backendFreshnessCheck(pid) {
  if (!repoRoot || !pid) return;
  const started = processStartMs(pid);
  if (!started) { add("warn", "后端新鲜度", `读不到 PID ${pid} 的启动时间, 无法判断是否比源码旧`); return; }
  const srcDir = path.join(repoRoot, "src");
  if (!existsSync(srcDir)) return;
  const { newest, newestFile } = newestMtime(srcDir);
  if (!newest) return;
  const ageMin = Math.round((Date.now() - started) / 60000);
  if (started < newest - 2000) {
    const msg = `后端进程启动于 ${new Date(started).toLocaleString("zh-CN")}(已跑 ${ageMin} 分钟), 而 src/ 里最新的改动是 ${new Date(newest).toLocaleString("zh-CN")}(${path.relative(repoRoot, newestFile)}) —— **服务没在跑你刚改的代码**(启动脚本是 tsx 不是 tsx watch, 不热重载)`;
    if (ALLOW_MISMATCH) add("warn", "后端新鲜度", `--allow-mismatch 放行: ${msg}`);
    else add("fail", "后端新鲜度", `${msg}。重启服务后重跑`);
  } else {
    add("ok", "后端新鲜度", `后端进程(已跑 ${ageMin} 分钟)不早于 src/ 最新改动`);
  }
}

// ── ⑦ 构建产物是否比源码旧 ──
// "改了没生效"最隐蔽的一种: 源码改了但没重建, 探针看的是上一版。
function stalenessCheck() {
  if (inDevSoc || !repoRoot) return;
  const dist = path.join(repoRoot, "web/dist/soc/index.html");
  const srcDir = path.join(repoRoot, "web/socialsci-vue/src");
  if (!existsSync(dist) || !existsSync(srcDir)) return;
  const distAt = statSync(dist).mtimeMs;
  const { newest, newestFile } = newestMtime(srcDir);
  if (!newest) return;
  if (newest > distAt + 1000) {
    add("warn", "产物新鲜度", `soc 源码比构建产物新(${path.relative(repoRoot, newestFile)} 晚 ${Math.round((newest - distAt) / 1000)}s) —— 改动探针看不到, 先 npm run build:socialsci-vue`);
  } else {
    add("ok", "产物新鲜度", "构建产物不比 soc 源码旧");
  }
}

// ── ⑧ dev 端口占用(5174 上可能是另一个树的 vite) ──
// 实测踩过: worktree 的 vite 监听 127.0.0.1:5174、主仓的监听 [::1]:5174, **两个都叫 5174**
//   且互不冲突 —— 谁解析 localhost 到 ::1 就把主仓那份前端当成 worktree 的看。
function devPortCheck() {
  if (inDevSoc) return; // dev 模式本就用 5174, 见 ⑤
  const pids = listeningPids(5174);
  if (!pids.length) return;
  const details = pids.map((pid) => {
    const cmd = cmdlineOf(pid);
    const t = repoRoot && norm(cmd).includes(norm(repoRoot)) ? "本树" : "**别的树**";
    return `PID ${pid}(${t})`;
  });
  add("warn", "dev 端口占用", `5174 上有 ${pids.length} 个 vite: ${details.join(", ")} —— 本次门禁打 ${origin(WEB)} 不受影响, 但任何指向 localhost:5174 的检查会拿到不确定的那一份`);
}

let apiPid = "";
if (repoRoot) {
  await checkServedFrontend();
  const pids = portTreeCheck();
  apiPid = pids[0] ?? "";
}
backendFreshnessCheck(apiPid);
envCheck();
stalenessCheck();
devPortCheck();

// ── 输出 ──
const ICON = { ok: "  ok  ", warn: " warn ", fail: "FAIL  " };
export async function runSentinel({ print = true } = {}) {
  if (print) {
    console.log("── 环境哨兵 ──");
    for (const c of checks) console.log(`${ICON[c.level]}${c.name} — ${c.detail}`);
  }
  const fail = checks.filter((c) => c.level === "fail");
  const warn = checks.filter((c) => c.level === "warn");
  return { ok: fail.length === 0, checks, fail, warn };
}

const { ok, fail, warn } = await runSentinel({ print: false });

/**
 * 只有**直接跑**这个文件时才当 CLI。
 *
 * ⚠ 这一层守卫是必须的: verify-ui.mjs 会 `import` 本文件拿 runSentinel, 而 ESM 的
 *   模块顶层代码**在被 import 时照样执行** —— 没有守卫的话, 下面那个 process.exit(1)
 *   会在 import 那一刻就把门禁进程杀掉, 于是中止发生了、但停在哨兵的消息上,
 *   调用方(caller)自己的说明与横幅一句都打不出来。
 *   行为"看着对"(确实中止了), 原因是错的 —— 这种最容易被当成没问题。
 */
const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  console.log("── 环境哨兵 ──");
  console.log(`  树: ${repoRoot || "(未知)"}  ·  页面: ${WEB}  ·  API: ${API}`);
  for (const c of checks) console.log(`${ICON[c.level]}${c.name} — ${c.detail}`);
  console.log("");
  if (fail.length) {
    console.log(`❌ 环境哨兵: ${fail.length} 项不一致 —— 先修这些再跑门禁, 否则下面十几分钟验的可能不是你在改的代码。`);
    console.log(`   (确实要故意跨树验证: 加 --allow-mismatch; 走 verify-ui 时用 --no-sentinel)`);
    process.exit(1);
  }
  console.log(`✅ 环境哨兵通过${warn.length ? `(${warn.length} 条提醒)` : ""}`);
}
export { checks as sentinelChecks };
