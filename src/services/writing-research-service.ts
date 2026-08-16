// writing-research-service.ts — 论文写作与研究设计 5 大能力（S46-S50）
// 研究问题凝练 / 框架与论证结构设计 / 论证链条补全 / 研究方法适配 / 反方视角生成
// 复用: 检索 + LLM 归纳；专属算法: 主题覆盖矩阵 / 框架模板匹配 / 逻辑断层检测 / 方法特征映射 / 前提弱化检测
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";
import { embeddingClient } from "../ai/embedding-client.js";

// ═══ 1. 研究问题凝练与空白识别 ═══
// LLM 总结现状/争议/空白 + 专属算法: 主题覆盖矩阵（检索现有文献的主题分布 → 可视化空白）
export async function researchGapIdentification(topic: string, sourceId: string, opts: { topK?: number; model?: string } = {}) {
  const topK = opts.topK ?? 25;
  const chunks = await retrieveChunks(topic, sourceId, topK);
  if (chunks.length === 0) return { topic, gap: null, error: "知识库中未检索到该主题相关文献" };

  const prompt = `你是研究选题专家。请基于以下文献片段对主题"${topic}"做研究现状分析：
1. 已解决的问题（研究现状）
2. 存在争议的问题
3. 尚未覆盖的研究空白
4. 提炼 2-3 个有学术价值的研究问题（避免重复研究与伪问题）
输出 JSON：{"solved":["已解决问题"],"controversial":["争议问题"],"gaps":["研究空白"],"researchQuestions":[{"question":"研究问题","rationale":"价值依据","novelty":"创新点"}]}

文献片段：
${chunks.map((c, i) => `[${i + 1}] 来源:${c.title} 章节:${c.heading}\n${c.content.substring(0, 400)}`).join("\n\n")}`;

  const answer = await llmJson(prompt, opts.model);

  // 专属算法: 主题覆盖矩阵（高频主题词 × 文献分布 → 覆盖度/空白度）
  let coverage: Array<{ keyword: string; docCount: number; coverage: string }> = [];
  let totalDocs = 0;
  try {
    const freq: Record<string, number> = {};
    const stopWords = new Set(["的", "了", "是", "在", "和", "与", "及", "或", "等", "中", "对", "为", "以", "从", "而", "被", "把", "将", "于", "之", "上", "下", "也", "并", "但", "都", "这", "那", "个", "一", "不", "很", "研究", "论文", "本文", "我们", "进行", "分析", "通过", "问题", "方法", "结果", "发现", "影响", "作用", "之间", "以及", "相关", "资本下乡"]);
    const docTitles = new Set<string>();
    for (const c of chunks) {
      const text = (c.content + " " + (c.title ?? "")).replace(topic, "");
      const matches = text.match(/[一-龥]{2,6}/g) ?? [];
      for (const m of matches) {
        if (stopWords.has(m) || m.length < 2) continue;
        freq[m] = (freq[m] ?? 0) + 1;
      }
      docTitles.add(c.title);
    }
    totalDocs = docTitles.size;
    // 高覆盖主题（出现 ≥ 3 次）vs 低覆盖（出现 1-2 次 → 可能的空白方向）
    coverage = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([word, count]) => ({
        keyword: word,
        docCount: count,
        coverage: count >= 4 ? "高覆盖（已有研究）" : count === 3 ? "中覆盖（有基础）" : "低覆盖（可能空白）",
      }));
  } catch { coverage = []; }

  return { topic, gap: answer, coverage, totalDocs };
}

