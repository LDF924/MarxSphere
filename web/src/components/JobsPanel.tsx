// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// JobsPanel.tsx — Jobs 任务队列（GBrain Jobs 适配）
// 顶部：统计胶囊 + 入队 + 任务流水（单列表）
// 下方（GBrain 三区域）：三栏队列卡片 / Deterministic Task 对照演示 / Dream Cycle 9-phase 卡
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2, Clock, CheckCircle2, XCircle, Activity, ChevronDown, Play, FlaskConical, Moon, Layers } from "lucide-react";
import { api, type MinionJob } from "../lib/api";
import { cn } from "../lib/utils";
import { Card } from "./ui/card";
import { Button } from "./ui/button";

const JOB_TYPES: Array<{ key: string; cn: string; en: string }> = [
  { key: "lint", cn: "数据体检", en: "lint" },
  { key: "backlinks", cn: "反向链接", en: "backlinks" },
  { key: "sync", cn: "数据同步", en: "sync" },
  { key: "synthesize", cn: "结论整合", en: "synthesize" },
  { key: "embed", cn: "向量化", en: "embed" },
  { key: "orphans", cn: "孤儿清理", en: "orphans" },
  { key: "purge", cn: "彻底删除", en: "purge" },
  { key: "dream_cycle", cn: "自整理", en: "dream_cycle" },
  { key: "extract", cn: "关系抽取", en: "extract" },
  { key: "patterns", cn: "主题发现", en: "patterns" },
  { key: "recompute_emotional_weight", cn: "权重重算", en: "emotional_weight" },
  { key: "batch_ingest", cn: "批量入库", en: "batch_ingest" },
  { key: "hyperedge", cn: "超边抽取", en: "hyperedge" },
  { key: "clean", cn: "清洗去重", en: "clean" },
  { key: "classify", cn: "语言分类", en: "classify" },
  { key: "disambiguate", cn: "实体消歧", en: "disambiguate" },
  { key: "index_refresh", cn: "索引刷新", en: "index_refresh" }
];

const STATUS_STYLE: Record<string, string> = {
  waiting: "bg-muted text-muted-foreground",
  active: "bg-blue-500/15 text-blue-600",
  completed: "bg-green-500/15 text-green-600",
  failed: "bg-red-500/15 text-red-600",
  cancelled: "bg-gray-500/15 text-gray-500",
  delayed: "bg-amber-500/15 text-amber-600",
  dead: "bg-red-500/20 text-red-600",
  "waiting-children": "bg-purple-500/15 text-purple-600",
  paused: "bg-gray-500/15 text-gray-500"
};

/** 三栏中文标签 */
const STATUS_LABELS: Record<string, string> = {
  waiting: "待处理",
  active: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  delayed: "延迟",
  dead: "死信",
  "waiting-children": "等子任务",
  paused: "暂停"
};

/** Trace Waterfall：任务执行瀑布（span 视图 — GBrain Trace Waterfall 适配） */
function WaterfallBar({ job }: { job: MinionJob }) {
  const duration = job.completedAt && job.startedAt
    ? (new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()) / 1000
    : null;
  const hasTokens = job.tokensInput + job.tokensOutput + job.tokensCacheRead > 0;
  return (
    <div className="mt-1.5 flex items-center gap-2 border-t border-border/40 pt-1.5 text-[10px] text-muted-foreground">
      <span className="w-14 shrink-0 font-mono">执行</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
        <div
          className={cn("h-full rounded", job.status === "completed" ? "bg-green-400" : job.status === "failed" || job.status === "dead" ? "bg-red-400" : job.status === "active" ? "bg-blue-400" : "bg-muted-foreground/40")}
          style={{ width: duration != null ? `${Math.min(100, Math.max(10, duration * 2))}%` : "10%" }}
        />
      </div>
      {duration != null && <span className="w-14 shrink-0 text-right font-mono">{duration.toFixed(1)}s</span>}
      {hasTokens && (
        <span className="shrink-0 font-mono">tokens {job.tokensInput + job.tokensOutput}/{job.tokensCacheRead}</span>
      )}
      <span className="shrink-0">重试 {job.attempts}/{job.maxAttempts}</span>
      {job.delayUntil && <span className="shrink-0">⏳ {new Date(job.delayUntil).toLocaleTimeString("zh-CN")}</span>}
    </div>
  );
}

