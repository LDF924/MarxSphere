// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// review-service.ts — SocialSci P0-3: 审稿任务流 + 期刊库/标准库解析
// 形态对齐(闭源产品交互语义, 原创实现): 传稿→分段审稿→SSE review.delta 维度JSON边流边渲染→聚合报告
//   - 分段: 2000-4000字/段 token感知, 逐段 LLM 审 → 写 progress checkpoint(断线续传)
//   - parse: 投稿须知/评分标准 → LLM 结构化 JSON(zod 校验)
//   - 选用刊物规则: journal.parsed_rules 并入本次审稿维度
// 迁移117 review_jobs/review_journals/review_standards
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";
import type { AttachedSse } from "../api/stream-utils.js";

// ═══ LLM JSON 调用 ═══
async function llmJson(prompt: string, modelOverride?: string, maxTokens = 6000, temperature = 0.3): Promise<any | null> {
  const ep = getLlmEndpoint({ model: modelOverride || getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON, 不要其他文字。" }],
    temperature, maxTokens, timeoutMs: 300_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}

/** 分段: 2000-4000字/段(尽量在段落边界断开) */
export function segmentText(text: string, minLen = 1800, maxLen = 4000): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= maxLen) return clean ? [clean] : [];
  const segs: string[] = [];
  let rest = clean;
  while (rest.length > maxLen) {
    // 在 [minLen, maxLen] 之间找最后的段落边界
    let cut = -1;
    for (let i = maxLen; i >= minLen && cut === -1; i--) {
      if (rest[i] === "\n" && rest[i + 1] === "\n") cut = i + 1;
    }
    if (cut === -1) {
      // 无段落边界: 找句号
      for (let i = maxLen; i >= minLen && cut === -1; i--) {
        if ("。！？.!?".includes(rest[i])) cut = i + 1;
      }
    }
    if (cut === -1) cut = maxLen;
    segs.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) segs.push(rest);
  return segs;
}

const DEFAULT_DIMENSIONS = [
  { key: "topic_value", name: "选题价值", weight: 0.2, criteria: "问题意识/学术价值/现实意义", min: 0, max: 100 },
  { key: "literature", name: "文献综述", weight: 0.15, criteria: "脉络梳理/文献充分/述评深度", min: 0, max: 100 },
  { key: "logic", name: "逻辑结构", weight: 0.2, criteria: "论证严密/结构清晰/层次分明", min: 0, max: 100 },
  { key: "method", name: "研究方法", weight: 0.2, criteria: "方法适配/数据可靠/操作规范", min: 0, max: 100 },
  { key: "expression", name: "文字表达", weight: 0.15, criteria: "语言规范/学术用语/可读性", min: 0, max: 100 },
  { key: "innovation", name: "创新贡献", weight: 0.1, criteria: "理论/方法/发现创新点", min: 0, max: 100 },
];

/** 取默认维度(新审稿无标准时) */
export function defaultDimensions() {
  return JSON.parse(JSON.stringify(DEFAULT_DIMENSIONS));
}

