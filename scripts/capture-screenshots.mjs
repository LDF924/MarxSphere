#!/usr/bin/env node
// capture-screenshots.mjs — 用 Playwright 抓 SocioSeek 主要界面, 供 README / 文档引用。
//
// 用法: node scripts/capture-screenshots.mjs [输出目录] [--base http://127.0.0.1:4173]
//
// ═══ 为什么重写(2026-09-30) ═══
// 上一版是 `capture-screenshots.cjs`(Electron + offscreen), 实测有两个硬伤:
//   ① **每张图都是同一个界面**。旧脚本先 loadURL 再设 hash, 而 `did-finish-load` 之后再改 hash
//      不触发它等待的那次加载 —— 于是 37 张图里有 11 张是**逐字节相同**的 AI 对话空态
//      (md5 都一样), 而文档里它们各自标着「政经C刊科研」「写作语料库」「文档中心」……
//      另外 7 张干脆没截到目标视图。**没有任何东西发现**, 因为文件名看着都对。
//   ② offscreen 模式抛 `UnknownVizError`, 图是空的。
//
// 这一版的三条纪律:
//   · **改 hash 之后要确认视图真换了**(读主内容区的标题), 没换就报错, 不静默出一张错图;
//   · **每张图必须互不相同**(逐张 pHash 比对), 撞了就说明导航没生效 —— 这是唯一能抓住
//     "37 张图其实是一张"的判据, 光有文件名和大小看不出来;
//   · 副标题/角标会随数据变, 但**导航栏与主标题是稳定的**, 用后者判目标视图。
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const OUT = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(ROOT, "docs/assets"));
const BASE = (() => {
  const i = args.indexOf("--base");
  return i >= 0 && args[i + 1] ? args[i + 1] : "http://127.0.0.1:4173";
})();

/**
 * 要抓的视图。`expect` 是**主内容区标题**里必须出现的字串 —— 用它确认 hash 导航真的生效了。
 *
 * ⚠ 加新视图时**必须同时填 expect**: 空着就等于放弃自检, 又会回到"37 张图是一张"的老路。
 */
