// ChatPanel.tsx — V398: AI 对话页（豆包式交互）
// 左侧会话管理侧边栏（新建/重命名/删除/置顶/折叠）+ 消息流（富渲染/引用/工具调用）+ 底部 Composer（模型/联网/附件/图片粘贴）
import { useEffect, useRef, useState, type FC } from "react";
import {
  Loader2, Plus, PanelLeftClose, PanelLeftOpen, Trash2, Pencil, Pin, PinOff,
  MessageSquare, Send, Square, Globe, ImagePlus, CheckCircle2, XCircle, Wrench, ChevronDown, ChevronRight, RotateCcw, Zap
} from "lucide-react";
import { api } from "../lib/api";
import type { McpMessageRecord, McpSessionRecord, McpToolCallRecord } from "../types";
import { MarkdownCitation } from "../lib/markdown";
import { cn, formatDate } from "../lib/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { MarkdownRich, MarkdownStreaming } from "./MarkdownRich";

export interface ChatDraftImage {
  dataUrl: string;
  name: string;
}

export interface ChatPanelProps {
  sessions: McpSessionRecord[];
  activeSessionId: string | null;
  messages: McpMessageRecord[];
  toolCalls: McpToolCallRecord[];
  pendingUserContent: string;
  streamingText: string;
  /** V398: 流式思考链（DeepSeek reasoning_content）— 折叠区展示 */
  reasoningText: string;
  isRunning: boolean;
  runningToolName: string | null;
  model: string;
  webSearch: boolean;
  /** V399: 深度模式 — 质量优先（文献必查/推理深化/轮次 20） */
  deepMode: boolean;
  collapsed: boolean;
  models: Array<{ id: string; label: string }>;
  /** V399: 待审批工具（review/manager 级弹窗确认） */
  approval: { approvalId: string; toolName: string; arguments: Record<string, unknown> } | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onSend: (content: string, images: ChatDraftImage[], webSearch: boolean, deepMode?: boolean) => void;
  onStop: () => void;
  onRecall: () => void;
  onApproveTool: (approvalId: string, approved: boolean) => void;
  onModelChange: (model: string) => void;
  onWebSearchChange: (value: boolean) => void;
  onDeepModeChange: (value: boolean) => void;
  onToggleCollapsed: () => void;
  onOpenCitation: (citation: MarkdownCitation) => void;
  onGoToView: (view: "ask" | "reason" | "empirical-research") => void;
}

/** 热词建议（豆包式首屏，点击即问） */
const SUGGESTIONS = [
  "分析剩余价值率的现实意义",
  "资本下乡对农村集体经济的双重效应",
  "比较 Keynes 与马克思的危机理论",
  "什么是超额剩余价值？"
];

/** 图片压缩：canvas 等比缩放 maxDim 1280 / JPEG 0.85，超限回退原图 */
export async function fileToDataUrl(file: File, maxDim = 1280): Promise<ChatDraftImage> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图片解码失败"));
      el.src = raw;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    if (scale >= 1 && raw.length <= 2 * 1024 * 1024) {
      return { dataUrl: raw, name: file.name || "paste.png" };
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { dataUrl: raw, name: file.name || "paste.png" };
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const compressed = canvas.toDataURL("image/jpeg", 0.85);
    return { dataUrl: compressed.length > 2 * 1024 * 1024 ? raw : compressed, name: file.name || "paste.png" };
  } catch {
    return { dataUrl: raw, name: file.name || "paste.png" };
  }
}

function MessageRoleBadge({ role }: { role: "user" | "assistant" }) {
  return (
    <span className={cn(
      "mb-1 flex items-center gap-1.5 text-xs",
      role === "user" ? "justify-end text-primary-foreground/70" : "text-muted-foreground"
    )}>
      {role === "user" ? "你" : (
        <>
          <span className="flex h-4 w-4 items-center justify-center rounded-sm bg-primary/20 text-[9px] font-bold text-primary">
            M
          </span>
          MarxSphere AI
        </>
      )}
    </span>
  );
}

