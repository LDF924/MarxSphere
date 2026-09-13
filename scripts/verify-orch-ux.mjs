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

/**
 * 取元素中心的**屏幕坐标**, 并保证它在视口内。
 *
 * 为什么必须滚到可见: 布局是"上排三块 + 下方通栏画布", 两者加起来超过视口高度, 画布里的节点
 * 天然有一部分在视口外。直接 getBoundingClientRect 取到的 y 可能 > innerHeight,
 * page.mouse.click 就会点在窗口外 —— 不报错, 只是什么都没发生(我已因此误判过两次"功能坏了")。
 * scrollIntoView 之后再取点。
 */
async function centerOf(selector) {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(150);
  const box = await el.boundingBox();
  if (!box) return null;
  const pt = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const inView = await page.evaluate(({ x, y }) =>
    y > 0 && y < window.innerHeight && x > 0 && x < window.innerWidth, pt);
  return inView ? pt : null;
}

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

// ── ①b 加节点必须落在看得见的地方 ──
// 用户报"点击加号时并没有出现新的节点" —— 老算法按节点数排全局网格, 与视野无关,
// 节点一多就落到可视区外(实测 1100x700 时第 7 个压在画布底边)。这里在窄窗口下连加 3 次逐个验可见性。
{
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(600);
  for (let i = 1; i <= 3; i++) {
    const n0 = await page.locator(".vue-flow__node").count();
    await page.locator(".pi-add").first().click({ force: true });
    await page.waitForTimeout(1100);
    const n1 = await page.locator(".vue-flow__node").count();
    const inside = await page.evaluate(() => {
      const c = document.querySelector(".agent-flow-canvas").getBoundingClientRect();
      const last = [...document.querySelectorAll(".vue-flow__node")].pop();
      const r = last.getBoundingClientRect();
      return r.top >= c.top - 4 && r.bottom <= c.bottom + 4 && r.left >= c.left - 4 && r.right <= c.right + 4;
    });
    t(`窄窗口第 ${i} 次加节点, 新节点完整可见`, n1 === n0 + 1 && inside, `${n0}→${n1} visible=${inside}`);
  }
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.waitForTimeout(600);
}

// ── ①c 卡片上要有固定的删除按钮 ──
// 用户报"删除按钮怎么是浮动的, 不是在节点上固定的" —— 现在 ✕ 常驻卡片头部。
{
  const n = await page.locator(".vue-flow__node .node-del").count();
  const nodes = await page.locator(".vue-flow__node").count();
  t("每个节点卡片上都有删除按钮", n === nodes && n > 0, `${n} 个按钮 / ${nodes} 个节点`);
  // 首个节点是起点、有下游 → 现在会先弹后果确认(见 4b); 这里走完整流程
  const before = nodes;
  await page.locator(".vue-flow__node .node-del").first().click({ force: true });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "仍然删除" }).click({ force: true });
  await page.waitForTimeout(700);
  t("点卡片上的 ✕ 能删掉节点", (await page.locator(".vue-flow__node").count()) === before - 1, `${before} → ${await page.locator(".vue-flow__node").count()}`);
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
  const arrow = await centerOf(".vue-flow__node .node-arrow");
  t("探针能取到卡片 → 的可见坐标", !!arrow, arrow ? JSON.stringify(arrow) : "元素不在视口内");
  if (arrow) await clickAt(arrow.x, arrow.y);
  t("卡片「待执行 →」能打开详情面板", await page.locator(".workspace-panel").isVisible().catch(() => false));

  // 4c. 浮层里有删除按钮, 且真的删掉
  const btns = await page.locator(".workspace-panel button").allInnerTexts();
  t("详情浮层里有「删除节点」按钮", btns.some((b) => /删除节点/.test(b)), JSON.stringify(btns.map((s) => s.trim())));
  const nBefore = await page.locator(".vue-flow__node").count();
  await page.locator(".workspace-panel button", { hasText: "删除节点" }).first().click({ force: true });
  await page.waitForTimeout(800);
  // 起点节点有下游 → 会弹确认; 确认后才删
  await page.getByRole("button", { name: "仍然删除" }).click({ force: true });
  await page.waitForTimeout(700);
  t("点删除后画布节点数 -1", (await page.locator(".vue-flow__node").count()) === nBefore - 1, `${nBefore} → ${await page.locator(".vue-flow__node").count()}`);

  // 4d. 选中连线后出现删除按钮, 点了能删
  // 注意: 只有**边**用这个浮动按钮 —— 节点卡片自带 ✕, 再挂一个圆形钮是重复的(用户指出过)。
  await open();
  // 连线是 SVG 曲线: 取路径中点(包围盒中心常常不在曲线上)。先把画布滚进视口再取,
  // 否则 y 可能 > innerHeight, 点了等于没点(和上面 → 是同一类坑)。
  await page.locator(".vue-flow__pane").scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(200);
  const p = await page.evaluate(() => {
    const el = document.querySelector(".vue-flow__edge path");
    const q = el.getPointAtLength(el.getTotalLength() / 2);
    const m = el.getScreenCTM();
    const x = q.x * m.a + q.y * m.c + m.e, y = q.x * m.b + q.y * m.d + m.f;
    return { x, y, inView: y > 0 && y < window.innerHeight && x > 0 && x < window.innerWidth };
  });
  t("连线中点落在视口内(探针取点前提)", p.inView, JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) }));
  await clickAt(p.x, p.y);
  const k = await page.locator(".canvas-kill.is-edge").count();
  t("点中连线后出现删除按钮", k > 0, `${k} 个`);
  t("选中的节点上不再出现重复的圆形删除钮", (await page.locator(".canvas-kill.is-node").count()) === 0,
    `${await page.locator(".canvas-kill.is-node").count()} 个`);
  const eBefore = await page.locator(".vue-flow__edge").count();
  if (k) {
    await page.locator(".canvas-kill.is-edge").first().click({ force: true });
    await page.waitForTimeout(600);
    t("点小红叉删掉这条连线", (await page.locator(".vue-flow__edge").count()) === eBefore - 1, `${eBefore} → ${await page.locator(".vue-flow__edge").count()}`);
  }
}

