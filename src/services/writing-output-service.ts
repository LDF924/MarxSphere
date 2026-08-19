// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// writing-output-service.ts — 论文写作输出 5 大能力（S51-S55）
// 高质量文献综述生成 / 学术段落扩写润色 / 规范化学术要件生成 / 引文与参考文献格式化 / 多场景语体适配
// 复用: 检索 + LLM + citation-service；专属算法: 综述结构模板 / 语体规则库 / 引文格式生成器 / 要件模板 / 口语化检测
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";

// ═══ 1. 高质量文献综述生成 ═══
// 专属算法: 综述结构模板（研究缘起-发展脉络-学派分歧-研究共识-现存不足）+ LLM 按模板生成 + 来源标注
export async function literatureReviewGeneration(topic: string, sourceId: string, opts: { topK?: number; model?: string } = {}) {
  const topK = opts.topK ?? 20;
  const chunks = await retrieveChunks(topic, sourceId, topK);
  if (chunks.length === 0) return { topic, review: null, error: "知识库中未检索到该主题相关文献" };

  // 专属算法: 综述结构模板（拒绝观点堆砌，突出学术脉络）
  const STRUCTURE = [
    { section: "研究缘起", task: "为什么这个问题值得研究（学术背景与问题意识）" },
    { section: "发展脉络", task: "研究如何演进（按时间/思想史梳理，标注关键节点）" },
    { section: "学派分歧", task: "不同学派/立场的主要分歧与争论" },
    { section: "研究共识", task: "已有研究的共同结论与稳定发现" },
    { section: "现存不足", task: "方法论局限/视角盲区/未解问题" },
  ];

  const prompt = `你是文献综述专家。请针对主题"${topic}"按以下结构生成高质量综述初稿：
${STRUCTURE.map((s, i) => `${i + 1}. ${s.section}：${s.task}`).join("\n")}

要求：
1. 突出学术脉络与研究演进，拒绝观点堆砌
2. 每个观点必须标注文献来源（[作者·年份] 或 [来源论文标题]）
3. 输出 JSON：{"sections":[{"section":"章节名","content":"综述内容(每观点带来源标注)"}],"citations":["引用的文献清单"]}

文献片段：
${chunks.map((c, i) => `[${i + 1}] 来源:${c.title} 章节:${c.heading}\n${c.content.substring(0, 400)}`).join("\n\n")}`;

  const answer = await llmJson(prompt, opts.model, 8000);
  return {
    topic,
    structure: STRUCTURE,
    review: answer,
    totalChunks: chunks.length,
  };
}

