// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// bibtex.ts — BibTeX 题录(Zotero / JabRef / Google Scholar 导出)
//
// 由来: 旧项目 AIToolman 的 `read_OTHER_file` 兜底场景之一。
//
//     @article{zhang2023study,
//       author  = {Zhang, San and Li, Si},
//       title   = {A study of {DNA} sequencing},
//       journal = {Journal of X},
//       year    = {2023},
//       volume  = {12},
//       doi     = {10.1000/xyz}
//     }
//
// ⚠ 实现要点(照搬正则的实现会在这里坏掉):
//   ① 值可以是 `{...}` / `"..."` / 裸数字 / **宏名**(`month = jan`);
//      花括号**可嵌套**(`{A study of {DNA}}`), 正则配不平 —— 这里用手写的游标扫描;
//   ② `@string{...}` 定义的宏要在后续条目里展开, `@preamble`/`@comment` 要跳过;
//   ③ 值里的 LaTeX(`\"u` `\&` `\emph{}`)读出来得还原成人话, 否则入库的是转义源码。
import { type FormatParser, type LiteratureRecord, parseYear, splitList, normalizeType, finish } from "./common.js";

// ───────────────────────────── LaTeX 还原 ─────────────────────────────

/** 组合重音符号(U+0300 段)。用 fromCharCode 构造 —— 直接写字符的话在编辑器里看不见 */
function mark(code: number): string { return String.fromCharCode(code); }
const ACCENT_MARK: Record<string, string> = {
  "'": mark(0x0301), "`": mark(0x0300), "^": mark(0x0302), '"': mark(0x0308), "~": mark(0x0303),
  "=": mark(0x0304), ".": mark(0x0307), u: mark(0x0306), v: mark(0x030c), H: mark(0x030b),
  c: mark(0x0327), d: mark(0x0323), b: mark(0x0331), k: mark(0x0328), r: mark(0x030a),
};

/** 可以反斜杠转义成字面量的字符 —— 去掉反斜杠后**保留**这个字符 */
const ESCAPED_LITERAL = new Set(["$", "%", "&", "_", "#", "{", "}", " ", ",", ";", ":", "!", "-", "/", "~"]);

/** 连字命令(`\ss` → ß)。命令名在反斜杠之后 */
const LIGATURES: Record<string, string> = {
  ss: "ß", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", o: "ø", O: "Ø",
  l: "ł", L: "Ł", aa: "å", AA: "Å", i: "ı", j: "ȷ",
};

/** 去掉命令名、**保留**其参数文本的命令(`\emph{粗体}` → `粗体`); 其余命令名一律丢掉 */
const KEEP_ARG_COMMANDS = new Set([
  "emph", "textit", "textbf", "textsc", "textrm", "textsf", "texttt", "mbox", "text",
  "mathrm", "mathit", "mathbf", "ensuremath", "protect", "noopsort", "relax", "hspace", "vspace",
]);

/**
 * LaTeX 源码 → 纯文本。
 *
 * ⚠ 用手写游标而不是一串 `replace`: 重音符号是**组合字符**(U+0300 段), 直接写进
 *   源码看不见、转义字面量又会被工具链反转义 —— 这个文件的第一版就坏在这儿。
 *   单遍扫描不需要哨兵字符, 也就没有"占位符被后续步骤吃掉"的坑。
 *
 * 未知命令的策略: 只删命令名, **保留参数内容**。题录里出现 `\foo{Bar}` 时,
 * 留下 `Bar` 比留下 `\foo` 有用得多。
 */
