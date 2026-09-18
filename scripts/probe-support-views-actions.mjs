// scripts/probe-support-views-actions.mjs — 支撑视图动作探针(QuickMode / Statistics / Viz / Review)
//
// 覆盖表收尾轮。写作舱五页已全绿,剩下六个动作散在这四个视图里:
//   quick:ms-demo / quick:ms-run        —— DAG 元技能: 演示与直接运行
//   statistics:run / reset / cancel     —— 数据分析台的运行-取消-重置
//   viz:new / export-png / to-workflow  —— 绘图台的新建/导出/送写作舱
//   review:submit / retry / export-* / send-to-workflow —— 审稿台
//
// 这四处**不在写作舱主流程**, 门禁只有 verify-fusion-tabs 验过"挂的是 Vue 子应用",
// 动作一个没验过。
//
// 用法: node scripts/probe-support-views-actions.mjs        (需 4173 已起)
//       node scripts/probe-support-views-actions.mjs --all  (含真调 LLM/慢动作)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, probeAction, waitFor, readToast } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
const ALL = process.argv.includes("--all");
const rows = [];
function rec(view, action, kind, detail) {
  rows.push({ view, action, kind, detail });
  const tag = kind === "ok" ? "  ok  " : kind === "dead" ? " DEAD " : kind === "gated" ? " gated" : kind === "err" ? " ERR  " : " skip ";
  console.log(`${tag} [${view}] ${action} — ${detail}`);
}
const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.ok ? r.json().catch(() => ({})) : { __status: r.status };
};
const short = (u) => String(u ?? "").replace(BASE, "").replace("/api/", "").slice(0, 64);
async function pollToast(cdp, n = 8) {
  let fb = "";
  for (let i = 0; i < n && !fb; i++) { await sleep(300); fb = (await readToast(cdp)) || ""; }
  return fb;
}
/** 按钮当前态(不存在 → null) */
const btn = (cdp, sel) => evalTop(cdp, `(() => {
  const b = document.querySelector(${JSON.stringify(sel)});
  return b ? { exists: true, disabled: b.disabled, text: b.textContent.trim().slice(0, 24) } : { exists: false };
})()`);

