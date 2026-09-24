// scripts/probe-sections-banners.mjs — 框架设计页 横幅态动作探针(失败态 / 分析中 / 引导补齐)
//
// 覆盖表第六轮。**为什么要专门验这一页**: SectionsView 的 6 个动作**全部**长在
//   `analyzeFailed` / `analyzing` / `missingCount>0` 三种横幅里 —— 正常路径的门禁
//   (verify-writing-cabin 那套"长什么样"的断言)照的全是**成功态**, 这三个分支没有信号。
//   失败态恰恰是最容易腐烂的地方: 平时跑不到, 坏了也没人知道。
//
// 做法: 真跑一次 analyze 任务, 在它跑的过程中**取消** → 驱动出失败横幅 → 逐个点。
//   (analyze 是真调 LLM 的, 所以本探针按需手跑, 不进默认门禁。)
//
// 用法: node scripts/probe-sections-banners.mjs        (需 4173 已起; 会真跑一次 analyze)
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
async function pollToast(cdp, n = 10) {
  let fb = "";
  for (let i = 0; i < n && !fb; i++) { await sleep(300); fb = (await readToast(cdp)) || ""; }
  return fb;
}
/** 当前横幅态(成功后门禁用它判"走到哪一态") */
const bannerState = (cdp) => evalTop(cdp, `(() => {
  const b = document.querySelector('.banner');
  if (!b) return null;
  const cls = b.className;
  return { cls,
    fail: /banner-fail/.test(cls), thinking: /banner-thinking/.test(cls),
    done: /banner-done/.test(cls), idle: /banner-idle/.test(cls),
    text: (b.innerText || '').replace(/\\s+/g, ' ').slice(0, 90) };
})()`);

/** 播种: 有章节结构但**没有**写作指导(skill 不全) → 天然落在 idle 横幅的补齐入口 */
async function seed(token) {
  const TITLE = `架构横幅探针-${Date.now()}`;
  const proj = await api(token, "/research/projects", "POST", { title: TITLE, status: "in-progress", phase: 2, phaseLabel: "框架设计" });
  const pid = (proj?.data ?? proj)?.id;
  if (!pid) return null;
  const INPUT = { title: TITLE, outline: "一、引言\n  1.1 研究背景\n二、文献综述\n  2.1 已有研究", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] };
  // 故意**不写** skill/指导字段 → missingCount > 0
  const sections = [
    { id: "sec_0", title: "引言", level: 1, order: 0, status: "pending" },
    { id: "sec_1", title: "文献综述", level: 1, order: 1, status: "pending" },
    { id: "sec_1_1", title: "已有研究", level: 2, order: 0, status: "pending", parentId: "sec_1" },
  ];
  await api(token, `/research/projects/${pid}/nodes/input`, "PUT", { payload: { input: INPUT, sections } });
  await api(token, `/research/projects/${pid}/nodes/sections`, "PUT", { payload: { sections } });
  await api(token, `/research/projects/${pid}/workbench`, "PUT", {
    snapshot: { phase: 2, phaseLabel: "框架设计", input: INPUT, sections, variables: [], hypotheses: [] },
  });
  return { pid };
}

const { cdp, ev, close } = await startCdp({ preferredPort: 31063, label: "probe-sections-banners" });
/** 播种出来的项目 id —— **必须在 finally 里删掉**。
 *  ⚠ 2026-09-24 补: 本探针一直**建项目却从不删**(同目录的 project-rail / materials-actions 都成对删)。
 *  后果是每跑一次门禁就在生产库里留一个「架构横幅探针-<时间戳>」, 几十轮排查后积了一堆 ——
 *  用户看到项目栏里全是这种名字, 以为自己的项目被污染了。测试产物就该由测试自己收尾。 */
let seededPid = "";
let token = "";   // ⚠ 必须在 try 外 —— finally 的清理要用它(第一版漏了, 结果 ReferenceError 被 catch 吞掉)

