// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// electron/main.ts — MarxSphere 桌面端主进程（V397）
// 职责: 单实例锁 / 端口预检 / 引导页(onboarding) / spawn 后端 / 健康轮询 / 崩溃重启 / 错误页
import { app, BrowserWindow, ipcMain, dialog, screen } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs, { cpSync, rmSync } from "node:fs";
import path from "node:path";
import http from "node:http";

const DEFAULT_PORT = 4173;
const MCP_DEFAULT_PORT = 4174;

/** 运行时根目录: userData/sag-root（可写数据全部落这里, 与安装目录分离） */
function sagRoot(): string {
  const root = path.join(app.getPath("userData"), "sag-root");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** 资源根目录: 安装目录 resources/sag（打包后由 electron-builder extraResources 提供） */
function resourceRoot(): string {
  // dev: 项目根; prod: resources/sag
  if (app.isPackaged) return path.join(process.resourcesPath, "sag");
  return path.resolve(__dirname, "..", "..");
}

/** 确保后端子进程依赖就绪: node_modules 缺失时从 node_modules.zip 解压（NSIS 大目录安装易截断） */
async function ensureBackendDeps(): Promise<boolean> {
  const root = resourceRoot();
  const nm = path.join(root, "node_modules");
  const zip = path.join(root, "node_modules.zip");
  if (fs.existsSync(path.join(nm, "fastify", "package.json"))) return true; // 已就绪
  if (!fs.existsSync(zip)) return false; // 无压缩包且无依赖 — 无法启动
  try {
    console.log("[desktop] 首次启动: 解压 node_modules（约 3-10 分钟，2.6 万文件）...");
    const { execFileSync, spawn } = require("node:child_process") as typeof import("node:child_process");
    fs.mkdirSync(nm, { recursive: true });
    const sysTar = "C:/Windows/System32/tar.exe";
    const tmp = path.join(root, "node_modules_tmp");
    rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    // 流式解压（带进度）：PowerShell 逐文件解压并输出 "进度:已解/总数"
    // 进度通过 IPC 发给引导页（extract-progress）
    const psScript = `
$zip = '${zip}'
$dst = '${tmp}'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$arc = [System.IO.Compression.ZipFile]::OpenRead($zip)
$total = $arc.Entries.Count
$done = 0
foreach ($e in $arc.Entries) {
  $target = Join-Path $dst $e.FullName
  if ($e.FullName.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $target | Out-Null; continue }
  New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
  $done++
  if ($done % 500 -eq 0 -or $done -eq $total) { Write-Output "PROGRESS:$done/$total" }
}
$arc.Dispose()
Write-Output "DONE:$done/$total"
`;
    let extracted = false;
    const extractProc = spawn("powershell.exe", ["-NoProfile", "-Command", psScript], { windowsHide: true });
    let extractErr = "";
    extractProc.stdout.on("data", (buf: Buffer) => {
      const line = buf.toString().trim();
      const m = line.match(/PROGRESS:(\d+)\/(\d+)/) || line.match(/DONE:(\d+)\/(\d+)/);
      if (m) {
        const done = Number(m[1]), total = Number(m[2]);
        const pct = total > 0 ? Math.round(done / total * 100) : 0;
        // IPC 发进度到引导页
        for (const w of BrowserWindow.getAllWindows()) {
          w.webContents.send("extract-progress", { done, total, pct });
        }
        if (line.startsWith("DONE")) {
          extracted = true;
          // 强制补发 100% 进度（防尾部进度未刷新导致 UI 卡 9x%）
          for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send("extract-progress", { done: total, total, pct: 100 });
          }
        }
      } else if (line) { extractErr += line + "\n"; }
    });
    extractProc.stderr.on("data", (buf: Buffer) => { extractErr += buf.toString(); });
    const extractOk = await new Promise<boolean>((resolve) => {
      extractProc.on("close", () => resolve(extracted));
      setTimeout(() => { if (!extracted) { extractProc.kill(); resolve(false); } }, 1_200_000); // 20 分钟超时
    });
    if (!extractOk) {
      console.log("[desktop] 流式解压失败，降级 tar.exe ...");
      execFileSync("powershell.exe", ["-NoProfile", "-Command",
        `& '${sysTar}' -x -f '${zip}' -C '${tmp}'`],
        { windowsHide: true, stdio: "pipe", timeout: 600_000 });
      extracted = true;
    }
    // 解出 node_modules/ 子目录（zip 内第一层是 node_modules/）→ 移到目标
    if (extracted) {
      // Expand-Archive 解出的目录名可能与 zip 内一致（node_modules），也可能有差异——
      // 递归找 fastify/package.json 所在目录作为 node_modules 根
      let src = path.join(tmp, "node_modules");
      if (!fs.existsSync(path.join(src, "fastify", "package.json"))) {
        // 搜索实际位置（zip 结构差异容错）
        const walk = (d: string): string | null => {
          try {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              const p = path.join(d, e.name);
              if (e.isDirectory()) {
                if (fs.existsSync(path.join(p, "fastify", "package.json"))) return p;
                const r = walk(p);
                if (r) return r;
              }
            }
          } catch { /* 权限跳过 */ }
          return null;
        };
        src = walk(tmp) ?? src;
      }
      if (fs.existsSync(src)) {
        rmSync(nm, { recursive: true, force: true });
        try {
          fs.renameSync(src, nm);
        } catch {
          cpSync(src, nm, { recursive: true });
        }
      }
    }
    rmSync(tmp, { recursive: true, force: true });
    return fs.existsSync(path.join(nm, "fastify", "package.json"));
  } catch (e: any) {
    console.error("[desktop] node_modules 解压失败:", String(e?.message || e).slice(0, 150));
    return false;
  }
}

