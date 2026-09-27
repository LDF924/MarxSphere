// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
/**
 * checkup-service.ts — 中期检查 / 结项验收：上传检查表 → 逐项对着填 → 缺失项明确留空。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 由来（2026-09-27 用户拍板）
 *
 * 这两项此前被**明确排除**在补齐计划之外，计划里给的理由是"那些是项目管理不是研究"。
 * **这条理由站不住**（我自己写的）：按它推，批6（评审返修）与批9（录用出版）同样
 * 不是"研究"，但那两批都做了。真正的分界线是另一条，而且是本仓反复验证过的一条 ——
 *
 *   **这件事的数据在不在平台手上。**
 *
 * 中期检查要的是"学院/学校给的那张检查表"，结项验收要的是"项目结项书模板 + 成果认定口径"，
 * 平台一样都没有。没有数据来源而硬做的功能，做出来就是"生成一段放之四海皆准的套话"，
 * 用户把它填进真实表格会被打回来。这与批9 否掉"让模型写版权声明"是同一条判据
 * （见 post-acceptance.ts 开头那段）。
 *
 * 所以这两项现在做，但形态是**四步，没有一步是"让模型写"**：
 *
 *   ① 用户**上传或粘贴**自己那份检查表（平台不猜模板）；
 *   ② 平台把它**拆成条目**（启发式，与 review-response-service.splitReviewComments 同源）；
 *   ③ 逐项三分类：
 *        · `auto`             —— 平台有真数据，**从项目现算**并标明来源；
 *        · `manual`           —— 平台没有，**明确留空**等用户填；
 *        · `platform_missing` —— 平台**结构上就不记录**这类内容（经费/签字/专家意见），
 *                                要显式说出来，否则用户会以为是"没做好"；
 *   ④ 导出成 Markdown / Word 交上去。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ⚠ 三条不能违反的约束（每一条都对应本仓踩过的一个坑）
 *
 * 1. **`auto` 的值一律现算，不存快照。**
 *    存快照必然漂移，而"检查表里写着 12 章、实际有 15 章"是会被受理方当场抓出来的。
 *    库里存的 items 只是**条目结构与用户手填的值**；auto 项每次读取时重算
 *    （`reclassify`）。用户改过的 auto 项带 `edited` 标记，不再被重算覆盖。
 *
 * 2. **auto 的值只来自可核验的真数据**，且**逐项标明来源**。
 *    没有来源的自动填写等于伪造 —— 用户拿着它去交差，出问题时连"这个数字哪来的"都答不上。
 *
 * 3. **绝不退回"让 AI 生成一份"**。
 *    这里从头到尾没有 LLM 调用。真要润色，那是用户填完之后的事，不是这里的职责。
 */
import { pool } from "../db/pool.js";
import * as researchPipeline from "./research-pipeline-service.js";
import * as researchMaterials from "./research-materials-service.js";
import * as researchEvidence from "./research-evidence-service.js";
import * as reviewResponse from "./review-response-service.js";
import { stageTitle } from "./research-stages.js";

export type CheckupKind = "midterm" | "final";
export const CHECKUP_KINDS: readonly CheckupKind[] = Object.freeze(["midterm", "final"]);

export const CHECKUP_CN: Readonly<Record<CheckupKind, string>> = Object.freeze({
  midterm: "中期检查",
  final: "结项验收",
});

/**
 * 条目的三种去向。
 *
 * `platform_missing` 与 `manual` 分开，是因为**两者对用户的含义完全不同**：
 *   · manual —— "平台没查到，你自己填"（可能填得出来，也可能平台没做那一步）；
 *   · platform_missing —— "这类内容平台结构上就不记录"（经费、签字、专家意见）。
 * 合成一类会让用户对着一个空框反复找"是不是哪里没填"。
 */
export type ItemKind = "auto" | "manual" | "platform_missing";

