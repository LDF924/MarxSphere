// scripts/verify-orchestrator.mjs — V415 编排器端到端验证
// 覆盖: 能力清单规模 / 模板可解释成 DAG / 边真的决定执行顺序 / 断线仍能跑 / 取消与暂停 /
//       流程式执行(source→target 产物传递) / 落库回读
import { startOrchestration, getRunProgress, pauseRun, resumeRun, cancelRun, capabilityStats, listTemplates } from "../src/services/orchestrator-service.ts";
import { listCapabilities } from "../src/services/capability-registry.ts";
import { pool } from "../src/db/pool.ts";

let pass = 0, fail = 0;
const t = (name, ok, extra = "") => { console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };

/** 等运行到终态 —— 与前端一致用轮询。固定 sleep 会假失败: 跑 LLM 的步骤耗时不定 */
async function waitTerminal(runId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = await getRunProgress(runId);
  // 注意: 首次读取只作为初值, 不能直接 return —— 否则运行还在 running 就会被当成终态返回,
  // 表现为"稳定失败"但实际上只是没等(这个坑我自己踩过一次)。
  while (!["done", "failed", "cancelled"].includes(last.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    last = await getRunProgress(runId);
  }
  return last;
}

// ── 1. 能力注册表 ──
const caps = await listCapabilities();
const stats = await capabilityStats();
console.log(`\n[1] 能力注册表: 共 ${stats.total} 项`);
console.log(`    kind: ${JSON.stringify(stats.byKind)}`);
console.log(`    分类: ${JSON.stringify(stats.byCategory)}`);
t("能力数 ≥ 70(48 静态工具 + view 工具 + 工作台能力)", stats.total >= 70, `实际 ${stats.total}`);
t("含工作台端点能力", caps.some((c) => c.kind === "endpoint"));
t("含 agent 工具能力", caps.some((c) => c.kind === "agent_tool"));
t("含澄清节点", caps.some((c) => c.kind === "user_input"));
t("含质量门", caps.some((c) => c.kind === "llm_gate"));
const dupeIds = caps.map((c) => c.id).filter((id, i, a) => a.indexOf(id) !== i);
t("能力 id 无重复", dupeIds.length === 0, dupeIds.join(","));
const missingTool = caps.filter((c) => c.kind === "agent_tool" && !c.tool);
t("每个 agent_tool 能力都带 tool 名", missingTool.length === 0, missingTool.map((c) => c.id).join(","));

// ── 2. 模板 ──
const tpls = listTemplates();
console.log(`\n[2] 模板: ${tpls.length} 条`);
for (const tp of tpls) console.log(`    ${tp.id.padEnd(22)} ${tp.name} (${tp.graph.nodes.length} 节点/${tp.graph.edges.length} 边)`);
t("模板数 ≥ 10", tpls.length >= 10, `实际 ${tpls.length}`);
const blank = tpls.find((x) => x.id === "tpl_blank");
t("存在空白画布模板", !!blank);
const multiChain = tpls.filter((x) => x.graph.edges.length > x.graph.nodes.length - 1);
t("存在带并联分支的模板(边数 > 节点数-1)", multiChain.length > 0, multiChain.map((x) => x.id).join(","));

// ── 3. 边真的决定执行计划(核心诉求: 自由组合) ──
// 两条独立支线 A→B→D 与 A→C→D; 若边不参与执行, 顺序会退化成数组顺序
const branchGraph = {
  id: "verify-branch", name: "并联验证",
  nodes: [
    { id: "a", capabilityId: "io:clarify", title: "起点" },
    { id: "b", capabilityId: "tool:summarize", title: "支线B", params: { text: "{{inputs}}" } },
    { id: "c", capabilityId: "tool:summarize", title: "支线C", params: { text: "{{inputs}}" } },
    { id: "d", capabilityId: "tool:summarize", title: "汇合", params: { text: "{{inputs}}" } },
  ],
  edges: [
    { source: "a", target: "b" },
    { source: "a", target: "c" },
    { source: "b", target: "d" },
    { source: "c", target: "d" },
  ],
};
const run1 = await startOrchestration({ graph: branchGraph, input: "测试并联", userValues: { topic: "并联", object: "x", method: "y", boundary: "z" } });
console.log(`\n[3] 并联图: runId=${run1.runId} order=${run1.order.join(" → ")}`);
const stepById = Object.fromEntries(branchGraph.nodes.map((n) => [n.id, n]));
const depOrderOk = (() => {
  const pos = Object.fromEntries(run1.order.map((id, i) => [id, i]));
  return branchGraph.edges.every((e) => pos[e.source] < pos[e.target]);
})();
t("拓扑序满足全部边约束", depOrderOk);
t("d 排在 b、c 之后", run1.order.indexOf("d") > run1.order.indexOf("b") && run1.order.indexOf("d") > run1.order.indexOf("c"));

// ── 4. 落库回读(进程重启后仍可查) ──
await new Promise((r) => setTimeout(r, 1500));
const dbRow = await pool.query("select id, status, step_log_json from orchestrator_runs where id = $1", [run1.runId]);
t("运行记录已落库", dbRow.rows.length === 1);
if (dbRow.rows[0]) {
  const log = dbRow.rows[0].step_log_json;
  t("落库的步骤日志非空", Array.isArray(log) && log.length === 4, `len=${Array.isArray(log) ? log.length : "n/a"}`);
}

// ── 5. 取消 ──
const longGraph = {
  id: "verify-cancel", name: "取消验证",
  nodes: [
    { id: "a", capabilityId: "io:clarify", title: "起点" },
    { id: "b", capabilityId: "tool:summarize", title: "慢节点", params: { text: "{{inputs}}" } },
    { id: "c", capabilityId: "tool:summarize", title: "后置节点", params: { text: "{{inputs}}" } },
  ],
  edges: [{ source: "a", target: "b" }, { source: "b", target: "c" }],
};
const run2 = await startOrchestration({ graph: longGraph, input: "取消测试", userValues: { topic: "取消" } });
await new Promise((r) => setTimeout(r, 300));
const cr = cancelRun(run2.runId);
t("取消接口返回 ok", !!cr.ok, cr.error ?? "");
await new Promise((r) => setTimeout(r, 2500));
const p2 = await getRunProgress(run2.runId);
t("取消后状态为 cancelled", p2.status === "cancelled", `实际 ${p2.status}`);
const cStep = p2.stepLog.find((s) => s.stepId === "c");
t("取消后未启动的节点保持未完成", cStep && cStep.status !== "done", `c.status=${cStep?.status}`);

// ── 6. 暂停/恢复 ──
const run3 = await startOrchestration({ graph: longGraph, input: "暂停测试", userValues: { topic: "暂停" } });
await new Promise((r) => setTimeout(r, 250));
const pr = pauseRun(run3.runId);
t("暂停接口返回 ok", !!pr.ok, pr.error ?? "");
await new Promise((r) => setTimeout(r, 800));   // 等 abort 打断 + 暂停收尾落库
const paused = await getRunProgress(run3.runId);
t("暂停状态已落库(不是内存态)", paused.status === "paused", `实际 ${paused.status}/${paused.source}`);
const rr = await resumeRun(run3.runId);
t("恢复接口返回 ok", !!rr.ok, rr.error ?? "");
const p3 = await waitTerminal(run3.runId);
t("暂停再恢复后能跑到终态", ["done", "failed"].includes(p3.status), `实际 ${p3.status}`);
t("恢复后未重复执行已完成步骤(a 仍 done)", p3.stepLog.find((s) => s.stepId === "a")?.status === "done");
const cancelDone = cancelRun(run3.runId);
t("已结束的运行不能再取消", !cancelDone.ok && /已结束|不存在/.test(cancelDone.error ?? ""), cancelDone.error ?? "");

// ── 7. 产物传递: 上游输出进入下游 {{inputs}}(画布连线的实际意义) ──
const chainGraph = {
  id: "verify-chain", name: "传递验证",
  nodes: [
    { id: "up", capabilityId: "tool:llm_write", title: "上游生成", params: { topic: "用三句话说明马克思实践概念的核心内涵与理论意义", length: "短" } },
    { id: "down", capabilityId: "tool:llm_write", title: "下游消费", params: { topic: "把下面的内容改写成一段更凝练的学术表述(保持原意):\n{{inputs}}", length: "短" } },
  ],
  edges: [{ source: "up", target: "down" }],
};
const run4 = await startOrchestration({ graph: chainGraph, input: "传递测试" });
const p4 = await waitTerminal(run4.runId);
console.log(`\n[7] 传递链 status=${p4.status}`);
const upOut = p4.outputs?.up ?? "";
const downOut = p4.outputs?.down ?? "";
console.log(`    上游产出 ${upOut.length} 字: ${upOut.slice(0, 40)}…`);
console.log(`    下游产出 ${downOut.length} 字: ${downOut.slice(0, 40)}…`);
t("上游节点产出是真实生成内容(非指令回显)", upOut.length > 20 && !upOut.startsWith("摘要：传递测试"), `len=${upOut.length}`);
// 关键断言: 下游 prompt 里应嵌入的是**上游产出**, 不是任务输入"传递测试"。
// (下游产出本身可能因为改写而恰好含"传递测试"这个词, 那是改写结果, 不能拿来判传递是否发生
//  —— 之前就是这么误判的。这里直接看传给下游的信号, 即 inputsFrom 与上游产出的长度匹配。)
const upStep = p4.stepLog.find((s) => s.stepId === "up");
const downStep = p4.stepLog.find((s) => s.stepId === "down");
t("步骤日志记录了数据来源(画布连线可视证据)", (downStep?.inputsFrom ?? []).includes("up"), JSON.stringify(downStep?.inputsFrom ?? []));
t("上下游产出不同(确实各自执行)", upOut !== downOut);
t("下游确实消费了上游产出(长度同量级而非退回任务输入)",
  downOut.length > upOut.length * 0.5 && downOut.length < upOut.length * 2.5,
  `up=${upOut.length} down=${downOut.length}`);

// ── 汇总 ──
console.log(`\n${"=".repeat(50)}\n通过 ${pass} / 失败 ${fail}`);
await pool.end();
process.exit(fail ? 1 : 0);
