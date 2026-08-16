import fs from "node:fs";
import path from "node:path";

/**
 * citation-service — 本地文献引文提取（轨道2：本地原文提取）
 *
 * 从 original.md 全文提取参考文献块（GB/T 7714 格式），解析为结构化条目。
 * 来源：知网/期刊论文原文文末「参考文献」块。
 * 后续：知网 CDP 抓取（轨道1）结果可合并进同一存储。
 */

export interface CitationEntry {
  raw: string;          // 原始行
  authors?: string;     // 作者
  title?: string;       // 标题
  source?: string;      // 期刊/出版社
  year?: string;        // 年份
  type?: string;        // [J]期刊 [M]专著 [D]学位 [C]会议 [N]报纸 [R]报告 [EB/OL]网络
}

export interface CitationBlock {
  paperId: string;
  paperTitle: string;
  count: number;
  entries: CitationEntry[];
  extractedAt: string;
}

const CITATION_HEADERS = [
  "参考文献", "参考文献：", "参考文献:", "References", "REFERENCES", "参考⽂献"
];

/** 识别一行是否是参考文献条目（GB/T 7714 特征，兼容全角/半角括号） */
function looksLikeCitation(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // 带序号开头：[1] ［1］ 1. 1、 1．
  if (/^[\[［]\s*\d+\s*[\]］]/.test(trimmed)) return true;
  // 空方括号开头（PDF 转换丢失序号）：［ ］ ［］
  if (/^[\[［]\s*[\]］]/.test(trimmed)) return true;
  if (/^\d+\s*[.、．]/.test(trimmed)) return true;
  // 含文献类型标志 [J] [M] [D] [C] [N] [R]（半角/全角）
  if (/[\[［][JMDCNRjmdcnr][\]］]|\[EB\/OL\]/.test(trimmed)) return true;
  return false;
}

/** 解析一条 GB/T 7714 引文为结构化字段 */
function parseCitation(line: string): CitationEntry {
  const raw = line.trim();
  const entry: CitationEntry = { raw };

  // 去掉序号前缀（半角/全角）
  let text = raw
    .replace(/^[\[［]\s*\d*\s*[\]］]\s*/, "")
    .replace(/^\d+\s*[.、．]\s*/, "");

  // 类型标志（半角/全角）
  const typeMatch = text.match(/[\[［]([JMDCNR])[\]］]/) || text.match(/\[(EB\/OL)\]/);
  if (typeMatch) entry.type = typeMatch[1];

  // 年份（4 位数字）
  const yearMatch = text.match(/(19|20)\d{2}/);
  if (yearMatch) entry.year = yearMatch[0];

  // 作者：开头的人名（中/英，含 [美][英] 等前缀）
  const authorMatch = text.match(/^(\[[^\]\d]+\])?\s*([^.,，。:：]+?)(?:[.,，。]\s*|$)/);
  if (authorMatch && authorMatch[2] && authorMatch[2].length < 40) {
    entry.authors = authorMatch[2].trim();
  }

  // 标题：从第一个 . 或 ，后到 [J]/[M] 前的部分（近似）
  const afterAuthor = text.replace(/^(\[[^\]\d]+\])?\s*[^.,，。:：]+?[.,，。]\s*/, "");
  const titleMatch = afterAuthor.match(/^(.+?)(?:[\[［][JMDCNR][\]］]|\[EB\/OL\]|\.\s*|$)/);
  if (titleMatch && titleMatch[1] && titleMatch[1].trim().length > 1) {
    entry.title = titleMatch[1].trim();
  }

  // 来源：类型标志后的部分（期刊名/出版社）
  if (entry.type) {
    const srcMatch = text.match(/[\[［][JMDCNR][\]］]\s*([^.,，。]+?)(?:\.|，|$)/);
    if (srcMatch && srcMatch[1].trim()) entry.source = srcMatch[1].trim();
  }

  return entry;
}

/** 从 original.md 内容提取参考文献块 */
export function extractCitationsFromText(content: string, paperId: string, paperTitle: string): CitationBlock | null {
  const lines = content.split("\n");
  let inBlock = false;
  let block: string[] = [];
  let headerLine = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    // 检测参考文献标题行（支持 "## 参考文献" Markdown 标题、纯文本、英文）
    if (!inBlock && CITATION_HEADERS.some((h) => line.replace(/^#+\s*/, "").startsWith(h))) {
      inBlock = true;
      headerLine = i;
      continue;
    }
    if (inBlock) {
      if (line === "") {
        // 空行：继续（条目间空行常见，后续仍有引文则继续收集）
        continue;
      }
      if (looksLikeCitation(line)) {
        block.push(line);
      } else if (block.length > 0) {
        // 续行判断：页码/年份/出版社等结尾（PDF 换行拆分），并入上一条
        if (/^(19|20)\d{2}|^\d+[（(]\d+[）)]|^[A-Za-z]+[:：]/.test(line.trim())) {
          block[block.length - 1] += " " + line.trim();
          continue;
        }
        // 真正的非引文行 → 结束
        break;
      }
    }
  }

  if (headerLine === -1 || block.length === 0) {
    return null;
  }

  const entries = block.map(parseCitation);
  return {
    paperId,
    paperTitle,
    count: entries.length,
    entries,
    extractedAt: new Date().toISOString()
  };
}

/** 从文献记录读取 original.md 并提取引文 */
export function extractCitationsForPaper(paperDir: string, paperId: string, paperTitle: string): CitationBlock | null {
  try {
    if (!fs.existsSync(paperDir)) return null;
    const files = fs.readdirSync(paperDir).filter((f) => f.endsWith(".original.md"));
    if (files.length === 0) return null;
    const content = fs.readFileSync(path.join(paperDir, files[0]), "utf-8");
    // 去 frontmatter
    let body = content;
    const fmEnd = content.indexOf("---", 3);
    if (content.startsWith("---") && fmEnd > 0) {
      body = content.slice(fmEnd + 3);
    }
    return extractCitationsFromText(body, paperId, paperTitle);
  } catch {
    return null;
  }
}

export const citationService = {
  extractFromText: extractCitationsFromText,
  extractForPaper: extractCitationsForPaper
};
