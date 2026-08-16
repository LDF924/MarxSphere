// demo-agent.ts — G20: Agent 子系统端到端演示
// 用法: npx tsx scripts/demo-agent.ts [goal]
// 流程: 创建任务(LLM 拆解计划) → 入队执行(runAgentTask) → 查看执行日志 → 清理
// 默认用"文献检索示例"目标（不依赖外部 API 的高确定性演示）
import { agentTaskService } from "../src/services/agent-task-service.js";
import { agentExecLogService } from "../src/services/agent-exec-log.js";
import { closePool } from "../src/db/pool.js";

const goal = process.argv[2] || "检索马克思《资本论》关于剩余价值的论述并总结要点";

async function main(): Promise<void> {
  console.log("═".repeat(60));
  console.log("SAG Agent 子系统端到端演示");
  console.log("═".repeat(60));

  // ① 创建任务（LLM 拆解计划 + 预算评估）
  console.log("\n[1/4] 创建任务: ", goal.slice(0, 50) + (goal.length > 50 ? "…" : ""));
  const task = await agentTaskService.createAgentTask({ goal });
  console.log(`  任务ID: ${task.id}`);
  console.log(`  状态: ${task.status} | 计划 ${task.plan.length} 步 | 预估成本 ${task.estimatedCostCents} 分`);
  console.log(`  计划步骤: ${task.plan.map((s) => `[${s.type}]${s.title}`).join(" → ")}`);

  // ② 执行（与 HTTP /run 路由同路径的 runAgentTask; 简化执行器逐步骤执行+验证+记日志）
  console.log("\n[2/4] 执行中…（每步: 工具调用→验证→记录日志）");
  await agentTaskService.runAgentTask(task.id, async (step) => {
    // 演示用简化执行器: 检索/推理直接回显目标（真实环境走 SAG 推理/工具链）
    const result = `【演示执行】${step.title} — 目标: ${(step.query || "").slice(0, 80)}`;
    return { result, detail: result, source: "demo-runner" };
  });

  // ③ 查看结果
  console.log("\n[3/4] 任务结果:");
  const done = await agentTaskService.getAgentTask(task.id);
  if (!done) { console.error("  任务不存在！"); process.exitCode = 1; return; }
  console.log(`  最终状态: ${done.status} | 循环 ${done.loopCount} 轮 | 实际成本 ${done.actualCostCents} 分`);
  if (done.progress) console.log(`  进度: ${done.progress}`);
  if (done.result) console.log(`  结果摘要: ${done.result.slice(0, 200)}…`);
  console.log(`  步骤明细: ${(done.plan || []).map((s) => `${s.title}(${s.status}${s.verification?.verified ? "✓" : ""})`).join(" · ")}`);

  // ④ 执行日志审计
  console.log("\n[4/4] 执行日志（exec_logs）:");
  const logs = await agentExecLogService.listAgentExecLogs(task.id, 10);
  for (const log of logs) {
    console.log(`  - [${log.status}] ${log.action} / ${log.tool || "-"} / ${log.durationMs}ms / ${log.costCents}分`);
  }
  if (logs.length === 0) console.log("  （无日志 — 简化执行器未触发真实 LLM/工具）");

  // 清理演示任务
  await agentTaskService.deleteAgentTask(task.id);
  console.log("\n✅ 演示完成（演示任务已清理）");
}

main()
  .catch((e: any) => { console.error("演示失败:", e?.message || e); process.exitCode = 1; })
  .finally(async () => { await closePool(); });
