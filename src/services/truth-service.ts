// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// truth-service.ts — GBrain Compiled Truth + Timeline 机制
// knowledge_pages: 页面 = Compiled Truth（当前最佳理解，可改写）+ 下方时间线（只追加）
// 核心语义：
//   - compiled_truth 是"我相信什么"（新证据出现时整体重写）
//   - page_entries 是"我为什么相信"（证据轨迹，永不删改）
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

export interface KnowledgePage {
  id: string;
  title: string;
  compiledTruth: string;
  sourceHint?: string;
  tags: string[];
  updatedAt: string;
  createdAt: string;
}

export interface PageEntry {
  id: string;
  pageId: string;
  content: string;
  entryType: string;
  source?: string;
  confidence: number;
  createdAt: string;
}

export interface PageWithTimeline extends KnowledgePage {
  timeline: PageEntry[];
}

function pageFromRow(row: Record<string, unknown>): KnowledgePage {
  return {
    id: String(row.id),
    title: String(row.title),
    compiledTruth: String(row.compiled_truth ?? ""),
    sourceHint: row.source_hint == null ? undefined : String(row.source_hint),
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    updatedAt: String(row.updated_at),
    createdAt: String(row.created_at)
  };
}

function entryFromRow(row: Record<string, unknown>): PageEntry {
  return {
    id: String(row.id),
    pageId: String(row.page_id),
    content: String(row.content),
    entryType: String(row.entry_type ?? "note"),
    source: row.source == null ? undefined : String(row.source),
    confidence: Number(row.confidence ?? 0.5),
    createdAt: String(row.created_at)
  };
}

async function listPages(): Promise<KnowledgePage[]> {
  const result = await pool.query(
    `select * from knowledge_pages order by updated_at desc`
  );
  return result.rows.map(pageFromRow);
}

async function getPageWithTimeline(pageId: string): Promise<PageWithTimeline | null> {
  const pageResult = await pool.query(
    `select * from knowledge_pages where id = $1`,
    [pageId]
  );
  if (pageResult.rows.length === 0) return null;
  const page = pageFromRow(pageResult.rows[0]);

  const entryResult = await pool.query(
    `select * from page_entries where page_id = $1 order by created_at asc`,
    [pageId]
  );
  return {
    ...page,
    timeline: entryResult.rows.map(entryFromRow)
  };
}

async function getPageByTitle(title: string): Promise<PageWithTimeline | null> {
  const pageResult = await pool.query(
    `select * from knowledge_pages where title = $1`,
    [title]
  );
  if (pageResult.rows.length === 0) return null;
  const page = pageFromRow(pageResult.rows[0]);
  const entryResult = await pool.query(
    `select * from page_entries where page_id = $1 order by created_at asc`,
    [page.id]
  );
  return {
    ...page,
    timeline: entryResult.rows.map(entryFromRow)
  };
}

/**
 * 创建页面或取回已存在的（按 title 唯一）
 */
async function createOrGetPage(input: {
  title: string;
  compiledTruth?: string;
  sourceHint?: string;
  tags?: string[];
}): Promise<KnowledgePage> {
  const existing = await pool.query(
    `select * from knowledge_pages where title = $1`,
    [input.title]
  );
  if (existing.rows.length > 0) {
    return pageFromRow(existing.rows[0]);
  }
  const id = randomUUID();
  const result = await pool.query(
    `insert into knowledge_pages (id, title, compiled_truth, source_hint, tags)
     values ($1, $2, $3, $4, $5)
     on conflict (title) do nothing
     returning *`,
    [id, input.title, input.compiledTruth ?? "", input.sourceHint ?? null, input.tags ?? []]
  );
  if (result.rows.length > 0) {
    return pageFromRow(result.rows[0]);
  }
  // 并发冲突：取已存在
  const again = await pool.query(`select * from knowledge_pages where title = $1`, [input.title]);
  return pageFromRow(again.rows[0]);
}

/**
 * 重写 Compiled Truth 区（新证据出现时整体重写，旧版本留在时间线）
 * 返回重写前的旧 truth（供前端 diff 展示）
 */
async function rewriteCompiledTruth(pageId: string, newTruth: string, source?: string): Promise<{ oldTruth: string; page: KnowledgePage }> {
  const before = await pool.query(`select * from knowledge_pages where id = $1`, [pageId]);
  const oldTruth = before.rows.length > 0 ? String(before.rows[0].compiled_truth ?? "") : "";

  const result = await pool.query(
    `update knowledge_pages set compiled_truth = $2, updated_at = now() where id = $1 returning *`,
    [pageId, newTruth]
  );

  // 追加一条时间线：记录这次重写（旧 → 新 的轨迹）
  if (result.rows.length > 0 && oldTruth && oldTruth !== newTruth) {
    await pool.query(
      `insert into page_entries (id, page_id, content, entry_type, source, confidence)
       values ($1, $2, $3, 'synthesis', $4, 1.0)`,
      [randomUUID(), pageId, `Compiled Truth 更新：${newTruth.slice(0, 200)}`, source ?? null]
    );
  }

  return {
    oldTruth,
    page: pageFromRow(result.rows[0])
  };
}

