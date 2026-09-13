// pb-report-verify.mjs — P-B 报告 UI 验证(独立无头会话): 直达审稿记录→打开 done job→断言报告新元素
// 用法: node scripts/pb-report-verify.mjs
import { spawn } from "node:child_process";
import { resolveBrowser } from "./lib/find-browser.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const BASE = "http://localhost:4173";
const CDP_PORT = 9334;
const userData = mkdtempSync(path.join(tmpdir(), "edge-cdp-pb"));

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

async function main() {
  const edge = spawn(resolveBrowser({ label: "scripts/pb-report-verify.mjs" }), [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "--headless=new", "--disable-gpu", "--window-size=1440,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 30; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const pg = l.find((t) => t.type === "page");
        if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; }
      } catch { }
      await new Promise((r) => setTimeout(r, 500));
    }
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } };

    await cdp("Page.enable"); await cdp("Runtime.enable");
    // login admin
    const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) });
    const token = (await r.json()).token;
    await cdp("Page.navigate", { url: BASE }); await new Promise((r2) => setTimeout(r2, 2500));
    if (token) { await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)}); location.href='http://localhost:4173/#review-lab';`); await new Promise((r2) => setTimeout(r2, 4000)); }

    const res = await ev(`(async () => {
      const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight));
      const clickByText = async (txt, partial=false) => {
        const els = Array.from(document.querySelectorAll('button,[role=button],a,div'));
        const el = els.find(b => { const t=(b.innerText||'').trim(); return partial ? t.includes(txt)&&t.length<80 : t===txt; });
        if (el && vis(el)) { el.click(); await new Promise(r=>setTimeout(r,600)); return true; }
        return false;
      };
      // 1) 点'审稿记录' tab
      await clickByText('审稿记录');
      await new Promise(r=>setTimeout(r,1200));
      // 2) 点第一张 job 卡(卡片区含 '· ' 或 done)
      const card = Array.from(document.querySelectorAll('div.cursor-pointer,div[class*=cursor]')).find(el => { const t=(el.textContent||''); return t.includes('字') && t.includes('2026'); });
      if (!card) return 'NO-CARD';
      card.click();
      await new Promise(r=>setTimeout(r,4000));
      const body = (document.querySelector('#root')||document.body).innerText;
      const checks = {
        total: body.includes('总分'),
        grade: body.includes('及格') || body.includes('良好') || body.includes('优秀') || body.includes('不及格'),
        core: body.includes('核心问题'),
        weight: body.includes('权重 4') || body.includes('权重 5'),
        dims7: body.includes('7 个维度审查'),
        original: body.includes('原文对照'),
      };
      // 抽报告段文本
      let seg = '';
      for (const mk of ['审稿报告','维度评分卡','核心问题']) { const i = body.indexOf(mk); if (i >= 0) { seg = body.slice(i, i + 500); break; } }
      return JSON.stringify({ checks, seg }, null, 1);
    })()`);
    console.log(res);
  } finally {
    try { ws?.close(); } catch { }
    edge.kill();
    setTimeout(() => rmSync(userData, { recursive: true, force: true }), 800);
  }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
