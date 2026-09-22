// scripts/probe-project-rail.mjs — 写作舱左侧「我的研究」项目栏 + 快捷键(V425 B2/D2)
//
// 覆盖的是**新加的入口本身**: 能列、能切、能归档, 以及快捷键真的换页。
//   ⚠ 这里**真的会切项目**(改 lastTask_workflow 指针) —— 所以先记下原指针, 收尾还原,
//     否则跑一次门禁就把用户当前项目换掉了(这类"测试改了用户状态"是本仓踩过的坑)。
//
// 用法: API_BASE=http://127.0.0.1:4373 WEB=http://127.0.0.1:4373 node scripts/probe-project-rail.mjs
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, dismissOverlays, spyInstall } from "./lib/probe-actions.mjs";

const BASE = process.env.WEB || "http://127.0.0.1:4173";
const API_BASE = process.env.API_BASE || "http://127.0.0.1:4173";

const rows = [];
const rec = (k, ok, d) => { rows.push({ k, ok }); console.log(`${ok ? "  ok  " : "FAIL  "}${k}${d ? " — " + d : ""}`); };

const api = async (tk, p, m = "GET", b) => {
  const r = await fetch(`${API_BASE}/api${p}`, {
    method: m, headers: { Authorization: `Bearer ${tk}`, ...(b ? { "Content-Type": "application/json" } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const tk = await loginToken("audit", "audit123456");
// 造两个项目: 一个当前(带快照), 一个用来切过去
const stamp = Date.now();
const pA = await api(tk, "/research/projects", "POST", { title: `项目栏探针-A-${stamp}` });
const pB = await api(tk, "/research/projects", "POST", { title: `项目栏探针-B-${stamp}` });
const idA = pA.json?.id, idB = pB.json?.id;
if (!idA || !idB) { console.error("建项目失败", JSON.stringify(pA).slice(0, 150)); process.exit(1); }
await api(tk, `/research/projects/${idA}/workbench`, "PUT", {
  // phase 必须写明: 快捷键「往前只能一格」的判定依赖它。不写就是 0，于是 Alt+2 会被
  // **正确地**拦下，而断言若按「应该能跳」去写就会假失败（实测踩过一次）。
  snapshot: { phase: 1, input: { title: `项目栏探针-A-${stamp}`, outline: "一、引言", totalWordCount: 6000 }, sections: [] },
});
await api(tk, `/research/projects/${idB}/workbench`, "PUT", {
  snapshot: { input: { title: `项目栏探针-B-${stamp}`, outline: "一、背景", totalWordCount: 6000 }, sections: [] },
});

const { cdp, close } = await startCdp({ preferredPort: 31095, label: "probe-project-rail" });
let originalPointer = "";
try {
  await openSoc(cdp, BASE, "/workflow/input", tk, idA, 7500);
  await dismissOverlays(cdp);
  await sleep(900);
  originalPointer = (await evalTop(cdp, `localStorage.getItem('lastTask_workflow')`)) || "";

  // ① 栏本身
  const rail = await evalTop(cdp, `(() => {
    const r = document.querySelector('.wfs-rail');
    if (!r) return { ok: false };
    const items = [...r.querySelectorAll('.wfs-item')];
    return {
      ok: true,
      items: items.length,
      hasSearch: !!r.querySelector('[data-control="workflow:proj-search"]'),
      hasArchivedToggle: !!r.querySelector('[data-control="workflow:proj-show-archived"]'),
      hasToggle: !!r.querySelector('[data-control="workflow:rail-toggle"]'),
      current: (r.querySelector('.wfs-item.on .wfs-item-title')?.textContent || '').trim(),
      w: Math.round(r.getBoundingClientRect().width),
    };
  })()`);
  rec("左侧项目栏渲染", rail?.ok === true, rail?.ok ? `宽 ${rail.w}px, ${rail.items} 个项目, 当前="${rail.current}"` : "未找到 .wfs-rail");
  rec("搜索 / 含归档 / 折叠 三个控件齐全", !!(rail?.hasSearch && rail?.hasArchivedToggle && rail?.hasToggle),
    `搜索=${rail?.hasSearch} 归档=${rail?.hasArchivedToggle} 折叠=${rail?.hasToggle}`);
  rec("当前项目被标出(与指针一致)", String(rail?.current ?? "").includes("A-"), `当前="${rail?.current}"`);
  rec("项目栏不挤占主区(主区仍有合理宽度)", (await evalTop(cdp, `Math.round(document.querySelector('.wf-page')?.getBoundingClientRect().width || 0)`)) > 600,
    `主区宽 ${await evalTop(cdp, `Math.round(document.querySelector('.wf-page')?.getBoundingClientRect().width || 0)`)}px`);

  // ② 搜索真筛
  const before = rail?.items ?? 0;
  await evalTop(cdp, `(() => {
    const el = document.querySelector('[data-control="workflow:proj-search"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(`项目栏探针-B-${stamp}`)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await sleep(500);
  const after = await evalTop(cdp, `document.querySelectorAll('.wfs-item').length`);
  rec("搜索真把列表筛短", after === 1 && before > 1, `${before} → ${after}`);

  // ③ 点项目真切(指针变 + 主区标题变)
  await evalTop(cdp, `(() => {
    const el = document.querySelector('[data-control="workflow:proj-search"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); return 1;
  })()`);
  await sleep(400);

  // ④ 快捷键门禁: 在 A(phase=1) 上测 —— 往前只能一格, 往回自由。
  //    刻意放在"切到 B"之前: B 是新项目(phase=0), 在它上面 Alt+3 本来就该被拦。
  await evalTop(cdp, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', altKey: true, bubbles: true })); return 1; })()`);
  await sleep(1200);
  // ⚠ 只验"hash 没变到素材页"**证明不了被拦下** —— 快捷键没生效时 hash 同样不变
  //   (实测: 我第一版漏了 router.push, 这条断言照样绿)。所以要求**同时**有拦下的提示。
  const blocked = await evalTop(cdp, `(() => {
    const fixed = [...document.querySelectorAll('div')].filter(d => /position/.test(d.getAttribute('style') || ''));
    return { hash: location.hash, toast: fixed.map(d => d.innerText || '').join(' ').slice(0, 80) };
  })()`);
  rec("Alt+3 越级被拦(不跳 + 有明确提示)",
    !String(blocked?.hash).includes("/workflow/materials") && /请先完成前面的阶段/.test(String(blocked?.toast)),
    `hash=${blocked?.hash} 提示="${blocked?.toast}"`);

  await evalTop(cdp, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', altKey: true, bubbles: true })); return 1; })()`);
  await sleep(1600);
  const afterAlt2 = await evalTop(cdp, `location.hash`);
  rec("Alt+2 前进一格生效", afterAlt2.includes("/workflow/sections"), `hash=${afterAlt2}`);

  await spyInstall(cdp);
  // 断言用 `.ppb-topic-title`(进度条上的项目名)而**不是输入框** —— 上面 Alt+2 已经把我们带到了
  // 科研架构页, 那一页没有 `workflow:research-title` 这个输入框, 读出来恒为空串。
  // 进度条在五页都在, 用它才不依赖"发快捷键之前先回到哪一页"。
  const topicBefore = await evalTop(cdp, `(document.querySelector('.ppb-topic-title')?.textContent || '').trim()`);
  await evalTop(cdp, `(() => { const it = document.querySelector(${JSON.stringify(`[data-control="workflow:proj-${idB}"]`)}); if (it) it.click(); return !!it; })()`);
  await sleep(3500);
  const ptr = await evalTop(cdp, `localStorage.getItem('lastTask_workflow')`);
  const topicAfter = await evalTop(cdp, `(document.querySelector('.ppb-topic-title')?.textContent || '').trim()`);
  rec("点项目真切换指针", ptr === idB, `指针 ${String(ptr).slice(0, 8)}… 期望 ${idB.slice(0, 8)}…`);
  rec("切完主区内容跟着变(不是只换了指针)",
    String(topicAfter).includes("B-") && topicBefore !== topicAfter,
    `进度条项目名 "${topicBefore}" → "${topicAfter}"`);

  // ⑤ 帮助浮层
  await evalTop(cdp, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })); return 1; })()`);
  await sleep(600);
  const help = await evalTop(cdp, `(() => {
    const h = document.querySelector('.wfs-help');
    return h ? { rows: h.querySelectorAll('tr').length, text: (h.innerText||'').slice(0, 60) } : null;
  })()`);
  rec("按 ? 弹出快捷键表", !!help && help.rows >= 4, help ? `${help.rows} 行` : "没弹");
  await evalTop(cdp, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1; })()`);
  await sleep(500);
  rec("Esc 关闭浮层", !(await evalTop(cdp, `!!document.querySelector('.wfs-help')`)), "");

  // ⑥ 折叠栏
  await evalTop(cdp, `(() => { document.querySelector('[data-control="workflow:rail-toggle"]').click(); return 1; })()`);
  await sleep(600);
  const collapsed = await evalTop(cdp, `(() => {
    const r = document.querySelector('.wfs-rail');
    return { cls: r.className.includes('is-collapsed'), w: Math.round(r.getBoundingClientRect().width) };
  })()`);
  rec("折叠后栏变窄且列表收起", collapsed?.cls === true && collapsed.w < 60, `宽 ${collapsed?.w}px`);
} catch (e) {
  console.error("探针异常:", e.message);
} finally {
  // 还原指针(探针切了项目, 不能把用户的当前项目留在别的项目上)
  if (originalPointer) {
    await evalTop(cdp, `localStorage.setItem('lastTask_workflow', ${JSON.stringify(originalPointer)})`).catch(() => null);
  }
  try { await api(tk, `/research/projects/${idA}`, "DELETE"); } catch { /* 忽略 */ }
  try { await api(tk, `/research/projects/${idB}`, "DELETE"); } catch { /* 忽略 */ }
  close();
}

console.log("\n" + "=".repeat(50));
const fail = rows.filter((r) => !r.ok);
console.log(`项目栏/快捷键探针: ${rows.length - fail.length} 通过 / ${fail.length} 失败`);
process.exit(fail.length ? 1 : 0);
