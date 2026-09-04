// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// PaperOutlinePanel.tsx — 论文写作工作台(大纲编辑器+分章生成+docx 导出)
// 参考 Respal「大纲编辑器/人机双写」交互(闭源, 仅借鉴思路): 左大纲树(增删排序) 右分章编辑
// 大纲 localStorage 持久化; 分章生成后端 LLM(带前文上下文); 导出 python-docx
import { useEffect, useMemo, useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, Download, FileText, Loader2, Plus, Trash2, Wand2 } from "lucide-react";

interface OutlineNode {
  id: string;
  title: string;
  level: number;
  content?: string;
  generated?: boolean;
  children?: OutlineNode[];
}

const STORAGE_KEY = "paper-outline:v1";

function genId(): string { return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function cn(...xs: Array<string | false | undefined>) { return xs.filter(Boolean).join(" "); }

function collectContent(nodes: OutlineNode[]): string[] {
  const out: string[] = [];
  const walk = (list: OutlineNode[]) => {
    for (const n of list) {
      if (n.generated && n.content) out.push(n.content);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function treeText(nodes: OutlineNode[]): string {
  const lines: string[] = [];
  const walk = (list: OutlineNode[], depth: number) => {
    for (const n of list) {
      lines.push(`${"  ".repeat(depth)}${n.title}`);
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return lines.join("\n");
}

function NodeItem({ node, depth, selected, onSelect, onDelete, onMove }: {
  node: OutlineNode;
  depth: number;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasKids = (node.children?.length ?? 0) > 0;
  return (
    <div>
      <div className={cn("group flex items-center gap-1 rounded px-1.5 py-1 text-xs", selected ? "bg-primary/10 text-primary" : "hover:bg-accent/40")}
        style={{ marginLeft: depth * 14 }}>
        <button type="button" onClick={() => hasKids && setOpen((v) => !v)} className="w-4 text-center text-muted-foreground/50">
          {hasKids ? (open ? <ChevronDown className="inline h-3 w-3" /> : <ChevronRight className="inline h-3 w-3" />) : null}
        </button>
        <button type="button" onClick={onSelect} className="min-w-0 flex-1 truncate text-left">
          {node.generated && <span className="mr-1 text-emerald-400">✓</span>}
          {node.title || "（未命名）"}
        </button>
        <span className="hidden gap-0.5 group-hover:flex">
          <button type="button" onClick={() => onMove(-1)} title="上移" className="text-muted-foreground/50 hover:text-foreground">↑</button>
          <button type="button" onClick={() => onMove(1)} title="下移" className="text-muted-foreground/50 hover:text-foreground">↓</button>
          <button type="button" onClick={onDelete} title="删除" className="text-muted-foreground/50 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
        </span>
      </div>
      {open && hasKids && (
        <div>
          {node.children!.map((c) => (
            <NodeItem key={c.id} node={c} depth={depth + 1} selected={false} onSelect={onSelect} onDelete={() => {}} onMove={() => {}} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PaperOutlinePanel() {
  const [paperTitle, setPaperTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [thesis, setThesis] = useState("");
  const [nodes, setNodes] = useState<OutlineNode[]>(() => {
    try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? (JSON.parse(raw) as OutlineNode[]) : []; } catch { return []; }
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportB64, setExportB64] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes)); } catch { /* 忽略 */ } }, [nodes]);

  const selected: OutlineNode | null = useMemo((): OutlineNode | null => {
    const find = (list: OutlineNode[]): OutlineNode | null => {
      for (const n of list) {
        if (n.id === selectedId) return n;
        if (n.children?.length) {
          const sub = find(n.children);
          if (sub) return sub;
        }
      }
      return null;
    };
    return find(nodes);
  }, [nodes, selectedId]);

  const addNode = (parentId: string | null) => {
    if (!newTitle.trim()) { setMsg("请先输入章节标题"); return; }
    const node: OutlineNode = { id: genId(), title: newTitle.trim(), level: parentId ? 1 : 0 };
    if (!parentId) { setNodes((p) => [...p, node]); }
    else {
      setNodes((prev) => {
        const upd = (list: OutlineNode[]): OutlineNode[] => list.map((n) => {
          if (n.id === parentId) return { ...n, children: [...(n.children ?? []), { ...node, level: n.level + 1 }] };
          if (n.children?.length) return { ...n, children: upd(n.children) };
          return n;
        });
        return upd(prev);
      });
    }
    setNewTitle("");
    setSelectedId(node.id);
    setMsg("");
  };

  const deleteNode = (id: string) => {
    setNodes((prev) => {
      const strip = (list: OutlineNode[]): OutlineNode[] => list.filter((n) => {
        if (n.id === id) return false;
        if (n.children?.length) n.children = strip(n.children);
        return true;
      });
      return strip(prev);
    });
    if (selectedId === id) setSelectedId(null);
  };

  const moveNode = (dir: -1 | 1) => {
    if (!selectedId) return;
    setNodes((prev) => {
      const idx = prev.findIndex((n) => n.id === selectedId);
      if (idx < 0) return prev;
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const generateSelected = async () => {
    if (!selected) { setMsg("请选择要生成的章节"); return; }
    setGenBusy(true); setMsg("");
    try {
      const res = await fetch("/api/paper-outline/chapter", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: selected.id, title: selected.title, level: selected.level,
          topic: topic || paperTitle || selected.title, thesis: thesis || undefined,
          prevContext: collectContent(nodes).slice(-5).join("\n\n") || undefined,
          outlineTree: treeText(nodes),
        }),
      });
      const d = await res.json();
      if (!res.ok) { setMsg(d?.error?.message ?? `生成失败: HTTP ${res.status}`); return; }
      setNodes((prev) => {
        const upd = (list: OutlineNode[]): OutlineNode[] => list.map((n) => {
          if (n.id === selected.id) return { ...n, content: d.content ?? "", generated: true };
          if (n.children?.length) return { ...n, children: upd(n.children) };
          return n;
        });
        return upd(prev);
      });
      setMsg(`✅ ${selected.title} 已生成(${d.wordCount ?? 0} 字)`);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setGenBusy(false); }
  };

  const genComponent = async (kind: "abstract" | "keywords" | "conclusion") => {
    const label = { abstract: "摘要", keywords: "关键词", conclusion: "结论" }[kind];
    setGenBusy(true); setMsg("");
    try {
      const res = await fetch("/api/paper-outline/component", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind, topic: topic || paperTitle, thesis: thesis || undefined,
          sections: nodes.filter((n) => n.level === 0 && n.title !== "摘要").map((n) => n.title),
          chapterContents: collectContent(nodes),
        }),
      });
      const d = await res.json();
      if (!res.ok) { setMsg(d?.error?.message ?? `${label}生成失败`); return; }
      const node: OutlineNode = { id: genId(), title: label, level: 0, content: d.content ?? "", generated: true };
      setNodes((prev) => [...prev.filter((n) => n.title !== label), node]);
      setMsg(`✅ ${label}已生成(${d.wordCount ?? 0} 字)`);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setGenBusy(false); }
  };

  const exportDocx = async () => {
    if (nodes.length === 0) { setMsg("大纲为空, 无法导出"); return; }
    setExportBusy(true); setMsg("");
    try {
      const res = await fetch("/api/paper-outline/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperTitle: paperTitle || "未命名论文", nodes }),
      });
      const d = await res.json();
      if (!res.ok) { setMsg(d?.error?.message ?? `导出失败: HTTP ${res.status}`); return; }
      setExportB64(d.base64 ?? "");
      setMsg("✅ docx 已生成, 点击下方按钮下载");
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setExportBusy(false); }
  };

  return (
    <section className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] space-y-3 p-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-[#6ee7b7]" />
          <h2 className="text-lg font-semibold">论文写作工作台</h2>
          <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-300">大纲 · 分章生成 · 导出 docx</span>
          <span className="ml-auto text-[10px] text-muted-foreground/60">内容本地自动保存 · 人机双写(AI 起草 → 人工审改)</span>
        </div>

        {/* 论文信息 */}
        <div className="grid grid-cols-1 gap-2 rounded-lg border border-border/70 bg-card/60 p-3 md:grid-cols-3">
          <input value={paperTitle} onChange={(e) => setPaperTitle(e.target.value)} placeholder="论文标题"
            className="h-9 rounded-md border border-border/70 bg-background px-2 text-sm outline-none focus:border-emerald-400/50" />
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="研究主题(生成章节时用)"
            className="h-9 rounded-md border border-border/70 bg-background px-2 text-sm outline-none focus:border-emerald-400/50" />
          <input value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="核心论点(可选)"
            className="h-9 rounded-md border border-border/70 bg-background px-2 text-sm outline-none focus:border-emerald-400/50" />
        </div>

        <div className="grid min-h-[60vh] grid-cols-1 gap-3 md:grid-cols-[300px_1fr]">
          {/* 左: 大纲树 */}
          <div className="flex flex-col rounded-lg border border-border/70 bg-card/40 p-2">
            <div className="flex items-center gap-1.5 border-b border-border/50 pb-2 text-xs font-medium text-muted-foreground">
              <FileText className="h-3.5 w-3.5" /> 大纲({nodes.length})
              <span className="ml-auto flex gap-1">
                {(["abstract", "keywords", "conclusion"] as const).map((k) => (
                  <button key={k} type="button" onClick={() => genComponent(k)} disabled={genBusy}
                    className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] hover:bg-accent/40 disabled:opacity-40">
                    {k === "abstract" ? "摘要" : k === "keywords" ? "关键词" : "结论"}
                  </button>
                ))}
              </span>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto py-1">
              {nodes.length === 0 && (
                <div className="py-6 text-center text-[11px] text-muted-foreground/50">大纲为空 — 下方添加章节</div>
              )}
              {nodes.map((n, i) => (
                <NodeItem key={n.id} node={n} depth={0} selected={selectedId === n.id}
                  onSelect={() => setSelectedId(n.id)}
                  onDelete={() => deleteNode(n.id)}
                  onMove={(d) => { /* 顶层排序 */ }}
                />
              ))}
            </div>
            <div className="border-t border-border/50 pt-2">
              <div className="flex gap-1">
                <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addNode(null)}
                  placeholder="新章节标题…" className="h-7 min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 text-[11px] outline-none focus:border-emerald-400/50" />
                <button type="button" onClick={() => addNode(null)}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-500/90 px-2 text-[11px] text-white hover:bg-emerald-400">
                  <Plus className="h-3 w-3" /> 章节
                </button>
              </div>
            </div>
          </div>

          {/* 右: 选中章节编辑/生成 */}
          <div className="flex flex-col rounded-lg border border-border/70 bg-card/40 p-3">
            {selected ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{selected.title}</span>
                  {selected.generated && <span className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-[9px] text-emerald-300">已生成</span>}
                  <span className="ml-auto flex gap-1.5">
                    <button type="button" onClick={generateSelected} disabled={genBusy}
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-400 disabled:opacity-40">
                      {genBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                      {genBusy ? "生成中…" : "生成本章"}
                    </button>
                    <button type="button" onClick={() => deleteNode(selected.id)}
                      className="rounded-md border border-border/70 px-2 py-1.5 text-[11px] text-muted-foreground hover:text-red-400">删除</button>
                  </span>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground/60">
                  带前文上下文连贯生成(最近已写内容自动注入) · 生成后可人工修改
                </p>
                <textarea
                  value={selected.content ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setNodes((prev) => {
                      const upd = (list: OutlineNode[]): OutlineNode[] => list.map((n) => {
                        if (n.id === selected.id) return { ...n, content: v, generated: !!(v && v.trim().length > 20) };
                        if (n.children?.length) return { ...n, children: upd(n.children) };
                        return n;
                      });
                      return upd(prev);
                    });
                  }}
                  placeholder="选中左侧章节 → 点「生成本章」自动起草, 或直接在这里手写(人机双写)…"
                  className="mt-2 min-h-[50vh] w-full flex-1 resize-y rounded-md border border-border/70 bg-background/80 p-3 font-mono text-xs leading-5 outline-none focus:border-emerald-400/40"
                />
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center text-center text-xs text-muted-foreground/50">
                <BookOpen className="mb-2 h-8 w-8 opacity-30" />
                <p>1. 填论文标题/主题</p>
                <p>2. 左栏输入章节标题 → 回车添加</p>
                <p>3. 选中章节 → 「生成本章」(带前文连贯)</p>
                <p>4. 摘要/关键词/结论用左栏顶部快捷生成</p>
                <p>5. 完成后「导出 docx」</p>
              </div>
            )}
          </div>
        </div>

        {/* 导出与状态 */}
        <div className="flex items-center gap-2">
          <button type="button" onClick={exportDocx} disabled={exportBusy || nodes.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-400 disabled:opacity-40">
            {exportBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {exportBusy ? "导出中…" : "导出 docx"}
          </button>
          {exportB64 && (
            <a href={`data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${exportB64}`}
              download={`${paperTitle || "论文"}.docx`}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/20 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/30">
              <Download className="h-3.5 w-3.5" /> 下载 {paperTitle || "论文"}.docx
            </a>
          )}
          {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
          <span className="ml-auto text-[10px] text-muted-foreground/50">
            格式自检提示: 导出 docx 后可在「格式智能评测」上传自检(页边距/字号/标题层级)
          </span>
        </div>
      </div>
    </section>
  );
}
