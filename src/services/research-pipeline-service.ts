// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// research-pipeline-service.ts — SocialSci P0-1: 科研项目容器 + 节点快照 + 版本发布
// 形态对齐(闭源产品交互语义, 原创实现, 不涉源码): 可视化DAG科研工作台的项目层
//   - research_projects: 项目容器, canvas 存 DAG 画布态(nodes/edges), 乐观锁防并发覆盖
//   - research_tasks:    项目级执行任务(并列于 agent_tasks, 不干扰52步推理主链)
//   - research_nodes:    节点快照(node_key 全量 JSON 原子覆盖 + 历史行回滚)
//   - research_versions: 版本发布(指针快照 {nodeKey: historyId}, 不复制 payload)
// 配套: docs/SOCIALSCI-GAP-ANALYSIS.md S-01~S-04/S-10; 迁移 114/115
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";

export interface CanvasNode {
  id: string;
  type: string;                  // goal / object_sample / data_design / literature / analysis / chart / writing / review / deliverable / end
  position: { x: number; y: number };
  data: Record<string, unknown>; // { label, status?, payload? }
}
export interface CanvasEdge { id: string; source: string; target: string; }
export interface CanvasState { nodes: CanvasNode[]; edges: CanvasEdge[]; }

export interface ResearchTask {
  id: string;
  projectId: string;
  dagNodeId: string;
  module: string;
  jobKind: string;
  status: string;
  goal: string;
  retry_of?: string | null;
  error?: unknown;
}

// ═══ 主控 Agent LLM JSON 调用(照 paper-outline-service llmJson 模式) ═══
async function llmJson(prompt: string, modelOverride?: string, maxTokens = 6000): Promise<any | null> {
  const ep = getLlmEndpoint({ model: modelOverride || getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url,
    key: ep.key,
    model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON, 不要其他文字。" }],
    temperature: 0.3,
    maxTokens,
    timeoutMs: 240_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}

// ═══ 项目 CRUD ═══
export async function createProject(input: {
  userId: string; title: string; topic?: string; thesis?: string; style?: string;
}): Promise<{ id: string }> {
  const r = await pool.query(
    `insert into research_projects (user_id, title, topic, thesis, style)
     values ($1,$2,$3,$4,$5) returning id`,
    [input.userId, input.title, input.topic ?? "", input.thesis ?? "", input.style ?? ""]
  );
  return { id: r.rows[0].id };
}

export async function listProjects(userId: string) {
  const r = await pool.query(
    `select id, title, topic, phase, phase_label, status, current_task_id,
            published_version, canvas, updated_at
       from research_projects where user_id=$1 and status<>'deleted'
      order by updated_at desc limit 100`,
    [userId]
  );
  return r.rows;
}

export async function getProject(userId: string, projectId: string) {
  const r = await pool.query(
    `select * from research_projects where id=$1 and user_id=$2`,
    [projectId, userId]
  );
  return r.rows[0] ?? null;
}

export async function updateProjectMeta(userId: string, projectId: string, patch: { title?: string; topic?: string; thesis?: string; style?: string }) {
  const sets: string[] = [];
  const vals: unknown[] = [projectId, userId];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) { sets.push(`${k}=$${vals.length + 1}`); vals.push(v); }
  }
  if (!sets.length) return null;
  sets.push(`updated_at=now()`);
  const r = await pool.query(
    `update research_projects set ${sets.join(",")} where id=$1 and user_id=$2 returning id`,
    vals
  );
  return r.rows[0] ?? null;
}

/** 项目归档/删除(软删) */
export async function archiveProject(userId: string, projectId: string) {
  const r = await pool.query(
    `update research_projects set status='archived', updated_at=now()
      where id=$1 and user_id=$2 returning id`,
    [projectId, userId]
  );
  return r.rows[0] ?? null;
}

// ═══ 画布 CRUD(乐观锁: 提交带期望 canvas_version, 不符则 409) ═══
export async function getCanvas(userId: string, projectId: string): Promise<{ canvas: CanvasState; canvasVersion: number } | null> {
  const p = await getProject(userId, projectId);
  if (!p) return null;
  return { canvas: p.canvas ?? { nodes: [], edges: [] }, canvasVersion: p.canvas_version ?? 1 };
}

