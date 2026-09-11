// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// review-service.ts — SocialSci P0-3: 审稿任务流 + 期刊库/标准库解析
// 形态对齐(闭源产品交互语义, 原创实现): 传稿→分段审稿→SSE review.delta 维度JSON边流边渲染→聚合报告
//   - 分段: 2000-4000字/段 token感知, 逐段 LLM 审 → 写 progress checkpoint(断线续传)
//   - parse: 投稿须知/评分标准 → LLM 结构化 JSON(zod 校验)
//   - 选用刊物规则: journal.parsed_rules 并入本次审稿维度
// 迁移117 review_jobs/review_journals/review_standards
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";
import type { AttachedSse } from "../api/stream-utils.js";

// ═══ LLM JSON 调用 ═══
async function llmJson(prompt: string, modelOverride?: string, maxTokens = 6000, temperature = 0.3): Promise<any | null> {
  const ep = getLlmEndpoint({ model: modelOverride || getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON, 不要其他文字。" }],
    temperature, maxTokens, timeoutMs: 300_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}

/** 分段: 2000-4000字/段(尽量在段落边界断开) */
export function segmentText(text: string, minLen = 1800, maxLen = 4000): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= maxLen) return clean ? [clean] : [];
  const segs: string[] = [];
  let rest = clean;
  while (rest.length > maxLen) {
    // 在 [minLen, maxLen] 之间找最后的段落边界
    let cut = -1;
    for (let i = maxLen; i >= minLen && cut === -1; i--) {
      if (rest[i] === "\n" && rest[i + 1] === "\n") cut = i + 1;
    }
    if (cut === -1) {
      // 无段落边界: 找句号
      for (let i = maxLen; i >= minLen && cut === -1; i--) {
        if ("。！？.!?".includes(rest[i])) cut = i + 1;
      }
    }
    if (cut === -1) cut = maxLen;
    segs.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) segs.push(rest);
  return segs;
}

const DEFAULT_DIMENSIONS = [
  // P-B: 闭源社科期刊 7 维模板(实页 /review 报告维度权重 3-5 整数档, 30 分制)
  // weight 归一 = weightLabel/30(聚合 schema 用 0-1), weightLabel 供 UI 显示闭源整档
  { key: "topic_value", name: "选题与意义", weight: 4 / 30, weightLabel: 4, criteria: "选题价值/现实意义/理论意义/概念创新性", min: 0, max: 100 },
  { key: "literature", name: "文献综述与分析框架", weight: 5 / 30, weightLabel: 5, criteria: "综述深度/学理对话/框架清晰/引文规范", min: 0, max: 100 },
  { key: "method", name: "研究方法与数据", weight: 5 / 30, weightLabel: 5, criteria: "研究设计/变量测量/数据可信/样本交代", min: 0, max: 100 },
  { key: "empirical", name: "实证分析", weight: 5 / 30, weightLabel: 5, criteria: "实证章节完整/假设检验/结果呈现/稳健性", min: 0, max: 100 },
  { key: "countermeasure", name: "对策建议", weight: 4 / 30, weightLabel: 4, criteria: "针对性/与实证对应/可操作性/创新建议", min: 0, max: 100 },
  { key: "writing", name: "写作规范与格式", weight: 3 / 30, weightLabel: 3, criteria: "文字流畅/格式统一/参考文献规范/无AI痕迹", min: 0, max: 100 },
  { key: "logic", name: "逻辑结构", weight: 4 / 30, weightLabel: 4, criteria: "论证严密/结构层次/逻辑连贯/实证衔接", min: 0, max: 100 },
];

/** 「还在跑」的状态集: 后端分段审稿会经过 segmenting/summarizing/streaming,
 *  只认 running 会让取消按钮对这些态无效、重试又对它们误开。 */
const ACTIVE_JOB_STATUS = ["queued", "running", "segmenting", "summarizing", "streaming", "paused"];

/** 取默认维度(新审稿无标准时) */
export function defaultDimensions() {
  return JSON.parse(JSON.stringify(DEFAULT_DIMENSIONS));
}

