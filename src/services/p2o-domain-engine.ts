// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// p2o-domain-engine.ts — V395-12: skill(pdf2obsidian) 领域能力整合 P2O 工作台
// 复用自研 skill 的领域深度 prompt（FIELD_CONTEXT 资本下乡研究领域上下文）
// 任务完成后重生成 摘要/术语表/问答 三产物 → 覆盖 vendor 通用产物
// 引擎: DeepSeek/MAAS（与 skill 同源: LLM_BASE_URL=dashscope, LLM_MODEL=qwen-plus 或 DEEPSEEK_API_KEY）
import fs from "node:fs/promises";
import path from "node:path";

/** 研究领域上下文（移植自 skill scripts/generate.py FIELD_CONTEXT — 资本规范与治理全领域） */
export const FIELD_CONTEXT =
  "资本规范与引导、资本治理、资本市场、资本监管、资本健康发展、" +
  "金融监管/金融监管改革、证券市场监管、资本无序扩张、平台经济反垄断、" +
  "社会资本、政府与社会资本合作(PPP)、民间资本、私募基金/私募股权、" +
  "公司法/公司治理、新公司法、注册资本、企业合规、" +
  "信息披露、会计规范、投资者保护、" +
  "数字经济/数字资本、数字经济治理、" +
  "工商资本、共同富裕、合作社、农民增收/农民收入、农业经济、农业农村现代化、" +
  "三农、田野调查、乡村产业振兴、乡村干部/乡镇干部、乡村农业/乡镇农业、" +
  "乡村企业/乡镇企业、乡村振兴、乡村治理/乡村基层治理/乡镇治理、" +
  "中国式现代化、资本参与、资本下乡";

/** 摘要 prompt（skill generate_summary） */
export function domainSummaryPrompt(): string {
  return `你是中国社会科学、金融经济学、公共管理与资本市场治理领域的资深学术编辑。
研究领域覆盖：${FIELD_CONTEXT}。

阅读以下论文，生成 10 条编号要点摘要，每条 80-120 字。要求：
- 每条引用正文中对应的文献编号（如 [5]、[8,10]）
- 覆盖：核心概念界定、理论框架、研究方法与数据来源、主要实证发现、政策建议
- 对涉及金融/资本市场的论文，指出具体监管政策文件、时间节点
- 对涉及田野调查的论文，指出调查地点、样本量和研究方法
- 区分"资本下乡""社会资本""资本要素""资本无序扩张"等不同语境

只输出摘要内容，不要任何标题或其他说明。`;
}

/** 术语表 prompt（skill generate_glossary） */
export function domainGlossaryPrompt(): string {
  return `你是中国社会科学、金融经济学、公共管理与资本市场治理领域的术语专家。
研究领域覆盖：${FIELD_CONTEXT}。

从论文中提取 15-25 个关键学术术语，输出 JSON 数组。每个术语给出在该论文语境下的精准学术释义（1-2句）。

特别关注以下类型术语：
- 核心概念：论文提出或重点讨论的学术概念（如"资本红绿灯""资本无序扩张""耐心资本""注册制""代表人诉讼"等）
- 政策术语：中央经济工作会议、金融监管政策文件中的专有名词
- 金融/法律术语：信息披露、关联交易、合规管理、实缴资本、认缴制、PPP等
- 研究方法：田野调查、双重差分、案例分析、实证研究等
- 理论框架：制度变迁理论、嵌入性理论、利益联结机制、资本有机构成等
- 经济学术语：资本要素、市场准入、反垄断、多层次资本市场等

输出纯 JSON 数组：
[{"term":"中文术语","english":"English Term","definition":"基于本文的精准学术释义"},...]`;
}

/** 问答 prompt（skill generate_qa） */
export function domainQaPrompt(): string {
  return `你是中国社会科学、金融经济学、公共管理与资本市场治理领域的教学专家。
研究领域覆盖：${FIELD_CONTEXT}。

基于论文生成 8-12 道复习问答。要求：
- 覆盖以下维度：
  * methodology（研究方法：数据来源、样本量、调查地点、计量模型）
  * finding（主要发现：实证结果、案例总结、机制分析）
  * theory（理论框架：核心概念、理论假说、分析框架）
  * policy（政策启示：政策建议、现实意义、制度设计）
- 问题要具体，答案要以"答："开头，引用论文中的具体内容
- 对涉及田野调查的论文，至少 1 道关于研究方法的题目
- 对涉及政策建议的论文，至少 1 道关于政策启示的题目
- 区分"资本下乡""社会资本""资本要素""资本无序扩张""金融资本"等不同语境

输出纯 JSON 数组：
[{"question":"具体问题？","answer":"答：基于论文内容的具体回答。","type":"methodology|finding|theory|policy"},...]`;
}