const VIEWS = [
  { file: "sag-assistant.png",        hash: "#assistant",           expect: "AI 助手|新对话" },
  { file: "sag-reason.png",           hash: "#reason",              expect: "推理工作台" },
  { file: "sag-ask.png",              hash: "#ask",                 expect: "Ask" },
  {
    file: "sag-literature.png",       hash: "#literature",          expect: "文献",
    // ⚠ 文献库首次进会加载全库, 给足时间, 否则抓到的是"加载中"空态
    wait: 9000,
  },
  { file: "sag-imports.png",          hash: "#imports",             expect: "文献管理" },
  { file: "sag-sciverse.png",         hash: "#sciverse",            expect: "Sciverse" },
  { file: "sag-scenarios.png",        hash: "#scenarios",           expect: "科研场景" },
  { file: "sag-education.png",        hash: "#education",           expect: "教育" },
  { file: "sag-empirical-research.png", hash: "#empirical-research", expect: "实证" },
  { file: "sag-statistics.png",       hash: "#statistics",          expect: "" },   // Vue 子应用, 标题在 iframe 内
  { file: "sag-structure.png",        hash: "#structure",           expect: "结构解析" },
  { file: "sag-citation-verify.png",  hash: "#citation-verify",     expect: "引文" },
  { file: "sag-format-eval.png",      hash: "#format-eval",         expect: "格式" },
  { file: "sag-p2o.png",              hash: "#p2o",                 expect: "PDF2Obsidian|Obsidian" },
  { file: "sag-cjournal.png",         hash: "#cjournal",            expect: "" },   // Vue 子应用
  { file: "sag-corpus.png",           hash: "#corpus",              expect: "语料库" },
  { file: "sag-paper-outline.png",    hash: "#paper-outline",       expect: "" },   // Vue 子应用
  { file: "sag-dag-workbench.png",    hash: "#dag-workbench",       expect: "" },   // Vue 子应用
  { file: "sag-review-lab.png",       hash: "#review-lab",          expect: "" },   // Vue 子应用
  { file: "sag-plot-agent.png",       hash: "#plot-agent",          expect: "" },   // Vue 子应用
  { file: "sag-editor.png",           hash: "#editor",              expect: "" },   // Vue 子应用
  { file: "sag-truth.png",            hash: "#truth",               expect: "知识" },
  { file: "sag-memory.png",           hash: "#memory",              expect: "记忆" },
  { file: "sag-graph.png",            hash: "#graph",               expect: "图谱|知识图谱" },
  { file: "sag-sources.png",          hash: "#sources",             expect: "数据源" },
  { file: "sag-policy.png",           hash: "#policy",              expect: "政策" },
  { file: "sag-skills.png",           hash: "#skills",              expect: "技能" },
  { file: "sag-agent-console.png",    hash: "#agent-console",       expect: "Agent" },
  { file: "sag-jobs.png",             hash: "#jobs",                expect: "Jobs" },
  { file: "sag-eval.png",             hash: "#eval",                expect: "评测" },
  { file: "sag-alerts.png",           hash: "#alerts",              expect: "告警" },
  { file: "sag-docs.png",             hash: "#docs",                expect: "文档" },
  { file: "sag-admin.png",            hash: "#admin",               expect: "" },
  { file: "sag-billing.png",          hash: "#billing",             expect: "" },
  { file: "sag-im.png",               hash: "#im",                  expect: "" },
  { file: "sag-mcp.png",              hash: "#mcp",                 expect: "MCP" },
  // ── 补齐到**导航里的全部 47 项** ──
  // ⚠ 上一版(2026-08-27 那批)只挑了 37 个, 其中 8 个还因为 hash 没生效而拍成了对话空态;
  //   而 `HomePanel` 那个「home」、系统管理里的 任务/记忆巩固/Trace/Inbox/站点内容/历史记录
  //   从没有人拍过 —— 文档里说的"49 视图"里有一大半从来没有图。
  //   `settings` 与 `capability-tools` 不算导航项(前者由右上角齿轮进入、后者是内部视图), 不拍。
  { file: "sag-chat.png",             hash: "#chat",                expect: "MCP" },
  { file: "sag-documents.png",        hash: "#documents",           expect: "入库" },
  { file: "sag-graphiti-ingest.png",  hash: "#graphiti-ingest",     expect: "Graphiti" },
  { file: "sag-cognee-ingest.png",    hash: "#cognee-ingest",       expect: "Cognee" },
  { file: "sag-tasks.png",            hash: "#tasks",               expect: "任务" },
  { file: "sag-dream.png",            hash: "#dream",               expect: "记忆" },
  { file: "sag-trace.png",            hash: "#trace",               expect: "Trace|链路" },
  { file: "sag-inbox.png",            hash: "#inbox",               expect: "Inbox|收件" },
  { file: "sag-site-content.png",     hash: "#site-content",        expect: "站点" },
  { file: "sag-vault.png",            hash: "#vault",               expect: "资料" },
  { file: "sag-research-history.png", hash: "#research-history",    expect: "历史" },
  { file: "sag-digest.png",           hash: "#digest",              expect: "研究速递" },
  { file: "sag-notifications.png",    hash: "#notifications",       expect: "通知" },
  { file: "sag-forum.png",            hash: "#forum",               expect: "学友论坛" },
];

const W = 1600, H = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起浏览器 —— 按可用性依次退让, **不假设 `npx playwright install` 跑过**。
 *
 * ⚠ 2026-09-30 踩到: 本机 ms-playwright 缓存里是 `chromium-1228`, 而 node 侧 playwright
 *   1.62.1 要的是 `chromium-1234` —— 于是裸 `chromium.launch()` 直接报"Executable doesn't exist"。
 *   仓库的 UI 门禁(verify-ui.mjs)走的是 CDP 连已开浏览器, 所以本地从来没装过配套的 chromium。
 *   这里按 msedge → chrome → 自带 chromium 的顺序试: Windows 自带 Edge, 实测可用。
 */