/**
 * 追加时间线条目（只追加，永不删改）
 */
async function appendEntry(input: {
  pageId: string;
  content: string;
  entryType?: string;
  source?: string;
  confidence?: number;
}): Promise<PageEntry> {
  const id = randomUUID();
  const result = await pool.query(
    `insert into page_entries (id, page_id, content, entry_type, source, confidence)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [id, input.pageId, input.content, input.entryType ?? "note", input.source ?? null, input.confidence ?? 0.5]
  );
  return entryFromRow(result.rows[0]);
}

/** 删除时间线条目 */
async function deleteEntry(pageId: string, entryId: string): Promise<boolean> {
  const result = await pool.query(
    `delete from page_entries where id = $1 and page_id = $2`,
    [entryId, pageId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** 删除知识页面（先删时间线，再删页面，避免外键约束） */
async function deletePage(pageId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from page_entries where page_id = $1`, [pageId]);
    const result = await client.query(`delete from knowledge_pages where id = $1`, [pageId]);
    await client.query("commit");
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export const truthService = {
  listPages,
  getPageWithTimeline,
  getPageByTitle,
  createOrGetPage,
  rewriteCompiledTruth,
  appendEntry,
  deleteEntry,
  deletePage,
  associateSearch,
  runDreamCycle
};

// ─── 检索与知识页打通（GBrain 机制5）：检索即记忆 ───
// 检索命中某个主题时，把关键证据写入对应知识页时间线

export interface AssociateSearchResult {
  matchedPage: boolean;
  pageId?: string;
  pageTitle?: string;
  evidenceAdded: number;
}

async function associateSearch(input: {
  query: string;
  evidence: Array<{ title: string; content: string }>;
}): Promise<AssociateSearchResult> {
  const result: AssociateSearchResult = { matchedPage: false, evidenceAdded: 0 };
  if (!input.query.trim() || input.evidence.length === 0) return result;

  // 1. 用查询词做关键词，尝试匹配已存在的知识页
  const pages = await listPages();
  const queryKeywords = input.query
    .split(/[\s，。、；：？！]/)
    .filter((w: string) => w.length >= 2 && w.length <= 12)
    .slice(0, 4);

  let matchedPage = pages.find((page) =>
    queryKeywords.some((kw: string) => page.title.includes(kw) || kw.includes(page.title))
  );

  // 2. 无匹配则创建一个知识页（以查询主题命名）
  if (!matchedPage) {
    const title = input.query.length <= 20 ? input.query : queryKeywords[0] || "未命名主题";
    matchedPage = await createOrGetPage({
      title,
      compiledTruth: input.evidence[0]?.content.slice(0, 300) || ""
    });
  }

  // 3. 把检索证据追加到时间线（去重：内容相似的不重复加）
  const detail = await getPageWithTimeline(matchedPage.id);
  const existingContents = detail?.timeline.map((e) => e.content.slice(0, 60)) || [];
  let added = 0;
  for (const ev of input.evidence.slice(0, 3)) {
    const content = ev.content.slice(0, 300);
    if (existingContents.some((c) => c.includes(content.slice(0, 30)))) continue;
    await appendEntry({
      pageId: matchedPage.id,
      content: `检索证据：${content}`,
      entryType: "evidence",
      source: ev.title || undefined,
      confidence: 0.6
    });
    added += 1;
  }

  return {
    matchedPage: true,
    pageId: matchedPage.id,
    pageTitle: matchedPage.title,
    evidenceAdded: added
  };
}

// ─── Dream Cycle：夜间自整理（GBrain 机制4）───
// 扫描知识页中的矛盾条目 → LLM 整合 → 更新 Compiled Truth → 追加 synthesis 时间线

export interface DreamCycleResult {
  scannedPages: number;
  pagesWithContradiction: number;
  resolved: Array<{
    pageId: string;
    title: string;
    oldTruth: string;
    newTruth: string;
  }>;
  skipped: Array<{ pageId: string; title: string; reason: string }>;
}

async function runDreamCycle(): Promise<DreamCycleResult> {
  const result: DreamCycleResult = { scannedPages: 0, pagesWithContradiction: 0, resolved: [], skipped: [] };
  const pages = await listPages();
  result.scannedPages = pages.length;

  for (const page of pages) {
    const detail = await getPageWithTimeline(page.id);
    if (!detail) continue;

    const contradictions = detail.timeline.filter((entry) => entry.entryType === "contradiction");
    if (contradictions.length === 0) {
      continue;
    }
    result.pagesWithContradiction += 1;

    try {
      // 用 LLM 整合矛盾，生成新的 Compiled Truth
      const { llmClient } = await import("../ai/llm-client.js");
      const contradictionText = contradictions
        .map((c) => `- ${c.content.slice(0, 500)}${c.source ? ` (来源: ${c.source})` : ""}`)
        .join("\n");

      const synthesis = await llmClient.composeAnswer({
        query: `请整合以下关于「${page.title}」的矛盾证据，给出一个协调一致的结论。如果证据确实矛盾且无法调和，说明分歧点。`,
        evidence: contradictions.map((c) => ({
          title: c.source || page.title,
          content: c.content.slice(0, 800)
        }))
      });

      const newTruth = synthesis.answer.slice(0, 1500);
      if (!newTruth || newTruth.length < 10) {
        result.skipped.push({ pageId: page.id, title: page.title, reason: "LLM 输出过短" });
        continue;
      }

      // 更新 Compiled Truth + 追加 synthesis 时间线
      await rewriteCompiledTruth(page.id, newTruth, "Dream Cycle");
      await appendEntry({
        pageId: page.id,
        content: `Dream Cycle 整合了 ${contradictions.length} 条矛盾证据`,
        entryType: "synthesis",
        source: "Dream Cycle"
      });

      result.resolved.push({
        pageId: page.id,
        title: page.title,
        oldTruth: detail.compiledTruth.slice(0, 200),
        newTruth: newTruth.slice(0, 200)
      });
    } catch (error) {
      result.skipped.push({
        pageId: page.id,
        title: page.title,
        reason: error instanceof Error ? error.message.slice(0, 100) : String(error)
      });
    }
  }

  return result;
}

// ═══════════ P1-7 知识沉淀 PR 工作流：Proposer-Reviewer 异源互审（2026-08-08）═══════════
// 书中 Ch8: Proposer 只写 drafts，合并只能由服务端 mergeReviewedPage 执行（前端无直写入口）
// Reviewer = qwen3.7-max（异源模型互审，能力相近偏好不同）
import { getRoleModel } from "./llm-model-registry.js";
import { callLlm } from "../ai/llm-common.js";

const DS_URL = process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions";

/** 提交知识草稿（Proposer 角色，只写 drafts 表） */
export async function submitKnowledgeDraft(input: {
  title: string;
  compiledTruth: string;
  sourceHint?: string;
  tags?: string[];
}): Promise<{ id: number; status: string }> {
  const r = await pool.query(
    `insert into knowledge_page_drafts (title, compiled_truth, source_hint, tags, proposer_model, status)
     values ($1, $2, $3, $4, $5, 'pending_review') returning id, status`,
    [input.title, input.compiledTruth, input.sourceHint ?? null, JSON.stringify(input.tags ?? []), getRoleModel("reason")]
  );
  return { id: r.rows[0].id, status: r.rows[0].status };
}

/** Reviewer 异源审核草稿（qwen3.7-max，核对每个断言是否被检索证据支持） */
export async function reviewKnowledgeDraft(draftId: number): Promise<{ verdict: string; feedback: string }> {
  const draft = await pool.query("select * from knowledge_page_drafts where id = $1", [draftId]);
  if (draft.rows.length === 0) return { verdict: "reject", feedback: "草稿不存在" };
  const d = draft.rows[0];

  const reviewerModel = "qwen3.7-max";  // 异源固定（能力相近偏好不同）
  const prompt = `你是知识页审核员。核对以下知识页的每个断言是否被检索证据支持。
标题: ${d.title}
内容: ${d.compiled_truth}

只返回 JSON: {"verdict":"approve|revise|reject","evidence_refs":[],"line_feedback":["..."],"reason":"..."}
- approve: 所有断言有证据支持
- revise: 部分断言缺证据（给出反馈）
- reject: 大量断言无证据（知识不可靠）`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      // V381: 收敛到统一 LLM 入口（原裸 fetch 三件套）
      const r = await callLlm({
        model: reviewerModel, messages: [{ role: "user", content: prompt }],
        temperature: 0, maxTokens: 1500, timeoutMs: 60_000,
      });
      const text = r?.text ?? "";
      const m = text.match(/"verdict"\s*:\s*"(approve|revise|reject)"/);
      const verdict = m ? m[1] : "reject";
      await pool.query(
        `update knowledge_page_drafts set review_verdict = $2, reviewer_model = $3, status = $4, reviewed_at = now()
         where id = $1`,
        [draftId, verdict, reviewerModel, verdict === "approve" ? "approved" : "rejected"]
      );
      return { verdict, feedback: text.substring(0, 300) };
    } finally { clearTimeout(timer); }
  } catch (e: any) {
    return { verdict: "reject", feedback: "审核失败: " + String(e).substring(0, 80) };
  }
}

/** 服务端合并（drafts → 正式表，仅此函数可执行） */
export async function mergeReviewedPage(draftId: number): Promise<{ ok: boolean; page?: KnowledgePage; error?: string }> {
  const draft = await pool.query("select * from knowledge_page_drafts where id = $1", [draftId]);
  if (draft.rows.length === 0) return { ok: false, error: "草稿不存在" };
  const d = draft.rows[0];
  if (d.status !== "approved") return { ok: false, error: "草稿未审核通过（status=" + d.status + "）" };
  // 合并 = 写入正式表（复用 createOrGetPage 的 title 唯一逻辑）
  const page = await createOrGetPage({ title: d.title, compiledTruth: d.compiled_truth, sourceHint: d.source_hint, tags: d.tags });
  await pool.query(`update knowledge_page_drafts set status = 'merged' where id = $1`, [draftId]);
  return { ok: true, page };
}
