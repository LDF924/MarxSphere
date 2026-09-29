// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// agent-orch-tools.ts — 把「课题流程编排」(orchestrator)尚未工具化的那一圈接进对话。
//
// 与 agent-view-tools.ts 同源(那个文件做的是 33 个视图的能力工具化), 本文件只做编排这块:
// 能力表 / 运行记录 / 事件流 / 画布图的增删读 / 单步与按图执行 / 控制(暂停取消恢复补输入) /
// 一句话→DAG / MetaSkill 反解 / Agent 编排开关 / 候选 DAG 提案。
// **已存在的 orch_run(按模板跑) 与 orch_list(列模板) 不在这里重复** —— 见 agent-tool-router.ts。
//
// ## 三条硬约束(都是实测踩出来的, 改这个文件前先读)
//
// 1. **直连 service, 绝不 fetch 自家 HTTP 端点。**
//    `AgentToolDef.run(args)` 的签名里**没有调用者的 token**, 而 /api/orchestrator/* 里
//    要登录的端点会回 401「未登录」(server 对自己的 fetch 不带 Authorization; 本机豁免只对
//    "带 Bearer 的本机请求"成立)。调用者身份从 `currentUserId()` 取 —— server 在 handler
//    入口用 AsyncLocalStorage 把身份包进来, request-context 从这里读得到。
//
// 2. **"会跑东西"的工具一律不绕开 orch_run 的开关。**
//    orch_run 受 `getAgentOrchestrationSetting().enabled` 约束 —— 因为编排节点能绑**任意**
//    agent 工具(含 file_write / run_code / sag_ingest), 所以"另开一个能起编排的入口"就是提权旁路。
//    本文件的单步执行 / 按图执行 / 恢复运行都过同一道闸 `agentOrchestrationAllowed()`
//    (见 requireAgentOrchestration)。
//    反过来, **不跑编排**的工具(提案、开关读写)不该被开关拦住 —— 开关关着的时候更需要能打开它。
//    闸的位置也有讲究: 放在**起跑前最后一刻**, 不要放在函数开头 —— 开关关着是常态, 先挡开关会让
//    "能力不存在 / 还差哪个字段 / 图是空的"这些提示永远看不到(实测踩到)。开关只不许"跑", 不拦"查"。
//
// 3. 异常兜底成「（编排能力不可用: …）」, **不抛断工具循环**(与 agent-view-tools 同一原则);
//    长任务不傻等 —— 起完运行最多等一段就返回 runId, 让人去画布或 view_orch_run_detail 接着看。
import type { AgentToolDef } from "./agent-tool-router.js";
import { currentUserId, getRequestContext } from "./request-context.js";
import type { OrchestratorGraph } from "./orchestrator-service.js";

/** 安全地执行服务调用，异常兜底为可读文本（不抛断工具循环） */
async function safeCall(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e: any) {
    return `（编排能力不可用: ${String(e?.message || e).slice(0, 150)}）`;
  }
}

/** 单行剪裁 —— 列表项里塞不下整段文本 */
function clip(s: unknown, n = 120): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

/** 宽松布尔: 工具入参可能是 true, 也可能是 "true"/"1"/"yes"(与 orchestrator-service 的 envBool 同口径) */
function toBool(v: unknown): boolean {
  if (v === true || v === false) return v;
  return ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
}

/** 当前调用者身份(后台任务里两者都是 undefined —— 那时端点型能力会 401, 要在结果里说出来) */
function currentCaller(): { userId?: string; tenantId?: string } {
  return { userId: currentUserId(), tenantId: getRequestContext()?.tenantId };
}

type OrchStepLog = Array<{ stepId: string; label?: string; status: string; error?: string; output?: string; durationMs?: number }>;

/** 轮询到终态(或暂停/等输入/超时) —— 工具调用必须同步返回, 不能等整条 DAG 跑完 */
async function waitForRun(runId: string, maxMs: number): Promise<{ status: string; stepLog: OrchStepLog; outputs?: Record<string, string>; source: string }> {
  const { getRunProgress } = await import("./orchestrator-service.js");
  const deadline = Date.now() + maxMs;
  let p = await getRunProgress(runId);
  while (!["done", "failed", "cancelled"].includes(p.status) && Date.now() < deadline) {
    if (p.status === "waiting_input" || p.status === "paused") break;
    await new Promise((res) => setTimeout(res, 2000));
    p = await getRunProgress(runId);
  }
  return p;
}

/** 步骤日志 → 人话(失败步骤带原因) */
function stepLines(stepLog: OrchStepLog, max = 12): string {
  return stepLog.slice(0, max)
    .map((s) => `· ${s.label ?? s.stepId} — ${s.status}${s.error ? `（${clip(s.error, 140)}）` : ""}`)
    .join("\n");
}

/**
 * 起编排前的统一闸门 —— 与 orch_run 同一道开关。
 *
 * 返回非 null 就是"别放行"的可读原因。**环境变量是总闸**: ORCH_AGENT_ENABLED 没开时
 * 用户在界面上也打不开, 所以这里的提示要指向"让部署方开 env", 而不是空说一句"已关闭"。
 */
async function requireAgentOrchestration(): Promise<string | null> {
  try {
    const { agentOrchestrationAllowed } = await import("./orchestrator-service.js");
    if (await agentOrchestrationAllowed()) return null;
    return "（Agent 编排当前是关闭的 —— 单步/按图执行与 orch_run 同一道开关, 不绕开它。用户可在「课题流程编排」页打开「允许 Agent 触发编排」; 若界面也是灰的, 说明部署方未开环境变量 ORCH_AGENT_ENABLED。）";
  } catch (e: any) {
    return `（编排开关不可用: ${String(e?.message || e).slice(0, 150)}）`;
  }
}

