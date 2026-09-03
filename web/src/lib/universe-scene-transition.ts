// universe-scene-transition.ts — 场景交付/增量计划与扇形进度(对齐 Zleap universe-scene-transition.ts)
// 语义: 策略边界+恢复探索 → 稳定恢复(不重播动画);稳定身份 diff 分离
// retained/entering/exiting;扇形距离是连续函数(不是离散车道)。
// 来源: Zleap-AI/SAG apps/web/lib/universe-scene-transition.ts(完整移植)。
export interface UniverseSceneDeltaPlan {
  retainedIds: string[];
  enteringIds: string[];
  exitingIds: string[];
  topologyChanged: boolean;
}

export interface UniverseSceneDeliveryPlan {
  stableRestore: boolean;
  animateTimelineWindow: boolean;
  animateEntrants: boolean;
  autoFocus: boolean;
}

/**
 * A retained exploration is a restoration, not a new scene entrance. The
 * strategy boundary still rebuilds WebGL objects to keep coordinate systems
 * isolated, but the rebuilt objects must land directly at their canonical
 * positions and wait for the retained camera to be restored.
 */
export function planUniverseSceneDelivery(input: {
  strategyBoundary: boolean;
  restoringExploration: boolean;
  windowChanged: boolean;
  timelineJourneyEnabled: boolean;
}): UniverseSceneDeliveryPlan {
  const stableRestore = input.strategyBoundary && input.restoringExploration;
  return {
    stableRestore,
    animateTimelineWindow: !stableRestore
      && input.windowChanged
      && input.timelineJourneyEnabled,
    animateEntrants: !stableRestore,
    autoFocus: !stableRestore,
  };
}

/**
 * Stable identity diff used by the WebGL scene. Retained ids are deliberately
 * separated from entrants so an ordinary window step can never reset the
 * opacity or object identity of the overlapping network.
 */
export function planUniverseSceneDelta(
  previousIds: Iterable<string>,
  nextIds: Iterable<string>,
): UniverseSceneDeltaPlan {
  const previous = [...new Set(previousIds)];
  const next = [...new Set(nextIds)];
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  const retainedIds = next.filter((id) => previousSet.has(id));
  const enteringIds = next.filter((id) => !previousSet.has(id));
  const exitingIds = previous.filter((id) => !nextSet.has(id));
  return {
    retainedIds,
    enteringIds,
    exitingIds,
    topologyChanged: enteringIds.length > 0 || exitingIds.length > 0,
  };
}

/** Continuous fan distance; unlike discrete lanes, every visible step moves. */
export function universeTimelineFanProgress(age: number, total: number) {
  const denominator = Math.max(1, Math.floor(total) - 1);
  const normalized = Math.min(1, Math.max(0, age / denominator));
  return 1 - Math.pow(1 - normalized, 2.2);
}
