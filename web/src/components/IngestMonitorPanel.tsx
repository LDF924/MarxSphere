// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// IngestMonitorPanel.tsx — 图库入库监控（V406）
// 挂在 Graphiti入库/Cognee入库 面板的入库操作下方：
//   左侧 = 文档队列（库内文档按入库步骤打标 + paper_id_map 中排队未入库）
//   右侧 = 概览 / 切片 / 事件(超边或摘要) / 实体 / 检索 标签页，实时数据可点开查看
import { useState, useEffect, useCallback, type FC } from "react";
import { Loader2, Search, RefreshCw, FileText, Clock, Inbox } from "lucide-react";
import { cn } from "../lib/utils";

interface QueueDoc {
  name: string;
  title: string;
  author: string;
  docType: string;
  createdAt: string;
  stages: Record<string, boolean>;
  counts: Record<string, number>;
  pending: boolean;
}
interface OverviewData {
  engine: "graphiti" | "cognee";
  stats: Record<string, number>;
  queue: QueueDoc[];
  stages: string[];
  stageLabels: Record<string, string>;
}

type TabKey = "overview" | "chunks" | "events" | "entities" | "search";

export const IngestMonitorPanel: FC<{ engine: "graphiti" | "cognee" }> = ({ engine }) => {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState<TabKey>("overview");
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ name: string; type: string; snippet: string }>>([]);
  const [searching, setSearching] = useState(false);

  const loadOverview = useCallback(async () => {
    try {
      const r = await fetch(`/api/ingest/monitor/overview?engine=${engine}`);
      const d = await r.json();
      setOverview(d);
      setError("");
    } catch {
      setError("监控服务不可达");
    }
    setLoading(false);
  }, [engine]);

  useEffect(() => {
    void loadOverview();
    const timer = setInterval(() => void loadOverview(), 15000); // 实时数据 15 秒刷新
    return () => clearInterval(timer);
  }, [loadOverview]);

  // 选中文档 → 加载详情
  const openDoc = async (name: string) => {
    setSelected(name);
    setTab("overview");
    setDetailLoading(true);
    setDetail(null);
    try {
      const r = await fetch(`/api/ingest/monitor/doc?engine=${engine}&name=${encodeURIComponent(name)}`);
      const d = await r.json();
      setDetail(d);
    } catch {
      setDetail(null);
    }
    setDetailLoading(false);
  };

  const doSearch = async () => {
    if (!searchQ.trim()) return;
    setSearching(true);
    try {
      const r = await fetch(`/api/ingest/monitor/search?engine=${engine}&q=${encodeURIComponent(searchQ)}${selected ? `&doc=${encodeURIComponent(selected)}` : ""}`);
      const d = await r.json();
      setSearchResults(d.nodes ?? []);
    } catch { setSearchResults([]); }
    setSearching(false);
  };

  const fmtTime = (v: string | null | undefined): string => {
    if (!v) return "";
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v.slice(5, 16) : d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  };

  // ── 左侧文档队列 ──
  const queue = overview?.queue ?? [];
  const stats = overview?.stats ?? {};
  const stageLabels = overview?.stageLabels ?? {};
  const stageKeys = overview?.stages ?? [];

  const stepBadges: Record<string, string> = engine === "graphiti"
    ? { chunk: "切片", extract: "实体", distill: "蒸馏", hyperedge: "超边" }
    : { chunk: "分块", summary: "摘要" };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[11px] font-semibold text-foreground/80">📋 入库监控</span>
        {overview && (
          <span className="flex flex-wrap gap-1.5">
            {Object.entries(stats).map(([k, v]) => (
              <span key={k} className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[9px] text-sky-600">
                {k === "docs" ? "文档" : k === "pending" ? "排队" : k} <b>{Number(v).toLocaleString()}</b>
              </span>
            ))}
          </span>
        )}
        {loading && <Loader2 className="ml-auto h-3 w-3 animate-spin text-sky-500" />}
        <button
          onClick={() => void loadOverview()}
          className="ml-auto rounded p-1 text-sky-500 hover:bg-muted"
          title="刷新"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {error ? (
        <div className="p-3 text-[10px] text-red-600">{error}</div>
      ) : (
        <div className="flex min-h-[300px]">
          {/* 左侧：文档队列 */}
          <div className="w-56 shrink-0 space-y-1 overflow-y-auto border-r border-border p-2" style={{ maxHeight: 460 }}>
            <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-muted-foreground">
              <Inbox className="h-3 w-3" /> 文档队列
              <span className="ml-auto font-normal text-muted-foreground/70">{queue.length} 篇</span>
            </div>
            {queue.length === 0 && <div className="p-2 text-[10px] text-muted-foreground">加载中…</div>}
            {queue.map((d) => {
              const doneCount = stageKeys.filter((s) => d.stages[s]).length;
              const isPending = d.pending;
              return (
                <button
                  key={d.name}
                  onClick={() => void openDoc(d.name)}
                  className={cn(
                    "w-full rounded-md border p-1.5 text-left transition-colors",
                    selected === d.name
                      ? "border-sky-500/60 bg-sky-500/10 shadow-sm"
                      : "border-transparent hover:border-sky-500/30 hover:bg-sky-500/5",
                    isPending && "border-dashed opacity-70"
                  )}
                >
                  <div className="flex items-center gap-1 text-[10px] font-medium text-foreground/80">
                    {isPending ? <Clock className="h-2.5 w-2.5 shrink-0 text-amber-500" /> : <FileText className="h-2.5 w-2.5 shrink-0 text-sky-500" />}
                    <span className="truncate">{d.title}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1">
                    {stageKeys.map((s) => (
                      <span
                        key={s}
                        title={stepBadges[s]}
                        className={cn(
                          "rounded px-1 py-px text-[8px]",
                          d.stages[s] ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground/60"
                        )}
                      >
                        {stageLabels[s] ?? stepBadges[s]}
                      </span>
                    ))}
                    {!isPending && doneCount === stageKeys.length && (
                      <span className="ml-auto text-[8px] text-emerald-500">✓</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* 右侧：详情标签页 */}
          <div className="min-w-0 flex-1 p-2.5">
            {!selected ? (
              <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-2 text-center text-[11px] text-muted-foreground">
                <div className="text-2xl">📊</div>
                <div>左侧选择文档，查看入库详情（概览 / 切片 / 事件 / 实体 / 检索）</div>
                <div className="text-[9px] text-sky-600/70">实时数据每 15 秒刷新 · 排队 = paper_id_map 中尚未入库</div>
              </div>
            ) : (
              <>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold text-foreground/80">{selected}</span>
                  <div className="flex gap-1">
                    {(["overview", "chunks", "events", "entities", "search"] as TabKey[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={cn(
                          "rounded-md px-2 py-0.5 text-[10px]",
                          tab === t ? "bg-sky-600 text-white" : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
                        )}
                      >
                        {t === "overview" ? "概览" : t === "chunks" ? "切片" : t === "events" ? (engine === "graphiti" ? "超边" : "摘要") : t === "entities" ? "实体" : "检索"}
                      </button>
                    ))}
                  </div>
                </div>

                {detailLoading ? (
                  <div className="flex items-center gap-2 p-4 text-[10px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> 加载详情…
                  </div>
                ) : !detail || detail.ok === false ? (
                  <div className="p-4 text-[10px] text-muted-foreground">暂无详情（文档可能尚未入库）</div>
                ) : (
                  <div className="max-h-[400px] space-y-2 overflow-y-auto pr-1">
                    {tab === "overview" && <OverviewBody detail={detail} stageLabels={stageLabels} engine={engine} />}
                    {tab === "chunks" && (
                      <ListBody
                        title={`切片 ${(detail.chunks as unknown[])?.length ?? 0}`}
                        items={((detail.chunks as Array<{ idx?: number; type?: string; text?: string; file?: string }>) ?? []).map((c) => ({
                          head: `#${c.idx ?? "?"}${c.type ? ` · ${c.type}` : ""}`,
                          body: c.text ?? "",
                          sub: c.file ?? "",
                        }))}
                      />
                    )}
                    {tab === "events" && (
                      engine === "graphiti"
                        ? <ListBody
                            title={`超边 ${(detail.hyperedges as unknown[])?.length ?? 0}`}
                            items={((detail.hyperedges as Array<{ summary?: string; claims?: string; confidence?: number; type?: string }>) ?? []).map((h) => ({
                              head: h.type ? `${h.type}${typeof h.confidence === "number" ? ` · 置信 ${Math.round(h.confidence * 100)}%` : ""}` : "超边",
                              body: h.summary ?? "",
                              sub: h.claims ? `claims: ${h.claims}` : "",
                            }))}
                          />
                        : <ListBody
                            title={`摘要 ${(detail.summaries as unknown[])?.length ?? 0}`}
                            items={((detail.summaries as Array<{ text?: string }>) ?? []).map((s) => ({ head: "摘要", body: s.text ?? "" }))}
                          />
                    )}
                    {tab === "entities" && (
                      engine === "graphiti"
                        ? <ListBody
                            title={`实体 ${(detail.entities as unknown[])?.length ?? 0}`}
                            items={((detail.entities as Array<{ name?: string; category?: string; description?: string }>) ?? []).map((e) => ({
                              head: e.name ?? "",
                              body: e.description ?? "",
                              sub: e.category ?? "",
                            }))}
                          />
                        : <div className="rounded border border-border bg-card p-3 text-[10px] text-muted-foreground">
                            Cognee 实体为全局概念图谱（无文档归属），请在「检索」页搜索
                          </div>
                    )}
                    {tab === "search" && (
                      <div>
                        <div className="flex gap-1">
                          <input
                            value={searchQ}
                            onChange={(e) => setSearchQ(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && void doSearch()}
                            placeholder={`在${engine === "graphiti" ? "本库" : "库中"}检索实体 / 切片…`}
                            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px]"
                          />
                          <button onClick={() => void doSearch()} disabled={searching} className="rounded bg-sky-600 px-2 text-white hover:bg-sky-700 disabled:opacity-50">
                            {searching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                          </button>
                        </div>
                        {engine === "graphiti" && (
                          <div className="mt-1 text-[9px] text-muted-foreground">
                            当前限定于「{selected}」{searchQ ? "" : "（输入关键词）"}
                          </div>
                        )}
                        {searchResults.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {searchResults.map((n, i) => (
                              <div key={i} className="rounded border border-border bg-card p-1.5 text-[10px]">
                                <span className="font-medium text-foreground/80">{n.name}</span>
                                <span className="ml-1 rounded bg-violet-500/10 px-1 py-px text-[8px] text-violet-700">{n.type}</span>
                                <div className="mt-0.5 text-muted-foreground">{n.snippet}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ── 概览页：步骤完成状态 + 计数 ──
const OverviewBody: FC<{ detail: Record<string, unknown>; stageLabels: Record<string, string>; engine: string }> = ({ detail, stageLabels, engine }) => {
  const chunks = (detail.chunks as unknown[])?.length ?? 0;
  const entities = (detail.entities as unknown[])?.length ?? 0;
  const hyperedges = (detail.hyperedges as unknown[])?.length ?? 0;
  const summaries = (detail.summaries as unknown[])?.length ?? 0;
  const distills = (detail.distills as unknown[])?.length ?? 0;
  const items = engine === "graphiti"
    ? [
        { label: stageLabels.chunk ?? "切片", value: chunks, ok: chunks > 0 },
        { label: stageLabels.extract ?? "实体", value: entities, ok: entities > 0 },
        { label: stageLabels.distill ?? "蒸馏", value: distills, ok: distills > 0 },
        { label: stageLabels.hyperedge ?? "超边", value: hyperedges, ok: hyperedges > 0 },
      ]
    : [
        { label: stageLabels.chunk ?? "分块", value: chunks, ok: chunks > 0 },
        { label: stageLabels.summary ?? "摘要", value: summaries, ok: summaries > 0 },
      ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map((it) => (
        <div key={it.label} className="rounded-lg border border-border bg-card p-2.5">
          <div className="flex items-center gap-1.5">
            <span className={cn("h-1.5 w-1.5 rounded-full", it.ok ? "bg-emerald-500" : "bg-amber-400")} />
            <span className="text-[10px] font-medium text-foreground/70">{it.label}</span>
            <span className="ml-auto text-[8px] text-muted-foreground">{it.ok ? "已完成" : "待处理"}</span>
          </div>
          <div className="mt-1 text-lg font-bold text-foreground/90">{Number(it.value).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
};

// ── 通用列表体 ──
const ListBody: FC<{ title: string; items: Array<{ head: string; body: string; sub?: string }> }> = ({ title, items }) => (
  <div>
    <div className="mb-1.5 text-[10px] font-semibold text-muted-foreground">{title}</div>
    {items.length === 0 ? (
      <div className="rounded border border-dashed border-border p-3 text-[10px] text-muted-foreground">该文档暂无此数据</div>
    ) : (
      <div className="space-y-1.5">
        {items.map((it, i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-2">
            <div className="flex items-center gap-1.5 text-[10px] font-medium text-foreground/80">
              {it.head}
              {it.sub ? <span className="truncate text-[9px] font-normal text-muted-foreground">· {it.sub}</span> : null}
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-[10px] leading-4 text-foreground/70">{it.body}</p>
          </div>
        ))}
      </div>
    )}
  </div>
);
