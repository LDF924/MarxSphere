// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// event-bus.ts — 事件驱动架构（BOOK-GAP-ROADMAP P2-2, V381 2026-08-09）
// 请求-响应式之外的补充：用户消息/定时任务/内部信号统一建模为结构化事件
// 四维: source(来源) / channel(渠道) / content(内容) / context(上下文)
// 三策略: 取消式(紧急中断, 最新事件覆盖) / 队列式(常规批处理 FIFO) / 并行式(独立轻量, 互不阻塞)
// 设计原则: 不替代 jobs-service 轮询（保留），为"需要事件语义"的场景提供统一入口；
//           与 jobs-service 通过 adapter 复用现有 handler（sleep_learn/dream_cycle 等）

export type EventSource =
  | "user"          // 用户消息/操作
  | "scheduler"     // 定时触发（schtasks/内部定时器）
  | "system"        // 内部信号（评测完成/入库完成/告警）
  | "external";     // 外部服务（GitHub 更新检测/上游技能）

export type EventChannel = "memory" | "eval" | "ingest" | "search" | "reason" | "skill" | "alert" | "admin";

export type EventStrategy = "cancel" | "queue" | "parallel";

export interface SagEvent {
  id: string;
  source: EventSource;
  channel: EventChannel;
  /** 内容（可 JSON 化负载：消息文本/任务参数/触发条件） */
  content: unknown;
  /** 上下文（会话/任务/项目关联信息） */
  context?: Record<string, unknown>;
  strategy: EventStrategy;
  priority?: number;      // 0-10, 默认 5
  createdAt: number;
  /** 取消式策略: 同 key 事件是否覆盖（key 如 "daily-eval"） */
  cancelKey?: string;
}

export type EventHandler = (ev: SagEvent) => Promise<void>;

interface QueueEntry { ev: SagEvent; handler: EventHandler }

interface CancelSlot { ev: SagEvent; handler: EventHandler; timer: NodeJS.Timeout }
const handlers = new Map<string, EventHandler>();      // key: `${channel}:${name}`
const cancelSlots = new Map<string, CancelSlot>();
const queue: QueueEntry[] = [];
const queueRunning = new Set<string>();                 // 防同事件重复入队
let queueActive = false;
let eventSeq = 0;

/** 注册事件处理器（channel 内按 name 区分） */
export function onEvent(channel: EventChannel, name: string, handler: EventHandler): void {
  handlers.set(`${channel}:${name}`, handler);
}

/** 是否有该事件处理器 */
export function hasEventHandler(channel: EventChannel, name: string): boolean {
  return handlers.has(`${channel}:${name}`);
}

function buildEvent(input: {
  source: EventSource; channel: EventChannel; content: unknown;
  context?: Record<string, unknown>; strategy?: EventStrategy; priority?: number; cancelKey?: string;
}): SagEvent {
  eventSeq += 1;
  return {
    id: `evt-${Date.now().toString(36)}-${eventSeq}`,
    source: input.source,
    channel: input.channel,
    content: input.content,
    context: input.context,
    strategy: input.strategy ?? "queue",
    priority: input.priority ?? 5,
    createdAt: Date.now(),
    cancelKey: input.cancelKey,
  };
}

/** 触发事件（按策略分发） */
export async function emit(input: Parameters<typeof buildEvent>[0]): Promise<boolean> {
  const ev = buildEvent(input);
  const handler = handlers.get(`${ev.channel}:${String((ev.content as any)?.name ?? "default")}`);
  if (!handler) {
    // 无专用处理器 → 尝试 channel 默认处理器
    const def = handlers.get(`${ev.channel}:default`);
    if (!def) return false;
    return dispatch(ev, def);
  }
  return dispatch(ev, handler);
}

async function dispatch(ev: SagEvent, handler: EventHandler): Promise<boolean> {
  switch (ev.strategy) {
    case "cancel": {
      // 取消式: 同 cancelKey 的新事件覆盖旧事件（紧急中断场景）
      if (!ev.cancelKey) break;
      const dupKey = `${ev.channel}:${ev.cancelKey}`;
      const prev = cancelSlots.get(ev.cancelKey);
      // V4xx: 覆盖旧槽位时, 将同 key 正在运行的 handler 并入"已运行"集合防重入 —
      //       旧事件若已开跑（定时器触发后未结束）, 新事件覆盖槽位后不得再排一个同样的执行
      if (prev && queueRunning.has(dupKey)) {
        return false;
      }
      if (prev) { clearTimeout(prev.timer); }
      const timer = setTimeout(() => {
        // V4xx: 并入"已运行"集合 — handler 真正开跑时才标记, 运行期间同 key 再 emit 被防重入拦截
        //       （pending 未开跑的事件仍可被新事件覆盖, 保持"最新覆盖"语义）
        queueRunning.add(dupKey);
        void Promise.resolve().then(() => handler(ev))
          .catch((e) => console.error(`[event-bus] cancel handler 失败 ${ev.channel}:${ev.id}:`, e?.message?.substring(0, 80)))
          .finally(() => {
            queueRunning.delete(dupKey);
            cancelSlots.delete(ev.cancelKey!);
          });
      }, 0);
      cancelSlots.set(ev.cancelKey, { ev, handler, timer });
      return true;
    }
    case "parallel": {
      // 并行式: 独立轻量会话，不阻塞（fire-and-forget + 错误隔离）
      void handler(ev).catch((e) => console.error(`[event-bus] parallel handler 失败 ${ev.channel}:${ev.id}:`, e?.message?.substring(0, 80)));
      return true;
    }
    case "queue":
    default: {
      // 队列式: FIFO 串行（常规批处理，避免并发写冲突）
      const dupKey = `${ev.channel}:${String((ev.content as any)?.name ?? ev.id)}`;
      if (queueRunning.has(dupKey)) return false;  // 同事件已在队列/执行中
      queueRunning.add(dupKey);
      queue.push({ ev, handler });
      void drainQueue();
      return true;
    }
  }
  return false;
}

/** 队列消化（串行执行） */
async function drainQueue(): Promise<void> {
  if (queueActive) return;
  queueActive = true;
  try {
    while (queue.length > 0) {
      const entry = queue.shift()!;
      try { await entry.handler(entry.ev); }
      catch (e) { console.error(`[event-bus] queue handler 失败 ${entry.ev.channel}:${entry.ev.id}:`, (e as Error)?.message?.substring(0, 80)); }
      finally { queueRunning.delete(`${entry.ev.channel}:${String((entry.ev.content as any)?.name ?? entry.ev.id)}`); }
    }
  } finally { queueActive = false; }
}

/** 队列待处理数（监控用） */
export function pendingEvents(): number { return queue.length + cancelSlots.size; }

/** 取消式槽位清理（定时器已自动清理；测试/维护用） */
export function clearCancelSlots(): void {
  for (const [, v] of cancelSlots) clearTimeout(v.timer);
  cancelSlots.clear();
}

export const eventBus = { onEvent, emit, hasEventHandler, pendingEvents, clearCancelSlots };
