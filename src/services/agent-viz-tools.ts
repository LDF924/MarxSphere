// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// agent-viz-tools.ts — V420: 「成果可视化工坊」(科研绘图)能力工具化。
//
// 由来(2026-09-29): 可视化是继写作舱之后**第二个在对话侧零覆盖**的模块 ——
//   后端 /api/viz/* 的建任务/列表/详情/数据集/取消/重试/数据源/产物转素材/模型选择
//   九项能力齐全, 前端(VizChatPanelV2 / VizView)也接满了, 但 agent 工具 0 个:
//   用户在对话里说"把这份数据画成柱状图", AI 既看不见手上的 CSV, 也画不出图。
//
// ## 为什么直连 service, 不走自家 HTTP 端点(与 agent-view-tools.ts V419 同一条链)
//   `AgentToolDef.run(args)` 的签名里**没有调用者的 token**, 而 /api/viz/* 里除了
//   GET /api/llm/models 之外**每一条都挂了 requireUser** —— 服务器对自己的 fetch 不带
//   Authorization, 实测返回 `401 未登录`。调用者身份只能从 currentUserId() 取
//   (server 的 handler 把它包进了 AsyncLocalStorage; 后台任务里没有, 返回 undefined)。
//
// ## 会话复用(这是建任务绕不开的一步)
//   createVizJob 第一步就校验 `viz_sessions(id, user_id)` 存在, 不存在直接 404。
//   对话里没人会去报一个 sessionId, 所以这里先 createSession 再建任务, 并把新会话 id
//   回给模型 —— 同一话题继续出图时带上它, 会话标题与消息流才是连贯的一条。
//
// ## 出图是后台跑, 这条工具不会等到图画完
//   与 `view_task_create` 同一形态(risk:"safe" + fire-and-forget): createVizJob 内部
//   `void (async () => ...)` 自行执行, SSE 断开也照跑。工具立刻返回 job id,
//   模型必须再调 view_viz_job 轮询 —— 这一点写在描述里, 免得模型以为返回即完成。
import type { AgentToolDef } from "./agent-tool-router.js";
import { currentUserId } from "./request-context.js";

/** 安全地执行服务调用, 异常兜底为可读文本（不抛断工具循环） */
async function safeCall(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e: any) {
    return `（成果可视化工坊不可用: ${String(e?.message || e).slice(0, 200)}）`;
  }
}

/**
 * 绘图产物路径 → blob-store 对象 key。
 *
 * 与 viz-exec-service.readVizFile 里那段内联归一化**同语义**(去前导 /、去历史 `data/` 前缀),
 * 差别只在于它按 `/viz-files/<uid>/` 这个 marker 切路径、拿不到 marker 就返回 null。
 * 库里的落库形状实测是 `viz-files/<uid>/<hash>.png`(47 行产物 36 行带 data/ 前缀、
 * 11 行裸写), **没有前导斜杠** —— 拿原值去调 readVizFile 会因找不到 `/viz-files/<uid>/`
 * 而一律返回 null, 于是"产物存在却读不出来"。所以这里直接按 key 取, 不再绕那一圈。
 */
