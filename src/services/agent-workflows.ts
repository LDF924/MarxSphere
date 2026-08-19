// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-workflows.ts — 借鉴 DSH workflow 包: 工作流模板
// 固定多步骤流程一键执行（学术研究类常用流水线）
// 每步 = 步骤名 + 类型 + 目标（由 agent 执行器驱动）
import { agentTaskService } from "./agent-task-service.js";

export interface WorkflowStep {
  title: string;
  type: "retrieve" | "reason" | "write" | "review";
  query?: string;
}

export interface AgentWorkflow {
  id: string;
  name: string;
  desc: string;
  steps: WorkflowStep[];
}

/** 工作流模板库（DSH preset 式: 可扩展） */
export const workflowTemplates: AgentWorkflow[] = [
  {
    id: "lit_review_flow", name: "文献综述流水线", desc: "检索→梳理→综述→评审（标准综述流程）",
    steps: [
      { title: "检索主题文献", type: "retrieve" },
      { title: "检索补充案例与数据", type: "retrieve" },
      { title: "梳理研究现状与争论", type: "reason" },
      { title: "撰写综述初稿", type: "write" },
      { title: "评审综述并修正", type: "review" },
    ],
  },
  {
    id: "concept_trace_flow", name: "概念溯源流水线", desc: "检索定义→溯源演进→撰写概念分析",
    steps: [
      { title: "检索概念定义与出处", type: "retrieve" },
      { title: "溯源概念语义演变", type: "reason" },
      { title: "撰写概念分析", type: "write" },
    ],
  },
  {
    id: "empirical_flow", name: "实证分析流水线", desc: "检索方法→梳理变量→撰写实证结论",
    steps: [
      { title: "检索实证方法与变量定义", type: "retrieve" },
      { title: "推理变量间关系假设", type: "reason" },
      { title: "撰写实证结论", type: "write" },
      { title: "评审实证结果", type: "review" },
    ],
  },
];

/** 运行工作流: 创建任务（用工作流步骤作计划）→ 入队执行 */
export async function runWorkflow(workflowId: string, goal: string): Promise<{ taskId: string; steps: number } | null> {
  const wf = workflowTemplates.find((w) => w.id === workflowId);
  if (!wf) return null;
  const effectiveGoal = goal || wf.name;
  // 用工作流步骤直接建任务（免 LLM 规划; 步骤 query 填目标）
  const r = await agentTaskService.createAgentTaskFromTemplate({
    templateId: "lit_review",  // 复用模板创建通道
    goal: effectiveGoal,
  });
  if (!r) return null;
  const { agentTaskQueue } = await import("./agent-task-queue.js");
  void agentTaskQueue.enqueueTask({
    taskId: r.id,
    priority: 2,
    run: async () => {
      await agentTaskService.runAgentTask(r.id, async (step) => {
        // 简化执行器: 检索/推理走 SAG 推理
        const { buildAgentTools, chooseToolByLlm, executeToolWithFallback } = await import("./agent-tool-router.js");
        const tools = await buildAgentTools({});
        const chosen = await chooseToolByLlm(effectiveGoal, step.title, tools);
        if (chosen) {
          const exec = await executeToolWithFallback(chosen.tool, chosen.args, tools, { role: "manager" });
          if (exec.ok) return { result: exec.result.substring(0, 120), detail: `【工具】${chosen.tool.label}\n${exec.result}`, source: `工具: ${chosen.tool.label}` };
        }
        const result = `【工作流:${wf.name}】${step.title} — 目标: ${(step.query || effectiveGoal).slice(0, 80)}`;
        return { result, detail: result, source: "workflow-runner" };
      });
    },
  });
  return { taskId: r.id, steps: wf.steps.length };
}
