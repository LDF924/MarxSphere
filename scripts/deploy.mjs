// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// scripts/deploy.mjs — 一键部署脚本（Windows / Linux / macOS）
// 目标: 小白从 clone 到可用的全自动流程，无需手动装 Node/PG/Docker
// 流程: ① 检查 Node（缺则装）→ ② 检查 Docker（缺则提示安装）→ ③ docker compose up（数据库）
//       → ④ npm install → ⑤ .env 准备 → ⑥ 数据库迁移 → ⑦ 种子数据入库 → ⑧ 启动 4173
import { spawn, spawnSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m", RESET = "\x1b[0m";
const ok = (m) => console.log(`${GREEN}✅ ${m}${RESET}`);
const warn = (m) => console.log(`${YELLOW}⚠️  ${m}${RESET}`);
const fail = (m) => console.log(`${RED}❌ ${m}${RESET}`);
const isWin = process.platform === "win32";

// ── ① Node 检查/安装 ──
function ensureNode() {
  try {
    const v = execSync("node --version", { encoding: "utf8" }).trim();
    const major = Number(v.replace("v", "").split(".")[0]);
    if (major >= 20) { ok(`Node ${v}`); return; }
    fail(`Node 版本过低（${v}），需要 ≥ 20`);
  } catch {
    warn("未检测到 Node — 尝试自动安装…");
    try {
      if (isWin) {
        execSync("winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements", { stdio: "inherit", shell: "cmd.exe" });
      } else {
        execSync("curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs", { stdio: "inherit" });
      }
      ok("Node 已安装，请重新打开终端后重跑本脚本");
    } catch {
      fail("Node 自动安装失败 — 请手动安装 Node ≥ 20（https://nodejs.org）后重试");
      process.exit(1);
    }
  }
}

// ── ② Docker 检查 ──
function ensureDocker() {
  try {
    execSync("docker ps", { stdio: "pipe", timeout: 8000 });
    ok("Docker 可用");
    return true;
  } catch {
    warn("Docker 未运行/未安装 — 将尝试无 Docker 模式（自动安装本地 PostgreSQL）");
    return false;
  }
}

// ── ②b 无 Docker 模式：自动安装本地 PostgreSQL（Windows 原生安装包，国内镜像）──
function installLocalPostgres() {
  console.log(`\n${GREEN}════ 无 Docker 模式：安装本地 PostgreSQL + pgvector ════${RESET}`);
  if (isWin) {
    // Windows: 用 zip 便携版 PostgreSQL（免安装、免管理员，含 pgvector）
    const pgVer = "16.6";
    const pgZipUrl = `https://get.enterprisedb.com/postgresql/postgresql-${pgVer}-1-windows-x64-binaries.zip`;
    const pgDir = path.join(root, ".pg-local");
    const pgBin = path.join(pgDir, "pgsql", "bin");
    try {
      if (!existsSync(path.join(pgBin, "pg_ctl.exe"))) {
        warn("下载 PostgreSQL 便携版（约 300MB，国内镜像）…");
        const zipPath = path.join(pgDir, "pg.zip");
        mkdirSync(pgDir, { recursive: true });
        // 先试国内镜像（华为云/清华），失败用官方
        const mirrors = [
          "https://mirrors.huaweicloud.com/postgresql/v16/postgresql-16.6-1-windows-x64-binaries.zip",
          pgZipUrl,
        ];
        let dlOk = false;
        for (const m of mirrors) {
          try { execSync(`curl -L -o "${zipPath}" "${m}"`, { stdio: "pipe", timeout: 600_000 }); dlOk = true; break; }
          catch { warn(`镜像 ${m} 下载失败，试下一个…`); }
        }
        if (!dlOk) { fail("PostgreSQL 下载失败 — 请手动下载后重试"); process.exit(1); }
        warn("解压 PostgreSQL…");
        execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${pgDir}' -Force"`, { stdio: "pipe", timeout: 300_000 });
        rmSync(zipPath, { force: true });
      }
      // 初始化数据库（幂等）
      const dataDir = path.join(pgDir, "data");
      if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
        warn("初始化数据库…");
        execSync(`"${path.join(pgBin, "initdb.exe")}" -D "${dataDir}" -U sag_lite -A trust -E UTF8 --locale=C`, { stdio: "pipe", timeout: 120_000 });
      }
      // 启动 PostgreSQL（幂等：已在跑则跳过）
      try {
        execSync(`"${path.join(pgBin, "pg_isready.exe")}" -h 127.0.0.1 -p 5540`, { stdio: "pipe", timeout: 5000 });
        ok("本地 PostgreSQL 已在运行");
      } catch {
        execSync(`"${path.join(pgBin, "pg_ctl.exe")}" -D "${dataDir}" -l "${path.join(pgDir, "pg.log")}" -o "-p 5540" start`, { stdio: "pipe", timeout: 30_000 });
        ok("本地 PostgreSQL 已启动（端口 5540）");
      }
      // 建库 + 用户 + pgvector 扩展
      execSync(`"${path.join(pgBin, "psql.exe")}" -h 127.0.0.1 -p 5540 -U sag_lite -d postgres -c "CREATE DATABASE sag_lite OWNER sag_lite"`, { stdio: "pipe", timeout: 30_000 });
      execSync(`"${path.join(pgBin, "psql.exe")}" -h 127.0.0.1 -p 5540 -U sag_lite -d sag_lite -c "CREATE EXTENSION IF NOT EXISTS vector"`, { stdio: "pipe", timeout: 30_000 });
      // 写 .env（DATABASE_URL 指向本地 PG）
      const envPath = path.join(root, ".env");
      if (existsSync(envPath)) {
        let env = readFileSync(envPath, "utf8");
        if (!env.includes("DATABASE_URL=")) {
          env += `\nDATABASE_URL=postgres://sag_lite@127.0.0.1:5540/sag_lite\n`;
          writeFileSync(envPath, env);
        }
      }
      ok("本地 PostgreSQL + pgvector 就绪（无 Docker）");
      return true;
    } catch (e) {
      fail("本地 PostgreSQL 安装失败: " + String(e?.message || e).slice(0, 200));
      fail("请手动安装 PostgreSQL 16 + pgvector，或安装 Docker 后重试");
      process.exit(1);
    }
  }
  // Linux/macOS: 用包管理器
  warn("Linux/macOS 建议用 Docker；也可 apt/brew 安装 postgresql + pgvector");
  return false;
}

// ── ③ 数据库启动（优先 Docker，失败自动本地 PG）──
function startDatabase() {
  console.log(`\n${GREEN}════ 数据库（docker compose）════${RESET}`);
  const composeFile = path.join(root, "docker-compose.yml");
  try {
    // -f 显式指定配置文件（防 CWD 异常/WSL 混用 Windows docker 时找不到文件）
    execSync(`docker compose -f "${composeFile}" up -d --wait`, { cwd: root, stdio: "inherit", timeout: 600_000 });
    ok("数据库已启动（PostgreSQL + Neo4j × 2）");
  } catch {
    warn("docker compose 未就绪（首次拉镜像或 Docker 未启动），尝试无 --wait 重试…");
    try {
      execSync(`docker compose -f "${composeFile}" up -d`, { cwd: root, stdio: "inherit", timeout: 600_000 });
      ok("数据库已启动");
    } catch {
      warn("Docker 数据库启动失败 — 自动切换到本地 PostgreSQL 模式…");
      installLocalPostgres();
    }
  }
}

// ── ④ npm install ──
function installDeps() {
  if (existsSync(path.join(root, "node_modules"))) { ok("依赖已就绪"); return; }
  console.log(`${GREEN}════ 安装依赖（首次约 1-2 分钟）════${RESET}`);
  execSync("npm install --no-audit --no-fund", { cwd: root, stdio: "inherit", timeout: 600_000 });
  ok("依赖安装完成");
}

// ── ⑤ .env 准备 ──
function prepareEnv() {
  const envPath = path.join(root, ".env");
  if (existsSync(envPath)) { ok(".env 已存在"); return; }
  warn(".env 不存在 — 从 .env.example 复制模板");
  writeFileSync(envPath, readFileSync(path.join(root, ".env.example"), "utf8"));
  warn("请编辑 .env 填入 LLM_API_KEY（推理/对话必需）；不填可先看界面");
}

// ── ⑥ 数据库迁移 ──
function runMigrations() {
  console.log(`${GREEN}════ 数据库迁移 ════${RESET}`);
  try {
    execSync("npx tsx src/db/migrate.ts", { cwd: root, stdio: "inherit", timeout: 300_000 });
    ok("迁移完成");
  } catch {
    fail("迁移失败 — 请确认数据库已启动（docker compose ps）");
    process.exit(1);
  }
}

// ── ⑦ 种子数据入库（可选）──
function seedData() {
  const seedScript = path.join(root, "examples", "seed-corpus", "ingest-seed-corpus.ts");
  if (!existsSync(seedScript)) { warn("种子脚本不存在，跳过"); return; }
  console.log(`${GREEN}════ 种子语料入库（演示数据，可跳过）════${RESET}`);
  try {
    execSync("npx tsx examples/seed-corpus/ingest-seed-corpus.ts", { cwd: root, stdio: "inherit", timeout: 600_000 });
    ok("种子语料已入库");
  } catch {
    warn("种子语料入库失败（不影响启动，可稍后手动执行）");
  }
}

// ── ⑧ 启动 ──
function startServer() {
  console.log(`\n${GREEN}════ 启动服务 http://localhost:4173 ════${RESET}`);
  const child = spawn("npx", ["tsx", "src/index.ts"], { cwd: root, stdio: "inherit" });
  child.on("exit", (code) => console.log(`服务退出（code=${code}）。按 Ctrl+C 停止。`));
}

// ── 主流程 ──
console.log(`${GREEN}════ MarxSphere 一键部署 ════${RESET}`);
ensureNode();
ensureDocker();
startDatabase();
installDeps();
prepareEnv();
runMigrations();
seedData();
startServer();