export async function putCanvas(userId: string, projectId: string, canvas: CanvasState, expectedVersion?: number) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query(
      `select canvas_version from research_projects where id=$1 and user_id=$2 for update`,
      [projectId, userId]
    );
    if (!cur.rows.length) { await client.query("rollback"); return { ok: false as const, code: "NOT_FOUND" }; }
    const curVer = cur.rows[0].canvas_version;
    if (expectedVersion !== undefined && expectedVersion !== curVer) {
      await client.query("rollback");
      return { ok: false as const, code: "CONFLICT", currentVersion: curVer };
    }
    await client.query(
      `update research_projects set canvas=$1, canvas_version=canvas_version+1, updated_at=now()
        where id=$2 and user_id=$3`,
      [JSON.stringify(canvas), projectId, userId]
    );
    await client.query("commit");
    return { ok: true as const, canvasVersion: curVer + 1 };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

// ═══ 执行任务 CRUD ═══
export async function createTask(input: {
  userId: string; projectId: string; dagNodeId?: string; module?: string; jobKind?: string;
  goal?: string; dependsOn?: string[]; phase?: number; plan?: unknown[];
  inputSnapshot?: Record<string, unknown>;
}): Promise<ResearchTask> {
  const id = randomUUID();
  await pool.query(
    `insert into research_tasks
       (id, project_id, user_id, dag_node_id, module, job_kind, phase, goal, depends_on, plan, input_snapshot, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued')`,
    [
      id, input.projectId, input.userId,
      input.dagNodeId ?? "", input.module ?? "workflow", input.jobKind ?? "analyze",
      input.phase ?? 0, input.goal ?? "",
      JSON.stringify(input.dependsOn ?? []), JSON.stringify(input.plan ?? []),
      JSON.stringify(input.inputSnapshot ?? {}),
    ]
  );
  return { id, projectId: input.projectId, dagNodeId: input.dagNodeId ?? "", module: input.module ?? "workflow", jobKind: input.jobKind ?? "analyze", status: "queued", goal: input.goal ?? "" };
}

export async function listTasks(userId: string, projectId?: string, status?: string) {
  const clauses = ["user_id=$1"];
  const vals: unknown[] = [userId];
  if (projectId) { vals.push(projectId); clauses.push(`project_id=$${vals.length}`); }
  if (status) { vals.push(status); clauses.push(`status=$${vals.length}`); }
  const r = await pool.query(
    `select * from research_tasks where ${clauses.join(" and ")} order by created_at desc limit 100`,
    vals
  );
  return r.rows;
}

export async function getTask(userId: string, taskId: string) {
  const r = await pool.query(
    `select * from research_tasks where id=$1 and user_id=$2`,
    [taskId, userId]
  );
  return r.rows[0] ?? null;
}

export async function updateTaskStatus(userId: string, taskId: string, status: string, patch: { error?: unknown; progress?: unknown; result?: unknown } = {}) {
  const sets = ["status=$3", "updated_at=now()"];
  const vals: unknown[] = [taskId, userId, status];
  if (patch.error !== undefined) { sets.push(`error=$${vals.length + 1}`); vals.push(JSON.stringify(patch.error)); }
  if (patch.progress !== undefined) { sets.push(`progress=$${vals.length + 1}`); vals.push(JSON.stringify(patch.progress)); }
  const r = await pool.query(
    `update research_tasks set ${sets.join(",")} where id=$1 and user_id=$2 returning id, status`,
    vals
  );
  return r.rows[0] ?? null;
}

