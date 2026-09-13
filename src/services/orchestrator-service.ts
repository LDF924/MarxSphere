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
import { persistRunSnapshot } from "./orchestrator-run-store.js";
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
 * 落库(每个步骤变化调用一次)。
 *
 * graph_json 要一并写入: 恢复暂停/进程重启后的续跑全靠它重建执行计划。
 * 早先的写法只更新状态字段, 而 insert 分支会把 graph_json 写成 NULL —— 后果是第一次进度
 * 落库把图抹掉, 之后 resume 报"缺少图定义"(2026-09-12 实测踩到)。
 *
 * 并发的两代执行(暂停打断的旧任务 + 恢复新建的任务)会同时回调本函数 —— 必须拒绝旧任务的写入,
 * 否则旧进度会把新进度覆盖回去。注意: 旧任务自己的"已暂停"收尾不走这里(见 run-store)。
 */
async function persist(
  runId: string, ctx: MetaRunContext, stepLog: MetaStepRun[],
  extra: { error?: string; finalText?: string; graph?: OrchestratorGraph } = {},
): Promise<void> {
  if (!isLiveRun(runId, ctx)) return;
  await persistRunSnapshot({
    runId, skillId: ctx.skillId, input: ctx.input, outputs: ctx.outputs,
    status: ctx.status, stepLog, graph: extra.graph,
    error: extra.error, finalText: extra.finalText,
  });
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
  /**
   * V415: 调用来源。Agent 触发时受"单次最多节点数"限制, 画布上用户自己点的则不受限
   *   —— 自己画的图自己跑, 加个上限反而碍事; 但 Agent 可能一句话就排一条 20 节点的长链。
   */
  source?: "ui" | "agent";
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

  // V415: Agent 触发的编排受开关 + 节点数上限约束(画布上用户自己点的不受限)
  if (opts.source === "agent") {
    const setting = await getAgentOrchestrationSetting();
    if (!setting.enabled) throw new Error("Agent 编排当前是关闭的(可在「课题流程编排」页打开)");
    if (graph.nodes.length > setting.maxNodes) {
      throw new Error(`编排节点数 ${graph.nodes.length} 超过上限 ${setting.maxNodes}(防止一句话触发超长链; 可在编排设置里调整)`);
    }
  }

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
 *
 * 一律从 DB 快照**重建**执行任务 —— 曾经写过一个"若能就地恢复就只拨状态"的轻量分支, 结果是错的:
 * 暂停必然 abort 掉当前执行任务(见 pauseMetaSkill), 那个任务回来时只写收尾状态、不再推进循环,
 * 所以"拨回 running"永远没人干活, 运行会永久卡在 running(实测: 恢复返回 ok 但状态不变)。
 *
 * 重建的代价只是重新遍历一遍步骤表; 已完成步骤被替换成回放节点(直接返回快照产物, 不调 LLM),
 * 所以不会重复烧 token。恢复前把这条运行的旧代任务摘掉, 防止它与新代抢写同一个 runId。
 */
export async function resumeRun(runId: string): Promise<{ ok: boolean; error?: string; rebuilt?: boolean }> {
  // 先把可能残留的旧代任务标记为被接管(若已经收尾, 这步是空操作)
  resumeMetaSkill(runId);
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

// ─── V415: Agent 编排开关(前端可见、可切) ───
//
// 语义: 打开后, AI 对话里的 Agent 能通过 meta_invoke / 编排工具触发一条完整的多步编排
//   —— 一次可能串起十几个节点、数十次 LLM 调用。默认关闭。
//
// 为什么不做成纯 env 开关: 用户要求"这个开关必须是前端用户看得见的"。只在 .env 里配,
//   用户不知道它开没开、也不知道对话为什么有时能编排有时不能。所以状态存 DB(用户可切),
//   env(ORCH_AGENT_ENABLED=1)只作为**初始默认值与总闸**: env 关时前端也不允许打开。
const SETTING_KEY = "orchestrator:agent_enabled";

export interface AgentOrchestrationSetting {
  /** 当前是否允许 Agent 触发编排 */
  enabled: boolean;
  /** 环境变量是否允许开(env 关 → 前端只能看到"被部署方禁用") */
  envAllowed: boolean;
  /** 默认值来源 */
  source: "env-default" | "user" | "env-locked-off";
  /** 单次 Agent 触发的编排最多几个节点(防一句"帮我写篇论文"烧掉整月额度) */
  maxNodes: number;
  /** 是否要求人工确认后才真跑 */
  requireConfirm: boolean;
}

const ENV_AGENT_ENABLED = envBool(process.env.ORCH_AGENT_ENABLED);
const AGENT_MAX_NODES = Math.max(1, parseInt(process.env.ORCH_AGENT_MAX_NODES || "8", 10));

/**
 * 宽松布尔解析: 1/true/yes/on 都算开(大小写不敏感, 忽略首尾空白)。
 *
 * 为什么不用 `=== "1"`: 一是部署方写 `true` 时会**静默变成永久关闭**(开关在前端灰着、
 *   原因提示却只说"未设为 1", 没人能想到是自己写成了 true); 二是 cmd 的
 *   `set X=1 && ...` 会把值带上尾随空格, `=== "1"` 直接判否 —— 这个坑我在验证时真踩到了。
 * 与本仓既有约定一致(src/config/env.ts 用 z.coerce.boolean())。
 */
function envBool(v: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
}

/** 用户级设置读取(表不存在/DB 不可用 → 回退 env 默认; 不让设置面成为单点故障) */
async function readUserSetting(): Promise<{ enabled?: boolean; maxNodes?: number; requireConfirm?: boolean } | null> {
  try {
    const r = await pool.query("select value_json from orchestrator_settings where key = $1", [SETTING_KEY]);
    if (!r.rows[0]) return null;
    const v = r.rows[0].value_json;
    return typeof v === "string" ? JSON.parse(v) : v;
  } catch { return null; }
}

export async function getAgentOrchestrationSetting(): Promise<AgentOrchestrationSetting> {
  const user = await readUserSetting();
  const enabled = ENV_AGENT_ENABLED ? (user?.enabled ?? false) : false;
  return {
    enabled,
    envAllowed: ENV_AGENT_ENABLED,
    source: !ENV_AGENT_ENABLED ? "env-locked-off" : user?.enabled === undefined ? "env-default" : "user",
    maxNodes: user?.maxNodes ?? AGENT_MAX_NODES,
    requireConfirm: user?.requireConfirm ?? true,
  };
}

export async function setAgentOrchestrationSetting(patch: { enabled?: boolean; maxNodes?: number; requireConfirm?: boolean }): Promise<AgentOrchestrationSetting> {
  if (!ENV_AGENT_ENABLED && patch.enabled) {
    throw new Error("部署方已关闭 Agent 编排: 环境变量 ORCH_AGENT_ENABLED 未开启(支持 1/true/yes/on), 前端无法自行开启");
  }
  const cur = (await readUserSetting()) ?? {};
  const next = { ...cur, ...patch };
  await pool.query(
    `insert into orchestrator_settings (key, value_json, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value_json = excluded.value_json, updated_at = now()`,
    [SETTING_KEY, JSON.stringify(next)]
  );
  return getAgentOrchestrationSetting();
}

/** 供 agent 工具/系统提示判断: Agent 能不能走编排(异步: 会读一次 DB, 失败即视为关闭) */
export async function agentOrchestrationAllowed(): Promise<boolean> {
  try { return (await getAgentOrchestrationSetting()).enabled; } catch { return false; }
}

/**
 * V415: 模板列表(带按能力 cost 算出的成本量级)。
 * 模板里手写的 cost 是"设计意图", 这里用节点能力的实际 cost 重算一遍 —— 手写值容易与
 * 节点改动脱节(改了模板忘了改 cost)。重算值优先, 手写值作为兜底。
 */
export async function listTemplatesWithCost(): Promise<Array<OrchestratorTemplate & { costEstimated: "light" | "medium" | "heavy" }>> {
  const caps = await listCapabilities();
  const { estimateGraphCost } = await import("./capability-registry.js");
  return ORCHESTRATOR_TEMPLATES.map((t) => ({ ...t, costEstimated: estimateGraphCost(t.graph, caps) }));
}

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