let backendProc: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let currentPort = DEFAULT_PORT;
let backendStopping = false;

// ─── 单实例锁 ───
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void bootstrap();
}

async function bootstrap() {
  await app.whenReady();
  const port = await probePort();
  if (port === null) {
    showErrorPage("端口 " + DEFAULT_PORT + " 被占用", "检测到 4173 端口已被其他程序占用。可能是旧版 MarxSphere 实例仍在运行，请先关闭后再启动本应用。");
    return;
  }
  currentPort = port;
  createWindow();
  // 等待引导页完全加载（did-finish-load）——确保解压/进度 IPC 事件不丢失（引导页 ready 前发的事件收不到）
  await waitForOnboardingReady();
  // DB 就绪检查: 未就绪则等待引导页完成数据库启动后再拉起后端（避免后端闪退循环）
  const dbReady = await waitForDbReady(port, 0);
  if (dbReady) void startBackend(port);
  else {
    // 引导页负责数据库启动；DB 就绪后由引导页触发 backend:start
    console.log("[desktop] 数据库未就绪 — 等待引导页完成数据库启动");
  }
}

/** 等待引导页 did-finish-load（最多 15s；解压进度事件需在页面 ready 后发出） */
function waitForOnboardingReady(): Promise<void> {
  return new Promise((resolve) => {
    const w = mainWindow;
    if (!w) return resolve();
    if (w.webContents.isLoading()) {
      w.webContents.once("did-finish-load", () => resolve());
      setTimeout(resolve, 15_000); // 兜底：15s 后不等了
    } else resolve();
  });
}

/** 探测数据库就绪（5540/5432），最多等 30s（引导页可能正在启动数据库/用户手动启动 Docker） */
function waitForDbReady(port: number, attempt: number): Promise<boolean> {
  return new Promise((resolve) => {
    const check = async () => {
      const ok = (await probeTcp(5540)) || (await probeTcp(5432));
      if (ok) return resolve(true);
      if (attempt >= 15) return resolve(false); // 30s 未就绪 → 引导页接管
      setTimeout(() => { void (async () => { const r = await waitForDbReady(port, attempt + 1); resolve(r); })(); }, 2000);
    };
    void check();
  });
}

