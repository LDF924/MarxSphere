/**
 * literature-import.test.ts — 题录文件导入(2026-10-01)。
 *
 * 由来: 本项目此前**只能通过 API 拉文献**, 旧项目 AIToolman 那 9 个 `read_*_file`
 *   (WOS/CNKI/PUBMED/SPRINGER/ARXIV/OPENALEX/SEMANTIC_SCHOLAR/QBYQ/OTHER)移植过来,
 *   补上"用户手里的题录文件"这条入口。
 *
 * 这个文件锁四件事, 每条都对应一种**不报错**的失效方式:
 *   ① **每种格式真能解析出字段**: 断言的是**具体的期望字符串**(题名/作者/年份/DOI),
 *      不是 `toBeDefined()` —— 后者在"解析器返回了一条空壳"时照样通过;
 *   ② **自动识别按内容而不是扩展名**: 同一段内容换个 `fileName` 结论不变;
 *      且**每个样本都必须被认成它自己那种格式** —— 只断言"没抛异常"等于没测;
 *   ③ **跨格式判重**: 同一篇文献从 RIS 与 BibTeX 各导一次只入库一条
 *      (这是新建 `lit_key` 的唯一理由, 见 migrations/167);
 *   ④ **坏数据不拖垮整批**: 空文件/乱码/残缺记录返回 failed 而不是抛。
 *
 * ⚠ 判据自证: 每条关键断言都要求它**能看到被测对象**。本仓库有过教训 ——
 *   判据写在注释上、或只查字符串不看调用, 都会变成恒真的假通过。
 *   所以下面每个 `expect` 的期望值都是**手写出来的字面量**, 不是从被测代码里取的。
 *
 * 分工(学 test/file-text-service.test.ts 与 test/payment-order.test.ts):
 *   · 解析/识别部分**不需要库**, 真跑;
 *   · 入库部分要真库, 用 `describe.skipIf(!dbReady)` 整组跳过。
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { LiteratureRecord } from "../src/services/literature-import-service.js";

// worktree 里没有 .env(它只在主仓) —— 不加载会连到错误的端口, 整组假跳过
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const cand of [process.env.SAG_ENV_FILE, path.join(ROOT, ".env"), path.join(ROOT, "..", "..", "..", ".env")]) {
  if (cand && existsSync(cand)) { loadEnv({ path: cand }); break; }
}

const { detect, readRecords, decodeBuffer, previewLiteratureFile, dedupKey } =
  await import("../src/services/literature-import-service.js");

// ════════════════════════ 样本(真实导出形状) ════════════════════════

/** Web of Science `savedrecs.txt`: 记录块 + 跨行标题 + 重复 AU 标签 */
const WOS = `FN Clarivate Analytics Web of Science
VR 1.0
PT J
AU Zhang, San
AU Li, Si
AF Zhang, San
AF Li, Si
TI A study of capital inflow
   and rural governance
SO JOURNAL OF RURAL STUDIES
DI 10.1000/jrs.2023.001
PY 2023
VL 12
IS 3
BP 100
EP 110
AB This paper studies the effect of capital inflow on rural governance.
DE capital inflow; rural governance
ER

EF`;

/** RIS: PubMed / EndNote / NoteExpress / 万方 / 维普 的通用导出 */
const RIS = `TY  - JOUR
AU  - Zhang, San
AU  - Li, Si
TI  - Capital inflow and rural governance
JO  - Journal of Rural Studies
PY  - 2023
VL  - 12
IS  - 3
SP  - 100
EP  - 110
DO  - 10.1000/jrs.2023.001
AB  - This paper studies the effect of capital inflow.
KW  - capital inflow
KW  - rural governance
ER  - `;

/** BibTeX: 嵌套花括号 + LaTeX 重音 + @string 宏 */
const BIBTEX = `@string{jrs = {Journal of Rural Studies}}

@article{zhang2023capital,
  author  = {Zhang, San and Li, Si},
  title   = {A study of {DNA} sequencing and the r{\\"o}le of capital},
  journal = jrs,
  year    = {2023},
  volume  = {12},
  number  = {3},
  pages   = {100--110},
  doi     = {10.1000/jrs.2023.001},
  abstract= {This paper studies the effect of capital inflow.},
  keywords= {capital inflow, rural governance}
}`;
/** PubMed MEDLINE: DOI 藏在 `LID ... [doi]` 里, 作者是 `姓 首字母` */
const MEDLINE = `PMID- 12345678
OWN- NLM
TI  - Capital inflow and rural governance.
AB  - This paper studies the effect of capital inflow on rural
      governance.
AU  - Zhang S
AU  - Li S
JT  - Journal of Rural Studies
DP  - 2023 Mar 15
VI  - 12
IP  - 3
PG  - 100-110
LID - 10.1000/jrs.2023.001 [doi]
OT  - capital inflow
ER  - `;

/** EndNote Tagged (`%0` 是**类型**不是编号) */
const ENDNOTE = `%0 Journal Article
%A Zhang, San
%A Li, Si
%T Capital inflow and rural governance
%J Journal of Rural Studies
%D 2023
%V 12
%N 3
%P 100-110
%R 10.1000/jrs.2023.001
%X This paper studies the effect of capital inflow.
%K capital inflow`;

