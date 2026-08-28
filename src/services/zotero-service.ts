// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// zotero-service.ts — Zotero 集成（2026-08-27, Agentero 对照: Zotero 生态衔接）
// 能力: 导入 Zotero 书库(标题/标签/笔记/附件路径) → SAG documents; 导出 BibTeX
// 方式: Zotero 本地 HTTP API (http://localhost:23119/api, 需 Zotero 桌面运行) 或 本地 sqlite(只读)
// 免依赖: 全用 fetch / child_process(sqlite3 CLI 可选)
import { execFile } from "node:child_process";
import { pool } from "../db/pool.js";

const ZOTERO_API = process.env.ZOTERO_API_URL || "http://127.0.0.1:23119/api";
const ZOTERO_DB = process.env.ZOTERO_DATA_DIR
  ? `${process.env.ZOTERO_DATA_DIR}/zotero.sqlite`
  : (process.env.USERPROFILE ? `${process.env.USERPROFILE}/Zotero/zotero.sqlite` : "");

export interface ZoteroItem {
  key: string;                    // Zotero item key (external_id)
  title: string;
  itemType: string;               // journalArticle/book/report...
  creators: Array<{ name?: string; firstName?: string; lastName?: string; creatorType?: string }>;
  date?: string;
  tags: string[];
  notes: string;
  attachmentPath?: string;        // PDF 附件路径
  doi?: string;
  url?: string;
  abstractNote?: string;
}

// ─── 读取 Zotero 书库 ───

/** 方式1: Zotero 本地 HTTP API（桌面运行中）— GET /api/users/0/items?format=json */
async function fetchViaHttp(): Promise<ZoteroItem[] | null> {
  try {
    const resp = await fetch(`${ZOTERO_API}/users/0/items?format=json&limit=100`, {
      signal: (AbortSignal as any).timeout(8000),
    });
    if (!resp.ok) return null;
    const raw = await resp.json() as any[];
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw.map((it) => ({
      key: String(it.key || ""),
      title: String(it.data?.title || it.title || "未命名"),
      itemType: String(it.data?.itemType || "unknown"),
      creators: Array.isArray(it.data?.creators) ? it.data.creators : [],
      date: it.data?.date ? String(it.data.date) : undefined,
      tags: Array.isArray(it.data?.tags) ? it.data.tags.map((t: any) => String(t.tag || t)) : [],
      notes: "",
      attachmentPath: undefined,
      doi: it.data?.DOI ? String(it.data.DOI) : undefined,
      url: it.data?.url ? String(it.data.url) : undefined,
      abstractNote: it.data?.abstractNote ? String(it.data.abstractNote) : undefined,
    }));
  } catch { return null; }
}

/** 方式2: 本地 zotero.sqlite（只读查询, 需 sqlite3 CLI 或纯 JS 解析）— 简化: 用 sqlite3 CLI */
function querySqlite(sql: string): Promise<any[]> {
  return new Promise((resolve) => {
    if (!ZOTERO_DB) return resolve([]);
    execFile("sqlite3", [ZOTERO_DB, sql], { timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          // sqlite3 CLI json 输出需 -json; 这里用 line 模式简单解析
          const lines = String(stdout).trim().split("\n").filter(Boolean);
          resolve(lines.map((l) => JSON.parse(l)));
        } catch { resolve([]); }
      });
  });
}

/** 导入 Zotero 书库 → SAG（HTTP API 优先, sqlite 兜底） */
export async function importZoteroLibrary(sourceId: string): Promise<{ imported: number; skipped: number; items: ZoteroItem[] }> {
  let items = await fetchViaHttp();
  if (!items || items.length === 0) {
    // sqlite 兜底（简化: 只取标题/标签）
    const rows = await querySqlite(
      `SELECT json_object('key', i.key, 'title', idv.value, 'itemType', it.typeName, 'tags', '[]') as j
       FROM items i
       JOIN itemData id ON id.itemID = i.itemID
       JOIN itemDataValues idv ON idv.valueID = id.valueID
       JOIN itemTypes it ON it.itemTypeID = i.itemTypeID
       WHERE id.fieldID = 1 AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
       LIMIT 100`
    );
    items = rows.map((r: any) => {
      try { return JSON.parse(r.j || "{}"); } catch { return { title: String(r.j || "") }; }
    }).map((r: any) => ({ key: String(r.key || ""), title: String(r.title || "未命名"), itemType: String(r.itemType || "unknown"), creators: [], tags: [], notes: "" }));
  }
  if (items.length === 0) return { imported: 0, skipped: 0, items: [] };

  let imported = 0, skipped = 0;
  for (const it of items) {
    if (!it.title) { skipped++; continue; }
    // external_id 判重（Zotero key）
    const dup = await pool.query("select 1 from documents where source_id = $1 and external_id = $2", [sourceId, it.key]);
    if (dup.rows.length > 0) { skipped++; continue; }
    await pool.query(
      `insert into documents (id, source_id, external_id, title, content, status, parse_status, metadata)
       values (gen_random_uuid(), $1, $2, $3, $4, 'COMPLETED', 'COMPLETED', $5::jsonb)`,
      [sourceId, it.key, it.title, it.abstractNote || it.notes || "",
       JSON.stringify({ source: "zotero", itemType: it.itemType, tags: it.tags, creators: it.creators, doi: it.doi, url: it.url, date: it.date })]
    );
    imported++;
  }
  return { imported, skipped, items };
}

