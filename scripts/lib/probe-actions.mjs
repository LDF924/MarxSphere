// scripts/lib/probe-actions.mjs — 写作舱「可执行动作」实测探针
//
// 为什么需要它: verify-writing-cabin.mjs 是**状态断言**门禁(读 DOM 判断渲染对不对),
//   覆盖的是"长什么样"。但 82 个 data-control 动作里的大部分要验的是**做的对不对** ——
//   点下去有没有发出请求、参数字段名对不对、后端认不认、失败有没有反馈。
//   两类缺陷的表现不同: 状态断言可以全绿而动作全是死的(已踩过: `status:"done"` vs
//   `"generated"` 两套词汇, 界面渲染正常但计数恒为 0)。
//
// 做法: 真点(data-control) + 拦 fetch 记录真实请求 + 断言「发出了请求」和「参数形状」。
//   ⚠ 只拦不阻断: 请求照常发到后端, 我们能同时看到请求体与响应码。
//   真点击必须落在**顶层页面** —— 跨 iframe 的 Input.dispatchMouseEvent 不保证路由进子文档
//   (见 cdp-editor.mjs clickInFrame 的注释), 所以这里统一用 openSoc 把子应用开成顶层页。
import { evalTop, clickOnPage, sleep } from "./cdp-editor.mjs";

/**
 * 注入 fetch 拦截器(记录 method/url/body/status, 不阻断)。
 * 页面导航会清掉注入脚本 —— 每次 openSoc 之后都要重装。
 */
const INSTALL_SPY = `(() => {
  if (window.__spy) { window.__spy.log.length = 0; return 'reused'; }
  const log = [];
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    let body = null;
    try { body = init && init.body ? String(init.body) : null; } catch (e) { body = '<unreadable>'; }
    const rec = { url, method, body, status: null, at: Date.now() };
    log.push(rec);
    try {
      const res = await of.apply(this, arguments);
      rec.status = res.status;
      return res;
    } catch (e) { rec.status = 'ERR:' + String((e && e.message) || e); throw e; }
  };
  window.__spy = { log };
  return 'installed';
})()`;

/**
 * 把 soc 子应用作为**顶层页面**打开 —— 需要真实鼠标事件的场景唯一可靠的落点。
 *
 * ## 2026-09-27 改：从"两次固定死等"改成一跳 + 就绪轮询（门禁提速 17 分钟）
 *
 * 旧实现在这里睡掉了整个门禁最大的一笔开销：**每次调用 15 秒**，
 *   `navigate + 等 7.5s → 写 token → reload + 等 7.5s`，
 *   而门禁里约 83 次调用 ⇒ **20.8 分钟**，占了门禁总时长(40.7 分钟)的一半，
 *   CI 上也是 43 分钟里 40.6 分钟全在这一步。
 *
 * **实测 soc 应用真正可用的耗时是 873ms** —— 那 15 秒里 14 秒是纯睡，
 * 而且这跟代码改不改没关系：`sleep(wait)` 不看页面状态，睡够才走。
 *
 * 新实现两处改动：
 *
 * ① **删掉第一次导航**。它当年的唯一目的是"先有个 origin 才能写 localStorage"，
 *    但 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 可以在**任何页面脚本执行之前**
 *    注入一段代码 —— token 直接写进真正的首次加载，不需要"先开一次空的、再 reload"。
 *    这同时**顺带修掉一个真实的错误窗口**：旧写法里首屏请求带着**旧的/没有的** token 发出去，
 *    要靠 reload 纠正（原注释自己写了这个顺序问题）。现在首屏就是对的。
 * ② **等待从 `sleep` 改成轮询"就绪"**。判据是子应用根元素出现 + 首屏数据请求已经回来
 *    （见 `readyProbe` 的注释），拿到就走；`wait` 仍然是**超时上限**，一个不多等。
 *
 * ⚠ 两点必须留着，否则会从"慢"变成"偶发红"：
 *   · `addScriptToEvaluateOnNewDocument` 是**每次导航都会跑**的，所以在同一个 cdp 会话里
 *     反复 openSoc 会累积多个注入脚本。每次调用先清掉自己上一次注册的那个(id 存起来)。
 *   · 就绪判据里**必须包含"首屏请求已回来"**, 不能只等 DOM。有些断言读的是加载完成的数据;
 *     只等外壳渲染出来会进入"DOM 在了、数据还没到"的窗口，表现为随机失败。
 *
 * @param {*} cdp CDP 会话
 * @param {string} base 形如 http://127.0.0.1:4173
 * @param {string} route 形如 /workflow/materials
 * @param {string} token Bearer token
 * @param {string} [pid] 写入 lastTask_workflow 的项目 id
 * @param {number} [wait] **超时上限**(ms), 不是固定等待 —— 就绪即返回
 * @param {string} [suffix] 入口路径后缀, 默认 "/soc/index.html"(4173 的静态产物);
 *   开发期传 "/"(soc 子工程的 vite dev, 自带热更新)即可免去每改一行都重新 build。
 */
