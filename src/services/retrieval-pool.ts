// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// retrieval-pool.ts — 内存候选池(G3, 完整移植 Zleap PooledCandidateSource)
// 参照: zleap/sag/modules/search/pool.py
// 设计对齐(不简化):
//   - VectorCandidateSource: 现有向量库调用原样封装(池关闭/降级时使用, 行为不变)
//   - PooledCandidateSource: 首次 query→event 检索(k=poolSize)建池,
//     后续 entity→event 改读内存倒排; 事件行自带 entity_ids 拼反向索引
//   - 建池失败自动降级回向量源; 池分 pool_score 供排序复用
import type { pool as pgPool } from "../db/pool.js";

export interface CandidateEventRow {
  eventId: string;
  entityIds: string[];
  score: number;
  description: string;
  summary: string;
  title: string;
  dataSourceId?: string;
}

export interface EventCandidateSource {
  recallDirect(limit: number): Promise<CandidateEventRow[]>;
  scoreEvents(eventIds: string[], opts?: { excludeEventIds?: string[]; limit?: number }): Promise<CandidateEventRow[]>;
  eventsForKeys(entityIds: string[], perEntityLimit: number, opts?: { excludeEventIds?: string[] }): Promise<Array<{ eventId: string; entityId: string; score: number; description: string; dataSourceId?: string }>>;
  poolScore(eventId: string): number | null;
  poolStats(): Record<string, unknown> | null;
}

/** 向量源: 直接查 PG(对齐 VectorCandidateSource — 行为与池化前一致) */
export class VectorCandidateSource implements EventCandidateSource {
  constructor(
    private queryEmbedding: number[],
    private sourceIds: string[],
    private pool: typeof pgPool,
  ) {}

  async recallDirect(limit: number): Promise<CandidateEventRow[]> {
    const r = await this.pool.query(
      `
      select e.id, e.title, e.summary, e.content,
             array(select ee2.entity_id from event_entities ee2 where ee2.event_id = e.id) as entity_ids,
             1 - (e.content_embedding <=> $1::vector) as score
      from events e
      where e.source_id = any($2::uuid[])
        and e.deleted_at is null
        and e.content_embedding is not null
      order by e.content_embedding <=> $1::vector
      limit $3
      `,
      [`[${this.queryEmbedding.join(",")}]`, this.sourceIds, limit],
    );
    return r.rows.map(rowFromEvent);
  }

  async scoreEvents(eventIds: string[], opts?: { excludeEventIds?: string[]; limit?: number }): Promise<CandidateEventRow[]> {
    if (eventIds.length === 0) return [];
    const excluded = opts?.excludeEventIds ?? [];
    const r = await this.pool.query(
      `
      select e.id, e.title, e.summary, e.content,
             array(select ee2.entity_id from event_entities ee2 where ee2.event_id = e.id) as entity_ids,
             1 - (e.content_embedding <=> $1::vector) as score
      from events e
      where e.id = any($2::uuid[])
        and e.source_id = any($3::uuid[])
        and e.deleted_at is null
        and ($4::uuid[] is null or not (e.id = any($4::uuid[])))
      order by e.content_embedding <=> $1::vector
      limit $5
      `,
      [`[${this.queryEmbedding.join(",")}]`, eventIds, this.sourceIds, excluded.length > 0 ? excluded : null, opts?.limit ?? eventIds.length],
    );
    return r.rows.map(rowFromEvent);
  }

  async eventsForKeys(entityIds: string[], perEntityLimit: number, opts?: { excludeEventIds?: string[] }): Promise<Array<{ eventId: string; entityId: string; score: number; description: string; dataSourceId?: string }>> {
    if (entityIds.length === 0) return [];
    const excluded = opts?.excludeEventIds ?? [];
    const r = await this.pool.query(
      `
      select ee.event_id, ee.entity_id, ee.description,
             case when e.content_embedding is not null then 1 - (e.content_embedding <=> $1::vector) else 0 end as score,
             e.source_id as data_source_id
      from event_entities ee
      join events e on e.id = ee.event_id
      where ee.entity_id = any($2::uuid[])
        and e.source_id = any($3::uuid[])
        and e.deleted_at is null
        and ($4::uuid[] is null or not (ee.event_id = any($4::uuid[])))
      order by ee.entity_id, score desc
      `,
      [`[${this.queryEmbedding.join(",")}]`, entityIds, this.sourceIds, excluded.length > 0 ? excluded : null],
    );
    // per-entity 截断(对齐 events_for_keys 的 per_entity_limit)
    const perEntity = new Map<string, number>();
    const rows: Array<{ eventId: string; entityId: string; score: number; description: string; dataSourceId?: string }> = [];
    for (const row of r.rows) {
      const entityId = String(row.entity_id);
      const taken = perEntity.get(entityId) ?? 0;
      if (taken >= perEntityLimit) continue;
      perEntity.set(entityId, taken + 1);
      rows.push({
        eventId: String(row.event_id),
        entityId,
        score: Number(row.score ?? 0),
        description: String(row.description ?? ""),
        dataSourceId: row.data_source_id == null ? undefined : String(row.data_source_id),
      });
    }
    return rows;
  }

