/**
 * 学术排版自研扩展 — 还原自闭源 EditorView E:39167-39288 academicTextStyle/academicBlockStyle
 * academicTextStyle: 行内 mark(fontFamily/fontSize/color), 命令链 clearAcademicTextStyle
 * academicBlockStyle: 段落级 attr(lineHeight/paragraphSpacing/paragraphStyle), unset 命令链
 */
import { Mark, mergeAttributes } from "@tiptap/core";
import { Extension } from "@tiptap/core";

export interface AcademicTextStyleOptions {
  HTMLAttributes: Record<string, unknown>;
}
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    academicTextStyle: {
      setAcademicFontFamily: (v: string) => ReturnType;
      unsetAcademicFontFamily: () => ReturnType;
      setAcademicFontSize: (v: string) => ReturnType;
      unsetAcademicFontSize: () => ReturnType;
      setAcademicColor: (v: string) => ReturnType;
      unsetAcademicColor: () => ReturnType;
      unsetAcademicTextStyle: () => ReturnType;
    };
    academicBlockStyle: {
      setAcademicLineHeight: (v: string) => ReturnType;
      unsetAcademicLineHeight: () => ReturnType;
      setAcademicParagraphSpacing: (v: string) => ReturnType;
      unsetAcademicParagraphSpacing: () => ReturnType;
      setParagraphStyle: (v: string) => ReturnType;
    };
  }
}

/** 行内排版 mark: fontFamily / fontSize / color */
export const AcademicTextStyle = Mark.create<AcademicTextStyleOptions>({
  name: "academicTextStyle",
  addOptions() {
    return { HTMLAttributes: {} };
  },
  addAttributes() {
    return {
      fontFamily: { default: null, parseHTML: (el) => el.style.fontFamily || null, renderHTML: (attrs) => ({ style: `font-family: ${attrs.fontFamily}` }) },
      fontSize: { default: null, parseHTML: (el) => el.style.fontSize || null, renderHTML: (attrs) => ({ style: `font-size: ${attrs.fontSize}` }) },
      color: { default: null, parseHTML: (el) => el.style.color || null, renderHTML: (attrs) => ({ style: `color: ${attrs.color}` }) }
    };
  },
  parseHTML() {
    return [{ tag: "span[style*='font-family']" }, { tag: "span[style*='font-size']" }, { tag: "span[style*='color']" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
  addCommands() {
    return {
      setAcademicFontFamily:
        (v) =>
        ({ chain }) => chain().setMark(this.name, { fontFamily: v }).run(),
      unsetAcademicFontFamily:
        () =>
        ({ chain }) =>
          chain().unsetMark(this.name).run(),
      setAcademicFontSize:
        (v) =>
        ({ chain }) => chain().setMark(this.name, { fontSize: v }).run(),
      unsetAcademicFontSize:
        () =>
        ({ chain }) =>
          chain().unsetMark(this.name).run(),
      setAcademicColor:
        (v) =>
        ({ chain }) => chain().setMark(this.name, { color: v }).run(),
      unsetAcademicColor:
        () =>
        ({ chain }) =>
          chain().unsetMark(this.name).run(),
      unsetAcademicTextStyle:
        () =>
        ({ chain }) => chain().unsetMark(this.name).run()
    };
  }
});

/** 段落级排版 extension: lineHeight / paragraphSpacing / paragraphStyle(自定义块) */
export const AcademicBlockStyle = Extension.create({
  name: "academicBlockStyle",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el) => el.style.lineHeight || null,
            renderHTML: (attrs) => (attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {})
          },
          paragraphSpacing: {
            default: null,
            parseHTML: (el) => (el.style.marginBottom ? el.style.marginBottom : null),
            renderHTML: (attrs) => (attrs.paragraphSpacing ? { style: `margin-bottom: ${attrs.paragraphSpacing}` } : {})
          },
          paragraphStyle: {
            default: null,
            parseHTML: (el) => (el.dataset.paragraphStyle ? el.dataset.paragraphStyle : null),
            renderHTML: (attrs) => (attrs.paragraphStyle ? { "data-paragraph-style": attrs.paragraphStyle } : {})
          }
        }
      }
    ];
  },
  addCommands() {
    return {
      setAcademicLineHeight:
        (v) =>
        ({ chain }) =>
          chain().updateAttributes("paragraph", { lineHeight: v }).updateAttributes("heading", { lineHeight: v }).run(),
      unsetAcademicLineHeight:
        () =>
        ({ chain }) =>
          chain().updateAttributes("paragraph", { lineHeight: null }).updateAttributes("heading", { lineHeight: null }).run(),
      setAcademicParagraphSpacing:
        (v) =>
        ({ chain }) =>
          chain().updateAttributes("paragraph", { paragraphSpacing: v }).updateAttributes("heading", { paragraphSpacing: v }).run(),
      unsetAcademicParagraphSpacing:
        () =>
        ({ chain }) =>
          chain().updateAttributes("paragraph", { paragraphSpacing: null }).updateAttributes("heading", { paragraphSpacing: null }).run(),
      setParagraphStyle:
        (v) =>
        ({ chain }) =>
          chain().updateAttributes("paragraph", { paragraphStyle: v }).run()
    };
  }
});

// ── 工具栏档位表(闭源工具栏常量) ──
export const FONT_FAMILIES = [
  { label: "宋体", value: "SimSun, 'Songti SC', serif" },
  { label: "黑体", value: "SimHei, 'Heiti SC', sans-serif" },
  { label: "楷体", value: "KaiTi, 'Kaiti SC', serif" },
  { label: "微软雅黑", value: "'Microsoft YaHei', sans-serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Arial", value: "Arial, sans-serif" }
];

export const FONT_SIZES = [
  { label: "小五 9pt", value: "9pt" },
  { label: "五号 10.5pt", value: "10.5pt" },
  { label: "小四 12pt", value: "12pt" },
  { label: "四号 14pt", value: "14pt" },
  { label: "小三 15pt", value: "15pt" },
  { label: "三号 16pt", value: "16pt" }
];

export const LINE_HEIGHTS = [
  { label: "单倍", value: "1.25" },
  { label: "1.5 倍", value: "1.5" },
  { label: "1.75 倍", value: "1.75" },
  { label: "双倍", value: "2" },
  { label: "固定 28 磅", value: "28pt" }
];

export const PARAGRAPH_SPACINGS = [
  { label: "0", value: "0" },
  { label: "0.5 行", value: "6px" },
  { label: "1 行", value: "12px" },
  { label: "1.5 行", value: "18px" },
  { label: "2 行", value: "24px" }
];

export const TEXT_COLORS = [
  { label: "默认", value: "" },
  { label: "红", value: "#dc2626" },
  { label: "橙", value: "#ea580c" },
  { label: "蓝", value: "#2563eb" },
  { label: "绿", value: "#059669" },
  { label: "紫", value: "#7c3aed" },
  { label: "灰", value: "#6b7280" }
];

export const HIGHLIGHT_COLORS = [
  { label: "无", value: "" },
  { label: "黄", value: "#fef08a" },
  { label: "绿", value: "#bbf7d0" },
  { label: "蓝", value: "#bfdbfe" },
  { label: "粉", value: "#fbcfe8" },
  { label: "橙", value: "#fed7aa" }
];
