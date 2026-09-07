// browser-smoke.mjs — 4173 真实浏览器视图冒烟(无头 Edge + CDP)
// 用法: node scripts/browser-smoke.mjs [--user audit] [--views "科研工作台 DAG,审稿实验室"]
// 输出: 每视图首屏正文(从视图特征头截取) + 全部 JS/console error
// 前置: 4173 服务已起; audit 测试账号存在(无则自动注册)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "http://localhost:4173";
const CDP_PORT = 9333;
const userData = mkdtempSync(path.join(tmpdir(), "edge-cdp-"));

const VIEWS = ["科研工作台 DAG", "审稿实验室", "科研绘图", "学术编辑器", "论文写作台", "实证研究"];

let ws, msgId = 0;
const pend = new Map();
const cdp = (m, p = {}) => new Promise((res, rej) => {
  const id = ++msgId; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p }));
  setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + m)); } }, 30000);
});
const ev = async (e) => {
  const r = await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return "JSERR:" + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};

async function ensureUser(username, password) {
  let r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (r.ok) return (await r.json()).token;
  r = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, email: `${username}@sag.local` }) });
  if (r.ok) return (await r.json()).token;
  return "";
}

async function main() {
  const argv = process.argv.slice(2);
  const views = (argv.find((a) => a.startsWith("--views"))?.split("=")[1] ?? "").split(",").filter(Boolean);
  const user = argv.find((a) => a.startsWith("--user"))?.split("=")[1] ?? "audit";
  const password = "audit123456";
  const targets = views.length ? views : VIEWS;
  const errors = [];
  const edge = spawn(EDGE, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "--headless=new", "--disable-gpu", "--window-size=1440,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 30; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const pg = l.find((t) => t.type === "page");
        if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; }
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
      if (d.method === "Runtime.exceptionThrown") errors.push("EXC: " + (d.params.exceptionDetails.exception?.description || "").slice(0, 300));
      if (d.method === "Log.entryAdded" && d.params.entry.level === "error" && !/favicon/.test(d.params.entry.text)) errors.push("LOG: " + d.params.entry.text.slice(0, 200));
    };
    await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable");
    const token = await ensureUser(user, password);
    await cdp("Page.navigate", { url: BASE }); await new Promise((r) => setTimeout(r, 2000));
    if (token) { await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)}); location.reload();`); await new Promise((r) => setTimeout(r, 2600)); }

    for (const v of targets) {
      const res = await ev(`(async () => {
        const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight));
        const clickNav = async (label) => {
          const els = Array.from(document.querySelectorAll('button,[role=button],a'));
          const el = els.find(b => (b.innerText||'').trim() === label);
          if (el && vis(el)) { el.click(); await new Promise(r=>setTimeout(r,500)); return true; }
          return false;
        };
        await clickNav('科研中心');
        await new Promise(r=>setTimeout(r,900));
        const ok = await clickNav(${JSON.stringify(v)});
        if (!ok) return 'entry-not-found';
        await new Promise(r=>setTimeout(r,3000));
        await clickNav('科研中心');
        await new Promise(r=>setTimeout(r,400));
        const root = document.querySelector('#root');
        const txt = (root ? root.innerText : '').replace(/\\s+/g, ' ');
        const markers = ['科研工作台', '审稿实验室', '科研绘图', '学术编辑器', '论文写作台', '实证研究', '写作'];
        let body = txt;
        for (const mk of markers) { const i = txt.lastIndexOf(mk); if (i > 0) { body = txt.slice(i); break; } }
        return body.length > 1000 ? body.slice(0, 1000) : body;
      })()`);
      console.log("\n===== " + v + " =====");
      console.log(typeof res === "string" ? res.slice(0, 1000) : JSON.stringify(res).slice(0, 1000));
    }
    console.log("\n===== JS/console errors =====");
    console.log(errors.slice(0, 20).join("\n---\n") || "(none)");
  } finally {
    try { ws?.close(); } catch { }
    edge.kill();
    setTimeout(() => rmSync(userData, { recursive: true, force: true }), 800);
  }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
