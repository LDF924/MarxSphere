// SPDX-License-Identifier: Apache-2.0
// home-topic-service.ts — 首页「当前课题」的持久化 + 关键词候选生成(2026-10-03)
//
// 由来(用户): 首页那句「让 Agent 帮你真正读懂 全人文社科理论」下面挂着一行
//   **硬编码**的关键词(农业农村现代化 · 资本下乡 · 工商资本 · 资本治理), 而下面的
//   「当前课题」横幅也是写死的一条基金项目名。用户要的是: 课题可输入、可固定,
//   输入时**自动识别该课题并列出关键词候选**, 勾选后呈现。
//
// ═══ 关键词从哪来(三条腿, 缺一路就退化) ═══
//   ① **本仓语料**: 把课题名跟已入库文献标题 + 期刊库 70 个主题标签放在一起跑
//      本仓的中文分词器(keyword-network-service.tokenizeZhCorpus) —— 它会做
//      n-gram 候选 + 最大覆盖剪枝, 于是切出来的是 `资本下乡` 这种真词而不是 `下乡对`。
//      这一路**不需要任何 API**, 离线可用。
//   ② **LLM 扩写**: 拿课题名要一批学科惯用的上位词/下位词/相邻概念
//      (如「资本下乡」→ 工商资本、资本治理、村社集体、土地流转)。
//      没有这一路就只有字面词, 给不出学科语境。
//   ③ 两路合并去重后**按"与课题的作用域关系"排序**: 完全包含课题串的、被课题串包含的、
//      与课题共现的, 依次靠前 —— 而不是按长度或字母序。
//
// ⚠ 这里**不编造候选**: LLM 给回来的词若与课题毫无字面或语料共现关系也留着(那是②的价值),
//   但会在前端标明来源, 让用户知道哪些是"推断"的。宁可信源可见, 不要假装都是原文里的。
import { pool } from "../db/pool.js";
import { logger } from "../observability/logger.js";

export interface HomeTopic {
  /** 课题全称(可含项目级别前缀) */
  title: string;
  /** 关键词(勾选后呈现的那一行) */
  keywords: string[];
  updatedAt: string;
}

/** 未设置时的兜底 —— 与改前的硬编码值一致, 让老用户的首页观感不突变 */
const FALLBACK: HomeTopic = {
  title: "农业农村现代化进程中工商资本规范与引导路径研究",
  keywords: ["农业农村现代化", "资本下乡", "工商资本", "资本治理"],
  updatedAt: ""
};

export async function getHomeTopic(userId: string): Promise<HomeTopic> {
  try {
    const r = await pool.query(
      `select title, keywords, updated_at from user_home_topic where user_id = $1`,
      [userId]
    );
    if (!r.rows.length) return FALLBACK;
    const row = r.rows[0];
    return {
      title: String(row.title || FALLBACK.title),
      keywords: Array.isArray(row.keywords) ? row.keywords.filter(Boolean) : [],
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : ""
    };
  } catch (e: any) {
    // 表还没建(迁移未跑到)时**不能让首页挂掉** —— 退回兜底而不是抛
    logger.warn({ err: String(e?.message || e).slice(0, 120) }, "读首页课题失败, 用兜底值");
    return FALLBACK;
  }
}

export async function setHomeTopic(
  userId: string,
  input: { title?: string; keywords?: string[] }
): Promise<HomeTopic> {
  const cur = await getHomeTopic(userId);
  const title = String(input.title ?? cur.title).trim().slice(0, 200);
  const keywords = (input.keywords ?? cur.keywords)
    .map((k) => String(k).trim())
    .filter(Boolean)
    .slice(0, 24);
  await pool.query(
    `insert into user_home_topic (user_id, title, keywords)
     values ($1, $2, $3::jsonb)
     on conflict (user_id) do update set
       title = excluded.title, keywords = excluded.keywords, updated_at = now()`,
    // ⚠ 必须 JSON.stringify —— node-postgres 对 JS 数组走的是 **Postgres 数组**字面量(`{a,b}`),
    //   而这一列是 jsonb, 于是报 "invalid input syntax for type json"(实测踩过)。
    //   digest_subscriptions 那几个 text[] 列不用转, 这两者容易混。
    [userId, title, JSON.stringify(keywords)]
  );
  return { title, keywords, updatedAt: new Date().toISOString() };
}

