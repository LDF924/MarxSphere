// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// electron/main.ts — MarxSphere 桌面端主进程（V397）
// 职责: 单实例锁 / 端口预检 / 引导页(onboarding) / spawn 后端 / 健康轮询 / 崩溃重启 / 错误页
import { app, BrowserWindow, ipcMain, dialog, screen } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs, { cpSync, rmSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";

const DEFAULT_PORT = 4173;
const MCP_DEFAULT_PORT = 4174;

/** V414: 生成 JWT 签名密钥（crypto 随机 32 字节 hex，等价 openssl rand -hex 32，跨平台无需外部命令） */
function generateJwtSecret(): string {
  return randomBytes(32).toString("hex");
}

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
  // V413: 安装目录写权限检查 — Program Files 只读时用 icacls 提权放开（普通用户可解压）
  try {
    const probe = path.join(nm, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
  } catch {
    console.log("[desktop] 安装目录不可写，尝试 icacls 放开权限（需 UAC）...");
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-Command",
        `Start-Process icacls -ArgumentList '\\"${root}\\"','/grant','*S-1-5-32-545:(OI)(CI)F','/T','/Q' -Verb RunAs -Wait`],
        { timeout: 60_000, windowsHide: true, stdio: "pipe" });
      console.log("[desktop] icacls 权限放开完成");
    } catch (e: any) {
      console.error("[desktop] icacls 提权失败:", String(e?.message || e).slice(0, 120));
      return false;
    }
    // 重试写入
    try {
      fs.mkdirSync(nm, { recursive: true });
      const probe = path.join(nm, ".write-test");
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe, { force: true });
    } catch {
      console.error("[desktop] 权限放开后仍不可写");
      return false;
    }
  }
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
  // 依赖就绪检查（提前执行，不等 DB——否则 DB 未就绪时解压永不触发）
  if (!(await ensureBackendDeps())) {
    showErrorPage("后端依赖缺失", "未找到后端运行依赖（node_modules）。请重新安装 MarxSphere。");
    return;
  }
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
  // V415: 启动前二次端口确认 — 探测到已被占用（探测-启动间竞态/残留进程）→ 提示而非盲目 bind 失败
  const busy = await probeTcp(port);
  if (busy) {
    const owner = probePortOwnerSync(port);
    const hint = owner && owner !== "unknown" ? `（进程: ${owner}）` : "";
    showErrorPage("后端服务已退出", `端口 ${port} 已被其他程序占用${hint}。\n` +
      `这通常是旧版 MarxSphere 实例仍在运行，或残留进程占用了端口。\n` +
      `请先关闭旧实例（任务管理器结束 MarxSphere.exe），再重新打开本应用。\n` +
      `下方状态面板会实时显示端口/数据库状态。`);
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
    if (backendStopping || !mainWindow) return;
    // V415: 退出原因分诊 — 端口被他人占用（旧实例/残留进程）→ 不盲目重启，提示用户
    const portBusy = probeTcp(currentPort);
    portBusy.then((busy) => {
      if (busy) {
        const owner = probePortOwnerSync(currentPort);
        const hint = owner && owner !== "unknown" ? `（进程: ${owner}）` : "";
        showErrorPage("后端服务已退出", `端口 ${currentPort} 已被其他程序占用${hint}。` +
          `\n这通常是旧版 MarxSphere 实例仍在运行，或残留进程占用了端口。\n` +
          `请先关闭旧实例（任务管理器结束 MarxSphere.exe），再重新打开本应用。\n` +
          `下方状态面板会实时显示端口/数据库状态。`);
        return;
      }
      // 非端口冲突 → 错误页 + 3 秒后自动重启（原逻辑）
      showErrorPage("后端服务已退出", `MarxSphere 后端进程异常退出（code=${code}），应用将自动重启后端。`);
      setTimeout(() => { if (mainWindow && !backendStopping) startBackend(currentPort); }, 3000);
    });
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
  // V416: 错误页雷达探测 — 扫描动画 + 服务节点状态灯（绿=正常/红=占用/黄=异常），右侧文字明细每 3 秒刷新
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{background:#0b1120;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:20px;box-sizing:border-box}
    .box{max-width:640px;padding:24px;text-align:center;width:100%}
    h1{color:#fbbf24;font-size:20px;margin:0 0 12px}
    p{color:#94a3b8;font-size:14px;line-height:1.7;white-space:pre-wrap;margin:0 0 8px}
    .panel{margin-top:16px;text-align:left;background:#111827;border:1px solid #1f2937;border-radius:12px;padding:16px;font-size:13px}
    .panel h3{margin:0 0 12px;color:#fbbf24;font-size:13px;text-align:center}
    /* ── 雷达 ── */
    .radar-wrap{display:flex;gap:18px;align-items:center;justify-content:center;flex-wrap:wrap}
    .radar{position:relative;width:200px;height:200px;border-radius:50%;border:1px solid #1f2937;background:radial-gradient(circle,rgba(16,185,129,.06),rgba(2,6,23,.55));margin:16px;flex-shrink:0}
    .radar-ring{position:absolute;border-radius:50%;border:1px dashed #1f2937}
    .r1{inset:15%}.r2{inset:32%}.r3{inset:49%}
    .radar-sweep{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,rgba(34,211,238,.38),transparent 70deg);animation:sweep 3s linear infinite}
    @keyframes sweep{to{transform:rotate(360deg)}}
    .radar-center{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#fbbf24;font-size:12px;font-weight:700;text-shadow:0 0 12px rgba(251,191,36,.5);letter-spacing:.5px}
    .radar-node{position:absolute;transform:translate(-50%,-50%);display:flex;align-items:center;gap:4px;white-space:nowrap}
    .dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;transition:background .3s,box-shadow .3s}
    .dot.ok{background:#34d399;box-shadow:0 0 9px #34d399}
    .dot.bad{background:#f87171;box-shadow:0 0 9px #f87171;animation:blink 1s infinite}
    .dot.probing{background:#64748b;box-shadow:0 0 6px #64748b}
    @keyframes blink{50%{opacity:.35}}
    .lbl{font-size:10px;color:#94a3b8;max-width:74px;overflow:hidden;text-overflow:ellipsis}
    /* ── 明细列表 ── */
    .radar-detail{min-width:210px;flex:1}
    .row{display:flex;justify-content:space-between;gap:10px;padding:4px 0;color:#94a3b8;font-size:12px}
    .row .ok{color:#34d399}.row .bad{color:#f87171}.row .warn{color:#fbbf24}
    .hint{margin-top:10px;color:#64748b;font-size:11px;line-height:1.6}
  </style></head><body><div class="box"><h1>${title}</h1><p>${message}</p>
  <div class="panel"><h3>🔍 系统雷达（每 3 秒自动扫描）</h3>
    <div class="radar-wrap">
      <div class="radar">
        <div class="radar-ring r1"></div><div class="radar-ring r2"></div><div class="radar-ring r3"></div>
        <div class="radar-sweep"></div>
        <div class="radar-center">MarxSphere</div>
        <div class="radar-node" id="node-port" style="left:50%;top:7%"><span class="dot probing"></span><span class="lbl">后端端口</span></div>
        <div class="radar-node" id="node-mcp" style="left:93%;top:50%;flex-direction:row-reverse"><span class="dot probing"></span><span class="lbl">MCP 端口</span></div>
        <div class="radar-node" id="node-pg" style="left:50%;top:93%"><span class="dot probing"></span><span class="lbl">PostgreSQL</span></div>
        <div class="radar-node" id="node-backend" style="left:7%;top:50%"><span class="dot probing"></span><span class="lbl">后端进程</span></div>
      </div>
      <div class="radar-detail">
        <div class="row"><span>后端端口 ${currentPort}</span><span id="st-port">探测中…</span></div>
        <div class="row"><span>MCP 端口 ${MCP_DEFAULT_PORT + (currentPort - DEFAULT_PORT)}</span><span id="st-mcp">探测中…</span></div>
        <div class="row"><span>PostgreSQL（5540/5432）</span><span id="st-pg">探测中…</span></div>
        <div class="row"><span>后端进程</span><span id="st-backend">探测中…</span></div>
        <div class="hint">提示：端口被占用时请先关闭旧版 MarxSphere（任务管理器结束 MarxSphere.exe）再重新打开。雷达节点：<span style="color:#34d399">●</span>正常 <span style="color:#f87171">●</span>占用/异常 <span style="color:#64748b">●</span>探测中</div>
      </div>
    </div>
  </div></div>
  <script>
    function setNode(id, cls, label) {
      const n = document.getElementById('node-' + id);
      if (!n) return;
      n.querySelector('.dot').className = 'dot ' + cls;
      const lbl = n.querySelector('.lbl');
      if (lbl) lbl.textContent = label;
    }
    async function refresh() {
      try {
        const s = await window.sagDesktop.portProbe();
        if (s.portBusy) {
          setNode('port', 'bad', '占用·' + (s.portOwner || '?'));
          document.getElementById('st-port').innerHTML = '<span class="bad">占用（' + (s.portOwner || '未知进程') + '）</span>';
        } else {
          setNode('port', 'ok', '空闲');
          document.getElementById('st-port').innerHTML = '<span class="ok">空闲 ✓</span>';
        }
        setNode('mcp', s.mcpBusy ? 'bad' : 'ok', s.mcpBusy ? '占用' : '空闲');
        document.getElementById('st-mcp').innerHTML = s.mcpBusy ? '<span class="bad">占用</span>' : '<span class="ok">空闲 ✓</span>';
        setNode('pg', s.dbUp ? 'ok' : 'bad', s.dbUp ? '就绪' : '未检测');
        document.getElementById('st-pg').innerHTML = s.dbUp ? '<span class="ok">已就绪 ✓</span>' : '<span class="warn">未检测到</span>';
        setNode('backend', s.backendRunning ? 'ok' : 'bad', s.backendRunning ? '运行中' : '未运行');
        document.getElementById('st-backend').innerHTML = s.backendRunning ? '<span class="ok">运行中 ✓</span>' : '<span class="bad">未运行</span>';
      } catch (e) { /* 桥未就绪则保持探测中 */ }
    }
    refresh();
    setInterval(refresh, 3000);
  </script></body></html>`;
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

/** V415: 查端口占用者进程名（netstat -ano → PID → tasklist）。返回 null=空闲；"unknown"=有占用但查不到进程名 */
function probePortOwnerSync(port: number): string | null {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const line = out.split("\n").find((l) => l.includes(":" + port) && l.includes("LISTENING"));
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (!pid || !/^\d+$/.test(pid)) return "unknown";
    const tl = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const m = tl.match(/"([^"]+)"/);
    return m && m[1] ? m[1] : "unknown";
  } catch {
    return "unknown";
  }
}

/** V415: 错误页端口/数据库状态探测（前端每 3s 调用，让用户看清系统状态） */
ipcMain.handle("port:probe", async () => {
  const mcpPort = MCP_DEFAULT_PORT + (currentPort - DEFAULT_PORT);
  const out: Record<string, unknown> = {
    port: currentPort,
    portBusy: false,
    portOwner: null,
    mcpPort,
    mcpBusy: false,
    pg5540: false,
    pg5432: false,
    dbUp: false,
    backendRunning: backendProc !== null && backendProc.exitCode === null,
  };
  try {
    out.portBusy = await probeTcp(currentPort);
    if (out.portBusy) out.portOwner = probePortOwnerSync(currentPort);
    out.mcpBusy = await probeTcp(mcpPort);
    out.pg5540 = await probeTcp(5540);
    out.pg5432 = await probeTcp(5432);
    out.dbUp = Boolean(out.pg5540) || Boolean(out.pg5432);
  } catch (e: any) {
    console.error("[desktop] port:probe 异常:", String(e?.message || e).slice(0, 120));
  }
  return out;
});

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
      sendStage("准备下载 PostgreSQL 便携版（约 300MB）…", 0, "download");
      // dlSpawn 提到循环外：pgvector 下载段（下方）也要用（原作用域只在循环内 → ReferenceError）
      const { spawn: dlSpawn } = require("node:child_process") as typeof import("node:child_process");
      for (const m of mirrors) {
        try {
          // 流式下载带进度（curl 输出进度条解析；Windows 需 curl.exe 全名）
          const dl = dlSpawn("curl.exe", ["-L", "-o", zipPath, m, "--progress-bar", "--retry", "2"], { windowsHide: true });
          dl.stderr.on("data", (buf: Buffer) => {
            const line = buf.toString();
            const m2 = line.match(/(\d+(?:\.\d+)?)%/);
            if (m2) sendStage(`下载 PostgreSQL（${m2[1]}%）…`, Number(m2[1]), "download");
            else if (!line.includes("%")) dlErr = line.trim().slice(0, 120);
          });
          dlOk = await new Promise<boolean>((resolve) => {
            dl.on("close", (c: number) => resolve(c === 0));
            // curl.exe 启动失败（ENOENT 等）→ 不卡死，立即失败
            dl.on("error", (e: Error) => { dlErr = "curl 启动失败: " + e.message.slice(0, 80); resolve(false); });
          });
          if (dlOk) { sendStage("✓ 下载完成", 100, "download"); break; }
        } catch { /* 试下一个镜像 */ }
      }
      if (!dlOk) return { ok: false, error: `PostgreSQL 下载失败（${dlErr || "网络问题"}）。请手动下载后放入 ${pgDir}\\pg.zip，或改用 Docker。` };
      sendStage("解压 PostgreSQL（约 300MB，需几分钟）…", 30, "install");
      // 流式解压带进度（ZipFile 逐文件计数，与 node_modules 解压一致）
      const { spawn: unzipSpawn } = require("node:child_process") as typeof import("node:child_process");
      const pgUnzipScript = `
$zip = '${zipPath}'
$dst = '${pgDir}'
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
  if ($done % 100 -eq 0 -or $done -eq $total) { Write-Output "PGUNZIP:$done/$total" }
}
$arc.Dispose()
Write-Output "PGDONE:$done/$total"
`;
      const unzip = unzipSpawn("powershell.exe", ["-NoProfile", "-Command", pgUnzipScript], { windowsHide: true });
      let unzipDone = false;
      unzip.stdout.on("data", (buf: Buffer) => {
        const line = buf.toString().trim();
        const m = line.match(/PGUNZIP:(\d+)\/(\d+)/) || line.match(/PGDONE:(\d+)\/(\d+)/);
        if (m) {
          const d = Number(m[1]), t = Number(m[2]);
          const pct = t > 0 ? Math.round(d / t * 100) : 0;
          sendStage(`解压 PostgreSQL… ${d.toLocaleString()}/${t.toLocaleString()}（${pct}%，约需 ${Math.max(1, Math.round((t - d) / 200))} 分钟）`, 30 + pct * 0.3, "install");
          if (line.startsWith("PGDONE")) {
            unzipDone = true;
            sendStage("✓ PostgreSQL 解压完成", 60, "install");
          }
        }
      });
      const unzipOk = await new Promise<boolean>((resolve) => {
        unzip.on("close", () => resolve(unzipDone));
        unzip.on("error", () => resolve(false));
        setTimeout(() => { if (!unzip.exitCode) { unzip.kill(); resolve(false); } }, 1_200_000); // 20 分钟超时
      });
      if (!unzipOk) return { ok: false, error: "PostgreSQL 解压超时/失败，请手动解压 pg.zip 后重试" };
      fs.rmSync(zipPath, { force: true });
      // 安装 pgvector 扩展（Windows 预编译，需与 PG 16 匹配）
      const pgBinReal = path.join(pgDir, "pgsql", "bin");
      const vectorControl = path.join(pgDir, "pgsql", "share", "extension", "vector.control");
      if (!fs.existsSync(vectorControl)) {
        sendStage("安装 pgvector 扩展…", 62, "install");
        const vecUrl = "https://github.com/andreiramani/pgvector_pgsql_windows/releases/download/0.8.6_16/vector.v0.8.6-pg16.zip";
        const vecZip = path.join(pgDir, "pgvector.zip");
        const vecOk = await new Promise<boolean>((resolve) => {
          const p = dlSpawn("curl.exe", ["-L", "-o", vecZip, vecUrl, "--retry", "2"], { windowsHide: true });
          p.on("close", (c: number) => resolve(c === 0));
          p.on("error", () => resolve(false));
          setTimeout(() => { if (!p.exitCode) { p.kill(); resolve(false); } }, 120_000);
        });
        if (!vecOk) return { ok: false, error: "pgvector 下载失败（网络问题）" };
        const vecUnzipOk = await new Promise<boolean>((resolve) => {
          const p = unzipSpawn("powershell.exe", ["-NoProfile", "-Command",
            `Expand-Archive -LiteralPath '${vecZip}' -DestinationPath '${pgDir}\\pgvector-tmp' -Force`],
            { windowsHide: true });
          p.on("close", (c: number) => resolve(c === 0));
          p.on("error", () => resolve(false));
          setTimeout(() => { if (!p.exitCode) { p.kill(); resolve(false); } }, 120_000);
        });
        if (!vecUnzipOk) return { ok: false, error: "pgvector 解压失败" };
        // 复制 lib/ → pgsql/lib/, share/ → pgsql/share/
        try {
          const cp = (src: string, dst: string) => {
            if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
            for (const f of fs.readdirSync(src)) {
              fs.copyFileSync(path.join(src, f), path.join(dst, f));
            }
          };
          cp(path.join(pgDir, "pgvector-tmp", "lib"), path.join(pgBinReal, "..", "lib"));
          cp(path.join(pgDir, "pgvector-tmp", "share", "extension"), path.join(pgDir, "pgsql", "share", "extension"));
          fs.rmSync(path.join(pgDir, "pgvector-tmp"), { recursive: true, force: true });
          fs.rmSync(vecZip, { force: true });
        } catch (e: any) {
          return { ok: false, error: "pgvector 复制失败: " + String(e?.message || e).slice(0, 100) };
        }
      }
    }
    // 初始化（幂等，异步不阻塞）
    const dataDir = path.join(pgDir, "data");
    if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
      sendStage("初始化数据库（VM/低配机需几分钟）…", 50);
      const { spawn: initSpawn } = require("node:child_process") as typeof import("node:child_process");
      const initOk = await new Promise<boolean>((resolve) => {
        const p = initSpawn(path.join(pgBin, "initdb.exe"), ["-D", dataDir, "-U", "sag_lite", "-A", "trust", "-E", "UTF8", "--locale=C"], { windowsHide: true });
        p.on("close", (c: number) => resolve(c === 0));
        p.on("error", () => resolve(false));
        setTimeout(() => { if (!p.exitCode) { p.kill(); resolve(false); } }, 600_000); // 10 分钟超时
      });
      if (!initOk) return { ok: false, error: "PostgreSQL 初始化失败/超时" };
    }
    // 启动（幂等，异步 + 轮询等待就绪）
    sendStage("启动 PostgreSQL…", 70);
    try {
      execFileSync(path.join(pgBin, "pg_isready.exe"), ["-h", "127.0.0.1", "-p", "5540"], { timeout: 5000, windowsHide: true, stdio: "pipe" });
    } catch {
      const { spawn: pgSpawn } = require("node:child_process") as typeof import("node:child_process");
      const startOk = await new Promise<boolean>((resolve) => {
        const p = pgSpawn(path.join(pgBin, "pg_ctl.exe"), ["-D", dataDir, "-l", path.join(pgDir, "pg.log"), "-o", "-p 5540", "start"], { windowsHide: true });
        p.on("close", (c: number) => resolve(c === 0));
        p.on("error", () => resolve(false));
        setTimeout(() => { if (!p.exitCode) { p.kill(); resolve(false); } }, 120_000); // 2 分钟超时
      });
      if (!startOk) {
        // pg_ctl 启动可能异步就绪（进程已起但端口未开）——轮询 60s
        let ready = false;
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            execFileSync(path.join(pgBin, "pg_isready.exe"), ["-h", "127.0.0.1", "-p", "5540"], { timeout: 3000, windowsHide: true, stdio: "pipe" });
            ready = true; break;
          } catch { /* 未就绪继续等 */ }
        }
        if (!ready) return { ok: false, error: "PostgreSQL 启动失败/超时（请检查 pg-local\\pg.log）" };
      }
    }
    // 建库 + pgvector（异步）
    sendStage("创建数据库 + pgvector 扩展…", 85);
    const { spawn: sqlSpawn } = require("node:child_process") as typeof import("node:child_process");
    const runSql = (sql: string) => new Promise<boolean>((resolve) => {
      const p = sqlSpawn(path.join(pgBin, "psql.exe"), ["-h", "127.0.0.1", "-p", "5540", "-U", "sag_lite", "-d", "postgres", "-c", sql], { windowsHide: true });
      p.on("close", (c: number) => resolve(c === 0));
      p.on("error", () => resolve(false));
      setTimeout(() => { if (!p.exitCode) { p.kill(); resolve(false); } }, 60_000);
    });
    await runSql("CREATE DATABASE sag_lite OWNER sag_lite");
    // 建扩展在 sag_lite 库
    const runSqlDb = (db: string, sql: string) => new Promise<boolean>((resolve) => {
      const p = sqlSpawn(path.join(pgBin, "psql.exe"), ["-h", "127.0.0.1", "-p", "5540", "-U", "sag_lite", "-d", db, "-c", sql], { windowsHide: true });
      p.on("close", (c: number) => resolve(c === 0));
      p.on("error", () => resolve(false));
      setTimeout(() => { if (!p.exitCode) { p.kill(); resolve(false); } }, 60_000);
    });
    await runSqlDb("sag_lite", "CREATE EXTENSION IF NOT EXISTS vector");
    sendStage("✓ PostgreSQL 就绪", 100);
    // 写 .env（引导页 dataRoot 下的 .env）— 本地 PG 模式强制 DATABASE_URL=5540（覆盖旧值）
    const envFile = path.join(dataRoot, ".env");
    if (fs.existsSync(envFile)) {
      let env = fs.readFileSync(envFile, "utf8");
      // 移除已有的 DATABASE_URL（可能指向 5432 旧配置），强制设为本地 PG 5540
      env = env.split("\n").filter((l) => !l.startsWith("DATABASE_URL=")).join("\n");
      env += `\nDATABASE_URL=postgres://sag_lite@127.0.0.1:5540/sag_lite\n`;
      fs.writeFileSync(envFile, env);
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
    // 无 Docker → ① 先尝试自动安装 Docker Desktop（winget 静默安装，异步不阻塞）
    console.log("[desktop] 未检测到 Docker，尝试自动安装 Docker Desktop ...");
    const sendDockerStage = (stage: string, pct: number) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send("pg-progress", { stage, pct, type: "install" });
      }
    };
    const { spawn: wingetSpawn } = require("node:child_process") as typeof import("node:child_process");
    sendDockerStage("正在安装 Docker Desktop（约 5-10 分钟，需外网）…", 15);
    const wingetOk = await new Promise<boolean>((resolve) => {
      const p = wingetSpawn("winget", ["install", "Docker.DockerDesktop", "--accept-source-agreements", "--accept-package-agreements", "--silent", "--disable-interactivity"], { windowsHide: true });
      p.on("close", (c: number) => resolve(c === 0));
      p.on("error", () => resolve(false));
      setTimeout(() => { if (!p.exitCode) { p.kill(); resolve(false); } }, 900_000); // 15 分钟超时
    });
    if (wingetOk) {
      console.log("[desktop] Docker Desktop 安装完成，等待启动 ...");
      sendDockerStage("Docker 已安装，等待启动（需 WSL2/虚拟化）…", 60);
      const waitStart = Date.now();
      let dockerReady = false;
      while (Date.now() - waitStart < 600_000) {
        try {
          const ok = execFileSync("docker", ["--version"], { timeout: 5000, windowsHide: true, stdio: "pipe" });
          if (ok) { dockerCmd = "docker"; dockerReady = true; break; }
        } catch { /* 未就绪继续等 */ }
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (dockerReady) sendDockerStage("✓ Docker 就绪", 80);
    } else {
      console.log("[desktop] Docker 自动安装失败（无 WSL2/嵌套虚拟化/注册限制）");
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
    // docker compose up -d（异步不阻塞；首次拉镜像可能几分钟）
    const { spawn: composeSpawn } = require("node:child_process") as typeof import("node:child_process");
    const composeOk = await new Promise<boolean>((resolve) => {
      const p = composeSpawn(dockerCmd, ["compose", "-f", composeDst, "up", "-d"], { windowsHide: true });
      p.on("close", (c: number) => resolve(c === 0));
      p.on("error", () => resolve(false));
      setTimeout(() => { if (!p.exitCode) { p.kill(); resolve(false); } }, 600_000); // 10 分钟超时
    });
    if (!composeOk) throw new Error("compose up 失败");
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
  // 已有 .env 先读入 map：本次未重新填写的键保留旧值（重复保存不丢失 LLM key 等）
  const prev = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const kv = new Map<string, string>();
  for (const line of prev.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const put = (k: string, v?: string) => { if (v !== undefined && v !== "") kv.set(k, v); };
  // 数据库端口: 探测到的优先（5540 docker > 5432 本机）
  const pgPort = input.pgPort || 5540;
  put("HTTP_HOST", "127.0.0.1");
  put("DATABASE_URL", `postgres://sag_lite:sag_lite_pass@127.0.0.1:${pgPort}/sag_lite`);
  put("LLM_API_KEY", input.llmApiKey?.trim());
  put("LLM_BASE_URL", input.llmBaseUrl?.trim());
  put("LLM_MODEL", input.llmModel?.trim());
  put("EMBEDDING_API_KEY", input.embeddingApiKey?.trim());
  put("COGNEE_PYTHON", input.cogneePython?.trim());
  put("EMPIRICAL_PYTHON", input.empiricalPython?.trim());
  // V414: 桌面端默认开启登录认证（已有 .env 且手动配置过则保留用户选择）
  if (!kv.has("SAG_AUTH_ENABLED")) kv.set("SAG_AUTH_ENABLED", "true");
  // JWT_SECRET: 已存在不重新生成（否则重启后已登录会话全部失效）
  if (!kv.has("JWT_SECRET")) kv.set("JWT_SECRET", generateJwtSecret());
  kv.set("SAG_ROOT", resourceRoot());
  fs.writeFileSync(envFile, [...kv.entries()].map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf-8");
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
