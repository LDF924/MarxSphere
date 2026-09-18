// scripts/probe-finalize-component-gen.mjs — 合稿页「论文要件生成」动作探针(摘要/关键词/结论)
//
// 覆盖表第七轮。这三个动作此前没验过: 它们是**同步**接口(`POST /paper-outline/component`,
//   直接等 LLM 返回, 不是任务泵), 失败路径与前面几轮都不同 —— 没有轮询、没有任务态,
//   全靠 try/catch + toast。
//
// 验什么:
//   · 三个按钮各自打到哪个接口、参数对不对(kind/topic/sections/chapterContents)
//   · 生成后**并回同级章节**的行为: 已有同名 → 覆盖内容; 没有 → 在最前补一个
//   · 落库(saveProject → workbench 快照)
//   · 生成期间三个按钮一起禁用(componentBusy), 防重入
//   · 缺标题时的门禁
//
// 用法: node scripts/probe-finalize-component-gen.mjs        (需 4173 已起; 真调 LLM, 慢)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, probeAction, waitFor, readToast } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
const rows = [];
function rec(action, kind, detail) {
  rows.push({ action, kind, detail });
  const tag = kind === "ok" ? "  ok  " : kind === "dead" ? " DEAD " : kind === "gated" ? " gated" : kind === "err" ? " ERR  " : " skip ";
  console.log(`${tag} ${action} — ${detail}`);
}
const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.ok ? r.json().catch(() => ({})) : { __status: r.status };
};
const short = (u) => String(u ?? "").replace(BASE, "").replace("/api/research", "").slice(0, 70);
async function pollToast(cdp, n = 12) {
  let fb = "";
  for (let i = 0; i < n && !fb; i++) { await sleep(300); fb = (await readToast(cdp)) || ""; }
  return fb;
}
/**
 * 等某个要件按钮回到可用态(= 这次生成结束)。
 * ⚠ 同步接口要**等到结束**才能判结果 —— 早读会读到"还没写进去"而误报失败(实测踩到)。
 *   超时返回 false, 由调用方如实记 ERR。
 */
async function waitIdle(cdp, kind, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await evalTop(cdp, `(() => {
      const b = document.querySelector('[data-control="workflow:gen-${kind}"]');
      return b ? { d: b.disabled, t: b.textContent.trim() } : null;
    })()`);
    if (st && !st.d) return true;
    await sleep(1500);
  }
  return false;
}
/** 该要件在快照 sections 里的字数(−1 = 不存在) */
async function secLen(token, pid, title) {
  const snap = await api(token, `/research/projects/${pid}/workbench`);
  const s = (snap?.snapshot?.sections ?? []).find((x) => x.title === title);
  return s ? String(s.content ?? "").length : -1;
}

/** 播种: 已合稿的终稿(要件按钮需要 store.sections 非空 + 有标题) */
async function seed(token, { withTitle = true } = {}) {
  const TITLE = withTitle ? `要件探针-${Date.now()}` : "";
  const proj = await api(token, "/research/projects", "POST", { title: TITLE || "未命名", status: "in-progress", phase: 5, phaseLabel: "合稿定稿" });
  const pid = (proj?.data ?? proj)?.id;
  if (!pid) return null;
  const INPUT = { title: TITLE, outline: "一、引言\n二、文献综述", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] };
  const sections = [
    { id: "sec_0", title: "引言", level: 1, order: 0, status: "done", content: "引言正文。" .repeat(20) },
    { id: "sec_1", title: "文献综述", level: 1, order: 1, status: "done", content: "综述正文。".repeat(20) },
  ];
  await api(token, `/research/projects/${pid}/nodes/input`, "PUT", { payload: { input: INPUT, sections } });
  await api(token, `/research/projects/${pid}/nodes/sections`, "PUT", { payload: { sections } });
  await api(token, `/research/projects/${pid}/workbench`, "PUT", {
    snapshot: { phase: 5, phaseLabel: "合稿定稿", input: INPUT, sections, variables: [], hypotheses: [] },
  });
  // 合稿态(要件卡只在 sections 非空时渲染; mergeGenerated 影响导出区, 这里不需要)
  // ⚠ withTitle:false 时必须把 mergedTitle 也留**空** —— 若回落成"未命名", `topic` 就非空,
  //   缺标题门禁根本不会触发, ⑤ 会误报"拦不住"(第一版就是这么假失败的)。
  await api(token, `/research/projects/${pid}/nodes/finalize`, "PUT", {
    payload: { mergedTitle: TITLE, mergedAbstract: "", mergedKeywords: "", mergedFullText: "合稿正文。" .repeat(30), mergedReferences: "" },
  });
  return { pid };
}

