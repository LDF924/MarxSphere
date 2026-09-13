// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/meta-skill-runtime.ts — V404-4: MetaSkill 声明式 DAG 运行时(试点)
// 借鉴 OpenSquilla docs/authoring/meta-skills.md(声明式 composition.steps, 运行时强制编排而非模型自律):
//   步骤 6 型: agent(复用 SAG 能力) / llm_chat(单次 LLM 生成) / llm_classify(闭集分类路由)
//             / user_input(暂停收集用户输入) / tool_call(确定性工具执行) / llm_gate(质量门判定)
//   depends_on: 前置依赖 → 拓扑排序执行;  route: 条件路由;  on_failure: 单步失败备胎
// 定义见 src/services/meta-skill-defs.ts; 前端最小 UI 见 AgentPanel 内 MetaSkillRunPanel
import { callLlm } from "../ai/llm-common.js";
import { selfBaseUrl } from "./base-urls.js";
import pLimit from "p-limit";

/**
 * V415: 编排并发闸。
 *
 * 为什么用 p-limit 走中心额度: 每个节点的终点要么是 PG、要么是 MCP 池、要么是 LLM。
 * 平台已在 db/concurrency.ts 用 pgLimit(2)/cogneeMcpLimit(3)/graphitiMcpLimit(3) 卡住这些出口;
 * 编排若自己开一套并发, 会绕开这些中心限制 —— 并行分支一起打下去就可能把 PG 连接池打爆,
 * 而 PG 打爆是**全局**故障(其它 tab 一起挂)。所以这里的上限默认保守,
 * 且与 LLM 供应商的限流口径对齐(详见 orchestrator-concurrency 的注释)。
 *
 * ORCH_CONCURRENCY=1 时行为等价于旧的严格串行(便于回归对照与排障)。
 */
const ORCH_CONCURRENCY = Math.max(1, parseInt(process.env.ORCH_CONCURRENCY || "3", 10));
let sharedLimit: ReturnType<typeof pLimit> | null = null;
/** 惰性单例: 同一进程内所有编排共用一个额度池(不是每次运行一个新的, 否则多运行叠加会失控) */
function concurrencyLimit(): ReturnType<typeof pLimit> {
  if (!sharedLimit) sharedLimit = pLimit(ORCH_CONCURRENCY);
  return sharedLimit;
}

/** 默认语料库 sourceId(与 agent-tool-router 对齐) */
const DEFAULT_SOURCE_ID = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";

/** V415: 端点型能力的超时(工作台能力里有跑 LLM/沙箱的, 不能沿用默认的短超时) */
const ENDPOINT_TIMEOUT_MS = Number(process.env.ORCH_ENDPOINT_TIMEOUT_MS) || 5 * 60_000;

/**
 * V415: 调 MarxSphere 自身的 HTTP 端点(工作台能力的统一执行路径)。
 *
 * 为什么走 HTTP 而不是直接 import service: 注册表里的工作台能力(实证/统计/审稿/绘图…)
 * 各有自己的路由与服务, 它们内部再做鉴权/租户/配额/产物落库。直接调 service 会绕开这一层,
 * 而且签名各异(每个 service 的入参结构不同)。走端点等于"复用面板在做的事", 语义一致。
 *
 * 鉴权: 本机环回请求被 onRequest 钩子豁免(socket 真实地址判定), 无需令牌 ——
 * 与 agent-view-tools 的 self-fetch 同一路径。跨机部署时 selfBaseUrl() 指向内部服务名,
 * 那种情形下由调用方(编排 API)传入令牌。
 */
