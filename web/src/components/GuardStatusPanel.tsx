// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// GuardStatusPanel.tsx — V404-29: 运行时防护状态页
// 展示各防护(进度哨兵/复读检测/注入闸/规则摘要/整树终止/代码页解码)的开关/命中计数/最近事件 + 子进程树
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";

interface GuardItem { id: string; label: string; desc: string; enabled: boolean; hits: number; lastHitAt?: number }
interface GuardEventItem { guard: string; action: string; detail: string; ts: number }
interface SubProc { id: string; label: string; runningMs: number; alive: boolean }

interface GuardStatus {
  guards: GuardItem[];
  recent: GuardEventItem[];
  subprocesses: SubProc[];
}

const GUARD_COLOR: Record<string, string> = {
  h1_progress: "text-blue-300 bg-blue-400/10",
  h2_repetition: "text-purple-300 bg-purple-400/10",
  h7_injection: "text-red-300 bg-red-400/10",
  m2_summary: "text-teal-300 bg-teal-400/10",
  h3_killtree: "text-orange-300 bg-orange-400/10",
  h4_decode: "text-emerald-300 bg-emerald-400/10",
};

// V404-32: 演示数据(展示界面形态, 不连后端)
const DEMO_GUARDS: GuardStatus = {
  guards: [
    { id: "h1_progress", label: "进度哨兵", desc: "连续只读检索无产出/重复工具错误 → 告警(observe-first)", enabled: true, hits: 3, lastHitAt: Date.now() - 4 * 60000 },
    { id: "h2_repetition", label: "复读检测", desc: "流式输出周期相似度 ≥0.985 且重复 ≥8 → 判复读", enabled: true, hits: 1, lastHitAt: Date.now() - 9 * 60000 },
    { id: "h7_injection", label: "注入闸", desc: "执行类工具参数含伪工具调用/破坏指令 → 拒绝", enabled: true, hits: 7, lastHitAt: Date.now() - 1 * 60000 },
    { id: "m2_summary", label: "规则摘要", desc: "长列表输出 → 计数+head/tail 紧凑视图(细节走取回)", enabled: true, hits: 14, lastHitAt: Date.now() - 2 * 60000 },
    { id: "h3_killtree", label: "整树终止", desc: "子进程超时/关闭 → taskkill /T 整树清理(防孤儿)", enabled: true, hits: 2, lastHitAt: Date.now() - 30 * 60000 },
    { id: "h4_decode", label: "代码页解码", desc: "子进程输出 UTF-8 误读 → CP936 等回退", enabled: true, hits: 5, lastHitAt: Date.now() - 12 * 60000 },
  ],
  recent: [
    { guard: "h7_injection", action: "block", detail: "工具 run_code 参数 code 疑似指令注入 — 已拒绝执行", ts: Date.now() - 1 * 60000 },
    { guard: "m2_summary", action: "summary", detail: "工具 file_list 列表输出 18432 字符 → 规则摘要(42 条目)", ts: Date.now() - 2 * 60000 },
    { guard: "h1_progress", action: "warn", detail: "连续 8 轮只读检索无产出(可能空转) — sag_retrieve", ts: Date.now() - 4 * 60000 },
    { guard: "h2_repetition", action: "warn", detail: "流式输出复读检出(相似度 0.99, 重复 12 周期)", ts: Date.now() - 9 * 60000 },
    { guard: "h4_decode", action: "warn", detail: "子进程输出按 gbk 解码(UTF-8 误读 17 处)", ts: Date.now() - 12 * 60000 },
    { guard: "h3_killtree", action: "kill", detail: "子进程 python-data-8a3f 超时整树终止", ts: Date.now() - 30 * 60000 },
  ],
  subprocesses: [
    { id: "proc-1", label: "python-analyze-7c2e", runningMs: 42000, alive: true },
    { id: "proc-2", label: "edge-headless-search", runningMs: 3100, alive: true },
  ],
};

