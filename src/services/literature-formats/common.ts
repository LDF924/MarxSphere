// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// literature-formats/common.ts — 题录解析器的公共类型与纯函数
//
// 由来(2026-10-01, 旧项目 AItoolman 的 9 个 read_*_file 移植):
//   本平台此前**只能通过 API 拉文献**(OpenAlex/Crossref/arXiv), 用户手里那堆
//   "从数据库自己导出来的题录文件"无处可去 —— WOS 的 `savedrecs.txt`、知网的 Refworks、
//   EndNote 的 `.enw`、Zotero 的 `.bib`/`.ris`、PubMed 的 MEDLINE……
//   这个目录就是那批文件的落地实现: 一个格式一个文件, 每个文件导出一个 `FormatParser`。
//
// ⚠ 为什么解析器要自带 `score` 而不是让调用方看扩展名:
//   用户拿到的是"从库里导出的一个文件", 扩展名经常是 .txt / .csv / 甚至没有扩展名,
//   同是 .txt, 知网导出与 WOS 导出的内容毫无相似之处。只有看内容才认得出。
//   `score` 是内容特征匹配度(0~100), 由 literature-import-service.detectFormat 择优。
/** 一个格式一个 id; "other" 是兜底(见 other.ts), "auto" 只作为调用方的入参 */
export type FormatId =
  | "wos" | "ris" | "bibtex" | "endnote" | "medline" | "cnki" | "csv"
  | "springer" | "arxiv" | "openalex" | "semanticscholar" | "json" | "other";

/** 归一化后的题录 —— 各格式解析器唯一的输出形状 */
export interface LiteratureRecord {
  title: string;
  authors: string[];
  year?: number;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  abstract?: string;
  keywords?: string[];
  url?: string;
  /** 文献类型(尽量归一, 认不出的原样保留) —— 见 normalizeType */
  type?: string;
  /** 解析它的格式。与"入库到哪个库(source_id)"是两件事 */
  source: FormatId;
}

export interface FormatParser {
  id: FormatId;
  /** 展示名(中文, 给前端下拉用) */
  label: string;
  /** 内容特征匹配度: 0=完全不像, 100=铁证。用于自动识别 */
  score(text: string): number;
  /** 按本格式解析。**约定不抛异常** —— 坏记录跳过即可, 整批不能因一条而失败 */
  read(text: string): LiteratureRecord[];
}

// ─────────────────────────────── 文本工具 ───────────────────────────────

/**
 * 任意值 → 干净的字符串。
 *
 * ⚠ 二进制字节用 GB18030 解码会产出**未配对的代理项**(非法 UTF-16), 而
 *   `String.prototype.trim()` 碰到未配对代理项**不返回字符串而是返回 undefined**
 *   —— 下游 `undefined.length` 直接抛。所以这里统一换掉, 顺便让"是不是二进制"
 *   能被后面的替换字符占比识别出来(见 literature-import-service.decodeBuffer)。
 */
export function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v !== "string") return "";
  // U+FFFD 是"这个字节解不出来"的标记, 不是内容 —— 留着它只会让乱码进库。
  // 剥掉之后, 纯噪声的标题会变成空串, 各解析器既有的"没标题就不算题录"自然把它丢掉。
  return v
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
    .replace(/�/g, "")
    .trim();
}

/** 摘要字段有时是 `{value: "..."}`(Springer/OpenAlex 的不同版本都出现过) */
export function textOrValue(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v)) return text((v as { value?: unknown }).value);
  return text(v);
}

/**
 * 年份: 从任意表达里抠出四位数年份。
 * 收录 `20230501`(数字型日期) —— 正则从左往右匹配, 命中的是前四位而不是中间那截。
 */
export function parseYear(v: unknown): number | undefined {
  const m = /(1[5-9]\d{2}|2[01]\d{2})/.exec(text(v));
  if (!m) return undefined;
  const y = Number(m[1]);
  return y >= 1500 && y <= 2199 ? y : undefined;
}

/**
 * DOI 归一: 去 `doi:` / `https://doi.org/` 前缀与结尾标点。
 * **保留原始大小写** —— DOI 解析本身大小写不敏感, 但作者看到的是稿子里的写法,
 * 归一化只发生在 dedupKey 里。
 */
export function normalizeDoi(v: unknown): string {
  let s = text(v);
  if (!s) return "";
  s = s.replace(/^\s*(?:doi\s*:\s*)?(?:https?:\/\/(?:dx\.)?doi\.org\/)?/i, "");
  s = s.replace(/^doi\s*:\s*/i, "");
  s = s.replace(/[.,;:)\]}>\s]+$/, "");
  return s.trim();
}

