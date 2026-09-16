// scripts/lib/cdp-editor.mjs — 编辑器验证脚本共用的 CDP 样板(2026-09-14)
//
// 由来: editor-ai6-verify / editor-check-verify / editor-ai6-chart 三个脚本各自复制了
//   同一份 90% 相同的 CDP 样板(起浏览器→连端口→登录→导航→evaluate), 于是**同一个 bug
//   要修三遍**(端口打进 Windows 保留区间时就是这么坏的)。抽到一处。
//
// 另一处必须记住的: 这三个脚本原先都在**顶层 document** 里找编辑器的 AI 面板,
//   还在用 `__reactProps`(React fiber 内部属性)去触发点击。
//   但真编辑器早换成了 **Vue 版**(web/socialsci-vue/src/views/editor/), 它渲染在 /soc/ 的
//   iframe 里, 根组件是 Vue —— 顶层既没有那些节点, 也没有 __reactProps。
//   所以它们**永远不可能通过**。这里统一按 iframe + 真 DOM 点击来。

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveBrowser } from "./find-browser.mjs";
import { resolveCdpPort } from "./cdp-port.mjs";

const BASE = "http://127.0.0.1:4173";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起浏览器并连上 CDP。返回 { ev, cdp, close } —— ev 是"在页面里跑 JS"。
 * @param {{ preferredPort: number, label: string, tmpPrefix?: string, windowSize?: string }} opts
 */
export async function startCdp({ preferredPort, label, tmpPrefix = "edge-cdp", windowSize = "1440,900" }) {
  const port = await resolveCdpPort(preferredPort);
  const userData = mkdtempSync(path.join(tmpdir(), tmpPrefix));
  const proc = spawn(
    resolveBrowser({ label }),
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, "--headless=new",
     "--disable-gpu", `--window-size=${windowSize}`, "--no-first-run", "about:blank"],
    { stdio: "ignore" },
  );
  let ws, msgId = 0;
  const pend = new Map();
  try {
    for (let i = 0; i < 40; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const pg = l.find((t) => t.type === "page");
        if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; }
      } catch { /* not ready */ }
      await sleep(500);
    }
    if (!ws) throw new Error(`连不上调试端口 ${port}(20s 超时)。若端口在 Windows 保留区间内, netsh int ipv4 show excludedportrange protocol=tcp 可查。`);
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
    };
    const cdp = (method, params = {}) => new Promise((res, rej) => {
      const id = ++msgId; pend.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + method)); } }, 30000);
    });
    await cdp("Page.enable"); await cdp("Runtime.enable");
    const ev = async (expr) => {
      const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return "JSERR:" + String(r.exceptionDetails.exception?.description ?? "").slice(0, 200);
      return r.result?.value;
    };
    const close = () => {
      try { ws?.close(); } catch { /* ignore */ }
      proc.kill();
      setTimeout(() => rmSync(userData, { recursive: true, force: true }), 800);
    };
    return { cdp, ev, close, port };
  } catch (e) {
    try { proc.kill(); } catch { /* ignore */ }
    rmSync(userData, { recursive: true, force: true });
    throw e;
  }
}

/**
 * 登录取 token。账号不存在就**自动注册**(CI 里是空库, 没有 admin)。
 * 都失败返回空串, 由调用方决定怎么报 —— 不在这里静默兜底成"游客"。
 */
