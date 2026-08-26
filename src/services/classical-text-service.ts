// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// classical-text-service.ts — 经典文本研究 5 大能力（马理论文本研究专用）
// 概念溯源 / 论证结构拆解 / 互文对照 / 晦涩文本阐释 / 版本校勘
// 专属算法（lcsDiff/alignParagraphs/semanticDrift）在 classical-algorithms.ts，纯算法不烧 token
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";
import { lcsDiff, classifyDiffBlock, alignParagraphs, semanticDrift } from "./classical-algorithms.js";

// ═══ 1. 概念溯源与语义演变 ═══
// LLM 归纳阶段 + 专属算法: 语义漂移检测（embedding 质心漂移量化）
export async function conceptTrace(concept: string, sourceId: string, opts: { topK?: number; model?: string } = {}) {
  const topK = opts.topK ?? 20;
  const chunks = await retrieveChunks(concept, sourceId, topK);
  if (chunks.length === 0) return { concept, stages: [], error: "知识库中未检索到该概念相关文本" };

  const prompt = `你是马克思主义经典文本研究专家。请对概念"${concept}"做语义溯源分析。
基于以下检索到的文本片段，按时间/思想史顺序归纳该概念的语义演变阶段。

要求：
1. 每个阶段包含：阶段名、时期/文献、语义内涵、关键出处（引用原文片段并标注来源文档）
2. 区分同一概念在不同语境（如政治经济学/哲学/社会学）下的内涵差异
3. 所有结论必须基于给定文本，禁止脱离文本的主观发挥
4. 输出 JSON：{"stages":[{"name":"阶段名","era":"时期或文献","meaning":"语义内涵","source":"出处（文档+章节）","quote":"原文片段"}]}

文本片段：
${chunks.map((c, i) => `[${i + 1}] 来源:${c.title} 章节:${c.heading}\n${c.content.substring(0, 600)}`).join("\n\n")}`;

  const answer = await llmJson(prompt, opts.model);
  // 专属算法: 语义漂移检测（按时段分窗计算 embedding 质心漂移）
  let drift = null;
  try {
    drift = await semanticDrift(concept, sourceId, [
      { label: "早期", filter: "2026-01-01~2026-06-01" },
      { label: "中期", filter: "2026-06-01~2026-07-01" },
      { label: "近期", filter: "2026-07-01~2026-12-31" },
    ]);
  } catch { drift = null; }
  return { concept, stages: answer?.stages ?? [], totalChunks: chunks.length, drift };
}

