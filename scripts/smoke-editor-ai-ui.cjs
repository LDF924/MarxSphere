// 最终 UI 实测: 打开已有文档 → AI 面板 14 按钮逐一点击 → 校验结果卡内容; 模型下拉切换
// 关键: 必须先真正打开文档(否则按钮按设计早退)
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const STATE = `(() => {
  const app = document.querySelector('#app').__vue_app__;
  const st = app.config.globalProperties.$pinia.state.value;
  const ai = st['editor-ai'] || {}; const doc = st['document'] || {};
  const c = document.querySelector('.ade-result-card');
  return JSON.stringify({
    docId: doc.currentDocument ? doc.currentDocument.id : null,
    st: ai.lastJobStatus, busy: !!ai.isLoading, sl: (ai.streamingContent||'').length,
    cards: document.querySelectorAll('.ade-result-card').length,
    head: c ? c.querySelector('.ade-result-card__header').innerText.trim() : '',
    txt: c ? c.querySelector('.ade-result-card__content').innerText.replace(/\\s+/g,' ').slice(0,70) : ''
  });
})()`;

const TABS = [
  { tab: "全文检查", buttons: ["全文逻辑检查", "章节衔接检查", "变量-方法-结论一致性", "投稿前检查"] },
  { tab: "选区修改", buttons: ["学术润色", "减少模板化表达", "压缩冗余", "扩展论证", "校对标点"], sel: true },
  { tab: "题名摘要", buttons: ["优化论文标题", "优化摘要", "提取关键词"] },
  { tab: "引用格式", buttons: ["引用一致性检查", "格式与语言检查"] },
];

