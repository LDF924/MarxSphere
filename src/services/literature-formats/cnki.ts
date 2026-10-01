// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// cnki.ts — 知网(CNKI)题录导出(旧项目 `read_CNKI_file`)
//
// 由来: **全平台没有一个入口能吃下用户从知网导出的题录文件**。知网的导出有好几种皮,
//   实际见到的至少三类, 这个文件把它们全兜住:
//
//   ① **一篇一段的"题名-作者-来源-年"紧凑格式**(知网"导出/参考文献"里选"自定义"或
//      复制结果时最容易拿到这种, 用 `--` / 换行分段):
//
//         [1] 张三,李四.资本下乡的路径创新[J].社会学研究,2023,12(03):100-110.
//
//   ② **Refworks 格式**(逐字段 `标签 值`, 与 RIS 近似但没有 `ER` 行):
//
//         TI  资本下乡的路径创新
//         A1  张三
//         JF  社会学研究
//         YR  2023
//
//   ③ 知网的 RIS 变体(`TY  - JOUR` ... `ER  -`) —— 直接交给 ris.ts, 见 common 的分派。
//
// ⚠ 知网导出最要命的一处: `[J]`/`[D]`/`[C]` 这类**文献类型标识在标题里**
//   (`资本下乡的路径创新[J]`) —— 不剥掉, 入库的标题就永远带着方括号, 判重也判不准。
import { type FormatParser, type LiteratureRecord, normalizeType, finish, splitList, authorsOf } from "./common.js";

/** 知网文献类型标识 → 归一类型 */
const CNKI_TYPE: Record<string, string> = {
  期刊: "journal-article", J: "journal-article",
  学位: "thesis", D: "thesis",
  会议: "conference-paper", C: "conference-paper",
  报纸: "newspaper-article", N: "newspaper-article",
  图书: "book", M: "book",
  专利: "other", P: "other",
  标准: "other", S: "other",
  报告: "report", R: "report",
};

