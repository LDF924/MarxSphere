// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// editor-ai-job-service.ts — R6(闭源 Editor AI job 契约): 统一 job 容器 + SSE 流
// 端点: POST ai/jobs{action,text,context,language,document_id}→{job_id}
//       GET ai/jobs/:id/stream(SSE: delta{content}/done{content}/error{message,is_retriable})
//       POST ai/jobs/:id/cancel | /retry
// 语义对齐闭源: activeJobId 断线恢复(retry 即重新入队), 内存 TTL 30min 清理
import { randomUUID } from "node:crypto";
import { rewriteText, checkFulltext, generateTitleAbstract, formatReferences, type RewriteMode } from "./editor-service.js";
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";
import type { AttachedSse } from "../api/stream-utils.js";

interface AiJob {
  id: string; userId: string; action: string; payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  content: string; result?: unknown; error?: string; createdAt: number;
  model: string;
}
const jobs = new Map<string, AiJob>();
const TTL = 30 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.createdAt > TTL) jobs.delete(id);
}, 5 * 60_000).unref?.();

export function createAiJob(userId: string, body: { action?: string; text?: string; mode?: string; context?: string; document_id?: string; model?: string }): AiJob | null {
  const action = body?.action;
  const ok = ["rewrite", "check", "title", "format_refs"].includes(action ?? "");
  if (!ok) return null;
  const job: AiJob = { id: randomUUID(), userId, action: action!, payload: body as Record<string, unknown>, status: "queued", content: "", createdAt: Date.now(), model: resolveModelAlias(getRoleModel("editor")) };
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
    const mode = String(job.payload.mode ?? "");
    switch (job.action) {
      case "rewrite": {
        // 前端直传后端 RewriteMode; 无 mode 时兜底 polish
        job.result = await rewriteText((mode || "polish") as RewriteMode, text, String(job.payload.context ?? ""));
        job.content = (job.result as { text?: string }).text ?? "";
        break;
      }
      case "check": {
        const r = await checkFulltext(text, mode || "logic");
        job.result = r;
        job.content = renderCheckContent(r);
        break;
      }
      case "title": {
        job.result = await generateTitleAbstract(text, mode);
        job.content = renderTitleContent(mode, job.result as TitleResult);
        break;
      }
      case "format_refs": {
        job.result = await formatReferences(text, (mode === "consistency" ? "consistency" : "format"));
        job.content = renderCitationContent(job.result as CitationResult);
        break;
      }
    }
    job.status = "done";
  } catch (e) {
    job.status = "failed";
    job.error = e instanceof Error ? e.message : String(e);
  }
}

interface TitleResult { title?: string; abstract?: string; keywords?: string[]; alternatives?: string[]; issues?: string[]; reason?: string }
interface CitationResult { text?: string; fixes?: string[]; stats?: { citedInText?: number; listed?: number } }

const mdList = (items?: string[]) => (items ?? []).map((s) => `- ${s}`).join("\n");

interface CheckResult { modeName?: string; checks?: Array<{ name?: string; ok?: boolean; findings?: string[] }> }

/** 全文检查结果 → Markdown(不再直接吐 JSON) */
function renderCheckContent(r: CheckResult): string {
  const checks = r.checks ?? [];
  const parts: string[] = [];
  for (const c of checks) {
    const findings = c.findings ?? [];
    const name = c.name ?? r.modeName ?? "检查结果";
    if (c.ok && !findings.length) {
      parts.push(`## ${name} · 通过\n\n未发现问题。`);
    } else {
      parts.push(`## ${name} · 发现 ${findings.length} 项\n\n${mdList(findings)}`);
    }
  }
  return parts.join("\n\n") || "未返回可用建议, 请稍后重试。";
}

/** 结果区渲染: 只呈现该按钮请求的那部分(mode 决定) */
function renderTitleContent(mode: string, r: TitleResult): string {
  if (mode === "abstract") {
    return `## 优化后的摘要\n\n${r.abstract ?? ""}${r.issues?.length ? `\n\n### 原摘要问题\n\n${mdList(r.issues)}` : ""}`;
  }
  if (mode === "keywords") {
    return `## 关键词候选\n\n${mdList(r.keywords)}${r.reason ? `\n\n> ${r.reason}` : ""}`;
  }
  return `## 推荐标题\n\n${r.title ?? ""}${r.alternatives?.length ? `\n\n### 候选标题\n\n${mdList(r.alternatives)}` : ""}${r.reason ? `\n\n> ${r.reason}` : ""}`;
}

function renderCitationContent(r: CitationResult): string {
  const parts: string[] = [];
  if (r.stats) {
    parts.push(`> 正文标注 ${r.stats.citedInText ?? 0} 处 · 列表 ${r.stats.listed ?? 0} 条`);
  }
  if (r.text?.trim()) parts.push(`## 规范化后的参考文献\n\n${r.text}`);
  if (r.fixes?.length) parts.push(`## 修正点\n\n${mdList(r.fixes)}`);
  return parts.join("\n\n") || "未发现问题。";
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
    sse.send("model", { model: j.model });
    sse.send("done", { content: j.content, result: j.result });
  } else if (j.status === "failed") {
    sse.send("error", { message: j.error ?? "未知错误", is_retriable: true });
  } else {
    sse.send("error", { message: "任务已取消或不存在", is_retriable: true });
  }
  sse.end();
}