const { cdp, ev, close } = await startCdp({ preferredPort: 31065, label: "probe-finalize-component-gen" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");
  const s = await seed(token);
  if (!s?.pid) throw new Error("播种失败");
  console.log(`项目 ${s.pid}\n`);

  await openSoc(cdp, BASE, "/workflow/finalize", token, s.pid);
  await spyInstall(cdp);

  // ── ① 入口存在性 + 门禁 ──
  console.log("\n═══ ① 要件生成入口 ═══");
  {
    const st = await evalTop(cdp, `(() => {
      const pick = (k) => { const b = document.querySelector('[data-control="workflow:gen-' + k + '"]'); return b ? { has: true, text: b.textContent.trim(), disabled: b.disabled } : { has: false }; };
      return { abstract: pick('abstract'), keywords: pick('keywords'), conclusion: pick('conclusion') };
    })()`);
    const n = [st?.abstract, st?.keywords, st?.conclusion].filter((x) => x?.has).length;
    rec("三个要件按钮都在(摘要/关键词/结论)", n === 3 ? "ok" : "ERR",
      `${n}/3 文案=${JSON.stringify([st?.abstract?.text, st?.keywords?.text, st?.conclusion?.text])}`);
    rec("初始都不禁用", [st?.abstract, st?.keywords, st?.conclusion].every((x) => x?.has && !x?.disabled) ? "ok" : "ERR",
      `disabled=${JSON.stringify([st?.abstract?.disabled, st?.keywords?.disabled, st?.conclusion?.disabled])}`);
  }

  // ── ② 生成摘要(同步接口: 发请求 → 等返回 → 并回章节 + 落库) ──
  console.log("\n═══ ② 生成摘要(同步接口) ═══");
  {
    const r = await probeAction(cdp, '[data-control="workflow:gen-abstract"]', { wait: 1200 });
    const req = r.apiReqs.find((x) => /paper-outline\/component/.test(x.url));
    rec("gen-abstract 打到 /paper-outline/component", req ? "ok" : "DEAD",
      req ? `POST ${short(req.url)}` : `零请求 toast=${r.toast.slice(0, 50)}`);
    if (req) {
      // 参数形状: kind + topic + sections + chapterContents
      let body = {};
      try { body = JSON.parse(String(req.body ?? "{}")); } catch { /* 保持空 */ }
      rec("请求参数形状(kind/topic/sections/chapterContents)",
        body.kind === "abstract" && typeof body.topic === "string" && Array.isArray(body.sections) && Array.isArray(body.chapterContents) ? "ok" : "ERR",
        `kind=${body.kind} topic="${String(body.topic).slice(0, 16)}" sections=${body.sections?.length} chapterContents=${body.chapterContents?.length}`);
      // 章节清单不能把"摘要/关键词/结论"再喂回去(否则递归生成要件)
      const leaked = (body.sections ?? []).filter((t) => ["摘要", "关键词", "结论"].includes(String(t)));
      rec("送审章节不含要件本身", leaked.length === 0 ? "ok" : "ERR", `混入=${JSON.stringify(leaked)}`);
    }

    /**
     * 生成期间三个按钮应**一起**禁用(componentBusy), 防重入。
     * ⚠ 采样时机很关键: 这是个同步等 LLM 的请求(几秒~几十秒), 但 `probeAction` 已经
     *   `await` 了一段 —— 晚读会读到"已经解禁"而误判失败。这里改成**连点后立刻高频采样**,
     *   采到过 `true` 即证明防重入生效; 若全程 false 且接口是秒回, 则如实记 skip。
     */
    let sawBusy = null;
    for (let i = 0; i < 40; i++) {
      const b = await evalTop(cdp, `(() => {
        const a = document.querySelector('[data-control="workflow:gen-abstract"]');
        return a ? { d: a.disabled, t: a.textContent.trim() } : null;
      })()`);
      if (b?.d) { sawBusy = b; break; }
      if (b?.t === "生成摘要") { await sleep(200); continue; }   // 还没进入忙碌态
      await sleep(200);
    }
    rec("生成期间按钮呈忙碌态(防重入)", sawBusy ? "ok" : "skip",
      sawBusy ? `已采到 disabled=true 文案="${sawBusy.t}"` : "未采到忙碌态(接口过快或已完成)");

    const done = await waitIdle(cdp, "abstract");
    rec("摘要生成结束(按钮回可用)", done ? "ok" : "ERR", done ? "已结束" : "180s 内未结束");
    const absLen = await secLen(token, s.pid, "摘要");
    rec("生成后并回同级章节(摘要)", absLen > 10 ? "ok" : "ERR", `摘要字数=${absLen}`);
    /**
     * **刷新后仍在** —— 这才是真判据。
     * 回读是"节点优先"(getWorkbenchSnapshot 对 sections 是节点无条件赢), 只写 workbench
     * 快照列的话, 这里刷新就没了(实测: 弹了"已生成 341 字", 重载后章节表里没有摘要)。
     */
    await cdp("Page.reload");
    await sleep(9000);
    const absAfter = await secLen(token, s.pid, "摘要");
    rec("刷新后摘要仍在(快照与 sections 节点口径一致)", absAfter > 10 ? "ok" : "ERR",
      `重载后摘要字数=${absAfter}${absAfter <= 0 ? " ← 只写快照列, 被节点回读盖掉" : ""}`);
    await spyInstall(cdp);
  }

  // ── ③ 再生成一次 → 应当**覆盖**同名章节而不是又补一个 ──
  console.log("\n═══ ③ 重复生成不产生重复章节 ═══");
  {
    await probeAction(cdp, '[data-control="workflow:gen-keywords"]', { wait: 1200 });
    await waitIdle(cdp, "keywords");
    await probeAction(cdp, '[data-control="workflow:gen-keywords"]', { wait: 1200 });
    await waitIdle(cdp, "keywords");
    const snap = await api(token, `/research/projects/${s.pid}/workbench`);
    const secs = snap?.snapshot?.sections ?? [];
    const kws = secs.filter((x) => x.title === "关键词");
    rec("重复生成不产生重复章节(覆盖同名)", kws.length === 1 ? "ok" : "ERR",
      `「关键词」章节数=${kws.length} 全部章节=${JSON.stringify(secs.map((x) => x.title))}`);
  }

  // ── ④ 结论 + 落库复核 ──
  console.log("\n═══ ④ 生成结论 ═══");
  {
    const r = await probeAction(cdp, '[data-control="workflow:gen-conclusion"]', { wait: 1500 });
    const req = r.apiReqs.find((x) => /paper-outline\/component/.test(x.url));
    let body = {};
    try { body = JSON.parse(String(req?.body ?? "{}")); } catch { /* 空 */ }
    rec("gen-conclusion 参数 kind=conclusion", req && body.kind === "conclusion" ? "ok" : "DEAD",
      req ? `kind=${body.kind}` : "零请求");
    await waitIdle(cdp, "conclusion");
    const snap = await api(token, `/research/projects/${s.pid}/workbench`);
    const secs = snap?.snapshot?.sections ?? [];
    const con = secs.find((x) => x.title === "结论");
    rec("结论并回章节且落库", con && String(con.content ?? "").length > 10 ? "ok" : "ERR",
      `章节=${JSON.stringify(secs.map((x) => x.title))} 结论字数=${String(con?.content ?? "").length}`);
    rec("三个要件都在最终章节表里", ["摘要", "关键词", "结论"].every((t) => secs.some((x) => x.title === t)) ? "ok" : "ERR",
      `章节=${JSON.stringify(secs.map((x) => x.title))}`);
  }

  // ── ⑤ 门禁: 无标题时应拦下 ──
  console.log("\n═══ ⑤ 缺标题门禁 ═══");
  {
    const s2 = await seed(token, { withTitle: false });
    await openSoc(cdp, BASE, "/workflow/finalize", token, s2.pid);
    await spyInstall(cdp);
    // 标题清空(播种时 input.title 为空, 但 mergedTitle 可能回落成"未命名"; 这里直接清干净)
    await evalTop(cdp, `(() => {
      const t = document.querySelector('.finale-card .f-title');
      if (!t) return 'no-input';
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(t, '');
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return 'cleared';
    })()`);
    await sleep(1200);
    // ⚠ wait 要短: toast 只活约 3.2s, 先等 2s 再去读必然读到空(实测踩到)
    const r = await probeAction(cdp, '[data-control="workflow:gen-abstract"]', { wait: 700 });
    const called = r.apiReqs.some((x) => /paper-outline\/component/.test(x.url));
    const fb = await pollToast(cdp, 8);
    rec("无标题时拦下并提示", !called && /标题/.test(fb) ? "ok" : (called ? "ERR" : "ERR"),
      `发了请求=${called} 提示="${fb.slice(0, 40)}"`);
  }

  console.log("\n════════ 汇总 ════════");
  const bad = rows.filter((r) => r.kind === "ERR" || r.kind === "DEAD");
  for (const r of rows) console.log(`${r.kind.padEnd(6)} ${r.action}`);
  console.log(bad.length ? `\n❌ ${bad.length} 项异常` : `\n✅ ${rows.length} 项全部通过`);
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error("探针异常:", e.message, e.stack?.split("\n")[1] ?? "");
  process.exitCode = 1;
} finally {
  await close();
}
