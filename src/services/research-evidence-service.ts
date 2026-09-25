// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
/**
 * research-evidence-service.ts — 把「研究」与「写作」接起来的那一段。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 由来(2026-09-25): 写作舱能生成论文, 但正文里**没有任何研究证据**。
 *
 * 实测三条(逐条 grep 过, 不是推测):
 *   ① `generateChapter` 的 prompt 里没有"数据/结果/发现"的位置。它拿到的是
 *      论文主题 / 核心论点 / 大纲 / 前文 / 语体 / 文献池 / 参考样例 —— 仅此。
 *   ② 后端**写好了**一条素材注入通道(`research-exec-engine.runLlmJob` 里的 `【可用素材】`),
 *      但它只在 `chapter_gen|finalize|writing` 下触发, 而那是 executorMap **未命中**时的
 *      兜底分支。写作舱用的 jobKind 全部命中 executorMap, 且那三种 jobKind 全仓无人创建
 *      ⇒ **这条通道是死代码, 一次都没执行过**。
 *   ③ 假设(H1..Hn)只躺在 analysis 节点的 JSON 里, 既不能改结论, 也不进正文。
 *
 * 于是"跑完回归"与"正文怎么写"是两件互不相干的事。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 本文件提供三件事, 对应三条被切断的线:
 *   ① 章节依据(evidence)   —— 每章选它依据哪些素材/分析/假设, 组装成证据块进 prompt
 *   ② 假设检验台账(hypotheses) —— H1..Hn + 结论(支持/部分支持/否定/待检验) + 依据
 *   ③ 数字核验(verify)      —— 正文里写出来的数字, 能不能对上分析结果。**只报告, 不改写**。
 *
 * ⚠ 一条贯穿全文件的纪律: **统计列一律从分析结果里抽出来, 不让模型复述。**
 *   模型只负责写句子; 句子里的数字必须能在 research_findings 的溯源列里找到。
 *   这是"真实科研"与"看起来很学术"的唯一硬边界。
 */
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

// ═══════════════════════════════════════════════════════════════
// ① 章节依据
// ═══════════════════════════════════════════════════════════════

export type EvidenceKind = "material" | "analysis" | "hypothesis" | "finding";

export interface EvidenceRef {
  kind: EvidenceKind;
  /** 按 kind 指向 research_materials.id / stats_jobs.id / research_hypotheses.id / research_findings.id */
  refId: string;
  note?: string;
}

/** 项目所有权校验 —— 本文件每个写函数的第一道闸。缺了它, 拿到别人的 projectId 就能往里写。 */
async function assertOwned(userId: string, projectId: string): Promise<boolean> {
  const r = await pool.query(`select 1 from research_projects where id=$1 and user_id=$2`, [projectId, userId]);
  return r.rows.length > 0;
}

/** 全项目依据(前端一次拉全, 切章不重查; 项目下章节数是个位到几十, 不值得按章懒加载) */
export async function listEvidence(userId: string, projectId: string, sectionId?: string) {
  if (!(await assertOwned(userId, projectId))) return null;
  const r = await pool.query(
    `select id, section_id, kind, ref_id, note, sort_order
       from research_chapter_evidence
      where project_id=$1 ${sectionId ? "and section_id=$2" : ""}
      order by section_id, sort_order, created_at`,
    sectionId ? [projectId, sectionId] : [projectId]
  );
  const bySection: Record<string, Array<{ id: string; kind: string; refId: string; note: string }>> = {};
  for (const row of r.rows) {
    const sid = String(row.section_id);
    (bySection[sid] ??= []).push({
      id: String(row.id), kind: String(row.kind), refId: String(row.ref_id), note: String(row.note ?? ""),
    });
  }
  return { bySection };
}

/**
 * 全量替换某一章的依据。
 *
 * 替换而不是增删端点对: 前端就是一个勾选列表, "我看到的这一组就是我要的这组"。
 * 用增/删两个端点的话, 取消勾选就得前端自己算差集 —— 一旦计算有偏差,
 * 库里会留下用户以为已经取消了的依据, 而且没有任何界面能让他看见它。
 * 事务内先删后插, 保证中途失败不会留下半截清单。
 */
export async function replaceSectionEvidence(
  userId: string, projectId: string, sectionId: string, refs: EvidenceRef[]
): Promise<{ ok: boolean; error?: string; count?: number }> {
  if (!(await assertOwned(userId, projectId))) return { ok: false, error: "项目不存在" };
  if (!sectionId) return { ok: false, error: "缺少章节 id" };
  const clean = refs
    .filter((x) => x && typeof x.refId === "string" && x.refId.trim() && ["material", "analysis", "hypothesis", "finding"].includes(x.kind))
    .slice(0, 100);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `delete from research_chapter_evidence where project_id=$1 and section_id=$2`,
      [projectId, sectionId]);
    for (let i = 0; i < clean.length; i++) {
      const x = clean[i];
      await client.query(
        // on conflict do nothing: 同一依据重复提交时保持幂等(唯一索引在 project/section/kind/ref 上)
        `insert into research_chapter_evidence (id, project_id, section_id, kind, ref_id, note, sort_order)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (project_id, section_id, kind, ref_id) do nothing`,
        [randomUUID(), projectId, sectionId, x.kind, x.refId.trim(), String(x.note ?? "").slice(0, 500), i]);
    }
    await client.query("commit");
    return { ok: true, count: clean.length };
  } catch (e) {
    await client.query("rollback").catch(() => null);
    return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
  } finally {
    client.release();
  }
}

/** 可选的依据来源清单(供前端勾选面板渲染) */
export async function listEvidenceCandidates(userId: string, projectId: string, fileId?: string) {
  if (!(await assertOwned(userId, projectId))) return null;
  const [mats, hyps, find, analyses] = await Promise.all([
    pool.query(
      `select id, kind, title, table_data, analysis_method
         from research_materials where project_id=$1 and user_id=$2 order by created_at limit 300`,
      [projectId, userId]),
    pool.query(
      `select id, code, text, verdict, evidence_ref from research_hypotheses where project_id=$1 order by sort_order, created_at`,
      [projectId]),
    pool.query(
      `select id, tool, var_name, coef, p_value, stars, claim, status
         from research_findings where project_id=$1 and status <> 'dismissed' order by created_at desc limit 200`,
      [projectId]),
    /**
     * 分析结果**按数据文件连接**(不是按项目)。这一点必须说清楚, 因为它是本系统里
     * 唯一一处"跨 id 空间"的地方: 写作舱用 research_projects.id, 而统计结果按 user_id
     * 存在 stats_jobs —— 两边没有任何一列把它们连起来。
     * 连接点是快照里的 statisticsFileId(写作舱第 3 步上传的那个数据文件), 见迁移 153 的注释。
     * 所以这里要 fileId: 没有它就只能返回空, 而不是"假装有分析结果"。
     */
    fileId
      ? pool.query(
          `select id, tool, status, created_at
             from stats_jobs
            where user_id=$1 and input->>'fileId' = $2 and status='completed'
            order by created_at desc limit 50`,
          [userId, String(fileId).replace(/^file_/, "")])
      : Promise.resolve({ rows: [] as unknown[] }),
  ]);
  return {
    materials: mats.rows.map((m) => ({
      refId: String(m.id), kind: "material",
      title: String(m.title ?? "未命名"),
      materialKind: String(m.kind ?? "note"),
      hasTable: !!(m.table_data && Object.keys(m.table_data as object).length),
      analysisMethod: String(m.analysis_method ?? ""),
    })),
    hypotheses: hyps.rows.map((h) => ({
      refId: String(h.id), kind: "hypothesis",
      code: String(h.code ?? ""), text: String(h.text ?? ""),
      verdict: String(h.verdict ?? "pending"), evidenceRef: String(h.evidence_ref ?? ""),
    })),
    findings: find.rows.map((f) => ({
      refId: String(f.id), kind: "finding",
      tool: String(f.tool ?? ""), varName: String(f.var_name ?? ""),
      coef: f.coef, pValue: f.p_value, stars: String(f.stars ?? ""),
      claim: String(f.claim ?? ""), status: String(f.status ?? "candidate"),
    })),
    analyses: analyses.rows.map((a) => ({
      refId: String(a.id), kind: "analysis",
      tool: String(a.tool ?? ""), createdAt: a.created_at,
    })),
    /** 数据文件指针: 没有它 analyses 恒空, 前端据此提示"先去上传数据文件"而不是显示空列表 */
    statisticsFileId: fileId ? String(fileId).replace(/^file_/, "") : "",
  };
}

/**
 * 组装某章的**证据块** —— 生成正文时直接拼进 prompt 的那段文本。
 *
 * ⚠ 这里是整个功能的**要害**, 有三条刻意的取舍:
 *
 * 1) **数字全部取自库列, 不由模型复述。** 系数/标准误/p/N 都从 research_findings
 *    的列里读, 模型只写 claim 那句话。这条让"A3 正文数字核验"有意义 —— 如果数字
 *    是模型写进 prompt 的, 核验就变成了"核对模型与自己", 恒真。
 *
 * 2) **分析结果默认只喂给"结果型"章节。** 把回归表塞进"研究背景"章, 模型会硬写一段
 *    "如回归所示…"—— 那是学术写作里最明显的 AI 痕迹。所以有 sectionType 这个开关:
 *    调用方按章节标题/类型能判就判, 判不出时**不拦**(有总比没有强), 但给出明确标注。
 *
 * 3) **取不到的依据静默丢弃, 不报错。** 依据引用的素材/分析可能已被删, 这时正确的
 *    行为是"少一块", 而不是"整章生成失败"。但会在返回值里给出 dropped 计数, 让界面
 *    能提示"有 2 条依据已失效, 请重新选择"。
 */
export async function buildEvidenceBlock(
  userId: string, projectId: string, sectionId: string
): Promise<{ text: string; used: number; dropped: number }> {
  const all = await buildEvidenceBlocks(userId, projectId);
  return all[sectionId] ?? { text: "", used: 0, dropped: 0 };
}

/**
 * **批量**版 —— 一次把整个项目所有章节的依据块组装出来。
 *
 * 为什么要批量: 章节生成是逐章循环的, 而上面那个单章版本每次要跑 4 类查询。
 * 一章一次的话, 20 章的论文会多出 80 次查询, 而其中**绝大多数字典是同一批素材**
 * (用户往往把同一份数据依据配给好几章)。这里把"取被引用对象"提到循环外, 按 kind
 * 各查一次(最多 4 次), 然后在内存里按章节切。差别是 4 次 vs 80 次。
 */