export function stripLatex(input: string): string {
  const s = String(input ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (c === "\\") {
      const next = s[i + 1] ?? "";
      if (next === "\\") { out += " "; i++; continue; }          // `\\` = 换行
      if (next === "") break;
      // 重音: \"o / \"{o} / \'e(后面不能再接字母, 否则 \underline 会变成 ùnderline)
      if (ACCENT_MARK[next]) {
        const after = s[i + 2] ?? "";
        if (after === "{") {
          const close = s.indexOf("}", i + 3);
          const body = close < 0 ? s.slice(i + 3) : s.slice(i + 3, close);
          out += `${body}${ACCENT_MARK[next]}`.normalize("NFC");
          i = close < 0 ? s.length : close;
          continue;
        }
        if (/[A-Za-z]/.test(after) && !/[A-Za-z]/.test(s[i + 3] ?? "")) {
          out += `${after}${ACCENT_MARK[next]}`.normalize("NFC");
          i += 2;
          continue;
        }
        // 落单的 `\~` / `\"` → 字面量
        out += next === "~" ? "~" : next;
        i++;
        continue;
      }
      if (/[A-Za-z]/.test(next)) {
        const m = /^[A-Za-z]+/.exec(s.slice(i + 1));
        const name = m ? m[0] : "";
        i += name.length;
        if (LIGATURES[name]) { out += LIGATURES[name]; continue; }
        if (KEEP_ARG_COMMANDS.has(name)) continue;
        continue;                                                 // 其余命令: 只丢名字
      }
      if (ESCAPED_LITERAL.has(next)) { out += next; i++; continue; }
      i++;                                                        // `\,` `\;` 这类间距命令: 整个丢掉
      continue;
    }

    if (c === "$" || c === "{" || c === "}") continue;            // 数学模式/分组括号: 去括号留内容
    if (c === "-" && s[i + 1] === "-") {
      if (s[i + 2] === "-") { out += "—"; i += 2; } else { out += "–"; i += 1; }
      continue;
    }
    if (c === "~") { out += " "; continue; }                      // LaTeX 的不换行空格
    out += c;
  }
  return out.replace(/\s+/g, " ").trim();
}

// ───────────────────────────── 结构扫描 ─────────────────────────────

/** `src[start]` 必须是 `{` 或 `(`; 返回 [括号内内容, 右括号之后的下标] */
function readBalanced(src: string, start: number): [string, number] {
  const open = src[start];
  const close = open === "{" ? "}" : ")";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }          // 转义的下一位不当括号
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return [src.slice(start + 1, i), i + 1]; }
  }
  return [src.slice(start + 1), src.length];    // 括号没配平: 当到文件末
}

/** 在**括号深度 0** 上找下一个目标字符(嵌套里的逗号/等号不算分隔符) */
function findTopLevel(src: string, from: number, target: string): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "{" || c === "(") depth++;
    else if (c === "}" || c === ")") { depth--; if (depth < 0) return -1; }
    else if (c === target && depth === 0) return i;
  }
  return -1;
}

/** 读一个值(可含 `#` 拼接与宏名); 返回 [值, 停在的下标(该处是 `,` 或串尾)] */
function readValue(src: string, pos: number, macros: Record<string, string>): [string, number] {
  let out = "";
  while (pos < src.length) {
    const c = src[pos];
    if (c === "{") { const [inner, end] = readBalanced(src, pos); out += inner; pos = end; }
    else if (c === '"') {
      let i = pos + 1, buf = "";
      for (; i < src.length; i++) {
        if (src[i] === "\\") { buf += src[i] + (src[i + 1] ?? ""); i++; continue; }
        if (src[i] === '"') break;
        buf += src[i];
      }
      out += buf; pos = i + 1;
    } else if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z][\w:-]*/.exec(src.slice(pos));
      if (!m) break;
      out += macros[m[0].toLowerCase()] ?? "";  // 未知宏按空串(比留着宏名干净)
      pos += m[0].length;
    } else if (c === "#") pos++;
    else if (c === ",") break;
    else { out += c; pos++; }                   // 裸数字
  }
  return [out, pos];
}

/** 条目体 → 字段表。第一段(cite key)之后是 `名 = 值` */
function readFields(body: string, macros: Record<string, string>): { key: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  let key = "", i = 0, seg = 0;
  while (i < body.length) {
    const eq = findTopLevel(body, i, "=");
    const comma = findTopLevel(body, i, ",");
    // 第一段且它比第一个等号更早结束 → 这是 cite key, 不是字段
    if (seg === 0 && (eq < 0 || (comma >= 0 && comma < eq))) {
      key = body.slice(i, comma < 0 ? body.length : comma).trim();
      i = comma < 0 ? body.length : comma + 1;
      seg++;
      continue;
    }
    if (eq < 0) break;
    const name = body.slice(i, eq).replace(/^[\s,;]+/, "").trim().toLowerCase();
    const [val, next] = readValue(body, eq + 1, macros);
    if (name) fields[name] = val;
    i = Math.max(next + 1, eq + 1);              // 死循环保险
    seg++;
  }
  return { key, fields };
}

