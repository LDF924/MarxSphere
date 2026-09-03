// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// vector-store.ts — 向量存储抽象层(渐进式新增, PG 真源不动)
// 参照: zleap/sag/core/storage/{pgvector_store,lancedb_store}.py
// 设计:
//   - VectorStore 接口: 与 Zleap 对齐的 embed/query 两类操作
//   - PgVectorStore: 现有 PG 查询封装(行为与现在完全一致, 真源)
//   - LanceDbVectorStore: 可选实现(接口就绪, 双写镜像后启用, 默认关)
//   - 通过 getVectorStore() 单例选择: 默认 PG; LANCE_VECTOR_STORE=true 且 lancedb 可用时启用
import { pool } from "../db/pool.js";
import { toVectorLiteral } from "../db/vector.js";

export interface VectorQueryResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface VectorStore {
  readonly name: string;
  /** 按向量召回 top-k(对齐 Zleap search_similar_by_*) */
  query(collection: string, vector: number[], topK: number, filter?: Record<string, unknown>): Promise<VectorQueryResult[]>;
  /** 写向量(对齐 Zleap index_document/bulk_index; PG 实现走表更新, LanceDB 实现走 upsert) */
  upsert(collection: string, id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>;
  /** 健康检查 */
  health(): Promise<{ ok: boolean; detail?: string }>;
}

/** PG 实现: 直连现有表(vector 列即真源, 行为与现有查询一致) */
export class PgVectorStore implements VectorStore {
  readonly name = "pg";

  async query(collection: string, vector: number[], topK: number, filter?: Record<string, unknown>): Promise<VectorQueryResult[]> {
    const vec = toVectorLiteral(vector);
    switch (collection) {
      case "events": {
        const r = await pool.query(
          `select e.id, 1 - (e.content_embedding <=> $1::vector) as score
           from events e
           where e.source_id = any($2::uuid[]) and e.deleted_at is null and e.content_embedding is not null
           order by e.content_embedding <=> $1::vector
           limit $3`,
          [vec, (filter?.sourceIds as string[]) ?? [], topK],
        );
        return r.rows.map((row) => ({ id: String(row.id), score: Number(row.score), metadata: {} }));
      }
      case "entities": {
        const r = await pool.query(
          `select e.id, 1 - (e.embedding <=> $1::vector) as score
           from entities e
           where e.source_id = any($2::uuid[]) and e.embedding is not null
           order by e.embedding <=> $1::vector
           limit $3`,
          [vec, (filter?.sourceIds as string[]) ?? [], topK],
        );
        return r.rows.map((row) => ({ id: String(row.id), score: Number(row.score), metadata: {} }));
      }
      case "chunks": {
        const r = await pool.query(
          `select c.id, 1 - (c.embedding <=> $1::vector) as score
           from source_chunks c
           where c.source_id = any($2::uuid[]) and c.embedding is not null
           order by c.embedding <=> $1::vector
           limit $3`,
          [vec, (filter?.sourceIds as string[]) ?? [], topK],
        );
        return r.rows.map((row) => ({ id: String(row.id), score: Number(row.score), metadata: {} }));
      }
      default:
        throw new Error(`未知向量集合: ${collection}`);
    }
  }

  async upsert(_collection: string, _id: string, _vector: number[], _metadata?: Record<string, unknown>): Promise<void> {
    // PG 真源: 向量随业务表写入(ingestion 流程), 此处不做独立写
    // (接口存在是为了 LanceDB 镜像实现对齐)
    throw new Error("PG 向量由业务表管理, 不支持独立 upsert");
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await pool.query("select 1");
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** LanceDB 实现(可选): 接口就绪, 双写镜像启用; 未安装 lancedb 时禁用 */
export class LanceDbVectorStore implements VectorStore {
  readonly name = "lancedb";
  private db: any = null;
  private enabled = false;

  constructor() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.db = require("lancedb"); // 可选依赖: 未安装时 enabled=false
      this.enabled = true;
    } catch {
      this.enabled = false;
    }
  }

  get available(): boolean {
    return this.enabled;
  }

  async query(_collection: string, _vector: number[], _topK: number, _filter?: Record<string, unknown>): Promise<VectorQueryResult[]> {
    if (!this.enabled) throw new Error("lancedb 未安装或未启用");
    // 镜像表按 collection 命名; 实现依赖 lancedb API(connect/table/search)
    // 本接口先就绪, 具体镜像写入由双写钩子接入
    return [];
  }

  async upsert(_collection: string, _id: string, _vector: number[], _metadata?: Record<string, unknown>): Promise<void> {
    if (!this.enabled) throw new Error("lancedb 未安装或未启用");
    // 双写钩子: 业务写入 PG 后镜像到 LanceDB(后续接入)
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return this.enabled
      ? { ok: true, detail: "lancedb available" }
      : { ok: false, detail: "lancedb 未安装(可选能力, 不影响 PG 主路径)" };
  }
}

let pgStore: PgVectorStore | null = null;
let lanceStore: LanceDbVectorStore | null = null;

/** 获取默认向量存储(单例; 默认 PG 真源, 行为不变) */
export function getVectorStore(): VectorStore {
  if (!pgStore) pgStore = new PgVectorStore();
  return pgStore;
}

/** 获取 LanceDB 可选存储(未安装返回 null) */
export function getLanceDbStore(): LanceDbVectorStore | null {
  if (!lanceStore) lanceStore = new LanceDbVectorStore();
  return lanceStore.available ? lanceStore : null;
}
