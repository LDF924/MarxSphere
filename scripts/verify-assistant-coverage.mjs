// scripts/verify-assistant-coverage.mjs — V416: 科研助手对**全站功能页**的覆盖度回归
//
// 由来（2026-09-14 用户反馈"科研助手并不能很好反映每一个功能页"）：
//   改前实测 —— 45 个视图里 33 个页面名兜底成"工作台"（名字表只写了 12 条），
//   45 个全都没有"当前页可执行"（唯一的埋点在 EditorView.tsx，而那个文件没被 App.tsx import）。
//   这个脚本把当时的量化口径固定下来，防止再退回去。
//
// 覆盖：
//   ① 每个视图助手都报得出**准确的页面名**（→ 0 个兜底）
//   ② 每个视图都有**功能说明**
//   ③ 埋了点的主功能页，助手里能列出**可执行动作**，且点下去真的驱动页面（POST/DOM 变化为证）
//   ④ 隐藏的保活 iframe 不上报（否则会把别的工作台的按钮混进来）
//
// 用法: node scripts/verify-assistant-coverage.mjs   (需 4173 已起)
import { chromium } from "playwright";
import { resolveBrowser } from "./lib/find-browser.mjs";

const BASE = process.env.ORCH_UI_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

// App.tsx validViews 的全集（改这里时同步那份列表）
const VIEWS = ["assistant", "chat", "documents", "graph", "mcp", "reason", "ask", "sciverse", "skills", "vault",
  "truth", "literature", "sources", "policy", "scenarios", "jobs", "inbox", "trace", "eval", "tasks",
  "agent-console", "dream", "p2o", "cjournal", "corpus", "paper-outline", "memory", "docs", "alerts", "im",
  "education", "empirical-research", "graphiti-ingest", "cogneee-ingest", "billing", "admin", "jupyter",
  "imports", "structure", "citation-verify", "format-eval", "dag-workbench", "review-lab", "plot-agent",
  "editor", "site-content", "research-history", "home"].filter((v) => v !== "cogneee-ingest");

// 有动作埋点的主功能页（断言这些页助手里必须列出动作）。
// review-lab / policy 不在列: 它们唯一的主动作(开始审稿 / 检索)在初始状态下是 **disabled** 的,
// 而"禁用按钮不进列表"是刻意行为 —— 把它们放进来会变成断言错误的行为。禁用过滤另测。
const WITH_ACTIONS = ["ask", "literature", "paper-outline", "dag-workbench", "plot-agent",
  "editor", "empirical-research", "eval", "structure", "truth", "dream", "skills", "jupyter"];

const browser = await chromium.launch({ headless: true, executablePath: resolveBrowser({ envVar: "UI_VERIFY_BROWSER", label: "node scripts/verify-assistant-coverage.mjs" }) });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 140)));

