// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// RoutingDiagPanel.tsx — V404-11: 路由诊断面(差距文档⑤)
// 每轮可见: 档位分布/模型成功率/低估 flagged/平均耗时/最近决策明细 — observe-only 灰度
import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw, TrendingDown, Zap } from "lucide-react";

interface DiagModel { model: string; tier: string; decisions: number; ok: number; fail: number; avgMs: number; underestimates: number; flagged: boolean }
interface DiagRecent { ts: string; model: string; tier: string; role: string; ok: boolean; errorType: string | null; ms: number; purpose: string | null }
interface Diag { total: number; okRate: number; byTier: Array<{ tier: string; decisions: number; okRate: number; avgMs: number }>; byModel: DiagModel[]; recent: DiagRecent[]; savingsHint: string; sizeBytes: number }

const TIER_COLOR: Record<string, string> = {
  cheap: "text-emerald-300 bg-emerald-400/10",
  standard: "text-sky-300 bg-sky-400/10",
  strong: "text-purple-300 bg-purple-400/10",
  other: "text-muted-foreground bg-muted",
};

export function RoutingDiagPanel() {
  const [diag, setDiag] = useState<Diag | null>(null);
  const [circuits, setCircuits] = useState<Record<string, any>>({});
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await fetch("/api/llm/routing-diagnostics").then((r) => r.json());
      setDiag(d.diag || null);
      const c = await fetch("/api/llm/circuit-state").then((r) => r.json());
      setCircuits(c.circuits || {});
      setErr("");
    } catch (e) { setErr(String(e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const flagged = (diag?.byModel || []).filter((m) => m.flagged);

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border border-sky-400/20 bg-sky-400/[0.04] p-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-sky-300" />
          <span className="text-[13px] font-semibold text-foreground">路由诊断面</span>
          <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-[9px] text-sky-300">观察模式 · 不自动改路由</span>
          <button type="button" onClick={() => void load()} className="ml-auto rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/40">
            <RefreshCw className="mr-0.5 inline h-2.5 w-2.5" />刷新
          </button>
        </div>
        {err && <p className="mt-1 text-[10px] text-red-300">{err}</p>}
        {diag && (
          <>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {diag.savingsHint || "暂无决策数据"}
            </p>
            <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
              <span className="text-muted-foreground">决策 <b className="text-foreground">{diag.total}</b></span>
              <span className="text-muted-foreground">成功率 <b className="text-foreground">{diag.okRate}%</b></span>
              <span className="text-muted-foreground">日志 <b className="font-mono text-foreground">{(diag.sizeBytes / 1024).toFixed(1)}KB</b></span>
              {flagged.length > 0 && (
                <span className="inline-flex items-center gap-1 text-amber-300">
                  <TrendingDown className="h-3 w-3" /> 建议降权: {flagged.map((f) => f.model).join(", ")}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* 档位分布 */}
      {diag && diag.byTier.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card p-3">
          <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">档位分布(近 500 决策)</div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {diag.byTier.map((t) => (
              <div key={t.tier} className="rounded-md border border-border/50 px-2 py-1.5">
                <span className={`rounded px-1 py-0.5 text-[9px] ${TIER_COLOR[t.tier] || "text-muted-foreground bg-muted"}`}>{t.tier}</span>
                <div className="mt-1 text-lg font-semibold text-foreground">{t.decisions}</div>
                <div className="text-[9px] text-muted-foreground">成功率 {t.okRate}% · 均 {t.avgMs}ms</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 按模型聚合 */}
      {diag && diag.byModel.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card p-3">
          <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">按模型(成功率/耗时/低估样本)</div>
          <div className="space-y-1">
            {diag.byModel.map((m) => (
              <div key={m.model} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-[11px] ${m.flagged ? "border-amber-400/40 bg-amber-400/5" : "border-border/40"}`}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${m.fail > 0 ? "bg-amber-400" : "bg-emerald-500"}`} />
                <span className="w-44 min-w-0 truncate font-mono text-foreground">{m.model}</span>
                <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] ${TIER_COLOR[m.tier] || ""}`}>{m.tier}</span>
                <span className="ml-auto text-muted-foreground">{m.decisions} 决策 · {Math.round((m.ok / Math.max(1, m.decisions)) * 100)}% 成功 · {m.avgMs}ms</span>
                {m.underestimates > 0 && (
                  <span className="shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] text-amber-300" title="用户负评且当时用了便宜档">低估×{m.underestimates}</span>
                )}
                {m.flagged && <Zap className="h-3 w-3 shrink-0 text-amber-300" />}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 最近决策明细 */}
      {diag && diag.recent.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card p-3">
          <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">最近决策明细</div>
          <div className="max-h-56 space-y-0.5 overflow-y-auto font-mono text-[9px] text-muted-foreground">
            {diag.recent.map((r, i) => (
              <div key={i} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-accent/20">
                <span className={r.ok ? "text-emerald-400" : "text-red-400"}>{r.ok ? "✓" : "✗"}</span>
                <span className="text-foreground">{r.model}</span>
                <span className={`rounded px-0.5 ${TIER_COLOR[r.tier] || ""}`}>{r.tier}</span>
                <span className="text-muted-foreground/60">{r.role}</span>
                <span className="ml-auto text-muted-foreground/50">{r.errorType || `${r.ms}ms`}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 熔断状态 */}
      {Object.keys(circuits).length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card p-3">
          <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">路由熔断(连续失败≥3 → 60s 冷却)</div>
          <div className="space-y-1">
            {Object.entries(circuits).map(([model, c]: [string, any]) => (
              <div key={model} className="flex items-center gap-2 rounded-md border border-border/40 px-2 py-1 text-[10px]">
                <span className={`h-2 w-2 rounded-full ${c.open ? "bg-red-500" : c.failures > 0 ? "bg-amber-400" : "bg-emerald-500"}`} />
                <span className="font-mono text-foreground">{model}</span>
                <span className="ml-auto text-muted-foreground">{c.open ? "熔断中" : `失败 ${c.failures} 次`}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