/** 端口预检: 4173 空闲则用, 被占则递增（最多 +10）; 返回 null 表示全部被占 */
function probePort(): Promise<number | null> {
  return new Promise((resolve) => {
    const tryPort = (p: number) => {
      if (p > DEFAULT_PORT + 10) return resolve(null);
      // 用 TCP connect 探测而非 bind 探测:
      // Windows 允许 0.0.0.0:4173 与 127.0.0.1:4173 共存, bind 探测会误判空闲
      const sock = net.connect({ host: "127.0.0.1", port: p, timeout: 1000 });
      sock.once("connect", () => { sock.destroy(); tryPort(p + 1); }); // 有服务在听 → 占用
      sock.once("error", () => { sock.destroy(); resolve(p); });      // 拒绝连接 → 空闲
    };
    tryPort(DEFAULT_PORT);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: "MarxSphere 马研星环",
    backgroundColor: "#0b1120",
    autoHideMenuBar: true,
    // V411: 先隐藏窗口，渲染就绪后再显示（防启动白屏/离屏窗口残留）
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // V411: 渲染进程首次就绪后再显示窗口（避免窗口创建即显示但内容未渲染的闪烁/离屏问题）
  mainWindow.once("ready-to-show", () => {
    if (mainWindow) {
      // 窗口位置校验：确保在屏幕可见区域内（异常退出后窗口可能残留屏幕外 -25600,-25600）
      const bounds = mainWindow.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const visible = display.workArea;
      const onScreen = bounds.x >= visible.x - 50 && bounds.y >= visible.y - 50 &&
        bounds.x < visible.x + visible.width && bounds.y < visible.y + visible.height;
      if (!onScreen) mainWindow.center();
      mainWindow.show();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  // 初始显示引导页（本地文件）, 后端就绪后切到主界面
  void mainWindow.loadFile(path.join(__dirname, "resources", "onboarding.html"));
  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) void import("electron").then(({ shell }) => shell.openExternal(url));
    return { action: "deny" };
  });
}

/** 启动后端子进程（ELECTRON_RUN_AS_NODE 复用内置 Node 跑编译产物） */
async function startBackend(port: number) {
  const root = resourceRoot();
  const dataRoot = sagRoot();
  // 依赖就绪检查: node_modules 缺失时从 tgz 解压（首次启动）
  if (!(await ensureBackendDeps())) {
    showErrorPage("后端依赖缺失", "未找到后端运行依赖（node_modules）。请重新安装 MarxSphere。");
    return;
  }
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ELECTRON_RUN_AS_NODE: "1",
    HTTP_PORT: String(port),
    HTTP_HOST: "127.0.0.1",
    AGENT_API_BASE: `http://127.0.0.1:${port}`,
    MCP_HTTP_PORT: String(MCP_DEFAULT_PORT + (port - DEFAULT_PORT)),
    SAG_ROOT: root,
    // 未配置 .env（首次启动）时用 preview 模式：不拉 Python MCP 池, 配置保存重启后才进完整模式
    MARXSPHERE_PREVIEW: fs.existsSync(path.join(dataRoot, ".env")) ? "0" : "1",
    // 运行时数据目录（userData 可写）: 通过 SAG_ROOT 指向安装资源 + cwd 指向 userData
    // 注: 后端 dotenv 从 cwd 加载 .env — 引导页写入 userData/sag-root/.env, spawn cwd 设到 dataRoot
  };
  backendProc = spawn(process.execPath, [path.join(root, "dist", "src", "index.js")], {
    env,
    cwd: dataRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  backendProc.stdout?.on("data", (d) => console.log("[backend]", String(d).trimEnd()));
  backendProc.stderr?.on("data", (d) => console.error("[backend]", String(d).trimEnd()));
  backendProc.on("exit", (code) => {
    console.error("[backend] exited code=" + code);
    if (!backendStopping && mainWindow) {
      showErrorPage("后端服务已退出", `MarxSphere 后端进程异常退出（code=${code}），应用将自动重启后端。`);
      // 3 秒后自动重启
      setTimeout(() => { if (mainWindow && !backendStopping) startBackend(currentPort); }, 3000);
    }
  });
  void waitForHealth(port, 0);
}

/** 轮询 /health 直到 DB up, 然后加载主界面 */
function waitForHealth(port: number, attempt: number) {
  if (attempt > 60) { // 60 * 2s = 2min 超时
    showErrorPage("服务启动超时", "后端服务在 2 分钟内未能就绪。请检查 PostgreSQL 是否已启动（docker-compose up -d）。");
    return;
  }
  http.get({ host: "127.0.0.1", port, path: "/health", timeout: 3000 }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      try {
        const j = JSON.parse(body);
        if (j.ok && j.db === "up") {
          if (mainWindow) void mainWindow.loadURL(`http://127.0.0.1:${port}`);
          return;
        }
      } catch {}
      setTimeout(() => waitForHealth(port, attempt + 1), 2000);
    });
  }).on("error", () => setTimeout(() => waitForHealth(port, attempt + 1), 2000));
}

