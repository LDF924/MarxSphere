// scripts/verify-writing-cabin.mjs — 研途写作舱(/workflow/*)2026-09-15 批次修复的回归门禁
//
// 由来: 这一批修了 8 项(失败原因透传/正文 markdown 渲染/二级子节/素材按章过滤/
//   来源落库/降AIGC 强度档/阶段落库/版本指针真实化)。它们有两个共同特点, 正是门禁必须钉住的:
//   ① **类型检查抓不到** —— 模板标签写错、字段名拼错, tsc/vue-tsc 全绿, 只有真跑才炸
//      (本轮真踩到: FinalizeView 多一个 </div>, 编译期才报 "Invalid end tag");
//   ② **失败是静默的** —— 数据不落库、二级行不渲染、档位传不到后端, 界面上没有红字, 用户只会觉得"没反应"。
//
// 自带数据播种(建项目 → 写节点 → 写快照 → 收尾删除), 不依赖手工遗留的测试项目。
// 用法: node scripts/verify-writing-cabin.mjs   (需 4173 已起)
import { startCdp, loginToken, findSocFrame, evalInFrame, evalTop, clickInFrame, sleep } from "./lib/cdp-editor.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0, skipped = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };
/**
 * 已知受限项 —— 环境限制导致**无法在本门禁里验证**, 既不算通过(那是撒谎)也不算失败(那是污染结论)。
 * 用时必须写明: 受限原因 + 已排除项 + 独立验证证据。裸用 skip 掩盖问题是禁止的。
 */
const skipt = (n, ex = "") => { console.log(`  skip  ${n}${ex ? " — " + ex : ""}`); skipped++; };

const TITLE = `门禁-写作舱-${Date.now()}`;

async function api(token, path, method = "GET", body) {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.ok ? r.json().catch(() => ({})) : null;
}

/** 播种一个处于 Phase4、含二级子节、素材分挂两章的项目 */
async function seed(token) {
  const proj = await api(token, "/research/projects", "POST", { title: TITLE, status: "in-progress", phase: 4, phaseLabel: "章节写作" });
  const pid = (proj?.data ?? proj)?.id;
  if (!pid) return null;
  const sections = [
    { id: "sec_0", title: "引言", level: 1, order: 0, status: "done", content: "## 研究背景\n\n| 变量 | 含义 |\n|---|---|\n| gap | 城乡收入差距 |\n\n正文若干。" },
    { id: "sec_1", title: "研究背景", level: 2, parentId: "sec_0", order: 1, status: "pending" },
    // 合稿门禁要求**每个**一级章都有 >50 字正文, 否则会拦下来(这条数据不备齐④就会卡住)
    { id: "sec_3", title: "文献综述", level: 1, order: 2, status: "done", content: "文献梳理与评述。已有研究多从宏观层面讨论该议题, 对微观机制的刻画仍不充分, 本文尝试在这一方向上作出补充。" },
  ];
  await api(token, `/research/projects/${pid}/nodes/sections`, "PUT", { payload: { sections } });
  await api(token, `/research/projects/${pid}/workbench`, "PUT", {
    snapshot: {
      phase: 4, phaseLabel: "章节写作",
      input: { title: TITLE, outline: "", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] },
      sections, variables: [], hypotheses: [],
      // ⚠ 这里**不能**种 mergeGenerated: true。原注释写「④ 要验合稿模式 tab + 强度档,
      //   那组控件只在已合稿态出现」—— 没错, 但那与第 ④ 组的第一条断言(未合稿时显示空态卡)
      //   直接**互斥**, 且与参考产品语义也不符: 参考产品是 `!mergeGenerated && !mergeGenerating` 才渲染空态。
      //   2026-09-20 之前它一直是绿的, 只因为 mergeGenerated 是**断了的一条链**
      //   (前端置真不落库 → 读侧被列里的 false 覆盖) —— 种了等于没种。
      //   那条链修好之后, 这个自相矛盾的播种立刻显形。
      //   现在: 不种, 空态成立; ④ 里点「开始合并」跑通后自然进入已合稿态, 模式 tab / 强度档照样验得到。
      mergedTitle: TITLE, mergedAbstract: "摘要", mergedKeywords: "关键词",
      mergedFullText: "# 正文\n\n内容", mergedReferences: "[1] 张三. 测试[J]. 2021.",
    },
  });
  // 两条素材分挂不同章 —— A4 的"按当前章过滤"要有可比对的数据才验得出来
  await api(token, "/research/materials", "POST", { projectId: pid, kind: "theory", title: "素材-挂引言", contentMd: "理论A", sectionIds: ["sec_0"] });
  await api(token, "/research/materials", "POST", { projectId: pid, kind: "citation", title: "素材-挂综述", contentMd: "文献B", sectionIds: ["sec_3"] });
  return pid;
}

