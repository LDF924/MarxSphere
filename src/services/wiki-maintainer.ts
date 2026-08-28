// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// wiki-maintainer.ts — L2 wiki 知识库维护器（2026-08-29, 借鉴 Inno Agent L2 wiki-maintainer）
// 定期巡检 notes 知识库:
//   1. 破损链接检测: [[目标]] 指向不存在的笔记 → 列出待创建
//   2. 孤立页检测: 无入链且无出链的笔记 → 提示关联或归档
//   3. 过期检测: 长期未更新的笔记 → 提示复习/重写
//   4. 链接修复建议: 标题近似匹配(编辑距离) → 建议重定向
import { pool } from "../db/pool.js";

export interface WikiIssue {
  kind: "broken_link" | "orphan" | "stale" | "redirect_hint";
  noteId?: string;
  noteTitle: string;
  detail: string;
  target?: string;
  suggestion?: string;
}

/** 巡检知识库, 返回问题清单 */
export async function auditWiki(thresholdDays = 60): Promise<{ ok: boolean; issues: WikiIssue[]; stats: Record<string, number> }> {
  const issues: WikiIssue[] = [];
  const notes = (await pool.query("select id, title, content, updated_at from notes order by title")).rows;

  // 1) 破损链接: 提取全部 [[目标]] 并对照 notes.title
  const titles = new Set(notes.map((n) => n.title));
  const linkHints = new Map<string, string>(); // 目标 → 建议(近似标题)
  for (const n of notes) {
    const links = [...n.content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
    for (const t of links) {
      if (titles.has(t)) continue;
      if (issues.some((i) => i.kind === "broken_link" && i.target === t)) continue;
      let hint = "";
      // 近似匹配: 包含关系/编辑距离 ≤ 2
      for (const t2 of titles) {
        if (t2.includes(t) || t.includes(t2)) { hint = `→ 已有「${t2}」`; break; }
        if (levenshtein(t, t2) <= 2) { hint = `→ 疑似「${t2}」`; break; }
      }
      issues.push({ kind: "broken_link", noteId: n.id, noteTitle: n.title, target: t, detail: `「${n.title}」引用了不存在的「${t}」`, suggestion: hint });
    }
  }

  // 2) 孤立页: 无入链(backlinks)且无出链
  const backlinkCounts: Record<string, number> = {};
  for (const n of notes) {
    for (const m of n.content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const t = m[1].trim();
      backlinkCounts[t] = (backlinkCounts[t] || 0) + 1;
    }
  }
  for (const n of notes) {
    const out = (n.content.match(/\[\[/g) || []).length;
    const inb = backlinkCounts[n.title] || 0;
    if (out === 0 && inb === 0) {
      issues.push({ kind: "orphan", noteId: n.id, noteTitle: n.title, detail: `「${n.title}」无入链且无出链(孤立页)`, suggestion: "添加双链关联或归档" });
    }
  }

  // 3) 过期检测: 更新超过 thresholdDays 天
  const cutoff = new Date(Date.now() - thresholdDays * 24 * 3600 * 1000);
  for (const n of notes) {
    if (new Date(n.updated_at) < cutoff) {
      issues.push({ kind: "stale", noteId: n.id, noteTitle: n.title, detail: `「${n.title}」已 ${Math.floor((Date.now() - new Date(n.updated_at).getTime()) / 86400000)} 天未更新`, suggestion: "复习并更新内容" });
    }
  }

  const stats = {
    broken_links: issues.filter((i) => i.kind === "broken_link").length,
    orphans: issues.filter((i) => i.kind === "orphan").length,
    stale: issues.filter((i) => i.kind === "stale").length,
    total: issues.length,
  };
  return { ok: true, issues: issues.slice(0, 100), stats };
}

/** 一键修复: 破损链接目标批量创建空笔记(或重命名建议) */
export async function createMissingNotes(createAll = false): Promise<{ ok: boolean; created: string[]; skipped: string[] }> {
  const audit = await auditWiki();
  const missing = [...new Set(audit.issues.filter((i) => i.kind === "broken_link" && i.target).map((i) => i.target as string))];
  const created: string[] = [];
  const skipped: string[] = [];
  for (const t of missing) {
    const hasHint = audit.issues.find((i) => i.target === t && i.suggestion);
    if (hasHint?.suggestion && !createAll) { skipped.push(t); continue; }
    try {
      await pool.query("insert into notes (title, content) values ($1, $2) on conflict (title) do nothing", [t, `# ${t}\n\n<!-- 由维护器自动创建, 待补充内容 -->`]);
      created.push(t);
    } catch { skipped.push(t); }
  }
  return { ok: true, created, skipped };
}

/** 编辑距离(标题近似匹配) */
function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export const wikiMaintainerService = { auditWiki, createMissingNotes };