/** 候选项 —— 前端要按来源分组显示, 所以带上出处 */
export interface TopicKeywordCandidate {
  text: string;
  /** corpus = 本仓语料里真出现过; llm = 模型按学科语境推断 */
  origin: "corpus" | "llm";
  /** corpus 候选的来源说明(如「你已入库的文献」/「期刊库主题标签」), llm 为空 */
  from?: string;
}

/**
 * 生成关键词候选。
 *
 * 语料只取**标题与摘要**不取全文: 全文里一篇文章几千字, 高频词全是"本文""研究"这类
 * 通用词, 而我们要的是够具体的学科概念。标题+摘要恰好是"作者自己挑出来的核心词"。
 */
export async function suggestTopicKeywords(topic: string): Promise<{
  topic: string;
  candidates: TopicKeywordCandidate[];
  /** 各条路的执行情况 —— 前端如实显示"哪一路没跑起来", 而不是假装候选就是全部 */
  sources: Array<{ id: string; ok: boolean; count: number; note?: string }>;
}> {
  const q = String(topic || "").trim();
  const sources: Array<{ id: string; ok: boolean; count: number; note?: string }> = [];
  if (!q) return { topic: "", candidates: [], sources };

  /**
   * 语料那路**先跑一次, 结果喂给 LLM 那路** —— 不要写成两个并行的 Promise。
   *
   * ⚠ 我第一版就是并行写的(`Promise.all([corpusCandidates(q), corpusCandidates(q).then(...)])`),
   *   于是同一个全库分词 + 400 篇文献查询**跑了两遍**, 而分词是这整条链里最慢的一步。
   *   顺序耦合是有意的: LLM 那路要拿语料验出来的词当"别重复这些"的清单(见下)。
   */
  const corpus = await corpusCandidates(q).catch((e) => {
    sources.push({ id: "corpus", ok: false, count: 0, note: String(e?.message || e).slice(0, 100) });
    return [] as TopicKeywordCandidate[];
  });
  const llm = await llmCandidates(q, corpus.map((x) => x.text)).catch((e) => {
    sources.push({ id: "llm", ok: false, count: 0, note: String(e?.message || e).slice(0, 100) });
    return [] as TopicKeywordCandidate[];
  });
  if (!sources.some((s) => s.id === "corpus")) {
    sources.push({ id: "corpus", ok: true, count: corpus.length });
  }
  if (!sources.some((s) => s.id === "llm")) {
    sources.push({ id: "llm", ok: true, count: llm.length });
  }

  /**
   * ⚠ 两路**各自截断**, 不做全局 top-N。
   *
   * 第一版是 `rank(...).slice(0, 30)` —— 实测语料那路候选多时会把 LLM 那路整个挤出去
   * (课题「数字乡村…」跑出来 30 条里 28 条是语料、2 条是 LLM, 而界面上那两组是分开显示的,
   * "模型推断"那组几乎是空的)。分组显示的界面就必须按组给量。
   */
  return {
    topic: q,
    candidates: [...rank(q, corpus).slice(0, 14), ...rank(q, llm).slice(0, 16)],
    sources
  };
}

/**
 * 排序: 与课题的**作用域关系**优先, 再按长度。
 *
 * 为什么不用词频排: 用户看到的第一屏应当是"围绕这个课题的关键概念",
 * 而 `农业农村现代化`(课题全串的一部分)显然比一个只共现过一次的四字词更该靠前。
 */