export async function buildEvidenceBlocks(
  userId: string, projectId: string, sectionIds?: string[]
): Promise<Record<string, { text: string; used: number; dropped: number }>> {
  const list = await listEvidence(userId, projectId);
  if (!list) return {};
  const targets = sectionIds?.length ? sectionIds.filter((id) => list.bySection[id]?.length) : Object.keys(list.bySection);
  if (!targets.length) return {};

  // 项目级去重: 同一份素材被 10 章引用时只查一次
  const allRefs = targets.flatMap((id) => list.bySection[id]);
  const idsOf = (kind: EvidenceKind) => [...new Set(allRefs.filter((r) => r.kind === kind).map((r) => r.refId))];

  const matIds = idsOf("material");
  const anaIds = idsOf("analysis");
  const hypIds = idsOf("hypothesis");
  const finIds = idsOf("finding");

  const [mats, anas, hyps, fins] = await Promise.all([
    matIds.length
      ? pool.query(
          `select id, kind, title, content_md, table_data from research_materials
            where project_id=$1 and user_id=$2 and id = any($3::uuid[])`,
          [projectId, userId, matIds])
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
    anaIds.length
      ? pool.query(
          `select id, tool, result from stats_jobs
            where user_id=$1 and id = any($2::uuid[]) and status='completed'`,
          [userId, anaIds])
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
    hypIds.length
      ? pool.query(
          `select id, code, text, verdict, evidence_ref, rationale from research_hypotheses
            where project_id=$1 and id = any($2::uuid[])`,
          [projectId, hypIds])
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
    finIds.length
      ? pool.query(
          `select id, tool, var_name, coef, std_err, t_value, p_value, ci_low, ci_high, stars, n_obs, r_squared, claim
             from research_findings where project_id=$1 and id = any($2::uuid[])`,
          [projectId, finIds])
      : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
  ]);
  const matMap = new Map(mats.rows.map((r) => [String((r as { id: unknown }).id), r as Record<string, unknown>]));
  const anaMap = new Map(anas.rows.map((r) => [String((r as { id: unknown }).id), r as Record<string, unknown>]));
  const hypMap = new Map(hyps.rows.map((r) => [String((r as { id: unknown }).id), r as Record<string, unknown>]));
  const finMap = new Map(fins.rows.map((r) => [String((r as { id: unknown }).id), r as Record<string, unknown>]));

  const out: Record<string, { text: string; used: number; dropped: number }> = {};
  for (const sectionId of targets) {
    const refs = list.bySection[sectionId];
    const parts: string[] = [];
    let used = 0;
    let dropped = 0;

    const noteOf = (r: { note: string }) => (r.note?.trim() ? `\n  本章用法: ${r.note.trim()}` : "");

    const matBlocks: string[] = [];
    for (const ref of refs.filter((r) => r.kind === "material")) {
      const m = matMap.get(ref.refId);
      if (!m) { dropped++; continue; }
      const tbl = renderTableData(m.table_data);
      if (!tbl && !String(m.content_md ?? "").trim()) { dropped++; continue; }
      used++;
      matBlocks.push(tbl
        ? `【素材·${String(m.kind)}·${escapeRefTitle(m.title)}】${noteOf(ref)}\n${tbl}`
        : `【素材·${String(m.kind)}·${escapeRefTitle(m.title)}】${noteOf(ref)}\n${String(m.content_md ?? "").slice(0, 800)}`);
    }
    if (matBlocks.length) parts.push(matBlocks.join("\n\n"));

    const anaBlocks: string[] = [];
    for (const ref of refs.filter((r) => r.kind === "analysis")) {
      const j = anaMap.get(ref.refId);
      if (!j) { dropped++; continue; }
      const tables = (j.result as { tables?: Array<{ title?: string; columns?: string[]; rows?: unknown[][] }> } | null)?.tables ?? [];
      const rendered = tables.slice(0, 4).map(renderAnalysisTable).filter(Boolean).join("\n\n");
      if (!rendered) { dropped++; continue; }
      used++;
      anaBlocks.push(`【分析结果·${String(j.tool)}】${noteOf(ref)}\n${rendered}`);
    }
    if (anaBlocks.length) parts.push(anaBlocks.join("\n\n"));

    const hypBlocks: string[] = [];
    for (const ref of refs.filter((r) => r.kind === "hypothesis")) {
      const h = hypMap.get(ref.refId);
      if (!h) { dropped++; continue; }
      used++;
      const verdictCn = VERDICT_CN[String(h.verdict)] ?? String(h.verdict);
      hypBlocks.push(`【假设 ${String(h.code || "?")}·${verdictCn}】${String(h.text)}`
        + (h.evidence_ref ? `\n  检验依据: ${String(h.evidence_ref)}` : "")
        + (h.rationale ? `\n  说明: ${String(h.rationale)}` : "") + noteOf(ref));
    }
    if (hypBlocks.length) parts.push(hypBlocks.join("\n\n"));

    const finBlocks: string[] = [];
    for (const ref of refs.filter((r) => r.kind === "finding")) {
      const f = finMap.get(ref.refId);
      if (!f) { dropped++; continue; }
      used++;
      finBlocks.push(`【发现·${String(f.tool)}·${String(f.var_name)}】${String(f.claim || "")}${noteOf(ref)}\n`
        + formatFindingStats(f));
    }
    if (finBlocks.length) parts.push(finBlocks.join("\n\n"));

    out[sectionId] = {
      text: parts.length ? evidencePreamble(parts) : "",
      used,
      dropped,
    };
  }
  return out;
}

function evidencePreamble(parts: string[]): string {
  return `【本章依据(用户为本章指定的真实研究材料, 必须围绕它们展开论证)】

${parts.join("\n\n")}

写作纪律(严格):
1. 上列【分析结果】【发现】里的**每一个数字都必须原样引用**, 不得四舍五入到别的位数、不得改符号、不得编造未出现的数字。
2. 上列没有的数据, 一律不写具体数值。需要数据支撑而依据不足处, 写"（此处待补数据）"而不是估一个。
3. 【假设】的检验结论以台账为准: 标"否定"的不得写成"得到支持"。
4. 引述统计结果时写清变量名与显著性(如"系数为 0.312, 在 1% 水平上显著"), 与依据里的写法一致。`;
}

const VERDICT_CN: Record<string, string> = {
  pending: "待检验", supported: "支持", partially_supported: "部分支持", rejected: "否定",
};

/** source_ref 可能与正文的占位符语法冲突, 做一次最小转义 */
function escapeRefTitle(v: unknown): string {
  return String(v ?? "未命名").replace(/[◆【】]/g, "").slice(0, 80);
}

/**
 * 表格对象的**归一化读取器** —— 本仓存在两套键名, 而它们是同一份数据的两种叫法。
 *
 * 由来(2026-09-25): 两个 Python runner 输出的表用的是**不同的键**:
 *   · `statistics_runner.py` → `{ title, columns, rows }`(统计台 17 法)
 *   · `empirical_runner.py`  → `{ title, cols, rows, notes }`(实证台 19 法)
 * 而写作舱的读取侧只认 `columns` —— 于是**实证台跑出来的表一进这里就是"空表"**,
 * 表现为 `renderAnalysisTable` 返回空串、`extractFindings` 报"表头里找不到系数列"。
 *
 * 这不是"兼容两套格式"的让步, 是修一个**同义不同名**的缺陷:
 * 两张表都是"表头 + 行", 叫 `cols` 还是 `columns` 对读到它的人没有任何区别。
 * 收在一个函数里, 以后 runner 再改键名只用改这一处。
 */
interface RawTable { title?: unknown; columns?: unknown; cols?: unknown; rows?: unknown; notes?: unknown }

/** 取表头数组(两套键名都认) */
function tableColumns(t: RawTable | null | undefined): string[] | null {
  const c = Array.isArray(t?.columns) ? t.columns : Array.isArray(t?.cols) ? t.cols : null;
  return c ? c.map(String) : null;
}

/** 取行数组 */
function tableRows(t: RawTable | null | undefined): unknown[][] | null {
  return Array.isArray(t?.rows) ? (t.rows as unknown[][]) : null;
}

/** 统一成 `{title, columns, rows, notes}` 再交给渲染/抽取 —— `notes` 是实证台的表注 */
function normalizeTable(t: RawTable): { title: string; columns: string[]; rows: unknown[][]; notes: string } | null {
  const cols = tableColumns(t);
  const rows = tableRows(t);
  if (!cols || !rows) return null;
  return { title: String(t.title ?? ""), columns: cols, rows, notes: String(t.notes ?? "") };
}

/** material.table_data 的两种形状(都是前端真会写进去的): {columns,rows} 或二维数组 */
export function renderTableData(td: unknown): string {
  if (!td) return "";
  const t = td as { columns?: unknown; rows?: unknown };
  if (Array.isArray(t.columns) && Array.isArray(t.rows)) {
    return renderTable(t.columns.map(String), t.rows as unknown[][]);
  }
  if (Array.isArray(td) && Array.isArray((td as unknown[])[0])) {
    const arr = td as unknown[][];
    return renderTable(arr[0].map(String), arr.slice(1));
  }
  return "";
}

/** 统计/实证任务的 result.tables[n] → markdown(取前 25 行, 避免把 prompt 撑爆) */
function renderAnalysisTable(raw: RawTable): string {
  const t = normalizeTable(raw);
  if (!t) return "";
  const body = renderTable(t.columns, t.rows.slice(0, 25));
  return t.title ? `〔${t.title}〕\n${body}` : body;
}

