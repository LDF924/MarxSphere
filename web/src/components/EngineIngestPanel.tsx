// EngineIngestPanel.tsx — Graphiti/Cognee 引擎入库面板（V399）
// 触发 orchestrate_ingest.py 后台入库 + 状态轮询 + 引擎健康检查
import { useState, useEffect, type FC } from "react";
import { Play, Loader2, Database, RefreshCw, CheckCircle2, Eye } from "lucide-react";
import { Neo4jBrowserPanel } from "./Neo4jBrowserPanel";
import { IngestMonitorPanel } from "./IngestMonitorPanel";

interface EngineIngestPanelProps {
  engine: "graphiti" | "cognee";
}

const ENGINE_INFO: Record<string, { name: string; port: number; desc: string; label: string }> = {
  graphiti: { name: "Graphiti", port: 11001, desc: "实体蒸馏 + 消歧 + 超边（五层蒸馏）", label: "实体级知识图谱" },
  cognee: { name: "Cognee", port: 11003, desc: "概念图谱 + 向量（add + cognify）", label: "概念级知识图谱" },
};

export const EngineIngestPanel: FC<EngineIngestPanelProps> = ({ engine }) => {
  const info = ENGINE_INFO[engine];
  const [view, setView] = useState<"ingest" | "browse">("ingest"); // 默认入库操作页（V406 改回：一进来应看到入库）
  const [browseMode, setBrowseMode] = useState<"browser" | "list">("list"); // V404: 默认列表浏览（Neo4j 5.26 内置 browser 为空，iframe 不可用）
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState<boolean | null>(null);
  const [nodeCount, setNodeCount] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // V403: Demo 演示 — 模拟入库流程（不真跑）
  const [demoRunning, setDemoRunning] = useState(false);
  const [demoStep, setDemoStep] = useState(0);
  const [demoDone, setDemoDone] = useState(false); // V405: 完成后保留流程展示

  // V404: Demo 阶段 = skill 真实流程（marx-graphiti-ingest 6 阶段 / marx-cognee-ingest 3+1 步）
  const demoStages = engine === "graphiti"
    ? [
        "扫描发现新增文献（ov_import vs Neo4j 差集）",
        "批量实体抽取（Episode + Entity + Relation 节点）",
        "知识蒸馏五层（LiteratureDistill 节点）",
        "向量化（text-embedding-v4 1024 维）",
        "消歧聚类清洗（合并重复实体 + 社区分配）",
        "超边抽取（HyperEdge + INVOLVED_IN 关联）",
        "checkpoint 原子写入 + 完整性校验",
      ]
    : [
        "copy 论文到 .batch_current",
        "cognee.add 文件分块（DocumentChunk → TextDocument）",
        "cognee.cognify 认知处理（Entity 抽取 → 关系）",
        "向量化嵌入（LanceDB）",
        "完整性校验（切片数 vs 实体数）",
      ];

  // 状态轮询
  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetch(`/api/ingest/engine/status?engine=${engine}`);
        const d = await r.json();
        setRunning(d.running ?? false);
        setStartedAt(d.startedAt);
      } catch { /* 忽略 */ }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [engine]);

  const start = async () => {
    setNote("正在启动入库（后台执行，可能耗时较长）…");
    try {
      const r = await fetch("/api/ingest/engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine }),
      });
      const d = await r.json();
      if (d.error) { setNote(d.error.message || "启动失败"); return; }
      setRunning(true);
      setStartedAt(d.startedAt);
      setNote(`${info.name} 入库已启动，后台执行中（可离开此页，进度会继续）`);
    } catch {
      setNote("启动失败：服务不可达");
    }
  };

  // V403: Demo 演示 — 模拟入库流程逐步推进（不真跑）
  const runDemo = () => {
    setDemoRunning(true);
    setDemoDone(false);
    setDemoStep(0);
    setNote("");
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      setDemoStep(step);
      if (step >= demoStages.length) {
        clearInterval(timer);
        setDemoRunning(false);
        setDemoDone(true); // V405: 保留完整流程展示
        setNote(`Demo 完成：${info.name} 入库流程共 ${demoStages.length} 个阶段（真实执行需 1-2 小时）`);
      }
    }, 1200);
  };

  const checkHealth = async () => {
    setChecking(true);
    setNote("");
    try {
      // 直连 Neo4j bolt 探测
      const r = await fetch(`/api/ingest/engine/status?engine=${engine}`);
      await r.json();
      // 用 Neo4j 端口探测引擎健康
      const sock = await fetch(`http://127.0.0.1:${info.port}/`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      setHealth(!!sock); // V381 fix: 原 || true 恒真, 健康指示失真
      setNodeCount("探测完成（详见图谱面板）");
      setNote(`${info.name} 引擎探测：端口 ${info.port} 已监听`);
    } catch {
      setHealth(false);
      setNote(`${info.name} 引擎不可达（端口 ${info.port}）`);
    }
    setChecking(false);
  };

  // V405: 入库实时数据监控 — 入库中每 10 秒刷新节点数（旁边可见数据增长）
  const [liveTotal, setLiveTotal] = useState<number | null>(null);
  const [liveLabels, setLiveLabels] = useState<Array<{ label: string; count: number }>>([]);
  useEffect(() => {
    const refresh = async () => {
      try {
        const r = await fetch(`/api/neo4j/stats?engine=${engine}`);
        const d = await r.json();
        setLiveTotal(typeof d.total === "number" ? d.total : 0);
        setLiveLabels(d.labels ?? []);
      } catch { /* 忽略 */ }
    };
    void refresh();
    if (!running) return;
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [engine, running]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* V400: 入库/浏览 切换 */}
      <div className="flex items-center gap-1 border-b px-4 py-1.5">
        {(["ingest", "browse"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setView(tab)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${view === tab ? "bg-violet-500/15 text-violet-600" : "text-muted-foreground hover:bg-muted"}`}
          >
            {tab === "ingest" ? "入库" : "库浏览"}
          </button>
        ))}
      </div>
      {view === "browse" ? (
        // V402: iframe 嵌入 Neo4j Browser（主）+ 列表浏览（备）
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b px-3 py-1.5">
            <Database className="h-3 w-3 text-sky-600" />
            <span className="text-[11px] font-semibold">Neo4j Browser</span>
            <span className="text-[10px] text-muted-foreground">端口 :{info.port} · 连接: bolt://127.0.0.1:{info.port} · neo4j/neo4j123</span>
            <div className="ml-auto flex gap-1">
              {(["list", "browser"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setBrowseMode(m)}
                  className={`rounded px-2 py-0.5 text-[10px] ${browseMode === m ? "bg-sky-100 text-sky-700" : "text-muted-foreground hover:bg-muted"}`}
                  title={m === "browser" ? "Neo4j 5.26 内置 browser 为空，不可用" : "类型统计/节点列表/搜索/关系"}
                >
                  {m === "browser" ? "图浏览器" : "列表浏览"}
                </button>
              ))}
            </div>
          </div>
          {browseMode === "browser" ? (
            <iframe
              src={`http://127.0.0.1:${info.port}/browser/`}
              className="w-full flex-1 border-0"
              title={`${info.name} Neo4j Browser`}
            />
          ) : (
            <Neo4jBrowserPanel engine={engine} />
          )}
        </div>
      ) : (
      <>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Database className="h-4 w-4 text-violet-600" />
        <h2 className="text-sm font-semibold">{info.name} 入库</h2>
        <span className="text-[10px] text-muted-foreground">{info.label} · Neo4j :{info.port}</span>
        <span className={`ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${running ? "bg-amber-500/15 text-amber-600" : "bg-emerald-500/15 text-emerald-600"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${running ? "animate-pulse bg-amber-500" : "bg-emerald-500"}`} />
          {running ? "入库中" : "空闲"}
        </span>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* V405: 入库实时数据监控（入库中旁边可见数据增长） */}
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-foreground/80">
            📊 入库实时数据
            {running && <span className="flex items-center gap-1 text-[9px] text-sky-500"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" /> 每 10 秒刷新</span>}
          </div>
          <div className="text-2xl font-bold text-sky-600">{liveTotal !== null ? liveTotal.toLocaleString() : "…"} <span className="text-[10px] font-normal text-muted-foreground">节点</span></div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {liveLabels.slice(0, 6).map((l) => (
              <span key={l.label} className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[9px] text-sky-600">
                {l.label} <b>{l.count.toLocaleString()}</b>
              </span>
            ))}
          </div>
          {!running && liveTotal !== null && <div className="mt-1 text-[9px] text-muted-foreground">入库空闲 · 当前数据快照（入库时自动更新）</div>}
        </div>

        {/* 状态卡 */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border border-border bg-card p-3 text-center">
            <div className="text-lg font-bold text-violet-600">{running ? "进行中" : "待命"}</div>
            <div className="text-[10px] text-muted-foreground">状态</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3 text-center">
            <div className="text-lg font-bold" style={{ color: "var(--primary)" }}>{startedAt ? startedAt.slice(11, 19) : "—"}</div>
            <div className="text-[10px] text-muted-foreground">启动时间</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3 text-center">
            <div className="text-lg font-bold text-emerald-600">{health === null ? "未检" : health ? "正常" : "异常"}</div>
            <div className="text-[10px] text-muted-foreground">引擎健康</div>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-2 text-[11px] font-semibold text-foreground/80">入库操作</div>
          <p className="mb-3 text-[10px] text-muted-foreground">{info.desc}</p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void start()}
              disabled={running}
              className="flex items-center gap-1 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              {running ? "入库中…" : `启动 ${info.name} 入库`}
            </button>
            <button
              onClick={() => void checkHealth()}
              disabled={checking}
              className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
            >
              {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              引擎健康检查
            </button>
            <button
              onClick={runDemo}
              disabled={demoRunning || running}
              className="flex items-center gap-1 rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
              title="模拟入库流程（不真跑，演示阶段效果）"
            >
              {demoRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              🎬 Demo 演示
            </button>
          </div>
          {note && <div className="mt-2 rounded bg-muted/40 p-2 text-[10px] text-muted-foreground">{note}</div>}
          {/* V403/V405: Demo 流程进度（运行时点亮，完成后保留展示） */}
          {(demoRunning || demoDone) && (
            <div className="mt-2 space-y-1 rounded border border-violet-200 bg-violet-50/40 p-2">
              {demoStages.map((s, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[10px]">
                  <span className={`h-2 w-2 rounded-full ${i < demoStep ? (demoDone ? "bg-emerald-500" : "bg-violet-500") : "bg-muted"}`} />
                  <span className={i < demoStep ? "text-violet-800" : "text-muted-foreground"}>{s}</span>
                  {demoDone && i === demoStages.length - 1 && <span className="ml-auto text-emerald-600">✓</span>}
                  {demoRunning && i === demoStep - 1 && <Loader2 className="ml-auto h-2.5 w-2.5 animate-spin text-violet-500" />}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 引擎信息 */}
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-foreground/80">
            <CheckCircle2 className="h-3 w-3 text-emerald-500" /> 引擎说明
          </div>
          <div className="space-y-1 text-[10px] leading-4 text-muted-foreground">
            <div>• {info.name} 入库 = orchestrate_ingest.py --{engine}</div>
            <div>• 后台执行，触发后可离开页面，进度继续</div>
            <div>• 5 秒自动轮询状态</div>
            <div>• 完成校验：切到「库浏览」查看节点数变化</div>
          </div>
        </div>

        {/* V406: 入库监控 — 左侧文档队列 + 右侧 概览/切片/事件(超边或摘要)/实体/检索 */}
        <IngestMonitorPanel engine={engine} />
      </div>
      </>
      )}
    </div>
  );
};
