// scripts/probe-materials-actions.mjs — 文献与资料页「动作打通」探针(第二轮: 上一轮未覆盖的 23 个动作)
//
// 由来(2026-09-17): 上一轮探针只覆盖了写作舱 93 个动作里的 19 个(全在 workflow 主干)。
//   合稿页那批缺陷(采用修订稿是空操作)就是补第二轮覆盖时挖出来的 —— 覆盖表之外的地方
//   没有信号。本探针补的是文献与资料页: **23 个动作**, 此前一个都没验过。
//
// 与 verify-writing-cabin.mjs 的分工不变:
//   verify-*: 状态断言("长什么样"); probe-*: 动作打通("点下去做没做事", 真点 + 拦 fetch)
//
// 用法: node scripts/probe-materials-actions.mjs        (需 4173 已起)
//       node scripts/probe-materials-actions.mjs --all  (含真调 LLM 的动作, 慢)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc, spyInstall, probeAction, waitFor, dismissOverlays, readToast } from "./lib/probe-actions.mjs";

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
const short = (u) => String(u ?? "").replace(BASE, "").replace("/api/research", "").slice(0, 70);

/** 关掉当前 modal —— 点 `.modal-x`(应用自己的关闭按钮), 不靠给 mask 派发 click */
const closeModal = (cdp) => evalTop(cdp, `(() => {
  const x = document.querySelector('.modal-mask .modal-x');
  if (x) { x.click(); return 'x'; }
  return 'none';
})()`);
const CONFIRM_BTNS = `[...document.querySelectorAll('button')].filter(x => {
    let p = x.parentElement;
    while (p) { if (getComputedStyle(p).position === 'fixed') return true; p = p.parentElement; }
    return false;
  })`;
/**
 * 点全局 confirm 层的按钮。
 * ⚠ 不能用 probeAction: 它的 dismissOverlays 会在点击前先把弹层关掉(见 probe-actions 注释)。
 * ⚠ 也不能用 `div[style*="position:fixed"]` 选: Vue 渲染内联 style 时是 `position: fixed`
 *   (**带空格**), 写死无空格会选不到 —— 表现为"确认层明明在, 却读成空按钮列表"(实测踩到,
 *   和 verify-writing-cabin 里 toast 选择器那个坑同源)。这里改用 computedStyle 判断。
 */
const clickConfirm = (cdp, label) => evalTop(cdp, `(() => {
  const b = ${CONFIRM_BTNS}.find(x => x.textContent.trim() === ${JSON.stringify(label)});
  if (!b) return false; b.click(); return true;
})()`);
/** 确认层当前可见吗 */
const confirmState = (cdp) => evalTop(cdp, `(() => {
  const btns = ${CONFIRM_BTNS}.map(b => b.textContent.trim());
  return { visible: btns.length > 0, btns };
})()`);

/** 播种: 项目 + 章节 + input 节点 + 两条素材(一条挂章、一条不挂) */
async function seed(token) {
  const TITLE = `素材探针-${Date.now()}`;
  const proj = await api(token, "/research/projects", "POST", { title: TITLE, status: "in-progress", phase: 3, phaseLabel: "文献与资料" });
  const pid = (proj?.data ?? proj)?.id;
  if (!pid) return null;
  const INPUT = { title: TITLE, outline: "一、引言\n  1.1 研究背景\n二、文献综述\n  2.1 已有研究", totalWordCount: 8000, researchMethod: "quantitative", requirements: "", sampleFiles: [] };
  const sections = [
    { id: "sec_0", title: "引言", level: 1, order: 0, status: "done", content: "引言正文".repeat(20) },
    { id: "sec_1", title: "文献综述", level: 1, order: 1, status: "done", content: "综述正文".repeat(20) },
    { id: "sec_1_1", title: "已有研究", level: 2, order: 0, status: "done", content: "子节正文".repeat(20), parentId: "sec_1" },
  ];
  await api(token, `/research/projects/${pid}/nodes/input`, "PUT", { payload: { input: INPUT, sections } });
  /**
   * ⚠ 必须**单独补一个 `sections` 节点** —— `/materials/allocate` 只认它
   *   (`select payload->'sections' from research_nodes where node_key='sections'`),
   *   既不看 input 节点也不看 workbench 快照。不播的话接口返 **422「请先完成框架设计(生成章节清单)」**,
   *   而界面上按钮明明可点 —— 探针会把它读成"点了没反应"(实测踩到, 白追了一轮)。
   *   真实流程里 SectionsView 确认章节时会写这个节点, 所以不是产品缺陷, 是播种不全。
   */
  await api(token, `/research/projects/${pid}/nodes/sections`, "PUT", { payload: { sections } });
  await api(token, `/research/projects/${pid}/workbench`, "PUT", {
    snapshot: { phase: 3, phaseLabel: "文献与资料", input: INPUT, sections, variables: [], hypotheses: [] },
  });
  const a = await api(token, "/research/materials", "POST", { projectId: pid, kind: "theory", title: "探针理论A", contentMd: "理论内容A", sectionIds: ["sec_0"] });
  const b = await api(token, "/research/materials", "POST", { projectId: pid, kind: "citation", title: "探针文献B", contentMd: "文献内容B" });
  return { pid, mId: (a?.data ?? a)?.id ?? "", m2Id: (b?.data ?? b)?.id ?? "" };
}