async function callEndpoint(
  path: string,
  rawBody: unknown,
  ctx: MetaRunContext,
  opts: MetaSkillExecutor
): Promise<string> {
  const body: Record<string, unknown> = {};
  if (rawBody && typeof rawBody === "object") {
    for (const [k, v] of Object.entries(rawBody as Record<string, unknown>)) body[k] = renderTemplate(String(v ?? ""), ctx);
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ENDPOINT_TIMEOUT_MS);
  try {
    const res = await fetch(`${selfBaseUrl()}${path}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // 端点返回 { error } 时把可读信息带进失败原因, 否则排查只能看到状态码
      let detail = text.slice(0, 300);
      try { const j = JSON.parse(text); detail = j?.error?.message || j?.error || j?.message || detail; } catch { /* 非 JSON 原样截断 */ }
      throw new Error(`端点 ${path} 失败(${res.status}): ${detail}`);
    }
    return text.slice(0, 20000);
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`端点 ${path} 超时(${Math.round(ENDPOINT_TIMEOUT_MS / 1000)}s)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export type MetaStepKind = "agent" | "llm_chat" | "llm_classify" | "user_input" | "tool_call" | "llm_gate";

export interface MetaStepDef {
  id: string;
  kind: MetaStepKind;
  label?: string;
  depends_on?: string[];
  /** 执行参数(按 kind 解释; 值支持 {{inputs}}/{{user.x}}/{{outputs.<id>}} 模板) */
  with?: Record<string, unknown>;
  /** llm_classify 输出闭集 */
  output_choices?: string[];
  /** 条件路由 [{when: "outputs.x == 'V'" | "outputs.x contains '词'", to: stepId}] */
  route?: Array<{ when: string; to: string }>;
  /** 失败备胎 step id(同 plan 内, 无自身依赖, 无嵌套 on_failure) */
  on_failure?: string;
  /** user_input 澄清表单 */
  clarify?: { intro?: string; fields: Array<{ name: string; type: string; required?: boolean; prompt?: string }> };
}

export interface MetaSkillDef {
  id: string;
  name: string;
  description: string;
  trigger?: string;
  final_text_mode?: "auto" | "raw" | string; // "step:<id>" 取指定步骤输出
  steps: MetaStepDef[];
}

export interface MetaStepRun {
  stepId: string;
  kind: MetaStepKind;
  label?: string;
  status: "pending" | "running" | "done" | "failed" | "waiting_input";
  output?: string;
  error?: string;
  startedAt?: number;
  durationMs?: number;
  waitingFields?: Array<{ name: string; prompt: string; required: boolean }>;
  /** V415: 该步骤消费了哪些上游步骤的产出(画布上"这条线真的传了数据"的证据) */
  inputsFrom?: string[];
}

export interface MetaRunContext {
  runId: string;
  skillId: string;
  input: string;
  outputs: Record<string, string>;
  userValues: Record<string, string>;
  status: "running" | "done" | "failed" | "waiting_input" | "paused" | "cancelled";
  /** V415: 取消标记 — 外部置 true 后, 每个步骤边界与等待循环都会检查并中止 */
  cancelled?: boolean;
  /**
   * V415: 被暂停打断的执行任务标记(内部用)。
   * Promise.race 只能让调用方提前返回, **打断不了已经在跑的那条链** —— 被打断的旧任务若继续推进,
   * 会和新重建的任务抢同一个 runId 写运行记录(实测: 恢复后进度被旧任务覆盖回去)。
   * 所以打断时给旧 ctx 打上本标记, 循环边界与落库守卫都据此停手。
   */
  pauseAborted?: boolean;
  /**
   * V415: 上游产出聚合 —— 模板里的 {{inputs}} 在**有依赖的步骤**上解析成"依赖的产出",
   * 而不是整条运行的输入。
   *
   * 旧行为(实测踩到): {{inputs}} 恒等于 ctx.input, 于是画布上 A→B 连了线、B 写了
   * {{inputs}}, B 拿到的仍是任务输入而非 A 的产出 —— 节点的 title/params 被彻底忽略,
   * 表现得像"这条线没接线"。对没有 depends_on 的起始节点, {{inputs}} 仍是运行输入。
   */
  stepInput?: string;
}

/** 模板替换: {{inputs}} / {{user.<field>}} / {{outputs.<id>}} / {{...|slice(n)}} / {{user.x || '默认'}} */
export function renderTemplate(tpl: string, ctx: MetaRunContext): string {
  let out = String(tpl || "");
  // user/outputs 字段带默认值: {{user.x || '默认'}}
  out = out.replace(/\{\{\s*(?:user|outputs?)\.([\w-]+)\s*\|\|\s*['"]([^'"]*)['"]\s*\}\}/g, (_, id: string, def: string) => {
    const src = (ctx.userValues[id] ?? ctx.outputs[id] ?? "").trim();
    return src || def;
  });
  out = out
    // V415: 有依赖的步骤 → {{inputs}} 取上游产出(见 MetaRunContext.stepInput 的说明)
    .replace(/\{\{\s*inputs?\s*\}\}/g, () => ctx.stepInput ?? ctx.input)
    .replace(/\{\{\s*user\.(\w+)\s*\}\}/g, (_, k: string) => ctx.userValues[k] ?? "")
    .replace(/\{\{\s*outputs?\.([\w-]+)\s*\}\}/g, (_, id: string) => ctx.outputs[id] ?? "")
    .replace(/\{\{\s*(?:outputs?|user|inputs?)\.([\w-]+)\s*\|\s*slice\((\d+)\)\s*\}\}/g, (_, id: string, n: string) => (ctx.outputs[id] ?? ctx.userValues[id] ?? ctx.input).slice(0, Number(n)))
    .replace(/\{\{([^}]+)\}\}/g, (m) => `[未渲染:${m.slice(0, 40)}]`);
  return out;
}

/** 简单条件: outputs.x == 'VAL' / outputs.x contains '词' / outputs.x(非空) / !outputs.x */
export function evalCondition(expr: string, ctx: MetaRunContext): boolean {
  const e = String(expr || "").trim();
  const eq = /^outputs?\.([\w-]+)\s*==\s*['"]([^'"]*)['"]$/.exec(e);
  if (eq) return (ctx.outputs[eq[1]] ?? "") === eq[2];
  const contains = /^outputs?\.([\w-]+)\s+contains\s+['"]([^'"]*)['"]$/.exec(e);
  if (contains) return (ctx.outputs[contains[1]] ?? "").includes(contains[2]);
  const neg = /^!outputs?\.([\w-]+)$/.exec(e);
  if (neg) return !ctx.outputs[neg[1]];
  const pos = /^outputs?\.([\w-]+)$/.exec(e);
  if (pos) return !!ctx.outputs[pos[1]];
  return false;
}

/** 从 JSON / 代码围栏 / 首个 { 起提取对象(配对大括号, 容忍前后杂文本) */
export function extractJson(text: string): any {
  const direct = String(text || "").replace(/^```(?:json)?\s*\n?|```\s*$/g, "").trim();
  const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
  const j = tryParse(direct);
  if (j) return j;
  const fence = /```json\s*([\s\S]*?)```/.exec(direct);
  if (fence) { const fj = tryParse(fence[1]); if (fj) return fj; }
  // 从首个 { 起找配对 }(处理模型输出末尾带杂文本)
  const start = direct.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < direct.length; i++) {
      const ch = direct[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { const sub = tryParse(direct.slice(start, i + 1)); if (sub) return sub; break; }
      }
    }
  }
  return null;
}

