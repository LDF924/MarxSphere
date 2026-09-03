// ExploreUniversePanel.tsx — Explore 知识宇宙图谱(阶段3, 对齐 Zleap Explore 模式)
// 数据: /api/universe API(PG 事件实体 + Graphiti 超边叠加)
// 渲染: EventEntityGraphView(force/radial/tree 三布局) + 搜索/穿越/详情
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, Orbit, Network } from "lucide-react";
import { EventEntityGraphView, type GraphEdgeInput, type GraphNodeInput } from "./EventEntityGraphView";
import { OrbitalGraph3DView } from "./OrbitalGraph3DView";
import type { OrbitalEdgeInput, OrbitalNodeInput } from "./OrbitalGraph3D";

import type {
  UniverseGraphPatch as UniverseGraphPatchContract,
  UniverseNodeDetail,
  UniverseTimelineSlice as UniverseTimelineSliceContract,
} from "../lib/universe-types";

/** 本地面板节点视图(事件/实体通用) */
interface UniverseNode {
  id: string;
  kind: "event" | "entity";
  label: string;
  category?: string;
  source_id?: string;
  source_name?: string;
  description?: string;
}

/** 本地面板关系视图 */
interface UniverseRelation {
  id: string;
  event_id: string;
  entity_id: string;
  description?: string;
  weight?: number;
}

/** 新契约 timeline */
type UniverseTimelineSlice = UniverseTimelineSliceContract;

/** 新契约 expand patch(anchor + nodes 展开) */
interface UniverseGraphPatch {
  nodes: UniverseNode[];
  relations: UniverseRelation[];
}

async function apiGet<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message ?? `请求失败: ${r.status}`);
  return data as T;
}

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message ?? `请求失败: ${r.status}`);
  return data as T;
}

/** 节点 → 图节点(事件/实体) */
function toGraphNodes(nodes: Array<{ id: string; kind: "event" | "entity"; label: string; category?: string }>): GraphNodeInput[] {
  return nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label || n.id.slice(0, 8),
    subtitle: n.category || (n.kind === "event" ? "事件" : "实体"),
  }));
}

/** 关系 → 图边 */
function toGraphEdges(relations: UniverseRelation[]): GraphEdgeInput[] {
  return relations.map((r) => ({
    id: r.id,
    fromId: r.event_id,
    toId: r.entity_id,
    method: r.description || "关联",
    confidence: r.weight ?? 1,
  }));
}