/** 单任务卡片（三栏队列共用） */
function JobCard({ job, onExpand, expanded, onDelete }: {
  job: MinionJob;
  onExpand: (id: string) => void;
  expanded: boolean;
  onDelete: (id: string) => void;
}) {
  const duration = job.completedAt && job.startedAt
    ? ((new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()) / 1000).toFixed(1)
    : null;
  return (
    <div className="rounded-lg border border-border/60 bg-background p-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">{job.jobType}</span>
        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px]", STATUS_STYLE[job.status] ?? "bg-muted")}>
          {STATUS_LABELS[job.status] ?? job.status}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <Clock className="h-3 w-3" />
        {new Date(job.createdAt).toLocaleTimeString("zh-CN")}
        {job.parentJobId && <span className="rounded bg-purple-50 px-1 py-0.5 text-purple-700">子任务 #{job.parentJobId.slice(0, 6)}</span>}
        {job.error && <span className="rounded bg-red-500/15 px-1 py-0.5 text-red-400">失败</span>}
      </div>
      {job.status === "completed" && job.result !== undefined && (
        <div className="mt-1 line-clamp-2 rounded bg-green-500/15 px-1.5 py-1 font-mono text-[9px] text-green-400">
          {JSON.stringify(job.result).slice(0, 120)}
        </div>
      )}
      {job.status === "active" && (
        <div className="mt-1 flex items-center gap-1.5 text-[9px] text-blue-600">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
          正在执行 {duration ? `${duration}s` : "…"}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1">
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" onClick={() => onExpand(job.id)}>
          <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} /> {expanded ? "收起" : "详情"}
        </Button>
        {job.status !== "active" && (
          <Button size="sm" variant="ghost" className="ml-auto h-6 w-6 cursor-pointer p-0 text-muted-foreground/50 hover:bg-red-500/15 hover:text-red-400" onClick={() => onDelete(job.id)} title="删除任务">
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
      {expanded && (
        <div className="mt-1.5 space-y-1 border-t border-border/50 pt-1.5 text-[10px]">
          <div className="text-muted-foreground">参数: <code className="font-mono">{JSON.stringify(job.payload)}</code></div>
          {job.result !== undefined && <div className="text-green-700">结果: <code className="font-mono">{JSON.stringify(job.result).slice(0, 300)}</code></div>}
          {job.error && <div className="text-red-600">错误: {job.error.slice(0, 300)}</div>}
          {job.completedAt && <div className="text-muted-foreground">完成: {new Date(job.completedAt).toLocaleString("zh-CN")}</div>}
          {job.delayUntil && <div className="text-amber-600">延迟至: {new Date(job.delayUntil).toLocaleString("zh-CN")}</div>}
          <WaterfallBar job={job} />
        </div>
      )}
    </div>
  );
}

/** 三栏队列（GBrain 顶部三栏：待处理/运行中/已完成） */
function QueueColumns({ jobs, onExpand, expandedId, onDelete }: {
  jobs: MinionJob[];
  onExpand: (id: string) => void;
  expandedId: string | null;
  onDelete: (id: string) => void;
}) {
  const groups: Array<{ status: string; label: string; list: MinionJob[]; emptyText: string }> = [
    { status: "waiting", label: "待处理", list: jobs.filter((j) => j.status === "waiting" || j.status === "delayed" || j.status === "waiting-children" || j.status === "paused"), emptyText: "没有排队中的任务" },
    { status: "active", label: "运行中", list: jobs.filter((j) => j.status === "active"), emptyText: "没有正在运行的任务" },
    { status: "completed", label: "已完成", list: jobs.filter((j) => j.status === "completed"), emptyText: "今天还没有完成的任务" }
  ];
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {groups.map((group) => (
        <div key={group.status} className="rounded-lg border border-border bg-accent/20 p-2">
          <div className="mb-2 flex items-center gap-2 px-1">
            <span className="text-sm font-medium">{group.label}</span>
            <span className={cn("rounded px-1.5 py-0.5 text-[10px]", STATUS_STYLE[group.status])}>{group.list.length}</span>
          </div>
          {group.list.length === 0 ? (
            <div className="px-1 py-6 text-center text-[11px] text-muted-foreground">{group.emptyText}</div>
          ) : (
            <div className="space-y-2">
              {group.list.slice(0, 12).map((job) => (
                <JobCard key={job.id} job={job} expanded={expandedId === job.id} onExpand={onExpand} onDelete={onDelete} />
              ))}
              {group.list.length > 12 && <div className="px-1 text-center text-[10px] text-muted-foreground">…还有 {group.list.length - 12} 条</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Deterministic Task 对照演示卡（GBrain：naive LLM 生成 vs Minions cached 确定性代码） */
function DeterministicCard({ onRun }: { onRun: (kind: "naive" | "cached") => void }) {
  const [running, setRunning] = useState<"naive" | "cached" | null>(null);
  const [naiveMs, setNaiveMs] = useState<number | null>(null);
  const [cachedMs, setCachedMs] = useState<number | null>(null);
  const [note, setNote] = useState("");

  const run = async (kind: "naive" | "cached") => {
    setRunning(kind);
    setNote("");
    const t0 = Date.now();
    try {
      await onRun(kind);
      const ms = Date.now() - t0;
      if (kind === "naive") { setNaiveMs(ms); setNote("常规路径：把任务喂给 LLM 让它生成代码再执行（慢、烧 token、易超时）"); }
      else { setCachedMs(ms); setNote("队列路径：确定性代码直接跑（快、省 token、结果可缓存）"); }
    } catch {
      setNote("执行失败");
    } finally {
      setRunning(null);
    }
  };

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <FlaskConical className="h-4 w-4 text-primary" /> 确定性任务对照演示
        <span className="text-[10px] font-normal text-muted-foreground">确定性任务走确定性代码 + 队列，不走 LLM 生成</span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border/60 p-3">
          <div className="text-xs font-medium">naive 对照（LLM 生成）</div>
          <div className="mt-1 text-[10px] text-muted-foreground">把任务作为 prompt 喂给 LLM 让它生成代码再执行</div>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={running !== null} onClick={() => void run("naive")}>
              {running === "naive" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
              触发
            </Button>
            {naiveMs != null && <span className="font-mono text-xs text-red-600">{naiveMs}ms</span>}
          </div>
        </div>
        <div className="rounded-lg border border-green-400/30 bg-green-500/10 p-3">
          <div className="text-xs font-medium">minions cached（确定性代码）</div>
          <div className="mt-1 text-[10px] text-muted-foreground">enqueue 一个 lint 任务，worker 直接跑预编译逻辑</div>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={running !== null} onClick={() => void run("cached")}>
              {running === "cached" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
              触发
            </Button>
            {cachedMs != null && <span className="font-mono text-xs text-green-700">{cachedMs}ms</span>}
          </div>
        </div>
      </div>
      {note && <div className="mt-2 text-[10px] text-muted-foreground">{note}</div>}
      {naiveMs != null && cachedMs != null && cachedMs > 0 && (
        <div className="mt-2 rounded bg-accent/40 px-3 py-2 text-xs">
          对比：常规 {naiveMs}ms vs 队列 {cachedMs}ms —— <span className={cn("font-semibold", naiveMs > cachedMs ? "text-green-700" : "text-amber-700")}>
          {naiveMs > cachedMs ? `cached 快 ${(naiveMs / Math.max(cachedMs, 1)).toFixed(1)} 倍` : "差距不明显（数据量小）"}</span>
        </div>
      )}
    </Card>
  );
}

/** Dream Cycle 13-phase 卡（最近一次自整理结果 — 对齐 GBrain 三阶段） */
function DreamCycleCard({ recentDreamCycle }: { recentDreamCycle: MinionJob | null }) {
  const PHASES = [
    // 阶段1 入库准备（蓝）
    { key: "clean", cn: "清洗去重", phase: 1 },
    { key: "classify", cn: "语言分类", phase: 1 },
    // 阶段2 知识建联（橙）
    { key: "lint", cn: "数据体检", phase: 2 },
    { key: "backlinks", cn: "反向链接", phase: 2 },
    { key: "sync", cn: "数据同步", phase: 2 },
    { key: "synthesize", cn: "结论整合", phase: 2 },
    { key: "extract", cn: "关系抽取", phase: 2 },
    { key: "disambiguate", cn: "实体消歧", phase: 2 },
    { key: "patterns", cn: "主题发现", phase: 2 },
    { key: "recompute_emotional_weight", cn: "权重重算", phase: 2 },
    // 阶段3 索引刷新（绿）
    { key: "embed", cn: "向量化", phase: 3 },
    { key: "orphans", cn: "孤儿清理", phase: 3 },
    { key: "index_refresh", cn: "索引刷新", phase: 3 }
  ];

  const result = recentDreamCycle?.result as { phases?: Record<string, unknown> } | undefined;
  const duration = recentDreamCycle?.completedAt && recentDreamCycle.startedAt
    ? ((new Date(recentDreamCycle.completedAt).getTime() - new Date(recentDreamCycle.startedAt).getTime()) / 1000).toFixed(0)
    : null;

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Moon className="h-4 w-4 text-indigo-500" /> Dream Cycle 自整理
        <span className="text-[10px] font-normal text-muted-foreground">13-phase 夜间自我维护 · 点上方"自整理"按钮触发</span>
        {recentDreamCycle && (
          <span className="ml-auto text-[10px] font-normal text-muted-foreground">
            最近: {new Date(recentDreamCycle.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
            {duration ? ` · ${duration}s` : ""} · {recentDreamCycle.status === "completed" ? "完成" : recentDreamCycle.status}
          </span>
        )}
      </div>
      {!recentDreamCycle ? (
        <div className="py-6 text-center text-xs text-muted-foreground">还没有跑过 Dream Cycle。点上方"自整理"按钮触发一次，这里会展示 13 个 phase 各自的执行结果。</div>
      ) : (
        <div className="space-y-3">
          {[1, 2, 3].map((stage) => {
            const stageName = stage === 1 ? "入库准备" : stage === 2 ? "知识建联" : "索引刷新";
            const stageColor = stage === 1 ? "text-blue-500" : stage === 2 ? "text-orange-500" : "text-green-500";
            const stagePhases = PHASES.filter((p) => p.phase === stage);
            return (
              <div key={stage}>
                <div className={cn("mb-1.5 text-[11px] font-medium", stageColor)}>阶段 {stage}：{stageName}</div>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
                  {stagePhases.map((phase) => {
                    const phaseResult = result?.phases?.[phase.key];
                    const hasResult = phaseResult !== undefined && phaseResult !== "skipped (no handler)";
                    const resultText = typeof phaseResult === "string" ? phaseResult : phaseResult ? JSON.stringify(phaseResult).slice(0, 60) : null;
                    return (
                      <div key={phase.key} className={cn("rounded-md border p-2", hasResult ? "border-green-200 bg-green-50/40" : "border-border/60 bg-muted/30")}>
                        <div className="flex items-center gap-1.5">
                          <span className={cn("inline-block h-1.5 w-1.5 rounded-full", hasResult ? "bg-green-500" : "bg-muted-foreground/40")} />
                          <span className="text-[11px] font-medium">{phase.cn}</span>
                          <span className="ml-auto font-mono text-[9px] text-muted-foreground">{phase.key}</span>
                        </div>
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          {hasResult ? (
                            resultText ? <span className="font-mono text-green-800">{resultText}</span> : <span className="text-green-700">✓ 完成</span>
                          ) : (
                            "未执行"
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function JobsPanel() {
  const [jobs, setJobs] = useState<MinionJob[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [recentDreamCycle, setRecentDreamCycle] = useState<MinionJob | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const data = await api.listJobs({ limit: 100 });
      setJobs(data.jobs);
      setStats(data.stats);
      // 最近一次 dream_cycle（completed 优先，否则任意状态）
      const dreams = data.jobs.filter((j: MinionJob) => j.jobType === "dream_cycle");
      const latest = dreams.sort((a: MinionJob, b: MinionJob) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;
      setRecentDreamCycle(latest);
    } catch {
      // 队列表未建时静默
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
    const timer = setInterval(() => void loadJobs(), 5000);
    return () => clearInterval(timer);
  }, [loadJobs]);

  const enqueue = async (jobType: string) => {
    await api.enqueueJob(jobType);
    void loadJobs();
  };

  const removeJob = async (jobId: string) => {
    await api.deleteJob(jobId);
    void loadJobs();
  };

  /** Deterministic 演示：cached = enqueue lint（确定性代码），naive = enqueue synthesize（LLM 路径） */
  const runDeterministic = async (kind: "naive" | "cached") => {
    await enqueue(kind === "naive" ? "synthesize" : "lint");
  };

  const expand = (id: string) => setExpandedId((prev) => prev === id ? null : id);

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto w-full max-w-[1400px] space-y-4">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Jobs 任务队列</h2>
          <span className="text-xs text-muted-foreground">后台任务队列 · Trace Waterfall</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void loadJobs()}><RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新</Button>
          </div>
        </div>

        {/* 统计 */}
        <div className="flex flex-wrap gap-2 text-xs">
          {(Object.keys(stats).length > 0 ? Object.entries(stats) : [["waiting", 0], ["active", 0], ["completed", 0], ["failed", 0]]).map(([status, count]) => (
            <span key={status} className={cn("rounded px-2 py-1", STATUS_STYLE[status] ?? "bg-muted")}>
              {STATUS_LABELS[status] ?? status} ×{count}
            </span>
          ))}
        </div>

        {/* 入队工具栏 */}
        <Card className="p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Layers className="h-4 w-4 text-primary" /> 入队任务
          </div>
          <div className="flex flex-wrap gap-1.5">
            {JOB_TYPES.map((type) => (
              <Button key={type.key} size="sm" variant="outline" onClick={() => void enqueue(type.key)} className="flex h-auto cursor-pointer flex-col gap-0.5 px-3 py-1.5">
                <span className="text-[11px] font-medium leading-tight">{type.cn}</span>
                <span className="text-[9px] font-normal leading-tight text-muted-foreground">{type.en}</span>
              </Button>
            ))}
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground">
            dream_cycle = 夜间自整理（lint → backlinks → sync → synthesize → extract → patterns → emotional → embed → orphans）
          </div>
        </Card>

        {/* ─── Dream Cycle 一键触发（醒目）─── */}
        <Card className="border-indigo-200/60 bg-gradient-to-r from-indigo-50/60 via-background to-background p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-indigo-100">
              <Moon className="h-4.5 w-4.5 text-indigo-600" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">Dream Cycle 自整理</div>
              <div className="text-[11px] text-muted-foreground">一键跑 13 个 phase（清洗去重 → 语言分类 → 数据体检 → 反向链接 → 数据同步 → 结论整合 → 关系抽取 → 实体消歧 → 主题发现 → 权重重算 → 向量化 → 孤儿清理 → 索引刷新），约 1 分钟，结果自动存库并展示在下方卡片</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => void enqueue("dream_cycle")} className="cursor-pointer border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100">
              <Moon className="mr-1 h-3.5 w-3.5" /> 触发自整理
            </Button>
          </div>
        </Card>

        {/* ─── GBrain 三区域 ─── */}

        {/* 三栏队列卡片（待处理/运行中/已完成） */}
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Activity className="h-4 w-4 text-primary" /> 队列状态分布
          </div>
          <QueueColumns jobs={jobs} expandedId={expandedId} onExpand={expand} onDelete={(id) => void removeJob(id)} />
        </div>

        {/* Deterministic Task 对照演示卡 */}
        <DeterministicCard onRun={(kind) => void runDeterministic(kind)} />

        {/* Dream Cycle 13-phase 卡 */}
        <DreamCycleCard recentDreamCycle={recentDreamCycle} />

        {/* 任务流水（Trace Waterfall） */}
        <Card className="p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            任务流水
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          {jobs.length === 0 ? (
            <div className="text-xs text-muted-foreground">暂无任务。点上方按钮入队一个任务。</div>
          ) : (
            <div className="space-y-1.5">
              {jobs.map((job) => (
                <div key={job.id} className="rounded border border-border/60">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expandedId === job.id ? null : job.id)}
                    className="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-xs"
                  >
                    <span className={cn("w-16 shrink-0 rounded px-1.5 py-0.5 text-center", STATUS_STYLE[job.status] ?? "bg-muted")}>
                      {STATUS_LABELS[job.status] ?? job.status}
                    </span>
                    <span className="font-mono font-medium">{job.jobType}</span>
                    <span className="text-muted-foreground">#{job.attempts}/{job.maxAttempts}</span>
                    <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {new Date(job.createdAt).toLocaleTimeString("zh-CN")}
                    </span>
                    {job.status !== "active" && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void removeJob(job.id); }}
                        className="rounded p-0.5 text-muted-foreground/40 hover:bg-red-500/15 hover:text-red-400"
                        title="删除任务"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                    <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform", expandedId === job.id && "rotate-180")} />
                  </button>
                  {expandedId === job.id && (
                    <div className="border-t border-border/50 px-2 py-2 text-[10px]">
                      <div className="text-muted-foreground">参数: <code className="font-mono">{JSON.stringify(job.payload)}</code></div>
                      {job.parentJobId && <div className="mt-1 text-muted-foreground">父任务: {job.parentJobId.slice(0, 8)}</div>}
                      {job.result !== undefined && <div className="mt-1 text-green-700">结果: <code className="font-mono">{JSON.stringify(job.result).slice(0, 300)}</code></div>}
                      {job.error && <div className="mt-1 text-red-600">错误: {job.error.slice(0, 300)}</div>}
                      {job.completedAt && <div className="mt-1 text-muted-foreground">完成: {new Date(job.completedAt).toLocaleString("zh-CN")}</div>}
                      <WaterfallBar job={job} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </section>
  );
}