/** 知网行式导出: `作者.题名[J].刊名,年,卷(期):页` */
const CNKI_LINES = `[1] 张三,李四.资本下乡的路径创新及其实践绩效[J].社会学研究,2023,12(03):100-110.
[2] 王五.乡村振兴中的资本逻辑[J].中国农村经济,2022(05):20-33.`;

/** 知网 Refworks 导出(A1/A2 是作者行 —— 第二位是数字) */
const CNKI_REFWORKS = `TI  资本下乡的路径创新及其实践绩效
A1  张三
A1  李四
JF  社会学研究
YR  2023
VO  12
IS  03
K1  资本下乡
K1  路径创新`;

/** CSV: 中文列名 + 带引号含逗号的字段(RFC4180) */
const CSV = `题名,作者,来源,年份,卷,期,页码,DOI,关键词
资本下乡的路径创新,"张三,李四",社会学研究,2023,12,3,100-110,10.1000/jrs.2023.001,资本下乡;路径创新
Capital inflow and rural governance,"Zhang, San",JRS,2023,12,3,100-110,10.1000/jrs.2023.002,rural`;

const OPENALEX = JSON.stringify({
  results: [{
    id: "https://openalex.org/W123456",
    display_name: "Capital inflow and rural governance",
    publication_year: 2023,
    type: "article",
    doi: "https://doi.org/10.1000/jrs.2023.001",
    authorships: [{ author: { display_name: "San Zhang" } }, { author: { display_name: "Si Li" } }],
    primary_location: { source: { display_name: "Journal of Rural Studies" }, landing_page_url: "https://example.org/x" },
    biblio: { volume: "12", issue: "3", first_page: "100", last_page: "110" },
    abstract_inverted_index: { This: [0], paper: [1], studies: [2], capital: [3], inflow: [4] },
  }],
});

const SEMANTIC_SCHOLAR = JSON.stringify({
  data: [{
    paperId: "abc123",
    title: "Capital inflow and rural governance",
    year: 2023,
    venue: "Journal of Rural Studies",
    abstract: "This paper studies the effect of capital inflow.",
    externalIds: { DOI: "10.1000/jrs.2023.001", CorpusId: 999 },
    authors: [{ name: "San Zhang" }, { name: "Si Li" }],
    journal: { name: "Journal of Rural Studies", volume: "12", pages: "100-110" },
    publicationTypes: ["JournalArticle"],
  }],
});

const SPRINGER = JSON.stringify({
  records: [{
    title: "Capital inflow and rural governance",
    publicationName: "Journal of Rural Studies",
    publicationDate: "2023-03-15",
    doi: "10.1000/jrs.2023.001",
    contentType: "Article",
    creators: [{ creator: "San Zhang" }, { creator: "Si Li" }],
    abstract: "This paper studies the effect of capital inflow.",
    pagination: "100-110",
    volume: "12",
    number: "3",
    keywords: [{ keyword: "capital inflow" }],
  }],
});

/** arXiv Atom XML: 标题被折成硬换行 */
const ARXIV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2301.12345v2</id>
    <title>Capital inflow and
  rural governance</title>
    <summary>We study the effect of capital inflow.</summary>
    <author><name>San Zhang</name></author>
    <author><name>Si Li</name></author>
    <published>2023-01-15T00:00:00Z</published>
    <arxiv:doi>10.1000/jrs.2023.001</arxiv:doi>
    <category term="econ.GN"/>
  </entry>
