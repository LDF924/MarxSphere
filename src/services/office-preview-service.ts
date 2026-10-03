// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// office-preview-service.ts — Office/图形文件的结构化预览(2026-10-02)
//
// 由来(对照 Respal 的文件预览): 本仓此前对 Office 只有"抽纯文本"这一条路 ——
//   `file-text-service` 把 pptx 抽成 "[Slide 3]\n标题\n正文" 的字符串, 前端拿到的是
//   一大坨文本, 分不出哪行是标题哪行是正文; drawio 更是全仓零实现。
//   于是"点开看一眼"这个动作对 Office 文件根本不成立, 用户只能下载。
//
// ═══ 为什么在**服务端**解析, 而不是前端 unzip ═══
//   ① pptx/drawio 都是 zip, 浏览器侧要么引 jszip(已有依赖但新增前端包体), 要么走
//      File System Access API(兼容性差);
//   ② 更重要的是**这份解析结果可以缓存/复用**: 对话里的 attachment_read、资料库预览、
//      审稿取正文是同一个问题, 各写一份 XML 解析必然漂移。
//   jszip 已是既有依赖(package.json:105), 不新增任何包。
//
// ═══ XML 解析: 正则 vs 解析器 ═══
//   选正则, 因为要取的东西结构极浅且固定:
//     · a:p 段落 / a:t 文本运行 / a:tbl 表格行单元格
//     · mxCell 的 value + style(判断形状/边)
//   装一个 XML 解析器(几十 KB + 命名空间要自己处理)换这几个模式不值得。
//   ⚠ 代价必须说清: 这只对**我们自己抽出来的、结构良好的** OOXML 有效。
//     若哪天要读批注、图表、SmartArt, 就该换成真解析器, 而不是继续加正则。
import JSZip from "jszip";
import { inflateRawSync } from "node:zlib";

/** pptx 一页 */
export interface SlidePreview {
  index: number;
  /** 标题占位符里的文字(拿不到就空) */
  title: string;
  /** 该页全部段落(不含标题, 标题已在 title 里) */
  lines: string[];
  /** 该页的表格(每张表 = 二维字符串) */
  tables: string[][][];
  hasNotes: boolean;
}

/** 把 XML 里的文本节点解出来 —— OOXML 会把 & < > 写成实体, 不解会让正文里出现 &amp; */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    // & 必须最后解 —— 先解它会把 &amp;lt; 变成 <(双重解码)
    .replace(/&amp;/g, "&");
}

/** 一段 `<a:p>` → 纯文本(把该段里所有 `<a:t>` 拼起来) */
function paraText(pXml: string): string {
  const runs = [...pXml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1]));
  return runs.join("").trim();
}

/** 一张 `<a:tbl>` → 二维数组 */
function tableRows(tblXml: string): string[][] {
  return [...tblXml.matchAll(/<a:tr[\s>][\s\S]*?<\/a:tr>/g)].map((tr) =>
    [...tr[0].matchAll(/<a:tc[\s>][\s\S]*?<\/a:tc>/g)].map((tc) => paraText(tc[0]))
  );
}

/**
 * pptx → 逐页结构。
 *
 * 页序必须按**文件名里的数字**排, 不能按 zip 条目顺序 ——
 * 实测 zip 里的顺序是 `slide1, slide10, slide11, …, slide2`, 直接遍历会把第 10 页
 * 排到第 2 页前面(纯文本抽取那条路就是这么错的, 只是输出成一坨看不出来)。
 */
