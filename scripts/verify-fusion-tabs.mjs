// verify-fusion-tabs.mjs — 5 个 FusionPanel(Vue 子应用)tab 的真实浏览器验证
//   验证点: iframe 指向 /soc/index.html#<route>, 且内容确实是 Vue 子应用而非 React 外壳
//   (2026-09-12 踩坑: web/dist/soc/ 被 vite build 的 emptyOutDir 清掉后,
//    iframe 落到 SPA 兜底 → 渲染成 React 应用「AI 对话页」)
// 用法: node scripts/verify-fusion-tabs.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveBrowser } from "./lib/find-browser.mjs";
import { resolveCdpPort } from "./lib/cdp-port.mjs";
import { loginToken } from "./lib/cdp-editor.mjs";

const BASE = "http://localhost:4173";
let CDP_PORT = 31007; // 起点值; 真实端口由 resolveCdpPort 探测(见下)
const userData = mkdtempSync(path.join(tmpdir(), "edge-fusion-"));

let ws, msgId = 0;
const pend = new Map();
const cdp = (m, p = {}) => new Promise((res, rej) => {
  const id = ++msgId; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p }));
  setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + m)); } }, 30000);
});
const ev = async (e) => {
  const r = await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return "JSERR:" + (r.exceptionDetails.exception?.description || "").slice(0, 200);
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 科研中心 → 5 个 Vue 完整版 tab(每个对应 FUSION_TABS 里的一条 vueRoute)
// 注意: want 用**结构性文案**(标题/面板名/稳定标签), 不要用某个版本的按钮字。
// 2026-09-13 编排画布重写后, 原来的「可视化DAG编排模式|标准工作流|科研 Agent」全被替换,
// 这条门禁就误报失败 —— 但它要验的是"iframe 里是本子应用而非 React 兜底", 与具体文案无关。
const TABS = [
  { label: "研途写作舱", route: "/workflow/input", want: /信息录入|科研架构|素材|工作流/ },
  { label: "课题流程编排", route: "/workbench/quick", want: /课题流程编排|能力节点|可用能力/ },
  { label: "论文质量评审", route: "/review", want: /审稿|评审|期刊|标准/ },
  { label: "成果可视化工坊", route: "/viz", want: /绘图|图表|可视化/ },
  { label: "学术文本工作台", route: "/editor", want: /文档|编辑|正文|保存|写作/ },
];
// React 外壳的特征串 — 出现即说明 iframe 落到了 SPA 兜底
const REACT_APP = /对话记录|知识中心.*政策资料|全人文社科 AI 科研中枢/;

const results = [];
const check = (n, p, d) => { results.push(p); console.log(`  ${p ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`); };

async function main() {
  // 端口由 resolveCdpPort 真实探测(硬编码端口曾整片落在 Windows 保留区间 9250-9449,
  // 浏览器 bind() 报 WSAEACCES → DevTools http server 起不来 → 本脚本恒失败)。
  CDP_PORT = await resolveCdpPort(CDP_PORT);
  const edge = spawn(resolveBrowser({ label: "scripts/verify-fusion-tabs.mjs" }), [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "--headless=new",
    "--disable-gpu", "--window-size=1500,950", "--no-first-run", "about:blank"], { stdio: "ignore" });
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
    // 原来这里直接 `ws.onmessage = ...`: 拿不到调试端口时 ws 还是 undefined,
    // 抛的是 "Cannot set properties of undefined" —— 看不出真正原因, 也没告诉人怎么办。
    if (ws === undefined) {
      throw new Error(`连不上浏览器调试端口 ${CDP_PORT}(20s 超时)。参见 scripts/lib/cdp-port.mjs 的排查说明。`);
    }
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
    };
    await cdp("Page.enable"); await cdp("Runtime.enable");

    const token = await loginToken("audit", "audit123456"); // 不存在则自动注册(CI 空库)
    await cdp("Page.navigate", { url: BASE }); await sleep(2200);
    if (token) { await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)});`); await cdp("Page.reload"); await sleep(2800); }
    await ev(`window.clickByText=function(l){const v=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight));const el=Array.from(document.querySelectorAll('button,[role=button],a')).find(b=>(b.innerText||'').trim()===l);if(el&&v(el)){el.click();return true;}return false;};true;`);
    await ev(`(async()=>{window.clickByText('科研中心');await new Promise(r=>setTimeout(r,700));})()`);

    for (const t of TABS) {
      const clicked = await ev(`window.clickByText(${JSON.stringify(t.label)})`);
      await sleep(3000);
      const info = await ev(`(async () => {
        const fs = Array.from(document.querySelectorAll('iframe'));
        const panel = fs.find(f => !!(f.offsetWidth||f.offsetHeight));
        let inner = '';
        try { inner = panel && panel.contentDocument ? (panel.contentDocument.body.innerText||'').replace(/\s+/g,' ') : ''; } catch(e) { inner = 'ERR'; }
        return { src: panel ? panel.getAttribute('src') : null, inner: inner.slice(0, 300) };
      })()`);
      const srcOk = info?.src === `/soc/index.html#${t.route}`;
      const notReact = !REACT_APP.test(info?.inner ?? "");
      const wantOk = t.want.test(info?.inner ?? "");
      const pass = clicked === true && srcOk && notReact && wantOk;
      check(`${t.label.padEnd(8)}`, pass, `src=${srcOk ? "ok" : info?.src} 非React=${notReact} 内容命中=${wantOk}`);
      if (!pass) console.log(`      内首段: ${(info?.inner || "(空)").slice(0, 130)}`);
    }
    const bad = results.filter((x) => !x).length;
    console.log(bad ? `\n  ❌ ${results.length - bad}/${results.length} 通过` : `\n  ✅ ${results.length}/${results.length} 全部通过`);
    // ⚠ 2026-09-23 补: 原先这里只打结论、**从不设置退出码**, 于是失败也 exit 0。
    //   后果实测过一次 —— CI 上出现 `✅ fusion-tabs  58.1s  ❌ 0/5 通过`:
    //   红着标了绿勾, 而汇总行("全部通过")跟着一起撒谎。**假绿比真红危险**。
    if (bad) process.exitCode = 1;
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    edge.kill();
    setTimeout(() => rmSync(userData, { recursive: true, force: true }), 800);
  }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