export interface CheckupItem {
  /** 序号，导出时用；用户重排不影响语义 */
  seq: number;
  /** 所属小节（检查表里"一、研究工作进展情况"这类），没有则为空串 */
  section: string;
  /** 检查项原文 */
  label: string;
  kind: ItemKind;
  /** 填写内容。auto 项由平台现算，manual/platform_missing 项由用户填 */
  value: string;
  /** auto 项的来源说明（"项目元数据" / "章节节点" / …）。非 auto 为空串 */
  autoSource: string;
  /** 用户手改过 —— 重算时不再覆盖 */
  edited?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// ① 拆条
// ═══════════════════════════════════════════════════════════════

/**
 * 把一份检查表拆成条目。
 *
 * **为什么是启发式而不是 LLM**：检查表是**格式**问题不是**理解**问题，而且
 * 拆错了后果很重 —— 漏掉一行 = 该交的一项没交。启发式即时、可复核、结果稳定，
 * 而 LLM 拆条会改写原文，用户拿去对着学校那份表逐行核时就对不上了。
 * （与 review-response-service 拆审稿意见同一条理由，见那边的长注释。）
 *
 * 兼容三种真实来源：
 *   · 从 Word/PDF 里复制出来的**纯文本**（带"一、二、三"或"1. 2. 3."编号）；
 *   · 从 Excel/网页表格复制出来的 **Tab 分隔**（一个格子一行）；
 *   · **Markdown 表格**（`| 序号 | 检查内容 |`）。
 *
 * 判错的每一种都退化成"少拆几条"或"多拆几条"，用户在前端可逐条改/删 ——
 * 这条退路必须留着，因为检查表的排版没有标准。
 */
export function parseChecklistItems(raw: string): Array<{ section: string; label: string }> {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return [];

  const lines = text.split("\n").map(normalizeLine).filter((l): l is NormLine => l !== null);

  /**
   * 这份表**有没有编号**决定了无编号行怎么处理 —— 这是本函数唯一一处必须猜的地方，
   * 所以把判据写死成一条可陈述的规则，而不是逐行去猜"这行像不像条目"：
   *
   *   · **有编号**（`1.` / `一、` / `①` …）⇒ 编号就是条目分隔符，
   *     无编号的行是**上一项的折行**（PDF 抽出来的文本、Word 里长条目换行都是这样），
   *     并进上一项 —— 并进去顶多是"两行粘在一起"（用户逐项核对该看得到），
   *     而拆出来会凭空多一个看着像检查项的杂行。
   *   · **完全没编号** ⇒ 那它就是个纯列表，**每行一个条目**。
   *
   * ⚠ 实测踩过一次相关的坑：`1. 项目名称` 曾被"短且无句读 ⇒ 小节标题"判成小节，
   *   11 条全塌成 1 条 —— 所以下面小节判定改成了**按编号样式**（中文数字 vs 阿拉伯数字），
   *   不再按长度。
   */
  const numbered = lines.some((l) => stripItemPrefix(l.line) !== null);

  const out: Array<{ section: string; label: string }> = [];
  let section = "";
  let sectionCount = 0;

  for (const { line, fromTable } of lines) {
    const stripped = stripItemPrefix(line);
    if (stripped) {
      const body = stripped.body.trim();
      /**
       * 小节标题 vs 检查项 —— **按编号样式判，不按长度判**。
       *
       * 中文公文里 `一、二、三` 是小节、`1. 2. 3.` 是条目的约定比长度可靠得多。
       * （第一版按长度判，实测把整份检查表判塌了，见上面 `numbered` 那段注释。）
       */
      if (stripped.style === "cn" && cnLen(body) <= 20 && !/[：:？?，,。；;]/.test(body)) {
        section = body;
        sectionCount++;
        continue;
      }
      if (body) out.push({ section, label: body.slice(0, 300) });
      continue;
    }

    // 无编号。表格里每行是独立一格 ⇒ 各自成项；纯文本里有编号 ⇒ 是折行，并进上一条
    if (fromTable) {
      if (line) out.push({ section, label: line.slice(0, 300) });
      continue;
    }
    if (numbered) {
      /**
       * ⚠ 并到 **out 的最后一条**，不是"当前待写条目"—— 编号行是直接 push 出去的，
       *   所以这里没有"当前条目"这个状态。第一版写成了后者，于是折行落进
       *   `cur === null` 的岔路、被当成新条目 push 出去，`1. …` + 折行变成了两条
       *   （单测先红，见 `小数开头的续行` 那条）。
       */
      const last = out[out.length - 1];
      if (last) last.label = `${last.label} ${line}`.slice(0, 300);
      // 编号还没出现过时的散句（如"根据学校通知，现提交如下材料"）—— 单起一条，不丢
      else if (cnLen(line) >= 4) out.push({ section, label: line.slice(0, 300) });
      continue;
    }
    // 纯列表：每行一条
    if (cnLen(line) >= 2 || line.length >= 8) out.push({ section, label: line.slice(0, 300) });
  }

  /**
   * 自纠：**只有小节、没有条目** ⇒ 那些"小节"其实就是条目。
   *
   * 有些检查表通篇用 `一、二、三` 编号（没有 `1. 2.` 这一层），按上面的约定会被全部
   * 判成小节、一个条目都不剩 —— 然后掉进下面的"整段当一条"兜底，得到一条吃掉全文的条目，
   * 而**界面上看着像"这份表只有一项"**，正是我第一版实测到的那个症状。
   * 这里显式兜住：宁可把它们当条目，也不要塌成一条。
   */
  if (!out.length && sectionCount) {
    for (const rawLine of text.split("\n")) {
      const s = stripItemPrefix(rawLine.trim());
      if (s?.body.trim()) out.push({ section: "", label: s.body.trim().slice(0, 300) });
    }
  }

  // 全篇没拆出任何编号时**整段当一条**（与 splitReviewComments 同一条退路：
  //   用户可能只是粘了一小段要点，硬拆只会把一句话拦腰截断）
  if (!out.length) {
    const one = text.trim().slice(0, 8000);
    if (one) out.push({ section: "", label: one });
  }
  return out.slice(0, 200);
}

interface NormLine { line: string; fromTable: boolean }

/** 把原始行规整成 {文本, 是否来自表格}；空白行/分隔行返回 null */
function normalizeLine(rawLine: string): NormLine | null {
  let line = rawLine.trim();
  if (!line) return null;
  // Markdown 表格的分隔行 `|---|---|`
  if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes("-")) return null;
  if (line.includes("\t")) {
    const cell = pickTableCell(line.split("\t"));
    return cell ? { line: cell, fromTable: true } : null;
  }
  if (line.startsWith("|")) {
    const cell = pickTableCell(line.replace(/^\|/, "").replace(/\|$/, "").split("|"));
    return cell ? { line: cell, fromTable: true } : null;
  }
  return { line, fromTable: false };
}

