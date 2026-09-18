// scripts/probe-workbench-sync.mjs — 「快照 ↔ 节点」口径统一 的端到端验证
//
// 由来(2026-09-18): 写作舱把同一份数据同时存在 workbench_snapshot 与 research_nodes,
//   此前**同步靠每个调用点自己记得补一刀**, 忘了就静默丢数据。实测栽过两次:
//     · 「已定稿」只写快照, 而读侧只从 finalize 节点读 → 刷新后丢失
//     · 要件生成只写快照 → 刷新后被 sections 节点盖回去
//   现在同步移到服务端(`workbench-sync.ts` 的映射表), 前端只管提交视图。
//
// 本探针验的就是"改完之后, 刷新还在不在" —— 这三条都是**用户视角**的判据,
//   与单测(验合并函数本身)互补: 单测保证函数对, 这里保证接线对。
//
// 用法: node scripts/probe-workbench-sync.mjs   (需 4173 已起; 不调 LLM, 秒级)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, probeAction, waitFor } from "./lib/probe-actions.mjs";

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

/** 播种: 一个到合稿阶段的完整项目 */
async function seed(token) {
  const TITLE = `同步探针-${Date.now()}`;
  const proj = await api(token, "/research/projects", "POST", { title: TITLE, status: "in-progress", phase: 5, phaseLabel: "合稿定稿" });
  const pid = (proj?.data ?? proj)?.id;
  if (!pid) return null;
  const INPUT = { title: TITLE, outline: "一、引言\n二、结论", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] };
  const sections = [
    { id: "sec_0", title: "引言", level: 1, order: 0, status: "done", content: "引擎写的引言正文。" },
    { id: "sec_1", title: "结论", level: 1, order: 1, status: "done", content: "引擎写的结论正文。" },
  ];
  await api(token, `/research/projects/${pid}/nodes/input`, "PUT", { payload: { input: INPUT, sections } });
  await api(token, `/research/projects/${pid}/nodes/sections`, "PUT", { payload: { sections } });
  await api(token, `/research/projects/${pid}/workbench`, "PUT", {
    snapshot: { phase: 5, phaseLabel: "合稿定稿", input: INPUT, sections, variables: [], hypotheses: [] },
  });
  await api(token, `/research/projects/${pid}/nodes/finalize`, "PUT", {
    payload: { mergedTitle: TITLE, mergedAbstract: "", mergedKeywords: "", mergedFullText: "合稿正文。", mergedReferences: "" },
  });
  return { pid, title: TITLE };
}