// ═══ 审稿任务 CRUD ═══
export async function createReviewJob(input: {
  userId: string; title?: string; text: string; kind?: string;
  journalId?: string; standardId?: string; sourceFilePath?: string;
  // SocialSci R4: settings/rules/来源文件(HAR 实测)
  settings?: { strictness?: string; journalId?: string | null; standardIds?: string[]; customRequirements?: string; modelId?: string };
  sourceFileId?: string; sourceFileName?: string; sourceFileType?: string;
  sidebarTaskId?: string;
  /** 显式要求按闭源 7 维默认标准判审(不选标准库时默认走「设为默认」的标准) */
  useDefaults?: boolean;
}) {
  const id = randomUUID();
  const segments = segmentText(input.text);
  // 选刊/选标准有两条来源, 必须读数组合:
  //   (a) settings.journalId / settings.standardIds — Vue 面板(闭源契约)只从这里发
  //   (b) 顶层 journalId / standardId — MCP、直接调 API 的老路径
  // 2026-09-11 实测: 面板选了刊物但 settings_json.journalId 被读成 journal_id=null,
  //   期刊规则不进提示词、"选用刊物"选项事实上是死的。
  const wantsDefaults = input.useDefaults === true;   // 显式「按默认标准判审」
  const journalId = input.journalId ?? input.settings?.journalId ?? undefined;
  const stdIds = (input.settings?.standardIds?.length ? input.settings.standardIds
    : input.standardId ? [input.standardId] : []);
  let dimensions: Array<Record<string, unknown>> = [];
  const picked: Array<Record<string, unknown>> = [];
  if (stdIds.length) {
    const s = await pool.query(
      // id 是 uuid 列, 面板传的是字符串数组 → `id = any($1::text[])` 报 uuid = text, 建任务直接 500。
      // 归属必须过滤(实测): 不加的话 A 传 B 的私有标准 id 就能把 B 的评分细则抄进自己的任务,
      //   再经 GET /jobs/:id 原样回显 —— 与 listStandards 的 ownClause 对齐。
      `select dimensions from review_standards
        where id::text = any($1::text[]) and (user_id=$2 or built_in)`, [stdIds, input.userId]);
    const seen = new Set<string>();
    for (const row of s.rows as Array<{ dimensions: unknown }>) {
      const dims = Array.isArray(row.dimensions) ? row.dimensions as Array<Record<string, unknown>> : [];
      for (const d of dims) {
        const k = String(d.key ?? d.name ?? "");
        if (!k || seen.has(k)) continue;
        seen.add(k); picked.push(d);
      }
    }
  }
  if (picked.length) dimensions = picked;
  else if (wantsDefaults) dimensions = defaultDimensions();
  else {
    // 没选标准也读一遍「设为默认」的标准(标准库那个开关此前对审稿毫无作用)
    const d = await pool.query(
      `select dimensions from review_standards
        where is_default and (user_id=$1 or built_in) order by updated_at desc limit 1`, [input.userId]);
    const dims = d.rows[0]?.dimensions;
    dimensions = Array.isArray(dims) && dims.length ? dims as Array<Record<string, unknown>> : defaultDimensions();
  }
  // 刊物规则并入(优先期刊规则的审稿关注点)
  let journalRules: unknown = null;
  if (journalId) {
    const j = await pool.query(
      // 同上: 期刊若不校验归属, 选别人私刊就能读到对方的投稿要求原文
      `select parsed_rules from review_journals where id=$1 and (user_id=$2 or user_id is null)`,
      [journalId, input.userId]);
    journalRules = j.rows[0]?.parsed_rules ?? null;
  }
  const payload = journalRules ? { rules: journalRules } : {};
  // R4: settings_json/rules_json 结构化落库(与前端契约对齐)
  const settings = {
    strictness: "standard", journalId: null as string | null, standardIds: [] as string[],
    customRequirements: "", modelId: "", ...(input.settings ?? {}),
  };
  settings.journalId = journalId ?? null;
  const rules = { journal: journalId ?? null, standards: stdIds };
  const contentHash = contentHashOf(input.text);
  await pool.query(
    `insert into review_jobs
       (id, user_id, kind, title, text_snapshot, journal_id, standard_id, dimensions, status, progress,
        settings_json, rules_json, content_hash, source_file_id, source_file_name, source_file_type, sidebar_task_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, input.userId, input.kind ?? "text", input.title ?? "",
     input.text, journalId ?? null, stdIds[0] ?? null,
     JSON.stringify(dimensions),
     JSON.stringify({ totalSegments: segments.length, segmentsDone: 0, lastEventSeq: 0, ...payload }),
     JSON.stringify(settings), JSON.stringify(rules), contentHash,
     input.sourceFileId ?? "", input.sourceFileName ?? "", input.sourceFileType ?? "",
     input.sidebarTaskId ?? ""]
  );
  return { id, segmentCount: segments.length, dimensions };
}

function contentHashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function getReviewJob(userId: string, jobId: string) {
  // 重审链: 向上追到底得到首次任务, 链长即"这是第几次审" —— UI 靠它显示"第 2 次审稿"
  // (只回 retry_of 时用户看到的是个没有含义的 uuid)
  const r = await pool.query(
    `with recursive chain as (
       select id, retry_of, 0 as depth from review_jobs where id=$1 and user_id=$2
       union all
       select p.id, p.retry_of, c.depth + 1 from review_jobs p join chain c on p.id = c.retry_of
        where c.depth < 200
     )
     select j.*,
            (select max(depth) from chain) as attempt_index,
            (select id from chain where depth = (select max(depth) from chain)) as first_job_id
       from review_jobs j where j.id=$1 and j.user_id=$2`,
    [jobId, userId]
  );
  return r.rows[0] ?? null;
}

/**
 * 任务列表(重审链只列最新的那次; 每条带"第几次审")。
 * 锚点必须取"链首"(retry_of 为空 / 父任务已不存在), 从链首往下数深度 ——
 * 反过来从链尾数会把首次审稿数成"第 2 次"(实测踩过)。
 */
export async function listReviewJobs(userId: string, limit = 50, offset = 0) {
  const r = await pool.query(
    `with recursive chain as (
       select j.id, 0 as depth
         from review_jobs j
        where j.user_id=$1
          and (j.retry_of is null or not exists (select 1 from review_jobs p where p.id = j.retry_of))
       union all
       select c.id, ch.depth + 1
         from review_jobs c join chain ch on c.retry_of = ch.id
        where ch.depth < 200
     )
     select j.id, j.kind, j.title, j.journal_id, j.standard_id, j.status, j.created_at, j.updated_at,
            j.retry_of, ch.depth as attempt_index,
            result->'paperTitle' as paper_title, result->'wordCount' as word_count
       from review_jobs j join chain ch on ch.id = j.id
      where not exists (select 1 from review_jobs c2 where c2.retry_of = j.id)
      order by j.created_at desc limit $2 offset $3`,
    [userId, limit, Math.max(0, offset)]
  );
  return r.rows;
}

/**
 * 删除一条审稿记录(报告 + 批注 + 进度一并删)。
 *
 * 由来(2026-09-11): 前端一直有删除按钮, 但**后端从来没有 DELETE 路由**, 而前端
 *   `deleteReviewJob` 又写了 `.catch(() => null)` —— 404 被吞掉, UI 显示"已删除"实际什么都没发生。
 *
 * 约束:
 *   ① 只删自己的(user_id 过滤), 且**不含重审链的其他版本** —— 删一条就是删一条,
 *      顺手连带删掉用户没选中的历史版本是意外破坏;
 *   ② 正在执行/排队的任务不允许删(执行器还在写它, 删了会留下孤儿状态) → 返回 false;
 *   ③ 重审链: 若被删的是中间节点, 把指向它的子节点 retry_of 置空(它们变成链头), 避免出现断链。
 */
export async function deleteReviewJob(userId: string, jobId: string): Promise<boolean> {
  const cur = await pool.query(`select status from review_jobs where id=$1 and user_id=$2`, [jobId, userId]);
  if (!cur.rowCount) return false;
  const st = String(cur.rows[0].status ?? "");
  if (ACTIVE_JOB_STATUS.includes(st)) return false;   // 还在跑/排队: 先取消再删

  const client = await pool.connect();
  try {
    await client.query("begin");
    // 先把指向它的子节点提到链头, 再删自己: 否则子节点的 retry_of 会指向不存在的行,
    // 列表的递归 CTE 找不到链头, 那些版本会从"往期审稿"里凭空消失
    await client.query(`update review_jobs set retry_of = null where retry_of = $1 and user_id = $2`, [jobId, userId]);
    const r = await client.query(`delete from review_jobs where id=$1 and user_id=$2`, [jobId, userId]);
    await client.query("commit");
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 往期审稿总数(同一个"链尾"口径, 与 listReviewJobs 一致) —— 前端据此决定还要不要"加载更多" */
export async function countReviewJobs(userId: string): Promise<number> {
  const r = await pool.query(
    `with recursive chain as (
       select j.id from review_jobs j
        where j.user_id=$1 and (j.retry_of is null or not exists (select 1 from review_jobs p where p.id = j.retry_of))
       union all
       select c.id from review_jobs c join chain ch on c.retry_of = ch.id
        where true
     )
     select count(*)::int as n from chain c
      where not exists (select 1 from review_jobs c2 where c2.retry_of = c.id)`,
    [userId]
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function updateJobStatus(userId: string, jobId: string, status: string, patch: { progress?: unknown; error?: unknown } = {}) {
  const sets = ["status=$3", "updated_at=now()"];
  const vals: unknown[] = [jobId, userId, status];
  if (patch.progress !== undefined) { sets.push(`progress=$${vals.length + 1}`); vals.push(JSON.stringify(patch.progress)); }
  if (patch.error !== undefined) { sets.push(`error=$${vals.length + 1}`); vals.push(JSON.stringify(patch.error)); }
  // 终态不可被中间态覆盖: cancelled/failed 之后仍可能有迟到的 segmenting/streaming 写入
  const keepTerminal = !["cancelled", "failed", "done"].includes(status);
  const r = await pool.query(
    `update review_jobs set ${sets.join(",")}
      where id=$1 and user_id=$2${keepTerminal ? " and status not in ('cancelled','failed','done')" : ""}
      returning id`, vals
  );
  return r.rows[0] ?? null;
}

/** 取消/终止判定(协作式取消用) */
async function isJobCancelled(userId: string, jobId: string): Promise<boolean> {
  try {
    const r = await pool.query(`select status from review_jobs where id=$1 and user_id=$2`, [jobId, userId]);
    const st = (r.rows[0] as { status?: string } | undefined)?.status;
    return st === "cancelled" || st === "failed";
  } catch { return false; }   // 查询失败按未取消处理, 不误杀
}

export async function controlReviewJob(userId: string, jobId: string, action: "cancel" | "retry") {
  const j = await getReviewJob(userId, jobId);
  if (!j) return null;
  if (action === "cancel" && ACTIVE_JOB_STATUS.includes(j.status)) {
    await updateJobStatus(userId, jobId, "cancelled");
    return { ...j, status: "cancelled" };
  }
  // 结果页的「重新审稿」按钮打在 done 任务上 —— 只允许 failed/cancelled 时它是死的(点了没反应)
  if (action === "retry" && !ACTIVE_JOB_STATUS.includes(j.status)) {
    const id = randomUUID();
    await pool.query(
      // settings_json/rules_json 一起复制: 漏了重审就退回默认严格度, 用户会以为"重审换了标准"
      `insert into review_jobs
         (id, user_id, kind, title, text_snapshot, journal_id, standard_id, dimensions, status, progress, retry_of,
          settings_json, rules_json, source_file_id, source_file_name, source_file_type)
       select $1, user_id, kind, title, text_snapshot, journal_id, standard_id, dimensions, 'queued',
              -- 期刊规则只存在 progress.rules 里, 写死 '{}' 会让"重审"悄悄丢掉选刊的效果;
              -- 但 segmentsDone 必须归零 —— 重审是重跑, 不是断点续传
              (coalesce(progress,'{}'::jsonb) - 'segmentsDone' - 'lastEventSeq')
                || jsonb_build_object('segmentsDone', 0, 'lastEventSeq', 0),
              id,
              settings_json, rules_json, source_file_id, source_file_name, source_file_type
         from review_jobs where id=$2 and user_id=$3`,
      [id, jobId, userId]
    );
    return { ...j, id, status: "queued" };
  }
  return j;
}

// ═══ 执行并发闸(集群级) ═══
// 两条要求, 都在 DB 上实现, 多实例部署同样成立:
//   ① 同一任务同时只能有一个执行者 —— 否则一份稿子会被审两遍(实测: 两条 SSE 各跑满全程,
//      LLM 调用与事件全部翻倍); 多实例下更难察觉。
//   ② 同时执行的审稿数有集群级上限 —— 进程内计数在多实例下等于没限。
// 与 agent-task-queue 的 exec_lease_* 同款: 实例标识 + token fencing + TTL 兜底。
const INSTANCE = `inst:${randomUUID().slice(0, 8)}:${process.pid}`;
let execSeq = 0;
/**
 * 租约持有者必须是"这一次执行", 不能是实例 —— 实例级持有者会让同进程内的第二个执行者
 * 被判定为"自己人"从而续租放行(实测: 同一进程开两条 SSE 会各审一遍)。
 */
const nextExecutionId = () => `${INSTANCE}#${++execSeq}`;
const LEASE_TTL_SECONDS = Math.max(30, parseInt(process.env.REVIEW_LEASE_TTL || "120", 10));
// 取用时读(而不是模块加载时): 测试可以把间隔调到很小来真正驱动心跳
const heartbeatMs = () => Math.max(20, parseInt(process.env.REVIEW_HEARTBEAT_MS || "30000", 10));
/** 槽位轮询间隔(秒): 抢不到就等下一轮 */
const SLOT_POLL_MS = Math.max(200, parseInt(process.env.REVIEW_SLOT_POLL_MS || "1500", 10));
/** 期望的集群并发上限(启动时用来补齐槽位行数) */
const WANTED_CONCURRENCY = Math.max(1, parseInt(process.env.REVIEW_CONCURRENCY || "4", 10));

/** 抢任务执行租约: 空闲/过期/自己持有 → 拿到(或续期)并返回 token; 他人持有未过期 → null(别跑) */
async function claimJobLease(jobId: string, holder: string): Promise<number | null> {
  try {
    const r = await pool.query(
      `update review_jobs set
         exec_lease_holder = case
           when exec_lease_holder = $2 and exec_lease_until > now() then exec_lease_holder
           when exec_lease_holder is null or exec_lease_until <= now() then $2
           else exec_lease_holder end,
         exec_lease_token = case
           when exec_lease_holder = $2 and exec_lease_until > now() then exec_lease_token
           when exec_lease_holder is null or exec_lease_until <= now() then coalesce(exec_lease_token, 0) + 1
           else exec_lease_token end,
         exec_lease_until = case
           when exec_lease_holder = $2 and exec_lease_until > now() then now() + ($3::int || ' seconds')::interval
           when exec_lease_holder is null or exec_lease_until <= now() then now() + ($3::int || ' seconds')::interval
           else exec_lease_until end
       where id = $1::uuid
       returning exec_lease_holder, exec_lease_token`,
      [jobId, holder, LEASE_TTL_SECONDS]
    );
    const row = r.rows[0] as { exec_lease_holder?: string; exec_lease_token?: number } | undefined;
    if (!row || row.exec_lease_holder !== holder) return null;   // 已被别的执行者持有
    return Number(row.exec_lease_token);
  } catch (e) {
    console.error("[review-lease] 抢租约失败:", String((e as Error)?.message ?? e).slice(0, 120));
    return null;   // DB 不可用 → 保守不跑(宁可排队也不双跑烧钱)
  }
}

/** 心跳续期: 只有仍持有且 token 未变时才成功(被抢走后旧持有者自动放弃) */
async function renewJobLease(jobId: string, holder: string, token: number): Promise<boolean> {
  try {
    const r = await pool.query(
      // TTL 必须是 $4: $3 是 token, 拿它当秒数(且多传一个参数)会让心跳每次都报参数个数不符,
      // 表现成"租约被抢"从而误杀正在跑的审稿(实测踩过: 快任务在首次心跳前跑完所以没暴露)
      `update review_jobs set exec_lease_until = now() + ($4::int || ' seconds')::interval
        where id = $1::uuid and exec_lease_holder = $2 and exec_lease_token = $3`,
      [jobId, holder, token, LEASE_TTL_SECONDS]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    // 不能静默吞: 查询写错和"租约真被别人抢走"都返回 false, 前者会伪装成后者
    console.error("[review-lease] 心跳失败:", String((e as Error)?.message ?? e).slice(0, 140));
    return false;
  }
}

async function releaseJobLease(jobId: string, holder: string, token: number): Promise<void> {
  try {
    await pool.query(
      `update review_jobs set exec_lease_holder = null, exec_lease_token = null, exec_lease_until = null
        where id = $1::uuid and exec_lease_holder = $2 and exec_lease_token = $3`,
      [jobId, holder, token]
    );
  } catch (e) {
    console.error("[review-lease] 释放失败(TTL 兜底):", String((e as Error)?.message ?? e).slice(0, 120));
  }
}

/** 抢一个全局槽位(原子): 返回槽位号; 全被占 → null */
async function claimSlot(jobId: string): Promise<number | null> {
  try {
    const r = await pool.query(
      `update review_exec_slots set job_id = $1::uuid, holder = $2, acquired_at = now()
        where slot = (select slot from review_exec_slots
                       where job_id is null or acquired_at < now() - ($3::int || ' seconds')::interval
                       order by slot limit 1 for update skip locked)
       returning slot`,
      [jobId, INSTANCE, LEASE_TTL_SECONDS * 2]
    );
    return r.rows.length ? Number((r.rows[0] as { slot: number }).slot) : null;
  } catch {
    return null;
  }
}

/**
 * 槽位心跳: 用 acquired_at 兼作心跳时间戳。
 * 不续期的后果(实测复核过): 一次审稿超过 2×TTL 后, 别的实例会把该槽位判成"过期残留"并抢走
 * → 同时执行数超过上限; 且原持有者释放时 job_id 已不匹配 → 槽位永久泄漏。
 */
async function renewSlot(slot: number, jobId: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `update review_exec_slots set acquired_at = now() where slot = $1 and job_id = $2::uuid`,
      [slot, jobId]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    console.error("[review-lease] 槽位续期失败:", String((e as Error)?.message ?? e).slice(0, 140));
    return false;
  }
}

async function releaseSlot(slot: number, jobId: string): Promise<void> {
  try {
    await pool.query(
      `update review_exec_slots set job_id = null, holder = null, acquired_at = null
        where slot = $1 and job_id = $2::uuid`,
      [slot, jobId]
    );
  } catch { /* TTL 兜底 */ }
}

/** 集群队列观测(面板/测试用): 占用中的槽位数 + 在跑的任务数 */
export async function reviewQueueDepth(): Promise<{ running: number; slots: number }> {
  try {
    const r = await pool.query(
      `select (select count(*) from review_exec_slots where job_id is not null) as used,
              (select count(*) from review_exec_slots) as total`
    );
    const row = r.rows[0] as { used: string; total: string };
    return { running: Number(row.used), slots: Number(row.total) };
  } catch { return { running: 0, slots: 0 }; }
}

/** 启动时把槽位行数补齐到期望值(扩容/缩容都靠它) */
export async function ensureReviewSlots(): Promise<number> {
  try {
    await pool.query(
      `insert into review_exec_slots (slot) select generate_series(1, $1::int) on conflict (slot) do nothing`,
      [WANTED_CONCURRENCY]
    );
    // 缩容: 只删"空闲且超出期望数量"的槽位(占用中的留给它跑完, 下次启动再收)
    await pool.query(
      `delete from review_exec_slots where slot > $1::int and job_id is null`,
      [WANTED_CONCURRENCY]
    );
    return WANTED_CONCURRENCY;
  } catch { return 0; }
}

/**
 * 申请执行权(集群级): 先抢任务租约(防同一任务双跑), 再抢全局槽位(防并发超限)。
 * ok:false 表示"这次连接不该执行" —— 任务被别的实例/标签页跑着, 或已取消/失败。
 * 客户端仍能通过它的 1.5s 轮询看到进度(审稿没有事件回放, 这一点与 viz 不同)。
 */
export async function acquireReviewSlot(opts: { userId: string; jobId: string; sse: AttachedSse }): Promise<{ ok: boolean; release: () => void; guard: () => void }> {
  const { userId, jobId, sse } = opts;
  const noop = () => { /* 未持有 */ };
  const holder = nextExecutionId();
  let leaseToken = await claimJobLease(jobId, holder);
  if (leaseToken === null) {
    // 失败立刻回落一次: 两个执行者几乎同时进来时, 谁先提交谁持有, 后者短暂重试即可拿到真实结论
    //   (不重试的话, "另一次执行刚好结束"会被误报成"有别的执行者在跑")
    await new Promise((r) => setTimeout(r, 400));
    leaseToken = await claimJobLease(jobId, holder);
  }
  if (leaseToken === null) {
    sse.send("review.status", { step: 0, total: 0, message: "该任务已由另一个执行者运行, 本页只做进度展示" });
    return { ok: false, release: noop, guard: noop };
  }

  let slot = await claimSlot(jobId);
  if (slot === null) {
    const q = await reviewQueueDepth();
    sse.send("review.status", { step: 0, total: 0, message: `审稿队列已满(${q.running}/${q.slots}), 已排队等待` });
    const deadline = Date.now() + 30 * 60_000;   // 最长等 30 分钟
    while (slot === null) {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, SLOT_POLL_MS));
      // 等待期间被取消 → 立刻放弃(不占租约)
      const j = await getReviewJob(userId, jobId);
      if (!j || j.status === "cancelled" || j.status === "failed") {
        await releaseJobLease(jobId, holder, leaseToken);
        return { ok: false, release: noop, guard: noop };
      }
      if (!(await renewJobLease(jobId, holder, leaseToken))) break;   // 租约被抢 → 放弃
      slot = await claimSlot(jobId);
    }
    if (slot === null) {
      await releaseJobLease(jobId, holder, leaseToken);
      sse.send("review.status", { step: 0, total: 0, message: "排队超时(30 分钟), 请稍后重新发起审稿" });
      return { ok: false, release: noop, guard: noop };
    }
  }

  // 心跳: 续 TTL; 被抢走(租约丢失)时置位, 由 guard 让执行循环退出, 不再继续烧 token
  let leaseLost = false;
  const beat = setInterval(() => {
    void (async () => {
      // 两个都要续: 任务租约(防重复执行) + 全局槽位(防被当成过期残留抢走)
      const [leaseOk, slotOk] = await Promise.all([
        renewJobLease(jobId, holder, leaseToken),
        renewSlot(slot!, jobId),
      ]);
      if (!leaseOk) {
        leaseLost = true;
        console.error("[review-lease] 租约已丢失, 停止执行", jobId);
      } else if (!slotOk) {
        // 槽位丢了但租约还在: 不中止执行(任务本身仍是独占的), 只告警——
        // 这可能让并发数短暂超出上限, 但比中断一次已经跑了一半的审稿代价小
        console.error("[review-lease] 槽位已失效(并发上限可能被短暂突破)", jobId);
      }
    })();
  }, heartbeatMs());

  let released = false;
  return {
    ok: true,
    guard: () => {
      if (leaseLost) throw Object.assign(new Error("执行租约已失效(另一实例接管), 本次执行中止"), { code: "LEASE_LOST" });
    },
    release: () => {
      if (released) return;
      released = true;
      clearInterval(beat);
      void releaseSlot(slot!, jobId);
      void releaseJobLease(jobId, holder, leaseToken);
    },
  };
}