/** 拓扑排序(依赖在前); 环检测返回错误串 */
export function topologicalOrder(steps: MetaStepDef[]): { order: string[]; error?: string } {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const temp = new Set<string>();
  const order: string[] = [];
  const visit = (id: string): string | null => {
    if (visited.has(id)) return null;
    if (temp.has(id)) return `依赖环: ${[...temp, id].join(" → ")}`;
    temp.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) {
      const err = visit(dep);
      if (err) return err;
    }
    temp.delete(id);
    visited.add(id);
    order.push(id);
    return null;
  };
  for (const s of steps) {
    const err = visit(s.id);
    if (err) return { order: [], error: err };
  }
  return { order };
}

/** 引用完整性校验 */
export function validateMetaSkill(def: MetaSkillDef): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set(def.steps.map((s) => s.id));
  for (const s of def.steps) {
    if (s.depends_on) for (const d of s.depends_on) if (!ids.has(d)) errors.push(`步骤 ${s.id} 依赖不存在的 ${d}`);
    if (s.route) for (const r of s.route) if (!ids.has(r.to)) errors.push(`步骤 ${s.id} 路由到不存在的 ${r.to}`);
    if (s.on_failure) {
      if (!ids.has(s.on_failure)) errors.push(`步骤 ${s.id} 备胎不存在 ${s.on_failure}`);
      else {
        const fb = def.steps.find((x) => x.id === s.on_failure)!;
        if (fb.depends_on?.length) errors.push(`备胎 ${fb.id} 不能有自身依赖`);
        if (fb.on_failure) errors.push(`备胎 ${fb.id} 不能嵌套 on_failure`);
      }
    }
    if (s.kind === "llm_classify" && !s.output_choices?.length) errors.push(`步骤 ${s.id} llm_classify 缺 output_choices`);
  }
  const { error } = topologicalOrder(def.steps);
  if (error) errors.push(error);
  return { ok: errors.length === 0, errors };
}

async function waitForUserInput(ctx: MetaRunContext, timeoutMs: number, pollMs = 1200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    // V415: 只把"取消/失败"当终止 —— 暂停期间继续等(用户恢复后仍在这一步等输入),
    // 否则暂停会把这一步直接判死, 恢复也无从继续。超时仍返回 false(异常路径)。
    if (ctx.cancelled || ctx.status === "cancelled" || ctx.status === "failed") return false;
    if (ctx.status !== "waiting_input" && ctx.status !== "paused") return true;
  }
  ctx.status = "failed";
  return false;
}

// ═══ 运行注册表: user_input 中途挂起 → 外部(resumeMetaSkillInput)提交续跑; stepLog 快照供前端逐步显示 ═══
interface LiveRun { ctx: MetaRunContext; stepLog: MetaStepRun[]; }
const liveRuns = new Map<string, LiveRun>();
export function getLiveRun(runId: string): MetaRunContext | undefined { return liveRuns.get(runId)?.ctx; }
/**
 * V415: 判断某个执行任务是否仍有权往该 runId 写状态。
 * 被打断的旧任务(暂停后由快照重建续跑)不在此列 —— 否则会用旧进度覆盖新进度
 * (实测表现为"恢复了但一直卡在 paused")。
 */
export function isLiveRun(runId: string, ctx: MetaRunContext): boolean {
  const cur = liveRuns.get(runId)?.ctx;
  return !!cur && cur === ctx && !ctx.pauseAborted;
}
export function getLiveRunSnapshot(runId: string): { runId: string; skillId: string; status: string; stepLog: MetaStepRun[] } | undefined {
  const lr = liveRuns.get(runId);
  if (!lr) return undefined;
  return { runId: lr.ctx.runId, skillId: lr.ctx.skillId, status: lr.ctx.status, stepLog: lr.stepLog };
}
export function listLiveRuns(): Array<{ runId: string; skillId: string; status: string }> {
  return [...liveRuns.entries()].map(([runId, lr]) => ({ runId, skillId: lr.ctx.skillId, status: lr.ctx.status }));
}

/** V415: 取消 — 置标记 + 状态; 正在跑的那一步由远端服务自行结束(无法强杀), 但本地不再推进 */
export function cancelMetaSkill(runId: string): { ok: boolean; error?: string } {
  const lr = liveRuns.get(runId);
  if (!lr) return { ok: false, error: `运行不存在: ${runId}(可能已结束, 请刷新运行记录)` };
  if (["done", "failed", "cancelled"].includes(lr.ctx.status)) {
    return { ok: false, error: `运行已结束(${lr.ctx.status})` };
  }
  lr.ctx.cancelled = true;
  lr.ctx.status = "cancelled";
  // 取消要立刻生效, 不能等当前步跑完 —— 与暂停同一机制
  abortForPause();
  return { ok: true };
}

/**
 * V415: 暂停/恢复。
 * 语义与旧前端的"暂停"不同 —— 旧实现只清掉前端 setInterval, 后端 job 照跑, 恢复时状态对不上。
 * 这里: 置 ctx.status = "paused" → 步骤边界不再启动新步骤; 若执行器声明了 pausePolicy="abort"
 * 则同时打断**正在跑**的那一步(否则要等当前步自然跑完, 用户点了没反应)。
 * 已完成的步骤产物保留, 恢复时从下一个未完成步骤继续。
 */
