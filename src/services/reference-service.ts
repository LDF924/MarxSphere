// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// reference-service.ts — 参考文献解析导入（2026-08-27, Agentero 对照）
// 能力: 从论文文本提取参考文献列表 → 识别 arXiv/DOI/标题 → 一键导入
// 免依赖: 正则解析（arXiv ID / DOI / 常见引用格式）
import { pool } from "../db/pool.js";

export interface ReferenceHit {
  raw: string;             // 原始引用行
  title?: string;          // 尝试提取的标题（粗提取: DOI/arXiv 有则用之）
  doi?: string;
  arxivId?: string;
  url?: string;
}

/** 从论文文本提取参考文献区（References/Bibliography 之后的内容） */
export function extractReferences(text: string): string[] {
  const markers = [
    /\bReferences\b/i, /\bBibliography\b/i, /\b参考文献\b/, /\bREFERENCES\b/,
    /\[1\]\s/, /\[1\]\s*$/, /^\s*1\.\s+[A-Z]/m,
  ];
  let start = -1;
  for (const m of markers) {
    const idx = m instanceof RegExp ? text.search(m) : -1;
    if (idx >= 0 && (start < 0 || idx < start)) start = idx;
  }
  if (start < 0) return [];
  const refSection = text.slice(start);
  // 按引用条目切分（[1] 或 [1]. 开头的新行）
  const entries = refSection
    .split(/\n(?=\[\d+\]|\[\d+\]\.|\[\d+\]\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
  return entries.slice(0, 50);
}

/** 从引用行提取 DOI / arXiv / URL */
export function parseReference(raw: string): ReferenceHit {
  const hit: ReferenceHit = { raw };
  const doiMatch = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/i.exec(raw);
  if (doiMatch) hit.doi = doiMatch[1];
  const arxivMatch = /\b(\d{4}\.\d{4,5})(v\d+)?\b/.exec(raw);
  if (arxivMatch) {
    hit.arxivId = arxivMatch[1];
    hit.url = `https://arxiv.org/abs/${arxivMatch[1]}`;
  }
  const urlMatch = /(https?:\/\/[^\s]+)/.exec(raw);
  if (urlMatch && !hit.url) hit.url = urlMatch[1];
  // 标题粗提取（"Title." 或 "Title," 开头部分, 20-100 字符）
  const t = raw.replace(/^\[\d+\]\.?\s*/, "").replace(/^(doi|https?:\/\/\S+)\s*/i, "");
  if (t.length > 15 && t.length < 200) hit.title = t.slice(0, 120);
  return hit;
}

/** 从文档内容解析参考文献 */
export function parseReferencesFromContent(content: string): ReferenceHit[] {
  return extractReferences(content).map(parseReference);
}

/** 导入参考文献到项目（arXiv/DOI 判重） */
export async function importReferences(refs: ReferenceHit[], sourceId: string): Promise<{ imported: number; skipped: number }> {
  let imported = 0, skipped = 0;
  for (const ref of refs) {
    const externalId = ref.arxivId ? `arxiv-${ref.arxivId}` : (ref.doi ? `doi-${ref.doi}` : null);
    if (!externalId) { skipped++; continue; }
    const dup = await pool.query("select 1 from documents where source_id = $1 and external_id = $2", [sourceId, externalId]);
    if (dup.rows.length > 0) { skipped++; continue; }
    await pool.query(
      `insert into documents (id, source_id, external_id, title, content, status, parse_status, metadata)
       values (gen_random_uuid(), $1, $2, $3, $4, 'COMPLETED', 'COMPLETED', $5::jsonb)`,
      [sourceId, externalId, ref.title || ref.raw.slice(0, 80), ref.raw,
       JSON.stringify({ source: "reference", doi: ref.doi, arxivId: ref.arxivId, url: ref.url })]
    );
    imported++;
  }
  return { imported, skipped };
}

export const referenceService = {
  extractReferences,
  parseReference,
  parseReferencesFromContent,
  importReferences,
};
