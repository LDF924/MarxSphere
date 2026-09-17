// scripts/probe-input-clarify-and-phase.mjs — 信息录入页「澄清轮」+ 阶段推进条 动作探针
//
// 覆盖表第四轮: 这两处此前一个动作都没验过。
//   输入页: 主题/字数/研究方法/参考来源 四个输入 + 澄清轮四态(idle/loading/error/done)
//   阶段条: 新项目(真建项目并切指针) —— 这条链会**动历史数据**, 单独验
//
// 同样分两类结果: verify-* 管"长什么样", 这里管"点下去做没做事"。
// 用法: node scripts/probe-input-clarify-and-phase.mjs        (需 4173 已起)
//       node scripts/probe-input-clarify-and-phase.mjs --all  (含真调 LLM 的澄清, 慢)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, probeAction, waitFor } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
const ALL = process.argv.includes("--all");
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
const readToast = (cdp) => evalTop(cdp, `(() => {
  const t = [...document.querySelectorAll('div')].find(d => { const st = d.getAttribute('style')||''; return st.includes('position') && st.includes('fixed'); });
  return t ? (t.innerText||'').replace(/\\s+/g,' ').slice(0, 60) : '';
})()`);
/** 轮询读 toast(存活约 3.2s, 固定延时读一次会扑空) */
async function pollToast(cdp, n = 10) {
  let fb = "";
  for (let i = 0; i < n && !fb; i++) { await sleep(300); fb = (await readToast(cdp)) || ""; }
  return fb;
}

