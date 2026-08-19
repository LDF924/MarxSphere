// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// DocumentReader.tsx — 文献阅读器（V361）：所见即所得标注
// 检索文献 → 选择文献 → 原文直接渲染，框选→工具条→高亮/下划线/笔记 立即作用于原文 span
// 无"编辑区+预览区"分离——标注直接在原文上进行（像 PDF 阅读器）
// 笔记收纳栏：底部抽屉显示全部标注（类型徽章/原文片段/笔记内容），可跳转/删除/导出 Markdown
import { useState, useRef, useEffect, type FC, type ReactNode } from "react";
import { BookOpen, FileText, ChevronDown, ChevronRight, ChevronUp, Loader2, Search, Highlighter, Underline, StickyNote, Trash2, Download, NotebookPen } from "lucide-react";
import { cn } from "../lib/utils";

const PROJECT_ID = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";

export interface DocAnnotation {
  id: string;
  type: "highlight" | "underline" | "note";
  text: string;
  start: number;
  end: number;
  note?: string;
  createdAt: number;
}

interface DocumentReaderProps {
  /** 标注持久化前缀（按场景） */
  storageKeyPrefix: string;
  title?: string;
}

const TYPE_STYLES: Record<DocAnnotation["type"], { cls: string; label: string }> = {
  highlight: { cls: "bg-yellow-200/80 text-yellow-950", label: "高亮" },
  underline: { cls: "text-emerald-700 underline decoration-emerald-500 decoration-2", label: "下划线" },
  note: { cls: "bg-violet-200/70 text-violet-950", label: "笔记" },
};

interface LitRef { id: string; title: string; }

