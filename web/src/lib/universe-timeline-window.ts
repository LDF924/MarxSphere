// universe-timeline-window.ts — 虚拟时间窗:缓存分页/可见窗/投影预算(对齐 Zleap universe-timeline-window.ts)
// 语义: 服务器按降序时间返回 bundle 页;cacheBundleIds 保持查询序,activeIndex 聚焦,
// 可见窗是 active 结尾的 slice;前进步进移动 active,投影把驻留工作集压到渲染预算内。
// 来源: Zleap-AI/SAG apps/web/lib/universe-timeline-window.ts(完整移植)。
import {
  universeNodeKey,
  universeRelationKey,
  type UniverseWorkingBundle,
  type UniverseWorkingSet,
} from "./universe-working-set";

export type UniverseTimelineWindowDirection = "next" | "previous";
export type UniverseTimelineEvictionBoundary =
  | "visible-window"
  | "active-bundle";

export type UniverseTimelineWindowPhase =
  | "idle"
  | "loading"
  | "transitioning"
  | "complete";

export interface UniverseTimelineWindowState {
  /**
   * Bundle ids retained in server query/FIFO order: the first page contains
   * the latest events and continuation pages move toward earlier events.
   * This order is not chronological ascending order.
   */
  cacheBundleIds: string[];
  /** Focused bundle inside `cacheBundleIds`; -1 means that the cache is empty. */
  activeIndex: number;
  /** Bundle ids currently eligible for scene projection. */
  visibleBundleIds: string[];
  /** Monotonic count of timeline bundles that have reached the visible window. */
  visitedCount: number;
  /** Monotonic high-water count of events acknowledged from the timeline API. */
  queriedCount: number;
  /** The server cursor has reported that no further continuation page exists. */
  networkExhausted: boolean;
  phase: UniverseTimelineWindowPhase;
  revision: number;
  visibleLimit: number;
  cacheLimit: number;
  /** Number of cached-prefix bundles discarded during this session. */
  cacheStartOffset: number;
  /** Absolute queried offset of the first non-empty window's active bundle. */
  rewindStartOffset: number;
}

/** Earliest focus that can still fill the configured window without padding. */
export function universeTimelineStartActiveIndex(
  cacheLength: number,
  visibleLimit: number,
) {
  const length = Math.max(0, Math.floor(cacheLength));
  if (length === 0) return -1;
  return Math.min(length - 1, positiveInteger(visibleLimit, 1) - 1);
}

/**
 * Earliest active index reachable inside the current resident cache. The
 * absolute boundary is captured by the first non-empty page, so later prefetch
 * growth cannot silently move the rewind floor. FIFO prefix eviction merely
 * translates that boundary into the cache's new relative coordinate space.
 */
export function universeTimelineRewindStartActiveIndex(
  state: Pick<
    UniverseTimelineWindowState,
    "cacheBundleIds" | "cacheStartOffset" | "rewindStartOffset"
  >,
) {
  if (state.cacheBundleIds.length === 0) return -1;
  return Math.min(
    state.cacheBundleIds.length - 1,
    Math.max(0, state.rewindStartOffset - state.cacheStartOffset),
  );
}

function positiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function normalizedBundleIds(ids: Iterable<string>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of ids) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * The active bundle is the furthest-advanced item in the visible query-order
 * slice. It stays at the visual centre while previously visited packages fan
 * out behind it. A forward step shifts exactly one bundle through the virtual
 * window, toward an earlier event in the server's descending-time traversal.
 */
export function effectiveUniverseTimelineVisibleBundleIds(
  cacheBundleIds: readonly string[],
  activeIndex: number,
  visibleLimit: number,
) {
  if (cacheBundleIds.length === 0 || activeIndex < 0) return [];
  const boundedActive = Math.min(
    cacheBundleIds.length - 1,
    Math.max(0, Math.floor(activeIndex)),
  );
  const limit = positiveInteger(visibleLimit, 1);
  return cacheBundleIds.slice(
    Math.max(0, boundedActive - limit + 1),
    boundedActive + 1,
  );
}

export function isUniverseTimelineWindowComplete(
  state: UniverseTimelineWindowState,
) {
  return state.networkExhausted
    && (
      state.cacheBundleIds.length === 0
      || state.activeIndex === state.cacheBundleIds.length - 1
    );
}

/**
 * Counts acknowledged events without retaining an unbounded identity ledger.
 * The high-water survives bidirectional cache reloads and edge retirement.
 */
export function queriedUniverseTimelineEventCount(
  state: UniverseTimelineWindowState,
) {
  return state.queriedCount;
}

function universeTimelineSafePrefixLength(
  state: UniverseTimelineWindowState,
  boundary: UniverseTimelineEvictionBoundary,
) {
  if (state.cacheBundleIds.length === 0 || state.activeIndex < 0) return 0;
  const boundedActiveIndex = Math.min(
    state.cacheBundleIds.length - 1,
    Math.max(0, Math.floor(state.activeIndex)),
  );
  return boundary === "active-bundle"
    ? boundedActiveIndex
    : Math.max(0, boundedActiveIndex - state.visibleLimit + 1);
}

/**
 * Bundle ids that admission must not evict. Normal admission starts at the
 * visible-window boundary; explicit capacity recovery starts at the active
 * bundle. Every queried bundle ahead of the selected boundary stays protected.
 */
export function protectedUniverseTimelineBundleIds(
  state: UniverseTimelineWindowState,
  boundary: UniverseTimelineEvictionBoundary = "visible-window",
) {
  if (state.cacheBundleIds.length === 0 || state.activeIndex < 0) return [];
  return state.cacheBundleIds.slice(
    universeTimelineSafePrefixLength(state, boundary),
  );
}

