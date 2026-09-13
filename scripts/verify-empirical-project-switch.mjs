// verify-empirical-project-switch.mjs — 验证本次三处改动(无头 Edge + CDP, 真浏览器)
//   ① 不再自动选中课题(初始应显示"选择课题")
//   ② 课题下拉每项显示 问卷/数据/分析 计数
//   ③ 空状态文案点名当前课题
// 用法: node scripts/verify-empirical-project-switch.mjs
// 前置: 4173 已起, 且已应用本次改动 + 前端已重新构建
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveBrowser } from "./lib/find-browser.mjs";

const BASE = "http://localhost:4173";
const CDP_PORT = 9345;
const userData = mkdtempSync(path.join(tmpdir(), "edge-cdp-emp-"));

let ws, msgId = 0;
const pend = new Map();
const cdp = (m, p = {}) => new Promise((res, rej) => {
  const id = ++msgId; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p }));
  setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error("timeout " + m)); } }, 30000);
});
const ev = async (e) => {
  const r = await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return "JSERR:" + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)).slice(0, 400);
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 每次导航/刷新后 window 上的辅助函数都会丢, 用前重新注入
const inject = () => ev(CLICK_FN);

// 在页面里同步点击一个可见按钮(按 innerText 精确匹配)。
// 先单独求值这段把 clickByText/mainText 挂到 window 上, 后续表达式直接用
// (函数声明不能塞进 (...)(...) 表达式里, 会 SyntaxError)。
const CLICK_FN = `
window.clickByText = function(label) {
  const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight));
  const els = Array.from(document.querySelectorAll('button,[role=button],a'));
  const el = els.find(b => (b.innerText||'').trim() === label);
  if (el && vis(el)) { el.click(); return true; }
  return false;
};
window.mainText = function() {
  const m = document.querySelector('main') || document.querySelector('#root');
  return (m ? m.innerText : '').replace(/\\s+/g, ' ');
};
true;`;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  ✅" : "  ❌"} ${name}${detail ? "  — " + detail : ""}`);
}

