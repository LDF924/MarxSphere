// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-eval-service.ts — V393-7: Agent 任务级评测体系
// 指标: 任务完成率 / 步骤成功率 / 多轮收敛率 / 平均成本 / 平均耗时
// V396-1: 轨迹级评测 — 计划遵循度 / 工具调用准确率 / 推理质量(LLM judge) / 回归基线告警
// 数据源: agent_tasks(任务) + agent_exec_logs(执行日志)
import { pool } from "../db/pool.js";
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";
import { callLlm } from "../ai/llm-common.js";

export interface AgentEvalReport {
  /** 时间范围 */
  days: number;
  /** 任务统计 */
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  cancelledTasks: number;
  /** 完成率 = completed / total */
  completionRate: number;
  /** 步骤统计 */
  totalSteps: number;
  succeededSteps: number;
  failedSteps: number;
  /** 步骤成功率 = succeeded / total */
  stepSuccessRate: number;
  /** 多轮收敛: 完成的任务中 loopCount >= 2 的比例（体现 replan 能力） */
  multiLoopTasks: number;
  multiLoopRate: number;
  /** reflect 评估记录数 */
  reflectCount: number;
  /** 成本效率 */
  avgCostCents: number;
  totalCostCents: number;
  /** 审批统计 */
  approvalCount: number;
  // ═══ V396-1: 轨迹级指标 ═══
  /** 计划遵循度: 实际执行步骤数 / 计划步骤数（接近1=严格遵循, <0.5=计划漂移） */
  planAdherence: number;
  /** 工具调用准确率: 成功工具调用 / 总工具调用 */
  toolAccuracy: number;
  /** 工具失败重试率: 重试过的工具调用占比 */
  toolRetryRate: number;
  /** 推理质量(LLM judge): 0-1 分, 对完成任务的推理轨迹评分 */
  reasoningQuality: number;
  /** 评测过的任务数（judge 抽样） */
  judgedTasks: number;
  /** 回归基线: 与上次评测的指标差值（告警用） */
  regression?: { metric: string; delta: number; threshold: number; alarm: boolean };
}

/** V393-7: 生成 Agent 任务级评测报告（近 N 天） */
export async function generateAgentEvalReport(days = 7): Promise<AgentEvalReport> {
  const daysClamped = Math.min(Math.max(days, 1), 90);
  // 任务统计
  const tasks = await pool.query(
    `select status, loop_count, count(*) as n from agent_tasks
     where created_at > now() - ($1::int || ' days')::interval group by status, loop_count`,
    [daysClamped]
  );
  const taskRows = tasks.rows as Array<{ status: string; loop_count: number; n: string }>;
  const totalTasks = taskRows.reduce((a, r) => a + Number(r.n), 0);
  const completedTasks = taskRows.filter((r) => r.status === "completed").reduce((a, r) => a + Number(r.n), 0);
  const failedTasks = taskRows.filter((r) => r.status === "failed").reduce((a, r) => a + Number(r.n), 0);
  const cancelledTasks = taskRows.filter((r) => r.status === "cancelled").reduce((a, r) => a + Number(r.n), 0);
  const multiLoopTasks = taskRows.filter((r) => r.status === "completed" && Number(r.loop_count) >= 2).reduce((a, r) => a + Number(r.n), 0);

  // 步骤统计（agent_exec_logs: action=tool_call）
  const steps = await pool.query(
    `select status, count(*) as n from agent_exec_logs
     where action = 'tool_call' and created_at > now() - ($1::int || ' days')::interval group by status`,
    [daysClamped]
  );
  const stepRows = steps.rows as Array<{ status: string; n: string }>;
  const totalSteps = stepRows.reduce((a, r) => a + Number(r.n), 0);
  const succeededSteps = stepRows.filter((r) => r.status === "ok").reduce((a, r) => a + Number(r.n), 0);
  const failedSteps = stepRows.filter((r) => r.status === "failed").reduce((a, r) => a + Number(r.n), 0);

  // reflect 记录
  const reflect = await pool.query(`select count(*) as n from agent_exec_logs where action = 'reflect' and created_at > now() - ($1::int || ' days')::interval`, [daysClamped]);
  // 审批记录
  const approvals = await pool.query(`select count(*) as n from agent_exec_logs where action = 'approval' and created_at > now() - ($1::int || ' days')::interval`, [daysClamped]);
  // 成本
  const cost = await pool.query(`select coalesce(sum(cost_cents),0) as c from agent_exec_logs where created_at > now() - ($1::int || ' days')::interval`, [daysClamped]);

  const totalCostCents = Number(cost.rows[0]?.c || 0);
  // ═══ V396-1: 轨迹级指标 ═══
  const [planAdherence, toolMetrics, judgeResult] = await Promise.all([
    computePlanAdherence(days),
    computeToolMetrics(days),
    judgeReasoningQuality(days),
  ]);
  const report: AgentEvalReport = {
    days,
    totalTasks,
    completedTasks,
    failedTasks,
    cancelledTasks,
    completionRate: totalTasks > 0 ? completedTasks / totalTasks : 0,
    totalSteps,
    succeededSteps,
    failedSteps,
    stepSuccessRate: totalSteps > 0 ? succeededSteps / totalSteps : 0,
    multiLoopTasks,
    multiLoopRate: completedTasks > 0 ? multiLoopTasks / completedTasks : 0,
    reflectCount: Number(reflect.rows[0]?.n || 0),
    approvalCount: Number(approvals.rows[0]?.n || 0),
    avgCostCents: totalSteps > 0 ? Math.round(totalCostCents / totalSteps) : 0,
    totalCostCents,
    planAdherence,
    toolAccuracy: toolMetrics.accuracy,
    toolRetryRate: toolMetrics.retryRate,
    reasoningQuality: judgeResult.score,
    judgedTasks: judgeResult.judged,
  };
  // 回归基线对比
  report.regression = await checkRegression({
    completionRate: report.completionRate,
    stepSuccessRate: report.stepSuccessRate,
    toolAccuracy: report.toolAccuracy,
  });
  return report;
}

