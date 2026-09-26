// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
/**
 * review-response-service.ts — 外部审稿意见的录入、拆条与逐条回应。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 由来(2026-09-26 全流程审计): 平台**没有"外部审稿意见"这个概念**。
 *
 * 三处看着像、逐一核过都不是:
 *   · `/api/review/*` 是**单向的"我方当审稿人"** —— 入参只有稿件全文
 *     (review-service.ts 的 `createPhase5Review({reviewText, ...})` 里没有放外部意见的位置),
 *     产出是我方给别人的报告;
 *   · `phase5_revise` 吃的是**系统自审报告**(`review_result`), 不是外审意见;
 *     而且报告里 `dimensions[].issues[]` 那些**逐条问题根本没进 prompt** ——
 *     送进去的只有 checks 的通过与否 + topSuggestions 的合并串;
 *   · 场景卡 S30「审稿意见回应」是**纯提示文案**, 指向用户本机的技能包, 平台侧零实现。
 *
 * 于是真实科研里最硬的一环缺失: 意见要**逐条**回应, 且"我没改"(responded/disagreed)
 * 与"我改了但没改到位"(revised) 是两回事 —— 编辑部要的正是这个区分。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 本文件提供四件事:
 *   ① 投稿记录(投了哪个刊/哪轮/什么状态);
 *   ② 意见录入 —— 粘贴一大段, 拆成条目(**启发式优先, LLM 兜底**);
 *   ③ 逐条状态机(待处理 → 已修改/已回应/不同意);
 *   ④ 生成回应信(给编辑部的"逐条回复", 这是投稿返修必交的材料)。
 *
 * ⚠ 落库而不是留在 localStorage: 参考产品那份"逐条复核"就只在 localStorage 里
 *   (ReviewView.vue), 换个浏览器就没了 —— 而这是要交给编辑部的材料。
 */
import { pool } from "../db/pool.js";
import { randomUUID } from "node:crypto";

async function assertOwned(userId: string, projectId: string): Promise<boolean> {
  const r = await pool.query(`select 1 from research_projects where id=$1 and user_id=$2`, [projectId, userId]);
  return r.rows.length > 0;
}

// ═══════════════════════════════════════════════════════════════
// ① 投稿记录
// ═══════════════════════════════════════════════════════════════

const SUB_STATUS = new Set(["submitted", "under_review", "revision_requested", "accepted", "rejected", "withdrawn"]);

export async function listSubmissions(userId: string, projectId: string) {
  if (!(await assertOwned(userId, projectId))) return null;
  const r = await pool.query(
    `select id, journal_name, submitted_on, status, note, round, created_at
       from research_submissions where project_id=$1 order by created_at desc`,
    [projectId]);
  return {
    submissions: r.rows.map((s) => ({
      id: String(s.id),
      journalName: String(s.journal_name ?? ""),
      // date 列 → 前端要的是 `YYYY-MM-DD`。用 toISOString() 会在 +08:00 下**退一天**
      //   (date 被 pg 解析成当地 00:00 再转 UTC) —— 投稿日期差一天是会被编辑部抓的。
      submittedOn: s.submitted_on ? toDateStr(s.submitted_on) : "",
      status: String(s.status ?? "submitted"),
      note: String(s.note ?? ""),
      round: Number(s.round ?? 1),
      createdAt: s.created_at,
    })),
  };
}

/** pg 的 date 列默认解析成 JS Date(当地 0 点) —— 取本地年月日, 不走 UTC */
function toDateStr(v: unknown): string {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v ?? "").slice(0, 10);
}

export interface SubmissionInput {
  id?: string; journalName?: string; submittedOn?: string; status?: string; note?: string; round?: number;
}

