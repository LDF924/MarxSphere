// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// paper-share-service.ts — 论文分享链接接收（2026-08-29, 借鉴 frowang /s/:token 分享模式）
// 功能:
//   1. 生成分享链接: 论文 + 随机 token + 过期时间/次数限制 → 链接可发给他人
//   2. 接收导入: 链接带 token → 校验 → 把论文导入接收方文献库(去重)
// 数据表: paper_shares(链接记录) — 分享不复制论文, 接收时引用源文档
import { pool } from "../db/pool.js";
import { randomBytes } from "node:crypto";

export interface PaperShare {
  id: string;
  token: string;
  documentId: string;
  title: string;
  createdBy: string;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
  createdAt: Date;
}

/** pg 行(snake_case) → PaperShare(camelCase) */
function mapShareRow(row: any): PaperShare {
  return {
    id: row.id,
    token: row.token,
    documentId: row.document_id,
    title: row.title,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    useCount: row.use_count,
    createdAt: row.created_at,
  };
}

/** 生成分享链接(默认 7 天有效, 最多 10 次接收) */
export async function createShareLink(input: {
  documentId: string;
  createdBy?: string;
  expiresHours?: number;
  maxUses?: number;
}): Promise<{ ok: boolean; share?: PaperShare; url?: string; error?: string }> {
  try {
    const doc = await pool.query("select id, title from documents where id = $1", [input.documentId]).catch(() => ({ rows: [] }));
    if (doc.rows.length === 0) return { ok: false, error: "文档不存在" };
    const token = randomBytes(12).toString("hex");
    const expiresAt = input.expiresHours
      ? new Date(Date.now() + input.expiresHours * 3600_000)
      : new Date(Date.now() + 7 * 24 * 3600_000);
    const r = await pool.query(
      `insert into paper_shares (token, document_id, title, created_by, expires_at, max_uses)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [token, input.documentId, doc.rows[0].title, input.createdBy || "local", expiresAt, input.maxUses ?? 10]
    );
    const share = mapShareRow(r.rows[0]);
    return { ok: true, share, url: `/s/paper/${token}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 校验分享链接(过期/次数校验), 返回文档信息 */
export async function resolveShare(token: string): Promise<{
  ok: boolean;
  share?: PaperShare;
  document?: { id: string; title: string; content: string; metadata: unknown };
  error?: string;
}> {
  try {
    const r = await pool.query("select * from paper_shares where token = $1", [token]).catch(() => ({ rows: [] }));
    if (r.rows.length === 0) return { ok: false, error: "分享链接不存在或已失效" };
    const share = mapShareRow(r.rows[0]);
    if (share.expiresAt && new Date(share.expiresAt) < new Date()) return { ok: false, error: "分享已过期" };
    if (share.maxUses != null && share.useCount >= share.maxUses) return { ok: false, error: "分享接收次数已达上限" };
    // 引用源文档内容(分享不复制)
    const doc = await pool.query("select id, title, content, metadata from documents where id = $1", [share.documentId]).catch(() => ({ rows: [] }));
    if (doc.rows.length === 0) return { ok: false, error: "源文档已被删除" };
    // 次数 +1
    await pool.query("update paper_shares set use_count = use_count + 1 where id = $1", [share.id]).catch(() => {});
    return { ok: true, share, document: doc.rows[0] };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 接收分享: 导入到目标项目(按 external_id 去重) */
export async function receiveShare(input: { token: string; sourceId: string }): Promise<{
  ok: boolean;
  imported?: boolean;
  title?: string;
  error?: string;
}> {
  const resolved = await resolveShare(input.token);
  if (!resolved.ok || !resolved.document) return { ok: false, error: resolved.error || "解析失败" };
  const doc = resolved.document;
  const key = `share-${resolved.share!.token}`;
  // 按 external_id(分享链接键)或同名文档去重
  const dup = await pool.query("select 1 from documents where source_id = $1 and (external_id = $2 or title = $3) limit 1", [input.sourceId, key, doc.title]).catch(() => ({ rows: [] }));
  if (dup.rows.length > 0) return { ok: true, imported: false, title: doc.title };
  // 校验源项目存在(外键约束, 提前给出友好错误)
  const src = await pool.query("select 1 from sources where id = $1", [input.sourceId]).catch(() => ({ rows: [] }));
  if (src.rows.length === 0) return { ok: false, error: "目标文献库不存在(sourceId 无效)" };
  try {
    await pool.query(
      `insert into documents (id, source_id, external_id, title, content, status, parse_status, metadata)
       values (gen_random_uuid(), $1, $2, $3, $4, 'COMPLETED', 'COMPLETED', $5::jsonb)`,
      [input.sourceId, key, doc.title, doc.content || "", JSON.stringify({ ...(doc.metadata as object || {}), shared: true })]
    );
  } catch (e: any) {
    return { ok: false, error: `导入失败: ${String(e?.message || e).slice(0, 120)}` };
  }
  return { ok: true, imported: true, title: doc.title };
}

/** 我的分享列表 */
export async function listMyShares(createdBy = "local"): Promise<Array<{ token: string; title: string; useCount: number; maxUses: number | null; expiresAt: Date | null }>> {
  const r = await pool.query(
    "select token, title, use_count, max_uses, expires_at from paper_shares where created_by = $1 order by created_at desc limit 20",
    [createdBy]
  ).catch(() => ({ rows: [] }));
  return r.rows.map((x: any) => ({ token: x.token, title: x.title, useCount: x.use_count, maxUses: x.max_uses, expiresAt: x.expires_at }));
}

export const paperShareService = { createShareLink, resolveShare, receiveShare, listMyShares };
