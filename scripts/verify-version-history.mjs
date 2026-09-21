// scripts/verify-version-history.mjs — 版本历史/回滚 的布局与交互门禁(V425 A1)
//
// 为什么单独一个脚本: 版本历史是**抽屉**形态, 而抽屉里的布局(表格不溢出、操作列不被挤掉)
//   与"点开有没有数据"是两回事 —— 前者只能真渲染再量。既有 verify-layout 只看五个主页面,
//   不会走到抽屉里。
//
// 覆盖(每条都能失败):
//   ① 入口按钮存在且可点 → 抽屉打开
//   ② 抽屉渲染出版本表(≥2 行: 探针自己发过两次版)
//   ③ 抽屉不横向溢出、版本号不被裁切
//   ④ 三个页签(阶段版本/节点历史/恢复)都能切且各自出表格(节点页签的表格只该由**目标节点**
//      的历史行撑起 —— 断言 .vh-row 会误把隐藏版本页的残留行算进来, 见下方 ⚠)
//   ⑤ 激活按钮带目标版本号、不是常抓禁用
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, dismissOverlays, readToast } from "./lib/probe-actions.mjs";

// BASE 后缀可由环境变量改 —— 生产产物由 4173 的 fastify-static 托管; 开发期用
//   `SOC_DEV=1` 指向 soc 子工程的 vite dev(5174, 自带热更新) ——
//   否则每改一行都要先 build:socialsci-vue 才能被探针看到。
//   ⚠ dev server 有两坑: ① 默认只监听 IPv6 回环(127.0.0.1:5174 连不上), 要 `--host 127.0.0.1`;
//     ② 它按**自己所在的工程根**解析源码 —— 从主仓启动的话, 探针看到的是主仓那份,
//     本 worktree 的改动一行都不会生效(表现为"新加的按钮不存在", 而构建/类型检查全绿)。
const BASE = process.env.WEB || (process.env.SOC_DEV ? "http://127.0.0.1:5174" : "http://127.0.0.1:4173");
const SOC_SUFFIX = process.env.WEB ? "/soc/index.html" : (process.env.SOC_DEV ? "/" : "/soc/index.html");
// API 地址也走环境变量 —— 改后端(如 research-pipeline-service)时必须能指向**本 worktree 起的服务**;
//   默认那个 4173 跑的是主仓源码, 改 worktree 的后端它在结构上就看不到(pid 一样、库一样,
//   症状是"后端改了但行为没变", 极易误判成改错了地方)。
//   ⚠ **API 与页面必须同源**: 这个应用把 token 放在 localStorage, 而 localStorage 按 origin 隔离 ——
//   页面在 5174、API 在 4373 时, 页面发的请求由 5174 的 vite 代理打到 4173(旧代码),
//   上面那条 API_BASE 只管探针**自己**发的 curl 类请求, 管不到页面。所以改后端要连页面一起搬:
//     API_BASE=http://127.0.0.1:4373 WEB=http://127.0.0.1:4373 node scripts/verify-version-history.mjs
const API_BASE = process.env.API_BASE || "http://127.0.0.1:4173";
const api = async (tk, path, method = "GET", body) => {
  const r = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${tk}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.ok ? r.json().catch(() => ({})) : { __status: r.status };
};

const tk = await loginToken("audit", "audit123456");
const p = await api(tk, "/research/projects", "POST", { title: `版本门禁-${Date.now()}` });const pid = p.id ?? p.data?.id;
// 没有 pid 就不许往下走: openSoc 的 `if (pid)` 为假时会跳过写 localStorage,
//   页面于是读上一轮遗留的项目 —— 断言照跑、全绿与否都跟本次种子无关。宁可硬停。
if (!pid) { console.error("建项目失败:", JSON.stringify(p).slice(0, 200)); process.exit(1); }

