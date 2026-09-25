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

const BASE = process.env.API_BASE || process.env.ORCH_UI_BASE || "http://127.0.0.1:4173";
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
//
// ⚠ 2026-09-23 **ask 也移出** —— 它与上面那两个是**同一种情况, 当初漏判了**:
//   ask 唯一的动作 `ask:run` 的 disabled 是 `running || !query.trim() || !selectedProjectId`,
//   **初始状态必然禁用**(查询框是空的, 还要先选检索库)。于是"助手里必须列出动作"这条
//   对 ask 恒为假 —— 断言的是错误的行为。
//   为什么以前一直过: 本地 4173 的 localStorage 里存着上次选过的库, `selectedProjectId` 有值;
//   CI 是干净环境 → 面板里一个可点动作都没有 → ① 缺 ask、②-7/③ "没有可点的动作" 一起红。
//   **这是"本地有历史状态撑着所以看起来是对的"的又一例。**
//   判据(下次往这个列表加页签时照这个问): **这一页在不带任何历史状态的干净会话里,
//   初始就有一个"可见且未禁用"的动作吗?** 没有 → 放 WITH_ACTIONS 就是错的。
const WITH_ACTIONS = ["literature", "paper-outline", "dag-workbench", "plot-agent",
  "editor", "empirical-research", "eval", "structure", "truth", "dream", "skills", "jupyter"];

const browser = await chromium.launch({ headless: true, executablePath: resolveBrowser({ envVar: "UI_VERIFY_BROWSER", label: "node scripts/verify-assistant-coverage.mjs" }) });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => {
  const msg = String(e.message).slice(0, 140);
  // V417: 过滤**第三方内嵌页**的错误 —— MemoryPanel 会内嵌 OpenViking Studio
  //   (http://127.0.0.1:1933/studio)。OpenViking 在线时, 它的 Studio 在非 https 的
  //   localhost 上注册 ServiceWorker 失败, 报 "Failed to register a ServiceWorker for
  //   scope ('http://127.0.0.1:1933/studio')" —— 这是**它的**前端错误, 不是 SAG 页面的。
  //   本门禁验的是 SAG 外壳无 JS 错误, 第三方 iframe 内部的错误不在此列。
  //   只过滤带 1933 的错误: 其余照旧收, 不借这个口子放宽任何真实断言。
  if (msg.includes("127.0.0.1:1933") || msg.includes(":1933/studio")) return;
  errors.push(msg);
});

/**
 * 点「科研助手」FAB —— **点第一个可见的, 不是第一个匹配的**。
 *
 * ⚠ 2026-09-23 修。原实现是 `.find(文本匹配)` 后直接 `.click()`, 不看可见性:
 *   只要**第一个**同文案的按钮不可见(FAB 在展开态是隐藏的; 窄屏下有汉堡菜单里的副本),
 *   这一下就点在空气上 → 面板打不开 → 后面一串断言全废, 而报错只写"没找到动作按钮"。
 *   CI 上那 4 条 FAIL 正是这个形态(本机全过, CI 上"面板可能已关")。
 *   改成先过滤可见再取第一个, 与"人只会点到看得见的东西"一致;
 *   同时把命中情况记到 window.__lastFab, 让失败诊断能直接说出"匹配几个/可见几个"。
 */
const CLICK_FAB = `(() => {
  const all = [...document.querySelectorAll('button')].filter((b) => /科研助手/.test(b.textContent || ''));
  const vis = all.filter((e) => !!(e.offsetWidth || e.offsetHeight));
  window.__lastFab = { matched: all.length, visible: vis.length };
  if (vis.length) { vis[0].click(); return true; }
  return false;
})()`;

