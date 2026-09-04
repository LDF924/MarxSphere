// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// format-eval-engine.ts — 论文格式评测: 纯代码规则引擎(2026-09-03)
// 零 LLM 依赖的确定性检测: 标题层级/摘要/关键词/章节结构/引文标注/
// 参考文献/图表编号/文本规范。每条规则产出统一 FormatIssue(行定位)。
//
// 行级语义: 用户粘贴的稿件(Word 复制/markdown/PDF 文本)行与段落边界
// 往往只有换行而无空行, 段落级切分会把「摘要/关键词/标题」等行锚结构
// 吞并进正文。故本引擎以"每个非空行为一个评测单元", 摘要等跨行结构
// 按行锚累计。paragraph 字段即行号(对 md/粘贴稿更直观)。

import type { FormatTemplate } from "./format-eval-templates.js";

export type IssueSeverity = "error" | "warning" | "info";

export interface FormatIssue {
  ruleId: string;
  category:
    | "标题层级"
    | "摘要"
    | "关键词"
    | "章节结构"
    | "引文标注"
    | "参考文献"
    | "图表编号"
    | "文本规范"
    | "Word样式";
  severity: IssueSeverity;
  message: string;
  paragraph: number; // 行号(1 起)
  snippet: string; // 违规片段(截 ~80 字)
  suggestion: string;
}

/** 规则状态: pass=通过(未触发任何违规), error/warning/info=触发问题 */
export type RuleStatus = "pass" | IssueSeverity;

/** 规则清单条目(供前端全量展示, 含未触发的通过项) */
export interface RuleStatusEntry extends RuleCatalogItem {
  status: RuleStatus;  // pass | error | warning | info
  message?: string;    // 违规时的问题描述
  suggestion?: string;
}

/** 规则登记表(单一真源): 引擎全部检查项 + 说明(供前端卡片展示) */
export interface RuleCatalogItem {
  ruleId: string;
  category: FormatIssue["category"];
  name: string;
  /** 这条规则检测什么(一句话) */
  desc: string;
  /** 怎么检测/怎么得出违规结论(可读逻辑步骤) */
  logic: string;
}

