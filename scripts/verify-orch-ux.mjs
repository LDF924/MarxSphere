// scripts/verify-orch-ux.mjs — V415: 编排画布的「可操作性」回归(用户 2026-09-13 报的 7 条)
//
// 与 verify-orch-ui.mjs 的分工: 那个测"流程能不能跑通", 这个测"人能不能操作它" ——
// 上一轮就是只测了前者, 于是右键菜单被覆盖、边端拖不动、••• 点了没反应这类问题全都没被发现。
//
// 覆盖: ①左右拉伸 ②页面滚动 ③边改接(含环/自环/去重) ④节点删除入口(浮层/•••/小红叉)
//       ⑤创作能力节点 ⑥运行记录展开看过程 ⑦节点卡片可拖动
// 用法: node scripts/verify-orch-ux.mjs   (需 4173 已起)
import { chromium } from "playwright";
import { resolveBrowser } from "./lib/find-browser.mjs";

const BASE = process.env.ORCH_UI_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ headless: true, executablePath: resolveBrowser({ envVar: "UI_VERIFY_BROWSER", label: "node scripts/verify-orch-ux.mjs" }) });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));

const open = async () => {
  // 注意: 同 URL 只改 hash 的 goto **不会重载文档**, 上一段留下的浮层会继续挡着后续点击
  // (实测: 4a 的右键菜单挡住 4b 的 → 点击, 表现成"→ 点了没反应"的假失败)。先过 blank 强制重载。
  await page.goto("about:blank");
  await page.goto(`${BASE}/soc/index.html#/workbench/quick`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".palette-item", { timeout: 30000 });
  await page.waitForTimeout(3200);
};
const edgesOf = () => page.evaluate(() => [...document.querySelectorAll(".vue-flow__edge")].map((e) => e.getAttribute("data-id")));
/** 用坐标点: locator.click 的可点性检查会被浮层动画挡出假超时(实测踩过) */
const clickAt = async (x, y) => { await page.mouse.click(x, y); await page.waitForTimeout(600); };

await open();