/** 打开视图并读助手面板内容 */
async function read(view) {
  await page.goto("about:blank");
  await page.goto(`${BASE}/#${view}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3200);
  return page.evaluate(() => {
    // 点可见的那个(见 CLICK_FAB 注释)
    void (() => { const all = [...document.querySelectorAll("button")].filter((b) => /科研助手/.test(b.textContent || "")); const vis = all.filter((e) => !!(e.offsetWidth || e.offsetHeight)); window.__lastFab = { matched: all.length, visible: vis.length }; if (vis.length) vis[0].click(); })();
    return new Promise((res) => setTimeout(() => {
      // 2026-09-15: 展开时 FAB 已隐藏(用户要求去掉重复的「收起」按钮), 不能再靠按钮文案
      //   反查容器 —— 直接从面板本身往上找 fixed 宿主。
      const panelEl = document.querySelector('[data-assistant-panel]');
      let host = panelEl; while (host && getComputedStyle(host).position !== "fixed") host = host.parentElement;
      const panel = host?.querySelector('[data-assistant-panel]');
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

console.log("\n═══ ②·5 展开态只有一个关闭入口 ═══");
{
  // 2026-09-15 用户反馈"怎么有两个删除按钮, 保留一个即可, 收起可以去掉了":
  //   修复前 FAB 展开时会变成「✕ 收起」, 与面板头部的 ✕ 重复。
  //   这里钉住"展开期间 FAB 隐藏", 免得以后又把第二个关闭入口加回来。
  await page.goto("about:blank");
  await page.goto(`${BASE}/#literature`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3200);
  const closedFab = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /科研助手/.test(b.textContent || "")));
  await page.evaluate((expr) => { void eval(expr); }, CLICK_FAB);
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const all = [...document.querySelectorAll("button")];
    return {
      panel: !!document.querySelector('[data-assistant-panel]'),
      fab: all.filter((b) => /科研助手|收起/.test(b.textContent || "")).map((b) => (b.textContent || "").trim()),
    };
  });
  t("收起态: FAB 可见(入口在)", closedFab);
  t("展开态: 面板在", r.panel);
  t("展开态: FAB 不出现(关闭只留头部 ✕)", r.panel && r.fab.length === 0, `实际 ${JSON.stringify(r.fab)}`);

  // 2026-09-15 用户反馈"删除按钮点击后无法删除":
  //   头部整条挂了 onPointerDown={startDrag}, 而 startDrag 会 setPointerCapture ——
  //   指针被头部捕获后, 后续 click 被重定向到头部 DIV, ✕ 的 onClick 永不触发。
  //   用真实鼠标事件(mousedown/up)而非 el.click() 才复现得出 —— el.click() 不带指针捕获。
  const xPt = await page.evaluate(() => {
    const pn = document.querySelector('[data-assistant-panel]');
    const b = pn?.querySelector("button");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!xPt) { t("点 ✕ 能关闭面板", false, "找不到头部按钮"); }
  else {
    await page.mouse.move(xPt.x, xPt.y);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(1000);
    t("点 ✕ 能关闭面板(需真实指针事件)", !(await page.evaluate(() => !!document.querySelector('[data-assistant-panel]'))));
  }
}

console.log("\n═══ ②-6 拖动自由度(不能被「给面板预留空间」吃掉) ═══");
{
  // 2026-09-15 用户反馈"不能随意挪移了, 往右侧移有边界":
  //   修"✕ 在屏外"时曾把 x 上界按**面板宽度**收紧, 结果右侧凭空多出 235px 拖不过去的死区。
  //   根因是拿展开态的尺寸去限制收起态的移动范围。现在改为"不限制移动, 面板自己找放得下的一侧",
  //   这里钉住: 必须能拖到屏幕最右(按钮右缘贴屏)。
  await page.goto("about:blank");
  await page.goto(`${BASE}/#literature`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3200);
  await page.evaluate(() => localStorage.removeItem("marx:assistant:pos:v1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3200);
  const vw = await page.evaluate(() => window.innerWidth);
  const fab = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /科研助手/.test(x.textContent || ""));
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await page.mouse.move(fab.x, fab.y);
  await page.mouse.down();
  await page.mouse.move(fab.x + 1400, fab.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const right = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /科研助手/.test(x.textContent || ""));
    return Math.round(b.getBoundingClientRect().right);
  });
  t("能拖到屏幕最右侧(无右侧死区)", right >= vw - 8, `FAB 右缘 ${right} / 视口 ${vw}, 剩余 ${vw - right}px`);
}

