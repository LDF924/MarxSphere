// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// literature-matrix-service.ts — 文献提取矩阵(参考 Elicit 数据提取成表机制, 闭源仅借鉴思路)
// 选论文集 → 定义提取列 → LLM 逐篇提取字段 → 表格(可排序/每格可链源文)
import { literatureService } from "./literature-service.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";

export interface MatrixColumn {
  key: string;        // 英文标识(如 method / sample / conclusion)
  label: string;      // 中文列名(如 研究方法 / 样本量 / 核心结论)
}

export interface MatrixCell {
  paperId: string;
  paperTitle: string;
  columnKey: string;
  value: string;
  quote?: string;      // 来源引文(链回源文)
}

export interface MatrixResult {
  papers: Array<{ id: string; title: string }>;
  columns: MatrixColumn[];
  cells: MatrixCell[];   // paperId × columnKey 平铺
  warnings: string[];
}

async function llmJson(prompt: string, modelOverride?: string, maxTokens = 3000): Promise<any | null> {
  const ep = getLlmEndpoint({ model: modelOverride || getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url,
    key: ep.key,
    model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON，不要其他文字。" }],
    temperature: 0.1,
    maxTokens,
    timeoutMs: 240_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}

/** 取论文正文(文献库文件索引 → 读 md 文件正文; 截断防超长) */
async function loadPaperText(paperIds: string[]): Promise<Array<{ id: string; title: string; text: string }>> {
  const ids = paperIds.slice(0, 30);
  const out: Array<{ id: string; title: string; text: string }> = [];
  for (const id of ids) {
    try {
      const detail = await literatureService.getDetail(id);
      const body = detail?.originalText ?? detail?.summary ?? "";
      out.push({ id, title: detail?.paperTitle ?? detail?.title ?? id, text: String(body).slice(0, 12_000) });
    } catch { /* 单篇失败跳过 */ }
  }
  return out;
}

/**
 * 逐篇提取: 每篇论文 → 各列值(LLM)
 */
export async function buildLiteratureMatrix(input: {
  paperIds: string[];
  columns: MatrixColumn[];
  model?: string;
}): Promise<MatrixResult> {
  const papers = await loadPaperText(input.paperIds);
  const warnings: string[] = [];
  if (papers.length === 0) return { papers: [], columns: input.columns, cells: [], warnings: ["未找到论文(检查 ID)"] };
  if (papers.length < input.paperIds.length) warnings.push(`有 ${input.paperIds.length - papers.length} 篇未找到或为空`);

  const cells: MatrixCell[] = [];
  const colDesc = input.columns.map((c) => `"${c.key}":"${c.label}"`).join(", ");

  for (const paper of papers) {
    if (!paper.text.trim()) { warnings.push(`「${paper.title}」无正文可提取`); continue; }
    const prompt = `你是人文社科学术文献提取员。从论文提取以下字段并输出 JSON。
只基于论文原文, 不推测; 找不到的字段给空字符串。

【论文标题】${paper.title}
【论文正文(截断)】\n${paper.text}

【提取字段】{ ${colDesc} }
【输出】{"values":{"<字段key>":"提取值(中文, ≤80字)"},"quote":"支撑引文(原文一句话, ≤120字; 无则空)"}`;
    const answer = await llmJson(prompt, input.model, 3000);
    const values = answer?.values as Record<string, unknown> | undefined;
    if (values && typeof values === "object") {
      for (const col of input.columns) {
        const v = String(values[col.key] ?? "").trim();
        if (v) {
          cells.push({
            paperId: paper.id,
            paperTitle: paper.title,
            columnKey: col.key,
            value: v,
            quote: typeof answer?.quote === "string" ? String(answer.quote).slice(0, 200) : undefined,
          });
        }
      }
    } else {
      warnings.push(`「${paper.title}」提取失败(输出非预期)`);
    }
  }
  return { papers: papers.map((p) => ({ id: p.id, title: p.title })), columns: input.columns, cells, warnings };
}