export async function readPptx(buf: Buffer): Promise<{ ok: true; slides: SlidePreview[] } | { ok: false; error: string }> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    if (!names.length) return { ok: false, error: "这份 .pptx 里没有幻灯片(可能只是模板或已损坏)" };
    names.sort((a, b) => (Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1])));

    const slides: SlidePreview[] = [];
    for (const name of names) {
      const idx = Number(name.match(/(\d+)/)![1]);
      const xml = await zip.files[name].async("string");
      // 表格先从 XML 里摘掉再抽段落, 否则表格文字会**同时**出现在 lines 与 tables 里
      const tables = [...xml.matchAll(/<a:tbl>[\s\S]*?<\/a:tbl>/g)].map((m) => tableRows(m[0]));
      const withoutTables = xml.replace(/<a:tbl>[\s\S]*?<\/a:tbl>/g, "");
      // 标题占位符: <p:sp> 里带 type="title" 或 "ctrTitle" 的那个
      let title = "";
      for (const sp of withoutTables.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
        const typeMatch = /<p:ph[^>]*type="(title|ctrTitle)"/.exec(sp[0]);
        if (!typeMatch) continue;
        title = paraText(sp[0]);
        if (title) break;
      }
      const lines = [...withoutTables.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)]
        .map((m) => paraText(m[0]))
        .filter((t) => t && t !== title);
      // 备注页是独立条目, 内容常为空 —— 只在真有文字时才算
      const notesName = `ppt/notesSlides/notesSlide${idx}.xml`;
      let hasNotes = false;
      if (zip.files[notesName]) {
        const notesXml = await zip.files[notesName].async("string");
        // 备注页里有个固定占位(幻灯片编号)总是非空, 要排掉它再判
        const notesText = [...notesXml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)]
          .map((m) => paraText(m[0]))
          .filter((t) => t && !/^\d+$/.test(t))
          .join("");
        hasNotes = notesText.length > 0;
      }
      slides.push({ index: idx, title, lines, tables, hasNotes });
    }
    return { ok: true, slides };
  } catch (e) {
    return { ok: false, error: `PPT 解析失败: ${String((e as Error).message).slice(0, 160)}` };
  }
}

// ═══════════════════════════════════════════════════════════════
// Word(.docx / .doc)
// ═══════════════════════════════════════════════════════════════
//
// 由来(2026-10-03 用户: 「.docx、.doc 无法读取和显现出来进行查看」—— 实测属实且是**两条不同的断链**):
//
//   · **.docx**: 数据一直在。`/api/vault/file` 对 .docx 回 200(走 mammoth 那条路),
//     但**前端预览器把 docx 当纯文本渲染** —— VaultFilePreview 直接 `MarkdownReader(content)`,
//     content 是未渲染的 HTML 源码, 用户在预览里看到的是 `<p>正文</p>` 这样的标签。
//     `/api/preview/parse` 更直接: 它对 docx 回 400 "预览解析不支持 .docx"。
//   · **.doc**: 全链路都写着"请另存为 .docx"(file-text-service:117、editor 导入路由),
//     于是老 .doc **一处都看不了**。而用户资料库里 .doc 比 .docx 还多 ——
//     那些是结题报告书、申报书这类格式固定的公文, 恰恰最需要"点开看一眼"。
//
// 现在: .docx 走这里的 `readDocx`(OOXML → HTML), .doc 走 `readLegacyDoc`
// (OLE 复合文档 → 按段落折行的纯文本, word-extractor, MIT)。

/**
 * .docx 的 XML 实体解码。
 *
 * ⚠ `&` **必须最后解** —— 先解会把 `&amp;lt;` 变成 `<`(双重解码),
 *   正文里一个真实的 "&lt;" 会被吃成尖括号。
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 一个 OOXML 文本节点的内容(`<w:t>` 里的字) */
function runText(chunk: string): string {
  return [...chunk.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((m) => decodeXmlEntities(m[1]))
    .join("");
}

/** 段落属性里是不是"加粗/斜体" —— 值是 `1`/`true` 都算, `0`/`false` 不算 */
function flagOn(attrs: string, name: string): boolean {
  const m = new RegExp(`<w:${name}\\b([^>]*)/?>`).exec(attrs);
  if (!m) return false;
  const v = /\bw:val="([^"]*)"/.exec(m[1])?.[1];
  return v !== "0" && v !== "false";
}

/**
 * 一个 `<w:p>` → 一行 HTML。
 *
 * ⚠ 只认**段落级样式**(标题/正文/列表)与**行内粗斜体**, 不认: 字号、颜色、字体、
 *   页眉页脚、脚注、批注、文本框、SmartArt、图表。
 *   取舍理由: 预览要回答的是"这份文件里写了什么", 不是"排版是否还原" ——
 *   要还原排版就该用 Word 打开。**不假装全支持**: 前端面板上如实写着这是"内容预览"。
 *   将来若要还原版式, 应当换成真渲染器(mammoth 的 styleMap 或 LibreOffice 转换),
 *   而不是在这里继续加正则 —— 与 pptx 那条注释同一个判断。
 */
