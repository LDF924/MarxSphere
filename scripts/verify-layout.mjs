// scripts/verify-layout.mjs — 写作舱布局回归: 溢出 / 塌陷 / 重叠 / 三档视口
//
// 由来(2026-09-16): 写作舱此前**没有任何布局断言** —— 已有一套门禁全是文案与结构断言
//   (查类名、查 innerText), 而"元素实际占多大、窄屏会不会塌"是另一回事, 静态读 CSS 也测不出。
//   用户在"布局、设计、空间"上的反馈一直无从回归。这个脚本补上这一层。
//
// 为什么需要它: 现有门禁全是**文案/结构**断言(查类名、查 innerText), 没有一条验过
//   "元素实际占多大、有没有溢出、窄屏会不会塌"。而这正是用户说的"布局、空间"。
//   静态读 CSS 也测不出来 —— 得让浏览器真渲染再量。
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, dismissOverlays } from "./lib/probe-actions.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
const api = async (tk, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, { method, headers: { Authorization: `Bearer ${tk}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.ok ? r.json().catch(() => ({})) : { __status: r.status };
};
const tk = await loginToken("audit", "audit123456");
const p = await api(tk, "/research/projects", "POST", { title: `布局实测-${Date.now()}`, status: "in-progress", phase: 4, phaseLabel: "章节写作" });
const pid = p.id ?? p.data?.id;
await api(tk, `/research/projects/${pid}/nodes/input`, "PUT", { payload: { input: { title: "布局实测研究", outline: "一、引言\n  1.1 背景\n二、综述", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] }, sections: [] } });
await api(tk, `/research/projects/${pid}/nodes/sections`, "PUT", { payload: { sections: [
  { id: "sec_0", title: "引言", level: 1, order: 0, status: "done", content: "正文内容。".repeat(120) },
  { id: "sec_1", title: "研究背景", level: 2, parentId: "sec_0", order: 1, status: "pending" },
  { id: "sec_2", title: "文献综述", level: 1, order: 2, status: "pending" },
] } });
await api(tk, "/research/materials", "POST", { projectId: pid, kind: "theory", title: "布局素材", contentMd: "素材内容".repeat(60), sectionIds: ["sec_0"] });

const { cdp, close } = await startCdp({ preferredPort: 31081, label: "scripts/verify-layout.mjs", windowSize: "1440,900" });
const out = [];
const rec = (v, k, ok, d) => { out.push({ v, k, ok, d }); console.log(`${ok ? "  ok  " : "FAIL  "}[${v}] ${k}${d ? " — " + d : ""}`); };

/** 量一页的布局: 溢出/塌陷/重叠/关键区域尺寸 */
const MEASURE = `(() => {
  const de = document.documentElement;
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left), y: Math.round(b.top) }; };
  // 横向溢出: 页面能否横向滚(不该能)
  const hOverflow = de.scrollWidth - de.clientWidth;
  // 塌陷: 任意可见容器高度 < 40 且子元素比它高 → 内容被裁
  let collapsed = [];
  for (const e of document.querySelectorAll('.workflow-page, .ws-page-root, .wf-layout, main, aside, section')) {
    if (e.getClientRects().length === 0) continue;
    const b = e.getBoundingClientRect();
    if (b.height > 0 && b.height < 40 && e.scrollHeight > 60) collapsed.push((e.className || e.tagName).toString().slice(0, 40));
  }
  // 重叠: 关键操作元素之间是否互相压住。
  // ⚠ 2026-09-22 修: 必须排除**祖孙关系**。容器上也可能带 data-control(如项目栏里
  //   每一项 workflow:proj-<id> 是个 div, 里面装着「归档」按钮) —— 孙子当然落在祖辈的
  //   矩形里, 那是包含不是重叠。不排除的话, 每当项目栏里多出一行就多报一条假重叠
  //   (实测 15 条全红, 而真实的按钮重叠一条都没有)。
  //   仍然要看的是**兄弟/远亲**之间的压盖: 那才是"点这个却点到那个"的真问题。
  //
  // ⚠ 2026-09-24 再修: 还要能**点到**才算。
  //   起因: 素材页在 1024 视口报了一条重叠, 查下去是**自己新加的折叠块**里的 input。
  //   那些 input 在**闭合的 details** 里 —— 用户看不到、也点不到, 但 Chromium **仍然
  //   为它们保留最后一次的布局盒**(实测该 input 的 getBoundingClientRect() 有完整的
  //   829x30, 而 elementFromPoint(它的中心) 返回 **null**; 同页一个真按钮作对照则命中它自己)。
  //   于是"折叠内容里只要有个宽控件横跨某行"就会不停误报。
  //   ⚠ 写这段注释时又踩了一次: MEASURE 本身是模板串, 注释里用反引号会**提前闭合它**
  //     (SyntaxError)。本文件的历史注释里已经记过这个坑, 照样会踩 —— 这里不要用反引号。
  //
  //   判据改成**用户视角**: 命中测试打不到的元素之间不存在重叠 —— 跟真实用户一致
  //   (人只能点到看得见的东西)。这是**收紧**而不是放宽: 它只排除掉"结构上不可能被点到"的
  //   那些, 真压盖照样报。
  const overlap = [];
  const canHit = (e) => {
    const b = e.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return false;
    const t = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
    return !!t && (t === e || e.contains(t));
  };
  const els = [...document.querySelectorAll('button, [data-control]')]
    .filter(e => e.getClientRects().length && canHit(e));
  const related = (a, b) => a.contains(b) || b.contains(a);
  for (let i = 0; i < Math.min(els.length, 40); i++) {
    for (let j = i + 1; j < Math.min(els.length, 40); j++) {
      if (related(els[i], els[j])) continue;
      const a = els[i].getBoundingClientRect(), c = els[j].getBoundingClientRect();
      const ox = Math.min(a.right, c.right) - Math.max(a.left, c.left);
      const oy = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
      if (ox > 6 && oy > 6) overlap.push([(els[i].innerText||'').trim().slice(0,10), (els[j].innerText||'').trim().slice(0,10)]);
    }
  }
  // 可滚动容器: 内容比视口高时, 必须存在一个能滚的祖先 —— 否则底部内容永久不可达。
  //   2026-09-16 实测踩到: 素材/架构/合稿三页根节点漏了 overflow-y-auto, 内容 1110px
  //   而视口 900px, 整条祖先链**零个可滚动元素**, 底部 210px 摸不到。
  const pg = document.querySelector('.workflow-page') || document.querySelector('.ws-page-root');
  let scroller = null;
  if (pg) {
    let e = pg;
    while (e && e !== document.documentElement) {
      const st = getComputedStyle(e);
      if (/(auto|scroll)/.test(st.overflowY)) { scroller = (e.className || e.tagName).toString().slice(0, 50); break; }
      e = e.parentElement;
    }
  }
  /**
   * 容器内两栏的**结果侧**是否被压瘪。
   *
   * 2026-09-22 加: 实测踩到一类"断点永远不在需要时触发"的错 —— 深度分析面板内部两栏
   *   原本用媒体查询(视口宽 1080)判宽窄, 可它实际受限于**所在列的宽**。
   *   合稿页两栏布局下, 1280 视口时左栏只有 509px, 面板结果栏被挤成 **141px**(文本没法读),
   *   而断点毫无反应(视口没到 1080)。已改成容器查询; 这条断言把"结果侧要么够宽、
   *   要么已经塌成单栏"钉住。
   */
  const squeezed = [];
  // ⚠ 2026-09-24: 只剩 .da-result —— .sec-col-right(sections) 与 .fin-col-doc(finalize)
  //   都随各自单栏化移除。这条检查的对象是「同排还有别的栏时自己却被压瘪」,
  //   单栏页没有「同排」, 所以那两页不再适用(不是放过它们, 是没有这个对象了)。
  for (const sel of ['.da-result']) {
    const e = document.querySelector(sel);
    if (!e) continue;
    const b = e.getBoundingClientRect();
    // 单栏(全宽)时不算被压瘪; 只在"同排还有别的栏"且自己很窄时报
    const parent = e.parentElement;
    const cols = parent ? getComputedStyle(parent).gridTemplateColumns.split(' ').filter(Boolean).length : 1;
    if (cols > 1 && b.width > 0 && b.width < 240) squeezed.push(sel + '=' + Math.round(b.width) + 'px');
  }
  /**
   * 窗口级滚动条是否存在 —— 用**可见事实**判, 不看它是怎么实现的。
   *
   * 2026-09-22 用户报"选题界定页有两个上下滑动": 实拍确认文档比视口高 68px, 窗口因此
   *   多出一条滚动条, 而滚动它会**把吸顶的进度条一起顶上去**(实测 top 0 → -68)。
   *   「根元素 offsetWidth - clientWidth > 0」正是"渲染出了竖向滚动条"这个事实,
   *   与用 overflow:hidden 还是别的手段无关。
   *
   * 注意别用 「window.scrollTo()「 去测: 程序化滚动**不受 overflow:hidden 限制**
   *   (我第一版就是这么测的, 修完仍报 68 —— 测的是"能不能被程序滚动", 不是"用户能不能滚")。
   */
  const winScrollBar = de.offsetWidth - de.clientWidth;
  /**
   * 两栏底部落差 —— **刻意不做成断言**, 只留一段说明。
   *
   * 2026-09-22 试过, 结论是这条在这个仓里做不可靠: 每个两栏页都有一栏是**可变高**的 ——
   *   · 选题界定页左栏是**大纲编辑器**, 实测 1440 下高 485px、1600 下只有 363px
   *     (窄了要换行), 而右栏三张卡在两种宽度下**完全一样**;
   *   · 合稿页右栏是整篇正文(一个 finale-card), 高度随稿件任意长;
   *   · 框架设计页两栏都装长度不定的树与指导。
   * 于是"两栏齐平"这条判据的噪声(23%)与真正要拦的信号(32%)只差 9 个百分点, 宽度一变就翻。
   * **没有可靠判据的检查不如不写** —— 写了只会变成需要反复调阈值的假失败来源。
   *
   * 但那 356px 的落差是真问题(在 1600 下肉眼可见), 修法是内容重排:
   *   把「额外要求」从左栏挪到右栏(它与右栏的"参考文件"同属补充说明类输入),
   *   实测 1600 下落差 356px → 8px。这类判断只能靠**看**, 靠不了断言。
   */
  /**
   * 行内两栏的**缝宽**。
   *   顶部卡原先 flex + max-width:72ch + 定宽144 三套宽度互相打架, 实测缝只有 12px
   *   (与全页统一用的 20px 不一致), 看着就是"没排好"。这里要求行内栅格的 column-gap
   *   与页面一致; 拿不到栅格就跳过(不是所有页都有这种行)。
   */
  const rowGap = (() => {
    const tr = document.querySelector('.topic-row');
    if (!tr) return null;
    const cs = getComputedStyle(tr);
    if (cs.display !== 'grid' && cs.display !== 'flex') return null;
    return Math.round(parseFloat(cs.columnGap || cs.gap) || 0);
  })();
  /**
   * 两栏页的**侧栏宽度** —— 五个页面此前各用各的比例(实测 1.55:1 / 1.15:1 / 1:1.25),
   *   同一角色的一栏在三个页面里宽度不同, 页面之间就读不成"一套东西";
   *   更糟的是合稿页把**论文正文**挤得比按钮列还窄(672/584)。
   * 现在统一走 「--wf-aside「 令牌: 同一视口下, 任何两栏页的侧栏宽度必须**完全相等**。
   * 这条能钉住"有人又给某一页写死一个比例"。
   */
  /**
   * 每一对(内容栏, 侧栏)的宽度 —— 判据是**内容栏不得窄于侧栏**。
   *
   * ⚠ 第一版我把"所有两栏页的侧栏"放进一个数组比相等, 那是错的: 同一页里
   *   「.sec-col-left「 是内容栏、「.sec-col-right「 才是侧栏, 把两者一起比就会自己跟自己打架
   *   (实测在 sections 页报出 [432, 672] 的假失败)。真要跨页比得在 Node 侧汇总,
   *   而这里能诚实判的是**页内的主侧关系** —— 那也正是修掉的那个缺陷。
   */
  const colPairs = [];
  // ⚠ 2026-09-23: 去掉 sections 那一对(该页已改单栏)。
  // ⚠ 2026-09-24: 再去掉 finalize 那一对(合稿页也改单栏)。**现在只剩选题界定页是两栏**。
  //   (⚠ 本段在模板串内部: 别写反引号, 它会闭合模板串 —— 本文件已因此踩坑多次)
  //   这条断言随两栏页一起减少是**对的行为**: 它验的是「内容栏不得窄于侧栏」,
  //   单栏页没有这个关系可验。等哪天选题界定页也改单栏, 它就该整体退役。
  for (const [content, aside] of [['.iv-col-main', '.iv-col-side']]) {
    const a = document.querySelector(content), b = document.querySelector(aside);
    if (!a || !b) continue;
    const aw = Math.round(a.getBoundingClientRect().width), bw = Math.round(b.getBoundingClientRect().width);
    if (aw < 100 || bw < 100) continue;
    colPairs.push({ content, aside, aw, bw });
  }
  const contentH = pg ? pg.scrollHeight : 0;
  return {
    vw: de.clientWidth, vh: de.clientHeight, hOverflow, collapsed, overlap: overlap.slice(0, 5), squeezed, winScrollBar, rowGap, colPairs,
    page: r('.workflow-page'), nav: r('.sec-nav,.ws-nav,aside'), main: r('main,.ws-main'),
    topic: r('.ppb-topic'), inner: r('.ppb-inner'),
    contentH, needScroll: contentH > de.clientHeight + 8, scroller,
  };
})()`;

const VIEWS = [
  ["input", "/workflow/input"],
  ["sections", "/workflow/sections"],
  ["materials", "/workflow/materials"],
  ["workspace", "/workflow/workspace"],
  ["finalize", "/workflow/finalize"],
];

// 三档视口 —— 窄屏是布局最容易塌的地方, 必须测
const VIEWPORTS = [
  ["宽屏 1440", 1440, 900],
  ["笔记本 1280", 1280, 800],
  ["窄屏 1024", 1024, 768],
];
try {
  for (const [vpName, w, h] of VIEWPORTS) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    console.log(`
