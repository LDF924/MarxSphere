/**
 * orchApi.ts — 编排器 API 客户端(V415)
 *
 * 对应后端 src/api/server.ts 的 /api/orchestrator/*:
 *   capabilities 能力清单(画布节点来源) / templates 模板 / run 启动 / progress 轮询
 *   control 暂停·恢复·取消·提交输入 / runs 历史 / graphs 自定义图存取
 *
 * 与旧实现的区别: 旧画布把节点写死在组件里、执行靠 800ms 轮询 job.status;
 * 现在节点来自后端能力表, 执行是后端的真 DAG(边=依赖), 这里只负责取数/提交/轮询。
 */
import { q } from "@/shared/api";

export type CapabilityKind = "agent_tool" | "endpoint" | "llm_chat" | "llm_gate" | "user_input";

export interface CapabilityField {
  name: string;
  label: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  placeholder?: string;
}

export interface OrchCapability {
  id: string;
  label: string;
  category: string;
  kind: CapabilityKind;
  description: string;
  inputs: string[];
  outputs: string[];
  risk: "safe" | "review" | "deny";
  /** 成本量级(后端按"这步会不会产生 LLM/沙箱开销"标注) */
  cost: "light" | "medium" | "heavy";
  tool?: string;
  artifact?: { where: string; label: string };
  fields?: CapabilityField[];
}

export interface CapabilityField {
  name: string;
  label: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  placeholder?: string;
  /** 能力自带默认值 —— 加进画布的节点会用可编辑的默认值填充(不是空字段) */
  default?: string;
}

export interface OrchTemplate {
  id: string;
  name: string;
  description: string;
  scenario: string;
  cost: "light" | "medium" | "heavy";
  /** 按节点能力的实际 cost 重算的量级(比手写值可信) */
  costEstimated?: "light" | "medium" | "heavy";
  graph: {
    id: string;
    name: string;
    description: string;
    nodes: Array<{ id: string; capabilityId?: string; title: string; params?: Record<string, unknown> }>;
    edges: Array<{ source: string; target: string }>;
  };
}

/** 成本量级 → 中文标签与样式类 */
export const COST_META: Record<string, { label: string; cls: string }> = {
  light: { label: "轻量", cls: "cost-light" },
  medium: { label: "中等", cls: "cost-medium" },
  heavy: { label: "较重", cls: "cost-heavy" },
};

export interface OrchStepRun {
  stepId: string;
  kind: string;
  label?: string;
  status: "pending" | "running" | "done" | "failed" | "waiting_input";
  output?: string;
  error?: string;
  durationMs?: number;
  waitingFields?: Array<{ name: string; prompt: string; required: boolean }>;
  inputsFrom?: string[];
}

export interface OrchProgress {
  ok: boolean;
  runId: string;
  status: "running" | "waiting_input" | "paused" | "done" | "failed" | "cancelled" | "unknown";
  stepLog: OrchStepRun[];
  outputs?: Record<string, string>;
  source?: "live" | "db" | "none";
}

