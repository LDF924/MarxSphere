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
 * @param {*} cdp CDP 会话
 * @param {string} base 形如 http://127.0.0.1:4173
 * @param {string} route 形如 /workflow/materials
 * @param {string} token Bearer token
 * @param {string} [pid] 写入 lastTask_workflow 的项目 id
 */
export async function openSoc(cdp, base, route, token, pid, wait = 7000) {
  await cdp("Page.navigate", { url: `${base}/soc/index.html#${route}` });
  await sleep(wait);
  // token/pid 必须在 reload **之前**写好 —— reload 后才是我们要测的那次加载。
  //   顺序反了会让应用带着旧 localStorage 启动, 再用注入的值跑, 但已经发出的首屏请求是错的。
  await evalTop(cdp, `localStorage.setItem('sag_token', ${JSON.stringify(token)});`);
  if (pid) await evalTop(cdp, `localStorage.setItem('lastTask_workflow', ${JSON.stringify(pid)});`);
  await cdp("Page.reload");
  await sleep(wait);
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
  await sleep(wait);
  const reqs = (await spyLog(cdp)) || [];
  const apiReqs = (Array.isArray(reqs) ? reqs : []).filter((r) => r && typeof r.url === "string" && r.url.includes("/api/"));
  return {
    clicked,
    before: Array.isArray(before) ? before : [],
    apiReqs,
    last: apiReqs.length ? apiReqs[apiReqs.length - 1] : null,
    toast: await readToast(cdp),
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
