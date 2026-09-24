// scripts/probe-input-clarify-and-phase.mjs — 选题界定页「澄清轮」+ 阶段推进条 动作探针
//
// 覆盖表第四轮: 这两处此前一个动作都没验过。
//   输入页: 主题/字数/研究方法/参考来源 四个输入 + 澄清轮四态(idle/loading/error/done)
//   阶段条: 新项目(真建项目并切指针) —— 这条链会**动历史数据**, 单独验
//
// 同样分两类结果: verify-* 管"长什么样", 这里管"点下去做没做事"。
// 用法: node scripts/probe-input-clarify-and-phase.mjs        (需 4173 已起)
//       node scripts/probe-input-clarify-and-phase.mjs --all  (含真调 LLM 的澄清, 慢)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, probeAction, waitFor, readToast } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
const ALL = process.argv.includes("--all");
const rows = [];
function rec(action, kind, detail) {
  rows.push({ action, kind, detail });
  /**
   * ⚠ 2026-09-24: 加 `FAIL` 这一档。
   *   原先映射表里只有 ok/dead/gated/err, 没有 FAIL —— 而 `kind` 传的是自由字符串,
   *   传了未知值就**落到 `skip`**(兜底分支)。后果: 一条真失败在逐行输出里读作 `skip`,
   *   只有最后的汇总行知道它失败了。**把失败显示成"跳过", 是比不显示更坏的一种谎**。
   *   (实测: 我把 max-width 改回 52ch 复现缺陷, 逐行打的是 `skip ... 行数=2(应为 1)`。)
   */
  const TAG = { ok: "  ok  ", fail: " FAIL ", FAIL: " FAIL ", dead: " DEAD ", DEAD: " DEAD ", gated: " gated", err: " ERR  ", ERR: " ERR  " };
  const tag = TAG[kind] ?? " skip ";
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
  const proj = await api(token, "/research/projects", "POST", { title: TITLE, status: "in-progress", phase: 1, phaseLabel: "选题界定" });
  const pid = (proj?.data ?? proj)?.id;
  if (!pid) throw new Error("建项目失败");
  const INPUT = {
    title: TITLE, outline: "一、引言\n  1.1 研究背景\n二、文献综述\n  2.1 已有研究",
    totalWordCount: 8000, researchMethod: "quantitative", requirements: "需要引用近三年文献", sampleFiles: [],
  };
  const sections = [{ id: "sec_0", title: "引言", level: 1, order: 0, status: "pending" }];
  await api(token, `/research/projects/${pid}/nodes/input`, "PUT", { payload: { input: INPUT, sections } });
  await api(token, `/research/projects/${pid}/workbench`, "PUT", {
    snapshot: { phase: 1, phaseLabel: "选题界定", input: INPUT, sections, variables: [], hypotheses: [] },
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

  // ── ①a 大纲编辑器: 插入模板 ──
  console.log("\n═══ ①a 大纲模板 ═══");
  {
    const before = await evalTop(cdp, `document.querySelectorAll('.oe-row.l1').length`);
    const ins = await evalTop(cdp, `(() => {
      const b = document.querySelector('[data-control="workflow:insert-template"]');
      if (!b) return 'no-btn';
      b.click(); return 'clicked';
    })()`);
    await sleep(1500);
    const after = await evalTop(cdp, `document.querySelectorAll('.oe-row.l1').length`);
    rec("insert-template(插入五段式模板)", ins === "clicked" && after > before ? "ok" : "ERR",
      `按钮=${ins} 一级章节 ${before} → ${after}`);
  }

  // ── ①b 草稿的**恢复**路径(只写不读 = 白写) ──
  //
  // 判据是「`hasSaved` 为假才会走草稿」:
  //   `const hasSaved = !!store.taskId && !!(store.input.title || store.input.outline); if (!hasSaved) loadDraft()`
  // 而 `store.taskId` 由 `loadProject()` 决定, 它的顺序是:
  //   ① 消费历史深链指针 → ② 读 `lastTask_workflow` → ③ **都没有就 list 出模块内任一进行中的任务并采纳**。
  //
  // ⚠ 2026-09-21 改: 原断言只 `removeItem('lastTask_workflow')` 就刷新, 以为会落到"无项目"——
  //   实际第 ③ 步会把**上一个探针留下的进行中项目**捡回来, taskId 非空且它有 input,
  //   hasSaved 为真 → 草稿按设计**不该**被加载。所以这条长期报 ERR, 而代码是对的。
  //   要真正走到草稿那条路, 必须让第 ③ 步也拿不到可用项目:
  //   指针指向一个**刚被删掉**的项目 —— loadProject 采纳它 → getWorkbench 拿不到 → 早返回,
  //   但 taskId 已非空而输入仍是空的, hasSaved 恰好为假。这既是"新项目"的真实形态,
  //   也顺带锁住了"指针指向已删项目时不能把界面卡死"。
  console.log("\n═══ ①b 草稿恢复 ═══");
  {
    const gone = await api(token, "/research/projects", "POST", { title: `草稿恢复-已删-${Date.now()}` });
    // `api()` 在非 2xx 时返回 `{__status}`(没有 id 字段), 所以两种形状都要接住 ——
    //   只写 `gone.id` 会让失败路径上 gonePid 变成 undefined, 指针被写成空串,
    //   于是又退回第 ③ 步(采纳别的进行中任务), 草稿照旧不恢复。
    const gonePid = gone.id ?? gone.data?.id;
    if (gonePid) await api(token, `/research/projects/${gonePid}`, "DELETE");
    await evalTop(cdp, `localStorage.setItem('skf_draft', JSON.stringify({ title: '草稿恢复验证', outline: '一、草稿大纲', requirements: '草稿要求', researchMethod: 'mixed', totalWordCount: 33000, clarifyAnswers: {} }))`);
    await evalTop(cdp, `localStorage.setItem('lastTask_workflow', ${JSON.stringify(gonePid ?? "")})`);
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
    /**
     * ⚠ 2026-09-24: 断言改成**按当前状态驱动**, 不再假设"初始是折叠的"。
     *
     * 起因: 手风琴的默认状态从折叠改成了**展开**(用户要求"保持一直打开")。
     *   原断言是"点一下 → 应该变成展开", 于是在新默认下, 点一下反而把它**折叠**了,
     *   探针如实报 DEAD —— 那是**断言前提过期**, 不是功能坏了。
     *
     * 现在要验的是"这个手风琴**能开合**", 与初始状态无关:
     *   先读当前是否展开 → 点 → 断言状态**翻转**了 → 再点回来(把页面还原, 后面的步骤还等着用)。
     *   断言的对象没变(手风琴可开合), 只是不再把它钉死在某一个初始状态上。
     */
    const readOpen = () => evalTop(cdp, `(() => {
      const b = document.querySelector('.clarify-body');
      return { open: !!b, hasRun: !!document.querySelector('[data-control="workflow:clarify"]') };
    })()`);
    const before = await readOpen();
    const toggle = await probeAction(cdp, '[data-control="workflow:clarify-toggle"]', { wait: 900 });
    const after = await readOpen();
    const flipped = !!before?.open !== !!after?.open;
    rec("clarify-toggle(手风琴可开合)", toggle.clicked && flipped ? "ok" : "DEAD",
      `初始展开=${before?.open} → 点击后展开=${after?.open}(应翻转) 有「AI 分析我的研究」=${after?.hasRun}`);
    // 还原成"展开"态, 后面的步骤要在这个状态下继续
    if (!after?.open) await probeAction(cdp, '[data-control="workflow:clarify-toggle"]', { wait: 900 });
    const opened = await readOpen();

    /**
     * 「AI 分析我的研究」按钮**真的居中**(左右余量相等)。
     *
     * 由来(2026-09-24 用户反馈): 按钮黏在卡片左边缘、右边空一大片。
     *   根因是 `.clarify-idle` 上的 `text-align: left` 被 inline-block 的按钮继承 ——
     *   那条 left 当初是为了修"提示语换行断点难看"加的, 而换行问题后来是靠**缩短文案**解决的,
     *   留下的 text-align 就不再保护任何东西, 只是把主按钮推到角上。
     *
     * 为什么必须进探针: 这类"位置偏了"**没有任何报错**, 界面上看就是有点别扭;
     *   而它极易被下一次排版调整带回来(改个 padding / 改个 display 就够了)。
     *   判据用**左右余量之差**而不是具体像素 —— 卡片宽度随视口变, 写死数字必然过期。
     *   容差 4px: 子像素舍入, 不是布局问题。
     */
    const centerInfo = await evalTop(cdp, `(() => {
      const b = document.querySelector('.clarify-body .btn-clarify-run');
      if (!b) return { missing: true };
      const bb = b.getBoundingClientRect();
      // 参照系取按钮所在的**状态块**(.clarify-idle 等). 取不到就退到父元素,
      // 免得将来加新状态时这条断言因为选择器过期而假红。
      const box = b.closest('.clarify-idle, .clarify-loading, .clarify-error, .clarify-done-empty') || b.parentElement;
      if (!box) return { missing: true };
      const xb = box.getBoundingClientRect();
      const ctr = (e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; };
      const boxCtr = ctr(box);
      // 提示语: 取块里**第一个** p。带底色的 .cq-analysis 是正文块, 按设计不参与居中, 排除。
      const p = [...box.querySelectorAll('p')].find((e) => !e.classList.contains('cq-analysis')) || null;
      return {
        btnOffset: Math.round(ctr(b) - boxCtr),
        btnW: Math.round(bb.width), boxW: Math.round(xb.width),
        textOffset: p ? Math.round(ctr(p) - boxCtr) : null,
        textLines: (() => { if (!p) return null; const lh = parseFloat(getComputedStyle(p).lineHeight) || 16; return Math.round(p.getBoundingClientRect().height / lh * 10) / 10; })(),
        gap: p ? Math.round(bb.top - p.getBoundingClientRect().bottom) : null,
        // 折叠状态下量出来的盒子是"幽灵盒"(点不到), 那种不算
        hittable: (() => { const t = document.elementFromPoint(Math.round(bb.left + bb.width / 2), Math.round(bb.top + bb.height / 2)); return !!t && (t === b || b.contains(t)); })(),
      };
    })()`);
    if (centerInfo?.missing) {
      rec("clarify 主按钮居中", "skip", "未渲染(可能尚未生成问题) —— 这条只在 idle/error/空结果态适用");
    } else if (!centerInfo.hittable) {
      rec("clarify 主按钮居中", "skip", "按钮不可命中(折叠中), 不量 —— 那是幽灵盒");
    } else {
      // 判据用**与中轴的偏移**而不是左右余量之差: 前者直接就是"居中没有"的定义,
      // 且块内 padding 左右不等时也不会误判。容差 4px = 子像素舍入, 不是布局问题。
      rec("clarify 主按钮居中", Math.abs(centerInfo.btnOffset) <= 4 ? "ok" : "FAIL",
        `偏离中轴=${centerInfo.btnOffset}px(容差 4) 卡片宽=${centerInfo.boxW} 按钮宽=${centerInfo.btnW}`);
      /**
       * 提示语也要居中, 且**不能被挤成两行**。
       *
       * 这两点都是用户 2026-09-24 直接反馈的:
       *   ① "这句话也没居中" —— 当时按钮已居中而文字靠左, 一条竖线上半左半中;
       *   ② 我第一版修这题时给段落写了 `max-width: 52ch` —— **ch 是数字"0"的宽度(约 6px),
       *      不是汉字宽度**, 52ch 只有约 312px, 那句 33 字的话直接被折成两行。本仓已经踩过
       *      这个坑并写在 InputView 的注释里, 我照样又踩了一次 —— 所以必须进断言。
       */
      if (centerInfo.textOffset === null) {
        rec("clarify 提示语居中", "skip", "本状态块里没有提示语段落");
      } else {
        rec("clarify 提示语居中", Math.abs(centerInfo.textOffset) <= 4 ? "ok" : "FAIL",
          `偏离中轴=${centerInfo.textOffset}px(容差 4)`);
        rec("clarify 提示语不被挤成两行", centerInfo.textLines !== null && centerInfo.textLines <= 1.2 ? "ok" : "FAIL",
          `行数=${centerInfo.textLines}(应为 1)`);
      }
      // 文案与按钮之间要有呼吸 —— 用户反馈"挨得太近", 原来是 0px(p 只设了 margin-top, 下边距为 0)。
      rec("clarify 提示语与按钮有间距", centerInfo.gap !== null && centerInfo.gap >= 8 ? "ok" : "FAIL",
        `间距=${centerInfo.gap}px(应 >= 8)`);
    }

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
    rec("新项目落回选题界定页", /\/workflow\/input/.test(hash ?? "") ? "ok" : "ERR", `hash=${hash}`);
  }

  console.log("\n════════ 汇总 ════════");
  // ⚠ 判"失败"必须把 FAIL 也算上 —— 原先只认 ERR/DEAD, 而失败就是失败, 叫什么名字都得算。
  //   (同 rec() 的 TAG 表: 「失败显示成跳过 / 失败不计入退出码」是同一类谎, 一次修掉两处。)
  const BAD = new Set(["ERR", "DEAD", "FAIL"]);
  const bad = rows.filter((r) => BAD.has(String(r.kind).toUpperCase()));
  for (const r of rows) console.log(`${String(r.kind).padEnd(6)} ${r.action}`);
  console.log(bad.length ? `\n❌ ${bad.length} 项异常: ${bad.map((r) => r.action).join(", ")}` : `\n✅ ${rows.length} 项全部通过`);
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error("探针异常:", e.message, e.stack?.split("\n")[1] ?? "");
  process.exitCode = 1;
} finally {
  await close();
}
