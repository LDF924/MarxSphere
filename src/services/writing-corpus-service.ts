// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// writing-corpus-service.ts — 学术写作语料库（2026-08-16）
// 四大子库: 文本范例 / 核心概念 / 论证逻辑 / 词汇句式
// 设计原则: 语料是可复用学术资产 — 借鉴逻辑与句式, 不照搬原文
// 工作流: 积累(手动/agent沉淀/pdf提取) → 整理(LLM打标/检索) → 应用(面板调取/agent注入)
import { pool } from "../db/pool.js";
import { callLlm } from "../ai/llm-common.js";
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";

// ═══ 文本范例库 ═══
export interface CorpusText {
  id: number;
  language: "zh" | "en";
  text: string;
  source?: string;
  writingModule: string;
  tags: string[];
  note?: string;
  createdBy: string;
  createdAt: Date;
}

export async function addCorpusText(input: {
  language: string; text: string; source?: string; writingModule?: string; tags?: string[];
  note?: string; createdBy?: string; sourceTaskId?: string;
}): Promise<CorpusText | null> {
  if (!input.text?.trim()) return null;
  const r = await pool.query(
    `insert into writing_corpus_texts (language, text, source, writing_module, tags, note, created_by, source_task_id)
     values ($1,$2,$3,$4,$5::text[],$6,$7,$8) returning *`,
    [input.language === "en" ? "en" : "zh", input.text.trim(), input.source || null,
     input.writingModule || "引言", input.tags || [], input.note || null,
     input.createdBy || "manual", input.sourceTaskId || null]
  );
  return mapText(r.rows[0]);
}

export async function listCorpusTexts(filter: { module?: string; language?: string; tag?: string; q?: string; limit?: number }): Promise<CorpusText[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.module) { params.push(filter.module); conds.push(`writing_module = $${params.length}`); }
  if (filter.language) { params.push(filter.language); conds.push(`language = $${params.length}`); }
  if (filter.tag) { params.push(filter.tag); conds.push(`$${params.length} = any(tags)`); }
  if (filter.q) { params.push(`%${filter.q}%`); conds.push(`(text ilike $${params.length} or note ilike $${params.length} or source ilike $${params.length})`); }
  const where = conds.length > 0 ? "where " + conds.join(" and ") : "";
  const limit = Math.min(Math.max(filter.limit || 50, 1), 200);
  const r = await pool.query(`select * from writing_corpus_texts ${where} order by id desc limit ${limit}`, params);
  return r.rows.map(mapText);
}

function mapText(row: any): CorpusText {
  return {
    id: Number(row.id), language: row.language, text: row.text, source: row.source,
    writingModule: row.writing_module, tags: Array.isArray(row.tags) ? row.tags : [],
    note: row.note, createdBy: row.created_by, createdAt: row.created_at,
  };
}

// ═══ 核心概念库 ═══
export interface CorpusConcept {
  id: number;
  name: string;
  definition: string;
  proposer?: string;
  year?: string;
  evolution: Array<{ year: string; scholar: string; contribution: string }>;
  boundary?: string;
  related: string[];
  tags: string[];
}

export async function addCorpusConcept(input: {
  name: string; definition: string; proposer?: string; year?: string;
  evolution?: Array<{ year: string; scholar: string; contribution: string }>;
  boundary?: string; related?: string[]; tags?: string[];
}): Promise<CorpusConcept | null> {
  if (!input.name?.trim() || !input.definition?.trim()) return null;
  const r = await pool.query(
    `insert into writing_corpus_concepts (name, definition, proposer, year, evolution, boundary, related, tags)
     values ($1,$2,$3,$4,$5::jsonb,$6,$7::text[],$8::text[])
     on conflict (name) do update set definition = excluded.definition, proposer = excluded.proposer,
       year = excluded.year, evolution = excluded.evolution, boundary = excluded.boundary,
       related = excluded.related, tags = excluded.tags
     returning *`,
    [input.name.trim(), input.definition.trim(), input.proposer || null, input.year || null,
     JSON.stringify(input.evolution || []), input.boundary || null, input.related || [], input.tags || []]
  );
  return mapConcept(r.rows[0]);
}

