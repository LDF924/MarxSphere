// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// research-exec-engine.ts — SocialSci P0-2: DAG 节点执行引擎(依赖就绪 → 排队 → 执行 → 产物落节点)
// 语义(对齐画布"上一节点输出=下一节点输入"): research_tasks.depends_on 前置全部 done →
//   任务 queued→running; 执行完成 → 写对应节点快照 + 下游任务重新就绪评估
// 说明: 本引擎为"科研项目级执行"调度, 与 agent-orchestrator(52步推理) 并列不冲突
// 执行器按 job_kind 分派:
//   - analyze/chapter_gen/finalize → research-pipeline 主控 Agent / paper-outline generateChapter
//   - review / viz / statistics   → 对应模块服务(P0-3/P0-4/empirical 就绪后接入)
// 当前实现: 引擎提供调度内核 + 通用 LLM 任务执行; 具体模块执行器逐批注册
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";
import * as materials from "./research-materials-service.js";
import { generateChapter, generateComponent } from "./paper-outline-service.js";

export interface ExecCtx {
  taskId: string;
  projectId: string;
  userId: string;
  dagNodeId: string;
  module: string;
  jobKind: string;
  goal: string;
  dependsOn: string[];
  inputSnapshot: Record<string, unknown>;
}

/** 找出所有依赖已就绪(前置全 done)的 queued 任务 */
export async function findReadyTasks(projectId?: string): Promise<any[]> {
  const clauses = ["t.status='queued'"];
  const vals: unknown[] = [];
  if (projectId) { vals.push(projectId); clauses.push(`t.project_id=$${vals.length}`); }
  const r = await pool.query(
    `select t.* from research_tasks t
      where ${clauses.join(" and ")} and (
        t.depends_on = '[]'::jsonb or not exists (
          select 1 from jsonb_array_elements_text(t.depends_on) dep
          left join research_tasks d on d.id = dep::uuid
          where d.id is null or d.status <> 'done'
        )
      )
      order by t.created_at asc limit 10`,
    vals
  );
  return r.rows;
}

/** 将任务标记 running(带 8MiB 线程语义无关; 乐观执行) */
export async function markRunning(taskId: string) {
  await pool.query(
    `update research_tasks set status='running', updated_at=now() where id=$1`,
    [taskId]
  );
}

export async function markDone(taskId: string, result: unknown) {
  await pool.query(
    `update research_tasks set status='done', result=$2::jsonb, progress=jsonb_set(coalesce(progress,'{}'::jsonb),'{doneAt}',to_jsonb(now()::text)), updated_at=now() where id=$1`,
    [taskId, JSON.stringify(result ?? {})]
  );
}

export async function markFailed(taskId: string, error: { code: string; userMessage: string; canRetry: boolean }) {
  await pool.query(
    `update research_tasks set status='failed', error=$2, updated_at=now() where id=$1`,
    [taskId, JSON.stringify(error)]
  );
}

export async function getTaskById(taskId: string) {
  const r = await pool.query(`select * from research_tasks where id=$1`, [taskId]);
  return r.rows[0] ?? null;
}

/** 通用 LLM JSON 执行器(章节/分析等 job_kind 走此) */
async function runLlmJob(task: any, ctx: ExecCtx) {
  // 注入素材上下文(写作类任务): 从项目素材库构建上下文
  let materialsCtx = "";
  if (["chapter_gen", "finalize", "writing"].includes(task.job_kind)) {
    materialsCtx = await materials.buildMaterialsContext(ctx.userId, ctx.projectId);
  }
  const ans = await (async () => {
    const ep = getLlmEndpoint({ model: getRoleModel("reason") });
    const res = await fetchLlm({
      url: ep.url,
      key: ep.key,
      model: ep.model,
      messages: [{
        role: "user",
        content: `你是科研任务执行智能体。执行研究项目中的一个节点任务, 输出 JSON 结果。

【任务目标】${ctx.goal}
【任务类型】${task.job_kind}
【节点类型】${task.dag_node_id ? `画布节点 ${task.dag_node_id}` : "线性任务"}
${materialsCtx ? `【可用素材】\n${materialsCtx.slice(0, 3000)}` : ""}

输出 JSON: {"result":"任务执行结论(中文, 简洁)", "structured":{}}`,
      }],
      temperature: 0.4,
      maxTokens: 4000,
      timeoutMs: 240_000,
    });
    if (!res?.text) throw new Error("LLM 无响应");
    return parseLlmJson(res.text);
  })();
  return { text: ans?.result ?? "", structured: ans?.structured ?? {}, materialsUsed: materialsCtx ? true : false };
}

