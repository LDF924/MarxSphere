// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// scripts/release.mjs — 一键发布脚本：构建 → 桌面端打包 → 上传 GitHub Release
// 用法: node scripts/release.mjs [版本标签] [发布说明] [--no-publish]
// 示例: node scripts/release.mjs v0.3.0 "新功能说明"
//       node scripts/release.mjs v0.1.0 --no-publish   # 只打包不上传（重打已发布版本时用，避免 Release 重复创建 422）
// 版本号来源: 标签去掉前导 v（v0.2.2 → 0.2.2）；安装包名与 Release 标签自动一致
// 环境变量: GITHUB_TOKEN（GitHub API token，仅发布模式必需）；SENSENOVA_API_KEY 等由 .env 提供
import { spawnSync, execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
// GITHUB_TOKEN 优先环境变量；否则从 git remote URL 提取（LDF924:TOKEN@gh-proxy...）
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || (() => {
  try {
    const remote = execSync("git remote get-url origin", { cwd: root, encoding: "utf8" }).trim();
    const m = remote.match(/https:\/\/([^:]+):([^@]+)@/);
    return m ? m[2] : "";
  } catch { return ""; }
})();
const REPO = process.env.GITHUB_REPO || "LDF924/MarxSphere";

// --no-publish：只打包（本地构建 + NSIS），跳过 GitHub Release 创建与资产上传。
// 用于重打已发布版本（如修正 license 重新出包），避免重复创建 Release 触发 422。
const NO_PUBLISH = process.argv.includes("--no-publish");
const posArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const notesArg = posArgs[1];
// 版本号：优先命令行参数（node scripts/release.mjs vX.Y.Z）；未传时从最新新序列 tag 自动递增（v0.2.0 → v0.3.0）
let tag = posArgs[0];
if (!tag) {
  try {
    // 只认新协议序列 tag（v0.1.x/v0.2.x/v0.3.x... 重新计数；旧协议 v0.2.2-marx-icon 等含后缀的不参与）
    const allTags = execSync(`git tag --sort=-version:refname`, { cwd: root, encoding: "utf8" }).trim().split("\n");
    const newSeries = allTags.filter((t) => /^v0\.[0-9]+\.[0-9]+$/.test(t) && !t.includes("-"));
    const latest = newSeries[0] || allTags[0];
    const m = latest.match(/^v(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      tag = `v${m[1]}.${Number(m[2]) + 1}.0`;
      console.log(`[release] 未传版本参数，自动递增: ${latest} → ${tag}`);
    }
  } catch { /* 无 tag 时用默认 */ }
}
tag = tag || `v${Date.now().toString(36)}`;

if (!GITHUB_TOKEN && !NO_PUBLISH) {
  console.error("❌ 缺少 GITHUB_TOKEN 环境变量（GitHub API token）");
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  // 用本地 node_modules/.bin（npx 在本机环境可能下载错误包）
  const localBin = path.join(root, "node_modules", ".bin", cmd + (process.platform === "win32" ? ".cmd" : ""));
  const useLocal = existsSync(localBin) ? localBin : cmd;
  const isCmd = useLocal.endsWith(".cmd") || useLocal.endsWith(".bat");
  console.log(`\n▶ ${cmd} ${args.join(" ")}`);
  // Windows 下 .cmd 必须经 shell 执行（spawnSync 直接跑 .cmd 会 exit null）
  const r = isCmd
    ? spawnSync(useLocal, args, { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, ...opts.env }, ...opts })
    : spawnSync(useLocal, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...opts.env }, ...opts });
  if (r.status !== 0) {
    console.error(`❌ 命令失败: ${cmd} ${args.join(" ")} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
  return r;
}

// 1) 构建后端 + 前端 + electron
console.log(NO_PUBLISH ? "════════ 1/3 构建后端 + 前端 ════════" : "════════ 1/5 构建后端 + 前端 ════════");
run("tsc", ["-p", "tsconfig.build.json"]);
run("vite", ["build"]);
run("tsx", ["electron/build.mjs"]);

// 2) 准备 resources/sag（node_modules 压缩 + 密钥断言）
console.log(NO_PUBLISH ? "════════ 2/3 准备桌面端资源 ════════" : "════════ 2/5 准备桌面端资源 ════════");
run("tsx", ["scripts/build-desktop.mjs"], { env: { SKIP_ELECTRON_BUILDER: "1" } });

// 3) NSIS 打包（项目内缓存 + npmmirror 镜像 + 跳过签名）
console.log(NO_PUBLISH ? "════════ 3/3 NSIS 安装包（--no-publish 模式）════════" : "════════ 3/5 NSIS 安装包 ════════");
const cacheDir = path.join(root, ".cache", "electron-builder");
if (!existsSync(cacheDir)) execSync(`mkdir -p "${cacheDir}"`, { shell: "powershell.exe" });
// 版本号 = 标签去前导 v；electron-builder 默认读 package.json version，需显式传入保证一致
const version = tag.replace(/^v/, "").split("-")[0];
const installer = path.join(root, "release", `MarxSphere Setup ${version}.exe`);
if (existsSync(installer)) execSync(`del "${installer}"`, { shell: "cmd.exe" });
run("electron-builder", ["--win", "nsis", "--config", "electron-builder.yml", "--publish", "never", "--config.extraMetadata.version", version], {
  env: {
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    ELECTRON_BUILDER_CACHE: cacheDir,
    ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
  },
});
if (!existsSync(installer)) {
  console.error("❌ 安装包未生成");
  process.exit(1);
}
const sizeMB = Math.round(statSync(installer).size / 1024 / 1024);
console.log(`✅ 安装包: ${installer} (${sizeMB}MB)`);

if (NO_PUBLISH) {
  console.log("\n🔧 --no-publish 模式：跳过 GitHub Release 创建与上传，产物留在本地 release/");
  console.log("   如需替换已发布资产：删旧 → 传新（curl uploads.github.com），或改用完整发布流程\n");
  process.exit(0);
}

// 4) 创建或更新 GitHub Release（幂等：tag 已有 Release 则 PATCH 更新，否则 POST 创建——重打版本不再 422）
console.log("════════ 4/5 GitHub Release ════════");
// 说明: 优先用命令行参数；未传时自动从 git 提交生成（上个 tag 到当前的 commit 列表）
let notes = notesArg;
if (!notes) {
  try {
    const prevTag = execSync(`git tag --sort=-version:refname | head -n 2 | tail -n 1`, { cwd: root, encoding: "utf8" }).trim();
    const range = prevTag ? `${prevTag}..${tag}` : "";
    const commits = execSync(`git log --oneline ${range} | head -n 30`, { cwd: root, encoding: "utf8" }).trim();
    if (commits) {
      notes = `## 更新内容（自动生成）\n\n${commits.split("\n").map((c) => `- ${c.replace(/^\S+\s+/, "")}`).join("\n")}\n\n> 完整变更见 [CHANGELOG.md](https://github.com/${REPO}/blob/main/CHANGELOG.md)`;
    }
  } catch { /* 生成失败用默认 */ }
}
notes = notes || "MarxSphere 自动发布";
const releaseMeta = {
  name: `MarxSphere ${tag} — 自动发布`,
  body: notes,
  draft: false,
  prerelease: false,
};
// 先查该 tag 是否已有 Release（存在则更新，避免 POST 重复创建 422）
// V397 修复: API 空响应/瞬时失败时重试(CI 环境偶发), 避免 JSON.parse("") 崩溃
let existingRaw = "";
for (let attempt = 1; attempt <= 3; attempt++) {
  existingRaw = execSync(
    `curl -s "https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}" -H "Authorization: token ${GITHUB_TOKEN}"`,
    { encoding: "utf8" }
  ).trim();
  if (existingRaw) break;
  console.log(`[release] Release 查询空响应, 重试 ${attempt}/3...`);
  execSync(`ping -n 2 127.0.0.1 >nul`, { shell: "cmd", stdio: "ignore" });
}
if (!existingRaw) {
  console.error("❌ Release 查询连续 3 次空响应(GitHub API 不可达), 跳过创建直接上传资产");
  process.exit(1);
}
const existing = JSON.parse(existingRaw);
let release;
if (existing.id) {
  // 已存在：不覆盖已有 body（保留手动写的发布说明），只更新 name/draft/prerelease
  const patchMeta = existing.body && existing.body.trim() !== "MarxSphere 自动发布"
    ? { name: releaseMeta.name, draft: false, prerelease: false }
    : releaseMeta;
  release = JSON.parse(execSync(
    `curl -s -X PATCH "https://api.github.com/repos/${REPO}/releases/${existing.id}" -H "Authorization: token ${GITHUB_TOKEN}" -H "Content-Type: application/json" -d ${JSON.stringify(JSON.stringify(patchMeta))}`,
    { encoding: "utf8" }
  ));
  console.log(`✅ Release 已存在，已更新（保留原 body）: ${release.html_url || release.message || "?"}`);
} else {
  // POST 创建；若 422（tag 已有 Release，竞态/时序）→ 自动降级查已有 + PATCH
  let postResp = execSync(
    `curl -s -X POST "https://api.github.com/repos/${REPO}/releases" -H "Authorization: token ${GITHUB_TOKEN}" -H "Content-Type: application/json" -d ${JSON.stringify(JSON.stringify({ tag_name: tag, ...releaseMeta }))}`,
    { encoding: "utf8" }
  );
  release = JSON.parse(postResp);
  if (!release.id && release.message?.includes("already_exists")) {
    console.log("⚠️ Release 已存在（竞态），降级 PATCH 更新…");
    const retry = JSON.parse(execSync(
      `curl -s "https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}" -H "Authorization: token ${GITHUB_TOKEN}"`,
      { encoding: "utf8" }
    ));
    if (retry.id) {
      release = JSON.parse(execSync(
        `curl -s -X PATCH "https://api.github.com/repos/${REPO}/releases/${retry.id}" -H "Authorization: token ${GITHUB_TOKEN}" -H "Content-Type: application/json" -d ${JSON.stringify(JSON.stringify(releaseMeta))}`,
        { encoding: "utf8" }
      ));
    }
  }
  console.log(`✅ Release 已创建/更新: ${release.html_url || release.message || "?"}`);
}
if (!release.id) {
  console.error("❌ Release 创建失败:", release.message || JSON.stringify(release).slice(0, 200));
  process.exit(1);
}

