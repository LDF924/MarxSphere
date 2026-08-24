// verify-v016.mjs — 代码级核验 v0.16.0 安装包是否包含当前会话全部修复（V421-V439）
// 方法：对每个提交取关键代码标记（从 git diff 提取），在安装包 asar/dist 里搜索
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const root = "C:/Users/HUAWEI/SAG-open-source";
const asar = readFileSync(root + "/release/win-unpacked/resources/app.asar", "utf8");
const dist = root + "/release/win-unpacked/resources/sag/dist";
const readDist = (p) => readFileSync(`${dist}/${p}`, "utf8");

// 每个提交的关键标记（函数名/字符串/逻辑特征）
const CHECKS = [
  // V421 下载加速
  { v: "V421", file: "asar", markers: ["mirror.nju.edu.cn", "--connect-timeout"] },
  { v: "V421", file: "asar", markers: ["pgvector-pg16.zip"] },
  // V422 迁移等待
  { v: "V422", file: "dist:src/index.js", markers: ["waitForDbReady", "runMigrationsWithRetry"] },
  // V423 雷达细分 + 修复跑迁移
  { v: "V423", file: "asar", markers: ["probeDbDetail", "migration_pending"] },
  // V424 退出登录
  { v: "V424", file: "web:index-*.js", markers: ["setAuth({ enabled: true, user: null })"] },
  // V425 key 清理
  { v: "V425", file: "dist", markers: [] }, // skills/ 不在 asar/dist，单独查 resources/sag/skills
  // V426 SSRF
  { v: "V426", file: "dist:src/services/url-guard.js", markers: ["assertPublicUrl"] },
  { v: "V426", file: "dist:src/services/p2o-service.js", markers: ["isControlledPdfPath"] },
  // V427 前端
  { v: "V427", file: "web:index-*.js", markers: ["FileReader.readAsDataURL"] },
  { v: "V427", file: "web:index-*.js", markers: ["securityLevel:\"strict\""] },
  // V428 Electron
  { v: "V428", file: "asar", markers: ["consecutiveCrashes", "MAX_CONSECUTIVE_CRASHES"] },
  { v: "V428", file: "asar", markers: ["btn-restart"] },
  { v: "V428", file: "asar", markers: ["FullName -match"] },
  // V429 后端 12 项
  { v: "V429", file: "dist:src/api/server.js", markers: ["requestTenantId", 'status === "disabled"'] },
  { v: "V429", file: "dist:src/services/event-bus.js", markers: ["queueRunning"] },
  { v: "V429", file: "dist:src/ai/mcp-pool.js", markers: ["MCP pool acquire timeout"] },
  { v: "V429", file: "dist:src/services/agent-credentials.js", markers: ["encryptByokKey"] },
  // V430 LOW
  { v: "V430", file: "dist:src/services/auth-service.js", markers: ["internalError"] },
  // V431 注入消除
  { v: "V431", file: "dist:src/services/self-heal-service.js", markers: ["execFile(\"netstat\""] },
  // V432 端口全占
  { v: "V432", file: "asar", markers: ["4173-4183"] },
  // V433 解压留引导页
  { v: "V433", file: "asar", markers: ["extract-error", "deps-error.log"] },
  // V434 PG 假阳性
  { v: "V434", file: "asar", markers: ['"-f"', "port: 5540"] },
  // V435 tar 提速
  { v: "V435", file: "asar", markers: ["-xf", "-C"] },
  // V436 进度
  { v: "V436", file: "asar", markers: ["TOTAL_NM_ENTRIES", "PG_VERSION"] },
  // V437 迁移降级
  { v: "V437", file: "dist:src/api/server.js", markers: ["MIGRATING", "markMigrationsReady"] },
  { v: "V437", file: "dist:src/index.js", markers: ["markMigrationsReady"] },
  // V438 服务商
  { v: "V438", file: "asar", markers: ["llmProvider", "api.deepseek.com/v1"] },
  { v: "V438", file: "web:index-*.js", markers: ["providerDetect"] },
  // V439 雷达启动页
  { v: "V439", file: "asar", markers: ["正在启动 MarxSphere"] },
];

let pass = 0, fail = 0;
for (const c of CHECKS) {
  let haystack = "";
  if (c.file === "asar") haystack = asar;
  else if (c.file.startsWith("dist:")) {
    try { haystack = readDist(c.file.slice(5)); } catch { haystack = ""; }
  } else if (c.file.startsWith("web:")) {
    // web dist assets 合并搜索
    try {
      const { readdirSync } = await import("node:fs");
      const assets = readdirSync(`${dist}/web/dist/assets`).filter((f) => f.endsWith(".js"));
      haystack = assets.map((f) => readFileSync(`${dist}/web/dist/assets/${f}`, "utf8")).join("\n");
    } catch { haystack = ""; }
  }
  const ok = c.markers.every((m) => haystack.includes(m));
  console.log(`${ok ? "PASS" : "FAIL"} ${c.v} ${c.file} [${c.markers.join(", ")}]`);
  if (ok) pass++; else fail++;
}

// V425 skills key 清理（resources/sag/skills 单独查）
const skillsFiles = ["skills/marx-graphiti/scripts/graphiti_init.py", "skills/marx-graphiti/mcp_server/server.py", "skills/marx-cognee/scripts/retry_failed.py"];
for (const f of skillsFiles) {
  const content = readFileSync(`${root}/release/win-unpacked/resources/sag/${f}`, "utf8");
  const noKey = !/sk-ws-[A-Za-z0-9._]/.test(content);
  const hasEnv = content.includes("getenv");
  const ok = noKey && hasEnv;
  console.log(`${ok ? "PASS" : "FAIL"} V425 ${f} [无硬编码 key + getenv]`);
  if (ok) pass++; else fail++;
}

console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
