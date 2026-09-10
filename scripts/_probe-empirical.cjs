// 探测实证研究视图 DOM, 供跨 iframe 链路实测
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
const ev = async (send, expression, awaitPromise = false) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("4173") && !t.url.includes("/soc/"));
  if (!page) { console.log("页面列表:", list.filter(t=>t.type==="page").map(t=>t.url)); throw new Error("找不到主应用页"); }
  const { ws, send } = await connect(page.webSocketDebuggerUrl);
  await send("Runtime.enable"); await send("Page.enable");
  await ev(send, `localStorage.setItem('sag_token', ${JSON.stringify(TOKEN)}); localStorage.setItem('skf_auth_token', ${JSON.stringify(TOKEN)}); 'ok'`);
  await send("Page.navigate", { url: "http://localhost:4173/?view=empirical-research" });
  await sleep(800); await send("Page.reload", { ignoreCache: true }); await sleep(11000);
  console.log("URL:", await ev(send, `location.href`));
  console.log("按钮:", await ev(send, `JSON.stringify([...document.querySelectorAll('button')].map(b=>(b.textContent||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,40))`));
  console.log("iframes:", await ev(send, `JSON.stringify([...document.querySelectorAll('iframe')].map(f=>({t:f.title,src:(f.src||'').slice(-40)})))`));
  console.log("textarea:", await ev(send, `JSON.stringify([...document.querySelectorAll('textarea')].map(t=>(t.placeholder||'').slice(0,40)))`));
  ws.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
