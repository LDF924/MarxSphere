// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// academic-research-service.ts — 学术研究 5 大能力（S41-S45）
// 学派脉络全景 / 核心观点对比 / 学术争鸣还原 / 学者思想谱系 / 学科前沿动态
// 复用: 检索(ILIKE+embedding) + entities 图谱 + LLM 归纳
// 专属算法: 师承关系提取 / 观点聚类 / 争鸣时间线 / 谱系链 / 高频词统计
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";
import { embeddingClient } from "../ai/embedding-client.js";

// ═══ 1. 学派脉络全景 ═══
// LLM 归纳起源/代表人物/命题/发展阶段/分歧/影响 + 专属算法: 学派代表人物的师承关系（图谱）
export async function schoolOverview(schoolName: string, sourceId: string, opts: { topK?: number; model?: string } = {}) {
  const topK = opts.topK ?? 20;
  const chunks = await retrieveChunks(schoolName, sourceId, topK);
  if (chunks.length === 0) return { school: schoolName, overview: null, error: "知识库中未检索到该学派相关文本" };

  const prompt = `你是学术史研究专家。请对理论流派"${schoolName}"做脉络全景梳理：
1. 起源与思想背景
2. 代表人物（含代表作）
3. 核心命题与理论主张
4. 发展阶段（按时间）
5. 内部分歧
6. 后世影响
输出 JSON：{"origin":"起源","representatives":[{"name":"人物","work":"代表作","role":"贡献"}],"corePropositions":["核心命题"],"stages":[{"name":"阶段","period":"时期","features":"特征"}],"divisions":["内部分歧"],"influence":"后世影响"}

文本片段：
${chunks.map((c, i) => `[${i + 1}] 来源:${c.title} 章节:${c.heading}\n${c.content.substring(0, 600)}`).join("\n\n")}`;

  const answer = await llmJson(prompt, opts.model);

  // 专属算法: 师承关系提取（entities 图谱中 person 实体 + 代表人物的共现）
  let genealogy: Array<{ person: string; relation: string; evidence: string }> = [];
  try {
    const reps = (answer?.representatives ?? []).map((r: any) => r.name).filter(Boolean).slice(0, 10);
    if (reps.length >= 2) {
      // 在库中找人物实体，检查人物之间的关联（同一文档共现 = 师承/合作线索）
      for (let i = 0; i < reps.length; i++) {
        for (let j = i + 1; j < reps.length; j++) {
          const co = await pool.query(
            `SELECT d.title FROM documents d
             JOIN source_chunks c ON c.document_id = d.id
             WHERE c.content ILIKE $1 AND c.content ILIKE $2 LIMIT 2`,
            [`%${reps[i]}%`, `%${reps[j]}%`]
          );
          if (co.rows.length > 0) {
            genealogy.push({ person: `${reps[i]} ↔ ${reps[j]}`, relation: "共现（可能师承/合作）", evidence: co.rows[0].title?.substring(0, 50) });
          }
        }
      }
    }
  } catch { genealogy = []; }

  return { school: schoolName, overview: answer, totalChunks: chunks.length, genealogy };
}