function resolvedPhase(
  state: Pick<
    UniverseTimelineWindowState,
    "cacheBundleIds" | "activeIndex" | "networkExhausted"
  >,
  fallback: UniverseTimelineWindowPhase,
): UniverseTimelineWindowPhase {
  if (state.networkExhausted && (
    state.cacheBundleIds.length === 0
    || state.activeIndex === state.cacheBundleIds.length - 1
  )) return "complete";
  if (state.cacheBundleIds.length === 0) return "idle";
  return fallback;
}

/**
 * Synchronizes physical admission evictions back into the virtual cache.
 * Timeline bundles may only be removed as one contiguous prefix strictly
 * before the selected protection boundary. Support-bundle ids are ignored.
 * `null` rejects an unsafe or non-prefix plan before either working set or
 * cursor is committed.
 */
export function applyUniverseTimelineBundleEvictions(
  state: UniverseTimelineWindowState,
  evictedBundleIds: Iterable<string>,
  boundary: UniverseTimelineEvictionBoundary = "visible-window",
): UniverseTimelineWindowState | null {
  const evicted = new Set(normalizedBundleIds(evictedBundleIds));
  if (evicted.size === 0 || state.cacheBundleIds.length === 0) return state;
  const evictedTimelineIds = state.cacheBundleIds.filter((id) => evicted.has(id));
  if (evictedTimelineIds.length === 0) return state;
  const safePrefixLength = universeTimelineSafePrefixLength(state, boundary);
  if (evictedTimelineIds.length > safePrefixLength) return null;
  const expectedPrefix = state.cacheBundleIds.slice(0, evictedTimelineIds.length);
  if (expectedPrefix.some((id, index) => id !== evictedTimelineIds[index])) {
    return null;
  }

  const removedPrefix = evictedTimelineIds.length;
  const cacheBundleIds = state.cacheBundleIds.slice(removedPrefix);
  const activeIndex = state.activeIndex - removedPrefix;
  const visibleBundleIds = effectiveUniverseTimelineVisibleBundleIds(
    cacheBundleIds,
    activeIndex,
    state.visibleLimit,
  );
  const candidate = {
    ...state,
    cacheBundleIds,
    activeIndex,
    visibleBundleIds,
    revision: state.revision + 1,
    cacheStartOffset: state.cacheStartOffset + removedPrefix,
  };
  return {
    ...candidate,
    phase: resolvedPhase(candidate, state.phase),
  };
}

/**
 * Conservative page size for bundle-atomic admission. Capacity recovery is
 * intentionally single-bundle so a partial page can advance exactly one
 * cursor without a later bundle evicting an earlier acknowledgement.
 */
export function universeTimelinePageBundleLimit(
  policyPageLimit: number,
  entityLimit: number,
  budget: { nodes: number; edges: number },
  capacityRecovery = false,
) {
  if (capacityRecovery) return 1;
  const policy = positiveInteger(policyPageLimit, 1);
  const entities = positiveInteger(entityLimit, 1);
  const nodes = Number.isFinite(budget.nodes)
    ? Math.max(0, Math.floor(budget.nodes))
    : 0;
  const edges = Number.isFinite(budget.edges)
    ? Math.max(0, Math.floor(budget.edges))
    : 0;
  const nodeBound = Math.max(1, Math.floor(nodes / (entities + 1)));
  const edgeBound = Math.max(1, Math.floor(edges / entities));
  return Math.max(1, Math.min(policy, nodeBound, edgeBound));
}

export function createUniverseTimelineWindow(
  visibleLimit: number,
  cacheLimit: number,
): UniverseTimelineWindowState {
  const normalizedVisibleLimit = positiveInteger(visibleLimit, 1);
  return {
    cacheBundleIds: [],
    activeIndex: -1,
    visibleBundleIds: [],
    visitedCount: 0,
    queriedCount: 0,
    networkExhausted: false,
    phase: "idle",
    revision: 0,
    visibleLimit: normalizedVisibleLimit,
    cacheLimit: Math.max(
      normalizedVisibleLimit,
      positiveInteger(cacheLimit, normalizedVisibleLimit),
    ),
    cacheStartOffset: 0,
    rewindStartOffset: -1,
  };
}

/**
 * Applies new window limits without changing the focused event package.
 * Shrinking consumes only history before the newly visible slice; if that is
 * insufficient, the effective cache limit stays temporarily above the request
 * until later forward steps make more history safely evictable.
 */