// ── ④b 删除的后果提示(用户选的是"不保护但给提示") + 空白处右键的两项 ──
// 设计: 节点**都可删**(不硬保护, 免得妨碍自由组合), 但删掉会让下游失去输入的, 先弹确认。
// 判据是图结构(有无出边)而不是"是不是模板起点" —— 用户可以把任何节点连成起点。
{
  await open();
  const n0 = await page.locator(".vue-flow__node").count();
  // 4b-1 删有下游的节点 → 弹确认, 取消后不删
  await page.locator(".vue-flow__node .node-del").first().click({ force: true });
  await page.waitForTimeout(900);
  const dlgTitle = (await page.locator("h3").first().innerText().catch(() => "")).trim();
  // 取整个确认浮层的文本: 正文是 head 的兄弟, 不是 h3 的兄弟(按 h3 找会拿到 × 按钮)
  const dlgBody = await page.evaluate(() => {
    const ov = [...document.querySelectorAll("div")].find((d) => d.style.position === "fixed" && d.style.zIndex === "200");
    return ov ? ov.innerText : "";
  });
  t("删除有下游的节点会先提示后果", dlgTitle.length > 0, `标题=「${dlgTitle}」`);
  t("提示里说清了下游数量与名字", /下游|失去输入/.test(dlgBody) && /[0-9]/.test(dlgBody), dlgBody.replace(/\s+/g, " ").slice(0, 90));
  await page.getByRole("button", { name: "取消" }).click({ force: true });
  await page.waitForTimeout(500);
  t("取消后节点仍在", (await page.locator(".vue-flow__node").count()) === n0, `${n0} → ${await page.locator(".vue-flow__node").count()}`);

  // 4b-2 确认后才真的删
  await page.locator(".vue-flow__node .node-del").first().click({ force: true });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "仍然删除" }).click({ force: true });
  await page.waitForTimeout(800);
  t("确认后真的删掉", (await page.locator(".vue-flow__node").count()) === n0 - 1, `${n0} → ${await page.locator(".vue-flow__node").count()}`);

  // 4b-3 删末端节点(无下游)不打扰用户
  await open();
  const n1 = await page.locator(".vue-flow__node").count();
  await page.locator(".vue-flow__node .node-del").last().click({ force: true });
  await page.waitForTimeout(800);
  const popped = await page.locator("h3").first().isVisible().catch(() => false);
  t("删无下游的节点不弹确认", !popped, popped ? "弹了" : "直接删");
  t("末端节点已删除", (await page.locator(".vue-flow__node").count()) === n1 - 1, `${n1} → ${await page.locator(".vue-flow__node").count()}`);

  // 4b-4 空白处右键补回的两项(原版有「新建空白任务」, 重写时丢了)
  await open();
  const paneBox = await page.locator(".vue-flow__pane").boundingBox();
  // 注意: 取点必须在窗口内。画布挪到下方通栏后, "pane 底边 - 60" 会算到 y>窗口高,
  // elementFromPoint 返回 null → 右键落空(实测踩到, 一度以为菜单坏了)。用 pane 内靠上的点。
  const clickPt = { x: Math.round(paneBox.x + 60), y: Math.round(paneBox.y + 60) };
  const inWindow = await page.evaluate(({ x, y }) => y < window.innerHeight && x < window.innerWidth, clickPt);
  t("探针取点在窗口内", inWindow, JSON.stringify(clickPt));
  await page.mouse.click(clickPt.x, clickPt.y, { button: "right" });
  await page.waitForTimeout(700);
  const pmenu = await page.locator(".canvas-context-menu").innerText().catch(() => "");
  t("空白处右键有「新建空白任务」", /新建空白任务/.test(pmenu));
  t("空白处右键有「清空画布」", /清空画布/.test(pmenu));
  await page.locator(".context-menu-item", { hasText: "新建空白任务" }).click({ force: true });
  await page.waitForTimeout(800);
  const afterNew = await page.locator(".vue-flow__node").count();
  t("新建空白任务后只剩一个起点节点", afterNew === 1, `${afterNew} 个节点`);
}

