// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// scripts/release.mjs — 一键发布脚本：构建 → 桌面端打包 → 上传 GitHub Release
// 用法: node scripts/release.mjs [版本标签] [发布说明]
// 示例: node scripts/release.mjs v0.3.0 "新功能说明"
// 版本号来源: 标签去掉前导 v（v0.2.2 → 0.2.2）；安装包名与 Release 标签自动一致
// 环境变量: GITHUB_TOKEN（GitHub API token，必需）；SENSENOVA_API_KEY 等由 .env 提供
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

if (!GITHUB_TOKEN) {
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
console.log("════════ 1/5 构建后端 + 前端 ════════");
run("tsc", ["-p", "tsconfig.build.json"]);
run("vite", ["build"]);
run("tsx", ["electron/build.mjs"]);

// 2) 准备 resources/sag（node_modules 压缩 + 密钥断言）
console.log("════════ 2/5 准备桌面端资源 ════════");
run("tsx", ["scripts/build-desktop.mjs"], { env: { SKIP_ELECTRON_BUILDER: "1" } });

// 3) NSIS 打包（项目内缓存 + npmmirror 镜像 + 跳过签名）
console.log("════════ 3/5 NSIS 安装包 ════════");
const cacheDir = path.join(root, ".cache", "electron-builder");
if (!existsSync(cacheDir)) execSync(`mkdir -p "${cacheDir}"`, { shell: "powershell.exe" });
// 版本号：优先命令行参数（node scripts/release.mjs vX.Y.Z）；未传时从最新新序列 tag 自动递增（v0.2.0 → v0.3.0）
let tag = process.argv[2];
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

// 4) 创建 GitHub Release + 上传安装包
console.log("════════ 4/5 GitHub Release ════════");
// 说明: 优先用命令行参数；未传时自动从 git 提交生成（上个 tag 到当前的 commit 列表）
let notes = process.argv[3];
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
const release = JSON.parse(execSync(
  `curl -s -X POST "https://api.github.com/repos/${REPO}/releases" -H "Authorization: token ${GITHUB_TOKEN}" -H "Content-Type: application/json" -d ${JSON.stringify(JSON.stringify({
    tag_name: tag,
    name: `MarxSphere ${tag} — 自动发布`,
    body: notes,
    draft: false,
    prerelease: false,
  }))}`,
  { encoding: "utf8" }
));
if (!release.id) {
  console.error("❌ Release 创建失败:", release.message || JSON.stringify(release).slice(0, 200));
  process.exit(1);
}
console.log(`✅ Release: ${release.html_url}`);

console.log("════════ 5/5 上传安装包 ════════");
const assetName = encodeURIComponent(path.basename(installer));
const upload = JSON.parse(execSync(
  `curl -s -X POST "https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${assetName}" -H "Authorization: token ${GITHUB_TOKEN}" -H "Content-Type: application/octet-stream" --data-binary "@${installer.replace(/\\/g, "/")}"`,
  { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
));
console.log(`✅ 安装包已上传: ${upload.browser_download_url || upload.message || "?"}`);

// 5) 同步安装包到主仓库（SAG-main release/）
const mainReleaseDir = path.join("C:/Users/HUAWEI/SAG-main", "release");
if (existsSync(mainReleaseDir)) {
  execSync(`copy /Y "${installer}" "${mainReleaseDir}\\MarxSphere Setup ${version}.exe"`, { shell: "cmd.exe" });
  console.log(`✅ 已同步到主仓库 release/ (MarxSphere Setup ${version}.exe)`);
}

console.log("\n🎉 发布完成!");
console.log(`   下载: ${upload.browser_download_url || ""}`);
