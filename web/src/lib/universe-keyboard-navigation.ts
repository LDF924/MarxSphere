// universe-keyboard-navigation.ts — 键盘导航候选排序与循环(对齐 Zleap universe-keyboard-navigation.ts)
// 语义: 候选按 kind(源→事件→实体)/sourceId/root/importance 稳定排序,
// 导航在有界列表内循环,空列表返回 null。
// 来源: Zleap-AI/SAG apps/web/lib/universe-keyboard-navigation.ts(完整移植)。
export type UniverseKeyboardDirection = -1 | 1;

export interface UniverseKeyboardCandidate {
  id: string;
  sourceId: string;
  kind: "source" | "event" | "entity";
  root: boolean;
  importance: number;
}

const KIND_RANK: Record<UniverseKeyboardCandidate["kind"], number> = {
  source: 0,
  event: 1,
  entity: 2,
};

/** Returns a stable copy; it never mutates graph or working-set order. */
export function orderUniverseKeyboardCandidates<T extends UniverseKeyboardCandidate>(
  candidates: readonly T[],
) {
  return [...candidates].sort((left, right) => {
    const kindDifference = KIND_RANK[left.kind] - KIND_RANK[right.kind];
    if (kindDifference) return kindDifference;
    const sourceDifference = left.sourceId.localeCompare(right.sourceId);
    if (sourceDifference) return sourceDifference;
    if (left.root !== right.root) return left.root ? -1 : 1;
    const importanceDifference = right.importance - left.importance;
    if (Number.isFinite(importanceDifference) && importanceDifference) {
      return importanceDifference;
    }
    return left.id.localeCompare(right.id);
  });
}

/** Cycles within one bounded candidate list, with a deterministic empty-current entry point. */
export function nextUniverseKeyboardNodeId(
  candidateIds: readonly string[],
  currentId: string | null,
  direction: UniverseKeyboardDirection,
) {
  if (!candidateIds.length) return null;
  const currentIndex = currentId ? candidateIds.indexOf(currentId) : -1;
  if (currentIndex < 0) {
    return direction > 0 ? candidateIds[0] : candidateIds[candidateIds.length - 1];
  }
  return candidateIds[
    (currentIndex + direction + candidateIds.length) % candidateIds.length
  ];
}