function paragraphToHtml(pXml: string): string {
  // 标题: w:pStyle 的值形如 Heading1 / 1 / 标题1
  const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(pXml)?.[1] ?? "";
  const headingLevel = /^(?:Heading|heading)([1-6])$/.exec(style)?.[1]
    ?? /^([1-6])$/.exec(style)?.[1]
    ?? /^标题([1-6])$/.exec(style)?.[1];

  // 行内: 按 run 走, 每个 run 自己判粗斜体
  let inner = "";
  for (const r of pXml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
    const t = runText(r[0]);
    if (!t) continue;
    const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(r[0])?.[1] ?? "";
    let frag = t.replace(/\s+$/, "");
    if (flagOn(rPr, "b")) frag = `<strong>${frag}</strong>`;
    if (flagOn(rPr, "i")) frag = `<em>${frag}</em>`;
    inner += frag;
  }
  if (!inner.trim()) return "";
  const isList = /<w:numPr>/.test(pXml);
  if (headingLevel) return `<h${headingLevel}>${inner}</h${headingLevel}>`;
  if (isList) return `<p class="docx-li">· ${inner}</p>`;
  return `<p>${inner}</p>`;
}

/** 一张 `<w:tbl>` → HTML 表格(逐行逐格, 每格再递归解析它自己的段落) */
function tableToHtml(tblXml: string): string {
  const rows: string[] = [];
  for (const tr of tblXml.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)) {
    const cells: string[] = [];
    for (const tc of tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)) {
      const cell = [...tc[0].matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)]
        .map((m) => paragraphToHtml(m[0]))
        .join(" ")
        // 单元格里再套 <p> 会让表格被撑得很高, 并成行内
        .replace(/^<p>|<\/p>$/g, "");
      cells.push(`<td>${cell}</td>`);
    }
    if (cells.length) rows.push(`<tr>${cells.join("")}</tr>`);
  }
  return rows.length ? `<table>${rows.join("")}</table>` : "";
}

/**
 * .docx → HTML。
 *
 * 用 JSZip 自己解、自己拼 HTML, 而**不是**引 mammoth 到浏览器:
 *   · mammoth 的默认输出带自己的内联样式(字号/颜色写死), 本应用是深色主题,
 *     那些写死的色值会把正文变成看不清的深灰 —— 而我们要的恰好是**不带颜色**的结构化 HTML
 *     (颜色交给所在主题的 CSS)。
 *   · 服务端已有 mammoth 那条路(编辑器导入 / 纯文本抽取), 那是给 TipTap 与 LLM 用的,
 *     与"预览要一份可主题化的结构"是两件事。
 */
export async function readDocx(buf: Buffer): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const doc = zip.files["word/document.xml"];
    if (!doc) {
      // 极少见: 有些生成器把主文档放在别处。给一个能自证的错, 而不是空 HTML
      return { ok: false, error: "这份 .docx 里没有 word/document.xml —— 可能不是 OOXML 文档" };
    }
    const xml = await doc.async("string");
    const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;

    // ⚠ 表格**不能**先摘出去再补回末尾(我第一版就是那么写的): 表格在正文里的**位置**是有意义的,
    //   把三张表统统挪到文末, 读者看到的是"正文 + 一堆不知道插在哪的表"。
    //   正确做法是按文档顺序**同步扫**段落与表格 —— 两者在 w:body 里本来就是平级的兄弟节点。
    const parts: string[] = [];
    const blocks = /<w:(p|tbl)(?:\s[^>]*)?>[\s\S]*?<\/w:\1>/g;
    for (const m of body.matchAll(blocks)) {
      const html = m[1] === "tbl" ? tableToHtml(m[0]) : paragraphToHtml(m[0]);
      if (html) parts.push(html);
    }
    const html = parts.join("\n");
    if (!html.trim()) return { ok: false, error: "这份 .docx 没有提取到正文(可能是空文档或只有图片)" };
    return { ok: true, html };
  } catch (e) {
    return { ok: false, error: `Word 解析失败: ${String((e as Error).message).slice(0, 160)}` };
  }
}