export function GuardStatusPanel() {
  const [data, setData] = useState<GuardStatus | null>(null);
  const [err, setErr] = useState("");
  const [demoOn, setDemoOn] = useState(false);
  // V404-30: 持久化审计(跨重启)
  const [audit, setAudit] = useState<{ events: Array<{ guard: string; action: string; detail: string; createdAt: string }>; counts: Array<{ guard: string; count: number }> } | null>(null);
  const [showAudit, setShowAudit] = useState(false);

  const loadAudit = async () => {
    try {
      const j = await fetch("/api/agent/guards/events?limit=50&days=7").then((r) => r.json());
      setAudit({ events: j.events || [], counts: j.counts || [] });
      setShowAudit(true);
    } catch { /* ignore */ }
  };

  const load = useCallback(async () => {
    if (demoOn) { setData(DEMO_GUARDS); setErr(""); return; }
    try {
      const j = await fetch("/api/agent/runtime-status").then((r) => r.json());
      setData(j.guards || null);
      setErr("");
    } catch (e: any) { setErr(String(e?.message || e)); }
  }, [demoOn]);

  const toggleDemo = () => { setDemoOn((v) => !v); };

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border border-sky-400/20 bg-sky-400/[0.04] p-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-sky-300" />
          <span className="text-[13px] font-semibold text-foreground">运行时防护状态</span>
          <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-[9px] text-sky-300">OpenSquilla 引擎防护 · 观察与拦截实时计数</span>
          <button type="button" onClick={() => { void loadAudit(); }} className="ml-auto rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/40">
            📋 审计(持久化)
          </button>
          <button type="button" onClick={() => { toggleDemo(); void load(); }} className="rounded border border-amber-400/40 px-1.5 py-0.5 text-[10px] text-amber-300 hover:bg-amber-400/10">
            {demoOn ? "退出演示" : "🎬 演示数据"}
          </button>
          <button type="button" onClick={() => void load()} className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/40">
            <RefreshCw className="mr-0.5 inline h-2.5 w-2.5" />刷新
          </button>
        </div>
        {err && <p className="mt-1 text-[10px] text-red-300">{err}</p>}
        {!data && !err && <p className="mt-1 text-[10px] text-muted-foreground">加载中…(运行一次 agent 任务后可见命中计数)</p>}
      </div>

      {data && (
        <>
          {/* 防护清单 */}
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {data.guards.map((g) => (
              <div key={g.id} className="rounded-lg border border-border/60 bg-card p-2.5">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[9px] ${GUARD_COLOR[g.id] || "text-muted-foreground bg-muted"}`}>{g.label}</span>
                  <span className={`h-1.5 w-1.5 rounded-full ${g.enabled ? "bg-emerald-500" : "bg-slate-500"}`} title={g.enabled ? "启用" : "停用"} />
                  <span className="ml-auto text-[15px] font-semibold text-foreground">{g.hits}</span>
                  <span className="text-[9px] text-muted-foreground">次命中</span>
                </div>
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{g.desc}</p>
                {g.lastHitAt && <p className="mt-0.5 text-[9px] text-muted-foreground/60">最近: {new Date(g.lastHitAt).toLocaleTimeString("zh-CN")}</p>}
              </div>
            ))}
          </div>

          {/* 最近事件 */}
          <div className="rounded-lg border border-border/60 bg-card p-3">
            <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">最近拦截/告警事件({data.recent.length})</div>
            {data.recent.length === 0
              ? <p className="text-[10px] text-muted-foreground">暂无事件 — 运行 agent 任务后, 防护触发的拦截/摘要/告警会实时出现在这里</p>
              : <div className="max-h-48 space-y-0.5 overflow-y-auto">
                {data.recent.map((e, i) => (
                  <div key={i} className="flex items-start gap-1.5 rounded px-1.5 py-1 text-[10px] hover:bg-accent/20">
                    <span className={`mt-0.5 shrink-0 rounded px-1 text-[9px] ${GUARD_COLOR[e.guard] || ""}`}>{e.guard}</span>
                    <span className={`shrink-0 rounded px-1 text-[9px] ${e.action === "block" ? "bg-red-400/15 text-red-300" : e.action === "kill" ? "bg-orange-400/15 text-orange-300" : e.action === "summary" ? "bg-teal-400/15 text-teal-300" : "bg-amber-400/15 text-amber-200"}`}>{e.action}</span>
                    <span className="min-w-0 flex-1 text-muted-foreground">{e.detail}</span>
                    <span className="shrink-0 text-[9px] text-muted-foreground/40">{new Date(e.ts).toLocaleTimeString("zh-CN")}</span>
                  </div>
                ))}
              </div>}
          </div>

          {/* 子进程树 */}
          <div className="rounded-lg border border-border/60 bg-card p-3">
            <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">活动子进程({data.subprocesses.length} — 超时/关闭将整树终止)</div>
            {data.subprocesses.length === 0
              ? <p className="text-[10px] text-muted-foreground">无活动子进程</p>
              : <div className="space-y-0.5">
                {data.subprocesses.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 rounded border border-border/40 px-2 py-1 text-[10px]">
                    <span className={`h-1.5 w-1.5 rounded-full ${p.alive ? "bg-emerald-500" : "bg-red-500"}`} />
                    <span className="font-mono text-foreground">{p.label}</span>
                    <span className="ml-auto text-muted-foreground">{(p.runningMs / 1000).toFixed(0)}s</span>
                  </div>
                ))}
              </div>}
          </div>
        </>
      )}

      {showAudit && (
        <div className="rounded-lg border border-border/60 bg-card p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="text-[11px] font-semibold text-muted-foreground">防护审计(7 天持久化 — 跨重启可查)</div>
            {audit?.counts.map((c) => (
              <span key={c.guard} className={`rounded px-1.5 py-0.5 text-[9px] ${GUARD_COLOR[c.guard] || "text-muted-foreground bg-muted"}`}>{c.guard} ×{c.count}</span>
            ))}
            {(!audit || audit.counts.length === 0) && <span className="text-[9px] text-muted-foreground">暂无持久化事件</span>}
          </div>
          {audit && audit.events.length > 0 && (
            <div className="max-h-64 space-y-0.5 overflow-y-auto">
              {audit.events.map((e, i) => (
                <div key={i} className="flex items-start gap-1.5 rounded px-1.5 py-1 text-[10px] hover:bg-accent/20">
                  <span className={`mt-0.5 shrink-0 rounded px-1 text-[9px] ${GUARD_COLOR[e.guard] || ""}`}>{e.guard}</span>
                  <span className={`shrink-0 rounded px-1 text-[9px] ${e.action === "block" ? "bg-red-400/15 text-red-300" : e.action === "kill" ? "bg-orange-400/15 text-orange-300" : "bg-amber-400/15 text-amber-200"}`}>{e.action}</span>
                  <span className="min-w-0 flex-1 text-muted-foreground">{e.detail}</span>
                  <span className="shrink-0 text-[9px] text-muted-foreground/40">{e.createdAt?.slice(5, 19).replace("T", " ")}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
