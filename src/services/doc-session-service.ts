// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/doc-session-service.ts — V404-13: WriterLease/ChangeSet/锚点批注(最小版)
// 借鉴 OpenSquilla artifact_session(models.py: Document writer_fencing_token / ChangeSet / Anchor):
//   1. WriterLease: 文档级编辑锁(holder + fencing token) — 旧写者令牌 < 当前令牌 → 拒绝(防旧写覆盖新写)
//   2. ChangeSet: 原子变更集 — 基于 base_version 的 [replace] 操作列表 → 原子应用(乐观锁冲突检测)
//   3. 锚点: text_range 定位符(quote + 偏移), 编辑后按"编辑点前后位移"重映射; 落在被删区间 → orphaned
// 与既有 documents/document_versions(内容哈希版本)衔接: ChangeSet 应用即 content_version+1 写版本行
import { randomUUID, createHash } from "node:crypto";
import { pool } from "../db/pool.js";

// ═══ 1. WriterLease ═══
export interface LeaseResult { ok: boolean; token?: number; error?: string }

/**
 * 获取/续期 WriterLease: 编辑前必须先持锁。
 * holder 相同(自己续期)保持原 token; 他人持锁且未过期 → 拒绝; 过期/无人 → 新发 token。
 * fencing: 每次新发 token 递增 — 旧 token 的写请求会在 apply 时被拒(见 applyChangeSet)。
 */
export async function acquireWriterLease(documentId: string, holder: string, ttlSeconds = 300): Promise<LeaseResult> {
  const r = await pool.query(
    `update documents set
       writer_lease_holder = $2,
       writer_lease_token = case
         when writer_lease_holder = $2 and writer_lease_until > now() then writer_lease_token
         when writer_lease_holder is null or writer_lease_until <= now() then coalesce(writer_lease_token, 0) + 1
         else writer_lease_token
       end,
       writer_lease_until = now() + ($3::int || ' seconds')::interval
     where id = $1::uuid
     returning writer_lease_holder, writer_lease_token`,
    [documentId, holder, ttlSeconds]
  );
  if (r.rows.length === 0) return { ok: false, error: "文档不存在" };
  const row = r.rows[0];
  if (row.writer_lease_holder !== holder) {
    return { ok: false, error: `文档被 ${row.writer_lease_holder} 编辑中(等他释放或过期 ${ttlSeconds}s 后重试)` };
  }
  return { ok: true, token: Number(row.writer_lease_token) };
}

/** 释放 WriterLease(仅持有者可释放) */
export async function releaseWriterLease(documentId: string, holder: string): Promise<{ ok: boolean }> {
  await pool.query(
    `update documents set writer_lease_holder = null, writer_lease_token = null, writer_lease_until = null
     where id = $1::uuid and writer_lease_holder = $2`,
    [documentId, holder]
  );
  return { ok: true };
}

// ═══ 2. ChangeSet(原子编辑) ═══
export interface ReplaceOp { op: "replace"; start: number; end: number; text: string }
export interface ChangeSetApplyResult {
  ok: boolean; changeSetId?: string; newVersion?: number; error?: string;
  /** 冲突时给当前最新版本(调用方可基于新版重做) */
  currentVersion?: number;
}

/** 在文本上应用 replace 操作(先按 start 升序排序; 区间不重叠校验) */
export function applyOpsToText(content: string, ops: ReplaceOp[]): { text: string; error?: string } {
  const sorted = [...ops].sort((a, b) => a.start - b.start);
  // 全部区间相对原始文本: 先统一校验(越界/重叠), 再从后往前应用(避免前面编辑改变后续偏移)
  for (let i = 0; i < sorted.length; i++) {
    const op = sorted[i];
    if (op.start < 0 || op.end > content.length || op.start > op.end) return { text: "", error: `区间非法 [${op.start},${op.end}) 文本长 ${content.length}` };
    if (i > 0 && op.start < sorted[i - 1].end) return { text: "", error: `操作区间重叠 [${sorted[i - 1].start},${sorted[i - 1].end}) 与 [${op.start},${op.end})` };
  }
  let cur = content;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const op = sorted[i];
    cur = cur.slice(0, op.start) + op.text + cur.slice(op.end);
  }
  return { text: cur };
}

/**
 * 原子应用 ChangeSet(基于 base_version 的编辑):
 *  - 乐观锁: 当前 content_version ≠ base_version → conflict(返回最新版本, 不改动)
 *  - fencing: 请求方 token < 文档 writer_lease_token → 旧写者, 拒绝
 *  - 成功: content+1、写 document_versions 行、锚点重映射(见第 3 节)
 */
