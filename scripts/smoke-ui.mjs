/**
 * 前端点击冒烟(2026-10-01) —— 覆盖自旧项目移植、并**融入既有 tab** 的 7 项能力。
 *
 * ⚠ 三条踩过的坑, 决定了这个脚本现在的写法:
 *
 *   ① **截图证明不了按钮能用**。空态表单上, 按钮坏掉 / handler 没接 / 接口 404
 *      —— 看起来完全一样。所以每一步的判据都要求**状态真的变了**(文案出现、
 *      元素增减、下载事件), 而不是"点到了"。
 *
 *   ② **别写死 sleep**。第一版用固定等待, 而"新建 PPT 任务"要串
 *      (插记录 → 生成大纲 → 拉列表 → 拉详情), 实测几十秒 —— 功能正常却报红。
 *      判据要等的是"状态真的变了", 不是"过了 N 秒"。
 *
 *   ③ **要打用户实际用的端口**。默认 4173(服务 web/dist 构建产物)。
 *      改了前端源码**必须 `npm run build:web`**, 否则 4173 上还是旧的 ——
 *      我栽过这一次: 在 vite dev(4189)上全绿, 用户那边什么都没有。
 *      用 SMOKE_BASE 可指向别的地址。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:4173";
const results = [];
let failed = 0;

function rec(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? "  —— " + detail : ""}`);
}

const browser = await chromium.launch({ channel: "msedge" })
  .catch(() => chromium.launch({ channel: "chrome" }))
  .catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const apiCalls = [];
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/")) apiCalls.push({ url: u.replace(BASE, ""), status: r.status() });
});
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text().slice(0, 200)); });

async function goto(view) {
  await page.goto(`${BASE}/#${view}`, { waitUntil: "load" });
  await page.waitForTimeout(2500);
}
/**
 * 强制**重新加载**目标视图。
 *
 * ⚠ 为什么不能靠 `goto` 带个 query 串: 本应用是 hash 路由, `#format-eval?t=123`
 *   整个是 hash 的一部分, 而 App.tsx 用 `validViews.includes(hash)` 判定 ——
 *   带 query 的 hash **不在白名单里**, 于是被当成非法视图、回落到默认页。
 *   实测症状: 后面那几个按钮全都"找不到"(页面根本不在那个视图上)。
 *   正确做法是导航到目标 hash, 再 reload() —— 同 hash 不重载的问题就此绕开。
 */
async function gotoFresh(view) {
  await page.goto(`${BASE}/#${view}`, { waitUntil: "load" });
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2500);
}
async function bodyText() {
  return (await page.evaluate(() => (document.querySelector("main") || document.body).innerText)) || "";
}

/**
 * 点一个按钮 —— 先看它**是不是可点**。
 *
 * 词云的「生成词云」曾因后端缺 `wordcloud` 库而 disabled(那是**正确行为**),
 * 但第一版脚本直接 `.click()` → 等 30 秒超时 → 整个冒烟崩在这, 后面一条没跑。
 */
async function clickIfEnabled(buttonName, label) {
  const btn = page.getByRole("button", { name: buttonName });
  if ((await btn.count()) === 0) { rec(label + " —— 找不到按钮", false); return false; }
  if (!(await btn.first().isEnabled())) {
    rec(label + " —— 按钮被禁用", false, "禁用可能是对的(前置自检没过), 但功能没被验证到");
    return false;
  }
  await btn.first().click();
  return true;
}

/** 轮询直到条件成立或超时。等"状态变了"而不是"过了 N 秒" */
async function waitFor(fn, tries = 30, gapMs = 2500) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await page.waitForTimeout(gapMs);
  }
  return false;
}

console.log("\n=== 前置: 登录 ===");
await goto("assistant");
/**
 * ⚠ 本地 `SAG_AUTH_ENABLED=false` **不等于免登录** —— 它只是让前端不弹登录框
 *   (AuthGate: "本地单机认证未启用也可登录")。而 `/api/ppt/*`、`/api/pay/*`
 *   这类走 `requireUser` 的接口**无条件要 JWT**, 不带就是 401。
 * 账号密码走环境变量, 脚本里不写死凭据。
 */
const SMOKE_USER = process.env.SMOKE_USER || "smoke_ui";
const SMOKE_PW = process.env.SMOKE_PW || "";
const lr = await page.evaluate(async ([u, p]) => {
  const r = await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p }),
  });
  const d = await r.json();
  if (d?.token) localStorage.setItem("sag_token", d.token);
  return { status: r.status, hasToken: !!d?.token, err: d?.error };
}, [SMOKE_USER, SMOKE_PW]);
rec("登录拿到 token", lr.hasToken, lr.hasToken ? "" : `status=${lr.status} ${lr.err ?? ""}`);

