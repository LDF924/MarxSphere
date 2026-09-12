// verify-fusion-tabs.mjs — 5 个 FusionPanel(Vue 子应用)tab 的真实浏览器验证
//   验证点: iframe 指向 /soc/index.html#<route>, 且内容确实是 Vue 子应用而非 React 外壳
//   (2026-09-12 踩坑: web/dist/soc/ 被 vite build 的 emptyOutDir 清掉后,
//    iframe 落到 SPA 兜底 → 渲染成 React 应用「AI 对话页」)
// 用法: node scripts/verify-fusion-tabs.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "http://localhost:4173";
const CDP_PORT = 9363;
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
const TABS = [
  { label: "研途写作舱", route: "/workflow/input", want: /信息录入|科研架构|素材|工作流/ },
  { label: "课题流程编排", route: "/workbench/quick", want: /可视化DAG编排模式|标准工作流|科研 Agent/ },
  { label: "论文质量评审", route: "/review", want: /审稿|评审|期刊|标准/ },
  { label: "成果可视化工坊", route: "/viz", want: /绘图|图表|可视化/ },
  { label: "学术文本工作台", route: "/editor", want: /文档|编辑|正文|保存|写作/ },
];
// React 外壳的特征串 — 出现即说明 iframe 落到了 SPA 兜底
const REACT_APP = /对话记录|知识中心.*政策资料|全人文社科 AI 科研中枢/;

const results = [];
const check = (n, p, d) => { results.push(p); console.log(`  ${p ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`); };

async function main() {
  const edge = spawn(EDGE, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "--headless=new",
    "--disable-gpu", "--window-size=1500,950", "--no-first-run", "about:blank"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 30; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const pg = l.find((t) => t.type === "page");
        if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; }
      } catch { /* not ready */ }
      await sleep(500);
    }
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
    };
    await cdp("Page.enable"); await cdp("Runtime.enable");

    let token = "";
    const lr = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "audit", password: "audit123456" }) });
    if (lr.ok) token = (await lr.json()).token;
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
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    edge.kill();
    setTimeout(() => rmSync(userData, { recursive: true, force: true }), 800);
  }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