export const RULE_CATALOG: RuleCatalogItem[] = [
  { ruleId: "heading-pattern-mismatch", category: "标题层级", name: "标题编号体系一致性",
    desc: "检测标题编号体系是否与所选模板一致(第X章 vs 一、 式)",
    logic: "逐行提取标题 → 比对模板 headingPattern(章节号样式) → 若标题用「一、」而模板要求「第X章/x.x」则判违规" },
  { ruleId: "heading-jump", category: "标题层级", name: "标题层级跳变",
    desc: "检测标题是否跳过中间层级(如从一级直接到三级)",
    logic: "解析标题层级序列 → 相邻两级差≥2 且中间层从未出现 → 判跳级" },
  { ruleId: "heading-no-content", category: "标题层级", name: "相邻标题内容检查",
    desc: "检测两个同级标题相邻(中间无正文)",
    logic: "相邻标题行号差=1 → 无正文行夹在中间 → 提示核查" },
  { ruleId: "abstract-missing", category: "摘要", name: "摘要存在性",
    desc: "检测是否缺少「摘要」段落",
    logic: "全文搜「摘要」锚行 → 无 → 判缺少; 有 → 进入字数检查" },
  { ruleId: "abstract-too-short", category: "摘要", name: "摘要字数下限",
    desc: "检测摘要字数是否低于模板下限(默认 200 字)",
    logic: "摘要锚行起累计正文到下一结构锚 → 中文字数计数 → <下限 → 违规" },
  { ruleId: "abstract-too-long", category: "摘要", name: "摘要字数上限",
    desc: "检测摘要字数是否超过模板上限(默认 400 字)",
    logic: "同上累计字数 → >上限 → 提示精简" },
  { ruleId: "keywords-missing", category: "关键词", name: "关键词存在性",
    desc: "检测是否缺少「关键词:」行",
    logic: "搜「关键词[:：]」行 → 无 → 判缺少" },
  { ruleId: "keywords-count", category: "关键词", name: "关键词数量",
    desc: "检测关键词个数是否在模板要求范围(默认 3-5 个)",
    logic: "按分隔符切分关键词行 → 计数 → 少于下限或超上限 → 违规" },
  { ruleId: "keywords-separator", category: "关键词", name: "关键词分隔符",
    desc: "检测关键词分隔符是否为模板要求的「；」",
    logic: "提取分隔符集合 → 与模板 separator 比对 → 混用/不符 → 提示" },
  { ruleId: "section-missing", category: "章节结构", name: "必备章节齐全",
    desc: "检测模板必备章节(摘要/目录/引言/结论/参考文献等)是否齐全",
    logic: "对每个必备章节 → 标题列表或全文匹配章节别名 → 缺失的收集后判违规" },
  { ruleId: "section-duplicate", category: "章节结构", name: "重复标题检查",
    desc: "检测是否存在重复章节标题",
    logic: "标题归一化(去空格小写)后查重 → 同 key 出现两次 → 提示核对" },
  { ruleId: "citation-none", category: "引文标注", name: "引文标注存在性",
    desc: "检测正文是否完全无引文标注",
    logic: "正文(不含参考文献段)提取 [n] 或 (作者, 年份) → 两者皆无 → 提示补充" },
  { ruleId: "citation-style-mismatch", category: "引文标注", name: "引文体系一致性",
    desc: "检测引文标注是否与模板指定体系一致(顺序编码 vs 著者-年)",
    logic: "统计两类标注 → 模板 numeric 但只发现 author-year → 判体系不符" },
  { ruleId: "citation-style-mixed", category: "引文标注", name: "引文体系混用",
    desc: "检测正文是否同时混用两种引文体系",
    logic: "[n] 与 (作者年份) 数量均>0 → 判混用" },
  { ruleId: "references-missing", category: "参考文献", name: "参考文献章节存在",
    desc: "检测是否缺少「参考文献」章节",
    logic: "搜「参考文献/REFERENCES」标题 → 无 → 判缺少" },
  { ruleId: "references-empty", category: "参考文献", name: "参考文献著录条数",
    desc: "检测参考文献标题后是否有 [1][2]… 著录条目",
    logic: "参考文献标题后扫描 [n] 开头的行 → 0 条 → 判空" },
  { ruleId: "reference-numbering-gap", category: "参考文献", name: "参考文献序号连续",
    desc: "检测参考文献序号是否从 [1] 连续递增",
    logic: "逐条取 [n] → 与位置(第 i 条应为 [i])比对 → 不符 → 违规" },
  { ruleId: "reference-out-of-range", category: "参考文献", name: "正文引用范围",
    desc: "检测正文引用的编号是否超出参考文献最大编号",
    logic: "正文 [n] 提取 → n > 文献最大编号 → 违规(引用悬空)" },
  { ruleId: "figure-numbering-gap", category: "图表编号", name: "图编号连续",
    desc: "检测图题编号是否连续(图1 图2… 或 图1.1 图1.2…)",
    logic: "全篇匹配 图\\d+(\\.\\d+)? → 相邻编号跳跃 → 判不连续" },
  { ruleId: "table-numbering-gap", category: "图表编号", name: "表编号连续",
    desc: "检测表题编号是否连续",
    logic: "全篇匹配 表\\d+(\\.\\d+)? → 相邻编号跳跃 → 判不连续" },
  { ruleId: "text-garbage", category: "文本规范", name: "乱码/控制字符",
    desc: "检测文本是否含乱码或控制字符(疑似提取损坏)",
    logic: "统计每行乱码字符(U+FFFD 等) → >3 个 → 判损坏" },
  { ruleId: "text-overlong-para", category: "文本规范", name: "超长无标点段落",
    desc: "检测超长且无句末标点的段落(疑似 PDF 换行丢失)",
    logic: "行 >500 中文字且无。！？ → 提示断句分段" },
  { ruleId: "text-empty", category: "文本规范", name: "文本非空",
    desc: "检测评测文本是否为空",
    logic: "输入 trim 后为空 → 判空无法评测" },
];

/** docx 路径专用: 合并 style+text findings → 规则清单 + 真实统计(与 runFormatEval 同评分口径) */
export function summarizeForDocx(findings: FormatIssue[]): {
  ruleStatuses: RuleStatusEntry[];
  score: number;
  stats: { passed: number; errors: number; warnings: number; infos: number; byCategory: Record<string, number> };
} {
  const ruleStatuses = summarizeRules(findings);
  const byCategory: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  let passed = 0;
  for (const s of ruleStatuses) {
    if (s.status === "pass") { passed += 1; continue; }
    byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
    if (s.status === "error") errors += 1;
    else if (s.status === "warning") warnings += 1;
    else infos += 1;
  }
  const score = Math.max(0, Math.min(100, Math.round((100 - errors * 5 - warnings * 2 - infos * 0.5) * 10) / 10));
  return { ruleStatuses, score, stats: { passed, errors, warnings, infos, byCategory } };
}

