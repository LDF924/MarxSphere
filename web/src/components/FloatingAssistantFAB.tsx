// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// FloatingAssistantFAB.tsx — SocialSci P0-7: 悬浮助手(深水区体验件)
// 形态对齐(闭源产品交互语义, 原创实现): 全局悬浮在场 UI(非对话框唤起式)
//   ①页面观察+导航引导: 记录访问历史 → 按"科研推进"规则推荐下一步
//   ②任务推荐: 聚合 research 流水线任务 + agent 任务, 推荐"继续/恢复"
//   ③签到卡: P0-8 points 接口就绪后接入(点位已留: loadCheckin + 签到按钮)
import { useEffect, useMemo, useRef, useState } from "react";
import { Bird, CheckCircle2, ChevronRight, Coffee, Compass, Loader2, Sparkles, X } from "lucide-react";

const HISTORY_KEY = "marx:assistant:viewhistory:v1";
const TIP_KEY = "marx:assistant:tiptime:v1";

/** 页面观察 → 导航推荐规则表(科研推进主线; 纯前端, 不埋点) */
const NEXT_STEP_RULES: Array<{ from: string[]; to: string; toLabel: string; reason: string }> = [
  { from: ["literature", "sciverse", "imports"], to: "citation-verify", toLabel: "引文核验", reason: "文献检索后建议核验引用, 保证证据可信" },
  { from: ["ask", "reason"], to: "dag-workbench", toLabel: "科研工作台", reason: "研究问题成形后, 建议把思路铺成 DAG 画布" },
  { from: ["citation-verify", "structure"], to: "corpus", toLabel: "写作语料库", reason: "素材核对完毕, 可准备写作语料" },
  { from: ["corpus", "writing-out", "paper-outline"], to: "review-lab", toLabel: "审稿实验室", reason: "成稿后可先送审稿实验室自查" },
  { from: ["empirical-research"], to: "plot-agent", toLabel: "科研绘图", reason: "数据分析完成, 可生成论文图表" },
  { from: ["dag-workbench", "paper-outline", "editor"], to: "review-lab", toLabel: "审稿实验室", reason: "论文推进到一定阶段, 建议审稿闭环" },
  { from: ["review-lab", "plot-agent"], to: "editor", toLabel: "学术编辑器", reason: "审稿/图表就绪, 回到编辑器定稿" },
];

const VIEW_LABELS: Record<string, string> = {
  reason: "推理工作台", ask: "Ask 检索", dag_workbench: "科研工作台", literature: "文献库",
  "plot-agent": "科研绘图", "review-lab": "审稿实验室", editor: "学术编辑器", corpus: "写作语料库",
  "paper-outline": "论文写作台", "empirical-research": "实证研究", "citation-verify": "引文核验",
  structure: "结构解析", sciverse: "外部检索", imports: "文献管理",
};

interface NavOption { view: string; label: string; reason: string; go: (v: string) => void; }