const clickCard = async (send, label) => {
  const box = await ev(send, `(() => {
    const b = [...document.querySelectorAll('.ade-task-card')].find(e => (e.textContent||'').includes(${JSON.stringify(label)}));
    if (!b) return '';
    if (b.disabled) return 'DISABLED';
    const r = b.getBoundingClientRect();
    window.__bx = r.x + r.width/2; window.__by = r.y + r.height/2;
    return 'OK';
  })()`);
  if (box !== "OK") return box;
  const p = JSON.parse(await ev(send, `JSON.stringify({x:window.__bx,y:window.__by})`));
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
  return "CLICKED";
};

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("/soc/"));
  const { ws, send } = await connect(page.webSocketDebuggerUrl);
  await send("Runtime.enable"); await send("Page.enable");
  await ev(send, `localStorage.setItem('skf_auth_token', ${JSON.stringify(TOKEN)}); 'ok'`);
  await send("Page.navigate", { url: "http://localhost:4173/soc/index.html#/editor" });
  await sleep(700); await send("Page.reload", { ignoreCache: true }); await sleep(7000);

  const out = {};
  // 打开文档: 点文档列表第一项(标题是文本节点, 点它最近的 li/可点容器)
  out.open = await ev(send, `(() => {
    const rail = document.querySelector('.ade-sidebar') || document.body;
    const els = [...rail.querySelectorAll('*')].filter(e => /AI助手实测文档/.test(e.textContent||'') && e.offsetParent);
    if (!els.length) return 'NOTFOUND';
    let t = els[els.length - 1];
    for (let i=0; i<4 && t; i++) { if (t.className && String(t.className).match(/item|card|row|doc/i)) break; t = t.parentElement; }
    if (t) { t.click(); return 'clicked:' + String(t.className).slice(0,40); }
    return 'noclick';
  })()`);
  await sleep(5000);
  out.state0 = await ev(send, STATE);
  console.log("opened:", out.open, " state:", out.state0);

  // 写入新正文(确保内容充分)
  await ev(send, `(() => { const el=document.querySelector('.ProseMirror'); el.focus(); const s=getSelection(); s.removeAllRanges(); const r=document.createRange(); r.selectNodeContents(el); r.collapse(false); s.addRange(r); return 'ok'; })()`);
  for (const line of ["补充: 本文进一步检验了数字经济的机制路径与区域异质性。", "参考文献补充如下。", "[3] 王五. 数字鸿沟研究[J]. 管理世界, 2020(8)."]) {
    await send("Input.insertText", { text: line });
    await send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
  }
  await sleep(3500);

  if (!(await ev(send, `!!document.querySelector('.ade-ai-panel')`))) {
    await ev(send, `(() => { const b=[...document.querySelectorAll('button')].find(e=>(e.textContent||'').includes('辅助工具')); b.click(); return 'ok'; })()`);
    await sleep(1500);
  }
  out.gate = await ev(send, `(() => { const n=document.querySelector('.ade-ai-panel__notice'); return n?n.textContent.trim():'(none)'; })()`);
  console.log("gate:", out.gate);

  const results = [];
  for (const t of TABS) {
    await ev(send, `(() => { const b=[...document.querySelectorAll('.ade-ai-panel__tab')].find(e=>(e.textContent||'').trim()===${JSON.stringify(t.tab)}); if(b) b.click(); return 'ok'; })()`);
    await sleep(900);
    for (const btn of t.buttons) {
      // resultTitle 在点击时同步更新, 故轮询以 head===btn 判定本轮结果
      if (t.sel) {
        await ev(send, `(() => {
          const el=document.querySelector('.ProseMirror'); el.focus();
          const ps=[...el.querySelectorAll('p')].filter(p=>(p.textContent||'').trim().length>8);
          if (ps.length<2) return 'fewp';
          const a=ps[0], b=ps[1];
          const r=document.createRange(); r.setStart(a.firstChild,0); r.setEnd(b.firstChild, Math.min(30,(b.textContent||'').length));
          const s=getSelection(); s.removeAllRanges(); s.addRange(r);
          document.dispatchEvent(new Event('selectionchange'));
          return 'ok';
        })()`);
        await sleep(1200);
      }
      const clicked = await clickCard(send, btn);
      // 等本轮: 点击后 resultTitle 同步=btn; 等 busy 起跑→结束, 且 header 仍是本按钮
      let st = null, waited = 0, sawBusy = false;
      while (waited < 120000) {
        await sleep(1000); waited += 1000;
        st = JSON.parse(await ev(send, STATE));
        if (st.busy) { sawBusy = true; continue; }
        // sawBusy 后再等结束; 若结果已就绪(header 匹配且有正文)则收工
        if (st.head === btn && st.txt) break;
        // 兜底: 完成但 header 不匹配(前一轮残留), 继续等到超时
      }
      const rec = { tab: t.tab, button: btn, clicked, sawBusy, chars: (st.txt || "").replace(/\s/g, "").length, head: st.head, sample: (st.txt || "").slice(0, 60) };
      results.push(rec);
      console.log(`${clicked === "CLICKED" && rec.chars > 0 ? "PASS" : "FAIL"} ${t.tab}/${btn} [${clicked}] head="${rec.head}" chars=${rec.chars} :: ${rec.sample.slice(0,50)}`);
    }
  }
  out.results = results;

  // 模型下拉
  out.modelBefore = await ev(send, `(document.querySelector('#ade-ai-model')||{}).value`);
  await ev(send, `(() => { const s=document.querySelector('#ade-ai-model'); s.value='deepseek-v4-pro'; s.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; })()`);
  await sleep(2500);
  out.modelAfter = await ev(send, `(document.querySelector('#ade-ai-model')||{}).value`);
  out.serverModel = (await (await fetch("http://127.0.0.1:4173/api/editor/v1/ai/model", { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).current;
  await ev(send, `(() => { const s=document.querySelector('#ade-ai-model'); s.value='deepseek-v4-flash'; s.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; })()`);
  await sleep(2000);
  out.serverRestored = (await (await fetch("http://127.0.0.1:4173/api/editor/v1/ai/model", { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).current;

  const pass = results.filter((r) => r.chars > 0 && r.clicked === "CLICKED").length;
  console.log(`\n模型: ${JSON.stringify({ before: out.modelBefore, after: out.modelAfter, server: out.serverModel, restored: out.serverRestored })}`);
  console.log(`═══ UI 层 ${pass}/${results.length} PASS ═══`);
  require("fs").writeFileSync(".smoke-ui.json", JSON.stringify(out, null, 1));
  ws.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
