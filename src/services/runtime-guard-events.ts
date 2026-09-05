// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/runtime-guard-events.ts — V404-29: 运行时防护事件计数(前端"防护状态页"数据源)
// 集中记录各防护的命中/拦截事件(内存态 + 最近 N 条明细), 供 API/面板展示:
//   H1 空转告警 / H2 复读检出 / H7 注入拦截 / M2 规则摘要 / 子进程整树终止
// 进程重启清零(运行时状态性质); 不落库避免噪音
export interface GuardEvent {
  guard: string;          // h1_progress / h2_repetition / h7_injection / m2_summary / h3_killtree
  action: "warn" | "block" | "summary" | "kill";
  detail: string;         // 事件说明(截断)
  ts: number;
}

import { subprocessStatus } from "./agent-runtime-utils.js";

const MAX_EVENTS = 100;
const events: GuardEvent[] = [];
const counters = new Map<string, number>();

export function recordGuardEvent(guard: string, action: GuardEvent["action"], detail: string): void {
  events.push({ guard, action, detail: String(detail).slice(0, 160), ts: Date.now() });
  if (events.length > MAX_EVENTS) events.shift();
  counters.set(guard, (counters.get(guard) || 0) + 1);
  // V404-30: 异步落库(跨重启审计; 失败静默不阻塞防护)
  void persistGuardEvent(guard, action, detail);
}

let persistChain: Promise<void> = Promise.resolve();
function persistGuardEvent(guard: string, action: string, detail: string): Promise<void> {
  persistChain = persistChain.then(async () => {
    try {
      const { pool } = await import("../db/pool.js");
      const total = (await pool.query("select count(*)::int as n from runtime_guard_events")).rows[0].n;
      if (total >= 5000) {
        // 保留 30 天 + 总量上限双清理
        await pool.query("delete from runtime_guard_events where created_at < now() - interval '30 days'");
      }
      await pool.query(
        "insert into runtime_guard_events (guard, action, detail) values ($1, $2, $3)",
        [guard, action, String(detail).slice(0, 300)]
      );
    } catch { /* 落库失败静默(防护不阻塞) */ }
  }).catch(() => {});
  return persistChain;
}

/** 查询持久化事件(审计; 按时间倒序) */
export async function listPersistedGuardEvents(guard?: string, limit = 50): Promise<Array<{ guard: string; action: string; detail: string; createdAt: string }>> {
  try {
    const { pool } = await import("../db/pool.js");
    const r = guard
      ? await pool.query("select guard, action, detail, created_at from runtime_guard_events where guard = $1 order by id desc limit $2", [guard, limit])
      : await pool.query("select guard, action, detail, created_at from runtime_guard_events order by id desc limit $1", [limit]);
    return r.rows.map((x: any) => ({ guard: x.guard, action: x.action, detail: x.detail, createdAt: new Date(x.created_at).toISOString() }));
  } catch { return []; }
}

/** 持久化统计(审计; 按防护聚合) */
export async function persistedGuardCounts(days = 7): Promise<Array<{ guard: string; count: number }>> {
  try {
    const { pool } = await import("../db/pool.js");
    const r = await pool.query(
      `select guard, count(*)::int as count from runtime_guard_events
       where created_at > now() - ($1::int || ' days')::interval group by guard order by count desc`, [days]);
    return r.rows.map((x: any) => ({ guard: x.guard, count: Number(x.count) }));
  } catch { return []; }
}

export function guardEventCounts(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function recentGuardEvents(limit = 20): GuardEvent[] {
  return events.slice(-limit).reverse();
}

export interface GuardStatus {
  guards: Array<{
    id: string;
    label: string;
    desc: string;
    enabled: boolean;
    hits: number;
    lastHitAt?: number;
  }>;
  recent: GuardEvent[];
  subprocesses: Array<{ id: string; label: string; runningMs: number; alive: boolean }>;
}

/** 聚合状态(前端防护页): 各防护开关/命中 + 最近事件 + 子进程树 */
export function guardStatusSnapshot(): GuardStatus {
  const counts = guardEventCounts();
  const now = Date.now();
  const last = (guard: string): number | undefined => {
    const hit = [...events].reverse().find((e) => e.guard === guard);
    return hit?.ts;
  };
  const guardDefs = [
    { id: "h1_progress", label: "进度哨兵", desc: "连续只读检索无产出/重复工具错误 → 告警(observe-first)", enabled: true },
    { id: "h2_repetition", label: "复读检测", desc: "流式输出周期相似度 ≥0.985 且重复 ≥8 → 判复读", enabled: true },
    { id: "h7_injection", label: "注入闸", desc: "执行类工具参数含伪工具调用/破坏指令 → 拒绝", enabled: true },
    { id: "m2_summary", label: "规则摘要", desc: "长列表输出 → 计数+head/tail 紧凑视图(细节走取回)", enabled: true },
    { id: "h3_killtree", label: "整树终止", desc: "子进程超时/关闭 → taskkill /T 整树清理(防孤儿)", enabled: true },
    { id: "h4_decode", label: "代码页解码", desc: "子进程输出 UTF-8 误读 → CP936 等回退", enabled: true },
  ];
  return {
    guards: guardDefs.map((g) => ({ ...g, hits: counts[g.id] || 0, lastHitAt: last(g.id) })),
    recent: recentGuardEvents(),
    subprocesses: subprocessStatus(),
  };
}

export const runtimeGuardEvents = { recordGuardEvent, guardEventCounts, recentGuardEvents, guardStatusSnapshot, listPersistedGuardEvents, persistedGuardCounts };