export function FloatingAssistantFAB({ workspaceView, onNavigate }: { workspaceView: string; onNavigate: (view: string) => void }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  // UI审计T1: DOM 可执行动作探测(data-control 埋点)
  const [controls, setControls] = useState<Array<{ id: string; text: string; disabled: boolean }>>([]);

  // 扫描当前页面 [data-control] 按钮 → 助手展示可"直接执行"动作
  const scanControls = () => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-control]"));
    const list = els.map((el) => ({
      id: el.getAttribute("data-control") ?? "",
      text: (el.textContent ?? "").trim().slice(0, 24),
      disabled: (el as HTMLButtonElement).disabled ?? false,
    })).filter((c) => c.id && !c.disabled);
    setControls(list);
  };
  const [tip, setTip] = useState<NavOption | null>(null);
  const [tasks, setTasks] = useState<Array<{ id: string; title: string; kind: string; status: string }>>([]);
  const [checkin, setCheckin] = useState<{ signedToday: boolean; reward: number } | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const openedRef = useRef(false);

  // 页面观察: 记录访问历史
  useEffect(() => {
    if (!workspaceView || workspaceView === "home" || workspaceView === "settings") return;
    setHistory((h) => {
      const next = [workspaceView, ...h.filter((x) => x !== workspaceView)].slice(0, 8);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
    // 命中推荐规则(最近访问过 from 之一 且 没在 to)
    const rule = NEXT_STEP_RULES.find((r) => r.from.includes(workspaceView) && workspaceView !== r.to);
    setTip(rule ? { view: rule.to, label: rule.toLabel, reason: rule.reason, go: onNavigate } : null);
    setTimeout(scanControls, 500); // 页面渲染后扫可执行控件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceView]);

  // 任务推荐聚合(research 流水线任务 + agent 任务)
  const loadTasks = async () => {
    setLoadingTasks(true);
    try {
      const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await fetch("/api/research/tasks?status=running,paused,failed", { headers });
      const d = await r.json().catch(() => ({ tasks: [] }));
      const list = (d.tasks ?? []).filter((t: { status: string }) => ["running", "paused", "failed"].includes(t.status));
      setTasks(list.slice(0, 3).map((t: { id: string; goal: string; status: string }) => ({
        id: t.id, title: t.goal?.slice(0, 40) || "科研任务", kind: "research", status: t.status,
      })));
    } catch { /* 静默: FAB 非关键路径 */ } finally { setLoadingTasks(false); }
  };

  // 签到态(P0-8 points 接口就绪后返回真实数据; 当前探测, 404 静默)
  const loadCheckin = async () => {
    try {
      const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await fetch("/api/points/me", { headers });
      if (!r.ok) return;
      const d = await r.json();
      setCheckin({ signedToday: d.data?.signedToday ?? true, reward: d.data?.rewardPoints ?? 20 });
    } catch { /* 接口未就绪(P0-8)前静默 */ }
  };

  useEffect(() => {
    const h = localStorage.getItem(HISTORY_KEY);
    if (h) { try { setHistory(JSON.parse(h)); } catch { /* ignore */ } }
    void loadCheckin();
  }, []);

  const doCheckin = async () => {
    try {
      const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
      const r = await fetch("/api/points/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: "{}",
      });
      if (r.ok) setCheckin({ signedToday: true, reward: checkin?.reward ?? 20 });
    } catch { /* 静默 */ }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !openedRef.current) {
      openedRef.current = true;
      void loadTasks();
      scanControls();
      localStorage.setItem(TIP_KEY, String(Date.now()));
    } else if (next) {
      scanControls();
    }
  };

  const hour = new Date().getHours();
  const greeting = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  const currentLabel = VIEW_LABELS[workspaceView] ?? "工作台";

  return (
    <div className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-2">
      {open && (
        <div className="w-80 overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-900/95 shadow-2xl backdrop-blur">
          {/* 头 */}
          <div className="flex items-center justify-between border-b border-slate-700/50 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Bird className="h-4 w-4 text-cyan-400" />
              <span className="text-xs font-semibold text-slate-200">科研助手 · {greeting}</span>
            </div>
            <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-300"><X className="h-4 w-4" /></button>
          </div>

          <div className="max-h-96 space-y-2 overflow-y-auto p-3">
            {/* 当前页 */}
            <div className="rounded-lg bg-slate-800/60 px-2.5 py-2 text-[11px] text-slate-300">
              当前在 <span className="font-medium text-cyan-300">{currentLabel}</span>
            </div>

            {/* 签到卡(P0-8 接口就绪后自动启用) */}
            {checkin && !checkin.signedToday && (
              <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
                <div className="text-[11px] text-amber-200">
                  <p className="flex items-center gap-1 font-medium"><Coffee className="h-3 w-3" /> 今日签到</p>
                  <p className="text-[9px] text-amber-200/60">签到得 {checkin.reward} 积分</p>
                </div>
                <button onClick={() => void doCheckin()} className="rounded-lg bg-amber-600 px-2.5 py-1 text-[11px] text-white hover:bg-amber-500">签到</button>
              </div>
            )}

            {/* 导航引导 */}
            {tip && (
              <button onClick={() => { onNavigate(tip.view); setOpen(false); }}
                className="flex w-full items-center justify-between rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-2.5 py-2 text-left transition hover:bg-cyan-500/10">
                <div>
                  <p className="flex items-center gap-1 text-[11px] font-medium text-cyan-200"><Compass className="h-3 w-3" /> 建议下一步: {tip.label}</p>
                  <p className="mt-0.5 text-[10px] text-slate-400">{tip.reason}</p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-cyan-500" />
              </button>
            )}

            {/* UI审计T1: 页面可执行动作(直接点击执行) */}
            {controls.length > 0 && (
              <div>
                <p className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">当前页面可执行</p>
                <div className="space-y-1">
                  {controls.slice(0, 4).map((c) => (
                    <button key={c.id} onClick={() => {
                      const el = document.querySelector(`[data-control="${c.id}"]`) as HTMLButtonElement | null;
                      el?.click();
                      setOpen(false);
                    }}
                      className="flex w-full items-center justify-between rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-2.5 py-1.5 text-left hover:bg-cyan-500/10">
                      <span className="text-[11px] text-cyan-200">▶ {c.text || c.id}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 任务推荐 */}
            <div>
              <p className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">待推进任务</p>
              {loadingTasks && <p className="px-1 text-[10px] text-slate-600"><Loader2 className="mr-1 inline h-2.5 w-2.5 animate-spin" />加载中</p>}
              {!loadingTasks && tasks.length === 0 && (
                <p className="rounded-lg bg-slate-800/40 px-2.5 py-2 text-[10px] text-slate-500">
                  {checkin === null ? "暂无进行中任务" : "没有进行中的任务, 去科研工作台开一个新项目吧"}
                </p>
              )}
              {tasks.map((t) => (
                <div key={t.id} className="mb-1 flex items-center justify-between rounded-lg bg-slate-800/60 px-2.5 py-1.5">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] text-slate-300">{t.title}</p>
                    <p className="text-[9px] text-slate-500">
                      {t.status === "failed" ? <span className="text-red-400">执行失败 · 可重试</span> : t.status === "running" ? <span className="text-amber-400">执行中</span> : <span className="text-sky-400">已暂停</span>}
                    </p>
                  </div>
                  {t.status === "failed" && (
                    <button onClick={() => { onNavigate("dag-workbench"); setOpen(false); }} className="rounded bg-slate-700 px-1.5 py-0.5 text-[9px] text-slate-200 hover:bg-slate-600">处理</button>
                  )}
                </div>
              ))}
            </div>

            {/* 访问足迹 */}
            {history.length > 1 && (
              <div className="pt-1">
                <p className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">最近足迹</p>
                <div className="flex flex-wrap gap-1">
                  {history.slice(1, 5).map((v) => (
                    <button key={v} onClick={() => { onNavigate(v); setOpen(false); }}
                      className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400 hover:bg-slate-700 hover:text-slate-200">
                      {VIEW_LABELS[v] ?? v}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* FAB */}
      <button onClick={toggle}
        className="flex items-center gap-1.5 rounded-full border border-slate-600/50 bg-slate-900/90 px-3.5 py-2 text-xs text-slate-200 shadow-xl backdrop-blur transition hover:bg-slate-800">
        {open ? <X className="h-4 w-4" /> : <Sparkles className="h-4 w-4 text-cyan-400" />}
        {open ? "收起" : "科研助手"}
      </button>
    </div>
  );
}