export async function openSoc(cdp, base, route, token, pid, wait = 7000, suffix = "/soc/index.html") {
  /**
   * 就绪判据：**根元素已挂上 + 没有在飞的数据请求 + 已经安静了一会儿**。
   *
   * ⚠ 「安静一会儿」这一段是必须的，第一版没有它、实测红了两个套件。
   *   第一版只数"启动后 2.5 秒内发出的请求"，而写作舱是**分段落加载**的：
   *   外壳先出（~900ms），项目数据在 `loadProject()` 之后才发，有的页还要等前一发回来
   *   才发下一发。2.5 秒那个窗口一关，后面发的请求就不计数了 ——
   *   判据在"外壳在、数据没到"的瞬间就成立并放行，于是依赖数据的按钮还没渲染出来。
   *   实测症状：`probe-project-rail` 的「未合稿也能看到大纲导出」变成 false
   *   （未合稿=false 已合稿=false ⇒ 两边都还没渲染出来）。
   *
   * 现在的判据不看"第几秒发的"，只看**当前**状态：
   *   没有未完成的请求，并且距最后一个请求开始已经过了 `QUIET_MS`。
   *   分几批发、每批间隔多久都不影响正确性 —— 只要还会再发，就还没到安静。
   *
   * 代价说明（写下来免得以后当成 bug）：**一直在轮询的页面**（间隔 < QUIET_MS）
   *   永远等不到安静窗口，会一直等到超时。那等于退回旧行为 —— 慢，但不会错。
   *   所以这里不设"最大安静窗口"之类的花活：正确性优先。
   */
  const QUIET_MS = 600;
  const READY = `(() => {
    const d = document;
    const root = d.querySelector('.workflow-page, .ws-page-root, .wf-layout');
    const appFilled = !!(d.querySelector('#app') && d.querySelector('#app').children.length);
    if (!root && !appFilled) return false;
    const rs = d.readyState;
    if (rs !== 'complete' && rs !== 'interactive') return false;
    const b = window.__boot;
    if (b) {
      if (b.pending > 0) return false;
      if (b.lastAt && (Date.now() - b.lastAt) < ${QUIET_MS}) return false;
    }
    return true;
  })()`;

  /**
   * 注入脚本：在**任何页面脚本执行之前**写好 token/pid，并装一个只数 `/api/` 请求的计数器。
   *
   * 为什么不数静态资源：它们不是 fetch，本来就不进这个口。
   * 为什么挂 `window.__boot` 而不是重装 fetch 拦截器：这个脚本每次导航都会跑，
   *   而 `__boot` 一旦存在就跳过重建 —— 免得反复包装 fetch 把调用栈堆起来。
   *
   * `__bootNonce` 是给调用方判"这次导航到底有没有换来一个新文档"用的（见下面 fresh 那一段）。
   * 每次调用生成一个新值，所以上一个 openSoc 留下的 nonce 必然对不上。
   */
  const bootNonce = `bn-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const boot = `(() => {
    window.__bootNonce = ${JSON.stringify(bootNonce)};
    try {
      localStorage.setItem('sag_token', ${JSON.stringify(token)});
      ${pid ? `localStorage.setItem('lastTask_workflow', ${JSON.stringify(pid)});` : ""}
    } catch (e) { /* 隐私模式等 */ }
    if (!window.__boot) {
      const b = { pending: 0, lastAt: 0 };
      const of = window.fetch;
      window.fetch = function () {
        const u = String((typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url)) || '');
        if (u.indexOf('/api/') >= 0) {
          b.pending++;
          b.lastAt = Date.now();
          const done = function () { b.pending = b.pending > 0 ? b.pending - 1 : 0; };
          try { return of.apply(this, arguments).then(function (r) { done(); return r; }, function (e) { done(); throw e; }); }
          catch (e) { done(); throw e; }
        }
        return of.apply(this, arguments);
      };
      window.__boot = b;
    }
  })()`;

  const r = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: boot }).catch(() => null);
  const injectedId = r?.identifier ?? null;

  /**
   * 超时上限 = 调用方给的 `wait` 的 **2 倍**。
   *
   * ⚠ 这一条是并发改动的**必要配套**，不加就会把"慢"变成"错"：
   *   旧实现是 `navigate + 等 wait` → 写 token → `reload + 再等 wait`，总共 **2×wait** 才断言；
   *   新实现只有一次加载，如果超时上限还用 `wait`，**总耐心只剩一半**。
   *   机器一忙（门禁并发跑时）就会比旧实现更早放弃，然后断言拿着半渲染的页面报错 ——
   *   看着像产品坏了，其实是等待预算被我砍了一半。
   *
   * 上限**不花钱**：健康时 873ms 就轮询到并返回，这个值只在被压慢时才会碰到。
   */
  const capMs = Math.max(wait * 2, 8000);
  try {
    await cdp("Page.navigate", { url: `${base}${suffix}#${route}` });

    /**
     * ⚠ **只有真的换了文档，注入才生效** —— 必须验，不能假设。
     *
     * soc 是 hash 路由的单页应用：从 `#/workflow/sections` 导航到 `#/workflow/finalize`
     * **是同一个文档**，`Page.navigate` 只触发 hashchange，**根本不重新加载** ——
     * 于是 document-start 的注入脚本一次都不跑，localStorage 里还是上一个项目的指针。
     *
     * 实测踩过（第一版就是这么错的）：`probe-project-rail` 的 ⑥b 在两次 `openSoc` 之间
     * 先做了 Alt+2/Alt+3 跳页，所以第二次 openSoc 落进"同文档导航"这条路上，
     * 打开的还是**上一个项目** —— 受控对照（未合稿 vs 已合稿）两边变成同一个对象，
     * 「未合稿也能看到大纲导出」判成 false。而单跑这个探针时第一次 openSoc 是从
     * React 外壳跳过来的（真换文档），所以**只在序列里复现、单独跑不复现**。
     *
     * 判据用 nonce：注入脚本会把它写到 `window.__bootNonce`，navigate 之后对不上
     * 就说明文档没换过 ⇒ 补一次 `Page.reload()`（那才是旧实现里唯一有效的那次加载）。
     */
    const fresh = await evalTop(cdp, `window.__bootNonce === ${JSON.stringify(bootNonce)}`).catch(() => false);
    if (fresh !== true) await cdp("Page.reload");

    const t0 = Date.now();
    let timedOut = false;
    for (;;) {
      const ok = await evalTop(cdp, READY).catch(() => false);
      if (ok === true) break;
      if (Date.now() - t0 >= capMs) { timedOut = true; break; }
      await sleep(120);
    }
    /**
     * 超时**要说出来**。静默超时会让"页面没准备好"伪装成"断言失败" ——
     * 而两者的排查方向完全不同（等得不够 vs 功能坏了）。
     * 打一行到 stderr（gate 会把子进程 stderr 一起收进日志）。
     */
    if (timedOut) {
      process.stderr.write(`\n  [openSoc] 等就绪超时(${capMs}ms)：${route} —— 这一跳之后断言可能都在看半渲染的页面\n`);
    }
  } finally {
    /**
     * ⚠ **注入脚本必须在这次导航之后立刻撤掉** —— 它一旦还注册着，**后面任何一次跳转**
     *   （包括探针自己写的裸 `Page.reload()`）都会再跑一遍，把我们刚注入的 token/pid
     *   重新盖回 localStorage。
     *
     *   实测踩过：`probe-input-clarify-and-phase` 的「刷新后从草稿恢复」是**故意**把
     *   `lastTask_workflow` 设成一个**已删除**的项目 id 再 reload，制造"无可用项目"的状态；
     *   注入脚本没撤，reload 时又把上个 openSoc 的 pid 写了回去，前提被破坏 ⇒ 长期报 ERR。
     *   这类"前置条件被旁路掉"的失败最难查 —— 断言看着像产品坏了。
     *
     * 放入 `finally`：中途抛错也不会把它留在会话里。
     */
    if (injectedId) await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: injectedId }).catch(() => null);
  }

  /**
   * 短的 settle —— 给 Vue 的 nextTick / 样式计算 / 首屏动画留一点时间。
   *
   * ⚠ 不能是 0。就绪判据看的是"根元素在不在"，而门禁里大量断言量的是
   *   **布局尺寸**(无溢出/无重叠/两栏不塌)。元素刚进 DOM 的那一帧尺寸还没算稳，
   *   0 等待会让布局类断言偶发红。400ms 是实测能稳住的最小值。
   */
  await sleep(400);
}