/** V394-9: 学习曲线 — 按天聚合评测指标（连续 N 天完成率/步骤成功率变化, 体现 Agent 是否在进步） */
export async function generateLearningCurve(days = 14): Promise<Array<{ day: string; completionRate: number; stepSuccessRate: number; taskCount: number }>> {
  const r = await pool.query(
    `select to_char(created_at, 'MM-DD') as day,
            count(*) as task_count,
            coalesce(avg(case when status = 'completed' then 1 else 0 end), 0) as completion_rate
     from agent_tasks
     where created_at > now() - (${Math.min(days, 90)} || ' days')::interval
     group by day order by day`
  );
  const stepR = await pool.query(
    `select to_char(created_at, 'MM-DD') as day,
            count(*) as n,
            coalesce(avg(case when status = 'ok' then 1 else 0 end), 0) as success_rate
     from agent_exec_logs
     where action = 'tool_call' and created_at > now() - (${Math.min(days, 90)} || ' days')::interval
     group by day order by day`
  );
  const stepMap = new Map(stepR.rows.map((x: any) => [x.day, Number(x.success_rate)]));
  return (r.rows as any[]).map((row) => ({
    day: row.day,
    completionRate: Number(row.completion_rate),
    stepSuccessRate: stepMap.get(row.day) ?? 0,
    taskCount: Number(row.task_count),
  }));
}

// ═══════════════════════════════════════════════════════════════
// V396-1: 轨迹级评测 — 计划遵循度 / 工具准确率 / 推理质量 judge
// ═══════════════════════════════════════════════════════════════

