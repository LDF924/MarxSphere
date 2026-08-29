// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// wiki-query.ts — L2 wiki 查询（2026-08-29, 借鉴 Inno Agent wiki-query.ts, MIT License）
// Copyright (c) 2026 Inno Agent Contributors — 行为对齐, 存储适配 MarxSphere notes 表
// 查询 wiki: 返回索引(笔记列表) + 匹配笔记内容(标题/内容关键词检索)
import { pool } from "../db/pool.js";

export interface WikiQueryHit {
  title: string;
  score: number;
  matchedFields: string[];   // title | content | tags
}

/** 索引: 全部笔记标题(与 Inno readIndex 对齐) */
export async function readIndex(): Promise<string> {
  const r = await pool.query("select title, updated_at from notes order by title").catch(() => ({ rows: [] }));
  if (r.rows.length === 0) return "L2 Wiki 尚未初始化，暂无索引。";
  return r.rows.map((n: any) => `- [[${n.title}]] (更新 ${String(n.updated_at).slice(0, 10)})`).join("\n");
}

/** 读单篇笔记 */
export async function readWikiPage(title: string): Promise<string | null> {
  const r = await pool.query("select content from notes where title = $1", [title]).catch(() => ({ rows: [] }));
  return r.rows[0]?.content ?? null;
}

/** 搜索笔记: 标题优先(权重高), 内容次之(与 Inno searchEntries 对齐) */
export async function searchEntries(query: string, limit = 10): Promise<WikiQueryHit[]> {
  const keywords = query.toLowerCase().split(/\s+/).filter((k) => k.length >= 2);
  if (keywords.length === 0) return [];
  const r = await pool.query("select title, content from notes").catch(() => ({ rows: [] }));
  const hits: WikiQueryHit[] = [];
  for (const n of r.rows as Array<{ title: string; content: string }>) {
    const matched: string[] = [];
    let score = 0;
    const title = n.title.toLowerCase();
    const content = n.content.toLowerCase();
    for (const kw of keywords) {
      if (title.includes(kw)) { matched.push("title"); score += 3; }
      if (content.includes(kw)) { matched.push("content"); score += 1; }
    }
    if (matched.length > 0) hits.push({ title: n.title, score, matchedFields: [...new Set(matched)] });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 查询 wiki: 索引 + 匹配笔记内容(与 Inno queryWiki 对齐) */
export async function queryWiki(query: string, limit = 5): Promise<string> {
  const index = await readIndex();
  const trimmed = (query ?? "").trim();
  if (!trimmed) {
    return `## Wiki 索引\n\n${index}\n\n---\n\n提示：传入 query 参数（如「剩余价值」）可定位并返回相关页面内容。`;
  }
  const matches = await searchEntries(trimmed, limit);
  if (matches.length === 0) {
    return `## Wiki 索引\n\n${index}\n\n---\n\n未找到与「${trimmed}」相关的内容。`;
  }
  const sections: string[] = [`## Wiki 索引\n\n${index}`, "---"];
  for (const m of matches) {
    const content = await readWikiPage(m.title);
    sections.push(`## 笔记：${m.title}\n\n${(content ?? "（空）").slice(0, 2000)}`);
  }
  return sections.join("\n\n");
}

export const wikiQueryService = { readIndex, readWikiPage, searchEntries, queryWiki };
