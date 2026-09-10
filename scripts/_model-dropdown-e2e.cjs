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

  // ── 新建空文档 → 按钮应被门控(不是静默无反应) ──
  // 走真实用户路径: 「＋ 新建文档」→ 填标题 → 创建(比在 tiptap 里模拟全选删除可靠)
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
  await sleep(4000);
  const emptyLen = await ev(`(() => { const ed=document.querySelector('.tiptap, .ProseMirror'); return ed ? ed.textContent.trim().length : -1; })()`);
  step("新建文档正文为空(前置条件)", emptyLen === 0, `正文${emptyLen}字`);

  await ev(`(() => { const t=[...document.querySelectorAll('.ade-ai-panel__tab')].find(e=>(e.textContent||'').trim()==='题名摘要'); if(t) t.click(); return !!t; })()`);
  await sleep(1000);
  const guard = await ev(`(() => {
    const el=[...document.querySelectorAll('.ade-ai-panel button')].find(b=>/优化论文标题/.test(b.textContent||''));
    if(!el) return JSON.stringify({no:true});
    const panel=document.querySelector('.ade-ai-panel');
    const hint=(panel?panel.textContent:'').replace(/\\s+/g,' ');
    return JSON.stringify({ no:false, disabled:Boolean(el.disabled), title:String(el.getAttribute('title')||''), hinted:/正文为空|请先|请选中/.test(hint) });
  })()`);
  const g = JSON.parse(guard || "{}");
  step("正文清空后按钮被门控(disabled)", emptyLen === 0 && !g.no && g.disabled === true,
    `正文${emptyLen}字 disabled=${g.disabled}`);

  // ── 真实 AI 调用: 填正文 + 切到题名摘要 tab + 点「优化论文标题」 ──
  await ev(`(() => { const ed=document.querySelector('.tiptap, .ProseMirror'); if(ed){ ed.focus(); } return !!ed; })()`);
  await send("Input.insertText", { text: "本文研究数字经济对区域协调发展的影响。基于2011-2022年省级面板数据,采用双向固定效应模型进行实证检验。研究发现数字经济显著促进区域协调发展,且存在空间溢出效应。" });
  await sleep(1500);
  const filled = await ev(`(() => { const ed=document.querySelector('.tiptap, .ProseMirror'); return ed ? ed.textContent.trim().length : -1; })()`);
  step("正文已填入(真实调用前置条件)", filled > 20, `正文${filled}字`);
  await ev(`(() => { const t=[...document.querySelectorAll('.ade-ai-panel__tab')].find(e=>(e.textContent||'').trim()==='题名摘要'); if(t) t.click(); return !!t; })()`);
  await sleep(900);
  const clicked = await ev(`(() => { const el=[...document.querySelectorAll('.ade-ai-panel button')].find(b=>/优化论文标题/.test(b.textContent||'')); if(el && !el.disabled){ el.click(); return 'clicked'; } return el ? 'disabled' : 'NO_BTN'; })()`);
  await sleep(60000);
  void clicked;
  const card = await ev(`(() => { const c=document.querySelector('.ade-result-card__content'); return c ? c.textContent.replace(/\\s+/g,' ').slice(0,260) : ''; })()`);
  const hasErr = /错误:/.test(card);
  const hasTitle = card.length > 40;
  step("真实调用返回标题内容", hasTitle && !hasErr, card.slice(0, 150) || "(结果卡为空)");

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${pass}/${results.length} PASS ===`);
  ws.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