// ═══ 2. 论证结构拆解 ═══
// LLM 拆解 + 专属能力: 论证树落库（argument_nodes/edges，前端可渲染树图）
export async function argumentStructure(documentId: string, opts: { maxChunks?: number; persist?: boolean; model?: string } = {}) {
  const maxChunks = opts.maxChunks ?? 30;
  const chunks = await getDocChunks(documentId, maxChunks);
  if (chunks.length === 0) return { argument: null, error: "未找到该文档的章节内容" };

  const prompt = `你是论证分析专家。请对以下文本做论证结构拆解：
1. 划分逻辑层次（一级：论证模块；二级：子论证）
2. 梳理从前提到结论的完整论证链条（每个环节标注对应的原文段落）
3. 标注论证类型（演绎/归纳/类比/辩证）
4. 输出 JSON：{"premises":[{"text":"前提","source":"原文段落"}],"conclusions":[{"text":"结论","source":"原文段落"}],"chain":[{"step":"论证环节","type":"论证类型","premise":"前提","conclusion":"结论","source":"原文出处"}]}

文本（按章节）：
${chunks.map((c, i) => `[第${i + 1}节] ${c.heading}\n${c.content.substring(0, 800)}`).join("\n\n")}`;

  const answer = await llmJson(prompt, opts.model);
  // 专属能力: 论证树持久化（opts.persist=true 时写 argument_nodes/edges）
  let treeId: string | null = null;
  if (opts.persist !== false && answer?.premises?.length) {
    treeId = crypto.randomUUID();
    try {
      const premiseIds: string[] = [];
      for (const p of answer.premises.slice(0, 30)) {
        const r = await pool.query(
          `insert into argument_nodes (document_id, tree_id, node_type, label, source, raw_quote)
           values ($1, $2, 'premise', $3, $4, $3) returning id`,
          [documentId, treeId, p.text?.substring(0, 500) ?? "", p.source ?? ""]
        );
        premiseIds.push(String(r.rows[0].id));
      }
      const conclIds: string[] = [];
      for (const c of answer.conclusions.slice(0, 10)) {
        const r = await pool.query(
          `insert into argument_nodes (document_id, tree_id, node_type, label, source, raw_quote)
           values ($1, $2, 'conclusion', $3, $4, $3) returning id`,
          [documentId, treeId, c.text?.substring(0, 500) ?? "", c.source ?? ""]
        );
        conclIds.push(String(r.rows[0].id));
      }
      // 前提→结论 支撑边
      for (const p of premiseIds) {
        for (const c of conclIds.slice(0, 2)) {
          await pool.query(
            `insert into argument_edges (tree_id, from_node, to_node, edge_type) values ($1, $2, $3, 'supports')`,
            [treeId, p, c]
          ).catch(() => {});
        }
      }
      // 链环节（step 节点）
      for (const s of (answer.chain ?? []).slice(0, 20)) {
        await pool.query(
          `insert into argument_nodes (document_id, tree_id, node_type, label, source, raw_quote)
           values ($1, $2, 'step', $3, $4, $5)`,
          [documentId, treeId, (s.step ?? "").substring(0, 300), s.source ?? "", s.premise?.substring(0, 300) ?? ""]
        ).catch(() => {});
      }
    } catch (e: any) { console.error("[classical] 论证树落库失败:", e?.message?.substring(0, 80)); }
  }
  return { argument: answer, totalChunks: chunks.length, treeId };
}

// 查询已落库的论证树
export async function getArgumentTree(documentId: string, treeId: string) {
  const nodes = await pool.query(
    `select id, node_type, label, source, raw_quote from argument_nodes where document_id = $1 and tree_id = $2 order by created_at`,
    [documentId, treeId]
  );
  const edges = await pool.query(
    `select e.id, e.from_node, e.to_node, e.edge_type,
       fn.label as from_label, tn.label as to_label
     from argument_edges e
     join argument_nodes fn on fn.id = e.from_node
     join argument_nodes tn on tn.id = e.to_node
     where e.tree_id = $1`,
    [treeId]
  );
  return { nodes: nodes.rows, edges: edges.rows };
}

// ═══ 3. 多文本互文对照 ═══
// LLM 对比 + 专属能力: 段落对齐（embedding 余弦相似度自动匹配对应段落）
export async function intertextualCompare(
  topic: string,
  documentIds: string[],
  sourceId: string,
  opts: { perDoc?: number; model?: string } = {}
) {
  const perDoc = opts.perDoc ?? 5;
  const perDocTexts: Array<{ title: string; chunks: Array<{ heading: string; content: string }> }> = [];
  for (const docId of documentIds) {
    const doc = await getDocMeta(docId);
    const chunks = (await getDocChunks(docId, perDoc * 3)).filter((c) =>
      c.content.toLowerCase().includes(topic.toLowerCase()) || c.heading.toLowerCase().includes(topic.toLowerCase())
    ).slice(0, perDoc);
    if (chunks.length > 0) perDocTexts.push({ title: doc?.title ?? docId, chunks });
  }
  if (perDocTexts.length < 2) {
    return { error: `需要至少 2 篇含"${topic}"的文档，当前 ${perDocTexts.length} 篇`, comparisons: [], alignments: [] };
  }

  const prompt = `你是互文对照研究专家。请对主题"${topic}"在以下不同文本中的表述做互文对照：
1. 各文本对同一问题的表述差异（观点/侧重/术语）
2. 若涉及不同译本，标注关键概念的译法分歧
3. 输出 JSON：{"comparisons":[{"aspect":"对照维度","texts":[{"title":"文本名","view":"表述/观点","quote":"原文片段"}],"difference":"差异分析"}]}

文本：
${perDocTexts.map((t, ti) => `【文本${ti + 1}】${t.title}\n${t.chunks.map((c) => `  [${c.heading}] ${c.content.substring(0, 500)}`).join("\n")}`).join("\n\n")}`;

  const answer = await llmJson(prompt, opts.model);
  // 专属能力: 段落对齐（对前两篇文本做 embedding 段落匹配）
  let alignments: Array<{ aHeading: string; bHeading: string; aText: string; bText: string; similarity: number }> = [];
  try {
    alignments = await alignParagraphs(perDocTexts[0].chunks, perDocTexts[1].chunks);
  } catch { alignments = []; }
  return { topic, comparisons: answer?.comparisons ?? [], documents: perDocTexts.map((t) => t.title), alignments };
}

