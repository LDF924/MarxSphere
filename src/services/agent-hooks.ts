// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-hooks.ts — 借鉴 DSH hooks 包: 任务/工具生命周期钩子
// 事件: task_start/task_end/tool_before/tool_after/step_fail/reflect
// 钩子类型: 内置(日志/指标) + 用户注册(通过 API 动态添加, 如通知/告警/统计)
// 用法: agentHooks.emit("task_start", { taskId, goal }) — 所有订阅者按注册序执行, 异常隔离
export type HookEventName = "task_start" | "task_end" | "tool_before" | "tool_after" | "step_fail" | "reflect" | "approval"
  | "turn_stop" | "pre_tool_use" | "post_tool_use" | "permission_request";

export interface AgentHook {
  id: string;
  event: HookEventName;
  name: string;
  /** 处理器: 返回字符串则写入执行日志; 异常被隔离不影响主流程 */
  handler: (payload: Record<string, unknown>) => Promise<string | void> | string | void;
  enabled: boolean;
}

/** 钩子注册表（内存; 可 API 动态增删） */
class AgentHookRegistry {
  private hooks = new Map<string, AgentHook[]>();

  /** 注册钩子（返回钩子 id） */
  register(event: HookEventName, name: string, handler: AgentHook["handler"]): string {
    const id = `hook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const list = this.hooks.get(event) || [];
    list.push({ id, event, name, handler, enabled: true });
    this.hooks.set(event, list);
    return id;
  }

  /** 注销钩子 */
  unregister(id: string): boolean {
    for (const [event, list] of this.hooks) {
      const idx = list.findIndex((h) => h.id === id);
      if (idx >= 0) { list.splice(idx, 1); return true; }
    }
    return false;
  }

  /** 触发事件: 所有启用的钩子按注册序执行; 单个钩子异常/超时不影响其他 */
  async emit(event: HookEventName, payload: Record<string, unknown>): Promise<Array<{ id: string; name: string; output?: string; error?: string }>> {
    const list = this.hooks.get(event) || [];
    const results: Array<{ id: string; name: string; output?: string; error?: string }> = [];
    for (const h of list) {
      if (!h.enabled) continue;
      try {
        const output = await Promise.race([
          Promise.resolve(h.handler(payload)),
          new Promise<string | void>((_, reject) => setTimeout(() => reject(new Error("钩子超时(5s)")), 5000)),
        ]);
        if (output) results.push({ id: h.id, name: h.name, output: String(output).slice(0, 200) });
      } catch (e: any) {
        results.push({ id: h.id, name: h.name, error: String(e?.message || e).slice(0, 100) });
      }
    }
    return results;
  }

  /** 列出全部钩子（管理/审计） */
  list(): Array<{ id: string; event: HookEventName; name: string; enabled: boolean }> {
    const out: Array<{ id: string; event: HookEventName; name: string; enabled: boolean }> = [];
    for (const [event, list] of this.hooks) {
      for (const h of list) out.push({ id: h.id, event: h.event, name: h.name, enabled: h.enabled });
    }
    return out;
  }

  /** 事件统计（运维） */
  stats(): Record<HookEventName, number> {
    const out: Record<HookEventName, number> = { task_start: 0, task_end: 0, tool_before: 0, tool_after: 0, step_fail: 0, reflect: 0, approval: 0, turn_stop: 0, pre_tool_use: 0, post_tool_use: 0, permission_request: 0 };
    for (const [event, list] of this.hooks) {
      if (event in out) out[event as HookEventName] = list.length;
    }
    return out;
  }

  /**
   * V400: Stop 钩子 (codex run_turn_stop_hooks 对齐)
   * 回合结束前运行: 返回 should_stop(结束) 或 should_block(注入消息继续)
   * 实现: 收集所有 turn_stop 订阅者的返回, 任一 {block:true} → block, {stop:true} → stop
   */
  async emitStop(turnPayload: Record<string, unknown>): Promise<{ shouldStop: boolean; shouldBlock: boolean; blockMessages: string[] }> {
    const list = this.hooks.get("turn_stop") || [];
    let shouldStop = false;
    let shouldBlock = false;
    const blockMessages: string[] = [];
    for (const h of list) {
      if (!h.enabled) continue;
      try {
        const out = await Promise.race([
          Promise.resolve(h.handler(turnPayload)),
          new Promise<string | void>((_, reject) => setTimeout(() => reject(new Error("Stop钩子超时(5s)")), 5000)),
        ]);
        const text = String(out || "");
        if (/stop|终止|结束/.test(text)) shouldStop = true;
        if (/block|继续|注入/.test(text)) { shouldBlock = true; blockMessages.push(text.slice(0, 200)); }
      } catch { /* 钩子异常隔离 */ }
    }
    return { shouldStop, shouldBlock, blockMessages };
  }

  /**
   * V400: PreToolUse 钩子 (codex hook_runtime.rs:184 对齐)
   * 工具执行前运行: 可返回 {block, updatedInput} — block 拒绝, updatedInput 改写参数
   */
  async emitPreToolUse(payload: Record<string, unknown>): Promise<{ blocked: boolean; updatedInput?: Record<string, unknown>; reason?: string }> {
    const list = this.hooks.get("pre_tool_use") || [];
    for (const h of list) {
      if (!h.enabled) continue;
      try {
        const out = await Promise.race([
          Promise.resolve(h.handler(payload)),
          new Promise<string | void>((_, reject) => setTimeout(() => reject(new Error("PreToolUse钩子超时(5s)")), 5000)),
        ]);
        const text = String(out || "");
        if (/block|拒绝|禁止/.test(text)) return { blocked: true, reason: text.slice(0, 200) };
        // updatedInput: 钩子返回 JSON { updatedInput: {...} }
        try {
          const parsed = JSON.parse(text);
          if (parsed?.updatedInput) return { blocked: false, updatedInput: parsed.updatedInput };
        } catch { /* 非 JSON 忽略 */ }
      } catch { /* 钩子异常隔离 */ }
    }
    return { blocked: false };
  }

  /**
   * V400: PostToolUse 钩子 (codex hook_runtime.rs:285 对齐)
   * 工具执行后运行: 可返回 failureMessage 替换模型可见输出
   */
  async emitPostToolUse(payload: Record<string, unknown>): Promise<{ failureMessage?: string }> {
    const list = this.hooks.get("post_tool_use") || [];
    for (const h of list) {
      if (!h.enabled) continue;
      try {
        const out = await Promise.race([
          Promise.resolve(h.handler(payload)),
          new Promise<string | void>((_, reject) => setTimeout(() => reject(new Error("PostToolUse钩子超时(5s)")), 5000)),
        ]);
        const text = String(out || "");
        const m = text.match(/failure[:_]?message\s*[:=]\s*(.+)/i);
        if (m) return { failureMessage: m[1].slice(0, 300) };
      } catch { /* 钩子异常隔离 */ }
    }
    return {};
  }

  /**
   * V400: PermissionRequest 钩子 (codex approvals.rs:495 对齐 — 审批三级链第一级)
   * 审批前运行: 返回 allow/deny 即终局; 无返回则降级 Guardian/用户
   */
  async emitPermissionRequest(payload: Record<string, unknown>): Promise<"allow" | "deny" | "none"> {
    const list = this.hooks.get("permission_request") || [];
    for (const h of list) {
      if (!h.enabled) continue;
      try {
        const out = await Promise.race([
          Promise.resolve(h.handler(payload)),
          new Promise<string | void>((_, reject) => setTimeout(() => reject(new Error("Permission钩子超时(5s)")), 5000)),
        ]);
        const text = String(out || "").toLowerCase();
        if (/allow|允许|通过/.test(text)) return "allow";
        if (/deny|拒绝|禁止/.test(text)) return "deny";
      } catch { /* 钩子异常隔离 */ }
    }
    return "none";
  }
}

export const agentHooks = new AgentHookRegistry();

/** 内置钩子: 任务完成 → 写执行日志（默认注册） */
export function registerBuiltinHooks(): void {
  // 幂等: 只注册一次
  if ((globalThis as any).__agentHooksBuiltin) return;
  (globalThis as any).__agentHooksBuiltin = true;
  agentHooks.register("task_end", "内置: 任务完成日志", async (payload) => {
    const taskId = String(payload.taskId || "");
    const status = String(payload.status || "");
    return `[hook] 任务 ${taskId.slice(0, 8)} ${status}${payload.loopCount ? ` (${payload.loopCount}轮)` : ""}`;
  });
}

// ═══ 差距E③(Codex turn_diff_tracker): 工作区变更跟踪 ═══
// 记录 agent_workspace 文件的变更（tool_after 时对比快照）; 变更列表入执行日志
const workspaceSnapshots = new Map<string, Map<string, { mtime: number; size: number }>>();

/** 快照工作区文件状态（任务开始时调用） */
export function snapshotWorkspace(taskId: string): void {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const ws = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
    if (!fs.existsSync(ws)) return;
    const snap = new Map<string, { mtime: number; size: number }>();
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p, depth + 1);
        else {
          const st = fs.statSync(p);
          snap.set(path.relative(ws, p), { mtime: st.mtimeMs, size: st.size });
        }
      }
    };
    walk(ws, 0);
    workspaceSnapshots.set(taskId, snap);
  } catch { /* 快照失败忽略 */ }
}

/** 对比快照 → 变更列表（tool_after 时调用; 返回变更文件 + 变更类型） */
export function diffWorkspace(taskId: string): Array<{ file: string; change: "modified" | "created" | "deleted" }> {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const ws = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
    const before = workspaceSnapshots.get(taskId);
    if (!before || !fs.existsSync(ws)) return [];
    const changes: Array<{ file: string; change: "modified" | "created" | "deleted" }> = [];
    const seen = new Set<string>();
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p, depth + 1);
        else {
          const rel = path.relative(ws, p);
          seen.add(rel);
          const st = fs.statSync(p);
          const prev = before.get(rel);
          if (!prev) changes.push({ file: rel, change: "created" });
          else if (prev.mtime !== st.mtimeMs || prev.size !== st.size) changes.push({ file: rel, change: "modified" });
        }
      }
    };
    walk(ws, 0);
    for (const [rel] of before) {
      if (!seen.has(rel)) changes.push({ file: rel, change: "deleted" });
    }
    return changes.slice(0, 20);
  } catch { return []; }
}

/** 清除快照（任务终态时调用, 防内存泄漏） */
export function clearWorkspaceSnapshot(taskId: string): void {
  workspaceSnapshots.delete(taskId);
}
