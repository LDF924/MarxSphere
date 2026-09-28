// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-review-tools.ts — V420: 「论文质量评审」能力工具化(对话页一句话调度审稿子系统)
//
// 覆盖: 建审稿任务 / 历史与报告 / 取消重审删除 / 审稿统计 / 期刊库 / 投稿须知解析 /
//       标准库与维度解析 / 报告导出。目标与 VIEW_TOOLS 同源 —— 用户在对话里说的话
//       ("这篇稿子帮我审一下")要真的能落到后端能力上, 而不是只有界面上那个按钮。
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ 三条实测教训, 改这个文件前先读
//
// ① **必须直连 service, 绝不 fetch 自家 /api/review/***
//    那些端点全部有 `requireUser`; 而 `AgentToolDef.run(args)` 的签名里**没有调用者的 token**,
//    服务器对自己的 fetch 不带 Authorization → 本机豁免也不成立 → 实测返回 401 未登录。
//    调用者身份从 `currentUserId()`(server 的 handler 包进 AsyncLocalStorage)取, 显式传给 service。
//
// ② **审稿的执行者是 SSE 流本身** —— "建 job" ≠ "跑 job"
//    `runReviewJob` 在全仓的唯一调用点是 `server.ts` 的 `GET /api/review/jobs/:id/stream`。
//    只建 job 不驱动流, 任务会**永远停在 queued**(用户侧表现: 进度条不动、没有报告)。
//    工具循环里没有 Fastify reply, 所以本文件自造一个"无人接收"的 AttachedSse 直接 await
//    runReviewJob —— 见下方 detachedSse。这不是绕过 service, 而是**补上本模块架构里那个缺失的执行者**。
//
// ③ **审稿烧钱且慢**: 一篇 3 万字的稿子 = 8-10 段 LLM + 1 次汇总, 分钟级、单次几毛到几块。
//    所以建/重审工具**后台启动**(参考 view_task_create 形态), 返回任务信息即走,
//    绝不阻塞工具循环等它跑完; 要等也必须显式传 waitSec(硬上限 600s)。
//
// ④ **归属过滤靠 userId**: 期刊/标准是 `(user_id=$n or user_id is null)` 的宽松口径,
//    自己的私有条目混在公共库里。工具只暴露"传 id"的写操作, 不额外放宽 —— service 层已按 id+userId 过滤。
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ 工具名与写工具登记(交接线方决定, 本文件**不动** WRITE_TOOLS / TOOL_MIN_ROLE)
//    · 读类一律 `view_review_*`, 执行/生成类 `review_*` —— 与既有 `review_output`
//      (**另一条链路**: 审一段文字本身, 不是本模块的审稿 job)不冲突, 已核过全仓无重名。
//    · 每条工具上方都标了「写 / 读」。会改用户已有数据或落库的(建 job / 增删改库 / 设默认 /
//      解析入库 / 重审 / 后台执行)必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE(analyst 起)。
//      只写 risk 挡不住只读会话 —— 本仓记过这个坑(orch_run 漏登记那次)。
// ─────────────────────────────────────────────────────────────────────────────
import type { AgentToolDef } from "./agent-tool-router.js";
import type { AttachedSse } from "../api/stream-utils.js";
import { currentUserId } from "./request-context.js";
import { pool } from "../db/pool.js";

/** 安全地执行服务调用，异常兜底为可读文本（不抛断工具循环） */
async function safeCall(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e: any) {
    return `（审稿能力不可用: ${String(e?.message || e).slice(0, 150)}）`;
  }
}

/** 需要登录身份的工具统一前置检查（对话触发会带上传入者身份; 后台任务里没有） */
function needUser(): { uid: string } | { error: string } {
  const uid = currentUserId();
  if (!uid) return { error: "（需要登录身份 — 对话触发的工具会带上传入者身份; 后台任务里没有）" };
  return { uid };
}

/** 稿件长度上限与 /api/review/jobs 端点一致（前端 MAX_REVIEW_CHARS 同值）——两端口径必须一样, 否则"前端能建、工具不能建" */
const MAX_REVIEW_CHARS = 120_000;

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 期刊 id 归一。
 *
 * `listJournals` 会把马理论期刊全库(80 本)以 `catalog:<uuid>` 形式并进列表 —— 那批
 * **只存在于 cjournal_journals, 不在 review_journals**, 而 `createReviewJob` 拿它去查
 * `review_journals where id=$1`(uuid 列) → 传 `catalog:xxx` 会直接 22P02 报错(不是"查不到", 是崩)。
 * 所以在工具边界就把这件事说清楚, 而不是让它变成一个 PG 异常。
 */
function normalizeJournalId(raw: string): { id: string } | { error: string } | { none: true } {
  const v = raw.trim();
  if (!v) return { none: true };
  if (v.startsWith("catalog:")) {
    return { error: `（${v} 是期刊全库的只读题录, 不带投稿规则, 无法直接用于审稿 — 先用 view_review_journals 找到同名期刊或 review_journal_create 建一条, 配好规则再选）` };
  }
  if (!uuidRe.test(v)) return { error: `（journalId 需为 uuid, 收到「${v.slice(0, 40)}」; 用 view_review_journals 查）` };
  return { id: v };
}

/**
 * 自造一个"无人接收"的 SSE 句柄, 用来直接 await `runReviewJob`(见文件头 ②)。
 *
 * 设计取舍(每一条都对应一个"看起来能跑, 实际会坏"的做法):
 *   · **不实现 AttachedSse 的 buffer** —— 一份长稿的事件量(每段 delta 里带 10 条问题)会白占内存,
 *     且没人读。send 不是空操作: 把 status 的 message 落到 job.progress, 让前端 1.5s 轮询能看到
 *     "正在审阅第 3/8 段"这类进度(审稿没有事件回放, progress 是唯一的对外进度通道)。
 *   · **closed 恒为 false** —— 语义是"消费者还在, 只是不收集事件"。置 true 会让 service 里
 *     任何一处 `if (sse.closed) return` 提前收摊(那是"客户端断开"的意思, 不是这里的意思)。
 *   · **写 progress 用 jsonb 合并 + 非终态守卫** —— 直接覆盖会把 `rules`(期刊规则, 建 job 时
 *     塞进 progress 的)和 segmentsDone 冲掉; 不带守卫会把 cancelled 覆盖回 streaming。
 *   · 写失败**只吞不抛**: 进度落库失败不该让一次审稿失败(它只是展示层)。
 */
function detachedSse(userId: string, jobId: string): AttachedSse {
  return {
    send(event: string, data: unknown) {
      if (event !== "review.status") return;
      const message = String((data as { message?: unknown })?.message ?? "").trim();
      if (!message) return;
      void pool.query(
        `update review_jobs
            set progress = coalesce(progress,'{}'::jsonb) || jsonb_build_object('message', $3::text),
                updated_at = now()
          where id=$1::uuid and user_id=$2 and status not in ('cancelled','failed','done')`,
        [jobId, userId, message]
      ).catch(() => { /* 进度只是展示层 */ });
    },
    error() { /* 终态由 runReviewJob 自己落库(status/error), 这里没有客户端可推 */ },
    end() { /* 无流可关 */ },
    get closed() { return false; },
  };
}