function rank(topic: string, items: TopicKeywordCandidate[]): TopicKeywordCandidate[] {
  const seen = new Map<string, TopicKeywordCandidate>();
  for (const it of items) {
    const t = it.text.trim();
    if (!t || t === topic) continue;
    if (!seen.has(t)) seen.set(t, { ...it, text: t });
  }
  const cmp = (a: TopicKeywordCandidate, b: TopicKeywordCandidate) => {
    const score = (c: TopicKeywordCandidate): number => {
      // ① 课题串里切出来的片段(被课题包含) —— 最贴近
      if (topic.includes(c.text)) return 0;
      // ② 包含课题串的更长表达 —— 次之(它是课题的上位)
      if (c.text.includes(topic)) return 1;
      // ③ 语料里真出现过
      if (c.origin === "corpus") return 2;
      // ④ 模型推断
      return 3;
    };
    const d = score(a) - score(b);
    if (d !== 0) return d;
    return b.text.length - a.text.length;
  };
  return [...seen.values()].sort(cmp);
}

/**
 * 本仓语料路: **候选来自课题名本身, 用本仓语料去验证**。
 *
 * ⚠ 方向是这里最关键的一件事, 我第一版写反了, 结果两轮都是垃圾:
 *   第一版: 从文献语料里挖词 → 用"与课题有字面交叠"筛。单字交叠时跑出 `下乡批量入库`
 *     `西宁中心支行`; 收紧成"公共子串 ≥ 2 字"后又跑出 `社会后果研究` `研究结果表明`
 *     `博士研究生` —— 因为闸门是两字, 而 `研究` 正好两字, 于是全语料的学术套话全进来了。
 *   根因不是闸门松紧, 是**方向**: 通用语料里"长得像课题"的词, 绝大多数不是这个课题的概念。
 *
 *   现在反过来 —— 候选只从**课题名自己的连续片段**里取(2-8 字的所有子串),
 *   用本仓语料的分词词频去**验证它是不是这个领域里成立的说法**。
 *   于是 `数字乡村` `数字素养` `农户` `增收` 这类会留下, 而 `研究结果表明` 根本不在候选里
 *   (它不是课题的子串)。语料的作用从"生成"变成"背书", 这才是它擅长的。
 *
 * 产出对用户的意思很直白: **"你课题名里的这几个说法, 在你自己的文献库里找得到"** ——
 * 剩下的(课题里没有、但你该考虑的概念)交给 LLM 那一路。
 */
