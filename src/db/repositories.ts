// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// Based on Zleap-AI/SAG (MIT License) — https://github.com/Zleap-AI/SAG
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool } from "./pool.js";
import { toVectorLiteral } from "./vector.js";
import { config } from "../config/env.js";
import type {
  ChunkRecord,
  DocumentRecord,
  EntityRecord,
  EntityDetailRecord,
  EntityWithEventsRecord,
  EventRecord,
  EventDetailRecord,
  EmbeddingPreview,
  AiProviderSettingsRecord,
  McpMessageRecord,
  McpMessageRole,
  McpSessionRecord,
  McpToolCallRecord,
  ProjectGraphEntityRecord,
  ProjectGraphEventRecord,
  ProjectGraphRecord,
  ProjectStatsRecord,
  SourceRecord,
  IngestProgressStage
} from "../types.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

function db(client?: Queryable): Queryable {
  return client ?? pool;
}

function sourceFromRow(row: Record<string, unknown>): SourceRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    archivedAt: row.archived_at == null ? null : new Date(String(row.archived_at)).toISOString(),
    createdAt: row.created_at == null ? undefined : new Date(String(row.created_at)).toISOString(),
    updatedAt: row.updated_at == null ? undefined : new Date(String(row.updated_at)).toISOString()
  };
}

function eventFromRow(row: Record<string, unknown>): EventRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    chunkId: row.chunk_id == null ? null : String(row.chunk_id),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    content: String(row.content ?? ""),
    rank: Number(row.rank ?? 0),
    score: row.score == null ? undefined : Number(row.score),
    createdAt: row.created_at == null ? undefined : new Date(String(row.created_at)).toISOString(),
    titleEmbedding: embeddingPreviewFromText(row.title_embedding_preview),
    contentEmbedding: embeddingPreviewFromText(row.content_embedding_preview)
  };
}

function entityFromRow(row: Record<string, unknown>): EntityRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    type: String(row.type),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    score: row.score == null ? undefined : Number(row.score),
    embedding: embeddingPreviewFromText(row.embedding_preview)
  };
}

function documentFromRow(row: Record<string, unknown>): DocumentRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    title: String(row.title),
    status: String(row.status),
    parseStatus: String(row.parse_status),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    archivedAt: row.archived_at == null ? null : new Date(String(row.archived_at)).toISOString()
  };
}

function chunkFromRow(row: Record<string, unknown>): ChunkRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    heading: row.heading == null ? null : String(row.heading),
    content: String(row.content),
    rawContent: row.raw_content == null ? null : String(row.raw_content),
    rank: Number(row.rank ?? 0),
    references: Array.isArray(row.references) ? row.references.map(String) : [],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    embedding: embeddingPreviewFromText(row.embedding_preview)
  };
}

function embeddingPreviewFromText(value: unknown): EmbeddingPreview | null | undefined {
  if (value == null) {
    return undefined;
  }
  const numbers = String(value)
    .match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)
    ?.map(Number)
    .filter((item) => Number.isFinite(item)) ?? [];
  if (numbers.length === 0) {
    return null;
  }
  return {
    dimensions: numbers.length,
    sample: numbers.slice(0, 8)
  };
}

function mcpSessionFromRow(row: Record<string, unknown>): McpSessionRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    title: String(row.title),
    status: String(row.status),
    model: row.model == null ? null : String(row.model),
    sourceIds: Array.isArray(row.source_ids) ? row.source_ids.map(String) : [],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    kind: (row.kind ?? "project") as "project" | "chat"
  };
}

function mcpMessageFromRow(row: Record<string, unknown>): McpMessageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role: String(row.role) as McpMessageRole,
    content: String(row.content),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    images: Array.isArray(row.images) ? row.images as McpMessageRecord["images"] : null
  };
}

