// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// AlertsPanel.tsx — 告警中心（任务巡检/降级/熔断/失败事件）
// 级别徽章 / 时间线列表 / 未读标记 / 全部已读 / 清空已读 / 轮询新告警
import { useState, useEffect, useCallback } from "react";
import { Bell, CheckCheck, Trash2, AlertTriangle, AlertOctagon, Info, Loader2, RefreshCw, Play, BarChart3, Activity, Target, Cpu } from "lucide-react";
import { cn } from "../lib/utils";

interface AlertItem {
  id: string;
  level: "info" | "warning" | "error" | "critical";
  category: string;
  message: string;
  task_type: string | null;
  detail: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
}

const LEVEL_STYLES: Record<AlertItem["level"], { badge: string; icon: React.ReactNode; label: string }> = {
  info: { badge: "bg-blue-500/15 text-blue-600", icon: <Info className="h-3 w-3" />, label: "信息" },
  warning: { badge: "bg-amber-500/15 text-amber-600", icon: <AlertTriangle className="h-3 w-3" />, label: "警告" },
  error: { badge: "bg-red-500/15 text-red-600", icon: <AlertOctagon className="h-3 w-3" />, label: "错误" },
  critical: { badge: "bg-red-600 text-white", icon: <AlertOctagon className="h-3 w-3" />, label: "严重" },
};

const CATEGORY_LABELS: Record<string, string> = {
  degradation: "降级", timeout: "超时", circuit_breaker: "熔断", failure: "失败",
  reflection: "反思", retry: "重试", success: "完成", ingestion: "入库", eval: "评测",
};

