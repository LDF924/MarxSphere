// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// ris.ts — RIS 题录(PubMed / EndNote / NoteExpress / 万方 / 维普 / Zotero 通用导出)
//
// 由来: 旧项目 AIToolman 的 `read_PUBMED_file` / `read_CNKI_file` / `read_OTHER_file`
//   都会走到 RIS 变体上 —— RIS 是事实上的题录交换 lingua franca, 一份实现能吃掉
//   一大半"来自各数据库的导出文件"。
//
//     TY  - JOUR
//     AU  - Zhang, San
//     TI  - A study of ...
//     JO  - Journal of X
//     PY  - 2023
//     VL  - 12
//     IS  - 3
//     SP  - 100
//     EP  - 110
//     DO  - 10.1000/xyz
//     AB  - ...
//     KW  - keyword one
//     ER  -
//
// ⚠ RIS 的**容错边界**(各家导出的差异都在这三处):
//   · 行首标签两个字母 + **两个空格或一个制表符** 再接 `- `(有的库只给一个空格);
//   · 值可以**跨行**, 续行不带标签(必须接回上一条);
//   · 单条(`TY` 无 `ER`)也要能读 —— 用户手工复制粘贴时经常丢掉结尾的 ER。
import { type FormatParser, type LiteratureRecord, parseYear, joinPages, splitList, authorsOf, normalizeType, finish } from "./common.js";

const LINE_RE = /^\s*([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/;

/** RIS TY → 归一类型 */
function risType(v: string): string {
  const s = String(v ?? "").trim().toUpperCase();
  if (!s) return "";
  const map: Record<string, string> = {
    JOUR: "journal-article", JFULL: "journal-article", MGZN: "journal-article", NEWS: "newspaper-article",
    CONF: "conference-paper", CPAPER: "conference-paper", RPRT: "report", BOOK: "book",
    CHAP: "book-chapter", ECHAP: "book-chapter", THES: "thesis", UNPB: "preprint",
    ELEC: "other", WEB: "other", DATA: "other", GEN: "other",
    // 知网/万方导出的是中文类型名, 直接交给统一词汇表
  };
  return normalizeType(map[s] ?? s);
}

/** RIS 关键字段兼容(不同库的标签不完全一致) */
const TITLE_TAGS = ["TI", "T1", "CT", "BT"];
const JOURNAL_TAGS = ["JO", "JF", "JA", "J1", "J2", "T2", "SO"];
const ABSTRACT_TAGS = ["AB", "N2"];
const URL_TAGS = ["UR", "L1", "L2", "LK"];

export function parseRis(input: string): LiteratureRecord[] {
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
    const m = LINE_RE.exec(line);
    if (m) {
      const tag = m[1].toUpperCase();
      const val = m[2].trim();
      if (tag === "ER") { flush(); continue; }
      if (tag === "TY" && rec && Object.keys(rec).length > 1) flush(); // 上一条没写 ER
      if (!rec) rec = {};
      (rec[tag] ??= []).push(val);
      last = tag;
      continue;
    }
    // 续行(无标签) —— 接回上一条
    if (rec && last && rec[last]?.length) {
      const arr = rec[last];
      arr[arr.length - 1] = `${arr[arr.length - 1]} ${line.trim()}`.trim();
    }
  }
  flush();
  return out;
}

function toRecord(rec: Record<string, string[]>): LiteratureRecord | null {
  const pick = (tags: string[]): string[] => {
    for (const t of tags) if (rec[t]?.length) return rec[t];
    return [];
  };
  const first = (tags: string[]): string => pick(tags)[0] ?? "";
  const title = first(TITLE_TAGS);
  if (!title) return null;

  // SP/EP 是起止页; 有的库只给 M1 或直接一个页码
  const pages = joinPages(first(["SP"]), first(["EP"])) || first(["M1", "PG"]);
  const kw = ["KW", "DE", "ID"].flatMap((t) => splitList((rec[t] ?? []).join("; ")));
  return finish({
    title,
    // AU 是首选; A1/A2 是 EndNote 的"作者/编者"拆分
    authors: authorsOf((rec.AU?.length ? rec.AU : rec.A1?.length ? rec.A1 : rec.A2 ?? []).join("; ")),
    year: parseYear(first(["PY", "Y1", "DA", "DP"])),
    journal: first(JOURNAL_TAGS),
    volume: first(["VL", "V1", "VO"]),
    issue: first(["IS", "V2", "IP"]),
    pages,
    doi: first(["DO", "DI", "M3"]),
    abstract: pick(ABSTRACT_TAGS).join(" ").trim(),
    keywords: kw,
    url: pick(URL_TAGS).find((u) => /^https?:/i.test(u)) ?? "",
    type: risType(first(["TY"])),
    source: "ris",
  });
}

export const risParser: FormatParser = {
  id: "ris",
  label: "RIS(PubMed / EndNote / NoteExpress)",
  /**
   * 铁证是 `XX  - ` 这种"两字母 + 缩进 + 连字符"的行型(注意连字符两侧都有空白),
   * 以及 `TY  - ` / `ER  - ` 这对起止符。**必须有 ER 或 TY** 才算 RIS ——
   * 否则与 WOS 的 `AU Zhang, San` 只有一线之隔。
   */
  score(t: string): number {
    const s = String(t ?? "");
    if (!s) return 0;
    if (!/^\s*[A-Z][A-Z0-9]\s{1,2}-\s/m.test(s)) return 0;
    let score = 0;
    const types = [...s.matchAll(/^\s*TY\s{1,2}-\s*(\S+)/gm)].map((m) => m[1].toUpperCase());
    const ends = (s.match(/^\s*ER\s{1,2}-/gm) ?? []).length;
    if (types.length > 0) score += 45;
    if (ends > 0) score += 25;
    // 骨架字段
    if (/^\s*TI\s{1,2}-\s/m.test(s)) score += 15;
    if (/^\s*(AU|A1)\s{1,2}-\s/m.test(s)) score += 10;
    // 典型的 RIS 类型码(知网/万方导出的是 JOUR/CPAPER 这类)
    if (types.some((x) => ["JOUR", "CONF", "BOOK", "THES", "CPAPER", "RPRT", "ELEC", "GEN", "JFULL"].includes(x))) score += 5;
    return Math.min(88, score);
  },
  read: parseRis,
};

export default risParser;
