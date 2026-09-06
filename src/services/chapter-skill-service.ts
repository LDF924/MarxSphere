// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// chapter-skill-service.ts — SocialSci 补漏R2: aiSkill 结构化写作卡 + 工作台整包快照
// HAR 二次审计(高频非噪音): 每章 aiSkill 9字段(type/wordCount/writingGoal/keyPoints/notes/connection/
//   sectionTitle/frameworkSource/chapterDraft/childSections); task.snapshot=23键整包工作台状态
// 迁移124 chapter_skill_cards + research_projects.workbench_snapshot
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";

// ═══ aiSkill 写作卡生成(按章节: 类型识别+写作目标+要点+衔接) ═══
export async function generateChapterSkillCard(input: {
  userId: string; projectId: string;
  sectionId: string; sectionTitle: string; level?: number;
  outlineTree?: string; parentTitle?: string; topic?: string; researchMethod?: string;
}): Promise<{ ok: boolean; card?: Record<string, unknown>; error?: string }> {
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: `你是论文章节规划专家。为本章生成结构化写作技能卡, 输出 JSON:
{"type":"intro|lit_review|theory|framework|analysis|data|results|discussion|conclusion|policy|other(选最贴切)",
 "wordCount":目标字数(整数),
 "writingGoal":"本章写作目标(150字内: 要完成什么论证任务)",
 "keyPoints":["要点1(80字内)"],
 "notes":"写作注意事项/易犯错误(可选)",
 "connection":"本章与上下文的衔接逻辑: 上章如何引出本节, 本节如何引出下章(120字内)",
 "frameworkSource":"(若有)本章依赖的理论/分析框架来源",
 "childSections":[{"title":"子节标题","aim":"该子节任务"}],
 "chapterDraft":""}

【章节】${input.sectionTitle} (层级 ${input.level ?? 1})
【父章节】${input.parentTitle ?? "-"}
【论文主题】${input.topic ?? "-"}
${input.researchMethod ? `【研究方法】${input.researchMethod}` : ""}
${input.outlineTree ? `【全文大纲】\n${input.outlineTree.slice(0, 2000)}` : ""}` }],
    temperature: 0.4, maxTokens: 4000, timeoutMs: 240_000,
  });
  const text = res?.text ?? "";
  let card: Record<string, unknown> | null = null;
  try { card = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch { /* 解析失败 */ }
  if (!card || !card.writingGoal) return { ok: false, error: "AI 未能生成写作卡, 请重试" };

  // 存库(迁移124 chapter_skill_cards)
  await pool.query(
    `insert into chapter_skill_cards
       (id, project_id, section_id, section_title, skill_type, word_count, writing_goal,
        key_points, notes, connection, framework_source, chapter_draft, child_sections)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (project_id, section_id)
     do update set skill_type=$5, word_count=$6, writing_goal=$7, key_points=$8, notes=$9,
                   connection=$10, framework_source=$11, chapter_draft=$12, child_sections=$13, updated_at=now()`,
    [randomUUID(), input.projectId, input.sectionId, input.sectionTitle,
     card.type ?? "", Number(card.wordCount) || 0, String(card.writingGoal),
     JSON.stringify(card.keyPoints ?? []), String(card.notes ?? ""),
     String(card.connection ?? ""), String(card.frameworkSource ?? ""),
     String(card.chapterDraft ?? ""), JSON.stringify(card.childSections ?? [])]);

  // 同时回写 sections 节点(aiSkill 挂章)
  const r = await pool.query(
    `select payload from research_nodes where project_id=$1 and node_key='sections'`, [input.projectId]);
  if (r.rows[0]) {
    const payload = r.rows[0].payload ?? { sections: [] };
    const list = Array.isArray(payload.sections) ? payload.sections : [];
    const idx = list.findIndex((s: { id?: string }) => s.id === input.sectionId);
    if (idx >= 0) {
      list[idx] = { ...list[idx], aiSkill: {
        type: card.type, wordCount: card.wordCount, writingGoal: card.writingGoal,
        keyPoints: card.keyPoints, notes: card.notes, connection: card.connection,
        sectionTitle: input.sectionTitle, frameworkSource: card.frameworkSource,
        chapterDraft: card.chapterDraft, childSections: card.childSections,
      } };
      await pool.query(
        `update research_nodes set payload=$2, version=version+1, updated_at=now()
          where project_id=$1 and node_key='sections'`,
        [input.projectId, JSON.stringify(payload)]);
    }
  }
  return { ok: true, card };
}

