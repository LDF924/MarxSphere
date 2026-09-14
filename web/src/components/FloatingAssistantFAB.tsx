// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// FloatingAssistantFAB.tsx — SocialSci P0-7: 悬浮助手(深水区体验件)
// 形态对齐(闭源产品交互语义, 原创实现): 全局悬浮在场 UI(非对话框唤起式)
//   ①页面观察+导航引导: 记录访问历史 → 按"科研推进"规则推荐下一步
//   ②任务推荐: 聚合 research 流水线任务 + agent 任务, 推荐"继续/恢复"
//   ③签到卡: P0-8 points 接口就绪后接入(点位已留: loadCheckin + 签到按钮)
import { useEffect, useMemo, useRef, useState } from "react";
import { Bird, CheckCircle2, ChevronRight, Coffee, Compass, GitBranch, GripVertical, Loader2, Sparkles, X } from "lucide-react";
import { contextOf } from "../lib/workbenchContext";

function cn(...xs: Array<string | false | undefined>) { return xs.filter(Boolean).join(" "); }

const HISTORY_KEY = "marx:assistant:viewhistory:v1";
const TIP_KEY = "marx:assistant:tiptime:v1";
/** V415: 悬浮助手的位置(用户拖过就记在这里) */
const POS_KEY = "marx:assistant:pos:v1";

/**
 * V415(2026-09-13 用户反馈): 助手原来钉死在右下角(fixed bottom-5 right-5), 挡着内容也挪不开。
 * 改成可拖动 + 位置记忆; 默认仍在右下角(首次使用与旧观感一致)。
 * 位置按视口坐标存, 挂载时算出"贴右下角"的坐标作为默认值。
 */
function defaultPos(): { x: number; y: number } {
  const w = typeof window === "undefined" ? 1200 : window.innerWidth;
  const h = typeof window === "undefined" ? 800 : window.innerHeight;
  return { x: Math.max(8, w - 220), y: Math.max(8, h - 120) };
}

/** 页面观察 → 导航推荐规则表(科研推进主线; 纯前端, 不埋点) */
const NEXT_STEP_RULES: Array<{ from: string[]; to: string; reason: string }> = [
  { from: ["literature", "sciverse", "imports"], to: "citation-verify", reason: "文献检索后建议核验引用, 保证证据可信" },
  { from: ["ask", "reason"], to: "dag-workbench", reason: "研究问题成形后, 建议把思路铺成 DAG 画布" },
  { from: ["citation-verify", "structure"], to: "corpus", reason: "素材核对完毕, 可准备写作语料" },
  { from: ["corpus", "paper-outline"], to: "review-lab", reason: "成稿后可先送审稿实验室自查" },
  { from: ["empirical-research"], to: "plot-agent", reason: "数据分析完成, 可生成论文图表" },
  { from: ["dag-workbench", "paper-outline", "editor"], to: "review-lab", reason: "论文推进到一定阶段, 建议审稿闭环" },
  { from: ["review-lab", "plot-agent"], to: "editor", reason: "审稿/图表就绪, 回到编辑器定稿" },
];

/** 子应用最近一次上报的动作: 窗口 → 动作表(见 soc 的 actions-bridge.ts) */
const iframeActions = new Map<Window, Array<{ id: string; text: string }>>();

/** DOM 里的动作: 带上 nth —— 同一个 data-control 往往有多个(每章节/每场景一个), 只记 id 会点错 */
interface DomAction { id: string; text: string; disabled: boolean; nth: number }

interface NavOption { view: string; label: string; reason: string; go: (v: string) => void; }

/**
 * 把 iframe 上报的动作取出来 —— 编排/评审/绘图/编辑器四个工作室都是 iframe 里的 Vue,
 * 外壳的 document.querySelector 看不到它们的 DOM, 只能靠 postMessage 上报(见 actions-bridge.ts)。
 */
function collectIframeActions(): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  for (const acts of iframeActions.values()) out.push(...acts);
  return out;
}

/**
 * 找出文档里第 nth 个匹配 `[data-control="id"]` 的**可见**元素。
 * 为什么不用 querySelector: 一个 id 常对应多个按钮(如文献库每个章节一个 docs:nav),
 * querySelector 永远返回第一个 —— 用户点"第 3 个章节"实际会跳去第 1 个。
 */