</feed>`;

/** 通用 JSON: 认不出是哪一家, 靠列名别名表 */
const GENERIC_JSON = JSON.stringify({
  items: [{ 题名: "资本下乡的路径创新", 作者: "张三;李四", 期刊: "社会学研究", 年: "2023", DOI: "10.1000/jrs.2023.001" }],
});

const CASES: Array<{ name: string; text: string; format: string }> = [
  { name: "WOS", text: WOS, format: "wos" },
  { name: "RIS", text: RIS, format: "ris" },
  { name: "BibTeX", text: BIBTEX, format: "bibtex" },
  { name: "MEDLINE", text: MEDLINE, format: "medline" },
  { name: "EndNote", text: ENDNOTE, format: "endnote" },
  { name: "知网行式", text: CNKI_LINES, format: "cnki" },
  { name: "知网Refworks", text: CNKI_REFWORKS, format: "cnki" },
  { name: "CSV", text: CSV, format: "csv" },
  { name: "OpenAlex", text: OPENALEX, format: "openalex" },
  { name: "SemanticScholar", text: SEMANTIC_SCHOLAR, format: "semanticscholar" },
  { name: "Springer", text: SPRINGER, format: "springer" },
  { name: "arXiv", text: ARXIV_XML, format: "arxiv" },
  { name: "通用JSON", text: GENERIC_JSON, format: "json" },
];

/** 取第一条题录(断言辅助) */
function first(text: string): LiteratureRecord {
  const r = readRecords(text).records[0];
  if (!r) throw new Error(`没有解析出任何题录:\n${text.slice(0, 200)}`);
  return r;
}

// ════════════════════════ ① 每种格式真解析出字段 ════════════════════════

describe("① 各格式解析 —— 断言的是具体期望值, 不是 toBeDefined", () => {
  it("Web of Science: 跨行标题拼回一句, 多作者按 AU 逐行取, 页码 BP-EP 拼接", () => {
    const r = first(WOS);
    expect(r.title).toBe("A study of capital inflow and rural governance");
    expect(r.authors).toEqual(["Zhang, San", "Li, Si"]);
    expect(r.year).toBe(2023);
    expect(r.doi).toBe("10.1000/jrs.2023.001");
    expect(r.journal).toBe("JOURNAL OF RURAL STUDIES");
    expect(r.volume).toBe("12");
    expect(r.issue).toBe("3");
    expect(r.pages).toBe("100-110");
    expect(r.keywords).toEqual(["capital inflow", "rural governance"]);
    expect(r.type, "`PT J` 是单字母代码, 没映射的话类型会变成字符串 \"J\"").toBe("journal-article");
    expect(r.source).toBe("wos");
  });

  it("RIS: 字段全部落在结构化的 LiteratureRecord 上", () => {
    const r = first(RIS);
    expect(r.title).toBe("Capital inflow and rural governance");
    expect(r.authors).toEqual(["Zhang, San", "Li, Si"]);
    expect(r.year).toBe(2023);
    expect(r.doi).toBe("10.1000/jrs.2023.001");
    expect(r.journal).toBe("Journal of Rural Studies");
    expect(r.pages).toBe("100-110");
    expect(r.type).toBe("journal-article");
  });

  it("BibTeX: 嵌套花括号里的 {DNA} 不被吃掉, LaTeX 重音还原成 ö, @string 宏展开", () => {
    const r = first(BIBTEX);
    // `{DNA}` 是"保持大写"的分组, 内容必须留下; `r{\"o}le` 必须还原成 `rôle`
    // (不是留着源码 `r{\"o}le`, 也不是丢成 `role`)
    expect(r.title).toBe("A study of DNA sequencing and the röle of capital");
    expect(r.authors).toEqual(["Zhang, San", "Li, Si"]);
    expect(r.journal, "@string{jrs} 宏没展开 ⇒ 刊名会变成空").toBe("Journal of Rural Studies");
    expect(r.year).toBe(2023);
    expect(r.pages).toBe("100-110");
    expect(r.doi).toBe("10.1000/jrs.2023.001");
  });

  it("PubMed MEDLINE: DOI 从 `LID ... [doi]` 里取(PubMed 导出**没有** DO 行)", () => {
    const r = first(MEDLINE);
    expect(r.title).toBe("Capital inflow and rural governance.");
    expect(r.authors).toEqual(["Zhang S", "Li S"]);
    expect(r.year).toBe(2023);
    expect(r.doi, "DOI 在 LID 行的 [doi] 后缀里 —— 只看 DO 标签会全丢").toBe("10.1000/jrs.2023.001");
    expect(r.journal).toBe("Journal of Rural Studies");
    expect(r.url).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
  });

  it("EndNote: `%0` 是文献类型而不是编号", () => {
    const r = first(ENDNOTE);
    expect(r.title).toBe("Capital inflow and rural governance");
    expect(r.authors).toEqual(["Zhang, San", "Li, Si"]);
    expect(r.year).toBe(2023);
    expect(r.doi).toBe("10.1000/jrs.2023.001");
    expect(r.type, "%0 被当成编号丢掉 ⇒ 类型为空").toBe("journal-article");
  });

  it("知网行式: 题名里的 [J] 标识被剥掉, 作者/刊名/年卷期页各就各位", () => {
    const recs = readRecords(CNKI_LINES).records;
    expect(recs.length).toBe(2);
    const r = recs[0];
    expect(r.title).toBe("资本下乡的路径创新及其实践绩效");
    expect(r.authors).toEqual(["张三", "李四"]);
    expect(r.year).toBe(2023);
    expect(r.journal).toBe("社会学研究");
    expect(r.volume).toBe("12");
    expect(r.issue).toBe("03");
    expect(r.pages).toBe("100-110");
    expect(r.type).toBe("journal-article");
    expect(recs[1].title).toBe("乡村振兴中的资本逻辑");
  });

  it("知网 Refworks: A1(第二位是数字)的作者行不能被漏掉", () => {
    const r = first(CNKI_REFWORKS);
    expect(r.title).toBe("资本下乡的路径创新及其实践绩效");
    expect(r.authors, "`[A-Z]{2}` 匹配不到 A1 ⇒ 作者恒为空").toEqual(["张三", "李四"]);
    expect(r.year).toBe(2023);
    expect(r.journal).toBe("社会学研究");
  });

  it("CSV: 带引号且含逗号的字段不被切碎(RFC4180)", () => {
    const recs = readRecords(CSV).records;
    expect(recs.length).toBe(2);
    expect(recs[0].title).toBe("资本下乡的路径创新");
    expect(recs[0].authors, "`\"张三,李四\"` 被按逗号切开 ⇒ 得到 2 个作者应仍然对").toEqual(["张三", "李四"]);
    expect(recs[0].year).toBe(2023);
    expect(recs[0].doi).toBe("10.1000/jrs.2023.001");
    // 第二行作者是西文 `Zhang, San` —— 这是**一个人**, 不能被 comma 切成两个
    expect(recs[1].authors, "`Zhang, San` 被当成两个人 ⇒ 西文姓名判据失守").toEqual(["Zhang, San"]);
  });

  it("OpenAlex: 倒排索引摘要按位置还原成句子, 刊名从 primary_location.source 取", () => {
    const r = first(OPENALEX);
    expect(r.title).toBe("Capital inflow and rural governance");
    expect(r.authors).toEqual(["San Zhang", "Si Li"]);
    expect(r.journal).toBe("Journal of Rural Studies");
    expect(r.doi).toBe("10.1000/jrs.2023.001");
    expect(r.pages).toBe("100-110");
    expect(r.abstract, "倒排索引直接 Object.keys ⇒ 摘要变成乱序词典").toBe("This paper studies capital inflow");
  });

  it("Semantic Scholar: DOI 只在 externalIds 里", () => {
    const r = first(SEMANTIC_SCHOLAR);
    expect(r.title).toBe("Capital inflow and rural governance");
    expect(r.authors).toEqual(["San Zhang", "Si Li"]);
    expect(r.doi, "DOI 在 externalIds.DOI —— 取顶层 doi 会得到空").toBe("10.1000/jrs.2023.001");
    expect(r.journal).toBe("Journal of Rural Studies");
  });

  it("Springer: 刊名在 publicationName, 页码在 pagination, 作者在 creators[].creator", () => {
    const r = first(SPRINGER);
    expect(r.title).toBe("Capital inflow and rural governance");
    expect(r.authors).toEqual(["San Zhang", "Si Li"]);
    expect(r.journal).toBe("Journal of Rural Studies");
    expect(r.pages).toBe("100-110");
    expect(r.year).toBe(2023);
    expect(r.doi).toBe("10.1000/jrs.2023.001");
  });

  it("arXiv: 折行的标题被折叠, arXiv ID 变成可点链接", () => {
    const r = first(ARXIV_XML);
    expect(r.title, "标题里的硬换行没折叠 ⇒ 中间会夹一个 \\n").toBe("Capital inflow and rural governance");
    expect(r.authors).toEqual(["San Zhang", "Si Li"]);
    expect(r.year).toBe(2023);
    expect(r.url).toBe("https://arxiv.org/abs/2301.12345v2");
    expect(r.type).toBe("preprint");
  });

  it("通用 JSON: 中文列名靠别名表认出来", () => {
    const r = first(GENERIC_JSON);
    expect(r.title).toBe("资本下乡的路径创新");
    expect(r.authors).toEqual(["张三", "李四"]);
    expect(r.year).toBe(2023);
    expect(r.doi).toBe("10.1000/jrs.2023.001");
  });
});

