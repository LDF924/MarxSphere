// TraversalPanel.tsx — 关系查询：从实体出发，按方向（入/出/双向）+ 深度遍历关系网络
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, GitCommitHorizontal, Loader2, Network, Search, X } from "lucide-react";
import { traverseGraph, type TraversalDirection, type TraversalResult } from "../lib/graph-traversal";
import type { ProjectGraphRecord } from "../types";
import { useI18n } from "../i18n";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

export function TraversalPanel(props: {
  graph: ProjectGraphRecord;
  onHighlight: (entityIds: string[]) => void;
}) {
  const { t } = useI18n();
  const [startId, setStartId] = useState("");
  const [direction, setDirection] = useState<TraversalDirection>("out");
  const [depth, setDepth] = useState(2);
  const [result, setResult] = useState<TraversalResult | null>(null);
  const [running, setRunning] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // 2026-08-07 性能：不再全量排序 5 万实体（首帧卡顿根源）——默认顺序即可，搜索时过滤
  const entityOptions = props.graph.entities;

  // 搜索过滤（2026-08-07 性能：最多扫 2000 条就停，避免全量 5 万条 filter 卡顿）
  const filteredOptions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return entityOptions;
    const out: typeof entityOptions = [];
    for (const e of entityOptions) {
      if (e.name.toLowerCase().includes(q)) out.push(e);
      if (out.length >= 2000) break;
    }
    return out;
  }, [entityOptions, searchQuery]);
  // 2026-08-07 修复：原生 select 渲染 5 万选项 → 下拉框巨大/灰色空白/超出视口
  // 改为自定义选择器：显示最近选中的实体名，点开是搜索框 + 过滤列表（最多 50 条）
  const [pickerOpen, setPickerOpen] = useState(false);
  // 2026-08-07 无限滚动：初始 50 条，滚动到底部 +50（不截断，5 万实体都可浏览）
  const [visibleCount, setVisibleCount] = useState(50);
  const selectedEntity = startId
    ? props.graph.entities.find((e) => e.id === startId)
    : undefined;
  const selectEntity = (id: string) => {
    setStartId(id);
    setPickerOpen(false);
    setRunning(true);
    setTimeout(() => {
      setResult(traverseGraph(props.graph, id, direction, depth));
      setRunning(false);
    }, 50);
  };
  // 打开/关闭面板（toggle）：重置可见数
  const openPicker = () => {
    if (pickerOpen) {
      setPickerOpen(false);
      return;
    }
    setPickerOpen(true);
    setVisibleCount(50);
    setSearchQuery("");
  };

  const runQuery = () => {
    if (!startId) return;
    setRunning(true);
    // 模拟异步让 UI 反馈
    setTimeout(() => {
      setResult(traverseGraph(props.graph, startId, direction, depth));
      setRunning(false);
    }, 50);
  };

  const changeDirection = (dir: TraversalDirection) => {
    setDirection(dir);
    // 已选起点时自动重查，无需再点"查询"
    if (startId) {
      setRunning(true);
      setTimeout(() => {
        setResult(traverseGraph(props.graph, startId, dir, depth));
        setRunning(false);
      }, 50);
    }
  };

  const changeDepth = (d: number) => {
    setDepth(d);
    // 已选起点时自动重查
    if (startId) {
      setRunning(true);
      setTimeout(() => {
        setResult(traverseGraph(props.graph, startId, direction, d));
        setRunning(false);
      }, 50);
    }
  };

  const clearSelection = () => {
    setStartId("");
    setResult(null);
    setSearchQuery("");
  };

  const highlight = () => {
    if (!result) return;
    props.onHighlight(result.nodes.map((n) => n.entityId));
  };

  const directionLabel: Record<TraversalDirection, string> = {
    in: t("入（谁引用它）", "in"),
    out: t("出（它指向谁）", "out"),
    both: t("双向", "both")
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 查询工具栏 */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-background/95 p-2 text-sm">
        <label className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">{t("起点实体", "Start entity")}</span>
          {/* 实体搜索框 */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("搜索实体…", "Search entity…")}
              className="w-36 rounded-md border border-border bg-background py-1 pl-7 pr-2 text-sm outline-none focus-visible:border-primary/60"
            />
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent" aria-label="清空搜索">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          {/* 2026-08-07 自定义实体选择器（替代 5 万选项的原生 select） */}
          <div className="relative">
            <button
              type="button"
              onClick={openPicker}
              className="flex max-w-56 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              <span className="max-w-[180px] truncate">
                {selectedEntity ? `${selectedEntity.name}（${selectedEntity.eventCount}）` : t("选择实体…", "Select…")}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
            {pickerOpen && (
              <div
                className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-border bg-background p-2 shadow-lg"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setVisibleCount(50); }}
                  placeholder={t("搜索实体…", "Search entity…")}
                  autoFocus
                  className="mb-1.5 w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:border-primary/60"
                />
                <div
                  className="max-h-56 space-y-0.5 overflow-y-auto pr-1"
                  onScroll={(e) => {
                    // 滚动到底部 +50（无限滚动，防抖：只在本批显示完时触发）
                    const el = e.currentTarget;
                    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 20) {
                      setVisibleCount((prev) => {
                        const next = Math.min(prev + 50, filteredOptions.length);
                        return next === prev ? prev : next;
                      });
                    }
                  }}
                >
                  {filteredOptions.slice(0, visibleCount).map((entity) => (
                    <button
                      key={entity.id}
                      type="button"
                      onClick={() => selectEntity(entity.id)}
                      className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] hover:bg-accent/50"
                    >
                      <span className="min-w-0 flex-1 truncate">{entity.name}</span>
                      <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">{entity.eventCount}</span>
                    </button>
                  ))}
                  {filteredOptions.length === 0 && (
                    <div className="px-1 py-2 text-[11px] text-muted-foreground">{t("无匹配实体", "No matching entity")}</div>
                  )}
                  {visibleCount < filteredOptions.length && (
                    <button
                      type="button"
                      onClick={() => setVisibleCount((prev) => Math.min(prev + 100, filteredOptions.length))}
                      className="w-full rounded px-1.5 py-1.5 text-center text-[10px] text-muted-foreground hover:bg-accent/50"
                    >
                      {t("加载更多", "Load more")}（{filteredOptions.length - visibleCount} 条剩余）
                    </button>
                  )}
                </div>
                <div className="mt-1 border-t border-border/50 pt-1 text-[9px] text-muted-foreground/70">
                  {t("共", "Total")} {filteredOptions.length} {t("条 · 滚动加载更多或搜索", "items · scroll to load more or search")}
                </div>
              </div>
            )}
          </div>
          {startId && (
            <button
              type="button"
              onClick={clearSelection}
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-red-50 hover:text-red-600"
              title={t("清除选择", "Clear")}
              aria-label={t("清除选择", "Clear")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {(Object.keys(directionLabel) as TraversalDirection[]).map((dir) => (
            <button
              key={dir}
              type="button"
              onClick={() => changeDirection(dir)}
              className={`rounded px-2 py-1 text-xs ${direction === dir ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {directionLabel[dir]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {[1, 2, 3].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => changeDepth(d)}
              className={`rounded px-2 py-1 text-xs ${depth === d ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {t("深度", "depth")} {d}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => void runQuery()} disabled={!startId || running}>
          {running ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Network className="mr-1 h-3.5 w-3.5" />}
          {t("查询", "Query")}
        </Button>
        {result && (
          <Button size="sm" variant="outline" onClick={highlight}>
            {t("在图里高亮", "Highlight in graph")}
          </Button>
        )}
      </div>

      {/* 结果 — 2026-08-07 内容自适应（不撑满全高），最多 60vh 滚动 */}
      {result ? (
        <Card className="max-h-[60vh] min-h-0 overflow-y-auto p-3">
          <div className="mb-2 text-sm font-medium">
            {t("遍历结果", "Traversal result")}
            <span className="ml-2 text-xs text-muted-foreground">{result.hitCount} {t("个实体", "entities")}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {directionLabel[direction]} · {t("深度", "depth")} {depth}
            </span>
          </div>
          {result.nodes.length === 0 ? (
            <div className="text-sm text-muted-foreground">{t("无关联实体", "No related entities")}</div>
          ) : (
            <div className="space-y-1.5">
              {result.nodes.map((node) => (
                <div key={node.entityId} className="rounded border border-border/60 px-2 py-1.5 text-sm">
                  <div className="flex items-center gap-2">
                    <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-medium">{node.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t("深度", "depth")} {node.depth}
                    </span>
                  </div>
                  <div className="mt-1 pl-6 text-xs leading-5 text-muted-foreground">
                    {node.path.join(" → ")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <div className="flex min-h-[80px] items-center justify-center rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          {t("选择起点实体 → 方向 → 深度 → 查询。图例：实体→[事件]→实体。", "Select start entity, direction, depth, then query.")}
        </div>
      )}
    </div>
  );
}