function pickControl(id: string, nth: number): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-control="${id}"]`)).filter((e) => e.offsetParent);
  return all[nth] ?? all[0] ?? null;
}

export function FloatingAssistantFAB({ workspaceView, onNavigate }: { workspaceView: string; onNavigate: (view: string) => void }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  // UI审计T1: DOM 可执行动作探测(data-control 埋点)
  const [controls, setControls] = useState<DomAction[]>([]);

  // 扫描当前页面 [data-control] 按钮 → 助手展示可"直接执行"动作。
  // 两个坑: ① iframe 里的 Vue 子应用查不到(contentDocument 是另一个文档), 那部分由
  // soc 侧 postMessage 上报(见 actions-bridge.ts), 这里合并两处结果;
  // ② 页面内部切 tab 不会触发 workspaceView 变化, 只在切换视图时扫一次会漏掉后来才渲染的按钮,
  // 所以 scanControls 也挂到了 open 时机与慢扫定时器上。
  const scanControls = () => {
    // 按 id 去重: 同一个 id 常对应多个按钮(每章节/每场景一个), 列表里只需出现一次。
    // 必须按**全部实例**数 nth(含隐藏的), 因为点击时用的也是全量列表的下标, 两边要一致;
    // 但只把第一个可见且可用的那个放出来。
    const seen = new Set<string>();
    const dom: DomAction[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-control]"))) {
      const id = el.getAttribute("data-control") ?? "";
      const text = (el.textContent ?? "").trim().slice(0, 24);
      if (!id || !text || seen.has(id)) continue;
      seen.add(id);
      if ((el as HTMLButtonElement).disabled || !el.offsetParent) continue;
      dom.push({ id, text, disabled: false, nth: 0 });
    }
    const merged = [...collectIframeActions().map((a) => ({ ...a, disabled: false, nth: 0 })), ...dom];
    setControls(merged.slice(0, 8));
  };
  const [tip, setTip] = useState<NavOption | null>(null);
  const [tasks, setTasks] = useState<Array<{ id: string; title: string; kind: string; status: string }>>([]);
  const [checkin, setCheckin] = useState<{ signedToday: boolean; reward: number } | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const openedRef = useRef(false);

  // 当前页上下文: 名称/说明/流程链全部来自共享表 workbenchContext(V416), 本组件不再自带一份
  const ctx = useMemo(() => contextOf(workspaceView), [workspaceView]);

  // 流程链: 当前页有 steps 才显示; 第几步按当前视图在链中的位置推
  const flowCtx = useMemo(() => {
    const steps = ctx.steps;
    if (!steps?.length) return null;
    const me = steps.findIndex((s) => (s.to ?? workspaceView) === workspaceView);
    return {
      step: me < 0 ? 0 : me,
      steps,
      jump: (key: string) => {
        const s = steps.find((x) => x.key === key);
        const view = s?.to ?? workspaceView;   // 未标 to = 就在本页完成, 不用跳
        if (view !== workspaceView) { onNavigate(view); return true; }
        return false; // 同视图内步骤 → 保持打开, 用户已在
      },
    };
  }, [workspaceView]); // eslint-disable-line react-hooks/exhaustive-deps

  // 收 iframe 上报的动作(soc 的 actions-bridge.ts 发 {source:"marxsphere-soc", type:"actions"})
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { source?: string; type?: string; actions?: Array<{ id: string; text: string }> } | null;
      if (d?.source !== "marxsphere-soc" || d.type !== "actions" || !Array.isArray(d.actions)) return;
      const src = e.source as Window | null;
      if (!src) return;
      iframeActions.set(src, d.actions);
      scanControls();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceView]);

  // 页面观察: 记录访问历史
  useEffect(() => {
    if (!workspaceView || workspaceView === "home" || workspaceView === "settings") return;
    setHistory((h) => {
      const next = [workspaceView, ...h.filter((x) => x !== workspaceView)].slice(0, 8);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
    // 命中推荐规则(最近访问过 from 之一 且 没在 to) —— 目标名现取共享表, 不再各写一份
    const rule = NEXT_STEP_RULES.find((r) => r.from.includes(workspaceView) && workspaceView !== r.to);
    setTip(rule ? { view: rule.to, label: contextOf(rule.to).label, reason: rule.reason, go: onNavigate } : null);
    // 页面渲染后才扫得到按钮; 之后再补扫几次 —— iframe 里的工作室(编排/评审/绘图/编辑器)
    // 挂载比 React 侧慢得多, 只扫一次会漏掉它们的动作。
    setControls([]);
    // 顺带主动问一遍 iframe(它们可能早已加载完、上报过但当时本组件还没挂监听)
    for (const f of Array.from(document.querySelectorAll("iframe"))) {
      try { (f as HTMLIFrameElement).contentWindow?.postMessage({ source: "marxsphere-workbench", type: "query-actions" }, "*"); } catch { /* 跨源忽略 */ }
    }
    const timers = [500, 1500, 3000].map((ms) => window.setTimeout(scanControls, ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
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

  // ── 拖动(见文件头 V415 说明) ──
  // V416(2026-09-14 用户反馈"拖起来卡、滞后"): 原来每个 pointermove 都 setPos ——
  // 真鼠标每秒报 125~1000 次, 而屏幕每秒只画 60 帧, 于是**一帧内白渲染 N 次**;
  // 主线程一忙(画布/轮询/iframe 里的 Vue), 指针就走在了元素前面, 手感是"黏、滞后"。
  // 两处改:
  //   ① 事件先攒着, 用 rAF 合并成**每帧最多一次** setState;
  //   ② 定位从 left/top 换成 transform: translate3d —— 只走合成层, 不触发布局。
  // 拖动期间仍然以 state 为准(不直接写 DOM), 避免别处的重渲染把面板拉回旧位置。
  const [pos, setPos] = useState<{ x: number; y: number }>(defaultPos);
  const posRef = useRef(pos);
  const [dragging, setDragging] = useState(false);
  // 拖完那一下 pointerup 之后浏览器还会补一个 click。位移超阈值就吞掉它,
  // 否则"拖到别处"会顺带把面板开/关一次(实测: 拖完按钮文案变成"收起")。
  const suppressClickRef = useRef(false);

  useEffect(() => { posRef.current = pos; }, [pos]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as { x: number; y: number };
      if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) setPos(p);
    } catch { /* 坏数据就当没存过 */ }
  }, []);

  // 缩窗/转屏后把助手拉回视口内, 否则它会停在外面再也抓不着
  useEffect(() => {
    const onResize = () => {
      const cur = posRef.current;
      const x = Math.min(Math.max(0, window.innerWidth - 80), Math.max(0, cur.x));
      const y = Math.min(Math.max(0, window.innerHeight - 50), Math.max(0, cur.y));
      if (x !== cur.x || y !== cur.y) setPos({ x, y });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    // 触摸有隐式指针捕获: 不显式捕获的话后续 pointermove 收不到
    try { target.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    const sx = e.clientX, sy = e.clientY;
    const from = { ...posRef.current };
    setDragging(true);

    let last = { x: from.x, y: from.y };
    let raf = 0;
    let moved = false;
    const flush = () => {
      raf = 0;
      if (last.x !== posRef.current.x || last.y !== posRef.current.y) setPos(last);
    };
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - sx) > 3 || Math.abs(ev.clientY - sy) > 3) moved = true;
      // 夹在视口内 —— 拖出去就再也抓不回来了
      last = {
        x: Math.min(Math.max(0, window.innerWidth - 80), Math.max(0, from.x + ev.clientX - sx)),
        y: Math.min(Math.max(0, window.innerHeight - 50), Math.max(0, from.y + ev.clientY - sy)),
      };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const up = () => {
      if (raf) { cancelAnimationFrame(raf); flush(); }
      setDragging(false);
      suppressClickRef.current = moved;
      try { localStorage.setItem(POS_KEY, JSON.stringify(last)); } catch { /* 忽略 */ }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div className="fixed z-40 flex flex-col items-end gap-2"
      style={{ left: 0, top: 0, transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}>
      {open && (
        <div className="w-80 overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-900/95 shadow-2xl backdrop-blur">
          {/* 头(拖动把手: 按住空白处移动, 双击复位) */}
          <div
            className="flex items-center justify-between border-b border-slate-700/50 px-3 py-2.5"
            style={{ cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}
            onPointerDown={startDrag}
            onDoubleClick={() => { const d = defaultPos(); setPos(d); try { localStorage.removeItem(POS_KEY); } catch { /* 忽略 */ } }}
            title="按住拖动 · 双击复位"
          >
            <div className="flex items-center gap-2">
              <GripVertical className="h-3.5 w-3.5 text-slate-600" />
              <Bird className="h-4 w-4 text-cyan-400" />
              <span className="text-xs font-semibold text-slate-200">科研助手 · {greeting}</span>
            </div>
            <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-300"><X className="h-4 w-4" /></button>
          </div>

          <div className="max-h-96 space-y-2 overflow-y-auto p-3">
            {/* 当前页: 名称 + 这页是干什么的(V416 起说明来自共享表, 全站 48 个视图都有) */}
            <div className="rounded-lg bg-slate-800/60 px-2.5 py-2">
              <p className="text-[11px] text-slate-300">
                当前在 <span className="font-medium text-cyan-300">{ctx.label}</span>
              </p>
              <p className="mt-0.5 text-[10px] leading-snug text-slate-500">{ctx.hint}</p>
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

            {/* 当前页流程链(共享表里有 steps 才显示) */}
            {flowCtx && (
              <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-2">
                <p className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  <GitBranch className="h-3 w-3 text-cyan-400" />{ctx.label} · 流程
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

            {/* 当前页可执行动作(data-control 埋点; 没埋点的页面不显示这一栏, 而不是显示空标题) */}
            {controls.length > 0 && (
              <div>
                <p className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  当前页可执行 <span className="text-slate-600">({controls.length})</span>
                </p>
                <div className="space-y-1">
                  {controls.slice(0, 5).map((c) => (
                    <button key={c.id} onClick={() => {
                      // iframe 上报的动作 → postMessage 回传给 soc 执行; 本页 DOM 动作 → 点第 nth 个
                      let relayed = false;
                      for (const [win, acts] of iframeActions) {
                        if (!acts.some((a) => a.id === c.id)) continue;
                        try {
                          win.postMessage({ source: "marxsphere-workbench", type: "invoke-action", id: c.id }, "*");
                          relayed = true;
                        } catch { /* 跨源忽略 */ }
                        break;
                      }
                      if (!relayed) pickControl(c.id, c.nth)?.click();
                      setOpen(false);
                    }}
                      className="flex w-full items-center justify-between rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-2.5 py-1.5 text-left hover:bg-cyan-500/10">
                      <span className="truncate text-[11px] text-cyan-200">
                        {c.text.startsWith("▶") ? c.text : `▶ ${c.text}`}
                      </span>
                    </button>
                  ))}
                  {controls.length > 5 && (
                    <p className="px-1 text-[9px] text-slate-600">另有 {controls.length - 5} 个动作在页面上</p>
                  )}
                </div>
              </div>
            )}

            {/* 任务推荐 */}
            <div>
              <p className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">待推进任务</p>
              {loadingTasks && <p className="px-1 text-[10px] text-slate-600"><Loader2 className="mr-1 inline h-2.5 w-2.5 animate-spin" />加载中</p>}
              {!loadingTasks && tasks.length === 0 && (
                <p className="rounded-lg bg-slate-800/40 px-2.5 py-2 text-[10px] text-slate-500">
                  没有进行中的任务, 去科研工作台开一个新项目吧
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
                      {contextOf(v).label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* FAB(同样可拖: 展开时从面板头部拖, 收起时直接从这个按钮拖) */}
      <button
        onClick={() => { if (suppressClickRef.current) { suppressClickRef.current = false; return; } posRef.current = pos; toggle(); }}
        onPointerDown={(e) => { if (open) return; startDrag(e); }}
        onDragStart={(e) => e.preventDefault()}
        title={open ? undefined : "点击展开 · 按住可拖动"}
        className="flex items-center gap-1.5 rounded-full border border-slate-600/50 bg-slate-900/90 px-3.5 py-2 text-xs text-slate-200 shadow-xl backdrop-blur transition hover:bg-slate-800"
        style={{ cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}>
        {open ? <X className="h-4 w-4" /> : <Sparkles className="h-4 w-4 text-cyan-400" />}
        {open ? "收起" : "科研助手"}
      </button>
    </div>
  );
}