const { cdp, ev, close } = await startCdp({ preferredPort: 31023, label: "scripts/verify-writing-cabin.mjs" });
let token = "", pid = "";
try {
  token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败, 无法播种数据");
  pid = await seed(token);
  if (!pid) throw new Error("播种失败(建项目没返回 id)");

  await cdp("Page.navigate", { url: BASE });
  await sleep(2500);
  await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)});`);
  await ev(`localStorage.setItem('lastTask_workflow', ${JSON.stringify(pid)});`);

  // findSocFrame 返回 frameTree 里**第一个** /soc/ frame; 连续切路由后旧 frame 可能尚未
  //   从树里摘掉, 取到旧的就会一直读到上一页的 DOM(表现为"点了没反应")。
  //   这里在本脚本内固定取**最后一个**(最新创建的那个)。
  const socFrame = async () => {
    const { frameTree } = await cdp("Page.getFrameTree");
    const acc = [];
    const walk = (t) => {
      if (t.frame?.url?.includes("/soc/")) acc.push({ id: t.frame.id, url: t.frame.url });
      for (const c of t.childFrames ?? []) walk(c);
    };
    walk(frameTree);
    return acc.length ? acc[acc.length - 1].id : null;
  };
  const inFrame = (fid, expr) => evalInFrame(cdp, fid, expr);

  const goto = async (route, wait = 6000) => {
    await ev(`location.hash = '#paper-outline';`);
    await sleep(1500);
    let fid = await socFrame();
    if (!fid) return null;
    // 子应用是独立 hash 路由, 切 route 必须整帧重载(hash 变更不触发 vue-router 重挂载)。
    // ⚠ location.href 赋值会**重建 iframe**, 旧 frameId 随之失效 —— 重载后必须重取,
    //   否则后续 evalInFrame 落在已销毁的 frame 上, 读到的永远是旧 DOM(表现为"点了没反应")。
    await evalInFrame(cdp, fid, `location.href = location.origin + '/soc/index.html#${route}'; 'ok'`);
    await sleep(wait);
    fid = await socFrame();
    return fid;
  };

  /**
   * 把 soc 子应用作为**顶层页面**打开, 返回 null(此时没有子 frame, 用顶层 ev 求值即可)。
   *
   * 为什么需要它: 需要**真实鼠标点击**的场景必须走顶层。
   *   嵌在 React 壳的 iframe 里时, `Input.dispatchMouseEvent` 派发到父页坐标后,
   *   浏览器不保证把事件路由进子文档 —— 实测坐标正确(落点 elementFromPoint 命中的就是那个 IFRAME)、
   *   事件也确实到达了顶层, 但 iframe 内的 Vue 处理器**从不触发**(零 fetch 零 toast)。
   *   同一段代码在顶层打开 soc 页面时一次就通。
   *   只读断言仍走 goto(保留"iframe 里也能跑"这层覆盖), 点击类断言走这里。
   */
  const gotoDirect = async (route, wait = 8000) => {
    await cdp("Page.navigate", { url: `${BASE}/soc/index.html#${route}` });
    await sleep(wait);
    await ev(`localStorage.setItem('sag_token', ${JSON.stringify(token)});`);
    await ev(`localStorage.setItem('lastTask_workflow', ${JSON.stringify(pid)});`);
    await cdp("Page.reload");
    await sleep(wait);
    return null;   // 顶层求值, 不需要 frameId
  };
  /** 顶层求值(与 inFrame 对称; gotoDirect 之后用它) */
  const onPage = (expr) => evalTop(cdp, expr);

  console.log("═══ ① 章节树渲染二级子节(2026-09-15 前只渲染一级) ═══");
  {
    const fid = await goto("/workflow/sections");
    const r = fid ? await inFrame(fid, `(() => {
      const l1 = [...document.querySelectorAll('.level1-row')].map(e => (e.querySelector('strong')||{}).innerText || '');
      const l2 = [...document.querySelectorAll('.l2-row')].map(e => (e.innerText||'').replace(/\\s+/g,' ').trim());
      return { l1, l2, lists: document.querySelectorAll('.l2-list').length };
    })()`) : null;
    t("二级子节有渲染", !!r && r.l2.length === 1, r ? `l2=${JSON.stringify(r.l2)}` : "子应用 frame 没拿到");
    t("二级挂在正确的一级下", !!r && r.lists === 1, r ? `l2-list=${r.lists} 一级=${JSON.stringify(r.l1)}` : "—");
  }

  console.log("\n═══ ② 正文编辑/预览双 tab + 预览渲染 markdown ═══");
  {
    const fid = await goto("/workflow/workspace");
    const r = fid ? await inFrame(fid, `(async () => {
      const tabs = [...document.querySelectorAll('.md-tab')].map(e => e.innerText.trim());
      const onBefore = [...document.querySelectorAll('.md-tab')].find(e => e.className.includes('on'))?.innerText.trim();
      // 切到预览(参考产品默认落在「编辑」, 预览是第二个 tab)
      const pv = [...document.querySelectorAll('.md-tab')].find(e => /预览/.test(e.innerText));
      if (pv) pv.click();
      await new Promise(r => setTimeout(r, 700));
      const html = document.querySelector('.content-html');
      return {
        tabs, onBefore,
        hasHtml: !!html,
        legacyPre: !!document.querySelector('.content-pre'),
        tables: html ? html.querySelectorAll('table').length : 0,
        rawPipes: /\\|\\s*变量\\s*\\|/.test(document.body.innerText),
      };
    })()`) : null;
    t("有编辑/预览双 tab", !!r && r.tabs.length === 2, r ? JSON.stringify(r.tabs) : "—");
    t("默认落在「编辑」(参考产品如此)", r?.onBefore === "编辑", r ? `激活=${r.onBefore}` : "—");
    t("切到预览后出现渲染容器(.content-html)", !!r?.hasHtml);
    t("旧的 <pre> 直出已移除", !!r && r.legacyPre === false);
    t("markdown 表格渲染成真表格", !!r && r.tables >= 1 && !r.rawPipes, r ? `tables=${r.tables} 裸管道符=${r.rawPipes}` : "—");
  }

  console.log("\n═══ ③ 右栏素材按当前章节过滤 ═══");
  {
    const fid = await socFrame();
    const readMats = `[...document.querySelectorAll('.mat-mini strong')].map(e => e.innerText)`;
    const before = fid ? await inFrame(fid, readMats) : null;
    // 切到「文献综述」那一章
    const clicked = fid ? await inFrame(fid, `(() => {
      const row = [...document.querySelectorAll('.nav-row')].find(r => /文献综述/.test(r.innerText));
      const el = row && (row.querySelector('.nav-l1') || row);
      if (!el) return 'no-nav';
      el.click(); return 'clicked';
    })()`) : null;
    await sleep(1500);
    const after = fid ? await inFrame(fid, readMats) : null;
    const ok = Array.isArray(before) && Array.isArray(after) && JSON.stringify(before) !== JSON.stringify(after)
      && before.every((x) => /引言/.test(x)) && after.every((x) => /综述/.test(x));
    t("切章后素材列表随之切换", ok, `${JSON.stringify(before)} → ${JSON.stringify(after)} (点击=${clicked})`);
  }

  console.log("\n═══ ④ 合稿空态 → UI 点合稿 → 降 AIGC 强度档 ═══");
  {
    // ⚠ 本组走**顶层页面**(gotoDirect), 不走 React 壳的 iframe。
    //   实测结论: `Input.dispatchMouseEvent` 跨 iframe 派发不可靠 —— 坐标正确
    //   (落点 elementFromPoint 命中的就是那个 IFRAME)、事件也到了顶层, 但 iframe 内的 Vue
    //   处理器**从不触发**(零 fetch 零 toast); 同一段代码在顶层打开 soc 页面时一次就通。
    //   排查中已逐一排除: iframe 坐标偏移(已修) / frame 取错(全页只有 1 个 iframe) /
    //   指针错位(已加断言) / 等待不足 / DOM 重复 / store 为空。
    //   因此"需要真实点击"的断言一律用顶层; 只读断言仍走 goto 保留 iframe 覆盖。
    await gotoDirect("/workflow/finalize");
    let empty = null;
    for (let i = 0; i < 25; i++) {
      empty = await onPage(`(() => {
        const el = document.querySelector('.rounds-card');
        return { has: !!el, text: el ? el.innerText.replace(/\s+/g,' ').trim() : '',
                 modes: document.querySelectorAll('.mm-tab').length,
                 tiers: document.querySelectorAll('.rounds-card .tier-btn').length };
      })()`);
      if (empty?.has || empty?.modes) break;
      await sleep(1000);
    }
    /**
     * ⚠ V425: 未合稿不再有**独立的空态卡** —— 它整块与"① 合并轮"重复(同样的模式 tab、
     *   同样的「开始合并」、同样的五步预览), 两处同时渲染的结果是页面上出现**两组 tab**(实测 4 个)。
     *   现在合并轮常驻, 空态卡已删除; 下面三条断言的对象随之从 `.finalize-empty` 换成 `.rounds-card`。
     *   **不是放宽**: 要验的性质没变(未合稿时模式可选、强度档默认不出现), 换的是承载它的元素。
     */
    t("未合稿时合并轮已渲染(不再是只有空态)", !!empty?.has && /合并正文/.test(empty.text), empty ? empty.text.slice(0, 46) : "—");
    t("合稿前就能选模式(且只有一组 tab)", empty?.modes === 2, `模式 tab=${empty?.modes}(期望 2)`);
    t("默认不出现强度档(仅降AIGC 模式才出)", empty?.tiers === 0, `档位按钮=${empty?.tiers}`);

    // 指针必须是我播的项目: loadProject() 在 localStorage 为空时会**兜底挑一个 in-progress
    //   的项目并写回 localStorage** —— 门禁首次开页时那会覆盖我播的 pid, 之后 doMerge 拿到
    //   的项目没有章节 → 走 `!withContent.length` 分支 toast 后 return(零 fetch 零反馈)。
    const ptr = await onPage(`localStorage.getItem('lastTask_workflow')`);
    t("子应用指针是我播种的项目(不是 loadProject 兜底选的)", ptr === pid,
      `指针=${ptr}${ptr === pid ? "" : ` 期望=${pid}`}`);

    // 快照里的 sections 还在不在? ①②③ 各视图挂载时会调 saveProject() 写快照,
    //   若某次用**空状态**写回, finalize 读到的章节就是空的 → doMerge 走 !withContent 分支拦截。
    const wb = await api(token, `/research/projects/${pid}/workbench`);
    const wbSecs = (wb?.snapshot?.sections ?? []).filter((x) => x.level === 1);
    t("快照里的一级章节没被前序步骤覆盖空", wbSecs.length === 2,
      `一级章节=${wbSecs.length} 正文字数=${JSON.stringify(wbSecs.map((x) => String(x.content || "").length))}`);

    /**
     * ⚠ 必须**点名**「开始合并」那个按钮, 不能按位置取。
     *   历史: 空态里加模式 tab 之后, `.finalize-empty button` 命中的是「直接合稿」,
     *   点了只切模式、不发起合稿(实测踩到)。
     * V425: 空态卡整块已删除(与常驻的 ① 合并轮重复), 合并按钮现在只有一个 ——
     *   用 `workflow:phase5-merge` 这个 data-control 点名, 比按类名更稳(它跟着按钮走)。
     */
    const clicked = await clickInFrame(cdp, null, '[data-control="workflow:phase5-merge"]');  // null frameId = 顶层
    let modes = [], why = "";
    for (let i = 0; i < 120 && clicked; i++) {
      await sleep(1500);
      // ⚠ 要等的是**轮次卡里的**模式 tab, 不是空态里那两个 —— 空态现在也有 .mm-tab,
      //   直接查全局会立刻 break(还没开始合稿就"通过"), 后面的降档交互就落在空态上了。
      const st = await onPage(`(() => ({
        modes: [...document.querySelectorAll('.round-row .mm-tab')].map(e => e.innerText.trim()),
        msg: [...document.querySelectorAll('.merge-msg, .finalize-empty')].map(e => e.innerText).join(' ').slice(0, 60),
        // toast 在 position:fixed; top:64px 容器里, 约 3.2s 消失。匹配不能写死 "top:64px"
        //   —— Vue 的 :style 渲染出来带空格("top: 64px"), 写死会恒空。
        toast: [...document.querySelectorAll('div')]
          .filter(d => { const s = d.getAttribute('style') || ''; return s.indexOf('position') >= 0 && s.indexOf('fixed') >= 0 && s.indexOf('64px') >= 0; })
          .map(d => (d.innerText || '').split(/\s+/).join(' ').trim()).join(' | ').slice(0, 120),
      }))()`);
      modes = Array.isArray(st?.modes) ? st.modes : [];
      if (modes.length) break;
      why = String(st?.toast || st?.msg || "").slice(0, 120);
    }
    t("点「开始合并」后合稿跑通, 轮次卡模式 tab 出现", modes.length === 2,
      `点击=${clicked} 实测=${JSON.stringify(modes)}${why ? ` 页面提示=${why}` : ""}`);

    // 交互序列放同一次 eval(跨 eval 会新建 isolated world, 读不到上一个 world 的 DOM 补丁)
    const ui = await onPage(`(async () => {
      const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const beforeTiers = document.querySelectorAll('.tier-btn').length;
      const aigc = [...document.querySelectorAll('.mm-tab')].find(e => /降AIGC/.test(e.innerText));
      if (!aigc) return { beforeTiers, err: 'no-aigc-tab' };
      aigc.click();
      await raf(); await new Promise(r => setTimeout(r, 600)); await raf();
      const tiers = [...document.querySelectorAll('.tier-btn')].map(e => e.innerText.trim());
      const defaultOn = [...document.querySelectorAll('.tier-btn')].find(e => e.className.includes('on'))?.innerText.trim() || '';
      const hint1 = document.querySelector('.tier-hint')?.innerText || '';
      const warn = document.querySelector('.tier-warn')?.innerText || '';
      const heavy = [...document.querySelectorAll('.tier-btn')].find(e => /重度/.test(e.innerText));
      if (heavy) heavy.click();
      await raf(); await new Promise(r => setTimeout(r, 400)); await raf();
      return { beforeTiers, tiers, defaultOn, hint1, warn,
        onAfter: [...document.querySelectorAll('.tier-btn')].find(e => e.className.includes('on'))?.innerText.trim() || '',
        hint2: document.querySelector('.tier-hint')?.innerText || '' };
    })()`);

    const rs = ui ?? {};
    t("降AIGC 模式出现三档", Array.isArray(rs.tiers) && rs.tiers.length === 3, JSON.stringify(rs.tiers ?? null));
    t("默认落在中度", /中度/.test(rs.defaultOn ?? ""), rs.defaultOn ?? "—");
    t("换档时该档说明跟着变", !!(rs.hint1 && rs.hint2 && rs.hint1 !== rs.hint2), `${rs.hint1 ?? ""} → ${rs.hint2 ?? ""}`);
    t("换档后激活态跟着走", /重度/.test(rs.onAfter ?? ""), rs.onAfter ?? "—");
    t("有降重风险提示", /降重可能会影响整体论文质量/.test(rs.warn ?? ""), rs.warn ?? "—");
  }


  console.log("\n═══ ⑤ 对齐批次的结构断言(2026-09-15 B1-B4) ═══");
  {
    // 文献与资料: 「补充素材来源」整卡 + 手风琴头行内按钮 + 页头三行状态
    const fid = await goto("/workflow/materials");
    const r = fid ? await inFrame(fid, `(() => {
      const tiles = [...document.querySelectorAll('.sc-tile .sc-tile-text')].map(e => e.innerText.trim());
      const heads = [...document.querySelectorAll('.cat-head')];
      const dataCat = heads.find(h => /数据分析素材/.test(h.innerText));
      return {
        hasSourceCard: !!document.querySelector('.source-card'),
        tileCount: tiles.length,
        tiles,
        groups: [...document.querySelectorAll('.sc-group')].map(e => e.innerText.trim()),
        // 行内按钮必须在**折叠态**也可见 —— 否则又退回"操作藏在展开体里"
        inlineInCollapsed: heads.filter(h => {
          const body = h.parentElement?.querySelector('.cat-body');
          return !body && h.querySelector('.cat-inline-btn');
        }).length,
        // 数据分析素材头行的四个入口(上传图片/上传数据/前往数据分析/前往科研绘图)
        dataCatBtns: dataCat ? [...dataCat.querySelectorAll('.cat-inline-btn')].map(e => e.innerText.trim()) : [],
        statsText: document.querySelector('.mat-stats')?.innerText.replace(/\\s+/g,' ').trim() || '',
        bottomBtns: [...document.querySelectorAll('.wf-actions button')].map(e => e.innerText.trim()),
        // 异步埋点必须是动态值(此前是写死的 "0")
        matCount: document.querySelector('.workflow-page')?.getAttribute('data-assistant-material-count'),
        hasBusyAttr: document.querySelector('.workflow-page')?.hasAttribute('data-assistant-async-busy'),
      };
    })()`) : null;
    t("有「补充素材来源」整卡", !!r?.hasSourceCard);
    t("手动添加四格 + 从其他模块导入两格", !!r && r.tileCount === 6, r ? `tiles=${JSON.stringify(r.tiles)}` : "—");
    /**
     * ⚠ 2026-09-19 修: 原来是 `r.groups.length === 2` —— **写死了分组数量**。
     *   素材页后来按需加了「文献库身份」「文献检索（中文三大库）」两组, 这条就假失败了,
     *   而页面本身没有任何问题(31 通过 / 1 失败)。
     *   改判**结构**: 原本必须有的两组要在, 且不允许空标题。
     *   —— 断言"数量等于 N"会把正常的新增判成回归; 断言"该有的在"才不会。
     */
    const needGroups = ["手动添加", "从其他模块导入"];
    const groupsOk = !!r && needGroups.every((g) => r.groups.includes(g)) && r.groups.every((g) => g.length > 0);
    t("必备分组标题都在(不锁数量)", groupsOk, r ? `实际=[${r.groups.join(", ")}]` : "—");
    t("折叠态也能看到行内操作按钮", !!r && r.inlineInCollapsed > 0, r ? `${r.inlineInCollapsed} 个分类` : "—");
    t("数据分析素材有上传图片入口", !!r && r.dataCatBtns.some((x) => /上传图片/.test(x)), r ? JSON.stringify(r.dataCatBtns) : "—");
    t("页头三行状态区", !!r && /按流程完成素材整理后即可进入创作/.test(r.statsText), r ? r.statsText : "—");
    t("底部收成两个按钮", !!r && r.bottomBtns.length === 2, r ? JSON.stringify(r.bottomBtns) : "—");
    t("埋点是动态值(非写死)", !!r?.hasBusyAttr && r.matCount !== null && r.matCount !== undefined, `material-count=${r?.matCount} busy 属性=${r?.hasBusyAttr}`);
  }

  console.log("\n═══ ⑥ 核对批次新增断言(C1-C7) ═══");
  {
    // 章节树: 一级/二级编号都应是**有底色的块**(参考产品红底浅/灰底), 而非纯文字
    const fid = await goto("/workflow/sections");
    const sec = fid ? await inFrame(fid, `(() => {
      const l1 = document.querySelector('.l1-num'), l2 = document.querySelector('.l2-num');
      const bg = (el) => el ? getComputedStyle(el).backgroundColor : null;
      return {
        statsText: document.querySelector('.wf-stats')?.innerText.replace(/\\s+/g,' ').trim() || '',
        l1bg: bg(l1), l2bg: bg(l2),
        l2Count: document.querySelectorAll('.l2-num').length,
      };
    })()`) : null;
    t("页头统计含「共 N 章」", !!sec && /共\s*\d+\s*章/.test(sec.statsText), sec ? sec.statsText : "—");
    t("二级编号是有底色的块(不是纯文字)", !!sec && sec.l2Count > 0 && sec.l2bg !== null && !/rgba\\(0, 0, 0, 0\\)/.test(sec.l2bg), sec ? `l2bg=${sec.l2bg}` : "—");
    t("一级编号有色块", !!sec && sec.l1bg !== null && !/rgba\\(0, 0, 0, 0\\)/.test(sec.l1bg), sec ? `l1bg=${sec.l1bg}` : "—");

    // 进度条 metric: 参考产品条件是 `(done||active||viewing) && metrics` —— 渲染与否看**有没有数据**,
    //   不是看状态。旧断言写死"active 必须有 metric"是错的: 本会话项目在 phase4(章节写作),
    //   active 那个节点是"章节写作", 它有值; 但换个 phase, active 节点(如文献与资料)素材为 0 时
    //   metric 本就该为空 —— 那是正确行为, 不是缺陷。所以验"有数据的节点渲染了 metric"。
    const p = fid ? await inFrame(fid, `(() => {
      // 框架设计节点一旦有章节就必须出「N 章节」(它是 done 态, 与 active 同属"该渲染"的集合)
      const nodes = [...document.querySelectorAll('.ppb-node')];
      const secNode = nodes.find(n => /框架设计/.test(n.innerText));
      return {
        metrics: [...document.querySelectorAll('.ppb-metric')].map(e => e.innerText.trim()),
        secHasMetric: !!(secNode && secNode.querySelector('.ppb-metric')),
        secMetricText: secNode?.querySelector('.ppb-metric')?.innerText.trim() ?? null,
        nodeStates: nodes.map(n => ({ cls: [n.className].flat().join(' '), hasMetric: !!n.querySelector('.ppb-metric'), text: n.innerText.replace(/\s+/g,' ').trim().slice(0, 14) })),
      };
    })()`) : null;
    // 有 2 个一级章节 → 框架设计节点必须显示「2 章节」; 且 metric 不能只出现在 done 上
    t("有数据的节点渲染 metric(非只 done 态)",
      !!p?.secHasMetric && /2 章节/.test(p?.secMetricText ?? ""),
      p ? `框架设计=${p.secMetricText} 全部=[${p.metrics.join(" | ")}]` : "—");
  }

  console.log("\n═══ ⑦ 无 JS 错误 ═══");
  {
    const errs = await ev(`JSON.stringify(window.__verifyErrs || [])`);
    t("外壳无未捕获错误", errs === "[]", String(errs).slice(0, 160));
  }
} finally {
  // 收尾: 删掉播种的项目与素材, 别在库里留垃圾
  try {
    if (token && pid) {
      const mats = await api(token, `/research/materials?projectId=${pid}`);
      for (const m of (mats?.materials ?? [])) await api(token, `/research/materials/${m.id}`, "DELETE");
      await api(token, `/research/projects/${pid}`, "DELETE");
      console.log(`\n  已清理播种项目 ${pid}`);
    }
  } catch { /* 清理失败不影响结论 */ }
  close();
}

console.log("\n" + "=".repeat(52));
console.log(`通过 ${pass} / 失败 ${fail}${skipped ? ` / 跳过 ${skipped}` : ""}`);
if (skipped) console.log(`  (跳过项是**环境限制**导致无法验证的, 见上文每条的原因; 它们不计入失败, 但也**不算通过**)`);
process.exit(fail ? 1 : 0);