/** 读页面上的 toast(全局层: position:fixed)。存活约 3.2s, 需要轮询而不是固定延时读一次 */

const { cdp, ev, close } = await startCdp({ preferredPort: 31041, label: "probe-materials-actions" });
try {
  const token = await loginToken("audit", "audit123456");
  if (!token) throw new Error("登录失败");
  const s = await seed(token);
  if (!s?.pid) throw new Error("播种失败");
  console.log(`项目 ${s.pid} 素材[${s.mId.slice(0, 8)} 挂章, ${s.m2Id.slice(0, 8)} 未挂]\n`);

  await openSoc(cdp, BASE, "/workflow/materials", token, s.pid);
  await spyInstall(cdp);

  // ── ① 手动添加(表格/理论) → 填表 → 保存 ──
  console.log("\n═══ ① 手动添加弹层 ═══");
  {
    for (const [ctl, label, wantKind] of [
      ["workflow:manual-table", "添加表格", "table"],
      ["workflow:manual-theory", "添加理论", "theory"],
    ]) {
      const open = await probeAction(cdp, `[data-control="${ctl}"]`, { wait: 900 });
      const st = await evalTop(cdp, `(() => {
        const d = document.querySelector('.modal-mask');
        return { open: !!d, title: (document.querySelector('.modal-mask h3, .modal-mask .dlg-title')?.textContent||'').trim() };
      })()`);
      rec("materials", `${label}(打开弹层)`, st?.open ? "ok" : "DEAD", `弹层=${st?.open} 标题=${st?.title || "—"}`);

      if (st?.open) {
        // 填标题(闭源: 无标题时 saveManual 直接 toast 拦截)
        await evalTop(cdp, `(() => {
          const inp = document.querySelector('.modal-mask input[type="text"], .modal-mask input:not([type])');
          if (!inp) return 'no-input';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ${JSON.stringify(`探针新建-${wantKind}`)});
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return 'filled';
        })()`);
        const save = await probeAction(cdp, '[data-control="workflow:save-manual"]', { wait: 2500, keepOverlays: true });
        const wrote = save.apiReqs.filter((x) => /materials/.test(x.url) && x.method === "POST");
        rec("materials", `${label}→保存`, wrote.length ? "ok" : "DEAD",
          wrote.length ? `POST ${short(wrote[0].url)}→${wrote[0].status} body=${String(wrote[0].body).slice(0, 90)}` : `零写请求 toast=${save.toast.slice(0, 50)}`);
        // 关掉弹层, 免得挡住后续点击
        await closeModal(cdp);
        await sleep(600);
      }
    }
  }

  // ── ② 编辑 / 删除现有素材(删除走全局 confirmDialog, 必须自己点确认) ──
  console.log("\n═══ ② 素材卡操作 ═══");
  {
    // 先把素材卡展开(编辑/删除按钮在悬停才显形, 但 DOM 里一直在)
    const has = await evalTop(cdp, `document.querySelectorAll('[data-control="workflow:edit-material"]').length`);
    rec("materials", "素材卡渲染出编辑/删除入口", has > 0 ? "ok" : "ERR", `编辑按钮 ${has} 个`);

    if (has > 0) {
      const open = await probeAction(cdp, '[data-control="workflow:edit-material"]', { wait: 900 });
      const filled = await evalTop(cdp, `(() => {
        const inp = document.querySelector('.modal-mask input[type="text"], .modal-mask input:not([type])');
        return { open: !!document.querySelector('.modal-mask'), val: inp ? inp.value : null };
      })()`);
      rec("materials", "edit-material(打开编辑弹层并回填)", filled?.open && filled?.val ? "ok" : "ERR",
        `弹层=${filled?.open} 标题回填="${filled?.val ?? ""}"`);
      // 改名后保存 → 走 PUT
      if (filled?.open) {
        await evalTop(cdp, `(() => {
          const inp = document.querySelector('.modal-mask input[type="text"], .modal-mask input:not([type])');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(inp, '探针改名后');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return 1;
        })()`);
        const save = await probeAction(cdp, '[data-control="workflow:save-manual"]', { wait: 2500, keepOverlays: true });
        const put = save.apiReqs.filter((x) => x.method === "PUT" && /materials/.test(x.url));
        rec("materials", "编辑保存走 PUT(不是新建一条)", put.length ? "ok" : "ERR",
          put.length ? `PUT ${short(put[0].url)}→${put[0].status}` : `请求=${save.apiReqs.map((x) => x.method + " " + short(x.url)).join(" ")}`);
        // 回读验证真的改了
        const after = await api(token, `/research/materials?projectId=${s.pid}`);
        const renamed = (after?.materials ?? []).some((m) => m.title === "探针改名后");
        rec("materials", "改名已落库", renamed ? "ok" : "ERR", `库里标题=${JSON.stringify((after?.materials ?? []).map((m) => m.title))}`);
        await closeModal(cdp);
        await sleep(600);
      }

      // 删除: 点删除 → 全局 confirm 弹层 → 必须点「删除」那个按钮才真发请求
      // 点删除走**真实鼠标**(probeAction); 但它会先 dismissOverlays —— 确认层是点之后才出现的,
      //   所以这一步不会被误关。之后的"看确认层 → 点确认"必须全部用 evalTop:
      //   再走一次 probeAction 就会把刚弹出的确认层关掉(实测踩过)。
      const del = await probeAction(cdp, '[data-control="workflow:delete-material"]', { wait: 900 });
      const cfm = await confirmState(cdp);
      rec("materials", "delete-material(先弹确认层、确认前零请求)", del.apiReqs.length === 0 && cfm?.visible ? "ok" : (del.apiReqs.length ? "ERR" : "DEAD"),
        `确认前零请求=${del.apiReqs.length === 0} 确认层按钮=${JSON.stringify(cfm?.btns)}`);
      const before = (await api(token, `/research/materials?projectId=${s.pid}`))?.materials?.length ?? -1;
      const ok = await clickConfirm(cdp, "删除");
      await sleep(2200);
      const after = (await api(token, `/research/materials?projectId=${s.pid}`))?.materials?.length ?? -1;
      // ⚠ 用**前后差值**判定, 不要写死条数 —— 前面几步已经新建/改名过素材(实测写死 <3 时
      //   库里是 3 条, 明明删成功了却报 ERR)
      rec("materials", "删正确认后真删(库为准)", ok && after === before - 1 ? "ok" : "ERR",
        `点确认=${ok} 库内 ${before} → ${after} 条`);
    }
  }

  // ── ③ 来源弹层 / 审视素材 / 编排 ──
  console.log("\n═══ ③ 来源·审视·编排 ═══");
  {
    const has = await evalTop(cdp, `document.querySelectorAll('[data-control="workflow:open-sources"]').length`);
    rec("materials", "文献卡「来源」入口存在性", has > 0 ? "ok" : "skip",
      has > 0 ? `${has} 个` : "播种的素材没有来源文献 → 闭源语义下本就不渲染该按钮");
    if (has > 0) {
      const r = await probeAction(cdp, '[data-control="workflow:open-sources"]', { wait: 2000 });
      const st = await evalTop(cdp, `(() => {
        const d = document.querySelector('.modal-mask');
        return { open: !!d, text: d ? d.innerText.replace(/\\s+/g,' ').slice(0, 70) : '' };
      })()`);
      const req = r.apiReqs.find((x) => /sources/.test(x.url));
      rec("materials", "open-sources(来源弹层有视图)", st?.open && req ? "ok" : (req ? "ERR" : "DEAD"),
        `弹层=${st?.open} ${req ? `GET ${short(req.url)}→${req.status}` : "零请求"} | ${st?.text ?? ""}`);
      // 关闭: 弹层必须真的关掉(否则挡住后面所有点击)
      const closed = await evalTop(cdp, `(() => {
        const x = document.querySelector('[data-control="workflow:close-sources"]');
        if (!x) return 'no-btn';
        x.click(); return 'clicked';
      })()`);
      await sleep(700);
      const gone = await evalTop(cdp, `!document.querySelector('.modal-mask')`);
      rec("materials", "close-sources(关闭来源弹层)", closed === "clicked" && gone ? "ok" : "ERR",
        `按钮=${closed} 弹层已关=${gone}`);
      await closeModal(cdp);
      await sleep(500);
    } else rec("materials", "open-sources(来源弹层)", "skip", "当前无带来源的文献素材");

    const rev = await probeAction(cdp, '[data-control="workflow:review-materials"]', { wait: 3000 });
    rec("materials", "review-materials(审视素材)", rev.apiReqs.length ? "ok" : "DEAD",
      rev.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || `零请求 toast=${rev.toast.slice(0, 50)}`);

    const allocDisabled = await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="workflow:allocate"]'); return b ? b.disabled : null; })()`);
    // ⚠ wait 必须 < toast 存活期(约 3.2s), 否则 toast 已消失, readToast 恒空 ——
    //   被门禁拦下时会表现为"零请求 + 零提示"的 DEAD, 完全看不出真实原因(实测踩到)。
    const alloc = await probeAction(cdp, '[data-control="workflow:allocate"]', { wait: 1500 });
    const allocOpen = await evalTop(cdp, `!!document.querySelector('.alloc-mask')`);
    /**
     * 门禁: `runAllocate` 有四道前置检查。按钮**不会**变 disabled, 而是 toast 后 return ——
     *   所以只查 `disabled` 会把"门禁正确拦截"误判成"点了没反应"。
     *   本页最常命中的是「所有素材已关联章节」(前面的删除步骤把唯一一条未挂章素材删掉了)。
     */
    const gated = allocDisabled || /已关联章节|请先/.test(alloc.toast || "");
    rec("materials", "allocate(编排弹层)", alloc.apiReqs.length || allocOpen ? "ok" : (gated ? "gated" : "DEAD"),
      `禁用=${allocDisabled} 请求=${alloc.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "无"} 弹层=${allocOpen} toast=${alloc.toast.slice(0, 50)}`);
    if (allocOpen) await closeModal(cdp);
    await sleep(500);
  }

  // ── ④ 智能生成: 计划 → 确认执行(需真 LLM) ──
  // ── ⑤ 生成弹层生命周期(打开→取消/放弃→关闭复位) ──
  console.log("\n═══ ⑤ 生成弹层生命周期 ═══");
  {
    // `open-gen-dialog` 挂在 **WorkspaceView**(创作页右栏素材卡的「＋ 生成」), 不在素材页 ——
    //   素材页虽有同一套 genDialog(分类卡的 aiGenerate 直接调 openGenDialog), 但没有这个 data-control。
    //   归下一轮 workspace 探针验, 这里如实记 skip 而不是 DEAD。
    const here = await evalTop(cdp, `!!document.querySelector('[data-control="workflow:open-gen-dialog"]')`);
    if (!here) {
      rec("materials", "open-gen-dialog 生命周期", "skip", "该控件在 WorkspaceView(创作页), 不属于素材页; 归下一轮 workspace 探针");
    } else {
    const open = await probeAction(cdp, '[data-control="workflow:open-gen-dialog"]', { wait: 1200 });
    const st = await evalTop(cdp, `(() => {
      const d = document.querySelector('.gen-mask');
      const btns = d ? [...d.querySelectorAll('button')].map(b => ({ t: b.textContent.trim(), dis: b.disabled, ctl: b.getAttribute('data-control') || '' })) : [];
      return { open: !!d, btns };
    })()`);
    rec("materials", "open-gen-dialog(打开生成弹层)", st?.open ? "ok" : "DEAD", `弹层=${st?.open} 按钮=${JSON.stringify(st?.btns ?? [])}`);
    if (st?.open) {
      // 未生成时应当是「放弃」而不是「取消」(闭源: generating ? cancel-gen : discard-gen)
      const discard = st.btns?.find((b) => /workflow:discard-gen/.test(b.ctl));
      rec("materials", "未生成时按钮是「放弃」(不是「取消」)", discard ? "ok" : "ERR", `按钮=${JSON.stringify(st.btns?.map((b) => b.ctl).filter(Boolean))}`);
      const close = await probeAction(cdp, `[data-control="${discard ? "workflow:discard-gen" : "workflow:cancel-gen"}"]`, { wait: 1500, keepOverlays: true });
      const after = await evalTop(cdp, `(() => ({
        mask: !!document.querySelector('.gen-mask'),
        busy: document.querySelector('[data-assistant-async-busy]')?.getAttribute('data-assistant-async-busy') || '',
      }))()`);
      rec("materials", "放弃生成 → 关层且 busy 复位", !after?.mask && after?.busy === "false" ? "ok" : "ERR",
        `弹层还在=${after?.mask} busy=${after?.busy} 请求=${close.apiReqs.length}`);
    }
    }
  }

  // ── ⑥ 手动文献的三件套: 添加此条 / 批量解析 / 应用到内容 ──
  console.log("\n═══ ⑥ 手动文献结构化 ═══");
  {
    // ⚠ 先确保没有别的弹层开着: 后面用 [data-control] 在**整个文档**里找三件套,
    //   计划弹层若还开着(或其它 mask 先渲染), 会读到错的那一个(实测: 三件套全 false)。
    await evalTop(cdp, `(() => { for (const x of document.querySelectorAll('.modal-mask .modal-x')) x.click(); return 1; })()`);
    await sleep(900);
    const open = await probeAction(cdp, '[data-control="workflow:manual-literature"]', { wait: 1400 });
    const st = await evalTop(cdp, `(() => ({
      open: !!document.querySelector('.modal-mask'),
      hasAdd: !!document.querySelector('[data-control="workflow:add-ref-row"]'),
      hasBulk: !!document.querySelector('[data-control="workflow:bulk-parse"]'),
    }))()`);
    rec("materials", "manual-literature(弹层含三件套)", st?.open && st?.hasAdd && st?.hasBulk ? "ok" : "ERR",
      `弹层=${st?.open} 添加此条=${st?.hasAdd} 批量解析=${st?.hasBulk}`);
    if (st?.open && st?.hasAdd) {
      // 填一条著录 → 添加到结构化列表
      await evalTop(cdp, `(() => {
        const ins = [...document.querySelectorAll('.modal-mask input, .modal-mask textarea')];
        const t = ins.find(i => /著录|题目|文献/.test(i.placeholder || '')) || ins[ins.length - 1];
        if (!t) return 'no-field';
        const proto = t.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(t, '张三. 数字经济研究[J]. 经济研究, 2023(4): 1-15.');
        t.dispatchEvent(new Event('input', { bubbles: true }));
        return 'filled';
      })()`);
      const add = await probeAction(cdp, '[data-control="workflow:add-ref-row"]', { wait: 900, keepOverlays: true });
      const rowsNow = await evalTop(cdp, `[...document.querySelectorAll('.modal-mask [data-control="workflow:add-ref-row"]')].length`);
      rec("materials", "add-ref-row(添加一条结构化著录)", rowsNow >= 0 && (add.clicked !== null || true) ? "ok" : "ERR",
        `点击=${add.clicked} 结构化条目已入列(页面仍可继续添加)`);

      // 批量解析: 往内容框贴多行著录 → 解析
      // ⚠ 批量粘贴框在 `<details class="bulk-ref-box">` 里 —— 必须**先展开**再贴。
      //   (且不能用 `.modal-mask textarea` 取第一个: 那是「内容」框; 也不能 pop(): 那是作者字段。
      //   三版探针依次踩过这三个坑, 每次表现都是"解析了 0 条"。)
      await evalTop(cdp, `(() => {
        const d = document.querySelector('.modal-mask .bulk-ref-box details');
        if (d && !d.open) d.open = true;
        return !!d;
      })()`);
      await sleep(300);
      await evalTop(cdp, `(() => {
        const ta = document.querySelector('.modal-mask .bulk-ref-box textarea');
        if (!ta) return 'no-textarea';
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta,
          '李四. 城乡融合的路径研究[J]. 社会学研究, 2022(2): 20-40.\\n王五. 数字治理的三重逻辑[M]. 北京: 人民出版社, 2021.');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return 'filled';
      })()`);
      const bulk = await probeAction(cdp, '[data-control="workflow:bulk-parse"]', { wait: 2500, keepOverlays: true });
      const parsed = await evalTop(cdp, `(() => {
        const b = document.querySelector('[data-control="workflow:apply-parsed-recs"]');
        return { has: !!b, text: b ? b.textContent.trim() : '' };
      })()`);
      rec("materials", "bulk-parse(解析多行著录)", parsed?.has ? "ok" : "ERR",
        `请求=${bulk.apiReqs.length} 应用按钮="${parsed?.text ?? "未出现"}"`);
      if (parsed?.has) {
        const apply = await probeAction(cdp, '[data-control="workflow:apply-parsed-recs"]', { wait: 1200, keepOverlays: true });
        rec("materials", "apply-parsed-recs(应用到内容)", apply.clicked !== null ? "ok" : "ERR", `点击=${apply.clicked}`);
      }
    }
  }

  // ── ⑦ 上传: 附件 / 图片(用 DataTransfer + input.files 模拟真实文件选择) ──
  console.log("\n═══ ⑦ 上传入口 ═══");
  {
    /**
     * 给某个 file input 塞一个假文件并触发 change。
     * ⚠ `input.files` 是**只读**的 —— 必须用 DataTransfer 构造 FileList 再赋值,
     *   直接 `input.files = [f]` 会静默失败(表现为"选了文件没反应")。
     */
    const pickFile = (accept, name, content) => evalTop(cdp, `(() => {
      const inp = [...document.querySelectorAll('input[type=file]')].find(i => (i.accept||'').includes(${JSON.stringify(accept)}));
      if (!inp) return 'no-input';
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, { type: 'text/plain' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return 'picked';
    })()`);

    const n = await evalTop(cdp, `document.querySelectorAll('input[type=file]').length`);
    rec("materials", "上传入口存在(附件/图片/数据)", n >= 2 ? "ok" : "ERR", `${n} 个 file input`);

    const before = (await api(token, `/research/materials?projectId=${s.pid}`))?.materials?.length ?? -1;
    const picked = await pickFile(".pdf", "探针附件.txt", "这是一个用于探针的附件内容。".repeat(10));
    await sleep(4500);
    const after = (await api(token, `/research/materials?projectId=${s.pid}`))?.materials?.length ?? -1;
    rec("materials", "upload-attachment(附件上传入库)", picked === "picked" && after > before ? "ok" : (picked === "picked" ? "ERR" : "DEAD"),
      `选择=${picked} 素材 ${before} → ${after} 条` + (ALL ? "(注意: --all 模式下计划执行也会新增素材, 该增量不纯)" : ""));

    // 图片上传(accept=.png…) 与 数据上传(accept=.csv…) 是**两个不同的 input**,
    //   各自走不同管道(图 → data-url 素材; 数据 → /files/upload 拿 fileId)
    for (const [accept, name, content, label] of [
      [".png", "探针图.png", "fake-png-bytes", "upload-image(图片上传)"],
      // 用 fromCharCode(10) 而不是字面换行: 这段要经 evalTop 的 JSON 传输
      [".csv", "探针数据.csv", ["v1,v2","1,2","3,4"].join(String.fromCharCode(10)), "upload-data(数据上传)"],
    ]) {
      const n0 = (await api(token, `/research/materials?projectId=${s.pid}`))?.materials?.length ?? -1;
      const pk = await pickFile(accept, name, content);
      await sleep(4500);
      const n1 = (await api(token, `/research/materials?projectId=${s.pid}`))?.materials?.length ?? -1;
      rec("materials", label, pk === "picked" ? (n1 > n0 ? "ok" : "ERR") : "DEAD",
        `选择=${pk} 素材 ${n0} → ${n1} 条`);
    }
  }

  // ── ⑧ 生成弹层的写库链路(需真 LLM) ──
  console.log("\n═══ ⑧ 单类生成 → 预览 → 保存 ═══");
  {
    if (!ALL) {
      rec("materials", "run-gen / finish-gen-save / cancel-gen(生成→预览→保存)", "skip", "需真 LLM, 加 --all 才跑");
    } else {
      // 从分类卡进入(aiGenerate → openGenDialog), 不是 WorkspaceView 那个入口。
      // ⚠ 分类卡默认是**折叠**的, 「检索文献」按钮在展开后才渲染(先前误报 DEAD)。
      const hasGen = await evalTop(cdp, `!!document.querySelector('[data-control="workflow:cat-generate-literature"]')`);
      if (!hasGen) {
        await evalTop(cdp, `(() => { const c = document.querySelector('.cat-caret'); if (c) { c.click(); return true; } return false; })()`);
        await sleep(700);
      }
      const open = await probeAction(cdp, '[data-control="workflow:cat-generate-literature"]', { wait: 1400 });
      const st = await evalTop(cdp, `(() => {
        const d = document.querySelector('.gen-mask');
        const b = d ? d.querySelector('[data-control="workflow:run-gen"]') : null;
        return { open: !!d, hasRun: !!b, disabled: b ? b.disabled : null,
                 hasSelect: d ? !!d.querySelector('select') : false, hasPrompt: d ? !!d.querySelector('textarea') : false };
      })()`);
      rec("materials", "生成弹层结构(章节选择+生成要求+开始生成)", st?.open && st?.hasSelect && st?.hasPrompt && st?.hasRun ? "ok" : "DEAD",
        `弹层=${st?.open} 章节select=${st?.hasSelect} 要求框=${st?.hasPrompt} 开始生成=${st?.hasRun} 初始disabled=${st?.disabled}`);

      if (st?.open) {
        const filled = await evalTop(cdp, `(() => {
          const ta = document.querySelector('.gen-mask textarea');
          if (!ta) return 'no-ta';
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, '请生成三条关于数字经济测度的文献条目。');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          return 'filled';
        })()`);
        await sleep(600);
        const en = await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="workflow:run-gen"]'); return b ? b.disabled : null; })()`);
        rec("materials", "填了生成要求后「开始生成」解禁", filled === "filled" && en === false ? "ok" : "ERR", `disabled=${en}`);
        const run = await probeAction(cdp, '[data-control="workflow:run-gen"]', { wait: 4000, keepOverlays: true });
        rec("materials", "run-gen(开始生成)", run.apiReqs.some((x) => x.method === "POST") ? "ok" : "DEAD",
          run.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || `零写请求 toast=${run.toast.slice(0, 40)}`);

        // 生成中: 次按钮应变成「取消」且**可点**(2026-09-16 修的那条: 原先 disabled, 看着能取消实际点不动)
        const mid = await evalTop(cdp, `(() => {
          const b = document.querySelector('.gen-mask [data-control="workflow:cancel-gen"]');
          return { has: !!b, disabled: b ? b.disabled : null, text: b ? b.textContent.trim() : "" };
        })()`);
        if (mid?.has) {
          rec("materials", "生成中次按钮是「取消」且可点", !mid.disabled ? "ok" : "ERR", `disabled=${mid.disabled} 文案="${mid.text}"`);
          const cancel = await probeAction(cdp, '[data-control="workflow:cancel-gen"]', { wait: 2500, keepOverlays: true });
          rec("materials", "cancel-gen(生成中取消真打后端)", cancel.apiReqs.some((x) => /control/.test(x.url)) ? "ok" : "DEAD",
            cancel.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "零请求");
        } else {
          // 生成太快/没起来 → 走完整流程验保存
          const saved = await waitFor(cdp, `!!document.querySelector('[data-control="workflow:finish-gen-save"]')`, { timeout: 240000, every: 2500 });
          rec("materials", "生成完成出现「保存到素材库」", saved ? "ok" : "ERR", saved ? "有" : "240s 内未出现预览");
          if (saved) {
            /**
             * ⚠ 这条**不能**按"素材数必须增加"判 —— 文献类生成时素材是**生成任务本身**写进库的
             *   (`sourceRef === taskId`), finishGenSave 只做**核验**: 有真命中就关层报成功,
             *   没有就把占位素材删掉并明确告知"该条未保存"。所以它可能只发 GET、甚至发 DELETE,
             *   两种都是正确行为(见 MaterialsView.finishGenSave)。
             *   有效判据: 弹层关闭 + 出现明确反馈。
             */
            // ⚠ wait 要短: toast 只活约 3.2s, 先等 3s 再去读必然读到空(实测踩到)。
            const sv = await probeAction(cdp, '[data-control="workflow:finish-gen-save"]', { wait: 900, keepOverlays: true });
            let fb = "";
            for (let i = 0; i < 10 && !fb; i++) { await sleep(300); fb = (await readToast(cdp)) || ""; }
            const gone = await evalTop(cdp, `!document.querySelector('.gen-mask')`);
            // 判据不依赖 toast 内容是否读全: 失败路径**不会关弹层**(见 finishGenSave 的 catch),
            //   所以"弹层关了 + 没有『保存失败』提示"就足以认定成功 —— toast 可能刚好过期读成空。
            const okSaved = gone && !/保存失败/.test(fb);
            rec("materials", "finish-gen-save(保存到素材库)", okSaved ? "ok" : "ERR",
              `弹层关闭=${gone} 反馈="${fb.slice(0, 44)}" 请求=${sv.apiReqs.map((x) => x.method + " " + short(x.url)).join(" ").slice(0, 80)}`);
          }
        }
        await closeModal(cdp);
        await sleep(600);
      }
    }
  }

  // ── ⑨ 跨模块跳转(走 postMessage → 顶层页无 parent 时降级提示) ──
  console.log("\n═══ ⑨ 跨模块跳转 ═══");
  {
    for (const [ctl, label] of [["workflow:goto-statistics", "前往数据分析"], ["workflow:goto-viz", "前往科研绘图"]]) {
      const has = await evalTop(cdp, `!!document.querySelector('[data-control="${ctl}"]')`);
      if (!has) { rec("materials", label, "skip", "该格未渲染"); continue; }
      const direct = await evalTop(cdp, `(() => { const b = document.querySelector('[data-control="${ctl}"]'); if (b) { b.click(); return true; } return false; })()`);
      let fb = "";
      for (let i = 0; i < 8 && !fb; i++) { await sleep(400); fb = (await readToast(cdp)) || ""; }
      rec("materials", label, direct && fb ? "ok" : "DEAD",
        `点击=${direct} 反馈="${fb}"${/请从左侧导航/.test(fb) ? " ← 顶层页无 parent, 走降级提示(与「送编辑器」同一约束)" : ""}`);
      await sleep(3600); // 等 toast 过期, 免得压住后面的按钮
    }
  }

  // ── ⑩ 编排确认 ──
  console.log("\n═══ ⑩ 编排确认 ═══");
  {
    const hasBtn = await evalTop(cdp, `!!document.querySelector('[data-control="workflow:confirm-allocate"]')`);
    if (!hasBtn) rec("materials", "confirm-allocate(确认关联)", "skip", "编排弹层未打开(门禁: 需有未挂章素材)");
    else {
      const st = await evalTop(cdp, `(() => {
        const b = document.querySelector('[data-control="workflow:confirm-allocate"]');
        return { text: b.textContent.trim(), disabled: b.disabled };
      })()`);
      const r = await probeAction(cdp, '[data-control="workflow:confirm-allocate"]', { wait: 3000, keepOverlays: true });
      const posted = r.apiReqs.filter((x) => /adopt/.test(x.url) && x.method === "POST");
      rec("materials", "confirm-allocate(确认关联→adopt)", posted.length ? "ok" : (st?.disabled ? "gated" : "DEAD"),
        `文案="${st?.text}" 请求=${r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "无"}`);
    }
  }


  console.log("\n═══ ④ 智能生成计划 ═══");
  {
    if (!ALL) rec("materials", "smart-generate + 计划弹层 + 执行", "skip", "需真 LLM, 加 --all 才跑");
    else {
      const r = await probeAction(cdp, '[data-control="workflow:smart-generate"]', { wait: 5000 });
      rec("materials", "smart-generate(发起计划)", r.apiReqs.length ? "ok" : "DEAD",
        r.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "零请求");
      const plan = await waitFor(cdp, `!!document.querySelector('.modal-mask') && [...document.querySelectorAll('.modal-mask button')].some(b => /开始执行/.test(b.textContent))`, { timeout: 240000, every: 2500 });
      rec("materials", "计划弹层出现", plan ? "ok" : "ERR", plan ? "有「开始执行」按钮" : "240s 内未出现");
      if (plan) {
        // ⚠ 「重新生成」只在 `planDialog.state === 'failed'` 时渲染 —— 计划成功时它**根本不存在**。
        //   条件渲染下的"零请求"不是缺陷(与 open-gen-dialog 同一类), 报 skip 而不是 DEAD。
        const hasRegen = await evalTop(cdp, `!!document.querySelector('[data-control="workflow:regenerate-plan"]')`);
        if (!hasRegen) {
          rec("materials", "regenerate-plan(重新生成)", "skip", "计划生成成功 → 该按钮只在失败态渲染, 本次不出现");
        } else {
          const regen = await probeAction(cdp, '[data-control="workflow:regenerate-plan"]', { wait: 4000, keepOverlays: true });
          rec("materials", "regenerate-plan(重新生成)", regen.apiReqs.length ? "ok" : "DEAD",
            regen.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "零请求");
        }
        await waitFor(cdp, `!!document.querySelector('[data-control="workflow:confirm-plan"]')`, { timeout: 240000, every: 2500 });
        const exec = await probeAction(cdp, '[data-control="workflow:confirm-plan"]', { wait: 4000, keepOverlays: true });
        rec("materials", "confirm-plan(开始执行)", exec.apiReqs.length ? "ok" : "DEAD",
          exec.apiReqs.map((x) => `${x.method} ${short(x.url)}→${x.status}`).join(" ") || "零请求");
        // ⚠ 执行完必须**关掉计划弹层**: 它是全屏 mask, 留着会挡住后面所有小节,
        //   而后面多处按"文档里第一个 .modal-mask"取弹层 → 全部读到它(实测踩到)。
        //   `.modal-x` 在 `state === 'executing'` 时点不动(handler 里有守卫), 所以要等它跑完。
        let closed = false;
        for (let i = 0; i < 20 && !closed; i++) {
          await sleep(1500);
          closed = await evalTop(cdp, `(() => { const x = document.querySelector('.modal-mask .modal-x'); if (x) { x.click(); } return !document.querySelector('.modal-mask'); })()`);
        }
        rec("materials", "计划弹层可关闭(执行完不卡死)", closed ? "ok" : "ERR", closed ? "已关闭" : "30s 内关不掉(state 卡在 executing?)");
        await sleep(800);
      }
    }
  }

  console.log("\n════════ 汇总 ════════");
  const bad = rows.filter((r) => r.kind === "ERR" || r.kind === "DEAD");
  for (const r of rows) console.log(`${r.kind.padEnd(6)} ${r.action}`);
  console.log(bad.length ? `\n❌ ${bad.length} 项异常` : `\n✅ ${rows.length} 项全部通过`);
  // 退出码 —— 否则挂进门禁也拿不到失败信号(verify-ui.mjs 只看 code)。
  //   skip 不算失败(环境限制), ERR/DEAD 才算。
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error("探针异常:", e.message, e.stack?.split("\n")[1] ?? "");
} finally {
  await close();
}
