#!/usr/bin/env node
// build-soc.mjs — 构建 SocialSci Vue 子应用, 并(可选)把产物同步到 4173 服务的目录
//
// 为什么需要它(2026-09-26 的教训):
//
//   写作舱的 Vue 子应用有两份源码、一份产物:
//     · 源码主仓     C:\Users\HUAWEI\SAG-main\web\socialsci-vue\
//     · 源码 worktree <repo>\.claude\worktrees\<name>\web\socialsci-vue\
//     · 产物只认一份 C:\Users\HUAWEI\SAG-main\web\dist\soc\   ← 4173 服务的是这里
//
//   而 `vite build --config web/socialsci-vue/vite.config.ts` 里的
//   `projectRoot = fileURLToPath(new URL(".", import.meta.url))` 是**相对配置文件解析**的。
//   于是在 worktree 里开发、在 4173 上看的人会踩这个连环坑:
//     ① 在 worktree 改了源码;
//     ② 在**主仓**跑构建(因为只有主仓的 dist 会被 4173 服务) → 构建的是**主仓那份没改的源码**;
//     ③ 以为"改完了已生效", 实际 4173 上还是旧界面 —— 反复"修了没反应"。
//
//   本脚本把三件事一次做对:
//     ① **按脚本自身位置**定位仓库根(不依赖 cwd) —— 在哪个树里跑, 就构建哪个树的源码;
//     ② 构建后**校验产物里真的含本次改动**(用调用方给的标记串), 而不是"命令退出码是 0";
//     ③ `--to-main` 时把产物拷到主仓 dist(即 4173 服务的目录), 让本地看到的就是刚构建的。
//
// 用法:
//   node scripts/build-soc.mjs                       # 只构建到本树的 web/dist/soc
//   node scripts/build-soc.mjs --to-main             # 构建 + 同步到主仓(4173 可直连看到)
//   node scripts/build-soc.mjs --to-main --assert=cnp-card,setViewport
//                                                    # 额外断言这些串必须出现在产物里
//
// ⚠ 退出码语义: 构建失败、或断言不通过, 都 **exit 1**。
//   不要写成 `grep ... | head && echo "OK"` 那种 —— 管道里 head 恒成功, 于是空结果也会报"OK"。
//   这个脚本里所有断言都是 `if (!hit) fail()`, 没有恒真的中间命令。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/scripts
const repoRoot = path.resolve(here, ".."); // 按脚本位置定根 —— 与 cwd 无关
const socConfig = path.join(repoRoot, "web", "socialsci-vue", "vite.config.ts");
const outDir = path.join(repoRoot, "web", "dist", "soc");

const argv = process.argv.slice(2);
const toMain = argv.includes("--to-main");
const assertArg = argv.find((a) => a.startsWith("--assert="));
const markers = assertArg ? assertArg.slice("--assert=".length).split(",").map((s) => s.trim()).filter(Boolean) : [];

/** 主仓根 —— 用来定位 4173 实际服务的那个 dist。可用 SAG_MAIN_ROOT 覆盖。 */
const mainRoot = process.env.SAG_MAIN_ROOT || "C:/Users/HUAWEI/SAG-main";
const mainOutDir = path.join(mainRoot, "web", "dist", "soc");

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!existsSync(socConfig)) fail(`找不到子应用配置: ${socConfig}`);

console.log(`源(本树): ${repoRoot}`);
console.log(`  配置:   ${socConfig}`);
console.log(`  产物:   ${outDir}`);
if (toMain) console.log(`  同步到: ${mainOutDir}   (4173 服务的就是这里)`);
else console.log(`  ⚠ 未加 --to-main: 产物只落在本树, 4173 上看不到`);

// ── 构建 ──
const r = spawnSync(process.execPath, [path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--config", socConfig], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (r.status !== 0) fail(`vite build 失败(退出码 ${r.status ?? "signal " + r.signal})`);
if (!existsSync(path.join(outDir, "index.html"))) fail(`构建结束但产物不存在: ${outDir}/index.html`);

// ── 断言: 产物里真的含本次改动 ──
// 子应用是懒加载分包, 标记串会落在**某个** chunk / css 里, 所以要全目录搜。
function findInAssets(needle) {
  const assets = path.join(outDir, "assets");
  if (!existsSync(assets)) return null;
  for (const f of readdirSync(assets)) {
    if (!/\.(js|css)$/.test(f)) continue;
    if (readFileSync(path.join(assets, f), "utf8").includes(needle)) return f;
  }
  return null;
}
if (markers.length) {
  console.log("\n断言产物内容:");
  const misses = [];
  for (const m of markers) {
    const hit = findInAssets(m);
    if (hit) console.log(`  ✅ ${m}  → ${hit}`);
    else { console.log(`  ❌ ${m}  → 产物里找不到`); misses.push(m); }
  }
  if (misses.length) fail(`以下标记不在产物里: ${misses.join(", ")}\n   这说明**构建的源码不是你要的那份**, 或者改动没保存。`);
}

// ── 同步到主仓(4173 服务的目录) ──
if (toMain) {
  if (!existsSync(path.join(mainRoot, "package.json"))) fail(`主仓根看着不对: ${mainRoot}(可用 SAG_MAIN_ROOT 指定)`);
  if (path.resolve(mainOutDir) === path.resolve(outDir)) {
    console.log("\n本树就是主仓, 不需要同步。");
  } else {
    // 清掉主仓里上一次的 assets 再拷 —— 只增量拷贝会让旧 chunk 留在那里(体积白涨, 且
    // 万一 index.html 引到了旧文件名就会加载到过期代码)。
    const mainAssets = path.join(mainOutDir, "assets");
    if (existsSync(mainAssets)) rmSync(mainAssets, { recursive: true, force: true });
    mkdirSync(mainOutDir, { recursive: true });
    copyDir(outDir, mainOutDir);
    console.log(`\n已同步产物 → ${mainOutDir}`);
    // 同步后再断言一次: 证明**4173 将要服务的那份**确实含改动(这才是用户会看到的)
    if (markers.length) {
      const check = (needle) => {
        const assets = path.join(mainOutDir, "assets");
        for (const f of readdirSync(assets)) {
          if (!/\.(js|css)$/.test(f)) continue;
          if (readFileSync(path.join(assets, f), "utf8").includes(needle)) return f;
        }
        return null;
      };
      const bad = markers.filter((m) => !check(m));
      if (bad.length) fail(`同步后主仓产物里仍找不到: ${bad.join(", ")}(拷贝可能没覆盖干净)`);
      console.log(`  ✅ 主仓产物已复核含全部 ${markers.length} 个标记`);
    }
  }
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (statSync(src).isDirectory()) copyDir(src, dst);
    else copyFileSync(src, dst);
  }
}

console.log("\n✅ 完成");