export async function saveSubmissions(
  userId: string, projectId: string, items: SubmissionInput[]
): Promise<{ ok: boolean; error?: string; submissions?: unknown[] }> {
  if (!(await assertOwned(userId, projectId))) return { ok: false, error: "项目不存在" };
  const clean = items.slice(0, 50);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const keep: string[] = [];
    for (const s of clean) {
      const journalName = String(s.journalName ?? "").slice(0, 200);
      const status = SUB_STATUS.has(String(s.status)) ? String(s.status) : "submitted";
      const note = String(s.note ?? "").slice(0, 2000);
      const round = Math.max(1, Math.min(99, Number(s.round) || 1));
      // 日期格式非法时存 null 而不是抛错: 用户可能正在输入(前端是逐字保存的),
      //   一个半截的 "2026-0" 不该把整次保存打回来。
      const on = /^\d{4}-\d{2}-\d{2}$/.test(String(s.submittedOn ?? "")) ? String(s.submittedOn) : null;
      if (s.id) {
        const upd = await client.query(
          `update research_submissions set journal_name=$3, submitted_on=$4, status=$5, note=$6, round=$7, updated_at=now()
            where id=$1 and project_id=$2 returning id`,
          [s.id, projectId, journalName, on, status, note, round]);
        if (upd.rows.length) { keep.push(String(s.id)); continue; }
      }
      const ins = await client.query(
        `insert into research_submissions (id, project_id, journal_name, submitted_on, status, note, round)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [randomUUID(), projectId, journalName, on, status, note, round]);
      if (ins.rows[0]) keep.push(String(ins.rows[0].id));
    }
    // 与假设台账同一套全量保存语义: 库里多出来的删掉, 这样"界面上删了"刷新后真的没了
    if (keep.length) {
      await client.query(`delete from research_submissions where project_id=$1 and id <> all($2::uuid[])`, [projectId, keep]);
    } else {
      await client.query(`delete from research_submissions where project_id=$1`, [projectId]);
    }
    await client.query("commit");
    return { ok: true, ...(await listSubmissions(userId, projectId)) ?? {} };
  } catch (e) {
    await client.query("rollback").catch(() => null);
    return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════════════════════════════
// ② 审稿意见条目
// ═══════════════════════════════════════════════════════════════

const KINDS = new Set(["revise", "question", "supplement", "reject"]);
const RESP_TYPES = new Set(["", "revised", "responded", "disagreed"]);

export interface ResponseInput {
  id?: string; round?: number; reviewerLabel?: string; seq?: number;
  kind?: string; quote?: string; comment?: string;
  response?: string; responseType?: string; status?: string; revisionRefs?: number[];
}

export async function listReviewResponses(userId: string, projectId: string, round?: number) {
  if (!(await assertOwned(userId, projectId))) return null;
  const args: unknown[] = [projectId];
  let where = "project_id=$1";
  if (Number.isInteger(round)) { args.push(round); where += ` and round=$${args.length}`; }
  const r = await pool.query(
    `select id, round, reviewer_label, seq, kind, quote, comment, response, response_type, status, revision_refs
       from research_review_responses where ${where} order by round, seq, created_at`,
    args);
  return {
    items: r.rows.map(mapItem),
    // 轮次列表单独给 —— 前端要一个"第几轮"的下拉, 不该让它自己从条目里推
    //   (某一轮可能一条都还没拆出来)
    rounds: await listRounds(projectId),
  };
}

async function listRounds(projectId: string): Promise<number[]> {
  const r = await pool.query(
    `select distinct round from research_review_responses where project_id=$1 order by round`, [projectId]);
  return r.rows.map((x) => Number(x.round));
}

function mapItem(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    round: Number(row.round ?? 1),
    reviewerLabel: String(row.reviewer_label ?? ""),
    seq: Number(row.seq ?? 0),
    kind: String(row.kind ?? "revise"),
    quote: String(row.quote ?? ""),
    comment: String(row.comment ?? ""),
    response: String(row.response ?? ""),
    responseType: String(row.response_type ?? ""),
    status: String(row.status ?? "pending"),
    revisionRefs: Array.isArray(row.revision_refs) ? (row.revision_refs as number[]).map(Number) : [],
  };
}

export async function saveReviewResponses(
  userId: string, projectId: string, items: ResponseInput[], round?: number
): Promise<{ ok: boolean; error?: string; items?: unknown[]; rounds?: number[] }> {
  if (!(await assertOwned(userId, projectId))) return { ok: false, error: "项目不存在" };
  const clean = items.slice(0, 300);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const keep: string[] = [];
    for (let i = 0; i < clean.length; i++) {
      const it = clean[i];
      const rd = Math.max(1, Math.min(99, Number(it.round) || Number(round) || 1));
      const kind = KINDS.has(String(it.kind)) ? String(it.kind) : "revise";
      const rt = RESP_TYPES.has(String(it.responseType)) ? String(it.responseType) : "";
      const response = String(it.response ?? "").slice(0, 8000);
      /**
       * status 由 response_type **推导**, 而不是让前端自己传。
       *
       * 为什么不信任前端传的 status: 这俩是一个事实的两个说法 —— 填了回应方式就是处理了,
       *   没填就是待处理。让两边各传各的, 迟早出现"已修改但状态是待处理"这种自相矛盾的行,
       *   而回应信的统计(处理 N/M 条)会跟着报错数。**派生字段就该派生**。
       */
      const status = rt ? "resolved" : "pending";
      const refs = Array.isArray(it.revisionRefs)
        ? it.revisionRefs.map(Number).filter((n) => Number.isInteger(n)).slice(0, 20)
        : [];
      const vals = [
        rd, String(it.reviewerLabel ?? "").slice(0, 100), Number.isInteger(it.seq) ? Number(it.seq) : i,
        kind, String(it.quote ?? "").slice(0, 2000), String(it.comment ?? "").slice(0, 8000),
        response, rt, status, refs,
      ];
      if (it.id) {
        const upd = await client.query(
          `update research_review_responses
              set round=$3, reviewer_label=$4, seq=$5, kind=$6, quote=$7, comment=$8,
                  response=$9, response_type=$10, status=$11, revision_refs=$12, updated_at=now()
            where id=$1 and project_id=$2 returning id`,
          [it.id, projectId, ...vals]);
        if (upd.rows.length) { keep.push(String(it.id)); continue; }
      }
      const ins = await client.query(
        `insert into research_review_responses
           (id, project_id, round, reviewer_label, seq, kind, quote, comment, response, response_type, status, revision_refs)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [randomUUID(), projectId, ...vals]);
      if (ins.rows[0]) keep.push(String(ins.rows[0].id));
    }
    if (keep.length) {
      await client.query(`delete from research_review_responses where project_id=$1 and id <> all($2::uuid[])`, [projectId, keep]);
    } else {
      await client.query(`delete from research_review_responses where project_id=$1`, [projectId]);
    }
    await client.query("commit");
    return { ok: true, ...(await listReviewResponses(userId, projectId, round)) ?? {} };
  } catch (e) {
    await client.query("rollback").catch(() => null);
    return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════════════════════════════
// ③ 粘贴的一大段 → 条目(启发式优先)
// ═══════════════════════════════════════════════════════════════

/**
 * 把一段审稿意见拆成条目。
 *
 * **为什么是启发式而不是 LLM**: 拆条是个**格式**问题不是**理解**问题, 而真实审稿意见
 * 的排版是高度规律的 —— 编号(1./①/一、/Comment 1)、分页、审稿人分节。启发式做得又准又即时,
 *   而 LLM 拆条会**改写原文**, 而原文是要原样引用给编辑部的("您指出『…』")。
 *   所以这里绝不改字, 只切分。
 *
 * 拆不干净时用户还能手改(前端是可编辑列表) —— 这比一个会篡改原文的 LLM 好得多。
 */
export function splitReviewComments(raw: string): Array<{ reviewerLabel: string; comment: string }> {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return [];

  const lines = text.split("\n");

  /** 审稿人分节标题: "审稿人1" / "Reviewer 2" / "外审专家A" / "编辑部意见" */
  const reviewerRe = /^\s*[【\[]?\s*(审稿人|外审专家|评审专家|编辑部|reviewer|referee)\s*([0-9一二三四五六七八九十A-Za-z]*)\s*[】\]]?\s*[:：]?\s*(意见|comments?)?\s*[:：]?\s*$/i;

  const blocks: Array<{ label: string; buf: string[] }> = [];
  let curLabel = "";
  let cur: string[] | null = null;

  const push = () => {
    if (cur && cur.join("\n").trim()) blocks.push({ label: curLabel, buf: cur });
    cur = null;
  };

  for (const line of lines) {
    if (reviewerRe.test(line)) { push(); curLabel = line.trim().replace(/[:：]\s*$/, ""); continue; }
    const stripped = stripItemPrefix(line);
    if (stripped !== null) {
      push();
      // 编号本身**不保留**在正文里 —— 序号由 seq 重新编, 保留会让"1. 1. 您指出"这种重复
      cur = [stripped];
      continue;
    }
    if (cur) cur.push(line);
    else if (line.trim()) cur = [line];   // 编号前的散句(如"感谢审稿意见, 现逐条回复如下")—— 单起一条, 不丢
  }
  push();

  /**
   * 没有命中任何编号时**整段当一条**。
   * 审稿人只写一段话是常态, 这时硬拆只会把一句话拦腰截断。
   */
  if (!blocks.length) return [{ reviewerLabel: "", comment: text.slice(0, 8000) }];

  return blocks
    .map((b) => ({ reviewerLabel: b.label, comment: b.buf.join("\n").trim() }))
    .filter((b) => b.comment)
    .slice(0, 300)
    // 单条过长多半是"编号判错了, 把整篇吞进第一条" —— 截断并在前端可编辑,
    //   好过让一条吃掉全文(前端表现为"只有一条意见")
    .map((b) => ({ ...b, comment: b.comment.slice(0, 8000) }));
}

/** 命中条目编号则返回**去掉编号后**的正文, 否则 null。 */
function stripItemPrefix(line: string): string | null {
  const s = line.replace(/^\s+/, "");
  /**
   * 加粗编号 `**1.**` / `**1**` / `__1.__` —— 必须**排在普通数字之前**判, 否则
   *   `**1.**` 会落到"点后接中文"那一支, 把 `**1.` 当成编号切掉, 留下 `** 标题过长`。
   *   实测过: 那一版的结果是**整行不拆**, 而且因为后面的条目拆开了, 总数看着没错 ——
   *   断言只看条数就会**假通过**(本仓管这叫"判据看不到被测对象")。
   */
  const bold = s.match(/^(?:\*\*|__)\s*(\d{1,3})\s*(?:[.、．])?\s*(?:\*\*|__)\s*/);
  if (bold) return s.slice(bold[0].length);
  // 括号编号: (1) （1） (一) （①）
  let m = s.match(/^[(（]\s*(?:\d{1,3}|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十]{1,3})\s*[)）]\s*/);
  if (m) return s.slice(m[0].length);
  // 圈号: ①②③
  m = s.match(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/);
  if (m) return s.slice(m[0].length);
  /**
   * 数字 + 点。**必须紧跟着空白或中文**, 否则 "3.5 的系数是…" 这种小数开头的续行
   *   会被误判成新条目, 把一条意见拦腰切断 —— 而切错的条目在界面上看着完全正常。
   *   `(?=\s|$|[一-龥])` 同时放过了中文里更常见的 "1.引言部分" (点后无空格)。
   */
  m = s.match(/^\d{1,3}\.(?=\s|$|[一-龥])/);
  if (m) return s.slice(m[0].length);
  // 中文顿号/句点、中文数字编号
  m = s.match(/^(\d{1,3}|[一二三四五六七八九十]{1,3})[、．]\s*/);
  if (m) return s.slice(m[0].length);
  // Comment 1 / 意见 1 / Q1
  m = s.match(/^(?:comment|comments|意见|问题|q)\s*\d{1,3}\s*[:：.、]?\s*/i);
  if (m) return s.slice(m[0].length);
  return null;
}

