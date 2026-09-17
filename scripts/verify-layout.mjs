// scripts/verify-layout.mjs — 写作舱布局回归: 溢出 / 塌陷 / 重叠 / 三档视口
//
// 由来(2026-09-16): 写作舱此前**没有任何布局断言** —— 已有一套门禁全是文案与结构断言
//   (查类名、查 innerText), 而"元素实际占多大、窄屏会不会塌"是另一回事, 静态读 CSS 也测不出。
//   用户在"布局、设计、空间"上的反馈一直无从回归。这个脚本补上这一层。
//
// 为什么需要它: 现有门禁全是**文案/结构**断言(查类名、查 innerText), 没有一条验过
//   "元素实际占多大、有没有溢出、窄屏会不会塌"。而这正是用户说的"布局、空间"。
//   静态读 CSS 也测不出来 —— 得让浏览器真渲染再量。
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, dismissOverlays } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
const api = async (tk, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, { method, headers: { Authorization: `Bearer ${tk}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.ok ? r.json().catch(() => ({})) : { __status: r.status };
};
const tk = await loginToken("audit", "audit123456");
const p = await api(tk, "/research/projects", "POST", { title: `布局实测-${Date.now()}`, status: "in-progress", phase: 4, phaseLabel: "文本创作" });
const pid = p.id ?? p.data?.id;
await api(tk, `/research/projects/${pid}/nodes/input`, "PUT", { payload: { input: { title: "布局实测研究", outline: "一、引言\n  1.1 背景\n二、综述", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] }, sections: [] } });
await api(tk, `/research/projects/${pid}/nodes/sections`, "PUT", { payload: { sections: [
  { id: "sec_0", title: "引言", level: 1, order: 0, status: "done", content: "正文内容。".repeat(120) },
  { id: "sec_1", title: "研究背景", level: 2, parentId: "sec_0", order: 1, status: "pending" },
  { id: "sec_2", title: "文献综述", level: 1, order: 2, status: "pending" },
] } });
await api(tk, "/research/materials", "POST", { projectId: pid, kind: "theory", title: "布局素材", contentMd: "素材内容".repeat(60), sectionIds: ["sec_0"] });

const { cdp, close } = await startCdp({ preferredPort: 31081, label: "scripts/verify-layout.mjs", windowSize: "1440,900" });
const out = [];
const rec = (v, k, ok, d) => { out.push({ v, k, ok, d }); console.log(`${ok ? "  ok  " : "FAIL  "}[${v}] ${k}${d ? " — " + d : ""}`); };

/** 量一页的布局: 溢出/塌陷/重叠/关键区域尺寸 */
const MEASURE = `(() => {
  const de = document.documentElement;
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left), y: Math.round(b.top) }; };
  // 横向溢出: 页面能否横向滚(不该能)
  const hOverflow = de.scrollWidth - de.clientWidth;
  // 塌陷: 任意可见容器高度 < 40 且子元素比它高 → 内容被裁
  let collapsed = [];
  for (const e of document.querySelectorAll('.workflow-page, .ws-page-root, .wf-layout, main, aside, section')) {
    if (e.getClientRects().length === 0) continue;
    const b = e.getBoundingClientRect();
    if (b.height > 0 && b.height < 40 && e.scrollHeight > 60) collapsed.push((e.className || e.tagName).toString().slice(0, 40));
  }
  // 重叠: 关键操作元素之间是否互相压住
  const overlap = [];
  const els = [...document.querySelectorAll('button, [data-control]')].filter(e => e.getClientRects().length);
  for (let i = 0; i < Math.min(els.length, 40); i++) {
    for (let j = i + 1; j < Math.min(els.length, 40); j++) {
      const a = els[i].getBoundingClientRect(), c = els[j].getBoundingClientRect();
      const ox = Math.min(a.right, c.right) - Math.max(a.left, c.left);
      const oy = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
      if (ox > 6 && oy > 6) overlap.push([(els[i].innerText||'').trim().slice(0,10), (els[j].innerText||'').trim().slice(0,10)]);
    }
  }
  // 可滚动容器: 内容比视口高时, 必须存在一个能滚的祖先 —— 否则底部内容永久不可达。
  //   2026-09-16 实测踩到: 素材/架构/合稿三页根节点漏了 overflow-y-auto, 内容 1110px
  //   而视口 900px, 整条祖先链**零个可滚动元素**, 底部 210px 摸不到。
  const pg = document.querySelector('.workflow-page') || document.querySelector('.ws-page-root');
  let scroller = null;
  if (pg) {
    let e = pg;
    while (e && e !== document.documentElement) {
      const st = getComputedStyle(e);
      if (/(auto|scroll)/.test(st.overflowY)) { scroller = (e.className || e.tagName).toString().slice(0, 50); break; }
      e = e.parentElement;
    }
  }
  const contentH = pg ? pg.scrollHeight : 0;
  return {
    vw: de.clientWidth, vh: de.clientHeight, hOverflow, collapsed, overlap: overlap.slice(0, 5),
    page: r('.workflow-page'), nav: r('.sec-nav,.ws-nav,aside'), main: r('main,.ws-main'),
    topic: r('.ppb-topic'), inner: r('.ppb-inner'),
    contentH, needScroll: contentH > de.clientHeight + 8, scroller,
  };
})()`;

const VIEWS = [
  ["input", "/workflow/input"],
  ["sections", "/workflow/sections"],
  ["materials", "/workflow/materials"],
  ["workspace", "/workflow/workspace"],
  ["finalize", "/workflow/finalize"],
];

// 三档视口 —— 窄屏是布局最容易塌的地方, 必须测
const VIEWPORTS = [
  ["宽屏 1440", 1440, 900],
  ["笔记本 1280", 1280, 800],
  ["窄屏 1024", 1024, 768],
];
try {
  for (const [vpName, w, h] of VIEWPORTS) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    console.log(`
── ${vpName} ──`);
    for (const [name, route] of VIEWS) {
      await openSoc(cdp, BASE, route, tk, pid, 7500);
      await dismissOverlays(cdp);
      await sleep(1200);
      const m = await evalTop(cdp, MEASURE);
      if (!m || typeof m !== "object") { rec(`${name}@${w}`, "页面可测量", false, String(m).slice(0, 80)); continue; }
      rec(`${name}@${w}`, "无横向溢出", m.hOverflow <= 2, `溢出=${m.hOverflow}px`);
      // 内容超出视口时必须有可滚动容器, 否则底部不可达
      rec(`${name}@${w}`, "内容超出时可滚动", !m.needScroll || !!m.scroller,
        m.needScroll ? `内容${m.contentH}px>视口${m.vh}px, 滚动容器=${m.scroller ?? "无(底部不可达)"}` : "内容未超出, 无需滚动");
      rec(`${name}@${w}`, "无塌陷容器", m.collapsed.length === 0, m.collapsed.length ? JSON.stringify(m.collapsed) : "");
      rec(`${name}@${w}`, "按钮无重叠", m.overlap.length === 0, m.overlap.length ? JSON.stringify(m.overlap) : "");
    }
  }
  await cdp("Emulation.clearDeviceMetricsOverride");
} catch (e) {
  console.error("探针异常:", e.message);
} finally {
  try { await api(tk, `/research/projects/${pid}`, "DELETE"); } catch { /* 忽略 */ }
  close();
}
console.log("\n" + "=".repeat(50));
const fail = out.filter((o) => !o.ok);
console.log(`布局门禁: ${out.length - fail.length} 通过 / ${fail.length} 失败`);
process.exit(fail.length ? 1 : 0);
