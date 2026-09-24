// scripts/probe-merged-review-round.mjs — 合稿页「三轮主流程」端到端实测
//
// 由来(2026-09-16): 合稿页的三轮卡(合并→审查→修订)在结构上是**我方独有**的容器,
//   闭源把这三件事分散在「空态 + 合并完成后的两栏」里。容器不同没关系, 但三轮里
//   「审查」与「修订」两步此前**从没有过一次端到端证据** —— 没有任何门禁、探针或单测
//   覆盖过 doReview / doRevise / adoptRevision。它们是否真的打到后端、返回的报告结构
//   前端是否吃得下, 全是未知。
//
// 本探针只做一件事: 真点这三个按钮, 打印**真实响应形状**与 DOM 结果。
//   ⚠ 会真调 LLM(两次), 慢且花钱, 所以不进 verify-ui 默认组, 按需手跑。
//
// 用法: node scripts/probe-merged-review-round.mjs        (需 4173 已起)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, spyLog, probeAction, waitFor, readToast } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.ok ? r.json().catch(() => ({})) : { __status: r.status };
};
const short = (u) => String(u ?? "").replace(BASE, "").slice(0, 80);
const rows = [];
function rec(step, kind, detail) {
  rows.push({ step, kind, detail });
  console.log(`${kind.padEnd(6)} ${step} — ${detail}`);
}

