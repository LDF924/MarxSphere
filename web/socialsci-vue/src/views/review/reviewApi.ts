/**
 * Review 域 API 客户端 — 还原自闭源 ReviewView-B4QyxKEn.js 直连契约(decoded-editor-review.md §2.4)
 * 我方后端: /api/review/jobs(L9549-9608, SSE review.started/status/delta/completed)
 * + journals/standards CRUD/parse(L9617-9696) + files/extract-text(base64) + export-word/html
 */
import { q, streamSse, type SseHandle } from "@/shared/api";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}
import type { ReviewResult, ReviewSettings } from "./stores/review";

// ── 文件文本提取(闭源 POST /api/files/extract-text multipart; 我方 base64 JSON) ──
export async function extractFileText(file: File): Promise<{
  text: string;
  fileId?: string;
  metadata?: { sourceType?: string; pageCount?: number; extractedPages?: number; reviewChunkCount?: number; truncated?: boolean; extractionWarnings?: string[] };
}> {
  const base64 = await fileToBase64(file);
  const lower = file.name.toLowerCase();
  const sourceType = lower.endsWith(".pdf") ? "pdf" : lower.endsWith(".docx") || lower.endsWith(".doc") ? "docx" : "txt";
  const r = await q<{ text?: string; fileId?: string; ok?: boolean; sourceType?: string; pageCount?: number; extractedPages?: number; truncated?: boolean }>(`/files/extract-text`, {
    method: "POST",
    body: { filename: file.name, base64, mime: file.type || "application/octet-stream" }
  });
  const text = r.text ?? "";
  return {
    text,
    fileId: r.fileId,
    metadata: {
      sourceType: r.sourceType ?? sourceType,
      pageCount: r.pageCount,
      extractedPages: r.extractedPages,
      truncated: r.truncated === true,
      // 段数按真实文本估(前端只用于进度提示, 不再是"页数"的替代品)
      reviewChunkCount: Math.max(1, Math.ceil(text.length / 3000))
    }
  };
}

export interface ReviewJob {
  id: string;
  title: string;
  status: string; // queued/running/completed/done/failed/cancelled
  created_at?: string;
  source_file_name?: string;
  source_file_type?: string;
  progress_message?: string;
  error?: { message?: string; userMessage?: string; code?: string } | null;
  result?: ReviewResult | string | null;
  settings?: Record<string, unknown>;
  sidebar_task_id?: string;
  /** 重审链: 指向上一次任务(首次为 null) */
  retry_of?: string | null;
  /** 第几次审这份稿(0 = 首次) */
  attempt_index?: number;
  /** job 详情才有: 稿件全文(刷新后恢复原文对照用) */
  text_snapshot?: string;
}

/** 创建审稿 job(闭源 body: {title,content,settings,sidebarTaskId,sourceFileId}) */
export async function createReviewJob(body: {
  title: string;
  content: string;
  settings?: ReviewSettings;
  sidebarTaskId?: string;
  sourceFileId?: string;
}): Promise<{ job: ReviewJob; truncated?: boolean }> {
  // 我方后端返回 {jobId, segmentCount, dimensions}(SSE 流驱动执行)
  const r = await q<{ jobId?: string; job?: ReviewJob; truncated?: boolean }>(`/review/jobs`, {
    method: "POST",
    body: {
      title: body.title,
      // 不再前端静默砍到 12 万: 由后端按同一上限裁剪并回传 truncated, 否则用户以为全文被审
      text: body.content,
      settings: body.settings,
      sidebarTaskId: body.sidebarTaskId,
      sourceFileId: body.sourceFileId
    }
  });
  if (r.job) return { job: r.job };
  return { job: { id: String(r.jobId ?? ""), title: body.title, status: "queued" }, truncated: r.truncated === true };
}

export async function listReviewJobs(limit = 20, offset = 0): Promise<{ jobs: ReviewJob[]; total?: number }> {
  return q(`/review/jobs?limit=${limit}&offset=${offset}`);
}

/** 审稿用 LLM 模型(角色 editor): 只列"所属 provider 已配密钥"的, 避免选了必然失败 */
export interface ReviewLlmModel { id: string; label: string; provider: string; desc: string }
export async function getReviewModels(): Promise<{ models: ReviewLlmModel[]; current: string }> {
  const r = await q<{ usable?: ReviewLlmModel[]; models?: ReviewLlmModel[]; roleMap?: Record<string, string> }>(`/llm/models`);
  return { models: r.usable ?? r.models ?? [], current: String(r.roleMap?.editor ?? r.roleMap?.review ?? "") };
}
/** 保存默认模型(按用户持久化, 下次进页面即选中) */
export async function setReviewModel(modelId: string): Promise<void> {
  await q(`/llm/models`, { method: "PUT", body: { role: "editor", modelId } });
}

