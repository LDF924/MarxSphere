// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// file-kind.ts — 文件类型判断的唯一真源(2026-10-02)
//
// 由来: 改前**同一份判断复制了三遍**, 各自维护一份 `PREVIEWABLE_EXT`:
//   VaultPanel.tsx:15 · PolicyPanel.tsx:25 · EducationPanel.tsx:21
// 三处都只会说两种话: "能内联预览" 或 "Office 文档（Word/Excel/PPT）浏览器不支持内联预览"。
// 于是 csv / geojson / shp / kml / drawio 全部被报成 **Office 文档** ——
// 文案是错的, 用户按提示去"下载后用本地 Office 打开"一个 .kml 只会更困惑。
//
// 这里把"这是什么文件 / 该用什么方式看"收敛成一处, 三份复制改成调它。
// 新增格式时**只改这里**(以及对应 viewer), 不再满仓找副本。

/** 文件大类 —— 前端据此选 viewer, 不再靠扩展名字符串比较 */
export type FileKind =
  | "markdown"    // md/markdown → MarkdownReader
  | "text"        // txt/csv/tsv/json/log → 纯文本(CSV/TSV 走表格)
  | "pdf"         // → PdfReader
  | "image"       // → <img>/AuthedImg
  | "sheets"      // xlsx/xls → SheetViewer(多 sheet)
  | "csv"         // csv/tsv → 表格(客户端解析)
  | "slides"      // pptx → SlideViewer
  | "diagram"     // drawio/xml → DiagramViewer
  | "geo"         // geojson/kml/gpx/topo → GeoViewer
  | "word"        // docx → 文本/Markdown(服务端 mammoth)
  | "legacy-doc"  // doc → 明确不接受(二进制老格式)
  | "download-only"; // 其余: 只能下载

/** 扩展名 → 大类。键一律小写不含点 */
const KIND_BY_EXT: Record<string, FileKind> = {
  md: "markdown", markdown: "markdown", mdx: "markdown",
  txt: "text", log: "text", json: "text", jsonl: "text", tex: "text", bib: "text", rtf: "text",
  pdf: "pdf",
  png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image", webp: "image", bmp: "image", avif: "image",
  xlsx: "sheets", xls: "sheets", xlsm: "sheets", xltx: "sheets",
  csv: "csv", tsv: "csv",
  pptx: "slides",
  drawio: "diagram",
  geojson: "geo", topojson: "geo", kml: "geo", gpx: "geo",
  docx: "word",
  doc: "legacy-doc",
};

export function extOf(nameOrPath: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(nameOrPath ?? ""));
  return m ? m[1].toLowerCase() : "";
}

export function fileKind(nameOrPath: string): FileKind {
  const ext = extOf(nameOrPath);
  // `.drawio.png` 是 drawio 的导出图 —— 它是**图片**, 不是图定义。
  // 必须先判这个, 否则 .png 的通用规则会把它当普通图片(结果其实也对, 但意图要说清)
  if (/\.drawio\.(png|svg)$/i.test(nameOrPath)) return "image";
  return KIND_BY_EXT[ext] ?? "download-only";
}

/** 支持"在应用内看一眼"的大类(不含 download-only 与 legacy-doc) */
const VIEWABLE = new Set<FileKind>([
  "markdown", "text", "pdf", "image", "sheets", "csv", "slides", "diagram", "geo", "word",
]);

export function isViewable(nameOrPath: string): boolean {
  return VIEWABLE.has(fileKind(nameOrPath));
}

/**
 * 该类型为什么看不了 / 会怎么被看 —— 给用户看的一句话。
 * 每个分支都必须**具体**: 上一版把 csv、geojson、shp、kml、drawio 一律说成
 * "Office 文档（Word/Excel/PPT）", 这是模板套错而不是信息。
 */
export function unsupportedReason(nameOrPath: string): string {
  switch (fileKind(nameOrPath)) {
    case "legacy-doc":
      return "旧版 .doc 是二进制格式，无法直接读取。请在 Word / WPS 里「另存为」.docx 后再上传。";
    case "download-only":
      return `.${extOf(nameOrPath) || "?"} 暂不支持在应用内预览，请下载后用本地软件打开。`;
    default:
      return "";
  }
}

/** 可内联预览类型的一句话清单(空态提示用, 与应用内实际支持保持一致) */
export const VIEWABLE_HINT = "支持 Markdown / 文本 / CSV / 表格(xlsx) / PDF / 图片 / PPT / drawio 图 / GIS(GeoJSON/KML/GPX) 内联预览，其余可下载打开";
