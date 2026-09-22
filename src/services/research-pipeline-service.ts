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
export interface CanvasEdge { id: string; source: string; target: string; data?: Record<string, unknown>; }
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

export async function updateProjectMeta(userId: string, projectId: string, patch: { title?: string; topic?: string; thesis?: string; style?: string; phase?: number; phaseLabel?: string }) {
  // 列名白名单: patch 来自请求体, 直接拼 `${k}=$n` 等于把 SQL 语句结构交给调用方
  const COLS: Record<string, string> = { title: "title", topic: "topic", thesis: "thesis", style: "style", phase: "phase", phaseLabel: "phase_label" };
  const sets: string[] = [];
  const vals: unknown[] = [projectId, userId];
  for (const [k, v] of Object.entries(patch)) {
    const col = COLS[k];
    if (col && v !== undefined) { sets.push(`${col}=$${vals.length + 1}`); vals.push(v); }
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

/**
 * 项目删除(软删, status='deleted')—— 与 archiveProject 只差一个状态值。
 *
 * 与 archive 分开而不是共用一个函数: 语义不同, 合并会让调用方看不出删和归档的区别。
 * 幂等: 已删的行再删仍返回 id(不报 404) —— 重复点删除不该报错。
 */
export async function deleteProject(userId: string, projectId: string) {
  const r = await pool.query(
    `update research_projects set status='deleted', updated_at=now()
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
  if (status) {
    // 支持逗号分隔多状态(running,queued) — RunningTasks 轮询用
    const parts = status.split(",").map((x) => x.trim()).filter(Boolean);
    if (parts.length === 1) { vals.push(parts[0]); clauses.push(`status=$${vals.length}`); }
    else { vals.push(parts); clauses.push(`status = any($${vals.length}::text[])`); }
  }
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
  // 审查 P1: patch.result 曾被静默丢弃 — 经此收尾的任务结果永空(历史中心/任务摘要取不到)
  if (patch.result !== undefined) { sets.push(`result=$${vals.length + 1}`); vals.push(JSON.stringify(patch.result)); }
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

/**
 * 节点**字段级浅合并**(保留未列出的键)。
 *
 * 与 putNode 的区别: putNode 是整块替换(适合"我就是这份完整 payload");
 * 这里适合"我只知道要改哪几个字段"的场景 —— 尤其是前端。
 * 前端拿 PUT 做部分更新必须 GET→并→PUT, 那是读改写, 与后台任务并发时后写覆盖先写,
 * 且一旦漏并某个键(reviewReport 之类)就被静默抹掉。
 * 这条语句在**一条 SQL 里**完成合并, 没有读改写窗口。
 */
export async function mergeNode(
  userId: string, projectId: string, nodeKey: string,
  patch: Record<string, unknown>, opts: { sourceRole?: string; note?: string } = {}
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const owned = await client.query(
      `select 1 from research_projects where id=$1 and user_id=$2`,
      [projectId, userId]
    );
    if (!owned.rows.length) { await client.query("rollback"); return { ok: false as const, code: "NOT_FOUND" as const }; }
    const cur = await client.query(
      `select id, version, payload from research_nodes where project_id=$1 and node_key=$2 for update`,
      [projectId, nodeKey]
    );
    if (!cur.rows.length) {
      // 节点不存在 → 以 patch 为初始 payload 建一条(与 putNode 的"新建"语义一致)
      const ins = await client.query(
        `insert into research_nodes (project_id, node_key, payload, version, source_role)
         values ($1,$2,$3,1,$4) returning version`,
        [projectId, nodeKey, JSON.stringify(patch), opts.sourceRole ?? "user"]
      );
      await client.query("commit");
      return { ok: true as const, version: ins.rows[0].version, created: true };
    }
    const node = cur.rows[0];
    await client.query(
      `insert into research_node_history (node_id, version, payload, parent_version, by_role, note)
       values ($1,$2,$3,$2,$4,$5)`,
      [node.id, node.version, node.payload, opts.sourceRole ?? "user", opts.note ?? ""]
    );
    const upd = await client.query(
      `update research_nodes
          set payload = coalesce(payload,'{}'::jsonb) || $1::jsonb,
              version = version + 1, source_role = $2, updated_at = now()
        where id = $3
        returning version`,
      [JSON.stringify(patch), opts.sourceRole ?? "user", node.id]
    );
    await client.query("commit");
    return { ok: true as const, version: upd.rows[0].version };
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

/**
 * 取**某一条历史**的完整 payload(V425 D3 章节级版本对比的前置)。
 *
 * 由来: 历史列表此前只返回元信息(id/version/by_role/note/created_at), 而唯一会碰 payload 的
 *   操作是 rollback —— **覆盖当前**。于是"看看上一版写了什么"只能靠回滚, 而回滚会改数据,
 *   用户不可能为了对比先滚一版。没有只读通道, 版本历史就只是一个"覆盖按钮"。
 *   对比必须能读到旧内容, 所以补这一条。
 *
 * 归属校验走 project + node_key 两级(与 listNodeHistory 同一套), 不额外信任 historyId 本身。
 */
export async function getNodeHistoryDetail(userId: string, projectId: string, nodeKey: string, historyId: string) {
  const r = await pool.query(
    `select h.id, h.version, h.by_role, h.note, h.created_at, h.payload
       from research_node_history h
       join research_nodes n on n.id = h.node_id
       join research_projects p on p.id = n.project_id
      where h.id=$1 and n.project_id=$2 and n.node_key=$3 and p.user_id=$4`,
    [historyId, projectId, nodeKey, userId]
  );
  return r.rows[0] ?? null;
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
    /**
     * 当前进历史(回滚动作本身留痕)。
     *
     * ⚠ 2026-09-21 修: 这条 INSERT 列了 5 个列却只绑了 4 个参数 —— `$1..$4` 之后直接跟
     *   字面量 `'system'`, 第 5 个占位符 `$5` 没有任何值。PG 直接报
     *   `bind message supplies 4 parameters, but prepared statement requires 5`,
     *   **回滚从头到尾没成功过一次**。之所以一直没被发现: 这个端点此前零调用方
     *   (前端没有回滚入口), 而 `by_role` 有默认值 `'user'`, 列数/值数不匹配在**静态**层面
     *   也看不出来。接版本历史面板时由动作探针第一次真点出来。
     *   修法: 字面量 'system' 挪进值列表, 占位符序号顺延。
     */
    await client.query(
      `insert into research_node_history (node_id, version, payload, parent_version, by_role, note)
       values ($1,$2,$3,$4,'system','rollback to v'||$5)`,
      [node.id, node.version, node.payload, hist.rows[0].from_version, hist.rows[0].from_version]
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
    /**
     * ⚠ 2026-09-18: 这里原来还把 `label` 写进 `research_projects.phase_label`。
     *   而那个列是**阶段名**的列(PATCH /projects/:id 写的是「合稿定稿」这种中文阶段名,
     *   前端 syncPhaseToProject 也在写它)。`label` 却是**版本标签**(`phase4_text`),
     *   两个写入方挤在同一列、语义不同 —— 谁后到谁赢, 阶段名会被覆成英文标签。
     *   该列目前**没有用户可见的读路径**(历史面板读的是 `research_tasks.phase_label`,
     *   不是这个列), 所以是潜在缺陷而非现症; 既然版本标签的权威位置是
     *   `research_versions.label`(下一句就写了), 就不该再往阶段列上写。
     */
    await client.query(
      `update research_projects set published_version=$2, updated_at=now() where id=$1`,
      [projectId, nextVer]
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
  // R10/R16 对齐(闭源 AgentFlowNode): index 序号 + module 徽标 + 输入/输出 meta + systemStart
  const stages: Array<{ type: CanvasNode["type"]; label: string; module: string; input: string; output: string }> = [
    { type: "goal", label: "研究目标", module: "SYSTEM", input: "用户目标", output: "研究框架" },
    { type: "object_sample", label: "对象/样本", module: "STANDARD WORKFLOW", input: "框架", output: "样本方案" },
    { type: "literature", label: "文献证据", module: "STANDARD WORKFLOW", input: "主题", output: "文献清单" },
    { type: "data_design", label: "数据与研究设计", module: "STANDARD WORKFLOW", input: "变量", output: "数据方案" },
    { type: "analysis", label: "数据分析", module: "STANDARD WORKFLOW", input: "数据", output: "实证结果" },
    { type: "chart", label: "图表产物", module: "STANDARD WORKFLOW", input: "结果", output: "图表" },
    { type: "writing", label: "论文写作", module: "STANDARD WORKFLOW", input: "素材", output: "章节草稿" },
    { type: "review", label: "审稿修订", module: "STANDARD WORKFLOW", input: "草稿", output: "修改稿" },
    { type: "deliverable", label: "交付成果", module: "STANDARD WORKFLOW", input: "修改稿", output: "论文终稿" },
    { type: "end", label: "任务终点", module: "SYSTEM", input: "终稿", output: "交付" },
  ];
  const nodes: CanvasNode[] = stages.map((s, i) => ({
    id: `n_${i + 1}`,
    type: s.type,
    position: { x: x0, y: 60 + i * 96 },
    data: {
      label: i === 0 ? `${s.label}·${topic}` : s.label,
      status: "idle",
      index: i === 0 ? "00" : String(i).padStart(2, "0"),
      module: s.module,
      input: s.input,
      output: s.output,
      systemStart: i === 0,
    },
  }));
  // E2(闭源 agent-edge- 自动补边): 模板边带 kind:auto(前端渲染为绿虚线), 与用户手动边(蓝实线)区分
  const edges: CanvasEdge[] = nodes.slice(0, -1).map((n, i) => ({
    id: `e_${i + 1}`,
    source: n.id,
    target: nodes[i + 1].id,
    data: { kind: "auto" },
  }));
  return { nodes, edges };
}

// ═══ NL → DAG(自然语言任务描述 → 可执行流程) ═══
/**
 * 2026-09-20 重做。原实现只产出 `{id,type,label}` 的**绘制用**画布, 有两个已实测的问题:
 *   ① 本仓没有任何视图读 `research_projects.canvas`, 也没有把画布节点变成 research_tasks
 *      的路径(8 个有 canvas 的项目, 画布节点从未变成过任务)—— 接出去就是个执行不了的视图;
 *   ② 速览模式 (`/workbench/quick`) 的画布是**纯客户端状态**, 从不落库, 它的「开始执行」
 *      走 `POST /orchestrator/run`(自包含, 不碰项目)—— 所以"生成→落 canvas 列→再读回来"
 *      那条路与真正能执行的那条**根本不是同一条**。
 *
 * 现在把"拆解"与"投递"分开: `planFromNl` 只负责调 LLM 出步骤(纯函数, 不落库);
 * 两个入口各自把结果投到**各自能执行的地方** —— 速览模式走 `/orchestrator/nl-to-dag`(载入
 * 前端画布, 接着点「开始执行」), 项目工作台走 `nlToDag`(落 canvas 列, 供项目级流程查看)。
 *
 * 节点 → 能力对应, 抄 `orchestrator-templates.ts` 的既有约定, 不自造:
 *   澄清/采集 → io:clarify · 检索 → tool:sag_search(真实检索能力) · 撰写 → io:llm-write ·
 *   成稿/审校 → io:quality-gate。chart 不给绑定, 后端按 llm_chat 兜底 —— 宁缺勿错。
 *
 * 「这一步做什么」同时写进 `label` 与 `goal`: 图执行时节点取到的是那一条自足指令,
 * 下游 `{{outputs.<nodeId>}}` 代入的就是它的产物文本。不往 params 里塞参数骨架 ——
 * 能力自带 fields 与默认模板, 塞了反而可能把默认覆盖掉。
 */
const NL_TYPE_TO_CAP: Record<string, string | undefined> = {
  goal: "io:clarify",
  object_sample: "io:clarify",
  literature: "tool:sag_search",
  analysis: "io:llm-write",
  data_design: "io:llm-write",
  chart: undefined,
  writing: "io:llm-write",
  review: "io:quality-gate",
  deliverable: "io:quality-gate",
};
// 这些能力的必填字段名按**类型**给值。为什么能这么做: 类型(goal/literature/writing/…)
//   是我自己枚举里的, 字段名由能力注册表固定(io:clarify{title,body} / tool:sag_search{query} /
//   io:quality-gate{criteria,text} / io:llm-write{system,task}), 两边都在本仓可查, 不是猜的。
//   不这么做的后果实测过: 只写 label 的话, 上图执行时 tool:sag_search 拿不到 query、
//   io:quality-gate 拿不到 criteria, 节点会空跑。
const NL_TYPE_FIELDS: Record<string, string[]> = {
  goal: ["title", "body"],
  object_sample: ["title", "body"],
  literature: ["query"],
  analysis: ["task"],
  data_design: ["task"],
  writing: ["task"],
  review: ["criteria", "text"],
  deliverable: ["criteria", "text"],
};

export interface NlStep {
  id: string;
  type: string;
  label: string;
  goal: string;
  capabilityId?: string;
  /** 该能力的必填字段 → 值(见 NL_TYPE_FIELDS 的说明) */
  params?: Record<string, string>;
}

/** 一句话 → 步骤序列(只拆解, 不落库; 两个入口共用) */
export async function planFromNl(description: string): Promise<{ steps: NlStep[]; edges: Array<{ source: string; target: string }> } | { error: string }> {
  const ans = await llmJson(`你是科研任务规划专家。把用户的一句话研究需求拆成 DAG 节点(研究流程), 输出 JSON:
{"steps":[{"type":"goal|object_sample|data_design|literature|analysis|chart|writing|review|deliverable","label":"步骤名(一句话)","task":"这一步要做什么(一句可直接执行的指令)"}]}

用户需求: ${description}
要求: 4-9 步, 类型取自枚举(goal 开头, deliverable 收尾), label 中文简短, task 具体到能直接交给执行器。`);
  const steps: Array<{ type: string; label: string; task?: string }> = ans?.steps;
  if (!Array.isArray(steps) || !steps.length) return { error: "AI 未能解析任务结构, 请重试或手动搭建画布" };
  const out: NlStep[] = steps.map((s, i) => {
    // 强制首尾(闭源同口径: goal 起、deliverable 收)
    const type = i === 0 ? "goal" : i === steps.length - 1 ? "deliverable" : String(s.type ?? "analysis");
    const label = String(s.label ?? `步骤${i + 1}`);
    const task = String(s.task ?? "").trim();
    const cap = NL_TYPE_TO_CAP[type];
    const goal = task || label;
    // 必填字段给值 —— 空跑比报错更难发现, 所以宁可把 label 也兜底填进去
    const names = cap ? (NL_TYPE_FIELDS[type] ?? []) : [];
    const params: Record<string, string> = {};
    for (const n of names) params[n] = goal;
    return {
      id: `nl_${i + 1}`, type, label, goal,
      ...(cap ? { capabilityId: cap } : {}),
      ...(Object.keys(params).length ? { params } : {}),
    };
  });
  return { steps: out, edges: out.slice(0, -1).map((_, i) => ({ source: out[i].id, target: out[i + 1].id })) };
}

/** 项目工作台的 NL→DAG: 落 `research_projects.canvas`(供项目级流程查看/后续接线) */
export async function nlToDag(userId: string, projectId: string, description: string): Promise<{ canvas: CanvasState } | { error: string }> {
  const planned = await planFromNl(description);
  if ("error" in planned) return planned;
  const canvas: CanvasState = {
    nodes: planned.steps.map((s, i) => ({
      id: s.id,
      type: s.type,
      position: { x: 60, y: 60 + i * 96 },
      data: {
        label: s.goal === s.label ? s.label : `${s.label}: ${s.goal}`,
        goal: s.goal,
        status: "idle",
        fromNl: true,
        index: String(i + 1).padStart(2, "0"),
        ...(s.capabilityId ? { capabilityId: s.capabilityId } : {}),
        ...(s.params ? { params: s.params } : {}),
      },
    })),
    edges: planned.edges.map((e, i) => ({ id: `nle_${i + 1}`, ...e })),
  };
  await putCanvas(userId, projectId, canvas);
  return { canvas };
}

/**
 * 速览模式的 NL→DAG: **不落库**, 直接回给前端画布吃。
 * 落库那条(de `nlToDag`)产出的是项目画布, 而速览模式的「开始执行」走 `/orchestrator/run`,
 * 读的是前端内存里的图 —— 两者不通用。这个入口把 `planFromNl` 的结果按 OrchestratorGraph
 * 的形状回给前端, 于是「生成→开始执行」全程在同一条能跑的链上。
 */
export async function nlToOrchestratorGraph(description: string): Promise<{ graph: { name: string; description: string; nodes: Array<{ id: string; capabilityId?: string; title: string }>; edges: Array<{ source: string; target: string }> } } | { error: string }> {
  const planned = await planFromNl(description);
  if ("error" in planned) return planned;
  return {
    graph: {
      name: description.slice(0, 40) || "AI 拆解流程",
      description: `由一句话需求拆解: ${description.slice(0, 120)}`,
      nodes: planned.steps.map((s) => ({
        id: s.id,
        ...(s.capabilityId ? { capabilityId: s.capabilityId } : {}),
        // 标题即指令: 执行器读到的就是它, 下游 {{outputs.id}} 代入的也是它
        title: s.goal === s.label ? s.label : `${s.label}: ${s.goal}`,
        ...(s.params ? { params: s.params } : {}),
      })),
      edges: planned.edges,
    },
  };
}

// ═══ SocialSci R5: 需求澄清(HAR: clarify/generate → {analysis, questions[5]带id/category/guidance/importance}) ═══
// E4(闭源 2 轮集中补齐): answers(已答上下文)传入 → 第二轮只追问仍模糊的点(≤3 问)
export async function generateClarify(input: {
  title: string; outline?: string; requirements?: string; researchMethod?: string;
  totalWordCount?: number; sampleContent?: string;
  answers?: Array<{ question: string; answer: string }>;
  round?: number;
}): Promise<{ analysis: string; questions: Array<{ id: string; category: string; question: string; guidance: string; importance: string }> }> {
  const round = input.round ?? 0;
  const answersBlock = Array.isArray(input.answers) && input.answers.length
    ? input.answers.map((a) => `- Q: ${a.question}\n  已答: ${a.answer?.slice(0, 300) || "未答"}`).join("\n")
    : "";
  const roundPrompt = round >= 1
    ? `这是第 2 轮追问(集中补齐): 基于以上已答内容, 只输出仍模糊的关键点(≤3 问, 不重复已明确项)。若已足够则 questions 返回 []。`
    : `要求: 5个问题, 每个带可操作的 guidance(含举例), category 按 scope/method/theory/innovation/data 分类。`;
  const ans = await llmJson(`你是科研需求澄清专家。分析用户研究方案, 找出关键模糊点, 输出 JSON:
{"analysis":"总体分析(150字内: 已明确什么+存在哪些关键模糊点)","questions":[{"id":"q1","category":"scope|method|theory|innovation|data","question":"澄清问题(一句话)","guidance":"引导用户回答的具体方向(50-80字, 含示例)","importance":"高|中|低"}]}

【研究主题】${input.title}
【目录】${input.outline?.slice(0, 1500) ?? ""}
${input.researchMethod ? `【方法】${input.researchMethod}` : ""}
${input.requirements ? `【已有要求】${input.requirements.slice(0, 500)}` : ""}
${input.totalWordCount ? `【目标字数】${input.totalWordCount}` : ""}
${input.sampleContent ? `【参考样例片段(用户上传, 用于判断其写作取向与规范)】\n${input.sampleContent.slice(0, 4000)}` : ""}
${answersBlock ? `\n【第一轮问答记录】\n${answersBlock}` : ""}

${roundPrompt}`, undefined, 4000);
  const questions = Array.isArray(ans?.questions) ? ans.questions.slice(0, round >= 1 ? 3 : 5) : [];
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
  // V417: putNode 是**整包替换**, 两步分析各写各的键, 于是互相抹对方:
  //   · 这条路径(架构确认)不产 stepAnalysisTexts, 却硬编码空串 → 点一次就把 P1 分析产出的
  //     step2/step3 文本抹成 ""; 而 SectionsView 的假设解析以 stepAnalysisTexts["2"] 为
  //     第一优先级 → 已解析出的假设静默清空。
  //   · 反向也一样: 只有分析链产出逻辑主线时, 上面那几个键会被清掉。
  //   而 getWorkbenchSnapshot / loadProject 都不回读 hypotheses 与 logicChain
  //   (analysis 节点读的只有 variables / stepAnalysisTexts / logicFlow) —— 一旦被清,
  //   前端刷新后永久丢失。所以两边都改成"只覆盖本次真正产出的键"。
  const prevAnalysis = await (async (): Promise<Record<string, unknown>> => {
    try {
      const r = await pool.query(
        `select payload from research_nodes where project_id=$1 and node_key='analysis'`, [projectId]);
      return ((r.rows[0]?.payload ?? {}) as Record<string, unknown>) ?? {};
    } catch { return {}; }
  })();
  const prevSteps = (prevAnalysis.stepAnalysisTexts ?? {}) as Record<string, string>;
  // 本章真正产出的章节计划; 模型偶尔只给标题 → 兜底成可用的 plan 条目
  const chapterPlan = (Array.isArray(ans?.chapterPlan) ? ans.chapterPlan : []).map((c: Record<string, unknown>, i: number) => ({
    title: String(c?.title ?? `第${i + 1}节`),
    level: Number(c?.level ?? 1),
    requirements: String(c?.requirements ?? ""),
    skillType: String(c?.skillType ?? "literature"),
    wordCount: Number(c?.wordCount ?? 0),
  }));
  // 三段分析文本: 本次产出的键用新值, 没产出的键沿用旧值 —— 逐键判定, 不做"整体留/整体换"
  const newSteps = {
    "1": String(ans?.step1Text ?? ""),
    "2": String(ans?.step2Text ?? ""),
    "3": String(ans?.step3Text ?? ""),
  };
  const stepAnalysisTexts: Record<string, string> = {};
  for (const k of new Set([...Object.keys(prevSteps), ...Object.keys(newSteps)])) {
    const fresh = String(newSteps[k as "1" | "2" | "3"] ?? "");
    stepAnalysisTexts[k] = fresh.trim() ? fresh : String(prevSteps[k] ?? "");
  }
  const newVars = ans?.variables as unknown;
  const varsProduced = Array.isArray(newVars) ? newVars.length > 0
    : Boolean(newVars && typeof newVars === "object" && Array.isArray((newVars as { list?: unknown }).list) && (newVars as { list: unknown[] }).list.length);
  const nodePayload = {
    ...prevAnalysis,
    variables: varsProduced ? newVars : (prevAnalysis.variables ?? { kind: "unknown", list: [] }),
    // 本次没产出就用旧值 —— 清空对用户是纯损失, 没有任何路径依赖"被清空"
    hypotheses: (ans?.hypotheses as unknown[] | undefined)?.length ? ans.hypotheses : (prevAnalysis.hypotheses ?? []),
    // 首次分析若结构为空, 拿 previously 的变量/章节规划兜底, 否则"确认进入"的门禁会突然变红
    chapterPlan: chapterPlan.length ? chapterPlan : (prevAnalysis.chapterPlan ?? []),
    logicChain: String(ans?.logicChain ?? "").trim() ? ans.logicChain : (prevAnalysis.logicChain ?? ""),
    clarifyQuestions: (ans?.clarifyQuestions as unknown[] | undefined)?.length ? ans.clarifyQuestions : (prevAnalysis.clarifyQuestions ?? []),
    // 这条路径产的是上面三段; 键在 prevSteps 里有而这里没覆盖到的(如历史键)也原样留着
    stepAnalysisTexts: Object.keys(stepAnalysisTexts).length ? stepAnalysisTexts : { "1": "", "2": "", "3": "" },
    generatedAt: new Date().toISOString(),
  };
  await putNode(userId, projectId, "analysis", nodePayload, { taskId: opts.taskId, sourceRole: "main_agent" });
  return { ok: true as const, payload: nodePayload };
}