async function main() {
  const errors = [];
  let tmpProjectId = "";
  const edge = spawn(resolveBrowser({ label: "scripts/verify-empirical-project-switch.mjs" }), [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, "--headless=new",
    "--disable-gpu", "--window-size=1440,1000", "--no-first-run", "about:blank"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 30; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const pg = l.find((t) => t.type === "page");
        if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; }
      } catch { /* not ready */ }
      await sleep(500);
    }
    const bad = new Map();   // requestId -> url
    const failed401 = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
      if (d.method === "Runtime.exceptionThrown") errors.push("EXC: " + (d.params.exceptionDetails.exception?.description || "").slice(0, 300));
      if (d.method === "Log.entryAdded" && d.params.entry.level === "error" && !/favicon/.test(d.params.entry.text)) errors.push("LOG: " + d.params.entry.text.slice(0, 200));
      if (d.method === "Network.requestWillBeSent") bad.set(d.params.requestId, d.params.request.url);
      if (d.method === "Network.responseReceived" && d.params.response.status >= 400) {
        const u = bad.get(d.params.requestId) ?? d.params.response.url;
        failed401.push(`${d.params.response.status} ${u}`);
      }
    };
    await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Network.enable");

    let token = "";
    let r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "audit", password: "audit123456" }) });
    if (r.ok) token = (await r.json()).token;
    else {
      r = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "audit", password: "audit123456", email: "audit@sag.local" }) });
      if (r.ok) token = (await r.json()).token;
    }
    console.log(token ? "登录 ok" : "登录失败(继续匿名)");

    await cdp("Page.navigate", { url: BASE }); await sleep(2500);
    if (token) { await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)});`); await cdp("Page.reload"); await sleep(3000); }

    // 进实证研究视图
    await inject();
    const nav = await ev(`(async () => {
      clickByText('科研中心'); await new Promise(r=>setTimeout(r,900));
      const ok = clickByText('实证研究'); await new Promise(r=>setTimeout(r,3200));
      return ok;
    })()`);
    check("能进入「实证研究」视图", nav === true, String(nav));

    // 初始态: 未选中课题
    await inject();
    const initial = await ev(`(async () => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetWidth);
      const sel = btns.find(b => /选择课题|▾/.test(b.innerText||'') && (b.innerText||'').length < 40);
      return { header: sel ? sel.innerText.replace(/\\s+/g,' ').trim() : '(未找到课题按钮)', body: mainText() };
    })()`);
    console.log("\n--- 初始态(未选课题) ---\n" + JSON.stringify({ header: initial?.header, len: (initial?.body||"").length }, null, 1));
    check("初始显示「选择课题」(不再自动选第一个)", /选择课题/.test(initial?.header ?? ""), initial?.header);
    check("未选课题时卡片仍在(不再凭空消失)", /课题流水线总览/.test(initial?.body ?? ""));
    check("空状态提示需先选课题", /先在右上角选择一个课题/.test(initial?.body ?? ""),
      (initial?.body ?? "").match(/.{0,10}先在右上角选择一个课题.{0,40}/)?.[0] ?? "(未匹配)");

    // 打开课题下拉: 看计数
    await inject();
    const menu = await ev(`(async () => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetWidth);
      const sel = btns.find(b => /选择课题/.test(b.innerText||''));
      sel.click(); await new Promise(r=>setTimeout(r,900));
      const panel = Array.from(document.querySelectorAll('div')).find(d => /课题列表\\(/.test(d.innerText||'') && d.offsetWidth && d.innerText.length < 1200);
      const opts = panel ? Array.from(panel.querySelectorAll('button')).map(b => (b.innerText||'').replace(/\\s+/g,' ').trim()).filter(t => t && !/^创建$/.test(t)) : [];
      return { panelText: panel ? panel.innerText.replace(/\\s+/g,' ').slice(0,400) : '(未找到面板)', opts };
    })()`);
    console.log("\n--- 课题下拉 ---\n" + JSON.stringify(menu, null, 1).slice(0, 1100));
    check("下拉提示切换会更换流水线上下文", /切换将更换整条流水线上下文/.test(menu?.panelText ?? ""));
    const loveOpt = (menu?.opts ?? []).find((t) => /婚恋观/.test(t));
    check("婚恋观课题项带计数", !!loveOpt && /📋\s*1\s*·\s*🗄\s*1\s*·\s*⚗️\s*0/.test(loveOpt), loveOpt);

    // 点选婚恋观课题
    await inject();
    const afterSelect = await ev(`(async () => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetWidth);
      const el = btns.find(b => /新时代高校硕士研究生婚恋观现状调查/.test(b.innerText||'') && (b.innerText||'').length < 200);
      if (!el) return { clicked:false };
      el.click(); await new Promise(r=>setTimeout(r,3500));
      return { clicked:true, body: mainText() };
    })()`);
    check("能点选「婚恋观」课题", afterSelect?.clicked === true);
    const body = afterSelect?.body ?? "";
    console.log("\n--- 选中婚后 ---\n" + body.slice(0, 1000));
    check("切换提示点名了课题", /已切换到课题「新时代高校硕士研究生婚恋观现状调查」/.test(body),
      body.match(/已切换到课题.{0,40}/)?.[0] ?? "(未匹配)");
    check("流水线总览仍在(未消失)", /课题流水线总览/.test(body));
    // 真实空课题才能走到"空状态点名当前课题"分支(婚恋观有问卷有数据, hasData=true)。
    // 建一个临时课题 → 选中 → 断言文案 → 结束后连行删除(它没有任何依赖数据)
    const tmpTitle = "验证用临时空课题(可删)";
    const cr = await fetch(`${BASE}/api/empirical/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: tmpTitle }) });
    tmpProjectId = (await cr.json())?.project?.id ?? "";
    check("创建临时空课题", !!tmpProjectId, tmpProjectId);
    // 课题是 Node 侧调 API 建的, React 的 projects state 还是旧的 → 刷新页面让它出现
    await cdp("Page.reload"); await sleep(3200);
    await inject();
    await ev(`(async () => { clickByText('科研中心'); await new Promise(r=>setTimeout(r,900)); clickByText('实证研究'); await new Promise(r=>setTimeout(r,3200)); })()`);
    await inject();
    const emptyCase = await ev(`(async () => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetWidth);
      const sel = btns.find(b => /▾/.test(b.innerText||'') && (b.innerText||'').length < 40);
      sel.click(); await new Promise(r=>setTimeout(r,800));
      const el = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').includes(${JSON.stringify(tmpTitle)}));
      if (!el) return { clicked:false };
      el.click(); await new Promise(r=>setTimeout(r,3000));
      return { clicked:true, body: mainText() };
    })()`);
    const eb = emptyCase?.body ?? "";
    check("空课题: 卡片仍在且点名当前课题", eb.includes(`当前课题「${tmpTitle}」暂无流水线产出`),
      eb.match(/当前课题.{0,70}/)?.[0] ?? "(未匹配)");
    check("空课题: 提示分析只在选中课题下汇总", /在本课题下依次做/.test(eb));

    console.log("\n===== JS/console errors =====");
    console.log(errors.slice(0, 15).join("\n---\n") || "(none)");
    const failed = results.filter((x) => !x.pass);
    console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} 通过 =====`);
    if (errors.length) console.log(`注意: 捕获到 ${errors.length} 条 console/JS error`);
  } finally {
    // 清掉临时课题(我自己建的, 无依赖数据)
    if (tmpProjectId) {
      try {
        const pg = (await import("pg")).default;
        const url = (await import("node:fs")).readFileSync(".env", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].trim();
        const c = new pg.Client({ connectionString: url }); await c.connect();
        const d = await c.query("delete from empirical_projects where id = $1 and title = $2", [tmpProjectId, "验证用临时空课题(可删)"]);
        console.log(`
清理临时课题: 删除 ${d.rowCount} 行`);
        await c.end();
      } catch (e) { console.log("清理临时课题失败(需手动删): " + tmpProjectId + " — " + e.message); }
    }
    try { ws?.close(); } catch { }
    edge.kill();
    setTimeout(() => rmSync(userData, { recursive: true, force: true }), 800);
  }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
