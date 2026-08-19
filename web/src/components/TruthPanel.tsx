// TruthPanel.tsx — GBrain Compiled Truth + Timeline 机制前端
// 页面 = 上方 Compiled Truth（当前最佳理解，可重写） + 下方时间线（证据轨迹，只追加）
import { useState, useEffect, type FC } from "react";
import { BookOpenCheck, Plus, FileText, History, GitCommitHorizontal, Loader2, RefreshCw, PencilLine, BookMarked, Trash2, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { MarkdownMessage } from "../lib/markdown";
import { TruthDiff } from "./TruthDiff";
import { LlmModelSelector, TASK_ROLES } from "./LlmModelSelector";
import { Card } from "../components/ui/card";
import { DragHandle } from "../components/ui/DragHandle";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";

// V328: 知识 PR 草稿状态（P1-7）
interface DraftStatus { statusCounts: Array<{ status: string; n: number }>; recent: Array<{ id: number; title: string; status: string; review_verdict: string | null; proposer_model: string | null; reviewer_model: string | null; created_at: string }> }

interface KnowledgePage {
  id: string;
  title: string;
  compiledTruth: string;
  sourceHint?: string;
  tags: string[];
  updatedAt: string;
  createdAt: string;
}

interface PageEntry {
  id: string;
  pageId: string;
  content: string;
  entryType: string;
  source?: string;
  confidence: number;
  createdAt: string;
}

interface PageWithTimeline extends KnowledgePage {
  timeline: PageEntry[];
}

const ENTRY_TYPE_LABELS: Record<string, string> = {
  note: "笔记",
  evidence: "证据",
  contradiction: "矛盾",
  synthesis: "综合"
};

const ENTRY_TYPE_COLORS: Record<string, string> = {
  note: "bg-muted text-muted-foreground",
  evidence: "bg-green-100 text-green-700",
  contradiction: "bg-red-100 text-red-700",
  synthesis: "bg-blue-100 text-blue-700"
};

export function TruthPanel() {
  const [pages, setPages] = useState<KnowledgePage[]>([]);
  // V328: 知识 PR 草稿状态
  const [drafts, setDrafts] = useState<DraftStatus | null>(null);
  const loadDrafts = () => { void api.getTruthDrafts().then(setDrafts).catch(() => setDrafts(null)); };
  useEffect(() => {
    loadDrafts();
    const timer = window.setInterval(loadDrafts, 30000);
    return () => window.clearInterval(timer);
  }, []);
  const [selected, setSelected] = useState<PageWithTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newTruth, setNewTruth] = useState("");
  const [editingTruth, setEditingTruth] = useState(false);
  const [draftTruth, setDraftTruth] = useState("");
  const [newEntry, setNewEntry] = useState("");
  const [saving, setSaving] = useState(false);
  // 归纳总结（Claude Code 桥）
  const [aiRunning, setAiRunning] = useState(false);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [aiResult, setAiResult] = useState<string>("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");

  const loadPages = async () => {
    setLoading(true);
    try {
      const data = await api.listTruthPages();
      setPages(data.pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPages();
    api.aiExecuteStatus().then((s) => setAiAvailable(s.available)).catch(() => setAiAvailable(false));
  }, []);

  const selectPage = async (pageId: string) => {
    try {
      const detail = await api.getTruthPage(pageId);
      setSelected(detail);
      setEditingTruth(false);
      setNewEntry("");
      setAiResult("");
      setAiError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const createPage = async () => {
    if (!newTitle.trim()) return;
    setSaving(true);
    try {
      const { page } = await api.createTruthPage({ title: newTitle.trim(), compiledTruth: newTruth.trim() || undefined });
      setNewTitle("");
      setNewTruth("");
      setShowCreate(false);
      await loadPages();
      await selectPage(page.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const rewriteTruth = async () => {
    if (!selected || !draftTruth.trim()) return;
    setSaving(true);
    try {
      await api.rewriteTruth(selected.id, { compiledTruth: draftTruth.trim() });
      await selectPage(selected.id);
      setEditingTruth(false);
      await loadPages();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const appendEntry = async () => {
    if (!selected || !newEntry.trim()) return;
    setSaving(true);
    try {
      await api.appendTruthEntry(selected.id, { content: newEntry.trim(), entryType: "note" });
      setNewEntry("");
      await selectPage(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteEntryItem = async (entryId: string) => {
    if (!selected) return;
    try {
      await api.deleteTruthEntry(selected.id, entryId);
      await selectPage(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deletePageItem = async (pageId: string, pageTitle: string) => {
    if (!window.confirm(`删除知识页面「${pageTitle}」？（时间线一并删除）`)) return;
    try {
      await api.deleteTruthPage(pageId);
      if (selected?.id === pageId) setSelected(null);
      await loadPages();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 归纳总结：把当前页面的 Compiled Truth + 时间线证据打包，交给 Claude Code（可带自定义指令） */
  const synthesizePage = async () => {
    if (!selected) return;
    setAiRunning(true);
    setAiError(null);
    setAiResult("");
    const userPrompt = aiPrompt.trim();
    const timelineText = selected.timeline
      .slice(0, 25)
      .map((e) => `- [${ENTRY_TYPE_LABELS[e.entryType] ?? e.entryType}] ${e.content.slice(0, 400)}${e.source ? `（来源：${e.source.slice(0, 60)}）` : ""}`)
      .join("\n");
    const prompt = [
      `你是马克思主义政治经济学研究助手。请根据知识页面「${selected.title}」的现有理解和证据时间线，${userPrompt ? `按用户指令执行：${userPrompt}` : "做归纳总结并给出结论。"}`,
      "重要：所有数据已内联在下方，禁止访问数据库、读取文件、联网或调用任何工具，直接基于以下内容回答。",
      "",
      `当前理解（Compiled Truth）：${selected.compiledTruth || "（无）"}`,
      "",
      "证据时间线（仅参考，不要逐条复述）：",
      timelineText || "（无时间线条目）",
      "",
      userPrompt
        ? "请直接回答用户的指令，用中文，简洁专业。"
        : "请严格按以下格式输出：",
      userPrompt
        ? ""
        : "【核心结论】一句话\n【要点结论】2-5 条，每条含判断与依据\n【存疑之处】仍存疑/未解决的问题\n【研究衔接】与工商资本下乡、农业农村现代化研究的衔接",
      userPrompt ? "" : "用中文，简洁专业，结论要有实质判断。"
    ].filter(Boolean).join("\n");
    try {
      // 2026-08-07 改 LLM API 直调（替代 Claude CLI，模型用注册表 reason 角色）
      const result = await api.executeLlm({ prompt });
      setAiResult(result.ok ? result.output : `执行失败: ${result.output.slice(0, 500)}`);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiRunning(false);
    }
  };

  /** 把 Claude 结论写回：追加时间线（synthesis）+ 可选更新 Compiled Truth */
  const applyAiResult = async (mode: "entry" | "truth") => {
    if (!selected || !aiResult) return;
    setSaving(true);
    try {
      const result = aiResult.replace(/^```(?:markdown|md|text)?\s*\n?|```\s*$/g, "").trim();
      await api.appendTruthEntry(selected.id, {
        content: `Claude 归纳总结：${result}`,
        entryType: "synthesis",
        source: "Claude Code",
        confidence: 0.8
      });
      if (mode === "truth") {
        await api.rewriteTruth(selected.id, { compiledTruth: result, source: "Claude Code 归纳" });
      }
      await selectPage(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="flex w-full flex-col space-y-3">
        <div className="flex items-center gap-2">
          <BookOpenCheck className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">知识页面（Compiled Truth + 时间线）</h2>
          <div className="ml-auto flex gap-2">
            <ButtonSmall onClick={() => void loadPages()}><RefreshCw className="h-3.5 w-3.5" /> 刷新</ButtonSmall>
            <ButtonSmall onClick={() => setShowCreate((current) => !current)}><Plus className="h-3.5 w-3.5" /> 新建页面</ButtonSmall>
          </div>
        </div>

        {/* V328: 知识 PR 审核状态条（P1-7 前端展示）— Proposer-Reviewer 异源互审 */}
        <div className="rounded-md border border-border bg-background p-2.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="flex items-center gap-1 font-medium"><Sparkles className="h-3.5 w-3.5 text-primary" /> 知识 PR 审核</span>
            {drafts ? (
              <>
                {(drafts.statusCounts || []).map((s) => (
                  <span key={s.status} className={cn(
                    "rounded px-1.5 py-0.5",
                    s.status === "approved" ? "bg-green-50 text-green-700" :
                    s.status === "rejected" ? "bg-red-50 text-red-700" :
                    s.status === "merged" ? "bg-blue-50 text-blue-700" :
                    "bg-amber-50 text-amber-700"
                  )}>
                    {s.status} {s.n}
                  </span>
                ))}
                {(!drafts.statusCounts || drafts.statusCounts.length === 0) && (
                  <span className="text-muted-foreground">无待审草稿 — 新知识先经 Proposer 起草 + Reviewer 异源审核才入正式表</span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">加载中…</span>
            )}
            <button type="button" onClick={loadDrafts} className="ml-auto flex items-center gap-1 rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted/70">
              <RefreshCw className="h-3 w-3" /> 刷新
            </button>
          </div>
          {drafts && drafts.recent && drafts.recent.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {drafts.recent.slice(0, 3).map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate text-foreground">{d.title}</span>
                  <span className="text-muted-foreground">{d.proposer_model || "?"} → {d.reviewer_model || "?"}</span>
                  <span className={cn("rounded px-1 py-0.5 text-[10px]",
                    d.status === "approved" ? "bg-green-50 text-green-700" :
                    d.status === "rejected" ? "bg-red-50 text-red-700" :
                    d.status === "merged" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700")}>
                    {d.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {showCreate && (
          <Card className="p-4">
            <div className="mb-2 text-sm font-medium">新建知识页面</div>
            <input
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="页面标题（如：资本下乡双重效应）"
              className="mb-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <Textarea
              value={newTruth}
              onChange={(event) => setNewTruth(event.target.value)}
              placeholder="初始 Compiled Truth（当前最佳理解）"
              rows={2}
              className="mb-2"
            />
            <Button onClick={() => void createPage()} disabled={saving || !newTitle.trim()}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null} 创建
            </Button>
          </Card>
        )}

        {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

        <div className="relative flex min-h-0 flex-1 flex-col">
          <DragHandle leftVar="--truth-w" defaultWidth={280} storageKey="truth-width" />
        <div className="relative grid h-[135vh] w-full grid-cols-1 gap-0 lg:grid-cols-[var(--truth-w,280px)_minmax(0,1fr)]" style={{"--truth-w": "280px"} as React.CSSProperties}>
          {/* 左：页面列表 */}
          <Card className="flex min-h-0 flex-col overflow-y-auto p-2">
            {loading ? (
              <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />加载页面…
              </div>
            ) : pages.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-6 text-center">
                <BookMarked className="h-8 w-8 text-muted-foreground/40" />
                <div className="text-sm font-medium">还没有知识页面</div>
                <div className="text-xs leading-5 text-muted-foreground">
                  知识页把研究结论沉淀为「当前最佳理解」+ 证据时间线。
                  <br />点右上角「新建页面」创建第一个主题页。
                </div>
              </div>
            ) : (
              pages.map((page) => (
                <div key={page.id} className="group flex items-center rounded hover:bg-accent">
                  <button
                    type="button"
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                      selected?.id === page.id && "bg-accent text-foreground"
                    )}
                    onClick={() => void selectPage(page.id)}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{page.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{new Date(page.updatedAt).toLocaleDateString("zh-CN")}</span>
                  </button>
                  {/* 删除页面（始终可见，z-10 提升层级避免被容器盖住） */}
                  <button
                    type="button"
                    onClick={() => void deletePageItem(page.id, page.title)}
                    className="relative z-10 mr-2 shrink-0 rounded-md p-1.5 text-muted-foreground/50 transition-colors hover:bg-red-50 hover:text-red-600"
                    title="删除页面"
                    aria-label={`删除页面 ${page.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </Card>

          {/* 右：页面详情（Compiled Truth 区 + Timeline 区） */}
          <Card className="flex min-h-0 flex-col overflow-y-auto p-4">
            {!selected ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">选择左侧页面查看</div>
            ) : (
              <div className="space-y-4">
                {/* Compiled Truth 区（可改写） */}
                <div>
                  <div className="mb-1 flex items-center gap-2 border-b border-border pb-1">
                    <span className="text-sm font-medium">Compiled Truth（当前最佳理解）</span>
                    <span className="text-xs text-muted-foreground">新证据出现时整体重写</span>
                    <ButtonSmall onClick={() => { setDraftTruth(selected.compiledTruth); setEditingTruth((current) => !current); }}>
                      <PencilLine className="h-3 w-3" /> {editingTruth ? "取消" : "重写"}
                    </ButtonSmall>
                  </div>
                  {editingTruth ? (
                    <div className="space-y-2">
                      <Textarea value={draftTruth} onChange={(event) => setDraftTruth(event.target.value)} rows={3} />
                      {/* Synthesize diff：重写前预览差异（GBrain Synthesize 适配） */}
                      <TruthDiff oldText={selected.compiledTruth} newText={draftTruth} />
                      <Button size="sm" onClick={() => void rewriteTruth()} disabled={saving || !draftTruth.trim()}>
                        {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null} 提交新版本
                      </Button>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm">{selected.compiledTruth || "（空）"}</p>
                  )}
                  {selected.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {selected.tags.map((tag) => <span key={tag} className="rounded bg-accent px-1.5 py-0.5 text-xs">{tag}</span>)}
                    </div>
                  )}
                </div>

                {/* 归纳总结（Claude Code 桥，带自定义输入框） */}
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={aiPrompt}
                      onChange={(event) => setAiPrompt(event.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void synthesizePage(); }}
                      placeholder="输入指令交给 Claude（留空则归纳总结：核心结论/要点/存疑/研究衔接）"
                      className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                    />
                    <Button size="sm" onClick={() => void synthesizePage()} disabled={aiRunning || aiAvailable === false}>
                      {aiRunning ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
                      {aiRunning ? "执行中…" : "执行"}
                    </Button>
                    {/* 2026-08-07 LLM 模型选择（LLM API 直调：reason 角色，显示与调用一致） */}
                    <LlmModelSelector roles={TASK_ROLES.search} />
                  </div>
                </div>

                {/* 归纳总结（LLM API 执行） */}
                {aiRunning && (
                  <div className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    正在归纳「{selected.title}」…（约 8-30 秒）
                  </div>
                )}
                {aiError && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{aiError}</div>}
                {aiResult && (
                  <Card className="border-primary/20 bg-primary/5">
                    <div className="mb-2 flex items-center gap-2 border-b border-border pb-2">
                      <Sparkles className="h-4 w-4 text-primary" />
                      <span className="text-sm font-medium">Claude Code 归纳结论</span>
                      <span className="text-xs text-muted-foreground">研究助手 · 可写回</span>
                      <div className="ml-auto flex gap-2">
                        <ButtonSmall onClick={() => void applyAiResult("entry")}>
                          <History className="h-3 w-3" /> 存入时间线
                        </ButtonSmall>
                        <ButtonSmall onClick={() => void applyAiResult("truth")}>
                          <PencilLine className="h-3 w-3" /> 更新为最新理解
                        </ButtonSmall>
                      </div>
                    </div>
                    <div className="markdown-body space-y-1">
                      <MarkdownMessage content={aiResult} />
                    </div>
                  </Card>
                )}

                {/* Timeline 区（只追加） */}
                <div>
                  <div className="mb-2 flex items-center gap-2 border-b border-border pb-1">
                    <History className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">时间线（证据轨迹 · 只追加）</span>
                    <span className="text-xs text-muted-foreground">{selected.timeline.length} 条</span>
                  </div>

                  <div className="space-y-2">
                    {selected.timeline.length === 0 && <div className="text-xs text-muted-foreground">暂无时间线条目</div>}
                    {selected.timeline.map((entry) => (
                      <div key={entry.id} className="group flex items-start gap-2 rounded border border-border p-2">
                        {/* 统一图标：固定 16px */}
                        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                          <GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className={cn("inline-flex h-5 items-center rounded px-1.5", ENTRY_TYPE_COLORS[entry.entryType] ?? "bg-muted")}>
                              {ENTRY_TYPE_LABELS[entry.entryType] ?? entry.entryType}
                            </span>
                            <span className="text-muted-foreground">{new Date(entry.createdAt).toLocaleString("zh-CN")}</span>
                            {entry.source && <span className="truncate text-muted-foreground">来自 {entry.source}</span>}
                            <span className="ml-auto shrink-0 text-muted-foreground">置信度 {(entry.confidence * 100).toFixed(0)}%</span>
                          </div>
                          <p className="mt-1 text-sm">{entry.content}</p>
                        </div>
                        {/* 删除按钮（始终可见，z-10 防遮挡） */}
                        <button
                          type="button"
                          onClick={() => void deleteEntryItem(entry.id)}
                          className="relative z-10 shrink-0 rounded-md p-1.5 text-muted-foreground/40 transition-colors hover:bg-red-50 hover:text-red-600"
                          title="删除该条目"
                          aria-label={`删除条目 ${entry.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* 追加条目 */}
                  <div className="mt-3 flex gap-2">
                    <Textarea
                      value={newEntry}
                      onChange={(event) => setNewEntry(event.target.value)}
                      placeholder="追加证据/笔记（只追加，不删改）…"
                      rows={1}
                    />
                    <Button onClick={() => void appendEntry()} disabled={saving || !newEntry.trim()}>
                      <Plus className="mr-1 h-3.5 w-3.5" /> 追加
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
    </section>
  );
}

function ButtonSmall(props: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent",
        props.disabled && "cursor-not-allowed opacity-50"
      )}
    >
      {props.children}
    </button>
  );
}
