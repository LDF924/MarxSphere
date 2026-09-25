/**
 * 任务体系(Task store API) — 还原自参考产品 index Rt 服务 + taskList store
 * 参考产品端点: GET /tasks?module= / GET|POST|PUT|DELETE /tasks/:id / POST /tasks/:id/switch
 *           POST /tasks/:id/release-lock / GET /tasks/:id/nodes / GET|PUT /tasks/:id/nodes/:nodeId
 * 我方后端形态差异: 任务主体在 /api/research/tasks(projectId 系), 本前端适配层提供
 * "task = {id, projectId, module, title, phase, status}" 统一视图, 所有写操作映射到 research 端点。
 * 映射表见 .claude/reverse-engineering/socialsci-com/VUE-IMPLEMENTATION-ROADMAP.md §9
 * (该目录为本地逆向归档, 不入库不同步; 入口见 .claude/reverse-engineering/README.md)。
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
  /** 后端失败详情 {code,userMessage,canRetry} —— 不透传的话失败原因在界面上恒为空 */
  error?: unknown;
}

export interface SocTaskListOptions {
  module?: string;
  limit?: number;
}

/** 任务列表(参考产品 GET /tasks?module=x) */
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

/** 创建任务(参考产品 POST /tasks) — 我方 research 域: 无 projectId 时创建独立项目容器 */
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
  // 无项目 → 先建项目(参考产品 createTaskWithTitle 语义: 任务即顶层容器)
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
  // 2026-09-15: error 原先没进这个键列表 —— 后端 markFailed 写的 {code,userMessage,canRetry}
  //   一直躺在响应里, 界面上的失败原因却恒为 undefined(三处消费点白读)。
  if (m.error) st.error = m.error;
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

/** 快照保存(参考产品 PUT /tasks/:id saveSnapshot {phase,status,phaseLabel,snapshot}) — 我方 workbench snapshot */
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

/**
 * 章节技能卡批量生成(参考产品 generateSkillsForSections: analyze done 后触发, 后端逐章 LLM)
 *
 * V417: **不再吞错**。原来 `.catch(() => ({ okCount: 0 }))` 把 HTTP 层的失败
 * (网络/401/500) 与"确实 0 条成功"合并成同一个返回值, 调用方据此无从判断 ——
 * 模型全挂时用户看到的仍是绿色成功提示, 只是指导卡空白。
 * 现在失败原样抛出, 由调用方决定怎么报。
 */
export async function batchGenerateSkillCards(projectId: string, sections: Array<{ id: string; title: string; level?: number }>): Promise<{ results?: Array<{ sectionId: string; ok: boolean; error?: string }>; okCount?: number }> {
  return q<{ results?: Array<{ sectionId: string; ok: boolean; error?: string }>; okCount?: number }>(`/research/projects/${projectId}/skill-cards/batch`, { method: "POST", body: { sections } });
}

/** 节点 KV(参考产品 /tasks/:id/nodes/:key {nodeData}) — 我方 /research/projects/:pid/nodes/:key */
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
  await q(`/research/projects/${projectId}/nodes/${nodeKey}`, { method: "PUT", body: { payload } }).catch(() => { /* 409 静默跳过(参考产品语义) */ });
}

/**
 * 只改节点里的几个字段, 其它键原样保留。
 *
 * 为什么不直接用 putNode: PUT 是**整块替换**。前端做部分更新只有两条路 ——
 *   ① 先 GET 再把字段并进去(PUT): 读改写, 与后台任务并发时后写覆盖先写, 漏并一个键就抹掉一个;
 *   ② 直接 PUT 部分 payload: 把节点里没提到的键全部删掉。
 * 后端的 merge 端点用一条 `payload || $1` 完成合并, 两个坑都没有。
 */
export async function mergeNode(projectId: string, nodeKey: string, patch: Record<string, unknown>): Promise<void> {
  await q(`/research/projects/${projectId}/nodes/${nodeKey}/merge`, { method: "PATCH", body: { patch } }).catch(() => { /* 失败不阻塞本地状态 */ });
}