/** 剥掉标题里混进来的类型标识与引号: `资本下乡的路径创新[J]` → `资本下乡的路径创新` */
function cleanCnkiTitle(raw: string): string {
  return String(raw ?? "")
    .replace(/^\s*\[?\d+\]?[.、\s]+/, "")          // 前导序号 `[1]` / `1.`
    .replace(/[[【（(]\s*[JDCNMPRS]\s*[\]】）)]\s*$/i, "")
    .replace(/[[【]\s*(期刊|学位|会议|报纸|图书|专利|标准|报告)\s*[\]】]\s*$/, "")
    .replace(/^["“”']+|["“”']+$/g, "")
    .trim();
}

/** `100-110` / `100~110` → `100-110` */
function normPages(v: string): string {
  return String(v ?? "").replace(/[~～—–]/g, "-").trim();
}

/**
 * 格式①: 一篇一段的行式题录。
 *
 * 单篇形如:
 *   `[1] 张三,李四.资本下乡的路径创新[J].社会学研究,2023,12(03):100-110.`
 *   `资本下乡的路径创新-张三-社会学研究-2023` (有的导出是"题名-作者-来源-年"连字符版)
 *   也可能是制表符/竖线分隔的列(纯文本视图)。
 *
 * **不用正则硬解整行** —— 中英文标点混用会让正则爆炸。做法是先用类型标识(`[J]`)
 * 把"作者+题名"与"刊名+年卷期页"切开, 再在各自那半段里用最右一个分隔符定位。
 */
export function parseCnkiLines(input: string): LiteratureRecord[] {
  const out: LiteratureRecord[] = [];
  for (const rawLine of String(input ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length < 8) continue;
    // 表头行(有列名但整行不是一篇文献)
    if (/^(题名|标题|篇名|作者|来源|刊名|年份|年)\b/.test(line) && !/[.。]/.test(line)) continue;
    const rec = parseCnkiLine(line);
    if (rec) out.push(rec);
  }
  return dedupe(out);
}

/** 从一段文本里抠 年/卷/期/页 */
function tailParts(s: string): { year?: number; volume: string; issue: string; pages: string } {
  // `2023,12(03):100-110` / `2023(03):100-110` / `2023, 12(3): 100~110`
  const full = /(1[89]\d{2}|20\d{2})\s*(?:[,，]\s*(\d+))?\s*[(（](\d+)[)）]?\s*[::]\s*([0-9]+(?:\s*[-–~～]\s*[0-9]+)?)/.exec(s);
  if (full) {
    return {
      year: Number(full[1]), volume: full[2] ?? "", issue: full[3] ?? "",
      pages: normPages(full[4] ?? ""),
    };
  }
  const partial = /(1[89]\d{2}|20\d{2})\s*[,，]\s*(\d+)\s*[(（](\d+)[)）]/.exec(s);
  if (partial) return { year: Number(partial[1]), volume: partial[2], issue: partial[3], pages: "" };
  const y = /(1[89]\d{2}|20\d{2})/.exec(s);
  return { year: y ? Number(y[1]) : undefined, volume: "", issue: "", pages: "" };
}

/** 从"作者段"抽作者 —— 中文题录里 `张三,李四` 是两个人, 用 authorsOf 的保守判据切 */
function authorSeg(raw: string): string[] {
  return authorsOf(String(raw ?? "").replace(/[、]/g, ";"))
    // 姓名长度上限 40(中文 2~4 字, 西文姓名最长也就这么多); 纯数字不是人名
    .filter((a) => a.length > 0 && a.length <= 40 && !/^\d+$/.test(a) && /[A-Za-z一-龥]/.test(a));
}

function parseCnkiLine(line: string): LiteratureRecord | null {
  const s = line.replace(/^\s*\[?\d+\]?[.、\s]+/, "").trim();
  if (s.length < 6) return null;

  const typeHit = /[[【(]\s*([JDCNMPRS]|期刊|学位|会议|报纸|图书|专利|标准|报告)\s*[\]】)]/i.exec(s);

  let title = "", journal = "", type = "", authorRaw = "", tail = "";

  if (typeHit) {
    const key = typeHit[1].toUpperCase();
    type = CNKI_TYPE[key] ?? CNKI_TYPE[typeHit[1]] ?? "";
    const before = s.slice(0, typeHit.index);
    const after = s.slice(typeHit.index + typeHit[0].length).replace(/^[.。，,、\s]+/, "");
    // 作者与题名之间用 `.` 分(知网的著录格式); 取**最右**一个, 副标题里的点不会误伤
    const cut = Math.max(before.lastIndexOf("."), before.lastIndexOf("。"));
    if (cut > 0 && cut < before.length - 1) {
      authorRaw = before.slice(0, cut);
      title = before.slice(cut + 1);
    } else {
      title = before;
    }
    const jEnd = after.search(/[,，]/);
    if (jEnd >= 0) { journal = after.slice(0, jEnd); tail = after.slice(jEnd + 1); }
    else { journal = after; }
  } else {
    // 无类型标识: 按 `.` / `。` 切段猜(作者.题名.刊名,年)
    const parts = s.split(/[.。]/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 3) {
      authorRaw = parts[0];
      title = parts[1];
      const rest = parts.slice(2).join(",");
      const jEnd = rest.search(/[,，]/);
      if (jEnd >= 0) { journal = rest.slice(0, jEnd); tail = rest.slice(jEnd + 1); }
      else { journal = rest; }
    } else if (parts.length === 2) {
      authorRaw = parts[0];
      title = parts[1];
    } else {
      // 连字符版: `题名-作者-来源-年`
      const hy = s.split(/\s*[-–—]{1,2}\s*/).map((x) => x.trim()).filter(Boolean);
      if (hy.length >= 3 && /^(1[89]\d{2}|20\d{2})$/.test(hy[hy.length - 1] ?? "")) {
        title = hy[0];
        authorRaw = hy[1];
        journal = hy.slice(2, -1).join("-");
        tail = hy[hy.length - 1];
      } else return null;
    }
  }

  title = cleanCnkiTitle(title);
  if (!title || title.length < 4) return null;

  const t = tailParts(tail || s);
  return finish({
    title,
    authors: authorSeg(authorRaw),
    year: t.year && t.year >= 1800 && t.year <= 2100 ? t.year : undefined,
    journal: journal.replace(/[.,，。;；]+$/, "").trim(),
    volume: t.volume,
    issue: t.issue,
    pages: t.pages,
    type,
    source: "cnki",
  });
}

/** 格式②: Refworks。逐行 `标签 值`, 标签是**两个字符 + 两个空格**(第一个是字母, 第二个可是数字: A1/A2/A3/A4) */
const REFWORKS_MAP: Record<string, string> = {
  TI: "title", T1: "title", T2: "journal", JF: "journal", JO: "journal", JA: "journal",
  A1: "author", AU: "author", A2: "author", A3: "author", A4: "author",
  YR: "year", PY: "year", FD: "year", PB: "publisher", SN: "issn",
  VO: "volume", VL: "volume", IS: "issue", OP: "pages", SP: "pages", PP: "pages", PG: "pages",
  AB: "abstract", K1: "keyword", KW: "keyword", DE: "keyword", NO: "note",
  DO: "doi", DI: "doi", UR: "url", LK: "url", AD: "address", LA: "language", M3: "type",
};

export function parseRefworks(input: string): LiteratureRecord[] {
  const out: LiteratureRecord[] = [];
  let cur: Record<string, string> = {};
  let hasTitle = false;

  const flush = (): void => {
    if (hasTitle) {
      const rec = toRefworksRecord(cur);
      if (rec) out.push(rec);
    }
    cur = {};
    hasTitle = false;
  };

  for (const raw of String(input ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (line === "") continue;
    // 标签第二位可以是数字(A1/A2/A3/A4 是知网/Refworks 的作者行) —— `[A-Z]{2}` 会漏掉全部作者
    const m = /^([A-Z][A-Z0-9])[ ]{2,}(.*)$/.exec(line);
    if (m) {
      const key = REFWORKS_MAP[m[1]];
      if (!key) continue;                       // 认不出的标签: 丢弃而不是造字段
      if (key === "title" && hasTitle) flush(); // 下一条开始了
      cur[key] = cur[key] ? `${cur[key]}; ${m[2].trim()}` : m[2].trim();
      if (key === "title") hasTitle = true;
      continue;
    }
    // 续行: 接回上一个已知标签(Refworks 的续行同样缩进)
    if (hasTitle && /^\s+\S/.test(line)) {
      const keys = Object.keys(cur);
      if (keys.length) cur[keys[keys.length - 1]] += " " + line.trim();
    }
  }
  flush();
  return dedupe(out);
}

function toRefworksRecord(f: Record<string, string>): LiteratureRecord | null {
  const title = cleanCnkiTitle(f.title ?? "");
  if (!title || title.length < 4) return null;
  return finish({
    title,
    authors: authorsOf(f.author ?? ""),
    year: f.year ? Number(String(f.year).slice(0, 4)) || undefined : undefined,
    journal: f.journal ?? "",
    volume: f.volume ?? "",
    issue: f.issue ?? "",
    pages: normPages(f.pages ?? ""),
    doi: f.doi ?? "",
    abstract: f.abstract ?? "",
    keywords: splitList(f.keyword ?? ""),
    url: /^https?:/i.test(f.url ?? "") ? f.url : "",
    type: CNKI_TYPE[(f.type ?? "").toUpperCase()] ?? normalizeType(f.type ?? ""),
    source: "cnki",
  });
}

/** 同文件内自去重(同标题同作者) —— 知网导出常把同一篇同时打进正文与参考文献 */
function dedupe(recs: LiteratureRecord[]): LiteratureRecord[] {
  const seen = new Set<string>();
  const out: LiteratureRecord[] = [];
  for (const r of recs) {
    const k = `${r.title}|${r.authors.join(",")}|${r.year ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export const cnkiParser: FormatParser = {
  id: "cnki",
  label: "知网(CNKI)题录",
  score(t: string): number {
    const s = String(t ?? "");
    if (!s) return 0;
    // 有 RIS 骨架的交给 ris.ts, 这里不抢
    if (/^\s*TY\s{1,2}-\s/m.test(s)) return 0;
    let score = 0;
    // 铁证: 中文文献类型标识紧跟在中文标题之后, 且带 `[J]` 这类方括号
    if (/[一-龥]{4,}\s*[[【]\s*[JDCNMPRS]\s*[\]】]/i.test(s)) score += 50;
    if (/^[A-Z][A-Z0-9]\s{2}\S/m.test(s) && /^(TI|A1|YR|JF|K1)\s{2}/m.test(s)) score += 25; // Refworks 标签组
    /**
     * 连字符版 `题名-作者-来源-年`(本文件 read() 一直在支持它, 但 score 原先**没有**
     * 任何规则认它 —— 于是 detect() 判成 other, 整行被当成题名, 作者/期刊全丢)。
     *
     * 结构性判据: 分隔成 4 段以上、且**末段是四位年份**。比"含中文"这种判据严格得多,
     * 不会把普通带连字符的句子认成题录。
     * 实测(2026-10-01): 加它之前 `乡村振兴与农村集体经济-张三-社会学研究-2024`
     *   识别为 other、authors=[]；加它之后正确识别为 cnki 并切出三段。
     */
    if (/^[^\n]{4,}[-–—][^\n]{2,12}[-–—][^\n]{2,}[-–—](?:19|20)\d{2}\s*$/m.test(s)) score += 40;
    // 中文作者 + 中文题名 + 年份卷期页的行型
    if (/^[\[【]?\d+[\]】]?\s*[一-龥]{2,4}[,，][^\n]{6,}$/m.test(s)) score += 20;
    if (/(1[89]\d{2}|20\d{2})\s*[,，]\s*\d+\s*[(（]\d+[)）]/.test(s)) score += 15;
    // ⚠ **刻意不给"含中文"这种加分**: 任何一段中文散文都满足, 加了它之后
    //   "会议纪要"这类文本会被认成知网题录(实测过)。认格式要的是**著录特征**,
    //   不是"看起来是中文"。
    return Math.min(80, score);
  },
  read: (t) => {
    // 同一份文件可能是 Refworks(带 TI/A1 标签)也可能是行式, 按内容选
    const s = String(t ?? "");
    if (/^(TI|A1|YR|JF)\s{2}\S/m.test(s)) return parseRefworks(s);
    return parseCnkiLines(s);
  },
};

export default cnkiParser;