function CitationStrip({ citations, onOpenCitation }: { citations: MarkdownCitation[]; onOpenCitation: (c: MarkdownCitation) => void }) {
  return (
    <div className="mt-3 border-t border-border/70 pt-2">
      <div className="mb-1 text-xs font-medium text-muted-foreground">引用原文</div>
      <div className="flex flex-wrap gap-1.5">
        {citations.map((citation) => (
          <button
            key={`${citation.index}-${citation.chunkId}`}
            type="button"
            className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-background px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            title={citation.heading || citation.chunkId}
            onClick={() => onOpenCitation(citation)}
          >
            {citation.index}
          </button>
        ))}
      </div>
    </div>
  );
}

/** V399: 工具元数据 — 英文工具名 → 中文功能名 + 数据源/数据库（工具链展示） */
const TOOL_META: Record<string, { label: string; source: string }> = {
  // Agent 工具
  sag_search: { label: "知识库检索", source: "PostgreSQL + 向量库（SAG 四源）" },
  sag_get_event: { label: "事件详情", source: "PostgreSQL（事件表）" },
  sag_reason: { label: "SAG 推理", source: "52 步推理链（Cognee/Graphiti/PG）" },
  sag_retrieve: { label: "文献检索", source: "文献库（500+ 论文）" },
  concept_trace: { label: "概念溯源", source: "知识图谱 + 文献库" },
  policy_search: { label: "政策检索", source: "政策库（gov.cn）" },
  empirical_analysis: { label: "实证分析", source: "Python 实证引擎" },
  llm_write: { label: "LLM 写作", source: "DeepSeek/Qwen" },
  summarize: { label: "内容摘要", source: "DeepSeek/Qwen" },
  review_output: { label: "质量评审", source: "DeepSeek/Qwen" },
  web_search: { label: "联网搜索", source: "Bing/百度/搜狗" },
  web_fetch: { label: "网页抓取", source: "外部网页" },
  run_code: { label: "代码执行", source: "Python/JS 沙箱" },
  runtime_exec: { label: "持久 Python", source: "Python 沙箱" },
  calc: { label: "计算器", source: "内置" },
  image_analyze: { label: "图片理解", source: "多模态 LLM" },
  audio_transcribe: { label: "音频转写", source: "语音模型" },
  attachment_read: { label: "附件读取", source: "附件文件" },
  file_read: { label: "文件读取", source: "本地文件" },
  file_write: { label: "文件写入", source: "本地文件" },
  apply_patch: { label: "精确补丁", source: "本地文件" },
  run_command: { label: "终端命令", source: "系统终端" },
  code_search: { label: "代码搜索", source: "代码库" },
  github_repo: { label: "GitHub 仓库", source: "GitHub API" },
  todo_update: { label: "待办管理", source: "任务系统" },
  agent_subagent: { label: "外部 Agent", source: "外部进程" },
  // 视图工具
  view_policy_tree: { label: "政策库检索", source: "政策库目录（Obsidian）" },
  view_truth_list: { label: "知识页检索", source: "知识页（PostgreSQL）" },
  view_literature_search: { label: "文献库检索", source: "文献库（500+ 论文元数据）" },
  view_sciverse_search: { label: "外部学术检索", source: "Sciverse（知网/万方）" },
  view_skill_search: { label: "技能检索", source: "技能库（103 个 Skill）" },
  view_skill_run: { label: "技能执行", source: "技能库 SKILL.md + references" },
  view_vault_tree: { label: "资料库检索", source: "资料库（Obsidian 目录）" },
  view_memory_context: { label: "记忆检索", source: "会话记忆（PostgreSQL）" },
  view_corpus_recall: { label: "写作语料", source: "写作语料库" },
  view_eval_report: { label: "评测报告", source: "Agent 评测（任务统计）" },
  view_ingest_status: { label: "入库监控", source: "Graphiti/Cognee 索引" },
  view_education_profile: { label: "学情画像", source: "自适应学习（PostgreSQL）" },
};