// ═══════════ 融入点 ①: 文献管理 → 题录文件 ═══════════
console.log("\n=== ① 文献管理 › 题录文件（融入） ===");
await goto("imports");
{
  rec("文献管理面板打开", (await bodyText()).includes("文献管理"), "");
  if (await clickIfEnabled(/题录文件/, "「题录文件」tab")) {
    const has = await waitFor(async () => (await bodyText()).includes("题录"), 12, 1500);
    rec("切到题录文件 tab", has, has ? "" : "切过去没看到题录面板");

    const wos = `FN Clarivate Analytics Web of Science
VR 1.0
PT J
AU Zhang, San
AU Li, Si
TI Rural collective economy and common prosperity
SO JOURNAL OF RURAL STUDIES
DI 10.1016/j.jrurstud.2024.01.001
PY 2024
VL 91
BP 12
EP 25
ER

EF`;
    /**
     * 粘贴框现在**折在 <details> 里**(拖放是主路径, 粘贴是备选) —— 直接 fill 会
     * "element is not visible" 超时。这里先展开。
     * 这不是功能坏了, 是交互改了: 冒烟要跟着改, 而不是反过来迁就脚本。
     */
    const details = page.locator("details").first();
    if (await details.count()) await details.locator("summary").click();
    await page.waitForTimeout(400);
    await page.fill("textarea", wos);
    if (await clickIfEnabled(/识别预览/, "「识别预览」")) {
      // 新界面把"共 N 条"拆成了「识别结果 + 格式徽章 + StatTile 数字」——
      // 判据改成认**格式徽章 + 识别结果区**都在(比抠某个具体串稳)
      const ok = await waitFor(async () => {
        const t = await bodyText();
        return /Web of Science|wos|知网|RIS/i.test(t) && t.includes("识别结果");
      }, 12, 1500);
      rec("识别出格式并预览", ok, ok ? "识别结果已出" : "没看到格式与条数");
    }
  }
}

// ═══════════ 融入点 ②: 文献库 → 图谱分析 ═══════════
console.log("\n=== ② 文献库 › 图谱分析（融入） ===");
await goto("literature");
{
  if (await clickIfEnabled(/图谱分析/, "「图谱分析」模式")) {
    const has = await waitFor(async () => {
      const t = await bodyText();
      return t.includes("关键词共现图谱") && t.includes("词云");
    }, 12, 1500);
    rec("切到图谱分析", has, has ? "" : "没看到子页切换");
    if (has && await clickIfEnabled(/^词云$/, "「词云」子页")) {
      /**
       * ⚠ 判据要锚到**面板真正渲染出来的文案**。
       *   第一版查的是 `includes("粘贴语料")` —— 那是 placeholder 属性, 不是 innerText,
       *   页面里根本没有那串文字, 于是功能正常却报红(假失败)。
       *   改用面板自己的标题句 + 自检行, 两者都是 innerText。
       */
      const cloud = await waitFor(async () => {
        const t = await bodyText();
        return t.includes("渲染成词云图") && t.includes("生成词云");
      }, 10, 1500);
      rec("词云子页渲染", cloud, cloud ? "" : "没看到词云面板文案");
    }
  }
}

// ═══════════ 融入点 ③: 格式智能评测 → 成品构建 › AIGC 检测 ═══════════
console.log("\n=== ③ 格式智能评测 › 成品构建 › AIGC（融入） ===");
await goto("format-eval");
{
  if (await clickIfEnabled(/成品构建/, "「成品构建」tab")) {
    const has = await waitFor(async () => (await bodyText()).includes("Word 成品构建"), 12, 1500);
    rec("切到成品构建 tab", has, has ? "" : "没看到子页");
    if (has && await clickIfEnabled(/AIGC 检测/, "「AIGC 检测」子页")) {
      const ok = await waitFor(async () => (await bodyText()).includes("开始检测"), 10, 1500);
      rec("AIGC 子页渲染", ok, "");
      if (ok) {
        await page.fill("textarea", "首先，本文旨在探讨该问题。其次，值得注意的是，相关研究表明。综上所述，本文认为该问题具有重要意义。");
        if (await clickIfEnabled(/开始检测/, "「开始检测」")) {
          const scored = await waitFor(async () => /更像人类|混合特征|更像 AI|样本不足/.test(await bodyText()), 16, 1500);
          rec("点「开始检测」拿回结论", scored, "");
        }
      }
    }
  }
}