export const DocumentReader: FC<DocumentReaderProps> = ({ storageKeyPrefix, title = "文献阅读与标注" }) => {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [refs, setRefs] = useState<LitRef[]>([]);
  const [activeDoc, setActiveDoc] = useState<LitRef | null>(null);
  const [docText, setDocText] = useState("");
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [annotations, setAnnotations] = useState<DocAnnotation[]>([]);
  const [toolbar, setToolbar] = useState<{ x: number; y: number; start: number; end: number; selected: string } | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteFor, setNoteFor] = useState<DocAnnotation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const readerRef = useRef<HTMLDivElement>(null);

  // 切换文献：加载原文 + 标注
  const selectDoc = async (ref: LitRef) => {
    setActiveDoc(ref);
    setLoadingDoc(true);
    setToolbar(null);
    setNoteFor(null);
    try {
      const [cr, ar] = await Promise.all([
        fetch(`/api/documents/${ref.id}/chunks`).then((r) => r.json()),
        Promise.resolve(loadAnnotations(`${storageKeyPrefix}-${ref.id.slice(0, 8)}`)),
      ]);
      const chunks = Array.isArray(cr) ? cr : (cr.chunks ?? []);
      const full = chunks.map((c: any) => (c.heading ? `## ${c.heading}\n` : "") + (c.content ?? "")).join("\n\n");
      setDocText(full);
      setAnnotations(ar);
    } catch {
      setDocText("文献加载失败");
      setAnnotations([]);
    }
    setLoadingDoc(false);
  };

  const loadAnnotations = (key: string): DocAnnotation[] => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as DocAnnotation[]) : [];
    } catch { return []; }
  };

  // 持久化（切文献时保存）
  useEffect(() => {
    if (!activeDoc) return;
    try {
      localStorage.setItem(`${storageKeyPrefix}-${activeDoc.id.slice(0, 8)}`, JSON.stringify(annotations));
    } catch { /* 存储满忽略 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, activeDoc?.id]);

  // 检索文献
  const doSearch = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setSearchError("");
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, sourceIds: [PROJECT_ID], topK: 15 }),
      });
      const j = await res.json();
      const byDoc = new Map<string, LitRef>();
      for (const s of j.sections ?? []) {
        if (s?.documentId && !byDoc.has(s.documentId)) {
          byDoc.set(s.documentId, { id: s.documentId, title: (s.paperTitle ?? s.documentTitle ?? s.heading ?? "文献").substring(0, 60) });
        }
      }
      const refsList = [...byDoc.values()];
      await Promise.all(refsList.map(async (r) => {
        try {
          const dr = await fetch(`/api/documents/${r.id}`);
          const dj = await dr.json();
          if (dj.document?.title) r.title = dj.document.title;
        } catch { /* 用临时标题 */ }
      }));
      setRefs(refsList);
      if (refsList.length === 0) setSearchError("未检索到相关文献");
    } catch { setSearchError("检索失败"); }
    setSearching(false);
  };

  // 框选（在渲染的原文 span 上选择）
  const handleSelect = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setToolbar(null); return; }
    const range = sel.getRangeAt(0);
    const reader = readerRef.current;
    if (!reader || !reader.contains(range.commonAncestorContainer)) { setToolbar(null); return; }
    // 计算选中文本在 docText 中的位置（用标注 span 的 data-start 定位）
    let start = -1, end = -1;
    const container = range.commonAncestorContainer;
    const parentEl = container.nodeType === 3 ? container.parentElement : (container as Element);
    const startEl = parentEl?.closest("[data-start]");
    if (startEl) start = Number(startEl.getAttribute("data-start"));
    const selected = sel.toString().trim();
    if (start === -1 || selected.length < 2) { setToolbar(null); return; }
    end = start + selected.length;
    // 工具条定位（选区上方）
    const rect = range.getBoundingClientRect();
    setToolbar({ x: Math.min(rect.left + rect.width / 2 - 90, rect.right - 220), y: rect.top - 38, start, end, selected });
  };

  const addAnnotation = (type: DocAnnotation["type"]) => {
    if (!toolbar) return;
    const anno: DocAnnotation = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type, text: toolbar.selected, start: toolbar.start, end: toolbar.end, createdAt: Date.now() };
    if (type === "note") { setNoteFor(anno); setToolbar(null); return; }
    setAnnotations((prev) => [...prev, anno]);
    setToolbar(null);
  };

  const saveNote = () => {
    if (!noteFor) return;
    setAnnotations((prev) => [...prev, { ...noteFor, note: noteDraft.trim() || "（无内容）" }]);
    setNoteFor(null);
    setNoteDraft("");
  };

  const removeAnnotation = (id: string) => setAnnotations((prev) => prev.filter((a) => a.id !== id));

  const jumpTo = (anno: DocAnnotation) => {
    setDrawerOpen(false);
    readerRef.current?.querySelector(`[data-anno-id="${anno.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const exportAnnotations = () => {
    const md = [
      `# 文献标注：${activeDoc?.title ?? ""}（${new Date().toLocaleString()}）`, "",
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
    a.download = `文献标注-${activeDoc?.title?.slice(0, 15) ?? "doc"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 渲染原文 + 标注 span（所见即所得）
  const renderDoc = (): ReactNode => {
    if (!docText) return <span className="text-muted-foreground/60">从左侧选择一篇文献开始阅读标注</span>;
    const sorted = [...annotations].sort((a, b) => a.start - b.start);
    const parts: ReactNode[] = [];
    let cursor = 0;
    for (const anno of sorted) {
      if (anno.start > cursor) parts.push(<span key={`t-${cursor}`} data-start={cursor}>{docText.slice(cursor, anno.start)}</span>);
      const style = TYPE_STYLES[anno.type];
      parts.push(
        <span
          key={anno.id}
          data-anno-id={anno.id}
          data-start={anno.start}
          className={cn("cursor-pointer rounded-sm", style.cls)}
          title={anno.note ? `📝 ${anno.note}` : style.label}
          onClick={() => { setNoteFor(anno); setNoteDraft(anno.note ?? ""); }}
        >
          {docText.slice(anno.start, anno.end)}
        </span>
      );
      cursor = anno.end;
    }
    if (cursor < docText.length) parts.push(<span key={`t-end`} data-start={cursor}>{docText.slice(cursor)}</span>);
    return parts;
  };

  return (
    <div className="rounded-lg border bg-background/40">
      {/* 顶栏：标题 + 笔记抽屉开关 */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <NotebookPen className="h-3.5 w-3.5 text-violet-500" />
          {title}
        </div>
        <div className="flex items-center gap-1">
          {activeDoc && (
            <>
              <button onClick={exportAnnotations} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted" title="导出标注">
                <Download className="h-3 w-3" /> 导出
              </button>
              <button onClick={() => setDrawerOpen((v) => !v)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted" title="查看全部笔记">
                {drawerOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
                笔记 {annotations.length > 0 ? `(${annotations.length})` : ""}
              </button>
            </>
          )}
        </div>
      </div>

      {/* 检索区 */}
      <div className="border-b p-2">
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doSearch(); }}
            placeholder="检索当前研究用到的文献著作…（如：资本下乡 治理）"
            className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/50"
          />
          <button onClick={() => void doSearch()} disabled={searching} className="flex shrink-0 items-center gap-1 rounded bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground disabled:opacity-50">
            {searching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
            检索
          </button>
        </div>
        {searchError && <p className="mt-1 text-[10px] text-red-600">{searchError}</p>}
      </div>

      <div className="grid min-h-0 gap-0 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* 左：文献列表 */}
        <div className="max-h-64 overflow-y-auto border-b p-2 lg:max-h-96 lg:border-b-0 lg:border-r">
          {refs.length === 0 ? (
            <p className="p-2 text-[10px] text-muted-foreground">输入主题检索后，这里显示相关文献列表</p>
          ) : (
            refs.map((ref) => (
              <button
                key={ref.id}
                onClick={() => void selectDoc(ref)}
                className={cn(
                  "mb-1 flex w-full items-start gap-1.5 rounded p-1.5 text-left text-[11px] transition-colors",
                  activeDoc?.id === ref.id ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted"
                )}
              >
                <FileText className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 leading-4">{ref.title}</span>
              </button>
            ))
          )}
        </div>

        {/* 右：原文阅读区（所见即所得标注） */}
        <div className="relative">
          <div className="flex items-center gap-2 border-b bg-muted/20 px-3 py-1.5">
            <BookOpen className="h-3 w-3 text-primary" />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{activeDoc?.title ?? "未选择文献"}</span>
            {loadingDoc && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
            {activeDoc && <span className="shrink-0 text-[10px] text-muted-foreground">框选文字 → 高亮/下划线/笔记</span>}
          </div>
          <div
            ref={readerRef}
            onMouseUp={handleSelect}
            onKeyUp={handleSelect}
            className="max-h-96 overflow-y-auto p-3 text-xs leading-[1.8]"
          >
            {renderDoc()}
          </div>
          {/* 框选工具条 */}
          {toolbar && activeDoc && (
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
      </div>

      {/* 笔记输入 */}
      {noteFor && activeDoc && (
        <div className="border-t p-3">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-medium">
            <StickyNote className="h-3.5 w-3.5 text-violet-500" />
            笔记：「{noteFor.text.substring(0, 40)}{noteFor.text.length > 40 ? "…" : ""}」
          </div>
          <div className="flex gap-2">
            <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="输入笔记内容…" className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs" autoFocus />
            <button onClick={saveNote} className="rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground">保存</button>
            <button onClick={() => setNoteFor(null)} className="rounded border px-2 py-1 text-[11px] text-muted-foreground">取消</button>
          </div>
        </div>
      )}

      {/* 笔记收纳抽屉 */}
      {drawerOpen && activeDoc && (
        <div className="max-h-48 overflow-y-auto border-t p-3">
          {annotations.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">暂无标注。在原文上框选文字后可添加高亮/下划线/笔记。</p>
          ) : (
            <div className="space-y-1.5">
              {annotations.map((a) => {
                const style = TYPE_STYLES[a.type];
                return (
                  <div key={a.id} className="flex items-start gap-2 rounded border p-1.5 text-[11px]">
                    <span className={cn("shrink-0 rounded px-1 py-0.5 text-[9px]", style.cls)}>{style.label}</span>
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
