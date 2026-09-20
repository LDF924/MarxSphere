// scripts/probe-writing-cabin-v419.mjs — 写作舱 V419 三项「加法」的真链路探针
//
// 这三项都是**后端能力早已就绪、写作舱零引用**的现成料, 这轮才接上:
//   ① 质量四检  POST /api/quality/{concept,citation,logic,plagiarism}  → 合稿页第 ②·5 轮
//   ② 语料库    POST /api/writing-corpus/recall                        → 创作台助手面板
//   ③ 素材筛选与批量(纯前端筛选 + 复用已有 DELETE /research/materials/:id)
//
// 为什么单开套件: 这三条链**从来没被任何门禁覆盖过** —— 接上后如果只验"按钮在",
//   那么"点了没反应/请求打到错端点/返回解析不出来"全都会漏。所以每条都验到**副作用**:
//   ① 真发出 4 个请求且都 200, 且界面上真出现四张卡的判定文案
//   ② 真召回出条目(或如实显示"暂无"), 插入按钮真把文本写进 textarea
//   ③ 搜索框真把列表筛短, 批量选择真改变选中数
//
// 用法: node scripts/probe-writing-cabin-v419.mjs        (需 4173 已起; 不调 LLM, 秒级)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, spyClear, spyLog, probeAction, dismissOverlays } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
const rows = [];
function rec(action, kind, detail) {
  rows.push({ action, kind, detail });
  const tag = kind === "ok" ? "  ok  " : kind === "dead" ? " DEAD " : kind === "gated" ? " gated" : kind === "err" ? " ERR  " : " skip ";
  console.log(`${tag} ${action} — ${detail}`);
}
const short = (u) => String(u ?? "").replace(BASE, "").replace("/api", "").slice(0, 60);