export async function listCorpusConcepts(filter: { q?: string; limit?: number }): Promise<CorpusConcept[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.q) {
    params.push(`%${filter.q}%`);
    conds.push(`(name ilike $${params.length} or definition ilike $${params.length} or proposer ilike $${params.length})`);
  }
  const where = conds.length > 0 ? "where " + conds.join(" and ") : "";
  const limit = Math.min(Math.max(filter.limit || 100, 1), 200);
  const r = await pool.query(`select * from writing_corpus_concepts ${where} order by name limit ${limit}`, params);
  return r.rows.map(mapConcept);
}

function mapConcept(row: any): CorpusConcept {
  return {
    id: Number(row.id), name: row.name, definition: row.definition, proposer: row.proposer,
    year: row.year, evolution: Array.isArray(row.evolution) ? row.evolution : [],
    boundary: row.boundary, related: Array.isArray(row.related) ? row.related : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
  };
}

// ═══ 论证逻辑库 ═══
export interface CorpusLogic {
  id: number;
  name: string;
  patternType: string;
  structure: Array<{ step: number; desc: string }>;
  example?: string;
  usageHint?: string;
  tags: string[];
}

export async function addCorpusLogic(input: {
  name: string; patternType?: string; structure?: Array<{ step: number; desc: string }>;
  example?: string; usageHint?: string; tags?: string[];
}): Promise<CorpusLogic | null> {
  if (!input.name?.trim()) return null;
  const r = await pool.query(
    `insert into writing_corpus_logics (name, pattern_type, structure, example, usage_hint, tags)
     values ($1,$2,$3::jsonb,$4,$5,$6::text[]) returning *`,
    [input.name.trim(), input.patternType || "general", JSON.stringify(input.structure || []),
     input.example || null, input.usageHint || null, input.tags || []]
  );
  return mapLogic(r.rows[0]);
}

export async function listCorpusLogics(filter: { q?: string; limit?: number }): Promise<CorpusLogic[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.q) {
    params.push(`%${filter.q}%`);
    conds.push(`(name ilike $${params.length} or example ilike $${params.length} or usage_hint ilike $${params.length})`);
  }
  const where = conds.length > 0 ? "where " + conds.join(" and ") : "";
  const limit = Math.min(Math.max(filter.limit || 100, 1), 200);
  const r = await pool.query(`select * from writing_corpus_logics ${where} order by id limit ${limit}`, params);
  return r.rows.map(mapLogic);
}

function mapLogic(row: any): CorpusLogic {
  return {
    id: Number(row.id), name: row.name, patternType: row.pattern_type,
    structure: Array.isArray(row.structure) ? row.structure : [],
    example: row.example, usageHint: row.usage_hint, tags: Array.isArray(row.tags) ? row.tags : [],
  };
}

// ═══ 词汇句式库 ═══
export interface CorpusExpression {
  id: number;
  semanticGroup: string;
  expression: string;
  zhMeaning?: string;
  enExample?: string;
  replaceFor?: string;
  language: string;
}

