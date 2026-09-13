// scripts/verify-orchestrator-api.mjs — V415 编排器 HTTP 端到端验证(打真实 4173)
// 与 verify-orchestrator.mjs 的区别: 那个直接调 service(白盒), 这个走 HTTP(黑盒),
// 覆盖前端真正会用的四件事: 拉能力 → 拉模板 → 按图启动 → 轮询进度 → 控制(暂停/恢复/取消) → 落库可查
const BASE = process.env.ORCH_BASE || "http://127.0.0.1:4173";

let pass = 0, fail = 0;
const t = (name, ok, extra = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };

/**
 * V415: 带令牌 —— 部分能力(编辑器改写/大纲补全)的端点在 SAG_AUTH_ENABLED=true 时要求登录。
 * 令牌来源: ORCH_TOKEN 环境变量, 或由调用方注册一个探针账号后传进来。
 * 没有令牌也能跑: 那几项断言会自动跳过并在输出里说明(不静默, 见下方 sk()).
 */
const TOKEN = process.env.ORCH_TOKEN || "";
const skip = [];
const sk = (name, why) => { console.log(`  skip  ${name} — ${why}`); skip.push(name); };

async function j(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, data, text };
}

// ── 1. 能力清单(前端画布的节点来源) ──
const capsRes = await j("GET", "/api/orchestrator/capabilities");
t("GET /capabilities 200", capsRes.status === 200, `status=${capsRes.status}`);
const caps = capsRes.data?.capabilities ?? [];
const stats = capsRes.data?.stats ?? {};
console.log(`\n[1] 能力 ${stats.total} 项 | kind=${JSON.stringify(stats.byKind)}`);
console.log(`    分类=${JSON.stringify(stats.byCategory)}`);
t("能力数 ≥ 70", caps.length >= 70, `${caps.length}`);
t("能力项带 id/label/category/kind/risk", caps.every((c) => c.id && c.label && c.category && c.kind && c.risk));
t("能力项带可编辑字段(fields)或工具参数", caps.filter((c) => Array.isArray(c.fields) && c.fields.length).length > 20,
  `带 fields 的 ${caps.filter((c) => Array.isArray(c.fields) && c.fields.length).length} 项`);
t("含工作台端点能力(实证/统计/审稿/绘图…)",
  ["实证", "统计", "审稿", "绘图", "格式", "引文"].every((k) => caps.some((c) => c.category === k)));

// ── 2. 模板 ──
const tplRes = await j("GET", "/api/orchestrator/templates");
t("GET /templates 200", tplRes.status === 200, `status=${tplRes.status}`);
const tpls = tplRes.data?.templates ?? [];
console.log(`\n[2] 模板 ${tpls.length} 条: ${tpls.map((x) => x.name).join(" / ")}`);
t("模板数 ≥ 13", tpls.length >= 13, `${tpls.length}`);
t("每个模板都有可执行图", tpls.every((x) => x.graph?.nodes?.length > 0));
t("模板节点引用的能力都真实存在",
  tpls.every((x) => x.graph.nodes.every((n) => !n.capabilityId || caps.some((c) => c.id === n.capabilityId))),
  (() => {
    const bad = [];
    for (const x of tpls) for (const n of x.graph.nodes) {
      if (n.capabilityId && !caps.some((c) => c.id === n.capabilityId)) bad.push(`${x.id}:${n.id}→${n.capabilityId}`);
    }
    return bad.slice(0, 5).join(",");
  })());

// ── 3. 用模板启动(这是前端"选个模板就开始"的路径) ──
// 选文献综述: 步骤少、依赖清晰, 且有个 user_input 澄清节点可验证挂起/提交
const lit = tpls.find((x) => x.id === "tpl_lit_review");
const runRes = await j("POST", "/api/orchestrator/run", { templateId: "tpl_lit_review", input: "数字普惠金融对中小企业融资约束的影响" });
t("POST /run 200", runRes.status === 200, `status=${runRes.status} ${runRes.text?.slice(0, 120)}`);
const runId = runRes.data?.runId;
t("返回 runId", !!runId, runId ?? "");
t("返回执行顺序(order)", Array.isArray(runRes.data?.order) && runRes.data.order.length > 0, JSON.stringify(runRes.data?.order ?? []));
console.log(`\n[3] 启动模板 ${lit?.name}: runId=${runId} order=${(runRes.data?.order ?? []).join(" → ")}`);

