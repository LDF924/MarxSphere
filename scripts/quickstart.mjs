// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// scripts/quickstart.mjs — 一键体验脚本（V409: 小白友好）
// clone 后跑 `npm run quickstart` 即可：检查环境 → 提示配置 → 启动服务
// 流程: 检查 node/pg → 检查 .env（缺 key 给提示但可跳过）→ 迁移 → 启动 4173
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m", RESET = "\x1b[0m";
const ok = (m) => console.log(`${GREEN}✅ ${m}${RESET}`);
const warn = (m) => console.log(`${YELLOW}⚠️  ${m}${RESET}`);
const fail = (m) => console.log(`${RED}❌ ${m}${RESET}`);

console.log(`${GREEN}════ MarxSphere 一键启动 ════${RESET}`);

// 1. Node 版本
const nodeMajor = Number(process.version.replace("v", "").split(".")[0]);
if (nodeMajor < 20) { fail(`Node 版本过低（${process.version}），需要 ≥ 20`); process.exit(1); }
ok(`Node ${process.version}`);

// 2. node_modules
if (!existsSync(path.join(root, "node_modules"))) {
  warn("未安装依赖，正在 npm install（首次约 1-2 分钟）…");
  execSync("npm install --no-audit --no-fund", { cwd: root, stdio: "inherit" });
}
ok("依赖已就绪");

// 3. .env 检查
const envPath = path.join(root, ".env");
if (!existsSync(envPath)) {
  warn(".env 不存在 — 已从 .env.example 复制模板，请编辑填入 API Key（LLM_API_KEY 等）");
  execSync("copy .env.example .env", { shell: "cmd.exe", cwd: root });
} else {
  ok(".env 已存在");
}
const env = readFileSync(envPath, "utf8");
if (!env.includes("LLM_API_KEY=") || env.includes("LLM_API_KEY=\n")) {
  warn("LLM_API_KEY 未配置 — 推理/对话不可用，但可先看界面。编辑 .env 填入后重启即可");
} else {
  ok("LLM_API_KEY 已配置");
}

// 4. PostgreSQL 检查（docker）
try {
  execSync("docker ps --format {{.Names}}", { stdio: "pipe", timeout: 8000 });
  ok("Docker 可用");
} catch {
  warn("Docker 未运行 — 数据库依赖 docker compose up -d（或已有外部 PG 则忽略）");
}

// 5. 启动
console.log(`${GREEN}════ 启动服务 http://localhost:4173 ════${RESET}`);
const child = spawn("npx", ["tsx", "src/index.ts"], { cwd: root, stdio: "inherit" });
child.on("exit", (code) => {
  console.log(`服务退出（code=${code}）。按 Ctrl+C 停止。`);
});
