// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// notes-service.ts — 双链笔记 + 知识图谱（2026-08-27, Agentero 对照）
// Obsidian 风格 [[wikilinks]]: 笔记互链 → 知识图谱浏览
import { pool } from "../db/pool.js";

/** 提取内容中的 [[wikilinks]] */
export function extractWikilinks(content: string): string[] {
  const links = [...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
  return [...new Set(links)];
}

/** 创建/更新笔记（自动解析 [[链接]] 写 note_links） */
export async function saveNote(input: { title: string; content: string; sourceId?: string }): Promise<{ id: string; title: string }> {
  const title = input.title.trim();
  const r = await pool.query(
    `insert into notes (id, title, content, source_id) values (gen_random_uuid(), $1, $2, $3)
     on conflict (title) do update set content = excluded.content, updated_at = now()
     returning id, title`,
    [title, input.content, input.sourceId || null]
  );
  const noteId = String(r.rows[0].id);
  // 重写链接（原链接删除 → 新链接插入）
  await pool.query("delete from note_links where from_note_id = $1", [noteId]);
  for (const target of extractWikilinks(input.content)) {
    const targetNote = await pool.query("select id from notes where title = $1", [target]);
    await pool.query(
      "insert into note_links (from_note_id, to_note_id, to_title) values ($1, $2, $3)",
      [noteId, targetNote.rows.length > 0 ? String(targetNote.rows[0].id) : null, target]
    );
  }
  return { id: noteId, title };
}

/** 笔记列表 */
export async function listNotes(sourceId?: string): Promise<Array<{ id: string; title: string; updated_at: string }>> {
  const r = sourceId
    ? await pool.query("select id, title, updated_at from notes where source_id = $1 order by updated_at desc limit 200", [sourceId])
    : await pool.query("select id, title, updated_at from notes order by updated_at desc limit 200");
  return r.rows.map((x: any) => ({ id: String(x.id), title: x.title, updated_at: new Date(x.updated_at).toISOString() }));
}

/** 单笔记（含出链/入链） */
export async function getNote(id: string): Promise<{ id: string; title: string; content: string; links: Array<{ title: string; exists: boolean }>; backlinks: Array<{ title: string }> } | null> {
  const r = await pool.query("select * from notes where id = $1", [id]);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  const links = await pool.query("select to_title, to_note_id from note_links where from_note_id = $1", [id]);
  const back = await pool.query(
    `select n.title from note_links nl join notes n on n.id = nl.from_note_id where nl.to_note_id = $1`, [id]
  );
  return {
    id: String(row.id), title: row.title, content: row.content,
    links: links.rows.map((l: any) => ({ title: l.to_title, exists: !!l.to_note_id })),
    backlinks: back.rows.map((b: any) => ({ title: b.title })),
  };
}

/** 知识图谱: 节点=笔记, 边=链接 */
export async function noteGraph(): Promise<{ nodes: Array<{ id: string; title: string }>; edges: Array<{ source: string; target: string }> }> {
  const nodes = await pool.query("select id, title from notes limit 200");
  const edges = await pool.query(
    `select nf.id as source, nt.id as target from note_links nl
     join notes nf on nf.id = nl.from_note_id
     join notes nt on nt.id = nl.to_note_id`
  );
  return {
    nodes: nodes.rows.map((n: any) => ({ id: String(n.id), title: n.title })),
    edges: edges.rows.map((e: any) => ({ source: String(e.source), target: String(e.target) })),
  };
}

export const notesService = {
  extractWikilinks, saveNote, listNotes, getNote, noteGraph,
};
