// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// prerequisite-store.ts — 前置知识边存储（2026-08-29, 移植自 Inno Agent prerequisite-store.ts, MIT License）
// Copyright (c) 2026 Inno Agent Contributors — 算法与结构保持一致
// 从概念页 frontmatter 读取显式前置知识边(prerequisites):
//   ---
//   concept_id: 剩余价值
//   prerequisites:
//     - concept_id: 商品二因素
//       relation: required
//       required_level: 0.65
//   ---
// 普通 wikilink 忽略(关联 ≠ 教学依赖方向)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PrerequisiteEdge, PrerequisiteRelation, PrerequisiteSource } from "./prerequisite-resolver.js";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface ConceptFrontmatter {
  concept_id?: string;
  confidence?: "high" | "medium" | "low";
  prerequisites?: Array<{
    concept_id: string;
    relation?: PrerequisiteRelation;
    required_level?: number;
    importance?: number;
    source?: PrerequisiteSource;
    source_confidence?: number;
    rationale?: string;
    scope?: string;
  }>;
}

function confidenceFromPage(value: string | undefined): number {
  if (value === "high") return 0.9;
  if (value === "low") return 0.4;
  return 0.65;
}

/** 解析 markdown frontmatter(--- 之间的 YAML 简化解析) */
export function parseFrontmatter(raw: string): { frontmatter: ConceptFrontmatter | null } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return { frontmatter: null };
  const body = m[1];
  const fm: ConceptFrontmatter = {};
  const concept = /concept_id:\s*["']?([^"'\n]+)["']?/.exec(body);
  if (concept) fm.concept_id = concept[1].trim();
  const conf = /confidence:\s*["']?(high|medium|low)["']?/.exec(body);
  if (conf) fm.confidence = conf[1] as ConceptFrontmatter["confidence"];
  // prerequisites: 列表项(支持 - concept_id: X 的连续条目)
  const prereqs: NonNullable<ConceptFrontmatter["prerequisites"]> = [];
  const items = [...body.matchAll(/-\s*concept_id:\s*["']?([^"'\n]+)["']?([\s\S]*?)(?=\n-\s*concept_id:|\n[a-zA-Z_]+:|$)/g)];
  for (const it of items) {
    const item: NonNullable<ConceptFrontmatter["prerequisites"]>[number] = { concept_id: it[1].trim() };
    const relation = /relation:\s*["']?(required|supporting)["']?/.exec(it[2]);
    if (relation) item.relation = relation[1] as PrerequisiteRelation;
    const level = /required_level:\s*([\d.]+)/.exec(it[2]);
    if (level) item.required_level = parseFloat(level[1]);
    const imp = /importance:\s*([\d.]+)/.exec(it[2]);
    if (imp) item.importance = parseFloat(imp[1]);
    const src = /source:\s*["']?([a-z_]+)["']?/.exec(it[2]);
    if (src) item.source = src[1] as PrerequisiteSource;
    const conf2 = /source_confidence:\s*([\d.]+)/.exec(it[2]);
    if (conf2) item.source_confidence = parseFloat(conf2[1]);
    const rationale = /rationale:\s*["']?([^"'\n]+)["']?/.exec(it[2]);
    if (rationale) item.rationale = rationale[1].trim();
    const scope = /scope:\s*["']?([^"'\n]+)["']?/.exec(it[2]);
    if (scope) item.scope = scope[1].trim();
    prereqs.push(item);
  }
  if (prereqs.length) fm.prerequisites = prereqs;
  return { frontmatter: fm };
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...markdownFiles(p));
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(p);
  }
  return result;
}

/** 从概念页目录读取目标概念的前置边(与源码 loadPrerequisiteEdges 一致) */
export function loadPrerequisiteEdges(
  conceptsDir: string | undefined,
  targetConceptId: string,
  scope?: string,
): PrerequisiteEdge[] {
  if (!conceptsDir || !targetConceptId.trim()) return [];
  const edges: PrerequisiteEdge[] = [];
  for (const p of markdownFiles(conceptsDir)) {
    const { frontmatter } = parseFrontmatter(readFileSync(p, "utf-8"));
    if (!frontmatter || frontmatter.concept_id !== targetConceptId) continue;
    for (const item of frontmatter.prerequisites ?? []) {
      if (scope && item.scope && item.scope !== scope) continue;
      edges.push({
        targetConceptId,
        prerequisiteConceptId: item.concept_id,
        relation: item.relation ?? "required",
        requiredLevel: clamp01(item.required_level ?? 0.65),
        importance: clamp01(item.importance ?? 0.8),
        source: item.source ?? "imported",
        sourceConfidence: clamp01(item.source_confidence ?? confidenceFromPage(frontmatter.confidence)),
        rationale: item.rationale ?? `L2 概念页声明 ${item.concept_id} 为前置知识。`,
        depth: 1,
      });
    }
  }
  return edges;
}

export const prerequisiteStoreService = { loadPrerequisiteEdges, parseFrontmatter };