async function launch() {
  const tries = [{ channel: "msedge" }, { channel: "chrome" }, {}];
  let lastErr;
  for (const opt of tries) {
    try { return await chromium.launch(opt); }
    catch (e) { lastErr = e; console.log(`  · 起浏览器 ${JSON.stringify(opt)} 不行: ${e.message.split("\n")[0].slice(0, 70)}`); }
  }
  throw lastErr;
}

/**
 * 取"这一屏是什么"的三个信号 —— 用它判 hash 导航是否真的生效。
 *
 * ⚠ 不能只认 `h1/h2`。实测(2026-09-30):
 *   · `graph` / `education` / `p2o` 这几个 tab 的主内容区压根没有 h1/h2, 取回来是空串;
 *   · `agent-console` 的 h1 是**子 tab 名**(「防错规则」), 不是视图名;
 *   · 而**导航栏的高亮项**才是"外壳认为你在哪一屏", 任何视图都有。
 * 所以三个信号一起取, 由 `matchView` 决定用哪个判。
 */
const PROBE_FN = () => {
  const t = (s) => (s || "").replace(/\s+/g, " ").trim();
  const act = document.querySelector('[aria-current="page"],[data-active="true"],[aria-selected="true"]');
  const hs = [...document.querySelectorAll("h1,h2")].map((e) => t(e.innerText)).filter(Boolean);
  // ⚠ 取**主内容区**而不是整个 body —— 实测 `p2o` 那屏正文开头是
  //   「PDF2OBSIDIAN 论文处理工作台 …」, 但它在 body 里排得很后(前面是整条导航栏),
  //   按 body 前 160 字裁出来只有导航, 于是被判成"没切过去"而误跳过。
  //   **判据的取样窗口也是判据的一部分。**
  const main = document.querySelector("main") || document.querySelector('[role="main"]') || document.body;
  return {
    active: act ? t(act.innerText).slice(0, 40) : "",
    heads: hs.slice(0, 3),
    iframe: !!document.querySelector("iframe"),
    text: t(main.innerText).slice(0, 400),
  };
};

/** 判这一屏是不是目标视图: 任一信号命中即可 —— 但**必须命中** */
function matchView(p, v) {
  if (!v.expect) return true;                       // 没写期望的只有"互不相同"兜底
  // ⚠ **必须忽略大小写**。`innerText` 返回的是**渲染后**的文本, 会带上 CSS 的
  //   `text-transform` —— 实测 p2o 那屏源码写的是 `PDF2Obsidian`, 渲染出来是
  //   `PDF2OBSIDIAN`(大写字距标题), 于是 `includes("PDF2Obsidian")` 恒为 false,
  //   这一屏被误判成"没切过去"而跳过。**判据撞上了表现层, 不是内容层。**
  const hay = [p.active, ...p.heads, p.text].join("  ").toLowerCase();
  return v.expect.split("|").some((s) => hay.includes(s.toLowerCase()));
}

/**
 * 登录一个验证账号, 把 token 写进 localStorage。
 *
 * ⚠ 2026-09-30 **必须做这一步**, 否则 37 张里 27 张会被**登录弹窗**盖住 ——
 *   实测: 各工作台面板都在 `AuthGate` 后面, 未登录时弹一层居中的卡片并把背景压暗,
 *   截出来的图看不出是哪个界面。而这一点**光看文件名/大小完全看不出来**。
 *   本仓已有这套办法(见 `scripts/lib/cdp-editor.mjs` 的 loginToken), 这里照做:
 *   先 login, 空库时 register 一次, 再把 token 塞进 `localStorage.sag_token`。
 */