/** 执行单个就绪任务(通用执行器分派) */
export async function executeReadyTask(taskId: string): Promise<{ ok: boolean; error?: string }> {
  const task = await getTaskById(taskId);
  if (!task || task.status !== "queued") return { ok: false, error: "任务不存在或非就绪" };
  // 二次就绪校验(依赖)
  if (task.depends_on?.length) {
    const deps = task.depends_on as string[];
    const r = await pool.query(
      `select status from research_tasks where id = any($1::uuid[])`,
      [deps]
    );
    const allDone = r.rows.length === deps.length && r.rows.every((d) => d.status === "done");
    if (!allDone) return { ok: false, error: "前置任务未完成" };
  }
  await markRunning(taskId);
  const ctx: ExecCtx = {
    taskId, projectId: task.project_id, userId: task.user_id,
    dagNodeId: task.dag_node_id ?? "", module: task.module ?? "workflow",
    jobKind: task.job_kind ?? "analyze", goal: task.goal ?? "",
    dependsOn: task.depends_on ?? [], inputSnapshot: task.input_snapshot ?? {},
  };
  try {
    // SocialSci 补漏组4: 专用执行器分派(P3 子任务/P4 批量/P5 合稿; review/viz/statistics 由对应面板直连)
    const executorMap: Record<string, (task: any, ctx: ExecCtx) => Promise<{ text: string; structured?: unknown }>> = {
      "literature-search": runLiteratureSearch,
      "theory-generate": runTheoryGenerate,
      "table-generate": runTableGenerate,
      chapter_batch: runChapterBatch,
      phase4_batch: runChapterBatch,
      review: runPhase5,
      phase5_review: runPhase5,
      merge: runPhase5,
      phase5_merge: runPhase5,
      revise: runPhase5,
      phase5_revise: runPhase5,
    };
    const executor = executorMap[ctx.jobKind];
    const result = executor ? await executor(task, ctx) : await runLlmJob(task, ctx);
    await markDone(taskId, result);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markFailed(taskId, { code: "EXEC_FAILED", userMessage: msg, canRetry: true });
    return { ok: false, error: msg };
  }
}

/** 一轮调度: 找出全部就绪任务并逐个执行(供手动触发或定时巡检) */
export async function runSchedulingRound(projectId?: string): Promise<{ executed: number; results: Array<{ taskId: string; ok: boolean; error?: string }> }> {
  const ready = await findReadyTasks(projectId);
  const results: Array<{ taskId: string; ok: boolean; error?: string }> = [];
  for (const t of ready) {
    const r = await executeReadyTask(t.id);
    results.push({ taskId: t.id, ...r });
  }
  return { executed: ready.length, results };
}

/** 从画布同步任务依赖(建任务时自动调用, 或画布变更后手动同步) */
export async function syncTaskDependenciesFromCanvas(projectId: string) {
  // 画布 edges 的 target → task 的 depends_on(前驱节点的任务)
  const p = await pool.query(
    `select canvas from research_projects where id=$1`,
    [projectId]
  );
  if (!p.rows.length) return { ok: false };
  const canvas = p.rows[0].canvas ?? { edges: [] };
  const incoming = new Map<string, string[]>(); // dagNodeId -> 前置 dagNodeId[]
  for (const e of canvas.edges ?? []) {
    const arr = incoming.get(e.target) ?? [];
    arr.push(e.source);
    incoming.set(e.target, arr);
  }
  // 每画布节点对应任务, 取其前驱节点的任务 id
  for (const [targetNode, sourceNodes] of incoming) {
    const tasks = await pool.query(
      `select id, dag_node_id from research_tasks where project_id=$1 and dag_node_id=any($2::text[])`,
      [projectId, sourceNodes]
    );
    const taskFor = await pool.query(
      `select id from research_tasks where project_id=$1 and dag_node_id=$2 limit 1`,
      [projectId, targetNode]
    );
    if (!taskFor.rows.length) continue;
    const depIds = tasks.rows.filter((t) => t.dag_node_id !== targetNode).map((t) => t.id);
    if (depIds.length) {
      await pool.query(
        `update research_tasks set depends_on=$3, updated_at=now() where id=$1 and project_id=$2`,
        [taskFor.rows[0].id, projectId, JSON.stringify(depIds)]
      );
    }
  }
  return { ok: true };
}