// ═══ 审稿任务 CRUD ═══
export async function createReviewJob(input: {
  userId: string; title?: string; text: string; kind?: string;
  journalId?: string; standardId?: string; sourceFilePath?: string;
  // SocialSci R4: settings/rules/来源文件(HAR 实测)
  settings?: { strictness?: string; journalId?: string | null; standardIds?: string[]; customRequirements?: string };
  sourceFileId?: string; sourceFileName?: string; sourceFileType?: string;
  sidebarTaskId?: string;
}) {
  const id = randomUUID();
  const segments = segmentText(input.text);
  let dimensions = defaultDimensions();
  // 标准库维度
  if (input.standardId) {
    const s = await pool.query(`select dimensions from review_standards where id=$1`, [input.standardId]);
    if (s.rows[0]?.dimensions?.length) dimensions = s.rows[0].dimensions;
  }
  // 刊物规则并入(优先期刊规则的审稿关注点)
  let journalRules: unknown = null;
  if (input.journalId) {
    const j = await pool.query(`select parsed_rules from review_journals where id=$1`, [input.journalId]);
    journalRules = j.rows[0]?.parsed_rules ?? null;
  }
  const payload = journalRules ? { rules: journalRules } : {};
  // R4: settings_json/rules_json 结构化落库(与前端契约对齐)
  const settings = input.settings ?? {
    strictness: "medium",
    journalId: input.journalId ?? null,
    standardIds: input.standardId ? [input.standardId] : [],
    customRequirements: "",
  };
  const rules = { journal: input.journalId ?? null, standards: input.standardId ? [input.standardId] : [] };
  const contentHash = contentHashOf(input.text);
  await pool.query(
    `insert into review_jobs
       (id, user_id, kind, title, text_snapshot, journal_id, standard_id, dimensions, status, progress,
        settings_json, rules_json, content_hash, source_file_id, source_file_name, source_file_type, sidebar_task_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, input.userId, input.kind ?? "text", input.title ?? "",
     input.text, input.journalId ?? null, input.standardId ?? null,
     JSON.stringify(dimensions),
     JSON.stringify({ totalSegments: segments.length, segmentsDone: 0, lastEventSeq: 0, ...payload }),
     JSON.stringify(settings), JSON.stringify(rules), contentHash,
     input.sourceFileId ?? "", input.sourceFileName ?? "", input.sourceFileType ?? "",
     input.sidebarTaskId ?? ""]
  );
  return { id, segmentCount: segments.length, dimensions };
}

function contentHashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function getReviewJob(userId: string, jobId: string) {
  const r = await pool.query(`select * from review_jobs where id=$1 and user_id=$2`, [jobId, userId]);
  return r.rows[0] ?? null;
}

export async function listReviewJobs(userId: string, limit = 50) {
  const r = await pool.query(
    `select id, kind, title, journal_id, standard_id, status, created_at, updated_at,
            result->'paperTitle' as paper_title, result->'wordCount' as word_count
       from review_jobs where user_id=$1 order by created_at desc limit $2`,
    [userId, limit]
  );
  return r.rows;
}

export async function updateJobStatus(userId: string, jobId: string, status: string, patch: { progress?: unknown; error?: unknown } = {}) {
  const sets = ["status=$3", "updated_at=now()"];
  const vals: unknown[] = [jobId, userId, status];
  if (patch.progress !== undefined) { sets.push(`progress=$${vals.length + 1}`); vals.push(JSON.stringify(patch.progress)); }
  if (patch.error !== undefined) { sets.push(`error=$${vals.length + 1}`); vals.push(JSON.stringify(patch.error)); }
  const r = await pool.query(
    `update review_jobs set ${sets.join(",")} where id=$1 and user_id=$2 returning id`, vals
  );
  return r.rows[0] ?? null;
}

export async function controlReviewJob(userId: string, jobId: string, action: "cancel" | "retry") {
  const j = await getReviewJob(userId, jobId);
  if (!j) return null;
  if (action === "cancel" && (j.status === "queued" || j.status === "running" || j.status === "segmenting" || j.status === "summarizing" || j.status === "streaming")) {
    await updateJobStatus(userId, jobId, "cancelled");
    return { ...j, status: "cancelled" };
  }
  if (action === "retry" && (j.status === "failed" || j.status === "cancelled")) {
    const id = randomUUID();
    await pool.query(
      `insert into review_jobs
         (id, user_id, kind, title, text_snapshot, journal_id, standard_id, dimensions, status, progress, retry_of)
       select $1, user_id, kind, title, text_snapshot, journal_id, standard_id, dimensions, 'queued', '{}', id
         from review_jobs where id=$2 and user_id=$3`,
      [id, jobId, userId]
    );
    return { ...j, id, status: "queued" };
  }
  return j;
}

// ═══ 核心: 分段审稿执行(SSE 流式) ═══
export async function runReviewJob(userId: string, jobId: string, sse: AttachedSse): Promise<void> {
  const job = await getReviewJob(userId, jobId);
  if (!job) { sse.error({ code: "NOT_FOUND", userMessage: "审稿任务不存在", canRetry: false }); return; }
  const text = job.text_snapshot || "";
  const segments = segmentText(text);
  const progress = job.progress ?? {};
  const startSeg = Number(progress.segmentsDone ?? 0);
  const dimensions = job.dimensions?.length ? job.dimensions : defaultDimensions();
  const dimNames = (dimensions as Array<{ name: string; key: string; criteria?: string }>).map((d) => d.name);
  const journalRules = (progress as { rules?: unknown }).rules;

  await updateJobStatus(userId, jobId, "segmenting");
  sse.send("review.started", { totalSegments: segments.length, fromSegment: startSeg });

  const segResults: Array<{ segIndex: number; findings: unknown[]; issues: unknown[] }> = [];
  try {
    // 逐段审(断点续传: 从 startSeg 起)
    for (let i = startSeg; i < segments.length; i++) {
      sse.send("review.status", { step: i, total: segments.length, message: `正在审阅第 ${i + 1}/${segments.length} 段...` });
      const ans = await llmJson(`你是中文学术期刊审稿专家。审阅论文的一个片段, 输出 JSON:
{"issues":[{"level":"major|minor|suggestion","quote":"问题原文片段","comment":"问题说明","suggest":"修改建议"}],"notablePoints":["亮点"]}

【论文片段 ${i + 1}/${segments.length}】
${segments[i].slice(0, 4000)}

${dimNames.length ? `审稿维度: ${dimNames.join("、")}` : ""}`, undefined, 4000, 0.3);
      const issues = Array.isArray(ans?.issues) ? ans.issues : [];
      segResults.push({ segIndex: i, findings: ans?.notablePoints ?? [], issues });
      sse.send("review.delta", {
        segIndex: i, issuesCount: issues.length, issues: issues.slice(0, 10),
        notablePoints: ans?.notablePoints ?? [],
      });
      // 每段 checkpoint(断线续传)
      await updateJobStatus(userId, jobId, "streaming", {
        progress: { ...progress, segmentsDone: i + 1, lastEventSeq: i + 1 },
      });
    }

    // 聚合: 全段完成后一次 LLM 汇总成维度评分卡
    await updateJobStatus(userId, jobId, "summarizing");
    sse.send("review.status", { step: -1, message: "正在汇总审稿意见并生成评分卡..." });
    const allIssues = segResults.flatMap((s) => s.issues);
    const notable = segResults.flatMap((s) => s.findings);
    const agg = await llmJson(`你是期刊主编, 综合多位审稿人的分段意见, 输出最终审稿报告 JSON(SocialSci R4 全schema):
{"paperTitle":"(从正文推断论文标题)",
 "wordCount":(正文中文字数),
 "overallScore":(0-100 总分整数),
 "grade":"A|B|C|D|E(总分档)",
 "overallComment":"总体评语(120字内, 亮点+主要问题+录用倾向)",
 "dimensions":[{"name":"维度名","score":0,"maxScore":100,"weight":1,"status":"good|warning|error","summary":"该维度综合意见(80字内)","issues":[{"id":"issue-001","severity":"major|minor","location":"章节/小节位置","originalText":"原文片段","suggestion":"修改建议"}]}],
 "annotations":[{"id":"ann-001","type":"error|warning|info","dimension":"所属维度名","highlightText":"批注对应原文片段(60字内)","comment":"批注说明"}],
 "highlights":["亮点1","亮点2","亮点3"],
 "topSuggestions":["首要修改建议1(具体可执行)","建议2","建议3"]}

【审稿维度】${(dimensions as Array<{ key: string }>).map((d) => d.key).join("、")}
${journalRules ? `【期刊规则(须对照)】${JSON.stringify(journalRules).slice(0, 1000)}` : ""}
全部问题清单:
${allIssues.map((x) => JSON.stringify(x)).join("\n").slice(0, 5000)}
亮点: ${notable.slice(0, 10).join("; ")}`, undefined, 6000, 0.3);

    // R4: 全 schema 结果(保留 majorIssues/minorIssues 字段兼容旧前端, 新增 overallScore/grade/annotations 等)
    const dimsFull = (Array.isArray(agg?.dimensions) ? agg.dimensions : dimensions).map((d: Record<string, unknown>, i: number) => ({
      name: d.name ?? dimensions[i]?.name ?? `维度${i + 1}`,
      score: d.score ?? 0,
      maxScore: d.maxScore ?? 100,
      weight: d.weight ?? 1,
      status: d.status ?? (Number(d.score ?? 0) >= 80 ? "good" : Number(d.score ?? 0) >= 60 ? "warning" : "error"),
      summary: d.summary ?? d.comment ?? "",
      issues: (Array.isArray(d.issues) ? d.issues : []).slice(0, 10).map((iss: unknown, j: number) =>
        typeof iss === "string" ? { id: `issue-${String(i + 1).padStart(3, "0")}-${String(j + 1).padStart(3, "0")}`, severity: "minor", location: "", originalText: "", suggestion: iss }
        : ({ id: `issue-${String(i + 1).padStart(3, "0")}-${String(j + 1).padStart(3, "0")}`, severity: "minor", location: "", originalText: "", suggestion: "", ...(iss as Record<string, unknown>) })),
    }));
    const result = {
      paperTitle: agg?.paperTitle ?? job.title ?? "未命名论文",
      wordCount: agg?.wordCount ?? text.replace(/\s/g, "").length,
      overallScore: agg?.overallScore ?? 0,
      grade: agg?.grade ?? "C",
      overallComment: agg?.overallComment ?? agg?.overall ?? "",
      dimensions: dimsFull,
      annotations: (Array.isArray(agg?.annotations) ? agg.annotations : []).map((a: Record<string, unknown>, i: number) => ({
        id: a.id ?? `ann-${String(i + 1).padStart(3, "0")}`,
        type: a.type ?? "info", dimension: a.dimension ?? "", highlightText: a.highlightText ?? "", comment: a.comment ?? "",
      })),
      highlights: Array.isArray(agg?.highlights) ? agg.highlights : [],
      topSuggestions: Array.isArray(agg?.topSuggestions) ? agg.topSuggestions : [],
      // 兼容旧字段
      overall: agg?.overallComment ?? agg?.overall ?? "",
      majorIssues: Array.isArray(agg?.majorIssues) ? agg.majorIssues : [],
      minorIssues: Array.isArray(agg?.minorIssues) ? agg.minorIssues : [],
      segmentIssues: allIssues.length,
      reviewedAt: new Date().toISOString(),
    };
    const resultStr = JSON.stringify(result);
    await pool.query(
      `update review_jobs set result=$2::jsonb, result_json=$5, result_text=$5, status='done',
              progress=jsonb_set(coalesce(progress,'{}'::jsonb),'{segmentsDone}',to_jsonb($3::int)),
              completed_at=now(), updated_at=now()
        where id=$1 and user_id=$4`,
      [jobId, resultStr, segments.length, userId, resultStr]
    );
    sse.send("review.completed", { result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateJobStatus(userId, jobId, "failed", {
      error: { code: "REVIEW_FAILED", userMessage: msg, canRetry: true },
    });
    sse.error({ code: "REVIEW_FAILED", userMessage: msg, canRetry: true });
  }
}

// ═══ 期刊库/标准库 CRUD + 解析 ═══
export async function listJournals(userId: string) {
  const r = await pool.query(
    `select id, name, level, scope, user_id, updated_at,
            jsonb_array_length(coalesce(parsed_rules->'reviewFocus','[]'::jsonb)) as focus_count
       from review_journals where user_id=$1 or user_id is null order by level, name`, [userId]);
  return r.rows;
}

export async function createJournal(input: { name: string; level?: string; scope?: string; submissionGuideText?: string; parsedRules?: unknown; userId?: string | null }) {
  const r = await pool.query(
    `insert into review_journals (name, level, scope, submission_guide_text, parsed_rules, user_id)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [input.name, input.level ?? "other", input.scope ?? "", input.submissionGuideText ?? "",
     JSON.stringify(input.parsedRules ?? {}), input.userId ?? null]);
  return { id: r.rows[0].id };
}

