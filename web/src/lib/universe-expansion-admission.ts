// universe-expansion-admission.ts — 扩展页原子准入(对齐 Zleap universe-expansion-admission.ts)
// 语义: 响应/请求快照契约(epoch/source/revision/snapshot/as-of/游标)校验通过后
// 才做一次原子 bundle 准入;返回的 nextCursor 只在接受时推进。
// 来源: Zleap-AI/SAG apps/web/lib/universe-expansion-admission.ts(完整移植)。
import type {
  UniverseGraphPatch,
  UniverseNodeKind,
} from "./universe-types";
import {
  admitUniverseBundle,
  type AdmitUniverseBundleOptions,
  type UniverseBundleAdmissionResult,
  type UniverseWorkingSet,
  universeNodeKey,
} from "./universe-working-set";

export interface UniverseExpansionRequestAnchor {
  epoch: number;
  sourceId: string;
  nodeKind: UniverseNodeKind;
  nodeId: string;
  /** Stable timeline node that owns the expansion branch. */
  lineageRootKey: string;
  requestCursor: string | null;
  snapshotId: string | null;
  sourceRevision: string | null;
  asOf: string | null;
}

export interface UniverseExpansionPageAdmission
  extends UniverseBundleAdmissionResult {
  nextCursor: string | null;
  done: boolean;
}

function nodeKey(kind: UniverseNodeKind, id: string) {
  return `${kind}:${id}`;
}

function validOpaqueValue(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function validNullableCursor(value: unknown): value is string | null {
  return value === null || validOpaqueValue(value, 2048);
}

function validTimestamp(value: unknown) {
  return typeof value === "string"
    && value.length > 0
    && Number.isFinite(Date.parse(value));
}

function validExpansionContract(
  page: UniverseGraphPatch,
  expected: UniverseExpansionRequestAnchor,
) {
  if (
    page.schema_version !== 2
    || page.epoch !== expected.epoch
    || !validOpaqueValue(page.source_id, 64)
    || page.source_id !== expected.sourceId
    || !validOpaqueValue(page.source_revision, 128)
    || !validOpaqueValue(page.snapshot_id, 2048)
    || !validOpaqueValue(page.page_id, 128)
    || !validOpaqueValue(page.bundle_id, 512)
    || !validTimestamp(page.as_of)
    || !validNullableCursor(page.request_cursor)
    || !validNullableCursor(page.page.next_cursor)
    || page.request_cursor !== expected.requestCursor
    || (expected.snapshotId !== null && page.snapshot_id !== expected.snapshotId)
    || (
      expected.sourceRevision !== null
      && page.source_revision !== expected.sourceRevision
    )
    || (expected.asOf !== null && page.as_of !== expected.asOf)
    || page.anchor.kind !== expected.nodeKind
    || page.anchor.id !== expected.nodeId
    || page.anchor.source_id !== expected.sourceId
    || !validOpaqueValue(expected.lineageRootKey, 4096)
    || !Number.isInteger(page.page.returned)
    || page.page.returned < 0
    || page.page.has_more !== (page.page.next_cursor !== null)
    || (page.page.has_more && page.page.returned === 0)
    || (
      page.page.next_cursor !== null
      && page.page.next_cursor === page.request_cursor
    )
    || (page.request_cursor !== null && expected.snapshotId === null)
  ) return false;

  const anchorKey = nodeKey(page.anchor.kind, page.anchor.id);
  const returnedIds = page.nodes.map((node) => node.id);
  const returnedKeys = page.nodes.map((node) => nodeKey(node.kind, node.id));
  const returnedKeySet = new Set(returnedKeys);
  if (
    new Set(returnedIds).size !== returnedIds.length
    || returnedIds.includes(page.anchor.id)
    || returnedKeySet.size !== returnedKeys.length
    || returnedKeySet.has(anchorKey)
    || page.nodes.some((node) => node.source_id !== expected.sourceId)
  ) return false;

  const eventIds = new Set<string>();
  const entityIds = new Set<string>();
  if (page.anchor.kind === "event") eventIds.add(page.anchor.id);
  else entityIds.add(page.anchor.id);
  page.nodes.forEach((node) => {
    (node.kind === "event" ? eventIds : entityIds).add(node.id);
  });
  const primaryCount = expected.nodeKind === "event"
    ? page.nodes.filter((node) => node.kind === "entity").length
    : page.nodes.filter((node) => node.kind === "event").length;
  if (
    primaryCount !== page.page.returned
    || page.anchor.related_count < primaryCount
    || (
      expected.nodeKind === "event"
      && page.nodes.some((node) => node.kind !== "entity")
    )
  ) return false;

  const relationKeys = page.relations.map((relation) =>
    `${relation.kind}:${relation.from_id}:${relation.to_id}`);
  if (
    new Set(relationKeys).size !== relationKeys.length
    || page.relations.some((relation) =>
      relation.source_id !== expected.sourceId
      || relation.kind !== "mentions"
      || !eventIds.has(relation.from_id)
      || !entityIds.has(relation.to_id))
  ) return false;

  const relatedKeys = new Set<string>();
  page.relations.forEach((relation) => {
    relatedKeys.add(nodeKey("event", relation.from_id));
    relatedKeys.add(nodeKey("entity", relation.to_id));
  });
  if (page.nodes.some((node) => !relatedKeys.has(nodeKey(node.kind, node.id)))) {
    return false;
  }
  if (expected.nodeKind === "event") {
    if (
      page.relations.length !== page.nodes.length
      || page.relations.some((relation) => relation.from_id !== page.anchor.id)
    ) return false;
  } else {
    const eventNodes = page.nodes.filter((node) => node.kind === "event");
    if (eventNodes.some((event) => !page.relations.some((relation) =>
      relation.from_id === event.id && relation.to_id === page.anchor.id))) {
      return false;
    }
  }
  return true;
}

/** Validate the response/request snapshot contract before one atomic admission. */
export function admitUniverseExpansionPage(
  current: UniverseWorkingSet,
  page: UniverseGraphPatch,
  expected: UniverseExpansionRequestAnchor,
  budget: { nodes: number; edges: number },
  now = Date.now(),
  options: AdmitUniverseBundleOptions = {},
): UniverseExpansionPageAdmission {
  if (!validExpansionContract(page, expected)) {
    throw new Error("invalid expansion bundle contract");
  }
  const admission = admitUniverseBundle(
    current,
    {
      id: page.bundle_id,
      origin: "expansion",
      anchor_key: universeNodeKey(
        expected.nodeKind,
        expected.nodeId,
        expected.sourceId,
      ),
      lineage_root_key: expected.lineageRootKey,
      request_cursor: page.request_cursor,
      next_cursor: page.page.next_cursor,
      epoch: page.epoch,
      source_id: page.source_id,
      nodes: [page.anchor, ...page.nodes],
      relations: page.relations,
    },
    budget,
    now,
    options,
  );
  return {
    ...admission,
    nextCursor: admission.accepted ? page.page.next_cursor : expected.requestCursor,
    done: admission.accepted && !page.page.has_more,
  };
}
