// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// paper-structure-service.ts — 论文图/表/公式/算法解析（2026-08-29, Agentero 对照: 解析论文中的图表公式算法并结合上下文理解）
// 能力:
//   1. 从论文文本/Markdown 中定位 图(Figure/Fig.)/表(Table)/公式(公式编号)/算法(Algorithm) 块
//   2. 提取每个块的内容 + 前后文(上下文)
//   3. 调 LLM 生成结构化理解摘要(该图表在论证中的作用)
// 零依赖: 纯正则定位, 不解析 PDF 二进制(文本来自 OCR/MinerU/PDF 文本层)
import { callLlm } from "../ai/llm-common.js";

export interface PaperBlock {
  kind: "figure" | "table" | "formula" | "algorithm";
  label: string;          // 如 "图 1" / "Table 2" / "(3)" / "Algorithm 1"
  content: string;        // 块内容(截断)
  contextBefore: string;  // 前文(150 字)
  contextAfter: string;   // 后文(150 字)
}

/** 定位论文中的结构化块(图/表/公式/算法), 返回带上下文的块列表 */
export function extractPaperBlocks(text: string, maxBlocks = 30): PaperBlock[] {
  const blocks: PaperBlock[] = [];
  const lines = text.split("\n");
  const LINE_CTX = 12; // 上下文行数

  const pushBlock = (kind: PaperBlock["kind"], label: string, startLine: number, endLine: number) => {
    const content = lines.slice(startLine, endLine + 1).join("\n").trim().slice(0, 1200);
    if (content.length < 3) return;
    const ctxBefore = lines.slice(Math.max(0, startLine - LINE_CTX), startLine).join(" ").replace(/\s+/g, " ").slice(-200);
    const ctxAfter = lines.slice(endLine + 1, endLine + 1 + LINE_CTX).join(" ").replace(/\s+/g, " ").slice(0, 200);
    blocks.push({ kind, label, content, contextBefore: ctxBefore, contextAfter: ctxAfter });
  };

  for (let i = 0; i < lines.length && blocks.length < maxBlocks; i++) {
    const line = lines[i];
    // 图: Figure 1: / 图 1 / Fig. 1 开头或独立行
    const fig = line.match(/^(?:Figure|Fig\.?|图)\s*(\d+)[:：.\-—]\s*(.*)$/i);
    if (fig) {
      const label = `图 ${fig[1]}`;
      // 收集后续内容行(直到下一个标题/空行×2)
      let j = i + 1;
      let contentLines = [line];
      while (j < lines.length && j < i + 15) {
        const l = lines[j];
        if (/^(?:Figure|Fig\.?|图|Table|表|Algorithm|公式)\s*\d/i.test(l)) break;
        if (!l.trim()) { contentLines.push(l); if (j - i > 3 && !lines[j + 1]?.trim()) break; }
        else contentLines.push(l);
        j++;
      }
      pushBlock("figure", label, i, Math.min(j, i + 12));
      i = j - 1;
      continue;
    }
    // 表: Table 1: / 表 1
    const tbl = line.match(/^(?:Table|表)\s*(\d+)[:：.\-—]\s*(.*)$/i);
    if (tbl) {
      const label = `表 ${tbl[1]}`;
      let j = i + 1;
      while (j < lines.length && j < i + 20 && !/^(?:Figure|Fig\.?|图|Table|表|Algorithm|公式)\s*\d/i.test(lines[j])) j++;
      pushBlock("table", label, i, Math.min(j, i + 18));
      i = j - 1;
      continue;
    }
    // 算法: Algorithm 1 / 算法 1
    const algo = line.match(/^(?:Algorithm|算法)\s*(\d+)[:：.\-—]\s*(.*)$/i);
    if (algo) {
      const label = `算法 ${algo[1]}`;
      let j = i + 1;
      while (j < lines.length && j < i + 25 && !/^(?:Figure|Fig\.?|图|Table|表|Algorithm|算法)\s*\d/i.test(lines[j])) j++;
      pushBlock("algorithm", label, i, Math.min(j, i + 23));
      i = j - 1;
      continue;
    }
    // 公式: 行尾含 "(1)" 编号且行内含数学符号, 或行以编号开头
    const formula = line.match(/\((\d+(?:\.\d+)?)\)\s*$/) || line.match(/^\s*\((\d+(?:\.\d+)?)\)\s*/);
    if (formula && /[=≈≤≥×÷∑∫√±∂Δθλβγ]/.test(line)) {
      const label = `公式 (${formula[1]})`;
      let j = i;
      // 向后合并连续公式行
      while (j + 1 < lines.length && j + 1 < i + 4 && lines[j + 1].trim() && !/^(?:Figure|Fig\.?|图|Table|表|Algorithm)/i.test(lines[j + 1])) j++;
      pushBlock("formula", label, i, j);
      i = j;
    }
  }
  return blocks;
}

/** 图表公式算法 → LLM 理解摘要(作用/结论/与论证关系) */
export async function explainBlock(block: PaperBlock): Promise<{ ok: boolean; result?: string; error?: string }> {
  const kindLabel: Record<PaperBlock["kind"], string> = {
    figure: "图", table: "表", formula: "公式", algorithm: "算法",
  };
  try {
    const resp = await callLlm({
      messages: [
        { role: "system", content: "你是学术论文结构分析助手。用中文分析下面论文中的" + kindLabel[block.kind] + "，输出：(1) 它展示/实现了什么 (2) 关键信息/结论 (3) 在论文论证中的作用。分点输出。" },
        { role: "user", content: `【${kindLabel[block.kind]}标签】${block.label}\n【前文】${block.contextBefore}\n【内容】\n${block.content.slice(0, 1500)}\n【后文】${block.contextAfter}` },
      ],
      temperature: 0.3,
      maxTokens: 800,
    });
    const result = (resp?.text || "").trim();
    if (!result) return { ok: false, error: "AI 无返回" };
    return { ok: true, result };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** 全文结构概览: 列出全部图表公式算法 */
export function structureOverview(text: string): { figures: PaperBlock[]; tables: PaperBlock[]; formulas: PaperBlock[]; algorithms: PaperBlock[] } {
  const blocks = extractPaperBlocks(text);
  return {
    figures: blocks.filter((b) => b.kind === "figure"),
    tables: blocks.filter((b) => b.kind === "table"),
    formulas: blocks.filter((b) => b.kind === "formula"),
    algorithms: blocks.filter((b) => b.kind === "algorithm"),
  };
}

export const paperStructureService = { extractPaperBlocks, explainBlock, structureOverview };