// ── 4. 进度轮询 ──
let prog = null;
{
  const deadline = Date.now() + 60_000;
  do {
    await new Promise((r) => setTimeout(r, 1500));
    const p = await j("GET", `/api/orchestrator/progress?runId=${encodeURIComponent(runId)}`);
    prog = p.data;
  } while (!["waiting_input", "done", "failed", "cancelled"].includes(prog?.status) && Date.now() < deadline);
}
console.log(`\n[4] 进度 status=${prog?.status} source=${prog?.source}`);
t("进度可查", !!prog?.ok, JSON.stringify(prog)?.slice(0, 120));
t("模板第一个节点是澄清节点 → 运行挂起等输入",
  prog?.status === "waiting_input" || prog?.status === "done",
  `status=${prog?.status}`);
const waitStep = (prog?.stepLog ?? []).find((s) => s.status === "waiting_input" || s.waitingFields?.length);
if (waitStep) {
  console.log(`    等待字段: ${(waitStep.waitingFields ?? []).map((f) => f.name).join(",")}`);
  t("挂起节点带等待字段(前端据此弹表单)", (waitStep.waitingFields ?? []).length > 0);
}

// ── 5. 提交输入 → 继续 ──
if (prog?.status === "waiting_input") {
  const inp = await j("POST", "/api/orchestrator/control", {
    runId, action: "input",
    values: { topic: "数字普惠金融对中小企业融资约束的影响", years: "近5年", focus: "机制" },
  });
  t("POST /control input 200", inp.status === 200, `${inp.status} ${inp.text?.slice(0, 100)}`);
}

// ── 6. 暂停 / 恢复 ──
await new Promise((r) => setTimeout(r, 2000));
const pauseRes = await j("POST", "/api/orchestrator/control", { runId, action: "pause" });
const pausable = pauseRes.status === 200;
t("POST /control pause 可用(或运行已结束)", pausable || /已结束|不存在|不在运行中/.test(pauseRes.data?.error?.message ?? ""),
  `${pauseRes.status} ${pauseRes.data?.error?.message ?? ""}`);
if (pausable) {
  await new Promise((r) => setTimeout(r, 1500));
  const afterPause = (await j("GET", `/api/orchestrator/progress?runId=${runId}`)).data;
  t("暂停后状态落库为 paused", afterPause?.status === "paused", `status=${afterPause?.status}/${afterPause?.source}`);
  const resumeRes = await j("POST", "/api/orchestrator/control", { runId, action: "resume" });
  t("POST /control resume 200", resumeRes.status === 200, `${resumeRes.status} ${resumeRes.data?.error?.message ?? ""}`);
}

// ── 7. 跑到终态 ──
// 等待上限按墙钟算(240 秒), 不按轮询次数 —— 之前写死 80 次 × 1.5s = 120s, 而这条链要跑
// 5 次 LLM(实测 150-240s), 于是"等够"的假失败掩盖了真实结果。
let final = null;
{
  const deadline = Date.now() + 240_000;
  do {
    await new Promise((r) => setTimeout(r, 1500));
    final = (await j("GET", `/api/orchestrator/progress?runId=${runId}`)).data;
  } while (!["done", "failed", "cancelled"].includes(final?.status) && Date.now() < deadline);
}
console.log(`\n[7] 终态 status=${final?.status}`);
console.log(`    steps: ${(final?.stepLog ?? []).map((s) => `${s.stepId}:${s.status}`).join(", ")}`);
t("运行到达终态(未永久卡在 running)", ["done", "failed"].includes(final?.status), `status=${final?.status}`);
t("有步骤产出", Object.keys(final?.outputs ?? {}).length > 0, `产出 ${Object.keys(final?.outputs ?? {}).length} 个`);
// 依赖传递的证据: 下游步骤记录了 inputsFrom
const withFrom = (final?.stepLog ?? []).filter((s) => (s.inputsFrom ?? []).length > 0);
t("存在依赖传递(步骤记录了 inputsFrom)", withFrom.length > 0,
  withFrom.map((s) => `${s.stepId}←${(s.inputsFrom ?? []).join("+")}`).join(" "));