// ═══ 4. 晦涩文本阐释辅助 ═══
// 输入: 原文段落 → 逻辑拆解 + 通俗重述 + 学界解读（禁止脱离原文）
export async function exegesis(text: string, sourceId: string, opts: { topK?: number; model?: string } = {}) {
  const topK = opts.topK ?? 10;
  // 在库中找该段落的上下文（同文档其他段落 + 相关解读文献）
  const contextChunks = await retrieveChunks(text.substring(0, 100), sourceId, topK);
  const prompt = `你是马克思主义经典文本阐释专家。请对以下晦涩段落做阐释辅助：

【原文段落】
${text}

要求：
1. 逻辑拆解：把段落拆成若干命题，说明每个命题的含义与逻辑关系
2. 通俗化重述：用通俗语言重述段落的整体意思（不改变原意）
3. 学界解读：给出该段落的主流解读观点与争议点（如无把握，标注"文献中未见明确解读"）
4. 禁止脱离文本的主观发挥：所有阐释必须对应原文短语并标注出处
5. 句级锚定：每个命题必须绑定原文句子（output 输出 JSON：{"propositions":[{"original":"原文句子(逐字引用)","text":"命题名","meaning":"含义"}],"plainRestatement":"通俗重述","scholarlyViews":[{"view":"解读观点","source":"出处或标注"}],"controversies":["争议点"]}

【相关上下文/文献】：
${contextChunks.map((c, i) => `[${i + 1}] 来源:${c.title} 章节:${c.heading}\n${c.content.substring(0, 400)}`).join("\n\n")}`;

  const answer = await llmJson(prompt, opts.model);
  // 句级锚定校验：检查每个命题是否绑定原文句子（硬约束——无原文绑定的命题标记为"脱离文本"）
  const anchored = (answer?.propositions ?? []).map((p: any) => ({
    ...p,
    anchored: typeof p.original === "string" && p.original.length > 0 && text.includes(p.original.slice(0, 20)),
  }));
  return { exegesis: { ...answer, propositions: anchored } };
}