/** 表头词 —— 表格粘贴时这些格子不是检查项，却不巧常常"中文最多" */
const HEADER_WORDS = /^(序号|编号|检查内容|检查项|内容|填写|填写情况|情况|备注|说明|项目|标准|分值|得分|自评|审核|材料|要求)$/;

/**
 * 从一行表格里挑出"检查项"那一格。
 *
 * 判据是**中文最多**（序号格是数字、填写格通常是空的），再排除表头词。
 * 挑不出（整行都是序号/空白）就返回空串，调用方据此跳过。
 */
function pickTableCell(cells: string[]): string {
  const cands = cells.map((c) => c.trim()).filter((c) => c && !HEADER_WORDS.test(c));
  if (!cands.length) return "";
  const best = cands.slice(0, 4).sort((a, b) => cnLen(b) - cnLen(a))[0] ?? "";
  return best.length >= 2 ? best : "";
}

function cnLen(s: string): number {
  return (String(s).match(/[一-龥]/g) ?? []).length;
}

/**
 * 命中编号则返回**去掉编号后**的正文与**编号样式**，否则 null。
 *
 * `style` 的用途见 `parseChecklistItems`：`cn`（中文数字）按小节处理，
 * 其余按条目处理。第一版没有这个返回值，要靠长度猜，实测把整份表判塌了。
 */
function stripItemPrefix(line: string): { body: string; style: "cn" | "arabic" | "other" } | null {
  const s = line.replace(/^\s+/, "");
  // 加粗编号（`**1.**`）必须排在普通数字前判 —— 否则会留下 `** 标题过长`
  //   （review-response-service 那边踩过，见它 stripItemPrefix 的长注释）
  const bold = s.match(/^(?:\*\*|__)\s*(\d{1,3})\s*(?:[.、．])?\s*(?:\*\*|__)\s*/);
  if (bold) return { body: s.slice(bold[0].length), style: "arabic" };
  // 括号编号：含中文数字的按小节判（（一）（二）），含阿拉伯数字/圈号的按条目判
  let m = s.match(/^[(（]\s*([一二三四五六七八九十]{1,3})\s*[)）]\s*/);
  if (m) return { body: s.slice(m[0].length), style: "cn" };
  m = s.match(/^[(（]\s*(?:\d{1,3}|[①②③④⑤⑥⑦⑧⑨⑩])\s*[)）]\s*/);
  if (m) return { body: s.slice(m[0].length), style: "arabic" };
  // 圈号: ①②③
  m = s.match(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/);
  if (m) return { body: s.slice(m[0].length), style: "other" };
  // 中文数字 + 顿号/句点 → **小节**；阿拉伯数字 + 顿号/句点 → 条目
  m = s.match(/^([一二三四五六七八九十]{1,3})[、．.]\s*/);
  if (m) return { body: s.slice(m[0].length), style: "cn" };
  /**
   * 阿拉伯数字编号 —— **点号后必须跟空白/行尾/中文**。
   *
   * ⚠ 没有这个前瞻时 `3.5 的系数值见上表` 会被判成"编号 3"，切掉 `3.` 留下 `5 的系数值…`
   *   —— 凭空多出一条看着像检查项的杂行。实测就是这么发现的（单测先红）。
   *   加了前瞻后 `3.5`（点后是数字）不匹配，而 `3. 标题` / `3.标题` / `3、标题` 都匹配。
   */
  m = s.match(/^(\d{1,3})[、．.](?=\s|$|[一-龥])/);
  if (m) return { body: s.slice(m[0].length), style: "arabic" };
  // 「第 1 项」「检查项 1」
  m = s.match(/^(?:第|检查项|item)\s*\d{1,3}\s*[项条:]?\s*/i);
  if (m) return { body: s.slice(m[0].length), style: "arabic" };
  return null;
}