// ── 8. 运行记录可查(落库) ──
const runsRes = await j("GET", "/api/orchestrator/runs?limit=20");
t("GET /runs 200", runsRes.status === 200, `${runsRes.status}`);
const mine = (runsRes.data?.runs ?? []).find((r) => r.runId === runId);
t("本次运行出现在运行记录里", !!mine, mine ? `status=${mine.status}` : "未找到");
t("记录带步骤日志", (mine?.stepLog ?? []).length > 0, `${(mine?.stepLog ?? []).length} 步`);

// ── 9. 保存/读取自定义图(自由组合的持久化) ──
const gid = `verify-graph-${Date.now().toString(36)}`;
const saveRes = await j("PUT", `/api/orchestrator/graphs/${gid}`, {
  name: "验证用自定义编排", description: "两节点串联",
  nodes: [
    { id: "s1", capabilityId: "tool:llm_write", title: "写一段话", params: { topic: "{{inputs}}", length: "短" } },
    { id: "s2", capabilityId: "tool:summarize", title: "摘要", params: { text: "{{inputs}}" } },
  ],
  edges: [{ source: "s1", target: "s2" }],
});
t("PUT /graphs/:id 200", saveRes.status === 200, `${saveRes.status} ${saveRes.text?.slice(0, 100)}`);
const getRes = await j("GET", `/api/orchestrator/graphs/${gid}`);
t("GET /graphs/:id 回读到同一张图",
  getRes.status === 200 && getRes.data?.graph?.nodes?.length === 2 && getRes.data?.graph?.edges?.length === 1,
  `nodes=${getRes.data?.graph?.nodes?.length} edges=${getRes.data?.graph?.edges?.length}`);
const listRes = await j("GET", "/api/orchestrator/graphs");
t("GET /graphs 列表含刚保存的图", (listRes.data?.graphs ?? []).some((x) => x.id === gid));
const delRes = await j("DELETE", `/api/orchestrator/graphs/${gid}`);
t("DELETE /graphs/:id 200", delRes.status === 200, `${delRes.status}`);

// ── 10. 取消一条新运行 ──
const r2 = await j("POST", "/api/orchestrator/run", { graph: {
  id: "api-cancel", name: "取消验证",
  nodes: [
    { id: "x1", capabilityId: "tool:llm_write", title: "慢", params: { topic: "写一千字", length: "长" } },
    { id: "x2", capabilityId: "tool:summarize", title: "后", params: { text: "{{inputs}}" } },
  ],
  edges: [{ source: "x1", target: "x2" }],
} });
const rid2 = r2.data?.runId;
await new Promise((r) => setTimeout(r, 1200));
const cRes = await j("POST", "/api/orchestrator/control", { runId: rid2, action: "cancel" });
t("POST /control cancel 200", cRes.status === 200, `${cRes.status} ${cRes.text?.slice(0, 100)}`);
await new Promise((r) => setTimeout(r, 2000));
const p2 = (await j("GET", `/api/orchestrator/progress?runId=${rid2}`)).data;
console.log(`\n[10] 取消后 status=${p2?.status}`);
t("取消生效(不是失败态)", p2?.status === "cancelled", `status=${p2?.status}`);
t("取消后未启动的节点仍未完成",
  (p2?.stepLog ?? []).find((s) => s.stepId === "x2")?.status !== "done",
  `x2=${(p2?.stepLog ?? []).find((s) => s.stepId === "x2")?.status}`);