async function loginToken(base, username = "verify", password = "verify123456") {
  const post = async (p, body) => {
    try {
      const r = await fetch(`${base}/api/auth/${p}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) return "";
      return (await r.json()).token ?? "";
    } catch { return ""; }
  };
  const hit = await post("login", { username, password });
  if (hit) return hit;
  const reg = await post("register", { username, password, email: `${username}@verify.local` });
  return reg || (await post("login", { username, password }));
}

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  page.on("pageerror", (e) => console.log("  ! 页面报错:", String(e).slice(0, 120)));

  console.log(`[shots] ${BASE} → ${OUT}`);
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 90_000 });

  // 先登录再截图 —— 不登录的话多数工作台会被登录弹窗盖住(见 loginToken 的说明)
  const token = await loginToken(BASE);
  if (!token) {
    console.error("❌ 登录失败 —— 多数视图会被登录弹窗盖住, 拒绝出图");
    await browser.close();
    process.exit(3);
  }
  await page.evaluate((t) => localStorage.setItem("sag_token", t), token);
  await page.reload({ waitUntil: "networkidle", timeout: 90_000 });
  await sleep(3500);   // 首屏要等 bootstrap(项目列表/告警/会话) 落地

  // 复核登录真的生效了 —— token 写进去不等于界面认了
  const loggedIn = await page.evaluate(() => !document.body.innerText.includes("密码（至少6位）"));
  if (!loggedIn) {
    console.error("❌ token 已写入但界面仍显示登录弹窗 —— 别拿被遮住的图充数");
    await browser.close();
    process.exit(3);
  }
  console.log("[shots] ✓ 已登录");

  const taken = [];
  let failed = 0;

  for (const v of VIEWS) {
    // 回到壳顶再切 —— 直接从 Vue 子应用 hash 切到另一个 Vue hash 时,
    // 外壳的 hashchange 监听**不一定**触发(子应用自己也在管 hash)。
    await page.evaluate("window.location.hash = '#assistant'");
    await sleep(400);
    await page.evaluate(`window.location.hash = ${JSON.stringify(v.hash)}`);
    await sleep(v.wait ?? 3500);

    const probe = await page.evaluate(PROBE_FN);
    if (!matchView(probe, v)) {
      // (got 由下一行的日志就地拼出, 不再单独算)
      console.log(`  ✗ ${v.file}: 切过去后是高亮=${JSON.stringify(probe.active)} 标题=${JSON.stringify(probe.heads[0] || "")}, 期望含 ${JSON.stringify(v.expect)} —— 这张图会是错的, 跳过`);
      failed++;
      continue;
    }
    // ⚠ 再查一次**这一屏有没有被弹层盖住**。登录只在开头做一次, 但个别面板
    //   (如某些 Vue 子应用) 可能自己再弹一次授权 —— 一旦被盖, 截出来的就是一张
    //   跟视图无关的卡片, 而**文件名、大小、甚至"互不相同"判据全都看不出来**。
    const covered = await page.evaluate(() => {
      const t = (document.body.innerText || "");
      return t.includes("密码（至少6位）") || t.includes("用户名已存在");
    });
    if (covered) {
      console.log(`  ✗ ${v.file}: 这一屏被授权弹层盖住了 —— 不出一张与视图无关的图`);
      failed++;
      continue;
    }
    const buf = await page.screenshot({ type: "png" });
    writeFileSync(path.join(OUT, v.file), buf);
    taken.push({ file: v.file, buf });
    console.log(`  ✓ ${v.file}  (${Math.round(buf.length / 1024)}KB)`);
  }

  // ── 自检: 两两比对, 撞了就说明导航没生效 ──
  // 上一版 37 张图里有 11 张逐字节相同, 而**文件名看着都对** ——
  // 光看大小/文件名抓不到, 必须真比内容。
  const crypto = await import("node:crypto");
  const byHash = new Map();
  for (const t of taken) {
    const h = crypto.createHash("md5").update(t.buf).digest("hex");
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(t.file);
  }
  const dupGroups = [...byHash.values()].filter((g) => g.length > 1);

  await browser.close();

  console.log(`\n[shots] 抓了 ${taken.length}/${VIEWS.length} 张`);
  if (failed) console.log(`[shots] ${failed} 张因没切到目标视图而跳过 —— 修好后重跑, 别拿错图顶替`);
  if (dupGroups.length) {
    console.log(`\n✗ 有 ${dupGroups.length} 组图完全相同 —— 说明 hash 导航没生效, 这些图是错的:`);
    for (const g of dupGroups) console.log("   " + g.join(" / "));
    process.exit(1);
  }
  console.log("[shots] ✓ 每张互不相同");
  process.exit(failed ? 1 : 0);
};

main().catch((e) => { console.error("✗", e.message); process.exit(2); });