export interface OrchRunRecord {
  runId: string;
  graphId: string | null;
  graphName: string | null;
  input: string;
  status: string;
  stepLog: OrchStepRun[];
  outputs: Record<string, string>;
  finalText: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchGraph {
  id?: string;
  name?: string;
  description?: string;
  basedOn?: string;
  nodes: Array<{ id: string; capabilityId?: string; title?: string; params?: Record<string, unknown> }>;
  edges: Array<{ source: string; target: string }>;
}

export async function fetchCapabilities(refresh = false): Promise<{ capabilities: OrchCapability[]; stats: { total: number; byKind: Record<string, number>; byCategory: Record<string, number> } }> {
  const r = await q<{ capabilities: OrchCapability[]; stats: any }>(`/orchestrator/capabilities${refresh ? "?refresh=1" : ""}`);
  return { capabilities: r.capabilities ?? [], stats: r.stats ?? { total: 0, byKind: {}, byCategory: {} } };
}

export async function fetchTemplates(): Promise<OrchTemplate[]> {
  const r = await q<{ templates: OrchTemplate[] }>("/orchestrator/templates");
  return r.templates ?? [];
}

/** 启动一次编排。graph 为空时用 templateId。 */
export async function startRun(input: { graph?: OrchGraph; templateId?: string; text: string; userValues?: Record<string, string>; model?: string }): Promise<{ runId: string; steps: number; order: string[] }> {
  const r = await q<{ runId: string; steps: number; order: string[] }>("/orchestrator/run", {
    method: "POST",
    body: { graph: input.graph, templateId: input.templateId, input: input.text, userValues: input.userValues, model: input.model },
  });
  return r;
}

export async function fetchProgress(runId: string): Promise<OrchProgress> {
  const r = await q<OrchProgress>(`/orchestrator/progress?runId=${encodeURIComponent(runId)}`);
  return r;
}

export async function controlRun(runId: string, action: "pause" | "resume" | "cancel" | "input", values?: Record<string, string>): Promise<void> {
  await q("/orchestrator/control", { method: "POST", body: { runId, action, values } });
}

export async function fetchRuns(limit = 20): Promise<OrchRunRecord[]> {
  const r = await q<{ runs: OrchRunRecord[] }>(`/orchestrator/runs?limit=${limit}`);
  return r.runs ?? [];
}

export async function listGraphs(): Promise<Array<{ id: string; name: string; description: string | null; basedOn: string | null; nodeCount: number; updatedAt: string }>> {
  const r = await q<{ graphs: any[] }>("/orchestrator/graphs");
  return r.graphs ?? [];
}

export async function loadGraph(id: string): Promise<OrchGraph | null> {
  try {
    const r = await q<{ graph: OrchGraph }>(`/orchestrator/graphs/${encodeURIComponent(id)}`);
    return r.graph ?? null;
  } catch {
    return null;
  }
}

export async function saveGraph(id: string, graph: OrchGraph): Promise<void> {
  await q(`/orchestrator/graphs/${encodeURIComponent(id)}`, { method: "PUT", body: graph });
}

export async function deleteGraph(id: string): Promise<void> {
  await q(`/orchestrator/graphs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** V415: Agent 编排开关(前端可见可切; env 为总闸, env 未开时只读) */
export interface AgentOrchSetting {
  enabled: boolean;
  envAllowed: boolean;
  source: "env-default" | "user" | "env-locked-off";
  maxNodes: number;
  requireConfirm: boolean;
}

export async function fetchAgentSetting(): Promise<AgentOrchSetting> {
  const r = await q<{ settings: AgentOrchSetting }>("/orchestrator/settings");
  return r.settings;
}

export async function updateAgentSetting(patch: Partial<Pick<AgentOrchSetting, "enabled" | "maxNodes" | "requireConfirm">>): Promise<AgentOrchSetting> {
  const r = await q<{ settings: AgentOrchSetting }>("/orchestrator/settings", { method: "PUT", body: patch });
  return r.settings;
}

/** 运行状态 → 中文标签与配色 class(节点徽标/顶部状态共用) */
export const RUN_STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: "草稿", cls: "st-draft" },
  running: { label: "运行中", cls: "st-running" },
  waiting_input: { label: "等待输入", cls: "st-waiting" },
  paused: { label: "已暂停", cls: "st-paused" },
  done: { label: "已完成", cls: "st-completed" },
  failed: { label: "执行失败", cls: "st-failed" },
  cancelled: { label: "已取消", cls: "st-cancelled" },
};

/** 步骤状态 → 画布节点 state(AgentFlowNode 认的是旧 8 值状态机) */
export function stepStatusToNodeState(s: OrchStepRun["status"]): string {
  if (s === "done") return "completed";
  if (s === "running") return "running";
  if (s === "failed") return "failed";
  if (s === "waiting_input") return "paused";
  return "draft";
}