/**
 * 后台把一条审稿任务跑完(工具循环不等它)。
 *
 * 与 `server.ts` 的 /stream 处理器**逐句对应**: 先抢执行权(任务租约 + 集群槽位), 再 run, 最后 release。
 * 抢不到执行权**不重试** —— 说明另一个执行者(用户开着的页面/别的实例)正在推进它, 结果是共享的,
 * 重试只会叠一份 LLM 账单。
 */
async function driveReviewJob(userId: string, jobId: string): Promise<void> {
  const review = await import("./review-service.js");
  const sse = detachedSse(userId, jobId);
  const gate = await review.acquireReviewSlot({ userId, jobId, sse });
  if (!gate.ok) return;
  try {
    await review.runReviewJob(userId, jobId, sse, { guard: gate.guard });
  } finally {
    gate.release();
  }
}

/** 轮询到终态(仅当调用方显式传 waitSec; 上限见 review_job_create 的说明) */
async function waitForReviewJob(userId: string, jobId: string, waitSec: number): Promise<{ status: string; summary: string }> {
  const review = await import("./review-service.js");
  const deadline = Date.now() + Math.min(Math.max(waitSec, 0), 600) * 1000;
  for (;;) {
    const j = await review.getReviewJob(userId, jobId);
    const status = String(j?.status ?? "unknown");
    if (status === "done" || status === "failed" || status === "cancelled") {
      return { status, summary: await renderJobReport(j) };
    }
    if (Date.now() >= deadline) {
      const prog = (j?.progress ?? {}) as { segmentsDone?: number; totalSegments?: number; message?: string };
      return { status, summary: `【等待超时】仍在 ${status}（${prog.segmentsDone ?? 0}/${prog.totalSegments ?? "?"} 段${prog.message ? `, ${prog.message}` : ""}）— 用 view_review_job 稍后再看。` };
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
}

/** 把一条 job 渲染成可读结果(有报告就出报告摘要, 没有就出状态/进度/失败原因) */
async function renderJobReport(job: Record<string, unknown> | null): Promise<string> {
  if (!job) return "（审稿任务不存在或不属于你 — 用 view_review_jobs 查 id）";
  const id = String(job.id ?? "");
  const title = String(job.title ?? "").trim() || "(无题)";
  const status = String(job.status ?? "unknown");
  const head = `【审稿任务 ${id.slice(0, 8)}…】${title} · ${status}${job.attempt_index ? ` · 第 ${Number(job.attempt_index) + 1} 次审` : ""}`;
  if (status !== "done") {
    const prog = (job.progress ?? {}) as { segmentsDone?: number; totalSegments?: number; message?: string };
    const err = (job.error ?? {}) as { userMessage?: string; code?: string; canRetry?: boolean };
    const bits = [`进度 ${prog.segmentsDone ?? 0}/${prog.totalSegments ?? "?"} 段`];
    if (prog.message) bits.push(prog.message);
    if (err.userMessage) bits.push(`失败/取消原因: ${err.userMessage}${err.canRetry ? "（可重试）" : ""}`);
    return `${head}\n${bits.join(" · ")}`;
  }
  const res = (job.result ?? job.result_json ?? null) as Record<string, unknown> | null;
  if (!res) return `${head}\n（状态已完成但报告为空 — 到「论文评审」页看, 或 review_job_retry 重审）`;
  const dims = (Array.isArray(res.dimensions) ? res.dimensions : []) as Array<Record<string, unknown>>;
  const line = (d: Record<string, unknown>) =>
    `${String(d.name ?? "?")} ${d.score ?? "?"}/${d.maxScore ?? 100}(${d.status ?? "?"})`;
  const issues: Array<Record<string, unknown>> = [];
  for (const d of dims) for (const i of (Array.isArray(d.issues) ? d.issues : [])) {
    if (i && typeof i === "object") issues.push({ ...(i as Record<string, unknown>), _dim: d.name });
  }
  const bySev = (s: string) => issues.filter((i) => String(i.severity ?? "") === s);
  const out: string[] = [head];
  out.push(`总分 ${res.overallScore ?? "?"} · 等级 ${res.grade ?? "?"} · 全文 ${res.wordCount ?? "?"} 字 · 维度问题 ${issues.length} 条`);
  if (res.overallComment || res.overall) out.push(`【总评】${String(res.overallComment ?? res.overall).slice(0, 300)}`);
  if (dims.length) out.push("【维度】" + dims.slice(0, 10).map(line).join(" / "));
  for (const [sev, cn] of [["major", "大修"], ["minor", "小修"], ["suggestion", "建议"]] as const) {
    const rows = bySev(sev).slice(0, 4);
    if (!rows.length) continue;
    out.push(`【${cn} ${bySev(sev).length} 条】` + rows.map((i) => `[${i._dim}] ${String(i.suggestion || i.originalText || i.comment || "").slice(0, 60)}`).join(" | "));
  }
  const sugg = (Array.isArray(res.topSuggestions) ? res.topSuggestions : []).slice(0, 3);
  if (sugg.length) out.push("【首要修改】" + sugg.map((s) => String(s).slice(0, 80)).join(" ; "));
  const hl = (Array.isArray(res.highlights) ? res.highlights : []).slice(0, 3);
  if (hl.length) out.push("【亮点】" + hl.map((h) => String(h).slice(0, 60)).join(" ; "));
  out.push(`（完整批注/评分卡: 到「论文评审」页打开, 或用 review_export_report 导出）`);
  return out.join("\n");
}

export const REVIEW_TOOLS: AgentToolDef[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // 一、审稿任务: 建 / 查 / 取消 / 重审 / 删
  // ═══════════════════════════════════════════════════════════════════════════
  /**
   * 写 —— 建 job **并且**后台真的开审(会落库、会烧 LLM)。**必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE**(analyst 起)。
   *
   * risk 为什么是 "safe" 而不是 "review"(虽然它烧钱):
   *   `view_task_create`(同样后台 spawn + 烧钱)就是 `risk:"safe"`, 与 VIEW_TOOLS 里两个
   *   `*_generate` 同一约定 —— 这里没有先例可破。**risk 的语义是"会不会覆盖别人已写的东西"**,
   *   不是"要不要钱"; 而 `review` 在**编排里等同于失败**(后台任务没有"停下等人点同意"这一态),
   *   把本工具标成 review 就会把"让 AI 自己审一篇稿"从编排里直接拿掉。
   *   ⚠ 所以**只读会话(评审)靠 WRITE_TOOLS 拦, 不能靠 risk 拦** —— 漏登记的后果是真金白银。
   */
  {
    name: "review_job_create", label: "发起论文审稿", risk: "safe",
    description:
      "提交一篇论文发起 AI 审稿(分段审阅 → 逐维度评分卡 → 大修/小修问题清单)。"
      + "**耗时分钟级、单次几毛到几块**(3 万字 ≈ 8-10 段 LLM + 1 次汇总), 所以工具是**后台启动立刻返回**, 不阻塞对话。"
      + "跑完后用 view_review_job 取报告。稿件文本上限 12 万字符(超出截断)。"
      + "稿件来源二选一: 直接给 text, 或给 fileId(用 view_review_files 查已上传的稿件, 服务端自己抽正文)。",
    params: {
      text: { type: "string", desc: "论文全文(纯文本)。与 fileId 二选一; 扫描版 PDF 请改用 fileId(会自动走文本层, 抽不到会告诉你先去做 OCR)" },
      fileId: { type: "string", desc: "已上传稿件的文件 id(用 view_review_files 查)。给了它就自动取正文, 不用再贴 text" },
      title: { type: "string", desc: "论文标题(省略则从正文推断; 用 fileId 时默认取文件名)" },
      journalId: { type: "string", desc: "按某本期刊的投稿规则审(uuid; 用 view_review_journals 查; 省略则用默认标准)" },
      standardId: { type: "string", desc: "按某套评审标准审(uuid; 用 view_review_standards 查)" },
      strictness: { type: "string", desc: "严格度: lax(从宽, 只指硬伤) / standard(适中, 默认) / strict(顶刊外审尺度)" },
      customRequirements: { type: "string", desc: "额外审稿要求(必须在报告里覆盖的点, 如「重点看内生性处理」)" },
      waitSec: { type: "number", desc: "等待秒数(默认 0 = 不等, 立刻返回任务信息; 想拿结果就先等可给 60-300, 硬上限 600)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;

      /**
       * 稿件来源(2026-09-29 用户: "审稿的上传 PDF 要先 file_read/pdf_parse 拿到文本再建 job ——
       *   后端没有 fileId → 纯文本这个能力")。此前只有 text 一条路, 于是用户想审自己上传的
       *   PDF 时, 只能先把正文粘贴进来。现在 fileId 是等价入口: 服务端按 id 取字节、抽文本。
       *
       * ⚠ 扫描件在这里**不自动等 OCR**: 识别是分钟级的, 工具是后台启动立刻返回的语义,
       *   在工具里阻塞几分钟会把对话一起卡住。抽不到就明确告诉用户下一步去哪。
       */
      let text = String(a.text ?? "");
      let srcFileId = "", srcFileName = "", srcFileType = "";
      const fileId = String(a.fileId ?? "").trim();
      if (fileId) {
        const { ensureFileText } = await import("./file-text-service.js");
        const r = await ensureFileText(id.uid, fileId);
        if (!r.ok) {
          if (r.needsOcr) {
            return `（这份文件是扫描件, 没有文字层 —— ${r.error}）\n先到「研途写作舱 → 资料 → 上传」用「识别文字」把它 OCR 成文本, 再回来用这个 fileId 建审稿。`;
          }
          return `（读不到这份文件的正文: ${r.error}）`;
        }
        text = r.text;
        srcFileId = r.fileId; srcFileName = r.fileName; srcFileType = r.ext;
        if (!text.trim()) return "（这份文件抽出来是空的 —— 换个文件或直接用 text 传正文）";
      }
      if (!text.trim()) return "（需要 text 或 fileId: 论文全文）";

      const trunc = text.length > MAX_REVIEW_CHARS;
      const body = text.slice(0, MAX_REVIEW_CHARS);
      const jid = normalizeJournalId(String(a.journalId ?? ""));
      if ("error" in jid) return jid.error;
      const sid = String(a.standardId ?? "").trim();
      const strictness = ["lax", "strict", "standard"].includes(String(a.strictness ?? "")) ? String(a.strictness) : undefined;
      const review = await import("./review-service.js");
      // 与 /api/review/jobs 端点逐句对应(settings 是面板契约, 顶层 id 是老路径, 两个都发 → service 自己读数组合)
      const r = await review.createReviewJob({
        userId: id.uid,
        // 用 fileId 时标题默认取文件名 —— 用户看到的原名比"对话发起的审稿"有用得多
        title: String(a.title ?? "").trim() || srcFileName.replace(/\.[^.]+$/, "") || "对话发起的审稿",
        text: body,
        kind: "text",
        ...(srcFileId ? { sourceFileId: srcFileId, sourceFileName: srcFileName, sourceFileType: srcFileType } : {}),
        ...(("id" in jid) ? { journalId: jid.id } : {}),
        ...(sid && uuidRe.test(sid) ? { standardId: sid } : {}),
        settings: {
          ...(strictness ? { strictness } : {}),
          ...(sid && uuidRe.test(sid) ? { standardIds: [sid] } : {}),
          customRequirements: String(a.customRequirements ?? "").slice(0, 500),
        },
      });
      // 关键: 只建 job 会永远停在 queued —— 必须自己驱动那条流(见文件头 ②)
      void driveReviewJob(id.uid, r.id).catch(() => { /* 失败由 runReviewJob 落库成 failed */ });
      const waitSec = Number(a.waitSec) || 0;
      const dims = (r.dimensions ?? []).map((d) => String((d as { name?: string }).name ?? "")).filter(Boolean);
      const src = srcFileId ? `稿件: ${srcFileName || srcFileId}` : "稿件: 对话内提交的文本";
      const head = `【审稿已发起】任务 ${r.id.slice(0, 8)}…（${body.length} 字 · ${r.segmentCount} 段${trunc ? " · **已截断到 12 万字符**" : ""}）`
        + `\n${src}`
        + `\n维度: ${dims.join(" / ") || "默认 7 维"}`
        + `\n已在后台开审(分钟级、会产生 LLM 费用), 现在就可以去「论文评审」页看进度; 完成后用 view_review_job("${r.id.slice(0, 8)}…") 取报告。`;
      if (waitSec <= 0) return head;
      const w = await waitForReviewJob(id.uid, r.id, waitSec);
      return `${head}\n\n${w.summary}`;
    }),
  },

  /**
   * 读 —— 列出「已上传、可以拿来审稿」的稿件。
   *
   * 由来(2026-09-29): review_job_create 现在能吃 fileId, 但对话里没法知道有哪些 id ——
   *   用户说"审一下我昨天传的那篇", AI 得先看得见它。与 view_viz_data_files 同形。
   */
  {
    name: "view_review_files", label: "可选稿件文件", risk: "safe",
    description: "列出本人已上传的文件(带文件 id 与是否已抽出正文), 返回的 fileId 可直接喂给 review_job_create",
    params: {
      limit: { type: "number", desc: "返回条数(默认 10, 上限 30)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const { pool } = await import("../db/pool.js");
      const limit = Math.min(Math.max(Number(a.limit) || 10, 1), 30);
      const r = await pool.query(
        `select id, filename, size_bytes, extraction, char_count, created_at
           from user_files where user_id=$1 order by created_at desc limit $2`, [id.uid, limit]);
      const rows = r.rows as Array<Record<string, unknown>>;
      if (!rows.length) return "【稿件文件】还没有上传过文件 —— 到「论文评审」页上传稿件, 或直接 review_job_create 时用 text 传全文。";
      const cn: Record<string, string> = {
        "": "待抽取", native: "文本", "text-layer": "PDF 文字层", mammoth: "Word", ocr: "OCR 识别", failed: "抽取失败",
      };
      const body = rows.map((f, i) => {
        const ext = String(f.extraction ?? "");
        const chars = Number(f.char_count) > 0 ? `${Number(f.char_count)} 字` : "";
        return `${i + 1}. ${String(f.filename).slice(0, 46)} — ${cn[ext] ?? ext}${chars ? " · " + chars : ""}`
          + `${ext === "failed" ? "（正文抽不出来, 可能是扫描件, 先去「识别文字」）" : ""}`
          + `\n   fileId: file_${String(f.id)}`;
      });
      return `【稿件文件】${rows.length} 个\n${body.join("\n")}`;
    }),
  },

  /** 读 —— 只查列表, 不改数据 */
  {
    name: "view_review_jobs", label: "审稿历史", risk: "safe",
    description: "列出本人的往期审稿记录(标题/状态/第几次审/总分), 重审链只列最新一次",
    params: {
      limit: { type: "number", desc: "返回条数(默认 10, 上限 50)" },
      offset: { type: "number", desc: "跳过条数(翻页用, 默认 0)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const review = await import("./review-service.js");
      const limit = Math.min(Math.max(Number(a.limit) || 10, 1), 50);
      const offset = Math.max(Number(a.offset) || 0, 0);
      const [jobs, total] = await Promise.all([
        review.listReviewJobs(id.uid, limit, offset),
        review.countReviewJobs(id.uid),
      ]);
      const rows = jobs as Array<Record<string, unknown>>;
      if (!rows.length) return `【往期审稿】还没有记录（共 ${total} 条）— 用 review_job_create 发起一次。`;
      const cn: Record<string, string> = { queued: "排队中", running: "执行中", segmenting: "分段审阅中", summarizing: "汇总中", streaming: "审阅中", paused: "已暂停", done: "已完成", failed: "失败", cancelled: "已取消" };
      const body = rows.map((j, i) =>
        `${i + 1}. ${String(j.paper_title ?? j.title ?? "(无题)").slice(0, 40)} — ${cn[String(j.status)] ?? j.status}`
        + `${Number(j.attempt_index) > 0 ? ` · 第 ${Number(j.attempt_index) + 1} 次审` : ""}`
        + ` · ${String(j.created_at).slice(0, 10)} · id ${String(j.id).slice(0, 8)}…`).join("\n");
      return `【往期审稿】${rows.length}/${total} 条\n${body}`;
    }),
  },

  /** 读 —— 只是查一条任务的报告/状态 */
  {
    name: "view_review_job", label: "审稿报告详情", risk: "safe",
    description: "取某次审稿的完整报告(总分/等级/各维度评分/大修小修改建议/亮点), 或查看尚未完成的任务进度与失败原因",
    params: {
      jobId: { type: "string", desc: "审稿任务 id(完整 uuid 或其前 8 位; 省略则取最近的一次审稿)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const review = await import("./review-service.js");
      const jobId = await resolveReviewJobId(id.uid, String(a.jobId ?? ""));
      if (!jobId) return "（没有找到审稿记录 — 先用 view_review_jobs 看有哪些）";
      if ("error" in jobId) return jobId.error;
      const job = await review.getReviewJob(id.uid, jobId.id) as Record<string, unknown> | null;
      return await renderJobReport(job);
    }),
  },

  /** 写 —— 把用户的任务置成 cancelled(改已有数据)。**必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE**/
  {
    name: "review_job_cancel", label: "取消审稿", risk: "review",
    description: "取消一次正在排队/执行的审稿(协作式: 当前段 LLM 返回后即停, 不再烧后续费用)。已完成的报告不会被撤掉",
    params: {
      jobId: { type: "string", desc: "审稿任务 id(完整 uuid 或其前 8 位; 省略则取最近的一次审稿)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const review = await import("./review-service.js");
      const jobId = await resolveReviewJobId(id.uid, String(a.jobId ?? ""));
      if (!jobId) return "（没有找到审稿记录）";
      if ("error" in jobId) return jobId.error;
      const before = await review.getReviewJob(id.uid, jobId.id) as Record<string, unknown> | null;
      if (!before) return "（审稿任务不存在或不属于你）";
      const r = await review.controlReviewJob(id.uid, jobId.id, "cancel") as Record<string, unknown> | null;
      const status = String(r?.status ?? "unknown");
      if (status === String(before.status)) {
        return `（没有可取消的: 任务当前是 ${status}${status === "done" ? " — 已完成的报告保留着" : ""}）`;
      }
      return `【已取消】任务 ${jobId.id.slice(0, 8)}… → ${status}（当前段 LLM 返回后即停; 报告不会产出）`;
    }),
  },

  /**
   * 写 —— 复制出新 job 并**后台开跑**(落库 + 烧 LLM)。**必须登记进 WRITE_TOOLS +
   * TOOL_MIN_ROLE**。与 review_job_create 同为 `risk:"safe"`(理由见上: risk 管"覆盖", 不管"烧钱";
   * 拦只读会话靠 WRITE_TOOLS —— 本工具一次重审就是一份完整审稿账单, 漏登记代价最大)。
   */
  {
    name: "review_job_retry", label: "重审", risk: "safe",
    description:
      "对某次审稿发起重审: 复制原任务(稿件/期刊/标准/严格度全沿用)生成一条新记录并后台开跑。"
      + "**同样烧钱、分钟级**。已完成的任务也可以重审(会多出第 N 次审的记录, 原报告不删)",
    params: {
      jobId: { type: "string", desc: "原审稿任务 id(完整 uuid 或其前 8 位; 省略则取最近的一次审稿)" },
      waitSec: { type: "number", desc: "等待秒数(默认 0 = 立刻返回; 硬上限 600)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const review = await import("./review-service.js");
      const jobId = await resolveReviewJobId(id.uid, String(a.jobId ?? ""));
      if (!jobId) return "（没有找到审稿记录）";
      if ("error" in jobId) return jobId.error;
      const r = await review.controlReviewJob(id.uid, jobId.id, "retry") as Record<string, unknown> | null;
      if (!r) return "（审稿任务不存在或不属于你）";
      const newId = String(r.id ?? jobId.id);
      // controlReviewJob 的 retry 只在"非活跃"任务上生效; 活跃任务会原样返回旧 job —— 说清楚而不是假装重审了
      if (newId === jobId.id) return `（任务当前是 ${r.status} — 正在跑的任务不能重审, 先 review_job_cancel 再重审）`;
      void driveReviewJob(id.uid, newId).catch(() => {});
      const waitSec = Number(a.waitSec) || 0;
      const head = `【已发起重审】新任务 ${newId.slice(0, 8)}…（沿用原稿与规则, 后台开跑中）`;
      if (waitSec <= 0) return `${head}\n完成后用 view_review_job("${newId.slice(0, 8)}…") 取报告。`;
      const w = await waitForReviewJob(id.uid, newId, waitSec);
      return `${head}\n\n${w.summary}`;
    }),
  },

  /** 写 —— 删掉用户已有记录(不可逆)。必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE */
  {
    name: "review_job_delete", label: "删除审稿记录", risk: "review",
    description: "删除一条审稿记录(报告+批注+进度一并删, **不可恢复**)。正在执行/排队的任务删不掉, 要先取消",
    params: {
      jobId: { type: "string", required: true, desc: "审稿任务 id(完整 uuid 或其前 8 位; 用 view_review_jobs 查)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const review = await import("./review-service.js");
      const jobId = await resolveReviewJobId(id.uid, String(a.jobId ?? ""));
      if (!jobId) return "（需要 jobId — 用 view_review_jobs 查）";
      if ("error" in jobId) return jobId.error;
      const ok = await review.deleteReviewJob(id.uid, jobId.id);
      if (ok) return `【已删除】审稿记录 ${jobId.id.slice(0, 8)}…`;
      // 删不掉只有两种原因(service 的语义): 不是你的/不存在, 或确实还在跑
      const job = await review.getReviewJob(id.uid, jobId.id) as Record<string, unknown> | null;
      if (!job) return `（审稿任务 ${jobId.id.slice(0, 8)}… 不存在或不属于你）`;
      return `（任务正在 ${String(job.status)} — 先 review_job_cancel 再删除）`;
    }),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 二、统计 / 期刊库 / 标准库
  // ═══════════════════════════════════════════════════════════════════════════
  /** 读 —— 纯统计查询 */
  {
    name: "view_review_stats", label: "审稿统计", risk: "safe",
    description: "汇总本人的审稿数据: 已完成篇数/均分/等级分布/问题严重度分布/高发维度/各期刊审稿均分",
    params: {},
    run: async () => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const review = await import("./review-service.js");
      const s = await review.reviewStats(id.uid);
      const o = s.overall;
      if (!o.total) return "【审稿统计】还没有已完成(带打分)的审稿 — 先用 review_job_create 跑一篇。";
      const out = [`【审稿统计】已完成 ${o.total} 篇 · 有分数 ${o.scored} 篇 · 均分 ${o.avgScore ?? "—"}`];
      if (o.grades.length) out.push("等级分布: " + o.grades.map((g) => `${g.grade} ${g.count}`).join(" / "));
      if (o.severity.length) out.push("问题严重度: " + o.severity.map((x) => `${x.severity} ${x.count}`).join(" / "));
      if (o.topIssueDimensions.length) out.push("高发维度: " + o.topIssueDimensions.slice(0, 6).map((d) => `${d.name} ${d.count}`).join(" / "));
      if (s.journals.length) out.push("按期刊: " + s.journals.slice(0, 6).map((j) => `${j.name} ${j.avgScore ?? "—"}分(${j.jobs}篇)`).join(" / "));
      return out.join("\n");
    }),
  },
  /** 读 —— 只查期刊库 */
  {
    name: "view_review_journals", label: "期刊库", risk: "safe",
    description: "列出期刊库(自建条目 + 马理论期刊全库 80 本只读题录): 名称/级别/规则来源/用过几次, 并给出可用于审稿的 id",
    params: {
      query: { type: "string", desc: "按刊名关键词过滤" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const review = await import("./review-service.js");
      const all = await review.listJournals(id.uid) as Array<Record<string, unknown>>;
      const kw = String(a.query ?? "").trim();
      const hit = kw ? all.filter((j) => String(j.name ?? "").includes(kw)) : all;
      const configured = hit.filter((j) => !j.isCatalog);
      const catalog = hit.filter((j) => j.isCatalog);
      const ruleCn = (j: Record<string, unknown>) =>
        j.ruleSource === "ai" ? `AI规则${j.canReparse ? "(可回退)" : ""}` : j.ruleSource === "manual" ? "手填规则" : "无规则";
      const rows = configured.slice(0, 20).map((j, i) =>
        `${i + 1}. ${j.name} [${j.level || j.category || "—"}] ${ruleCn(j)} 用过${j.useCount ?? 0}次 id ${String(j.id).slice(0, 8)}…`).join("\n");
      const catNames = catalog.slice(0, 25).map((j) => String(j.name)).join("、");
      let out = `【期刊库】自建/已配规则 ${configured.length} 条`
        + `${kw ? `(按「${kw}」命中)` : ""}${configured.length ? `\n${rows}` : ""}`;
      if (catalog.length) out += `\n【全库题录 ${catalog.length} 本, 只有题录没有投稿规则 — 要用于审稿得先配规则】${catNames}${catalog.length > 25 ? "…" : ""}`;
      out += `\n（用 review_journal_create 建刊 / review_journal_batch_parse 一次粘多刊须知 / review_journal_reparse 回退重解析）`;
      return out;
    }),
  },
  /** 写 —— 新增期刊条目(落库)。必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE */
  {
    name: "review_journal_create", label: "新增期刊", risk: "review",
    description: "在期刊库新增(或补规则)一条期刊条目, 之后审稿可选它按该刊要求判审。手填/手改的规则标记为 manual(不会被 AI 重解析覆盖)",
    params: {
      name: { type: "string", required: true, desc: "期刊名" },
      level: { type: "string", desc: "级别/分类(如 南核/北核/CSSCI/其他)" },
      scope: { type: "string", desc: "收录范围(一句话)" },
      submissionGuideText: { type: "string", desc: "投稿须知原文(留档用; 想要结构化规则请用 review_guide_parse 解析后再填 structuredRules)" },
      structuredRules: { type: "string", desc: "结构化规则 JSON 字符串({formatRules,reviewFocus,citationRules,scope})" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const name = String(a.name ?? "").trim();
      if (!name) return "（需要 name: 期刊名）";
      let rules: Record<string, unknown> = {};
      const rawRules = String(a.structuredRules ?? "").trim();
      if (rawRules) {
        try {
          const parsed = JSON.parse(rawRules);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "（structuredRules 需为 JSON 对象）";
          rules = parsed as Record<string, unknown>;
        } catch { return "（structuredRules 不是合法 JSON — 先用 review_guide_parse 解析投稿须知, 把结果原样传进来）"; }
      }
      const review = await import("./review-service.js");
      const r = await review.createJournal({
        name,
        level: String(a.level ?? "").trim() || "other",
        scope: String(a.scope ?? "").trim(),
        submissionGuideText: String(a.submissionGuideText ?? ""),
        structuredRules: rules,
        userId: id.uid,
      });
      return `【期刊已新增】${name}（id ${String(r.id).slice(0, 8)}…）${Object.keys(rules).length ? "含结构化规则" : "暂无规则 — 可用 review_journal_batch_parse / review_journal_reparse 补"}`;
    }),
  },
  /** 写 —— 改用户已有期刊条目。**必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE**/
  {
    name: "review_journal_update", label: "修改期刊", risk: "review",
    description: "修改期刊库条目(刊名/级别/范围/投稿须知原文/结构化规则)。改了规则来源会转成 manual(保住你的手改, 不被 AI 重解析覆盖)",
    params: {
      journalId: { type: "string", required: true, desc: "期刊 id(uuid, 用 view_review_journals 查)" },
      name: { type: "string", desc: "新刊名" },
      level: { type: "string", desc: "新级别/分类" },
      scope: { type: "string", desc: "新收录范围" },
      submissionGuideText: { type: "string", desc: "新投稿须知原文" },
      structuredRules: { type: "string", desc: "新结构化规则 JSON 字符串" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const journalId = String(a.journalId ?? "").trim();
      if (!uuidRe.test(journalId)) return "（需要 journalId(uuid) — 用 view_review_journals 查）";
      const patch: Record<string, unknown> = {};
      if (a.name !== undefined) patch.name = String(a.name);
      if (a.level !== undefined) patch.level = String(a.level);
      if (a.scope !== undefined) patch.scope = String(a.scope);
      if (a.submissionGuideText !== undefined) patch.submissionGuideText = String(a.submissionGuideText);
      if (a.structuredRules !== undefined) {
        try {
          const p = JSON.parse(String(a.structuredRules));
          if (!p || typeof p !== "object" || Array.isArray(p)) return "（structuredRules 需为 JSON 对象）";
          patch.structuredRules = p;
        } catch { return "（structuredRules 不是合法 JSON）"; }
      }
      if (!Object.keys(patch).length) return "（没有要改的字段 — 至少给一个 name/level/scope/submissionGuideText/structuredRules）";
      const review = await import("./review-service.js");
      const r = await review.updateJournal(id.uid, journalId, patch);
      if (!r) return `（期刊 ${journalId.slice(0, 8)}… 不存在或无权限）`;
      return `【期刊已更新】${journalId.slice(0, 8)}…（改了 ${Object.keys(patch).join("/")}${patch.structuredRules !== undefined ? "; 规则来源已转 manual" : ""}）`;
    }),
  },
  /** 写 —— 删期刊条目(不可逆)。必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE */
  {
    name: "review_journal_delete", label: "删除期刊", risk: "review",
    description: "从期刊库删除一条条目(**不可恢复**; 已用它审过的历史报告不受影响)",
    params: {
      journalId: { type: "string", required: true, desc: "期刊 id(uuid, 用 view_review_journals 查)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const journalId = String(a.journalId ?? "").trim();
      if (!uuidRe.test(journalId)) return "（需要 journalId(uuid) — 用 view_review_journals 查）";
      const review = await import("./review-service.js");
      const r = await review.deleteJournal(id.uid, journalId);
      if (!r) return `（期刊 ${journalId.slice(0, 8)}… 不存在或无权限; 公共库(catalog)题录不能删）`;
      return `【已删除期刊】${journalId.slice(0, 8)}…`;
    }),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 三、投稿须知解析(纯解析不落库 → safe; 批量落库 → review)
  // ═══════════════════════════════════════════════════════════════════════════
  /** 读 —— 纯解析, 结果只在对话里, 不落库。但**会烧一次 LLM**, 接线方若按"写"记也可接受 */
  {
    name: "review_guide_parse", label: "解析投稿须知", risk: "safe",
    description: "把一段期刊投稿须知原文交给 AI 解析成结构化规则(格式要求/审稿关注点/引文规范/收录范围)。**不落库、只是解析结果**, 约 10-30 秒",
    params: {
      text: { type: "string", required: true, desc: "投稿须知原文(≤6000 字生效, 超出截断)" },
    },
    run: async (a) => safeCall(async () => {
      const text = String(a.text ?? "");
      if (!text.trim()) return "（需要 text: 投稿须知原文）";
      const { parseSubmissionGuide } = await import("./review-service.js");
      const p = await parseSubmissionGuide(text);
      const err = (p as { error?: string }).error;
      if (err) return `（解析失败: ${err}）`;
      const fmt = p.formatRules ?? [], focus = p.reviewFocus ?? [], cite = p.citationRules ?? [];
      return `【投稿须知解析】格式要求 ${fmt.length} / 审稿关注点 ${focus.length} / 引文规范 ${cite.length}\n收录范围: ${p.scope || "—"}`
        + `\n关注点: ${focus.slice(0, 8).join("、") || "—"}`
        + `\n格式: ${fmt.slice(0, 6).join("、") || "—"}`
        + `\n（要入库: 把这段原文交给 review_journal_batch_parse, 或建刊时填 structuredRules）`;
    }),
  },
  /** 读 —— 纯切分, 不烧 token */
  {
    name: "view_review_guide_split", label: "多刊须知切分预览", risk: "safe",
    description: "一次粘贴了多家期刊的投稿须知时, 先看会怎么切分(**纯规则切分, 不烧 token**), 确认后再用 review_journal_batch_parse 真正解析入库",
    params: {
      text: { type: "string", required: true, desc: "多刊投稿须知原文(建议用《刊名》投稿须知 作分隔标题)" },
    },
    run: async (a) => safeCall(async () => {
      const text = String(a.text ?? "");
      if (!text.trim()) return "（需要 text: 投稿须知原文）";
      const { splitMultiJournalText } = await import("./review-service.js");
      const blocks = splitMultiJournalText(text);
      if (!blocks.length) return "（没有内容可切）";
      const rows = blocks.map((b, i) => `${i + 1}. ${b.name || "(未识别刊名 — 将用「待命名期刊-N」)"} — ${b.text.length} 字: ${b.text.replace(/\s+/g, " ").slice(0, 60)}…`).join("\n");
      return `【切分预览】${blocks.length} 块（宁少切不多切: 只认明确的标题行）\n${rows}`
        + `${blocks.length === 1 ? "\n⚠ 只切出 1 块 — 整段会被当成一本刊解析; 若确实有多本, 请用《刊名》投稿须知 作分隔" : ""}`;
    }),
  },
  /** 写 —— 批量解析**并入库**(改/建用户期刊库 + 多次 LLM)。**必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE** */
  {
    name: "review_journal_batch_parse", label: "批量解析入库", risk: "review",
    description:
      "一次粘贴多刊投稿须知 → 逐刊 AI 解析并写入期刊库。**每刊一次 LLM 调用, 几本就要几十秒到分钟级**(烧钱), 所以是同步等待、但请先 view_review_guide_split 确认切分。"
      + "已有规则的自建刊默认**不覆盖**(要覆盖得显式 overwrite)",
    params: {
      text: { type: "string", required: true, desc: "多刊投稿须知原文(《刊名》投稿须知 作分隔)" },
      overwrite: { type: "boolean", desc: "已有规则的自建刊是否覆盖(默认 false)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const text = String(a.text ?? "");
      if (!text.trim()) return "（需要 text: 投稿须知原文）";
      const review = await import("./review-service.js");
      const r = await review.batchParseJournals({ text, userId: id.uid, overwrite: a.overwrite === true });
      const s = r.summary;
      const rows = r.results.slice(0, 15).map((x, i) =>
        `${i + 1}. ${x.name} — ${x.ok ? `已${x.created ? "新建" : "更新"}, ${x.ruleCount ?? 0} 条规则` : `跳过/失败: ${x.error ?? "?"}`}`).join("\n");
      return `【批量解析完成】共 ${s.total} 刊: 成功 ${s.ok}(新建 ${s.created}) / 未处理 ${s.failed}\n${rows}`
        + `\n（用 view_review_journals 复核; 抽歪的条目可用 review_journal_reparse 回退重解析）`;
    }),
  },
  /** 写 —— 覆盖该刊已有规则(改用户数据 + 一次 LLM)。**必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE** */
  {
    name: "review_journal_reparse", label: "回退重解析期刊规则", risk: "review",
    description: "用当初喂给 AI 的投稿须知原文重新解析一遍某刊规则(AI 抽歪时的回退)。改过规则或没有原文的刊会被如实拒绝, 不会拿别的文本硬凑。约 10-30 秒",
    params: {
      journalId: { type: "string", required: true, desc: "期刊 id(uuid, 用 view_review_journals 查; 需该刊规则来源为 AI 且留了原文)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const journalId = String(a.journalId ?? "").trim();
      if (!uuidRe.test(journalId)) return "（需要 journalId(uuid) — 用 view_review_journals 查）";
      const review = await import("./review-service.js");
      const r = await review.reparseJournalRules(id.uid, journalId);
      if (!r.ok) return `（无法回退重解析: ${r.error}）`;
      const rules = r.rules as { formatRules?: unknown[]; reviewFocus?: unknown[]; citationRules?: unknown[]; scope?: string };
      return `【已重解析】${journalId.slice(0, 8)}… — ${r.ruleCount} 条规则\n关注点: ${(rules.reviewFocus ?? []).slice(0, 6).join("、") || "—"}\n范围: ${rules.scope || "—"}`;
    }),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 四、评审标准库
  // ═══════════════════════════════════════════════════════════════════════════
  /** 读 —— 只查标准库 */
  {
    name: "view_review_standards", label: "评审标准库", risk: "safe",
    description: "列出评审标准库(自建 + 内置): 名称/维度数与权重/是否为默认/用过几次。审稿时选标准就是选这里的 id",
    params: {},
    run: async () => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const review = await import("./review-service.js");
      const all = await review.listStandards(id.uid) as Array<Record<string, unknown>>;
      if (!all.length) return "【评审标准库】空 — 用 review_standard_parse 解析一份评分标准并 review_standard_create 入库。";
      const rows = all.slice(0, 20).map((s, i) => {
        const dims = (Array.isArray(s.dimensions) ? s.dimensions : []) as Array<Record<string, unknown>>;
        const d = dims.map((x) => `${x.name ?? x.key}(${x.weight ?? 1})`).slice(0, 5).join(" ");
        return `${i + 1}. ${s.name}${s.isDefault ? " [默认]" : ""}${s.isBuiltIn ? " [内置]" : ""} — ${dims.length} 维: ${d || "—"} · 用过${s.useCount ?? 0}次 · id ${String(s.id).slice(0, 8)}…`;
      }).join("\n");
      return `【评审标准库】${all.length} 套\n${rows}`;
    }),
  },
  /** 读 —— 纯解析不落库(但烧一次 LLM) */
  {
    name: "review_standard_parse", label: "解析评分标准", risk: "safe",
    description: "把一份论文评分标准/审稿要点原文交给 AI 解析成结构化维度(名称/权重/评分细则, 最多 12 维)。**不落库**, 约 10-30 秒; 要入库用 review_standard_create",
    params: {
      text: { type: "string", required: true, desc: "评分标准/审稿要点原文(≤6000 字生效)" },
    },
    run: async (a) => safeCall(async () => {
      const text = String(a.text ?? "");
      if (!text.trim()) return "（需要 text: 评分标准原文）";
      const { parseStandardText } = await import("./review-service.js");
      const p = await parseStandardText(text);
      const err = (p as { error?: string }).error;
      const dims = (p.dimensions ?? []) as Array<Record<string, unknown>>;
      if (!dims.length) return `（解析失败: ${err ?? "没有解析出维度"}）`;
      return `【评分标准解析】${dims.length} 维\n` + dims.map((d, i) =>
        `${i + 1}. ${d.name ?? d.key} 权重${d.weight ?? "?"} — ${String(d.criteria ?? "").slice(0, 70)}`).join("\n")
        + `\n（要入库: 把这份 dimensions JSON 传给 review_standard_create）`;
    }),
  },
  /** 写 —— 建标准(落库)。必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE */
  {
    name: "review_standard_create", label: "新增评审标准", risk: "review",
    description: "把一套评分维度存进评审标准库, 之后审稿可选它。维度至少一条, 否则直接拒绝",
    params: {
      name: { type: "string", required: true, desc: "标准名(如 马理论C刊外审7维)" },
      sourceText: { type: "string", desc: "标准原文(留档用)" },
      dimensions: { type: "string", required: true, desc: "维度 JSON 数组字符串([{key,name,weight,criteria,min,max}]; 通常来自 review_standard_parse)" },
      isDefault: { type: "boolean", desc: "是否直接设为默认标准(默认 false)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const name = String(a.name ?? "").trim();
      if (!name) return "（需要 name: 标准名）";
      let dims: unknown[];
      try {
        const p = JSON.parse(String(a.dimensions ?? ""));
        if (!Array.isArray(p) || !p.length) return "（dimensions 需为非空 JSON 数组 — 先用 review_standard_parse 解析评分标准原文）";
        dims = p;
      } catch { return "（dimensions 不是合法 JSON 数组）"; }
      const review = await import("./review-service.js");
      // ⚠ createStandard 对空维度会 throw(EMPTY_DIMENSIONS), safeCall 会兜成"不可用"文案 —— 上面已先拦
      const r = await review.createStandard({
        name, sourceText: String(a.sourceText ?? ""), dimensions: dims, userId: id.uid,
      });
      if (a.isDefault === true) await review.setDefaultStandard(id.uid, String(r.id), true);
      return `【标准已新增】${name}（${dims.length} 维, id ${String(r.id).slice(0, 8)}…${a.isDefault === true ? ", 已设为默认" : ""}）`;
    }),
  },
  /** 写 —— 改标准(落库)。必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE */
  {
    name: "review_standard_update", label: "修改评审标准", risk: "review",
    description: "修改标准库条目(名称/原文/维度/默认标记)。改维度会整组替换(不是逐条合并)",
    params: {
      standardId: { type: "string", required: true, desc: "标准 id(uuid, 用 view_review_standards 查)" },
      name: { type: "string", desc: "新名称" },
      sourceText: { type: "string", desc: "新标准原文" },
      dimensions: { type: "string", desc: "新维度 JSON 数组字符串(整组替换)" },
      isDefault: { type: "boolean", desc: "是否设为默认(会清掉原来的默认)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const standardId = String(a.standardId ?? "").trim();
      if (!uuidRe.test(standardId)) return "（需要 standardId(uuid) — 用 view_review_standards 查）";
      const patch: Record<string, unknown> = {};
      if (a.name !== undefined) patch.name = String(a.name);
      if (a.sourceText !== undefined) patch.sourceText = String(a.sourceText);
      if (a.isDefault !== undefined) patch.isDefault = a.isDefault === true;
      if (a.dimensions !== undefined) {
        try {
          const p = JSON.parse(String(a.dimensions));
          if (!Array.isArray(p) || !p.length) return "（dimensions 需为非空 JSON 数组）";
          patch.dimensions = p;
        } catch { return "（dimensions 不是合法 JSON 数组）"; }
      }
      if (!Object.keys(patch).length) return "（没有要改的字段）";
      const review = await import("./review-service.js");
      const r = await review.updateStandard(id.uid, standardId, patch);
      if (!r) return `（标准 ${standardId.slice(0, 8)}… 不存在或无权限）`;
      return `【标准已更新】${standardId.slice(0, 8)}…（改了 ${Object.keys(patch).join("/")}）`;
    }),
  },
  /** 写 —— 删标准。**必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE**/
  {
    name: "review_standard_delete", label: "删除评审标准", risk: "review",
    description: "从标准库删除一套评审标准(**不可恢复**; 已用它审过的历史报告不受影响)",
    params: {
      standardId: { type: "string", required: true, desc: "标准 id(uuid, 用 view_review_standards 查)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const standardId = String(a.standardId ?? "").trim();
      if (!uuidRe.test(standardId)) return "（需要 standardId(uuid) — 用 view_review_standards 查）";
      const review = await import("./review-service.js");
      const r = await review.deleteStandard(id.uid, standardId);
      if (!r) return `（标准 ${standardId.slice(0, 8)}… 不存在或无权限）`;
      return `【已删除标准】${standardId.slice(0, 8)}…`;
    }),
  },
  /** 写 —— 改用户的"默认审稿标准"这一项设置。**必须登记进 WRITE_TOOLS + TOOL_MIN_ROLE**/
  {
    name: "review_standard_set_default", label: "设默认评审标准", risk: "review",
    description: "把某套标准设为(或取消)默认 —— 之后不指定标准的审稿都按它判。**设一个会清掉原来的默认**(同一时刻只有一个默认)",
    params: {
      standardId: { type: "string", required: true, desc: "标准 id(uuid, 用 view_review_standards 查)" },
      isDefault: { type: "boolean", desc: "true 设为默认(默认) / false 取消" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const standardId = String(a.standardId ?? "").trim();
      if (!uuidRe.test(standardId)) return "（需要 standardId(uuid) — 用 view_review_standards 查）";
      const review = await import("./review-service.js");
      const want = a.isDefault !== false;
      const r = await review.setDefaultStandard(id.uid, standardId, want);
      if (!r) return `（标准 ${standardId.slice(0, 8)}… 不存在或无权限 — 原有默认**未被改动**）`;
      return want
        ? `【已设为默认】${standardId.slice(0, 8)}…（原来的默认已自动取消; 之后不指定标准的审稿都按它判）`
        : `【已取消默认】${standardId.slice(0, 8)}…（之后审稿回到内置 7 维默认）`;
    }),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 五、报告导出
  // ═══════════════════════════════════════════════════════════════════════════
  /** 读 —— 导出是"读报告 → 渲染文件", 不改任何已有数据(只在本地落一个产物文件)。按"读"记 */
  {
    name: "review_export_report", label: "导出审稿报告", risk: "safe",
    description:
      "把某次审稿的报告导出成文件(html 排版报告 / docx Word 批注 二选一, 都落成文件给你路径)。"
      + "html 约 1 秒; **docx 走 Python(python-docx), 可能十几秒**",
    params: {
      jobId: { type: "string", desc: "审稿任务 id(完整 uuid 或其前 8 位; 省略则取最近的一次审稿)" },
      format: { type: "string", desc: "导出格式: html(默认, 排版报告可打印/存 PDF) / docx(Word 批注稿)" },
    },
    run: async (a) => safeCall(async () => {
      const id = needUser();
      if ("error" in id) return id.error;
      const review = await import("./review-service.js");
      const jobId = await resolveReviewJobId(id.uid, String(a.jobId ?? ""));
      if (!jobId) return "（没有找到审稿记录 — 先用 view_review_jobs 看有哪些）";
      if ("error" in jobId) return jobId.error;
      const format = String(a.format ?? "html").toLowerCase() === "docx" ? "docx" : "html";
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const dir = path.join(os.tmpdir(), "sag-review-export");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = jobId.id.slice(0, 8);
      if (format === "docx") {
        const r = await review.exportReportWord(id.uid, jobId.id);
        if (!r.ok || !r.base64) return `（Word 导出失败: ${r.error ?? "无内容"}）`;
        const file = path.join(dir, `review-${stamp}.docx`);
        fs.writeFileSync(file, Buffer.from(r.base64, "base64"));
        return `【已导出 Word 批注稿】${file}（${Math.round(Buffer.from(r.base64, "base64").length / 1024)}KB）`
          + `\n⚠ 这是**临时目录**里的文件(重启/清理会丢; 要长期留存请到「论文评审」页点导出下载)。`;
      }
      const r = await review.exportReportHtml(id.uid, jobId.id);
      if (!r.ok || !r.html) return `（HTML 导出失败: ${r.error ?? "无内容"}）`;
      const file = path.join(dir, `review-${stamp}.html`);
      fs.writeFileSync(file, r.html, "utf-8");
      return `【已导出排版报告】${file}（${r.html.length} 字符）`
        + `\n⚠ 临时目录, 重启/清理会丢; 要长期留存请到「论文评审」页点导出下载(或直接打印存 PDF)。`
        + `\n（也可以用 file_read 直接读这个 html）`;
    }),
  },
];

/**
 * 把"用户可能只给了 8 位前缀 / 干脆没给"的 jobId 解析成完整 id。
 *
 * 对话里没人会去贴完整 uuid, 而 listReviewJobs 返回的 id 是完整的 —— 所以允许前缀匹配,
 * 但**命中多条要报错而不是挑一条**: 挑错了用户会拿着别人的报告说"这不是我这篇"(数据全对, 只有对象错了)。
 */
async function resolveReviewJobId(userId: string, raw: string): Promise<{ id: string } | { error: string } | null> {
  const review = await import("./review-service.js");
  const v = raw.trim().toLowerCase();
  const jobs = await review.listReviewJobs(userId, 50, 0) as Array<Record<string, unknown>>;
  if (!jobs.length) return null;
  if (!v) return { id: String(jobs[0].id) };
  if (uuidRe.test(v)) return { id: v };
  // 前缀匹配: 长度够(≥6)才允许, 否则 "1" 这种会把一堆 id 网进来
  if (v.length >= 6) {
    const hit = jobs.filter((j) => String(j.id).toLowerCase().startsWith(v));
    if (hit.length === 1) return { id: String(hit[0].id) };
    if (hit.length > 1) return { error: `（前缀 ${v} 命中 ${hit.length} 条审稿记录, 请给更长的 id — 用 view_review_jobs 看完整 id）` };
    // 前缀没命中但它是完整 uuid 的情况上面已返回; 这里给"最近 8 条"当线索
    const recent = jobs.slice(0, 8).map((j) => `${String(j.paper_title ?? j.title ?? "(无题)").slice(0, 24)}:${String(j.id).slice(0, 8)}`).join(", ");
    return { error: `（没找到 id 以 ${v} 开头的审稿记录; 最近的几条: ${recent}）` };
  }
  return { error: `（jobId 太短(需 ≥6 位或完整 uuid) — 用 view_review_jobs 看 id）` };
}
