// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// other.ts — 兜底解析("我不认识这个格式, 但里面确实有题录")
//
// 由来: 旧项目 AIToolman 的 `read_OTHER_file` —— 它被调用 6 次, 是那批 read_* 里
//   最常被用到的, 原因很直白: **用户手里的文件根本不按格式来**。
//
// 这个文件不猜格式, 只做三件"无论如何都成立"的事:
//   ① 逐行/逐段扫, 挑出**看起来像题录**的段落(有年份、有长度、像个标题);
//   ② 从段落里抠出能确定的字段(DOI / arXiv ID / 年份 / 引号内的题名), 其余留空;
//   ③ 抠不到标题的段落直接丢弃 —— 宁可少, 不要造。
//
// ⚠ 它的输出**一定比专用解析器差**(作者/刊名多半为空), 所以 detectFormat 里它的
//   分数是最低的; 只有在没有任何专用解析器认账时才会被选中。
import {
  type FormatParser, type LiteratureRecord, parseYear, normalizeDoi, splitList, finish,
} from "./common.js";

/** 一行/一段里能确定的东西 */
function guessLine(line: string): LiteratureRecord | null {
  const s = line.trim();
  if (s.length < 12 || s.length > 2000) return null;

  // DOI 是题录里最硬的标识 —— 有它就基本能确定这是一条文献
  const doiMatch = /\b(10\.\d{4,9}\/[^\s"',;）)]+)/.exec(s);
  const arxivMatch = /\b(\d{4}\.\d{4,5})(v\d+)?\b/.exec(s);
  const year = parseYear(s);
  const hasQuote = /["“][^"”]{6,}["”]/.test(s);

  // 没有任何文献标识的一行(既无 DOI, 也无年份) → 不是题录
  if (!doiMatch && !arxivMatch && !year) return null;
  // 纯 URL 行 / 纯日期行 / 目录行不算
  if (/^https?:\/\/\S+$/.test(s)) return null;
  if (/^\s*[\d\s.,:/-]+\s*$/.test(s)) return null;

  // 标题: 优先引号内的内容(引用格式里题名常被引号包住), 否则取去掉两侧序号/作者后的中段
  let title = "";
  const q = /["“]([^"”]{6,})["”]/.exec(s);
  if (q) title = q[1];
  else {
    title = s
      .replace(/^\s*\[?\d+\]?[.、)\s]+/, "")                       // 序号
      .replace(/^\s*[A-Z][A-Za-z.'-]+(?:\s+[A-Z]\.?){0,4}\s*[,.]\s*/, "") // 前导西文作者
      .replace(/\bdoi\s*:\s*\S+/gi, "")
      .replace(/\bhttps?:\/\/\S+/g, "")
      .replace(/[.。]\s*$/, "")
      .trim();
  }
  if (!title || title.length < 6) return null;

  const authors = q
    ? splitList(s.slice(0, s.indexOf(q[0])).replace(/^\s*\[?\d+\]?[.、)\s]+/, ""))
    : [];
  return finish({
    title: hasQuote || doiMatch || arxivMatch ? title : title.slice(0, 300),
    authors,
    year,
    doi: doiMatch ? normalizeDoi(doiMatch[1]) : "",
    url: arxivMatch ? `https://arxiv.org/abs/${arxivMatch[1]}` : "",
    source: "other",
  });
}

export function parseOther(input: string): LiteratureRecord[] {
  const src = String(input ?? "");
  if (!src.trim()) return [];
  // 先按空行分段: 题录常常一篇一段; 段内再按行兜底
  const chunks = src.split(/\n\s*\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.length === 0 ? [] : lines;
  });
  const seen = new Set<string>();
  const out: LiteratureRecord[] = [];
  for (const chunk of chunks) {
    const rec = guessLine(chunk);
    if (!rec) continue;
    const key = `${rec.title}|${rec.year ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

export const otherParser: FormatParser = {
  id: "other",
  label: "通用兜底(按内容嗅探)",
  /**
   * 兜底: 只要内容里**确实有**能被认成题录的行就给一个低分, 保证 detectFormat
   * 在无路可走时能选到它, 但绝不会抢过任何认得格式的解析器。
   */
  score(t: string): number {
    const s = String(t ?? "");
    if (!s.trim()) return 0;
    const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 12).slice(0, 50);
    if (lines.length === 0) return 0;
    const hits = lines.filter((l) => {
      const hasDoi = /\b10\.\d{4,9}\//.test(l);
      const hasYear = /(1[89]\d{2}|20[0-2]\d)/.test(l);
      return hasDoi || hasYear;
    }).length;
    if (hits === 0) return 0;
    return Math.min(20, Math.round((hits / lines.length) * 20));
  },
  read: parseOther,
};

export default otherParser;
