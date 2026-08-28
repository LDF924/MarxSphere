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

  // 2026-08-27 Agentero 对照: [[ 输入补全（Live Preview 风格）
  const [wikiCandidates, setWikiCandidates] = useState<Note[]>([]);
  const [wikiQuery, setWikiQuery] = useState("");

  /** 检测 textarea 光标处是否在 [[...]] 输入中, 返回补全查询词 */
  const wikiCompletionAt = (value: string, cursor: number): string | null => {
    const before = value.slice(0, cursor);
    const m = /\[\[([^\]\n]*)$/.exec(before);
    return m ? m[1] : null;
  };

  // 2026-08-27 Agentero 对照: 目录大纲（从 Markdown 标题提取）
  const extractOutline = (md: string): Array<{ level: number; title: string; line: number }> => {
    return md.split("\n").map((l, i) => {
      const m = /^(#{1,6})\s+(.+)$/.exec(l);
      return m ? { level: m[1].length, title: m[2].trim(), line: i } : null;
    }).filter((x): x is { level: number; title: string; line: number } => !!x);
  };

  // 2026-08-27 Agentero 对照: Slash 命令（/ 菜单）
  const SLASH_COMMANDS = [
    { id: "h1", label: "标题 1", insert: "# " },
    { id: "h2", label: "标题 2", insert: "## " },
    { id: "h3", label: "标题 3", insert: "### " },
    { id: "list", label: "列表", insert: "- " },
    { id: "quote", label: "引用", insert: "> " },
    { id: "code", label: "代码块", insert: "```\n\n```" },
    { id: "wiki", label: "双链", insert: "[[]]" },
    { id: "embed", label: "嵌入笔记", insert: "![[]]" },
    { id: "formula", label: "行内公式", insert: "$$" },
    { id: "callout", label: "Callout 提示", insert: "> [!important]\n> " },
  ];
  const [slashCandidates, setSlashCandidates] = useState<Array<{ id: string; label: string; insert: string }>>([]);
  const slashCompletionAt = (value: string, cursor: number): string | null => {
    const before = value.slice(0, cursor);
    const m = /(?:^|\n)(\/([a-z0-9一-鿿]*))$/.exec(before);
    return m ? m[2] || "" : null;
  };
  // 嵌入展开（![[title]] → 提示占位, 真正内容渲染靠 renderMd 的 [[ ]] 已处理; 这里把 ![[ ]] 转为块引用）
  const embedContent = (md: string): string => {
    return md.replace(/!\[\[([^\]]+)\]\]/g, (_m, title: string) => {
      const target = notes.find((n) => n.title === title);
      return target ? `> 📄 嵌入「${title}」` : `> ⚠️ 嵌入「${title}」尚未创建`;
    });
  };

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
    try {
      const r = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content: `# ${title}\n\n` }) }).then((x) => x.json());
      if (r?.note) { await load(); void openNote(r.note.id); setEditing(true); }
      else setNotice({ type: "err", text: r?.error || "创建失败" });
    } catch (e: any) { setNotice({ type: "err", text: String(e?.message || e).slice(0, 80) }); }
    setBusy(false);
  };

  const saveNote = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const r = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: current.title, content: draft }) }).then((x) => x.json());
      if (r?.note) {
        setNotice({ type: "ok", text: "✅ 已保存（[[双链]] 已更新）" });
        setEditing(false);
        await load();
        void openNote(r.note.id);
      } else setNotice({ type: "err", text: r?.error || "保存失败" });
    } catch (e: any) { setNotice({ type: "err", text: String(e?.message || e).slice(0, 80) }); }
    setBusy(false);
  };

  const doTranslate = async () => {
    if (!translateSrc.trim()) return;
    setBusy(true);
    try {
      const r = await fetch("/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: translateSrc }) }).then((x) => x.json());
      r?.ok ? setTranslated(r.translated) : setNotice({ type: "err", text: r?.error || "翻译失败" });
    } catch (e: any) { setNotice({ type: "err", text: String(e?.message || e).slice(0, 80) }); }
    setBusy(false);
  };

  const parseRefs = async () => {
    if (!refText.trim()) return;
    setBusy(true);
    try {
      const r = await fetch("/api/references/parse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: refText }) }).then((x) => x.json());
      setRefs(r?.references || []);
      setNotice({ type: "ok", text: `解析到 ${(r?.references || []).length} 条参考文献` });
    } catch (e: any) { setNotice({ type: "err", text: String(e?.message || e).slice(0, 80) }); }
    setBusy(false);
  };

  const renderMd = (t: string) => {
    // 行渲染: 标题行加 id（供目录滚动定位）+ [[wikilinks]] 可点击
    const lines = t.split("\n");
    let headingIdx = 0;
    return lines.map((line, li) => {
      // 标题
      const hm = /^(#{1,6})\s+(.+)$/.exec(line);
      if (hm) {
        const level = hm[1].length;
        const text = hm[2];
        const parts = text.split(/(\[\[[^\]]+\]\])/g);
        const content = parts.map((p, pi) => {
          const wm = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(p);
          if (!wm) return p;
          const title = wm[1];
          const target = notes.find((n) => n.title === title);
          return (
            <button key={pi} type="button" onClick={() => target && void openNote(target.id)}
              className={`mx-0.5 rounded px-1 font-medium ${target ? "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25" : "bg-muted/50 text-muted-foreground line-through"}`}
              title={target ? `打开「${title}」` : `「${title}」尚未创建`}>
              {title}
            </button>
          );
        });
        const cls = ["text-lg font-bold", "text-base font-semibold", "text-sm font-semibold", "text-[13px] font-medium", "text-[12px] font-medium", "text-[11px] font-medium"][Math.min(level - 1, 5)];
        return (
          <div key={li} id={`note-heading-${headingIdx++}`} className={`mt-2 ${cls} text-foreground`}>{content}</div>
        );
      }
      // [[wikilinks]]（普通行）
      const parts = line.split(/(\[\[[^\]]+\]\])/g);
      return (
        <div key={li} className="min-h-[1.4em]">
          {parts.map((p, pi) => {
            const m = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(p);
            if (!m) return p;
            const title = m[1];
            const target = notes.find((n) => n.title === title);
            return (
              <button key={pi} type="button" onClick={() => target && void openNote(target.id)}
                className={`mx-0.5 rounded px-1 font-medium ${target ? "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25" : "bg-muted/50 text-muted-foreground line-through"}`}
                title={target ? `打开「${title}」` : `「${title}」尚未创建`}>
                {title}
              </button>
            );
          })}
        </div>
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
              <div className="flex min-h-0 flex-1">
                {/* 2026-08-27 Agentero 对照: 目录大纲（≥3 标题时显示, 点击滚动） */}
                {!editing && current && extractOutline(current.content).length >= 3 && (
                  <div className="w-40 shrink-0 border-r border-border/40 p-2">
                    <div className="mb-1 text-[9px] font-semibold text-muted-foreground">目录</div>
                    <div className="space-y-0.5">
                      {extractOutline(current.content).map((h, i) => (
                        <button key={i} type="button"
                          onClick={() => {
                            const el = document.getElementById(`note-heading-${i}`);
                            el?.scrollIntoView({ behavior: "smooth", block: "start" });
                          }}
                          className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          style={{ paddingLeft: `${h.level * 8}px` }}>
                          {h.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {editing ? (
                    <div className="relative flex gap-2">
                      {/* 2026-08-27 Agentero 对照: [[ 补全候选浮层 */}
                      {wikiCandidates.length > 0 && (
                      <div className="absolute bottom-full left-2 z-20 mb-1 w-64 overflow-hidden rounded-lg border bg-card shadow-xl">
                        <div className="border-b border-border/50 px-2 py-1 text-[9px] text-muted-foreground">
                          链接到… 输入 <code className="font-mono">[[</code> 触发 · ↑↓ 选择 · Enter 插入 · Esc 关闭
                        </div>
                        <div className="max-h-40 overflow-y-auto">
                          {wikiCandidates.map((n) => (
                            <button key={n.id} type="button"
                              onClick={() => {
                                const cursor = (document.activeElement as HTMLTextAreaElement)?.selectionStart ?? draft.length;
                                const before = draft.slice(0, cursor);
                                const insertAt = Math.max(0, before.lastIndexOf("[["));
                                setDraft(draft.slice(0, insertAt) + `[[${n.title}]]` + draft.slice(cursor));
                                setWikiCandidates([]);
                                setWikiQuery("");
                              }}
                              className="flex w-full items-center justify-between px-2 py-1.5 text-left text-[11px] hover:bg-emerald-500/10">
                              <span className="truncate">{n.title}</span>
                              <span className="shrink-0 text-[9px] text-muted-foreground">↩</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* 2026-08-27 Agentero 对照: Slash 命令菜单 */}
                    {slashCandidates.length > 0 && (
                      <div className="absolute bottom-full left-2 z-20 mb-1 w-56 overflow-hidden rounded-lg border bg-card shadow-xl">
                        <div className="border-b border-border/50 px-2 py-1 text-[9px] text-muted-foreground">/ 命令</div>
                        <div className="max-h-48 overflow-y-auto">
                          {slashCandidates.map((c) => (
                            <button key={c.id} type="button"
                              onClick={() => {
                                const cursor = (document.activeElement as HTMLTextAreaElement)?.selectionStart ?? draft.length;
                                const before = draft.slice(0, cursor);
                                const insertAt = Math.max(0, before.lastIndexOf("/"));
                                setDraft(draft.slice(0, insertAt) + c.insert + draft.slice(cursor));
                                setSlashCandidates([]);
                              }}
                              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-emerald-500/10">
                              <span className="rounded bg-muted/60 px-1 font-mono text-[9px]">{c.id}</span>
                              {c.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="w-1/2 min-w-0">
                      <textarea value={draft}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDraft(v);
                        const cursor = e.target.selectionStart ?? v.length;
                        // [[ 补全
                        const q = wikiCompletionAt(v, cursor);
                        if (q !== null) {
                          setWikiQuery(q);
                          setWikiCandidates(notes.filter((n) => n.title.toLowerCase().includes(q.toLowerCase())).slice(0, 8));
                          setSlashCandidates([]);
                          return;
                        }
                        setWikiCandidates([]);
                        // / Slash 命令
                        const sq = slashCompletionAt(v, cursor);
                        if (sq !== null) {
                          setSlashCandidates(SLASH_COMMANDS.filter((c) => c.id.includes(sq) || c.label.includes(sq)).slice(0, 8));
                          return;
                        }
                        setSlashCandidates([]);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && (wikiCandidates.length > 0 || slashCandidates.length > 0)) {
                          setWikiCandidates([]); setSlashCandidates([]); e.preventDefault();
                        }
                      }}
                      placeholder="# 标题&#10;&#10;输入 [[ 连接笔记 · 输入 / 插入格式 · ![[笔记]] 嵌入"
                      className="h-full min-h-[300px] w-full resize-y rounded-lg border bg-background/60 p-3 font-mono text-[12px] leading-relaxed outline-none" />
                    </div>
                    {/* 2026-08-29 Agentero 对照: 所见即所得 — 编辑时右侧实时预览 */}
                    <div className="min-w-0 flex-1 overflow-y-auto rounded-lg border border-border/40 bg-background/30 p-3">
                      <div className="mb-1.5 flex items-center gap-1 border-b border-border/40 pb-1 text-[9px] text-muted-foreground">
                        <NotebookPen className="h-3 w-3" /> 实时预览（WYSIWYG）
                      </div>
                      <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/90">{renderMd(embedContent(draft))}</div>
                    </div>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/90">{renderMd(embedContent(current.content))}</div>
                )}
                </div>
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
                {/* 2026-08-27 Agentero 对照: 状态栏 — 反链数 + 词数 + 字符数 */}
                <span className="ml-auto flex items-center gap-3 text-muted-foreground">
                  <span className="flex items-center gap-0.5" title="反向链接数量"><Share2 className="h-3 w-3" /> {current.backlinks.length}</span>
                  <span title="词数">{current.content.split(/\s+/).filter(Boolean).length} 词</span>
                  <span title="字符数">{current.content.length} 字</span>
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
