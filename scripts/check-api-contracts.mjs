// scripts/check-api-contracts.mjs — 前端调用 × 后端路由 的契约对账
//
// 为什么要有它: 2026-09-18/19 两轮里挖出的 **5 个缺陷有 4 个是同一个形状** ——
//   **前端在调一个后端不存在(或形状/鉴权对不上)的东西**:
//     · 编辑器「导出 Word」→ `/api/editor/v1/documents/<id>/export` 恒 404
//     · 图片用原生 `<img>` 取 requireUser 保护的端点 → 恒 401(本机也 401)
//     · `/api/llm/provider-sync` / `/api/eval/confirm` / `/api/eval/model-info` 恒 404
//   而这些**都不是扫出来的, 是做 UI 活时顺手撞出来的**。前端面当时已扫透(93 个动作全覆盖),
//   后端契约面却从没有过任何信号。这个脚本就是补那一面。
//
// 做法(刻意保守, 宁可漏报不可误报 —— 假阳性会让人不再信它):
//   1. 后端路由从 **src/ 下所有 .ts** 抽 `app.<verb>("<path>")`(**不能只看 server.ts**:
//      `/api/backup` 注册在 `routes-backup.ts`, 我第一版只看 server.ts 就把它误判成死链了)
//   2. 前端调用从 web/src + web/socialsci-vue/src 抽 `/api/...` 字面量
//   3. 逐段匹配(占位符 `<v>` 对一段, `<s>` 对剩余); 尾部占位符逐级回退
//      (模板串里的 `${qs}` 往往是 query string, 不是路径段)
//   4. 剔除"只是前缀"的项(`/api/academic` 这种是 base URL, 不是调用)
//
// ⚠ **扫描器只能给候选, 判死必须用运行时**: 我实测过 13 条候选里 **10 条是假阳性**
//   (`/api/agent/logs` 是 500 不是 404、`/api/byoa/agent/<action>` 的 action 是路径段、
//    `/api/scenarios` 是演示表格里的字符串…)。所以本脚本**只报告, 不判死, 也不退出非零** ——
//   理由见文件末尾那段注释(我写过一版自动判死, 误报 10/13, 已删除)。
//
// 用法: node scripts/check-api-contracts.mjs      # 打印候选, 人再逐条核
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

// ── 1. 后端路由(全 src/, 不只是 server.ts) ──
const ROUTE_RE = /app\.(get|post|put|patch|delete)\(\s*["`]([^"`]+)["`]/g;
const routes = [];
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p, out); continue; }
    if (extname(p) === ".ts") out.push(p);
  }
  return out;
}
for (const f of walk("src")) {
  const t = readFileSync(f, "utf-8");
  for (const m of t.matchAll(ROUTE_RE)) {
    const p = m[2];
    if (!p.startsWith("/api")) continue;
    routes.push({ method: m[1].toUpperCase(), segs: p.replace(/:[\w]+/g, "<v>").replace(/\*/g, "<s>").split("/").filter(Boolean) });
  }
}

// ── 2. 前端调用 ──
const CALL_RE = /[`"'](\/api\/[A-Za-z0-9_\-/:.<>${}]*)/g;
const FRONT = ["web/src", "web/socialsci-vue/src"];
const calls = new Map(); // path → 出现文件
function walkFront(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walkFront(p, out); continue; }
    if ([".ts", ".tsx", ".vue"].includes(extname(p))) out.push(p);
  }
  return out;
}
for (const f of FRONT.flatMap((r) => walkFront(r))) {
  const t = readFileSync(f, "utf-8");
  for (const m of t.matchAll(CALL_RE)) {
    const u = m[1].replace(/\$\{[^}]*\}?/g, "<v>").replace(/<[a-zA-Z]+>/g, "<v>").replace(/\/$/, "");
    if (u === "/api") continue;
    if (!calls.has(u)) calls.set(u, new Set());
    calls.get(u).add(f);
  }
}

// ── 3. 匹配 ──
const seg = (u) => u.split("/").filter(Boolean);
function matches(cp, rp) {
  let i = 0;
  for (const s of rp) {
    if (s === "<s>") return true;
    if (i >= cp.length) return false;
    if (s === "<v>") { i++; continue; }
    if (s !== cp[i]) return false;
    i++;
  }
  return i === cp.length;
}
const routePaths = routes.map((r) => "/" + r.segs.join("/"));
const isPrefix = (c) => routePaths.some((rp) => rp.startsWith(c + "/"));
function hitAny(c) {
  const cp = seg(c);
  for (let k = cp.length; k >= 0; k--) if (routes.some((r) => matches(cp.slice(0, k), r.segs))) return true;
  return false;
}

const candidates = [...calls.keys()].filter((c) => !isPrefix(c) && c !== "/api/..." && !hitAny(c)).sort();

console.log(`后端路由 ${routes.length} 条 · 前端调用 ${calls.size} 条 · **候选(后端无匹配) ${candidates.length} 条**\n`);
for (const c of candidates) {
  const files = [...calls.get(c)].slice(0, 2).join(", ");
  console.log(`  ${c}\n      ${files}`);
}

if (!candidates.length) process.exit(0);

/**
 * ⚠ **刻意不做自动判死**。
 *
 * 我试过写 `--strict`: 对每条候选发一个真请求, 404 就算死。**它是错的, 已删除** ——
 * 候选串里带着 `<v>` 占位符, 原样发出去必然 404; 就算换成真实值, `/api/agent/logs`
 * 的实测结果是 **500**(路由存在, 是别的问题), 机器分不出来。
 * 实测 13 条候选里 **10 条是假阳性**, 而它们每一条我都得用运行时单独核过才敢下结论。
 *
 * 所以这个脚本的定位是**给候选, 不给结论**。判死要人来: 逐条发请求看**状态码本身**
 *   (404 = 没这个路由; 500 = 有路由但炸了; 200/400 = 有路由), 再看调用点怎么消费结果。
 *   本轮就是这么从 13 条收敛到 **3 条真死链**的。
 *
 * 一个会误报 10/13 的门禁比没有门禁更糟 —— 它会让下一个人不再信它。
 */
process.exitCode = 0;
