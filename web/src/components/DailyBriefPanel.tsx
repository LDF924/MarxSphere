// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// DailyBriefPanel.tsx — 每日简报(2026-10-04)
//
// ⚠ 界面本体**移植**自开源项目 观澜/Guanlan(MIT)的 `guanlan/daily_renderers.py` 与
//   `daily.py` 的 `format_daily_markdown` 章节结构; 判据与编排在
//   `src/services/daily-brief-service.ts`(同一份移植)。见 THIRD_PARTY_NOTICES.md 第 9 节。
//
// ═══ 界面上必须显式的三条 ═══
//   ① **来源层级徽标 A/B/C/D 逐条显示**, 且带那句"这类来源能证明什么"的边界 ——
//      把所有证据排成一个列表而不标层级, 是自动聚合最危险的失败模式。
//   ② **采编自检**放在正文之后: 先读判断, 再看"这份判断哪里不牢"。
//   ③ **「本期未见」不是「已消退」** —— 降温桶的措辞必须留余地, 那多半只是这期没抓到。
import { useEffect, useState } from "react";
import {
  Loader2, RefreshCw, Sun, AlertTriangle, ChevronRight, FileText, Copy, Check, CalendarDays,
} from "lucide-react";
import { cn } from "../lib/utils";
import { apiWeb } from "../lib/api";
import { PanelNotice, panelInputCls } from "./PanelShell";

type Brief = Awaited<ReturnType<typeof apiWeb.dailyBrief>>;

const TIER_CLS: Record<string, string> = {
  A: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  B: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  C: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  D: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

const RISK_CLS: Record<string, string> = {
  high: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  medium: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  low: "bg-muted text-muted-foreground border-border",
};

const HEALTH_CLS: Record<string, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  block: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

function TierBadge({ tier, label }: { tier: string; label?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px]", TIER_CLS[tier] ?? "bg-muted text-muted-foreground border-border")}>
      {label || tier}
    </span>
  );
}

