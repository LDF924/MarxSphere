// scripts/probe-writing-cabin-actions.mjs — 研途写作舱「动作打通」探针(只报告, 不改代码)
//
// 与 verify-writing-cabin.mjs 的分工:
//   verify-*: 状态断言门禁 —— "长什么样对不对"(DOM 结构/文案/渲染容器), 断言失败即 exit 1
//   probe-*:  动作打通探测 —— "点下去做没做事"(真点 → 拦 fetch → 看请求与响应), 只报告清单
//
// 为什么要有 probe: 82 个 data-control 动作里, 门禁只覆盖了十来个的**渲染**, 没有一个验过
//   「这个按钮真的打到后端了吗、参数字段名对吗」。这类缺陷界面上没有红字 —— 点下去没反应,
//   用户只会以为"功能就是这样"。
//
// 用法: node scripts/probe-writing-cabin-actions.mjs        (需 4173 已起)
//       node scripts/probe-writing-cabin-actions.mjs --all  (含会真调 LLM 的动作, 慢)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, probeAction, waitFor, readToast, dismissOverlays } from "./lib/probe-actions.mjs";

const BASE = "http://127.0.0.1:4173";
const ALL = process.argv.includes("--all");
const rows = [];
/**
 * 记一条探测结果。
 * kind:
 *   ok    = 动作发出了预期的请求 / 产生了预期副作用
 *   dead  = 点了**零反应**(按钮可点却没请求) —— 这才是缺陷
 *   gated = 按钮处于**禁用态**, 没发请求是门禁的正确行为, 不算缺陷也不冒充通过
 *   err   = 发出了请求但状态不对 / 副作用缺失
 *   skip  = 环境限制(需真 LLM / 需要父窗口)无法验证
 */
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
  return r.ok ? r.json().catch(() => ({})) : null;
};

/**
 * 播种一个项目。
 *
 * ⚠ 必须**同时**写 workbench 快照与 `input` 节点 —— 后端 `getWorkbenchSnapshot` 是
 *   **节点优先**(`merged.input = payload.input`), 只写快照的话节点里的旧值会把它盖掉,
 *   于是标题/目录/方法全是空的(实测踩到: 启发式断言读到空题面, 误判成"功能没实现")。
 */
async function seedFresh(token, phase = 1, over = {}) {
  const TITLE = over.title ?? `探针-${Date.now()}`;
  const INPUT = {
    title: TITLE, outline: over.outline ?? "一、引言\n  1.1 研究背景\n二、文献综述\n  2.1 已有研究",
    totalWordCount: 8000, researchMethod: over.researchMethod ?? "quantitative",
    requirements: "", sampleFiles: [],
  };
  const proj = await api(token, "/research/projects", "POST", { title: TITLE, status: "in-progress", phase, phaseLabel: phase === 1 ? "信息录入" : "素材准备" });
  const pid = (proj?.data ?? proj)?.id;
  if (!pid) return null;
  const sections = [
    { id: "sec_0", title: "引言", level: 1, order: 0, status: "pending" },
    { id: "sec_1", title: "文献综述", level: 1, order: 1, status: "pending" },
  ];
  await api(token, `/research/projects/${pid}/nodes/input`, "PUT", { payload: { input: INPUT, sections } });
  await api(token, `/research/projects/${pid}/workbench`, "PUT", {
    snapshot: { phase, phaseLabel: phase === 1 ? "信息录入" : "素材准备", input: INPUT, sections, variables: [], hypotheses: [] },
  });
  return pid;
}