// ═══════════════════════════════════════════════════════════════
// ② 项目真数据 —— auto 项的唯一来源
// ═══════════════════════════════════════════════════════════════

interface ProjectFacts {
  title: string;
  phase: number;
  phaseTitle: string;
  createdAt: string;
  updatedAt: string;
  sectionsTotal: number;
  sectionsWithText: number;
  materialsTotal: number;
  citations: number;
  dataResults: number;
  figures: number;
  hypothesesTotal: number;
  hypothesesSettled: number;
  findingsTotal: number;
  findingsAdopted: number;
  proposalDocs: string[];
  submissionsBrief: string;
  acceptedCount: number;
  followupsTotal: number;
  versionsTotal: number;
}

/** 只取本地年月日 —— date/timestamptz 走 toISOString 在东八区会退一天 */
function ymd(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v ?? ""));
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 把项目散在各处的真实状态收齐。
 *
 * 每一样都是**已经存在的接口/表**，没有为这个功能新造字段 ——
 * 检查表要的"进度、成果、材料"本来就在库里，只是此前没有一个地方把它们并排摆出来。
 * 读不到的（某张表还没数据）按 0 处理并在来源里如实说明，**不猜**。
 */
async function gatherFacts(userId: string, projectId: string): Promise<ProjectFacts | null> {
  const p = await pool.query(
    `select title, phase, created_at, updated_at from research_projects where id=$1 and user_id=$2`,
    [projectId, userId]);
  const row = p.rows[0];
  if (!row) return null;

  /**
   * 章节数取自 `sections` 节点（与 PhaseProgressBar 的 metric 同一口径）。
   *
   * ⚠ 已生成的判据必须是"有没有正文"，**不能只看 status 词汇** ——
   *   后端 analyze / runChapterBatch 写 `"done"`，前端多处写 `"generated"`，
   *   两套词汇没统一（PhaseProgressBar 里为这条踩过坑）。有正文（>50 字）才算。
   */
  const sectionsNode = await researchPipeline.getNode(userId, projectId, "sections").catch(() => null);
  const sections = (sectionsNode?.payload as { sections?: unknown[] } | undefined)?.sections ?? [];
  const secList = (Array.isArray(sections) ? sections : []) as Array<{ content?: string; status?: string; children?: unknown[] }>;
  const sectionsTotal = secList.length;
  const sectionsWithText = secList.filter(
    (s) => String(s?.content ?? "").length > 50 || s?.status === "generated" || s?.status === "done").length;

  const mats = await researchMaterials.listMaterials(userId, projectId).catch(() => []);
  const matList = (Array.isArray(mats) ? mats : []) as Array<{ kind?: string }>;
  const byKind = (k: string) => matList.filter((m) => String(m?.kind ?? "") === k).length;

  const hyp = await researchEvidence.listHypotheses(userId, projectId).catch(() => null);
  const hypList = (hyp?.hypotheses ?? []) as Array<{ verdict?: string }>;
  const fnd = await researchEvidence.listFindings(userId, projectId).catch(() => null);
  const fndList = (fnd?.findings ?? []) as Array<{ status?: string }>;

  const propNode = await researchPipeline.getNode(userId, projectId, "proposal").catch(() => null);
  const propPayload = (propNode?.payload ?? {}) as Record<string, { content?: string; title?: string }>;
  const PROPOSAL_CN: Record<string, string> = { proposal: "开题报告", grant: "基金申报书", ethics: "伦理审查材料", prereg: "预注册方案" };
  const proposalDocs = Object.keys(PROPOSAL_CN)
    .filter((k) => String(propPayload[k]?.content ?? "").trim().length > 0)
    .map((k) => PROPOSAL_CN[k]);

  const subs = await reviewResponse.listSubmissions(userId, projectId).catch(() => null);
  const subList = (subs?.submissions ?? []) as Array<{ journalName?: string; status?: string; round?: number }>;
  const SUB_CN: Record<string, string> = {
    submitted: "已投出", under_review: "外审中", revision_requested: "返修中",
    accepted: "已录用", rejected: "已退稿", withdrawn: "已撤稿",
  };
  const submissionsBrief = subList.length
    ? subList.map((s) => `《${String(s.journalName || "未填刊名")}》${SUB_CN[String(s.status)] ?? String(s.status)}（第${Number(s.round) || 1}轮）`).join("；")
    : "";
  const acceptedCount = subList.filter((s) => s.status === "accepted").length;

  const fu = await reviewResponse.listFollowups(userId, projectId).catch(() => null);
  const versions = await researchPipeline.listVersions(userId, projectId).catch(() => []);

  return {
    title: String(row.title ?? ""),
    phase: Number(row.phase ?? 0),
    phaseTitle: stageTitle(Number(row.phase ?? 0)) || "尚未推进",
    createdAt: ymd(row.created_at),
    updatedAt: ymd(row.updated_at),
    sectionsTotal,
    sectionsWithText,
    materialsTotal: matList.length,
    citations: byKind("citation"),
    dataResults: byKind("data_result"),
    figures: byKind("figure"),
    hypothesesTotal: hypList.length,
    hypothesesSettled: hypList.filter((h) => String(h?.verdict ?? "pending") !== "pending").length,
    findingsTotal: fndList.length,
    findingsAdopted: fndList.filter((f) => String(f?.status ?? "") === "adopted").length,
    proposalDocs,
    submissionsBrief,
    acceptedCount,
    followupsTotal: (fu?.followups ?? []).length,
    versionsTotal: Array.isArray(versions) ? versions.length : 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// ③ 三分类 —— 逐项判断平台能不能填
// ═══════════════════════════════════════════════════════════════

interface Rule {
  /** 命中即用这条（按顺序，先命中者胜） */
  re: RegExp;
  /** 从真数据里取值的函数；返回 null 表示"这类事平台没有"，退成 manual */
  resolve: (f: ProjectFacts) => { value: string; source: string } | null;
}

/**
 * 平台**结构上就不记录**的内容 —— 不是"还没做"，是"不该由这里记"。
 *
 * 这一类的存在本身就是产品决策：把这些如实标出来，用户才不会对着一个空框
 * 反复找"是不是哪一步没做"。**它们不该被"补上"** —— 平台的边界在此。
 */
const PLATFORM_MISSING_RE = /经费|预算|决算|报销|支出|到账|专家意见|评审组意见|学院意见|指导教师意见|导师意见|签字|盖章|审批|财务|考核等级|评分|等第/;

/**
 * 自动填写规则表。
 *
 * ⚠ **每一条的 `source` 必须指向真实存在的东西** —— 用户拿着导出去交差，
 *   被问到"这个数字哪来的"时要答得上。没有来源的自动填写等于伪造。
 *
 * ⚠ **顺序有意义，而且实测踩过**：`/文献/` 排在 `/收集/` 前面时，
 *   "文献资料收集情况" 会落到"文献条数"那条上 —— 而检查表里那一项问的是
 *   **你收集到什么程度**，不是"库里有几条"。填一个小得多的数进去，用户当场看不出错。
 *   所以**越具体、越能反映真实意图的规则排在越前面**，宽泛的兜在后面。
 *   加新规则时先问一句：它会不会抢走已有规则该管的项。
 */
const RULES: readonly Rule[] = Object.freeze([
  { re: /题目|课题名称|项目名称|论文标题|研究名称/, resolve: (f) => ({ value: f.title, source: "项目元数据" }) },
  {
    re: /起止|周期|开题|立项时间|研究时间|开始时间|结束时间/,
    // 平台只有"创建日期"，没有合同上的计划起止 —— 所以这里**只填一半**，
    //   另一半显式留成"（待填）"。宁可半空，不可编一个日期上去。
    resolve: (f) => ({ value: `开始：${f.createdAt}（平台登记日期）；结束：（待填）`, source: "项目元数据（仅创建日期）" }),
  },
  // 数据收集先于文献：两者都可能含"资料"二字，而这一条更具体
  { re: /数据|样本|调查|数据集|统计/, resolve: (f) => ({ value: `${f.dataResults} 条数据分析结果素材`, source: "研究素材库" }) },
  { re: /收集|资料汇总|素材/, resolve: (f) => ({ value: `素材库共 ${f.materialsTotal} 条（文献 ${f.citations} · 数据结果 ${f.dataResults} · 图表 ${f.figures}）`, source: "研究素材库" }) },
  { re: /章节|目录|结构|篇幅|框架/, resolve: (f) => ({ value: `共 ${f.sectionsTotal} 章，其中 ${f.sectionsWithText} 章已写出正文`, source: "sections 节点" }) },
  { re: /文献|参考资料|引文|参考书目/, resolve: (f) => ({ value: `${f.citations} 条文献素材（项目内素材合计 ${f.materialsTotal} 条）`, source: "研究素材库" }) },
  { re: /图表|绘图|图件/, resolve: (f) => ({ value: `${f.figures} 张图表素材`, source: "研究素材库" }) },
  {
    re: /假设|检验/,
    resolve: (f) => (f.hypothesesTotal ? { value: `共 ${f.hypothesesTotal} 条，已判定 ${f.hypothesesSettled} 条`, source: "假设检验台账" } : null),
  },
  {
    re: /发现|结果|结论|成果内容|主要研究/,
    resolve: (f) => (f.findingsTotal ? { value: `共 ${f.findingsTotal} 条研究发现，其中 ${f.findingsAdopted} 条已采纳进正文`, source: "研究发现台账" } : null),
  },
  {
    re: /开题|申报|伦理|预注册|已交材料|已提交材料/,
    resolve: (f) => (f.proposalDocs.length ? { value: f.proposalDocs.join("、"), source: "申报与审查（proposal 节点）" } : null),
  },
  {
    re: /录用|投稿|发表|见刊|期刊|外审/,
    resolve: (f) => (f.submissionsBrief ? { value: f.submissionsBrief, source: "投稿记录" } : null),
  },
  {
    re: /转载|转化|社会影响|被引|采纳情况|应用/,
    resolve: (f) => (f.followupsTotal ? { value: `${f.followupsTotal} 条成果转化 / 后续方向记录`, source: "录用与传播" } : null),
  },
  { re: /版本|过程记录|存档|留档/, resolve: (f) => ({ value: `${f.versionsTotal} 个已发布版本`, source: "版本历史" }) },
  /**
   * 进度类。
   *
   * ⚠ 注意 `phase` 的语义：它是**"用户按到哪一步了"**，不是"做完了什么"——
   *   `stores/workflow.ts` 的 `setPhase` 只在各页的「确认」按钮里 +1（PhaseProgressBar 里
   *   有这条的长注释）。所以平台**答得了**"现在这一步是哪一步"，
   *   **答不了**"做到几成、有没有滞后" —— 后者要合同里的计划节点，平台没有。
   *   因此这条规则写得**刻意保守**：只报阶段名 + 平台登记的最后更新时间，不给任何
   *   "已完成 ×%" 之类的判断。探针为此专门有一条断言（进度项不得报"完成度"）。
   */
  { re: /进度|进展|完成情况|执行情况|阶段/, resolve: (f) => ({ value: `当前阶段：${f.phaseTitle}（平台登记的最后更新 ${f.updatedAt}）`, source: "项目阶段" }) },
]);

/** 单个条目的三分类。auto 之外一律 label 原样、value 留空 —— **绝不编内容**。 */
function classify(label: string, facts: ProjectFacts): { kind: ItemKind; value: string; autoSource: string } {
  const s = String(label ?? "");
  for (const r of RULES) {
    if (!r.re.test(s)) continue;
    const hit = r.resolve(facts);
    // 规则命中了但**值取不到**（如"假设检验情况"而台账是空的）→ 退 manual 而不是给个"0 条"
    return hit
      ? { kind: "auto", value: hit.value, autoSource: hit.source }
      : { kind: "manual", value: "", autoSource: "" };
  }
  // 规则没命中：先看是不是平台的边界之外，再退到 manual
  if (PLATFORM_MISSING_RE.test(s)) return { kind: "platform_missing", value: "", autoSource: "" };
  return { kind: "manual", value: "", autoSource: "" };
}

/**
 * 重算 auto 项。
 *
 * 每次读取都跑 —— 存快照必然漂移，而"检查表里写着 12 章、实际有 15 章"
 * 是会被受理方当场抓出来的。用户手改过的（`edited`）不动。
 */
function reclassify(items: CheckupItem[], facts: ProjectFacts): CheckupItem[] {
  return items.map((it) => {
    if (it.edited) return it;
    const c = classify(it.label, facts);
    return { ...it, kind: c.kind, value: c.value, autoSource: c.autoSource };
  });
}

// ═══════════════════════════════════════════════════════════════
// ④ 读 / 写
// ═══════════════════════════════════════════════════════════════

export interface CheckupDoc {
  kind: CheckupKind;
  sourceName: string;
  items: CheckupItem[];
  /** 三类的条数 —— 前端与导出都要用，服务端算一次免得两边不一致 */
  counts: { auto: number; manual: number; platformMissing: number };
  updatedAt: string;
  rawText: string;
}

function countOf(items: CheckupItem[]) {
  return {
    auto: items.filter((i) => i.kind === "auto").length,
    manual: items.filter((i) => i.kind === "manual").length,
    platformMissing: items.filter((i) => i.kind === "platform_missing").length,
  };
}

/** 读一份；没有就返回空文档（**不返回 null** —— 空态是正常状态，不是错误） */
export async function getCheckup(userId: string, projectId: string, kind: CheckupKind): Promise<CheckupDoc | null> {
  const owned = await pool.query(`select 1 from research_projects where id=$1 and user_id=$2`, [projectId, userId]);
  if (!owned.rows.length) return null;

  const r = await pool.query(
    `select items, source_name, raw_text, updated_at from research_checkup_documents where project_id=$1 and kind=$2`,
    [projectId, kind]);
  const row = r.rows[0];
  if (!row) {
    return { kind, sourceName: "", items: [], counts: { auto: 0, manual: 0, platformMissing: 0 }, updatedAt: "", rawText: "" };
  }
  const stored = (Array.isArray(row.items) ? row.items : []) as CheckupItem[];
  const facts = await gatherFacts(userId, projectId);
  const items = facts ? reclassify(stored, facts) : stored;
  return {
    kind,
    sourceName: String(row.source_name ?? ""),
    items,
    counts: countOf(items),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ""),
    rawText: String(row.raw_text ?? ""),
  };
}

/**
 * 上传/粘贴一份检查表 → 拆条 → 三分类 → 落库。
 *
 * **替换而非追加**：同一项目同一类只留一份。并排两份会让"我到底该交哪一份"
 * 变成一个真实存在但没人该问的问题。
 */
export async function putCheckup(
  userId: string, projectId: string, kind: CheckupKind, rawText: string, sourceName = ""
): Promise<{ ok: boolean; error?: string; doc?: CheckupDoc }> {
  const owned = await pool.query(`select 1 from research_projects where id=$1 and user_id=$2`, [projectId, userId]);
  if (!owned.rows.length) return { ok: false, error: "项目不存在" };

  const raw = String(rawText ?? "");
  if (!raw.trim()) return { ok: false, error: "检查表内容为空" };
  const parsed = parseChecklistItems(raw);
  if (!parsed.length) return { ok: false, error: "没有从这份检查表里拆出任何检查项" };

  const facts = await gatherFacts(userId, projectId);
  if (!facts) return { ok: false, error: "项目不存在" };
  const items: CheckupItem[] = parsed.map((p, i) => {
    const c = classify(p.label, facts);
    return { seq: i + 1, section: p.section, label: p.label, kind: c.kind, value: c.value, autoSource: c.autoSource };
  });

  await pool.query(
    `insert into research_checkup_documents (project_id, kind, raw_text, source_name, items)
     values ($1,$2,$3,$4,$5::jsonb)
     on conflict (project_id, kind) do update
       set raw_text=excluded.raw_text, source_name=excluded.source_name,
           items=excluded.items, updated_at=now()`,
    [projectId, kind, raw.slice(0, 200_000), String(sourceName ?? "").slice(0, 200), JSON.stringify(items)]);

  return { ok: true, doc: (await getCheckup(userId, projectId, kind)) ?? undefined };
}

/**
 * 改一项的填写内容（用户手填，或覆盖平台算出来的值）。
 *
 * 打 `edited` 标记 —— 否则下一次读取的重算会**把用户改的值悄悄冲掉**，
 * 而用户那边表现为"填了、刷新就没了"（本仓最典型的一类静默失效）。
 */
export async function setItemValue(
  userId: string, projectId: string, kind: CheckupKind, seq: number, value: string
): Promise<{ ok: boolean; error?: string; doc?: CheckupDoc }> {
  const owned = await pool.query(`select 1 from research_projects where id=$1 and user_id=$2`, [projectId, userId]);
  if (!owned.rows.length) return { ok: false, error: "项目不存在" };
  const r = await pool.query(
    `select items from research_checkup_documents where project_id=$1 and kind=$2`, [projectId, kind]);
  const stored = (Array.isArray(r.rows[0]?.items) ? r.rows[0].items : []) as CheckupItem[];
  if (!stored.length) return { ok: false, error: "还没有这份检查表，请先上传" };

  let hit = false;
  const next = stored.map((it) => {
    if (Number(it.seq) !== Number(seq)) return it;
    hit = true;
    return { ...it, value: String(value ?? "").slice(0, 8000), edited: true };
  });
  if (!hit) return { ok: false, error: `第 ${seq} 项不存在` };

  await pool.query(
    `update research_checkup_documents set items=$3::jsonb, updated_at=now() where project_id=$1 and kind=$2`,
    [projectId, kind, JSON.stringify(next)]);
  return { ok: true, doc: (await getCheckup(userId, projectId, kind)) ?? undefined };
}

/** 删掉整份（重新上传前的清空，或存错了） */
export async function deleteCheckup(userId: string, projectId: string, kind: CheckupKind): Promise<{ ok: boolean }> {
  const owned = await pool.query(`select 1 from research_projects where id=$1 and user_id=$2`, [projectId, userId]);
  if (!owned.rows.length) return { ok: false };
  await pool.query(`delete from research_checkup_documents where project_id=$1 and kind=$2`, [projectId, kind]);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// ⑤ 导出
// ═══════════════════════════════════════════════════════════════

/**
 * 导出成 Markdown（可再转 Word）。
 *
 * 格式上有一处是**刻意的**：每一个 `auto` 项后面都跟着 `【来源：…】`。
 * 用户拿去交差，被问到"这个数字哪来的"要答得上 —— 也让用户自己一眼看出
 * 哪些是平台查的、哪些是自己填的。`platform_missing` 另起一段集中列出，
 * 免得用户以为是"漏填了"。
 */
export function exportCheckupMarkdown(doc: CheckupDoc, title = ""): string {
  const cn = CHECKUP_CN[doc.kind] ?? doc.kind;
  const head = title ? `# ${title} · ${cn}` : `# ${cn}`;
  const lines = [head, ""];
  if (doc.sourceName) lines.push(`> 检查表来源：${doc.sourceName}`, "");

  let curSection = "__none__";
  for (const it of doc.items) {
    if (it.section !== curSection) {
      curSection = it.section;
      lines.push("", `## ${curSection || "检查项"}`, "");
    }
    const src = it.kind === "auto" && it.autoSource ? `　【来源：${it.autoSource}】` : "";
    const val = String(it.value ?? "").trim() || "（待填）";
    lines.push(`- **${it.label}**：${val}${src}`);
  }

  const missing = doc.items.filter((i) => i.kind === "platform_missing");
  if (missing.length) {
    lines.push("", "---", "", "## 平台不记录、需线下补齐的项", "");
    lines.push("以下内容平台结构上就不记录（经费 / 签字 / 专家意见等），导出的表里**留空**，请线下补：", "");
    for (const m of missing) lines.push(`- ${m.label}`);
  }
  const manual = doc.items.filter((i) => i.kind === "manual");
  if (manual.length) {
    lines.push("", `> 另有 ${manual.length} 项平台没有对应数据，已在表中留空待填。`, "");
  }
  return lines.join("\n");
}

/**
 * 同一份内容、给 docx 生成器的结构（`/paper-outline/export` 的 `nodes` 形状）。
 *
 * **为什么在后端出这个结构而不是让前端把 Markdown 再解析一遍**：
 * 两条导出路径（md 与 docx）必须同源。前端各写一份拼装逻辑，迟早出现
 * "网页复制出来有来源标注、Word 里没有" —— 而两者都叫"导出"，用户不会想到是两段代码。
 * （本仓在投稿声明那处已经踩过完全一样的坑：前端 md/html 与后端 docx 是两条独立路径。）
 *
 * 每节一个 node，节内所有条目拼进 `content` —— 检查表是给人逐行看的表格，
 * 把每一项都做成标题会让 Word 里满屏大字号。
   */
export function exportCheckupDocxNodes(doc: CheckupDoc, title = ""): Array<{ title: string; level: number; content: string; children?: unknown[] }> {
  const cn = CHECKUP_CN[doc.kind] ?? doc.kind;
  const nodes: Array<{ title: string; level: number; content: string }> = [];
  const head = title ? `${title} · ${cn}` : cn;
  const meta = doc.sourceName ? `检查表来源：${doc.sourceName}` : "";
  nodes.push({ title: head, level: 1, content: meta });

  let curSection = "__none__";
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    nodes.push({ title: curSection === "__none__" ? "检查项" : curSection, level: 2, content: buf.join("\n") });
    buf = [];
  };
  for (const it of doc.items) {
    if (it.section !== curSection) { flush(); curSection = it.section; }
    const src = it.kind === "auto" && it.autoSource ? `【来源：${it.autoSource}】` : "";
    const val = String(it.value ?? "").trim() || "（待填）";
    buf.push(`· ${it.label}：${val}${src}`);
  }
  flush();

  const missing = doc.items.filter((i) => i.kind === "platform_missing");
  if (missing.length) {
    nodes.push({
      title: "平台不记录、需线下补齐的项",
      level: 2,
      content: ["以下内容平台结构上就不记录（经费 / 签字 / 专家意见等），此处留空请线下补：", ...missing.map((m) => `· ${m.label}`)].join("\n"),
    });
  }
  return nodes;
}
