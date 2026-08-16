// scripts/dev-desktop.mjs — 开发态启动桌面端（源码直接跑, 资源指向项目根）
// 用法: npm run dev:desktop
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const electronBin = path.join(root, "node_modules", ".bin", "electron.cmd");

console.log("[desktop] dev 模式启动 Electron (资源根=" + root + ")");
const child = spawn(electronBin, [path.join(root, "electron", "dist", "main.cjs")], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, SAG_DESKTOP_DEV: "1" },
});
child.on("exit", (code) => process.exit(code ?? 0));
