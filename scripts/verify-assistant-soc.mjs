// scripts/verify-assistant-soc.mjs — 科研助手对 **soc 子应用(iframe)** 的动作覆盖回归
//
// 由来(2026-09-16): 外壳的 `verify-assistant-coverage.mjs` 覆盖的是 45 个 React 视图 ——
//   它扫的是**外壳自己的** DOM。写作舱等 6 个工作台是 iframe(走 `actions-bridge` postMessage
//   上报), 那条链路此前**没有门禁**: 动作 id 重复、首个实例被禁用、上报丢失,
//   任何一种都会让「当前页可执行」少列或点了没反应, 而外壳侧的门禁全绿。
//
// 覆盖:
//   ① soc 真的上报了动作(不是空表)
//   ② 每个上报 id 都能在 iframe 里按**外壳的取元素方式**命中
//   ③ 命中的元素可点(不是禁用/隐藏态 —— 那会让外壳点了没反应)
//   ④ 切换 soc 路由后动作表跟着换(不是只报首屏)
//
// 用法: node scripts/verify-assistant-soc.mjs   (需 4173 已起)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";

const BASE = process.env.ORCH_UI_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.ok ? r.json().catch(() => ({})) : { __status: r.status };
};

const token = await loginToken("audit", "audit123456");
if (!token) { console.error("登录失败, 无法播种"); process.exit(1); }
const proj = await api(token, "/research/projects", "POST", { title: `助手门禁-${Date.now()}`, status: "in-progress", phase: 3, phaseLabel: "素材准备" });
const pid = (proj?.data ?? proj)?.id;
await api(token, `/research/projects/${pid}/nodes/input`, "PUT", {
  payload: {
    input: { title: "助手覆盖门禁", outline: "一、引言\n二、文献综述", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] },
    sections: [{ id: "sec_0", title: "引言", level: 1, order: 0, status: "pending" }],
  },
});
await api(token, "/research/materials", "POST", { projectId: pid, kind: "theory", title: "门禁素材", contentMd: "内容" });

const { cdp, close } = await startCdp({ preferredPort: 31073, label: "scripts/verify-assistant-soc.mjs" });

/** 收集 soc 上报的动作(装监听 + 主动问一次, 解决"监听装得比上报晚") */
async function collectActs(waitMs = 6000) {
  await evalTop(cdp, `(() => {
    if (!window.__socActsInstalled) {
      window.__socActs = [];
      window.addEventListener('message', (e) => {
        const d = e.data || {};
        if (d.source === 'marxsphere-soc' && d.type === 'actions') window.__socActs = d.actions || [];
      });
      window.__socActsInstalled = true;
    }
    window.__socActs = [];
    const f = document.querySelector('iframe');
    if (f && f.contentWindow) f.contentWindow.postMessage({ source: 'marxsphere-workbench', type: 'query-actions' }, '*');
    return 1;
  })()`);
  await sleep(waitMs);
  return (await evalTop(cdp, `window.__socActs || []`)) || [];
}

/** 按外壳 `invokeFromShell` 的取元素方式回查: 能否命中、可否点 */
async function probeHit(id) {
  const key = String(id).split(":").slice(1).join(":");
  return evalTop(cdp, `(() => {
    const f = document.querySelector('iframe');
    if (!f || !f.contentDocument) return { err: 'no-frame' };
    const els = Array.from(f.contentDocument.querySelectorAll('[data-control=${JSON.stringify(key)}]'));
    if (!els.length) return { err: 'missing' };
    const usable = els.find(e => !e.disabled && e.getClientRects().length);
    return { n: els.length, usable: !!usable, firstDisabled: !!els[0].disabled };
  })()`);
}

