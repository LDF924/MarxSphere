// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// OpinionSearchPanel.tsx — 舆情检索(2026-10-01, 自旧项目 AItoolman 移植)
//
// 由来: 本仓**完全没有舆情能力**。旧项目有 `get_public_opinion_sources_dict` 与舆情检索。
//   面向**研究**而非商业监控: 政策出台后的讨论走向 / 媒体框架 / 舆论与官方话语对照。
//
// ⚠ 源是有限的真实源(见 /api/opinion/sources), 有的源本身有局限(人民网 RSS 冻结、
//   微博只有公开热搜榜)。服务侧把这些写在源元数据 note 里, 这里如实展示 ——
//   "这个源没有结果"和"这个源本来就取不到"是两回事, 不能让用户猜。
//
// 第一版丑在: 结果就是一列文字 + 一个小色标。改成**统计条 + 情感分布 + 卡片式条列**,
//   并把"几条转载"这种合并信息显式标出来(那正是舆情研究关心的)。
import { useEffect, useState } from "react";
import {
  Newspaper, Search, Loader2, ExternalLink, Layers, TrendingUp, Info,
} from "lucide-react";
import {
  PanelHeader, PanelCard, PanelButton, PanelEmpty, panelInputCls, PillGroup, StatTile, panelAccent,
} from "./PanelShell";
import { cn } from "../lib/utils";

interface Source { id: string; name: string; category?: string; country?: string; lang?: string; enabled?: boolean; note?: string }
interface Item {
  title: string; summary?: string; url?: string; sourceName?: string; publishedAt?: string | null;
  sentiment?: { polarity?: string; stance?: string; intensity?: number };
  duplicateCount?: number; alsoReportedBy?: string[]; topics?: string[];
}

const POLARITY: Record<string, { label: string; cls: string; dot: string }> = {
  positive: { label: "正面", cls: "text-emerald-300", dot: "bg-emerald-400" },
  negative: { label: "负面", cls: "text-red-300", dot: "bg-red-400" },
  neutral: { label: "中性", cls: "text-slate-400", dot: "bg-slate-500" },
};
const STANCE: Record<string, string> = { support: "支持", oppose: "反对", neutral: "中立" };

/** 路由意图的中文名 —— 与后端 opinion-router 的 OpinionIntent 一一对应 */
const INTENT_LABEL: Record<string, string> = {
  policy: "政策", official_data: "官方数据", academic: "学术文献",
  news_event: "事件动态", public_opinion: "公众舆论", tech_dev: "技术视角",
};

interface RoutePlan {
  primary: string[];
  secondary: string[];
  preferredSourceIds: string[];
  reason: string;
  avoidAsPrimary: string[];
  lowConfidence: boolean;
}

