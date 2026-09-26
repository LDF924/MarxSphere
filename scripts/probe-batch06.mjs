// probe-batch06.mjs — 审稿意见录入 / 逐条回应 / 回应信 端到端回归
//
// 覆盖：
//   ① 区可达：投稿与要件页里有「审稿意见与逐条回应」
//   ② 粘贴整段 → 预览拆分（**不落库**）→ 确认导入 → 真落库
//   ③ 拆条**保留原文**（不能改写 —— 原文要原样引用给编辑部）
//   ④ 逐条回应：状态由 responseType **派生**（填了=已处理，没填=待处理）
//   ⑤ 刷新后仍在 —— 这是最容易静默失效的一处（参考产品那份就只在 localStorage）
//   ⑥ 回应信：含条数统计、未采纳被标注、**未处理的也列出来**（瞒着不写编辑一审就发现少一条）
//
// ⚠ 不烧模型：本区**没有任何 LLM 调用**（拆条是启发式，刻意不走 LLM）。整套默认就能跑。
//
// 用法: node scripts/probe-batch06.mjs   (需 4173 已起, 产物已重建)
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
  ({ cdp, close } = await startCdp({ preferredPort: 31231, label: "probe-batch06", windowSize: "1600,900" }));
  await cdp("Page.navigate", { url: BASE });
  await sleep(2500);
  await evalTop(cdp, `localStorage.setItem("sag_token", ${JSON.stringify(token)}); localStorage.setItem("skf_auth_token", ${JSON.stringify(token)}); 1`);
  await evalTop(cdp, `(() => { location.hash = "#paper-outline"; return 1; })()`);
  await sleep(4000);

  const runInSoc = (body) => evalTop(cdp, `(() => {
    const f = ${SOC};
    if (!f) return "NO_IFRAME";
    try { const w = f.contentWindow; ${body} } catch (e) { return "ERR:" + e.message; }
  })()`);
  const goto = async (hash) => {
    await runInSoc(`w.location.href = w.location.origin + "/soc/index.html#" + ${JSON.stringify(hash)}; return "ok";`);
    await sleep(2600);
  };

  const boot = await evalTop(cdp, `${SOC} ? "ok" : "NO_IFRAME"`);
  t("前置: 写作舱 iframe 已挂载", boot === "ok", `实测 ${boot}`);
  if (boot !== "ok") throw new Error("iframe 没挂上");

  // 造一个项目并把指针指过去
  const p = await api(token, "/research/projects", "POST", { title: `批6返修-${Date.now()}`, status: "active" });
  pid = (p.body?.data ?? p.body)?.id ?? p.body?.project?.id ?? "";
  t("前置: 建得出测试项目", !!pid, `pid=${pid}`);
  await evalTop(cdp, `localStorage.setItem("lastTask_workflow", ${JSON.stringify(String(pid))}); 1`);
  await runInSoc(`w.location.reload(); return 1;`);
  await sleep(6500);

  // ── ① 区可达 ──
  console.log("\n═══ ① 审稿意见区可达 ═══");
  {
    await goto("/workflow/submission");
    const head = await runInSoc(`return w.document.querySelector(".rr-h2") ? w.document.querySelector(".rr-h2").innerText.trim() : "missing";`);
    t("投稿与要件页有「审稿意见与逐条回应」", head === "审稿意见与逐条回应", `实测 ${JSON.stringify(head)}`);
    const paste = await runInSoc(`return w.document.querySelector('[data-control="workflow:rr-paste"]') ? "found" : "missing";`);
    t("粘贴框在", paste === "found", `实测 ${paste}`);
  }

  // ── ② 粘贴 → 预览 → 导入 ──
  //
  // ⚠ 真实审稿意见的排版就是这几种编号混用（中文编号/数字编号/圈号/审稿人分节），
  //   所以这里刻意用一份**混合形态**的样本，而不是清一色的 "1. 2. 3."。
  const SAMPLE = [
    "审稿人1",
    "1. 引言部分缺少问题意识, 未说明本文相对既有研究的增量。",
    "2. 表 2 中 x 的系数与正文不一致, 正文写 0.42, 表里是 0.35。",
    "审稿人2",
    "① 建议补充稳健性检验。",
    "② 第三章篇幅过长, 可考虑压缩。",
  ].join("\n");

  console.log("\n═══ ② 粘贴 → 预览 → 导入 ═══");
  {
    const set = await runInSoc(`
      const el = w.document.querySelector('[data-control="workflow:rr-paste"]');
      if (!el) return "no-el";
      const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, ${JSON.stringify(SAMPLE)});
      el.dispatchEvent(new w.Event("input", { bubbles: true }));
      return "ok";
    `);
    t("粘贴样本", set === "ok", `实测 ${set}`);
    await sleep(400);

    await runInSoc(`w.document.querySelector('[data-control="workflow:rr-preview"]').click(); return "ok";`);
    await sleep(1200);
    const prev = await runInSoc(`
      const rows = [...w.document.querySelectorAll(".rr-preview-row")];
      return JSON.stringify({ n: rows.length, texts: rows.map((r) => r.innerText.replace(/\\s+/g, " ").trim()) });
    `);
    let o = {};
    try { o = JSON.parse(prev); } catch { /* 忽略 */ }
    t("预览拆出 4 条（不是 5 —— 审稿人分节不是意见）", o.n === 4, `实测 ${o.n} 条`);

    // 导入按钮上写着条数
    const importLabel = await runInSoc(`
      const b = w.document.querySelector('[data-control="workflow:rr-import"]');
      return b ? b.innerText.trim() : "missing";
    `);
    t("确认按钮标出条数", /4/.test(String(importLabel)), `实测 ${JSON.stringify(importLabel)}`);

    await runInSoc(`w.document.querySelector('[data-control="workflow:rr-import"]').click(); return "ok";`);
    await sleep(2200);

    const cards = await runInSoc(`return w.document.querySelectorAll(".rr-item").length;`);
    t("导入后渲染出 4 条意见卡", Number(cards) === 4, `实测 ${cards}`);

    // 后端回读
    const list = await api(token, `/research/projects/${pid}/review-responses`);
    const items = list.body?.items ?? [];
    t("后端确有 4 条", items.length === 4, `实测 ${items.length}`);
    t("轮次为第 1 轮", (list.body?.rounds ?? []).includes(1), `rounds=${JSON.stringify(list.body?.rounds)}`);

    /**
     * 拆条**保留原文**：不能改写 —— 原文要原样引用给编辑部("您指出『…』")。
     * 这条锁的是"将来有人图省事换成 LLM 拆条"：LLM 一定会顺手改写。
     */
    const c0 = String(items[0]?.comment ?? "");
    t("拆出来的正文与原文逐字一致（未被改写）", c0 === "引言部分缺少问题意识, 未说明本文相对既有研究的增量。", `实测 ${JSON.stringify(c0)}`);
    t("审稿人标签被记下", String(items[0]?.reviewerLabel ?? "").includes("审稿人1"), `实测 ${JSON.stringify(items[0]?.reviewerLabel)}`);
    t("第一条仍是「待处理」", items[0]?.status === "pending", `实测 ${items[0]?.status}`);
  }

  // ── ③ 逐条回应 + 状态派生 ──
  console.log("\n═══ ③ 逐条回应（状态由后端派生）═══");
  {
    // 第 1 条填回应 + 点「已修改」
    await runInSoc(`
      const ta = w.document.querySelector('[data-control="workflow:rr-response-0"]');
      const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "已在 1.2 节补充研究增量说明");
      ta.dispatchEvent(new w.Event("change", { bubbles: true }));
      return "ok";
    `);
    await sleep(900);
    await runInSoc(`w.document.querySelector('[data-control="workflow:rr-resp-revised-0"]').click(); return "ok";`);
    await sleep(1400);

    const after = await api(token, `/research/projects/${pid}/review-responses`);
    const it0 = (after.body?.items ?? [])[0] ?? {};
    t("第 1 条 responseType=revised", it0.responseType === "revised", `实测 ${it0.responseType}`);
    t("⚠ status 由后端派生为 resolved（前端不传 status）", it0.status === "resolved", `实测 ${it0.status}`);
    t("回应的正文落库了", String(it0.response ?? "").includes("1.2 节"), `实测 ${JSON.stringify(it0.response)}`);

    // 第 2 条点「未采纳」
    await runInSoc(`w.document.querySelector('[data-control="workflow:rr-resp-disagreed-1"]').click(); return "ok";`);
    await sleep(1400);
    const after2 = await api(token, `/research/projects/${pid}/review-responses`);
    const it1 = (after2.body?.items ?? [])[1] ?? {};
    t("第 2 条 responseType=disagreed", it1.responseType === "disagreed", `实测 ${it1.responseType}`);

    // 再点一次 = 撤销（回到未处理）
    await runInSoc(`w.document.querySelector('[data-control="workflow:rr-resp-disagreed-1"]').click(); return "ok";`);
    await sleep(1400);
    const after3 = await api(token, `/research/projects/${pid}/review-responses`);
    const it1b = (after3.body?.items ?? [])[1] ?? {};
    t("再点一次同选项=撤销（responseType 清空）", it1b.responseType === "", `实测 ${JSON.stringify(it1b.responseType)}`);
    t("撤销后 status 回到 pending（派生跟着走）", it1b.status === "pending", `实测 ${it1b.status}`);

    // 恢复成「未采纳」，后面验回应信要用
    await runInSoc(`w.document.querySelector('[data-control="workflow:rr-resp-disagreed-1"]').click(); return "ok";`);
    await sleep(1400);
  }

  // ── ④ 刷新后仍在 ──
  console.log("\n═══ ④ 刷新后仍在（落库, 不是 localStorage）═══");
  {
    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(6500);
    await goto("/workflow/submission");
    const n = await runInSoc(`return w.document.querySelectorAll(".rr-item").length;`);
    t("刷新后 4 条意见还在", Number(n) === 4, `实测 ${n}`);
    const kept = await runInSoc(`
      const ta = w.document.querySelector('[data-control="workflow:rr-response-0"]');
      return ta ? ta.value : "missing";
    `);
    t("刷新后回应正文还在", String(kept).includes("1.2 节"), `实测 ${JSON.stringify(kept)}`);
    const chipOn = await runInSoc(`
      const c = w.document.querySelector('[data-control="workflow:rr-resp-revised-0"]');
      return c ? (c.className.includes("is-on") ? "on" : "off") : "missing";
    `);
    t("刷新后「已修改」仍是选中态", chipOn === "on", `实测 ${chipOn}`);
  }

  // ── ⑤ 回应信 ──
  console.log("\n═══ ⑤ 回应信 ═══");
  {
    await runInSoc(`w.document.querySelector('[data-control="workflow:rr-gen-letter"]').click(); return "ok";`);
    await sleep(1800);
    const md = await runInSoc(`
      const el = w.document.querySelector('[data-control="workflow:rr-letter"]');
      return el ? el.innerText : "missing";
    `);
    const s = String(md);
    t("回应信渲染出来了", s !== "missing" && s.length > 50, `长度 ${s.length}`);
    t("含条数统计", /共收到 4 条意见/.test(s), `实测 ${s.slice(0, 60).replace(/\n/g, " ")}`);
    t("已处理的条数正确（1 条已修改 / 1 条未采纳 = 2）", /已处理 2 条/.test(s), `实测 ${s.slice(0, 60).replace(/\n/g, " ")}`);
    t("「未采纳」被标注", s.includes("未采纳"), `含=${s.includes("未采纳")}`);
    t("「尚未处理」被列出（瞒着不写编辑一审就发现少一条）", s.includes("尚未处理"), `含=${s.includes("尚未处理")}`);
    t("分轮次小节", s.includes("第 1 轮"), `含=${s.includes("第 1 轮")}`);
    t("原文引用出来了", s.includes("表 2 中 x 的系数与正文不一致"), `含=${s.includes("表 2")}`);
  }

  // ── ⑥ 投稿记录 ──
  console.log("\n═══ ⑥ 投稿记录 ═══");
  {
    await runInSoc(`w.document.querySelector('[data-control="workflow:sub-add"]').click(); return "ok";`);
    await sleep(1600);
    const rows = await runInSoc(`return w.document.querySelectorAll(".rr-sub").length;`);
    t("点「记一次投稿」加出一行", Number(rows) === 1, `实测 ${rows}`);

    // 填期刊名 + 状态（date 已在 addSubmission 里预填今天）
    await runInSoc(`
      const j = w.document.querySelector('[data-control="workflow:sub-journal-0"]');
      const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set;
      setter.call(j, "马克思主义研究");
      j.dispatchEvent(new w.Event("change", { bubbles: true }));
      return "ok";
    `);
    await sleep(1000);
    await runInSoc(`
      const s = w.document.querySelector('[data-control="workflow:sub-status-0"]');
      s.value = "under_review";
      s.dispatchEvent(new w.Event("change", { bubbles: true }));
      return "ok";
    `);
    await sleep(1000);

    const sub = await api(token, `/research/projects/${pid}/submissions`);
    const s0 = (sub.body?.submissions ?? [])[0] ?? {};
    t("投稿记录落库（期刊名）", s0.journalName === "马克思主义研究", `实测 ${JSON.stringify(s0.journalName)}`);
    t("状态落库（外审中）", s0.status === "under_review", `实测 ${s0.status}`);
    /**
     * ⚠ 日期是 `date` 列。用 `toISOString()` 会在 +08:00 下**退一天**
     *   (date 被 pg 解析成当地 00:00 再转 UTC) —— 投稿日期差一天会被编辑部抓。
     */
    const today = new Date();
    const want = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    t("日期回读不差一天（不走 UTC）", s0.submittedOn === want, `实测 ${s0.submittedOn} 期望 ${want}`);

    // 刷新后仍在
    await runInSoc(`w.location.reload(); return 1;`);
    await sleep(6500);
    await goto("/workflow/submission");
    const kept = await runInSoc(`
      const j = w.document.querySelector('[data-control="workflow:sub-journal-0"]');
      return j ? j.value : "missing";
    `);
    t("刷新后投稿记录还在", String(kept) === "马克思主义研究", `实测 ${JSON.stringify(kept)}`);

    // 删掉
    await runInSoc(`w.document.querySelector('[data-control="workflow:sub-del-0"]').click(); return "ok";`);
    await sleep(1600);
    const after = await api(token, `/research/projects/${pid}/submissions`);
    t("删除后库里也没了", (after.body?.submissions ?? []).length === 0, `实测 ${(after.body?.submissions ?? []).length}`);
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
