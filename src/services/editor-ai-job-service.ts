// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// editor-ai-job-service.ts — R6(闭源 Editor AI job 契约): 统一 job 容器 + SSE 流
// 端点: POST ai/jobs{action,text,context,language,document_id}→{job_id}
//       GET ai/jobs/:id/stream(SSE: delta{content}/done{content}/error{message,is_retriable})
//       POST ai/jobs/:id/cancel | /retry
// 语义对齐闭源: activeJobId 断线恢复(retry 即重新入队), 内存 TTL 30min 清理
import { randomUUID } from "node:crypto";
import { rewriteText, checkFulltext, generateTitleAbstract, formatReferences } from "./editor-service.js";
import type { AttachedSse } from "../api/stream-utils.js";

interface AiJob {
  id: string; userId: string; action: string; payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  content: string; result?: unknown; error?: string; createdAt: number;
}
const jobs = new Map<string, AiJob>();
const TTL = 30 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.createdAt > TTL) jobs.delete(id);
}, 5 * 60_000).unref?.();

export function createAiJob(userId: string, body: { action?: string; text?: string; context?: string; document_id?: string }): AiJob | null {
  const action = body?.action;
  const ok = ["rewrite", "check", "title", "format_refs"].includes(action ?? "");
  if (!ok) return null;
  const job: AiJob = { id: randomUUID(), userId, action: action!, payload: body as Record<string, unknown>, status: "queued", content: "", createdAt: Date.now() };
  jobs.set(job.id, job);
  void run(job);
  return job;
}
export function getAiJob(userId: string, jobId: string) {
  const j = jobs.get(jobId);
  return j && j.userId === userId ? j : null;
}
export function cancelAiJob(userId: string, jobId: string) {
  const j = getAiJob(userId, jobId);
  if (j && (j.status === "queued" || j.status === "running")) { j.status = "cancelled"; return true; }
  return false;
}
export function retryAiJob(userId: string, jobId: string) {
  const j = getAiJob(userId, jobId);
  if (!j || (j.status !== "failed" && j.status !== "cancelled")) return null;
  j.status = "queued"; j.content = ""; j.error = undefined; j.createdAt = Date.now();
  void run(j);
  return j;
}

async function run(job: AiJob) {
  job.status = "running";
  try {
    const text = String(job.payload.text ?? "");
    switch (job.action) {
      case "rewrite": {
        const mode = String(job.payload.mode ?? "polish") as never;
        job.result = await rewriteText(mode, text);
        job.content = (job.result as { text?: string }).text ?? "";
        break;
      }
      case "check": {
        const mode = String(job.payload.mode ?? "logic");
        job.result = await checkFulltext(text, mode);
        job.content = JSON.stringify(job.result);
        break;
      }
      case "title": {
        job.result = await generateTitleAbstract(text);
        job.content = JSON.stringify(job.result);
        break;
      }
      case "format_refs": {
        job.result = await formatReferences(text);
        job.content = JSON.stringify(job.result);
        break;
      }
    }
    job.status = "done";
  } catch (e) {
    job.status = "failed";
    job.error = e instanceof Error ? e.message : String(e);
  }
}

/** SSE 流: 状态完成前挂起等待; 完成推 delta(全量)+done */
export async function streamAiJob(userId: string, jobId: string, sse: AttachedSse): Promise<void> {
  const j = getAiJob(userId, jobId);
  if (!j) { sse.error({ code: "NOT_FOUND", userMessage: "任务不存在", canRetry: false }); return; }
  // 等 job 非 running(带 5s 轮询, 90 次 ≈ 7.5min 上限)
  for (let i = 0; i < 90 && (j.status === "queued" || j.status === "running"); i++) {
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (j.status === "done") {
    sse.send("delta", { content: j.content });
    sse.send("model", { model: "default" });
    sse.send("done", { content: j.content, result: j.result });
  } else if (j.status === "failed") {
    sse.send("error", { message: j.error ?? "未知错误", is_retriable: true });
  } else {
    sse.send("error", { message: "任务已取消或不存在", is_retriable: true });
  }
  sse.end();
}