export function pauseMetaSkill(runId: string): { ok: boolean; error?: string } {
  const lr = liveRuns.get(runId);
  if (!lr) return { ok: false, error: `运行不存在: ${runId}(可能已结束, 请刷新运行记录)` };
  if (lr.ctx.status !== "running") return { ok: false, error: `运行不在运行中(当前 ${lr.ctx.status})` };
  lr.ctx.status = "paused";
  // 必须**同步**打上 pauseAborted: 否则从 pause 返回到旧任务的 catch 跑完之间有一段窗口,
  // 期间 isLiveRun 会把这条已死的运行当成"还活着"(实测: 恢复接口返回 ok, 但没人推进,
  // 运行永久卡在 running)。
  lr.ctx.pauseAborted = true;
  abortForPause();
  return { ok: true };
}

/**
 * 恢复, 交接给快照重建的执行任务。
 * 旧实现只把 ctx.status 拨回 "running", 那个 ctx 属于已经被打断的旧任务 —— 拨回去等于
 * 把僵尸放生: 它继续推 further, 而重建的新任务同时在写同一个 runId, 两边互相覆盖(实测踩到)。
 * 正确做法: 把旧 ctx 标记为被接管, 并从 liveRuns 摘除, 状态交给调用方落库。
 */
export function resumeMetaSkill(runId: string): { ok: boolean; error?: string } {
  const lr = liveRuns.get(runId);
  if (!lr) return { ok: false, error: `运行不存在: ${runId}(暂停后由编排层重建, 请用 /api/orchestrator/control)` };
  if (lr.ctx.status !== "paused") return { ok: false, error: `运行不在暂停中(当前 ${lr.ctx.status})` };
  lr.ctx.pauseAborted = true;
  liveRuns.delete(runId);
  return { ok: true };
}

/**
 * V415: 从快照续跑 —— 暂停/进程重启后重建执行, 跳过已完成的步骤。
 *
 * 实现要点(实测踩到): **不能把已完成步骤从 steps 里删掉**。删掉会让剩下步骤的
 * depends_on 指向不存在的 id, validateMetaSkill 直接判"定义无效", 续跑一步都不跑。
 * 正确做法是保留完整的步骤表(依赖引用才成立), 只把已完成步骤的产物预先放进 ctx.outputs。
 * 这样它们会被正常遍历到, 但下游需要的输入已经就绪 —— 唯一代价是重新"跑"一次已完成步骤。
 *
 * 为避免重复烧 token, 已完成步骤在这里被替换成**回放节点**: 直接返回快照里的产物, 不调任何外部服务。
 * @param snapshot.completed 已完成步骤 id(其产物从 snapshot.outputs 取, 不重算)
 */
export async function resumeMetaSkillFromSnapshot(
  def: MetaSkillDef,
  inputText: string,
  snapshot: { runId: string; outputs: Record<string, string>; completed: string[]; userValues?: Record<string, string> },
  opts: MetaSkillExecutor = {},
): Promise<MetaSkillRunResult> {
  const done = new Set(snapshot.completed);
  const replay: MetaSkillDef = {
    ...def,
    steps: def.steps.map((s) => (done.has(s.id)
      ? { ...s, kind: "llm_chat" as const, with: { task: "", __replay: snapshot.outputs[s.id] ?? "" }, on_failure: undefined, route: undefined }
      : s)),
  };
  const r = await runMetaSkill(replay, inputText, {
    ...opts,
    runId: snapshot.runId,
    userValues: { ...(snapshot.userValues ?? {}), ...(opts.userValues ?? {}) },
    // 回放节点直接给产物, 不走 LLM
    stepExecutor: (step, ctx) => {
      const w = (step as { with?: Record<string, unknown> }).with ?? {};
      if (typeof w.__replay === "string") return Promise.resolve(w.__replay);
      return defaultStepExecutor(step, ctx, opts);
    },
    // 回放不是"新产出", 不该覆盖快照里更完整的产物 —— 交给这里合并
    sourceId: opts.sourceId,
  });
  const merged = { ...snapshot.outputs };
  for (const [k, v] of Object.entries(r.outputs)) {
    // 已完成步骤保留快照原值(回放值可能被截断/为空), 其余用新产出
    if (!done.has(k) || v.length >= (merged[k] ?? "").length) merged[k] = v;
  }
  return { ...r, outputs: merged };
}
/** 提交 user_input 字段值 → 续跑 */
export function resumeMetaSkillInput(runId: string, values: Record<string, string>): { ok: boolean; error?: string } {
  const lr = liveRuns.get(runId);
  if (!lr) return { ok: false, error: `运行不存在: ${runId}` };
  if (lr.ctx.status !== "waiting_input") return { ok: false, error: `运行不在等待输入(当前 ${lr.ctx.status})` };
  for (const [k, v] of Object.entries(values)) lr.ctx.userValues[k] = String(v ?? "");
  lr.ctx.status = "running";
  return { ok: true };
}

export interface MetaSkillRunResult {
  runId: string;
  /** V415: paused/cancelled 是用户主动操作, 不是失败 —— 旧实现只有 done|failed, 主动暂停被记成失败 */
  status: "done" | "failed" | "paused" | "cancelled";
  output: string;
  stepLog: MetaStepRun[];
  outputs: Record<string, string>;
}

