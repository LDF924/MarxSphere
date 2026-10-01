// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// medline.ts — PubMed MEDLINE 格式(旧项目 `read_PUBMED_file`)
//
// 由来: PubMed 的 "Save → Format: MEDLINE" 导出。它与 RIS 的区别不在语义, 而在**行型**:
//
//     PMID- 12345678
//     TI  - A study of ...
//     AB  - Background: ...
//           Methods: ...          ← 续行缩进 6 空格, 且**会带冒号分段**
//     AU  - Zhang S
//     JT  - Journal of X
//     DP  - 2023 Mar 15
//     VI  - 12
//     IP  - 3
//     PG  - 100-110
//     LID - 10.1000/xyz [doi]
//     AID - 10.1000/xyz [doi]
//     OT  - keyword one
//     ER  -
//
// ⚠ 三个 MEDLINE 特有的坑:
//   ① DOI **不在 DO 标签里**, 而在 `LID`/`AID` 的 `[doi]` 后缀里 ——
//      只找 DO 的实现会丢掉全部 DOI(PubMed 导出根本没有 DO 行);
//   ② 作者是 `Zhang S`(姓 + 名首字母), 不是 RIS 的 `Zhang, San`;
//   ③ `DP` 是自由日期文本(`2023 Mar 15` / `2023`), 年份得从里面抠。
import { type FormatParser, type LiteratureRecord, parseYear, splitList, normalizeType, finish } from "./common.js";

/** PubMed 的出版类型 → 归一类型; 认不出交给统一词汇表 */
function medlineType(v: string): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/journal article|randomized controlled trial|clinical trial|comparative study|review/i.test(s)) {
    return /review/i.test(s) ? "review" : "journal-article";
  }
  if (/congress|meeting|conference/i.test(s)) return "conference-paper";
  if (/book|monograph/i.test(s)) return "book";
  if (/thesis/i.test(s)) return "thesis";
  if (/preprint/i.test(s)) return "preprint";
  return normalizeType(s);
}

/** `LID - 10.1000/xyz [doi]` / `AID - 10.1000/xyz [doi]` 里把 DOI 抠出来 */
function doiFromIdentifierLines(lines: string[]): string {
  for (const l of lines) {
    const m = /\[doi\]\s*$/i.exec(l);
    if (m) return l.replace(/\s*\[doi\]\s*$/i, "").replace(/^doi:\s*/i, "").trim();
  }
  // 有的导出把 doi 写成 `doi: 10.xxxx/yyy`
  for (const l of lines) {
    const m = /^doi:\s*(\S+)/i.exec(l.trim());
    if (m) return m[1];
  }
  return "";
}

export function parseMedline(input: string): LiteratureRecord[] {
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
    // `ER` 是光杆行(标签后什么都没有), `标签-值` 那条正则会漏掉它 —— 与 wos.ts 同一个坑
    if (/^ER\s*-\s*$/.test(line) || /^ER\s*$/.test(line)) { flush(); continue; }
    const m = /^([A-Z]{2,4})\s*-\s?(.*)$/.exec(line);
    if (m) {
      const tag = m[1];
      if (!rec) rec = {};
      (rec[tag] ??= []).push(m[2].trim());
      last = tag;
      continue;
    }
    // 续行(缩进) —— 接回上一条
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
  const title = get("TI") || get("BTI");
  if (!title) return null;
  const pages = get("PG") || [get("VI"), get("IP")].filter(Boolean).join("");
  return finish({
    title,
    authors: (rec.AU ?? []).map((a) => a.trim()).filter(Boolean),
    year: parseYear(get("DP") || get("DEP") || get("DA")),
    journal: get("JT") || get("TA") || get("BTI"),
    volume: get("VI"),
    issue: get("IP"),
    pages,
    doi: doiFromIdentifierLines(rec.LID ?? []) || doiFromIdentifierLines(rec.AID ?? []) || get("DO"),
    abstract: (rec.AB ?? []).join(" ").trim(),
    keywords: splitList((rec.OT ?? []).join("; ")).concat(splitList((rec.MH ?? []).join("; "))),
    url: get("PMID") ? `https://pubmed.ncbi.nlm.nih.gov/${get("PMID")}/` : "",
    type: medlineType(get("PT")),
    source: "medline",
  });
}

export const medlineParser: FormatParser = {
  id: "medline",
  label: "PubMed MEDLINE",
  /**
   * MEDLINE 的铁证是 `PMID- `(四个字母 + **连字符紧跟**, 与 RIS 的 `XX  - ` 缩进不同)
   * 和 `LID - ... [doi]`。只给 85 —— 它毕竟是 RIS 的近亲。
   */
  score(t: string): number {
    const s = String(t ?? "");
    if (!s) return 0;
    if (!/^[A-Z]{2,4}- /m.test(s)) return 0;
    let score = 0;
    if (/^PMID- \d+/m.test(s)) score += 40;                    // 铁证: PMID 行
    if (/^(LID|AID) - .*\[doi\]/im.test(s)) score += 20;       // 铁证: [doi] 标识符行
    if (/^(TI|JT|DP|AU)  - /m.test(s)) score += 15;            // 双字母 + 两空格
    if (/^ER  -\s*$/m.test(s)) score += 10;
    if (/^(MH|OT)  - /m.test(s)) score += 5;                   // MeSH 主题词/关键词
    return Math.min(85, score);
  },
  read: parseMedline,
};

export default medlineParser;