function showErrorPage(title: string, message: string) {
  if (!mainWindow) return;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{background:#0b1120;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .box{max-width:520px;padding:32px;text-align:center}
    h1{color:#fbbf24;font-size:20px;margin:0 0 12px} p{color:#94a3b8;font-size:14px;line-height:1.7}
  </style></head><body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`;
  void mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

// ─── IPC: 引导页配置 ───
/** 端口探测（TCP connect, 1.5s 超时） */
function probeTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 1500 });
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
    s.once("timeout", () => finish(false));
  });
}

/** 探测系统可用的 python 解释器（快速版: 只探测存在的路径 + PATH 首个命中, 单次超时 2s） */
function probeSystemPython(): string[] {
  const found: string[] = [];
  const fixedPaths = [
    "C:/Python312/python.exe", "C:/Python311/python.exe",
    "C:/Program Files/Python312/python.exe", "C:/Program Files/Python311/python.exe",
    "C:/Users/" + (process.env.USERNAME || "") + "/AppData/Local/Programs/Python/Python312/python.exe",
    "C:/Users/" + (process.env.USERNAME || "") + "/AppData/Local/Programs/Python/Python311/python.exe",
  ];
  for (const p of fixedPaths) {
    if (fs.existsSync(p)) found.push(p);
  }
  // PATH 命令: 只测第一个命中（避免 py/python/python3 全测拖时间）
  for (const cmd of ["python", "py"]) {
    try {
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      const r = execFileSync(cmd, ["--version"], { timeout: 2000, windowsHide: true, stdio: "pipe" });
      if (String(r).includes("Python")) { found.push(cmd); break; }
    } catch { /* 不在 PATH */ }
  }
  return [...new Set(found)].slice(0, 4);
}

/** 验证 Python 可执行 + 输出版本 */
function checkPython(p: string): { ok: boolean; version?: string; error?: string } {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const r = execFileSync(p, ["--version"], { timeout: 5000, windowsHide: true, stdio: "pipe" });
    return { ok: true, version: String(r).trim() };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

ipcMain.handle("env:probe", async () => {
  const out: Record<string, unknown> = { root: "", dataRoot: "", port: currentPort };
  try {
    const dataRoot = sagRoot();
    const root = resourceRoot();
    out.root = root;
    out.dataRoot = dataRoot;
    // 1) PostgreSQL 探测: 常见端口 5540(docker) / 5432(本机)
    for (const p of [5540, 5432]) out["pg:" + p] = await probeTcp(p);
    // 2) Neo4j 探测: Graphiti(11001) / Cognee(11003)
    for (const p of [11001, 11003]) out["neo4j:" + p] = await probeTcp(p);
    // 3) Python 探测: 硬编码 venv + 系统 python（单个失败不阻塞整体）
    const candidates = {
      cognee: [""],
      empirical: [""],
    };
    for (const [k, list] of Object.entries(candidates)) {
      try { out["py:" + k] = list.filter((p) => fs.existsSync(p)); } catch { out["py:" + k] = []; }
    }
    try { out["py:system"] = probeSystemPython(); } catch { out["py:system"] = []; }
    // 4) 已有 .env 读取
    const envFile = path.join(dataRoot, ".env");
    if (fs.existsSync(envFile)) out.envExists = true;
    return out;
  } catch (e: any) {
    console.error("[desktop] env:probe 异常:", String(e?.message || e).slice(0, 200));
    // 返回部分结果, 不让渲染进程崩溃
    return out;
  }
});

ipcMain.handle("py:check", async (_e, p: string) => checkPython(String(p || "")));

/** 无 Docker 模式：自动安装本地 PostgreSQL 16 便携版（免管理员，国内镜像）→ 返回端口或错误
 * 注意：pg-local 必须放 dataRoot（userData 可写）——Program Files 只读会导致 initdb ENOENT */
async function installLocalPostgres(dataRoot: string): Promise<{ ok: boolean; error?: string }> {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const pgDir = path.join(dataRoot, "pg-local");
  const pgBin = path.join(pgDir, "pgsql", "bin");
  const pgVer = "16.6";
  // 阶段进度 → 引导页
  const sendStage = (stage: string, pct: number, type: "download" | "install" = "install") => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send("pg-progress", { stage, pct, type });
    }
  };
  try {
    if (!fs.existsSync(path.join(pgBin, "pg_ctl.exe"))) {
      const zipPath = path.join(pgDir, "pg.zip");
      fs.mkdirSync(pgDir, { recursive: true });
      // 官方 EDB 优先（实测国内可达 4MB/s）；华为云镜像（部分文件 404）作备选
      const mirrors = [
        `https://get.enterprisedb.com/postgresql/postgresql-${pgVer}-1-windows-x64-binaries.zip`,
        `https://mirrors.huaweicloud.com/postgresql/v16/postgresql-${pgVer}-1-windows-x64-binaries.zip`,
      ];
      let dlOk = false;
      let dlErr = "";
      sendStage("准备下载 PostgreSQL 便携版（约 300MB）…", 5, "download");
      for (const m of mirrors) {
        try {
          // 流式下载带进度（curl 输出进度条解析；Windows 需 curl.exe 全名）
          const { spawn: dlSpawn } = require("node:child_process") as typeof import("node:child_process");
          const dl = dlSpawn("curl.exe", ["-L", "-o", zipPath, m, "--progress-bar", "--retry", "2"], { windowsHide: true });
          dl.stderr.on("data", (buf: Buffer) => {
            const line = buf.toString();
            const m2 = line.match(/(\d+(?:\.\d+)?)%/);
            if (m2) sendStage(`下载 PostgreSQL（${m2[1]}%）…`, 5 + Number(m2[1]) * 0.35, "download");
            else if (!line.includes("%")) dlErr = line.trim().slice(0, 120);
          });
          dlOk = await new Promise<boolean>((resolve) => {
            dl.on("close", (c: number) => resolve(c === 0));
            // curl.exe 启动失败（ENOENT 等）→ 不卡死，立即失败
            dl.on("error", (e: Error) => { dlErr = "curl 启动失败: " + e.message.slice(0, 80); resolve(false); });
          });
          if (dlOk) break;
        } catch { /* 试下一个镜像 */ }
      }
      if (!dlOk) return { ok: false, error: `PostgreSQL 下载失败（${dlErr || "网络问题"}）。请手动下载后放入 ${pgDir}\\pg.zip，或改用 Docker。` };
      sendStage("解压 PostgreSQL（约 300MB，需几分钟）…", 45, "install");
      // 异步流式解压（不阻塞主进程；VM/低配机可能 5-15 分钟）
      const { spawn: unzipSpawn } = require("node:child_process") as typeof import("node:child_process");
      const unzip = unzipSpawn("powershell.exe", ["-NoProfile", "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${pgDir}' -Force`],
        { windowsHide: true });
      const unzipOk = await new Promise<boolean>((resolve) => {
        unzip.on("close", (c: number) => resolve(c === 0));
        unzip.on("error", () => resolve(false));
        setTimeout(() => { if (!unzip.exitCode) { unzip.kill(); resolve(false); } }, 1_200_000); // 20 分钟超时
      });
      if (!unzipOk) return { ok: false, error: "PostgreSQL 解压超时/失败，请手动解压 pg.zip 后重试" };
      fs.rmSync(zipPath, { force: true });
    }
    // 初始化（幂等）
    const dataDir = path.join(pgDir, "data");
    if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
      sendStage("初始化数据库…", 60);
      execFileSync(path.join(pgBin, "initdb.exe"), ["-D", dataDir, "-U", "sag_lite", "-A", "trust", "-E", "UTF8", "--locale=C"], { timeout: 120_000, windowsHide: true, stdio: "pipe" });
    }
    // 启动（幂等）
    sendStage("启动 PostgreSQL…", 75);
    try {
      execFileSync(path.join(pgBin, "pg_isready.exe"), ["-h", "127.0.0.1", "-p", "5540"], { timeout: 5000, windowsHide: true, stdio: "pipe" });
    } catch {
      execFileSync(path.join(pgBin, "pg_ctl.exe"), ["-D", dataDir, "-l", path.join(pgDir, "pg.log"), "-o", "-p 5540", "start"], { timeout: 30_000, windowsHide: true, stdio: "pipe" });
    }
    // 建库 + pgvector
    sendStage("创建数据库 + pgvector 扩展…", 85);
    execFileSync(path.join(pgBin, "psql.exe"), ["-h", "127.0.0.1", "-p", "5540", "-U", "sag_lite", "-d", "postgres", "-c", "CREATE DATABASE sag_lite OWNER sag_lite"], { timeout: 30_000, windowsHide: true, stdio: "pipe" });
    execFileSync(path.join(pgBin, "psql.exe"), ["-h", "127.0.0.1", "-p", "5540", "-U", "sag_lite", "-d", "sag_lite", "-c", "CREATE EXTENSION IF NOT EXISTS vector"], { timeout: 30_000, windowsHide: true, stdio: "pipe" });
    sendStage("✓ PostgreSQL 就绪", 100);
    // 写 .env（引导页 dataRoot 下的 .env）
    const envFile = path.join(dataRoot, ".env");
    if (fs.existsSync(envFile)) {
      let env = fs.readFileSync(envFile, "utf8");
      if (!env.includes("DATABASE_URL=")) {
        env += `\nDATABASE_URL=postgres://sag_lite@127.0.0.1:5540/sag_lite\n`;
        fs.writeFileSync(envFile, env);
      }
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: "本地 PostgreSQL 安装失败: " + String(e?.message || e).slice(0, 150) };
  }
}