export interface MetaSkillExecutor {
  model?: string;
  sourceId?: string;
  onStep?: (run: MetaStepRun) => void;
  userValues?: Record<string, string>;
  /** 测试注入: 替代真实执行的步骤执行器 */
  stepExecutor?: (step: MetaStepDef, ctx: MetaRunContext) => Promise<string>;
  userInputTimeoutMs?: number;
  /** V415: 工作台能力的端点调用要带令牌(跨机部署时本机豁免不成立) */
  authToken?: string;
  /** V415: 运行状态变化回调(编排层据此落库 —— 刷新/换设备后仍能查到跑到哪了) */
  onStatus?: (ctx: MetaRunContext, stepLog: MetaStepRun[]) => void;
  /** V415: 调用方指定 runId(编排层要先返回 id 再后台跑, 不能等运行时自己生成) */
  runId?: string;
  /**
   * V415: 暂停时如何处置"正在跑"的那一步。
   *   "wait"  — 等这一步跑完(默认; 用于副作用不可重入的场景)
   *   "abort" — 立即中断并放弃其写入, 恢复时重跑(幂等的只读/生成步骤用这个, 否则用户
   *             点了暂停还得盯着当前步跑完, 长任务体验很差)
   */
  pausePolicy?: "wait" | "abort";
}

/** 生产执行器: agent→SAG 综述; llm_*→callLlm; tool_call→executeAgentTool; user_input→等提交 */
async function defaultStepExecutor(step: MetaStepDef, ctx: MetaRunContext, opts: MetaSkillExecutor): Promise<string> {
  const w = step.with || {};
  const render = (v: unknown): string => renderTemplate(String(v ?? ""), ctx);
  const model = opts.model;

  if (step.kind === "agent") {
    const { literatureReviewGeneration } = await import("./writing-output-service.js");
    const r = await literatureReviewGeneration(render(w.topic ?? w.text ?? ctx.input), opts.sourceId || DEFAULT_SOURCE_ID, {
      model, topK: Number(w.topK) || 6,
    });
    return typeof r === "string" ? r : JSON.stringify(r);
  }
  if (step.kind === "llm_chat") {
    const r = await callLlm({
      model,
      messages: [
        ...(w.system ? [{ role: "system" as const, content: render(w.system) }] : []),
        { role: "user", content: render(w.task ?? w.text ?? ctx.input) },
      ],
      maxTokens: Number(w.maxTokens) || 2000,
      temperature: Number(w.temperature ?? 0.3),
    });
    if (!r?.text) throw new Error(r?.error || "LLM 空输出");
    return r.text;
  }
  if (step.kind === "llm_classify") {
    const choices = step.output_choices || [];
    const r = await callLlm({
      model,
      messages: [{ role: "user", content: `把以下文本分类, 只返回一个值(闭集): [${choices.join(" / ")}]\n文本: ${render(w.text ?? ctx.input).slice(0, 2000)}` }],
      maxTokens: 50, temperature: 0,
    });
    const text = (r?.text ?? "").trim();
    return choices.find((c) => text === c || text.includes(c)) ?? choices[0] ?? text;
  }
  if (step.kind === "tool_call") {
    // V415: 两条路径 —— endpoint(工作台能力的 HTTP 端点) 与 tool(agent 工具注册表)。
    // 注册表里 100+ 项能力分属这两类: 工具能同进程直连, 各工作台的面板能力只有端点。
    if (typeof w.endpoint === "string" && w.endpoint) return await callEndpoint(String(w.endpoint), w.body, ctx, opts);
    const { executeAgentTool, buildAgentTools } = await import("./agent-tool-router.js");
    const tools = await buildAgentTools({ sourceId: opts.sourceId });
    const tool = tools.find((t) => t.name === w.tool);
    if (!tool) throw new Error(`工具不存在: ${w.tool}`);
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(w.args || {})) args[k] = render(v);
    const r = await executeAgentTool(tool, args, { role: "analyst" });
    if (!r.ok) throw new Error(r.result.slice(0, 150));
    return r.result;
  }
  if (step.kind === "user_input") {
    const fields = step.clarify?.fields ?? [];
    // 已在调度层把 status 置为 waiting_input — 这里等提交
    const got = await waitForUserInput(ctx, opts.userInputTimeoutMs ?? 5 * 60_000);
    if (!got) throw new Error("用户输入等待超时");
    return fields.map((f) => `${f.name}: ${ctx.userValues[f.name] ?? ""}`).join("\n");
  }
  if (step.kind === "llm_gate") {
    const r = await callLlm({
      model,
      messages: [
        { role: "system", content: render(w.system ?? "你是质量评审员, 判定输入是否合格。只返回 JSON: {\"pass\":true/false,\"reason\":\"...\"}") },
        { role: "user", content: `检查是否满足要求: ${render(w.criteria ?? "")}\n\n内容:\n${render(w.text ?? ctx.outputs[String(w.on || "draft")] ?? ctx.input).slice(0, 3000)}` },
      ],
      jsonMode: true, maxTokens: 200, temperature: 0,
    });
    const j = extractJson(r?.text ?? "") || {};
    return JSON.stringify({ pass: j.pass !== false, reason: j.reason || "" });
  }
  throw new Error(`未知步骤类型: ${step.kind}`);
}

