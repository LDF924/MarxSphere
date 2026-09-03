// universe-types.ts — Explore 知识宇宙图谱前端类型(对齐 Zleap apps/web/lib/types.ts universe 段)
// 纯类型模块,无运行时代码;UniverseActivationNode 等被 universe-* lib 与视图组件共享。
// 注: 本地后端 universe API 契约简化,前端 lib 层保留 Zleap 完整类型以便后续接入。

/** 检索响应中的实体(检索激活的来源之一)。 */
export interface Entity {
  id: string;
  name: string;
  type: string;
  description: string;
  heat: number;
}

/** 检索响应中的事件(继承图谱事件,带来源与分数)。 */
export interface SearchEvent extends SourceGraphEvent {
  source_id: string | null;
  source_name?: string | null;
  score: number;
}

/** 检索响应中的关系边。 */
export interface SourceGraphRelation {
  source_id: string;
  source_kind: SourceGraphNodeKind;
  target_id: string;
  target_kind: SourceGraphNodeKind;
  kind: SourceGraphRelationKind;
  weight: number;
  description: string;
}

export type SourceGraphNodeKind = "document" | "event" | "entity";
export type SourceGraphRelationKind = "contains" | "subevent" | "mentions";

/** 图谱事件:universe 激活的原始数据形状。 */
export interface SourceGraphEvent {
  id: string;
  document_id: string | null;
  title: string;
  summary: string;
  category: string;
  rank: number;
  parent_id: string | null;
  chunk_id: string | null;
  start_time: string | null;
}

/** 检索响应段(激活构建的辅助数据)。 */
export interface Section {
  chunk_id: string | null;
  heading: string;
  content: string;
  score: number;
  rank: number;
  source_id: string | null;
  source_name?: string | null;
}

/** 检索响应(activationFromSearch 的输入)。 */
export interface SearchResponse {
  query: string;
  sections: Section[];
  events: SearchEvent[];
  entities: Entity[];
  relations: SourceGraphRelation[];
  source_hits: SearchSourceHit[];
  summary: string;
  exploration_id: string | null;
  stats: Record<string, unknown>;
}

export type UniverseNodeKind = "event" | "entity";
export type UniverseActivationOrigin = "search" | "assistant" | "browse";

export interface UniversePartition {
  id: string;
  source_id: string;
  parent_id: string | null;
  kind: "source" | "topic";
  key: string;
  label: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  node_count: number;
  event_count: number;
  entity_count: number;
  relation_count: number;
  density: number;
  time_buckets: Array<{ start: string; end: string; count: number }>;
  importance: number;
}

export interface UniverseManifest {
  version: string | null;
  status: "empty" | "building" | "ready" | "stale" | "failed";
  stale: boolean;
  as_of: string | null;
  bounds: {
    min_x?: number;
    min_y?: number;
    min_z?: number;
    max_x?: number;
    max_y?: number;
    max_z?: number;
  };
  partitions: UniversePartition[];
  counts: {
    sources?: number;
    partitions?: number;
    events?: number;
    entities?: number;
    nodes?: number;
    relations?: number;
  };
  policy: UniversePolicy;
}

export interface UniversePolicy {
  source_limit: number;
  timeline_event_page_size: number;
  event_entity_limit: number;
  lod_orbit_px: number;
  lod_near_px: number;
  lod_deep_px: number;
  lod_hysteresis_px: number;
  lod_debounce_ms: number;
  proxy_budget_desktop: number;
  proxy_budget_mobile: number;
  node_budget_desktop: number;
  node_budget_mobile: number;
  edge_budget_desktop: number;
  edge_budget_mobile: number;
}

export interface UniverseRelation {
  source_id: string;
  from_id: string;
  to_id: string;
  kind: "mentions" | "subevent";
  weight: number;
  description: string;
}

export interface UniverseEvidence {
  source_id: string;
  source_name: string;
  document_id: string | null;
  document_name: string | null;
  chunk_id: string | null;
  heading: string;
  content: string;
}

export interface UniverseNodeDetail {
  id: string;
  kind: UniverseNodeKind;
  source_id: string;
  source_name: string;
  label: string;
  description: string;
  category: string;
  start_time: string | null;
  evidence: UniverseEvidence | null;
}

export interface UniverseActivationNode {
  id: string;
  kind: UniverseNodeKind;
  source_id?: string | null;
  label: string;
  description?: string;
  category?: string;
  chunk_id?: string | null;
  start_time?: string | null;
  importance?: number;
  related_count?: number;
  citation_numbers?: number[];
  state?: "latent" | "active";
}

export interface UniverseActivation {
  epoch?: number;
  origin?: UniverseActivationOrigin;
  query: string;
  nodes: UniverseActivationNode[];
  relations: UniverseRelation[];
  source_hits?: SearchSourceHit[];
}

export interface UniversePatchNode {
  id: string;
  kind: UniverseNodeKind;
  source_id: string;
  label: string;
  description: string;
  category: string;
  chunk_id: string | null;
  start_time: string | null;
  importance: number;
  related_count: number;
  state: "latent" | "active";
}

export interface UniverseGraphPatch {
  schema_version: 2;
  epoch: number;
  source_id: string;
  source_revision: string;
  snapshot_id: string;
  request_cursor: string | null;
  page_id: string;
  bundle_id: string;
  anchor: UniversePatchNode;
  nodes: UniversePatchNode[];
  relations: UniverseRelation[];
  page: {
    returned: number;
    has_more: boolean;
    next_cursor: string | null;
  };
  as_of: string;
}

export interface UniverseTimelineEventNode extends UniversePatchNode {
  kind: "event";
}

export interface UniverseTimelineEntityNode extends UniversePatchNode {
  kind: "entity";
}

export interface UniverseTimelineRelation extends UniverseRelation {
  kind: "mentions";
}

export type UniverseTimelineDirection = "older" | "newer";

export interface UniverseTimelineSlice {
  schema_version: 3;
  epoch: number;
  source_id: string;
  source_revision: string;
  snapshot_id: string;
  request_direction: UniverseTimelineDirection;
  request_cursor: string | null;
  page_id: string;
  bundles: Array<{
    bundle_id: string;
    /** Snapshot-stable position in the source's exploration order; 0 = newest. */
    ordinal: number;
    event: UniverseTimelineEventNode;
    nodes: UniverseTimelineEntityNode[];
    relations: UniverseTimelineRelation[];
    neighbor_page: {
      total_unique: number;
      returned_unique: number;
      complete: boolean;
      next_cursor: string | null;
    };
    cursor_before: string | null;
    cursor_after: string | null;
  }>;
  /** Snapshot-stable event total: the counting axis' length for this source. */
  total_events: number;
  page: {
    returned_bundles: number;
    returned_unique_nodes: number;
    returned_relations: number;
    direction: UniverseTimelineDirection;
    has_newer: boolean;
    newer_cursor: string | null;
    has_older: boolean;
    older_cursor: string | null;
    has_more: boolean;
    next_cursor: string | null;
  };
  as_of: string;
}

/** 检索命中的来源聚合(激活 bundle 的 source_hits 元素)。 */
export interface SearchSourceHit {
  source_id: string;
  source_name: string | null;
  event_hits: number;
  max_score: number;
  latest_event_time: string | null;
}