export async function spyInstall(cdp) {
  return evalTop(cdp, INSTALL_SPY);
}
export async function spyClear(cdp) {
  return evalTop(cdp, `(() => { if (window.__spy) window.__spy.log.length = 0; return true; })()`);
}
export async function spyLog(cdp) {
  return evalTop(cdp, `(() => (window.__spy ? window.__spy.log : []) )()`);
}

/** 读页面上的 toast / 内联错误提示(动作失败时用户看到的那句话) */
export async function readToast(cdp) {
  return evalTop(cdp, `(() => {
    const fixed = [...document.querySelectorAll('div')].filter(d => {
      const s = d.getAttribute('style') || '';
      return s.includes('position') && s.includes('fixed');
    });
    const texts = fixed.map(d => (d.innerText || '').split(/\\s+/).join(' ').trim()).filter(Boolean);
    const inline = [...document.querySelectorAll('[class*="error"],[class*="fail"],.banner-warn,.banner-err,.gone-banner')]
      .map(e => (e.innerText || '').split(/\\s+/).join(' ').trim()).filter(Boolean);
    return [...texts, ...inline].join(' | ').slice(0, 300);
  })()`);
}

/**
 * 一次动作实测: 清日志 → 真点 → 等 → 取请求。
 * @returns {{clicked:*, before:string[], apiReqs:Array, last:object|null, toast:string}}
 */