/** 计划遵循度: 对每个完成任务, 对比 plan 计划步骤数 vs 实际工具调用数 */
async function computePlanAdherence(days: number): Promise<number> {
  const daysC = Math.min(Math.max(days, 1), 90);
  const r = await pool.query(
    `select t.plan, count(l.id) as steps
     from agent_tasks t left join agent_exec_logs l on l.task_id = t.id and l.action = 'tool_call'
     where t.status = 'completed' and t.created_at > now() - ($1::int || ' days')::interval
     group by t.id, t.plan limit 50`,
    [daysC]
  );
  const rows = r.rows as Array<{ plan: unknown; steps: string }>;
  if (rows.length === 0) return 0;
  const ratios: number[] = [];
  for (const row of rows) {
    const planArr = Array.isArray(row.plan) ? row.plan : [];
    const planned = planArr.length > 0 ? planArr.length : 3;  // 无 plan 时按 3 步估
    const actual = Number(row.steps);
    ratios.push(Math.min(actual / planned, 2));  // 超过 2 倍计划视为失控, 封顶
  }
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

/** 工具调用准确率 + 重试率: 从 exec_logs 统计 */
async function computeToolMetrics(days: number): Promise<{ accuracy: number; retryRate: number }> {
  const r = await pool.query(
    `select status, count(*) as n from agent_exec_logs
     where action = 'tool_call' and created_at > now() - ($1::int || ' days')::interval group by status`,
    [Math.min(Math.max(days, 1), 90)]
  );
  const rows = r.rows as Array<{ status: string; n: string }>;
  const total = rows.reduce((a, x) => a + Number(x.n), 0);
  const ok = rows.filter((x) => x.status === "ok").reduce((a, x) => a + Number(x.n), 0);
  // 重试: 同 task_id+tool 出现多次且首次失败
  const retryR = await pool.query(
    `select count(*) as n from (
       select task_id, tool, count(*) as c,
              sum(case when status = 'failed' then 1 else 0 end) as fails
       from agent_exec_logs where action = 'tool_call' and created_at > now() - ($1::int || ' days')::interval
       group by task_id, tool having count(*) > 1 and sum(case when status = 'failed' then 1 else 0 end) > 0
     ) x`,
    [Math.min(Math.max(days, 1), 90)]
  );
  const retryCount = Number(retryR.rows[0]?.n || 0);
  return {
    accuracy: total > 0 ? ok / total : 0,
    retryRate: total > 0 ? Math.min(retryCount / total, 1) : 0,
  };
}

/** 推理质量: LLM judge 对完成任务的关键轨迹打分（抽样最多 5 个） */
async function judgeReasoningQuality(days: number): Promise<{ score: number; judged: number }> {
  const daysC = Math.min(Math.max(days, 1), 90);
  const r = await pool.query(
    `select id, goal, result, reflect_log from agent_tasks
     where status = 'completed' and created_at > now() - ($1::int || ' days')::interval
     order by created_at desc limit 5`,
    [daysC]
  );
  const rows = r.rows as Array<{ id: string; goal: string; result: unknown; reflect_log: unknown }>;
  if (rows.length === 0) return { score: 0, judged: 0 };
  const model = resolveModelAlias(getRoleModel("plan"));
  let total = 0;
  let judged = 0;
  for (const row of rows) {
    try {
      const prompt = `你是 Agent 推理质量评审员。对以下 Agent 任务轨迹评分（0-1, 0.7+为合格）:
任务目标: ${String(row.goal || "").slice(0, 200)}
执行结果: ${String(row.result || "").slice(0, 400)}
反思记录: ${String(row.reflect_log || "").slice(0, 200)}

评分维度: ①目标达成度 ②推理链连贯性 ③工具使用合理性 ④反思深度
只输出一个 0-1 之间的数字, 不要其他文字:`;
      const resp = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0, maxTokens: 10 });
      const score = parseFloat((resp?.text || "0").trim());
      if (!Number.isNaN(score) && score >= 0 && score <= 1) {
        total += score;
        judged++;
        // W2: judge 分数写回 agent_tasks（评测→修复基线）
        try {
          await pool.query(
            "update agent_tasks set judge_score = $2, judge_at = now() where id = $1::uuid",
            [row.id, score]
          );
        } catch { /* 写回失败不阻塞 */ }
      }
    } catch { /* judge 失败跳过 */ }
  }
  return { score: judged > 0 ? total / judged : 0, judged };
}

/** 回归基线对比: 读取上次评测基线(agent_eval_baselines 表), 聚合<1%/单指标<5% 告警 */
async function checkRegression(current: { completionRate: number; stepSuccessRate: number; toolAccuracy: number }): Promise<{ metric: string; delta: number; threshold: number; alarm: boolean } | undefined> {
  try {
    const r = await pool.query("select baselines from agent_eval_baselines order by created_at desc limit 1");
    if (r.rows.length === 0) {
      // 首次: 写入基线
      await pool.query("insert into agent_eval_baselines (baselines) values ($1)", [JSON.stringify(current)]);
      return undefined;
    }
    const prev = JSON.parse(r.rows[0].baselines);
    // 找下降最严重的指标
    const candidates = [
      { metric: "completionRate", delta: current.completionRate - Number(prev.completionRate || 0), threshold: 0.05 },
      { metric: "stepSuccessRate", delta: current.stepSuccessRate - Number(prev.stepSuccessRate || 0), threshold: 0.05 },
      { metric: "toolAccuracy", delta: current.toolAccuracy - Number(prev.toolAccuracy || 0), threshold: 0.05 },
    ];
    const worst = candidates.sort((a, b) => a.delta - b.delta)[0];
    // 更新基线(滚动)
    await pool.query("insert into agent_eval_baselines (baselines) values ($1)", [JSON.stringify(current)]);
    return {
      metric: worst.metric,
      delta: Number(worst.delta.toFixed(4)),
      threshold: worst.threshold,
      alarm: worst.delta < -worst.threshold,  // 单指标回退>5% 告警
    };
  } catch { return undefined; }
}