/** 归一化标题 —— 只服务于判重, 绝不回写展示字段 */
export function normalizeTitle(t: unknown): string {
  return text(t)
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[.,;:!?'"“”‘’()（）\[\]【】{}<>《》\-–—_/\\|·、，。；：！？…～]/g, "");
}

/**
 * 判重键。DOI 优先 → 全局唯一; 无 DOI 退化为 `title:<归一化标题>|<年>`。
 *
 * 有 DOI 时**刻意不看标题与年份**: 同一篇文献在不同库里题名可能带副标题/大小写不同,
 * 年份可能是印刷年也可能是在线首发年 —— 拿它们参与比较只会把同一篇判成两篇。
 */
export function dedupKey(rec: LiteratureRecord): string {
  const doi = normalizeDoi(rec.doi);
  if (doi) return `doi:${doi.toLowerCase()}`;
  const t = normalizeTitle(rec.title);
  if (!t) return "";
  return `title:${t}|${rec.year ?? ""}`;
}

export function joinPages(from: unknown, to: unknown): string {
  const a = text(from), b = text(to);
  if (a && b && a !== b) return `${a}-${b}`;
  return a || b;
}

/**
 * 列表字段(作者/关键词)切分 —— 只切**明确的分隔符**(`;` `|` 换行 `and`)。
 *
 * ⚠ 逗号**默认不切**: 西文姓名按 `姓, 名` 著录(`Zhang, San`), 一刀切下去会得到
 *   `Zhang` / `San` 两条假作者。多作者又确实可能写成 `张三, 李四` —— 所以由
 *   `authorsOf` 按"切完之后每段是否还像个人名"来判断, 而不是在这里一律切/一律不切。
 */
export function splitList(raw: unknown): string[] {
  return text(raw)
    .split(/[;；|｜\n]+|\s+and\s+/i)
    .map((s) => s.replace(/[;；,，、\s]+$/, "").trim())
    .filter((s) => s.length > 0);
}

/**
 * 作者字段切分 —— 先按形态归一(`authorsFrom`), 再补一层"逗号是不是分隔符"的判断。
 *
 * ⚠ 逗号这一层只能**保守**: `张三, 李四` 是两个人, `Zhang, San` 是一个人 ——
 *   光看逗号分不出来。可用的判据是**每段是不是纯中文名**(2~4 个汉字或含 `·`):
 *   中文名列表切出来必然是这种形状, 而西文 `姓, 名` 里至少有一段是英文。
 *   判不出来就**当一个人**(宁可把 `Smith, John` 留着, 也不要把一个西文姓名拆成两个人)。
 */
export function authorsOf(raw: unknown): string[] {
  const out: string[] = [];
  for (const item of authorsFrom(raw)) {
    if (!/[，,]/.test(item)) { out.push(item); continue; }
    const parts = item.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    const allChineseNames = parts.length > 1 && parts.every((p) => /^[一-龥][一-龥·]{1,3}$/.test(p));
    if (allChineseNames) out.push(...parts);
    else out.push(item);
  }
  return out;
}

/** 中英文文献类型 → 归一词汇表。认不出的原样保留(宁可粗, 不可编) */
const TYPE_MAP: Record<string, string> = {
  "journal article": "journal-article", "journalarticle": "journal-article", "article": "journal-article",
  "journal paper": "journal-article", "期刊论文": "journal-article", "期刊": "journal-article",
  "review": "review", "综述": "review", "review article": "review",
  "conference paper": "conference-paper", "proceedings paper": "conference-paper",
  "conference": "conference-paper", "inproceedings": "conference-paper", "会议论文": "conference-paper",
  "book": "book", "专著": "book", "图书": "book", "monograph": "book",
  "book chapter": "book-chapter", "incollection": "book-chapter", "chapter": "book-chapter", "图书章节": "book-chapter",
  "thesis": "thesis", "phdthesis": "thesis", "mastersthesis": "thesis", "dissertation": "thesis",
  "学位论文": "thesis", "博士论文": "thesis", "硕士论文": "thesis",
  "preprint": "preprint", "posted-content": "preprint", "预印本": "preprint",
  "report": "report", "报告": "report", "techreport": "report",
  "newspaper article": "newspaper-article", "报纸": "newspaper-article",
  "editorial": "editorial", "社论": "editorial",
  "letter": "letter", "信件": "letter",
  "dataset": "other", "misc": "other",
};

export function normalizeType(raw: unknown): string {
  const s = text(raw);
  if (!s) return "";
  const key = s.toLowerCase().replace(/\s+/g, " ").trim();
  return TYPE_MAP[key] ?? TYPE_MAP[key.replace(/\s/g, "")] ?? s;
}

/**
 * 收尾: 去空字段 + 用 DOI 补一个可点链接。
 *
 * 补链接不是编造 —— `https://doi.org/<doi>` 是 DOI 的标准解析地址, 点开就是原文页;
 * 有显式 URL 的格式(arXiv/OpenAlex/知网)各自填了, 这里只补空的。
 */
export function finish(rec: LiteratureRecord): LiteratureRecord {
  const out: LiteratureRecord = { title: text(rec.title), authors: (rec.authors ?? []).map(text).filter(Boolean), source: rec.source };
  if (rec.year !== undefined && Number.isFinite(rec.year)) out.year = rec.year;
  for (const k of ["journal", "volume", "issue", "abstract", "url", "type"] as const) {
    const v = text(rec[k]);
    if (v) out[k] = v;
  }
  // 页码统一成 ASCII 连字符 —— BibTeX 的 `100--110` 会先被 LaTeX 还原成 en dash,
  //   各库又各有 `100~110`/`100—110` 的写法; 展示与比对都该是同一个形状
  const pages = text(rec.pages).replace(/\s*[–—~～‐-―]+\s*/g, "-").replace(/\s+/g, "");
  if (pages) out.pages = pages;
  const doi = normalizeDoi(rec.doi);
  if (doi) out.doi = doi;
  if (rec.keywords && rec.keywords.length) {
    const kw = rec.keywords.map(text).filter(Boolean);
    if (kw.length) out.keywords = kw;
  }
  if (!out.url && out.doi) out.url = `https://doi.org/${out.doi}`;
  return out;
}

/** `TAG value` 行切分(WOS/MEDLINE/Refworks 都长这样, 只是缩进不同) */
export function tagFields(lines: string[], width = 2): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const re = new RegExp(`^([A-Za-z][A-Za-z0-9]{0,${width - 1}})[ \\t](.*)$`);
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const tag = m[1].toUpperCase();
    const val = m[2].trim();
    (out[tag] ??= []).push(val);
  }
  return out;
}

