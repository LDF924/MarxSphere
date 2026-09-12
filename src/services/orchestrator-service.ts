// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/orchestrator-service.ts — V415: 画布编排的执行层
//
// 由来(2026-09-12 用户指出「课题流程编排」不完善): 旧实现把五阶段写死在
//   QuickModeView 的 makeNodes()/MODULE_DEFS 里, 执行靠数组顺序 + 写死的 id→jobKind 字典,
//   **用户拖的连线根本不参与执行计划** —— 是流程图不是编排器。
//
// 本模块把"画布"变成"能跑的 DAG":
//   图(节点+边) → capability-registry 解释成 MetaSkillDef → meta-skill-runtime 拓扑执行
//   边 = 依赖本体(source 的产出进 target 的 depends_on; target 的已就绪输入进 {{inputs}})
//
// 运行状态落 orchestrator_runs 表: 刷新/换设备/进程重启后仍查得到跑到哪一步(旧实现全在前端内存)。
import { pool } from "../db/pool.js";
import { listCapabilities, graphToMetaSkill, type CapabilityDef } from "./capability-registry.js";
import { ORCHESTRATOR_TEMPLATES, getTemplate, type OrchestratorTemplate } from "./orchestrator-templates.js";
import {
  runMetaSkill, resumeMetaSkillFromSnapshot, cancelMetaSkill, pauseMetaSkill, resumeMetaSkill,
  resumeMetaSkillInput, getLiveRunSnapshot, isLiveRun,
  type MetaSkillDef, type MetaStepRun, type MetaRunContext,
} from "./meta-skill-runtime.js";

export interface OrchestratorGraph {
  id?: string;
  name?: string;
  description?: string;
  basedOn?: string;
  nodes: Array<{ id: string; capabilityId?: string; title?: string; params?: Record<string, unknown>; onFailure?: string }>;
  edges: Array<{ source: string; target: string }>;
}