function toolMeta(name: string): { label: string; source: string } {
  return TOOL_META[name] ?? { label: name, source: "内置" };
}

/** V399: 工具链合并面板 — 默认折叠，摘要（N 次调用 · 成功率 · 总耗时），展开看每步详情 */
function ToolChain({ calls }: { calls: McpToolCallRecord[] }) {
  const [open, setOpen] = useState(false);
  const okCount = calls.filter((c) => c.status === "SUCCEEDED").length;
  const totalMs = calls.reduce((s, c) => s + (c.durationMs ?? 0), 0);
  return (
    <div className="mt-2.5 overflow-hidden rounded-lg border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <Wrench className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="font-medium text-foreground">工具链</span>
        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
          {calls.length} 次
        </span>
        <span className={cn("shrink-0 text-[10px]", okCount === calls.length ? "text-emerald-500" : "text-amber-500")}>
          {okCount === calls.length ? `全部成功` : `${okCount}/${calls.length} 成功`}
        </span>
        {totalMs > 0 ? <span className="shrink-0 text-[10px]">{(totalMs / 1000).toFixed(1)}s</span> : null}
        <span className="min-w-0 flex-1 truncate text-[10px] opacity-70">
          {calls.map((c) => toolMeta(c.toolName).label).join(" → ")}
        </span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="space-y-1.5 border-t border-border/60 p-2">
          {calls.map((call, i) => <ToolCallCard key={call.id} call={call} index={i + 1} />)}
        </div>
      ) : null}
    </div>
  );
}