export function AlertsPanel() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  // V381: 系统健康状态（事件中心 + 记忆召回 + KV 缓存）
  const [eventPending, setEventPending] = useState(0);
  const [eventHandlerActive, setEventHandlerActive] = useState(false);
  const [recallReport, setRecallReport] = useState<{ recallAt5?: number; hits?: number; total?: number } | null>(null);
  const [cacheRate, setCacheRate] = useState<number | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      const [ev, mem] = await Promise.all([
        fetch("/api/events/status").then((r) => r.json()).catch(() => null),
        fetch("/api/memory/recall-report").then((r) => r.json()).catch(() => null),
      ]);
      if (ev?.ok) {
        setEventPending(ev.pending ?? 0);
        setEventHandlerActive(ev.handlers?.some((h: { active: boolean }) => h.active) ?? false);
        if (typeof ev.cacheRate === "number") setCacheRate(ev.cacheRate);
      }
      if (mem?.ok && mem.report) setRecallReport(mem.report);
    } catch { /* 健康状态失败不阻塞 */ }
  }, []);

  // KV 缓存命中率：从评测报告 / 最近推理 trace 聚合（简化：recall 报告无则略）
  useEffect(() => {
    void loadHealth();
    const timer = window.setInterval(() => void loadHealth(), 15000);
    return () => window.clearInterval(timer);
  }, [loadHealth]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/alerts?limit=100");
      const j = await r.json();
      setAlerts(j.alerts ?? []);
      setUnread(j.unread ?? 0);
    } catch { /* 忽略 */ }
    setLoading(false);
  }, []);

  // 轮询新告警（5 秒，可关）
  useEffect(() => {
    void load();
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load, autoRefresh]);

  const markRead = async (id?: string) => {
    await fetch("/api/alerts/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(id ? { id } : {}) });
    void load();
  };

  const clear = async () => {
    await fetch("/api/alerts/clear", { method: "POST" });
    void load();
  };

  /** 触发一次告警 demo（各类型一条，模拟真实事件） */
  const runDemo = async () => {
    const demos = [
      { level: "warning", category: "degradation", message: "[demo] 检索降级：Cognee 粗检超时，降级到 PG 全文检索（stage2 3/17 路可用）", taskType: "reason" },
      { level: "warning", category: "timeout", message: "[demo] 慢查询：概念溯源分析 32.4s（>30s）", taskType: "reason" },
      { level: "warning", category: "reflection", message: "[demo] 反思修正触发：初评 0.48 < 0.55，正在重新生成", taskType: "reason", detail: { questionId: "Q-demo" } },
      { level: "error", category: "circuit_breaker", message: "[demo] 反思熔断已打开——连续 2 次失败跳过反思", taskType: "reason", detail: { failures: 2 } },
      { level: "critical", category: "failure", message: "[demo] 评测任务崩溃：eval-32-metrics 进程异常退出（exit 1）", taskType: "eval", detail: { exitCode: 1 } },
      { level: "error", category: "failure", message: "[demo] 入库失败：LLM JSON 解析失败（批次 12）", taskType: "ingest", detail: { batch: 12 } },
    ];
    for (const d of demos) {
      await fetch("/api/alerts/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) });
    }
    void load();
  };

  // 统计
  const byLevel = { info: 0, warning: 0, error: 0, critical: 0 };
  const byCategory: Record<string, number> = {};
  for (const a of alerts) {
    byLevel[a.level] = (byLevel[a.level] ?? 0) + 1;
    byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
  }
  const total = alerts.length;
  const topCategory = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Bell className="h-4 w-4 text-amber-500" />
        <h2 className="text-sm font-semibold">告警中心</h2>
        {unread > 0 && <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">{unread} 未读</span>}
        <span className="text-[10px] text-muted-foreground">任务巡检 · 降级/超时/熔断/失败事件 · 5 秒自动刷新</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => void runDemo()} className="flex items-center gap-1 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-700 hover:bg-violet-500/20" title="一键触发各类型告警演示">
            <Play className="h-3 w-3" /> Demo
          </button>
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]", autoRefresh ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")}
            title="自动刷新开关"
          >
            <RefreshCw className={cn("h-3 w-3", autoRefresh && "animate-spin [animation-duration:3s]")} /> 自动
          </button>
          <button onClick={() => void markRead()} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted" title="全部已读">
            <CheckCheck className="h-3 w-3" /> 全部已读
          </button>
          <button onClick={() => void clear()} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-red-50 hover:text-red-600" title="清空已读">
            <Trash2 className="h-3 w-3" /> 清空已读
          </button>
        </div>
      </div>

      {/* 统计卡片（巡检可视化） */}
      <div className="grid grid-cols-4 gap-2 border-b p-3">
        <div className="rounded-lg border p-2">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground"><BarChart3 className="h-3 w-3" /> 全部事件</div>
          <div className="mt-1 text-lg font-semibold">{total}</div>
        </div>
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
          <div className="flex items-center gap-1 text-[10px] text-amber-700"><AlertTriangle className="h-3 w-3" /> 警告</div>
          <div className="mt-1 text-lg font-semibold text-amber-700">{byLevel.warning}</div>
        </div>
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2">
          <div className="flex items-center gap-1 text-[10px] text-red-700"><AlertOctagon className="h-3 w-3" /> 错误</div>
          <div className="mt-1 text-lg font-semibold text-red-700">{byLevel.error}</div>
        </div>
        <div className="rounded-lg border border-red-600/30 bg-red-600/10 p-2">
          <div className="flex items-center gap-1 text-[10px] text-red-700"><AlertOctagon className="h-3 w-3" /> 严重</div>
          <div className="mt-1 text-lg font-semibold text-red-700">{byLevel.critical}</div>
          {topCategory && <div className="text-[9px] text-muted-foreground">高频: {topCategory[0]}</div>}
        </div>
      </div>

      {/* V381: 系统健康 — 事件中心 + 记忆评测（实时状态卡） */}
      <div className="grid grid-cols-3 gap-2 border-b p-3">
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-2">
          <div className="flex items-center gap-1 text-[10px] text-blue-700"><Activity className="h-3 w-3" /> 事件中心</div>
          <div className="mt-1 text-lg font-semibold text-blue-800">{eventPending}</div>
          <div className="text-[9px] text-muted-foreground">{eventHandlerActive ? "sleep_learn 已注册" : "无处理器"}</div>
        </div>
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2">
          <div className="flex items-center gap-1 text-[10px] text-emerald-700"><Target className="h-3 w-3" /> 记忆召回</div>
          <div className="mt-1 text-lg font-semibold text-emerald-800">{recallReport ? `${Math.round((recallReport.recallAt5 ?? 0) * 100)}%` : "—"}</div>
          <div className="text-[9px] text-muted-foreground">{recallReport ? `${recallReport.hits}/${recallReport.total} 命中` : "未评测"}</div>
        </div>
        <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-2">
          <div className="flex items-center gap-1 text-[10px] text-cyan-700"><Cpu className="h-3 w-3" /> KV 缓存</div>
          <div className="mt-1 text-lg font-semibold text-cyan-800">{cacheRate !== null ? `${cacheRate}%` : "—"}</div>
          <div className="text-[9px] text-muted-foreground">平均前缀命中率</div>
        </div>
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center gap-2 py-10 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中...</div>
        ) : alerts.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">暂无告警。任务执行中的降级/超时/熔断/失败事件会实时出现在这里。</div>
        ) : (
          <div className="space-y-1.5">
            {alerts.map((a) => {
              const style = LEVEL_STYLES[a.level];
              return (
                <div
                  key={a.id}
                  className={cn(
                    "flex items-start gap-2 rounded-lg border p-2.5 transition-opacity",
                    a.read ? "opacity-60" : "border-primary/30 bg-primary/5"
                  )}
                >
                  <span className={cn("mt-0.5 flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium", style.badge)}>
                    {style.icon} {style.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] leading-4">{a.message}</p>
                    <div className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground">
                      <span className="rounded bg-muted px-1 py-0.5">{CATEGORY_LABELS[a.category] ?? a.category}</span>
                      {a.task_type && <span>{a.task_type}</span>}
                      <span>{new Date(a.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                      {/* V379: 自愈状态徽章 */}
                      {a.metadata?.healed === true && (
                        <span className="ml-auto rounded bg-green-100 px-1.5 py-0.5 text-[8px] text-green-700" title={`修复动作：${a.metadata.healAction}\n详情：${a.metadata.healDetail}`}>
                          ✓ 已自愈（{String(a.metadata.healAction ?? "").slice(0, 12)}）
                        </span>
                      )}
                      {a.metadata?.healed === false && (
                        <span className="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 text-[8px] text-amber-600" title={`处理动作：${a.metadata.healAction}\n原因：${a.metadata.healDetail}`}>
                          ⚠ 需人工（{String(a.metadata.healAction ?? "").slice(0, 12)}）
                        </span>
                      )}
                      {!a.read && !a.metadata?.healed && <span className="ml-auto rounded-full bg-primary/20 px-1.5 py-0.5 text-[8px] text-primary">未读</span>}
                    </div>
                    {Boolean(a.metadata?.healDetail) && (
                      <p className="mt-0.5 rounded bg-muted/40 p-1 text-[9px] text-muted-foreground">🔧 {String(a.metadata?.healDetail)}</p>
                    )}
                    {a.detail && Object.keys(a.detail).length > 0 && (
                      <pre className="mt-1 truncate rounded bg-muted/40 p-1 text-[9px] text-muted-foreground">{JSON.stringify(a.detail)}</pre>
                    )}
                  </div>
                  {!a.read && (
                    <button onClick={() => void markRead(a.id)} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted" title="标记已读">
                      <CheckCheck className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
