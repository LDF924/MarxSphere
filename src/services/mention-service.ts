// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// mention-service.ts — 对话里的 @ 引用来源(2026-10-02)
//
// ═══ 由来 ═══
// 实测本仓此前**只有 `@skill:`**(ChatPanel.tsx:421), 没有任何"引用一个文件/文献"的语法 ——
// 用户只能整体上传附件或口头描述路径。对照 Respal 的导览, @ 引用文件是它的第一序列能力。
//
// ═══ 为什么是这三种来源 ═══
// 对话里真正会被引用的东西只有三类, 各自有**不同的读取路径**(不能合并成一张表):
//   · workspace —— agent 工作区里的素材(agent_workspace/assets), 按相对路径读
//   · upload    —— 用户上传的文件(user_files), 按 storage_rel 读, 可能已有 extraction 文本
//   · literature—— 已入库文献(documents), 按 document_id 读切片
// 三者的权限与生命周期都不同, 所以这里只做**统一列举**(给前端选), 读取仍走各自既有链路。
//
// ═══ 为什么不返回全文 ═══
// 列举接口只给元数据(名字/类型/大小/时间)。引用之后由调用方按既有工具读内容 ——
// 一次把 100 个文件的正文塞进响应会把对话上下文一次打满。
import { pool } from "../db/pool.js";
import { listWorkspaceAssets } from "./agent-workspace-service.js";

export interface MentionItem {
  /** 引用语法里写的东西, 如 `@file:assets/调研数据.csv` / `@doc:<uuid>` */
  ref: string;
  kind: "workspace" | "upload" | "literature";
  label: string;
  /** 副标题(路径/期刊/年份), 供列表第二行显示 */
  hint: string;
  bytes?: number;
  /** 入库时间, 用于排序 */
  at?: string;
}

/** 列举可引用对象。query 为空时按类别给"最近若干条", 有 query 时做子串过滤。 */
export async function listMentionables(
  userId: string,
  opts: { query?: string; kind?: MentionItem["kind"]; limit?: number } = {}
): Promise<MentionItem[]> {
  const q = String(opts.query || "").trim().toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 50);
  const want = (k: MentionItem["kind"]) => !opts.kind || opts.kind === k;
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
  const out: MentionItem[] = [];

  // ① 工作区素材 —— 同步读本地目录, 没有就空
  if (want("workspace")) {
    try {
      for (const a of listWorkspaceAssets()) {
        if (!hit(a.rel)) continue;
        out.push({
          ref: `@file:${a.rel}`,
          kind: "workspace",
          label: a.rel.replace(/^assets\//, ""),
          hint: "工作区素材",
          bytes: a.bytes
        });
      }
    } catch { /* 工作区不存在时跳过这一类 */ }
  }

  // ② 用户上传的文件。extraction <> '' 的标记出来 —— 那意味着**文本已抽过**,
  //    引用它可以省一次解析(用户与模型都受益)。这个区分对使用者有实际意义, 所以显示。
  if (want("upload")) {
    try {
      const r = await pool.query(
        `select id, filename, mime, size_bytes, created_at,
                (coalesce(extraction,'') <> '') as has_text
           from user_files
          where user_id = $1
          order by created_at desc limit 200`,
        [userId]
      );
      for (const row of r.rows) {
        const name = String(row.filename || "");
        if (!hit(name)) continue;
        out.push({
          ref: `@upload:${row.id}`,
          kind: "upload",
          label: name,
          hint: `上传文件${row.has_text ? " · 已抽文本" : ""}`,
          bytes: Number(row.size_bytes) || undefined,
          at: row.created_at ? new Date(row.created_at).toISOString() : undefined
        });
      }
    } catch { /* user_files 不可用时跳过 */ }
  }

  // ③ 已入库文献 —— documents 是全局表(不分用户), 所以不做 user 过滤,
  //    但只给标题元数据, 不含正文
  if (want("literature")) {
    try {
      const r = await pool.query(
        `select id, title, created_at from documents
          where archived_at is null
          order by created_at desc limit 200`
      );
      for (const row of r.rows) {
        const title = String(row.title || "");
        if (!title || !hit(title)) continue;
        out.push({
          ref: `@doc:${row.id}`,
          kind: "literature",
          label: title,
          hint: "文献库",
          at: row.created_at ? new Date(row.created_at).toISOString() : undefined
        });
      }
    } catch { /* documents 不可用时跳过 */ }
  }

  // 每类各留 limit 条 —— 不合并排序, 否则"文献 200 条"会把工作区素材全挤掉
  const byKind = new Map<string, MentionItem[]>();
  for (const it of out) {
    const arr = byKind.get(it.kind) ?? [];
    if (arr.length < limit) { arr.push(it); byKind.set(it.kind, arr); }
  }
  return [...byKind.values()].flat();
}

/** 解析一段文本里的 @ 引用 —— 发送前用它把引用摘出来, 交给调用方按 kind 取内容。
 *
 *  语法(与 ChatPanel 的插入保持一致): `@file:<相对路径>` / `@upload:<uuid>` / `@doc:<uuid>`
 *  **不匹配** `@skill:` —— 那是另一套语义(引用的是能力而不是数据), 由既有链路处理。
 */
export function parseMentions(text: string): Array<{ kind: MentionItem["kind"]; id: string; raw: string }> {
  const out: Array<{ kind: MentionItem["kind"]; id: string; raw: string }> = [];
  const re = /@(file|upload|doc):([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || ""))) !== null) {
    const kind = m[1] === "file" ? "workspace" : m[1] === "upload" ? "upload" : "literature";
    out.push({ kind, id: m[2], raw: m[0] });
  }
  // 去重(同一文件被引用两次只取一次)
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = `${x.kind}:${x.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const mentionService = { listMentionables, parseMentions };
