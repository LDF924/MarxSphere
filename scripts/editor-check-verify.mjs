// editor-check-verify.mjs — P-C 编辑器全文检查 4 模式 UI 验证(无头 Edge+CDP)
// 用法: node scripts/editor-check-verify.mjs (前置: 4173 已起; admin 账号存在)
// 通过: 4 检查模式全渲染 + 提示语 + 运行按钮带模式名
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = 9347;
const userData = mkdtempSync(path.join(tmpdir(), "edge-cdp-ec"));
let ws, msgId = 0; const pend = new Map();
const cdp = (m, p = {}) => new Promise((res, rej) => { const id = ++msgId; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + m)); } }, 20000); });
const ev = async (e, t = 15000) => { const r = await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true, timeout: t }); if (r.exceptionDetails) return "JSERR:" + (r.exceptionDetails.exception?.description || "").slice(0, 150); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "--headless=new", "--disable-gpu", "--window-size=1440,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 30; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); const pg = l.find((t) => t.type === "page"); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; } } catch { } await sleep(500); }
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } };
    await cdp("Page.enable"); await cdp("Runtime.enable");
    const r = await fetch(`http://localhost:4173/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) });
    const token = (await r.json()).token;
    await cdp("Page.navigate", { url: "http://localhost:4173/" }); await sleep(3000);
    await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)}); location.hash='#editor';`); await sleep(7000);
    const out = await ev(`(async () => {
      const ps = Array.from(document.querySelectorAll('p.truncate')).filter(p => (p.textContent||'').trim().length > 0 && (p.textContent||'').trim().length < 40);
      if (ps.length) { const k = Object.keys(ps[0]).find(x => x.startsWith('__reactProps')); ps[0][k]?.onClick?.(); }
      await new Promise(r2=>setTimeout(r2,3500));
      const cb = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').includes('全文检查'));
      if (cb) { const k = Object.keys(cb).find(x => x.startsWith('__reactProps')); cb[k]?.onClick?.(); }
      await new Promise(r2=>setTimeout(r2,1500));
      const body = (document.querySelector('#root')||document.body).innerText;
      return JSON.stringify({ modes: ['全文逻辑检查','章节衔接检查','变量-方法-结论一致性','投稿前检查'].map(t=>body.includes(t)), hint: body.includes('只给修改建议'), runBtn: body.includes('运行全文逻辑检查'), drawer: body.includes('全文一致性检查') });
    })()`);
    console.log(out);
  } finally { try { ws?.close(); } catch {} edge.kill(); setTimeout(() => rmSync(userData, { recursive: true, force: true }), 800); }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
