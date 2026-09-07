// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ResearchHistoryPanel.tsx — SocialSci UI审计: 历史记录中心(6模块分区卡)
// 形态对齐(闭源 HistoryView): 按模块分区卡片(科研工作流/审稿/数据分析/绘图/编辑器/知识库),
//   卡片=状态点+phase_label+标题+相对时间; 点击恢复该任务(切到对应工作台); 清除全部历史
import { useCallback, useEffect, useState } from "react";
import { BarChart3, BookOpen, ChevronRight, ClipboardList, Eraser, FlaskConical, GitBranch, Loader2, PenLine, Search } from "lucide-react";
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

interface HistoryTask {
  id: string; module: string; title: string; phase: number; phase_label: string;
  status: string; created_at: string; updated_at: string;
}

const MODULE_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  workflow: { label: "科研工作流", color: "#06b6d4", icon: <GitBranch className="h-3.5 w-3.5" /> },
  review: { label: "审稿记录", color: "#f43f5e", icon: <ClipboardList className="h-3.5 w-3.5" /> },  statistics: { label: "数据分析", color: "#8b5cf6", icon: <FlaskConical className="h-3.5 w-3.5" /> },
  viz: { label: "科研绘图", color: "#ec4899", icon: <BarChart3 className="h-3.5 w-3.5" /> },
  editor: { label: "编辑器文档", color: "#6366f1", icon: <PenLine className="h-3.5 w-3.5" /> },
  knowledge: { label: "知识库查询", color: "#22c55e", icon: <Search className="h-3.5 w-3.5" /> },
};

function relTime(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(iso).toLocaleDateString();
}

export function ResearchHistoryPanel({ onNavigate }: { onNavigate: (view: string) => void }) {
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [askClear, setAskClear] = useState<ConfirmSpec | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [r, v, s] = await Promise.all([
        j<{ tasks: HistoryTask[] }>("/api/research/tasks"),
        j<{ jobs: HistoryTask[] }>("/api/review/jobs").catch(() => ({ jobs: [] as HistoryTask[] })),
        j<{ materials: HistoryTask[] }>("/api/viz/sessions").catch(() => ({ sessions: [] as HistoryTask[] })),
      ]);
      // workflow/review/viz 三类合并(editor/knowledge/statistics 各自任务)
      const merged: HistoryTask[] = [...(r.tasks ?? []).map((t) => ({ ...t, module: "workflow" }))];
      const reviewJobs = await j<{ jobs: Array<{ id: string; title: string; status: string; created_at: string; updated_at: string }> }>("/api/review/jobs").catch(() => ({ jobs: [] }));
      merged.push(...reviewJobs.jobs.map((j2) => ({ id: j2.id, module: "review", title: j2.title || "审稿任务", phase: 0, phase_label: "", status: j2.status, created_at: j2.created_at, updated_at: j2.updated_at })));
      const docs = await j<{ data: { items: Array<{ id: string; title: string; updated_at: string }> } }>("/api/editor/v1/documents").catch(() => ({ data: { items: [] } }));
      merged.push(...docs.data.items.map((d2) => ({ id: d2.id, module: "editor", title: d2.title || "未命名文档", phase: 0, phase_label: "", status: "done", created_at: d2.updated_at, updated_at: d2.updated_at })));
      setTasks(merged.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()).slice(0, 60));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const clearAll = async () => {
    setBusy(true);
    try {
      await j("/api/research/tasks/history", { method: "DELETE" });
      setTasks([]);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const resume = (t: HistoryTask) => {
    // 按模块跳到对应工作台
    const target = t.module === "review" ? "review-lab" : t.module === "viz" ? "plot-agent"
      : t.module === "editor" ? "editor" : t.module === "knowledge" ? "ask" : "dag-workbench";
    onNavigate(target);
  };

  const statusColor = (s: string) =>
    s === "done" || s === "completed" ? "bg-green-400" : s === "failed" || s === "error" ? "bg-rose-400"
    : s === "running" || s === "reviewing" ? "bg-amber-400 animate-pulse" : "bg-slate-400";

  const modules = Object.keys(MODULE_META);

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-cyan-400" />
          <h2 className="text-base font-bold text-slate-100">历史记录</h2>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">SocialSci 对齐</span>
        </div>
        <div className="flex items-center gap-2">
          {tasks.length > 0 && (
            <button onClick={() => setAskClear({ title: "清除全部历史?", desc: "将删除科研任务/审稿记录/绘图会话等全部历史条目, 不可恢复。", confirmText: "清除", danger: true })} disabled={busy}
              className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-rose-600/30 hover:text-rose-300 disabled:opacity-50">
              <Eraser className="h-3.5 w-3.5" /> 清除全部历史
            </button>
          )}
          <button onClick={() => void load()} className="rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-700">刷新</button>
        </div>
      </div>

      {err && <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">{err}</div>}
      {busy && <div className="mb-2 text-xs text-slate-500"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />加载中...</div>}

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto lg:grid-cols-3">
        {modules.map((m) => {
          const meta = MODULE_META[m];
          const list = tasks.filter((t) => t.module === m);
          return (
            <div key={m} className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold" style={{ color: meta.color }}>
                {meta.icon} {meta.label}
                <span className="ml-auto rounded-full bg-slate-800 px-1.5 py-0.5 text-[9px] text-slate-400">{list.length}</span>
              </p>
              {list.length === 0 && <p className="py-3 text-center text-[10px] text-slate-600">暂无记录</p>}
              <div className="space-y-1.5">
                {list.slice(0, 6).map((t) => (
                  <button key={t.id} onClick={() => resume(t)}
                    className="flex w-full items-center gap-2 rounded-lg border border-slate-700/40 bg-slate-800/40 px-2.5 py-2 text-left transition hover:border-slate-500 hover:bg-slate-800">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${statusColor(t.status)}`} title={t.status} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium text-slate-200">{t.title || "未命名"}</p>
                      <p className="text-[9px] text-slate-500">{t.phase_label || `阶段 ${t.phase}`} · {relTime(t.updated_at)}</p>
                    </div>
                    <ChevronRight className="h-3 w-3 shrink-0 text-slate-600" />
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <ConfirmDialog spec={askClear} onDone={(ok) => { setAskClear(null); if (ok) void clearAll(); }} />
    </div>
  );
}
