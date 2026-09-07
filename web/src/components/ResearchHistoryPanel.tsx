// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ResearchHistoryPanel.tsx — SocialSci HistoryView 源码级对照(闭源 Vue HistoryView 解码):
//   6 模块历史分区(section-header+count+task-grid 卡) / 卡=状态点+phase 徽标+title+相对时间 /
//   点击恢复对应工作台条目(deep-resume) / 清除全部历史(confirm + ACTIVE_JOB 保护 + failed 明细 toast)
// 数据源: GET /api/research/history(后端一次聚合 6 源: research_tasks+review_jobs+empirical_results
//   +viz_sessions+documents_v2+search_query_history); 删除走 DELETE /api/research/tasks/history(deleteAll 语义)
// 恢复通道: localStorage sag:resume:<module> = {id, projectId} — 各工作台面板挂载时消费并自动打开
//   (语义同闭源 lastTask_*; knowledge 查询经 App pendingDemo 通道重放)
import { useCallback, useEffect, useState } from "react";
import { BarChart3, BookOpen, ChevronRight, ClipboardList, Eraser, FlaskConical, GitBranch, Loader2, PenLine, RefreshCw, Search } from "lucide-react";
import { ConfirmDialog, type ConfirmSpec } from "./ConfirmDialog";

function tokenOf() { return localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""; }
async function j<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) ?? {}) };
  const t = tokenOf(); if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(url, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败 ${r.status}`);
  return body as T;
}

/** 统一历史条目(闭源 HistoryView 卡结构: phase 徽标+title+status+相对时间) */
export interface HistoryTask {
  id: string; projectId?: string; module: string; title: string; phase: number; phase_label: string;
  status: string; created_at: string; updated_at: string; error?: unknown; active?: boolean; kind?: string;
}
interface HistoryBundle {
  tasks: HistoryTask[]; review: HistoryTask[]; statistics: HistoryTask[]; viz: HistoryTask[];
  editor: HistoryTask[]; knowledge: HistoryTask[];
}

/** deep-resume: 写入待消费的恢复指针(目标面板挂载时读取并自动打开; 同闭源 lastTask_* 语义) */
export function writeResume(module: string, payload: Record<string, unknown>) {
  try { localStorage.setItem(`sag:resume:${module}`, JSON.stringify({ ...payload, at: Date.now() })); } catch { /* 忽略 */ }
}
export function readResume(module: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(`sag:resume:${module}`);
    if (!raw) return null;
    localStorage.removeItem(`sag:resume:${module}`);
    const p = JSON.parse(raw) as Record<string, unknown>;
    // 10s 内写入的才算数(避免陈旧指针误触发)
    return typeof p.at === "number" && Date.now() - p.at < 10_000 ? p : null;
  } catch { return null; }
}
/** 清除全部历史后清理全部恢复指针(闭源 lastTask_* removeItem 语义) */
export function clearResumeAll() {
  for (const m of ["workflow", "review", "statistics", "viz", "editor", "knowledge"]) {
    try { localStorage.removeItem(`sag:resume:${m}`); } catch { /* 忽略 */ }
  }
}

const MODULE_ORDER: Array<{ key: string; label: string; color: string; icon: React.ReactNode; target: string }> = [
  { key: "workflow", label: "科研工作流", color: "#06b6d4", icon: <GitBranch className="h-3.5 w-3.5" />, target: "dag-workbench" },
  { key: "review", label: "审稿记录", color: "#f43f5e", icon: <ClipboardList className="h-3.5 w-3.5" />, target: "review-lab" },
  { key: "statistics", label: "数据分析", color: "#8b5cf6", icon: <FlaskConical className="h-3.5 w-3.5" />, target: "empirical-research" },
  { key: "viz", label: "科研绘图", color: "#ec4899", icon: <BarChart3 className="h-3.5 w-3.5" />, target: "plot-agent" },
  { key: "editor", label: "编辑器文档", color: "#6366f1", icon: <PenLine className="h-3.5 w-3.5" />, target: "editor" },
  { key: "knowledge", label: "知识库查询", color: "#22c55e", icon: <Search className="h-3.5 w-3.5" />, target: "ask" },
];

/** 相对时间(闭源格式: <1h 分钟前 / <1d 小时前 / <7d 天前 / 否则日期) */
function relTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return "";
  const diff = Date.now() - d;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function statusDot(s: string): { cls: string; title: string } {
  const v = s || "";
  if (v === "done" || v === "completed" || v === "active" || v === "draft") return { cls: "bg-green-400", title: v };
  if (v === "failed" || v === "error" || v === "cancelled") return { cls: "bg-rose-400", title: v };
  if (v === "queued" || v === "running" || v === "streaming" || v === "segmenting" || v === "summarizing" || v === "reviewing") return { cls: "bg-amber-400 animate-pulse", title: `${v} 进行中` };
  return { cls: "bg-slate-400", title: v };
}

export function ResearchHistoryPanel({ onNavigate }: { onNavigate: (view: string) => void }) {
  const [bundle, setBundle] = useState<HistoryBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState("");
  const [askClear, setAskClear] = useState<ConfirmSpec | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await j<HistoryBundle>("/api/research/history");
      setBundle(r);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const total = (bundle?.tasks.length ?? 0) + (bundle?.review.length ?? 0) + (bundle?.statistics.length ?? 0)
    + (bundle?.viz.length ?? 0) + (bundle?.editor.length ?? 0) + (bundle?.knowledge.length ?? 0);

  // 清除全部历史(闭源 z(): confirm → deleteAll → failed 明细 → 清空+重载)
  const clearAll = async () => {
    setBusy(true); setErr(""); setToast("");
    try {

      const r = await j<{ deleted: Array<{ id: string; module: string }>; failed?: Array<{ id: string; module: string; reason: string }> }>("/api/research/tasks/history", { method: "DELETE", body: "{}" });
      const failed = Array.isArray(r.failed) ? r.failed : [];
      clearResumeAll();
      await load();
      if (failed.length > 0) {
        const nActive = failed.filter((f) => f.reason === "ACTIVE_JOB").length;
        const others = [...new Set(failed.filter((f) => f.reason !== "ACTIVE_JOB").map((f) => f.reason).filter(Boolean))];
        const parts = [
          nActive ? `${nActive} 条仍在运行，请先取消或等待完成` : "",
          others.length ? `其他失败原因：${others.join("、")}` : "",
        ].filter(Boolean).join("；");
        setToast(`已删除 ${r.deleted?.length ?? 0} 条，${failed.length} 条未能删除${parts ? `（${parts}）` : ""}。`);
      } else {
        setToast(`已删除 ${r.deleted?.length ?? 0} 条历史记录。`);

      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // 点击恢复: 写 deep-resume 指针 → 跳对应工作台(面板挂载时自动打开该条目)
  // module 取卡片所在区 key(后端 statistics/viz/editor/knowledge/review 条目不带 module 字段, 由区定位)
  const resume = (moduleKey: string, t: HistoryTask) => {
    const meta = MODULE_ORDER.find((m) => m.key === moduleKey);
    if (!meta) return;
    if (moduleKey === "knowledge") {
      writeResume("knowledge", { id: t.id, query: t.title });
    } else {
      writeResume(moduleKey, { id: t.id, projectId: t.projectId ?? "" });
    }
    onNavigate(meta.target);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏: 标题 + 总计数 + 操作(闭源 history-page header) */}
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-cyan-400" />
          <h2 className="text-base font-bold text-slate-100">历史记录</h2>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">{total} 条记录</span>
        </div>
        <div className="flex items-center gap-2">
          {total > 0 && (
            <button
              onClick={() => setAskClear({ title: "清除历史记录", desc: "确定清除全部历史记录？此操作不可撤销。\n将删除科研任务/审稿/绘图会话/知识查询等记录；运行中的任务会被保留。文档与实证分析结果不受影响。", confirmText: "清除", danger: true })}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs text-rose-500 transition-colors hover:bg-rose-50 disabled:opacity-50">
              <Eraser className="h-3.5 w-3.5" /> 清除全部历史
            </button>
          )}
          <button onClick={() => void load()} disabled={busy} className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-50">
            <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} /> 刷新
          </button>
        </div>
      </div>

      {toast && <div className="border-b border-amber-500/20 bg-amber-500/10 px-5 py-2 text-xs text-amber-300">{toast}</div>}
      {err && <div className="border-b border-red-500/30 bg-red-500/10 px-5 py-2 text-xs text-red-300">{err}</div>}

      {/* 6 模块分区(section-header + task-grid 卡 / 空区 section-empty) */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!bundle && busy && (
          <div className="py-20 text-center text-sm text-slate-500"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />加载中...</div>
        )}
        {!bundle && !busy && <div className="py-20 text-center text-sm text-slate-500">暂无数据或加载失败，请点刷新重试</div>}
        {bundle && total === 0 && (
          <div className="py-20 text-center">
            <p className="text-sm text-slate-400">暂无历史记录</p>
            <p className="mt-1 text-xs text-slate-600">开始使用各模块后，任务会自动出现在这里</p>
          </div>
        )}
        {bundle && total > 0 && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {MODULE_ORDER.map((meta) => {
              // 后端返回字段名 tasks 对应 workflow 区(闭源 module=workflow), 其余同名
              const list = (meta.key === "workflow" ? bundle.tasks : (bundle as unknown as Record<string, HistoryTask[]>)[meta.key]) ?? [];
              if (list.length === 0) {
                return (
                  <section key={meta.key} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold" style={{ color: meta.color }}>
                      {meta.icon} {meta.label}
                      <span className="ml-auto rounded-full bg-slate-800 px-1.5 py-0.5 text-[9px] text-slate-500">{list.length} 个任务</span>
                    </h3>
                    <p className="py-4 text-center text-[11px] text-slate-600">暂无 {meta.label} 记录</p>
                  </section>
                );
              }
              return (
                <section key={meta.key} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold" style={{ color: meta.color }}>
                    {meta.icon} {meta.label}
                    <span className="ml-auto rounded-full bg-slate-800 px-1.5 py-0.5 text-[9px] text-slate-500">{list.length} 个任务</span>
                  </h3>
                  <div className="space-y-1.5">
                    {list.map((t) => {
                      const dot = statusDot(t.status);
                      return (
                        <button key={`${meta.key}:${t.id}`} onClick={() => resume(meta.key, t)}
                          className="flex w-full items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-2 text-left transition hover:border-slate-600 hover:bg-slate-800"
                          title={t.active ? "运行中 — 点击前往该任务工作台" : "点击恢复该条目"}>
                          <span className={`h-2 w-2 shrink-0 rounded-full ${dot.cls}`} title={dot.title} />
                          {t.phase_label ? (
                            <span className="shrink-0 rounded border border-slate-600/60 px-1 py-px text-[8px] text-slate-400">{t.phase_label}</span>
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[11px] font-medium text-slate-200">{t.title || "未命名"}</p>
                            <p className="text-[9px] text-slate-500">{relTime(t.updated_at || t.created_at)}{t.active ? " · 运行中" : ""}</p>
                          </div>
                          <ChevronRight className="h-3 w-3 shrink-0 text-slate-600" />
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
      <ConfirmDialog spec={askClear} onDone={(ok) => { setAskClear(null); if (ok) void clearAll(); }} />
    </div>
  );
}