/** V399: 工具链时间线卡片 — 序号 + 工具名 + 参数摘要 + 结果摘要 + 耗时，可展开详情 */
function ToolCallCard({ call, index }: { call: McpToolCallRecord; index: number }) {
  const [open, setOpen] = useState(false);
  const ok = call.status === "SUCCEEDED";
  const meta = toolMeta(call.toolName);
  const argsText = Object.entries(call.arguments ?? {})
    .map(([k, v]) => `${k}=${typeof v === "string" ? (v.length > 40 ? v.slice(0, 40) + "…" : v) : JSON.stringify(v).slice(0, 40)}`)
    .join(" · ");
  const resultText = typeof call.result === "string" ? call.result : JSON.stringify(call.result ?? call.error ?? {}, null, 2);
  return (
    <div className={cn(
      "rounded-md border px-2.5 py-1.5 text-xs",
      call.status === "FAILED" ? "border-red-400/30 bg-red-500/5" : ok ? "border-emerald-400/30 bg-emerald-500/5" : "border-blue-400/30 bg-blue-500/5"
    )}>
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        <span className={cn(
          "flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold",
          call.status === "FAILED" ? "bg-red-500/20 text-red-400" : ok ? "bg-emerald-500/20 text-emerald-400" : "bg-blue-500/20 text-blue-400"
        )}>
          {index}
        </span>
        {call.status === "FAILED" ? <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" /> : ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" /> : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-400" />}
        <span className="shrink-0 font-medium">{meta.label}</span>
        <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">{meta.source}</span>
        {argsText ? <span className="min-w-0 flex-1 truncate text-muted-foreground">{argsText}</span> : null}
        {call.durationMs != null ? <span className="shrink-0 text-muted-foreground">{call.durationMs}ms</span> : null}
        <ChevronDown className={cn("ml-auto h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1.5">
          <div className="rounded bg-background/60 px-2 py-1 text-[10px] leading-4 text-muted-foreground">
            📚 数据源: {meta.source} · 工具: <span className="font-mono">{call.toolName}</span>
          </div>
          {argsText ? (
            <div className="rounded bg-background/60 px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground">
              参数: {argsText}
            </div>
          ) : null}
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 font-mono text-[10px] leading-4 text-muted-foreground">
            {resultText.slice(0, 2000)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/** V398: 「已深度思考」折叠区（DeepSeek reasoning_content） */
function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 rounded-lg border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <span className="flex h-4 w-4 items-center justify-center rounded-sm bg-primary/15 text-[9px] text-primary">🧠</span>
        已深度思考
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="max-h-56 overflow-auto whitespace-pre-wrap border-t border-border/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
          {text}
        </div>
      ) : null}
    </div>
  );
}

export const ChatPanel: FC<ChatPanelProps> = (props) => {
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<ChatDraftImage[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      return JSON.parse(window.localStorage.getItem("sag:chat:pinned:v1") ?? "[]");
    } catch {
      return [];
    }
  });
  const [menuId, setMenuId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const activeSession = props.sessions.find((s) => s.id === props.activeSessionId) ?? null;

  // 自动滚动到底
  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [props.messages.length, props.pendingUserContent, props.streamingText, props.isRunning, props.toolCalls.length]);

  // Ctrl+K 新建会话（焦点不在输入框时）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        const el = document.activeElement;
        const typing = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
        if (!typing) {
          e.preventDefault();
          props.onCreateSession();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onCreateSession]);

  // 置顶持久化
  useEffect(() => {
    try {
      window.localStorage.setItem("sag:chat:pinned:v1", JSON.stringify(pinnedIds));
    } catch { /* ignore */ }
  }, [pinnedIds]);

  // 切换会话时聚焦输入框
  useEffect(() => {
    textareaRef.current?.focus();
  }, [props.activeSessionId]);

  const sortedSessions = [...props.sessions].sort((a, b) => {
    const aPinned = pinnedIds.includes(a.id) ? 1 : 0;
    const bPinned = pinnedIds.includes(b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  function handleSend() {
    const content = draft.trim();
    if (!content || props.isRunning) return;
    props.onSend(content, draftImages, props.webSearch, props.deepMode);
    setDraft("");
    setDraftImages([]);
  }

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      if (draftImages.length >= 6) break;
      try {
        const img = await fileToDataUrl(file);
        setDraftImages((prev) => [...prev, img]);
      } catch { /* ignore */ }
    }
  }

  const citationsFor = (message: McpMessageRecord): MarkdownCitation[] => {
    const raw = message.metadata?.citations;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c: any) => c && typeof c === "object" && Number.isFinite(c.index) && c.index > 0 && c.chunkId && c.content)
      .map((c: any) => ({
        index: c.index,
        chunkId: String(c.chunkId),
        sourceId: String(c.sourceId ?? ""),
        heading: c.heading ? String(c.heading) : undefined,
        content: String(c.content),
        rank: c.rank,
        score: c.score,
        query: c.query ? String(c.query) : undefined
      }))
      .slice(0, 8);
  };

  const toolCallsFor = (messageId: string) => props.toolCalls.filter((t) => t.messageId === messageId).slice(-4);

  return (
    <section className="flex min-h-0 flex-1 overflow-hidden">
      {/* ── 左侧会话侧边栏 ── */}
      <aside className={cn(
        "flex shrink-0 flex-col border-r border-border bg-background/60 transition-[width] duration-300",
        props.collapsed ? "w-14" : "w-60"
      )}>
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-2">
          {!props.collapsed ? (
            <>
              <span className="pl-2 text-sm font-semibold">对话记录</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={props.onCreateSession}
                  title="新建会话 (Ctrl+K)"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Plus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={props.onToggleCollapsed}
                  title="折叠侧边栏"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={props.onToggleCollapsed}
              title="展开侧边栏"
              className="mx-auto flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {props.collapsed ? (
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={props.onCreateSession}
                title="新建会话"
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Plus className="h-4 w-4" />
              </button>
              {sortedSessions.slice(0, 8).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => props.onSelectSession(s.id)}
                  title={s.title}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-md",
                    s.id === props.activeSessionId ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent"
                  )}
                >
                  <MessageSquare className="h-4 w-4" />
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-0.5">
              {sortedSessions.map((session) => {
                const active = session.id === props.activeSessionId;
                const pinned = pinnedIds.includes(session.id);
                return (
                  <div
                    key={session.id}
                    className={cn(
                      "group relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                      active ? "bg-primary/12 font-medium text-primary" : "text-muted-foreground hover:bg-accent"
                    )}
                    onClick={() => props.onSelectSession(session.id)}
                    onMouseEnter={() => setMenuId(session.id)}
                    onMouseLeave={() => setMenuId(null)}
                  >
                    {renamingId === session.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && renameValue.trim()) {
                            props.onRenameSession(session.id, renameValue.trim());
                            setRenamingId(null);
                          }
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        onBlur={() => {
                          if (renameValue.trim()) props.onRenameSession(session.id, renameValue.trim());
                          setRenamingId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full rounded border border-primary/40 bg-background px-1.5 py-0.5 text-xs text-foreground outline-none"
                      />
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate">{pinned ? "📌 " : ""}{session.title}</span>
                        {menuId === session.id && (
                          <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              title={pinned ? "取消置顶" : "置顶"}
                              onClick={() => setPinnedIds((prev) => pinned ? prev.filter((id) => id !== session.id) : [...prev, session.id])}
                              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                              {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                            </button>
                            <button
                              type="button"
                              title="重命名"
                              onClick={() => { setRenamingId(session.id); setRenameValue(session.title); }}
                              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              title="删除"
                              onClick={() => {
                                if (window.confirm(`删除会话「${session.title}」？`)) {
                                  props.onDeleteSession(session.id);
                                }
                              }}
                              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-red-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* ── 右侧对话流 ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6">
            {/* 会话标题 */}
            <div className="shrink-0 pt-2">
              <h2 className="text-lg font-semibold leading-7">{activeSession?.title ?? "新对话"}</h2>
              <p className="text-xs text-muted-foreground">{props.model ? `模型：${props.model}` : ""}</p>
            </div>

            {/* 空会话首屏（豆包式：欢迎语 + 热词 + 功能入口） */}
            {props.messages.length === 0 && !props.pendingUserContent && !props.streamingText ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-8 py-10">
                <div className="text-center">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                    <MessageSquare className="h-7 w-7" />
                  </div>
                  <h1 className="text-xl font-semibold">你好，我是 MarxSphere AI 助手</h1>
                  <p className="mt-1.5 text-sm text-muted-foreground">马克思主义理论研究科研助手 — 输入问题开始对话</p>
                </div>
                <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => props.onSend(s, [], props.webSearch)}
                      className="rounded-lg border border-border bg-card p-3 text-left text-sm text-muted-foreground transition-all hover:border-primary/50 hover:text-foreground hover:shadow-md"
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button type="button" onClick={() => props.onGoToView("ask")} className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                    🔍 Ask 检索
                  </button>
                  <button type="button" onClick={() => props.onGoToView("reason")} className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                    🧠 52 步推理
                  </button>
                  <button type="button" onClick={() => props.onGoToView("empirical-research")} className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                    📊 实证工作台
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {/* 历史消息 */}
                {props.messages.map((message) => {
                  const isUser = message.role === "user";
                  return (
                    <div key={message.id} className={cn("group flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
                      <MessageRoleBadge role={isUser ? "user" : "assistant"} />
                      <div className={cn(
                        "message-pop-in max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6",
                        isUser
                          ? "rounded-br-md bg-primary text-primary-foreground"
                          : "rounded-bl-md border border-border bg-card shadow-sm"
                      )}>
                        {isUser ? (
                          <div className="whitespace-pre-wrap">{message.content}</div>
                        ) : (
                          <>
                            {/* V399: 历史消息思考链（后端 metadata.reasoning 回填） */}
                            {typeof message.metadata?.reasoning === "string" && message.metadata.reasoning.length > 0 ? (
                              <ReasoningBlock text={message.metadata.reasoning} />
                            ) : null}
                            <MarkdownRich
                              content={message.content}
                              citations={citationsFor(message)}
                              onOpenCitation={props.onOpenCitation}
                            />
                          </>
                        )}
                        {isUser && message.images?.length ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {message.images.map((img, i) => (
                              <img
                                key={i}
                                src={`/api/chat/images/${img.path}`}
                                alt={img.name}
                                className="max-h-44 rounded-lg border border-border/60"
                              />
                            ))}
                          </div>
                        ) : null}
                        {!isUser && citationsFor(message).length > 0 ? (
                          <CitationStrip citations={citationsFor(message)} onOpenCitation={props.onOpenCitation} />
                        ) : null}
                        {toolCallsFor(message.id).length > 0 ? (
                          <ToolChain calls={toolCallsFor(message.id)} />
                        ) : null}
                        <div className={cn("mt-1 text-[10px]", isUser ? "text-primary-foreground/60" : "text-muted-foreground/70")}>
                          {formatDate(message.createdAt)}
                        </div>
                      </div>
                      {/* V398: 撤回按钮 — 最后一条用户消息常显（不依赖悬停） */}
                      {isUser && !props.isRunning && message.id === props.messages[props.messages.length - 1]?.id ? (
                        <button
                          type="button"
                          onClick={props.onRecall}
                          title="撤回这条消息（回复前可撤回）"
                          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-red-400"
                        >
                          <RotateCcw className="h-3 w-3" />
                          撤回
                        </button>
                      ) : null}
                    </div>
                  );
                })}

                {/* 进行中的工具调用 */}
                {props.runningToolName && (
                  <div className="flex items-start gap-1.5 self-start">
                    <MessageRoleBadge role="assistant" />
                    <div className="max-w-[88%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-sm">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <Wrench className="h-3 w-3" />
                        正在调用 {props.runningToolName}…
                      </div>
                    </div>
                  </div>
                )}

                {/* 待发送用户消息 */}
                {props.pendingUserContent ? (
                  <div className="flex flex-col items-end gap-1.5 self-end">
                    <MessageRoleBadge role="user" />
                    <div className="message-pop-in max-w-[88%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground">
                      <div className="whitespace-pre-wrap">{props.pendingUserContent}</div>
                    </div>
                  </div>
                ) : null}

                {/* 流式 AI 回复 */}
                {props.streamingText || props.reasoningText ? (
                  <div className="flex flex-col items-start gap-1.5 self-start">
                    <MessageRoleBadge role="assistant" />
                    <div className="message-pop-in max-w-[88%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 text-sm leading-6 shadow-sm">
                      {props.reasoningText ? <ReasoningBlock text={props.reasoningText} /> : null}
                      {props.streamingText ? (
                        <>
                          <MarkdownStreaming content={props.streamingText} />
                          <span className="ml-1 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-primary align-middle" />
                        </>
                      ) : (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          正在思考…
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            <div ref={scrollAnchorRef} />
          </div>
        </div>

        {/* ── 底部 Composer ── */}
        <div className="shrink-0 border-t border-border bg-background/80 px-4 py-3 md:px-6">
          <div className="mx-auto max-w-3xl">
            <div className="rounded-2xl border border-border bg-card shadow-sm transition-all duration-150 hover:border-primary/40 focus-within:border-primary/60 focus-within:shadow-[0_0_0_3px_hsl(214_55%_55%/0.12)]">
              {/* 功能行（豆包式）：附件 / 联网 / 模型 */}
              <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => { void handleFiles(e.target.files); e.target.value = ""; }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="上传图片（也可 Ctrl+V 粘贴截图）"
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ImagePlus className="h-4 w-4" />
                  图片
                </button>
                <button
                  type="button"
                  onClick={() => props.onWebSearchChange(!props.webSearch)}
                  title="联网搜索（注入 web_search 结果）"
                  className={cn(
                    "flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors",
                    props.webSearch ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent"
                  )}
                >
                  <Globe className="h-4 w-4" />
                  联网
                </button>
                {/* V399: 深度模式 — 质量优先（文献必查/推理深化/轮次 20） */}
                <button
                  type="button"
                  onClick={() => props.onDeepModeChange(!props.deepMode)}
                  title="深度模式：文献必查、推理深化、最多 20 轮工具调用（更全面但更耗时）"
                  className={cn(
                    "flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors",
                    props.deepMode ? "bg-purple-500/15 text-purple-400" : "text-muted-foreground hover:bg-accent"
                  )}
                >
                  <Zap className="h-4 w-4" />
                  深度
                </button>
                <div className="ml-auto flex items-center gap-1.5">
                  <label className="text-xs text-muted-foreground">模型</label>
                  <select
                    value={props.model}
                    onChange={(e) => props.onModelChange(e.target.value)}
                    className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary/60"
                  >
                    {props.models.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 图片草稿预览 */}
              {draftImages.length > 0 ? (
                <div className="flex flex-wrap gap-2 px-3 pt-2">
                  {draftImages.map((img, i) => (
                    <div key={i} className="group relative">
                      <img src={img.dataUrl} alt={img.name} className="h-20 w-20 rounded-lg border border-border object-cover" />
                      <button
                        type="button"
                        onClick={() => setDraftImages((prev) => prev.filter((_, idx) => idx !== i))}
                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="flex items-end gap-2 p-2">
                <Textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={(e) => {
                    const files = e.clipboardData?.files;
                    if (files && files.length > 0 && Array.from(files).some((f) => f.type.startsWith("image/"))) {
                      e.preventDefault();
                      void handleFiles(files);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="输入问题，Enter 发送，Shift+Enter 换行…"
                  className="max-h-40 min-h-11 flex-1 resize-none border-0 bg-transparent focus-visible:ring-0"
                />
                <Button
                  className="h-9 shrink-0 self-end px-4"
                  variant={props.isRunning ? "destructive" : "default"}
                  onClick={props.isRunning ? props.onStop : handleSend}
                  disabled={!props.isRunning && !draft.trim()}
                >
                  {props.isRunning ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                  {props.isRunning ? "停止" : "发送"}
                </Button>
              </div>
            </div>
            <p className="mt-1.5 text-center text-[11px] text-muted-foreground/60">
              MarxSphere AI 对话 · 支持 Markdown / 代码高亮 / LaTeX 公式 / 图片理解 / Agent 工具调度
            </p>
          </div>
        </div>
      </div>

      {/* V399: 工具审批弹窗（review/manager 级工具） */}
      {props.approval ? <ToolApprovalModal approval={props.approval} onApprove={props.onApproveTool} /> : null}
    </section>
  );
};

/** 工具审批弹窗（review/manager 级工具需人工确认） */
function ToolApprovalModal(props: {
  approval: { approvalId: string; toolName: string; arguments: Record<string, unknown> };
  onApprove: (approvalId: string, approved: boolean) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => props.onApprove(props.approval.approvalId, false)}>
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-500">⚠️</span>
          <h3 className="text-sm font-semibold">工具需要人工审批</h3>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Agent 请求调用 <span className="font-mono font-medium text-foreground">{props.approval.toolName}</span>（该工具风险较高，需确认后执行）：
        </p>
        <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted/50 p-2.5 font-mono text-[11px] leading-4 text-muted-foreground">
          {JSON.stringify(props.approval.arguments, null, 2)}
        </pre>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => props.onApprove(props.approval.approvalId, false)}>
            拒绝
          </Button>
          <Button variant="default" size="sm" onClick={() => props.onApprove(props.approval.approvalId, true)}>
            批准执行
          </Button>
        </div>
      </div>
    </div>
  );
}
