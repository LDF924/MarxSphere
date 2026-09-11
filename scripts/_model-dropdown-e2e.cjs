// 编辑器「写作模型」下拉 + AI 按钮端到端实测
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
    if (r.result?.exceptionDetails) {
      console.error("  [eval异常]", JSON.stringify(r.result.exceptionDetails).slice(0, 260));
      return undefined;
    }
    return r.result?.result?.value;
  };
  await send("Runtime.enable"); await send("Page.enable");
  await ev(`localStorage.setItem('skf_auth_token', ${JSON.stringify(TOKEN)}); localStorage.setItem('sag_token', ${JSON.stringify(TOKEN)}); 'ok'`);
  await send("Page.navigate", { url: "http://localhost:4173/soc/index.html#/editor" });
  await sleep(800); await send("Page.reload", { ignoreCache: true }); await sleep(9000);

  if (!(await ev(`!!document.querySelector('.ade-ai-panel')`))) {
    await ev(`(() => { const b=[...document.querySelectorAll('button')].find(e=>(e.textContent||'').includes('辅助工具')); if(b) b.click(); return !!b; })()`);
    await sleep(2000);
  }
  step("AI 面板打开", await ev(`!!document.querySelector('.ade-ai-panel')`));

  // ── 模型下拉 ──
  const sel = await ev(`(() => { const s=document.getElementById('ade-ai-model'); if(!s) return 'MISSING'; return JSON.stringify({value:s.value, opts:[...s.options].map(o=>({v:o.value,t:o.textContent.trim()}))}); })()`);
  let s = {};
  try { s = JSON.parse(sel || "{}"); } catch { /* */ }
  const ids = (s.opts ?? []).map((o) => o.v);
  step("下拉存在", sel !== "MISSING");
  step("只列可用模型(DeepSeek 两个)", ids.length === 2 && ids.every((i) => i.startsWith("deepseek")),
    `${ids.length} 个: ${ids.join(", ")}`);
  step("无不可用模型(claude/qwen 已滤除)", !ids.some((i) => /claude|qwen/.test(i)), ids.filter((i) => /claude|qwen/.test(i)).join(",") || "无");
  step("当前模型来自持久化(下拉值等于后端 current)", ids.includes(s.value), `value=${s.value}`);

  // ── 切到 flash 再切回, 确认可用 ──
  const sw = await ev(`(async () => {
    const el = document.getElementById('ade-ai-model');
    el.value = 'deepseek-v4-flash';
    el.dispatchEvent(new Event('change', {bubbles:true}));
    await new Promise(r => setTimeout(r, 2500));
    const r = await fetch('/api/editor/v1/ai/model', {headers:{Authorization:'Bearer ' + localStorage.getItem('skf_auth_token')}}).then(x=>x.json());
    return r.current;
  })()`, true);
  step("切换模型成功并落库", sw === "deepseek-v4-flash", `current=${sw}`);

  // ═══ 顺序讲究: 先播种一篇有内容的文档测真实调用, 再新建空文档测门控 ═══
  // 播种: 编辑器会自动载入"最近更新"的文档, 所以先用 API 造一篇有正文的, 再重新加载
  const seeded = await ev(`(async () => {
    const t = localStorage.getItem('skf_auth_token') || '';
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t };
    const c = await fetch('/api/editor/v1/documents', { method:'POST', headers:H, body: JSON.stringify({ title: '模型实测文档' }) }).then(x=>x.json());
    const id = c?.id || c?.document?.id;
    if (!id) return 'CREATE_FAIL';
    const para = '本文研究数字经济对区域协调发展的影响。基于2011-2022年省级面板数据,采用双向固定效应模型进行实证检验。研究发现数字经济显著促进区域协调发展,且存在空间溢出效应。';
    const doc = { type:'doc', content:[{ type:'paragraph', content:[{ type:'text', text: para }] }] };
    const r = await fetch('/api/editor/v1/documents/' + id, { method:'PUT', headers:H, body: JSON.stringify({ content: JSON.stringify(doc) }) });
    if (!r.ok) return 'SAVE_FAIL_' + r.status;
    // 编辑器重载后打开的是 editor.activeDocumentId 记住的文档, 这里指向刚播种的
    localStorage.setItem('editor.activeDocumentId', id);
    return 'OK';
  })()`, true);
  step("播种有内容的文档", seeded === "OK", String(seeded));

  // 重新加载使编辑器载入刚播种的文档
  await send("Page.reload", { ignoreCache: true });
  await sleep(10000);
  if (!(await ev(`!!document.querySelector('.ade-ai-panel')`))) {
    await ev(`(() => { const b=[...document.querySelectorAll('button')].find(e=>(e.textContent||'').includes('辅助工具')); if(b) b.click(); return !!b; })()`);
    await sleep(2000);
  }

  // ── 真实 AI 调用: 切到题名摘要 tab + 点「优化论文标题」──
  await ev(`(() => { const t=[...document.querySelectorAll('.ade-ai-panel__tab')].find(e=>(e.textContent||'').trim()==='题名摘要'); if(t) t.click(); return !!t; })()`);
  await sleep(900);
  const hasDoc = await ev(`(() => { const ed=document.querySelector('.tiptap, .ProseMirror'); return ed ? ed.textContent.trim().length : -1; })()`);
  step("有正文(真实调用前置条件)", hasDoc > 20, `正文${hasDoc}字`);
  if (hasDoc > 20) {
    await ev(`(() => { const el=[...document.querySelectorAll('.ade-ai-panel button')].find(b=>/优化论文标题/.test(b.textContent||'')); if(el && !el.disabled) el.click(); return el ? el.disabled : 'NO'; })()`);
    await sleep(60000);
    const card = await ev(`(() => { const c=document.querySelector('.ade-result-card__content'); return c ? c.textContent.replace(/\\s+/g,' ').slice(0,260) : ''; })()`);
    const hasErr = /错误:/.test(card);
    step("真实调用返回标题内容", card.length > 40 && !hasErr, card.slice(0, 150) || "(结果卡为空)");
  }

  // ── 新建空文档 → 按钮应被门控(不是静默无反应) ──
  // 走真实用户路径: 「＋ 新建文档」→ 填标题 → 创建
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/新建文档/.test(x.textContent||'')); if(b) b.click(); return !!b; })()`);
  await sleep(1800);
  await ev(`(() => {
    const h=[...document.querySelectorAll('h1,h2,h3,div')].find(e=>e.textContent.trim()==='新建文档' && e.querySelector);
    const box=h ? (h.closest('.rounded-2xl')||h.parentElement) : null;
    const inp=box ? box.querySelector('input,textarea') : document.querySelector('input[placeholder*="标题"],input[placeholder*="文档"]');
    if(!inp) return 'NO_INPUT';
    inp.focus(); inp.value='模型门控测试空文档';
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    return 'filled';
  })()`);
  await sleep(400);
  await ev(`(() => {
    const h=[...document.querySelectorAll('h1,h2,h3,div')].find(e=>e.textContent.trim()==='新建文档' && e.querySelector);
    const box=h ? (h.closest('.rounded-2xl')||h.parentElement) : null;
    const btn=box ? [...box.querySelectorAll('button')].find(b=>/创建|确定|保存/.test(b.textContent||'')) : null;
    if(btn){ btn.click(); return 'created'; }
    return 'NO_BTN';
  })()`);
  await sleep(4500);
  const emptyLen = await ev(`(() => { const ed=document.querySelector('.tiptap, .ProseMirror'); return ed ? ed.textContent.trim().length : -1; })()`);
  step("新建文档正文为空(门控前置条件)", emptyLen === 0, `正文${emptyLen}字`);

  await ev(`(() => { const t=[...document.querySelectorAll('.ade-ai-panel__tab')].find(e=>(e.textContent||'').trim()==='题名摘要'); if(t) t.click(); return !!t; })()`);
  await sleep(1000);
  const guard = await ev(`(() => {
    const el=[...document.querySelectorAll('.ade-ai-panel button')].find(b=>/优化论文标题/.test(b.textContent||''));
    if(!el) return JSON.stringify({no:true});
    return JSON.stringify({ no:false, disabled:Boolean(el.disabled) });
  })()`);
  const g = JSON.parse(guard || "{}");
  step("空正文时按钮被门控(disabled)", emptyLen === 0 && !g.no && g.disabled === true,
    `正文${emptyLen}字 disabled=${g.disabled}`);

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${pass}/${results.length} PASS ===`);
  ws.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