const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const { cdp, close } = await startCdp({ preferredPort: 31089, label: "probe-v419" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");

  // ── 播种: 一个有正文 + 一章已生成的项目(质量四检要 mergedFullText 才让点; 素材筛选要有素材) ──
  const proj = await api(token, "/research/projects", "POST", { title: "V419 加法探针" });
  const pid = proj.json?.id;
  rec("造测试项目", pid ? "ok" : "err", pid ? `id=${pid}` : `HTTP ${proj.status}`);
  if (!pid) throw new Error("建项目失败");

  const SEC_TEXT = "资本下乡指工商资本进入农村从事农业经营，村级治理包括村民自治与公共服务供给。";
  await api(token, `/research/projects/${pid}/workbench`, "PUT", {
    snapshot: {
      input: { title: "V419 加法探针", topic: "资本下乡" },
      sections: [{ id: "sec_0", title: "引言", level: 1, content: SEC_TEXT, status: "generated" }],
      mergedFullText: SEC_TEXT + "本文认为资本下乡对村级治理的影响存在异质性。",
      mergedReferences: "[1] 张三. 资本下乡研究[J]. 社会学研究, 2020(3): 1-20.",
      mergeGenerated: true,
    },
  });
  const mats = await api(token, "/research/materials", "POST", {
    projectId: pid, kind: "theory", title: "探针素材甲", contentMd: "素材甲正文：关于资本下乡的讨论。",
  });
  await api(token, "/research/materials", "POST", {
    projectId: pid, kind: "literature", title: "探针素材乙", contentMd: "素材乙正文：村级治理的既有研究。",
  });
  rec("播种素材两条", mats.status < 400 ? "ok" : "err", `HTTP ${mats.status}`);

  // ══ ① 质量四检(合稿页 ②·5 轮) ══
  console.log("\n═══ ① 质量四检 /workflow/finalize ═══");
  await openSoc(cdp, BASE, "/workflow/finalize", token, pid, 7500);
  await spyInstall(cdp);
  const btn = await evalTop(cdp, `(() => {
    const b = document.querySelector('[data-control="workflow:quality-check"]');
    return b ? { exists: true, disabled: b.disabled, text: b.textContent.trim() } : { exists: false };
  })()`);
  rec("[四检] 按钮存在且可点", btn?.exists && !btn.disabled ? "ok" : "skip",
    btn?.exists ? `文案="${btn.text}" 禁用=${btn.disabled}` : "本页未渲染该按钮(需先有合稿正文)");
  if (btn?.exists && !btn.disabled) {
    const r = await probeAction(cdp, '[data-control="workflow:quality-check"]', { wait: 25000 });
    const qs = (r.apiReqs ?? []).filter((x) => /\/quality\//.test(x.url));
    const okAll = qs.length >= 4 && qs.every((x) => x.status === 200);
    rec("[四检] 真发出 4 个检查请求且全 200", okAll ? "ok" : "DEAD",
      qs.length ? qs.map((x) => `${short(x.url)}→${x.status}`).join(" ") : `零请求(共 ${(r.apiReqs ?? []).length} 个)`);
    const cards = await evalTop(cdp, `(() => {
      const cs = [...document.querySelectorAll('.q-card')];
      return { n: cs.length, texts: cs.map(c => (c.textContent||'').replace(/\\s+/g,' ').trim().slice(0,50)) };
    })()`);
    rec("[四检] 四张结果卡真渲染", cards?.n === 4 ? "ok" : "DEAD",
      `卡数=${cards?.n} · ${(cards?.texts ?? []).slice(0, 2).join(" | ")}`);
  }

  // ══ ② 素材筛选 + 批量选择 ══
  console.log("\n═══ ② 素材页筛选与批量 /workflow/materials ═══");
  await openSoc(cdp, BASE, "/workflow/materials", token, pid, 7500);
  await dismissOverlays(cdp);
  const before = await evalTop(cdp, `document.querySelectorAll('.mat-card').length`);
  const bar = await evalTop(cdp, `(() => ({
    search: !!document.querySelector('[data-control="workflow:mat-search"]'),
    filter: !!document.querySelector('[data-control="workflow:mat-filter"]'),
    batch:  !!document.querySelector('[data-control="workflow:mat-batch-toggle"]'),
  }))()`);
  rec("[筛选] 工具栏三件套渲染", bar?.search && bar?.filter && bar?.batch ? "ok" : "DEAD",
    `搜索=${bar?.search} 类别=${bar?.filter} 批量=${bar?.batch}`);
  // 真输入关键词 → 列表应变短(或至少不增多)
  await evalTop(cdp, `(() => {
    const el = document.querySelector('[data-control="workflow:mat-search"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, '探针素材甲');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);
  await sleep(600);
  const after = await evalTop(cdp, `({
    cards: document.querySelectorAll('.mat-card').length,
    filtered: !!document.querySelector('.mat-filtered'),
  })`);
  rec("[筛选] 输入关键词后列表真被筛短", after?.cards < before && after?.cards > 0 ? "ok" : "err",
    `卡片 ${before} → ${after?.cards} 筛选提示=${after?.filtered}`);
  // 批量选择 → 全选 → 选中数变化
  await probeAction(cdp, '[data-control="workflow:mat-batch-toggle"]', { wait: 1200 });
  const pickedBefore = await evalTop(cdp, `(() => {
    const el = document.querySelector('.mat-picked');
    return el ? el.textContent.trim() : '(无)';
  })()`);
  await probeAction(cdp, '[data-control="workflow:mat-select-all"]', { wait: 1200 });
  const pickedAfter = await evalTop(cdp, `(() => {
    const el = document.querySelector('.mat-picked');
    const boxes = document.querySelectorAll('.mat-pick:checked').length;
    return { txt: el ? el.textContent.trim() : '(无)', checked: boxes };
  })()`);
  rec("[批量] 全选真改变选中态", (pickedAfter?.checked ?? 0) > 0 && pickedBefore !== pickedAfter?.txt ? "ok" : "DEAD",
    `选中 ${pickedBefore} → ${pickedAfter?.txt} · 勾选框=${pickedAfter?.checked}`);

  // ══ ③ 语料库召回(创作台助手面板) ══
  console.log("\n═══ ③ 语料库召回 /workflow/workspace ═══");
  await openSoc(cdp, BASE, "/workflow/workspace", token, pid, 7500);
  await spyInstall(cdp);
  await probeAction(cdp, '[data-control="workflow:toggle-ai-panel"]', { wait: 2000 });
  const cz = await evalTop(cdp, `(() => {
    const z = document.querySelector('.corpus-zone');
    const b = document.querySelector('[data-control="workflow:corpus-recall"]');
    return { zone: !!z, btn: !!b, inBody: z ? !!z.closest('.ai-panel-body') : false, disabled: b?.disabled };
  })()`);
  rec("[语料] 召回区渲染且在面板体内", cz?.zone && cz?.inBody ? "ok" : "skip",
    `区=${cz?.zone} 在body内=${cz?.inBody} 按钮禁用=${cz?.disabled}`);
  if (cz?.btn && !cz?.disabled) {
    const r = await probeAction(cdp, '[data-control="workflow:corpus-recall"]', { wait: 8000 });
    const hit = (r.apiReqs ?? []).find((x) => /writing-corpus\/recall/.test(x.url));
    rec("[语料] 打真端点且 200", hit && hit.status === 200 ? "ok" : "DEAD",
      hit ? `${short(hit.url)} → ${hit.status}` : `未见请求(共 ${(r.apiReqs ?? []).length} 个)`);
    const got = await evalTop(cdp, `(() => ({
      items: document.querySelectorAll('.cz-item').length,
      msg: (document.querySelector('.cz-msg')?.textContent || '').trim().slice(0, 40),
    }))()`);
    rec("[语料] 召回结果或空态如实显示", (got?.items ?? 0) > 0 || got?.msg ? "ok" : "err",
      `条目=${got?.items} 提示="${got?.msg}"`);
  }

  // 清理
  await api(token, `/research/projects/${pid}`, "DELETE").catch(() => null);
  console.log("\n════════ 汇总 ════════");
  for (const x of rows) console.log(`${x.kind.padEnd(6)} ${x.action}`);
  const bad = rows.filter((x) => x.kind === "err" || x.kind === "dead");
  console.log(bad.length ? `\n❌ ${bad.length} 项异常 / 共 ${rows.length}` : `\n✅ ${rows.length} 项全部通过`);
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error("探针异常:", e.message, e.stack?.split("\n")[1] ?? "");
  process.exitCode = 1;
} finally {
  await close();
}
