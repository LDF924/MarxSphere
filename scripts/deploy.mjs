// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// scripts/deploy.mjs — 一键部署脚本（Windows / Linux / macOS）
// 目标: 小白从 clone 到可用的全自动流程，无需手动装 Node/PG/Docker
// 流程: ① 检查 Node（缺则装）→ ② 检查 Docker（缺则提示安装）→ ③ docker compose up（数据库）
//       → ④ npm install → ⑤ .env 准备 → ⑥ 数据库迁移 → ⑦ 种子数据入库 → ⑧ 启动 4173
import { spawn, spawnSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  } catch {
    if (isWin) {
      fail("Docker 未运行 — 请先安装/启动 Docker Desktop（https://www.docker.com/products/docker-desktop/）");
      fail("安装后：docker desktop 启动完成（右下角鲸鱼图标绿色）→ 重跑本脚本");
    } else {
      fail("Docker 未运行 — 请安装 Docker（https://docs.docker.com/get-docker/）后重试");
    }
    process.exit(1);
  }
}

// ── ③ docker compose up（数据库，含首次拉镜像）──
function startDatabase() {
  console.log(`\n${GREEN}════ 数据库（docker compose）════${RESET}`);
  try {
    execSync("docker compose up -d --wait", { cwd: root, stdio: "inherit", timeout: 600_000 });
    ok("数据库已启动（PostgreSQL + Neo4j × 2）");
  } catch {
    warn("docker compose 未就绪（首次拉镜像或 Docker 未启动），尝试无 --wait 重试…");
    try {
      execSync("docker compose up -d", { cwd: root, stdio: "inherit", timeout: 600_000 });
      ok("数据库已启动");
    } catch {
      fail("数据库启动失败 — 请检查 Docker 是否正常运行（docker ps 应能看到容器）");
      process.exit(1);
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
