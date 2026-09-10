// ④ 成果可视化工坊产物 → 编辑器插图 端到端实测
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
const results = [];
const step = (n, ok, d) => { results.push({ n, ok, d }); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };

(async () => {
  const l = await (await fetch(`${BASE}/json/list`)).json();
  const pg = l.filter((t) => t.type === "page").find((t) => t.url.includes("4173"));
  const { ws, send } = await connect(pg.webSocketDebuggerUrl);
  const ev = async (expression, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise, userGesture: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  await send("Runtime.enable"); await send("Page.enable");
  await ev(`localStorage.setItem('skf_auth_token', ${JSON.stringify(TOKEN)}); localStorage.setItem('sag_token', ${JSON.stringify(TOKEN)}); 'ok'`);
  await send("Page.navigate", { url: "http://localhost:4173/soc/index.html#/editor" });
  await sleep(800); await send("Page.reload", { ignoreCache: true }); await sleep(9000);

  if (!(await ev(`!!document.querySelector('.ade-ai-panel')`))) {
    await ev(`(() => { const b=[...document.querySelectorAll('button')].find(e=>(e.textContent||'').includes('辅助工具')); if(b) b.click(); return !!b; })()`);
    await sleep(1800);
  }
  step("编辑器面板打开", await ev(`!!document.querySelector('.ade-ai-panel')`));

  await ev(`(() => { const b=[...document.querySelectorAll('.ade-ai-panel__tab')].find(e=>(e.textContent||'').trim()==='图表'); if(b) b.click(); return !!b; })()`);
  await sleep(1200);

  // 选工坊源
  await ev(`(() => { const s=document.querySelector('.ade-chart-source select'); s.value='workshop'; s.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; })()`);
  await sleep(1800);
  const opts = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.ade-chart-hint select option')].map(o=>({v:o.value,t:o.textContent.trim()})))`) || "[]").filter((o) => o.v);
  step("工坊产物列表可读", opts.length > 0, `${opts.length} 条: ${opts.map(o=>o.t.slice(0,22)).join(" | ")}`);

  if (opts.length) {
    await ev(`(() => { const s=document.querySelector('.ade-chart-hint select'); s.value=${JSON.stringify(opts[0].v)}; s.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; })()`);
    await sleep(3500);
    const img = JSON.parse(await ev(`(() => { const im=document.querySelector('.ade-chart-preview__img'); if(!im) return JSON.stringify({no:true}); return JSON.stringify({w:im.naturalWidth,h:im.naturalHeight,blob:im.src.startsWith('blob:')}); })()`) || "{}");
    step("工坊产物图片真实显示", !img.no && img.w > 0 && img.h > 0, img.no ? "无 img" : `${img.w}x${img.h} blob=${img.blob}`);

    // 新建一个干净文档插入, 便于计数
    const before = await ev(`(() => { const ed=document.querySelector('.tiptap, .ProseMirror'); return ed ? ed.querySelectorAll('img').length : -1; })()`);
    await ev(`(() => { const b=[...document.querySelectorAll('.ade-chart-preview button')].find(x=>/插入到正文/.test(x.textContent)); if(b) b.click(); return !!b; })()`);
    await sleep(1600);
    const after = await ev(`(() => { const ed=document.querySelector('.tiptap, .ProseMirror'); return ed ? ed.querySelectorAll('img').length : -1; })()`);
    const src = await ev(`(() => { const ed=document.querySelector('.tiptap, .ProseMirror'); if(!ed) return ''; const ims=[...ed.querySelectorAll('img')]; return ims.length?ims[ims.length-1].getAttribute('src')||'':''; })()`);
    step("工坊产物插入正文", after === before + 1, `before=${before} after=${after}`);
    step("存的是持久化相对路径", String(src).includes("/api/viz/files/"), String(src).slice(0, 72));

    // SVG 下载链接可用性
    const svgLink = await ev(`!!document.querySelector('.ade-chart-preview__svg')`);
    step("矢量 SVG 下载入口出现", svgLink === true);
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${pass}/${results.length} PASS ===`);
  ws.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