export async function probeAction(cdp, selector, { wait = 2600, index = 0, keepOverlays = false } = {}) {
  // ⚠ 必须先关掉可能挡路的浮层: 写作舱的助手面板/弹层是 position:fixed 的高 z-index 覆盖层,
  //   盖在按钮上时 Input.dispatchMouseEvent 打中的是覆盖层 —— 表现为"点了没反应",
  //   而按钮根本没收到事件。实测踩过: 素材页格子在浮层下恒报 DEAD(假失败)。
  // keepOverlays: 目标按钮**就在弹层里**时必须置 true。
  //   否则 dismissOverlays 会先把那个弹层关掉, 再去点一个已经不存在的按钮 —— 表现为
  //   "点了没反应"(实测: 手动添加弹层的「保存」、生成弹层的按钮全部误报 DEAD)。
  if (!keepOverlays) await dismissOverlays(cdp);
  await spyClear(cdp);
  const before = await evalTop(cdp, `(() => [...document.querySelectorAll(${JSON.stringify(selector)})]
    .map(e => (e.innerText || e.value || '').replace(/\\s+/g,' ').trim().slice(0, 40)))()`);
  let clicked;
  try {
    clicked = await clickOnPage(cdp, selector, { index });
  } catch (e) {
    clicked = "ERR:" + e.message;
  }
  /**
   * 等待期间**持续采样 toast** —— 不能等完再读一次。
   *
   * 2026-09-18 修(这个坑我逐个脚本补了四次, 索性在这里一次修掉):
   *   toast 只活约 3.2s。`await sleep(wait)` 之后再 `readToast()` —— 只要 wait ≥ 3.2s
   *   (而门禁类断言恰恰常用 wait:2500~4000 来"等它别急"), toast 必然已经消失,
   *   于是"被门禁拦下并给了提示"被读成"零请求 + 零提示"= DEAD(假失败)。
   *   实测踩过: 素材页 allocate、创作台 section-to-editor、合稿页 finish-gen-save、
   *   审稿台 submit、数据台 run —— 五次全是同一个形状。
   *
   * 现在按 250ms 采样整个等待窗口, 取**第一条**非空 toast(最早的那条最贴近本次动作)。
   */
  let toast = "";
  const deadline = Date.now() + Math.max(0, wait);
  while (!toast && Date.now() < deadline) {
    await sleep(250);
    toast = (await readToast(cdp)) || "";
  }
  // 若在窗口内就采到了, 剩余时间照等 —— 调用方依赖 `wait` 也用来"等异步落库"
  const rest = deadline - Date.now();
  if (rest > 0) await sleep(rest);
  const reqs = (await spyLog(cdp)) || [];
  const apiReqs = (Array.isArray(reqs) ? reqs : []).filter((r) => r && typeof r.url === "string" && r.url.includes("/api/"));
  return {
    clicked,
    before: Array.isArray(before) ? before : [],
    apiReqs,
    last: apiReqs.length ? apiReqs[apiReqs.length - 1] : null,
    toast,
  };
}

