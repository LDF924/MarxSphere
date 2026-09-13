// scripts/verify-orchestrator-api.mjs — V415 编排器 HTTP 端到端验证(打真实 4173)
// 与 verify-orchestrator.mjs 的区别: 那个直接调 service(白盒), 这个走 HTTP(黑盒),
// 覆盖前端真正会用的四件事: 拉能力 → 拉模板 → 按图启动 → 轮询进度 → 控制(暂停/恢复/取消) → 落库可查
const BASE = process.env.ORCH_BASE || "http://127.0.0.1:4173";

let pass = 0, fail = 0;
const t = (name, ok, extra = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };

async function j(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
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
t("模板数 ≥ 10", tpls.length >= 10, `${tpls.length}`);
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

console.log(`\n${"=".repeat(54)}\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