// ═══ 5. 版本校勘与文本差异识别 ═══
// 专属能力: LCS 算法 diff（不依赖 LLM 读全文，大文本可用）+ LLM 补充差异意义分析
export async function collation(documentGroup: string, sourceId: string, opts: { perVersion?: number; model?: string } = {}) {
  const perVersion = opts.perVersion ?? 20;
  // 按标题前缀匹配同著作多版本
  const docs = await pool.query(
    `SELECT id, title FROM documents WHERE title ILIKE $1 ORDER BY title`,
    [`%${documentGroup}%`]
  );
  if (docs.rows.length < 2) {
    return { error: `需要至少 2 个版本（标题含"${documentGroup}"），当前 ${docs.rows.length} 个`, diffs: [], algorithmDiffs: [] };
  }
  // 取每版前 perVersion 个 chunk 做逐段比对
  const versions: Array<{ title: string; chunks: Array<{ heading: string; content: string }> }> = [];
  for (const doc of docs.rows) {
    const chunks = await getDocChunks(doc.id, perVersion);
    versions.push({ title: doc.title, chunks });
  }

  // ═══ 专属能力: LCS 算法 diff（版本0 vs 版本1，按段落逐段比对）═══
  const algorithmDiffs: Array<{
    section: string;
    type: string;
    oldText: string;
    newText: string;
    classification: string;
  }> = [];
  const v0 = versions[0], v1 = versions[1];
  const maxPairs = Math.min(v0.chunks.length, v1.chunks.length, perVersion);
  for (let i = 0; i < maxPairs; i++) {
    const c0 = v0.chunks[i].content;
    const c1 = v1.chunks[i].content;
    const blocks = lcsDiff(c0, c1);
    const nonEqual = blocks.filter((b) => b.type !== "equal");
    if (nonEqual.length === 0) continue;
    // 合并相邻差异成块（最多输出 5 个显著差异）
    for (const b of nonEqual.slice(0, 5)) {
      algorithmDiffs.push({
        section: `${v0.chunks[i].heading || `第${i + 1}段`}（${v0.title.slice(0, 15)} vs ${v1.title.slice(0, 15)}）`,
        type: b.type === "insert" ? "增补" : b.type === "delete" ? "删改" : "改写",
        oldText: b.oldText.substring(0, 100),
        newText: b.newText.substring(0, 100),
        classification: classifyDiffBlock(b),
      });
    }
    if (algorithmDiffs.length >= 20) break;
  }

  // LLM 补充差异意义分析（只对显著差异，控制 token）
  const prompt = `你是版本校勘专家。请对以下同一著作的多个版本做文字差异比对：
1. 识别版本间的文字差异（删改/增补/改写）
2. 标注差异类型（删改/增补/改写/标点）与差异位置
3. 输出 JSON：{"diffs":[{"section":"章节/位置","type":"删改|增补|改写|标点","versions":[{"title":"版本名","text":"该版本文字"}],"description":"差异描述"}]}

版本文本：
${versions.map((v, vi) => `【版本${vi + 1}】${v.title}\n${v.chunks.map((c, i) => `  [${i + 1}] ${c.heading}\n  ${c.content.substring(0, 400)}`).join("\n")}`).join("\n\n")}`;

  const answer = await llmJson(prompt, opts.model);
  return { documentGroup, diffs: answer?.diffs ?? [], versions: versions.map((v) => v.title), algorithmDiffs };
}

// ═══ 工具函数 ═══

async function retrieveChunks(query: string, sourceId: string, topK: number) {
  // 关键词 ILIKE 检索 + 命中加权排序（命中词多优先）+ 过滤短内容块（标题块等）
  const words = query.replace(/[？?。，,、；;：:！!（）\(\)"「」『』《》【】\[\]{}''\s]/g, " ").split(" ").filter((w) => w.length >= 2).slice(0, 6);
  if (words.length === 0) return [];
  const likeClauses = words.map((_, i) => `c.content ILIKE $${i + 2}`).join(" OR ");
  const hitClauses = words.map((_, i) => `(CASE WHEN c.content ILIKE $${i + 2} THEN 1 ELSE 0 END)`).join(" + ");
  const res = await pool.query(
    `SELECT c.heading, c.content, d.title, (${hitClauses}) AS hit_count
     FROM source_chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.source_id = $1 AND (${likeClauses}) AND length(c.content) > 80
     ORDER BY hit_count DESC, length(c.content) DESC
     LIMIT $${words.length + 2}`,
    [sourceId, ...words.map((w) => `%${w}%`), topK]
  );
  return res.rows;
}

async function getDocChunks(documentId: string, limit: number) {
  const r = await pool.query(
    `SELECT heading, content FROM source_chunks WHERE document_id = $1 ORDER BY rank LIMIT $2`,
    [documentId, limit]
  );
  return r.rows;
}

async function getDocMeta(documentId: string) {
  const r = await pool.query(`SELECT title FROM documents WHERE id = $1`, [documentId]);
  return r.rows[0] ?? null;
}

async function llmJson(prompt: string, modelOverride?: string): Promise<any | null> {
  const ep = getLlmEndpoint({ model: modelOverride || getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url,
    key: ep.key,
    model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON，不要其他文字。" }],
    temperature: 0.2,
    maxTokens: 4000,
    timeoutMs: 120_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}

export const classicalTextService = {
  conceptTrace,
  argumentStructure,
  getArgumentTree,
  intertextualCompare,
  exegesis,
  collation,
};