function mcpToolCallFromRow(row: Record<string, unknown>): McpToolCallRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    toolName: String(row.tool_name),
    arguments: (row.arguments ?? {}) as Record<string, unknown>,
    result: row.result,
    status: String(row.status) as McpToolCallRecord["status"],
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    error: row.error == null ? null : String(row.error),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function aiProviderSettingsFromRow(row: Record<string, unknown>): AiProviderSettingsRecord {
  return {
    id: "global",
    embeddingBaseUrl: String(row.embedding_base_url),
    embeddingModel: String(row.embedding_model),
    embeddingDimensions: Number(row.embedding_dimensions),
    embeddingApiKey: row.embedding_api_key == null ? null : String(row.embedding_api_key),
    llmBaseUrl: String(row.llm_base_url),
    llmModel: String(row.llm_model),
    llmApiKey: row.llm_api_key == null ? null : String(row.llm_api_key),
    llmTimeoutMs: Number(row.llm_timeout_ms),
    llmMaxRetries: Number(row.llm_max_retries),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

export async function createSource(input: {
  id?: string;
  tenantId: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}, client?: Queryable): Promise<SourceRecord> {
  const id = input.id ?? randomUUID();
  const result = await db(client).query(
    `
      insert into sources (id, tenant_id, name, description, metadata)
      values ($1, $2, $3, $4, $5::jsonb)
      on conflict (id) do update set
        name = sources.name,
        description = sources.description,
        metadata = sources.metadata || excluded.metadata,
        updated_at = now()
      returning *
    `,
    [id, input.tenantId, input.name, input.description ?? null, JSON.stringify(input.metadata ?? {})]
  );
  return sourceFromRow(result.rows[0]);
}

export async function getSource(sourceId: string, tenantId: string): Promise<SourceRecord | null> {
  const result = await pool.query(
    "select * from sources where id = $1 and tenant_id = $2",
    [sourceId, tenantId]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function listSources(input: {
  tenantId: string;
  limit: number;
  cursor?: string;
  includeArchived?: boolean;
}): Promise<SourceRecord[]> {
  const params: unknown[] = [input.tenantId, input.limit];
  let cursorSql = "";
  if (input.cursor) {
    params.push(input.cursor);
    cursorSql = "and id::text > $3";
  }
  const archiveSql = input.includeArchived ? "" : "and archived_at is null";
  const result = await pool.query(
    `
      select *
      from sources
      where tenant_id = $1 ${archiveSql} ${cursorSql}
      order by id
      limit $2
    `,
    params
  );
  return result.rows.map(sourceFromRow);
}

export async function updateSource(input: {
  sourceId: string;
  tenantId: string;
  name?: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<SourceRecord | null> {
  const result = await pool.query(
    `
      update sources
      set
        name = coalesce($3, name),
        description = case when $4::boolean then $5 else description end,
        metadata = metadata || $6::jsonb,
        updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [
      input.sourceId,
      input.tenantId,
      input.name?.trim() || null,
      Object.prototype.hasOwnProperty.call(input, "description"),
      input.description ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function archiveSource(input: {
  sourceId: string;
  tenantId: string;
}): Promise<SourceRecord | null> {
  const result = await pool.query(
    `
      update sources
      set archived_at = coalesce(archived_at, now()), updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [input.sourceId, input.tenantId]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function restoreSource(input: {
  sourceId: string;
  tenantId: string;
}): Promise<SourceRecord | null> {
  const result = await pool.query(
    `
      update sources
      set archived_at = null, updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [input.sourceId, input.tenantId]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function deleteSource(input: {
  sourceId: string;
  tenantId: string;
}): Promise<boolean> {
  const result = await pool.query(
    "delete from sources where id = $1 and tenant_id = $2",
    [input.sourceId, input.tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function assertSourcesAccessible(sourceIds: string[], tenantId: string): Promise<void> {
  if (sourceIds.length === 0) {
    throw new Error("sourceIds must not be empty");
  }
  // V399: 公共库(PUBLIC_TENANT)资源对本机/默认租户也可见 — 检索 501 篇文献资产不因租户隔离不可达
  const accessibleTenants = tenantId === "00000000-0000-0000-0000-000000000001" || tenantId === "default"
    ? ["default", "00000000-0000-0000-0000-000000000001"]
    : [tenantId];
  const result = await pool.query(
    "select id from sources where tenant_id = any($1::text[]) and archived_at is null and id = any($2::uuid[])",
    [accessibleTenants, sourceIds]
  );
  const found = new Set(result.rows.map((row) => String(row.id)));
  const missing = sourceIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`source not found or not accessible: ${missing.join(",")}`);
  }
}

export async function getDefaultEntityType(type: string, client?: Queryable): Promise<string | null> {
  const result = await db(client).query(
    `
      select id
      from entity_types
      where type = $1 and is_active = true
      order by is_default desc
      limit 1
    `,
    [type]
  );
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

export async function getAnyDefaultEntityType(client?: Queryable): Promise<string> {
  const result = await db(client).query(
    `
      select id
      from entity_types
      where is_active = true
      order by case when type = 'subject' then 0 else 1 end, is_default desc
      limit 1
    `
  );
  if (!result.rows[0]?.id) {
    throw new Error("entity_types seed data is missing; run npm run seed");
  }
  return String(result.rows[0].id);
}

export async function upsertEntity(input: {
  sourceId: string;
  type: string;
  name: string;
  description?: string;
  embedding: number[];
}, client?: Queryable): Promise<EntityRecord> {
  const normalizedName = input.name.trim().toLowerCase();
  const entityTypeId = (await getDefaultEntityType(input.type, client)) ?? await getAnyDefaultEntityType(client);
  const result = await db(client).query(
    `
      insert into entities (
        id, source_id, entity_type_id, type, name, normalized_name, description, embedding
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::vector)
      on conflict (source_id, type, normalized_name) do update set
        name = excluded.name,
        description = coalesce(nullif(entities.description, ''), excluded.description),
        embedding = coalesce(entities.embedding, excluded.embedding),
        updated_at = now()
      returning *
    `,
    [
      randomUUID(),
      input.sourceId,
      entityTypeId,
      input.type,
      input.name,
      normalizedName,
      input.description ?? "",
      toVectorLiteral(input.embedding)
    ]
  );
  return entityFromRow(result.rows[0]);
}

export async function searchEntitiesByVector(input: {
  sourceIds: string[];
  queryVector: number[];
  topK: number;
  threshold: number;
}): Promise<EntityRecord[]> {
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             1 - (ent.embedding <=> $1::vector) as score
      from entities ent
      where ent.source_id = any($2::uuid[])
        and ent.embedding is not null
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
      order by ent.embedding <=> $1::vector
      limit $3
    `,
    [toVectorLiteral(input.queryVector), input.sourceIds, input.topK]
  );
  return result.rows
    .map(entityFromRow)
    .filter((entity) => (entity.score ?? 0) >= input.threshold);
}

export async function searchEntitiesByName(input: {
  sourceIds: string[];
  names: string[];
  limit: number;
}): Promise<EntityRecord[]> {
  if (input.names.length === 0) {
    return [];
  }
  const normalizedNames = input.names.map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (normalizedNames.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name, 1.0 as score
      from entities ent
      where ent.source_id = any($1::uuid[])
        and exists (
          select 1
          from unnest($2::text[]) as query_name(name)
          where ent.normalized_name = query_name.name
             or ent.normalized_name % query_name.name
        )
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
      limit $3
    `,
    [input.sourceIds, normalizedNames, input.limit]
  );
  return result.rows.map(entityFromRow);
}

export async function searchEntitiesByText(input: {
  sourceIds: string[];
  query: string;
  limit: number;
}): Promise<EntityRecord[]> {
  const query = input.query.trim();
  if (!query) {
    return [];
  }
  const result = await pool.query(
    `
      with q as (
        select
          websearch_to_tsquery('simple', $2) as tsq,
          lower($2) as raw_query
      )
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             greatest(
               coalesce(ts_rank_cd(ent.search_text, q.tsq), 0),
               similarity(ent.normalized_name, q.raw_query),
               case when q.raw_query like '%' || ent.normalized_name || '%' then 1.0 else 0 end,
               case when ent.normalized_name = q.raw_query then 1.2 else 0 end
             ) as score
      from entities ent
      cross join q
      where ent.source_id = any($1::uuid[])
        and (
          ent.search_text @@ q.tsq
          or ent.normalized_name % q.raw_query
          or q.raw_query like '%' || ent.normalized_name || '%'
        )
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
      order by score desc, ent.name
      limit $3
    `,
    [input.sourceIds, query, input.limit]
  );
  return result.rows.map(entityFromRow);
}

export async function getEventIdsByEntityIds(input: {
  entityIds: string[];
  sourceIds: string[];
  excludeEventIds?: string[];
}): Promise<string[]> {
  if (input.entityIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select distinct ee.event_id
      from event_entities ee
      join events e on e.id = ee.event_id
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where ee.entity_id = any($1::uuid[])
        and e.source_id = any($2::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and not (ee.event_id = any($3::uuid[]))
    `,
    [input.entityIds, input.sourceIds, input.excludeEventIds ?? []]
  );
  return result.rows.map((row) => String(row.event_id));
}

/**
 * ② Compiled Truth（GBrain 步6）— 检索知识页沉淀结论
 * 按 query 关键词匹配 knowledge_pages 的 title/compiled_truth，返回作为检索增强
 * 语义：知识页是「已沉淀结论」，命中时 ×2.0 boost（与 GBrain compiled_truth boost 一致）
 */
export async function searchCompiledTruth(input: {
  query: string;
  limit: number;
}): Promise<Array<{ id: string; title: string; compiledTruth: string }>> {
  if (!input.query || input.query.trim().length < 2) {
    return [];
  }
  try {
    const words = input.query
      .replace(/[？?。，,、；;：:！!（）\(\)"「」『』《》【】\[\]{}''\s]/g, " ")
      .split(" ")
      .filter((w: string) => w.length >= 2)
      .slice(0, 6);
    if (words.length === 0) {
      return [];
    }
    const likeClauses = words.map((_, i: number) => `(title ILIKE $${i + 1} OR compiled_truth ILIKE $${i + 1})`).join(" OR ");
    const result = await pool.query(
      `select id, title, compiled_truth from knowledge_pages
       where ${likeClauses} and compiled_truth != '' order by updated_at desc limit $${words.length + 1}`,
      [...words.map((w: string) => `%${w}%`), input.limit]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      compiledTruth: String(row.compiled_truth)
    }));
  } catch {
    return [];
  }
}

/**
 * ⑤ Graph traversal（GBrain 步8）— SQL 递归 CTE 2 层：
 * 种子实体 → 关联事件 → 事件其它实体 → 其它实体的事件（2 层内闭环）
 * 返回事件 id + 实体 id，供 search-service 直接取切片/提升排序
 */
export async function graphTraversalTwoHops(input: {
  seedEntityIds: string[];
  sourceIds: string[];
  maxEvents: number;
}): Promise<{ eventIds: string[]; entityIds: string[] }> {
  if (input.seedEntityIds.length === 0) {
    return { eventIds: [], entityIds: [] };
  }
  const result = await pool.query(
    `
      with recursive seed_events as (
        select distinct ee.event_id, 1 as depth
        from event_entities ee
        join events e on e.id = ee.event_id
        where ee.entity_id = any($1::uuid[])
          and e.source_id = any($2::uuid[])
          and e.deleted_at is null
      ),
      hop1_entities as (
        select distinct ee.entity_id, se.depth + 1 as depth
        from seed_events se
        join event_entities ee on ee.event_id = se.event_id
        where se.depth <= 2
      ),
      hop2_events as (
        select distinct ee.event_id, he.depth + 1 as depth
        from hop1_entities he
        join event_entities ee on ee.entity_id = he.entity_id
        where he.depth <= 2
      )
      select
        (select array_agg(distinct event_id) from seed_events) as event_ids,
        (select array_agg(distinct entity_id) from hop1_entities) as entity_ids
    `,
    [input.seedEntityIds, input.sourceIds]
  );
  const row = result.rows[0] ?? {};
  const eventIds = (row.event_ids ?? []).filter((id: unknown): id is string => typeof id === "string").slice(0, input.maxEvents);
  const entityIds = (row.entity_ids ?? []).filter((id: unknown): id is string => typeof id === "string");
  return { eventIds, entityIds };
}

export async function searchEventsByTitleVector(input: {
  sourceIds: string[];
  queryVector: number[];
  topK: number;
  threshold: number;
}): Promise<EventRecord[]> {
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             1 - (e.title_embedding <=> $1::vector) as score
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.source_id = any($2::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and e.title_embedding is not null
      order by e.title_embedding <=> $1::vector
      limit $3
    `,
    [toVectorLiteral(input.queryVector), input.sourceIds, input.topK]
  );
  return result.rows
    .map(eventFromRow)
    .filter((event) => (event.score ?? 0) >= input.threshold);
}

export async function coarseRankEventsByContent(input: {
  sourceIds: string[];
  eventIds: string[];
  queryVector: number[];
  maxEvents: number;
}): Promise<EventRecord[]> {
  if (input.eventIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             e.created_at,
             1 - (e.content_embedding <=> $1::vector) as score
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.id = any($2::uuid[])
        and e.source_id = any($3::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and e.content_embedding is not null
      order by e.content_embedding <=> $1::vector
      limit $4
    `,
    [toVectorLiteral(input.queryVector), input.eventIds, input.sourceIds, input.maxEvents]
  );
  return result.rows.map(eventFromRow);
}

/**
 * searchEventsByText — 事件 BM25 文本召回臂（RRF 融合的第三臂）
 * 用 events.search_text 生成列（title+summary+content 的 tsvector）做全文检索
 */
export async function searchEventsByText(input: {
  sourceIds: string[];
  eventIds: string[];
  query: string;
  limit: number;
}): Promise<EventRecord[]> {
  if (input.eventIds.length === 0 || !input.query.trim()) {
    return [];
  }
  const result = await pool.query(
    `
      with q as (
        select websearch_to_tsquery('simple', $1) as tsq
      )
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             e.created_at,
             ts_rank_cd(e.search_text, q.tsq) as score
      from events e
      cross join q
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.id = any($2::uuid[])
        and e.source_id = any($3::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and e.search_text @@ q.tsq
      order by ts_rank_cd(e.search_text, q.tsq) desc
      limit $4
    `,
    [input.query, input.eventIds, input.sourceIds, input.limit]
  );
  return result.rows.map(eventFromRow);
}

export async function getEventsWithEntityIds(eventIds: string[]): Promise<Map<string, EventRecord & { entityIds: string[] }>> {
  const map = new Map<string, EventRecord & { entityIds: string[] }>();
  if (eventIds.length === 0) {
    return map;
  }
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             coalesce(array_agg(ee.entity_id) filter (where ee.entity_id is not null), '{}') as entity_ids
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      left join event_entities ee on ee.event_id = e.id
      where e.id = any($1::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
      group by e.id
    `,
    [eventIds]
  );
  for (const row of result.rows) {
    const event = eventFromRow(row) as EventRecord & { entityIds: string[] };
    event.entityIds = (row.entity_ids ?? []).map(String);
    map.set(event.id, event);
  }
  return map;
}

export async function getSectionsForEvents(eventIds: string[]): Promise<Array<{
  eventId: string;
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank: number;
  sourceType?: string;
}>> {
  if (eventIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select e.id as event_id, c.id as chunk_id, c.source_id, c.document_id,
             c.heading, c.content, c.rank, c.source_type
      from events e
      join source_chunks c on c.id = e.chunk_id
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.id = any($1::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
      order by array_position($1::uuid[], e.id), c.rank
    `,
    [eventIds]
  );
  return result.rows.map((row) => ({
    eventId: String(row.event_id),
    chunkId: String(row.chunk_id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? undefined : String(row.document_id),
    heading: row.heading == null ? undefined : String(row.heading),
    content: String(row.content),
    rank: Number(row.rank),
    sourceType: row.source_type == null ? undefined : String(row.source_type)
  }));
}

export async function searchChunksByVector(input: {
  sourceIds: string[];
  queryVector: number[];
  topK: number;
}): Promise<Array<{
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank: number;
  score: number;
}>> {
  const result = await pool.query(
    `
      select c.id, c.source_id, c.document_id, c.heading, c.content, c.rank,
             1 - (c.embedding <=> $1::vector) as score
      from source_chunks c
      join documents d on d.id = c.document_id
      join sources s on s.id = c.source_id
      where c.source_id = any($2::uuid[])
        and c.embedding is not null
        and d.archived_at is null
        and s.archived_at is null
      order by c.embedding <=> $1::vector
      limit $3
    `,
    [toVectorLiteral(input.queryVector), input.sourceIds, input.topK]
  );
  return result.rows.map((row) => ({
    chunkId: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? undefined : String(row.document_id),
    heading: row.heading == null ? undefined : String(row.heading),
    content: String(row.content),
    rank: Number(row.rank),
    score: Number(row.score)
  }));
}

export async function getEventDetail(input: {
  eventId: string;
  tenantId: string;
  includeArchived?: boolean;
}): Promise<EventDetailRecord | null> {
  const archiveSql = input.includeArchived
    ? ""
    : "and s.archived_at is null and (d.id is null or d.archived_at is null)";
  // V392修复: 公共库对所有用户可见（放宽租户过滤）
  const PUBLIC_TENANT = "00000000-0000-0000-0000-000000000001";
  const eventResult = await pool.query(
    `
      select
        e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
        d.id as document_id_for_detail,
        d.title as document_title,
        d.status as document_status,
        d.parse_status as document_parse_status,
        d.metadata as document_metadata,
        d.created_at as document_created_at,
        d.updated_at as document_updated_at,
        d.archived_at as document_archived_at,
        s.id as source_id_for_detail,
        s.tenant_id as source_tenant_id,
        s.name as source_name,
        s.description as source_description,
        s.metadata as source_metadata,
        s.archived_at as source_archived_at,
        s.created_at as source_created_at,
        s.updated_at as source_updated_at
      from events e
      join sources s on s.id = e.source_id
      left join documents d on d.id = e.document_id
      where e.id = $1
        and (s.tenant_id = $2 or s.tenant_id = $3)
        and e.deleted_at is null
        ${archiveSql}
    `,
    [input.eventId, input.tenantId, PUBLIC_TENANT]
  );
  if (!eventResult.rows[0]) {
    return null;
  }
  const event = eventFromRow(eventResult.rows[0]);
  const entityResult = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name
      from event_entities ee
      join entities ent on ent.id = ee.entity_id
      join sources s on s.id = ent.source_id
      where ee.event_id = $1
        and (s.tenant_id = $2 or s.tenant_id = $3)
      order by ent.type, ent.name
    `,
    [input.eventId, input.tenantId, PUBLIC_TENANT]
  );
  const chunkResult = event.chunkId
    ? await pool.query(
        `
          select c.id, c.source_id, c.document_id, c.heading, c.content, c.rank
          from source_chunks c
          join sources s on s.id = c.source_id
          left join documents d on d.id = c.document_id
          where c.id = $1
            and (s.tenant_id = $2 or s.tenant_id = $3)
            ${archiveSql}
        `,
        [event.chunkId, input.tenantId, PUBLIC_TENANT]
      )
    : { rows: [] };
  const row = eventResult.rows[0] as Record<string, unknown>;

  return {
    event,
    entities: entityResult.rows.map(entityFromRow),
    source: row.source_id_for_detail == null
      ? null
      : sourceFromRow({
          id: row.source_id_for_detail,
          tenant_id: row.source_tenant_id,
          name: row.source_name,
          description: row.source_description,
          metadata: row.source_metadata,
          archived_at: row.source_archived_at,
          created_at: row.source_created_at,
          updated_at: row.source_updated_at
        }),
    document: row.document_id_for_detail == null
      ? null
      : documentFromRow({
          id: row.document_id_for_detail,
          source_id: row.source_id_for_detail,
          title: row.document_title,
          status: row.document_status,
          parse_status: row.document_parse_status,
          metadata: row.document_metadata,
          created_at: row.document_created_at,
          updated_at: row.document_updated_at,
          archived_at: row.document_archived_at
        }),
    chunk: chunkResult.rows[0]
      ? {
          chunkId: String(chunkResult.rows[0].id),
          sourceId: String(chunkResult.rows[0].source_id),
          documentId: chunkResult.rows[0].document_id == null ? null : String(chunkResult.rows[0].document_id),
          heading: chunkResult.rows[0].heading == null ? undefined : String(chunkResult.rows[0].heading),
          content: String(chunkResult.rows[0].content),
          rank: Number(chunkResult.rows[0].rank ?? 0)
        }
      : undefined
  };
}

export async function listDocumentsBySource(input: {
  sourceId: string;
  tenantId: string;
  limit: number;
  includeArchived?: boolean;
}): Promise<DocumentRecord[]> {
  const archiveSql = input.includeArchived ? "" : "and d.archived_at is null";
  // V392修复: 公共库(00000000-...-0001)对所有用户可见 — 租户过滤放宽为「公共租户 OR 指定租户」
  const PUBLIC_TENANT = "00000000-0000-0000-0000-000000000001";
  const result = await pool.query(
    `
      select d.*
      from documents d
      join sources s on s.id = d.source_id
      where d.source_id = $1 and (s.tenant_id = $2 or s.tenant_id = $3) ${archiveSql}
      order by d.created_at desc, d.id
      limit $4
    `,
    [input.sourceId, input.tenantId, PUBLIC_TENANT, input.limit]
  );
  return result.rows.map(documentFromRow);
}

export async function updateDocument(input: {
  documentId: string;
  tenantId: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): Promise<DocumentRecord | null> {
  const result = await pool.query(
    `
      update documents d
      set
        title = coalesce($3, d.title),
        metadata = d.metadata || $4::jsonb,
        updated_at = now()
      from sources s
      where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      returning d.*
    `,
    [
      input.documentId,
      input.tenantId,
      input.title?.trim() || null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ? documentFromRow(result.rows[0]) : null;
}

export async function archiveDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<DocumentRecord | null> {
  const result = await pool.query(
    `
      update documents d
      set archived_at = coalesce(d.archived_at, now()), updated_at = now()
      from sources s
      where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      returning d.*
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows[0] ? documentFromRow(result.rows[0]) : null;
}

export async function restoreDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<DocumentRecord | null> {
  const result = await pool.query(
    `
      update documents d
      set archived_at = null, updated_at = now()
      from sources s
      where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      returning d.*
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows[0] ? documentFromRow(result.rows[0]) : null;
}

export async function deleteDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const documentResult = await client.query(
      `
        select d.id
        from documents d
        join sources s on s.id = d.source_id
        where d.id = $1 and s.tenant_id = $2
        for update
      `,
      [input.documentId, input.tenantId]
    );
    if (!documentResult.rows[0]) {
      await client.query("rollback");
      return false;
    }

    await client.query(
      `
        with document_events as (
          select id
          from events
          where document_id = $1
        ),
        candidate_entities as (
          select distinct ee.entity_id
          from event_entities ee
          join document_events de on de.id = ee.event_id
        ),
        shared_entities as (
          select distinct ee.entity_id
          from event_entities ee
          join events e on e.id = ee.event_id
          where ee.entity_id in (select entity_id from candidate_entities)
            and (e.document_id is distinct from $1)
        )
        delete from entities ent
        where ent.id in (select entity_id from candidate_entities)
          and ent.id not in (select entity_id from shared_entities)
      `,
      [input.documentId]
    );

    await client.query(
      `
        delete from documents d
        using sources s
        where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      `,
      [input.documentId, input.tenantId]
    );
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getProjectStats(input: {
  sourceId: string;
  tenantId: string;
}): Promise<ProjectStatsRecord> {
  // V392修复: 公共库对所有用户可见（放宽租户过滤）
  const PUBLIC_TENANT = "00000000-0000-0000-0000-000000000001";
  const result = await pool.query(
    `
      select
        count(distinct d.id)::int as document_count,
        count(distinct c.id)::int as chunk_count,
        count(distinct e.id)::int as event_count,
        count(distinct ent.id)::int as entity_count
      from sources s
      left join documents d
        on d.source_id = s.id
       and d.archived_at is null
      left join source_chunks c
        on c.document_id = d.id
      left join events e
        on e.document_id = d.id
       and e.deleted_at is null
      left join event_entities ee
        on ee.event_id = e.id
      left join entities ent
        on ent.id = ee.entity_id
      where s.id = $1
        and (s.tenant_id = $2 or s.tenant_id = $3)
      group by s.id
    `,
    [input.sourceId, input.tenantId, PUBLIC_TENANT]
  );
  const row = result.rows[0];
  return {
    documentCount: Number(row?.document_count ?? 0),
    chunkCount: Number(row?.chunk_count ?? 0),
    eventCount: Number(row?.event_count ?? 0),
    entityCount: Number(row?.entity_count ?? 0)
  };
}

export async function getProjectGraph(input: {
  sourceId: string;
  tenantId: string;
}): Promise<ProjectGraphRecord> {
  // V392修复: 公共库对所有用户可见（放宽租户过滤）
  const PUBLIC_TENANT = "00000000-0000-0000-0000-000000000001";
  const entitiesResult = await pool.query(
    `
      select
        ent.id,
        ent.source_id,
        ent.type,
        ent.name,
        ent.normalized_name,
        count(distinct e.id)::int as event_count
      from entities ent
      join event_entities ee on ee.entity_id = ent.id
      join events e on e.id = ee.event_id
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where ent.source_id = $1
        and (s.tenant_id = $2 or s.tenant_id = $3)
        and d.archived_at is null
        and e.deleted_at is null
      group by ent.id
      order by event_count desc, ent.type, ent.name
    `,
    [input.sourceId, input.tenantId, PUBLIC_TENANT]
  );

  const entities: ProjectGraphEntityRecord[] = entitiesResult.rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    type: String(row.type),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    eventCount: Number(row.event_count ?? 0)
  }));

  if (entities.length === 0) {
    return { entities: [], events: [], edges: [] };
  }

  const entityIds = entities.map((entity) => entity.id);
  const eventsResult = await pool.query(
    `
      select
        e.id,
        e.source_id,
        e.document_id,
        e.title,
        e.rank,
        coalesce(
          array_agg(ee.entity_id order by ent.name) filter (where ee.entity_id is not null),
          '{}'
        ) as entity_ids,
        coalesce(d.subject_ids, '{}') as subject_ids,
        coalesce(d.object_ids, '{}') as object_ids
      from events e
      join documents d2 on d2.id = e.document_id
      join sources s on s.id = e.source_id
      join event_entities ee on ee.event_id = e.id
      join entities ent on ent.id = ee.entity_id
      left join event_directions d on d.event_id = e.id
      where e.source_id = $1
        and (s.tenant_id = $2 or s.tenant_id = $3)
        and d2.archived_at is null
        and e.deleted_at is null
        and ee.entity_id = any($4::uuid[])
      group by e.id, d.subject_ids, d.object_ids
      order by e.rank, e.id
    `,
    [input.sourceId, input.tenantId, PUBLIC_TENANT, entityIds]
  );

  const events: ProjectGraphEventRecord[] = eventsResult.rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    title: String(row.title),
    rank: Number(row.rank ?? 0),
    entityIds: Array.isArray(row.entity_ids) ? row.entity_ids.map(String) : [],
    subjectIds: Array.isArray(row.subject_ids) ? row.subject_ids.map(String) : [],
    objectIds: Array.isArray(row.object_ids) ? row.object_ids.map(String) : []
  }));
  const edges = events.flatMap((event) => event.entityIds.map((entityId) => ({
    entityId,
    eventId: event.id
  })));

  return { entities, events, edges };
}

export async function getDocumentDetail(input: {
  documentId: string;
  tenantId: string;
}): Promise<(DocumentRecord & { source: SourceRecord }) | null> {
  // V392修复: 公共库对所有用户可见（放宽租户过滤）
  const PUBLIC_TENANT = "00000000-0000-0000-0000-000000000001";
  const result = await pool.query(
    `
      select d.*, s.id as source_id_for_source, s.tenant_id, s.name as source_name,
             s.description as source_description, s.metadata as source_metadata
      from documents d
      join sources s on s.id = d.source_id
      where d.id = $1 and (s.tenant_id = $2 or s.tenant_id = $3)
    `,
    [input.documentId, input.tenantId, PUBLIC_TENANT]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    ...documentFromRow(row),
    source: {
      id: String(row.source_id),
      tenantId: String(row.tenant_id),
      name: String(row.source_name),
      description: row.source_description == null ? null : String(row.source_description),
      metadata: (row.source_metadata ?? {}) as Record<string, unknown>
    }
  };
}

/** 按正文内容哈希查文档（V398：内容级幂等 — 同内容重灌跳过，不依赖标题） */
export async function findByContentHash(
  contentHash: string,
  tenantId: string
): Promise<(DocumentRecord & { source: SourceRecord }) | null> {
  const result = await pool.query(
    `
      select d.*, s.id as source_id_for_source, s.tenant_id, s.name as source_name,
             s.description as source_description, s.metadata as source_metadata
      from documents d
      join sources s on s.id = d.source_id
      where d.content_hash = $1 and s.tenant_id = $2 and d.archived_at is null
      order by d.created_at desc
      limit 1
    `,
    [contentHash, tenantId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    ...documentFromRow(row),
    source: sourceFromRow(row)
  };
}

/** 按标题查文档（入库幂等检查用：同标题已存在则跳过重复入库） */
export async function findDocumentByTitle(
  title: string,
  tenantId: string
): Promise<(DocumentRecord & { source: SourceRecord }) | null> {
  const result = await pool.query(
    `
      select d.*, s.id as source_id_for_source, s.tenant_id, s.name as source_name,
             s.description as source_description, s.metadata as source_metadata
      from documents d
      join sources s on s.id = d.source_id
      where d.title = $1 and s.tenant_id = $2 and d.archived_at is null
      order by d.created_at desc
      limit 1
    `,
    [title, tenantId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    ...documentFromRow(row),
    source: {
      id: String(row.source_id),
      tenantId: String(row.tenant_id),
      name: String(row.source_name),
      description: row.source_description == null ? null : String(row.source_description),
      metadata: (row.source_metadata ?? {}) as Record<string, unknown>
    }
  };
}

export async function listChunksByDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<ChunkRecord[]> {
  // V392修复: 公共库对所有用户可见（放宽租户过滤）
  const PUBLIC_TENANT = "00000000-0000-0000-0000-000000000001";
  const result = await pool.query(
    `
      select c.*, c.embedding::text as embedding_preview
      from source_chunks c
      join sources s on s.id = c.source_id
      where c.document_id = $1 and (s.tenant_id = $2 or s.tenant_id = $3)
      order by c.rank, c.id
    `,
    [input.documentId, input.tenantId, PUBLIC_TENANT]
  );
  return result.rows.map(chunkFromRow);
}

export async function listEventsByDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<Array<EventRecord & { entityCount: number; entities: EntityRecord[] }>> {
  // V392修复: 公共库对所有用户可见（放宽租户过滤）
  const PUBLIC_TENANT = "00000000-0000-0000-0000-000000000001";
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary,
             e.content, e.rank, e.title_embedding::text as title_embedding_preview,
             e.content_embedding::text as content_embedding_preview,
             count(ee.entity_id)::int as entity_count,
             coalesce(
               jsonb_agg(
                 distinct jsonb_build_object(
                   'id', ent.id,
                   'source_id', ent.source_id,
                   'type', ent.type,
                   'name', ent.name,
                   'normalized_name', ent.normalized_name,
                   'description', ent.description
                 )
               ) filter (where ent.id is not null),
               '[]'::jsonb
             ) as entities
      from events e
      join sources s on s.id = e.source_id
      left join event_entities ee on ee.event_id = e.id
      left join entities ent on ent.id = ee.entity_id
      where e.document_id = $1 and (s.tenant_id = $2 or s.tenant_id = $3) and e.deleted_at is null
      group by e.id
      order by e.rank, e.id
    `,
    [input.documentId, input.tenantId, PUBLIC_TENANT]
  );
  return result.rows.map((row) => ({
    ...eventFromRow(row),
    entityCount: Number(row.entity_count ?? 0),
    entities: Array.isArray(row.entities)
      ? row.entities.map((entityRow: Record<string, unknown>) => entityFromRow(entityRow))
      : []
  }));
}

export async function listEntitiesByDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<EntityWithEventsRecord[]> {
  // V392修复: 公共库对所有用户可见（放宽租户过滤）
  const PUBLIC_TENANT = "00000000-0000-0000-0000-000000000001";
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             ent.description, ent.embedding::text as embedding_preview,
             count(distinct ee.event_id)::int as event_count
      from entities ent
      join event_entities ee on ee.entity_id = ent.id
      join events e on e.id = ee.event_id
      join sources s on s.id = e.source_id
      where e.document_id = $1 and (s.tenant_id = $2 or s.tenant_id = $3) and e.deleted_at is null
      group by ent.id
      order by event_count desc, ent.type, ent.name
    `,
    [input.documentId, input.tenantId, PUBLIC_TENANT]
  );
  return result.rows.map((row) => ({
    ...entityFromRow(row),
    description: row.description == null ? null : String(row.description),
    eventCount: Number(row.event_count ?? 0)
  }));
}

export async function getEntityDetail(input: {
  entityId: string;
  tenantId: string;
  includeArchived?: boolean;
}): Promise<EntityDetailRecord | null> {
  const archiveSql = input.includeArchived
    ? ""
    : "and s.archived_at is null and d.archived_at is null";
  // V392修复: 公共库对所有用户可见（放宽租户过滤）
  const PUBLIC_TENANT = "00000000-0000-0000-0000-000000000001";
  const entityResult = await pool.query(
    `
      select
        ent.id,
        ent.source_id,
        ent.type,
        ent.name,
        ent.normalized_name,
        ent.description,
        count(distinct ee.event_id)::int as event_count,
        s.tenant_id,
        s.name as source_name,
        s.description as source_description,
        s.metadata as source_metadata,
        s.archived_at as source_archived_at,
        s.created_at as source_created_at,
        s.updated_at as source_updated_at
      from entities ent
      join sources s on s.id = ent.source_id
      join event_entities ee on ee.entity_id = ent.id
      join events e on e.id = ee.event_id
      join documents d on d.id = e.document_id
      where ent.id = $1
        and (s.tenant_id = $2 or s.tenant_id = $3)
        and e.deleted_at is null
        ${archiveSql}
      group by ent.id, s.id
    `,
    [input.entityId, input.tenantId, PUBLIC_TENANT]
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) {
    return null;
  }
  const eventsResult = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank
      from event_entities ee
      join events e on e.id = ee.event_id
      join sources s on s.id = e.source_id
      join documents d on d.id = e.document_id
      where ee.entity_id = $1
        and (s.tenant_id = $2 or s.tenant_id = $3)
        and e.deleted_at is null
        ${archiveSql}
      order by e.rank, e.id
    `,
    [input.entityId, input.tenantId, PUBLIC_TENANT]
  );
  return {
    entity: {
      ...entityFromRow(entityRow),
      description: entityRow.description == null ? null : String(entityRow.description),
      eventCount: Number(entityRow.event_count ?? 0)
    },
    events: eventsResult.rows.map(eventFromRow),
    source: sourceFromRow({
      id: entityRow.source_id,
      tenant_id: entityRow.tenant_id,
      name: entityRow.source_name,
      description: entityRow.source_description,
      metadata: entityRow.source_metadata,
      archived_at: entityRow.source_archived_at,
      created_at: entityRow.source_created_at,
      updated_at: entityRow.source_updated_at
    })
  };
}

export async function getAiProviderSettings(): Promise<AiProviderSettingsRecord | null> {
  const result = await pool.query("select * from ai_provider_settings where id = 'global'");
  return result.rows[0] ? aiProviderSettingsFromRow(result.rows[0]) : null;
}

export async function upsertAiProviderSettings(input: {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey?: string | null;
  preserveEmbeddingApiKey?: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string | null;
  preserveLlmApiKey?: boolean;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  metadata?: Record<string, unknown>;
}): Promise<AiProviderSettingsRecord> {
  const result = await pool.query(
    `
      insert into ai_provider_settings (
        id,
        embedding_base_url,
        embedding_model,
        embedding_dimensions,
        embedding_api_key,
        llm_base_url,
        llm_model,
        llm_api_key,
        llm_timeout_ms,
        llm_max_retries,
        metadata
      )
      values (
        'global',
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10::jsonb
      )
      on conflict (id) do update set
        embedding_base_url = excluded.embedding_base_url,
        embedding_model = excluded.embedding_model,
        embedding_dimensions = excluded.embedding_dimensions,
        embedding_api_key = case
          when $11::boolean then ai_provider_settings.embedding_api_key
          else excluded.embedding_api_key
        end,
        llm_base_url = excluded.llm_base_url,
        llm_model = excluded.llm_model,
        llm_api_key = case
          when $12::boolean then ai_provider_settings.llm_api_key
          else excluded.llm_api_key
        end,
        llm_timeout_ms = excluded.llm_timeout_ms,
        llm_max_retries = excluded.llm_max_retries,
        metadata = ai_provider_settings.metadata || excluded.metadata,
        updated_at = now()
      returning *
    `,
    [
      input.embeddingBaseUrl,
      input.embeddingModel,
      input.embeddingDimensions,
      input.embeddingApiKey ?? null,
      input.llmBaseUrl,
      input.llmModel,
      input.llmApiKey ?? null,
      input.llmTimeoutMs,
      input.llmMaxRetries,
      JSON.stringify(input.metadata ?? {}),
      input.preserveEmbeddingApiKey ?? false,
      input.preserveLlmApiKey ?? false
    ]
  );
  return aiProviderSettingsFromRow(result.rows[0]);
}

export async function createMcpSession(input: {
  tenantId: string;
  title: string;
  model?: string;
  sourceIds?: string[];
  metadata?: Record<string, unknown>;
  kind?: "project" | "chat";
}): Promise<McpSessionRecord> {
  const result = await pool.query(
    `
      insert into mcp_sessions (id, tenant_id, title, model, source_ids, metadata, kind)
      values ($1, $2, $3, $4, $5::uuid[], $6::jsonb, $7)
      returning *
    `,
    [
      randomUUID(),
      input.tenantId,
      input.title,
      input.model ?? null,
      input.sourceIds ?? [],
      JSON.stringify(input.metadata ?? {}),
      input.kind ?? "project"
    ]
  );
  return mcpSessionFromRow(result.rows[0]);
}

export async function listMcpSessions(input: {
  tenantId: string;
  limit: number;
  sourceId?: string;
  kind?: "project" | "chat";
}): Promise<McpSessionRecord[]> {
  const params: unknown[] = [input.tenantId, input.limit];
  const clauses: string[] = [];
  if (input.sourceId) {
    params.push([input.sourceId]);
    clauses.push("source_ids @> $3::uuid[]");
  }
  if (input.kind) {
    params.push(input.kind);
    clauses.push(`kind = $${params.length}`);
  }
  const whereSql = clauses.length > 0 ? `and ${clauses.join(" and ")}` : "";
  const result = await pool.query(
    `
      select *
      from mcp_sessions
      where tenant_id = $1 ${whereSql}
      order by updated_at desc, id
      limit $2
    `,
    params
  );
  return result.rows.map(mcpSessionFromRow);
}

export async function getMcpSession(input: {
  sessionId: string;
  tenantId: string;
}): Promise<McpSessionRecord | null> {
  const result = await pool.query(
    "select * from mcp_sessions where id = $1 and tenant_id = $2",
    [input.sessionId, input.tenantId]
  );
  return result.rows[0] ? mcpSessionFromRow(result.rows[0]) : null;
}

export async function updateMcpSessionTitle(input: {
  sessionId: string;
  tenantId: string;
  title: string;
  metadata?: Record<string, unknown>;
}): Promise<McpSessionRecord | null> {
  const result = await pool.query(
    `
      update mcp_sessions
      set
        title = $3,
        metadata = metadata || $4::jsonb,
        updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [
      input.sessionId,
      input.tenantId,
      input.title.trim(),
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ? mcpSessionFromRow(result.rows[0]) : null;
}

export async function clearMcpSession(input: {
  sessionId: string;
  tenantId: string;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sessionResult = await client.query(
      "select id from mcp_sessions where id = $1 and tenant_id = $2 for update",
      [input.sessionId, input.tenantId]
    );
    if (!sessionResult.rows[0]) {
      await client.query("rollback");
      return false;
    }
    await client.query("delete from mcp_tool_calls where session_id = $1", [input.sessionId]);
    await client.query("delete from mcp_messages where session_id = $1", [input.sessionId]);
    await client.query(
      "update mcp_sessions set updated_at = now() where id = $1",
      [input.sessionId]
    );
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** V398: 撤回单条消息（连带其工具调用删除；仅限 AI 对话页回复前撤回） */
export async function deleteMcpMessage(input: {
  sessionId: string;
  messageId: string;
  tenantId: string;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sessionResult = await client.query(
      "select id from mcp_sessions where id = $1 and tenant_id = $2 for update",
      [input.sessionId, input.tenantId]
    );
    if (!sessionResult.rows[0]) {
      await client.query("rollback");
      return false;
    }
    await client.query("delete from mcp_tool_calls where session_id = $1 and message_id = $2", [input.sessionId, input.messageId]);
    const del = await client.query(
      "delete from mcp_messages where id = $1 and session_id = $2",
      [input.messageId, input.sessionId]
    );
    await client.query(
      "update mcp_sessions set updated_at = now() where id = $1",
      [input.sessionId]
    );
    await client.query("commit");
    return (del.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteMcpSession(input: {
  sessionId: string;
  tenantId: string;
}): Promise<boolean> {
  const result = await pool.query(
    "delete from mcp_sessions where id = $1 and tenant_id = $2",
    [input.sessionId, input.tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function addMcpMessage(input: {
  sessionId: string;
  role: McpMessageRole;
  content: string;
  metadata?: Record<string, unknown>;
  images?: McpMessageRecord["images"];
}): Promise<McpMessageRecord> {
  const result = await pool.query(
    `
      insert into mcp_messages (id, session_id, role, content, metadata, images)
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
      returning *
    `,
    [randomUUID(), input.sessionId, input.role, input.content, JSON.stringify(input.metadata ?? {}), JSON.stringify(input.images ?? null)]
  );
  await touchMcpSession(input.sessionId);
  return mcpMessageFromRow(result.rows[0]);
}

export async function addMcpToolCall(input: {
  sessionId: string;
  messageId?: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  durationMs?: number | null;
  error?: string | null;
}): Promise<McpToolCallRecord> {
  const queryResult = await pool.query(
    `
      insert into mcp_tool_calls (
        id, session_id, message_id, tool_name, arguments, result, status, duration_ms, error
      )
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
      returning *
    `,
    [
      randomUUID(),
      input.sessionId,
      input.messageId ?? null,
      input.toolName,
      JSON.stringify(input.arguments),
      JSON.stringify(input.result ?? null),
      input.status,
      input.durationMs ?? null,
      input.error ?? null
    ]
  );
  await touchMcpSession(input.sessionId);
  return mcpToolCallFromRow(queryResult.rows[0]);
}

export async function getMcpSessionDetail(input: {
  sessionId: string;
  tenantId: string;
}): Promise<{
  session: McpSessionRecord;
  messages: McpMessageRecord[];
  toolCalls: McpToolCallRecord[];
} | null> {
  const session = await getMcpSession(input);
  if (!session) {
    return null;
  }
  const [messagesResult, callsResult] = await Promise.all([
    pool.query(
      "select * from mcp_messages where session_id = $1 order by created_at, id",
      [input.sessionId]
    ),
    pool.query(
      "select * from mcp_tool_calls where session_id = $1 order by created_at, id",
      [input.sessionId]
    )
  ]);
  return {
    session,
    messages: messagesResult.rows.map(mcpMessageFromRow),
    toolCalls: callsResult.rows.map(mcpToolCallFromRow)
  };
}

async function touchMcpSession(sessionId: string): Promise<void> {
  await pool.query(
    "update mcp_sessions set updated_at = now() where id = $1",
    [sessionId]
  );
}

/**
 * Relational fanout（GBrain relational-recall 适配）— 沿事件-实体边展开
 * 用 event_entities.description 作为关系标签（role text），支持 linkTypes 过滤 + direction + depth
 * P2(Zleap 评审): 支持 queryVector + threshold 边相似度剪枝(参照 Zleap relation_threshold) —
 *   传 queryVector 时, 边(ee.embedding 与 query 余弦相似度)低于 threshold 的关联被过滤,
 *   减少多跳噪音; 不传则行为与旧版完全一致。
 * 返回: { entityId, name, eventId, eventTitle, linkType, hop }[]
 */
export async function relationalFanout(input: {
  seedEntityIds: string[];
  sourceIds: string[];
  linkTypes?: string[];
  direction?: "out" | "in" | "both";
  depth?: number;
  limit?: number;
  queryVector?: number[];
  threshold?: number;
  /** G1(Zleap 对齐): 每跳最多扩展的实体数(默认 null=不限制, 保持旧行为) */
  entitiesPerHop?: number;
  /** G1: 每跳最多新增的事件数(默认 null=不限制) */
  eventsPerHop?: number;
  /** G1: 新事件向量相似度阈值(低于则不入下一跳, 默认 null=不限制) */
  eventThreshold?: number;
}): Promise<Array<{ entityId: string; name: string; eventId: string; eventTitle: string; linkType: string; hop: number }>> {
  if (input.seedEntityIds.length === 0) return [];
  const maxDepth = Math.min(Math.max(input.depth ?? 1, 1), 3);
  const limit = input.limit ?? 50;
  const threshold = input.queryVector ? (input.threshold ?? config.RELATIONAL_EDGE_THRESHOLD) : 0;
  const queryVectorLiteral = input.queryVector ? toVectorLiteral(input.queryVector) : null;
  const { entitiesPerHop, eventsPerHop, eventThreshold } = input;

  // 双路径: 传了任何配额 → 逐跳受限扩展(JS 循环, 参照 Zleap _expand_graph hook 设计);
  // 否则 → 原递归 CTE(完全向后兼容)
  if (entitiesPerHop !== undefined || eventsPerHop !== undefined || eventThreshold !== undefined) {
    try {
      return await fanoutHopByHop(input, maxDepth, limit, threshold, queryVectorLiteral, entitiesPerHop, eventsPerHop, eventThreshold);
    } catch (error) {
      console.error("[relationalFanout] hop-by-hop failed:", error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  try {
    const result = await pool.query(
      `
      with recursive fanout as (
        -- 种子实体 → 关联事件（hop 1）
        select ee.entity_id, ee.event_id, 1 as hop
        from event_entities ee
        join events e on e.id = ee.event_id
        where ee.entity_id = any($1::uuid[])
          and e.source_id = any($2::uuid[])
          and e.deleted_at is null
          and ($5::vector is null or (ee.embedding is not null and 1 - (ee.embedding <=> $5::vector) >= $6))
        union
        -- 事件 → 其它实体（hop+1）
        select ee2.entity_id, ee2.event_id, f.hop + 1 as hop
        from fanout f
        join event_entities ee1 on ee1.event_id = f.event_id and ee1.entity_id = f.entity_id
        join event_entities ee2 on ee2.event_id = ee1.event_id
        where f.hop < $3
          and not (ee2.entity_id = any($1::uuid[]))
          and ($5::vector is null or (ee2.embedding is not null and 1 - (ee2.embedding <=> $5::vector) >= $6))
      )
      select distinct
        ee3.entity_id, ent.name, ee3.event_id, e.title as event_title,
        coalesce(ee3.description, '') as link_type, f2.hop
      from (
        select entity_id, event_id, min(hop) as hop
        from fanout group by entity_id, event_id
      ) f2
      join event_entities ee3 on ee3.event_id = f2.event_id and ee3.entity_id = f2.entity_id
      join entities ent on ent.id = ee3.entity_id
      join events e on e.id = ee3.event_id
      order by f2.hop, ent.name
      limit $4
      `,
      [input.seedEntityIds, input.sourceIds, maxDepth, limit, queryVectorLiteral, threshold]
    );
    return result.rows.map((row) => ({
      entityId: String(row.entity_id),
      name: String(row.name),
      eventId: String(row.event_id),
      eventTitle: String(row.event_title),
      linkType: String(row.link_type ?? ""),
      hop: Number(row.hop)
    }));
  } catch {
    return [];
  }
}

/** G1 逐跳受限扩展: 每跳按边相似度排序截断 entitiesPerHop/eventsPerHop, 新事件按 eventThreshold 过滤 */
async function fanoutHopByHop(
  input: {
    seedEntityIds: string[];
    sourceIds: string[];
    queryVector?: number[];
    threshold?: number;
  },
  maxDepth: number,
  limit: number,
  threshold: number,
  queryVectorLiteral: string | null,
  entitiesPerHop?: number,
  eventsPerHop?: number,
  eventThreshold?: number,
): Promise<Array<{ entityId: string; name: string; eventId: string; eventTitle: string; linkType: string; hop: number }>> {
  const rows: Array<{ entityId: string; name: string; eventId: string; eventTitle: string; linkType: string; hop: number }> = [];
  const seenEntities = new Set<string>(input.seedEntityIds);
  const seenEvents = new Set<string>();

  // 当前 frontier = seed 实体 → 关联事件(hop1, 按边相似度排序截断 eventsPerHop)
  let frontier: Array<{ entityId: string; name: string; eventId: string; eventTitle: string; linkType: string; hop: number; score: number }> =
    await queryEventRowsFromEntities(input.seedEntityIds, input.sourceIds, threshold, queryVectorLiteral, eventsPerHop, 1);
  frontier = frontier.filter((e) => !seenEvents.has(e.eventId));
  for (const e of frontier) seenEvents.add(e.eventId);

  for (let hop = 1; hop <= maxDepth; hop++) {
    // 记录本跳结果(去重)
    const fresh = frontier.filter((e) => !rows.some((r) => r.eventId === e.eventId && r.hop === e.hop));
    rows.push(...fresh);
    if (hop === maxDepth || fresh.length === 0) break;

    // 事件 → 新实体(按边相似度排序截断 entitiesPerHop)
    const newEntities = await queryEntityRowsFromEvents(frontier.map((e) => e.eventId), input.sourceIds, threshold, queryVectorLiteral, entitiesPerHop);
    const freshEntities = newEntities.filter((en) => !seenEntities.has(en.entityId));
    for (const en of freshEntities) seenEntities.add(en.entityId);
    if (freshEntities.length === 0) break;

    // 新实体 → 新事件(eventsPerHop 截断 + eventThreshold 过滤)
    const nextHop = await queryEventRowsFromEntities(freshEntities.map((en) => en.entityId), input.sourceIds, threshold, queryVectorLiteral, eventsPerHop, hop + 1);
    frontier = nextHop.filter((e) => !seenEvents.has(e.eventId) && (eventThreshold == null || e.score >= eventThreshold));
    for (const e of frontier) seenEvents.add(e.eventId);
    if (frontier.length === 0) break;
  }

  return rows.slice(0, limit);
}

/** 实体 → 关联事件行(含实体名/关系标签, 按边相似度排序) */
async function queryEventRowsFromEntities(
  entityIds: string[],
  sourceIds: string[],
  threshold: number,
  queryVectorLiteral: string | null,
  limitPerHop: number | undefined,
  hop: number,
): Promise<Array<{ entityId: string; name: string; eventId: string; eventTitle: string; linkType: string; hop: number; score: number }>> {
  if (entityIds.length === 0) return [];
  const r = await pool.query(
    `
      select ee.entity_id, ent.name, ee.event_id, e.title as event_title,
             coalesce(ee.description, '') as link_type,
             case when $4::vector is null then 0 else 1 - (ee.embedding <=> $4::vector) end as score
      from event_entities ee
      join events e on e.id = ee.event_id
      join entities ent on ent.id = ee.entity_id
      where ee.entity_id = any($1::uuid[])
        and e.source_id = any($2::uuid[])
        and e.deleted_at is null
        and ($4::vector is null or (ee.embedding is not null and 1 - (ee.embedding <=> $4::vector) >= $3::float8))
      order by score desc, ee.event_id
      limit $5
    `,
    [entityIds, sourceIds, threshold, queryVectorLiteral, limitPerHop ?? 1000]
  );
  return r.rows.map((row) => ({
    entityId: String(row.entity_id),
    name: String(row.name),
    eventId: String(row.event_id),
    eventTitle: String(row.event_title),
    linkType: String(row.link_type ?? ""),
    hop,
    score: Number(row.score ?? 0),
  }));
}

/** 事件 → 关联实体(按边相似度排序) */
async function queryEntityRowsFromEvents(
  eventIds: string[],
  sourceIds: string[],
  threshold: number,
  queryVectorLiteral: string | null,
  limitPerHop: number | undefined,
): Promise<Array<{ entityId: string }>> {
  if (eventIds.length === 0) return [];
  const r = await pool.query(
    `
      select distinct ee.entity_id
      from event_entities ee
      where ee.event_id = any($1::uuid[])
        and ($3::vector is null or (ee.embedding is not null and 1 - (ee.embedding <=> $3::vector) >= $2::float8))
      order by ee.entity_id
      limit $4
    `,
    [eventIds, threshold, queryVectorLiteral, limitPerHop ?? 1000]
  );
  return r.rows.map((row) => ({ entityId: String(row.entity_id) }));
}

// ─── Upload jobs 持久化（037_upload_jobs）───
// job 的内存 Map 落盘副本：写入即持久化，重启后从表恢复
interface UploadJobRow {
  id: string;
  source_id: string;
  file_name: string;
  title: string;
  status: string;
  stage: string;
  message: string;
  progress: number;
  chunk_count: number | null;
  event_count: number | null;
  current_chunk: number | null;
  total_chunks: number | null;
  document_id: string | null;
  trace_id: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapUploadJobRow(row: UploadJobRow) {
  return {
    id: row.id,
    sourceId: row.source_id,
    fileName: row.file_name,
    title: row.title,
    status: row.status as "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED",
    stage: row.stage as IngestProgressStage,
    message: row.message,
    progress: Number(row.progress),
    chunkCount: row.chunk_count == null ? undefined : Number(row.chunk_count),
    eventCount: row.event_count == null ? undefined : Number(row.event_count),
    currentChunk: row.current_chunk == null ? undefined : Number(row.current_chunk),
    totalChunks: row.total_chunks == null ? undefined : Number(row.total_chunks),
    documentId: row.document_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export async function upsertUploadJob(job: {
  id: string;
  sourceId: string;
  fileName: string;
  title: string;
  status: string;
  stage: string;
  message: string;
  progress: number;
  chunkCount?: number;
  eventCount?: number;
  currentChunk?: number;
  totalChunks?: number;
  documentId?: string;
  traceId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}): Promise<void> {
  await pool.query(
    `
    insert into upload_jobs (
      id, source_id, file_name, title, status, stage, message, progress,
      chunk_count, event_count, current_chunk, total_chunks, document_id, trace_id, error,
      created_at, updated_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    on conflict (id) do update set
      status = excluded.status,
      stage = excluded.stage,
      message = excluded.message,
      progress = excluded.progress,
      chunk_count = excluded.chunk_count,
      event_count = excluded.event_count,
      current_chunk = excluded.current_chunk,
      total_chunks = excluded.total_chunks,
      document_id = excluded.document_id,
      trace_id = excluded.trace_id,
      error = excluded.error,
      updated_at = excluded.updated_at
    `,
    [
      job.id, job.sourceId, job.fileName, job.title, job.status, job.stage, job.message, job.progress,
      job.chunkCount ?? null, job.eventCount ?? null, job.currentChunk ?? null, job.totalChunks ?? null,
      job.documentId ?? null, job.traceId ?? null, job.error ?? null,
      job.createdAt, job.updatedAt
    ]
  );
}

export async function loadActiveUploadJobs(): Promise<ReturnType<typeof mapUploadJobRow>[]> {
  // 2026-08-12 修复：加载全部任务（含历史 COMPLETED/FAILED），前端 Jobs 队列显示完整历史
  const result = await pool.query<UploadJobRow>(
    `select * from upload_jobs order by created_at desc limit 500`
  );
  return result.rows.map(mapUploadJobRow);
}

/** 启动恢复：所有遗留 RUNNING/QUEUED 任务标记 FAILED（进程已死，原任务丢失） */
export async function markInterruptedUploadJobsFailed(): Promise<void> {
  await pool.query(
    `update upload_jobs set status = 'FAILED', stage = 'FAILED',
       message = '服务重启，任务中断', error = 'service restarted',
       updated_at = now() where status in ('QUEUED','RUNNING')`
  );
}

// ═══ P2: MCP 只读工具查询(Zleap 评审) ═══

/** 词法搜索 chunk(tsvector GIN 索引, 零新索引成本) — MCP sag_grep 用 */
export async function searchChunksByText(input: {
  sourceId: string;
  query: string;
  limit: number;
}): Promise<Array<{
  chunkId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank: number;
  score: number;
}>> {
  if (!input.query.trim()) return [];
  const result = await pool.query(
    `
      with q as (
        select websearch_to_tsquery('simple', $1) as tsq
      )
      select c.id, c.document_id, c.heading, c.content, c.rank,
             ts_rank_cd(c.search_text, q.tsq) as score
      from source_chunks c
      cross join q
      join documents d on d.id = c.document_id
      join sources s on s.id = c.source_id
      where c.source_id = $2::uuid
        and d.archived_at is null
        and s.archived_at is null
        and c.search_text @@ q.tsq
      order by ts_rank_cd(c.search_text, q.tsq) desc
      limit $3
    `,
    [input.query, input.sourceId, input.limit]
  );
  return result.rows.map((row) => ({
    chunkId: String(row.id),
    documentId: row.document_id == null ? undefined : String(row.document_id),
    heading: row.heading == null ? undefined : String(row.heading),
    content: String(row.content),
    rank: Number(row.rank),
    score: Number(row.score)
  }));
}

/** 按 chunkId 取单个 chunk(限定 source) — MCP sag_get_chunk 用 */
export async function getChunkById(input: {
  chunkId: string;
  sourceId: string;
}): Promise<{
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank: number;
} | null> {
  const result = await pool.query(
    `
      select c.id, c.source_id, c.document_id, c.heading, c.content, c.rank
      from source_chunks c
      join sources s on s.id = c.source_id
      where c.id = $1::uuid
        and c.source_id = $2::uuid
    `,
    [input.chunkId, input.sourceId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    chunkId: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? undefined : String(row.document_id),
    heading: row.heading == null ? undefined : String(row.heading),
    content: String(row.content),
    rank: Number(row.rank)
  };
}
