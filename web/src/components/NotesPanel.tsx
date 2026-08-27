// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// NotesPanel.tsx — 双链笔记 + 翻译 + 参考文献（2026-08-27, Agentero 功能前端）
// [[wikilinks]] 笔记编辑 · 出链入链 · 知识图谱 · 划词翻译 · 参考文献解析
import { useEffect, useState } from "react";
import { NotebookPen, Link2, Share2, Languages, BookOpenText, Plus, Save, Loader2, Trash2, Search, CheckCircle2, X } from "lucide-react";

interface Note { id: string; title: string; updated_at: string }
interface NoteDetail { id: string; title: string; content: string; links: Array<{ title: string; exists: boolean }>; backlinks: Array<{ title: string }> }

export function NotesPanel() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [current, setCurrent] = useState<NoteDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [graph, setGraph] = useState<{ nodes: Array<{ id: string; title: string }>; edges: Array<{ source: string; target: string }> }>({ nodes: [], edges: [] });
  const [notice, setNotice] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 翻译 + 参考文献
  const [translateSrc, setTranslateSrc] = useState("");
  const [translated, setTranslated] = useState("");
  const [refText, setRefText] = useState("");
  const [refs, setRefs] = useState<any[]>([]);

  const load = async () => {
    const [n, g] = await Promise.all([
      fetch("/api/notes").then((r) => r.json()).catch(() => ({ notes: [] })),
      fetch("/api/notes/graph").then((r) => r.json()).catch(() => ({ nodes: [], edges: [] })),
    ]);
    setNotes(n.notes || []);
    setGraph(g);
  };

  useEffect(() => { void load(); }, []);

  const openNote = async (id: string) => {
    const r = await fetch(`/api/notes/${id}`).then((x) => x.json()).catch(() => null);
    setCurrent(r?.note || null);
    setDraft(r?.note?.content || "");
    setEditing(false);
  };

  const createNote = async () => {
    const title = prompt("笔记标题（可用 [[双链]] 指向其他笔记）", "新笔记");
    if (!title) return;
    setBusy(true);
    const r = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content: `# ${title}\n\n` }) }).then((x) => x.json());
    setBusy(false);
    if (r?.note) { await load(); void openNote(r.note.id); setEditing(true); }
  };

  const saveNote = async () => {
    if (!current) return;
    setBusy(true);
    const r = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: current.title, content: draft }) }).then((x) => x.json());
    setBusy(false);
    if (r?.note) {
      setNotice({ type: "ok", text: "✅ 已保存（[[双链]] 已更新）" });
      setEditing(false);
      await load();
      void openNote(r.note.id);
    }
  };

  const doTranslate = async () => {
    if (!translateSrc.trim()) return;
    setBusy(true);
    const r = await fetch("/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: translateSrc }) }).then((x) => x.json());
    setBusy(false);
    r?.ok ? setTranslated(r.translated) : setNotice({ type: "err", text: r?.error || "翻译失败" });
  };

  const parseRefs = async () => {
    if (!refText.trim()) return;
    setBusy(true);
    const r = await fetch("/api/references/parse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: refText }) }).then((x) => x.json());
    setBusy(false);
    setRefs(r?.references || []);
    setNotice({ type: "ok", text: `解析到 ${(r?.references || []).length} 条参考文献` });
  };

  const renderMd = (t: string) => {
    // 渲染 [[wikilinks]] 为可点击链接
    const parts = t.split(/(\[\[[^\]]+\]\])/g);
    return parts.map((p, i) => {
      const m = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(p);
      if (!m) return p;
      const title = m[1];
      const target = notes.find((n) => n.title === title);
      return (
        <button key={i} type="button" onClick={() => target && void openNote(target.id)}
          className={`mx-0.5 rounded px-1 font-medium ${target ? "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25" : "bg-muted/50 text-muted-foreground line-through"}`}
          title={target ? `打开「${title}」` : `「${title}」尚未创建`}>
          {title}
        </button>
      );
    });
  };

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* 头部 */}
      <div className="relative overflow-hidden rounded-xl border bg-gradient-to-r from-emerald-500/10 via-teal-500/5 to-transparent p-4">
        <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-emerald-500/10 blur-2xl" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20">
            <NotebookPen className="h-5 w-5 text-white" />
          </div>
          <div>
            <h2 className="text-base font-bold">双链笔记 · 知识图谱</h2>
            <p className="text-[10px] text-muted-foreground">[[wikilinks]] 笔记 · 划词翻译 · 参考文献解析（Obsidian 风格）</p>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] font-medium text-emerald-600">● {notes.length} 笔记</span>
            <span className="rounded-full bg-teal-500/15 px-2 py-0.5 text-[9px] font-medium text-teal-600">{graph.edges.length} 链接</span>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </div>
        </div>
      </div>

      {notice && (
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${notice.type === "ok" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700" : "border-red-500/30 bg-red-500/10 text-red-600"}`}>
          {notice.type === "ok" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
          <span className="flex-1">{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} className="rounded p-0.5 hover:bg-white/10"><X className="h-3 w-3" /></button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
        {/* 左侧: 笔记列表 + 图谱 */}
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card/60 p-3 backdrop-blur-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-semibold"><Link2 className="h-3.5 w-3.5 text-emerald-600" /> 笔记</span>
              <button type="button" onClick={() => void createNote()} disabled={busy}
                className="flex items-center gap-0.5 rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
                <Plus className="h-3 w-3" /> 新建
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {notes.map((n) => (
                <button key={n.id} type="button" onClick={() => void openNote(n.id)}
                  className={`block w-full truncate rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-accent ${current?.id === n.id ? "bg-emerald-500/10 font-medium text-emerald-700" : ""}`}>
                  {n.title}
                </button>
              ))}
              {notes.length === 0 && <div className="px-2 py-4 text-center text-[10px] text-muted-foreground">暂无笔记<br />点「新建」开始</div>}
            </div>
          </div>
          {/* 图谱预览 */}
          <div className="rounded-xl border bg-card/60 p-3 backdrop-blur-sm">
            <span className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><Share2 className="h-3.5 w-3.5 text-purple-600" /> 知识图谱</span>
            {graph.nodes.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {graph.nodes.slice(0, 20).map((n) => (
                  <button key={n.id} type="button" onClick={() => void openNote(n.id)}
                    className="rounded-full border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-[9px] text-purple-700 hover:bg-purple-500/20">
                    {n.title}
                  </button>
                ))}
                {graph.nodes.length > 20 && <span className="px-1 text-[9px] text-muted-foreground">+{graph.nodes.length - 20}</span>}
              </div>
            ) : <div className="py-2 text-center text-[10px] text-muted-foreground">建笔记后显示链接关系</div>}
          </div>
        </div>

        {/* 右侧: 笔记编辑 + 工具 */}
        <div className="flex min-h-0 flex-col gap-3">
          {current ? (
            <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card/60 backdrop-blur-sm">
              <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
                <span className="text-xs font-semibold">{current.title}</span>
                {!editing ? (
                  <button type="button" onClick={() => setEditing(true)}
                    className="ml-auto rounded-md border px-2 py-1 text-[10px] hover:bg-accent">编辑</button>
                ) : (
                  <>
                    <button type="button" onClick={() => void saveNote()} disabled={busy}
                      className="ml-auto flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
                      <Save className="h-3 w-3" /> 保存
                    </button>
                    <button type="button" onClick={() => { setDraft(current.content); setEditing(false); }}
                      className="rounded-md border px-2 py-1 text-[10px] hover:bg-accent">取消</button>
                  </>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {editing ? (
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                    placeholder="# 标题&#10;&#10;正文，用 [[双链]] 连接其他笔记&#10;如：参见 [[资本下乡]] 研究"
                    className="h-full min-h-[300px] w-full resize-y rounded-lg border bg-background/60 p-3 font-mono text-[12px] leading-relaxed outline-none" />
                ) : (
                  <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/90">{renderMd(current.content)}</div>
                )}
              </div>
              <div className="flex flex-wrap gap-3 border-t border-border/50 px-3 py-2 text-[10px]">
                <span className="flex items-center gap-1 text-muted-foreground"><Link2 className="h-3 w-3" /> 出链：
                  {current.links.map((l, i) => (
                    <span key={i} className={`rounded px-1 py-0.5 ${l.exists ? "bg-emerald-500/15 text-emerald-700" : "bg-muted/40 text-muted-foreground"}`}>{l.title}{l.exists ? "✓" : "✗"}</span>
                  ))}
                  {current.links.length === 0 && <span className="text-muted-foreground/60">无</span>}
                </span>
                <span className="flex items-center gap-1 text-muted-foreground"><Share2 className="h-3 w-3" /> 入链：
                  {current.backlinks.map((b, i) => (
                    <button key={i} type="button" onClick={() => { const n = notes.find((x) => x.title === b.title); if (n) void openNote(n.id); }}
                      className="rounded bg-purple-500/15 px-1 py-0.5 text-purple-700 hover:bg-purple-500/25">{b.title}</button>
                  ))}
                  {current.backlinks.length === 0 && <span className="text-muted-foreground/60">无</span>}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed bg-card/30">
              <div className="text-center text-[11px] text-muted-foreground">
                <NotebookPen className="mx-auto mb-2 h-8 w-8 opacity-40" />
                选择左侧笔记或点「新建」<br />
                用 <code className="rounded bg-muted px-1">[[双链]]</code> 连接概念与论文
              </div>
            </div>
          )}

          {/* 翻译 + 参考文献 */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-xl border bg-card/60 p-3 backdrop-blur-sm">
              <span className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><Languages className="h-3.5 w-3.5 text-blue-600" /> 论文翻译</span>
              <textarea value={translateSrc} onChange={(e) => setTranslateSrc(e.target.value)} placeholder="粘贴论文片段/段落，翻译为中文…"
                className="h-24 w-full resize-y rounded-lg border bg-background/60 p-2 text-[11px] outline-none" />
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={() => void doTranslate()} disabled={busy || !translateSrc.trim()}
                  className="rounded-md bg-blue-600 px-3 py-1 text-[10px] font-medium text-white hover:bg-blue-700 disabled:opacity-40">
                  {busy ? "翻译中…" : "翻译"}
                </button>
                {translated && <button type="button" onClick={() => setTranslated("")} className="text-[9px] text-muted-foreground hover:underline">清空</button>}
              </div>
              {translated && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-muted/20 p-2 text-[10px] leading-relaxed">{translateSrc.slice(0, 300)}</div>
                  <div className="rounded-lg bg-blue-500/10 p-2 text-[10px] leading-relaxed text-blue-800">{translated}</div>
                </div>
              )}
            </div>

            <div className="rounded-xl border bg-card/60 p-3 backdrop-blur-sm">
              <span className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><BookOpenText className="h-3.5 w-3.5 text-orange-500" /> 参考文献解析</span>
              <textarea value={refText} onChange={(e) => setRefText(e.target.value)} placeholder="粘贴论文的 References 区文本…"
                className="h-24 w-full resize-y rounded-lg border bg-background/60 p-2 text-[11px] outline-none" />
              <div className="mt-2">
                <button type="button" onClick={() => void parseRefs()} disabled={busy || !refText.trim()}
                  className="rounded-md bg-orange-600 px-3 py-1 text-[10px] font-medium text-white hover:bg-orange-700 disabled:opacity-40">
                  {busy ? "解析中…" : "解析"}
                </button>
              </div>
              {refs.length > 0 && (
                <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
                  {refs.map((r, i) => (
                    <div key={i} className="truncate rounded bg-muted/10 px-2 py-1 text-[10px]">
                      <span className="font-mono text-[9px] text-muted-foreground">[{i + 1}]</span> {r.title || r.raw.slice(0, 60)}
                      {r.doi ? <span className="ml-1 font-mono text-[8px] text-blue-600">{r.doi}</span> : null}
                      {r.arxivId ? <span className="ml-1 font-mono text-[8px] text-purple-600">arXiv:{r.arxivId}</span> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
