// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
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
const REPO = process.env.GITHUB_REPO || "LDF924/SocioSeek";

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
const installer = path.join(root, "release", `SocioSeek Setup ${version}.exe`);
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

/**
 * 跑一条 GitHub API 的 curl，并把响应解析成 JSON。
 *
 * ⚠ 2026-09-30 加。此前这里是**裸的 `JSON.parse(execSync(...))`**，5 处都是。实测后果:
 *   v1.4.0 那次发布(CI run 34946713743), 安装包都打好了(503MB, 花了 40 分钟构建)，
 *   走到「创建 Release」时 curl 返回空串 —— `JSON.parse("")` 抛
 *   `SyntaxError: Unexpected end of JSON input`，**报错里既没有 HTTP 状态、也没有 curl 的
 *   stderr**，只有一个 `release.mjs:162`，完全看不出是网络、鉴权还是限流。
 *
 *   查询那一处本来有 3 次重试，但判据是"返回的字符串为空" —— 而 curl 失败时 stdout 确实为空，
 *   于是重试三次后照样空手退出，还是没留下任何线索。
 *
 * 现在: 空响应**带重试**(每次都把 stderr 攒下来)，仍失败就把 curl 的 exit code 与 stderr
 *   一并打出来再退出。宁可多几行日志，不要一个查不出原因的 SyntaxError。
 */
function curlText(cmd) {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), code: r.status };
}

