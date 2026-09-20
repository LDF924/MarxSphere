// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// chapter-skill-service.ts — SocialSci 补漏R2: aiSkill 结构化写作卡 + 工作台整包快照
// HAR 二次审计(高频非噪音): 每章 aiSkill 9字段(type/wordCount/writingGoal/keyPoints/notes/connection/
//   sectionTitle/frameworkSource/chapterDraft/childSections); task.snapshot=23键整包工作台状态
// 迁移124 chapter_skill_cards + research_projects.workbench_snapshot
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { applyNodesToSnapshot } from "./workbench-sync.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";

// ═══ aiSkill 写作卡生成(按章节: 类型识别+写作目标+要点+衔接) ═══
export async function generateChapterSkillCard(input: {
  userId: string; projectId: string;
  sectionId: string; sectionTitle: string; level?: number;
  outlineTree?: string; parentTitle?: string; topic?: string; researchMethod?: string;
}): Promise<{ ok: boolean; card?: Record<string, unknown>; error?: string }> {
  // V417 安全修复: 这个 userId 以前声明了却**在函数体内零引用** —— projectId 由调用方直接传,
  //   等于任何登录用户只要拿到别人的 projectId, 就能往对方项目写写作卡并改它的 sections 节点。
  //   实测确认: 账号B 用自己 token 往 账号A 的项目写卡成功, A 的项目里真出现了 B 注入的章节。
  //   同文件的 saveWorkbenchSnapshot / getWorkbenchSnapshot / getChapterSkillCards 都做了
  //   `join research_projects ... user_id=`, 这里补上同样的所有权校验。
  const owned = await pool.query(
    `select 1 from research_projects where id=$1 and user_id=$2`, [input.projectId, input.userId]);
  if (!owned.rows.length) return { ok: false, error: "项目不存在" };
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

  /**
   * 同时回写 sections 节点(aiSkill 挂章)。
   *
   * ⚠ 2026-09-18 修: 这里原来是**无事务的读改写** —— "读 payload" 与 "写 payload"
   *   是两条独立语句, 而写的是**整块 payload**。与 `runChapterBatch`(整块回写正文)、
   *   或批量生成技能卡(循环调用本函数)并发时, 后写的一方会把对方刚写的整批内容顶掉:
   *   用户看到的是"生成了 20 章写作指导, 正文没了"。
   *   现在包进单事务 + `for update` 行锁, 读改写在同一把锁下完成。
   */
  const client = await pool.connect();
  try {
    await client.query("begin");
    const r = await client.query(
      `select id, payload from research_nodes
        where project_id=$1 and node_key='sections' for update`, [input.projectId]);
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
        await client.query(
          `insert into research_node_history (node_id, version, payload, parent_version, by_role, note)
           select id, version, payload, version, 'agent', '写作指导回写' from research_nodes
            where project_id=$1 and node_key='sections'`,
          [input.projectId]);
        await client.query(
          `update research_nodes set payload=$2, version=version+1, updated_at=now()
            where project_id=$1 and node_key='sections'`,
          [input.projectId, JSON.stringify(payload)]);
      }
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => null);
    throw e;
  } finally {
    client.release();
  }
  return { ok: true, card };
}

// ═══ 工作台整包快照(HAR: task.snapshot 23键) ═══
/**
 * 保存工作台快照。
 *
 * 2026-09-18: 由**整块覆盖**改成 **jsonb `||` 合并**。
 *   坑: 只要有一次**部分提交**(比如只带 `{phase, phaseLabel}` 的阶段推进, 或
 *   `/materials/review` 那条读改写路径…),
 *   之前存的键就被整块抹掉 —— 实测: 只提交 3 个键后, 快照里原有的 `sections` 与
 *   `statisticsFileId` 全没了。
 *   而本地图里没有任何"删除快照键"的语义(`resetLocal` 只清内存态并换 taskId),
 *   所以合并写严格优于覆盖写。
 *
 * ⚠ 同步改动: 主写入路径现在是 `PUT /workbench`(server.ts), 它会**连节点一起同步**。
 *   本函数保留给"只改快照不动节点"的调用方(如 `/materials/review` 只并一个报告键),
 *   语义与那条路径保持一致(合并写)。
 */
export async function saveWorkbenchSnapshot(userId: string, projectId: string, snapshot: Record<string, unknown>) {
  const owned = await pool.query(`select id from research_projects where id=$1 and user_id=$2`, [projectId, userId]);
  if (!owned.rows.length) return { ok: false, error: "项目不存在" };
  // englishAbstract 提取(若有)
  const en = snapshot._englishAbstract;
  await pool.query(
    `update research_projects
        set workbench_snapshot = coalesce(workbench_snapshot,'{}'::jsonb) || $2::jsonb,
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
  // 与节点最新状态动态合并(节点是"最近真相", 快照是"缓存视图")。
  // 2026-09-18: if-else 链改成**遍历 SNAPSHOT_NODE_MAP**(workbench-sync.ts) ——
  //   同一张表也驱动写入侧的同步, 于是"读什么"与"写什么"不会再各说各话。
  //   各条的合并判据(readGate)是从原 if-else 逐条抄的, 行为不变。
  const nodes = await pool.query(
    `select node_key, payload, updated_at from research_nodes where project_id=$1`, [projectId]);
  const merged = applyNodesToSnapshot(stored, nodes.rows as Array<{ node_key: string; payload: unknown }>);
  // merged_* 列并入(引擎 merge 分支写这里)。
  //
  // ⚠ 2026-09-16 口径修正: 这里原来是**列优先**(`if (row.merged_fulltext) merged.mergedFullText = row.merged_fulltext`),
  //   与 research-exec-engine 的读取口径**相反** —— 那边是 `fz.mergedTitle ?? p.merged_title`
  //   (节点优先, 注释写明"前端所见即所得")。
  //   两边不一致的后果是实打实的数据丢失: 用户在手改合稿页的标题/摘要/正文后,
  //   前端写节点、引擎写列, 回读时列赢 → **刷新即回退到引擎旧值**。
  //   现在统一成"节点优先, 列只在节点没给该字段时兜底", 且逐字段判断
  //   (原来只要列有值就整体覆盖, 连节点里更新过的 title 也会被列里的旧 title 盖掉)。
  if (!merged.mergedFullText && row.merged_fulltext) merged.mergedFullText = row.merged_fulltext;
  if (!merged.mergedReferences && row.merged_references) merged.mergedReferences = row.merged_references;
  if (!merged.mergedTitle && row.merged_title) merged.mergedTitle = row.merged_title;
  if (!merged.mergedAbstract && row.merged_abstract) merged.mergedAbstract = row.merged_abstract;
  if (!merged.mergedKeywords && row.merged_keywords) merged.mergedKeywords = row.merged_keywords;
  // mergeGenerated 此前是无条件 `= row.merge_generated ?? false` —— 而这一列**只有引擎写**
  //   (真跑 phase5 合稿时), 前端置位后没有任何地方落库 → 刷新就回 false, 而合稿页的渲染
  //   以它为门(`v-if="!mergeGenerated && !mergeRunning"` 决定空态还是三轮卡)
  //   → **刷新一次"已完成合稿"的现场就整个没了**。2026-09-20 实测复现。
  //   修法与上面几个 merged_* 同口径(节点优先, 列只在节点没给该键时兜底), 不自造特例:
  //   写成"两边任一为真"会破坏重置 —— 引擎写过列之后即使用户重置回 false 也读成 true。
  if (merged.mergeGenerated === undefined) merged.mergeGenerated = row.merge_generated ?? false;
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