// ═══ 2. 研究框架与论证结构设计 ═══
// LLM 设计框架 + 专属算法: 框架模板匹配（按主题特征推荐适配的论文结构模板）
export async function frameworkDesign(topic: string, researchType: string, opts: { model?: string } = {}) {
  // 专属算法: 框架模板库（按研究类型匹配模板）
  const TEMPLATES: Record<string, { name: string; structure: string[]; suited: string }> = {
    "理论研究": { name: "概念辨析-理论溯源-现实关照-批判反思", structure: ["概念辨析：界定核心概念", "理论溯源：追溯思想脉络", "现实关照：联系当代实践", "批判反思：理论评价与局限"], suited: "哲学/理论/概念类研究" },
    "实证研究": { name: "问题提出-文献综述-研究设计-实证分析-结论政策", structure: ["问题提出：研究背景与问题", "文献综述：研究现状与缺口", "研究设计：数据与方法", "实证分析：结果与稳健性", "结论政策：结论与启示"], suited: "计量/案例/调查类研究" },
    "历史研究": { name: "时代背景-历史演进-阶段分析-历史启示", structure: ["时代背景：历史语境", "历史演进：发展脉络", "阶段分析：分期与特征", "历史启示：现实借鉴"], suited: "历史/思想史/制度史类研究" },
    "比较研究": { name: "比较框架-对象描述-异同比较-结论启示", structure: ["比较框架：比较维度", "对象描述：各比较对象", "异同比较：横向对照", "结论启示：规律与借鉴"], suited: "跨国/跨区域/跨学派类研究" },
    "文本研究": { name: "文本考辨-思想梳理-理论阐释-当代价值", structure: ["文本考辨：版本与原文", "思想梳理：核心观点", "理论阐释：体系解读", "当代价值：现实意义"], suited: "经典文本/文献类研究" },
    "政策研究": { name: "政策背景-现状分析-问题诊断-对策建议", structure: ["政策背景：政策脉络", "现状分析：执行现状", "问题诊断：问题与成因", "对策建议：优化路径"], suited: "政策/治理/制度类研究" },
  };
  const template = TEMPLATES[researchType] ?? TEMPLATES["理论研究"];

  const prompt = `你是论文框架设计专家。请针对研究问题"${topic}"（类型：${researchType}）设计论文框架：
1. 推荐论文结构（${template.name}）
2. 各章节的核心论证任务
3. 整体逻辑骨架（章节间的逻辑关系）
输出 JSON：{"structure":"结构名称","chapters":[{"title":"章节","task":"核心论证任务","logic":"与前章的逻辑关系"}],"logicSkeleton":"整体逻辑骨架","designRationale":"结构设计理由"}

参考模板：${template.structure.join(" → ")}（适用：${template.suited}）`;

  const answer = await llmJson(prompt, opts.model);
  return { topic, framework: answer, template: { name: template.name, structure: template.structure, suited: template.suited } };
}

// ═══ 3. 论证链条补全与逻辑校验 ═══
// LLM 梳理推理步骤 + 专属算法: 逻辑断层检测（论点间关键词衔接度——断开的链环节标记）
export async function argumentChainCompletion(claim: string, conclusion: string, opts: { model?: string } = {}) {
  const prompt = `你是论证逻辑专家。请梳理从核心论点"${claim}"到结论"${conclusion}"的完整推理步骤：
1. 推理链条（每步：前提→推论）
2. 识别逻辑断层（哪些环节缺少理论依据或实证支撑）
3. 提示需要补充的中间环节（如微观机制）
输出 JSON：{"chain":[{"step":"推理步骤","from":"前提","to":"推论","gap":"断层（无则空）"}],"gaps":[{"position":"断层位置","missing":"缺失的理论/实证支撑","suggestion":"补充建议"}],"supplements":[{"mechanism":"需补充的微观机制","evidence":"所需证据类型"}]}`;

  const answer = await llmJson(prompt, opts.model);

  // 专属算法: 逻辑断层检测（LLM 链条中标记 gap 的环节 → 量化断层度）
  const gapCount = (answer?.gaps ?? []).length;
  const chainLen = (answer?.chain ?? []).length;
  const gapScore = chainLen > 0 ? Math.round((gapCount / chainLen) * 100) : 0;

  return {
    claim,
    conclusion,
    chain: answer?.chain ?? [],
    gaps: answer?.gaps ?? [],
    supplements: answer?.supplements ?? [],
    gapScore,
    gapVerdict: gapScore === 0 ? "逻辑完整（无断层）" : gapScore < 40 ? "逻辑基本完整（少量断层）" : gapScore < 70 ? "逻辑断层较多（需补论证）" : "逻辑断裂严重（需重构）",
  };
}

