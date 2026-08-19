// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { config } from "../config/env.js";
import {
  archiveDocument,
  archiveSource,
  createSource,
  deleteDocument,
  deleteSource,
  findDocumentByTitle,
  getEntityDetail,
  getDocumentDetail,
  getEventDetail,
  getProjectGraph,
  getProjectStats,
  listChunksByDocument,
  listDocumentsBySource,
  listEntitiesByDocument,
  listEventsByDocument,
  listSources,
  loadActiveUploadJobs,
  markInterruptedUploadJobsFailed,
  restoreDocument,
  restoreSource,
  updateDocument,
  updateSource,
  upsertUploadJob
} from "../db/repositories.js";
import { ingestionService } from "./ingestion-service.js";
import type { ChunkingMode, IngestProgressStage, IngestProgressUpdate } from "../types.js";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".md", ".txt"]);

type UploadJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export interface UploadJobRecord {
  id: string;
  sourceId: string;
  fileName: string;
  title: string;
  status: UploadJobStatus;
  stage: IngestProgressStage;
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
}

export class WebuiService {
  private readonly uploadJobs = new Map<string, UploadJobRecord>();

  async listProjects(input: {
    limit?: number;
    cursor?: string;
    includeArchived?: boolean;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    return listSources({
      tenantId,
      limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
      cursor: input.cursor,
      includeArchived: input.includeArchived ?? false
    });
  }

  async listSources(input: { limit?: number; cursor?: string }, tenantId = config.DEFAULT_TENANT_ID) {
    return this.listProjects(input, tenantId);
  }

  /** V392: 多租户项目列表（公共库 + 用户自己租户合并, JWT 用户用） */
  async listProjectsByTenants(tenantIds: string[], input: { limit?: number; cursor?: string; includeArchived?: boolean }) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const r = await pool.query(
      `select * from sources
       where tenant_id = any($1::text[])
         and ($2::boolean or archived_at is null)
       order by updated_at desc limit $3`,
      [tenantIds, !!input.includeArchived, limit]
    );
    return r.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      archivedAt: row.archived_at,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
    }));
  }

  async createProject(input: {
    name: string;
    description?: string | null;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const name = input.name.trim();
    if (!name) {
      throw new Error("项目名称不能为空");
    }
    return createSource({
      tenantId,
      name,
      description: input.description?.trim() || undefined,
      metadata: {
        createdVia: "webui",
        semanticType: "project"
      }
    });
  }

  async updateProject(projectId: string, input: {
    name?: string;
    description?: string | null;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const project = await updateSource({
      sourceId: projectId,
      tenantId,
      name: input.name,
      description: input.description
    });
    if (!project) {
      throw new Error("项目不存在");
    }
    return project;
  }

  async archiveProject(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const project = await archiveSource({ sourceId: projectId, tenantId });
    if (!project) {
      throw new Error("项目不存在");
    }
    return project;
  }

  async restoreProject(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const project = await restoreSource({ sourceId: projectId, tenantId });
    if (!project) {
      throw new Error("项目不存在");
    }
    return project;
  }

  async deleteProject(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const deleted = await deleteSource({ sourceId: projectId, tenantId });
    if (!deleted) {
      throw new Error("项目不存在");
    }
    return { deleted: true };
  }

  async uploadDocument(input: {
    title?: string;
    fileName: string;
    content: string;
    sourceId?: string;
    extract?: boolean;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
  }, tenantId = config.DEFAULT_TENANT_ID, jwtUser?: { id: string; tenantId: string; username: string }) {
    // V389: 私有文档 — JWT 用户上传归用户租户（仅自己/企业成员可见）
    const effectiveTenant = jwtUser?.tenantId || tenantId;
    const fileName = input.fileName.trim();
    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error("只支持上传 .md 和 .txt 文档");
    }
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes === 0) {
      throw new Error("上传文档为空");
    }
    if (bytes > MAX_UPLOAD_BYTES) {
      throw new Error(`上传文档超过 ${MAX_UPLOAD_BYTES} 字节限制`);
    }
    if (!input.sourceId) {
      throw new Error("上传文档必须先选择项目");
    }
    const title = input.title?.trim() || fileName.replace(/\.[^.]+$/, "") || "未命名文档";
    // V389: 私有文档 — JWT 用户上传用"用户私有 source"（归用户租户, 仅自己/企业成员可见）
    // 用户私有 source: 不存在则自动创建（名: {username} 的私有库）
    let uploadSourceId = input.sourceId;
    if (jwtUser) {
      try {
        const s = await pool.query("select id from sources where tenant_id = $1 and name = $2", [jwtUser.tenantId, `@${jwtUser.username}-private`]);
        if (s.rows.length > 0) {
          uploadSourceId = s.rows[0].id;
        } else {
          const created = await pool.query(
            "insert into sources (id, name, tenant_id, metadata) values (gen_random_uuid(), $1, $2, $3) returning id",
            [`@${jwtUser.username}-private`, jwtUser.tenantId, JSON.stringify({ private: true, owner: jwtUser.username })]
          );
          uploadSourceId = created.rows[0].id;
        }
      } catch { /* 私有source创建失败则退回默认 */ }
    }

    // 幂等检查：同标题文档已存在 → 直接返回已存在的（不重复入库）
    const existing = await findDocumentByTitle(title, effectiveTenant);
    if (existing) {
      return {
        sourceId: input.sourceId,
        documentId: existing.id,
        chunkCount: 0,
        eventCount: 0,
        taskId: "",
        traceId: "",
        duplicate: true,
        document: existing
      };
    }

    const result = await ingestionService.ingestDocument({
      sourceId: uploadSourceId,  // V389: 私有文档用用户私有 source
      title,
      content: input.content,
      extract: input.extract ?? true,
      chunking: input.chunking,
      metadata: {
        fileName,
        uploadedVia: "webui",
        uploadBytes: bytes
      }
    }, effectiveTenant);  // V389: 私有文档用用户租户
    const document = await getDocumentDetail({
      documentId: result.documentId,
      tenantId: effectiveTenant
    });
    return {
      ...result,
      document
    };
  }

  async createUploadJob(input: {
    title?: string;
    fileName: string;
    content: string;
    sourceId?: string;
    extract?: boolean;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const upload = validateUploadInput(input);
    const now = new Date().toISOString();
    const job: UploadJobRecord = {
      id: randomUUID(),
      sourceId: upload.sourceId,
      fileName: upload.fileName,
      title: upload.title,
      status: "QUEUED",
      stage: "QUEUED",
      message: "等待处理",
      progress: 0,
      createdAt: now,
      updatedAt: now
    };
    this.uploadJobs.set(job.id, job);
    // 持久化：写入 PG（异步，不阻塞提交返回）
    void upsertUploadJob(job).catch(() => { /* 持久化失败不阻塞处理 */ });
    queueMicrotask(() => {
      void this.runUploadJob(job.id, {
        ...upload,
        extract: input.extract,
        chunking: input.chunking
      }, tenantId);
    });
    return job;
  }

  getUploadJob(jobId: string) {
    return this.uploadJobs.get(jobId) ?? null;
  }

  /** 启动恢复：内存 Map 从 PG 加载 + 中断任务标记 FAILED（进程重启后原任务已丢） */
  async restoreUploadJobs() {
    await markInterruptedUploadJobsFailed();
    const active = await loadActiveUploadJobs();
    for (const job of active) {
      this.uploadJobs.set(job.id, job);
    }
    return active.length;
  }

  /** 列出全部上传任务（含历史 COMPLETED/FAILED）——2026-08-12 修复：前端 Jobs 队列显示完整历史 */
  listActiveUploadJobs() {
    return [...this.uploadJobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async runUploadJob(jobId: string, input: {
    title: string;
    fileName: string;
    content: string;
    sourceId: string;
    extract?: boolean;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
    uploadBytes: number;
  }, tenantId: string) {
    this.updateUploadJob(jobId, {
      status: "RUNNING",
      stage: "READING",
      message: "已读取文件，准备提交处理",
      progress: 5
    });
    try {
      const result = await ingestionService.ingestDocument({
        sourceId: input.sourceId,
        title: input.title,
        content: input.content,
        extract: input.extract ?? true,
        chunking: input.chunking,
        metadata: {
          fileName: input.fileName,
          uploadedVia: "webui",
          uploadBytes: input.uploadBytes
        }
      }, tenantId, (update) => this.updateUploadJob(jobId, {
        status: update.stage === "COMPLETED" ? "COMPLETED" : "RUNNING",
        ...update
      }));
      this.updateUploadJob(jobId, {
        status: "COMPLETED",
        stage: "COMPLETED",
        message: `处理完成：${result.chunkCount} 个切片，${result.eventCount} 个事件`,
        progress: 100,
        documentId: result.documentId,
        traceId: result.traceId,
        chunkCount: result.chunkCount,
        eventCount: result.eventCount
      });
    } catch (error) {
      this.updateUploadJob(jobId, {
        status: "FAILED",
        stage: "FAILED",
        message: "处理失败",
        progress: 100,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private updateUploadJob(jobId: string, patch: Partial<UploadJobRecord> & Partial<IngestProgressUpdate>) {
    const existing = this.uploadJobs.get(jobId);
    if (!existing) {
      return;
    }
    const updated = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.uploadJobs.set(jobId, updated);
    // 持久化落盘（异步，进度更新高频调用不阻塞）
    void upsertUploadJob(updated).catch(() => { /* 持久化失败忽略，内存仍是权威 */ });
  }

  async listDocuments(sourceId: string, input: { includeArchived?: boolean } = {}, tenantId = config.DEFAULT_TENANT_ID) {
    return listDocumentsBySource({
      sourceId,
      tenantId,
      limit: 100,
      includeArchived: input.includeArchived ?? false
    });
  }

  async getProjectStats(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getProjectStats({ sourceId: projectId, tenantId });
  }

  async getProjectGraph(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getProjectGraph({ sourceId: projectId, tenantId });
  }

  async updateDocument(documentId: string, input: { title?: string }, tenantId = config.DEFAULT_TENANT_ID) {
    const document = await updateDocument({
      documentId,
      tenantId,
      title: input.title
    });
    if (!document) {
      throw new Error("文档不存在");
    }
    return document;
  }

  async archiveDocument(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const document = await archiveDocument({ documentId, tenantId });
    if (!document) {
      throw new Error("文档不存在");
    }
    return document;
  }

  async restoreDocument(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const document = await restoreDocument({ documentId, tenantId });
    if (!document) {
      throw new Error("文档不存在");
    }
    return document;
  }

  async deleteDocument(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const deleted = await deleteDocument({ documentId, tenantId });
    if (!deleted) {
      throw new Error("文档不存在");
    }
    return { deleted: true };
  }

  async getDocument(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getDocumentDetail({ documentId, tenantId });
  }

  async listChunks(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return listChunksByDocument({ documentId, tenantId });
  }

  async listEvents(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return listEventsByDocument({ documentId, tenantId });
  }

  async listEntities(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return listEntitiesByDocument({ documentId, tenantId });
  }

  async getEvent(eventId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getEventDetail({ eventId, tenantId });
  }

  async getEntity(entityId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getEntityDetail({ entityId, tenantId });
  }
}

export const webuiService = new WebuiService();

function validateUploadInput(input: {
  title?: string;
  fileName: string;
  content: string;
  sourceId?: string;
}) {
  const fileName = input.fileName.trim();
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error("只支持上传 .md 和 .txt 文档");
  }
  const uploadBytes = Buffer.byteLength(input.content, "utf8");
  if (uploadBytes === 0) {
    throw new Error("上传文档为空");
  }
  if (uploadBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`上传文档超过 ${MAX_UPLOAD_BYTES} 字节限制`);
  }
  if (!input.sourceId) {
    throw new Error("上传文档必须先选择项目");
  }
  return {
    fileName,
    title: input.title?.trim() || fileName.replace(/\.[^.]+$/, "") || "未命名文档",
    content: input.content,
    sourceId: input.sourceId,
    uploadBytes
  };
}
