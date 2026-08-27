// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// notes-service.ts — 双链笔记 + 知识图谱（2026-08-27, Agentero 对照）
// Obsidian 风格 [[wikilinks]]: 笔记互链 → 知识图谱浏览
import { pool } from "../db/pool.js";

/** 提取内容中的 [[wikilinks]] */
export function extractWikilinks(content: string): string[] {
  const links = [...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
  return [...new Set(links)];
}

/** 创建/更新笔记（保存 [[链接]] 文本; 目标解析在读取时动态做, 避免"创建时目标尚不存在"漏链） */
export async function saveNote(input: { title: string; content: string; sourceId?: string }): Promise<{ id: string; title: string }> {
  const title = input.title.trim();
  const r = await pool.query(
    `insert into notes (id, title, content, source_id) values (gen_random_uuid(), $1, $2, $3)
     on conflict (title) do update set content = excluded.content, updated_at = now()
     returning id, title`,
    [title, input.content, input.sourceId || null]
  );
  return { id: String(r.rows[0].id), title };
}

/** 笔记列表 */
export async function listNotes(sourceId?: string): Promise<Array<{ id: string; title: string; updated_at: string }>> {
  const r = sourceId
    ? await pool.query("select id, title, updated_at from notes where source_id = $1 order by updated_at desc limit 200", [sourceId])
    : await pool.query("select id, title, updated_at from notes order by updated_at desc limit 200");
  return r.rows.map((x: any) => ({ id: String(x.id), title: x.title, updated_at: new Date(x.updated_at).toISOString() }));
}

/** 单笔记（含出链/入链 — 动态解析, 目标存在性实时判定） */
export async function getNote(id: string): Promise<{ id: string; title: string; content: string; links: Array<{ title: string; exists: boolean }>; backlinks: Array<{ title: string }> } | null> {
  const r = await pool.query("select * from notes where id = $1", [id]);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  // 出链: 从 content 提取 [[...]], 实时查目标是否存在
  const linkTitles = extractWikilinks(row.content);
  const links: Array<{ title: string; exists: boolean }> = [];
  for (const t of linkTitles) {
    const target = await pool.query("select 1 from notes where title = $1", [t]);
    links.push({ title: t, exists: target.rows.length > 0 });
  }
  // 入链: 其他笔记 content 里 [[本笔记标题]]
  const back = await pool.query("select id, title from notes where content like $1", [`%[[${row.title}]]%`]);
  return {
    id: String(row.id), title: row.title, content: row.content,
    links,
    backlinks: back.rows.map((b: any) => ({ title: b.title })),
  };
}

/** 知识图谱: 节点=笔记, 边=链接（动态解析, 只连存在的目标） */
export async function noteGraph(): Promise<{ nodes: Array<{ id: string; title: string }>; edges: Array<{ source: string; target: string }> }> {
  const nodes = await pool.query("select id, title, content from notes limit 200");
  const nodeList = nodes.rows.map((n: any) => ({ id: String(n.id), title: n.title }));
  const idByTitle = new Map(nodeList.map((n) => [n.title, n.id]));
  const edges: Array<{ source: string; target: string }> = [];
  for (const n of nodes.rows) {
    for (const t of extractWikilinks(String(n.content || ""))) {
      const targetId = idByTitle.get(t);
      if (targetId && targetId !== String(n.id)) edges.push({ source: String(n.id), target: targetId });
    }
  }
  return { nodes: nodeList, edges };
}

export const notesService = {
  extractWikilinks, saveNote, listNotes, getNote, noteGraph,
};