// ═══ 2. 核心观点对比 ═══
// LLM 结构化对照表 + 专属算法: 观点聚类（各观点 embedding 相似度分组 → 共识/分歧自动识别）
export async function viewComparison(topic: string, scholars: string[], sourceId: string, opts: { perScholar?: number; model?: string } = {}) {
  const perScholar = opts.perScholar ?? 5;
  // 每位学者的观点段落
  const scholarViews: Array<{ name: string; quotes: Array<{ title: string; text: string }> }> = [];
  for (const scholar of scholars) {
    const chunks = await retrieveChunks(`${topic} ${scholar}`, sourceId, perScholar);
    if (chunks.length > 0) {
      scholarViews.push({ name: scholar, quotes: chunks.map((c) => ({ title: c.title, text: c.content.substring(0, 300) })) });
    }
  }
  if (scholarViews.length < 2) {
    return { error: `至少需要 2 位学者的观点（当前 ${scholarViews.length}）`, topic, comparisons: [], clusters: [] };
  }

  const prompt = `你是学术观点比较专家。请对研究问题"${topic}"在以下学者的观点做横向对比：
1. 各学者的核心观点
2. 论证逻辑差异
3. 立场分歧
4. 共识点与争议点
输出 JSON：{"comparisons":[{"scholar":"学者","view":"核心观点","logic":"论证逻辑","stance":"立场"}],"consensus":["共识点"],"disputes":["争议点"],"evidence":{"scholar":"论据","source":"出处"}}

学者观点：
${scholarViews.map((s) => `【${s.name}】\n${s.quotes.map((q, i) => `  [${i + 1}] (${q.title}) ${q.text}`).join("\n")}`).join("\n\n")}`;

  const answer = await llmJson(prompt, opts.model);

  // 专属算法: 观点聚类（各观点段落 embedding 两两相似度 → 高相似 = 共识簇 / 低相似 = 分歧）
  let clusters: Array<{ label: string; scholars: string[]; similarity: number }> = [];
  try {
    const allQuotes: Array<{ scholar: string; text: string }> = [];
    for (const sv of scholarViews) for (const q of sv.quotes) allQuotes.push({ scholar: sv.name, text: q.text });
    const vecs = await embeddingClient.batchGenerate(allQuotes.map((q) => q.text.substring(0, 300)));
    const cos = (v1: number[], v2: number[]) => {
      let dot = 0, n1 = 0, n2 = 0;
      for (let k = 0; k < v1.length; k++) { dot += v1[k] * v2[k]; n1 += v1[k] * v1[k]; n2 += v2[k] * v2[k]; }
      return n1 && n2 ? dot / (Math.sqrt(n1) * Math.sqrt(n2)) : 0;
    };
    // 跨学者找高相似对（>0.8 = 共识；<0.3 = 分歧）
    const consensusPairs: Array<{ a: string; b: string; sim: number }> = [];
    const disputePairs: Array<{ a: string; b: string; sim: number }> = [];
    for (let i = 0; i < allQuotes.length; i++) {
      for (let j = i + 1; j < allQuotes.length; j++) {
        if (allQuotes[i].scholar === allQuotes[j].scholar) continue;
        const sim = cos(vecs[i], vecs[j]);
        if (sim > 0.8) consensusPairs.push({ a: allQuotes[i].scholar, b: allQuotes[j].scholar, sim });
        if (sim < 0.25) disputePairs.push({ a: allQuotes[i].scholar, b: allQuotes[j].scholar, sim });
      }
    }
    clusters = [
      ...consensusPairs.slice(0, 5).map((p) => ({ label: `共识：${p.a} ↔ ${p.b}`, scholars: [p.a, p.b], similarity: Math.round(p.sim * 1000) / 1000 })),
      ...disputePairs.slice(0, 5).map((p) => ({ label: `分歧：${p.a} vs ${p.b}`, scholars: [p.a, p.b], similarity: Math.round(p.sim * 1000) / 1000 })),
    ];
  } catch { clusters = []; }

  return { topic, comparisons: answer?.comparisons ?? [], consensus: answer?.consensus ?? [], disputes: answer?.disputes ?? [], clusters };
}