try {
  token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");
  const s = await seed(token);
  seededPid = s?.pid ?? "";
  if (!s?.pid) throw new Error("播种失败");
  console.log(`项目 ${s.pid}(有章节、无写作指导)\n`);

  await openSoc(cdp, BASE, "/workflow/sections", token, s.pid);
  await spyInstall(cdp);

  // ── ① idle 横幅: 缺指导时的"只生成写作指导"入口 ──
  console.log("\n═══ ① idle 横幅(缺写作指导) ═══");
  {
    const st = await bannerState(cdp);
    rec("缺指导时落在 idle 横幅并给出补齐入口", st?.idle && /还差/.test(st.text) ? "ok" : "ERR", `横幅=${st?.cls} 文案="${st?.text}"`);
    const btns = await evalTop(cdp, `(() => ({
      retry: !!document.querySelector('[data-control="workflow:retry-guides"]'),
      start: !!document.querySelector('[data-control="workflow:start-analysis-2"]'),
      retryText: document.querySelector('[data-control="workflow:retry-guides"]')?.textContent?.trim() || '',
      startText: document.querySelector('[data-control="workflow:start-analysis-2"]')?.textContent?.trim() || '',
    }))()`);
    rec("两个入口都在(补齐指导 / 重新分析)", btns?.retry && btns?.start ? "ok" : "ERR",
      `retry="${btns?.retryText}" start="${btns?.startText}"`);
    // 缺指导时的措辞必须点明"只补指导", 不能让人以为要重跑结构
    rec("补齐入口文案点明只补指导", /只生成写作指导/.test(btns?.retryText ?? "") ? "ok" : "ERR", `retry="${btns?.retryText}"`);
  }

  // ── ② 开一次分析 → 分析中横幅(3 步进度 + 取消) ──
  console.log("\n═══ ② 分析中横幅 ═══");
  let taskId = "";
  {
    const r = await probeAction(cdp, '[data-control="workflow:start-analysis-2"]', { wait: 3000 });
    taskId = (() => {
      for (const x of r.apiReqs) { const m = String(x.url).match(/\/research\/tasks\/([0-9a-f-]{36})/i); if (m) return m[1]; }
      return "";
    })();
    rec("start-analysis-2(发起分析)", r.apiReqs.length ? "ok" : "DEAD",
      `任务=${taskId.slice(0, 8)} ` + (r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "零请求"));

    const thinking = await waitFor(cdp, `!!document.querySelector('.banner-thinking')`, { timeout: 30000, every: 1000 });
    rec("进入分析中横幅", thinking ? "ok" : "ERR", thinking ? "有" : "30s 内未进入");
    const st = await evalTop(cdp, `(() => ({
      steps: [...document.querySelectorAll('.step-item')].map(e => ({ t: e.querySelector('.step-label')?.textContent?.trim(), cls: e.className })),
      spinning: document.querySelectorAll('.step-circle.spinning').length,
      cancel: !!document.querySelector('[data-control="workflow:cancel-analysis"]'),
      progressText: document.querySelector('.thinking-title')?.textContent?.trim() || '',
    }))()`);
    rec("三步骤条 + 当前步转圈 + 取消按钮", st?.steps?.length === 3 && st?.cancel ? "ok" : "ERR",
      `步骤=${JSON.stringify(st?.steps?.map((x) => x.t))} 转圈=${st?.spinning} 进度="${st?.progressText}"`);
    // 当前步必须有且只有一个在转圈(闭源语义: 让用户看出卡在哪一步)
    rec("同一时刻只有一个步骤在转圈", st?.spinning === 1 ? "ok" : (st?.spinning === 0 ? "skip" : "ERR"), `spinning=${st?.spinning}`);
  }

  // ── ③ 取消 → 失败横幅 → 两个动作逐个点 ──
  console.log("\n═══ ③ 取消 → 失败横幅 ═══");
  {
    const cancel = await probeAction(cdp, '[data-control="workflow:cancel-analysis"]', { wait: 2500 });
    rec("cancel-analysis(取消)", cancel.apiReqs.some((x) => /control/.test(x.url)) ? "ok" : "DEAD",
      cancel.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "零请求");
    // 后端任务必须真的转 cancelled
    let status = "";
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const t = taskId ? await api(token, `/research/tasks/${taskId}`) : null;
      status = String(t?.task?.status ?? "");
      if (["cancelled", "failed", "done"].includes(status)) break;
    }
    rec("取消后后端任务转 cancelled", status === "cancelled" ? "ok" : "ERR", `任务状态=${status || "未知"}`);

    // 取消 → 前端应落到**失败横幅**(给了"只重试指导 / 重新生成"两条出路)
    const st = await waitFor(cdp, `(() => { const b = document.querySelector('.banner-fail'); return b ? (b.innerText||'').replace(/\\s+/g,' ').slice(0,90) : null; })()`, { timeout: 20000, every: 1200 });
    // 横幅必须**如实说是取消**, 不能显示"生成失败"(用户主动取消不是系统故障)
    const head = await evalTop(cdp, `document.querySelector('.banner-fail .banner-head strong')?.textContent?.trim() || ''`);
    rec("取消后落到失败横幅且写明「已取消」", st && /已取消/.test(st) && /已取消/.test(head ?? "") ? "ok" : "ERR",
      `标题="${head}" 横幅="${st ?? "未出现"}"`);
    rec("取消的横幅不冒充「生成失败」", !/生成失败/.test(head ?? "") ? "ok" : "ERR", `标题="${head}"`);
    const btns = await evalTop(cdp, `(() => ({
      retry: !!document.querySelector('[data-control="workflow:retry-guides"]'),
      regen: !!document.querySelector('[data-control="workflow:regen-sections"]'),
      step: document.querySelector('.fail-step')?.textContent?.trim() || '',
    }))()`);
    rec("失败横幅两个动作 + Step 编号", btns?.retry && btns?.regen && /Step \d/.test(btns?.step ?? "") ? "ok" : "ERR",
      `retry=${btns?.retry} regen=${btns?.regen} 编号="${btns?.step}"`);

    // 「只重试生成写作指导」: 有章节 → 应当真的发起指导生成(不是重跑结构)
    if (btns?.retry) {
      const r = await probeAction(cdp, '[data-control="workflow:retry-guides"]', { wait: 4000 });
      rec("retry-guides(只补写作指导)", r.apiReqs.length ? "ok" : "DEAD",
        r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ").slice(0, 110) || "零请求");
      // 等它跑完或失败(不管哪种, 状态机都该落回来, 不能永远 busy)
      await waitFor(cdp, `!document.querySelector('[data-disabled="true"]')`, { timeout: 5000, every: 1000 });
      const settled = await waitFor(cdp, `(() => {
        const b = document.querySelector('[data-control="workflow:retry-guides"]');
        return b && !b.disabled ? 'settled' : null;
      })()`, { timeout: 240000, every: 3000 });
      rec("补齐指导后按钮不再卡在禁用态", settled ? "ok" : "ERR", settled ? "已复位" : "240s 内仍禁用(卡死)");
    }
  }

  // ── ④ 「重新生成」(regen-sections 与缺失警告里的 reanalyze 同一动作) ──
  console.log("\n═══ ④ 重新生成 / 重新分析 ═══");
  {
    const hasRegen = await evalTop(cdp, `!!document.querySelector('[data-control="workflow:regen-sections"]')`);
    const hasRean = await evalTop(cdp, `!!document.querySelector('[data-control="workflow:reanalyze"]')`);
    rec("reanalyze(缺失警告里的重新分析入口)", hasRean ? "ok" : "skip", hasRean ? "存在" : "当前无缺失警告(指导已齐)");
    if (hasRean) {
      const r = await probeAction(cdp, '[data-control="workflow:reanalyze"]', { wait: 3000 });
      rec("reanalyze 发起新分析", r.apiReqs.some((x) => /tasks/.test(x.url)) ? "ok" : "DEAD",
        r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ").slice(0, 110) || "零请求");
      // 起完就取消, 别让它跑满
      await sleep(2500);
      await probeAction(cdp, '[data-control="workflow:cancel-analysis"]', { wait: 2000 });
      await sleep(1500);
    }
    if (hasRegen) {
      const settled = await waitFor(cdp, `!!document.querySelector('[data-control="workflow:regen-sections"]')`, { timeout: 60000, every: 2000 });
      if (settled) {
        const r = await probeAction(cdp, '[data-control="workflow:regen-sections"]', { wait: 3000 });
        rec("regen-sections(重新生成)", r.apiReqs.some((x) => /tasks/.test(x.url)) ? "ok" : "DEAD",
          r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ").slice(0, 110) || "零请求");
        await sleep(2000);
        await probeAction(cdp, '[data-control="workflow:cancel-analysis"]', { wait: 2000 });
      } else rec("regen-sections(重新生成)", "skip", "未回到失败横幅(该按钮只在失败态渲染)");
    }
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
  // 收尾: 删掉本次播的项目 —— 别再往生产库里积测试数据
  if (seededPid) {
    try {
      const r = await api(token, `/research/projects/${seededPid}`, "DELETE");
      // ⚠ 也要看返回码: api() 失败时**不抛错**, 而是返回 `{__status}` —— 只 try/catch 会漏掉"请求发出但被拒"
      if (r && r.__status && r.__status >= 400) console.error(`  (清理临时项目被拒 HTTP ${r.__status}, 需手动删: ${seededPid})`);
    } catch (e) {
      // ⚠ 错误信息**必须打出来**: 第一版这里 catch 了却只写"失败", 把 ReferenceError(token 不在作用域)
      //   吞成了一句无信息量的话, 我为此白跑一轮才发现真因。
      console.error(`  (清理临时项目失败: ${e?.message ?? e} — 需手动删: ${seededPid})`);
    }
  }
  await close();
}
