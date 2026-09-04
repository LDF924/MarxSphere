// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/meta-skill-runtime.ts — V404-4: MetaSkill 声明式 DAG 运行时(试点)
// 借鉴 OpenSquilla docs/authoring/meta-skills.md(声明式 composition.steps, 运行时强制编排而非模型自律):
//   步骤 6 型: agent(复用 SAG 能力) / llm_chat(单次 LLM 生成) / llm_classify(闭集分类路由)
//             / user_input(暂停收集用户输入) / tool_call(确定性工具执行) / llm_gate(质量门判定)
//   depends_on: 前置依赖 → 拓扑排序执行;  route: 条件路由;  on_failure: 单步失败备胎
// 定义见 src/services/meta-skill-defs.ts; 前端最小 UI 见 AgentPanel 内 MetaSkillRunPanel
import { callLlm } from "../ai/llm-common.js";

/** 默认语料库 sourceId(与 agent-tool-router 对齐) */
const DEFAULT_SOURCE_ID = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";

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
}

export interface MetaRunContext {
  runId: string;
  skillId: string;
  input: string;
  outputs: Record<string, string>;
  userValues: Record<string, string>;
  status: "running" | "done" | "failed" | "waiting_input";
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
    .replace(/\{\{\s*inputs?\s*\}\}/g, () => ctx.input)
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
    if (ctx.status !== "waiting_input") return true;
  }
  ctx.status = "failed";
  return false;
}

// ═══ 运行注册表: user_input 中途挂起 → 外部(resumeMetaSkillInput)提交续跑; stepLog 快照供前端逐步显示 ═══
interface LiveRun { ctx: MetaRunContext; stepLog: MetaStepRun[]; }
const liveRuns = new Map<string, LiveRun>();
export function getLiveRun(runId: string): MetaRunContext | undefined { return liveRuns.get(runId)?.ctx; }
export function getLiveRunSnapshot(runId: string): { runId: string; skillId: string; status: string; stepLog: MetaStepRun[] } | undefined {
  const lr = liveRuns.get(runId);
  if (!lr) return undefined;
  return { runId: lr.ctx.runId, skillId: lr.ctx.skillId, status: lr.ctx.status, stepLog: lr.stepLog };
}
export function listLiveRuns(): Array<{ runId: string; skillId: string; status: string }> {
  return [...liveRuns.entries()].map(([runId, lr]) => ({ runId, skillId: lr.ctx.skillId, status: lr.ctx.status }));
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
  status: "done" | "failed";
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
  const runId = `ms-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-6)}`;
  const ctx: MetaRunContext = {
    runId, skillId: def.id, input: inputText,
    outputs: {}, userValues: opts.userValues || {}, status: "running",
  };
  const stepLog: MetaStepRun[] = def.steps.map((s) => ({ stepId: s.id, kind: s.kind, label: s.label, status: "pending" }));
  liveRuns.set(runId, { ctx, stepLog });
  try {
    return await runMetaSkillInner(def, ctx, stepLog, opts);
  } finally {
    // 运行结束(或调用方断开)清理 — waiting_input 挂起时保留 10 分钟供 resume
    if (ctx.status !== "waiting_input") liveRuns.delete(runId);
    else {
      setTimeout(() => {
        const cur = liveRuns.get(runId);
        if (cur && cur.ctx.status === "waiting_input") liveRuns.delete(runId);
      }, 10 * 60_000).unref?.();
    }
  }
}

async function runMetaSkillInner(def: MetaSkillDef, ctx: MetaRunContext, stepLog: MetaStepRun[], opts: MetaSkillExecutor): Promise<MetaSkillRunResult> {
  const onStep = opts.onStep || (() => {});
  const logOf = (id: string) => stepLog.find((r) => r.stepId === id)!;
  const execStep: (step: MetaStepDef) => Promise<string> = opts.stepExecutor
    ? (step) => opts.stepExecutor!(step, ctx)
    : (step) => defaultStepExecutor(step, ctx, opts);
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

  for (const stepId of order) {
    if (done.has(stepId) || failed.has(stepId)) continue;
    if (fallbackIds.has(stepId) && !fallbackOf.has(stepId)) continue; // 纯备胎: 主序不跑
    const step = byId.get(stepId)!;
    const depsFailed = (step.depends_on || []).some((d) => failed.has(d));
    if (depsFailed) {
      // 上游失败 → 本步骤跳过
      logOf(stepId).status = "failed";
      logOf(stepId).error = "上游步骤失败, 跳过";
      onStep({ ...logOf(stepId) });
      failed.add(stepId);
      continue;
    }
    const log = logOf(stepId);
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
        continue;
      }
      log.status = "waiting_input";
      log.waitingFields = fields.map((f) => ({ name: f.name, prompt: f.prompt || f.name, required: !!f.required }));
      ctx.status = "waiting_input";
      onStep({ ...log });
      const got = await waitForUserInput(ctx, opts.userInputTimeoutMs ?? 5 * 60_000);
      if (!got) {
        log.status = "failed"; log.error = "用户输入等待超时"; onStep({ ...log });
        failed.add(stepId);
        break;
      }
      ctx.status = "running";
      // 恢复: 直接以提交值落盘(不再走 execStep)
      const outStr = fields.map((f) => `${f.name}: ${ctx.userValues[f.name] ?? ""}`).join("\n");
      log.status = "done"; log.output = outStr; log.waitingFields = undefined;
      log.durationMs = Date.now() - (log.startedAt || Date.now());
      onStep({ ...log });
      ctx.outputs[stepId] = outStr;
      done.add(stepId);
      continue;
    }
    try {
      let out = await execStep(step);
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
      // 条件路由: 命中 → 提前解除目标步骤的 fallbackIds 限制并排入队尾补跑
      if (step.route) {
        const hit = step.route.find((r) => evalCondition(r.when, ctx));
        if (hit && !done.has(hit.to) && !failed.has(hit.to)) {
          fallbackIds.delete(hit.to); // 若目标本是备胎, 路由显式要求 → 解除
        }
      }
    } catch (e: any) {
      log.status = "failed"; log.error = String(e?.message || e).slice(0, 300);
      onStep({ ...log });
      failed.add(stepId);
      // on_failure 备胎
      const fb = fallbackOf.get(stepId);
      if (fb && !done.has(fb.id)) {
        const fbLog = logOf(fb.id);
        fbLog.status = "running"; fbLog.startedAt = Date.now();
        onStep({ ...fbLog });
        try {
          const out = await execStep(fb);
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
  }

  const status: "done" | "failed" = failed.size > 0 ? "failed" : "done";
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