// ── ① 左右拉伸: 三栏之间有两条独立的拉伸条(助手↔能力节点 / 能力节点↔画布) ──
{
  const n = await page.locator(".pane-splitter").count();
  t("三栏之间有两条拉伸条", n === 2, `${n} 条`);
  // 先拖最左那条(助手 ↔ 能力节点) —— 第一版只做了右边那条, 用户当场发现左边拉不动
  const a0 = await page.evaluate(() => document.querySelector(".agent-panel")?.getBoundingClientRect().width);
  const s0 = await page.locator(".pane-splitter").first().boundingBox();
  if (s0) {
    await page.mouse.move(s0.x + s0.width / 2, s0.y + 200);
    await page.mouse.down();
    await page.mouse.move(s0.x + s0.width / 2 + 110, s0.y + 200, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const a1 = await page.evaluate(() => document.querySelector(".agent-panel")?.getBoundingClientRect().width);
    t("拖动后编排助手变宽", a1 > a0 + 70, `${Math.round(a0)} → ${Math.round(a1)}`);
    t("助手宽度写入 localStorage", Number(await page.evaluate(() => localStorage.getItem("orch_agent_w"))) > 280);
  }
  const w0 = await page.evaluate(() => document.querySelector(".palette-panel")?.getBoundingClientRect().width);
  const sp = await page.locator(".pane-splitter").nth(1).boundingBox();
  t("能力面板与画布之间有拉伸条", !!sp, sp ? `x=${Math.round(sp.x)} 命中宽=${Math.round(sp.width)}px` : "无");
  if (sp) {
    await page.mouse.move(sp.x + sp.width / 2, sp.y + 200);
    await page.mouse.down();
    await page.mouse.move(sp.x + sp.width / 2 + 90, sp.y + 200, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const w1 = await page.evaluate(() => document.querySelector(".palette-panel")?.getBoundingClientRect().width);
    t("拖动后能力面板变宽", w1 > w0 + 70, `${Math.round(w0)} → ${Math.round(w1)}`);
    t("宽度写入 localStorage", Number(await page.evaluate(() => localStorage.getItem("orch_palette_w"))) > 280);
  }
}

// ── ② 页面上下滚动(窗口压矮) ──
{
  // 视口 560 时内容正好铺满(不该出现滚动条), 所以用 460 —— 那时必然溢出
  await page.setViewportSize({ width: 1600, height: 460 });
  await page.waitForTimeout(700);
  const s = await page.evaluate(() => {
    const v = document.querySelector(".quick-view");
    return { can: v.scrollHeight > v.clientHeight + 4, sh: v.scrollHeight, ch: v.clientHeight, oy: getComputedStyle(v).overflowY };
  });
  t("窗口压矮后整页可上下滚", s.can && s.oy === "auto", JSON.stringify(s));
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.waitForTimeout(500);
}

// ── ③ 边改接 ──
{
  const before = await edgesOf();
  const plan = await page.evaluate(() => {
    const u = document.querySelector(".vue-flow__edgeupdater-target");
    const cur = u?.closest(".vue-flow__edge")?.getAttribute("data-id") || "";
    const ur = u?.getBoundingClientRect();
    let pick = null;
    for (const n of [...document.querySelectorAll(".vue-flow__node")]) {
      const id = n.getAttribute("data-id");
      const short = id.replace("agent-", "");
      if (cur.endsWith("-" + short) || cur.includes("-" + short + "-")) continue; // 跳过当前终点与起点
      const h = n.querySelector(".vue-flow__handle.target");
      if (!h) continue;
      const hr = h.getBoundingClientRect();
      pick = { id, x: Math.round(hr.x + hr.width / 2), y: Math.round(hr.y + hr.height / 2) };
      break;
    }
    return ur ? { ux: Math.round(ur.x + ur.width / 2), uy: Math.round(ur.y + ur.height / 2), cur, pick } : { cur, pick: null };
  });
  if (plan.ux && plan.pick) {
    await page.mouse.move(plan.ux, plan.uy);
    await page.mouse.down();
    await page.mouse.move((plan.ux + plan.pick.x) / 2, (plan.uy + plan.pick.y) / 2, { steps: 18 });
    await page.mouse.move(plan.pick.x, plan.pick.y, { steps: 18 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(1000);
  }
  const after = await edgesOf();
  const added = after.find((x) => !before.includes(x));
  t("拖动已有边的一端能改接到新卡片", !!added && added.endsWith(plan.pick?.id.replace("agent-", "") || "##"), `${plan.cur} → ${added ?? "未变"}；共 ${after.length} 条`);
  t("改接是换终点, 不是新增一条", after.length === before.length, `${before.length} → ${after.length}`);
}

// ── ④ 删除入口 ──
{
  // 4a. ••• 打开节点菜单(空白页重载, 不受其它浮层干扰)
  await open();
  await page.locator(".vue-flow__node .node-menu").first().click({ force: true });
  await page.waitForTimeout(700);
  const menu = await page.locator(".canvas-context-menu").innerText().catch(() => "");
  t("卡片右上角 ••• 能开节点菜单", /删除节点/.test(menu), menu ? menu.split("\n").slice(0, 4).join(" / ") : "(无菜单)");

  // 4b. → 打开详情面板
  await open();
  const arrow = await page.evaluate(() => {
    const a = document.querySelector(".vue-flow__node .node-arrow");
    const r = a.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await clickAt(arrow.x, arrow.y);
  t("卡片「待执行 →」能打开详情面板", await page.locator(".workspace-panel").isVisible().catch(() => false));

  // 4c. 浮层里有删除按钮, 且真的删掉
  const btns = await page.locator(".workspace-panel button").allInnerTexts();
  t("详情浮层里有「删除节点」按钮", btns.some((b) => /删除节点/.test(b)), JSON.stringify(btns.map((s) => s.trim())));
  const nBefore = await page.locator(".vue-flow__node").count();
  await page.locator(".workspace-panel button", { hasText: "删除节点" }).first().click({ force: true });
  await page.waitForTimeout(700);
  t("点删除后画布节点数 -1", (await page.locator(".vue-flow__node").count()) === nBefore - 1, `${nBefore} → ${await page.locator(".vue-flow__node").count()}`);

  // 4d. 选中连线后出现小红叉, 点了能删
  await open();
  const p = await page.evaluate(() => {
    const el = document.querySelector(".vue-flow__edge path");
    const q = el.getPointAtLength(el.getTotalLength() / 2);
    const m = el.getScreenCTM();
    return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f };
  });
  await clickAt(p.x, p.y);
  const k = await page.locator(".canvas-kill.is-edge").count();
  t("点中连线后出现删除按钮", k > 0, `${k} 个`);
  const eBefore = await page.locator(".vue-flow__edge").count();
  if (k) {
    await page.locator(".canvas-kill.is-edge").first().click({ force: true });
    await page.waitForTimeout(600);
    t("点小红叉删掉这条连线", (await page.locator(".vue-flow__edge").count()) === eBefore - 1, `${eBefore} → ${await page.locator(".vue-flow__edge").count()}`);
  }
}

// ── ⑤ 创作能力节点 ──
{
  await open();
  const nBefore = await page.locator(".vue-flow__node").count();
  await page.locator(".palette-create").click();
  await page.waitForTimeout(600);
  t("「＋ 创作能力节点」打开编辑弹层", await page.locator(".modal-card").filter({ hasText: "创作能力节点" }).isVisible().catch(() => false));
  await page.locator(".modal-card input.palette-search").first().fill("交叉验证数据来源");
  await page.locator(".modal-card textarea.set-input").fill("对上游结论里的每个数据点列出替代解释。");
  await page.locator("button", { hasText: "添加到画布" }).first().click();
  await page.waitForTimeout(800);
  const nAfter = await page.locator(".vue-flow__node").count();
  const titles = await page.locator(".vue-flow__node .node-title-row strong").allInnerTexts();
  t("创作节点被加进画布且用自定义标题", nAfter === nBefore + 1 && titles.includes("交叉验证数据来源"), `${nBefore} → ${nAfter}; ${titles.slice(-2).join("|")}`);
}

// ── ⑥ 运行记录展开 ──
{
  await open();
  await page.getByRole("button", { name: "运行记录" }).click();
  await page.waitForTimeout(1500);
  const rows = await page.locator(".run-row").count();
  t("运行记录弹层有记录", rows > 0, `${rows} 条`);
  await page.locator(".run-row").first().click({ force: true });
  await page.waitForTimeout(600);
  const steps = await page.locator(".run-detail .run-step").count();
  const first = await page.locator(".run-detail .run-step").first().innerText().catch(() => "");
  t("点一条记录能展开看到运行过程", steps > 0, `${steps} 步; 首步: ${first.replace(/\n/g, " | ").slice(0, 90)}`);
  t("步骤里带依赖来源或耗时", /依赖|s|字/.test(first), first.replace(/\n/g, " | ").slice(0, 90));
}

// ── ⑦ 节点卡片可拖动 ──
{
  await open();
  await page.locator(".vue-flow__node .node-arrow").first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(600);
  const before = await page.locator(".workspace-panel").boundingBox();
  const grip = await page.locator(".workspace-panel-header").boundingBox();
  if (before && grip) {
    await page.mouse.move(grip.x + 60, grip.y + 14);
    await page.mouse.down();
    await page.mouse.move(grip.x + 60 - 260, grip.y + 14 + 120, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const after = await page.locator(".workspace-panel").boundingBox();
    t("节点详情浮层能拖动", !!after && (Math.abs(after.x - before.x) > 150 || Math.abs(after.y - before.y) > 80),
      `(${Math.round(before.x)},${Math.round(before.y)}) → (${Math.round(after?.x ?? -1)},${Math.round(after?.y ?? -1)})`);
  } else {
    t("节点详情浮层能拖动", false, "找不到浮层");
  }
}

t("页面无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
console.log(`\n${"=".repeat(52)}\n通过 ${pass} / 失败 ${fail}`);
await browser.close();
process.exit(fail ? 1 : 0);
