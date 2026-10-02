// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// summarize.ts — 速递条目的中文概括
//
// 对照依据: Respal 的 `cn_summary` 是 **LLM 生成的概括, 不是翻译**
// (实测: PLOS ONE 的 1766 字符英文摘要 → 157 字符中文概括)。
// 它对**所有来源统一生成** —— 中文刊的 abstract 本身已是中文, cn_summary 仍照常生成。
//
// ⚠ 本仓的一个选择与它不同: **只给英文条目生成**。
//   理由: 中文条目再让 LLM 概括一遍, 得到的是"把中文改写成更短的中文",
//   信息必然丢失而没有翻译增益。Respal 那么做大概是因为它前端只展示 cn_summary
//   一个字段(需要它永远有值); 我们前端两个字段都有, 直接显示原文摘要更好。

import { callLlm } from "../../ai/llm-common.js";
import { pool } from "../../db/pool.js";
import { logger } from "../../observability/logger.js";

const MAX_ABSTRACT_CHARS = 4000;

/** 为一个条目生成中文概括。返回空串表示"没生成"(失败或不需要)。 */
export async function summarizeToChinese(input: {
  title: string;
  abstract: string;
  journal?: string;
}): Promise<string> {
  const title = String(input.title || "").trim();
  let abstract = String(input.abstract || "").trim();
  if (!title) return "";
  // 摘要过长先截断 —— 速递的目的是"一眼看懂这篇讲什么", 不需要完整摘要进 prompt
  if (abstract.length > MAX_ABSTRACT_CHARS) abstract = `${abstract.slice(0, MAX_ABSTRACT_CHARS)}…`;

  // policy: "background" —— 后台批量任务。它会**跳过模型降级链**(失败即弃不换模型重试),
  //   这是有意的: 速递抓 50 条就是 50 次调用, 跟着主链路重试会挤占前台并发配额,
  //   而"这条没有中文概括"是完全可以接受的降级(前端回落到显示英文摘要)。
  const r = await callLlm({
    policy: "background",
    temperature: 0.3,
    maxTokens: 300,
    messages: [
      {
        role: "system",
        content: "你是学术文献摘要助手。用**中文概括**给定论文的要点, 不要逐句翻译。"
          + "输出 1-3 句话(80-160 字), 直接给概括正文, 不要任何前后缀、不要 markdown、不要\"本文\"以外的引导语。"
      },
      {
        role: "user",
        content: `标题: ${title}\n${input.journal ? `期刊: ${input.journal}\n` : ""}${abstract ? `摘要: ${abstract}` : "(无摘要, 请仅根据标题概括, 并明确说明信息有限)"}`
      }
    ]
  });

  // ⚠ callLlm **失败时返回 {text:"", error} 而不抛异常**(见 llm-common.ts:643/755)。
  //   不检查 error 就会把空串当成"概括成功"写进库, 前端显示空白摘要而没有任何报错。
  if (!r || r.error || !r.text) return "";
  return r.text.trim().replace(/^["'「『]|["'」』]$/g, "").slice(0, 400);
}

/** 给最近抓到的、还没有中文概括的英文条目补概括。
 *
 *  上限默认 30 —— 每次抓取新增几十条, 一次性全跑会瞬间打满 LLM 并发槽。
 *  剩下的留给下一轮(定时任务每天跑, 不会积压)。
 */
export async function backfillSummaries(limit = 30): Promise<{ done: number; failed: number }> {
  const r = await pool.query(
    `select id, title, abstract, journal from digest_items
      where cn_summary = '' and lang = 'en' and abstract <> ''
      order by fetched_at desc limit $1`,
    [Math.min(Math.max(limit, 1), 100)]
  );
  let done = 0;
  let failed = 0;
  for (const row of r.rows) {
    try {
      const cn = await summarizeToChinese({ title: row.title, abstract: row.abstract, journal: row.journal });
      if (!cn) { failed++; continue; }
      await pool.query(
        `update digest_items set cn_summary = $2, cn_summary_at = now() where id = $1`,
        [row.id, cn]
      );
      done++;
    } catch (e: any) {
      failed++;
      logger.warn({ id: row.id, err: String(e?.message || e).slice(0, 120) }, "digest 中文概括失败");
    }
  }
  return { done, failed };
}