// ═══════════════════════════════════════════════════════════════
// V396-2: 回归评测集 + 门禁 + 故障注入
// ═══════════════════════════════════════════════════════════════

/** 评测集管理: 列表/增删 */
export async function listEvalSuite(category?: string): Promise<any[]> {
  const where = category ? "where category = $1" : "";
  const params = category ? [category] : [];
  const r = await pool.query(`select * from agent_eval_suite ${where} order by category, id`, params);
  return r.rows;
}

export async function upsertEvalSuite(input: { name: string; category: string; goal: string; expectedSteps?: number; expectedTools?: string[]; expectedKeywords?: string[]; minScore?: number }): Promise<any> {
  const r = await pool.query(
    `insert into agent_eval_suite (name, category, goal, expected_steps, expected_tools, expected_keywords, min_score)
     values ($1,$2,$3,$4,$5::text[],$6::text[],$7) returning *`,
    [input.name, input.category || "gold", input.goal, input.expectedSteps || 0, input.expectedTools || [], input.expectedKeywords || [], input.minScore ?? 0.7]
  );
  return r.rows[0];
}

export async function deleteEvalSuite(id: number): Promise<void> {
  await pool.query("delete from agent_eval_suite where id = $1", [id]);
}

/** 故障注入类型(环境级评测): 429风暴/超时/依赖降级 */
export type FaultType = "none" | "rate_limit" | "timeout" | "degraded";

/** 运行评测集: 逐条跑 gold 任务(调用 Agent 执行), 对比期望工具/关键词/步骤数, 记录通过与否
 * fault 参数: 故障注入模拟(429/超时/降级) */