const { cdp, ev, close } = await startCdp({ preferredPort: 31057, label: "probe-input-clarify-and-phase" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");

  // ── 播种: 含研究方法与参考来源的完整输入 ──
  const TITLE = `输入探针-${Date.now()}`;
  const proj = await api(token, "/research/projects", "POST", { title: TITLE, status: "in-progress", phase: 1, phaseLabel: "信息录入" });
  const pid = (proj?.data ?? proj)?.id;
  if (!pid) throw new Error("建项目失败");
  const INPUT = {
    title: TITLE, outline: "一、引言\n  1.1 研究背景\n二、文献综述\n  2.1 已有研究",
    totalWordCount: 8000, researchMethod: "quantitative", requirements: "需要引用近三年文献", sampleFiles: [],
  };
  const sections = [{ id: "sec_0", title: "引言", level: 1, order: 0, status: "pending" }];
  await api(token, `/research/projects/${pid}/nodes/input`, "PUT", { payload: { input: INPUT, sections } });
  await api(token, `/research/projects/${pid}/workbench`, "PUT", {
    snapshot: { phase: 1, phaseLabel: "信息录入", input: INPUT, sections, variables: [], hypotheses: [] },
  });
  console.log(`项目 ${pid}\n`);

  await openSoc(cdp, BASE, "/workflow/input", token, pid);
  await spyInstall(cdp);

  // ── ① 输入控件 ──
  //   ⚠ 本页**不写后端快照**: `autoSave()` 落的是 localStorage 草稿(`skf_draft`),
  //     后端只在「提交研究主题」(submit-analysis) 时才收到这些字段。
  //     第一版探针按"改完后端快照要变"判, 三条全 ERR/DEAD —— 那是断言口径错, 不是缺陷。
  console.log("\n═══ ① 输入控件(草稿持久化) ═══");
  {
    const setVal = (sel, val, proto) => evalTop(cdp, `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'no-el';
      Object.getOwnPropertyDescriptor(window.${proto}.prototype, 'value').set.call(el, ${JSON.stringify(val)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'set';
    })()`);
    const draft = () => evalTop(cdp, `(() => { try { return JSON.parse(localStorage.getItem('skf_draft') || '{}'); } catch (e) { return {}; } })()`);

    const t1 = await setVal('[data-control="workflow:research-title"]', "探针改名后的研究主题", "HTMLInputElement");
    await sleep(900);
    const d1 = await draft();
    rec("research-title(改标题落草稿)", t1 === "set" && d1?.title === "探针改名后的研究主题" ? "ok" : "ERR",
      `输入=${t1} 草稿 title="${d1?.title ?? ""}"`);

    const w1 = await setVal('[data-control="workflow:total-word-count"]', "12000", "HTMLInputElement");
    await sleep(900);
    const d2 = await draft();
    rec("total-word-count(改字数落草稿)", w1 === "set" && Number(d2?.totalWordCount) === 12000 ? "ok" : "ERR",
      `输入=${w1} 草稿 totalWordCount=${d2?.totalWordCount ?? ""}`);

    // 研究方法三卡
    const has = await evalTop(cdp, `document.querySelectorAll('[data-control^="workflow_method_"]').length`);
    if (has > 0) {
      const r = await probeAction(cdp, '[data-control="workflow_method_mixed"]', { wait: 1200 });
      await sleep(600);
      const d3 = await draft();
      const on = await evalTop(cdp, `!!document.querySelector('[data-control="workflow_method_mixed"].selected')`);
      rec("研究方法卡切换", on && d3?.researchMethod === "mixed" ? "ok" : "DEAD",
        `${has} 张卡 | selected=${on} 草稿 researchMethod=${d3?.researchMethod ?? ""}`);
    } else rec("研究方法卡切换", "skip", "未渲染方法卡");

    /**
     * 参考来源勾选(可选中 = 可取消)。
     * ⚠ 不能按"点了必须变成 selected"判 —— 加载时会**默认勾上第一个**源
     *   (见 loadAvailableSources: 未选过则默认勾文档最多的那个), 而这里只有 1 个源,
     *   点一下是**取消**它。有效判据是"选中态发生了翻转"。
     */
    const srcs = await evalTop(cdp, `document.querySelectorAll('[data-control^="workflow_source_"]').length`);
    if (srcs > 0) {
      const n0 = await evalTop(cdp, `document.querySelectorAll('[data-control^="workflow_source_"].selected').length`);
      await probeAction(cdp, '[data-control^="workflow_source_"]', { wait: 1200 });
      await sleep(600);
      const n1 = await evalTop(cdp, `document.querySelectorAll('[data-control^="workflow_source_"].selected').length`);
      rec("参考来源勾选(可切可取消)", n1 !== n0 ? "ok" : "DEAD",
        `${srcs} 个源 → selected ${n0} → ${n1}${n0 > 0 ? "(默认勾第一个, 点一下=取消)" : ""}`);
    } else rec("参考来源勾选", "skip", "未渲染数据源列表(需后端 available-sources 有返回)");
  }

  // ── ①b 草稿的**恢复**路径(只写不读 = 白写) ──
  //   本页的草稿只在「没有已存项目输入」时恢复(见 onMounted 的 hasSaved 判据) ——
  //   有已存项目时服务端快照优先, 否则旧草稿会覆盖掉服务端内容。
  //   所以这里把指针清掉再刷新, 走"新项目"那条路径。
  console.log("\n═══ ①b 草稿恢复 ═══");
  {
    await evalTop(cdp, `localStorage.setItem('skf_draft', JSON.stringify({ title: '草稿恢复验证', outline: '一、草稿大纲', requirements: '草稿要求', researchMethod: 'mixed', totalWordCount: 33000, clarifyAnswers: {} }))`);
    await evalTop(cdp, `localStorage.removeItem('lastTask_workflow')`);
    await cdp("Page.reload");
    await sleep(9000);
    const shown = await evalTop(cdp, `(() => ({
      title: document.querySelector('[data-control="workflow:research-title"]')?.value,
      wc: document.querySelector('[data-control="workflow:total-word-count"]')?.value,
      methodOn: !!document.querySelector('[data-control="workflow_method_mixed"].selected'),
    }))()`);
    rec("刷新后从草稿恢复(标题/字数/方法)", shown?.title === "草稿恢复验证" && shown?.wc === "33000" && shown?.methodOn ? "ok" : "ERR",
      `标题="${shown?.title}" 字数=${shown?.wc} 方法选中=${shown?.methodOn}`);
    // 还原: 重新指回播种项目, 免得后续小节跑在空项目上
    await evalTop(cdp, `localStorage.setItem('lastTask_workflow', ${JSON.stringify(pid)})`);
    await cdp("Page.reload");
    await sleep(8000);
    await spyInstall(cdp);
  }

  // ── ② 澄清轮(手风琴 + 四态) ──
  console.log("\n═══ ② 澄清轮 ═══");
  {
    const toggle = await probeAction(cdp, '[data-control="workflow:clarify-toggle"]', { wait: 900 });
    const opened = await evalTop(cdp, `(() => {
      const b = document.querySelector('.clarify-body');
      return { open: !!b, hasRun: !!document.querySelector('[data-control="workflow:clarify"]') };
    })()`);
    rec("clarify-toggle(展开手风琴)", toggle.clicked && opened?.open ? "ok" : "DEAD",
      `点击=${toggle.clicked} 展开=${opened?.open} 有「AI 分析我的研究」=${opened?.hasRun}`);

    if (ALL && opened?.hasRun) {
      const run = await probeAction(cdp, '[data-control="workflow:clarify"]', { wait: 3500 });
      rec("clarify(生成引导问题)", run.apiReqs.length ? "ok" : "DEAD",
        run.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "零请求");
      // 三分钟后端超时; 这里等它出结果(done 或 error 都算"状态机走到了")
      const done = await waitFor(cdp, `(() => {
        const b = document.querySelector('.clarify-done, .clarify-error, .clarify-idle');
        return b ? b.className : null;
      })()`, { timeout: 240000, every: 3000 });
      rec("澄清状态机落到终态", done ? "ok" : "ERR", `终态=${done ?? "240s 内未落"}`);
      if (/clarify-error/.test(done ?? "")) {
        const err = await evalTop(cdp, `(document.querySelector('.clarify-error')?.innerText || '').slice(0, 60)`);
        rec("失败态给了重试入口", true, `错误="${err}"(有「重新生成引导问题」按钮)`);
      }
      // 有下一轮按钮 → 验轮次上限(闭源 2 轮)
      const next = await evalTop(cdp, `(() => {
        const b = document.querySelector('[data-control="workflow:clarify-next-round"]');
        return b ? { has: true, disabled: b.disabled, text: b.textContent.trim() } : { has: false };
      })()`);
      if (next?.has) {
        const r = await probeAction(cdp, '[data-control="workflow:clarify-next-round"]', { wait: 3500 });
        rec("clarify-next-round(下一轮)", r.apiReqs.length ? "ok" : "DEAD",
          `文案="${next.text}" ${r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "零请求"}`);
      } else rec("clarify-next-round(下一轮)", "skip", "本轮无引导问题 → 不渲染该按钮(条件渲染, 非缺陷)");
    } else if (!ALL) {
      rec("clarify / clarify-regen / clarify-retry / clarify-next-round", "skip", "需真 LLM 且依赖后端返回, 加 --all 才跑");
    }
  }

  // ── ③ 阶段推进条: 新项目(会真建项目) ──
  console.log("\n═══ ③ 阶段推进条 ═══");
  {
    const beforePtr = await evalTop(cdp, `localStorage.getItem('lastTask_workflow')`);
    const r = await probeAction(cdp, '[data-control="workflow:new-project"]', { wait: 1200 });
    // 会弹 confirmDialog(闭源语义: 确认后真建项目), 必须自己点确认
    const cf = await evalTop(cdp, `(() => {
      const btns = [...document.querySelectorAll('button')].filter(x => {
        let p = x.parentElement; while (p) { if (getComputedStyle(p).position === 'fixed') return true; p = p.parentElement; } return false;
      }).map(b => b.textContent.trim());
      return btns;
    })()`);
    rec("new-project(先弹确认层)", r.apiReqs.length === 0 && cf.length > 0 ? "ok" : (r.apiReqs.length ? "ERR" : "DEAD"),
      `确认前零请求=${r.apiReqs.length === 0} 确认层=${JSON.stringify(cf)}`);

    const clicked = await evalTop(cdp, `(() => {
      const b = [...document.querySelectorAll('button')].filter(x => {
        let p = x.parentElement; while (p) { if (getComputedStyle(p).position === 'fixed') return true; p = p.parentElement; } return false;
      }).find(x => /开始新项目/.test(x.textContent));
      if (!b) return false; b.click(); return true;
    })()`);
    await sleep(3500);
    const afterPtr = await evalTop(cdp, `localStorage.getItem('lastTask_workflow')`);
    const hash = await evalTop(cdp, `location.hash`);
    // ⚠ 不能判"项目总数 +1": `/research/projects` 有**数量上限**(实测恒为 100),
    //   新项目可能被分页挡在外面。改判"指针切到一个**真实存在的新项目**"。
    const fresh = afterPtr ? await api(token, `/research/projects/${afterPtr}`) : null;
    const freshOk = !!(fresh?.project ?? fresh?.data);
    rec("new-project 确认后真建项目并切指针",
      clicked && !!afterPtr && afterPtr !== beforePtr && freshOk ? "ok" : "ERR",
      `指针 ${String(beforePtr).slice(0, 8)} → ${String(afterPtr).slice(0, 8)} 该项目可读=${freshOk} hash=${hash}`);
    rec("新项目落回信息录入页", /\/workflow\/input/.test(hash ?? "") ? "ok" : "ERR", `hash=${hash}`);
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