/** 执行 MetaSkill DAG: 校验 → 拓扑序串行执行 → 失败走 on_failure 备胎 → 按 final_text_mode 汇总 */
export async function runMetaSkill(def: MetaSkillDef, inputText: string, opts: MetaSkillExecutor = {}): Promise<MetaSkillRunResult> {
  const v = validateMetaSkill(def);
  if (!v.ok) {
    return { runId: "", status: "failed", output: `MetaSkill 定义无效: ${v.errors.join("; ")}`, stepLog: [], outputs: {} };
  }
  const runId = opts.runId || `ms-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-6)}`;
  const ctx: MetaRunContext = {
    runId, skillId: def.id, input: inputText,
    outputs: {}, userValues: opts.userValues || {}, status: "running",
  };
  const stepLog: MetaStepRun[] = def.steps.map((s) => ({ stepId: s.id, kind: s.kind, label: s.label, status: "pending" }));
  liveRuns.set(runId, { ctx, stepLog });
  // V415: 每次状态/步骤变化都通知编排层落库 —— 刷新、换设备、进程重启后仍查得到跑到哪一步
  const hookStep = opts.onStep;
  const hooked: MetaSkillExecutor = {
    ...opts,
    onStep: (run) => { hookStep?.(run); opts.onStatus?.(ctx, stepLog); },
  };
  // abort 型暂停: ctx 被外部置 paused 后, 当前步的 await 由这里主动打断 —— 不这样做的话
  // "暂停"要等当前步自然跑完才生效(端点是远端服务, 长任务可能几分钟), 用户感知为"点了没反应"。
  const onPauseAbort = opts.pausePolicy === "abort"
    ? new Promise<never>((_, rej) => { pauseAbort = { ctx, reject: rej }; })
    : null;
  try {
    const pending = runMetaSkillInner(def, ctx, stepLog, hooked);
    // 只做竞速不挂默认 handler 会在打断时触发 unhandledRejection(旧任务随后失败没人接) —— 这里接住它
    if (onPauseAbort) pending.catch(() => {});
    const aborted = onPauseAbort ? await Promise.race([pending, onPauseAbort]) : await pending;
    opts.onStatus?.(ctx, stepLog);
    return aborted;
  } catch (e: any) {
    // abort 打断不是失败: 交回一份"暂停中"的结果(已完成的步骤产物保留)
    if (e?.name === "PauseAbort") {
      // 收尾状态直写 DB —— 不走 opts.onStatus。编排层的 onStatus 会先过 isLiveRun 守卫,
      // 而被接管的任务正是被该守卫挡住的; 走 onStatus 的话收尾写不进去, DB 会永久卡在 running。
      // (守卫的本来目的是"别让被接管的任务覆盖新进度", 不该连它自己的收尾也拦掉)
      const { persistRunSnapshot } = await import("./orchestrator-run-store.js");
      await persistRunSnapshot({ runId, skillId: ctx.skillId, input: ctx.input, outputs: ctx.outputs, status: "paused", stepLog });
      return { runId, status: "paused", output: "（已暂停, 恢复到下一个未完成步骤继续）", stepLog, outputs: ctx.outputs };
    }
    throw e;
  } finally {
    if (pauseAbort?.ctx === ctx) pauseAbort = null;
    // V415: 暂停也要从 liveRuns 移除 —— 否则"已暂停"的运行一直挂在内存里, 恢复时
    // 这份残留会让上游(已结束的)那份和恢复新建的那份同名 runId 互相打架。
    // 恢复由 orchestrator 从 DB 快照重建(已完成的步骤不重跑)。waiting_input 仍保留供提交。
    //
    // ⚠ 摘除条件必须排除 pauseAborted: 被接管的那份**不能**在这里摘掉新任务刚登记的 ctx ——
    // 它醒得比新任务早是常态(新任务还没跑到第一个 await), 早先没排除, 结果新任务登记后
    // 立刻被旧任务的 finally 摘走, 之后的 input 提交/暂停/取消全部报"运行不存在"。
    if (ctx.status !== "waiting_input" && !ctx.pauseAborted) liveRuns.delete(runId);
    else if (ctx.status === "waiting_input") {
      setTimeout(() => {
        const cur = liveRuns.get(runId);
        if (cur && cur.ctx.status === "waiting_input") liveRuns.delete(runId);
      }, 10 * 60_000).unref?.();
    }
  }
}

/** V415: 当前被 abort 型暂停挂钩的运行(同一时刻只可能有一个在"被暂停"上) */
let pauseAbort: { ctx: MetaRunContext; reject: (e: Error) => void } | null = null;

function abortForPause(): void {
  if (!pauseAbort) return;
  const e = new Error("paused");
  e.name = "PauseAbort";
  const { ctx, reject } = pauseAbort;
  pauseAbort = null;
  // 先打标记: 被 race 提前返回后, 旧任务仍会走完当前 await 并可能继续推进循环,
  // 这里让它一醒来就知道自己已被接管(见 MetaRunContext.pauseAborted)
  ctx.pauseAborted = true;
  reject(e);
}