/** 统一 LLM 调用（与 skill 同源: 优先 DeepSeek, 回退 dashscope MAAS） */
async function callLlm(system: string, excerpt: string, maxTokens = 4096): Promise<string> {
  const dsKey = process.env.DEEPSEEK_API_KEY || "";
  const endpoint = dsKey
    ? { url: process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions", model: process.env.P2O_DOMAIN_MODEL || "deepseek-chat", key: dsKey }
    : { url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: process.env.P2O_DOMAIN_MODEL || "qwen-plus", key: process.env.LLM_API_KEY || "" };
  const res = await fetch(endpoint.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.key}` },
    body: JSON.stringify({
      model: endpoint.model,
      messages: [{ role: "system", content: system }, { role: "user", content: `论文内容：\n${excerpt}` }],
      temperature: 0.5, max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`领域引擎 LLM 调用失败 (${res.status})`);
  const data: any = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

/** 从 JSON 块提取数组（skill _parse_json_response 同逻辑） */
function parseJsonArray(text: string): any[] | null {
  let t = text.trim();
  if (t.startsWith("```")) {
    const lines = t.split(/\r?\n/);
    t = lines.slice(1, -1).join("\n");
  }
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** 领域术语表 markdown（对齐 skill _format_glossary: 表格） */
function glossaryToMarkdown(list: any[]): string {
  const rows = (list || []).map((g) => {
    const term = String(g?.term || "").trim();
    const en = String(g?.english || "").trim();
    const def = String(g?.definition || "").trim();
    if (!term) return "";
    return `| ${term} | ${en} | ${def} |`;
  }).filter(Boolean);
  return `# 术语表\n\n| 术语 | 中文译名 | 上下文解释 |\n|------|----------|------------|\n${rows.join("\n")}\n`;
}

/** 领域问答 markdown（对齐 skill _format_qa） */
function qaToMarkdown(list: any[]): string {
  const items = (list || []).map((q) => {
    const question = String(q?.question || "").trim();
    const answer = String(q?.answer || "").trim();
    const type = String(q?.type || "");
    if (!question) return "";
    const typeTag = type ? `（${type}）` : "";
    return `### ${question}${typeTag}\n\n${answer || "答：—"}\n`;
  }).filter(Boolean);
  return `# 问答\n\n${items.join("\n\n")}\n`;
}

/**
 * 用 skill 领域引擎重新生成一篇论文的阅读材料（摘要/术语表/问答）
 * @returns 各产物写盘路径（失败项省略）
 */
export async function regenerateDomainAssets(input: {
  slug: string;
  originalMarkdownPath: string;
  documentRoot: string;
  summaryFileName?: string;
  termsFileName?: string;
  qaFileName?: string;
}): Promise<{ summaryPath?: string; termsPath?: string; qaPath?: string; skipped?: string[] }> {
  const summaryFile = input.summaryFileName || "摘要.md";
  const termsFile = input.termsFileName || "术语表.md";
  const qaFile = input.qaFileName || "问答.md";
  const out: { summaryPath?: string; termsPath?: string; qaPath?: string; skipped?: string[] } = { skipped: [] };
  // 读取原文（取前 12000 字符, 与 skill excerpt 一致）
  let markdown = "";
  try {
    markdown = await fs.readFile(input.originalMarkdownPath, "utf8");
  } catch {
    out.skipped?.push("原文读取失败");
    return out;
  }
  const excerpt = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").slice(0, 12000);
  if (excerpt.trim().length < 100) { out.skipped?.push("原文过短"); return out; }

  try {
    await fs.mkdir(input.documentRoot, { recursive: true });
    // 摘要（纯文本要点）
    const summaryText = await callLlm(domainSummaryPrompt(), excerpt);
    const summaryPath = path.join(input.documentRoot, summaryFile);
    await fs.writeFile(summaryPath, `# 摘要\n\n${summaryText.trim()}\n`, "utf8");
    out.summaryPath = summaryPath;
  } catch (e: any) { out.skipped?.push(`摘要: ${String(e?.message || e).slice(0, 80)}`); }

  try {
    // 术语表（JSON → 表格）
    const glossaryRaw = await callLlm(domainGlossaryPrompt(), excerpt);
    const glossary = parseJsonArray(glossaryRaw);
    if (glossary && glossary.length >= 3) {
      const termsPath = path.join(input.documentRoot, termsFile);
      await fs.writeFile(termsPath, glossaryToMarkdown(glossary), "utf8");
      out.termsPath = termsPath;
    } else { out.skipped?.push("术语表解析失败"); }
  } catch (e: any) { out.skipped?.push(`术语表: ${String(e?.message || e).slice(0, 80)}`); }

  try {
    // 问答（JSON → 标题+答案）
    const qaRaw = await callLlm(domainQaPrompt(), excerpt);
    const qa = parseJsonArray(qaRaw);
    if (qa && qa.length >= 3) {
      const qaPath = path.join(input.documentRoot, qaFile);
      await fs.writeFile(qaPath, qaToMarkdown(qa), "utf8");
      out.qaPath = qaPath;
    } else { out.skipped?.push("问答解析失败"); }
  } catch (e: any) { out.skipped?.push(`问答: ${String(e?.message || e).slice(0, 80)}`); }

  return out;
}

export const p2oDomainEngine = { regenerateDomainAssets, domainSummaryPrompt, domainGlossaryPrompt, domainQaPrompt, FIELD_CONTEXT };