// ═══ 2. 学术段落扩写与润色 ═══
// LLM 扩写 + 专属算法: 口语化/主观化检测（正则扫描 → 标注需改写处）
export async function paragraphExpansion(coreIdea: string, topic: string, opts: { style?: string; model?: string } = {}) {
  // 专属算法: 口语化/主观化检测
  const informalPatterns = [
    { pattern: /我觉得|我认为|感觉|好像|挺|蛮|特别特别|非常非常|真的/g, type: "口语化" },
    { pattern: /显而易见|毫无疑问|众所周知|显然|当然/g, type: "绝对化判断" },
    { pattern: /牛逼|厉害|棒|不错|很好/g, type: "非学术评价" },
    { pattern: /其实|说白了|换句话说|讲真的/g, type: "口语连接词" },
  ];
  const detected: Array<{ text: string; type: string }> = [];
  for (const { pattern, type } of informalPatterns) {
    const matches = coreIdea.match(pattern);
    if (matches) detected.push({ text: matches[0], type });
  }

  const prompt = `你是学术写作专家。请基于核心观点扩写为严谨的学术段落：
【核心观点】${coreIdea}
【研究主题】${topic}
【语体要求】${opts.style ?? "标准哲社科学术语体"}

要求：
1. 补充理论依据与逻辑论证
2. 去除口语化、主观化表达
3. 适配哲社科学术语体（严谨/客观/规范）
4. 输出 JSON：{"paragraph":"扩写后的学术段落(300-500字)","theoryBasis":"补充的理论依据","improvements":[{"original":"原文表达","revised":"规范表达"}]}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    coreIdea,
    paragraph: answer?.paragraph ?? "",
    theoryBasis: answer?.theoryBasis ?? "",
    improvements: answer?.improvements ?? [],
    informalDetected: detected,
    style: opts.style ?? "标准哲社科学术语体",
  };
}

// ═══ 3. 规范化学术要件生成 ═══
// 专属算法: 要件模板（摘要/关键词/引言/结论/英文摘要按论文信息填充）+ LLM 生成
export async function academicComponentsGeneration(input: {
  title: string;
  topic: string;
  method: string;
  findings: string;
  type: "期刊论文" | "学位论文";
  model?: string;
}) {
  // 专属算法: 要件模板（固定结构，LLM 按模板填充）
  const COMPONENTS: Array<{ key: string; name: string; template: string }> = [
    { key: "abstract", name: "中文摘要", template: "【目的】…【方法】…【结果】…【结论】…（150-300字）" },
    { key: "keywords", name: "关键词", template: "3-5 个核心概念，用分号分隔" },
    { key: "introduction", name: "引言", template: "研究背景 → 问题提出 → 研究意义 → 本文结构（400-600字）" },
    { key: "conclusion", name: "结论", template: "核心发现总结 → 理论贡献 → 实践启示 → 研究局限与展望（300-500字）" },
    { key: "abstractEn", name: "英文摘要", template: "Title + Abstract（与中文摘要对应）+ Keywords" },
  ];

  const prompt = `你是学术写作专家。请为以下论文生成规范化学术要件：
【标题】${input.title}
【主题】${input.topic}
【研究方法】${input.method}
【核心发现】${input.findings}
【类型】${input.type}

按模板生成：
${COMPONENTS.map((c) => `${c.name}（模板：${c.template}）`).join("\n")}

要求：突出研究创新点、研究方法与核心结论，符合学术写作规范。
输出 JSON：{"abstract":"中文摘要","keywords":"关键词","introduction":"引言","conclusion":"结论","abstractEn":"英文摘要(含Title)"}`;

  const answer = await llmJson(prompt, input.model);
  return {
    title: input.title,
    components: answer,
    templates: COMPONENTS,
  };
}

// ═══ 4. 引文与参考文献格式化 ═══
// 专属算法: 引文格式生成器（GB/T 7714 / APA / MLA 三格式）+ 核对
export function formatCitation(input: {
  authors: string[];
  year: string;
  title: string;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  city?: string;
  doi?: string;
}): Record<string, string> {
  const a = input.authors;
  const year = input.year;
  const title = input.title;
  const journal = input.journal ?? "";
  const volume = input.volume ?? "";
  const issue = input.issue ?? "";
  const pages = input.pages ?? "";
  const publisher = input.publisher ?? "";
  const city = input.city ?? "";
  const doi = input.doi ?? "";

  const gb7714 = a.length > 3
    ? `${a[0]} 等. ${title}[J]. ${journal}, ${year}, ${volume}(${issue}): ${pages}.`
    : `${a.join(", ")}. ${title}[J]. ${journal}, ${year}, ${volume}(${issue}): ${pages}.`;
  const apa = a.length > 3
    ? `${a[0]} et al. (${year}). ${title}. ${journal}, ${volume}(${issue}), ${pages}.`
    : `${a.join(", ")} (${year}). ${title}. ${journal}, ${volume}(${issue}), ${pages}.`;
  const mla = `${a[0]}${a.length > 1 ? `, et al.` : ""}. "${title}." ${journal}, vol. ${volume}, no. ${issue}, ${year}, pp. ${pages}.`;

  return { gb7714, apa, mla };
}

export async function citationFormatting(input: {
  rawText: string;
  format: "GB/T 7714" | "APA" | "MLA";
  model?: string;
}) {
  // 专属算法: 从原始文本提取引文条目（正则，GB/T 7714 特征）→ 生成目标格式
  const lines = input.rawText.split(/\n+/).filter((l) => l.trim().length > 5);
  const formatted: Array<{ original: string; converted: string }> = [];
  for (const line of lines.slice(0, 20)) {
    // 尝试解析作者/年份/标题（简化解析：年份前后切分）
    const yearMatch = line.match(/(19|20)\d{2}/);
    const authorMatch = line.match(/^([^.\d]+?)[.．]/);
    if (yearMatch && authorMatch) {
      const authors = authorMatch[1].trim().split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
      const year = yearMatch[0];
      const titlePart = line.slice(authorMatch[0].length);
      const title = titlePart.split(/[.．,，]/)[0]?.trim() ?? titlePart.substring(0, 40);
      const converted = formatCitation({ authors, year, title });
      formatted.push({ original: line.substring(0, 80), converted: converted[input.format === "GB/T 7714" ? "gb7714" : input.format === "APA" ? "apa" : "mla"] });
    }
  }

  // LLM 补充：核对与修正
  const prompt = `你是参考文献格式专家。请将以下参考文献列表转换为 ${input.format} 格式，并核对完整性：
${input.rawText.substring(0, 1500)}

输出 JSON：{"convertedList":"转换后的完整列表","errors":[{"issue":"问题","fix":"修正建议"}]}`;

  const answer = await llmJson(prompt, input.model);
  return {
    format: input.format,
    autoConverted: formatted,
    llmConverted: answer?.convertedList ?? "",
    errors: answer?.errors ?? [],
  };
}

// ═══ 5. 多场景语体适配 ═══
// 专属算法: 语体规则库（5 场景 × 严谨度/通俗度/理论深度）+ LLM 改写
export async function styleAdaptation(text: string, scene: string, opts: { model?: string } = {}) {
  // 专属算法: 语体规则库
  const STYLES: Record<string, { level: string; rules: string[] }> = {
    "期刊论文": { level: "严谨性最高，理论深度高", rules: ["术语规范", "论证严密", "避免口语", "客观中立"] },
    "学位论文": { level: "严谨性高，系统性最强", rules: ["体系完整", "章节分明", "文献充分", "格式规范"] },
    "会议论文": { level: "严谨性高，篇幅精简", rules: ["问题聚焦", "创新突出", "论证简洁"] },
    "理论宣传文稿": { level: "严谨性与通俗性平衡", rules: ["通俗易懂", "政治准确", "案例鲜活", "人民立场"] },
    "课程论文": { level: "教学导向，理论与学习并重", rules: ["结构清晰", "论证完整", "结合课堂所学"] },
  };
  const style = STYLES[scene] ?? STYLES["期刊论文"];

  // 口语化检测（复用）
  const informalPatterns = [
    { pattern: /我觉得|我感觉|好像|挺|蛮/g, type: "口语化" },
    { pattern: /显而易见|毫无疑问|众所周知/g, type: "绝对化判断" },
    { pattern: /说白了|其实/g, type: "口语连接词" },
  ];
  const detected: Array<{ text: string; type: string }> = [];
  for (const { pattern, type } of informalPatterns) {
    const m = text.match(pattern);
    if (m) detected.push({ text: m[0], type });
  }

  const prompt = `你是语体适配专家。请将以下文本改写为「${scene}」语体：
【语体特征】${style.level}
【规则】${style.rules.join("、")}

原文：
${text.substring(0, 2000)}

输出 JSON：{"rewritten":"改写后的文本","adjustments":[{"aspect":"调整维度","from":"原文","to":"改写后"}],"notes":"语体说明"}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    scene,
    style,
    rewritten: answer?.rewritten ?? "",
    adjustments: answer?.adjustments ?? [],
    notes: answer?.notes ?? "",
    informalDetected: detected,
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

export const writingOutputService = {
  literatureReviewGeneration,
  paragraphExpansion,
  academicComponentsGeneration,
  citationFormatting,
  formatCitation,
  styleAdaptation,
};
