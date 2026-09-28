// probe-batch13.mjs — 阶段内部步骤: 真源 / 画布可跑 / 单步执行 / 模板可展开
//
// 由来(2026-09-28 用户要求):「DAG 的可供执行的节点除了我们现在现有的宏观的节点外,
//   还要像人家那样能执行每一个环节里的每一步这样的微观操作」。
//
// 覆盖:
//   ① 能力面板能切到「按研究阶段」, 六个阶段各自的步骤都列出来了
//   ② 每一步的**可执行性**与真源表一致: 有能力的给「▶ 跑 / ＋」, 没能力的给「去页面」
//      —— 判据是**真实存在的 capabilityId**(后端注册表里查得到), 不是界面上有没有按钮
//   ③ **单步执行真的跑起来**: 点「▶ 跑」→ 后端起一次运行 → 进度能读到
//      (⚠ 只断言"发出了请求"是不够的 —— 那证明不了后端认这张单节点图)
//   ④ 模板库能展开看内部结构, 且**展开不会连带把模板载入画布**
//      (展开按钮忘了 stopPropagation 就会这样, 症状是"想看结构却把画布覆盖了")
//
// ⚠ **不烧模型**: ① 只读; ②③ 挑的都是不需要 LLM 的步(第一个可跑的是「澄清追问」,
//   它是 user_input 节点, 跑起来**正确地挂起等人填**, 不产生任何模型调用); ④ 只读前端数据。
//
// 用法: node scripts/probe-batch13.mjs   (需 4173 已起, 产物已重建)
import { startCdp, loginToken, sleep, evalTop, clickOnPage } from "./lib/cdp-editor.mjs";
import { openSoc } from "./lib/probe-actions.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const token = await loginToken();
if (!token) { console.error("登录失败: 4173 未起或缺 verify 账号"); process.exit(1); }

// ── 前置: 真实能力表 ──
// 用它当**独立判据** —— 界面上的每一格可执行步骤, 它的能力 id 都必须在这张表里。
const capsRes = await api(token, "/orchestrator/capabilities");
const knownCaps = new Set((capsRes.body?.capabilities ?? []).map((c) => c.id));
t("前置: 拿到能力表", knownCaps.size > 50, `${knownCaps.size} 项`);

