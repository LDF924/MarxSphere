/**
 * 任务体系(Task store API) — 还原自闭源 index-xpWAkSSw.js Rt 服务(L13219-13271) + taskList store
 * 闭源端点: GET /tasks?module= / GET|POST|PUT|DELETE /tasks/:id / POST /tasks/:id/switch
 *           POST /tasks/:id/release-lock / GET /tasks/:id/nodes / GET|PUT /tasks/:id/nodes/:nodeId
 * 我方后端形态差异: 任务主体在 /api/research/tasks(projectId 系), 本前端适配层提供
 * "task = {id, projectId, module, title, phase, status}" 统一视图, 所有写操作映射到 research 端点。
 * 映射表见 docs/socialsci-chunks/VUE-IMPLEMENTATION-ROADMAP.md §9。
 */
import { q } from "./api";
import type { SocModule } from "./constants";
import { K, MODULE_LABELS } from "./constants";

export interface SocTask {
  id: string;
  projectId?: string;
  goal?: string;
  progress?: { stage?: string; current?: number; total?: number; doneAt?: string };
  inputSnapshot?: Record<string, unknown>;
  result?: unknown;
  title: string;
  module: SocModule | string;
  status: string; // in-progress / queued / running / paused / waiting_user / cancelled / failed / done
  phase: number;
  phaseLabel?: string;
  createdAt?: string;
  updatedAt?: string;
  snapshot?: Record<string, unknown>;
  dagNodeId?: string | null;
  jobKind?: string | null;
}

export interface SocTaskListOptions {
  module?: string;
  limit?: number;
}

/** 任务列表(闭源 GET /tasks?module=x) */
export async function listTasks(opts: SocTaskListOptions = {}): Promise<SocTask[]> {
  const p: string[] = [];
  if (opts.module) p.push(`module=${encodeURIComponent(opts.module)}`);
  if (opts.limit) p.push(`limit=${opts.limit}`);
  const r = await q<{ tasks?: Record<string, unknown>[]; items?: Record<string, unknown>[] }>(`/research/tasks${p.length ? "?" + p.join("&") : ""}`);
  const list = (r.tasks ?? r.items ?? []) as Record<string, unknown>[];
  return list.filter((t) => t && typeof t === "object" && !!t.id).map(normTask);
}

export interface CreateTaskInput {
  title: string;
  module: string;
  status?: string;
  phase?: number;
  phaseLabel?: string;
  snapshot?: Record<string, unknown>;
  projectId?: string;
  goal?: string;
  jobKind?: string;
  inputSnapshot?: Record<string, unknown>;
}

/** 创建任务(闭源 POST /tasks) — 我方 research 域: 无 projectId 时创建独立项目容器 */
export async function createTask(input: CreateTaskInput): Promise<SocTask> {
  const { projectId } = input;
  if (projectId) {
    const r = await q<{ task?: SocTask }>(`/research/tasks`, {
      method: "POST",
      body: {
        projectId,
        module: input.module,
        goal: input.goal ?? input.title,
        phase: input.phase ?? 0,
        phaseLabel: input.phaseLabel ?? "",
        jobKind: input.jobKind,
        inputSnapshot: input.inputSnapshot
      }
    });
    return r.task ?? (r as unknown as SocTask);
  }
  // 无项目 → 先建项目(闭源 createTaskWithTitle 语义: 任务即顶层容器)
  const p = await q<{ data?: { id: string }; id?: string }>(`/research/projects`, {
    method: "POST",
    body: { title: input.title, status: "active", phase: input.phase ?? 0, phaseLabel: input.phaseLabel ?? "" }
  });
  const pid = (p.data ?? p).id;
  if (!pid) throw new Error("项目创建失败");
  const r = await q<{ task?: SocTask }>(`/research/tasks`, {
    method: "POST",
    body: { projectId: pid, module: input.module, goal: input.goal ?? input.title, phase: input.phase ?? 0, phaseLabel: input.phaseLabel ?? "", jobKind: input.jobKind, inputSnapshot: input.inputSnapshot }
  });
  const t = (r.task ?? r) as unknown as SocTask;
  return { ...t, projectId: t.projectId ?? pid };
}