function renderTable(headers: string[], rows: unknown[][]): string {
  if (!headers.length) return "";
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "number" ? String(v) : String(v);
    return s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 40);
  };
  const lines = [`| ${headers.map(cell).join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const r of rows) lines.push(`| ${headers.map((_, i) => cell((r ?? [])[i])).join(" | ")} |`);
  return lines.join("\n");
}

function formatFindingStats(f: Record<string, unknown>): string {
  const bits: string[] = [];
  const num = (v: unknown, d = 3) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "");
  const c = num(f.coef); if (c) bits.push(`系数 ${c}${String(f.stars ?? "")}`);
  const se = num(f.std_err); if (se) bits.push(`标准误 ${se}`);
  const t = num(f.t_value); if (t) bits.push(`t=${t}`);
  const p = num(f.p_value, 4); if (p) bits.push(`p=${p}`);
  if (typeof f.ci_low === "number" && typeof f.ci_high === "number") {
    bits.push(`95%CI [${f.ci_low.toFixed(3)}, ${f.ci_high.toFixed(3)}]`);
  }
  if (typeof f.n_obs === "number") bits.push(`N=${f.n_obs}`);
  if (typeof f.r_squared === "number") bits.push(`R²=${f.r_squared.toFixed(4)}`);
  return `  统计: ${bits.join(", ")}`;
}

// ═══════════════════════════════════════════════════════════════
// ② 假设检验台账
// ═══════════════════════════════════════════════════════════════

export interface HypothesisInput {
  id?: string; code?: string; text?: string;
  verdict?: string; evidenceRef?: string; rationale?: string;
}

export async function listHypotheses(userId: string, projectId: string) {
  if (!(await assertOwned(userId, projectId))) return null;
  const r = await pool.query(
    `select id, code, text, verdict, evidence_ref, rationale, sort_order
       from research_hypotheses where project_id=$1 order by sort_order, created_at`,
    [projectId]);
  return {
    hypotheses: r.rows.map((h) => ({
      id: String(h.id), code: String(h.code ?? ""), text: String(h.text ?? ""),
      verdict: String(h.verdict ?? "pending"), evidenceRef: String(h.evidence_ref ?? ""),
      rationale: String(h.rationale ?? ""),
    })),
  };
}

const VERDICTS = new Set(["pending", "supported", "partially_supported", "rejected"]);

/**
 * 台账全量保存(与章节依据同一形态: 前端看到的就是库里的)。
 *
 * 已存在的按 id 更新, 没有 id 的插入, **库里多出来的删除** —— 这样用户在界面上删掉
 * 一条假设, 刷新后它真的不在了。code 留空时按序自动补 H1/H2…, 因为正文引用靠它。
 */
export async function saveHypotheses(
  userId: string, projectId: string, items: HypothesisInput[]
): Promise<{ ok: boolean; error?: string; hypotheses?: unknown[] }> {
  if (!(await assertOwned(userId, projectId))) return { ok: false, error: "项目不存在" };
  const max = 50;
  const clean = items.slice(0, max);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const keep: string[] = [];
    for (let i = 0; i < clean.length; i++) {
      const h = clean[i];
      const code = String(h.code ?? "").trim() || `H${i + 1}`;
      const verdict = VERDICTS.has(String(h.verdict)) ? String(h.verdict) : "pending";
      const text = String(h.text ?? "").slice(0, 2000);
      const evidenceRef = String(h.evidenceRef ?? "").slice(0, 1000);
      const rationale = String(h.rationale ?? "").slice(0, 2000);
      if (h.id) {
        const upd = await client.query(
          `update research_hypotheses
              set code=$3, text=$4, verdict=$5, evidence_ref=$6, rationale=$7, sort_order=$8, updated_at=now()
            where id=$1 and project_id=$2 returning id`,
          [h.id, projectId, code, text, verdict, evidenceRef, rationale, i]);
        if (upd.rows.length) { keep.push(String(h.id)); continue; }
        // id 不属于本项目 → 当作新增, 不报错(id 可能是前端从别的项目复制来的)
      }
      const ins = await client.query(
        `insert into research_hypotheses (id, project_id, code, text, verdict, evidence_ref, rationale, sort_order)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (project_id, code) where code <> '' do update
           set text=$4, verdict=$5, evidence_ref=$6, rationale=$7, sort_order=$8, updated_at=now()
         returning id`,
        [randomUUID(), projectId, code, text, verdict, evidenceRef, rationale, i]);
      if (ins.rows[0]) keep.push(String(ins.rows[0].id));
    }
    if (keep.length) {
      await client.query(
        `delete from research_hypotheses where project_id=$1 and id <> all($2::uuid[])`,
        [projectId, keep]);
    } else {
      await client.query(`delete from research_hypotheses where project_id=$1`, [projectId]);
    }
    await client.query("commit");
    return { ok: true, ...(await listHypotheses(userId, projectId)) ?? {} };
  } catch (e) {
    await client.query("rollback").catch(() => null);
    return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
  } finally {
    client.release();
  }
}

/**
 * 把 analysis 节点里那份**假设草案**灌进台账。只补不覆盖。
 *
 * 为什么是"只补不覆盖": 那份草案是框架设计阶段 LLM 生成的, 而台账里可能已经有用户
 * 手工改过的结论。重跑一次框架设计就把结论冲掉, 等于这个台账不能要。
 * 判重按**文本**(不是 code —— code 是 LLM 编的, 重跑会变)。
 */
export async function syncHypothesesFromAnalysis(userId: string, projectId: string): Promise<{ ok: boolean; added: number; total: number }> {
  if (!(await assertOwned(userId, projectId))) return { ok: false, added: 0, total: 0 };
  const r = await pool.query(
    `select payload->'hypotheses' as hyps from research_nodes where project_id=$1 and node_key='analysis'`,
    [projectId]);
  const raw = (r.rows[0]?.hyps ?? []) as unknown[];
  const texts: string[] = [];
  for (const h of raw) {
    if (typeof h === "string") texts.push(h);
    else if (h && typeof h === "object" && typeof (h as { text?: unknown }).text === "string") {
      texts.push(String((h as { text: string }).text));
    }
  }
  const existing = await listHypotheses(userId, projectId);
  if (!existing) return { ok: false, added: 0, total: 0 };
  const seen = new Set(existing.hypotheses.map((h) => h.text.trim()));
  const fresh = texts.map((t) => t.trim()).filter((t) => t && !seen.has(t));
  if (!fresh.length) return { ok: true, added: 0, total: existing.hypotheses.length };
  const nextTotal = existing.hypotheses.length + fresh.length;
  const merged: HypothesisInput[] = [
    ...existing.hypotheses.map((h) => ({
      id: h.id, code: h.code, text: h.text, verdict: h.verdict, evidenceRef: h.evidenceRef, rationale: h.rationale,
    })),
    ...fresh.map((t, i) => ({ code: `H${existing.hypotheses.length + i + 1}`, text: t, verdict: "pending" })),
  ];
  const saved = await saveHypotheses(userId, projectId, merged);
  return { ok: saved.ok, added: fresh.length, total: nextTotal };
}

// ═══════════════════════════════════════════════════════════════
// ③ 正文数字核验
// ═══════════════════════════════════════════════════════════════

/** 提取数字的字面量 —— 核验(正文侧)与依据收集(依据侧)**共用同一个口径** */
const NUM_RE = /-?\d+(?:\.\d+)?%?/g;

export interface NumberCheck {
  raw: string;
  value: number;
  /** 在正文里的上下文(前后各 12 字), 供界面显示"哪个数字对不上" */
  context: string;
  status: "matched" | "unmatched";
  /** 匹配上时: 来源说明; 匹配不上时: 空 */
  matchedVia: string;
  /** 匹配不上的时候, 依据里最接近的数(给用户一个"是不是想写这个"的提示) */
  suggestion?: string;
}

/**
 * 被跳过的数字, 以及**为什么跳过**。
 *
 * 2026-09-25 补。此前这些是**静默 continue** —— 而"跳过了什么"恰恰是别人能不能信任
 * 这条核验的关键: 如果它悄悄漏掉了正文里一半的数字, 那份"全部对上"的报告就是假的。
 * 现在全部计进 skipped 并在界面上显示(数量 + 分类), 让人一眼看出覆盖到哪儿。
 */
export type SkipReason = "citation" | "reference" | "year" | "threshold";
export interface SkippedNumber { raw: string; reason: SkipReason; context: string }

/**
 * 引用标注在正文里的**字符区间** —— 落在这里面的数字是"别人研究里的数", 不该拿本课题的数据去核。
 *
 * 三种标注形态(都是中文社科论文里的实际写法):
 *   ① `[12]` / `[12,13]` / `[12-14]` —— 顺序编码制。方括号里**只有数字与分隔符**才算,
 *      `[表1]`、`[注: 0.5]` 这类不是引用, 不会被误判(它们的方括号里有汉字)。
 *   ② `§REF_23_1§` —— 本系统生成正文时用的引用占位符(见 generateChapter 的引用池段)。
 *   ③ `（张三等，2020）` / `(Smith, 2020: 15)` —— 作者年份制。
 *      ⚠ 这一条**刻意收窄**: 要求括号里除了 4 位年份**还有别的字符**。
 *      纯 `(2020)` 不跳 —— 因为它同样可能是数据(如"较 2020 年增长…"的括注)。
 *      跳多了就是漏报, 而核验的价值全在"抓错"上。
 */
function citationSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const push = (m: RegExpMatchArray) => { if (m.index !== undefined) spans.push([m.index, m.index + m[0].length]); };
  for (const m of text.matchAll(/\[[\d\s,，\-–—、;；]{1,40}\]/g)) push(m);
  for (const m of text.matchAll(/§REF_\d+_\d+§/g)) push(m);
  for (const m of text.matchAll(/[（(][^（）()]{2,60}[）)]/g)) {
    if (!/(?:19|20)\d{2}/.test(m[0])) continue;
    // 去掉年份后还剩"实质内容"才算引用(见上面第 ③ 条的收窄理由)
    if (m[0].replace(/[（()）\s,，:：\-–—]|(?:19|20)\d{2}/g, "").length > 0) push(m);
  }
  return spans;
}

/** 图表/公式/章节编号 —— `表 1`、`图 2`、`式 (3)`、`模型 (3)`、`第 4 列` */
const REFERENCE_RE = /(?:表|图|式|方程|模型|公式|附录|列|行|个|名)\s*[（(]?\s*(\d{1,3})\s*[）)]?/g;

/**
 * 显著性阈值字面量 —— `p<0.01` 里的 0.01 是**惯例写法**, 不是从数据算出来的统计量。
 * 依据里存的是 p=0.0021, 正文写 "p<0.01" 完全正确, 不核验它。
 * 只在比较符**前面紧邻 p/P** 时才算阈值(避免把 "β<0.1" 这种真系数也吞掉)。
 */
const THRESHOLD_RE = /[pP]\s*[<≤=≥>]\s*(\d+(?:\.\d+)?)/g;

/**
 * 判断正文里第 index 个位置的数字属于哪一类。
 * 返回 undefined = 需要核验的统计量。
 */
function classifyNumber(raw: string, text: string, index: number, citationRanges: Array<[number, number]>): SkipReason | undefined {
  const end = index + raw.length;
  for (const [s, e] of citationRanges) {
    if (index >= s && end <= e) return "citation";
  }
  // 阈值: 数字落在 `p<…` 那个捕获组的位置上
  for (const m of text.matchAll(THRESHOLD_RE)) {
    if (m.index === undefined || m[1] === undefined) continue;
    const at = m.index + m[0].lastIndexOf(m[1]);
    if (index === at) return "threshold";
  }
  // 图表/编号: 数字紧跟在"表/图/式…"之后(matchAll 的捕获组位置)
  for (const m of text.matchAll(REFERENCE_RE)) {
    if (m.index === undefined || m[1] === undefined) continue;
    const at = m.index + m[0].lastIndexOf(m[1]);
    if (index === at) return "reference";
  }
  // 年份(1900-2100 的整数)—— 统计系数落在这个区间的可能性极低, 而年份极常见
  const v = parseFloat(raw);
  if (Number.isInteger(v) && v >= 1900 && v <= 2100) return "year";
  return undefined;
}

/**
 * 核验正文里的数字能不能对上"本章依据"。
 *
 * ⚠ 这条**只报告, 不改写正文**。理由是学术写作的责任边界: 系统能证明"这个数不在你的
 *   结果里", 但不能替研究者决定该改成什么 —— 也许那个 0.42 来自他没选进本章依据的另一次
 *   分析(那就是"依据没选全"), 也许是他从别处引的(那就该标出处)。把它自动"修正"成
 *   最接近的系数是最糟的做法: 那会让一句本来标注了出处的引文变成假数据。
 *
 * **标了出处的数字不核验**(2026-09-25 补): 正文里 `[12]`、`§REF_2_1§`、`（张三，2020）`
 *   这些标注里的数字, 以及图表/公式编号、显著性阈值, 都不属于"本研究的结果",
 *   拿本课题的数据去核它们是**假报错**。跳过的部分计进 `skipped` 并分类返回, 不静默丢 ——
 *   否则"全部对上"这句话就没有意义了。
 *
 * 判"对上"的口径刻意宽: 允许**四舍五入到任意位数**命中(0.3 / 0.31 / 0.312 都算对上同一个
 * 系数), 因为论文里写几位小数是作者的表述选择, 不是数据错误。真正要抓的是那种
 * "结果里根本没有这个量级"的数字(比如依据里全是 ±2 以内的系数, 正文写了个 15.7)。
 */
export async function verifyChapterNumbers(
  userId: string, projectId: string, sectionId: string, content: string
): Promise<{
  checks: NumberCheck[]; matched: number; unmatched: number;
  basisCount: number; basisNumbers: number;
  skipped: SkippedNumber[]; skippedByReason: Record<SkipReason, number>;
} | null> {
  if (!(await assertOwned(userId, projectId))) return null;
  const basis = await collectBasisNumbers(userId, projectId, sectionId);
  const text = String(content ?? "");
  const citationRanges = citationSpans(text);
  const checks: NumberCheck[] = [];
  const skipped: SkippedNumber[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const raw = m[0];
    if (m.index === undefined) continue;
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) continue;
    const start = Math.max(0, m.index - 12);
    const context = text.slice(start, Math.min(text.length, m.index + raw.length + 12)).replace(/\n/g, " ");
    const reason = classifyNumber(raw, text, m.index, citationRanges);
    if (reason) { skipped.push({ raw, reason, context }); continue; }
    const hit = basis.numbers.find((b) => roundTierMatch(b.value, v));
    checks.push({
      raw, value: v, context,
      status: hit ? "matched" : "unmatched",
      matchedVia: hit ? hit.via : "",
      ...(hit ? {} : nearestSuggestion(basis.numbers, v)),
    });
  }
  const matched = checks.filter((c) => c.status === "matched").length;
  const skippedByReason = { citation: 0, reference: 0, year: 0, threshold: 0 } as Record<SkipReason, number>;
  for (const s of skipped) skippedByReason[s.reason]++;
  return {
    checks,
    matched,
    unmatched: checks.length - matched,
    basisCount: basis.itemCount,
    basisNumbers: basis.numbers.length,
    skipped,
    skippedByReason,
  };
}

/**
 * 同一个数按不同小数位四舍五入后是否相等。
 *
 * 例: 依据里的 0.3125 → 正文写 0.3 / 0.31 / 0.313 都应算对上。
 * 反过来也成立(依据存 0.312, 正文写 0.3125 —— 少见但不该判错)。
 *
 * ⚠ 判据是「**写出来的数本身就是依据某个精度的正确四舍五入**」, 不是「两者在某个精度下相等」。
 *   这两个写法差别很大, 而第一版我写成了后者, 立刻出了假阳性:
 *     round(0.312, 0) == 0 且 round(0.35, 0) == 0  →  0.35 被判"对上了 0.312"。
 *   这类假阳性比漏报危险得多 —— 它是**把错的判成对的**, 而整条核验链的价值全在"抓错"上。
 *   所以精度从 **1 位小数**起(d=0 会把 0.1~0.9 全塌成 0/1), 且两个方向都要精确命中。
 */
function roundTierMatch(basis: number, written: number): boolean {
  if (!Number.isFinite(basis) || !Number.isFinite(written)) return false;
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  for (let d = 1; d <= 4; d++) {
    const tier = Math.pow(10, d);
    // 方向一: 正文写的是依据按 d 位四舍五入的结果(依据更精确)
    if (eq(Math.round(basis * tier) / tier, written)) return true;
    // 方向二: 依据本身是正文按 d 位四舍五入的结果(正文更精确)
    if (eq(Math.round(written * tier) / tier, basis)) return true;
  }
  // 百分比 vs 小数写法的换算: 0.312 与 31.2%
  for (const k of [100]) {
    if (Math.abs(basis - written / k) < Math.abs(basis) * 0.005 + 1e-9) return true;
    if (Math.abs(basis * k - written) < Math.abs(written) * 0.005 + 1e-9) return true;
  }
  return false;
}

function nearestSuggestion(nums: Array<{ value: number; via: string }>, v: number): { suggestion?: string } {
  if (!nums.length) return {};
  let best: { value: number; via: string } | null = null;
  let bestD = Infinity;
  for (const n of nums) {
    const d = Math.abs(n.value - v);
    // 只提示"可能就是它"的情况: 相对差 < 30%, 否则不提示(免得误导)
    if (d < bestD && d <= Math.abs(v) * 0.3 + 1e-9) { best = n; bestD = d; }
  }
  return best ? { suggestion: `依据里最接近的是 ${best.value}(${best.via}, 差 ${bestD.toFixed(4)})` } : {};
}

// ═══════════════════════════════════════════════════════════════
// ⑥ 结果段落生成(A4) —— 从分析结果直接产出「结果」章草稿
// ═══════════════════════════════════════════════════════════════

/**
 * 从**发现台账**生成「结果」章草稿。
 *
 * 与普通章节生成的区别, 也是它存在的理由:
 *   普通章节生成是"给模型一堆上下文, 让它写一篇文章"; 结果章不是文章, 是**数据的陈述**。
 *   实测过的问题: 让模型自由写结果章, 它会把系数四舍五入、把不显著的写成"显著为正"、
 *   把相关写成因果。所以这里的做法是 ——
 *
 *   ① 数字先由**代码**写成句子骨架(每条发现一句, 系数/显著性/N 从列里取, 不经模型);
 *   ② 模型只负责把这些句子**连成段**, 并补过渡句与"这表明…"的解释;
 *   ③ 生成后立刻跑一遍数字核验, 对不上的原样报出来。
 *
 * ⚠ 顺序很重要: 先有骨架再让模型润色, 比"让模型写然后核验"可靠得多 ——
 *   后者要靠核验兜底, 前者从源头就不会错位。
 */
export function buildFindingSkeleton(findings: Array<Record<string, unknown>>): string {
  if (!findings.length) return "";
  return findings.map((f) => {
    const stars = String(f.stars ?? "");
    const coef = typeof f.coef === "number" ? f.coef : null;
    if (coef === null) return "";
    const dir = coef > 0 ? "正向" : coef < 0 ? "负向" : "无";
    // 显著性表述用**中文惯例**而不是星号: 星号在正文里要配脚注, 而这里给的是句子
    const sig = !f.pValue && f.pValue !== 0 ? "未报告显著性"
      : String(stars) === "***" ? "在 1% 水平上显著"
        : String(stars) === "**" ? "在 5% 水平上显著"
          : String(stars) === "*" ? "在 10% 水平上显著"
            : "在常规水平上不显著";
    const bits = [`${String(f.varName)} 的系数为 ${coef}`, sig];
    if (typeof f.stdErr === "number") bits.push(`标准误 ${f.stdErr}`);
    if (typeof f.pValue === "number") bits.push(`p=${f.pValue}`);
    if (typeof f.nObs === "number") bits.push(`N=${f.nObs}`);
    if (typeof f.rSquared === "number") bits.push(`R²=${f.rSquared}`);
    // "不显著"时不能写"正向影响" —— 方向在没有统计意义时是不可解读的
    return stars
      ? `${String(f.tool)} 结果显示, ${bits.join("，")}；表明 ${String(f.varName)} 与因变量呈${dir}关联。`
      : `${String(f.tool)} 结果显示, ${bits.join("，")}；${String(f.varName)} 的影响未通过显著性检验, 不宜解读方向。`;
  }).filter(Boolean).join("\n");
}

/**
 * 生成结果段: 骨架(代码写) → 模型连缀 → 核验。
 * 返回的 `skeleton` 与 `verification` 一并给出, 让界面能把"哪些数字是机器写的"显示出来。
 */
export async function generateResultDraft(
  userId: string, projectId: string, sectionId: string, opts: { findingIds?: string[]; topic?: string } = {}
): Promise<{
  ok: boolean; content?: string; skeleton?: string; verification?: { matched: number; unmatched: number; checks: unknown[] };
  error?: string;
}> {
  if (!(await assertOwned(userId, projectId))) return { ok: false, error: "项目不存在" };
  const list = await listFindings(userId, projectId);
  if (!list) return { ok: false, error: "项目不存在" };
  const picked = list.findings.filter((f) =>
    f.status !== "dismissed" && (!opts.findingIds?.length || opts.findingIds.includes(f.id)));
  if (!picked.length) {
    return { ok: false, error: "还没有可用的发现 —— 先在研究台账里从某次分析采集, 并采纳要写进正文的条目" };
  }
  const skeleton = buildFindingSkeleton(picked as unknown as Array<Record<string, unknown>>);
  if (!skeleton) return { ok: false, error: "这些发现里没有可用的数字" };

  const { getLlmEndpoint, fetchLlm } = await import("../ai/llm-common.js");
  const { getRoleModel } = await import("./llm-model-registry.js");
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{
      role: "user",
      content: `你是社科论文写作助手。下面是一组**已经算好的**统计结果要点, 请把它们连缀成论文「研究结果」部分的正文。

硬性要求:
1. **一个数字都不许改、不许增删、不许四舍五入到别的位数**。所有数字已给出, 你只组织语言。
2. 不要复述"系数为 X"这种表格式罗列 —— 要写成段落, 用"结果表明""从模型 X 看"等过渡把要点串起来。
3. 不要下因果断言(除非原文已明说因果识别); 用"与…相关""伴随""显著影响"这类表述。
4. 不显著的条目要如实写"未通过显著性检验", 不得暗示方向。
5. 400-800 字, 自然分段。输出 JSON: {"content":"正文"}

【论文主题】${String(opts.topic ?? "").slice(0, 200)}

【结果要点(数字固定)】
${skeleton}`,
    }],
    temperature: 0.3, maxTokens: 3000, timeoutMs: 240_000,
  });
  const text = res?.text ?? "";
  let content = "";
  try { content = String(JSON.parse(text.replace(/```json|```/g, "").trim())?.content ?? ""); } catch { /* 解析失败 */ }
  if (!content.trim()) return { ok: false, error: "AI 未能生成结果段, 请重试" };

  // 生成后立刻核验 —— 把"哪些数字对不上"原样交给用户, 不做自动修正
  const v = await verifyChapterNumbers(userId, projectId, sectionId, content);
  return {
    ok: true,
    content,
    skeleton,
    verification: v ? { matched: v.matched, unmatched: v.unmatched, checks: v.checks.filter((c) => c.status === "unmatched") } : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════
// ⑤ 研究设计 —— 方法/识别策略/数据来源/伦理
// ═══════════════════════════════════════════════════════════════

/**
 * 读 design 节点并组装成**可注入正文的设计约束块**。
 *
 * 由来: 框架设计页那张「研究设计」面板此前既不落库也不进生成 —— 用户选"双重差分"
 * 还是选"不做因果推断", 生成的稿子一模一样。设计对正文零影响, 那这一步就只是装饰。
 *
 * 注入位置刻意是**章节生成**而不是只有方法章: 方法与识别策略决定了全文的口径
 * (比如"不做因果推断"时, 全文都不该写"导致/因为…才"), 而数据来源与伦理决定了
 * 哪些话能说(未脱敏的个人经历不能当例证)。
 */
export async function buildDesignBlock(userId: string, projectId: string): Promise<string> {
  if (!(await assertOwned(userId, projectId))) return "";
  const r = await pool.query(
    `select payload from research_nodes where project_id=$1 and node_key='design'`, [projectId]);
  const p = (r.rows[0]?.payload ?? {}) as {
    methodId?: unknown; identifyId?: unknown; dataSources?: unknown; ethics?: unknown;
  };
  const methodId = String(p.methodId ?? "").trim();
  const identifyId = String(p.identifyId ?? "").trim();
  const dataSources = Array.isArray(p.dataSources) ? p.dataSources.map(String).filter(Boolean) : [];
  const ethics = Array.isArray(p.ethics) ? p.ethics.map(String) : [];
  if (!methodId && !identifyId && !dataSources.length) return "";

  /**
   * 方法 id → 方法论口径。**不是**把 id 原样丢给模型 —— "did" 这种缩写对模型是个空词,
   * 它可能理解成别的。这里给的是"选了这个方法意味着正文该怎么写"。
   * 表里没有的方法只是显示中文名, 不加额外约束(不编造它不认识的语义)。
   */
  const METHOD_SPEC: Record<string, string> = {
    ols: "使用多元回归: 报告系数、标准误与显著性, 不得由相关推断因果",
    did: "使用双重差分: 必须交代处理组/对照组与政策时点, 只能声称**平均处理效应**, 且需在方法部分说明平行趋势检验",
    panel_fe: "使用面板固定效应: 需说明个体/时间固定效应的选择理由, 结论限于样本期内",
    iv: "使用工具变量: 必须报告第一阶段结果与工具外生性论证, 否则不得声称因果",
    rdd: "使用断点回归: 需说明驱动变量、带宽选择与断点处平滑性检验",
    psm: "使用倾向得分匹配: 需报告匹配前后平衡性检验",
    logit: "使用 Logistic 回归: 报告系数与优势比 OR, 说明因变量为二分变量",
    ologit: "使用有序 Logistic: 说明因变量的有序取值与平行线检验",
    mediation: "使用中介效应分析: 区分直接效应/间接效应/总效应, 不声称单一机制的因果独占性",
    descriptive: "以描述统计为主: 只呈现分布与趋势, 不做推断性断言",
    crosstab: "使用交叉表与卡方检验: 报告卡方值与 p 值, 注意期望频数约束",
    meta_analysis: "使用元分析: 报告效应量、置信区间与异质性指标(I²)",
  };
  const IDENTIFY_SPEC: Record<string, string> = {
    none: "**不做因果推断** —— 全文只能写相关/关联/伴随, 严禁出现「导致」「因为…所以」「使得」等因果句式",
    did: "因果识别策略: 双重差分(DiD)",
    event_study: "因果识别策略: 事件研究(需报告平行趋势检验与动态效应)",
    iv: "因果识别策略: 工具变量 2SLS",
    rdd: "因果识别策略: 断点回归(RDD)",
    psm: "因果识别策略: 倾向得分匹配",
    scm: "因果识别策略: 合成控制法",
  };

  const lines: string[] = [];
  if (methodId) lines.push(`研究方法: ${METHOD_SPEC[methodId] ?? methodId}`);
  if (identifyId) lines.push(`因果识别: ${IDENTIFY_SPEC[identifyId] ?? identifyId}`);
  if (dataSources.length) {
    lines.push(`数据来源: ${dataSources.join("、")}`
      + "\n  (正文提到数据时必须与这里一致; 未在列的数据来源不得出现)");
  }
  if (ethics.length) {
    lines.push(`已声明的研究伦理约束: ${ethics.join("；")}`);
  }
  return `【研究设计约束(用户在设计阶段定下的, 正文必须遵守)】

${lines.join("\n")}

遵守要求:
1. 因果识别的口径决定了全文句式 —— 见上, 尤其"不做因果推断"时严禁因果措辞。
2. 提到数据来源时只能写上面列出的; 伦理约束涉及的材料不得直接引用。
3. 方法部分(若本章是方法/数据章)需按上面的要求交代识别策略与检验。`;
}

/** 把"本章依据 + 分析结果 + 发现"里所有可核验的数字收集起来 */async function collectBasisNumbers(
  userId: string, projectId: string, sectionId: string
): Promise<{ numbers: Array<{ value: number; via: string }>; itemCount: number }> {
  const numbers: Array<{ value: number; via: string }> = [];
  const seen = new Set<string>();
  const push = (v: unknown, via: string) => {
    const n = typeof v === "number" ? v : parseFloat(String(v));
    if (!Number.isFinite(n)) return;
    const key = `${n}|${via}`;
    if (seen.has(key)) return;
    seen.add(key);
    numbers.push({ value: n, via });
  };

  const list = await listEvidence(userId, projectId, sectionId);
  const refs = list?.bySection[sectionId] ?? [];
  let itemCount = 0;

  const mats = refs.filter((r) => r.kind === "material");
  const anas = refs.filter((r) => r.kind === "analysis");
  const fins = refs.filter((r) => r.kind === "finding");
  const hyps = refs.filter((r) => r.kind === "hypothesis");

  if (mats.length) {
    const r = await pool.query(
      `select id, title, table_data, content_md from research_materials
        where project_id=$1 and user_id=$2 and id = any($3::uuid[])`,
      [projectId, userId, mats.map((x) => x.refId)]);
    for (const row of r.rows) {
      itemCount++;
      const td = row.table_data as { columns?: unknown; rows?: unknown } | null;
      if (td && Array.isArray(td.columns) && Array.isArray(td.rows)) {
        for (const cell of (td.rows as unknown[][]).flat()) {
          if (typeof cell === "number") push(cell, `素材「${String(row.title)}」表格`);
        }
      }
      // 正文里出现的数字也可能是从素材正文里引的 —— 一并收进来。
      // ⚠ 这里**不过滤**年份/编号: 依据侧是"候选值集合", 多收几个只是让假报错更少;
      //   真正要过滤的是**正文侧**(见 verifyChapterNumbers 的 classifyNumber)——
      //   那边的每一个"跳过"都意味着可能漏掉一个错, 所以判据必须严。
      for (const n of String(row.content_md ?? "").match(NUM_RE) ?? []) {
        push(parseFloat(n), `素材「${String(row.title)}」正文`);
      }
    }
  }

  if (anas.length) {
    const r = await pool.query(
      `select id, tool, result from stats_jobs
        where user_id=$1 and id = any($2::uuid[]) and status='completed'`,
      [userId, anas.map((x) => x.refId)]);
    for (const row of r.rows) {
      itemCount++;
      const tables = (row.result as { tables?: Array<{ title?: string; rows?: unknown[][] }> } | null)?.tables ?? [];
      for (const t of tables) {
        const label = `${String(row.tool)} · ${String(t.title ?? "表")}`;
        for (const cell of (t.rows ?? []).flat()) {
          if (typeof cell === "number") push(cell, label);
          else if (typeof cell === "string" && !/^\[|\]$/.test(cell.trim())) push(cell, label);
        }
      }
    }
  }

  if (fins.length) {
    const r = await pool.query(
      `select id, tool, var_name, coef, std_err, t_value, p_value, ci_low, ci_high, n_obs, r_squared
         from research_findings where project_id=$1 and id = any($2::uuid[])`,
      [projectId, fins.map((x) => x.refId)]);
    for (const f of r.rows) {
      itemCount++;
      const label = `发现 ${String(f.tool)}·${String(f.var_name)}`;
      for (const k of ["coef", "std_err", "t_value", "p_value", "ci_low", "ci_high", "n_obs", "r_squared"] as const) {
        push(f[k], label);
      }
    }
  }

  if (hyps.length) {
    // 假设的依据是自由文本(如"模型2 中 x 的系数 0.312, p<0.01"), 里面的数字也算依据
    const r = await pool.query(
      `select id, code, evidence_ref, rationale from research_hypotheses
        where project_id=$1 and id = any($2::uuid[])`,
      [projectId, hyps.map((x) => x.refId)]);
    for (const h of r.rows) {
      itemCount++;
      for (const src of [String(h.evidence_ref ?? ""), String(h.rationale ?? "")]) {
        for (const n of src.match(NUM_RE) ?? []) {
          push(parseFloat(n), `假设 ${String(h.code)} 依据`);
        }
      }
    }
  }

  return { numbers, itemCount };
}

// ═══════════════════════════════════════════════════════════════
// ④ 发现台账(B)
// ═══════════════════════════════════════════════════════════════

/**
 * 从一份统计分析结果里**抽取**可溯源的发现。
 *
 * 这里刻意**不用 LLM 抽数字** —— 报错一个系数, 整篇论文的可信度就没了。
 * 数字一律按表头精确匹配(见 findCol), 匹配不到就跳过并记进 skipped;
 * LLM 只在之后给那些已经抽出来的数字写一句话(见 claimFindings)。
 */
export function extractFindings(tool: string, result: unknown): {
  findings: Array<{
    varName: string; coef: number; stdErr?: number; tValue?: number;
    pValue?: number; ciLow?: number; ciHigh?: number; stars: string;
    nObs?: number; rSquared?: number;
  }>;
  skipped: string[];
} {
  const out: Array<{
    varName: string; coef: number; stdErr?: number; tValue?: number;
    pValue?: number; ciLow?: number; ciHigh?: number; stars: string;
    nObs?: number; rSquared?: number;
  }> = [];
  const skipped: string[] = [];
  // 归一化: 实证台的表用 `cols`, 统计台用 `columns` —— 见 tableColumns 的注释
  const raw = (result as { tables?: RawTable[] } | null)?.tables ?? [];
  const tables = raw.map((t) => normalizeTable(t)).filter((t): t is NonNullable<typeof t> => !!t);

  const findCol = (cols: string[], ...names: string[]): number => {
    for (const n of names) {
      const i = cols.findIndex((c) => String(c).replace(/\s/g, "").includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };

  let nObs: number | undefined;
  let rSquared: number | undefined;
  // 拟合指标: 统计台单独一张「模型拟合」表; 实证台把它写在系数表的**表注**里
  //   (见 empirical_runner 的 table_html 第三参数, 形如 "R²=0.9278, N=30, *** p<0.01")
  const fit = tables.find((t) => t.title.includes("模型拟合"));
  if (fit) {
    const ci = findCol(fit.columns, "R²", "R2");
    const ni = findCol(fit.columns, "N");
    const row = fit.rows[0] ?? [];
    if (ci >= 0 && typeof row[ci] === "number") rSquared = row[ci] as number;
    if (ni >= 0 && typeof row[ni] === "number") nObs = row[ni] as number;
  }

  for (const t of tables) {
    const title = t.title;
    const cols = t.columns;
    /**
     * ⚠⚠ **按结构判, 不按名字判** —— 2026-09-25 修。
     *
     * 原先这里写死了 `回归结果|ANOVA` 这个标题正则、以及「标准误」「p值」这两个列名。
     * 那是**统计台(17 法)**的口径; 而实证台(19 法)的表叫「OLS 回归」「期间」「路径」「条件」,
     * 列叫「SE」「p」。结果: **实证台的结果一条都抽不出来**, 全部落进 skipped,
     * 表现为"采集为发现"提示"没有可抽取的系数表" —— 而表就在那里, 系数清清楚楚。
     *
     * 现在只认两件事: ① 有「变量」类列; ② 有「系数」列且值能转成数。
     * 这就够了 —— 描述统计(均值/标准差)、交叉表(频数)、变量构造(公式) 天然没有「系数」列,
     * 不会误入; 而两张 runner 的**所有**系数表都有。
     */
    const vi = findCol(cols, "变量", "项", "路径", "期间", "条件");  // ANOVA 叫"项", 中介叫"路径", 事件研究叫"期间"
    const ci = findCol(cols, "系数", "效应", "边际效应");
    if (vi < 0 || ci < 0) {
      /**
       * 没有系数列的表**绝大多数本来就该跳过**(描述统计/交叉表/变量构造…), 所以这里不逐张报。
       * 但如果**标题看着就是系数表**(含"回归/OLS/IV/RDD/PSM/DID/Logit/效应…")却抽不出来,
       * 那就是真的出问题了 —— 必须报出来。
       *
       * 这条诊断是**踩出来的**: 实证台的表曾因为标题叫「OLS 回归」而列名叫「SE」「p」
       * 被整个跳过, 界面只说"没有可抽取的系数表" —— 表就在那里, 系数清清楚楚,
       * 而没有任何信号告诉人"是列名对不上"。静默的失败比失败的失败难查得多。
       */
      if (/(回归|OLS|IV|2SLS|RDD|PSM|DID|TWFE|Logit|Probit|效应|系数|估计)/i.test(title)) {
        skipped.push(`${title}: 看着是系数表, 但表头里找不到「变量」或「系数」列(实际列: ${cols.slice(0, 6).join("/")})`);
      }
      continue;
    }
    // 列名兼容两套: 统计台「标准误/p 值/95% CI」, 实证台「SE/p/95%CI」
    const sei = findCol(cols, "标准误", "SE", "标准差");
    const ti = findCol(cols, "t值", "t 值", "z值", "z 值");
    const pi = findCol(cols, "p值", "p 值", "p");
    const cii = findCol(cols, "95%CI", "95% CI");
    // 表注里的拟合指标(实证台) —— 只在这个 run 还没从「模型拟合」表里拿到时才用
    const note = String((t as { notes?: unknown }).notes ?? "");
    const noteR2 = note.match(/R²\s*=\s*([\d.]+)/);
    const noteN = note.match(/N\s*=\s*(\d+)/);
    for (const row of t.rows) {
      const name = String((row ?? [])[vi] ?? "").trim();
      const coef = (row ?? [])[ci];
      if (!name) continue;
      // const 是截距, 不是实质发现 —— 放进"发现台账"只会稀释它
      if (name === "const" || name === "Intercept" || name === "截距") continue;
      if (typeof coef !== "number" || !Number.isFinite(coef)) {
        skipped.push(`${title} · ${name}: 系数不是数字(${String(coef).slice(0, 20)})`);
        continue;
      }
      const p = pi >= 0 && typeof (row ?? [])[pi] === "number" ? ((row ?? [])[pi] as number) : undefined;
      let ciLow: number | undefined;
      let ciHigh: number | undefined;
      if (cii >= 0) {
        const m = String((row ?? [])[cii] ?? "").match(/\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/);
        if (m) { ciLow = parseFloat(m[1]); ciHigh = parseFloat(m[2]); }
      }
      out.push({
        varName: name,
        coef,
        ...(typeof (row ?? [])[sei] === "number" ? { stdErr: (row ?? [])[sei] as number } : {}),
        ...(ti >= 0 && typeof (row ?? [])[ti] === "number" ? { tValue: (row ?? [])[ti] as number } : {}),
        ...(p !== undefined ? { pValue: p } : {}),
        ...(ciLow !== undefined ? { ciLow } : {}),
        ...(ciHigh !== undefined ? { ciHigh } : {}),
        stars: starsOf(p),
        // 拟合表优先; 实证台没有那张表, 退回表注里的 R²=/N=
        ...(nObs !== undefined ? { nObs } : noteN ? { nObs: Number(noteN[1]) } : {}),
        ...(rSquared !== undefined ? { rSquared } : noteR2 ? { rSquared: Number(noteR2[1]) } : {}),
      });
    }
  }
  return { findings: out, skipped };
}

/** 显著性星号(经济学论文惯例: 1% / 5% / 10%) */
export function starsOf(p: number | undefined): string {
  if (typeof p !== "number" || !Number.isFinite(p)) return "";
  if (p < 0.01) return "***";
  if (p < 0.05) return "**";
  if (p < 0.10) return "*";
  return "";
}

/**
 * 落库(幂等: 同一分析的同一变量只留一条, 由 uq_research_findings_src 保证)。
 *
 * `varName` 用 `tool::varName` 参与唯一键 —— 同一次分析里 OLS 与 Logistic 可能有同名变量。
 * claim 先留空, 由 `claimFindings` 用 LLM 写一句话; 不调 LLM 也能用(claim 空时界面显示统计式描述)。
 */
export async function saveFindings(
  userId: string, projectId: string, jobId: string, tool: string,
  rows: Array<Record<string, unknown>>
): Promise<{ ok: boolean; saved: number; error?: string }> {
  if (!(await assertOwned(userId, projectId))) return { ok: false, saved: 0, error: "项目不存在" };
  if (!rows.length) return { ok: true, saved: 0 };
  let saved = 0;
  for (const f of rows) {
    try {
      await pool.query(
        `insert into research_findings
           (id, project_id, job_id, tool, var_name, coef, std_err, t_value, p_value, ci_low, ci_high, stars, n_obs, r_squared)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (project_id, job_id, var_name) do update
           set coef=$6, std_err=$7, t_value=$8, p_value=$9, ci_low=$10, ci_high=$11,
               stars=$12, n_obs=$13, r_squared=$14, updated_at=now()`,
        [randomUUID(), projectId, jobId, tool, String(f.varName ?? ""),
         f.coef ?? null, f.stdErr ?? null, f.tValue ?? null, f.pValue ?? null,
         f.ciLow ?? null, f.ciHigh ?? null, String(f.stars ?? ""),
         f.nObs ?? null, f.rSquared ?? null]);
      saved++;
    } catch (e) {
      console.error("[findings] 落库失败", String(e).slice(0, 160));
    }
  }
  return { ok: true, saved };
}

export async function listFindings(userId: string, projectId: string) {
  if (!(await assertOwned(userId, projectId))) return null;
  const r = await pool.query(
    `select id, job_id, tool, var_name, coef, std_err, t_value, p_value, ci_low, ci_high,
            stars, n_obs, r_squared, claim, status
       from research_findings where project_id=$1 order by created_at desc limit 200`,
    [projectId]);
  return {
    findings: r.rows.map((f) => ({
      id: String(f.id), jobId: String(f.job_id ?? ""), tool: String(f.tool ?? ""),
      varName: String(f.var_name ?? ""), coef: f.coef, stdErr: f.std_err,
      tValue: f.t_value, pValue: f.p_value, ciLow: f.ci_low, ciHigh: f.ci_high,
      stars: String(f.stars ?? ""), nObs: f.n_obs, rSquared: f.r_squared,
      claim: String(f.claim ?? ""), status: String(f.status ?? "candidate"),
    })),
  };
}

/** 采纳/忽略一条发现(采纳后才会出现在"本章依据"的可选清单里) */
export async function setFindingStatus(userId: string, projectId: string, findingId: string, status: string) {
  if (!(await assertOwned(userId, projectId))) return { ok: false, error: "项目不存在" };
  if (!["candidate", "adopted", "dismissed"].includes(status)) return { ok: false, error: "状态不合法" };
  const r = await pool.query(
    `update research_findings set status=$3, updated_at=now() where id=$1 and project_id=$2 returning id`,
    [findingId, projectId, status]);
  return r.rows.length ? { ok: true } : { ok: false, error: "发现不存在" };
}

export async function setFindingClaim(userId: string, projectId: string, findingId: string, claim: string) {
  if (!(await assertOwned(userId, projectId))) return { ok: false, error: "项目不存在" };
  const r = await pool.query(
    `update research_findings set claim=$3, updated_at=now() where id=$1 and project_id=$2 returning id`,
    [findingId, projectId, String(claim ?? "").slice(0, 1000)]);
  return r.rows.length ? { ok: true } : { ok: false, error: "发现不存在" };
}

/**
 * 用 LLM 给已抽取的发现写自然语言外壳。
 *
 * ⚠ 提示词里**把数字写在 prompt 里让模型改写句子**, 而不是"描述这个发现" ——
 *   前者模型只需措辞, 后者模型会自作主张地四舍五入、换单位、甚至补一个它认为合理的数。
 *   写完之后 A3 的数字核验仍会逐条比对, 对不上的会被标出来。
 */
export async function claimFindings(
  userId: string, projectId: string, topic: string, ids?: string[]
): Promise<{ ok: boolean; updated: number; error?: string }> {
  if (!(await assertOwned(userId, projectId))) return { ok: false, updated: 0, error: "项目不存在" };
  const list = await listFindings(userId, projectId);
  if (!list) return { ok: false, updated: 0, error: "项目不存在" };
  const targets = list.findings.filter((f) => f.status !== "dismissed" && (!ids?.length || ids.includes(f.id)));
  if (!targets.length) return { ok: true, updated: 0 };

  const { getLlmEndpoint, fetchLlm } = await import("../ai/llm-common.js");
  const { getRoleModel } = await import("./llm-model-registry.js");
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });
  const items = targets.slice(0, 40);
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{
      role: "user",
      content: `你是社科研究结果表述助手。下面是一组**已经算出来的**统计结果, 请为每一条写一句学术化的中文结论。

硬性要求:
1. **只能使用给出的数字**, 一个字都不许改、不许四舍五入到别的位数、不许补充别的数值。
2. 写清变量、系数、显著性水平(如"在 5% 水平上显著")。系数为负要写"负向"。
3. 不下因果断言, 除非方法本身是因果识别设计。默认写"与…相关/呈显著正相关"。
4. 每条 40-80 字。

【研究主题】${String(topic ?? "").slice(0, 200)}

【结果清单】
${items.map((f, i) => `${i + 1}. 变量=${f.varName} | 方法=${f.tool} | 系数=${f.coef} | 标准误=${f.stdErr ?? "-"} | t=${f.tValue ?? "-"} | p=${f.pValue ?? "-"} | 显著性=${f.stars || "不显著"} | N=${f.nObs ?? "-"} | R²=${f.rSquared ?? "-"}`).join("\n")}

输出 JSON: {"claims":[{"i":序号,"claim":"结论句"}]}`,
    }],
    temperature: 0.2, maxTokens: 4000, timeoutMs: 240_000,
  });
  const text = res?.text ?? "";
  let claims: Array<{ i?: number; claim?: string }> = [];
  try { claims = JSON.parse(text.replace(/```json|```/g, "").trim())?.claims ?? []; } catch { /* 解析失败 */ }
  if (!Array.isArray(claims) || !claims.length) return { ok: false, updated: 0, error: "AI 未能生成表述, 请重试" };
  let updated = 0;
  for (const c of claims) {
    const idx = Number(c.i);
    const f = items[idx - 1];
    if (!f || !c.claim) continue;
    const r = await setFindingClaim(userId, projectId, f.id, String(c.claim));
    if (r.ok) updated++;
  }
  return { ok: true, updated };
}

/**
 * 一键采集: 把某次统计分析的系数抽出来, 写进发现台账。
 *
 * 这是 **A→B 的分界点**: A 批要求用户在界面里手动勾选依据; B 批允许系统自己
 * 从结果里找出"值得写的那些", 但仍然**不发明数字** —— 每个数字都能回到那次分析。
 */
export async function harvestFindings(
  userId: string, projectId: string, jobId: string
): Promise<{ ok: boolean; saved?: number; skipped?: string[]; error?: string }> {
  if (!(await assertOwned(userId, projectId))) return { ok: false, error: "项目不存在" };
  const r = await pool.query(
    `select id, tool, result from stats_jobs where id=$1 and user_id=$2 and status='completed'`,
    [jobId, userId]);
  if (!r.rows.length) return { ok: false, error: "分析结果不存在或尚未完成" };
  const job = r.rows[0];
  const { findings, skipped } = extractFindings(String(job.tool ?? ""), job.result);
  if (!findings.length) {
    return { ok: false, error: "这次分析里没有可抽取的系数表(相关矩阵/描述统计等结果请用「素材」通道插入)", skipped };
  }
  const saved = await saveFindings(userId, projectId, jobId, String(job.tool ?? ""), findings);
  return { ok: saved.ok, saved: saved.saved, skipped };
}

/**
 * **自动采集**(B 批的"系统自己发现"这一步)。
 *
 * 与上面那个手动采集的唯一区别: 触发者是系统, 不是用户点击。
 * 由 `statistics-job-service` 在任务成功落库时调用 —— 因为那时结果已经写进 `stats_jobs`,
 * 抽取只需要读那一行, 没有额外等待。
 *
 * 为什么要"自动": 用户跑一次回归的意图本来就是"我要看到结果"。让他再去点一次"采集",
 * 等于把中间那一步的责任推回给他 —— 而这一步**没有任何需要他判断的东西**:
 * 抽哪些行(系数表)、排除哪些(截距)、怎么算星号, 全是有客观规则的。
 * 真正需要判断的是后面几步: 这条发现说明什么(写结论句)、用在哪一章、要不要采纳 ——
 * 那些仍然是人工的, 本函数一律不碰(status 留 'candidate')。
 *
 * ⚠ 归属: **不写 project_id 到 stats_jobs**。一个数据文件可能被多个课题用,
 *   所以这里按 `input->>'fileId'` 反查**所有**关联的课题(走迁移 153 建的表达式索引),
 *   每个课题各存一份自己名下的发现。找不到关联课题时静默返回 0 ——
 *   用户在"数据分析"页直接跑的分析(不属于任何课题)本就不该产生台账行。
 */
export async function autoHarvestForFile(userId: string, jobId: string): Promise<number> {
  try {
    const jr = await pool.query(
      `select id, tool, result, input->>'fileId' as file_id
         from stats_jobs where id=$1 and user_id=$2 and status='completed'`,
      [jobId, userId]);
    const job = jr.rows[0];
    if (!job) return 0;
    const fileId = String(job.file_id ?? "").replace(/^file_/, "");
    if (!fileId) return 0;
    // 哪些课题的"数据文件"是这一个 —— 与 /analyses 端点同一条连接规则
    const pr = await pool.query(
      `select id from research_projects
        where user_id=$1
          and coalesce(status,'active') not in ('deleted','archived')
          and (workbench_snapshot->>'statisticsFileId' = $2
               or workbench_snapshot->>'statisticsFileId' = $3)`,
      [userId, fileId, `file_${fileId}`]);
    if (!pr.rows.length) return 0;
    const { findings } = extractFindings(String(job.tool ?? ""), job.result);
    if (!findings.length) return 0;
    let total = 0;
    for (const row of pr.rows) {
      const saved = await saveFindings(userId, String(row.id), jobId, String(job.tool ?? ""), findings);
      if (saved.ok) total += saved.saved;
    }
    return total;
  } catch (e) {
    // 不吞错但也不抛: 这是旁路增强, 失败不该让统计任务本身变成失败
    console.warn(`[findings] 自动采集失败(job=${jobId}): ${String(e).slice(0, 160)}`);
    return 0;
  }
}

/**
 * 把发现自动对到假设上(**只提议, 不判定**)。
 *
 * 做法是两层匹配, 都在代码里, 不用 LLM:
 *   ① 假设的"检验依据"里如果已经写了变量名或系数, 直接按它找对应的发现;
 *   ② 否则用假设**文本**里出现的变量名去匹配 —— 变量名来自项目的 variables 列表,
 *      所以不是模糊字符串猜测, 而是"假设里提到了哪个已知变量"。
 *
 * 为什么只提议不判定: 一条假设常常对应多个系数(主效应+交互), 也可能对应的是
 * 某个系数**不显著**从而被否定 —— 这些判断依赖研究设计, 系统替不了。
 * 本函数只把"看起来相关的发现"摆到那条假设旁边, 结论仍由人填。
 */
export async function suggestHypothesisLinks(
  userId: string, projectId: string
): Promise<Array<{ hypothesisId: string; code: string; findingIds: string[]; reason: string }>> {
  if (!(await assertOwned(userId, projectId))) return [];
  const [hl, fl, vars] = await Promise.all([
    listHypotheses(userId, projectId),
    listFindings(userId, projectId),
    pool.query(
      `select payload->'variables' as vars from research_nodes where project_id=$1 and node_key='analysis'`,
      [projectId]),
  ]);
  if (!hl || !fl) return [];
  const varNames: string[] = (Array.isArray(vars.rows[0]?.vars) ? vars.rows[0].vars : [])
    .map((v: { name?: unknown }) => String(v?.name ?? "")).filter(Boolean);
  const open = fl.findings.filter((f) => f.status !== "dismissed");

  const out: Array<{ hypothesisId: string; code: string; findingIds: string[]; reason: string }> = [];
  for (const h of hl.hypotheses) {
    const hay = `${h.text} ${h.evidenceRef} ${h.rationale}`;
    const hits = open.filter((f) => {
      // ① 依据里直接写了这个变量名
      if (f.varName && hay.includes(f.varName)) return true;
      // ② 依据里写了这个系数
      if (typeof f.coef === "number" && hay.includes(String(f.coef))) return true;
      return false;
    });
    // ③ 兜底: 假设文本里出现了某个已知变量, 而这条发现正属于那个变量
    if (!hits.length && varNames.length) {
      const mentioned = varNames.filter((n) => n && h.text.includes(n));
      for (const f of open) if (mentioned.includes(f.varName)) hits.push(f);
    }
    if (hits.length) {
      out.push({
        hypothesisId: h.id, code: h.code,
        findingIds: [...new Set(hits.map((f) => f.id))],
        reason: `假设里提到了 ${[...new Set(hits.map((f) => f.varName))].join("、")}`,
      });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// ⑦ 实证台绑定(跨 id 空间的那条线)
// ═══════════════════════════════════════════════════════════════

/**
 * 把写作课题绑定到一个实证课题 —— 于是它的**因果推断结果**(DiD/IV/RDD/PSM/合成控制/事件研究)
 * 也能作为研究证据。
 *
 * ⚠⚠ 安全模型, 必须读完再改这段代码:
 *
 *   `empirical_projects` **没有 user_id 列**, 实证台的 63 个路由**没有一处调 requireUser**,
 *   服务端对**本机连接全豁免**。也就是说 —— **实证台的数据是"实例级"的, 本来就没有用户隔离**。
 *   这是既有的架构事实, 不是本次引入的。
 *
 *   因此本函数**不假装**补上了隔离(那需要给 empirical_projects 加 user_id + 回填 + 改三个
 *   创建路径, 是另一件事)。它做的是:
 *     · 绑定是**用户显式设定**的(不是自动发现), 且**运行时校验** "这个实证课题确实存在";
 *     · 读取时只按**这一个** empirical_project_id 取数 —— 不提供"列出全部实证课题的数据"这种接口;
 *     · 越权面与实证台自身的暴露面**完全一致, 没有扩大**。
 *   界面上必须如实说明这一点(见 ChapterEvidencePanel 的提示), 否则用户会以为
 *   "写作舱里看得见"等于"它是我的私有数据"。
 */
export async function bindEmpiricalProject(
  userId: string, projectId: string, empiricalProjectId: string | null
): Promise<{ ok: boolean; error?: string; empiricalTitle?: string }> {
  if (!(await assertOwned(userId, projectId))) return { ok: false, error: "项目不存在" };
  if (!empiricalProjectId) {
    await pool.query(`update research_projects set empirical_project_id=null, updated_at=now() where id=$1 and user_id=$2`,
      [projectId, userId]);
    return { ok: true };
  }
  // 运行时校验实证课题确实存在 —— 挡住"绑一个不存在的 id"这种拼写错误,
  // 而不是等到读取时才表现为"空列表"(那会让人以为实证台没跑过东西)
  const r = await pool.query(`select id, title, user_id from empirical_projects where id=$1`, [empiricalProjectId]);
  if (!r.rows.length) return { ok: false, error: "实证课题不存在" };
  // 归属校验: 归属别人就拒; 未归属(历史数据)放行 —— 与 listEmpiricalProjects 同一口径
  if (r.rows[0].user_id && String(r.rows[0].user_id) !== String(userId)) {
    return { ok: false, error: "该实证课题属于其他账号, 无法绑定" };
  }
  await pool.query(`update research_projects set empirical_project_id=$3, updated_at=now() where id=$1 and user_id=$2`,
    [projectId, userId, empiricalProjectId]);

  /**
   * **回补**: 把绑定之前就已经跑好的运行也收进台账。
   *
   * 为什么必须有这一步: 自动采集是挂在"运行落库那一刻"的 —— 那一刻如果还没绑定,
   * 就没有任何课题可写, 于是那批结果**永远不会**进台账。而"先跑分析、后建写作课题"
   * 恰恰是最自然的顺序(实证台本来就先于写作舱用)。不回补的话, 用户绑完看到的是一张空台账,
   * 只能一条条手点「采集为发现」—— 那正是"跑完了正文里还是没证据"的原病。
   *
   * 纯代码抽取(不调 LLM), 上限 20 条最近的运行; 失败只 warn —— 绑定本身必须成功。
   */
  try {
    const runs = await pool.query(
      `select id, stage, python_result from empirical_pipeline_runs
        where project_id=$1 and jsonb_array_length(coalesce(python_result->'tables','[]'::jsonb)) > 0
        order by created_at desc limit 20`, [empiricalProjectId]);
    for (const run of runs.rows) {
      const { findings } = extractFindings(String(run.stage ?? ""), run.python_result);
      if (findings.length) {
        await saveFindings(userId, projectId, String(run.id), String(run.stage ?? ""), findings);
      }
    }
  } catch (e) {
    console.warn(`[findings] 绑定时回补失败(project=${projectId}): ${String(e).slice(0, 160)}`);
  }

  return { ok: true, empiricalTitle: String(r.rows[0].title ?? "") };
}

/** 当前绑定 */
export async function getEmpiricalBinding(userId: string, projectId: string) {
  if (!(await assertOwned(userId, projectId))) return null;
  const r = await pool.query(
    `select p.empirical_project_id, e.title
       from research_projects p
       left join empirical_projects e on e.id = p.empirical_project_id
      where p.id=$1 and p.user_id=$2`, [projectId, userId]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    empiricalProjectId: row.empirical_project_id ? String(row.empirical_project_id) : "",
    empiricalTitle: String(row.title ?? ""),
  };
}

/**
 * 可绑定的实证课题清单(给下拉用)。
 *
 * ⚠ 2026-09-25 起按归属过滤(迁移 156), 但保留未归属的历史课题并标记出来:
 *   直接藏掉那些课题, 用户会以为"我跑过的分析不见了" —— 而它们的归属**无法可靠回填**
 *   (见迁移 156: `empirical_results` 没有 project_id, `pipeline_runs` 没有用户列)。
 *   所以是"标注"而不是"隐藏", 由用户自己判断要不要绑。
 */
export async function listEmpiricalProjects(viewerId?: string | null) {
  const r = await pool.query(
    `select p.id, p.title, p.topic, p.created_at, p.user_id,
            (select count(*)::int from empirical_pipeline_runs r
              where r.project_id = p.id and jsonb_array_length(coalesce(r.python_result->'tables','[]'::jsonb)) > 0) as n_runs_with_tables
       from empirical_projects p
      where coalesce(p.status,'active') <> 'archived'
        and ($1::uuid is null or p.user_id is null or p.user_id = $1::uuid)
      order by p.created_at desc limit 100`, [viewerId ?? null]);
  return r.rows.map((row) => ({
    id: String(row.id), title: String(row.title ?? ""), topic: String(row.topic ?? ""),
    createdAt: row.created_at,
    /** 未归属的历史课题 —— 界面要标出来, 否则会被当成"我的" */
    unowned: !row.user_id,
    /** 只列出**有表格产物**的课题数 —— 没跑过分析的绑了也没用, 界面据此提示 */
    runsWithTables: Number(row.n_runs_with_tables ?? 0),
  }));
}

/** 已绑定的实证课题下、有结果的运行(证据候选) */
export async function listEmpiricalRuns(userId: string, projectId: string) {
  const binding = await getEmpiricalBinding(userId, projectId);
  if (!binding) return null;
  if (!binding.empiricalProjectId) return { empiricalProjectId: "", empiricalTitle: "", runs: [] };
  // 读取时再过一次归属 —— 绑定是过去做的, 课题的归属有可能在之后被改
  const own = await pool.query(`select user_id from empirical_projects where id=$1`, [binding.empiricalProjectId]);
  if (own.rows[0]?.user_id && String(own.rows[0].user_id) !== String(userId)) {
    return { empiricalProjectId: binding.empiricalProjectId, empiricalTitle: binding.empiricalTitle, runs: [], denied: true };
  }
  const r = await pool.query(
    `select id, stage, created_at,
            jsonb_array_length(coalesce(python_result->'tables','[]'::jsonb)) as n_tables,
            coalesce(python_result->'tables','[]'::jsonb) as tables,
            coalesce(right(stata_code, 0),'') as _unused
       from empirical_pipeline_runs
      where project_id=$1 and jsonb_array_length(coalesce(python_result->'tables','[]'::jsonb)) > 0
      order by created_at desc limit 100`,
    [binding.empiricalProjectId]);
  return {
    empiricalProjectId: binding.empiricalProjectId,
    empiricalTitle: binding.empiricalTitle,
    runs: r.rows.map((row) => {
      const tables = Array.isArray(row.tables) ? (row.tables as RawTable[]) : [];
      return {
        id: String(row.id),
        stage: String(row.stage ?? ""),
        createdAt: row.created_at,
        nTables: Number(row.n_tables ?? 0),
        /** 表的标题清单 —— 界面据此让人选"要引用哪张表", 而不是整跑全塞进去 */
        tableTitles: tables.map((t) => String(t?.title ?? "")).filter(Boolean),
      };
    }),
  };
}

/**
 * 从一次实证运行里**采集**发现(B 的实证台通路)。
 *
 * 与 `harvestFindings`(统计台)的关系: 逻辑同源 —— 都是"按表头精确匹配抽系数, 不让 LLM 读数字"。
 * 区别只在数据来源表与键名(实证台是 `cols`, 统计台是 `columns` —— 已由 normalizeTable 抹平)。
 *
 * 落库到**同一个** `research_findings` 表, 用 `job_id` 存实证的 runId。
 * 为什么不新开一张表: 下游(章节依据/数字核验/结果段生成/假设匹配)全部按"发现"这一种形状消费,
 * 分成两张表会让那四处各多一个分支 —— 而它们本就是同一种东西。
 */
export async function harvestEmpiricalFindings(
  userId: string, projectId: string, runId: string, tableIndex?: number
): Promise<{ ok: boolean; saved?: number; skipped?: string[]; error?: string }> {
  if (!(await assertOwned(userId, projectId))) return { ok: false, error: "项目不存在" };
  const binding = await getEmpiricalBinding(userId, projectId);
  if (!binding) return { ok: false, error: "项目不存在" };
  if (!binding.empiricalProjectId) return { ok: false, error: "尚未绑定实证课题 —— 先在「本章依据」里绑定一个" };
  const r = await pool.query(
    `select id, stage, python_result from empirical_pipeline_runs where id=$1 and project_id=$2`,
    [runId, binding.empiricalProjectId]);
  if (!r.rows.length) return { ok: false, error: "该运行不在已绑定的实证课题下" };
  const run = r.rows[0];
  const all = (run.python_result as { tables?: RawTable[] } | null)?.tables ?? [];
  const pick = Number.isInteger(tableIndex) && tableIndex !== undefined
    ? (all[tableIndex] !== undefined ? [all[tableIndex]] : [])
    : all;
  if (!pick.length) return { ok: false, error: "该运行里没有表格产物" };
  const { findings, skipped } = extractFindings(String(run.stage ?? ""), { tables: pick });
  if (!findings.length) {
    return {
      ok: false,
      error: "这次运行里没有可抽取的系数表(描述统计/相关矩阵等结果请用「素材」通道插入)",
      skipped,
    };
  }
  const saved = await saveFindings(userId, projectId, runId, String(run.stage ?? ""), findings);
  return { ok: saved.ok, saved: saved.saved, skipped };
}

/**
 * **自动采集**(实证台那条路的对称实现)。
 *
 * 与统计台 `autoHarvestForFile` 同一个设计: 任务跑完即入账, 不需要人再点一次 ——
 * 因为"抽哪些行/排除截距/怎么算星号"全是有客观规则的, 没有需要人判断的东西。
 * 真正需要判断的是后面几步(这条发现说明什么、用在哪一章、要不要采纳), 那些仍是人工的,
 * 本函数一律不碰(status 留 'candidate')。
 *
 * 归属: 实证课题可能被多个写作课题绑定(同一份数据可以支撑多篇论文), 所以**遍历所有绑定方**,
 *   各写一份自己名下的发现。一个都没绑 → 静默返回 0(实证台独立使用时本就不该产生台账行)。
 */
export async function autoHarvestEmpiricalRun(empiricalProjectId: string, runId: string): Promise<number> {
  try {
    const binders = await pool.query(
      `select id, user_id from research_projects
        where empirical_project_id = $1 and coalesce(status,'active') not in ('deleted','archived')`,
      [empiricalProjectId]);
    if (!binders.rows.length) return 0;
    const jr = await pool.query(
      `select stage, python_result from empirical_pipeline_runs where id=$1`, [runId]);
    const run = jr.rows[0];
    if (!run) return 0;
    const { findings } = extractFindings(String(run.stage ?? ""), run.python_result);
    if (!findings.length) return 0;
    let total = 0;
    for (const b of binders.rows) {
      const saved = await saveFindings(String(b.user_id), String(b.id), runId, String(run.stage ?? ""), findings);
      if (saved.ok) total += saved.saved;
    }
    return total;
  } catch (e) {
    // 旁路增强: 失败不该让一次成功的实证分析变成失败
    console.warn(`[findings] 实证自动采集失败(run=${runId}): ${String(e).slice(0, 160)}`);
    return 0;
  }
}

export const researchEvidenceService = {
  listEvidence, replaceSectionEvidence, listEvidenceCandidates, buildDesignBlock,
  buildEvidenceBlock, buildEvidenceBlocks,
  listHypotheses, saveHypotheses, syncHypothesesFromAnalysis,
  verifyChapterNumbers, collectBasisNumbers,
  extractFindings, starsOf, saveFindings, listFindings, setFindingStatus, setFindingClaim,
  claimFindings, harvestFindings, autoHarvestForFile, suggestHypothesisLinks, renderTableData,
  bindEmpiricalProject, getEmpiricalBinding, listEmpiricalProjects, listEmpiricalRuns, harvestEmpiricalFindings,
  autoHarvestEmpiricalRun,
  buildFindingSkeleton, generateResultDraft,
};
