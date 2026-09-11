// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// editor-ai-job-service.ts — R6(闭源 Editor AI job 契约): 统一 job 容器 + SSE 流
// 端点: POST ai/jobs{action,text,context,language,document_id}→{job_id}
//       GET ai/jobs/:id/stream(SSE: delta{content}/done{content}/error{message,is_retriable})
//       POST ai/jobs/:id/cancel | /retry
// 语义对齐闭源: activeJobId 断线恢复(retry 即重新入队), 内存 TTL 30min 清理
import { randomUUID } from "node:crypto";
import { rewriteText, checkFulltext, generateTitleAbstract, formatReferences, type RewriteMode } from "./editor-service.js";
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";
import { freezeCharge, settleCharge, rollbackFreeze } from "./points-service.js";
import { pointsEnabled, featureCost, InsufficientPointsError } from "./points-gate.js";
import type { AttachedSse } from "../api/stream-utils.js";

interface AiJob {
  id: string; userId: string; action: string; payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  content: string; result?: unknown; error?: string; createdAt: number;
  model: string;
  /** 已冻结的积分(创建时冻结, run() 结束时核销/归还) */
  points?: { cost: number; feature: string };
  /** 用户已取消(取消在途任务无法中断 LLM, 但收尾时不得按成功核销) */
  cancelled?: boolean;
}
const jobs = new Map<string, AiJob>();
const TTL = 30 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.createdAt > TTL) jobs.delete(id);
}, 5 * 60_000).unref?.();

/** 同一用户同时运行的编辑器 AI 任务上限 — 每个任务最长 240s、maxTokens 4000,
 *  无上限时连点 14 个按钮会并发打出 14 路长请求(实测无任何成本/并发护栏) */
const MAX_CONCURRENT_PER_USER = Math.max(1, parseInt(process.env.EDITOR_AI_MAX_CONCURRENT || "3", 10));

/** 该用户当前在跑/排队的任务数 */
export function countActiveAiJobs(userId: string): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.userId === userId && (j.status === "queued" || j.status === "running")) n++;
  }
  return n;
}

export async function createAiJob(userId: string, body: { action?: string; text?: string; mode?: string; context?: string; document_id?: string; model?: string }): Promise<AiJob | null> {
  const action = body?.action;
  const ok = ["rewrite", "check", "title", "format_refs"].includes(action ?? "");
  if (!ok) return null;
  // 并发上限: 超出直接拒绝(前端会收到明确原因), 避免无限并发烧 token
  if (countActiveAiJobs(userId) >= MAX_CONCURRENT_PER_USER) {
    throw new Error(`同时进行的 AI 任务已达上限(${MAX_CONCURRENT_PER_USER} 个), 请等前一个完成或取消`);
  }
  const job: AiJob = { id: randomUUID(), userId, action: action!, payload: body as Record<string, unknown>, status: "queued", content: "", createdAt: Date.now(), model: resolveModelAlias(getRoleModel("editor")) };

  // 积分闸门(2026-09-11): 冻结在**创建时**, 核销/归还在 run() 结束时。
  //   job 是异步的(创建即返回), 用 withPoints 包 run 会导致 HTTP 响应一直挂到任务跑完,
  //   故这里拆开: 冻结失败直接抛(路由转 402), 把 cost 记在 job 上供 run 收尾。
  if (pointsEnabled()) {
    const feature = `editor:${EDITOR_FEATURE[action!] ?? action!}`;
    const cost = featureCost(feature);
    if (cost > 0) {
      const r = await freezeCharge(userId, cost, feature, job.id);
      if (!r.ok) throw new InsufficientPointsError(cost);
      job.points = { cost, feature };
    }
  }

  jobs.set(job.id, job);
  void run(job);
  return job;
}