/**
 * 关掉会挡住点击的浮层(助手面板 / 已打开的弹层)。只点"关闭"类按钮, 不碰业务动作。
 *
 * ⚠ 不要把全局 confirm 层的按钮(div[style*="position:fixed"] 里的取消/确认)收进来。
 *   本函数在**每次 probeAction 之前**都跑 ——
 *   (a) "点删除 → 断言确认层出现 → 再点确认"这类分两步的用例, 确认层会在第一步就被自己关掉
 *       (实测踩到: 删素材的确认层刚出来就没了, 表现为"点了没反应");
 *   (b) 断言过程中若用 probeAction 去查层内元素(它的 dismissOverlays 会先跑), 同样误关。
 *   这两种场合改用 evalTop 直点。
 */
export async function dismissOverlays(cdp) {
  return evalTop(cdp, `(() => {
    let closed = 0;
    for (const sel of ['.modal-x', '.dlg-close', '.assistant-close', '[data-control="assistant:close"]']) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.offsetParent !== null || el.getClientRects().length) { el.click(); closed++; }
      }
    }
    return closed;
  })()`);
}

/** 轮询直到 expr 求值为真或超时; 返回最后一次求值结果(不抛错) */
export async function waitFor(cdp, expr, { timeout = 40000, every = 1500 } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await evalTop(cdp, expr);
    if (last) return last;
    await sleep(every);
  }
  return last;
}