function relToKey(rel: string): string {
  return String(rel ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^data\//, "");
}

/**
 * 读取某用户的 viz 产物字节。
 *
 * ⚠ 这里**刻意不走 viz-exec-service.readVizFile** —— 实测它对无 `data/` 前缀的产物一律返回 null:
 *   它先 `replace(/^\/+/,"")` 去掉前导斜杠, 再用 `/viz-files/<uid>/`(带前导斜杠)去 indexOf,
 *   于是 `viz-files/<uid>/x.png` 找不到该 marker → null。库里 47 行产物有 **36 行带 `data/` 前缀、
 *   11 行是裸 key**(现版本落的就是裸 key), 那 11 行的 /api/viz/files 地址是 404。
 *   这里只做归一化后按 key 取, 两种形状都能读到。
 */
async function readVizArtifact(rel: string, userId: string): Promise<Buffer | null> {
  const key = relToKey(rel);
  // ⚠ 判据必须是 startsWith, **不能**是 `includes("/viz-files/…")` —— 归一化已经把前导斜杠去掉了,
  //   拿带斜杠的 marker 去 includes 永远不命中(readVizFile 的 bug 正是这一条; 我自己的第一版守卫
  //   原样又犯了一次, 是探针打出来的: 产物明明在磁盘上(123444 字节), 工具却说"读不到")。
  if (!key.startsWith(`viz-files/${userId}/`)) return null;
  const { getObject } = await import("./blob-store.js");
  return getObject(key);
}

/**
 * 绘图产物的落盘位置(「取产物」能给出什么)。
 *
 * 本系统**没有"另存到自定义目录"这种导出接口** —— 前端的「导出为图片 / SVG」是浏览器端
 * 把 /api/viz/files/<rel> 的字节存成下载文件(web/socialsci-vue/src/views/viz/VizView.vue:314-376)。
 * 对话侧等价的能力就是"把字节取出来落到某个路径", 所以这里: 本地驱动直接给绝对路径,
 * 对象存储驱动落一份到 DATA_DIR/exports/viz/ 再给。
 */
async function exportVizArtifact(rel: string, userId: string, ext: "png" | "svg"): Promise<{ localPath: string | null; bytes: number } | { error: string }> {
  const buf = await readVizArtifact(rel, userId);
  if (!buf) return { error: `产物文件读不到(${String(rel).slice(0, 60)} — 可能已被清理, 或不是本用户的)` };
  const key = relToKey(rel);
  const { objectLocalPath } = await import("./blob-store.js");
  const direct = objectLocalPath(key);
  if (direct) return { localPath: direct, bytes: buf.length };
  const { dataPath } = await import("./storage-paths.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = dataPath("exports", "viz");
  mkdirSync(dir, { recursive: true });
  const name = key.split("/").pop() || `artifact.${ext}`;
  // 归一化后 pop 出来的是 `4d9d6e3c3259.png`(实测); 真没有扩展名时按调用方给的补一个,
  //   免得导出目录里多出一堆无后缀文件
  const out = join(dir, name.includes(".") ? name : `${name}.${ext}`);
  writeFileSync(out, buf);
  return { localPath: out, bytes: buf.length };
}

interface VizArtifactRow {
  id: string; session_id: string; version: number; prompt: string;
  png_path: string; svg_editable_path: string;
}

/**
 * 定位一张绘图产物(按 id, 或按 jobId + 版本; 归属一律用 user_id 过滤)。
 *
 * ⚠ 为什么不能只收 artifactId(端点 /api/viz/artifacts/:id/to-materials 的契约是那样):
 *   `getVizJob` 的 `result.charts[]` **不含产物的行 id**(只有 png/svg/caption/chartVersionId/
 *   figureId...) —— 对话里模型从 view_viz_job 拿不到那个 id, 给不出参数的工具等于没有。
 *   而 viz_artifacts 的版本号是**会话级**的(`unique (session_id, version)`), 与 view_viz_job
 *   显示的 `chartVersionId` 同一个数, 所以 (jobId → 该会话) + version 能唯一定位。
 */
async function resolveVizArtifact(uid: string, args: { artifactId?: string; jobId?: string; version?: string }): Promise<VizArtifactRow | { error: string }> {
  const { pool } = await import("../db/pool.js");
  const artifactId = String(args.artifactId ?? "").trim();
  if (artifactId) {
    const r = await pool.query<VizArtifactRow>(
      `select id, session_id, version, prompt, png_path, svg_editable_path from viz_artifacts where id=$1 and user_id=$2`,
      [artifactId, uid]);
    return r.rows[0] ?? { error: `（绘图产物不存在或不属于你: ${artifactId.slice(0, 8)}…）` };
  }
  const jobId = String(args.jobId ?? "").trim();
  if (!jobId) return { error: "（需要 jobId(或用 artifactId)—— 用 view_viz_jobs 查任务 id）" };
  const job = await pool.query<{ session_id: string }>(`select session_id from viz_jobs where id=$1 and user_id=$2`, [jobId, uid]);
  if (!job.rows.length) return { error: `（任务 ${jobId.slice(0, 8)}… 不存在或不属于你）` };
  const version = Number(args.version);
  const r = await pool.query<VizArtifactRow>(
    `select id, session_id, version, prompt, png_path, svg_editable_path from viz_artifacts
      where session_id=$1 and user_id=$2 ${Number.isFinite(version) && version > 0 ? "and version=$3" : ""}
      order by version desc limit 1`,
    Number.isFinite(version) && version > 0 ? [job.rows[0].session_id, uid, version] : [job.rows[0].session_id, uid]);
  return r.rows[0] ?? { error: `（任务 ${jobId.slice(0, 8)}… 还没有产物图${Number.isFinite(version) && version > 0 ? `(没有 v${version} 这一版)` : ""} —— 它可能还在绘制中或已失败, 用 view_viz_job 确认）` };
}

/** 任务状态 → 中文(与前端的六态一致) */
const JOB_STATUS_CN: Record<string, string> = {
  queued: "排队中", running: "绘制中", done: "已完成", failed: "失败", cancelled: "已取消",
};

/**
 * 缺省期刊规范。由前端默认值搬来 —— 那是**产品默认**(Nature 单栏 89mm/600dpi/7pt),
 * 抄在这里是为了"省略 journal 参数时不退化成裸 matplotlib 尺寸"。
 * 真源: web/socialsci-vue/src/views/viz/vizApi.ts 的 DEFAULT_JOURNAL_CONFIG。
 */
const DEFAULT_JOURNAL_CONFIG: Record<string, unknown> = {
  journal: "nature", layout: "single-column", colorScheme: "nature-default",
  dpi: 600, fontSize: 7, fontFamily: "Arial",
  axisLineWidth: 0.8, dataLineWidth: 1, widthMm: 89, heightMm: 62.3,
};

/**
 * 解析一个真实属于该用户的绘图会话 id; 给不出就建一个新的。
 * 与 server.ts 的 POST /api/viz/jobs(createVizJob 第一步查 viz_sessions)同一约束。
 */
async function resolveSessionId(uid: string, sessionId: string, title: string): Promise<{ sessionId: string; created: boolean }> {
  const { createSession, listSessions } = await import("./viz-agent-service.js");
  const want = sessionId.trim();
  if (want) {
    const all = await listSessions(uid) as Array<Record<string, unknown>>;
    if (all.some((s) => String(s.id) === want)) return { sessionId: want, created: false };
  }
  const r = await createSession(uid, title.slice(0, 40) || "对话绘图");
  return { sessionId: r.id, created: true };
}

/** 把 projectId 解析成"某个真实属于该用户的项目"(与 agent-view-tools 的 resolveProject 同规则) */
async function resolveProject(projectId: string): Promise<{ uid: string; projectId: string; title: string } | { error: string }> {
  const uid = currentUserId();
  if (!uid) return { error: "（需要登录身份 — 对话触发的工具会带上传入者身份; 后台任务里没有）" };
  const { listProjects } = await import("./research-pipeline-service.js");
  const all = await listProjects(uid) as Array<Record<string, unknown>>;
  const active = all.filter((p) => p.status !== "archived");
  if (!active.length) return { error: "【研究项目】还没有项目。到「研途写作舱 → 选题界定」建一个, 或把图留在工坊里。" };
  const id = projectId.trim();
  if (id) {
    const hit = active.find((p) => String(p.id) === id);
    if (!hit) return { error: `（项目 ${id.slice(0, 8)}… 不在你的活跃项目里 — 先用 view_research_projects 查 id）` };
    return { uid, projectId: id, title: String(hit.title ?? "(无题)") };
  }
  const first = active[0];
  return { uid, projectId: String(first.id), title: String(first.title ?? "(无题)") };
}

// ═════════════════════════════════════════════════════════════════════════════
// 绘图产物地址: 库里存的是 blob key(`viz-files/<uid>/<hash>.png`), 浏览器要的是
// `/api/viz/files/<key>`。**只给 key 不给 URL 的话, 模型多半会拼错**(前车之鉴: 前端
// 曾因 px 前缀与裸 base64 三种形状混用而渲染空白)。
// ═════════════════════════════════════════════════════════════════════════════
function artifactUrl(rel: unknown): string | null {
  const s = String(rel ?? "");
  return s ? `/api/viz/files/${s}` : null;
}

export const VIZ_TOOLS: AgentToolDef[] = [
  // ─────────────────────────────────────────────────────────────────────────────
  // 工具注释约定(派单方要求): 每条工具喊一声「这条要不要算写工具」——
  //   判据与既有清单一致: 会改**用户已有数据/产物**的才算写。
  //   (本文件只声明, 不改 WRITE_TOOLS / TOOL_MIN_ROLE —— 那两个集合由派单方接线。)
  // ─────────────────────────────────────────────────────────────────────────────

  {
    // 写/执行: **算写工具**。会烧 LLM(规划→出图→自审→修订三段, viz 角色)、跑 Python 渲染、
    //   往 viz_jobs / viz_events / viz_artifacts 落库。与 view_task_create / chart_template
    //   同档(risk:"safe" + 后台自跑), 但只读会话(评审)不该拿到它 —— 请登记进 WRITE_TOOLS。
    name: "viz_job_create", label: "建绘图任务", risk: "safe",
    description:
      "「成果可视化工坊」出图: 用自然语言描述要画的图, 系统规划→出图→自审修订→落盘 PNG+SVG。" +
      "可选绑定一份已上传数据文件(fileId, 用 view_viz_data_files 查)或直接给 csv 文本; 不绑数据则画概念/示意图。" +
      "⚠ 任务是**后台自跑**的: 本工具立刻返回 jobId, 不会等到图画完 —— 之后用 view_viz_job 轮询看结果。",
    params: {
      message: { type: "string", required: true, desc: "要画什么(自然语言), 如「按地区分组画村集体收入柱状图, 比较引入工商资本前后」" },
      fileId: { type: "string", desc: "数据源文件 id(工坊上传的表格; 先调 view_viz_data_files 查)。省略且无 csv 则画示意/概念图" },
      csv: { type: "string", desc: "直接给数据(首行表头)。与 fileId 二选一, fileId 优先" },
      columnOrder: { type: "string", desc: "csv 的列名顺序, 逗号分隔(给了 csv 时应一起给; 服务端按 fileId 取数时会自行解析)" },
      sessionId: { type: "string", desc: "续用某个绘图会话; 省略则自动新建一个(会话里的数据源与上下文会延续)" },
      journal: { type: "string", desc: "期刊/版式预设: nature-single(默认) / nature-double / science-single / ieee-double / cn-core(中文核心) / slide(汇报用图)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return "（需要登录身份 — 对话触发的工具会带上传入者身份; 后台任务里没有）";
      const message = String(a.message ?? "").trim();
      if (!message) return "（需要 message: 说明要画什么图）";

      // 期刊预设 → journalConfig。键名与前端 JOURNAL_PRESETS 一致(见 VizChatPanelV2.vue:129);
      // 不认识的键按自定义处理, 把原值当 journal 名带上, 而不是静默丢掉。
      const JOURNAL_PRESETS: Record<string, Record<string, unknown>> = {
        "nature-single": { journal: "nature", layout: "single-column", widthMm: 89, heightMm: 62.3, dpi: 600, fontSize: 7, fontFamily: "Arial" },
        "nature-double": { journal: "nature", layout: "double-column", widthMm: 183, heightMm: 120, dpi: 600, fontSize: 8, fontFamily: "Arial" },
        "science-single": { journal: "science", layout: "single-column", widthMm: 55, heightMm: 40, dpi: 600, fontSize: 6, fontFamily: "Arial" },
        "ieee-double": { journal: "ieee", layout: "double-column", widthMm: 88.9, heightMm: 60, dpi: 600, fontSize: 8, fontFamily: "Times New Roman" },
        "cn-core": { journal: "中文核心期刊", layout: "single-column", widthMm: 140, heightMm: 100, dpi: 300, fontSize: 9, fontFamily: "SimSun" },
        slide: { journal: "presentation", layout: "double-column", widthMm: 240, heightMm: 135, dpi: 150, fontSize: 12, fontFamily: "Microsoft YaHei" },
      };
      const presetKey = String(a.journal ?? "").trim();
      const journalConfig = presetKey
        ? { ...DEFAULT_JOURNAL_CONFIG, ...(JOURNAL_PRESETS[presetKey] ?? { journal: presetKey }) }
        : DEFAULT_JOURNAL_CONFIG;

      const { sessionId, created } = await resolveSessionId(uid, String(a.sessionId ?? ""), message);
      const { createVizJob } = await import("./viz-job-service.js");
      const columnOrder = String(a.columnOrder ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const r = await createVizJob(uid, sessionId, message, {
        fileId: a.fileId ? String(a.fileId) : undefined,
        csv: a.csv ? String(a.csv) : undefined,
        columnOrder: columnOrder.length ? columnOrder : undefined,
        journalConfig,
      });
      const src = a.fileId ? "已绑定数据文件(服务端按 id 取真实数据)" : a.csv ? "已绑定向内联 csv" : "**未绑定数据 = 示意/概念图, 数值非真实数据**";
      return [
        `【绘图任务已创建】${r.job_id}`,
        `会话: ${sessionId}${created ? "（本次新建; 同一话题继续出图时把它传回 sessionId）" : "（沿用）"}`,
        `数据来源: ${src}`,
        `期刊规范: ${journalConfig.journal} · ${journalConfig.widthMm}×${journalConfig.heightMm}mm · ${journalConfig.dpi}dpi`,
        `已开始后台绘制(规划→出图→自审修订, 通常 1-3 分钟)。请用 view_viz_job(jobId="${r.job_id}") 轮询结果, 或用 view_viz_jobs 看列表。`,
      ].join("\n");
    }),
  },
  {
    // 读: 只查列表, 不改任何东西 → 不算写工具。
    name: "view_viz_jobs", label: "绘图任务列表", risk: "safe",
    description: "列出「成果可视化工坊」最近的绘图任务(状态/图数/数据文件/失败原因)。用于看手上画过什么、拿到 jobId",
    params: {
      limit: { type: "number", desc: "返回条数(默认8, 上限20)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return "（需要登录身份 — 对话触发的工具会带上传入者身份; 后台任务里没有）";
      const { listVizJobs } = await import("./viz-job-service.js");
      const limit = Math.min(Math.max(Number(a.limit) || 8, 1), 20);
      const jobs = await listVizJobs(uid, limit) as Array<Record<string, unknown>>;
      if (!jobs.length) return "【绘图任务】还没有任务。用 viz_job_create 说一句要画什么就能开一张。";
      const rows = jobs.map((j, i) => {
        const err = (j.error ?? {}) as { userMessage?: string };
        const st = String(j.status ?? "?");
        return `${i + 1}. [${JOB_STATUS_CN[st] ?? st}] ${String(j.prompt ?? "(无题)").replace(/\s+/g, " ").slice(0, 50)}` +
          ` — ${j.chart_count ?? 0} 张图${j.file_name ? ` · 数据:${String(j.file_name).slice(0, 24)}` : " · 无数据源"}` +
          `${err.userMessage ? ` · ${String(err.userMessage).slice(0, 60)}` : ""}\n   ${String(j.id)} · ${String(j.created_at ?? "").slice(0, 16)}`;
      });
      return `【绘图任务】最近 ${jobs.length} 条\n` + rows.join("\n");
    }),
  },
  {
    // 读: 只查详情与产物清单, 不改 → 不算写工具。
    name: "view_viz_job", label: "绘图任务详情", risk: "safe",
    description: "查看某个绘图任务的状态与产物图(PNG/SVG 地址、生成的 Python 代码、图注与分析、是否用了真实数据)",
    params: {
      jobId: { type: "string", required: true, desc: "任务 id(来自 viz_job_create 或 view_viz_jobs)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return "（需要登录身份 — 对话触发的工具会带上传入者身份; 后台任务里没有）";
      const jobId = String(a.jobId ?? "").trim();
      if (!jobId) return "（需要 jobId）";
      const { getVizJob } = await import("./viz-job-service.js");
      const job = await getVizJob(uid, jobId) as Record<string, unknown> | null;
      if (!job) return `（任务 ${jobId.slice(0, 8)}… 不存在或不属于你 — 用 view_viz_jobs 查 id）`;
      const st = String(job.status ?? "?");
      const out: string[] = [`【绘图任务】${JOB_STATUS_CN[st] ?? st} · ${String(job.prompt ?? "").replace(/\s+/g, " ").slice(0, 80)}`];
      out.push(`id: ${String(job.id)} · 会话: ${String(job.session_id ?? "")}`);
      const err = (job.error ?? {}) as { userMessage?: string };
      if (err.userMessage) out.push(`失败原因: ${String(err.userMessage).slice(0, 200)}`);
      if (st === "queued" || st === "running") out.push("（还在绘制中 — 稍等一会儿再查一次）");
      const charts = ((job.result as { charts?: Array<Record<string, unknown>> } | undefined)?.charts ?? []);
      if (!charts.length) {
        if (st === "done") {
          /**
           * ⚠ 实测的坑: 出图失败的任务**状态仍是 done**。
           *
           * runTurn 在三次渲染都失败时只发 `sse.error` 然后照常 `send("done")`, 自己并不抛;
           * 于是 createVizJob 走的是成功分支 → setStatus(done) 且 `error=null`, 失败原因在任务行上
           * 被抹掉(实测事件流 #16 有 `CHART_FAILED: KeyError: '村集体收入均值'`, 而 job.error 是 null)。
           * 只报"没有产物图"会让人以为产物被清理了 —— 真正的原因在事件流里, 去把它捞出来。
           */
          const { pool } = await import("../db/pool.js");
          const ev = await pool.query(
            `select payload from viz_job_events where job_id=$1 and event='error' order by seq desc limit 1`, [jobId]);
          const why = (ev.rows[0]?.payload as { userMessage?: string } | undefined)?.userMessage;
          out.push(why
            ? `该任务**出图失败**(状态却标着已完成 — 见 runTurn 的收尾): ${String(why).slice(0, 200)}`
            : "该任务没有留下产物图(会话产物已被清理, 或出图未成功落盘)。");
        }
        return out.join("\n");
      }
      out.push(`产物 ${charts.length} 张(最近版本在前):`);
      charts.slice(0, 5).forEach((c, i) => {
        out.push(`${i + 1}. ${String(c.chartType || "图表")} · ${c.sampleData ? "⚠示意图(无真实数据)" : "真实数据"}` +
          ` · v${c.chartVersionId ?? "?"}${c.dataFile ? ` · 数据:${String(c.dataFile).slice(0, 24)}` : ""}`);
        if (c.caption) out.push(`   图注: ${String(c.caption).replace(/\s+/g, " ").slice(0, 120)}`);
        if (c.analysisText) out.push(`   分析: ${String(c.analysisText).replace(/\s+/g, " ").slice(0, 150)}`);
        if (c.png) out.push(`   PNG: ${String(c.png)}`);
        if (c.svg) out.push(`   SVG(可编辑): ${String(c.svg)}`);
        if (c.code) out.push(`   代码(前 200 字):\n     ${String(c.code).replace(/\n/g, "\n     ").slice(0, 200)}`);
      });
      // 给出可直接抄的参数(version 用第一张的 chartVersionId, 不要写死 1 —— 版本号是会话级的)
      const top = String(charts[0]?.chartVersionId ?? "1");
      out.push(`【下一步】取图/导出: viz_artifact_export(jobId="${String(job.id)}", version=${top})`);
      out.push(`存入写作舱素材库: viz_artifact_to_materials(jobId="${String(job.id)}", version=${top})`);
      return out.join("\n");
    }),
  },
  {
    // 读: 只回看该任务用了什么数据 → 不算写工具。
    name: "view_viz_job_dataset", label: "绘图任务数据集", risk: "safe",
    description: "回看某个绘图任务实际用的数据(列名与前若干行, 以及绑定的是哪个文件)。用于核对「这张图到底画的什么数」",
    params: {
      jobId: { type: "string", required: true, desc: "任务 id" },
      limit: { type: "number", desc: "预览行数(默认5, 上限20)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return "（需要登录身份 — 对话触发的工具会带上传入者身份; 后台任务里没有）";
      const jobId = String(a.jobId ?? "").trim();
      if (!jobId) return "（需要 jobId）";
      const { getVizJobDataset } = await import("./viz-job-service.js");
      const ds = await getVizJobDataset(uid, jobId, 200);
      if (!ds) return `（任务 ${jobId.slice(0, 8)}… 不存在或不属于你）`;
      if (ds.sampleData) {
        return `【数据集】该任务**没有绑定数据**(fileName=${ds.fileName || "无"}) —— 图是示意/概念图, 图上的数值不是真实统计值。要画真实数据, 先 view_viz_data_files 选一个文件再用 viz_job_create 带上 fileId。`;
      }
      const top = ds.rows.slice(0, Math.min(Math.max(Number(a.limit) || 5, 1), 20));
      const head = `【数据集】文件: ${ds.fileName || "(未知)"} · ${ds.columnOrder.length} 列 × ${ds.totalRows} 行`;
      const cols = ds.columnOrder.join(" | ");
      const body = top.map((r, i) => `${i + 1}. ${r.map((c) => String(c).slice(0, 20)).join(" | ")}`).join("\n");
      return `${head}\n${cols}\n${body}\n（仅预览前 ${top.length} 行, 共 ${ds.totalRows} 行）`;
    }),
  },
  {
    // 写: **算写工具**。不改产物字节, 但改用户已有任务的状态(而且前端要等它停下来)。
    //   派单方规则把「改既有 job」归到 review(需审批); 若嫌取消也要点一次批准太重,
    //   可降到 safe —— 它既不改数据也不删产物, 只把 status 置 cancelled。
    name: "viz_job_cancel", label: "取消绘图任务", risk: "review",
    description: "取消一个还在排队/绘制中的绘图任务(幂等: 已取消或已完成的任务调了也不出错)",
    params: {
      jobId: { type: "string", required: true, desc: "任务 id" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return "（需要登录身份 — 对话触发的工具会带上传入者身份; 后台任务里没有）";
      const jobId = String(a.jobId ?? "").trim();
      if (!jobId) return "（需要 jobId）";
      const { cancelVizJob } = await import("./viz-job-service.js");
      const ok = await cancelVizJob(uid, jobId);
      return ok
        ? `【已取消】任务 ${jobId} 的绘制已中断(已落盘的旧版本产物仍在, 用 view_viz_job 可看)。`
        : `（任务 ${jobId.slice(0, 8)}… 不存在、不属于你, 或已是终态 — 用 view_viz_job 确认状态）`;
    }),
  },
  {
    // 写: **算写工具**。会新建一个任务(再烧一次 LLM + Python)。同 viz_job_cancel 的 review 口径。
    name: "viz_job_retry", label: "重试绘图任务", risk: "review",
    description: "重试一个失败/已取消的绘图任务(沿用原提问与原数据源重跑一遍, 返回新任务 id)",
    params: {
      jobId: { type: "string", required: true, desc: "要重试的任务 id(须为 failed 或 cancelled 状态)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return "（需要登录身份 — 对话触发的工具会带上传入者身份; 后台任务里没有）";
      const jobId = String(a.jobId ?? "").trim();
      if (!jobId) return "（需要 jobId）";
      const { retryVizJob } = await import("./viz-job-service.js");
      const r = await retryVizJob(uid, jobId);
      if (!r) return `（任务 ${jobId.slice(0, 8)}… 不存在, 或状态不是 failed/cancelled —— 只有这两种能重试）`;
      return `【已重试】新任务 ${r.job_id}(沿用原提问与原数据源), 后台绘制中。用 view_viz_job(jobId="${r.job_id}") 轮询。`;
    }),
  },
  {
    // 读: 只列可选数据源 → 不算写工具。
    name: "view_viz_data_files", label: "绘图数据源列表", risk: "safe",
    description: "列出可用于绘图的已上传数据文件(表格类文件, 带行列数), 返回 fileId 供 viz_job_create 绑定",
    params: {
      limit: { type: "number", desc: "返回条数(默认10, 上限20)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return "（需要登录身份 — 对话触发的工具会带上传入者身份; 后台任务里没有）";
      const { listDataFiles } = await import("./viz-exec-service.js");
      const files = await listDataFiles(uid);
      if (!files.length) return "【数据源】还没有可用来绘图的表格文件 —— 到「成果可视化工坊」上传 CSV/Excel, 或把数据直接贴进对话(用 viz_job_create 的 csv 参数)。";
      const top = files.slice(0, Math.min(Math.max(Number(a.limit) || 10, 1), 20));
      const rows = top.map((f, i) => `${i + 1}. ${f.fileName.slice(0, 40)} — ${f.rowCount} 行 × ${f.colCount} 列\n   fileId: ${f.fileId}`);
      return `【绘图数据源】${top.length}/${files.length} 个\n` + rows.join("\n");
    }),
  },
  {
    // 写: **算写工具**。往用户的写作舱素材库插一条 figure(素材会被引到章节正文里)。
    //   派单方明确要求这条 review(且**必须传 userId**)。
    name: "viz_artifact_to_materials", label: "图表存入素材库", risk: "review",
    description: "把某张绘图产物存进研究项目的素材库(写作舱), 之后可在章节正文里引用它。给 jobId(默认取最新一版)或用 version 指定某一版",
    params: {
      jobId: { type: "string", desc: "绘图任务 id(来自 view_viz_job); 与 artifactId 二选一" },
      version: { type: "string", desc: "版本号(见 view_viz_job 的 chartVersionId); 省略取该任务最新一版" },
      artifactId: { type: "string", desc: "绘图产物行 id(已知时可直接给, 一般用不上)" },
      projectId: { type: "string", desc: "研究项目 id; 省略则用最近更新的那个项目" },
    },
    run: async (a) => safeCall(async () => {
      const ctx = await resolveProject(String(a.projectId ?? ""));
      if ("error" in ctx) return ctx.error;
      const art = await resolveVizArtifact(ctx.uid, { artifactId: String(a.artifactId ?? ""), jobId: String(a.jobId ?? ""), version: String(a.version ?? "") });
      if ("error" in art) return art.error;

      // 产物文件必须先能读到 —— 否则素材库里会多一条"点开是破图"的记录。
      // 读法见 readVizArtifact 的注释: 不走 readVizFile(它对裸 key 恒 null)。
      const pngBuf = art.png_path ? await readVizArtifact(art.png_path, ctx.uid).catch(() => null) : null;

      // 直连 service 而不是 POST /api/viz/artifacts/:id/to-materials —— 那个端点 requireUser。
      // 形状与 server.ts:11097 的处理器逐句对应(kind='figure' + meta.vizArtifact + sourceRef=产物 id,
      // 正文是 markdown 图片引用 + SVG 可编辑地址); 改端点时要同步改这里。
      const { createMaterial } = await import("./research-materials-service.js");
      const m = await createMaterial({
        projectId: ctx.projectId,
        userId: ctx.uid,
        kind: "figure",
        title: `${art.prompt.slice(0, 40) || "科研图表"} (v${art.version})`,
        contentMd: `![图表](${artifactUrl(art.png_path) ?? ""})\n\nSVG 可编辑: ${artifactUrl(art.svg_editable_path) ?? "无"}`,
        sourceRef: art.id,
        summary: art.prompt.slice(0, 200),
        imagePath: art.png_path,
        meta: { vizArtifact: art.id, version: art.version },
      });
      return `【已存入素材库】项目「${ctx.title}」新增图表素材 (v${art.version})` +
        `\n素材 id: ${m.id}${pngBuf ? ` · PNG ${pngBuf.length} 字节` : " · ⚠ 产物文件当前读不到, 打开可能是破图"}` +
        `\n到「研途写作舱 → 素材库」可见, 或在章节正文里引用。`;
    }),
  },
  {
    // 读: 只把已有产物字节读出来/给出路径, **不生成也不改动任何东西** → 不算写工具。
    //   (若派单方认为"往磁盘落一份副本"算副作用, 再把它挪进写名单 —— 它不碰任何用户数据行。)
    name: "viz_artifact_export", label: "取绘图产物", risk: "safe",
    description: "取出某张绘图产物的 PNG/SVG: 返回产物地址、可访问的图片 URL, 以及本地文件绝对路径(可直接交给 image_analyze/OCR/PDF 排版等需要文件路径的后续步骤)",
    params: {
      jobId: { type: "string", desc: "绘图任务 id(来自 view_viz_job); 与 artifactId 二选一" },
      version: { type: "string", desc: "版本号(见 view_viz_job 的 chartVersionId); 省略取该任务最新一版" },
      artifactId: { type: "string", desc: "绘图产物行 id(已知时可直接给, 一般用不上)" },
    },
    run: async (a) => safeCall(async () => {
      const uid = currentUserId();
      if (!uid) return "（需要登录身份 — 对话触发的工具会带上传入者身份; 后台任务里没有）";
      const art = await resolveVizArtifact(uid, { artifactId: String(a.artifactId ?? ""), jobId: String(a.jobId ?? ""), version: String(a.version ?? "") });
      if ("error" in art) return art.error;
      const out: string[] = [`【绘图产物】v${art.version} · ${art.prompt.replace(/\s+/g, " ").slice(0, 60)}`];
      for (const [ext, rel] of [["png", art.png_path], ["svg", art.svg_editable_path]] as Array<["png" | "svg", string]>) {
        if (!rel) { out.push(`${ext.toUpperCase()}: 无(该版本只落了 PNG)`); continue; }
        const exp = await exportVizArtifact(rel, uid, ext);
        if ("error" in exp) { out.push(`${ext.toUpperCase()}: ${exp.error}`); continue; }
        out.push(`${ext.toUpperCase()}: ${artifactUrl(rel)}`);
        out.push(`   本地路径: ${exp.localPath ?? "(对象存储驱动, 无本地路径 — 用上面的 URL 取)"} · ${exp.bytes} 字节`);
      }
      out.push("（图片 URL 需带登录令牌访问; 本地路径可直接交给需要文件路径的下一步）");
      return out.join("\n");
    }),
  },
  {
    // 读: 只列模型 → 不算写工具。
    name: "view_viz_models", label: "绘图模型列表", risk: "safe",
    description: "查看「成果可视化工坊」可用的绘图模型(viz 角色)与当前选中的那个。用于回答「现在用哪个模型画图」",
    params: {},
    run: async () => safeCall(async () => {
      const { LLM_MODEL_REGISTRY, isModelUsable, getRoleModel } = await import("./llm-model-registry.js");
      const current = getRoleModel("viz");
      const usable = LLM_MODEL_REGISTRY.filter((m) => isModelUsable(m.id));
      const line = (m: { id: string; label: string }, mark: string) =>
        `${mark} ${m.label}（${m.id}）`;
      const out = [`【绘图模型】当前: ${current}`];
      out.push(`可用 ${usable.length} 个:`);
      out.push(usable.slice(0, 10).map((m) => line(m, m.id === current ? "▸" : "·")).join("\n") || "（没有可用模型 — 对应 provider 的密钥未配置）");
      const unusable = LLM_MODEL_REGISTRY.filter((m) => !isModelUsable(m.id));
      if (unusable.length) out.push(`未配置密钥(不可用): ${unusable.map((m) => m.id).join(", ")}`);
      out.push("（切换绘图模型在「成果可视化工坊」面板里选; 对话侧不改模型配置）");
      return out.join("\n");
    }),
  },
];