/** 任务四态控制(cancel/pause/resume/retry 语义对齐 agent-task-service controlAgentTask) */
export async function controlTask(userId: string, taskId: string, action: "cancel" | "pause" | "resume" | "retry"): Promise<ResearchTask | null> {
  const t = await getTask(userId, taskId);
  if (!t) return null;
  let next: string;
  switch (action) {
    case "cancel": next = "cancelled"; break;
    case "pause": next = t.status === "running" || t.status === "queued" ? "paused" : t.status; break;
    case "resume": next = t.status === "paused" || t.status === "failed" ? "queued" : t.status; break;
    case "retry": {
      if (t.status !== "failed" && t.status !== "cancelled") return t;
      // 追链: 建子任务 retry_of=原任务, 状态 queued(执行引擎会重新入队)
      const id = randomUUID();
      await pool.query(
        `insert into research_tasks
           (id, project_id, user_id, dag_node_id, module, job_kind, phase, goal, depends_on, plan, status, retry_of, input_snapshot, progress)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12,'{}')`,
        [id, t.project_id, userId, t.dag_node_id, t.module, t.job_kind, t.phase, t.goal, t.depends_on, t.plan, t.id, t.input_snapshot]
      );
      return { ...t, id, status: "queued", retry_of: t.id } as ResearchTask;
    }
    default: return t;
  }
  if (next === t.status) return t;
  await pool.query(
    `update research_tasks set status=$3, updated_at=now() where id=$1 and user_id=$2`,
    [taskId, userId, next]
  );
  return { ...t, status: next };
}

// ═══ 节点快照(原子覆盖 + 历史行) ═══
export async function getNode(userId: string, projectId: string, nodeKey: string) {
  const r = await pool.query(
    `select n.* from research_nodes n
       join research_projects p on p.id=n.project_id
      where n.project_id=$1 and n.node_key=$2 and p.user_id=$3`,
    [projectId, nodeKey, userId]
  );
  return r.rows[0] ?? null;
}

export async function listNodes(userId: string, projectId: string) {
  const r = await pool.query(
    `select n.node_key, n.version, n.source_role, n.updated_at from research_nodes n
       join research_projects p on p.id=n.project_id
      where n.project_id=$1 and p.user_id=$2 order by n.node_key`,
    [projectId, userId]
  );
  return r.rows;
}

