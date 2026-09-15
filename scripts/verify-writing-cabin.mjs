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
import { startCdp, loginToken, findSocFrame, evalInFrame, sleep } from "./lib/cdp-editor.mjs";

const BASE = "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

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
  const proj = await api(token, "/research/projects", "POST", { title: TITLE, status: "in-progress", phase: 4, phaseLabel: "文本创作" });
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
      phase: 4, phaseLabel: "文本创作",
      input: { title: TITLE, outline: "", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] },
      sections, variables: [], hypotheses: [],
      // ④ 要验「合稿模式 tab + 强度档」, 那组控件只在**已合稿态**出现(空态只有「开始合并」, 与闭源一致)
      mergeGenerated: true,
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

  const goto = async (route, wait = 6000) => {
    await ev(`location.hash = '#paper-outline';`);
    await sleep(1500);
    const fid = await findSocFrame(cdp);
    if (!fid) return null;
    // 子应用是独立 hash 路由, 切 route 必须整帧重载(hash 变更不触发 vue-router 重挂载)
    await evalInFrame(cdp, fid, `location.href = location.origin + '/soc/index.html#${route}'; 'ok'`);
    await sleep(wait);
    return await findSocFrame(cdp);
  };
  const inFrame = (fid, expr) => evalInFrame(cdp, fid, expr);

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
      // 切到预览(闭源默认落在「编辑」, 预览是第二个 tab)
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
    t("默认落在「编辑」(闭源如此)", r?.onBefore === "编辑", r ? `激活=${r.onBefore}` : "—");
    t("切到预览后出现渲染容器(.content-html)", !!r?.hasHtml);
    t("旧的 <pre> 直出已移除", !!r && r.legacyPre === false);
    t("markdown 表格渲染成真表格", !!r && r.tables >= 1 && !r.rawPipes, r ? `tables=${r.tables} 裸管道符=${r.rawPipes}` : "—");
  }

  console.log("\n═══ ③ 右栏素材按当前章节过滤 ═══");
  {
    const fid = await findSocFrame(cdp);
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

  console.log("\n═══ ④ 合稿空态 → 真合稿 → 降 AIGC 强度档 ═══");
  {
    // 已合稿态不能靠播种伪造: FinalizeView 挂载后 refreshMerged() 会用项目行的 merge_generated
    //   覆盖本地快照, 而那一列只有真跑一次合稿才会被置真。所以这里走真实链路
    //   (顺带把新增的「准备合并定稿」空态卡也验了)。
    const fid = await goto("/workflow/finalize");
    // 等页面真正挂载(空态卡出现)再读, 否则读到的可能是上一页的残留 DOM
    let empty = null;
    for (let i = 0; i < 12; i++) {
      empty = fid ? await inFrame(fid, `(() => {
        const el = document.querySelector('.finalize-empty');
        return { has: !!el, text: el ? el.innerText.replace(/\\s+/g,' ').trim() : '', modes: document.querySelectorAll('.mm-tab').length };
      })()`) : null;
      if (empty?.has || empty?.modes) break;
      await sleep(1200);
    }
    t("未合稿时显示空态卡", !!empty?.has && /准备合并定稿/.test(empty.text), empty ? empty.text.slice(0, 60) : "—");
    t("空态下不出现强度档", empty?.modes === 0, `模式 tab=${empty?.modes}`);

    const clicked = fid ? await inFrame(fid, `(() => {
      const b = [...document.querySelectorAll('.finalize-empty button, .btn-round')].find(e => /开始合并/.test(e.innerText));
      if (!b) return false; b.click(); return true;
    })()`) : false;
    let modes = [];
    let why = "";
    // 合稿要跑摘要 + 关键词 + (降AIGC 时) 逐章改写, 多次 LLM 调用叠加可到 2 分钟;
    //   原先 96s 的窗口在慢的时候不够 —— 表现成"模式 tab 没出现"的假失败。
    for (let i = 0; i < 60 && clicked; i++) {
      await sleep(4000);
      const st = await inFrame(fid, `(() => ({
        modes: [...document.querySelectorAll('.mm-tab')].map(e => e.innerText.trim()),
        toast: (document.querySelector('[class*="toast"], .ui-toast')||{}).innerText || '',
        msg: [...document.querySelectorAll('.merge-msg, .gen-err, .finalize-empty')].map(e => e.innerText).join(' ').slice(0, 120),
        running: !!document.querySelector('.mt-item'),
      }))()`);
      modes = Array.isArray(st?.modes) ? st.modes : [];
      if (modes.length) break;
      why = String(st?.toast || st?.msg || "").slice(0, 120);
    }
    t("合稿完成后出现模式 tab(直接/降AIGC)", modes.length === 2,
      `点击=${clicked} 实测=${JSON.stringify(modes)}${why ? ` 页面提示=${why}` : ""}`);

    // 整个交互序列放在**同一次 eval** 里: evalInFrame 每次会新建 isolated world,
    //   跨 eval 观察不到 Vue 在上一个 world 里做的 DOM 补丁(实测: 分开读恒为空)。
    const r = fid ? await inFrame(fid, `(async () => {
      const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const beforeTiers = document.querySelectorAll('.tier-btn').length;
      const aigc = [...document.querySelectorAll('.mm-tab')].find(e => /降AIGC/.test(e.innerText));
      if (!aigc) return { beforeTiers, err: 'no-aigc-tab' };
      aigc.click();
      await raf(); await new Promise(r => setTimeout(r, 600)); await raf();
      const tiers = [...document.querySelectorAll('.tier-btn')].map(e => e.innerText.trim());
      const defaultOn = [...document.querySelectorAll('.tier-btn')].find(e => e.className.includes('on'))?.innerText.trim() || '';
      const hint1 = document.querySelector('.tier-hint')?.innerText || '';
      const heavy = [...document.querySelectorAll('.tier-btn')].find(e => /重度/.test(e.innerText));
      if (heavy) heavy.click();
      await raf(); await new Promise(r => setTimeout(r, 400)); await raf();
      return {
        beforeTiers, tiers, defaultOn, hint1,
        onAfter: [...document.querySelectorAll('.tier-btn')].find(e => e.className.includes('on'))?.innerText.trim() || '',
        hint2: document.querySelector('.tier-hint')?.innerText || '',
      };
    })()`) : null;

    t("直接合稿时不显示强度档", r?.beforeTiers === 0, `切前档位数=${r?.beforeTiers}`);
    t("降AIGC 模式出现三档", !!r && r.tiers.length === 3, r ? JSON.stringify(r.tiers) : "—");
    t("默认落在中度", /中度/.test(r?.defaultOn ?? ""), r ? r.defaultOn : "—");
    t("换档时该档说明跟着变", !!(r?.hint1 && r?.hint2 && r.hint1 !== r.hint2), `${r?.hint1} → ${r?.hint2}`);
    t("换档后激活态跟着走", /重度/.test(r?.onAfter ?? ""), r ? r.onAfter : "—");
  }

  console.log("\n═══ ⑤ 对齐批次的结构断言(2026-09-15 B1-B4) ═══");
  {
    // 素材准备: 「补充素材来源」整卡 + 手风琴头行内按钮 + 页头三行状态
    const fid = await goto("/workflow/materials");
    const r = fid ? await inFrame(fid, `(() => {
      const tiles = [...document.querySelectorAll('.sc-tile .sc-tile-text')].map(e => e.innerText.trim());
      const heads = [...document.querySelectorAll('.cat-head')];
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
        statsText: document.querySelector('.mat-stats')?.innerText.replace(/\\s+/g,' ').trim() || '',
        bottomBtns: [...document.querySelectorAll('.wf-actions button')].map(e => e.innerText.trim()),
      };
    })()`) : null;
    t("有「补充素材来源」整卡", !!r?.hasSourceCard);
    t("手动添加四格 + 从其他模块导入两格", !!r && r.tileCount === 6, r ? `tiles=${JSON.stringify(r.tiles)}` : "—");
    t("分组标题存在", !!r && r.groups.length === 2, r ? JSON.stringify(r.groups) : "—");
    t("折叠态也能看到行内操作按钮", !!r && r.inlineInCollapsed > 0, r ? `${r.inlineInCollapsed} 个分类` : "—");
    t("页头三行状态区", !!r && /按流程完成素材整理后即可进入创作/.test(r.statsText), r ? r.statsText : "—");
    t("底部收成两个按钮", !!r && r.bottomBtns.length === 2, r ? JSON.stringify(r.bottomBtns) : "—");
  }

  console.log("\n═══ ⑥ 无 JS 错误 ═══");
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
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
