// scripts/probe-review-reset.mjs — 审稿台「新建审稿」整条流 + 「重置能否清干净界面」
//
// 为什么单开一条: 「＋ 新建审稿」是 2026-09-18 按闭源 `review_new_review` 补的入口,
//   当时**只验了渲染**(按钮在不在), 没跑"确认层 → 清空"这条流。一跑就现形 ——
//   见下面那条注释: 点了确认, 正文一个字都没少。
//
// 覆盖:
//   ① 空白页点新建**不弹**确认层(不打断用户)
//   ② 粘正文 → 点新建 → 弹确认层, 且文案与闭源逐字一致
//   ③ 点「取消」→ 正文原样保留(这才是确认存在的意义)
//   ④ 点「新建」→ 状态真被清空(正文 0 字 + 提交键回禁用)
//   ⑤ 「重置」类操作**不重挂载组件**时, 界面那份副本也要跟着清
//      —— ④ 修的就是这条路径的机制; 这里单列, 是因为另一个入口(删除当前任务)
//         走的是同一个 store.resetPaper() 且同样不重挂载, 容易只修一处
//
// 用法: node scripts/probe-review-reset.mjs   (需 4173 已起)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, probeAction } from "./lib/probe-actions.mjs";

const rows = [];
function rec(action, kind, detail) {
  rows.push({ action, kind, detail });
  const tag = kind === "ok" ? "  ok  " : kind === "dead" ? " DEAD " : kind === "err" ? " ERR  " : " skip ";
  console.log(`${tag} ${action} — ${detail}`);
}

const PAPER = "数字经济背景下中小企业融资约束的实证研究。".repeat(8);

/**
 * 弹层文本的**正确取法**。
 *
 * ⚠ 第一版取了 `overlay.parentElement` —— 那是整个页面, 于是"文案对齐"这条**永远判对**(假通过)。
 *   overlay(确认键往上第一个 position:fixed 的祖先)才是这个弹层的文本边界。
 */
const OVERLAY_TEXT = `(() => {
  const ok = document.querySelector('[data-control="dialog:confirm"]');
  if (!ok) return null;
  let card = ok.closest('div');
  while (card && getComputedStyle(card).position !== 'fixed') card = card.parentElement;
  return card ? card.innerText.replace(/\s+/g, ' ').trim() : '';
})()`;

const { cdp, close } = await startCdp({ preferredPort: 31091, label: "probe-review-reset" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");
  await openSoc(cdp, "http://127.0.0.1:4173", "/review", token, undefined, 7000);

  // ① 空白页不打断
  await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="review:new"]'); if (b) b.click(); return true; })()`);
  await sleep(900);
  const blank = await evalTop(cdp, `!!document.querySelector('[data-control="dialog:confirm"]')`);
  rec("空白页点新建不弹确认层", blank === false ? "ok" : "err", `确认层出现=${blank}(应为 false)`);

  // ② 粘正文(真实 input 事件, 走 v-model)
  const typed = await evalTop(cdp, `(() => {
    const ta = document.querySelector('.paste-area');
    if (!ta) return -1;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(PAPER)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value.length;
  })()`);
  await sleep(900);
  const filled = await evalTop(cdp, `(() => ({
    hint: document.querySelector('.input-hint')?.textContent.trim(),
    submitDisabled: document.querySelector('[data-control="review:submit"]')?.disabled,
  }))()`);
  rec("粘入正文并解锁提交", typed === PAPER.length && filled?.submitDisabled === false ? "ok" : "err",
    `字数=${typed}/${PAPER.length} 提示="${filled?.hint}" 提交键禁用=${filled?.submitDisabled}`);

  // ③ 有内容 → 确认层 + 文案逐字对齐闭源
  await probeAction(cdp, '[data-control="review:new"]', { wait: 1500 });
  const txt = await evalTop(cdp, OVERLAY_TEXT);
  const exact = typeof txt === "string" && txt.includes("开始新的审稿") && txt.includes("当前审稿状态将清除") && txt.includes("新建审稿");
  rec("确认层出现且文案逐字对齐闭源", exact ? "ok" : "err", `弹层文本="${String(txt).slice(0, 66)}"`);

  // ④ 取消 → 正文保留
  await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="dialog:cancel"]'); if (b) b.click(); return true; })()`);
  await sleep(1000);
  const afterCancel = await evalTop(cdp, `(() => ({
    len: document.querySelector('.paste-area')?.value.length ?? -1,
    gone: !document.querySelector('[data-control="dialog:confirm"]'),
  }))()`);
  rec("点取消 ▸ 正文原样保留", afterCancel?.len === PAPER.length && afterCancel?.gone ? "ok" : "err",
    `字数=${afterCancel?.len}(应 ${PAPER.length}) 层已关=${afterCancel?.gone}`);

  // ⑤ 确认 → 真清空(本轮修的缺陷)
  await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="review:new"]'); if (b) b.click(); return true; })()`);
  await sleep(1200);
  await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="dialog:confirm"]'); if (b) b.click(); return true; })()`);
  await sleep(1200);
  const afterOk = await evalTop(cdp, `(() => ({
    len: document.querySelector('.paste-area')?.value.length ?? -1,
    hint: document.querySelector('.input-hint')?.textContent.trim(),
    submitDisabled: document.querySelector('[data-control="review:submit"]')?.disabled,
  }))()`);
  rec("点新建 ▸ 状态真被清空", afterOk?.len === 0 && afterOk?.submitDisabled === true ? "ok" : "err",
    `正文字数=${afterOk?.len}(应 0) 提示="${afterOk?.hint}" 提交键禁用=${afterOk?.submitDisabled}`);

  // ⑥ 机制层: 不重挂载组件时, store.resetPaper() 也要能让界面清零
  //    —— 「删除当前任务」入口走的就是这条(从结果页退回输入页, 组件不重挂载)
  await evalTop(cdp, `(() => {
    const ta = document.querySelector('.paste-area');
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    s.call(ta, ${JSON.stringify(PAPER)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return 1;
  })()`);
  await sleep(900);
  const before = await evalTop(cdp, `document.querySelector('.paste-area')?.value.length ?? -1`);
  const storeBefore = await evalTop(cdp, `(() => {
    const p = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    const st = p._s.get('review');
    const n = st.paperContent.length;
    st.resetPaper();
    return n;
  })()`);
  await sleep(900);
  const mech = await evalTop(cdp, `(() => ({
    len: document.querySelector('.paste-area')?.value.length ?? -1,
    submitDisabled: document.querySelector('[data-control="review:submit"]')?.disabled,
  }))()`);
  rec("不重挂载时 resetPaper 也清界面", before > 0 && storeBefore > 0 && mech?.len === 0 && mech?.submitDisabled === true ? "ok" : "err",
    `填 ${before} 字(store=${storeBefore}) → resetPaper → 文本框 ${mech?.len} 字, 提交键禁用=${mech?.submitDisabled}`);

  console.log("\n════════ 汇总 ════════");
  for (const x of rows) console.log(`${x.kind.padEnd(6)} ${x.action}`);
  const bad = rows.filter((x) => x.kind === "err" || x.kind === "dead");
  console.log(bad.length ? `\n❌ ${bad.length} 项异常` : `\n✅ ${rows.length} 项全部通过`);
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error("探针异常:", e.message, e.stack?.split("\n")[1] ?? "");
  process.exitCode = 1;
} finally {
  await close();
}
