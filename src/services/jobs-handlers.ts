// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// jobs-handlers.ts — Jobs 默认任务处理器注册
// lint（数据完整性检查）/ backlinks（反向链接重算）/ synthesize（Compiled Truth 整合）
// / dream_cycle（夜间自整理 9-phase）/ batch_ingest（批量入库）/ hyperedge（超边）
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { registerHandler, type MinionJob } from "./jobs-service.js";

/** lint：检查 entities/events/chunks 数据完整性 */
registerHandler("lint", async () => {
  const counts = await pool.query(
    `select
      (select count(*) from entities) as entities,
      (select count(*) from events) as events,
      (select count(*) from source_chunks) as chunks,
      (select count(*) from event_entities) as edges,
      (select count(*) from knowledge_pages) as pages`
  );
  const row = counts.rows[0] ?? {};
  const issues: string[] = [];
  if (Number(row.entities) === 0) issues.push("entities 为空");
  if (Number(row.events) === 0) issues.push("events 为空");
  if (Number(row.chunks) === 0) issues.push("source_chunks 为空");
  return { counts: row, issues };
});

/** backlinks：重算实体反向链接（事件关联数） */
registerHandler("backlinks", async () => {
  const result = await pool.query(
    `update entities e set metadata = jsonb_set(
       coalesce(e.metadata, '{}'::jsonb), '{backlink_count}',
       to_jsonb((select count(*) from event_entities ee where ee.entity_id = e.id))
     )
     where exists (select 1 from event_entities ee where ee.entity_id = e.id)`
  );
  return { updated: result.rowCount ?? 0 };
});

/** synthesize：知识页 Compiled Truth 整合（扫描时间线矛盾 → 整合） */
registerHandler("synthesize", async (job: MinionJob) => {
  const { truthService } = await import("./truth-service.js");
  const result = await truthService.runDreamCycle();
  return { pages: result.scannedPages, resolved: result.resolved.length };
});

/** dream_cycle：夜间自整理（13-phase 对齐 GBrain 全链路：清洗→分类→建联→索引） */
registerHandler("dream_cycle", async () => {
  const phases: string[] = [
    // 阶段1 入库准备（蓝）
    "clean", "classify",
    // 阶段2 知识建联（橙）
    "lint", "backlinks", "sync", "synthesize", "extract", "disambiguate", "patterns", "recompute_emotional_weight",
    // 阶段3 索引刷新（绿）
    "embed", "orphans", "index_refresh",
    // V321(P1-8): 阶段4 睡眠学习（记忆整理+修剪）
    "sleep_learn"
  ];
  const phaseResults: Record<string, unknown> = {};
  for (const phase of phases) {
    try {
      const { jobsService } = await import("./jobs-service.js");
      if (jobsService.hasHandler(phase as never)) {
        // 直接调 handler（不走 executeJob 的 finishJob——内存子 job 无数据库行）
        phaseResults[phase] = await jobsService.runHandlerDirect(phase as never);
      } else {
        phaseResults[phase] = "skipped (no handler)";
      }
    } catch (error) {
      phaseResults[phase] = error instanceof Error ? error.message : String(error);
    }
  }
  return { phases: phaseResults };
});

/** extract：抽取关系（对齐 GBrain 9-phase phase 5 — 从文档抽实体/关系） */
registerHandler("extract", async () => {
  return { status: "needs-data", note: "关系抽取由入库流程 extractEventsFromChunk 完成，批量执行走 batch_ingest" };
});