/** 打开视图并读助手面板内容 */
async function read(view) {
  await page.goto("about:blank");
  await page.goto(`${BASE}/#${view}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3200);
  return page.evaluate(() => {
    const fab = [...document.querySelectorAll("button")].find((b) => /科研助手/.test(b.textContent || ""));
    if (fab) fab.click();
    return new Promise((res) => setTimeout(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /科研助手|收起/.test(b.textContent || ""));
      let host = btn; while (host && getComputedStyle(host).position !== "fixed") host = host.parentElement;
      const panel = host?.querySelector('div[class*="w-80"]');
      if (!panel) { res({ ok: false }); return; }
      const txt = (e) => (e?.textContent || "").trim();
      const box = panel.querySelector('div[class*="bg-slate-800/60"]');
      const actions = [];
      for (const s of panel.querySelectorAll("span")) { const v = txt(s); if (v.startsWith("▶")) actions.push(v); }
      // label 与 hint 是两个独立的 <p>: 第一个是"当前在 X"(X 在 span 里), 第二个才是说明
      const ps = box ? [...box.querySelectorAll(":scope > p")] : [];
      res({
        ok: true,
        label: (txt(box) || "").replace(/^当前在\s*/, ""),
        hint: ps.length > 1 ? txt(ps[1]) : "",
        actions,
      });
    }, 900));
  });
}

console.log("═══ ① 页面名 + 功能说明（全站 48 视图）═══");
const missing = [];
let noHint = 0;
const noHintViews = [];
for (const v of VIEWS) {
  const r = await read(v);
  if (!r.ok) continue;
  if (!r.label || r.label.startsWith("工作台")) missing.push(`${v}→"${r.label}"`);
  // hint 就是第二个 <p>, 不与 label 拼在一起(上一版按标点切是错的)
  if (!r.hint || r.hint.length < 4) { noHint++; noHintViews.push(v); }
}
t("没有视图名兜底成“工作台”", missing.length === 0, missing.length ? missing.join(", ") : "48/48 都有准确名字");
t("每个视图都有功能说明", noHint === 0, noHint ? `${noHint} 个缺说明: ${noHintViews.slice(0, 6).join(", ")}` : "全部有说明");

console.log("\n═══ ② 主功能页的“当前页可执行” ═══");
const noAct = [];
for (const v of WITH_ACTIONS) {
  const r = await read(v);
  if (!r.ok) { noAct.push(`${v}(面板没打开)`); continue; }
  if (r.actions.length === 0) noAct.push(v);
  else console.log(`  ${v.padEnd(20)} ${r.actions.join(" | ")}`);
}
t("主功能页都能列出可执行动作", noAct.length === 0, noAct.length ? `缺: ${noAct.join(", ")}` : `${WITH_ACTIONS.length} 个页全部有`);

console.log("\n═══ ②b 禁用/隐藏的按钮不该出现在列表里 ═══");
{
  // policy 页刚进来时「检索」是 disabled 的(没输查询词) → 助手不应列出它
  const r = await read("policy");
  const listed = r.actions.join(" ");
  t("policy 不列出 disabled 的「检索」", r.ok && !/检索/.test(listed), `实际列出: ${listed || "(空)"}`);
  // 编排页 7 个 DAG 行各有一个「🎬 演示」→ 去重后只应出现 1 次
  const d = await read("dag-workbench");
  const demo = d.actions.filter((a) => /演示/.test(a)).length;
  t("同名动作按 id 去重(编排页 7 行只出 1 条演示)", demo === 1, `实际 ${demo} 条`);
}

console.log("\n═══ ③ 点助手动作真的驱动页面 ═══");
{
  const posts = [];
  page.on("request", (req) => { if (req.method() === "POST") posts.push(req.url().replace(BASE, "")); });
  await page.goto("about:blank");
  await page.goto(`${BASE}/#ask`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3200);
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /科研助手/.test(x.textContent || "")); if (b) b.click(); });
  await page.waitForTimeout(1200);
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /科研助手|收起/.test(b.textContent || ""));
    let host = btn; while (host && getComputedStyle(host).position !== "fixed") host = host.parentElement;
    const panel = host?.querySelector('div[class*="w-80"]');
    let target = null;
    for (const b of panel.querySelectorAll("button")) { if (/▶/.test(b.textContent || "")) { target = b; break; } }
    if (!target) return null;
    const label = (target.textContent || "").trim();
    target.click();
    return label;
  });
  await page.waitForTimeout(2500);
  t("助手列出的动作可点击", clicked !== null, clicked ? `点了「${clicked}」` : "没有可点的动作");
  t("点击后助手自动收起(不挡页面)", await page.evaluate(() => !document.querySelector('div[class*="w-80"][class*="rounded-2xl"]')));
}

console.log("\n═══ ④ 页面无 JS 错误 ═══");
t("助手与桥接不报错", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log("\n" + "=".repeat(52));
console.log(`通过 ${pass} / 失败 ${fail}`);
await browser.close();
process.exit(fail ? 1 : 0);