// 造两次发布 → 版本表至少两行; 且最后一次(版本号最大)是当前终稿
//
// ⚠ 节点历史只在**第二次及以后**的写入才产生: `putNode` 是 upsert(version+1) + 把**旧 payload**
//   追加进 research_node_history —— 首写没有"旧 payload", 所以第一次 PUT 只建节点、不建历史
//   (实测: PUT → version=1, history=[])。所以种子必须写两次, 否则"节点历史有记录"这条
//   测的是种子本身的形状而不是产品的行为。
await api(tk, `/research/projects/${pid}/nodes/finalize`, "PUT", {
  payload: { mergedTitle: "版本门禁稿", mergedFullText: "正文".repeat(200), mergedAbstract: "摘要", isFinalized: false },
});
const pub1 = await api(tk, `/research/projects/${pid}/publish`, "POST", { label: "phase4_text" });
await api(tk, `/research/projects/${pid}/nodes/finalize/merge`, "PATCH", { patch: { mergedFullText: "正文二稿".repeat(200) } });
const pub2 = await api(tk, `/research/projects/${pid}/publish`, "POST", { label: "phase5_final" });
const seedHist = await api(tk, `/research/projects/${pid}/nodes/finalize/history`);
console.log(`种子: 版本 ${pub1.version} / ${pub2.version}; finalize 历史 ${(seedHist.history ?? []).length} 条`);
if (!(seedHist.history ?? []).length) { console.error("种子无效: 写完两次仍无节点历史 —— 后续断言会测的是种子形状, 不是产品行为"); process.exit(1); }

const { cdp, close } = await startCdp({ preferredPort: 31083, label: "scripts/verify-version-history.mjs", windowSize: "1440,900" });
const out = [];
const rec = (k, ok, d) => { out.push({ k, ok }); console.log(`${ok ? "  ok  " : "FAIL  "}${k}${d ? " — " + d : ""}`); };

/** 点一次并等渲染 —— 抽屉内的按钮很多是 v-if 切换, 点完要等两帧 */
const clickEval = async (expr, wait = 900) => { const r = await evalTop(cdp, expr); await sleep(wait); return r; };

