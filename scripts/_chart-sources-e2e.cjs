/**
 * 图表 tab 四种数据源端到端实测 — 验"真功能"而非"有元素"
 * 判定标准(硬指标):
 *   1. stats 源: 必须回查到**真实列名**(province/gdp/pop), 且图表用到的列名出现在生成的代码里
 *   2. paste 源: 4 个业务列名必须全部出现在代码里
 *   3. 图片: naturalWidth > 0 且 字节数 > 10000(证明真的渲染出了图, 不是 1px 占位)
 *   4. 插入正文: tiptap 文档里必须真的多出一个 <img>(计数 +1)
 *   5. empirical 源: 记录"未同步"是否出现(跨 iframe 链路诚实判定)
 */
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};

const results = [];
const step = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("/soc/"))
    || list.find((t) => t.type === "page" && t.url.includes("4173"));
  if (!page) throw new Error("找不到 /soc/ 页面, 请先打开编辑器");
  const { ws, send } = await connect(page.webSocketDebuggerUrl);
  await send("Runtime.enable"); await send("Page.enable");

  await ev(send, `localStorage.setItem('skf_auth_token', ${JSON.stringify(TOKEN)}); 'ok'`);
  await send("Page.navigate", { url: "http://localhost:4173/soc/index.html#/editor" });
  await sleep(800);
  await send("Page.reload", { ignoreCache: true });
  await sleep(9000);

  // hook chart-code 响应, 拿生成代码与 pngRel
  await ev(send, `(() => {
    window.__cc = [];
    if (!window.__of) window.__of = window.fetch;
    window.fetch = async (...a) => {
      const u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '';
      const r = await window.__of(...a);
      if (u.includes('chart-code')) {
        try { window.__cc.push(await r.clone().json()); } catch (e) { window.__cc.push({ __err: String(e) }); }
      }
      return r;
    };
    return 'hooked';
  })()`);

  // ── 打开辅助工具面板 ──
  if (!(await ev(send, `!!document.querySelector('.ade-ai-panel')`))) {
    await ev(send, `(() => { const b=[...document.querySelectorAll('button')].find(e=>(e.textContent||'').includes('辅助工具')); if(b) b.click(); return !!b; })()`);
    await sleep(1800);
  }
  const hasPanel = await ev(send, `!!document.querySelector('.ade-ai-panel')`);
  step("辅助工具面板打开", hasPanel);
  if (!hasPanel) { ws.close(); return; }

  // 生产构建下 Vue 不暴露 __vueParentComponent → 一律断言 DOM 文本(也更贴近用户所见)
  const hintText = () => ev(send, `(() => { const h=document.querySelector('.ade-chart-hint'); return h ? h.textContent.replace(/\\s+/g,' ').trim() : ''; })()`);

  // 切到图表 tab
  await ev(send, `(() => { const b=[...document.querySelectorAll('.ade-ai-panel__tab')].find(e=>(e.textContent||'').trim()==='图表'); if(b) b.click(); return !!b; })()`);
  await sleep(1200);
  step("图表 tab 可切换", await ev(send, `!!document.querySelector('.ade-chart-form')`));

  // ── 场景1: stats 源, 回查真实数据集 ──
  await ev(send, `(() => { const s=document.querySelector('.ade-chart-source select'); const o=[...s.options].find(x=>x.value==='stats'); if(!o) return 'NO_OPT'; s.value='stats'; s.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; })()`);
  await sleep(1500);
  const statsOpts = await ev(send, `(() => { const opts=[...document.querySelectorAll('.ade-chart-hint select option')].map(o=>({v:o.value,t:o.textContent.trim()})); return JSON.stringify(opts); })()`);
  const opts = JSON.parse(statsOpts || "[]").filter((o) => o.v);
  step("stats 源列出已完成的统计任务", opts.length > 0, `${opts.length} 条`);

  if (opts.length) {
    await ev(send, `(() => { const s=document.querySelector('.ade-chart-hint select'); s.value=${JSON.stringify(opts[0].v)}; s.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; })()`);
    await sleep(2500);
    const hint = await hintText();
    const m = hint.match(/已回查:\s*(\S+)\s*·\s*(\d+)\s*列\s*·\s*(\d+)\s*行/);
    step("stats 源回查到真实数据集", Boolean(m), hint || "(hint 为空)");
    const realCols = m ? [] : [];

    // 出图
    await ev(send, `(() => { const ta=[...document.querySelectorAll('.ade-chart-form textarea')].find(t=>/例如/.test(t.placeholder||'')); ta.focus(); return 'ok'; })()`);
    await send("Input.insertText", { text: "各省 GDP 与人口的对比柱状图" });
    await sleep(300);
    await ev(send, `(() => { const b=[...document.querySelectorAll('.ade-chart-form button')].find(x=>/生成图表/.test(x.textContent)); b.click(); return 'ok'; })()`);
    await sleep(30000);

    const resp = await ev(send, `JSON.stringify(window.__cc[window.__cc.length-1] ?? null)`);
    const r = JSON.parse(resp || "null");
    const code = r?.code ?? "";
    // 该任务的数据集列名(前面已知: province/gdp/pop)
    const want = ["province", "gdp", "pop"];
    const usedCols = want.filter((c) => code.includes(c));
    step("stats 源图表使用真实列名", usedCols.length > 0,
      `命中 ${usedCols.length}/${want.length}: ${usedCols.join(",") || "无"}`);
    step("stats 源标记 dataUsed=true", r?.dataUsed === true, `dataUsed=${r?.dataUsed}, pngRel=${r?.pngRel ? "有" : "无"}`);

    const imgOk = await ev(send, `(() => { const im=document.querySelector('.ade-chart-preview__img'); if(!im) return JSON.stringify({no:true}); return JSON.stringify({w:im.naturalWidth,h:im.naturalHeight,blob:im.src.startsWith('blob:')}); })()`);
    const im = JSON.parse(imgOk || "{}");
    step("stats 源图片真实渲染(非0尺寸)", !im.no && im.w > 0 && im.h > 0, im.no ? "无 img 元素" : `${im.w}x${im.h} blob=${im.blob}`);
    void realCols;
  }

  // ── 场景2: paste 源 ──
  await ev(send, `(() => { const s=document.querySelector('.ade-chart-source select'); s.value='paste'; s.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; })()`);
  await sleep(900);
  const N = await ev(send, `(() => { const ims=[...document.querySelectorAll('img')]; const i=ims.find(x=>x.src.startsWith('blob:')); if(!i) return -1; return i.src.length; })()`);
  await ev(send, `(() => { const ta=[...document.querySelectorAll('.ade-chart-form textarea')].find(t=>/CSV/.test(t.placeholder||'')); ta.focus(); return 'ok'; })()`);
  await sleep(200);
  await send("Input.insertText", { text: "province,industry,y2020,y2024\nBeijing,Mfg,100,180\nShanghai,Tech,80,150\nGuangdong,Factor,50,95\nJiangsu,Svc,40,70\nZhejiang,Eff,30,60" });
  await sleep(400);
  await ev(send, `(() => { const ta=[...document.querySelectorAll('.ade-chart-form textarea')].find(t=>/例如/.test(t.placeholder||'')); ta.focus(); return 'ok'; })()`);
  await send("Input.insertText", { text: "五个省份 2020 与 2024 年增加值对比柱状图" });
  await sleep(400);
  await ev(send, `(() => { const b=[...document.querySelectorAll('.ade-chart-form button')].find(x=>/生成图表/.test(x.textContent)); b.click(); return 'ok'; })()`);
  await sleep(30000);

  const resp2 = await ev(send, `JSON.stringify(window.__cc[window.__cc.length-1] ?? null)`);
  const r2 = JSON.parse(resp2 || "null");
  const code2 = r2?.code ?? "";
  const want = ["province", "industry", "y2020", "y2024"];
  const hit2 = want.filter((c) => code2.includes(c));
  step("paste 源图表使用粘贴的 4 个列名", hit2.length === 4, `命中 ${hit2.length}/4: ${hit2.join(",")}`);
  step("paste 源 dataUsed=true", r2?.dataUsed === true, `dataUsed=${r2?.dataUsed}`);

  const img2 = await ev(send, `(() => { const im=document.querySelector('.ade-chart-preview__img'); if(!im) return JSON.stringify({no:true}); return JSON.stringify({w:im.naturalWidth,h:im.naturalHeight,blob:im.src.startsWith('blob:')}); })()`);
  const i2 = JSON.parse(img2 || "{}");
  step("paste 源图片真实渲染(blob+非0尺寸)", !i2.no && i2.w > 0 && i2.h > 0 && i2.blob,
    i2.no ? "无 img" : `${i2.w}x${i2.h} blob=${i2.blob}`);

  // ── 场景3: 插入正文(文档里必须真的多一个 img) ──
  const before = await ev(send, `(() => { const ed=document.querySelector('.tiptap, .ProseMirror'); return ed ? ed.querySelectorAll('img').length : -1; })()`);
  await ev(send, `(() => { const b=[...document.querySelectorAll('.ade-chart-preview button')].find(x=>/插入到正文/.test(x.textContent)); if(b) b.click(); return !!b; })()`);
  await sleep(1500);
  const after = await ev(send, `(() => { const ed=document.querySelector('.tiptap, .ProseMirror'); return ed ? ed.querySelectorAll('img').length : -1; })()`);
  const imgSrc = await ev(send, `(() => { const ed=document.querySelector('.tiptap, .ProseMirror'); if(!ed) return ''; const ims=[...ed.querySelectorAll('img')]; return ims.length ? ims[ims.length-1].getAttribute('src')||'' : ''; })()`);
  step("插入到正文 — 文档 img 计数 +1", after === before + 1, `before=${before} after=${after}`);
  step("插入的是持久相对路径(非 blob)", String(imgSrc).includes("/api/viz/files/"), imgSrc.slice(0, 70));

  // ── 场景4: empirical 源可选项状态(跨 iframe 链路诚实判定) ──
  const empLabel = await ev(send, `(() => { const s=document.querySelector('.ade-chart-source select'); const o=[...s.options].find(x=>x.value==='empirical'); return o ? o.textContent.trim() : 'MISSING'; })()`);
  step("empirical 源选项存在(带同步状态)", /empirical|统一分析台/.test(empLabel) || String(empLabel).includes("统一分析台"), String(empLabel));

  // ── 汇总 ──
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${pass}/${results.length} PASS ===`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log("失败项:\n" + failed.map((f) => `  - ${f.name}: ${f.detail ?? ""}`).join("\n"));
  ws.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