async function corpusCandidates(topic: string): Promise<TopicKeywordCandidate[]> {
  const { tokenizeZhCorpus, zhSentenceRuns } = await import("./keyword-network-service.js");

  const [docs, tags] = await Promise.all([
    pool.query(
      `select title, coalesce(left(content, 600), '') as body
         from documents
        where title is not null and length(title) > 4
        order by created_at desc limit 400`
    ).catch(() => ({ rows: [] as any[] })),
    pool.query(
      `select distinct unnest(topic_tags) as t from cjournal_journals where topic_tags is not null`
    ).catch(() => ({ rows: [] as any[] }))
  ]);

  const texts: string[] = [];
  for (const r of docs.rows as any[]) texts.push(`${r.title}。${r.body}`);
  for (const r of tags.rows as any[]) if (r.t) texts.push(String(r.t));
  if (!texts.length) return [];

  // ⚠ 必须走本仓自己的语句切片(zhSentenceRuns), **不能**按 `[。，、]` 之类的标点简单劈开:
  //   分词器的最大概率切分建立在"句子"这个单位上, 而我们这边的期刊标签是**连续短语**
  //   (`马克思主义中国化`), 简单劈开等于喂给它一堆拟句 —— 实测切出来的词会碎成
  //   `主义` `中国` 这类片段。用同一个切片器, 词表与关键词网络面板才是一致的。
  const runs: string[] = [];
  for (const t of texts) for (const rs of zhSentenceRuns(t)) runs.push(...rs);
  if (!runs.length) return [];
  const tok = tokenizeZhCorpus(runs, { minTermLength: 2, maxTermLength: 6, minCount: 2 });

  // 从课题名切出 2-8 字的连续片段 —— 短于 2 字不成词, 长于 8 字不是关键词。
  // 用 Set 去重(同一片段在长课题里可能被多次切出)
  const segs = new Set<string>();
  const chars = Array.from(topic);
  for (let i = 0; i < chars.length; i++) {
    for (let len = 2; len <= 8 && i + len <= chars.length; len++) {
      segs.add(chars.slice(i, i + len).join(""));
    }
  }

  const out: TopicKeywordCandidate[] = [];
  for (const seg of segs) {
    const f = tok.freq.get(seg) ?? 0;
    // 判据: 这个片段在本仓语料里**作为独立词出现过**(分词器给了它频次)。
    //   频次 ≥ 2 是"不是偶发切分"的下限 —— 语料里只出现一次的三字以上片段
    //   多半是分词边界抖动造出来的, 不是真说法。
    if (f < 2) continue;
    out.push({ text: seg, origin: "corpus", from: `本仓语料中出现 ${f} 次` });
  }
  // 长词优先(它信息更多), 同长度按频次 —— 频次不返回给前端, 只在排序里用
  out.sort((a, b) => (b.text.length - a.text.length) || ((tok.freq.get(b.text) ?? 0) - (tok.freq.get(a.text) ?? 0)));
  return out;
}

/**
 * LLM 扩写: 要一批**学科语境**里的相关概念。
 *
 * ⚠ 提示词里明确要求"必须是这个研究领域里真实使用的术语, 不要造词", 并要求输出 JSON 数组。
 *   实测模型很爱加解释性前后缀(「相关概念:」), 所以解析时按行/按数组两种都兜。
 */
async function llmCandidates(topic: string, known: string[] = []): Promise<TopicKeywordCandidate[]> {
  const { callLlm } = await import("../ai/llm-common.js");
  const { getRoleModel } = await import("./llm-model-registry.js");
  const knownBlock = known.length
    ? `\n下面这些词已经在你的语料库里出现过, 不要重复(给出**别的**): ${known.slice(0, 20).join("、")}\n`
    : "";
  const prompt = `你是人文社科领域的选题顾问。给定一个研究课题, 列出 12-16 个该课题研究中最常用的**中文关键词**。
要求:
- 必须是这个研究领域里真实使用的术语, 不要造词, 不要解释
- 覆盖: 核心概念 / 相邻概念 / 主要机制或变量 / 常用理论视角
- 每个词 2-10 个字, 不要短语, 不要标点
- 只输出一个 JSON 数组, 例如 ["关键词一","关键词二"]
${knownBlock}
课题: ${topic}`;
  const res = await callLlm({
    model: getRoleModel("reason"),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    maxTokens: 600,
    policy: "background"
  });
  const text = String(res?.text ?? "").trim();
  if (!text) return [];
  // 两种形态都兜: 纯 JSON 数组, 或模型带了解释的散文里夹着数组
  const jsonMatch = /\[[\s\S]*?\]/.exec(text);
  let words: string[] = [];
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr)) words = arr.map((x) => String(x));
    } catch { /* 落到下面的按行兜底 */ }
  }
  if (!words.length) {
    words = text.split(/[\n,，、;；]+/).map((s) => s.replace(/^[\s"'\[\]-]+|[\s"'\]]+$/g, ""));
  }
  return words
    .map((w) => w.replace(/[。，、；：""''（）()【】\[\]{}]/g, "").trim())
    .filter((w) => w.length >= 2 && w.length <= 12 && !/^(关键词|相关|如下|例如)/.test(w))
    .slice(0, 20)
    .map((text) => ({ text, origin: "llm" as const }));
}
