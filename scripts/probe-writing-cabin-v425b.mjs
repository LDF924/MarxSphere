// probe-writing-cabin-v425b.mjs — V425 第二批加法 + 三件收尾的接线门禁
//
// 由来(2026-09-24): 这一批加的是"后端早就有、写作舱零引用"的能力。这类改动**最危险的失败模式**
//   不是崩, 而是**静默**: 面板渲染了、按钮在, 但点下去打错端点 / 字段名对不上 / 返回解析不出来,
//   界面上看起来"就是没结果"。只断言"元素存在"完全抓不到。所以每条都验到**副作用**。
//
// 覆盖(默认组可跑; 只有「生成问卷」会调 LLM, 用拦 fetch 的方式停住不真烧):
//   ① 引文核查   从正文抽出 [n] 标注 → 真打 /api/citations/verify(Crossref/OpenAlex, 不烧 token)
//   ② 投稿前检查 期刊库真加载(80 本); 查重在没选源文本时**禁用**(验"没干耍流氓的事"),
//                而库查重那条**可点**(它不需要源文本)
//   ③ 选题论证   表述/范围进页面即出结果(无需点击) + 改题后**防抖自动重算** + 创新性按钮真打两处端点
//   ④ 研究设计   方法目录真加载 + 选中后出设计摘要
//   ⑤ 数据收集   两个模式可切 + 「生成问卷」真打端点(拦截态)
//   ⑥ 文献矩阵   有文献条目时才出现 + 「开始提取」真打 /api/literature/matrix
//   ⑦ 分析回流   真跑一次 regression → 列表出现 → **点按钮 → table 素材真落库**
//   ⑧ 引用网络   面板真渲染 + 力导向把节点摆开(**库非空时**)
//   ⑨ 库查重     拿**库内真实文本**去查必须命中自己 + 比例不超过 1（分子不去重会算出 >1）
//   ⑩ Word 导出  解开 docx 的 zip 看 document.xml: 期刊论文 1.5 倍、高校学报固定 20 磅
//
// ⚠⚠ ⑧ 与 ⑨ **依赖文献库**, 而 `data/` 是 gitignore 的 —— 本机 500 篇, **CI / 新部署 0 篇**。
//   这两条**必须**分情况: 库空时 skip 并说明"无验证对象", 库非空时必须真验。
//   2026-09-24 实测教训: 我一开始写成了无条件断言, 本地全绿、**推上去 CI 当场红**
//   (本地另起一个 LITERATURE_DIR 指向空目录的后端即可复现)。
//   这不是"放宽断言": 库为空时这条断言没有验证对象, 硬要求"有边"是在验环境而不是验代码。
//
// ⚠ 写这个探针时反复踩到的两类坑(都会造成**假红**, 与产品无关):
//   ① **观测时机**: 拦截器装晚了(改题重算是防抖触发的, 装完再等 600ms+)、
//      或装早但没还原(SPA 换页**不重载**, window.fetch 的覆盖会一直生效, 把后面全打成失败);
//   ② **被测对象看不见数据**: 写作舱的"当前项目"读 localStorage 指针而非 URL, 不写指针它就读别的项目。
//   所以每次导航都用 `hardGo`(先回空白页真正卸载, 再进目标 hash), 拦截器成对装/卸。
//
// 用法: node scripts/probe-writing-cabin-v425b.mjs
// 前置: 4173 已起(API_BASE/WEB 可覆盖, 同其它探针)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveBrowser } from "./lib/find-browser.mjs";
import { resolveCdpPort } from "./lib/cdp-port.mjs";
import { loginToken } from "./lib/cdp-editor.mjs";

const BASE = process.env.WEB || "http://127.0.0.1:4173";
const API = process.env.API_BASE || "http://127.0.0.1:4173";
let CDP_PORT = 31021;
const userData = mkdtempSync(path.join(tmpdir(), "edge-wf425b-"));