async function runMetaSkillInner(def: MetaSkillDef, ctx: MetaRunContext, stepLog: MetaStepRun[], opts: MetaSkillExecutor): Promise<MetaSkillRunResult> {
  const onStep = opts.onStep || (() => {});
  const logOf = (id: string) => stepLog.find((r) => r.stepId === id)!;
  // 执行的 ctx 由调用处传入(并发下每步一个 ctxView, 见 DAG 调度器里 stepInput 的说明);
  // 默认用共享 ctx, 保持单步/测试路径的行为不变。
  const execStep: (step: MetaStepDef, c?: MetaRunContext) => Promise<string> = opts.stepExecutor
    ? (step, c) => opts.stepExecutor!(step, c ?? ctx)
    : (step, c) => defaultStepExecutor(step, c ?? ctx, opts);
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const fallbackOf = new Map<string, MetaStepDef>();
  for (const s of def.steps) {
    if (s.on_failure) {
      const fb = byId.get(s.on_failure);
      if (fb) fallbackOf.set(s.id, fb);
    }
  }
  const { order, error: topoError } = topologicalOrder(def.steps);
  if (topoError) return { runId: ctx.runId, status: "failed", output: topoError, stepLog, outputs: {} };

  const done = new Set<string>();
  const failed = new Set<string>();
  // 标记仅在备胎表里出现的步骤(不主动跑, 由失败触发)
  const fallbackIds = new Set([...fallbackOf.values()].map((f) => f.id));

  // ─── V415: DAG 调度器(带闸并发) ───
  // 旧实现是 `for (const stepId of order)` 严格串行 —— 拓扑序对了, 但并联分支也要一条条跑。
  // 实测: tpl_classical 4 路并联、tpl_academic_map 5 路并联、tpl_retrieval_heavy 4 路并联检索,
  // 画布上画成并联、跑起来却是串行, 形状与行为不一致。
  //
  // 并发闸用平台中心的 p-limit(db/concurrency.ts 的 pgLimit/cogneeMcpLimit/graphitiMcpLimit),
  // 与其它功能共享额度 —— 不能自己开一套绕过去, 否则并发编排会把 PG 连接与 MCP 池打爆。
  // 上限 1 时行为等价于原来的串行(便于回归对照)。
  //
  // 关于 ctx.stepInput: 它是**单个步骤的输入**(见 MetaRunContext.stepInput 的说明)。
  // 并发下多个步骤同时在跑, 一个共享字段会互相踩。所以这里给每个 step 造一个轻量视图 ctxView
  // (Object.create 挂在 ctx 上, 只覆盖 stepInput), 步骤执行器读 ctxView.stepInput 拿到自己的值,
  // 而 outputs/userValues/status/cancelled 等共享状态仍走原型链落到真正的 ctx —— 无需改动
  // renderTemplate 与 defaultStepExecutor 的签名。
  const stepLimit = concurrencyLimit();
  const runStep = async (stepId: string, step: MetaStepDef): Promise<void> => {
    const log = logOf(stepId);
    const deps = (step.depends_on ?? []).filter((d) => ctx.outputs[d] !== undefined);
    log.inputsFrom = deps.length ? deps : undefined;
    const ctxView = Object.create(ctx) as MetaRunContext;
    ctxView.stepInput = deps.length ? deps.map((d) => ctx.outputs[d]).join("\n\n") : ctx.input;

    log.status = "running";
    log.startedAt = Date.now();
    onStep({ ...log });

    if (step.kind === "user_input") {
      // 必填字段已齐(预置/上游提供) → 跳过等待直接继续; 否则挂起等前端提交
      const fields = step.clarify?.fields ?? [];
      const missing = fields.filter((f) => f.required && !(ctx.userValues[f.name] ?? "").trim());
      if (missing.length === 0) {
        const outStr = fields.length ? fields.map((f) => `${f.name}: ${ctx.userValues[f.name] ?? ""}`).join("\n") : ctx.input;
        log.status = "done"; log.output = outStr; log.waitingFields = undefined;
        log.durationMs = Date.now() - (log.startedAt || Date.now());
        onStep({ ...log });
        ctx.outputs[stepId] = outStr;
        done.add(stepId);
        return;
      }
      log.status = "waiting_input";
      log.waitingFields = fields.map((f) => ({ name: f.name, prompt: f.prompt || f.name, required: !!f.required }));
      ctx.status = "waiting_input";
      onStep({ ...log });
      const got = await waitForUserInput(ctx, opts.userInputTimeoutMs ?? 5 * 60_000);
      if (!got) {
        // V415: 取消/暂停与"等待超时"要分开报 —— 前者是用户操作, 后者是异常。
        // 注意 ctx.status 被 waitForUserInput 改过, TS 从上一行的赋值推断不出, 故显式收窄。
        const stop = ctx.status as string;
        if (stop === "cancelled" || ctx.cancelled) {
          log.status = "failed"; log.error = "已取消"; onStep({ ...log });
        } else if (stop === "paused") {
          log.status = "pending"; log.error = undefined; onStep({ ...log });
        } else {
          log.status = "failed"; log.error = "用户输入等待超时"; onStep({ ...log });
        }
        failed.add(stepId);
        return;
      }
      ctx.status = "running";
      // 恢复: 直接以提交值落盘(不再走 execStep)
      const outStr = fields.map((f) => `${f.name}: ${ctx.userValues[f.name] ?? ""}`).join("\n");
      log.status = "done"; log.output = outStr; log.waitingFields = undefined;
      log.durationMs = Date.now() - (log.startedAt || Date.now());
      onStep({ ...log });
      ctx.outputs[stepId] = outStr;
      done.add(stepId);
      return;
    }

    try {
      let out = await execStep(step, ctxView);
      // llm_gate 判定不过 → 走失败语义(触发 on_failure 备胎)
      if (step.kind === "llm_gate") {
        const j = extractJson(out) || {};
        if (j.pass === false) {
          const reason = String(j.reason || "质量门未通过");
          if (step.on_failure) throw new Error(`质量门未通过: ${reason}`);
          // 无备胎 → 附加说明后仍算 done(软门)
          out = JSON.stringify({ pass: false, reason, note: "无备胎步骤, 结果透传" });
        }
      }
      ctx.outputs[stepId] = out;
      log.status = "done"; log.output = out; log.waitingFields = undefined;
      log.durationMs = Date.now() - (log.startedAt || Date.now());
      onStep({ ...log });
      done.add(stepId);
      // 条件路由: 命中 → 立刻补跑目标(它可能是只为路由存在的节点, 被排除在可调度集之外)
      if (step.route) {
        const hit = step.route.find((r) => evalCondition(r.when, ctx));
        if (hit && !done.has(hit.to) && !failed.has(hit.to) && !runningIds.has(hit.to)) {
          const target = byId.get(hit.to);
          if (target && !isTerminal()) {
            fallbackIds.delete(hit.to); // 若目标本是备胎, 路由显式要求 → 解除
            runningIds.add(hit.to);
            await stepLimit(() => runStep(hit.to, target)).finally(() => runningIds.delete(hit.to));
          }
        }
      }
    } catch (e: any) {
      log.status = "failed"; log.error = String(e?.message || e).slice(0, 300);
      onStep({ ...log });
      failed.add(stepId);
      // on_failure 备胎
      const fb = fallbackOf.get(stepId);
      if (fb && !done.has(fb.id) && !failed.has(fb.id)) {
        const fbLog = logOf(fb.id);
        fbLog.status = "running"; fbLog.startedAt = Date.now();
        onStep({ ...fbLog });
        try {
          const out = await execStep(fb, ctxView);
          ctx.outputs[stepId] = out;
          ctx.outputs[fb.id] = out;
          fbLog.status = "done"; fbLog.output = out;
          fbLog.durationMs = Date.now() - (fbLog.startedAt || Date.now());
          onStep({ ...fbLog });
          done.add(fb.id);
          done.add(stepId); // 备胎成功视原步骤完成
          failed.delete(stepId);
        } catch (e2: any) {
          fbLog.status = "failed"; fbLog.error = String(e2?.message || e2).slice(0, 300);
          onStep({ ...fbLog });
          failed.add(fb.id);
        }
      }
    }
  };

  const runningIds = new Set<string>();
  /** 该停了么(取消/暂停/被接管) —— 与旧串行循环的边界检查同一语义, 只是现在在调度循环里 */
  const isTerminal = () => !!ctx.pauseAborted || ctx.cancelled || ctx.status === "cancelled" || ctx.status === "paused";

  /** 某步骤现在能不能启动: 依赖都结束(成功或失败已决), 且没在跑/没结束 */
  const readyToRun = (step: MetaStepDef): boolean => {
    if (done.has(step.id) || failed.has(step.id) || runningIds.has(step.id)) return false;
    return (step.depends_on ?? []).every((d) => done.has(d) || failed.has(d));
  };
  /** 依赖里只要有失败的 → 本步骤跳过(旧串行的 depsFailed 分支) */
  const depFailed = (step: MetaStepDef) => (step.depends_on ?? []).some((d) => failed.has(d));

  // 可调度集排除"纯备胎"节点(只在失败时被调用), 但若它被 route 指到则由 route 分支补跑
  const schedulable = order.map((id) => byId.get(id)!).filter((s) => !(fallbackIds.has(s.id) && !fallbackOf.has(s.id)));

  let pending = schedulable.length;
  while (pending > 0) {
    if (isTerminal()) break;
    const batch = schedulable.filter((s) => readyToRun(s) && !depFailed(s) && !isTerminal());
    if (!batch.length) {
      // 没有可启动的, 也没有在跑的 → 剩下的都卡在未决依赖上(正常不该发生, 拓扑序已保证无环)
      if (!runningIds.size) break;
      await new Promise((r) => setTimeout(r, 120));
      continue;
    }
    pending -= batch.length;
    await Promise.all(batch.map((s) => {
      runningIds.add(s.id);
      return stepLimit(() => runStep(s.id, s)).finally(() => runningIds.delete(s.id));
    }));
    // 依赖失败而跳过的步骤: 在这里统一记失败(否则它们的下游会永远等不到)
    for (const s of schedulable) {
      if (!done.has(s.id) && !failed.has(s.id) && !runningIds.has(s.id) && depFailed(s)) {
        const l = logOf(s.id);
        l.status = "failed"; l.error = "上游步骤失败, 跳过";
        onStep({ ...l });
        failed.add(s.id);
        pending--;
      }
    }
  }

  // V415: 暂停/取消不是"失败" —— 旧实现只有 done|failed 两态, 用户主动停下会被记成失败,
  // 前端据此报"执行失败, 可修正后重试", 与实际不符。
  // 被接管的旧任务(暂停后重建续跑)不得回写终态 —— 否则会把新任务的进度覆盖成旧值。
  if (ctx.pauseAborted) {
    return { runId: ctx.runId, status: "paused", output: "（已被重新接管的执行取代, 本任务不再写出）", stepLog, outputs: ctx.outputs };
  }
  const aborted = ctx.status === "paused" || ctx.status === "cancelled";
  const status: "done" | "failed" | "paused" | "cancelled" =
    aborted ? (ctx.status as "paused" | "cancelled") : failed.size > 0 ? "failed" : "done";
  ctx.status = status;
  let output = "";
  if (def.final_text_mode?.startsWith("step:")) {
    output = ctx.outputs[def.final_text_mode.slice(5)] ?? "（指定步骤无输出）";
  } else if (def.final_text_mode === "raw") {
    const last = order.filter((id) => ctx.outputs[id]).pop();
    output = last ? ctx.outputs[last] : "（无输出）";
  } else {
    output = Object.entries(ctx.outputs)
      .map(([, v]) => v).join("\n\n").slice(0, 8000) || "（无输出）";
  }
  return { runId: ctx.runId, status, output, stepLog, outputs: ctx.outputs };
}