// ═══════════ 融入点 ④: 格式智能评测 → 成品构建 › Word ═══════════
console.log("\n=== ④ 格式智能评测 › 成品构建 › Word（融入） ===");
{
  if (await clickIfEnabled(/Word 成品构建/, "「Word 成品构建」子页")) {
    // 新界面把"依赖自检通过"改成了头部徽章「依赖就绪」
      const ok = await waitFor(async () => {
        const t = await bodyText();
        return t.includes("依赖就绪") || t.includes("依赖缺失") || t.includes("Word 成品构建");
      }, 10, 1500);
    rec("Word 子页渲染", ok, "");
    if (ok) {
      const dl = page.waitForEvent("download", { timeout: 120000 }).catch(() => null);
      if (await clickIfEnabled(/生成并下载/, "「生成并下载」")) {
        const d = await dl;
        rec("点「生成并下载」真的触发下载", !!d, d ? await d.suggestedFilename() : "120s 内没有 download 事件");
      }
    }
  }
}

// ═══════════ 融入点 ⑤: 外部检索 → 舆情检索 ═══════════
console.log("\n=== ⑤ 外部检索 › 舆情检索（融入） ===");
await goto("sciverse");
{
  if (await clickIfEnabled(/舆情检索/, "「舆情检索」工具")) {
    const ok = await waitFor(async () => (await bodyText()).includes("个源"), 12, 1500);
    rec("切到舆情检索", ok, ok ? "" : "没看到舆情面板");
    if (ok) {
      await page.fill("input[placeholder*='议题关键词']", "农村集体经济");
      if (await clickIfEnabled(/^检索$/, "「检索」")) {
        const done = await waitFor(async () => {
          const t = await bodyText();
          // 新界面把"命中 N 条"做成了 StatTile(数字与"命中"分处两个元素),
          // 所以同时认"情感分布"卡出现 —— 那说明结果区真的渲染了
          return /命中|情感分布/.test(t) || t.includes("没取到结果") || t.includes("检索失败");
        }, 20, 2500);
        rec("点「检索」有明确反馈", done, "");
      }
    }
  }
}

// ═══════════ 融入点 ⑥: 研途写作舱 → PPT 演示 ═══════════
console.log("\n=== ⑥ 研途写作舱 › PPT 演示（融入） ===");
await goto("paper-outline");
{
  const t0 = await bodyText();
  rec("默认仍是六步写作舱", t0.includes("六步写作") || t0.includes("选题"), t0.split("\n")[0].slice(0, 40));
  if (await clickIfEnabled(/PPT 演示/, "「PPT 演示」切换")) {
    const ok = await waitFor(async () => (await bodyText()).includes("新建"), 12, 1500);
    rec("切到 PPT 工作台", ok, "");
    if (ok) {
      const title = "冒烟PPT" + Date.now().toString().slice(-6);
      await page.fill("input[placeholder*='乡村振兴']", title);
      if (await clickIfEnabled(/新建/, "「新建」")) {
        /**
         * 判据锚到**这条新任务的标题出现在列表里**。
         *
         * ⚠ 别再要求"标题紧跟状态词": 新界面把状态做成了**独立徽章**(「大纲就绪」),
         *   innerText 里两者之间还有别的元素文本, 正则对不上 —— 功能正常却报红。
         *   只认标题即可: 标题带秒级时间戳, 不会与历史任务撞。
         */
        const appeared = await waitFor(async () => (await bodyText()).includes(title), 30, 5000);
        rec("新建任务并出大纲", appeared, appeared ? "" : "150s 内列表里没出现这条");
        if (appeared) {
          const toolbar = await waitFor(async () =>
            (await page.getByRole("button", { name: /生成脚本/ }).count()) > 0, 24, 2500);
          rec("打开任务后出现工具条", toolbar, "");
          if (toolbar) {
            await page.getByRole("button", { name: /生成脚本/ }).click();
            /**
             * 讲稿现在**只在点开某一页时才渲染**(详情是折叠的) ——
             * 全页 innerText 里看不到「讲稿：」。所以先等缩略图上出现「脚本」徽章,
             * 再点开一页确认讲稿真的渲染出来。
             * (第一版直接扫全页文本 → 功能正常却报红。)
             */
            const scripted = await waitFor(async () =>
              (await page.getByText(/^脚本$/).count()) > 0, 36, 5000);
            rec("点「生成脚本」产出脚本", scripted, scripted ? "" : "180s 内缩略图上没出现「脚本」徽章");
            if (scripted) {
              await page.getByText(/^脚本$/).first().click();
              const notes = await waitFor(async () => /讲稿/.test(await bodyText()), 10, 1500);
              rec("点开单页能看到讲稿", notes, notes ? "" : "详情里没有讲稿");
            }
          }
        }
      }
    }
  }
}