export async function applyChangeSet(input: {
  documentId: string;
  holder: string;
  token: number;
  summary?: string;
  ops: ReplaceOp[];
  actor?: string;
}): Promise<ChangeSetApplyResult> {
  const doc = await pool.query(
    `select content, content_version, writer_lease_token, writer_lease_holder from documents where id = $1::uuid`,
    [input.documentId]
  );
  if (doc.rows.length === 0) return { ok: false, error: "文档不存在" };
  const d = doc.rows[0];
  // fencing 检查
  if (d.writer_lease_holder !== input.holder) return { ok: false, error: "未持 WriterLease(先 acquire)" };
  if (Number(d.writer_lease_token) > input.token) return { ok: false, error: "旧编辑令牌已过期(他人已新编辑), 请重读重写" };
  const baseVersion = Number(d.content_version);
  const applied = applyOpsToText(String(d.content || ""), input.ops);
  if (applied.error) return { ok: false, error: applied.error };
  // 事务: 版本检查 + 更新内容 + 写版本历史 + 落 change_set + 锚点重映射
  const client = await pool.connect();
  try {
    await client.query("begin");
    const chk = await client.query(
      `select content_version from documents where id = $1::uuid for update`, [input.documentId]
    );
    const curVersion = Number(chk.rows[0]?.content_version ?? -1);
    if (curVersion !== baseVersion) {
      await client.query("rollback");
      return { ok: false, error: `版本冲突: 基准 ${baseVersion}, 当前 ${curVersion} — 请基于新版重做`, currentVersion: curVersion };
    }
    const changeSetId = randomUUID();
    const newVersion = curVersion + 1;
    await client.query(
      `update documents set content = $2, content_version = $3, updated_at = now()
       where id = $1::uuid`,
      [input.documentId, applied.text, newVersion]
    );
    await client.query(
      `insert into document_versions (document_id, version, content_hash) values ($1, $2, $3)`,
      [input.documentId, newVersion, hashOf(applied.text)]
    );
    await client.query(
      `insert into doc_change_sets (id, document_id, base_version, summary, status, operations, actor, applied_version, applied_at)
       values ($1, $2, $3, $4, 'applied', $5::jsonb, $6, $7, now())`,
      [changeSetId, input.documentId, baseVersion, input.summary || "", JSON.stringify(input.ops), input.actor || "agent", newVersion]
    );
    // 锚点重映射: 该文档已 resolved 锚点按 ops 位移(区间 [start,end) 被改 → orphaned)
    await remapAnchorsTx(client, input.documentId, baseVersion, input.ops, changeSetId);
    await client.query("commit");
    return { ok: true, changeSetId, newVersion };
  } catch (e: any) {
    try { await client.query("rollback"); } catch { /* ignore */ }
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  } finally {
    client.release();
  }
}

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ═══ 3. 锚点(text_range) ═══
export interface AnchorInput {
  documentId: string;
  version: number;        // 锚定在哪个版本
  start: number;
  end: number;
  quote?: string;
  note?: string;
}

/** 建锚点(须给出版本对应的 quote 供校验/审计) */
export async function createAnchor(a: AnchorInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const r = await pool.query(
      `insert into doc_anchors (id, document_id, version, start_offset, end_offset, quote, note)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [randomUUID(), a.documentId, a.version, a.start, a.end, a.quote || null, a.note || null]
    );
    return { ok: true, id: r.rows[0].id };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** 列出文档锚点 */
export async function listAnchors(documentId: string): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query(
    `select id, version, start_offset, end_offset, quote, note, state from doc_anchors
     where document_id = $1::uuid order by version, start_offset`, [documentId]
  );
  return r.rows.map((x) => ({ ...x, startOffset: Number(x.start_offset), endOffset: Number(x.end_offset) }));
}

/**
 * 锚点重映射(事务内, ChangeSet 应用后): 对每个 resolved 锚点,
 * 若其区间与任一被改区间相交 → orphaned(引用内容已变);
 * 完全在被改区间前 → 位移(被插入文本推后/被删文本前移)。
 */
async function remapAnchorsTx(client: any, documentId: string, fromVersion: number, ops: ReplaceOp[], changeSetId: string): Promise<void> {
  const anchors = await client.query(
    `select id, start_offset, end_offset from doc_anchors
     where document_id = $1::uuid and version = $2 and state = 'resolved'`,
    [documentId, fromVersion]
  );
  for (const an of anchors.rows) {
    const aStart = Number(an.start_offset);
    const aEnd = Number(an.end_offset);
    let delta = 0;
    let orphaned = false;
    for (const op of ops) {
      const diff = op.text.length - (op.end - op.start);
      if (aStart < op.end && aEnd > op.start) { orphaned = true; break; } // 与编辑区间相交 → 失效
      if (aStart >= op.end) delta += diff; // 锚点整体在编辑点之后 → 位移
    }
    if (orphaned) {
      await client.query(
        `update doc_anchors set state = 'orphaned', remapped_from = null
         where id = $1`, [an.id]
      );
      void changeSetId;
    } else if (delta !== 0) {
      await client.query(
        `update doc_anchors set start_offset = start_offset + $2, end_offset = end_offset + $2
         where id = $1`, [an.id, delta]
      );
    }
  }
}

export const docSessionService = {
  acquireWriterLease, releaseWriterLease, applyChangeSet, createAnchor, listAnchors, applyOpsToText,
};
