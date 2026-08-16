// electron/build.mjs — esbuild 编译 electron main/preload (CJS, 供 Electron 加载)
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "dist");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(__dirname, "main.ts"), path.join(__dirname, "preload.ts")],
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  sourcemap: false,
  outExtension: { ".js": ".cjs" }, // 项目 package.json type:module — CJS 产物必须 .cjs 扩展名
});

// 拷贝 resources（onboarding.html 等）
const resSrc = path.join(__dirname, "resources");
const resDst = path.join(outDir, "resources");
if (existsSync(resSrc)) cpSync(resSrc, resDst, { recursive: true });

console.log("[desktop] electron build 完成 →", outDir);