export async function listNodes(projectId: string): Promise<Array<{ node_key: string; payload: unknown; version: number }>> {
  const r = await q<{ nodes?: Array<{ node_key: string; payload: unknown; version: number }> }>(`/research/projects/${projectId}/nodes`);
  return r.nodes ?? [];
}

// ═══ V425 A1: 版本历史域 ═══
//
// 由来: 写作舱**有发布动作却没有历史 UI** —— 素材页「确认并进入创作」、架构页「确认章节」、
//   创作台「进入合稿」各发一次版(phase3_materials / phase2_architecture / phase4_text),
//   后端 `research_versions` 一路记着, 页面却一处都读不到、也退不回去。四条路由
//   (versions / nodes/:key/history / nodes/:key/rollback / versions/:ver/activate)全在后端躺着,
//   前端引用数为 0。
//
// 契约形状(读后端 handler 逐个确认, 不照抄参考产品):
//   GET  versions                  → { versions: [{id, version, label, status, created_at}] }   (version desc)
//   GET  nodes/:key/history        → { history: [{id, version, by_role, note, created_at}] }    (version desc)
//   POST nodes/:key/rollback       → { ok, version }   body { historyId }       404 = 历史不存在
//   POST versions/:ver/activate    → { ok, version }   404 = 版本不存在
//   发布(已有调用点)                → POST publish { label }
//
// ⚠ 这里的 GET 都需要登录态: 后端在没读到 Authorization 时直接把整条路由重定向到 web 登录页
//   (实测 listSources 就这么干过), q() 会拿到非 JSON 体。所以消费者必须能容忍空数组。

/** 阶段版本列表(新 → 旧) */
export async function listVersions(projectId: string): Promise<Array<{ id: string; version: number; label: string; status: string; createdAt: string }>> {
  const r = await q<{ versions?: Array<Record<string, unknown>> }>(`/research/projects/${projectId}/versions`);
  return (r.versions ?? []).map((v) => ({
    id: String(v.id ?? ""),
    version: Number(v.version ?? 0),
    label: String(v.label ?? ""),
    status: String(v.status ?? ""),
    createdAt: String(v.created_at ?? ""),
  }));
}

/** 某节点的历史记录(新 → 旧) */
export interface NodeHistoryItem { id: string; version: number; byRole: string; note: string; createdAt: string }
export async function listNodeHistory(projectId: string, nodeKey: string): Promise<NodeHistoryItem[]> {
  const r = await q<{ history?: Array<Record<string, unknown>> }>(`/research/projects/${projectId}/nodes/${nodeKey}/history`);
  return (r.history ?? []).map((h) => ({
    id: String(h.id ?? ""),
    version: Number(h.version ?? 0),
    byRole: String(h.by_role ?? ""),
    note: String(h.note ?? ""),
    createdAt: String(h.created_at ?? ""),
  }));
}

/**
 * 取某条历史的完整 payload(只读)。
 *
 * 为什么需要它: 历史列表只给元信息, 而唯一碰 payload 的操作是**回滚**(覆盖当前)。
 *   于是"看看上一版写了什么"只能先回滚 —— 对比本来是个只读动作, 不该改数据。
 *
 * 返回的 payload 形状随节点而变(sections 节点是 `{sections: [...]}`, finalize 是
 *   `{mergedFullText, mergedTitle, ...}`), 所以这里原样透出, 由调用方按节点解读。
 */
export async function getNodeHistoryPayload(projectId: string, nodeKey: string, historyId: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await q<{ history?: { payload?: Record<string, unknown> } }>(
      `/research/projects/${projectId}/nodes/${nodeKey}/history/${historyId}`);
    return r.history?.payload ?? null;
  } catch {
    return null;
  }
}