// ── ④c 声明式 DAG 区(MetaSkill 的独有能力融进编排页) ──
// 两件事: ① 已注册的 DAG 能"打开到画布"继续改(以前只能在 MetaSkill 面板点运行);
//         ② 候选流程(提案)能在这审 —— 且**来源技能可追溯**(此前 sourceSkillIds 全是 null)
{
  await open();
  // 位置: 声明式 DAG 现在占据右栏(原画布位置), 画布挪到页面下方通栏 —— 用几何关系断言,
  // 不写死"在页面下方"这种会随布局变动的措辞
  t("右栏是「声明式 DAG」面板", (await page.locator(".dag-panel").count()) === 1);
  const geo = await page.evaluate(() => {
    const dag = document.querySelector(".dag-panel")?.getBoundingClientRect();
    const band = document.querySelector(".canvas-band")?.getBoundingClientRect();
    const pal = document.querySelector(".palette-panel")?.getBoundingClientRect();
    return dag && band ? {
      dagTop: Math.round(dag.top), bandTop: Math.round(band.top),
      dagRightOfPalette: pal ? dag.left >= pal.right - 2 : true,
      bandIsFullWidth: Math.round(band.width) > Math.round(dag.width),
    } : null;
  });
  t("DAG 面板在画布上方", !!geo && geo.dagTop < geo.bandTop, JSON.stringify(geo));
  t("DAG 面板与能力面板并排(不重叠)", !!geo && geo.dagRightOfPalette);
  t("画布通栏比 DAG 面板宽", !!geo && geo.bandIsFullWidth, JSON.stringify(geo));
  const dagItems = await page.locator('.dag-row').first().locator(".dag-item").count();
  t("列出了可打开的已注册 DAG", dagItems > 0, `${dagItems} 条`);
  const proposeBox = await page.locator(".dag-panel input.dag-input").count();
  t("候选区可提交高频主题让平台组装", proposeBox > 0);

  // 来源可追溯: 提案上要显示参与编排的技能名(修 null 之前这里是空的)
  // 已注册/候选改成上下两段后, 候选是第二个 .dag-row(原来是第二个 .dag-col)
  const propText = await page.locator(".dag-row").nth(1).locator(".dag-item").first().innerText().catch(() => "");
  const srcLine = (propText.split("\n").find((l) => l.includes("来源技能")) ?? "(无)").trim();
  t("候选条目显示了来源技能(可追溯)", srcLine.includes("来源技能"), srcLine);
  t("来源技能不再标注 id 缺失", !propText.includes("id 缺失"));

  // 打开到画布: 节点数应变成该 DAG 的步数
  const n0 = await page.locator(".vue-flow__node").count();
  await page.locator(".dag-item button", { hasText: "打开到画布" }).first().click({ force: true });
  await page.waitForTimeout(1500);
  const n1 = await page.locator(".vue-flow__node").count();
  const titles = await page.locator(".vue-flow__node .node-title-row strong").allInnerTexts();
  t("「打开到画布」把声明式 DAG 变成了可编辑节点", n1 > 0 && n1 !== n0, `${n0} → ${n1}`);
  t("节点标题来自该 DAG 的步骤", /澄清综述范围|检索文献素材|生成综述/.test(titles.join("|")), titles.slice(0, 3).join(" | "));
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
