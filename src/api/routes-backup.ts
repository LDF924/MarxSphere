// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// routes-backup.ts — 知识库备份/恢复路由(admin 权限, 异步任务 + 轮询)
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { enqueueJob } from "../services/jobs-service.js";
import { deleteBackup, listBackups, verifyBackup } from "../services/backup-service.js";
import "../services/jobs-handlers-backup.js"; // import 即注册 backup/restore handler

const backupCreateSchema = z.object({
  includeGraphs: z.boolean().optional(),
}).strict();

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  // 创建备份(异步任务, 202 + 轮询 GET /api/jobs)
  app.post("/api/backup", async (request, reply) => {
    const body = backupCreateSchema.parse(request.body ?? {});
    const idempotencyKey = `backup-${new Date().toISOString().slice(0, 10)}`; // 防同日重复
    const job = await enqueueJob({
      jobType: "backup",
      payload: { includeGraphs: body.includeGraphs },
      idempotencyKey,
      timeoutMs: 30 * 60 * 1000, // 30min 防挂死
    });
    return reply.code(201).send({ job });
  });

  // 备份列表
  app.get("/api/backup", async () => {
    const backups = await listBackups();
    return { backups };
  });

  // 校验备份完整性(重算 sha256 对比 manifest)
  app.get("/api/backup/:backupId/verify", async (request) => {
    const { backupId } = z.object({ backupId: z.string().uuid() }).parse(request.params);
    const result = await verifyBackup(backupId);
    return result;
  });

  // 恢复(异步任务, 全量替换)
  app.post("/api/backup/:backupId/restore", async (request, reply) => {
    const { backupId } = z.object({ backupId: z.string().uuid() }).parse(request.params);
    const job = await enqueueJob({
      jobType: "restore",
      payload: { backupId },
      timeoutMs: 60 * 60 * 1000, // 60min(含 Neo4j 重建)
    });
    return reply.code(201).send({ job });
  });

  // 删除备份
  app.delete("/api/backup/:backupId", async (request) => {
    const { backupId } = z.object({ backupId: z.string().uuid() }).parse(request.params);
    await deleteBackup(backupId);
    return { deleted: true };
  });
}