  poolScore(_eventId: string): number | null {
    return null;
  }

  poolStats(): Record<string, unknown> | null {
    return null;
  }
}

function rowFromEvent(row: Record<string, unknown>): CandidateEventRow {
  return {
    eventId: String(row.id),
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    description: String(row.content ?? row.summary ?? ""),
    entityIds: Array.isArray(row.entity_ids) ? row.entity_ids.map(String) : [],
    score: Number(row.score ?? 0),
    dataSourceId: row.data_source_id == null ? undefined : String(row.data_source_id),
  };
}

/** 池化候选源: 一次建池, 后续读内存(对齐 PooledCandidateSource 三结构) */
export class PooledCandidateSource implements EventCandidateSource {
  private events = new Map<string, CandidateEventRow>();
  private eventsByEntity = new Map<string, string[]>();
  private orderedIds: string[] = [];
  private built = false;
  private degraded = false;
  private building: Promise<void> | null = null;
  private vector: VectorCandidateSource;

  constructor(
    queryEmbedding: number[],
    sourceIds: string[],
    private poolSize: number,
    pool: typeof pgPool,
  ) {
    this.vector = new VectorCandidateSource(queryEmbedding, sourceIds, pool);
  }

  private async ensureBuilt(): Promise<void> {
    if (this.built || this.degraded) return;
    if (this.building) {
      await this.building;
      return;
    }
    this.building = (async () => {
      try {
        const rows = await this.vector.recallDirect(this.poolSize);
        for (const row of rows) {
          this.events.set(row.eventId, row);
          for (const entityId of row.entityIds) {
            const list = this.eventsByEntity.get(entityId) ?? [];
            if (!list.includes(row.eventId)) list.push(row.eventId);
            this.eventsByEntity.set(entityId, list);
          }
        }
        this.orderedIds = [...this.events.entries()]
          .sort((a, b) => (b[1].score ?? 0) - (a[1].score ?? 0) || a[0].localeCompare(b[0]))
          .map(([id]) => id);
        this.built = true;
      } catch {
        this.degraded = true; // 建池失败降级回向量源(对齐 _ensure_built)
      } finally {
        this.building = null;
      }
    })();
    await this.building;
  }

  async recallDirect(limit: number): Promise<CandidateEventRow[]> {
    await this.ensureBuilt();
    if (this.degraded) return this.vector.recallDirect(limit);
    return this.orderedIds.slice(0, limit).map((id) => this.events.get(id)!);
  }

  async scoreEvents(eventIds: string[], opts?: { excludeEventIds?: string[]; limit?: number }): Promise<CandidateEventRow[]> {
    await this.ensureBuilt();
    if (this.degraded) return this.vector.scoreEvents(eventIds, opts);
    const excluded = new Set(opts?.excludeEventIds ?? []);
    let wanted = eventIds.filter((id) => this.events.has(id) && !excluded.has(id));
    if (opts?.limit != null) {
      const wantedSet = new Set(wanted);
      wanted = this.orderedIds.filter((id) => wantedSet.has(id)).slice(0, opts.limit);
    }
    return wanted.map((id) => this.events.get(id)!);
  }

  async eventsForKeys(entityIds: string[], perEntityLimit: number, opts?: { excludeEventIds?: string[] }): Promise<Array<{ eventId: string; entityId: string; score: number; description: string; dataSourceId?: string }>> {
    await this.ensureBuilt();
    if (this.degraded) return this.vector.eventsForKeys(entityIds, perEntityLimit, opts);
    const excluded = new Set(opts?.excludeEventIds ?? []);
    const relations: Array<{ eventId: string; entityId: string; score: number; description: string; dataSourceId?: string }> = [];
    for (const entityId of [...new Set(entityIds)]) {
      let taken = 0;
      for (const eventId of this.eventsByEntity.get(entityId) ?? []) {
        if (excluded.has(eventId)) continue;
        const row = this.events.get(eventId);
        if (!row) continue;
        relations.push({
          eventId,
          entityId,
          score: row.score ?? 0,
          description: row.description,
          dataSourceId: row.dataSourceId,
        });
        taken++;
        if (taken >= perEntityLimit) break;
      }
    }
    return relations;
  }

  poolScore(eventId: string): number | null {
    if (!this.built || this.degraded) return null;
    const row = this.events.get(eventId);
    return row ? row.score : null;
  }

  poolStats(): Record<string, unknown> | null {
    if (!this.built || this.degraded) return null;
    const scores = this.orderedIds.map((id) => this.events.get(id)?.score ?? 0);
    return {
      requested: this.poolSize,
      actual: this.events.size,
      saturated: this.events.size >= this.poolSize,
      keyCount: this.eventsByEntity.size,
      relationCount: [...this.eventsByEntity.values()].reduce((sum, ids) => sum + ids.length, 0),
      minScore: scores.length > 0 ? Math.min(...scores) : null,
    };
  }
}