/** JS 动作名(action: rewrite/check/title/format_refs) → 定价键(editor:rewrite/check/title/refs) */
const EDITOR_FEATURE: Record<string, string> = {
  rewrite: "rewrite",
  check: "check",
  title: "title",
  format_refs: "refs",
};
export function getAiJob(userId: string, jobId: string) {
  const j = jobs.get(jobId);
  return j && j.userId === userId ? j : null;
}
export function cancelAiJob(userId: string, jobId: string) {
  const j = getAiJob(userId, jobId);
  if (j && (j.status === "queued" || j.status === "running")) {
    j.status = "cancelled";
    // 2026-09-11: 必须置独立标志 —— 在途的 LLM 调用无法真正中断(已产生的 token 平台承担),
    //   但 run() 回来后会**无条件**把 status 覆盖成 "done", 导致"点了取消仍按成功核销积分"。
    //   settlePoints 依据 cancelled 决定核销还是归还。
    j.cancelled = true;
    return true;
  }
  return false;
}
export async function retryAiJob(userId: string, jobId: string): Promise<AiJob | null> {
  const j = getAiJob(userId, jobId);
  if (!j || (j.status !== "failed" && j.status !== "cancelled")) return null;
  // 重跑 = 再消耗一次 → 重新冻结(失败的上一轮已在 settlePoints 里归还过)
  if (pointsEnabled()) {
    const feature = `editor:${EDITOR_FEATURE[j.action] ?? j.action}`;
    const cost = featureCost(feature);
    if (cost > 0) {
      const r = await freezeCharge(userId, cost, feature, j.id);
      if (!r.ok) throw new InsufficientPointsError(cost);
      j.points = { cost, feature };
    }
  }
  j.status = "queued"; j.content = ""; j.error = undefined; j.createdAt = Date.now();
  j.cancelled = false;   // 重跑是新的开始, 不清会把跑完的结果又标回 cancelled
  void run(j);
  return j;
}

async function run(job: AiJob) {
  job.status = "running";
  try {
    const text = String(job.payload.text ?? "");
    const mode = String(job.payload.mode ?? "");
    const u = { userId: job.userId };
    switch (job.action) {
      case "rewrite": {
        // 前端直传后端 RewriteMode; 无 mode 时兜底 polish
        job.result = await rewriteText((mode || "polish") as RewriteMode, text, String(job.payload.context ?? ""), u);
        job.content = (job.result as { text?: string }).text ?? "";
        break;
      }
      case "check": {
        const r = await checkFulltext(text, mode || "logic", u);
        job.result = r;
        job.content = renderCheckContent(r);
        break;
      }
      case "title": {
        job.result = await generateTitleAbstract(text, mode, u);
        job.content = renderTitleContent(mode, job.result as TitleResult);
        break;
      }
      case "format_refs": {
        job.result = await formatReferences(text, (mode === "consistency" ? "consistency" : "format"), u);
        job.content = renderCitationContent(job.result as CitationResult);
        break;
      }
    }
    job.status = "done";
  } catch (e) {
    job.status = "failed";
    job.error = e instanceof Error ? e.message : String(e);
  } finally {
    // 取消在途: run 仍会跑完(LLM 调用不可中断), 但不能覆盖成 done, 否则会按成功核销
    if (job.cancelled) job.status = "cancelled";
    await settlePoints(job);
  }
}

/** 任务收尾结算积分: 成功核销, 失败/取消归还(冻结不回滚会永久占用用户余额) */
async function settlePoints(job: AiJob): Promise<void> {
  const p = job.points;
  if (!p) return;
  job.points = undefined;   // 置空防重复结算(retry 会重新冻结)
  try {
    if (job.status === "done") {
      const r = await settleCharge(job.userId, p.cost, p.feature, job.id);
      if (!r.ok) console.error(`[editor-ai] 积分核销失败 ${job.id}: ${r.error}`);
    } else {
      const r = await rollbackFreeze(job.userId, p.cost, p.feature, job.id);
      if (!r.ok) console.error(`[editor-ai] 积分归还失败 ${job.id}: ${r.error}`);
    }
  } catch (e) {
    console.error(`[editor-ai] 积分结算异常 ${job.id}:`, String(e).slice(0, 120));
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