/** 原子覆盖写节点: 当前 upsert(version+1) + 历史 append(旧 payload), 单事务 */
export async function putNode(
  userId: string, projectId: string, nodeKey: string,
  payload: unknown, opts: { taskId?: string; sourceRole?: string; note?: string } = {}
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const owned = await client.query(
      `select 1 from research_projects where id=$1 and user_id=$2`,
      [projectId, userId]
    );
    if (!owned.rows.length) { await client.query("rollback"); return { ok: false as const, code: "NOT_FOUND" }; }
    const cur = await client.query(
      `select id, version from research_nodes where project_id=$1 and node_key=$2 for update`,
      [projectId, nodeKey]
    );
    if (cur.rows.length) {
      const node = cur.rows[0];
      // 旧 payload 进历史
      const hist = await client.query(
        `select payload from research_nodes where id=$1`,
        [node.id]
      );
      await client.query(
        `insert into research_node_history (node_id, version, payload, parent_version, by_role, note)
         values ($1,$2,$3,$2,$4,$5)`,
        [node.id, node.version, hist.rows[0].payload, opts.sourceRole ?? "user", opts.note ?? ""]
      );
      await client.query(
        `update research_nodes set payload=$1, version=version+1, task_id=coalesce($2,task_id),
                source_role=$3, updated_at=now()
          where id=$4`,
        [JSON.stringify(payload), opts.taskId ?? null, opts.sourceRole ?? "user", node.id]
      );
      await client.query("commit");
      return { ok: true as const, version: node.version + 1 };
    }
    // 新建
    const ins = await client.query(
      `insert into research_nodes (project_id, task_id, node_key, payload, version, source_role)
       values ($1,$2,$3,$4,1,$5) returning id`,
      [projectId, opts.taskId ?? null, nodeKey, JSON.stringify(payload), opts.sourceRole ?? "user"]
    );
    await client.query("commit");
    return { ok: true as const, version: 1, nodeId: ins.rows[0].id };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** 节点历史(回滚数据源) */
export async function listNodeHistory(userId: string, projectId: string, nodeKey: string, limit = 50) {
  const r = await pool.query(
    `select h.id, h.version, h.by_role, h.note, h.created_at
       from research_node_history h
       join research_nodes n on n.id=h.node_id
       join research_projects p on p.id=n.project_id
      where n.project_id=$1 and n.node_key=$2 and p.user_id=$3
      order by h.version desc limit $4`,
    [projectId, nodeKey, userId, limit]
  );
  return r.rows;
}

/** 回滚: 取历史 payload 回写当前(version+1 新历史行) */
export async function rollbackNode(userId: string, projectId: string, nodeKey: string, historyId: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const owned = await client.query(
      `select 1 from research_projects where id=$1 and user_id=$2`,
      [projectId, userId]
    );
    if (!owned.rows.length) { await client.query("rollback"); return { ok: false as const, code: "NOT_FOUND" }; }
    const hist = await client.query(
      `select h.payload, h.version as from_version from research_node_history h
         join research_nodes n on n.id=h.node_id
        where h.id=$1 and n.project_id=$2 and n.node_key=$3`,
      [historyId, projectId, nodeKey]
    );
    if (!hist.rows.length) { await client.query("rollback"); return { ok: false as const, code: "HISTORY_NOT_FOUND" }; }
    const cur = await client.query(
      `select id, version, payload from research_nodes where project_id=$1 and node_key=$2 for update`,
      [projectId, nodeKey]
    );
    if (!cur.rows.length) { await client.query("rollback"); return { ok: false as const, code: "NODE_NOT_FOUND" }; }
    const node = cur.rows[0];
    // 当前进历史(回滚动作本身留痕)
    await client.query(
      `insert into research_node_history (node_id, version, payload, parent_version, by_role, note)
       values ($1,$2,$3,$4,'system','rollback to v'||$5)`,
      [node.id, node.version, node.payload, hist.rows[0].from_version]
    );
    await client.query(
      `update research_nodes set payload=$1, version=version+1, updated_at=now() where id=$2`,
      [hist.rows[0].payload, node.id]
    );
    await client.query("commit");
    return { ok: true as const, version: node.version + 1 };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

// ═══ 版本发布(指针快照) ═══
export async function publishVersion(userId: string, projectId: string, label: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const owned = await client.query(
      `select published_version from research_projects where id=$1 and user_id=$2 for update`,
      [projectId, userId]
    );
    if (!owned.rows.length) { await client.query("rollback"); return { ok: false as const, code: "NOT_FOUND" }; }
    const nextVer = owned.rows[0].published_version + 1;
    // 指针快照: 收集当前各节点最新历史/当前状态
    const nodes = await client.query(
      `select node_key, id, version from research_nodes where project_id=$1`,
      [projectId]
    );
    const snapshot: Record<string, { nodeId: string; historyId: string | null; version: number }> = {};
    for (const n of nodes.rows) {
      const h = await client.query(
        `select id from research_node_history where node_id=$1 order by version desc limit 1`,
        [n.id]
      );
      snapshot[n.node_key] = { nodeId: n.id, historyId: h.rows[0]?.id ?? null, version: n.version };
    }
    await client.query(
      `insert into research_versions (project_id, version, label, snapshot, created_by)
       values ($1,$2,$3,$4,$5)`,
      [projectId, nextVer, label, JSON.stringify(snapshot), userId]
    );
    await client.query(
      `update research_projects set published_version=$2, phase_label=$3, updated_at=now() where id=$1`,
      [projectId, nextVer, label]
    );
    await client.query("commit");
    return { ok: true as const, version: nextVer };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function listVersions(userId: string, projectId: string) {
  const r = await pool.query(
    `select v.id, v.version, v.label, v.status, v.created_at from research_versions v
       join research_projects p on p.id=v.project_id
      where v.project_id=$1 and p.user_id=$2 order by v.version desc`,
    [projectId, userId]
  );
  return r.rows;
}

/** P-A 终稿激活(闭源 #651 activate 语义): 把指定版本置 published/终稿, 其余版本 superseded,
 *  记录 project.revision_of_version 指向激活版本。 */
export async function activateVersion(userId: string, projectId: string, version: number) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const owned = await client.query(
      `select 1 from research_projects where id=$1 and user_id=$2 for update`,
      [projectId, userId]
    );
    if (!owned.rows.length) { await client.query("rollback"); return { ok: false as const, code: "PROJECT_NOT_FOUND" }; }
    const ver = await client.query(
      `select 1 from research_versions where project_id=$1 and version=$2`,
      [projectId, version]
    );
    if (!ver.rows.length) { await client.query("rollback"); return { ok: false as const, code: "VERSION_NOT_FOUND" }; }
    // 旧激活版本 → superseded; 目标版本 → published(终稿)(research_versions 无 updated_at 列, 只改 status)
    await client.query(
      `update research_versions set status='superseded'
        where project_id=$1 and status='published' and version<>$2`,
      [projectId, version]
    );
    await client.query(
      `update research_versions set status='published'
        where project_id=$1 and version=$2`,
      [projectId, version]
    );
    await client.query(
      `update research_projects set revision_of_version=$2, updated_at=now() where id=$1`,
      [projectId, version]
    );
    await client.query("commit");
    return { ok: true as const, version };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

// ═══ DAG 模板(标准五阶段 → 画布节点+连线) ═══
export function dagTemplateFiveStage(topic: string): CanvasState {
  const x0 = 60;
  const stages: Array<{ type: CanvasNode["type"]; label: string }> = [
    { type: "goal", label: "研究目标" },
    { type: "object_sample", label: "对象/样本" },
    { type: "literature", label: "文献证据" },
    { type: "data_design", label: "数据与研究设计" },
    { type: "analysis", label: "数据分析" },
    { type: "chart", label: "图表产物" },
    { type: "writing", label: "论文写作" },
    { type: "review", label: "审稿修订" },
    { type: "deliverable", label: "交付成果" },
    { type: "end", label: "任务终点" },
  ];
  const nodes: CanvasNode[] = stages.map((s, i) => ({
    id: `n_${i + 1}`,
    type: s.type,
    position: { x: x0, y: 60 + i * 96 },
    data: { label: i === 0 ? `${s.label}·${topic}` : s.label, status: "idle" },
  }));
  const edges: CanvasEdge[] = nodes.slice(0, -1).map((n, i) => ({
    id: `e_${i + 1}`,
    source: n.id,
    target: nodes[i + 1].id,
  }));
  return { nodes, edges };
}

// ═══ NL → DAG(自然语言任务描述 → 研究框架节点, 对齐画布任务形态) ═══
export async function nlToDag(userId: string, projectId: string, description: string): Promise<{ canvas: CanvasState } | { error: string }> {
  const ans = await llmJson(`你是科研任务规划专家。把用户的一句话研究需求拆成 DAG 节点(研究流程), 输出 JSON:
{"steps":[{"type":"goal|object_sample|data_design|literature|analysis|chart|writing|review|deliverable","label":"步骤名(一句话)"}]}

用户需求: ${description}
要求: 4-9 步, 类型取自枚举(goal 开头, deliverable 收尾), label 中文简短。`);
  const steps: Array<{ type: string; label: string }> = ans?.steps;
  if (!Array.isArray(steps) || !steps.length) return { error: "AI 未能解析任务结构, 请重试或手动搭建画布" };
  // 强制首尾
  const norm = steps.map((s, i) => ({
    type: i === 0 ? "goal" : i === steps.length - 1 ? "deliverable" : (s.type ?? "analysis"),
    label: s.label ?? `步骤${i + 1}`,
  }));
  const canvas: CanvasState = {
    nodes: norm.map((s, i) => ({
      id: `nl_${i + 1}`,
      type: s.type,
      position: { x: 60, y: 60 + i * 96 },
      data: { label: s.label, status: "idle", fromNl: true },
    })),
    edges: norm.slice(0, -1).map((_, i) => ({ id: `nle_${i + 1}`, source: `nl_${i + 1}`, target: `nl_${i + 2}` })),
  };
  await putCanvas(userId, projectId, canvas);
  return { canvas };
}

// ═══ SocialSci R5: 需求澄清(HAR: clarify/generate → {analysis, questions[5]带id/category/guidance/importance}) ═══
export async function generateClarify(input: {
  title: string; outline?: string; requirements?: string; researchMethod?: string;
  totalWordCount?: number; sampleContent?: string;
}): Promise<{ analysis: string; questions: Array<{ id: string; category: string; question: string; guidance: string; importance: string }> }> {
  const ans = await llmJson(`你是科研需求澄清专家。分析用户研究方案, 找出关键模糊点, 输出 JSON:
{"analysis":"总体分析(150字内: 已明确什么+存在哪些关键模糊点)","questions":[{"id":"q1","category":"scope|method|theory|innovation|data","question":"澄清问题(一句话)","guidance":"引导用户回答的具体方向(50-80字, 含示例)","importance":"高|中|低"}]}

【研究主题】${input.title}
【目录】${input.outline?.slice(0, 1500) ?? ""}
${input.researchMethod ? `【方法】${input.researchMethod}` : ""}
${input.requirements ? `【已有要求】${input.requirements.slice(0, 500)}` : ""}
${input.totalWordCount ? `【目标字数】${input.totalWordCount}` : ""}

要求: 5个问题, 每个带可操作的 guidance(含举例), category 按 scope/method/theory/innovation/data 分类。`, undefined, 4000);
  const questions = Array.isArray(ans?.questions) ? ans.questions.slice(0, 5) : [];
  return {
    analysis: String(ans?.analysis ?? "已分析研究方案, 见以下澄清问题。"),
    questions: questions.map((q: Record<string, unknown>, i: number) => ({
      id: String(q.id ?? `q${i + 1}`),
      category: String(q.category ?? "scope"),
      question: String(q.question ?? ""),
      guidance: String(q.guidance ?? ""),
      importance: String(q.importance ?? "中"),
    })),
  };
}

// ═══ 主控 Agent P1 分析(变量/章节规划 → analysis 节点) ═══
export async function runMainAgentAnalysis(userId: string, projectId: string, opts: { taskId?: string } = {}) {
  const project = await getProject(userId, projectId);
  if (!project) return { ok: false as const, code: "NOT_FOUND" };
  const ans = await llmJson(`你是科研架构分析专家(主控智能体)。基于研究主题生成科研架构, 输出 JSON(R3 闭源 SectionsView 对齐: 定性方法用定性变量角色):
{"variables":{"kind":"qualitative|quantitative|mixed","list":[{"name":"变量名","role":"quantitative 时: dependent|independent|mediator|moderator|control; qualitative 时: influence|outcome|mechanism|context|background","description":"该变量的操作化语义描述(含为何作此角色)"}]},
 "hypotheses":[{"id":"H1","type":"main|mediation|moderation","text":"完整假设表述","theory":"基于 XX 理论/假说+机制解释"}],
 "chapterPlan":[{"title":"章节标题","level":1,"requirements":"该章写作要求(一句话)","skillType":"intro|literature|theory|method|result|conclusion","wordCount":按总字数比例的该章目标字数}],
 "logicChain":"研究逻辑主线(一段话, 闭源'研究逻辑'风格: 起承转结构说明)",
 "clarifyQuestions":["澄清问题(如无则[])"]}

研究主题: ${project.topic || project.title}
研究方法: ${project.style || "mixed"}
【目标字数】10000 字(社会科学论文默认, 按此分配每章 wordCount; 若主题明显偏长/偏短可自行微调)`);
  const nodePayload = {
    variables: ans?.variables ?? { kind: "unknown", list: [] },
    hypotheses: ans?.hypotheses ?? [],
    chapterPlan: ans?.chapterPlan ?? [],
    logicChain: ans?.logicChain ?? "",
    clarifyQuestions: ans?.clarifyQuestions ?? [],
    stepAnalysisTexts: { "1": "", "2": "", "3": "" },
    generatedAt: new Date().toISOString(),
  };
  await putNode(userId, projectId, "analysis", nodePayload, { taskId: opts.taskId, sourceRole: "main_agent" });
  return { ok: true as const, payload: nodePayload };
}
