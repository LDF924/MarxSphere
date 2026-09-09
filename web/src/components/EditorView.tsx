// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// EditorView.tsx — SocialSci P0-5: 在线学术文本编辑器(学术编辑器)
// 形态对齐(闭源产品交互语义, 原创实现): 文档列表/双栏编辑(markdown+预览)/选区改写5模式+humanize/
//   全文一致性检查/图表代码插入/自动保存+锁心跳/字数
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ConfirmDialog } from "./ConfirmDialog";
import { MarkdownRich } from "./MarkdownRich";
import { readResume } from "./ResearchHistoryPanel";
import {
  AlignLeft, BarChart3, CheckCircle2, ChevronLeft, ClipboardCheck, Download,
  Eye, FileText, History as HistoryIcon, ImageIcon, Loader2, Lock, Pencil, Plus, Save, Search,
  Sparkles, Trash2, Upload, Wand2, X,
} from "lucide-react";

interface DocLite { id: string; title: string; word_count: number; status: string; updated_at: string; }
interface RewriteResult { text: string; }
// P-C: 闭源全文检查 4 模式(EditorView 实页: 全文逻辑/章节衔接/变量-方法-结论/投稿前)
const CHECK_MODES: Array<{ k: string; name: string; desc: string }> = [
  { k: "logic", name: "全文逻辑检查", desc: "结构、重复、跳跃和论证断裂。" },
  { k: "cohesion", name: "章节衔接检查", desc: "检查标题层级、前后承接和小标题支撑关系。" },
  { k: "consistency", name: "变量-方法-结论一致性", desc: "检查研究问题、变量、方法和结论是否前后一致。" },
  { k: "submission", name: "投稿前检查", desc: "列出需要优先处理的修订事项。" },
];
interface CheckResult { mode?: string; modeName?: string; checks: Array<{ name: string; ok: boolean; findings: string[] }>; }

const REWRITE_MODES: Array<{ key: string; label: string; desc: string }> = [
  { key: "polish", label: "学术润色", desc: "优化用词与句式" },
  { key: "condense", label: "压缩冗余", desc: "删重复/空泛, 缩短30-40%" },
  { key: "de-template", label: "去除模板化", desc: "消除口号/套路表达" },
  { key: "proofread", label: "修正语病", desc: "错别字/语病/标点" },
  { key: "journal-style", label: "期刊风格", desc: "中文核心期刊表达" },
  { key: "humanize", label: "消除AI痕迹", desc: "行文更接近人类学者" },
  { key: "expand", label: "扩展论证", desc: "补足推理链条和解释" },
];

// T5-4: 图表类型快捷预设(闭源 EditorView 图表 tab: 流程图/思维导图/柱状/折线/饼图等)
const CHART_TYPES: Array<{ k: string; label: string; tpl: string }> = [
  { k: "flow", label: "流程图", tpl: "画流程图: 研究思路/方法步骤的流程示意(mermaid 风格)" },
  { k: "mind", label: "思维导图", tpl: "画思维导图: 主题分层的结构示意" },
  { k: "bar", label: "柱状图", tpl: "画柱状图: 对比各分类数值, 中文标签" },
  { k: "line", label: "折线图", tpl: "画折线图: 时间趋势变化, 中文标签" },
  { k: "pie", label: "饼图", tpl: "画饼图: 占比构成, 中文标签" },
  { k: "scatter", label: "散点图", tpl: "画散点图: 相关关系, 中文标签" },
];

