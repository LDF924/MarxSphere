// TracePanel.tsx — Trace Waterfall 统一追踪（OTEL 风格）
// Ask 检索步骤 + Jobs 任务流水的统一 span 视图
// 左列表（ID/状态标识 + 选中 + 删除 + 清空）+ 右瀑布（类型图标 + 层级 + 单条折叠 + 明细）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Activity, ChevronRight, Trash2, ChevronDown, Search, Database, GitBranch, Cpu, Zap, AlertTriangle, Clock, Hash, FileText } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { Card } from "./ui/card";
import { Button } from "./ui/button";

interface TraceSpan {
  id: string;
  traceId: string;
  parentId?: string;
  kind: string;
  name: string;
  status: "ok" | "error" | "running";
  startedAt: string;
  durationMs?: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  detail?: string;
}

interface TraceSummary {
  traceId: string;
  name: string;
  spanCount: number;
  startedAt: string;
  status?: string;
}

const KIND_STYLE: Record<string, string> = {
  trace: "bg-primary/10 text-primary",
  step: "bg-blue-100 text-blue-700",
  job: "bg-green-100 text-green-700",
  llm: "bg-purple-100 text-purple-700",
  sql: "bg-amber-100 text-amber-700"
};

const KIND_ICONS: Record<string, React.ReactNode> = {
  trace: <Activity className="h-3 w-3" />,
  step: <Zap className="h-3 w-3" />,
  job: <Database className="h-3 w-3" />,
  llm: <Cpu className="h-3 w-3" />,
  sql: <FileText className="h-3 w-3" />
};

const KIND_LABELS: Record<string, string> = {
  trace: "根",
  step: "步骤",
  job: "任务",
  llm: "LLM",
  sql: "查询"
};

function shortId(id: string): string {
  return id ? id.slice(0, 8) : "";
}