const DEFAULT_MACROS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const NAME_TAGS = ["author", "authors", "editor"];
const JOURNAL_TAGS = ["journal", "journaltitle", "booktitle", "series", "publisher"];
const ABSTRACT_TAGS = ["abstract", "annotation"];

export function parseBibtex(input: string): LiteratureRecord[] {
  const src = String(input ?? "");
  const macros: Record<string, string> = { ...DEFAULT_MACROS };
  const out: LiteratureRecord[] = [];
  let i = 0;

  while (i < src.length) {
    const at = src.indexOf("@", i);
    if (at < 0) break;
    const head = /^@([A-Za-z]+)\s*([{(])/.exec(src.slice(at));
    if (!head) { i = at + 1; continue; }
    const type = head[1].toLowerCase();
    const [body, end] = readBalanced(src, at + head[0].length - 1);
    i = end;

    if (type === "comment" || type === "preamble") continue;   // 注释/导言: 不是文献
    const { fields } = readFields(body, macros);
    if (type === "string") {
      for (const [k, v] of Object.entries(fields)) macros[k.toLowerCase()] = v;
      continue;
    }
    const get = (tags: string[]): string => {
      for (const t of tags) if (fields[t]) return fields[t];
      return "";
    };
    const title = stripLatex(get(["title"]));
    if (!title) continue;                                       // 无标题的条目不是题录
    // 作者之间用 `and` 分隔(BibTeX 的规定), 姓名内部可以有逗号 —— 不能按逗号切
    const authors = splitList(stripLatex(get(NAME_TAGS).replace(/\s+and\s+/gi, "; ")));
    out.push(finish({
      title,
      authors,
      year: parseYear(fields.year || fields.date || fields.y1),
      journal: stripLatex(get(JOURNAL_TAGS)),
      volume: stripLatex(fields.volume ?? ""),
      issue: stripLatex(fields.number ?? fields.issue ?? ""),
      pages: fields.pages ? stripLatex(fields.pages).replace(/\s*--+\s*/, "-") : "",
      doi: fields.doi ?? fields.DOI ?? "",
      abstract: stripLatex(get(ABSTRACT_TAGS)),
      keywords: splitList(stripLatex(fields.keywords ?? fields.keyword ?? "")),
      url: fields.url ?? fields.howpublished ?? "",
      type: bibType(type),
      source: "bibtex",
    }));
  }
  return out;
}

function bibType(t: string): string {
  const map: Record<string, string> = {
    article: "journal-article", inproceedings: "conference-paper", conference: "conference-paper",
    incollection: "book-chapter", inbook: "book-chapter", book: "book", phdthesis: "thesis",
    mastersthesis: "thesis", techreport: "report", misc: "other", unpublished: "preprint",
    proceedings: "conference-paper", online: "other", software: "other", dataset: "other",
  };
  return normalizeType(map[t] ?? t);
}

const KNOWN_ENTRY_TYPES = new Set(["article", "book", "inproceedings", "incollection", "phdthesis",
  "mastersthesis", "techreport", "misc", "unpublished", "conference", "proceedings", "string",
  "comment", "preamble", "inbook", "booklet", "manual", "online", "software", "dataset"]);

export const bibtexParser: FormatParser = {
  id: "bibtex",
  label: "BibTeX",
  score(t: string): number {
    const s = String(t ?? "");
    if (!s) return 0;
    const entries = [...s.matchAll(/@([A-Za-z]+)\s*[{(]/g)].map((m) => m[1].toLowerCase());
    if (entries.length === 0) return 0;
    const known = entries.filter((x) => KNOWN_ENTRY_TYPES.has(x));
    // 认不出任何一个条目类型 → 不是 BibTeX(`@` 在别处也可能是邮箱)
    if (known.length === 0) return 0;
    let score = 45;
    if (/@string\s*[{(]/i.test(s)) score += 10;                 // @string 是 BibTeX 独有的
    if (/^\s*\w+\s*=\s*[{"]/m.test(s)) score += 25;             // `字段 = {值}` 形状
    if (/^\s*\}\s*$/m.test(s)) score += 10;                     // 条目以单独一行的 `}` 收尾
    if (/author\s*=\s*[{"][^}"]*\band\b/i.test(s)) score += 5;  // 作者用 and 分隔
    return Math.min(92, score);
  },
  read: parseBibtex,
};

export default bibtexParser;