/**
 * 卡死审稿自愈(启动时调): 进程崩溃/重启后, running·segmenting·summarizing 这些状态没人推进,
 * 且租约已过期 → 置 failed 可重试。审稿没有事件回放, 不修的话用户点开只会永久空转。
 * 顺带清掉超时残留的槽位占用(实例崩溃时 release 不会执行)。
 */
export async function reapStaleReviewJobs(): Promise<number> {
  try {
    const r = await pool.query(
      `update review_jobs set status='failed', updated_at=now(),
              error = coalesce(error,
                '{"code":"REVIEW_INTERRUPTED","userMessage":"服务重启导致审稿中断, 可点击重试","canRetry":true}'::jsonb)
        -- 不含 queued: 排队中的任务没有执行者是因为"还没人来取", 前端一连上就会跑它;
        --   判死会让它永远救不回来(runReviewJob 见到 failed 直接退出)。实测这条路径在
        --   "建完任务先去干别的"这种最常见用法下必中。
        where status = any($1::text[]) and status <> 'queued'
          and (exec_lease_until is null or exec_lease_until < now())
          and updated_at < now() - interval '2 minutes'
        returning id`,
      [["running", "segmenting", "summarizing", "streaming", "paused"]]
    );
    await pool.query(
      `update review_exec_slots set job_id=null, holder=null, acquired_at=null
        where acquired_at is not null and acquired_at < now() - ($1::int || ' seconds')::interval`,
      [LEASE_TTL_SECONDS * 2]
    );
    if (r.rows.length) console.error(`[review] 自愈 ${r.rows.length} 个中断审稿任务`);
    return r.rows.length;
  } catch (e) {
    console.error("[review] 卡死任务自愈失败", String((e as Error)?.message ?? e).slice(0, 120));
    return 0;
  }
}