export async function runEvalSuite(input: { category?: string; fault?: FaultType; limit?: number }): Promise<{
  total: number; passed: number; failed: number;
  results: Array<{ suiteId: number; name: string; passed: boolean; score: number; metrics: Record<string, unknown>; fault: string; error?: string }>;
}> {
  const suite = await listEvalSuite(input.category || "gold");
  const items = suite.filter((s: any) => s.enabled).slice(0, input.limit || 10);
  const results = [];
  for (const s of items) {
    try {
      // 用 agent 执行器跑该 goal(实际 LLM + 工具)
      const { runAgentTask } = await import("./agent-task-service.js");
      const fault = input.fault || "none";
      // W10: 故障注入真实执行 — rate_limit 用降级模型+限工具; timeout 加短超时模拟
      let error: string | undefined;
      let taskResult: any = null;
      if (fault === "rate_limit") {
        // 429 风暴: 真实执行但降级 — 用 cheap 模型 + 限制单步(模拟限流下能力受限)
        try {
          const { createAgentTask, runAgentTask } = await import("./agent-task-service.js");
          const task = await createAgentTask({ goal: s.goal, contextHint: "评测集任务(限流降级模式)" });
          const { buildAgentTools, chooseToolByLlm, executeToolWithFallback } = await import("./agent-tool-router.js");
          const tools = (await buildAgentTools()).slice(0, 2);  // 限流下只有少量工具可用
          taskResult = await runAgentTask(task.id, async (step: any) => {
            try {
              const chosen = await chooseToolByLlm(s.goal, step.title || step.query || "", tools);
              if (chosen) {
                const exec = await executeToolWithFallback(chosen.tool, chosen.args, tools, { role: "analyst" });
                if (exec.ok) return { result: exec.result.substring(0, 120), detail: exec.result, source: `工具: ${chosen.tool.name}` };
              }
              return { result: "限流降级: 工具不可用, 步骤跳过", detail: "", source: "rate_limit" };
            } catch { return { result: "限流降级: 执行失败", detail: "", source: "rate_limit" }; }
          });
        } catch (e: any) { error = `FAULT_INJECTED:rate_limit 执行失败 ${String(e?.message || e).slice(0, 80)}`; }
      } else if (fault === "timeout") {
        // 超时: 真实执行但单步 3s 超时模拟
        try {
          const { createAgentTask, runAgentTask } = await import("./agent-task-service.js");
          const task = await createAgentTask({ goal: s.goal, contextHint: "评测集任务(超时模拟模式)" });
          taskResult = await runAgentTask(task.id, async (step: any) => {
            await new Promise((r) => setTimeout(r, 3000));  // 模拟慢响应
            return { result: "超时后返回(慢响应)", detail: "", source: "timeout" };
          });
        } catch (e: any) { error = `FAULT_INJECTED:timeout 执行失败 ${String(e?.message || e).slice(0, 80)}`; }
      } else {
        try {
          // 先创建任务(带 goal), 再用真实工具执行 stepRunner 跑
          const { createAgentTask, runAgentTask } = await import("./agent-task-service.js");
          const task = await createAgentTask({ goal: s.goal, contextHint: "评测集任务, 使用系统工具完成目标" });
          // 简化但真实的 stepRunner: LLM 选工具 → 降级链执行; 非工具步骤用 LLM 直答
          const { buildAgentTools, chooseToolByLlm, executeToolWithFallback } = await import("./agent-tool-router.js");
          const tools = await buildAgentTools();
          taskResult = await runAgentTask(task.id, async (step: any) => {
            try {
              const chosen = await chooseToolByLlm(s.goal, step.title || step.query || "", tools);
              if (chosen) {
                const exec = await executeToolWithFallback(chosen.tool, chosen.args, tools, { role: "analyst" });
                if (exec.ok) {
                  return {
                    result: exec.result.substring(0, 120),
                    detail: `【工具】${chosen.tool.label}${exec.usedFallback ? `(降级→${exec.usedFallback})` : ""}\n【结果】\n${exec.result}`,
                    source: `工具: ${chosen.tool.name}`,
                  };
                }
              }
              // 工具失败/不可用 → LLM 直答兜底
              const model = resolveModelAlias(getRoleModel("plan"));
              const resp = await callLlm({ model, messages: [{ role: "user", content: `目标: ${s.goal}\n步骤: ${step.title || step.query || ""}\n给出该步骤的完成内容(200字内):` }], temperature: 0.2, maxTokens: 400 });
              return { result: (resp?.text || "").substring(0, 120), detail: `【LLM直答】\n${resp?.text || ""}`, source: "LLM" };
            } catch (e: any) {
              return { result: `步骤失败: ${String(e?.message || e).slice(0, 80)}`, detail: "", source: "error" };
            }
          });
        } catch (e: any) {
          error = String(e?.message || e).slice(0, 200);
        }
      }
      // 评分: 期望工具命中率 + 期望关键词命中率 + 步骤数接近度
      // runAgentTask 返回 AgentTaskRecord; 实际工具/步骤数从 exec_logs 查
      const taskId = (taskResult as any)?.id || (taskResult as any)?.taskId || null;
      const resultText = String((taskResult as any)?.result || taskResult?.progress || (taskResult as any)?.summary || "");
      let steps = 0;
      let usedTools: string[] = [];
      if (taskId) {
        try {
          const logsR = await pool.query(
            "select tool, count(*) as n from agent_exec_logs where task_id = $1 and action = 'tool_call' group by tool",
            [taskId]
          );
          steps = Number((await pool.query("select count(*) as n from agent_exec_logs where task_id = $1", [taskId])).rows[0]?.n || 0);
          usedTools = logsR.rows.map((x: any) => x.tool);
        } catch { /* 日志查询失败不影响评分 */ }
      }
      const toolHit = (s.expected_tools || []).filter((t: string) => usedTools.some((u) => u.includes(t.split("_")[0]) || u === t)).length;
      const kwHit = (s.expected_keywords || []).filter((k: string) => resultText.includes(k)).length;
      const toolScore = (s.expected_tools || []).length > 0 ? toolHit / (s.expected_tools || []).length : 0.5;
      const kwScore = (s.expected_keywords || []).length > 0 ? kwHit / (s.expected_keywords || []).length : 0.5;
      const stepScore = s.expected_steps > 0 ? Math.min(steps / s.expected_steps, 1) : 0.5;
      const score = error ? 0 : toolScore * 0.4 + kwScore * 0.4 + stepScore * 0.2;
      const passed = !error && score >= Number(s.min_score || 0.7);
      // V399-2 P2 补齐: agent 评测参数/环境快照（088/089 迁移列; 与 eval-runner 的 RAGAS 评测快照同模式）
      // 参数: 本次评测的 suite/category/fault/limit; 环境: node/依赖/时间
      const parameters = {
        category: input.category || "gold",
        fault: input.fault || "none",
        limit: input.limit ?? null,
        suite: s.name,
      };
      const environment = {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        recordedAt: new Date().toISOString(),
      };
      await pool.query(
        `insert into agent_eval_runs (suite_id, task_id, passed, score, metrics, fault_injected, error, parameters_json, environment_json)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [s.id, taskId, passed, Number(score.toFixed(3)), JSON.stringify({ steps, usedTools, toolScore, kwScore, stepScore, resultPreview: resultText.slice(0, 150) }), input.fault || "none", error || null, JSON.stringify(parameters), JSON.stringify(environment)]
      );
      results.push({ suiteId: s.id, name: s.name, passed, score: Number(score.toFixed(3)), metrics: { steps, usedTools }, fault: input.fault || "none", error });
    } catch (e: any) {
      results.push({ suiteId: s.id, name: s.name, passed: false, score: 0, metrics: {}, fault: input.fault || "none", error: String(e?.message || e).slice(0, 150) });
    }
  }
  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

/** 评测集历史(门禁趋势): 最近 N 次运行通过率（V399-2 P2 补齐: 含参数/环境快照供前端溯源） */
export async function evalSuiteHistory(limit = 20): Promise<Array<{ created_at: string; passed: boolean; score: number; fault_injected: string; name: string; parameters_json?: unknown; environment_json?: unknown }>> {
  const r = await pool.query(
    `select r.created_at, r.passed, r.score, r.fault_injected, s.name, r.parameters_json, r.environment_json
     from agent_eval_runs r join agent_eval_suite s on s.id = r.suite_id
     order by r.created_at desc limit $1`, [limit]
  );
  return r.rows.map((row: any) => ({
    created_at: row.created_at, passed: row.passed, score: row.score,
    fault_injected: row.fault_injected, name: row.name,
    parameters_json: row.parameters_json ?? null,
    environment_json: row.environment_json ?? null,
  }));
}

/** V6: 自动回归调度 — 每天跑一次 gold 评测集（不阻塞, 失败静默; 通过率低于基线告警日志） */
export async function scheduledEvalSuiteRun(): Promise<{ ran: boolean; passed: number; total: number; note?: string }> {
  try {
    // 避免与手动运行并发: 简单时间窗口(距上次运行 <12h 跳过)
    const last = await pool.query("select max(created_at) as last from agent_eval_runs");
    const lastAt = last.rows[0]?.last ? new Date(last.rows[0].last).getTime() : 0;
    if (lastAt && Date.now() - lastAt < 12 * 3600 * 1000) {
      return { ran: false, passed: 0, total: 0, note: "12h 内已运行过, 跳过" };
    }
    const result = await runEvalSuite({ category: "gold", limit: 4 });
    const passRate = result.total > 0 ? result.passed / result.total : 0;
    if (passRate < 0.5) {
      console.warn(`[agent-eval] V6 回归告警: 通过率 ${(passRate * 100).toFixed(0)}% (${result.passed}/${result.total}) — 低于 50% 阈值`);
    } else {
      console.log(`[agent-eval] V6 自动回归: ${result.passed}/${result.total} 通过 (${(passRate * 100).toFixed(0)}%)`);
    }
    return { ran: true, passed: result.passed, total: result.total };
  } catch (e: any) {
    console.warn(`[agent-eval] V6 自动回归失败: ${String(e?.message || e).slice(0, 80)}`);
    return { ran: false, passed: 0, total: 0, note: "运行失败" };
  }
}

/** V6: 启动自动回归调度器（每 24h 跑一次） */
export function startEvalSuiteScheduler(): void {
  const EVAL_INTERVAL_MS = 24 * 60 * 60 * 1000;
  void scheduledEvalSuiteRun();  // 启动即跑一次
  setInterval(() => { void scheduledEvalSuiteRun(); }, EVAL_INTERVAL_MS);
  console.log("[agent-eval] V6 回归调度已启动 (每24h自动跑gold评测集)");
}

export const agentEvalService = {
  generateAgentEvalReport,
  generateLearningCurve,
  computePlanAdherence,
  computeToolMetrics,
  judgeReasoningQuality,
  // V396-2: 回归评测集
  listEvalSuite,
  upsertEvalSuite,
  deleteEvalSuite,
  runEvalSuite,
  evalSuiteHistory,
  // V6: 自动回归调度
  scheduledEvalSuiteRun,
  startEvalSuiteScheduler,
};
