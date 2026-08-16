// AnnotationWorkspace.tsx — 研究场景文本标注工作区（V357）
// 功能: 粘贴文本 → 框选 → 工具条(高亮/下划线/笔记) → span 着色渲染 → 笔记收纳栏(分组/跳转/删除/导出)
// 存储: localStorage 按 storageKey 持久化（不碰数据库）
import { useState, useRef, useEffect, useCallback, type FC, type ReactNode } from "react";
import { Highlighter, Underline, StickyNote, Trash2, Download, ChevronDown, ChevronUp, NotebookPen } from "lucide-react";
import { cn } from "../lib/utils";

export interface Annotation {
  id: string;
  type: "highlight" | "underline" | "note";
  text: string;
  start: number;
  end: number;
  note?: string;
  createdAt: number;
}

interface AnnotationWorkspaceProps {
  /** localStorage key（按场景区分，如 "anno-classical-S36"） */
  storageKey: string;
  /** 初始文本（可选，从外部传入） */
  initialText?: string;
  /** 外部更新文本（如从分析结果回填） */
  externalText?: string;
  /** 标题（如 "原文工作区"） */
  title?: string;
  /** 输入框是否可编辑（默认 true） */
  editable?: boolean;
}

const TYPE_STYLES: Record<Annotation["type"], { bg: string; border: string; label: string }> = {
  highlight: { bg: "bg-yellow-200/70 text-yellow-950", border: "border-yellow-400", label: "高亮" },
  underline: { bg: "bg-transparent text-emerald-700 underline decoration-emerald-500 decoration-2", border: "border-emerald-400", label: "下划线" },
  note: { bg: "bg-violet-200/60 text-violet-950", border: "border-violet-400", label: "笔记" },
};

function loadAnnotations(key: string): Annotation[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Annotation[]) : [];
  } catch { return []; }
}