/** 汇总规则状态: 基于 catalog 全部条目 + 引擎触发的 findings 合并出完整清单 */
export function summarizeRules(findings: FormatIssue[]): RuleStatusEntry[] {
  const byId = new Map<string, FormatIssue[]>();
  for (const f of findings) {
    const list = byId.get(f.ruleId) ?? [];
    list.push(f);
    byId.set(f.ruleId, list);
  }
  const worst = (list: FormatIssue[]): RuleStatus => {
    if (list.some((f) => f.severity === "error")) return "error";
    if (list.some((f) => f.severity === "warning")) return "warning";
    return "info";
  };
  return RULE_CATALOG.map((r) => {
    const hits = byId.get(r.ruleId);
    if (!hits) return { ...r, status: "pass" as const };
    return {
      ...r,
      status: worst(hits),
      message: hits[0]?.message,
      suggestion: hits[0]?.suggestion,
    };
  });
}

export interface HeadingLine {
  text: string; // 去编号后的标题文本
  level: number; // 章级=0, 节级=1, 小节级=2 …
  raw: string;
  paragraph: number; // 行号(1 起)
  explicitChapter: boolean;
}

/** 行切分: 每个非空行为一个评测单元 */
export function splitLines(text: string): Array<{ text: string; line: number }> {
  return text.split("\n")
    .map((l, i) => ({ text: l.trim(), line: i + 1 }))
    .filter((l) => l.text.length > 0);
}

/** 段落切分(兼容旧语义): 空行分组; 无空行时退化为行级 */
export function splitParagraphs(text: string): Array<{ text: string; paragraph: number }> {
  if (!/\n\s*\n/.test(text)) {
    return splitLines(text).map((l) => ({ text: l.text, paragraph: l.line }));
  }
  return text.split(/\n\s*\n+/)
    .map((p, i) => ({ text: p.trim(), paragraph: i + 1 }))
    .filter((p) => p.text.length > 0);
}

/** 中文字数(粗略: 常用 CJK 区按 1 计, 含标点) */
export function chineseLength(s: string): number {
  return (s.match(/[⺀-鿿　-〿豈-﫿]/g) ?? []).length;
}

const CN_NUM = "一二三四五六七八九十百千";
const CHAPTER_RE = /^第([一二三四五六七八九十百]+|\d+)章\s*(.*)$/;
const CN_SEQ_RE = /^([一二三四五六七八九十]+)、(.*)$/;
const CN_PAREN_RE = /^（([一二三四五六七八九十]+)）(.*)$/;
const NUM_DOT_RE = /^(\d+)[\.．]\s*(.+)$/;
const NUM_PAREN_RE = /^\((\d+)\)\s*(.+)$/;
const XDOT_RE = /^(\d+(?:\.\d+)+)[\.．]?\s*(.*)$/;

