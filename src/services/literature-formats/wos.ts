// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// wos.ts — Web of Science 纯文本题录(`savedrecs.txt`)
//
// 由来: 旧项目 AIToolman 的 `read_WOS_file`。WOS 主页 → 导出 → "纯文本" 得到的
//   savedrecs.txt 是**记录块**格式, 不是行式表格:
//
//     FN Clarivate Analytics Web of Science
//     VR 1.0
//     PT J
//     AU Zhang, San
//     AF Zhang, San
//     TI A study of ...
//     SO JOURNAL OF X
//     DI 10.1000/xyz
//     PY 2023
//     VL 12
//     IS 3
//     BP 100
//     EP 110
//     AB ...
//     DE keyword one; keyword two
//     ER
//
// ⚠ 三个必须处理的现实差异(照抄不动的实现都会在这里丢数据):
//   ① 字段值可以**跨行**: 长标题/长摘要会续下一行, 且续行**缩进三个空格** ——
//      不拼接就会把标题截成前半句;
//   ② 多作者/多关键词是**重复标签**(每行一个 AU), 不是一行分号列表;
//   ③ 记录之间靠 `ER` 分隔, 文件末还有 `EF`; `FN`/`VR` 是文件头不是文献。
import { type FormatParser, type LiteratureRecord, parseYear, joinPages, splitList, authorsOf, normalizeType, finish } from "./common.js";

/**
 * WOS 的标签全集。用**白名单**而不是 `^[A-Z][A-Z0-9] `:
 * 用户从网页复制出来的文本经常丢掉缩进, 那样"续行"会长得像标签(如 `AB 的后续`)
 * —— 白名单让认不出的两字母前缀退回续行, 而不是造出一个假字段。
 */
const WOS_TAGS = new Set([
  "FN", "VR", "PT", "AU", "AF", "BA", "BE", "TI", "SO", "SE", "BS", "LA", "DT", "CT", "CY",
  "CL", "SP", "HO", "DE", "ID", "AB", "C1", "RP", "EM", "RI", "OI", "FU", "FX", "CR", "NR",
  "TC", "Z9", "U1", "U2", "PU", "PI", "PA", "SN", "EI", "BN", "J9", "JI", "PD", "PY", "VL",
  "IS", "BP", "EP", "PG", "WC", "SC", "GA", "UT", "OA", "PM", "DA", "ER", "EF", "DI", "EA",
  "EY", "AD", "AR", "SI", "PN", "SU", "MA", "GP", "CP", "T1", "T2", "T3", "Y1", "A1", "A2",
]);
const TAG_RE = /^([A-Z][A-Z0-9])[ \t](.*)$/;
/**
 * `ER` / `EF` 是**光杆行**(标签后面什么都没有)。
 * 只按 `标签 + 空格 + 值` 匹配的实现会把它们当成"续行"接到上一条字段上 ——
 * 实测表现是关键词变成 `rural governance ER EF`, 记录也永远不 flush。
 */
const BARE_RE = /^(ER|EF)\s*$/;

export function parseWos(input: string): LiteratureRecord[] {
  const out: LiteratureRecord[] = [];
  /** 当前记录: 标签 → 值行数组(重复标签按出现顺序堆叠) */
  let rec: Record<string, string[]> | null = null;
  let lastTag = "";

  const flush = (): void => {
    if (!rec) return;
    const r = toRecord(rec);
    if (r) out.push(r);
    rec = null;
    lastTag = "";
  };

  for (const raw of String(input ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (line === "") continue;

    const bare = BARE_RE.exec(line);
    if (bare) {
      if (bare[1] === "ER") { flush(); continue; }
      flush(); break;                                   // EF = 文件结束
    }

    const m = TAG_RE.exec(line);
    const tag = m && WOS_TAGS.has(m[1]) ? m[1] : "";
    if (tag) {
      if (tag === "FN" || tag === "VR") continue; // 文件头(库名 + 版本号)
      if (!rec) rec = {};
      (rec[tag] ??= []).push(m![2].trim());
      lastTag = tag;
      continue;
    }
    // 续行: 接到**最后一个**标签上(不是第一个 —— 摘要后面还跟着 DE/CR 等)
    if (rec && lastTag && rec[lastTag]?.length) {
      const arr = rec[lastTag];
      arr[arr.length - 1] = `${arr[arr.length - 1]} ${line.trim()}`.trim();
    }
  }
  flush();
  return out;
}

/**
 * WOS 的 `PT` 是**单字母代码**(J/B/C/P/D/S…), 而 `DT` 是展开的英文类型名。
 * 不管代码直接丢给统一词汇表的话, 类型会变成字符串 `"J"` —— 归一失败但不报错。
 */
const PT_CODES: Record<string, string> = {
  J: "journal-article", B: "book", S: "book", C: "conference-paper",
  P: "other", D: "other", R: "report", E: "thesis", G: "other",
};

function wosType(rawDt: string, rawPt: string): string {
  if (rawDt) return normalizeType(rawDt);
  const code = rawPt.trim().toUpperCase();
  if (!code) return "";
  return PT_CODES[code] ?? normalizeType(code);
}

function toRecord(rec: Record<string, string[]>): LiteratureRecord | null {
  const get = (t: string): string => (rec[t]?.length ? rec[t][0] : "");
  const title = get("TI") || get("T1");
  if (!title) return null;
  // AU = 作者(姓, 名); AF 是同一批人的展开式, 两者内容重复, AU 优先
  // AU 每行一个作者, 但同一行里也可能写成 `Zhang, San; Li, Si` —— authorsOf 按"段是否像中文名"决定要不要再切
  const authors = authorsOf((rec.AU?.length ? rec.AU : rec.AF ?? []).join("; "));
  return finish({
    title,
    authors,
    year: parseYear(get("PY") || get("PD") || get("Y1")),
    journal: get("SO") || get("J2") || get("T2") || get("JI"),
    volume: get("VL"),
    issue: get("IS"),
    pages: joinPages(get("BP"), get("EP")) || get("PG"),
    doi: get("DI") || get("DO"),
    abstract: get("AB"),
    keywords: splitList((rec.DE ?? []).join("; ")).concat(splitList((rec.ID ?? []).join("; "))),
    url: get("UR") || get("L1") || get("L2"),
    type: wosType(get("DT"), get("PT")),
    source: "wos",
  });
}

export const wosParser: FormatParser = {
  id: "wos",
  label: "Web of Science 纯文本",
  /**
   * `FN Clarivate` / `VR 1.0` 是 WOS 独有的文件头(铁证); `PT J` + `ER` 骨架次之。
   * 上限 90 而非 100 —— 留出余量给"更独特的格式", 但并不影响它赢过形状相似者。
   */
  score(t: string): number {
    const s = String(t ?? "").slice(0, 8000);
    if (!s) return 0;
    let score = 0;
    if (/^FN\s+(Clarivate|Thomson|ISI|Web of Science)/im.test(s)) score += 55;
    if (/^VR\s+1\.0\s*$/im.test(s)) score += 25;
    if (/^ER\s*$/im.test(s)) score += 20;
    if (/^PT\s+[A-Z]/im.test(s) && /^TI\s+\S/im.test(s) && /^AU\s+\S/im.test(s)) score += 15;
    return Math.min(90, score);
  },
  read: parseWos,
};

export default wosParser;