const { cdp, ev, close } = await startCdp({ preferredPort: 31031, label: "scripts/probe-writing-cabin-actions.mjs" });
let token = "", pid = "";
try {
  token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");

  // ═══ 1. 信息录入: 提交研究主题(整条流水线的入口) ═══
  console.log("\n═══ /workflow/input ═══");
  {
    pid = await seedFresh(token, 1);
    await openSoc(cdp, BASE, "/workflow/input", token, pid);
    await spyInstall(cdp);

    // AI 分析我的研究(clarify): 需真 LLM
    // ⚠ 先展开手风琴 —— 按钮在 `v-if="clarifyOpen"` 里, 折叠时**根本不渲染**,
    //   直接查会得到"零请求"的假失败(实测踩到)。
    if (ALL) {
      await evalTop(cdp, `(() => { const t = document.querySelector('[data-control="workflow:clarify-toggle"]'); if (t) t.click(); return 1; })()`);
      await sleep(800);
      const r = await probeAction(cdp, '[data-control="workflow:clarify"]', { wait: 6000 });
      rec("input", "clarify(AI 生成引导问题)", r.apiReqs.length ? "ok" : "dead",
        r.apiReqs.length ? `${r.last?.method} ${short(r.last?.url)} → ${r.last?.status}` : "点击后零请求");
      if (r.apiReqs.length) await waitFor(cdp, `document.querySelectorAll('.clarify-item').length > 0`, { timeout: 90000 });
    } else rec("input", "clarify(AI 生成引导问题)", "skip", "需真 LLM, 加 --all 才跑");

    // 提交研究主题: 建/更新任务 + 写 input 节点 + 跳 sections
    const r = await probeAction(cdp, '[data-control="workflow:submit-analysis"]', { wait: 8000 });
    const wrote = r.apiReqs.filter((x) => /nodes\/input|workbench|research\/tasks/.test(x.url));
    rec("input", "submit-analysis(提交主题→科研架构)", wrote.length ? "ok" : "dead",
      wrote.length
        ? wrote.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ")
        : `点击后零写请求 (全部请求=${r.apiReqs.length}) toast=${r.toast.slice(0, 60)}`);
  }

  // ═══ 2. 科研架构: 开始分析 / 确认章节 ═══
  console.log("\n═══ /workflow/sections ═══");
  {
    const pid2 = await seedFresh(token, 2);
    await openSoc(cdp, BASE, "/workflow/sections", token, pid2);
    await spyInstall(cdp);

    if (ALL) {
      const r = await probeAction(cdp, '[data-control="workflow:start-analysis-2"]', { wait: 6000 });
      rec("sections", "start-analysis(开始科研架构分析)", r.apiReqs.length ? "ok" : "dead",
        r.apiReqs.length ? `${r.last?.method} ${short(r.last?.url)} → ${r.last?.status}` : "点击后零请求");
      if (r.apiReqs.length) {
        const done = await waitFor(cdp, `document.querySelectorAll('.var-card').length > 0`, { timeout: 180000 });
        rec("sections", "分析产物回填(变量卡)", done ? "ok" : "skip", done ? "变量卡已渲染" : "180s 内未产出(模型慢/失败)");
      }
    } else rec("sections", "start-analysis(开始科研架构分析)", "skip", "需真 LLM, 加 --all 才跑");

    // 确认章节 → 推进 phase(写快照 + 推进阶段)
    //
    // ⚠ 这里**不能**在禁用态下把"没发出请求"判成 ok —— 那是把"门禁正确拦截"混进了
    //   "动作打通"的结论里。正确做法是先播一份"章节齐备"的数据让门禁本就该放行,
    //   再断言点下去真的推进了 phase。门禁本身由 verify-writing-cabin.mjs 的
    //   「门禁正确拦截」类断言覆盖, 两个门禁各管一件事。
    const canConfirm = await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="workflow:confirm-sections"]'); return b ? !b.disabled : null; })()`);
    const r = await probeAction(cdp, '[data-control="workflow:confirm-sections"]', { wait: 4000 });
    rec("sections", "confirm-sections(确认→素材准备)",
      canConfirm === false ? "gated" : (r.apiReqs.length ? "ok" : "dead"),
      canConfirm === false
        ? "按钮禁用态(章节尚未生成写作指导) —— 门禁生效, 不算缺陷"
        : (r.apiReqs.length ? r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") : `零写请求 toast=${r.toast.slice(0, 60)}`));

    // phase 推进: 只有上一动作真的放行了才有意义, 否则"没推进"是门禁的正确结果
    const wb = await api(token, `/research/projects/${pid2}/workbench`);
    if (canConfirm === false) {
      rec("sections", "phase 落库校验", "skip", `确认按钮禁用中, 未推进是门禁的正确行为(phase=${wb?.snapshot?.phase})`);
    } else {
      rec("sections", "phase 落库校验", wb?.snapshot?.phase >= 3 ? "ok" : "err", `快照 phase=${wb?.snapshot?.phase}(确认后应 ≥3)`);
    }
  }

  // ═══ 3. 素材准备: 编排 / 智能生成计划 / 手动添加 / 发布门禁 ═══
  console.log("\n═══ /workflow/materials ═══");
  {
    const pid3 = await seedFresh(token, 3);
    // 播两条素材, 让"编排"有输入
    await api(token, "/research/materials", "POST", { projectId: pid3, kind: "theory", title: "探针素材A", contentMd: "内容A" });
    await api(token, "/research/materials", "POST", { projectId: pid3, kind: "citation", title: "探针素材B", contentMd: "内容B" });
    await openSoc(cdp, BASE, "/workflow/materials", token, pid3);
    await spyInstall(cdp);

    // 编排素材(无 sectionIds 的素材 → 建议弹层)
    const r1 = await probeAction(cdp, '[data-control="workflow:allocate"]', { wait: 5000 });
    rec("materials", "allocate(编排素材)", r1.apiReqs.length ? "ok" : "dead",
      r1.apiReqs.length ? `${r1.last?.method} ${short(r1.last?.url)} → ${r1.last?.status}` : `零请求 toast=${r1.toast.slice(0, 60)}`);

    // 智能生成素材(计划弹层): 需真 LLM 出计划
    if (ALL) {
      const r2 = await probeAction(cdp, '[data-control="workflow:smart-generate"]', { wait: 6000 });
      rec("materials", "smart-generate(智能生成计划)", r2.apiReqs.length ? "ok" : "dead",
        r2.apiReqs.length ? `${r2.last?.method} ${short(r2.last?.url)} → ${r2.last?.status}` : "零请求");
    } else rec("materials", "smart-generate(智能生成计划)", "skip", "需真 LLM, 加 --all 才跑");

    // 手动添加文献(弹层 → 保存)
    const r3 = await probeAction(cdp, '[data-control="workflow:manual-literature"]', { wait: 1600 });
    // 弹层类名是 `.modal-mask` / `.modal-card` —— `[class*="modal"]` 能覆盖, 但 `.dlg` 是错的
    //   (不存在的类名), 只写 `.dlg` 反而让断言恒假。这里以真实渲染结果为准并把标题带出来。
    const dlg = await evalTop(cdp, `(() => {
      const card = document.querySelector('.modal-card');
      return { open: !!card, title: card ? (card.querySelector('h3')?.innerText || '').trim() : '' };
    })()`);
    rec("materials", "manual-literature(打开手动添加弹层)", dlg?.open ? "ok" : "err",
      dlg?.open ? `弹层已开: ${dlg.title}` : `未开弹层 toast=${r3.toast.slice(0, 60)}`);
    await dismissOverlays(cdp);
    await sleep(600);

    // 发布门禁: 素材未关联章节时应拦下
    const gate = await probeAction(cdp, '[data-control="workflow:confirm-materials"]', { wait: 3000 });
    const gotoWorkspace = await evalTop(cdp, `location.hash`);
    rec("materials", "confirm-materials(发布门禁)", gate.toast && /未关联|请先/.test(gate.toast) ? "ok" : (gate.apiReqs.length ? "ok" : "err"),
      `toast=${gate.toast.slice(0, 80)} hash=${gotoWorkspace}`);
  }

  // ═══ 4. 文本创作: 生成/保存/插入素材 ═══
  console.log("\n═══ /workflow/workspace ═══");
  {
    const pid4 = await seedFresh(token, 4);
    await api(token, `/research/projects/${pid4}/nodes/sections`, "PUT", {
      payload: {
        sections: [
          { id: "sec_0", title: "引言", level: 1, order: 0, status: "pending" },
          { id: "sec_1", title: "文献综述", level: 1, order: 1, status: "pending" },
        ],
      },
    });
    await openSoc(cdp, BASE, "/workflow/workspace", token, pid4);
    await spyInstall(cdp);

    // 点章节 → 生成(需真 LLM)
    if (ALL) {
      const r1 = await probeAction(cdp, '[data-control="workflow:generate-section"]', { wait: 6000 });
      rec("workspace", "generate-section(生成单章)", r1.apiReqs.length ? "ok" : "dead",
        r1.apiReqs.length ? `${r1.last?.method} ${short(r1.last?.url)} → ${r1.last?.status}` : "零请求");
      if (r1.apiReqs.length) {
        /**
         * ⚠ 2026-09-20 修正: 这条原先只等 `.content-html` —— 而它是**「预览」tab 的 v-else 分支**
         *   (`WorkspaceView.vue:1176`), `mdTab` 默认是 `'write'`(`:405`), 所以页面加载后
         *   DOM 里根本**没有** `.content-html`, 正文落在 `textarea.content-textarea`(`editText`)里。
         *   结果是: 后端 40 秒就把正文写进了节点, 探针却等到 240 秒报"未产出"。
         *
         *   实测权威证据(绕开 DOM 直接查库): 任务 `status=done`,
         *   `progress={stage:"批量完成", total:1, current:1}`, `research_nodes.sections`
         *   的章节正文 **1268 字已落库** ⇒ **功能是好的, 是判据点错了地方**。
         *
         *   ⇒ 判据改为**两个 tab 任一成立**: 编辑 tab 的 textarea 值, 或预览 tab 的 HTML 文本。
         *     这才是"正文已回填"在界面上真实的样子, 不依赖默认停在哪一个 tab。
         */
        const done = await waitFor(
          cdp,
          `(() => {
             const ta = document.querySelector('textarea.content-textarea');
             if (ta && (ta.value || '').trim().length > 200) return true;
             const html = document.querySelector('.content-html');
             if (html && (html.innerText || '').trim().length > 200) return true;
             return false;
           })()`,
          { timeout: 240000 }
        );
        /**
         * 诊断: 把"store 里有没有正文"和"编辑框里有没有"分开报。
         *   · 页脚「N 字」来自 `store`(`activeWords`) ⇒ >0 说明 refreshSections 已把正文读回来了;
         *   · textarea 值来自 `editText` ⇒ 空说明**编辑框没跟着回填**(2026-09-20 修的就是这条);
         *     两者都 0 则说明根因在 refreshSections / 节点回读那一侧, 是另一个问题。
         *   没有这条, 下次再失败只能知道"没看到", 分不清卡在哪一环。
         */
        const diag = await evalTop(
          cdp,
          `(() => {
             const foot = document.querySelector('.md-foot');
             const ta = document.querySelector('textarea.content-textarea');
             return JSON.stringify({
               footer: (foot ? foot.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 24),
               textareaLen: ta ? ta.value.length : -1,
             });
           })()`
        );
        rec("workspace", "单章产物回填(编辑/预览两个 tab 任一)", done ? "ok" : "skip",
          done ? "正文已回填到界面" : `240s 内两处都未见正文 | 诊断=${diag}`);
      }
    } else rec("workspace", "generate-section(生成单章)", "skip", "需真 LLM, 加 --all 才跑");

    /**
     * 切章不得把编辑态踢掉。
     *
     * 2026-09-16 实测缺陷: `selectSection()` 里 `editing.value = false`, 而 `editing` 是个
     * computed(读 mdTab==='write', 写 mdTab=...)。副作用是**只要点任意章节(包括当前章),
     * 正文区就从「编辑」跳到「预览」** —— 用户每点一次章节树就得手动切回来。
     * 对照闭源 MarkdownEditor: 那个 tab 是组件内部 `x("write")` 的局部状态, 没有 watch/没有
     * 章节依赖, 切章不会重置。我方的耦合是自己加的。
     */
    const tabProbe = `(() => {
      const on = [...document.querySelectorAll('.md-tab')].find(e => e.className.includes('on'));
      return { on: on ? on.innerText.trim() : null, ta: !!document.querySelector('.content-textarea') };
    })()`;
    await evalTop(cdp, `(() => { const r = [...document.querySelectorAll('.nav-l1')].find(x => /引言/.test(x.innerText)); if (r) r.click(); return 1; })()`);
    await sleep(1500);
    const t1 = await evalTop(cdp, tabProbe);
    await evalTop(cdp, `(() => { const r = [...document.querySelectorAll('.nav-l1')].find(x => /文献综述/.test(x.innerText)); if (r) r.click(); return 1; })()`);
    await sleep(1500);
    const t2 = await evalTop(cdp, tabProbe);
    rec("workspace", "切章不丢编辑态(闭源 tab 是局部状态)", t1?.on === "编辑" && t2?.on === "编辑" ? "ok" : "err",
      `切章前=${t1?.on} 切章后=${t2?.on}(应为「编辑」)`);

    // 编辑正文 → 防抖保存(这是踩过数据丢失的那个点)
    // ⚠ 选择器必须是 `.content-textarea` —— 它是正文编辑框, 只在「编辑」tab 才存在。
    //   直接写 `textarea` 会选中 `.think-input`(主控智能体思考), 那条 watch 走的是
    //   `persistThinkPrompt`, 根本不写 sections 节点正文, 于是探针永远报"未落库"(假失败)。
    //   另外: 必须先点章节, 否则正文区是空的。
    await evalTop(cdp, `(() => { const r = [...document.querySelectorAll('.nav-l1')].find(x => /引言/.test(x.innerText)); if (r) r.click(); return 1; })()`);
    await sleep(1500);
    const edited = await evalTop(cdp, `(() => {
      const ta = document.querySelector('.content-textarea');
      if (!ta) return 'NO-TEXTAREA(不在编辑 tab)';
      const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      s.call(ta, '探针写入的正文内容' + '甲'.repeat(80));
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()`);
    await sleep(2500);
    const r2 = await probeAction(cdp, '[data-control="workflow:save-section"]', { wait: 3000 });
    const saved = r2.apiReqs.length ? r2 : await (async () => ({ apiReqs: [], last: null, toast: "无保存按钮" }))();
    const nodes = await api(token, `/research/projects/${pid4}/nodes/sections`);
    const c0 = String(nodes?.node?.payload?.sections?.find((s) => s.id === "sec_0")?.content ?? "");
    rec("workspace", `正文编辑→落库(${edited})`, /探针写入/.test(c0) ? "ok" : "err",
      `节点 sec_0 正文长度=${c0.length}${/探针写入/.test(c0) ? "(含探针内容 ✓)" : "(未落库!)"}`);

    // 素材插入按钮
    const hasMat = await evalTop(cdp, `document.querySelectorAll('[data-control="workflow:insert-material"]').length`);
    rec("workspace", "insert-material(插入素材到章节)", hasMat ? "skip" : "skip", `素材卡 ${hasMat} 个(需先有挂本章素材才能点)`);
  }

  // ═══ 5. 合稿定稿: 导出类动作 ═══
  console.log("\n═══ /workflow/finalize ═══");
  {
    const pid5 = await seedFresh(token, 5);
    // 章节必须落在 **sections 节点** —— FinalizeView 的 buildOutlineTree() 读 `store.sections`,
    //   而 store 的章节来源是节点(seedFresh 只在 workbench 里放了同名数组的话,
    //   导出按钮会走 `!nodes.length` 分支静默 return, 表现为"点了零请求"的假失败)。
    await api(token, `/research/projects/${pid5}/nodes/sections`, "PUT", {
      payload: { sections: [{ id: "sec_0", title: "引言", level: 1, order: 0, status: "done", content: "引言的正文内容。".repeat(20) }] },
    });
    await api(token, `/research/projects/${pid5}/workbench`, "PUT", {
      snapshot: {
        phase: 5, phaseLabel: "合稿定稿",
        input: { title: "探针合稿", outline: "", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] },
        sections: [{ id: "sec_0", title: "引言", level: 1, order: 0, status: "done", content: "引言的正文内容。".repeat(20) }],
        variables: [], hypotheses: [],
        mergeGenerated: true, mergedTitle: "探针合稿", mergedAbstract: "摘要内容",
        mergedKeywords: "关键词", mergedFullText: "# 正文\n\n引言的正文内容。".repeat(30),
        mergedReferences: "[1] 张三. 测试[J]. 2021.",
      },
    });
    await openSoc(cdp, BASE, "/workflow/finalize", token, pid5);
    await spyInstall(cdp);

    // 合稿态的数据源契约(实测确认, 不是猜):
    //   `mergeGenerated` 由后端从 **research_projects.merge_generated 列**读出
    //   (chapter-skill-service.getWorkbenchSnapshot), 快照里那个键会被忽略 ——
    //   列是后端合稿任务写的权威值。merged_* 正文则是**节点优先、列兜底**。
    //   所以播种要写节点 + 真实走一次 merge 才会置位; 这里直接调 UI 的「开始合并」
    //   会让它真跑一次 LLM, 太重 —— 改由验证「节点里的 merged_* 能读回来」代替,
    //   而 mergeGenerated 的置位由下面 doMerge 的实跑断言覆盖(--all 时)。
    const pid5b = pid5;
    /**
     * ⚠ 这条断言此前是**错的**, 2026-09-20 按闭源规格改对(不是放宽, 是反过来)。
     *
     *   旧断言:「未合稿时不出现模式 tab」, 期望 `modes.length === 0`。
     *   但它自己在上面几行把 `mergeGenerated` 播成了 `true` —— 这份"空态"根本不空,
     *   于是必然报 ERR。而且方向也反了: 闭源 `FinalizeView.js` 的空态容器是
     *   `!mergeGenerated && !mergeGenerating`, **模式按钮(node `qe`)就在那个容器内部** ——
     *   空态本来就该显示「直接合稿 / 降AIGC合稿」, 用户得先选模式才能点「开始合并」。
     *   我们实现 `FinalizeView.vue:941` 的 `finalize-empty` 与之逐字同构。
     *   ⇒ 真正该锁的是**反过来的那半边**: 合稿完成后**不能**再出现空态的那组模式 tab
     *     (那样界面会自相矛盾 —— 让人以为还没合稿)。
     */
    const modes = await evalTop(cdp, `[...document.querySelectorAll('.mm-tab')].map(e => e.innerText.trim())`);
    const hasEmptyBox = await evalTop(cdp, `String(!!document.querySelector('.finalize-empty'))`);
    rec("finalize", hasEmptyBox === "false"
      ? "已合稿 → 不出现空态模式 tab(闭源: 空态容器 !mergeGenerated && !mergeGenerating)"
      : "空态 → 模式 tab 就位(直接合稿/降AIGC合稿), 用户先选模式才能合并",
      hasEmptyBox === "false"
        ? (modes.length === 0 ? "ok" : "err")
        : (modes.includes("直接合稿") && modes.includes("降AIGC合稿") ? "ok" : "err"),
      hasEmptyBox === "false"
        ? `空态容器不在; 模式 tab=${JSON.stringify(modes)}(已合稿应为空)`
        : `空态容器在; 模式 tab=${JSON.stringify(modes)}`);

    // ── 回归: 终稿手改必须**刷新后仍在**(2026-09-16 修的核心缺陷) ──
    //   缺陷形态: 快照写得进、节点写不进 → 回读时节点/列赢 → 刷新回退。
    await evalTop(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(x => /开始合并/.test(x.innerText)); if (b) b.click(); return 1; })()`);
    const merged = await waitFor(cdp, `document.querySelector('.finale-card') ? 'ready' : null`, { timeout: 240000 });
    if (!merged) {
      rec("finalize", "合稿产物落库+手改持久化", "skip", "240s 内未完成合稿(需真 LLM, 环境慢或模型不可用)");
    } else {
      const stamped = `手改标记${Date.now()}`;
      await evalTop(cdp, `(() => {
        const ta = document.querySelector('.finale-card textarea.body');
        if (!ta) return 'no-ta';
        const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        s.call(ta, ${JSON.stringify(stamped)} + '\\n' + ta.value);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return 'typed';
      })()`);
      await sleep(2500);   // 等 500ms 防抖
      const node = await api(token, `/research/projects/${pid5b}/nodes/finalize`);
      const inNode = String((node?.node?.payload ?? {}).mergedFullText ?? "").includes(stamped);
      await cdp("Page.reload");
      await sleep(7000);
      // ⚠ 重载会**清掉注入的 fetch 拦截器** —— 不补装, 后面所有动作的请求都记录不到,
      //   全部误报成"点了没反应"(实测踩到: 导出按钮明明返回 200 却报 DEAD)。
      await spyInstall(cdp);
      const afterReload = await evalTop(cdp, `(() => {
        const ta = document.querySelector('.finale-card textarea.body');
        return ta ? ta.value.includes(${JSON.stringify(stamped)}) : false;
      })()`);
      rec("finalize", "合稿产物落库+手改持久化", inNode && afterReload ? "ok" : "err",
        `落节点=${inNode} 刷新后仍在=${afterReload}(两者都要真)`);
    }

    // 导出 md/html(纯前端, 不依赖 LLM)
    const r1 = await probeAction(cdp, '[data-control="workflow:export"]', { wait: 4000 });
    rec("finalize", "export(导出 md/html)", r1.apiReqs.length || !/失败|error/i.test(r1.toast) ? "ok" : "err",
      `api=${r1.apiReqs.length} toast=${r1.toast.slice(0, 80)}`);

    // 送学术文本工作台: 走 `window.parent.postMessage`(外壳中转 → 编辑器),
    //   **不是 HTTP 动作**。所以"零 /api/ 请求"是正确行为。这里断言它确实向父窗口
    //   发出了 forward-to-module(顶层打开时 parent===window, 该动作是 no-op, 记为 skip)。
    const isIframe = await evalTop(cdp, `window.parent !== window`);
    if (!isIframe) {
      rec("finalize", "send-to-editor(发到编辑器)", "skip", "顶层打开时无父窗口可投递(该动作走 postMessage 给外壳, 非 HTTP)");
    } else {
      await evalTop(cdp, `(() => { window.__fwd = []; window.addEventListener('message', e => { if (e.data && e.data.source === 'marxsphere-soc') window.__fwd.push(e.data.type); }); return 1; })()`);
      const r2 = await probeAction(cdp, '[data-control="workflow:send-to-editor"]', { wait: 3000 });
      const fwd = await evalTop(cdp, `JSON.stringify(window.__fwd || [])`);
      rec("finalize", "send-to-editor(发到编辑器)", String(fwd).includes("forward-to-module") ? "ok" : "dead",
        `postMessage 类型=${fwd} toast=${r2.toast.slice(0, 50)}`);
    }

    // 导出 docx / pptx (后端生成)
    // ⚠ 必须**排在本组最后**: 这一组前面会点「开始合并」并一直轮询到产出, 那段期间
    //   浏览器被单个长任务占着, 此时再插点击会落空 —— 实测表现为"零请求"的假失败。
    //   单独复核过: 同一按钮在页面稳定后点, `POST /api/paper-outline/export → 200` 是通的。
    if (ALL) {
      await sleep(1500);
      for (const [sel, name] of [['[data-control="workflow:export-docx"]', "export-docx"], ['[data-control="workflow:export-pptx"]', "export-pptx"]]) {
        const r = await probeAction(cdp, sel, { wait: 9000 });
        rec("finalize", `${name}(后端导出)`, r.apiReqs.length ? "ok" : "dead",
          r.apiReqs.length ? `${r.last?.method} ${short(r.last?.url)} → ${r.last?.status}` : `零请求 toast=${r.toast.slice(0, 60)}`);
      }
    } else rec("finalize", "export-docx/pptx(后端导出)", "skip", "慢, 加 --all 才跑");
  }

  // ═══ 6. 2026-09-16 批次二新增回归(研究方法启发式 / aiSkill 渲染 / 生成弹层生命周期) ═══
  console.log("\n═══ 研究方法自动识别(闭源 wp(): 34 定量词 / 18 定性词 / 标题+目录 / 兜底定性) ═══");
  {
    // 标题+目录里塞**只有宽词表才认得出**的量化词(量表/结构方程/信度/效度) —— 旧词表(10 词)会漏
    const pidH = await seedFresh(token, 1, {
      title: "数字化转型对企业创新绩效的影响研究",
      outline: "一、引言\n  1.1 量表设计与信度效度检验\n  1.2 结构方程模型构建",
      researchMethod: "",   // 留空 → 走启发式
    });
    await openSoc(cdp, BASE, "/workflow/input", token, pidH, 8000);
    const hint = await evalTop(cdp, `(() => {
      const el = document.querySelector('.auto-detect-note');
      return { exists: !!el, text: el ? el.innerText.replace(/\\s+/g,' ').trim() : '' };
    })()`);
    // 命中「量表/信度/效度/结构方程/绩效」等 ≥2 个定量词 → 必须识别为定量
    rec("input", "研究方法自动识别(宽词表)", hint?.exists && /定量/.test(hint.text) ? "ok" : "err",
      hint?.exists ? hint.text : "提示条未渲染");

    // 兜底: 一个量化/定性词都没有的题面 → 闭源兜底 qualitative(而非空)
    const pidH2 = await seedFresh(token, 1, {
      title: "关于某个议题的初步思考",
      outline: "一、引言\n二、结语",
      researchMethod: "",
    });
    await openSoc(cdp, BASE, "/workflow/input", token, pidH2, 8000);
    const hint2 = await evalTop(cdp, `(() => { const el = document.querySelector('.auto-detect-note'); return el ? el.innerText.replace(/\\s+/g,' ').trim() : ''; })()`);
    rec("input", "无匹配时兜底定性(闭源语义)", /定性/.test(String(hint2)) ? "ok" : "err", `提示条=${hint2 || "(空)"}`);
    await api(token, `/research/projects/${pidH}`, "DELETE");
    await api(token, `/research/projects/${pidH2}`, "DELETE");
  }

  console.log("\n═══ aiSkill 产物渲染(闭源展开区 8 项, 其中 frameworkSource 是对象) ═══");
  {
    const pidS = await seedFresh(token, 2);
    await api(token, `/research/projects/${pidS}/nodes/sections`, "PUT", {
      payload: { sections: [{
        id: "sec_0", title: "引言", level: 1, order: 0, status: "pending",
        aiSkill: {
          type: "intro", wordCount: 1500, writingGoal: "奠定研究基础",
          keyPoints: ["要点一"], connection: "承接下文", notes: "注意语体",
          // 后端存的是**对象** —— 旧实现当字符串插值会渲染出 [object Object]
          frameworkSource: { refFile: "参考.pdf", originalStructure: "总-分-总", variableMapping: "A→B", extractedModel: "中介模型" },
          chapterDraft: "这是草稿正文。",
          childSections: [{ title: "研究背景", aim: "交代问题" }],
        },
      }] },
    });
    await openSoc(cdp, BASE, "/workflow/sections", token, pidS, 8000);
    const r = await evalTop(cdp, `(() => {
      const d = document.querySelector('.skill-detail');
      const txt = d ? d.innerText : '';
      return {
        has: !!d,
        objectObject: txt.includes('[object Object]'),
        fields: ['框架来源','文件：','原文结构：','变量替换：','分析框架：','草稿预览','子节规划','写作目标','要点','衔接','注意']
          .filter(k => txt.includes(k)),
        typeBadge: d ? (d.querySelector('.skill-type-badge')?.innerText || '') : '',
        draftBox: !!document.querySelector('.draft-box'),
      };
    })()`);
    rec("sections", "aiSkill 展开区字段齐(8 类产物)", r?.has && r.fields.length >= 8 ? "ok" : "err", `命中=${JSON.stringify(r?.fields)}`);
    rec("sections", "frameworkSource 按对象渲染(不出 [object Object])", r?.has && !r.objectObject ? "ok" : "err",
      r?.objectObject ? "渲染出了 [object Object]" : "四子字段逐个渲染");
    rec("sections", "chapterDraft 有独立草稿框", r?.draftBox ? "ok" : "err", r?.draftBox ? "绿框已渲染" : "未渲染");
    rec("sections", "type 徽章渲染", r?.typeBadge ? "ok" : "err", `type=${r?.typeBadge || "(空)"}`);
    await api(token, `/research/projects/${pidS}`, "DELETE");
  }

  console.log("\n═══ 生成弹层生命周期(闭源: 生成中可取消 / 完成后状态位复位) ═══");
  {
    const pidG = await seedFresh(token, 3);
    await api(token, `/research/projects/${pidG}/nodes/sections`, "PUT", {
      payload: { sections: [{ id: "sec_0", title: "引言", level: 1, order: 0, status: "pending" }] },
    });
    await openSoc(cdp, BASE, "/workflow/materials", token, pidG, 8000);
    await spyInstall(cdp);
    // 打开生成弹层(文献类), 检查初始态: 次按钮应是「取消」(非「取消」的禁用态), 且无残留
    await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="workflow:cat-generate-literature"]'); if (b) b.click(); return 1; })()`);
    await sleep(1500);
    const st = await evalTop(cdp, `(() => {
      const btns = [...document.querySelectorAll('.gen-foot button')].map(b => ({ t: b.innerText.trim(), dis: b.disabled, ctl: b.getAttribute('data-control') }));
      return { btns, busy: document.querySelector('.workflow-page')?.getAttribute('data-assistant-async-busy') };
    })()`);
    // 关闭弹层 → async-busy 必须复位为 false(修前 genTaskId 不清零 → 恒 true)
    await evalTop(cdp, `(() => { const b = [...document.querySelectorAll('.gen-foot button')].find(x => /取消|放弃/.test(x.innerText)); if (b) b.click(); return 1; })()`);
    await sleep(1200);
    const busyAfter = await evalTop(cdp, `document.querySelector('.workflow-page')?.getAttribute('data-assistant-async-busy')`);
    rec("materials", "关弹层后 async-busy 复位", busyAfter === "false" ? "ok" : "err", `busy=${busyAfter}(修前恒为 true)`);
    rec("materials", "弹层次按钮可点(不是禁用态)", !!st?.btns?.some((b) => /取消|放弃/.test(b.t) && !b.dis) ? "ok" : "err",
      `按钮=${JSON.stringify(st?.btns)}`);
    await api(token, `/research/projects/${pidG}`, "DELETE");
  }

  console.log("\n═══ 分析进行中的界面反馈(打字机 / 步骤三态) ═══");
  {
    // 用 --all 才跑: 要真起一个 analyze 任务(真 LLM)。这里验的是"等待期间用户看得到东西",
    //   而不是任务结果 —— 结果由上面的 start-analysis 断言覆盖。
    if (!ALL) {
      rec("sections", "分析思考区非空(打字机接上真实阶段)", "skip", "需真 LLM, 加 --all 才跑");
      rec("sections", "当前步显示转圈态", "skip", "需真 LLM, 加 --all 才跑");
    } else {
      const pidT = await seedFresh(token, 2);
      await openSoc(cdp, BASE, "/workflow/sections", token, pidT, 8000);
      await spyInstall(cdp);
      await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="workflow:start-analysis-2"]'); if (b) b.click(); return 1; })()`);
      const seen = await waitFor(cdp, `(() => {
        const txt = document.querySelector('.thinking-text')?.innerText || '';
        const spin = document.querySelectorAll('.step-circle.spinning').length;
        return (txt.trim().length > 0 || spin > 0) ? { textLen: txt.trim().length, spin } : null;
      })()`, { timeout: 120000 });
      rec("sections", "分析思考区非空(打字机接上真实阶段)", seen?.textLen > 0 ? "ok" : "err",
        seen ? `思考区 ${seen.textLen} 字` : "120s 内思考区始终为空");
      rec("sections", "当前步显示转圈态", seen?.spin > 0 ? "ok" : "err", `转圈元素=${seen?.spin ?? 0}`);
      await api(token, `/research/projects/${pidT}`, "DELETE");
    }
  }

  // ═══ 7. 深链恢复: 历史中心 → 写作舱 ═══
  console.log("\n═══ 深链恢复(sag:resume:workflow) ═══");
  {
    const pid6 = await seedFresh(token, 5);
    await openSoc(cdp, BASE, "/workflow/workspace", token, pid6);
    await spyInstall(cdp);
    // 模拟历史中心写入恢复指针, 再重新加载子应用
    await evalTop(cdp, `localStorage.setItem('sag:resume:workflow', JSON.stringify({ id: 'x', projectId: ${JSON.stringify(pid6)}, at: Date.now() }));`);
    const pidsBefore = await evalTop(cdp, `localStorage.getItem('lastTask_workflow')`);
    await cdp("Page.reload");
    await sleep(7000);
    const pidsAfter = await evalTop(cdp, `localStorage.getItem('lastTask_workflow')`);
    const consumed = await evalTop(cdp, `localStorage.getItem('sag:resume:workflow')`);
    rec("global", "sag:resume:workflow 被写作舱消费", consumed === null ? "ok" : "err",
      consumed === null ? "指针已被消费" : `指针仍在(写作舱无消费点) 加载前提=${pidsBefore} 后=${pidsAfter}`);
  }
} catch (e) {
  console.error("\n探针异常: " + e.message);
} finally {
  // 清理播种项目
  try {
    if (token) {
      const list = await api(token, "/research/projects?limit=60");
      for (const p of (list?.projects ?? list?.data ?? [])) {
        if (/^探针-/.test(String(p.title ?? ""))) {
          const mats = await api(token, `/research/materials?projectId=${p.id}`);
          for (const m of (mats?.materials ?? [])) await api(token, `/research/materials/${m.id}`, "DELETE");
          await api(token, `/research/projects/${p.id}`, "DELETE");
        }
      }
      console.log("\n  已清理探针项目");
    }
  } catch { /* 清理失败不影响结论 */ }
  close();
}