// 行锚结构标记: 新起一行的结构(标题/摘要/关键词/参考文献/致谢等)
const STRUCT_ANCHOR =
  /^(第[一二三四五六七八九十百]+章|[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）|\((\d+)\)|(\d+)[\.．](\s|$)|(\d+(?:\.\d+)+)[\.．]?\s|摘\s*要|关键词|Abstract|Keywords|参\s*考\s*文\s*献|致\s*谢|目\s*录|图\s*\d|表\s*\d)/;

/** 是否行锚结构: 若该行是"上一段的延续内容"则 false */
function isStructStart(text: string): boolean {
  if (STRUCT_ANCHOR.test(text)) return true;
  // 参考文献条目
  if (/^\[\d+\]/.test(text)) return true;
  // 英文标题(短行 + 无句末标点)启发式: 不在此判定, 交给 extractHeadings
  return false;
}

/** 智能分块: 以空行为硬分隔; 无空行时按行锚把粘连块切开 */
export function smartSegments(text: string): Array<{ text: string; line: number }> {
  const lines = text.split("\n").map((l, i) => ({ text: l.trim(), line: i + 1 }));
  const segs: Array<{ text: string; line: number }> = [];
  let buf: string[] = [];
  let bufStart = 0;
  let prevBlank = true;

  const flush = () => {
    if (buf.length > 0) {
      segs.push({ text: buf.join("\n"), line: bufStart });
      buf = [];
    }
  };

  for (const l of lines) {
    if (l.text.length === 0) { flush(); prevBlank = true; continue; }
    const struct = !prevBlank && isStructStart(l.text);
    if (struct) flush();
    if (buf.length === 0) bufStart = l.line;
    buf.push(l.text);
    prevBlank = false;
  }
  flush();
  return segs;
}

/** 提取标题行(行级) */
export function extractHeadings(
  lines: Array<{ text: string; line: number }>,
  pattern: FormatTemplate["headingPattern"],
): HeadingLine[] {
  const out: HeadingLine[] = [];
  for (const { text, line } of lines) {
    const oneLine = text.replace(/\n/g, " ").trim();
    if (oneLine.length > 60) continue;
    if (/^\[\d+\]/.test(oneLine)) continue;

    let hit: { level: number; title: string; explicitChapter: boolean } | null = null;

    if (pattern === "chapter-x.x") {
      const ch = oneLine.match(CHAPTER_RE);
      if (ch) {
        hit = { level: 0, title: ch[2].trim() || ch[0], explicitChapter: true };
      } else {
        const m = oneLine.match(XDOT_RE);
        if (m && m[2].trim().length > 0 && m[1].length <= 12) {
          // 章级=0: 第1章; 节级=1: 1.1; 小节级=2: 1.1.1 → level = 点组分-1
          const depth = m[1].split(".").length;
          hit = { level: depth - 1, title: m[2].trim(), explicitChapter: false };
        } else {
          // "1 引言"(省略"第X章"的章级写法) 视为章级 0
          const m1 = oneLine.match(/^(\d+)\s+(.+)$/);
          if (m1 && !/^\d{4}$/.test(m1[1]) && m1[2].trim().length > 0 && !/^[\d.%-]+$/.test(m1[2].trim())) {
            hit = { level: 0, title: m1[2].trim(), explicitChapter: false };
          }
        }
      }
    } else {
      // cn-seq: 一、→0 (一)→1 1.→2 (1)→3; 但"第X章"也要识别(供 pattern-mismatch 检测)
      const chForeign = oneLine.match(CHAPTER_RE);
      if (chForeign) {
        hit = { level: 0, title: chForeign[2].trim() || chForeign[0], explicitChapter: true };
      } else {
        const seq = oneLine.match(CN_SEQ_RE);
        if (seq && CN_NUM.includes(seq[1][0])) {
          hit = { level: 0, title: seq[2].trim(), explicitChapter: true };
        } else {
          const paren = oneLine.match(CN_PAREN_RE);
          if (paren && CN_NUM.includes(paren[1][0])) {
            hit = { level: 1, title: paren[2].trim(), explicitChapter: false };
          } else {
            const dot = oneLine.match(NUM_DOT_RE);
            if (dot && !/^\d{4}$/.test(dot[1]) && dot[2].trim().length > 0) {
              hit = { level: 2, title: dot[2].trim(), explicitChapter: false };
            } else {
              const parenNum = oneLine.match(NUM_PAREN_RE);
              if (parenNum) {
                hit = { level: 3, title: parenNum[2].trim(), explicitChapter: false };
              }
            }
          }
        }
      }
    }

    if (hit && hit.title.length > 0) {
      const t = hit.title.replace(/[。．.!！?？;；:：,，、]$/g, "").trim();
      // 标题长度 < 50、不以括号/句末标点开头结尾、不含中英文句号才算标题
      if (t.length > 0 && t.length <= 50 && !/^[（(]/.test(t)) {
        out.push({ text: t, level: hit.level, raw: oneLine, paragraph: line, explicitChapter: hit.explicitChapter });
      }
    }
  }
  return out;
}

// ─── 工具 ───
function clip(s: string, n = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

// ─── 规则实现(全部行级) ───

function ruleHeading(lines: Array<{ text: string; line: number }>, tpl: FormatTemplate): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const headings = extractHeadings(lines, tpl.headingPattern);

  // 1) 模板 pattern 不符
  for (const h of headings) {
    if (tpl.headingPattern === "cn-seq" && /^第(?:[一二三四五六七八九十百]+|\d+)章/.test(h.raw)) {
      issues.push({
        ruleId: "heading-pattern-mismatch", category: "标题层级", severity: "error",
        message: `模板使用「一、(一)1.」编号体系, 但标题「${clip(h.raw)}」用了「第X章」章节号`,
        paragraph: h.paragraph, snippet: clip(h.raw),
        suggestion: "将「第X章」改为「一、二、三…」式编号",
      });
    }
    if (tpl.headingPattern === "chapter-x.x" && /^[一二三四五六七八九十]+、/.test(h.raw)) {
      issues.push({
        ruleId: "heading-pattern-mismatch", category: "标题层级", severity: "error",
        message: `模板使用「第X章 → x.x」编号体系, 但标题「${clip(h.raw)}」用了「一、」式编号`,
        paragraph: h.paragraph, snippet: clip(h.raw),
        suggestion: "将「一、」改为「第X章」并启用节号",
      });
    }
  }

  // 2) 层级跳变
  const seq: Array<{ level: number; paragraph: number; raw: string }> = headings.map((h) => ({
    level: h.explicitChapter ? 0 : h.level,
    paragraph: h.paragraph,
    raw: h.raw,
  }));
  const seenLevels = new Set(seq.map((x) => x.level));
  for (let i = 1; i < seq.length; i += 1) {
    const prev = seq[i - 1];
    const cur = seq[i];
    if (cur.level > prev.level && cur.level - prev.level >= 2) {
      const missing = prev.level + 1;
      if (!seenLevels.has(missing) && missing <= 3) {
        issues.push({
          ruleId: "heading-jump", category: "标题层级", severity: "error",
          message: `标题层级跳变: 从第 ${prev.level + 1} 级直接跳到第 ${cur.level + 1} 级「${clip(cur.raw)}」, 缺少中间第 ${missing + 1} 级`,
          paragraph: cur.paragraph, snippet: clip(cur.raw),
          suggestion: `补出第 ${missing + 1} 级小标题或在正文分段说明`,
        });
      }
    }
  }

  // 3) 相邻标题(行相邻且无正文行) → info
  for (let i = 0; i < seq.length - 1; i += 1) {
    const a = seq[i];
    const b = seq[i + 1];
    if (a.level === b.level && a.paragraph + 1 === b.paragraph) {
      issues.push({
        ruleId: "heading-no-content", category: "标题层级", severity: "info",
        message: `相邻标题「${clip(a.raw)}」与「${clip(b.raw)}」之间无正文行`,
        paragraph: b.paragraph, snippet: clip(a.raw) + " … " + clip(b.raw),
        suggestion: "确认两标题间确有内容; 若为并列分节可忽略",
      });
    }
  }
  return issues;
}

/** 摘要体: 从摘要锚行起, 累计其后不属于新结构锚的连续行 */
function collectAbstract(lines: Array<{ text: string; line: number }>): { body: string; startLine: number } | null {
  const idx = lines.findIndex((l) => /^(摘\s*要|【摘要】)/.test(l.text));
  if (idx < 0) return null;
  const first = lines[idx];
  let body = first.text.replace(/^摘\s*要[:：]?\s*/, "");
  let line = first.line;
  for (let i = idx + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^(关键词|Abstract|Keywords|目\s*录|第[一二三四五六七八九十百]+章|[一二三四五六七八九十]+、|参\s*考\s*文\s*献)/.test(l.text)) break;
    if (/^[（(]?\s*(\d+|[一二三四五六七八九十]+)[）)、.．]/.test(l.text) && chineseLength(l.text) < 60) break; // 疑似新标题
    body += l.text;
  }
  void line;
  return { body, startLine: first.line };
}

function ruleAbstract(lines: Array<{ text: string; line: number }>, tpl: FormatTemplate): FormatIssue[] {
  if (!tpl.abstract.required) return [];
  const issues: FormatIssue[] = [];
  const abs = collectAbstract(lines);
  if (!abs) {
    issues.push({
      ruleId: "abstract-missing", category: "摘要", severity: "error",
      message: `缺少「摘要」段落(模板要求 ${tpl.abstract.min}-${tpl.abstract.max} 字)`,
      paragraph: 0, snippet: "",
      suggestion: "在论文开头补写摘要, 概括研究目的/方法/结果/结论",
    });
    return issues;
  }
  const len = chineseLength(abs.body);
  if (len < tpl.abstract.min) {
    issues.push({
      ruleId: "abstract-too-short", category: "摘要", severity: "error",
      message: `摘要约 ${len} 字, 低于模板要求下限 ${tpl.abstract.min} 字`,
      paragraph: abs.startLine, snippet: clip(abs.body),
      suggestion: `扩充摘要至 ${tpl.abstract.min}-${tpl.abstract.max} 字, 涵盖目的/方法/结果/结论`,
    });
  }
  if (tpl.abstract.max > 0 && len > tpl.abstract.max) {
    issues.push({
      ruleId: "abstract-too-long", category: "摘要", severity: "warning",
      message: `摘要约 ${len} 字, 超过模板要求上限 ${tpl.abstract.max} 字`,
      paragraph: abs.startLine, snippet: clip(abs.body),
      suggestion: `精简摘要至 ${tpl.abstract.min}-${tpl.abstract.max} 字`,
    });
  }
  return issues;
}

function ruleKeywords(lines: Array<{ text: string; line: number }>, tpl: FormatTemplate): FormatIssue[] {
  if (!tpl.keywords.required) return [];
  const issues: FormatIssue[] = [];
  const kw = lines.find((l) => /^(关键词|关\s*键\s*词)\s*[:：]/.test(l.text));
  if (!kw) {
    issues.push({
      ruleId: "keywords-missing", category: "关键词", severity: "error",
      message: `缺少「关键词」行(模板要求 ${tpl.keywords.min}-${tpl.keywords.max} 个)`,
      paragraph: 0, snippet: "",
      suggestion: "在摘要后添加「关键词: 甲; 乙; 丙」",
    });
    return issues;
  }
  const body = kw.text.replace(/^(关键词|关\s*键\s*词)\s*[:：]?\s*/, "").trim();
  const items = body.split(/[；;，,]/).map((s) => s.trim()).filter(Boolean);
  if (items.length < tpl.keywords.min) {
    issues.push({
      ruleId: "keywords-count", category: "关键词", severity: "error",
      message: `关键词仅 ${items.length} 个, 低于模板要求 ${tpl.keywords.min}-${tpl.keywords.max} 个`,
      paragraph: kw.line, snippet: clip(body),
      suggestion: `补充至 ${tpl.keywords.min}-${tpl.keywords.max} 个`,
    });
  }
  if (items.length > tpl.keywords.max) {
    issues.push({
      ruleId: "keywords-count", category: "关键词", severity: "warning",
      message: `关键词 ${items.length} 个, 超过模板要求 ${tpl.keywords.max} 个`,
      paragraph: kw.line, snippet: clip(body),
      suggestion: `精简至 ${tpl.keywords.max} 个以内`,
    });
  }
  const seps = body.match(/[；;，,]/g) ?? [];
  const sepKinds = new Set(seps);
  if (sepKinds.size >= 2) {
    issues.push({
      ruleId: "keywords-separator", category: "关键词", severity: "warning",
      message: `关键词分隔符混用(${[...sepKinds].join(" ")} 并存), 应统一为「${tpl.keywords.separator}」`,
      paragraph: kw.line, snippet: clip(body),
      suggestion: `统一使用模板要求的分隔符「${tpl.keywords.separator}」`,
    });
  } else if (sepKinds.size === 1 && !sepKinds.has(tpl.keywords.separator)) {
    issues.push({
      ruleId: "keywords-separator", category: "关键词", severity: "info",
      message: `关键词分隔符使用了「${[...sepKinds][0]}」, 模板要求「${tpl.keywords.separator}」`,
      paragraph: kw.line, snippet: clip(body),
      suggestion: `改用模板要求的分隔符「${tpl.keywords.separator}」`,
    });
  }
  return issues;
}

function ruleSections(lines: Array<{ text: string; line: number }>, tpl: FormatTemplate): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const allText = lines.map((l) => l.text).join("\n");
  const headings = extractHeadings(lines, tpl.headingPattern);
  const headingTexts = headings.map((h) => h.text.replace(/\s+/g, ""));
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

  const missing: string[] = [];
  for (const sec of tpl.requiredSections) {
    if (sec === "摘要") {
      if (!lines.some((l) => /^摘\s*要/.test(l.text))) missing.push(sec);
    } else if (/^abstract$/i.test(sec)) {
      if (!/\bAbstract\b/i.test(allText)) missing.push(sec);
    } else if (sec === "目录") {
      if (!/(^|\n)\s*(目\s*录|CONTENTS?)/i.test(allText)) missing.push(sec);
    } else if (sec === "参考文献") {
      if (!/(^|\n)\s*参\s*考\s*文\s*献/.test(allText)) missing.push(sec);
    } else if (sec === "致谢") {
      if (!/(^|\n)\s*致\s*谢/.test(allText)) missing.push(sec);
    } else if (sec === "攻读学位期间的研究成果") {
      if (!allText.includes("研究成果") && !allText.includes("攻读学位期间")) missing.push(sec);
    } else {
      const aliases = (tpl.sectionAliases?.[sec] ?? []).map(norm);
      const target = norm(sec);
      const found = headingTexts.some((t) => aliases.includes(norm(t)) || t.includes(target) || target.includes(t));
      if (!found && !aliases.some((a) => allText.toLowerCase().includes(a))) missing.push(sec);
    }
  }
  if (missing.length > 0) {
    issues.push({
      ruleId: "section-missing", category: "章节结构", severity: "error",
      message: `缺少模板要求的章节: ${missing.join("、")}`,
      paragraph: 0, snippet: "",
      suggestion: "补齐缺失章节(部分学校允许合并时, 可在模板别名中登记变体)",
    });
  }

  const seen = new Map<string, number>();
  for (const h of headings) {
    const key = norm(h.text);
    if (key.length < 2) continue;
    if (seen.has(key)) {
      issues.push({
        ruleId: "section-duplicate", category: "章节结构", severity: "info",
        message: `标题「${clip(h.raw)}」与第 ${seen.get(key)} 行标题重复, 请核对是否为误排`,
        paragraph: h.paragraph, snippet: clip(h.raw),
        suggestion: "删除重复标题或改为分节编号",
      });
    } else {
      seen.set(key, h.paragraph);
    }
  }
  return issues;
}

