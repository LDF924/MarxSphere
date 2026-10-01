// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// index.ts — 题录格式注册表 + 按内容自动识别
//
// 由来(2026-10-01): 旧项目 AIToolman 有 9 个 `read_*_file`
//   (WOS/CNKI/PUBMED/SPRINGER/ARXIV/OPENALEX/SEMANTIC_SCHOLAR/QBYQ/OTHER),
//   本项目此前只能通过 API 拉文献。这一批文件把"用户手里的题录文件"这条路补上。
//
// 注册表顺序 = 识别时的**同分优先级**(靠前的先被选中), 大体按"格式特征强弱"排。
export type { LiteratureRecord, FormatParser, FormatId } from "./common.js";
export {
  dedupKey, normalizeTitle, normalizeDoi, normalizeType, parseYear, splitList, finish,
  authorsFrom, keywordsFrom, invertAbstract, FIELD_ALIASES, normalizeKey,
} from "./common.js";

import type { FormatId, FormatParser } from "./common.js";
import { wosParser } from "./wos.js";
import { risParser } from "./ris.js";
import { medlineParser } from "./medline.js";
import { endnoteParser } from "./endnote.js";
import { bibtexParser } from "./bibtex.js";
import { cnkiParser } from "./cnki.js";
import { csvParser } from "./csv.js";
import { springerParser } from "./springer.js";
import { openalexParser } from "./openalex.js";
import { semanticScholarParser } from "./semanticscholar.js";
import { arxivParser } from "./arxiv.js";
import { jsonParser } from "./json.js";
import { otherParser } from "./other.js";

/**
 * 全部解析器。
 *
 * QBYQ(旧项目的第 8 个 `read_QBYQ_file`)**没有单独实现在这里** —— 它是那家产品自己
 * 的题录导出格式, 外面见不到样本; 但它的形状就是 RIS 变体, 由 `ris.ts` 覆盖(含
 * `TY` 无 `ER` 的单条场景)。与其凭想象写一个没人能验证的解析器, 不如说明白。
 */
export const PARSERS: FormatParser[] = [
  wosParser, medlineParser, endnoteParser, bibtexParser, risParser, cnkiParser,
  springerParser, openalexParser, semanticScholarParser, arxivParser,
  csvParser, jsonParser, otherParser,
];

export const FORMAT_IDS: FormatId[] = PARSERS.map((p) => p.id);

export function getParser(id: FormatId): FormatParser | undefined {
  return PARSERS.find((p) => p.id === id);
}

export interface DetectResult {
  id: FormatId;
  label: string;
  score: number;
  /** 所有得分为正的候选(降序) —— 报错/日志里能看到"它像什么" */
  candidates: Array<{ id: FormatId; score: number }>;
}

/**
 * 按内容识别格式。
 *
 * ⚠ `hint`(扩展名)只在**内容线索不足**时起作用, 且只作为并列时的倾向 ——
 *   实测同一个 `.txt` 可能是知网导出也可能是 WOS; 反过来 `.ris` 里装的可能是
 *   EndNote 的 Tagged 文本。内容永远优先。
 */
export function detectFormat(text: string, hint?: string): DetectResult {
  const s = String(text ?? "");
  const scored = PARSERS.map((p) => {
    let score = 0;
    try { score = p.score(s); } catch { score = 0; }   // 解析器自己崩了不能拖垮识别
    return { parser: p, score };
  }).filter((x) => x.score > 0);

  if (scored.length === 0) {
    return { id: "other", label: "通用兜底(按内容嗅探)", score: 0, candidates: [] };
  }
  // 稳定排序: 同分时保持 PARSERS 的注册顺序
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const candidates = scored.map((x) => ({ id: x.parser.id, score: x.score }));

  // 扩展名提示只在**并列**时打破平局, 不改变分高者
  const hinted = hint ? scored.find((x) => x.score === top.score && matchesHint(x.parser.id, hint)) : undefined;
  const winner = hinted ?? top;
  return { id: winner.parser.id, label: winner.parser.label, score: winner.score, candidates };
}

/** 扩展名 → 格式的弱提示 */
function matchesHint(id: FormatId, hint: string): boolean {
  const h = String(hint ?? "").toLowerCase().replace(/^\./, "");
  if (!h) return false;
  if (h === "ris" && id === "ris") return true;
  if ((h === "bib" || h === "bibtex") && id === "bibtex") return true;
  if (h === "enw" && id === "endnote") return true;
  if (h === "nbib" && id === "medline") return true;
  if ((h === "csv" || h === "tsv" || h === "xls" || h === "xlsx") && id === "csv") return true;
  if (h === "json" && (id === "json" || id === "openalex" || id === "semanticscholar" || id === "springer" || id === "arxiv")) return true;
  if (h === "xml" && id === "arxiv") return true;
  return false;
}

/**
 * 解析: 用识别出的格式读。**不抛异常** —— 没有任何解析器认账时返回空数组,
 *   由调用方记成 failed 并带上原文片段。
 */
export function parseWithDetected(text: string, hint?: string): { id: FormatId; records: import("./common.js").LiteratureRecord[]; candidates: Array<{ id: FormatId; score: number }> } {
  const det = detectFormat(text, hint);
  const parser = getParser(det.id);
  let records: import("./common.js").LiteratureRecord[] = [];
  try {
    records = parser ? parser.read(text) : [];
  } catch {
    records = [];
  }
  return { id: det.id, records, candidates: det.candidates };
}