/** 落库一组拆好的条目(接在指定轮次) */
export async function importReviewComments(
  userId: string, projectId: string, raw: string, opts: { round?: number; reviewerLabel?: string } = {}
): Promise<{ ok: boolean; error?: string; added?: number; items?: unknown[]; rounds?: number[] }> {
  if (!(await assertOwned(userId, projectId))) return { ok: false, error: "项目不存在" };
  const parts = splitReviewComments(raw);
  if (!parts.length) return { ok: false, error: "没有解析出任何意见" };

  /**
   * 轮次: 调用方没给就取"当前最大轮 + 1"。
   * 不默认 1 —— 那会把第二轮的粘贴内容混进第一轮, 而轮次正是"这批意见对应哪一稿"的唯一凭据。
   */
  let round = Number(opts.round) || 0;
  if (!round) {
    const r = await pool.query(`select coalesce(max(round),0) as m from research_review_responses where project_id=$1`, [projectId]);
    const m = Number(r.rows[0]?.m ?? 0);
    // 库里空 → 第 1 轮; 否则接在最后一轮(同一轮再粘一次是"补几条", 不是新开一轮)
    round = m > 0 ? m : 1;
  }
  // 序接在已有之后, 不从头开始 —— 否则第二轮 import 会把序号与上一轮撞上
  const mx = await pool.query(
    `select coalesce(max(seq),-1) as m from research_review_responses where project_id=$1 and round=$2`, [projectId, round]);
  let seq = Number(mx.rows[0]?.m ?? -1) + 1;

  const client = await pool.connect();
  try {
    await client.query("begin");
    let added = 0;
    for (const p of parts) {
      /**
       * ⚠ 这里是 `||` 而**不是** `??` —— 两者在这件事上不等价, 而差别是静默的。
       *
       * 路由层没收到 reviewerLabel 时会传 `""`(不是 undefined), 于是
       * `opts.reviewerLabel ?? p.reviewerLabel` 取到的是那个**空串**, 永远落不到
       * 每条自己的标签上。症状: 粘贴时明明有「审稿人1 / 审稿人2」分节, 预览里也显示对了,
       * 落库后标签**全空** —— 而预览走的是 parts 直出, 不经过这条路径, 所以看着一切正常。
       * (探针就是这样抓到的: 预览对、库里空。)
       */
      const label = String(opts.reviewerLabel ?? "").trim() || p.reviewerLabel || "";
      await client.query(
        `insert into research_review_responses (id, project_id, round, reviewer_label, seq, kind, comment)
         values ($1,$2,$3,$4,$5,'revise',$6)`,
        [randomUUID(), projectId, round, label.slice(0, 100), seq++, p.comment]);
      added++;
    }
    await client.query("commit");
    return { ok: true, added, ...(await listReviewResponses(userId, projectId)) ?? {} };
  } catch (e) {
    await client.query("rollback").catch(() => null);
    return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════════════════════════════
// ④ 回应信 + 送进修订的输入通道
// ═══════════════════════════════════════════════════════════════

const KIND_CN: Record<string, string> = {
  revise: "修改类", question: "质疑类", supplement: "补充类", reject: "拒绝类",
};
const RESP_CN: Record<string, string> = {
  revised: "已修改", responded: "已回应", disagreed: "未采纳",
};

/**
 * 生成给编辑部的「逐条回复」。
 *
 * 三类呼应方式分开写, 因为编辑部要的正是这个区分:
 *   已修改 → 改了哪里; 已回应 → 为何这样处理; 未采纳 → 理由(这是最容易被追问的)。
 * 未处理的**也列出来并标注** —— 瞒着不写, 编辑一审就会发现少了一条。
 *
 * `projectId` 保留在签名里是为了与路由层的调用形状一致(将来若要往信头写项目信息),
 * 当前不参与渲染 —— 回应信是**交给外部**的文本, 不该带上内部 id。
 */
export function buildResponseLetter(items: ResponseInput[], projectId: string, title = ""): string {
  void projectId;
  const list = (items ?? []).slice().sort((a, b) => (Number(a.seq ?? 0) - Number(b.seq ?? 0)));
  const done = list.filter((i) => String(i.responseType ?? "")).length;
  const lines = [
    `# 审稿意见回复`,
    ``,
    title ? `稿件：${title}` : "",
    title ? "" : "",
    `共收到 ${list.length} 条意见，已处理 ${done} 条。`,
    "",
  ];
  const byRound = new Map<number, ResponseInput[]>();
  for (const it of list) {
    const r = Number(it.round ?? 1);
    byRound.set(r, [...(byRound.get(r) ?? []), it]);
  }
  for (const [round, arr] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`## 第 ${round} 轮`, "");
    let curLabel = "";
    for (const it of arr) {
      const label = String(it.reviewerLabel ?? "");
      if (label && label !== curLabel) { lines.push(`### ${label}`, ""); curLabel = label; }
      const seq = Number(it.seq ?? 0) + 1;
      lines.push(`**意见 ${seq}**（${KIND_CN[String(it.kind)] ?? "修改类"}）`, "");
      const quote = String(it.quote ?? "").trim();
      if (quote) lines.push(`> ${quote}`, "");
      lines.push(String(it.comment ?? "").trim() || "_(空)_", "");
      const rt = String(it.responseType ?? "");
      lines.push(`**回复**：${RESP_CN[rt] ?? "**尚未处理**"}`, "");
      const resp = String(it.response ?? "").trim();
      if (resp) lines.push(resp, "");
      const refs = (it.revisionRefs ?? []).filter((n) => Number.isInteger(n));
      if (refs.length) lines.push(`_(对应修订稿 v${refs.join(" / v")})_`, "");
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

/**
 * 把**已处理的**外部意见拼成送进 `phase5_revise` 的一段文本。
 *
 * 这是与既有 revise 分支的**唯一接口** —— 不改那条分支的 review 逻辑,
 * 只在它组装 prompt 时把这一段并进去。空列表返回空串, 调用方据此决定加不加。
 *
 * 只送"已修改/已回应"的: "未采纳"的意见若也塞进去, 模型会照着改 —— 而用户恰恰
 * 是不想改才标了未采纳。**这是最容易做错的一处**, 所以判据写在这里而不是调用方。
 */
export function buildRevisionInput(items: ResponseInput[]): string {
  const usable = (items ?? []).filter((i) => {
    const rt = String(i.responseType ?? "");
    return rt === "revised" || rt === "responded";
  });
  if (!usable.length) return "";
  const lines = usable
    .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))
    .map((it, i) => {
      const seq = Number(it.seq ?? 0) + 1;
      const parts = [`${i + 1}. 【${KIND_CN[String(it.kind)] ?? "修改类"}·意见${seq}】${String(it.comment ?? "").trim()}`];
      const resp = String(it.response ?? "").trim();
      if (resp) parts.push(`   作者已表态：${resp}`);
      return parts.join("\n");
    });
  return lines.join("\n");
}