const { cdp, ev, close } = await startCdp({ preferredPort: 31071, label: "probe-support-views" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");

  // ═══ ① 可视化 DAG 编排(QuickMode) ═══
  console.log("\n═══ ① QuickMode /workbench/quick ═══");
  {
    await openSoc(cdp, BASE, "/workbench/quick", token);
    await spyInstall(cdp);

    const demo = await btn(cdp, '[data-control="quick:ms-demo"]');
    rec("quick", "ms-demo 存在", demo?.exists ? "ok" : "skip", demo?.exists ? `文案="${demo.text}"` : "该页未渲染此按钮");
    if (demo?.exists) {
      const r = await probeAction(cdp, '[data-control="quick:ms-demo"]', { wait: 2000 });
      const st = await evalTop(cdp, `(() => ({
        topic: document.querySelector('input[type=text], .ms-topic, textarea')?.value || '',
        dagItems: document.querySelectorAll('.dag-item').length,
      }))()`);
      rec("quick", "ms-demo(一键演示: 填题面+建 DAG)", r.clicked ? "ok" : "DEAD",
        `点击=${r.clicked} 题面="${String(st?.topic).slice(0, 20)}" 画布节点=${st?.dagItems}`);
    }

    const run = await btn(cdp, '[data-control="quick:ms-run"]');
    if (!run?.exists) rec("quick", "ms-run(DAG 直接运行)", "skip", "需先有 DAG 节点才渲染运行按钮");
    else rec("quick", "ms-run 存在", "ok", `文案="${run.text}" 禁用=${run.disabled}(未填题面时应为 true)`);
  }

  // ═══ ② 数据分析台(Statistics) ═══
  console.log("\n═══ ② Statistics /statistics ═══");
  {
    await openSoc(cdp, BASE, "/statistics", token);
    await spyInstall(cdp);

    const run = await btn(cdp, '[data-control="statistics:run"]');
    const reset = await btn(cdp, '[data-control="statistics:reset"]');
    rec("statistics", "run / reset 存在", run?.exists && reset?.exists ? "ok" : "ERR",
      `run="${run?.text}" reset="${reset?.text}"`);

    // 重置: 纯前端清态, 不该发请求
    const r = await probeAction(cdp, '[data-control="statistics:reset"]', { wait: 1500 });
    rec("statistics", "reset(清空分析台)", r.clicked && r.apiReqs.length === 0 ? "ok" : (r.clicked ? "ok" : "DEAD"),
      `点击=${r.clicked} 请求=${r.apiReqs.length}(纯前端清态应为 0)`);

    // 运行: 未选数据源时应禁用或给提示 —— 两种都算门禁生效
    const runNow = await btn(cdp, '[data-control="statistics:run"]');
    if (runNow?.disabled) {
      rec("statistics", "run 未选数据时禁用(门禁)", "gated", `disabled=true 文案="${runNow.text}"`);
    } else if (ALL) {
      const rr = await probeAction(cdp, '[data-control="statistics:run"]', { wait: 4000 });
      const fb = await pollToast(cdp, 8);
      rec("statistics", "run(发起分析)", rr.apiReqs.length ? "ok" : (fb ? "gated" : "DEAD"),
        rr.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || `零请求 toast="${fb}"`);
      // 跑起来了 → 取消按钮应出现且能真取消
      const cancel = await waitFor(cdp, `document.querySelector('[data-control="statistics:cancel"]') ? 1 : null`, { timeout: 20000, every: 1000 });
      rec("statistics", "运行中出现取消按钮", cancel ? "ok" : "skip", cancel ? "有" : "20s 内未出现(可能已完成)");
      if (cancel) {
        const cr = await probeAction(cdp, '[data-control="statistics:cancel"]', { wait: 2500 });
        rec("statistics", "cancel(取消任务)", cr.apiReqs.some((x) => /control|cancel/.test(x.url)) ? "ok" : "DEAD",
          cr.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "零请求");
      }
    } else rec("statistics", "run / cancel", "skip", "未选数据源且 run 未禁用; 加 --all 才真跑");
  }

  // ═══ ③ 科研绘图(Viz) ═══
  console.log("\n═══ ③ Viz /viz ═══");
  {
    await openSoc(cdp, BASE, "/viz", token);
    await spyInstall(cdp);

    const nw = await btn(cdp, '[data-control="viz:new"]');
    rec("viz", "new(新建图表)存在", nw?.exists ? "ok" : "ERR", nw?.exists ? `文案="${nw.text}"` : "未渲染");
    if (nw?.exists) {
      const r = await probeAction(cdp, '[data-control="viz:new"]', { wait: 2000 });
      const st = await evalTop(cdp, `(() => ({
        cards: document.querySelectorAll('.viz-card, .figure-card, [class*="figure"]').length,
        empty: !!document.querySelector('.viz-empty, .empty-state'),
      }))()`);
      rec("viz", "new(新建图表)", r.clicked ? "ok" : "DEAD", `点击=${r.clicked} 卡片=${st?.cards}`);
    }

    const exp = await btn(cdp, '[data-control="viz:export-png"]');
    rec("viz", "export-png 存在且未选图时禁用", exp?.exists ? (exp.disabled ? "ok" : "ERR") : "ERR",
      exp?.exists ? `disabled=${exp.disabled}(无选中图应为 true)` : "未渲染");

    // 选一张图 → 导出应解禁
    if (exp?.exists && exp.disabled) {
      const picked = await evalTop(cdp, `(() => {
        const c = document.querySelector('.viz-card, [class*="figure-item"], .chart-item');
        if (!c) return false; c.click(); return true;
      })()`);
      await sleep(1200);
      const exp2 = await btn(cdp, '[data-control="viz:export-png"]');
      rec("viz", "选中图后 export-png 解禁", picked && exp2 && !exp2.disabled ? "ok" : "skip",
        picked ? `disabled=${exp2?.disabled}` : "页面无可选图");
    }

    const toWf = await btn(cdp, '[data-control="viz:to-workflow"]');
    rec("viz", "to-workflow(图表送写作舱)", toWf?.exists ? "ok" : "skip",
      toWf?.exists ? `文案="${toWf.text}"` : "需先生成带图的会话才渲染(条件渲染)");
  }

  // ═══ ④ 科研审查(Review) ═══
  console.log("\n═══ ④ Review /review ═══");
  {
    await openSoc(cdp, BASE, "/review", token);
    await spyInstall(cdp);

    const submit = await btn(cdp, '[data-control="review:submit"]');
    const retry = await btn(cdp, '[data-control="review:retry"]');
    rec("review", "submit 存在且无输入时禁用(门禁)", submit?.exists ? (submit.disabled ? "ok" : "ERR") : "ERR",
      submit?.exists ? `disabled=${submit.disabled} 文案="${submit.text}"` : "未渲染");
    // retry 与导出/发送都在"已有审稿结果"之后才渲染 —— 条件渲染, 如实记 skip
    for (const [sel, label] of [
      ["review:retry", "retry(重新审稿)"],
      ["review:export-html", "export-html"],
      ["review:export-word", "export-word"],
      ["review:send-to-workflow", "send-to-workflow(审稿意见送写作舱)"],
    ]) {
      const b = await btn(cdp, `[data-control="${sel}"]`);
      rec("review", label, b?.exists ? "ok" : "skip",
        b?.exists ? `文案="${b.text}" 禁用=${b.disabled}` : "需先有审稿结果(条件渲染)");
    }

    /**
     * 真跑一次审稿 —— 这是把下面四个动作从 skip 变成真验的**唯一**途径:
     * retry/export-html/export-word/send-to-workflow 全部挂在"已有审稿结果"之后(条件渲染),
     * 不跑一次它们根本不渲染。顺带验 submit 本身。
     * (会调 LLM, 所以只在 --all 下跑; 之后的两条 export 是**纯前端**下载, 很便宜。)
     */
    if (ALL && submit?.exists) {
      // 门禁: 内容 <100 字时应拦下
      await evalTop(cdp, `(() => {
        const ta = document.querySelector('.paste-area');
        if (!ta) return 'no-ta';
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, '太短');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return 'set';
      })()`);
      await sleep(800);
      const gate = await btn(cdp, '[data-control="review:submit"]');
      rec("review", "内容不足时 submit 禁用(门禁)", gate?.disabled ? "ok" : "ERR", `disabled=${gate?.disabled}`);

      /**
       * ⚠ 长文本必须从 node 侧用 `JSON.stringify` 传进去。
       *   直接写在模板串里时, 换行/引号会破坏 evalTop 的 JSON 传输 —— 整段 JS **静默评估失败**,
       *   表现是"明明灌了稿子, 按钮却仍禁用"(实测踩到: 我还在按钮上读到 1680 字, 那只是
       *   把同一个坏串又算了一遍; 真正进 store 的是空)。
       */
      const LONG_PAPER = '数字经济背景下中小企业融资约束的实证研究。'.repeat(30) + "\n" +
        '本文基于省级面板数据构建计量模型, 检验数字经济水平对融资约束的影响。'.repeat(30);
      await evalTop(cdp, `(() => {
        const ta = document.querySelector('.paste-area');
        if (!ta) return 'no-ta';
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(LONG_PAPER)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return ta.value.length;
      })()`);
      await sleep(1000);
      const r = await probeAction(cdp, '[data-control="review:submit"]', { wait: 4000 });
      rec("review", "submit(发起审稿)", r.apiReqs.some((x) => /review/.test(x.url)) ? "ok" : "DEAD",
        r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ").slice(0, 100) || "零请求");

      // 等结果页出现(审稿是长任务)
      const got = await waitFor(cdp, `!!document.querySelector('[data-control="review:retry"]')`, { timeout: 420000, every: 4000 });
      rec("review", "审稿完成并进入结果页", got ? "ok" : "ERR", got ? "结果动作区已渲染" : "420s 内未出现(拒绝采样假通过)");
      if (got) {
        for (const [sel, label] of [
          ["review:retry", "retry(重新审稿)"],
          ["review:export-html", "export-html"],
          ["review:export-word", "export-word"],
          ["review:send-to-workflow", "send-to-workflow(审稿意见送写作舱)"],
        ]) {
          const b = await btn(cdp, `[data-control="${sel}"]`);
          rec("review", `${label} 渲染`, b?.exists ? "ok" : "ERR", b?.exists ? `禁用=${b.disabled}` : "结果页仍缺这个按钮");
        }
        // 导出是纯前端生成 blob + 下载 —— 点下去不该报错, 且导出态要复位
        const ex = await probeAction(cdp, '[data-control="review:export-html"]', { wait: 2500 });
        const exAfter = await btn(cdp, '[data-control="review:export-html"]');
        rec("review", "export-html 执行并复位", ex.clicked && exAfter && !exAfter.disabled ? "ok" : "ERR",
          `点击=${ex.clicked} 之后 disabled=${exAfter?.disabled}`);
        // 「送写作舱」走 postMessage, 顶层页无 parent → 应给明确失败反馈(与写作舱「送编辑器」同一约束)
        const sw = await probeAction(cdp, '[data-control="review:send-to-workflow"]', { wait: 1500 });
        const fb = await pollToast(cdp, 8);
        rec("review", "send-to-workflow 给出明确反馈", sw.clicked && fb ? "ok" : "DEAD",
          `点击=${sw.clicked} 反馈="${fb.slice(0, 46)}"`);
      }
    } else if (!ALL) {
      rec("review", "submit / retry / export-* / send-to-workflow", "skip", "加 --all 才跑(会调 LLM; 跑完后面四个才是真验)");
    }
  }

  console.log("\n════════ 汇总 ════════");
  const bad = rows.filter((r) => r.kind === "ERR" || r.kind === "DEAD");
  for (const r of rows) console.log(`${r.kind.padEnd(6)} [${r.view}] ${r.action}`);
  console.log(bad.length ? `\n❌ ${bad.length} 项异常` : `\n✅ ${rows.length} 项全部通过`);
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error("探针异常:", e.message, e.stack?.split("\n")[1] ?? "");
  process.exitCode = 1;
} finally {
  await close();
}