// ═══ SocialSci 补漏组4: P3/P4/P5 专用执行器(HAR 实测语义: phase3 literature-search/theory-generate/table-generate; phase4 batch; phase5 merge/revise) ═══

/** P3 文献检索子任务(per section): sectionTitle+keywords → citation 素材 */
async function runLiteratureSearch(task: any, ctx: ExecCtx) {
  const snapshot = task.input_snapshot ?? {};
  const sectionTitle = snapshot.sectionTitle ?? ctx.goal;
  const keywords = Array.isArray(snapshot.keywords) ? snapshot.keywords : [];
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: `你是社科文献检索规划助手。为章节规划检索, 输出 JSON:
{"queries":["检索词1","检索词2"],"expected":["文献主题(勿编造, 标注[待检索])"]}

【目标章节】${sectionTitle}
【关键词】${keywords.join("、") || "未提供"}
【研究主题】${ctx.goal}` }],
    temperature: 0.3, maxTokens: 2000, timeoutMs: 180_000,
  });
  let queries: string[] = [];
  try { queries = JSON.parse(String(res?.text ?? "{}").replace(/```json|```/g, "").trim())?.queries ?? []; } catch { /* 忽略 */ }
  await materials.createMaterial({
    projectId: ctx.projectId, userId: ctx.userId, kind: "citation",
    title: `检索方案 · ${String(sectionTitle).slice(0, 30)}`,
    contentMd: `检索词:\n${queries.join("\n")}\n\n(实际检索需接知识库/CNKI, 命中后追加来源)`,
    sourceRef: task.id, producedByDagNode: ctx.dagNodeId,
  });
  return { text: `已生成 ${queries.length} 组检索词`, structured: { queries } };
}

/** P3 理论框架生成(per section): 理论梳理 → theory 素材 */
async function runTheoryGenerate(task: any, ctx: ExecCtx) {
  const snapshot = task.input_snapshot ?? {};
  const sectionTitle = snapshot.sectionTitle ?? "本节";
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: `你是社科理论专家。为论文章节梳理理论框架, 输出 JSON:
{"theory":{"name":"核心理论","source":"出处(勿编造, 标注[待核实])","core":"核心主张150字内","apply":"本文应用100字内","caveats":"适用边界"}}

【目标章节】${sectionTitle}
【研究主题】${ctx.goal}` }],
    temperature: 0.4, maxTokens: 3000, timeoutMs: 240_000,
  });
  let theory: { name?: string; core?: string; apply?: string } | null = null;
  try { theory = JSON.parse(String(res?.text ?? "{}").replace(/```json|```/g, "").trim())?.theory ?? null; } catch { /* 忽略 */ }
  await materials.createMaterial({
    projectId: ctx.projectId, userId: ctx.userId, kind: "theory",
    title: `理论框架 · ${(theory?.name || sectionTitle).toString().slice(0, 30)}`,
    contentMd: `${theory?.core ?? ""}\n\n本文应用: ${theory?.apply ?? ""}`,
    sourceRef: task.id, producedByDagNode: ctx.dagNodeId,
  });
  return { text: `理论框架: ${theory?.name ?? "未生成"}`, structured: { theory } };
}