/** 一键启动 PostgreSQL: 优先 Docker；不可用则自动装本地 PostgreSQL（免 Docker，国内友好） */
ipcMain.handle("db:setup", async (_e, mode?: "auto" | "docker" | "local") => {
  const root = resourceRoot();
  const dataRoot = sagRoot();
  const { execFileSync, spawn } = require("node:child_process") as typeof import("node:child_process");
  // 模式选择:
  //   auto   (默认): Docker → 装 Docker → 本地 PG（降级链）
  //   docker       : 只用 Docker（用户选择装 Docker）
  //   local        : 直接用本地 PG（跳过 Docker）
  const wantDocker = mode !== "local";
  const wantLocalFallback = mode !== "docker";
  // 0) 先探测 5540 是否已有 PG（本地模式已跑则直接成功）
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Test-NetConnection -ComputerName 127.0.0.1 -Port 5540 -WarningAction SilentlyContinue).TcpTestSucceeded"], { timeout: 8000, windowsHide: true, stdio: "pipe" });
    // 若 5540 已通，检查是否我们的库
    try {
      const pgCheck = execFileSync("powershell.exe", ["-NoProfile", "-Command", `& { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 5540); $c.Close(); 'ok' }`], { timeout: 5000, windowsHide: true, stdio: "pipe" });
      if (pgCheck.toString().includes("ok")) return { ok: true, note: "数据库端口 5540 已就绪" };
    } catch { /* 继续正常流程 */ }
  } catch { /* 端口未开，继续 */ }
  // 1) 找 docker 命令
  let dockerCmd = ["docker", "docker.exe"].find((c) => {
    try { execFileSync(c, ["--version"], { timeout: 3000, windowsHide: true, stdio: "pipe" }); return true; } catch { return false; }
  });
  // local 模式：跳过 Docker，直接本地 PG
  if (mode === "local") {
    console.log("[desktop] 用户选择本地 PostgreSQL 模式 ...");
    const r = await installLocalPostgres(dataRoot);
    if (r.ok) return { ok: true, note: "已用本地 PostgreSQL（用户选择）" };
    return { ok: false, error: r.error || "本地 PostgreSQL 安装失败" };
  }
  if (!dockerCmd && wantDocker) {
    // 无 Docker → ① 先尝试自动安装 Docker Desktop（winget 静默安装）
    console.log("[desktop] 未检测到 Docker，尝试自动安装 Docker Desktop ...");
    try {
      execFileSync("winget", ["install", "Docker.DockerDesktop", "--accept-source-agreements", "--accept-package-agreements", "--silent", "--disable-interactivity"], { timeout: 600_000, windowsHide: true, stdio: "pipe" });
      console.log("[desktop] Docker Desktop 安装完成，等待启动 ...");
      const waitStart = Date.now();
      while (Date.now() - waitStart < 600_000) {
        try {
          const ok = execFileSync("docker", ["--version"], { timeout: 5000, windowsHide: true, stdio: "pipe" });
          if (ok) { dockerCmd = "docker"; break; }
        } catch { /* 未就绪继续等 */ }
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (e: any) {
      console.log("[desktop] Docker 自动安装失败（无 WSL2/嵌套虚拟化/注册限制）", String(e?.message || e).slice(0, 100));
      dockerCmd = undefined;
    }
  }
  if (!dockerCmd) {
    // ② Docker 装不了/起不来（如 VM 嵌套虚拟化、国内注册门槛）→ 降级本地 PostgreSQL（免 Docker，国内友好）
    if (wantLocalFallback) {
      console.log("[desktop] 使用无 Docker 模式：自动安装本地 PostgreSQL ...");
      const r = await installLocalPostgres(dataRoot);
      if (r.ok) return { ok: true, note: "已用本地 PostgreSQL（无 Docker 模式）" };
      return { ok: false, error: r.error || "无 Docker 模式安装失败" };
    }
    return { ok: false, error: "Docker 不可用（docker 模式下不降级）。请安装 Docker Desktop 后重试，或选择「本地 PostgreSQL」模式。" };
  }
  // 2) 准备 compose 文件（内置 → userData）
  const composeSrc = path.join(root, "docker-compose.yml");
  const composeDst = path.join(dataRoot, "docker-compose.yml");
  if (fs.existsSync(composeSrc)) fs.copyFileSync(composeSrc, composeDst);
  else {
    // 内置缺失时生成标准配置（与项目 docker-compose.yml 一致）
    fs.writeFileSync(composeDst, `services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: sag_lite_postgres
    environment:
      POSTGRES_DB: sag_lite
      POSTGRES_USER: sag_lite
      POSTGRES_PASSWORD: sag_lite_pass
    ports:
      - "5540:5432"
    volumes:
      - sag_lite_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sag_lite -d sag_lite"]
      interval: 5s
      timeout: 5s
      retries: 20
volumes:
  sag_lite_pgdata:
`, "utf-8");
  }
  // 3) docker compose up -d
  try {
    execFileSync(dockerCmd, ["compose", "-f", composeDst, "up", "-d"], { timeout: 120_000, windowsHide: true, stdio: "pipe" });
  } catch (e: any) {
    // Docker 有但 compose 失败（daemon 未跑/镜像拉取失败）→ 视模式降级本地 PostgreSQL
    if (wantLocalFallback) {
      console.log("[desktop] docker compose 失败，降级本地 PostgreSQL ...", String(e?.message || e).slice(0, 100));
      const r = await installLocalPostgres(dataRoot);
      if (r.ok) return { ok: true, note: "已用本地 PostgreSQL（Docker compose 失败降级）" };
      return { ok: false, error: r.error || "docker compose 与本地 PostgreSQL 均失败" };
    }
    return { ok: false, error: "docker compose 启动失败: " + String(e?.message || e).slice(0, 150) };
  }
  // 4) 轮询等待 5540 就绪（最多 60s）
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await probeTcp(5540)) return { ok: true, port: 5540 };
  }
  // 5) Docker 容器起了但 60s 未就绪 → 视模式降级本地 PostgreSQL
  if (wantLocalFallback) {
    console.log("[desktop] Docker PostgreSQL 60s 未就绪，降级本地 PostgreSQL ...");
    const r2 = await installLocalPostgres(dataRoot);
    if (r2.ok) return { ok: true, note: "已用本地 PostgreSQL（Docker 超时降级）" };
    return { ok: false, error: r2.error || "PostgreSQL 容器与本地 PostgreSQL 均未就绪" };
  }
  return { ok: false, error: "PostgreSQL 容器已启动但 60 秒内未就绪，请检查 Docker Desktop 是否正常运行。" };
});