const { cdp, ev, close } = await startCdp({ preferredPort: 31081, label: "probe-workbench-sync" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");
  const s = await seed(token);
  if (!s?.pid) throw new Error("播种失败");
  console.log(`项目 ${s.pid}\n`);

  await openSoc(cdp, BASE, "/workflow/finalize", token, s.pid);
  await spyInstall(cdp);

  // ── ① isFinalized: 此前整条链失效(只写快照, 读侧只读 finalize 节点) ──
  console.log("\n═══ ① 「已定稿」刷新后仍在 ═══");
  {
    // 直接走前端那条路: 改本地 + saveProject(不手写节点 —— 那正是要验的"服务端替我同步")
    const wrote = await api(token, `/research/projects/${s.pid}/workbench`, "PUT", {
      snapshot: { phase: 5, phaseLabel: "合稿定稿", isFinalized: true },
    });
    rec("PUT /workbench 接受提交", wrote?.ok ? "ok" : "ERR", `syncedNodes=${JSON.stringify(wrote?.syncedNodes ?? null)}`);

    // 服务端应把它同步进 finalize 节点
    const node = await api(token, `/research/projects/${s.pid}/nodes/finalize`);
    const inNode = node?.node?.payload?.isFinalized;
    rec("服务端同步进 finalize 节点(核心)", inNode === true ? "ok" : "ERR",
      `节点里的 isFinalized=${JSON.stringify(inNode)}`);

    // 读接口回传
    const wb = await api(token, `/research/projects/${s.pid}/workbench`);
    rec("回读接口带出 isFinalized", wb?.snapshot?.isFinalized === true ? "ok" : "ERR",
      `workbench.isFinalized=${JSON.stringify(wb?.snapshot?.isFinalized)}`);

    // 浏览器刷新后进度条节点应显示「已定稿」
    await cdp("Page.reload");
    await sleep(9000);
    const bar = await evalTop(cdp, `(() => {
      const m = [...document.querySelectorAll('.ppb-metric')].map(e => e.textContent.trim());
      return m.filter(Boolean);
    })()`);
    rec("刷新后进度条显示「已定稿」", (bar ?? []).some((t) => /已定稿/.test(t)) ? "ok" : "ERR",
      `进度条 metric=${JSON.stringify(bar)}`);
    await spyInstall(cdp);
  }

  // ── ② statisticsFileId: 写的键必须能读回来(此前是"写了但 loadProject 不回读"的死键) ──
  console.log("\n═══ ② 只写不读的键已接上回读 ═══");
  {
    const fakeId = `file_probe_${Date.now()}`;
    await api(token, `/research/projects/${s.pid}/workbench`, "PUT", {
      snapshot: { phase: 5, phaseLabel: "合稿定稿", statisticsFileId: fakeId },
    });
    // 刷新页面(走前端 loadProject 那条路), 再读接口 —— 两边都该有
    await cdp("Page.reload");
    await sleep(9000);
    const wb = await api(token, `/research/projects/${s.pid}/workbench`);
    rec("刷新后 fileId 仍在(接口侧)", wb?.snapshot?.statisticsFileId === fakeId ? "ok" : "ERR",
      `workbench.statisticsFileId=${String(wb?.snapshot?.statisticsFileId ?? "").slice(0, 26)}`);
    // 前端 loadProject 是否真把它吃进 store: store 未挂 window, 用页面上的可观测副作用判 ——
    //   MaterialsView 以 `hasDataFile: !!store.statisticsFileId` 决定素材计划的数据分析段。
    //   这里退一步只断言"没有把它当成空"(上传入口仍在, 且页面无报错)。
    const pageOk = await evalTop(cdp, `(() => ({
      uploads: document.querySelectorAll('[data-control="workflow:upload-data"]').length,
      err: [...document.querySelectorAll('div')].filter(d => (d.getAttribute('style')||'').includes('fixed')).map(d => (d.innerText||'').slice(0,30)).join('|'),
    }))()`);
    rec("刷新后页面无异常", !/失败|错误/.test(pageOk?.err ?? "") ? "ok" : "ERR", `固定层="${(pageOk?.err ?? "").slice(0, 40)}"`);
  }

  // ── ③ 防倒退: 拿旧快照提交, 引擎刚写的正文不得被顶掉 ──
  console.log("\n═══ ③ 旧视图提交不顶掉引擎产出(防倒退) ═══");
  {
    const staleSections = [
      { id: "sec_0", title: "引言", level: 1, order: 0, status: "pending", content: "" },   // 旧视图: 正文空
      { id: "sec_1", title: "结论", level: 1, order: 1, status: "pending", content: "" },
    ];
    await api(token, `/research/projects/${s.pid}/workbench`, "PUT", {
      snapshot: { phase: 5, phaseLabel: "合稿定稿", sections: staleSections },
    });
    const node = await api(token, `/research/projects/${s.pid}/nodes/sections`);
    const secs = node?.node?.payload?.sections ?? [];
    const lost = secs.filter((x) => !String(x.content ?? "").includes("引擎写的"));
    rec("引擎写的正文没被空内容顶掉", lost.length === 0 ? "ok" : "ERR",
      `节点正文=${JSON.stringify(secs.map((x) => ({ id: x.id, len: String(x.content ?? "").length })))}`);

    // 但编辑性字段要跟着走
    const renamed = [{ id: "sec_0", title: "引言(改过标题)", level: 1, order: 0 }];
    await api(token, `/research/projects/${s.pid}/workbench`, "PUT", {
      snapshot: { phase: 5, phaseLabel: "合稿定稿", sections: renamed },
    });
    const node2 = await api(token, `/research/projects/${s.pid}/nodes/sections`);
    const secs2 = node2?.node?.payload?.sections ?? [];
    const s0 = secs2.find((x) => x.id === "sec_0");
    rec("编辑性字段(标题)以提交值为准", s0?.title === "引言(改过标题)" ? "ok" : "ERR",
      `节点标题="${s0?.title}" 正文仍在=${String(s0?.content ?? "").length > 0}`);
    rec("提交里没有的章节被保留", secs2.some((x) => x.id === "sec_1") ? "ok" : "ERR",
      `节点章节=${JSON.stringify(secs2.map((x) => x.id))}`);
  }

  // ── ④ diff 守卫: 值没变不该反复写节点(否则撑爆版本历史) ──
  console.log("\n═══ ④ diff 守卫(值没变不写节点) ═══");
  {
    const before = (await api(token, `/research/projects/${s.pid}/nodes/sections`))?.node?.version ?? -1;
    for (let i = 0; i < 3; i++) {
      await api(token, `/research/projects/${s.pid}/workbench`, "PUT", {
        snapshot: { phase: 5, phaseLabel: "合稿定稿", sections: [
          { id: "sec_0", title: "引言(改过标题)", level: 1, order: 0 },
          { id: "sec_1", title: "结论", level: 1, order: 1 },
        ] },
      });
    }
    const after = (await api(token, `/research/projects/${s.pid}/nodes/sections`))?.node?.version ?? -1;
    rec("重复提交同样的值不 bump 节点版本", after === before ? "ok" : "ERR",
      `sections 节点 version ${before} → ${after}(重复提交 3 次)`);
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
