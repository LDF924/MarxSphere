// theory-reflection-service.ts — 理论思辨拓展 5 大能力（S61-S65）
// 理论前提反思 / 跨学科视角拓展 / 理论与现实联结 / 理论创新点识别 / 理论体系建构
// 复用: LLM + 检索；专属算法: 前提分类库 / 学科映射库 / 理论-案例匹配 / 创新点扫描 / 体系一致性检测
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";
import { embeddingClient } from "../ai/embedding-client.js";

// ═══ 1. 理论前提反思 ═══
// LLM 揭示前提 + 专属算法: 前提分类库（默认假设/价值立场/认识论前提的信号词扫描）
export async function premiseReflection(claim: string, text: string, opts: { model?: string } = {}) {
  // 专属算法: 前提信号词检测（揭示文本默认假设）
  const PREMISE_PATTERNS: Array<{ pattern: RegExp; type: string; premise: string }> = [
    { pattern: /市场是有效|市场能够自发|看不见的手/g, type: "默认假设", premise: "市场有效性假设" },
    { pattern: /理性人|经济人|利益最大化/g, type: "默认假设", premise: "理性人假设" },
    { pattern: /应当|必须|应该/g, type: "价值立场", premise: "规范性价值判断" },
    { pattern: /客观|中立|科学地/g, type: "认识论前提", premise: "实证主义认识论（价值中立）" },
    { pattern: /发展即进步|现代化即/g, type: "价值立场", premise: "线性进步观" },
    { pattern: /本质|归根结底/g, type: "认识论前提", premise: "本质主义" },
  ];
  const detectedPremises: Array<{ type: string; premise: string; evidence: string }> = [];
  for (const { pattern, type, premise } of PREMISE_PATTERNS) {
    const m = (text + " " + claim).match(pattern);
    if (m) detectedPremises.push({ type, premise, evidence: m[0] });
  }

  const prompt = `你是理论反思专家。请对以下研究主张做理论前提反思：
1. 揭示默认的理论预设（如市场有效性/理性人/线性进步）
2. 揭示价值立场
3. 揭示认识论前提
4. 分析前提合理性 + 提供替代视角与范式
输出 JSON：{"premises":[{"premise":"前提","type":"理论预设|价值立场|认识论前提","evidence":"文本依据","rationale":"合理性分析"}],"alternatives":[{"view":"替代视角","paradigm":"研究范式","difference":"与现有前提的差异"}]}

研究主张：${claim}
研究文本：${text.substring(0, 3000)}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    claim,
    detectedPremises,
    premises: answer?.premises ?? [],
    alternatives: answer?.alternatives ?? [],
  };
}

// ═══ 2. 跨学科视角拓展 ═══
// LLM 引入相邻学科 + 专属算法: 学科映射库（政治经济学 ↔ 社会学/政治学/法学等交叉映射）
export async function interdisciplinaryExpansion(topic: string, discipline: string, opts: { model?: string } = {}) {
  // 专属算法: 学科交叉映射库
  const CROSS_MAP: Record<string, Array<{ discipline: string; framework: string; application: string }>> = {
    "政治经济学": [
      { discipline: "社会学", framework: "社会网络/嵌入性理论", application: "分析经济行为的社会嵌入（格兰诺维特）" },
      { discipline: "政治学", framework: "国家能力/治理理论", application: "分析国家-市场-社会关系中的权力配置" },
      { discipline: "法学", framework: "产权理论/制度法学", application: "分析产权界定与制度变迁的规则逻辑" },
      { discipline: "人类学", framework: "互惠/礼物经济", application: "分析非市场交换与社会关系再生产" },
    ],
    "经济学": [
      { discipline: "社会学", framework: "制度社会学", application: "分析制度的非正式约束" },
      { discipline: "心理学", framework: "行为经济学", application: "分析有限理性与偏好异质性" },
    ],
  };
  const cross = CROSS_MAP[discipline] ?? [
    { discipline: "社会学", framework: "社会结构分析", application: "补充社会维度" },
    { discipline: "政治学", framework: "权力与制度", application: "补充政治维度" },
  ];

  const prompt = `你是跨学科研究专家。请为研究主题"${topic}"（学科：${discipline}）引入相邻学科的理论资源：
1. 推荐 2-3 个相邻学科及其理论框架
2. 每个框架如何应用于本主题
3. 跨学科融合的潜在洞见
输出 JSON：{"perspectives":[{"discipline":"学科","framework":"理论框架","application":"应用方式","insight":"潜在洞见"}],"integration":"跨学科整合建议","boundaries":"跨学科适用边界"}

候选交叉学科：${cross.map((c) => `${c.discipline}（${c.framework}）`).join("、")}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    topic,
    discipline,
    mappedCandidates: cross,
    perspectives: answer?.perspectives ?? [],
    integration: answer?.integration ?? "",
    boundaries: answer?.boundaries ?? "",
  };
}

