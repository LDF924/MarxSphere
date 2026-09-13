// scripts/verify-orch-ui.mjs — V415 编排画布 浏览器端实测(Playwright + Chromium headless)
// 覆盖: 能力面板加载 → 模板自动载入 → 画布渲染节点与连线 → 加节点(双击/＋) → 节点详情参数 →
//       切换模板 → 页面内启动编排并观察到终态 → 依赖传递 → 控制按钮随状态切换
// 用法: node scripts/verify-orch-ui.mjs
import { chromium } from "playwright";
import { existsSync, readdirSync } from "node:fs";

const BASE = process.env.ORCH_UI_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (name, ok, extra = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };

/** Playwright 各平台的浏览器缓存根目录(扫描用; 不同平台默认路径不同) */
function playwrightRoots() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return [
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/ms-playwright` : "",      // Windows
    home ? `${home}/.cache/ms-playwright` : "",                                        // Linux
    home ? `${home}/Library/Caches/ms-playwright` : "",                                // macOS
    process.env.PLAYWRIGHT_BROWSERS_PATH || "",
  ].filter(Boolean);
}

/** 扫描各平台缓存目录, 找出实际装着的 chromium(目录名带版本号, 不能硬编码) */
function findBrowsers() {
  const out = [];
  for (const root of playwrightRoots()) {
    if (!existsSync(root)) continue;
    try {
      for (const d of readdirSync(root).filter((x) => /^chromium/.test(x))) {
        for (const p of [`${root}/${d}/chrome-win64/chrome.exe`, `${root}/${d}/chrome-linux/chrome`, `${root}/${d}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`]) {
          if (existsSync(p)) out.push(p);
        }
      }
    } catch { /* 权限/损坏目录跳过 */ }
  }
  return out;
}

async function launchBrowser() {
  const systemBrowsers = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const attempts = [
    { how: "ORCH_UI_BROWSER 指定", opts: process.env.ORCH_UI_BROWSER ? { executablePath: process.env.ORCH_UI_BROWSER } : null },
    { how: "Playwright 默认", opts: {} },
    ...findBrowsers().map((p) => ({ how: `扫描到的 chromium(${p.split("/").slice(-3)[0]})`, opts: { executablePath: p } })),
    ...systemBrowsers.map((p) => ({ how: `系统浏览器 ${p}`, opts: { executablePath: p } })),
  ].filter((a) => a.opts !== null);
  const failures = [];
  for (const a of attempts) {
    try {
      const b = await chromium.launch({ headless: true, ...a.opts });
      console.log(`[env] 浏览器: ${a.how}\n`);
      return b;
    } catch (e) {
      failures.push(`${a.how}: ${String(e?.message ?? e).split("\n")[0].slice(0, 90)}`);
    }
  }
  console.error("找不到可用的浏览器。已尝试:\n" + failures.map((f) => "  - " + f).join("\n"));
  console.error("\n解决(任选其一):\n  npx playwright install chromium        # 装 Playwright 自带浏览器(约 200MB)\n  ORCH_UI_BROWSER=<chrome/edge 可执行文件路径> node scripts/verify-orch-ui.mjs");
  process.exit(1);
}
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  // 带上资源 URL —— 否则只有 "Failed to load resource: 404" 这种无信息文本
  const loc = m.location?.()?.url ?? "";
  errors.push(`${m.text().slice(0, 160)}${loc ? ` [${loc}]` : ""}`);
});

try {
  // 直达编排页(子应用自带 hash 路由)
  await page.goto(`${BASE}/soc/index.html#/workbench/quick`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".palette-item, .palette-empty", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3500);

  // ── 1. 页面骨架 ──
  const headerText = await page.locator(".brand-lockup").innerText().catch(() => "");
  t("渲染的是编排画布(标题为「课题流程编排」)", /课题流程编排/.test(headerText), headerText.split("\n")[0]);
  t("顶部显示可用能力数与模板名", /可用能力 \d+ 项/.test(headerText), headerText.replace(/\n/g, " | ").slice(0, 110));

  // ── 2. 能力面板 ──
  const capCount = await page.locator(".palette-item").count();
  const capFirst = await page.locator(".palette-item strong").first().innerText().catch(() => "");
  const catCount = await page.locator(".palette-cat").count();
  t("能力面板已渲染节点列表", capCount > 10, `${capCount} 项, 首个=${capFirst}`);
  t("分类筛选器存在", catCount > 3, `${catCount} 个分类`);

  // 搜索过滤
  await page.locator(".palette-search").fill("论文");
  await page.waitForTimeout(500);
  const filtered = await page.locator(".palette-item").count();
  t("能力搜索可过滤", filtered > 0 && filtered < capCount, `${capCount} → ${filtered}`);
  await page.locator(".palette-search").fill("");
  await page.waitForTimeout(400);

  // ── 3. 模板自动载入 ──
  const nodeCount = await page.locator(".vue-flow__node").count();
  const edgeCount = await page.locator(".vue-flow__edge").count();
  const titles = await page.locator(".vue-flow__node .node-title-row strong").allInnerTexts();
  t("模板已载入画布(节点 > 3)", nodeCount > 3, `${nodeCount} 节点`);
  t("渲染了依赖连线", edgeCount > 0, `${edgeCount} 条`);
  t("节点标题来自能力注册表(非旧写死的 phrase)", titles.some((x) => /信息录入|科研架构|素材|正文|质量门|澄清/.test(x)), titles.slice(0, 6).join(" | "));

  // ── 4. 加节点 ──
  const before = nodeCount;
  await page.locator(".palette-item").first().dblclick();
  await page.waitForTimeout(700);
  const afterDbl = await page.locator(".vue-flow__node").count();
  t("双击能力项可加节点", afterDbl === before + 1, `${before} → ${afterDbl}`);

  await page.locator(".pi-add").nth(1).click();
  await page.waitForTimeout(700);
  const afterPlus = await page.locator(".vue-flow__node").count();
  t("「＋」按钮可加节点", afterPlus === before + 2, `${afterPlus}`);

  // ── 5. 节点详情 ──
  await page.locator(".vue-flow__node").first().click();
  await page.waitForTimeout(600);
  const panelOpen = await page.locator(".workspace-panel").isVisible().catch(() => false);
  const panelTitle = await page.locator(".workspace-panel h2").innerText().catch(() => "");
  const fieldCount = await page.locator(".workspace-panel .workspace-field").count();
  t("点节点打开详情面板", panelOpen, panelTitle);
  t("详情面板显示可编辑参数字段", fieldCount > 0, `${fieldCount} 个字段`);
  const panelHasCap = await page.locator(".workspace-panel .drawer-row").first().innerText().catch(() => "");
  t("详情面板显示能力绑定", /能力/.test(panelHasCap), panelHasCap.replace(/\n/g, " "));
  await page.locator(".workspace-panel .workspace-close").click();
  await page.waitForTimeout(300);

  // ── 6. 切换模板(含并联分支的) ──
  const sel = page.locator(".hdr-select").first();
  await sel.selectOption({ label: "多源检索汇编" });
  await page.waitForTimeout(2000);
  const n2 = await page.locator(".vue-flow__node").count();
  const e2 = await page.locator(".vue-flow__edge").count();
  // 该模板实测 6 节点 8 边(四路检索并联进 merge) —— 断言直接对齐模板真实形状,
  // 不用 "e > n-1" 这种线性链判据(它分不清"少画了边"和"本来就是链")。
  t("可切换模板(多源检索汇编)", n2 >= 5, `${n2} 节点 / ${e2} 边`);
  t("模板的并联连线全部渲染(6 节点 8 边)", n2 === 6 && e2 === 8, `${n2} 节点 / ${e2} 边`);

  // 模板库弹层
  await page.getByRole("button", { name: "模板库" }).click();
  await page.waitForTimeout(600);
  const tplCards = await page.locator(".tpl-card").count();
  t("模板库弹层列出全部模板", tplCards >= 10, `${tplCards} 张卡`);
  await page.locator(".tpl-card").first().click();
  await page.waitForTimeout(1200);

  // ── 7. 页面内真跑一条编排 ──
  const started = await page.evaluate(async () => {
    const tok = localStorage.getItem("sag_token") || "";
    return fetch("/api/orchestrator/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({
        graph: {
          id: "ui-probe", name: "UI 探针",
          nodes: [
            { id: "p1", capabilityId: "tool:llm_write", title: "生成", params: { topic: "用两句话说明实践概念", length: "短" } },
            { id: "p2", capabilityId: "tool:summarize", title: "摘要", params: { text: "{{inputs}}" } },
          ],
          edges: [{ source: "p1", target: "p2" }],
        },
      }),
    }).then((r) => r.json());
  });
  t("页面内可启动编排(API 可达)", !!started?.runId, JSON.stringify(started).slice(0, 120));

  let final = null;
  const deadline = Date.now() + 180_000;
  do {
    await page.waitForTimeout(4000);
    final = await page.evaluate((rid) => fetch(`/api/orchestrator/progress?runId=${rid}`).then((r) => r.json()), started.runId);
  } while (!["done", "failed", "cancelled"].includes(final?.status) && Date.now() < deadline);
  console.log(`\n[运行] status=${final?.status} | ${(final?.stepLog ?? []).map((s) => s.stepId + ":" + s.status).join(", ")}`);
  t("编排跑到终态", final?.status === "done", final?.status ?? "?");
  t("依赖传递有记录(上游产出流入下游)", (final?.stepLog ?? []).some((s) => (s.inputsFrom ?? []).length > 0),
    JSON.stringify((final?.stepLog ?? []).map((s) => s.inputsFrom)));
  t("两端都有产出", Object.keys(final?.outputs ?? {}).length === 2, JSON.stringify(Object.keys(final?.outputs ?? {})));
  const up = (final?.outputs?.p1 ?? "").length;
  const down = (final?.outputs?.p2 ?? "").length;
  // 这条链的语义是"摘要": 产出本来就应该比原文短, 所以判据不是"长度同量级",
  // 而是"确实变短了且不为空" —— 若下游退回任务输入, 得到的是 4 字左右的空转结果。
  t("下游确实消费上游产出(摘要变短且非空)", down > 20 && down < up, `up=${up} down=${down}`);

  // ── 8. 控制按钮 ──
  const runBtns = await page.locator(".run-btn").allInnerTexts().catch(() => []);
  t("控制按钮存在", runBtns.length > 0, runBtns.map((x) => x.trim()).join(" / "));

  // ── 9. 弹层: 运行记录 ──
  await page.getByRole("button", { name: "运行记录" }).click();
  await page.waitForTimeout(1200);
  const runRows = await page.locator(".run-row").count();
  t("运行记录弹层能查到后端落库的运行", runRows > 0, `${runRows} 条`);
  await page.locator(".modal-head .workspace-close").click();
  await page.waitForTimeout(300);

  // ── 9b. V415: 成本量级 + Agent 编排开关(用户要求"开关必须前端可见") ──
  const costChip = await page.locator(".cost-chip").innerText().catch(() => "");
  t("画布顶部显示成本量级", /成本\s*(轻量|中等|较重)/.test(costChip), costChip);

  const agentChip = await page.locator(".agent-chip").innerText().catch(() => "");
  t("画布顶部常驻显示 Agent 编排开关状态", /Agent 编排(已开|已关)/.test(agentChip), agentChip);

  await page.locator(".agent-chip").click();
  await page.waitForTimeout(1200);
  const setPanel = await page.locator(".modal-card").filter({ hasText: "编排设置" }).isVisible().catch(() => false);
  t("点状态芯片可打开编排设置", setPanel);
  // 开关本体是 opacity:0 的 checkbox(常见开关做法), 真正可见的是它旁边的滑块 ——
  // 所以判"可见"要看 .switch 容器与 .slider, 不能看 input(Playwright 会报 not visible)。
  const switchVisible = await page.locator(".switch .slider").first().isVisible().catch(() => false);
  t("设置里有可见的开关控件", switchVisible);
  const disabled = await page.locator(".switch input").isDisabled().catch(() => null);
  const warnText = await page.locator(".set-warn").innerText().catch(() => "");
  // 开关默认关且受环境总闸约束: env 未设 ORCH_AGENT_ENABLED=1 时必然 disabled + 给出原因。
  // 所以判据不是"必须能点", 而是"状态与原因都对用户可见"(用户核心要求是可见, 不是必须能开)。
  const envAllowed = await page.evaluate(() => fetch("/api/orchestrator/settings").then((r) => r.json()).then((j) => j.settings.envAllowed));
  t("开关可用性与环境总闸一致",
    envAllowed ? disabled === false : (disabled === true && warnText.length > 0),
    `envAllowed=${envAllowed} disabled=${disabled} 提示="${warnText.replace(/\s+/g, " ").slice(0, 50)}"`);
  t("被禁用时给出可读原因(不是静默灰掉)", !envAllowed ? /ORCH_AGENT_ENABLED|部署方/.test(warnText) : true, warnText.replace(/\s+/g, " ").slice(0, 60));
  await page.locator(".modal-head .workspace-close").click();
  await page.waitForTimeout(300);

  // 后端开关接口: 读 → (总闸允许时)切换 → 读回。
  // 总闸关闭时切换**应当**被 400 拒绝 —— 那是正确行为, 不是失败; 所以这里分两支断言。
  // (把"拒绝"也留作负向证据: 前端若能绕过 env 打开, 这里就会看到意外成功)
  const setting = await page.evaluate(async () => {
    const tok = localStorage.getItem("sag_token") || "";
    const h = { Authorization: "Bearer " + tok, "Content-Type": "application/json" };
    const before = (await fetch("/api/orchestrator/settings", { headers: h }).then((r) => r.json())).settings;
    const res = await fetch("/api/orchestrator/settings", {
      method: "PUT", headers: h, body: JSON.stringify({ enabled: !before.enabled }),
    });
    const body = await res.json().catch(() => ({}));
    let after = null;
    if (res.ok) {
      after = (await fetch("/api/orchestrator/settings", { headers: h }).then((r) => r.json())).settings;
      await fetch("/api/orchestrator/settings", { method: "PUT", headers: h, body: JSON.stringify({ enabled: before.enabled }) });
    }
    return { before, status: res.status, flipped: body.settings, after };
  });
  t("后端设置接口可读", typeof setting?.before?.enabled === "boolean", JSON.stringify(setting?.before));
  if (setting?.before?.envAllowed) {
    t("总闸开时可切换并落库",
      setting?.status === 200 && setting?.after?.enabled === !setting?.before?.enabled,
      `status=${setting?.status} before=${setting?.before?.enabled} after=${setting?.after?.enabled}`);
  } else {
    t("总闸关时切换被拒(前端无法绕过 env 打开)",
      setting?.status === 400 && setting?.before?.enabled === false,
      `status=${setting?.status} before=${setting?.before?.enabled} 错误="${setting?.flipped === undefined ? "(已拒绝)" : ""}"`);
  }

  // ── 10. 弹层: 我的编排(保存/读取) ──
  await page.getByRole("button", { name: "我的编排" }).click();
  await page.waitForTimeout(800);
  await page.locator(".save-row .workspace-primary").click();
  await page.waitForTimeout(1500);
  const saved = await page.locator(".run-row").count();
  t("可保存当前画布为自定义编排", saved > 0, `${saved} 条`);
  // 清理刚保存的探针图
  const cleanErr = await page.evaluate(async () => {
    const tok = localStorage.getItem("sag_token") || "";
    const list = await fetch("/api/orchestrator/graphs", { headers: { Authorization: "Bearer " + tok } }).then((r) => r.json());
    for (const g of list.graphs ?? []) {
      if (/自定义编排|多源检索|标准五阶段/.test(g.name)) {
        await fetch(`/api/orchestrator/graphs/${g.id}`, { method: "DELETE", headers: { Authorization: "Bearer " + tok } });
      }
    }
    return null;
  }).catch((e) => String(e));

  // ── 11. 无脚本错误 ──
  // 说明: 以下三类是环境噪音, 不算缺陷 ——
  //   ① favicon.ico 404(浏览器自己发的, 站点未提供该图标; 消息文本里没有 "favicon" 字样,
  //      所以要连 location().url 一起看, 只按文本过滤会漏)
  //   ② ResizeObserver 循环警告(vue-flow 尺寸变化时的常见噪音)
  //   ③ 总闸关闭时探测 /api/orchestrator/settings 的 400(本轮显式做的负向验证, 预期就是 400)
  const realErrors = errors.filter((e) => {
    const s = typeof e === "string" ? e : String(e);
    if (/favicon|ResizeObserver/.test(s)) return false;
    if (/400 \(Bad Request\)/.test(s) && /orchestrator\/settings/.test(s)) return false;
    return true;
  });
  t("页面无 JS 错误", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

} catch (e) {
  console.error("UI 实测异常:", e.message);
  fail++;
} finally {
  await browser.close();
  console.log(`\n${"=".repeat(52)}\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}
