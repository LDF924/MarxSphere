// MemoryPanel.tsx — 记忆管理面板（2026-08-08 V326, P1-4 记忆向量化 + P1-8 睡眠学习 前端展示）
// 展示: ①记忆统计卡(总数/归档/冲突/向量化) ②最近记忆列表(状态徽章) ③睡眠学习报告
// 真实数据: GET /api/memory/stats + /api/memory/recent; 10秒轮询; 无数据回退 demo
import { useEffect, useRef, useState, type FC } from "react";
import { Archive, Brain, CircleCheck, CircleX, Database, RefreshCw, Zap } from "lucide-react";
import { cn } from "../lib/utils";
import { Card } from "./ui/card";
import { api } from "../lib/api";

interface MemoryStats { total: number; archived: number; conflicts: number; vectorized: number }
interface RecentMemory { query: string; qtype: string; success: boolean; quality_score: number | null; archived: boolean; conflict_unsolved: boolean; created_at: string; vectorized?: boolean }

// demo 数据（无真实数据时展示）
const DEMO_STATS: MemoryStats = { total: 128, archived: 6, conflicts: 2, vectorized: 122 };
const DEMO_MEMORIES: RecentMemory[] = [
  { query: "农村土地流转政策", qtype: "政策评估", success: true, quality_score: 0.9, archived: false, conflict_unsolved: false, created_at: new Date().toISOString() },
  { query: "农地三权分置规定", qtype: "政策评估", success: true, quality_score: 0.85, archived: false, conflict_unsolved: false, created_at: new Date().toISOString() },
  { query: "资本规范引导机制", qtype: "概念定义", success: false, quality_score: 0.4, archived: true, conflict_unsolved: true, created_at: new Date(Date.now() - 86400000).toISOString() },
  { query: "合作社人力资本负向影响", qtype: "多跳推理", success: true, quality_score: 0.78, archived: false, conflict_unsolved: false, created_at: new Date(Date.now() - 172800000).toISOString() },
];