export async function getReviewJob(jobId: string): Promise<{ job: ReviewJob }> {
  return q(`/review/jobs/${jobId}`);
}

export async function cancelReviewJob(jobId: string): Promise<unknown> {
  // 后端只有 /control {action:cancel}; 旧前端打的 /cancel 是 404 → 取消从未真正下发
  return q(`/review/jobs/${jobId}/control`, { method: "POST", body: { action: "cancel" } }).catch(() => null);
}

export async function retryReviewJob(jobId: string): Promise<{ job?: ReviewJob }> {
  return q<{ job?: ReviewJob }>(`/review/jobs/${jobId}/control`, { method: "POST", body: { action: "retry" } })
    .catch(() => ({}) as { job?: ReviewJob });
}

/**
 * 删除审稿记录。**不要吞异常** —— 之前这里写了 .catch(() => null), 后端根本没有 DELETE 路由,
 * 404 被吃掉后上层照样弹"已删除", 记录其实还在(实测)。失败必须让调用方知道。
 */
export async function deleteReviewJob(jobId: string): Promise<void> {
  await q(`/review/jobs/${jobId}`, { method: "DELETE" });
}

/**
 * 审稿 SSE — 我方事件: review.started/status/delta/completed; 终态 failed/cancelled 靠轮询兜底
 * (闭源 4 事件 + 断点续传语义)
 */
export function streamReviewJob(
  jobId: string,
  handlers: {
    onStatus?: (step: number, message: string, total: number, detail?: { segChars: number; segFrom: number; segTo: number; foundSoFar: number }) => void;
    onDelta?: (payload: { segIndex: number; issuesCount: number; issues?: unknown[] }) => void;
    onCompleted?: (result: ReviewResult) => void;
    onCancelled?: () => void;
    onError?: (e: unknown) => void;
  }
): SseHandle {
  return streamSse(`/review/jobs/${jobId}/stream`, {
    onEvent: (event, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      if (event === "review.status") {
        handlers.onStatus?.(
          Number(p.step ?? 0),
          String(p.message ?? ""),
          Number(p.total ?? 0),
          // 进度细化(2026-09-12): 段字数区间 + 累计发现问题数; 老后端不发这些字段 → undefined
          typeof p.segChars === "number"
            ? { segChars: p.segChars, segFrom: Number(p.segFrom ?? 0), segTo: Number(p.segTo ?? 0), foundSoFar: Number(p.foundSoFar ?? 0) }
            : undefined,
        );
      } else if (event === "review.delta") {
        handlers.onDelta?.({ segIndex: Number(p.segIndex ?? 0), issuesCount: Number(p.issuesCount ?? 0), issues: Array.isArray(p.issues) ? p.issues : [] });
      } else if (event === "review.completed") {
        const res = p.result as ReviewResult;
        handlers.onCompleted?.(res);
      } else if (event === "review.cancelled") {
        handlers.onCancelled?.();
      } else if (event === "review.failed") {
        handlers.onError?.(p.error ?? "审稿失败");
      } else if (event === "error") {
        // 后端 attachSse 的通用错误事件: 此前无分支处理 → 流断了前端只看到"正在审稿"卡住
        handlers.onError?.(p.userMessage ?? p.message ?? "审稿失败");
      }
    },
    onError: (e) => handlers.onError?.(e)
  });
}

// ── 期刊/标准库(审稿库 LibraryHome) ──
export interface JournalRecord {
  id?: string;
  name: string;
  category?: string;
  level?: string;
  isBuiltIn?: boolean;
  isVerified?: boolean;
  useCount?: number;
  /** 来自马理论期刊全库(cjournal_journals)的题录条目: 只有主办/主题/官网, 尚无投稿规则 */
  isCatalog?: boolean;
  org?: string;
  topicTags?: string[];
  style?: string;
  officialSite?: string;
  // 后端 /review/journals/parse 产出的是这四类(闭源 ReviewView 编辑页读 formatRules)
  structuredRules?: {
    formatRules?: string[];
    reviewFocus?: string[];
    citationRules?: string[];
    scope?: string;
    // 前端本地正则 6 类归槽的旧形状(保留兼容)
    wordCount?: { min?: number; max?: number; unit?: string };
    referenceFormat?: string;
    languageStyle?: string[];
    structureRequirements?: string[];
    forbiddenItems?: string[];
    specialNotes?: string[];
  };
  submissionGuideText?: string;
  /** 收录范围 — 后端 journalShape 顶层就回它(对比视图要用), 别只在 structuredRules.scope 里找 */
  scope?: string;
  /** 规则来源标注: 'ai'=AI 解析且未编辑, 'manual'=用户新建/编辑过 */
  ruleSource?: string | null;
  /** 是否留了可回退的 AI 原文 —— 决定"回退重解析"按钮可不可用 */
  canReparse?: boolean;
  aiParsedAt?: string | null;
  updated_at?: string;
}