export function TracePanel() {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [loading, setLoading] = useState(true);
  // span 单条折叠：spanId → 展开与否（默认展开）
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 清空两段式确认
  const [confirmingClear, setConfirmingClear] = useState(false);
  // 分组折叠：ingest/ask/jobs 组是否展开
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(["ask"]));
  // 筛选：类型（全部/ask/ingest/other）+ 状态（全部/ok/error/running）
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  // 批量勾选
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmingBatchDelete, setConfirmingBatchDelete] = useState(false);

  const filteredTraces = useMemo(() => {
    return traces.filter((t) => {
      const typeOk = filterType === "all"
        ? true
        : filterType === "ask" ? t.name.startsWith("ask:")
        : filterType === "ingest" ? t.name.startsWith("ingest:")
        : !t.name.startsWith("ask:") && !t.name.startsWith("ingest:");
      const statusOk = filterStatus === "all" ? true : t.status === filterStatus;
      return typeOk && statusOk;
    });
  }, [traces, filterType, filterStatus]);

  // 按类型分组：Ask 检索 / 入库 / 其他（Jobs 等）
  const groupedTraces = useMemo(() => {
    const groups: Array<{ key: string; label: string; list: TraceSummary[] }> = [
      { key: "ask", label: "Ask 检索", list: [] },
      { key: "ingest", label: "文献入库", list: [] },
      { key: "other", label: "任务/其他", list: [] }
    ];
    for (const trace of filteredTraces) {
      if (trace.name.startsWith("ask:")) groups[0].list.push(trace);
      else if (trace.name.startsWith("ingest:")) groups[1].list.push(trace);
      else groups[2].list.push(trace);
    }
    return groups;
  }, [filteredTraces]);

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 左右列表滚动容器引用（用于自动滚到底部）
  const leftListRef = useRef<HTMLDivElement | null>(null);
  const rightListRef = useRef<HTMLDivElement | null>(null);

  const loadTraces = useCallback(async () => {
    try {
      // 分组查询：Ask/入库/Jobs 各组独立 limit（ingest 200 覆盖 500 篇入库全部），互不挤占
      const data = await api.listTracesGrouped({ perGroup: 200 });
      setTraces([...data.ask, ...data.ingest, ...data.other]);
    } catch { /* 表未建时静默 */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void loadTraces();
    const timer = setInterval(() => void loadTraces(), 8000);
    return () => clearInterval(timer);
  }, [loadTraces]);

  // 首次加载后滚到底部一次（看最新 trace）；之后不干预用户手动滚动
  const initialScrollDoneRef = useRef(false);
  useEffect(() => {
    if (leftListRef.current && !initialScrollDoneRef.current) {
      leftListRef.current.scrollTop = leftListRef.current.scrollHeight;
      initialScrollDoneRef.current = true;
    }
  }, [traces]);

  const selectTrace = async (traceId: string) => {
    // 再点已展开的 trace → 收起（右侧清空）
    if (selected === traceId) {
      setSelected(null);
      setSpans([]);
      setCollapsed(new Set());
      return;
    }
    setSelected(traceId);
    setCollapsed(new Set());
    try {
      const data = await api.listTraceSpans(traceId);
      setSpans(data.spans as unknown as TraceSpan[]);
    } catch { setSpans([]); }
  };

  const toggleSpan = (spanId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  };

  const removeTrace = async (traceId: string) => {
    try {
      await api.deleteTrace(traceId);
      setTraces((prev) => prev.filter((t) => t.traceId !== traceId));
      if (selected === traceId) { setSelected(null); setSpans([]); }
    } catch { /* 忽略 */ }
  };

  // 批量删除（勾选的）
  const removeSelected = async () => {
    if (selectedIds.size === 0) return;
    // 两段式确认
    if (!confirmingBatchDelete) {
      setConfirmingBatchDelete(true);
      setTimeout(() => setConfirmingBatchDelete(false), 4000);
      return;
    }
    setConfirmingBatchDelete(false);
    try {
      await api.deleteTracesBatch(Array.from(selectedIds));
      setTraces((prev) => prev.filter((t) => !selectedIds.has(t.traceId)));
      setSelectedIds(new Set());
      if (selected && selectedIds.has(selected)) { setSelected(null); setSpans([]); }
    } catch { /* 忽略 */ }
  };

  const toggleSelect = (traceId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
  };

  const toggleSelectAll = (list: TraceSummary[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = list.every((t) => next.has(t.traceId));
      if (allSelected) {
        for (const t of list) next.delete(t.traceId);
      } else {
        for (const t of list) next.add(t.traceId);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const clearAll = async () => {
    // 两段式确认（不用 window.confirm，沙箱 iframe 里会被禁用）
    if (!confirmingClear) {
      setConfirmingClear(true);
      setTimeout(() => setConfirmingClear(false), 4000);
      return;
    }
    setConfirmingClear(false);
    try {
      await api.clearTraces();
      setTraces([]);
      setSelected(null);
      setSpans([]);
    } catch { /* 忽略 */ }
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto w-full max-w-[1400px] space-y-4">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Trace Waterfall</h2>
          <span className="text-xs text-muted-foreground">Ask 步骤 + Jobs 流水 · OTEL 风格 span</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void loadTraces()}><RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新</Button>
            {traces.length > 0 && (
              <Button size="sm" variant={confirmingClear ? "destructive" : "outline"} onClick={() => void clearAll()}>
                <Trash2 className="mr-1 h-3.5 w-3.5" /> {confirmingClear ? "确认清空？" : "清空"}
              </Button>
            )}
          </div>
        </div>

        {/* 筛选 + 批量操作栏 */}
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/95 p-2 text-xs">
          <span className="text-muted-foreground">筛选</span>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="all">全部类型</option>
            <option value="ask">Ask 检索</option>
            <option value="ingest">文献入库</option>
            <option value="other">任务/其他</option>
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="all">全部状态</option>
            <option value="ok">成功</option>
            <option value="error">失败</option>
            <option value="running">运行中</option>
          </select>
          <div className="ml-auto flex items-center gap-2">
            {selectedIds.size > 0 && (
              <>
                <span className="text-muted-foreground">已选 {selectedIds.size} 条</span>
                <Button size="sm" variant="outline" onClick={clearSelection}>取消选择</Button>
                <Button size="sm" variant={confirmingBatchDelete ? "destructive" : "default"} onClick={() => void removeSelected()}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> {confirmingBatchDelete ? "确认删除？" : `删除选中 (${selectedIds.size})`}
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          {/* 左：trace 列表（含 ID/状态标识） */}
          <Card className="flex h-[calc(100vh-190px)] min-h-[300px] flex-col p-2">
            <div ref={leftListRef} className="min-h-0 flex-1 overflow-y-auto">
            {loading && <div className="p-2 text-xs text-muted-foreground"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />加载…</div>}
            {traces.length === 0 && !loading && <div className="p-2 text-xs text-muted-foreground">暂无 trace。跑一次 Ask 检索或 Jobs 任务后这里会出现。</div>}
            <div className="space-y-1">
              {groupedTraces.map((group) => group.list.length === 0 ? null : (
                <div key={group.key}>
                  <div className="flex items-center gap-1 rounded px-1 py-1">
                    <input
                      type="checkbox"
                      checked={group.list.length > 0 && group.list.every((t) => selectedIds.has(t.traceId))}
                      onChange={() => toggleSelectAll(group.list)}
                      className="h-3 w-3 shrink-0 cursor-pointer accent-primary"
                      title="全选本组"
                    />
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.key)}
                      className="flex w-full cursor-pointer items-center gap-1.5 rounded text-[11px] font-medium text-muted-foreground hover:bg-accent"
                    >
                      <ChevronDown className={cn("h-3 w-3 transition-transform", openGroups.has(group.key) && "rotate-180")} />
                      {group.label}
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{group.list.length}</span>
                    </button>
                  </div>
                  {openGroups.has(group.key) && group.list.map((trace) => (
                <div
                  key={trace.traceId}
                  className={cn(
                    "group flex items-center gap-1 rounded px-1 py-1 text-xs hover:bg-accent",
                    selected === trace.traceId && "bg-accent"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(trace.traceId)}
                    onChange={() => toggleSelect(trace.traceId)}
                    className="h-3 w-3 shrink-0 cursor-pointer accent-primary"
                    title="勾选删除"
                  />
                  <button
                    type="button"
                    onClick={() => void selectTrace(trace.traceId)}
                    className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
                    title={selected === trace.traceId ? "点击收起" : "点击查看瀑布"}
                  >
                    <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground", selected === trace.traceId && "rotate-90")} />
                    {/* 成功/失败/运行中状态标识 */}
                    {trace.status === "error" ? (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" title="失败" />
                    ) : trace.status === "running" ? (
                      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" title="运行中" />
                    ) : (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" title="成功" />
                    )}
                    <span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">{shortId(trace.traceId)}</span>
                    <span className="min-w-0 flex-1 truncate">{trace.name.slice(0, 40)}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{trace.spanCount} spans</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{new Date(trace.startedAt).toLocaleTimeString("zh-CN")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeTrace(trace.traceId)}
                    className="relative z-10 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600"
                    title="删除这条 trace"
                    aria-label={`删除 ${trace.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                  ))}
                  </div>
              ))}
            </div>
            </div>
          </Card>

          {/* 右：选中 trace 的瀑布（类型图标 + 层级 + 单条折叠 + 明细） */}
          <Card className="flex h-[calc(100vh-190px)] min-h-[300px] flex-col p-3">
            <div ref={rightListRef} className="min-h-0 flex-1 overflow-y-auto">
            {!selected ? (
              <div className="py-10 text-center text-sm text-muted-foreground">选择左侧 trace 查看瀑布</div>
            ) : spans.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">该 trace 暂无 span</div>
            ) : (
              <div className="space-y-1.5">
                {/* 选中 trace 概览条 */}
                {(() => {
                  const rootSpan = spans.find((s) => s.kind === "trace");
                  const modeMatch = rootSpan?.detail?.match(/^\[(fast|standard)\]/);
                  const mode = modeMatch ? modeMatch[1] : null;
                  return (
                    <div className="mb-2 flex items-center gap-2 rounded-md bg-muted/40 px-3 py-1.5 text-xs">
                      <Hash className="h-3 w-3 text-muted-foreground" />
                      <span className="font-mono text-[10px] text-muted-foreground">{selected.slice(0, 12)}…</span>
                      <span className="ml-1 font-medium">{traces.find((t) => t.traceId === selected)?.name ?? "trace"}</span>
                      {mode && (
                        <span className={cn("rounded px-1.5 py-0.5 text-[10px]", mode === "fast" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700")}>
                          {mode === "fast" ? "fast 模式" : "standard 完整"}
                        </span>
                      )}
                      <span className="ml-auto text-muted-foreground">{spans.length} spans · 总耗时 {spans.some((s) => s.durationMs != null) ? `${(Math.max(...spans.map((s) => s.durationMs ?? 0), 0) / 1000).toFixed(2)}s` : "—"}</span>
                    </div>
                  );
                })()}
                {spans.map((span, idx) => {
                  const isCollapsed = collapsed.has(span.id);
                  // 层级：有 parentId 的子 span 缩进（当前数据 parentId 为空，预留逻辑）
                  const depth = span.parentId ? 1 : 0;
                  const maxDur = Math.max(...spans.map((s) => s.durationMs ?? 0), 1);
                  const width = span.durationMs != null ? Math.max(8, (span.durationMs / maxDur) * 100) : 8;
                  const hasTokens = span.tokensInput + span.tokensOutput + span.tokensCacheRead > 0;
                  const isError = span.status === "error";
                  return (
                    <div
                      key={span.id}
                      className={cn("rounded border p-2", isError ? "border-red-200 bg-red-50/40" : "border-border/60")}
                      style={{ marginLeft: depth * 16 }}
                    >
                      {/* 单条头部：类型图标 + 名称 + 状态 + 折叠 */}
                      <button
                        type="button"
                        onClick={() => toggleSpan(span.id)}
                        className="flex w-full cursor-pointer items-center gap-2 text-xs"
                        title={isCollapsed ? "展开" : "收起"}
                      >
                        <ChevronDown className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", isCollapsed && "-rotate-90")} />
                        <span className={cn("inline-flex w-14 shrink-0 items-center justify-center gap-1 rounded px-1.5 py-0.5 text-[10px]", KIND_STYLE[span.kind] ?? "bg-muted")}>
                          {KIND_ICONS[span.kind] ?? null}
                          {KIND_LABELS[span.kind] ?? span.kind}
                        </span>
                        {isError && <AlertTriangle className="h-3 w-3 shrink-0 text-red-500" />}
                        <span className="min-w-0 flex-1 truncate font-mono">{span.name}</span>
                        <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{shortId(span.id)}</span>
                        {span.durationMs != null && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{(span.durationMs / 1000).toFixed(2)}s</span>}
                        <span className={cn("shrink-0", isError ? "text-red-600" : span.status === "running" ? "text-blue-600" : "text-muted-foreground")}>
                          {span.status}
                        </span>
                      </button>
                      {/* 折叠内容：进度条 + detail + token 明细 */}
                      {!isCollapsed && (
                        <div className="mt-1.5">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                              <div
                                className={cn("h-full rounded", isError ? "bg-red-400" : span.status === "running" ? "bg-blue-400" : "bg-green-400")}
                                style={{ width: `${width}%` }}
                              />
                            </div>
                            {span.durationMs != null && (
                              <span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground">
                                <Clock className="h-3 w-3" /> {(span.durationMs / 1000).toFixed(2)}s
                              </span>
                            )}
                          </div>
                          {hasTokens && (
                            <div className="mt-1 flex items-center gap-1.5">
                              <Cpu className="h-3 w-3 text-muted-foreground" />
                              <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground" title="输入 token">
                                输入 <span className="font-semibold text-foreground/70">{span.tokensInput}</span>
                              </span>
                              <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground" title="输出 token">
                                输出 <span className="font-semibold text-foreground/70">{span.tokensOutput}</span>
                              </span>
                              <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground" title="缓存 token">
                                缓存 <span className="font-semibold text-foreground/70">{span.tokensCacheRead}</span>
                              </span>
                            </div>
                          )}
                          {span.detail && <div className="mt-1 text-[10px] text-muted-foreground">{span.detail.slice(0, 200)}</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            </div>
          </Card>
        </div>
      </div>
    </section>
  );
}