export function reconfigureUniverseTimelineWindow(
  state: UniverseTimelineWindowState,
  visibleLimit: number,
  cacheLimit: number,
): UniverseTimelineWindowState {
  const nextVisibleLimit = positiveInteger(visibleLimit, 1);
  const requestedCacheLimit = Math.max(
    nextVisibleLimit,
    positiveInteger(cacheLimit, nextVisibleLimit),
  );
  const boundedActiveIndex = state.cacheBundleIds.length === 0
    ? -1
    : Math.min(
        state.cacheBundleIds.length - 1,
        Math.max(0, state.activeIndex),
      );
  const safeHistoryCount = boundedActiveIndex < 0
    ? 0
    : Math.max(0, boundedActiveIndex - nextVisibleLimit + 1);
  const requestedOverflow = Math.max(
    0,
    state.cacheBundleIds.length - requestedCacheLimit,
  );
  const removedPrefix = Math.min(requestedOverflow, safeHistoryCount);
  const cacheBundleIds = removedPrefix > 0
    ? state.cacheBundleIds.slice(removedPrefix)
    : state.cacheBundleIds;
  const activeIndex = boundedActiveIndex < 0
    ? -1
    : boundedActiveIndex - removedPrefix;
  const effectiveCacheLimit = Math.max(
    requestedCacheLimit,
    cacheBundleIds.length,
  );
  const visibleBundleIds = effectiveUniverseTimelineVisibleBundleIds(
    cacheBundleIds,
    activeIndex,
    nextVisibleLimit,
  );
  const phase = state.networkExhausted && (
    cacheBundleIds.length === 0
    || activeIndex === cacheBundleIds.length - 1
  )
    ? "complete"
    : state.phase === "loading" ? "loading" : "idle";
  const unchanged = state.visibleLimit === nextVisibleLimit
    && state.cacheLimit === effectiveCacheLimit
    && state.activeIndex === activeIndex
    && state.cacheBundleIds.length === cacheBundleIds.length
    && state.cacheBundleIds.every((id, index) => id === cacheBundleIds[index])
    && state.visibleBundleIds.length === visibleBundleIds.length
    && state.visibleBundleIds.every((id, index) => id === visibleBundleIds[index])
    && state.phase === phase;
  if (unchanged) return state;
  return {
    ...state,
    cacheBundleIds,
    activeIndex,
    visibleBundleIds,
    phase,
    revision: state.revision + 1,
    visibleLimit: nextVisibleLimit,
    cacheLimit: effectiveCacheLimit,
    cacheStartOffset: state.cacheStartOffset + removedPrefix,
  };
}

/** Number of already-queried future bundles kept ready for continuous travel. */
export function universeTimelinePrefetchAheadTarget(
  state: Pick<UniverseTimelineWindowState, "visibleLimit" | "cacheLimit">,
  nextPageSize: number,
  cacheCapacity = state.cacheLimit,
) {
  const pageSize = positiveInteger(nextPageSize, 1);
  const capacity = Math.max(
    state.visibleLimit,
    positiveInteger(cacheCapacity, state.cacheLimit),
  );
  return Math.min(capacity, Math.max(state.visibleLimit, pageSize * 2));
}

/**
 * Pure ahead-water decision. Cache capacity bounds retained history; it is
 * intentionally not an eager-fill target. Request/session gates such as EOF,
 * loading, locks and capacity pauses remain the caller's responsibility.
 */
export function shouldPrefetchUniverseTimelineWindow(
  state: UniverseTimelineWindowState,
  nextPageSize: number,
  cacheCapacity = state.cacheLimit,
) {
  if (state.cacheBundleIds.length === 0 || state.activeIndex < 0) return false;
  const pageSize = positiveInteger(nextPageSize, 1);
  const capacity = Math.max(
    state.visibleLimit,
    positiveInteger(cacheCapacity, state.cacheLimit),
  );
  const aheadTarget = universeTimelinePrefetchAheadTarget(
    state,
    pageSize,
    capacity,
  );
  const cachedAhead = state.cacheBundleIds.length - state.activeIndex - 1;
  const projectedOverflow = Math.max(
    0,
    state.cacheBundleIds.length + pageSize - capacity,
  );
  const safelyEvictableHistory = Math.max(
    0,
    state.activeIndex - state.visibleLimit + 1,
  );
  return projectedOverflow <= safelyEvictableHistory
    && cachedAhead < aheadTarget;
}

function trimTimelineCache(
  ids: string[],
  activeIndex: number,
  visibleLimit: number,
  cacheLimit: number,
) {
  let cacheBundleIds = ids;
  let nextActiveIndex = activeIndex;
  let removedPrefix = 0;
  const overflow = Math.max(0, cacheBundleIds.length - cacheLimit);

  // Prefer evicting history strictly before the current visible window. It is
  // safe to revisit anything still visible, and forward-prefetched bundles stay
  // available for the next gesture.
  const visibleStart = Math.max(0, nextActiveIndex - visibleLimit + 1);
  const prefixCount = Math.min(overflow, visibleStart);
  if (prefixCount > 0) {
    cacheBundleIds = cacheBundleIds.slice(prefixCount);
    nextActiveIndex -= prefixCount;
    removedPrefix = prefixCount;
  }

  // If a caller admits more than can be safely evicted, temporarily lift the
  // effective limit. Dropping a queried-but-unseen suffix would permanently
  // skip those events because the server cursor has already advanced.
  return {
    cacheBundleIds,
    activeIndex: nextActiveIndex,
    removedPrefix,
    effectiveCacheLimit: Math.max(cacheLimit, cacheBundleIds.length),
  };
}

export function appendUniverseTimelineBundles(
  state: UniverseTimelineWindowState,
  ids: Iterable<string>,
): UniverseTimelineWindowState {
  const resident = new Set(state.cacheBundleIds);
  const appended = normalizedBundleIds(ids).filter((id) => !resident.has(id));
  if (appended.length === 0) return state;

  const wasEmpty = state.cacheBundleIds.length === 0;
  const combined = [...state.cacheBundleIds, ...appended];
  const initialActiveIndex = wasEmpty
    ? universeTimelineStartActiveIndex(combined.length, state.visibleLimit)
    : state.activeIndex;
  const rewindStartOffset = wasEmpty
    ? state.cacheStartOffset + initialActiveIndex
    : state.rewindStartOffset;
  const trimmed = trimTimelineCache(
    combined,
    initialActiveIndex,
    state.visibleLimit,
    state.cacheLimit,
  );
  const visibleBundleIds = effectiveUniverseTimelineVisibleBundleIds(
    trimmed.cacheBundleIds,
    trimmed.activeIndex,
    state.visibleLimit,
  );
  const cacheStartOffset = state.cacheStartOffset + trimmed.removedPrefix;

  return {
    ...state,
    cacheBundleIds: trimmed.cacheBundleIds,
    activeIndex: trimmed.activeIndex,
    visibleBundleIds,
    visitedCount: Math.max(
      state.visitedCount,
      cacheStartOffset + trimmed.activeIndex + 1,
    ),
    queriedCount: Math.max(
      state.queriedCount,
      cacheStartOffset + trimmed.cacheBundleIds.length,
    ),
    networkExhausted: false,
    phase: resolvedPhase({
      cacheBundleIds: trimmed.cacheBundleIds,
      activeIndex: trimmed.activeIndex,
      networkExhausted: false,
    }, "idle"),
    revision: state.revision + 1,
    cacheLimit: trimmed.effectiveCacheLimit,
    cacheStartOffset,
    rewindStartOffset,
  };
}