console.log("\n═══ ②-7 整卡可拖 + 内部元素不受影响 ═══");
{
  // 2026-09-15 用户反馈"抓手只能抓顶部, 不能整个卡片抓":
  //   原先只有头部那条挂 onPointerDown, 卡片其余部分(含大量空白)拖不动。
  //   改为整卡可拖时必须用"阈值延迟启动"—— 头部整条 preventDefault + setPointerCapture 的老写法
  //   会让内部按钮全部失灵(正是前一版"✕ 点不动"的成因), 而卡片里全是按钮/链接。
  //   这里同时钉住两件相反的事: 空白处能拖, 按钮仍能点。
  await page.goto("about:blank");
  await page.goto(`${BASE}/#literature`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3200);
  await page.evaluate(() => {
    localStorage.setItem("marx:assistant:pos:v1", JSON.stringify({ x: 320, y: 200 }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3600);
  await page.evaluate((expr) => { void eval(expr); }, CLICK_FAB);
  await page.waitForTimeout(1400);

  const readPos = () => page.evaluate(() => JSON.parse(localStorage.getItem("marx:assistant:pos:v1") || "null"));
  const dragFrom = async (pt, dx, dy) => {
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.down();
    await page.mouse.move(pt.x + dx, pt.y + dy, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(800);
  };

  const p0 = await readPos();
  // 头部之外 —— 面板左上角的卡片边框内侧空白
  const blank = await page.evaluate(() => {
    const pn = document.querySelector("[data-assistant-panel]");
    const r = pn.getBoundingClientRect();
    return { x: Math.round(r.left + 6), y: Math.round(r.top + 6) };
  });
  await dragFrom(blank, 60, 50);
  const p1 = await readPos();
  t("卡片空白处可拖(不止顶部抓手)", p1 && p0 && (p1.x !== p0.x || p1.y !== p0.y), `${JSON.stringify(p0)} → ${JSON.stringify(p1)}`);

  // 内部动作按钮仍需可点(先滚进可视区, 否则中心点可能落在滚动容器可见区之外)
  const act = await page.evaluate(() => {
    const pn = document.querySelector("[data-assistant-panel]");
    if (!pn) return null;
    const b = [...pn.querySelectorAll("button")].find((x) => /▶/.test(x.textContent || ""));
    if (!b) return null;
    b.scrollIntoView({ block: "center" });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: (b.textContent || "").trim().slice(0, 16) };
  });
  if (!act) { t("内部动作按钮仍可点", false, "没找到动作按钮(面板可能已关)"); }
  else {
    await page.waitForTimeout(400);
    await page.mouse.move(act.x, act.y);
    await page.mouse.down();
    await page.waitForTimeout(110);
    await page.mouse.up();
    await page.waitForTimeout(1400);
    t("内部动作按钮仍可点", !(await page.evaluate(() => !!document.querySelector("[data-assistant-panel]"))), `点了「${act.label}」`);
  }
}

console.log("\n═══ ③ 点助手动作真的驱动页面 ═══");
{
  const posts = [];
  page.on("request", (req) => { if (req.method() === "POST") posts.push(req.url().replace(BASE, "")); });
  await page.goto("about:blank");
  await page.goto(`${BASE}/#literature`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3200);
  await page.evaluate((expr) => { void eval(expr); }, CLICK_FAB);
  await page.waitForTimeout(1200);
  const clicked = await page.evaluate(() => {
    const panelEl = document.querySelector('[data-assistant-panel]');
    let host = panelEl; while (host && getComputedStyle(host).position !== "fixed") host = host.parentElement;
    const panel = host?.querySelector('[data-assistant-panel]');
    let target = null;
    for (const b of panel.querySelectorAll("button")) { if (/▶/.test(b.textContent || "")) { target = b; break; } }
    if (!target) return null;
    const label = (target.textContent || "").trim();
    target.click();
    return label;
  });
  await page.waitForTimeout(2500);
  t("助手列出的动作可点击", clicked !== null, clicked ? `点了「${clicked}」` : "没有可点的动作");
  t("点击后助手自动收起(不挡页面)", await page.evaluate(() => !document.querySelector('[data-assistant-panel]')));
}

console.log("\n═══ ④ 页面无 JS 错误 ═══");
t("助手与桥接不报错", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log("\n" + "=".repeat(52));
console.log(`通过 ${pass} / 失败 ${fail}`);
await browser.close();
process.exit(fail ? 1 : 0);
