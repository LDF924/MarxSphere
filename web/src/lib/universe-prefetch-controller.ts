// universe-prefetch-controller.ts — 时间线预取计划与请求状态(对齐 Zleap universe-prefetch-controller.ts)
// 语义: 每侧目标 3 页,优先补首选方向的赤字,回落唯一剩余边缘;
// 同一时刻至多一个在途页面;作用域重置使迟到完成失效。
// 来源: Zleap-AI/SAG apps/web/lib/universe-prefetch-controller.ts(完整移植)。
import type { UniverseTimelineDirection } from "./universe-types";

export interface UniversePrefetchRunway {
  newerEvents: number;
  olderEvents: number;
  pageSize: number;
  pagesPerSide: number;
  hasNewer: boolean;
  hasOlder: boolean;
  preferredDirection: UniverseTimelineDirection;
  inFlight: boolean;
}

export interface UniversePrefetchPlan {
  direction: UniverseTimelineDirection | null;
  targetEventsPerSide: number;
  newerDeficit: number;
  olderDeficit: number;
  reason:
    | "request-newer"
    | "request-older"
    | "in-flight"
    | "ready"
    | "exhausted";
}

function nonNegativeInteger(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function positiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/**
 * Selects at most one adjacent page. Re-running after each response naturally
 * walks from the nearest cursor outward because a farther cursor does not
 * exist until the nearer page has been admitted.
 */
export function planUniversePrefetch(
  input: UniversePrefetchRunway,
): UniversePrefetchPlan {
  const pageSize = positiveInteger(input.pageSize, 20);
  const pagesPerSide = Math.min(
    3,
    nonNegativeInteger(input.pagesPerSide, 3),
  );
  const targetEventsPerSide = pageSize * pagesPerSide;
  const newerDeficit = input.hasNewer
    ? Math.max(
        0,
        targetEventsPerSide - nonNegativeInteger(input.newerEvents, 0),
      )
    : 0;
  const olderDeficit = input.hasOlder
    ? Math.max(
        0,
        targetEventsPerSide - nonNegativeInteger(input.olderEvents, 0),
      )
    : 0;
  const base = { targetEventsPerSide, newerDeficit, olderDeficit };

  if (input.inFlight) {
    return { ...base, direction: null, reason: "in-flight" };
  }
  if (!input.hasNewer && !input.hasOlder) {
    return { ...base, direction: null, reason: "exhausted" };
  }
  if (newerDeficit === 0 && olderDeficit === 0) {
    return { ...base, direction: null, reason: "ready" };
  }

  const preferredDeficit = input.preferredDirection === "newer"
    ? newerDeficit
    : olderDeficit;
  if (preferredDeficit > 0) {
    return {
      ...base,
      direction: input.preferredDirection,
      reason: input.preferredDirection === "newer"
        ? "request-newer"
        : "request-older",
    };
  }
  const direction = newerDeficit > 0 ? "newer" : "older";
  return {
    ...base,
    direction,
    reason: direction === "newer" ? "request-newer" : "request-older",
  };
}

export interface UniversePrefetchRequestState {
  generation: number;
  inFlight: {
    direction: UniverseTimelineDirection;
    cursor: string;
  } | null;
}

export function createUniversePrefetchRequestState(
  generation = 0,
): UniversePrefetchRequestState {
  return { generation, inFlight: null };
}

export function beginUniversePrefetchRequest(
  state: UniversePrefetchRequestState,
  direction: UniverseTimelineDirection,
  cursor: string | null,
) {
  if (state.inFlight || !cursor) return null;
  return {
    ...state,
    inFlight: { direction, cursor },
  };
}

export function finishUniversePrefetchRequest(
  state: UniversePrefetchRequestState,
  generation: number,
) {
  if (generation !== state.generation) return state;
  return { ...state, inFlight: null };
}

export function resetUniversePrefetchRequests(
  state: UniversePrefetchRequestState,
) {
  return {
    generation: state.generation + 1,
    inFlight: null,
  };
}