/**
 * Atomically advances one visual time page through the virtual window.
 *
 * ``stride`` is explicit so interaction code cannot accidentally fall back to
 * single-event travel. It may be smaller than the network page when the user
 * configures a narrower visible window. A short terminal page clamps to the
 * cache boundary; rewind clamps to the session floor. Focus, visibility,
 * visit accounting, phase and revision are committed together exactly once.
 */
export function advanceUniverseTimelineWindow(
  state: UniverseTimelineWindowState,
  direction: UniverseTimelineWindowDirection,
  stride: number,
): UniverseTimelineWindowState {
  if (!Number.isInteger(stride) || stride < 1) {
    throw new Error("timeline window stride must be a positive integer");
  }
  if (state.cacheBundleIds.length === 0 || state.activeIndex < 0) return state;
  const startActiveIndex = universeTimelineRewindStartActiveIndex(state);
  if (direction === "previous" && state.activeIndex <= startActiveIndex) return state;
  const absoluteActiveIndex = state.cacheStartOffset + state.activeIndex;
  const absoluteProgress = Math.max(
    0,
    absoluteActiveIndex - state.rewindStartOffset,
  );
  const terminalRemainder = state.networkExhausted
    && state.activeIndex === state.cacheBundleIds.length - 1
    ? absoluteProgress % stride
    : 0;
  const previousStride = terminalRemainder > 0 ? terminalRemainder : stride;
  const targetIndex = direction === "next"
    ? state.activeIndex + stride
    : state.activeIndex - previousStride;
  const activeIndex = Math.min(
    state.cacheBundleIds.length - 1,
    Math.max(startActiveIndex, targetIndex),
  );
  if (activeIndex === state.activeIndex) return state;
  const visibleBundleIds = effectiveUniverseTimelineVisibleBundleIds(
    state.cacheBundleIds,
    activeIndex,
    state.visibleLimit,
  );
  const candidate = {
    ...state,
    activeIndex,
    visibleBundleIds,
    visitedCount: Math.max(
      state.visitedCount,
      state.cacheStartOffset + activeIndex + 1,
    ),
    phase: "transitioning" as UniverseTimelineWindowPhase,
    revision: state.revision + 1,
  };
  return {
    ...candidate,
    phase: resolvedPhase(candidate, "transitioning"),
  };
}

export function markUniverseTimelineNetworkExhausted(
  state: UniverseTimelineWindowState,
): UniverseTimelineWindowState {
  if (state.networkExhausted) return state;
  const candidate = {
    ...state,
    networkExhausted: true,
    revision: state.revision + 1,
  };
  return {
    ...candidate,
    phase: resolvedPhase(candidate, "idle"),
  };
}

/** Marks a completed scene transition without moving the virtual window. */
export function settleUniverseTimelineWindow(
  state: UniverseTimelineWindowState,
): UniverseTimelineWindowState {
  const phase = resolvedPhase(state, "idle");
  if (phase === state.phase) return state;
  return { ...state, phase, revision: state.revision + 1 };
}

function relationEndpointKeys(
  relation: UniverseWorkingSet["relations"][number],
) {
  return [
    universeNodeKey("event", relation.from_id, relation.source_id),
    universeNodeKey(
      relation.kind === "subevent" ? "event" : "entity",
      relation.to_id,
      relation.source_id,
    ),
  ] as const;
}

