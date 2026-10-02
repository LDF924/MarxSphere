// probe-batch09.mjs — 批9 录用与传播: 出版事务(版权/OA/校样) + 成果转化 + 后续方向
//
// 覆盖:
//   ① 段位存在, 且**只对「已录用」的投稿显示** —— 未录用时给的是提示, 不是空表单
//   ② 版权许可 / 开放获取的**选项表来自后端**(前端不写死), 且选中后 hint 会显示
//   ③ 改了就**真落库**, 刷新后仍在(这是本仓最容易静默失效的一处)
//   ④ 校样: 清单来自后端; 标记完成后出现"已完成"徽标
//   ⑤ 成果转化 / 后续方向: 增删真落库
//   ⑥ 日期不走 UTC(投稿日期那条教训的同一形状)
//
// ⚠ **不烧模型**: 这一批**没有 LLM 调用**(版权/OA 是标准条款的选择, 校样要看到校样 ——
//   两者都不该由模型生成, 见 post-acceptance.ts 的注释)。所以整套默认就能跑。
//
// 用法: node scripts/probe-batch09.mjs   (需 4173 已起, 产物已重建)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";

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

const token = await loginToken("audit", "audit123456");
if (!token) { console.error("登录失败"); process.exit(1); }

const SOC = `document.querySelector('iframe[title^="研途写作舱"], iframe[src*="/soc/"]')`;
let cdp, close;
let pid = "";
try {
  ({ cdp, close } = await startCdp({ preferredPort: 31233, label: "probe-batch09", windowSize: "1600,1100" }));
  await cdp("Page.navigate", { url: BASE });
  await sleep(2500);
  await evalTop(cdp, `localStorage.setItem("sag_token", ${JSON.stringify(token)}); localStorage.setItem("skf_auth_token", ${JSON.stringify(token)}); localStorage.setItem('sag_onboarding_done_v1','1'); 1`);
  await evalTop(cdp, `(() => { location.hash = "#paper-outline"; return 1; })()`);
  await sleep(4000);

  const runInSoc = (body) => evalTop(cdp, `(() => {
    const f = ${SOC};
    if (!f) return "NO_IFRAME";
    try { const w = f.contentWindow; ${body} } catch (e) { return "ERR:" + e.message; }
  })()`);
  const goto = async (hash) => {
    await runInSoc(`w.location.href = w.location.origin + "/soc/index.html#" + ${JSON.stringify(hash)}; return "ok";`);
    await sleep(2800);
  };

  const boot = await evalTop(cdp, `${SOC} ? "ok" : "NO_IFRAME"`);
  t("前置: 写作舱 iframe 已挂载", boot === "ok", `实测 ${boot}`);
  if (boot !== "ok") throw new Error("iframe 没挂上");

  const p = await api(token, "/research/projects", "POST", { title: `批9录用-${Date.now()}`, status: "active" });
  pid = (p.body?.data ?? p.body)?.id ?? p.body?.project?.id ?? "";
  t("前置: 建得出测试项目", !!pid, `pid=${pid}`);

  // ── ① 未录用时: 只给提示, 不显示空表单 ──
  await api(token, `/research/projects/${pid}/submissions`, "PUT", {
    submissions: [{ journalName: "某刊", submittedOn: "2026-09-01", status: "under_review", round: 1 }],
  });
  await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(pid))}); 1`);
  await runInSoc(`w.location.reload(); return 1;`);
  await sleep(7000);
  await goto("/workflow/submission");

  console.log("\n═══ ① 只对「已录用」显示 ═══");
  {
    const sec = await runInSoc(`return w.document.querySelector(".pa-h2") ? w.document.querySelector(".pa-h2").innerText.trim() : "missing";`);
    t("投稿与要件页有「录用与传播」段", sec === "录用与传播", `实测 ${JSON.stringify(sec)}`);
    const noAcc = await runInSoc(`return w.document.querySelector('[data-control="workflow:pa-no-accepted"]') ? "shown" : "missing";`);
    t("未录用时给提示而不是空表单", noAcc === "shown", `实测 ${noAcc}`);
    const card = await runInSoc(`return w.document.querySelector('[data-control="workflow:pa-sub"]') ? "present" : "absent";`);
    t("未录用时不显示出版事务卡", card === "absent", `实测 ${card}`);
  }

  // ── ② 改成已录用 → 出版事务出现 ──
  console.log("\n═══ ② 录用后出版事务出现 ═══");
  const subNow = await api(token, `/research/projects/${pid}/submissions`);
  const subId = (subNow.body?.submissions ?? [])[0]?.id ?? "";
  await api(token, `/research/projects/${pid}/submissions`, "PUT", {
    submissions: [{ id: subId, journalName: "某刊", submittedOn: "2026-09-01", status: "accepted", round: 1 }],
  });
  await runInSoc(`w.location.reload(); return 1;`);
  await sleep(7000);
  await goto("/workflow/submission");
  {
    const card = await runInSoc(`return w.document.querySelector('[data-control="workflow:pa-sub"]') ? "present" : "absent";`);
    t("改「已录用」后出现出版事务卡", card === "present", `实测 ${card}`);

    // 选项来自后端(不是前端写死)
    const optCount = await runInSoc(`
      const sel = w.document.querySelector('[data-control="workflow:pa-license-${subId}"]');
      return sel ? sel.options.length : 0;
    `);
    const optApi = await api(token, "/research/post-acceptance/options");
    const apiCount = (optApi.body?.licenses ?? []).length + 1;   // +1 = 空占位
    t("版权许可的选项数与后端一致(前端没写死)", Number(optCount) === apiCount,
      `界面 ${optCount} / 后端 ${apiCount}`);

    const proofN = await runInSoc(`return w.document.querySelectorAll(".pa-checklist li").length;`);
    t("校样清单从后端取(条数对得上)", Number(proofN) === (optApi.body?.proofChecklist ?? []).length,
      `界面 ${proofN} / 后端 ${(optApi.body?.proofChecklist ?? []).length}`);
  }

  // ── ③ 选了就落库 + hint 显示 ──
  console.log("\n═══ ③ 选择真落库 ═══");
  {
    await runInSoc(`
      const sel = w.document.querySelector('[data-control="workflow:pa-license-${subId}"]');
      sel.value = "cc-by-nc"; sel.dispatchEvent(new w.Event("change", { bubbles: true }));
      return "ok";
    `);
    await sleep(1200);
    await runInSoc(`
      const sel = w.document.querySelector('[data-control="workflow:pa-oa-${subId}"]');
      sel.value = "green"; sel.dispatchEvent(new w.Event("change", { bubbles: true }));
      return "ok";
    `);
    await sleep(1200);
    const after = await api(token, `/research/projects/${pid}/submissions`);
    const s0 = (after.body?.submissions ?? [])[0] ?? {};
    t("版权许可落库", s0.license === "cc-by-nc", `实测 ${s0.license}`);
    t("开放获取落库", s0.oaChoice === "green", `实测 ${s0.oaChoice}`);

    const hint = await runInSoc(`
      const hs = [...w.document.querySelectorAll(".pa-field .pa-hint")].map((e) => e.innerText.trim());
      return hs.some((x) => x.includes("禁止商业")) ? "shown" : "missing";
    `);
    t("选中后显示该项的说明(不是只存个代码)", hint === "shown", `实测 ${hint}`);
  }

  // ── ④ 录用日期不走 UTC + 刷新仍在 ──
  console.log("\n═══ ④ 刷新后仍在 / 日期不退一天 ═══");
  {
    await runInSoc(`
      const inp = w.document.querySelector('[data-control="workflow:pa-accepted-on-${subId}"]');
      const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set;
      setter.call(inp, "2026-12-15");
      inp.dispatchEvent(new w.Event("change", { bubbles: true }));
      return "ok";
    `);
    await sleep(1300);
    const after = await api(token, `/research/projects/${pid}/submissions`);
    t("录用日期落库且不退一天", (after.body?.submissions ?? [])[0]?.acceptedOn === "2026-12-15",
      `实测 ${(after.body?.submissions ?? [])[0]?.acceptedOn}`);

    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(7000);
    await goto("/workflow/submission");
    const back = await runInSoc(`
      const g = (s) => { const e = w.document.querySelector(s); return e ? e.value : null; };
      return JSON.stringify({
        lic: g('[data-control="workflow:pa-license-${subId}"]'),
        oa: g('[data-control="workflow:pa-oa-${subId}"]'),
        dt: g('[data-control="workflow:pa-accepted-on-${subId}"]'),
      });
    `);
    let o = {};
    try { o = JSON.parse(String(back)); } catch { /* 忽略 */ }
    t("刷新后三项都还在", o.lic === "cc-by-nc" && o.oa === "green" && o.dt === "2026-12-15", `实测 ${back}`);
  }

  // ── ⑤ 校样标记 ──
  console.log("\n═══ ⑤ 校样核对 ═══");
  {
    await runInSoc(`w.document.querySelector('[data-control="workflow:pa-proof-done"]').click(); return "ok";`);
    await sleep(1300);
    const after = await api(token, `/research/projects/${pid}/submissions`);
    t("校样标记落库", (after.body?.submissions ?? [])[0]?.proofChecked === true,
      `实测 ${(after.body?.submissions ?? [])[0]?.proofChecked}`);
    const badge = await runInSoc(`return w.document.querySelector(".pa-done") ? "shown" : "missing";`);
    t("界面出现「已完成」徽标", badge === "shown", `实测 ${badge}`);
  }

  // ── ⑥ 成果转化 / 后续方向 ──
  console.log("\n═══ ⑥ 成果转化与后续方向 ═══");
  {
    await runInSoc(`w.document.querySelector('[data-control="workflow:pa-add-trans"]').click(); return "ok";`);
    await sleep(1300);
    await runInSoc(`
      const inp = w.document.querySelector('[data-control="workflow:pa-trans-title-0"]');
      const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set;
      setter.call(inp, "被《中国社会科学文摘》转载");
      inp.dispatchEvent(new w.Event("change", { bubbles: true }));
      return "ok";
    `);
    await sleep(1300);
    await runInSoc(`w.document.querySelector('[data-control="workflow:pa-add-dir"]').click(); return "ok";`);
    await sleep(1300);
    await runInSoc(`
      const inp = w.document.querySelector('[data-control="workflow:pa-dir-title-0"]');
      const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set;
      setter.call(inp, "把样本扩到县域层面");
      inp.dispatchEvent(new w.Event("change", { bubbles: true }));
      return "ok";
    `);
    await sleep(1400);

    const fu = await api(token, `/research/projects/${pid}/followups`);
    const all = fu.body?.followups ?? [];
    t("两类各一条都落库", all.length === 2, `实测 ${all.length} 条: ${all.map((f) => f.kind).join(",")}`);
    t("转化标题落库", all.some((f) => f.kind === "translation" && String(f.title).includes("文摘")), JSON.stringify(all.map((f) => f.title)));
    t("方向标题落库", all.some((f) => f.kind === "direction" && String(f.title).includes("县域")), JSON.stringify(all.map((f) => f.title)));

    // 删掉方向那条
    await runInSoc(`w.document.querySelector('[data-control="workflow:pa-dir-del-0"]').click(); return "ok";`);
    await sleep(1400);
    const fu2 = await api(token, `/research/projects/${pid}/followups`);
    t("删掉后库里真的少了", (fu2.body?.followups ?? []).length === 1, `实测 ${(fu2.body?.followups ?? []).length}`);
  }

  // ── ⑦ 无 JS 错误 ──
  console.log("\n═══ ⑦ 无 JS 错误 ═══");
  {
    const errs = await evalTop(cdp, `JSON.stringify((window.__verifyErrs || []).slice(0, 3))`);
    t("顶层无未捕获错误", errs === "[]", String(errs).slice(0, 200));
  }
} finally {
  if (pid) await api(token, `/research/projects/${pid}`, "DELETE").catch(() => null);
  try { close?.(); } catch { /* 忽略 */ }
}
console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