// ── 11. 错误面: 空图 / 不存在的模板 ──
const bad1 = await j("POST", "/api/orchestrator/run", { graph: { id: "empty", nodes: [], edges: [] } });
t("空图被拒绝", bad1.status === 400, `${bad1.status} ${bad1.data?.error?.message?.slice(0, 60)}`);
const bad2 = await j("POST", "/api/orchestrator/run", { templateId: "tpl_not_exist" });
t("不存在的模板被拒绝", bad2.status === 400, `${bad2.status} ${bad2.data?.error?.message?.slice(0, 60)}`);
const bad3 = await j("POST", "/api/orchestrator/control", { runId: "no-such-run", action: "pause" });
t("对不存在的运行控制返回 400", bad3.status === 400, `${bad3.status} ${bad3.data?.error?.message?.slice(0, 60)}`);
const bad4 = await j("POST", "/api/orchestrator/control", { runId: "x", action: "nonsense" });
t("未知动作返回 400", bad4.status === 400, `${bad4.status}`);

// ── 12. V415 新增: 编辑器/大纲能力进了注册表 + 澄清节点跑通 + 执行角色可见 ──
const NEW_CAPS = ["editor:rewrite", "editor:title-abstract", "editor:check-fulltext", "editor:format-references", "outline:chapter", "outline:component", "p2o:convert"];
t("编辑器/大纲/PDF 能力已登记",
  NEW_CAPS.every((id) => caps.some((c) => c.id === id)),
  NEW_CAPS.filter((id) => !caps.some((c) => c.id === id)).join(",") || "全部在列");

// 澄清节点(io:clarify)是全场景起点: 挂起 → 提交 → 续跑到终态。之前只有白盒覆盖。
const r3 = await j("POST", "/api/orchestrator/run", { graph: {
  id: "api-clarify", name: "API 澄清探针",
  nodes: [
    { id: "c1", capabilityId: "io:clarify", title: "澄清" },
    { id: "w1", capabilityId: "io:llm-write", title: "生成", params: { task: "{{inputs}}", system: "只回一句" } },
  ],
  edges: [{ source: "c1", target: "w1" }],
} });
const rid3 = r3.data?.runId;
if (!rid3) { t("澄清图可启动", false, r3.text?.slice(0, 120)); }
else {
  await new Promise((r) => setTimeout(r, 3000));
  const p3 = (await j("GET", `/api/orchestrator/progress?runId=${rid3}`)).data;
  t("澄清节点让运行挂起等待输入", p3?.status === "waiting_input", `status=${p3?.status}`);
  t("挂起节点带等待字段", ((p3?.stepLog ?? []).find((s) => s.stepId === "c1")?.waitingFields ?? []).length > 0,
    JSON.stringify(((p3?.stepLog ?? []).find((s) => s.stepId === "c1")?.waitingFields ?? []).map((f) => f.name)));
  t("进度回读带执行角色", p3?.runSource === "ui", `runSource=${p3?.runSource}`);
  const inp = await j("POST", "/api/orchestrator/control", { runId: rid3, action: "input", values: { topic: "基层治理数字化" } });
  t("提交澄清输入 200", inp.status === 200, `${inp.status}`);
  let p3b = null;
  const dl = Date.now() + 120_000;
  do { await new Promise((r) => setTimeout(r, 3000)); p3b = (await j("GET", `/api/orchestrator/progress?runId=${rid3}`)).data; }
  while (!["done", "failed", "cancelled"].includes(p3b?.status) && Date.now() < dl);
  t("提交输入后跑到终态", p3b?.status === "done", `status=${p3b?.status}`);
}

// 编辑器改写节点: 端点要求登录。有令牌则必须真跑通(身份带不过去就是 401);
// 无令牌时说明跳过原因, 不把"没测"包装成"通过"。
if (!TOKEN) {
  sk("编辑器改写节点在编排里可执行", "未提供 ORCH_TOKEN(端点要求登录); 用 ORCH_TOKEN=<jwt> 重跑");
} else {
  const r4 = await j("POST", "/api/orchestrator/run", { graph: {
    id: "api-editor", name: "API 编辑器探针",
    nodes: [{ id: "e1", capabilityId: "editor:rewrite", title: "去AI味", params: { mode: "humanize", text: "综上所述, 本文进行了深入的研究。" } }],
    edges: [],
  } });
  const rid4 = r4.data?.runId;
  let p4 = null;
  const dl4 = Date.now() + 120_000;
  if (rid4) {
    do { await new Promise((r) => setTimeout(r, 3000)); p4 = (await j("GET", `/api/orchestrator/progress?runId=${rid4}`)).data; }
    while (!["done", "failed", "cancelled"].includes(p4?.status) && Date.now() < dl4);
  }
  const step4 = (p4?.stepLog ?? []).find((s) => s.stepId === "e1");
  t("编辑器改写节点在编排里可执行(身份带得下去)", p4?.status === "done",
    `status=${p4?.status} err=${String(step4?.error ?? "").slice(0, 120)}`);
}