export async function loginToken(username = "admin", password = "admin123") {
  const post = async (path, body) => {
    try {
      const r = await fetch(`${BASE}/api/auth/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) return "";
      return (await r.json()).token ?? "";
    } catch { return ""; }
  };
  const hit = await post("login", { username, password });
  if (hit) return hit;
  // 空库/新环境: 注册一个固定名的验证账号(幂等——已存在时注册会失败, 那就再登一次)
  const reg = await post("register", { username, password, email: `${username}@verify.local` });
  return reg || (await post("login", { username, password }));
}

/**
 * 打开编辑器并展开「辅助工具」AI 面板, 返回 iframe 的 frameId。
 * 步骤都是**真实 DOM 点击**, 不碰框架内部属性。
 */
export async function openEditorWithAiPanel(ev, cdp, token) {
  await cdp("Page.navigate", { url: BASE });
  await sleep(3000);
  if (token) await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)});`);
  await ev(`location.hash = '#editor';`);
  await sleep(8000);

  // /soc/ 的 iframe 是 Vue 编辑器; 用 iframe 的 frameId 建 isolated world 才能稳定取到它
  const frameId = await findSocFrame(cdp);
  if (!frameId) return null;

  // 面板可能默认收起 —— 点工具栏「辅助工具」展开(名称取自 EditorView.vue 的按钮文案)
  await evalInFrame(cdp, frameId, `(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').includes('辅助工具'));
    if (!b) return 'no-toggle';
    if (!b.classList.contains('active')) b.click();
    return 'toggled';
  })()`);
  await sleep(2000);
  return frameId;
}

/** 找到 /soc/ 那个子 frame 的 id */
export async function findSocFrame(cdp) {
  const { frameTree } = await cdp("Page.getFrameTree");
  const walk = (t, acc = []) => {
    if (t.frame?.url?.includes("/soc/")) acc.push(t.frame.id);
    for (const c of t.childFrames ?? []) walk(c, acc);
    return acc;
  };
  return walk(frameTree)[0] ?? null;
}

/**
 * 在指定子 frame 里求值。
 * Playwright 那套在这里用不上(脚本走的是裸 CDP); Runtime.evaluate 需要 frame 的
 * executionContextId —— 由 Page.createIsolatedWorld 拿。
 */
/** 在**顶层文档**求值(不建 isolated world —— 顶层没有跨 world 的事件问题) */
export async function evalTop(cdp, expression) {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return "JSERR:" + String(r.exceptionDetails.exception?.description ?? "").slice(0, 200);
  return r.result?.value;
}

export async function evalInFrame(cdp, frameId, expression) {
  const { executionContextId } = await cdp("Page.createIsolatedWorld", { frameId, worldName: "verify", grantUniveralAccess: true });
  const r = await cdp("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return "JSERR:" + String(r.exceptionDetails.exception?.description ?? "").slice(0, 200);
  return r.result?.value;
}

/**
 * 在子 frame 里对元素发**真实鼠标事件**(mousedown → mouseup)。
 *
 * 三个必须同时处理对的坑(都实际踩过):
 *
 * ① **不能用 element.click()**: 本文件的求值走 Page.createIsolatedWorld, 那是与页面主世界
 *   **隔离**的执行环境 —— 在里面拿到的 element 是隔离世界的包装, `.click()` 合成的事件
 *   到不了主世界 Vue 挂的监听器上。表现是"函数返回成功, 但界面毫无反应"。
 *
 * ② **必须加上 iframe 在父页里的偏移**: `Input.dispatchMouseEvent` 收的是**顶层页面**坐标,
 *   而 `getBoundingClientRect()` 给的是 iframe 内的坐标。少了这个偏移就会点到别的地方 ——
 *   实测写作舱的 iframe 顶部偏移 119px。
 *
 * ③ **滚动与读坐标必须分成两次求值**: 同一个同步块里 `scrollIntoView()` 之后立刻
 *   `getBoundingClientRect()`, 拿到的是**滚动之前**的位置(浏览器不会同步重排)。
 *   元素在视口外时点击坐标就是过期的 —— 这是"点不中"最隐蔽的一种, 因为函数照样返回 true。
 *   实测写作舱的合稿按钮(页面中部)恒点不中, 而顶部的「新项目」按钮一直正常
 *   (它在视口内, scrollIntoView 不产生滚动, 所以从来没暴露这个 bug)。
 */
export async function clickInFrame(cdp, frameId, selector, opts = {}) {
  const sel = JSON.stringify(selector);
  // frameId 为空 → 顶层页面(没有隔离 world 问题, 直接用 ev 语义)
  const evalAt = frameId ? (expr) => evalInFrame(cdp, frameId, expr) : (expr) => evalTop(cdp, expr);
  // 第一次求值: 只做滚动(behavior:instant 避免平滑滚动期间坐标继续变)
  await evalAt(`(() => {
    const el = document.querySelector(${sel});
    if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
    return 'ok';
  })()`);
  await sleep(250); // 等滚动与重排落定
  // 第二次求值: 滚动之后再读坐标
  const point = await evalAt(`(() => {
    const el = document.querySelector(${sel});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!point || typeof point !== "object") return false;
  const off = await frameOffset(cdp, frameId);
  const common = {
    x: point.x + off.x, y: point.y + off.y,
    button: "left", clickCount: 1, ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
  };
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...common, button: "none" });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
  await sleep(60);
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...common });
  return true;
}

/**
 * 顶层页面上的真实鼠标点击(clickInFrame 的无 frame 版本)。
 * frameId 传 null / undefined 时可直接用 clickInFrame —— 这里单独给个名字是为了让调用点
 * 一眼看出"这一击发生在顶层"。
 */
export async function clickOnPage(cdp, selector, opts = {}) {
  return clickInFrame(cdp, null, selector, opts);
}

/**
 * 子 frame 左上角在**顶层页面**里的坐标。
 * 做法: 从根 frame 往下逐层找目标 frame, 每层在**父 frame 的文档**里查这个 iframe 元素的
 * getBoundingClientRect, 把各级偏移累加 —— 这就是 Input.dispatchMouseEvent 需要的坐标系。
 * 找不到时返回 {0,0}(退化成旧行为, 不会因此崩掉)。
 */
async function frameOffset(cdp, frameId) {
  // 顶层页面无 frame 可找 —— 偏移就是 0
  if (!frameId) return { x: 0, y: 0 };
  try {
    const { frameTree } = await cdp("Page.getFrameTree");
    const walk = async (node, accX, accY) => {
      if (node.frame?.id === frameId) return { x: accX, y: accY };
      for (const child of node.childFrames ?? []) {
        const childUrl = child.frame?.url ?? "";
        const target = shortUrl(childUrl);
        if (target === "/") continue;
        // 这个子 frame 对应的 <iframe> 元素在**父 frame** 的文档里
        const box = node.frame?.id
          ? await evalInFrame(cdp, node.frame.id, `(() => {
              const f = [...document.querySelectorAll('iframe')]
                .find(x => (x.getAttribute('src') || '').includes(${JSON.stringify(target)}));
              if (!f) return { x: 0, y: 0 };
              const b = f.getBoundingClientRect();
              return { x: Math.round(b.x), y: Math.round(b.y) };
            })()`).catch(() => ({ x: 0, y: 0 }))
          : { x: 0, y: 0 };
        const safe = (box && typeof box === "object") ? box : { x: 0, y: 0 };
        const got = await walk(child, accX + (safe.x ?? 0), accY + (safe.y ?? 0));
        if (got) return got;
      }
      return null;
    };
    return (await walk(frameTree, 0, 0)) ?? { x: 0, y: 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}

/** 取 URL 里有辨识度的一段(用于在父文档里定位对应的 iframe 元素) */
function shortUrl(u) {
  try {
    const url = new URL(u);
    return url.pathname + url.hash || "/";
  } catch {
    return u || "/";
  }
}

/** 打印统一格式的结论行 */
export function verdict(results) {
  const bad = results.filter((r) => !r.pass).length;
  for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  console.log(bad ? `\n  ❌ ${results.length - bad}/${results.length} 通过` : `\n  ✅ ${results.length}/${results.length} 全部通过`);
  return bad === 0;
}
