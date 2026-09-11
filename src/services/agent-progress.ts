// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-progress.ts — V395-2: 任务流式进度（SSE 事件中心）
// runAgentTask 各阶段发布事件 → /api/agent/tasks/:id/stream 推送给前端
// 事件类型: snapshot(初始快照) | task(状态) | step(步骤) | reflect(循环评估) | exec_log(执行日志, V395-7) | done
// V396-12: 工具生命周期事件 — tool_start(开始) | tool_complete(完成) | tool_error(失败), 前端渲染工具卡片
// 订阅者与任务同生命周期: 前端 EventSource 连接注册, 断开自动清理
export interface AgentProgressEvent {
  type: "task" | "step" | "reflect" | "exec_log" | "done" | "error" | "tool_start" | "tool_complete" | "tool_error";
  taskId: string;
  timestamp: number;
  data: Record<string, unknown>;
  /** W3: 事件序号（SSE id: 字段, 断线续传用） */
  seq?: number;
  /** 差距R③(Codex event_mapping): 统一溯源字段 — 事件来源组件/工具/层 */
  source?: string;
  /** 差距R③: 事件关联的工具名（tool_start/complete/error 时） */
  tool?: string;
}

type Listener = (ev: AgentProgressEvent) => void;

/** taskId → 订阅者集合（前端 EventSource 连接） */
const subscribers = new Map<string, Set<Listener>>();

// ═══════ W3: 事件环形缓冲（断线重连补发中间事件）═══════
/** taskId → 最近 100 条事件（进程内, 断线重连可补发; 进程重启后依赖 snapshot 全量） */
const eventBuffer = new Map<string, AgentProgressEvent[]>();
const BUFFER_MAX = 100;
let globalSeq = 0;

/** 订阅任务进度（返回取消订阅函数） */
export function subscribeAgentProgress(taskId: string, cb: Listener): () => void {
  let set = subscribers.get(taskId);
  if (!set) {
    set = new Set();
    subscribers.set(taskId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) subscribers.delete(taskId);
  };
}

/** 发布一次进度事件（所有订阅者收到; 监听器异常不影响发布; W3: 写入环形缓冲带序号）
 *  同时落库(异步, 不阻塞): 多副本下观察者可能连在别的实例上, 只靠内存缓冲会"零事件永不 done"。 */
export function publishAgentProgress(ev: Omit<AgentProgressEvent, "timestamp">): void {
  const seq = ++globalSeq;
  const full: AgentProgressEvent = { ...ev, timestamp: Date.now(), seq };
  void persistEvent(full);
  // W3: 写入环形缓冲（每任务最多 100 条, 供断线重连补发）
  const buf = eventBuffer.get(ev.taskId) || [];
  buf.push(full);
  if (buf.length > BUFFER_MAX) buf.splice(0, buf.length - BUFFER_MAX);
  eventBuffer.set(ev.taskId, buf);
  const set = subscribers.get(ev.taskId);
  if (!set) return;
  for (const cb of set) {
    try { cb(full); } catch { /* 订阅者异常忽略 */ }
  }
}

/** W3: 获取某任务的缓冲事件（断线重连时按 Last-Event-ID 补发） */
export function bufferedEventsSince(taskId: string, lastSeq?: number): AgentProgressEvent[] {
  const buf = eventBuffer.get(taskId) || [];
  if (!lastSeq) return buf;
  return buf.filter((e) => (e.seq || 0) > lastSeq);
}

/** W3: 清理任务缓冲（任务终态后可调） */
export function clearEventBuffer(taskId: string): void {
  eventBuffer.delete(taskId);
}

/** 当前订阅者数（运维/测试用） */
export function agentProgressSubscriberCount(taskId?: string): number {
  if (taskId) return subscribers.get(taskId)?.size ?? 0;
  let n = 0;
  for (const s of subscribers.values()) n += s.size;
  return n;
}

export const agentProgressService = {
  subscribeAgentProgress,
  publishAgentProgress,
  agentProgressSubscriberCount,
  // W3: 断线续传
  bufferedEventsSince,
  clearEventBuffer,
};


// ═══════ 多副本: 事件落库(观察者与执行者解耦) ═══════
/** 事件写入(尽力而为: 失败不影响实时推送, 只让跨实例回放少一条) */
async function persistEvent(ev: AgentProgressEvent): Promise<void> {
  try {
    const { pool } = await import("../db/pool.js");
    await pool.query(
      `insert into agent_task_events (task_id, seq, event, payload)
       values ($1::uuid, $2, $3, $4::jsonb) on conflict (task_id, seq) do nothing`,
      [ev.taskId, ev.seq ?? 0, ev.type, JSON.stringify({ data: ev.data, timestamp: ev.timestamp, source: ev.source, tool: ev.tool })]
    );
  } catch { /* 事件表不可用时退化成纯内存(单机照常) */ }
}

/** 从库里回放 seq > after 的事件(跨实例/进程重启后仍能看到历史) */
export async function replayAgentEvents(taskId: string, after = 0, limit = 500): Promise<AgentProgressEvent[]> {
  try {
    const { pool } = await import("../db/pool.js");
    const r = await pool.query(
      `select seq, event, payload, created_at from agent_task_events
        where task_id = $1::uuid and seq > $2 order by seq asc limit $3`,
      [taskId, after, limit]
    );
    return r.rows.map((row: Record<string, unknown>) => {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      return {
        type: String(row.event) as AgentProgressEvent["type"],
        taskId,
        seq: Number(row.seq),
        timestamp: Number(p.timestamp ?? 0) || new Date(String(row.created_at)).getTime(),
        data: (p.data ?? {}) as Record<string, unknown>,
        ...(p.source ? { source: String(p.source) } : {}),
        ...(p.tool ? { tool: String(p.tool) } : {}),
      };
    });
  } catch { return []; }
}

/** 清理过期事件(默认保留 3 天), 由启动巡检调用 */
export async function pruneAgentEvents(days = 3): Promise<number> {
  try {
    const { pool } = await import("../db/pool.js");
    const r = await pool.query(
      `delete from agent_task_events where created_at < now() - ($1::int || ' days')::interval`,
      [days]
    );
    return r.rowCount ?? 0;
  } catch { return 0; }
}