// 新模板"定稿润色车间"端到端: 它把编辑器端点串成 7 节点并联图(去AI味/降重并行 → 语体统一 → 引文 → 体检)。
// 这条链只有真跑一遍才能证明: ① 节点参数(mode)真的进了 body; ② 编辑器端点要求的登录身份被带下去了;
// ③ 并联分支的两份产出都汇进了下游的 {{outputs.x}}。缺任何一条都会在这一段暴露成 failed。
if (!TOKEN) {
  sk("定稿润色车间模板端到端", "未提供 ORCH_TOKEN; 用 ORCH_TOKEN=<jwt> 重跑");
} else {
  const rp = await j("POST", "/api/orchestrator/run", {
    templateId: "tpl_polish",
    input: "综上所述, 本文对抗逆力这一概念进行了深入的研究, 具有重要的理论意义与实践价值。研究采用了文献分析法与案例分析法, 对相关问题进行了系统的探讨。",
  });
  const ridp = rp.data?.runId;
  t("润色模板可启动", !!ridp, rp.text?.slice(0, 120));
  if (ridp) {
    // 第一个节点是澄清(要正文) —— 与前端一致: 挂起 → 提交 → 继续
    let pp = null;
    let dlp = Date.now() + 60_000;
    do { await new Promise((r) => setTimeout(r, 2000)); pp = (await j("GET", `/api/orchestrator/progress?runId=${ridp}`)).data; }
    while (pp?.status !== "waiting_input" && !["done", "failed"].includes(pp?.status) && Date.now() < dlp);
    if (pp?.status === "waiting_input") {
      await j("POST", "/api/orchestrator/control", {
        runId: ridp, action: "input",
        values: { topic: "综上所述, 本文对抗逆力这一概念进行了深入的研究, 具有重要的理论意义与实践价值。研究采用了文献分析法与案例分析法, 对相关问题进行了系统的探讨。", object: "抗逆力", method: "文献分析", boundary: "近五年" },
      });
    }
    dlp = Date.now() + 300_000;
    do { await new Promise((r) => setTimeout(r, 3000)); pp = (await j("GET", `/api/orchestrator/progress?runId=${ridp}`)).data; }
    while (!["done", "failed", "cancelled"].includes(pp?.status) && Date.now() < dlp);
    console.log(`\n[13] 润色模板 status=${pp?.status} | ${(pp?.stepLog ?? []).map((s) => `${s.stepId}:${s.status}`).join(", ")}`);
    const editorSteps = ["humanize", "dedupe", "style", "refs", "check"];
    const editorDone = editorSteps.filter((id) => (pp?.stepLog ?? []).find((s) => s.stepId === id)?.status === "done");
    t("润色模板跑到终态", pp?.status === "done", `status=${pp?.status} 失败于: ${(pp?.stepLog ?? []).filter((s) => s.status === "failed").map((s) => s.stepId + ":" + String(s.error ?? "").slice(0, 60)).join(" | ")}`);
    t("编辑器链的节点全部执行成功", editorDone.length === editorSteps.length, `${editorDone.length}/${editorSteps.length}: ${editorDone.join(",")}`);
    t("并联分支的两份产出都汇入了下游",
      ((pp?.stepLog ?? []).find((s) => s.stepId === "style")?.inputsFrom ?? []).length === 2,
      JSON.stringify((pp?.stepLog ?? []).find((s) => s.stepId === "style")?.inputsFrom ?? []));
  }
}

console.log(`\n${"=".repeat(54)}\n通过 ${pass} / 失败 ${fail}${skip.length ? ` / 跳过 ${skip.length}` : ""}`);
process.exit(fail ? 1 : 0);