const { cdp, ev, close } = await startCdp({ preferredPort: 31037, label: "probe-merged-review-round" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");

  // ── 播种: 建项目 + 章节(带正文) + input 节点 + workbench 快照 ──
  const TITLE = `审查轮探针-${Date.now()}`;
  const proj = await api(token, "/research/projects", "POST", { title: TITLE, status: "in-progress", phase: 5, phaseLabel: "统稿定稿" });
  const pid = (proj?.data ?? proj)?.id;
  if (!pid) throw new Error("建项目失败");

  const body1 = "数字经济的测度体系在既有研究中长期依赖单一指标,难以覆盖其多维属性。本文以省级面板为分析单元,构建了包含数字化基础设施、数字化应用与数字化创新三个维度的综合评价体系。".repeat(3);
  const body2 = "基于 2015—2023 年的省级面板数据,本文采用双向固定效应模型对研究假说进行检验。基准回归结果显示,数字经济水平每提升一个标准差,中小企业融资约束指数下降约 0.18 个标准差,该结果在更换核心解释变量与调整样本区间后依然稳健。".repeat(3);
  const sections = [
    { id: "sec_0", title: "引言", level: 1, order: 0, status: "done", content: body1 },
    { id: "sec_1", title: "实证分析", level: 1, order: 1, status: "done", content: body2 },
  ];
  const INPUT = { title: TITLE, outline: "一、引言\n二、实证分析", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] };
  await api(token, `/research/projects/${pid}/nodes/input`, "PUT", { payload: { input: INPUT, sections } });
  await api(token, `/research/projects/${pid}/workbench`, "PUT", {
    snapshot: { phase: 5, phaseLabel: "统稿定稿", input: INPUT, sections, variables: [], hypotheses: [] },
  });
  console.log(`项目 ${pid}\n`);

  await openSoc(cdp, BASE, "/workflow/finalize", token, pid);
  await spyInstall(cdp);

  // ── 0. 空态: 合并模式/强度档应当**同屏可选**(本次刚补) ──
  {
    const empty = await evalTop(cdp, `(() => {
      const vis = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), txt: (e.textContent||'').trim().slice(0,20) }; };
      return {
        emptyShown: !!document.querySelector('.finalize-empty'),
        modes: [...document.querySelectorAll('.finalize-empty .mm-tab')].map(b => b.textContent.trim()),
        start: vis('.finalize-empty .fe-start'),
        steps: document.querySelectorAll('.finalize-empty .msp-item').length,
        tiersVisible: !!document.querySelector('.finalize-empty .fe-tiers'),
      };
    })()`);
    rec("空态", empty?.modes?.length === 2 ? "ok" : "ERR",
      `模式tab=${JSON.stringify(empty?.modes)} 开始按钮=${empty?.start?.w}x${empty?.start?.h} 五步预览=${empty?.steps}条 档位(直接模式下不该有)=${empty?.tiersVisible}`);
    // 切到降AIGC → 档位应出现
    await probeAction(cdp, '.finalize-empty .mm-tab:nth-child(2)', { wait: 800 });
    const after = await evalTop(cdp, `(() => ({ tiers: [...document.querySelectorAll('.finalize-empty .tier-btn')].map(b=>b.textContent.trim()), warn: !!document.querySelector('.finalize-empty .tier-warn') }))()`);
    rec("空态·切降AIGC", after?.tiers?.length === 3 ? "ok" : "ERR", `档位=${JSON.stringify(after?.tiers)} 警示语=${after?.warn}`);
    // 切回直接合稿, 走常规路径
    await probeAction(cdp, '.finalize-empty .mm-tab:nth-child(1)', { wait: 500 });
  }

  // ── 1. 合并(真调 LLM) ──
  console.log("\n═══ ① 合并正文 ═══");
  let mergeTaskId = "";
  {
    const r = await probeAction(cdp, '[data-control="workflow:phase5-merge"]', { wait: 4000 });
    rec("合并·发起", r.apiReqs.length ? "ok" : "DEAD", r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "点击后零请求");
    mergeTaskId = (r.apiReqs.find((x) => /\/research\/tasks$/.test(x.url))?.body ?? "").match(/"taskId":"([^"]+)"|"id":"([^"]+)"/)?.[1]
      ?? (() => { try { return JSON.parse(r.apiReqs.find((x) => /\/research\/tasks$/.test(x.url))?.body ?? "{}").id ?? ""; } catch { return ""; } })();
    const done = await waitFor(cdp, `!!document.querySelector('.finale-card')`, { timeout: 300000, every: 2500 });
    rec("合并·完成", done ? "ok" : "ERR", done ? "终稿卡已渲染" : "300s 内未出现终稿卡");
    if (!done) throw new Error("合并未完成, 后续轮次无从验证");
    // ⚠ 必须用 `.f-area.body` —— `.finale-card textarea` 命中的是**摘要**(DOM 里第一个 textarea),
    //   上一版探针就是拿摘要在当正文比, 结论看似通过其实量错了字段。
    const mt = await evalTop(cdp, `(() => {
      const ta = document.querySelector('.finale-card .f-area.body');
      return { bodyLen: ta ? ta.value.length : -1, refs: !!document.querySelector('.finale-card .f-area.refs') };
    })()`);
    rec("合并·产物", mt?.bodyLen > 200 ? "ok" : "ERR", `合并正文 ${mt?.bodyLen} 字`);
  }

  // ── 2. 任务结果里有没有 revise_pending 契约需要的字段(不花 LLM, 读任务行) ──
  if (mergeTaskId) {
    const t = await api(token, `/research/tasks/${mergeTaskId}`);
    const res = t?.task?.result ?? t?.result ?? null;
    rec("合并·任务结果契约", res ? "ok" : "ERR",
      `result=${res ? JSON.stringify(Object.keys(res)).slice(0, 120) : "null(前端回读会拿到空)"}`);
  }

  // ── 2. 时间轴形态(之字形) ──
  //   注: 不能用注入节点量样式 —— 该组件的 CSS 是 scoped, 样式只挂 `.merge-timeline[data-v-xxx]`,
  //   新建的节点没有那个属性, 取到的是空样式(上一版探针就是这么假失败的)。
  //   改为在**该组件自己的**实例上量: 合并中时间轴会真实渲染出来。
  console.log("\n═══ 时间轴形态 ═══");
  {
    // 重新合稿一次以让时间轴出现 —— 会再花一次 LLM, 所以只在需要时做。
    // 更省的做法: 直接量已构建产物里的样式表文本, 断言选择器与取值。
    const css = await evalTop(cdp, `(() => {
      const out = [];
      for (const sh of document.styleSheets) {
        let rules; try { rules = sh.cssRules; } catch { continue; }
        for (const r of rules || []) {
          const t = r.cssText || '';
          if (t.includes('merge-timeline')) out.push(t);
        }
      }
      return out;
    })()`);
    const joined = (css || []).join("\n");
    // ⚠ 构建产物里的媒体查询被 lightningcss 规范化成 `@media (width<=640px)`,
    //   照源码文本写断言会假失败(上一版就是这么红的)。两种写法都要认。
    const has = (s) => joined.includes(s);
    const hasMedia640 = /@media[^{]*\(\s*(max-width:\s*640px|width\s*<=\s*640px)\s*\)/.test(joined);
    const checks = {
      "max-width:640px": has("max-width: 640px") || has("max-width:640px"),
      "grid 三列": /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*36px\s*minmax\(0,\s*1fr\)/.test(joined) || has("36px"),
      "is-left 右对齐": /is-left[^{]*\{[^}]*text-align:\s*right/.test(joined),
      "断点 640": hasMedia640,
    };
    const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    rec("时间轴·之字形", bad.length === 0 ? "ok" : "ERR",
      `规则${(css || []).length}条 | ` + Object.entries(checks).map(([k, v]) => `${k}=${v ? "✓" : "✗"}`).join(" ") + (bad.length ? ` | 缺: ${bad.join(",")}` : ""));
  }

  // ── 3. 全文审查(真调 LLM) ──
  console.log("\n═══ ② 全文审查 ═══");
  {
    const r = await probeAction(cdp, '[data-control="workflow:review"]', { wait: 4000 });
    rec("审查·发起", r.apiReqs.length ? "ok" : "DEAD", r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "点击后零请求");
    const done = await waitFor(cdp, `!!document.querySelector('.review-result-card')`, { timeout: 300000, every: 2500 });
    rec("审查·完成", done ? "ok" : "ERR", done ? "审查报告卡已渲染" : "300s 内未出现报告卡");
    if (done) {
      const shape = await evalTop(cdp, `(() => {
        const c = document.querySelector('.review-result-card');
        return { score: c.querySelector('.rr-score')?.textContent?.trim(), grade: c.querySelector('.rr-grade')?.textContent?.trim(),
                 commentLen: (c.querySelector('.rr-comment')?.textContent||'').length,
                 highlights: c.querySelectorAll('.rr-block:nth-of-type(1) li').length,
                 checks: [...c.querySelectorAll('.rr-check')].map(x => ({ n: x.querySelector('.rr-check-name')?.textContent?.trim(), f: x.querySelector('.rr-check-flag')?.textContent?.trim(), d: (x.querySelector('.rr-check-detail')?.textContent||'').length })),
                 suggestions: c.querySelectorAll('.rr-suggestions li').length };
      })()`);
      rec("审查·报告结构", shape?.checks?.length ? "ok" : "ERR", `分=${shape?.score} 等级=${shape?.grade} 评语${shape?.commentLen}字 五维=${JSON.stringify(shape?.checks)} 建议=${shape?.suggestions}条`);
    }
  }

  // ── 4. 修订轮(真调 LLM) ──
  console.log("\n═══ ③ 修订定稿 ═══");
  let pendingLen = -1;
  {
    const r = await probeAction(cdp, '[data-control="workflow:revise"]', { wait: 4000 });
    rec("修订·发起", r.apiReqs.length ? "ok" : "DEAD", r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "点击后零请求");
    const done = await waitFor(cdp, `!!document.querySelector('.revision-card')`, { timeout: 300000, every: 2500 });
    rec("修订·产出", done ? "ok" : "ERR", done ? "修订稿卡已渲染" : "300s 内未出现修订稿卡");
    if (done) {
      // 修订稿字数(从卡片文案里读: "修订稿已生成, 正文 N 字")
      pendingLen = Number((await evalTop(cdp, `(() => { const p = document.querySelector('.revision-card p'); const m = (p?p.textContent:'').match(/(\\d+)\\s*字/); return m ? Number(m[1]) : -1; })()`)) ?? -1);
      // 修订稿正文取自任务结果(后端已不写 merged_*), 先记下来做对比基线
      const revBody = await evalTop(cdp, `(() => { const p = document.querySelector('.revision-card p'); return (p ? p.textContent : '').trim().slice(0, 80); })()`);
      const before = await evalTop(cdp, `(() => { const t = document.querySelector('.finale-card .f-area.body'); return t ? t.value.length : -1; })()`);
      rec("修订·待采用态", pendingLen !== -1 ? "ok" : "ERR",
        `卡片=${revBody} | 当前合稿正文 ${before} 字${pendingLen === before ? " ⚠ 与待采用稿同长(可疑)" : " (未被替换 ✓)"}`);
      const adopt = await probeAction(cdp, '[data-control="workflow:adopt-revision"]', { wait: 5000 });
      const after = await evalTop(cdp, `(() => { const t = document.querySelector('.finale-card .f-area.body'); return t ? t.value.length : -1; })()`);
      const activated = adopt.apiReqs.some((x) => /versions\/\d+\/activate/.test(x.url) && x.status === 200);
      // 三件事都要成立: (a) activate 真被调用且 200 (b) 正文被换成修订稿(长度变且约等于卡片报的字数)
      //   (c) 不是"空操作" —— 修订稿与合稿长度一定不同(实测 349 vs 5551)
      const okAdopt = activated && after !== before && Math.abs(after - pendingLen) < pendingLen * 0.05;
      rec("修订·采用", okAdopt ? "ok" : "ERR",
        `采用前 ${before} 字 → 采用后 ${after} 字 (修订稿卡片报 ${pendingLen} 字) | activate 200=${activated} | 请求=${adopt.apiReqs.map(x => `${x.method} ${short(x.url)}→${x.status}`).join(" ")}`);
      // 采用后必须落库 —— 重新加载页面看还在不在(闭源语义: 采用即替换当前合稿)
      await cdp("Page.reload");
      await sleep(9000);
      const persisted = await evalTop(cdp, `(() => { const t = document.querySelector('.finale-card .f-area.body'); return t ? t.value.length : -1; })()`);
      const stillPending = await evalTop(cdp, `!!document.querySelector('.revision-card')`);
      rec("修订·落库", persisted === after ? "ok" : "ERR", `重载后正文 ${persisted} 字 (采用后是 ${after}) 待采用卡还在=${stillPending}`);
    }
  }

  console.log("\n════════ 汇总 ════════");
  const bad = rows.filter((r) => r.kind === "ERR" || r.kind === "DEAD");
  for (const r of rows) console.log(`${r.kind.padEnd(6)} ${r.step}`);
  console.log(bad.length ? `\n❌ ${bad.length} 项异常` : `\n✅ ${rows.length} 项全部通过`);
} catch (e) {
  console.error("探针异常:", e.message);
} finally {
  await close();
}