// ═══ 核心: 分段审稿执行(SSE 流式) ═══// ═══ 核心: 分段审稿执行(SSE 流式) ═══// ═══ 核心: 分段审稿执行(SSE 流式) ═══// ═══ 核心: 分段审稿执行(SSE 流式) ═══
export async function runReviewJob(
  userId: string,
  jobId: string,
  sse: AttachedSse,
  opts: { guard?: () => void } = {}
): Promise<void> {
  const guard = opts.guard ?? (() => { /* 无租约(单测/内部调用)时不做中断检查 */ });
  const job = await getReviewJob(userId, jobId);
  if (!job) { sse.error({ code: "NOT_FOUND", userMessage: "审稿任务不存在", canRetry: false }); return; }
  // 排队期间被取消/已失败的任务不能复活 —— 否则会把 cancelled 覆盖回 segmenting 继续烧 token
  if (job.status === "cancelled" || job.status === "failed") {
    sse.send("review.cancelled", { userMessage: job.status === "cancelled" ? "审稿已取消" : "任务已失败, 请重新提交" });
    return;
  }
  const text = job.text_snapshot || "";
  const segments = segmentText(text);
  const progress = job.progress ?? {};
  const startSeg = Number(progress.segmentsDone ?? 0);
  const dimsRaw = (job.dimensions?.length ? job.dimensions : defaultDimensions()) as Array<Record<string, unknown>>;
  // 维度的展示名与权重: 标准库给的是 {key,name,weight}, LLM 汇总时只回 key —— 直接透传会把
  //   "选题与意义" 显示成 "topic_value"; weight 缺省也不能让归一权重(0.16)当百分比用。
  const dimNames = dimsRaw.map((d) => String(d.name ?? d.key ?? ""));
  const dimKeyOf = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/[\s_\-()（）]/g, "");
  const dimLabels = dimsRaw.map((d, i) => String(d.name || d.key || `维度${i + 1}`));
  const weightLabelOf = (d: Record<string, unknown> | undefined): number => {
    if (!d) return 1;
    const wl = Number(d.weightLabel);
    if (Number.isFinite(wl) && wl > 0) return wl;           // 闭源 3-5 整档
    const w = Number(d.weight);
    if (Number.isFinite(w) && w > 1) return w;             // 标准库 int 权重
    return 1;
  };
  const journalRules = (progress as { rules?: unknown }).rules;
  // 本次审稿的模型: 提交时选定, 随任务落库 —— 重审/恢复历史任务都会沿用同一个模型,
  //   不会出现"当时用 A 审的, 重开却走了默认模型"。
  const jobModel = String(((job.settings_json ?? {}) as { modelId?: string }).modelId || "");
  // 审稿设置(闭源三档严格度 + 额外要求): 此前只落库不进提示词, 三个档位跑出来一模一样
  const st = (job.settings_json ?? {}) as { strictness?: string; customRequirements?: string };
  const strictnessHint = st.strictness === "lax" ? "标准从宽: 只指出影响结论的硬伤, 措辞鼓励为主, 不罗列细节瑕疵。"
    : st.strictness === "strict" ? "标准从严: 按顶刊外审尺度逐条深挖, 方法/数据/论证/表述任一环节不达标都要指出并给出可执行修改方案。"
    : "标准适中: 按期刊编辑视角全面指出问题, 区分主次。";
  const customHint = String(st.customRequirements ?? "").trim().slice(0, 500);

  await updateJobStatus(userId, jobId, "segmenting");
  sse.send("review.started", { totalSegments: segments.length, fromSegment: startSeg });

  const segResults: Array<{ segIndex: number; findings: unknown[]; issues: unknown[] }> = [];
  try {
    // 逐段审(断点续传: 从 startSeg 起)
    for (let i = startSeg; i < segments.length; i++) {
      guard();   // 租约被别的实例抢走 → 立刻停, 不再继续烧 token
      // 协作式取消: 用户点"停止"时本段可能正卡在 LLM 调用里(超时最高 300s),
      //   返回后必须立刻退出 —— 否则会把 cancelled 覆盖回 streaming 并继续审完剩余所有段(实测)
      if (await isJobCancelled(userId, jobId)) {
        sse.send("review.cancelled", { userMessage: "审稿已取消" });
        return;
      }
      sse.send("review.status", { step: i, total: segments.length, message: `正在审阅第 ${i + 1}/${segments.length} 段...` });
      const ans = await llmJson(`你是中文学术期刊审稿专家。一律使用简体中文(引用原文时也照原文的简体写法)。审阅论文的一个片段, 输出 JSON:
{"issues":[{"level":"major|minor|suggestion","quote":"问题原文片段","comment":"问题说明","suggest":"修改建议"}],"notablePoints":["亮点"]}

【论文片段 ${i + 1}/${segments.length}】
${segments[i].slice(0, 4000)}

${dimNames.length ? `审稿维度: ${dimNames.join("、")}` : ""}
${strictnessHint}${customHint ? `
作者/编辑的额外要求(必须覆盖): ${customHint}` : ""}`, jobModel || undefined, 4000, 0.3);
      const issues = Array.isArray(ans?.issues) ? ans.issues : [];
      segResults.push({ segIndex: i, findings: ans?.notablePoints ?? [], issues });
      sse.send("review.delta", {
        segIndex: i, issuesCount: issues.length, issues: issues.slice(0, 10),
        notablePoints: ans?.notablePoints ?? [],
      });
      // 每段 checkpoint(断线续传) —— 只在非终态行上写: 无条件 update 会把 cancelled 覆盖回 streaming
      await pool.query(
        `update review_jobs set status='streaming', progress=$3::jsonb, updated_at=now()
          where id=$1 and user_id=$2 and status not in ('cancelled','failed')`,
        [jobId, userId, JSON.stringify({ ...progress, segmentsDone: i + 1, lastEventSeq: i + 1 })]
      );
      if (await isJobCancelled(userId, jobId)) {
        sse.send("review.cancelled", { userMessage: "审稿已取消" });
        return;
      }
    }

    // 聚合: 全段完成后一次 LLM 汇总成维度评分卡
    await updateJobStatus(userId, jobId, "summarizing");
    sse.send("review.status", { step: -1, message: "正在汇总审稿意见并生成评分卡..." });
    const allIssues = segResults.flatMap((s) => s.issues);
    const notable = segResults.flatMap((s) => s.findings);
    const agg = await llmJson(`你是期刊主编, 综合多位审稿人的分段意见, 输出最终审稿报告 JSON(SocialSci R4 全schema)。所有字段(含总体评语/维度意见/批注/建议)一律用简体中文书写, 不要混入繁体字:
{"paperTitle":"(从正文推断论文标题)",
 "wordCount":(正文中文字数),
 "overallScore":(0-100 总分整数),
 "grade":"A|A+|B|B+|C|C+|D(总分档)",
 "overallComment":"总体评语(120字内, 亮点+主要问题+录用倾向)",
 "dimensions":[{"name":"维度名","score":0,"maxScore":100,"weight":1,"status":"pass|warning|fail","summary":"该维度综合意见(80字内)","issues":[{"id":"issue-001","severity":"major|minor|suggestion","location":"章节/小节位置","originalText":"原文片段","suggestion":"修改建议"}]}],
 "annotations":[{"id":"ann-001","type":"error|warning|info","dimension":"所属维度名","highlightText":"批注对应原文片段(60字内)","comment":"批注说明"}],
 "highlights":["亮点1","亮点2","亮点3"],
 "topSuggestions":["首要修改建议1(具体可执行)","建议2","建议3"]}

【审稿维度(必须逐一评分, name 原样返回)】${dimLabels.map((n, i) => `${n}(权重${weightLabelOf(dimsRaw[i])})`).join("、")}
${strictnessHint}${customHint ? `\n额外要求: ${customHint}` : ""}
${journalRules ? `【期刊规则(须对照)】${JSON.stringify(journalRules).slice(0, 1000)}` : ""}
全部问题清单:
${allIssues.map((x) => JSON.stringify(x)).join("\n").slice(0, 5000)}
亮点: ${notable.slice(0, 10).join("; ")}`, undefined, 6000, 0.3);

    // 汇总这一步失败(模型超时/限流/JSON 解不出)时 agg 为 null —— 必须明确失败,
    //   否则会把"全 0 分 + 空评语"的报告当成功交出去, 用户看到一份完全瞎的审稿结果
    if (!agg) throw new Error("汇总评分失败(模型未返回可用结果), 可重试");

    // 按维度名把 LLM 输出对回标准定义(LLM 常用 key、模板默认名或顺序漂移)
    const byName = new Map<string, Record<string, unknown>>();
    for (const d of dimsRaw) for (const k of [d.name, d.key]) {
      const kk = dimKeyOf(k);
      if (kk) byName.set(kk, d);
    }
    // R4: 全 schema 结果(保留 majorIssues/minorIssues 字段兼容旧前端, 新增 overallScore/grade/annotations 等)
    // P-B: weightLabel 透传默认维度整档(3-5)供 UI 显示; LLM 输出维度保留其权重
    const aggDims = Array.isArray(agg?.dimensions) ? agg.dimensions as Array<Record<string, unknown>> : [];
    const usedAgg = new Set<number>();
    const dimsFull = dimsRaw.map((def, i) => {
      // 先按名字匹配 LLM 结果, 否则退回同序号(LLM 顺序一般与提示词一致)
      let hit = aggDims.findIndex((a, j) => !usedAgg.has(j) && dimKeyOf(a?.name) === dimKeyOf(def.name ?? def.key));
      if (hit < 0 && i < aggDims.length && !usedAgg.has(i)) hit = i;
      if (hit >= 0) usedAgg.add(hit);
      const d = (hit >= 0 ? aggDims[hit] : {}) as Record<string, unknown>;
      const wl = weightLabelOf(def);
      return {
        name: String(def.name ?? def.key ?? `维度${i + 1}`),
        score: Number(d.score ?? 0),
        maxScore: Number(d.maxScore ?? 100),
        weight: wl,
        weightLabel: wl,
        status: d.status ?? (Number(d.score ?? 0) >= 80 ? "pass" : Number(d.score ?? 0) >= 60 ? "warning" : "fail"),
        summary: String(d.summary ?? d.comment ?? ""),
        issues: (Array.isArray(d.issues) ? d.issues : []).slice(0, 10).map((iss: unknown, j: number) =>
          typeof iss === "string" ? { id: `issue-${String(i + 1).padStart(3, "0")}-${String(j + 1).padStart(3, "0")}`, severity: "minor", location: "", originalText: "", suggestion: iss }
          : ({ id: `issue-${String(i + 1).padStart(3, "0")}-${String(j + 1).padStart(3, "0")}`, severity: "minor", location: "", originalText: "", suggestion: "", ...(iss as Record<string, unknown>) })),
      };
    });
    // LLM 多给的维度(标准外补充)追加在后, 只保留有名称的
    for (const [j, a] of aggDims.entries()) {
      if (usedAgg.has(j)) continue;
      const nm = String(a?.name ?? "").trim();
      if (!nm) continue;
      dimsFull.push({
        name: nm, score: Number(a.score ?? 0), maxScore: Number(a.maxScore ?? 100),
        weight: weightLabelOf(a), weightLabel: weightLabelOf(a),
        status: String(a.status ?? "warning"), summary: String(a.summary ?? a.comment ?? ""), issues: [],
      });
    }
    // 批注的 dimension 同样归一成展示名, 否则详情页右边说"写作规范"、左边说"writing"
    const dimNameOf = (raw: unknown): string => {
      const def = byName.get(dimKeyOf(raw));
      return def ? String(def.name ?? def.key ?? raw) : String(raw ?? "");
    };
    const result = {
      paperTitle: agg?.paperTitle ?? job.title ?? "未命名论文",
      wordCount: agg?.wordCount ?? text.replace(/\s/g, "").length,
      overallScore: agg?.overallScore ?? 0,
      grade: agg?.grade ?? "C",
      overallComment: agg?.overallComment ?? agg?.overall ?? "",
      dimensions: dimsFull,
      annotations: (Array.isArray(agg?.annotations) ? agg.annotations : []).map((a: Record<string, unknown>, i: number) => ({
        id: a.id ?? `ann-${String(i + 1).padStart(3, "0")}`,
        type: a.type ?? "info", dimension: a.dimension ?? "", highlightText: a.highlightText ?? "", comment: a.comment ?? "",
      })),
      highlights: Array.isArray(agg?.highlights) ? agg.highlights : [],
      topSuggestions: Array.isArray(agg?.topSuggestions) ? agg.topSuggestions : [],
      // 兼容旧字段
      overall: agg?.overallComment ?? agg?.overall ?? "",
      majorIssues: Array.isArray(agg?.majorIssues) ? agg.majorIssues : [],
      minorIssues: Array.isArray(agg?.minorIssues) ? agg.minorIssues : [],
      segmentIssues: allIssues.length,
      reviewedAt: new Date().toISOString(),
    };
    const resultStr = JSON.stringify(result);
    // 终态写入只在非终态行上生效: 用户点了取消(control 已置 cancelled)时不能又把结果覆盖成 done —
    //   2017-09-11 实测: 取消后任务照样写 done, 前端只能把"已取消"当成功显示
    const fin = await pool.query(
      `update review_jobs set result=$2::jsonb, result_json=$5, result_text=$5, status='done',
              progress=jsonb_set(coalesce(progress,'{}'::jsonb),'{segmentsDone}',to_jsonb($3::int)),
              completed_at=now(), updated_at=now()
        where id=$1 and user_id=$4 and status not in ('cancelled','failed')
        returning id`,
      [jobId, resultStr, segments.length, userId, resultStr]
    );
    if (!fin.rows.length) {
      sse.send("review.cancelled", { userMessage: "审稿已取消" });
      sse.end();
      return;
    }
    sse.send("review.completed", { result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 取消导致的失败(SSE 断开时 AbortError)不该记成"审稿失败";
    // 租约丢失是执行权被接管, 也不能把任务标 failed(别人正在跑)
    const leaseLost = (e as { code?: string })?.code === "LEASE_LOST";
    const cancelled = !leaseLost && (/aborted|abort/i.test(msg) || /cancel/i.test(msg));
    if (leaseLost) {
      // 不写状态: 接管者正在推进这个任务
      sse.send("review.status", { step: 0, total: 0, message: "执行权已转给其他实例, 本页仅展示进度" });
      return;
    }
    await updateJobStatus(userId, jobId, cancelled ? "cancelled" : "failed", {
      error: { code: cancelled ? "REVIEW_CANCELLED" : "REVIEW_FAILED", userMessage: cancelled ? "审稿已取消" : msg, canRetry: !cancelled },
    });
    sse.error({ code: "REVIEW_FAILED", userMessage: msg, canRetry: true });
  }
}

// ═══ 期刊库/标准库 CRUD + 解析 ═══
/** 归属判定从宽: 公共库 + 本人创建 + 无主(迁移前遗留) — 否则自己建的条目在本列表里消失、改也改不动 */
const ownClause = (col = "user_id", n = 1) => `(${col}=$${n} or ${col} is null)`;

/** 库列表的对外形状: 面板读 category/scope/isBuiltIn/structuredRules/useCount —
 *  后端列名是 level/parsed_rules, 直接回 rows 会让面板的分类全是"其他"、关卡全是"待确认"。
 *  字段名由闭源 ReviewView 契约决定(left.join 只认这两个 key), 这里同时给 snake 兼容旧调用方。 */
function journalShape(row: Record<string, unknown>) {
  const rules = (row.parsed_rules ?? {}) as Record<string, unknown>;
  const level = String(row.level ?? "");
  return {
    ...row,
    category: level === "other" ? "" : level,
    scope: row.scope ?? "",
    isBuiltIn: row.user_id == null,
    isVerified: row.user_id != null,          // 自建 = 已核对; 公共库条目仍是"待确认"
    useCount: Number(row.use_count ?? 0),
    structuredRules: {
      // 原样保留库里的全部键: 面板读的是 AI 四类, 但本地正则产出的 6 类
      //   (wordCount/referenceFormat/languageStyle/…) 也必须带回前端, 否则编辑一次就永久丢失
      ...rules,
      formatRules: rules.formatRules ?? undefined,          // 闭源编辑页读这个 key(不是 reviewFocus)
      reviewFocus: rules.reviewFocus ?? undefined,
      citationRules: rules.citationRules ?? undefined,
      scope: rules.scope ?? undefined,
      submissionGuideText: row.submission_guide_text ?? "",
    },
  };
}

function standardShape(row: Record<string, unknown>) {
  const dims = Array.isArray(row.dimensions) ? row.dimensions as Array<Record<string, unknown>> : [];
  return {
    ...row,
    isBuiltIn: !!row.built_in,
    isDefault: !!row.is_default,
    useCount: Number(row.use_count ?? 0),
    // 闭源 StandardRecord 契约: 维度对象是 {name, weight, description, criteria:[{id,title}]},
    //   标准库存的是 {key, criteria(字符串), min, max} — 缺 description 会让面板整行维度渲染成空白
    dimensions: dims.map((d) => ({
      ...d,
      name: String(d.name ?? d.key ?? ""),
      description: d.description ?? d.criteria ?? "",
      criteria: Array.isArray(d.criteria) ? d.criteria : (d.criteria ? [{ id: "c1", title: String(d.criteria) }] : []),
    })),
  };
}

export async function listJournals(userId: string) {
  const r = await pool.query(
    // 只按真实任务数统计: 原来还去 parsed_rules->'usedBy' 里取 useCount 做 ::int 强转,
    //   用户往 parsedRules 塞一个非数字就会让列表永久 500(invalid input syntax for type integer)
    `select j.*,
            (select count(*) from review_jobs x where x.journal_id = j.id) as use_count
       from review_journals j where ${ownClause("j.user_id")} order by j.level, j.name`, [userId]);
  const own = r.rows.map(journalShape) as Array<Record<string, unknown>>;
  // 并入马理论期刊全库(cjournal_journals, 80 本)。
  //   由来(2026-09-11 用户反馈"期刊库太简陋"): 那份期刊目录一直在另一个表里, 审稿库只读 review_journals
  //   —— 于是界面上只有零散几条自建记录, 用户以为"期刊库是空的/很简陋"。
  //   拿过来做**只读底库**: 有官网/主办/主题标签, 可直接选刊; 要配投稿规则仍走"新增期刊"(存进 review_journals),
  //   同名时以自己配的那条为准。
  let catalog: Record<string, unknown>[] = [];
  try {
    const c = await pool.query(
      `select id, name, level, org, topic_tags, style, official_site
         from cjournal_journals order by level, name`);
    const ownNames = new Set(own.map((j) => String(j.name ?? "")));
    catalog = c.rows
      .filter((row) => !ownNames.has(String(row.name ?? "")))   // 自建的同名条目优先
      .map((row) => ({
        id: `catalog:${row.id}`,
        name: String(row.name ?? ""),
        category: String(row.level ?? ""),
        level: String(row.level ?? ""),
        scope: "",
        org: String(row.org ?? ""),
        topicTags: Array.isArray(row.topic_tags) ? row.topic_tags : [],
        style: String(row.style ?? ""),
        officialSite: row.official_site ?? "",
        structuredRules: {},
        isBuiltIn: true,          // 全库条目不归任何用户
        isVerified: false,
        isCatalog: true,          // 前端据此区分"只有题录"与"配了规则"
        useCount: 0,
      }));
  } catch { /* 期刊全库表不存在(旧库) → 只回自建 */ }
  return [...own, ...catalog];
}

export async function createJournal(input: { name: string; level?: string; category?: string; scope?: string; submissionGuideText?: string; parsedRules?: unknown; structuredRules?: Record<string, unknown>; userId?: string | null }) {
  // 面板发的是 category + structuredRules(闭源契约), 老调用方发 level + parsedRules — 两个都收
  const level = input.level ?? input.category ?? "other";
  const rules = input.parsedRules ?? input.structuredRules ?? {};
  const guide = input.submissionGuideText ?? String((input.structuredRules as Record<string, unknown> | undefined)?.submissionGuideText ?? "");
  const r = await pool.query(
    `insert into review_journals (name, level, scope, submission_guide_text, parsed_rules, user_id)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [input.name, level || "other", input.scope ?? "", guide,
     JSON.stringify(rules ?? {}), input.userId ?? null]);
  return { id: r.rows[0].id };
}

export async function updateJournal(userId: string, journalId: string, patch: { name?: string; level?: string; category?: string; scope?: string; submissionGuideText?: string; parsedRules?: unknown; structuredRules?: unknown }) {
  // 列名映射(白名单): 面板字段名 ≠ 库列名, 直接拼进 SQL 会 42703
  const cols: Record<string, unknown> = {};
  if (patch.name !== undefined) cols.name = patch.name;
  if (patch.level !== undefined || patch.category !== undefined) cols.level = patch.level ?? patch.category;
  if (patch.scope !== undefined) cols.scope = patch.scope;
  if (patch.submissionGuideText !== undefined) cols.submission_guide_text = patch.submissionGuideText;
  if (patch.parsedRules !== undefined) cols.parsed_rules = patch.parsedRules;
  else if (patch.structuredRules !== undefined) cols.parsed_rules = patch.structuredRules;
  const sets = ["updated_at=now()"]; const vals: unknown[] = [journalId, userId];
  for (const [k, v] of Object.entries(cols)) {
    if (v === undefined) continue;
    sets.push(`${k}=$${vals.length + 1}`);
    vals.push(typeof v === "string" || v === null ? v : JSON.stringify(v));
  }
  const r = await pool.query(
    `update review_journals set ${sets.join(",")} where id=$1 and ${ownClause("user_id", 2)} returning id`, vals);
  return r.rows[0] ?? null;
}

export async function deleteJournal(userId: string, journalId: string) {
  const r = await pool.query(`delete from review_journals where id=$1 and ${ownClause("user_id", 2)} returning id`, [journalId, userId]);
  return r.rows[0] ?? null;
}

/** 投稿须知 → AI 解析结构化规则 */
export async function parseSubmissionGuide(text: string) {
  // R9c: LLM JSON 解析失败兜底 — 重试 1 次仍失败返回可读错误(闭源 500"非有效JSON"无兜底, 学其教训)
  const run = async () => {
    const ans = await llmJson(`你是学术期刊编辑。解析期刊投稿须知原文为结构化规则, 输出 JSON:
{"formatRules":["格式要求(如字数/摘要结构/图表规范)"],
 "reviewFocus":["审稿关注点(该刊最看重的质量维度)"],
 "citationRules":["引文与参考文献规范"],
 "scope":"刊物收录范围一句话"}

原文:
${text.slice(0, 6000)}`, undefined, 3000, 0.2);
    if (!ans) return null;
    return {
      formatRules: Array.isArray(ans.formatRules) ? ans.formatRules : [],
      reviewFocus: Array.isArray(ans.reviewFocus) ? ans.reviewFocus : [],
      citationRules: Array.isArray(ans.citationRules) ? ans.citationRules : [],
      scope: typeof ans.scope === "string" ? ans.scope : "",
    };
  };
  const first = await run();
  if (first) return first;
  const retry = await run();
  if (retry) return retry;
  // 结构契约保持(测试/前端依赖字段恒存在), 附加 error 供前端提示
  return { formatRules: [], reviewFocus: [], citationRules: [], scope: "", error: "AI 解析失败(JSON 格式无效), 请稍后重试或换一段更规范的原文" };
}

export async function listStandards(userId: string) {
  const r = await pool.query(
    `select s.*,
            (select count(*) from review_jobs x where x.standard_id = s.id) as use_count
       from review_standards s where ${ownClause("s.user_id")} or s.built_in order by s.is_default desc, s.name`, [userId]);
  return r.rows.map(standardShape);
}

/** 面板维度 {name, weight, description, criteria:[{title}]} → 库格式 {key, name, weight, criteria(串), min, max} */
function dimToStored(d: Record<string, unknown>): Record<string, unknown> {
  const crit = d.criteria;
  const critText = Array.isArray(crit)
    ? crit.map((c) => String((c as Record<string, unknown>)?.title ?? c ?? "")).filter(Boolean).join("; ")
    : String(crit ?? d.description ?? "");
  return {
    key: String(d.key ?? d.name ?? "").trim(),
    name: String(d.name ?? d.key ?? "").trim(),
    weight: Number(d.weight) || 1,
    criteria: critText,
    description: String(d.description ?? critText),
    min: Number(d.min ?? 0), max: Number(d.max ?? 100),
  };
}

export async function createStandard(input: { name: string; scope?: string; description?: string; sourceText?: string; dimensions?: unknown; builtIn?: boolean; isDefault?: boolean; userId?: string | null }) {
  const dims = (Array.isArray(input.dimensions) ? input.dimensions as Array<Record<string, unknown>> : []).map(dimToStored);
  if (!dims.length) throw Object.assign(new Error("请至少填写一个审查维度"), { code: "EMPTY_DIMENSIONS", status: 400 });
  // built_in 只能由服务端内部置位(seed/迁移)。API 能传的话, 任何登录用户都能造一条"内置"标准:
  //   会被所有用户的列表看到、被"设为默认"选中、还能被任何人删掉 —— 全站默认维度可被单点污染(实测)。
  const r = await pool.query(
    `insert into review_standards (name, built_in, source_text, dimensions, is_default, user_id)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [input.name, input.builtIn === true && input.userId === null ? true : false,
     input.sourceText ?? input.description ?? "",
     JSON.stringify(dims), input.isDefault === true, input.userId ?? null]);
  return { id: r.rows[0].id };
}

export async function updateStandard(userId: string, standardId: string, patch: { name?: string; scope?: string; description?: string; sourceText?: string; dimensions?: unknown; isDefault?: boolean }) {
  const cols: Record<string, unknown> = {};
  if (patch.name !== undefined) cols.name = patch.name;
  if (patch.sourceText !== undefined) cols.source_text = patch.sourceText;
  else if (patch.description !== undefined) cols.source_text = patch.description;
  if (patch.isDefault !== undefined) cols.is_default = patch.isDefault;
  if (patch.dimensions !== undefined) {
    cols.dimensions = JSON.stringify((Array.isArray(patch.dimensions) ? patch.dimensions as Array<Record<string, unknown>> : []).map(dimToStored));
  }
  const sets = ["updated_at=now()"]; const vals: unknown[] = [standardId, userId];
  for (const [k, v] of Object.entries(cols)) {
    if (v === undefined) continue;
    sets.push(`${k}=$${vals.length + 1}`);
    vals.push(typeof v === "string" || v === null || typeof v === "boolean" ? v : JSON.stringify(v));
  }
  const r = await pool.query(
    `update review_standards set ${sets.join(",")} where id=$1 and (user_id=$2 or built_in) returning id`, vals);
  return r.rows[0] ?? null;
}

export async function deleteStandard(userId: string, standardId: string) {
  const r = await pool.query(`delete from review_standards where id=$1 and (user_id=$2 or built_in) returning id`, [standardId, userId]);
  return r.rows[0] ?? null;
}

export async function setDefaultStandard(userId: string, standardId: string, isDefault: boolean) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (isDefault) await client.query(`update review_standards set is_default=false where user_id=$1`, [userId]);
    const r = await client.query(
      `update review_standards set is_default=$2 where id=$1 and (user_id=$3 or built_in)`, [standardId, isDefault, userId]);
    // 目标不存在时原来直接 commit → "设置成功"但原有默认已被清空, 用户从此悄悄退回 7 维默认
    if (!(r.rowCount ?? 0)) { await client.query("rollback"); return null; }
    await client.query("commit");
    return { ok: true };
  } catch (e) { await client.query("rollback"); throw e; }
  finally { client.release(); }
}