export async function addCorpusExpression(input: {
  semanticGroup: string; expression: string; zhMeaning?: string; enExample?: string;
  replaceFor?: string; language?: string;
}): Promise<CorpusExpression | null> {
  if (!input.expression?.trim()) return null;
  const r = await pool.query(
    `insert into writing_corpus_expressions (semantic_group, expression, zh_meaning, en_example, replace_for, language)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [input.semanticGroup || "因果", input.expression.trim(), input.zhMeaning || null,
     input.enExample || null, input.replaceFor || null, input.language || "en"]
  );
  return mapExpression(r.rows[0]);
}

export async function listCorpusExpressions(filter: { group?: string; q?: string; limit?: number }): Promise<CorpusExpression[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.group) { params.push(filter.group); conds.push(`semantic_group = $${params.length}`); }
  if (filter.q) {
    params.push(`%${filter.q}%`);
    conds.push(`(expression ilike $${params.length} or replace_for ilike $${params.length})`);
  }
  const where = conds.length > 0 ? "where " + conds.join(" and ") : "";
  const limit = Math.min(Math.max(filter.limit || 100, 1), 200);
  const r = await pool.query(`select * from writing_corpus_expressions ${where} order by semantic_group, id limit ${limit}`, params);
  return r.rows.map(mapExpression);
}

function mapExpression(row: any): CorpusExpression {
  return {
    id: Number(row.id), semanticGroup: row.semantic_group, expression: row.expression,
    zhMeaning: row.zh_meaning, enExample: row.en_example, replaceFor: row.replace_for, language: row.language,
  };
}

// ═══ LLM 辅助提取（积累入口: 粘贴原文 → 自动识别定义/学者/年份/模块/语义组）═══
export async function extractCorpusWithLlm(input: {
  text: string; kind: "text" | "concept" | "logic" | "expression";
}): Promise<any> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const kindHint: Record<string, string> = {
    text: `提取为文本范例: {language:"zh|en", text:"段落原文(保留)", writingModule:"引言|综述|实证分析|结论|讨论|方法|摘要", tags:["标签"], note:"借鉴点(句式/结构亮点)"}`,
    concept: `提取为核心概念: {name:"概念名", definition:"精确定义", proposer:"提出学者", year:"年份", evolution:[{year,scholar,contribution}], boundary:"适用边界", related:["关联概念"]}`,
    logic: `提取为论证范式: {name:"范式名", patternType:"现象抽象|多案例对比|辩证结构|实证递进|归纳-演绎", structure:[{step,desc}], example:"简短示例", usageHint:"何时使用"}`,
    expression: `提取为词汇句式: {semanticGroup:"因果|对比|研究缺口|总结发现|让步|强调|示例|过渡", expression:"高级表达", zhMeaning:"中文释义", enExample:"英文例句", replaceFor:"替代的基础词"}`,
  };
  try {
    const r = await callLlm({
      model,
      agentContext: { action: "corpus_extract" },
      messages: [{
        role: "user",
        content: `你是学术写作语料库管理员。把以下内容转化为可复用的学术资产（借鉴逻辑与句式, 不照搬原文）。
${kindHint[input.kind]}
内容:
${String(input.text).slice(0, 2000)}

只返回 JSON, 不要其他文字:`,
      }],
      temperature: 0.1, maxTokens: 600,
    });
    const text = (r?.text || "").trim().replace(/```json|```/g, "");
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

// ═══ 检索: 按写作模块+语义组召回（Agent llm_write 注入用）═══
export async function recallCorpusForWriting(input: {
  writingModule?: string; semanticGroups?: string[]; q?: string; limit?: number;
}): Promise<{ texts: CorpusText[]; expressions: CorpusExpression[]; logics: CorpusLogic[]; concepts: CorpusConcept[] }> {
  const limit = Math.min(Math.max(input.limit || 3, 1), 5);
  const [texts, expressions, logics, concepts] = await Promise.all([
    listCorpusTexts({ module: input.writingModule, q: input.q, limit }),
    input.semanticGroups && input.semanticGroups.length > 0
      ? Promise.all(input.semanticGroups.slice(0, 3).map((g) => listCorpusExpressions({ group: g, limit }))).then((rs) => rs.flat().slice(0, limit * 2))
      : listCorpusExpressions({ q: input.q, limit: limit * 2 }),
    listCorpusLogics({ q: input.q, limit }),
    listCorpusConcepts({ q: input.q, limit }),
  ]);
  return { texts, expressions, logics, concepts };
}

export const writingCorpusService = {
  // 文本范例
  addCorpusText, listCorpusTexts,
  // 核心概念
  addCorpusConcept, listCorpusConcepts,
  // 论证逻辑
  addCorpusLogic, listCorpusLogics,
  // 词汇句式
  addCorpusExpression, listCorpusExpressions,
  // LLM 辅助提取
  extractCorpusWithLlm,
  // 检索召回（Agent 注入用）
  recallCorpusForWriting,
};