function ruleCitations(lines: Array<{ text: string; line: number }>, tpl: FormatTemplate): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const bodyLines = lines.filter((l) => !/^参\s*考\s*文\s*献/.test(l.text));
  const bodyText = bodyLines.map((l) => l.text).join("\n");
  const numericMarks = bodyText.match(/\[(\d+(?:[-,]\d+)*)\]/g) ?? [];
  const authorYearMarks = bodyText.match(/[（(][^（）()]{1,60}(?:19|20)\d{2}[a-z]?[）)]/g) ?? [];

  if (tpl.citationStyle === "numeric") {
    if (numericMarks.length === 0 && authorYearMarks.length === 0) {
      issues.push({
        ruleId: "citation-none", category: "引文标注", severity: "info",
        message: "正文未发现任何引文标注(模板要求 GB/T 7714 顺序编码 [1] 式)",
        paragraph: 0, snippet: "",
        suggestion: "在引用处标注 [1]、[2] 等序号, 与文末参考文献对应",
      });
    } else if (numericMarks.length === 0 && authorYearMarks.length > 0) {
      issues.push({
        ruleId: "citation-style-mismatch", category: "引文标注", severity: "error",
        message: `模板使用顺序编码制([1] 式), 但正文仅发现著者-出版年式标注 ${authorYearMarks.length} 处`,
        paragraph: 0, snippet: clip(authorYearMarks[0] ?? ""),
        suggestion: "将（作者, 年份）标注改写为 [序号] 编码制",
      });
    }
  } else {
    if (authorYearMarks.length === 0 && numericMarks.length === 0) {
      issues.push({
        ruleId: "citation-none", category: "引文标注", severity: "info",
        message: "正文未发现任何引文标注(模板要求著者-出版年式)",
        paragraph: 0, snippet: "",
        suggestion: "在引用处标注（作者, 年份）",
      });
    } else if (authorYearMarks.length === 0 && numericMarks.length > 0) {
      issues.push({
        ruleId: "citation-style-mismatch", category: "引文标注", severity: "error",
        message: `模板使用著者-出版年制, 但正文使用了 [n] 顺序编码 ${numericMarks.length} 处`,
        paragraph: 0, snippet: clip(numericMarks[0] ?? ""),
        suggestion: "将 [n] 编码改写为（作者, 年份）标注",
      });
    }
  }

  if (numericMarks.length > 0 && authorYearMarks.length > 0) {
    issues.push({
      ruleId: "citation-style-mixed", category: "引文标注", severity: "warning",
      message: `正文同时出现 [n] 编码 ${numericMarks.length} 处与（作者, 年份）标注 ${authorYearMarks.length} 处, 疑似两种体系混用`,
      paragraph: 0, snippet: clip(numericMarks[0] ?? "") + " … " + clip(authorYearMarks[0] ?? ""),
      suggestion: "全篇统一为单一引文体系",
    });
  }
  return issues;
}