// ═══ 4. 研究方法适配建议 ═══
// LLM 推荐方法 + 专属算法: 方法特征映射（主题关键词 → 方法适配矩阵）
export async function methodRecommendation(topic: string, researchType: string, opts: { model?: string } = {}) {
  // 专属算法: 方法-特征映射（主题关键词命中 → 推荐方法优先级）
  const METHODS: Array<{ name: string; keywords: string[]; suited: string; boundary: string; pitfalls: string }> = [
    { name: "文本研究法", keywords: ["概念", "文本", "原著", "经典", "解读", "阐释", "义理"], suited: "经典文本解读/概念辨析", boundary: "适用于文本内部分析，不适用于需要外部数据验证的问题", pitfalls: "容易脱离文本语境过度诠释" },
    { name: "比较研究法", keywords: ["比较", "对比", "差异", "异同", "中西方", "不同学派"], suited: "跨对象/跨学派/跨国比较", boundary: "需保证比较对象可比性（同维度/同时期）", pitfalls: "比较维度不统一导致结论失真" },
    { name: "历史分析法", keywords: ["历史", "演变", "演进", "发展历程", "溯源", "脉络"], suited: "制度变迁/思想史/政策演进", boundary: "需史料支撑，不可凭空建构历史叙事", pitfalls: "以今度古的辉格史观" },
    { name: "质性研究法", keywords: ["案例", "访谈", "田野", "扎根", "个案", "经验"], suited: "案例研究/过程机制/微观行为", boundary: "样本代表性有限，结论外推需谨慎", pitfalls: "个案选择性偏差" },
    { name: "定量研究法", keywords: ["数据", "计量", "实证", "面板", "回归", "效应", "统计"], suited: "因果识别/效应测度/规律检验", boundary: "需数据可得性与识别策略有效性", pitfalls: "内生性/遗漏变量/测量误差" },
    { name: "辩证分析法", keywords: ["矛盾", "辩证", "对立统一", "两重性", "双重"], suited: "哲学思辨/理论评价", boundary: "需基于文本事实，避免玄学化", pitfalls: "辩证法万能化" },
  ];
  // 主题关键词命中计数 → 推荐排序
  const scores = METHODS.map((m) => ({
    ...m,
    hit: m.keywords.filter((k) => topic.includes(k)).length,
  })).sort((a, b) => b.hit - a.hit);
  const topMatch = scores[0].hit > 0 ? scores.slice(0, 3) : METHODS.slice(0, 3);

  const prompt = `你是研究方法专家。请针对研究问题"${topic}"（类型：${researchType}）推荐适配的研究方法：
1. 推荐 2-3 种方法（含理由）
2. 每种方法的适用边界
3. 操作要点与常见误区
输出 JSON：{"recommendations":[{"method":"方法","rationale":"推荐理由","boundary":"适用边界","operations":"操作要点","pitfalls":"常见误区"}]}

候选方法：${topMatch.map((m) => `${m.name}（${m.suited}）`).join("、")}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    topic,
    recommendations: answer?.recommendations ?? [],
    matchedMethods: topMatch.map((m) => ({ name: m.name, suited: m.suited, boundary: m.boundary, pitfalls: m.pitfalls })),
  };
}

// ═══ 5. 反方视角与反驳意见生成 ═══
// LLM 生成批评/反例 + 专属算法: 前提弱化检测（关键前提扫描 → 易被攻击点）
export async function counterargumentGeneration(claim: string, argumentText: string, opts: { model?: string } = {}) {
  // 专属算法: 前提弱化检测（从论证文本中提取"绝对化表述"→ 反方攻击点）
  const absolutistPatterns = [
    { pattern: /必然|一定|绝对|全部|所有|无一/g, type: "绝对化表述" },
    { pattern: /本质上是|归根结底|实质上/g, type: "本质主义断言" },
    { pattern: /唯一|只有.*才能|必须/g, type: "排他性主张" },
    { pattern: /显著|大幅|剧烈|完全/g, type: "强度断言" },
  ];
  const weakPoints: Array<{ text: string; type: string; attack: string }> = [];
  for (const { pattern, type } of absolutistPatterns) {
    const matches = argumentText.match(pattern);
    if (matches) {
      weakPoints.push({ text: matches[0], type, attack: `反方可质疑"${matches[0]}"的绝对性：是否总是成立？有无反例？` });
    }
  }

  const prompt = `你是批判性思维专家。请针对以下核心论点生成反方视角与反驳意见：
1. 对立学派的批评观点
2. 逻辑反例
3. 理论前提质疑
4. 对反方的回应建议
输出 JSON：{"criticisms":[{"view":"批评观点","source":"对立学派/立场"}],"counterExamples":["逻辑反例"],"premiseChallenges":["前提质疑"],"responses":["回应建议"]}

核心论点：${claim}
论证文本：${argumentText.substring(0, 1500)}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    claim,
    counter: answer,
    weakPoints,
    weakVerdict: weakPoints.length === 0 ? "论证较审慎（未发现绝对化表述）" : `发现 ${weakPoints.length} 处易被攻击的表述（${weakPoints.map((w) => w.type).join("、")}）`,
  };
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

export const writingResearchService = {
  researchGapIdentification,
  frameworkDesign,
  argumentChainCompletion,
  methodRecommendation,
  counterargumentGeneration,
};