/**
 * 旧版 .doc(OLE 复合文档)→ 纯文本。
 *
 * 为什么能做: `word-extractor`(MIT, 依赖 saxes + yauzl, 纯 JS 无原生模块)直接读
 *   Word 97-2003 的二进制流并把正文、脚注、页眉分开取。
 * 为什么以前不做: 改前全链路写的是"请另存为 .docx" —— 那是把解析器的短板转嫁给用户,
 *   而用户资料库里 .doc 比 .docx 还多(结题报告书/申报书这类公文模板至今仍是 .doc)。
 *
 * ⚠ 这条只出**纯文本**: .doc 的样式信息藏在二进制格式里, 要还原排版得靠 LibreOffice 转档,
 *   本机与环境都不一定有。前端把它当文本渲染, 并如实标注"旧版 .doc 仅提取正文,
 *   版式不还原" —— 比"打不开"和"假装打开"都好。
 */
export async function readLegacyDoc(buf: Buffer): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  // word-extractor 只吃**磁盘路径**(它内部按随机访问读文件), 所以必须先落一个临时文件
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const tmp = path.join(os.tmpdir(), `sag-doc-${Date.now()}-${Math.random().toString(36).slice(2)}.doc`);
  try {
    fs.writeFileSync(tmp, buf);
    const WordExtractor = (await import("word-extractor")).default;
    const d = await new WordExtractor().extract(tmp);
    const parts = [
      String(d.getHeaders?.() ?? "").trim(),
      String(d.getBody?.() ?? "").trim(),
      String(d.getFootnotes?.() ?? "").trim(),
    ].filter(Boolean);
    const text = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return { ok: false, error: "这份 .doc 没有提取到正文(可能是空文档或纯图片文档)" };
    return { ok: true, text };
  } catch (e) {
    // ⚠ word-extractor 的报错是英文短句("Unable to read this type of file"), 直接透出去
    //   用户只看到一行看不懂的英文。这里按**已知的那两种**翻译, 其余原样带出 ——
    //   不认识的错不能硬套模板(那会把"磁盘满了"说成"文件损坏")。
    const raw = String((e as Error)?.message ?? e).slice(0, 160);
    const msg = /Unable to read this type of file|not a (valid )?(OLE|compound|word)/i.test(raw)
      ? "这个 .doc 不是 Word 97-2003 格式(可能被改过扩展名, 或其实是 RTF/HTML 伪装成 .doc)"
      : raw;
    return { ok: false, error: `.doc 解析失败: ${msg}` };
  } finally {
    // 临时文件必须删 —— 它在系统 temp 里, 不删会随着每次预览堆积(正文可能含敏感内容)
    try { fs.unlinkSync(tmp); } catch { /* 删不掉不该盖住真正的结果 */ }
  }
}

export interface DrawioShape {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 边(连线)而不是节点 */
  isEdge: boolean;
  /** 源/目标 —— 只有边有 */
  source?: string;
  target?: string;
  /** 原始 style 串, 前端可据此上色(不去猜语义) */
  style: string;
}

/**
 * drawio → 形状表 + 画布尺寸。
 *
 * ⚠ 几何只认**绝对坐标**, 不认相对父子定位(容器/分组用 parent + 相对 x/y)。
 *   本仓的 drawio 产出(技能里的模板)都是平铺的绝对坐标, 所以够用;
 *   若以后要支持嵌套容器, 这里必须补父子坐标累加 —— 否则子形状会全部堆在左上角。
 *
 * ⚠ 多页(.drawio 可以有多个 `<diagram>`)**会被合并成一张图** —— 形状各自带 id,
 *   但不同页的 id 可能重名。本仓的产出都是单页, 所以先不为多页设计。
 */
