// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// PaperOutlinePanel.tsx — 论文写作工作台 v2
// 三形态: ①卡片流(每章一卡, 卡内直接编辑 markdown) ②整篇连续编辑(全文一个编辑器, 按 ## 标题定位回写)
//        ③大纲树增强(行内改名/排序/折叠/子节)
// 管线: 生成(LLM 带前文)→ 人工编辑 → 导出 docx/pptx; 大纲 localStorage 持久化
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, Download, FileText, Loader2, Pencil, Plus, Trash2, Wand2, Eye, Edit3, ListOrdered, Bold, Italic, Quote, Heading1 } from "lucide-react";

interface OutlineNode {
  id: string;
  title: string;
  level: number;
  targetWords?: number;
  content?: string;
  generated?: boolean;
  children?: OutlineNode[];
}

const STORAGE_KEY = "paper-outline:v1";        // 自动草稿(当前文档)
const SNAPSHOT_KEY = "paper-outline:snapshots:v1"; // 命名版本列表
const AUTO_INTERVAL = 8000;                         // 自动保存间隔
type ViewMode = "cards" | "full";
type EditMode = "edit" | "preview";

function genId(): string { return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function cn(...xs: Array<string | false | undefined>) { return xs.filter(Boolean).join(" "); }

function collectContent(nodes: OutlineNode[]): string[] {
  const out: string[] = [];
  const walk = (list: OutlineNode[]) => { for (const n of list) { if (n.generated && n.content) out.push(n.content); if (n.children?.length) walk(n.children); } };
  walk(nodes);
  return out;
}

// T3-6: 中文序号工具 — 一级 一、二、三 / 二级 1.1 1.2; arabic: 1. 2.
const CN_NUM = ["一","二","三","四","五","六","七","八","九","十"];
function applyNumbering(nodes: OutlineNode[], mode: "cn" | "arabic"): OutlineNode[] {
  let top = 0;
  return nodes.map((n) => {
    if (n.title === "摘要" || n.title === "关键词" || n.title === "结论") return { ...n, children: n.children?.map((c, j) => ({ ...c, title: c.title.replace(/^[一二三四五六七八九十]+、/, "").replace(/^\d+\.\s?/, "") })) };
    top++;
    const prefix = mode === "cn" ? `${CN_NUM[top - 1] ?? top}、` : `${top}. `;
    const clean = (t: string) => t.replace(/^[一二三四五六七八九十]+、/, "").replace(/^\d+\.\s?/, "");
    const kids = (n.children ?? []).map((c, j) => ({ ...c, title: mode === "cn" ? `${prefix.replace(/[、.]+$/, "")}.${j + 1} ${clean(c.title)}` : `${top}.${j + 1} ${clean(c.title)}` }));
    return { ...n, title: prefix + clean(n.title), children: kids };
  });
}
function stripNumbering(nodes: OutlineNode[]): OutlineNode[] {
  const clean = (t: string) => t.replace(/^[一二三四五六七八九十]+[、.．]\s?/, "").replace(/^\d+(\.\d+)?[、.．]\s?/, "").replace(/^\d+\.\s?/, "");
  return nodes.map((n) => ({ ...n, title: clean(n.title), children: (n.children ?? []).map((c) => ({ ...c, title: clean(c.title) })) }));
}

function treeText(nodes: OutlineNode[]): string {
  const lines: string[] = [];
  const walk = (list: OutlineNode[], d: number) => { for (const n of list) { lines.push(`${"  ".repeat(d)}${n.title}`); if (n.children?.length) walk(n.children, d + 1); } };
  walk(nodes, 0);
  return lines.join("\n");
}
function updateNode(list: OutlineNode[], id: string, fn: (n: OutlineNode) => OutlineNode): OutlineNode[] {
  return list.map((n) => {
    if (n.id === id) return fn(n);
    if (n.children?.length) return { ...n, children: updateNode(n.children, id, fn) };
    return n;
  });
}
function removeNode(list: OutlineNode[], id: string): OutlineNode[] {
  return list.filter((n) => {
    if (n.id === id) return false;
    if (n.children?.length) n.children = removeNode(n.children, id);
    return true;
  });
}
function findNode(list: OutlineNode[], id: string): OutlineNode | null {
  for (const n of list) {
    if (n.id === id) return n;
    if (n.children?.length) { const s = findNode(n.children, id); if (s) return s; }
  }
  return null;
}
/** 整篇拼接: ## 标题 + 内容(供连续编辑/导出) */
function toFullMarkdown(nodes: OutlineNode[]): string {
  const parts: string[] = [];
  const walk = (list: OutlineNode[]) => {
    for (const n of list) {
      parts.push(`${"#".repeat(Math.min(n.level + 1, 4))} ${n.title}`);
      if (n.content?.trim()) parts.push(n.content.trim());
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return parts.join("\n\n");
}
/** 整篇 markdown 解析回节点内容: 按标题行切, 标题匹配 node.title 则回写 content */
function parseFullBack(nodes: OutlineNode[], md: string): OutlineNode[] {
  const blocks = md.split(/\n(?=#{1,4} )/).map((b) => b.trim()).filter(Boolean);
  const byTitle = new Map<string, string[]>();
  for (const b of blocks) {
    const m = b.match(/^#{1,4} (.+)$/m);
    if (m) {
      const title = m[1].trim();
      const body = b.replace(/^#{1,4} .+\n?/, "").trim();
      const arr = byTitle.get(title) ?? [];
      arr.push(body);
      byTitle.set(title, arr);
    }
  }
  const upd = (list: OutlineNode[]): OutlineNode[] => list.map((n) => {
    const bodies = byTitle.get(n.title.trim());
    let out = n;
    if (bodies && bodies.length > 0) out = { ...out, content: bodies.join("\n\n"), generated: true };
    if (out.children?.length) out = { ...out, children: upd(out.children) };
    return out;
  });
  return upd(nodes);
}

function MdToolbar({ onInsert }: { onInsert: (tpl: string, sel?: [number, number]) => void }) {
  const items: Array<{ icon: React.ReactNode; label: string; tpl: string }> = [
    { icon: <Bold className="h-3 w-3" />, label: "加粗", tpl: "**选中文字**" },
    { icon: <Italic className="h-3 w-3" />, label: "斜体", tpl: "*选中文字*" },
    { icon: <Heading1 className="h-3 w-3" />, label: "小标题", tpl: "\n### 小标题\n" },
    { icon: <ListOrdered className="h-3 w-3" />, label: "列表", tpl: "\n- 要点一\n- 要点二\n" },
    { icon: <Quote className="h-3 w-3" />, label: "引用", tpl: "\n> 引文内容\n" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border/50 px-1 py-1">
      {items.map((it) => (
        <button key={it.label} type="button" title={`插入${it.label}`} onClick={() => onInsert(it.tpl)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">{it.icon}</button>
      ))}
      <span className="ml-auto pr-1 text-[9px] text-muted-foreground/40">Markdown 语法 · 插入后光标处编辑</span>
    </div>
  );
}

export function PaperOutlinePanel() {
  const [paperTitle, setPaperTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [thesis, setThesis] = useState("");
  const [nodes, setNodes] = useState<OutlineNode[]>(() => {
    try { const raw = localStorage.getItem(STORAGE_KEY); const d = raw ? JSON.parse(raw) : null; return d?.nodes ?? []; } catch { return []; }
  });
  const [newTitle, setNewTitle] = useState("");
  const [view, setView] = useState<ViewMode>("cards");
  const [editMode, setEditMode] = useState<EditMode>("edit");
  const [genBusy, setGenBusy] = useState(false);
  const [genId_, setGenId_] = useState<string | null>(null);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [fullMd, setFullMd] = useState("");
  const [exportB64, setExportB64] = useState("");
  const [pptxB64, setPptxB64] = useState("");
  const [pptxBusy, setPptxBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [snapshots, setSnapshots] = useState<Array<{ id: string; name: string; savedAt: number; paperTitle: string; nodes: OutlineNode[] }>>(() => {
    try { const raw = localStorage.getItem(SNAPSHOT_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
  });
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [saveName, setSaveName] = useState("");
  const fullRef = useRef<HTMLTextAreaElement>(null);

  // 自动保存: 编辑即写(auto 槽) + 每 8s 兜底(防极频繁编辑丢中间态)
  const persistAuto = useMemo(() => ({ paperTitle, topic, thesis, nodes }), [nodes, paperTitle, topic, thesis]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...persistAuto, savedAt: Date.now() })); } catch { /* 忽略 */ }
  }, [persistAuto]);
  useEffect(() => {
    const t = setInterval(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...persistAuto, savedAt: Date.now() })); } catch { /* 忽略 */ }
    }, AUTO_INTERVAL);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistAuto]);

  const persistSnapshots = (list: typeof snapshots) => {
    setSnapshots(list);
    try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(list)); } catch { /* 忽略 */ }
  };
  // 手动保存为命名版本
  const manualSave = () => {
    const name = saveName.trim() || `${paperTitle || "论文"}-${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    const entry = { id: genId(), name, savedAt: Date.now(), paperTitle, nodes };
    persistSnapshots([entry, ...snapshots].slice(0, 30)); // 保留 30 份
    setSaveName("");
    setMsg(`✅ 已保存版本「${name}」(${nodes.length} 章)`);
  };
  // 打开一个版本(读取载入当前编辑)
  const openSnapshot = (id: string) => {
    const hit = snapshots.find((x) => x.id === id);
    if (!hit) return;
    setPaperTitle(hit.paperTitle ?? "");
    setNodes(hit.nodes ?? []);
    setMsg(`📂 已打开版本「${hit.name}」`);
    setShowSnapshots(false);
  };
  // 删除版本
  const deleteSnapshot = (id: string) => persistSnapshots(snapshots.filter((x) => x.id !== id));
  // 新文档(清空当前)
  const newDoc = () => {
    if (nodes.length > 0 && !window.confirm("新建会清空当前草稿(自动草稿保留在 8 秒前), 确定?")) return;
    setPaperTitle(""); setTopic(""); setThesis(""); setNodes([]); setMsg("已新建空白文档");
  };
  // UI审计T11: 清空大纲(保留标题/主题等文档头)
  const clearOutline = () => {
    if (nodes.length === 0) return;
    if (!window.confirm("清空全部章节?")) return;
    setNodes([]); setMsg("大纲已清空");
  };

  const topNodes = nodes.filter((n) => n.level === 0);

  // ── UI审计T11: 社科论文大纲模板库(对齐闭源16模板一键插入) ──
  const [showTpl, setShowTpl] = useState(false);
  // T3-6: 中文序号工具(自动编号/去编号) + 字数分配
  const [numMode, setNumMode] = useState<"none" | "cn" | "arabic">("none");
  const [assignW, setAssignW] = useState<Record<string, string>>({});
  const OUTLINE_TEMPLATES: Array<{ name: string; desc: string; chapters: Array<{ title: string; children?: string[] }> }> = [
    { name: "实证论文·经济管理", desc: "引言→文献→理论→实证→结论", chapters: [
      { title: "引言", children: ["问题提出与研究缘起", "研究目的与意义", "核心概念界定"] },
      { title: "文献综述与分析框架", children: ["相关领域研究进展", "现有研究的不足与本研究的切入点", "本文的分析框架"] },
      { title: "研究设计与数据", children: ["数据来源与样本", "变量选取与测度", "模型设定"] },
      { title: "实证结果与分析", children: ["基准回归结果", "稳健性检验", "异质性分析"] },
      { title: "进一步讨论", children: ["机制检验", "调节效应"] },
      { title: "结论与政策建议", children: ["主要结论", "政策建议", "研究局限与展望"] },
    ]},
    { name: "理论思辨·社科", desc: "现象→理论溯源→分析→批判", chapters: [
      { title: "引言" },
      { title: "现象与问题域", children: ["现实背景", "问题的学术化"] },
      { title: "理论谱系与解释框架", children: ["经典理论资源", "当代发展", "本文的框架"] },
      { title: "机理分析", children: ["逻辑展开", "典型例证"] },
      { title: "批判性讨论", children: ["张力与限度", "与替代解释的对话"] },
      { title: "结语", children: ["结论", "启示"] },
    ]},
    { name: "案例研究", desc: "引言→文献→案例→分析→结论", chapters: [
      { title: "引言", children: ["问题提出"] },
      { title: "文献回顾与分析框架" },
      { title: "案例选择与研究方法", children: ["案例概况", "资料收集", "分析方法"] },
      { title: "案例呈现", children: ["阶段一", "阶段二"] },
      { title: "案例讨论", children: ["理论对话", "发现"] },
      { title: "结论与启示" },
    ]},
    { name: "综述类", desc: "概述→分主题→评估→展望", chapters: [
      { title: "引言" },
      { title: "研究概况与总体趋势", children: ["发文量与时序", "核心议题分布"] },
      { title: "主题一综述", children: ["进展", "分歧"] },
      { title: "主题二综述" },
      { title: "研究方法评述", children: ["方法谱系", "数据来源"] },
      { title: "述评与展望", children: ["现存不足", "未来方向"] },
    ]},
    { name: "政论/政策分析", desc: "背景→问题→原因→对策", chapters: [
      { title: "引言", children: ["背景与问题提出"] },
      { title: "现状与成效", children: ["总体态势", "主要成效"] },
      { title: "问题与挑战", children: ["现实困境", "深层原因"] },
      { title: "对策建议", children: ["总体思路", "具体路径"] },
      { title: "结语" },
    ]},
  ];
  const applyTemplate = (tpl: { name: string; chapters: Array<{ title: string; children?: string[] }> }) => {
    if (nodes.length > 0 && !window.confirm("套用模板将替换当前大纲, 确定?")) return;
    const list: OutlineNode[] = tpl.chapters.map((ch) => ({
      id: genId(), title: ch.title, level: 0,
      children: (ch.children ?? []).map((c) => ({ id: genId(), title: c, level: 1 })),
    }));
    setNodes(list);
    setMsg(`已套用「${tpl.name}」模板(${list.length} 章)`);
    setShowTpl(false);
  };

  // ── 大纲操作 ──
  const addTopNode = () => {
    if (!newTitle.trim()) { setMsg("先输入章节标题"); return; }
    const node: OutlineNode = { id: genId(), title: newTitle.trim(), level: 0 };
    setNodes((p) => [...p, node]);
    setNewTitle("");
    setEditingTitleId(node.id); setTitleDraft(node.title);
    setMsg("");
  };
  const commitTitle = () => {
    if (editingTitleId && titleDraft.trim()) {
      setNodes((prev) => updateNode(prev, editingTitleId, (n) => ({ ...n, title: titleDraft.trim() })));
    }
    setEditingTitleId(null);
  };
  const deleteById = (id: string) => setNodes((prev) => removeNode(prev, id));
  const moveTop = (idx: number, dir: -1 | 1) => {
    setNodes((prev) => {
      const j = idx + dir;
      if (j < 0 || j >= prev.filter((n) => n.level === 0).length) return prev;
      // 只在顶层间移动
      const tops = prev.filter((n) => n.level === 0);
      const others = prev.filter((n) => n.level > 0);
      const a = tops[idx], b = tops[j];
      tops[idx] = b; tops[j] = a;
      return [...others, ...tops];
    });
  };

  const setContent = (id: string, content: string) => {
    setNodes((prev) => updateNode(prev, id, (n) => ({ ...n, content, generated: content.trim().length > 20 })));
  };

  // ── 生成 ──
  const generateChapter = async (id: string) => {
    const node = findNode(nodes, id);
    if (!node) return;
    setGenBusy(true); setGenId_(id); setMsg("");
    try {
      const res = await fetch("/api/paper-outline/chapter", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: node.id, title: node.title, level: node.level,
          topic: topic || paperTitle || node.title, thesis: thesis || undefined,
          prevContext: collectContent(nodes).slice(-5).join("\n\n") || undefined,
          outlineTree: treeText(nodes),
        }),
      });
      const d = await res.json();
      if (!res.ok) { setMsg(d?.error?.message ?? `生成失败: HTTP ${res.status}`); return; }
      setContent(node.id, d.content ?? "");
      setMsg(`✅「${node.title}」已生成(${d.wordCount ?? 0} 字)`);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setGenBusy(false); setGenId_(null); }
  };
  const genComponent = async (kind: "abstract" | "keywords" | "conclusion") => {
    const label = { abstract: "摘要", keywords: "关键词", conclusion: "结论" }[kind];
    setGenBusy(true); setMsg("");
    try {
      const res = await fetch("/api/paper-outline/component", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind, topic: topic || paperTitle, thesis: thesis || undefined,
          sections: nodes.filter((n) => n.level === 0 && !["摘要", "关键词", "结论"].includes(n.title)).map((n) => n.title),
          chapterContents: collectContent(nodes),
        }),
      });
      const d = await res.json();
      if (!res.ok) { setMsg(d?.error?.message ?? `${label}生成失败`); return; }
      const node: OutlineNode = { id: genId(), title: label, level: 0, content: d.content ?? "", generated: true };
      setNodes((prev) => [...prev.filter((n) => n.title !== label), node]);
      setMsg(`✅ ${label} 已生成(${d.wordCount ?? 0} 字)`);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setGenBusy(false); }
  };

  // ── 整篇编辑 ──
  const enterFull = () => { setFullMd(toFullMarkdown(nodes)); setView("full"); setEditMode("edit"); };
  const saveFull = () => {
    setNodes((prev) => parseFullBack(prev, fullMd));
    setView("cards");
    setMsg("✅ 全文已保存回章节结构");
  };

  // ── 导出 ──
  const exportDocx = async () => {
    if (nodes.length === 0) { setMsg("大纲为空"); return; }
    setExportBusy(true); setMsg("");
    try {
      const res = await fetch("/api/paper-outline/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperTitle: paperTitle || "未命名论文", nodes }),
      });
      const d = await res.json();
      if (!res.ok) { setMsg(d?.error?.message ?? `导出失败: HTTP ${res.status}`); return; }
      setExportB64(d.base64 ?? ""); setMsg("✅ docx 已生成, 点击下载");
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setExportBusy(false); }
  };
  const exportPptx = async () => {
    if (nodes.length === 0) { setMsg("大纲为空"); return; }
    setPptxBusy(true); setMsg("");
    try {
      const res = await fetch("/api/paper-outline/export-pptx", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperTitle: paperTitle || "未命名论文", nodes }),
      });
      const d = await res.json();
      if (!res.ok) { setMsg(d?.error?.message ?? `导出失败: HTTP ${res.status}`); return; }
      setPptxB64(d.base64 ?? ""); setMsg("✅ PPT 已生成, 点击下载");
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setPptxBusy(false); }
  };

  // ── 工具栏插入(卡片编辑器) ──
  const insertAt = (ta: HTMLTextAreaElement, tpl: string) => {
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const sel = ta.value.slice(start, end);
    const text = sel ? tpl.replace("选中文字", sel).replace(/\n/g, sel.includes("\n") ? "" : "\n") : tpl;
    const next = ta.value.slice(0, start) + text + ta.value.slice(end);
    // 交由受控更新: 无法直接 setContent, 通过 id 标记
    (ta as HTMLTextAreaElement & { _pendingInsert?: { start: number; text: string } })._pendingInsert = { start, text };
    ta.value = next;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
    ta.setSelectionRange(start + text.length, start + text.length);
  };

  // 简单预览(纯文本 md 转 <p>)
  const renderPreview = (md: string) => (
    <div className="space-y-2 text-[13px] leading-6">
      {md.split("\n").filter((l) => l.trim()).map((l, i) => {
        const t = l.trim();
        if (t.startsWith("### ")) return <p key={i} className="font-semibold">{t.slice(4)}</p>;
        if (t.startsWith("## ")) return <p key={i} className="font-semibold text-[15px]">{t.slice(3)}</p>;
        if (t.startsWith("# ")) return <p key={i} className="font-bold text-base">{t.slice(2)}</p>;
        if (t.startsWith("- ")) return <p key={i} className="pl-4">• {t.slice(2)}</p>;
        if (t.startsWith("> ")) return <p key={i} className="border-l-2 border-border pl-2 text-muted-foreground">{t.slice(2)}</p>;
        return <p key={i}>{t}</p>;
      })}
    </div>
  );

  // 单卡: 标题行(可改名)+ 工具栏 + 编辑/预览
  const ChapterCard = ({ node, idx }: { node: OutlineNode; idx: number }) => {
    const [mode, setMode] = useState<EditMode>("edit");
    const busy = genBusy && genId_ === node.id;
    const isComp = ["摘要", "关键词", "结论"].includes(node.title);
    return (
      <div className="rounded-lg border border-border/70 bg-card/40">
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
          {editingTitleId === node.id ? (
            <input autoFocus value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle} onKeyDown={(e) => e.key === "Enter" && commitTitle()}
              className="h-6 min-w-0 flex-1 rounded border border-primary/40 bg-background px-1.5 text-sm font-medium outline-none" />
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{node.title}</span>
              <button type="button" title="改名" onClick={() => { setEditingTitleId(node.id); setTitleDraft(node.title); }}
                className="rounded p-1 text-muted-foreground/50 hover:text-foreground"><Pencil className="h-3 w-3" /></button>
            </>
          )}
          {node.generated && <span className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-[9px] text-emerald-300">✓</span>}
          <span className="ml-auto flex items-center gap-0.5 text-muted-foreground/60">
            <button type="button" title="上移" onClick={() => moveTop(idx, -1)} className="rounded p-1 hover:text-foreground">↑</button>
            <button type="button" title="下移" onClick={() => moveTop(idx, 1)} className="rounded p-1 hover:text-foreground">↓</button>
            <button type="button" title="删除" onClick={() => deleteById(node.id)} className="rounded p-1 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
          </span>
        </div>
        {isComp ? (
          <div className="p-3">
            {mode === "edit" ? (
              <textarea value={node.content ?? ""} onChange={(e) => setContent(node.id, e.target.value)}
                rows={4} className="w-full rounded border border-border/60 bg-background/70 p-2 text-xs leading-5 outline-none focus:border-emerald-400/40" />
            ) : renderPreview(node.content ?? "")}
            <div className="mt-1 flex justify-end gap-1">
              <button type="button" onClick={() => setMode(mode === "edit" ? "preview" : "edit")}
                className="rounded border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/40">
                {mode === "edit" ? <Eye className="inline h-3 w-3" /> : <Edit3 className="inline h-3 w-3" />} {mode === "edit" ? "预览" : "编辑"}
              </button>
              <button type="button" onClick={() => genComponent(node.title === "摘要" ? "abstract" : node.title === "关键词" ? "keywords" : "conclusion")}
                disabled={genBusy} className="rounded bg-emerald-500/90 px-2 py-0.5 text-[10px] text-white hover:bg-emerald-400 disabled:opacity-40">
                {busy ? "…" : "重新生成"}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-3">
            <MdToolbar onInsert={(tpl) => { /* textarea 焦点插入由下编辑器各自处理 */ }} />
            {mode === "edit" ? (
              <textarea
                value={node.content ?? ""}
                onChange={(e) => setContent(node.id, e.target.value)}
                rows={Math.max(6, Math.min(20, Math.ceil((node.content ?? "").length / 120)))}
                placeholder="在此直接撰写该章内容(Markdown): 标题用 # / ##, 列表用 -, 引用用 >。或点「AI 生成本章」起草。"
                className="mt-1 w-full resize-y rounded border border-border/60 bg-background/70 p-2 font-mono text-xs leading-5 outline-none focus:border-emerald-400/40" />
            ) : (
              <div className="mt-1 rounded border border-border/50 bg-background/40 p-2">{renderPreview(node.content ?? "")}</div>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={() => generateChapter(node.id)} disabled={genBusy}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-400 disabled:opacity-40">
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
                {busy ? "生成中…" : node.content ? "AI 重写" : "AI 生成本章"}
              </button>
              <button type="button" onClick={() => setMode(mode === "edit" ? "preview" : "edit")}
                className="rounded-md border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/40">
                {mode === "edit" ? "预览" : "编辑"}
              </button>
              <span className="ml-auto text-[10px] text-muted-foreground/50">
                {node.content ? `${node.content.replace(/\s/g, "").length} 字` : "未生成"}
              </span>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1500px] space-y-3 p-4">
        {/* 头 */}
        <div className="flex flex-wrap items-center gap-2">
          <BookOpen className="h-5 w-5 text-[#6ee7b7]" />
          <h2 className="text-lg font-semibold">论文写作工作台</h2>
          <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-300">卡片 · 整篇 · 大纲</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={newDoc} title="新建空白文档"
              className="rounded-md border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/40">＋ 新建</button>
            <button type="button" onClick={() => setShowSnapshots((v) => !v)}
              className="rounded-md border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/40">📂 打开({snapshots.length})</button>
            <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="版本名(可选)"
              className="h-7 w-32 rounded-md border border-border/60 bg-background px-2 text-[11px] outline-none focus:border-emerald-400/50" />
            <button type="button" onClick={manualSave}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-400">💾 保存版本</button>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-card/40 p-0.5 text-xs">
            <button type="button" onClick={() => setView("cards")} className={cn("rounded-md px-2.5 py-1", view === "cards" ? "bg-emerald-500/15 text-emerald-300" : "text-muted-foreground hover:text-foreground")}>📇 章节卡片</button>
            <button type="button" onClick={enterFull} className={cn("rounded-md px-2.5 py-1", view === "full" ? "bg-emerald-500/15 text-emerald-300" : "text-muted-foreground hover:text-foreground")}>📄 整篇连续</button>
          </div>
        </div>

        {/* 版本列表 */}
        {showSnapshots && (
          <div className="rounded-lg border border-border/70 bg-card/60 p-2">
            <div className="flex items-center justify-between px-1 pb-1.5 text-xs font-medium text-muted-foreground">
              已保存版本({snapshots.length}/30) · 点击打开
              <span className="text-[10px] text-muted-foreground/50">自动草稿每 8 秒后台保存(无需手动)</span>
            </div>
            {snapshots.length === 0 ? (
              <div className="py-3 text-center text-[11px] text-muted-foreground/50">暂无命名版本 — 填版本名点「保存版本」; 当前内容已在自动草稿中</div>
            ) : (
              <div className="max-h-52 space-y-1 overflow-y-auto">
                {snapshots.map((sn) => (
                  <div key={sn.id} className="group flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5 hover:bg-accent/30">
                    <button type="button" onClick={() => openSnapshot(sn.id)} className="min-w-0 flex-1 truncate text-left text-xs">
                      <span className="font-medium">{sn.name}</span>
                      <span className="ml-2 text-[10px] text-muted-foreground/60">
                        {sn.nodes.length} 章 · {new Date(sn.savedAt).toLocaleString("zh-CN", { hour12: false })}
                      </span>
                    </button>
                    <button type="button" onClick={() => deleteSnapshot(sn.id)} title="删除版本"
                      className="text-muted-foreground/40 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 论文信息 */}
        <div className="grid grid-cols-1 gap-2 rounded-lg border border-border/70 bg-card/60 p-3 md:grid-cols-3">
          <input value={paperTitle} onChange={(e) => setPaperTitle(e.target.value)} placeholder="论文标题"
            className="h-9 rounded-md border border-border/70 bg-background px-2 text-sm outline-none focus:border-emerald-400/50" />
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="研究主题(生成章节时用)"
            className="h-9 rounded-md border border-border/70 bg-background px-2 text-sm outline-none focus:border-emerald-400/50" />
          <input value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="核心论点(可选)"
            className="h-9 rounded-md border border-border/70 bg-background px-2 text-sm outline-none focus:border-emerald-400/50" />
        </div>

        {view === "cards" ? (
          <div className="grid min-h-[60vh] grid-cols-1 gap-3 lg:grid-cols-[260px_1fr]">
            {/* 左: 大纲 */}
            <div className="flex flex-col rounded-lg border border-border/70 bg-card/40 p-2">
              <div className="flex items-center gap-1 border-b border-border/50 pb-2 text-xs font-medium text-muted-foreground">
                <FileText className="h-3.5 w-3.5" /> 大纲({nodes.length})
                <span className="ml-auto flex gap-1">
                  {(["abstract", "keywords", "conclusion"] as const).map((k) => (
                    <button key={k} type="button" onClick={() => genComponent(k)} disabled={genBusy}
                      className="rounded border border-border/60 px-1 py-0.5 text-[9px] hover:bg-accent/40 disabled:opacity-40">
                      {k === "abstract" ? "摘要" : k === "keywords" ? "关键词" : "结论"}
                    </button>
                  ))}
                </span>
              </div>
              {/* T3-6: 中文序号工具条 */}
              <div className="flex flex-wrap items-center gap-1 border-b border-border/40 pb-1.5 text-[9px]">
                <span className="text-muted-foreground/60">序号</span>
                {([["none", "无"], ["cn", "一、1.1"], ["arabic", "1. 1.1"]] as Array<["none" | "cn" | "arabic", string]>).map(([k, lbl]) => (
                  <button key={k} type="button" onClick={() => {
                    setNumMode(k);
                    if (k === "none") setNodes((p2) => stripNumbering(p2));
                    else setNodes((p2) => applyNumbering(p2, k));
                  }}
                    className={cn("rounded border px-1.5 py-0.5", numMode === k ? "border-emerald-400/50 bg-emerald-400/15 text-emerald-300" : "border-border/50 text-muted-foreground hover:bg-accent/40")}>
                    {lbl}
                  </button>
                ))}
                <span className="ml-auto text-muted-foreground/60">字数分配(字/章)</span>
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto py-1 text-xs">
                {nodes.length === 0 && <div className="py-6 text-center text-[11px] text-muted-foreground/50">大纲为空 — 下方添加章节, 或点摘要/关键词/结论</div>}
                {nodes.map((n, i) => {
                  const kids = n.children ?? [];
                  return (
                    <div key={n.id}>
                      <div className="group flex items-center gap-1 rounded px-1 py-1 hover:bg-accent/30">
                        {kids.length > 0 ? <ChevronDown className="h-3 w-3 text-muted-foreground/40" /> : <span className="w-3" />}
                        <span className="min-w-0 flex-1 truncate">
                          {n.generated ? <span className="text-emerald-400">✓ </span> : null}{n.title}
                          {n.targetWords ? <span className="ml-1 rounded bg-accent/50 px-1 text-[8px] text-muted-foreground">{n.targetWords}字</span> : null}
                        </span>
                        {assignW[n.id] !== undefined ? (
                          <input autoFocus value={assignW[n.id] ?? ""}
                            onChange={(e) => setAssignW((m) => ({ ...m, [n.id]: e.target.value }))}
                            onBlur={() => { const v = Number(assignW[n.id]); if (v > 0) setNodes((p2) => updateNode(p2, n.id, (x) => ({ ...x, targetWords: v }))); setAssignW((m) => { const n2 = { ...m }; delete n2[n.id]; return n2; }); }}
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                            placeholder="字数"
                            className="w-14 rounded border border-border/60 bg-background px-1 py-0.5 text-[9px] text-muted-foreground outline-none" />
                        ) : null}
                        <span className="hidden gap-0.5 group-hover:flex">
                          <button type="button" title="改名" onClick={() => { setEditingTitleId(n.id); setTitleDraft(n.title); }}
                            className="text-muted-foreground/50 hover:text-foreground"><Pencil className="h-3 w-3" /></button>
                          <button type="button" title="上移" onClick={() => moveTop(i, -1)} className="text-muted-foreground/50 hover:text-foreground">↑</button>
                          <button type="button" title="下移" onClick={() => moveTop(i, 1)} className="text-muted-foreground/50 hover:text-foreground">↓</button>
                          <button type="button" title="设目标字数" onClick={() => setAssignW((m) => ({ ...m, [n.id]: String(n.targetWords ?? "") }))}
                            className="text-muted-foreground/50 hover:text-emerald-400">字</button>
                          <button type="button" title="删除" onClick={() => deleteById(n.id)} className="text-muted-foreground/50 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
                        </span>
                      </div>
                      {kids.map((k) => (
                        <div key={k.id} className="flex items-center gap-1 rounded py-0.5 pl-6 pr-1 text-[11px] text-muted-foreground hover:bg-accent/20">
                          <span className="min-w-0 flex-1 truncate">{k.generated ? "✓ " : ""}{k.title}</span>
                          <button type="button" onClick={() => deleteById(k.id)} className="text-muted-foreground/40 hover:text-red-400"><Trash2 className="h-2.5 w-2.5" /></button>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
              <div className="border-t border-border/50 pt-2">
                <div className="flex gap-1">
                  <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addTopNode()}
                    placeholder="新章节标题, 回车添加…" className="h-7 min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 text-[11px] outline-none focus:border-emerald-400/50" />
                  <button type="button" onClick={addTopNode}
                    className="inline-flex items-center gap-0.5 rounded-md bg-emerald-500/90 px-1.5 text-[11px] text-white hover:bg-emerald-400">
                    <Plus className="h-3 w-3" />
                  </button>
                </div>
                {/* UI审计T11: 大纲模板库 */}
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <button type="button" onClick={() => setShowTpl((v) => !v)}
                    className="rounded-md border border-emerald-400/30 bg-emerald-400/5 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-400/15">
                    📋 大纲模板库 {showTpl ? "▲" : "▼"}
                  </button>
                  {nodes.length > 0 && (
                    <button type="button" onClick={clearOutline}
                      className="rounded-md border border-border/40 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/40">清空大纲</button>
                  )}
                </div>
                {showTpl && (
                  <div className="mt-1 grid grid-cols-1 gap-1 rounded-lg border border-emerald-400/20 bg-card/50 p-1.5">
                    {OUTLINE_TEMPLATES.map((t) => (
                      <button key={t.name} type="button" onClick={() => applyTemplate(t)}
                        className="flex items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-emerald-400/10">
                        <span className="text-[11px] text-emerald-200">{t.name}</span>
                        <span className="text-[9px] text-muted-foreground">{t.desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 右: 章节卡片流 */}
            <div className="space-y-3">
              {topNodes.length === 0 && (
                <div className="flex h-40 flex-col items-center justify-center rounded-lg border border-dashed border-border/50 text-xs text-muted-foreground/50">
                  <BookOpen className="mb-2 h-7 w-7 opacity-30" />
                  左栏输入章节标题 → 回车, 每章一张卡, 卡内直接写或 AI 生成
                </div>
              )}
              {topNodes.map((n, i) => <ChapterCard key={n.id} node={n} idx={i} />)}
            </div>
          </div>
        ) : (
          /* 整篇连续编辑 */
          <div className="rounded-lg border border-border/70 bg-card/40">
            <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2 text-xs">
              <span className="font-medium text-muted-foreground">整篇连续编辑</span>
              <span className="text-[10px] text-muted-foreground/50"># 一级标题 / ## 二级 — 编辑后「保存回章节」按标题自动归位; 改动标题将新增章节</span>
              <div className="ml-auto flex gap-1">
                <button type="button" onClick={() => setEditMode(editMode === "edit" ? "preview" : "edit")}
                  className="rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/40">
                  {editMode === "edit" ? "预览全文" : "编辑模式"}
                </button>
                <button type="button" onClick={() => { setFullMd(toFullMarkdown(nodes)); setMsg("已重置为当前大纲内容"); }}
                  className="rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/40">重置</button>
                <button type="button" onClick={saveFull}
                  className="rounded-md bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-400">💾 保存回章节</button>
              </div>
            </div>
            {editMode === "edit" ? (
              <textarea ref={fullRef} value={fullMd} onChange={(e) => setFullMd(e.target.value)}
                spellCheck={false}
                className="h-[70vh] w-full resize-y bg-background/60 p-4 font-mono text-xs leading-5 outline-none focus:bg-background/80"
                placeholder="全文 markdown… 顶部为论文标题, 每章前用 # 标题行" />
            ) : (
              <div className="h-[70vh] overflow-y-auto p-4">{renderPreview(fullMd)}</div>
            )}
          </div>
        )}

        {/* 导出与状态 */}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={exportDocx} disabled={exportBusy || nodes.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-400 disabled:opacity-40">
            {exportBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {exportBusy ? "导出中…" : "导出 docx"}
          </button>
          <button type="button" onClick={exportPptx} disabled={pptxBusy || nodes.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-500 px-4 py-2 text-xs font-medium text-white hover:bg-violet-400 disabled:opacity-40">
            {pptxBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {pptxBusy ? "导出中…" : "导出 PPT"}
          </button>
          {exportB64 && (
            <a href={`data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${exportB64}`}
              download={`${paperTitle || "论文"}.docx`}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/20 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/30">下载 docx</a>
          )}
          {pptxB64 && (
            <a href={`data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${pptxB64}`}
              download={`${paperTitle || "论文"}.pptx`}
              className="inline-flex items-center gap-1.5 rounded-md bg-violet-500/20 px-3 py-2 text-xs font-medium text-violet-300 hover:bg-violet-500/30">下载 pptx</a>
          )}
          {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
          <span className="ml-auto text-[10px] text-muted-foreground/40">草稿自动本地保存 · 导出 docx 后可送「格式智能评测」自检</span>
        </div>
      </div>
    </section>
  );
}