function ruleReferences(lines: Array<{ text: string; line: number }>, tpl: FormatTemplate): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const refIdx = lines.findIndex((l) => /^参\s*考\s*文\s*献/.test(l.text) || /^REFERENCES?\s*$/i.test(l.text));

  if (!tpl.referencesRequired) return issues;
  if (refIdx < 0) {
    issues.push({
      ruleId: "references-missing", category: "参考文献", severity: "error",
      message: "缺少「参考文献」章节",
      paragraph: 0, snippet: "",
      suggestion: "文末添加参考文献章节, 按 GB/T 7714 著录",
    });
    return issues;
  }

  const refLines: Array<{ num: number; text: string }> = [];
  let inBlock = false;
  for (const l of lines.slice(refIdx + 1)) {
    if (/^(致\s*谢|附\s*录|攻读学位|作者简介)/.test(l.text)) break;
    if (/^\[\d+\]/.test(l.text)) {
      inBlock = true;
      const m = l.text.match(/^\[(\d+)\]\s*(.*)$/s);
      if (m) refLines.push({ num: Number(m[1]), text: m[2] });
    } else if (inBlock && /^\S+[.．]/.test(l.text) && /(19|20)\d{2}/.test(l.text)) {
      const last = refLines[refLines.length - 1];
      if (last) last.text += " " + l.text; // 折行续段并入前一条
    }
  }
  if (refLines.length === 0) {
    issues.push({
      ruleId: "references-empty", category: "参考文献", severity: "error",
      message: "「参考文献」标题后未检测到 [1][2]… 形式的著录条目",
      paragraph: 0, snippet: "",
      suggestion: "按 GB/T 7714 顺序编码逐条著录文献",
    });
    return issues;
  }

  for (let i = 0; i < refLines.length; i += 1) {
    const got = refLines[i].num;
    if (got !== i + 1) {
      issues.push({
        ruleId: "reference-numbering-gap", category: "参考文献", severity: "error",
        message: `参考文献序号不连续: 第 ${i + 1} 条应为 [${i + 1}], 实际为 [${got}]`,
        paragraph: refIdx + 1, snippet: clip(refLines[i].text),
        suggestion: `将条目 [${got}] 改编号为 [${i + 1}], 并同步正文引用`,
      });
      break;
    }
  }

  const maxRef = refLines[refLines.length - 1].num;
  const bodyText = lines.slice(0, refIdx).map((l) => l.text).join("\n");
  const cited: number[] = [];
  for (const m of bodyText.matchAll(/\[(\d+(?:-\d+)?)\]/g)) {
    const [a, b] = m[1].split("-").map(Number);
    cited.push(a, b ?? a);
  }
  const overCited = [...new Set(cited.filter((n) => n > maxRef))];
  if (overCited.length > 0) {
    issues.push({
      ruleId: "reference-out-of-range", category: "参考文献", severity: "error",
      message: `正文引用了 [${overCited.join("][")}], 超出参考文献最大编号 [${maxRef}]`,
      paragraph: 0, snippet: "",
      suggestion: "核对引用编号与文献列表一一对应",
    });
  }
  return issues;
}

