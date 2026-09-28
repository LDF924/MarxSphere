// probe-batch15.mjs — 模板参数在画布上真的接对了
//
// 由来(2026-09-28 用户: "要修"): 从"tpl_empirical 有两个参数名写错"查起, 挖出**三个**死键
//   + 一个更根本的缺陷。这个探针验的就是"改完之后, 画布上真的能填、真的能跑"。
//
// 覆盖:
//   ① 载入「实证研究流程」模板 → 每个节点的参数键都是该能力**声明过的字段**
//      (死键判据: 拿节点参数键去能力表的 fields 里反查 —— 不是数有没有报错)
//   ①b **模板没给参数的字段也要出现在画布上** —— 否则用户想填都没地方填
//      (修前: 参数行按 params 的键渲染, 模板没给的字段整行不存在)
//   ② 载入「重检索」模板 → 政策检索节点的键是 keyword 不是 query
//   ③ 真跑一步端点型节点, 断言请求体里的参数**不是 [未渲染:...]**
//      ⚠ 只断言"请求发出去了"证明不了参数对 —— 端点收到 "[未渲染:{{tool}}]" 也会回 400,
//        而那看起来像"参数填错了"。
//
// ⚠ 烧钱提示: ③ 会真跑一次端点(统计/描述)。挑的是不需要 LLM 的那类; 若环境里没有
//   数据文件, 它会在参数校验之前失败 —— 那时断言的是**请求体本身**, 不是执行结果。
//
// 用法: node scripts/probe-batch15.mjs   (需 4173 已起, soc 产物已重建)
import { startCdp, loginToken, sleep, evalTop } from "./lib/cdp-editor.mjs";
import { openSoc } from "./lib/probe-actions.mjs";

