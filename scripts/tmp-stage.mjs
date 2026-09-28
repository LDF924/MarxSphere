import { startCdp, loginToken, sleep, evalTop, clickOnPage } from "./lib/cdp-editor.mjs";
import { openSoc } from "./lib/probe-actions.mjs";
const BASE = "http://127.0.0.1:4173";
const token = await loginToken();
const { cdp, close } = await startCdp({ preferredPort: 9440, label: "stage" });
try {
  await openSoc(cdp, BASE, "/workbench/quick", token, "", 9000);
  await evalTop(cdp, `(() => { document.querySelectorAll('.assistant-close,.modal-x').forEach(b=>b.click()); return true; })()`);
  await sleep(800);
  // 切到"按研究阶段"
  const ok = await evalTop(cdp, `(() => { const b=[...document.querySelectorAll('.palette-mode')].find(x=>x.innerText.includes('阶段')); if(!b) return 'NO_BTN'; b.click(); return 'clicked'; })()`);
  console.log("切换视图:", ok);
  await sleep(900);
  console.log(await evalTop(cdp, `(() => {
    const blocks = [...document.querySelectorAll('.stage-block')];
    const states = blocks.map(b => ({
      阶段: (b.querySelector('.stage-head strong')?.innerText||'').trim(),
      步骤数: b.querySelectorAll('.stage-step').length,
      可跑: b.querySelectorAll('[data-run-step]').length,
      去页面: b.querySelectorAll('.ss-go').length,
    }));
    return JSON.stringify({ 阶段数: blocks.length, states }, null, 1);
  })()`));
  // 单跑一步
  const r = await evalTop(cdp, `(() => { const b=document.querySelector('[data-run-step]'); if(!b) return 'NO_RUN_BTN'; b.click(); return 'clicked'; })()`);
  console.log("点第一个「跑」:", r);
  await sleep(4000);
  console.log("运行状态:", await evalTop(cdp, `(() => {
    const s=document.querySelector('.state-chip'); const msgs=[...document.querySelectorAll('.msg-text,.chat-msg')].slice(-2).map(x=>(x.innerText||'').slice(0,40));
    return JSON.stringify({ 状态: (s?.innerText||'').trim(), 最近消息: msgs });
  })()`));
} finally { try { close(); } catch {} }
process.exit(0);
