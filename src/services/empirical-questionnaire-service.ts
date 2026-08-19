// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// empirical-questionnaire-service.ts — 问卷生成器 + 上传识别（V380+）
// 生成: 课题 → 研究问题 → 变量维度分解 → Question[] 结构化问卷
// 识别: 上传问卷文本 → 自动识别主体/指标/变量结构
// 反 hallucinate: 输出后校验(qid/varName/stem/type 非空 + varName 正则), 失败重试 1 次
import { randomUUID } from "node:crypto";
import { callLlm } from "../ai/llm-common.js";
import { getRoleModel } from "./llm-model-registry.js";
import { pool } from "../db/pool.js";
import { GuardError } from "./empirical-guards.js";

// ─── 统一问卷数据结构 Question（前端类型 + DB jsonb + LLM 输出契约共用）───
export interface QuestionOption { code: number; label: string }
export interface SkipLogic { ifQid: string; ifOption: number | null; goto: string }
export interface Question {
  qid: string;            // 题号, 如 2-15 / 3a-1
  varName: string;        // 变量名, 小写下划线
  stem: string;           // 题干
  type: "cat" | "ordinal" | "cont" | "text" | "multi";
  options?: QuestionOption[];
  skipLogic?: SkipLogic | null;
  derived?: string;       // 建议衍生变量
}

const QUESTION_CONTRACT = `
Question 结构(JSON):
{
  "qid": "题号(如 2-15, 3a-1)",
  "varName": "变量名(小写下划线, 如 adj_willing)",
  "stem": "题干",
  "type": "cat|ordinal|cont|text|multi",
  "options": [{"code": 1, "label": "选项文案"}, ...],
  "skipLogic": {"ifQid": "上一题号", "ifOption": 2, "goto": "目标题号"} 或 null,
  "derived": "建议衍生变量(如 流转率=转出面积/承包面积)"
}
约束:
- type 必填; cat/ordinal/multi 必须带 options(code 为整数); cont/text 不带 options
- 可多选 → type=multi; 1-5 程度 → ordinal; 数字类 → cont; 开放填写 → text
- 选项预留"其他"用 code 99(说明性开放文本)
- varName 必须小写下划线, 不重复
- 缺失编码约定: -99 未适用(跳转), -88 拒答
`;

async function callQuestionLlm(prompt: string): Promise<{ questions: Question[]; meta: Record<string, unknown> }> {
  const r = await callLlm({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    maxTokens: 30_000,
    timeoutMs: 120_000,
    jsonMode: true,
    model: getRoleModel("reason"),
  });
  const json = r?.json;
  if (!json || !Array.isArray(json.questions)) {
    throw new GuardError("LLM_OUTPUT_INVALID", "LLM 输出不是合法 JSON 结构: " + String(r?.text ?? "无输出").slice(0, 300));
  }
  return json;
}

/** 后校验: 结构 + varName 正则; 返回清洗后的题列表 */
export function validateQuestions(questions: Question[]): Question[] {
  const seen = new Set<string>();
  const out: Question[] = [];
  for (const q of questions) {
    if (!q || typeof q !== "object") continue;
    const qid = String(q.qid ?? "").trim();
    const varName = String(q.varName ?? "").trim();
    const stem = String(q.stem ?? "").trim();
    if (!qid || !varName || !stem) continue;
    if (!/^[a-z_][a-z0-9_]*$/.test(varName)) continue;
    let vn = varName;
    let n = 2;
    while (seen.has(vn)) vn = `${varName}_${n++}`;  // 重名去重
    seen.add(vn);
    const type = ["cat", "ordinal", "cont", "text", "multi"].includes(q.type) ? q.type : "cat";
    let options = Array.isArray(q.options) ? q.options.filter((o) => o && o.code !== undefined && o.label) : undefined;
    if (options && options.length > 0) {
      options = options.map((o, i) => ({ code: Number.isFinite(Number(o.code)) ? Number(o.code) : i + 1, label: String(o.label) }));
    }
    out.push({
      qid, varName: vn, stem, type,
      options: options?.length ? options : undefined,
      skipLogic: q.skipLogic ?? null,
      derived: q.derived ? String(q.derived) : undefined,
    });
  }
  return out;
}