export async function updateJournal(userId: string, journalId: string, patch: { name?: string; level?: string; scope?: string; submissionGuideText?: string; parsedRules?: unknown }) {
  const sets = ["updated_at=now()"]; const vals: unknown[] = [journalId, userId];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) { sets.push(`${k}=$${vals.length + 1}`); vals.push(typeof v === "string" ? v : JSON.stringify(v)); }
  }
  const r = await pool.query(
    `update review_journals set ${sets.join(",")} where id=$1 and (user_id=$2 or user_id is null) returning id`, vals);
  return r.rows[0] ?? null;
}

export async function deleteJournal(userId: string, journalId: string) {
  const r = await pool.query(`delete from review_journals where id=$1 and (user_id=$2 or user_id is null) returning id`, [journalId, userId]);
  return r.rows[0] ?? null;
}

/** 投稿须知 → AI 解析结构化规则 */
export async function parseSubmissionGuide(text: string) {
  const ans = await llmJson(`你是学术期刊编辑。解析期刊投稿须知原文为结构化规则, 输出 JSON:
{"formatRules":["格式要求(如字数/摘要结构/图表规范)"],
 "reviewFocus":["审稿关注点(该刊最看重的质量维度)"],
 "citationRules":["引文与参考文献规范"],
 "scope":"刊物收录范围一句话"}

原文:
${text.slice(0, 6000)}`, undefined, 3000, 0.2);
  return {
    formatRules: ans?.formatRules ?? [], reviewFocus: ans?.reviewFocus ?? [],
    citationRules: ans?.citationRules ?? [], scope: ans?.scope ?? "",
  };
}

