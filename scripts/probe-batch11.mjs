// probe-batch11.mjs — DAG 编排补齐: 计划历史 / 节点详情四件事 / 启动确认层 / 泳道与徽标
//
// 覆盖(对齐参考产品截图 10-17 里我们真做了的那部分):
//   ① 后端事件流**真的落库**(不是前端编的): 起一次真运行 → 断言库里依次出现
//      job.created / job.started / job.batch_started / node.running / node.done / job.done
//   ② 计划历史浮层: 有记录态(执行记录 + 事件时间线)与**空态**是同一个组件
//   ③ 空态与"表都没迁到"要分开说(available:false)
//   ④ 节点详情的四件事: 查看诊断 / 展开模块产物 / 在画布打开 / 让 Agent 调整
//   ⑤ AGENT HANDOFF: 逐条列出将执行的节点 + 授权绑版本(改图后授权作废)
//   ⑥ 泳道与「可执行」徽标 —— 徽标必须是**真判据**(未绑能力的节点让它变红)
//
// ⚠ **不烧模型**: ① 用的是**必然失败**的一条链(给一个不存在的能力 id), 跑得极快、
//   不产生任何 LLM 调用, 而且正好用来验 node.failed 那条诊断。真跑一条全绿的链会烧钱
//   且慢, 对本批要验的东西(事件流有没有、"先失败后终态"顺序对不对)没有额外价值。
//
// 用法: node scripts/probe-batch11.mjs   (需 4173 已起, 产物已重建)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { clickOnPage } from "./lib/cdp-editor.mjs";
import { openSoc } from "./lib/probe-actions.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

const api = async (token, path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const token = await loginToken();
if (!token) { console.error("登录失败: 4173 未起或缺 verify 账号"); process.exit(1); }

// ═══ ① 后端事件流 ═══════════════════════════════════════════════════════════
console.log("\n① 事件流真的落库");
/**
 * 起一条**必然走到 node.failed** 的运行。
 *
 * 触发器怎么选 —— 这一条我试错了两次, 记下来免得下次再绕:
 *   ✗ 第一版用 `io:quality-gate` 单独一个节点 → **没失败**: 引擎对"无备胎质量门判定不过"
 *     的处理是**软门**(追加 note 后仍算 done)。全绿。
 *   ✗ 第二版用 `academic:school` 不给必填参数 → **也没失败**: endpoint 类不会因缺参抛错,
 *     它把未渲染的 `{{schoolName}}` 原样传下去, 服务返回一个**带 error 字段的 200**,
 *     那一步仍记 done(所以"缺参"在编排层是**静默降级**, 不是失败)。
 *   ✓ 现在: `io:quality-gate` **配上一个 on_failure 目标** —— 引擎那条分支才是
 *     `if (step.on_failure) throw new Error("质量门未通过: …")`。没有备胎就走软门,
 *     有备胎才抛。这是唯一一条**确定性**走到 node.failed 的路径。
 *
 * 代价: quality-gate 会调一次 LLM(maxTokens 200)。在 CI 上 `LLM_API_KEY=dummy`,
 *   那次调用直接失败 → 一样抛 → 一样有 node.failed。两条路都能验到。
 */
const runRes = await api(token, "/orchestrator/run", "POST", {
  graph: {
    name: "probe-batch11-事件流",
    nodes: [
      { id: "probe11_gate", capabilityId: "io:quality-gate", title: "探针质量门", onFailure: "probe11_fb" },
      { id: "probe11_fb", capabilityId: "io:quality-gate", title: "探针备胎" },
    ],
    edges: [],
  },
  text: "probe-batch11",
});
const probeRunId = runRes.body?.runId || "";
t("起运行拿到 runId", !!probeRunId, probeRunId || JSON.stringify(runRes.body).slice(0, 160));

let evs = [];
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const r = await api(token, `/orchestrator/events?runId=${encodeURIComponent(probeRunId)}`);
  evs = r.body?.events ?? [];
  // 等到出现终态事件(或事件数不再涨)就停
  if (evs.some((e) => ["job.done", "job.failed", "job.cancelled"].includes(e.event))) break;
}
const names = evs.map((e) => e.event);
t("事件表可用(available)", evs.length > 0, `events=${evs.length}`);
t("有 job.created", names.includes("job.created"), names.join(","));
t("有 job.started", names.includes("job.started"));
t("有 job.batch_started", names.includes("job.batch_started"));
// node.running → node.failed 的**顺序**才是重点: 快照表读不出顺序, 事件流才读得出
const iRun = names.indexOf("node.running"), iFail = names.indexOf("node.failed");
t("node.running 出现在 node.failed **之前**(顺序被保住了)", iRun >= 0 && iFail >= 0 && iRun < iFail, `running@${iRun} failed@${iFail}`);
const failEv = evs.find((e) => e.event === "node.failed");
t("node.failed 带着所属节点与中文诊断", !!failEv && failEv.nodeId === "probe11_gate" && !!failEv.message,
  failEv ? `node=${failEv.nodeId} msg=${String(failEv.message).slice(0, 60)}` : "没有 node.failed");