/** 评分标准 → AI 解析维度(带权重/评分标准) */
export async function parseStandardText(text: string) {
  // R9c: JSON 解析失败重试 1 次, 仍失败返回可读错误(不裸 500)
  const run = async () => {
    const ans = await llmJson(`你是学术期刊编辑。把一份论文评分标准/审稿要点解析为结构化维度, 输出 JSON:
{"dimensions":[{"key":"snake_case","name":"维度名","weight":0.0-1.0,"criteria":"评分细则","min":0,"max":100}]}

原文:
${text.slice(0, 6000)}`, undefined, 3000, 0.2);
    if (!Array.isArray(ans?.dimensions)) return null;
    return { dimensions: ans.dimensions.slice(0, 12) };
  };
  const first = await run();
  if (first) return first;
  const retry = await run();
  if (retry) return retry;
  return { dimensions: [], error: "AI 解析失败(JSON 格式无效), 请稍后重试或换一段更规范的原文" };
}

// ═══ Word 批注导出(SocialSci P0-3 补漏: export-report) ═══
// 依赖: .venv-fmtcheck python-docx(与 format-docx 同通道); 失败降级 HTML(前端 @media print)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const execFileAsync = promisify(execFile);
const DOCX_PYTHON = path.resolve(process.cwd(), ".venv-fmtcheck", "Scripts", "python.exe");
const ANNOT_SCRIPT = path.resolve(process.cwd(), "scripts", "review_annotations.py");