export function firstOf(fields: Record<string, string[]>, ...tags: string[]): string {
  for (const t of tags) {
    const v = fields[t];
    if (v && v.length && v[0]) return v[0];
  }
  return "";
}

// ───────────────────────── 表头别名(CSV 与通用 JSON 共用) ─────────────────────────

export type CanonicalField =
  | "title" | "authors" | "year" | "journal" | "volume" | "issue" | "pages"
  | "doi" | "abstract" | "keywords" | "url" | "type" | "issn" | "language" | "publisher";

/** 把表头/键名压成可比较的形状: 小写、去空格下划线点号、全角转半角 */
export function normalizeKey(h: unknown): string {
  return text(h)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s_\-.]/g, "")
    .toLowerCase();
}

/**
 * 中英文列名别名表 —— 键是 normalizeKey 之后的形状。
 * 覆盖 WOS/知网/万方/维普/Zotero/EndNote 常见的导出列名。
 */
export const FIELD_ALIASES: Record<string, CanonicalField> = {};
function alias(field: CanonicalField, names: string[]): void {
  for (const n of names) FIELD_ALIASES[normalizeKey(n)] = field;
}
alias("title", ["title", "ti", "t1", "题名", "标题", "论文标题", "文献题名", "篇名", "文章标题", "题目", "中文题名", "articletitle", "文献标题", "论文题目"]);
alias("authors", ["author", "authors", "au", "a1", "作者", "作者列表", "全部作者", "第一作者", "责任者", "creator", "creators", "authorfullnames", "作者姓名", "作者名"]);
alias("year", ["year", "py", "y1", "年", "年份", "出版年", "发表年", "出版年份", "publicationyear", "date", "出版日期", "发表日期", "时间", "年卷期"]);
alias("journal", ["journal", "jo", "jf", "ja", "j2", "so", "t2", "期刊", "刊名", "来源", "来源期刊", "期刊名称", "发表期刊", "出版物", "出处", "sourcetitle", "publication", "publicationname", "journalname", "期刊名", "venue", "原文出处"]);
alias("volume", ["volume", "vl", "vol", "卷", "卷号"]);
alias("issue", ["issue", "is", "期", "期号", "number", "no", "期次"]);
alias("pages", ["pages", "page", "pg", "页码", "页", "起止页码", "bp", "sp", "ep", "页数", "pagerange", "页码信息", "起止页"]);
alias("doi", ["doi", "do", "di", "数字对象唯一标识符", "数字对象标识符", "文章编号", "doi号"]);
alias("abstract", ["abstract", "ab", "n2", "摘要", "文摘", "摘要与关键词"]);
alias("keywords", ["keywords", "kw", "de", "id", "关键词", "主题词", "关键字", "中文关键词", "authorkeywords", "关键词中"]);
alias("url", ["url", "ur", "lk", "l1", "link", "链接", "网址", "原文链接", "全文链接", "获取全文", "地址"]);
alias("type", ["type", "dt", "ty", "类型", "文献类型", "资源类型", "documenttype", "itemtype", "文献类型标识"]);
alias("issn", ["issn", "sn", "国际标准刊号", "标准刊号"]);
alias("language", ["language", "la", "语言", "语种"]);
alias("publisher", ["publisher", "pu", "pb", "出版社", "出版者", "出版单位"]);

