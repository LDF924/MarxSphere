// agent-task-export.ts — V395-8: 任务结果导出 Markdown
// 目标/状态/计划/步骤详情/执行日志/成本对比 → 可下载 .md
import type { AgentTaskRecord } from "./agent-task-service.js";
import type { AgentExecLog } from "./agent-exec-log.js";

const TYPE_LABELS: Record<string, string> = { retrieve: "检索", reason: "推理", write: "写作", review: "评审" };
const STATUS_LABELS: Record<string, string> = {
  planning: "规划中", running: "执行中", paused: "已暂停", awaiting_approval: "等待审批",
  completed: "已完成", failed: "失败", cancelled: "已取消",
};

/** 生成任务 Markdown 报告（导出用） */
export function renderTaskMarkdown(task: AgentTaskRecord, logs: AgentExecLog[]): string {
  const lines: string[] = [];
  lines.push(`# Agent 任务报告`);
  lines.push("");
  lines.push(`- **目标**: ${task.goal}`);
  lines.push(`- **状态**: ${STATUS_LABELS[task.status] || task.status}`);
  lines.push(`- **任务 ID**: ${task.id}`);
  lines.push(`- **创建时间**: ${task.createdAt ? new Date(task.createdAt).toLocaleString("zh-CN") : "-"}`);
  lines.push(`- **循环轮次**: ${task.loopCount + 1}`);
  // V395-6: 成本对比
  const est = task.estimatedCostCents ?? 0;
  const act = task.actualCostCents ?? 0;
  lines.push(`- **成本**: 预估 ¥${(est / 100).toFixed(3)} → 实际 ¥${(act / 100).toFixed(3)}${act > 0 ? `（偏差 ${((act - est) / Math.max(est, 1) * 100).toFixed(1)}%）` : "（执行中）"}`);
  if (task.progress) lines.push(`- **进度**: ${task.progress}`);
  lines.push("");

  // 计划与步骤
  lines.push(`## 执行计划（${task.plan.length} 步）`);
  lines.push("");
  for (const [i, s] of task.plan.entries()) {
    const status = s.status === "done" ? "✅" : s.status === "running" ? "⏳" : s.status === "failed" ? "❌" : "⬜";
    lines.push(`### ${status} ${i + 1}. ${s.title}（${TYPE_LABELS[s.type] || s.type}）`);
    if (s.query) lines.push(`- 查询: ${s.query}`);
    if (s.source) lines.push(`- 来源: ${s.source}`);
    if (s.verification) lines.push(`- 验证: ${s.verification.verified ? "✅ 通过" : "⚠️ 未通过"}（${s.verification.how}）`);
    if (s.result) lines.push(`- 摘要: ${s.result}`);
    if (s.detail) lines.push("");
    if (s.detail) lines.push(`<details><summary>完整详情</summary>\n\n${s.detail}\n\n</details>`);
    lines.push("");
  }

  // 循环评估
  if (task.reflectLog && task.reflectLog.length > 0) {
    lines.push(`## 循环评估（reflect）`);
    lines.push("");
    for (const r of task.reflectLog) {
      lines.push(`- 第 ${r.round} 轮: ${r.verdict === "pass" ? "✅ 达标" : "⚠️ 未达标"} 评分 ${r.score.toFixed(2)}${r.issues.length > 0 ? ` — ${r.issues.join("; ")}` : ""}`);
    }
    lines.push("");
  }

  // 执行日志
  if (logs.length > 0) {
    lines.push(`## 执行日志（最近 ${logs.length} 条）`);
    lines.push("");
    lines.push("| 时间 | 动作 | 工具 | 状态 | 摘要 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const l of logs) {
      const ts = l.createdAt ? new Date(l.createdAt).toLocaleString("zh-CN", { hour12: false }) : "-";
      const summary = String(l.outputSummary || l.inputSummary || "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 60);
      lines.push(`| ${ts} | ${l.action} | ${l.tool || "-"} | ${l.status} | ${summary} |`);
    }
    lines.push("");
  }

  // 最终结果
  lines.push(`## 最终结果`);
  lines.push("");
  lines.push(task.result || "（任务尚未完成，无最终结果）");
  lines.push("");
  return lines.join("\n");
}

export const agentTaskExport = { renderTaskMarkdown };