export const AnnotationWorkspace: FC<AnnotationWorkspaceProps> = ({
  storageKey,
  initialText = "",
  externalText,
  title = "文本工作区",
  editable = true,
}) => {
  const [text, setText] = useState(initialText);
  const [annotations, setAnnotations] = useState<Annotation[]>(() => loadAnnotations(storageKey));
  const [toolbar, setToolbar] = useState<{ x: number; y: number; selected: string; start: number; end: number } | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteFor, setNoteFor] = useState<Annotation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 外部文本回填（分析结果 → 工作区）
  useEffect(() => {
    if (externalText && externalText !== text) setText(externalText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalText]);

  // 持久化
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(annotations)); } catch { /* 存储满忽略 */ }
  }, [annotations, storageKey]);

  // 框选处理（textarea 选择 → 工具条）
  const handleSelect = () => {
    const ta = textareaRef.current;
    if (!ta || ta.selectionStart === ta.selectionEnd) { setToolbar(null); return; }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = text.substring(start, end).trim();
    if (selected.length < 2) { setToolbar(null); return; }
    const rect = ta.getBoundingClientRect();
    // 工具条放选区上方（用行高估算位置）
    const lineHeight = 22;
    const line = text.substring(0, start).split("\n").length - 1;
    setToolbar({
      x: Math.min(rect.left + 40, rect.right - 200),
      y: rect.top + line * lineHeight - 40,
      selected,
      start,
      end,
    });
  };

  // 添加标注
  const addAnnotation = (type: Annotation["type"]) => {
    if (!toolbar) return;
    const anno: Annotation = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      text: toolbar.selected,
      start: toolbar.start,
      end: toolbar.end,
      createdAt: Date.now(),
    };
    if (type === "note") {
      setNoteFor(anno);
      setNoteDraft("");
      setToolbar(null);
      return;
    }
    setAnnotations((prev) => [...prev, anno]);
    setToolbar(null);
  };

  // 保存笔记
  const saveNote = () => {
    if (!noteFor) return;
    setAnnotations((prev) => [...prev, { ...noteFor, note: noteDraft.trim() || "（无内容）" }]);
    setNoteFor(null);
    setNoteDraft("");
  };

  // 删除标注
  const removeAnnotation = (id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  };

  // 跳转到标注位置（滚动到预览区对应 span）
  const jumpTo = useCallback((anno: Annotation) => {
    setDrawerOpen(false);
    const el = previewRef.current?.querySelector(`[data-anno-id="${anno.id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // 导出标注（JSON + Markdown 笔记）
  const exportAnnotations = () => {
    const md = [
      `# ${title} 标注导出（${new Date().toLocaleString()}）`,
      "",
      ...annotations.map((a, i) => {
        const note = a.note ? `\n\n> 📝 ${a.note}` : "";
        const style = a.type === "highlight" ? "==高亮==" : a.type === "underline" ? "__下划线__" : "【笔记】";
        return `${i + 1}. ${style} "${a.text}"${note}`;
      }),
    ].join("\n");
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}-标注.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 渲染带标注的预览文本（按 start 排序重叠处理——简单实现：非重叠标注）
  const renderPreview = (): ReactNode => {
    if (!text) return <span className="text-muted-foreground/50">粘贴或输入文本后，框选文字可添加标注</span>;
    const sorted = [...annotations].sort((a, b) => a.start - b.start);
    const parts: ReactNode[] = [];
    let cursor = 0;
    for (const anno of sorted) {
      if (anno.start > cursor) parts.push(text.slice(cursor, anno.start));
      const style = TYPE_STYLES[anno.type];
      parts.push(
        <span
          key={anno.id}
          data-anno-id={anno.id}
          className={cn("rounded-sm cursor-pointer", style.bg, style.border)}
          title={anno.note ? `📝 ${anno.note}` : anno.type === "highlight" ? "高亮" : anno.type === "underline" ? "下划线" : "笔记"}
          onClick={() => { setNoteFor(anno); setNoteDraft(anno.note ?? ""); }}
        >
          {text.slice(anno.start, anno.end)}
        </span>
      );
      cursor = anno.end;
    }
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
  };

  return (
    <div className="rounded-lg border bg-background/40">
      {/* 标题栏 */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <NotebookPen className="h-3.5 w-3.5 text-violet-500" />
          {title}
          <span className="text-[10px] font-normal text-muted-foreground">
            框选文字 → 高亮 / 下划线 / 笔记
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={exportAnnotations} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted" title="导出标注为 Markdown">
            <Download className="h-3 w-3" /> 导出
          </button>
          <button onClick={() => setDrawerOpen((v) => !v)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted" title="笔记收纳">
            {drawerOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
            笔记 {annotations.length > 0 ? `(${annotations.length})` : ""}
          </button>
        </div>
      </div>

      <div className="grid gap-3 p-3 md:grid-cols-2">
        {/* 左：可编辑文本 */}
        <div>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onSelect={handleSelect}
            onBlur={() => setTimeout(() => setToolbar(null), 200)}
            disabled={!editable}
            rows={10}
            placeholder="在此粘贴或输入文本…（可框选标注）"
            className="w-full resize-y rounded border bg-background p-2 font-mono text-xs leading-[22px] outline-none focus:border-primary/50"
          />
          {/* 框选工具条 */}
          {toolbar && (
            <div
              className="fixed z-50 flex items-center gap-1 rounded-lg border bg-background p-1 shadow-lg"
              style={{ left: toolbar.x, top: toolbar.y }}
            >
              <button onClick={() => addAnnotation("highlight")} className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] hover:bg-yellow-100" title="高亮">
                <Highlighter className="h-3 w-3 text-yellow-600" /> 高亮
              </button>
              <button onClick={() => addAnnotation("underline")} className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] hover:bg-emerald-100" title="下划线">
                <Underline className="h-3 w-3 text-emerald-600" /> 下划线
              </button>
              <button onClick={() => addAnnotation("note")} className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] hover:bg-violet-100" title="笔记">
                <StickyNote className="h-3 w-3 text-violet-600" /> 笔记
              </button>
            </div>
          )}
        </div>

        {/* 右：标注预览 */}
        <div ref={previewRef} className="max-h-64 overflow-y-auto rounded border bg-muted/20 p-2 text-xs leading-[22px]">
          {renderPreview()}
        </div>
      </div>

      {/* 笔记输入弹层 */}
      {noteFor && (
        <div className="border-t p-3">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-medium">
            <StickyNote className="h-3.5 w-3.5 text-violet-500" />
            笔记：「{noteFor.text.substring(0, 40)}{noteFor.text.length > 40 ? "…" : ""}」
          </div>
          <div className="flex gap-2">
            <input
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="输入笔记内容…"
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
              autoFocus
            />
            <button onClick={saveNote} className="rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground">保存</button>
            <button onClick={() => setNoteFor(null)} className="rounded border px-2 py-1 text-[11px] text-muted-foreground">取消</button>
          </div>
        </div>
      )}

      {/* 笔记收纳栏 */}
      {drawerOpen && (
        <div className="max-h-48 overflow-y-auto border-t p-3">
          {annotations.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">暂无标注。框选文本后添加高亮/下划线/笔记。</p>
          ) : (
            <div className="space-y-1.5">
              {annotations.map((a) => {
                const style = TYPE_STYLES[a.type];
                return (
                  <div key={a.id} className="flex items-start gap-2 rounded border p-1.5 text-[11px]">
                    <span className={cn("shrink-0 rounded px-1 py-0.5 text-[9px]", style.bg)}>{style.label}</span>
                    <button onClick={() => jumpTo(a)} className="min-w-0 flex-1 text-left">
                      <span className="line-clamp-1">{a.text}</span>
                      {a.note && <span className="mt-0.5 block text-[10px] text-muted-foreground">📝 {a.note}</span>}
                    </button>
                    <button onClick={() => removeAnnotation(a.id)} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-red-50 hover:text-red-600" title="删除">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
