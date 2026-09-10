const BASE = "http://127.0.0.1:9222";
const TOKEN = process.env.SAG_TOKEN || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect(u) {
  const ws = new WebSocket(u);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
  return { ws, send: (method, params = {}) => new Promise((res) => { const i = ++id; p.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }) };
}
const ev = async (s, e, a = false) => {
  const r = await s("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: a, userGesture: true });
  if (r.result?.exceptionDetails) return "EXC: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300);
  return r.result?.result?.value;
};
(async () => {
  const l = await (await fetch(`${BASE}/json/list`)).json();
  const pg = l.filter((t) => t.type === "page").find((t) => t.url.includes("4173"));
  const { ws, send } = await connect(pg.webSocketDebuggerUrl);
  await send("Runtime.enable"); await send("Page.enable");
  await ev(send, `localStorage.setItem('skf_auth_token', ${JSON.stringify(TOKEN)}); localStorage.setItem('sag_token', ${JSON.stringify(TOKEN)}); 'ok'`);
  await send("Page.navigate", { url: "http://localhost:4173/soc/index.html#/editor" });
  await sleep(800); await send("Page.reload", { ignoreCache: true }); await sleep(9000);
  if (!(await ev(send, `!!document.querySelector('.ade-ai-panel')`))) {
    await ev(send, `(() => { const b=[...document.querySelectorAll('button')].find(e=>(e.textContent||'').includes('辅助工具')); if(b) b.click(); return !!b; })()`);
    await sleep(2200);
  }
  console.log("面板存在:", await ev(send, `!!document.querySelector('.ade-ai-panel')`));
  console.log("\n所有 tab:", await ev(send, `JSON.stringify([...document.querySelectorAll('.ade-ai-panel__tab')].map(t=>t.textContent.trim()))`));
  console.log("\n面板内所有按钮文本:", await ev(send, `JSON.stringify([...document.querySelectorAll('.ade-ai-panel button')].map(b=>b.textContent.trim().slice(0,20)).filter(Boolean))`));
  console.log("\n当前激活 tab 的按钮:", await ev(send, `(() => { const tabs=[...document.querySelectorAll('.ade-ai-panel__tab')]; const act=tabs.find(t=>/active|is-active/.test(t.className)); return act ? act.textContent.trim() : '(未识别)'; })()`));
  const g = await ev(send, `(() => {
    const el=[...document.querySelectorAll('.ade-ai-panel button')].find(b=>/优化标题/.test(b.textContent||''));
    if(!el) return 'NO_BTN';
    return JSON.stringify({disabled:Boolean(el.disabled), title:String(el.getAttribute('title')||''), cls:String(el.className).slice(0,60)});
  })()`);
  console.log("\n优化标题按钮探测:", g);
  ws.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