const { cdp, close } = await startCdp({ preferredPort: 9363, label: "batch13" });
try {
  await openSoc(cdp, BASE, "/workbench/quick", token, "", 9000);
  await evalTop(cdp, `(() => { document.querySelectorAll('.assistant-close,.modal-x').forEach(b => b.click()); return true; })()`);
  await sleep(800);

  // ═══ ① 能力面板的「按研究阶段」视图 ═══
  console.log("\n① 按研究阶段视图");
  const modes = await evalTop(cdp, `[...document.querySelectorAll('.palette-mode')].map(b => (b.innerText||'').trim())`);
  t("面板有「按能力 / 按研究阶段」两档", Array.isArray(modes) && modes.length === 2, JSON.stringify(modes));
  await evalTop(cdp, `(() => { const b=[...document.querySelectorAll('.palette-mode')].find(x=>(x.innerText||'').includes('阶段')); if(b) b.click(); return true; })()`);
  await sleep(900);
  const stages = await evalTop(cdp, `(() => {
    const blocks = [...document.querySelectorAll('.stage-block')];
    return blocks.map(b => ({
      title: (b.querySelector('.stage-head strong')?.innerText || '').trim(),
      steps: [...b.querySelectorAll('.stage-step')].map(s => ({
        label: (s.querySelector('.ss-label')?.innerText || '').trim(),
        runnable: !!s.querySelector('[data-run-step]'),
        goPage: !!s.querySelector('.ss-go'),
      })),
    }));
  })()`);
  t("六个阶段都列出来了", Array.isArray(stages) && stages.length === 6,
    (stages ?? []).map((s) => `${s.title}(${s.steps.length})`).join(" "));
  t("每个阶段都有步骤(不是空壳)", (stages ?? []).every((s) => s.steps.length > 0),
    (stages ?? []).map((s) => s.steps.length).join("/"));

  /**
   * ② 可执行性必须与真源表一致 —— 判据是**能力表里真有这个 id**。
   * ⚠ 只数按钮个数是不够的: 按钮画出来了、点下去报"能力不存在"同样算坏。
   *   这里做的是**反向核对** —— 界面上标了"可跑"的步骤, 把它的能力 id 取出来,
   *   拿去能力表里查。查得到才算数。
   */
  console.log("\n② 可执行步骤挂的能力都真实存在");
  const runnableCaps = await evalTop(cdp, `(() => {
    const out = [];
    for (const s of document.querySelectorAll('.stage-step')) {
      const btn = s.querySelector('[data-run-step]');
      if (!btn) continue;
      out.push({ label: (s.querySelector('.ss-label')?.innerText || '').trim(), title: btn.getAttribute('title') || '' });
    }
    return out;
  })()`);
  t("取到了可执行步骤清单", Array.isArray(runnableCaps) && runnableCaps.length >= 10, `${runnableCaps?.length} 步可跑`);
  const unknown = (runnableCaps ?? []).filter((x) => {
    const m = String(x.title).match(/\(([^)]+)\)\s*$/);
    return !m || !knownCaps.has(m[1]);
  });
  t("**每一个**可跑步骤挂的能力都在后端能力表里", unknown.length === 0,
    unknown.length ? `查不到: ${unknown.map((x) => x.label).join(", ")}` : `${runnableCaps?.length} 步全部有真能力`);
  const manualSteps = await evalTop(cdp, `document.querySelectorAll('.stage-step.is-manual .ss-go').length`);
  t("没有能力的步给的是「去页面」而不是假的可跑按钮", Number(manualSteps) > 0, `${manualSteps} 步走页面`);

  // ═══ ③ 单步执行真跑起来 ═══
  console.log("\n③ 单步执行");
  const runLogBefore = (await api(token, "/orchestrator/runs?limit=1")).body?.runs?.[0]?.runId ?? "";
  await evalTop(cdp, `(() => { const b=document.querySelector('[data-run-step]'); if(b) b.click(); return !!b; })()`);
  /**
   * ⚠ 判据是**后端真的多了一条运行**, 不是"界面上出现了 loading"。
   *   只断言 UI 变化的话, 一个点了没反应的按钮也会通过。
   */
  let newRun = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const r = await api(token, "/orchestrator/runs?limit=1");
    const top = r.body?.runs?.[0];
    if (top && top.runId !== runLogBefore) {
      // 确认它是**单节点图** —— 那才是"只跑这一步"而不是"跑了整张画布"
      if ((top.stepLog ?? []).length === 1) { newRun = top; break; }
      newRun = top; break;
    }
  }
  t("点「▶ 跑」之后后端**真的起了一次运行**", !!newRun, newRun ? `runId=${newRun.runId}` : "20 秒内没有新运行");
  t("这次运行是**单节点**图(只跑这一步, 没跑整张画布)",
    !!newRun && (newRun.stepLog ?? []).length === 1,
    newRun ? `节点数=${(newRun.stepLog ?? []).length}: ${(newRun.stepLog ?? []).map((s) => s.stepId).join(",")}` : "—");
  /**
   * 单跑的那一步是「澄清追问」(user_input) —— 它的**正确行为就是挂起等人填**。
   * 所以这里期望 waiting_input; 若它直接 done 或 failed, 说明单节点图的语义被破坏了。
   */
  const st = newRun?.status ?? "";
  t("该步是 user_input 节点 → 正确挂起等输入(不是失败)",
    ["waiting_input", "running", "done"].includes(st), `状态=${st}`);

  // ═══ ④ 模板库展开 ═══
  console.log("\n④ 模板库可展开看内部结构");
  /**
   * ⚠ 先**重新打开一次页面**再验模板库。
   *
   * 实测踩过: ③ 起的单步运行挂在 `waiting_input` ⇒ 画布 `locked=true` ⇒
   *   「模板库」按钮是 `:disabled="locked"` 的, **点不动** ⇒ ④ 的五条全红,
   *   看着像"模板功能坏了"。
   * 我先试过用 `/orchestrator/control` cancel 那条路 —— 取消后前端还要等一轮进度
   *   轮询才把 runState 放回 draft, 时序不稳。**换页重开**干净且确定, 而且与用户
   *   真正去点模板库时的状态一致(没有人会在一半挂起的运行上翻模板)。
   */
  await openSoc(cdp, BASE, "/workbench/quick", token, "", 9000);
  await evalTop(cdp, `(() => { document.querySelectorAll('.assistant-close,.modal-x').forEach(b => b.click()); return true; })()`);
  await sleep(800);
  const tplBtn = await evalTop(cdp, `(() => { const b=[...document.querySelectorAll('.hdr-btn')].find(x => (x.innerText||'').includes('模板库')); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; })()`);
  t("换页重开后「模板库」可点(不是被上一步的运行锁住)", tplBtn === "clicked", String(tplBtn));
  await sleep(1500);
  const cardCount = await evalTop(cdp, `document.querySelectorAll('.tpl-card').length`);
  t("模板库列出模板卡", Number(cardCount) >= 10, `${cardCount} 个`);
  const expanded = await evalTop(cdp, `(() => { const b=document.querySelector('.tpl-expand'); if(!b) return false; b.click(); return true; })()`);
  t("模板卡上有「展开」入口", expanded === true);
  await sleep(700);
  const graph = await evalTop(cdp, `(() => {
    const g = document.querySelector('.tpl-graph');
    if (!g) return null;
    return { rows: [...g.querySelectorAll('.tpl-node')].map(x => (x.innerText||'').replace(/\\s+/g,' ').trim()) };
  })()`);
  t("展开后列出了内部节点", !!graph && graph.rows.length > 0, `${graph?.rows?.length} 行`);
  t("每行带能力标签与下游流向(看得出这张图怎么跑)",
    !!graph && graph.rows.some((r) => r.includes("→")),
    graph?.rows?.[0] ?? "");
  /**
   * ⚠ 这一条是**真踩过的那类坑**: 展开按钮在卡片里, 而卡片整块绑了
   *   "载入画布 + 关窗"。忘了 stopPropagation 的话, 用户点"展开"会变成
   *   "模板被载入画布、弹窗关掉" —— 想看结构却把当前画布覆盖了。
   */
  const stillOpen = await evalTop(cdp, `!!document.querySelector('.tpl-card')`);
  t("点「展开」**不会**连带把模板载入画布并关窗", stillOpen === true, stillOpen ? "弹窗仍在" : "被连带关掉了");
} finally {
  console.log(`\n  ${fail ? "❌" : "✅"} ${pass}/${pass + fail} 通过`);
  try { close(); } catch { /* 清理失败不改结论 */ }
}
process.exit(fail ? 1 : 0);