// ─── 生成问卷 ───
export async function generateQuestionnaire(input: {
  title?: string; topic: string; extra?: string; nQuestions?: number;
}): Promise<{ questions: Question[]; meta: Record<string, unknown> }> {
  const n = Math.min(Math.max(input.nQuestions ?? 20, 5), 120);
  let prompt = `你是问卷设计专家。为以下课题设计一份适合农户/居民填写的实证调查问卷。
课题: ${input.topic}
${input.extra ? `补充要求: ${input.extra}\n` : ""}
要求:
1. 从课题分解出核心变量维度(身份特征/资源禀赋/行为决策/态度意愿/政策感知等)
2. 设计 ${n} 道题, 覆盖: 身份类(分类)、资源类(连续)、行为类、态度类(有序 1-5)、开放题(1-2 道)
3. 每道题给出变量名/题干/选项/类型/建议衍生变量, 并标注必要的跳转逻辑
4. 只输出 JSON: {"questions": [...], "meta": {"dimensions": ["..."], "nQuestions": 数字}}
${QUESTION_CONTRACT}`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await callQuestionLlm(prompt);
      const questions = validateQuestions(json.questions);
      if (questions.length < Math.max(3, Math.floor(n / 2))) throw new Error("题数不足");
      return { questions, meta: json.meta ?? { dimensions: [], nQuestions: questions.length } };
    } catch (e: any) {
      lastErr = String(e?.message ?? e);
    }
  }
  throw new GuardError("LLM_OUTPUT_INVALID", `问卷生成失败(重试后): ${lastErr.slice(0, 200)}`);
}

// ─── 上传识别 ───
export async function recognizeQuestionnaire(input: {
  title?: string; rawText: string;
}): Promise<{ questions: Question[]; meta: Record<string, unknown> }> {
  const text = (input.rawText ?? "").trim();
  if (!text) throw new GuardError("BAD_REQUEST", "问卷文本为空");

  // 分块识别: 长问卷按页标记/空行切块(每块 ≤8000 字符), 每块独立 LLM 调用后合并去重
  // 避免单次输出超过 maxTokens 截断导致 JSON 解析失败
  const blocks = splitBlocks(text, 8_000);
  const allQuestions: Question[] = [];
  let subject = "";
  let indicators: string[] = [];
  let lastErr = "";

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    let prompt = `你是问卷结构化专家。将以下问卷文本片段转换为结构化 Question 数组。
识别要求:
1. 逐题提取题号/题干/选项; 数字题→cont, 1-5 程度→ordinal, 单选→cat, 可多选→multi, 开放→text
2. 题干含"若选择某选项则跳至"→ 识别 skipLogic
3. 只输出 JSON: {"questions": [...]}${bi === 0 ? `, "meta": {"subject": "...", "indicators": ["..."]}` : ""}
问卷文本(第 ${bi + 1}/${blocks.length} 块, 约 ${block.length} 字符):
---开始---
${block}
---结束---
${QUESTION_CONTRACT}`;

    let blockDone = false;
    for (let attempt = 0; attempt < 2 && !blockDone; attempt++) {
      try {
        const json = await callQuestionLlm(prompt);
        const questions = validateQuestions(json.questions);
        if (questions.length === 0) throw new Error("未识别到有效题目");
        allQuestions.push(...questions);
        if (bi === 0) {
          subject = String(json.meta?.subject ?? "");
          indicators = Array.isArray(json.meta?.indicators) ? json.meta.indicators.map((i: unknown) => String(i)) : [];
        }
        blockDone = true;
      } catch (e: any) {
        lastErr = String(e?.message ?? e);
      }
    }
    if (!blockDone) {
      throw new GuardError("LLM_OUTPUT_INVALID", `问卷识别第 ${bi + 1}/${blocks.length} 块失败(重试后): ${lastErr.slice(0, 200)}`);
    }
  }

  if (allQuestions.length === 0) throw new GuardError("LLM_OUTPUT_INVALID", "未识别到任何有效题目");
  // 按 qid 顺序排序
  allQuestions.sort((a, b) => a.qid.localeCompare(b.qid, "zh", { numeric: true }));
  return { questions: allQuestions, meta: { subject, indicators, blocks: blocks.length } };
}

/** 按页标记/空行把长文本切成 ≤maxChars 的块（尽量在题号边界切开） */
function splitBlocks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  // 按页标记(===== 第N页 =====)优先切; 两侧各 5 个等号
  const pageParts = text.split(/(?===== 第\d+页 =====)/g).filter((p) => p.trim());
  const blocks: string[] = [];
  let cur = "";
  for (const part of pageParts.length > 1 ? pageParts : [text]) {
    if ((cur + part).length > maxChars && cur) {
      blocks.push(cur);
      cur = part;
    } else {
      cur += part;
    }
  }
  if (cur) blocks.push(cur);
  // 仍超长的块按题号切
  const out: string[] = [];
  for (const b of blocks) {
    if (b.length <= maxChars) { out.push(b); continue; }
    const lines = b.split("\n");
    let sub = "";
    for (const line of lines) {
      if ((sub + line).length > maxChars && sub) {
        out.push(sub);
        sub = line;
      } else {
        sub += line + "\n";
      }
    }
    if (sub) out.push(sub);
  }
  return out;
}

