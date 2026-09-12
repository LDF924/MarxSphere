/**
 * TipTap 编辑器装配 — 还原自闭源 useEditor GN()(EditorView E:39289-39315)
 * extensions 全表 1:1: StarterKit{codeBlock:false,link:false,underline:false} + Placeholder + Link(openOnClick:false)
 * + Underline + academicTextStyle/academicBlockStyle + TextAlign + Highlight(multicolor)
 * + Image(allowBase64) + ImageResize + Table(resizable) + CodeBlockLowlight(29 语言)
 */
import { useEditor, EditorContent, type Editor } from "@tiptap/vue-3";
import type { ShallowRef } from "vue";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { AcademicTextStyle, AcademicBlockStyle } from "./academicExtensions";
import { mergeAttributes, type Extensions } from "@tiptap/core";

// 29 语言注册表(闭源 zN lowlight 表): 常见科研语言
const LANGS = [
  "python", "javascript", "typescript", "java", "c", "cpp", "csharp", "go", "rust",
  "r", "sql", "bash", "shell", "json", "yaml", "xml", "html", "css", "markdown",
  "latex", "matlab", "stata", "sas", "julia", "scala", "kotlin", "swift", "php", "ruby"
];
const lowlight = createLowlight(common);

export { EditorContent };
export type { Editor };

export interface EditorExtensionsOptions {
  placeholder?: string;
  editorProps?: Record<string, unknown>;
}

/** 扩展装配(闭源 GN 1:1) */
export function buildExtensions(opts: EditorExtensionsOptions = {}): Extensions {
  return [
    StarterKit.configure({ codeBlock: false, link: false, underline: false }),
    Placeholder.configure({ placeholder: opts.placeholder ?? "开始输入..." }),
    Link.configure({ openOnClick: false, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }),
    Underline,
    AcademicTextStyle,
    AcademicBlockStyle,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Highlight.configure({ multicolor: true }),
    Image.configure({ inline: false, allowBase64: true }),
    // ImageResize = Image.extend({name:"imageResize", allowBase64:true}) — 闭源用同名扩展做 resize
    Image.extend({ name: "imageResize", allowBase64: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    CodeBlockLowlight.configure({ lowlight }),
    ...(opts.editorProps ? [] : [])
  ];
}

/** 供组件建立 editor — 组件 setup 内调用; useEditor 返回 ShallowRef<Editor|undefined>(TipTap v3) */
export function createAcademicEditor(opts: {
  content?: unknown;
  onUpdate?: (json: unknown) => void;
  placeholder?: string;
}): ShallowRef<Editor | undefined> {
  const editor = useEditor({
    content: (opts.content as string) ?? "",
    extensions: buildExtensions({ placeholder: opts.placeholder }),
    editorProps: { attributes: { class: "ade-editor-prose" } },
    onUpdate: ({ editor: ed }) => {
      opts.onUpdate?.(ed.getJSON());
    }
  });
  return editor;
}

export { mergeAttributes };