function materializeUniverseBundles(
  working: UniverseWorkingSet,
  orderedBundleIds: readonly string[],
  allowedNodeKeys?: ReadonlySet<string>,
  allowedRelationKeys?: ReadonlySet<string>,
): UniverseWorkingSet {
  const selectedIds = normalizedBundleIds(orderedBundleIds)
    .filter((id) => Boolean(working.bundles[id]));
  const nodesByKey = new Map(working.nodes.map((node) => [
    universeNodeKey(node.kind, node.id, node.source_id),
    node,
  ]));
  const relationsByKey = new Map(working.relations.map((relation) => [
    universeRelationKey(relation),
    relation,
  ]));
  const selectedBundles = selectedIds.map((id) => working.bundles[id]);
  const selectedNodeKeys = new Set(
    selectedBundles.flatMap((bundle) => bundle.node_keys)
      .filter((key) =>
        nodesByKey.has(key)
        && (!allowedNodeKeys || allowedNodeKeys.has(key))),
  );
  const candidateRelationKeys = new Set(
    selectedBundles.flatMap((bundle) => bundle.relation_keys)
      .filter((key) => !allowedRelationKeys || allowedRelationKeys.has(key)),
  );
  const validRelationKeys = new Set(
    [...candidateRelationKeys].filter((key) => {
      const relation = relationsByKey.get(key);
      return Boolean(
        relation
        && relationEndpointKeys(relation).every((endpoint) =>
          selectedNodeKeys.has(endpoint)),
      );
    }),
  );

  const nodeOrder: string[] = [];
  const appendNodeKey = (key: string) => {
    if (
      selectedNodeKeys.has(key)
      && nodesByKey.has(key)
      && !nodeOrder.includes(key)
    ) nodeOrder.push(key);
  };
  selectedBundles.forEach((bundle) => bundle.node_keys.forEach(appendNodeKey));
  working.node_order.forEach(appendNodeKey);

  const relationOrder: string[] = [];
  const appendRelationKey = (key: string) => {
    if (
      validRelationKeys.has(key)
      && relationsByKey.has(key)
      && !relationOrder.includes(key)
    ) relationOrder.push(key);
  };
  selectedBundles.forEach((bundle) => bundle.relation_keys.forEach(appendRelationKey));
  working.relations.forEach((relation) => appendRelationKey(universeRelationKey(relation)));

  const bundles = new Map<string, UniverseWorkingBundle>();
  selectedIds.forEach((id) => {
    const bundle = working.bundles[id];
    const normalized = {
      ...bundle,
      node_keys: bundle.node_keys.filter((key) => selectedNodeKeys.has(key)),
      relation_keys: bundle.relation_keys.filter((key) => validRelationKeys.has(key)),
    };
    if (normalized.node_keys.length > 0 || normalized.relation_keys.length > 0) {
      bundles.set(id, normalized);
    }
  });
  const bundleOrder = selectedIds.filter((id) => bundles.has(id));
  const nodeOwners = new Map<string, string[]>();
  const relationOwners = new Map<string, string[]>();
  bundleOrder.forEach((id) => {
    const bundle = bundles.get(id);
    if (!bundle) return;
    bundle.node_keys.forEach((key) => {
      const owners = nodeOwners.get(key) ?? [];
      if (!owners.includes(id)) owners.push(id);
      nodeOwners.set(key, owners);
    });
    bundle.relation_keys.forEach((key) => {
      const owners = relationOwners.get(key) ?? [];
      if (!owners.includes(id)) owners.push(id);
      relationOwners.set(key, owners);
    });
  });
  const rootKeys = new Set(working.root_keys);

  return {
    ...working,
    nodes: nodeOrder
      .map((key) => nodesByKey.get(key))
      .filter((node): node is UniverseWorkingSet["nodes"][number] => Boolean(node)),
    relations: relationOrder
      .map((key) => relationsByKey.get(key))
      .filter((relation): relation is UniverseWorkingSet["relations"][number] =>
        Boolean(relation)),
    root_keys: nodeOrder.filter((key) => rootKeys.has(key)),
    node_order: nodeOrder,
    bundle_order: bundleOrder,
    bundles: Object.fromEntries(bundleOrder.map((id) => [id, bundles.get(id)!])),
    node_owners: Object.fromEntries(nodeOwners),
    relation_owners: Object.fromEntries(relationOwners),
    pinned_keys: working.pinned_keys.filter((key) => nodeOwners.has(key)),
    pinned_relation_keys: working.pinned_relation_keys.filter((key) =>
      relationOwners.has(key)),
  };
}

/**
 * Produces an atomic render projection from the selected event bundles. Shared
 * entities are materialized once and factual relations survive only when both
 * endpoints are present.
 */
export function projectUniverseBundleWindow(
  working: UniverseWorkingSet,
  visibleBundleIds: Iterable<string>,
) {
  return materializeUniverseBundles(
    working,
    normalizedBundleIds(visibleBundleIds),
  );
}

function rankedUniverseSupportBundleIds(
  working: UniverseWorkingSet,
  visibleSet: ReadonlySet<string>,
  supportBundleIds: Iterable<string>,
) {
  const requestedSupport = normalizedBundleIds(supportBundleIds);
  const supportRank = new Map(requestedSupport.map((id, index) => [id, index]));
  const orderRank = new Map(
    working.bundle_order.map((id, index) => [id, index]),
  );
  const pinnedNodeKeys = new Set(working.pinned_keys);
  const pinnedRelationKeys = new Set(working.pinned_relation_keys);
  const pinned = (bundle: UniverseWorkingBundle) => Number(
    bundle.node_keys.some((key) => pinnedNodeKeys.has(key))
    || bundle.relation_keys.some((key) => pinnedRelationKeys.has(key)),
  );
  const ranked = requestedSupport
    .filter((id) => Boolean(working.bundles[id]) && !visibleSet.has(id))
    .sort((left, right) => {
      const leftBundle = working.bundles[left];
      const rightBundle = working.bundles[right];
      return pinned(rightBundle) - pinned(leftBundle)
        || (supportRank.get(left) ?? Number.MAX_SAFE_INTEGER)
          - (supportRank.get(right) ?? Number.MAX_SAFE_INTEGER)
        || (orderRank.get(right) ?? -1) - (orderRank.get(left) ?? -1)
        || right.localeCompare(left);
    });
  const availableNodeKeys = new Set(working.nodes.map((node) =>
    universeNodeKey(node.kind, node.id, node.source_id)));
  const reachableNodeKeys = new Set(
    [...visibleSet].flatMap((id) => working.bundles[id]?.node_keys ?? [])
      .filter((key) => availableNodeKeys.has(key)),
  );
  const pending = [...ranked];
  const dependencyOrdered: string[] = [];
  let advanced = true;
  while (pending.length > 0 && advanced) {
    advanced = false;
    for (let index = 0; index < pending.length;) {
      const id = pending[index];
      const bundle = working.bundles[id];
      const anchorReady = bundle.origin !== "expansion"
        || (Boolean(bundle.anchor_key) && reachableNodeKeys.has(bundle.anchor_key!))
        || (
          Boolean(bundle.lineage_root_key)
          && reachableNodeKeys.has(bundle.lineage_root_key!)
        );
      if (!anchorReady) {
        index += 1;
        continue;
      }
      dependencyOrdered.push(id);
      bundle.node_keys.forEach((key) => {
        if (availableNodeKeys.has(key)) reachableNodeKeys.add(key);
      });
      pending.splice(index, 1);
      advanced = true;
    }
  }
  return dependencyOrdered;
}