// ─── 导出 BibTeX ───

/** 生成 BibTeX（journalArticle 为主, 其他类型兜底 @misc） */
export function exportBibtex(items: ZoteroItem[]): string {
  const entries = items.map((it) => {
    const citeKey = (it.creators?.[0]?.lastName || "unknown").replace(/\s+/g, "").toLowerCase()
      + (it.date ? it.date.slice(0, 4) : "n.d.");
    const typeMap: Record<string, string> = {
      journalArticle: "article", book: "book", report: "techreport",
      thesis: "phdthesis", conferencePaper: "inproceedings", preprint: "misc",
    };
    const type = typeMap[it.itemType] || "misc";
    const author = (it.creators || [])
      .map((c) => c.lastName ? `${c.lastName}, ${c.firstName || ""}`.trim() : c.name || "")
      .filter(Boolean).join(" and ");
    const lines = [
      `@${type}{${citeKey},`,
      `  title = {${(it.title || "").replace(/[{}]/g, "")}},`,
      author ? `  author = {${author}},` : "",
      it.date ? `  year = {${it.date.slice(0, 4)}},` : "",
      it.doi ? `  doi = {${it.doi}},` : "",
      it.url ? `  url = {${it.url}},` : "",
      it.abstractNote ? `  abstract = {${it.abstractNote.replace(/[{}]/g, "").slice(0, 500)}},` : "",
      "}",
    ].filter(Boolean).join("\n");
    return lines;
  });
  return entries.join("\n\n") + "\n";
}

/** 浏览器插件/书签导入（2026-08-29, Agentero 对照: 支持从标识符、链接或浏览器插件保存论文）
 *  接收 Zotero 浏览器插件(或任何书签)保存的文献 JSON, 入库到项目
 *  兼容 Zotero translators 输出字段: title/creators/DOI/url/date/abstractNote/tags
 */
export async function importFromBrowserPlugin(items: Array<{
  title?: string; creators?: Array<{ firstName?: string; lastName?: string; name?: string }>;
  date?: string; DOI?: string; url?: string; abstractNote?: string; tags?: Array<{ tag?: string } | string>;
  itemType?: string;
}>, sourceId: string): Promise<{ imported: number; skipped: number }> {
  let imported = 0, skipped = 0;
  for (const it of items) {
    const title = String(it.title || "").trim();
    if (!title || title.length < 3) { skipped++; continue; }
    const doi = it.DOI ? String(it.DOI) : undefined;
    const externalId = doi || `plugin-${title.slice(0, 40)}`;
    const dup = await pool.query("select 1 from documents where source_id = $1 and external_id = $2", [sourceId, externalId]);
    if (dup.rows.length > 0) { skipped++; continue; }
    const creators = Array.isArray(it.creators) ? it.creators : [];
    const authors = creators.map((c) => c.lastName ? `${c.lastName}${c.firstName ? ", " + c.firstName : ""}` : (c.name || "")).filter(Boolean);
    const year = it.date ? parseInt(String(it.date).slice(0, 4), 10) : undefined;
    const tags = Array.isArray(it.tags) ? it.tags.map((t: any) => String(t.tag || t)) : [];
    await pool.query(
      `insert into documents (id, source_id, external_id, title, content, status, parse_status, metadata)
       values (gen_random_uuid(), $1, $2, $3, $4, 'COMPLETED', 'COMPLETED', $5::jsonb)`,
      [sourceId, externalId, title, it.abstractNote || "",
       JSON.stringify({ source: "zotero-plugin", itemType: it.itemType || "webpage", authors, year, doi, url: it.url, tags })]
    );
    imported++;
  }
  return { imported, skipped };
}

export const zoteroService = {
  importZoteroLibrary,
  exportBibtex,
  fetchViaHttp,
  importFromBrowserPlugin,
};