const BASE = process.env.API_BASE || "http://127.0.0.1:4173";
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${n}${ex ? " — " + ex : ""}`); ok ? pass++ : fail++; };

const api = async (token, p, method = "GET", body) => {
  const r = await fetch(`${BASE}/api${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const token = await loginToken();
if (!token) { console.error("登录失败: 4173 未起或缺 verify 账号"); process.exit(1); }

// ── 判据源: 真实能力表(领域侧的真源) ──
const capsRes = await api(token, "/orchestrator/capabilities");
const caps = capsRes.body?.capabilities ?? [];
const byId = new Map(caps.map((c) => [c.id, c]));
t("前置: 拿到能力表", caps.length > 50, `${caps.length} 项`);

const { cdp, close } = await startCdp({ preferredPort: 9365, label: "batch15" });
try {
  await openSoc(cdp, BASE, "/workbench/quick", token, "", 9000);
  await evalTop(cdp, `(() => { document.querySelectorAll('.assistant-close,.modal-x').forEach(b => b.click()); return true; })()`);
  await sleep(800);

  /**
   * 打开模板库 → 点模板卡 → 回读画布节点。
   *
   * ⚠ 整张卡就是载入按钮(`@click="applyTemplate(...)"`), 卡片里**没有**单独的"使用"按钮 ——
   *   第一版按 /载入|使用|应用/ 找按钮, 结果是 `no-button` 假失败。找按钮前先看模板长什么样。
   */
  const loadTemplate = async (namePart) => {
    await evalTop(cdp, `(() => { const b=[...document.querySelectorAll('.hdr-btn')].find(x=>(x.innerText||'').includes('模板库')); if(b) b.click(); return !!b; })()`);
    await sleep(1200);
    const picked = await evalTop(cdp, `(() => {
      const card = [...document.querySelectorAll('.tpl-card')].find(x => (x.innerText||'').includes(${JSON.stringify(namePart)}));
      if (!card) return "missing:" + [...document.querySelectorAll('.tpl-card')].map(c => (c.innerText||'').split("\\n")[0]).join("/");
      card.click(); return "clicked";
    })()`);
    await sleep(1800);
    return picked;
  };

  /** 从画布上把节点参数读回来(以界面上真实存在的为准, 不是读前端源码) */
  const readCanvasNodes = () => evalTop(cdp, `(() => {
    // 画布节点渲染在 .vue-flow__node 里, 标题与参数行都是文本
    return [...document.querySelectorAll('.vue-flow__node')].map(n => ({ text: (n.innerText||'').replace(/\\s+/g,' ').trim() }));
  })()`);

  /**
   * ⚠ **节点参数不在节点卡上** —— 卡上只有标题与输入/输出端口标签。
   *   参数填在右侧抽屉里, 且**只有选中节点后**才渲染(`v-if="selectedNode"` 的那一段)。
   *   第一版在节点卡上找"方法"这个 label, 必然找不到 —— 又是一次"判据看不到被测对象"。
   *   所以下断言前必须先点节点把它选中。
   */
  const selectNodeByTitle = (titlePart) => evalTop(cdp, `(() => {
    const n = [...document.querySelectorAll('.vue-flow__node')].find(x => (x.innerText||'').includes(${JSON.stringify(titlePart)}));
    if (!n) return "missing";
    n.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return "clicked";
  })()`);

  /** 右侧抽屉里渲染出来的参数行(用真实 DOM 的 label, 不是前端源码) */
  const readParamPanel = () => evalTop(cdp, `(() => {
    const labels = [...document.querySelectorAll('.workspace-field span')].map(x => (x.innerText||'').trim());
    return { labels, hasParamsSection: !!document.querySelector('.panel-section-title') };
  })()`);

  /** 右侧"高级: 直接编辑全部参数(JSON)"里显示的就是这个节点**真实带着的**参数 */
  const readParamJson = () => evalTop(cdp, `(() => {
    const ta = document.querySelector('.json-editor');
    if (!ta) return null;
    try { return JSON.parse(ta.value); } catch { return { __parse_error: ta.value.slice(0, 200) }; }
  })()`);

  // ═══ ① 实证研究流程: 参数键必须是被声明过的字段 ═══
  console.log("\n① 实证研究流程模板");
  const loaded = await loadTemplate("实证");
  t("模板能载入画布", loaded === "clicked", String(loaded));
  await sleep(1200);
  const nodes = await readCanvasNodes();
  t("画布上有节点", Array.isArray(nodes) && nodes.length >= 5, `${nodes?.length} 个`);
  const allText = (nodes ?? []).map((n) => n.text).join(" | ");
  console.log(`     画布: ${allText.slice(0, 240)}`);
  t("**没有 [未渲染:...] 漏到界面上**", !/未渲染/.test(allText), (allText.match(/未渲染[^|]{0,40}/) ?? [])[0] ?? "");

  /**
   * ①b 参数面板 + 节点真实参数。
   *
   * ⚠ 面板上的**标签**来自 `cap.fields`(与 node.params 无关), 所以"面板显示了什么字段"
   *   证明不了参数对不对 —— 要读的是"高级"里那份 JSON(那才是真正会发给端的值)。
   */
  const sel = await selectNodeByTitle("描述统计");
  t("能选中节点", sel === "clicked", String(sel));
  await sleep(800);
  const panel = await readParamPanel();
  t("选中后出现参数区且列出该能力的字段",
    panel?.hasParamsSection === true && (panel?.labels ?? []).length >= 2,
    JSON.stringify(panel).slice(0, 200));
  const pjson = await readParamJson();
  t("读得到节点真实参数(高级 JSON)", pjson && typeof pjson === "object", JSON.stringify(pjson).slice(0, 160));
  /**
   * ⚠ 关键判据: 节点参数里要**包含该能力的全部字段**, 不只是模板自己给的那几个。
   *
   * 这条是从一次**假验证**里逼出来的。我先后写错过两版判据:
   *   · v1 断言"面板上能看到字段 label" —— 面板标签来自 `cap.fields`, 与 node.params 无关, 恒真;
   *   · v2 断言"node.params 里没有裸占位符" —— 而裸占位符在**能力注册表的模板 body** 里,
   *     不在 node.params 上; 旧代码下 node.params 干脆没有 fileId 这个键, 于是又恒真。
   * 两版都通过, 而反向验证(把改动撤掉)也通过 —— 那就等于没验。
   *
   * 真正的差别在这里: 模板给的是 `{tool:"describe"}`, 而注册表模板 body 是
   *   `{ fileId: "{{fileId}}", tool: "{{tool}}" }`。合并时才看得出:
   *   · 旧(二选一): body = { fileId: "{{fileId}}", tool: "describe" } —— 裸名原样发给端点;
   *   · 新(合并)  : body = { fileId: "",           tool: "describe" } —— 取值, 空就是空。
   * 所以判据是"**所有声明字段都在 params 里**"(缺哪个就说明它没被补上)。
   */
  const capFields = (byId.get("stat:run")?.fields ?? []).map((f) => f.name);
  const missingKeys = capFields.filter((f) => !(f in (pjson ?? {})));
  t("**节点参数包含该能力的全部字段**(模板没给的也补上, 否则端点收到裸占位符)",
    missingKeys.length === 0,
    missingKeys.length ? `缺: ${missingKeys.join(", ")} — 实际 ${JSON.stringify(pjson)}` : `参数: ${JSON.stringify(pjson)}`);
  t("模板自己给的参数**没被默认值盖掉**(tool 仍是 describe, 不是默认的 describe 之外的)",
    pjson?.tool === "describe", `tool=${pjson?.tool}`);

  // ═══ ② 多源检索汇编: 政策检索的键是 keyword ═══
  //
  // ⚠ 用**模板全名**匹配, 不用一个词。第一版传 "检索" —— 而 `applyTemplate` 存的是
  //   **模板 id**, 再载回画布时匹配的是卡片的可见文本; "检索"这种子串在多个模板里都出现,
  //   加上上一次载入的节点还在画布上, 就出现了"载入成功但画布上找不到政策节点"的假失败。
  console.log("\n② 多源检索汇编模板(政策检索节点)");
  await evalTop(cdp, `(() => { document.querySelectorAll('.modal-x,.assistant-close').forEach(b => b.click()); return true; })()`);
  await sleep(600);
  const loaded2 = await loadTemplate("多源检索汇编");
  t("模板能载入画布", loaded2 === "clicked", String(loaded2));
  await sleep(1200);
  const nodes2 = await readCanvasNodes();
  const text2 = (nodes2 ?? []).map((n) => n.text).join(" | ");
  console.log(`     画布: ${text2.slice(0, 240)}`);
  t("画布上有政策检索节点", /政策/.test(text2), "");
  /**
   * 判据是**选中那个节点后抽屉里出现的字段 label** —— keyword 的中文 label 是"政策关键词"。
   * 修前模板给的是 `query`, 而该能力只声明了 keyword: 合并进 args 后 query 被忽略、
   * required 的 keyword 拿不到值 ⇒ 这一步**必然失败**(而不是"结果不准")。
   */
  const selPolicy = await selectNodeByTitle("政策文件检索");
  t("能选中政策检索节点", selPolicy === "clicked", String(selPolicy));
  await sleep(800);
  const panel2 = await readParamPanel();
  t("**面板上的字段是 keyword(不是写错的 query)**",
    (panel2?.labels ?? []).some((l) => l.includes("keyword") || l.includes("政策关键词")),
    `看到: ${(panel2?.labels ?? []).join(" / ") || "(空)"}`);

  // ═══ ③ 真跑一步: 请求体里的参数不能是未渲染标记 ═══
  console.log("\n③ 真发起一次: 请求体参数");
  /**
   * 用 API 直接起一张单节点图(描述统计), 带上画布会传的那种参数。
   * 观察点是**后端收到的 body** —— 通过 run 的 stepLog 错误信息反推:
   *   · 参数对 → 端点正常处理(可能因缺数据文件而失败, 但错误信息是业务性的);
   *   · 参数是 [未渲染:...] → 错误信息里带这几个字。
   */
  const run = await api(token, "/orchestrator/run", "POST", {
    graph: {
      id: "probe15", name: "probe15 参数传递",
      nodes: [{ id: "d1", capabilityId: "stat:run", title: "描述统计", params: { tool: "describe", fileId: "" } }],
      edges: [],
    },
    input: "probe15",
  });
  const runId = run.body?.runId ?? "";
  t("单节点运行起得来", !!runId, runId || JSON.stringify(run.body).slice(0, 160));
  let log = [];
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const p = await api(token, `/orchestrator/progress?runId=${runId}`);
    log = p.body?.stepLog ?? [];
    if (log.length && ["done", "failed", "waiting_input", "cancelled"].includes(log[0]?.status)) break;
  }
  const detail = JSON.stringify(log);
  t("**请求体里没有未渲染占位符**(有的话说明参数没接上)", !/未渲染/.test(detail),
    (detail.match(/未渲染[^"]{0,60}/) ?? [])[0] ?? "");
  t("这一步确实被执行了(有状态, 不是空转)", log.length > 0 && !!log[0]?.status,
    log[0] ? `${log[0].status}: ${String(log[0].error ?? "").slice(0, 90)}` : "无 stepLog");
} finally {
  console.log(`\n  ${fail ? "❌" : "✅"} ${pass}/${pass + fail} 通过`);
  try { close(); } catch { /* 清理失败不改结论 */ }
}
process.exit(fail ? 1 : 0);