/**
 * Converts resident admission bundles into a strict visual event window.
 * Entity-expansion pages may contain several events, so admission stays atomic
 * while projection selects canonical event identities and their closed factual
 * endpoints. An exact pin wins while locked; otherwise the active timeline
 * event keeps the centre slot. The newest continuous support suffix wins the
 * remaining runway before older timeline events fill the edge slots.
 */
function projectUniverseEventWindowWithinBudget(
  working: UniverseWorkingSet,
  visible: readonly string[],
  support: readonly string[],
  nodeLimit: number,
  edgeLimit: number,
  eventLimit: number,
  perEventRelationLimit?: number,
) {
  const nodesByKey = new Map(working.nodes.map((node) => [
    universeNodeKey(node.kind, node.id, node.source_id),
    node,
  ]));
  const eventKeysForBundle = (id: string) =>
    (working.bundles[id]?.node_keys ?? []).filter((key) =>
      nodesByKey.get(key)?.kind === "event");
  const maxEvents = Number.isFinite(eventLimit)
    ? Math.max(0, Math.min(nodeLimit, Math.floor(eventLimit)))
    : 0;
  if (maxEvents === 0) return materializeUniverseBundles(working, []);

  const selectedEventKeys: string[] = [];
  const selectedEventSet = new Set<string>();
  const appendEvent = (key: string) => {
    if (
      selectedEventKeys.length >= maxEvents
      || selectedEventSet.has(key)
      || nodesByKey.get(key)?.kind !== "event"
    ) return;
    selectedEventSet.add(key);
    selectedEventKeys.push(key);
  };
  const supportOrder = new Map(support.map((id, index) => [id, index]));
  const recentSupport = [...support].sort((left, right) =>
    (working.bundles[right]?.admitted_at ?? 0)
      - (working.bundles[left]?.admitted_at ?? 0)
    || (supportOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (supportOrder.get(right) ?? Number.MAX_SAFE_INTEGER));

  const pinnedNodeKeys = new Set(working.pinned_keys);
  const pinnedRelationKeys = new Set(working.pinned_relation_keys);
  const relationsByKey = new Map(working.relations.map((relation) => [
    universeRelationKey(relation),
    relation,
  ]));
  const bundleIsPinned = (id: string) => {
    const bundle = working.bundles[id];
    return Boolean(bundle && (
      bundle.node_keys.some((key) => pinnedNodeKeys.has(key))
      || bundle.relation_keys.some((key) => pinnedRelationKeys.has(key))
    ));
  };
  const visibleAnchorKeys = new Set(
    visible.flatMap((id) => working.bundles[id]?.node_keys ?? [])
      .filter((key) => nodesByKey.has(key)),
  );
  const supportSet = new Set(support);
  const supportParentById = new Map<string, string>();
  const latestSupportOwnerByNode = new Map<string, string>();
  working.bundle_order.forEach((id) => {
    if (!supportSet.has(id)) return;
    const current = working.bundles[id];
    const anchorKey = current?.anchor_key;
    const parentId = anchorKey && !visibleAnchorKeys.has(anchorKey)
      ? latestSupportOwnerByNode.get(anchorKey)
      : undefined;
    if (parentId) supportParentById.set(id, parentId);
    current?.node_keys.forEach((key) => latestSupportOwnerByNode.set(key, id));
  });
  const supportChainFrom = (leafId: string) => {
    const chain: string[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = leafId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      chain.push(currentId);
      const current: UniverseWorkingBundle | undefined = working.bundles[currentId];
      const anchorKey: string | undefined = current?.anchor_key;
      if (
        !anchorKey
        || visibleAnchorKeys.has(anchorKey)
        || (
          current?.lineage_root_key
          && visibleAnchorKeys.has(current.lineage_root_key)
          && !supportParentById.has(currentId)
        )
      ) break;
      currentId = supportParentById.get(currentId);
    }
    return chain;
  };
  const supportParents = new Set(supportParentById.values());
  const supportLeafIds = recentSupport.filter((id) => !supportParents.has(id));
  const orderedLeafIds = supportLeafIds.length > 0 ? supportLeafIds : recentSupport;
  const chainByLeaf = new Map<string, string[]>();
  const chainEventKeys = (leafId: string) => {
    const cached = chainByLeaf.get(leafId);
    if (cached) return cached;
    const keys: string[] = [];
    const seen = new Set<string>();
    supportChainFrom(leafId).forEach((id) => {
      eventKeysForBundle(id).forEach((key) => {
        if (seen.has(key)) return;
        seen.add(key);
        keys.push(key);
      });
    });
    chainByLeaf.set(leafId, keys);
    return keys;
  };
  const pinnedEventKeys: string[] = [];
  const appendPinnedEvent = (key: string) => {
    if (
      nodesByKey.get(key)?.kind === "event"
      && !pinnedEventKeys.includes(key)
    ) pinnedEventKeys.push(key);
  };
  working.pinned_keys.forEach(appendPinnedEvent);
  working.pinned_relation_keys.forEach((key) => {
    const relation = relationsByKey.get(key);
    if (!relation) return;
    appendPinnedEvent(universeNodeKey("event", relation.from_id, relation.source_id));
    if (relation.kind === "subevent") {
      appendPinnedEvent(universeNodeKey("event", relation.to_id, relation.source_id));
    }
  });
  pinnedEventKeys.forEach(appendEvent);

  const hasPinnedFocus = pinnedNodeKeys.size > 0 || pinnedRelationKeys.size > 0;
  const activeBundleId = visible.at(-1);
  if (!hasPinnedFocus && activeBundleId) {
    eventKeysForBundle(activeBundleId).forEach(appendEvent);
  }

  const pinnedLeafIds = orderedLeafIds.filter((leafId) =>
    supportChainFrom(leafId).some(bundleIsPinned));
  const priorityLeafIds = [...new Set([
    ...pinnedLeafIds,
    ...(orderedLeafIds[0] ? [orderedLeafIds[0]] : []),
  ])];
  const priorityLeafSet = new Set(priorityLeafIds);
  const prioritySupportIds = [...new Set(
    priorityLeafIds.flatMap((leafId) => supportChainFrom(leafId)),
  )];

  // The locked/latest branch owns the remaining visual runway. Consume its
  // newest leaf-to-ancestor suffix before considering any unrelated branch;
  // older support pages may already have left the resident FIFO.
  priorityLeafIds.forEach((leafId) => {
    const remaining = maxEvents - selectedEventKeys.length;
    if (remaining <= 0) return;
    chainEventKeys(leafId)
      .filter((key) => !selectedEventSet.has(key))
      .slice(0, remaining)
      .forEach(appendEvent);
  });

  // Other branches are atomic. Never spend the last slot on a disconnected
  // deep leaf when its connective support suffix cannot fit beside it.
  orderedLeafIds
    .filter((id) => !priorityLeafSet.has(id))
    .forEach((leafId) => {
      const missing = chainEventKeys(leafId).filter((key) =>
        !selectedEventSet.has(key));
      if (missing.length > maxEvents - selectedEventKeys.length) return;
      missing.forEach(appendEvent);
    });

  [...visible].reverse().forEach((id) =>
    eventKeysForBundle(id).forEach(appendEvent));

  const candidateBundleIds = [...new Set([...visible, ...support])];
  const candidateRelationKeys = new Set(
    candidateBundleIds.flatMap((id) => working.bundles[id]?.relation_keys ?? []),
  );
  const relationBundlePriority = [
    ...prioritySupportIds,
    ...recentSupport.filter((id) => !prioritySupportIds.includes(id)),
    ...[...visible].reverse(),
  ];
  const relationRank = new Map<string, number>();
  relationBundlePriority.forEach((id, index) => {
    working.bundles[id]?.relation_keys.forEach((key) => {
      if (!relationRank.has(key)) relationRank.set(key, index);
    });
  });
  const eventRank = new Map(selectedEventKeys.map((key, index) => [key, index]));
  const relationOrder = new Map(working.relations.map((relation, index) => [
    universeRelationKey(relation),
    index,
  ]));
  const prioritizedRelations = working.relations
    .filter((relation) => {
      const key = universeRelationKey(relation);
      const sourceKey = universeNodeKey("event", relation.from_id, relation.source_id);
      return candidateRelationKeys.has(key) && selectedEventSet.has(sourceKey);
    })
    .sort((left, right) => {
      const leftKey = universeRelationKey(left);
      const rightKey = universeRelationKey(right);
      return Number(pinnedRelationKeys.has(rightKey))
        - Number(pinnedRelationKeys.has(leftKey))
        || (eventRank.get(universeNodeKey(
        "event",
        left.from_id,
        left.source_id,
      )) ?? Number.MAX_SAFE_INTEGER)
        - (eventRank.get(universeNodeKey(
          "event",
          right.from_id,
          right.source_id,
        )) ?? Number.MAX_SAFE_INTEGER)
        || (relationRank.get(leftKey) ?? Number.MAX_SAFE_INTEGER)
          - (relationRank.get(rightKey) ?? Number.MAX_SAFE_INTEGER)
        || (relationOrder.get(leftKey) ?? Number.MAX_SAFE_INTEGER)
          - (relationOrder.get(rightKey) ?? Number.MAX_SAFE_INTEGER);
    });

  const allowedNodeKeys = new Set(selectedEventKeys);
  const allowedRelationKeys = new Set<string>();
  const maxRelationsPerEvent = perEventRelationLimit === undefined
    ? Number.MAX_SAFE_INTEGER
    : Number.isFinite(perEventRelationLimit)
      ? Math.max(0, Math.floor(perEventRelationLimit))
      : 0;
  const relationsBySelectedEvent = new Map(selectedEventKeys.map((key) => [
    key,
    [] as typeof prioritizedRelations,
  ]));
  prioritizedRelations.forEach((relation) => {
    relationsBySelectedEvent.get(universeNodeKey(
      "event",
      relation.from_id,
      relation.source_id,
    ))?.push(relation);
  });
  const admittedRelationsByEvent = new Map<string, number>();
  const allocateRelationPass = (pinned: boolean) => {
    const passRelations = new Map(selectedEventKeys.map((eventKey) => [
      eventKey,
      (relationsBySelectedEvent.get(eventKey) ?? []).filter((relation) =>
        pinnedRelationKeys.has(universeRelationKey(relation)) === pinned),
    ]));
    const relationDepth = Math.max(
      0,
      ...[...passRelations.values()].map((relations) => relations.length),
    );
    for (
      let index = 0;
      index < relationDepth && allowedRelationKeys.size < edgeLimit;
      index += 1
    ) {
      selectedEventKeys.forEach((eventKey) => {
        if (
          allowedRelationKeys.size >= edgeLimit
          || (admittedRelationsByEvent.get(eventKey) ?? 0) >= maxRelationsPerEvent
        ) return;
        const relation = passRelations.get(eventKey)?.[index];
        if (!relation) return;
        const targetKind = relation.kind === "subevent" ? "event" : "entity";
        const targetKey = universeNodeKey(targetKind, relation.to_id, relation.source_id);
        if (targetKind === "event" && !selectedEventSet.has(targetKey)) return;
        if (!nodesByKey.has(targetKey)) return;
        const additionalNode = Number(!allowedNodeKeys.has(targetKey));
        if (allowedNodeKeys.size + additionalNode > nodeLimit) return;
        allowedNodeKeys.add(targetKey);
        allowedRelationKeys.add(universeRelationKey(relation));
        admittedRelationsByEvent.set(
          eventKey,
          (admittedRelationsByEvent.get(eventKey) ?? 0) + 1,
        );
      });
    }
  };
  allocateRelationPass(true);
  allocateRelationPass(false);

  const relevantBundleIds = new Set(candidateBundleIds.filter((id) => {
    const bundle = working.bundles[id];
    return bundle?.node_keys.some((key) => selectedEventSet.has(key))
      || bundle?.relation_keys.some((key) => allowedRelationKeys.has(key));
  }));
  return materializeUniverseBundles(
    working,
    working.bundle_order.filter((id) => relevantBundleIds.has(id)),
    allowedNodeKeys,
    allowedRelationKeys,
  );
}

/**
 * Projects a resident browse cache through the renderer's smaller hard budget.
 * The active timeline bundle is considered first, followed by the remaining
 * visible timeline in recency order. Optional support prefers a locked/pinned
 * network and then the most recently admitted bundles. Every selection is
 * bundle-atomic, so no dangling relation or half event package can enter the
 * scene. Under the production limits every requested visible timeline bundle
 * fits; the recency ordering is a final guard for malformed oversized data.
 */
export function projectUniverseBundleWindowWithinBudget(
  working: UniverseWorkingSet,
  visibleBundleIds: Iterable<string>,
  supportBundleIds: Iterable<string>,
  budget: { nodes: number; edges: number },
  eventLimit?: number,
  perEventRelationLimit?: number,
) {
  const nodeLimit = Number.isFinite(budget.nodes)
    ? Math.max(0, Math.floor(budget.nodes))
    : 0;
  const edgeLimit = Number.isFinite(budget.edges)
    ? Math.max(0, Math.floor(budget.edges))
    : 0;
  if (nodeLimit === 0) return materializeUniverseBundles(working, []);

  const visible = normalizedBundleIds(visibleBundleIds)
    .filter((id) => Boolean(working.bundles[id]));
  const visibleSet = new Set(visible);
  const support = rankedUniverseSupportBundleIds(
    working,
    visibleSet,
    supportBundleIds,
  );
  if (eventLimit !== undefined) {
    return projectUniverseEventWindowWithinBudget(
      working,
      visible,
      support,
      nodeLimit,
      edgeLimit,
      eventLimit,
      perEventRelationLimit,
    );
  }
  const selected = new Set<string>();
  const selectedNodeKeys = new Set<string>();
  const selectedRelationKeys = new Set<string>();
  const availableNodeKeys = new Set(working.nodes.map((node) =>
    universeNodeKey(node.kind, node.id, node.source_id)));
  const availableRelationKeys = new Set(working.relations.map(universeRelationKey));

  const selectIfFits = (id: string) => {
    if (selected.has(id)) return true;
    const bundle = working.bundles[id];
    if (!bundle) return false;
    const bundleNodeKeys = bundle.node_keys.filter((key) => availableNodeKeys.has(key));
    const bundleRelationKeys = bundle.relation_keys.filter((key) =>
      availableRelationKeys.has(key));
    const additionalNodes = bundleNodeKeys.reduce(
      (count, key) => count + Number(!selectedNodeKeys.has(key)),
      0,
    );
    const additionalRelations = bundleRelationKeys.reduce(
      (count, key) => count + Number(!selectedRelationKeys.has(key)),
      0,
    );
    if (
      selectedNodeKeys.size + additionalNodes > nodeLimit
      || selectedRelationKeys.size + additionalRelations > edgeLimit
    ) return false;
    selected.add(id);
    bundleNodeKeys.forEach((key) => selectedNodeKeys.add(key));
    bundleRelationKeys.forEach((key) => selectedRelationKeys.add(key));
    return true;
  };

  // The last visible id is the active event package. Protect it first if a
  // corrupt or unexpectedly large server bundle ever exceeds the contract.
  [...visible].reverse().forEach(selectIfFits);

  support.forEach((id) => {
    const bundle = working.bundles[id];
    if (
      bundle.origin === "expansion"
      && (
        (!bundle.anchor_key || !selectedNodeKeys.has(bundle.anchor_key))
        && (
          !bundle.lineage_root_key
          || !selectedNodeKeys.has(bundle.lineage_root_key)
        )
      )
    ) return;
    selectIfFits(id);
  });

  return materializeUniverseBundles(
    working,
    working.bundle_order.filter((id) => selected.has(id)),
  );
}

/**
 * Physically removes evicted cache bundles while rebuilding ownership, pins,
 * roots and endpoint-closed relations for the retained support bundles.
 */
export function retainUniverseWorkingSetBundles(
  working: UniverseWorkingSet,
  keepIds: Iterable<string>,
) {
  const keep = new Set(normalizedBundleIds(keepIds));
  return materializeUniverseBundles(
    working,
    working.bundle_order.filter((id) => keep.has(id)),
  );
}