export async function listStandards(userId: string) {
  const r = await pool.query(
    `select id, name, built_in, is_default, user_id, dimensions, updated_at
       from review_standards where user_id=$1 or built_in order by is_default desc, name`, [userId]);
  return r.rows;
}

export async function createStandard(input: { name: string; sourceText?: string; dimensions?: unknown; builtIn?: boolean; userId?: string | null }) {
  const r = await pool.query(
    `insert into review_standards (name, built_in, source_text, dimensions, is_default, user_id)
     values ($1,$2,$3,$4,false,$5) returning id`,
    [input.name, input.builtIn ?? false, input.sourceText ?? "", JSON.stringify(input.dimensions ?? []), input.userId ?? null]);
  return { id: r.rows[0].id };
}

export async function updateStandard(userId: string, standardId: string, patch: { name?: string; sourceText?: string; dimensions?: unknown }) {
  const sets = ["updated_at=now()"]; const vals: unknown[] = [standardId, userId];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) { sets.push(`${k}=$${vals.length + 1}`); vals.push(typeof v === "string" ? v : JSON.stringify(v)); }
  }
  const r = await pool.query(
    `update review_standards set ${sets.join(",")} where id=$1 and (user_id=$2 or built_in) returning id`, vals);
  return r.rows[0] ?? null;
}

