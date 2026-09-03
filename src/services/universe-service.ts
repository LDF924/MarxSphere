// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// universe-service.ts — Explore 图谱数据服务(阶段4b, 对齐 Zleap universe 快照契约)
// 数据源: PG 事件/实体为主 + Graphiti 超边叠加(Neo4j 11001 在线时)
// 契约: manifest / timeline(bundle+ordinal+cursor) / expand(patch) / node_detail / rebuild
// 快照语义: epoch 全局单调;snapshot_id = epoch+source+修订指纹;游标 = 事件 UUID;
// ordinal = 源内按 created_at desc 排序的计数轴位置(0 = 最新)。
import { pool } from "../db/pool.js";
import { neo4jQuery } from "../db/neo4j-query.js";

export type UniverseNodeKind = "event" | "entity";

export interface UniverseManifest {
  version: string | null;
  status: "empty" | "building" | "ready" | "stale" | "failed";
  stale: boolean;
  as_of: string | null;
  bounds: Record<string, number | undefined>;
  partitions: Array<{
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
  }>;
  counts: {
    sources?: number;
    partitions?: number;
    events?: number;
    entities?: number;
    nodes?: number;
    relations?: number;
  };
  policy: {
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
  };
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

export interface UniverseRelation {
  source_id: string;
  from_id: string;
  to_id: string;
  kind: "mentions" | "subevent";
  weight: number;
  description: string;
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
  page: { returned: number; has_more: boolean; next_cursor: string | null };
  as_of: string;
}

export interface UniverseTimelineEventNode extends UniversePatchNode {
  kind: "event";
}

export interface UniverseTimelineEntityNode extends UniversePatchNode {
  kind: "entity";
}

export interface UniverseTimelineSlice {
  schema_version: 3;
  epoch: number;
  source_id: string;
  source_revision: string;
  snapshot_id: string;
  request_direction: "older" | "newer";
  request_cursor: string | null;
  page_id: string;
  bundles: Array<{
    bundle_id: string;
    ordinal: number;
    event: UniverseTimelineEventNode;
    nodes: UniverseTimelineEntityNode[];
    relations: UniverseRelation[];
    neighbor_page: {
      total_unique: number;
      returned_unique: number;
      complete: boolean;
      next_cursor: string | null;
    };
    cursor_before: string | null;
    cursor_after: string | null;
  }>;
  total_events: number;
  page: {
    returned_bundles: number;
    returned_unique_nodes: number;
    returned_relations: number;
    direction: "older" | "newer";
    has_newer: boolean;
    newer_cursor: string | null;
    has_older: boolean;
    older_cursor: string | null;
    has_more: boolean;
    next_cursor: string | null;
  };
  as_of: string;
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
  evidence: {
    source_id: string;
    source_name: string;
    document_id: string | null;
    document_name: string | null;
    chunk_id: string | null;
    heading: string;
    content: string;
  } | null;
}

const DEFAULT_POLICY = {
  source_limit: 24,
  timeline_event_page_size: 20,
  event_entity_limit: 8,
  lod_orbit_px: 240,
  lod_near_px: 480,
  lod_deep_px: 960,
  lod_hysteresis_px: 72,
  lod_debounce_ms: 120,
  proxy_budget_desktop: 700,
  proxy_budget_mobile: 520,
  node_budget_desktop: 700,
  node_budget_mobile: 520,
  edge_budget_desktop: 1_000,
  edge_budget_mobile: 720,
} as const;

/** 快照指纹: 源内事件总量 + 最新更新时间,用于检测修订。 */
async function sourceRevision(sourceId: string): Promise<{
  revision: string;
  totalEvents: number;
  asOf: string;
}> {
  const r = await pool.query(
    `select count(*)::int as total,
            coalesce(to_char(max(updated_at) at time zone 'utc',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') as latest
     from events where source_id = $1 and deleted_at is null`,
    [sourceId],
  );
  const total = Number(r.rows[0]?.total ?? 0);
  const latest = String(r.rows[0]?.latest ?? "");
  // asOf 必须稳定(数据修订时刻): 前端按严格相等校验跨页快照一致性,
  // 用实时时钟会让同一快照的第二次请求即失败 → 时间轴永远卡第 1 页。
  // latest 为空(空源)时回退到过去固定时刻,避免请求间抖动。
  return {
    revision: `${total}:${latest}`.slice(0, 128),
    totalEvents: total,
    asOf: latest !== ""
      ? new Date(latest).toISOString()
      : new Date(0).toISOString(),
  };
}

let universeEpoch = 0;
function nextEpoch(): number {
  universeEpoch += 1;
  return universeEpoch;
}

function snapshotId(epoch: number, sourceId: string, revision: string) {
  let hash = 2166136261;
  const value = `${epoch}:${sourceId}:${revision}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `snap-${(hash >>> 0).toString(36)}`;
}

function patchNodeFromEvent(row: any, sourceId: string): UniverseTimelineEventNode {
  return {
    id: String(row.id),
    kind: "event",
    source_id: sourceId,
    label: String(row.title ?? row.id ?? ""),
    description: String(row.summary ?? ""),
    category: String(row.category ?? "event"),
    chunk_id: row.chunk_id ? String(row.chunk_id) : null,
    start_time: row.start_time ? new Date(row.start_time).toISOString() : null,
    importance: Number(row.rank ?? 0) > 0 ? Math.min(1, Number(row.rank) / 10) : 0.5,
    related_count: Number(row.related_count ?? 0),
    state: "active",
  };
}

function patchNodeFromEntity(row: any, sourceId: string): UniverseTimelineEntityNode {
  return {
    id: String(row.id),
    kind: "entity",
    source_id: sourceId,
    label: String(row.name ?? row.id ?? ""),
    description: String(row.description ?? ""),
    category: String(row.type ?? "entity"),
    chunk_id: null,
    start_time: null,
    importance: 0.5,
    related_count: Number(row.related_count ?? 0),
    state: "latent",
  };
}

/** manifest: 全局统计 + 能力声明 + 分区布局 */
export async function universeManifest(): Promise<UniverseManifest> {
  const [events, entities, relations, sources] = await Promise.all([
    pool.query(`select count(*) as c from events where deleted_at is null`),
    pool.query(`select count(*) as c from entities`),
    pool.query(
      `select count(*) as c from event_entities ee join events e on e.id = ee.event_id where e.deleted_at is null`,
    ),
    pool.query(`select count(*) as c from sources where archived_at is null`),
  ]);
  const sourceRows = await pool.query(
    `select s.id, s.name, count(distinct e.id) as events
     from sources s
     left join events e on e.source_id = s.id and e.deleted_at is null
     where s.archived_at is null
     group by s.id, s.name
     order by events desc
     limit $1`,
    [DEFAULT_POLICY.source_limit],
  );
  const partitions = sourceRows.rows.map((row: any, index: number) => {
    const angle = index * (Math.PI * (3 - Math.sqrt(5)));
    const radius = 260 + (index % 5) * 36;
    return {
      id: String(row.id),
      source_id: String(row.id),
      parent_id: null,
      kind: "source" as const,
      key: String(row.id),
      label: String(row.name ?? "未命名来源"),
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.82,
      z: 0,
      radius: 88,
      node_count: Number(row.events ?? 0),
      event_count: Number(row.events ?? 0),
      entity_count: 0,
      relation_count: 0,
      density: 0.5,
      time_buckets: [],
      importance: 0.6,
    };
  });
  // Graphiti 可用性
  let graphiti = false;
  try {
    await neo4jQuery(11001, "MATCH (n) RETURN count(n) AS c LIMIT 1");
    graphiti = true;
  } catch {
    graphiti = false;
  }
  // as_of/version 用全局数据指纹(最新修订时刻),非请求时钟:
  // 前端把 version 变化当作数据修订信号并重置场景,实时递增会让每次
  // manifest 轮询都重置;也避免 rebuild 轮询中视图被反复打断。
  const revisionRow = await pool.query(
    `select coalesce(
       to_char(greatest(
         (select max(updated_at) from events where deleted_at is null),
         (select max(updated_at) from sources where archived_at is null)
       ) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') as latest`,
  );
  const globalLatest = String(revisionRow.rows[0]?.latest ?? "");
  const manifestAsOf = globalLatest !== ""
    ? new Date(globalLatest).toISOString()
    : new Date(0).toISOString();
  return {
    version: `v1:${manifestAsOf}`,
    status: "ready",
    stale: false,
    as_of: manifestAsOf,
    bounds: {},
    partitions,
    counts: {
      sources: Number(sources.rows[0]?.c ?? 0),
      partitions: partitions.length,
      events: Number(events.rows[0]?.c ?? 0),
      entities: Number(entities.rows[0]?.c ?? 0),
      nodes: Number(events.rows[0]?.c ?? 0) + Number(entities.rows[0]?.c ?? 0),
      relations: Number(relations.rows[0]?.c ?? 0),
    },
    policy: {
      ...DEFAULT_POLICY,
      // Graphiti 在线时叠加能力(政策字段保持数值契约)
      proxy_budget_desktop: DEFAULT_POLICY.proxy_budget_desktop,
    },
    // 附加能力声明: Graphiti 超边可用性(前端状态条展示)
    ...(graphiti ? { graphiti: true } : {}),
  };
}

/** timeline: 快照契约分页(事件 bundle = 事件 + 关联实体 + 关系) */
export async function universeTimeline(input: {
  epoch: number;
  source_id: string;
  limit?: number;
  direction?: "older" | "newer";
  cursor?: string | null;
  snapshot_id?: string | null;
}): Promise<UniverseTimelineSlice> {
  const sourceId = input.source_id;
  const direction = input.direction ?? "older";
  const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
  console.log("[universe-timeline] req:", JSON.stringify({ epoch: input.epoch, sourceId, direction, cursor: input.cursor ?? null, snapshot_id: input.snapshot_id ?? null }));
  const { revision, totalEvents, asOf } = await sourceRevision(sourceId);
  const epoch = input.epoch || nextEpoch();
  const snap = snapshotId(epoch, sourceId, revision);

  // 全源计数轴: created_at desc, id 决胜
  const order = direction === "older" ? "desc" : "asc";
  const cursorFilter = input.cursor
    ? direction === "older"
      ? `and (e.created_at, e.id) < (select created_at, id from events where id = $3::uuid)`
      : `and (e.created_at, e.id) > (select created_at, id from events where id = $3::uuid)`
    : "";
  const params: unknown[] = [sourceId, limit];
  if (input.cursor) params.push(input.cursor);
  const r = await pool.query(
    `select e.id, e.title, e.summary, e.category, e.chunk_id, e.start_time, e.rank,
            e.created_at, e.parent_id,
            (select count(*) from event_entities ee where ee.event_id = e.id) as related_count
     from events e
     where e.source_id = $1 and e.deleted_at is null
     ${cursorFilter}
     order by e.created_at ${order}, e.id ${order}
     limit $2`,
    params,
  );
  // 最新/最旧边缘(决定 has_newer / has_older)
  const edge = await pool.query(
    `select
       (select id from events where source_id = $1 and deleted_at is null order by created_at desc, id desc limit 1) as newest_id,
       (select id from events where source_id = $1 and deleted_at is null order by created_at asc, id asc limit 1) as oldest_id`,
    [sourceId],
  );
  const newestId = edge.rows[0]?.newest_id ? String(edge.rows[0].newest_id) : null;
  const oldestId = edge.rows[0]?.oldest_id ? String(edge.rows[0].oldest_id) : null;

  const events = r.rows;
  const firstId = events[0] ? String(events[0].id) : null;
  const lastId = events.length > 0 ? String(events[events.length - 1].id) : null;
  const hasNewer = Boolean(input.cursor)
    || (firstId !== null && firstId !== newestId);
  const hasOlder = Boolean(input.cursor)
    || (lastId !== null && lastId !== oldestId);

  // ordinal: 全源计数轴位置(0 = 最新)。单次窗口排序拉取 id+ordinal
  // (依赖 events_source_time_idx 复合索引, 无需逐事件子查询)。
  const ordinals = new Map<string, number>();
  if (events.length > 0) {
    const ord = await pool.query(
      `select e.id,
              row_number() over (order by e.created_at desc, e.id desc) - 1 as ordinal
       from events e
       where e.source_id = $1 and e.deleted_at is null
       order by e.created_at desc, e.id desc`,
      [sourceId],
    );
    for (const row of ord.rows) ordinals.set(String(row.id), Number(row.ordinal ?? 0));
  }

  // 实体与关系: 只取本页事件关联的
  const eventIds = events.map((row: any) => String(row.id));
  const entityById = new Map<string, any>();
  const relationsByEvent = new Map<string, UniverseRelation[]>();
  if (eventIds.length > 0) {
    const rel = await pool.query(
      `select ee.event_id, ee.entity_id, ee.weight, ee.description,
              ent.name, ent.type, ent.description as entity_description
       from event_entities ee
       join entities ent on ent.id = ee.entity_id
       where ee.event_id = any($1::uuid[])
       order by ee.weight desc`,
      [eventIds],
    );
    for (const row of rel.rows) {
      const eventId = String(row.event_id);
      const entityId = String(row.entity_id);
      if (!entityById.has(entityId)) {
        entityById.set(entityId, { ...row, id: entityId });
      }
      const list = relationsByEvent.get(eventId) ?? [];
      list.push({
        source_id: sourceId,
        from_id: eventId,
        to_id: entityId,
        kind: "mentions" as const,
        weight: Number(row.weight ?? 1),
        description: row.description ? String(row.description) : "",
      });
      relationsByEvent.set(eventId, list);
    }
  }

  const bundles = events.map((row: any) => {
    const eventId = String(row.id);
    const relations = relationsByEvent.get(eventId) ?? [];
    const nodes = relations.map((relation) => {
      const entityRow = entityById.get(relation.to_id);
      return patchNodeFromEntity(entityRow ?? { id: relation.to_id }, sourceId);
    });
    return {
      bundle_id: `bundle:${eventId}`,
      ordinal: ordinals.get(eventId) ?? 0,
      event: patchNodeFromEvent(row, sourceId),
      nodes,
      relations,
      neighbor_page: {
        total_unique: nodes.length,
        returned_unique: nodes.length,
        complete: true,
        next_cursor: null,
      },
      // 游标 = 事件身份: cursor_before 非 null 表示"从该项向更新方向翻"可用,
      // cursor_after 非 null 表示"从该项向更旧方向翻"可用。仅当该项在
      // 全局边缘(最旧/最新)时对应侧为 null。
      cursor_before: (firstId === eventId && !hasNewer) ? null : eventId,
      cursor_after: (lastId === eventId && !hasOlder) ? null : eventId,
    };
  });

  const uniqueNodes = new Set<string>();
  bundles.forEach((bundle) => {
    uniqueNodes.add(`event:${bundle.event.id}`);
    bundle.nodes.forEach((node) => uniqueNodes.add(`entity:${node.id}`));
  });
  const returned_relations = bundles.reduce(
    (total, bundle) => total + bundle.relations.length,
    0,
  );
  const newerCursor = hasNewer
    ? (direction === "older" ? firstId : lastId)
    : null;
  const olderCursor = hasOlder
    ? (direction === "older" ? lastId : firstId)
    : null;
  const hasMore = direction === "older" ? hasOlder : hasNewer;
  const nextCursor = hasMore
    ? (direction === "older" ? lastId : firstId)
    : null;

  return {
    schema_version: 3,
    epoch,
    source_id: sourceId,
    source_revision: revision,
    snapshot_id: snap,
    request_direction: direction,
    request_cursor: input.cursor ?? null,
    page_id: `page:${direction}:${input.cursor ?? "root"}`,
    bundles,
    total_events: totalEvents,
    page: {
      returned_bundles: bundles.length,
      returned_unique_nodes: uniqueNodes.size,
      returned_relations,
      direction,
      has_newer: hasNewer,
      newer_cursor: newerCursor,
      has_older: hasOlder,
      older_cursor: olderCursor,
      has_more: hasMore,
      next_cursor: nextCursor,
    },
    as_of: asOf,
  };
}

/** expand: 节点扩展(实体→关联事件 / 事件→关联实体), 快照契约 patch */
export async function universeExpand(input: {
  epoch: number;
  source_id: string;
  node_kind: UniverseNodeKind;
  node_id: string;
  limit?: number;
  cursor?: string | null;
  snapshot_id?: string | null;
  after?: string | null;
  before?: string | null;
}): Promise<UniverseGraphPatch> {
  const sourceId = input.source_id;
  const limit = Math.max(1, Math.min(input.limit ?? 8, 50));
  const { revision, asOf } = await sourceRevision(sourceId);
  const epoch = input.epoch || nextEpoch();
  const snap = snapshotId(epoch, sourceId, revision);
  const cursor = input.cursor ?? null;

  let anchor: UniversePatchNode;
  let rows: UniversePatchNode[];
  if (input.node_kind === "event") {
    const a = await pool.query(
      `select e.id, e.title, e.summary, e.category, e.chunk_id, e.start_time, e.rank,
              (select count(*) from event_entities ee where ee.event_id = e.id) as related_count
       from events e where e.id = $1 and e.deleted_at is null`,
      [input.node_id],
    );
    if (a.rows.length === 0) throw new Error("anchor event not found");
    anchor = patchNodeFromEvent(a.rows[0], sourceId);
    const rel = await pool.query(
      `select ent.id, ent.name, ent.type, ent.description
       from event_entities ee
       join entities ent on ent.id = ee.entity_id
       where ee.event_id = $1
       order by ee.weight desc
       limit $2`,
      [input.node_id, limit],
    );
    rows = rel.rows.map((row: any) => patchNodeFromEntity(row, sourceId));
  } else {
    const a = await pool.query(
      `select ent.id, ent.name, ent.type, ent.description,
              (select count(*) from event_entities ee where ee.entity_id = ent.id) as related_count
       from entities ent where ent.id = $1`,
      [input.node_id],
    );
    if (a.rows.length === 0) throw new Error("anchor entity not found");
    anchor = patchNodeFromEntity(a.rows[0], sourceId);
    const rel = await pool.query(
      `select e.id, e.title, e.summary, e.category, e.chunk_id, e.start_time, e.rank
       from event_entities ee
       join events e on e.id = ee.event_id
       where ee.entity_id = $1 and e.deleted_at is null
       order by ee.weight desc
       limit $2`,
      [input.node_id, limit],
    );
    rows = rel.rows.map((row: any) => patchNodeFromEvent(row, sourceId));
  }

  const relations: UniverseRelation[] = rows.map((node) =>
    input.node_kind === "event"
      ? {
          source_id: sourceId,
          from_id: input.node_id,
          to_id: node.id,
          kind: "mentions" as const,
          weight: 1,
          description: "",
        }
      : {
          source_id: sourceId,
          from_id: node.id,
          to_id: input.node_id,
          kind: "mentions" as const,
          weight: 1,
          description: "",
        },
  );
  // Graphiti 超边叠加(Neo4j 11001 在线时): 实体扩展补充图谱外关联。
  // 只对实体锚点做一跳超边查询(阶段1 雏形), 失败静默降级不阻断 PG 结果。
  if (input.node_kind === "entity") {
    try {
      // Graphiti 按实体名匹配(uuid 查不到), 先从 PG 取实体名
      const entityRow = await pool.query(
        `select name from entities where id = $1`,
        [input.node_id],
      );
      const entityName = entityRow.rows[0]?.name
        ? String(entityRow.rows[0].name)
        : null;
      if (entityName) {
      const g = await neo4jQuery(
        11001,
        `MATCH (e:Entity {name: $name})-[r]-(n)
         WHERE n:Entity AND n.name IS NOT NULL
         RETURN n.name AS name, type(r) AS rel
         LIMIT $limit`,
        { name: entityName, limit: Math.max(4, limit) },
        8000,
      );
      const existing = new Set(rows.map((node) => node.id));
      const gRows: UniversePatchNode[] = [];
      const gRelations: UniverseRelation[] = [];
      for (const row of g) {
        const name = String(row.name ?? "");
        if (!name || existing.has(name)) continue;
        existing.add(name);
        gRows.push({
          id: `g:${name}`,
          kind: "entity",
          source_id: sourceId,
          label: name,
          description: "",
          category: Array.isArray(row.labels) && row.labels.length
            ? String(row.labels[0])
            : "entity",
          chunk_id: null,
          start_time: null,
          importance: 0.4,
          related_count: 0,
          state: "latent",
        });
        const graphitiNodeId = `g:${name}`;
        const anchored = row.rel === "EVENT" || row.rel === "MENTIONS";
        gRelations.push({
          source_id: sourceId,
          // 关系端点必须用节点 id(g: 前缀), 否则前端关系闭包校验会丢弃
          from_id: anchored ? input.node_id : graphitiNodeId,
          to_id: anchored ? graphitiNodeId : input.node_id,
          kind: "mentions" as const,
          weight: 0.6,
          description: `Graphiti 超边: ${String(row.rel ?? "")}`,
        });
      }
      rows.push(...gRows);
      relations.push(...gRelations);
      }
    } catch {
      // Graphiti 离线不阻断(超时/连接失败静默降级)
    }
  }
  return {
    schema_version: 2,
    epoch,
    source_id: sourceId,
    source_revision: revision,
    snapshot_id: snap,
    request_cursor: cursor,
    page_id: `expand:${input.node_kind}:${input.node_id}:${cursor ?? "root"}`,
    bundle_id: `expand:${input.node_kind}:${input.node_id}:${cursor ?? "root"}`,
    anchor,
    nodes: rows,
    relations,
    page: {
      returned: rows.length,
      has_more: rows.length >= limit,
      next_cursor: rows.length >= limit ? rows[rows.length - 1].id : null,
    },
    as_of: asOf,
  };
}

/** node_detail: 节点详情(含证据) */
export async function universeNodeDetail(input: {
  kind: UniverseNodeKind;
  nodeId: string;
  sourceId?: string;
}): Promise<UniverseNodeDetail | null> {
  if (input.kind === "event") {
    const r = await pool.query(
      `select e.*, s.name as source_name, d.name as document_name
       from events e
       left join sources s on s.id = e.source_id
       left join documents d on d.id = e.document_id
       where e.id = $1`,
      [input.nodeId],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      id: String(row.id),
      kind: "event",
      source_id: row.source_id ? String(row.source_id) : "",
      source_name: row.source_name ? String(row.source_name) : "",
      label: String(row.title ?? ""),
      description: String(row.summary ?? ""),
      category: String(row.category ?? ""),
      start_time: row.start_time ? new Date(row.start_time).toISOString() : null,
      evidence: {
        source_id: row.source_id ? String(row.source_id) : "",
        source_name: row.source_name ? String(row.source_name) : "",
        document_id: row.document_id ? String(row.document_id) : null,
        document_name: row.document_name ? String(row.document_name) : null,
        chunk_id: row.chunk_id ? String(row.chunk_id) : null,
        heading: String(row.title ?? ""),
        content: String(row.content ?? "").slice(0, 2_000),
      },
    };
  }
  const r = await pool.query(
    `select ent.*, s.name as source_name
     from entities ent
     left join sources s on s.id = ent.source_id
     where ent.id = $1`,
    [input.nodeId],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: String(row.id),
    kind: "entity",
    source_id: row.source_id ? String(row.source_id) : "",
    source_name: row.source_name ? String(row.source_name) : "",
    label: String(row.name ?? ""),
    description: String(row.description ?? ""),
    category: String(row.type ?? ""),
    start_time: null,
    evidence: null,
  };
}

const rebuildJobs = new Map<
  string,
  { status: string; progress: number; error: string | null; created_at: string }
>();

/** rebuild: 后台重建统计(轻量: 后台推进状态) */
export async function universeRebuild(): Promise<{
  id: string;
  type: string;
  status: string;
  source_id: string | null;
  document_id: string | null;
  progress: number;
  attempts: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}> {
  const id = `rebuild-${nextEpoch()}-${Date.now().toString(36)}`;
  rebuildJobs.set(id, {
    status: "running",
    progress: 0.1,
    error: null,
    created_at: new Date().toISOString(),
  });
  void (async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    rebuildJobs.set(id, {
      status: "succeeded",
      progress: 1,
      error: null,
      created_at: new Date().toISOString(),
    });
  })();
  return {
    id,
    type: "universe-rebuild",
    status: "running",
    source_id: null,
    document_id: null,
    progress: 0.1,
    attempts: 1,
    error: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
  };
}

/** job 查询: rebuild 任务状态 */
export async function universeJob(id: string) {
  const job = rebuildJobs.get(id);
  if (!job) return null;
  return {
    id,
    type: "universe-rebuild",
    status: job.status,
    source_id: null,
    document_id: null,
    progress: job.progress,
    attempts: 1,
    error: job.error,
    created_at: job.created_at,
    started_at: job.created_at,
    finished_at: job.status === "succeeded" ? new Date().toISOString() : null,
  };
}

/** 实体搜索: 按名称模糊匹配, 返回事件数排序的前 N 条 */
export async function universeSearchEntities(input: {
  q: string;
  sourceId?: string;
  limit?: number;
}) {
  const q = (input.q ?? "").trim();
  if (!q) return { entities: [] };
  const limit = Math.max(1, Math.min(input.limit ?? 30, 100));
  const sourceFilter = input.sourceId ? "and ent.source_id = $2" : "";
  const params: unknown[] = input.sourceId
    ? [`%${q}%`, input.sourceId, limit]
    : [`%${q}%`, limit];
  const r = await pool.query(
    `select ent.id, ent.name, ent.type,
            (select count(*) from event_entities ee where ee.entity_id = ent.id) as event_count
     from entities ent
     where ent.name ilike $1
     ${sourceFilter}
     order by event_count desc
     limit $${input.sourceId ? 3 : 2}`,
    params,
  );
  return {
    entities: r.rows.map((row: any) => ({
      id: String(row.id),
      name: String(row.name ?? ""),
      type: String(row.type ?? ""),
      source_id: row.source_id ? String(row.source_id) : undefined,
      event_count: Number(row.event_count ?? 0),
    })),
  };
}

/** 三源状态: PG / Graphiti(11001) / Cognee(11003) 在线检测 + 规模 */
export async function universeDataSources() {
  const [events, entities] = await Promise.all([
    pool.query(`select count(*) as c from events where deleted_at is null`),
    pool.query(`select count(*) as c from entities`),
  ]);
  const sources: Array<{
    id: string;
    label: string;
    type: "pg" | "graphiti" | "cognee";
    online: boolean;
    nodes?: number;
    events?: number;
    entities?: number;
  }> = [
    {
      id: "pg",
      label: "PG 图谱(SAG 入库)",
      type: "pg",
      online: true,
      events: Number(events.rows[0]?.c ?? 0),
      entities: Number(entities.rows[0]?.c ?? 0),
    },
    { id: "graphiti", label: "Graphiti(11001)", type: "graphiti", online: false },
    { id: "cognee", label: "Cognee(11003)", type: "cognee", online: false },
  ];
  // 探测 Graphiti/Cognee
  for (const [idx, port, key] of [[1, 11001, "graphiti"], [2, 11003, "cognee"]] as const) {
    try {
      const r = await neo4jQuery(port, "MATCH (n) RETURN count(n) AS c LIMIT 1", {}, 8000);
      sources[idx].online = true;
      sources[idx].nodes = Number((r[0] as any)?.c ?? 0);
    } catch {
      // 离线
    }
  }
  return { sources };
}

/** Graphiti 实体搜索(按 name 前缀)+ 邻居查询 */
export async function universeGraphitiQuery(input: {
  q?: string;
  name?: string;
  limit?: number;
}) {
  const limit = Math.max(1, Math.min(input.limit ?? 30, 100));
  if (!input.q && !input.name) {
    // 热门实体(出边最多的)
    const r = await neo4jQuery(
      11001,
      `MATCH (e:Entity)-[rel]->()
       RETURN e.name AS name, count(rel) AS cnt
       ORDER BY cnt DESC LIMIT $limit`,
      { limit: Math.floor(limit) },
      15000,
    );
    return { entities: r.map((row) => ({ name: String(row.name ?? "") })) };
  }
  if (input.q) {
    const r = await neo4jQuery(
      11001,
      `MATCH (e:Entity) WHERE e.name CONTAINS $q
       RETURN e.name AS name LIMIT $limit`,
      { q: input.q, limit: Math.floor(limit) },
      15000,
    );
    return { entities: r.map((row) => ({ name: String(row.name ?? ""), event_count: 0 })) };
  }
  if (input.name) {
    const r = await neo4jQuery(
      11001,
      `MATCH (e:Entity {name: $name})-[rel]-(n)
       WHERE n:Entity AND n.name IS NOT NULL AND n.name <> $name
       RETURN DISTINCT n.name AS name, type(rel) AS rel
       LIMIT $limit`,
      { name: input.name, limit: Math.floor(limit) },
      15000,
    );
    const seen = new Set<string>();
    const entities: Array<{ name: string; rel?: string }> = [];
    const edges: Array<{ from: string; to: string; rel: string }> = [];
    for (const row of r) {
      const name = String(row.name ?? "");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const rel = String(row.rel ?? "关联");
      entities.push({ name, rel });
      edges.push({ from: input.name, to: name, rel });
    }
    return { entities, edges };
  }
  return { entities: [], edges: [] };
}

/** Graphiti 超边: 查询实体所在社区(Community 节点) */
export async function universeGraphitiCommunity(name: string) {
  const r = await neo4jQuery(
    11001,
    `MATCH (e:Entity {name: $name})-[:INVOLVED_IN]->(he:HyperEdge)
     OPTIONAL MATCH (he)<-[:CONTAINS]-(c:Community)
     RETURN DISTINCT c.id AS community_id, c.title AS community_title
     LIMIT 5`,
    { name },
    15000,
  );
  return r.map((row) => ({
    id: row.community_id !== undefined ? String(row.community_id) : undefined,
    title: row.community_title !== undefined ? String(row.community_title) : undefined,
  }));
}

/** Cognee 实体搜索(按 name 前缀)+ 邻居查询 */
export async function universeCogneeQuery(input: {
  q?: string;
  name?: string;
  limit?: number;
}) {
  const limit = Math.max(1, Math.min(input.limit ?? 30, 100));
  if (!input.q && !input.name) {
    // 热门实体(关系最多的)
    const r = await neo4jQuery(
      11003,
      `MATCH (e:Entity)-[rel]-()
       RETURN e.name AS name, count(rel) AS cnt
       ORDER BY cnt DESC LIMIT $limit`,
      { limit: Math.floor(limit) },
      15000,
    );
    return { entities: r.map((row) => ({ name: String(row.name ?? "") })) };
  }
  if (input.q) {
    const r = await neo4jQuery(
      11003,
      `MATCH (e:Entity) WHERE e.name CONTAINS $q
       RETURN e.name AS name LIMIT $limit`,
      { q: input.q, limit: Math.floor(limit) },
      15000,
    );
    return { entities: r.map((row) => ({ name: String(row.name ?? "") })) };
  }
  if (input.name) {
    const r = await neo4jQuery(
      11003,
      `MATCH (e:Entity {name: $name})-[rel]-(n)
       WHERE n:Entity AND n.name IS NOT NULL AND n.name <> $name
       RETURN DISTINCT n.name AS name, type(rel) AS rel
       LIMIT $limit`,
      { name: input.name, limit: Math.floor(limit) },
      15000,
    );
    const entities: Array<{ name: string; rel?: string }> = [];
    const edges: Array<{ from: string; to: string; rel: string }> = [];
    for (const row of r) {
      const name = String(row.name ?? "");
      const rel = String(row.rel ?? "关联");
      entities.push({ name, rel });
      edges.push({ from: input.name, to: name, rel });
    }
    return { entities, edges };
  }
  return { entities: [], edges: [] };
}