// ═══ 3. 理论与现实联结 ═══
// LLM 搭桥 + 专属算法: 理论-案例匹配（理论关键词 × 现实案例库 embedding 相似度）
export async function theoryRealityBridge(theory: string, claim: string, realCases: string, opts: { model?: string } = {}) {
  // 专属算法: 理论-案例相似度匹配（embedding 余弦，从用户提供的案例文本中找最相关案例）
  let matchedCases: Array<{ text: string; similarity: number }> = [];
  try {
    const cases = realCases.split(/\n+/).filter((c) => c.trim().length > 15).slice(0, 10);
    if (cases.length > 0) {
      const vecTheory = await embeddingClient.generate(`${theory} ${claim}`);
      const vecCases = await embeddingClient.batchGenerate(cases.map((c) => c.substring(0, 300)));
      const cos = (v1: number[], v2: number[]) => {
        let dot = 0, n1 = 0, n2 = 0;
        for (let k = 0; k < v1.length; k++) { dot += v1[k] * v2[k]; n1 += v1[k] * v1[k]; n2 += v2[k] * v2[k]; }
        return n1 && n2 ? dot / (Math.sqrt(n1) * Math.sqrt(n2)) : 0;
      };
      matchedCases = cases.map((c, i) => ({ text: c, similarity: Math.round(cos(vecTheory, vecCases[i]) * 1000) / 1000 }))
        .filter((m) => m.similarity > 0.4)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 3);
    }
  } catch { matchedCases = []; }

  const prompt = `你是理论应用专家。请搭建"理论命题 - 现实案例 - 机制分析"的桥梁：
【理论】${theory}
【理论命题】${claim}
【现实案例】${realCases.substring(0, 1500)}

输出 JSON：{"theoryPropositions":[{"proposition":"理论命题","mechanism":"对应机制"}],"caseAnalysis":[{"case":"案例","matchedProposition":"匹配的理论命题","mechanism":"机制分析","evidence":"案例证据"}],"bridge":"理论与现实的联结逻辑","limits":"理论适用边界"}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    theory,
    theoryPropositions: answer?.theoryPropositions ?? [],
    caseAnalysis: answer?.caseAnalysis ?? [],
    bridge: answer?.bridge ?? "",
    limits: answer?.limits ?? "",
    algorithmMatched: matchedCases,
  };
}

// ═══ 4. 理论创新点识别 ═══
// LLM 识别创新空间 + 专属算法: 创新信号扫描（"空白/未解/争议/不足"等信号词 → 创新切入点）
export async function innovationPointIdentification(topic: string, text: string, opts: { model?: string } = {}) {
  // 专属算法: 创新信号词扫描（文本中表明"研究空间"的位置）
  const SIGNAL_PATTERNS = [
    { pattern: /尚未|还未|缺乏|不足|空白|盲区/g, type: "研究空白" },
    { pattern: /存在争议|争论|分歧/g, type: "学术争议" },
    { pattern: /值得进一步|有待|需要深入/g, type: "研究延伸" },
    { pattern: /新视角|新范式|重新审视/g, type: "范式转换" },
  ];
  const signals: Array<{ type: string; evidence: string }> = [];
  for (const { pattern, type } of SIGNAL_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) signals.push({ type, evidence: matches.slice(0, 3).join("；") });
  }

  const prompt = `你是理论创新专家。请为研究主题"${topic}"识别理论创新点：
1. 现有研究的理论局限
2. 可创新的理论空间（概念/视角/方法/框架）
3. 创新点的学术价值
输出 JSON：{"limitations":[{"limit":"现有局限","detail":"详情"}],"innovations":[{"point":"创新点","type":"概念创新|视角创新|方法创新|框架创新","rationale":"学术价值","novelty":"新颖性"}],"positioning":"创新定位"}

研究文本：${text.substring(0, 3000)}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    topic,
    signals,
    limitations: answer?.limitations ?? [],
    innovations: answer?.innovations ?? [],
    positioning: answer?.positioning ?? "",
  };
}

// ═══ 5. 理论体系建构 ═══
// LLM 整合命题 + 专属算法: 体系一致性检测（命题间矛盾信号/术语统一性）
export async function theoreticalSystemConstruction(propositions: string[], topic: string, opts: { model?: string } = {}) {
  // 专属算法: 命题一致性检测（矛盾信号词对 + 关键术语统一性）
  const contradictionSignals: Array<{ text: string; type: string }> = [];
  for (const p of propositions) {
    if (/既.*又.*然而/.test(p) || /一方面.*另一方面.*但/.test(p)) {
      contradictionSignals.push({ text: p.substring(0, 60), type: "命题内部张力" });
    }
  }
  // 术语统一性（各命题中核心术语是否一致）
  const termFreq: Record<string, number> = {};
  for (const p of propositions) {
    const terms = p.match(/[一-龥]{2,5}(论|机制|效应|关系|理论|范式)/g) ?? [];
    for (const t of terms) termFreq[t] = (termFreq[t] ?? 0) + 1;
  }
  const inconsistentTerms = Object.entries(termFreq).filter(([, count]) => count === 1).slice(0, 5).map(([t]) => t);

  const prompt = `你是理论建构专家。请将以下命题整合为自洽的理论体系：
【主题】${topic}
【命题】${propositions.map((p, i) => `${i + 1}. ${p}`).join("\n")}

输出 JSON：{"framework":"理论体系框架","coreConcepts":[{"concept":"核心概念","definition":"定义","relations":"与其它概念关系"}],"propositionLinks":[{"from":"命题","to":"命题","relation":"逻辑关系"}],"coherence":"体系自洽性说明","gaps":["体系中的薄弱环节"]}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    topic,
    framework: answer?.framework ?? "",
    coreConcepts: answer?.coreConcepts ?? [],
    propositionLinks: answer?.propositionLinks ?? [],
    coherence: answer?.coherence ?? "",
    gaps: answer?.gaps ?? [],
    contradictionSignals,
    inconsistentTerms,
  };
}

export const theoryReflectionService = {
  premiseReflection,
  interdisciplinaryExpansion,
  theoryRealityBridge,
  innovationPointIdentification,
  theoreticalSystemConstruction,
};

// ═══ 工具函数 ═══

async function llmJson(prompt: string, modelOverride?: string, maxTokens = 4000): Promise<any | null> {
  const ep = getLlmEndpoint({ model: modelOverride || getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url,
    key: ep.key,
    model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON，不要其他文字。" }],
    temperature: 0.2,
    maxTokens,
    timeoutMs: 180_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}