function ghJson(cmd, what, { attempts = 3 } = {}) {
  let last = { out: "", err: "", code: null };
  for (let i = 1; i <= attempts; i++) {
    last = curlText(cmd);
    // 判据只看 **stdout 是否为空** —— curl 把进度/警告写到 stderr, 那不影响响应体,
    // 拿它当失败信号会造成假重试(尤其上传 503MB 安装包那次)。
    if (last.out) break;
    if (i < attempts) {
      console.log(`[release] ${what}: 空响应, 重试 ${i}/${attempts}…${last.err ? " (" + last.err.slice(0, 120) + ")" : ""}`);
      try { execSync("ping -n 3 127.0.0.1 >nul", { shell: "cmd", stdio: "ignore" }); } catch { /* 纯等待 */ }
    }
  }
  if (!last.out) {
    console.error(`❌ ${what}: GitHub API 连续 ${attempts} 次空响应。`);
    console.error(`   curl exit=${last.code}${last.err ? "  stderr=" + last.err.slice(0, 400) : "  (无 stderr)"}`);
    console.error(`   常见原因: token 失效/权限不足(需 contents:write) · 网络不可达 · 触发了二级限流`);
    process.exit(1);
  }
  try {
    return JSON.parse(last.out);
  } catch {
    console.error(`❌ ${what}: 响应不是合法 JSON(可能是 HTML 错误页或限流文案)。`);
    console.error(`   前 300 字: ${last.out.slice(0, 300)}`);
    process.exit(1);
  }
}

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
notes = notes || "SocioSeek 自动发布";
const releaseMeta = {
  // ⚠ 新 Release 用 SocioSeek, 但**2026-09-30 之前的 32 个历史 Release 有意保持 MarxSphere**。
  //
  //   用户 2026-09-30 的决定: 那些 Release 的**安装包附件就叫**
  //   `MarxSphere Setup 1.4.0.exe` —— 把标题改成 SocioSeek 之后, 标题与附件名对不上,
  //   点进去会以为下错了东西。它们记录的是"当时的事实"(当时产品确实叫 MarxSphere)。
  //   **别"顺手"把历史 Release 改名。** 32 个里 29 个是这句自动生成的, 另 3 个
  //   (v0.1.0 / v0.2.0 / v1.2.0) 有自定义副标题。
  //
  //   顺带: 上面那段"已存在则只 PATCH name/draft/prerelease"的降级逻辑**会让老 Release
  //   继续保持 MarxSphere** —— 重打旧 tag 时不会被这句改掉, 这是对的, 别当 bug 修。
  name: `SocioSeek ${tag} — 自动发布`,
  body: notes,
  draft: false,
  prerelease: false,
};
// 先查该 tag 是否已有 Release（存在则更新，避免 POST 重复创建 422）
// ⚠ 这一处的重试内联在 V397 就有了, 但判据只认"返回非空串"、且**不留 stderr** ——
//   实测 v1.4.0 那次就是"重试三次仍空、然后 JSON.parse("") 崩在一个查不出原因的位置"。
//   现在统一交给 ghJson: 重试 + 失败时打 curl exit/stderr + 非法 JSON 时打前 300 字。
//   ⚠ 404(该 tag 尚无 Release) 是**合法**结果, 会返回 {"message":"Not Found"} —— 不是空串,
//     所以不会被当成失败; 下面靠 `existing.id` 区分。
const existing = ghJson(
  `curl -s "https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}" -H "Authorization: token ${GITHUB_TOKEN}"`,
  "查询 Release",
);
let release;
if (existing.id) {
  // 已存在：不覆盖已有 body（保留手动写的发布说明），只更新 name/draft/prerelease
  const patchMeta = existing.body && existing.body.trim() !== "SocioSeek 自动发布"
    ? { name: releaseMeta.name, draft: false, prerelease: false }
    : releaseMeta;
  release = ghJson(
    `curl -s -X PATCH "https://api.github.com/repos/${REPO}/releases/${existing.id}" -H "Authorization: token ${GITHUB_TOKEN}" -H "Content-Type: application/json" -d ${JSON.stringify(JSON.stringify(patchMeta))}`,
    "更新 Release",
  );
  console.log(`✅ Release 已存在，已更新（保留原 body）: ${release.html_url || release.message || "?"}`);
} else {
  // POST 创建；若 422（tag 已有 Release，竞态/时序）→ 自动降级查已有 + PATCH
  release = ghJson(
    `curl -s -X POST "https://api.github.com/repos/${REPO}/releases" -H "Authorization: token ${GITHUB_TOKEN}" -H "Content-Type: application/json" -d ${JSON.stringify(JSON.stringify({ tag_name: tag, ...releaseMeta }))}`,
    "创建 Release",
  );
  if (!release.id && release.message?.includes("already_exists")) {
    console.log("⚠️ Release 已存在（竞态），降级 PATCH 更新…");
    const retry = ghJson(
      `curl -s "https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}" -H "Authorization: token ${GITHUB_TOKEN}"`,
      "重查 Release",
    );
    if (retry.id) {
      release = ghJson(
        `curl -s -X PATCH "https://api.github.com/repos/${REPO}/releases/${retry.id}" -H "Authorization: token ${GITHUB_TOKEN}" -H "Content-Type: application/json" -d ${JSON.stringify(JSON.stringify(releaseMeta))}`,
        "降级 PATCH Release",
      );
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
// ⚠ "该 Release 尚无任何资产"时 GitHub 返回的是 `[]`（合法 JSON）—— 用 allowEmpty 放行，
//   免得被当成"空响应"重试三次。解析出来的空数组由下面的 Array.isArray 分支处理。
const existingAssets = ghJson(
  `curl -s "https://api.github.com/repos/${REPO}/releases/${release.id}/assets" -H "Authorization: token ${GITHUB_TOKEN}"`,
  "查询已有资产",
);
const dup = (Array.isArray(existingAssets) ? existingAssets : []).find((a) => a.name === decodeURIComponent(assetName));
if (dup) {
  curlText(`curl -s -X DELETE "https://api.github.com/repos/${REPO}/releases/assets/${dup.id}" -H "Authorization: token ${GITHUB_TOKEN}"`);
  console.log(`↻ 已删除旧资产 ${dup.name}，替换为新安装包`);
}
// 上传: 走 uploads.github.com(与 api 不同域), 503MB 的 body 走 --data-binary
const upload = ghJson(
  `curl -s -X POST "https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${assetName}" -H "Authorization: token ${GITHUB_TOKEN}" -H "Content-Type: application/octet-stream" --data-binary "@${installer.replace(/\\/g, "/")}"`,
  "上传安装包",
  { attempts: 2 },
);
console.log(`✅ 安装包已上传: ${upload.browser_download_url || upload.message || "?"}`);

// 6) 同步安装包到主仓库（SAG-main release/）
const mainReleaseDir = path.join(process.env.SAG_MAIN_ROOT || path.resolve(root, ".."), "release");
if (existsSync(mainReleaseDir)) {
  execSync(`copy /Y "${installer}" "${mainReleaseDir}\\SocioSeek Setup ${version}.exe"`, { shell: "cmd.exe" });
  console.log(`✅ 已同步到主仓库 release/ (SocioSeek Setup ${version}.exe)`);
}

console.log("\n🎉 发布完成!");
console.log(`   下载: ${upload.browser_download_url || ""}`);