ipcMain.handle("env:save", async (_e, input: { llmApiKey?: string; llmBaseUrl?: string; llmModel?: string; embeddingApiKey?: string; cogneePython?: string; empiricalPython?: string; pgPort?: number }) => {
  const dataRoot = sagRoot();
  const envFile = path.join(dataRoot, ".env");
  // 数据库端口: 探测到的优先（5540 docker > 5432 本机）
  const pgPort = input.pgPort || 5540;
  const lines: string[] = [
    "HTTP_HOST=127.0.0.1",
    `DATABASE_URL=postgres://sag_lite:sag_lite_pass@127.0.0.1:${pgPort}/sag_lite`,
  ];
  if (input.llmApiKey) {
    lines.push(`LLM_API_KEY=${input.llmApiKey.trim()}`);
    if (input.llmBaseUrl) lines.push(`LLM_BASE_URL=${input.llmBaseUrl.trim()}`);
    if (input.llmModel) lines.push(`LLM_MODEL=${input.llmModel.trim()}`);
  }
  if (input.embeddingApiKey) lines.push(`EMBEDDING_API_KEY=${input.embeddingApiKey.trim()}`);
  if (input.cogneePython) lines.push(`COGNEE_PYTHON=${input.cogneePython.trim()}`);
  if (input.empiricalPython) lines.push(`EMPIRICAL_PYTHON=${input.empiricalPython.trim()}`);
  lines.push("SAG_ROOT=" + resourceRoot());
  fs.writeFileSync(envFile, lines.join("\n") + "\n", "utf-8");
  return { ok: true, envFile };
});

ipcMain.handle("backend:restart", async () => {
  if (backendProc) { backendStopping = true; backendProc.kill(); backendStopping = false; }
  startBackend(currentPort);
  return { ok: true };
});

// 引导页数据库就绪后触发后端启动（DB 未就绪时 bootstrap 等待，由本入口拉起）
ipcMain.handle("backend:start", async () => {
  if (!backendProc) startBackend(currentPort);
  return { ok: true };
});

app.on("window-all-closed", () => {
  shutdownBackend();
  if (process.platform !== "darwin") app.quit();
});

// 退出时彻底清理后端子进程（含 Windows 下子进程树, 避免 node 残留占端口）
function shutdownBackend() {
  backendStopping = true;
  if (backendProc && !backendProc.killed) {
    const pid = backendProc.pid;
    backendProc.kill();
    // Windows: taskkill /T 强杀整个进程树（后端 spawn 的 Python MCP 等一并清理）
    try {
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch { /* 进程已退出 */ }
  }
  backendProc = null;
}
process.on("before-quit", shutdownBackend);
process.on("exit", shutdownBackend);