let ws, msgId = 0;
const pend = new Map();
const cdp = (m, p = {}) => new Promise((res, rej) => {
  const id = ++msgId; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p }));
  setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + m)); } }, 30000);
});
const ev = async (e) => {
  const r = await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return "JSERR:" + (r.exceptionDetails.exception?.description || "").slice(0, 300);
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (n, p, d) => { results.push({ n, p }); console.log(`  ${p ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`); };

/**
 * 造一个**属于本探针**的课题, 收尾删掉。
 * 教训(2026-09-24): 上一批探针每次运行都建一个项目却**从不删除**, 门禁跑了 N 次库里就多 N 个
 *   "未命名", 审计时完全对不上账。所以带副作用(建项目/传文件/跑分析)的探针必须自清。
 */
async function apiCall(method, p, token, body) {
  const res = await fetch(API + "/api" + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { __raw: txt }; }
}

async function main() {
  CDP_PORT = await resolveCdpPort(CDP_PORT);
  const token = await loginToken("audit", "audit123456"); // 不存在则自动注册(CI 空库)

  // ── 造测试数据: 一个课题 + 数据文件 + 一条文献素材(带 [n] 标注的正文与参考文献) ──
  const created = await apiCall("POST", "/research/projects", token, { title: `V425b探针-${Date.now()}`, status: "active", phase: 3, phaseLabel: "文献与资料" });
  const pid = ((created?.data ?? created)?.id) ?? "";
  if (!pid) { console.error("ERR 建课题失败, 无法继续:", JSON.stringify(created).slice(0, 200)); process.exit(1); }
  console.log(`  测试课题: ${pid}`);

  // 数据文件(有它才会渲染"本课题跑过的分析"那一段)
  const csv = ["id,x,y", "1,1.0,2.0", "2,2.0,4.1", "3,3.0,6.2"].join("\n");
  const up = await apiCall("POST", "/files/upload", token, {
    filename: "probe425b.csv", mime: "text/csv", base64: Buffer.from(csv, "utf-8").toString("base64"),
  });
  const fileId = up?.fileId ?? "";
  if (fileId) {
    await apiCall("PUT", `/research/projects/${pid}/workbench`, token, { snapshot: { statisticsFileId: fileId, phase: 3 } });
  }
  // 一条文献素材。⚠ kind 必须是 `citation` —— 后端只接受
  //   note/citation/data_result/figure/file/theory/table 这七种, 别的会被**静默降级成 note**,
  //   于是所有"按 kind 找文献"的前端逻辑恒空。首跑就是发了个 literature 才两条假红。
  await apiCall("POST", "/research/materials", token, {
    projectId: pid, kind: "citation", title: "数字经济与企业全要素生产率",
    contentMd: "数字化转型显著提升了企业全要素生产率[1]。这一结论在多个样本中都成立。",
    references: [{ title: "数字化转型与企业全要素生产率", author: "张三", year: "2022", source: "经济研究" }],
    sectionIds: [],
  });
  /**
   * 章节快照 —— **必须造**, 否则章节写作页是空态, 而引文核查块长在"选中章节"之后。
   *
   * ⚠ 这里踩过一次(2026-09-24 首跑 3 条假失败): 探针直接 `Page.navigate` 到
   *   `/soc/index.html#/workflow/materials` —— 写作舱的"当前项目"来自
   *   `localStorage['lastTask_workflow']`, 而不是 URL。于是它加载的是**上一次留下的项目**,
   *   探针刚建的那个课题根本没被读到 → 文献矩阵(有文献条目才渲染)与引文核查(有章节才渲染)
   *   两条全红。**探针造了数据却没让被测对象看见它** —— 这是探针自己制造的假失败。
   *   修法: ① 导航前把指针写到 localStorage(见下); ② 快照里带上章节。
   *
   * ⚠ 正文要**够长**: 投稿前检查的格式检查有 `>= 50 字` 的前置守卫(正文太短就不该查格式),
   *   最初这里只放了 29 字, 于是"格式检查真打端点"那条永远点不出请求 —— 又是探针的错,
   *   被守卫正确地挡住了。现在给足长度, 让守卫放行。
   */
  const SEC_BODY = "数字化转型显著提升了企业全要素生产率[1]。这一结论在多个样本、多个口径下都成立，"
    + "并且在控制了企业规模、行业与年份固定效应之后依然稳健。进一步的机制检验表明，"
    + "这一效应主要通过降低信息不对称与缓解融资约束两条渠道实现。";
  await apiCall("PUT", `/research/projects/${pid}/workbench`, token, {
    snapshot: {
      statisticsFileId: fileId, phase: 4,
      input: { title: "数字化转型与企业全要素生产率研究", outline: "一、引言\n二、文献综述", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [], clarifyAnswers: {} },
      sections: [{ id: "sec-1", title: "引言", level: 1, content: SEC_BODY }],
    },
  });

  const edge = spawn(resolveBrowser({ label: "scripts/probe-writing-cabin-v425b.mjs" }), [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "--headless=new",
    "--disable-gpu", "--window-size=1600,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
  let exited = false;
  edge.on("exit", (code) => { exited = true; if (ws === undefined) console.error(`  浏览器提前退出(code=${code})`); });

  try {
    for (let i = 0; i < 40; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const pg = l.find((t) => t.type === "page");
        if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; }
      } catch { /* not ready */ }
      if (exited) break;
      await sleep(500);
    }
    if (ws === undefined) throw new Error(`连不上浏览器调试端口 ${CDP_PORT}(20s 超时)。参见 scripts/lib/cdp-port.mjs。`);
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
    };
    await cdp("Page.enable"); await cdp("Runtime.enable");

    // 登录态 + 中文界面(CI 的 chromium 没有中文 locale, 不钉死界面会是英文, 中文断言全落空)
    await cdp("Page.navigate", { url: BASE }); await sleep(2200);
    await ev(`localStorage.setItem('sag:language-preference:v1','zh');`);
    if (token) await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)});`);
    /**
     * ⚠ **必须**把写作舱的项目指针指向探针刚建的课题。
     *   舱内"当前项目"读的是 `localStorage['lastTask_workflow']`(见 stores/workflow.ts 的
     *   loadProject), 不看 URL。不写这一句, 页面加载的是别的项目 —— 探针造的数据一条都读不到,
     *   于是"文献矩阵/引文核查"这类**依赖数据才渲染**的块会全红, 而代码其实是对的。
     */
    await ev(`localStorage.setItem('lastTask_workflow', ${JSON.stringify(pid)});`);
    // 直连写作舱 iframe(不经外壳)——本探针验的是舱内接线, 外壳那层由别套覆盖
    const go = async (sub) => {
      await cdp("Page.navigate", { url: `${BASE}/soc/index.html#${sub}` });
      await sleep(3200);
    };
    /**
     * 强制**真重载**再导航到子路由。
     *
     * ⚠ 不能只靠 `Page.navigate`: 本仓踩过 —— 目标 URL 与当前**只差 hash** 时, 浏览器视作同文档导航,
     *   不会重新加载页面。后果有两层:
     *   ① 上一次测试装的 `window.fetch` 覆盖**继续生效**(SPA 换页是重渲染, 不是重载),
     *      于是后面所有请求都被拦住 → 看起来像"产品坏了";
     *   ② 页面状态与上一次测试残留纠缠。
     *   这里先导航到同源空白页(真正卸载)再进目标 hash, 保证每次都是干净加载。
     */
    const hardGo = async (sub) => {
      await cdp("Page.navigate", { url: `${BASE}/soc/index.html` });
      await sleep(600);
      await cdp("Page.navigate", { url: `${BASE}/soc/index.html#${sub}` });
      await sleep(3200);
    };
    /** 装/卸 fetch 拦截器(成对使用) */
    const installFetchSpy = () => ev(`(() => {
      window.__capRealFetch = window.fetch;
      window.__capSpy = [];
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/api/')) { window.__capSpy.push({ url, method: (init && init.method) || 'GET' }); return Promise.reject(new Error('probe-abort')); }
        return window.__capRealFetch.apply(this, arguments);
      };
      return 1; })()`);
    const restoreFetch = () => ev(`(() => { if (window.__capRealFetch) { window.fetch = window.__capRealFetch; window.__capRealFetch = null; } window.__capSpy = []; return 1; })()`);
    const has = async (sel) => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
    const text = async () => ev(`(document.body.innerText||'').replace(/\\s+/g,' ')`);
    const clickSel = async (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'MISSING';e.click();return 'ok';})()`);
    const clickByText = async (t) => ev(`(()=>{const all=Array.from(document.querySelectorAll('button,summary,a')).filter(b=>(b.innerText||'').trim().includes(${JSON.stringify(t)}));const vis=all.filter(e=>!!(e.offsetWidth||e.offsetHeight));if(!vis.length)return 'MISSING';vis[0].click();return 'ok';})()`);

    // ═══ ① 选题界定: 选题论证 ═══
    await go("/workflow/input");
    const hasRationale = await has(".rationale-box");
    check("选题界定-论证面板存在", hasRationale === true);
    if (hasRationale) {
      // 填主题 → 本地两项应**自动**出结果(用户不必点任何东西)
      await ev(`(()=>{const el=document.querySelector('[data-control="workflow:research-title"]');if(!el)return 'MISSING';const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,'数字化转型与企业全要素生产率研究');el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
      await sleep(2600);
      const body = String(await text());
      const auto = /未见模板腔|疑似模板腔/.test(body) && /范围合适|偏宽/.test(body);
      check("选题界定-表述/范围自动出结果(无需点击)", auto, auto ? "" : "本地两项没出结果");
      const hasBtn = await has('[data-control="workflow:design-run"]');
      check("选题界定-创新性按钮存在(手动触发)", hasBtn === true);
    }

    // ═══ ② 框架设计: 研究设计 ═══
    await go("/workflow/sections");
    const hasDesign = await has(".design-box");
    check("框架设计-研究设计面板存在", hasDesign === true);
    if (hasDesign) {
      await sleep(1500);
      const body = String(await text());
      // 方法目录是真拉的(来自 GET /api/empirical/methods) —— 命中一两个具体方法名即证
      const gotMethods = /描述性统计|OLS 回归|双重差分/.test(body);
      check("框架设计-方法目录真加载", gotMethods, gotMethods ? "" : "方法清单没出现, 可能没拉到 /empirical/methods");
      const hasIdent = await has('[data-control="workflow:rd-identify-did"]');
      check("框架设计-因果识别七项存在", hasIdent === true);
      // 选中一个方法 + 一个识别策略 → 应出「设计摘要」
      await clickSel('[data-control="workflow:rd-identify-none"]');
      await sleep(400);
      const sum = String(await text());
      check("框架设计-选择后出设计摘要", /设计摘要/.test(sum), /设计摘要/.test(sum) ? "" : "选了识别策略但没有摘要");
    }

    // ═══ ③ 文献与资料: 数据收集 + 文献矩阵 ═══
    await go("/workflow/materials");
    await sleep(1200);
    const matBody = String(await text());
    check("文献与资料-数据收集面板存在", /数据收集（生成问卷/.test(matBody), /数据收集/.test(matBody) ? "" : "整块没渲染");
    check("文献与资料-文献矩阵出现(有文献条目时)", /文献提取矩阵/.test(matBody));
    const hasDcGen = await has('[data-control="workflow:dc-generate"]');
    check("文献与资料-问卷生成按钮存在", hasDcGen === true);
    if (hasDcGen) {
      await clickSel('[data-control="workflow:dc-mode-recognize"]');
      await sleep(400);
      const rec = await has('[data-control="workflow:dc-recognize"]');
      check("文献与资料-切到识别模式", rec === true);
    }

    // ═══ ④ 章节写作: 引文核查(真打后端, 不烧 token —— verify 是 Crossref/OpenAlex + 本地算法) ═══
    await go("/workflow/workspace");
    await sleep(1500);
    // 先选中章节: 引文核查块长在"选中章节"之后
    await clickSel(".nav-l1");
    await sleep(900);
    const wsBody = String(await text());
    check("章节写作-引文核查块存在", /引文核查/.test(wsBody), /引文核查/.test(wsBody) ? "" : `首段: ${wsBody.slice(0, 120)}`);
    const ccBtn = await has('[data-control="workflow:citation-check-run"]');
    check("章节写作-引文核查按钮存在", ccBtn === true);
    if (ccBtn) {
      // 正文里有一条 `[1]` 标注 + 库里有第 1 条参考文献 → 应报"找到 1 处引用"
      const note = String(await ev(`(()=>{const e=document.querySelector('.ccp-note');return e?e.innerText.replace(/\\s+/g,' '):'';})()`));
      check("章节写作-真从正文抽出 [n] 引用", /找到\s*1\s*处引用/.test(note), note.slice(0, 90));
      // 点下去 → 真打 /api/citations/verify。不烧 token(纯查证), 所以默认门禁里也敢跑。
      await clickSel('[data-control="workflow:citation-check-run"]');
      await sleep(6000);
      const after = String(await ev(`(()=>{const e=document.querySelector('.ccp-item');return e?e.innerText.replace(/\\s+/g,' '):'';})()`));
      // 判定标签是三维核验的结果(通过/存疑/无法判定/疑似问题)之一 —— 出现即证后端真返回并渲染了
      const rendered = /通过|存疑|无法判定|疑似问题/.test(after);
      check("章节写作-引文核查真跑并渲染三维结果", rendered, rendered ? after.slice(0, 80) : "点了没有结果渲染出来");
    }

    // ═══ ⑤ 统稿定稿: 投稿前检查(期刊库真加载) ═══
    await go("/workflow/finalize");
    await sleep(2600);
    const finBody = String(await text());
    const hasSub = /投稿前检查|选刊/.test(finBody);
    check("统稿定稿-投稿前检查存在", hasSub);
    if (hasSub) {
      const journals = /南核|北核|C扩/.test(finBody);
      check("统稿定稿-期刊库真加载", journals, journals ? "" : "级别标签没出现, 期刊库可能降级为空");
      const jrow = await ev(`document.querySelectorAll('[data-control^="workflow:sub-journal-"]').length`);
      check("统稿定稿-期刊条目已渲染", Number(jrow) > 0, `${jrow} 条`);
      // ⚠ 这条是验"没干耍流氓的事": 没有比对源文本时, 查重必须**不可点**
      const plgDisabled = await ev(`(()=>{const e=document.querySelector('[data-control="workflow:sub-plg-run"]');return e?e.disabled:null;})()`);
      check("统稿定稿-查重在未选源文本时禁用", plgDisabled === true, `disabled=${plgDisabled}`);
      const srcSel = await has('[data-control="workflow:sub-src-pick"]');
      check("统稿定稿-比对文献选择器存在", srcSel === true);
      // 库查重的主按钮 —— 这条**不需要**用户挑源文本, 所以它不该被禁用
      const corpusDis = await ev(`(()=>{const e=document.querySelector('[data-control="workflow:sub-corpus-run"]');return e?e.disabled:null;})()`);
      check("统稿定稿-库查重按钮可点(不需要源文本)", corpusDis === false, `disabled=${corpusDis}`);
    }

    // ═══ ⑥ 引用网络 —— 现算的文献耦合图(citation-graph-service 的接入口) ═══
    // 这条验的是"图真连出边了"。只验面板在没在是不够的: 一个渲染得很漂亮但零边的图,
    //   和"接错了数据源"长得一模一样。
    const net = await apiCall("GET", "/literature/network?threshold=0.05", token);
    const netNodes = (net?.nodes ?? []).length, netEdges = (net?.edges ?? []).length;
    check("引用网络-统计字段齐(库/有参考文献/库内互引)", typeof net?.stats?.papers === "number" && typeof net?.stats?.withRefs === "number" && typeof net?.stats?.inLibraryRefs === "number",
      JSON.stringify(net?.stats ?? {}));
    /**
     * ⚠ 「有边」这条**不能无条件断言** —— 引用网络依赖文献库, 而 `data/` 是 gitignore 的。
     *   本机库里 500 篇(有边), **CI / 新部署里是 0 篇(没边)**。
     *   无条件断言的后果: 推上去 CI 立刻红(2026-09-24 实测; 本地另起空库后端复现过)。
     *   这不是"放宽断言" —— 库为空时这条**没有验证对象**, 正确做法是 skip 并说明原因;
     *   库非空时必须真有边, 那才有意义。
     */
    const libEmpty = (net?.stats?.papers ?? 0) === 0;
    const libNoRefs = (net?.stats?.withRefs ?? 0) === 0;
    if (libEmpty) {
      check("引用网络-接口返回图且**有边**", "skip", "文献库为空(CI/新部署就是这个状态) —— 无验证对象");
    } else if (libNoRefs) {
      check("引用网络-接口返回图且**有边**", "skip", `库有 ${net.stats.papers} 篇但都没解析出参考文献 —— 无验证对象`);
    } else {
      check("引用网络-接口返回图且**有边**", netEdges > 0, `节点 ${netNodes} 边 ${netEdges}`);
    }

    // ═══ ⑦ 库查重 —— 拿库内真实正文当查询, 必须能查出它自己 ═══
    // 这是**唯一**能证明查重真在工作的方法: 用**确定来自库内**的文本去查, 必须命中。
    // (用一个随机字符串去查, 无论实现对不对都是"未发现重合", 那种断言是自娱自乐。)
    // ⚠ 第一次写这条时我拿"列表第一篇"当样本 —— 它恰好一条引文都没有, 于是断言退化成 skip。
    //   这等于没验。改成**扫到第一篇真有引文的**再用。
    let sampleRaw = "";
    const firstPage = await apiCall("GET", "/literature?pageSize=40", token);
    for (const it of firstPage?.items ?? []) {
      const cits = await apiCall("GET", `/literature/${it.id}/citations`, token);
      const entries = (cits?.citations?.entries ?? []).map((e) => e.raw).filter(Boolean);
      if (entries.join("。").length >= 50) { sampleRaw = entries.join("。").slice(0, 800); break; }
    }
    if (sampleRaw) {
      const plg = await apiCall("POST", "/quality/plagiarism-corpus", token, { text: sampleRaw });
      const ms = plg?.matches ?? [];
      const topRatio = Math.max(0, ...ms.map((m) => m.overlapRatio ?? 0));
      const topRun = Math.max(0, ...ms.map((m) => m.longestRun ?? 0));
      // 这段文本是由**库内某篇的参考文献条目**拼成的 → 该篇自己也含这些条目 → 必然命中
      check("库查重-查得出来(库内文本能被命中)", ms.length > 0, `命中 ${ms.length} 篇, 最高比例 ${topRatio}, 最长连续 ${topRun}`);
      // ⚠ 比例必须 <= 1 —— 分子不去重时会出现 1.565 这种超过 1 的"比例"(实测踩到过)
      check("库查重-比例不超过 1", topRatio <= 1, `最高 ${topRatio}`);
      check("库查重-确有连续命中(不是只擦到几个 gram)", topRun >= 20, `最长连续 ${topRun} 字`);
    } else {
      // 这里原先写成 check(名, "FAIL", 说明) —— **字符串是 truthy, 于是显示成 ✅**,
      // 而详情里还写着"按失败处理"。假绿比假红更坏: 它让"没验到"看起来像"验过了"。
      // 改成 skip 并把原因写清楚 —— 库为空是环境事实, 不是产品缺陷。
      check("库查重-查得出来(库内文本能被命中)", "skip", "文献库为空(CI/新部署就是这个状态) —— 无验证对象");
    }

    // ═══ ⑧ Word 导出带体例行距 —— 解开 docx 的 zip, 逐字节看 document.xml ═══
    // 只验"请求 200"是不够的: 行距写没写进文件, 只有解包才知道。
    // ⚠ document.xml 在 docx 里是 **deflate 压缩**的 —— 直接在 buffer 上找字符串找不到(我第一次就这么写的,
    //   两条断言全 null)。用 fflate 按 zip 解开再读。
    const { unzipSync } = await import("fflate");
    const docxProbe = async (target) => {
      const r = await apiCall("POST", "/paper-outline/export", token, {
        paperTitle: "体例探针稿", formatTarget: target,
        nodes: [{ title: "一、引言", level: 0, content: "正文段落，用于检查行距。" }],
        references: { text: "[1] 测试文献[J]. 某刊, 2020.", needsManual: false, sources: [] },
      });
      if (!r?.base64) return { err: "后端未返回 base64" };
      const files = unzipSync(new Uint8Array(Buffer.from(r.base64, "base64")));
      const xml = files["word/document.xml"] ? Buffer.from(files["word/document.xml"]).toString("utf-8") : "";
      if (!xml) return { err: "包里没有 word/document.xml" };
      const m = xml.match(/w:line="(\d+)" w:lineRule="(\w+)"/);
      return m ? { line: m[1], rule: m[2], paragraphs: (xml.match(/<w:p[ >]/g) ?? []).length } : { err: "document.xml 里没有任何行距设置" };
    };
    const d1 = await docxProbe("期刊论文");
    check("Word 导出-期刊论文 1.5 倍行距", d1?.line === "360" && d1?.rule === "auto", JSON.stringify(d1));
    const d2 = await docxProbe("高校学报");
    check("Word 导出-高校学报固定 20 磅", d2?.line === "400" && d2?.rule === "exact", JSON.stringify(d2));

    // ═══ ⑨ 尚未真正点过的四个按钮 —— 只验"接口通"是不够的 ═══
    //
    // 上面 ①~⑧ 里, 引文核查/库查重/Word 导出的**接口**我都是直接 fetch 验的 ——
    //   **按钮那条线一次都没走过**。而"接口通、按钮死"正是本仓反复踩的那类坑
    //   (verify-ui.mjs 里写着: 状态断言与动作断言都要有, 缺一就会出现"界面全对、按钮全死")。
    //   这里把剩下四个会发请求的按钮逐个点一遍, 用 probe-deep-analysis 的既成手法:
    //   **拦 fetch、记下请求形状、立刻 reject** —— 既不烧模型, 又能证明按钮真的接上了线。
    //
    // 顺序有讲究: 拦 fetch 一旦装上, 同页所有请求都会失败, 所以这四条放在**最后**跑,
    //   且每条跑完立刻恢复。被点到的面板会走失败分支 —— 这是预期的, 不影响后面的断言。
    const clickAndCapture = async (route, sel, waitMs = 1600) => {
      await hardGo(route);
      if (route.includes("/materials")) {
        // 文献矩阵在折叠块里 —— 先展开, 否则按钮点不到(且量到的是"幽灵盒")
        await ev(`(()=>{const d=[...document.querySelectorAll('details')].find(x=>(x.querySelector('summary')||{}).innerText?.includes('文献提取矩阵'));if(d)d.open=true;return 1;})()`);
        await sleep(400);
      }
      await installFetchSpy();
      const clicked = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return 'MISSING'; if (e.disabled) return 'DISABLED';
        e.scrollIntoView({ block: 'center' }); e.click(); return 'ok'; })()`);
      await sleep(waitMs);
      const reqs = await ev(`(window.__capSpy || [])`);
      // ⚠ 必须还原! 拦截器挂在 window.fetch 上, 而 SPA 换页**不会**重载页面 ——
      //   不还原的话后面所有请求都被 reject, 看起来就像"产品坏了"(实测把 ⑩⑪ 两条全打成假红)。
      await restoreFetch();
      return { clicked, reqs: Array.isArray(reqs) ? reqs : [] };
    };
    const hit = (reqs, frag) => reqs.find((r) => String(r.url).includes(frag));

    const m1 = await clickAndCapture("/workflow/materials", '[data-control="workflow:matrix-run"]', 2200);
    check("文献矩阵-『开始提取』真打端点", m1.clicked === "ok" && !!hit(m1.reqs, "/literature/matrix"),
      `点击=${m1.clicked} 请求=${m1.reqs.map((r) => r.method + " " + r.url).join(" ") || "零请求"}`);

    const f1 = await clickAndCapture("/workflow/finalize", '[data-control="workflow:sub-format-run"]', 2200);
    check("投稿检查-『格式检查』真打端点", f1.clicked === "ok" && !!hit(f1.reqs, "/quality/format"),
      `点击=${f1.clicked} 请求=${f1.reqs.map((r) => r.method + " " + r.url).join(" ") || "零请求"}`);

    const i1 = await clickAndCapture("/workflow/input", '[data-control="workflow:design-run"]', 2200);
    check("选题论证-『评估创新性与编辑标准』真打端点", i1.clicked === "ok" && !!hit(i1.reqs, "/cjournal/validate") && !!hit(i1.reqs, "/cjournal/mainline-check"),
      `点击=${i1.clicked} 请求=${i1.reqs.map((r) => r.method + " " + r.url).join(" ") || "零请求"}`);
    /**
     * 表述/范围两项不点按钮也该算 —— 而且**改了题要重算**(面板上写着"不花钱，改题即重算")。
     *
     * ⚠ 别想用"拦截器装在导航前"去抓加载时的请求: `Page.navigate` 会重载页面,
     *   `window.fetch` 的覆盖随之被冲掉(实测抓了个空)。加载时那一次已由上面
     *   「表述/范围自动出结果(无需点击)」用**界面**证明了 —— 那条断言的就是"没点任何东西却出了结论"。
     *   这里改为验更值钱的那半句: **改题 → 防抖后自动重算**(覆盖 watch + 600ms debounce 的接线)。
     */
    await installFetchSpy();
    await ev(`(() => { const el = document.querySelector('[data-control="workflow:research-title"]');
      if (!el) return 'MISSING';
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, '农村土地流转意愿的影响因素研究');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok'; })()`);
    await sleep(2600);   // watch 有 600ms 防抖, 留足时间
    const autoReqs = await ev(`(window.__capSpy || [])`);
    const autoList = Array.isArray(autoReqs) ? autoReqs : [];
    check("选题论证-改题后自动重算(防抖 watch)", !!hit(autoList, "/cjournal/template-check") && !!hit(autoList, "/cjournal/scope-check"),
      `请求=${autoList.map((r) => r.url).join(" ") || "零请求"}`);
    await restoreFetch();

    // ⚠ 「生成问卷」会真调 LLM —— 必须在**拦截态**下点。
    //   clickAndCapture 收尾会把拦截器还原(见它的注释), 所以这里得**再装一次**,
    //   否则 spied 数组是空的, 看起来就像"按钮没接线"(实测被自己坑了一条)。
    await hardGo("/workflow/materials");
    await sleep(1200);
    await ev(`(()=>{const d=[...document.querySelectorAll('details')].find(x=>(x.querySelector('summary')||{}).innerText?.includes('数据收集'));if(d)d.open=true;return 1;})()`);
    await sleep(400);
    await installFetchSpy();
    const dcClick = await ev(`(() => { const e = document.querySelector('[data-control="workflow:dc-generate"]');
      if (!e) return 'MISSING'; if (e.disabled) return 'DISABLED';
      e.scrollIntoView({ block: 'center' }); e.click(); return 'ok'; })()`);
    await sleep(2200);
    const dcReqs = await ev(`(window.__capSpy || [])`);
    await restoreFetch();
    const dcList = Array.isArray(dcReqs) ? dcReqs : [];
    check("数据收集-『生成问卷』真打端点(拦停未烧模型)", dcClick === "ok" && !!hit(dcList, "/empirical/questionnaires/generate"),
      `点击=${dcClick} 请求=${dcList.map((r) => r.method + " " + r.url).join(" ") || "零请求"}`);

    // ═══ ⑩ 引用网络面板**在浏览器里真的画出图了** ═══
    //
    // 上面那条只验了**接口**返回节点与边 —— 面板有没有把它们画出来, 完全没走过。
    // 这是"接口通 ≠ 界面在"的典型: d3 布局若抛错、SVG 选择器写错、容器高度塌成 0,
    //   接口那条照样全绿。所以这里必须去量**真的 <circle>/<line> 元素**。
    // 面板在折叠块里, 先展开(闭着的 details 里量到的是"幽灵盒", 见 verify-layout 的教训)。
    await hardGo("/workflow/materials");
    await ev(`(() => { const d = [...document.querySelectorAll('details')].find(x => (x.querySelector('summary') || {}).innerText?.includes('引用网络'));
      if (d) d.open = true; return 1; })()`);
    await sleep(4500);   // 构图要读 500 个文件(约 1.5s) + d3 布局
    const svgInfo = await ev(`(() => {
      const svg = document.querySelector('.cnp-svg');
      if (!svg) return { err: '没有 .cnp-svg' };
      const circles = svg.querySelectorAll('circle').length;
      const lines = svg.querySelectorAll('line').length;
      const box = svg.getBoundingClientRect();
      // 节点真的被摆开了吗 —— 全挤在一点也说明布局没跑(力导向失败时常见)
      const xs = [...svg.querySelectorAll('circle')].map(c => Number(c.getAttribute('cx')));
      const spread = xs.length ? Math.round(Math.max(...xs) - Math.min(...xs)) : 0;
      return { circles, lines, w: Math.round(box.width), h: Math.round(box.height), spread };
    })()`);
    // 面板这条同样分情况: 库空时改验"空态有没有把原因说清楚", 不硬要求画点
    if (libEmpty || libNoRefs) {
      const emptyText = await ev("(() => { const e = document.querySelector('.cnp-empty'); return e ? e.innerText.replace(/\\s+/g, ' ').trim() : ''; })()");
      check("引用网络-空库时说的是原因(不是一句「没有数据」)",
        /文献库还是空的|没有一篇解析出参考文献/.test(String(emptyText)),
        `空态文案="${String(emptyText).slice(0, 72)}"`);
    } else {
      check("引用网络-面板真画出 SVG 节点与边", (svgInfo?.circles ?? 0) > 0 && (svgInfo?.lines ?? 0) > 0,
        `circle=${svgInfo?.circles} line=${svgInfo?.lines} spread=${svgInfo?.spread}px 容器=${svgInfo?.w}x${svgInfo?.h}`);
      check("引用网络-节点被真正摆开(力导向跑过)", (svgInfo?.spread ?? 0) > 50, `x 方向跨度 ${svgInfo?.spread}px(>50 才算排开)`);
    }

    // ═══ ⑪ 「插入到当前章节」按钮 —— 真点一次, 并验素材真落库 ═══
    //
    // 上面 ④ 只验了 `/statistics-jobs/:id/to-materials` **接口**能插(直接 fetch),
    //   而界面上那个按钮从没被点过。这里造一份数据文件 + 跑一次真分析, 再点按钮。
    //   之所以敢真跑分析: statistics_runner 是**纯统计**(pandas/statsmodels), 不调 LLM, 秒级完成。
    const rows = ["id,x,y"];
    for (let i = 1; i <= 24; i++) rows.push(`${i},${i},${(2 * i + (i % 5) * 0.13).toFixed(2)}`);
    const up2 = await apiCall("POST", "/files/upload", token, {
      filename: "probe425b_reg.csv", mime: "text/csv", base64: Buffer.from(rows.join("\n"), "utf-8").toString("base64"),
    });
    const fid2 = up2?.fileId ?? "";
    if (!fid2) {
      check("分析回流-『插入到当前章节』真点且真落库", "FAIL", "数据文件上传失败");
    } else {
      await apiCall("PUT", `/research/projects/${pid}/workbench`, token, { snapshot: { statisticsFileId: fid2, phase: 4 } });
      const job = await apiCall("POST", "/statistics-jobs", token, {
        tool: "regression", fileId: fid2, params: { dependentVar: "y", independentVars: ["x"] },
      });
      const jobId = job?.job?.id ?? "";
      for (let i = 0; i < 12 && jobId; i++) {
        await sleep(3000);
        const st = await apiCall("GET", `/statistics-jobs/${jobId}`, token);
        if (["completed", "failed", "cancelled"].includes(st?.job?.status)) break;
      }
      // 回到资料页: 展开「本课题跑过的分析」那一段(它在"从其他模块导入"下面, 有数据文件才渲染)
      await hardGo("/workflow/materials");
      await sleep(500);
      const listInfo = await ev(`(() => {
        const btns = [...document.querySelectorAll('[data-control^="workflow:insert-analysis-"]')];
        return { n: btns.length, text: btns[0] ? btns[0].textContent.trim() : '', disabled: btns[0] ? btns[0].disabled : null };
      })()`);
      check("分析回流-列表里出现可插入的分析", (listInfo?.n ?? 0) > 0, `按钮数=${listInfo?.n} 文案="${listInfo?.text}"`);
      if ((listInfo?.n ?? 0) > 0) {
        const before = await apiCall("GET", `/research/materials?projectId=${pid}`, token);
        const beforeTables = (before?.materials ?? []).filter((m) => m.kind === "table").length;
        await ev(`(() => { const b = document.querySelector('[data-control^="workflow:insert-analysis-"]'); if (b) { b.scrollIntoView({block:'center'}); b.click(); } return 1; })()`);
        await sleep(3000);
        const after = await apiCall("GET", `/research/materials?projectId=${pid}`, token);
        const tables = (after?.materials ?? []).filter((m) => m.kind === "table");
        const td = tables[0]?.tableData ?? {};
        check("分析回流-点按钮后 table 素材真落库", tables.length > beforeTables && (td.columns ?? []).length > 0,
          `table 素材 ${beforeTables}→${tables.length}, 列数=${(td.columns ?? []).length} 行数=${(td.rows ?? []).length}`);
      }
    }

    const bad = results.filter((r) => !r.p).length;
    console.log(bad ? `\n  ❌ ${results.length - bad}/${results.length} 通过` : `\n  ✅ ${results.length}/${results.length} 全部通过`);
    if (bad) process.exitCode = 1;
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    edge.kill();
    // ── 清理: 删素材 + 删课题(数据文件与统计结果随课题一起留着也没用, 但接口只能删课题) ──
    try {
      const ms = await apiCall("GET", `/research/materials?projectId=${pid}`, token);
      for (const m of (ms?.materials ?? ms?.items ?? [])) {
        await apiCall("DELETE", `/research/materials/${m.id}`, token);
      }
      await apiCall("DELETE", `/research/projects/${pid}`, token);
      console.log(`  已清理测试课题 ${pid}`);
    } catch { console.error(`  ⚠ 清理测试课题失败(需手动删): ${pid}`); }
    setTimeout(() => rmSync(userData, { recursive: true, force: true }), 800);
  }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