// ═══ 3. 学术争鸣脉络还原 ═══
// LLM 还原论战 + 专属算法: 交锋时间线（相关文档按时间排序，识别回合）
export async function debateReconstruction(debateTopic: string, sourceId: string, opts: { topK?: number; model?: string } = {}) {
  const topK = opts.topK ?? 15;
  const chunks = await retrieveChunks(debateTopic, sourceId, topK);
  if (chunks.length === 0) return { topic: debateTopic, debate: null, error: "知识库中未检索到该争鸣相关文本" };

  const prompt = `你是学术论战研究专家。请对学术争鸣"${debateTopic}"做脉络还原：
1. 问题缘起（谁在何时提出）
2. 正反双方代表人物与核心论据
3. 回合交锋（按时间顺序）
4. 理论意义与后续影响
输出 JSON：{"origin":"问题缘起","proponents":[{"name":"正方代表","arguments":"核心论据"}],"opponents":[{"name":"反方代表","arguments":"核心论据"}],"rounds":[{"round":"回合","period":"时间","content":"交锋内容"}],"significance":"理论意义"}

文本片段：
${chunks.map((c, i) => `[${i + 1}] 来源:${c.title} 章节:${c.heading}\n${c.content.substring(0, 500)}`).join("\n\n")}`;

  const answer = await llmJson(prompt, opts.model);

  // 专属算法: 交锋时间线（相关文档按入库时间排序，标注可能的时间顺序）
  let timeline: Array<{ title: string; date: string; role: string }> = [];
  try {
    const ordered = await pool.query(
      `SELECT d.title, d.created_at FROM documents d
       JOIN source_chunks c ON c.document_id = d.id
       WHERE c.content ILIKE $1 ORDER BY d.created_at LIMIT 10`,
      [`%${debateTopic}%`]
    );
    timeline = ordered.rows.map((r: any, i: number) => ({
      title: r.title?.substring(0, 40),
      date: new Date(r.created_at).toISOString().slice(0, 10),
      role: i === 0 ? "缘起" : i === ordered.rows.length - 1 ? "最新回应" : "交锋",
    }));
  } catch { timeline = []; }

  return { topic: debateTopic, debate: answer, timeline };
}

// ═══ 4. 学者思想谱系 ═══
// LLM 梳理思想发展 + 专属算法: 学术师承链（entities 图谱 person→org/work 关系）
export async function scholarGenealogy(scholarName: string, sourceId: string, opts: { topK?: number; model?: string } = {}) {
  const topK = opts.topK ?? 15;
  const chunks = await retrieveChunks(scholarName, sourceId, topK);
  if (chunks.length === 0) return { scholar: scholarName, profile: null, error: "知识库中未检索到该学者相关文本" };

  const prompt = `你是学术思想史专家。请对学者"${scholarName}"做思想谱系构建：
1. 思想发展历程（各阶段）
2. 不同阶段代表作
3. 核心观点演变
4. 学术师承与理论来源
5. 对后世影响
输出 JSON：{"stages":[{"name":"阶段","period":"时期","works":"代表作","views":"核心观点"}],"mentors":["师承"],"sources":["理论来源"],"influence":"后世影响"}

文本片段：
${chunks.map((c, i) => `[${i + 1}] 来源:${c.title} 章节:${c.heading}\n${c.content.substring(0, 500)}`).join("\n\n")}`;

  const answer = await llmJson(prompt, opts.model);

  // 专属算法: 学术师承链（图谱中 person 实体关联 + 代表作提取）
  let network: Array<{ from: string; to: string; type: string }> = [];
  try {
    // 找该学者的著作实体（work）
    const works = await pool.query(
      `SELECT name FROM entities WHERE type = 'work' AND (name ILIKE $1 OR description ILIKE $1) LIMIT 5`,
      [`%${scholarName}%`]
    );
    for (const w of works.rows) {
      network.push({ from: scholarName, to: w.name?.substring(0, 50), type: "著作" });
    }
    // 找共现的其他人名（可能的师承/合作）
    const coNames = await pool.query(
      `SELECT name FROM entities WHERE type = 'person' AND name ILIKE $1 AND name != $2 LIMIT 5`,
      [`%${scholarName.slice(0, 2)}%`, scholarName]
    );
    for (const n of coNames.rows) {
      network.push({ from: scholarName, to: n.name?.substring(0, 30), type: "关联学者" });
    }
  } catch { network = []; }

  return { scholar: scholarName, profile: answer, network };
}