export async function listJournals(): Promise<{ data?: JournalRecord[]; journals?: JournalRecord[] }> {
  return q(`/review/journals`);
}

export interface ReviewStats {
  overall: {
    total: number; scored: number; avgScore: number | null;
    grades: Array<{ grade: string; count: number }>;
    severity: Array<{ severity: string; count: number }>;
    topIssueDimensions: Array<{ name: string; count: number }>;
  };
  journals: Array<{ id: string; name: string; jobs: number; avgScore: number | null }>;
}
/** 审稿使用统计反哺: 分数分布 / 常见问题严重度 / 高发维度 / 各刊均分 */
export async function getReviewStats(): Promise<ReviewStats> {
  return q(`/review/stats`);
}
export async function createJournal(body: Partial<JournalRecord>): Promise<{ data?: JournalRecord; ok?: boolean }> {
  return q(`/review/journals`, { method: "POST", body });
}
export async function updateJournal(id: string, body: Partial<JournalRecord>): Promise<{ ok?: boolean }> {
  return q(`/review/journals/${id}`, { method: "PUT", body });
}
export async function deleteJournal(id: string): Promise<{ ok?: boolean }> {
  return q(`/review/journals/${id}`, { method: "DELETE" });
}
export async function parseJournalText(text: string): Promise<{ data?: { name?: string; category?: string; structuredRules?: JournalRecord["structuredRules"] } }> {
  return q(`/review/journals/parse`, { method: "POST", body: { text } });
}
/** 一键回退重解析: 用当初喂给 AI 的原文重抽规则(手工填的刊会被拒, error 里说明原因) */
export async function reparseJournalRules(journalId: string): Promise<{ ok?: boolean; rules?: JournalRecord["structuredRules"]; ruleCount?: number; error?: string }> {
  return q(`/review/journals/${journalId}/reparse`, { method: "POST" });
}

export interface BatchParseResult {
  results: Array<{ name: string; ok: boolean; created: boolean; journalId?: string; ruleCount?: number; error?: string }>;
  summary: { total: number; ok: number; failed: number; created: number };
}
/** 批量补规则: 一次粘多刊投稿须知, 逐刊 AI 解析入库 */
export async function batchParseJournals(text: string, overwrite = false): Promise<BatchParseResult> {
  return q(`/review/journals/batch-parse`, { method: "POST", body: { text, overwrite } });
}
/** 只切分不解析(不烧 token): 先确认切得对不对再提交 */
export async function splitPreviewJournalText(text: string): Promise<{ blocks: Array<{ name: string; chars: number; preview: string }> }> {
  return q(`/review/journals/split-preview`, { method: "POST", body: { text } });
}

export interface StandardRecord {
  id?: string;
  name: string;
  scope?: string;
  description?: string;
  isDefault?: boolean;
  isBuiltIn?: boolean;
  useCount?: number;
  dimensions?: Array<{ name: string; weight?: number; description?: string; criteria?: Array<{ id?: string; title?: string }> }>;
}

export async function listStandards(): Promise<{ data?: StandardRecord[]; standards?: StandardRecord[] }> {
  return q(`/review/standards`);
}
export async function createStandard(body: Partial<StandardRecord>): Promise<{ data?: StandardRecord; ok?: boolean }> {
  return q(`/review/standards`, { method: "POST", body });
}
export async function updateStandard(id: string, body: Partial<StandardRecord>): Promise<{ ok?: boolean }> {
  return q(`/review/standards/${id}`, { method: "PUT", body });
}
export async function deleteStandard(id: string): Promise<{ ok?: boolean }> {
  return q(`/review/standards/${id}`, { method: "DELETE" });
}
export interface ParsedDimension { key?: string; name: string; weight?: number; criteria?: string; min?: number; max?: number }

/** 评分标准原文 → AI 解析维度(后端 LLM; 失败时抛出, 由调用方回落本地解析) */
export async function parseStandardText(text: string): Promise<{ dimensions: ParsedDimension[]; error?: string }> {
  return q(`/review/standards/parse`, { method: "POST", body: { text } });
}

