// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { createHash, randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { toVectorLiteral } from "../db/vector.js";
import { createSource, upsertEntity } from "../db/repositories.js";
import { config } from "../config/env.js";
import { embeddingClient, type EmbeddingClient } from "../ai/embedding-client.js";
import { llmClient, type LlmClient } from "../ai/llm-client.js";
import { chunkMarkdown, type ChunkDraft } from "../ingestion/chunking/markdown.js";
import { extractEventsFromChunk } from "../ingestion/extract/extractor.js";
import type { ExtractedEntity, ExtractedEvent, IngestDocumentInput, IngestDocumentResult, IngestProgressUpdate } from "../types.js";
import { logger } from "../observability/logger.js";
import { aiSettingsService } from "./ai-settings-service.js";

/** 修复③：按标题推断 source_type（原来写死 'ARTICLE' 导致 source-aware boost 空转）
 *  论文/研究 → academic · 政策/法规/通知 → policy · 笔记/日志 → note · 默认 article */
export function inferSourceType(title: string): string {
  const t = title || "";
  if (/(论文|研究|分析|报告|学报|期刊|杂志|评论|评析|考察|探析|路径|机制)/.test(t)) return "academic";
  if (/(政策|法规|条例|办法|意见|通知|规定|文件|公报|规划|纲要|决定|指引)/.test(t)) return "policy";
  if (/(笔记|日志|备忘|日记|摘要|随笔)/.test(t)) return "note";
  return "article";
}

type ExtractedChunkEvents = {
  chunk: ChunkDraft;
  events: ExtractedEvent[];
};

type EventInput = {
  chunk: ChunkDraft;
  event: ExtractedEvent;
  eventId: string;
  rank: number;
};

type EventEmbeddingInput = EventInput & {
  titleEmbedding: number[];
  contentEmbedding: number[];
};

type EntityEmbeddingInput = {
  key: string;
  entity: ExtractedEntity;
};

type RelationEmbeddingInput = {
  eventId: string;
  eventTitle: string;
  entity: ExtractedEntity;
};

type PreparedEvent = EventEmbeddingInput & {  entities: Array<ExtractedEntity & {
    entityEmbedding: number[];
    relationEmbedding: number[];
  }>;
};

export class IngestionService {
  constructor(
    private readonly embeddings: EmbeddingClient = embeddingClient,
    private readonly llm: LlmClient = llmClient
  ) {}