export function readDrawio(rawXml: string): { ok: true; shapes: DrawioShape[]; pageWidth: number; pageHeight: number; compressed: boolean } | { ok: false; error: string } {
  try {
    const { xml, compressed } = maybeInflate(rawXml);
    const shapes: DrawioShape[] = [];
    for (const m of xml.matchAll(/<mxCell\b([^>]*?)\/?>/g)) {
      const attrs = m[1];
      const get = (k: string) => {
        const r = new RegExp(`\\b${k}="([^"]*)"`).exec(attrs);
        return r ? unescapeXml(r[1]) : "";
      };
      const id = get("id");
      if (!id || id === "0" || id === "1") continue; // 0/1 是 drawio 的两个根节点, 不是图形
      const style = get("style");
      const isEdge = get("edge") === "1" || /(^|;)(edgeStyle|endArrow)=/.test(style);
      // geometry 紧跟在自己的 mxCell 后面 —— 只在这个 cell 自身的片段里找,
      // 不能用"从 m.index 往后 2000 字符"(相邻 cell 的 geometry 会被误取)
      const tail = xml.slice(m.index ?? 0);
      const nextCell = tail.indexOf("<mxCell", 1);
      const seg = nextCell > 0 ? tail.slice(0, nextCell) : tail;
      const geo = /<mxGeometry\b([^>]*)>/.exec(seg) ?? /<mxGeometry\b([^>]*)\/>/.exec(seg);
      const geoAttrs = geo ? geo[1] : "";
      const num = (k: string) => {
        const r = new RegExp(`\\b${k}="(-?[\\d.]+)"`).exec(geoAttrs);
        return r ? Number(r[1]) : 0;
      };
      // 边的 x/y/w/h 是相对偏移, 画布上用不上 —— 统一给 0, 由 source/target 决定位置
      shapes.push({
        id,
        text: get("value"),
        x: isEdge ? 0 : num("x"),
        y: isEdge ? 0 : num("y"),
        w: isEdge ? 0 : num("width"),
        h: isEdge ? 0 : num("height"),
        isEdge,
        source: get("source") || undefined,
        target: get("target") || undefined,
        style,
      });
    }
    if (!shapes.length) {
      return { ok: false, error: "这个文件里没有解析出任何图形 —— 请确认是 drawio 的 XML(而非导出的 png/svg)。" };
    }
    const pageW = /<mxGraphModel[^>]*\bpageWidth="([\d.]+)"/.exec(xml);
    const pageH = /<mxGraphModel[^>]*\bpageHeight="([\d.]+)"/.exec(xml);
    return {
      ok: true, shapes,
      pageWidth: pageW ? Number(pageW[1]) : 850,
      pageHeight: pageH ? Number(pageH[1]) : 1100,
      compressed,
    };
  } catch (e) {
    return { ok: false, error: `drawio 解析失败: ${String((e as Error).message).slice(0, 160)}` };
  }
}

/**
 * 解开 drawio 桌面端保存的压缩页。
 *
 * 格式(官方约定, 三步都可逆): `xml` → `encodeURIComponent` → `deflateRaw` → `base64`,
 * 结果直接放进 `<diagram>` 的文本内容里。
 *
 * 为什么用 node:zlib 而不是引 pako: inflateRaw 是 Node 内置能力, 零新增依赖。
 * 为什么不是"检测到压缩就报错让用户另存": 那等于把解析器的短板转嫁给用户 ——
 * 而这条链本来就该透明(用户并不知道自己存的时候勾没勾压缩)。
 */
function maybeInflate(rawXml: string): { xml: string; compressed: boolean } {
  // 未压缩: 直接就有 mxGraphModel
  if (rawXml.includes("<mxGraphModel")) return { xml: rawXml, compressed: false };
  const diagram = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/.exec(rawXml);
  const payload = diagram?.[1]?.replace(/\s+/g, "") ?? "";
  if (!payload || payload.startsWith("<")) return { xml: rawXml, compressed: false };
  const inflated = inflateRawSync(Buffer.from(payload, "base64")).toString("utf-8");
  // deflate 之后还可能被 URI 编码过(decodeURIComponent 能反转 %, 但 % 本身在 XML 里合法,
  // 所以只在确实解出 %xx 时才当作编码过 —— 否则会把 XML 里的字面 % 弄坏)
  const xml = /%[0-9A-Fa-f]{2}/.test(inflated) ? decodeURIComponent(inflated) : inflated;
  return { xml, compressed: true };
}