function ruleFigures(lines: Array<{ text: string; line: number }>, tpl: FormatTemplate): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const check = (kind: "图" | "表", id: string, re: RegExp) => {
    const found: Array<{ n: number; raw: string; line: number }> = [];
    for (const l of lines) {
      for (const m of l.text.matchAll(re)) {
        found.push({ n: Number(m[1]), raw: m[0], line: l.line });
      }
    }
    if (found.length === 0) return;
    for (let i = 1; i < found.length; i += 1) {
      if (found[i].n !== found[i - 1].n + 1 && found[i].n !== found[i - 1].n) {
        issues.push({
          ruleId: id, category: "图表编号", severity: "error",
          message: `${kind}编号不连续: ${found[i - 1].raw} 后出现 ${found[i].raw}`,
          paragraph: found[i].line, snippet: clip(found[i].raw),
          suggestion: `将${kind}题编号改为连续编号, 并同步正文引用`,
        });
        break;
      }
    }
  };
  void tpl.figureCaptionBelow;
  check("图", "figure-numbering-gap", /图\s*(\d+(?:\.\d+)?)/g);
  check("表", "table-numbering-gap", /表\s*(\d+(?:\.\d+)?)/g);
  return issues;
}

function ruleTextNorm(lines: Array<{ text: string; line: number }>): FormatIssue[] {
  const issues: FormatIssue[] = [];
  for (const l of lines) {
    const garbage = (l.text.match(/[� --]/g) ?? []).length;
    if (garbage > 3) {
      issues.push({
        ruleId: "text-garbage", category: "文本规范", severity: "error",
        message: `段落含 ${garbage} 个乱码/控制字符, 疑似文本提取损坏`,
        paragraph: l.line, snippet: clip(l.text),
        suggestion: "检查原文档/转换过程, 修复乱码后重新评测",
      });
      continue;
    }
    if (chineseLength(l.text) > 500 && !/[。！？]/.test(l.text)) {
      issues.push({
        ruleId: "text-overlong-para", category: "文本规范", severity: "info",
        message: `第 ${l.line} 行超过 500 字且无句末标点, 疑似换行丢失`,
        paragraph: l.line, snippet: clip(l.text),
        suggestion: "检查段落是否因 PDF 转换丢行, 人工断句分段",
      });
    }
  }
  return issues;
}