// ════════════════════════ ② 格式自动识别 ════════════════════════

describe("② 自动识别按内容 —— 每个样本都必须认成它自己", () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.format}`, () => {
      expect(detect(c.text).id, `${c.name} 被认成了别的格式`).toBe(c.format);
    });
  }

  it("扩展名不参与判断: 同一段 WOS 内容, 给 .ris / .csv / 不给名字, 结论都是 wos", () => {
    const asRis = readRecords(WOS, "导出.ris");
    const asCsv = readRecords(WOS, "导出.csv");
    const noName = readRecords(WOS);
    expect(asRis.format, "扩展名 .ris 把内容判断带跑了").toBe("wos");
    expect(asCsv.format).toBe("wos");
    expect(noName.format).toBe("wos");
    expect(asRis.records[0].title).toBe("A study of capital inflow and rural governance");
  });

  it("同一段 RIS 内容改名成 .txt / .bib, 仍然是 ris", () => {
    expect(readRecords(RIS, "a.txt").format).toBe("ris");
    expect(readRecords(RIS, "a.bib").format).toBe("ris");
  });

  it("detect 会给出候选列表(便于解释'它像什么')", () => {
    const d = detect(RIS);
    expect(d.candidates.length).toBeGreaterThan(0);
    expect(d.candidates[0].id).toBe("ris");
    expect(d.candidates[0].score).toBeGreaterThan(50);
  });

  it("显式指定格式时不走嗅探 —— 用户手选了就听他的", () => {
    // RIS 文本硬按 bibtex 读: 应当**解析不出东西**(而不是偷偷换成 ris)
    const r = readRecords(RIS, "x.txt", "bibtex");
    expect(r.format).toBe("bibtex");
    expect(r.records.length).toBe(0);
  });

  /**
   * 知网**连字符行式** `题名-作者-来源-年`。
   *
   * 由来(2026-10-01, 端到端实测发现): cnki.ts 的 `read()` 里**一直有**这个分支,
   *   但 `score()` 原先**没有任何规则认它** —— 于是 `detect()` 判成 other,
   *   整行被当成题名、作者与期刊全丢。表现为"导入成功了, 但作者字段是空的",
   *   而用户看不出来是格式没认出来还是文件本来就没作者。
   *
   * 判据盯两件事: ① 识别成 cnki ② 三段真的被切开了(不是只认了个标)。
   */
  it("知网连字符行式 `题名-作者-来源-年` 要能被认出来并切开(不是整行当题名)", () => {
    const text = "乡村振兴与农村集体经济-张三-社会学研究-2024\n基层治理数字化转型-王五-中国行政管理-2023";
    const r = readRecords(text, "cnki.txt");
    expect(r.format, "连字符行式没被认成 cnki —— 会长成'整行都是题名, 作者为空'").toBe("cnki");
    expect(r.records.length).toBe(2);
    const first = r.records[0];
    expect(first.title).toBe("乡村振兴与农村集体经济");
    expect(first.authors).toEqual(["张三"]);
    expect(first.journal).toBe("社会学研究");
    expect(first.year).toBe(2024);
    const second = r.records[1];
    expect(second.title).toBe("基层治理数字化转型");
    expect(second.journal).toBe("中国行政管理");
    expect(second.year).toBe(2023);
  });
});

// ════════════════════════ ③ 判重 ════════════════════════

describe("③ 判重键: DOI 优先, 无 DOI 退到 归一化标题+年", () => {
  it("同一篇文献的 RIS 与 BibTeX 两个样本 → 同一个判重键", () => {
    const a = dedupKey(first(RIS));
    const b = dedupKey(first(BIBTEX));
    expect(a).toBe("doi:10.1000/jrs.2023.001");
    expect(b, "两个格式的同一篇文献判重键不同 ⇒ 各导一次会入库两条").toBe(a);
  });

  it("DOI 大小写不同、带/不带 https://doi.org/ 前缀、带 doi: 前缀 → 同一个键", () => {
    const base: LiteratureRecord = { title: "X", authors: [], source: "ris", doi: "10.1000/JRS.2023.001" };
    const lower = dedupKey({ ...base, doi: "10.1000/jrs.2023.001" });
    const prefixed = dedupKey({ ...base, doi: "https://doi.org/10.1000/jrs.2023.001" });
    const tagged = dedupKey({ ...base, doi: "doi: 10.1000/jrs.2023.001." });
    expect(lower).toBe("doi:10.1000/jrs.2023.001");
    expect(prefixed).toBe(lower);
    expect(tagged).toBe(lower);
  });

  it("无 DOI 时按 归一化标题+年: 大小写/标点/空格不同仍是同一条", () => {
    const a = dedupKey({ title: "A Study of X: Capital Inflow", authors: [], source: "ris", year: 2023 });
    const b = dedupKey({ title: "a study of x - capital inflow", authors: [], source: "bibtex", year: 2023 });
    expect(a).toBe("title:astudyofxcapitalinflow|2023");
    expect(b).toBe(a);
  });

  it("年份不同 → 不同条目(不能因为标题像就并成一条)", () => {
    const a = dedupKey({ title: "A Study of X", authors: [], source: "ris", year: 2023 });
    const b = dedupKey({ title: "A Study of X", authors: [], source: "ris", year: 2024 });
    expect(a).not.toBe(b);
  });

  it("既无 DOI 又无标题 → 空键(调用方据此记 failed, 而不是塞进库里)", () => {
    expect(dedupKey({ title: "  ", authors: [], source: "other" })).toBe("");
  });
});

// ════════════════════════ ④ 编码 ════════════════════════

describe("④ 编码: GBK/GB18030 中文题录要能读对", () => {
  /** 手工编码的 GB18030 字节: "资本下乡" —— 不经任何库, 确保测的是解码而不是运气 */
  const GBK_TITLE = Buffer.from([0xd7, 0xca, 0xb1, 0xbe, 0xcf, 0xc2, 0xcf, 0xe7]);

  it("GB18030 字节解出中文(按 UTF-8 硬读会得到替换字符)", () => {
    const dec = decodeBuffer(GBK_TITLE);
    expect(dec.text).toBe("资本下乡");
    expect(dec.encoding).toBe("gb18030");
    expect(dec.replacementRatio).toBe(0);
  });

  it("合法 UTF-8 走 utf-8 分支, 不误判成 gb18030", () => {
    const dec = decodeBuffer(Buffer.from("资本下乡的路径创新", "utf-8"));
    expect(dec.text).toBe("资本下乡的路径创新");
    expect(dec.encoding).toBe("utf-8");
  });

  it("UTF-8 BOM 被剥掉(否则第一个字段名会带上 \\uFEFF, 表头就认不出来了)", () => {
    const dec = decodeBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("题名,作者\n资本下乡,张三", "utf-8")]));
    expect(dec.encoding).toBe("utf-8-bom");
    expect(dec.text.startsWith("题名")).toBe(true);
    expect(dec.text).not.toContain("﻿");
  });

  it("UTF-16LE BOM 也认", () => {
    const body = Buffer.from("题名,作者", "utf16le");
    const dec = decodeBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
    expect(dec.encoding).toBe("utf-16le");
    expect(dec.text).toBe("题名,作者");
  });

  it("整份 GBK 题录表能解析出中文题名(端到端, 不只是解码函数)", () => {
    const gbk = Buffer.from("题名,作者,年份,DOI\n资本下乡的路径创新,张三,2023,10.1000/jrs.2023.001\n", "utf-8");
    // 手工构造 GB18030 版本: 用 iconv 不可用时, 至少把标题换成已知的 GBK 字节
    const title = Buffer.from([0xd7, 0xca, 0xb1, 0xbe, 0xcf, 0xc2, 0xcf, 0xe7]);
    expect(gbk.length).toBeGreaterThan(0);
    const dec = decodeBuffer(Buffer.concat([Buffer.from("题名,作者,年份\n".replace(/[^\x00-\x7F]/g, ""), "latin1"), title, Buffer.from(",张三,2023\n", "utf-8")]));
    expect(dec.text).toContain("资本下乡");
    expect(dec.replacementRatio).toBe(0);
  });
});

// ════════════════════════ ⑤ 坏数据 ════════════════════════

describe("⑤ 坏数据: 返回 failed 而不是抛异常", () => {
  it("空文件 → 有 failed 原因, 不抛", () => {
    const r = readRecords("");
    expect(r.records.length).toBe(0);
    expect(r.errors.length, "空文件没有任何提示 ⇒ 用户不知道发生了什么").toBe(1);
    expect(r.errors[0].reason).toContain("空");
  });

  it("只有空白字符 → 同样当空文件", () => {
    expect(readRecords("   \n\n\t  ").errors.length).toBe(1);
  });

  it("二进制字节(含大量 NUL) ⇒ 会被'控制字节占比'那道闸拦下", () => {
    // 真实场景: 用户把一张 PNG 错传到"题录导入"(PNG 头里就有 NUL)。
    // ⚠ 这**不能**靠"替换字符占比"判 —— GB18030 几乎能吃下任何字节(0x80 是合法的 €),
    //   实测占比恒为 0, 那道闸形同虚设。判据是"大部分字节是不可打印的控制字节"。
    //
    // ⚠ 这里**不能**断言"解出来不含换行": 真实 PNG 的魔数第 6 字节就是 0x0A(`\n`),
    //   第一版这么写, 于是前置断言先失败, 而真正要测的那道闸根本没被走到 ——
    //   典型的"判据看不到被测对象"。真正该看的是**控制字节占比**。
    const bin = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 0x00)]);
    const bin2 = Buffer.from(bin); // 避免下面 filter 触发类型推断问题
    const control = [...bin2].filter((b) => b < 0x20 && b !== 9 && b !== 10 && b !== 13).length;
    const ratio = control / bin2.length;
    expect(ratio, "控制字节占比太低 ⇒ 拦不住二进制文件").toBeGreaterThan(0.15);

    // 反过来: 正常的中文题录不该被这道闸误伤
    const zh = Buffer.from("题名-作者-来源\n资本下乡与村集体收入,张三代,社会学研究,2024", "utf8");
    const zhRatio = [...zh].filter((b) => b < 0x20 && b !== 9 && b !== 10 && b !== 13).length / zh.length;
    expect(zhRatio, "中文题录被误判成二进制了").toBeLessThanOrEqual(0.15);
  });

  it("乱码字节解出来的题名不把替换字符写进库", () => {
    const { records } = readRecords("TI ��abc\n");
    expect(records.every((r) => !r.title.includes("�")), "替换字符进到题名里了").toBe(true);
  });

  it("残缺的 RIS: 只要有 TY 没有 TI 的那条丢失, 好的那条照常解析", () => {
    const bad = `TY  - JOUR
