// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// endnote.ts — EndNote 的 Tagged / Refer 导出格式(`.enw` / `.txt`)
//
// 由来: 旧项目 AIToolman 的 `read_OTHER_file` 会碰到的另一种常见导出。
//   EndNote 的 "Tagged" 格式长这样(每行 `%X 值`, X 是一个字母):
//
//     %0 Journal Article
//     %A Zhang, San
//     %A Li, Si
//     %T A study of ...
//     %J Journal of X
//     %D 2023
//     %V 12
//     %N 3
//     %P 100-110
//     %R 10.1000/xyz
//     %X Abstract ...
//     %K keyword one
//
// ⚠ 与 RIS/WOS 的区别**只在标签这一个字母上**, 所以:
//   · 自动识别必须靠 `%A`/`%T`/`%0` 这几个"EndNote 专属"的组合, 不能靠"有 % 就是";
//   · `%0` 是**文献类型**(Journal Article / Book / Thesis / Conference Proceedings …),
//     不是 ID —— 认错的实现会把它当成编号丢掉, 然后整批类型为空。
import { type FormatParser, type LiteratureRecord, parseYear, normalizeDoi, splitList, authorsOf, normalizeType, finish } from "./common.js";

/** EndNote Reference Type 字符串 → 归一类型 */
function endnoteType(v: string): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/journal\s*article/i.test(s)) return "journal-article";
  if (/conference|proceedings|meeting/i.test(s)) return "conference-paper";
  if (/book\s*section|book\s*chapter|electronic\s*book\s*section/i.test(s)) return "book-chapter";
  if (/^book$/i.test(s) || /edited\s*book/i.test(s)) return "book";
  if (/thesis|dissertation/i.test(s)) return "thesis";
  if (/report/i.test(s)) return "report";
  if (/web\s*page|electronic/i.test(s)) return "other";
  if (/patent/i.test(s)) return "other";
  if (/preprint|unpublished/i.test(s)) return "preprint";
  if (/newspaper|magazine/i.test(s)) return "newspaper-article";
  return normalizeType(s);
}

/** `%标签 值` —— 标签是一个字母(EndNote Tagged) */
const ENW_RE = /^%([0-9A-Za-z])\s?(.*)$/;

export function parseEndnote(input: string): LiteratureRecord[] {
  const out: LiteratureRecord[] = [];
  let rec: Record<string, string[]> | null = null;
  let last = "";

  const flush = (): void => {
    if (!rec) return;
    const r = toRecord(rec);
    if (r) out.push(r);
    rec = null;
    last = "";
  };

  for (const raw of String(input ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (line === "") continue;
    const m = ENW_RE.exec(line);
    if (m) {
      const tag = m[1].toUpperCase();
      if (!rec) rec = {};
      (rec[tag] ??= []).push(m[2].trim());
      last = tag;
      continue;
    }
    // 续行(不带 `%`) —— 接回上一条
    if (rec && last && rec[last]?.length) {
      const arr = rec[last];
      arr[arr.length - 1] = `${arr[arr.length - 1]} ${line.trim()}`.trim();
    }
  }
  flush();
  return out;
}

function toRecord(rec: Record<string, string[]>): LiteratureRecord | null {
  const get = (t: string): string => (rec[t]?.length ? rec[t][0] : "");
  // `%T` 是题名; 只有 `%B`(书/会议名)时退而用之 —— 那多半是会议论文
  const title = get("T") || get("S") || "";
  if (!title) return null;
  const pages = get("P");
  const doi = normalizeDoi(get("R"));
  return finish({
    title,
    authors: authorsOf((rec.A?.length ? rec.A : rec.E ?? []).join("; ")),
    year: parseYear(get("D")),
    journal: get("J") || get("B"),
    volume: get("V"),
    issue: get("N"),
    pages: pages.replace(/[-–—~～]{1,2}/g, "-"),
    doi,
    abstract: get("X"),
    keywords: splitList((rec.K ?? []).join("; ")),
    url: /^https?:/i.test(get("U")) ? get("U") : "",
    // `%9` 在学位论文里是"PhD thesis", 在别处是杂项 —— 两者都无害, 统一当类型
    type: endnoteType(get("0")) || endnoteType(get("9")),
    source: "endnote",
  });
}

export const endnoteParser: FormatParser = {
  id: "endnote",
  label: "EndNote Tagged(.enw)",
  /**
   * 铁证: `%0 <参考文献类型>`(EndNote Tagged 特有)与 `%A`/`%T` 组合。
   * 只给 82 —— 低于 WOS/RIS 的"文件头级"证据, 高于只是形状像的。
   */
  score(t: string): number {
    const s = String(t ?? "");
    if (!s) return 0;
    if (!/^%[0-9A-Za-z] /m.test(s)) return 0;
    let score = 0;
    if (/^%0\s+\S/m.test(s)) score += 40;                        // 参考文献类型行
    if (/^%T\s+\S/m.test(s)) score += 15;
    if (/^%(A|E)\s+\S/m.test(s)) score += 10;
    if (/^%(J|D|V|N|P|R|X|K|U)\s+\S/m.test(s)) score += 10;
    // 完全不像 RIS/WOS: 没有 `XX  - ` 也没有 `XX ` 两字母标签
    if (!/^\s*[A-Z][A-Z0-9]\s{1,2}-\s/m.test(s) && !/^[A-Z][A-Z0-9] \S/m.test(s)) score += 7;
    return Math.min(82, score);
  },
  read: parseEndnote,
};

export default endnoteParser;