export interface RunRecord {
  runId: string;
  graphId: string | null;
  graphName: string | null;
  input: string;
  status: string;
  stepLog: MetaStepRun[];
  outputs: Record<string, string>;
  finalText: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

function rowToRecord(r: any): RunRecord {
  return {
    runId: String(r.id),
    graphId: r.graph_id ?? null,
    graphName: r.graph_name ?? null,
    input: String(r.input ?? ""),
    status: String(r.status ?? "running"),
    stepLog: (typeof r.step_log_json === "string" ? JSON.parse(r.step_log_json) : r.step_log_json) ?? [],
    outputs: (typeof r.outputs_json === "string" ? JSON.parse(r.outputs_json) : r.outputs_json) ?? {},
    finalText: r.final_text ?? null,
    error: r.error ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    finishedAt: r.finished_at ? String(r.finished_at) : null,
  };
}

/**
 * 落库(每个步骤变化调用一次; 失败不阻断执行 —— 记录是辅助, 不能因为写库失败把编排搞崩)。
 *
 * 注意 graph_json 要一并写入: 恢复暂停/进程重启后的续跑全靠它重建执行计划。
 * 早先的写法只更新状态字段, 而 insert 分支会把 graph_json 写成 NULL —— 后果是第一次进度
 * 落库把图抹掉, 之后 resume 报"缺少图定义"(2026-09-12 实测踩到)。
 *
 * 并发的两代执行(暂停打断的旧任务 + 恢复新建的任务)会同时回调本函数 —— 必须拒绝旧任务的写入,
 * 否则旧进度会把新进度覆盖回去(实测表现为"恢复了但一直卡在 paused")。
 */
async function persist(
  runId: string, ctx: MetaRunContext, stepLog: MetaStepRun[],
  extra: { error?: string; finalText?: string; graph?: OrchestratorGraph } = {},
): Promise<void> {
  if (!isLiveRun(runId, ctx)) return;
  const finished = ["done", "failed", "cancelled"].includes(ctx.status);
  if (process.env.ORCH_DEBUG_PERSIST) console.log(`[orch-dbg] persist ${runId} status=${ctx.status} finished=${finished}`);
  try {
    await pool.query(
      `insert into orchestrator_runs (id, graph_id, graph_name, input, status, graph_json, step_log_json, outputs_json, final_text, error, updated_at, finished_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, now(), case when $11 then now() else null end)
       on conflict (id) do update set
         status = excluded.status,
         step_log_json = excluded.step_log_json,
         outputs_json = excluded.outputs_json,
         graph_json = coalesce(excluded.graph_json, orchestrator_runs.graph_json),
         final_text = coalesce(excluded.final_text, orchestrator_runs.final_text),
         error = coalesce(excluded.error, orchestrator_runs.error),
         updated_at = now(),
         finished_at = coalesce(excluded.finished_at, orchestrator_runs.finished_at)`,
      [
        runId, ctx.skillId, ctx.skillId, ctx.input, ctx.status,
        extra.graph ? JSON.stringify(extra.graph) : null,
        JSON.stringify(stepLog), JSON.stringify(ctx.outputs),
        extra.finalText ?? null, extra.error ?? null, finished,
      ]
    );
  } catch (e: any) {
    console.warn(`[orchestrator] 落库失败(不阻断执行): ${String(e?.message || e).slice(0, 150)}`);
  }
}

export interface StartRunOptions {
  graph?: OrchestratorGraph;
  templateId?: string;
  input?: string;
  model?: string;
  userValues?: Record<string, string>;
  /** 画布会话 id(可复用已有运行记录; 用于"接着上次继续") */
  runId?: string;
  authToken?: string;
}

export interface StartRunResult {
  runId: string;
  steps: number;
  order: string[];
}

/** 起后台执行并立刻拿到 runId(不能等运行时自己生成 id —— API 要先把 id 返回给前端) */
function launch(def: MetaSkillDef, runId: string, opts: StartRunOptions, graph: OrchestratorGraph): void {
  const onStatus = (ctx: MetaRunContext, stepLog: MetaStepRun[]) => { void persist(ctx.runId, ctx, stepLog, { graph }); };
  void runMetaSkill(def, opts.input ?? "", {
    model: opts.model,
    userValues: opts.userValues,
    authToken: opts.authToken,
    runId,
    onStatus,
    // 编排里的步骤以只读检索与 LLM 生成为主, 天然幂等 —— 中断后重跑不会造成重复副作用,
    // 所以选 abort: 用户点暂停/取消立刻生效, 而不是"等当前这步跑完"(可能是几分钟的长文生成)。
    pausePolicy: "abort",
  }).then((r) => {
    const ctx = { runId: r.runId, skillId: def.id, input: opts.input ?? "", outputs: r.outputs, userValues: {}, status: r.status } as MetaRunContext;
    return persist(r.runId, ctx, r.stepLog, { graph, finalText: r.output, error: r.status === "failed" ? r.output.slice(0, 500) : undefined });
  }).catch((e) => {
    console.warn(`[orchestrator] 运行 ${runId} 异常退出: ${String(e?.message || e).slice(0, 200)}`);
  });
}

/**
 * 启动一次编排。返回 runId 后由前端轮询 /api/orchestrator/progress(与既有 MetaSkill 一致的模式)。
 * 后台执行: user_input 节点会挂起等前端提交(不占 HTTP 连接)。
 */
export async function startOrchestration(opts: StartRunOptions): Promise<StartRunResult> {
  const caps = await listCapabilities();
  let graph = opts.graph;
  let name = graph?.name;
  if (!graph && opts.templateId) {
    const tpl = getTemplate(opts.templateId);
    if (!tpl) throw new Error(`模板不存在: ${opts.templateId}`);
    graph = { ...tpl.graph, basedOn: tpl.id };
    name = tpl.name;
  }
  if (!graph || !graph.nodes.length) throw new Error("编排为空: 请选择模板或添加节点");

  const def = buildDef(graph, caps, name);
  const runId = opts.runId || `orch-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  launch(def, runId, opts, graph);
  // 落一行初始记录(即使后端先挂了, 也能在列表里看到"启动过")
  await pool.query(
    `insert into orchestrator_runs (id, graph_id, graph_name, input, status, graph_json)
     values ($1, $2, $3, $4, 'running', $5::jsonb) on conflict (id) do nothing`,
    [runId, graph.id ?? null, name ?? null, opts.input ?? "", JSON.stringify(graph)]
  ).catch(() => { /* 表不存在/DB 不可用 → 仅内存态 */ });
  return { runId, steps: def.steps.length, order: def.steps.map((s) => s.id) };
}

/** 图 → 可执行的 MetaSkillDef(终端节点产物作为最终交付) */
function buildDef(graph: OrchestratorGraph, caps: Awaited<ReturnType<typeof listCapabilities>>, name?: string): MetaSkillDef {
  const def = graphToMetaSkill(graph as any, caps) as MetaSkillDef;
  def.id = graph.id || def.id;
  def.name = name || def.name;
  // 图里没有下游的节点就是终点 —— 最终交付取它的产物
  const hasDownstream = new Set(graph.edges.map((e) => e.source));
  const terminals = graph.nodes.filter((n) => !hasDownstream.has(n.id)).map((n) => n.id);
  def.final_text_mode = terminals.length === 1 ? `step:${terminals[0]}` : "auto";
  return def;
}

/** 进度: 内存优先(实时), 内存没有则回读 DB(进程重启后) */
export async function getRunProgress(runId: string): Promise<{
  ok: boolean; runId: string; status: string; stepLog: MetaStepRun[];
  outputs?: Record<string, string>; source: "live" | "db" | "none";
}> {
  const live = getLiveRunSnapshot(runId);
  if (live) return { ok: true, runId, status: live.status, stepLog: live.stepLog, source: "live" };
  try {
    const r = await pool.query("select * from orchestrator_runs where id = $1", [runId]);
    if (r.rows[0]) {
      const rec = rowToRecord(r.rows[0]);
      return { ok: true, runId, status: rec.status, stepLog: rec.stepLog, outputs: rec.outputs, source: "db" };
    }
  } catch { /* 表不存在 → 当作查不到 */ }
  return { ok: false, runId, status: "unknown", stepLog: [], source: "none" };
}

export function cancelRun(runId: string) { return cancelMetaSkill(runId); }
export function pauseRun(runId: string) { return pauseMetaSkill(runId); }
export function submitRunInput(runId: string, values: Record<string, string>) { return resumeMetaSkillInput(runId, values); }

/** 从 DB 的 graph_json + step_log 取回"这次跑的是哪张图、已经完成到哪" */
async function loadRunSnapshot(runId: string): Promise<{ graph: OrchestratorGraph; input: string; outputs: Record<string, string>; completed: string[]; userValues: Record<string, string> } | null> {
  try {
    const r = await pool.query("select graph_json, input, outputs_json, step_log_json from orchestrator_runs where id = $1", [runId]);
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    const graph = (typeof row.graph_json === "string" ? JSON.parse(row.graph_json) : row.graph_json) as OrchestratorGraph;
    if (!graph?.nodes) return null;
    const log: MetaStepRun[] = (typeof row.step_log_json === "string" ? JSON.parse(row.step_log_json) : row.step_log_json) ?? [];
    const outputs = (typeof row.outputs_json === "string" ? JSON.parse(row.outputs_json) : row.outputs_json) ?? {};
    // 已完成的判定: 状态 done 或有非空产物 —— 用户提交过的输入也算完成
    const completed = log.filter((s) => s.status === "done" || (outputs[s.stepId] ?? "") !== "").map((s) => s.stepId);
    const userValues: Record<string, string> = {};
    for (const [k, v] of Object.entries(outputs)) {
      // user_input 步骤的产物形如 "topic: 资本下乡\nmethod: 案例" —— 回填成 userValues 供 {{user.x}} 用
      for (const line of String(v).split("\n")) {
        const m = /^([\w-]+):\s*(.*)$/.exec(line.trim());
        if (m) userValues[m[1]] = m[2];
      }
    }
    return { graph, input: String(row.input ?? ""), outputs, completed, userValues };
  } catch { return null; }
}

/**
 * V415: 恢复暂停的运行。
 * 关键点(实测踩到的): 暂停会用 abort 打断当前步, 那个执行任务已经退出 —— 只把状态拨回
 * "running" 是没人推进的。必须从 DB 快照重建执行, 并跳过已完成的步骤(不重跑, 不重复烧 token)。
 */
export async function resumeRun(runId: string): Promise<{ ok: boolean; error?: string; rebuilt?: boolean }> {
  const live = getLiveRunSnapshot(runId);
  if (live && live.status === "paused") {
    // 执行任务仍在(慢步骤尚未被打断) → 拨回状态即可, 它会在步骤边界继续
    const r = resumeMetaSkill(runId);
    if (r.ok) return { ok: true, rebuilt: false };
  }
  const snap = await loadRunSnapshot(runId);
  if (!snap) return { ok: false, error: `运行快照不存在或缺少图定义: ${runId}` };
  const done = new Set(snap.completed);
  if (snap.graph.nodes.every((n) => done.has(n.id))) {
    return { ok: false, error: "该运行已全部完成, 无需恢复" };
  }
  const caps = await listCapabilities();
  const def = buildDef(snap.graph, caps, snap.graph.name);
  // 不 await 整个续跑 —— 与首次启动一致: 立刻返回 ok, 前端继续轮询进度。
  // (await 的话这个 HTTP 请求会挂到整条 DAG 跑完, 长任务必然超时)
  void resumeMetaSkillFromSnapshot(def, snap.input, {
    runId, outputs: snap.outputs, completed: snap.completed, userValues: snap.userValues,
  }, {
    onStatus: (ctx, stepLog) => { void persist(ctx.runId, ctx, stepLog, { graph: snap.graph }); },
    pausePolicy: "abort",
  }).then((r) => {
    void persist(runId, { runId, skillId: def.id, input: snap.input, outputs: r.outputs, userValues: {}, status: r.status } as MetaRunContext, r.stepLog, {
      graph: snap.graph, finalText: r.output, error: r.status === "failed" ? r.output.slice(0, 500) : undefined,
    });
  }).catch((e) => {
    console.warn(`[orchestrator] 恢复 ${runId} 异常: ${String(e?.message || e).slice(0, 200)}`);
  });
  return { ok: true, rebuilt: true };
}

/** 历史运行(前端"运行记录"面板) */
export async function listRuns(limit = 30): Promise<RunRecord[]> {
  try {
    const r = await pool.query("select * from orchestrator_runs order by created_at desc limit $1", [Math.min(Math.max(limit, 1), 200)]);
    return r.rows.map(rowToRecord);
  } catch { return []; }
}

// ─── 用户保存的自定义图 ───

export async function saveGraph(graph: OrchestratorGraph): Promise<{ id: string }> {
  const id = graph.id || `g-${Date.now().toString(36)}`;
  await pool.query(
    `insert into orchestrator_graphs (id, name, description, graph_json, based_on, updated_at)
     values ($1, $2, $3, $4::jsonb, $5, now())
     on conflict (id) do update set
       name = excluded.name, description = excluded.description,
       graph_json = excluded.graph_json, based_on = excluded.based_on, updated_at = now()`,
    [id, graph.name || "未命名编排", graph.description ?? null, JSON.stringify(graph), graph.basedOn ?? null]
  );
  return { id };
}

export async function listGraphs(): Promise<Array<{ id: string; name: string; description: string | null; basedOn: string | null; nodeCount: number; updatedAt: string }>> {
  try {
    const r = await pool.query("select id, name, description, based_on, graph_json, updated_at from orchestrator_graphs order by updated_at desc limit 100");
    return r.rows.map((x) => {
      const g = typeof x.graph_json === "string" ? JSON.parse(x.graph_json) : x.graph_json;
      return {
        id: String(x.id), name: String(x.name), description: x.description ?? null,
        basedOn: x.based_on ?? null, nodeCount: Array.isArray(g?.nodes) ? g.nodes.length : 0,
        updatedAt: String(x.updated_at),
      };
    });
  } catch { return []; }
}

export async function loadGraph(id: string): Promise<OrchestratorGraph | null> {
  try {
    const r = await pool.query("select graph_json from orchestrator_graphs where id = $1", [id]);
    if (!r.rows[0]) return null;
    const g = r.rows[0].graph_json;
    return (typeof g === "string" ? JSON.parse(g) : g) as OrchestratorGraph;
  } catch { return null; }
}

export async function deleteGraph(id: string): Promise<void> {
  await pool.query("delete from orchestrator_graphs where id = $1", [id]);
}

// ─── 供 API 层直接用的元数据 ───

export function listTemplates(): OrchestratorTemplate[] { return ORCHESTRATOR_TEMPLATES; }

export async function capabilityStats(): Promise<{ total: number; byKind: Record<string, number>; byCategory: Record<string, number> }> {
  const caps: CapabilityDef[] = await listCapabilities();
  const byKind: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const c of caps) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
  }
  return { total: caps.length, byKind, byCategory };
}
