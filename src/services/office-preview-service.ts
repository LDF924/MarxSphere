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
// drawio(.drawio / .xml)
// ═══════════════════════════════════════════════════════════════

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