/** 后端 task 行 snake_case → SocTask camelCase(审查修复: 后端返回 job_kind/project_id, 前端读 jobKind 恒 undefined → 阶段判定错乱卡 phrase1) */
function normTask(raw: Record<string, unknown>): SocTask {
  const m = raw as unknown as SocTask & {
    job_kind?: string; project_id?: string; phase_label?: string; input_snapshot?: Record<string, unknown>;
    dag_node_id?: string | null; updated_at?: string; created_at?: string; result?: unknown;
  };
  const st: SocTask = {
    id: String(m.id ?? ""),
    title: String(m.title ?? m.goal ?? ""),
    module: String(m.module ?? ""),
    status: String(m.status ?? ""),
    phase: Number(m.phase ?? 0),
    jobKind: m.jobKind ?? m.job_kind ?? "",
    projectId: m.projectId ?? m.project_id,
    goal: m.goal ? String(m.goal) : undefined,
    phaseLabel: m.phaseLabel ?? m.phase_label,
    inputSnapshot: m.inputSnapshot ?? m.input_snapshot,
    dagNodeId: m.dagNodeId ?? m.dag_node_id ?? null,
    createdAt: m.createdAt ?? m.created_at,
    updatedAt: m.updatedAt ?? m.updated_at,
    result: m.result,
    progress: m.progress as SocTask["progress"]
  };
  if (m.snapshot) st.snapshot = m.snapshot;
  return st;
}

