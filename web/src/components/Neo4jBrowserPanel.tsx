// Neo4jBrowserPanel.tsx — Neo4j 库直连浏览（V400）
// 引擎切换(Graphiti/Cognee) + 节点类型统计 + 按类型列表 + 实体搜索 + 关系图
import { useState, useEffect, type FC } from "react";
import { Database, Search, Network, Loader2, RefreshCw, ChevronRight, ChevronDown } from "lucide-react";

interface LabelStat { label: string; count: number }
interface NodeProps { [k: string]: unknown }

export const Neo4jBrowserPanel: FC<{ engine: "graphiti" | "cognee" }> = ({ engine }) => {
  const [labels, setLabels] = useState<LabelStat[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [nodes, setNodes] = useState<NodeProps[]>([]);
  const [nodeCount, setNodeCount] = useState(0);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<NodeProps[]>([]);
  const [searching, setSearching] = useState(false);
  const [graphCenter, setGraphCenter] = useState("");
  const [graphData, setGraphData] = useState<{ nodes: Array<{ name: string; props: NodeProps }>; edges: Array<{ source: string; target: string; relation: string }> } | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [expandedNode, setExpandedNode] = useState<number | null>(null);

  const loadStats = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/neo4j/stats?engine=${engine}`);
      const d = await r.json();
      setTotal(d.total ?? 0);
      setLabels(d.labels ?? []);
    } catch { /* 忽略 */ }
    setLoading(false);
  };

  useEffect(() => { void loadStats(); }, [engine]);

  const loadLabel = async (label: string) => {
    setSelectedLabel(label);
    setNodesLoading(true);
    try {
      const r = await fetch(`/api/neo4j/label?engine=${engine}&label=${encodeURIComponent(label)}&limit=30`);
      const d = await r.json();
      setNodes(d.nodes ?? []);
      setNodeCount(d.count ?? 0);
    } catch { setNodes([]); }
    setNodesLoading(false);
  };

  const doSearch = async () => {
    if (!searchQ.trim()) return;
    setSearching(true);
    try {
      const r = await fetch(`/api/neo4j/search?engine=${engine}&q=${encodeURIComponent(searchQ)}`);
      const d = await r.json();
      setSearchResults(d.nodes ?? []);
    } catch { setSearchResults([]); }
    setSearching(false);
  };

  const loadGraph = async (name: string) => {
    setGraphCenter(name);
    setGraphLoading(true);
    try {
      const r = await fetch(`/api/neo4j/graph?engine=${engine}&name=${encodeURIComponent(name)}`);
      const d = await r.json();
      setGraphData(d);
    } catch { setGraphData(null); }
    setGraphLoading(false);
  };

  const fmt = (v: unknown): string => {
    if (v === null || v === undefined) return "—";
    if (typeof v === "object") {
      const o = v as { low?: number };
      if (typeof o.low === "number") return String(o.low);
      return JSON.stringify(v).slice(0, 40);
    }
    return String(v).slice(0, 40);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Database className="h-4 w-4 text-sky-600" />
        <h2 className="text-sm font-semibold">Neo4j 库浏览</h2>
        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] text-sky-700">
          {engine === "graphiti" ? "Graphiti :11001" : "Cognee :11003"}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">共 {total.toLocaleString()} 节点</span>
        <button onClick={() => void loadStats()} className="rounded p-1 text-muted-foreground hover:bg-muted" title="刷新">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：类型统计 + 搜索 */}
        <div className="w-60 shrink-0 space-y-3 overflow-y-auto border-r p-2">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold text-muted-foreground">搜索实体</div>
            <div className="flex gap-1">
              <input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void doSearch()}
                placeholder="实体名…"
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px]"
              />
              <button onClick={() => void doSearch()} disabled={searching} className="rounded bg-sky-600 px-2 text-white hover:bg-sky-700 disabled:opacity-50">
                {searching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
              </button>
            </div>
            {searchResults.length > 0 && (
              <div className="mt-1.5 space-y-1">
                {searchResults.slice(0, 8).map((n, i) => (
                  <div key={i} className="rounded border border-border bg-card p-1.5 text-[10px]">
                    <button onClick={() => void loadGraph(String(n.name || n.title || ""))} className="block w-full truncate text-left font-medium text-sky-700 hover:underline">
                      {String(n.name || n.title || "(未命名)")}
                    </button>
                    <div className="mt-0.5 truncate text-muted-foreground">{fmt(n.type || n.embedding_type || "")}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-[10px] font-semibold text-muted-foreground">节点类型（{labels.length}）</div>
            {loading ? <div className="p-2 text-[10px] text-muted-foreground">加载中…</div> : (
              <div className="space-y-0.5">
                {labels.map((l) => (
                  <button
                    key={l.label}
                    onClick={() => void loadLabel(l.label)}
                    className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] hover:bg-muted ${selectedLabel === l.label ? "bg-sky-50 text-sky-800" : ""}`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                    <span className="min-w-0 flex-1 truncate">{l.label}</span>
                    <span className="text-[9px] text-muted-foreground">{l.count.toLocaleString()}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右：节点列表 / 关系图 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {graphData && graphCenter ? (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Network className="h-3.5 w-3.5 text-violet-600" />
                <span className="text-[11px] font-semibold">「{graphCenter}」关系图</span>
                <span className="text-[10px] text-muted-foreground">{graphData.nodes.length} 节点 / {graphData.edges.length} 关系</span>
                <button onClick={() => setGraphData(null)} className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-accent">返回列表</button>
              </div>
              <div className="space-y-1">
                {graphData.edges.map((e, i) => (
                  <div key={i} className="flex items-center gap-1.5 rounded-lg border border-border bg-card p-1.5 text-[10px]">
                    <button onClick={() => void loadGraph(e.source)} className="truncate font-medium text-sky-700 hover:underline">{e.source}</button>
                    <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[9px] text-violet-700">{e.relation}</span>
                    <button onClick={() => void loadGraph(e.target)} className="truncate font-medium text-sky-700 hover:underline">{e.target}</button>
                  </div>
                ))}
              </div>
            </div>
          ) : selectedLabel ? (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[11px] font-semibold">{selectedLabel}</span>
                <span className="text-[10px] text-muted-foreground">{nodeCount.toLocaleString()} 个 · 显示前 30</span>
                <button onClick={() => setSelectedLabel(null)} className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-accent">返回类型</button>
              </div>
              {nodesLoading ? <div className="p-3 text-[10px] text-muted-foreground">加载中…</div> : (
                <div className="space-y-1">
                  {nodes.map((n, i) => {
                    const name = String(n.name || n.title || `#${i + 1}`);
                    const keys = Object.keys(n).slice(0, 5);
                    return (
                      <div key={i} className="rounded-lg border border-border bg-card">
                        <button
                          onClick={() => setExpandedNode(expandedNode === i ? null : i)}
                          className="flex w-full items-center gap-1.5 p-2 text-left text-[11px]"
                        >
                          {expandedNode === i ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
                          <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                          <button onClick={(e) => { e.stopPropagation(); void loadGraph(name); }} className="shrink-0 rounded bg-violet-50 px-1.5 py-0.5 text-[9px] text-violet-700 hover:bg-violet-100">关系</button>
                        </button>
                        {expandedNode === i && (
                          <div className="border-t border-border/50 p-2">
                            {keys.map((k) => (
                              <div key={k} className="flex gap-1.5 py-0.5 text-[10px]">
                                <span className="w-24 shrink-0 truncate text-muted-foreground">{k}</span>
                                <span className="min-w-0 break-words">{fmt(n[k])}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {nodes.length === 0 && <div className="p-2 text-[10px] text-muted-foreground">无节点</div>}
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
              选择左侧节点类型浏览，或搜索实体 · 点「关系」查看邻接图
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