/** 本地兜底: 按"维度名 + 分值"逐行归槽(不依赖 LLM 也能建出可用标准) */
export function parseStandardLocally(text: string): ParsedDimension[] {
  const out: ParsedDimension[] = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim().replace(/^[-*·•\d.、()）]+\s*/, "");
    if (!line || line.length > 60) continue;
    // "创新性 20分" / "选题意义（20 分）" / "方法: 25 分"
    const m = line.match(/^(.{2,20}?)\s*[（(:：]?\s*(\d+(?:\.\d+)?)\s*分/);
    if (!m) continue;
    const name = m[1].replace(/[（(:：\s]+$/, "").trim();
    if (!name || out.some((d) => d.name === name)) continue;
    out.push({ name, weight: Number(m[2]), criteria: line.slice(0, 200) });
  }
  return out.slice(0, 12);
}

export async function setDefaultStandard(id: string, isDefault: boolean): Promise<{ ok?: boolean }> {
  return q(`/review/standards/${id}/default`, { method: "POST", body: { isDefault } });
}

/** 投稿须知 → 结构化规则(闭源纯前端正则 6 类归槽; 后端 parse 为 AI 辅助) */
export function parseSubmissionGuideLocally(text: string): JournalRecord["structuredRules"] {
  const rules: NonNullable<JournalRecord["structuredRules"]> = {};
  const lines = String(text ?? "").split("\n").map((l) => l.trim().replace(/^[-*·•]\s*/, "")).filter(Boolean);
  const wordHits: string[] = [];
  const refHits: string[] = [];
  const styleHits: string[] = [];
  const structHits: string[] = [];
  const noteHits: string[] = [];
  const forbidHits: string[] = [];
  for (const line of lines) {
    // 字数区间
    const wm = line.match(/(\d+)\s*[-~～至到]\s*(\d+)\s*(字|词|字符)/);
    if (wm) {
      wordHits.push(line);
      rules.wordCount = { min: Number(wm[1]), max: Number(wm[2]), unit: wm[3] };
      continue;
    }
    if (/(引用|citation|gb\/t|apa|mla|chicago)/i.test(line)) refHits.push(line);
    else if (/(风格|语气|人称|被动|主动|学术)/.test(line)) styleHits.push(line);
    else if (/(结构|章节|文献综述|方法|结论|引言)/.test(line)) structHits.push(line);
    else if (/(盲审|英文|摘要|关键词|声明|利益)/.test(line)) noteHits.push(line);
    else if (/(禁止|不得|不允许|不能|请勿)/.test(line)) forbidHits.push(line);
    else noteHits.push(line);
  }
  if (refHits.length) rules.referenceFormat = refHits.join("; ").slice(0, 500);
  if (styleHits.length) rules.languageStyle = styleHits.slice(0, 8);
  if (structHits.length) rules.structureRequirements = structHits.slice(0, 8);
  if (forbidHits.length) rules.forbiddenItems = forbidHits.slice(0, 8);
  if (noteHits.length) rules.specialNotes = noteHits.slice(0, 8);
  return rules;
}

/** 结果导出(闭源: Word 导出在 ReviewResult 内) */
/**
 * 审稿报告导出(2026-09-12)。
 *
 * 这段原来是死代码: 写着 GET + `r.text()` + 手搓 token, 而后端是 **POST 且返回 base64**
 * (`{ok, html: base64}`) —— 契约对不上, 所以从来没被调用过, 报告只能看不能带走。
 * 现在改成走共享 q()(它已处理鉴权/401 广播/错误), 并解出 base64 转成 HTML 文本。
 */
export async function exportReviewHtml(jobId: string): Promise<string> {
  const r = await q<{ ok?: boolean; html?: string }>(`/review/jobs/${jobId}/export-html`, { method: "POST" });
  const b64 = r.html ?? "";
  if (!b64) throw new Error("导出内容为空");
  // base64 → UTF-8 文本: 中文报告直接 atob 会乱码, 必须先按字节还原再用 TextDecoder
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/** Word 批注导出: 返回 base64 与文件名, 由调用方触发下载 */
export async function exportReviewWord(jobId: string): Promise<{ base64: string; fileName: string }> {
  const r = await q<{ ok?: boolean; base64?: string; fileName?: string }>(`/review/jobs/${jobId}/export-word`, { method: "POST" });
  if (!r.base64) throw new Error("导出内容为空");
  return { base64: r.base64, fileName: r.fileName || "审稿报告.docx" };
}