export async function deleteStandard(userId: string, standardId: string) {
  const r = await pool.query(`delete from review_standards where id=$1 and (user_id=$2 or built_in) returning id`, [standardId, userId]);
  return r.rows[0] ?? null;
}

export async function setDefaultStandard(userId: string, standardId: string, isDefault: boolean) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (isDefault) await client.query(`update review_standards set is_default=false where user_id=$1`, [userId]);
    await client.query(
      `update review_standards set is_default=$2 where id=$1 and (user_id=$3 or built_in)`, [standardId, isDefault, userId]);
    await client.query("commit");
    return { ok: true };
  } catch (e) { await client.query("rollback"); throw e; }
  finally { client.release(); }
}

/** 评分标准 → AI 解析维度(带权重/评分标准) */
export async function parseStandardText(text: string) {
  const ans = await llmJson(`你是学术期刊编辑。把一份论文评分标准/审稿要点解析为结构化维度, 输出 JSON:
{"dimensions":[{"key":"snake_case","name":"维度名","weight":0.0-1.0,"criteria":"评分细则","min":0,"max":100}]}

原文:
${text.slice(0, 6000)}`, undefined, 3000, 0.2);
  const dims = Array.isArray(ans?.dimensions) ? ans.dimensions : [];
  return { dimensions: dims.slice(0, 12) };
}