/** 回滚节点到某条历史 —— 会写一条新历史(回滚动作本身留痕), 不删任何东西 */
export async function rollbackNode(projectId: string, nodeKey: string, historyId: string): Promise<void> {
  await q(`/research/projects/${projectId}/nodes/${nodeKey}/rollback`, { method: "POST", body: { historyId } });
}

/** 激活阶段版本(置 published / 其余 superseded / 记 revision_of_version) */
export async function activateVersion(projectId: string, version: number): Promise<void> {
  await q(`/research/projects/${projectId}/versions/${version}/activate`, { method: "POST" });
}

/** 发布一个阶段版本, 返回新版本号(拿不到版本号时返回 null —— 调用方不该据此判成败) */
export async function publishVersion(projectId: string, label: string): Promise<number | null> {
  try {
    const r = await q<{ version?: number }>(`/research/projects/${projectId}/publish`, { method: "POST", body: { label } });
    return typeof r.version === "number" ? r.version : null;
  } catch {
    return null;
  }
}

// ── lastTask_workflow 持久化(参考产品共享层语义) ──
export function persistLastWorkflowTask(taskId: string): void {
  localStorage.setItem(K.lastTaskWorkflow, taskId);
}
export function readLastWorkflowTask(): string | null {
  return localStorage.getItem(K.lastTaskWorkflow);
}
export function clearLastWorkflowTask(): void {
  localStorage.removeItem(K.lastTaskWorkflow);
}

// ── 任务命名(参考产品 createTaskWithTitle: 复用同名模块任务 or 新建) ──
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

// ── 项目列表(V425 B2) ──
//
// 由来: 写作舱**没有项目切换入口** —— 工作台里只能看到 `lastTask_workflow` 指针指向的那一个,
//   要换项目得退回外壳的「历史记录」。后端 listProjects(按 updated_at 倒序、排除已删)
//   与 archiveProject 一直就绪, 前端引用数为 0。
//
// 契约: GET /research/projects → { projects: [...] }(注意是**对象包着数组**, 不是裸数组)
export interface SocProject {
  id: string;
  title: string;
  topic?: string;
  phase: number;
  phaseLabel?: string;
  status: string;
  updatedAt?: string;
}

export async function listProjects(): Promise<SocProject[]> {
  const r = await q<{ projects?: Array<Record<string, unknown>> }>("/research/projects");
  return (r.projects ?? []).map((p) => ({
    id: String(p.id ?? ""),
    title: String(p.title ?? "") || "未命名项目",
    topic: p.topic ? String(p.topic) : undefined,
    phase: Number(p.phase ?? 0),
    phaseLabel: p.phase_label ? String(p.phase_label) : undefined,
    status: String(p.status ?? "active"),
    // 后端返回的是 updated_at(snake), 不是 updatedAt
    updatedAt: p.updated_at ? String(p.updated_at) : undefined,
  }));
}

/** 归档项目(软删, status='archived'; 列表随之不再返回它) */
export async function archiveProject(projectId: string): Promise<void> {
  await q(`/research/projects/${projectId}/archive`, { method: "POST" });
}

/**
 * **删除**项目 —— 与归档是两件事。
 *
 * 后端 `DELETE /research/projects/:id` 走的是 `deleteProject`(硬删, 404 表示不存在)。
 * 项目栏把两者并排提供给用户, 文案里写死了区别: 归档可从「历史记录」找回, 删除不能。
 * (选题界定页底部也有一个「删除当前项目」, 它走的是同一套后端 —— 这条只是把入口
 *  放到项目栏, 免得"想删一个不想要的项目"要先切过去再翻到页面底部。)
 */
export async function deleteProject(projectId: string): Promise<void> {
  await q(`/research/projects/${projectId}`, { method: "DELETE" });
}

/** 任务模块中文标签 */
export function moduleLabel(m: string): string {
  return MODULE_LABELS[m as SocModule] ?? m;
}

// ── 状态机(参考产品 task status → 中文/圆点色) ──
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