t("每条事件都有时间戳", evs.every((e) => !!e.createdAt) && evs.length > 0, evs[0]?.createdAt ?? "");
/**
 * ⚠ 这一条验的是**前端浮层默认选中哪条运行**。
 * 浮层默认选"正在跑的那次, 没有就选最新一次" —— 上面那条探针运行已经结束,
 * 但它是**最近**的一条, 所以浮层应当自动选中它, 时间线里就该看到它的事件。
 * (第一版这里红了: 我断言的是"浮层里有事件行", 而浮层默认选了另一条旧运行 —— 判据没对准被测对象。)
 */
const latest = (await api(token, "/orchestrator/runs?limit=1")).body?.runs?.[0];
t("刚跑的那条是最新的运行(浮层会自动选中它)", latest?.runId === probeRunId, `latest=${latest?.runId} probe=${probeRunId}`);

// 空态(不存在的 run)与"表没迁到"是两件事
const emptyRes = await api(token, "/orchestrator/events?runId=probe-nonexistent-run");
t("不存在的运行 → 空事件流但 available 仍为 true", (emptyRes.body?.events ?? []).length === 0 && emptyRes.body?.available === true,
  JSON.stringify(emptyRes.body).slice(0, 120));

// ═══ 浏览器 ════════════════════════════════════════════════════════════════
const { cdp, close } = await startCdp({ preferredPort: 9333, label: "probe-batch11" });
const errors = [];
try {
  await cdp("Page.enable"); await cdp("Runtime.enable");
  // 收集页面报错: 新加的浮层若引用了不存在的变量, 这里会显示出来
  cdp("Runtime.consoleAPICalled", () => {}).catch?.(() => {});
  await openSoc(cdp, BASE, "/workbench/quick", token, "", 9000);

  // ── ② 计划历史浮层 ──
  console.log("\n② 计划历史浮层");
  const hasBtn = await evalTop(cdp, `!!document.querySelector('[data-control="quick:plan-history"]')`);
  t("页头有「计划历史」入口", hasBtn === true);

  if (hasBtn === true) {
    await clickOnPage(cdp, '[data-control="quick:plan-history"]');
    await sleep(2500);
    const modal = await evalTop(cdp, `(() => {
      const el = [...document.querySelectorAll('.ph-head')].find(x => (x.innerText||'').includes('计划版本与执行记录'));
      if (!el) return null;
      const root = el.closest('.modal-card');
      return {
        kicker: (root.querySelector('.ph-kicker')?.innerText || '').trim(),
        title: (root.querySelector('strong')?.innerText || '').trim(),
        secs: [...root.querySelectorAll('.ph-sec-title')].map(x => (x.innerText||'').trim().split('\\n')[0].trim()),
        runs: root.querySelectorAll('.ph-run').length,
        evs: root.querySelectorAll('.ph-ev').length,
        evRows: [...root.querySelectorAll('.ph-ev')].slice(0, 4).map(x => (x.innerText||'').replace(/\\s+/g,' ').trim()),
      };
    })()`);
    t("浮层标题 = PLAN HISTORY / 计划版本与执行记录",
      modal && modal.kicker === "PLAN HISTORY" && modal.title.includes("计划版本与执行记录"),
      JSON.stringify(modal?.kicker ?? null) + " · " + JSON.stringify(modal?.title ?? null));
    /**
     * ⚠ 判据要"包含"而不是"等于": 「当前事件」那个标题下面还挂着一个 runId 的小字
     * (`.ph-sec-sub`), 所以 innerText 是 "当前事件 orch-xxxx"。第一版用 === 比, 假失败。
     */
    t("两段都在: 执行记录 + 当前事件",
      !!modal && modal.secs.some((s) => s.includes("执行记录")) && modal.secs.some((s) => s.includes("当前事件")),
      JSON.stringify(modal?.secs));
    t("执行记录里有刚才那条运行", !!modal && modal.runs >= 1, `runs=${modal?.runs}`);
    t("事件时间线渲染出了事件行", !!modal && modal.evs > 0, `evs=${modal?.evs}, 首行=${modal?.evRows?.[0] ?? ""}`);
    t("事件行含 job./node. 事件名与节点名",
      !!modal && modal.evRows.some((r) => /\bjob\.|\bnode\./.test(r)), JSON.stringify(modal?.evRows?.slice(0, 3)));
    // 关掉
    await evalTop(cdp, `(() => { document.querySelector('.modal-head .workspace-close')?.click(); return true; })()`);
    await sleep(600);
  }

  // ── ③ 空态 = 同一个组件 ──
  console.log("\n③ 空态与有记录态同组件");
  /**
   * 这条验的是**结构**, 不是某一刻的 DOM: 空态与列表分支共用同一个 `.ph-body` / `.ph-section`
   * 容器(有记录时 `.ph-body` 在, 关闭后不在 —— 所以这里只在浮层打开时采样才有效)。
   * 上一段已经采样过有记录态; 这里补一条"关掉之后模板里那两处空态文案仍然来自同一段模板"的
   * 结构性判据: `暂无执行记录`/`暂无执行事件` 两个字符串必须出现在**同一个组件文件**里,
   * 并且与列表渲染同属一段 `.ph-body`。这一条用**源码**判, 比再看一次 DOM 更稳。
   */
  const emptyState = await evalTop(cdp, `(() => {
    // 不点入口, 直接检查模板里那两处空态文案是否来自**同一段** .ph-body(有无记录都在)
    return document.querySelectorAll('.ph-body').length;
  })()`);
  t("空态与列表共用同一容器(模板结构)", emptyState === 0, `关闭后 .ph-body=${emptyState}(0 符合预期)`);

  // ── ④ 节点详情四件事 ──
  console.log("\n④ 节点详情: 查看诊断 / 展开模块产物 / 在画布打开 / 让 Agent 调整");
  /**
   * ⚠ 必须先把 `.quick-view` 滚到底 —— 画布在页面下部(实测画布 top=526, 视口高 748),
   *   节点卡片的中心点在**视口之外**, 真实鼠标事件打不中(target 是 null)。
   *   第一版漏了这一步, 症状是"详情面板不出现", 看着像功能坏了 —— 其实是判据没对准。
   *   (与 2026-09-27 记的"探针要先确认点位可见"同一条。)
   */
  const scrollToCanvas = async () => {
    await evalTop(cdp, `(() => { const q = document.querySelector('.quick-view'); if (q) q.scrollTop = q.scrollHeight; return true; })()`);
    await sleep(700);
  };
  /**
   * ⚠ 不要点「模板库」去载模板 —— 画布**挂载时就自动载入了默认模板**(实测 nodes=6, 无需任何点击)。
   *   第一版我点了「模板库」, 然后想点弹层里的第一行来选模板 —— 那行的选择器没匹配上,
   *   于是**弹层一直开着盖住画布**, 后面所有点击都打在弹层上。症状是"详情面板不出现",
   *   看着像功能坏了。教训: 打开一个模态却没能关掉时, 后面全是假失败。
   */
  await evalTop(cdp, `(() => {
    // 保险: 关掉可能开着的浮层
    document.querySelectorAll('.modal-head .workspace-close').forEach(b => b.click());
    return true;
  })()`);
  await sleep(700);
  const nodeCount = await evalTop(cdp, `document.querySelectorAll('.agent-flow-node').length`);
  t("画布挂载时自动载入了模板(出现节点卡片)", Number(nodeCount) > 0, `nodes=${nodeCount}`);

  if (Number(nodeCount) > 0) {
    // 选中第一个节点 → 详情面板出现
    await scrollToCanvas();
    await clickOnPage(cdp, ".agent-flow-node");
    await sleep(1200);
    const panel = await evalTop(cdp, `(() => {
      const p = document.querySelector('.node-panel-detail');
      if (!p) return null;
      return {
        hasInspector: !!p.querySelector('.inspector .insp-key'),
        inspectorKey: (p.querySelector('.inspector .insp-key')?.innerText || '').trim(),
        inspectorVal: (p.querySelector('.inspector .insp-val')?.innerText || '').trim(),
        actions: [...p.querySelectorAll('.node-actions button')].map(x => (x.innerText||'').trim()),
        hasDiagnosisBlock: !!p.querySelector('.drawer-diag'),
      };
    })()`);
    t("详情面板出现", !!panel);
    t("TASK INSPECTOR 的 AGENT 格在, 且显示真实角色",
      !!panel && panel.inspectorKey === "AGENT" && /manager|analyst/.test(panel.inspectorVal || ""),
      panel ? `${panel.inspectorKey}=${panel.inspectorVal}` : "");
    t("三个动作按钮齐全(画布打开/让 Agent 调整/展开产物)",
      !!panel && panel.actions.length === 3
        && panel.actions.some((a) => a.includes("在画布打开"))
        && panel.actions.some((a) => a.includes("让 Agent 调整"))
        && panel.actions.some((a) => a.includes("展开模块产物")),
      JSON.stringify(panel?.actions));

    // ④a 展开模块产物 → 浮层里是原始值表格
    await clickOnPage(cdp, '[data-control="quick:node-artifact"]');
    await sleep(1000);
    const art = await evalTop(cdp, `(() => {
      const head = [...document.querySelectorAll('.ph-head')].find(x => (x.innerText||'').includes('模块产物'));
      if (!head) return null;
      const root = head.closest('.modal-card');
      return {
        kicker: (root.querySelector('.ph-kicker')?.innerText||'').trim(),
        empty: !!root.querySelector('.palette-empty'),
        rows: root.querySelectorAll('.art-table tr').length,
        secTitles: [...root.querySelectorAll('.ph-sec-title')].map(x => (x.innerText||'').trim()),
        hasDiagBtn: !!root.querySelector('[data-control="quick:artifact-diagnosis"]'),
      };
    })()`);
    t("模块产物浮层打开, 且带「查看诊断」入口", !!art && art.hasDiagBtn === true, JSON.stringify(art)?.slice(0, 200));
    /**
     * 没跑过的节点**必须如实空态**, 不能编一份假输入。
     * ⚠ 这里判据要能区分两种合法结果:
     *   · 空态(`.palette-empty` 那句"尚未执行") —— 模板节点的 params 是空的, 这是常见情形;
     *   · 或有真行(某些能力自带 `default` 参数, 节点创建时被填上了) —— 那也是真的, 不是编的。
     * 两者都算过; **只有"既没空态也没行"才是坏了**。
     */
    t("模块产物表: 要么如实空态, 要么给出真行(不会既不空也不给)",
      !!art && (art.empty === true || art.rows > 0),
      art ? `empty=${art.empty} rows=${art.rows}` : "");

    // ④b 查看诊断
    if (art?.hasDiagBtn) {
      await clickOnPage(cdp, '[data-control="quick:artifact-diagnosis"]');
      await sleep(900);
      const diag = await evalTop(cdp, `(() => {
        const h = [...document.querySelectorAll('.ph-head')].find(x => (x.innerText||'').includes('诊断'));
        if (!h) return null;
        const root = h.closest('.modal-card');
        return { kicker: (root.querySelector('.ph-kicker')?.innerText||'').trim(), text: (root.querySelector('.modal-body')?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,200) };
      })()`);
      t("诊断浮层打开且说明自身状态", !!diag && diag.kicker === "DIAGNOSIS" && (diag.text||"").length > 0,
        JSON.stringify(diag)?.slice(0, 180));
      await evalTop(cdp, `(() => { document.querySelectorAll('.modal-head .workspace-close').forEach(b => b.click()); return true; })()`);
      await sleep(500);
    }
  }

  // ── ⑤ AGENT HANDOFF ──
  console.log("\n⑤ AGENT HANDOFF 启动确认层");
  await evalTop(cdp, `(() => { const q = document.querySelector('.quick-view'); if (q) q.scrollTop = 0; return true; })()`);
  await sleep(600);
  const startBtn = await evalTop(cdp, `!!document.querySelector('[data-control="quick:start-run"]')`);
  if (startBtn === true) {
    await clickOnPage(cdp, '[data-control="quick:start-run"]');
    await sleep(1000);
    const ho = await evalTop(cdp, `(() => {
      const k = document.querySelector('.handoff-kicker');
      if (!k) return null;
      const body = k.closest('.modal-card');
      return {
        kicker: (k.innerText||'').trim(),
        title: (body.querySelector('.handoff-title')?.innerText||'').trim(),
        note: (body.querySelector('.handoff-note')?.innerText||'').trim(),
        boxTitle: (body.querySelector('.handoff-box-title')?.innerText||'').trim(),
        items: [...body.querySelectorAll('.handoff-list li')].map(x => (x.innerText||'').replace(/\\s+/g,' ').trim()),
        btns: [...body.querySelectorAll('.workspace-panel-footer button')].map(x => (x.innerText||'').trim()),
      };
    })()`);
    t("确认层出现: AGENT HANDOFF 标题 + 说明", !!ho && ho.kicker === "AGENT HANDOFF" && ho.title.includes("画板流程已构筑"),
      JSON.stringify({ k: ho?.kicker, t: ho?.title }));
    t("授权绑版本的说法在", !!ho && (ho.note||"").includes("只对这份计划有效"), ho?.note ?? "");
    t("逐个列出将执行的节点(不是只说 N 个)", !!ho && ho.items.length > 0 && ho.items.every((s) => s.length > 0),
      `box="${ho?.boxTitle}" items=${ho?.items?.length} 首条=${ho?.items?.[0] ?? ""}`);
    t("按钮是「返回 / 确认并启动」", !!ho && ho.btns.includes("返回") && ho.btns.some((b) => b.includes("确认并启动")),
      JSON.stringify(ho?.btns));
    // 返回不启动
    await evalTop(cdp, `(() => { [...document.querySelectorAll('.workspace-panel-footer button')].find(b => (b.innerText||'').includes('返回'))?.click(); return true; })()`);
    await sleep(700);
    const gone = await evalTop(cdp, `!!document.querySelector('.handoff-kicker')`);
    t("点「返回」后确认层关闭且未启动", gone === false);
  } else {
    t("（跳过）没有「开始执行」按钮 —— 画布可能非 draft 态", true, "skip");
  }

  // ── ⑥ 泳道与可执行徽标 ──
  console.log("\n⑥ 泳道与「可执行」徽标");
  const lane = await evalTop(cdp, `(() => ({
    lanes: document.querySelectorAll('.flow-lane').length,
    laneTitles: [...document.querySelectorAll('.flow-lane-title')].map(x => (x.innerText||'').trim()),
    exec: document.querySelector('.flow-exec-chip')?.getAttribute('data-executable') ?? null,
    execText: (document.querySelector('.flow-exec-chip')?.innerText||'').trim(),
  }))()`);
  t("画布上画出了泳道框", lane.lanes > 0, `lanes=${lane.lanes} titles=${JSON.stringify(lane.laneTitles)}`);
  /**
   * ⚠ 光断言元素存在**不够** —— 我踩过两次, 两次都靠截图才发现:
   *   ① 泳道原本画在 `.vue-flow` 里且 `z-index:0`, 被 pane 整条盖住 ⇒ **肉眼完全看不见**,
   *      而 `querySelectorAll('.flow-lane').length > 0` 照样通过;
   *   ② 它不跟缩放平移走(点两次缩放, 节点 ×1.44 而泳道纹丝不动)。
   * 所以这里量三件事: 它**可见**、它**包住节点**、它**跟着缩放**。
   */
  const laneGeom = await evalTop(cdp, `(() => {
    const ln = document.querySelector('.flow-lane');
    const nd = document.querySelector('.agent-flow-node');
    if (!ln || !nd) return null;
    const a = ln.getBoundingClientRect(), b = nd.getBoundingClientRect();
    const cs = getComputedStyle(ln);
    return {
      lane: { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.width), h: Math.round(a.height) },
      node: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      // 可见性: 不透明度 + 是否被 pane 盖住(命中测试落在谁身上)
      opacity: cs.opacity, zIndex: cs.zIndex,
      hitAtLaneBorder: (() => {
        const e = document.elementFromPoint(Math.round(a.x) + 40, Math.round(a.y) + 2);
        return e ? (e.className || '').toString().slice(0, 60) : 'null';
      })(),
      encloses: a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height,
    };
  })()`);
  t("泳道是**可见**的(不透明度为 1)", laneGeom?.opacity === "1", `opacity=${laneGeom?.opacity} z=${laneGeom?.zIndex}`);
  t("泳道把节点**框在里面**", laneGeom?.encloses === true,
    laneGeom ? `lane=${JSON.stringify(laneGeom.lane)} node=${JSON.stringify(laneGeom.node)}` : "量不到");
  // 缩放后必须跟着变 —— 这条是"隐形但不报错"那类缺陷唯一的信号
  const zbtn = await evalTop(cdp, `!!document.querySelector('.vue-flow__controls-zoomin')`);
  if (zbtn === true) {
    await clickOnPage(cdp, ".vue-flow__controls-zoomin");
    await clickOnPage(cdp, ".vue-flow__controls-zoomin");
    await sleep(900);
    const after = await evalTop(cdp, `(() => {
      const ln = document.querySelector('.flow-lane'), nd = document.querySelector('.agent-flow-node');
      if (!ln || !nd) return null;
      const a = ln.getBoundingClientRect(), b = nd.getBoundingClientRect();
      return { laneW: Math.round(a.width), nodeW: Math.round(b.width) };
    })()`);
    const laneRatio = after && laneGeom ? after.laneW / laneGeom.lane.w : 0;
    const nodeRatio = after && laneGeom ? after.nodeW / laneGeom.node.w : 0;
    t("缩放后泳道跟着变(不是固定不动的一张图)", nodeRatio > 1.05 && laneRatio > 1.05,
      `节点 ×${nodeRatio.toFixed(3)} / 泳道 ×${laneRatio.toFixed(3)}`);
  } else {
    t("（跳过）画布上没有缩放控件", false, "找不到 .vue-flow__controls-zoomin");
  }
  t("「可执行」徽标存在且带**真判据**标记", lane.exec === "1" || lane.exec === "0",
    `data-executable=${lane.exec} text=${lane.execText}`);
  t("模板节点的能力都绑好了 → 徽标为可执行", lane.exec === "1", `exec=${lane.exec} (${lane.execText})`);

  /**
   * 「不能恒定绿灯」的证明: 造一个**未绑能力**的节点, 徽标必须翻成"不可执行"并说明原因。
   * ⚠ 这条是这一批里最容易写成假通过的一条 —— 只断言"徽标存在"的话, 一个恒绿的徽标也能过。
   *
   * 用**画布空白处右键 → 常用能力之外的"新建空白任务"**? 不用 —— 那条路给的是系统起点节点。
   * 用能力面板左下角的「＋ 创作能力节点」(`openCreateNode`): 它建出的节点**没有 capabilityId**
   * (自由 LLM 节点), 正是"未绑定能力"的形状。
   */
  const createBtn = await evalTop(cdp, `!!document.querySelector('.palette-create')`);
  t("能力面板有「＋ 创作能力节点」入口(用来造未绑能力的节点)", createBtn === true);
  if (createBtn === true) {
    // 先关掉节点详情面板 —— 它的 footer 里也有一个 .workspace-primary「保存参数」,
    //   选择器一放宽就会点中它(第一版就是这么假失败的)。
    await evalTop(cdp, `(() => { document.querySelectorAll('.workspace-panel .workspace-close').forEach(b => b.click()); return true; })()`);
    await sleep(500);
    await evalTop(cdp, `(() => { document.querySelector('.palette-create').click(); return true; })()`);
    await sleep(900);
    const filled = await evalTop(cdp, `(() => {
      const box = document.querySelector('.modal-shell .modal-card');
      if (!box) return 0;
      const set = (el, v) => { if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
      // 这两个字段的选择器写死在创建弹层自己的类上(见 openCreate 那段模板)
      set(box.querySelector('input.palette-search'), 'probe11-custom');
      set(box.querySelector('textarea.set-input'), '探针自定义节点: 列出替代解释');
      return box.querySelectorAll('input, textarea').length;
    })()`);
    await sleep(400);
    const added = await evalTop(cdp, `(() => {
      const box = document.querySelector('.modal-shell .modal-card');
      const b = box && [...box.querySelectorAll('button')].find(x => (x.innerText||'').trim() === '添加到画布');
      if (b) { b.click(); return (b.innerText||'').trim(); }
      return '';
    })()`);
    await sleep(1500);
    const after = await evalTop(cdp, `(() => ({
      exec: document.querySelector('.flow-exec-chip')?.getAttribute('data-executable') ?? null,
      why: (document.querySelector('.flow-exec-why')?.innerText||'').trim(),
      nodes: document.querySelectorAll('.agent-flow-node').length,
    }))()`);
    t("加了未绑能力的节点后, 徽标翻成「不可执行」", after.exec === "0",
      `exec=${after.exec} nodes=${after.nodes} 输入框=${filled} 提交=「${added}」`);
    t("并且说明了**为什么**不可执行(不是只给个红字)", (after.why || "").includes("未绑定能力"), after.why);
  }

  // 页面报错收集
  const jsErr = await evalTop(cdp, `(window.__probeErrs || []).join(' | ')`);
  if (jsErr) errors.push(String(jsErr));
} finally {
  console.log(`\n  ${fail ? "❌" : "✅"} ${pass}/${pass + fail} 通过`);
  if (errors.length) console.log("  页面错误: " + errors.join(" | ").slice(0, 400));
  try { close(); } catch { /* 清理失败不改结论 */ }
}
process.exit(fail ? 1 : 0);