// ─── 落库 helpers ───
export async function createProject(input: { title: string; topic?: string }): Promise<Record<string, unknown>> {
  const r = await pool.query(
    `insert into empirical_projects (title, topic) values ($1, $2) returning id, title, topic, created_at`,
    [input.title, input.topic ?? ""]
  );
  const row = r.rows[0];
  return { id: String(row.id), title: row.title, topic: row.topic, created_at: new Date(row.created_at).toISOString() };
}

export async function listProjects(): Promise<Record<string, unknown>[]> {
  const r = await pool.query(`select id, title, topic, status, created_at from empirical_projects order by created_at desc limit 50`);
  return r.rows.map((row: any) => ({ id: String(row.id), title: row.title, topic: row.topic, status: row.status, created_at: new Date(row.created_at).toISOString() }));
}

export async function saveQuestionnaire(input: {
  projectId?: string | null; title: string; source: string; rawText?: string;
  questions: Question[]; meta?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const columns = input.questions.map((q) => q.varName);
  const r = await pool.query(
    `insert into empirical_questionnaires (project_id, title, source, raw_text, structure, columns, meta)
     values ($1, $2, $3, $4, $5, $6, $7) returning id, created_at`,
    [input.projectId ?? null, input.title, input.source, input.rawText ?? "", JSON.stringify(input.questions), JSON.stringify(columns), JSON.stringify(input.meta ?? {})]
  );
  return { id: String(r.rows[0].id), columns, created_at: new Date(r.rows[0].created_at).toISOString() };
}

export async function listQuestionnaires(projectId?: string): Promise<Record<string, unknown>[]> {
  const r = projectId
    ? await pool.query(`select id, project_id, title, source, columns, meta, created_at from empirical_questionnaires where project_id = $1 order by created_at desc limit 50`, [projectId])
    : await pool.query(`select id, project_id, title, source, columns, meta, created_at from empirical_questionnaires order by created_at desc limit 50`);
  return r.rows.map((row: any) => ({
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : null,
    title: row.title, source: row.source,
    columns: row.columns ?? [], meta: row.meta ?? {},
    created_at: new Date(row.created_at).toISOString(),
  }));
}

export async function getQuestionnaire(id: string): Promise<Record<string, unknown> | null> {
  const r = await pool.query(`select * from empirical_questionnaires where id = $1`, [id]);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: String(row.id), projectId: row.project_id ? String(row.project_id) : null,
    title: row.title, source: row.source, rawText: row.raw_text,
    structure: row.structure ?? [], columns: row.columns ?? [], meta: row.meta ?? {},
    created_at: new Date(row.created_at).toISOString(),
  };
}

export async function saveDataVersion(input: {
  projectId?: string | null; name: string; columns: string[]; nRows: number; meta?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const r = await pool.query(
    `insert into empirical_data_versions (project_id, name, columns, n_rows, meta)
     values ($1, $2, $3, $4, $5) returning id, created_at`,
    [input.projectId ?? null, input.name, JSON.stringify(input.columns), input.nRows, JSON.stringify(input.meta ?? {})]
  );
  return { id: String(r.rows[0].id), created_at: new Date(r.rows[0].created_at).toISOString() };
}

export async function listDataVersions(projectId?: string): Promise<Record<string, unknown>[]> {
  const r = projectId
    ? await pool.query(`select id, project_id, name, columns, n_rows, meta, created_at from empirical_data_versions where project_id = $1 order by created_at desc limit 50`, [projectId])
    : await pool.query(`select id, project_id, name, columns, n_rows, meta, created_at from empirical_data_versions order by created_at desc limit 50`);
  return r.rows.map((row: any) => ({
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : null,
    name: row.name, columns: row.columns ?? [], nRows: row.n_rows, meta: row.meta ?? {},
    created_at: new Date(row.created_at).toISOString(),
  }));
}

export const questionnaireService = {
  generateQuestionnaire, recognizeQuestionnaire, validateQuestions,
  createProject, listProjects, saveQuestionnaire, listQuestionnaires, getQuestionnaire,
  saveDataVersion, listDataVersions,
};