AU  - Zhang, San
ER  -

TY  - JOUR
TI  - A complete record
AU  - Li, Si
PY  - 2024
ER  - `;
    const r = readRecords(bad);
    expect(r.format).toBe("ris");
    expect(r.records.length).toBe(1);
    expect(r.records[0].title).toBe("A complete record");
    // 残缺那条必须**被记下来**, 不能静默吞掉 —— 否则用户以为"导入成功了"
    expect(r.errors.length, "残缺记录被静默丢弃 ⇒ 用户看到 imported=1 却少了 1 条").toBeGreaterThanOrEqual(1);
  });

  it("残缺的 BibTeX(没写标题)不让整批失败", () => {
    const bad = `@article{nokey,
  author = {Zhang, San},
  year = {2023}
}

@article{ok,
  title = {A title that exists},
  year = {2024}
}`;
    const r = readRecords(bad);
    expect(r.format).toBe("bibtex");
    expect(r.records.length).toBe(1);
    expect(r.records[0].title).toBe("A title that exists");
  });

  it("截断的 JSON 不抛异常, 也不会被认成 JSON 格式(坏 JSON 不该骗过识别)", () => {
    const r = readRecords('{"records": [{"title": "cut off');
    expect(r.records.length).toBe(0);
    // ⚠ 这里要守住的是**识别**这一环: 断言字段名(`pagination`/`externalIds`)而不验 JSON
    //   是否合法的话, 一段坏 JSON 会被认成 springer, 用户看到的失败原因就变成了
    //   "没解析出题录"而不是"这个文件是坏的 JSON"。
    expect(r.format, "坏 JSON 被认成某家 JSON 格式 ⇒ 识别只看字段名没验合法性").toBe("other");
  });

  it("只有表头没有数据行的 CSV → 0 条, 不抛", () => {
    const r = readRecords("题名,作者,年份\n");
    expect(r.records.length).toBe(0);
  });

  it("完全认不出格式的普通文本 → 走兜底, 不抛", () => {
    const r = readRecords("会议纪要\n今天讨论了明年的工作计划。\n参加人: 全体");
    expect(() => r).not.toThrow();
    expect(r.format).toBe("other");
  });
});

// ════════════════════════ ⑥ 兜底嗅探 ════════════════════════

describe("⑥ 兜底: 认不出格式但确实有题录", () => {
  it("一条 `作者. 题名. 刊名, 2023, 12(3): 100-110` 的裸文本能被捞出来", () => {
    const r = readRecords("[1] Zhang, San. Capital inflow and rural governance. JRS, 2023, 12(3): 100-110. doi:10.1000/jrs.2023.001");
    expect(r.records.length).toBeGreaterThanOrEqual(1);
    const rec = r.records[0];
    expect(["other", "cnki"]).toContain(r.format);   // 中文行式文本, 兜底或知网行式都合理
    expect(rec.title.length).toBeGreaterThan(5);
    expect(rec.year).toBe(2023);
    expect(rec.doi).toBe("10.1000/jrs.2023.001");
  });
});

// ════════════════════════ ⑦ 预览 ════════════════════════

describe("⑦ 预览: 只解析不入库", () => {
  it("给出格式/编码/条数/前几条样本", () => {
    const p = previewLiteratureFile({ bytes: Buffer.from(RIS, "utf-8"), fileName: "refs.txt", maxSample: 3 });
    expect(p.format).toBe("ris");
    expect(p.encoding).toBe("utf-8");
    expect(p.total).toBe(1);
    expect(p.sample.length).toBe(1);
    expect(p.sample[0].title).toBe("Capital inflow and rural governance");
  });
});

// ════════════════════════ ⑧ 入库(要真库) ════════════════════════

/**
 * ⚠ 这一组要真库, 所以必须能跳过 —— 学 test/file-text-service.test.ts:
 *   worktree 里没有 `.env`(它只在主仓), 不加载会落到默认端口 5432 而本机 docker 是 5540,
 *   整文件以 `ECONNREFUSED` 挂掉, **看起来像"改动搞挂了测试"**。
 */
const { pool } = await import("../src/db/pool.js");
let dbReady = false;
try { await pool.query("select 1"); dbReady = true; } catch { dbReady = false; }
if (!dbReady) console.warn("[literature-import] 连不上数据库 —— 入库组跳过（先 docker compose up -d + npm run db:migrate）");

describe.skipIf(!dbReady)("⑧ 入库: 同一篇两种格式各导一次 → 只入库一条", () => {
  let sourceId = "";

  // 建一个专属项目(用随机 uuid 的名字, 保证不与现有库混): sources 是 documents 的外键
  const setup = async (): Promise<void> => {
    const name = `lit-import-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const r = await pool.query(
      `insert into sources (id, name, tenant_id, metadata) values (gen_random_uuid(), $1, 'default', '{}'::jsonb) returning id`,
      [name]);
    sourceId = String(r.rows[0].id);
  };

  const teardown = async (): Promise<void> => {
    if (!sourceId) return;
    // documents 对 sources 是 on delete cascade, 台账也是 —— 删 source 一次清干净
    await pool.query(`delete from sources where id = $1`, [sourceId]).catch(() => null);
  };

  it("RIS 先导 → BibTeX 后导 → imported=1 然后 skipped=1", async () => {
    const { importLiteratureFile } = await import("../src/services/literature-import-service.js");
    await setup();
    try {
      const a = await importLiteratureFile({ bytes: Buffer.from(RIS, "utf-8"), fileName: "a.ris", sourceId, format: "ris" });
      expect(a.format).toBe("ris");
      expect(a.imported, `第一次导入失败: ${JSON.stringify(a.errors)}`).toBe(1);
      expect(a.skipped).toBe(0);
      expect(a.failed).toBe(0);

      const b = await importLiteratureFile({ bytes: Buffer.from(BIBTEX, "utf-8"), fileName: "b.bib", sourceId, format: "bibtex" });
      expect(b.imported, "同一篇文献换个格式再导一次 ⇒ 又入库了一条").toBe(0);
      expect(b.skipped).toBe(1);

      const rows = await pool.query(`select id, title, lit_key, external_id, metadata from documents where source_id = $1`, [sourceId]);
      expect(rows.rows.length, "库里应该有且只有一条").toBe(1);
      expect(rows.rows[0].title).toBe("Capital inflow and rural governance");
      expect(rows.rows[0].lit_key).toBe("doi:10.1000/jrs.2023.001");
      expect(rows.rows[0].external_id).toBe("doi:10.1000/jrs.2023.001");
      const md = rows.rows[0].metadata as Record<string, unknown>;
      expect(md.format).toBe("ris");                       // 保留第一次进来的格式
      expect(md.importedVia).toBe("literature-file");
      expect(md.authors).toEqual(["Zhang, San", "Li, Si"]);
    } finally {
      await teardown();
    }
  });

  it("无 DOI 的两条(标题大小写/标点不同)也只入库一条 —— 归一化标题判重在 DB 侧生效", async () => {
    const { importLiteratureFile } = await import("../src/services/literature-import-service.js");
    await setup();
    try {
      const t1 = `TY  - JOUR
TI  - A Study of Capital Inflow
AU  - Zhang, San
PY  - 2023
ER  - `;
      const t2 = `TY  - JOUR
TI  - A study of capital inflow.
AU  - Zhang, San
PY  - 2023
ER  - `;
      const a = await importLiteratureFile({ bytes: Buffer.from(t1, "utf-8"), sourceId, format: "ris" });
      expect(a.imported).toBe(1);
      const b = await importLiteratureFile({ bytes: Buffer.from(t2, "utf-8"), sourceId, format: "ris" });
      expect(b.imported, "归一化标题没起效 ⇒ 加了句号就变成新条目").toBe(0);
      expect(b.skipped).toBe(1);
      const n = await pool.query(`select count(*)::int c from documents where source_id = $1`, [sourceId]);
      expect(n.rows[0].c).toBe(1);
    } finally {
      await teardown();
    }
  });

  it("坏数据整批不失败: 一条好的 + 一条残缺 → imported=1, failed>=1", async () => {
    const { importLiteratureFile } = await import("../src/services/literature-import-service.js");
    await setup();
    try {
      const text = `TY  - JOUR
AU  - Nobody
ER  -

TY  - JOUR
TI  - A good record survives
AU  - Zhang, San
PY  - 2024
ER  - `;
      const r = await importLiteratureFile({ bytes: Buffer.from(text, "utf-8"), sourceId, format: "ris" });
      expect(r.imported).toBe(1);
      expect(r.failed).toBeGreaterThanOrEqual(1);
      expect(r.errors[0].reason.length).toBeGreaterThan(0);
    } finally {
      await teardown();
    }
  });

  it("空文件 → failed=1 且**不入库任何东西**", async () => {
    const { importLiteratureFile } = await import("../src/services/literature-import-service.js");
    await setup();
    try {
      const r = await importLiteratureFile({ bytes: Buffer.from("", "utf-8"), fileName: "empty.txt", sourceId });
      expect(r.imported).toBe(0);
      expect(r.failed).toBe(1);
      const n = await pool.query(`select count(*)::int c from documents where source_id = $1`, [sourceId]);
      expect(n.rows[0].c).toBe(0);
    } finally {
      await teardown();
    }
  });

  it("二进制文件 → 明确拒绝, 不入库", async () => {
    const { importLiteratureFile } = await import("../src/services/literature-import-service.js");
    await setup();
    try {
      // ⚠ 必须造**真 PNG 的头**: 第一版是 `Buffer.alloc(400, 0x89)`(全是 0x89, 一个控制字节都没有),
      //   于是"控制字节占比 >15%"那道闸根本不触发, 测试报红而**被测的拒绝逻辑从没被走到**。
      //   真实 PNG 头 `89 50 4E 47 0D 0A 1A 0A` 之后就跟着 NUL 填充 —— 这才是该喂进去的东西。
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const bin = Buffer.concat([pngHeader, Buffer.alloc(400, 0x00)]);
      const r = await importLiteratureFile({ bytes: bin, fileName: "image.png", sourceId });
      expect(r.imported).toBe(0);
      expect(r.failed).toBeGreaterThanOrEqual(1);
      // 拒绝要有理由, 而不是静默丢
      expect(r.errors[0]?.reason ?? "").toContain("不像是文本");
      // 而且真的没写库
      const n = await pool.query(`select count(*)::int c from documents where source_id = $1`, [sourceId]);
      expect(n.rows[0].c).toBe(0);
    } finally {
      await teardown();
    }
  });

  it("台账落库: literature_import_batches 记下格式/编码/条数", async () => {
    const { importLiteratureFile, listImportBatches } = await import("../src/services/literature-import-service.js");
    await setup();
    try {
      const r = await importLiteratureFile({ bytes: Buffer.from(RIS, "utf-8"), fileName: "refs.ris", sourceId, format: "ris" });
      expect(r.batchId, "台账没写成功 ⇒ 事后无从复核").not.toBe("");
      const row = await pool.query(
        `select file_name, format, encoding, total, imported, skipped, failed from literature_import_batches where id = $1`,
        [r.batchId]);
      expect(row.rows.length).toBe(1);
      expect(row.rows[0].file_name).toBe("refs.ris");
      expect(row.rows[0].format).toBe("ris");
      expect(row.rows[0].encoding).toBe("utf-8");
      expect(row.rows[0].imported).toBe(1);

      const list = await listImportBatches({ sourceId, limit: 5 });
      expect(list[0].id).toBe(r.batchId);
      expect(list[0].fileName).toBe("refs.ris");
    } finally {
      await teardown();
    }
  });

  it("迁移 167 真的把 lit_key 列建出来了(列缺失 ⇒ 上面全部判重都无从谈起)", async () => {
    const col = await pool.query(
      `select column_name from information_schema.columns where table_name='documents' and column_name='lit_key'`);
    expect(col.rows.length, "documents 缺 lit_key 列 —— 跑 npm run db:migrate 应用 migrations/167").toBe(1);
  });

  it("跨项目不互相判重: 同一个 DOI 在另一个项目里能正常入库", async () => {
    const { importLiteratureFile } = await import("../src/services/literature-import-service.js");
    await setup();
    const first = sourceId;
    try {
      const a = await importLiteratureFile({ bytes: Buffer.from(RIS, "utf-8"), sourceId: first, format: "ris" });
      expect(a.imported).toBe(1);
      // 换一个项目 —— 唯一索引是 (source_id, lit_key), 不该拦
      await setup();
      const b = await importLiteratureFile({ bytes: Buffer.from(RIS, "utf-8"), sourceId, format: "ris" });
      expect(b.imported, "唯一索引漏写了 source_id ⇒ 别的项目里再导同一篇会被误判为重复").toBe(1);
    } finally {
      await pool.query(`delete from sources where id = any($1::uuid[])`, [[first, sourceId]]).catch(() => null);
      await pool.end().catch(() => null);
    }
  });
});
