// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ForceGraphPanel.tsx — 力导向视图：d3-force 仿真驱动 React Flow 节点
// 参数（charge/linkDistance/centering）可拖拽调节 + localStorage 持久化
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  useEdgesState,
  useNodesState,
  useReactFlow
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ProjectGraphRecord } from "../types";
import { loadForceParams, runForceSimulation, saveForceParams, type ForceParams } from "../lib/force-layout";
import type { ForceLinkDatum, ForceNodeDatum } from "../lib/force-layout";
import { useI18n } from "../i18n";
import { Button } from "./ui/button";

const OVERVIEW_LIMIT = 50;

export function ForceGraphPanel(props: {
  graph: ProjectGraphRecord;
  language: "zh" | "en";
  onOpenEntity: (entityId: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <ForceGraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function ForceGraphCanvas(props: { graph: ProjectGraphRecord; language: "zh" | "en"; onOpenEntity: (entityId: string) => void }) {
  const { t } = useI18n();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [params, setParams] = useState<ForceParams>(() => loadForceParams());
  // 2026-08-07 防全量：mount 时强制概览（不继承上次 fullMode 残留）
  const [fullMode, setFullMode] = useState(() => {
    const saved = sessionStorage.getItem("sag-force-fullmode");
    return saved === "1" ? true : false;
  });
  // 2026-08-07 力导向筛选：论文标题搜索 + 批量选择（selected 非空时只渲染勾选）
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPapers, setSelectedPapers] = useState<Set<string>>(new Set());
  const [showPaperPicker, setShowPaperPicker] = useState(false);
  const simulationRef = useRef<{ stop: () => void; restart: (p: ForceParams) => void } | null>(null);
  const fitDoneRef = useRef(false);

  // 选择节点子集：概览 = top-500 实体（eventCount 排序）+ 关联事件；全量 = 全部
  // 注意：依赖 props.graph（稳定引用）而非派生数组——避免每次渲染重建导致 effect 死循环
  const { subNodes, subEvents, subEdges } = useMemo(() => {
    // 2026-08-07 筛选：勾选论文后只渲染勾选的
    const entities = selectedPapers.size > 0
      ? props.graph.entities.filter((e) => selectedPapers.has(e.id))
      : fullMode
        ? props.graph.entities
        : [...props.graph.entities].sort((a, b) => (b.eventCount ?? 0) - (a.eventCount ?? 0)).slice(0, OVERVIEW_LIMIT);
    const entityIds = new Set(entities.map((e) => e.id));
    // 2026-08-07 防全量：概览模式限制事件/边规模（50 实体 + 最多 200 事件）
    const rawEvents = props.graph.events.filter((ev) => ev.entityIds.some((id) => entityIds.has(id)));
    const events = selectedPapers.size > 0 || fullMode
      ? rawEvents
      : [...rawEvents].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)).slice(0, 200);
    const eventIds = new Set(events.map((e) => e.id));
    const edgeList = props.graph.edges.filter((ed) => entityIds.has(ed.entityId) && eventIds.has(ed.eventId));
    return { subNodes: entities, subEvents: events, subEdges: edgeList };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.graph, fullMode, selectedPapers]);

  // 启动/重启仿真（实体 + 事件都作为节点；事件节点小号灰底）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    const allNodes: Array<{ id: string; kind: "entity" | "event"; name: string }> = [
      ...subNodes.map((e) => ({ id: e.id, kind: "entity" as const, name: e.name })),
      ...subEvents.map((ev) => ({ id: ev.id, kind: "event" as const, name: ev.title.slice(0, 30) }))
    ];
    const forceNodes: ForceNodeDatum[] = allNodes.map((n, i) => ({
      id: n.id,
      x: width / 2 + (i % 20 - 10) * 30,
      y: height / 2 + Math.floor(i / 20) * 30
    }));
    const forceLinks: ForceLinkDatum[] = subEdges.map((ed) => ({ source: ed.entityId, target: ed.eventId }));

    const handle = runForceSimulation({
      nodes: forceNodes,
      links: forceLinks,
      params,
      width,
      height,
      onTick: (tickNodes) => {
        const nodeById = new Map(tickNodes.map((n) => [n.id, n]));
        setNodes(
          allNodes.map((n) => {
            const pos = nodeById.get(n.id);
            const isEntity = n.kind === "entity";
            return {
              id: n.id,
              position: { x: pos?.x ?? 0, y: pos?.y ?? 0 },
              data: { label: n.name, kind: n.kind },
              style: {
                width: isEntity ? 140 : 150,
                borderRadius: 6,
                // 深色主题兼容：硬编码亮色 → CSS 变量（样式由 App 主题注入）
                border: "1px solid var(--graph-node-border, #d4d4d8)",
                background: isEntity ? "var(--graph-node-bg, #ffffff)" : "var(--graph-node-bg-alt, #f8fafc)",
                color: "var(--graph-node-fg, #111827)",
                fontSize: 12,
                fontWeight: isEntity ? 650 : 520,
                padding: "8px 10px"
              }
            } satisfies Node;
          })
        );
        setEdges(
          subEdges.map((ed) => ({
            id: `${ed.entityId}-${ed.eventId}`,
            source: ed.entityId,
            target: ed.eventId,
            style: { stroke: "var(--graph-edge, #d4d4d8)", strokeWidth: 1.2 }
          }))
        );
        if (!fitDoneRef.current) {
          fitDoneRef.current = true;
          window.requestAnimationFrame(() => fitView({ padding: 0.15, duration: 300 }));
        }
      }
    });
    simulationRef.current = handle;
    return () => handle.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.graph, fullMode, params]);

  const updateParams = (patch: Partial<ForceParams>) => {
    setParams((prev) => {
      const next = { ...prev, ...patch };
      saveForceParams(next);
      simulationRef.current?.restart(next);
      return next;
    });
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-2">
      {/* 参数工具栏 */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-background/95 p-2 text-xs">
        <span className="font-medium">{t("力导向参数", "Force params")}</span>
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">{t("斥力", "charge")}</span>
          <input type="range" min={-1200} max={-50} step={10} value={params.charge}
            onChange={(e) => updateParams({ charge: Number(e.target.value) })} className="w-24" />
          <span className="w-12 text-right text-muted-foreground">{params.charge}</span>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">{t("连边距离", "link dist")}</span>
          <input type="range" min={20} max={220} step={5} value={params.linkDistance}
            onChange={(e) => updateParams({ linkDistance: Number(e.target.value) })} className="w-24" />
          <span className="w-12 text-right text-muted-foreground">{params.linkDistance}</span>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">{t("向心力", "centering")}</span>
          <input type="range" min={0} max={0.5} step={0.01} value={params.centerStrength}
            onChange={(e) => updateParams({ centerStrength: Number(e.target.value) })} className="w-24" />
          <span className="w-12 text-right text-muted-foreground">{typeof params.centerStrength === "number" ? params.centerStrength.toFixed(2) : "0.00"}</span>
        </label>
        <div className="ml-auto flex items-center gap-2">
          {/* 2026-08-07 力导向筛选：论文标题搜索 + 批量选择 */}
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("搜索论文标题…", "Search paper…")}
            className="w-40 rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
          <div className="relative">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowPaperPicker((v) => !v)}>
              {t("选择论文", "Select")}{selectedPapers.size > 0 ? ` (${selectedPapers.size})` : ""}
            </Button>
            {showPaperPicker && (
              <div
                className="absolute right-0 top-full z-20 mt-1.5 w-72 rounded-md border border-border bg-background/95 p-2 shadow-lg"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-medium">{t("选择要渲染的论文", "Select papers")}</span>
                  <div className="flex gap-1">
                    <button type="button" onClick={() => setSelectedPapers(new Set(props.graph.entities.map((e) => e.id)))}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">全选</button>
                    <button type="button" onClick={() => setSelectedPapers(new Set())}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">清空</button>
                  </div>
                </div>
                <div className="max-h-52 space-y-0.5 overflow-y-auto pr-1">
                  {props.graph.entities
                    .filter((e) => !searchQuery || e.name.toLowerCase().includes(searchQuery.toLowerCase()))
                    .slice(0, 50)
                    .map((e) => (
                      <label key={e.id} className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] hover:bg-accent/50">
                        <input
                          type="checkbox"
                          checked={selectedPapers.has(e.id)}
                          onChange={() => {
                            setSelectedPapers((prev) => {
                              const next = new Set(prev);
                              if (next.has(e.id)) next.delete(e.id);
                              else next.add(e.id);
                              return next;
                            });
                          }}
                          className="h-3 w-3"
                        />
                        <span className="min-w-0 flex-1 truncate">{e.name}</span>
                      </label>
                    ))}
                </div>
              </div>
            )}
          </div>
          <Button type="button" variant={fullMode ? "default" : "outline"} size="sm" onClick={() => { fitDoneRef.current = false; setFullMode((v) => !v); }}>
            {fullMode ? t("概览", "Overview") : t("全量", "Full")}
          </Button>
          <span className="text-muted-foreground">{subNodes.length} {t("节点", "nodes")} / {subEdges.length} {t("边", "edges")}</span>
        </div>
      </div>

      {/* 画布 */}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-background">
        <ReactFlow<Node, Edge>
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDoubleClick={(_, node) => props.onOpenEntity(node.id)}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.05}
          maxZoom={3}
          nodesDraggable
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={() => "var(--graph-node-fg, #111827)"} maskColor="var(--graph-minimap-mask, rgba(255,255,255,0.65))" />
        </ReactFlow>
        {!fullMode && subNodes.length >= OVERVIEW_LIMIT && (
          <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/90 px-2 py-1 text-[11px] text-muted-foreground">
            {t("概览模式：仅显示 eventCount 最高的前 500 个实体（事件节点已含）", "Overview: top-500 entities by eventCount")}
          </div>
        )}
      </div>
    </div>
  );
}