function tokenOf() { return localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""; }
// R6: 统一 AI job 调用(建 job → SSE 收 delta/done; localStorage activeJobId 断线恢复语义)
async function runAiJob<T>(body: Record<string, unknown>, onDelta?: (d: string) => void): Promise<T> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const t = tokenOf(); if (t) h.Authorization = `Bearer ${t}`;
  const r = await fetch("/api/editor/v1/ai/jobs", { method: "POST", headers: h, body: JSON.stringify(body) });
  const jd = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((jd as { error?: string }).error ?? `任务创建失败 ${r.status}`);
  const jobId = (jd as { job_id?: string }).job_id;
  if (!jobId) throw new Error("任务创建失败: 无 job_id");
  try { localStorage.setItem("editor.activeJobId", jobId); } catch { /* 忽略 */ }
  try {
    const s = await fetch(`/api/editor/v1/ai/jobs/${jobId}/stream`, { headers: { ...h, Accept: "text/event-stream" } });
    if (!s.ok || !s.body) throw new Error("后台作业连接失败");
    const reader = s.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
      for (const p of parts) {
        const ev = p.match(/event: (\S+)/)?.[1];
        const data = p.match(/data: (.*)/s)?.[1];
        if (!data) continue;
        const obj = JSON.parse(data);
        if (ev === "delta" && obj.content) onDelta?.(obj.content);
        if (ev === "error") throw new Error(obj.message ?? "任务执行失败");
        if (ev === "done") {
          try { localStorage.removeItem("editor.activeJobId"); } catch { /* 忽略 */ }
          return (obj.content ? { ...obj, text: typeof obj.content === "string" ? obj.content : "" } : obj) as T;
        }
      }
    }
    throw new Error("流意外结束");
  } catch (e) {
    // 断线: 保留 activeJobId 供下次挂载 retry
    throw e;
  }
}
async function j<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) ?? {}) };
  const t = tokenOf(); if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(url, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败 ${r.status}`);
  return body as T;
}
function cn(...xs: Array<string | false | undefined>) { return xs.filter(Boolean).join(" "); }

export function EditorView() {
  const [docs, setDocs] = useState<DocLite[]>([]);
  const [curId, setCurId] = useState<string | null>(null);
  const [title, setTitle] = useState("未命名文档");
  const [content, setContent] = useState("");
  const [wordCount, setWordCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [view, setView] = useState<"edit" | "split" | "preview">("split");
  // 预览风格(闭源 EditorView formatPresets 对齐): 控制预览排版观感 — 闭源用 CSS 变量驱动 + localStorage
  const [docStyle, setDocStyle] = useState(() => { const v = localStorage.getItem("ade-format-preset") || "general"; return ["general", "journal_cn", "apa", "degree"].includes(v) ? v : "general"; });
  const DOC_STYLES: Record<string, { label: string; desc: string; style: React.CSSProperties; docxFont?: string }> = {
    general: { label: "通用学术论文", desc: "宋体/Times New Roman，适合中文论文草稿与通用投稿前检查。", style: { fontFamily: '"Noto Serif SC", "Songti SC", SimSun, "Times New Roman", serif', fontSize: "15px", lineHeight: 1.85, textIndent: "2em" }, docxFont: "SimSun" },
    journal_cn: { label: "中文期刊风格", desc: "更紧凑的中文期刊预览，强调段落缩进和标题层级。", style: { fontFamily: 'SimSun, "Noto Serif SC", serif', fontSize: "14.5px", lineHeight: 1.75, textIndent: "2em" }, docxFont: "SimSun" },
    apa: { label: "APA 草稿", desc: "英文论文草稿预览，使用 Times New Roman 与双倍行距。", style: { fontFamily: '"Times New Roman", Times, serif', fontSize: "16px", lineHeight: 2, textIndent: "0.5in" }, docxFont: "Times New Roman" },
    degree: { label: "学位论文草稿", desc: "适合较长篇幅论文的宽松预览，便于逐章审阅。", style: { fontFamily: 'SimSun, "Noto Serif SC", serif', fontSize: "15px", lineHeight: 1.9, textIndent: "2em" }, docxFont: "SimSun" },
  };
  useEffect(() => { localStorage.setItem("ade-format-preset", docStyle); }, [docStyle]);
  const [selText, setSelText] = useState("");
  const [rewriting, setRewriting] = useState("");
  // P1-2(审查): rewriteBox 带发起时选区 [start,end) 与 docId — 防首现替换错位/跨文档污染
  const [rewriteBox, setRewriteBox] = useState<{ original: string; result: string; start?: number; end?: number; docId?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [checkMode, setCheckMode] = useState("logic"); // P-C: 闭源 4 检查模式
  const [showCheck, setShowCheck] = useState(false);
  const [chartDesc, setChartDesc] = useState("");
  const [chartBusy, setChartBusy] = useState(false);
  const [chartArt, setChartArt] = useState<{ pngRel: string; code: string } | null>(null);
  const [showChart, setShowChart] = useState(false);
  // UI审计T5: AI右侧常驻面板
  const [showAiPanel, setShowAiPanel] = useState(false);
  // A6(闭源 ade-ai-panel-width): AI 面板宽度持久化(clamp 300-560) + 左缘拖拽调宽
  const [aiPanelW, setAiPanelW] = useState<string>(() => { try { return localStorage.getItem("ade-ai-panel-width") || "340px"; } catch { return "340px"; } });
  const aiPanelWRef = useRef(340);
  useEffect(() => {
    const m = aiPanelW.match(/(\d+)/);
    aiPanelWRef.current = m ? Number(m[1]) : 340;
  }, [aiPanelW]);
  const onAiPanelDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = aiPanelWRef.current;
    const onMove = (ev: PointerEvent) => {
      // 拖动在 AI 面板左侧 → 面板宽 = 起始宽 - 位移
      const w = Math.min(560, Math.max(300, startW - (ev.clientX - startX)));
      aiPanelWRef.current = w;
      setAiPanelW(`${w}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try { localStorage.setItem("ade-ai-panel-width", aiPanelWRef.current + "px"); } catch { /* 忽略 */ }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const [lockedBy, setLockedBy] = useState("");
  const [delAsk, setDelAsk] = useState<{ id: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // 版本历史(任务4: 对齐闭源编辑器版本历史 — 时间线+回档)
  const [showHistory, setShowHistory] = useState(false);
  const [histVers, setHistVers] = useState<Array<{ version: number; content_len: number; by_editor: string; created_at: string }>>([]);
  const [histBusy, setHistBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const curIdRef = useRef<string | null>(null);
  curIdRef.current = curId;
  const contentRef = useRef("");
  contentRef.current = content;

  const flash = (m: string) => { setOkMsg(m); setTimeout(() => setOkMsg(""), 2500); };

  const loadDocs = useCallback(async () => {
    try { const r = await j<{ data: { items: DocLite[] } }>("/api/editor/v1/documents"); setDocs(r.data?.items ?? []); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void loadDocs(); }, [loadDocs]);

  // 历史中心 deep-resume: 从历史记录 editor 区卡点击跳入 → 自动打开对应文档
  // A3(闭源 editor.activeDocumentId): 最后打开文档 localStorage 持久化, 冷启动恢复
  useEffect(() => {
    const r = readResume("editor");
    const lastId = (() => { try { return localStorage.getItem("editor.activeDocumentId"); } catch { return null; } })();
    if (r?.id) void openDoc(String(r.id));
    else if (lastId && !curIdRef.current) void openDoc(lastId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDoc = async (id: string) => {
    setBusy(true); setErr("");
    try {
      // P2-3(审查): 切文档先释放旧文档锁(协作方不再等 5 分钟锁过期)
      if (curIdRef.current && curIdRef.current !== id) {
        void j(`/api/editor/v1/documents/${curIdRef.current}/unlock`, { method: "POST", body: "{}" }).catch(() => {});
        if (heartbeatTimer.current) { clearInterval(heartbeatTimer.current); heartbeatTimer.current = null; }
      }
      const r = await j<{ document: { title: string; content: string; word_count: number; locked_by: string; content_hash?: string } }>(`/api/editor/v1/documents/${id}`);
      // P0-1A(审查): 乐观锁基准 = 打开时服务端内容的 hash, 存 ref 供保存时比对
      if (r.document.content_hash) {
        let h = 0x811c9dc5;
        const str = r.document.content;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
        lastSyncedHashRef.current = h.toString(16);
      } else {
        lastSyncedHashRef.current = "";
      }
      setCurId(id); setTitle(r.document.title); setContent(r.document.content);
      setWordCount(r.document.word_count); setLockedBy(r.document.locked_by);
      setRewriteBox(null); setCheckResult(null); setChartArt(null);
      try { localStorage.setItem("editor.activeDocumentId", id); } catch { /* 忽略 */ }
      // 持锁 + 心跳(编辑会话; 每 30s 续, 5min 超时自动放)
      await j(`/api/editor/v1/documents/${id}/lock`, { method: "POST", body: "{}" });
      setLockedBy(`user:${tokenOf().slice(0, 6)}`);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = setInterval(() => {
        if (curIdRef.current) void j(`/api/editor/v1/documents/${curIdRef.current}/lock`, { method: "POST", body: "{}" }).catch(() => {});
      }, 30_000);
    } catch (e) {
      // P3-1(审查): 失效文档 id 清理(防冷启动 404 横幅重复)
      try {
        const cur = localStorage.getItem("editor.activeDocumentId");
        if (cur === id) localStorage.removeItem("editor.activeDocumentId");
      } catch { /* 忽略 */ }
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  // 新建文档弹层(闭源 editor: 标题 input + 取消/创建 自绘弹层, 弃 window.prompt)
  const [showNewDoc, setShowNewDoc] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const newDoc = async () => {
    setBusy(true); setErr("");
    try {
      const r = await j<{ id: string }>("/api/editor/v1/documents", { method: "POST", body: JSON.stringify({ title: newTitle.trim() || "未命名文档" }) });
      setShowNewDoc(false); setNewTitle("");
      await loadDocs();
      await openDoc(r.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // 任务4: Word 导入即看 — 提取正文→建档→打开(可继续编辑/检查/改写)
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [impBusy, setImpBusy] = useState(false);
  const importWord = async (file: File) => {
    setImpBusy(true); setErr("");
    try {
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const r = await j<{ ok: boolean; text?: string; error?: string }>("/api/files/extract-text", {
        method: "POST", body: JSON.stringify({ filename: file.name, base64: b64, mime: file.type }),
      });
      if (!r.ok || !r.text) throw new Error(r.error || "未能提取正文");
      const title = file.name.replace(/\.[^.]+$/, "");
      const d = await j<{ id: string }>("/api/editor/v1/documents", { method: "POST", body: JSON.stringify({ title, content: r.text }) });
      await loadDocs();
      await openDoc(d.id);
      flash(`已导入 ${file.name} (${r.text.length} 字)`);
    } catch (e) { setErr((e as Error).message); } finally { setImpBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  // R7(闭源 导出): 导出 Word — 按当前预览预设的 docxFont 生成 docx(python-docx 通道)
  const [expBusy, setExpBusy] = useState(false);
  const exportDocx = async () => {
    if (!curId) return;
    setExpBusy(true); setErr("");
    try {
      const doc = await j<{ document: { title: string; content: string } }>(`/api/editor/v1/documents/${curId}`);
      const markdown = doc.document.content || content;
      // markdown → 节点树(一级标题/二级/正文)
      const node: Record<string, unknown> = { title: doc.document.title || title, level: 0, content: "", children: [] as Record<string, unknown>[] };
      let cur: Record<string, unknown> | null = null;
      for (const line of markdown.split("\n")) {
        const h1 = line.match(/^##\s+(.+)$/);
        const h2 = line.match(/^###\s+(.+)$/);
        if (h1) { cur = { title: h1[1], level: 1, content: "", children: [] as Record<string, unknown>[] }; (node.children as Record<string, unknown>[]).push(cur); }
        else if (h2 && cur) { (cur.children as Record<string, unknown>[]).push({ title: h2[1], level: 2, content: "", children: [] }); }
        else if (cur) { cur.content = String(cur.content ?? "") + line + "\n"; }
        else { node.content = String(node.content ?? "") + line + "\n"; }
      }
      const r = await j<{ ok: boolean; base64: string }>("/api/paper-outline/export", {
        method: "POST", body: JSON.stringify({ paperTitle: doc.document.title || title, nodes: [node], fontName: DOC_STYLES[docStyle]?.docxFont ?? "SimSun" }),
      });
      const bin = atob(r.base64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(doc.document.title || title).replace(/[\\/:*?"<>|]/g, "_")}.docx`;
      a.click();
      URL.revokeObjectURL(a.href);
      flash("已导出 Word");
    } catch (e) { setErr((e as Error).message); } finally { setExpBusy(false); }
  };

  // P0-1A(审查): 乐观锁基准 = 最近一次与服务器同步的内容 hash(非待发内容!)
  const lastSyncedHashRef = useRef("");
  const saveNow = async (payload?: { title?: string; content?: string }) => {
    if (!curId) return;
    setSaving(true);
    try {
      const body = { ...(payload ?? { title, content }) };
      // A1(闭源 content_hash 乐观锁): expected = 上次同步内容的 hash
      // (后端语义: 服务端当前 hash ≠ expected 且内容不同 → 他窗口已改 → 409)
      if (body.content !== undefined) {
        (body as { expectedContentHash?: string }).expectedContentHash = lastSyncedHashRef.current;
      }
      const r = await j<{ wordCount: number }>(`/api/editor/v1/documents/${curId}`, {
        method: "PUT", body: JSON.stringify(body),
      });
      // 保存成功 → 基准更新为刚保存的内容(若有 content)
      if (body.content !== undefined) {
        const h = body.content;
        let hv = 0x811c9dc5;
        for (let i = 0; i < h.length; i++) { hv ^= h.charCodeAt(i); hv = (hv * 0x01000193) >>> 0; }
        lastSyncedHashRef.current = hv.toString(16);
      }
      setWordCount(r.wordCount);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("其他窗口") || msg.includes("DOC_CONFLICT")) {
        setErr("文档已在其他窗口被修改 — 已停止保存你的更改。请刷新加载最新内容(未保存内容已丢失)");
        window.dispatchEvent(new CustomEvent("doc-conflict"));
      } else { setErr(msg); }
    } finally { setSaving(false); }
  };

  const onContentChange = (v: string) => {
    setContent(v);
    setWordCount(v.replace(/\s/g, "").length);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // P2-1(审查): 防抖快照只带 content(title 走 blur 保存, 防旧标题回退新标题)
    const snap = { title, content: v };
    saveTimer.current = setTimeout(() => {
      void saveNow({ content: snap.content }); // title 不入快照 — blur 保存负责
    }, 1200); // A2: 自动保存防抖(闭源 1200ms)
  };

  const removeDoc = async (id: string) => {
    setDelAsk(null);
    try {
      await j(`/api/editor/v1/documents/${id}`, { method: "DELETE" });
      if (curId === id) { setCurId(null); setContent(""); setTitle(""); try { localStorage.removeItem("editor.activeDocumentId"); } catch { /* 忽略 */ } }
      await loadDocs();
    } catch (e) { setErr((e as Error).message); }
  };

  // 选区改写: 取 textarea 选中文本
  const grabSelection = () => {
    const ta = taRef.current;
    if (!ta) return "";
    const s = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    return s.trim();
  };

  const doRewrite = async (mode: string) => {
    const sel = selText || grabSelection();
    if (!sel) { setErr("请先在正文中选中一段文字, 再选择改写方式"); return; }
    const ta0 = taRef.current;
    const selStart = ta0 ? ta0.selectionStart : -1;
    const selEnd = ta0 ? ta0.selectionEnd : -1;
    const reqDoc = curId ?? "";
    setRewriting(mode); setErr("");
    try {
      // R6: 统一 AI job
      const r = await runAiJob<{ content: string }>({ action: "rewrite", mode, text: sel, document_id: curId });
      // P1-1(审查): 用户已切到别的文档 → 丢弃结果不注入(防跨文档污染)
      if (curIdRef.current !== reqDoc) {
        setErr("改写完成但你已切换到其他文档 — 结果未注入(回原文档可重试)");
        return;
      }
      setRewriteBox({ original: sel, result: r.content, start: selStart, end: selEnd, docId: reqDoc });
    } catch (e) { setErr((e as Error).message); } finally { setRewriting(""); }
  };

  const applyRewrite = () => {
    if (!rewriteBox || !taRef.current) return;
    const ta = taRef.current;
    const s = ta.value;
    // P1-2(审查): 优先按原选区位置切片替换(非首现); 校验区间文本仍等于原文才替换
    let start = -1;
    if (typeof rewriteBox.start === "number" && typeof rewriteBox.end === "number"
      && rewriteBox.start >= 0 && rewriteBox.end <= s.length) {
      const seg = s.slice(rewriteBox.start, rewriteBox.end);
      if (seg.trim() === rewriteBox.original.trim()) { start = rewriteBox.start; }
    }
    if (start < 0) {
      // 选区已不在(用户改了) → 找唯一匹配兜底; 多处匹配不替换(防错位)
      const first = s.indexOf(rewriteBox.original);
      const second = first >= 0 ? s.indexOf(rewriteBox.original, first + 1) : -1;
      if (first >= 0 && second < 0) start = first;
    }
    if (start >= 0) {
      const next = s.slice(0, start) + rewriteBox.result + s.slice(start + rewriteBox.original.length);
      onContentChange(next);
      flash("已替换改写结果");
    } else {
      setErr("原文已变化/出现多处, 未自动替换 — 请手动粘贴改写结果");
    }
    setRewriteBox(null);
  };

  const doCheck = async () => {
    if (!content.trim()) { setErr("全文为空"); return; }
    setChecking(true); setErr("");
    try {
      // R6: 统一 AI job
      const r = await runAiJob<{ content: string }>({ action: "check", text: content, mode: checkMode, document_id: curId });
      let parsed: CheckResult | null = null;
      try { parsed = r.content ? JSON.parse(r.content) : null; } catch { /* 非 JSON 忽略 */ }
      setCheckResult(parsed ?? { mode: checkMode, modeName: "", checks: [{ name: "检查", ok: false, findings: [r.content || "无结果"] }] });
      setShowCheck(true);
    } catch (e) { setErr((e as Error).message); } finally { setChecking(false); }
  };

  // 图表代码 → 渲染 → 插入
  const doChart = async () => {
    if (!chartDesc.trim()) { setErr("请描述图表需求"); return; }
    setChartBusy(true); setErr("");
    try {
      const r = await j<{ pngRel: string; code: string }>("/api/editor/v1/chart-code", {
        method: "POST", body: JSON.stringify({ description: chartDesc }),
      });
      setChartArt({ pngRel: r.pngRel, code: r.code });
    } catch (e) { setErr((e as Error).message); } finally { setChartBusy(false); }
  };

  const insertChartMd = () => {
    if (!chartArt) return;
    const md = `\n\n![图表](/api/viz/files/${chartArt.pngRel})\n\n`;
    onContentChange(content + md);
    setShowChart(false); setChartArt(null); setChartDesc("");
    flash("图表已插入正文");
  };

  // 版本历史: 拉取 + 回档(任务4-2)
  const loadHistory = async () => {
    if (!curId) return;
    setHistBusy(true); setErr("");
    try {
      const r = await j<{ versions: Array<{ version: number; content_len: number; by_editor: string; created_at: string }> }>(`/api/editor/v1/documents/${curId}/versions`);
      setHistVers(r.versions ?? []);
      setShowHistory(true);
    } catch (e) { setErr((e as Error).message); } finally { setHistBusy(false); }
  };
  const restoreVersion = async (version: number) => {
    if (!curId) return;
    setHistBusy(true); setErr("");
    try {
      const r = await j<{ ok: boolean; restoredFrom: number; currentVersion: number }>(`/api/editor/v1/documents/${curId}/restore`, {
        method: "POST", body: JSON.stringify({ version }),
      });
      const doc = await j<{ document: { content: string; title: string } }>(`/api/editor/v1/documents/${curId}`);
      setContent(doc.document.content); setTitle(doc.document.title);
      setWordCount(doc.document.content.replace(/\s/g, "").length);
      setShowHistory(false);
      flash(`已回档到 v${r.restoredFrom} (新版本 v${r.currentVersion})`);
    } catch (e) { setErr((e as Error).message); } finally { setHistBusy(false); }
  };

  // 清理锁(卸载)
  useEffect(() => {
    return () => {
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      if (curIdRef.current) void j(`/api/editor/v1/documents/${curIdRef.current}/unlock`, { method: "POST", body: "{}" }).catch(() => {});
    };
  }, []);

  const wordCountNice = wordCount >= 10000 ? `${(wordCount / 10000).toFixed(1)} 万` : String(wordCount);

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      {/* 顶栏 */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-indigo-400" />
          <h2 className="text-base font-bold text-slate-100">学术编辑器</h2>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">科研工作台</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-slate-800/80 p-0.5">
            {([["edit", "编辑", <Pencil key="i" className="h-3 w-3" />], ["split", "双栏", <AlignLeft key="i" className="h-3 w-3" />], ["preview", "预览", <Eye key="i" className="h-3 w-3" />]] as Array<[string, string, React.ReactNode]>).map(([k, label, ic]) => (
              <button key={k} onClick={() => setView(k as never)}
                className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-[11px]", view === k ? "bg-slate-600 text-white" : "text-slate-400 hover:text-slate-200")}>
                {ic}{label}
              </button>
            ))}
          </div>
          <button data-control="editor_check" onClick={() => setShowCheck((v) => !v)} disabled={checking}
            className="flex items-center gap-1 rounded-lg bg-amber-600 px-2.5 py-1.5 text-xs text-white hover:bg-amber-500 disabled:opacity-50">
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />}全文检查
          </button>
          <button onClick={() => setShowChart((v) => !v)}
            className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs text-white hover:bg-indigo-500">
            <BarChart3 className="h-3.5 w-3.5" />图表
          </button>
          <button onClick={() => setShowAiPanel((v) => !v)}
            className={cn("flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs", showAiPanel ? "bg-slate-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700")}>
            <Sparkles className="h-3.5 w-3.5" /> AI面板
          </button>
          <button data-control="editor_import" onClick={() => fileRef.current?.click()} disabled={impBusy}
            className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50" title="导入 Word/TXT 即看">
            {impBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}导入 Word
          </button>
          {/* R7(闭源工具栏 导出): 按当前预览预设字体导出 docx */}
          {curId && (
            <button onClick={() => void exportDocx()} disabled={expBusy}
              className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50" title={`导出 Word(${DOC_STYLES[docStyle]?.docxFont ?? "SimSun"})`}>
              {expBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}导出 Word
            </button>
          )}
          <button data-control="editor_new" onClick={() => setShowNewDoc(true)} className="flex items-center gap-1 rounded-lg bg-cyan-600 px-2.5 py-1.5 text-xs text-white hover:bg-cyan-500">
            <Plus className="h-3.5 w-3.5" />新建文档
          </button>
          {curId && (
            <button onClick={() => (showHistory ? setShowHistory(false) : void loadHistory())} disabled={histBusy}
              className={cn("flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs", showHistory ? "bg-slate-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700")}
              title="查看历史版本">
              {histBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <HistoryIcon className="h-3.5 w-3.5" />}版本历史
            </button>
          )}
          <input ref={fileRef} type="file" accept=".docx,.txt,.md" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importWord(f); }} />
        </div>
      </div>

      {/* 版本历史抽屉 */}
      {showHistory && curId && (
        <div className="mb-2 rounded-xl border border-slate-600/60 bg-slate-900/90 p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[11px] font-semibold text-slate-200">版本时间线 ({histVers.length})</p>
            <button onClick={() => setShowHistory(false)} className="rounded p-0.5 text-slate-500 hover:text-slate-300"><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="max-h-44 space-y-1 overflow-y-auto">
            {histVers.map((v) => (
              <div key={v.version} className="flex items-center justify-between rounded-lg bg-slate-800/60 px-2 py-1.5 text-[10px]">
                <div className="flex items-center gap-2">
                  <span className={cn("rounded px-1.5 py-0.5 font-bold", v.version === 1 ? "bg-slate-700 text-slate-300" : "bg-cyan-600/20 text-cyan-300")}>v{v.version}</span>
                  <span className="text-slate-400">{new Date(v.created_at).toLocaleString()}</span>
                  <span className="text-slate-500">{(v.content_len / 1000).toFixed(1)}k 字 · {v.by_editor === "restore" ? "回档" : v.by_editor === "editor" ? "编辑" : "导入"}</span>
                </div>
                <button onClick={() => restoreVersion(v.version)} disabled={histBusy}
                  className="rounded bg-slate-700 px-2 py-0.5 text-[10px] text-slate-200 hover:bg-amber-600/40 hover:text-amber-200 disabled:opacity-50">
                  {histBusy ? "…" : "回档到此"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {(err || okMsg) && (
        <div className={cn("mb-2 flex items-center justify-between rounded-lg px-3 py-1.5 text-xs", err ? "border border-red-500/30 bg-red-500/10 text-red-300" : "border border-green-500/30 bg-green-500/10 text-green-300")}>
          <span>{err || okMsg}</span>
          <button onClick={() => { setErr(""); setOkMsg(""); }}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* A6(闭源 ade-ai-panel-width): AI 面板宽 CSS 变量驱动+拖拽持久化 */}
      <div className={cn("grid min-h-0 flex-1 gap-3", showAiPanel ? "grid-cols-[200px_1fr_var(--ai-panel-w,340px)]" : "grid-cols-[200px_1fr]")}
        style={{ "--ai-panel-w": aiPanelW } as React.CSSProperties}>
        {/* 文档列表 */}
        <div className="flex min-h-0 flex-col overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-900/50 p-2">
          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase text-slate-500">我的文档 ({docs.length})</p>
          {docs.length === 0 && <p className="px-1 text-[11px] text-slate-600">暂无文档</p>}
          {docs.map((d) => (
            <div key={d.id} className={cn("group mb-1 cursor-pointer rounded-lg px-2 py-1.5", curId === d.id ? "bg-indigo-600/20 text-indigo-200" : "hover:bg-slate-800 text-slate-300")}>
              <div className="flex items-center justify-between">
                <p className="truncate text-[11px] font-medium" onClick={() => openDoc(d.id)}>{d.title}</p>
                <button onClick={() => setDelAsk({ id: d.id })} className="hidden text-slate-500 hover:text-red-400 group-hover:block"><Trash2 className="h-3 w-3" /></button>
              </div>
              <p className="text-[9px] text-slate-500">{d.word_count} 字 · {new Date(d.updated_at).toLocaleDateString()}</p>
            </div>
          ))}
        </div>

        {/* 编辑器主区 */}
        {!curId ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-slate-700/60 bg-slate-900/50">
            <FileText className="h-12 w-12 text-slate-700" />
            <p className="mt-3 text-sm text-slate-500">选择或新建一个文档开始写作</p>
            {/* 空态双按钮(闭源: 新建文档 + 上传 Word) */}
            <div className="mt-3 flex gap-2">
              <button onClick={() => setShowNewDoc(true)} data-control="editor_empty_new" className="rounded-lg bg-cyan-600 px-4 py-2 text-xs text-white hover:bg-cyan-500">新建文档</button>
              <button onClick={() => fileRef.current?.click()} disabled={impBusy} className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-50">
                {impBusy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <Upload className="mr-1 inline h-3 w-3" />}上传 Word
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col rounded-xl border border-slate-700/60 bg-slate-900/50">
            {/* 文档工具条 */}
            <div className="flex items-center justify-between border-b border-slate-700/50 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <button onClick={() => setCurId(null)} className="text-slate-400 hover:text-slate-200"><ChevronLeft className="h-4 w-4" /></button>
                <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void saveNow()}
                  className="w-64 rounded border border-transparent bg-transparent px-1 text-sm font-semibold text-slate-100 hover:border-slate-600 focus:border-slate-500 focus:bg-slate-800" />
                {lockedBy && <Lock className="h-3 w-3 text-amber-400" />}
              </div>
              <div className="flex items-center gap-2 text-[10px] text-slate-500">
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                <span>{wordCountNice} 字</span>
                <button onClick={() => void saveNow()} className="flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700">
                  <Save className="h-3 w-3" />保存
                </button>
              </div>
            </div>

            {/* 编辑区 */}
            <div className={cn("min-h-0 flex-1", view === "edit" ? "flex" : view === "preview" ? "flex" : "grid grid-cols-2")}>
              {view !== "preview" && (
                <div className="relative flex min-h-0 min-w-0 flex-col border-r border-slate-700/40">
                  <textarea ref={taRef} value={content}
                    onChange={(e) => onContentChange(e.target.value)}
                    onMouseUp={() => setSelText(grabSelection())}
                    onKeyUp={() => setSelText(grabSelection())}
                    placeholder={"# 论文标题\n\n在这里开始写作…(markdown 语法, 双栏预览)\n\n## 一、引言\n\n…"}
                    className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[12px] leading-relaxed text-slate-200 placeholder:text-slate-600 focus:outline-none" />
                  {/* 选区改写悬浮条 */}
                  {selText && (
                    <div className="absolute bottom-2 left-2 rounded-lg border border-indigo-500/40 bg-slate-800 p-1.5 shadow-xl">
                      <p className="mb-1 flex items-center gap-1 px-1 text-[9px] text-indigo-300"><Sparkles className="h-2.5 w-2.5" />改写选中文字 ({selText.length}字):</p>
                      <div className="flex flex-wrap gap-1">
                        {REWRITE_MODES.map((m) => (
                          <button key={m.key} onClick={() => doRewrite(m.key)} disabled={!!rewriting} title={m.desc}
                            className="rounded bg-indigo-600/40 px-1.5 py-0.5 text-[10px] text-indigo-100 hover:bg-indigo-600 disabled:opacity-50">
                            {rewriting === m.key ? <Loader2 className="mr-0.5 inline h-2.5 w-2.5 animate-spin" /> : null}{m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {view !== "edit" && (
                <div className="flex min-h-0 flex-col">
                  {/* T5-3: 预览风格切换(闭源 EditorView formatPresets: 4 套+desc+CSS 变量驱动) */}
                  <div className="flex items-center gap-1 border-b border-slate-700/40 px-2 py-1">
                    <span className="text-[9px] text-slate-500">预览风格</span>
                    {Object.entries(DOC_STYLES).map(([k, s]) => (
                      <button key={k} onClick={() => setDocStyle(k)} title={s.desc}
                        className={cn("rounded-full border px-2 py-0.5 text-[9px]", docStyle === k ? "border-indigo-500/60 bg-indigo-600/20 text-indigo-200" : "border-slate-600/60 bg-slate-800 text-slate-400 hover:text-slate-200")}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                  {/* R5: 预览走 MarkdownRich(KaTeX 公式+代码高亮, 对齐闭源 AI 面板双渲染) */}
                  {/* A4(闭源 210mm A4 纸面视口): 预览正文包白色纸面卡, CSS 变量驱动排版预设 */}
                  <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" style={{ background: "#3a3f4b" }}>
                    <div className="mx-auto max-w-[210mm] rounded-sm bg-white px-[2.5rem] py-16 shadow-[0_2px_16px_rgba(0,0,0,0.35)]">
                      <div className="markdown-rich-body" style={DOC_STYLES[docStyle]?.style}>
                        <MarkdownRich content={content || "*（空文档）*"} />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 改写结果确认条 */}
            {rewriteBox && (
              <div className="border-t border-indigo-500/30 bg-indigo-500/5 p-3">
                <p className="mb-1.5 text-[10px] font-semibold text-indigo-300">改写结果</p>
                <div className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto">
                  <div className="rounded bg-slate-900/60 p-2">
                    <p className="mb-1 text-[9px] uppercase text-slate-500">原文</p>
                    <p className="text-[11px] leading-relaxed text-slate-400">{rewriteBox.original.slice(0, 600)}</p>
                  </div>
                  <div className="rounded bg-slate-900/60 p-2">
                    <p className="mb-1 text-[9px] uppercase text-emerald-500">改写</p>
                    <p className="text-[11px] leading-relaxed text-slate-200">{rewriteBox.result}</p>
                  </div>
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <button onClick={() => setRewriteBox(null)} className="rounded bg-slate-700 px-3 py-1 text-[11px] text-slate-300 hover:bg-slate-600">放弃</button>
                  <button onClick={applyRewrite} className="rounded bg-indigo-600 px-3 py-1 text-[11px] text-white hover:bg-indigo-500">替换原文</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 全文检查抽屉 */}
      {showCheck && curId && (
        <div className="absolute bottom-4 right-4 z-20 max-h-96 w-96 overflow-y-auto rounded-xl border border-amber-500/40 bg-slate-900/95 p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
              <ClipboardCheck className="h-3.5 w-3.5" /> 全文一致性检查
              <span className="text-[9px] font-normal text-slate-500">(不验证文献真实性)</span>
            </p>
            <button onClick={() => setShowCheck(false)} className="text-slate-400 hover:text-slate-200"><X className="h-4 w-4" /></button>
          </div>
          {/* P-C: 闭源 4 检查模式选择(检查项卡片, 单选) */}
          {!checkResult && (
            <div className="mb-2 space-y-1">
              <p className="text-[9px] text-slate-500">检查结构、论证和一致性, 只给修改建议, 不直接改正文。</p>
              {CHECK_MODES.map((md) => (
                <button key={md.k} onClick={() => setCheckMode(md.k)}
                  className={cn("w-full rounded-lg border px-2 py-1.5 text-left", checkMode === md.k ? "border-amber-500/50 bg-amber-500/10" : "border-slate-700/50 bg-slate-800/40 hover:border-slate-500/50")}>
                  <p className={cn("text-[11px] font-medium", checkMode === md.k ? "text-amber-200" : "text-slate-200")}>{md.name}</p>
                  <p className="text-[9px] text-slate-500">{md.desc}</p>
                </button>
              ))}
            </div>
          )}
          {!checkResult ? (
            <button onClick={doCheck} disabled={checking}
              className="w-full rounded-lg bg-amber-600 py-2 text-xs text-white hover:bg-amber-500 disabled:opacity-50">
              {checking ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <Search className="mr-1 inline h-3 w-3" />}运行{CHECK_MODES.find((m) => m.k === checkMode)?.name ?? "检查"}
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-[10px] text-amber-300/80">模式: {checkResult.modeName ?? checkResult.checks[0]?.name ?? "检查"} {checkResult.checks.every((c) => c.ok) ? "· ✓ 未发现问题" : `· 发现 ${checkResult.checks.reduce((a, c) => a + c.findings.length, 0)} 处问题`}</p>
              {checkResult.checks.map((c) => (
                <div key={c.name} className={cn("rounded-lg border p-2", c.ok ? "border-green-500/30 bg-green-500/5" : "border-amber-500/30 bg-amber-500/5")}>
                  <p className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                    {c.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-green-400" /> : <X className="h-3.5 w-3.5 text-amber-400" />}
                    {c.name}
                  </p>
                  {c.findings.map((f, i) => <p key={i} className="mt-1 text-[10px] leading-relaxed text-slate-400">· {f}</p>)}
                </div>
              ))}
              <button onClick={() => setCheckResult(null)} className="w-full rounded bg-slate-800 py-1.5 text-[11px] text-slate-300 hover:bg-slate-700">重新检查</button>
            </div>
          )}
        </div>
      )}

      {/* 图表插入抽屉 */}
      {showChart && curId && (
        <div className="absolute bottom-4 right-4 z-20 w-96 rounded-xl border border-indigo-500/40 bg-slate-900/95 p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-indigo-300"><BarChart3 className="h-3.5 w-3.5" /> AI 图表生成</p>
            <button onClick={() => setShowChart(false)} className="text-slate-400 hover:text-slate-200"><X className="h-4 w-4" /></button>
          </div>
          <textarea value={chartDesc} onChange={(e) => setChartDesc(e.target.value)} rows={2} placeholder="描述图表… 如: 按年份的 GDP 折线图(无数据则画示意图)"
            className="w-full resize-none rounded-lg border border-slate-600/60 bg-slate-800 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-500" />
          {/* T5-4: 图表类型快捷预设(闭源 EditorView 图表 tab 对齐) */}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {CHART_TYPES.map((c) => (
              <button key={c.k} onClick={() => setChartDesc(c.tpl)}
                className={cn("rounded-full border px-2 py-0.5 text-[9px]", chartDesc === c.tpl ? "border-indigo-500/60 bg-indigo-600/20 text-indigo-200" : "border-slate-600/60 bg-slate-800 text-slate-400 hover:text-slate-200")}>
                {c.label}
              </button>
            ))}
          </div>
          <button onClick={doChart} disabled={chartBusy || !chartDesc.trim()}
            className="mt-1.5 w-full rounded-lg bg-indigo-600 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50">
            {chartBusy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <Wand2 className="mr-1 inline h-3 w-3" />}生成图表
          </button>
          {chartArt && (
            <div className="mt-2">
              <img src={`/api/viz/files/${chartArt.pngRel}`} alt="chart" className="max-h-48 w-full rounded border border-slate-700/50 object-contain" />
              <button onClick={insertChartMd} className="mt-1.5 w-full rounded-lg bg-emerald-600 py-1.5 text-xs text-white hover:bg-emerald-500">
                <ImageIcon className="mr-1 inline h-3 w-3" />插入正文
              </button>
            </div>
          )}
        </div>
      )}

      {/* UI审计T5: AI 面板(第三栏) */}
      {showAiPanel && curId && (
        <div className="relative flex min-h-0 flex-col">
          {/* A6: 左缘拖拽调宽 handle(闭源 ade-ai-panel__resize-handle) */}
          <div onPointerDown={onAiPanelDrag} title="拖动调整面板宽度"
            className="absolute -left-1 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-cyan-500/30" />
          <AiEditorPanel
            content={content}
            title={title}
            selText={selText || grabSelection()}
            onInsert={(t) => { onContentChange(content + String.fromCharCode(10,10) + t); flash('已插入到文末'); }}
            onApplyTitle={(t) => { setTitle(t); void saveNow(); flash('标题已更新'); }}
            onMsg={(m) => setErr(m)}
          />
        </div>
      )}
      {/* A5(闭源 ai-apply 事件): AI 结果经 window CustomEvent 落文 — 主组件先做选区原文回读校验
          再决定覆盖选区(改写)或文末追加(生成)。兼容 props onInsert(老调用), 事件为统一通道 */}
      <ApplyAiResultBridge content={content} onContentChange={onContentChange} onFlash={flash} selText={selText} taRef={taRef} />
      <ConfirmDialog spec={delAsk ? { title: "删除文档?", desc: "将永久删除该文档(含全部保存版本), 不可恢复。", confirmText: "删除", danger: true } : null}
        onDone={(ok) => { if (ok && delAsk) void removeDoc(delAsk.id); else setDelAsk(null); }} />

      {/* 新建文档弹层(闭源: 标题 input + 取消/创建) */}
      {showNewDoc && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={() => { setShowNewDoc(false); setNewTitle(""); }}>
          <div className="w-full max-w-sm rounded-xl border border-slate-600/60 bg-slate-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <p className="mb-3 text-sm font-semibold text-slate-100">新建文档</p>
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void newDoc(); }}
              autoFocus placeholder="未命名论文" className="w-full rounded-lg border border-slate-600/60 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500" />
            <div className="mt-3 flex gap-2">
              <button onClick={() => { setShowNewDoc(false); setNewTitle(""); }} className="flex-1 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-400 hover:bg-slate-700">取消</button>
              <button onClick={() => void newDoc()} disabled={busy} className="flex-1 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50">创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A5(闭源 window CustomEvent ai-apply/ai-insert-chart): AI 面板结果统一经事件总线落文。
 *  改写场景带 originalText → 主组件做选区原文回读校验(避免用户在 AI 生成期间改了选区);
 *  校验失败则降级文末追加并提示。 */
function ApplyAiResultBridge({ content, onContentChange, onFlash, selText, taRef }: {
  content: string; onContentChange: (v: string) => void; onFlash: (m: string) => void; selText: string;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  useEffect(() => {
    const onApply = (e: Event) => {
      const d = (e as CustomEvent<{ text?: string; kind?: string; originalText?: string }>).detail;
      if (!d?.text) return;
      // 选区原文回读校验: 期望的 originalText 与当前选中/最近上下文一致才覆盖选区
      if (d.kind === "rewrite" && d.originalText) {
        const expect = d.originalText.trim();
        const ta = taRef.current;
        if (ta) {
          const s = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
          if (s && s !== expect) {
            // 用户在 AI 生成期间改动了选区 → 降级文末追加(不覆盖用户新内容)
            onContentChange(content + String.fromCharCode(10, 10) + d.text);
            onFlash("选区已变化, AI 结果已追加到文末(未覆盖你的新内容)");
            return;
          }
          if (s === expect && s.length > 0) {
            // 覆盖选区
            const start = ta.selectionStart; const end = ta.selectionEnd;
            const next = ta.value.slice(0, start) + d.text + ta.value.slice(end);
            onContentChange(next);
            onFlash("已替换选中文本");
            return;
          }
        }
        // 无活动选区: 回读最近文本兜底
        if (selText?.trim() && selText.trim() === expect) {
          onContentChange(content.replace(expect, d.text));
          onFlash("已替换选中文本");
          return;
        }
      }
      // 普通生成 → 文末追加
      onContentChange(content + String.fromCharCode(10, 10) + d.text);
      onFlash("已插入到文末");
    };
    const onInsertChart = (e: Event) => {
      const d = (e as CustomEvent<{ markdown?: string }>).detail;
      if (!d?.markdown) return;
      onContentChange(content + String.fromCharCode(10, 10) + d.markdown);
      onFlash("图表已插入到文末");
    };
    window.addEventListener("ai-apply", onApply);
    window.addEventListener("ai-insert-chart", onInsertChart);
    return () => { window.removeEventListener("ai-apply", onApply); window.removeEventListener("ai-insert-chart", onInsertChart); };
  }, [content, selText, onContentChange, onFlash]);
  return null;
}
export function AiEditorPanel(props: {
  content: string; title: string; selText: string;
  onInsert: (t: string) => void; onApplyTitle: (t: string) => void; onMsg: (m: string) => void;
}) {
  const { content, title, selText, onInsert, onApplyTitle, onMsg } = props;
  const [tab, setTab] = useState<"check" | "rewrite" | "title" | "refs" | "format" | "chart">("check");
  const [checkResult, setCheckResult] = useState<{ modeName?: string; checks: Array<{ name: string; ok: boolean; findings: string[] }> } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkMode, setCheckMode] = useState("logic"); // P-C: 闭源 4 检查模式
  const [taResult, setTaResult] = useState<{ title: string; abstract: string; keywords: string[] } | null>(null);
  const [taBusy, setTaBusy] = useState(false);
  const [rewriteSel, setRewriteSel] = useState("");
  const [rewriteMode, setRewriteMode] = useState("polish");
  const [rwBusy, setRwBusy] = useState(false);
  const [rwResult, setRwResult] = useState("");
  const [fmtText, setFmtText] = useState("");
  const [fmtResult, setFmtResult] = useState("");
  const [fmtBusy, setFmtBusy] = useState(false);
  // P-C 遗留处理: AiEditorPanel 补图表页签(闭源辅助工具 6 页签之六)
  const [chartDesc, setChartDesc] = useState("");
  const [chartType, setChartType] = useState("flow");
  const [chartBusy, setChartBusy] = useState(false);
  const [chartArt, setChartArt] = useState<{ pngRel: string; code: string } | null>(null);
  const doChartPanel = async () => {
    const desc = chartDesc.trim() || CHART_TYPES.find((c) => c.k === chartType)?.tpl || "画示意图";
    if (!content.trim()) { onMsg("全文为空, 无法生成图表"); return; }
    setChartBusy(true);
    try {
      const r = await j<{ pngRel: string; code: string }>("/api/editor/v1/chart-code", {
        method: "POST", body: JSON.stringify({ description: desc }),
      });
      setChartArt(r);
    } catch (e) { onMsg((e as Error).message); } finally { setChartBusy(false); }
  };

  const doCheck = async () => {
    if (!content.trim()) { onMsg("全文为空"); return; }
    setChecking(true);
    try {
      // R6: 走统一 AI job(SSE delta/done + 断线可恢复)
      const r = await runAiJob<{ content: string; text?: string }>({ action: "check", text: content, mode: checkMode, document_id: undefined });
      let parsed: { modeName?: string; checks: Array<{ name: string; ok: boolean; findings: string[] }> } | null = null;
      try { parsed = r.content ? JSON.parse(r.content) : null; } catch { /* 非 JSON 忽略 */ }
      setCheckResult(parsed ?? { checks: [{ name: checkMode, ok: false, findings: [r.content || "无结果"] }] });
    } catch (e) { onMsg((e as Error).message); } finally { setChecking(false); }
  };
  const doTitle = async () => {
    if (!content.trim()) { onMsg("全文为空"); return; }
    setTaBusy(true);
    try {
      const r = await j<{ title: string; abstract: string; keywords: string[] }>("/api/editor/v1/title-abstract", { method: "POST", body: JSON.stringify({ text: content }) });
      setTaResult(r);
    } catch (e) { onMsg((e as Error).message); } finally { setTaBusy(false); }
  };
  const doRewrite = async () => {
    const sel = rewriteSel || selText;
    if (!sel) { onMsg("请先选中文字或粘贴到面板"); return; }
    setRwBusy(true);
    try {
      // R6: 统一 AI job
      const r = await runAiJob<{ content: string }>({ action: "rewrite", mode: rewriteMode, text: sel, document_id: undefined });
      setRwResult(r.content);
    } catch (e) { onMsg((e as Error).message); } finally { setRwBusy(false); }
  };
  const doFormat = async () => {
    const txt = fmtText.trim() || selText;
    if (!txt) { onMsg("请粘贴文本或选中正文"); return; }
    setFmtBusy(true);
    try {
      const r = await j<{ text: string }>("/api/editor/v1/rewrite", { method: "POST", body: JSON.stringify({ mode: "journal-style", text: txt }) });
      setFmtResult(r.text);
    } catch (e) { onMsg((e as Error).message); } finally { setFmtBusy(false); }
  };
  const [refText, setRefText] = useState("");
  const [refResult, setRefResult] = useState<{ text: string; fixes: string[] } | null>(null);
  const [refBusy, setRefBusy] = useState(false);
  const doRefs = async () => {
    if (!refText.trim()) { onMsg("请粘贴参考文献"); return; }
    setRefBusy(true);
    try {
      const r = await j<{ text: string; fixes: string[] }>("/api/editor/v1/format-references", { method: "POST", body: JSON.stringify({ text: refText }) });
      setRefResult(r);
    } catch (e) { onMsg((e as Error).message); } finally { setRefBusy(false); }
  };
  const tabs = [
    // P-C 遗留处理: 页签排序对齐闭源 EditorView 辅助工具浮层(全文检查/选区修改/题名摘要/引用格式/格式模板/图表)
    { k: "check" as const, label: "全文检查", icon: <ClipboardCheck className="h-3 w-3" /> },
    { k: "rewrite" as const, label: "选区修改", icon: <Wand2 className="h-3 w-3" /> },
    { k: "title" as const, label: "题名摘要", icon: <FileText className="h-3 w-3" /> },
    { k: "refs" as const, label: "引用格式", icon: <FileText className="h-3 w-3" /> },
    { k: "format" as const, label: "格式模板", icon: <AlignLeft className="h-3 w-3" /> },
    { k: "chart" as const, label: "图表", icon: <BarChart3 className="h-3 w-3" /> },
  ];
  return (
    <div className="flex min-h-0 flex-col rounded-xl border border-slate-700/60 bg-slate-900/95">
      <div className="border-b border-slate-700/50 px-2 py-1.5">
        <span className="flex items-center gap-1 text-[11px] font-semibold text-indigo-300"><Sparkles className="h-3 w-3" /> AI 编辑助手</span>
      </div>
      <div className="flex gap-0.5 border-b border-slate-700/40 px-1.5 py-1">
        {tabs.map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)}
            className={cn("flex flex-1 items-center justify-center gap-1 rounded px-1 py-1 text-[9px]", tab === t.k ? "bg-indigo-600/40 text-indigo-100" : "text-slate-500 hover:text-slate-300")}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 text-[11px]">
        {tab === "check" && (
          <div className="space-y-1.5">
            {/* P-C: 闭源 4 检查模式 */}            {CHECK_MODES.map((md) => (
              <button key={md.k} onClick={() => { setCheckMode(md.k); setCheckResult(null); }}
                className={cn("w-full rounded-lg border px-2 py-1.5 text-left", checkMode === md.k ? "border-amber-500/50 bg-amber-500/10" : "border-slate-700/50 bg-slate-800/40")}>
                <p className={cn("text-[10px] font-medium", checkMode === md.k ? "text-amber-200" : "text-slate-300")}>{md.name}</p>
                <p className="text-[8px] text-slate-500">{md.desc}</p>
              </button>
            ))}
            <button onClick={doCheck} disabled={checking}
              className="w-full rounded-lg bg-amber-600 py-1.5 text-[11px] text-white hover:bg-amber-500 disabled:opacity-50">
              {checking ? "检查中…" : `运行${CHECK_MODES.find((m) => m.k === checkMode)?.name ?? "检查"}`}
            </button>
            {checkResult?.checks.map((c, i) => (
              <div key={i} className={cn("rounded border p-1.5", c.ok ? "border-green-500/30 bg-green-500/5" : "border-amber-500/30 bg-amber-500/5")}>
                <p className="flex items-center gap-1 text-[10px] font-medium text-slate-200">{c.ok ? "✓" : "✗"} {c.name}</p>
                {c.findings.map((fd, j) => <p key={j} className="mt-0.5 text-[9px] text-slate-400">· {fd}</p>)}
              </div>
            ))}
          </div>
        )}
        {tab === "title" && (
          <div className="space-y-1.5">
            <p className="text-[9px] text-slate-500">从全文提炼优化标题/摘要/关键词</p>
            <button onClick={doTitle} disabled={taBusy}
              className="w-full rounded-lg bg-indigo-600 py-1.5 text-[11px] text-white hover:bg-indigo-500 disabled:opacity-50">
              {taBusy ? "生成中…" : "生成标题+摘要+关键词"}
            </button>
            {taResult && (
              <div className="space-y-1.5">
                <div className="rounded bg-slate-800/60 p-1.5">
                  <p className="text-[9px] font-bold text-indigo-300">建议标题</p>
                  <p className="text-[10px] text-slate-200">{taResult.title}</p>
                  <button onClick={() => onApplyTitle(taResult.title)} className="mt-1 rounded bg-indigo-600 px-2 py-0.5 text-[9px] text-white">采纳标题</button>
                </div>
                <div className="rounded bg-slate-800/60 p-1.5">
                  <p className="text-[9px] font-bold text-indigo-300">摘要</p>
                  <p className="text-[9px] leading-relaxed text-slate-300">{taResult.abstract}</p>
                  <button onClick={() => onInsert("**摘要**\n" + taResult.abstract)} className="mt-1 rounded bg-emerald-600 px-2 py-0.5 text-[9px] text-white">插入文末</button>
                </div>
                <div className="rounded bg-slate-800/60 p-1.5">
                  <p className="text-[9px] font-bold text-indigo-300">关键词</p>
                  <p className="text-[9px] text-slate-300">{taResult.keywords.join("、")}</p>
                </div>
              </div>
            )}
          </div>
        )}
        {tab === "rewrite" && (
          <div className="space-y-1.5">
            <p className="text-[9px] text-slate-500">{selText ? "正文已选中 " + selText.length + " 字, 直接点改写" : "未选中文字 — 可粘贴要改写的段落"}</p>
            <textarea value={rewriteSel} onChange={(e) => setRewriteSel(e.target.value)} rows={3} placeholder="要改写的文本…"
              className="w-full resize-none rounded border border-slate-600/60 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
            <div className="flex gap-1">
              {([["polish", "润色"], ["condense", "压缩"], ["journal-style", "期刊"], ["humanize", "去AI痕迹"]] as Array<[string, string]>).map(([k, lb]) => (
                <button key={k} onClick={() => setRewriteMode(k)}
                  className={cn("flex-1 rounded py-1 text-[9px]", rewriteMode === k ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-400")}>{lb}</button>
              ))}
            </div>
            <button onClick={doRewrite} disabled={rwBusy}
              className="w-full rounded-lg bg-indigo-600 py-1.5 text-[11px] text-white hover:bg-indigo-500 disabled:opacity-50">{rwBusy ? "改写中…" : "执行改写"}</button>
            {rwResult && (
              <div className="space-y-1">
                <p className="text-[9px] font-bold text-emerald-400">改写结果</p>
                <p className="rounded bg-slate-800/60 p-1.5 text-[9px] leading-relaxed text-slate-300">{rwResult}</p>
                <button onClick={() => onInsert(rwResult)} className="w-full rounded bg-emerald-600 py-1 text-[9px] text-white">插入到文末</button>
              </div>
            )}
          </div>
        )}
        {tab === "format" && (
          <div className="space-y-1.5">
            <p className="text-[9px] text-slate-500">中文期刊风格化(用于选中/粘贴段落)</p>
            <textarea value={fmtText} onChange={(e) => setFmtText(e.target.value)} rows={3} placeholder="粘贴要格式化的文本(空则用当前选中)…"
              className="w-full resize-none rounded border border-slate-600/60 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
            <button onClick={doFormat} disabled={fmtBusy}
              className="w-full rounded-lg bg-cyan-600 py-1.5 text-[11px] text-white hover:bg-cyan-500 disabled:opacity-50">{fmtBusy ? "处理中…" : "期刊风格化"}</button>
            {fmtResult && (
              <div className="space-y-1">
                <p className="text-[9px] font-bold text-cyan-400">结果</p>
                <p className="rounded bg-slate-800/60 p-1.5 text-[9px] leading-relaxed text-slate-300">{fmtResult}</p>
                <button onClick={() => onInsert(fmtResult)} className="w-full rounded bg-emerald-600 py-1 text-[9px] text-white">插入到文末</button>
              </div>
            )}
          </div>
        )}
        {tab === "refs" && (
          <div className="space-y-1.5">
            <p className="text-[9px] text-slate-500">粘贴参考文献 → 规范化 GB/T7714 格式(修正卷期/页码/年份)</p>
            <textarea value={refText} onChange={(e) => setRefText(e.target.value)} rows={4} placeholder={"[1] 李海波. 数字经济发展水平测度与时空分异特征[J]. 商展经济, 2026(15):58-61.\n[2] ..."}
              className="w-full resize-none rounded border border-slate-600/60 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
            <button onClick={doRefs} disabled={refBusy}
              className="w-full rounded-lg bg-purple-600 py-1.5 text-[11px] text-white hover:bg-purple-500 disabled:opacity-50">{refBusy ? "规范化中…" : "GB/T7714 规范化"}</button>
            {refResult && (
              <div className="space-y-1">
                {refResult.fixes.length > 0 && (
                  <div className="rounded bg-amber-500/10 p-1.5">
                    <p className="text-[9px] font-bold text-amber-300">修正 {refResult.fixes.length} 处</p>
                    {refResult.fixes.map((fx, i) => <p key={i} className="text-[9px] text-amber-200/80">· {fx}</p>)}
                  </div>
                )}
                <p className="rounded bg-slate-800/60 p-1.5 text-[9px] leading-relaxed text-slate-300">{refResult.text}</p>
                <button onClick={() => onInsert(refResult.text)} className="w-full rounded bg-emerald-600 py-1 text-[9px] text-white">插入到文末</button>
              </div>
            )}
          </div>
        )}
        {/* P-C 遗留处理: 图表页签(闭源辅助工具 6 页签之六, 与主图表抽屉同链路) */}
        {tab === "chart" && (
          <div className="space-y-1.5">
            <p className="text-[9px] text-slate-500">描述图表需求 → AI 生成图表代码并渲染</p>
            <div className="flex flex-wrap gap-1">
              {CHART_TYPES.map((ct) => (
                <button key={ct.k} onClick={() => { setChartType(ct.k); setChartDesc(ct.tpl); setChartArt(null); }}
                  className={cn("rounded px-1.5 py-0.5 text-[9px]", chartType === ct.k ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-400")}>{ct.label}</button>
              ))}
            </div>
            <textarea value={chartDesc} onChange={(e) => setChartDesc(e.target.value)} rows={2} placeholder="如: 按年份的 GDP 折线图…"
              className="w-full resize-none rounded border border-slate-600/60 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
            <button onClick={doChartPanel} disabled={chartBusy}
              className="w-full rounded-lg bg-indigo-600 py-1.5 text-[11px] text-white hover:bg-indigo-500 disabled:opacity-50">
              {chartBusy ? "生成中…" : "生成图表"}
            </button>
            {chartArt && (
              <div className="space-y-1">
                <img src={`/api/viz/files/${chartArt.pngRel}`} alt="AI 图表" className="w-full rounded border border-slate-700/50 bg-slate-950" />
                <button onClick={() => onInsert(`\n\n![图表](/api/viz/files/${chartArt.pngRel})\n\n`)}
                  className="w-full rounded bg-emerald-600 py-1 text-[9px] text-white">插入到文末</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