  async ingestDocument(
    input: IngestDocumentInput,
    tenantId = config.DEFAULT_TENANT_ID,
    onProgress?: (update: IngestProgressUpdate) => void
  ): Promise<IngestDocumentResult> {
    const ingestStartedAt = Date.now();
    const traceId = randomUUID();
    const taskId = randomUUID();
    const documentId = randomUUID();
    const extract = input.extract ?? true;
    const ingestConcurrency = config.INGEST_CONCURRENCY;
    const runtimeSettings = await aiSettingsService.getRuntimeSettings();
    const chunkingOptions = {
      mode: input.chunking?.mode ?? runtimeSettings.defaultChunkingMode,
      maxTokens: input.chunking?.maxTokens ?? runtimeSettings.chunkTokenLimit,
      overlapTokens: input.chunking?.overlapTokens ?? runtimeSettings.chunkOverlapTokens
    };

    onProgress?.({
      stage: "PARSING",
      message: "正在解析文档内容",
      progress: 8
    });
    const source = await createSource({
      id: input.sourceId,
      tenantId,
      name: input.title,
      description: "Created by SAG ingestDocument",
      metadata: { ...(input.metadata ?? {}), traceId, chunking: chunkingOptions }
    });

    const chunking = chunkMarkdown(input.content, chunkingOptions);
    onProgress?.({
      stage: "CHUNKING",
      message: `已生成 ${chunking.chunks.length} 个切片`,
      progress: 18,
      chunkCount: chunking.chunks.length,
      totalChunks: chunking.chunks.length
    });

    onProgress?.({
      stage: "EMBEDDING_CHUNKS",
      message: "正在生成切片向量",
      progress: 35,
      chunkCount: chunking.chunks.length,
      totalChunks: chunking.chunks.length
    });
    const chunkEmbeddings = await this.embeddings.batchGenerate(chunking.chunks.map((chunk) => `${chunk.heading}\n${chunk.content}`));

    const preparedEvents = extract
      ? await this.prepareEvents({
          input,
          chunks: chunking.chunks,
          onProgress,
          concurrency: ingestConcurrency
        })
      : [];

    const client = await pool.connect();
    try {
      await client.query("begin");
      // upsert：同项目内同标题已存在 → 更新内容（幂等根本保障，配合 016 唯一索引）
      // 注意：冲突时返回的是已存在行的 id（不是传入的 documentId）
      // V398: 正文内容哈希（sha256，清洗后内容）— 内容级幂等 + 变化感知（087 迁移）
      const contentHash = createHash("sha256").update(input.content).digest("hex");
      // V399-2 P2(3.4): 版本历史 — upsert 前查旧行(同标题)的旧哈希, 冲突更新且内容实际变化时写 document_versions
      const prevRow = await client.query(
        `select id, content_version, content_hash from documents
         where title = $1 and source_id = $2 and archived_at is null
         limit 1`,
        [input.title, source.id]
      );
      const docResult = await client.query(
        `
          insert into documents (id, source_id, title, content, status, parse_status, metadata, content_hash)
          values ($1, $2, $3, $4, 'PARSING', 'PARSING', $5::jsonb, $6)
          on conflict (title, source_id) do update set
            content = excluded.content,
            status = 'PARSING',
            parse_status = 'PARSING',
            metadata = excluded.metadata,
            content_hash = excluded.content_hash,
            content_version = documents.content_version + 1,
            updated_at = now()
          returning id
        `,
        [documentId, source.id, input.title, input.content, JSON.stringify({ ...(input.metadata ?? {}), chunking: chunkingOptions }), contentHash]
      );
      // V399-2 P2(3.4): 内容实际变化(旧行存在且旧哈希≠新哈希) → 登记历史版本
      // 无变化重灌(同内容)已在上游 hash 判重拦截, 不会走到这里; 此处兜底避免写无意义历史
      if (prevRow.rows.length > 0 && prevRow.rows[0].content_hash !== contentHash) {
        await client.query(
          `insert into document_versions (document_id, version, content_hash)
           values ($1, $2, $3)
           on conflict (document_id, version) do nothing`,
          [String(docResult.rows[0].id), Number(prevRow.rows[0].content_version) + 1, contentHash]
        );
      }
      const actualDocumentId = String(docResult.rows[0].id);
      onProgress?.({
        stage: "WRITING_GRAPH",
        message: "正在写入文档记录",
        progress: 24,
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        totalChunks: chunking.chunks.length
      });

      // upsert 更新已有文档时：清 actualDocumentId（冲突=旧行，非冲突=新行）的旧关联数据，避免堆积
      // 注意：不能删 documents 行本身（upsert 已更新它，删除会导致 sections 外键失败）
      const oldId = actualDocumentId;
      await client.query(`delete from document_sections where document_id = $1`, [oldId]);
      await client.query(`delete from source_chunks where document_id = $1`, [oldId]);
      const oldEvents = await client.query(`select id from events where document_id = $1`, [oldId]);
      for (const ev of oldEvents.rows) {
        await client.query(`delete from event_entities where event_id = $1`, [ev.id]);
      }
      await client.query(`delete from events where document_id = $1`, [oldId]);

      for (const section of chunking.sections) {
        await client.query(
          `
            insert into document_sections (
              id, document_id, order_index, render_group_index, type, heading, content,
              raw_content, metadata, token_count
            )
            values ($1, $2, $3, 0, 'TEXT', $4, $5, $6, '{}'::jsonb, $7)
          `,
          [
            section.id,
            actualDocumentId,
            Math.trunc(section.orderIndex * 1000),
            section.heading,
            section.content,
            section.rawContent,
            section.tokenCount
          ]
        );
      }

      for (const [index, chunk] of chunking.chunks.entries()) {
        await client.query(
          `
            insert into source_chunks (
              id, source_id, document_id, source_type, external_source_id, heading, content,
              raw_content, rank, "references", metadata, embedding
            )
            values ($1, $2, $3, $4, $3::uuid::text, $5, $6, $7, $8, $9::uuid[], '{}'::jsonb, $10::vector)
          `,
          [
            chunk.id,
            source.id,
            actualDocumentId,
            inferSourceType(input.title),
            chunk.heading,
            chunk.content,
            chunk.rawContent,
            chunk.rank,
            chunk.sectionIds,
            toVectorLiteral(chunkEmbeddings[index])
          ]
        );
      }

      for (const preparedEvent of preparedEvents) {
        await client.query(
          `
            insert into events (
              id, source_id, document_id, chunk_id, source_type, external_source_id,
              level, rank, title, summary, content, category, keywords, priority, status,
              "references", metadata, title_embedding, content_embedding
            )
            values (
              $1, $2, $3, $4, $5, $3::uuid::text,
              0, $6, $7, $8, $9, $10, $11::text[], $12, $13,
              $14::uuid[], $15::jsonb, $16::vector, $17::vector
            )
          `,
          [
            preparedEvent.eventId,
            source.id,
            actualDocumentId,
            preparedEvent.chunk.id,
            inferSourceType(input.title),
            preparedEvent.rank,
            preparedEvent.event.title,
            preparedEvent.event.summary,
            preparedEvent.event.content,
            preparedEvent.event.category ?? null,
            preparedEvent.event.keywords,
            preparedEvent.event.priority ?? "UNKNOWN",
            preparedEvent.event.status ?? "COMPLETED",
            preparedEvent.event.references,
            JSON.stringify({ traceId }),
            toVectorLiteral(preparedEvent.titleEmbedding),
            toVectorLiteral(preparedEvent.contentEmbedding)
          ]
        );

        for (const entity of preparedEvent.entities) {
          const saved = await upsertEntity({
            sourceId: source.id,
            type: entity.type,
            name: entity.name,
            description: entity.description,
            embedding: entity.entityEmbedding
          }, client);
          await client.query(
            `
              insert into event_entities (id, event_id, entity_id, weight, description, embedding)
              values ($1, $2, $3, 1.0, $4, $5::vector)
              on conflict (event_id, entity_id) do update set
                description = excluded.description,
                embedding = excluded.embedding
            `,
            [
              randomUUID(),
              preparedEvent.eventId,
              saved.id,
              entity.description,
              toVectorLiteral(entity.relationEmbedding)
            ]
          );
        }
      }

      onProgress?.({
        stage: "WRITING_GRAPH",
        message: "正在完成图谱关系写入",
        progress: 95,
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        totalChunks: chunking.chunks.length
      });
      await client.query(
        "update documents set status = 'COMPLETED', parse_status = 'COMPLETED', updated_at = now() where id = $1",
        [actualDocumentId]
      );
      await client.query("commit");

      logger.info({ traceId, actualDocumentId, chunkCount: chunking.chunks.length, eventCount: preparedEvents.length }, "document ingested");
      onProgress?.({
        stage: "COMPLETED",
        message: `处理完成：${chunking.chunks.length} 个切片，${preparedEvents.length} 个事件`,
        progress: 100,
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        totalChunks: chunking.chunks.length
      });
      // Trace Waterfall：入库成功 span（kind=job 绿色徽章，与 Ask 检索区分）
      const ingestDuration = Date.now() - ingestStartedAt;
      import("./trace-service.js").then(({ recordSpan }) => {
        void recordSpan({
          traceId,
          kind: "job",
          name: `ingest: ${input.title.slice(0, 40)}`,
          status: "ok",
          durationMs: ingestDuration,
          tokens: { input: 0, output: 0, cacheRead: 0 },
          detail: `${chunking.chunks.length} chunks · ${preparedEvents.length} events`
        }).catch(() => {});
      }).catch(() => {});
      return {
        sourceId: source.id,
        documentId,
        actualDocumentId,
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        taskId,
        traceId
      };
    } catch (error) {
      await client.query("rollback");
      logger.error({ traceId, error }, "document ingest failed");
      // Trace Waterfall：入库失败 span
      const errMsg = error instanceof Error ? error.message : String(error);
      import("./trace-service.js").then(({ recordSpan }) => {
        void recordSpan({
          traceId,
          kind: "job",
          name: `ingest: ${input.title.slice(0, 40)}`,
          status: "error",
          durationMs: Date.now() - ingestStartedAt,
          detail: errMsg.slice(0, 200)
        }).catch(() => {});
      }).catch(() => {});
      // 真实事件 → 告警（入库失败）
      import("./alert-service.js").then(({ recordAlert }) => {
        void recordAlert({
          level: "error",
          category: "failure",
          message: `入库失败：${input.title?.substring(0, 40) || "文档"}（${errMsg.substring(0, 60)}）`,
          taskType: "ingest",
          taskId: traceId,
          detail: { error: errMsg.substring(0, 200) },
        }).catch(() => {});
      }).catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async prepareEvents(input: {
    input: IngestDocumentInput;
    chunks: ChunkDraft[];
    concurrency: number;
    onProgress?: (update: IngestProgressUpdate) => void;
  }): Promise<PreparedEvent[]> {
    let extractedChunks = 0;
    let extractedEventCount = 0;
    const extracted = await mapWithConcurrency(input.chunks, input.concurrency, async (chunk) => {
      input.onProgress?.({
        stage: "EXTRACTING_EVENTS",
        message: `正在并行抽取事件（并发 ${input.concurrency}），已完成 ${extractedChunks}/${input.chunks.length} 个切片`,
        progress: progressForCompleted(extractedChunks, input.chunks.length, 48, 74),
        chunkCount: input.chunks.length,
        eventCount: extractedEventCount,
        currentChunk: extractedChunks,
        totalChunks: input.chunks.length
      });
      const events = await extractEventsFromChunk({
        llm: this.llm,
        documentTitle: input.input.title,
        heading: chunk.heading,
        content: chunk.content,
        references: chunk.sectionIds
      });
      extractedChunks += 1;
      extractedEventCount += events.length;
      input.onProgress?.({
        stage: "EXTRACTING_EVENTS",
        message: `已完成 ${extractedChunks}/${input.chunks.length} 个切片事件抽取`,
        progress: progressForCompleted(extractedChunks, input.chunks.length, 48, 74),
        chunkCount: input.chunks.length,
        eventCount: extractedEventCount,
        currentChunk: extractedChunks,
        totalChunks: input.chunks.length
      });
      return { chunk, events } satisfies ExtractedChunkEvents;
    });

    const eventInputs: EventInput[] = extracted
      .flatMap((item) => item.events.map((event) => ({ chunk: item.chunk, event })))
      .map((item, rank) => ({
        ...item,
        eventId: randomUUID(),
        rank
      }));

    let embeddedEvents = 0;
    const eventEmbeddingInputs = await mapWithConcurrency(eventInputs, input.concurrency, async (eventInput) => {
      const [titleEmbedding, contentEmbedding] = await this.embeddings.batchGenerate([
        eventInput.event.title,
        `${eventInput.event.title}\n\n${eventInput.event.content}`
      ]);
      embeddedEvents += 1;
      input.onProgress?.({
        stage: "EMBEDDING_EVENTS",
        message: `正在并行生成事件向量（并发 ${input.concurrency}），已完成 ${embeddedEvents}/${eventInputs.length} 个事件`,
        progress: progressForCompleted(embeddedEvents, Math.max(eventInputs.length, 1), 74, 82),
        chunkCount: input.chunks.length,
        eventCount: eventInputs.length,
        totalChunks: input.chunks.length
      });
      return {
        ...eventInput,
        titleEmbedding,
        contentEmbedding
      } satisfies EventEmbeddingInput;
    });

    const entityInputs = dedupeEntityEmbeddingInputs(eventInputs.flatMap((item) => item.event.entities));
    let embeddedEntities = 0;
    const entityEmbeddingEntries = await mapWithConcurrency(entityInputs, input.concurrency, async (inputItem) => {
      const embedding = await this.embeddings.generate(inputItem.entity.name);
      embeddedEntities += 1;
      input.onProgress?.({
        stage: "EMBEDDING_EVENTS",
        message: `正在并行生成实体向量（并发 ${input.concurrency}），已完成 ${embeddedEntities}/${entityInputs.length} 个实体`,
        progress: progressForCompleted(embeddedEntities, Math.max(entityInputs.length, 1), 82, 88),
        chunkCount: input.chunks.length,
        eventCount: eventInputs.length,
        totalChunks: input.chunks.length
      });
      return [inputItem.key, embedding] as const;
    });
    const entityEmbeddings = new Map(entityEmbeddingEntries);

    const relationInputs: RelationEmbeddingInput[] = eventInputs.flatMap((item) => (
      item.event.entities.map((entity) => ({
        eventId: item.eventId,
        eventTitle: item.event.title,
        entity
      }))
    ));
    let embeddedRelations = 0;
    const relationEmbeddingEntries = await mapWithConcurrency(relationInputs, input.concurrency, async (inputItem) => {
      const embedding = await this.embeddings.generate(inputItem.entity.description || `${inputItem.eventTitle} ${inputItem.entity.name}`);
      embeddedRelations += 1;
      input.onProgress?.({
        stage: "EMBEDDING_EVENTS",
        message: `正在并行生成关系向量（并发 ${input.concurrency}），已完成 ${embeddedRelations}/${relationInputs.length} 条关系`,
        progress: progressForCompleted(embeddedRelations, Math.max(relationInputs.length, 1), 88, 92),
        chunkCount: input.chunks.length,
        eventCount: eventInputs.length,
        totalChunks: input.chunks.length
      });
      return [relationEmbeddingKey(inputItem.eventId, inputItem.entity), embedding] as const;
    });
    const relationEmbeddings = new Map(relationEmbeddingEntries);

    return eventEmbeddingInputs.map((eventInput) => ({
      ...eventInput,
      entities: eventInput.event.entities.map((entity) => {
        const entityEmbedding = entityEmbeddings.get(entityEmbeddingKey(entity));
        const relationEmbedding = relationEmbeddings.get(relationEmbeddingKey(eventInput.eventId, entity));
        if (!entityEmbedding || !relationEmbedding) {
          throw new Error("实体或关系向量生成不完整");
        }
        return {
          ...entity,
          entityEmbedding,
          relationEmbedding
        };
      })
    }));
  }
}

export const ingestionService = new IngestionService();

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function dedupeEntityEmbeddingInputs(entities: ExtractedEntity[]): EntityEmbeddingInput[] {
  const map = new Map<string, EntityEmbeddingInput>();
  for (const entity of entities) {
    const key = entityEmbeddingKey(entity);
    if (!map.has(key)) {
      map.set(key, { key, entity });
    }
  }
  return [...map.values()];
}

function entityEmbeddingKey(entity: ExtractedEntity): string {
  return `${entity.type.trim().toLowerCase()}\u0000${entity.name.trim().toLowerCase()}`;
}

function relationEmbeddingKey(eventId: string, entity: ExtractedEntity): string {
  return `${eventId}\u0000${entityEmbeddingKey(entity)}\u0000${entity.description.trim().toLowerCase()}`;
}

function progressForCompleted(completed: number, total: number, start: number, end: number): number {
  if (total <= 0) {
    return end;
  }
  return Math.min(end, Math.round(start + (completed / total) * (end - start)));
}
