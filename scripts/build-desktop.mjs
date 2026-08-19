// scripts/build-desktop.mjs — 打包桌面端安装包（NSIS）
// 前置: npm run build（后端 tsc + 前端 vite）; 流程: 准备 resources/sag → electron-builder
import { spawnSync, execSync as s2 } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const sagResDir = path.join(root, "resources", "sag");

// 1) 准备 extraResources 内容（真实目录, 非 asar）
rmSync(path.join(root, "resources"), { recursive: true, force: true });
mkdirSync(sagResDir, { recursive: true });
for (const dir of ["dist", "scripts", "migrations", "data", "evaluation", "reports", "docs"]) {
  const src = path.join(root, dir);
  if (existsSync(src)) cpSync(src, path.join(sagResDir, dir), { recursive: true });
}
// 前端产物: 后端期望 <SAG_ROOT>/web/dist — 需拷到 sag/web/dist 而非 sag/web-dist
const webDist = path.join(root, "web", "dist");
if (existsSync(webDist)) {
  cpSync(webDist, path.join(sagResDir, "web", "dist"), { recursive: true });
}
// 数据库一键启动: docker-compose.yml 随包携带（引导页 db:setup 用）
if (existsSync(path.join(root, "docker-compose.yml"))) {
  cpSync(path.join(root, "docker-compose.yml"), path.join(sagResDir, "docker-compose.yml"));
}
// 生产依赖 node_modules: dist 编译产物 import fastify/pg/dotenv 等 npm 包,
// 运行时从 <SAG_ROOT>/node_modules 解析 — 必须随包携带（只拷 dependencies, 排除 dev）
const depNames = Object.keys(JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")).dependencies || {});
const nmSrc = path.join(root, "node_modules");
const nmDst = path.join(sagResDir, "node_modules");
mkdirSync(nmDst, { recursive: true });
for (const dep of depNames) {
  const src = path.join(nmSrc, dep);
  if (existsSync(src)) cpSync(src, path.join(nmDst, dep), { recursive: true });
}
// @fastify/static 等 scoped 包已在 dependencies 列表; 补充 dist 实际 require 但漏拷的（兜底: 全量浅拷非 dev 包）
// dev 包标记: 从根 node_modules/.package-lock.json 读取 dev 标记
try {
  const pkgLock = JSON.parse(readFileSync(path.join(root, "node_modules", ".package-lock.json"), "utf-8"));
  for (const [name, info] of Object.entries(pkgLock.packages || {})) {
    if (!name) continue;
    const key = name.replace(/^node_modules\//, "");
    if (depNames.includes(key)) continue; // 已在 dependencies
    if (info.dev) continue; // dev 依赖跳过
    const src = path.join(nmSrc, key);
    if (existsSync(src) && !existsSync(path.join(nmDst, key))) {
      try { cpSync(src, path.join(nmDst, key), { recursive: true }); } catch { /* 忽略损坏项 */ }
    }
  }
} catch { /* .package-lock.json 缺失时跳过兜底 */ }
console.log(`[desktop] node_modules 已拷贝 (${depNames.length} 直接依赖 + 传递依赖)`);

// 2) 断言: 打包目录不含 .env / 密钥文件
const banned = [".env", "sag.env", "DEEPSEEK_API_KEY", "sk-ws-", "sk-4b39"];
let leaked = [];
const scan = (d) => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { scan(p); continue; }
    const lower = f.name.toLowerCase();
    if (banned.some((b) => lower.includes(b.toLowerCase()))) leaked.push(p);
    if (/\.(env|json)$/.test(lower)) {
      try {
        const txt = require("fs").readFileSync(p, "utf-8");
        if (banned.some((b) => txt.includes(b))) leaked.push(p);
      } catch {}
    }
  }
};
scan(sagResDir);
if (leaked.length > 0) {
  console.error("[desktop] ⚠ 检测到密钥/敏感文件泄漏, 中止打包:", leaked);
  process.exit(1);
}
console.log("[desktop] resources/sag 就绪, 无密钥泄漏 ✓");

// 2.5) node_modules 压缩为单文件（NSIS 安装大目录易截断 → 单文件 zip 可靠）
// 用 Windows System32 bsdtar（libarchive, 路径处理稳, 支持 zip 格式）
const nmDir = path.join(sagResDir, "node_modules");
const zipPath = path.join(sagResDir, "node_modules.zip");
if (existsSync(nmDir)) {
  console.log("[desktop] 压缩 node_modules → node_modules.zip ...");
  const sysTar = "C:/Windows/System32/tar.exe";
  try {
    const ps = `& '${sysTar}' -a -c -f '${zipPath}' -C '${sagResDir}' node_modules`;
    s2(ps, { shell: "powershell.exe", stdio: "pipe", windowsHide: true });
  } catch (e) {
    console.error("[desktop] bsdtar 压缩失败:", String(e).slice(0, 200));
    process.exit(1);
  }
  rmSync(nmDir, { recursive: true, force: true });
  const size = Math.round(statSync(zipPath).size / 1024 / 1024);
  console.log("[desktop] node_modules.zip:", size, "MB");
}

// 3) 编译 electron main/preload
const eb = spawnSync("node", [path.join(root, "electron", "build.mjs")], { cwd: root, stdio: "inherit" });
if (eb.status !== 0) process.exit(eb.status ?? 1);

// 4) electron-builder 打包 NSIS
// 缓存目录放项目内（跨盘符 EXDEV 修复: 默认 %LOCALAPPDATA% 可能在 D 盘而 tmp 在 C 盘）
// V399: SKIP_ELECTRON_BUILDER=1 时跳过（release.mjs 会用完整 env 单独跑）
if (process.env.SKIP_ELECTRON_BUILDER !== "1") {
  const cacheDir = path.join(root, ".cache", "electron-builder");
  writeFileSync(path.join(root, "resources", ".gitkeep"), "");
  const pb = spawnSync("npx", ["electron-builder", "--win", "nsis", "--config", "electron-builder.yml"], {
    cwd: root, stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_BUILDER_CACHE: cacheDir,
      ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
  });
  if (pb.status !== 0) process.exit(pb.status ?? 1);
  console.log("[desktop] 打包完成 → release/ 目录");
}