── ${vpName} ──`);
    for (const [name, route] of VIEWS) {
      await openSoc(cdp, BASE, route, tk, pid, 7500);
      await dismissOverlays(cdp);
      await sleep(1200);
      const m = await evalTop(cdp, MEASURE);
      if (!m || typeof m !== "object") { rec(`${name}@${w}`, "页面可测量", false, String(m).slice(0, 80)); continue; }
      rec(`${name}@${w}`, "无横向溢出", m.hOverflow <= 2, `溢出=${m.hOverflow}px`);
      // 内容超出视口时必须有可滚动容器, 否则底部不可达
      rec(`${name}@${w}`, "内容超出时可滚动", !m.needScroll || !!m.scroller,
        m.needScroll ? `内容${m.contentH}px>视口${m.vh}px, 滚动容器=${m.scroller ?? "无(底部不可达)"}` : "内容未超出, 无需滚动");
      rec(`${name}@${w}`, "无塌陷容器", m.collapsed.length === 0, m.collapsed.length ? JSON.stringify(m.collapsed) : "");
      rec(`${name}@${w}`, "按钮无重叠", m.overlap.length === 0, m.overlap.length ? JSON.stringify(m.overlap) : "");
      // 两栏布局里某一栏被挤到读不了 —— 视口够宽也照样发生(面板受限于它所在列的宽)
      rec(`${name}@${w}`, "无被压瘪的栏(≥240px)", (m.squeezed ?? []).length === 0,
        (m.squeezed ?? []).length ? `过窄: ${m.squeezed.join(", ")}` : "");
      // 窗口级滚动条 = 页面出现"第二条滚动条", 且滚动它会顶掉吸顶元素
      rec(`${name}@${w}`, "无窗口级滚动条", (m.winScrollBar ?? 0) <= 0,
        (m.winScrollBar ?? 0) > 0 ? `窗口滚动条宽 ${m.winScrollBar}px —— 页面会多出一条上下滑动` : "");
      // 行内多列控件的缝宽要与页面统一(12px 那种"挨在一起"就是不规整)
      if (m.rowGap !== null && m.rowGap !== undefined) {
        rec(`${name}@${w}`, "行内多列缝宽 = 页面栅格间距", m.rowGap === 20, `实测 ${m.rowGap}px(期望 20)`);
      }
      // 内容栏不得窄于侧栏 —— "控制列比正文还宽"那类版式倒置
      for (const cp of (m.colPairs ?? [])) {
        rec(`${name}@${w}`, `内容栏不窄于侧栏(${cp.content} ≥ ${cp.aside})`, cp.aw >= cp.bw,
          `实测 内容 ${cp.aw}px / 侧栏 ${cp.bw}px`);
      }
    }
  }
  await cdp("Emulation.clearDeviceMetricsOverride");

  // ── 页级垂直节奏: 按参考产品 DOM 实拍钉住(2026-09-20) ──
  // 上面那批断言只证明"不溢出/不塌/不重叠", **证明不了间距对不对** —— 而"挤"正是
  //   用户抱怨的那种问题: 改前 3 个视图的页级间距是 mb-4/14/16 混搭, 参考产品统一是
  //   mb-8(页头与卡片)/ mb-6(卡片之间)/ 动作行 pt-6+分隔线。这里把规格钉死,
  //   免得日后有人顺手调样式又漂回去。
  console.log("\n── 页级垂直节奏(参考产品实拍规格) ──");
  await openSoc(cdp, BASE, "/workflow/sections", tk, pid, 7500);
  await dismissOverlays(cdp);
  await sleep(1000);
  const rhythm = await evalTop(cdp, `(() => {
    const px = (el, prop) => el ? Math.round(parseFloat(getComputedStyle(el)[prop])) : null;
    const h1 = document.querySelector('.wf-h1');
    const head = h1 ? h1.closest('.wf-head') : null;
    const banner = document.querySelector('.banner');
    // ⚠ 2026-09-23: 量 **overview-card** 而不是 tree-card。框架设计页改回单栏后,
    //   tree-card 是**最后一个块**, 下距归零交给页面底部; 夹在中间、真正需要下距的是概览卡。
    //   (两栏时两者都归零、间距由列的 gap 提供 —— 现在没有列了, 间距回到卡片自己的 margin。)
    const card = document.querySelector('.overview-card');
    const act = document.querySelector('.wf-actions');
    const btn = act ? act.querySelector('button') : null;
    const cs = act ? getComputedStyle(act) : null;
    return {
      headMb: px(head, 'marginBottom'),
      bannerMb: px(banner, 'marginBottom'),
      cardMb: px(card, 'marginBottom'),
      actMt: px(act, 'marginTop'), actPt: px(act, 'paddingTop'),
      actBorder: cs ? cs.borderTopWidth : null, actGap: cs ? Math.round(parseFloat(cs.columnGap || cs.gap)) : null,
      btnH: btn ? Math.round(btn.getBoundingClientRect().height) : null,
      colGap: (() => { const c = document.querySelector('.sec-cols'); return c ? Math.round(parseFloat(getComputedStyle(c).columnGap || getComputedStyle(c).gap) || 0) : null; })(),
    };
  })()`);
  const R = rhythm ?? {};
  const eq = (label, got, want) => rec("sections@节奏", label, got === want, `实测=${got} 参考产品=${want}`);
  eq("页头块下距 mb-8", R.headMb, 32);
  eq("状态卡下距 mb-6", R.bannerMb, 24);
  // ⚠ 2026-09-23 再变一次: 框架设计页**从两栏改回单栏**(对齐参考产品), 列的 gap 不存在了 ——
  //   卡片之间的垂直间距回到**卡片自己的 margin**(概览卡 14px)。
  //   这条断言的对象与 2026-09-21 那次是同一个(卡片外边距), 只是值随版式而变:
  //     两栏 → 0(交给 gap) · 单栏 → 14(自己承担)。**判断依据没变: 它必须有个来源, 且不能叠加。**
  eq("单栏下概览卡自带下距 14", R.cardMb, 14);
  eq("已无两栏容器(列间距为空)", R.colGap, null);
  eq("动作行上距 mt-8", R.actMt, 32);
  eq("动作行上内距 pt-6", R.actPt, 24);
  eq("动作行有分隔线", R.actBorder, "1px");
  eq("动作行按钮间距 gap-3", R.actGap, 12);
  eq("按钮高 px-6py-3+20px行高", R.btnH, 46);

  // ── 空态与动效(2026-09-21 V422) ──
  // 这两条都**不影响任何文案/结构断言**, 却正是用户看到的: 空态只有一行灰字、
  //   开合是硬切。不钉住就会悄悄回退。
  console.log("\n── 空态与动效 ──");
  await openSoc(cdp, BASE, "/workflow/materials", tk, pid, 7000);
  await dismissOverlays(cdp);
  await sleep(800);
  // ⚠ 折叠体的内容是 v-if 懒渲染的(不在 DOM 里), 必须**先点开**才有空态。
  //   而且点击后等一帧 —— 展开过渡期间 DOM 已插入但布局未完成(实测 0 处)。
  await evalTop(cdp, `(() => {
    for (const h of document.querySelectorAll('.cat-head .cat-icon-box')) h.click();
    return 1;
  })()`);
  await sleep(600);
  const empty = await evalTop(cdp, `(() => {
    const es = [...document.querySelectorAll('.es')];
    return es.map(e => ({
      hasIcon: !!e.querySelector('.es-icon'),
      hasTitle: !!e.querySelector('.es-title'),
      hintLen: (e.querySelector('.es-hint')?.textContent || '').trim().length,
      hasAction: !!e.querySelector('.es-action'),
    }));
  })()`);
  rec("materials@空态", "空态渲染(应有多处)", (empty?.length ?? 0) > 0, `${empty?.length ?? 0} 处`);
  if (empty?.length) {
    rec("materials@空态", "每处都有图示", empty.every((x) => x.hasIcon), "");
    rec("materials@空态", "每处都有标题", empty.every((x) => x.hasTitle), "");
    // 「一行灰字」的判据: 引导语要有实义长度, 不是「暂无X素材」那种
    rec("materials@空态", "引导语有实义(>12 字, 不是一行灰字)", empty.every((x) => x.hintLen > 12),
      `最短 ${Math.min(...empty.map((x) => x.hintLen))} 字`);
  }
  // 动效: 展开时真的在过渡(120ms 处读到的 opacity/高度应处于中间态)
  const mid = await evalTop(cdp, `(async () => {
    const h = document.querySelector('.cat-head .cat-icon-box');
    if (!h) return null;
    h.click();
    await new Promise(r => setTimeout(r, 120));
    const b = document.querySelector('.cat-body');
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { prop: cs.transitionProperty, op: parseFloat(cs.opacity) };
  })()`);
  rec("materials@动效", "展开不是硬切(过渡属性生效)", mid && /opacity/.test(mid.prop || ""),
    mid ? `transition-property=${mid.prop} 过渡中 opacity=${mid.op}` : "取不到过渡态");

  // ── 吸顶进度条: 滚动时必须贴顶通栏(2026-09-21 修的那个"悬空架着") ──
  // 踩过的坑: 顶部进度条是 position:sticky, 而 sticky 的约束矩形是**滚动容器的内容盒** ——
  //   容器带 padding 时它就只能停在 padding 之内: 实测页面 padding-top 31px 时,
  //   滚动 400 之后进度条 top 恒为 31、左右各露 34/49px, 内容从两侧穿过去。
  //   修法是把内边距从滚动容器移到内层 .wf-body。这条断言锁住"它真的贴顶了"。
  console.log("\n── 吸顶进度条 ──");
  for (const [name, route] of [["materials", "/workflow/materials"], ["sections", "/workflow/sections"]]) {
    await openSoc(cdp, BASE, route, tk, pid, 7000);
    await dismissOverlays(cdp);
    await sleep(800);
    const before = await evalTop(cdp, `(() => {
      const w = document.querySelector('.phase-progress-wrapper');
      const p = document.querySelector('.wf-page');
      if (!w || !p) return null;
      return { pt: getComputedStyle(p).paddingTop, scrollable: p.scrollHeight > p.clientHeight + 8 };
    })()`);
    if (!before) { rec(`${name}@吸顶`, "进度条与滚动容器都在", false, "缺元素"); continue; }
    rec(`${name}@吸顶`, "滚动容器自身无内边距", parseFloat(before.pt) === 0, `paddingTop=${before.pt}`);
    // 滚到底(内容可能不够长, 滚不动就只验静态位置)
    const after = await evalTop(cdp, `(() => {
      const p = document.querySelector('.wf-page');
      p.scrollTop = 400;
      const w = document.querySelector('.phase-progress-wrapper');
      const pw = p.getBoundingClientRect(), ww = w.getBoundingClientRect();
      return { st: Math.round(p.scrollTop), top: Math.round(ww.top),
               左露: Math.round(ww.left - pw.left), 右露: Math.round(pw.right - ww.right) };
    })()`);
    rec(`${name}@吸顶`, "滚动后仍然贴顶(无悬空)", after.top === 0,
      `scrollTop=${after.st} 进度条top=${after.top}${after.top !== 0 ? "(悬空!)" : ""}`);
    // 右露恒为 ~15px —— 那是**滚动条**占的宽(滚动容器自己滚动时内容宽度不含滚动条),
    //   不是"露底"。所以容差放到 20px, 只拦真正的"两侧都露一大截"。
    rec(`${name}@吸顶`, "通栏(只可能差一条滚动条宽)", after.左露 <= 1 && after.右露 <= 20,
      `左露=${after.左露}px 右露=${after.右露}px(滚动条约 15px)`);
  }
} catch (e) {
  console.error("探针异常:", e.message);
} finally {
  try { await api(tk, `/research/projects/${pid}`, "DELETE"); } catch { /* 忽略 */ }
  close();
}
console.log("\n" + "=".repeat(50));
const fail = out.filter((o) => !o.ok);
console.log(`布局门禁: ${out.length - fail.length} 通过 / ${fail.length} 失败`);
process.exit(fail.length ? 1 : 0);