export const ORCH_TOOLS: AgentToolDef[] = [
  // ─────────────────────────────────────────────────────────────────────────────
  // 一、读: 能力表 / 运行 / 事件流 / 画布图 / 开关 / 提案
  // ─────────────────────────────────────────────────────────────────────────────
  {
    // 读 —— 不登记 WRITE_TOOLS
    name: "view_orch_capabilities", label: "编排·能力表", risk: "safe",
    description: "浏览「课题流程编排」可用的能力(节点): 100+ 项, 含 id/分类/实现方式(agent_tool|endpoint|llm_chat|llm_gate|user_input)/成本量级/危险档/所需输入。要单步跑某个能力时先用它拿 capabilityId",
    params: {
      query: { type: "string", desc: "关键词, 在 id/名称/说明里找(如 回归/综述/引文)" },
      category: { type: "string", desc: "分类过滤: 检索/推理/写作/实证/统计/审稿/绘图/编辑/格式/引文/经典/教育/知识/文件/通用" },
      kind: { type: "string", desc: "实现方式过滤: agent_tool/endpoint/llm_chat/llm_gate/user_input" },
      limit: { type: "number", desc: "返回条数(默认25, 上限60)" },
    },
    run: async (a) => safeCall(async () => {
      const { listCapabilities } = await import("./capability-registry.js");
      const { capabilityStats } = await import("./orchestrator-service.js");
      const [caps, stats] = await Promise.all([listCapabilities(), capabilityStats()]);
      const kw = String(a.query ?? "").trim().toLowerCase();
      const kind = String(a.kind ?? "").trim();
      const category = String(a.category ?? "").trim();
      let hit = caps;
      if (kind) hit = hit.filter((c) => c.kind === kind);
      if (category) hit = hit.filter((c) => c.category === category);
      if (kw) hit = hit.filter((c) => `${c.id} ${c.label} ${c.description}`.toLowerCase().includes(kw));
      const limit = Math.min(Math.max(Number(a.limit) || 25, 1), 60);
      const top = hit.slice(0, limit);
      const byKind = Object.entries(stats.byKind).map(([k, v]) => `${k} ${v}`).join(" / ");
      const byCat = Object.entries(stats.byCategory).map(([k, v]) => `${k}${v}`).join(" ");
      /**
       * 这个能力的模板里有哪些**字面字段**要由节点参数填 —— 端点型写的是 `{{code}}`/`{{message}}`
       * 这类自定义字段, 不给值就会被渲染成 [未渲染:{{code}}] 发给端点(必然参数校验失败), 而看着
       * 像"这能力坏了"。那批字段名就是单步/画布上要填的东西, 所以列在这里让人一眼看得见。
       */
      const RENDERABLE = /^(inputs?|user\.\w+(\s*\|\s*split)?|outputs?\.([\w-]+)(\s*\|\s*slice\(\d+\))?)$/;
      const fieldNames = (c: (typeof caps)[number]) => {
        const acc = new Set<string>();
        const walk = (v: unknown) => {
          if (typeof v === "string") {
            for (const m of v.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) if (!RENDERABLE.test(m[1])) acc.add(m[1]);
          } else if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
        };
        walk(c.step.with);
        return [...acc];
      };
      const head = `【编排能力】共 ${stats.total} 项（筛选后 ${hit.length}, 列前 ${top.length}）\n实现方式: ${byKind}\n分类: ${byCat}`;
      if (!top.length) return head + "\n（没有匹配项 —— 换个关键词, 或去掉 category/kind 过滤）";
      const rows = top.map((c, i) => {
        const fields = fieldNames(c);
        return `${i + 1}. ${c.id} — ${c.label} · ${c.category}/${c.kind} · 成本${c.cost} · ${c.risk}`
          + (fields.length ? ` · 要填: ${fields.join("/")}` : "")
          + (c.inputs.length ? ` · 上游可喂: ${c.inputs.join("/")}` : "");
      });
      return head + "\n" + rows.join("\n")
        + `\n\n「要填」= 这个能力发给端点/工具时会用到的字段名(单步用 orch_run_step 的 params, 画布上就在节点参数里)。\n单步跑某个能力: orch_run_step(capabilityId)。跑完整流程: orch_run(模板) 或 orch_nl_to_dag(一句话拆解)。`;
    }),
  },
  {
    // 读 —— 不登记 WRITE_TOOLS
    name: "view_orch_runs", label: "编排·运行记录", risk: "safe",
    description: "列出最近的编排运行记录(runId/状态/用的是哪张图/进度/输入), 用于回答「我上次那条流程跑完没」或拿到 runId 查详情",
    params: {
      limit: { type: "number", desc: "返回条数(默认10, 上限50)" },
    },
    run: async (a) => safeCall(async () => {
      const { listRuns } = await import("./orchestrator-service.js");
      const runs = await listRuns(Math.min(Math.max(Number(a.limit) || 10, 1), 50));
      // ⚠ 空列表 ≠ 没有运行: listRuns 在"表不存在/DB 连不上"时也返回 [] (服务层有意不让它成为单点故障)。
      //   所以这里不能断言"还没有运行记录" —— 那会把"数据库没连上"说成"你没跑过", 是本仓吃过亏的那类误诊。
      if (!runs.length) return "【编排运行】没有查到运行记录。若你确定跑过, 那就是数据库没连上或表还没迁移 —— 空列表不等于没跑过; 到「课题流程编排」页看运行记录面板对照一下。";
      const st: Record<string, string> = { done: "完成", failed: "失败", running: "运行中", paused: "已暂停", cancelled: "已取消", waiting_input: "等输入" };
      const rows = runs.map((r) => {
        const done = r.stepLog.filter((s) => s.status === "done").length;
        return `${clip(r.runId, 20)} | ${st[r.status] ?? r.status} | ${clip(r.graphName ?? "(未命名图)", 24)} | 步 ${done}/${r.stepLog.length} | ${clip(r.input, 40)} | ${String(r.createdAt).slice(0, 16)}`;
      });
      return `【编排运行】最近 ${runs.length} 条\n${rows.join("\n")}\n\n查详情: view_orch_run_detail(runId); 查时间线: view_orch_events(runId)`;
    }),
  },
  {
    // 读 —— 不登记 WRITE_TOOLS
    name: "view_orch_run_detail", label: "编排·运行详情", risk: "safe",
    description: "查一次编排运行的逐步状态: 每步 done/failed/等待输入、报错原因、耗时、以及已完成步骤的产物(截断)。runId 用 view_orch_runs 拿",
    params: {
      runId: { type: "string", required: true, desc: "运行 id(orch-xxxx, 来自 view_orch_runs)" },
      outputChars: { type: "number", desc: "每步产物展示字数(默认300, 上限2000)" },
    },
    run: async (a) => safeCall(async () => {
      const runId = String(a.runId ?? "").trim();
      if (!runId) return "（需要 runId — 用 view_orch_runs 查）";
      const { getRunProgress } = await import("./orchestrator-service.js");
      const p = await getRunProgress(runId);
      if (!p.ok) return `（没有这次运行: ${clip(runId, 30)} — 用 view_orch_runs 列最近的运行看 id）`;
      const n = Math.min(Math.max(Number(a.outputChars) || 300, 0), 2000);
      const done = p.stepLog.filter((s) => s.status === "done").length;
      const from = p.source === "live" ? "内存(进行中)" : p.source === "db" ? "数据库(已结束或进程重启后回读)" : "未知";
      const role = p.runSource === "agent" ? "analyst(Agent 触发 → 写类节点会被拦)" : "manager(画布上用户自己点)";
      const head = `【运行 ${clip(runId, 24)}】${p.status} · 步 ${done}/${p.stepLog.length} · 来源 ${from} · 执行角色 ${role}`;
      const detail = p.stepLog.map((s) => {
        const t = s.durationMs ? ` ${Math.round(s.durationMs / 1000)}s` : "";
        const body = s.status === "failed"
          ? `\n    ✗ ${clip(s.error, 300)}`
          : n > 0 && s.output ? `\n    ${clip(s.output, n)}` : "";
        const wait = s.waitingFields?.length ? ` 需填: ${s.waitingFields.map((f) => f.name).join("/")}` : "";
        return `- ${s.label ?? s.stepId} [${s.status}${t}]${wait}${body}`;
      }).join("\n");
      const waiting = p.stepLog.find((s) => s.status === "waiting_input");
      const tail = waiting
        ? `\n\n它在等输入 —— 用 orch_control(action="input", runId, valuesJson) 提交: ${(waiting.waitingFields ?? []).map((f) => f.name).join(", ")}`
        : p.status === "paused" ? `\n\n已暂停 —— 用 orch_resume(runId) 续跑。` : "";
      return `${head}\n${detail}${tail}`;
    }),
  },
  {
    // 读 —— 不登记 WRITE_TOOLS
    name: "view_orch_events", label: "编排·事件流", risk: "safe",
    description: "读一次运行的事件时间线(计划历史): 依次发生过什么 —— 每次节点开始/结束/失败/暂停。与「运行详情」的区别: 详情是快照, 这里是时间线",
    params: {
      runId: { type: "string", required: true, desc: "运行 id" },
      since: { type: "number", desc: "只要 seq 大于它的增量(默认0 = 全量)" },
    },
    run: async (a) => safeCall(async () => {
      const runId = String(a.runId ?? "").trim();
      if (!runId) return "（需要 runId — 用 view_orch_runs 查）";
      const { getRunEventLog } = await import("./orchestrator-service.js");
      const r = await getRunEventLog(runId, Math.max(Number(a.since) || 0, 0));
      // available=false 是"事件表都没建"(老库未迁移/DB 连不上), 与"表在但这次没事件"是两件事 —— 分开说
      if (!r.available) return `（事件流不可用: 事件表查不到(可能是老库未跑迁移, 也可能是数据库没连上) —— 运行详情仍可看: view_orch_run_detail）`;
      if (!r.events.length) return `【事件流】这次运行没有事件记录（seq>${Math.max(Number(a.since) || 0, 0)} 的部分）`;
      const st: Record<string, string> = {
        "job.created": "建计划", "job.started": "启动", "job.batch_started": "开始调度",
        "job.paused": "暂停", "job.resumed": "恢复", "job.cancelled": "取消", "job.done": "结束", "job.failed": "失败",
      };
      const rows = r.events.slice(-40).map((e) =>
        `#${e.seq} ${String(e.createdAt).slice(11, 19)} [${st[e.event] ?? e.event}]${e.nodeId ? ` ${e.nodeId}` : ""} ${clip(e.message, 80)}`);
      return `【事件流】共 ${r.events.length} 条(列最近 ${rows.length})\n${rows.join("\n")}`;
    }),
  },
  {
    // 读 —— 不登记 WRITE_TOOLS
    name: "view_orch_graphs", label: "编排·画布图列表", risk: "safe",
    description: "列出用户保存的画布编排图(自定义流程): id/名称/节点数/最近更新。回答「我画过哪些流程」, 或拿到 graphId",
    params: {},
    run: async () => safeCall(async () => {
      const { listGraphs } = await import("./orchestrator-service.js");
      const gs = await listGraphs();
      // 同 view_orch_runs: listGraphs 在 DB 不可用时也返回 [], 不能说成"你没画过图"
      if (!gs.length) return "【画布图】没有查到保存过的自定义图。若你确定存过, 那就是数据库没连上或表还没迁移 —— 空列表不等于不存在; 到「课题流程编排」页对照一下。要新建: orch_graph_save 或 orch_nl_to_dag。";
      const rows = gs.map((g, i) =>
        `${i + 1}. ${clip(g.id, 20)} — ${clip(g.name, 30)} · ${g.nodeCount} 节点 · ${String(g.updatedAt).slice(0, 16)}${g.basedOn ? ` · 基于 ${clip(g.basedOn, 20)}` : ""}${g.description ? `\n     ${clip(g.description, 60)}` : ""}`);
      return `【画布图】${gs.length} 张\n${rows.join("\n")}\n\n看某张图: view_orch_graph_get; 跑它: orch_run_graph; 删: orch_graph_delete`;
    }),
  },
  {
    // 读 —— 不登记 WRITE_TOOLS
    name: "view_orch_graph_get", label: "编排·读画布图", risk: "safe",
    description: "读一张画布编排图的完整内容: 每个节点绑的哪个能力、节点参数、节点之间的连线(谁喂谁)",
    params: {
      graphId: { type: "string", required: true, desc: "图 id(来自 view_orch_graphs)" },
      maxNodes: { type: "number", desc: "最多列几个节点(默认20)" },
    },
    run: async (a) => safeCall(async () => {
      const graphId = String(a.graphId ?? "").trim();
      if (!graphId) return "（需要 graphId — 用 view_orch_graphs 查）";
      const { loadGraph } = await import("./orchestrator-service.js");
      const g = await loadGraph(graphId);
      if (!g) return `（图 ${clip(graphId, 20)} 不存在 —— 用 view_orch_graphs 列出来看 id; 也可能是数据库没连上(读图失败与"图不存在"在本层分不开, 那个列表能对上就是真不存在)）`;
      const max = Math.min(Math.max(Number(a.maxNodes) || 20, 1), 60);
      const nodes = g.nodes.slice(0, max).map((n, i) => {
        const ps = n.params && Object.keys(n.params).length ? ` 参数: ${clip(JSON.stringify(n.params), 160)}` : "";
        return `${i + 1}. ${n.id} — ${clip(n.title, 40)}${n.capabilityId ? ` [${n.capabilityId}]` : "（无能力 → 退化成一次 LLM 生成）"}${ps}${n.onFailure ? ` 失败备胎:${n.onFailure}` : ""}`;
      });
      const edges = g.edges.length ? g.edges.map((e) => `· ${e.source} → ${e.target}`).join("\n") : "（无连线 —— 多个无依赖节点会并行跑）";
      return `【画布图 ${clip(g.id ?? graphId, 20)}】${clip(g.name ?? "(未命名)", 40)}${g.description ? `\n${clip(g.description, 100)}` : ""}\n节点 ${g.nodes.length}（列 ${nodes.length}）:\n${nodes.join("\n")}\n连线:\n${edges}\n\n跑它: orch_run_graph; 改/另存: orch_graph_save`;
    }),
  },
  {
    // 读 —— 纯转换, 不落库、不执行(要落成画布图得再调 orch_graph_save)
    name: "view_orch_meta_to_graph", label: "编排·MetaSkill 反解成图", risk: "safe",
    description: "把一条 MetaSkill(声明式 DAG, 含提案 accept 进来的)反解成画布图: 每步落到哪个能力、步骤间依赖。用于「这条 MetaSkill 如果搬到画布上会长什么样 / 能不能自由改」",
    params: {
      skillId: { type: "string", required: true, desc: "MetaSkill id(先用 meta_list 或 view_orch_dag_proposals 查; 不存在的 id 会返回可用清单)" },
    },
    run: async (a) => safeCall(async () => {
      const skillId = String(a.skillId ?? "").trim();
      if (!skillId) return "（需要 skillId — 用 meta_list 查可用 id）";
      const { metaSkillToGraph, listMetaSkillsForCanvas } = await import("./orchestrator-service.js");
      const g = await metaSkillToGraph(skillId);
      if (!g) {
        const all = await listMetaSkillsForCanvas();
        const ids = all.slice(0, 15).map((s) => `${s.id}(${s.source === "builtin" ? "内置" : "已注册"})`).join(", ");
        return `（MetaSkill 不存在: ${clip(skillId, 40)}）可用 ${all.length} 条: ${ids}${all.length > 15 ? " …" : ""}`;
      }
      const noCap = g.nodes.filter((n) => !n.capabilityId).length;
      const nodes = g.nodes.slice(0, 20).map((n, i) =>
        `${i + 1}. ${n.id} — ${clip(n.title, 46)}${n.capabilityId ? ` [${n.capabilityId}]` : " [无等价能力 → 打开后按 LLM 生成]"}${n.params && Object.keys(n.params).length ? ` 参数: ${clip(JSON.stringify(n.params), 120)}` : ""}`);
      const edges = g.edges.length ? g.edges.map((e) => `· ${e.source} → ${e.target}`).join("\n") : "（无依赖 → 并行）";
      return `【${clip(g.name, 40)} → 画布图】${g.nodes.length} 节点 / ${g.edges.length} 边${noCap ? `（其中 ${noCap} 个节点在注册表里没有等价能力, 搬运后会退化成 LLM 生成 —— 这是已知落差, 不是丢数据）` : ""}\n${nodes.join("\n")}\n依赖:\n${edges}\n\n要落成自己的画布图(可改可跑): orch_graph_save(fromMetaSkill="${clip(skillId, 40)}", name="…")`;
    }),
  },
  {
    // 读 —— 不登记 WRITE_TOOLS
    name: "view_orch_settings", label: "编排·开关状态", risk: "safe",
    description: "读 Agent 编排开关: 现在允不允许 Agent 触发编排、环境变量是否允许开、单次最多几个节点、是否要求人工确认",
    params: {},
    run: async () => safeCall(async () => {
      const { getAgentOrchestrationSetting } = await import("./orchestrator-service.js");
      const s = await getAgentOrchestrationSetting();
      const src: Record<string, string> = {
        "env-default": "环境默认(用户还没改过)", "user": "用户在界面上设的", "env-locked-off": "被部署方锁定关闭",
      };
      return `【Agent 编排开关】${s.enabled ? "开" : "关"}\n· 环境变量允许开: ${s.envAllowed ? "是" : "否（ORCH_AGENT_ENABLED 未开 → 界面上也打不开）"}\n· 状态来源: ${src[s.source] ?? s.source}\n· 单次 Agent 触发最多节点: ${s.maxNodes}\n· 是否要求人工确认: ${s.requireConfirm ? "是" : "否"}\n\n改它: orch_settings_set(enabled/maxNodes/requireConfirm)`;
    }),
  },
  {
    // 读 —— 顺手修历史提案里丢失的来源 id(与 GET /api/meta-skill/proposals 端点同一行为;
    // 那是数据的自我修复, 不是用户可见的写, 故不算写工具)
    name: "view_orch_dag_proposals", label: "编排·候选 DAG 提案", risk: "safe",
    description: "列出候选 MetaSkill DAG 提案(技能组自动组装的隔离区): 提案 id/状态/触发主题/步数/来源技能。回答「有哪些自动组出来的流程等我审」",
    params: {
      status: { type: "string", desc: "只看某状态: proposed(待审) / accepted(已接受) / rejected(已否决)" },
      limit: { type: "number", desc: "返回条数(默认10)" },
    },
    run: async (a) => safeCall(async () => {
      const { listDagProposals, repairProposalSourceIds } = await import("./meta-skill-propose-service.js");
      // 老提案的 sourceSkillIds 曾是 [null,…](构造时漏了 id), 读的时候顺手补一次
      await repairProposalSourceIds().catch(() => 0);
      const st = String(a.status ?? "").trim();
      let all = listDagProposals();
      if (st) all = all.filter((p) => p.status === st);
      const limit = Math.min(Math.max(Number(a.limit) || 10, 1), 30);
      const top = all.slice(-limit).reverse();
      if (!top.length) return `【DAG 提案】${st ? `没有 ${st} 状态的` : "暂时没有"}提案 —— 提案由技能组凝练时自动生成, 也可以现在就让 orch_dag_propose 组一条。`;
      const cn: Record<string, string> = { proposed: "待审", accepted: "已接受", rejected: "已否决" };
      const rows = top.map((p, i) =>
        `${i + 1}. ${p.id} | ${cn[p.status] ?? p.status} | ${clip(p.dag?.name, 24)}（${p.dag?.steps?.length ?? 0} 步）| 触发: ${clip(p.triggerGoal, 40)} | 技能: ${p.sourceSkillNames.slice(0, 3).join("/") || "?"} | ${clip(p.createdAt, 10)}`);
      return `【DAG 提案】${top.length} 条（筛选后 ${all.length}）\n${rows.join("\n")}\n\n接受/否决: orch_dag_decide(id, decision=accept|reject)`;
    }),
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 二、执行: 单步 / 按图 / 一句话→DAG
  //
  // 为什么单步与按图是 risk:"safe"(与 view_task_create 同档): 跑一条 DAG 不破坏数据,
  //   失败只是没产出; 真正危险的是**编排里的节点**能不能写东西 —— 那由执行角色管
  //   (source:"agent" → analyst, 见 orchestrator-service 的 toolRoleFor), 不由这一档管。
  //   ⚠ 例外是 orch_run_graph: 图的**内容**是用户资产, agent 只看得见 id 看不见里面绑了什么,
  //     所以它跟 orch_run 一样定 review(两个"按完整 DAG 跑"的入口不该有宽严之分)。
  // 三个都**受 orch_run 那道开关约束**(requireAgentOrchestration), 且都是后台起跑 + 限时等待。
  // ─────────────────────────────────────────────────────────────────────────────
  {
    // 写 —— 会真的跑一次执行(调端点/工具/LLM, 烧额度; 能力本身是 safe 档才放行), 要登记进 WRITE_TOOLS
    name: "orch_run_step", label: "编排·单步执行", risk: "safe",
    description: "只跑「课题流程编排」里的一个能力(单节点 DAG)并拿到产物: 一次检索/一次回归/一次引文核验/一次 LLM 生成, 不起整条长链。capabilityId 先用 view_orch_capabilities 查",
    params: {
      capabilityId: { type: "string", required: true, desc: "能力 id(如 tool:sag_retrieve / emp:regression / io:llm-write)" },
      input: { type: "string", desc: "主输入。该能力只认一个字段时会自动落到那个字段上(如 emp:regression 的 code); 字段多于一个时它填不进具体字段, 请改用 params 逐项给 —— 缺哪个字段会被拦下并说明" },
      params: { type: "string", desc: '逐字段指定节点参数(优先于 input; 字段名看 view_orch_capabilities 的「要填:」): {"code":"import pandas…"}' },
      waitSeconds: { type: "number", desc: "最多等多久(秒, 默认120, 上限1800); 超了返回 runId 让用户去画布看" },
    },
    run: async (a) => safeCall(async () => {
      const capabilityId = String(a.capabilityId ?? "").trim();
      if (!capabilityId) return "（需要 capabilityId — 先用 view_orch_capabilities 查有哪些能力）";
      const { listCapabilities, findCapability } = await import("./capability-registry.js");
      const cap = findCapability(capabilityId, await listCapabilities());
      if (!cap) return `（能力 ${clip(capabilityId, 60)} 不存在 — 用 view_orch_capabilities 查 id; 注意不确定的节点在画布上会被当作一次 LLM 生成, 单步工具这里不替它猜）`;
      // review/deny 档的能力不代跑: 本工具是"绕开画布快速跑一步"的便利工, 不该成为审批旁路
      if (cap.risk !== "safe") return `（能力「${cap.label}」是 ${cap.risk} 档(需人工审批) —— 单步工具不代跑, 到画布上由人确认）`;
      const input = String(a.input ?? "").trim();
      let nodeParams: Record<string, unknown> | undefined;
      const rawParams = String(a.params ?? "").trim();
      if (rawParams) {
        try {
          const j = JSON.parse(rawParams);
          if (!j || typeof j !== "object" || Array.isArray(j)) return "（params 需为 JSON 对象, 如 {\"topic\":\"资本下乡\"}）";
          nodeParams = j as Record<string, unknown>;
        } catch (e: any) { return `（params 不是合法 JSON: ${clip(e?.message, 100)}）`; }
      }
      /**
       * 这个能力的模板里有哪些**字面字段**要由节点参数填。
       *
       * 为什么必须查一遍: 端点型能力的请求体写的是 `{{code}}` / `{{message}}` / `{{claim}}`
       *   这类**自定义字段**, 它们不在渲染上下文里 —— 不给值就会被渲染成 `[未渲染:{{code}}]`
       *   原样发给端点, 端点回一句参数校验失败, 而看着像"这个能力坏了"(实测: emp:regression
       *   的字段叫 code, 我把 input 直接当主输入塞了, 结果是一个必然 400 的请求体)。
       * 怎么填: 节点参数在运行时**直接覆盖**模板里的对应字段(见 dagNodeToMetaStep 的修复注释),
       *   所以 params={"code":"…"} 就是这条能力的正确用法。
       */
      const RENDERABLE = /^(inputs?|user\.\w+(\s*\|\s*split)?|outputs?\.([\w-]+)(\s*\|\s*slice\(\d+\))?)$/;
      const placeholders = (() => {
        const acc = new Set<string>();
        const walk = (v: unknown) => {
          if (typeof v === "string") {
            for (const m of v.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) if (!RENDERABLE.test(m[1])) acc.add(m[1]);
          } else if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
        };
        walk(cap.step.with);
        return [...acc];
      })();
      // input 是"主输入"的快捷方式: 该能力只认一个字段时把它落上去(否则用户给了 input 却什么都没发出去)
      if (input && !nodeParams && placeholders.length === 1) nodeParams = { [placeholders[0]]: input };
      const unwarned = placeholders.filter((n) => nodeParams?.[n] === undefined);
      const declared = new Map((cap.fields ?? []).map((f) => [f.name, f]));
      // 挡两类: 声明为必填的、以及根本没在 fields 里登记过的(后者百分百是垃圾请求)
      const blockers = unwarned.filter((n) => declared.get(n)?.required !== false);
      if (blockers.length) {
        const hint = blockers.map((n) => {
          const f = declared.get(n);
          return `${n}${f ? `（${f.label}${f.placeholder ? `: ${f.placeholder}` : ""}）` : ""}`;
        }).join("; ");
        return `（能力「${cap.label}」还差字段: ${blockers.join(" / ")} —— 用 params 逐项给值, 如 params={"${blockers[0]}":"…"}。${placeholders.length > 1 ? `该能力要填的字段: ${placeholders.join(" / ")}。` : ""}${hint}）`;
      }
      const optWarn = unwarned.length ? `\n（提示: 可选字段 ${unwarned.join(", ")} 没给值 —— 该字段会以未渲染占位符发给端点, 要精确控制就带 params 重跑）` : "";
      const nodeId = "step1";
      const graph: OrchestratorGraph = {
        id: `g-single-${Date.now().toString(36)}`,
        name: `单步: ${cap.label}`,
        description: `Agent 单步执行 ${cap.id}`,
        nodes: [{ id: nodeId, capabilityId: cap.id, title: cap.label, ...(nodeParams ? { params: nodeParams } : {}) }],
        edges: [],
      };
      // 闸放在**起跑前最后一刻**而不是函数开头: 开关关着是常态, 若先挡开关, 上面那些
      // "能力不存在/还差字段"的提示就永远看不到(实测: 关着开关时调本工具, 连"这个能力要填 code"
      // 都不告诉你, 只能猜)。开关只是不许"跑", 不拦"查"。
      const gate = await requireAgentOrchestration();
      if (gate) return gate;
      const { startOrchestration } = await import("./orchestrator-service.js");
      const caller = currentCaller();
      const r = await startOrchestration({ graph, input, source: "agent", userId: caller.userId, tenantId: caller.tenantId });
      const maxMs = Math.min(Math.max((Number(a.waitSeconds) || 120) * 1000, 10_000), 1_800_000);
      const p = await waitForRun(r.runId, maxMs);
      const out = String(p.outputs?.[nodeId] ?? p.stepLog[0]?.output ?? "");
      const noId = caller.userId ? "" : "（本次调用没有登录身份 —— 端点型能力会报 401, 这是后台任务语义, 不是权限 bug）";
      if (p.status === "done") return `【单步完成】${cap.label}（runId=${r.runId}）\n${optWarn}${clip(out, 3000) || "（这一步没产出文本）"}`;
      if (p.status === "failed") return `（单步失败: ${clip(p.stepLog.find((s) => s.status === "failed")?.error ?? out, 300)}）${noId}\n${stepLines(p.stepLog)}`;
      return `【单步仍在运行】runId=${r.runId} 当前 ${p.status}${optWarn}\n${stepLines(p.stepLog)}\n（到「课题流程编排 → 运行记录」看, 或用 view_orch_run_detail(runId) 再查）`;
    }),
  },
  {
    // 写 —— 起一条真实运行, 且图里可能含写类节点, 要登记进 WRITE_TOOLS
    // risk 与 orch_run 同档(review): 都是"按一条完整 DAG 跑"的入口, 不该有宽严之分
    name: "orch_run_graph", label: "编排·按图执行", risk: "review",
    description: "按 id 跑一张**已保存的**画布编排图(不是模板 —— 模板用 orch_run)。图里可能含写类节点、会烧额度, 所以与 orch_run 同级需审批",
    params: {
      graphId: { type: "string", required: true, desc: "画布图 id(来自 view_orch_graphs)" },
      input: { type: "string", desc: "整条运行的主输入(text/topic 类根节点会取它)" },
      waitSeconds: { type: "number", desc: "最多等多久(秒, 默认60, 上限900)" },
    },
    run: async (a) => safeCall(async () => {
      const graphId = String(a.graphId ?? "").trim();
      if (!graphId) return "（需要 graphId — 用 view_orch_graphs 查）";
      const { loadGraph, listGraphs, startOrchestration } = await import("./orchestrator-service.js");
      const graph = await loadGraph(graphId);
      if (!graph) {
        const gs = await listGraphs();
        return `（图 ${clip(graphId, 20)} 不存在）现有 ${gs.length} 张: ${gs.slice(0, 10).map((g) => `${g.id}(${g.name})`).join(", ")}`;
      }
      if (!graph.nodes?.length) return `（图「${clip(graph.name ?? graphId, 30)}」里没有节点 —— 空图跑不出东西, 到画布上给它加节点）`;
      // 闸放在起跑前最后一刻(与 orch_run_step 同理: 开关关着时也要能看出"图找不到/图是空的")
      const gate = await requireAgentOrchestration();
      if (gate) return gate;
      // 图必须带 id 起跑 —— 否则运行记录里的 graph_id 为空, 之后想按图查历史就断了
      const caller = currentCaller();
      const r = await startOrchestration({
        graph: { ...graph, id: graph.id ?? graphId },
        input: String(a.input ?? ""),
        source: "agent", userId: caller.userId, tenantId: caller.tenantId,
      });
      const p = await waitForRun(r.runId, Math.min(Math.max((Number(a.waitSeconds) || 60) * 1000, 10_000), 900_000));
      const last = p.stepLog[p.stepLog.length - 1];
      const out = String(p.outputs?.[last?.stepId ?? ""] ?? last?.output ?? "");
      const head = `【${clip(graph.name ?? graphId, 30)}】runId=${r.runId} · ${r.steps} 节点 · 状态 ${p.status}`;
      if (p.status === "done") return `${head}\n${stepLines(p.stepLog)}\n\n产物(末节点):\n${clip(out, 2500) || "（无文本产物）"}`;
      if (p.status === "failed") return `（编排失败: ${clip(p.stepLog.find((s) => s.status === "failed")?.error ?? "", 300)}）\n${head}\n${stepLines(p.stepLog)}`;
      return `${head}\n${stepLines(p.stepLog)}\n（还没跑完/在等输入 —— view_orch_run_detail(runId) 可继续看; 等输入用 orch_control(action="input")）`;
    }),
  },
  {
    // 写 —— n/a(本工具只调一次 LLM 出图, **不落库、不起运行**; 要存下来走 orch_graph_save, 要跑走 orch_run_graph)
    name: "orch_nl_to_dag", label: "编排·一句话→流程图", risk: "safe",
    description: "把一句研究任务描述拆成可执行的编排图(节点+连线+每个节点绑的能力)并回显。**只拆不存不跑** —— 想留着走 orch_graph_save, 想跑走 orch_run_graph",
    params: {
      description: { type: "string", required: true, desc: "一句话描述(如 帮我做一篇关于资本下乡的实证论文: 检索→假设→回归→写作)" },
    },
    run: async (a) => safeCall(async () => {
      const description = String(a.description ?? "").trim();
      if (!description) return "（需要 description: 一句话说明要做什么研究任务）";
      const { nlToOrchestratorGraph } = await import("./research-pipeline-service.js");
      const r = await nlToOrchestratorGraph(description);
      if ("error" in r) return `（拆解失败: ${clip(r.error, 200)}）`;
      const g = r.graph;
      const nodes = g.nodes.map((n, i) =>
        `${i + 1}. ${n.id} — ${clip(n.title, 50)}${n.capabilityId ? ` [${n.capabilityId}]` : " [未绑能力 → 按 LLM 生成执行]"}`);
      const edges = g.edges.length ? g.edges.map((e) => `· ${e.source} → ${e.target}`).join("\n") : "（无依赖 → 并行）";
      return `【拆解结果】${g.nodes.length} 节点 / ${g.edges.length} 边\n${nodes.join("\n")}\n依赖:\n${edges}`
        + `\n\n（只拆不存 —— 留着它: orch_graph_save(nodesJson=…, edgesJson=…) 或到「课题流程编排」照着画; 直接用: orch_run_graph 需要一张已保存的图, 或按模板用 orch_run）`;
    }),
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 三、改: 保存/删除画布图、控制运行、开关、候选 DAG 提案
  // ─────────────────────────────────────────────────────────────────────────────
  {
    // 写 —— 落库/覆盖一张画布图, 要登记进 WRITE_TOOLS
    name: "orch_graph_save", label: "编排·保存画布图", risk: "review",
    description: "保存编排图到画布: 改已有图(给 graphId, 会覆盖)、从 MetaSkill 转一张(fromMetaSkill)、或存前端导出的 nodes JSON(nodesJson)。**按 id 保存时图里原样保留, 只换名字/描述**",
    params: {
      graphId: { type: "string", desc: "要覆盖的图 id(与 nodesJson 二选一; 给了就从库里读原图改)" },
      fromMetaSkill: { type: "string", desc: "从 MetaSkill id 转一张新图(与 graphId/nodesJson 三选一)" },
      nodesJson: { type: "string", desc: "画布导出的 nodes 数组 JSON(新建图时用; 每项至少要有 id, 建议带 capabilityId/title)" },
      edgesJson: { type: "string", desc: "画布导出的 edges 数组 JSON(与 nodesJson 搭配)" },
      name: { type: "string", desc: "图名(改已有图时用它改名)" },
      description: { type: "string", desc: "图用途说明" },
    },
    run: async (a) => safeCall(async () => {
      const graphId = String(a.graphId ?? "").trim();
      const fromMeta = String(a.fromMetaSkill ?? "").trim();
      const { loadGraph, saveGraph, metaSkillToGraph } = await import("./orchestrator-service.js");
      let graph: OrchestratorGraph | null = null;
      if (fromMeta) {
        graph = await metaSkillToGraph(fromMeta);
        if (!graph) return `（MetaSkill 不存在: ${clip(fromMeta, 40)} — 先用 meta_list 查 id）`;
      } else if (graphId) {
        graph = await loadGraph(graphId);
        if (!graph) return `（图 ${clip(graphId, 20)} 不存在 — 用 view_orch_graphs 查; 要新建就给 nodesJson）`;
        // ⚠ 必须把 id 钉回去: 库里的 graph_json 不一定带 id, saveGraph 会按 graph.id 决定 upsert 主键 ——
        //   丢了它就变成"另存成一张新图"(原图还在, 用户看到两张), 而不是覆盖
        graph = { ...graph, id: graphId };
      } else {
        const raw = String(a.nodesJson ?? "").trim();
        if (!raw) return "（三选一: graphId(改已有) / fromMetaSkill(MetaSkill 转图) / nodesJson(新建)）";
        let nodes: unknown;
        try { nodes = JSON.parse(raw); } catch (e: any) { return `（nodesJson 不是合法 JSON: ${clip(e?.message, 100)} —— 建议从画布「导出」拿原样 JSON, 别手写）`; }
        if (!Array.isArray(nodes) || !nodes.length || nodes.some((n: any) => !n || typeof n.id !== "string")) {
          return "（nodes 需为非空数组, 且每项都有字符串 id）";
        }
        let edges: unknown = [];
        const rawEdges = String(a.edgesJson ?? "").trim();
        if (rawEdges) {
          try { edges = JSON.parse(rawEdges); } catch (e: any) { return `（edgesJson 不是合法 JSON: ${clip(e?.message, 100)}）`; }
        }
        if (!Array.isArray(edges)) return "（edges 需为数组, 如 [{\"source\":\"a\",\"target\":\"b\"}]）";
        graph = { name: String(a.name ?? "").trim() || "Agent 新建的编排", description: String(a.description ?? "") || undefined, nodes: nodes as OrchestratorGraph["nodes"], edges: edges as OrchestratorGraph["edges"] };
      }
      if (!graph) return "（没有解析出可保存的图）";
      if (a.name !== undefined && !fromMeta) graph = { ...graph, name: String(a.name).trim() || graph.name };
      if (a.description !== undefined) graph = { ...graph, description: String(a.description) };
      const saved = await saveGraph(graph);
      return `【已保存】${saved.id} — ${clip(graph.name ?? "(未命名)", 30)}（${graph.nodes.length} 节点 / ${graph.edges.length} 边）${graphId || fromMeta ? "（按 id 覆盖, 已存在则更新）" : ""}\n跑它: orch_run_graph(graphId="${saved.id}")`;
    }),
  },
  {
    // 写 —— 删库里的图(不可逆), 要登记进 WRITE_TOOLS
    name: "orch_graph_delete", label: "编排·删除画布图", risk: "review",
    description: "删除一张已保存的画布编排图(不可逆)。不是删模板 —— 模板写在代码里删不掉",
    params: {
      graphId: { type: "string", required: true, desc: "图 id(来自 view_orch_graphs)" },
    },
    run: async (a) => safeCall(async () => {
      const graphId = String(a.graphId ?? "").trim();
      if (!graphId) return "（需要 graphId — 用 view_orch_graphs 查）";
      const { loadGraph, deleteGraph } = await import("./orchestrator-service.js");
      // 先读一眼: 删一个不存在的 id 会"成功但什么也没发生", 那是最难查的空操作
      const g = await loadGraph(graphId);
      if (!g) return `（图 ${clip(graphId, 20)} 不存在 —— 无需删除; 用 view_orch_graphs 核对 id）`;
      await deleteGraph(graphId);
      return `【已删除】${clip(graphId, 20)} — ${clip(g.name ?? "(未命名)", 30)}（${g.nodes.length} 节点）`;
    }),
  },
  {
    // 写 —— 换运行状态(取消别人在跑的运行也算), 要登记进 WRITE_TOOLS
    name: "orch_control", label: "编排·运行控制", risk: "review",
    description: "控制一次编排运行: pause(暂停) / cancel(取消) / input(提交它在等的输入)。长流程卡在等输入或跑飞了用这个, 比让用户去画布点更快",
    params: {
      runId: { type: "string", required: true, desc: "运行 id(来自 view_orch_runs)" },
      action: { type: "string", required: true, desc: "pause(暂停) / cancel(取消) / input(提交输入)" },
      valuesJson: { type: "string", desc: 'action=input 时必填, JSON 对象: {"topic":"资本下乡","method":"案例"}' },
    },
    run: async (a) => safeCall(async () => {
      const runId = String(a.runId ?? "").trim();
      const action = String(a.action ?? "").trim();
      if (!runId) return "（需要 runId — 用 view_orch_runs 查）";
      const { pauseRun, cancelRun, submitRunInput } = await import("./orchestrator-service.js");
      if (action === "pause") {
        const r = pauseRun(runId);
        return r.ok ? `【已暂停】${clip(runId, 24)} — 用 orch_resume(runId) 续跑（已完成步骤会回放快照, 不重复烧 token）` : `（暂停失败: ${clip(r.error, 160)}）`;
      }
      if (action === "cancel") {
        const r = cancelRun(runId);
        return r.ok ? `【已取消】${clip(runId, 24)}` : `（取消失败: ${clip(r.error, 160)}）`;
      }
      if (action === "input") {
        const raw = String(a.valuesJson ?? "").trim();
        if (!raw) return "（action=input 需要 valuesJson, 形如 {\"topic\":\"资本下乡\"}）";
        let values: Record<string, string>;
        try {
          const j = JSON.parse(raw);
          if (!j || typeof j !== "object" || Array.isArray(j)) return "（valuesJson 需为 JSON 对象）";
          values = Object.fromEntries(Object.entries(j as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]));
        } catch (e: any) { return `（valuesJson 不是合法 JSON: ${clip(e?.message, 100)}）`; }
        const r = submitRunInput(runId, values);
        return r.ok
          ? `【已提交输入】${clip(runId, 24)} — ${Object.keys(values).join(", ")}（运行接着往下跑）`
          : `（提交失败: ${clip(r.error, 160)} — 只有正在等输入的运行能提交, 用 view_orch_run_detail 看它是不是 waiting_input）`;
      }
      return "（action 需为 pause / cancel / input）";
    }),
  },
  {
    // 写 —— 恢复会真的继续执行, 要登记进 WRITE_TOOLS
    name: "orch_resume", label: "编排·恢复运行", risk: "review",
    description: "恢复一条已暂停的编排: 从库里那张图+已完成步骤重建执行, 已完成步骤回放快照不重跑。受 Agent 编排开关约束 —— 恢复本质是「继续让编排跑」, 所以和起新运行同一道闸, 否则「开了又关」的开关等于没关",
    params: {
      runId: { type: "string", required: true, desc: "运行 id(暂停状态; 来自 view_orch_runs)" },
    },
    run: async (a) => safeCall(async () => {
      const runId = String(a.runId ?? "").trim();
      if (!runId) return "（需要 runId — 用 view_orch_runs 查）";
      const { resumeRun, getRunProgress } = await import("./orchestrator-service.js");
      // 先确认这次运行存在(快照与状态都在这一个调用里): 错的 runId 直接说清楚,
      //   否则用户拿到的是"恢复失败: 运行快照不存在", 还得自己猜是不是 id 写错了
      const before = await getRunProgress(runId);
      if (!before.ok) return `（没有这次运行: ${clip(runId, 24)} — 用 view_orch_runs 核对 id; 恢复靠库里的图快照重建执行计划, 没有就无从续跑）`;
      // 闸: 恢复本质是"继续让编排跑", 与起新运行同一道 —— 否则「开了又关」的开关等于没关
      const gate = await requireAgentOrchestration();
      if (gate) return gate;
      const caller = currentCaller();
      const r = await resumeRun(runId, caller);
      if (!r.ok) return `（恢复失败: ${clip(r.error, 200)}）`;
      const noId = caller.userId ? "" : "\n（本次调用没有登录身份 —— 续跑里的端点型能力会 401; 回到对话/界面里发起恢复才带得上身份）";
      return `【已恢复】${clip(runId, 24)} — 后台从快照重建续跑中（已完成的步骤回放, 不重复烧 token）\n看进度: view_orch_run_detail(runId)${noId}`;
    }),
  },
  {
    // 写 —— 改系统配置(Agent 能不能触发编排), 要登记进 WRITE_TOOLS
    name: "orch_settings_set", label: "编排·开关设置", risk: "review",
    description: "改 Agent 编排开关: enabled(允不允许 Agent 触发编排) / maxNodes(单次最多几个节点) / requireConfirm。环境变量 ORCH_AGENT_ENABLED 未开时开不起来, 会如实回失败原因",
    params: {
      enabled: { type: "boolean", desc: "允许 Agent 触发编排(开/关)" },
      maxNodes: { type: "number", desc: "单次 Agent 触发的编排最多节点数(1..64, 防一句话烧掉整月额度)" },
      requireConfirm: { type: "boolean", desc: "是否要求人工确认后才真跑" },
    },
    run: async (a) => safeCall(async () => {
      const patch: { enabled?: boolean; maxNodes?: number; requireConfirm?: boolean } = {};
      if (a.enabled !== undefined) patch.enabled = toBool(a.enabled);
      if (a.requireConfirm !== undefined) patch.requireConfirm = toBool(a.requireConfirm);
      if (a.maxNodes !== undefined) {
        const n = Math.floor(Number(a.maxNodes));
        if (!Number.isFinite(n) || n < 1 || n > 64) return `（maxNodes 需为 1..64 的整数, 收到 ${clip(a.maxNodes, 20)}）`;
        patch.maxNodes = n;
      }
      if (!Object.keys(patch).length) return "（至少给一个: enabled / maxNodes / requireConfirm）";
      const { setAgentOrchestrationSetting } = await import("./orchestrator-service.js");
      const s = await setAgentOrchestrationSetting(patch);
      return `【编排开关已更新】Agent 触发编排: ${s.enabled ? "开" : "关"} · 最多 ${s.maxNodes} 节点 · 要求人工确认: ${s.requireConfirm ? "是" : "否"}\n（环境变量允许开: ${s.envAllowed ? "是" : "否"}）`;
    }),
  },
  {
    // 写 —— 写提案文件 + 烧一次 LLM, 要登记进 WRITE_TOOLS
    // 注意: 它**不跑编排**, 所以不受 orch_run 那道开关约束 —— 开关关着的时候更需要能先组提案看看
    name: "orch_dag_propose", label: "编排·提案一条 DAG", risk: "safe",
    description: "让 LLM 把技能库里的已批准技能组组装成一条候选 MetaSkill DAG(进隔离区, 不自动启用)。红线: 提案不会自动 accept, 要人审 —— 用 orch_dag_decide 决定",
    params: {
      goal: { type: "string", required: true, desc: "高频任务主题(要解决什么, 如 批量做文献综述)" },
      seenCount: { type: "number", desc: "这个主题出现过几次(证据, 默认1)" },
      skillIds: { type: "string", desc: "指定参与编排的已批准技能 id, 逗号分隔(省略则取共识最高的 5 个)" },
    },
    run: async (a) => safeCall(async () => {
      const goal = String(a.goal ?? "").trim();
      if (!goal) return "（需要 goal: 要解决的高频任务主题）";
      const idsRaw = String(a.skillIds ?? "").trim();
      const skillIds = idsRaw ? idsRaw.split(/[,\s]+/).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0) : undefined;
      const { proposeMetaSkillDag } = await import("./meta-skill-propose-service.js");
      const p = await proposeMetaSkillDag(goal, Math.max(Number(a.seenCount) || 1, 1), skillIds);
      if (!p) return "（组装失败: 技能库为空或 LLM 解析不出可用 DAG —— 不会硬造一条假流程; 可换更具体的 goal 重试）";
      const steps = (p.dag?.steps ?? []) as Array<{ id?: string; kind?: string; label?: string }>;
      const rows = steps.slice(0, 15).map((s, i) => `${i + 1}. ${s.id ?? "?"} — ${clip(s.label ?? s.kind, 40)} [${s.kind ?? "?"}]`);
      return `【提案已生成】${p.id} — ${clip(p.dag?.name, 30)}（${steps.length} 步）\n来源技能: ${p.sourceSkillNames.slice(0, 5).join("/")}\n${rows.join("\n")}\n\n红线: 提案不会自动启用。接受(注册成可跑 DAG): orch_dag_decide("${p.id}", "accept"); 否决: orch_dag_decide("${p.id}", "reject")`;
    }),
  },
  {
    // 写 —— accept 会把 DAG 写进运行时注册表(变成可被 meta_invoke 触发的流程), reject 改提案状态;
    // 两者都是人审动作(服务层红线: 提案不自动 accept), 要登记进 WRITE_TOOLS
    name: "orch_dag_decide", label: "编排·审候选 DAG", risk: "review",
    description: "对候选 DAG 提案做人工决定: accept(注册成可跑的 MetaSkill, 之后能被 meta_invoke / 画布打开) 或 reject(否决)。两条路都不自动启用编排开关",
    params: {
      id: { type: "string", required: true, desc: "提案 id(来自 view_orch_dag_proposals)" },
      decision: { type: "string", required: true, desc: "accept(接受) / reject(否决)" },
    },
    run: async (a) => safeCall(async () => {
      const id = String(a.id ?? "").trim();
      const decision = String(a.decision ?? "").trim();
      if (!id) return "（需要 id — 用 view_orch_dag_proposals 查）";
      if (decision !== "accept" && decision !== "reject") return "（decision 需为 accept / reject）";
      const { acceptDagProposal, rejectDagProposal } = await import("./meta-skill-propose-service.js");
      if (decision === "accept") {
        const r = await acceptDagProposal(id);
        if (!r.ok) return `（接受失败: ${clip(r.error, 160)}）`;
        return `【已接受】${clip(id, 24)} → 注册为可跑 DAG ${clip(r.dagId, 24)}\n看它长什么样: view_orch_meta_to_graph("${clip(r.dagId, 24)}"); 要跑还得看 Agent 编排开关是否打开（view_orch_settings）。`;
      }
      const r = rejectDagProposal(id);
      return r.ok ? `【已否决】${clip(id, 24)}` : `（否决失败: ${clip(r.error, 160)}）`;
    }),
  },
];