// ═══ 工作台整包快照(HAR: task.snapshot 23键) ═══
export async function saveWorkbenchSnapshot(userId: string, projectId: string, snapshot: Record<string, unknown>) {
  const owned = await pool.query(`select id from research_projects where id=$1 and user_id=$2`, [projectId, userId]);
  if (!owned.rows.length) return { ok: false, error: "项目不存在" };
  // englishAbstract 提取(若有)
  const en = snapshot._englishAbstract;
  await pool.query(
    `update research_projects set workbench_snapshot=$2,
            english_abstract=coalesce($3, english_abstract), updated_at=now()
      where id=$1`,
    [projectId, JSON.stringify(snapshot), typeof en === "string" ? en : null]);
  return { ok: true };
}

export async function getWorkbenchSnapshot(userId: string, projectId: string) {
  const r = await pool.query(
    `select workbench_snapshot, english_abstract, merged_title, merged_abstract, merged_keywords, merged_fulltext, merged_references, merge_generated from research_projects where id=$1 and user_id=$2`,
    [projectId, userId]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const stored = row.workbench_snapshot ?? {};
  // 与节点最新状态动态合并(节点是"最近真相", 快照是"缓存视图")
  const nodes = await pool.query(
    `select node_key, payload, updated_at from research_nodes where project_id=$1`, [projectId]);
  const merged = { ...stored };
  for (const n of nodes.rows) {
    const payload = n.payload ?? {};
    if (n.node_key === "input" && payload.input) merged.input = payload.input;
    else if (n.node_key === "sections" && Array.isArray(payload.sections)) merged.sections = payload.sections;
    else if (n.node_key === "analysis") {
      if (payload.variables) merged.variables = payload.variables;
      if (payload.stepAnalysisTexts) merged.stepAnalysisTexts = payload.stepAnalysisTexts;
      if (payload.logicFlow) merged.logicFlow = payload.logicFlow;
    } else if (n.node_key === "finalize" && payload) {
      if (payload.mergedTitle !== undefined) merged.mergedTitle = payload.mergedTitle;
      if (payload.mergedAbstract !== undefined) merged.mergedAbstract = payload.mergedAbstract;
      if (payload.mergedKeywords !== undefined) merged.mergedKeywords = payload.mergedKeywords;
      if (payload.mergedFullText !== undefined) merged.mergedFullText = payload.mergedFullText;
      if (payload.mergedReferences !== undefined) merged.mergedReferences = payload.mergedReferences;
      if (payload.isFinalized !== undefined) merged.isFinalized = payload.isFinalized;
    }
  }
  // merged_* 列并入(列是最终落库, 优先)
  if (row.merged_fulltext) merged.mergedFullText = row.merged_fulltext;
  if (row.merged_references) merged.mergedReferences = row.merged_references;
  if (row.merged_title) merged.mergedTitle = row.merged_title;
  if (row.merged_abstract) merged.mergedAbstract = row.merged_abstract;
  if (row.merged_keywords) merged.mergedKeywords = row.merged_keywords;
  merged.mergeGenerated = row.merge_generated ?? false;
  if (row.english_abstract) merged._englishAbstract = row.english_abstract;
  return { snapshot: merged, englishAbstract: row.english_abstract ?? "" };
}

export async function getChapterSkillCards(userId: string, projectId: string) {
  const r = await pool.query(
    `select c.* from chapter_skill_cards c
       join research_projects p on p.id=c.project_id and p.user_id=$2
      where c.project_id=$1 order by c.created_at`, [projectId, userId]);
  return r.rows;
}

// ═══ 章节批量技能卡(HAR: skillStepDone 1→2→3 逐步) ═══
export async function batchGenerateSkillCards(userId: string, projectId: string, sections: Array<{ id: string; title: string; level?: number }>) {
  const results: Array<{ sectionId: string; ok: boolean; error?: string }> = [];
  for (const sec of sections.slice(0, 20)) {
    try {
      const r = await generateChapterSkillCard({
        userId, projectId, sectionId: sec.id, sectionTitle: sec.title, level: sec.level,
      });
      results.push({ sectionId: sec.id, ...r });
    } catch (e) {
      results.push({ sectionId: sec.id, ok: false, error: String(e).slice(0, 100) });
    }
  }
  return { results, okCount: results.filter((r) => r.ok).length };
}