/** 从任意对象的键里认字段名(通用 JSON 用) */
export function pickByAlias(obj: Record<string, unknown>, field: CanonicalField): unknown {
  if (obj[field] !== undefined) return obj[field];
  for (const [k, v] of Object.entries(obj)) {
    if (FIELD_ALIASES[normalizeKey(k)] === field) return v;
  }
  return undefined;
}

// ───────────────────────── 通用 JSON: 作者/关键词的多形态归一 ─────────────────────────

/**
 * 作者字段的形态**五花八门**(实测各自都出现过):
 *   `"Zhang, San; Li, Si"` / `["Zhang, San", "Li, Si"]` /
 *   `[{name: "Zhang, San"}]` / `[{display_name: "San Zhang"}]` / `[{firstName, lastName}]` /
 *   `[{author: {display_name}}]`(OpenAlex)
 * 这里把它们全归一成字符串数组。
 */
export function authorsFrom(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return splitList(v);
  if (!Array.isArray(v)) return authorsFrom([v]);
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") { out.push(...splitList(item)); continue; }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = text(o.name) || text(o.display_name) || textOrValue(o.author) || text(o.full_name) ||
      text(o.displayName) || text(o.creator);
    if (name) { out.push(name); continue; }
    // {author: {...}} 形态(OpenAlex 的 authorships)
    if (o.author && typeof o.author === "object") {
      const inner = text((o.author as Record<string, unknown>).display_name) || text((o.author as Record<string, unknown>).name);
      if (inner) { out.push(inner); continue; }
    }
    const last = text(o.lastName) || text(o.family) || text(o.surname);
    const first = text(o.firstName) || text(o.given) || text(o.givenName);
    const joined = [last, first].filter(Boolean).join(", ");
    if (joined) out.push(joined);
  }
  return out.filter(Boolean);
}

/** 关键词: `"a; b"` / `["a","b"]` / `[{name:"a"}]` / `{a: [pos...]}`(倒排索引不是关键词) */
export function keywordsFrom(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return splitList(v);
  if (!Array.isArray(v)) {
    // 倒排索引形态(OpenAlex abstract_inverted_index) —— 键是词, 值是位置数组, 不能当关键词
    if (typeof v === "object") return [];
    return [];
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") { out.push(...splitList(item)); continue; }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const name = text(o.name) || text(o.display_name) || text(o.value) || text(o.tag);
      if (name) out.push(name);
    }
  }
  return out.filter(Boolean);
}

/** 页码: 有的 JSON 给 `page: "100-110"`, 有的给 `firstPage`/`lastPage` */
export function pagesFrom(v: unknown, first: unknown, last: unknown): string {
  const direct = textOrValue(v);
  if (direct) return direct.replace(/[–—~～]/g, "-");
  return joinPages(first, last).replace(/[–—~～]/g, "-");
}

/** 期刊: 字符串 / `[{name}]` / `{name}` 三种形态 */
export function venueFrom(v: unknown): string {
  if (Array.isArray(v)) return v.map(venueFrom).filter(Boolean).join("; ");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return text(o.name) || text(o.display_name) || text(o.title) || text(o.publisher);
  }
  return text(v);
}

/** OpenAlex 倒排索引摘要 → 文本(键是词, 值是出现位置) */
export function invertAbstract(inv: unknown): string {
  if (!inv || typeof inv !== "object" || Array.isArray(inv)) return "";
  const pairs: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(inv as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) if (typeof p === "number") pairs.push([p, word]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map((p) => p[1]).join(" ").trim();
}