export function runRuleEngine(text: string, tpl: FormatTemplate): FormatIssue[] {
  if (!text || text.trim().length === 0) {
    return [{
      ruleId: "text-empty", category: "文本规范", severity: "error",
      message: "文本为空, 无法评测", paragraph: 0, snippet: "",
      suggestion: "粘贴论文全文或上传 .md/.txt 文件",
    }];
  }
  const linesAll = splitLines(text);
  const lines = linesAll.length > 2000 ? linesAll.slice(0, 2000) : linesAll;

  const issues: FormatIssue[] = [
    ...ruleHeading(lines, tpl),
    ...ruleAbstract(lines, tpl),
    ...ruleKeywords(lines, tpl),
    ...ruleSections(lines, tpl),
    ...ruleCitations(lines, tpl),
    ...ruleReferences(lines, tpl),
    ...ruleFigures(lines, tpl),
    ...ruleTextNorm(lines),
  ];
  if (linesAll.length > 2000) {
    issues.push({
      ruleId: "text-truncated", category: "文本规范", severity: "info",
      message: `文本超过 2000 行, 仅评测前 2000 行(共 ${linesAll.length} 行)`,
      paragraph: 0, snippet: "",
      suggestion: "分段评测或缩短文本",
    });
  }
  return issues;
}