export function ExploreUniversePanel({ sourceId }: { sourceId?: string }) {
  const [timeline, setTimeline] = useState<UniverseTimelineSlice | null>(null);
  const [expanded, setExpanded] = useState<UniverseGraphPatch | null>(null);
  const [stats, setStats] = useState<{ events: number; entities: number; relations: number; graphiti: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceList, setSourceList] = useState<Array<{ source_id: string; label: string; event_count: number }>>([]);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  // 数据源: pg / graphiti / cognee
  const [dataSource, setDataSource] = useState<"pg" | "graphiti" | "cognee">("pg");
  const [sourceStatus, setSourceStatus] = useState<Array<{ id: string; label: string; online: boolean; events?: number; entities?: number; nodes?: number }>>([]);
  const [neoCenter, setNeoCenter] = useState<string | null>(null);
  // 非 PG 源数据(实体名+关系)
  const [neoEntities, setNeoEntities] = useState<Array<{ name: string; rel?: string }>>([]);
  const [neoNodes, setNeoNodes] = useState<Array<{ id: string; kind: "event" | "entity"; label: string; subtitle?: string }>>([]);
  const [neoEdges, setNeoEdges] = useState<Array<{ fromId: string; toId: string; rel: string }>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandingAll, setExpandingAll] = useState(false);
  const [detail, setDetail] = useState<UniverseNode | null>(null);
  const [viewMode, setViewMode] = useState<"2d" | "3d">("3d");
  const [entityTypeFilter, setEntityTypeFilter] = useState<string | null>(null);

  // 加载数据源状态(挂载时)
  useEffect(() => {
    apiGet<{ sources: Array<{ id: string; label: string; online: boolean; events?: number; entities?: number; nodes?: number }> }>("/api/universe/sources")
      .then((r) => setSourceStatus(r.sources ?? []))
      .catch(() => {});
  }, []);

  async function selectEntity(entityId: string, name: string, sourceOverride?: "pg" | "graphiti" | "cognee") {
    const src = sourceOverride ?? dataSource;
    setEntityPickerOpen(false);
    setEntityQuery(name);
    setSelectedId(entityId);
    if (src !== "pg") {
      // Neo 源: 中心实体 + 邻居 + 关系边(带色带标签)
      try {
        const r = await apiGet<{ entities: Array<{ name: string; rel?: string }>; edges?: Array<{ from: string; to: string; rel: string }> }>(
          `/api/universe/neo/query?source=${src}&name=${encodeURIComponent(name)}&limit=40`);
        const neighbors = r.entities ?? [];
        const edges = r.edges ?? [];
        const centerId = `center-${name}`;
        setNeoEntities(neighbors);
        setNeoNodes([
          // 中心实体: 事件色高亮(琥珀)便于识别
          { id: centerId, kind: "event", label: name, subtitle: `${src === "graphiti" ? "Graphiti" : "Cognee"} 中心实体` },
          // 邻居实体
          ...neighbors.map((e) => ({
            id: `n-${e.name}`, kind: "entity" as const, label: e.name, subtitle: e.rel || "关联",
          })),
        ]);
        setNeoEdges(edges.map((e) => ({
          fromId: e.from === name ? centerId : `n-${e.from}`,
          toId: e.to === name ? centerId : `n-${e.to}`,
          rel: e.rel,
        })));
        setNeoCenter(name);
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      return;
    }
    try {
      const patch = await apiPost<UniverseGraphPatchContract>("/api/universe/expand", {
        epoch: 1,
        source_id: activeSource ?? sourceId ?? "",
        node_kind: "entity",
        node_id: entityId,
        limit: 30,
      });
      const patchNodes: UniverseNode[] = [patch.anchor, ...patch.nodes].map((n) => ({
        id: n.id, kind: n.kind, label: n.label, category: n.category, source_id: n.source_id,
      }));
      const patchRelations: UniverseRelation[] = patch.relations.map((r, index) => ({
        id: `${r.from_id}:${r.to_id}:${index}`,
        event_id: r.from_id, entity_id: r.to_id, description: r.description, weight: r.weight,
      }));
      setExpanded({ nodes: patchNodes, relations: patchRelations });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 切换数据源: pg 走现有接口; graphiti/cognee 走 neo 查询
  const switchDataSource = async (src: "pg" | "graphiti" | "cognee") => {
    setDataSource(src);
    setNeoEntities([]);
    setNeoNodes([]);
    setNeoEdges([]);
    setEntityQuery("");
    setExpanded(null);
    if (src === "pg") { void load(); return; }
    // Neo4j 源: 拉热门实体作为初始网络
    setTimeline(null);
    try {
      const r = await apiGet<{ entities: Array<{ name: string }> }>(
        `/api/universe/neo/query?source=${src}&limit=10`);
      const hot = r.entities ?? [];
      if (hot.length > 0) {
        // 自动选中第一个热门实体呈现其网络
        await selectEntity("", hot[0].name, src);
      }
    } catch { /* 静默 */ }
  };
  // 实体选择面板(类似关系查询: 点开列表→搜索过滤→点选)
  const [entityPickerOpen, setEntityPickerOpen] = useState(false);
  const [entityQuery, setEntityQuery] = useState("");
  const [allEntities, setAllEntities] = useState<Array<{ id: string; name: string; type: string; event_count: number }>>([]);
  const [entityListLoading, setEntityListLoading] = useState(false);

  // 初始加载: manifest + timeline
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const manifest = await apiGet<{ counts: { events: number; entities: number; relations: number }; partitions: Array<{ source_id: string; label: string; event_count: number }>; graphiti?: boolean }>("/api/universe/manifest");
      // graphiti 字段 = Neo4j 11001 探测结果(后端 manifest 提供)
      setStats({ ...manifest.counts, graphiti: manifest.graphiti === true });
      setSourceList(manifest.partitions ?? []);
      // 优先已选源, 其次外部 sourceId, 再首个分区
      const chosen = activeSource || sourceId || manifest.partitions[0]?.source_id;
      if (!chosen) { setTimeline(null); return; }
      setActiveSource(chosen);
      const slice = await apiPost<UniverseTimelineSlice>("/api/universe/timeline", { epoch: 1, source_id: chosen, direction: "older", limit: 30 });
      setTimeline(slice);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sourceId, activeSource]);

  useEffect(() => { void load(); }, [load]);

  // 合并节点/边: timeline 基础 + expand 扩展
  const graphNodes = useMemo<GraphNodeInput[]>(() => {
    if (dataSource !== "pg") return neoNodes;
    const base: Array<{ id: string; kind: "event" | "entity"; label: string; category?: string }> = [];
    timeline?.bundles.forEach((bundle) => {
      base.push({ id: bundle.event.id, kind: "event", label: bundle.event.label, category: bundle.event.category });
      bundle.nodes.forEach((node) => base.push({ id: node.id, kind: "entity", label: node.label, category: node.category }));
    });
    const extra = expanded?.nodes ?? [];
    return toGraphNodes([...base, ...extra]);
  }, [dataSource, neoNodes, timeline, expanded]);

  const graphEdges = useMemo<GraphEdgeInput[]>(() => {
    if (dataSource !== "pg") {
      return neoEdges.map((e, i) => ({
        id: `neo-${i}-${e.rel}`,
        fromId: e.fromId,
        toId: e.toId,
        method: e.rel,
      }));
    }
    const base: UniverseRelation[] = [];
    timeline?.bundles.forEach((bundle) => {
      bundle.relations.forEach((relation) => {
        base.push({
          id: `${bundle.bundle_id}:${relation.to_id}`,
          event_id: relation.from_id,
          entity_id: relation.to_id,
          description: relation.description,
          weight: relation.weight,
        });
      });
    });
    const extra = expanded?.relations ?? [];
    return toGraphEdges([...base, ...extra]);
  }, [dataSource, neoEdges, timeline, expanded]);

  // 打开面板: pg 拉 graph 全量; neo 源提示先输入搜索
  const openEntityPicker = useCallback(async () => {
    setEntityPickerOpen((v) => !v);
    if (allEntities.length > 0 || entityListLoading) return;
    if (dataSource !== "pg") return; // Neo 源: 用输入搜索
    setEntityListLoading(true);
    try {
      const r = await apiGet<{ graph?: { entities: Array<{ id: string; name: string; type: string; eventCount: number }> } }>(
        `/api/projects/${encodeURIComponent(activeSource ?? sourceId ?? "")}/graph`);
      const ents = r.graph?.entities ?? [];
      setAllEntities(ents.slice(0, 100).map((e) => ({
        id: e.id, name: e.name, type: e.type, event_count: e.eventCount,
      })));
    } catch {
      setAllEntities([]);
    } finally {
      setEntityListLoading(false);
    }
  }, [activeSource, allEntities.length, dataSource, entityListLoading, sourceId]);

  // 列表过滤(输入即时过滤已加载的)
  const filteredEntityList = useMemo(() => {
    const q = entityQuery.trim().toLowerCase();
    if (!q) return allEntities;
    return allEntities.filter((e) => e.name.toLowerCase().includes(q));
  }, [allEntities, entityQuery]);

  // Neo 源搜索(输入触发 API): dataSource 动态判断避免 TS 收窄
  const sourceIsNeo = dataSource === "graphiti" || dataSource === "cognee";
  const neoSearchResults = useCallback(async (q: string) => {
    const src = dataSource;
    if (!q.trim() || src === "pg") return;
    try {
      const r = await apiGet<{ entities: Array<{ name: string }> }>(
        `/api/universe/neo/query?source=${src}&q=${encodeURIComponent(q)}&limit=15`);
      setNeoSearchList(r.entities ?? []);
    } catch {
      setNeoSearchList([]);
    }
  }, [dataSource]);
  const [neoSearchList, setNeoSearchList] = useState<Array<{ name: string }>>([]);

  // 选中实体 → 图谱聚焦其关联(expand 该实体, 呈现它的网络)

  // 实体类别统计(点击筛选用)
  const entityTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    graphNodes.forEach((n) => {
      if (n.kind !== "entity") return;
      const cat = n.subtitle || "未分类";
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [graphNodes]);

  // 按实体类别过滤: 选中类别 → 只留该类实体 + 关联事件; null → 全部
  const typeFilteredNodes = useMemo(() => {
    if (!entityTypeFilter) return graphNodes;
    const entities = graphNodes.filter((n) => n.kind === "entity" && (n.subtitle || "未分类") === entityTypeFilter);
    const entityIds = new Set(entities.map((n) => n.id));
    const events = graphNodes.filter((n) =>
      n.kind === "event" && graphEdges.some((e) =>
        (e.fromId === n.id && entityIds.has(e.toId)) || (e.toId === n.id && entityIds.has(e.fromId))));
    return [...events, ...entities];
  }, [entityTypeFilter, graphEdges, graphNodes]);

  // 节点详情
  const openDetail = async (nodeId: string) => {
    setSelectedId(nodeId);
    // 从已加载节点找 kind
    const node = graphNodes.find((n) => n.id === nodeId);
    if (!node) return;
    try {
      const detailData = await apiGet<UniverseNodeDetail>(`/api/universe/nodes/${node.kind}/${nodeId}`);
      setDetail({
        id: detailData.id,
        kind: detailData.kind,
        label: detailData.label,
        category: detailData.category,
        source_id: detailData.source_id,
        source_name: detailData.source_name,
        description: detailData.description,
      });
    } catch {
      setDetail(null);
    }
  };

  // 节点点击 → 扩展
  const onNodeClick = async (nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId);
    if (!node) return;
    try {
      const patch = await apiPost<UniverseGraphPatchContract>("/api/universe/expand", {
        epoch: 1,
        source_id: sourceId ?? "",
        node_kind: node.kind,
        node_id: nodeId,
        limit: 30,
      });
      // 新契约 patch: anchor + nodes(带 label/kind) → 本地节点/关系视图
      const patchNodes: UniverseNode[] = [patch.anchor, ...patch.nodes].map((n) => ({
        id: n.id,
        kind: n.kind,
        label: n.label,
        category: n.category,
        source_id: n.source_id,
      }));
      const patchRelations: UniverseRelation[] = patch.relations.map((r, index) => ({
        id: `${r.from_id}:${r.to_id}:${index}`,
        event_id: r.from_id,
        entity_id: r.to_id,
        description: r.description,
        weight: r.weight,
      }));
      setExpanded((prev) => ({
        nodes: [...(prev?.nodes ?? []), ...patchNodes.filter(
          (n) => !(prev?.nodes ?? []).some((x) => x.id === n.id))],
        relations: [...(prev?.relations ?? []), ...patchRelations.filter(
          (r) => !(prev?.relations ?? []).some((x) => x.id === r.id))],
      }));
      void openDetail(nodeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 搜索过滤(标题/名称包含)
  const filteredNodes = useMemo(() => {
    if (dataSource !== "pg") return typeFilteredNodes;
    if (!query.trim()) return typeFilteredNodes;
    const q = query.trim().toLowerCase();
    return typeFilteredNodes.filter((n) => n.label.toLowerCase().includes(q));
  }, [dataSource, query, typeFilteredNodes]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      {/* 统计条 */}
      {stats && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span>事件 <b className="text-foreground">{stats.events.toLocaleString()}</b></span>
          <span>实体 <b className="text-foreground">{stats.entities.toLocaleString()}</b></span>
          <span>关系 <b className="text-foreground">{stats.relations.toLocaleString()}</b></span>
          {stats.graphiti
            ? <span className="text-emerald-600">Graphiti 超边在线</span>
            : <span className="text-amber-600">Graphiti 离线(仅 PG 图谱)</span>}
          <span className="ml-auto text-[10px]">点击节点扩展 · 双击详情 · 悬停高亮</span>
        </div>
      )}

      {/* 实体选择面板(类似关系查询): 点按钮 → 列表 → 点选聚焦 */}
      <div className="relative">
        <button
          type="button"
          onClick={() => void openEntityPicker()}
          className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Search className="size-3.5" />
          {selectedId
            ? `已选: ${entityQuery || "实体"} (点击重新选择)`
            : "选择实体查看其网络…"}
          <span className="ml-auto text-[10px]">▼</span>
        </button>
        {entityPickerOpen && (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-background shadow-xl">
            <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1.5">
              <Search className="size-3 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={entityQuery}
                onChange={(e) => {
                  setEntityQuery(e.target.value);
                  if (dataSource !== "pg") void neoSearchResults(e.target.value);
                }}
                placeholder="搜索实体(如 资本下乡)…"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none"
              />
              <button type="button" onClick={() => setEntityPickerOpen(false)} className="text-[10px] text-muted-foreground hover:text-foreground">关闭</button>
            </div>
            <div className="max-h-64 overflow-y-auto">
              {(dataSource !== "pg" && neoSearchList.length > 0) ? (
                neoSearchList.map((e) => (
                  <button
                    key={e.name}
                    type="button"
                    onClick={() => void selectEntity("", e.name)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                  >
                    <span className="min-w-0 truncate">{e.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{dataSource === "graphiti" ? "Graphiti" : "Cognee"}</span>
                  </button>
                ))
              ) : entityListLoading ? (
                <div className="flex items-center justify-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> 加载实体列表…
                </div>
              ) : filteredEntityList.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {entityQuery ? "无匹配实体" : "暂无实体数据"}
                </div>
              ) : (
                filteredEntityList.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => void selectEntity(e.id, e.name)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                  >
                    <span className="min-w-0 truncate">
                      {e.name}
                      <span className="ml-2 text-[10px] text-muted-foreground">{e.type}</span>
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{e.event_count} 事件</span>
                  </button>
                ))
              )}
            </div>
            <div className="border-t border-border/60 px-3 py-1 text-center text-[10px] text-muted-foreground">
              共 {allEntities.length}+ 条 · 输入关键字过滤
            </div>
          </div>
        )}
      </div>

      {/* 数据源选择: PG / Graphiti / Cognee */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border px-2 py-1.5">
        <span className="text-[10px] text-muted-foreground">数据源</span>
        {[
          { id: "pg", label: "PG 图谱" },
          { id: "graphiti", label: "Graphiti" },
          { id: "cognee", label: "Cognee" },
        ].map((src) => {
          const st = sourceStatus.find((x) => x.id === src.id);
          const detail = st
            ? st.id === "pg" ? `(${st.events ?? 0} 事件)` : `(${st.nodes ?? 0} 节点)`
            : "";
          return (
            <button
              key={src.id}
              type="button"
              onClick={() => void switchDataSource(src.id as "pg" | "graphiti" | "cognee")}
              className={"flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] " +
                (dataSource === src.id
                  ? "bg-primary text-primary-foreground"
                  : st?.online
                    ? "bg-muted text-muted-foreground hover:bg-accent"
                    : "bg-muted/40 text-muted-foreground/50 hover:bg-accent")}
              title={st?.online ? `${src.label} 在线` : `${src.label} 离线`}
            >
              <span className={"size-1.5 rounded-full " + (st?.online ? "bg-emerald-500" : "bg-red-500/60")} />
              {src.label}
              {st && st.online && <span className="tabular-nums">{detail}</span>}
            </button>
          );
        })}
      </div>

      {/* 源选择 */}
      {sourceList.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
          <span className="text-[10px] text-muted-foreground">来源</span>
          <select
            value={activeSource ?? ""}
            onChange={(e) => setActiveSource(e.target.value || null)}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
            aria-label="选择数据来源"
          >
            {sourceList.map((src) => (
              <option key={src.source_id} value={src.source_id}>
                {src.label || src.source_id.slice(0, 12)}（{src.event_count ?? 0} 事件）
              </option>
            ))}
          </select>
          <span className="text-[10px] text-muted-foreground">{sourceList.length} 个来源</span>
        </div>
      )}

      {/* 实体类型筛选(点击筛选, 类似选择论文) */}
      {entityTypeCounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border px-2 py-1.5">
          <span className="text-[10px] text-muted-foreground">实体类型</span>
          <button
            type="button"
            onClick={() => setEntityTypeFilter(null)}
            className={"rounded-full px-2 py-0.5 text-[10px] " + (entityTypeFilter === null ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent")}
          >
            全部({graphNodes.filter((n) => n.kind === "entity").length})
          </button>
          {entityTypeCounts.slice(0, 15).map(([cat, count]) => (
            <button
              key={cat}
              type="button"
              onClick={() => setEntityTypeFilter(entityTypeFilter === cat ? null : cat)}
              className={"rounded-full px-2 py-0.5 text-[10px] " + (entityTypeFilter === cat ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent")}
            >
              {cat}({count})
            </button>
          ))}
        </div>
      )}

      {/* 操作栏: 展开全部 */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={async () => {
            const eventNodes = graphNodes.filter((n) => n.kind === "event").slice(0, 30);
            setExpandingAll(true);
            setError(null);
            try {
              for (const node of eventNodes) {
                const patch = await apiPost<UniverseGraphPatchContract>("/api/universe/expand", {
                  epoch: 1,
                  source_id: sourceId ?? "",
                  node_kind: "event",
                  node_id: node.id,
                  limit: 30,
                });
                const patchNodes: UniverseNode[] = [patch.anchor, ...patch.nodes].map((n) => ({
                  id: n.id, kind: n.kind, label: n.label, category: n.category, source_id: n.source_id,
                }));
                const patchRelations: UniverseRelation[] = patch.relations.map((r, index) => ({
                  id: `${r.from_id}:${r.to_id}:${index}`,
                  event_id: r.from_id, entity_id: r.to_id, description: r.description, weight: r.weight,
                }));
                setExpanded((prev) => ({
                  nodes: [...(prev?.nodes ?? []), ...patchNodes.filter(
                    (n) => !(prev?.nodes ?? []).some((x) => x.id === n.id))],
                  relations: [...(prev?.relations ?? []), ...patchRelations.filter(
                    (r) => !(prev?.relations ?? []).some((x) => x.id === r.id))],
                }));
              }
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setExpandingAll(false);
            }
          }}
          disabled={expandingAll || graphNodes.length === 0}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {expandingAll
            ? "展开中…"
            : `展开全部(${stats?.events ?? graphNodes.filter((n) => n.kind === "event").length} 事件)`}
        </button>
        <button
          type="button"
          onClick={() => setExpanded(null)}
          disabled={!expanded}
          className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          收起扩展
        </button>
      </div>

      {/* 搜索 */}
      <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
        <Search className="size-3.5 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索事件/实体…(过滤当前图谱)"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
        {query && (
          <button onClick={() => setQuery("")} className="text-[10px] text-muted-foreground hover:text-foreground">清除</button>
        )}
        {/* 2D/3D 切换 */}
        <div className="ml-2 flex rounded-md border border-border">
          <button
            type="button"
            onClick={() => setViewMode("2d")}
            className={"flex items-center gap-1 px-2 py-0.5 text-[10px] " + (viewMode === "2d" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")}
            title="2D 力导向/径向/树形"
          >
            <Network className="size-3" /> 2D
          </button>
          <button
            type="button"
            onClick={() => setViewMode("3d")}
            className={"flex items-center gap-1 px-2 py-0.5 text-[10px] " + (viewMode === "3d" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")}
            title="3D 轨道图"
          >
            <Orbit className="size-3" /> 3D
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid flex-1 place-items-center text-xs text-muted-foreground">加载知识宇宙…</div>
      ) : error ? (
        <div className="grid flex-1 place-items-center text-xs text-red-500">{error}</div>
      ) : (
        <>
          {/* 图谱: 2D(force/radial/tree) / 3D(轨道) */}
          <div className="h-[680px] shrink-0">
            {viewMode === "2d" ? (
              <div className="h-full">
                <EventEntityGraphView nodes={filteredNodes.slice(0, 300)} edges={graphEdges.filter((e) => filteredNodes.some((n) => n.id === e.fromId) && filteredNodes.some((n) => n.id === e.toId)).slice(0, 800)} onNodeClick={onNodeClick} />
              </div>
            ) : (
              <div className="h-full">
                <OrbitalGraph3DView
                  nodes={filteredNodes.slice(0, 120).map((n) => ({ id: n.id, kind: n.kind, label: n.label, subtitle: n.subtitle, category: n.kind === "event" ? n.subtitle : undefined })) as OrbitalNodeInput[]}
                  edges={graphEdges.filter((e) => filteredNodes.slice(0, 120).some((n) => n.id === e.fromId) && filteredNodes.slice(0, 120).some((n) => n.id === e.toId)).slice(0, 300) as OrbitalEdgeInput[]}
                />
              </div>
            )}
          </div>

          {/* 详情条 */}
          {detail && (
            <div className="rounded-md border border-border bg-card/60 p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">
                    {detail.label}
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {detail.kind === "event" ? "事件" : "实体"}
                    </span>
                  </div>
                  {detail.source_name && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground">来源: {detail.source_name}</div>
                  )}
                  <p className="mt-1.5 line-clamp-3 text-muted-foreground">
                    {detail.kind === "event" ? (detail.description || detail.category || "无摘要") : (detail.category || "无描述")}
                  </p>
                </div>
                <button
                  onClick={() => setDetail(null)}
                  className="shrink-0 rounded px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  ✕
                </button>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => { void onNodeClick(detail.id); }}
                  className="rounded bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20"
                >
                  扩展关联
                </button>
                {detail.source_id && (
                  <span className="rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">
                    source: {detail.source_id.slice(0, 8)}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 时间线分页 */}
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>时间线方向: {timeline?.request_direction === "older" ? "更早" : "更新"}</span>
            {timeline?.page.has_more && (
              <button
                onClick={async () => {
                  const slice = await apiPost<UniverseTimelineSlice>("/api/universe/timeline", { epoch: 1, source_id: sourceId ?? "", direction: "newer", limit: 30 });
                  setTimeline(slice);
                }}
                className="rounded bg-accent px-2 py-0.5 hover:bg-accent/70"
              >
                加载更近的事件 →
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