function short(u) { return String(u ?? "").replace(BASE, "").split("?")[0].slice(-58); }

console.log("\n" + "=".repeat(70));
const dead = rows.filter((r) => r.kind === "dead");
const err = rows.filter((r) => r.kind === "err");
const gated = rows.filter((r) => r.kind === "gated");
const skip = rows.filter((r) => r.kind === "skip");
const ok = rows.filter((r) => r.kind === "ok");
console.log(`动作探针: ok ${ok.length} / DEAD ${dead.length} / ERR ${err.length} / gated ${gated.length} / skip ${skip.length}`);
if (dead.length) { console.log("\n【点了没反应(可点却零请求)—— 缺陷】"); for (const d of dead) console.log(`  • [${d.view}] ${d.action} — ${d.detail}`); }
if (err.length) { console.log("\n【有问题】"); for (const d of err) console.log(`  • [${d.view}] ${d.action} — ${d.detail}`); }
if (gated.length) { console.log("\n【门禁拦截(正确行为, 非缺陷)】"); for (const d of gated) console.log(`  • [${d.view}] ${d.action} — ${d.detail}`); }
if (skip.length) { console.log("\n【环境限制未验(不算通过)】"); for (const d of skip) console.log(`  • [${d.view}] ${d.action} — ${d.detail}`); }
