// agent-hooks.ts — 借鉴 DSH hooks 包: 任务/工具生命周期钩子
// 事件: task_start/task_end/tool_before/tool_after/step_fail/reflect
// 钩子类型: 内置(日志/指标) + 用户注册(通过 API 动态添加, 如通知/告警/统计)
// 用法: agentHooks.emit("task_start", { taskId, goal }) — 所有订阅者按注册序执行, 异常隔离
export type HookEventName = "task_start" | "task_end" | "tool_before" | "tool_after" | "step_fail" | "reflect" | "approval";

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
    const out: Record<HookEventName, number> = { task_start: 0, task_end: 0, tool_before: 0, tool_after: 0, step_fail: 0, reflect: 0, approval: 0 };
    for (const [event, list] of this.hooks) {
      if (event in out) out[event as HookEventName] = list.length;
    }
    return out;
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