console.log("════════ 5/5 上传安装包 ════════");
const assetName = encodeURIComponent(path.basename(installer));
// 同名资产已存在时先删除再上传（重打版本时资产替换，避免上传 422 already_exists）
const existingAssets = JSON.parse(execSync(
  `curl -s "https://api.github.com/repos/${REPO}/releases/${release.id}/assets" -H "Authorization: token ${GITHUB_TOKEN}"`,
  { encoding: "utf8" }
));
const dup = (Array.isArray(existingAssets) ? existingAssets : []).find((a) => a.name === decodeURIComponent(assetName));
if (dup) {
  execSync(`curl -s -X DELETE "https://api.github.com/repos/${REPO}/releases/assets/${dup.id}" -H "Authorization: token ${GITHUB_TOKEN}"`, { encoding: "utf8" });
  console.log(`↻ 已删除旧资产 ${dup.name}，替换为新安装包`);
}
const upload = JSON.parse(execSync(
  `curl -s -X POST "https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${assetName}" -H "Authorization: token ${GITHUB_TOKEN}" -H "Content-Type: application/octet-stream" --data-binary "@${installer.replace(/\\/g, "/")}"`,
  { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
));
console.log(`✅ 安装包已上传: ${upload.browser_download_url || upload.message || "?"}`);

// 6) 同步安装包到主仓库（SAG-main release/）
const mainReleaseDir = path.join("C:/Users/HUAWEI/SAG-main", "release");
if (existsSync(mainReleaseDir)) {
  execSync(`copy /Y "${installer}" "${mainReleaseDir}\\MarxSphere Setup ${version}.exe"`, { shell: "cmd.exe" });
  console.log(`✅ 已同步到主仓库 release/ (MarxSphere Setup ${version}.exe)`);
}

console.log("\n🎉 发布完成!");
console.log(`   下载: ${upload.browser_download_url || ""}`);