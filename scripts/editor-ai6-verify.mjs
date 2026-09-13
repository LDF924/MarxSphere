// editor-ai6-verify.mjs — AI 编辑助手 6 页签对齐验证(闭源辅助工具页签序: 全文检查/选区修改/题名摘要/引用格式/格式模板/图表)
import { spawn } from "node:child_process";
import { resolveBrowser } from "./lib/find-browser.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
const CDP_PORT = 9348;
const userData = mkdtempSync(path.join(tmpdir(), "edge-cdp-ai6"));
let ws, msgId = 0; const pend = new Map();
const cdp = (m, p = {}) => new Promise((res, rej) => { const id = ++msgId; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + m)); } }, 20000); });
const ev = async (e, t = 15000) => { const r = await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true, timeout: t }); if (r.exceptionDetails) return "JSERR:" + (r.exceptionDetails.exception?.description || "").slice(0, 150); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(resolveBrowser({ label: "scripts/editor-ai6-verify.mjs" }), [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "--headless=new", "--disable-gpu", "--window-size=1440,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 30; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); const pg = l.find((t) => t.type === "page"); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; } } catch { } await sleep(500); }
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } };
    await cdp("Page.enable"); await cdp("Runtime.enable");
    const r = await fetch(`http://localhost:4173/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) });
    const token = (await r.json()).token;
    await cdp("Page.navigate", { url: "http://localhost:4173/" }); await sleep(3000);
    await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)}); location.hash='#editor';`); await sleep(7000);
    const out = await ev(`(async () => {
      // 开文档
      const ps = Array.from(document.querySelectorAll('p.truncate')).filter(p => (p.textContent||'').trim().length > 0 && (p.textContent||'').trim().length < 40);
      if (ps.length) { const k = Object.keys(ps[0]).find(x => x.startsWith('__reactProps')); ps[0][k]?.onClick?.(); }
      await new Promise(r2=>setTimeout(r2,3500));
      // 开 AI面板
      const ab = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').includes('AI面板'));
      if (ab) { const k = Object.keys(ab).find(x => x.startsWith('__reactProps')); ab[k]?.onClick?.(); }
      await new Promise(r2=>setTimeout(r2,1200));
      const body = (document.querySelector('#root')||document.body).innerText;
      // 页签顺序: 全文检查/选区修改/题名摘要/引用格式/格式模板/图表
      const order = ['全文检查','选区修改','题名摘要','引用格式','格式模板','图表'];
      const pos = order.map(t => body.indexOf(t));
      return JSON.stringify({ tabs: order.map((t,i)=>({t, at: pos[i]})), ordered: pos.every((p,i)=>i===0||pos[i-1]<p), hasPanel: body.includes('AI 编辑助手') });
    })()`);
    console.log(out);
  } finally { try { ws?.close(); } catch {} edge.kill(); setTimeout(() => rmSync(userData, { recursive: true, force: true }), 800); }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
