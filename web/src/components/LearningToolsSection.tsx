// LearningToolsSection.tsx — 评测学习引擎工具区块（2026-08-08 V290）
// 展示 P0-1~P0-5 五个学习工具的：① 真实结果（API 数据） ② demo 演示（learning-demo.ts 静态数据逐步动画）
// 挂在 EvalPanel 内（"学习引擎" tab），复用 EvalPanel 的 demo 播放机制（setTimeout 队列 + autoPlayedRef）
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { BarChart3, ChevronDown, ChevronRight, CircleCheck, CircleX, FileText, GraduationCap, Play, RefreshCw, Square } from "lucide-react";
import { cn } from "../lib/utils";
import { Card } from "./ui/card";
import { api } from "../lib/api";
import { MarkdownMessage } from "../lib/markdown";
import { LEARNING_TOOLS } from "../lib/learning-demo";

// 工具 → 报告文件映射（真实模式读这些文件）
const TOOL_REPORT: Record<string, string> = {
  significance: "significance_report.md",
  attribution: "failure_report.md",
  trajectory: "tp_report.md",
  calibration: "kappa_report.md",
};

const CATEGORY_COLORS: Record<string, string> = {
  retrieval: "bg-blue-500",
  context: "bg-violet-500",
  reasoning: "bg-amber-500",
  hallucination: "bg-red-500",
  tool: "bg-orange-500",
  timeout: "bg-slate-500",
  other: "bg-gray-400",
};

/** 归因类别条形图（真实数据） */
function CategoryBars({ counts }: { counts: Array<{ category: string; count: number }> }) {
  const max = Math.max(1, ...counts.map((c) => c.count));
  return (
    <div className="space-y-1.5">
      {counts.map((c) => (
        <div key={c.category} className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{c.category}</span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
            <div
              className={cn("h-full rounded", CATEGORY_COLORS[c.category] || "bg-gray-400")}
              style={{ width: `${(c.count / max) * 100}%` }}
            />
          </div>
          <span className="w-8 text-right text-[11px] tabular-nums text-foreground">{c.count}</span>
        </div>
      ))}
    </div>
  );
}