/** P3 表格设计(per section): 设计论文所需表格规范 → data_result 素材 */
async function runTableGenerate(task: any, ctx: ExecCtx) {
  const snapshot = task.input_snapshot ?? {};
  const sectionTitle = snapshot.sectionTitle ?? "本节";
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: `你是社科论文表格设计专家。为章节设计表格, 输出 JSON:
{"tables":[{"no":1,"title":"表题","columns":["列名"],"purpose":"论证目的50字内","dataSource":"数据来源(勿编造, [待数据])"}]}

【目标章节】${sectionTitle}
【研究主题】${ctx.goal}` }],
    temperature: 0.4, maxTokens: 3000, timeoutMs: 240_000,
  });
  let tables: Array<{ title?: string; columns?: string[]; purpose?: string }> = [];
  try { tables = JSON.parse(String(res?.text ?? "{}").replace(/```json|```/g, "").trim())?.tables ?? []; } catch { /* 忽略 */ }
  await materials.createMaterial({
    projectId: ctx.projectId, userId: ctx.userId, kind: "data_result",
    title: `表格设计 · ${String(sectionTitle).slice(0, 30)}`,
    contentMd: tables.map((t) => `- ${t.title}: [${(t.columns ?? []).join("|")}] ${t.purpose ?? ""}`).join("\n"),
    sourceRef: task.id, producedByDagNode: ctx.dagNodeId,
  });
  return { text: `已设计 ${tables.length} 张表`, structured: { tables } };
}