export const MemoryPanel: FC = () => {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [memories, setMemories] = useState<RecentMemory[] | null>(null);
  const [usingDemo, setUsingDemo] = useState(false);
  const [lastSync, setLastSync] = useState("");
  // V331: 预算感知记录（P1-9）
  const [prunes, setPrunes] = useState<Array<{ taskId: string; query: string; op: string; executedCost: number; budget: number; createdAt: string }> | null>(null);
  // V335: 睡眠学习报告（P1-8）
  const [sleepReport, setSleepReport] = useState<{ lastReport: { duplicates: number; archived_duplicates: number; conflicts: number; pruned: number; at: string | null } | null; current: { archived: number; conflicts: number } } | null>(null);
  // V338: 成本监控（P2-3）
  const [cost, setCost] = useState<{ summary: { totalTokensIn: number; totalTokensOut: number; estimatedCost: number; taskCount: number; byModel: Record<string, { tokensIn: number; tokensOut: number; cost: number }> } | null; today: { cost: number; tokensIn: number; tokensOut: number } | null }>({ summary: null, today: null });
  // V337: 记忆注入设置（用户控制）
  const [injectSettings, setInjectSettings] = useState<{ enabled: string; mode: string; count: string } | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNote, setSettingsNote] = useState<string | null>(null);
  // V370: OpenViking Studio iframe 展开状态
  const [ovOpen, setOvOpen] = useState(true);
  // V371: iframe 高度（跨域不可读内容，用固定大高度 800px 保证完整显示）
  const [ovHeight, setOvHeight] = useState(800);
  useEffect(() => {
    if (!ovOpen) return;
    // 视口大时再拉高一点（最大 900）
    setOvHeight(Math.min(900, Math.max(800, window.innerHeight - 260)));
    const onResize = () => setOvHeight(Math.min(900, Math.max(800, window.innerHeight - 260)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [ovOpen]);

  useEffect(() => {
    void api.getMemoryInjectSettings().then((r) => setInjectSettings(r.settings)).catch(() => {});
  }, []);

  const saveInjectSettings = async () => {
    if (!injectSettings) return;
    setSettingsSaving(true);
    try {
      const r = await api.saveMemoryInjectSettings({ enabled: injectSettings.enabled, mode: injectSettings.mode, count: Number(injectSettings.count) });
      setSettingsNote(r.note || "已保存");
    } catch (e: any) { setSettingsNote("保存失败: " + String(e).substring(0, 50)); }
    setSettingsSaving(false);
  };

  // 10 秒轮询真实数据
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [s, m, p, sr, cs, tc] = await Promise.all([
          api.getMemoryStats(), api.getRecentMemories(10), api.getBudgetPrunes(5), api.getSleepReport(), api.getCostSummary(7), api.getTodayCost(),
        ]);
        if (cancelled) return;
        setStats(s);
        setMemories(m.items);
        setPrunes(p.items);
        setSleepReport(sr);
        setCost({ summary: cs, today: tc });
        setUsingDemo(s.total === 0);
        setLastSync(new Date().toLocaleTimeString());
      } catch { /* 失败保持现状 */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const displayStats = stats ?? DEMO_STATS;
  const displayMemories = memories ?? DEMO_MEMORIES;

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      {/* V370: OpenViking 长期记忆——全宽显示（突破 max-w-5xl，消除两侧空白） */}
      <div className="mb-4 rounded-lg border bg-background/40">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Brain className="h-3.5 w-3.5 text-violet-500" />
          <span className="text-xs font-semibold">OpenViking 长期记忆</span>
          <span className="text-[10px] text-muted-foreground">外部记忆层 · 用户偏好/会话经验/历史交互 · 独立存储</span>
          <button
            onClick={() => setOvOpen((v) => !v)}
            className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
          >
            {ovOpen ? "收起" : "展开管理界面"}
          </button>
        </div>
        {ovOpen && (
          <iframe
            src="http://127.0.0.1:1933/studio"
            className="w-full border-0"
            style={{ height: ovHeight }}
            title="OpenViking Studio"
          />
        )}
      </div>
      {/* SAG 记忆概览——全宽（与上方 OpenViking 一致，消除两侧空白） */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">记忆管理</h2>
            <span className="text-xs text-muted-foreground">长期经验 · 向量化 · 睡眠学习</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
            {usingDemo && !stats && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">演示数据</span>
            )}
            <span className="flex items-center gap-1"><RefreshCw className="h-2.5 w-2.5" /> 每 10 秒自动同步{lastSync && ` · ${lastSync}`}</span>
          </div>
        </div>

        {/* V337: 记忆注入设置（用户控制）— 是否注入 + 模式 + 数量 */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Brain className="h-3.5 w-3.5 text-primary" /> 记忆注入设置
          </div>
          {injectSettings ? (
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-muted-foreground">注入开关</span>
                <button type="button" onClick={() => setInjectSettings({ ...injectSettings, enabled: injectSettings.enabled === "on" ? "off" : "on" })}
                  className={cn("rounded px-2.5 py-1 text-[11px] font-medium", injectSettings.enabled === "on" ? "bg-green-50 text-green-700" : "bg-muted text-muted-foreground")}>
                  {injectSettings.enabled === "on" ? "已开启" : "已关闭"}
                </button>
                <span className="text-muted-foreground">{injectSettings.enabled === "on" ? "AI 回答时注入相似经验" : "AI 回答时不注入记忆"}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-muted-foreground">注入模式</span>
                <select value={injectSettings.mode} onChange={(e) => setInjectSettings({ ...injectSettings, mode: e.target.value })}
                  className="rounded border border-border bg-background px-2 py-1 text-xs">
                  <option value="all">全部（含失败标注）</option>
                  <option value="success">仅成功经验</option>
                  <option value="top">仅高质量（≥0.6）</option>
                </select>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-muted-foreground">注入条数</span>
                <input type="number" min={0} max={5} value={injectSettings.count}
                  onChange={(e) => setInjectSettings({ ...injectSettings, count: e.target.value })}
                  className="w-16 rounded border border-border bg-background px-2 py-1 text-xs" />
                <span className="text-muted-foreground">0-5 条</span>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void saveInjectSettings()} disabled={settingsSaving}
                  className="rounded bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                  {settingsSaving ? "保存中…" : "保存设置"}
                </button>
                {settingsNote && <span className="text-[10px] text-amber-600">{settingsNote}</span>}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">加载设置中…</p>
          )}
        </Card>

        {/* 统计卡 */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {[
            { label: "记忆总数", value: displayStats.total, icon: <Database className="h-4 w-4 text-blue-500" /> },
            { label: "向量化覆盖", value: displayStats.vectorized, icon: <Zap className="h-4 w-4 text-violet-500" /> },
            { label: "已归档", value: displayStats.archived, icon: <Archive className="h-4 w-4 text-amber-500" /> },
            { label: "冲突未解决", value: displayStats.conflicts, icon: <CircleX className="h-4 w-4 text-red-500" /> },
          ].map((s) => (
            <Card key={s.label} className="p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">{s.icon}{s.label}</div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{s.value}</div>
            </Card>
          ))}
        </div>

        {/* 最近记忆列表 */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">最近记忆</div>
          {displayMemories.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              暂无记忆 — 系统运行推理后自动沉淀
              <button type="button" onClick={() => { void api.getMemoryStats().then(setStats); void api.getRecentMemories(10).then(m => setMemories(m.items)); }}
                className="ml-2 rounded bg-primary px-2 py-1 text-[10px] text-primary-foreground">刷新</button>
            </div>
          ) : (
            <div className="space-y-1">
              {displayMemories.map((m, i) => (
                <div key={i} className="flex items-center justify-between gap-2 rounded border border-border/50 px-2 py-1.5 text-xs transition-colors hover:bg-accent/40">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", m.success ? "bg-green-500" : "bg-red-500")} />
                    <span className="truncate">{m.query}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{m.qtype}</span>
                    {m.vectorized && <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700"><Zap className="inline h-2.5 w-2.5" />向量</span>}
                    {m.archived && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">已归档</span>}
                    {m.conflict_unsolved && <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700">冲突</span>}
                    {m.quality_score != null && <span className="tabular-nums text-muted-foreground">{Number(m.quality_score).toFixed(2)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* V331: 预算感知（P1-9）— adaptive 执行中裁剪记录 */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Zap className="h-3.5 w-3.5 text-violet-500" /> 预算感知（BAVT）
          </div>
          {prunes && prunes.length > 0 ? (
            <div className="space-y-1">
              {prunes.map((p, i) => (
                <div key={i} className="flex items-center justify-between gap-2 rounded border border-border/50 px-2 py-1.5 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{p.query}</span>
                    <span className="shrink-0 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700">裁剪 {p.op}</span>
                  </div>
                  <span className="shrink-0 tabular-nums text-muted-foreground">成本 {p.executedCost}/{p.budget}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              暂无裁剪记录 — adaptive 推理中预算超过 60% 时自动裁剪非核心算子（省钱保质量）。运行复杂推理后可见。
            </p>
          )}
        </Card>

        {/* 睡眠学习说明（V335: 显示上次整理报告） */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <CircleCheck className="h-3.5 w-3.5 text-green-500" /> 睡眠学习（夜间自动整理）
          </div>
          {sleepReport?.lastReport ? (
            <div className="space-y-2">
              <div className="grid grid-cols-4 gap-1.5">
                {[
                  { label: "去重", value: sleepReport.lastReport.duplicates },
                  { label: "冲突标记", value: sleepReport.lastReport.conflicts },
                  { label: "修剪归档", value: sleepReport.lastReport.pruned },
                  { label: "当前归档", value: sleepReport.current.archived },
                ].map((s) => (
                  <div key={s.label} className="rounded border border-border/50 bg-muted/30 p-1.5 text-center">
                    <div className="text-[10px] text-muted-foreground">{s.label}</div>
                    <div className="text-base font-bold tabular-nums">{s.value}</div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                最近整理于 {sleepReport.lastReport.at ? new Date(sleepReport.lastReport.at).toLocaleString() : "近期"}
                — dream_cycle 自动执行：去重（相同问题合并）→ 冲突标记（成功/失败并存标未解决）→ 修剪（90 天未用或点踩归档）。
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              尚无 sleep_learn 整理报告 — dream_cycle 含 sleep_learn 阶段后自动生成（当前已归档 {sleepReport?.current.archived ?? displayStats.archived} 条，冲突 {sleepReport?.current.conflicts ?? displayStats.conflicts} 条）。
            </p>
          )}
        </Card>

        {/* V338: 成本监控（P2-3）— token → 成本估算 */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Database className="h-3.5 w-3.5 text-blue-500" /> 成本监控（近 7 天）
          </div>
          {cost.summary ? (
            <div className="space-y-2">
              <div className="grid grid-cols-4 gap-1.5">
                {[
                  { label: "总成本", value: "$" + cost.summary.estimatedCost.toFixed(2) },
                  { label: "今日成本", value: cost.today ? "$" + cost.today.cost.toFixed(3) : "-" },
                  { label: "输入 token", value: cost.summary.totalTokensIn.toLocaleString() },
                  { label: "输出 token", value: cost.summary.totalTokensOut.toLocaleString() },
                ].map((s) => (
                  <div key={s.label} className="rounded border border-border/50 bg-muted/30 p-1.5 text-center">
                    <div className="text-[10px] text-muted-foreground">{s.label}</div>
                    <div className="text-base font-bold tabular-nums">{s.value}</div>
                  </div>
                ))}
              </div>
              {Object.keys(cost.summary.byModel).length > 0 && (
                <div className="space-y-1">
                  {Object.entries(cost.summary.byModel).map(([model, v]) => (
                    <div key={model} className="flex items-center justify-between rounded border border-border/50 px-2 py-1 text-[11px]">
                      <span className="truncate">{model}</span>
                      <span className="tabular-nums text-muted-foreground">{(v.tokensIn / 1e6).toFixed(1)}M in / {(v.tokensOut / 1e6).toFixed(1)}M out</span>
                      <span className="tabular-nums text-blue-600">${v.cost.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground">按 DeepSeek 约价估算（$0.3/M in + $1.2/M out），实际以账单为准。单任务 token 上限：100 万。</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">暂无成本数据 — 运行推理后可见 token 用量与成本估算。</p>
          )}
        </Card>
      </div>
    </section>
  );
};