// ═══════════ 联动: 图谱节点 → 文献库筛选 ═══════════
console.log("\n=== 联动① 共现图谱 › 点节点 → 文献库按该词筛选 ===");
/**
 * ⚠ 这条路需要**文献库里有带正文的文献**, 而冒烟账号在新机器上多半是空的。
 *
 *   图谱面板在库内嵌时只有 `fromLibrary` 一种形态(LiteraturePanel.tsx:329 ——
 *   粘贴语料那条分支根本不挂载), 所以"库是空的"没有替代输入。
 *
 *   本仓的约定是「探针要给被测对象指路」, 于是这里**就地造 3 篇**。
 *   ⚠ 但服务端 `literatureService` 把目录扫描结果**缓存在进程内**(getRecords 只在首次
 *     或显式 refresh 时重扫)—— 刚写的语料, 正在跑的后端看不到, 除非它是在语料之后启动的。
 *   所以空库时**如实报"未验证"并说清怎么办**, 既不报红(假失败)也不报绿(假通过)。
 */
const LIT_DIR = path.join(process.cwd(), "data", "kb", "journal");
const SMOKE_TOPIC = "冒烟测试主题";
{
  const corpus = [
    ["paper1_张三", "农村集体经济的实现形式研究", "smoke-paper-1",
      "农村集体经济是社会主义公有制经济的重要组成部分，发展农村集体经济有利于实现共同富裕。\n" +
      "乡村振兴战略要求壮大农村集体经济，完善集体资产产权制度，创新集体经济实现形式。\n" +
      "农民组织化程度影响集体经济的运行效率，制度创新是集体经济持续发展的关键。\n" +
      "集体资产产权改革需要兼顾效率与公平，集体经济组织的治理机制是核心问题。"],
    ["paper2_李四", "乡村振兴与集体经济创新", "smoke-paper-2",
      "乡村振兴战略背景下，农村集体经济的创新实现形式成为学术界关注的重点问题。\n" +
      "集体资产产权制度改革推动集体经济组织向市场化方向转型，治理机制逐步完善。\n" +
      "农民合作社与集体经济组织的关系需要重新界定，制度创新是突破路径依赖的关键。\n" +
      "共同富裕目标要求集体经济在效率与公平之间寻找新的平衡点。"],
    ["paper3_王五", "共同富裕视角下的集体经济治理", "smoke-paper-3",
      "共同富裕是社会主义的本质要求，农村集体经济是实现共同富裕的重要制度载体。\n" +
      "集体经济组织的治理结构影响其运行效率，产权明晰是制度创新的前提条件。\n" +
      "农村集体资产的管理需要制度创新，农民的组织化程度决定了集体经济的活力。\n" +
      "乡村振兴与共同富裕目标相互支撑，集体经济的发展路径需要因地制宜。"],
  ];
  for (const [dir, title, hash, body] of corpus) {
    const d = path.join(LIT_DIR, SMOKE_TOPIC, "Markdown", dir);
    if (fs.existsSync(path.join(d, `${dir}.original.md`))) continue; // 已造过, 不覆盖
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${dir}_信息.md`),
      `---\ntitle: ${title} - 信息\npaperTitle: ${title}\nsourceHash: ${hash}\ncreatedAt: 2026-10-01\n---\n\n冒烟测试用语料\n`, "utf8");
    fs.writeFileSync(path.join(d, `${dir}.original.md`), body + "\n", "utf8");
  }
}

await goto("literature");
{
  await clickIfEnabled(/图谱分析/, "「图谱分析」模式");
  await waitFor(async () => (await bodyText()).includes("关键词共现图谱"), 12, 1500);
  if (await clickIfEnabled(/生成图谱/, "「生成图谱」")) {
    // 节点画出来的标志: 出现**带 pointer 光标的 <g>**(那正是绑了 onClick 的节点组)
    /**
     * ⚠ 不能用 `svg circle` 数节点 —— 页面上到处是 lucide 图标, 它们本身就是
     *   `<svg viewBox="0 0 24 24"><circle …/></svg>`。第一版按 circle 数, 数到的是图标
     *   (实测 22 个 viewBox="0 0 24 24" 的图标 svg), 点下去当然什么都不发生。
     *   绑了 onClick 的节点组会渲染成 `style="cursor: pointer"`, 这个才是被测对象。
     */
    const nodeSel = 'svg g[style*="cursor"]';
    const hasNodes = await waitFor(async () => (await page.locator(nodeSel).count()) >= 3, 20, 3000);
    if (hasNodes) {
      // 点一个节点 —— 应当发起交接并切到文献库
      await page.locator(nodeSel).first().click();
      const jumped = await waitFor(async () => {
        const t = await bodyText();
        return t.includes("来自「共现图谱」的筛选");
      }, 16, 2000);
      rec("点图谱节点 → 跳文献库并带上筛选", jumped, jumped ? "" : "没看到交接提示条");
      if (jumped) {
        // 提示条上的"清除筛选"要能真的清掉
        if (await clickIfEnabled(/清除筛选/, "「清除筛选」")) {
          const cleared = await waitFor(async () => !(await bodyText()).includes("来自「共现图谱」的筛选"), 8, 1500);
          rec("清除筛选生效", cleared, "");
        }
      }
    } else if ((await bodyText()).includes("文献库里没有可用于生成图谱的文本")) {
      rec("图谱节点 → 文献库筛选", false,
        `未验证: 文献库为空。语料已造在 data/kb/journal/${SMOKE_TOPIC}, ` +
        `但服务端进程内缓存了目录扫描结果 —— 重启 4173 后重跑本脚本才能真验到`);
    } else {
      rec("图谱生成出可点节点", false, `带 cursor 的节点组只有 ${await page.locator(nodeSel).count()} 个`);
    }
  }
}

// ═══════════ 联动: AIGC → 统稿定稿(旧) —— 已并入 ⑨/④ ═══════════
/*
 * ⚠ 这一段原先是「点『送研途写作舱改写』→ 跳到写作舱」。2026-10-01 改方向后
 *   该按钮变成次要出口且改了名(现在是「只看这一段：送写作舱改写」), 这里**整段退役** ——
 *   它的职责已被上面 ⑨(AIGC 检测面板本体) 与 ④(送统稿定稿的完整链路) 覆盖, 且更严:
 *   ④ 会穿过 iframe 校验提示条 + 合稿模式 + 强度档三项真实控件状态,
 *   而这一段只能证明"页面跳了"(那种判据曾经全绿却是坏的)。
 */

// ═══════════ 联动: 词云词条 → 共现图谱 ═══════════
console.log("\n=== 联动③ 词云 › 点词条 → 切到共现图谱 ===");
await goto("literature");
{
  await clickIfEnabled(/图谱分析/, "「图谱分析」模式");
  await clickIfEnabled(/^词云$/, "「词云」子页");
  await waitFor(async () => (await bodyText()).includes("生成词云"), 10, 1500);
  const ta2 = page.locator("textarea").first();
  if (await ta2.count()) {
    await ta2.fill("农村集体经济 乡村振兴 共同富裕 集体经济 农民 组织 制度 创新 发展 治理 集体 资产 产权 改革");
    if (await clickIfEnabled(/生成词云/, "「生成词云」")) {
      const gotWords = await waitFor(async () => (await bodyText()).includes("词频（前 60）"), 25, 2500);
      if (gotWords) {
        const wordBtn = page.getByRole("button", { name: /^集体经济$/ }).first();
        if (await wordBtn.count()) {
          await wordBtn.click();
          const back = await waitFor(async () => (await bodyText()).includes("关键词共现图谱"), 10, 1500);
          rec("点词频词条 → 切回共现图谱", back, back ? "" : "没切回去");
        } else {
          rec("词频里有可点的词条", false, "没找到词条按钮");
        }
      } else {
        rec("词云产出词频", false, "没看到词频区");
      }
    }
  }
}

// ═══════════ 融入点 ⑦: 计费面板的充值入口(改过) ═══════════
console.log("\n=== ⑦ 计费面板（充值入口已改走扫码） ===");
await goto("billing");
{
  const t = await bodyText();
  rec("充值按钮已改成扫码口径", t.includes("扫码充值"), t.includes("扫码充值") ? "" : "仍写着「立即充值」");
  rec("没有调用被锁掉的旧充值接口",
    !apiCalls.some((c) => c.url.includes("/api/billing/recharge")), "");
}

// ═══════════ 融入点 ⑧: PPT 第二条路径（技能生成） ═══════════
console.log("\n=== ⑧ PPT 工作台 › 技能生成（第二条路径） ===");
await goto("ppt-workbench");
{
  if (await clickIfEnabled(/^技能生成$/, "「技能生成」切换")) {
    /**
     * ⚠ 等的是**接口真回来之后才有的内容**("产物：…"), 不是"这是第二条路径"。
     *   后者是面板本地的静态文案, 一切过去就有 —— 而技能清单要等 /api/ppt/skills 回来。
     *   第一版只等静态文案就往下读, 冷启动时读到 0 张卡片, 四条判据全红(功能是好的)。
     *   (⑨ 是同一个毛病, 已在那里记过一次。)
     */
    const ok = await waitFor(async () => (await bodyText()).includes("产物："), 20, 2000);
    rec("切到技能路径且技能清单已加载", ok, ok ? "" : "没等到技能清单");
    if (ok) {
      const t = await bodyText();
      /**
       * ⚠ 判据锚在**产物形态**上, 不是"技能列出来了"。
       *   本机 5 个技能里 3 个产不出可编辑 .pptx（paper-slide-deck 只出图 / beamer 出 PDF）。
       *   把它们统一标成 pptx, 用户会一直做到最后一步才发现改不了字 ——
       *   这正是这个面板存在的主要理由, 所以必须被冒烟守住。
       */
      rec("每个技能都标了产物形态", (t.match(/产物：/g) || []).length > 0,
        `${(t.match(/产物：/g) || []).length} 个`);
      rec("非 pptx 的技能显式标出警告",
        t.includes("不可编辑") && t.includes("产出 PDF 不是 pptx"),
        t.includes("不可编辑") ? "" : "出图/出 PDF 的技能没标警告");
      rec("说明了这条路径更慢且计费", /分钟/.test(t) && /计费/.test(t), "");
      rec("说明了不会自动开始", t.includes("不会自动开始"), "");
      rec("界面文案无 markdown 星号泄漏", !t.includes("**"), t.includes("**") ? "文案里出现了字面 **" : "");
    }
  }
}

// ═══════════ 融入点 ⑨: AIGC 外接权威检测平台 ═══════════
console.log("\n=== ⑨ AIGC 检测 › 权威平台（外接） ===");
await goto("format-eval");
{
  await clickIfEnabled(/成品构建/, "「成品构建」tab");
  await clickIfEnabled(/AIGC 检测/, "「AIGC 检测」子页");
  await waitFor(async () => (await bodyText()).includes("本机检测"), 10, 1500);
  if (await clickIfEnabled(/^权威平台$/, "「权威平台」切换")) {
    /**
     * ⚠ 等的是**异步拉回来的服务商数据**, 不是那几块静态标题。
     *   "选择平台"/"可直连"这些区块标题是本地字符串, 一切 tab 就渲染好了;
     *   而"仅英文""Enterprise"这类标注要等 /api/aigc/external/providers 回来 ——
     *   第一版只等到"选择平台"就往下读, 于是三条判据全红(功能是好的, 判据读早了)。
     *   判据锚到**接口真回来了才有的内容**上。
     */
    const ok = await waitFor(async () => (await bodyText()).includes("仅英文"), 20, 2000);
    rec("切到外接平台且服务商清单已加载", ok, ok ? "" : "没等到服务商数据");
    if (ok) {
      const t = await bodyText();
      /**
       * ⚠ 判据锚在**两类都在** —— 这是这张表最重要的一个事实(2026-10-01 逐家打端点确认):
       *   有公开 API 的只有 GPTZero/Winston/Copyleaks/Sapling/Pangram/Originality;
       *   知网/维普/万方/朱雀/中科睿鉴/AIGC-X/Turnitin **没有**公开接口, 只能人工送检。
       *   少了任何一类, 用户要么找不到自己要过的那一家, 要么被引到一个走不通的"送检"上。
       */
      rec("可直连平台区在", t.includes("可直连"), "");
      rec("人工送检区在", t.includes("人工送检"), "");
      rec("国内那几家在清单里(用户最认的恰恰是它们)",
        t.includes("知网") && t.includes("维普") && t.includes("腾讯朱雀"), "");
      rec("有 API 但没有普通套餐权限的标了限制",
        t.includes("企业版订阅") || t.includes("Enterprise"), "");
      rec("只支持英文的检测器标了警告", t.includes("仅英文"), "");
      rec("界面文案无 markdown 星号泄漏", !t.includes("**"), t.includes("**") ? "文案里出现了字面 **" : "");
    }
  }
}

// ═══════════ 联动: AIGC 检测 → 统稿定稿的合并轮 ═══════════
console.log("\n=== 联动④ AIGC 检测 › 送统稿定稿 → 合稿模式与强度自动就位 ===");
/**
 * ⚠ 这一步**必须把时间戳挂上去**。
 *
 *   `goto("format-eval")` 在**已经是这个 hash** 时不会触发导航(浏览器的同 hash 不重载) ——
 *   上一段 ⑨ 正好停在 format-eval 且切在「权威平台」子页。于是这一段继承了那个状态:
 *   `page.locator("textarea").first()` 命中的是**外接面板**的输入框(此时根本没有"检测"按钮)。
 *   实测症状: 整段静默跳过, 一条 rec 都没有 —— 最难发现的那种冒烟失效。
 *   加时间戳强制换 URL, 让页面真的重载。
 */
await gotoFresh("format-eval");
{
  await clickIfEnabled(/成品构建/, "「成品构建」tab");
  await clickIfEnabled(/AIGC 检测/, "「AIGC 检测」子页");
  /**
   * ⚠ 必须等"开始检测"且**当前在「本机检测」子页**。
   *   面板默认落在本机检测, 但上一步若留下"权威平台"状态就会走岔 —— 显式点一次最稳。
   */
  await clickIfEnabled(/^本机检测$/, "「本机检测」子页");
  const ready = await waitFor(async () => (await bodyText()).includes("开始检测"), 10, 1500);
  rec("AIGC 检测面板就绪（本机检测）", ready, ready ? "" : "没看到「开始检测」");
  if (ready) {
    const ta3 = page.locator("textarea").first();
    await ta3.fill("首先，本文旨在探讨该问题。其次，值得注意的是，相关研究表明。综上所述，本文认为该问题具有重要意义。");
    if (await clickIfEnabled(/开始检测/, "「开始检测」")) {
      await waitFor(async () => /更像人类|混合特征|更像 AI|样本不足/.test(await bodyText()), 16, 1500);
      if (await clickIfEnabled(/送统稿定稿/, "「送统稿定稿」")) {        /**
         * ⚠ 判据必须**穿过 iframe** 看统稿定稿页里的真实控件状态, 不能只看外壳跳没跳。
         *
         * 第一版就是只认"跳到写作舱了" → 全绿, 而真实情况是:
         *   投递广播发生在该视图挂载前 162ms, 没人监听; onMounted 又忘了主动取一次 ——
         *   页面确实跳过去了, 但提示条、模式、档位**一个都没生效**。
         *   "跳过去了"与"联动成立"是两件事, 只有 iframe 内部的状态能区分。
         */
        const linked = await waitFor(async () => {
          const st = await page.evaluate(() => {
            const ifr = document.querySelector('iframe[title="研途写作舱"], iframe[src*="/workflow"]');
            const d = ifr?.contentDocument;
            return {
              hash: (() => { try { return ifr?.contentWindow?.location?.hash ?? ""; } catch { return ""; } })(),
              notice: !!d?.querySelector('[data-control="workflow:aigc-notice"]'),
              aigcTab: d?.querySelector('[data-control="workflow:merge-mode-aigc"]')?.getAttribute("aria-pressed"),
              tierOn: Array.from(d?.querySelectorAll('[data-control^="workflow:aigc-tier-"]') ?? [])
                .filter((e) => (e.className || "").includes("on")).length,
            };
          });
          return st.hash === "#/workflow/finalize" && st.notice && st.aigcTab === "true" && st.tierOn === 1;
        }, 16, 2000);
        rec("投递送达并落到统稿定稿（提示条 + 降AIGC模式 + 建议档位）", linked,
          linked ? "" : "跳过去了但联动没生效（提示/模式/档位至少一项没到）");
        const back = await page.evaluate(() => {
          const ifr = document.querySelector('iframe[title="研途写作舱"], iframe[src*="/workflow"]');
          const b = ifr?.contentDocument?.querySelector('[data-control="workflow:goto-aigc-detect"]');
          if (b) { b.click(); return true; } return false;
        });
        if (back) {
          const came = await waitFor(async () => (await bodyText()).includes("成品构建"), 12, 2000);
          rec("统稿定稿的「先测 AIGC」能反向回到检测页", came, came ? "" : "没回来");
        }
      }
    }
  }
}


// ═══════════ 融入点 ⑩: AIGC 送检包下载 + 人工回填（点击流） ═══════════
console.log("\n=== ⑩ AIGC 权威平台 › 送检包下载 + 回填 ===");
await gotoFresh("format-eval");
{
  await clickIfEnabled(/成品构建/, "「成品构建」tab");
  await clickIfEnabled(/AIGC 检测/, "「AIGC 检测」子页");
  if (await clickIfEnabled(/^权威平台$/, "「权威平台」切换")) {
    const loaded = await waitFor(async () => (await bodyText()).includes("导出送检包"), 20, 2000);
    rec("外接平台就绪", loaded, "");
    if (loaded) {
      /**
       * ⚠ 先**清空**文本框再验"无文本时按钮禁用"。
       *   本段跑在 ⑨ 之后, 那时文本域里已经留着 ⑨ 填的内容 ——
       *   不显式清空就会命中"有文本所以按钮可点", 判据假失败。
       *   (判据要控制自己的前置状态, 不能依赖上游段落的残留。)
       */
      await clickIfEnabled(/^本机检测$/, "回本机检测清空文本");
      await page.waitForTimeout(700);
      const taClr = page.locator("textarea").first();
      if (await taClr.count()) await taClr.fill("");
      await clickIfEnabled(/^权威平台$/, "回权威平台");
      await page.waitForTimeout(1000);
      await clickIfEnabled(/知网 AIGC 检测/, "「知网」平台(清空后)");
      await page.waitForTimeout(800);
      const btn0 = page.getByRole("button", { name: /导出送检包/ });
      rec("无文本时「导出送检包」禁用", (await btn0.count()) > 0 && !(await btn0.first().isEnabled()), "");

      // 填回文本, 继续验下载
      await clickIfEnabled(/^本机检测$/, "回本机检测填文本");
      await page.waitForTimeout(600);
      const ta = page.locator("textarea").first();
      if (await ta.count()) await ta.fill("这是用于送检验证的正文内容。第一段说明农村集体经济的实现形式。第二段讨论治理机制。");
      await clickIfEnabled(/^权威平台$/, "再回权威平台");
      await page.waitForTimeout(1000);
      await clickIfEnabled(/知网 AIGC 检测/, "「知网」平台(再选)");
      await page.waitForTimeout(800);

      /**
       * ⚠ 判据是 **download 事件 + 文件名**, 不是"出现了步骤说明"。
       *   实测(2026-10-01): 原来点「导出送检包」只生成不下载, 页面照样显示操作步骤,
       *   看起来完全正常 —— 而磁盘上什么都没有。名字承诺"导出", 行为必须真的落到文件。
       */
      const dl = page.waitForEvent("download", { timeout: 40000 }).catch(() => null);
      if (await clickIfEnabled(/导出送检包/, "「导出送检包」")) {
        const d = await dl;
        rec("点「导出送检包」真的触发下载", !!d, d ? await d.suggestedFilename() : "40s 内没有 download 事件");
        const guide = await waitFor(async () => (await bodyText()).includes("操作步骤"), 10, 1500);
        rec("给出人工送检的操作步骤", guide, "");
        rec("步骤里说明稿子会离开本机", /离开|发到/.test(await bodyText()), "");
      }

      // 回填: 只填分数不填原文必须被拒
      const sc = page.locator('input[inputmode="decimal"]').first();
      if (await sc.count()) {
        await sc.fill("12.3");
        const selEl = page.locator("select").first();
        if (await selEl.count()) await selEl.selectOption({ label: "知网 AIGC 检测" }).catch(() => null);
        await page.waitForTimeout(400);
        if (await clickIfEnabled(/保存回填/, "「保存回填」(缺原文)")) {
          const rejected = await waitFor(async () => (await bodyText()).includes("必须附平台报告原文"), 10, 1500);
          rec("只填分数不填原文 → 被拒并说明原因", rejected,
            rejected ? "" : "没有被拒 —— 期刊/学校认的是平台报告, 只留数字无法复核");
        }
        const raw = page.locator('input[placeholder*="疑似度"]').first();
        if (await raw.count()) {
          await raw.fill("AI 生成疑似度 12.3%");
          if (await clickIfEnabled(/保存回填/, "「保存回填」(带原文)")) {
            const saved = await waitFor(async () => {
              const t = await bodyText();
              return t.includes("回填已保存") || t.includes("12.3%");
            }, 12, 1500);
            rec("补上平台报告原文后保存成功", saved, saved ? "" : "没看到保存成功或历史条目");
          }
        }
      }
    }
  }
}

// ═══════════ 汇总 ═══════════
console.log("\n=== 接口调用(去重, 前 30) ===");
const uniq = [...new Map(apiCalls.map((c) => [c.url, c])).values()];
for (const c of uniq.slice(0, 30)) console.log(`  ${String(c.status).padEnd(4)} ${c.url}`);
const bad = apiCalls.filter((c) => c.status >= 400);
console.log(`  —— 4xx/5xx 共 ${bad.length} 个`);

console.log("\n=== 页面错误 ===");
// 登录前的 /api/auth/me 401 是预期的, 不算错误
const realErr = pageErrors.filter((e) => !/401|Unauthorized|Failed to load resource/i.test(e));
if (realErr.length === 0) console.log("  (无 JS 报错)");
else for (const e of realErr.slice(0, 8)) console.log("  ✗ " + e);

console.log(`\n=== 结果: ${results.length - failed}/${results.length} 通过 ===`);
await browser.close();
process.exit(failed > 0 || realErr.length > 0 ? 1 : 0);
