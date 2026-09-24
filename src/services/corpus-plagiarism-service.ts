// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// corpus-plagiarism-service.ts — 对**平台文献库**查重(2026-09-24)
//
// 由来: 原有的 `paper-quality-service.plagiarismRiskCheck` 是 **text-vs-text** —— 调用方必须
//   自己给出"比对源文本", 没有源文本就算不出任何东西。终稿页因此只能让用户手工挑一篇文献比,
//   并在界面上写明"平台没有全网语料库"。
//   但平台其实**有**一个语料: `documents` 表(本机 504 篇, 全都有正文, 平均 1.3 万字)。
//   写论文时最该查的恰恰是"我有没有抄到我读过的这些" —— 那正是这个库。
//
// 与原有那条的关系: 不是替换, 是**并集**。原条能做中文改写/不当引用的 LLM 判断, 这条只做
//   确定性的字面重合。终稿页两条都提供, 由用户选。
//
// ── 算法 ──
// 对每篇库文献统计"查询文本的 6-gram 有多少出现在它里面", 取重合率最高的若干篇。
//
// 关键取舍: **不为每篇文档建 gram 集合**。504 篇 × 1.3 万字 = 650 万个 gram, 全建成 Set
//   既慢又吃内存。改成反着来 —— 只建**查询文本**的 gram 集合(一篇也才一万多个),
//   然后逐篇滑窗查表。每个位置一次 Set 查找, 总计 650 万次查找, 秒级完成, 内存只有查询集。
//
// 归一化沿用 `paper-quality-service` 的口径(去空白 + 去中英文标点), 额外补一条**转小写** ——
//   否则英文文献的 "The" 与 "the" 会被当成不同的 gram, 而中文不受影响。
import { pool } from "../db/pool.js";

/** 与 paper-quality-service 的 ngrams 同一套去噪口径, 另加转小写(英文大小写不该算差异) */
function normalize(t: string): string {
  return String(t ?? "")
    .replace(/\s+/g, "")
    .replace(/[，。；：！？、""''（）《》—…,.;:!?"'()<>[\]{}\-]/g, "")
    .toLowerCase();
}

/** 取文本的 n-gram 集合(n 默认 6, 与既有查重保持一致) */
function gramSet(clean: string, n = 6): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i + n <= clean.length; i++) s.add(clean.slice(i, i + n));
  return s;
}

export interface CorpusMatch {
  id: string;
  title: string;
  /**
   * 重合程度(0~1): 查询文本的 gram 有多大比例出现在这篇里。
   *
   * ⚠ 分子必须去重。文档比查询长时, 同一个 gram 会在文档里出现多次 —— 直接累加计数会**超过分母**,
   *   算出 1.565 这种大于 1 的"比例"(实测: 查询取库内某篇的 773 字段落, 与该篇比出 1.565)。
   *   比例超过 1 在界面上是明显的 bug, 也会让"按比例排序"失真。
   */
  overlapRatio: number;
  /** 命中的**去重** gram 个数 */
  matchedGrams: number;
  /** 最长连续命中长度(字符) —— "大段重合"的判据, 比总重合率更能说明问题 */
  longestRun: number;
  /** 最长连续命中处的原文片段(供人工核对是否真抄) */
  sample: string;
}

export interface CorpusPlagiarismResult {
  ok: boolean;
  error?: string;
  /** 库里参与比对的文献数 */
  corpusSize: number;
  /** 查询文本去噪后的长度(太短时结果没有意义, 这里如实给出) */
  queryLength: number;
  matches: CorpusMatch[];
  verdict: string;
}

/**
 * 一篇文档与查询文本的重合情况。
 *
 * `hits` 是**命中的去重 gram 集合**(不是计数)——比例的分母是查询的 gram 数, 分子必须是
 * "查询里有几个 gram 在这篇出现过", 而不是"这篇里出现了多少次"。后者在文档比查询长时会超过分母。
 */
function scoreDoc(cleanDoc: string, queryGrams: Set<string>, n: number): { hits: Set<string>; longestRun: number; runAt: number } {
  const hits = new Set<string>();
  let run = 0;
  let best = 0;
  let bestAt = 0;
  const len = cleanDoc.length;
  for (let i = 0; i + n <= len; i++) {
    const g = cleanDoc.slice(i, i + n);
    if (queryGrams.has(g)) {
      hits.add(g);
      run++;
      if (run > best) { best = run; bestAt = i - run + 1; }
    } else {
      run = 0;
    }
  }
  return { hits, longestRun: best > 0 ? best + n - 1 : 0, runAt: bestAt };
}

/**
 * 对平台文献库查重。
 *
 * @param text   要查的正文(通常是统稿后的全文)
 * @param opts   limit: 最多扫描多少篇(默认全部); minRun: 只回报最长连续命中达到这个字符数的
 * @param userId 仅用于日志/审计, 不参与过滤 —— `documents` 是平台公共文献库, 不属于某个用户
 */
export async function checkAgainstCorpus(
  text: string,
  opts: { limit?: number; minRun?: number } = {},
): Promise<CorpusPlagiarismResult> {
  const n = 6;
  const cleanQuery = normalize(text);
  if (cleanQuery.length < 50) {
    return {
      ok: false, error: "正文太短(去噪后不足 50 字), 查重结果没有意义", corpusSize: 0,
      queryLength: cleanQuery.length, matches: [], verdict: "未执行",
    };
  }
  const queryGrams = gramSet(cleanQuery, n);
  const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? Math.min(opts.limit as number, 5000) : 5000;

  // 只取正文与标题。ORDER BY 不重要(要全扫), 但 LIMIT 要能生效, 故加个确定性排序
  const rows = await pool.query<{ id: string; title: string; content: string | null }>(
    `select id, title, content from documents
      where content is not null and length(content) > 200
      order by id limit $1`,
    [limit],
  );

  const matches: CorpusMatch[] = [];
  for (const r of rows.rows) {
    const cleanDoc = normalize(r.content ?? "");
    if (cleanDoc.length < n) continue;
    const { hits, longestRun, runAt } = scoreDoc(cleanDoc, queryGrams, n);
    if (hits.size === 0) continue;
    matches.push({
      id: r.id,
      title: r.title,
      overlapRatio: Math.round((hits.size / queryGrams.size) * 1000) / 1000,
      matchedGrams: hits.size,
      longestRun,
      sample: longestRun > 0 ? cleanDoc.slice(runAt, runAt + Math.min(longestRun, 160)) : "",
    });
  }

  // 排序: 先按最长连续命中(最像"大段抄"), 再按总重合率
  matches.sort((a, b) => b.longestRun - a.longestRun || b.overlapRatio - a.overlapRatio);
  const minRun = Number.isFinite(opts.minRun) ? (opts.minRun as number) : 0;
  const filtered = matches.filter((m) => m.longestRun >= minRun).slice(0, 20);

  const worst = filtered[0];
  const verdict = !worst
    ? "未发现与库中文献的明显重合"
    : worst.longestRun >= 100
      ? `高风险：与《${worst.title}》存在 ${worst.longestRun} 字的连续重合`
      : worst.longestRun >= 30
        ? `需注意：与《${worst.title}》存在 ${worst.longestRun} 字的连续重合`
        : `低风险：最长连续重合 ${worst.longestRun} 字`;

  return {
    ok: true,
    corpusSize: rows.rows.length,
    queryLength: cleanQuery.length,
    matches: filtered,
    verdict,
  };
}

export const corpusPlagiarismService = { checkAgainstCorpus };