/** V298: 闭环流转视图 — 四闭环状态卡片（实时同步） */
interface LoopInfo {
  id: string; label: string; enabled: boolean; trigger: string;
  status: "ready" | "empty"; counts: Record<string, number>;
  lastRun: string | null; items: Array<{ id: string; source: string; status: string }>;
}
function LoopView({ loops }: { loops: Record<string, LoopInfo> | null }) {
  if (!loops) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        加载闭环状态…（或运行脚本后刷新）
      </div>
    );
  }
  const order = ["reflection", "trajectoryReflux", "minDiffPatch", "badCasePromote"];
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {order.map((key) => {
        const l = loops[key];
        if (!l) return null;
        const ready = l.status === "ready";
        return (
          <div key={key} className="rounded-md border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                {ready ? (
                  <CircleCheck className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <CircleX className="h-3.5 w-3.5 text-amber-500" />
                )}
                <span className="text-xs font-medium">{l.label}</span>
              </div>
              <span className={cn(
                "rounded px-1.5 py-0.5 text-[10px]",
                ready ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
              )}>
                {ready ? "有数据" : "待运行"}
              </span>
            </div>
            <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
              <div>触发：{l.trigger}</div>
              <div>
                产物：
                {Object.entries(l.counts).map(([k, v]) => (
                  <span key={k} className="mr-2">
                    {k} <b className="tabular-nums text-foreground">{v}</b>
                  </span>
                ))}
              </div>
              {l.lastRun && <div>最近：{l.lastRun.substring(0, 19).replace("T", " ")}</div>}
            </div>
            {l.items.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-border/50 pt-2">
                {l.items.map((it) => (
                  <div key={it.id} className="flex items-center justify-between text-[10px]">
                    <span className="text-foreground">{it.id}</span>
                    <span className="text-muted-foreground">← {it.source}</span>
                    <span className={cn(
                      "rounded px-1 py-0.5",
                      it.status === "confirmed" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
                    )}>
                      {it.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const LearningToolsSection: FC = () => {
  const [activeTool, setActiveTool] = useState<string>("attribution");
  const [demoPlaying, setDemoPlaying] = useState(false);
  const [demoStep, setDemoStep] = useState(0);
  const [demoRow, setDemoRow] = useState(0);
  const demoTimersRef = useRef<number[]>([]);
  const autoPlayedRef = useRef(false);
  const [toolLabel, setToolLabel] = useState("");

  // 真实数据（按工具懒加载）
  const [realData, setRealData] = useState<Record<string, any>>({});
  const [dataLoading, setDataLoading] = useState<Record<string, boolean>>({});
  // V293: 真实同步 — 轮询计数（每次 +1 触发重新拉取）+ 评测完成联动
  const [refreshTick, setRefreshTick] = useState(0);
  const [lastSync, setLastSync] = useState<string>("");

  /** 强制刷新当前工具的真实数据（手动/评测完成联动共用） */
  const forceRefresh = () => setRefreshTick((t) => t + 1);

  // V293: 真实同步 — 轮询：面板可见期间每 10s 自动刷新一次
  useEffect(() => {
    const timer = window.setInterval(() => {
      // 只在有真实数据或无数据但非演示播放时刷新（避免打断演示动画）
      setRefreshTick((t) => t + 1);
    }, 10000);
    return () => window.clearInterval(timer);
  }, []);

  // V293: 评测完成联动 — 监听 EvalPanel 评测结束事件（window 级 CustomEvent）
  useEffect(() => {
    const onEvalDone = () => { setRefreshTick((t) => t + 1); };
    window.addEventListener("eval-run-done", onEvalDone);
    return () => window.removeEventListener("eval-run-done", onEvalDone);
  }, []);

  const clearDemoTimers = () => {
    demoTimersRef.current.forEach((t) => window.clearTimeout(t));
    demoTimersRef.current = [];
  };

  // 首次进入自动播一次 demo
  useEffect(() => {
    if (!autoPlayedRef.current) {
      autoPlayedRef.current = true;
      playDemo(LEARNING_TOOLS[0]);
    }
    return () => clearDemoTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切工具：清定时器 + 重置动画状态
  const switchTool = (tool: string) => {
    clearDemoTimers();
    setDemoPlaying(false);
    setDemoStep(0);
    setDemoRow(0);
    setActiveTool(tool);
  };

  const playDemo = (tool: ToolDemoLike) => {
    clearDemoTimers();
    setDemoPlaying(true);
    setDemoStep(0);
    setDemoRow(0);
    setToolLabel(tool.label);
    const total = tool.steps.length + tool.rows.length;
    for (let i = 0; i <= total; i++) {
      demoTimersRef.current.push(window.setTimeout(() => {
        if (i < tool.steps.length) setDemoStep(i + 1);
        else setDemoRow(i - tool.steps.length + 1);
      }, 260 * i));
    }
  };

  const exitDemo = () => {
    clearDemoTimers();
    setDemoPlaying(false);
    setDemoStep(0);
    setDemoRow(0);
  };

  // V298: loop tab 无 LEARNING_TOOLS 条目，用描述对象替代
  const tool = activeTool === "loop"
    ? { label: "闭环流转", desc: "评测学习引擎四个闭环的实时状态：失败→归因→回归题/补丁/新评测题", steps: [] as string[], rows: [] as Array<{ cells: string[]; score?: number; bad?: boolean }>, stats: undefined }
    : (LEARNING_TOOLS.find((t) => t.id === activeTool) || LEARNING_TOOLS[0]);

  // 拉取当前工具真实数据（activeTool 或 refreshTick 变化时触发；V293 轮询+联动共用）
  useEffect(() => {
    let cancelled = false;
    const key = activeTool;
    if (dataLoading[key]) return;
    setDataLoading((p) => ({ ...p, [key]: true }));

    if (key === "attribution") {
      api.getEvalFailures().then((d) => {
        if (!cancelled) { setRealData((p) => ({ ...p, [key]: d })); setLastSync(new Date().toLocaleTimeString()); }
      }).catch(() => {}).finally(() => {
        if (!cancelled) setDataLoading((p) => ({ ...p, [key]: false }));
      });
    } else if (key === "loop") {
      // V298: 闭环流转聚合数据（轮询/联动自动刷新）
      api.getEvalLoop().then((d) => {
        if (!cancelled) { setRealData((p) => ({ ...p, [key]: d })); setLastSync(new Date().toLocaleTimeString()); }
      }).catch(() => {}).finally(() => {
        if (!cancelled) setDataLoading((p) => ({ ...p, [key]: false }));
      });
    } else {
      const report = TOOL_REPORT[key];
      if (report) {
        api.getEvalReport(report).then((d) => {
          if (!cancelled) { setRealData((p) => ({ ...p, [key]: d })); setLastSync(new Date().toLocaleTimeString()); }
        }).catch(() => {}).finally(() => {
          if (!cancelled) setDataLoading((p) => ({ ...p, [key]: false }));
        });
      }
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, refreshTick]);

  // 真实数据是否存在（归因: total>0; 报告: exists; loop: 总有数据）
  const hasReal = useMemo(() => {
    const d = realData[activeTool];
    if (!d) return false;
    if (activeTool === "attribution") return d.total > 0;
    if (activeTool === "loop") return true;  // 闭环流转总是有数据（空态也展示）
    return d.exists === true;
  }, [realData, activeTool]);

  // demo 播放中的当前行/步骤
  const showSteps = demoPlaying ? tool.steps.slice(0, demoStep) : [];
  const showRows = demoPlaying ? tool.rows.slice(0, demoRow) : [];

  // ── 真实归因渲染 ──
  const renderAttribution = () => {
    const d = realData.attribution as
      | { categoryCounts: Array<{ category: string; count: number }>; layerCounts?: Array<{ layer: string; count: number }>; items: Array<any>; total: number; runId: string | null }
      | undefined;
    if (!d || d.total === 0) return null;
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CircleCheck className="h-3.5 w-3.5 text-green-500" />
          归因轮次: {d.runId ?? "-"} · 共 {d.total} 题
        </div>
        <CategoryBars counts={d.categoryCounts} />
        {/* V329(P1-6): 三层验证 layer 分布（结果/过程/质量） */}
        {d.layerCounts && d.layerCounts.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-muted-foreground">三层验证:</span>
            {d.layerCounts.map((l) => (
              <span key={l.layer} className={cn(
                "rounded px-1.5 py-0.5",
                l.layer === "result" ? "bg-blue-50 text-blue-700" :
                l.layer === "process" ? "bg-violet-50 text-violet-700" :
                "bg-green-50 text-green-700"
              )}>
                {l.layer} {l.count}
              </span>
            ))}
          </div>
        )}
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                <th className="px-2 py-1.5">题号</th>
                <th className="px-2 py-1.5">类别</th>
                <th className="px-2 py-1.5">首个错误步骤</th>
                <th className="px-2 py-1.5">层</th>
                <th className="px-2 py-1.5">置信度</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((it: any) => (
                <tr key={it.question_id} className="border-b border-border/50 last:border-0">
                  <td className="px-2 py-1 font-medium">{it.question_id}</td>
                  <td className="px-2 py-1">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{it.failure_category}</span>
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">{it.first_error_step || "-"}</td>
                  <td className="px-2 py-1">
                    {it.layer && (
                      <span className={cn(
                        "rounded px-1 py-0.5 text-[10px]",
                        it.layer === "result" ? "bg-blue-50 text-blue-700" :
                        it.layer === "process" ? "bg-violet-50 text-violet-700" :
                        "bg-green-50 text-green-700"
                      )}>{it.layer}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  // ── 真实报告渲染（markdown） ──
  const renderReport = () => {
    const d = realData[activeTool] as { exists?: boolean; content?: string } | undefined;
    if (!d || d.exists !== true || !d.content) return null;
    return (
      <div className="rounded-md border border-border bg-background p-3">
        <MarkdownMessage content={d.content} />
      </div>
    );
  };

  // ── demo 渲染（逐步动画） ──
  const renderDemo = () => {
    if (!demoPlaying) return null;
    return (
      <div className="space-y-3">
        <div className="space-y-1.5">
          {showSteps.map((s, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
              <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
              <span>{s}</span>
            </div>
          ))}
        </div>
        {showRows.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-[11px]">
              <tbody>
                {showRows.map((r, i) => (
                  <tr
                    key={i}
                    className={cn(
                      "border-b border-border/50 last:border-0",
                      i === showRows.length - 1 && "bg-primary/5"
                    )}
                  >
                    {r.cells.map((c, j) => (
                      <td
                        key={j}
                        className={cn(
                          "px-2 py-1",
                          j === 0 && "font-medium",
                          r.bad && "text-red-600",
                          r.score === 1 && j === r.cells.length - 1 && "text-green-600"
                        )}
                      >
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {demoStep >= tool.steps.length && showRows.length >= tool.rows.length && tool.stats && (
          <div className="grid grid-cols-3 gap-2">
            {tool.stats.map((s, i) => (
              <div key={i} className="rounded-md border border-border bg-muted/30 p-2 text-center">
                <div className="text-[10px] text-muted-foreground">{s.label}</div>
                <div className={cn("text-lg font-bold tabular-nums", s.good ? "text-green-600" : "text-foreground")}>
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── 空态（无真实数据且未播 demo） ──
  const renderEmpty = () => {
    if (hasReal || demoPlaying) return null;
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <GraduationCap className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-xs text-muted-foreground">
          {activeTool === "attribution"
            ? "暂无归因数据 — 运行 scripts/failure-attribution.ts 后刷新"
            : `报告未生成 — 运行对应脚本后刷新`}
        </p>
        <button
          type="button"
          onClick={() => playDemo(tool)}
          className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          <Play className="h-3.5 w-3.5" /> 播放演示
        </button>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {/* 工具切换按钮组（V298: 加"闭环流转"第6个tab） */}
      <div className="flex flex-wrap gap-1.5">
        {LEARNING_TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => switchTool(t.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[11px] transition-colors",
              activeTool === t.id
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
            )}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => switchTool("loop")}
          className={cn(
            "rounded-md px-2.5 py-1 text-[11px] transition-colors",
            activeTool === "loop"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/70"
          )}
        >
          <RefreshCw className="mr-1 inline h-3 w-3" />闭环流转
        </button>
      </div>

      {/* 当前工具描述 + 操作行 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {hasReal ? (
            <span className="flex items-center gap-1 rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-700">
              <CircleCheck className="h-3 w-3" /> 真实数据
            </span>
          ) : (
            !demoPlaying && (
              <span className="flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                <FileText className="h-3 w-3" /> 暂无真实数据
              </span>
            )
          )}
          {demoPlaying && (
            <span className="flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
              <Play className="h-3 w-3" /> 演示数据（{toolLabel}）
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">{tool.desc}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {!demoPlaying ? (
            <button
              type="button"
              onClick={() => playDemo(tool)}
              className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90"
            >
              <Play className="h-3 w-3" /> 播放演示
            </button>
          ) : (
            <button
              type="button"
              onClick={exitDemo}
              className="flex items-center gap-1 rounded-md bg-muted px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted/70"
            >
              <Square className="h-3 w-3" /> 退出演示
            </button>
          )}
          <button
            type="button"
            onClick={forceRefresh}
            className="flex items-center gap-1 rounded-md bg-muted px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted/70"
          >
            <RefreshCw className="h-3 w-3" /> 刷新
          </button>
        </div>
      </div>

      {/* V293: 真实同步状态条（轮询 10s + 评测完成联动） */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
        <span className="flex items-center gap-1">
          <RefreshCw className="h-2.5 w-2.5" /> 每 10 秒自动同步
        </span>
        {lastSync && (
          <span>· 最后同步 {lastSync} · 评测完成自动刷新</span>
        )}
      </div>

      {/* 内容区 */}
      <div className="min-h-24">
        {hasReal ? (
          activeTool === "attribution" ? renderAttribution() : renderReport()
        ) : (
          <>
            {renderDemo()}
            {renderEmpty()}
          </>
        )}
      </div>

      {/* V298: 闭环流转视图（loop tab）— 四闭环状态实时同步 */}
      {activeTool === "loop" && (
        <LoopView loops={(realData.loop as { loops: Record<string, LoopInfo> | null } | undefined)?.loops ?? null} />
      )}
    </div>
  );
};

// 演示工具类型（避免循环依赖 learning-demo.ts）
type ToolDemoLike = {
  label: string;
  steps: string[];
  rows: Array<{ cells: string[]; score?: number; bad?: boolean }>;
  stats?: Array<{ label: string; value: string; good?: boolean }>;
};