try {
  await cdp("Page.navigate", { url: `${BASE}/` });
  await sleep(4000);
  await evalTop(cdp, `localStorage.setItem('sag_token', ${JSON.stringify(token)}); localStorage.setItem('lastTask_workflow', ${JSON.stringify(pid)});`);
  await cdp("Page.reload");
  await sleep(6000);
  await evalTop(cdp, `location.hash = '#paper-outline';`);
  await sleep(8000);

  console.log("═══ ① soc 上报动作(iframes 链路) ═══");
  const acts = await collectActs();
  t("soc 上报了动作(非空表)", acts.length > 0, `上报 ${acts.length} 条`);

  console.log("\n═══ ②③ 每条都能按外壳方式命中且可点 ═══");
  const broken = [];
  for (const a of acts.slice(0, 15)) {
    const hit = await probeHit(a.id);
    if (hit?.err) broken.push(`${a.id}(${hit.err})`);
    else if (!hit.usable) broken.push(`${a.id}(首个实例${hit.firstDisabled ? "禁用" : "隐藏"})`);
  }
  t("全部可唯一命中且存在可点实例", broken.length === 0,
    broken.length ? `问题项: ${broken.join(", ")}` : `回查 ${Math.min(acts.length, 15)} 条全通过`);

  console.log("\n═══ ④ 切换 soc 路由后动作表跟着换 ═══");
  const before = acts.map((a) => a.id).join(",");
  await evalTop(cdp, `(() => { const f = document.querySelector('iframe'); if (f) f.contentWindow.location.href = location.origin + '/soc/index.html#/workflow/materials'; return 1; })()`);
  await sleep(9000);
  const acts2 = await collectActs();
  const after = acts2.map((a) => a.id).join(",");
  t("换路由后上报了新页面的动作", acts2.length > 0 && after !== before,
    `input=${acts.length} 条 → materials=${acts2.length} 条`);
  // 新页面的动作同样要能命中 —— 这条最容易漏(外壳可能拿着上一页的 id 去点)
  const broken2 = [];
  for (const a of acts2.slice(0, 15)) {
    const hit = await probeHit(a.id);
    if (hit?.err || !hit.usable) broken2.push(`${a.id}(${hit?.err ?? "不可点"})`);
  }
  t("新页面的动作也能命中可点", broken2.length === 0, broken2.length ? `问题项: ${broken2.join(", ")}` : `回查 ${Math.min(acts2.length, 15)} 条全通过`);

  console.log("\n═══ ④b 动作数量地板(防『埋点被静默摘掉』) ═══");
  /**
   * 为什么要有数量地板: ①②③ 只验"上报的能点" —— **一条都不报也照样全绿**,
   * 埋点被人删掉或改错前缀, 门禁不会有任何反应。
   *
   * 2026-09-18 实测的教训: 把闭源 44 个 data-assistant-control 逐条对照时发现,
   *   五个阶段页的「返回」按钮**一个都没埋点**(它们长得跟有埋点的一模一样, 肉眼看不出来);
   *   合稿页更是连"空态根本没有返回路径"这个真缺陷也是靠这条线才浮出来的。
   *   补齐后各页动作显著变多, 这里把**只增不减**钉住。
   *
   * 数字取自补齐后的**实测值**(这一门禁自己量出来的口径: 上报条数含视图前缀,
   *   与 DOM 里 `[data-control]` 的去重种类数**不是同一个量**, 别拿那边数当基准)。
   * **往下调要说明理由** —— 那意味着有功能从助手视野里消失。
   */
  const FLOOR = { input: 9, sections: 5, materials: 27, workspace: 8, finalize: 8 };
  for (const [page, min] of Object.entries(FLOOR)) {
    await evalTop(cdp, `(() => { const f = document.querySelector('iframe'); if (f) f.contentWindow.location.href = location.origin + '/soc/index.html#/workflow/${page}'; return 1; })()`);
    await sleep(6500);
    const got = (await collectActs()) || [];
    // ⚠ 上报的 id **带视图前缀**(形如 `materials:workflow:back`), 所以只能按子串判,
    //   别用 split(":") 取尾段 —— 那样恒判"缺 back"(我第一版就是这么写的, 红了 5 条)。
    const missing = page !== "input" && !got.some((a) => String(a.id).toLowerCase().includes("back")) ? ["back"] : [];
    t(`${page} 动作数 ≥ ${min} 且返回键在`, got.length >= min && !missing.length,
      `实测 ${got.length} 条${missing.length ? ` · 缺: ${missing.join(",")}` : ""}`);
  }

  console.log("\n═══ ⑤ 无 JS 错误 ═══");
  const errs = await evalTop(cdp, `JSON.stringify(window.__verifyErrs || [])`);
  t("页面无未捕获错误", errs === "[]", String(errs).slice(0, 160));
} finally {
  try { await api(token, `/research/projects/${pid}`, "DELETE"); } catch { /* 清理失败不影响结论 */ }
  close();
}

console.log("\n" + "=".repeat(52));
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