// ═══ 5. 学科前沿动态追踪 ═══
// LLM 汇总前沿 + 专属算法: 高频关键词统计（TF）+ 高被引识别（引用数）
export async function frontierReport(discipline: string, sourceId: string, opts: { topK?: number; model?: string } = {}) {
  const topK = opts.topK ?? 30;
  const chunks = await retrieveChunks(discipline, sourceId, topK);
  if (chunks.length === 0) return { discipline, report: null, error: "知识库中未检索到该学科相关文本" };

  // 专属算法: 高频关键词（TF 统计，去掉停用词）
  const freq: Record<string, number> = {};
  const stopWords = new Set(["的", "了", "是", "在", "和", "与", "及", "或", "等", "中", "对", "为", "以", "从", "而", "被", "把", "将", "于", "之", "上", "下", "也", "并", "但", "都", "这", "那", "个", "一", "不", "很", "及", "研究", "论文", "本文", "我们", "进行", "分析", "通过", "问题", "方法", "结果", "发现", "影响", "作用", "之间", "以及", "相关"]);
  for (const c of chunks) {
    const text = c.content;
    const matches = text.match(/[一-龥]{2,6}/g) ?? [];
    for (const m of matches) {
      if (stopWords.has(m) || m.length < 2) continue;
      freq[m] = (freq[m] ?? 0) + 1;
    }
  }
  const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([word, count]) => ({ word, count }));

  // 高被引识别（chunk 数最多的文档近似高被引/高关注）
  const hotDocs = await pool.query(
    `SELECT d.title, count(c.id) as chunk_count FROM documents d
     JOIN source_chunks c ON c.document_id = d.id
     WHERE d.source_id = $1 AND d.title ILIKE $2
     GROUP BY d.id ORDER BY chunk_count DESC LIMIT 5`,
    [sourceId, `%${discipline.slice(0, 4)}%`]
  );

  const prompt = `你是学科前沿跟踪专家。请对学科"${discipline}"生成领域前沿简报：
1. 研究热点（当前重点议题）
2. 新兴议题
3. 研究方法转向
4. 年度关键文献
输出 JSON：{"hotTopics":["研究热点"],"emergingIssues":["新兴议题"],"methodShifts":["方法转向"],"keyWorks":[{"title":"文献","significance":"意义"}]}

文本片段：
${chunks.map((c, i) => `[${i + 1}] 来源:${c.title} 章节:${c.heading}\n${c.content.substring(0, 400)}`).join("\n\n")}`;

  const answer = await llmJson(prompt, opts.model);

  return { discipline, report: answer, keywords, hotDocs: hotDocs.rows.map((r: any) => ({ title: r.title?.substring(0, 50), chunks: r.chunk_count })) };
}

// ═══ 工具函数 ═══

async function retrieveChunks(query: string, sourceId: string, topK: number) {
  const words = query.replace(/[？?。，,、；;：:！!（）\(\)"「」『』《》【】\[\]{}''\s]/g, " ").split(" ").filter((w) => w.length >= 2).slice(0, 6);
  if (words.length === 0) return [];
  const likeClauses = words.map((_, i) => `c.content ILIKE $${i + 2}`).join(" OR ");
  const hitClauses = words.map((_, i) => `(CASE WHEN c.content ILIKE $${i + 2} THEN 1 ELSE 0 END)`).join(" + ");
  const res = await pool.query(
    `SELECT c.heading, c.content, d.title, (${hitClauses}) AS hit_count
     FROM source_chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.source_id = $1 AND (${likeClauses}) AND length(c.content) > 80
     ORDER BY hit_count DESC, length(c.content) DESC LIMIT $${words.length + 2}`,
    [sourceId, ...words.map((w) => `%${w}%`), topK]
  );
  return res.rows;
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

export const academicResearchService = {
  schoolOverview,
  viewComparison,
  debateReconstruction,
  scholarGenealogy,
  frontierReport,
};