// ═══ Word 批注导出(SocialSci P0-3 补漏: export-report) ═══
// 依赖: .venv-fmtcheck python-docx(与 format-docx 同通道); 失败降级 HTML(前端 @media print)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const execFileAsync = promisify(execFile);
const DOCX_PYTHON = path.resolve(process.cwd(), ".venv-fmtcheck", "Scripts", "python.exe");
const ANNOT_SCRIPT = path.resolve(process.cwd(), "scripts", "review_annotations.py");

/** 把审稿结果转成 Word 批注 docx(base64 返回, 前端下载) */
export async function exportReportWord(userId: string, jobId: string): Promise<{ ok: boolean; base64?: string; fileName?: string; error?: string }> {
  const job = await getReviewJob(userId, jobId);
  if (!job) return { ok: false, error: "审稿任务不存在" };
  const res = job.result;
  if (!res) return { ok: false, error: "审稿尚未完成, 无报告可导出" };

  const text = job.text_snapshot || "";
  // 生成批注清单: 维度问题→批注; major/minor issues→批注
  const comments: Array<{ range: { start: number; end: number }; author: string; text: string }> = [];
  const dims = res.dimensions ?? [];
  for (const d of dims) {
    if (d.issues?.length) {
      for (const iss of (Array.isArray(d.issues) ? d.issues : []).slice(0, 5)) {
        const s = typeof iss === "string" ? iss : JSON.stringify(iss);
        comments.push({ range: { start: 0, end: Math.min(40, text.length) }, author: "AI审稿", text: `[${d.name ?? ""}] ${s.slice(0, 200)}` });
      }
    }
    if (d.comment) comments.push({ range: { start: 0, end: Math.min(40, text.length) }, author: "AI审稿", text: `[${d.name ?? ""} ${d.score ?? ""}分] ${String(d.comment).slice(0, 200)}` });
  }
  for (const m of (res.majorIssues ?? []).slice(0, 10)) {
    comments.push({ range: { start: 0, end: Math.min(40, text.length) }, author: "AI审稿·大修", text: `${String(m.title ?? "")}: ${String(m.detail ?? "").slice(0, 250)}` });
  }
  for (const m of (res.minorIssues ?? []).slice(0, 10)) {
    comments.push({ range: { start: 0, end: Math.min(40, text.length) }, author: "AI审稿·小修", text: `${String(m.title ?? "")}: ${String(m.detail ?? "").slice(0, 200)}` });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-export-"));
  const inPath = path.join(tmpDir, "input.json");
  const outPath = path.join(tmpDir, "review.docx");
  fs.writeFileSync(inPath, JSON.stringify({ text, comments, title: `审稿报告 · ${res.paperTitle ?? job.title ?? "未命名"}` }), "utf-8");
  try {
    const py = fs.existsSync(DOCX_PYTHON) ? DOCX_PYTHON : "python";
    await execFileAsync(py, [ANNOT_SCRIPT, inPath, outPath], { timeout: 120_000, windowsHide: true, cwd: process.cwd() });
    const buf = fs.readFileSync(outPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { ok: true, base64: buf.toString("base64"), fileName: `审稿报告_${(res.paperTitle ?? "unnamed").slice(0, 24)}.docx` };
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { ok: false, error: `Word 导出失败: ${String(e).slice(0, 150)}(可改用打印/存PDF)` };
  }
}
