// verify-asar.mjs — 验证 v0.10.0 安装包含关键修复
// asar 文件内容不压缩：main.cjs 字节原样存储，直接扫描原始缓冲区即可验证（无需解析 header 偏移）
import { readFileSync } from "node:fs";

const archive = process.argv[2] || "release/win-unpacked/resources/app.asar";
const buf = readFileSync(archive);
console.log(`asar size: ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
const has = (s) => buf.includes(Buffer.from(s, "utf8"));

// ── app.asar 内 electron main.cjs 关键修复 ──
const asarText = buf.toString("utf8");
const checks = {
  waitForOnboardingReady: has("waitForOnboardingReady"),
  initSpawn: has("initSpawn"),
  icacls: has("icacls"),
  "Number(m2[1])": has("Number(m2[1])"),
  "SAG_AUTH_ENABLED 写入": has('"SAG_AUTH_ENABLED"') && has('"true"'),
  generateJwtSecret: has("generateJwtSecret"),
  "JWT_SECRET 写入": has('"JWT_SECRET"'),
  "dlSpawn 函数级声明(唯一)": (asarText.match(/const \{ spawn: dlSpawn \} = require/g) || []).length === 1,
};
let allOk = true;
for (const [k, v] of Object.entries(checks)) {
  console.log(`${v ? "PASS" : "FAIL"} [asar] ${k}`);
  if (!v) allOk = false;
}

// ── resources/sag/dist 后端产物（extraResources，非 asar）──
const sagDist = "release/win-unpacked/resources/sag/dist";
const read = (p) => readFileSync(p, "utf8");
const skillsSvc = read(`${sagDist}/src/services/skills-service.js`);
const ovMem = read(`${sagDist}/src/services/openviking-memory.js`);
const envJs = read(`${sagDist}/src/config/env.js`);
const checks2 = {
  "skills getSkillsRoots()": skillsSvc.includes("getSkillsRoots"),
  "skills 双目录 (SAG_ROOT/skills)": skillsSvc.includes("SAG_ROOT") && skillsSvc.includes('"skills"'),
  "skills 无重复 records 声明": (skillsSvc.match(/const records = \[\];/g) || []).length === 1,
  "openviking warnOnce 降级日志": ovMem.includes("warnOnce"),
  "openviking memoryHealth url/degraded": ovMem.includes("degraded") && ovMem.includes("url"),
  "env.ts SAG_AUTH_ENABLED": envJs.includes("SAG_AUTH_ENABLED"),
};
for (const [k, v] of Object.entries(checks2)) {
  console.log(`${v ? "PASS" : "FAIL"} [dist] ${k}`);
  if (!v) allOk = false;
}

// ── 随包 skills 目录 ──
const skillsDir = "release/win-unpacked/resources/sag/skills";
const { readdirSync } = await import("node:fs");
let skillsCount = 0;
try { skillsCount = readdirSync(skillsDir).filter((f) => f !== "_中文说明").length; } catch { skillsCount = -1; }
console.log(`${skillsCount >= 10 ? "PASS" : "FAIL"} [resources] sag/skills 随包技能数=${skillsCount}（≥10）`);
if (skillsCount < 10) allOk = false;

console.log(allOk ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(allOk ? 0 : 1);
