// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// FloatingAssistantFAB.tsx — SocialSci P0-7: 悬浮助手(深水区体验件)
// 形态对齐(闭源产品交互语义, 原创实现): 全局悬浮在场 UI(非对话框唤起式)
//   ①页面观察+导航引导: 记录访问历史 → 按"科研推进"规则推荐下一步
//   ②任务推荐: 聚合 research 流水线任务 + agent 任务, 推荐"继续/恢复"
//   ③签到卡: P0-8 points 接口就绪后接入(点位已留: loadCheckin + 签到按钮)
import { useEffect, useMemo, useRef, useState } from "react";
import { Bird, CheckCircle2, ChevronRight, Coffee, Compass, GitBranch, Loader2, Sparkles, X } from "lucide-react";

function cn(...xs: Array<string | false | undefined>) { return xs.filter(Boolean).join(" "); }

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

// T4-3: 六模块步进引导(逆向闭源 FloatingAssistant 状态机, 原创实现)
// 每个模块 = 步骤链 {key,label,purpose,next}; 当前视图所在模块 → 展示分步+下一步推荐
const FLOW_STEPS: Record<string, Array<{ key: string; label: string; purpose: string; next: string }>> = {
  workflow: [
    { key: "input", label: "研究信息", purpose: "填写主题/方法/字数/目录", next: "sections" },
    { key: "sections", label: "科研架构", purpose: "确认结构/变量/章节指导", next: "materials" },
    { key: "materials", label: "素材准备", purpose: "生成/审视/编排素材", next: "workspace" },
    { key: "workspace", label: "正文创作", purpose: "逐章生成并核对正文", next: "finalize" },
    { key: "finalize", label: "合稿审阅", purpose: "合并/审阅/导出终稿", next: "complete" },
  ],
  statistics: [
    { key: "data_input", label: "数据输入", purpose: "选择或上传数据", next: "method_selection" },
    { key: "method_selection", label: "方法选择", purpose: "选统计方法与变量", next: "analysis_run" },
    { key: "analysis_run", label: "分析运行", purpose: "提交后台任务", next: "result_review" },
    { key: "result_review", label: "结果核对", purpose: "核对表格图形结论", next: "complete" },
  ],
  viz: [
    { key: "chart_input", label: "绘图输入", purpose: "描述图表与数据", next: "chart_generation" },
    { key: "chart_generation", label: "图表生成", purpose: "Agent 计算出图", next: "chart_review" },
    { key: "chart_review", label: "图表核对", purpose: "核对标注与规范", next: "export" },
    { key: "export", label: "图表导出", purpose: "导出或入素材库", next: "complete" },
  ],
  knowledge: [
    { key: "query_input", label: "检索输入", purpose: "填主题/变量/文献词", next: "search" },
    { key: "search", label: "执行检索", purpose: "四库检索跑任务", next: "evidence_review" },
    { key: "evidence_review", label: "证据核对", purpose: "核对结果相关性", next: "material_import" },
    { key: "material_import", label: "素材导入", purpose: "证据入素材库", next: "complete" },
  ],
  review: [
    { key: "document_input", label: "文稿输入", purpose: "打开或上传文稿", next: "review_setup" },
    { key: "review_setup", label: "审阅设置", purpose: "选期刊/标准/严格度", next: "review_run" },
    { key: "review_run", label: "审阅运行", purpose: "SSE 流式审稿", next: "suggestion_review" },
    { key: "suggestion_review", label: "建议核对", purpose: "查看并确认建议", next: "complete" },
  ],
  editor: [
    { key: "document_create", label: "文档创建", purpose: "新建或打开文档", next: "editing" },
    { key: "editing", label: "内容编辑", purpose: "AI 改写/检查/润色", next: "formatting" },
    { key: "formatting", label: "格式整理", purpose: "引用/标题/排版", next: "versioning" },
    { key: "versioning", label: "版本管理", purpose: "保存/回档版本", next: "complete" },
  ],
};
// 视图 → 模块 + 已做到第几步(按视图与状态粗判)
const VIEW_FLOW: Record<string, { mod: string; step: number }> = {
  "dag-workbench": { mod: "workflow", step: 0 },
  "paper-outline": { mod: "workflow", step: 3 },
  "review-lab": { mod: "review", step: 0 },
  "plot-agent": { mod: "viz", step: 0 },
  editor: { mod: "editor", step: 0 },
  ask: { mod: "knowledge", step: 0 },
  "empirical-research": { mod: "statistics", step: 0 },
};
const MODULE_LABEL: Record<string, string> = {
  workflow: "科研工作流", statistics: "数据分析", viz: "科研绘图",
  knowledge: "知识检索", review: "论文审阅", editor: "学术编辑",
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

  // T4-3: 推导当前模块步进上下文(视图→模块/步数; jump 映射流程步→实际视图)
  const flowCtx = useMemo(() => {
    const vf = VIEW_FLOW[workspaceView];
    if (!vf) return null;
    const steps = FLOW_STEPS[vf.mod];
    if (!steps) return null;
    // 步骤 key → 落地视图(模块各步大多同视图不同页签; 同视图内步骤跳转用第二步…第 N 步全落同视图 + 提示)
    const viewOfStep = (s: string): string => {
      if (vf.mod === "workflow") {
        if (s === "sections") return "dag-workbench";
        if (s === "workspace") return "dag-workbench";
        if (s === "materials") return "dag-workbench";
        if (s === "finalize") return "dag-workbench";
        return "dag-workbench";
      }
      if (vf.mod === "review") return "review-lab";
      if (vf.mod === "viz") return "plot-agent";
      if (vf.mod === "editor") return "editor";
      if (vf.mod === "knowledge") return "ask";
      if (vf.mod === "statistics") return "empirical-research";
      return "dag-workbench";
    };
    return {
      mod: vf.mod, step: vf.step, steps,
      jump: (key: string) => {
        const view = viewOfStep(key);
        if (view !== workspaceView) { onNavigate(view); return true; }
        return false; // 同视图内步骤 → 保持打开, 用户已在
      },
    };
  }, [workspaceView]); // eslint-disable-line react-hooks/exhaustive-deps

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

            {/* T4-3: 当前模块步进引导(闭源 FloatingAssistant 状态机对齐) */}
            {flowCtx && (
              <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-2">
                <p className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  <GitBranch className="h-3 w-3 text-cyan-400" />{MODULE_LABEL[flowCtx.mod]} · 步骤引导
                </p>
                <div className="space-y-0.5">
                  {flowCtx.steps.map((s, i) => {
                    const done = i < flowCtx.step;
                    const cur = i === flowCtx.step;
                    return (
                      <button key={s.key}
                        onClick={() => { if (flowCtx.jump?.(s.key)) setOpen(false); }}
                        className={cn("flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition", cur ? "bg-cyan-500/10" : "hover:bg-slate-700/40")}>
                        <span className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] font-bold",
                          done ? "bg-green-500/25 text-green-300" : cur ? "bg-cyan-500 text-white" : "bg-slate-700 text-slate-500")}>
                          {done ? "✓" : i + 1}
                        </span>
                        <span className={cn("text-[10px]", cur ? "font-semibold text-cyan-200" : done ? "text-slate-400" : "text-slate-500")}>{s.label}</span>
                        <span className="ml-auto hidden max-w-28 truncate text-[8px] text-slate-600 sm:inline">{s.purpose}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
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
