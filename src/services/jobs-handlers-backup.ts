// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// jobs-handlers-backup.ts — 备份/恢复异步任务(import 即注册, 与 jobs-handlers.ts 同模式)
import { registerHandler, type MinionJob } from "./jobs-service.js";
import { createBackup, restoreBackup } from "./backup-service.js";

registerHandler("backup", async (job: MinionJob) => {
  const includeGraphs = job.payload?.includeGraphs !== false;
  const backup = await createBackup({ includeGraphs });
  return {
    ok: true,
    backupId: backup.id,
    name: backup.name,
    size: backup.size,
    warnings: backup.manifest?.warnings ?? [],
  };
});

registerHandler("restore", async (job: MinionJob) => {
  const backupId = String(job.payload?.backupId ?? "");
  if (!backupId) throw new Error("restore job 缺少 backupId");
  const result = await restoreBackup(backupId);
  return { ok: true, ...result };
});