export async function getTask(taskId: string): Promise<SocTask | null> {
  try {
    const r = await q<{ task?: Record<string, unknown>; project?: Record<string, unknown> }>(`/research/tasks/${taskId}`);
    const t = (r.task ?? r) as Record<string, unknown>;
    if (!t || !t.id) return null;
    return normTask(t);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

/** 快照保存(闭源 PUT /tasks/:id saveSnapshot {phase,status,phaseLabel,snapshot}) — 我方 workbench snapshot */
export async function saveTaskSnapshot(taskId: string, patch: { phase?: number; status?: string; phaseLabel?: string; snapshot?: Record<string, unknown> }): Promise<void> {
  const task = await getTask(taskId).catch(() => null);
  if (!task?.projectId) return;
  const cur = await getWorkbench(task.projectId).catch(() => ({} as Record<string, unknown>));
  await saveWorkbench(task.projectId, {
    ...cur,
    ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
    ...(patch.status ? { taskStatus: patch.status } : {}),
    ...(patch.phaseLabel !== undefined ? { phaseLabel: patch.phaseLabel } : {}),
    ...(patch.snapshot ? { ...patch.snapshot } : {})
  });
}

/** 阶段快照(project store saveProject 语义) — 我方契约: GET → {snapshot}; PUT body {snapshot} */
export async function getWorkbench(projectId: string): Promise<Record<string, unknown>> {
  const r = await q<{ snapshot?: Record<string, unknown>; data?: Record<string, unknown> }>(`/research/projects/${projectId}/workbench`);
  return (r.snapshot ?? r.data ?? {}) as Record<string, unknown>;
}

export async function saveWorkbench(projectId: string, snapshot: Record<string, unknown>): Promise<void> {
  await q(`/research/projects/${projectId}/workbench`, { method: "PUT", body: { snapshot } }).catch(() => { /* 409/锁容忍 */ });
}

/** 章节技能卡(Phase2 aiSkill 数据源) */
export async function listSkillCards(projectId: string): Promise<Array<Record<string, unknown>>> {
  try {
    const r = await q<{ cards?: Array<Record<string, unknown>> }>(`/research/projects/${projectId}/skill-cards`);
    return r.cards ?? [];
  } catch {
    return [];
  }
}

export async function createSkillCard(projectId: string, body: Record<string, unknown>): Promise<{ card?: Record<string, unknown>; ok?: boolean; error?: string }> {
  return q(`/research/projects/${projectId}/skill-card`, { method: "POST", body });
}

/** 章节技能卡批量生成(闭源 generateSkillsForSections: analyze done 后触发, 后端逐章 LLM) */
export async function batchGenerateSkillCards(projectId: string, sections: Array<{ id: string; title: string; level?: number }>): Promise<{ results?: Array<{ sectionId: string; ok: boolean; error?: string }>; okCount?: number }> {
  return q<{ results?: Array<{ sectionId: string; ok: boolean; error?: string }>; okCount?: number }>(`/research/projects/${projectId}/skill-cards/batch`, { method: "POST", body: { sections } }).catch(() => ({ okCount: 0 }));
}

/** 节点 KV(闭源 /tasks/:id/nodes/:key {nodeData}) — 我方 /research/projects/:pid/nodes/:key */
export async function getNode(projectId: string, nodeKey: string): Promise<Record<string, unknown> | null> {
  try {
    // 我方契约: GET → {node:{payload,...}}; 404 = 节点不存在
    const r = await q<{ node?: { payload?: Record<string, unknown> }; payload?: Record<string, unknown>; data?: Record<string, unknown> }>(`/research/projects/${projectId}/nodes/${nodeKey}`);
    return (r.node?.payload ?? r.payload ?? r.data ?? null) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

export async function putNode(projectId: string, nodeKey: string, payload: Record<string, unknown>): Promise<void> {
  await q(`/research/projects/${projectId}/nodes/${nodeKey}`, { method: "PUT", body: { payload } }).catch(() => { /* 409 静默跳过(闭源语义) */ });
}

export async function listNodes(projectId: string): Promise<Array<{ node_key: string; payload: unknown; version: number }>> {
  const r = await q<{ nodes?: Array<{ node_key: string; payload: unknown; version: number }> }>(`/research/projects/${projectId}/nodes`);
  return r.nodes ?? [];
}

// ── lastTask_workflow 持久化(闭源共享层语义) ──
export function persistLastWorkflowTask(taskId: string): void {
  localStorage.setItem(K.lastTaskWorkflow, taskId);
}
export function readLastWorkflowTask(): string | null {
  return localStorage.getItem(K.lastTaskWorkflow);
}
export function clearLastWorkflowTask(): void {
  localStorage.removeItem(K.lastTaskWorkflow);
}

// ── 任务命名(闭源 createTaskWithTitle: 复用同名模块任务 or 新建) ──
export async function ensureModuleTask(module: SocModule, title: string, taskId?: string): Promise<{ taskId: string; projectId?: string; created: boolean }> {
  if (taskId) {
    const t = await getTask(taskId).catch(() => null);
    if (t) return { taskId: t.id, projectId: t.projectId, created: false };
  }
  // 同名模块任务复用
  const list = await listTasks({ module, limit: 50 }).catch(() => []);
  const hit = list.find((t) => t.title === title && t.module === module && !["cancelled", "failed"].includes(t.status));
  if (hit) return { taskId: hit.id, projectId: hit.projectId, created: false };
  const t = await createTask({ title, module, status: "in-progress", phase: 0, phaseLabel: "" });
  return { taskId: t.id, projectId: t.projectId, created: true };
}

/** 任务模块中文标签 */
export function moduleLabel(m: string): string {
  return MODULE_LABELS[m as SocModule] ?? m;
}

// ── 状态机(闭源 task status → 中文/圆点色) ──
export const taskStatusMeta: Record<string, { label: string; dot: string }> = {
  queued: { label: "排队中", dot: "#94a3b8" },
  running: { label: "运行中", dot: "#2563eb" },
  paused: { label: "已暂停", dot: "#d97706" },
  waiting_user: { label: "等待输入", dot: "#d97706" },
  completed: { label: "已完成", dot: "#059669" },
  done: { label: "已完成", dot: "#059669" },
  failed: { label: "失败", dot: "#dc2626" },
  cancelled: { label: "已取消", dot: "#94a3b8" },
  "in-progress": { label: "进行中", dot: "#2563eb" },
  draft: { label: "草稿", dot: "#94a3b8" }
};