/** patterns：跨会话主题（对齐 GBrain 9-phase phase 6 — 扫描知识页找重复主题） */
registerHandler("patterns", async () => {
  const { pool } = await import("../db/pool.js");
  const pages = await pool.query(`select title, compiled_truth from knowledge_pages where compiled_truth != ''`);
  const themes = new Map<string, number>();
  for (const row of pages.rows) {
    const words = String(row.compiled_truth).split(/[\s，。、；：！？,.!?;:]+/).filter((w: string) => w.length >= 3);
    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
    for (const [w, n] of freq.entries()) {
      if (n >= 2) themes.set(w, (themes.get(w) ?? 0) + 1);
    }
  }
  const top = [...themes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return { themes: top.map(([w, n]) => ({ theme: w, pages: n })) };
});

/** recompute_emotional_weight：情感权重重算（对齐 GBrain 9-phase phase 7 — 简化版：用事件数近似） */
registerHandler("recompute_emotional_weight", async () => {
  const { pool } = await import("../db/pool.js");
  const result = await pool.query(
    `update entities e set metadata = jsonb_set(
       coalesce(e.metadata, '{}'::jsonb), '{emotional_weight}',
       to_jsonb(least(1.0, 0.1 * (select count(*) from event_entities ee where ee.entity_id = e.id)))
     )
     where exists (select 1 from event_entities ee where ee.entity_id = e.id)`
  );
  return { updated: result.rowCount ?? 0 };
});

/** batch_ingest：批量入库（payload: { dir, count }） */
registerHandler("batch_ingest", async (job: MinionJob) => {
  const dir = String(job.payload?.dir ?? "");
  if (!dir) throw new Error("batch_ingest 需要 payload.dir");
  return { dir, status: "queued-for-manual-run", note: "批量入库请用 marx-ingest-all skill 执行" };
});

/** hyperedge：超边抽取（payload: { batchSize }） */
registerHandler("hyperedge", async (job: MinionJob) => {
  const batchSize = Number(job.payload?.batchSize ?? 10);
  return { batchSize, status: "check-log", note: "超边抽取由独立 Python 进程 batch_hyperedge_extract.py 执行" };
});

/** clean：清洗去重（GBrain phase 1 — 查重复文档/事件，软标记重复项） */
registerHandler("clean", async () => {
  const { pool } = await import("../db/pool.js");
  // 找重复文档（同 title 多份）
  const dups = await pool.query(
    `select title, count(*) as n from documents
     group by title having count(*) > 1 order by n desc limit 20`
  );
  // 找空内容文档
  const empty = await pool.query(
    `select id, title from documents where content is null or length(trim(content)) = 0 limit 20`
  );
  return {
    duplicate_docs: dups.rows,
    empty_docs: empty.rows,
    note: "重复项已在 V207 入库幂等处理，此处为巡检报告",
  };
});

/** classify：语言检测+内容分类（GBrain phase 2-3 — 统计语料语言分布与主题分类） */
registerHandler("classify", async () => {
  const { pool } = await import("../db/pool.js");
  // 语言检测：按字符特征粗分（中文/英文/混合）
  const lang = await pool.query(
    `select
       sum(case when title ~ '[一-鿿]' and title !~ '[a-zA-Z]' then 1 else 0 end) as chinese_only,
       sum(case when title ~ '[a-zA-Z]' and title !~ '[一-鿿]' then 1 else 0 end) as english_only,
       sum(case when title ~ '[一-鿿]' and title ~ '[a-zA-Z]' then 1 else 0 end) as mixed,
       count(*) as total
     from documents`
  );
  // 内容分类：按关键词粗分主题
  const topics = await pool.query(
    `select
       sum(case when title like '%资本%' or title like '%经济%' then 1 else 0 end) as econ,
       sum(case when title like '%乡村%' or title like '%农村%' or title like '%农业%' then 1 else 0 end) as rural,
       sum(case when title like '%金融%' or title like '%市场%' then 1 else 0 end) as finance,
       sum(case when title like '%法%' or title like '%政策%' or title like '%监管%' then 1 else 0 end) as policy,
       count(*) as total
     from documents`
  );
  return { language: lang.rows[0], topics: topics.rows[0] };
});

/** disambiguate：实体消歧（GBrain phase 6 — 找同名/近名实体报告） */
registerHandler("disambiguate", async () => {
  const { pool } = await import("../db/pool.js");
  // 同名实体（不同 id 同名）
  const same_name = await pool.query(
    `select name, count(*) as n from entities
     group by name having count(*) > 1 order by n desc limit 20`
  );
  // 近名实体（CONTAINS 相似）
  const fuzzy = await pool.query(
    `select e1.name as a, e2.name as b
     from entities e1 join entities e2 on e1.id < e2.id
       and e1.name <> e2.name
       and (e1.name like '%' || e2.name || '%' or e2.name like '%' || e1.name || '%')
     limit 20`
  );
  return {
    same_name: same_name.rows,
    fuzzy_pairs: fuzzy.rows,
    note: "消歧结果供人工确认，Graphiti 侧已有全局消歧脚本",
  };
});

/** index_refresh：索引刷新+统计报告（GBrain phase 7-9 — 向量/全文/统计） */
registerHandler("index_refresh", async () => {
  const { pool } = await import("../db/pool.js");
  // 统计报告
  const stats = await pool.query(
    `select
       (select count(*) from documents) as docs,
       (select count(*) from source_chunks) as chunks,
       (select count(*) from entities) as entities,
       (select count(*) from events) as events,
       (select count(*) from event_entities) as edges,
       (select count(*) from knowledge_pages) as pages,
       (select count(*) from page_entries) as page_entries`
  );
  // 向量覆盖检查（有 embedding 的 chunk 比例）
  const vec = await pool.query(
    `select
       count(*) filter (where embedding is not null) as embedded,
       count(*) as total
     from source_chunks`
  );
  // 全文索引状态
  const indexes = await pool.query(
    `select indexname, tablename from pg_indexes
     where indexname like '%gin%' or indexname like '%trgm%' or indexname like '%vector%'
     order by tablename limit 20`
  );
  return {
    stats: stats.rows[0],
    vector_coverage: vec.rows[0],
    indexes: indexes.rows.map((r: any) => `${r.tablename}.${r.indexname}`),
    note: "索引为 PG 侧；Neo4j 向量/全文索引在超边/实体抽取时自动建立",
  };
});

// ═══════════ P1-8 睡眠学习：记忆整理 + 修剪（2026-08-08）═══════════
// 书中 Ch8 睡眠学习: 触发→定向→整合(去重/冲突)→验证→修剪
// 只写不修剪 = 上下文腐化; archived 标记代替物理删除, 检索默认过滤
registerHandler("sleep_learn", async () => {
  const { pool } = await import("../db/pool.js");
  const report: Record<string, number> = {};

  // ① 去重：相同 query 归一化后哈希去重（保留最新的）
  const dup = await pool.query(`
    with ranked as (
      select id, query,
        row_number() over (partition by lower(regexp_replace(query, '[，。、；：！？\s]+', '', 'g')) order by created_at desc) as rn
      from task_experience where archived = false
    )
    select count(*)::int as n from ranked where rn > 1
  `);
  report.duplicates = dup.rows[0]?.n ?? 0;
  await pool.query(`
    with ranked as (
      select id,
        row_number() over (partition by lower(regexp_replace(query, '[，。、；：！？\s]+', '', 'g')) order by created_at desc) as rn
      from task_experience where archived = false
    )
    update task_experience set archived = true
    where id in (select id from ranked where rn > 1)
  `);
  report.archived_duplicates = report.duplicates;

  // ② 冲突标记：同一 query 的 success 与 fail 并存 → 标记 conflict_unsolved
  const conflict = await pool.query(`
    select count(distinct q)::int as n from (
      select lower(regexp_replace(query, '[，。、；：！？\s]+', '', 'g')) as q
      from task_experience where archived = false
      group by q having bool_or(success) and bool_or(not success)
    ) t
  `);
  report.conflicts = conflict.rows[0]?.n ?? 0;
  await pool.query(`
    update task_experience set conflict_unsolved = true
    where archived = false and lower(regexp_replace(query, '[，。、；：！？\s]+', '', 'g')) in (
      select lower(regexp_replace(query, '[，。、；：！？\s]+', '', 'g'))
      from task_experience where archived = false
      group by 1 having bool_or(success) and bool_or(not success)
    )
  `);

  // ③ 修剪：last_used_at > 90 天 或 user_feedback ≤ -3 → 归档（不物理删除）
  const prune = await pool.query(`
    update task_experience set archived = true
    where archived = false
      and (last_used_at < now() - interval '90 days' or user_feedback <= -3)
    returning id
  `);
  report.pruned = prune.rows.length;

  return { status: "done", report };
});

// 注册进 dream_cycle 链（睡眠学习 = 记忆整理阶段，放在 embed 之后）

// ═══ V376: 自主研究（③主动行为）——每日自动: 记忆巡检→待办提取→研究摘要 ═══
registerHandler("autonomous_research", async () => {
  console.log("[autonomous_research] 开始自主研究周期...");
  const report: Record<string, unknown> = { at: new Date().toISOString() };
  try {
    // 1. 记忆巡检: 从 OpenViking 召回用户最近偏好/待办（找研究主题）
    const { recallMemory } = await import("./openviking-memory.js");
    const mems = await recallMemory("用户研究主题 待办 关注", 5, 0.1);
    report.memoryRecalled = mems.length;
    // 2. 从记忆里提取潜在研究主题（用户关注点）
    const topics = mems.map((m) => m.content.replace(/[\n\r]+/g, " ").substring(0, 80));
    report.topics = topics.slice(0, 3);
    // 3. 主动研究摘要: 对最高分主题做一次检索总结（若有主题）
    if (topics.length > 0) {
      const topTopic = topics[0];
      report.researched = topTopic;
      // 用 SAG 检索跑一次（如果服务可用）
      try {
        const searchRes = await fetch("http://localhost:4173/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: topTopic, sourceIds: ["c609acbf-1d6e-4bd5-9ae1-92fa6c64021a"], topK: 5 }),
          signal: AbortSignal.timeout(30000),
        });
        if (searchRes.ok) {
          const sj = await searchRes.json();
          report.searchHits = (sj.sections ?? []).length;
        }
      } catch { report.searchHits = 0; }
    }
    // 4. 记录完成（alerts 告警中心可见）
    const { recordAlert } = await import("./alert-service.js");
    await recordAlert({ level: "info", category: "success", message: `自主研究完成：召回 ${report.memoryRecalled} 条记忆${report.researched ? `，研究主题「${String(report.researched).slice(0, 30)}」` : "（无主题）"}`, taskType: "autonomous" });
  } catch (e: any) {
    console.error("[autonomous_research] 失败:", e?.message?.substring(0, 80));
    const { recordAlert } = await import("./alert-service.js");
    await recordAlert({ level: "error", category: "failure", message: `自主研究失败：${e?.message?.substring(0, 60)}`, taskType: "autonomous" });
  }
  return report;
});