/** 把审稿结果转成 Word 批注 docx(base64 返回, 前端下载) */
export async function exportReportWord(userId: string, jobId: string): Promise<{ ok: boolean; base64?: string; fileName?: string; error?: string }> {
  const job = await getReviewJob(userId, jobId);
  if (!job) return { ok: false, error: "审稿任务不存在" };
  const res = job.result;
  if (!res) return { ok: false, error: "审稿尚未完成, 无报告可导出" };

  const text = job.text_snapshot || "";
  // 生成批注清单: 维度问题→批注; major/minor issues→批注
  const comments: Array<{ range: { start: number; end: number }; author: string; text: string }> = [];
  const dims = res.dimensions ?? [];
  for (const d of dims) {
    if (d.issues?.length) {
      for (const iss of (Array.isArray(d.issues) ? d.issues : []).slice(0, 5)) {
        const s = typeof iss === "string" ? iss : JSON.stringify(iss);
        comments.push({ range: { start: 0, end: Math.min(40, text.length) }, author: "AI审稿", text: `[${d.name ?? ""}] ${s.slice(0, 200)}` });
      }
    }
    if (d.comment) comments.push({ range: { start: 0, end: Math.min(40, text.length) }, author: "AI审稿", text: `[${d.name ?? ""} ${d.score ?? ""}分] ${String(d.comment).slice(0, 200)}` });
  }
  for (const m of (res.majorIssues ?? []).slice(0, 10)) {
    comments.push({ range: { start: 0, end: Math.min(40, text.length) }, author: "AI审稿·大修", text: `${String(m.title ?? "")}: ${String(m.detail ?? "").slice(0, 250)}` });
  }
  for (const m of (res.minorIssues ?? []).slice(0, 10)) {
    comments.push({ range: { start: 0, end: Math.min(40, text.length) }, author: "AI审稿·小修", text: `${String(m.title ?? "")}: ${String(m.detail ?? "").slice(0, 200)}` });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-export-"));
  const inPath = path.join(tmpDir, "input.json");
  const outPath = path.join(tmpDir, "review.docx");
  fs.writeFileSync(inPath, JSON.stringify({ text, comments, title: `审稿报告 · ${res.paperTitle ?? job.title ?? "未命名"}` }), "utf-8");
  try {
    const py = fs.existsSync(DOCX_PYTHON) ? DOCX_PYTHON : "python";
    await execFileAsync(py, [ANNOT_SCRIPT, inPath, outPath], { timeout: 120_000, windowsHide: true, cwd: process.cwd() });
    const buf = fs.readFileSync(outPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { ok: true, base64: buf.toString("base64"), fileName: `审稿报告_${(res.paperTitle ?? "unnamed").slice(0, 24)}.docx` };
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { ok: false, error: `Word 导出失败: ${String(e).slice(0, 150)}(可改用打印/存PDF)` };
  }
}

// ═══ T6: 审稿排版 HTML 报告导出(对齐闭源 export-report 语义) ═══
// 闭源 POST /review/export-report → 服务端渲染完整排版 HTML(标题/总分大字/总评/维度卡/批注),
// 供打印/存 PDF; 我方 Word 批注导出之外的第二种报告形态
export async function exportReportHtml(userId: string, jobId: string): Promise<{ ok: boolean; html?: string; error?: string }> {
  const job = await getReviewJob(userId, jobId);
  if (!job) return { ok: false, error: "审稿任务不存在" };
  const res = job.result_json ? (typeof job.result_json === "string" ? JSON.parse(job.result_json) : job.result_json) : null;
  if (!res) return { ok: false, error: "审稿结果为空(任务未完成)" };
  const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const dims = (res.dimensions ?? []).filter((d: Record<string, unknown>) => d && typeof d === "object");
  const anns = (res.annotations ?? []).filter((a: Record<string, unknown>) => a && typeof a === "object");
  const majors = (res.majorIssues ?? []).slice(0, 12);
  const minors = (res.minorIssues ?? []).slice(0, 12);
  const highlights = res.highlights ?? [];
  const dimRows = dims.map((d: Record<string, unknown>) => {
    const issueLis = (Array.isArray(d.issues) ? d.issues : []).slice(0, 6).map((iss: unknown) => {
      if (typeof iss === "string") return `<li>${esc(iss)}</li>`;
      const o = iss as Record<string, unknown>;
      return `<li><b>[${esc(o.severity ?? "suggestion")}]</b> ${o.location ? `<i>(${esc(o.location)})</i> ` : ""}${esc(o.suggestion || o.originalText || "")}</li>`;
    }).join("");
    const gradeCls = (Number(d.score) ?? 0) >= 80 ? "#1e7d34" : Number(d.score) >= 60 ? "#b7791f" : "#c0392b";
    return `<div class="dim"><h3>${esc(d.name)} <span class="score" style="color:${gradeCls}">${esc(d.score)}/${esc(d.maxScore ?? 100)}</span></h3>
      ${d.summary ? `<p class="dim-comment">${esc(d.summary)}</p>` : ""}
      ${issueLis ? `<ul class="issues">${issueLis}</ul>` : ""}</div>`;
  }).join("");
  const annRows = anns.map((a: Record<string, unknown>) =>
    `<div class="ann"><b>${esc(a.type ?? "info").toUpperCase()}</b> ${a.dimension ? `<span class="loc">${esc(a.dimension)}</span>` : ""}
     ${a.highlightText ? `<div class="hl-text">“${esc(a.highlightText)}”</div>` : ""}
     ${a.comment ? `<div>${esc(a.comment)}</div>` : ""}</div>`).join("");
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>审稿报告</title><style>
  body{font-family:'PingFang SC','Microsoft YaHei',sans-serif;max-width:800px;margin:0 auto;padding:40px 30px;color:#333;line-height:1.8;font-size:14px}
  h1{text-align:center;font-size:22px;margin-bottom:8px;color:#1a365d}
  .meta{text-align:center;font-size:13px;color:#888;margin-bottom:30px}
  .score-box{text-align:center;margin:24px 0}
  .score-num{font-size:48px;font-weight:bold;color:#1a365d}
  .score-grade{font-size:18px;color:#666;margin-top:4px}
  .overall-comment{background:#f8f9fa;padding:16px 20px;border-radius:6px;margin:16px 0}
  .section{margin:30px 0}
  h2{color:#1a365d;border-bottom:2px solid #eee;padding-bottom:6px;font-size:17px}
  .dim{border:1px solid #e5e0d8;border-radius:6px;padding:14px 16px;margin:10px 0;break-inside:avoid}
  .dim h3{margin:0 0 6px;font-size:15px;color:#222}
  .score{font-weight:normal;font-size:13px}
  .dim-comment{color:#555;margin:0 0 8px}
  .issues{margin:6px 0 0;padding-left:20px;color:#444}
  .ann{border-left:3px solid #1e4d8c;padding:8px 12px;margin:8px 0;background:#fafcff;border-radius:0 4px 4px 0}
  .hl-text{color:#666;font-style:italic;margin:4px 0}
  .loc{color:#666;font-style:italic;background:#fefce8;padding:0 4px;border-radius:3px;font-size:12px}
  .pill{display:inline-block;background:#eef;padding:2px 10px;border-radius:12px;margin:3px;font-size:12px;color:#335}
  @media print{body{padding:10px}}
  </style></head><body>
  <h1>${esc(res.paperTitle ?? "审稿报告")}</h1>
  <div class="meta">全文 ${esc(res.wordCount ?? 0)} 字 · ${esc(res.grade ?? "")} 档 · ${new Date().toLocaleDateString("zh-CN")} 审</div>
  <div class="score-box"><div class="score-num">${esc(res.overallScore ?? 0)}</div><div class="score-grade">等级 ${esc(res.grade ?? "—")}</div></div>
  <div class="overall-comment"><b>总体评语</b><br>${esc(res.overallComment ?? res.overall ?? "")}</div>
  <div class="section"><h2>维度评分</h2>${dimRows || "<p>无维度数据</p>"}</div>
  ${annRows ? `<div class="section"><h2>正文批注 (${anns.length})</h2>${annRows}</div>` : ""}
  ${(majors.length || minors.length) ? `<div class="section"><h2>问题清单</h2>
    ${majors.length ? `<h3>大修 (${majors.length})</h3><ul class="issues">${majors.map((m: Record<string, unknown>) => `<li><b>${esc(m.title ?? "")}</b> — ${esc(m.detail ?? "")}</li>`).join("")}</ul>` : ""}
    ${minors.length ? `<h3>小修 (${minors.length})</h3><ul class="issues">${minors.map((m: Record<string, unknown>) => `<li><b>${esc(m.title ?? "")}</b> — ${esc(m.detail ?? "")}</li>`).join("")}</ul>` : ""}
  </div>` : ""}
  ${highlights.length ? `<div class="section"><h2>论文亮点</h2>${highlights.map((h: unknown) => `<span class="pill">${esc(h)}</span>`).join("")}</div>` : ""}
  </body></html>`;
  return { ok: true, html };
}