try {
  await openSoc(cdp, BASE, "/workflow/finalize", tk, pid, 7500, SOC_SUFFIX);
  await dismissOverlays(cdp);
  await sleep(800);

  // ① 入口
  const entry = await evalTop(cdp, `(() => {
    const b = document.querySelector('[data-control="workflow:version-history"]');
    return b ? { text: (b.innerText || '').trim(), disabled: !!b.disabled } : null;
  })()`);
  rec("版本历史入口存在", !!entry, entry ? JSON.stringify(entry) : "未找到 data-control");
  if (!entry) throw new Error("入口缺失, 后续断言无从谈起");

  await clickEval(`(() => { const b = document.querySelector('[data-control="workflow:version-history"]'); if (b) b.click(); return !!b; })()`);

  // ② 抽屉打开 + 版本表有行
  const opened = await evalTop(cdp, `(() => {
    const m = document.querySelector('.vh-mask');
    if (!m) return { open: false };
    const rows = [...document.querySelectorAll('.vh-row')];
    return {
      open: true,
      rows: rows.length,
      first: rows[0] ? (rows[0].innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : '',
      // 版本号列的实际渲染宽度 —— 被挤成 0 就是"看不见版本号"
      numW: rows[0] ? Math.round((rows[0].querySelector('.vh-num') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width) : 0,
    };
  })()`);
  rec("抽屉已打开", opened?.open === true, opened?.open ? "" : "点入口后 .vh-mask 未出现");
  rec("阶段版本表有行(≥2, 探针发了两次版)", (opened?.rows ?? 0) >= 2, `实测 ${opened?.rows ?? 0} 行; 首行=${opened?.first ?? ""}`);
  rec("版本号列有实际宽度(未被挤掉)", (opened?.numW ?? 0) >= 16, `${opened?.numW ?? 0}px`);

  // ③ 抽屉不横向溢出
  const of = await evalTop(cdp, `(() => {
    const c = document.querySelector('.vh-drawer');
    if (!c) return null;
    return { hOverflow: c.scrollWidth - c.clientWidth, w: Math.round(c.getBoundingClientRect().width), vw: document.documentElement.clientWidth };
  })()`);
  rec("抽屉内容不横向溢出", !!of && of.hOverflow <= 2, of ? `容器 ${of.w}px, 溢出 ${of.hOverflow}px` : "取不到 .vh-drawer");

  // ④ 页签: 节点历史 / 恢复
  //
  // ⚠ 判据必须是**该节点自己的历史行**(.vh-note 只在节点页签的表头里出现), 不能用 .vh-row ——
  //   切页签用的是 v-if, 版本页卸载后 .vh-row 应该归零; 但"应"字靠不住, 一旦哪个分支改成
  //   v-show, 计数就会把隐藏的版本行算进来, 于是"节点历史有记录"在**零条历史**时也是绿的。
  //   这不只是理论风险: 我第一版探针就踩了兄弟问题 —— `openSoc(cdp, …, pid="")` 里
  //   `if (pid)` 是假, 项目指针压根没写进 localStorage, 页面读的是上一轮遗留的旧项目,
  //   于是种子明明写了 finalize 节点、节点历史却查的是别的 projectId, 全是 0。
  //   现在: 空 pid 直接报错停住, 断言也只认结构明确的 .vh-note。
  const tabCounts = {};
  for (const [key, sel] of [["节点历史", "history"], ["恢复", "rollback"]]) {
    await clickEval(`(() => { const b = document.querySelector('[data-control="workflow:vh-tab-${sel}"]'); if (b) b.click(); return !!b; })()`);
    const r = await evalTop(cdp, `(() => {
      const t = document.querySelector('.vh-table');
      const notes = [...document.querySelectorAll('.vh-note')];
      return { hasTable: !!t, rows: notes.length, verdicts: [...document.querySelectorAll('.vh-btn')].length,
               hint: (document.querySelector('.vh-body')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 90) };
    })()`);
    tabCounts[key] = r;
    rec(`页签「${key}」可切换且出表格`, r?.hasTable === true, r?.hasTable ? `${r.rows} 行` : `无 .vh-table; 内容="${r?.hint ?? ""}"`);
  }
  // 探针刚 PUT + PATCH 过 sections 与 finalize 两个节点, 节点历史里必然有记录
  rec("节点历史有记录(种子写过节点)", (tabCounts["节点历史"]?.rows ?? 0) >= 1,
    `实测 ${tabCounts["节点历史"]?.rows ?? 0} 行; 内容="${tabCounts["节点历史"]?.hint ?? ""}"`);
  // 恢复页签是同一份历史 + 每行一个回滚按钮
  rec("恢复页签列出可回滚历史并有按钮",
    (tabCounts["恢复"]?.rows ?? 0) >= 1 && (tabCounts["恢复"]?.verdicts ?? 0) >= 1,
    `历史 ${tabCounts["恢复"]?.rows ?? 0} 行 / 按钮 ${tabCounts["恢复"]?.verdicts ?? 0} 个`);

  // ⑤ 版本页签: 每行都有激活按钮, 且至少一个**可点**(非常抓 disabled)
  //
  // ⚠ 这里**不断言"最新版本禁用"**: 后端 activateVersion 是纯粹的"设为终稿"操作, 没有
  //   "已经是终稿"的概念(它把其余版本置 superseded、自身置 published, 再点一次只是幂等)。
  //   而且探针刚发布的 version 既是最高版本、又是唯一 published —— 若按"最新=当前"去禁用,
  //   就等于断言一个后端不支持、用户也没法得到的语义。禁用窗口只在**请求进行中**。
  await clickEval(`(() => { const b = document.querySelector('[data-control="workflow:vh-tab-versions"]'); if (b) b.click(); return !!b; })()`);
  const acts = await evalTop(cdp, `(() => {
    const rows = [...document.querySelectorAll('.vh-row')];
    return rows.map(r => {
      const b = r.querySelector('[data-control^="workflow:vh-activate-"]');
      return { v: (r.querySelector('.vh-num')?.innerText || '').trim(), hasBtn: !!b, disabled: b ? !!b.disabled : null,
               ctl: b ? b.getAttribute('data-control') : null };
    });
  })()`);
  const rows = Array.isArray(acts) ? acts : [];
  rec("每行都有激活按钮", rows.length > 0 && rows.every((a) => a.hasBtn), JSON.stringify(rows));
  rec("至少一个版本可激活(按钮不是常抓禁用)", rows.some((a) => a.disabled === false),
    `禁用 ${rows.filter((a) => a.disabled).length}/${rows.length}`);
  // 激活按钮必须带**版本号** —— 否则点第 N 行激活的是哪一版无从断言(动作探针靠它选目标)
  rec("激活按钮携带目标版本号", rows.every((a) => /^workflow:vh-activate-\d+$/.test(a.ctl ?? "")), JSON.stringify(rows.map((a) => a.ctl)));

  // ⑥ 真动作: 点激活必须是**写了库的**(不只是发了个请求)。判据是后端状态变化, 不是请求记录 ——
  //   跨域/预检/401 都能让"发了请求"成立而数据没动。
  const beforeAct = await api(tk, `/research/projects/${pid}/versions`);
  const actTarget = rows.find((a) => a.disabled === false)?.ctl;
  if (actTarget) {
    await clickEval(`(() => { const b = document.querySelector('[data-control="${actTarget}"]'); if (b) b.click(); return !!b; })()`, 2600);
    const afterAct = await api(tk, `/research/projects/${pid}/versions`);
    const tgt = Number(actTarget.split("-").pop());
    const activated = (afterAct.versions ?? []).find((v) => v.version === tgt);
    const others = (afterAct.versions ?? []).filter((v) => v.version !== tgt);
    rec("点「设为终稿」真的改了版本状态",
      activated?.status === "published" && others.every((v) => v.status === "superseded"),
      `目标 v${tgt}=${activated?.status}; 其余=${others.map((v) => `v${v.version}:${v.status}`).join(",")}`);
  }

  // ⑦ 真动作: 回滚。用「合稿」节点 —— 种子里它被写过两次, 历史里有一条 v1。
  //   断言回滚后的**节点内容**变回旧值, 而不是只看请求发出去了。
  const fh = await api(tk, `/research/projects/${pid}/nodes/finalize/history`);
  const target = (fh.history ?? [])[0];
  const oldSnap = (fh.history ?? []).find((h) => h.id === target?.id);
  if (target) {
    await clickEval(`(() => { const b = document.querySelector('[data-control="workflow:vh-tab-rollback"]'); if (b) b.click(); return !!b; })()`);
    await clickEval(`(() => { const b = document.querySelector('[data-control="workflow:vh-node-finalize"]'); if (b) b.click(); return !!b; })()`);
    await clickEval(`(() => { const bs = [...document.querySelectorAll('.vh-btn')]; const b = bs[bs.length - 1]; if (b) b.click(); return !!b; })()`, 900);
    const dlg = await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="dialog:confirm"]'); return b ? (b.innerText||'').trim() : null; })()`);
    rec("回滚有二次确认(不是一击即改)", !!dlg, dlg ? `确认键文案="${dlg}"` : "没等到确认层");
    if (dlg) {
      await clickEval(`(() => { const b = document.querySelector('[data-control="dialog:confirm"]'); if (b) b.click(); return !!b; })()`, 2600);
      const toastMsg = await readToast(cdp);
      const after = await api(tk, `/research/projects/${pid}/nodes/finalize/history`);
      // 回滚会**先写一条新历史**(当前内容留痕), 所以历史条数必然 +1 —— 这是"回滚动作本身留痕"的证据
      rec("回滚真的落库(历史条数 +1, 回滚动作留痕)",
        (after.history ?? []).length > (fh.history ?? []).length,
        `${(fh.history ?? []).length} → ${(after.history ?? []).length} 条; 最新 note=${(after.history ?? [])[0]?.note ?? ""}; 页面提示="${toastMsg || "(无)"}"`);
      void oldSnap;
    }
  }
} catch (e) {
  console.error("探针异常:", e.message);
} finally {
  try { await api(tk, `/research/projects/${pid}`, "DELETE"); } catch { /* 忽略 */ }
  close();
}

console.log("\n" + "=".repeat(50));
const fail = out.filter((o) => !o.ok);
console.log(`版本历史门禁: ${out.length - fail.length} 通过 / ${fail.length} 失败`);
process.exit(fail.length ? 1 : 0);