export function DailyBriefPanel() {
  const [query, setQuery] = useState("");
  const [timeWindow, setTimeWindow] = useState<"today" | "24h" | "3d" | "7d">("3d");
  const [edition, setEdition] = useState<"research" | "policy" | "market" | "teaching">("research");
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [brief, setBrief] = useState<Brief | null>(null);
  const [history, setHistory] = useState<{ records: number; lastAt: string } | null>(null);
  const [copied, setCopied] = useState<"md" | "ctx" | "">("");

  useEffect(() => {
    void apiWeb.dailyHistory("", 14).then(setHistory).catch(() => { /* 历史查不到不影响生成 */ });
  }, [brief]);

  const run = async () => {
    setBusy(true); setErr("");
    try {
      const r = await apiWeb.dailyBrief({
        query: query.trim() || undefined,
        timeWindow, edition,
        limit: 12, overflowLimit: 20,
        // 离线模式只用本地归档 —— 舆情检索要打 28 个源, 热榜要打 4 个平台
        includeOpinion: !offline,
        includeHotboard: !offline,
        compareDays: 7,
        recordHistory: true,
      });
      setBrief(r);
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 240)); }
    finally { setBusy(false); }
  };

  const copy = async (which: "md" | "ctx") => {
    if (!brief) return;
    const text = which === "md" ? brief.markdown : brief.context;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(""), 1500);
    } catch { setErr("复制失败 —— 浏览器拒绝了剪贴板权限"); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Sun className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-medium">每日简报</span>
        <span className="text-xs text-muted-foreground">
          把舆情检索 / 热榜 / 本地归档合成一份<span className="text-foreground/80">带主线的当期判断</span> —— 不是结果列表
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
          placeholder="主题(留空=只看热榜与归档), 如: 农村土地流转"
          className={cn(panelInputCls, "min-w-[220px] flex-1")} data-control="daily:query" />
        <select value={timeWindow} onChange={(e) => setTimeWindow(e.target.value as never)} className={panelInputCls} data-control="daily:window">
          <option value="today">今天</option>
          <option value="24h">24 小时</option>
          <option value="3d">近 3 天</option>
          <option value="7d">近 7 天</option>
        </select>
        <select value={edition} onChange={(e) => setEdition(e.target.value as never)} className={panelInputCls} data-control="daily:edition">
          <option value="research">研究</option>
          <option value="policy">政策</option>
          <option value="market">市场</option>
          <option value="teaching">教学</option>
        </select>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title="只用本地归档, 不联网">
          <input type="checkbox" checked={offline} onChange={(e) => setOffline(e.target.checked)} data-control="daily:offline" />
          离线(只用本地归档)
        </label>
        <button type="button" onClick={() => void run()} disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
          data-control="daily:run">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {busy ? "生成中…(要打多个外部源, 约十几秒)" : "生成当期简报"}
        </button>
        {history?.records ? (
          <span className="text-[10px] text-muted-foreground">
            已有 {history.records} 期历史可对比{history.lastAt ? `, 最近 ${history.lastAt.slice(0, 16).replace("T", " ")}` : ""}
          </span>
        ) : null}
      </div>

      {err ? <PanelNotice type="err">{err}</PanelNotice> : null}
      {offline && busy ? (
        <PanelNotice type="info">离线模式: 只用本地已归档的材料, 不会联网。</PanelNotice>
      ) : null}

      {!brief ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
          点上面按钮生成一期。它会走舆情检索(28 个公开源)+ 热榜(4 个平台)+ 本地归档, 然后按
          <span className="mx-1">来源层级</span>与<span className="mx-1">栏目配额</span>选稿、聚主线、给采编自检。
          <br />结果不打分不排序伪造确定性 —— 每条都带「这类来源能证明什么」的边界。
        </div>
      ) : (
        <>
          {/* ── 概况 ── */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
            <span className="font-medium">{brief.title || "中文互联网今日"}</span>
            <span className="text-muted-foreground">
              从 {brief.candidateCount} 条线索筛出 {brief.itemCount} 条 · 时间窗 {brief.timeWindow}
            </span>
            <span className={cn("rounded border px-1.5 py-0.5", HEALTH_CLS[brief.editorialHealth.status] ?? "")}>
              自检 {brief.editorialHealth.status}
            </span>
            {Object.entries(brief.tierMix).map(([t, n]) => (
              <span key={t} className="inline-flex items-center gap-1">
                <TierBadge tier={t} /> {n}
              </span>
            ))}
            <div className="ml-auto flex gap-1">
              <button type="button" onClick={() => void copy("md")} data-control="daily:copy-md"
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] hover:bg-accent">
                {copied === "md" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}Markdown
              </button>
              <button type="button" onClick={() => void copy("ctx")} data-control="daily:copy-ctx"
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] hover:bg-accent">
                {copied === "ctx" ? <Check className="h-3 w-3" /> : <FileText className="h-3 w-3" />}给 Agent 的上下文
              </button>
            </div>
          </div>

          {/* ── 各通道状态: 挂了就说挂了, 不静默少几条 ── */}
          <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
            {Object.entries(brief.diagnostics).map(([k, d]) => (
              <span key={k} className={cn("rounded border px-1.5 py-0.5",
                d.status === "ok" ? "border-border" : d.status === "error" ? "border-rose-500/40 text-rose-300" : "border-border")}
                title={d.error || d.note || ""}>
                {k}: {d.status} {d.count} 条{d.source ? ` · ${d.source}` : ""}
              </span>
            ))}
          </div>

          {/* ── 摘要 ── */}
          {brief.highlights.length ? (
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="mb-1.5 text-xs font-medium text-amber-300">今日摘要</div>
              <ul className="space-y-1 text-xs leading-relaxed">
                {brief.highlights.map((h, i) => <li key={i} className="flex gap-1.5"><ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" /><span>{h}</span></li>)}
              </ul>
            </div>
          ) : null}

          {/* ── 主线 ── */}
          {brief.storylines.length ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">今日主线({brief.storylines.length} 条)</div>
              {brief.storylines.map((s, i) => (
                <div key={s.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">#{i + 1}</span>
                    <span className="text-sm font-medium">{s.headline}</span>
                    <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", RISK_CLS[s.riskLevel] ?? "")}>风险 {s.riskLevel}</span>
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px]">{s.recommendedAction}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {s.freshnessLabel} · 信心 {s.confidence} · {s.storylineTypeLabel}
                    </span>
                    {/* 来源层分布 —— 这一句是"证据够不够"的唯一线索, 必须显示 */}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      来源层 {Object.entries(s.sourceSpread.tierCounts).map(([t, n]) => `${t}:${n}`).join(" / ") || "—"}
                      {" · "}{s.sourceSpread.domainCount} 个域名
                    </span>
                  </div>
                  {s.riskFlags.length ? (
                    <div className="mt-1.5 text-[10px] text-rose-300">风险标记: {s.riskFlags.join("、")}</div>
                  ) : null}
                  <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-muted-foreground">
                    <div><span className="text-foreground/70">发生了什么: </span>{s.whatHappened}</div>
                    <div><span className="text-foreground/70">为什么值得看: </span>{s.whyItMatters}</div>
                  </div>
                  {s.evidenceItems.length ? (
                    <div className="mt-2 space-y-1 border-t border-border pt-2">
                      {s.evidenceItems.map((e, j) => (
                        <div key={j} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          <TierBadge tier={e.sourceTier} label={e.sourceTierLabel || e.sourceTier} />
                          {e.url ? (
                            <a href={e.url} target="_blank" rel="noreferrer" className="truncate hover:underline">{e.title}</a>
                          ) : <span className="truncate">{e.title}</span>}
                          <span className="text-muted-foreground">{e.source} · {e.freshnessLabel || e.freshness}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {/* ── 分栏 ── */}
          {brief.sections.map((sec) => (
            <div key={sec.key} className="rounded-lg border border-border bg-card p-3">
              <div className="mb-1 text-xs font-medium">{sec.title} <span className="text-muted-foreground">({sec.items.length})</span></div>
              <div className="mb-2 text-[10px] text-muted-foreground">{sec.summary}</div>
              <div className="space-y-2">
                {sec.items.map((it, i) => (
                  <div key={i} className="rounded border border-border/60 p-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <TierBadge tier={it.sourceTier} label={it.sourceTierLabel} />
                      {it.url ? (
                        <a href={it.url} target="_blank" rel="noreferrer" className="text-xs hover:underline">{it.title}</a>
                      ) : <span className="text-xs">{it.title}</span>}
                      <span className="text-[10px] text-muted-foreground">{it.source} · {it.freshnessLabel}</span>
                    </div>
                    {it.summary ? <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{it.summary}</div> : null}
                    {/* 边界逐条显示 —— 层级分对了但没人告诉读者这意味着什么, 等于白分 */}
                    <div className="mt-1 text-[10px] text-amber-300/80">边界: {it.sourceProfile.boundary}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* ── 历史对比 ── */}
          {brief.historyDelta.enabled ? (
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
                <CalendarDays className="h-3.5 w-3.5" />与往期对比
                <span className="text-[10px] text-muted-foreground">
                  ({brief.historyDelta.compareDays} 天窗口 / {brief.historyDelta.recordsChecked} 期历史)
                </span>
              </div>
              <div className="space-y-1 text-[11px]">
                {([["今日新增", brief.historyDelta.newStorylines],
                  ["延续观察", brief.historyDelta.continuedStorylines],
                  ["本期未见", brief.historyDelta.cooledStorylines]] as const).map(([label, rows]) => (
                  rows.length ? (
                    <div key={label} className="flex flex-wrap gap-1.5">
                      <span className="text-muted-foreground">{label}:</span>
                      {rows.slice(0, 5).map((r, i) => <span key={i} className="rounded border border-border px-1.5 py-0.5">{r.headline}</span>)}
                    </div>
                  ) : null
                ))}
                {brief.historyDelta.persistentRisks.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    <span className="text-rose-300">持续风险:</span>
                    {brief.historyDelta.persistentRisks.map((r, i) => <span key={i} className="rounded border border-rose-500/40 px-1.5 py-0.5 text-rose-300">{r.headline}</span>)}
                  </div>
                ) : null}
              </div>
              {/* ⚠ 这句不能省: 降温桶很可能只是这期没抓到, 不是事情结束了 */}
              <div className="mt-1.5 text-[10px] text-muted-foreground">
                「本期未见」只表示本期检索未覆盖到, <span className="text-foreground/70">不等于事情结束了</span>。
              </div>
            </div>
          ) : null}

          {/* ── 候补池 ── */}
          {brief.overflowItems.length ? (
            <details className="rounded-lg border border-border bg-card p-3">
              <summary className="cursor-pointer text-xs font-medium">候补线索池({brief.overflowCount} 条, 没进正文但留着改稿/扩展用)</summary>
              <div className="mt-2 space-y-1">
                {brief.overflowItems.map((it, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <TierBadge tier={(it.sourceTierLabel || "?")[0]} label={it.sourceTierLabel} />
                    {it.url ? <a href={it.url} target="_blank" rel="noreferrer" className="truncate hover:underline">{it.title}</a> : <span className="truncate">{it.title}</span>}
                    <span className="text-[10px] text-muted-foreground">{it.source} · {it.freshnessLabel}</span>
                  </div>
                ))}
              </div>
            </details>
          ) : null}

          {/* ── 采编自检: 放在正文之后 ── */}
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />采编自检
              <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", HEALTH_CLS[brief.editorialHealth.status] ?? "")}>
                {brief.editorialHealth.status}
              </span>
            </div>
            <div className="mb-1.5 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
              {Object.entries(brief.editorialHealth.coverage).map(([k, n]) => (
                <span key={k} className="rounded border border-border px-1.5 py-0.5">{k}: {n}</span>
              ))}
              {Object.entries(brief.sourceHealth.mainFreshnessCounts).map(([k, n]) => (
                <span key={k} className="rounded border border-border px-1.5 py-0.5">时效 {k}: {n}</span>
              ))}
            </div>
            {brief.editorialHealth.warnings.length ? (
              <ul className="space-y-1 text-[11px] leading-relaxed text-amber-300/90">
                {brief.editorialHealth.warnings.map((w, i) => <li key={i}>· {w}</li>)}
              </ul>
            ) : <div className="text-[11px] text-emerald-300">各项覆盖齐备, 未发现需要提醒的缺口。</div>}
          </div>

          {/* ── 边界与下一步 ── */}
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="mb-1.5 text-xs font-medium">边界提醒</div>
            <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
              {brief.boundaries.map((b, i) => <li key={i}>· {b}</li>)}
              <li>· {brief.boundary}</li>
            </ul>
            {brief.nextSteps.length ? (
              <>
                <div className="mb-1.5 mt-3 text-xs font-medium">下一步</div>
                <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                  {brief.nextSteps.map((s, i) => <li key={i}>· {s}</li>)}
                </ul>
              </>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export default DailyBriefPanel;