export function OpinionSearchPanel({ onSendToWorkflow }: {
  /** 把一条舆情作为**论据素材**投给写作舱 */
  onSendToWorkflow?: (text: string, title: string) => void;
} = {}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [query, setQuery] = useState("");
  const [days, setDays] = useState(7);
  const [items, setItems] = useState<Item[]>([]);
  const [softErrors, setSoftErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showSources, setShowSources] = useState(false);
  /**
   * 信源路由(2026-10-03)。默认**关** —— 与后端同一口径: 路由是启发式的,
   * 它能明显提速降噪, 但也可能对冷门主题选错而漏源。默认关 = 行为与加这个之前一致。
   * 用户打字时先去问一次"这个问题会去哪些源", 免得点了检索才知道。
   */
  const [useRoute, setUseRoute] = useState(false);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [filter, setFilter] = useState<"all" | "positive" | "neutral" | "negative">("all");

  useEffect(() => {
    void (async () => {
      try { setSources(((await (await fetch("/api/opinion/sources")).json()).sources) ?? []); }
      catch { /* 源列表失败不阻断检索 */ }
    })();
  }, []);

  const search = async () => {
    if (!query.trim()) { setErr("请输入检索主题"); return; }
    setBusy(true); setErr(""); setItems([]); setSoftErrors([]);
    try {
      const r = await fetch("/api/opinion/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, days, limit: 60, analyzeSentiment: true, route: useRoute }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || d?.error || "检索失败");
      setItems(d.items ?? []);
      setSoftErrors(d.softErrors ?? []);
      setPlan(d.route ?? null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  /** 输入态就问一次路由 —— 用户该在**点检索之前**知道会去哪些源 */
  useEffect(() => {
    const q = query.trim();
    if (!useRoute || q.length < 4) { setPlan(null); return; }
    const t = window.setTimeout(() => {
      void fetch(`/api/opinion/route?q=${encodeURIComponent(q)}`)
        .then((r) => r.json()).then(setPlan)
        .catch(() => { /* 路由取不到不影响检索 */ });
    }, 450);
    return () => window.clearTimeout(t);
  }, [query, useRoute]);

  const shown = filter === "all" ? items : items.filter((i) => (i.sentiment?.polarity ?? "neutral") === filter);
  const dist = {
    positive: items.filter((i) => i.sentiment?.polarity === "positive").length,
    neutral: items.filter((i) => (i.sentiment?.polarity ?? "neutral") === "neutral").length,
    negative: items.filter((i) => i.sentiment?.polarity === "negative").length,
  };
  const a = panelAccent("amber");

  return (
    <div className="space-y-3">
      <PanelHeader
        icon={<Newspaper />} accent="amber" title="舆情检索"
        subtitle="检索公开舆论源并做情感与立场分析。用于研究议题的媒体框架与舆论走向，不是商业舆情监控"
        actions={
          <>
            {items.length > 0 && <StatTile accent="amber" value={items.length} label="命中" />}
            <PanelButton accent="amber" variant="ghost" size="sm" onClick={() => setShowSources((v) => !v)}>
              <Layers className="h-3 w-3" />{sources.length} 个源
            </PanelButton>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
          placeholder="议题关键词，例如「农村集体经济」"
          className={panelInputCls + " min-w-[240px] flex-1"} />
        <PillGroup accent="amber" label="时间" value={String(days) as string}
          onChange={(v) => setDays(Number(v))}
          options={[1, 3, 7, 30, 90].map((d) => ({ value: String(d), label: `${d}天` }))} />
        {/* 信源路由开关 —— 与"检索"并排, 因为它改的是"这次去哪查" */}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="按研究意图自动选源, 而不是把 26 个源全跑一遍">
          <input type="checkbox" checked={useRoute} onChange={(e) => setUseRoute(e.target.checked)} data-control="opinion:route-toggle" />
          按意图选源
        </label>
        <PanelButton accent="amber" busy={busy} onClick={() => void search()}>
          <Search className="h-3.5 w-3.5" />检索
        </PanelButton>
      </div>

      {/* 路由建议 —— 输入态即可见, 讲清"会去哪些源 / 别拿谁当主要依据" */}
      {useRoute && plan ? (
        <div className="rounded-md border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-xs" data-control="opinion:route-plan">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sky-300">信源路由</span>
            {plan.primary.map((i) => (
              <span key={i} className="rounded bg-sky-400/15 px-1.5 py-0.5 text-[10px] text-sky-200">{INTENT_LABEL[i] ?? i}</span>
            ))}
            <span className="text-muted-foreground">
              将跑 {plan.preferredSourceIds.length} 个源
              {plan.lowConfidence ? "（未识别出明确意图，建议关掉路由全量检索）" : ""}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{plan.reason}</p>
          {plan.avoidAsPrimary.length ? (
            <ul className="mt-1 space-y-0.5 text-[11px] text-amber-300/90">
              {plan.avoidAsPrimary.map((a) => <li key={a}>· {a}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}

      {showSources && (
        <PanelCard icon={<Layers />} title={`数据源（${sources.length}）`}>
          <div className="grid gap-1.5 md:grid-cols-2">
            {sources.map((s) => (
              <div key={s.id} className="flex items-start gap-2 rounded-lg border border-border/50 px-2 py-1.5">
                <span className={cn("mt-px shrink-0 rounded px-1 py-px text-[9px]",
                  s.enabled === false ? "bg-slate-500/15 text-slate-400" : "bg-amber-500/15 text-amber-300")}>
                  {s.category ?? "—"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cn("truncate text-[11px]", s.enabled === false && "text-muted-foreground line-through")}>{s.name}</div>
                  {s.note && (
                    <div className="mt-0.5 flex items-start gap-1 text-[9px] text-amber-400/70">
                      <Info className="mt-px h-2.5 w-2.5 shrink-0" />{s.note}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </PanelCard>
      )}

      {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{err}</div>}
      {softErrors.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300/90">
          {softErrors.length} 个源本次没取到结果（网络或反爬）—— 其余源照常展示
        </div>
      )}

      {/* 情感分布 + 筛选 */}
      {items.length > 0 && (
        <PanelCard icon={<TrendingUp />} title="情感分布">
          <div className="flex h-2.5 overflow-hidden rounded-full">
            {(["positive", "neutral", "negative"] as const).map((k) => (
              dist[k] > 0 && <div key={k} className={cn(POLARITY[k].dot, "transition-all")}
                style={{ width: `${(dist[k] / items.length) * 100}%` }} title={`${POLARITY[k].label} ${dist[k]}`} />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(["all", "positive", "neutral", "negative"] as const).map((k) => (
              <button key={k} type="button" onClick={() => setFilter(k)}
                className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] transition-colors",
                  filter === k ? "border-amber-500/50 bg-amber-500/15 text-amber-200" : "border-border/60 text-muted-foreground hover:bg-accent")}>
                {k !== "all" && <span className={cn("h-1.5 w-1.5 rounded-full", POLARITY[k].dot)} />}
                {k === "all" ? `全部 ${items.length}` : `${POLARITY[k].label} ${dist[k]}`}
              </button>
            ))}
          </div>
        </PanelCard>
      )}

      {shown.length > 0 && (
        <div className="space-y-1.5">
          {shown.map((it, i) => {
            const pol = POLARITY[it.sentiment?.polarity ?? "neutral"] ?? POLARITY.neutral;
            const dup = it.duplicateCount ?? 0;
            return (
              <div key={i} className="group rounded-xl border border-border/50 bg-card/60 p-3 backdrop-blur-sm transition-colors hover:border-amber-500/30">
                <div className="flex items-start gap-2">
                  <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", pol.dot)} title={pol.label} />
                  <a href={it.url} target="_blank" rel="noreferrer"
                    className="min-w-0 flex-1 text-[12px] font-medium leading-5 hover:text-amber-300 hover:underline">
                    {it.title}
                    <ExternalLink className="ml-1 inline h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
                  </a>
                  {it.sentiment?.stance && it.sentiment.stance !== "neutral" && (
                    <span className={cn("shrink-0 rounded-full border px-1.5 py-px text-[9px]",
                      it.sentiment.stance === "oppose" ? "border-red-500/40 text-red-300" : "border-emerald-500/40 text-emerald-300")}>
                      {STANCE[it.sentiment.stance] ?? it.sentiment.stance}
                    </span>
                  )}
                </div>
                {it.summary && <p className="mt-1 ml-3.5 line-clamp-2 text-[11px] leading-5 text-muted-foreground">{it.summary}</p>}
                <div className="mt-1.5 ml-3.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="rounded bg-accent/60 px-1.5 py-px">{it.sourceName}</span>
                  {it.publishedAt && <span className="tabular-nums">{String(it.publishedAt).slice(0, 10)}</span>}
                  {dup > 1 && (
                    <span className="rounded bg-amber-500/10 px-1.5 py-px text-amber-300/90"
                      title={(it.alsoReportedBy ?? []).join(" / ")}>
                      {dup} 家转载
                    </span>
                  )}
                  {typeof it.sentiment?.intensity === "number" && it.sentiment.intensity > 0 && (
                    <span>强度 {it.sentiment.intensity.toFixed(2)}</span>
                  )}
                  {/*
                    舆情**不入文献库** —— 它是新闻/政策, 不是文献。塞进 documents 会污染
                    文献检索与向量库(而服务侧也确实没有对应入库接口)。
                    合理的下一步是"当论据用": 投给写作舱的素材页, 写作时引用。
                  */}
                  {onSendToWorkflow && (
                    <button type="button"
                      onClick={() => onSendToWorkflow(
                        `> ${it.title}
> —— ${it.sourceName}${it.publishedAt ? ` · ${String(it.publishedAt).slice(0, 10)}` : ""}
> ${it.url}

${it.summary ?? ""}`,
                        `舆情论据：${it.title.slice(0, 40)}`)}
                      className="ml-auto rounded border border-amber-500/40 px-1.5 py-px text-amber-300/90 hover:bg-amber-500/15">
                      作论据
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!busy && items.length === 0 && !err && (
        <PanelEmpty>输入议题关键词后点「检索」—— 结果会按情感着色，多源转载自动合并标注</PanelEmpty>
      )}
    </div>
  );
}