/** P4 章节批量生成(HAR: phase4/batch sectionSnapshots 含 skill_prompt; 复用 generateChapter) */
async function runChapterBatch(task: any, ctx: ExecCtx) {
  const snapshot = task.input_snapshot ?? {};
  const sections = Array.isArray(snapshot.sections) ? snapshot.sections as Array<{
    id?: string; title?: string; level?: number; skill_prompt?: string; requirements?: string;
  }> : [];
  if (!sections.length) throw new Error("批量生成缺少章节清单(snapshot.sections)");
  // SocialSci R3: 从素材库收集引用池(citation 素材的 content 是 [N] 条目清单 → 编号引用)
  const citationPool = await buildCitationPool(ctx.userId, ctx.projectId);
  const results: Array<{ id?: string; title?: string; ok: boolean; wordCount?: number; content?: string; error?: string }> = [];
  for (const sec of sections) {
    try {
      // UI审计T4: 每章进度写回 progress(前端步骤卡消费)
      await pool.query(
        `update research_tasks set progress=jsonb_set(jsonb_set(jsonb_set(coalesce(progress,'{}'::jsonb),'{stage}',to_jsonb('章节生成'::text)),'{current}',to_jsonb($2::int)),'{total}',to_jsonb($3::int)) where id=$1`,
        [ctx.taskId, results.length + 1, sections.length]);
      const ch = await generateChapter({
        nodeId: sec.id ?? "unknown",
        title: sec.title ?? "未命名章节",
        level: sec.level ?? 1,
        topic: ctx.goal,
        ...(sec.skill_prompt ? { prevContext: `【本章写作指令】${sec.skill_prompt.slice(0, 2000)}` } : {}),
        ...(sec.requirements ? { outlineTree: sec.requirements.slice(0, 1000) } : {}),
        ...(citationPool ? { citationPool } : {}),
      });
      results.push({ id: sec.id, title: sec.title, ok: !!ch.content, wordCount: ch.wordCount, content: ch.content });
    } catch (e) {
      results.push({ id: sec.id, title: sec.title, ok: false, error: String(e).slice(0, 100) });
    }
  }
  // UI审计T4: 完成进度标记
  await pool.query(
    `update research_tasks set progress=jsonb_set(jsonb_set(coalesce(progress,'{}'::jsonb),'{stage}',to_jsonb('批量完成'::text)),'{current}',to_jsonb($2::int)) where id=$1`,
    [ctx.taskId, sections.length]);
  // 修正: 把生成的正文回写 sections 节点(否则结果丢失, 只在 progress.doneAt)
  const node = await pool.query(
    `select payload from research_nodes where project_id=$1 and node_key='sections'`, [ctx.projectId]);
  let list: Array<Record<string, unknown>> = [];
  if (node.rows[0]?.payload?.sections) list = [...node.rows[0].payload.sections];
  else {
    // 无节点则用任务快照章节建
    list = sections.map((s) => ({ id: s.id ?? s.title, title: s.title, level: s.level ?? 1 }) as Record<string, unknown>);
  }
  let changed = false;
  for (const res of results) {
    if (!res.ok || !res.content) continue;
    const idx = list.findIndex((s) => s.id === res.id || s.title === res.title);
    if (idx >= 0) {
      // UI审计: 正文回写时自动生成 structuredSummary(结论/数据/论点/遗留 正则抽取)
      list[idx] = { ...list[idx], content: res.content, status: "done", structuredSummary: buildStructuredSummary(res.content) };
      changed = true;
    }
  }
  if (changed) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      // UI审计T8: 回写前记录 batch:pre 锚点(批量前状态 → 可回滚)
      const cur = await client.query(
        `select id, version, payload from research_nodes where project_id=$1 and node_key='sections' for update`,
        [ctx.projectId]);
      if (cur.rows.length) {
        const node = cur.rows[0];
        await client.query(
          `insert into research_node_history (node_id, version, payload, parent_version, by_role, note)
           values ($1,$2,$3,$2,'agent','batch:pre')`,
          [node.id, node.version, node.payload]);
        await client.query(
          `update research_nodes set payload=$1, version=version+1, updated_at=now() where id=$2`,
          [JSON.stringify({ sections: list }), node.id]);
      } else {
        await client.query(
          `insert into research_nodes (project_id, task_id, node_key, payload, version, source_role)
           values ($1,$2,'sections',$3,1,'agent')`,
          [ctx.projectId, ctx.taskId, JSON.stringify({ sections: list })]);
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
  return { text: `批量完成 ${results.filter((r) => r.ok).length}/${sections.length} 章`, structured: { results } };
}

/** 引用池构建: 项目 citation 素材的 [N] 条目 → 编号清单(供正文引用, 格式对齐 GB/T7714 实体) */
async function buildCitationPool(userId: string, projectId: string): Promise<string> {
  try {
    const r = await pool.query(
      `select content_md from research_materials
        where project_id=$1 and user_id=$2 and kind='citation'
        order by created_at limit 5`, [projectId, userId]);
    const lines: string[] = [];
    for (const row of r.rows) {
      const text = String(row.content_md ?? "");
      for (const line of text.split("\n")) {
        const m = /^\s*\[(\d+)\]\s*(.+)$/.exec(line.trim());
        if (m) lines.push(`[${m[1]}] ${m[2].trim()}`);
      }
    }
    // 去重保序, 最多 20 条
    const seen = new Set<string>();
    const out: string[] = [];
    for (const l of lines) {
      const key = l.replace(/^\[\d+\]\s*/, "");
      if (!seen.has(key)) { seen.add(key); out.push(l); }
      if (out.length >= 20) break;
    }
    return out.join("\n");
  } catch { return ""; }
}

/** P5 合并/审查/修订(job_kind: merge|review|revise; 合并走 generateComponent 要件)
 *  P-A 对齐闭源 #589/#601/#612/#651: review 产六维报告存 task.result+project.review_result;
 *  revise 读报告对 merge 产物做有向修订(输出去AI痕迹+按 checks 改), 产出修订稿覆盖 merged_*,
 *  产物链 revisionOf 指向被修订版本(发布版本号), activate 端点把版本置终稿。 */
async function runPhase5(task: any, ctx: ExecCtx) {
  const snapshot = task.input_snapshot ?? {};
  const kind = task.job_kind; // merge | review | revise
  const sections = Array.isArray(snapshot.sections) ? snapshot.sections as Array<{ title?: string }> : [];
  const bodies = Array.isArray(snapshot.chapterContents) ? snapshot.chapterContents as string[] : [];
  if (kind === "merge") {
    const abstract = await generateComponent({
      kind: "abstract", topic: ctx.goal,
      sections: sections.map((s) => s.title ?? ""),
      chapterContents: bodies,
    }).catch(() => ({ content: "" }));
    const keywords = await generateComponent({ kind: "keywords", topic: ctx.goal, sections: [] }).catch(() => ({ content: "" }));
    // SocialSci R3: 合并结果落 finalize 字段(mergedTitle/Abstract/Keywords/FullText/References + merge_generated)
    const fulltext = (bodies ?? []).join("\n\n");
    const references = await buildMergedReferences(ctx.userId, ctx.projectId);
    await pool.query(
      `update research_projects set
         merged_title=coalesce(nullif(merged_title,''), $2),
         merged_abstract=$3, merged_keywords=$4, merged_fulltext=$5,
         merged_references=$6, merge_generated=true,
         updated_at=now()
       where id=$1`,
      [ctx.projectId, ctx.goal, abstract.content, keywords.content, fulltext, references]);
    return { text: "合并完成: 摘要+关键词已生成", structured: { abstract: abstract.content, keywords: keywords.content, references } };
  }

  // ═══ P-A: review/revise 以 finalize 节点为真源(前端 PUT nodes/finalize 写入 merged_* + reviewReport) ═══
  const nodeRow = await pool.query(
    `select payload from research_nodes
       join research_projects p on p.id=research_nodes.project_id
      where research_nodes.project_id=$1 and research_nodes.node_key='finalize' and p.user_id=$2
      limit 1`,
    [ctx.projectId, ctx.userId]
  ).catch(() => ({ rows: [] as unknown[] }));
  const fz = (nodeRow?.rows?.[0]?.payload ?? {}) as {
    mergedTitle?: string; mergedAbstract?: string; mergedFullText?: string;
    mergedKeywords?: string; mergedReferences?: string; reviewReport?: unknown;
  };
  const proj = await pool.query(
    `select merged_title, merged_abstract, merged_keywords, merged_fulltext, merged_references,
            review_result, published_version, phase_label
       from research_projects where id=$1 and user_id=$2`,
    [ctx.projectId, ctx.userId]
  ).catch(() => ({ rows: [] as unknown[] }));
  const p = (proj?.rows?.[0] ?? {}) as {
    merged_title?: string; merged_abstract?: string; merged_keywords?: string;
    merged_fulltext?: string; merged_references?: string; review_result?: unknown;
    published_version?: number; phase_label?: string;
  };
  const nodeReview = (typeof fz.reviewReport === "string" ? JSON.parse(fz.reviewReport) : fz.reviewReport) as Record<string, unknown> | null;
  // 真源优先节点 payload(前端所见即所得), 缺时回落 project 列(引擎 merge 分支写)
  const title = fz.mergedTitle ?? p.merged_title ?? "";
  const fulltext = (fz.mergedFullText ?? p.merged_fulltext ?? "") as string;
  const abstract = fz.mergedAbstract ?? p.merged_abstract ?? "";
  const keywords = fz.mergedKeywords ?? p.merged_keywords ?? "";
  const refs = fz.mergedReferences ?? p.merged_references ?? "";
  const reportSrc = (nodeReview ?? p.review_result ?? null) as Record<string, unknown> | null;
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });

  if (kind === "review") {
    if (!fulltext.trim()) throw new Error("尚无合并正文, 请先运行合稿");
    // 闭源六维审查: score/overall/highlights/checks{requirements,references,aiTone,logic,dataAccuracy}/topSuggestions
    const res = await fetchLlm({
      url: ep.url, key: ep.key, model: ep.model,
      messages: [{ role: "user", content: `你是期刊主编, 对一篇社科论文做多维质量审查。只依据提供的全文, 不验证文献真实存在与否, 只评价文本呈现。

【论文全文】
${fulltext.slice(0, 16000)}

输出 JSON(不要代码块):
{"score":0-100总分整数,"grade":"A|B|C|D","overall":"总体评语(150字内,亮点+主要问题+修订方向)","highlights":["亮点1","亮点2"],"checks":{"requirements":{"pass":true/false,"detail":"结构与体例完整性检查意见(≤120字)"},"references":{"pass":true/false,"detail":"引文数量/格式/位置规范检查意见(≤120字)"},"aiTone":{"pass":true/false,"detail":"AI生成痕迹检查意见(模板化表达/机械列举/套话, ≤150字)"},"logic":{"pass":true/false,"detail":"论证逻辑一致性检查意见(≤120字)"},"dataAccuracy":{"pass":true/false,"detail":"数据/实证表述可信度检查意见(≤120字)"}},"topSuggestions":["首要修改建议1(具体可执行)","建议2","建议3"]}` }],
      temperature: 0.3, maxTokens: 4000, timeoutMs: 240_000,
    });
    if (!res?.text) throw new Error("LLM 无响应");
    let report: Record<string, unknown> = {};
    try { report = parseLlmJson(res.text) ?? {}; } catch { report = { raw: String(res.text ?? "").slice(0, 3000) }; }
    const grade = String(report.grade ?? (Number(report.score ?? 0) >= 85 ? "A" : Number(report.score ?? 0) >= 70 ? "B" : Number(report.score ?? 0) >= 60 ? "C" : "D"));
    const result = {
      paperTitle: title || ctx.goal, wordCount: fulltext.replace(/\s/g, "").length,
      overallScore: Number(report.score ?? 0), grade,
      overallComment: report.overall ?? "", overall: report.overall ?? "",
      highlights: Array.isArray(report.highlights) ? report.highlights : [],
      checks: report.checks ?? {}, topSuggestions: Array.isArray(report.topSuggestions) ? report.topSuggestions : [],
      reviewedAt: new Date().toISOString(),
    };
    // 报告双写: project.review_result(引擎链) + finalize 节点 payload.reviewReport(前端渲染源)
    await pool.query(
      `update research_projects set review_result=$2::jsonb, updated_at=now() where id=$1`,
      [ctx.projectId, JSON.stringify(result)]);
    const nUpd = await pool.query(
      `update research_nodes set payload=jsonb_set(coalesce(payload,'{}'::jsonb),'{reviewReport}', $2::jsonb), updated_at=now()
        where project_id=$1 and node_key='finalize'`, [ctx.projectId, JSON.stringify(result)]).catch(() => ({ rowCount: 0 }));
    void nUpd;
    return { text: `审查完成: ${result.overallScore} 分 ${result.grade} 级`, structured: result };
  }

  // revise: 读 review_result(节点 reviewReport 优先, 无则 project) → 有向修订全文
  if (!reportSrc || !fulltext.trim()) throw new Error("缺少审查报告或合并正文, 请先运行 合稿→审查");
  const reviewReport = reportSrc;
  const checksBrief = ((): string => {
    try {
      const c = (reviewReport.checks ?? {}) as Record<string, { pass?: boolean; detail?: string }>;
      return Object.entries(c).map(([k, v]) => `- ${k}: ${v.pass ? "通过" : "不通过"} ${v.detail ?? ""}`).join("\n");
    } catch { return JSON.stringify(reviewReport).slice(0, 1000); }
  })();
  const scoreLine = reviewReport.overallScore !== undefined ? `${reviewReport.overallScore} 分 ${reviewReport.grade ?? ""}` : "";
  // step1: 修订正文 — 直出修订后 markdown 全文(不进 JSON, 防超长转义)
  const r1 = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: `你是学术论文修订专家。根据审稿意见对全文做有向修订: 消除 AI 痕迹(模板化开头/机械列举/套话/箭头链式), 修复报告指出的结构与一致性问题, 保持全部章节与实质观点不变, 不要新增实证数据, 保留 markdown 标题结构与 [n] 引文标记。

【审稿报告】${scoreLine}
${checksBrief}
【优先建议】${Array.isArray(reviewReport.topSuggestions) ? (reviewReport.topSuggestions as string[]).join("; ") : ""}

【待修订全文】
${fulltext}

直接输出修订后的完整全文 markdown(不要任何解释、不要代码块围栏)。` }],
    temperature: 0.4, maxTokens: 16000, timeoutMs: 480_000,
  });
  if (!r1?.text) throw new Error("修订 LLM 无响应");
  const revisedBody = String(r1.text).replace(/^```(markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim();
  // step2: 摘要/关键词按修订稿重生成
  const abs = await generateComponent({ kind: "abstract", topic: ctx.goal ?? title, sections: [], chapterContents: [revisedBody] }).catch(() => ({ content: abstract }));
  const kws = await generateComponent({ kind: "keywords", topic: ctx.goal ?? title, sections: [] }).catch(() => ({ content: keywords }));
  const curVer = p.published_version ?? 0;
  const result = {
    revisionOf: curVer, revisionOfVersion: curVer,
    data: { abstract: abs.content, body: revisedBody },
    revisedAt: new Date().toISOString(),
  };
  // 修订稿双写: project 列(引擎链) + finalize 节点 payload(前端渲染源)
  await pool.query(
    `update research_projects set
       merged_abstract=$2, merged_keywords=$3, merged_fulltext=$4,
       revision_of_version=$5, merge_generated=true, updated_at=now()
     where id=$1`,
    [ctx.projectId, abs.content, kws.content, revisedBody, curVer || null]);
  const fzPayload = {
    mergedTitle: title, mergedAbstract: abs.content, mergedKeywords: kws.content,
    mergedFullText: revisedBody, mergedReferences: refs, reviewReport: reviewReport,
  };
  await pool.query(
    `update research_nodes set payload=$2::jsonb, version=version+1, updated_at=now()
      where project_id=$1 and node_key='finalize'`,
    [ctx.projectId, JSON.stringify(fzPayload)]).catch(() => ({ rowCount: 0 }));
  return {
    text: `修订完成: 全文 ${revisedBody.replace(/\s/g, "").length} 字 (revise of v${curVer})`,
    structured: result,
  };
}

/** 合并参考文献(GB/T7714 全文条目, 素材 citation 池去重; HAR mergedReferences 语义) */
async function buildMergedReferences(userId: string, projectId: string): Promise<string> {
  try {
    const r = await pool.query(
      `select content_md from research_materials
        where project_id=$1 and user_id=$2 and kind in ('citation','note')
        order by created_at limit 10`, [projectId, userId]);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of r.rows) {
      const text = String(row.content_md ?? "");
      for (const line of text.split("\n")) {
        const m = /^\s*\[(\d+)\]\s*(.+)$/.exec(line.trim());
        if (!m) continue;
        const body = m[2].trim();
        if (!seen.has(body)) {
          seen.add(body);
          out.push(`[${out.length + 1}] ${body}`);
        }
      }
    }
    return out.join("\n");
  } catch { return ""; }
}

// ═══ SocialSci UI级审计: structuredSummary 自动抽取器(原创实现, 规格对齐) ═══
// 功能: 从章节正文正则抽取 {关键结论/关键数据/核心论点/遗留问题} → ≤800字结构化摘要
// 语义对齐(闭源UI的Z()函数行为): 按段落切分→四类句式正则→组装
export function buildStructuredSummary(content: string): string {
  if (!content || content.trim().length < 100) return "";
  const paras = content.split(/\n\s*\n/).filter((w) => w.trim().length > 20);
  // 结论句式: 结果表明/本文认为/研究表明/综上/分析显示/由此/因此/可见
  const conclRe = /结果(表明|显示|发现|指出)|本文(认为|发现|得出)|研究(表明|发现|显示|证实)|综上|结论|分析(表明|显示)|由此|因此|可见/;
  const u = paras.filter((w) => conclRe.test(w));
  // 数据句式: 增长/降低/占比+数字
  const dataRe = /[增长上升提高增加下降降低减少]了\s*\d+|[占比达到]\s*\d+\.?\d*%|\d+\.?\d*\s*[万亿千百]/;
  const h: string[] = [];
  for (const w of paras) {
    for (const b of w.split(/[。！？]/)) {
      if (dataRe.test(b) && b.length > 10) h.push(b.trim());
    }
  }
  // 局限句式
  const limitRe = /局限|不足|未能|尚未|待进一步|未来研究|有待/;
  const E = paras.filter((w) => limitRe.test(w));
  // 论点句式
  const thesisRe = /假设|H\d|命题|核心(论点|观点|发现)|重要(结论|发现|贡献)/;
  const m = paras.filter((w) => thesisRe.test(w));

  const R: string[] = [];
  if (u.length > 0) R.push(`【关键结论】\n${u.slice(0, 2).map((w) => w.trim()).join("\n\n")}`);
  else {
    const tail = paras.slice(-2);
    if (tail.length > 0) R.push(`【关键结论】\n${tail.map((d) => d.trim()).join("\n\n")}`);
  }
  if (h.length > 0) R.push(`【关键数据】\n${h.slice(0, 3).join("\n")}`);
  if (m.length > 0) R.push(`【核心论点】\n${m.slice(0, 2).map((w) => w.trim()).join("\n\n")}`);
  if (E.length > 0) R.push(`【遗留问题】\n${E.slice(0, 1).map((w) => w.trim()).join("\n\n")}`);
  return R.join("\n\n").substring(0, 800);
}
